'use strict';
// List prices in USD per million tokens, Anthropic first-party API.
// Source: Anthropic model table (cached 2026-10-06) shipped with Claude Code 2.1.318.
// Cache writes are derived from input price: 5-minute TTL = 1.25x, 1-hour TTL = 2x.
// Cache reads are per model (not a fixed multiplier on newer models).
//
// `verified: true`  -> the row was taken from the current published model table.
// `verified: false` -> legacy model priced from older published rates; shown with a marker.
// A model that matches no row is reported as UNPRICED (cost null), never guessed.

const PRICE_TABLE_DATE = '2026-10-06';

const ROWS = [
  { re: /^claude-(fable|mythos)-5-1/, name: 'Fable 5.1', in: 10, out: 50, cr: 0.25, verified: true },
  { re: /^claude-(fable|mythos)-5(?!-\d{1,2}(?!\d))/, name: 'Fable 5', in: 10, out: 50, cr: 1, verified: true },
  { re: /^claude-opus-5-5/, name: 'Opus 5.5', in: 4, out: 20, cr: 0.2, verified: true },
  { re: /^claude-opus-5(?!-\d{1,2}(?!\d))/, name: 'Opus 5', in: 5, out: 25, cr: 0.5, verified: true },
  { re: /^claude-opus-4-[5-8]/, name: 'Opus 4.x', in: 5, out: 25, cr: 0.5, verified: true },
  { re: /^claude-opus-4(-1)?(-\d{8}|$)/, name: 'Opus 4/4.1', in: 15, out: 75, cr: 1.5, verified: false },
  { re: /^claude-sonnet-5-5/, name: 'Sonnet 5.5', in: 2, out: 10, cr: 0.2, verified: true },
  { re: /^claude-sonnet-5(?!-\d{1,2}(?!\d))/, name: 'Sonnet 5', in: 2, out: 10, cr: 0.2, verified: true },
  { re: /^claude-sonnet-4/, name: 'Sonnet 4.x', in: 3, out: 15, cr: 0.3, verified: true },
  { re: /^claude-3-[57]-sonnet/, name: 'Sonnet 3.x', in: 3, out: 15, cr: 0.3, verified: false },
  {
    re: /^claude-haiku-5-5/, name: 'Haiku 5.5', in: 0.1, out: 0.5, cr: 0.01, verified: true,
    // Prompt (input + cache read + cache write) over 100K tokens: $0.50 / $2.50.
    long: { threshold: 100000, in: 0.5, out: 2.5, cr: 0.05 },
  },
  { re: /^claude-haiku-4/, name: 'Haiku 4.5', in: 1, out: 5, cr: 0.1, verified: true },
  { re: /^claude-3-5-haiku/, name: 'Haiku 3.5', in: 0.8, out: 4, cr: 0.08, verified: false },
];

// Fast mode (usage.speed === 'fast') is billed at 2x on the models that offer it.
const FAST_MULTIPLIER = 2;

/** Normalise ids such as `us.anthropic.claude-opus-4-6-v1`, `claude-opus-4-6[1m]`. */
function normalizeModel(id) {
  if (!id || typeof id !== 'string') return '';
  return id.toLowerCase()
    .replace(/^(us|eu|apac|global)\./, '')
    .replace(/^anthropic\./, '')
    .replace(/\[.*\]$/, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/@.*$/, '')
    .trim();
}

function rowFor(model) {
  const id = normalizeModel(model);
  return ROWS.find(r => r.re.test(id)) || null;
}

/** "claude-opus-5-5" -> "Opus 5.5"; unknown ids are returned tidied. */
function displayName(model) {
  const id = normalizeModel(model);
  const m = /^claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(id)
    || /^claude-(\d)-(\d)-(sonnet|haiku|opus)/.exec(id);
  if (!m) return id.replace(/^claude-/, '') || 'unknown';
  if (/^\d$/.test(m[1])) return `${cap(m[3])} ${m[1]}.${m[2]}`;
  return `${cap(m[1])} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}

function family(model) {
  const id = normalizeModel(model);
  const m = /(fable|mythos|opus|sonnet|haiku)/.exec(id);
  return m ? m[1] : 'other';
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Estimated list-price cost of one model request.
 * usage: { input, output, cacheRead, cacheWrite5m, cacheWrite1h, speed }
 * Returns { usd: number|null, priced: boolean, verified: boolean }.
 */
function costOf(model, u) {
  const row = rowFor(model);
  if (!row) return { usd: null, priced: false, verified: false };
  const input = u.input || 0, out = u.output || 0, cr = u.cacheRead || 0;
  const w5 = u.cacheWrite5m || 0, w1 = u.cacheWrite1h || 0;
  let p = row;
  if (row.long && input + cr + w5 + w1 > row.long.threshold) p = { ...row, ...row.long };
  const mult = u.speed === 'fast' ? FAST_MULTIPLIER : 1;
  const usd = mult * (input * p.in + out * p.out + cr * p.cr + w5 * p.in * 1.25 + w1 * p.in * 2) / 1e6;
  return { usd, priced: true, verified: row.verified };
}

/** Public table for the dashboard's "how costs are calculated" panel. */
function table() {
  return ROWS.map(r => ({
    name: r.name, input: r.in, output: r.out, cacheRead: r.cr,
    cacheWrite5m: +(r.in * 1.25).toFixed(4), cacheWrite1h: r.in * 2,
    verified: r.verified, long: r.long || null,
  }));
}

module.exports = { costOf, normalizeModel, displayName, family, rowFor, table, PRICE_TABLE_DATE, FAST_MULTIPLIER };
