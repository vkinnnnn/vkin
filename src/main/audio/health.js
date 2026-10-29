// @ts-check
'use strict';
// Device-health monitor for the two audio channels (PRD Phase 2). Pure and clock-injected so it is
// fully testable without audio hardware. It never inspects audio content beyond the RMS level the
// capture layer already computes, and it keeps O(1) state per channel (no growth over a long call).
//
// States per channel:
//   stopped  - not capturing
//   starting - capture requested, no frame yet
//   ok       - frames arriving, signal present recently
//   silent   - frames arriving but level below the floor for silentAfterMs (muted mic, nothing playing)
//   stalled  - no frame for stallAfterMs while capturing (device gone, driver hang)
//   error    - capture reported an error

const DEFAULTS = Object.freeze({
  stallAfterMs: 2000,
  silentAfterMs: 15000,
  silenceLevel: 0.002, // RMS; about -54 dBFS
  gapMs: 400, // an inter-frame gap above this counts as a dropout (80 ms frames)
});

/**
 * @typedef {'stopped'|'starting'|'ok'|'silent'|'stalled'|'error'} HealthState
 * @typedef {{ state: HealthState, frames: number, dropouts: number, level: number, lastFrameAt: number,
 *   lastSignalAt: number, startedAt: number, error: string, source: string }} ChannelHealth
 */

/**
 * @param {{ channels?: string[], now?: () => number, onChange?: (channel: string, h: ChannelHealth) => void,
 *   options?: Partial<typeof DEFAULTS> }} [deps]
 */
function createHealthMonitor(deps = {}) {
  const now = deps.now || (() => Date.now());
  const opts = { ...DEFAULTS, ...(deps.options || {}) };
  const channels = deps.channels || ['them', 'me'];
  /** @type {Record<string, ChannelHealth>} */
  const ch = {};
  for (const c of channels) ch[c] = fresh('stopped', '');

  /** @returns {ChannelHealth} */
  function fresh(state, source) {
    return { state, frames: 0, dropouts: 0, level: 0, lastFrameAt: 0, lastSignalAt: 0, startedAt: 0, error: '', source };
  }

  function set(c, state, error = '') {
    const h = ch[c];
    if (!h || (h.state === state && h.error === error)) return;
    h.state = state;
    h.error = error;
    if (deps.onChange) deps.onChange(c, { ...h });
  }

  return {
    /** Capture requested for a channel from a given source ('native' | 'renderer'). */
    start(c, source) {
      if (!ch[c]) return;
      const t = now();
      ch[c] = { ...fresh('stopped', source), startedAt: t };
      set(c, 'starting');
    },
    stop(c) {
      if (!ch[c]) return;
      ch[c] = fresh(ch[c].state, '');
      set(c, 'stopped');
    },
    error(c, message) {
      if (ch[c]) set(c, 'error', String(message || 'error'));
    },
    /** One captured frame. level is RMS 0..1. */
    frame(c, level) {
      const h = ch[c];
      if (!h || h.state === 'stopped' || h.state === 'error') return;
      const t = now();
      if (h.lastFrameAt && t - h.lastFrameAt > opts.gapMs) h.dropouts += 1;
      h.lastFrameAt = t;
      h.frames += 1;
      h.level = h.level * 0.8 + (Number(level) || 0) * 0.2;
      if ((Number(level) || 0) >= opts.silenceLevel) h.lastSignalAt = t;
      if (h.state === 'starting' || h.state === 'stalled') set(c, 'ok');
    },
    /** Re-evaluate time-based states; call every ~500 ms. Returns channels that are stalled. */
    tick() {
      const t = now();
      const stalled = [];
      for (const c of channels) {
        const h = ch[c];
        if (h.state === 'stopped' || h.state === 'error') continue;
        const since = h.lastFrameAt || h.startedAt;
        if (since && t - since > opts.stallAfterMs) {
          set(c, 'stalled');
          stalled.push(c);
          continue;
        }
        if (h.state === 'starting') continue;
        const quietFor = t - (h.lastSignalAt || h.startedAt);
        set(c, quietFor > opts.silentAfterMs ? 'silent' : 'ok');
      }
      return stalled;
    },
    /** Snapshot for status/UI (numbers only, no audio). */
    snapshot() {
      /** @type {Record<string, { state: HealthState, source: string, frames: number, dropouts: number, level: number, error: string }>} */
      const out = {};
      for (const c of channels) {
        const h = ch[c];
        out[c] = { state: h.state, source: h.source, frames: h.frames, dropouts: h.dropouts, level: Math.round(h.level * 1000) / 1000, error: h.error };
      }
      return out;
    },
  };
}

module.exports = { createHealthMonitor, HEALTH_DEFAULTS: DEFAULTS };
