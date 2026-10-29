# Vkin hosted API contract (v1)

Owner: main agent. Workers implement this contract exactly; change it only through the main agent.

## Base and auth
- Base URL: `VKIN_API_URL` (desktop env), `VITE_VKIN_API_URL` (web). Example: `https://vkin-api.onrender.com`.
- Every HTTP request and the STT WebSocket upgrade carry `Authorization: Bearer <Supabase access_token>`.
  - The server verifies it with `supabaseAdmin.auth.getUser(token)` and caches the result for at most 60 s per token.
  - A missing, invalid or expired token gives `401 {error:'unauthorized'}`.
- Tokens are **never** sent in URLs or query strings.
- Errors use the JSON shape `{ error: '<code>', message: '<short human text>' }`.
- CORS: allow only the configured web origins (`CORS_ORIGINS`, comma separated). The desktop is not a browser and is unaffected.

## Entitlement model
- One trial per Supabase user: `trial_seconds = 600` of **active copilot time**.
  - It is granted on the first `GET /v1/me` or `POST /v1/sessions/start`.
  - The grant is idempotent: `insert … on conflict do nothing`.
  - It is granted only when the user has a confirmed email (`email_confirmed_at`) or an OAuth identity.
- `remaining = trial_seconds + purchased_seconds - used_seconds`, floored at 0.
- Time counts while a lease is active, including listening. **Server/DB time only.** Nothing the client reports is trusted.

## Leases (one active per user)
- `POST /v1/sessions/start` with body `{ device: string ≤ 80 }`:
  - `201 { leaseId, remainingSeconds, beatEverySec: 15 }`;
  - `402 { error:'no_minutes' }`;
  - `409 { error:'lease_active', message }` when another device or session is active.
- `POST /v1/sessions/:id/beat`:
  - bills `least(db_now - last_beat_at, 30 s)` atomically;
  - returns `200 { remainingSeconds, status: 'active' | 'ended' }`;
  - when remaining reaches 0 the lease ends, the response is `402 { error:'no_minutes' }`, and all of that lease's relays close.
- `POST /v1/sessions/:id/stop`: bills the final interval (same cap), ends the lease, returns `200 { remainingSeconds }`. Used for Pause and End.
- **Sweep** every 15 s: a lease with `last_beat_at` older than 45 s is ended and billed its 45 s window (see "Changes after security review 1"), and its relays close.
- A lease belongs to its user. Another user's lease id gives `404 { error:'not_found' }`.

## GET /v1/me
`200 { userId, email, trialSeconds, purchasedSeconds, usedSeconds, remainingSeconds, activeLease: { id, device, startedAt } | null }`

## POST /v1/chat/completions (OpenAI-compatible; streaming)
- Required header: `X-Vkin-Lease: <leaseId>`. The lease must be active, owned by the user, with remaining > 0.
  - Otherwise: `402 no_minutes`, `409 lease_inactive`, `404 not_found`.
- The body is the OpenAI chat body.
  - `model` must be in the allowlist; otherwise `400 { error:'model_not_allowed' }`.
  - `max_tokens` is clamped to 1200.
  - `stream: true` is supported, and so is non-stream.
  - Unknown top-level fields are dropped, except `chat_template_kwargs`, `reasoning_effort`, `stream_options` and `temperature`.
- **Allowlist and routing:**
  - **Nebius Token Factory:** `nvidia/Nemotron-3_5-Lightning`, `nvidia/Nemotron-3-Ultra-550b-a55b`, `Qwen/Qwen3-235B-A22B-Instruct-2507`.
  - **Gemini (free tier only)**, including image `image_url` data-URL parts for vision: `gemini-3.5-flash`.
- The response is passed through as OpenAI SSE (`data: {...}` chunks, then `data: [DONE]`).
  - The server forces `stream_options.include_usage = true` upstream to meter tokens.
  - It may forward the usage chunk to the client.
- **Metering:** cost = usage × `prices.json` (Nebius per-1M input/output).
  - The record is `usage_events(provider, model, units_in, units_out, cost_usd)`.
  - Gemini cost is 0 and its paid usage is never enabled.
- **Spend caps** are checked before every upstream call:
  - `NEBIUS_SERVER_CAP_USD` (default 10);
  - `DEEPGRAM_SERVER_CAP_USD` (default 10);
  - totals come from summing `usage_events` by provider (cached 30 s), plus in-flight estimates;
  - over the cap gives `503 { error:'capacity', message:'Vkin trial capacity is used up for now. Please try again later.' }` with **no upstream call**;
  - an unknown model price gives `503 { error:'price_unknown' }` with no upstream call.

## WS /v1/stt (Deepgram Flux relay)
- Upgrade URL: `wss://<api>/v1/stt?lease=<leaseId>&channel=me|them&<flux params>`, with `Authorization: Bearer` set as a header.
- Allowed flux params are passed through:
  - `model` (`flux-general-en` only), `encoding` (`linear16`), `sample_rate` (`16000`);
  - `eot_threshold`, `eager_eot_threshold`, `eot_timeout_ms`;
  - `keyterm` (repeatable, at most 50, each at most 100 chars).
  - The server always adds `mip_opt_out=true`. Other params are dropped.
- At most 2 relays per lease (one per channel). A third gives close 4429.
- Binary client frames go upstream as they are. Upstream text messages come back as they are. The server holds `DEEPGRAM_API_KEY`.
- **Metering:** audio seconds = bytes / (16000 × 2), recorded to `usage_events(provider:'deepgram', units_in: seconds, cost_usd)`.
  - The price is `DEEPGRAM_USD_PER_MIN`, which is required. If it is unset, the server refuses STT with close 4503 (unknown price means reject).
- **Close codes:**
  - 4401 unauthorized;
  - 4402 no minutes;
  - 4404 lease not found;
  - 4409 lease ended;
  - 4429 too many relays;
  - 4503 capacity or price unknown.
- When the lease ends (stop, sweep or exhaustion), the server closes both the client and upstream sockets within 1 s.

## Non-goals in v1
- payments (pricing is shown as "coming soon");
- storing transcripts on the server;
- the server never logs prompt or transcript text, only counts.

## Clarifications from implementation (2026-10-29, server v1)
- **Chat:** chat without `X-Vkin-Lease` gives `409 lease_inactive`; a lease id that is not a UUID gives `404 not_found`.
- **Errors:**
  - provider failure gives `502 upstream_error` (with `upstreamStatus`); a mid-stream failure sends one SSE `data: {"error":…}` and ends without `[DONE]`;
  - `503 provider_unavailable` when a key is missing; `503 auth_unavailable` when Supabase auth is unreachable (a bad token is still 401);
  - `400 bad_request` and `413 too_large`.
- **Fields per provider:**
  - `chat_template_kwargs` goes to Nebius only, and Nemotron defaults to `{enable_thinking:false}`;
  - `reasoning_effort` goes to Gemini only;
  - messages keep only `role` and `content`;
  - `image_url` must be a base64 data URL and is allowed for Gemini only.
- **Speech relay (STT):**
  - `model`, `encoding` and `sample_rate` are forced;
  - out-of-range numeric params are dropped; a keyterm over 100 characters is skipped;
  - the client may send the text frames `CloseStream`, `ForceEndTurn` and `KeepAlive`;
  - close codes: bad channel 1008, duplicate channel 4429, auth unavailable 1013;
  - usage is written every 15 s and on close; each open relay reserves 60 s of cost against the cap; all relays close with 4503 when the cap is exceeded.
- **Billing:** whole seconds; `last_beat_at` advances by the seconds billed.
- **Stale leases:**
  - a beat or stop on a stale lease ends it with no charge;
  - `start` ends the same user's stale lease first, so a crash does not block a restart.
- **Trial eligibility:** checked by `vkin_trial_eligible(p_user)`, the **only SECURITY DEFINER** function.
  - It returns a boolean, uses `search_path=''`, and only `service_role` can execute it.
  - It exists because `service_role` cannot read `auth.users` or `auth.identities` under invoker rights.
- **Gemini is free tier only** because the deployed `GEMINI_API_KEY` comes from a Google project without billing; the server cannot enforce this.
## Changes after security review 1 (2026-10-29, server v1.1). These supersede the text above where they differ.
- **Billing:**
  - **Start charges `min(15, remaining)` up front** as prepaid time; the first start returns `remainingSeconds: 585`. Each Pause and Resume therefore costs at least 15 s.
  - **Beats bill `ceil(elapsed)`, up to 45 s**; `last_beat_at` means "billed through".
  - **A stale lease** (no beat for 45 s) is ended and **billed its 45 s window**, by the sweep, the next beat or stop, or the next start.
- **Lease state:** a lease whose last beat is more than 45 s old is reported `ended` immediately, even before the sweep.
- **Ending a lease** (stop, sweep, stale, exhaustion) closes its STT relays **and aborts its in-flight chat streams** and their upstream calls. Long streams re-check the lease every 30 s.
  - A mid-stream end is an SSE `data: {"error":{"code":"lease_inactive",…}}` with no `[DONE]`.
- **Limits:**
  - at most 2 in-flight chat requests per lease, and 30 per minute per user (`429 too_many_requests`);
  - per-user Nebius dollar cap `NEBIUS_USER_CAP_USD`, default 0.50 (`429 user_cap`);
  - Gemini: `GEMINI_DAILY_REQUEST_CAP` 300 server-wide (`503 capacity`) and `GEMINI_USER_DAILY_CAP` 40 per user (`429 user_cap`); one image per request, at most 4 MB; `reasoning_effort: 'high'` gives 400.
  - Bodies at most 1 MB, except a Gemini request with an image (6 MB); Nebius prompts over 400 KB get `413 too_large`.
- **Metering:**
  - input tokens are estimated as UTF-8 bytes (an upper bound);
  - a failed or aborted upstream call is billed as input plus 25% of `max_tokens`;
  - the server does not retry;
  - a failed usage write stays counted and is retried.
- **STT:**
  - the handshake is validated before anything is reserved;
  - audio is limited to 1.25× real time over 5 s (close 1008);
  - the Deepgram cap is checked every 5 s of audio.
- **Trial eligibility:** a confirmed email, or a google or github identity. Phone-only users do not qualify.
- **Deploy:** a single instance is required (`numInstances: 1`), because the relay registry and reservations live in the process.
- **Review 2 (N1):** only calls that may have been billed are charged: 5xx, timeouts, aborts after send, and broken streams. 4xx and connection errors record $0. `NEBIUS_USER_CAP_USD` is **per user per UTC day**. The STT rate window is 15 s.
