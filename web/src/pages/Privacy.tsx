import { useState, type FormEvent } from 'react';
import { Check, ErrorNotice, Loading, Notice, TextField } from '../components/ui';
import { useAuth, useUser } from '../lib/auth';
import {
  DELETE_CONFIRMATION, deleteAccountData, exportAll, exportFilename, getOrCreateProfile, readSettings, updateProfile,
} from '../lib/data';
import { downloadJson } from '../lib/format';
import { useAction, useLoad, usePageTitle } from '../lib/hooks';
import type { Profile } from '../lib/types';

export default function Privacy() {
  usePageTitle('Privacy & data');
  const { client, signOut } = useAuth();
  const user = useUser();
  const { data: profile, error, loading, reload } = useLoad(() => getOrCreateProfile(client, user.id), [client, user.id]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Privacy &amp; data</h1>
          <p>Control what is remembered, take your data with you, or erase it.</p>
        </div>
      </div>
      <DataFlowCard />

      <ErrorNotice error={error} onReload={reload} />
      {loading && !profile ? <Loading what="Loading settings" /> : profile && <Settings key={profile.rev} profile={profile} onChanged={reload} />}

      <ExportCard />

      <section className="card" aria-labelledby="signout-title" style={{ marginTop: '1.5rem' }}>
        <h2 id="signout-title">Sign out</h2>
        <p className="muted">
          Ends your session in this browser and removes the sign-in data and any app preferences this site stored on this device.
        </p>
        <button type="button" className="btn" onClick={() => void signOut()}>Sign out</button>
      </section>

      <DeleteCard />
    </>
  );
}

/** Where live-help data goes. Keep in line with docs/vkin-hosted-api.md. */
export function DataFlowCard() {
  return (
    <section className="card" aria-labelledby="flow-title" style={{ marginBottom: '1.5rem' }}>
      <h2 id="flow-title">Where your meeting data goes</h2>
      <ul className="checklist">
        <li>
          During a live session the Windows desktop app sends meeting audio to the Vkin server, which relays it to Deepgram for live
          transcription.
        </li>
        <li>
          Prompts for answers go through the Vkin server to Nebius Token Factory (NVIDIA Nemotron models). Screenshots for coding
          help go to Google Gemini.
        </li>
        <li>
          The Vkin server does not store transcripts or prompts. It keeps only usage counts (seconds, tokens and cost) to measure
          your trial minutes.
        </li>
        <li>
          Copilots, memory and any transcripts you choose to save are stored in your account in Supabase only when you sign in and
          sync. What you create in this dashboard is stored there too.
        </li>
      </ul>
    </section>
  );
}

function Settings({ profile, onChanged }: { profile: Profile; onChanged: () => void }) {
  const { client } = useAuth();
  const act = useAction();
  const s = readSettings(profile);

  async function set(patch: { memory_enabled?: boolean; save_transcripts_default?: boolean }) {
    const r = await act.run(() => updateProfile(client, profile, { settings: patch }));
    if (r) onChanged();
  }

  return (
    <section className="card" aria-labelledby="settings-title">
      <h2 id="settings-title">Memory and transcripts</h2>
      <ErrorNotice error={act.error} onReload={() => { act.clear(); onChanged(); }} />
      <Check
        label="Memory is on"
        hint="When on, approved memory can be used to answer in later sessions. When off, nothing you approved is used. Your items are kept and can still be edited or forgotten."
        checked={s.memory_enabled} disabled={act.busy} onChange={(v) => void set({ memory_enabled: v })}
      />
      <Check
        label="Save transcripts by default"
        hint="Off by default. When on, new sessions start with “save transcript” selected, so the words spoken in the meeting are stored in your account. When off, sessions keep only the memory you approve and a summary. Turning this off does not delete transcripts that were already saved; deleting a thread does."
        checked={s.save_transcripts_default} disabled={act.busy} onChange={(v) => void set({ save_transcripts_default: v })}
      />
    </section>
  );
}

function ExportCard() {
  const { client } = useAuth();
  const user = useUser();
  const act = useAction();
  const [done, setDone] = useState<string | null>(null);

  return (
    <section className="card" aria-labelledby="export-title" style={{ marginTop: '1.5rem' }}>
      <h2 id="export-title">Export all my data</h2>
      <p className="muted">
        Reads everything stored in your account and saves it as one JSON file on this device. The file is built in your browser and
        is not sent anywhere else. Uploaded document files are not included, only their details.
      </p>
      <ErrorNotice error={act.error} />
      {done && <Notice kind="ok">{done}</Notice>}
      <button
        type="button" className="btn" disabled={act.busy}
        onClick={async () => {
          setDone(null);
          const out = await act.run(() => exportAll(client, { id: user.id, email: user.email }));
          if (out) {
            const name = exportFilename();
            downloadJson(out, name);
            const total = Object.values(out.counts).reduce((a, b) => a + b, 0);
            setDone(`Exported ${total} records to ${name}.`);
          }
        }}
      >
        {act.busy ? 'Reading your data…' : 'Export as JSON'}
      </button>
    </section>
  );
}

function DeleteCard() {
  const { client, signOut } = useAuth();
  const user = useUser();
  const act = useAction();
  const [typed, setTyped] = useState('');

  async function wipe(e: FormEvent) {
    e.preventDefault();
    const ok = await act.run(async () => { await deleteAccountData(client, user.id, typed); return true; });
    if (ok) await signOut({ deleted: true });
  }

  return (
    <section className="card" aria-labelledby="delete-title" style={{ marginTop: '1.5rem', borderColor: 'var(--danger)' }}>
      <h2 id="delete-title">Delete all my data</h2>
      <p>
        Erases your profile, facts, copilots, threads, sessions, memory and saved transcripts from Vkin. This cannot be undone, and
        it is not the same as exporting first: export if you want a copy.
      </p>
      <form onSubmit={wipe}>
        <TextField
          label={`Type ${DELETE_CONFIRMATION} to confirm`} value={typed} onChange={setTyped} autoComplete="off"
        />
        <ErrorNotice error={act.error} />
        <button type="submit" className="btn danger solid" disabled={act.busy || typed.trim() !== DELETE_CONFIRMATION}>
          {act.busy ? 'Deleting…' : 'Delete everything'}
        </button>
      </form>
    </section>
  );
}
