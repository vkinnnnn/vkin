# Vkin — The Meeting Copilot

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Vkin is a real-time AI copilot for live conversations: interviews, supervisor check-ins, client calls and
coding discussions. A Windows desktop app listens to your microphone and the call audio, notices when the
other person has asked you something, and shows a short, grounded suggested answer in a private overlay.
Context is organised as **copilots** (one per purpose, such as "weekly supervisor meeting"), each with
**threads** of **sessions**, and Vkin only remembers what you approve at the end of a meeting.

Built for the **Nebius × NVIDIA Global AI Hackathon** (track: Best Apps and Agents). Answers are generated
by **NVIDIA Nemotron** models served by **Nebius Token Factory**.

> **Status (2026-10-29).** The desktop app, web dashboard, Supabase schema and model routing are
> implemented and covered by mocked tests; the model choice is backed by a live benchmark. The hosted
> backend (`server/`) is being built now, and the Supabase project, web hosting and backend hosting are
> **not deployed yet**. Placeholders like `<your-render-url>` mark values you supply. The Windows
> installer is unsigned.

---

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [How NVIDIA Nemotron and Nebius Token Factory are used](#how-nvidia-nemotron-and-nebius-token-factory-are-used)
- [Other services](#other-services)
- [Setup](#setup)
- [Testing](#testing)
- [Privacy](#privacy)
- [Repository layout](#repository-layout)
- [License](#license)

## What it does

- **Live suggestions.** Two audio channels (your mic = "me", system audio = "them") are transcribed by
  Deepgram Flux with end-of-turn detection. When the other side finishes a question, Vkin streams a
  first-person answer you can glance at.
- **Grounded answers.** Answers are built only from evidence: your profile facts, the copilot's documents,
  and memory you approved. An answer validator blocks restricted or forbidden claims (for example work
  authorisation or pay you have not approved, contact details, claims your profile marks as off-limits)
  and trims facts the evidence does not support.
- **Small talk first.** Greetings and "how are you" are routed before retrieval, so they get a short
  natural reply with no profile evidence and no invented activity.
- **Coding mode.** Press `Ctrl+Alt+S` to take one manual screenshot. Vkin reads it (local Windows OCR, or
  Gemini vision) and answers with fenced code that follows the constraints spoken earlier in the call, in
  the order they were said ("use Java", "only part two").
- **Deeper answer.** One click regenerates the current answer with the larger Nemotron Ultra model.
- **Memory you approve.** At the end of a session Vkin drafts memory items (decisions, action items,
  commitments, open questions) from what was actually said. Nothing is used later until you approve it;
  you can edit, forget or delete any item. Post-call notes are built only from approved items.
- **Web dashboard.** Sign in to manage copilots, threads, memory, profile, privacy settings, export and
  account deletion, from a desktop or a phone browser.
- **Reliability.** An audio watchdog detects silent or stalled capture and speech-to-text, restarts once,
  and tells you in the overlay.

## Architecture

```
                 ┌────────────────────────────────────┐
                 │  Web (Vite + React)                │  landing, sign-in, dashboard
                 │  Cloudflare Pages  [not deployed]  │  copilots, threads, memory, export, delete
                 └───────────────┬────────────────────┘
                                 │ Supabase JS (user JWT, RLS)
                 ┌───────────────▼────────────────────┐
                 │  Supabase                          │  Auth (email code), Postgres + RLS,
                 │  [project not provisioned yet]     │  private storage, entitlements
                 └───────▲───────────────────▲────────┘
            sync (JWT)   │                   │ service role (server only)
┌────────────────────────┴──────┐   ┌────────┴──────────────────────────────────┐
│  Windows desktop (Electron)   │   │  Vkin hosted API (Node 22, server/)       │
│  mic + system audio, AEC      │──▶│  [in progress, target: Render]            │
│  turn detection, overlay      │   │  trial (10 active min), session leases,   │
│  screenshots / coding mode    │   │  spend caps, metering                     │
│  local store, budget guard    │   │   ├─▶ Nebius Token Factory (Nemotron)     │
│  answer validator             │   │   ├─▶ Deepgram Flux (WebSocket relay)     │
└───────────────────────────────┘   │   └─▶ Gemini free tier (screenshots)      │
   developer mode (BYOK): the       └───────────────────────────────────────────┘
   desktop calls the providers
   directly with your own keys
```

**Answer pipeline (desktop):** audio → Deepgram Flux turns → intent (small talk is answered here) →
retrieval over profile facts, copilot documents and approved memory → route (default or deep) → budget
guard admits the call → Nemotron streams the answer → validator (restricted claims, unsupported facts;
regenerate once or trim) → overlay.

## How NVIDIA Nemotron and Nebius Token Factory are used

All text generation goes through Nebius Token Factory's OpenAI-compatible API
(`https://api.tokenfactory.nebius.com/v1/`) using the official `openai` Node SDK with a custom `baseURL`.

| Route (`config.json` → `llm.routes`) | Model | Used for |
|---|---|---|
| `default` and `utility` | `nvidia/Nemotron-3_5-Lightning` | every live answer, refinements, small helpers |
| `deep` | `nvidia/Nemotron-3-Ultra-550b-a55b` | the **Deeper answer** button (regenerate with the larger model) |
| `nebius_fallback` | `Qwen/Qwen3-235B-A22B-Instruct-2507` | fallback when a Nemotron call fails |
| `vision` | `gemini-3.5-flash` (Google, free tier) | describing a manual screenshot |

**Thinking off for latency.** Both Nemotron models are reasoning models. For live answers Vkin sends
`chat_template_kwargs: { enable_thinking: false }`, otherwise the model spends the time budget reasoning
(and, in our early probes, wrote its reasoning as the answer).

**Why Lightning is the default and Ultra is one click away.** Same-run live benchmark on 2026-10-29,
23 grounded-answer questions, identical prompts:

| Model | Grounded answers (raw, before the validator) | First token p50 | Cost per answer |
|---|---|---|---|
| Nemotron-3-Ultra-550b-a55b | 78% | 845 ms | $0.0043 |
| **Nemotron-3.5-Lightning** | 78% | **295 ms** | **$0.0003** |
| Qwen3-30B-A3B (comparison) | 57% | 281 ms | $0.0004 |

Lightning matched Ultra on grounding at about 3× lower latency and about 14× lower cost. It made one
forbidden-claim slip, which the answer validator blocked. In a live call, latency matters most, so
Lightning answers by default and Ultra is reserved for the moments you ask for more depth.

**Grounding validator.** Every answer is checked against the evidence it was given
(`src/main/validate.js`): restricted claims (per profile, from `config.profile.restrictedClaims`),
forbidden categories for everyone (unapproved pay or work authorisation, contact details, internal IDs),
and unsupported numbers or facts. On a failure Vkin regenerates once, then trims. Code fences are checked
too.

**Budget guard (desktop developer mode).** Every billable call is admitted by
`src/main/budget/guard.js` before it is sent, against an append-only JSONL ledger with per-line SHA-256
checksums:

- reservation = (input tokens + max output tokens) × price × 1.2 safety multiplier, settled with the
  provider's reported usage;
- defaults: $40 total, $8 protected reserve, **$32 hard stop**, warnings at $16 / $24 / $28.80,
  400 requests per day, 150 per session;
- an unknown model price, or a price list older than 30 days, means the call is rejected without a request;
- no hedged or parallel model races; live calls are off at startup until you switch them on.

Price list used by the guard (USD per 1M tokens, copied from the Token Factory catalog on 2026-10-14;
`src/main/budget/prices.json`, refresh due by 2026-11-13):

| Model | Input | Output |
|---|---|---|
| `nvidia/Nemotron-3_5-Lightning` | $0.06 | $0.24 |
| `nvidia/Nemotron-3-Ultra-550b-a55b` | $1.00 | $3.00 |
| `Qwen/Qwen3-235B-A22B-Instruct-2507` | $0.20 | $0.60 |

**Hosted mode (in progress).** The hosted API (`server/`, contract in
[`docs/vkin-hosted-api.md`](docs/vkin-hosted-api.md)) keeps the Nebius key on the server, allowlists the
three Nebius models above plus Gemini, clamps `max_tokens`, meters usage from the streamed `usage` chunk
against the same price list, and checks a per-provider spend cap (`NEBIUS_SERVER_CAP_USD`, default $10)
before every upstream call. Over the cap, or with an unknown price, it answers 503 without calling
Nebius.

## Other services

| Service | Role | Notes |
|---|---|---|
| Deepgram Flux (`flux-general-en`) | streaming speech-to-text with end-of-turn detection, two channels | sent with `mip_opt_out=true`; English only |
| Google Gemini (`gemini-3.5-flash`) | screenshot description in coding mode | free tier only; Google may use free-tier prompts to improve its products |
| Supabase | accounts (email one-time code), Postgres with row-level security, private storage, trial entitlements | free tier; not provisioned yet |
| Cloudflare Pages | hosting for the web landing page and dashboard | not deployed yet |
| Render | hosting for the Node API | not deployed yet |

## Setup

### Requirements

- Windows 10 or 11 (the desktop app captures system audio through WASAPI)
- Node.js 22 or later, npm
- Optional, only for the native echo-cancellation addon: Visual Studio Build Tools (C++)

### Desktop app

```powershell
npm ci
Copy-Item .env.example .env      # then edit .env (it is git-ignored)
npm start
```

Choose one of two modes in `.env`:

**Hosted mode** (what end users get). The server holds every provider key and meters the free trial.

```
VKIN_API_URL=<your-render-url>
VKIN_SUPABASE_URL=https://<project-ref>.supabase.co
VKIN_SUPABASE_ANON_KEY=<public anon key>
```

Then open **Copilots & memory** in the app and sign in with the emailed code. Never put a Supabase
`service_role` key in the desktop app; it is rejected.

**Developer mode (bring your own keys).** Leave `VKIN_API_URL` empty (or set `hosted.enabled` to
`false` in `config.json`) and fill in:

```
NEBIUS_API_KEY=<your Token Factory key>
DEEPGRAM_API_KEY=<your Deepgram key>
GEMINI_API_KEY=<optional, free-tier key for screenshots>
```

Live AI calls are off at startup; switch them on per session from the overlay's "AI off" pill. Route
overrides (`NEBIUS_DEFAULT_MODEL`, `NEBIUS_DEEP_MODEL`, …) are documented in `.env.example`.

Optional: `npm run build:native` builds the WASAPI + echo-cancellation addon, enabled with
`FABEL_NATIVE_AUDIO=1` (off by default; the renderer capture path is the fallback). `npm run dist`
builds an unsigned NSIS installer from neutral defaults (`scripts/make-defaults.js`).

Main hotkeys: `Ctrl+Shift+Space` answer now · `Ctrl+Shift+R` regenerate · `Ctrl+Shift+H` show/hide ·
`Ctrl+Shift+K` chat box · `Ctrl+Shift+Left/Right` answer history · `Ctrl+Alt+S` screenshot.

### Hosted API (`server/`, in progress)

```powershell
Set-Location server
npm ci
npm test
npm start
```

Configuration, environment variables and the Render deployment (`server/render.yaml`) are described in
[`server/README.md`](server/README.md). The API contract is [`docs/vkin-hosted-api.md`](docs/vkin-hosted-api.md).
The Supabase service-role key, provider keys, `DEEPGRAM_USD_PER_MIN` (speech-to-text is refused until it
is set), the spend caps and `CORS_ORIGINS` belong only in the hosting dashboard, never in the repo.

### Web dashboard (`web/`)

```powershell
Set-Location web
npm ci
Copy-Item .env.example .env.local   # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, optional VITE_VKIN_API_URL
npm run dev                         # http://localhost:5173
npm run build                       # static site in web/dist (SPA fallback in public/_redirects)
```

Without Supabase values the landing page still works and the signed-in pages show "Not configured yet".
See [`web/README.md`](web/README.md).

### Supabase

1. Create a Supabase project. Enable email sign-in with "Confirm email", and make sure the Magic Link email
   template contains `{{ .Token }}` (the desktop signs in with the 6-digit code).
2. In the SQL editor, run the migrations **in order**:
   1. `supabase/migrations/0001_vkin_init.sql` (profiles, copilots, documents, threads, sessions,
      memory items, transcript lines; RLS forced on every table; composite owner foreign keys; revision and
      tombstone triggers; private `documents` bucket)
   2. `supabase/migrations/0002_vkin_entitlements.sql` (trial entitlements, session leases, usage events;
      service-role-only functions)
3. Run the isolation tests; both roll themselves back:
   - `supabase/tests/isolation.sql` (user A cannot read, change or subscribe to user B's rows or files)
   - `supabase/tests/entitlements.sql`
4. Optional two-account check from Node: create two confirmed test users, put `VKIN_TEST_A_EMAIL`,
   `VKIN_TEST_A_PASSWORD`, `VKIN_TEST_B_EMAIL`, `VKIN_TEST_B_PASSWORD` in `.env`, then run
   `node scripts/vkin-isolation-test.js`.

## Testing

All of these run with mocked providers: no network and no spend.

```powershell
npm run check                       # eslint + tsc (main and renderer) + node --test test/*.test.js
Set-Location web;    npm test; Set-Location ..
Set-Location server; npm test; Set-Location ..
node scripts/eval.js --set <golden.json>   # deterministic prompt/grounding checks for a golden set
```

The eval harness is included, but our golden sets are not: they were built from a real person's profile.
Write your own set in the same format: `items[]` (`id`, `category`, `question`, `expect`) and
`candidates[]` (`id`, `question`, `answer`, `expect_valid`), run against your own profile.
`node scripts/eval.js --live` runs a paid benchmark: it prints the worst-case cost, asks for "yes", and
stops at `--max-usd`.

## Privacy

- **Transcripts are off by default.** Nothing from a call is written to disk unless you turn transcripts
  on; synced transcript lines are only accepted by the database for sessions where you enabled them.
- **Memory only after approval.** Drafts come only from what was actually said (commitments only from
  your own speech) and are never used for answers until you approve them. Forget and delete remove the
  item everywhere; export gives you all your rows as JSON.
- **Isolation.** Every table enforces `user_id = auth.uid()` with row-level security. Approved memory
  belongs to one copilot (one thread by default) and is never used by another copilot.
- **What leaves your computer:** audio goes to Deepgram for transcription, prompts go to Nebius Token
  Factory (and screenshots, only when you choose, to Gemini). In hosted mode they pass through the Vkin
  API, which is designed to log counts only, never prompt or transcript text.
- **No end-to-end encryption claim.** Data synced to Supabase is protected in transit by TLS and in the
  database by row-level security; it is not end-to-end encrypted. The local store is a JSON file in your
  Windows user profile (provider keys you enter in developer mode are kept with Windows DPAPI).
- **Screenshots are manual,** one at a time, previewed before anything is sent. There is no continuous
  screen capture.
- **No disguise features.** No blank or renamed executables, no misleading process names, no reading of
  other windows' titles. The overlay uses Windows content protection so it is left out of screen shares
  and recordings by default; this is a declared setting (`COPILOT_VISIBLE=1` turns it off). Use Vkin only
  where the other participants and the setting allow it.
- Local telemetry is numbers only (latencies, counts), never text.

## Repository layout

| Path | Contents |
|---|---|
| `src/main/` | Electron main process: audio, turns, intent, retrieval, engine, router, validator, LLM gateway, budget guard, Vkin store/sync/auth, hosted client |
| `src/renderer/` | overlay, meeting board and "Copilots & memory" view, audio capture worklet |
| `native/fabel-audio/` | optional Node-API addon: WASAPI loopback + Windows Voice Capture DSP echo cancellation |
| `web/` | landing page and dashboard (Vite, React, TypeScript, Supabase JS) |
| `server/` | hosted API (Node 22, Express, WebSocket relay), in progress |
| `supabase/` | migrations and SQL isolation tests |
| `scripts/` | eval harness, model probe and selection, defaults builder, isolation test, tooling |
| `test/` | `node:test` suite for the desktop app |
| `docs/` | API and data contracts, design notes, [hackathon write-ups](docs/hackathon/) |

## License

Copyright 2026 Chirag Verma. Licensed under the [Apache License, Version 2.0](LICENSE); see
[NOTICE](NOTICE) for third-party notes.
