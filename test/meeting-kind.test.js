'use strict';
// Meeting kinds: research packs keep the original scholarly rules; interviews get neutral ones.
const test = require('node:test');
const assert = require('node:assert');
const { meetingKindOf } = require('../src/main/meeting');
const { classify } = require('../src/main/understand');
const { answerInstructions, MEETING_RULE, MEETING_RULE_GENERAL, KIND_RULES, DEFAULTS } = require('../src/main/render');

test('meeting kind: explicit wins, then session meeting type, then literature terms', () => {
  assert.equal(meetingKindOf({ meeting_kind: 'general', literature_terms: ['OKR'] }), 'general');
  assert.equal(meetingKindOf({ session: { meetingType: 'Job interview' } }), 'interview');
  assert.equal(meetingKindOf({ session: { meetingType: 'Recruiter screen' } }), 'interview');
  assert.equal(meetingKindOf({ session: { meetingType: 'Research meeting' } }), 'research');
  assert.equal(meetingKindOf({ literature_terms: ['social capital'] }), 'research', 'the first research pack stays research');
  assert.equal(meetingKindOf({}), 'general');
});

test('classifier: only research meetings turn "what is X" and reading words into literature', () => {
  const research = { literatureTerms: ['OKR'], research: true };
  const interview = { literatureTerms: [], research: false };
  assert.equal(classify('What is ETL and how does it work?', { meeting: research }), 'literature');
  assert.equal(classify('What is ETL and how does it work?', { meeting: interview }), 'technical');
  assert.equal(classify('What do you know about data governance concepts?', { meeting: interview }) === 'literature', false);
  assert.equal(classify('What is ETL and how does it work?', { meeting: { literatureTerms: [] } }), 'literature', 'older callers default to research');
});

test('classifier: pay-expectation wording is compensation in every mode', () => {
  for (const q of ['What is your pay expectation for this position?', 'What are your salary expectations?', 'What hourly rate are you looking for?', 'How much do you expect to make?']) {
    assert.equal(classify(q, { meeting: { research: false } }), 'compensation', q);
    assert.equal(classify(q), 'compensation', q);
  }
});

const roleFit = { kind: 'role_fit', expected_answer_shape: 'direct', literal_question: 'Why are you a good fit for this role?', stakes: 'normal', ambiguities: [] };
test('answer rules: interviews use the neutral meeting rule and role-fit rule; research is unchanged', () => {
  const interview = answerInstructions(roleFit, {}, { settings: DEFAULTS, meeting: 'interview' });
  assert.ok(interview.includes(MEETING_RULE_GENERAL));
  assert.ok(!interview.includes(MEETING_RULE));
  assert.doesNotMatch(interview, /dashboard I built for them|for the paper/);
  assert.match(interview, /If the role names a tool I have not used/);
  for (const meeting of ['research', true]) {
    const research = answerInstructions(roleFit, {}, { settings: DEFAULTS, meeting });
    assert.ok(research.includes(MEETING_RULE));
    assert.ok(research.includes(KIND_RULES.role_fit));
  }
  const none = answerInstructions(roleFit, {}, { settings: DEFAULTS });
  assert.ok(!none.includes(MEETING_RULE) && !none.includes(MEETING_RULE_GENERAL));
});
