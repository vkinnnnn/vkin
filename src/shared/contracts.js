// @ts-check
// Shared contracts between main, renderers and the phone mirror.
// LOCKED after Gate 1. Change only with a DECISIONS.md entry.

// ---- Audio (renderer capture -> main) ----------------------------------
// One IPC message per frame. pcm is a 16 kHz mono little-endian Int16 buffer.
// FRAME_MS of audio per frame; Deepgram Flux recommends ~80 ms chunks.
const AUDIO = Object.freeze({
  SAMPLE_RATE: 16000,
  FRAME_MS: 80,
  FRAME_SAMPLES: 1280, // 16000 * 0.080
  CHANNELS: Object.freeze(['them', 'me']),
});

// IPC channel names
const IPC = Object.freeze({
  AUDIO_FRAME: 'audio:frame', // renderer->main  {channel, pcm:ArrayBuffer, level:number}
  CAPTURE_STATUS: 'capture:status', // renderer->main {channel, state:'starting'|'live'|'stopped'|'error', sampleRate, error?}
  CAPTURE_CMD: 'capture:cmd', // main->capture   {cmd:'start'|'stop', channels:['them','me']}
  UI_EVENT: 'ui:event', // main->overlay   any UiEvent below
  UI_CMD: 'ui:cmd', // overlay->main   {cmd, ...args}
});

// ---- STT events (stt.js -> turns.js) -----------------------------------
// Normalised from Deepgram Flux v2 TurnInfo messages.
// {channel, event, turnIndex, transcript, audioStart:number, audioEnd:number, eotConfidence:number}
const STT_EVENTS = Object.freeze(['Update', 'StartOfTurn', 'EagerEndOfTurn', 'TurnResumed', 'EndOfTurn']);

// ---- Turns (turns.js) --------------------------------------------------
// {sessionId, turnId, channel, revision, text, status:'open'|'eager'|'final', startedAt, endedAt}
// turnId = `${channel}:${sessionId}:${turnIndex}`. revision increments on every TurnResumed.
const TURN_STATUS = Object.freeze(['open', 'eager', 'final']);

// ---- Answers (turns.js/llm.js -> overlay + phone) -----------------------
// Every answer event carries {genId, turnId, revision, kind}.
// Displays MUST ignore answer:delta/promote/done whose genId is not their current genId,
// and MUST clear the current card on answer:invalidate for that genId.
// Stale-turn guard (FABEL_STALE_TURN_GUARD, DECISIONS 2026-10-15): when on, every answer event also
// carries `seq`, a number that increases with each new generation (all events of one generation share
// it). Displays MUST drop an answer event whose seq is below the highest seq they have seen. Events
// without a seq (guard off) are handled exactly as before.
const ANSWER_KIND = Object.freeze(['speculative', 'confirmed', 'manual']);
const ANSWER_EVENTS = Object.freeze({
  START: 'answer:start', // {genId, turnId, revision, kind, question}
  DELTA: 'answer:delta', // {genId, text}  (append)
  PROMOTE: 'answer:promote', // {genId}      speculative -> confirmed (undim)
  INVALIDATE: 'answer:invalidate', // {genId, reason}
  DONE: 'answer:done', // {genId, timings:{eotToFirstTokenMs, totalMs}, model}
  ERROR: 'answer:error', // {genId, message}
  VALIDATED: 'answer:validated', // {genId, ok, action:'checked'|'regenerating'|'trimmed', unsupported:[{claim,kind,reason}], warnings, confidence}
  REPLACE: 'answer:replace', // {genId, text}  replace the card text (unsupported sentences removed)
});

// Non-answer UI events
const UI_EVENTS = Object.freeze({
  TRANSCRIPT: 'transcript', // {channel, turnId, text, status}
  STATUS: 'status', // {stt:{them,me}, capture:{them,me}, llm:{provider,model}, mirror:{url?}}
  LEVEL: 'level', // {channel, level}  0..1 RMS, throttled
  WATCHDOG: 'watchdog', // {state:'warn'|'clear', channel, code, message?} audio/transcription health
});

// Event allowed to cross to the phone mirror (allowlist; nothing else is forwarded).
const MIRROR_ALLOWED = Object.freeze(new Set(Object.values(ANSWER_EVENTS)));

let genCounter = 0;
function newGenId() {
  genCounter += 1;
  return `g${Date.now().toString(36)}${genCounter}`;
}

// Monotonic generation sequence for the stale-turn guard. Process-wide; displays live and die with
// this process (the phone mirror's token rotates on restart), so it never needs to survive a restart.
let seqCounter = 0;
function nextSeq() {
  seqCounter += 1;
  return seqCounter;
}

module.exports = {
  AUDIO, IPC, STT_EVENTS, TURN_STATUS, ANSWER_KIND, ANSWER_EVENTS, UI_EVENTS, MIRROR_ALLOWED, newGenId, nextSeq,
};
