'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, request, runHook, scenario, fixtureProjects, tmpdir, fakeNotifier } = require('./helpers');
const { commandFor, windowsScript } = require('../server/notify');

test('engine: full task lifecycle from real-shaped hook events', async () => {
  const app = await startServer();
  try {
    app.config.update({ notifications: { finishMinSeconds: 1 } });
    const events = scenario();
    let promptRes;
    for (const e of events) {
      const r = app.engine.ingest(e);
      if (e._event === 'UserPromptSubmit' && !promptRes) promptRes = r;
    }
    // prompt intelligence answered the first prompt with a systemMessage
    assert.match(promptRes.systemMessage, /^◆ Command Center suggests/);
    const [t] = [...app.engine.tasks.values()];
    const v = app.engine.taskView(t, { detail: true });
    assert.equal(v.status, 'completed');
    assert.equal(v.toolErrors, 1);
    assert.equal(v.toolCount, 5); // TodoWrite, Agent, Grep (in subagent), Bash, Read
    assert.deepEqual(v.progress && [v.progress.completed, v.progress.total], [1, 4]);
    const agent = v.agents.find(a => a.id === 'agent-aaa');
    assert.equal(agent.type, 'Explore');
    assert.equal(agent.status, 'done');
    assert.equal(agent.model, 'claude-haiku-5-5'); // reported by the Agent tool result
    assert.equal(agent.modelSource, 'reported');
    const failed = v.tools.find(c => c.id === 'tu-bash');
    assert.equal(failed.status, 'error');
    assert.match(failed.error, /1 failing/);
    // notifications: blocked on permission, then finished
    const kinds = app.notifier.sent.map(n => n.kind);
    assert.ok(kinds.includes('blocked'), kinds.join(','));
    assert.ok(kinds.includes('finish'), kinds.join(','));
    // background agents kept the task open until the final Stop
    assert.ok(v.endedAt > events.find(e => e.background_tasks && e.background_tasks.length)._ts);
  } finally { await app.close(); }
});

test('engine: duplicate events are counted once; replay restores state without notifying', async () => {
  const home = tmpdir('ccc-home');
  const app = await startServer({ home });
  const events = scenario();
  try {
    for (const e of events) { app.engine.ingest(e); app.engine.ingest(e); }
    const t = [...app.engine.tasks.values()][0];
    assert.equal(t.toolErrors, 1);
    assert.equal(t.toolCount, 5);
  } finally { await app.close(); }

  const notifier = fakeNotifier();
  const again = await startServer({ home, notifier });
  try {
    const t2 = [...again.engine.tasks.values()][0];
    assert.equal(t2.status, 'completed');
    assert.equal(t2.toolCount, 5);
    assert.equal(notifier.sent.length, 0, 'replay must not re-send notifications');
  } finally { await again.close(); }
});

test('engine: interrupted, failed and session-end states', async () => {
  const app = await startServer();
  try {
    const base = { session_id: 's-2', cwd: '/w/x' };
    let ts = Date.now() - 60000;
    const e = (name, extra = {}) => app.engine.ingest({ ...base, _event: name, _ts: (ts += 1000), ...extra });
    e('UserPromptSubmit', { prompt: 'first task' });
    e('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'sleep 100' }, tool_use_id: 'b1' });
    e('UserPromptSubmit', { prompt: 'second task' }); // Esc + new prompt: no Stop for the first
    e('StopFailure', { error: 'API Error: 529 overloaded' });
    e('UserPromptSubmit', { prompt: 'third task' });
    e('SessionEnd', { reason: 'logout' });
    const ts3 = [...app.engine.tasks.values()].map(t => [t.prompt, t.status]);
    assert.deepEqual(ts3, [['first task', 'interrupted'], ['second task', 'failed'], ['third task', 'interrupted']]);
    assert.ok(app.notifier.sent.some(n => n.kind === 'fail' && /529/.test(n.body)));
  } finally { await app.close(); }
});

test('engine: usage from transcripts is joined to tasks, by model and by agent', async () => {
  const projectsDir = fixtureProjects();
  const app = await startServer({ projectsDir });
  try {
    const sid = '33fc458d-0f9a-4058-905e-f4cd7a16d86f';
    const recs = app.index.records({ sessionId: sid }).sort((a, b) => a.ts - b.ts);
    const start = recs[0].ts - 2000, end = recs[recs.length - 1].ts + 1000;
    app.engine.ingest({ session_id: sid, _event: 'UserPromptSubmit', _ts: start, prompt: 'probe', cwd: '/fixture/probe-work' });
    app.engine.ingest({ session_id: sid, _event: 'SubagentStart', _ts: start + 10, agent_id: 'adad64685c2db911d', agent_type: 'general-purpose' });
    app.engine.ingest({ session_id: sid, _event: 'Stop', _ts: end, background_tasks: [] });
    const t = [...app.engine.tasks.values()][0];
    const v = app.engine.taskView(t);
    assert.equal(v.usage.requests, recs.length);
    assert.ok(Math.abs(v.usage.costUsd - 0.00715157) < 1e-7, String(v.usage.costUsd)); // == Claude Code total_cost_usd
    const sub = v.usage.byAgent.find(a => a.key === 'adad64685c2db911d');
    assert.match(sub.label, /general-purpose/);
    assert.deepEqual(Object.keys(sub.models), ['Haiku 5.5']);
    assert.equal(v.agents[0].modelSource, 'measured');
    const models = await request(app.port, 'GET', '/api/models?range=all');
    assert.ok(models.body.models[0].agentTypes['general-purpose'] >= 2);
    const an = await request(app.port, 'GET', '/api/analytics?range=all');
    assert.equal(an.status, 200);
    assert.ok(an.body.totals.requests >= recs.length);
    assert.ok(an.body.claudeCodeReported.sessions >= 2);
  } finally { await app.close(); }
});

test('server: localhost guard, CSRF header, static files', async () => {
  const app = await startServer();
  try {
    assert.equal((await request(app.port, 'GET', '/api/state', undefined, { host: 'evil.example' })).status, 403);
    assert.equal((await request(app.port, 'POST', '/api/config', { billing: 'api' }, { 'x-ccc': '' })).status, 403);
    const html = await request(app.port, 'GET', '/');
    assert.match(String(html.body), /Claude Command Center/);
    assert.equal((await request(app.port, 'GET', '/../package.json')).status, 404);
    const cfg = await request(app.port, 'POST', '/api/config', { adminApiKey: 'sk-ant-admin-secret-1234' });
    assert.equal(cfg.body.adminApiKey, '••••1234', 'secret never echoed');
  } finally { await app.close(); }
});

test('bridge: ccc-hook.js forwards events and returns the advisor line', async () => {
  const home = tmpdir('ccc-home');
  const app = await startServer({ home });
  try {
    const env = { CCC_PORT: String(app.port), CCC_HOME: home };
    const r = await runHook('UserPromptSubmit', { session_id: 'b-1', prompt: 'what is a monad?', cwd: '/w' }, env);
    assert.equal(r.code, 0);
    const out = JSON.parse(r.out);
    assert.match(out.systemMessage, /Haiku 5\.5/);
    const r2 = await runHook('PreToolUse', { session_id: 'b-1', tool_name: 'Read', tool_input: { file_path: '/w/a.txt' }, tool_use_id: 'x1' }, env);
    assert.equal(r2.code, 0);
    assert.equal(r2.out, '', 'non-prompt hooks print nothing');
    const t = [...app.engine.tasks.values()][0];
    assert.equal(t.toolCount, 1);
  } finally { await app.close(); }
});

test('bridge: with the backend down, hooks exit 0 fast, spool, and still advise; spool is ingested on start', async () => {
  const home = tmpdir('ccc-home');
  const env = { CCC_PORT: '1', CCC_HOME: home }; // nothing listens on port 1
  const r = await runHook('UserPromptSubmit', { session_id: 'off-1', prompt: 'rename foo to bar', cwd: '/w' }, env);
  assert.equal(r.code, 0);
  assert.ok(r.ms < 3000, `took ${r.ms}ms`);
  assert.match(JSON.parse(r.out).systemMessage, /Command Center suggests/);
  await runHook('Stop', { session_id: 'off-1', background_tasks: [] }, env);
  const spool = fs.readFileSync(path.join(home, 'spool.jsonl'), 'utf8').trim().split('\n');
  assert.equal(spool.length, 2);
  const app = await startServer({ home });
  try {
    const t = [...app.engine.tasks.values()][0];
    assert.equal(t.status, 'completed');
    assert.equal(app.notifier.sent.length, 0, 'old spooled events do not notify');
    assert.ok(!fs.existsSync(path.join(home, 'spool.jsonl')));
  } finally { await app.close(); }
});

test('bridge: garbage on stdin never breaks a hook', async () => {
  const { spawn } = require('child_process');
  const code = await new Promise(res => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'cli', 'ccc-hook.js'), 'PreToolUse'], { env: { ...process.env, CCC_PORT: '1', CCC_HOME: tmpdir(), CCC_NO_AUTOSTART: '1' } });
    p.on('close', res);
    p.stdin.end('{not json');
  });
  assert.equal(code, 0);
});

test('status line endpoint renders task state and Claude Code cost', async () => {
  const app = await startServer();
  try {
    app.engine.ingest({ session_id: 'sl-1', _event: 'UserPromptSubmit', _ts: Date.now() - 5000, prompt: 'what is a closure?' });
    const r = await request(app.port, 'POST', '/api/statusline', { session_id: 'sl-1', model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, cost: { total_cost_usd: 0.42 } });
    const plain = r.body.line.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(plain, /◆ CCC │ Opus 5\.5 │ ● \d+s/);
    assert.match(plain, /tip: Haiku 5\.5·low/);
    assert.match(plain, /\$0\.42/);
  } finally { await app.close(); }
});

test('notify: Windows toast command is a valid encoded PowerShell script with escaped XML', () => {
  const [cmd, args] = commandFor('win32', { title: 'Task <done> & "ok"', body: "it's fine", url: 'http://127.0.0.1:47821/#/task/a', aumid: 'X' });
  assert.equal(cmd, 'powershell.exe');
  const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.match(script, /Task &lt;done&gt; &amp; &quot;ok&quot;/);
  assert.match(script, /it&apos;s fine/);
  assert.ok(!/<text>[^<]*['"][^<]*<\/text>/.test(windowsScript({ title: "a'b", body: 'c' })));
  assert.equal(commandFor('darwin', { title: 't', body: 'b' })[0], 'osascript');
});
