'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolveFlags, parseEnvBool, FLAG_DEFS } = require('../src/main/flags');

test('defaults: stale-turn guard on, every other flag off', () => {
  const { values, warnings } = resolveFlags({}, {});
  assert.equal(values.staleTurnGuard, true);
  assert.equal(values.dialogueStateV2, false);
  assert.equal(values.evidenceLedger, false);
  assert.equal(values.answerPlanner, false);
  assert.equal(values.activeContextV2, false);
  assert.equal(values.questionInterpreterV2, false);
  assert.equal(values.noveltyController, false);
  assert.equal(values.preparedAnswersAsEvidence, false);
  assert.equal(values.nativeAudio, false);
  assert.deepEqual(warnings, []);
});

test('config.flags overrides a default', () => {
  const { values } = resolveFlags({ flags: { dialogueStateV2: true } }, {});
  assert.equal(values.dialogueStateV2, true);
});

test('env overrides config and default', () => {
  assert.equal(resolveFlags({ flags: { staleTurnGuard: true } }, { FABEL_STALE_TURN_GUARD: 'false' }).values.staleTurnGuard, false);
  assert.equal(resolveFlags({ flags: { dialogueStateV2: false } }, { FABEL_DIALOGUE_STATE_V2: 'true' }).values.dialogueStateV2, true);
});

test('env boolean parsing accepts common forms and ignores garbage', () => {
  assert.equal(parseEnvBool('true'), true);
  assert.equal(parseEnvBool('1'), true);
  assert.equal(parseEnvBool('ON'), true);
  assert.equal(parseEnvBool('yes'), true);
  assert.equal(parseEnvBool('false'), false);
  assert.equal(parseEnvBool('0'), false);
  assert.equal(parseEnvBool('off'), false);
  assert.equal(parseEnvBool('maybe'), undefined);
  assert.equal(parseEnvBool(undefined), undefined);
  // garbage leaves the resolved value at its default
  assert.equal(resolveFlags({}, { FABEL_STALE_TURN_GUARD: 'maybe' }).values.staleTurnGuard, true);
});

test('dependency: a dependent flag is forced off and warned when its requirement is off', () => {
  const { values, warnings } = resolveFlags({ flags: { evidenceLedger: true } }, {});
  assert.equal(values.evidenceLedger, false);
  assert.equal(values.dialogueStateV2, false);
  assert.ok(warnings.some((w) => w.includes('FABEL_EVIDENCE_LEDGER') && w.includes('FABEL_DIALOGUE_STATE_V2')));
});

test('dependency satisfied: dependent flag stays on with no warning', () => {
  const { values, warnings } = resolveFlags({ flags: { dialogueStateV2: true, evidenceLedger: true, activeContextV2: true, answerPlanner: true } }, {});
  assert.equal(values.evidenceLedger, true);
  assert.equal(values.activeContextV2, true);
  assert.equal(values.answerPlanner, true);
  assert.deepEqual(warnings, []);
});

test('every flag def has a unique name and FABEL_ env key', () => {
  const names = new Set();
  const envs = new Set();
  for (const f of FLAG_DEFS) {
    assert.ok(/^[a-zA-Z0-9]+$/.test(f.name), `bad name ${f.name}`);
    assert.ok(f.env.startsWith('FABEL_'), `bad env ${f.env}`);
    assert.equal(typeof f.default, 'boolean');
    assert.ok(!names.has(f.name), `dup name ${f.name}`);
    assert.ok(!envs.has(f.env), `dup env ${f.env}`);
    names.add(f.name);
    envs.add(f.env);
    for (const r of f.requires || []) assert.ok(FLAG_DEFS.some((d) => d.name === r), `unknown requires ${r}`);
  }
});
