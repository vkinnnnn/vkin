# Demo video script (target 2:50, hard limit 3:00)

**Goal:** show the full Vkin loop in one take-able flow, and make clear where NVIDIA Nemotron and Nebius
Token Factory do the work.

## Before recording (checklist)

- [ ] The hosted API, Supabase project and web dashboard are live, and the desktop `.env` has
      `VKIN_API_URL=<your-render-url>`, `VKIN_SUPABASE_URL` and `VKIN_SUPABASE_ANON_KEY`. If the hosted
      API is not live yet, record in developer mode and **do not** show or mention the trial minutes
      (skip step 2 and the minutes card in step 9, and say "developer mode" on screen).
- [ ] A fresh test account that has never used the trial (so the dashboard shows 10:00 remaining).
- [ ] The other participant is a teammate or friend who **knows and agrees** that the call is a recorded
      Vkin demo. Say so on camera at the start of the call segment.
- [ ] Start the desktop app with `COPILOT_VISIBLE=1` so the overlay appears in the screen recording
      (it is hidden from screen capture by default). Mention this in the voice-over.
- [ ] One copilot ready, for example **"Mock technical interview"**, with a short purpose and a few
      profile facts you are happy to show publicly. No real personal data on screen.
- [ ] A coding question visible in the Meet window or a shared doc for the screenshot step (e.g. a
      two-part array problem).
- [ ] Browser zoom at 110%, notifications off, a clean desktop, headphones on.

## Shot list and voice-over

| # | Time | Shot | On screen | Voice-over (what to say) |
|---|---|---|---|---|
| 0 | 0:00–0:12 | Title card over the landing page | "Vkin — The Meeting Copilot · NVIDIA Nemotron on Nebius Token Factory" | "Vkin is a real-time copilot for live conversations. It suggests grounded answers while you talk, and remembers only what you approve." |
| 1 | 0:12–0:27 | Web: sign in | Landing → Sign in → email code → dashboard | "I sign in on the web with a one-time email code. Accounts and memory live in Supabase, with row-level security on every table." |
| 2 | 0:27–0:37 | Web: trial granted | Dashboard card showing 10 minutes of trial time | "A new account gets a ten-minute trial of active copilot time. The server meters it by database time, not by anything the app reports." |
| 3 | 0:37–0:50 | Desktop: sign in | Open Vkin → Copilots & memory → sign in with code → pick the "Mock technical interview" copilot and a new thread | "On the Windows app I sign in with the same account and pick a copilot. A copilot is a workspace: purpose, instructions and memory scope." |
| 4 | 0:50–1:02 | Start in Google Meet | Meet call with the consenting teammate; press Start; overlay appears with "Listening" | "This is a consensual demo call. When I press Start, Vkin captures my mic and the call audio separately and streams both to Deepgram for transcription." |
| 5 | 1:02–1:30 | Conversational question | Teammate: "How are you doing today?" (short reply) then "Tell me about a project you're proud of." Overlay streams an answer; briefly click **Deeper answer** | "Small talk gets a short reply with no profile lookup. A real question is answered from my own evidence by **Nemotron-3.5-Lightning on Nebius Token Factory**: first token in about 300 milliseconds in our benchmark. If I want more depth, Deeper answer regenerates with **Nemotron-3-Ultra**." |
| 6 | 1:30–1:52 | Coding follow-up (spoken) | Teammate: "Let's do a coding question. Please use Java, and only do part two." The overlay's live question strip shows the instruction | "Vkin keeps the spoken instructions in order. That matters for the next step." |
| 7 | 1:52–2:15 | Screenshot answer | Press `Ctrl+Alt+S` → preview → "Describe with Gemini" or "Read text" → **Answer with this** → Java code for part two only | "I take one manual screenshot, previewed before anything is sent. The answer is Java and covers only part two, because it follows what was said earlier. Every answer, including code, goes through a validator that blocks claims my evidence doesn't support." |
| 8 | 2:15–2:35 | End and approve memory | Press End → memory draft (a decision, an action item) → edit one word → Approve | "When the meeting ends, Vkin drafts memory from what was actually said. Nothing is kept until I approve it, and only approved memory is used next time, only in this copilot." |
| 9 | 2:35–2:52 | Web: thread and minutes | Dashboard → copilot → thread with the session and approved memory; minutes card shows the remaining time | "Back on the web, the thread shows the session and the approved memory, and the minutes card shows what is left of the trial." |
| 10 | 2:52–3:00 | Closing card | "Apache 2.0 · github repo link · Built with NVIDIA Nemotron + Nebius Token Factory" | "Vkin: fast enough for a live call, grounded in your own evidence. Built on NVIDIA Nemotron and Nebius Token Factory." |

## Lines about Nemotron and Token Factory (use as written; all are measured or factual)

- "Every answer comes from NVIDIA Nemotron through Nebius Token Factory's OpenAI-compatible API."
- "In a same-run benchmark of 23 grounded questions, Lightning matched Ultra's grounding and answered about
  three times faster, at about one fourteenth of the cost per answer, so Lightning is the default and
  Ultra is the Deeper answer button."
- "Thinking is turned off for live answers so the first words arrive fast."

## Do not say or show

- Any claim of end-to-end encryption, languages other than English, macOS support, or paid plans (paid
  minutes are "coming soon").
- Real names, e-mail addresses, API keys, the `.env` file, or the Supabase/Render dashboards with keys.
- Any suggestion of using Vkin without the other participants' knowledge.

## Fallbacks during recording

- If an answer is slow or blocked by the validator, keep rolling and say "the validator caught an
  unsupported claim and regenerated"; it is a feature.
- If the hosted trial cannot start (409 "already live on another device"), stop the other session first;
  if minutes run out, use a second fresh test account.
