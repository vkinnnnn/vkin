'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { understand, inferCompetencies } = require('../src/main/understand');
const { createRouter } = require('../src/main/router');
const { createRegistry } = require('../src/main/providers/registry');

const cases = [
  ['Tell me about yourself.', 'biographical', 'direct'],
  ['Tell me about a conflict you had with a teammate.', 'behavioral', 'star'],
  ['Give me an example of working under a tight deadline.', 'behavioral', 'star'],
  ['Why this role?', 'biographical', 'direct'],
  ['What would you do if a stakeholder kept changing requirements?', 'strategic', 'recommend'],
  ['How does this system work?', 'technical', 'explain'],
  ['What is the difference between RAG and fine-tuning?', 'technical', 'compare'],
  ['When did you work at Fabrikam?', 'factual', 'direct'],
  ['What are your biggest strengths?', 'biographical', 'direct'],
  ['Sorry, what do you mean by grounding?', 'clarification', 'clarify'],
  ['Hi, nice to meet you!', 'casual', 'direct'],
  ['What do you think about LLM agents in production?', 'opinion', 'direct'],
];

for (const [q, type, shape] of cases) {
  test(`understand: "${q}" -> ${type}/${shape}`, () => {
    const m = understand(q);
    assert.equal(m.question_type, type);
    assert.equal(m.expected_answer_shape, shape);
  });
}

test('situational questions never ask for a STAR story; behavioral ones carry competencies', () => {
  assert.notEqual(understand('What would you do in your first 90 days?').expected_answer_shape, 'star');
  const m = understand('Tell me about a time you had a conflict with a teammate and how you resolved it');
  assert.equal(m.expected_answer_shape, 'star');
  assert.ok(m.competencies_being_tested.includes('conflict'));
  assert.ok(m.competencies_being_tested.includes('teamwork'));
  assert.equal(m.time_horizon, 'past');
});

test('stakes, entities, ambiguity and personal-evidence flags', () => {
  assert.equal(understand('What salary range are you expecting?').stakes, 'high');
  const e = understand('So how did Contoso use your dashboard?', { knownEntities: ['Contoso', 'LangGraph'] });
  assert.ok(e.entities.includes('Contoso'));
  assert.ok(understand('and that?').ambiguities.includes('fragment'));
  assert.equal(understand('How does a B-tree index work?').needs_personal_evidence, false);
  assert.equal(understand('How did you deploy your loan pipeline?').needs_personal_evidence, true);
  assert.equal(understand('and that?', { live: true }).needs_clarification, false, 'live mode answers narrowly instead');
});

test('inferCompetencies', () => {
  assert.deepEqual(inferCompetencies('a stakeholder who was non-technical'), ['stakeholder']);
});

const config = { llm: { routes: { default: 'Qwen/Qwen3-235B-A22B-Instruct-2507', deep: 'nvidia/Nemotron-3-Ultra-550b-a55b', personal: '' }, enableDeepRoute: false, deepComplexityThreshold: 0.6, deepMaxShare: 0.05 }, answer: { length: 'short' } };

test('router: default route, shape-based output caps, deep disabled by default with an uncertainty flag', () => {
  const r = createRouter({ config, registry: createRegistry(config, {}) });
  const star = r.route(understand('Tell me about a time you failed'));
  assert.equal(star.route, 'default');
  assert.equal(star.maxOutputTokens, 500);
  assert.ok(r.route(understand('Hi there')).maxOutputTokens <= 60);
  const hard = understand('Estimate how many requests per second we can serve given 3 GPUs, assuming 40% utilization, and also what would you change while keeping cost flat?');
  const d = r.route(hard, { previousFailure: true });
  assert.equal(d.route, 'default');
  assert.equal(d.addUncertainty, true);
  assert.match(d.reason, /deep disabled/);
});

test('router: deep only above threshold, never for length alone, capped at 5% share', () => {
  const cfg = { ...config, llm: { ...config.llm, enableDeepRoute: true } };
  const r = createRouter({ config: cfg, registry: createRegistry(cfg, {}) });
  const long = understand(`Tell me about yourself ${'and your background in data '.repeat(20)}`);
  assert.equal(r.route(long).route, 'default', 'length is not complexity');
  const hard = understand('Estimate the cost per request given 2 models, assuming 30% cache hits, while keeping p95 under a second, and also compare it?');
  assert.equal(r.route(hard, { previousFailure: true, remainingUsableUsd: 20 }).route, 'default', 'first call would be 100% deep');
  for (let i = 0; i < 19; i++) r.recordCall({ route: 'default' });
  const first = r.route(hard, { previousFailure: true, remainingUsableUsd: 20 });
  assert.equal(first.route, 'deep', '1 of 20 = 5%');
  r.recordCall(first);
  assert.equal(r.route(hard, { previousFailure: true, remainingUsableUsd: 20 }).route, 'default', '2 of 21 > 5%');
  for (let i = 0; i < 40; i++) r.recordCall({ route: 'default' });
  assert.equal(r.route(hard, { previousFailure: true, remainingUsableUsd: 1 }).route, 'default', 'budget floor');
});

test('router: empty PERSONAL model routes to DEFAULT', () => {
  const r = createRouter({ config, registry: createRegistry(config, {}) });
  assert.equal(r.route(understand('Tell me about yourself')).route, 'default');
  const withPersonal = createRouter({ config, registry: createRegistry(config, { NEBIUS_PERSONAL_MODEL: 'Qwen/Qwen3-30B-A3B-Instruct-2507' }) });
  assert.equal(withPersonal.route(understand('Tell me about yourself')).route, 'personal');
});

test('[M2] hypotheticals are never STAR unless an explicit past cue is present', () => {
  for (const q of ['Imagine a situation where a teammate misses a deadline. How would you handle it?', 'How would you handle a situation where you disagree with your manager?', 'Suppose there is a situation where the data is wrong.', 'Give me an example of how you would handle conflict.']) {
    assert.equal(understand(q).expected_answer_shape, 'recommend', q);
  }
  assert.equal(understand('Tell me about a time you had to decide what you would cut from scope.').expected_answer_shape, 'star');
});

test('[m3/M5] more behavioral phrasings are recognised', () => {
  for (const q of ['Tell me about the time you shipped under pressure.', 'Tell me about another time you worked with a difficult stakeholder.', 'Another example please.', 'Give me a different example.', 'Describe a situation in which you had to learn fast.', "What's a challenge you faced on a team project?"]) {
    assert.equal(understand(q).expected_answer_shape, 'star', q);
  }
});

test('[re-review] "situation where you would" is hypothetical; "was there ever a time" is behavioral', () => {
  assert.equal(understand('Describe a situation where you would escalate an incident.').expected_answer_shape, 'recommend');
  assert.equal(understand('Was there ever a time you failed?').expected_answer_shape, 'star');
});
