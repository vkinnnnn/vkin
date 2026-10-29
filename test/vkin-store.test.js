'use strict';
// Vkin local store: CRUD, validation, rev/dirty, scoping, forget, cascades, export, wipe, migration, import.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVkinStore, migrateDoc, SCHEMA_VERSION } = require('../src/main/vkin/store');

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vkin-store-'));
}

function clock() {
  let t = Date.parse('2026-10-28T10:00:00.000Z');
  return () => new Date((t += 1000)).toISOString();
}

function open(root = tmpRoot(), account = USER) {
  return createVkinStore({ dataRoot: root, account, now: clock() });
}

const code = (c) => (err) => err && err.code === c;

function listFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

test('store: per-account path, schemaVersion 1, atomic write leaves no temp files', () => {
  const root = tmpRoot();
  const s = open(root);
  s.createCopilot({ name: 'Interview copilot' });
  assert.equal(s.file, path.join(root, 'vkin', USER, 'vkin.json'));
  const doc = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.account, USER);
  assert.deepEqual(fs.readdirSync(path.dirname(s.file)), ['vkin.json']);
  const local = createVkinStore({ dataRoot: root });
  assert.equal(local.account, 'local');
  assert.match(local.file, /[\\/]vkin[\\/]local[\\/]vkin\.json$/);
});

test('store: account names cannot escape the store root', () => {
  for (const bad of ['..', '../x', 'C:\\x', '', 'not-a-uuid']) {
    assert.throws(() => createVkinStore({ dataRoot: tmpRoot(), account: bad }), code('E_BAD_ACCOUNT'));
  }
});

test('copilots: create with defaults, validation errors carry codes, unknown fields rejected', () => {
  const s = open();
  const c = s.createCopilot({ name: '  Supervisor  ', keyterms: ['OKR', 'OKR', ' SVI '] });
  assert.equal(c.name, 'Supervisor');
  assert.equal(c.memory_scope, 'thread');
  assert.equal(c.use_profile_facts, true);
  assert.deepEqual(c.keyterms, ['OKR', 'SVI']);
  assert.equal(c.rev, 1);
  assert.equal(c.dirty, true);
  assert.throws(() => s.createCopilot({}), code('E_REQUIRED'));
  assert.throws(() => s.createCopilot({ name: 'x'.repeat(121) }), code('E_TOO_LONG'));
  assert.throws(() => s.createCopilot({ name: 'x', purpose: 'p'.repeat(2001) }), code('E_TOO_LONG'));
  assert.throws(() => s.createCopilot({ name: 'x', memory_scope: 'global' }), code('E_INVALID'));
  assert.throws(() => s.createCopilot({ name: 'x', user_id: OTHER }), code('E_UNKNOWN_FIELD'));
  assert.throws(() => s.createCopilot({ name: 'x', rev: 9 }), code('E_UNKNOWN_FIELD'));
  assert.throws(() => s.createCopilot({ name: 'x', answer_prefs: [] }), code('E_INVALID'));
  assert.throws(() => s.updateCopilot('nope', { name: 'y' }), code('E_NOT_FOUND'));
  const u = s.updateCopilot(c.id, { purpose: 'Weekly check-ins', memory_scope: 'copilot' });
  assert.equal(u.purpose, 'Weekly check-ins');
  assert.equal(u.memory_scope, 'copilot');
  assert.equal(s.listCopilots().length, 1);
  s.deleteCopilot(c.id);
  assert.equal(s.listCopilots().length, 0);
  assert.throws(() => s.updateCopilot(c.id, { name: 'z' }), code('E_NOT_FOUND'));
});

test('rev: edits coalesce while dirty, increment after the server acknowledges, survive in-flight edits', () => {
  const s = open();
  const a = s.syncAdapter();
  const c = s.createCopilot({ name: 'A' });
  s.updateCopilot(c.id, { name: 'B' });
  assert.equal(a.getRow('copilots', c.id).rev, 1, 'never synced: still rev 1');
  const snap = a.getRow('copilots', c.id);
  a.markSynced('copilots', c.id, { rev: snap.rev, seq: snap.seq });
  assert.equal(a.getRow('copilots', c.id).dirty, false);
  s.updateCopilot(c.id, { name: 'C' });
  s.updateCopilot(c.id, { name: 'D' });
  assert.equal(a.getRow('copilots', c.id).rev, 2);
  const inflight = a.getRow('copilots', c.id);
  s.updateCopilot(c.id, { name: 'E' }); // edited while the push of rev 2 is in flight
  a.markSynced('copilots', c.id, { rev: inflight.rev, seq: inflight.seq });
  const after = a.getRow('copilots', c.id);
  assert.equal(after.dirty, true, 'the in-flight edit is not lost');
  assert.equal(after.synced_rev, 2);
  assert.equal(after.rev, 3);
});

test('sessions and transcripts: saveTranscript opt-in, endSession idempotent', () => {
  const s = open();
  const c = s.createCopilot({ name: 'C' });
  const t = s.createThread(c.id, 'Weekly');
  assert.throws(() => s.createThread(c.id, 'x'.repeat(201)), code('E_TOO_LONG'));
  const off = s.startSession(t.id);
  assert.equal(off.save_transcript, false);
  assert.throws(() => s.addTranscriptLines(off.id, [{ speaker: 'me', text: 'hi' }]), code('E_TRANSCRIPT_DISABLED'));
  const on = s.startSession(t.id, { saveTranscript: true });
  const lines = s.addTranscriptLines(on.id, [{ speaker: 'them', text: 'Hello' }, { speaker: 'me', text: 'Hi' }]);
  assert.equal(lines.length, 2);
  assert.throws(() => s.addTranscriptLines(on.id, [{ speaker: 'bot', text: 'x' }]), code('E_INVALID'));
  const e1 = s.endSession(on.id);
  const e2 = s.endSession(on.id);
  assert.ok(e1.ended_at);
  assert.equal(e2.ended_at, e1.ended_at);
  assert.equal(s.listSessions(t.id).length, 2);
  assert.equal(s.listTranscript(on.id).length, 2);
});

test('memory: drafts are validated and only approved items are retrieved; origin cannot become my_speech', () => {
  const s = open();
  const c = s.createCopilot({ name: 'C' });
  const t = s.createThread(c.id, 'T');
  const ses = s.startSession(t.id);
  assert.throws(() => s.addMemoryDraft(ses.id, [{ kind: 'commitment', text: 'They will call', origin: 'their_speech' }]), code('E_COMMITMENT_ORIGIN'));
  assert.throws(() => s.addMemoryDraft(ses.id, [{ kind: 'topic', text: 'x' }]), code('E_INVALID'), 'origin is required');
  assert.throws(() => s.addMemoryDraft(ses.id, [{ kind: 'topic', text: 'x'.repeat(2001), origin: 'note' }]), code('E_TOO_LONG'));
  const [d1, d2] = s.addMemoryDraft(ses.id, [
    { kind: 'decision', text: 'Use OKR 2022', origin: 'their_speech' },
    { kind: 'action_item', text: 'Send the draft', origin: 'my_speech', due_at: '2026-11-01' },
  ]);
  assert.equal(d1.status, 'draft');
  assert.equal(d1.thread_id, t.id);
  assert.deepEqual(s.approvedMemory({ copilotId: c.id, threadId: t.id }), [], 'drafts never retrieved');
  assert.throws(() => s.updateMemory(d1.id, { origin: 'my_speech' }), code('E_ORIGIN_LOCKED'));
  s.updateMemory(d1.id, { origin: 'confirmed', kind: 'commitment' });
  s.approveMemory([d1.id, d2.id]);
  const got = s.approvedMemory({ copilotId: c.id, threadId: t.id });
  assert.deepEqual(got.map((m) => m.id).sort(), [d1.id, d2.id].sort());
  assert.deepEqual(Object.keys(got[0]).sort(), ['due_at', 'id', 'kind', 'session_id', 'source_at', 'text', 'thread_id']);
  assert.throws(() => s.approveMemory([d1.id, 'missing']), code('E_NOT_FOUND'));
});

test('approvedMemory: thread scope stays in the thread, copilot scope spans threads, never crosses copilots', () => {
  const s = open();
  const a = s.createCopilot({ name: 'Supervisor', memory_scope: 'thread' });
  const b = s.createCopilot({ name: 'Interviews', memory_scope: 'copilot' });
  const at1 = s.createThread(a.id, 'a1');
  const at2 = s.createThread(a.id, 'a2');
  const bt1 = s.createThread(b.id, 'b1');
  const bt2 = s.createThread(b.id, 'b2');
  const add = (thread, text) => {
    const ses = s.startSession(thread.id);
    const [m] = s.addMemoryDraft(ses.id, [{ kind: 'fact', text, origin: 'note' }]);
    s.approveMemory([m.id]);
    return m.id;
  };
  const ma1 = add(at1, 'a1 fact');
  add(at2, 'a2 fact');
  const mb1 = add(bt1, 'b1 fact');
  const mb2 = add(bt2, 'b2 fact');
  assert.deepEqual(s.approvedMemory({ copilotId: a.id, threadId: at1.id }).map((m) => m.id), [ma1]);
  assert.deepEqual(s.approvedMemory({ copilotId: a.id, threadId: null }), [], 'new thread: no memory');
  assert.deepEqual(s.approvedMemory({ copilotId: a.id, threadId: bt1.id }), [], 'thread from another copilot');
  assert.deepEqual(s.approvedMemory({ copilotId: b.id, threadId: null }).map((m) => m.id).sort(), [mb1, mb2].sort());
  assert.deepEqual(s.approvedMemory({ copilotId: b.id, threadId: at1.id }).map((m) => m.id).sort(), [mb1, mb2].sort(), 'copilot scope ignores a foreign thread');
  assert.equal(s.approvedMemory({ copilotId: b.id, threadId: null, limit: 1 }).length, 1);
  s.deleteThread(bt2.id);
  assert.deepEqual(s.approvedMemory({ copilotId: b.id }).map((m) => m.id), [mb1], 'deleted thread drops out');
});

test('forget: clears text, tombstones, drops from retrieval and clears summaries that cite it', () => {
  const s = open();
  const c = s.createCopilot({ name: 'C' });
  const t = s.createThread(c.id, 'T');
  const ses = s.startSession(t.id);
  const [m, keep] = s.addMemoryDraft(ses.id, [
    { kind: 'fact', text: 'He prefers email', origin: 'their_speech' },
    { kind: 'topic', text: 'Overlap paper', origin: 'note' },
  ]);
  s.approveMemory([m.id, keep.id]);
  s.setSessionSummary(ses.id, `He prefers email [MEM-${m.id}]`);
  const other = s.startSession(t.id);
  s.setSessionSummary(other.id, `Paper [MEM-${keep.id}]`);
  const r = s.forgetMemory(m.id);
  assert.deepEqual(r.clearedSummaries, [ses.id]);
  const raw = s.syncAdapter().getRow('memory_items', m.id);
  assert.equal(raw.text, '');
  assert.equal(raw.status, 'forgotten');
  assert.ok(raw.deleted_at);
  assert.equal(raw.dirty, true, 'the forget is pushed');
  assert.deepEqual(s.approvedMemory({ copilotId: c.id, threadId: t.id }).map((x) => x.id), [keep.id]);
  assert.equal(s.listSessions(t.id).find((x) => x.id === other.id).summary, `Paper [MEM-${keep.id}]`);
  assert.doesNotMatch(fs.readFileSync(s.file, 'utf8'), /He prefers email/);
  assert.throws(() => s.forgetMemory(m.id), code('E_NOT_FOUND'));
});

test('deleteThread and deleteCopilot cascade tombstones and clear content', () => {
  const s = open();
  const c = s.createCopilot({ name: 'C', purpose: 'private purpose' });
  const t = s.createThread(c.id, 'secret thread');
  const ses = s.startSession(t.id, { saveTranscript: true });
  s.addTranscriptLines(ses.id, [{ speaker: 'them', text: 'secret line' }]);
  s.addMemoryDraft(ses.id, [{ kind: 'fact', text: 'secret fact', origin: 'note' }]);
  const t2 = s.createThread(c.id, 'other');
  const r = s.deleteThread(t.id);
  assert.equal(r.cascaded, 3, 'session + transcript line + memory item');
  const a = s.syncAdapter();
  for (const table of ['threads', 'sessions', 'memory_items', 'transcript_lines']) {
    for (const row of a.dirtyRows(table).filter((x) => x.id !== t2.id)) {
      assert.ok(row.deleted_at, `${table} tombstoned`);
      assert.ok(!row.text && !row.title && !row.summary, `${table} content cleared`);
    }
  }
  assert.deepEqual(s.listThreads(c.id).map((x) => x.id), [t2.id]);
  const raw = fs.readFileSync(s.file, 'utf8');
  assert.doesNotMatch(raw, /secret (thread|line|fact)/);
  s.deleteCopilot(c.id);
  assert.ok(a.getRow('threads', t2.id).deleted_at, 'copilot delete cascades to threads');
  assert.equal(a.getRow('copilots', c.id).purpose, '');
});

test('profile and facts: lazy profile, settings validated, only shareable facts reach copilots', () => {
  const s = open();
  assert.equal(s.profile().rev, 0, 'not persisted before the first edit');
  assert.equal(s.syncAdapter().dirtyRows('profiles').length, 0);
  const p = s.updateProfile({ display_name: 'Avery', about: 'Data person', settings: { save_transcripts_default: true } });
  assert.equal(p.id, USER, 'profile id is the user id');
  assert.equal(p.settings.memory_enabled, true);
  assert.equal(p.settings.save_transcripts_default, true);
  assert.throws(() => s.updateProfile({ settings: { evil: true } }), code('E_UNKNOWN_FIELD'));
  assert.throws(() => s.updateProfile({ today_context: 'x'.repeat(2001) }), code('E_TOO_LONG'));
  const c = s.createCopilot({ name: 'C' });
  const t = s.createThread(c.id);
  assert.equal(s.startSession(t.id).save_transcript, true, 'default comes from settings');
  const f1 = s.addFact({ text: 'State University MS', shareable: true });
  s.addFact({ text: 'Private fact' });
  assert.deepEqual(s.factsForCopilot(c.id), [{ id: f1.id, text: 'State University MS' }]);
  s.updateCopilot(c.id, { use_profile_facts: false });
  assert.deepEqual(s.factsForCopilot(c.id), []);
  s.forgetFact(f1.id);
  assert.equal(s.listFacts().length, 1);
});

test('memory_enabled=false: nothing retrieved and no drafts accepted', () => {
  const s = open();
  const c = s.createCopilot({ name: 'C' });
  const t = s.createThread(c.id);
  const ses = s.startSession(t.id);
  const [m] = s.addMemoryDraft(ses.id, [{ kind: 'fact', text: 'x', origin: 'note' }]);
  s.approveMemory([m.id]);
  s.updateProfile({ settings: { memory_enabled: false } });
  assert.deepEqual(s.approvedMemory({ copilotId: c.id, threadId: t.id }), []);
  assert.throws(() => s.addMemoryDraft(ses.id, [{ kind: 'fact', text: 'y', origin: 'note' }]), code('E_MEMORY_DISABLED'));
});

test('exportAll: every live row, no tombstones, no local bookkeeping', () => {
  const s = open();
  const c = s.createCopilot({ name: 'C' });
  const gone = s.createCopilot({ name: 'Gone' });
  s.deleteCopilot(gone.id);
  s.createThread(c.id, 'T');
  s.addFact({ text: 'fact' });
  const out = s.exportAll();
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.account, USER);
  assert.deepEqual(out.copilots.map((x) => x.id), [c.id]);
  assert.equal(out.threads.length, 1);
  assert.equal(out.profile_facts.length, 1);
  const text = JSON.stringify(out);
  for (const f of ['"dirty"', '"synced_rev"', '"seq"', '"conflict"']) assert.ok(!text.includes(f), f);
});

test('wipeAccount removes only this account folder', () => {
  const root = tmpRoot();
  const mine = open(root, USER);
  const theirs = open(root, OTHER);
  mine.createCopilot({ name: 'mine' });
  theirs.createCopilot({ name: 'theirs' });
  const r = mine.wipeAccount();
  assert.deepEqual(r, { wiped: true, account: USER });
  assert.equal(fs.existsSync(path.join(root, 'vkin', USER)), false);
  assert.equal(fs.existsSync(path.join(root, 'vkin', OTHER, 'vkin.json')), true);
  assert.equal(mine.listCopilots().length, 0);
  assert.equal(open(root, OTHER).listCopilots().length, 1);
});

test('reload: a fresh instance reads what the previous one wrote', () => {
  const root = tmpRoot();
  const a = open(root);
  const c = a.createCopilot({ name: 'Persisted', keyterms: ['x'] });
  const b = open(root);
  assert.deepEqual(b.listCopilots().map((x) => x.name), ['Persisted']);
  assert.equal(b.getCopilot(c.id).keyterms[0], 'x');
});

test('migration: v0 prototype file upgrades to schemaVersion 1; newer and corrupt files are refused untouched', () => {
  const root = tmpRoot();
  const dir = path.join(root, 'vkin', USER);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'vkin.json');
  const cid = '33333333-3333-4333-8333-333333333333';
  fs.writeFileSync(file, JSON.stringify({ copilots: [{ id: cid, name: 'Old', purpose: '', memory_scope: 'thread' }, { id: 'bad', name: 'x' }] }));
  const s = open(root);
  assert.deepEqual(s.listCopilots().map((c) => c.name), ['Old']);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.schemaVersion, SCHEMA_VERSION);
  assert.equal(disk.tables.copilots[cid].dirty, true, 'unsynced prototype rows will be pushed');
  assert.equal(disk.tables.copilots[cid].rev, 1);

  const newer = JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, account: USER, tables: {} });
  fs.writeFileSync(file, newer);
  assert.throws(() => open(root).listCopilots(), code('E_SCHEMA_NEWER'));
  assert.equal(fs.readFileSync(file, 'utf8'), newer, 'not overwritten');

  fs.writeFileSync(file, '{not json');
  assert.throws(() => open(root).listCopilots(), code('E_STORE_CORRUPT'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json');

  assert.equal(migrateDoc({ schemaVersion: 1, account: USER, tables: {} }, USER).tables.memory_items !== undefined, true);
});

test('migration: a store file from another account is refused', () => {
  const root = tmpRoot();
  const dir = path.join(root, 'vkin', USER);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vkin.json'), JSON.stringify({ schemaVersion: 1, account: OTHER, tables: {}, cursors: {}, meta: {} }));
  assert.throws(() => open(root).listCopilots(), code('E_ACCOUNT_MISMATCH'));
});

test('importLegacy: one copilot per pack folder, idempotent, writes only the account store', () => {
  const root = tmpRoot();
  const packs = fs.mkdtempSync(path.join(os.tmpdir(), 'vkin-packs-'));
  fs.mkdirSync(path.join(packs, '2026-10-14-supervisor'));
  fs.writeFileSync(path.join(packs, '2026-10-14-supervisor', 'pack.json'), JSON.stringify({
    person: 'Prof. Example', summary: `Who: a professor.\n${'Long context. '.repeat(400)}`, keyterms: ['OKR', 'SVI', 'OKR', 42],
    records: [{ text: 'PERSONAL RECORD' }],
  }));
  fs.mkdirSync(path.join(packs, '2026-10-23-interview'));
  fs.writeFileSync(path.join(packs, '2026-10-23-interview', 'pack.json'), JSON.stringify({
    person: 'Hiring team', session: { title: 'Data Specialist interview' }, summary: 'Interview prep', keyterms: ['SKU'],
  }));
  fs.mkdirSync(path.join(packs, 'broken'));
  fs.writeFileSync(path.join(packs, 'broken', 'pack.json'), '{oops');
  fs.writeFileSync(path.join(packs, 'README.md'), 'not a folder');
  const packFilesBefore = listFiles(packs).sort();

  const s = open(root);
  const r1 = s.importLegacy({ meetingPacksDir: packs });
  assert.deepEqual(r1.imported.map((x) => x.name), ['Prof. Example', 'Data Specialist interview']);
  assert.deepEqual(r1.skipped, [{ folder: 'broken', reason: 'no_readable_pack' }]);
  const [sup, intv] = s.listCopilots();
  assert.ok(sup.purpose.length <= 2000 && sup.purpose.startsWith('Who: a professor.'));
  assert.deepEqual(sup.keyterms, ['OKR', 'SVI']);
  assert.deepEqual(intv.keyterms, ['SKU']);
  assert.doesNotMatch(fs.readFileSync(s.file, 'utf8'), /PERSONAL RECORD/, 'records are not copied');
  assert.equal(sup.local_only, true);
  const t = s.createThread(sup.id, 'under an imported copilot');
  const a = s.syncAdapter();
  assert.deepEqual(a.dirtyRows('copilots'), [], 'imported pack content is never synced without consent');
  assert.deepEqual(a.dirtyRows('threads'), []);
  s.allowSync(sup.id);
  assert.deepEqual(a.dirtyRows('copilots').map((x) => x.id), [sup.id]);
  assert.deepEqual(a.dirtyRows('threads').map((x) => x.id), [t.id]);
  assert.ok(!JSON.stringify(s.exportAll()).includes('local_only'));

  s.deleteCopilot(intv.id);
  const r2 = open(root).importLegacy({ meetingPacksDir: packs });
  assert.deepEqual(r2.imported, [], 'idempotent, and a deleted import is not resurrected');
  assert.equal(open(root).listCopilots().length, 1);
  assert.deepEqual(listFiles(root), [s.file], 'nothing written outside the account store');
  assert.deepEqual(listFiles(packs).sort(), packFilesBefore, 'packs untouched');
  assert.deepEqual(s.importLegacy({ meetingPacksDir: path.join(packs, 'missing') }), { imported: [], skipped: [] });
});

test('syncAdapter.applyRemote: rejects foreign rows, never resurrects, never overwrites local edits', () => {
  const s = open();
  const a = s.syncAdapter();
  const c = s.createCopilot({ name: 'Local' });
  const base = a.getRow('copilots', c.id);
  a.markSynced('copilots', c.id, { rev: 1, seq: base.seq });
  const srv = (over) => ({ id: c.id, user_id: USER, rev: 2, created_at: base.created_at, updated_at: '2026-10-28T11:00:00.000000+00:00', deleted_at: null, name: 'Remote', purpose: '', instructions: '', answer_prefs: {}, restricted_claims: [], memory_scope: 'thread', use_profile_facts: true, keyterms: [], ...over });

  assert.equal(a.applyRemote('copilots', srv({ user_id: OTHER })), 'rejected');
  s.updateCopilot(c.id, { name: 'Local edit' });
  assert.equal(a.applyRemote('copilots', srv()), 'conflict');
  assert.equal(s.getCopilot(c.id).name, 'Local edit', 'local edit kept');
  assert.equal(s.listConflicts().length, 1);
  const kept = s.resolveConflict('copilots', c.id, 'local');
  assert.equal(kept.rev, 3, 'rebased on server rev 2');
  assert.equal(a.getRow('copilots', c.id).synced_rev, 2);

  assert.equal(a.applyRemote('copilots', srv({ rev: 4, deleted_at: '2026-10-28T12:00:00+00:00', name: 'should be cleared' })), 'tombstoned_over_local_edit');
  assert.equal(a.getRow('copilots', c.id).name, '');
  assert.equal(a.applyRemote('copilots', srv({ rev: 5, deleted_at: null, name: 'Zombie' })), 'kept_tombstone');
  assert.ok(a.getRow('copilots', c.id).deleted_at, 'never resurrected');
  assert.equal(s.listCopilots().length, 0);
});

test('close and wipeAccount: later writes throw E_CLOSED and never touch disk', () => {
  const root = tmpRoot();
  const s = open(root);
  const c = s.createCopilot({ name: 'C' });
  const a = s.syncAdapter();
  const row = a.getRow('copilots', c.id);
  s.wipeAccount();
  const dir = path.join(root, 'vkin', USER);
  assert.throws(() => s.createCopilot({ name: 'again' }), code('E_CLOSED'));
  assert.throws(() => a.markSynced('copilots', c.id, { rev: 1, seq: row.seq }), code('E_CLOSED'));
  assert.throws(() => a.applyRemote('copilots', { ...row, rev: 2, user_id: USER }), code('E_CLOSED'));
  assert.throws(() => a.setCursor('copilots', { ts: 'x', id: c.id }), code('E_CLOSED'));
  assert.throws(() => s.importLegacy({ meetingPacksDir: root }), code('E_CLOSED'));
  assert.equal(fs.existsSync(dir), false, 'wiped folder not recreated');
  assert.deepEqual(s.listCopilots(), []);
  assert.equal(s.isClosed(), true);

  const s2 = open(root);
  s2.createCopilot({ name: 'kept' });
  const before = fs.readFileSync(s2.file, 'utf8');
  s2.close();
  assert.throws(() => s2.createCopilot({ name: 'late' }), code('E_CLOSED'));
  assert.equal(fs.readFileSync(s2.file, 'utf8'), before, 'close leaves disk untouched');
  assert.deepEqual(open(root).listCopilots().map((x) => x.name), ['kept']);
});

test('delete wins over a conflict: forget/forgetFact/deleteThread drop the server copy and rebase the rev', () => {
  const s = open();
  const a = s.syncAdapter();
  const c = s.createCopilot({ name: 'C' });
  const t = s.createThread(c.id, 'T');
  const ses = s.startSession(t.id);
  const [m, child] = s.addMemoryDraft(ses.id, [
    { kind: 'fact', text: 'mine', origin: 'note' },
    { kind: 'topic', text: 'child', origin: 'note' },
  ]);
  const f = s.addFact({ text: 'my fact' });
  for (const [table, id] of [['copilots', c.id], ['threads', t.id], ['sessions', ses.id], ['memory_items', m.id], ['memory_items', child.id], ['profile_facts', f.id]]) {
    const r = a.getRow(table, id);
    a.markSynced(table, id, { rev: r.rev, seq: r.seq });
  }
  const server = (table, id, over) => ({ ...a.getRow(table, id), ...over, rev: 4, user_id: USER, updated_at: '2026-10-28T12:00:00+00:00' });
  s.updateMemory(m.id, { text: 'mine edited' });
  assert.equal(a.applyRemote('memory_items', server('memory_items', m.id, { text: 'SERVER SECRET A' })), 'conflict');
  s.updateMemory(child.id, { text: 'child edited' });
  assert.equal(a.applyRemote('memory_items', server('memory_items', child.id, { text: 'SERVER SECRET B' })), 'conflict');
  assert.equal(a.markConflict('profile_facts', f.id, server('profile_facts', f.id, { text: 'SERVER FACT SECRET' }), 'rev_conflict'), 'conflict');
  assert.equal(s.listConflicts().length, 3);

  s.forgetMemory(m.id);
  const fm = a.getRow('memory_items', m.id);
  assert.equal(fm.conflict, undefined);
  assert.equal(fm.synced_rev, 4);
  assert.equal(fm.rev, 5);
  assert.equal(fm.dirty, true);
  assert.ok(a.dirtyRows('memory_items').some((r) => r.id === m.id), 'the forget will sync');
  assert.throws(() => s.resolveConflict('memory_items', m.id, 'server'), code('E_NOT_FOUND'), 'cannot restore forgotten text');

  s.deleteThread(t.id); // cascades onto the conflicted child
  const fc = a.getRow('memory_items', child.id);
  assert.equal(fc.conflict, undefined);
  assert.equal(fc.rev, 5);
  assert.ok(fc.deleted_at);

  s.forgetFact(f.id);
  const ff = a.getRow('profile_facts', f.id);
  assert.equal(ff.conflict, undefined);
  assert.equal(ff.rev, 5);
  assert.ok(a.dirtyRows('profile_facts').some((r) => r.id === f.id));
  assert.deepEqual(s.listConflicts(), []);
  assert.doesNotMatch(fs.readFileSync(s.file, 'utf8'), /SERVER (FACT )?SECRET|mine edited|child edited|my fact/);
});
