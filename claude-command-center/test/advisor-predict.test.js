'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const advisor = require('../server/advisor');
const { Predictor } = require('../server/predict');

test('advisor: trivial questions go to Haiku at low effort', () => {
  const a = advisor.analyze('what is the default port of postgres?');
  assert.equal(a.tier, 'trivial');
  assert.equal(a.model.alias, 'haiku');
  assert.equal(a.effort, 'low');
  assert.ok(a.heuristic);
});

test('advisor: a small rename is light, a bug fix is moderate', () => {
  assert.ok(['trivial', 'simple'].includes(advisor.analyze('rename the variable foo to bar in utils.js').tier));
  const fix = advisor.analyze('Debug why the login test is failing after the last change and fix the bug. Here is the stack trace:\n```\nTypeError: x is undefined\n    at login (auth.js:12:5)\n```');
  assert.ok(['moderate', 'complex'].includes(fix.tier), fix.tier);
});

test('advisor: a large autonomous build is at least "hard" and explains why', () => {
  const prompt = `Build a working Claude Code mod called Claude Command Center.
1. Model tracking
2. Cost tracking
3. Time prediction
4. Prompt intelligence
5. Live monitoring
6. Notifications
7. Analytics
Work autonomously through implementation, testing and debugging. Choose the most reliable architecture. Deliver a working, installable project end to end.`;
  const a = advisor.analyze(prompt);
  assert.ok(['hard', 'frontier'].includes(a.tier), a.tier);
  assert.ok(a.reasons.length >= 3);
  assert.match(advisor.chatLine(a), /Suggestion only; nothing was changed\./);
});

test('advisor: chat line mentions the current model when it differs', () => {
  const a = advisor.analyze('what is 2+2?');
  assert.match(advisor.chatLine(a, { currentModelName: 'Opus 5.5' }), /You are on Opus 5\.5/);
  assert.doesNotMatch(advisor.chatLine(a, { currentModelName: 'Haiku 5.5' }), /You are on/);
});

const mk = (tier, secs, extra = {}) => ({ tier, durationMs: secs * 1000, endedAt: Date.now(), ...extra });

test('predictor: refuses to predict without history (never fabricates)', () => {
  const p = new Predictor();
  p.setHistory([mk('moderate', 60), mk('moderate', 80)]);
  const r = p.predict({ tier: 'moderate', elapsedMs: 0 });
  assert.equal(r.basis, 'none');
  assert.equal(r.remainingMs, null);
  assert.match(r.note, /Not enough finished tasks/);
});

test('predictor: quantiles from same-tier history; remaining conditioned on elapsed time', () => {
  const p = new Predictor();
  p.setHistory([30, 40, 50, 60, 70, 80, 90, 100, 110, 120].map(s => mk('moderate', s)));
  const r0 = p.predict({ tier: 'moderate', elapsedMs: 0 });
  assert.equal(r0.basis, 'history');
  assert.ok(r0.p50Ms >= 60000 && r0.p50Ms <= 90000, String(r0.p50Ms));
  const r1 = p.predict({ tier: 'moderate', elapsedMs: 95000 });
  assert.ok(r1.remainingMs > 0 && r1.remainingMs <= 25000, String(r1.remainingMs)); // only 100-120s tasks remain
  const r2 = p.predict({ tier: 'moderate', elapsedMs: 500000 });
  assert.equal(r2.basis, 'none');
  assert.match(r2.note, /longer than/);
});

test('predictor: todo progress blends with history and works alone', () => {
  const p = new Predictor();
  const alone = p.predict({ tier: 'complex', elapsedMs: 60000, todos: { total: 4, completed: 2 } });
  assert.equal(alone.basis, 'progress');
  assert.equal(alone.remainingMs, 60000);
  p.setHistory([100, 200, 300, 400, 500, 600].map(s => mk('complex', s)));
  const blend = p.predict({ tier: 'complex', elapsedMs: 60000, todos: { total: 4, completed: 2 } });
  assert.equal(blend.basis, 'blend');
});

test('predictor: calibration learns a systematic bias and reduces error', () => {
  // History where the predictor has been under-predicting by 2x.
  const hist = [];
  for (let i = 0; i < 12; i++) hist.push(mk('hard', 100 + i, { predictedP50Ms: 50000 }));
  const p = new Predictor();
  p.setHistory(hist);
  const cal = p.calibration('hard');
  assert.ok(cal.factor > 1.8 && cal.factor <= 2, String(cal.factor));
  const acc = p.accuracy();
  assert.equal(acc.n, 12);
  assert.ok(acc.medianAbsPctError > 0.4);
});
