'use strict';
// Adopting records created before sign-in (the 'local' store) into the signed-in account's store.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVkinStore } = require('../src/main/vkin/store');

const USER = '11111111-1111-4111-8111-111111111111';
const code = (c) => (err) => err && err.code === c;

function clock() {
  let t = Date.parse('2026-10-28T10:00:00.000Z');
  return () => new Date((t += 1000)).toISOString();
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vkin-adopt-'));
  const now = clock();
  const local = createVkinStore({ dataRoot: root, account: 'local', now });
  const mine = createVkinStore({ dataRoot: root, account: USER, now });
  return { root, local, mine, now };
}

/** A realistic local store: one normal copilot tree, a deleted copilot, a legacy-imported pack, facts, profile. */
function seed(local, root) {
  const c = local.createCopilot({ name: 'Supervisor', purpose: 'weekly', keyterms: ['OKR'] });
  const t = local.createThread(c.id, 'Weekly');
  const sOn = local.startSession(t.id, { saveTranscript: true });
  local.addTranscriptLines(sOn.id, [{ speaker: 'them', text: 'line one' }, { speaker: 'me', text: 'line two' }]);
  const sOff = local.startSession(t.id);
  const [draft, approved, forgotten] = local.addMemoryDraft(sOn.id, [
    { kind: 'topic', text: 'draft topic', origin: 'their_speech' },
    { kind: 'commitment', text: 'I will send the table', origin: 'my_speech' },
    { kind: 'fact', text: 'FORGOTTEN SECRET', origin: 'note' },
  ]);
  local.approveMemory([approved.id]);
  local.forgetMemory(forgotten.id);
  local.setSessionSummary(sOn.id, `Promised the table [MEM-${approved.id}]`);
  const gone = local.createCopilot({ name: 'DELETED COPILOT' });
  local.deleteCopilot(gone.id);
  const packs = fs.mkdtempSync(path.join(root, 'packs-'));
  fs.mkdirSync(path.join(packs, 'p1'));
  fs.writeFileSync(path.join(packs, 'p1', 'pack.json'), JSON.stringify({ person: 'Imported Pack', summary: 'THIRD PARTY SUMMARY' }));
  const [imp] = local.importLegacy({ meetingPacksDir: packs }).imported;
  const fact = local.addFact({ text: 'State University MS', shareable: true });
  const goneFact = local.addFact({ text: 'FORGOTTEN FACT' });
  local.forgetFact(goneFact.id);
  local.updateProfile({ display_name: 'Avery', about: 'Data person', settings: { save_transcripts_default: true } });
  return { c, t, sOn, sOff, draft, approved, forgotten, gone, importedId: imp.copilotId, fact };
}

test('adoptFrom refuses a local target, a closed target or source, a non-local source and unknown copilots', () => {
  const { root, local, mine } = setup();
  assert.throws(() => local.adoptFrom(local), code('E_BAD_ACCOUNT'));
  assert.throws(() => mine.adoptFrom(mine), code('E_INVALID'));
  assert.throws(() => mine.adoptFrom(local, { copilotIds: ['33333333-3333-4333-8333-333333333333'] }), code('E_NOT_FOUND'));
  assert.throws(() => mine.adoptFrom(local, { copilotIds: 'all' }), code('E_INVALID'));
  const closedLocal = createVkinStore({ dataRoot: root, account: 'local' });
  closedLocal.close();
  assert.throws(() => mine.adoptFrom(closedLocal), code('E_CLOSED'));
  mine.close();
  assert.throws(() => mine.adoptFrom(local), code('E_CLOSED'));
  assert.throws(() => mine.purgeLocal({}), code('E_CLOSED'));
  assert.throws(() => createVkinStore({ dataRoot: root, account: USER }).purgeLocal({}), code('E_INVALID'));
});

test('adoptFrom copies live local records as new dirty rows with re-linked parents; skips tombstones and local_only', () => {
  const { root, local, mine } = setup();
  const src = seed(local, root);
  const localBefore = fs.readFileSync(local.file, 'utf8');
  const r = mine.adoptFrom(local);
  assert.deepEqual(r.adopted, { copilots: 1, threads: 1, sessions: 2, memory_items: 2, transcript_lines: 2, profile_facts: 1, profile: true });
  assert.deepEqual(r.skipped, []);
  assert.equal(r.removedFromLocal, false);
  assert.equal(fs.readFileSync(local.file, 'utf8'), localBefore, 'local store untouched without removeFromLocal');

  const [c] = mine.listCopilots();
  assert.deepEqual(r.copilots, [{ from: src.c.id, to: c.id }]);
  assert.notEqual(c.id, src.c.id, 'new id');
  assert.equal(c.name, 'Supervisor');
  assert.deepEqual(c.keyterms, ['OKR']);
  assert.equal(c.rev, 1);
  assert.equal(c.dirty, true);
  const [t] = mine.listThreads(c.id);
  assert.notEqual(t.id, src.t.id);
  const sessions = mine.listSessions(t.id);
  assert.equal(sessions.length, 2);
  const on = sessions.find((x) => x.save_transcript);
  assert.equal(on.copilot_id, c.id);
  assert.deepEqual(mine.listTranscript(on.id).map((l) => l.text), ['line one', 'line two']);
  const mem = mine.listMemory({ copilotId: c.id });
  assert.deepEqual(mem.map((m) => m.status).sort(), ['approved', 'draft']);
  for (const m of mem) {
    assert.equal(m.thread_id, t.id);
    assert.equal(m.session_id, on.id);
    assert.ok(![src.draft.id, src.approved.id].includes(m.id));
  }
  const approved = mem.find((m) => m.status === 'approved');
  assert.equal(approved.kind, 'commitment');
  assert.equal(approved.origin, 'my_speech');
  assert.equal(on.summary, `Promised the table [MEM-${approved.id}]`, 'summary citation re-pointed');
  assert.deepEqual(mine.approvedMemory({ copilotId: c.id, threadId: t.id }).map((m) => m.id), [approved.id]);
  assert.equal(mine.listFacts().length, 1);
  const p = mine.profile();
  assert.equal(p.id, USER);
  assert.equal(p.display_name, 'Avery');
  assert.equal(p.settings.save_transcripts_default, true);

  const a = mine.syncAdapter();
  for (const table of ['copilots', 'threads', 'sessions', 'memory_items', 'transcript_lines', 'profile_facts', 'profiles']) {
    for (const row of a.dirtyRows(table)) assert.equal(row.rev, 1, `${table} rev 1`);
  }
  assert.equal(a.dirtyRows('memory_items').length, 2);
  const text = fs.readFileSync(mine.file, 'utf8');
  assert.doesNotMatch(text, /FORGOTTEN|DELETED COPILOT|THIRD PARTY SUMMARY|Imported Pack/);
});

test('adoptFrom is idempotent and later adopts only rows created since', () => {
  const { root, local, mine } = setup();
  const src = seed(local, root);
  mine.adoptFrom(local);
  const again = mine.adoptFrom(local);
  assert.deepEqual(again.adopted, { copilots: 0, threads: 0, sessions: 0, memory_items: 0, transcript_lines: 0, profile_facts: 0, profile: false });
  assert.equal(again.copilots.length, 1, 'still reports the mapping');
  const t2 = local.createThread(src.c.id, 'Later thread');
  const reopened = createVkinStore({ dataRoot: root, account: USER }); // mapping persisted in the account folder
  const r3 = reopened.adoptFrom(local);
  assert.equal(r3.adopted.threads, 1);
  assert.equal(r3.adopted.copilots, 0);
  const [c] = reopened.listCopilots();
  assert.deepEqual(reopened.listThreads(c.id).map((x) => x.title).sort(), ['Later thread', 'Weekly']);
  assert.equal(reopened.listCopilots().length, 1);
  assert.ok(JSON.parse(fs.readFileSync(reopened.file, 'utf8')).meta.adopted[t2.id]);
});

test('adoptFrom keeps a non-empty account profile, still adopts facts, and only adopts selected copilots', () => {
  const { root, local, mine } = setup();
  const src = seed(local, root);
  const other = local.createCopilot({ name: 'Second' });
  mine.updateProfile({ display_name: 'Already set' });
  const r = mine.adoptFrom(local, { copilotIds: [other.id] });
  assert.equal(r.adopted.profile, false);
  assert.equal(mine.profile().display_name, 'Already set');
  assert.equal(mine.profile().about, '');
  assert.equal(r.adopted.profile_facts, 1);
  assert.deepEqual(mine.listCopilots().map((x) => x.name), ['Second']);
  assert.ok(!r.copilots.some((x) => x.from === src.c.id));
});

test('adoptFrom takes a legacy local_only copilot only when listed, and it stays local_only', () => {
  const { root, local, mine } = setup();
  const src = seed(local, root);
  const r = mine.adoptFrom(local, { copilotIds: [src.importedId] });
  assert.equal(r.adopted.copilots, 1);
  const [c] = mine.listCopilots();
  assert.equal(c.name, 'Imported Pack');
  assert.equal(c.local_only, true);
  assert.deepEqual(mine.syncAdapter().dirtyRows('copilots'), [], 'not synced until allowSync');
});

test('adoptFrom never copies transcript lines of a session that does not save transcripts', () => {
  const { local, mine } = setup();
  const c = local.createCopilot({ name: 'C' });
  const t = local.createThread(c.id, 'T');
  const s = local.startSession(t.id); // save_transcript false
  // A stray line (e.g. from an older build) under a no-transcript session.
  local.syncAdapter().applyRemote('transcript_lines', {
    id: '44444444-4444-4444-8444-444444444444', rev: 1, created_at: s.created_at, updated_at: s.created_at, deleted_at: null,
    session_id: s.id, speaker: 'them', text: 'STRAY LINE', at: s.created_at,
  });
  const r = mine.adoptFrom(local);
  assert.equal(r.adopted.sessions, 1);
  assert.equal(r.adopted.transcript_lines, 0);
  assert.doesNotMatch(fs.readFileSync(mine.file, 'utf8'), /STRAY LINE/);
});

test('removeFromLocal hard-deletes only what was adopted from the local store', () => {
  const { root, local, mine } = setup();
  const src = seed(local, root);
  const r = mine.adoptFrom(local, { removeFromLocal: true });
  assert.equal(r.removedFromLocal, true);
  assert.deepEqual(local.listCopilots().map((x) => x.id), [src.importedId], 'unadopted local_only pack stays');
  assert.equal(local.listFacts().length, 0);
  assert.equal(local.profile().rev, 0, 'copied profile removed');
  const raw = fs.readFileSync(local.file, 'utf8');
  assert.doesNotMatch(raw, /Supervisor|line one|I will send the table|State University MS|Avery/);
  assert.match(raw, /Imported Pack/);
  const fresh = createVkinStore({ dataRoot: root, account: USER });
  assert.equal(fresh.listCopilots()[0].name, 'Supervisor', 'adopted data persisted in the account store');
  assert.deepEqual(fresh.adoptFrom(createVkinStore({ dataRoot: root, account: 'local' })).adopted.copilots, 0);
});
