import { useState, type FormEvent } from 'react';
import { Check, ConfirmButton, Empty, ErrorNotice, Loading, Notice, TextArea, TextField } from '../components/ui';
import { useAuth, useUser } from '../lib/auth';
import { createFact, forgetFact, getOrCreateProfile, listFacts, updateFact, updateProfile } from '../lib/data';
import { useAction, useLoad, usePageTitle } from '../lib/hooks';
import type { Profile as ProfileRow, ProfileFact } from '../lib/types';

export default function Profile() {
  usePageTitle('Profile');
  const { client } = useAuth();
  const user = useUser();
  const { data: profile, error, loading, reload } = useLoad(() => getOrCreateProfile(client, user.id), [client, user.id]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Profile</h1>
          <p>What your copilots know about you. You decide what is shared.</p>
        </div>
      </div>
      <ErrorNotice error={error} onReload={reload} />
      {loading && !profile ? <Loading what="Loading profile" /> : profile && (
        <>
          <ProfileForm key={profile.rev} profile={profile} onSaved={reload} onReload={reload} />
          <FactsPanel />
        </>
      )}
    </>
  );
}

function ProfileForm({ profile, onSaved, onReload }: { profile: ProfileRow; onSaved: () => void; onReload: () => void }) {
  const { client } = useAuth();
  const act = useAction();
  const [name, setName] = useState(profile.display_name ?? '');
  const [about, setAbout] = useState(profile.about ?? '');
  const [today, setToday] = useState(profile.today_context ?? '');
  const [saved, setSaved] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const r = await act.run(() => updateProfile(client, profile, { display_name: name, about, today_context: today }));
    if (r) {
      setSaved(true);
      onSaved();
    }
  }

  return (
    <form onSubmit={save} className="card" aria-label="Profile details">
      <TextField label="Display name" value={name} onChange={setName} maxLength={120} autoComplete="name" />
      <TextArea label="About you" value={about} onChange={setAbout} maxLength={20000} tall hint="Background a copilot can draw on when it answers for you." />
      <TextArea
        label="Today's context (optional, private)" value={today} onChange={setToday} maxLength={2000} rows={3}
        hint="Something small about today, like “just back from a trip” or “running late on a release”. It is only used for small talk such as greetings, never for answering real questions. Leave it empty if you prefer."
      />
      {saved && !act.error && <Notice kind="ok">Saved.</Notice>}
      <ErrorNotice error={act.error} onReload={() => { act.clear(); onReload(); }} />
      <button className="btn primary" type="submit" disabled={act.busy}>{act.busy ? 'Saving…' : 'Save profile'}</button>
    </form>
  );
}

function FactsPanel() {
  const { client } = useAuth();
  const { data, error, loading, reload } = useLoad(() => listFacts(client), [client]);
  const act = useAction();
  const [text, setText] = useState('');
  const [share, setShare] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    const r = await act.run(() => createFact(client, { text, shareable: share }));
    if (r) {
      setText('');
      setShare(false);
      reload();
    }
  }

  return (
    <section aria-labelledby="facts-title" style={{ marginTop: '2rem' }}>
      <h2 id="facts-title">Profile facts</h2>
      <p className="muted">
        Short facts about you. A fact is only available to all your copilots when “Share across my copilots” is on, and a copilot
        must also have “Use profile facts” turned on.
      </p>

      <form onSubmit={add} className="card flat" aria-label="Add a fact">
        <TextArea label="New fact" value={text} onChange={setText} maxLength={2000} rows={2} />
        <Check label="Share across my copilots" checked={share} onChange={setShare} />
        <button className="btn primary" type="submit" disabled={act.busy}>Add fact</button>
      </form>

      <div style={{ marginTop: '1rem' }}>
        <ErrorNotice error={act.error ?? error} onReload={() => { act.clear(); reload(); }} />
        {loading && !data ? <Loading what="Loading facts" /> : data && data.length === 0 ? (
          <Empty>No facts yet.</Empty>
        ) : (
          <ul className="list" aria-label="Profile facts">
            {data?.map((f) => <FactCard key={`${f.id}:${f.rev}`} fact={f} onChanged={reload} />)}
          </ul>
        )}
      </div>
    </section>
  );
}

function FactCard({ fact, onChanged }: { fact: ProfileFact; onChanged: () => void }) {
  const { client } = useAuth();
  const act = useAction();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(fact.text);

  return (
    <li>
      <article className="card">
        {editing ? (
          <form onSubmit={async (e) => {
            e.preventDefault();
            const r = await act.run(() => updateFact(client, fact, { text }));
            if (r) { setEditing(false); onChanged(); }
          }}>
            <TextArea label="Fact" value={text} onChange={setText} maxLength={2000} rows={2} />
            <ErrorNotice error={act.error} onReload={onChanged} />
            <div className="row">
              <button className="btn primary small" type="submit" disabled={act.busy}>Save</button>
              <button type="button" className="btn small" onClick={() => { setEditing(false); setText(fact.text); act.clear(); }}>Cancel</button>
            </div>
          </form>
        ) : (
          <>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{fact.text}</p>
            <Check
              label="Share across my copilots" checked={fact.shareable} disabled={act.busy}
              onChange={async (v) => { const r = await act.run(() => updateFact(client, fact, { shareable: v })); if (r) onChanged(); }}
            />
            <ErrorNotice error={act.error} onReload={onChanged} />
            <div className="row">
              <button type="button" className="btn small" onClick={() => setEditing(true)}>Edit</button>
              <ConfirmButton
                label="Forget…" question="Forget this fact? Its text is erased." confirmLabel="Yes, forget" disabled={act.busy}
                onConfirm={async () => { const r = await act.run(() => forgetFact(client, fact)); if (r) onChanged(); }}
              />
            </div>
          </>
        )}
      </article>
    </li>
  );
}
