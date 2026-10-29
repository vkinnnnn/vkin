// @ts-check
'use strict';
// Vkin v1 record schema shared by the local store, sync and the migration tests (docs/vkin-contracts.md).
// The Postgres side lives in supabase/migrations/0001_vkin_init.sql; test/vkin-migration.test.js checks
// that the two agree on tables and columns.

class VkinError extends Error {
  /**
   * @param {string} code  stable machine code, e.g. E_INVALID, E_NOT_FOUND, E_ACCOUNT_MISMATCH
   * @param {string} message
   * @param {Record<string, unknown>} [extra]
   */
  constructor(code, message, extra) {
    super(message);
    this.name = 'VkinError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

// Push order for live rows: parents before children (composite FKs). Tombstones are pushed in reverse.
const TABLES = Object.freeze([
  'profiles', 'profile_facts', 'copilots', 'documents', 'threads', 'sessions', 'memory_items', 'transcript_lines',
]);

// Columns every table has. user_id and updated_at are server-owned and never pushed.
const COMMON_COLUMNS = Object.freeze(['id', 'rev', 'created_at', 'deleted_at']);
const SERVER_ONLY_COLUMNS = Object.freeze(['user_id', 'updated_at']);

/** Content columns per table (pushed besides COMMON_COLUMNS). */
const CONTENT_COLUMNS = Object.freeze({
  profiles: ['display_name', 'about', 'today_context', 'settings'],
  profile_facts: ['text', 'shareable', 'source'],
  copilots: ['name', 'purpose', 'instructions', 'answer_prefs', 'restricted_claims', 'memory_scope', 'use_profile_facts', 'keyterms'],
  documents: ['copilot_id', 'title', 'kind', 'storage_path', 'chars', 'approved'],
  threads: ['copilot_id', 'title', 'status'],
  sessions: ['copilot_id', 'thread_id', 'started_at', 'ended_at', 'save_transcript', 'summary'],
  memory_items: ['copilot_id', 'thread_id', 'session_id', 'kind', 'text', 'status', 'origin', 'source_at', 'due_at'],
  transcript_lines: ['session_id', 'speaker', 'text', 'at'],
});

/** Values written into content columns when a row becomes a tombstone (mirrors the SQL tombstone triggers). */
const TOMBSTONE_CLEAR = Object.freeze({
  profiles: { display_name: '', about: '', today_context: '', settings: {} },
  profile_facts: { text: '', source: '' },
  copilots: { name: '', purpose: '', instructions: '', answer_prefs: {}, restricted_claims: [], keyterms: [] },
  documents: { title: '', chars: 0 },
  threads: { title: '' },
  sessions: { summary: '' },
  memory_items: { text: '' },
  transcript_lines: { text: '' },
});

/** Parent links: table -> [{ column, parent }]. Used for local cascades. */
const PARENTS = Object.freeze({
  documents: [{ column: 'copilot_id', parent: 'copilots' }],
  threads: [{ column: 'copilot_id', parent: 'copilots' }],
  sessions: [{ column: 'thread_id', parent: 'threads' }],
  memory_items: [{ column: 'thread_id', parent: 'threads' }],
  transcript_lines: [{ column: 'session_id', parent: 'sessions' }],
});

const TIMESTAMP_COLUMNS = Object.freeze(['created_at', 'updated_at', 'deleted_at', 'started_at', 'ended_at', 'source_at', 'due_at', 'at']);

// Local-only bookkeeping fields, never pushed.
const LOCAL_FIELDS = Object.freeze(['dirty', 'synced_rev', 'seq', 'conflict', 'local_only']);

const LIMITS = Object.freeze({
  display_name: 120,
  about: 20000,
  today_context: 2000,
  fact_text: 2000,
  fact_source: 200,
  copilot_name: 120,
  purpose: 2000,
  instructions: 20000,
  claim: 500,
  claims_max: 200,
  keyterm: 100,
  keyterms_max: 500,
  json_bytes: 20000,
  document_title: 200,
  thread_title: 200,
  summary: 8000,
  memory_text: 2000,
  transcript_text: 10000,
  memory_batch: 200,
  transcript_batch: 500,
});

const ENUMS = Object.freeze({
  memory_scope: ['thread', 'copilot'],
  document_kind: ['about_me', 'about_them', 'notes', 'other'],
  thread_status: ['active', 'archived'],
  memory_kind: ['topic', 'decision', 'open_question', 'action_item', 'commitment', 'fact'],
  memory_status: ['draft', 'approved', 'forgotten'],
  memory_origin: ['my_speech', 'their_speech', 'confirmed', 'note'],
  commitment_origin: ['my_speech', 'confirmed'],
  speaker: ['me', 'them'],
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/** Columns sent to the server for a table, in a stable order. */
function pushColumns(table) {
  const content = CONTENT_COLUMNS[table];
  if (!content) throw new VkinError('E_INVALID', `unknown table ${table}`);
  return [...COMMON_COLUMNS, ...content];
}

/** Stable JSON for content comparison (object key order independent). */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

function sameValue(col, a, b) {
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  if (na === null || nb === null) return na === nb;
  if (TIMESTAMP_COLUMNS.includes(col)) return Date.parse(na) === Date.parse(nb);
  return stable(na) === stable(nb);
}

/** True when the server row holds the same revision and content as our local row. */
function sameContent(table, server, local) {
  if (!server || server.rev !== local.rev) return false;
  return ['deleted_at', ...CONTENT_COLUMNS[table]].every((c) => sameValue(c, server[c], local[c]));
}

module.exports = {
  VkinError,
  sameContent,
  TABLES,
  COMMON_COLUMNS,
  SERVER_ONLY_COLUMNS,
  CONTENT_COLUMNS,
  TOMBSTONE_CLEAR,
  PARENTS,
  TIMESTAMP_COLUMNS,
  LOCAL_FIELDS,
  LIMITS,
  ENUMS,
  isUuid,
  pushColumns,
};
