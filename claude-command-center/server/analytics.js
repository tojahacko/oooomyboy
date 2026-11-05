'use strict';
// Historical analytics over measured usage (transcripts) and tracked tasks (hooks).
const advisor = require('./advisor');
const { displayName, family, costOf } = require('./pricing');
const { summarize, ACTIVE } = require('./engine');
const { median } = require('./predict');

const DAY = 86400000;

function rangeStart(range, now) {
  const m = /^(\d+)d$/.exec(range || '');
  if (m) { const d = new Date(now - (Number(m[1]) - 1) * DAY); d.setHours(0, 0, 0, 0); return d.getTime(); }
  return 0; // all
}

const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function analytics(engine, { range = '30d', now = Date.now() } = {}) {
  const from = rangeStart(range, now);
  const recs = engine.index ? engine.index.records({ from }) : [];

  // ---- daily series (measured tokens, estimated cost) ----
  const days = new Map();
  const first = recs.length ? Math.min(...recs.map(r => r.ts)) : now;
  const startDay = from || first;
  for (let t = new Date(startDay).setHours(0, 0, 0, 0); t <= now; t += DAY) days.set(dayKey(t), { date: dayKey(t), costUsd: 0, tokens: 0, output: 0, requests: 0, byFamily: {} });
  for (const r of recs) {
    const d = days.get(dayKey(r.ts));
    if (!d) continue;
    d.requests++; d.costUsd += r.costUsd || 0; d.output += r.output;
    d.tokens += r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
    const f = family(r.model);
    d.byFamily[f] = (d.byFamily[f] || 0) + (r.costUsd || 0);
  }

  // ---- model distribution: who used which model (main session vs subagent types) ----
  const agents = engine.index ? engine.index.agents : {};
  const byAgentType = {};
  for (const r of recs) {
    const type = r.agentId ? ((agents[r.agentId] && agents[r.agentId].agentType) || agentTypeFromTasks(engine, r.agentId) || 'subagent') : 'main session';
    const a = byAgentType[type] || (byAgentType[type] = { type, requests: 0, costUsd: 0, tokens: 0, models: {} });
    a.requests++; a.costUsd += r.costUsd || 0;
    a.tokens += r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
    const mn = displayName(r.model);
    a.models[mn] = (a.models[mn] || 0) + 1;
  }

  // ---- activity heatmap (requests by weekday x hour) ----
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of recs) { const d = new Date(r.ts); heat[d.getDay()][d.getHours()]++; }

  // ---- projects ----
  const projects = {};
  for (const r of recs) {
    const p = r.project || (engine.index.sessions[r.sessionId] || {}).project || 'unknown';
    const x = projects[p] || (projects[p] = { project: p, costUsd: 0, requests: 0, sessions: new Set() });
    x.costUsd += r.costUsd || 0; x.requests++; x.sessions.add(r.sessionId);
  }

  // ---- tasks: hook-tracked + transcript-reconstructed ----
  const hookTasks = [];
  for (const id of engine.taskOrder) {
    const t = engine.tasks.get(id);
    if (t && t.startedAt >= from && !t.adopted) hookTasks.push(t);
  }
  const seen = hookTasks.map(t => [t.sessionId, t.startedAt]);
  const transcriptTasks = (engine.index ? engine.index.history : []).filter(h => h.startedAt >= from && !seen.some(([s, a]) => s === h.sessionId && Math.abs(a - h.startedAt) < 10000));

  const tiers = {};
  const tierOf = t => (t.advice ? t.advice.tier : advisor.analyze(t.prompt).tier);
  const bucket = tier => tiers[tier] || (tiers[tier] = { tier, n: 0, completed: 0, failed: 0, interrupted: 0, durations: [], costs: [] });
  for (const t of hookTasks) {
    if (ACTIVE.has(t.status)) continue;
    const b = bucket(tierOf(t));
    b.n++;
    if (t.status === 'completed') { b.completed++; b.durations.push(t.durationMs); }
    else if (t.status === 'failed') b.failed++;
    else b.interrupted++;
    const u = engine.taskUsage(t).summary;
    if (u.requests) b.costs.push(u.costUsd);
  }
  for (const h of transcriptTasks) {
    if (h.durationMs > 6 * 3600000) continue;
    const b = bucket(tierOf(h));
    b.n++; b.completed++; b.durations.push(h.durationMs);
  }
  const tierStats = advisor.TIER_ORDER.filter(t => tiers[t]).map(t => {
    const b = tiers[t];
    return { tier: t, n: b.n, completed: b.completed, failed: b.failed, interrupted: b.interrupted, successRate: b.n ? b.completed / b.n : null,
      medianDurationMs: median(b.durations), p90DurationMs: quantile(b.durations, 0.9), medianCostUsd: median(b.costs), costSamples: b.costs.length };
  });

  // ---- advisor alignment (what-if re-pricing is an ESTIMATE that assumes the same tokens) ----
  let aligned = 0, heavier = 0, lighter = 0, whatIfUsd = 0, actualUsd = 0, compared = 0;
  const rank = { haiku: 0, sonnet: 1, opus: 2, fable: 3, mythos: 3 };
  for (const t of hookTasks) {
    if (ACTIVE.has(t.status)) continue;
    const { records } = engine.taskUsage(t);
    const main = records.filter(r => !r.agentId);
    if (!main.length) continue;
    const used = family(main[main.length - 1].model);
    const rec = family(t.advice.model.id);
    compared++;
    if (rank[used] === rank[rec]) aligned++; else if (rank[used] > rank[rec]) heavier++; else lighter++;
    for (const r of main) {
      actualUsd += r.costUsd || 0;
      const w = costOf(t.advice.model.id, r);
      whatIfUsd += w.usd || 0;
    }
  }

  const billing = engine.billing();
  return {
    range, from, now, billing,
    totals: summarize(recs),
    days: [...days.values()],
    byAgentType: Object.values(byAgentType).sort((a, b) => b.requests - a.requests),
    heat,
    projects: Object.values(projects).map(p => ({ ...p, sessions: p.sessions.size })).sort((a, b) => b.costUsd - a.costUsd).slice(0, 12),
    tasks: {
      tracked: hookTasks.length, reconstructed: transcriptTasks.length,
      completed: hookTasks.filter(t => t.status === 'completed').length,
      failed: hookTasks.filter(t => t.status === 'failed').length,
      interrupted: hookTasks.filter(t => t.status === 'interrupted').length,
      toolErrors: hookTasks.reduce((s, t) => s + t.toolErrors, 0) + (engine.index ? engine.index.toolErrors.filter(e => e.ts >= from).length : 0),
      tierStats,
    },
    prediction: engine.predictor.accuracy(),
    advisor: { compared, aligned, heavier, lighter, actualMainUsd: actualUsd, whatIfRecommendedUsd: whatIfUsd },
    claudeCodeReported: claudeCodeReported(engine, from),
  };
}

function agentTypeFromTasks(engine, agentId) {
  for (const t of engine.tasks.values()) if (t.agents[agentId]) return t.agents[agentId].type;
  return null;
}

function quantile(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/** Sum of Claude Code's own per-session cost records (latest snapshot per session). */
function claudeCodeReported(engine, from) {
  let usd = 0, sessions = 0;
  const cs = engine.index ? engine.index.costState : {};
  for (const [sid, c] of Object.entries(cs)) {
    const live = engine.sessions.get(sid);
    const val = live && live.claudeCodeCost && live.claudeCodeCost.usd != null ? live.claudeCodeCost.usd : c.totalCostUSD;
    if ((c.at || 0) < from || val == null) continue;
    usd += val; sessions++;
  }
  for (const s of engine.sessions.values()) {
    if (cs[s.id] || !s.claudeCodeCost || s.claudeCodeCost.usd == null || s.lastEventAt < from) continue;
    usd += s.claudeCodeCost.usd; sessions++;
  }
  return { usd, sessions, note: 'Latest cost Claude Code itself recorded per session (cost-state / status line). Snapshots can lag the newest messages.' };
}

/** Model tracking table: every model, how often, by whom. */
function models(engine, { range = '30d', now = Date.now() } = {}) {
  const from = rangeStart(range, now);
  const recs = engine.index ? engine.index.records({ from }) : [];
  const agents = engine.index ? engine.index.agents : {};
  const map = {};
  for (const r of recs) {
    const m = map[r.model] || (map[r.model] = { model: r.model, name: displayName(r.model), family: family(r.model), requests: 0, mainRequests: 0, subagentRequests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: 0, firstUsed: r.ts, lastUsed: r.ts, sessions: new Set(), agentTypes: {} });
    m.requests++;
    if (r.agentId) {
      m.subagentRequests++;
      const type = (agents[r.agentId] && agents[r.agentId].agentType) || agentTypeFromTasks(engine, r.agentId) || 'subagent';
      m.agentTypes[type] = (m.agentTypes[type] || 0) + 1;
    } else m.mainRequests++;
    m.input += r.input; m.output += r.output; m.cacheRead += r.cacheRead; m.cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
    if (r.costUsd == null) m.unpriced++; else m.costUsd += r.costUsd;
    m.firstUsed = Math.min(m.firstUsed, r.ts); m.lastUsed = Math.max(m.lastUsed, r.ts);
    m.sessions.add(r.sessionId);
  }
  const list = Object.values(map).map(m => ({ ...m, sessions: m.sessions.size })).sort((a, b) => b.requests - a.requests);
  const total = list.reduce((s, m) => s + m.requests, 0);
  for (const m of list) m.share = total ? m.requests / total : 0;
  return { range, total, models: list };
}

module.exports = { analytics, models, rangeStart, dayKey };
