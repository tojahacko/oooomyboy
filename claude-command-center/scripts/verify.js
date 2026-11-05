#!/usr/bin/env node
'use strict';
// End-to-end verification. Prints a PASS / FAIL / SKIP report and exits non-zero on any FAIL.
//   node scripts/verify.js            unit tests, plugin validation, backend+hook e2e, dashboard smoke
//   node scripts/verify.js --live     also runs a REAL Claude Code session (claude -p, Haiku; costs < $0.02)
//                                     and checks the measured task against Claude Code's own numbers
//   node scripts/verify.js --notify   also shows one real desktop notification
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const results = [];
const record = (name, status, detail = '') => { results.push({ name, status, detail }); console.log(`${status === 'PASS' ? '✔' : status === 'SKIP' ? '–' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`); };

function run(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, { encoding: 'utf8', timeout: opts.timeout || 300000, cwd: opts.cwd || ROOT, env: { ...process.env, ...(opts.env || {}) }, input: opts.input, shell: opts.shell || false });
}
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), name + '-'));
function req(port, method, p, body) {
  return new Promise(resolve => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'x-ccc': '1', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, res => {
      let out = ''; res.on('data', d => { out += d; }); res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    });
    r.on('error', () => resolve(null));
    r.end(data || undefined);
  });
}
function hook(event, payload, env) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(ROOT, 'cli', 'ccc-hook.js'), event], { env: { ...process.env, CCC_NO_AUTOSTART: '1', ...env } });
    let out = ''; p.stdout.on('data', d => { out += d; });
    p.on('close', code => resolve({ code, out }));
    p.stdin.end(JSON.stringify(payload));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`Claude Command Center verification · node ${process.version} · ${os.platform()} ${os.release()}\n`);

  // 1. unit + integration tests
  const files = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).map(f => path.join('test', f));
  const t = run(process.execPath, ['--test', ...files]);
  const pass = /# pass (\d+)/.exec(t.stdout || ''), fail = /# fail (\d+)/.exec(t.stdout || '');
  record('Unit and integration tests', t.status === 0 ? 'PASS' : 'FAIL', `${pass ? pass[1] : '?'} passed, ${fail ? fail[1] : '?'} failed`);
  if (t.status !== 0) console.log((t.stdout || '').split('\n').filter(l => /^not ok|error:|expected|actual/.test(l)).join('\n'));

  // 2. plugin manifest
  const claude = run(process.platform === 'win32' ? 'claude.cmd' : 'claude', ['--version'], { shell: process.platform === 'win32' });
  if (claude.status === 0) {
    const v = run(process.platform === 'win32' ? 'claude.cmd' : 'claude', ['plugin', 'validate', ROOT], { shell: process.platform === 'win32' });
    record('Claude Code plugin validates', /Validation passed/.test(v.stdout + v.stderr) ? 'PASS' : 'FAIL', `Claude Code ${claude.stdout.trim()}`);
  } else record('Claude Code plugin validates', 'SKIP', 'claude CLI not on PATH');

  // 3. backend + real hook processes, end to end
  const home = tmp('ccc-verify-home');
  const { createServer } = require('../server/index.js');
  const sent = [];
  const app = createServer({ home, projectsDir: path.join(ROOT, 'test', 'fixtures', 'projects'), port: 0, claudeJson: path.join(home, 'none.json'), notifier: { send: n => { sent.push(n); return true; } } });
  const port = await app.listen();
  app.config.update({ notifications: { finishMinSeconds: 0 } });
  const env = { CCC_PORT: String(port), CCC_HOME: home };
  const { scenario } = require('../test/helpers');
  const events = scenario({ t0: Date.now() - 60000 });
  let advice = null, hookFailures = 0;
  for (const e of events) {
    const r = await hook(e._event, e, env);
    if (r.code !== 0) hookFailures++;
    if (e._event === 'UserPromptSubmit' && !advice && r.out) advice = JSON.parse(r.out).systemMessage;
  }
  await sleep(300);
  const state = await req(port, 'GET', '/api/state');
  const task = state && state.recent[0];
  record('Hooks exit 0 for every event', hookFailures === 0 ? 'PASS' : 'FAIL', `${events.length} events through cli/ccc-hook.js`);
  record('Live monitoring: task lifecycle', task && task.status === 'completed' && task.toolCount === 5 && task.toolErrors === 1 ? 'PASS' : 'FAIL', task ? `${task.status}, ${task.toolCount} tools, ${task.toolErrors} error(s)` : 'no task');
  record('Subagent tracking (type + reported model)', task && task.agents.some(a => a.type === 'Explore' && a.model === 'claude-haiku-5-5') ? 'PASS' : 'FAIL');
  record('Progress from Claude\'s todo list', task && task.progress && task.progress.total === 4 ? 'PASS' : 'FAIL');
  record('Prompt intelligence line in Claude Code', advice && /suggests .* · effort/.test(advice) && /nothing was changed/.test(advice) ? 'PASS' : 'FAIL', advice ? advice.slice(0, 90) + '…' : '');
  record('Notifications (blocked + finished)', ['blocked', 'finish'].every(k => sent.some(n => n.kind === k)) ? 'PASS' : 'FAIL', sent.map(n => n.kind).join(', '));
  const fixtureSession = '33fc458d-0f9a-4058-905e-f4cd7a16d86f';
  const sumOurs = app.index.records({ sessionId: fixtureSession }).reduce((s, r) => s + r.costUsd, 0);
  const sumTheirs = app.index.costState[fixtureSession].totalCostUSD;
  record('Cost estimate == Claude Code\'s own cost (real transcript)', Math.abs(sumOurs - sumTheirs) < 1e-6 ? 'PASS' : 'FAIL', `$${sumOurs.toFixed(8)} vs $${sumTheirs.toFixed(8)}`);
  const models = await req(port, 'GET', '/api/models?range=all');
  record('Model tracking by agent type', models && models.models.some(m => m.agentTypes['general-purpose']) ? 'PASS' : 'FAIL', models ? models.models.map(m => `${m.name}×${m.requests}`).join(', ') : '');
  const an = await req(port, 'GET', '/api/analytics?range=all');
  record('Analytics endpoint', an && an.days.length > 0 && an.tasks.tierStats.length > 0 ? 'PASS' : 'FAIL', an ? `${an.tasks.tracked} tracked + ${an.tasks.reconstructed} reconstructed tasks` : '');
  const adv = await req(port, 'POST', '/api/advise', { prompt: 'what is a closure?' });
  record('Time prediction never fabricated without history', adv && (adv.prediction.basis === 'none' ? /Not enough/.test(adv.prediction.note) : adv.prediction.n >= 3) ? 'PASS' : 'FAIL', adv ? `${adv.prediction.basis}: ${adv.prediction.note || 'n=' + adv.prediction.n}` : '');
  const sl = await req(port, 'POST', '/api/statusline', { session_id: events[0].session_id, model: { display_name: 'Opus 5.5' }, cost: { total_cost_usd: 1.23 } });
  record('Status line', sl && /CCC/.test(sl.line) ? 'PASS' : 'FAIL', sl ? sl.line.replace(/\x1b\[[0-9;]*m/g, '') : '');

  // 4. dashboard smoke test in a real browser (optional dependency)
  let playwright = null;
  try { playwright = require('playwright'); } catch { /* not installed */ }
  if (playwright) {
    // add an in-flight task so the live view renders an active card
    const live = scenario({ session: 'sess-live-3333', t0: Date.now() - 30000 }).slice(0, 10);
    for (const e of live) app.engine.ingest(e);
    const browser = await playwright.chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const checks = { live: '.task-card', tasks: 'table tbody tr', models: 'table tbody tr', costs: 'svg.chart', analytics: '.heat', advisor: '#adv-text', settings: '#save' };
    const missing = [];
    for (const [v, sel] of Object.entries(checks)) {
      await page.goto(`http://127.0.0.1:${port}/#/${v}`);
      try { await page.waitForSelector(sel, { timeout: 5000 }); } catch { missing.push(v); }
    }
    await page.goto(`http://127.0.0.1:${port}/#/task/${encodeURIComponent(state.recent[0].id)}`);
    try { await page.waitForSelector('.lanes', { timeout: 5000 }); } catch { missing.push('task detail'); }
    await browser.close();
    record('Dashboard renders every view without errors', !errors.length && !missing.length ? 'PASS' : 'FAIL', [...missing.map(m => 'missing ' + m), ...errors].join('; ') || '8 views');
  } else record('Dashboard renders every view without errors', 'SKIP', 'playwright not installed (npm i -g playwright to enable)');
  await app.close();

  // 5. desktop notification (opt-in: it really pops up)
  if (args.has('--notify')) {
    const { Notifier } = require('../server/notify');
    const ok = new Notifier({ getConfig: () => ({ notifications: { desktop: true } }) }).send({ kind: 'attention', title: 'Claude Command Center', body: 'Verification: did you see this toast?' });
    record('Desktop notification dispatched', ok ? 'PASS' : 'FAIL', 'confirm you saw it');
  }

  // 6. live Claude Code session (opt-in: spends a fraction of a cent)
  if (args.has('--live')) await liveCheck(claude.status === 0);

  const failed = results.filter(r => r.status === 'FAIL');
  console.log(`\n${results.filter(r => r.status === 'PASS').length} passed · ${failed.length} failed · ${results.filter(r => r.status === 'SKIP').length} skipped`);
  process.exit(failed.length ? 1 : 0);
}

async function liveCheck(haveClaude) {
  if (!haveClaude) return record('Live Claude Code session', 'SKIP', 'claude CLI not on PATH');
  const home = tmp('ccc-live-home');
  const work = tmp('ccc-live-work');
  const { createServer } = require('../server/index.js');
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const app = createServer({ home, projectsDir: projects, port: 0, notifier: { send: () => true } });
  const port = await app.listen();
  const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const r = run(cmd, ['-p', 'Use the Agent tool once (subagent_type general-purpose, model haiku, description "verify agent") to run the bash command: echo verified. Wait for it, then reply with its output only.', '--plugin-dir', ROOT, '--model', 'haiku', '--output-format', 'json'],
    { cwd: work, env: { CCC_PORT: String(port), CCC_HOME: home, CCC_NO_AUTOSTART: '1' }, input: '', timeout: 300000, shell: process.platform === 'win32' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* below */ }
  if (!out) { await app.close(); return record('Live Claude Code session', 'FAIL', (r.stderr || r.stdout || 'no output').slice(0, 200)); }
  // let the transcript poller catch the last lines
  for (let i = 0; i < 10; i++) { app.index.scan(); await sleep(500); }
  const st = await req(port, 'GET', '/api/state');
  const task = st && [...st.recent, ...st.active].find(t => t.sessionId === out.session_id);
  record('Live: hooks reached the backend', task ? 'PASS' : 'FAIL', task ? `task ${task.status}, ${task.toolCount} tool calls` : 'no task for session ' + out.session_id);
  if (task) {
    const diff = Math.abs(task.usage.costUsd - out.total_cost_usd);
    record('Live: task cost == Claude Code total_cost_usd', diff < 1e-6 ? 'PASS' : 'FAIL', `$${task.usage.costUsd.toFixed(6)} vs $${Number(out.total_cost_usd).toFixed(6)}`);
    const sub = task.agents.find(a => a.description === 'verify agent');
    record('Live: subagent model measured', sub && sub.modelSource === 'measured' && /haiku/.test(sub.model) ? 'PASS' : 'FAIL', sub ? `${sub.type} on ${sub.modelName} (${sub.modelSource})` : 'subagent not found');
  }
  await app.close();
}

main().catch(e => { console.error(e); process.exit(1); });
