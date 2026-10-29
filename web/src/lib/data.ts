// Vkin data layer. Every function takes a Supabase-shaped client as its first argument so it can be
// tested with a fake. Rules come from docs/vkin-contracts.md:
//   - ids are client-generated UUIDs and writes are idempotent upserts on id
//   - user_id is never sent (the server sets it and RLS enforces it)
//   - an update sends rev = stored_rev + 1; a stale write is a conflict, never a silent overwrite
//   - reads filter deleted_at is null; deletes are tombstones with content cleared
//   - commitments require origin my_speech or confirmed
import {
  MEMORY_KINDS,
  MEMORY_ORIGINS,
  type AnswerPrefs,
  type Copilot,
  type CopilotInput,
  type MemoryItem,
  type MemoryKind,
  type Profile,
  type ProfileFact,
  type ProfileSettings,
  type Session,
  type Thread,
  type ThreadStatus,
} from './types';

// ---------------------------------------------------------------------------
// Client shape (subset of SupabaseClient that this module uses)
// ---------------------------------------------------------------------------

export interface SbError {
  message: string;
  code?: string;
  status?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface SbLike {
  from(table: string): any;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: SbError | null }>;
  storage?: {
    from(bucket: string): {
      remove(paths: string[]): PromiseLike<{ data: unknown; error: SbError | null }>;
      list(
        path?: string,
        options?: { limit?: number; offset?: number },
      ): PromiseLike<{ data: { name: string; id: string | null }[] | null; error: SbError | null }>;
    };
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface SbAuthLike {
  auth: { signOut(options?: { scope?: 'global' | 'local' | 'others' }): PromiseLike<{ error: SbError | null }> };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DataError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'DataError';
    this.code = code;
  }
}

/** The row was changed elsewhere (another device or the desktop app). The caller should refetch. */
export class ConflictError extends DataError {
  constructor(message = 'This item was changed elsewhere. Reload to see the latest version.') {
    super(message, 'conflict');
    this.name = 'ConflictError';
  }
}

export class ValidationError extends DataError {
  constructor(message: string) {
    super(message, 'validation');
    this.name = 'ValidationError';
  }
}

/** The row was deleted (tombstoned) elsewhere; the server never lets a tombstone be restored. */
export class TombstonedError extends DataError {
  constructor(message = 'This item was deleted elsewhere and cannot be restored. Reload to see the current state.') {
    super(message, 'tombstoned');
    this.name = 'TombstonedError';
  }
}

// SQLSTATEs raised by supabase/migrations/0001_vkin_init.sql (PostgREST passes them through as error.code).
export const PG_REV_CONFLICT = 'PT409'; // vkin_rev_conflict
export const PG_TOMBSTONED = 'PT410'; // vkin_tombstoned

export function isConflict(error: SbError | null | undefined): boolean {
  if (!error) return false;
  return error.code === PG_REV_CONFLICT || (error.message ?? '').startsWith('vkin_rev_conflict');
}

export function isTombstoned(error: SbError | null | undefined): boolean {
  if (!error) return false;
  return error.code === PG_TOMBSTONED || (error.message ?? '').startsWith('vkin_tombstoned');
}

function fail(error: SbError, context: string): never {
  if (isConflict(error)) throw new ConflictError();
  if (isTombstoned(error)) throw new TombstonedError();
  throw new DataError(`${context}: ${error.message}`, error.code);
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export const nowIso = (): string => new Date().toISOString();

const SERVER_FIELDS = ['user_id', 'id', 'rev', 'created_at', 'updated_at'] as const;

function clean(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if ((SERVER_FIELDS as readonly string[]).includes(k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

async function insertRow<T>(db: SbLike, table: string, fields: Record<string, unknown>, id = newId()): Promise<T> {
  const payload = { ...clean(fields), id, rev: 1 };
  const { data, error } = await db.from(table).upsert(payload, { onConflict: 'id' }).select().single();
  if (error) fail(error, `Could not save ${table}`);
  return data as T;
}

/** Update with optimistic concurrency: sends rev + 1 and only matches the revision we last read. */
async function updateRow<T extends { id: string; rev: number }>(
  db: SbLike,
  table: string,
  row: T,
  patch: Record<string, unknown>,
): Promise<T> {
  const payload = { ...clean(patch), rev: row.rev + 1 };
  const { data, error } = await db
    .from(table)
    .update(payload)
    .eq('id', row.id)
    .eq('rev', row.rev)
    .select()
    .maybeSingle();
  if (error) fail(error, `Could not update ${table}`);
  if (!data) throw new ConflictError();
  return data as T;
}

async function selectAll<T>(
  db: SbLike,
  table: string,
  build: (q: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<T[]> {
  const q = build(db.from(table).select('*').is('deleted_at', null));
  const { data, error } = await q;
  if (error) fail(error, `Could not load ${table}`);
  return (data ?? []) as T[];
}

function checkLen(label: string, value: string | null | undefined, max: number): void {
  if ((value ?? '').length > max) throw new ValidationError(`${label} is too long (maximum ${max} characters).`);
}

export function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseTerms(text: string): string[] {
  return text
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Copilots
// ---------------------------------------------------------------------------

export const DEFAULT_ANSWER_PREFS: AnswerPrefs = {
  length: 'balanced',
  tone: 'conversational',
  star: 'auto',
  filler: 'subtle',
  technical_depth: 'medium',
  format: 'prose',
};

export function validateCopilot(input: CopilotInput): CopilotInput {
  const name = input.name.trim();
  if (!name) throw new ValidationError('Give the copilot a name.');
  checkLen('Name', name, 120);
  checkLen('Purpose', input.purpose, 2000);
  checkLen('Instructions', input.instructions, 20000);
  if (input.restricted_claims.length > 200) throw new ValidationError('At most 200 restricted claims.');
  if (input.keyterms.length > 500) throw new ValidationError('At most 500 keyterms.');
  if (input.memory_scope !== 'thread' && input.memory_scope !== 'copilot') {
    throw new ValidationError('Memory scope must be thread or copilot.');
  }
  return {
    ...input,
    name,
    restricted_claims: input.restricted_claims.map((s) => s.trim()).filter(Boolean),
    keyterms: input.keyterms.map((s) => s.trim()).filter(Boolean),
  };
}

export async function listCopilots(db: SbLike): Promise<Copilot[]> {
  return selectAll<Copilot>(db, 'copilots', (q) => q.order('created_at', { ascending: false }));
}

export async function getCopilot(db: SbLike, id: string): Promise<Copilot | null> {
  const rows = await selectAll<Copilot>(db, 'copilots', (q) => q.eq('id', id));
  return rows[0] ?? null;
}

export async function createCopilot(db: SbLike, input: CopilotInput): Promise<Copilot> {
  return insertRow<Copilot>(db, 'copilots', { ...validateCopilot(input) });
}

export async function updateCopilot(db: SbLike, copilot: Copilot, input: CopilotInput): Promise<Copilot> {
  return updateRow<Copilot>(db, 'copilots', copilot, { ...validateCopilot(input) });
}

/**
 * Tombstones the copilot first (the server's cascade trigger tombstones its documents, threads, sessions,
 * memory items and transcript lines), then removes the stored files. If the tombstone fails (for example a
 * conflicting edit elsewhere), no file is removed, so live document rows never point at missing objects.
 */
export async function deleteCopilot(db: SbLike, copilot: Copilot): Promise<void> {
  const docs = await selectAll<{ id: string; storage_path: string | null }>(db, 'documents', (q) =>
    q.eq('copilot_id', copilot.id),
  );
  const paths = docs.map((d) => d.storage_path).filter((p): p is string => !!p);

  await updateRow(db, 'copilots', copilot, {
    name: '',
    purpose: '',
    instructions: '',
    restricted_claims: [],
    keyterms: [],
    deleted_at: nowIso(),
  });

  if (paths.length && db.storage) {
    const { error } = await db.storage.from('documents').remove(paths);
    if (error) throw new DataError(`Copilot deleted, but some stored documents could not be removed: ${error.message}`, error.code);
  }
}

// ---------------------------------------------------------------------------
// Threads and sessions
// ---------------------------------------------------------------------------

export async function listThreads(
  db: SbLike,
  copilotId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<Thread[]> {
  const rows = await selectAll<Thread>(db, 'threads', (q) =>
    q.eq('copilot_id', copilotId).order('created_at', { ascending: false }),
  );
  return opts.includeArchived ? rows : rows.filter((t) => t.status !== 'archived');
}

export async function getThread(db: SbLike, id: string): Promise<Thread | null> {
  const rows = await selectAll<Thread>(db, 'threads', (q) => q.eq('id', id));
  return rows[0] ?? null;
}

export async function createThread(db: SbLike, copilotId: string, title: string): Promise<Thread> {
  const t = title.trim();
  if (!t) throw new ValidationError('Give the thread a title.');
  checkLen('Title', t, 200);
  return insertRow<Thread>(db, 'threads', { copilot_id: copilotId, title: t, status: 'active' });
}

export async function setThreadStatus(db: SbLike, thread: Thread, status: ThreadStatus): Promise<Thread> {
  return updateRow<Thread>(db, 'threads', thread, { status });
}

/** Server function; tombstones the thread, its sessions, memory items and transcript lines. */
export async function deleteThread(db: SbLike, threadId: string): Promise<void> {
  const { error } = await db.rpc('vkin_delete_thread', { p_id: threadId });
  if (error) fail(error, 'Could not delete thread');
}

export async function listSessions(db: SbLike, threadId: string): Promise<Session[]> {
  return selectAll<Session>(db, 'sessions', (q) =>
    q.eq('thread_id', threadId).order('started_at', { ascending: false }),
  );
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const MEMORY_TEXT_MAX = 2000;

export function commitmentAllowed(origin: string): boolean {
  return origin === 'my_speech' || origin === 'confirmed';
}

/** Throws ValidationError if the item breaks a contract rule. */
export function assertMemoryValid(item: Pick<MemoryItem, 'kind' | 'origin' | 'text'>, opts: { allowEmpty?: boolean } = {}): void {
  if (!(MEMORY_KINDS as readonly string[]).includes(item.kind)) throw new ValidationError('Unknown memory kind.');
  if (!(MEMORY_ORIGINS as readonly string[]).includes(item.origin)) throw new ValidationError('Unknown memory origin.');
  if (item.kind === 'commitment' && !commitmentAllowed(item.origin)) {
    throw new ValidationError(
      'A commitment can only come from something you said or something you confirmed. Pick another kind, or confirm it first.',
    );
  }
  if (!opts.allowEmpty && !item.text.trim()) throw new ValidationError('Memory text cannot be empty.');
  checkLen('Memory text', item.text, MEMORY_TEXT_MAX);
}

export async function listMemory(db: SbLike, threadId: string): Promise<MemoryItem[]> {
  return selectAll<MemoryItem>(db, 'memory_items', (q) =>
    q.eq('thread_id', threadId).order('created_at', { ascending: true }),
  );
}

/** A note typed by the user. Origin is always 'note'; it starts as a draft. */
export async function createMemoryNote(
  db: SbLike,
  ctx: { copilotId: string; threadId: string },
  fields: { text: string; kind: MemoryKind; due_at?: string | null },
): Promise<MemoryItem> {
  const item = { kind: fields.kind, origin: 'note' as const, text: fields.text.trim() };
  assertMemoryValid(item);
  return insertRow<MemoryItem>(db, 'memory_items', {
    copilot_id: ctx.copilotId,
    thread_id: ctx.threadId,
    session_id: null,
    ...item,
    status: 'draft',
    source_at: nowIso(),
    due_at: fields.due_at ?? null,
  });
}

export async function updateMemory(
  db: SbLike,
  item: MemoryItem,
  patch: { text?: string; kind?: MemoryKind; due_at?: string | null },
): Promise<MemoryItem> {
  const merged = { kind: patch.kind ?? item.kind, origin: item.origin, text: (patch.text ?? item.text).trim() };
  assertMemoryValid(merged);
  return updateRow<MemoryItem>(db, 'memory_items', item, {
    text: merged.text,
    kind: merged.kind,
    due_at: patch.due_at === undefined ? item.due_at : patch.due_at,
  });
}

/** The user confirms that an item (from their conversation partner, or their own note) is accurate. */
export async function confirmMemory(db: SbLike, item: MemoryItem): Promise<MemoryItem> {
  if (item.origin !== 'their_speech' && item.origin !== 'note') {
    throw new ValidationError('Only items from their speech or your notes can be marked as confirmed.');
  }
  return updateRow<MemoryItem>(db, 'memory_items', item, { origin: 'confirmed' });
}

export interface ApproveResult {
  approved: MemoryItem[];
  failed: { item: MemoryItem; error: Error }[];
}

export async function approveMemory(db: SbLike, items: MemoryItem[]): Promise<ApproveResult> {
  const result: ApproveResult = { approved: [], failed: [] };
  for (const item of items) {
    try {
      if (item.status !== 'draft') throw new ValidationError('Only drafts can be approved.');
      assertMemoryValid(item);
      result.approved.push(await updateRow<MemoryItem>(db, 'memory_items', item, { status: 'approved' }));
    } catch (e) {
      result.failed.push({ item, error: e instanceof Error ? e : new Error(String(e)) });
    }
  }
  return result;
}

/**
 * Forget = status forgotten, text cleared, deleted_at set. If the item belonged to a session and
 * `clearSessionSummary` is set, that session's approved summary is cleared too (it may have cited the item).
 */
export async function forgetMemory(
  db: SbLike,
  item: MemoryItem,
  opts: { clearSessionSummary?: boolean } = {},
): Promise<MemoryItem> {
  const forgotten = await updateRow<MemoryItem>(db, 'memory_items', item, {
    status: 'forgotten',
    text: '',
    deleted_at: nowIso(),
  });
  if (opts.clearSessionSummary && item.session_id) {
    const sessions = await selectAll<Session>(db, 'sessions', (q) => q.eq('id', item.session_id));
    const s = sessions[0];
    // sessions.summary is NOT NULL; an empty string means "no summary".
    if (s && s.summary) await updateRow<Session>(db, 'sessions', s, { summary: '' });
  }
  return forgotten;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: Required<Pick<ProfileSettings, 'memory_enabled' | 'save_transcripts_default'>> = {
  memory_enabled: true,
  save_transcripts_default: false,
};

export function readSettings(profile: Pick<Profile, 'settings'>): { memory_enabled: boolean; save_transcripts_default: boolean } {
  const s = profile.settings ?? {};
  return {
    memory_enabled: typeof s.memory_enabled === 'boolean' ? s.memory_enabled : DEFAULT_SETTINGS.memory_enabled,
    save_transcripts_default:
      typeof s.save_transcripts_default === 'boolean' ? s.save_transcripts_default : DEFAULT_SETTINGS.save_transcripts_default,
  };
}

/** profiles.id equals the account id, so the first sign-in creates the row with id = user id. */
export async function getOrCreateProfile(db: SbLike, userId: string): Promise<Profile> {
  const { data, error } = await db.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) fail(error, 'Could not load profile');
  if (!data) {
    return insertRow<Profile>(
      db,
      'profiles',
      { display_name: '', about: '', today_context: '', settings: { ...DEFAULT_SETTINGS } },
      userId,
    );
  }
  const row = data as Profile;
  if (row.deleted_at) {
    // The server never restores a tombstone (PT410), so do not try. "Delete all my data" hard-deletes the
    // profile row instead, which lets the next sign-in create a fresh one.
    throw new TombstonedError(
      'Your profile was deleted and cannot be restored from the web app. Contact support, or delete all data and sign in again to start fresh.',
    );
  }
  return row;
}

export async function updateProfile(
  db: SbLike,
  profile: Profile,
  patch: { display_name?: string; about?: string; today_context?: string; settings?: Partial<ProfileSettings> },
): Promise<Profile> {
  if (patch.display_name !== undefined) checkLen('Display name', patch.display_name, 120);
  if (patch.about !== undefined) checkLen('About', patch.about, 20000);
  if (patch.today_context !== undefined) checkLen("Today's context", patch.today_context, 2000);
  const { settings, ...rest } = patch;
  const body: Record<string, unknown> = { ...rest };
  if (settings) body.settings = { ...(profile.settings ?? {}), ...settings };
  return updateRow<Profile>(db, 'profiles', profile, body);
}

export const FACT_MAX = 2000;

export async function listFacts(db: SbLike): Promise<ProfileFact[]> {
  return selectAll<ProfileFact>(db, 'profile_facts', (q) => q.order('created_at', { ascending: true }));
}

export async function createFact(db: SbLike, fields: { text: string; shareable: boolean }): Promise<ProfileFact> {
  const text = fields.text.trim();
  if (!text) throw new ValidationError('A fact cannot be empty.');
  checkLen('Fact', text, FACT_MAX);
  return insertRow<ProfileFact>(db, 'profile_facts', { text, shareable: fields.shareable, source: 'web' });
}

export async function updateFact(
  db: SbLike,
  fact: ProfileFact,
  patch: { text?: string; shareable?: boolean },
): Promise<ProfileFact> {
  const body: Record<string, unknown> = {};
  if (patch.text !== undefined) {
    const text = patch.text.trim();
    if (!text) throw new ValidationError('A fact cannot be empty.');
    checkLen('Fact', text, FACT_MAX);
    body.text = text;
  }
  if (patch.shareable !== undefined) body.shareable = patch.shareable;
  return updateRow<ProfileFact>(db, 'profile_facts', fact, body);
}

export async function forgetFact(db: SbLike, fact: ProfileFact): Promise<ProfileFact> {
  return updateRow<ProfileFact>(db, 'profile_facts', fact, { text: '', deleted_at: nowIso() });
}

// ---------------------------------------------------------------------------
// Export, account data deletion, sign-out
// ---------------------------------------------------------------------------

export const EXPORT_TABLES = [
  'profiles',
  'profile_facts',
  'copilots',
  'documents',
  'threads',
  'sessions',
  'memory_items',
  'transcript_lines',
] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];

const PAGE = 1000;

async function fetchAllRows(db: SbLike, table: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(table)
      .select('*')
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) fail(error, `Could not read ${table}`);
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

export interface VkinExport {
  format: 'vkin-export';
  version: 1;
  exported_at: string;
  user: { id: string; email: string | null };
  note: string;
  counts: Record<ExportTable, number>;
  data: Record<ExportTable, Record<string, unknown>[]>;
}

/** Reads every non-deleted row the user owns (RLS limits the reads to the signed-in account). */
export async function exportAll(db: SbLike, user: { id: string; email?: string | null }): Promise<VkinExport> {
  const data = {} as VkinExport['data'];
  const counts = {} as VkinExport['counts'];
  for (const table of EXPORT_TABLES) {
    data[table] = await fetchAllRows(db, table);
    counts[table] = data[table].length;
  }
  return {
    format: 'vkin-export',
    version: 1,
    exported_at: nowIso(),
    user: { id: user.id, email: user.email ?? null },
    note: 'Deleted and forgotten items are not included. Uploaded document files are not part of this export; only their metadata is.',
    counts,
    data,
  };
}

export function exportFilename(date = new Date()): string {
  return `vkin-export-${date.toISOString().slice(0, 10)}.json`;
}

export const DELETE_CONFIRMATION = 'DELETE MY DATA';

/** Lists every object under `<prefix>/` in the documents bucket (recursing into folders, paginated). */
async function listObjectPaths(db: SbLike, prefix: string): Promise<string[]> {
  const bucket = db.storage?.from('documents');
  if (!bucket) return [];
  const files: string[] = [];
  const folders = [prefix];
  const LIMIT = 100;
  while (folders.length) {
    const folder = folders.pop()!;
    for (let offset = 0; ; offset += LIMIT) {
      const { data, error } = await bucket.list(folder, { limit: LIMIT, offset });
      if (error) throw new DataError(`Could not list stored documents: ${error.message}`, error.code);
      const page = data ?? [];
      for (const entry of page) {
        // Folders come back without an id.
        if (entry.id === null) folders.push(`${folder}/${entry.name}`);
        else files.push(`${folder}/${entry.name}`);
      }
      if (page.length < LIMIT) break;
    }
  }
  return files;
}

/** Removes all of the user's stored document files. An empty bucket is fine. */
export async function removeUserStorage(db: SbLike, userId: string): Promise<number> {
  const bucket = db.storage?.from('documents');
  if (!bucket) return 0;
  const paths = await listObjectPaths(db, userId);
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await bucket.remove(paths.slice(i, i + 100));
    if (error) throw new DataError(`Could not remove stored documents: ${error.message}`, error.code);
  }
  return paths.length;
}

/**
 * Hard-deletes the user's data. Stored files go first (the SQL function cannot touch Storage); if that fails
 * nothing is deleted from the database, so the user can retry.
 */
export async function deleteAccountData(db: SbLike, userId: string, typedConfirmation: string): Promise<void> {
  if (typedConfirmation.trim() !== DELETE_CONFIRMATION) {
    throw new ValidationError(`Type ${DELETE_CONFIRMATION} exactly to confirm.`);
  }
  await removeUserStorage(db, userId);
  const { error } = await db.rpc('vkin_delete_account_data');
  if (error) fail(error, 'Could not delete your data');
}

export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

/** Key prefixes this app (and the Supabase client it configures) writes to browser storage. */
export const APP_STORAGE_PREFIXES = ['vkin.', 'sb-'] as const;

export function clearAppStorage(storages: StorageLike[], prefixes: readonly string[] = APP_STORAGE_PREFIXES): string[] {
  const removed: string[] = [];
  for (const s of storages) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && prefixes.some((p) => k.startsWith(p))) keys.push(k);
      }
      for (const k of keys) {
        s.removeItem(k);
        removed.push(k);
      }
    } catch {
      // Storage can be unavailable (private windows, blocked site data); nothing to clear then.
    }
  }
  return removed;
}

/**
 * Ends the Supabase session on this device, then removes every storage key the app created.
 * Storage is cleared even if the sign-out request fails; the failure is reported as `warning`.
 */
export async function signOutAndClear(
  client: SbAuthLike,
  storages: StorageLike[],
): Promise<{ removedKeys: string[]; warning: string | null }> {
  let warning: string | null = null;
  try {
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) warning = error.message;
  } catch (e) {
    warning = e instanceof Error ? e.message : String(e);
  }
  const removedKeys = clearAppStorage(storages);
  return { removedKeys, warning };
}
