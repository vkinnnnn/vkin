// @ts-check
'use strict';
// Chooses where the two audio channels come from and keeps them flowing (PRD Phase 2):
//   native   - the fabel-audio addon: WASAPI loopback (them) + Windows Voice Capture DSP (me,
//              signal-level echo cancellation against the render loopback)
//   renderer - the original capture window (getDisplayMedia loopback + getUserMedia)
// Native is used only when requested (FABEL_NATIVE_AUDIO) and the addon loads. Any native failure
// (start error, runtime error, repeated stalls) falls back to the renderer path for the rest of the
// session, so a broken driver can never leave the meeting without audio. Default-device changes
// restart native capture so it follows the new device (hot switching).
const { createHealthMonitor } = require('./health');

const CHANNELS = Object.freeze(['them', 'me']);
const RESTART_DEBOUNCE_MS = 600;
const TICK_MS = 500;

/**
 * @typedef {{ start: (channels: readonly string[]) => void, stop: (channels: readonly string[]) => void }} RendererCapture
 * @typedef {{ aec?: boolean, ns?: boolean, agc?: boolean }} NativeOptions
 * @typedef {{ source: 'native'|'renderer'|'none', aec: boolean, fallbackReason: string, restarts: number,
 *   health: Record<string, any> }} AudioStatus
 */

/**
 * @param {{
 *   mode: 'native'|'renderer',
 *   addon?: any,
 *   addonError?: string,
 *   nativeOptions?: NativeOptions,
 *   renderer: RendererCapture,
 *   onFrame: (channel: string, pcm: Buffer, level: number) => void,
 *   onStatus?: (s: AudioStatus) => void,
 *   log?: (...args: any[]) => void,
 *   now?: () => number,
 *   timers?: { setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function },
 *   maxRestarts?: number,
 * }} deps
 */
function createAudioSource(deps) {
  const log = deps.log || (() => {});
  const timers = deps.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
  const nativeOpts = { aec: true, ns: false, agc: false, aes: 1, echoLengthMs: 256, ...(deps.nativeOptions || {}) };
  const maxRestarts = deps.maxRestarts == null ? 3 : deps.maxRestarts;
  /** @type {'native'|'renderer'|'none'} */
  let source = 'none';
  let running = false;
  let fallbackReason = '';
  let restarts = 0;
  let keepAliveOk = true;
  let restartTimer = null;
  let tickTimer = null;
  let gen = 0; // a newer start supersedes an older pending one
  let starting = false;
  const health = createHealthMonitor({ channels: [...CHANNELS], now: deps.now, onChange: () => emitStatus() });

  /** @returns {AudioStatus} */
  function status() {
    return { source, aec: source === 'native' && Boolean(nativeOpts.aec), fallbackReason, restarts, health: health.snapshot() };
  }
  function emitStatus() {
    if (deps.onStatus) deps.onStatus(status());
  }

  function onNativeFrame(f) {
    if (!running || source !== 'native' || !f || !CHANNELS.includes(f.channel)) return;
    health.frame(f.channel, f.level);
    deps.onFrame(f.channel, f.pcm, f.level);
  }

  function onNativeEvent(e) {
    if (!e) return;
    if (e.type === 'info') return log('audio native', e.channel, e.detail);
    if (e.type === 'warning') {
      if (String(e.detail).includes('keep-alive')) keepAliveOk = false;
      return log('audio native warning', e.channel, e.detail);
    }
    if (e.type === 'error') return fallBack(`native ${e.channel || 'audio'} error: ${e.detail}`);
    if (e.type === 'device') return scheduleRestart(`device ${e.channel || ''} ${e.detail}`.replace(/\s+/g, ' '));
  }

  /**
   * Starts native capture. With startAsync (current addon) the device/DSP initialisation runs off the
   * main thread: this returns '' at once and a later failure falls back to the renderer. Older addons
   * (and the test fake) start synchronously.
   * @param {string} what 'start' | 'restart' (for the fallback reason)
   * @returns {string} '' when started or starting, else the error message
   */
  function startNative(what = 'start') {
    const opts = {
      them: true, me: true, meRaw: false, keepAlive: true,
      aec: nativeOpts.aec, ns: nativeOpts.ns, agc: nativeOpts.agc, aes: nativeOpts.aes, echoLengthMs: nativeOpts.echoLengthMs,
    };
    if (typeof deps.addon.startAsync === 'function') {
      const g = ++gen;
      starting = true;
      source = 'native';
      for (const c of CHANNELS) health.start(c, 'native');
      deps.addon.startAsync(opts, onNativeFrame, onNativeEvent).then(() => {
        if (g !== gen) return;
        starting = false;
        if (!running || source !== 'native') stopNative(); // stopped or fell back while starting
      }, (err) => {
        if (g !== gen) return;
        starting = false;
        fallBack(`native ${what} failed: ${(err && err.message) || err}`);
      });
      return '';
    }
    try {
      deps.addon.start(opts, onNativeFrame, onNativeEvent);
    } catch (err) {
      return (err && err.message) || String(err);
    }
    source = 'native';
    for (const c of CHANNELS) health.start(c, 'native');
    return '';
  }

  function stopNative() {
    try { deps.addon.stop(); } catch (err) { log('audio native stop error', err && err.message); }
  }

  function startRenderer(reason) {
    source = 'renderer';
    fallbackReason = reason;
    for (const c of CHANNELS) health.start(c, 'renderer');
    deps.renderer.start(CHANNELS);
    emitStatus();
  }

  function fallBack(reason) {
    if (!running || source === 'renderer') return;
    timers.clearTimeout(restartTimer);
    restartTimer = null;
    if (source === 'native') stopNative();
    log('audio: falling back to renderer capture:', reason);
    startRenderer(reason);
  }

  function scheduleRestart(reason) {
    if (!running || source !== 'native') return;
    timers.clearTimeout(restartTimer);
    restartTimer = timers.setTimeout(() => {
      restartTimer = null;
      restartNative(reason);
    }, RESTART_DEBOUNCE_MS);
  }

  function restartNative(reason) {
    if (!running || source !== 'native') return;
    if (starting) return scheduleRestart(reason); // let the pending start finish first
    if (restarts >= maxRestarts) return fallBack(`native restarted ${restarts} times (${reason})`);
    restarts += 1;
    log('audio: restarting native capture:', reason);
    stopNative();
    const err = startNative('restart');
    if (err) fallBack(`native restart failed: ${err}`);
    else emitStatus();
  }

  function tick() {
    if (!running) return;
    // Without the silent keep-alive stream, loopback legitimately goes quiet when nothing plays.
    const stalled = health.tick().filter((c) => keepAliveOk || c !== 'them');
    if (stalled.length && source === 'native' && !starting) restartNative(`stalled: ${stalled.join(',')}`);
  }

  return {
    CHANNELS,
    start() {
      if (running) return status();
      running = true;
      restarts = 0;
      keepAliveOk = true;
      fallbackReason = '';
      if (deps.mode === 'native' && deps.addon) {
        const err = startNative();
        if (err) {
          log('audio: native start failed:', err);
          startRenderer(`native start failed: ${err}`);
        } else {
          log('audio: native capture', nativeOpts.aec ? '(echo cancellation on)' : '(echo cancellation off)');
          emitStatus();
        }
      } else {
        startRenderer(deps.mode === 'native' ? deps.addonError || 'native audio unavailable' : '');
      }
      tickTimer = timers.setInterval(tick, TICK_MS);
      return status();
    },
    stop() {
      if (!running) return;
      running = false;
      timers.clearTimeout(restartTimer);
      timers.clearInterval(tickTimer);
      restartTimer = null;
      tickTimer = null;
      if (source === 'native') stopNative();
      else if (source === 'renderer') deps.renderer.stop(CHANNELS);
      source = 'none';
      for (const c of CHANNELS) health.stop(c);
      emitStatus();
    },
    /** A frame from the renderer capture window; forwarded only while the renderer is the source. */
    rendererFrame(channel, pcm, level) {
      if (!running || source !== 'renderer' || !CHANNELS.includes(channel)) return false;
      health.frame(channel, level);
      deps.onFrame(channel, pcm, level);
      return true;
    },
    /** Status report from the renderer capture window. */
    rendererStatus(channel, state, error) {
      if (source !== 'renderer') return;
      if (state === 'error') health.error(channel, error);
    },
    status,
    // test hook
    _tick: tick,
  };
}

module.exports = { createAudioSource, CHANNELS };
