import { useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Check, ConfirmButton, Empty, ErrorNotice, Loading, Notice, SelectField, TextArea, TextField } from '../components/ui';
import { useAuth, useUser } from '../lib/auth';
import {
  approveMemory, commitmentAllowed, confirmMemory, createMemoryNote, forgetMemory, getOrCreateProfile, getThread,
  listMemory, listSessions, readSettings, updateMemory,
} from '../lib/data';
import { fmtDate, fmtDateTime, fromDateInput, toDateInput } from '../lib/format';
import { useAction, useLoad, usePageTitle } from '../lib/hooks';
import { MEMORY_KINDS, type MemoryItem, type MemoryKind, type MemoryOrigin, type Session } from '../lib/types';

const KIND_LABEL: Record<MemoryKind, string> = {
  topic: 'Topic', decision: 'Decision', open_question: 'Open question', action_item: 'Action item', commitment: 'Commitment', fact: 'Fact',
};
const ORIGIN_LABEL: Record<MemoryOrigin, string> = {
  my_speech: 'My speech', their_speech: 'Their speech', confirmed: 'Confirmed', note: 'Note',
};

export default function ThreadPage() {
  const { copilotId = '', threadId = '' } = useParams();
  const { client } = useAuth();
  const user = useUser();
  const thread = useLoad(() => getThread(client, threadId), [client, threadId]);
  const settings = useLoad(async () => readSettings(await getOrCreateProfile(client, user.id)), [client, user.id]);
  usePageTitle(thread.data?.title || 'Thread');

  const back = <p className="breadcrumb"><Link to={`/app/copilots/${copilotId}`}>← Back to copilot</Link></p>;
  if (thread.loading && !thread.data) return <>{back}<Loading what="Loading thread" /></>;
  if (thread.error) return <>{back}<ErrorNotice error={thread.error} onReload={thread.reload} /></>;
  if (!thread.data) return <>{back}<Notice kind="warn">This thread was not found. It may have been deleted.</Notice></>;

  return (
    <>
      {back}
      <div className="page-head">
        <div>
          <h1>{thread.data.title}</h1>
          <p>{thread.data.status === 'archived' ? 'Archived thread. ' : ''}Sessions and memory for this ongoing conversation.</p>
        </div>
      </div>
      {settings.data && !settings.data.memory_enabled && (
        <Notice kind="warn">
          Memory is turned off in <Link to="/app/privacy">Privacy &amp; data</Link>. You can still review and edit items here, but
          approved memory is not used until you turn it back on.
        </Notice>
      )}
      <SessionsPanel threadId={threadId} />
      <MemoryPanel copilotId={copilotId} threadId={threadId} />
    </>
  );
}

function SessionsPanel({ threadId }: { threadId: string }) {
  const { client } = useAuth();
  const { data, error, loading, reload } = useLoad(() => listSessions(client, threadId), [client, threadId]);
  return (
    <section aria-labelledby="sessions-title" style={{ marginBottom: '2rem' }}>
      <h2 id="sessions-title">Sessions</h2>
      <ErrorNotice error={error} onReload={reload} />
      {loading && !data ? (
        <Loading what="Loading sessions" />
      ) : data && data.length === 0 ? (
        <Empty>No sessions yet. Sessions are recorded when you run a meeting in the Windows desktop app.</Empty>
      ) : (
        <ul className="list" aria-label="Sessions">
          {data?.map((s) => <SessionCard key={s.id} s={s} />)}
        </ul>
      )}
    </section>
  );
}

function SessionCard({ s }: { s: Session }) {
  return (
    <li>
      <article className="card">
        <h3>{fmtDateTime(s.started_at)}</h3>
        <p className="meta-line">
          {s.ended_at ? `Ended ${fmtDateTime(s.ended_at)}` : 'Not marked as ended'} ·{' '}
          {s.save_transcript ? 'Transcript saved for this session' : 'Transcript not saved'}
        </p>
        {s.summary ? <p className="summary" style={{ marginBottom: 0 }}>{s.summary}</p> : <p className="muted" style={{ marginBottom: 0 }}>No approved summary.</p>}
      </article>
    </li>
  );
}

function MemoryPanel({ copilotId, threadId }: { copilotId: string; threadId: string }) {
  const { client } = useAuth();
  const { data, error, loading, reload } = useLoad(() => listMemory(client, threadId), [client, threadId]);
  const act = useAction();
  const [tab, setTab] = useState<'draft' | 'approved'>('draft');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);

  const drafts = useMemo(() => (data ?? []).filter((m) => m.status === 'draft'), [data]);
  const approved = useMemo(() => (data ?? []).filter((m) => m.status === 'approved'), [data]);
  const shown = tab === 'draft' ? drafts : approved;
  const selectedDrafts = drafts.filter((m) => selected.has(m.id));

  function refresh() {
    setSelected(new Set());
    reload();
  }

  async function approveSelected() {
    setMessage(null);
    const res = await act.run(() => approveMemory(client, selectedDrafts));
    if (!res) return;
    const conflict = res.failed.find((f) => f.error.name === 'ConflictError');
    if (conflict) act.setError(conflict.error);
    const others = res.failed.filter((f) => f !== conflict);
    setMessage(
      `${res.approved.length} approved.` +
        (others.length ? ` ${others.length} not approved: ${[...new Set(others.map((f) => f.error.message))].join(' ')}` : ''),
    );
    refresh();
  }

  return (
    <section aria-labelledby="memory-title">
      <h2 id="memory-title">Memory</h2>
      <p className="muted">
        Only approved memory is used to answer. Drafts are shown here so you can edit them first. Forgetting an item clears its text.
      </p>

      <div className="tabs" role="tablist" aria-label="Memory status">
        <button type="button" role="tab" id="tab-draft" aria-selected={tab === 'draft'} aria-controls="memory-list" onClick={() => setTab('draft')}>
          Drafts ({drafts.length})
        </button>
        <button type="button" role="tab" id="tab-approved" aria-selected={tab === 'approved'} aria-controls="memory-list" onClick={() => setTab('approved')}>
          Approved ({approved.length})
        </button>
      </div>

      <ErrorNotice error={act.error ?? error} onReload={() => { act.clear(); refresh(); }} />
      {message && <Notice kind="info">{message}</Notice>}

      {tab === 'draft' && drafts.length > 0 && (
        <div className="row" style={{ marginBottom: '1rem' }}>
          <button
            type="button" className="btn small"
            onClick={() => setSelected(selected.size === drafts.length ? new Set() : new Set(drafts.map((d) => d.id)))}
          >
            {selected.size === drafts.length ? 'Clear selection' : 'Select all drafts'}
          </button>
          <button type="button" className="btn primary small" disabled={act.busy || selectedDrafts.length === 0} onClick={() => void approveSelected()}>
            Approve selected ({selectedDrafts.length})
          </button>
        </div>
      )}

      <div id="memory-list" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {loading && !data ? (
          <Loading what="Loading memory" />
        ) : shown.length === 0 ? (
          <Empty>{tab === 'draft' ? 'No drafts waiting for review.' : 'Nothing approved yet.'}</Empty>
        ) : (
          <ul className="list">
            {shown.map((m) => (
              <MemoryCard
                key={`${m.id}:${m.rev}`}
                item={m}
                selectable={tab === 'draft'}
                selected={selected.has(m.id)}
                onSelect={(on) => setSelected((prev) => { const n = new Set(prev); if (on) n.add(m.id); else n.delete(m.id); return n; })}
                onChanged={refresh}
              />
            ))}
          </ul>
        )}
      </div>

      <AddNote copilotId={copilotId} threadId={threadId} onAdded={() => { setTab('draft'); refresh(); }} />
    </section>
  );
}

function MemoryCard({
  item, selectable, selected, onSelect, onChanged,
}: { item: MemoryItem; selectable: boolean; selected: boolean; onSelect: (on: boolean) => void; onChanged: () => void }) {
  const { client } = useAuth();
  const act = useAction();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const [kind, setKind] = useState<MemoryKind>(item.kind);
  const [due, setDue] = useState(toDateInput(item.due_at));
  const [clearSummary, setClearSummary] = useState(true);
  const canCommit = commitmentAllowed(item.origin);

  const kindOptions = MEMORY_KINDS.map((k) => ({
    value: k,
    label: KIND_LABEL[k] + (k === 'commitment' && !canCommit ? ' (needs my speech or confirmed)' : ''),
  }));

  async function save(e: FormEvent) {
    e.preventDefault();
    const r = await act.run(() => updateMemory(client, item, { text, kind, due_at: due ? fromDateInput(due) : null }));
    if (r) {
      setEditing(false);
      onChanged();
    }
  }

  return (
    <li>
      <article className="card">
        <div className="mem">
          {selectable ? (
            <input
              type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)}
              aria-label={`Select: ${item.text.slice(0, 60)}`} style={{ width: 22, height: 22, marginTop: 4, accentColor: 'var(--accent)' }}
            />
          ) : <span />}
          <div className="body">
            <div className="meta">
              <span className={`badge ${item.origin}`}>{ORIGIN_LABEL[item.origin]}</span>
              <span className="badge kind">{KIND_LABEL[item.kind]}</span>
              {item.source_at && <span>Source: {fmtDate(item.source_at)}</span>}
              {item.due_at && <span>Due: {fmtDate(item.due_at)}</span>}
            </div>

            {editing ? (
              <form onSubmit={save} style={{ marginTop: '0.75rem' }}>
                <TextArea label="Text" value={text} onChange={setText} maxLength={2000} rows={3} />
                <div className="grid-2">
                  <SelectField label="Kind" value={kind} onChange={setKind} options={kindOptions} hint="A commitment must come from something you said or confirmed." />
                  <TextField label="Due date (optional)" type="date" value={due} onChange={setDue} />
                </div>
                <ErrorNotice error={act.error} onReload={onChanged} />
                <div className="row">
                  <button className="btn primary small" type="submit" disabled={act.busy}>Save</button>
                  <button type="button" className="btn small" onClick={() => { setEditing(false); act.clear(); setText(item.text); setKind(item.kind); setDue(toDateInput(item.due_at)); }}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <>
                <p className="text">{item.text}</p>
                <ErrorNotice error={act.error} onReload={onChanged} />
                <div className="row">
                  <button type="button" className="btn small" onClick={() => setEditing(true)}>Edit</button>
                  {(item.origin === 'their_speech' || item.origin === 'note') && (
                    <button
                      type="button" className="btn small" disabled={act.busy}
                      title="Mark this as accurate. Confirmed items can be saved as commitments."
                      onClick={async () => { const r = await act.run(() => confirmMemory(client, item)); if (r) onChanged(); }}
                    >
                      Mark as confirmed
                    </button>
                  )}
                  <ConfirmButton
                    label="Forget…"
                    question="Forget this item? Its text is erased."
                    confirmLabel="Yes, forget"
                    disabled={act.busy}
                    onConfirm={async () => {
                      const r = await act.run(() => forgetMemory(client, item, { clearSessionSummary: clearSummary }));
                      if (r) onChanged();
                    }}
                  />
                </div>
                {item.session_id && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <Check
                      label="When forgetting, also clear that session's summary"
                      hint="The summary may mention this item."
                      checked={clearSummary}
                      onChange={setClearSummary}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </article>
    </li>
  );
}

function AddNote({ copilotId, threadId, onAdded }: { copilotId: string; threadId: string; onAdded: () => void }) {
  const { client } = useAuth();
  const act = useAction();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<MemoryKind>('topic');
  const [due, setDue] = useState('');
  const options = MEMORY_KINDS.filter((k) => k !== 'commitment').map((k) => ({ value: k, label: KIND_LABEL[k] }));

  if (!open) {
    return (
      <p style={{ marginTop: '1.25rem' }}>
        <button type="button" className="btn" onClick={() => setOpen(true)}>Add a note</button>
      </p>
    );
  }
  return (
    <form
      className="card flat" style={{ marginTop: '1.25rem' }} aria-label="Add a note"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await act.run(() => createMemoryNote(client, { copilotId, threadId }, { text, kind, due_at: due ? fromDateInput(due) : null }));
        if (r) { setText(''); setDue(''); setOpen(false); onAdded(); }
      }}
    >
      <h3>Add a note</h3>
      <p className="muted">Notes you write yourself are saved as drafts with the origin “Note”. They only count after you approve them.</p>
      <TextArea label="Note" value={text} onChange={setText} maxLength={2000} rows={3} />
      <div className="grid-2">
        <SelectField label="Kind" value={kind} onChange={setKind} options={options} />
        <TextField label="Due date (optional)" type="date" value={due} onChange={setDue} />
      </div>
      <ErrorNotice error={act.error} />
      <div className="row">
        <button className="btn primary" type="submit" disabled={act.busy}>Save draft</button>
        <button type="button" className="btn" onClick={() => { setOpen(false); act.clear(); }}>Cancel</button>
      </div>
    </form>
  );
}
