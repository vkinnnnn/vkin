'use strict';
// Answer preferences (PRD Phase 3): defaults leave the instructions unchanged; each preference adds
// exactly its own instruction; unknown/invalid values are dropped.
const test = require('node:test');
const assert = require('node:assert');
const { answerInstructions, sanitizePreferences, DEFAULTS } = require('../src/main/render');

const behavioral = { kind: 'behavioral', expected_answer_shape: 'star', literal_question: 'How do you handle conflict on a team?', stakes: 'normal', ambiguities: [] };
const explicit = { ...behavioral, literal_question: 'Tell me about a time you handled conflict on a team.' };
const technical = { kind: 'technical', expected_answer_shape: 'explain', literal_question: 'How does gradient boosting work?', stakes: 'normal', ambiguities: [] };
const story = { title: 'Team conflict at Fabrikam' };
const ins = (meta, prefs = {}) => answerInstructions(meta, {}, { settings: { ...DEFAULTS, ...prefs }, story });

test('defaults: no preference instruction is added', () => {
  const s = ins(technical);
  assert.doesNotMatch(s, /professional register|formal register|technical content light|technically deep|spoken words, even if|Write the answer in|talking points/);
  assert.match(s, /One paragraph only/);
});

test('tone, depth, language and max length each add one instruction', () => {
  assert.match(ins(technical, { tone: 'formal' }), /formal register/);
  assert.match(ins(technical, { tone: 'professional' }), /professional register/);
  assert.match(ins(technical, { technicalDepth: 'light' }), /technical content light/);
  assert.match(ins(technical, { technicalDepth: 'deep' }), /technically deep/);
  assert.match(ins(technical, { language: 'Spanish' }), /Write the answer in Spanish/);
  assert.match(ins(technical, { maxSeconds: 30 }), /under about 75 spoken words/);
});

test('format bullets swaps the one-paragraph rule for short talking points', () => {
  const s = ins(technical, { format: 'bullets' });
  assert.match(s, /at most 4 short talking points/);
  assert.doesNotMatch(s, /One paragraph only/);
});

test('STAR policy: auto tells the story, disabled never, manual only when an example is asked for', () => {
  assert.match(ins(behavioral), /Answer with this ONE real story/);
  assert.doesNotMatch(ins(behavioral, { star: 'disabled' }), /ONE real story/);
  assert.match(ins(behavioral, { star: 'disabled' }), /Do not tell it as a Situation-Task-Action-Result story/);
  assert.doesNotMatch(ins(behavioral, { star: 'manual' }), /ONE real story/);
  assert.match(ins(explicit, { star: 'manual' }), /ONE real story/);
});

test('sanitizePreferences keeps allowed values only and clamps maxSeconds', () => {
  assert.deepEqual(sanitizePreferences({ tone: 'formal', star: 'sometimes', evil: 'x', length: 'long' }), { tone: 'formal', length: 'long' });
  assert.deepEqual(sanitizePreferences({ maxSeconds: 5 }), { maxSeconds: 10 });
  assert.deepEqual(sanitizePreferences({ maxSeconds: 9999 }), { maxSeconds: 300 });
  assert.deepEqual(sanitizePreferences({ maxSeconds: -1 }), { maxSeconds: 0 });
  assert.deepEqual(sanitizePreferences(null), {});
  assert.deepEqual(sanitizePreferences({ language: 'Klingon' }), {});
});