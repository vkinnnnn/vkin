# vkin-server

Hosted API for Vkin: trial entitlements, copilot-time leases, a metered OpenAI-compatible chat proxy
(Nebius Token Factory and free-tier Gemini) and a Deepgram Flux WebSocket relay. The contract is
`docs/vkin-hosted-api.md`; the database side is `supabase/migrations/0002_vkin_entitlements.sql`.

## Environment

| Name | Required | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | yes | The server refuses to start without it. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | The server refuses to start without it. Server-side only. |
| `NEBIUS_API_KEY` | for Nebius models | Without it, Nebius models answer `503 provider_unavailable`. |
| `NEBIUS_BASE_URL` | no | Default `https://api.tokenfactory.nebius.com/v1/` |
| `GEMINI_API_KEY` | for `gemini-3.5-flash` | Use a key from a Google Cloud project **with no billing account**. Code cannot stop paid usage on a billed key; Gemini cost is always recorded as 0. |
| `GEMINI_BASE_URL` | no | Default `https://generativelanguage.googleapis.com/v1beta/openai/` |
| `DEEPGRAM_API_KEY` | for STT | |
| `DEEPGRAM_USD_PER_MIN` | for STT | Unset or invalid: every STT upgrade closes with 4503. |
| `NEBIUS_SERVER_CAP_USD` | no | Default 10. |
| `DEEPGRAM_SERVER_CAP_USD` | no | Default 10. |
| `NEBIUS_USER_CAP_USD` | no | Default 0.50. Nebius spend per user per UTC day; over it chat answers `429 user_cap` until the next UTC day. |
| `GEMINI_DAILY_REQUEST_CAP` | no | Default 300. Server-wide Gemini requests per UTC day; over it `503 capacity`. |
| `GEMINI_USER_DAILY_CAP` | no | Default 40. Per-user Gemini requests per UTC day; over it `429 user_cap`. |
| `CORS_ORIGINS` | no | Comma-separated web origins, e.g. `https://vkin.example`. |
| `PORT` | no | Default 8080 (Render sets it). |

Built-in limits: 2 in-flight chat requests per lease and 30 chat requests per minute per user (`429 too_many_requests`); request bodies up to 1 MB (6 MB only for a Gemini request with one image of at most 4 MB); Nebius prompts up to 400 KB; STT audio at most 1.25x real time (averaged over 15 s).

Billing: start charges a 15 s minimum; beats bill every second (ceil, up to 45 s); a lease without a beat for 45 s is ended and billed its 45 s window. Ending a lease closes its STT relays and aborts its chat streams.

Metering: provider-reported usage when present. Without it (aborted call, timeout, 5xx, broken stream) the estimate is input bytes/3 plus the larger of streamed output bytes/3 and 25% of max_tokens. A 4xx or a connection error that never reached the provider is recorded at $0.

The server logs JSON lines with counts only. It never logs keys, tokens, prompts or transcript text.

## Run

```sh
cd server
npm ci
# set the variables above in your shell, then:
npm start
```

Apply `supabase/migrations/0002_vkin_entitlements.sql` first, then run `supabase/tests/entitlements.sql`
in the Supabase SQL editor (it rolls itself back and ends with "ALL CHECKS PASSED").

## Test

```sh
cd server
npm test
```

Tests run offline: an in-memory DB with the same semantics as the SQL functions, fake OpenAI clients and a
fake Deepgram socket. No network, no keys.

## Deploy on Render

1. New > Blueprint, pick the repo, set the Blueprint path to `server/render.yaml`. Keep exactly one instance: relays, in-flight requests, rate limits and reservations are in process memory.
2. Enter the `sync: false` secrets in the dashboard.
3. Deploy, then check `GET /healthz` returns `{"ok":true}`.

A `Dockerfile` (node:22-slim, non-root) is included if you prefer a Docker runtime.
