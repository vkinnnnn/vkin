'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { understand } = require('../src/main/understand');
const { answerInstructions, settingsFrom } = require('../src/main/render');
const { createTelemetry, summarize, percentile } = require('../src/main/telemetry');

const S = settingsFrom({ answer: { length: 'short', fillerIntensity: 'subtle', maxFillers: 2, starSeconds: 60 } }, {});

test('STAR shape uses one story, no labels, 20/10/60/10 and ~150 words for 60 s', () => {
  const t = answerInstructions(understand('Tell me about a time you worked under a deadline'), {}, { settings: S, story: { title: 'Shipping the loan pipeline' } });
  assert.match(t, /ONE real story: "Shipping the loan pipeline"/);
  assert.match(t, /no Situation\/Task\/Action\/Result labels/);
  assert.match(t, /60% on what I personally did/);
  assert.match(t, /About 150 spoken words/);
});

test('STAR with no qualifying story refuses to invent one', () => {
  const t = answerInstructions(understand('Tell me about a time you handled a conflict'), {}, { settings: S, story: null });
  assert.match(t, /Do not invent or combine stories/);
});

test('situational answers are framed as hypothetical; technical as explanation', () => {
  assert.match(answerInstructions(understand('What would you do if the model kept hallucinating?'), {}, { settings: S }), /hypothetical/);
  assert.match(answerInstructions(understand('How does a vector database work?'), {}, { settings: S }), /3 to 6 short spoken sentences/);
});

test('filler restraint: at most 2 in subtle mode, none for high stakes or non-live', () => {
  assert.match(answerInstructions(understand('Tell me about yourself'), {}, { settings: S }), /at most 2 light discourse markers/);
  assert.match(answerInstructions(understand('What salary are you expecting?'), {}, { settings: S }), /Use no filler words/);
  assert.match(answerInstructions(understand('Tell me about yourself'), {}, { settings: { ...S, mode: 'written' } }), /Use no filler words/);
  assert.match(answerInstructions(understand('Hi there!'), {}, { settings: S }), /one short, natural sentence/);
});

test('env settings override config', () => {
  const s = settingsFrom({ answer: { length: 'short' } }, { ANSWER_LENGTH: 'long', FILLER_INTENSITY: 'none', MAX_FILLERS_PER_ANSWER: '0', SHOW_STAR_LABELS: 'true' });
  assert.equal(s.length, 'long');
  assert.equal(s.fillerIntensity, 'none');
  assert.equal(s.maxFillers, 0);
  assert.equal(s.showStarLabels, true);
});

test('telemetry stores only allow-listed numeric/label fields and hashes turn ids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tel-'));
  const tel = createTelemetry({ dir, now: () => Date.parse('2026-10-14T12:00:00Z') });
  tel.record({ turn: 'them:abc:1', route: 'default', eotToFirstTokenMs: 700, totalMs: 1800, finalUsd: 0.001, question: 'SECRET QUESTION', answer: 'SECRET ANSWER', validated: true });
  tel.record({ turn: 'them:abc:2', route: 'default', eotToFirstTokenMs: 1300, totalMs: 2500, finalUsd: 0.002, validated: false, regenerated: true });
  return new Promise((r) => setTimeout(r, 50)).then(() => {
    const raw = fs.readFileSync(path.join(dir, '2026-10-14.jsonl'), 'utf8');
    assert.ok(!raw.includes('SECRET'));
    assert.ok(!raw.includes('them:abc:1'));
    const s = summarize(tel.rows());
    assert.equal(s.turns, 2);
    assert.equal(s.firstToken.p50, 700);
    assert.equal(s.firstToken.p95, 1300);
    assert.equal(s.unsupportedRate, 0.5);
    assert.equal(s.regenerated, 1);
    assert.ok(Math.abs(s.costPerTurnUsd - 0.0015) < 1e-12);
  });
});

test('percentile', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([], 95), null);
});

const { limitFillers, polish } = require('../src/main/render');

test('filler limiter keeps at most N clause-opening markers in SAY only', () => {
  const t = limitFillers('SAY: Yeah—my strength is data. So I built a tool. So, it helped. Honestly, it was fun.\nPOINTS:\n- So many things', 2);
  assert.equal(t, 'SAY: Yeah—my strength is data. So I built a tool. It helped. It was fun.\nPOINTS:\n- So many things');
  assert.equal(limitFillers('SAY: So I trained it—so I moved to HPC.', 1), 'SAY: So I trained it—I moved to HPC.');
  assert.equal(polish('SAY: Honestly, the range is flexible.', S, { stakes: 'high' }), 'SAY: The range is flexible.', 'no fillers in high-stakes answers');
});

test('telemetry retention prunes daily files older than the window', () => {
  const { prune } = require('../src/main/telemetry');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tel-ret-'));
  for (const d of ['2026-08-01', '2026-10-01', '2026-10-14']) fs.writeFileSync(path.join(dir, `${d}.jsonl`), '{}\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
  assert.equal(prune(dir, 30, () => Date.parse('2026-10-14T12:00:00Z')), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-10-01.jsonl', '2026-10-14.jsonl', 'notes.txt']);
});
