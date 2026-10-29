'use strict';
// Regression tests for the Phase 2-6 independent review (2026-10-17): four Major findings + minors.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { TurnManager } = require('../src/main/turns');
const { toPackRecords } = require('../src/main/prep/chunk');
const { createScreenContext } = require('../src/main/screen/screen-context');
const { isPage } = require('../src/main/trust');

test('[M1] only the exact bundled page passes the renderer trust check', () => {
  const dir = path.join('C:', 'app', 'src', 'renderer');
  assert.equal(isPage(pathToFileURL(path.join(dir, 'prep.html')).href, 'prep.html', dir), true);
  assert.equal(isPage(pathToFileURL(path.join('C:', 'Users', 'x', 'Downloads', 'evil.html')).href, 'prep.html', dir), false, 'a dropped file');
  assert.equal(isPage(pathToFileURL(path.join(dir, 'overlay.html')).href, 'prep.html', dir), false, 'another bundled page');
  assert.equal(isPage('https://example.com/prep.html', 'prep.html', dir), false);
  assert.equal(isPage('', 'prep.html', dir), false);
  assert.equal(isPage(`${pathToFileURL(path.join(dir, 'x', '..', 'prep.html')).href}`, 'prep.html', dir), true, 'normalized');
});

test('[M2] importing the maximum 2 MB text is linear (was 14 s on the main thread)', () => {
  const para = 'Professor Example studies Social Capital and Disaster Recovery in Japan. '.repeat(10);
  let text = '';
  while (text.length < 2 * 1024 * 1024) text += `${para}\n\n`;
  const t0 = Date.now();
  const recs = toPackRecords(text, { docId: 'big', docName: 'big.txt', kind: 'supplementary', side: 'them' });
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  assert.ok(recs.length > 1000);
  const last = recs[recs.length - 1].span.match(/^L(\d+)-L(\d+)$/);
  assert.ok(Number(last[1]) > 5000, 'line numbers still correct at the end of the file');
});

function fakeLlm() {
  const calls = [];
  return { calls, stream({ signal, onDelta }) { return new Promise((resolve) => { calls.push({ push: (t) => onDelta(t), finish: () => resolve({ text: '' }) }); signal.addEventListener('abort', () => resolve({ aborted: true })); }); } };
}

test('[M3] a prepared build is not reused once another answer was remembered, even with a full (capped) log', async () => {
  const builds = [];
  let t = 1000;
  const tm = new TurnManager({
    sessionId: 's', config: { minWords: 6, speculativeLlm: false }, llm: fakeLlm(), partialPrep: true,
    buildMessages: (q, h, extra) => { builds.push({ q, prepare: Boolean(extra && extra.prepare), convo: (extra && extra.conversation || []).length }); return [{ role: 'user', content: q }]; },
    emit: () => {}, now: () => (t += 10),
  });
  for (let i = 0; i < 20; i += 1) tm.answers.remember(`question ${i}`, `answer ${i}`);
  assert.equal(tm.answers.log.length, 20);
  const Q = 'Why did you choose that approach for the pipeline?';
  tm.onSttEvent({ channel: 'them', event: 'EagerEndOfTurn', turnIndex: 5, transcript: Q });
  tm.answers.remember('question 20', 'answer 20'); // an answer finished between eager and final
  assert.equal(tm.answers.log.length, 20, 'still capped at 20');
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 5, transcript: Q });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(builds.map((b) => b.prepare), [true, false], 'rebuilt with the new conversation');
});

test('[M4] manual mode: Answer answers the question shown as waiting, not a later statement', async () => {
  const starts = [];
  const tm = new TurnManager({ sessionId: 's', config: { minWords: 6 }, llm: fakeLlm(), buildMessages: () => [], emit: () => {}, now: () => 1000 });
  tm.answers.start = (o) => { starts.push(o); return 'g'; };
  tm.setAutoAnswer(false);
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: 'How did you validate the model?' });
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 1, transcript: 'Take your time, no rush at all.' });
  tm.manualAnswer();
  assert.equal(starts[0].question, 'How did you validate the model?');
  assert.equal(tm.lastQuestion, 'How did you validate the model?', 'regenerate keeps the right question');
  tm.manualAnswer(); // nothing pending any more: falls back to their last finished turn
  assert.equal(starts[1].question, 'Take your time, no rush at all.');
});

test('[minor] screen: discard cancels a running vision call and tells the overlay; using or replacing does not', async () => {
  const discarded = [];
  let signal = null;
  const ctx = createScreenContext({
    grab: async () => ({ ocrPng: Buffer.from('p'), visionJpeg: Buffer.from('j'), previewDataUrl: '', width: 10, height: 10, visionWidth: 10, visionHeight: 10 }),
    ocr: async () => ({ text: 'hello', ms: 1 }),
    llm: { stream: (req) => new Promise((resolve) => { signal = req.signal; req.signal.addEventListener('abort', () => resolve({ aborted: true })); }) },
    timers: { setTimeout: () => 1, clearTimeout: () => {} },
    onDiscard: (r) => discarded.push(r),
  });
  const s = await ctx.capture();
  const pending = ctx.describe(s.id, 'q');
  ctx.discard('panic');
  await assert.rejects(pending, /discarded/);
  assert.equal(signal.aborted, true, 'vision request aborted');
  assert.deepEqual(discarded, ['panic']);
  const s2 = await ctx.capture();
  await ctx.capture(); // replacing an unused shot: no notice (the overlay itself asked)
  await ctx.readText();
  ctx.take(); // used for an answer: no notice
  assert.deepEqual(discarded, ['panic']);
  assert.ok(s2.id);
});
