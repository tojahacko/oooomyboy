'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { costOf, displayName, rowFor } = require('../server/pricing');
const { TranscriptIndex } = require('../server/transcripts');
const { fixtureProjects, tmpdir } = require('./helpers');

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

test('pricing reproduces Claude Code\'s own costUSD (Opus 5.5 session totals, 1h cache writes)', () => {
  // From a real cost-state record written by Claude Code 2.1.318.
  const usd = costOf('claude-opus-5-5', { input: 2578, output: 6794, cacheRead: 2786943, cacheWrite1h: 89642 }).usd;
  assert.ok(close(usd, 1.4207165999999998), `got ${usd}`);
});

test('every fixture session: sum of per-request estimates == Claude Code cost-state', () => {
  const idx = new TranscriptIndex({ projectsDir: fixtureProjects(), cacheFile: path.join(tmpdir(), 'c.json') });
  idx.scan();
  const sessions = Object.keys(idx.costState);
  assert.ok(sessions.length >= 2, 'fixtures contain cost-state records');
  for (const sid of sessions) {
    const ours = idx.records({ sessionId: sid }).reduce((s, r) => s + r.costUsd, 0);
    const theirs = idx.costState[sid].totalCostUSD;
    assert.ok(close(ours, theirs, 1e-6), `${sid}: ours ${ours} vs Claude Code ${theirs}`);
  }
});

test('Haiku 5.5 long-prompt pricing applies per request over 100K prompt tokens', () => {
  const short = costOf('claude-haiku-5-5', { input: 50000, output: 1000 }).usd;
  const long = costOf('claude-haiku-5-5', { input: 120000, output: 1000 }).usd;
  assert.ok(close(short, (50000 * 0.1 + 1000 * 0.5) / 1e6));
  assert.ok(close(long, (120000 * 0.5 + 1000 * 2.5) / 1e6));
});

test('unknown models are unpriced, never guessed; ids normalise', () => {
  assert.deepEqual(costOf('gpt-4o', { input: 10 }), { usd: null, priced: false, verified: false });
  assert.equal(rowFor('us.anthropic.claude-opus-4-6-v1').name, 'Opus 4.x');
  assert.equal(rowFor('claude-opus-4-1-20250805').name, 'Opus 4/4.1');
  assert.equal(rowFor('claude-fable-5-1').name, 'Fable 5.1');
  assert.equal(rowFor('claude-fable-5').name, 'Fable 5');
  assert.equal(displayName('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(displayName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(costOf('claude-opus-5-5', { input: 1e6, speed: 'fast' }).usd, 8);
});

test('transcripts: de-duplicates split assistant messages and attributes subagents', () => {
  const idx = new TranscriptIndex({ projectsDir: fixtureProjects(), cacheFile: path.join(tmpdir(), 'c.json') });
  idx.scan();
  const recs = idx.records({ sessionId: '33fc458d-0f9a-4058-905e-f4cd7a16d86f' });
  const ids = recs.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, 'one record per message.id');
  const sub = recs.filter(r => r.agentId === 'adad64685c2db911d');
  assert.equal(sub.length, 2);
  assert.ok(sub.every(r => r.model === 'claude-haiku-5-5'));
  assert.equal(idx.agents.adad64685c2db911d.agentType, 'general-purpose');
  assert.equal(idx.agents.adad64685c2db911d.description, 'probe agent');
  // a rescan adds nothing
  assert.equal(idx.scan(), 0);
});

test('transcripts: incremental reads handle partial lines and appends', () => {
  const dir = tmpdir('ccc-proj');
  const f = path.join(dir, 'p', 'sess-a.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const line = (id, ts) => JSON.stringify({ type: 'assistant', sessionId: 'sess-a', timestamp: ts, message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [] } });
  const full = line('m1', '2026-11-01T10:00:00Z') + '\n' + line('m2', '2026-11-01T10:00:05Z');
  fs.writeFileSync(f, full.slice(0, -20)); // second line cut mid-way
  const idx = new TranscriptIndex({ projectsDir: dir, cacheFile: path.join(dir, 'c.json') });
  idx.scan();
  assert.equal(idx.usage.size, 1);
  fs.writeFileSync(f, full + '\n');
  idx.scan();
  assert.equal(idx.usage.size, 2);
  // cache round-trip
  idx.save();
  const again = new TranscriptIndex({ projectsDir: dir, cacheFile: path.join(dir, 'c.json') });
  again.load();
  assert.equal(again.usage.size, 2);
  assert.equal(again.scan(), 0);
});

test('transcripts: reconstructs prompt->finish history, skipping harness messages', () => {
  const idx = new TranscriptIndex({ projectsDir: fixtureProjects(), cacheFile: path.join(tmpdir(), 'c.json') });
  idx.scan();
  idx.closeIdle(0);
  const prompts = idx.history.map(h => h.prompt);
  assert.ok(prompts.some(p => p.startsWith('Use the Agent tool once')));
  assert.ok(!prompts.some(p => p.startsWith('<task-notification>')));
  assert.ok(idx.history.every(h => h.durationMs > 0));
});
