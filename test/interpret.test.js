'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { understand } = require('../src/main/understand');
const { interpretQuestion, focusedShape } = require('../src/main/interpret');

const I = (text, extra = {}) => interpretQuestion({ meta: understand(text), surfaceQuestion: text, ...extra });

test('a behavioral question maps to the behavioral type and ~90s', () => {
  const r = I('Tell me about a time you handled a tight deadline.');
  assert.equal(r.questionType, 'behavioral');
  assert.equal(r.answerShape, 'star');
  assert.equal(r.expectedSeconds, 90);
  assert.ok(r.requiredEvidence.includes('personal actions'));
});

test('a follow-up becomes behavioral_follow_up with a focused component and a resolved question', () => {
  const r = I('What did you personally do there?', { followUp: true, lastTopicQuestion: 'Tell me about a time you handled a deadline', lastTopicTurnId: 'them:1' });
  assert.equal(r.questionType, 'behavioral_follow_up');
  assert.equal(r.answerShape, 'focused_star_action');
  assert.equal(r.expectedSeconds, 32);
  assert.match(r.resolvedQuestion, /regarding: Tell me about a time you handled a deadline/);
  assert.deepEqual(r.referencedTurnIds, ['them:1']);
});

test('focusedShape picks the STAR component the follow-up asks for', () => {
  assert.equal(focusedShape('what was the result?'), 'focused_star_result');
  assert.equal(focusedShape('what was the hardest part?'), 'focused_star_situation');
  assert.equal(focusedShape('what was your responsibility?'), 'focused_star_task');
  assert.equal(focusedShape('why did you do that?'), 'focused_star_action');
});

test('motivation and technical get the right type and duration', () => {
  const m = I('Why are you interested in this role?');
  assert.equal(m.questionType, 'motivation');
  assert.equal(m.expectedSeconds, 45);
  const t = I('How does retrieval-augmented generation work?');
  assert.equal(t.questionType, 'technical');
  assert.equal(t.expectedSeconds, 67);
});

test('a social nicety is casual and needs no retrieval', () => {
  const r = I('Great, thanks so much!');
  assert.equal(r.questionType, 'casual');
  assert.equal(r.needsRetrieval, false);
});

test('referenced entities flow through from understand()', () => {
  const r = interpretQuestion({ meta: understand('What did you build at Contoso?', { knownEntities: ['Contoso'] }), surfaceQuestion: 'What did you build at Contoso?' });
  assert.ok(r.referencedEntities.includes('Contoso'));
});

test('an elliptical follow-up with nothing to resolve against is low confidence', () => {
  const r = I('Why?', { followUp: true });
  assert.ok(r.confidence <= 0.4);
});
