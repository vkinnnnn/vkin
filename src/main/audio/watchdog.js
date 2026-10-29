// @ts-check
'use strict';
// Meeting watchdog: notices a dead capture, a stalled speech-recognition socket, or a channel that has heard
// nothing for a long time, tells the user, and asks for at most a few bounded recoveries. Electron-free and
// clock-injected: main.js feeds it per channel and calls tick() about once a second. It only ever sees
// levels and timestamps, never audio or transcript text, and it logs and warns with fixed messages only.
//
//   stale audio  capture running but no frame for staleMs           -> warn + recover capture
//   STT stall    audio with signal, but no STT message for sttStallMs -> warn + recover stt (reconnect)
//   silence      RMS below silenceRms for silenceMs (them 30 s, me 60 s) -> warn only
//
// Recovery is bounded: one per channel per recoveryCooldownMs and maxRecoveriesPerSession per session. When a
// recoverable condition persists and the budget is spent, the warning becomes "recovery exhausted".

const CHANNELS = ['them', 'me'];

const DEFAULTS = Object.freeze({
  staleMs: 5000,
  sttStallMs: 15000,
  silenceMs: Object.freeze({ them: 30000, me: 60000 }),
  silenceRms: 0.002, // the same floor as audio/health.js (about -54 dBFS)
  recoveryCooldownMs: 60000,
  maxRecoveriesPerSession: 3,
});

const NAME = { them: 'meeting audio', me: 'microphone' };

/** Fixed warning texts, by condition. */
const MESSAGES = Object.freeze({
  audio_stale: (ch) => `No ${NAME[ch]} frames for a few seconds; restarting capture.`,
  stt_stall: (ch) => `Speech recognition for ${NAME[ch]} has gone quiet; reconnecting.`,
  silence: (ch) => (ch === 'them' ? 'No meeting audio heard — check the output device.' : 'No microphone audio heard — check the microphone.'),
  recovery_exhausted: () => 'Recovery exhausted, check devices.',
});

/**
 * @typedef {'audio_stale'|'stt_stall'|'silence'|'recovery_exhausted'} WarnCode
 * @typedef {{ channel: string, code: WarnCode, message: string }} Warning
 * @typedef {{ channel: string, kind: 'capture'|'stt', reason: WarnCode }} RecoverRequest
 * @param {{
 *   now?: () => number,
 *   onWarn?: (w: Warning) => void,
 *   onRecover?: (r: RecoverRequest) => void,
 *   onClear?: (c: { channel: string, code: WarnCode }) => void,
 *   config?: Partial<typeof DEFAULTS> & { silenceMs?: Partial<Record<string, number>> },
 * }} [deps]
 */
function createWatchdog(deps = {}) {
  const now = deps.now || (() => Date.now());
  const cfg = { ...DEFAULTS, ...(deps.config || {}), silenceMs: { ...DEFAULTS.silenceMs, ...((deps.config && deps.config.silenceMs) || {}) } };
  const noop = () => {};
  const onWarn = deps.onWarn || noop;
  const onRecover = deps.onRecover || noop;
  const onClear = deps.onClear || noop;

  let running = false;
  let sessionRecoveries = 0;
  /** @type {Record<string, { lastFrameAt: number, unansweredSince: number, silentSince: number, lastRecoveryAt: number, active: Set<WarnCode> }>} */
  const ch = {};
  const fresh = (t) => ({ lastFrameAt: t, unansweredSince: 0, silentSince: 0, lastRecoveryAt: -Infinity, active: new Set() });

  function raise(channel, code) {
    const s = ch[channel];
    if (s.active.has(code)) return;
    s.active.add(code);
    onWarn({ channel, code, message: MESSAGES[code](channel) });
  }
  function drop(channel, code) {
    const s = ch[channel];
    if (!s.active.delete(code)) return;
    onClear({ channel, code });
  }
  const canRecover = (s, t) => sessionRecoveries < cfg.maxRecoveriesPerSession && t - s.lastRecoveryAt >= cfg.recoveryCooldownMs;

  function recover(channel, kind, reason, t) {
    const s = ch[channel];
    s.lastRecoveryAt = t;
    sessionRecoveries += 1;
    try { onRecover({ channel, kind, reason }); } catch { /* a failing recovery must not stop the watchdog */ }
  }

  return {
    CHANNELS,
    config: cfg,
    /** Capture and speech recognition are running: begin watching. A new session gets a fresh recovery budget. */
    start() {
      const t = now();
      running = true;
      sessionRecoveries = 0;
      for (const c of CHANNELS) ch[c] = fresh(t);
    },
    /** Stops watching. Warnings still showing are cleared, so the overlay does not keep a stale notice. */
    stop() {
      if (!running) return;
      running = false;
      for (const c of CHANNELS) for (const code of [...ch[c].active]) drop(c, code);
    },
    /** One captured frame; rms is 0..1. */
    frame(channel, rms) {
      if (!running || !ch[channel]) return;
      const s = ch[channel];
      const t = now();
      s.lastFrameAt = t;
      if (Number(rms) >= cfg.silenceRms) {
        s.silentSince = 0;
        // Audio with signal that nobody has answered yet starts the speech-recognition stall clock.
        if (!s.unansweredSince) s.unansweredSince = t;
      } else if (!s.silentSince) s.silentSince = t;
    },
    /** Any message from the speech-recognition socket for this channel (no content is read). */
    sttMessage(channel) {
      if (!running || !ch[channel]) return;
      ch[channel].unansweredSince = 0;
    },
    /** Evaluates every condition; call about once a second. */
    tick() {
      if (!running) return;
      const t = now();
      for (const c of CHANNELS) {
        const s = ch[c];
        const stale = t - s.lastFrameAt >= cfg.staleMs;
        // Frames must be flowing for the other two conditions to mean anything.
        const stall = !stale && s.unansweredSince > 0 && t - s.unansweredSince >= cfg.sttStallMs;
        const silent = !stale && s.silentSince > 0 && t - s.silentSince >= cfg.silenceMs[c];

        if (stale) {
          raise(c, 'audio_stale');
          // Clocks that need frames start over when frames come back.
          s.unansweredSince = 0;
          s.silentSince = 0;
        } else drop(c, 'audio_stale');
        if (stall) raise(c, 'stt_stall'); else drop(c, 'stt_stall');
        if (silent) raise(c, 'silence'); else drop(c, 'silence');

        // A silent channel is only reported. A dead capture or a stalled socket gets one bounded recovery.
        const kind = stale ? 'capture' : stall ? 'stt' : null;
        if (kind) {
          if (canRecover(s, t)) recover(c, kind, stale ? 'audio_stale' : 'stt_stall', t);
          // Exhausted: the session budget is spent and the last attempt on this channel had a full cooldown to work.
          else if (sessionRecoveries >= cfg.maxRecoveriesPerSession && t - s.lastRecoveryAt >= cfg.recoveryCooldownMs) raise(c, 'recovery_exhausted');
        } else drop(c, 'recovery_exhausted');
      }
    },
    /** Active warning codes per channel (for status snapshots and tests). */
    active() {
      return Object.fromEntries(CHANNELS.map((c) => [c, ch[c] ? [...ch[c].active] : []]));
    },
    recoveries: () => sessionRecoveries,
    isRunning: () => running,
  };
}

module.exports = { createWatchdog, DEFAULTS, MESSAGES, CHANNELS };
