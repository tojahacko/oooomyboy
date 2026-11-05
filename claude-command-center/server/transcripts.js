'use strict';
// Reads Claude Code's own session transcripts (~/.claude/projects/**.jsonl) incrementally.
// This is the MEASURED source for model usage and tokens: every assistant message carries
// `message.model` and `message.usage` exactly as the API returned them.
//
// Format facts verified on Claude Code 2.1.318:
//  * one assistant message is written once per content block, every copy carrying the same
//    message.id and the same usage -> records are de-duplicated by message.id;
//  * subagent transcripts live in <project>/<session>/subagents/agent-<id>.jsonl with
//    `agentId` on every line and an `agent-<id>.meta.json` next to them (agentType, description);
//  * `cost-state` lines hold Claude Code's own computed cost for the session.
const fs = require('fs');
const path = require('path');
const { costOf } = require('./pricing');

const CACHE_VERSION = 3;
const MAX_PROMPT_CHARS = 400;

class TranscriptIndex {
  constructor({ projectsDir, cacheFile, log = () => {} }) {
    this.projectsDir = projectsDir;
    this.cacheFile = cacheFile;
    this.log = log;
    this.files = {};          // path -> { size, offset, sessionId, agentId, open, lastTs }
    this.usage = new Map();   // message.id -> usage record
    this.costState = {};      // sessionId -> Claude Code reported cost
    this.agents = {};         // agentId -> { agentType, description, sessionId, modelAlias }
    this.history = [];        // reconstructed prompt->finish tasks from transcripts
    this.toolErrors = [];     // { ts, sessionId, agentId } from tool_result.is_error
    this.sessions = {};       // sessionId -> { cwd, project, gitBranch, version, entrypoint, firstTs, lastTs }
    this.dirty = false;
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  load() {
    try {
      const c = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (c.version !== CACHE_VERSION) return;
      this.files = c.files || {};
      for (const r of c.usage || []) this.usage.set(r.id, r);
      this.costState = c.costState || {};
      this.agents = c.agents || {};
      this.history = c.history || [];
      this.toolErrors = c.toolErrors || [];
      this.sessions = c.sessions || {};
    } catch { /* first run or corrupt cache: full scan */ }
  }

  save() {
    if (!this.dirty) return;
    const data = {
      version: CACHE_VERSION, savedAt: Date.now(), files: this.files, usage: [...this.usage.values()],
      costState: this.costState, agents: this.agents, history: this.history.slice(-20000),
      toolErrors: this.toolErrors.slice(-20000), sessions: this.sessions,
    };
    const tmp = this.cacheFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.cacheFile);
    this.dirty = false;
  }

  /** Walk the projects dir and ingest anything new. Returns number of new usage records. */
  scan() {
    const before = this.usage.size;
    const found = [];
    walk(this.projectsDir, found, 0);
    let changed = false;
    for (const f of found) changed = this.ingestFile(f) || changed;
    if (changed) { this.dirty = true; this.emit(); }
    return this.usage.size - before;
  }

  /** Ingest one file (used for fast polling of the transcripts of live sessions). */
  ingestFile(file) {
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    if (file.endsWith('.meta.json')) return this.ingestMeta(file, st);
    if (!file.endsWith('.jsonl')) return false;
    let rec = this.files[file];
    if (rec && st.size < rec.offset) rec = null; // truncated / rewritten
    if (rec && st.size === rec.offset) return false;
    if (!rec) rec = this.files[file] = { offset: 0, ...identify(file) };
    const fd = fs.openSync(file, 'r');
    try {
      const len = st.size - rec.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, rec.offset);
      const lastNl = buf.lastIndexOf(10);
      if (lastNl < 0) return false; // only a partial line so far
      const text = buf.subarray(0, lastNl).toString('utf8');
      rec.offset += lastNl + 1;
      rec.size = st.size;
      for (const line of text.split('\n')) this.ingestLine(line, rec);
      this.dirty = true;
      return true;
    } finally { fs.closeSync(fd); }
  }

  ingestMeta(file, st) {
    const key = file;
    if (this.files[key] && this.files[key].size === st.size) return false;
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      const agentId = (/agent-([^.]+)\.meta\.json$/.exec(file) || [])[1];
      const sessionId = path.basename(path.dirname(path.dirname(file)));
      if (agentId) this.agents[agentId] = { ...(this.agents[agentId] || {}), agentType: m.agentType, description: m.description, modelAlias: m.model, sessionId };
      this.files[key] = { size: st.size, offset: st.size };
      return true;
    } catch { return false; }
  }

  ingestLine(line, rec) {
    if (!line || line.length < 10) return;
    // Cheap prefilter: only parse the line types we use.
    const isAssistant = /"type":\s?"assistant"/.test(line);
    const isUser = !isAssistant && /"type":\s?"user"/.test(line);
    const isCost = !isAssistant && !isUser && /"type":\s?"cost-state"/.test(line);
    if (!isAssistant && !isUser && !isCost) {
      const ts = /"timestamp":\s?"([^"]+)"/.exec(line);
      if (ts) rec.lastTs = Date.parse(ts[1]) || rec.lastTs;
      return;
    }
    let d;
    try { d = JSON.parse(line); } catch { return; }
    if (d.type !== (isAssistant ? 'assistant' : isUser ? 'user' : 'cost-state')) return;
    const ts = d.timestamp ? Date.parse(d.timestamp) : rec.lastTs;
    const sessionId = d.sessionId || rec.sessionId;
    const agentId = d.agentId || rec.agentId || null;
    if (sessionId && !agentId) this.touchSession(sessionId, d, ts);

    if (isCost) {
      this.costState[sessionId] = {
        totalCostUSD: d.totalCostUSD, modelUsage: d.modelUsage || {}, totalDuration: d.totalDuration,
        totalAPIDuration: d.totalAPIDuration, startTime: d.startTime, at: rec.lastTs || Date.now(),
      };
      return;
    }

    if (isAssistant) {
      const m = d.message || {};
      if (!m.id || !m.usage || !m.model || m.model === '<synthetic>') { rec.lastTs = ts; return; }
      const u = m.usage;
      const cc = u.cache_creation || {};
      let w5 = cc.ephemeral_5m_input_tokens, w1 = cc.ephemeral_1h_input_tokens;
      if (w5 == null && w1 == null) { w5 = u.cache_creation_input_tokens || 0; w1 = 0; } // older transcripts: assume 5m
      const prev = this.usage.get(m.id);
      const toolIds = new Set(prev ? prev.toolIds : []);
      for (const c of m.content || []) if (c && c.type === 'tool_use' && c.id) toolIds.add(c.id);
      const usage = {
        input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0,
        cacheWrite5m: w5 || 0, cacheWrite1h: w1 || 0, speed: u.speed || null,
      };
      const cost = costOf(m.model, usage);
      this.usage.set(m.id, {
        id: m.id, ts: prev ? prev.ts : ts, sessionId, agentId, model: m.model, ...usage,
        thinking: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
        costUsd: cost.usd, priced: cost.priced, toolIds: [...toolIds],
        project: (this.sessions[sessionId] || {}).project || projectOf(d.cwd),
      });
      rec.lastTs = ts;
      return;
    }

    // user lines: prompts (task boundaries for reconstructed history) and tool errors
    const content = d.message && d.message.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c && c.type === 'tool_result' && c.is_error) this.toolErrors.push({ ts, sessionId, agentId });
      }
    }
    if (!agentId && !d.isSidechain && !d.isMeta && !d.toolUseResult) {
      const text = promptText(content);
      if (text) {
        this.closeOpen(rec);
        rec.open = { sessionId, startedAt: ts, prompt: text.slice(0, MAX_PROMPT_CHARS), promptLen: text.length };
      }
    }
    rec.lastTs = ts;
  }

  touchSession(sessionId, d, ts) {
    const s = this.sessions[sessionId] || (this.sessions[sessionId] = { firstTs: ts });
    if (d.cwd) { s.cwd = d.cwd; s.project = projectOf(d.cwd); }
    if (d.gitBranch) s.gitBranch = d.gitBranch;
    if (d.version) s.version = d.version;
    if (d.entrypoint) s.entrypoint = d.entrypoint;
    if (ts && (!s.lastTs || ts > s.lastTs)) s.lastTs = ts;
  }

  /** Close the transcript's open prompt as a reconstructed history task. */
  closeOpen(rec) {
    const o = rec.open;
    if (!o) return;
    rec.open = null;
    const end = rec.lastTs;
    if (!end || !o.startedAt || end <= o.startedAt) return;
    this.history.push({ ...o, endedAt: end, durationMs: end - o.startedAt, source: 'transcript' });
  }

  /** Finalise prompts whose transcripts have been quiet for `idleMs` (they are finished). */
  closeIdle(idleMs = 10 * 60 * 1000, now = Date.now()) {
    let n = 0;
    for (const rec of Object.values(this.files)) {
      if (rec.open && rec.lastTs && now - rec.lastTs > idleMs) { this.closeOpen(rec); n++; }
    }
    if (n) this.dirty = true;
    return n;
  }

  emit() { for (const fn of this.listeners) { try { fn(); } catch { /* listener errors are not ours */ } } }

  /** Usage records, optionally filtered. */
  records({ sessionId, from, to } = {}) {
    const out = [];
    for (const r of this.usage.values()) {
      if (sessionId && r.sessionId !== sessionId) continue;
      if (from != null && r.ts < from) continue;
      if (to != null && r.ts > to) continue;
      out.push(r);
    }
    return out;
  }
}

function walk(dir, out, depth) {
  if (depth > 5) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.name.endsWith('.jsonl') || e.name.endsWith('.meta.json')) out.push(p);
  }
}

/** sessionId / agentId from a transcript path. */
function identify(file) {
  const base = path.basename(file, '.jsonl');
  const agent = /^agent-(.+)$/.exec(base);
  if (agent && path.basename(path.dirname(file)) === 'subagents') {
    return { agentId: agent[1], sessionId: path.basename(path.dirname(path.dirname(file))) };
  }
  return { sessionId: base, agentId: null };
}

function projectOf(cwd) {
  if (!cwd) return null;
  return cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
}

/** The text of a real human prompt, or '' for tool results, commands and harness messages. */
function promptText(content) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some(c => c && c.type === 'tool_result')) return '';
    text = content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
  }
  text = text.trim();
  if (!text) return '';
  if (/^<(command-|local-command|task-notification|system-reminder|bash-|user-memory|teammate)/.test(text)) return '';
  if (text.startsWith('[Request interrupted')) return '';
  if (text.startsWith('Caveat: The messages below')) return '';
  return text;
}

module.exports = { TranscriptIndex, promptText, identify, projectOf };
