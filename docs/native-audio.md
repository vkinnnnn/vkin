# Native audio + echo cancellation (PRD v2 Phase 2)

Status: built and measured on Windows 11 (Dell laptop, Realtek speakers, Intel SST mic array).
Behind `FABEL_NATIVE_AUDIO` (default **off**). The renderer capture window and the text-overlap echo
filter in `turns.js` are unchanged and remain the fallback (PRD rollback rule).

## What it is

`native/fabel-audio` is a Node-API addon (C++, no third-party code). Node-API is ABI-stable, so one
build loads in Node (probe, tests) and in Electron's main process.

| Stream | Source | Notes |
|---|---|---|
| `them` | WASAPI shared **loopback** of the default render device | mixed to mono, resampled to 16 kHz with the same box filter as `src/shared/pcm.js` |
| `me` | **Windows Voice Capture DSP** (`CLSID_CWMAudioAEC`, `SINGLE_CHANNEL_AEC`) | signal-level AEC using the render loopback as reference; the DSP compensates mic/speaker clock drift internally |
| `meRaw` | raw WASAPI mic | probe/A-B only, never sent to STT |

Also inside the addon: a silent keep-alive render stream (the DSP refuses to run and loopback goes
quiet without an active render stream), an `IMMNotificationClient` for default-device and
device-state changes, per-channel counters (frames, discontinuities, queue drops, delivered-rate ppm
against QPC), and a bounded callback queue (256 frames; overflow is dropped and counted, never grows).

JS side (`src/main/audio/`):
- `native-loader.js` finds/loads the addon; missing/broken/non-Windows is a normal "unavailable".
- `audio-source.js` picks native or renderer, routes frames to Deepgram, restarts native on
  default-device change (600 ms debounce) or stall, and **falls back to the renderer** on start
  failure, runtime error (e.g. `device-invalidated`), failed restart, or more than 3 restarts.
- `health.js` per-channel state `starting/ok/silent/stalled/error/stopped`, dropouts, smoothed level.
  O(1) state; shown in the overlay status-dot tooltip.

## Measured results (scripts/audio-probe.js, laptop speakers, 2026-10-17)

The probe plays TTS through the speakers while capturing all three streams, then transcribes `me`
and `meRaw` with Deepgram Flux (pennies) and counts played words that appear in each transcript.

| DSP setting | raw mic heard | echo-cancelled mic heard |
|---|---|---|
| AES 0 (Windows default) | 22/21 words | **18/21** (AEC alone ~7 dB) |
| AES 1 | 22/21 | **0/21** |
| AES 2 | 22/21 | 0/21 |
| AES 2, echo tail 512 ms | 22/21 | 0/21 |
| AES 2 + noise suppression | 22/21 | 11/21 (NS made it worse) |

Decision: `aes: 1` (least aggressive setting that removed all leaked words, kinder to double-talk),
`ns: false`, `agc: false`, echo tail 256 ms. Config: `config.audio.native`.

End-to-end (Electron, native on, two TTS questions through the speakers): both questions
transcribed on THEM; **zero** ME transcripts (no echo reached STT).

Native clock/latency: frame delivery ~95 ms after the first sample; delivered rate within a few
hundred ppm of 16 kHz on short runs (see the soak for long runs).

## Not yet proven (needs a person at the mic)

| PRD matrix item | Status | How to run |
|---|---|---|
| Speaker-on leakage (1-4) | laptop speakers: PASS (0/21). Headphones / external speakers / loud: not run | `npm run audio:probe -- --stt --brief` per condition |
| Double-talk (7) | **not run** (needs a real voice) | `npm run audio:probe -- --double-talk --brief` and read the sentence at GO |
| Long session (12/13) | **30-min soak PASS** (RSS flat 62-70 MB, drift within +/-5 ppm after settling, 0 queue drops, 11 discontinuities all in the first 8 min). 90-min not run | `npm run audio:probe -- --no-play --seconds 5400 --every 300 --brief` |
| Device disconnect/replace (9/10) | logic unit-tested with a fake addon; not physically exercised | unplug/switch the default device during a session with `FABEL_NATIVE_AUDIO=1 COPILOT_DEBUG=1` |

Until double-talk passes on your hardware, keep `FABEL_NATIVE_AUDIO` off for real meetings.

## Build

Windows needs MSVC (VS 2019/2022 Build Tools, C++ workload) + Python 3; npm's bundled node-gyp does
the rest:

```
npm run build:native
```

## Rollback

`FABEL_NATIVE_AUDIO=false` (or `config.flags.nativeAudio=false`): the app uses the renderer capture
window exactly as before. A failing addon at runtime falls back automatically.
