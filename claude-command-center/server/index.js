'use strict';
// Claude Command Center backend: a small local HTTP server (127.0.0.1 only).
//  POST /api/hook        hook events from bin/ccc-hook.js
//  POST /api/statusline  status line text for bin/ccc-statusline.js
//  GET  /api/state       live snapshot          GET /api/events  server-sent events
//  GET  /api/tasks[/:id] task history/detail    GET /api/analytics, /api/models, /api/pricing
//  GET/POST /api/config  settings               POST /api/advise   prompt-intelligence playground
const http = require('http');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { TranscriptIndex } = require('./transcripts');
const { Predictor } = require('./predict');
const { Notifier } = require('./notify');
const { Config } = require('./config');
const { Engine, EventLog, ACTIVE } = require('./engine');
const { analytics, models } = require('./analytics');
const { detectBilling, fetchCostReport } = require('./billing');
const advisor = require('./advisor');
const pricing = require('./pricing');
const VERSION = require('../package.json').version;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function createServer(opts = {}) {
  const home = opts.home || paths.HOME;
  const port = opts.port != null ? opts.port : paths.PORT;
  fs.mkdirSync(home, { recursive: true });
  const logFile = path.join(home, 'server.log');
  const log = msg => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ } };

  const config = new Config(path.join(home, 'config.json'));
  const index = new TranscriptIndex({ projectsDir: opts.projectsDir || paths.PROJECTS_DIR, cacheFile: path.join(home, 'scan-cache.json'), log });
  const predictor = new Predictor();
  const notifier = opts.notifier || new Notifier({ getConfig: () => config.get(), log });
  let billingCache = null, billingAt = 0;
  const billing = () => {
    if (!billingCache || Date.now() - billingAt > 60000) {
      billingCache = detectBilling({ claudeJsonPath: opts.claudeJson || paths.CLAUDE_JSON, configured: config.get().billing, env: opts.env || process.env });
      billingAt = Date.now();
    }
    return billingCache;
  };
  const eventLog = new EventLog(path.join(home, 'events.jsonl'));
  const engine = new Engine({ index, predictor, notifier, config, log, eventLog, billing });

  index.load();
  index.scan();
  index.closeIdle();
  const replayed = engine.replay();
  ingestSpool();
  log(`started v${VERSION} on ${port}; ${index.usage.size} usage records, ${replayed} events replayed`);

  // ---- SSE ----
  const clients = new Set();
  let pending = null;
  engine.onChange(kind => {
    if (kind === 'notification') broadcast('notification', engine.notifications[0]);
    if (pending) return;
    pending = setTimeout(() => { pending = null; broadcast('changed', { at: Date.now() }); }, 400);
  });
  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) { try { res.write(msg); } catch { clients.delete(res); } }
  }

  // ---- background work: transcript polling, cache saving ----
  const timers = [];
  const livePoll = () => {
    // Poll the transcripts of active sessions quickly; a full scan picks up everything else.
    let changed = false;
    for (const s of engine.sessions.values()) {
      if (s.status === 'ended' || Date.now() - s.lastEventAt > 3600000 || !s.transcriptPath) continue;
      changed = index.ingestFile(s.transcriptPath) || changed;
      const sub = path.join(path.dirname(s.transcriptPath), s.id, 'subagents');
      try { for (const f of fs.readdirSync(sub)) changed = index.ingestFile(path.join(sub, f)) || changed; } catch { /* no subagents */ }
    }
    if (changed) index.emit();
  };
  timers.push(setInterval(livePoll, 2000));
  timers.push(setInterval(() => { try { index.scan(); index.closeIdle(); } catch (e) { log('scan: ' + e.message); } }, 60000));
  timers.push(setInterval(() => { try { index.save(); } catch (e) { log('save: ' + e.message); } }, 30000));
  timers.push(setInterval(() => broadcast('tick', { at: Date.now() }), 15000)); // keep-alive
  timers.push(setInterval(() => { try { eventLog.compact(config.get().retentionDays || 365); } catch (e) { log('compact: ' + e.message); } }, 6 * 3600000));
  for (const t of timers) t.unref();

  function ingestSpool() {
    const spool = path.join(home, 'spool.jsonl');
    let text = '';
    try { text = fs.readFileSync(spool, 'utf8'); fs.unlinkSync(spool); } catch { return; }
    const evts = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).sort((a, b) => a._ts - b._ts);
    engine.replaying = true; // events from the past: no notifications, no chat messages
    for (const e of evts) engine.ingest(e);
    engine.replaying = false;
    if (evts.length) log(`ingested ${evts.length} spooled events`);
  }

  let adminCache = null;
  async function adminCost() {
    const key = config.get().adminApiKey;
    if (!key) return { configured: false };
    if (adminCache && Date.now() - adminCache.fetchedAt < 15 * 60000) return { configured: true, ...adminCache };
    try { adminCache = await fetchCostReport(key); return { configured: true, ...adminCache }; } catch (e) { return { configured: true, error: e.message }; }
  }

  // ---- HTTP ----
  const dashDir = path.join(paths.APP_ROOT, 'dashboard');
  const server = http.createServer(async (req, res) => {
    try {
      // Only local pages may talk to us (DNS-rebinding guard).
      const host = (req.headers.host || '').toLowerCase();
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: 'forbidden host' });
      const url = new URL(req.url, 'http://127.0.0.1');
      const p = url.pathname;
      if (req.method === 'POST' && req.headers['x-ccc'] !== '1') return send(res, 403, { error: 'missing x-ccc header' });

      if (p === '/api/hook' && req.method === 'POST') {
        const body = await readJson(req);
        if (url.searchParams.get('event')) body._event = url.searchParams.get('event');
        return send(res, 200, engine.ingest(body));
      }
      if (p === '/api/statusline' && req.method === 'POST') {
        const body = await readJson(req);
        engine.ingest({ ...body, _event: 'statusline', hook_event_name: 'statusline' });
        return send(res, 200, { line: engine.statusLine(body) });
      }
      if (p === '/api/health') return send(res, 200, { ok: true, app: 'claude-command-center', version: VERSION, pid: process.pid, port, uptimeMs: Date.now() - engine.stats.startedAt, ...engine.snapshot().health });
      if (p === '/api/state') return send(res, 200, engine.snapshot());
      if (p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify({ version: VERSION })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (p === '/api/tasks') {
        const status = url.searchParams.get('status');
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const limit = Math.min(500, Number(url.searchParams.get('limit') || 100));
        const out = [];
        for (let i = engine.taskOrder.length - 1; i >= 0 && out.length < limit; i--) {
          const t = engine.tasks.get(engine.taskOrder[i]);
          if (!t) continue;
          if (status && (status === 'active' ? !ACTIVE.has(t.status) : t.status !== status)) continue;
          if (q && !t.prompt.toLowerCase().includes(q) && !(t.project || '').toLowerCase().includes(q)) continue;
          out.push(engine.taskView(t));
        }
        return send(res, 200, { tasks: out, total: engine.tasks.size });
      }
      const tm = /^\/api\/tasks\/([^/]+)$/.exec(p);
      if (tm) {
        const t = engine.tasks.get(decodeURIComponent(tm[1]));
        return t ? send(res, 200, engine.taskView(t, { detail: true })) : send(res, 404, { error: 'no such task' });
      }
      if (p === '/api/analytics') return send(res, 200, analytics(engine, { range: url.searchParams.get('range') || '30d' }));
      if (p === '/api/models') return send(res, 200, models(engine, { range: url.searchParams.get('range') || '30d' }));
      if (p === '/api/pricing') return send(res, 200, { date: pricing.PRICE_TABLE_DATE, rows: pricing.table(), fastMultiplier: pricing.FAST_MULTIPLIER });
      if (p === '/api/admin-cost') return send(res, 200, await adminCost());
      if (p === '/api/config' && req.method === 'GET') return send(res, 200, config.public());
      if (p === '/api/config' && req.method === 'POST') {
        const body = await readJson(req);
        if (typeof body.adminApiKey === 'string' && body.adminApiKey.startsWith('••••')) delete body.adminApiKey;
        config.update(body);
        billingCache = null; adminCache = null;
        return send(res, 200, config.public());
      }
      if (p === '/api/advise' && req.method === 'POST') {
        const body = await readJson(req);
        const a = advisor.analyze(body.prompt || '');
        engine.ensureHistory();
        const pred = predictor.predict({ tier: a.tier, elapsedMs: 0 });
        return send(res, 200, { advice: a, prediction: pred, chatLine: advisor.chatLine(a, { history: pred.basis !== 'none' ? { n: pred.n, p50Ms: pred.p50Ms, scope: pred.scope } : null }) });
      }
      if (p === '/api/notifications/read' && req.method === 'POST') { for (const n of engine.notifications) n.read = true; engine.changed(); return send(res, 200, { ok: true }); }
      if (p === '/api/notify/test' && req.method === 'POST') {
        const sent = notifier.send({ kind: 'attention', title: 'Claude Command Center', body: 'Notifications are working.', url: `http://127.0.0.1:${port}/` });
        return send(res, 200, { sent });
      }
      if (p === '/api/rescan' && req.method === 'POST') { const n = index.scan(); return send(res, 200, { newRecords: n }); }
      if (p === '/api/shutdown' && req.method === 'POST') { send(res, 200, { ok: true }); setTimeout(() => close().then(() => process.exit(0)), 50); return; }

      // ---- static dashboard ----
      if (req.method !== 'GET') return send(res, 404, { error: 'not found' });
      let file = p === '/' ? 'index.html' : p.slice(1);
      file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
      const full = path.join(dashDir, file);
      if (!full.startsWith(dashDir)) return send(res, 403, { error: 'forbidden' });
      fs.readFile(full, (err, data) => {
        if (err) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
        res.end(data);
      });
    } catch (e) {
      log('request error: ' + (e.stack || e.message));
      send(res, 500, { error: e.message });
    }
  });

  function close() {
    for (const t of timers) clearInterval(t);
    for (const c of clients) { try { c.end(); } catch { /* ignore */ } }
    try { index.save(); } catch { /* ignore */ }
    return new Promise(r => server.close(() => r()));
  }

  return { server, engine, index, config, predictor, notifier, close, port, home, listen: () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, paths.HOST, () => resolve(server.address().port));
  }) };
}

function send(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

module.exports = { createServer };

if (require.main === module) {
  const app = createServer();
  app.listen().then(port => {
    process.stdout.write(`Claude Command Center listening on http://127.0.0.1:${port}\n`);
  }).catch(e => {
    if (e.code === 'EADDRINUSE') { process.stdout.write('Claude Command Center is already running.\n'); process.exit(0); }
    process.stderr.write(e.stack + '\n'); process.exit(1);
  });
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
