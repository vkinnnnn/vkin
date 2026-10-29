import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  TombstonedError,
  isTombstoned,
  DELETE_CONFIRMATION,
  DEFAULT_ANSWER_PREFS,
  ValidationError,
  approveMemory,
  confirmMemory,
  createCopilot,
  createMemoryNote,
  deleteAccountData,
  deleteCopilot,
  deleteThread,
  exportAll,
  forgetMemory,
  getOrCreateProfile,
  getCopilot,
  isConflict,
  listCopilots,
  listMemory,
  readSettings,
  signOutAndClear,
  updateCopilot,
  updateMemory,
  updateProfile,
  type SbLike,
} from './data';
import type { Copilot, CopilotInput, MemoryItem } from './types';
import { FakeStorage, FakeSupabase } from '../test/fakeSupabase';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const input = (over: Partial<CopilotInput> = {}): CopilotInput => ({
  name: 'Interview prep',
  purpose: 'Practice',
  instructions: 'Be concise.',
  answer_prefs: { ...DEFAULT_ANSWER_PREFS },
  restricted_claims: [],
  memory_scope: 'thread',
  use_profile_facts: true,
  keyterms: [],
  ...over,
});

const memory = (over: Partial<MemoryItem> = {}): Record<string, unknown> => ({
  id: 'm1',
  copilot_id: 'c1',
  thread_id: 't1',
  session_id: null,
  kind: 'topic',
  text: 'Discussed the roadmap',
  status: 'draft',
  origin: 'their_speech',
  source_at: '2026-10-01T10:00:00.000Z',
  due_at: null,
  ...over,
});

describe('create writes', () => {
  it('uses a client-generated UUID, rev 1, and never sends user_id', async () => {
    const db = new FakeSupabase();
    const c = await createCopilot(db, input());
    expect(c.id).toMatch(UUID);
    expect(c.rev).toBe(1);
    expect(c.user_id).toBe(db.uid); // set by the server, not the client
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]!.op).toBe('upsert');
    expect('user_id' in db.writes[0]!.payload).toBe(false);
  });

  it('reads filter out tombstones', async () => {
    const db = new FakeSupabase();
    db.seed('copilots', [
      { id: 'a', name: 'Live' },
      { id: 'b', name: '', deleted_at: '2026-10-02T00:00:00.000Z' },
    ]);
    const rows = await listCopilots(db);
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });
});

describe('rev conflict handling', () => {
  it('sends rev = stored + 1 and succeeds when the row is current', async () => {
    const db = new FakeSupabase();
    const c = await createCopilot(db, input());
    const updated = await updateCopilot(db, c, input({ name: 'Renamed' }));
    expect(updated.rev).toBe(2);
    expect(updated.name).toBe('Renamed');
    const w = db.writes.at(-1)!;
    expect(w.payload.rev).toBe(2);
    expect('user_id' in w.payload).toBe(false);
  });

  it('throws ConflictError for a stale row, leaves the stored row alone, and works after a refetch', async () => {
    const db = new FakeSupabase();
    const c = await createCopilot(db, input());
    db.bump('copilots', c.id, { name: 'Edited on desktop' }); // another device wins first

    await expect(updateCopilot(db, c, input({ name: 'Mine' }))).rejects.toBeInstanceOf(ConflictError);
    expect(db.rows('copilots')[0]!.name).toBe('Edited on desktop');

    const fresh = (await getCopilot(db, c.id)) as Copilot;
    expect(fresh.rev).toBe(2);
    const retry = await updateCopilot(db, fresh, input({ name: 'Mine' }));
    expect(retry.rev).toBe(3);
  });

  it('maps a server-side vkin_rev_conflict (PT409) rejection to ConflictError', async () => {
    expect(isConflict({ message: 'vkin_rev_conflict: copilots x is at rev 3', code: 'PT409' })).toBe(true);
    expect(isConflict({ message: 'duplicate key', code: '23505' })).toBe(false);

    const db = new FakeSupabase();
    const c = await createCopilot(db, input());
    const rejecting = {
      ...db,
      from: () => {
        const q: Record<string, unknown> = {};
        for (const m of ['update', 'eq', 'select']) q[m] = () => q;
        q.maybeSingle = () =>
          Promise.resolve({ data: null, error: { message: 'vkin_rev_conflict: copilots x is at rev 3', code: 'PT409' } });
        return q;
      },
    } as unknown as SbLike;
    await expect(updateCopilot(rejecting, c, input())).rejects.toBeInstanceOf(ConflictError);
  });

  it('shows a conflict for memory edits too', async () => {
    const db = new FakeSupabase();
    db.seed('memory_items', [memory()]);
    const [item] = await listMemory(db, 't1');
    db.bump('memory_items', 'm1');
    await expect(updateMemory(db, item!, { text: 'new' })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('forget', () => {
  it('sets status forgotten, clears the text, sets deleted_at, bumps rev, and hides the item', async () => {
    const db = new FakeSupabase();
    db.seed('memory_items', [memory({ status: 'approved' })]);
    const [item] = await listMemory(db, 't1');
    const gone = await forgetMemory(db, item!);
    expect(gone.status).toBe('forgotten');
    expect(gone.text).toBe('');
    expect(gone.deleted_at).toBeTruthy();
    expect(gone.rev).toBe(item!.rev + 1);
    expect(await listMemory(db, 't1')).toHaveLength(0);
    // The stored row no longer holds the text anywhere.
    expect(JSON.stringify(db.rows('memory_items'))).not.toContain('Discussed the roadmap');
  });

  it('can also clear the summary of the session the item came from', async () => {
    const db = new FakeSupabase();
    db.seed('sessions', [{ id: 's1', copilot_id: 'c1', thread_id: 't1', started_at: '2026-10-01T10:00:00.000Z', summary: 'We talked roadmap.' }]);
    db.seed('memory_items', [memory({ session_id: 's1', status: 'approved' })]);
    const [item] = await listMemory(db, 't1');
    await forgetMemory(db, item!, { clearSessionSummary: true });
    expect(db.rows('sessions')[0]!.summary).toBe(''); // column is NOT NULL, so '' not null
    expect(db.writes.at(-1)!.payload.summary).toBe('');
    expect(db.rows('sessions')[0]!.rev).toBe(2);
  });
});

describe('commitment origin rule', () => {
  it('rejects turning their speech into a commitment, with no write', async () => {
    const db = new FakeSupabase();
    db.seed('memory_items', [memory({ origin: 'their_speech' })]);
    const [item] = await listMemory(db, 't1');
    await expect(updateMemory(db, item!, { kind: 'commitment' })).rejects.toBeInstanceOf(ValidationError);
    expect(db.writes).toHaveLength(0);
  });

  it('allows commitments for my_speech and for confirmed items', async () => {
    const db = new FakeSupabase();
    db.seed('memory_items', [memory({ id: 'a', origin: 'my_speech' }), memory({ id: 'b', origin: 'their_speech' })]);
    const [mine, theirs] = await listMemory(db, 't1');
    expect((await updateMemory(db, mine!, { kind: 'commitment' })).kind).toBe('commitment');
    const confirmed = await confirmMemory(db, theirs!);
    expect(confirmed.origin).toBe('confirmed');
    expect((await updateMemory(db, confirmed, { kind: 'commitment' })).kind).toBe('commitment');
  });

  it('does not let a note be created as a commitment', async () => {
    const db = new FakeSupabase();
    await expect(
      createMemoryNote(db, { copilotId: 'c1', threadId: 't1' }, { text: 'I will send the deck', kind: 'commitment' }),
    ).rejects.toBeInstanceOf(ValidationError);
    const ok = await createMemoryNote(db, { copilotId: 'c1', threadId: 't1' }, { text: 'Likes concise answers', kind: 'fact' });
    expect(ok.origin).toBe('note');
    expect(ok.status).toBe('draft');
  });

  it('does not approve an inconsistent commitment but approves the rest', async () => {
    const db = new FakeSupabase();
    db.seed('memory_items', [
      memory({ id: 'bad', kind: 'commitment', origin: 'their_speech' }), // e.g. written by another client
      memory({ id: 'good', kind: 'decision', origin: 'their_speech' }),
    ]);
    const items = await listMemory(db, 't1');
    const res = await approveMemory(db, items);
    expect(res.approved.map((i) => i.id)).toEqual(['good']);
    expect(res.failed.map((f) => f.item.id)).toEqual(['bad']);
    expect(db.rows('memory_items').find((r) => r.id === 'bad')!.status).toBe('draft');
    expect(db.rows('memory_items').find((r) => r.id === 'good')!.status).toBe('approved');
  });
});

describe('export', () => {
  it('has the documented shape, includes only my live rows, and covers every table', async () => {
    const db = new FakeSupabase();
    db.seed('profiles', [{ id: db.uid, display_name: 'Sam', about: '', today_context: '', settings: {} }]);
    db.seed('copilots', [{ id: 'c1', name: 'A' }, { id: 'c2', name: '', deleted_at: '2026-10-02T00:00:00.000Z' }]);
    db.seed('threads', [{ id: 't1', copilot_id: 'c1', title: 'T', status: 'active' }]);
    db.seed('memory_items', [memory(), memory({ id: 'm2', text: '', status: 'forgotten', deleted_at: '2026-10-02T00:00:00.000Z' })]);
    db.tables['copilots']!.push({ id: 'other', name: 'Not mine', user_id: 'someone-else', rev: 1, created_at: '', updated_at: '', deleted_at: null });

    const out = await exportAll(db, { id: db.uid, email: 'sam@example.com' });
    expect(out.format).toBe('vkin-export');
    expect(out.version).toBe(1);
    expect(new Date(out.exported_at).toString()).not.toBe('Invalid Date');
    expect(out.user).toEqual({ id: db.uid, email: 'sam@example.com' });
    expect(Object.keys(out.data).sort()).toEqual(
      ['copilots', 'documents', 'memory_items', 'profile_facts', 'profiles', 'sessions', 'threads', 'transcript_lines'],
    );
    expect(out.counts).toMatchObject({ profiles: 1, copilots: 1, threads: 1, memory_items: 1, documents: 0 });
    expect(out.data.copilots.map((r) => r.id)).toEqual(['c1']);
    expect(JSON.stringify(out)).not.toContain('Not mine');
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });

  it('pages through more than one page of rows', async () => {
    const db = new FakeSupabase();
    db.seed(
      'profile_facts',
      Array.from({ length: 1203 }, (_, i) => ({ id: `f${String(i).padStart(5, '0')}`, text: `fact ${i}`, shareable: false })),
    );
    const out = await exportAll(db, { id: db.uid });
    expect(out.counts.profile_facts).toBe(1203);
  });
});

describe('sign-out storage cleanup', () => {
  it('ends the session locally and removes only the keys the app and supabase client created', async () => {
    const db = new FakeSupabase();
    const local = new FakeStorage();
    const session = new FakeStorage();
    local.setItem('vkin.auth', '{"access_token":"x"}');
    local.setItem('sb-abcdef-auth-token', '{}');
    local.setItem('vkin.ui.lastCopilot', 'c1');
    local.setItem('unrelated.key', 'keep');
    session.setItem('vkin.draft', 'text');
    session.setItem('sb-abcdef-auth-token-code-verifier', 'v');
    session.setItem('other', 'keep');

    const res = await signOutAndClear(db, [local, session]);
    expect(db.signOutCalls).toEqual([{ scope: 'local' }]);
    expect(local.keys()).toEqual(['unrelated.key']);
    expect(session.keys()).toEqual(['other']);
    expect(res.removedKeys).toHaveLength(5);
    expect(res.warning).toBeNull();
  });

  it('still clears storage when the sign-out request fails, and reports it', async () => {
    const db = new FakeSupabase();
    db.signOutError = { message: 'network down' };
    const local = new FakeStorage();
    local.setItem('vkin.auth', 'x');
    const res = await signOutAndClear(db, [local]);
    expect(local.keys()).toEqual([]);
    expect(res.warning).toBe('network down');
  });
});

describe('other operations call the server', () => {
  it('deleteThread calls rpc vkin_delete_thread', async () => {
    const db = new FakeSupabase();
    await deleteThread(db, 't1');
    // The SQL parameter is p_id (supabase/migrations/0001_vkin_init.sql).
    expect(db.rpcCalls).toEqual([{ fn: 'vkin_delete_thread', args: { p_id: 't1' } }]);
  });

  it('deleteAccountData needs the typed confirmation, then calls the rpc with no arguments', async () => {
    const db = new FakeSupabase();
    await expect(deleteAccountData(db, db.uid, 'delete')).rejects.toBeInstanceOf(ValidationError);
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.listCalls).toHaveLength(0);
    await deleteAccountData(db, db.uid, DELETE_CONFIRMATION); // empty bucket is fine
    expect(db.rpcCalls).toEqual([{ fn: 'vkin_delete_account_data', args: undefined }]);
  });

  it('deleteAccountData removes every stored object under <uid>/ (nested, paginated) before the rpc', async () => {
    const db = new FakeSupabase();
    const names = Array.from({ length: 230 }, (_, i) => `${db.uid}/cop1/doc${String(i).padStart(3, '0')}`);
    db.objects = [...names, `${db.uid}/cop2/only`, 'someone-else/cop9/theirs'];
    const order: string[] = [];
    const origRpc = db.rpc.bind(db);
    db.rpc = (fn, args) => {
      order.push(`rpc:${fn}:remaining=${db.objects.filter((o) => o.startsWith(db.uid + '/')).length}`);
      return origRpc(fn, args);
    };
    await deleteAccountData(db, db.uid, DELETE_CONFIRMATION);
    expect(db.removedPaths).toHaveLength(231);
    expect(db.removedPaths.every((p) => p.startsWith(`${db.uid}/`))).toBe(true);
    expect(db.removeBatches.every((b) => b.length <= 100)).toBe(true);
    expect(db.objects).toEqual(['someone-else/cop9/theirs']);
    expect(order).toEqual(['rpc:vkin_delete_account_data:remaining=0']);
    expect(db.listCalls.some((c) => (c.offset ?? 0) >= 200)).toBe(true); // went past the first pages
  });

  it('deleteAccountData does not touch the database if the storage cleanup fails', async () => {
    const db = new FakeSupabase();
    db.objects = [`${db.uid}/c/d`];
    db.storage.from = () => ({
      list: () => Promise.resolve({ data: null, error: { message: 'storage down' } }),
      remove: () => Promise.resolve({ data: null, error: null }),
    });
    await expect(deleteAccountData(db, db.uid, DELETE_CONFIRMATION)).rejects.toThrow(/storage down/);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('deleteCopilot removes its stored files and tombstones the copilot with content cleared (server cascades children)', async () => {
    const db = new FakeSupabase();
    const c = await createCopilot(db, input({ purpose: 'secret purpose', instructions: 'secret instructions' }));
    db.seed('documents', [{ id: 'd1', copilot_id: c.id, title: 'CV', storage_path: `${db.uid}/${c.id}/d1`, kind: 'about_me', approved: false }]);
    await deleteCopilot(db, c);
    expect(db.removedPaths).toEqual([`${db.uid}/${c.id}/d1`]);
    const row = db.rows('copilots')[0]!;
    expect(row.deleted_at).toBeTruthy();
    expect(row.name).toBe('');
    expect(row.purpose).toBe('');
    expect(row.instructions).toBe('');
  });

  it('a tombstoned profile gives an honest error instead of trying to revive it', async () => {
    const db = new FakeSupabase();
    db.seed('profiles', [{ id: db.uid, display_name: '', about: '', today_context: '', settings: {}, deleted_at: '2026-10-02T00:00:00.000Z' }]);
    await expect(getOrCreateProfile(db, db.uid)).rejects.toBeInstanceOf(TombstonedError);
    expect(db.writes).toHaveLength(0);
  });

  it('maps the exact SQLSTATEs PT409 and PT410', () => {
    expect(isConflict({ message: 'anything', code: 'PT409' })).toBe(true);
    expect(isConflict({ message: 'vkin_rev_conflict: x', code: undefined })).toBe(true);
    expect(isConflict({ message: 'a conflict of interest', code: '23505' })).toBe(false);
    expect(isTombstoned({ message: 'x', code: 'PT410' })).toBe(true);
    expect(isTombstoned({ message: 'x', code: 'PT409' })).toBe(false);
  });

  it('getOrCreateProfile creates the profile with id = account id once, and merges settings on update', async () => {
    const db = new FakeSupabase();
    const p = await getOrCreateProfile(db, db.uid);
    expect(p.id).toBe(db.uid);
    expect(readSettings(p)).toEqual({ memory_enabled: true, save_transcripts_default: false });
    const again = await getOrCreateProfile(db, db.uid);
    expect(again.rev).toBe(1);
    expect(db.rows('profiles')).toHaveLength(1);

    const next = await updateProfile(db, p, { settings: { save_transcripts_default: true } });
    expect(readSettings(next)).toEqual({ memory_enabled: true, save_transcripts_default: true });
    expect(next.rev).toBe(2);
  });
});
