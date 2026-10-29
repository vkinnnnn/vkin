'use strict';
// Vkin sync against an in-memory fake of the Supabase REST surface that mirrors the SQL rules in
// supabase/migrations/0001_vkin_init.sql: RLS by user, server-set user_id/updated_at, rev check (PT409),
// identical replay = no-op, tombstones clear content and never revive (PT410), parent tombstones cascade,
// composite-FK style parent checks, and vkin_delete_thread.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVkinStore } = require('../src/main/vkin/store');
const { createVkinSync, isTransient } = require('../src/main/vkin/sync');
const { TOMBSTONE_CLEAR, PARENTS } = require('../src/main/vkin/schema');

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const clone = (v) => JSON.parse(JSON.stringify(v));
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${k}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

const CHILDREN = {}; // parent table -> [{ table, column }]
for (const [table, links] of Object.entries(PARENTS)) for (const { column, parent } of links) (CHILDREN[parent] = CHILDREN[parent] || []).push({ table, column });

function pgError(code, message, status) {
  return { data: null, error: { code, message, details: null, hint: null }, status };
}

class FakeServer {
  constructor() {
    /** @type {Record<string, Map<string, any>>} */
    this.tables = {};
    this.micros = 0;
    this.uid = USER;
    this.calls = 0;
    this.faults = []; // queue of 'before' | 'after' | '503'
    this.leak = false;
    this.afterUpsert = null; // test hook, runs after each applied upsert
  }
  rows(t) { return (this.tables[t] = this.tables[t] || new Map()); }
  tick() {
    this.micros += 137;
    const ms = Date.parse('2026-10-28T10:00:00.000Z') + Math.floor(this.micros / 1000);
    const iso = new Date(ms).toISOString().slice(0, 19);
    const frac = String((ms % 1000) * 1000 + (this.micros % 1000)).padStart(6, '0');
    return `${iso}.${frac}+00:00`;
  }
  visible(row) { return this.leak || row.user_id === this.uid; }
  tombstoneClear(t, row) {
    if (t === 'memory_items' && row.status === 'forgotten' && !row.deleted_at) row.deleted_at = this.tick();
    if (row.deleted_at) Object.assign(row, clone(TOMBSTONE_CLEAR[t]));
  }
  parentOf(t, row) {
    const link = (PARENTS[t] || [])[0];
    if (!link) return { ok: true };
    const p = this.rows(link.parent).get(row[link.column]);
    if (!p || p.user_id !== row.user_id) return { ok: false };
    return { ok: true, dead: Boolean(p.deleted_at) };
  }
  cascade(t, parent) {
    for (const { table, column } of CHILDREN[t] || []) {
      for (const r of this.rows(table).values()) {
        if (r[column] === parent.id && r.user_id === parent.user_id && !r.deleted_at) {
          r.deleted_at = parent.deleted_at;
          r.rev += 1;
          this.tombstoneClear(table, r);
          r.updated_at = this.tick();
          this.cascade(table, r);
        }
      }
    }
  }
  upsert(t, payload) {
    const res = this.upsertInner(t, payload);
    if (!res.error && this.afterUpsert) this.afterUpsert(t, payload);
    return res;
  }
  upsertInner(t, payload) {
    const existing = this.rows(t).get(payload.id);
    if (existing && existing.user_id !== this.uid) return pgError('42501', 'new row violates row-level security policy (USING expression)', 403);
    // RLS WITH CHECK (user_id = auth.uid()) on a client-sent owner.
    if (payload.user_id !== undefined && payload.user_id !== this.uid) return pgError('42501', 'new row violates row-level security policy', 403);
    if (!existing) {
      const row = { ...clone(payload), user_id: this.uid, created_at: payload.created_at || this.tick() };
      if (t === 'profiles' && row.id !== row.user_id) return pgError('23514', 'profiles_id_is_user', 400);
      const p = this.parentOf(t, row);
      if (!p.ok) return pgError('23503', 'violates foreign key constraint', 409);
      if (p.dead && !row.deleted_at) row.deleted_at = this.tick();
      this.tombstoneClear(t, row);
      row.updated_at = this.tick();
      this.rows(t).set(row.id, row);
      return { data: clone(row), error: null, status: 201 };
    }
    const next = { ...clone(existing), ...clone(payload), user_id: existing.user_id, created_at: existing.created_at };
    this.tombstoneClear(t, next);
    const strip = (r) => { const o = { ...r }; delete o.updated_at; delete o.created_at; return stable(o); };
    if (next.rev === existing.rev && strip(next) === strip(existing)) return { data: clone(existing), error: null, status: 200 };
    if (existing.deleted_at && !next.deleted_at) return pgError('PT410', `vkin_tombstoned: ${t} ${existing.id} was deleted`, 410);
    if (next.rev !== existing.rev + 1) return pgError('PT409', `vkin_rev_conflict: ${t} ${existing.id} is at rev ${existing.rev}`, 409);
    next.updated_at = this.tick();
    this.rows(t).set(next.id, next);
    if (!existing.deleted_at && next.deleted_at) this.cascade(t, next);
    return { data: clone(next), error: null, status: 200 };
  }
  deleteThread(id) {
    const th = this.rows('threads').get(id);
    if (!th || th.user_id !== this.uid || th.deleted_at) return { data: { threads: 0 }, error: null, status: 200 };
    th.deleted_at = this.tick();
    th.rev += 1;
    this.tombstoneClear('threads', th);
    th.updated_at = this.tick();
    this.cascade('threads', th);
    return { data: { threads: 1 }, error: null, status: 200 };
  }
  live(t) { return [...this.rows(t).values()].filter((r) => !r.deleted_at); }
}

class Query {
  constructor(server, table) {
    this.s = server;
    this.t = table;
    this.op = 'select';
    this.filters = [];
    this.lim = Infinity;
    this.single = false;
  }
  select() { return this; }
  upsert(payload) { this.op = 'upsert'; this.payload = payload; return this; }
  eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
  gte(c, v) { this.filters.push((r) => Date.parse(r[c]) >= Date.parse(v)); return this; }
  or(expr) {
    const m = /^updated_at\.gt\."([^"]+)",and\(updated_at\.eq\."([^"]+)",id\.gt\.([0-9a-f-]+)\)$/.exec(expr);
    if (!m) throw new Error(`fake: unsupported or() ${expr}`);
    this.filters.push((r) => r.updated_at > m[1] || (r.updated_at === m[2] && r.id > m[3]));
    return this;
  }
  order() { return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this.single = true; return this; }
  run() {
    if (this.op === 'upsert') return this.s.upsert(this.t, this.payload);
    let rows = [...this.s.rows(this.t).values()].filter((r) => this.s.visible(r) && this.filters.every((f) => f(r)));
    rows.sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.id < b.id ? -1 : 1));
    rows = rows.slice(0, this.lim).map(clone);
    return { data: this.single ? rows[0] || null : rows, error: null, status: 200 };
  }
  then(resolve, reject) {
    return Promise.resolve().then(() => this.s.exec(() => this.run())).then(resolve, reject);
  }
}

FakeServer.prototype.exec = function exec(fn) {
  this.calls += 1;
  const fault = this.faults.shift();
  if (fault === 'before') throw new TypeError('fetch failed');
  if (fault === '503') return { data: null, error: { message: 'Service Unavailable', code: '' }, status: 503 };
  const res = fn();
  if (fault === 'after') throw new TypeError('fetch failed'); // applied, but the response was lost
  return res;
};

function fakeClient(server) {
  return {
    from: (t) => new Query(server, t),
    rpc: (name, args) => ({
      then: (resolve, reject) => Promise.resolve()
        .then(() => server.exec(() => (name === 'vkin_delete_thread' ? server.deleteThread(args.p_id) : pgError('42883', 'no function', 404))))
        .then(resolve, reject),
    }),
    auth: { getSession: async () => ({ data: { session: server.uid ? { user: { id: server.uid } } : null }, error: null }) },
  };
}

function clock() {
  let t = Date.parse('2026-10-28T09:00:00.000Z');
  return () => new Date((t += 1000)).toISOString();
}

function device(server, account = USER, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vkin-sync-'));
  const store = createVkinStore({ dataRoot: root, account, now: clock() });
  const delays = [];
  const sync = createVkinSync({ store, client: fakeClient(server), sleep: async (ms) => { delays.push(ms); }, baseDelayMs: 10, ...opts });
  return { store, sync, delays, adapter: store.syncAdapter() };
}

test('push: new rows go up parents-first, are marked clean, and the server sets user_id', async () => {
  const server = new FakeServer();
  const d = device(server);
  const c = d.store.createCopilot({ name: 'Supervisor', keyterms: ['OKR'] });
  const t = d.store.createThread(c.id, 'Weekly');
  const s = d.store.startSession(t.id, { saveTranscript: true });
  d.store.addTranscriptLines(s.id, [{ speaker: 'them', text: 'hello' }]);
  d.store.addMemoryDraft(s.id, [{ kind: 'topic', text: 'Overlap paper', origin: 'their_speech' }]);
  d.store.updateProfile({ display_name: 'Avery' });
  const r = await d.sync.syncNow();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.pushed, 6);
  assert.deepEqual(r.conflicts, []);
  for (const table of ['copilots', 'threads', 'sessions', 'memory_items', 'transcript_lines', 'profiles']) {
    assert.equal(d.adapter.dirtyRows(table).length, 0, `${table} clean`);
    for (const row of server.rows(table).values()) assert.equal(row.user_id, USER);
  }
  assert.equal(server.rows('copilots').get(c.id).rev, 1);
  assert.equal(d.adapter.getRow('copilots', c.id).updated_at, server.rows('copilots').get(c.id).updated_at, 'server time adopted');
  const again = await d.sync.syncNow();
  assert.equal(again.pushed, 0);
  assert.equal(again.pulled, 0, 'own rows coming back are not re-applied');
});

test('rev: a second device editing a stale base gets a conflict that is surfaced, never overwritten', async () => {
  const server = new FakeServer();
  const d1 = device(server);
  const d2 = device(server);
  const c = d1.store.createCopilot({ name: 'Original' });
  await d1.sync.syncNow();
  await d2.sync.syncNow();
  assert.equal(d2.store.getCopilot(c.id).name, 'Original');

  d1.store.updateCopilot(c.id, { name: 'From device 1' });
  assert.equal((await d1.sync.syncNow()).pushed, 1);
  assert.equal(server.rows('copilots').get(c.id).rev, 2);

  d2.store.updateCopilot(c.id, { name: 'From device 2' });
  const r = await d2.sync.syncNow();
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual({ table: r.conflicts[0].table, localRev: r.conflicts[0].localRev, serverRev: r.conflicts[0].serverRev }, { table: 'copilots', localRev: 2, serverRev: 2 });
  assert.equal(server.rows('copilots').get(c.id).name, 'From device 1', 'server not overwritten');
  assert.equal(d2.store.getCopilot(c.id).name, 'From device 2', 'local edit kept');
  assert.equal(d2.store.getCopilot(c.id).conflict, true);
  assert.equal((await d2.sync.syncNow()).pushed, 0, 'a conflicted row is not retried blindly');

  d2.store.resolveConflict('copilots', c.id, 'local');
  const r2 = await d2.sync.syncNow();
  assert.equal(r2.pushed, 1);
  assert.equal(server.rows('copilots').get(c.id).name, 'From device 2');
  assert.equal(server.rows('copilots').get(c.id).rev, 3);
  await d1.sync.syncNow();
  assert.equal(d1.store.getCopilot(c.id).name, 'From device 2');
});

test('pull: remote tombstones apply, cascade locally, override local edits and are never resurrected', async () => {
  const server = new FakeServer();
  const d1 = device(server);
  const d2 = device(server);
  const c = d1.store.createCopilot({ name: 'C' });
  const t = d1.store.createThread(c.id, 'secret title');
  const s = d1.store.startSession(t.id);
  d1.store.addMemoryDraft(s.id, [{ kind: 'fact', text: 'secret memory', origin: 'note' }]);
  await d1.sync.syncNow();
  await d2.sync.syncNow();
  assert.equal(d2.store.listThreads(c.id).length, 1);

  d2.store.updateThread(t.id, { title: 'edited offline' });
  d1.store.deleteThread(t.id);
  const r1 = await d1.sync.syncNow();
  assert.deepEqual(r1.conflicts, []);
  assert.ok(server.rows('threads').get(t.id).deleted_at);

  const r2 = await d2.sync.syncNow();
  assert.deepEqual(r2.deletedRemotely.map((x) => x.table), ['threads']);
  assert.equal(d2.store.listThreads(c.id).length, 0);
  assert.equal(d2.store.listMemory({ copilotId: c.id }).length, 0);
  const local = d2.adapter.getRow('threads', t.id);
  assert.equal(local.title, '');
  assert.ok(local.deleted_at);
  assert.doesNotMatch(fs.readFileSync(d2.store.file, 'utf8'), /secret (title|memory)|edited offline/);
  const r3 = await d2.sync.syncNow();
  assert.equal(r3.ok, true);
  assert.ok(server.rows('threads').get(t.id).deleted_at, 'still a tombstone on the server');
  assert.equal(server.rows('threads').get(t.id).title, '');
});

test('thread delete: tombstones server rows this device never pulled (vkin_delete_thread + cascade)', async () => {
  const server = new FakeServer();
  const d1 = device(server);
  const d2 = device(server);
  const c = d1.store.createCopilot({ name: 'C' });
  const t = d1.store.createThread(c.id, 'T');
  await d1.sync.syncNow();
  await d2.sync.syncNow();
  const s2 = d2.store.startSession(t.id, { saveTranscript: true });
  d2.store.addTranscriptLines(s2.id, [{ speaker: 'them', text: 'only on device 2' }]);
  await d2.sync.syncNow();

  d1.store.deleteThread(t.id); // d1 never saw s2
  const r = await d1.sync.syncNow();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(server.rows('sessions').get(s2.id).deleted_at, 'unseen session tombstoned');
  for (const line of server.rows('transcript_lines').values()) {
    assert.ok(line.deleted_at);
    assert.equal(line.text, '');
  }
});

test('idempotent retry: a lost response is retried without duplicates and the row ends clean', async () => {
  const server = new FakeServer();
  const d = device(server);
  const c = d.store.createCopilot({ name: 'C' });
  const t = d.store.createThread(c.id, 'T');
  const s = d.store.startSession(t.id);
  server.faults = ['after', 'after', 'after']; // copilot, thread and session upserts all lose their first response
  const r = await d.sync.syncNow();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(server.rows('sessions').size, 1);
  assert.equal(server.rows('sessions').get(s.id).rev, 1);
  assert.equal(d.adapter.dirtyRows('sessions').length, 0);
});

test('reconnect: retries exhausted mid-push leave rows dirty; the next sync converges with no duplicate session', async () => {
  const server = new FakeServer();
  const d = device(server, USER, { maxRetries: 1 });
  const c = d.store.createCopilot({ name: 'C' });
  const t = d.store.createThread(c.id, 'T');
  const s = d.store.startSession(t.id);
  await d.sync.syncNow();
  d.store.endSession(s.id); // rev 2
  // Applied but the response is lost, the retry fails, and every pull attempt fails too: fully offline.
  server.faults = ['after', 'before', ...Array(16).fill('before')];
  const r1 = await d.sync.syncNow();
  assert.equal(r1.ok, false);
  assert.equal(d.adapter.getRow('sessions', s.id).dirty, true, 'still queued');
  assert.equal(server.rows('sessions').get(s.id).rev, 2, 'the server did apply it');
  const r2 = await d.sync.syncNow(); // reconnect: same rev, same content => accepted as a replay
  assert.equal(r2.ok, true, JSON.stringify(r2.errors));
  assert.deepEqual(r2.conflicts, []);
  assert.equal(server.rows('sessions').size, 1);
  assert.equal(d.adapter.getRow('sessions', s.id).dirty, false);
  assert.equal(d.store.listSessions(t.id).length, 1);
});

test('lost response surfaced as PT409 by a server without replay support still resolves as our own write', async () => {
  const server = new FakeServer();
  const d = device(server, USER, { maxRetries: 0 });
  const c = d.store.createCopilot({ name: 'C' });
  await d.sync.syncNow();
  d.store.updateCopilot(c.id, { name: 'C2' });
  server.faults = ['after', ...Array(8).fill('before')]; // push applied but lost; every pull fails too
  const r1 = await d.sync.syncNow();
  assert.equal(r1.ok, false);
  assert.equal(d.adapter.getRow('copilots', c.id).dirty, true);
  const orig = server.upsert.bind(server);
  server.upsert = (t, p) => {
    const ex = server.rows(t).get(p.id);
    if (ex && ex.rev === p.rev) return pgError('PT409', 'vkin_rev_conflict', 409);
    return orig(t, p);
  };
  const r = await d.sync.syncNow();
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.pushed, 1);
  assert.equal(d.adapter.getRow('copilots', c.id).dirty, false);
});

test('offline: bounded retries with exponential backoff, nothing lost, then catches up', async () => {
  const server = new FakeServer();
  const d = device(server, USER, { maxRetries: 3 });
  d.store.createCopilot({ name: 'Offline' });
  server.faults = ['before', '503', 'before', 'before'];
  const r = await d.sync.syncNow();
  assert.equal(r.ok, false);
  assert.deepEqual(d.delays.slice(0, 3), [10, 20, 40]);
  assert.equal(d.delays.length, 3, 'bounded: maxRetries sleeps for one request');
  assert.equal(d.adapter.dirtyRows('copilots').length, 1);
  assert.equal(server.rows('copilots').size, 0);
  const r2 = await d.sync.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(server.rows('copilots').size, 1);
  assert.equal(isTransient({ error: { code: '42501', message: 'rls' }, status: 403 }), false);
  assert.equal(isTransient({ error: { code: 'PT409', message: 'vkin_rev_conflict' }, status: 409 }), false);
  assert.equal(isTransient({ error: { message: 'x' }, status: 429 }), true);
});

test('account safety: refuses when the store belongs to another user, when signed out, and for the local store', async () => {
  const server = new FakeServer();
  const mine = device(server, OTHER);
  mine.store.createCopilot({ name: 'theirs' });
  await assert.rejects(mine.sync.syncNow(), (e) => e.code === 'E_ACCOUNT_MISMATCH');
  const local = device(server, 'local');
  await assert.rejects(local.sync.syncNow(), (e) => e.code === 'E_ACCOUNT_MISMATCH');
  server.uid = null;
  const d = device(server);
  await assert.rejects(d.sync.syncNow(), (e) => e.code === 'E_NOT_SIGNED_IN');
  assert.equal(server.calls, 0, 'no request was made');
  assert.equal(server.rows('copilots').size, 0);
});

test('account safety: rows of another account returned by a misconfigured server are ignored', async () => {
  const server = new FakeServer();
  server.uid = OTHER;
  const other = device(server, OTHER);
  other.store.createCopilot({ name: 'Other user secret' });
  await other.sync.syncNow();
  server.uid = USER;
  server.leak = true; // simulate broken RLS
  const d = device(server);
  const r = await d.sync.syncNow();
  assert.ok(r.errors.some((e) => e.code === 'E_FOREIGN_ROW'));
  assert.equal(d.store.listCopilots().length, 0);
  assert.doesNotMatch(fs.readFileSync(d.store.file, 'utf8'), /Other user secret/);
});

test('pull: keyset pagination over small pages gets every row once; the overlap window re-reads without duplicating', async () => {
  const server = new FakeServer();
  const d1 = device(server);
  for (let i = 0; i < 7; i++) d1.store.createCopilot({ name: `C${i}` });
  await d1.sync.syncNow();
  const d2 = device(server, USER, { pageSize: 2 });
  const r = await d2.sync.syncNow();
  assert.equal(r.pulled, 7);
  assert.equal(d2.store.listCopilots().length, 7);
  const r2 = await d2.sync.syncNow();
  assert.equal(r2.pulled, 0);
  assert.ok(d2.adapter.getCursor('copilots').ts.endsWith('+00:00'), 'raw server timestamp kept as the cursor');
});

test('syncNow: concurrent calls share one pass', async () => {
  const server = new FakeServer();
  const d = device(server);
  d.store.createCopilot({ name: 'C' });
  const [a, b] = await Promise.all([d.sync.syncNow(), d.sync.syncNow()]);
  assert.strictEqual(a, b);
  assert.equal(server.rows('copilots').size, 1);
});

test('mid-pass account switch: the next request is refused; nothing lands under the new user', async () => {
  const server = new FakeServer();
  const d = device(server);
  const c = d.store.createCopilot({ name: 'C' });
  d.store.createThread(c.id, 'T');
  server.afterUpsert = () => { server.uid = OTHER; server.afterUpsert = null; };
  await assert.rejects(d.sync.syncNow(), (e) => e.code === 'E_ACCOUNT_MISMATCH');
  assert.equal(server.rows('copilots').size, 1);
  assert.equal(server.rows('threads').size, 0, 'the thread was not inserted for the new user');
  for (const t of Object.keys(server.tables)) for (const r of server.rows(t).values()) assert.equal(r.user_id, USER);
  assert.equal(d.adapter.dirtyRows('threads').length, 1, 'still queued for the right account');
});

test('defence in depth: user_id is sent on upserts, so RLS rejects a session that does not own the store', async () => {
  const server = new FakeServer();
  server.uid = OTHER; // the real session user
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vkin-sync-'));
  const store = createVkinStore({ dataRoot: root, account: USER, now: clock() });
  // A buggy session lookup that claims USER while requests actually run as OTHER.
  const sync = createVkinSync({ store, client: fakeClient(server), getUserId: async () => USER, sleep: async () => {} });
  store.createCopilot({ name: 'C' });
  const r = await sync.syncNow();
  assert.ok(r.errors.some((e) => e.code === '42501'));
  assert.equal(server.rows('copilots').size, 0);
  assert.equal(store.syncAdapter().dirtyRows('copilots').length, 1);
});

test('cancel: stops an in-progress pass at the next request and resolves once stopped', async () => {
  const server = new FakeServer();
  const d = device(server);
  for (let i = 0; i < 5; i++) d.store.createCopilot({ name: `C${i}` });
  let stopped = null;
  server.afterUpsert = () => { server.afterUpsert = null; stopped = d.sync.cancel(); };
  const r = await d.sync.syncNow();
  await stopped;
  assert.equal(r.aborted, 'E_CANCELLED');
  assert.equal(r.ok, false);
  assert.equal(server.rows('copilots').size, 1);
  assert.equal(d.sync.isRunning(), false);
  await d.sync.cancel(); // nothing running: resolves immediately
  const r2 = await d.sync.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(server.rows('copilots').size, 5);
});

test('sign-out wipe during a pass: the old store instance never recreates the wiped folder', async () => {
  const server = new FakeServer();
  const d = device(server);
  d.store.createCopilot({ name: 'C1' });
  d.store.createCopilot({ name: 'C2' });
  server.afterUpsert = () => { server.afterUpsert = null; d.store.wipeAccount(); };
  const r = await d.sync.syncNow();
  assert.equal(r.aborted, 'E_CLOSED');
  assert.equal(fs.existsSync(path.dirname(d.store.file)), false);
});

test('forget while in conflict: delete wins, the tombstone syncs and no text survives anywhere', async () => {
  const server = new FakeServer();
  const d1 = device(server);
  const d2 = device(server);
  const c = d1.store.createCopilot({ name: 'C' });
  const t = d1.store.createThread(c.id, 'T');
  const s = d1.store.startSession(t.id);
  const [m] = d1.store.addMemoryDraft(s.id, [{ kind: 'fact', text: 'original text', origin: 'note' }]);
  await d1.sync.syncNow();
  await d2.sync.syncNow();
  d1.store.updateMemory(m.id, { text: 'server side secret' });
  await d1.sync.syncNow();
  d2.store.updateMemory(m.id, { text: 'local secret' });
  const r = await d2.sync.syncNow();
  assert.equal(r.conflicts.length, 1);
  d2.store.forgetMemory(m.id);
  assert.deepEqual(d2.store.listConflicts(), []);
  const r2 = await d2.sync.syncNow();
  assert.equal(r2.ok, true, JSON.stringify(r2.errors));
  const srv = server.rows('memory_items').get(m.id);
  assert.ok(srv.deleted_at);
  assert.equal(srv.text, '');
  assert.equal(srv.status, 'forgotten');
  assert.doesNotMatch(fs.readFileSync(d2.store.file, 'utf8'), /secret|original text/);
});

test('local delete that hits a rev conflict is rebased (delete wins) and pushed, not parked', async () => {
  const server = new FakeServer();
  const d1 = device(server);
  const d2 = device(server);
  const c = d1.store.createCopilot({ name: 'C' });
  await d1.sync.syncNow();
  await d2.sync.syncNow();
  d1.store.updateCopilot(c.id, { name: 'renamed on device 1' });
  await d1.sync.syncNow();
  d2.store.deleteCopilot(c.id);
  const r = await d2.sync.syncNow();
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(d2.store.listConflicts(), []);
  await d2.sync.syncNow();
  assert.ok(server.rows('copilots').get(c.id).deleted_at);
  assert.equal(server.rows('copilots').get(c.id).name, '');
});
