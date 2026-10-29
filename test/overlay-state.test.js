const test = require('node:test');
const assert = require('node:assert/strict');
const OS = require('../src/renderer/overlay-state.js');

const run = (events, s = OS.initial()) => events.reduce((acc, ev) => OS.reduce(acc, ev), s);
const start = (genId, kind = 'confirmed', extra = {}) => ({ type: 'answer:start', genId, kind, question: `q${genId}`, at: 1000 * genId, ...extra });
const delta = (genId, text) => ({ type: 'answer:delta', genId, text });
const done = (genId, extra = {}) => ({ type: 'answer:done', genId, timings: { eotToFirstTokenMs: 321, totalMs: 900 }, model: 'm', hedged: false, ...extra });
const finished = (genId, text = `SAY: a${genId}`) => [start(genId), delta(genId, text), done(genId)];

test('done moves a confirmed card to history and clears live', () => {
  const s = run([start(1), delta(1, 'SAY: hi POINTS:\n- a'), done(1)]);
  assert.equal(s.history.length, 1);
  assert.equal(s.live, null);
  assert.equal(s.history[0].genId, 1);
  assert.equal(s.history[0].text, 'SAY: hi POINTS:\n- a');
  assert.equal(s.history[0].firstTokenMs, 321);
  assert.equal(s.history[0].question, 'q1');
  assert.equal(OS.viewed(s).card.genId, 1);
});

test('a speculative card that is invalidated never reaches history', () => {
  let s = run([start(1, 'speculative'), delta(1, 'SAY: draft'), { type: 'answer:invalidate', genId: 1 }]);
  assert.equal(s.live, null);
  s = OS.reduce(s, done(1)); // late done for the invalidated card
  assert.equal(s.history.length, 0);
});

test('a speculative card that finishes without promotion stays out of history', () => {
  const s = run([start(1, 'speculative'), delta(1, 'SAY: draft'), done(1)]);
  assert.equal(s.history.length, 0);
  assert.equal(s.live.genId, 1);
});

test('a promoted speculative card reaches history after done', () => {
  let s = run([start(1, 'speculative'), delta(1, 'SAY: x'), { type: 'answer:promote', genId: 1 }]);
  assert.equal(s.history.length, 0);
  assert.equal(s.live.kind, 'confirmed');
  s = OS.reduce(s, done(1));
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].kind, 'confirmed');
  assert.equal(s.live, null);
});

test('promote after done also commits (no duplicate on a repeated done)', () => {
  let s = run([start(1, 'speculative'), delta(1, 'SAY: x'), done(1), { type: 'answer:promote', genId: 1 }]);
  assert.equal(s.history.length, 1);
  s = OS.reduce(s, done(1));
  assert.equal(s.history.length, 1);
});

test('invalidate never affects history', () => {
  const s = run([...finished(1), start(2, 'speculative'), { type: 'answer:invalidate', genId: 2 }, { type: 'answer:invalidate', genId: 1 }]);
  assert.deepEqual(s.history.map((c) => c.genId), [1]);
  assert.equal(s.live, null);
});

test('nav bounds are respected', () => {
  let s = run([...finished(1), ...finished(2), ...finished(3)]);
  assert.equal(OS.viewed(s).index, 2);
  for (let i = 0; i < 6; i++) s = OS.reduce(s, { type: 'nav', dir: -1 });
  assert.equal(OS.viewed(s).index, 0);
  assert.equal(OS.viewed(s).card.genId, 1);
  for (let i = 0; i < 6; i++) s = OS.reduce(s, { type: 'nav', dir: 1 });
  assert.equal(OS.viewed(s).index, 2);
  assert.equal(OS.viewed(s).card.genId, 3);
  assert.equal(OS.reduce(OS.initial(), { type: 'nav', dir: -1 }).view, null); // empty history: no-op
});

test('nav reaches the live card and resumes following it', () => {
  let s = run([...finished(1), ...finished(2), start(3), delta(3, 'SAY: z')]);
  assert.equal(OS.viewed(s).isLive, true);
  s = OS.reduce(s, { type: 'nav', dir: -1 });
  assert.equal(OS.viewed(s).card.genId, 2);
  s = OS.reduce(s, { type: 'nav', dir: 1 });
  assert.equal(OS.viewed(s).isLive, true);
  assert.equal(s.view, null);
  assert.equal(OS.viewed(s).total, 3);
});

test('a stale genId delta is ignored', () => {
  let s = run([start(1), start(2)]);
  s = OS.reduce(s, delta(1, 'STALE'));
  assert.equal(s.live.text, '');
  s = OS.reduce(s, delta(2, 'ok'));
  assert.equal(s.live.text, 'ok');
  for (const type of ['answer:promote', 'answer:invalidate', 'answer:error']) s = OS.reduce(s, { type, genId: 1, message: 'x' });
  s = OS.reduce(s, done(1));
  assert.equal(s.live.genId, 2);
  assert.equal(s.live.kind, 'confirmed');
  assert.equal(s.live.error, null);
  assert.equal(s.history.length, 0);
});

test('a new speculative start while viewing an old card keeps the view and sets newPill', () => {
  let s = run([...finished(1), ...finished(2), { type: 'nav', dir: -1 }]);
  assert.equal(OS.viewed(s).card.genId, 1);
  s = OS.reduce(s, start(3, 'speculative'));
  assert.equal(OS.viewed(s).card.genId, 1);
  assert.equal(s.newPill, true);
  assert.equal(s.live.genId, 3);
  s = OS.reduce(s, { type: 'jumpLive' });
  assert.equal(OS.viewed(s).card.genId, 3);
  assert.equal(s.newPill, false);
});

test('a speculative start while following the newest card jumps to it; a non-speculative start always jumps', () => {
  let s = run([...finished(1), start(2, 'speculative')]);
  assert.equal(OS.viewed(s).card.genId, 2);
  assert.equal(s.newPill, false);
  s = run([...finished(1), ...finished(2), { type: 'nav', dir: -1 }, start(3, 'manual')]);
  assert.equal(OS.viewed(s).card.genId, 3);
  assert.equal(s.newPill, false);
});

test('invalidating the live card drops the new-answer pill', () => {
  const s = run([...finished(1), ...finished(2), { type: 'nav', dir: -1 }, start(3, 'speculative'), { type: 'answer:invalidate', genId: 3 }]);
  assert.equal(s.newPill, false);
  assert.equal(s.live, null);
  assert.equal(OS.viewed(s).card.genId, 1);
});

test('rate is stored on history and live cards', () => {
  let s = run([...finished(1), start(2)]);
  s = OS.reduce(s, { type: 'rate', genId: 1, rating: 'up' });
  assert.equal(s.history[0].rating, 'up');
  s = OS.reduce(s, { type: 'rate', genId: 2, rating: 'down' });
  assert.equal(s.live.rating, 'down');
  s = OS.reduce(s, { type: 'rate', genId: 1, rating: 'down' });
  assert.equal(s.history[0].rating, 'down');
});

test('clear hides the newest card but keeps history', () => {
  let s = run([...finished(1), start(2), delta(2, 'SAY: z'), { type: 'clear' }]);
  assert.equal(s.live, null);
  assert.equal(OS.viewed(s).card, null);
  assert.equal(s.history.length, 1);
  s = OS.reduce(s, { type: 'nav', dir: -1 });
  assert.equal(OS.viewed(s).card.genId, 1);
  // clearing while an older card is shown does nothing
  s = run([...finished(1), ...finished(2), { type: 'nav', dir: -1 }, { type: 'clear' }]);
  assert.equal(OS.viewed(s).card.genId, 1);
  assert.equal(s.history.length, 2);
});

test('errors and chat requests are kept on the card; errored cards never enter history', () => {
  let s = run([start(1, 'chat', { request: 'shorter' }), { type: 'answer:error', genId: 1, message: 'boom' }, done(1)]);
  assert.equal(s.live.request, 'shorter');
  assert.equal(s.live.error, 'boom');
  assert.equal(s.history.length, 0);
});

test('sessionEnd flags the session and keeps history; the next start clears the flag', () => {
  let s = run([...finished(1), { type: 'sessionEnd' }]);
  assert.equal(s.ended, true);
  assert.equal(s.history.length, 1);
  s = OS.reduce(s, start(2));
  assert.equal(s.ended, false);
});

test('live question strip follows THEM non-final turns, ignores ME and echo, mutes on final', () => {
  const t = (o) => ({ type: 'transcript', channel: 'them', turnId: 1, text: 'x', status: 'partial', ...o });
  let st = OS.stripReduce(null, t({ text: 'what is' }));
  assert.deepEqual([st.text, st.final], ['what is', false]);
  assert.equal(OS.stripReduce(st, t({ channel: 'me', text: 'nope' })), st);
  assert.equal(OS.stripReduce(st, t({ echo: true, text: 'nope' })), st);
  st = OS.stripReduce(st, t({ text: 'what is a mutex', status: 'final' }));
  assert.deepEqual([st.text, st.final], ['what is a mutex', true]);
  assert.equal(OS.stripReduce(st, t({ text: 'late partial' })).text, 'what is a mutex');
  st = OS.stripReduce(st, t({ turnId: 2, text: 'next' }));
  assert.deepEqual([st.turnId, st.final], [2, false]);
  st = OS.stripReduce(st, { type: 'clearStrip' });
  assert.equal(st.dismissed, true);
  assert.equal(OS.stripReduce(st, t({ turnId: 2, text: 'next more' })), st);
  assert.equal(OS.stripReduce(st, t({ turnId: 3, text: 'fresh' })).dismissed, false);
});

test('helpers: lastWords, clock, clean, parse, answerText', () => {
  const w = OS.lastWords(Array.from({ length: 15 }, (_, i) => `w${i}`).join(' '), 12);
  assert.equal(w.words.length, 12);
  assert.equal(w.words[0], 'w3');
  assert.equal(w.more, true);
  assert.equal(OS.clock(125000, 5000), '02:00');
  assert.equal(OS.clock(5000, null), '');
  assert.equal(OS.clean('Built it (PRJ-001, EXP-002) [src: x] fast'), 'Built it fast');
  const p = OS.parse('SAY: Hello there. PRJ-003\nPOINTS:\n- one\n- two');
  assert.equal(p.say, 'Hello there.');
  assert.deepEqual(p.points, ['one', 'two']);
  assert.equal(OS.answerText({ text: 'SAY: Hi\nPOINTS:\n- a\n- b' }), 'Hi\n- a\n- b');
});

// ---- answer:validated / answer:replace -------------------------------------------------------
const validated = (genId, action, extra = {}) => ({ type: 'answer:validated', genId, ok: action !== 'regenerating', action, unsupported: [], warnings: 0, confidence: 0.9, ...extra });
const replace = (genId, text) => ({ type: 'answer:replace', genId, text });

test('validated checked sets card.validation and survives into history', () => {
  let s = run([start(1), delta(1, 'SAY: hi'), validated(1, 'checked', { warnings: 2 })]);
  assert.equal(s.live.validation.action, 'checked');
  assert.equal(s.live.validation.warnings, 2);
  s = OS.reduce(s, done(1));
  assert.equal(s.history[0].validation.action, 'checked');
  assert.deepEqual(OS.validationBadge(s.history[0]), { cls: 'grounded', text: '✓ grounded', title: '✓ grounded (2 notes)' });
});

test('regenerating then start with revisionOf leaves no history entry for the rejected genId', () => {
  let s = run([...finished(1), start(2), delta(2, 'SAY: bad'), validated(2, 'regenerating')]);
  assert.equal(s.live.validation.action, 'regenerating');
  assert.equal(OS.validationBadge(s.live).cls, 'checking');
  s = OS.reduce(s, done(2)); // never happens, but must not commit a rejected draft
  assert.equal(s.history.length, 1);
  s = OS.reduce(s, start(3, 'confirmed', { revisionOf: 2 }));
  assert.equal(s.live.genId, 3);
  assert.equal(s.live.revisionOf, 2);
  assert.equal(s.newPill, false);
  assert.equal(s.view, null);
  assert.deepEqual(s.history.map((c) => c.genId), [1]);
  s = run([delta(3, 'SAY: good'), done(3)], s);
  assert.deepEqual(s.history.map((c) => c.genId), [1, 3]);
});

test('start with revisionOf does not move the view of a user pinned on an older card', () => {
  let s = run([...finished(1), ...finished(2), start(3), delta(3, 'SAY: bad'), { type: 'nav', dir: -1 }, { type: 'nav', dir: -1 }]);
  assert.equal(s.view, 0);
  s = run([validated(3, 'regenerating'), start(4, 'confirmed', { revisionOf: 3 })], s);
  assert.equal(s.view, 0);
  assert.equal(s.newPill, false);
  assert.equal(OS.viewed(s).card.genId, 1);
  assert.equal(s.live.genId, 4);
  assert.deepEqual(s.history.map((c) => c.genId), [1, 2]);
});

test('a start whose revisionOf is not the live card behaves like a normal start', () => {
  const s = run([start(1), start(2, 'confirmed', { revisionOf: 'nope' })]);
  assert.equal(s.live.genId, 2);
  assert.equal(s.history.length, 0);
});

test('replace updates both the live card and a history card; unknown genIds are ignored', () => {
  let s = run([...finished(1, 'SAY: old1'), start(2), delta(2, 'SAY: old2')]);
  s = OS.reduce(s, replace(2, 'SAY: new2'));
  assert.equal(s.live.text, 'SAY: new2');
  s = OS.reduce(s, replace(1, 'SAY: new1'));
  assert.equal(s.history[0].text, 'SAY: new1');
  assert.equal(OS.reduce(s, replace(99, 'x')), s);
  assert.equal(OS.reduce(s, { type: 'answer:replace', genId: 1 }), s); // no text
});

test('stale validated and replace are ignored', () => {
  const s = run([start(1), delta(1, 'SAY: a'), { type: 'answer:invalidate', genId: 1 }, start(2), delta(2, 'SAY: b')]);
  assert.equal(OS.reduce(s, validated(1, 'checked')), s);
  assert.equal(OS.reduce(s, validated(7, 'regenerating')), s);
  assert.equal(OS.reduce(s, replace(1, 'zzz')), s);
  assert.equal(s.live.validation, undefined);
});

test('a trimmed card enters history with validation.action trimmed and the replaced text', () => {
  const unsupported = [{ claim: 'Led a team of 40', kind: 'metric', reason: 'not in profile' }];
  const s = run([start(1), delta(1, 'SAY: a. Led a team of 40.'), replace(1, 'SAY: a.'), validated(1, 'trimmed', { unsupported }), done(1)]);
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].validation.action, 'trimmed');
  assert.equal(s.history[0].text, 'SAY: a.');
  const b = OS.validationBadge(s.history[0]);
  assert.equal(b.text, '✂ trimmed unsupported claims');
  assert.match(b.title, /Led a team of 40/);
});

test('trimmed badge title truncates long claims and long lists', () => {
  const unsupported = Array.from({ length: 8 }, (_, i) => ({ claim: `c${i} ${'x'.repeat(200)}`, kind: 'k', reason: 'r' }));
  const b = OS.validationBadge({ validation: { action: 'trimmed', unsupported, warnings: 0 } });
  assert.equal(b.title.split('\n').length, 1 + 5 + 1);
  assert.match(b.title, /and 3 more/);
  assert.ok(b.title.split('\n').every((l) => l.length <= 90));
  assert.equal(OS.validationBadge({ validation: { action: 'checked', warnings: 0 } }).title, '✓ grounded');
  assert.equal(OS.validationBadge({}), null);
});
