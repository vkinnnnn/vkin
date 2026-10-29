# Vkin web

Public site and signed-in dashboard for **Vkin — The Meeting Copilot**. Vite + React + TypeScript + `@supabase/supabase-js`. Data rules come from `../docs/vkin-contracts.md`.

## Setup

```powershell
Set-Location C:\PROJECTS\meeting-copilot\web
npm install
Copy-Item .env.example .env.local   # then fill in the two values
npm run dev                         # http://localhost:5173
```

`.env.local` (gitignored) takes only the public values:

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<public anon key>
```

Optional public values for the hosted service: `VITE_VKIN_API_URL` (hosted API base URL; empty hides the trial minutes card), `VITE_GOOGLE_ENABLED=1` (shows "Continue with Google"; enable the Google provider in Supabase first), `VITE_DOWNLOAD_URL` (Windows installer link on the landing page).

Never put a service role key here. Without these values the landing page still works, and `/signin` and `/app/*` show a "Not configured yet" screen.

## Commands

| command | what it does |
|---|---|
| `npm run dev` | dev server |
| `npm run build` | `tsc --noEmit` then production build into `dist/` |
| `npm test` | `vitest run` (data layer, with a fake Supabase client) |
| `npx tsc --noEmit` | type check only |

## What is real

- Landing page (`/`): static, works with no backend. The download section has no link because there is no release yet.
- Everything under `/signin` and `/app/*` calls Supabase for real; there are no mock records. It needs a Supabase project with the contract's tables, RLS, the `vkin_check_rev` trigger, and the functions `vkin_delete_thread(id)` and `vkin_delete_account_data()`.
- Sign-in: email one-time code (`signInWithOtp`, then `verifyOtp` with `type: 'email'`). The magic link comes from the same email if the Supabase email template includes `{{ .ConfirmationURL }}`. Add the site's `/app` URL to the Supabase redirect allow-list.
- Writes: client UUIDs, upsert on create, `rev + 1` on update (a stale write shows "Changed elsewhere, reload" and refetches), reads filter `deleted_at is null`, `user_id` is never sent.
- Export is built in the browser from the user's rows. Sign-out ends the local Supabase session and removes every `vkin.*` and `sb-*` key from localStorage and sessionStorage.

## What is not in the web app

- Live audio help (a browser cannot capture other apps' meeting audio). That is the Windows desktop app.
- Document upload and management (the `documents` table is only cleaned up when a copilot is deleted, and appears in the export as metadata).

## Layout

- `src/lib/data.ts`: the whole data layer, takes a Supabase-shaped client so it is unit-tested with `src/test/fakeSupabase.ts`.
- `src/pages/*`: landing, sign-in, dashboard pages. `src/styles.css`: design tokens, light and dark.

The site is a single-page app; the host must serve `index.html` for unknown paths such as `/signin`.
