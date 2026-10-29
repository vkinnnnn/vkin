'use strict';
const test = require('node:test');
const assert = require('node:assert');
const OS = require('../src/renderer/overlay-state');
const { reduce: mReduce } = require('../src/main/mirror');
const { nextSeq } = require('../src/shared/contracts');

// --- contracts: nextSeq is monotonic -------------------------------------------------------
test('nextSeq increases strictly', () => {
  const a = nextSeq();
  const b = nextSeq();
  const c = nextSeq();
  assert.ok(b > a && c > b);
});

// --- overlay reducer: seq guard ------------------------------------------------------------
function play(reduce, init, events) {
  return events.reduce((s, ev) => reduce(s, ev), init);
}

test('overlay: a lower-seq answer event is dropped once a higher seq has been seen', () => {
  const s0 = OS.initial();
  // new generation seq=2 starts and streams
  const s1 = play(OS.reduce, s0, [
    { type: 'answer:start', seq: 2, genId: 'g2', kind: 'confirmed', question: 'q2' },
    { type: 'answer:delta', seq: 2, genId: 'g2', text: 'new answer' },
  ]);
  assert.equal(s1.live.text, 'new answer');
  // a stale delta from the older generation (seq=1) must not reach the card
  const s2 = OS.reduce(s1, { type: 'answer:delta', seq: 1, genId: 'g1', text: 'STALE' });
  assert.equal(s2, s1, 'stale event returns the same state');
  assert.equal(s2.live.text, 'new answer');
});

test('overlay: a stale START cannot replace the live card', () => {
  const s0 = OS.initial();
  const s1 = OS.reduce(s0, { type: 'answer:start', seq: 5, genId: 'g5', kind: 'confirmed', question: 'current' });
  const s2 = OS.reduce(s1, { type: 'answer:start', seq: 3, genId: 'g3', kind: 'confirmed', question: 'late' });
  assert.equal(s2.live.genId, 'g5');
  assert.equal(s2.live.question, 'current');
});

test('overlay: equal seq is allowed (same generation, multiple events)', () => {
  const s0 = OS.initial();
  const s1 = play(OS.reduce, s0, [
    { type: 'answer:start', seq: 4, genId: 'g4', kind: 'confirmed', question: 'q' },
    { type: 'answer:delta', seq: 4, genId: 'g4', text: 'a' },
    { type: 'answer:delta', seq: 4, genId: 'g4', text: 'b' },
  ]);
  assert.equal(s1.live.text, 'ab');
});

test('overlay: guard off (no seq on events) behaves exactly as before', () => {
  const s0 = OS.initial();
  const s1 = play(OS.reduce, s0, [
    { type: 'answer:start', genId: 'g1', kind: 'confirmed', question: 'q1' },
    { type: 'answer:delta', genId: 'g1', text: 'first' },
    { type: 'answer:start', genId: 'g2', kind: 'confirmed', question: 'q2' },
    { type: 'answer:delta', genId: 'g2', text: 'second' },
  ]);
  assert.equal(s1.live.genId, 'g2');
  assert.equal(s1.live.text, 'second');
  assert.equal(s1.maxSeq, undefined, 'no maxSeq tracked when events carry no seq');
});

test('overlay: non-answer events (nav/clear) pass through the guard untouched', () => {
  const s0 = OS.initial();
  const s1 = play(OS.reduce, s0, [
    { type: 'answer:start', seq: 2, genId: 'g2', kind: 'confirmed', question: 'q' },
    { type: 'answer:done', seq: 2, genId: 'g2', timings: {} },
    { type: 'answer:start', seq: 3, genId: 'g3', kind: 'confirmed', question: 'q3' },
  ]);
  const nav = OS.reduce(s1, { type: 'nav', dir: -1 });
  assert.equal(nav.view, 0, 'nav still works with the guard active');
});

// --- mirror reducer: seq guard -------------------------------------------------------------
test('mirror: a stale delta is dropped after a newer generation starts', () => {
  let st = { current: null, previous: null };
  st = mReduce(st, { type: 'answer:start', seq: 2, genId: 'g2', turnId: 't2', revision: 0, kind: 'confirmed', question: 'q2' });
  st = mReduce(st, { type: 'answer:delta', seq: 2, genId: 'g2', text: 'new' });
  const before = st;
  st = mReduce(st, { type: 'answer:delta', seq: 1, genId: 'g1', text: 'STALE' });
  assert.equal(st, before, 'stale event returns same state');
  assert.equal(st.current.text, 'new');
});

test('mirror: guard off (no seq) keeps prior behaviour and tracks no maxSeq', () => {
  let st = { current: null, previous: null };
  st = mReduce(st, { type: 'answer:start', genId: 'g1', turnId: 't1', revision: 0, kind: 'confirmed', question: 'q' });
  st = mReduce(st, { type: 'answer:delta', genId: 'g1', text: 'x' });
  assert.equal(st.current.text, 'x');
  assert.equal(st.maxSeq, undefined);
});
