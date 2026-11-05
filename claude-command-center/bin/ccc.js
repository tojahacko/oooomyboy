#!/usr/bin/env node
'use strict';
// Claude Command Center CLI.
//   ccc open                 start the backend if needed and open the dashboard window
//   ccc start | stop | status | run (foreground)
//   ccc doctor               check the whole chain and say exactly what is missing
//   ccc statusline install|uninstall [--force]
//   ccc hooks install|uninstall      (only if you do not use the plugin)
//   ccc notify-test
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const paths = require('../server/paths');

const ROOT = path.resolve(__dirname, '..');
const URL_BASE = `http://127.0.0.1:${paths.PORT}`;
const SETTINGS = path.join(paths.CLAUDE_DIR, 'settings.json');
const HOOK_EVENTS = {
  SessionStart: false, UserPromptSubmit: false, Stop: false, StopFailure: false, SessionEnd: false,
  PreToolUse: true, PostToolUse: true, PostToolUseFailure: true, PermissionRequest: true, PermissionDenied: true,
  SubagentStart: true, SubagentStop: true, Notification: true, TaskCreated: true, TaskCompleted: true, PreCompact: true,
};

function request(method, p, body, timeout = 1500) {
  return new Promise(resolve => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port: paths.PORT, path: p, method, timeout,
      headers: { 'x-ccc': '1', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, res => {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(out) }); } catch { resolve({ status: res.statusCode, body: out }); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(data || undefined);
  });
}

const health = async () => { const r = await request('GET', '/api/health'); return r && r.status === 200 && r.body.app === 'claude-command-center' ? r.body : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function start({ quiet } = {}) {
  const h = await health();
  if (h) { if (!quiet) console.log(`Already running (v${h.version}, pid ${h.pid}) at ${URL_BASE}`); return true; }
  fs.mkdirSync(paths.HOME, { recursive: true });
  const out = fs.openSync(path.join(paths.HOME, 'server.out.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    if (await health()) { if (!quiet) console.log(`Started at ${URL_BASE}`); return true; }
  }
  console.error(`The backend did not start. See ${path.join(paths.HOME, 'server.out.log')}`);
  return false;
}

function findBrowser() {
  if (process.platform === 'win32') {
    const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    const rel = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'];
    for (const r of rel) for (const base of pf) { const p = path.join(base, r); if (fs.existsSync(p)) return p; }
    return null;
  }
  if (process.platform === 'darwin') {
    for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']) if (fs.existsSync(p)) return p;
    return null;
  }
  for (const b of ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser']) {
    try { execFileSync('which', [b], { stdio: 'ignore' }); return b; } catch { /* next */ }
  }
  return null;
}

async function open(hash = '') {
  if (!(await start({ quiet: true }))) return;
  const url = URL_BASE + '/' + hash;
  const browser = process.env.CCC_NO_APP_WINDOW ? null : findBrowser();
  if (browser) {
    // A dedicated profile makes it a standalone app window with its own taskbar entry.
    const profile = path.join(paths.HOME, 'window-profile');
    spawn(browser, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1480,940', '--no-first-run', '--no-default-browser-check'], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  console.log(`Dashboard: ${url}`);
}

async function stop() {
  const r = await request('POST', '/api/shutdown', {});
  console.log(r ? 'Stopped.' : 'Not running.');
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`${SETTINGS} is not valid JSON; fix it first (${e.message})`); }
}

function writeSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.bak-ccc-${Date.now()}`);
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
}

const nodeCmd = file => `node "${path.join(ROOT, 'bin', file).replace(/\\/g, '/')}"`;

function statusline(action, force) {
  const s = readSettings();
  const ours = s.statusLine && /ccc-statusline\.js/.test(s.statusLine.command || '');
  if (action === 'uninstall') {
    if (!ours) return console.log('The status line is not Claude Command Center\'s; left unchanged.');
    delete s.statusLine; writeSettings(s); return console.log('Status line removed. Restart Claude Code.');
  }
  if (s.statusLine && !ours && !force) {
    console.log(`You already have a status line: ${JSON.stringify(s.statusLine)}\nLeft unchanged. Run "ccc statusline install --force" to replace it (a backup of settings.json is kept).`);
    return;
  }
  s.statusLine = { type: 'command', command: nodeCmd('ccc-statusline.js'), padding: 0 };
  writeSettings(s);
  console.log(`Status line installed in ${SETTINGS}. Restart Claude Code to see it.`);
}

function hooks(action) {
  const s = readSettings();
  s.hooks = s.hooks || {};
  for (const ev of Object.keys(s.hooks)) {
    s.hooks[ev] = (s.hooks[ev] || []).map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !/ccc-hook\.js/.test(h.command || '')) })).filter(g => g.hooks.length);
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  if (action === 'install') {
    for (const [ev, isAsync] of Object.entries(HOOK_EVENTS)) {
      const h = { type: 'command', command: `${nodeCmd('ccc-hook.js')} ${ev}`, timeout: 10 };
      if (isAsync) h.async = true;
      (s.hooks[ev] = s.hooks[ev] || []).push({ matcher: '', hooks: [h] });
    }
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  writeSettings(s);
  console.log(action === 'install' ? `Hooks added to ${SETTINGS}. Do not also enable the plugin, or every event is counted twice.` : 'Command Center hooks removed.');
}

async function doctor() {
  const ok = (b, msg, fix) => { console.log(`${b ? '✔' : '✘'} ${msg}${!b && fix ? `\n    → ${fix}` : ''}`); return b; };
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 18, `Node.js ${process.versions.node}`, 'Install Node.js 18 or newer (winget install OpenJS.NodeJS.LTS)');
  ok(fs.existsSync(paths.PROJECTS_DIR), `Claude Code transcripts at ${paths.PROJECTS_DIR}`, 'Run Claude Code once, or set CLAUDE_CONFIG_DIR if you moved it');
  const h = await health();
  ok(!!h, h ? `Backend running (v${h.version}, ${h.usageRecords} usage records, ${h.events} hook events)` : 'Backend not running', 'Run: ccc start');
  let s = {};
  try { s = readSettings(); } catch (e) { ok(false, e.message); }
  const pluginOn = Object.entries(s.enabledPlugins || {}).some(([k, v]) => v && k.startsWith('command-center@'));
  const manual = JSON.stringify(s.hooks || {}).includes('ccc-hook.js');
  ok(pluginOn || manual, pluginOn ? 'Plugin command-center enabled' : manual ? 'Hooks installed in settings.json' : 'Claude Code integration not found',
    'Run windows\\install.ps1, or in Claude Code: /plugin marketplace add <this folder> then /plugin install command-center');
  if (pluginOn && manual) ok(false, 'Both the plugin and manual hooks are active', 'Run: ccc hooks uninstall');
  ok(!!(s.statusLine && /ccc-statusline/.test(s.statusLine.command || '')), 'Status line (optional)', 'Run: ccc statusline install');
  if (h) {
    const st = await request('GET', '/api/state');
    if (st) console.log(`  billing mode: ${st.body.billing.mode} (${st.body.billing.source})`);
    if (h.events === 0) console.log('  No hook events received yet: start a new Claude Code session after installing.');
  }
}

/** Plain-text summary for the /command-center:status slash command. */
async function summary() {
  if (!(await start({ quiet: true }))) return;
  const r = await request('GET', '/api/state');
  if (!r) return console.log('Backend not reachable.');
  const s = r.body;
  const usd = v => v == null ? '-' : '$' + v.toFixed(2);
  const d = ms => { const x = Math.round(ms / 1000); return x < 60 ? x + 's' : Math.floor(x / 60) + 'm' + String(x % 60).padStart(2, '0') + 's'; };
  const label = s.billing.mode === 'subscription' ? 'subscription-equivalent' : s.billing.mode === 'api' ? 'estimated API cost' : 'estimated token value';
  console.log(`Claude Command Center: ${s.active.length} active task(s), today ${usd(s.today.costUsd)} ${label} (${s.today.requests} model requests, measured tokens x list prices).`);
  for (const t of s.active) {
    const p = t.prediction && t.prediction.remainingMs != null ? `, about ${d(t.prediction.remainingMs)} left (prediction, ${t.prediction.basis}, n=${t.prediction.n})` : '';
    console.log(`- [${t.status}] ${t.prompt.slice(0, 70)}: ${d(t.elapsedMs)} elapsed${p}, ${t.toolCount} tool calls, ${usd(t.usage.costUsd)} so far`);
  }
  for (const n of s.notifications.filter(x => !x.read).slice(0, 5)) console.log(`! ${n.title}: ${n.body}`);
  console.log(`Dashboard: ${URL_BASE}`);
}

async function main() {
  const [cmd = 'open', a1, ...rest] = process.argv.slice(2);
  const force = rest.includes('--force') || a1 === '--force';
  switch (cmd) {
    case 'open': return open(a1 ? `#/${a1}` : '');
    case 'start': return start();
    case 'run': {
      const app = require('../server/index.js').createServer();
      const p = await app.listen();
      console.log(`Claude Command Center on http://127.0.0.1:${p} (Ctrl+C to stop)`);
      return;
    }
    case 'stop': return stop();
    case 'status': { const h = await health(); console.log(h ? JSON.stringify(h, null, 2) : 'Not running.'); return; }
    case 'doctor': return doctor();
    case 'summary': return summary();
    case 'statusline': return statusline(a1 || 'install', force);
    case 'hooks': return hooks(a1 || 'install');
    case 'notify-test': { await start({ quiet: true }); const r = await request('POST', '/api/notify/test', {}); console.log(r && r.body.sent ? 'Notification sent.' : 'Could not send a notification.'); return; }
    case 'help': default:
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 10).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
}

module.exports = { HOOK_EVENTS };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
