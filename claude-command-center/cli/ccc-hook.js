#!/usr/bin/env node
'use strict';
// Claude Code hook -> Command Center bridge.  Usage (from hooks.json): node ccc-hook.js <EventName>
// Design rules: never block Claude Code, never fail a hook, never print anything except the
// optional prompt-intelligence systemMessage on UserPromptSubmit (shown to you, not to the model).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOME = process.env.CCC_HOME || path.join(require('os').homedir(), '.claude-command-center');
const PORT = Number(process.env.CCC_PORT || 47821);
const event = process.argv[2] || '';
const started = Date.now();

function readStdin(maxMs) {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let s = '';
    const t = setTimeout(() => resolve(s), maxMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { s += d; });
    process.stdin.on('end', () => { clearTimeout(t); resolve(s); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(s); });
  });
}

function post(body, timeoutMs) {
  return new Promise(resolve => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/hook', method: 'POST', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-ccc': '1' } }, res => {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(out) : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(data);
  });
}

function spool(body) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.appendFileSync(path.join(HOME, 'spool.jsonl'), JSON.stringify(body) + '\n');
  } catch { /* nothing else we can do */ }
}

function startServer() {
  if (process.env.CCC_NO_AUTOSTART === '1') return;
  try {
    // One start attempt per 20s across all hook processes.
    const lock = path.join(HOME, 'autostart.lock');
    try { if (Date.now() - fs.statSync(lock).mtimeMs < 20000) return; } catch { /* no lock */ }
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(lock, String(process.pid));
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch { /* ignore */ }
}

(async () => {
  try {
    const raw = await readStdin(3000);
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { parse_error: true }; }
    payload._event = event || payload.hook_event_name;
    payload._ts = started;
    const res = await post(payload, event === 'UserPromptSubmit' ? 1500 : 800);
    if (!res) {
      spool(payload);
      if (event === 'SessionStart' || event === 'UserPromptSubmit') startServer();
    }
    if (event === 'UserPromptSubmit') {
      let line = res && res.systemMessage;
      if (!res) {
        // Backend not up yet: still give the recommendation, computed locally.
        try {
          const advisor = require('../server/advisor');
          const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); } catch { return {}; } })();
          if (!(cfg.advisor && cfg.advisor.showInChat === false)) line = advisor.chatLine(advisor.analyze(payload.prompt || ''));
        } catch { /* ignore */ }
      }
      if (line) process.stdout.write(JSON.stringify({ systemMessage: line }));
    }
  } catch { /* a monitoring hook must never break Claude Code */ }
  process.exit(0);
})();
