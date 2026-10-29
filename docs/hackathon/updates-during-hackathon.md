# What changed during the submission period

Vkin existed before the hackathon as a **single-user interview copilot** (working name FABEL), built for
its author's own use. This page separates what already existed from what was built during the
submission period, so the judges can see the new work.

> **Note on history.** The public repository was created from a clean export of approved files, so its git
> history starts at the export and does not show the earlier work. This page is the record of what is
> new. Dates are in EDT.
>
> **Submission period start:** `<confirm the exact start date from the Devpost rules>`. The sections below
> are dated, so the split can be read either way.

## Before the period: what already existed

Built up to 2026-10-23 (last commit before the Vkin work):

- An Electron overlay for Windows that listened to mic and system audio, used Deepgram Flux for
  speech-to-text and end-of-turn detection, and streamed answers.
- Grounded answers from **one person's** profile files, with an answer validator and a local budget guard
  for Nebius Token Factory calls.
- Meeting packs (preparation material per meeting), a meeting board window, a phone mirror on the local
  network.
- A series of engineering phases committed between 2026-10-14 and 2026-10-23: feature flags; a
  "conversation brain" (stale-turn guard, dialogue state; most of it still off by default); an optional
  native audio addon with Windows echo cancellation (off by default); latency timing and model routing;
  manual screen context (local OCR or Gemini vision); encrypted key storage, Electron upgrade, packaging
  and an opt-in updater.

It had no accounts, no multi-user data model, no web app, no hosted service, and its prompts and rules
assumed one specific user.

## During the period: what is new (2026-10-28 to 2026-10-30)

Status values: **implemented** = code plus automated tests with mocked providers; **validated** = checked
against the real service; **in progress** = being built at the time of writing.

| # | Change | Status |
|---|---|---|
| 1 | **Rename to Vkin — The Meeting Copilot** across the desktop UI, tray and installer name, keeping existing users' data folder. | implemented |
| 2 | **De-personalised runtime.** No hardcoded user: prompts use a `{{USER_NAME}}` placeholder, person-specific rules moved into configuration (`config.profile.restrictedClaims`), the engine starts cleanly with no profile, and installers ship neutral defaults with no developer data (`scripts/make-defaults.js`). | implemented; removal of the last built-in legacy defaults in progress |
| 3 | **Copilots → threads → sessions → memory.** A copilot is a workspace (purpose, instructions, answer preferences, restricted claims, key terms); threads continue across sessions; a local per-account store with revisions and tombstones. | implemented |
| 4 | **Memory you approve.** End-of-session drafts built only from real speech (commitments only from the user's own speech), an edit/approve/forget flow, approved memory used as evidence in the next session of the same thread and never by another copilot. | implemented |
| 5 | **Post-call notes** built deterministically from approved memory only (no AI call). | implemented |
| 6 | **Small-talk routing.** Greetings and "how are you" are classified before retrieval and get a short reply with no profile evidence; the chat-box greeting bug was fixed. | implemented |
| 7 | **Coding mode.** Screenshot plus the spoken instructions so far, in time order; answers in fenced code; the validator now checks code fences too. | implemented |
| 8 | **Supabase backend.** Schema for profiles, copilots, documents, threads, sessions, memory and transcript lines; row-level security forced on every table; composite owner foreign keys; revision, tombstone and transcript-consent triggers; delete RPCs; SQL isolation tests and a two-account Node test. | implemented; not yet run on a live project |
| 9 | **Desktop sync and sign-in.** Push/pull sync engine with conflict handling, email one-time-code sign-in with the session encrypted on disk (service-role keys rejected), and adopting data created before sign-in. | implemented; not yet run on a live project |
| 10 | **Web landing page and dashboard** (Vite + React): sign-in, copilots, threads, memory, profile, privacy, export and account deletion; responsive to phone width. | implemented; not yet deployed |
| 11 | **Audio watchdog.** Detects stale capture, stalled speech-to-text and long silence; one automatic recovery with rate limits; overlay warning. | implemented |
| 12 | **Model benchmark and new default.** All configured Nebius models confirmed via the `/models` endpoint; same-run benchmark on 23 grounded-answer questions (Ultra 78% raw grounded, 845 ms p50, $0.0043/answer; Lightning 78%, 295 ms, $0.0003/answer with one validator-blocked slip; Qwen3-30B 57%). **Nemotron-3.5-Lightning** became the default and **Nemotron-3-Ultra** powers "Deeper answer". | validated (live benchmark, $0.159) |
| 13 | **Hosted backend with trial metering** (`server/`, `supabase/migrations/0002_vkin_entitlements.sql`): a 10-minute trial of active copilot time per confirmed account, session leases billed by database time, an allowlisted and metered OpenAI-compatible proxy to Token Factory, a Deepgram relay, per-provider spend caps checked before every upstream call; desktop hosted mode with lease start/heartbeat/stop and minutes left in the overlay. | in progress |
| 14 | **Independent reviews.** Two fresh-context review cycles on the new work; 9 major findings, then 2 major and 2 minor, all fixed with regression tests. | done |
| 15 | **Public release preparation:** Apache 2.0 license, this documentation, and a scripted export that publishes only approved files and scans them for secrets and personal data. | in progress |

## Not done yet (honest list)

- Supabase project, web hosting and the hosted API are not deployed at the time of writing.
- Native echo cancellation has not passed a double-talk test, so it stays off by default.
- The Windows installer is unsigned (Windows SmartScreen will warn).
- Paid minutes are not offered; the dashboard shows them as "coming soon".
