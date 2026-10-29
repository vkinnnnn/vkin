import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ConfirmButton, Empty, ErrorNotice, Loading, Notice, TextField } from '../components/ui';
import { useAuth } from '../lib/auth';
import {
  createThread, deleteCopilot, deleteThread, getCopilot, listThreads, setThreadStatus, updateCopilot,
} from '../lib/data';
import { fmtDate } from '../lib/format';
import { useAction, useLoad, usePageTitle } from '../lib/hooks';
import CopilotForm from './CopilotForm';

export default function CopilotDetail() {
  const { copilotId = '' } = useParams();
  const { client } = useAuth();
  const navigate = useNavigate();
  const { data: copilot, error, loading, reload } = useLoad(() => getCopilot(client, copilotId), [client, copilotId]);
  usePageTitle(copilot?.name || 'Copilot');
  const save = useAction();
  const del = useAction();
  const [saved, setSaved] = useState(false);

  if (loading && !copilot) return <Loading what="Loading copilot" />;
  if (error) return <><Breadcrumb /><ErrorNotice error={error} onReload={reload} /></>;
  if (!copilot) {
    return (
      <>
        <Breadcrumb />
        <Notice kind="warn">This copilot was not found. It may have been deleted.</Notice>
      </>
    );
  }

  return (
    <>
      <Breadcrumb />
      <div className="page-head">
        <div>
          <h1>{copilot.name}</h1>
          <p>Edit this copilot, then manage its threads below.</p>
        </div>
      </div>

      <ThreadsPanel copilotId={copilot.id} />

      <section className="card" aria-labelledby="edit-title" style={{ marginTop: '1.5rem' }}>
        <h2 id="edit-title">Settings</h2>
        {saved && !save.error && <Notice kind="ok">Saved.</Notice>}
        <ErrorNotice error={save.error} onReload={() => { save.clear(); setSaved(false); reload(); }} />
        {/* keyed on rev so a reload after a conflict resets the form to the stored values */}
        <CopilotForm
          key={copilot.rev}
          initial={copilot}
          submitLabel="Save changes"
          busy={save.busy}
          onSubmit={async (input) => {
            setSaved(false);
            const next = await save.run(() => updateCopilot(client, copilot, input));
            if (next) {
              setSaved(true);
              reload();
            }
          }}
        />
      </section>

      <section className="card" aria-labelledby="danger-title" style={{ marginTop: '1.5rem' }}>
        <h2 id="danger-title">Delete this copilot</h2>
        <p className="muted">
          Deletes the copilot with all its threads, sessions, memory and saved transcript lines, and removes its uploaded documents.
          This cannot be undone.
        </p>
        <ErrorNotice error={del.error} onReload={() => { del.clear(); reload(); }} />
        <ConfirmButton
          small={false}
          label="Delete copilot…"
          question={`Delete “${copilot.name}” and everything in it?`}
          confirmLabel="Yes, delete"
          disabled={del.busy}
          onConfirm={async () => {
            const ok = await del.run(async () => { await deleteCopilot(client, copilot); return true; });
            if (ok) navigate('/app/copilots', { replace: true });
          }}
        />
      </section>
    </>
  );
}

function Breadcrumb() {
  return (
    <p className="breadcrumb"><Link to="/app/copilots">← All copilots</Link></p>
  );
}

function ThreadsPanel({ copilotId }: { copilotId: string }) {
  const { client } = useAuth();
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, loading, reload } = useLoad(
    () => listThreads(client, copilotId, { includeArchived: true }),
    [client, copilotId],
  );
  const act = useAction();
  const [title, setTitle] = useState('');
  const visible = (data ?? []).filter((t) => showArchived || t.status === 'active');
  const archivedCount = (data ?? []).filter((t) => t.status === 'archived').length;

  async function add(e: FormEvent) {
    e.preventDefault();
    const t = await act.run(() => createThread(client, copilotId, title));
    if (t) {
      setTitle('');
      reload();
    }
  }

  return (
    <section aria-labelledby="threads-title">
      <h2 id="threads-title">Threads</h2>
      <p className="muted">A thread is one ongoing relationship across meetings, such as one company or one supervisor.</p>

      <form onSubmit={add} className="card flat" aria-label="New thread">
        <TextField label="New thread title" value={title} onChange={setTitle} maxLength={200} required />
        <button className="btn primary" type="submit" disabled={act.busy}>Create thread</button>
      </form>

      <div style={{ marginTop: '1rem' }}>
        <ErrorNotice error={act.error ?? error} onReload={() => { act.clear(); reload(); }} />
        {loading && !data ? (
          <Loading what="Loading threads" />
        ) : visible.length === 0 ? (
          <Empty>{archivedCount > 0 ? 'No active threads. Archived threads are hidden.' : 'No threads yet.'}</Empty>
        ) : (
          <ul className="list" aria-label="Threads">
            {visible.map((t) => (
              <li key={t.id}>
                <article className="card">
                  <div className="row between">
                    <h3 style={{ margin: 0 }}>
                      <Link to={`/app/copilots/${copilotId}/threads/${t.id}`}>{t.title}</Link>
                      {t.status === 'archived' && <> <span className="badge">Archived</span></>}
                    </h3>
                    <span className="meta-line">Started {fmtDate(t.created_at)}</span>
                  </div>
                  <div className="row" style={{ marginTop: '0.75rem' }}>
                    <Link className="btn small" to={`/app/copilots/${copilotId}/threads/${t.id}`}>Open</Link>
                    <button
                      type="button" className="btn small" disabled={act.busy}
                      onClick={async () => {
                        const r = await act.run(() => setThreadStatus(client, t, t.status === 'active' ? 'archived' : 'active'));
                        if (r) reload();
                      }}
                    >
                      {t.status === 'active' ? 'Archive' : 'Unarchive'}
                    </button>
                    <ConfirmButton
                      label="Delete…"
                      question={`Delete “${t.title}”, its sessions and its memory?`}
                      confirmLabel="Yes, delete"
                      disabled={act.busy}
                      onConfirm={async () => {
                        const ok = await act.run(async () => { await deleteThread(client, t.id); return true; });
                        if (ok) reload();
                      }}
                    />
                  </div>
                </article>
              </li>
            ))}
          </ul>
        )}
        {archivedCount > 0 && (
          <label className="check" style={{ marginTop: '1rem' }}>
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            <span>Show {archivedCount} archived thread{archivedCount === 1 ? '' : 's'}</span>
          </label>
        )}
      </div>
    </section>
  );
}
