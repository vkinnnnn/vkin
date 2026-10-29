'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildPlan, renderPlan, structureFor } = require('../src/main/plan');

test('a behavioral question plans a natural STAR of ~90s', () => {
  const p = buildPlan({ meta: { kind: 'behavioral', expected_answer_shape: 'star', sourceIds: ['S1'] } });
  assert.equal(p.structure, 'natural_star');
  assert.equal(p.targetSeconds, 90);
  assert.equal(p.targetWords, Math.round((90 * 150) / 60));
  assert.deepEqual(p.evidenceIds, ['S1']);
});

test('a behavioral follow-up plans only the requested STAR component', () => {
  const interpreted = { answerShape: 'focused_star_result', expectedSeconds: 32, turnId: 't1' };
  const p = buildPlan({ meta: { kind: 'behavioral', expected_answer_shape: 'star' }, interpreted });
  assert.equal(p.structure, 'focused_star_result');
  assert.equal(p.targetSeconds, 32);
  assert.ok(p.newInformation[0].includes('result'));
  assert.equal(p.turnId, 't1');
});

test('avoid list includes canned openings and recent answer openings', () => {
  const p = buildPlan({ meta: { kind: 'technical' }, convo: [{ question: 'q', answer: 'So basically the pipeline joins two datasets and scores them.' }] });
  assert.ok(p.avoidPhrases.includes('One example that comes to mind'));
  assert.ok(p.avoidPhrases.some((x) => x.startsWith('So basically the pipeline')));
  assert.equal(p.structure, 'technical');
});

test('structureFor maps shapes to PRD structures', () => {
  assert.equal(structureFor({ kind: 'motivation', expected_answer_shape: 'direct' }), 'motivation');
  assert.equal(structureFor({ kind: 'compare', expected_answer_shape: 'compare' }), 'comparison');
  assert.equal(structureFor({ kind: 'situational', expected_answer_shape: 'recommend' }), 'situational');
  assert.equal(structureFor({ kind: 'factual', expected_answer_shape: 'direct' }), 'direct');
  assert.equal(structureFor({ kind: 'behavioral', expected_answer_shape: 'direct' }, { needsClarification: true }), 'clarification');
});

test('renderPlan produces a compact tagged block', () => {
  const block = renderPlan(buildPlan({ meta: { kind: 'behavioral', expected_answer_shape: 'star' } }));
  assert.match(block, /^<answer_plan>/);
  assert.match(block, /structure: natural_star/);
  assert.match(block, /target: about \d+ words/);
  assert.match(block, /<\/answer_plan>$/);
});
