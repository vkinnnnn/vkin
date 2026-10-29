'use strict';
// A packaged build must not carry the developer's profile (Vkin generalisation).
const test = require('node:test');
const assert = require('node:assert');
const { neutralConfig } = require('../scripts/make-defaults');

test('neutral default config carries no personal profile, keyterms or active pack', () => {
  const c = neutralConfig(require('../config.json'));
  assert.deepEqual(c.stt.keyterms, []);
  for (const k of ['careerPro', 'partsDir', 'brief', 'displayName']) assert.equal(c.profile[k], '', k);
  assert.deepEqual(c.profile.replacements, []);
  assert.deepEqual(c.profile.restrictedClaims, []);
  assert.deepEqual(c.profile.correctionAliases, []);
  assert.deepEqual(c.profile.excludeRecords, []);
  assert.equal(c.meeting.enabled, false);
  assert.equal(c.meeting.profile, '');
  assert.doesNotMatch(JSON.stringify(c), /[A-Za-z]:[\\/]Users|CareerPro\.md/i);
  // Safety defaults survive.
  assert.equal(c.budget.liveCallsEnabledAtStartup, false);
});
