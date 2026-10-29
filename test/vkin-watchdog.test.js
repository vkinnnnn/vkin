'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWatchdog, DEFAULTS, MESSAGES } = require('../src/main/audio/watchdog');

// Fake clock + recorders. step() advances one second: the listed channels get frames (at the given RMS), the
// listed channels get an STT message, then tick() runs.
function rig(config) {
  let t = 1_000_000;
  const warns = [];
  const recovers = [];
  const clears = [];
  const wd = createWatchdog({
    now: () => t, config,
    onWarn: (w) => warns.push({ ...w, at: t }),
    onRecover: (r) => recovers.push({ ...r, at: t }),
    onClear: (c) => clears.push({ ...c, at: t }),
  });
  const step = ({ frames = {}, stt = [] } = {}) => {
    t += 1000;
    for (const [c, rms] of Object.entries(frames)) wd.frame(c, rms);
    for (const c of stt) wd.sttMessage(c);
    wd.tick();
  };
  const run = (seconds, opts) => { for (let i = 0; i < seconds; i += 1) step(opts); };
  const codes = (list, channel) => list.filter((x) => x.channel === channel).map((x) => x.code);
  return { wd, warns, recovers, clears, step, run, codes, advance: (ms) => { t += ms; }, now: () => t };
}
const LIVE = { them: 0.05, me: 0.05 };

test('defaults are the agreed thresholds', () => {
  assert.equal(DEFAULTS.staleMs, 5000);
  assert.equal(DEFAULTS.sttStallMs, 15000);
  assert.deepEqual({ ...DEFAULTS.silenceMs }, { them: 30000, me: 60000 });
  assert.equal(DEFAULTS.recoveryCooldownMs, 60000);
  assert.equal(DEFAULTS.maxRecoveriesPerSession, 3);
});

test('healthy channels raise nothing', () => {
  const r = rig();
  r.wd.start();
  r.run(120, { frames: LIVE, stt: ['them', 'me'] });
  assert.deepEqual([r.warns, r.recovers, r.clears], [[], [], []]);
});

test('stale audio: warns after 5 s without frames and asks for ONE capture recovery; clears when frames return', () => {
  const r = rig();
  r.wd.start();
  r.run(3, { frames: LIVE, stt: ['them', 'me'] });
  r.run(4, { stt: ['me', 'them'] }); // 4 s of silence from the capture: not stale yet
  assert.equal(r.warns.length, 0);
  r.run(2, { stt: ['me', 'them'] }); // 6 s since the last frame
  assert.deepEqual(r.codes(r.warns, 'them'), ['audio_stale']);
  assert.deepEqual(r.codes(r.warns, 'me'), ['audio_stale']);
  assert.match(r.warns[0].message, /frames/);
  assert.deepEqual(r.recovers.filter((x) => x.channel === 'them').map((x) => [x.kind, x.reason]), [['capture', 'audio_stale']]);
  // Still stale for a long time: the warning is not repeated, and no second recovery inside the cooldown.
  r.run(40, {});
  assert.equal(r.codes(r.warns, 'them').length, 1);
  assert.equal(r.recovers.filter((x) => x.channel === 'them').length, 1);
  // Frames return: the warning clears.
  r.step({ frames: { them: 0.05 } });
  assert.deepEqual(r.codes(r.clears, 'them'), ['audio_stale']);
  assert.deepEqual(r.wd.active(), { them: [], me: ['audio_stale'] });
});

test('STT stall: audio with signal but no STT message for 15 s warns once and asks for one reconnect', () => {
  const r = rig();
  r.wd.start();
  r.run(14, { frames: LIVE });
  assert.equal(r.warns.length, 0);
  r.run(2, { frames: LIVE });
  assert.deepEqual(r.codes(r.warns, 'them'), ['stt_stall']);
  assert.deepEqual(r.recovers.map((x) => [x.channel, x.kind]).sort(), [['me', 'stt'], ['them', 'stt']]);
  r.run(20, { frames: LIVE });
  assert.equal(r.recovers.length, 2, 'no second recovery inside the cooldown');
  // The reconnected socket speaks again: cleared.
  r.step({ frames: LIVE, stt: ['them'] });
  assert.deepEqual(r.codes(r.clears, 'them'), ['stt_stall']);
  assert.deepEqual(r.wd.active().them, []);
});

test('STT stall is not raised by frames that carry no signal (STT has nothing to say about silence)', () => {
  const r = rig();
  r.wd.start();
  r.run(20, { frames: { them: 0.0001, me: 0.0001 } });
  assert.equal(r.recovers.length, 0);
  assert.equal(r.codes(r.warns, 'them').includes('stt_stall'), false);
  // An STT message resets the clock even with signal flowing.
  const q = rig();
  q.wd.start();
  for (let i = 0; i < 40; i += 1) q.step({ frames: LIVE, stt: i % 10 === 0 ? ['them', 'me'] : [] });
  assert.equal(q.warns.length, 0);
});

test('silence: THEM warns after 30 s, ME after 60 s; warn only, no recovery; clears on signal', () => {
  const r = rig();
  r.wd.start();
  const quiet = { them: 0.0005, me: 0.0005 };
  r.run(29, { frames: quiet, stt: ['them', 'me'] });
  assert.equal(r.warns.length, 0);
  r.run(2, { frames: quiet, stt: ['them', 'me'] });
  assert.deepEqual(r.codes(r.warns, 'them'), ['silence']);
  assert.equal(r.warns[0].message, 'No meeting audio heard — check the output device.');
  assert.deepEqual(r.codes(r.warns, 'me'), []);
  r.run(28, { frames: quiet, stt: ['them', 'me'] });
  assert.deepEqual(r.codes(r.warns, 'me'), [])
  r.run(3, { frames: quiet, stt: ['them', 'me'] });
  assert.deepEqual(r.codes(r.warns, 'me'), ['silence']);
  assert.equal(r.recovers.length, 0, 'silence never triggers recovery');
  r.step({ frames: { them: 0.05, me: 0.05 }, stt: ['them', 'me'] });
  assert.deepEqual(r.codes(r.clears, 'them'), ['silence']);
  assert.deepEqual(r.codes(r.clears, 'me'), ['silence']);
});

test('recovery is bounded: one per channel per 60 s, three per session, then "recovery exhausted"', () => {
  const r = rig();
  r.wd.start();
  r.run(3, { frames: LIVE, stt: ['them', 'me'] });
  // THEM capture stays dead for ever; ME stays healthy.
  const dead = { frames: { me: 0.05 }, stt: ['me'] };
  r.run(10, dead);
  assert.equal(r.recovers.length, 1);
  const first = r.recovers[0].at;
  while (r.now() - first < 59000) r.step(dead);
  assert.equal(r.recovers.length, 1, 'still inside 60 s of the first recovery');
  r.run(3, dead);
  assert.equal(r.recovers.length, 2);
  assert.ok(r.recovers[1].at - first >= 60000);
  r.run(61, dead);
  assert.equal(r.recovers.length, 3);
  assert.equal(r.codes(r.warns, 'them').includes('recovery_exhausted'), false, 'the third attempt still has its cooldown to work');
  r.run(61, dead);
  assert.equal(r.recovers.length, 3, 'never more than 3 per session');
  assert.deepEqual(r.codes(r.warns, 'them'), ['audio_stale', 'recovery_exhausted']);
  assert.equal(r.warns.at(-1).message, 'Recovery exhausted, check devices.');
  // It does not repeat, and it clears with the condition.
  r.run(30, dead);
  assert.equal(r.codes(r.warns, 'them').filter((c) => c === 'recovery_exhausted').length, 1);
  r.step({ frames: LIVE, stt: ['them', 'me'] });
  assert.deepEqual(r.codes(r.clears, 'them').sort(), ['audio_stale', 'recovery_exhausted']);
});

test('the session budget is shared by both channels and by both kinds of recovery', () => {
  const r = rig({ recoveryCooldownMs: 10000 });
  r.wd.start();
  r.run(20, { frames: LIVE }); // stt stalls on both channels: 2 recoveries
  assert.equal(r.recovers.length, 2);
  r.run(12, { frames: LIVE }); // cooldown over: one more for the first channel, then the budget is gone
  assert.equal(r.recovers.length, 3);
  r.run(40, { frames: LIVE });
  assert.equal(r.recovers.length, 3);
  assert.ok(r.codes(r.warns, 'them').concat(r.codes(r.warns, 'me')).includes('recovery_exhausted'));
});

test('start() begins a new session with a fresh budget', () => {
  const r = rig({ recoveryCooldownMs: 1000, maxRecoveriesPerSession: 1 });
  r.wd.start();
  r.run(20, { frames: LIVE });
  assert.equal(r.recovers.length, 1, 'a budget of one is spent');
  assert.equal(r.wd.recoveries(), 1);
  r.wd.stop();
  r.wd.start();
  assert.equal(r.wd.recoveries(), 0);
  r.run(20, { frames: LIVE });
  assert.equal(r.recovers.length, 2, 'the new session recovers again');
});

test('stop(): clears showing warnings, then ignores frames, messages and ticks', () => {
  const r = rig();
  r.wd.start();
  r.run(10, {});
  assert.deepEqual(r.wd.active().them, ['audio_stale']);
  const warnsBefore = r.warns.length;
  const recoversBefore = r.recovers.length;
  r.wd.stop();
  assert.deepEqual(r.codes(r.clears, 'them'), ['audio_stale']);
  assert.equal(r.wd.isRunning(), false);
  r.run(200, {});
  r.wd.frame('them', 0.5);
  r.wd.sttMessage('them');
  assert.equal(r.warns.length, warnsBefore);
  assert.equal(r.recovers.length, recoversBefore);
  assert.deepEqual(r.wd.active(), { them: [], me: [] });
  r.wd.stop(); // idempotent
  assert.equal(r.clears.length, 2);
});

test('before start() nothing is watched, and unknown channels are ignored', () => {
  const r = rig();
  r.wd.frame('them', 0.1);
  r.wd.tick();
  r.wd.start();
  r.wd.frame('mic', 0.1);
  r.wd.sttMessage('speaker');
  r.run(10, { frames: LIVE, stt: ['them', 'me'] });
  assert.equal(r.warns.length, 0);
});

test('config overrides the defaults per field', () => {
  const r = rig({ staleMs: 2000, silenceMs: { them: 5000 } });
  r.wd.start();
  r.run(3, { frames: { me: 0.05 }, stt: ['me'] });
  assert.deepEqual(r.codes(r.warns, 'them'), ['audio_stale']);
  const q = rig({ silenceMs: { them: 5000 } });
  q.wd.start();
  q.run(6, { frames: { them: 0, me: 0.05 }, stt: ['them', 'me'] });
  assert.deepEqual(q.codes(q.warns, 'them'), ['silence']);
  assert.equal(q.wd.config.silenceMs.me, 60000, 'the other channel keeps its default');
});

test('warnings carry only a channel, a code and a fixed message; a throwing recovery does not stop the watchdog', () => {
  const r = rig();
  r.wd.start();
  r.run(8, {});
  for (const w of r.warns) {
    assert.deepEqual(Object.keys(w).sort(), ['at', 'channel', 'code', 'message']);
    assert.equal(w.message, MESSAGES[w.code](w.channel));
  }
  for (const rec of r.recovers) assert.deepEqual(Object.keys(rec).sort(), ['at', 'channel', 'kind', 'reason']);
  let t = 0;
  const wd = createWatchdog({ now: () => t, onRecover: () => { throw new Error('boom'); }, onWarn: () => {} });
  wd.start();
  t += 6000;
  assert.doesNotThrow(() => wd.tick());
  assert.equal(wd.recoveries(), 2);
});
