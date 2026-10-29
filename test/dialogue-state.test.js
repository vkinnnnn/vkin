'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createDialogueState, ANSWER_STATE } = require('../src/main/brain/dialogue-state');

function ds() {
  let t = 0;
  return createDialogueState({ sessionId: 's1', now: () => (t += 1) });
}

test('a generated answer is not displayed and not spoken', () => {
  const d = ds();
  d.answerGenerated({ answerId: 'a1', turnId: 't1', storyId: 'STORY-1', claims: ['c1'], opening: 'Yeah,' });
  assert.equal(d.answerState('a1'), ANSWER_STATE.GENERATED);
  assert.deepEqual(d.claimsDelivered(), [], 'generated claims are not delivered');
  assert.deepEqual(d.storiesUsed(), []);
  assert.deepEqual(d.snapshot().generatedButUndisplayedAnswerIds, ['a1']);
  assert.deepEqual(d.snapshot().displayedAnswerIds, []);
});

test('displayed updates delivered claims, stories, openings and phrases', () => {
  const d = ds();
  d.answerGenerated({ answerId: 'a1', turnId: 't1', storyId: 'STORY-1', exampleIds: ['EX-1'], claims: ['c1', 'c2'], opening: 'Yeah,', phrases: ['the no show rate'] });
  assert.ok(d.answerDisplayed('a1'));
  assert.equal(d.answerState('a1'), ANSWER_STATE.DISPLAYED);
  assert.deepEqual(d.claimsDelivered(), ['c1', 'c2']);
  assert.deepEqual(d.storiesUsed(), ['STORY-1']);
  assert.deepEqual(d.examplesUsed(), ['EX-1']);
  assert.equal(d.lastDisplayedAnswerId, 'a1');
  const s = d.snapshot();
  assert.deepEqual(s.recentOpenings, ['Yeah,']);
  assert.deepEqual(s.recentDistinctivePhrases, ['the no show rate']);
  assert.equal(s.lastUserSpokenTurnId, null, 'displayed is not spoken');
});

test('displayed is not spoken; spoken is a separate, stronger transition', () => {
  const d = ds();
  d.answerGenerated({ answerId: 'a1', turnId: 't1' });
  d.answerDisplayed('a1');
  assert.equal(d.lastUserSpokenTurnId, null);
  assert.ok(d.answerSpoken('a1'));
  assert.equal(d.answerState('a1'), ANSWER_STATE.SPOKEN);
  assert.equal(d.lastUserSpokenTurnId, 't1');
  assert.ok(d.wasDelivered('a1'));
});

test('a cancelled answer never contributes a delivered claim', () => {
  const d = ds();
  d.answerGenerated({ answerId: 'a1', storyId: 'STORY-1', claims: ['c1'] });
  assert.ok(d.answerCancelled('a1'));
  assert.equal(d.answerState('a1'), ANSWER_STATE.CANCELLED);
  assert.deepEqual(d.claimsDelivered(), []);
  assert.deepEqual(d.storiesUsed(), []);
  // a cancelled answer cannot then be displayed or spoken
  assert.equal(d.answerDisplayed('a1'), false);
  assert.equal(d.answerSpoken('a1'), false);
});

test('a superseded generated answer is not delivered; an already-displayed answer keeps its truth', () => {
  const d = ds();
  d.answerGenerated({ answerId: 'a1', claims: ['c1'] });
  assert.ok(d.answerSuperseded('a1'));
  assert.deepEqual(d.claimsDelivered(), []);
  // one that already reached the user cannot be downgraded by a late supersede
  d.answerGenerated({ answerId: 'a2', claims: ['c2'] });
  d.answerDisplayed('a2');
  assert.equal(d.answerSuperseded('a2'), false, 'delivered answers keep the audit truth');
  assert.deepEqual(d.claimsDelivered(), ['c2']);
});

test('answerDisplayed enrichment fills empty fields but never overwrites generation facts', () => {
  const d = ds();
  d.answerGenerated({ answerId: 'a1', storyId: 'STORY-GEN', claims: ['gen-claim'] });
  // enrich provides a different story + examples; story is already set at generation, so it is kept
  d.answerDisplayed('a1', { storyId: 'STORY-ENRICH', exampleIds: ['EX-1'], claims: ['enrich-claim'], opening: 'Yeah,' });
  assert.deepEqual(d.storiesUsed(), ['STORY-GEN'], 'generation story is not overwritten');
  assert.deepEqual(d.examplesUsed(), ['EX-1'], 'empty exampleIds filled from enrichment');
  assert.deepEqual(d.claimsDelivered(), ['gen-claim'], 'non-empty claims not overwritten');
  assert.deepEqual(d.snapshot().recentOpenings, ['Yeah,']);
});

test('active topic and story are explicit and nullable', () => {
  const d = ds();
  d.setActiveTopic('project-atlas');
  d.setActiveStory('story-atlas');
  assert.equal(d.activeTopicId, 'project-atlas');
  assert.equal(d.activeStoryId, 'story-atlas');
  d.setActiveTopic(null);
  assert.equal(d.activeTopicId, null);
});

test('recent turn ids are bounded and de-duplicated consecutively', () => {
  const d = ds();
  for (let i = 0; i < 20; i++) d.noteTurn(`t${i}`);
  d.noteTurn('t19'); // consecutive dup ignored
  const ids = d.snapshot().recentTurnIds;
  assert.ok(ids.length <= 12);
  assert.equal(ids[ids.length - 1], 't19');
  assert.equal(ids.filter((x) => x === 't19').length, 1);
});

test('corrections are appended and never erased (audit history)', () => {
  const d = ds();
  d.noteCorrection('Fabrikam was Jan 2022, not 2023');
  d.noteCorrection('it is Okafor, not Aldridge');
  assert.deepEqual(d.snapshot().corrections, ['Fabrikam was Jan 2022, not 2023', 'it is Okafor, not Aldridge']);
});

test('open questions can be added and resolved by turn', () => {
  const d = ds();
  d.noteOpenQuestion({ turnId: 't1', question: 'What is your availability?' });
  d.noteOpenQuestion({ turnId: 't2', question: 'What tools?' });
  assert.equal(d.snapshot().openQuestions.length, 2);
  d.resolveOpenQuestion('t1');
  assert.deepEqual(d.snapshot().openQuestions.map((o) => o.turnId), ['t2']);
});

test('reset clears session-scoped state', () => {
  const d = ds();
  d.answerGenerated({ answerId: 'a1', claims: ['c1'] });
  d.answerDisplayed('a1');
  d.setActiveTopic('x');
  d.reset();
  const s = d.snapshot();
  assert.deepEqual(s.claimsDelivered, []);
  assert.equal(s.activeTopicId, null);
  assert.deepEqual(s.displayedAnswerIds, []);
});

test('snapshot is a copy: mutating it does not change state', () => {
  const d = ds();
  d.answerGenerated({ answerId: 'a1', claims: ['c1'] });
  d.answerDisplayed('a1');
  const s = d.snapshot();
  s.claimsDelivered.push('injected');
  s.recentOpenings.push('x');
  assert.deepEqual(d.claimsDelivered(), ['c1'], 'internal state is not mutated by snapshot consumers');
});
