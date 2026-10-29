// @ts-check
'use strict';
// Vkin sync: local store <-> Supabase (docs/vkin-contracts.md, "Identity and sync rules").
//
// push: every dirty row is upserted by id with its rev. Tombstones go first, children before parents; live
//       rows go parents before children (composite FKs). A rev conflict (PT409) or a write to a tombstone
//       (PT410) never overwrites anything: the row is marked `conflict` and surfaced, except when the server
//       already holds exactly our write (a retried request whose response was lost) or both sides deleted it.
// pull: per-table cursor on (updated_at, id), re-reading a small overlap window each time so rows committed
//       slightly out of timestamp order are not missed. Re-applied rows are idempotent (rev <= synced_rev).
//       Tombstones are applied and never resurrected.
// The queue is simply the set of dirty rows, so the store is offline-safe by construction.
// Only the signed-in user's folder is synced: if store.account != session user, sync refuses.
const { VkinError, TABLES, pushColumns, sameContent } = require('./schema');

const CONFLICT_CODES = Object.freeze(['PT409', 'PT410']);

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function isConflict(err) {
  if (!err) return false;
  return CONFLICT_CODES.includes(err.code) || /vkin_rev_conflict|vkin_tombstoned/.test(String(err.message || ''));
}

/** Network failures, 5xx and 429 are retried; database errors (RLS, checks, conflicts) are not. */
function isTransient(res) {
  if (!res) return true;
  if (res.thrown) return true;
  const err = res.error;
  if (!err) return false;
  if (isConflict(err)) return false;
  const status = Number(res.status || err.status || 0);
  if (status === 429 || status >= 500) return true;
  if (!err.code && (!status || /fetch|network|timeout|ECONN|ETIMEDOUT|socket|abort/i.test(String(err.message || '')))) return true;
  return false;
}

const safeError = (err) => ({ code: err && err.code ? String(err.code) : '', message: String((err && err.message) || err || 'error').slice(0, 300) });

/** Later of two server timestamps (microsecond strings: compare by ms, then lexically). */
function laterCursor(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a.ts);
  const tb = Date.parse(b.ts);
  if (ta !== tb) return ta > tb ? a : b;
  if (a.ts !== b.ts) return a.ts > b.ts ? a : b;
  return String(a.id) >= String(b.id) ? a : b;
}

/**
 * @param {{
 *   store: { syncAdapter: () => any },
 *   client: any,
 *   getUserId?: () => Promise<string|null>,
 *   sleep?: (ms: number) => Promise<void>,
 *   maxRetries?: number,
 *   baseDelayMs?: number,
 *   pageSize?: number,
 *   overlapMs?: number,
 * }} opts
 */
function createVkinSync({ store, client, getUserId, sleep = sleepMs, maxRetries = 3, baseDelayMs = 400, pageSize = 500, overlapMs = 5000 }) {
  if (!store || !client) throw new VkinError('E_INVALID', 'store and client are required');
  const adapter = store.syncAdapter();
  const userId = getUserId || (async () => {
    const { data } = await client.auth.getSession();
    return (data && data.session && data.session.user && data.session.user.id) || null;
  });
  /** @type {Promise<any>|null} */
  let running = null;
  let cancelRequested = false;

  async function guard() {
    const uid = await userId();
    if (!uid) throw new VkinError('E_NOT_SIGNED_IN', 'sign in to sync');
    if (adapter.account !== String(uid).toLowerCase()) {
      throw new VkinError('E_ACCOUNT_MISMATCH', 'the open local store belongs to a different account than the signed-in user');
    }
  }

  /** Before every request: stop if cancelled, and re-check that the session user still owns this store. */
  async function checkpoint() {
    if (cancelRequested) throw new VkinError('E_CANCELLED', 'sync was cancelled');
    await guard();
    if (cancelRequested) throw new VkinError('E_CANCELLED', 'sync was cancelled');
  }

  /** Runs a query with bounded retries + exponential backoff on transient failures. */
  async function withRetry(run) {
    let res;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await checkpoint();
      try {
        res = await run();
      } catch (err) {
        res = { thrown: true, error: { message: String((err && err.message) || err) } };
      }
      if (!isTransient(res) || attempt === maxRetries) return res;
      await sleep(baseDelayMs * 2 ** attempt);
    }
    return res;
  }

  // user_id is sent as defence in depth: RLS WITH CHECK (user_id = auth.uid()) rejects the write if the
  // session user is not the owner of this store, instead of silently stamping the row with a new owner.
  function payloadFor(table, row) {
    const p = {};
    for (const c of pushColumns(table)) if (row[c] !== undefined) p[c] = row[c];
    p.user_id = adapter.account;
    return p;
  }

  async function resolvePushConflict(table, row, err, report) {
    const res = await withRetry(() => client.from(table).select('*').eq('id', row.id).maybeSingle());
    if (res.error) {
      report.errors.push({ table, id: row.id, ...safeError(res.error) });
      return;
    }
    const server = res.data || null;
    if (server && sameContent(table, server, row)) {
      adapter.markSynced(table, row.id, { rev: row.rev, seq: row.seq, server });
      report.pushed += 1;
      return;
    }
    if (server && server.deleted_at) {
      const outcome = adapter.applyRemote(table, server);
      if (!row.deleted_at && outcome !== 'skipped') report.deletedRemotely.push({ table, id: row.id });
      return;
    }
    const outcome = adapter.markConflict(table, row.id, server, err.code === 'PT410' ? 'tombstoned' : 'rev_conflict');
    // A local delete is rebased on the server rev (delete wins) and goes out on the next pass.
    if (outcome !== 'rebased') report.conflicts.push({ table, id: row.id, localRev: row.rev, serverRev: server ? server.rev : null });
  }

  async function pushRow(table, row, report) {
    const res = await withRetry(() => client.from(table).upsert(payloadFor(table, row), { onConflict: 'id' }).select().maybeSingle());
    if (!res.error) {
      adapter.markSynced(table, row.id, { rev: row.rev, seq: row.seq, server: res.data || null });
      report.pushed += 1;
      return true;
    }
    if (isConflict(res.error)) {
      await resolvePushConflict(table, row, res.error, report);
      return false;
    }
    report.errors.push({ table, id: row.id, ...safeError(res.error) });
    return false;
  }

  async function push(report) {
    // Tombstones: children first, so a parent's server-side cascade finds nothing left to bump.
    for (const table of [...TABLES].reverse()) {
      for (const row of adapter.dirtyRows(table).filter((r) => r.deleted_at)) {
        const ok = await pushRow(table, row, report);
        if (ok && table === 'threads') {
          // Tombstones server rows this device never saw (sessions/memory/lines from another device).
          const r = await withRetry(() => client.rpc('vkin_delete_thread', { p_id: row.id }));
          if (r.error) report.errors.push({ table, id: row.id, ...safeError(r.error) });
        }
      }
    }
    for (const table of TABLES) {
      for (const row of adapter.dirtyRows(table).filter((r) => !r.deleted_at)) await pushRow(table, row, report);
    }
  }

  async function pullTable(table, report) {
    const stored = adapter.getCursor(table);
    let cursor = stored;
    const since = stored ? new Date(Date.parse(stored.ts) - overlapMs).toISOString() : null;
    /** @type {{ts: string, id: string}|null} */
    let last = null;
    for (;;) {
      const res = await withRetry(() => {
        let q = client.from(table).select('*');
        if (last) q = q.or(`updated_at.gt."${last.ts}",and(updated_at.eq."${last.ts}",id.gt.${last.id})`);
        else if (since) q = q.gte('updated_at', since);
        return q.order('updated_at', { ascending: true }).order('id', { ascending: true }).limit(pageSize);
      });
      if (res.error) {
        report.errors.push({ table, id: null, ...safeError(res.error) });
        return;
      }
      const rows = Array.isArray(res.data) ? res.data : [];
      adapter.batch(() => {
        for (const srv of rows) {
          const outcome = adapter.applyRemote(table, srv);
          if (outcome === 'inserted' || outcome === 'updated' || outcome.startsWith('tombstoned')) report.pulled += 1;
          if (outcome === 'conflict') report.conflicts.push({ table, id: srv.id, localRev: null, serverRev: srv.rev });
          if (outcome === 'tombstoned_over_local_edit') report.deletedRemotely.push({ table, id: srv.id });
          if (outcome === 'rejected') report.errors.push({ table, id: srv.id, code: 'E_FOREIGN_ROW', message: 'row for another account ignored' });
        }
        if (rows.length) {
          const tail = rows[rows.length - 1];
          last = { ts: String(tail.updated_at), id: String(tail.id) };
          cursor = laterCursor(cursor, last);
          adapter.setCursor(table, cursor);
        }
      });
      if (rows.length < pageSize) return;
    }
  }

  async function pull(report) {
    for (const table of TABLES) await pullTable(table, report);
  }

  /**
   * Account checks reject (E_NOT_SIGNED_IN / E_ACCOUNT_MISMATCH), also mid-pass. A cancel, or the store being
   * closed (sign-out wiped it), ends the pass early with report.aborted set.
   */
  async function run() {
    cancelRequested = false;
    const report = { ok: false, aborted: null, pushed: 0, pulled: 0, conflicts: [], deletedRemotely: [], errors: [] };
    try {
      await guard();
      await push(report);
      await pull(report);
    } catch (err) {
      const code = err && /** @type {any} */ (err).code;
      if (code !== 'E_CANCELLED' && code !== 'E_CLOSED') throw err;
      report.aborted = code;
      return report;
    }
    report.ok = report.errors.length === 0;
    return report;
  }

  /** One sync pass (push then pull). Concurrent calls share the running pass. */
  function syncNow() {
    if (!running) running = run().finally(() => { running = null; });
    return running;
  }

  /** Stops an in-progress pass at the next request boundary. Resolves once it has stopped. */
  function cancel() {
    if (!running) return Promise.resolve();
    cancelRequested = true;
    return running.then(() => undefined, () => undefined);
  }

  return { syncNow, cancel, isRunning: () => Boolean(running) };
}

module.exports = { createVkinSync, isTransient, isConflict, sameContent };
