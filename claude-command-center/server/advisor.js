'use strict';
// Prompt intelligence: a transparent, deterministic heuristic that reads a prompt and
// recommends a Claude model + effort level, with the reasons that drove the decision.
// It never changes anything itself: Claude Code keeps the model you chose.
//
// The recommendation is a heuristic, labelled as such everywhere it is shown. Historical
// outcomes of earlier tasks in the same tier (measured) are attached by the engine.

const MODELS = {
  haiku: { id: 'claude-haiku-5-5', name: 'Haiku 5.5', alias: 'haiku', price: '$0.10 / $0.50 per MTok' },
  sonnet: { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', alias: 'sonnet', price: '$2 / $10 per MTok' },
  opus: { id: 'claude-opus-5-5', name: 'Opus 5.5', alias: 'opus', price: '$4 / $20 per MTok' },
  fable: { id: 'claude-fable-5-1', name: 'Fable 5.1', alias: 'fable', price: '$10 / $50 per MTok' },
};

const TIERS = [
  // max score (inclusive) -> tier
  { max: 0, tier: 'trivial', model: 'haiku', effort: 'low', why: 'a quick lookup, answer or mechanical edit; the fastest, cheapest model handles it well' },
  { max: 2, tier: 'simple', model: 'sonnet', effort: 'low', why: 'a small, well-specified change; Sonnet is fast and accurate at this size' },
  { max: 4, tier: 'moderate', model: 'sonnet', effort: 'medium', why: 'routine feature or bug work; Sonnet 5.5 at medium effort is the cost-effective default for agentic coding' },
  { max: 6, tier: 'complex', model: 'opus', effort: 'high', why: 'multi-step work where reasoning quality matters; Opus 5.5 at high effort' },
  { max: 9, tier: 'hard', model: 'opus', effort: 'xhigh', why: 'deep, long-horizon engineering; Opus 5.5 at xhigh effort is built for long agentic runs' },
  { max: Infinity, tier: 'frontier', model: 'fable', effort: 'high', why: 'very large or open-ended autonomous work where the most capable model pays for itself (Opus 5.5 at max effort is the cheaper alternative)' },
];

const TIER_ORDER = TIERS.map(t => t.tier);

// [pattern, weight, reason]
const SIGNALS = [
  [/\b(architect(ure)?|system design|design (a|the) (system|architecture))\b/i, 2, 'architecture / system design'],
  [/\b(from scratch|end[- ]to[- ]end|full[- ]stack|production[- ]ready|installable)\b/i, 2, 'builds something complete end to end'],
  [/\bbuild (a|an|the) [\w\s-]{0,40}(app|application|system|platform|dashboard|service|mod|plugin|tool|backend|engine|game)\b/i, 2, 'builds a new application or system'],
  [/\b(security|vulnerab\w*|exploit|threat model|pentest|cve)\b/i, 2, 'security-sensitive analysis'],
  [/\b(race condition|deadlock|concurren\w*|distributed|consensus|memory leak|heisenbug)\b/i, 2, 'concurrency or distributed-systems reasoning'],
  [/\b(migrat\w+|refactor\w*|rewrite|re-architect|port (it|this|the))\b/i, 1, 'migration or refactor'],
  [/\b(prove|proof|formal|algorithm\w*|complexity analysis|optimi[sz]e (the )?performance)\b/i, 1, 'algorithmic or analytical depth'],
  [/\b(implement\w*|integrat\w+|feature|endpoint|api|database|schema|test suite|unit tests?)\b/i, 1, 'implementation work'],
  [/\b(debug\w*|stack ?trace|traceback|exception|failing|crash\w*|regression|root cause|bug)\b/i, 1, 'debugging'],
  [/\b(entire|whole|every|all) (code ?base|repo(sitory)?|files?|modules?|services?)\b/i, 1, 'repository-wide scope'],
  [/\b(autonomous(ly)?|phases?|don'?t stop|without (asking|stopping)|keep going|iterate until)\b/i, 1, 'long autonomous run'],
  [/\b(research|investigate|compare|evaluate|trade-?offs?)\b/i, 1, 'research or evaluation'],
  [/\b(rename|typo|spelling|reformat|format (this|the)|lint|bump (the )?version|one[- ]liner|add a comment|docstring)\b/i, -2, 'small mechanical edit'],
  [/^(what|who|when|where|which|is|are|does|do|can|how much|how many)\b[^.!\n]{0,120}\?\s*$/i, -2, 'a short factual question'],
  [/\b(explain|summari[sz]e|translate|list|show me|tell me)\b/i, -1, 'explanation or summary'],
];

function wordsOf(text) { return (text.match(/\S+/g) || []).length; }

/**
 * analyze(prompt) -> { tier, score, model:{id,name,alias,price}, effort, reasons[], summary, confidence, heuristic:true }
 */
function analyze(prompt) {
  const text = String(prompt || '');
  const reasons = [];
  let score = 1; // a typical coding request starts as "simple"
  const words = wordsOf(text);
  if (words < 12) { score -= 1; reasons.push({ w: -1, why: `short prompt (${words} words)` }); }
  else if (words > 400) { score += 2; reasons.push({ w: 2, why: `long, detailed specification (${words} words)` }); }
  else if (words > 150) { score += 1; reasons.push({ w: 1, why: `detailed request (${words} words)` }); }

  const listItems = (text.match(/^\s*(\d+[.)]|[-*•])\s+\S/gm) || []).length;
  if (listItems >= 6) { score += 2; reasons.push({ w: 2, why: `${listItems} separate requirements` }); }
  else if (listItems >= 3) { score += 1; reasons.push({ w: 1, why: `${listItems} separate requirements` }); }

  if (/```|^\s{4}\S|\bat [\w.$]+\(.*:\d+\)|Traceback \(most recent/m.test(text)) {
    score += 1; reasons.push({ w: 1, why: 'includes code or a stack trace' });
  }

  for (const [re, w, why] of SIGNALS) {
    if (re.test(text)) { score += w; reasons.push({ w, why }); }
  }

  const t = TIERS.find(x => score <= x.max);
  const model = MODELS[t.model];
  const signalCount = reasons.length;
  const confidence = signalCount >= 4 ? 'high' : signalCount >= 2 ? 'medium' : 'low';
  return {
    heuristic: true,
    tier: t.tier,
    tierIndex: TIER_ORDER.indexOf(t.tier),
    score,
    model,
    effort: t.effort,
    reasons: reasons.sort((a, b) => Math.abs(b.w) - Math.abs(a.w)),
    why: t.why,
    confidence,
    summary: `${model.name} · effort ${t.effort} — ${t.why}.`,
  };
}

/** The one-line message shown under the prompt in Claude Code (systemMessage; not sent to the model). */
function chatLine(advice, ctx = {}) {
  const top = advice.reasons.filter(r => r.w > 0).slice(0, 3).map(r => r.why);
  const because = top.length ? top.join(', ') : (advice.reasons[0] ? advice.reasons[0].why : 'no strong signals');
  let line = `◆ Command Center suggests ${advice.model.name} · effort ${advice.effort} (${advice.tier}): ${because}.`;
  if (ctx.currentModelName && ctx.currentModelName !== advice.model.name) line += ` You are on ${ctx.currentModelName}.`;
  if (ctx.history && ctx.history.n >= 3) {
    const similar = ctx.history.scope === 'same tier';
    line += similar
      ? ` Similar tasks took ~${fmtDur(ctx.history.p50Ms)} (median of ${ctx.history.n}).`
      : ` Your tasks typically take ~${fmtDur(ctx.history.p50Ms)} (median of ${ctx.history.n}, ${ctx.history.scope || 'all tasks'}).`;
  }
  line += ' Suggestion only; nothing was changed.';
  return line;
}

function fmtDur(ms) {
  if (ms == null || !isFinite(ms)) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

module.exports = { analyze, chatLine, fmtDur, MODELS, TIERS, TIER_ORDER };
