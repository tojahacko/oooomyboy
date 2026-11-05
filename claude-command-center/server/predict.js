'use strict';
// Time prediction from MEASURED history. Outputs are always labelled as predictions,
// carry their sample size and basis, and are withheld (basis 'none') when there is not
// enough history to say anything honest.
//
// Model:
//  1. Durations of finished tasks in the same tier (prompt-intelligence tier), recency-weighted;
//     neighbouring tiers fill in when a tier has fewer than MIN_SAME samples.
//  2. Weighted quantiles of log-duration give p25 / p50 / p80.
//  3. Calibration: each finished task stores the p50 predicted when it started; the median
//     ratio actual/predicted for that tier corrects later predictions (learns over time).
//  4. While running: the remaining time is conditioned on the elapsed time (only tasks that
//     ran at least that long count), and blended with the todo-list completion rate when
//     Claude reports a todo list.
const { TIER_ORDER } = require('./advisor');

const MIN_SAMPLES = 3;
const MIN_SAME = 5;
const WINDOW = 80;
const HALF_LIFE = 25; // in tasks

function wquantile(items, q) {
  // items: [{v, w}] sorted by v
  const total = items.reduce((s, x) => s + x.w, 0);
  if (!total) return null;
  let acc = 0;
  for (const x of items) {
    acc += x.w;
    if (acc >= q * total) return x.v;
  }
  return items[items.length - 1].v;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

class Predictor {
  constructor() { this.history = []; } // { tier, durationMs, endedAt, predictedP50Ms?, source }

  setHistory(list) {
    this.history = list.filter(h => h.durationMs > 0 && isFinite(h.durationMs)).sort((a, b) => a.endedAt - b.endedAt);
  }

  add(h) { if (h.durationMs > 0) this.history.push(h); }

  sample(tier) {
    const ti = TIER_ORDER.indexOf(tier);
    const same = this.history.filter(h => h.tier === tier).slice(-WINDOW);
    let pool = same.map((h, i, a) => ({ h, w: Math.pow(0.5, (a.length - 1 - i) / HALF_LIFE) }));
    let scope = 'same tier';
    if (same.length < MIN_SAME) {
      const near = this.history.filter(h => Math.abs(TIER_ORDER.indexOf(h.tier) - ti) === 1).slice(-WINDOW);
      pool = pool.concat(near.map((h, i, a) => ({ h, w: 0.5 * Math.pow(0.5, (a.length - 1 - i) / HALF_LIFE) })));
      scope = same.length ? 'same + neighbouring tiers' : 'neighbouring tiers';
      if (pool.length < MIN_SAMPLES) {
        const all = this.history.slice(-WINDOW);
        pool = all.map((h, i, a) => ({ h, w: 0.25 * Math.pow(0.5, (a.length - 1 - i) / HALF_LIFE) }));
        scope = 'all tasks';
      }
    }
    return { pool, scope, sameCount: same.length };
  }

  /** Correction factor learned from this tier's past predictions (1 = unbiased). */
  calibration(tier) {
    const done = this.history.filter(h => h.tier === tier && h.predictedP50Ms > 0).slice(-30);
    if (done.length < 3) return { factor: 1, n: done.length };
    const logs = done.map(h => Math.log(h.durationMs / h.predictedP50Ms));
    const f = Math.exp(median(logs));
    return { factor: Math.min(2, Math.max(0.5, f)), n: done.length };
  }

  /**
   * predict({ tier, elapsedMs, todos:{total, completed} }) ->
   * { basis, n, scope, p25Ms, p50Ms, p80Ms, remainingMs, remainingLowMs, remainingHighMs, confidence, note }
   */
  predict({ tier, elapsedMs = 0, todos = null }) {
    const { pool, scope, sameCount } = this.sample(tier);
    const out = { basis: 'none', n: pool.length, scope, confidence: 'none', p25Ms: null, p50Ms: null, p80Ms: null, remainingMs: null, remainingLowMs: null, remainingHighMs: null, note: '' };
    let hist = null;
    if (pool.length >= MIN_SAMPLES) {
      const cal = this.calibration(tier);
      const items = pool.map(x => ({ v: x.h.durationMs * cal.factor, w: x.w })).sort((a, b) => a.v - b.v);
      hist = { p25: wquantile(items, 0.25), p50: wquantile(items, 0.5), p80: wquantile(items, 0.8), cal };
      out.p25Ms = hist.p25; out.p50Ms = hist.p50; out.p80Ms = hist.p80;
      out.calibrationFactor = +cal.factor.toFixed(3);
      out.calibrationN = cal.n;
      // condition on elapsed time
      const surv = items.filter(x => x.v > elapsedMs);
      if (surv.length >= MIN_SAMPLES) {
        hist.rem = { low: wquantile(surv, 0.25) - elapsedMs, mid: wquantile(surv, 0.5) - elapsedMs, high: wquantile(surv, 0.8) - elapsedMs };
      } else if (elapsedMs > 0) {
        const pct = Math.round(100 * (1 - surv.length / items.length));
        out.note = `Running longer than ${pct}% of similar tasks; history cannot bound the remaining time.`;
      }
    }

    let prog = null;
    if (todos && todos.total > 0 && todos.completed > 0 && todos.completed < todos.total && elapsedMs > 0) {
      const rate = elapsedMs / todos.completed;
      prog = { mid: rate * (todos.total - todos.completed), frac: todos.completed / todos.total };
    }

    if (hist && hist.rem && prog) {
      const w = prog.frac;
      out.basis = 'blend';
      out.remainingMs = w * prog.mid + (1 - w) * hist.rem.mid;
      out.remainingLowMs = Math.min(out.remainingMs, w * prog.mid * 0.6 + (1 - w) * hist.rem.low);
      out.remainingHighMs = Math.max(out.remainingMs, w * prog.mid * 1.6 + (1 - w) * hist.rem.high);
    } else if (hist && hist.rem) {
      out.basis = 'history';
      out.remainingMs = hist.rem.mid; out.remainingLowMs = hist.rem.low; out.remainingHighMs = hist.rem.high;
    } else if (prog) {
      out.basis = 'progress';
      out.remainingMs = prog.mid; out.remainingLowMs = prog.mid * 0.6; out.remainingHighMs = prog.mid * 1.6;
    } else if (hist && elapsedMs === 0) {
      out.basis = 'history';
      out.remainingMs = hist.p50; out.remainingLowMs = hist.p25; out.remainingHighMs = hist.p80;
    }
    if (out.basis === 'none' && !out.note) out.note = `Not enough finished tasks yet (${pool.length} of ${MIN_SAMPLES} needed).`;
    const n = pool.length;
    out.confidence = out.basis === 'none' ? 'none'
      : (sameCount >= 15 && out.basis !== 'progress') ? 'high'
      : (sameCount >= MIN_SAME || (prog && prog.frac >= 0.5)) ? 'medium' : 'low';
    out.n = n;
    return out;
  }

  /** How good have the predictions been? Uses only tasks that had a prediction at start. */
  accuracy() {
    const done = this.history.filter(h => h.predictedP50Ms > 0);
    if (!done.length) return { n: 0 };
    const err = done.map(h => Math.abs(h.durationMs - h.predictedP50Ms) / h.durationMs);
    const half = Math.floor(done.length / 2);
    const early = err.slice(0, half), late = err.slice(half);
    const within = done.filter(h => h.predictedP25Ms != null && h.durationMs >= h.predictedP25Ms && h.durationMs <= h.predictedP80Ms).length;
    return {
      n: done.length,
      medianAbsPctError: median(err),
      earlyMedianAbsPctError: early.length >= 3 ? median(early) : null,
      recentMedianAbsPctError: late.length >= 3 ? median(late) : null,
      withinRangeRate: done.length ? within / done.length : null,
    };
  }
}

module.exports = { Predictor, wquantile, median, MIN_SAMPLES };
