// @ts-check
'use strict';
// Vkin local store (docs/vkin-contracts.md, "Desktop local store").
//
// One JSON file per account: <dataRoot>/vkin/<account>/vkin.json, where <account> is 'local' before sign-in
// and the Supabase user id after. Writes are atomic (tmp file + rename). Every record carries the server
// shape (id, rev, created_at, updated_at, deleted_at + content columns) plus local bookkeeping:
//   dirty       true when the row has local changes not yet acknowledged by the server
//   synced_rev  the last rev the server acknowledged (0 = never synced)
//   seq         local edit counter, so an edit made while a push is in flight is not marked clean
//   conflict    { server, reason, at } when the server holds a newer revision than our base (never auto-merged)
//
// rev rule: the server accepts an update only with rev = stored_rev + 1. Local edits therefore coalesce: the
// first edit after a sync sets rev = synced_rev + 1, further edits before the next push keep that rev.
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const {
  VkinError, TABLES, CONTENT_COLUMNS, TOMBSTONE_CLEAR, PARENTS, LOCAL_FIELDS, LIMITS, ENUMS, isUuid, sameContent,
} = require('./schema');

const SCHEMA_VERSION = 1;
const FILE_NAME = 'vkin.json';

/**
 * MIGRATIONS[i] upgrades a document from schemaVersion i to i + 1. SCHEMA_VERSION === MIGRATIONS.length.
 * v0 is the pre-release prototype layout: top-level arrays per table and no schemaVersion.
 * @type {Array<(doc: any) => any>}
 */
const MIGRATIONS = [
  (doc) => {
    const out = emptyDoc(doc.account || 'local');
    for (const t of TABLES) {
      const rows = Array.isArray(doc[t]) ? doc[t] : (doc.tables && doc.tables[t]) || [];
      for (const r of Array.isArray(rows) ? rows : Object.values(rows)) {
        if (!r || !isUuid(r.id)) continue;
        out.tables[t][r.id] = {
          ...r,
          rev: Number.isInteger(r.rev) && r.rev > 0 ? r.rev : 1,
          deleted_at: r.deleted_at || null,
          dirty: r.dirty !== false,
          synced_rev: Number.isInteger(r.synced_rev) ? r.synced_rev : 0,
          seq: Number.isInteger(r.seq) ? r.seq : 1,
        };
      }
    }
    if (doc.meta && typeof doc.meta === 'object') out.meta = { ...out.meta, ...doc.meta };
    return out;
  },
];

function emptyDoc(account) {
  /** @type {Record<string, Record<string, any>>} */
  const tables = {};
  for (const t of TABLES) tables[t] = {};
  return { schemaVersion: SCHEMA_VERSION, account, tables, cursors: {}, meta: { legacyImports: {}, adopted: {} } };
}

/** Upgrades a parsed document to SCHEMA_VERSION. Throws on a newer (unknown) version. */
function migrateDoc(doc, account) {
  let d = doc && typeof doc === 'object' ? doc : {};
  let v = Number.isInteger(d.schemaVersion) ? d.schemaVersion : 0;
  if (v > SCHEMA_VERSION) {
    throw new VkinError('E_SCHEMA_NEWER', `store schemaVersion ${v} is newer than this app (${SCHEMA_VERSION})`);
  }
  if (v === 0 && !d.account) d = { ...d, account };
  while (v < SCHEMA_VERSION) {
    d = MIGRATIONS[v](d);
    v += 1;
    d.schemaVersion = v;
  }
  for (const t of TABLES) if (!d.tables[t]) d.tables[t] = {};
  if (!d.cursors) d.cursors = {};
  if (!d.meta) d.meta = { legacyImports: {} };
  if (!d.meta.legacyImports) d.meta.legacyImports = {};
  if (!d.meta.adopted) d.meta.adopted = {};
  return d;
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ---------- validation ----------

/** @returns {never} */
function fail(code, message, field) {
  throw new VkinError(code, message, field ? { field } : undefined);
}

function checkKeys(obj, allowed, what) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail('E_INVALID', `${what} must be an object`);
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail('E_UNKNOWN_FIELD', `${what}: field "${k}" is not allowed`, k);
  }
}

function vStr(v, field, max, { required = false } = {}) {
  if (required && (v === undefined || v === null)) fail('E_REQUIRED', `${field} is required`, field);
  if (typeof v !== 'string') fail('E_INVALID', `${field} must be a string`, field);
  const s = v.trim();
  if (required && !s) fail('E_REQUIRED', `${field} is required`, field);
  if (s.length > max) fail('E_TOO_LONG', `${field} exceeds ${max} characters`, field);
  return s;
}

function vBool(v, field) {
  if (typeof v !== 'boolean') fail('E_INVALID', `${field} must be true or false`, field);
  return v;
}

function vEnum(v, field, allowed) {
  if (!allowed.includes(v)) fail('E_INVALID', `${field} must be one of ${allowed.join(', ')}`, field);
  return v;
}

function vStrArray(v, field, maxItems, maxLen) {
  if (!Array.isArray(v)) fail('E_INVALID', `${field} must be a list of strings`, field);
  if (v.length > maxItems) fail('E_TOO_LONG', `${field} has more than ${maxItems} entries`, field);
  const out = [];
  for (const s of v) {
    const t = vStr(s, field, maxLen);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function vJson(v, field) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('E_INVALID', `${field} must be an object`, field);
  const text = JSON.stringify(v);
  if (Buffer.byteLength(text, 'utf8') > LIMITS.json_bytes) fail('E_TOO_LONG', `${field} is too large`, field);
  return JSON.parse(text);
}

function vTime(v, field, { nullable = true } = {}) {
  if (v === null || v === undefined) {
    if (nullable) return null;
    fail('E_REQUIRED', `${field} is required`, field);
  }
  const ms = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(ms)) fail('E_INVALID', `${field} must be a timestamp`, field);
  return new Date(ms).toISOString();
}

function vId(v, field = 'id') {
  if (!isUuid(v)) fail('E_BAD_ID', `${field} must be a UUID`, field);
  return String(v).toLowerCase();
}

function vSettings(v) {
  checkKeys(v, ['save_transcripts_default', 'memory_enabled'], 'settings');
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = vBool(val, `settings.${k}`);
  return out;
}

const COPILOT_FIELDS = Object.freeze(['name', 'purpose', 'instructions', 'answer_prefs', 'restricted_claims', 'memory_scope', 'use_profile_facts', 'keyterms']);

function copilotPatch(fields, { creating }) {
  checkKeys(fields, COPILOT_FIELDS, 'copilot');
  const out = {};
  if (creating || 'name' in fields) out.name = vStr(fields.name, 'name', LIMITS.copilot_name, { required: true });
  if ('purpose' in fields) out.purpose = vStr(fields.purpose, 'purpose', LIMITS.purpose);
  if ('instructions' in fields) out.instructions = vStr(fields.instructions, 'instructions', LIMITS.instructions);
  if ('answer_prefs' in fields) out.answer_prefs = vJson(fields.answer_prefs, 'answer_prefs');
  if ('restricted_claims' in fields) out.restricted_claims = vStrArray(fields.restricted_claims, 'restricted_claims', LIMITS.claims_max, LIMITS.claim);
  if ('memory_scope' in fields) out.memory_scope = vEnum(fields.memory_scope, 'memory_scope', ENUMS.memory_scope);
  if ('use_profile_facts' in fields) out.use_profile_facts = vBool(fields.use_profile_facts, 'use_profile_facts');
  if ('keyterms' in fields) out.keyterms = vStrArray(fields.keyterms, 'keyterms', LIMITS.keyterms_max, LIMITS.keyterm);
  return out;
}

function memoryItem(item) {
  checkKeys(item, ['kind', 'text', 'origin', 'source_at', 'due_at'], 'memory item');
  const kind = vEnum(item.kind, 'kind', ENUMS.memory_kind);
  const origin = vEnum(item.origin, 'origin', ENUMS.memory_origin);
  if (kind === 'commitment' && !ENUMS.commitment_origin.includes(origin)) {
    fail('E_COMMITMENT_ORIGIN', 'a commitment must come from my own speech or be confirmed', 'origin');
  }
  return {
    kind,
    origin,
    text: vStr(item.text, 'text', LIMITS.memory_text, { required: true }),
    source_at: vTime(item.source_at, 'source_at'),
    due_at: vTime(item.due_at, 'due_at'),
  };
}

// ---------- store ----------

/**
 * @param {{ dataRoot: string, account?: string, now?: () => string, newId?: () => string }} opts
 */
function createVkinStore({ dataRoot, account = 'local', now = () => new Date().toISOString(), newId = () => nodeCrypto.randomUUID() }) {
  if (!dataRoot || typeof dataRoot !== 'string') throw new VkinError('E_INVALID', 'dataRoot is required');
  if (account !== 'local' && !isUuid(account)) throw new VkinError('E_BAD_ACCOUNT', 'account must be "local" or a user id');
  const acct = account === 'local' ? 'local' : account.toLowerCase();
  const vkinRoot = path.resolve(dataRoot, 'vkin');
  const dir = path.join(vkinRoot, acct);
  const file = path.join(dir, FILE_NAME);
  if (path.dirname(dir) !== vkinRoot) throw new VkinError('E_BAD_ACCOUNT', 'account path escapes the store root');

  /** @type {any} */
  let doc = null;
  let batching = 0;
  // Closed by close() or wipeAccount(): reads see an empty store, writes throw E_CLOSED and never touch disk
  // (an in-flight sync holding this instance must not recreate a wiped folder).
  let closed = false;
  let pending = false;

  function load() {
    if (!fs.existsSync(file)) return emptyDoc(acct);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new VkinError('E_STORE_CORRUPT', 'the local Vkin store could not be read');
    }
    const before = parsed && parsed.schemaVersion;
    const d = migrateDoc(parsed, acct);
    if (d.account !== acct) throw new VkinError('E_ACCOUNT_MISMATCH', 'store file belongs to a different account');
    if (before !== d.schemaVersion) { doc = d; writeNow(); }
    return d;
  }

  function data() {
    if (closed) return doc || (doc = emptyDoc(acct));
    if (!doc) doc = load();
    return doc;
  }

  function assertOpen() {
    if (closed) throw new VkinError('E_CLOSED', 'this Vkin store has been closed');
  }

  function writeNow() {
    assertOpen();
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${nodeCrypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 });
    // Windows can briefly refuse a rename while an indexer/AV holds the target; retry a few times.
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(/** @type {any} */ (err).code)) {
          try { fs.unlinkSync(tmp); } catch {}
          throw err;
        }
        const until = Date.now() + 20 * (i + 1);
        while (Date.now() < until) { /* short sync back-off */ }
      }
    }
  }

  function save() {
    assertOpen();
    if (batching) { pending = true; return; }
    writeNow();
  }

  /** Runs fn with a single write at the end (used by sync and multi-row operations). */
  function batch(fn) {
    batching += 1;
    try {
      return fn();
    } finally {
      batching -= 1;
      if (!batching && pending) { pending = false; writeNow(); }
    }
  }

  const rows = (t) => data().tables[t];

  function newRow(t, fields, id = newId()) {
    assertOpen();
    const ts = now();
    const row = { id: vId(id), rev: 1, created_at: ts, updated_at: ts, deleted_at: null, ...fields, dirty: true, synced_rev: 0, seq: 1 };
    rows(t)[row.id] = row;
    return row;
  }

  /** Marks a local change on row (coalescing rev, see header). */
  function touch(row) {
    assertOpen();
    if (!row.dirty) {
      row.rev = (row.synced_rev || 0) + 1;
      row.dirty = true;
    }
    row.seq = (row.seq || 0) + 1;
    row.updated_at = now();
  }

  /**
   * Delete wins over an unresolved conflict: drop the stored server copy (it may hold the text being
   * forgotten) and rebase on its rev, so the tombstone is pushed instead of being parked as a conflict.
   */
  function deleteWins(row) {
    if (!row.conflict) return;
    const srv = row.conflict.server;
    delete row.conflict;
    if (srv && Number.isInteger(srv.rev)) {
      row.synced_rev = Math.max(row.synced_rev || 0, srv.rev);
      row.rev = row.synced_rev + 1;
      row.dirty = true;
    }
  }

  function tombstone(t, row) {
    if (row.deleted_at) return false;
    deleteWins(row);
    Object.assign(row, clone(TOMBSTONE_CLEAR[t]));
    if (t === 'memory_items') row.status = 'forgotten';
    row.deleted_at = now();
    touch(row);
    return true;
  }

  /** Tombstones every live descendant of (t, id). Returns the number of rows tombstoned. */
  function cascade(t, id) {
    let n = 0;
    for (const [child, links] of Object.entries(PARENTS)) {
      for (const { column, parent } of links) {
        if (parent !== t) continue;
        for (const r of Object.values(rows(child))) {
          if (r[column] === id && !r.deleted_at) {
            // Memory under a deleted thread is tombstoned but keeps status (it was not "forgotten" by the user).
            deleteWins(r);
            Object.assign(r, clone(TOMBSTONE_CLEAR[child]));
            r.deleted_at = now();
            touch(r);
            n += 1 + cascade(child, r.id);
          }
        }
      }
    }
    return n;
  }

  function live(t, id, what = t) {
    const r = isUuid(id) ? rows(t)[String(id).toLowerCase()] : null;
    if (!r || r.deleted_at) fail('E_NOT_FOUND', `${what} not found`);
    return r;
  }

  /** Public copy of a row: no local bookkeeping except dirty/conflict flags. */
  function view(r) {
    if (!r) return null;
    const out = clone(r);
    delete out.synced_rev;
    delete out.seq;
    out.conflict = Boolean(r.conflict);
    return out;
  }

  /** @type {(t: string, pred?: (r: any) => boolean) => any[]} */
  const liveRows = (t, pred = (_r) => true) => Object.values(rows(t)).filter((r) => !r.deleted_at && pred(r));
  const byCreated = (a, b) => String(a.created_at).localeCompare(String(b.created_at));

  // ---------- profile ----------

  function profileRow() {
    const id = acct === 'local' ? null : acct;
    const list = Object.values(rows('profiles')).filter((r) => !r.deleted_at);
    return (id && rows('profiles')[id]) || list[0] || null;
  }

  const DEFAULT_SETTINGS = Object.freeze({ save_transcripts_default: false, memory_enabled: true });

  function profile() {
    const r = profileRow();
    if (r) return { ...view(r), settings: { ...DEFAULT_SETTINGS, ...(r.settings || {}) } };
    // Not persisted until the user edits it, so a fresh device never pushes an empty profile over a real one.
    return { id: acct === 'local' ? null : acct, display_name: '', about: '', today_context: '', settings: { ...DEFAULT_SETTINGS }, rev: 0, dirty: false, conflict: false };
  }

  function updateProfile(patch) {
    checkKeys(patch, ['display_name', 'about', 'today_context', 'settings'], 'profile');
    const p = {};
    if ('display_name' in patch) p.display_name = vStr(patch.display_name, 'display_name', LIMITS.display_name);
    if ('about' in patch) p.about = vStr(patch.about, 'about', LIMITS.about);
    if ('today_context' in patch) p.today_context = vStr(patch.today_context, 'today_context', LIMITS.today_context);
    let r = profileRow();
    if ('settings' in patch) p.settings = { ...DEFAULT_SETTINGS, ...((r && r.settings) || {}), ...vSettings(patch.settings) };
    if (!r) {
      r = newRow('profiles', { display_name: '', about: '', today_context: '', settings: { ...DEFAULT_SETTINGS }, ...p }, acct === 'local' ? newId() : acct);
    } else {
      Object.assign(r, p);
      touch(r);
    }
    save();
    return profile();
  }

  const settings = () => profile().settings;

  function listFacts() {
    return liveRows('profile_facts').sort(byCreated).map(view);
  }

  function addFact(fields) {
    checkKeys(fields, ['text', 'shareable', 'source'], 'fact');
    const r = newRow('profile_facts', {
      text: vStr(fields.text, 'text', LIMITS.fact_text, { required: true }),
      shareable: 'shareable' in fields ? vBool(fields.shareable, 'shareable') : false,
      source: 'source' in fields ? vStr(fields.source, 'source', LIMITS.fact_source) : '',
    });
    save();
    return view(r);
  }

  function forgetFact(id) {
    const r = live('profile_facts', id, 'fact');
    tombstone('profile_facts', r);
    save();
    return { id: r.id, forgotten: true };
  }

  /** Facts a copilot may use: shareable facts only, and none when the copilot opted out. */
  function factsForCopilot(copilotId) {
    const c = live('copilots', copilotId, 'copilot');
    if (c.use_profile_facts === false) return [];
    return liveRows('profile_facts', (f) => f.shareable === true).sort(byCreated).map((f) => ({ id: f.id, text: f.text }));
  }

  // ---------- copilots ----------

  function createCopilot(fields) {
    const p = copilotPatch(fields, { creating: true });
    const r = newRow('copilots', {
      name: p.name,
      purpose: p.purpose ?? '',
      instructions: p.instructions ?? '',
      answer_prefs: p.answer_prefs ?? {},
      restricted_claims: p.restricted_claims ?? [],
      memory_scope: p.memory_scope ?? 'thread',
      use_profile_facts: p.use_profile_facts ?? true,
      keyterms: p.keyterms ?? [],
    });
    save();
    return view(r);
  }

  function updateCopilot(id, patch) {
    const r = live('copilots', id, 'copilot');
    const p = copilotPatch(patch, { creating: false });
    if (!Object.keys(p).length) return view(r);
    Object.assign(r, p);
    touch(r);
    save();
    return view(r);
  }

  function deleteCopilot(id) {
    const r = live('copilots', id, 'copilot');
    const cascaded = batch(() => {
      tombstone('copilots', r);
      return cascade('copilots', r.id);
    });
    save();
    return { id: r.id, deleted: true, cascaded };
  }

  function getCopilot(id) {
    return view(live('copilots', id, 'copilot'));
  }

  /** Lets a local-only (imported) copilot and everything under it sync to the account. */
  function allowSync(id) {
    assertOpen();
    const r = live('copilots', id, 'copilot');
    if (r.local_only) {
      delete r.local_only;
      save();
    }
    return view(r);
  }

  function listCopilots() {
    return liveRows('copilots').sort(byCreated).map(view);
  }

  // ---------- threads ----------

  function createThread(copilotId, title = '') {
    const c = live('copilots', copilotId, 'copilot');
    const r = newRow('threads', {
      copilot_id: c.id,
      title: vStr(title ?? '', 'title', LIMITS.thread_title),
      status: 'active',
    });
    save();
    return view(r);
  }

  function updateThread(id, patch) {
    const r = live('threads', id, 'thread');
    checkKeys(patch, ['title', 'status'], 'thread');
    if ('title' in patch) r.title = vStr(patch.title, 'title', LIMITS.thread_title);
    if ('status' in patch) r.status = vEnum(patch.status, 'status', ENUMS.thread_status);
    touch(r);
    save();
    return view(r);
  }

  function listThreads(copilotId) {
    const c = live('copilots', copilotId, 'copilot');
    return liveRows('threads', (t) => t.copilot_id === c.id).sort(byCreated).map(view);
  }

  /** Tombstones the thread, its sessions, memory items and transcript lines (server: vkin_delete_thread). */
  function deleteThread(id) {
    const r = live('threads', id, 'thread');
    const cascaded = batch(() => {
      tombstone('threads', r);
      return cascade('threads', r.id);
    });
    save();
    return { id: r.id, deleted: true, cascaded };
  }

  // ---------- sessions ----------

  function startSession(threadId, opts = {}) {
    const t = live('threads', threadId, 'thread');
    live('copilots', t.copilot_id, 'copilot');
    checkKeys(opts || {}, ['saveTranscript'], 'session options');
    const save_transcript = opts && opts.saveTranscript !== undefined
      ? vBool(opts.saveTranscript, 'saveTranscript')
      : Boolean(settings().save_transcripts_default);
    const r = newRow('sessions', {
      copilot_id: t.copilot_id,
      thread_id: t.id,
      started_at: now(),
      ended_at: null,
      save_transcript,
      summary: '',
    });
    save();
    return view(r);
  }

  function endSession(id) {
    const r = live('sessions', id, 'session');
    if (!r.ended_at) {
      r.ended_at = now();
      touch(r);
      save();
    }
    return view(r);
  }

  function setSessionSummary(id, summary) {
    const r = live('sessions', id, 'session');
    r.summary = vStr(summary, 'summary', LIMITS.summary);
    touch(r);
    save();
    return view(r);
  }

  function listSessions(threadId) {
    const t = live('threads', threadId, 'thread');
    return liveRows('sessions', (s) => s.thread_id === t.id).sort(byCreated).map(view);
  }

  // ---------- transcript ----------

  function addTranscriptLines(sessionId, lines) {
    const s = live('sessions', sessionId, 'session');
    if (!s.save_transcript) fail('E_TRANSCRIPT_DISABLED', 'transcript saving is off for this session');
    if (!Array.isArray(lines) || lines.length > LIMITS.transcript_batch) fail('E_INVALID', 'lines must be a list');
    const clean = lines.map((l) => {
      checkKeys(l, ['speaker', 'text', 'at'], 'transcript line');
      return {
        speaker: vEnum(l.speaker, 'speaker', ENUMS.speaker),
        text: vStr(l.text, 'text', LIMITS.transcript_text, { required: true }),
        at: vTime(l.at ?? now(), 'at', { nullable: false }),
      };
    });
    const out = batch(() => clean.map((l) => view(newRow('transcript_lines', { session_id: s.id, ...l }))));
    save();
    return out;
  }

  function listTranscript(sessionId) {
    const s = live('sessions', sessionId, 'session');
    return liveRows('transcript_lines', (l) => l.session_id === s.id)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .map(view);
  }

  // ---------- memory ----------

  function addMemoryDraft(sessionId, items) {
    const s = live('sessions', sessionId, 'session');
    if (settings().memory_enabled === false) fail('E_MEMORY_DISABLED', 'memory is turned off in settings');
    if (!Array.isArray(items) || items.length > LIMITS.memory_batch) fail('E_INVALID', 'items must be a list');
    const clean = items.map(memoryItem);
    const out = batch(() => clean.map((it) => view(newRow('memory_items', {
      copilot_id: s.copilot_id,
      thread_id: s.thread_id,
      session_id: s.id,
      status: 'draft',
      ...it,
    }))));
    save();
    return out;
  }

  function updateMemory(id, patch) {
    const r = live('memory_items', id, 'memory item');
    checkKeys(patch, ['text', 'kind', 'origin', 'due_at', 'source_at'], 'memory patch');
    const next = { ...r };
    if ('text' in patch) next.text = vStr(patch.text, 'text', LIMITS.memory_text, { required: true });
    if ('kind' in patch) next.kind = vEnum(patch.kind, 'kind', ENUMS.memory_kind);
    if ('origin' in patch) {
      // The user may confirm an item; nothing may relabel an item as their own speech after the fact.
      if (patch.origin !== 'confirmed' && patch.origin !== r.origin) {
        fail('E_ORIGIN_LOCKED', 'origin can only be changed to "confirmed"', 'origin');
      }
      next.origin = patch.origin;
    }
    if ('due_at' in patch) next.due_at = vTime(patch.due_at, 'due_at');
    if ('source_at' in patch) next.source_at = vTime(patch.source_at, 'source_at');
    if (next.kind === 'commitment' && !ENUMS.commitment_origin.includes(next.origin)) {
      fail('E_COMMITMENT_ORIGIN', 'a commitment must come from my own speech or be confirmed', 'origin');
    }
    Object.assign(r, next);
    touch(r);
    save();
    return view(r);
  }

  function approveMemory(ids) {
    if (!Array.isArray(ids)) fail('E_INVALID', 'ids must be a list');
    const targets = ids.map((id) => live('memory_items', id, 'memory item')); // validate all before writing
    batch(() => {
      for (const r of targets) {
        if (r.status !== 'approved') {
          r.status = 'approved';
          touch(r);
        }
      }
    });
    save();
    return targets.map(view);
  }

  /** Forget: status forgotten, text cleared, tombstoned; session summaries citing MEM-<id> are cleared. */
  function forgetMemory(id) {
    const r = live('memory_items', id, 'memory item');
    const cite = `MEM-${r.id}`;
    const clearedSummaries = batch(() => {
      tombstone('memory_items', r); // sets status 'forgotten', text '' and deleted_at
      const cleared = [];
      for (const s of liveRows('sessions', (x) => typeof x.summary === 'string' && x.summary.includes(cite))) {
        s.summary = '';
        touch(s);
        cleared.push(s.id);
      }
      return cleared;
    });
    save();
    return { id: r.id, forgotten: true, clearedSummaries };
  }

  function listMemory({ copilotId = null, threadId = null, sessionId = null, status = null } = {}) {
    if (!copilotId && !threadId && !sessionId) fail('E_REQUIRED', 'copilotId, threadId or sessionId is required');
    if (status !== null) vEnum(status, 'status', ['draft', 'approved']);
    const lc = (v) => (v ? String(v).toLowerCase() : null);
    [copilotId, threadId, sessionId] = [lc(copilotId), lc(threadId), lc(sessionId)];
    return liveRows('memory_items', (m) =>
      (!copilotId || m.copilot_id === copilotId)
      && (!threadId || m.thread_id === threadId)
      && (!sessionId || m.session_id === sessionId)
      && (!status || m.status === status))
      .sort(byCreated)
      .map(view);
  }

  /**
   * Retrieval input for answers. Approved, live items only; never crosses copilots.
   * thread scope: only threadId's items (none when threadId is null = a new thread).
   * copilot scope: every live thread of that copilot.
   */
  function approvedMemory({ copilotId, threadId = null, limit = 50 } = /** @type {any} */ ({})) {
    const c = live('copilots', copilotId, 'copilot');
    if (settings().memory_enabled === false) return [];
    const n = Math.max(0, Math.min(500, Number.isInteger(limit) ? limit : 50));
    let threadOk;
    if (c.memory_scope === 'copilot') {
      const liveThreads = new Set(liveRows('threads', (t) => t.copilot_id === c.id).map((t) => t.id));
      threadOk = (m) => liveThreads.has(m.thread_id);
    } else {
      if (!threadId) return [];
      const t = rows('threads')[String(threadId).toLowerCase()];
      if (!t || t.deleted_at || t.copilot_id !== c.id) return [];
      threadOk = (m) => m.thread_id === t.id;
    }
    return liveRows('memory_items', (m) => m.copilot_id === c.id && m.status === 'approved' && threadOk(m))
      .sort((a, b) => String(b.source_at || b.created_at).localeCompare(String(a.source_at || a.created_at)))
      .slice(0, n)
      .map((m) => ({ id: m.id, kind: m.kind, text: m.text, source_at: m.source_at, due_at: m.due_at, thread_id: m.thread_id, session_id: m.session_id }));
  }

  // ---------- export / wipe ----------

  function exportAll() {
    const strip = (r) => {
      const o = clone(r);
      for (const f of LOCAL_FIELDS) delete o[f];
      return o;
    };
    const out = { app: 'Vkin — The Meeting Copilot', schemaVersion: SCHEMA_VERSION, exportedAt: now(), account: acct };
    for (const t of TABLES) out[t] = liveRows(t).sort(byCreated).map(strip);
    return out;
  }

  /** Closes this instance: later writes throw E_CLOSED, reads see an empty store. Disk is left as is. */
  function close() {
    closed = true;
    doc = emptyDoc(acct);
  }

  /**
   * Deletes this account's local folder (private device state) and closes this instance, so a sync still
   * holding it cannot write the folder back.
   */
  function wipeAccount() {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== vkinRoot) throw new VkinError('E_BAD_ACCOUNT', 'refusing to wipe outside the store root');
    closed = true;
    doc = emptyDoc(acct);
    fs.rmSync(resolved, { recursive: true, force: true });
    return { wiped: true, account: acct };
  }

  // ---------- conflicts ----------

  function listConflicts() {
    const out = [];
    for (const t of TABLES) {
      for (const r of Object.values(rows(t))) {
        if (r.conflict) out.push({ table: t, id: r.id, reason: r.conflict.reason, at: r.conflict.at, local: view(r), server: clone(r.conflict.server) });
      }
    }
    return out;
  }

  /** keep: 'server' replaces the local row with the server copy; 'local' rebases the local edit on it. */
  function resolveConflict(table, id, keep) {
    assertOpen();
    if (!TABLES.includes(table)) fail('E_INVALID', 'unknown table');
    vEnum(keep, 'keep', ['local', 'server']);
    const r = rows(table)[String(id).toLowerCase()];
    if (!r || !r.conflict) fail('E_NOT_FOUND', 'no conflict for that row');
    const server = r.conflict.server;
    if (keep === 'server' || !server || server.deleted_at) {
      if (server) rows(table)[r.id] = fromServer(table, server);
      else delete r.conflict;
    } else {
      delete r.conflict;
      r.synced_rev = server.rev;
      r.rev = server.rev + 1;
      r.dirty = true;
      r.seq = (r.seq || 0) + 1;
    }
    save();
    return view(rows(table)[r.id]);
  }

  // ---------- sync adapter (used by sync.js only) ----------

  function fromServer(t, srv) {
    const row = { id: String(srv.id).toLowerCase(), rev: srv.rev, created_at: srv.created_at, updated_at: srv.updated_at, deleted_at: srv.deleted_at || null };
    if (srv.user_id) row.user_id = srv.user_id;
    for (const c of CONTENT_COLUMNS[t]) if (c in srv) row[c] = clone(srv[c]);
    if (row.deleted_at) Object.assign(row, clone(TOMBSTONE_CLEAR[t]));
    return { ...row, dirty: false, synced_rev: srv.rev, seq: 0 };
  }

  function syncAdapter() {
    return {
      account: acct,
      tables: TABLES,
      batch,
      /**
       * Dirty rows not in conflict and not under a local-only copilot, as copies (with seq so a concurrent
       * edit is detected).
       */
      dirtyRows(t) {
        const blocked = new Set(Object.values(rows('copilots')).filter((c) => c.local_only).map((c) => c.id));
        const copilotOf = (r) => {
          if (t === 'copilots') return r.id;
          if (t === 'transcript_lines') return (rows('sessions')[r.session_id] || {}).copilot_id;
          return r.copilot_id;
        };
        return Object.values(rows(t)).filter((r) => r.dirty && !r.conflict && !blocked.has(copilotOf(r))).map(clone);
      },
      getRow(t, id) {
        return clone(rows(t)[id]) || null;
      },
      /** Server acknowledged rev for row id. server: the row the server returned (may be a tombstone). */
      markSynced(t, id, { rev, seq, server = null }) {
        assertOpen();
        const r = rows(t)[id];
        if (!r) return;
        if (server && server.deleted_at && !r.deleted_at) {
          rows(t)[id] = fromServer(t, server);
          cascade(t, id);
        } else {
          r.synced_rev = Math.max(r.synced_rev || 0, rev);
          if (server && server.updated_at) r.updated_at = server.updated_at;
          if (server && server.user_id) r.user_id = server.user_id;
          if (r.seq === seq && r.rev === rev) r.dirty = false;
          else if (r.rev <= r.synced_rev) r.rev = r.synced_rev + 1; // edited during the push: next rev
        }
        save();
      },
      /** Parks a row as a conflict; a local tombstone instead rebases (delete wins). Returns 'conflict'|'rebased'. */
      markConflict(t, id, server, reason) {
        assertOpen();
        const r = rows(t)[id];
        if (!r) return 'conflict';
        r.conflict = { server: server ? clone(server) : null, reason, at: now() };
        if (r.deleted_at) {
          deleteWins(r);
          save();
          return 'rebased';
        }
        save();
        return 'conflict';
      },
      /**
       * Applies a pulled server row. Never resurrects a tombstone; never overwrites unsynced local edits
       * (those become conflicts). Returns what happened.
       */
      applyRemote(t, srv) {
        assertOpen();
        if (!srv || !isUuid(srv.id)) return 'rejected';
        if (srv.user_id && srv.user_id !== acct) return 'rejected';
        const id = String(srv.id).toLowerCase();
        const local = rows(t)[id];
        if (!local) {
          rows(t)[id] = fromServer(t, srv);
          if (srv.deleted_at) cascade(t, id);
          save();
          return srv.deleted_at ? 'tombstoned' : 'inserted';
        }
        if (srv.rev <= (local.synced_rev || 0)) return 'skipped';
        if (local.dirty && srv.rev === local.rev && sameContent(t, srv, local)) {
          // Our own write whose response was lost: the server already has exactly this row.
          local.synced_rev = srv.rev;
          local.dirty = false;
          local.updated_at = srv.updated_at;
          delete local.conflict;
          save();
          return 'acknowledged';
        }
        if (local.deleted_at && !srv.deleted_at) {
          // Delete wins over a concurrent remote edit: rebase our tombstone on the newer server rev.
          local.synced_rev = srv.rev;
          local.rev = srv.rev + 1;
          local.dirty = true;
          delete local.conflict;
          save();
          return 'kept_tombstone';
        }
        if (srv.deleted_at) {
          const hadLocalEdits = Boolean(local.dirty && !local.deleted_at);
          rows(t)[id] = fromServer(t, srv);
          cascade(t, id);
          save();
          return hadLocalEdits ? 'tombstoned_over_local_edit' : 'tombstoned';
        }
        if (local.dirty) {
          const known = Boolean(local.conflict);
          local.conflict = { server: clone(srv), reason: known ? local.conflict.reason : 'remote_changed', at: now() };
          save();
          return known ? 'conflict_updated' : 'conflict';
        }
        rows(t)[id] = fromServer(t, srv);
        save();
        return 'updated';
      },
      getCursor(t) {
        return clone(data().cursors[t]) || null;
      },
      setCursor(t, cursor) {
        assertOpen();
        data().cursors[t] = clone(cursor);
        save();
      },
    };
  }

  // ---------- adopting data created before sign-in ----------

  /**
   * Hard-removes rows from the 'local' (never synced) store: the listed copilots with every descendant in any
   * state, the listed facts, and optionally the profile. Used by adoptFrom({ removeFromLocal: true }).
   * @param {{ copilotIds?: string[], factIds?: string[], profile?: boolean }} p
   */
  function purgeLocal({ copilotIds = [], factIds = [], profile: dropProfile = false }) {
    assertOpen();
    if (acct !== 'local') fail('E_INVALID', 'only the local (pre-sign-in) store can be purged');
    const gone = { copilots: new Set(copilotIds), threads: new Set(), sessions: new Set() };
    for (const r of Object.values(rows('threads'))) if (gone.copilots.has(r.copilot_id)) gone.threads.add(r.id);
    for (const r of Object.values(rows('sessions'))) if (gone.threads.has(r.thread_id) || gone.copilots.has(r.copilot_id)) gone.sessions.add(r.id);
    const drop = (t, pred) => { for (const r of Object.values(rows(t))) if (pred(r)) delete rows(t)[r.id]; };
    drop('transcript_lines', (r) => gone.sessions.has(r.session_id));
    drop('memory_items', (r) => gone.copilots.has(r.copilot_id) || gone.threads.has(r.thread_id));
    drop('sessions', (r) => gone.sessions.has(r.id));
    drop('threads', (r) => gone.threads.has(r.id));
    drop('documents', (r) => gone.copilots.has(r.copilot_id));
    drop('copilots', (r) => gone.copilots.has(r.id));
    const facts = new Set(factIds);
    drop('profile_facts', (r) => facts.has(r.id));
    if (dropProfile) drop('profiles', () => true);
    save();
  }

  /**
   * Copies records created before sign-in (the 'local' store) into this signed-in account's store as NEW
   * dirty rows (new ids, rev 1, re-linked parents). Live rows only: tombstones and forgotten memory are never
   * copied; transcript lines only for sessions with save_transcript. Legacy-imported local_only copilots are
   * skipped unless listed in copilotIds (they stay local_only here too, until allowSync). Profile fields are
   * copied only while this account's profile is still empty; all live profile facts are copied.
   * Idempotent: adopted source ids are remembered in this account's store (meta.adopted), so a second call
   * only adds rows created since. removeFromLocal hard-deletes the adopted copilots (with descendants), facts
   * and copied profile from the local store afterwards.
   * @param {any} source the 'local' store instance (createVkinStore({ dataRoot, account: 'local' }))
   * @param {{ copilotIds?: string[]|null, removeFromLocal?: boolean }} [opts]
   */
  function adoptFrom(source, { copilotIds = null, removeFromLocal = false } = {}) {
    assertOpen();
    if (acct === 'local') fail('E_BAD_ACCOUNT', 'sign in before adopting local data');
    if (!source || typeof source.exportAll !== 'function' || source.account !== 'local') fail('E_INVALID', 'source must be the local store');
    if (source.isClosed()) fail('E_CLOSED', 'the local store has been closed');
    if (copilotIds !== null && !Array.isArray(copilotIds)) fail('E_INVALID', 'copilotIds must be a list');

    const src = source.exportAll(); // live rows only, no bookkeeping
    const localOnly = new Set(source.listCopilots().filter((c) => c.local_only).map((c) => c.id));
    const wanted = copilotIds === null ? null : new Set(copilotIds.map((x) => vId(x, 'copilotId')));
    if (wanted) for (const id of wanted) if (!src.copilots.some((c) => c.id === id)) fail('E_NOT_FOUND', `local copilot ${id} not found`);
    const picked = src.copilots.filter((c) => (wanted ? wanted.has(c.id) : !localOnly.has(c.id)));

    const map = data().meta.adopted;
    const adopted = { copilots: 0, threads: 0, sessions: 0, memory_items: 0, transcript_lines: 0, profile_facts: 0, profile: false };
    const skipped = [];
    const copilotMap = [];
    /** Target id for an adopted source id, only while that target row is still live. */
    const target = (t, sid) => {
      const tid = map[sid];
      return tid && rows(t)[tid] && !rows(t)[tid].deleted_at ? tid : null;
    };
    const tryRow = (t, sr, build) => {
      if (map[sr.id]) return;
      try {
        const r = build();
        if (!r) return;
        map[sr.id] = r.id;
        adopted[t] += 1;
      } catch (err) {
        skipped.push({ table: t, id: sr.id, reason: /** @type {any} */ (err).code || 'E_INVALID' });
      }
    };
    const keep = (sr) => ({ created_at: sr.created_at });

    batch(() => {
      for (const c of picked) {
        tryRow('copilots', c, () => {
          const p = copilotPatch(Object.fromEntries(COPILOT_FIELDS.filter((f) => f in c).map((f) => [f, c[f]])), { creating: true });
          const r = newRow('copilots', {
            purpose: '', instructions: '', answer_prefs: {}, restricted_claims: [], memory_scope: 'thread', use_profile_facts: true, keyterms: [],
            ...p, ...keep(c),
          });
          if (localOnly.has(c.id)) r.local_only = true;
          return r;
        });
        const to = target('copilots', c.id);
        if (to) copilotMap.push({ from: c.id, to });
      }
      const pickedIds = new Set(picked.map((c) => c.id));
      for (const th of src.threads.filter((x) => pickedIds.has(x.copilot_id))) {
        tryRow('threads', th, () => {
          const cid = target('copilots', th.copilot_id);
          if (!cid) fail('E_PARENT_MISSING', 'copilot not adopted');
          return newRow('threads', {
            copilot_id: cid,
            title: vStr(th.title ?? '', 'title', LIMITS.thread_title),
            status: ENUMS.thread_status.includes(th.status) ? th.status : 'active',
            ...keep(th),
          });
        });
      }
      const sessions = src.sessions.filter((x) => pickedIds.has(x.copilot_id));
      for (const se of sessions) {
        tryRow('sessions', se, () => {
          const tid = target('threads', se.thread_id);
          if (!tid) fail('E_PARENT_MISSING', 'thread not adopted');
          return newRow('sessions', {
            copilot_id: rows('threads')[tid].copilot_id,
            thread_id: tid,
            started_at: vTime(se.started_at, 'started_at', { nullable: false }),
            ended_at: vTime(se.ended_at, 'ended_at'),
            save_transcript: se.save_transcript === true,
            summary: vStr(se.summary ?? '', 'summary', LIMITS.summary),
            ...keep(se),
          });
        });
      }
      for (const m of src.memory_items.filter((x) => pickedIds.has(x.copilot_id) && (x.status === 'draft' || x.status === 'approved'))) {
        tryRow('memory_items', m, () => {
          const tid = target('threads', m.thread_id);
          if (!tid) fail('E_PARENT_MISSING', 'thread not adopted');
          const it = memoryItem({ kind: m.kind, text: m.text, origin: m.origin, source_at: m.source_at, due_at: m.due_at });
          return newRow('memory_items', {
            copilot_id: rows('threads')[tid].copilot_id,
            thread_id: tid,
            session_id: m.session_id ? target('sessions', m.session_id) : null,
            status: m.status,
            ...it,
            ...keep(m),
          });
        });
      }
      const transcriptOn = new Set(sessions.filter((x) => x.save_transcript === true).map((x) => x.id));
      for (const l of src.transcript_lines.filter((x) => transcriptOn.has(x.session_id))) {
        tryRow('transcript_lines', l, () => {
          const sid = target('sessions', l.session_id);
          if (!sid || !rows('sessions')[sid].save_transcript) fail('E_PARENT_MISSING', 'session not adopted');
          return newRow('transcript_lines', {
            session_id: sid,
            speaker: vEnum(l.speaker, 'speaker', ENUMS.speaker),
            text: vStr(l.text, 'text', LIMITS.transcript_text, { required: true }),
            at: vTime(l.at, 'at', { nullable: false }),
            ...keep(l),
          });
        });
      }
      // Session summaries cite memory as MEM-<id>: point the copies at the adopted ids.
      for (const se of sessions) {
        const tid = target('sessions', se.id);
        const row = tid && rows('sessions')[tid];
        if (!row || !row.summary || !row.summary.includes('MEM-')) continue;
        const next = row.summary.replace(/MEM-([0-9a-f-]{36})/gi, (whole, mid) => (map[mid.toLowerCase()] ? `MEM-${map[mid.toLowerCase()]}` : whole));
        if (next !== row.summary) { row.summary = next; touch(row); }
      }
      for (const f of src.profile_facts) {
        tryRow('profile_facts', f, () => newRow('profile_facts', {
          text: vStr(f.text, 'text', LIMITS.fact_text, { required: true }),
          shareable: f.shareable === true,
          source: vStr(f.source ?? '', 'source', LIMITS.fact_source),
          ...keep(f),
        }));
      }
      const mine = profile();
      const srcProfile = src.profiles[0];
      if (srcProfile && !mine.display_name && !mine.about && !mine.today_context) {
        const patch = {};
        for (const k of ['display_name', 'about', 'today_context']) if (typeof srcProfile[k] === 'string' && srcProfile[k]) patch[k] = srcProfile[k];
        if (srcProfile.settings && typeof srcProfile.settings === 'object') {
          patch.settings = Object.fromEntries(Object.entries(srcProfile.settings).filter(([k, v]) => ['save_transcripts_default', 'memory_enabled'].includes(k) && typeof v === 'boolean'));
        }
        if (Object.keys(patch).length) {
          try {
            updateProfile(patch);
            adopted.profile = true;
          } catch (err) {
            skipped.push({ table: 'profiles', id: srcProfile.id, reason: /** @type {any} */ (err).code || 'E_INVALID' });
          }
        }
      }
      save();
    });

    let removedFromLocal = false;
    if (removeFromLocal) {
      // Only copilots that now exist here are removed locally; their unadopted leftovers go with them.
      source.purgeLocal({
        copilotIds: picked.filter((c) => map[c.id]).map((c) => c.id),
        factIds: src.profile_facts.filter((f) => map[f.id]).map((f) => f.id),
        profile: adopted.profile,
      });
      removedFromLocal = true;
    }
    return { adopted, copilots: copilotMap, skipped, removedFromLocal };
  }

  // ---------- legacy import ----------

  function truncate(s, max) {
    const t = String(s || '').replace(/\s+\n/g, '\n').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
    return (at > max * 0.5 ? cut.slice(0, at + 1) : cut.slice(0, max - 1)).trim();
  }

  /**
   * One-time import: one copilot per meeting pack folder (name, purpose, keyterms only). Reads the packs,
   * writes only into this account's store. Idempotent: a folder imported once (even if the copilot was
   * later deleted) is never imported again.
   * @param {{ meetingPacksDir: string }} p
   */
  function importLegacy({ meetingPacksDir }) {
    assertOpen();
    const imported = [];
    const skipped = [];
    if (!meetingPacksDir || !fs.existsSync(meetingPacksDir)) return { imported, skipped };
    const done = data().meta.legacyImports;
    const entries = fs.readdirSync(meetingPacksDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    batch(() => {
      for (const folder of entries) {
        if (done[folder]) { skipped.push({ folder, reason: 'already_imported' }); continue; }
        const packFile = path.join(meetingPacksDir, folder, 'pack.json');
        let pack;
        try {
          pack = JSON.parse(fs.readFileSync(packFile, 'utf8'));
        } catch {
          skipped.push({ folder, reason: 'no_readable_pack' });
          continue;
        }
        const session = pack && typeof pack.session === 'object' && pack.session ? pack.session : {};
        const name = truncate(session.title || pack.person || folder, LIMITS.copilot_name) || folder.slice(0, LIMITS.copilot_name);
        const keyterms = (Array.isArray(pack.keyterms) ? pack.keyterms : [])
          .filter((k) => typeof k === 'string' && k.trim())
          .map((k) => k.trim().slice(0, LIMITS.keyterm))
          .slice(0, LIMITS.keyterms_max);
        const r = newRow('copilots', {
          name,
          purpose: truncate(pack.summary || '', LIMITS.purpose),
          instructions: '',
          answer_prefs: {},
          restricted_claims: [],
          memory_scope: 'thread',
          use_profile_facts: true,
          keyterms: [...new Set(keyterms)],
        });
        // Pack content stays on this device until the user explicitly allows sync (allowSync).
        r.local_only = true;
        done[folder] = r.id;
        imported.push({ folder, copilotId: r.id, name });
      }
      if (imported.length) save();
    });
    return { imported, skipped };
  }

  return {
    account: acct,
    file,
    // contract API
    createCopilot, updateCopilot, deleteCopilot, listCopilots,
    createThread, listThreads, deleteThread,
    startSession, endSession, listSessions,
    addMemoryDraft, updateMemory, approveMemory, forgetMemory, approvedMemory,
    profile, updateProfile, listFacts, addFact, forgetFact,
    exportAll, wipeAccount, close, isClosed: () => closed,
    // additions (proposed for the contract)
    adoptFrom, purgeLocal, getCopilot, allowSync, updateThread, setSessionSummary, addTranscriptLines, listTranscript, listMemory,
    factsForCopilot, listConflicts, resolveConflict, importLegacy, syncAdapter,
  };
}

module.exports = { createVkinStore, migrateDoc, SCHEMA_VERSION, MIGRATIONS, VkinError };
