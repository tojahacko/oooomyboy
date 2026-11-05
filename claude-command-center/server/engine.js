'use strict';
// The live model of what Claude Code is doing, built from hook events (live) and transcripts
// (measured usage). Every number it reports is tagged with where it came from:
//   measured  - read from Claude Code (hook payloads, transcript usage, Claude Code's cost record)
//   estimate  - computed by us from measured tokens x published list prices
//   predicted - forecast by the predictor from measured history
//   heuristic - prompt-intelligence recommendation
const fs = require('fs');
const path = require('path');
const advisor = require('./advisor');
const { displayName, costOf, family } = require('./pricing');

const MAX_TOOLS_PER_TASK = 400;
const MAX_TASKS = 5000;
const MAX_NOTIFICATIONS = 200;

const ACTIVE = new Set(['running', 'blocked', 'waiting', 'background']);

class EventLog {
  constructor(file) { this.file = file; }
  append(evt) {
    try { fs.appendFileSync(this.file, JSON.stringify(evt) + '\n'); } catch { /* disk full etc: live state still works */ }
  }
  *read() {
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { yield JSON.parse(line); } catch { /* skip a torn line */ }
    }
  }
  /** Keep the log bounded: drop tool-level events older than `days`. */
  compact(days, now = Date.now()) {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < 30 * 1024 * 1024) return;
    const keepTool = now - 14 * 86400000, keepAll = now - days * 86400000;
    const out = [];
    for (const e of this.read()) {
      if (e._ts < keepAll) continue;
      if (/^(PreToolUse|PostToolUse|PostToolUseFailure|PermissionDenied|statusline)$/.test(e._event) && e._ts < keepTool) continue;
      out.push(JSON.stringify(e));
    }
    fs.writeFileSync(this.file + '.tmp', out.join('\n') + '\n');
    fs.renameSync(this.file + '.tmp', this.file);
  }
}

/** Trim a hook payload before storing it: keep what we use, drop big tool output. */
function slim(p) {
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'tool_response') out[k] = slimResponse(p.tool_name, v);
    else if (k === 'tool_input') out[k] = slimInput(p.tool_name, v);
    else if (k === 'transcript_path' || k === 'scratchpad_dir') continue;
    else if (k === 'last_assistant_message' || k === 'prompt' || k === 'error' || k === 'message') out[k] = typeof v === 'string' ? v.slice(0, 4000) : v;
    else out[k] = v;
  }
  if (p.transcript_path) out.transcript_path = p.transcript_path;
  return out;
}

function slimInput(tool, v) {
  if (!v || typeof v !== 'object') return v;
  if (tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate') return v;
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = typeof x === 'string' ? x.slice(0, 300) : (typeof x === 'object' ? undefined : x);
  return o;
}

function slimResponse(tool, v) {
  if (!v || typeof v !== 'object') return typeof v === 'string' ? v.slice(0, 300) : v;
  const keep = ['agentId', 'resolvedModel', 'status', 'isAsync', 'interrupted', 'is_error', 'totalDurationMs', 'totalTokens', 'totalToolUseCount', 'usage', 'task', 'id', 'taskId'];
  const o = {};
  for (const k of keep) if (v[k] !== undefined) o[k] = v[k];
  return o;
}

function toolSummary(name, input) {
  const i = input || {};
  const pick = i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.description || i.subject || i.prompt || '';
  let s = typeof pick === 'string' ? pick : '';
  if ((name === 'Read' || name === 'Edit' || name === 'Write' || name === 'NotebookEdit') && s) s = s.replace(/^.*[\\/]([^\\/]+[\\/][^\\/]+)$/, '…/$1');
  return s.replace(/\s+/g, ' ').slice(0, 140);
}

const isAgentTool = n => n === 'Agent' || n === 'Task';

class Engine {
  constructor({ index, predictor, notifier, config, log, eventLog, now = () => Date.now(), billing = () => ({ mode: 'unknown' }) }) {
    this.index = index;
    this.predictor = predictor;
    this.notifier = notifier;
    this.config = config;
    this.log = log || (() => {});
    this.eventLog = eventLog;
    this.now = now;
    this.billing = billing;
    this.sessions = new Map();
    this.tasks = new Map();
    this.taskOrder = [];
    this.notifications = [];
    this.listeners = new Set();
    this.replaying = false;
    this.lastAgentCall = new Map(); // sessionId -> [pending Agent tool calls]
    this.stats = { events: 0, startedAt: now() };
    this.historyDirty = true;
    if (index) index.onChange(() => { this.historyDirty = true; this.sessionUsageCache = null; this.changed(); });
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed(kind = 'state') { for (const fn of this.listeners) { try { fn(kind); } catch { /* ignore */ } } }

  /** The same hook event can reach us twice (spool + log); count it once. */
  isDuplicate(evt) {
    if (evt._event === 'statusline') return false;
    const key = `${evt._event}|${evt.session_id}|${evt.tool_use_id || evt.agent_id || ''}|${evt._ts}`;
    this.seen = this.seen || new Map();
    if (this.seen.has(key)) return true;
    this.seen.set(key, true);
    if (this.seen.size > 20000) this.seen.delete(this.seen.keys().next().value);
    return false;
  }

  replay() {
    if (!this.eventLog) return 0;
    this.replaying = true;
    let n = 0;
    for (const e of this.eventLog.read()) {
      if (this.isDuplicate(e)) continue; try { this.apply(e); } catch (err) { this.log(`replay ${e._event}: ${err.message}`); } n++; }
    this.replaying = false;
    // Anything still "active" after a replay of an old log with no live Claude Code is stale;
    // it is reconciled when the session sends its next event or ends.
    return n;
  }

  /** Entry point for a hook event from ccc-hook.js. Returns the hook response. */
  ingest(raw) {
    const evt = slim(raw);
    evt._event = raw._event || raw.hook_event_name;
    evt._ts = raw._ts || this.now();
    if (!evt._event) return { ok: false, error: 'missing event name' };
    if (this.isDuplicate(evt)) return { ok: true, duplicate: true };
    if (this.eventLog) this.eventLog.append(evt);
    let res = {};
    try { res = this.apply(evt) || {}; } catch (e) {
      // A bug in our bookkeeping must not lose the event (it is logged) or bother Claude Code.
      this.log(`apply ${evt._event} failed: ${e.stack || e.message}`);
      this.stats.errors = (this.stats.errors || 0) + 1;
    }
    this.changed();
    return { ok: true, ...res };
  }

  session(id, evt) {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, startedAt: evt._ts, cwd: evt.cwd, project: evt.cwd ? path.basename(evt.cwd) : null, status: 'active', currentTaskId: null, transcriptPath: null, model: null, lastEventAt: evt._ts };
      this.sessions.set(id, s);
    }
    if (evt.cwd) { s.cwd = evt.cwd; s.project = path.basename(evt.cwd); }
    if (evt.transcript_path) s.transcriptPath = evt.transcript_path;
    if (evt.permission_mode) s.permissionMode = evt.permission_mode;
    if (evt.effort && evt.effort.level) s.effort = evt.effort.level;
    s.lastEventAt = evt._ts;
    if (s.status === 'ended' && evt._event !== 'SessionEnd') s.status = 'active';
    return s;
  }

  findTool(t, evt) {
    const id = evt.tool_use_id;
    for (let i = t.tools.length - 1; i >= 0; i--) {
      const c = t.tools[i];
      if (id ? c.id === id : (c.name === evt.tool_name && c.status === 'running')) return c;
    }
    return null;
  }

  currentTask(s) {
    const t = s.currentTaskId && this.tasks.get(s.currentTaskId);
    return t || null;
  }

  apply(evt) {
    this.stats.events++;
    const sid = evt.session_id;
    if (!sid) return null;
    const s = this.session(sid, evt);
    const t = this.currentTask(s);
    switch (evt._event) {
      case 'SessionStart':
        s.source = evt.source;
        if (evt.model) s.model = typeof evt.model === 'string' ? evt.model : evt.model.id;
        return null;
      case 'UserPromptSubmit': return this.onPrompt(s, t, evt);
      case 'PreToolUse': return this.onPreTool(s, t, evt);
      case 'PermissionRequest': return this.onPermission(s, t, evt);
      case 'PostToolUse': return this.onPostTool(s, t, evt, false);
      case 'PostToolUseFailure': return this.onPostTool(s, t, evt, true);
      case 'PermissionDenied': {
        if (t) { const c = this.findTool(t, evt); if (c) { c.status = 'denied'; c.endedAt = evt._ts; } if (t.status === 'blocked') t.status = 'running'; }
        return null;
      }
      case 'SubagentStart': return this.onSubagentStart(s, t, evt);
      case 'SubagentStop': return this.onSubagentStop(s, t, evt);
      case 'Notification': return this.onNotification(s, t, evt);
      case 'Stop': return this.onStop(s, t, evt);
      case 'StopFailure': return this.onStopFailure(s, t, evt);
      case 'TaskCreated': case 'TaskCompleted': return this.onTaskItem(t, evt);
      case 'PreCompact': if (t) t.compactions = (t.compactions || 0) + 1; return null;
      case 'SessionEnd': {
        if (t && ACTIVE.has(t.status)) this.finish(t, t.status === 'background' ? 'completed' : 'interrupted', evt._ts, { reason: 'session ended (' + (evt.reason || 'exit') + ')' });
        s.status = 'ended';
        s.endedAt = evt._ts;
        return null;
      }
      case 'statusline': {
        if (evt.model) s.model = evt.model.id || s.model, s.modelName = evt.model.display_name;
        if (evt.cost) s.claudeCodeCost = { usd: evt.cost.total_cost_usd, durationMs: evt.cost.total_duration_ms, apiDurationMs: evt.cost.total_api_duration_ms, linesAdded: evt.cost.total_lines_added, linesRemoved: evt.cost.total_lines_removed, at: evt._ts };
        if (evt.context_window) s.contextWindow = evt.context_window;
        if (evt.version) s.version = evt.version;
        return null;
      }
      default: return null;
    }
  }

  // ---- task lifecycle -------------------------------------------------------------------

  onPrompt(s, prev, evt) {
    const text = String(evt.prompt || '');
    if (/^\s*<task-notification>/.test(text)) {
      // A background agent reported back: same task continues.
      if (prev) {
        const id = (/<task-id>([^<]+)</.exec(text) || [])[1];
        const st = (/<status>([^<]+)</.exec(text) || [])[1];
        if (id && prev.agents[id]) { prev.agents[id].status = st === 'completed' ? 'done' : (st || 'done'); prev.agents[id].endedAt = prev.agents[id].endedAt || evt._ts; }
        if (!ACTIVE.has(prev.status)) { prev.status = 'running'; prev.endedAt = null; prev.reopened = (prev.reopened || 0) + 1; }
        else prev.status = 'running';
      }
      return null;
    }
    if (prev && ACTIVE.has(prev.status)) {
      // A new prompt while the previous one was still active: the user interrupted it
      // (Esc fires no Stop hook) or it was waiting on background work.
      this.finish(prev, prev.status === 'background' ? 'completed' : 'interrupted', evt._ts, { reason: 'next prompt submitted' });
    }
    const advice = advisor.analyze(text);
    const t = {
      id: `${s.id.slice(0, 8)}-${evt._ts.toString(36)}`,
      sessionId: s.id, promptId: evt.prompt_id || null, project: s.project, cwd: s.cwd,
      prompt: text.slice(0, 2000), promptLen: text.length,
      startedAt: evt._ts, endedAt: null, status: 'running', advice,
      effort: (evt.effort && evt.effort.level) || s.effort || null, permissionMode: evt.permission_mode || s.permissionMode,
      tools: [], toolCount: 0, toolErrors: 0, agents: {}, todos: null, items: {},
      lastMessage: '', source: 'hooks', notified: {},
    };
    t.predictionAtStart = this.predictFor(t, 0);
    this.tasks.set(t.id, t);
    this.taskOrder.push(t.id);
    if (this.taskOrder.length > MAX_TASKS) this.tasks.delete(this.taskOrder.shift());
    s.currentTaskId = t.id;

    if (this.replaying) return null;
    const cfg = this.config.get();
    if (cfg.advisor && cfg.advisor.showInChat === false) return { advice };
    const currentModelName = s.modelName || (s.model ? displayName(s.model) : this.lastModelName(s.id));
    const h = t.predictionAtStart;
    const line = advisor.chatLine(advice, { currentModelName, history: h && h.basis !== 'none' ? { n: h.n, p50Ms: h.p50Ms, scope: h.scope } : null });
    return { advice, systemMessage: line };
  }

  onPreTool(s, t, evt) {
    if (!t) t = this.adoptTask(s, evt);
    const name = evt.tool_name;
    const call = {
      id: evt.tool_use_id || `${name}-${evt._ts}`, name, summary: toolSummary(name, evt.tool_input),
      agentId: evt.agent_id || null, startedAt: evt._ts, endedAt: null, status: 'running',
    };
    if (t.tools.length >= MAX_TOOLS_PER_TASK) t.tools.shift();
    t.tools.push(call);
    t.toolCount++;
    t.lastActivityAt = evt._ts;
    if (t.status === 'blocked' || t.status === 'waiting') t.status = 'running';
    const input = evt.tool_input || {};
    if (isAgentTool(name)) {
      const q = this.lastAgentCall.get(s.id) || [];
      q.push({ toolUseId: call.id, type: input.subagent_type || 'general-purpose', description: input.description || '', modelAlias: input.model || null, at: evt._ts });
      this.lastAgentCall.set(s.id, q.slice(-20));
    }
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      t.todos = input.todos.map(x => ({ text: x.content || x.activeForm || '', status: x.status || 'pending' }));
    }
    if (name === 'TaskCreate' && input.subject && !evt.agent_id) {
      t.items[`pending:${call.id}`] = { text: input.subject, status: 'pending' };
      this.syncItems(t);
    }
    if (name === 'TaskUpdate' && input.taskId && !evt.agent_id) {
      const it = t.items[input.taskId] || (t.items[input.taskId] = { text: input.subject || `task #${input.taskId}`, status: 'pending' });
      if (input.status) it.status = input.status === 'deleted' ? 'deleted' : input.status;
      if (input.subject) it.text = input.subject;
      this.syncItems(t);
    }
    if (!this.replaying && (name === 'AskUserQuestion' || name === 'ExitPlanMode') && !evt.agent_id) {
      t.status = 'waiting';
      this.attention(t, name === 'AskUserQuestion' ? 'Claude has a question for you' : 'A plan is ready for your review', t.prompt, `ask-${call.id}`);
    }
    return null;
  }

  syncItems(t) {
    const items = Object.values(t.items).filter(x => x.status !== 'deleted');
    if (!items.length) return;
    // TaskCreate/TaskUpdate lists take precedence only when no TodoWrite list exists.
    if (!t.todos || t.todosFromItems) {
      t.todos = items.map(x => ({ text: x.text, status: x.status }));
      t.todosFromItems = true;
    }
  }

  onTaskItem(t, evt) {
    if (!t) return null;
    const id = evt.task_id || evt.taskId || (evt.task && evt.task.id);
    if (!id) return null;
    const it = t.items[id] || (t.items[id] = { text: evt.task_subject || evt.subject || (evt.task && evt.task.subject) || `task #${id}`, status: 'pending' });
    if (evt._event === 'TaskCompleted') it.status = 'completed';
    this.syncItems(t);
    return null;
  }

  onPermission(s, t, evt) {
    if (!t) t = this.adoptTask(s, evt);
    if (evt.agent_id && t.status !== 'running') return null;
    t.status = 'blocked';
    t.blockedOn = { tool: evt.tool_name, summary: toolSummary(evt.tool_name, evt.tool_input), at: evt._ts };
    if (!this.replaying) this.attention(t, `Approval needed: ${evt.tool_name}`, t.blockedOn.summary || t.prompt, `perm-${evt.tool_name}-${Math.floor(evt._ts / 5000)}`, 'blocked');
    return null;
  }

  onPostTool(s, t, evt, failed) {
    if (!t) t = this.adoptTask(s, evt);
    const c = this.findTool(t, evt) || (() => {
      const x = { id: evt.tool_use_id || `${evt.tool_name}-${evt._ts}`, name: evt.tool_name, summary: toolSummary(evt.tool_name, evt.tool_input), agentId: evt.agent_id || null, startedAt: evt._ts - (evt.duration_ms || 0) };
      t.tools.push(x); t.toolCount++; return x;
    })();
    c.endedAt = evt._ts;
    if (evt.duration_ms != null) c.durationMs = evt.duration_ms;
    t.lastActivityAt = evt._ts;
    if (t.status === 'blocked') t.status = 'running';
    if (failed) {
      c.status = evt.is_interrupt ? 'interrupted' : 'error';
      c.error = String(evt.error || 'failed').slice(0, 400);
      if (!evt.is_interrupt) t.toolErrors++;
      const limit = (this.config.get().notifications || {}).onToolErrors;
      if (!this.replaying && limit > 0 && t.toolErrors === limit) {
        this.notify(t, 'errors', `${t.toolErrors} tool errors in one task`, `Latest: ${c.name} — ${c.error.slice(0, 120)}`);
      }
    } else {
      c.status = 'done';
    }
    if (isAgentTool(evt.tool_name) && evt.tool_response) {
      const r = evt.tool_response;
      const aid = r.agentId;
      if (aid) {
        const a = t.agents[aid] || (t.agents[aid] = { id: aid, startedAt: c.startedAt, status: 'running' });
        a.toolUseId = c.id;
        a.description = a.description || (evt.tool_input && evt.tool_input.description) || '';
        a.type = a.type || (evt.tool_input && evt.tool_input.subagent_type) || 'general-purpose';
        if (r.resolvedModel) a.model = r.resolvedModel;
        a.async = !!r.isAsync;
        if (!r.isAsync && r.status !== 'async_launched') { a.status = failed ? 'failed' : 'done'; a.endedAt = evt._ts; }
      }
    }
    if (evt.tool_name === 'TaskCreate' && !evt.agent_id) {
      const r = evt.tool_response || {};
      const id = (r.task && r.task.id) || r.taskId || r.id || (/#(\d+)/.exec(typeof r === 'string' ? r : JSON.stringify(r)) || [])[1];
      const pend = t.items[`pending:${c.id}`];
      if (pend && id) { delete t.items[`pending:${c.id}`]; t.items[id] = pend; }
      this.syncItems(t);
    }
    return null;
  }

  onSubagentStart(s, t, evt) {
    if (!t) t = this.adoptTask(s, evt);
    const q = this.lastAgentCall.get(s.id) || [];
    const idx = q.findIndex(x => x.type === evt.agent_type);
    const call = idx >= 0 ? q.splice(idx, 1)[0] : null;
    const a = t.agents[evt.agent_id] || (t.agents[evt.agent_id] = { id: evt.agent_id });
    Object.assign(a, {
      type: evt.agent_type || a.type, startedAt: a.startedAt || evt._ts, status: 'running',
      description: a.description || (call && call.description) || '', modelAlias: call && call.modelAlias, toolUseId: a.toolUseId || (call && call.toolUseId),
    });
    return null;
  }

  onSubagentStop(s, t, evt) {
    if (!t) return null;
    const a = t.agents[evt.agent_id] || (t.agents[evt.agent_id] = { id: evt.agent_id, type: evt.agent_type, startedAt: evt._ts });
    a.status = 'done';
    a.endedAt = evt._ts;
    a.lastMessage = String(evt.last_assistant_message || '').slice(0, 600);
    if (evt.agent_transcript_path) a.transcriptPath = evt.agent_transcript_path;
    return null;
  }

  onNotification(s, t, evt) {
    const type = evt.notification_type || '';
    const msg = String(evt.message || '');
    if (!t) return null;
    if (type === 'permission_prompt' || /permission/i.test(msg)) {
      t.status = 'blocked';
      if (!this.replaying) this.attention(t, 'Claude needs your permission', msg || t.prompt, `perm-n-${Math.floor(evt._ts / 5000)}`, 'blocked');
    } else if (type === 'idle_prompt' || /waiting for your input/i.test(msg)) {
      if (!this.replaying && !(t.notified.finish && evt._ts - t.notified.finish < 120000)) {
        this.attention(t, 'Claude is waiting for your input', msg || t.prompt, `idle-${t.id}`);
      }
    } else if (type === 'elicitation_dialog') {
      t.status = 'waiting';
      if (!this.replaying) this.attention(t, 'Input requested', msg || t.prompt, `elic-${Math.floor(evt._ts / 5000)}`);
    } else if (type !== 'auth_success' && msg && !this.replaying) {
      this.attention(t, 'Claude Code', msg, `n-${Math.floor(evt._ts / 5000)}`);
    }
    return null;
  }

  onStop(s, t, evt) {
    if (!t) return null;
    t.lastMessage = String(evt.last_assistant_message || '').slice(0, 2000);
    const bg = (evt.background_tasks || []).filter(b => b.status === 'running');
    t.backgroundRunning = bg.length;
    if (bg.length) {
      t.status = 'background';
      for (const b of bg) {
        if (b.type === 'subagent' && !t.agents[b.id]) t.agents[b.id] = { id: b.id, type: b.agent_type, description: b.description, status: 'running', startedAt: evt._ts, async: true };
      }
      return null;
    }
    this.finish(t, 'completed', evt._ts);
    return null;
  }

  onStopFailure(s, t, evt) {
    if (!t) t = this.adoptTask(s, evt);
    const err = evt.error || evt.error_message || evt.reason || evt.message || (evt.error_type ? `${evt.error_type}` : 'the turn ended with an API error');
    this.finish(t, 'failed', evt._ts, { reason: typeof err === 'string' ? err : JSON.stringify(err).slice(0, 300) });
    return null;
  }

  /** Events can arrive for a session whose prompt we never saw (plugin installed mid-session). */
  adoptTask(s, evt) {
    const t = {
      id: `${s.id.slice(0, 8)}-${evt._ts.toString(36)}`, sessionId: s.id, project: s.project, cwd: s.cwd,
      prompt: '(task already running when Command Center started)', promptLen: 0, startedAt: evt._ts, endedAt: null,
      status: 'running', advice: advisor.analyze(''), tools: [], toolCount: 0, toolErrors: 0, agents: {}, todos: null, items: {},
      lastMessage: '', source: 'hooks', adopted: true, notified: {},
    };
    this.tasks.set(t.id, t);
    this.taskOrder.push(t.id);
    s.currentTaskId = t.id;
    return t;
  }

  finish(t, status, at, extra = {}) {
    if (!t || (!ACTIVE.has(t.status) && t.status === status)) return;
    t.status = status;
    t.endedAt = at;
    t.durationMs = Math.max(0, at - t.startedAt);
    Object.assign(t, extra);
    for (const c of t.tools) if (c.status === 'running') { c.status = status === 'completed' ? 'done' : status; c.endedAt = at; }
    for (const a of Object.values(t.agents)) if (a.status === 'running' && status !== 'completed') { a.status = status; a.endedAt = at; }
    if (status === 'completed' && !t.adopted) {
      const p = t.predictionAtStart || {};
      this.predictor.add({ tier: t.advice.tier, durationMs: t.durationMs, endedAt: at, predictedP50Ms: p.p50Ms, predictedP25Ms: p.p25Ms, predictedP80Ms: p.p80Ms, source: 'hooks' });
    }
    if (this.replaying) return;
    const cfg = this.config.get().notifications || {};
    if (status === 'completed' && cfg.onFinish && t.durationMs >= (cfg.finishMinSeconds || 0) * 1000) {
      const cost = this.taskUsage(t).summary;
      const costTxt = cost.costUsd != null && cost.requests ? ` · ≈$${cost.costUsd.toFixed(2)}` : '';
      t.notified.finish = at;
      this.notify(t, 'finish', `Task finished · ${advisor.fmtDur(t.durationMs)}${costTxt}`, excerpt(t.prompt));
    } else if (status === 'failed' && cfg.onFail) {
      this.notify(t, 'fail', 'Task failed', `${excerpt(t.prompt, 60)} — ${String(t.reason || '').slice(0, 120)}`);
    }
  }

  // ---- notifications --------------------------------------------------------------------

  attention(t, title, body, key, kind = 'attention') {
    const cfg = this.config.get().notifications || {};
    if (!cfg.onAttention) return;
    if (t.notified[key]) return;
    t.notified[key] = this.now();
    this.notify(t, kind, title, excerpt(body, 160));
  }

  notify(t, kind, title, body) {
    const n = { id: `${kind}-${t.id}-${this.now()}`, kind, title, body, taskId: t.id, sessionId: t.sessionId, project: t.project, at: this.now(), read: false };
    n.url = `http://127.0.0.1:${process.env.CCC_PORT || 47821}/#/task/${encodeURIComponent(t.id)}`;
    this.notifications.unshift(n);
    if (this.notifications.length > MAX_NOTIFICATIONS) this.notifications.pop();
    if (this.notifier) n.desktop = this.notifier.send(n);
    this.changed('notification');
    return n;
  }

  // ---- derived data ---------------------------------------------------------------------

  sessionRecords(sessionId) {
    if (!this.index) return [];
    if (!this.sessionUsageCache) {
      const m = new Map();
      for (const r of this.index.usage.values()) {
        if (!m.has(r.sessionId)) m.set(r.sessionId, []);
        m.get(r.sessionId).push(r);
      }
      for (const arr of m.values()) arr.sort((a, b) => a.ts - b.ts);
      this.sessionUsageCache = m;
    }
    return this.sessionUsageCache.get(sessionId) || [];
  }

  lastModelName(sessionId) {
    const recs = this.sessionRecords(sessionId).filter(r => !r.agentId);
    return recs.length ? displayName(recs[recs.length - 1].model) : null;
  }

  taskUsage(t) {
    const end = (t.endedAt || this.now()) + 3000;
    const recs = this.sessionRecords(t.sessionId).filter(r => r.ts >= t.startedAt - 1000 && r.ts <= end);
    return { records: recs, summary: summarize(recs, id => this.agentLabel(t, id)) };
  }

  agentLabel(t, agentId) {
    if (!agentId) return { key: 'main', label: 'Main session', type: 'main' };
    const a = (t && t.agents[agentId]) || {};
    const meta = (this.index && this.index.agents[agentId]) || {};
    const type = a.type || meta.agentType || 'subagent';
    return { key: agentId, label: `${type}${(a.description || meta.description) ? ' · ' + (a.description || meta.description) : ''}`, type };
  }

  predictFor(t, elapsedMs) {
    this.ensureHistory();
    const todos = t.todos && t.todos.length ? { total: t.todos.length, completed: t.todos.filter(x => x.status === 'completed').length } : null;
    return this.predictor.predict({ tier: t.advice.tier, elapsedMs, todos });
  }

  /** Rebuild the predictor's history from hook tasks + transcript-reconstructed tasks. */
  ensureHistory() {
    if (!this.historyDirty) return;
    this.historyDirty = false;
    const list = [];
    const seen = [];
    for (const id of this.taskOrder) {
      const t = this.tasks.get(id);
      if (!t || t.status !== 'completed' || t.adopted || !t.durationMs) continue;
      const p = t.predictionAtStart || {};
      list.push({ tier: t.advice.tier, durationMs: t.durationMs, endedAt: t.endedAt, predictedP50Ms: p.p50Ms, predictedP25Ms: p.p25Ms, predictedP80Ms: p.p80Ms, source: 'hooks' });
      seen.push([t.sessionId, t.startedAt]);
    }
    if (this.index) {
      this.tierCache = this.tierCache || new Map();
      for (const h of this.index.history) {
        if (seen.some(([sid, at]) => sid === h.sessionId && Math.abs(at - h.startedAt) < 10000)) continue;
        if (h.durationMs > 6 * 3600000) continue; // left open overnight: not a task duration
        const key = h.sessionId + h.startedAt;
        let tier = this.tierCache.get(key);
        if (!tier) { tier = advisor.analyze(h.prompt).tier; this.tierCache.set(key, tier); }
        list.push({ tier, durationMs: h.durationMs, endedAt: h.endedAt, source: 'transcript' });
      }
    }
    this.predictor.setHistory(list);
  }

  /** Live view of one task, with fresh prediction and usage. */
  taskView(t, { detail = false } = {}) {
    const now = this.now();
    const elapsed = (t.endedAt || now) - t.startedAt;
    const usage = this.taskUsage(t);
    const active = ACTIVE.has(t.status);
    const prediction = active ? this.predictFor(t, elapsed) : null;
    const agents = Object.values(t.agents).map(a => {
      const recs = usage.records.filter(r => r.agentId === a.id);
      const models = [...new Set(recs.map(r => r.model))];
      const meta = (this.index && this.index.agents[a.id]) || {};
      return {
        ...a, type: a.type || meta.agentType, description: a.description || meta.description || '',
        model: models[0] || a.model || null, modelName: models[0] ? displayName(models[0]) : (a.model ? displayName(a.model) : (a.modelAlias || null)),
        modelSource: models.length ? 'measured' : (a.model ? 'reported' : (a.modelAlias ? 'requested' : null)),
        requests: recs.length, costUsd: recs.reduce((x, r) => x + (r.costUsd || 0), 0),
        tokens: recs.reduce((x, r) => x + r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h, 0),
        durationMs: (a.endedAt || (a.status === 'running' ? now : a.startedAt)) - (a.startedAt || now),
      };
    });
    const mainRecs = usage.records.filter(r => !r.agentId);
    const view = {
      id: t.id, sessionId: t.sessionId, project: t.project, prompt: detail ? t.prompt : t.prompt.slice(0, 300),
      status: t.status, startedAt: t.startedAt, endedAt: t.endedAt, elapsedMs: elapsed, reason: t.reason || null,
      blockedOn: t.status === 'blocked' ? t.blockedOn : null, advice: t.advice, effort: t.effort,
      model: mainRecs.length ? mainRecs[mainRecs.length - 1].model : null,
      modelName: mainRecs.length ? displayName(mainRecs[mainRecs.length - 1].model) : null,
      toolCount: t.toolCount, toolErrors: t.toolErrors,
      runningTools: t.tools.filter(c => c.status === 'running').slice(-5),
      recentTools: t.tools.slice(-8).reverse(),
      todos: t.todos, progress: progressOf(t), agents,
      usage: usage.summary, prediction, predictionAtStart: t.predictionAtStart, adopted: !!t.adopted,
      lastMessage: detail ? t.lastMessage : t.lastMessage.slice(0, 280),
    };
    if (detail) {
      view.tools = t.tools.slice().reverse();
      view.timeline = timeline(usage.records, t.startedAt);
    }
    return view;
  }

  snapshot() {
    const now = this.now();
    const active = [], recent = [];
    for (let i = this.taskOrder.length - 1; i >= 0; i--) {
      const t = this.tasks.get(this.taskOrder[i]);
      if (!t) continue;
      if (ACTIVE.has(t.status)) {
        // stale: no event for 6h -> it was abandoned without a SessionEnd
        if (now - (t.lastActivityAt || t.startedAt) > 6 * 3600000) { this.finish(t, 'interrupted', t.lastActivityAt || t.startedAt, { reason: 'no activity for 6 hours' }); recent.push(t); continue; }
        active.push(t);
      } else if (recent.length < 25) recent.push(t);
    }
    const sessions = [...this.sessions.values()].filter(s => s.status !== 'ended' && now - s.lastEventAt < 12 * 3600000).map(s => this.sessionView(s));
    const today = startOfDay(now);
    const todayRecs = this.index ? this.index.records({ from: today }) : [];
    return {
      now, billing: this.billing(),
      active: active.map(t => this.taskView(t)),
      recent: recent.map(t => this.taskView(t)),
      sessions,
      today: summarize(todayRecs),
      notifications: this.notifications.slice(0, 30),
      unread: this.notifications.filter(n => !n.read).length,
      health: { events: this.stats.events, errors: this.stats.errors || 0, startedAt: this.stats.startedAt, usageRecords: this.index ? this.index.usage.size : 0, tasks: this.tasks.size },
    };
  }

  sessionView(s) {
    const recs = this.sessionRecords(s.id);
    const main = recs.filter(r => !r.agentId);
    const model = s.model || (main.length ? main[main.length - 1].model : null);
    const cs = this.index && this.index.costState[s.id];
    return {
      id: s.id, project: s.project, cwd: s.cwd, status: s.status, startedAt: s.startedAt, lastEventAt: s.lastEventAt,
      model, modelName: s.modelName || (model ? displayName(model) : null), effort: s.effort || null, permissionMode: s.permissionMode,
      currentTaskId: s.currentTaskId, estimate: summarize(recs),
      claudeCodeCost: s.claudeCodeCost || (cs ? { usd: cs.totalCostUSD, at: cs.at, source: 'transcript cost-state' } : null),
      contextWindow: s.contextWindow || null,
    };
  }

  /** One status line for Claude Code's statusLine command. */
  statusLine(payload) {
    const sid = payload.session_id;
    const s = sid && this.sessions.get(sid);
    const t = s && this.currentTask(s);
    const C = { dim: '\x1b[2m', r: '\x1b[0m', a: '\x1b[38;5;141m', g: '\x1b[38;5;78m', y: '\x1b[38;5;221m', red: '\x1b[38;5;203m', c: '\x1b[38;5;117m' };
    const model = (payload.model && payload.model.display_name) || (s && s.modelName) || '';
    const parts = [`${C.a}◆ CCC${C.r}`];
    if (model) parts.push(`${C.c}${model}${C.r}`);
    if (t) {
      const v = this.taskView(t);
      const icon = { running: `${C.g}●`, blocked: `${C.y}⏸`, waiting: `${C.y}?`, background: `${C.c}◐`, completed: `${C.g}✓`, failed: `${C.red}✗`, interrupted: `${C.dim}■` }[t.status] || '';
      let seg = `${icon} ${advisor.fmtDur(v.elapsedMs)}${C.r}`;
      if (v.prediction && v.prediction.remainingMs != null) seg += ` ${C.dim}~${advisor.fmtDur(Math.max(0, v.prediction.remainingMs))} left (pred.)${C.r}`;
      if (v.progress) seg += ` ${C.dim}${v.progress.completed}/${v.progress.total}${C.r}`;
      if (v.agents.some(a => a.status === 'running')) seg += ` ${C.c}${v.agents.filter(a => a.status === 'running').length} agent(s)${C.r}`;
      parts.push(seg);
      if (t.advice && t.advice.model.name !== model) parts.push(`${C.dim}tip: ${t.advice.model.name}·${t.advice.effort}${C.r}`);
    }
    const ccCost = payload.cost && payload.cost.total_cost_usd;
    const mode = this.billing().mode;
    if (ccCost != null) parts.push(`${C.dim}${mode === 'subscription' ? 'sub-equiv' : mode === 'api' ? 'API est.' : 'est.'} $${Number(ccCost).toFixed(2)}${C.r}`);
    return parts.join(`${C.dim} │ ${C.r}`);
  }
}

// ---- helpers --------------------------------------------------------------------------

function excerpt(s, n = 100) {
  const x = String(s || '').replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n - 1) + '…' : x;
}

function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }

function progressOf(t) {
  if (!t.todos || !t.todos.length) return null;
  const total = t.todos.length;
  const completed = t.todos.filter(x => x.status === 'completed').length;
  const inProgress = t.todos.find(x => x.status === 'in_progress');
  return { total, completed, current: inProgress ? inProgress.text : null, source: 'Claude todo list (measured)' };
}

function emptyAgg() { return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, costUsd: 0, unpriced: 0 }; }

function add(a, r) {
  a.requests++;
  a.input += r.input; a.output += r.output; a.cacheRead += r.cacheRead; a.cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
  a.tokens += r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
  if (r.costUsd == null) a.unpriced++; else a.costUsd += r.costUsd;
}

/** Aggregate usage records: totals, per model and per agent. */
function summarize(recs, labelFor) {
  const total = emptyAgg();
  const byModel = {}, byAgent = {};
  for (const r of recs) {
    add(total, r);
    const m = byModel[r.model] || (byModel[r.model] = { ...emptyAgg(), model: r.model, name: displayName(r.model), family: family(r.model) });
    add(m, r);
    const lab = labelFor ? labelFor(r.agentId) : { key: r.agentId || 'main', label: r.agentId ? 'subagent' : 'Main session', type: r.agentId ? 'subagent' : 'main' };
    const a = byAgent[lab.key] || (byAgent[lab.key] = { ...emptyAgg(), key: lab.key, label: lab.label, type: lab.type, models: {} });
    add(a, r);
    a.models[displayName(r.model)] = (a.models[displayName(r.model)] || 0) + 1;
  }
  return { ...total, byModel: Object.values(byModel).sort((a, b) => b.costUsd - a.costUsd), byAgent: Object.values(byAgent).sort((a, b) => b.costUsd - a.costUsd) };
}

function timeline(recs, start) {
  return recs.map(r => ({ t: r.ts - start, model: displayName(r.model), agentId: r.agentId, out: r.output, costUsd: r.costUsd }));
}

module.exports = { Engine, EventLog, summarize, slim, toolSummary, progressOf, ACTIVE, costOf, excerpt, startOfDay };
