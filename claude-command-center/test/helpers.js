'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_PROJECTS = path.join(__dirname, 'fixtures', 'projects');

function tmpdir(name = 'ccc') { return fs.mkdtempSync(path.join(os.tmpdir(), name + '-')); }

/** Copy fixture transcripts into a writable temp projects dir. */
function fixtureProjects() {
  const dir = tmpdir('ccc-projects');
  fs.cpSync(FIXTURE_PROJECTS, dir, { recursive: true });
  return dir;
}

/** A Notifier stand-in that records instead of showing OS toasts. */
function fakeNotifier() {
  const sent = [];
  return { sent, send(n) { sent.push(n); return true; } };
}

async function startServer(opts = {}) {
  const { createServer } = require('../server/index.js');
  const home = opts.home || tmpdir('ccc-home');
  const projectsDir = opts.projectsDir || tmpdir('ccc-empty-projects');
  const notifier = opts.notifier || fakeNotifier();
  const claudeJson = path.join(home, 'claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify(opts.claudeJson || {}));
  const app = createServer({ home, projectsDir, port: opts.port || 0, notifier, claudeJson, env: opts.env || {} });
  const port = await app.listen();
  return { ...app, port, home, projectsDir, notifier };
}

function request(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method,
      headers: { 'x-ccc': '1', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, res => {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('end', () => { let j; try { j = JSON.parse(out); } catch { j = out; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

/** Run cli/ccc-hook.js exactly as Claude Code does: event name as argv, payload on stdin. */
function runHook(event, payload, env) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(ROOT, 'cli', 'ccc-hook.js'), event], { env: { ...process.env, CCC_NO_AUTOSTART: '1', ...env } });
    let out = '', err = '';
    const t0 = Date.now();
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err, ms: Date.now() - t0 }));
    p.stdin.end(JSON.stringify(payload));
  });
}

/** A realistic hook-event sequence, shaped exactly like the payloads Claude Code 2.1.318 sent in our probes. */
function scenario({ session = 'sess-1111-2222', t0 = Date.now() - 120000, cwd = '/work/demo-app' } = {}) {
  const base = { session_id: session, transcript_path: `/x/${session}.jsonl`, cwd, permission_mode: 'default', effort: { level: 'medium' } };
  let t = t0;
  const at = d => (t += d);
  const ev = (name, extra, dt = 200) => ({ ...base, hook_event_name: name, _event: name, _ts: at(dt), ...extra });
  return [
    ev('SessionStart', { source: 'startup', effort: undefined }, 0),
    ev('UserPromptSubmit', { prompt: 'Refactor the payment module and add unit tests for the refund flow. Debug the failing test in refunds.spec.ts.', prompt_id: 'p1' }),
    ev('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Read module', status: 'completed' }, { content: 'Refactor', status: 'in_progress' }, { content: 'Write tests', status: 'pending' }, { content: 'Fix failing test', status: 'pending' }] }, tool_use_id: 'tu-todo' }),
    ev('PostToolUse', { tool_name: 'TodoWrite', tool_input: {}, tool_response: {}, tool_use_id: 'tu-todo', duration_ms: 2 }),
    ev('PreToolUse', { tool_name: 'Agent', tool_input: { description: 'explore payments', prompt: 'look around', subagent_type: 'Explore', model: 'haiku' }, tool_use_id: 'tu-agent' }),
    ev('PostToolUse', { tool_name: 'Agent', tool_input: { description: 'explore payments', subagent_type: 'Explore' }, tool_response: { isAsync: true, status: 'async_launched', agentId: 'agent-aaa', resolvedModel: 'claude-haiku-5-5' }, tool_use_id: 'tu-agent', duration_ms: 40 }),
    ev('SubagentStart', { agent_id: 'agent-aaa', agent_type: 'Explore' }),
    ev('PreToolUse', { agent_id: 'agent-aaa', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'refund' }, tool_use_id: 'tu-grep' }),
    ev('PostToolUse', { agent_id: 'agent-aaa', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'refund' }, tool_response: { stdout: 'x' }, tool_use_id: 'tu-grep', duration_ms: 30 }),
    ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test -- refunds' }, tool_use_id: 'tu-bash' }),
    ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test -- refunds' }, permission_suggestions: [] }),
    ev('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test -- refunds' }, tool_use_id: 'tu-bash', error: 'Exit code 1: 1 failing', is_interrupt: false, duration_ms: 4200 }, 5000),
    ev('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/work/demo-app/src/refunds.ts' }, tool_use_id: 'tu-read' }),
    ev('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/work/demo-app/src/refunds.ts' }, tool_response: { type: 'text' }, tool_use_id: 'tu-read', duration_ms: 5 }),
    ev('SubagentStop', { agent_id: 'agent-aaa', agent_type: 'Explore', last_assistant_message: 'Found 3 files', agent_transcript_path: '/x/agent-aaa.jsonl', background_tasks: [] }, 3000),
    ev('Stop', { last_assistant_message: 'Waiting for the explore agent.', background_tasks: [{ id: 'agent-aaa', type: 'subagent', status: 'running', description: 'explore payments', agent_type: 'Explore' }] }),
    ev('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>agent-aaa</task-id>\n<status>completed</status>\n</task-notification>', prompt_id: 'p2' }),
    ev('Stop', { last_assistant_message: 'Refactor done; refund tests pass.', background_tasks: [] }, 40000),
  ];
}

module.exports = { ROOT, tmpdir, fixtureProjects, fakeNotifier, startServer, request, runHook, scenario, FIXTURE_PROJECTS };
