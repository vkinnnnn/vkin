import { useEffect, useState } from 'react';
import { ApiError, fmtMinutes, getMe, type Me } from '../lib/api';
import { useAuth } from '../lib/auth';
import { vkinApiUrl } from '../lib/config';
import { fmtDateTime } from '../lib/format';

export type MinutesState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; me: Me };

/** While a lease is live the server bills time, so refresh the numbers this often. */
const LIVE_REFRESH_MS = 30_000;

function fmtSince(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : fmtDateTime(iso);
}

/** Pure view, so every state can be rendered and tested without a network or Supabase. */
export function MinutesCardView({ state, onRetry }: { state: MinutesState; onRetry: () => void }) {
  return (
    <section className="card minutes" aria-labelledby="minutes-title">
      <div className="minutes-head">
        <h2 id="minutes-title">Copilot minutes</h2>
        {state.status === 'ready' && (
          <button type="button" className="btn ghost small" onClick={onRetry}>Refresh</button>
        )}
      </div>
      {state.status === 'loading' && <p className="muted" role="status">Loading your minutes…</p>}
      {state.status === 'error' && (
        <div className="notice error" role="alert">
          <p>{state.message}</p>
          <button type="button" className="btn small" onClick={onRetry}>Retry</button>
        </div>
      )}
      {state.status === 'ready' && <MinutesBody me={state.me} />}
    </section>
  );
}

function MinutesBody({ me }: { me: Me }) {
  const total = me.trialSeconds + me.purchasedSeconds;
  const remaining = Math.min(me.remainingSeconds, total);
  const usedPct = total > 0 ? Math.min(100, Math.round(((total - remaining) / total) * 100)) : 100;
  const lease = me.activeLease;
  const since = lease ? fmtSince(lease.startedAt) : '';

  return (
    <>
      {lease && (
        <p className="notice info" role="status">
          <strong>Live on {lease.device}{since ? ` since ${since}` : ''}.</strong> Time is counting.
        </p>
      )}
      {total === 0 ? (
        <p>No trial minutes on this account yet. The free trial is added once your email address is confirmed.</p>
      ) : remaining <= 0 ? (
        <>
          <p className="minutes-big">Trial used — paid minutes coming soon</p>
          <p className="muted">You have used all {fmtMinutes(total)} of copilot time on this account.</p>
        </>
      ) : (
        <>
          <p className="minutes-big">
            {fmtMinutes(remaining)} <span className="muted">left</span>
          </p>
          <p className="muted">
            {fmtMinutes(me.usedSeconds)} used of {fmtMinutes(total)}
            {me.purchasedSeconds === 0 ? ' free trial' : ''}.
          </p>
        </>
      )}
      {total > 0 && (
        <div className="minutes-bar" aria-hidden="true">
          <span style={{ width: `${usedPct}%` }} />
        </div>
      )}
      <p className="hint">
        Time counts while the copilot is live in the Windows desktop app, including while it is listening. Pausing stops it.
      </p>
    </>
  );
}

function LiveMinutesCard({ apiUrl }: { apiUrl: string }) {
  const { client } = useAuth();
  const [state, setState] = useState<MinutesState>({ status: 'loading' });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    // Keep showing the last numbers during a background refresh; only the first load shows "Loading".
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    getMe(client, apiUrl, { signal: ctrl.signal }).then(
      (me) => {
        if (!ctrl.signal.aborted) setState({ status: 'ready', me });
      },
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({ status: 'error', message: e instanceof ApiError ? e.message : 'Could not load your minutes. Try again.' });
      },
    );
    return () => ctrl.abort();
  }, [client, apiUrl, tick]);

  const live = state.status === 'ready' && state.me.activeLease !== null;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick((n) => n + 1), LIVE_REFRESH_MS);
    return () => clearInterval(t);
  }, [live]);

  return <MinutesCardView state={state} onRetry={() => setTick((n) => n + 1)} />;
}

/** Trial minutes from GET /v1/me. Renders nothing when the hosted API is not configured. */
export default function MinutesCard({ apiUrl = vkinApiUrl }: { apiUrl?: string }) {
  if (!apiUrl) return null;
  return <LiveMinutesCard apiUrl={apiUrl} />;
}
