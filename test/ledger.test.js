'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildLedger, renderLedger } = require('../src/main/brain/ledger');

const META = { needs_personal_evidence: true };

test('allowed claims carry their source id, from story + items + meeting items', () => {
  const l = buildLedger({
    story: { story: { id: 'STORY-1', title: 'Cut no-show rate with a scheduling model' } },
    items: [{ record: { id: 'PRJ-006', title: 'Appointment no-show prediction' } }],
    mItems: [{ record: { id: 'MTG-DASH', title: 'OKR vs SVI county dashboard' } }],
    meta: META,
  });
  assert.deepEqual(l.allowedClaims.map((a) => a.sourceId), ['STORY-1', 'PRJ-006', 'MTG-DASH']);
  assert.match(l.allowedClaims[0].claim, /no-show/);
});

test('forbidden reasons become do-not-say lines; regex-only entries are dropped', () => {
  const l = buildLedger({
    items: [{ record: { id: 'X', title: 't' } }],
    forbidden: [{ re: /x/, reason: 'Avery has no publications' }, { re: /y/ }],
    meta: META,
  });
  assert.deepEqual(l.disallowedClaims, ['Avery has no publications']);
});

test('already-delivered claims are the first sentence of each prior answer', () => {
  const l = buildLedger({
    items: [{ record: { id: 'X', title: 't' } }],
    convo: [{ question: 'q1', answer: 'SAY: I built the dashboard. It joined two datasets.' }],
    meta: META,
  });
  assert.deepEqual(l.alreadyDeliveredClaims, ['I built the dashboard.']);
});

test('unknown is flagged when personal evidence was needed but none retrieved', () => {
  const l = buildLedger({ items: [], meta: { needs_personal_evidence: true } });
  assert.equal(l.unknowns.length, 1);
  const l2 = buildLedger({ items: [{ record: { id: 'X', title: 't' } }], meta: { needs_personal_evidence: true } });
  assert.deepEqual(l2.unknowns, []);
});

test('renderLedger produces a compact tagged block, and empty ledger renders nothing', () => {
  const l = buildLedger({ story: { story: { id: 'S1', title: 'A story' } }, forbidden: [{ reason: 'no visa claims' }], meta: META });
  const block = renderLedger(l);
  assert.match(block, /^<evidence_ledger>/);
  assert.match(block, /ALLOWED/);
  assert.match(block, /\[S1\] A story/);
  assert.match(block, /DO NOT SAY/);
  assert.match(block, /no visa claims/);
  assert.match(block, /<\/evidence_ledger>$/);
  // nothing material -> empty string
  assert.equal(renderLedger({ allowedClaims: [], disallowedClaims: [], alreadyDeliveredClaims: [], unknowns: [] }), '');
});
