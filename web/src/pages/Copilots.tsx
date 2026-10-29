import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Empty, ErrorNotice, Loading } from '../components/ui';
import { useAuth } from '../lib/auth';
import { createCopilot, listCopilots } from '../lib/data';
import { fmtDate } from '../lib/format';
import { useAction, useLoad, usePageTitle } from '../lib/hooks';
import CopilotForm from './CopilotForm';

export default function Copilots() {
  usePageTitle('Copilots');
  const { client } = useAuth();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useLoad(() => listCopilots(client), [client]);
  const create = useAction();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Copilots</h1>
          <p>A copilot is a workspace: purpose, instructions and preferences. Each one has its own threads and memory.</p>
        </div>
        {!creating && (
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>New copilot</button>
        )}
      </div>

      {creating && (
        <section className="card" aria-labelledby="new-copilot">
          <h2 id="new-copilot">New copilot</h2>
          <ErrorNotice error={create.error} />
          <CopilotForm
            submitLabel="Create copilot"
            busy={create.busy}
            onSubmit={async (input) => {
              const c = await create.run(() => createCopilot(client, input));
              if (c) navigate(`/app/copilots/${c.id}`);
            }}
          />
          <p style={{ marginTop: '1rem', marginBottom: 0 }}>
            <button type="button" className="btn ghost small" onClick={() => setCreating(false)}>Cancel</button>
          </p>
        </section>
      )}

      <ErrorNotice error={error} onReload={reload} />
      {loading && !data ? (
        <Loading what="Loading copilots" />
      ) : data && data.length === 0 ? (
        !creating && <Empty>No copilots yet. Create one to start preparing.</Empty>
      ) : (
        <ul className="list" style={{ marginTop: creating ? '1.25rem' : 0 }} aria-label="Your copilots">
          {data?.map((c) => (
            <li key={c.id}>
              <article className="card">
                <h2 style={{ fontSize: '1.15rem', marginBottom: '0.25rem' }}>
                  <Link to={`/app/copilots/${c.id}`}>{c.name}</Link>
                </h2>
                {c.purpose && <p className="muted" style={{ marginBottom: '0.5rem' }}>{c.purpose.length > 200 ? `${c.purpose.slice(0, 200)}…` : c.purpose}</p>}
                <p className="meta-line" style={{ marginBottom: 0 }}>
                  Memory: {c.memory_scope === 'copilot' ? 'shared across threads' : 'per thread'} · Created {fmtDate(c.created_at)}
                </p>
              </article>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
