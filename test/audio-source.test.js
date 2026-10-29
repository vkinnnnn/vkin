'use strict';
// Phase 2 audio source + device health. A fake addon and fake timers stand in for the hardware, so
// these run anywhere; the real addon is exercised by scripts/audio-probe.js on a Windows machine.
const test = require('node:test');
const assert = require('node:assert');
const { createAudioSource } = require('../src/main/audio/audio-source');
const { createHealthMonitor } = require('../src/main/audio/health');
const { loadNativeAudio } = require('../src/main/audio/native-loader');

function fakeTimers() {
  let t = 1000; // real clocks are never 0
  let id = 0;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => { id += 1; timeouts.set(id, { fn, at: t + ms }); return id; },
      clearTimeout: (h) => { timeouts.delete(h); },
      setInterval: (fn, ms) => { id += 1; intervals.set(id, { fn, ms, next: t + ms }); return id; },
      clearInterval: (h) => { intervals.delete(h); },
    },
    advance(ms) {
      const end = t + ms;
      while (t < end) {
        t = Math.min(end, t + 50);
        for (const [h, v] of [...timeouts]) if (v.at <= t) { timeouts.delete(h); v.fn(); }
        for (const v of intervals.values()) while (v.next <= t) { v.next += v.ms; v.fn(); }
      }
    },
  };
}

function fakeAddon({ failStart = 0 } = {}) {
  const a = {
    starts: 0,
    stops: 0,
    failStart,
    running: false,
    onFrame: null,
    onEvent: null,
    lastOptions: null,
    available: () => true,
    start(opts, onFrame, onEvent) {
      a.starts += 1;
      if (a.failStart > 0) { a.failStart -= 1; throw new Error('DSP init failed (0x80070005)'); }
      a.running = true;
      a.lastOptions = opts;
      a.onFrame = onFrame;
      a.onEvent = onEvent;
      return true;
    },
    stop() { a.stops += 1; a.running = false; },
    frame(channel, level = 0.1) { a.onFrame({ channel, pcm: Buffer.alloc(2560), level, tsMs: 0, seq: 0 }); },
    event(type, channel, detail) { a.onEvent({ type, channel, detail }); },
  };
  return a;
}

function setup({ mode = 'native', addon = fakeAddon(), addonError = '' } = {}) {
  const clock = fakeTimers();
  const frames = [];
  const statuses = [];
  const renderer = { starts: [], stops: [], start: (c) => renderer.starts.push([...c]), stop: (c) => renderer.stops.push([...c]) };
  const src = createAudioSource({
    mode, addon, addonError, renderer,
    nativeOptions: { aec: true },
    onFrame: (channel, pcm, level) => frames.push({ channel, bytes: pcm.length, level }),
    onStatus: (s) => statuses.push(s),
    now: clock.now,
    timers: clock.timers,
  });
  return { src, addon, renderer, frames, statuses, clock };
}

test('native mode: starts the addon with echo cancellation and routes them/me frames', () => {
  const { src, addon, frames, renderer } = setup();
  const s = src.start();
  assert.equal(s.source, 'native');
  assert.equal(s.aec, true);
  assert.equal(addon.lastOptions.aec, true);
  assert.equal(addon.lastOptions.meRaw, false, 'raw mic is never routed to STT');
  addon.frame('them');
  addon.frame('me');
  addon.frame('meRaw');
  assert.deepEqual(frames.map((f) => f.channel), ['them', 'me']);
  assert.equal(renderer.starts.length, 0, 'renderer capture untouched while native works');
});

test('renderer mode never touches the addon', () => {
  const { src, addon, renderer } = setup({ mode: 'renderer' });
  assert.equal(src.start().source, 'renderer');
  assert.equal(addon.starts, 0);
  assert.deepEqual(renderer.starts, [['them', 'me']]);
});

test('missing addon falls back to the renderer with the reason', () => {
  const { src, renderer } = setup({ addon: null, addonError: 'native audio addon not built' });
  const s = src.start();
  assert.equal(s.source, 'renderer');
  assert.match(s.fallbackReason, /not built/);
  assert.equal(renderer.starts.length, 1);
});

test('native start failure falls back to the renderer (safe fallback)', () => {
  const { src, renderer } = setup({ addon: fakeAddon({ failStart: 1 }) });
  const s = src.start();
  assert.equal(s.source, 'renderer');
  assert.match(s.fallbackReason, /native start failed: DSP init failed/);
  assert.deepEqual(renderer.starts, [['them', 'me']]);
});

test('native runtime error (device unplugged) stops native and falls back mid-session', () => {
  const { src, addon, renderer, frames } = setup();
  src.start();
  addon.frame('me');
  addon.event('error', 'me', 'device-invalidated');
  assert.equal(src.status().source, 'renderer');
  assert.equal(addon.stops, 1);
  assert.equal(renderer.starts.length, 1);
  // late native frames after fallback are ignored; renderer frames now flow
  addon.frame('me');
  assert.equal(src.rendererFrame('me', Buffer.alloc(2560), 0.2), true);
  assert.deepEqual(frames.map((f) => f.channel), ['me', 'me']);
});

test('renderer frames are ignored while native is the source (no double audio)', () => {
  const { src, frames } = setup();
  src.start();
  assert.equal(src.rendererFrame('them', Buffer.alloc(2560), 0.1), false);
  assert.equal(frames.length, 0);
});

test('default-device change restarts native capture after a debounce (hot switching)', () => {
  const { src, addon, clock } = setup();
  src.start();
  addon.event('device', 'me', 'default-changed');
  addon.event('device', 'me', 'default-changed');
  assert.equal(addon.starts, 1, 'debounced');
  clock.advance(700);
  assert.equal(addon.starts, 2);
  assert.equal(addon.stops, 1);
  assert.equal(src.status().source, 'native');
  assert.equal(src.status().restarts, 1);
});

test('restart failure after a device change falls back to the renderer', () => {
  const { src, addon, renderer, clock } = setup();
  src.start();
  addon.failStart = 1;
  addon.event('device', 'them', 'default-changed');
  clock.advance(700);
  assert.equal(src.status().source, 'renderer');
  assert.match(src.status().fallbackReason, /restart failed/);
  assert.equal(renderer.starts.length, 1);
});

test('a stalled native channel is restarted; repeated stalls fall back', () => {
  const { src, addon, renderer, clock } = setup();
  src.start();
  addon.frame('them');
  addon.frame('me');
  // no frames at all: each stall (>2 s) restarts, until the restart budget (3) is spent
  clock.advance(12000);
  assert.equal(src.status().source, 'renderer');
  assert.match(src.status().fallbackReason, /restarted 3 times/);
  assert.equal(addon.starts, 4);
  assert.equal(renderer.starts.length, 1);
});

test('without the keep-alive stream an idle loopback is not treated as a stall', () => {
  const { src, addon, clock } = setup();
  src.start();
  addon.event('warning', 'them', 'silent keep-alive render stream failed (0x88890004)');
  for (let i = 0; i < 40; i += 1) { addon.frame('me'); clock.advance(80); }
  assert.equal(src.status().source, 'native');
  assert.equal(addon.starts, 1);
});

test('stop releases native capture and resets health', () => {
  const { src, addon } = setup();
  src.start();
  src.stop();
  assert.equal(addon.stops, 1);
  const s = src.status();
  assert.equal(s.source, 'none');
  assert.equal(s.health.me.state, 'stopped');
  assert.equal(s.health.them.state, 'stopped');
});

test('health: ok -> silent after sustained quiet -> ok on signal; dropouts counted; bounded state', () => {
  let t = 1000;
  const h = createHealthMonitor({ now: () => t, options: { silentAfterMs: 1000 } });
  h.start('me', 'native');
  assert.equal(h.snapshot().me.state, 'starting');
  h.frame('me', 0.05);
  assert.equal(h.snapshot().me.state, 'ok');
  for (let i = 0; i < 20; i += 1) { t += 80; h.frame('me', 0.0001); }
  h.tick();
  assert.equal(h.snapshot().me.state, 'silent');
  t += 600; // a 600 ms gap is a dropout
  h.frame('me', 0.08);
  h.tick();
  const s = h.snapshot().me;
  assert.equal(s.state, 'ok');
  assert.equal(s.dropouts, 1);
  // 90 minutes of frames: state stays O(1) (no per-frame history kept)
  for (let i = 0; i < 67500; i += 1) { t += 80; h.frame('me', 0.05); }
  assert.equal(Object.keys(h.snapshot().me).length, 6);
  assert.equal(h.snapshot().me.frames, 67522);
});

test('health: stall detected when frames stop; error is sticky until restart', () => {
  let t = 1000;
  const h = createHealthMonitor({ now: () => t });
  h.start('them', 'native');
  h.frame('them', 0.1);
  t += 2500;
  assert.deepEqual(h.tick(), ['them']);
  assert.equal(h.snapshot().them.state, 'stalled');
  h.error('them', 'device-invalidated');
  h.frame('them', 0.1);
  assert.equal(h.snapshot().them.state, 'error');
  h.start('them', 'renderer');
  assert.equal(h.snapshot().them.state, 'starting');
});

test('native loader: non-Windows and missing builds degrade to null with a reason', () => {
  assert.match(loadNativeAudio({ platform: 'darwin' }).error, /Windows-only/);
  assert.match(loadNativeAudio({ platform: 'win32', exists: () => false }).error, /not built/);
  const broken = loadNativeAudio({ platform: 'win32', exists: () => true, requireFn: () => { throw new Error('bad ABI'); } });
  assert.equal(broken.addon, null);
  assert.match(broken.error, /failed to load: bad ABI/);
  const ok = loadNativeAudio({ platform: 'win32', exists: () => true, requireFn: () => ({ available: () => true }) });
  assert.ok(ok.addon);
  assert.equal(ok.error, '');
});

function asyncAddon() {
  const a = fakeAddon();
  a.pending = null;
  a.startAsync = (opts, onFrame, onEvent) => new Promise((resolve, reject) => {
    a.starts += 1;
    a.onFrame = onFrame;
    a.onEvent = onEvent;
    a.pending = { resolve: () => { a.running = true; resolve(true); }, reject: (m) => reject(new Error(m)) };
  });
  return a;
}
const settle = () => new Promise((r) => setImmediate(r));

test('async start: capture starts off the main thread; frames flow once started', async () => {
  const addon = asyncAddon();
  const { src, frames, renderer } = setup({ addon });
  assert.equal(src.start().source, 'native');
  addon.pending.resolve();
  await settle();
  addon.frame('me');
  assert.deepEqual(frames.map((f) => f.channel), ['me']);
  assert.equal(renderer.starts.length, 0);
});

test('async start failure falls back to the renderer with the reason', async () => {
  const addon = asyncAddon();
  const { src, renderer } = setup({ addon });
  src.start();
  addon.pending.reject('DSP ProcessOutput failed (0x80070005)');
  await settle();
  assert.equal(src.status().source, 'renderer');
  assert.match(src.status().fallbackReason, /native start failed: DSP ProcessOutput failed/);
  assert.equal(renderer.starts.length, 1);
});

test('stop while an async start is pending: the late start is stopped again and ignored', async () => {
  const addon = asyncAddon();
  const { src, frames } = setup({ addon });
  src.start();
  src.stop();
  const stopsBefore = addon.stops;
  addon.pending.resolve();
  await settle();
  assert.equal(addon.stops, stopsBefore + 1, 'late start released');
  addon.frame('me');
  assert.equal(frames.length, 0);
  assert.equal(src.status().source, 'none');
});