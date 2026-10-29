'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { draftFromTranscript } = require('../src/main/memory-draft');

test('memory draft: commitments only from my own speech, requests from theirs, origins kept', () => {
  const d = draftFromTranscript({ lines: [
    { speaker: 'them', text: 'Could you send us your portfolio link after this call?', at: '2026-10-29T15:00:00Z' },
    { speaker: 'me', text: "Sure, I'll send the portfolio link by tonight.", at: '2026-10-29T15:00:05Z' },
    { speaker: 'them', text: "Great, let's go with a second round next Tuesday.", at: '2026-10-29T15:01:00Z' },
    { speaker: 'them', text: 'What timezone are you working from these days?' },
  ] });
  const kinds = d.map((i) => `${i.kind}/${i.origin}`);
  assert.ok(kinds.includes('action_item/their_speech'));
  assert.ok(kinds.includes('commitment/my_speech'));
  assert.ok(kinds.includes('decision/their_speech'));
  assert.ok(kinds.includes('open_question/their_speech'));
  assert.ok(d.every((i) => i.kind !== 'commitment' || i.origin === 'my_speech'));
  assert.equal(d.find((i) => i.kind === 'commitment').source_at, '2026-10-29T15:00:05Z');
});

test('memory draft: their "I will" is never my commitment; short lines and duplicates skipped', () => {
  const d = draftFromTranscript({ lines: [
    { speaker: 'them', text: "I'll send the offer details tomorrow morning." },
    { speaker: 'me', text: 'Okay.' },
    { speaker: 'me', text: "I'll share the slides with the team." },
    { speaker: 'me', text: "I'll share the slides with the team." },
  ] });
  assert.equal(d.filter((i) => i.kind === 'commitment').length, 1);
  assert.ok(!d.some((i) => i.kind === 'commitment' && i.origin === 'their_speech'));
});
