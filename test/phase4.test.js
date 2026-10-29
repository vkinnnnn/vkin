'use strict';
// Phase 4: gated deep route (defined triggers only), benchmark-based model selection, per-stage
// latency summaries. All deterministic; no provider calls.
const test = require('node:test');
const assert = require('node:assert');
const { createRouter } = require('../src/main/router');
const { summarize: summarizeRuns, choose } = require('../scripts/select-model');
const { summarize: summarizeTelemetry, createTelemetry } = require('../src/main/telemetry');

const registry = { modelFor: (r) => ({ default: 'fast', deep: 'strong', personal: 'fast' }[r] || null) };
const simple = { question_type: 'technical', expected_answer_shape: 'explain', kind: 'technical', literal_question: 'What is RAG?', stakes: 'normal', needs_personal_evidence: false, complexity: { constraints: 0, needsCalc: false } };

test('deep route: an explicit request is a defined trigger, but every gate still applies', () => {
  const off = createRouter({ config: { llm: { enableDeepRoute: false }, answer: {} }, registry });
  const r0 = off.route(simple, { requestDeep: true });
  assert.equal(r0.route, 'default');
  assert.match(r0.reason, /deep requested; deep disabled/);
  assert.equal(r0.addUncertainty, false, 'a declined request does not add an uncertainty clause');

  const on = createRouter({ config: { llm: { enableDeepRoute: true, deepMaxShare: 1, deepMinRemainingUsd: 5 }, answer: {} }, registry });
  assert.equal(on.route(simple, {}).route, 'default', 'no request, low complexity: default');
  assert.equal(on.route(simple, { requestDeep: true, remainingUsableUsd: 20 }).route, 'deep');
  const floor = on.route(simple, { requestDeep: true, remainingUsableUsd: 3 });
  assert.equal(floor.route, 'default');
  assert.match(floor.reason, /deep budget floor/);
});

// Decision 2026-10-29: "Deeper answer" (explicit request) always uses the deep model when enabled and
// above the budget floor; the share cap only limits automatic complexity escalation.
const complex = { ...simple, stakes: 'high', literal_question: 'Walk me through the math step by step', complexity: { constraints: 3, needsCalc: true } };

test('deep route: the share cap limits automatic escalation, not an explicit request', () => {
  const r = createRouter({ config: { llm: { enableDeepRoute: true, deepMaxShare: 0.25, deepMinRemainingUsd: 0 }, answer: {} }, registry });
  // automatic: (0+1)/(0+1) = 1 > 0.25 -> capped
  const auto = r.route(complex, {});
  assert.equal(auto.route, 'default');
  assert.match(auto.reason, /deep share cap/);
  // explicit request on the very first call still goes deep
  assert.equal(r.route(simple, { requestDeep: true }).route, 'deep');
  for (let i = 0; i < 4; i += 1) r.recordCall({ route: 'default' });
  assert.equal(r.route(complex, {}).route, 'deep', 'automatic: (0+1)/(4+1) = 0.2 <= 0.25');
});

test('deep route: an explicit request still respects disabled route and budget floor', () => {
  const off = createRouter({ config: { llm: { enableDeepRoute: false, deepMaxShare: 0.05 }, answer: {} }, registry });
  assert.equal(off.route(simple, { requestDeep: true }).route, 'default');
  const on = createRouter({ config: { llm: { enableDeepRoute: true, deepMaxShare: 0.05, deepMinRemainingUsd: 5 }, answer: {} }, registry });
  const floor = on.route(simple, { requestDeep: true, remainingUsableUsd: 2 });
  assert.equal(floor.route, 'default');
  assert.match(floor.reason, /deep budget floor/);
});

const row = (model, id, o = {}) => ({ model, id, grounded: true, mustNotSay: [], words: 120, usd: 0.001, ttftMs: 600, ...o });

test('model selection: fastest model that keeps grounding and has no violations wins', () => {
  const results = [
    ...[1, 2, 3, 4, 5].map((i) => row('strong', `q${i}`, { ttftMs: 1700, usd: 0.006 })),
    ...[1, 2, 3, 4, 5].map((i) => row('fast', `q${i}`, { ttftMs: 500 })),
    ...[1, 2, 3, 4, 5].map((i) => row('fastest-but-wrong', `q${i}`, { ttftMs: 300, grounded: i > 2 })),
    ...[1, 2, 3, 4, 5].map((i) => row('empty', `q${i}`, { ttftMs: 200, words: i > 1 ? 0 : 50 })),
  ];
  const { winner, rejected } = choose(summarizeRuns(results), 'strong');
  assert.equal(winner, 'fast');
  assert.ok(rejected.find((r) => r.model === 'fastest-but-wrong').reasons.some((x) => /grounded 60%/.test(x)));
  assert.ok(rejected.find((r) => r.model === 'empty').reasons.some((x) => /empty answers/.test(x)), 'empty answers never count as grounded');
});

test('model selection: grounding regression against the current default disqualifies', () => {
  const results = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => row('strong', `q${i}`, { ttftMs: 1500 })),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => row('fast', `q${i}`, { ttftMs: 400, grounded: i !== 1 })),
  ];
  const { winner, rejected } = choose(summarizeRuns(results), 'strong');
  assert.equal(winner, 'strong');
  assert.ok(rejected[0].reasons.includes('grounding below the current default'));
});

test('model selection: violations and too few items are rejected', () => {
  const results = [
    ...[1, 2, 3, 4].map((i) => row('a', `q${i}`, { mustNotSay: i === 2 ? ['co-authored'] : [] })),
    ...[1, 2, 3].map((i) => row('b', `q${i}`)),
  ];
  const { winner, rejected } = choose(summarizeRuns(results), 'x');
  assert.equal(winner, null);
  assert.equal(rejected.length, 2);
});

test('telemetry: per-stage latency fields are recorded (no text) and summarized', () => {
  const t = createTelemetry({ dir: null, enabled: false });
  for (const [b, d, p] of [[20, 60, 500], [30, 80, 700], [10, 40, 900]]) {
    t.record({ turn: 'x', buildMs: b, eotToDispatchMs: d, providerTtftMs: p, eotToFirstTokenMs: d + p, streamMs: 1000, validateMs: 2, prepHit: b === 10, question: 'secret text' });
  }
  const rows = t.rows();
  assert.equal(rows[0].question, undefined, 'question text is never recorded');
  const s = summarizeTelemetry(rows);
  assert.equal(s.stages.build.p50, 20);
  assert.equal(s.stages.eotToDispatch.p95, 80);
  assert.equal(s.stages.providerTtft.p50, 700);
  assert.equal(s.prepHits, 1);
});
