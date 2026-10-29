// @ts-check
'use strict';
// Meeting packs: a temporary, source-grounded profile for one meeting (MEETING_PROFILE). Nothing is trained:
// pack records are retrieved per turn beside the personal brain and checked by the same validator.
// A pack lives in meeting-packs/<id>/pack.json (gitignored: it holds private correspondence).
const fs = require('node:fs');
const path = require('node:path');
const { validateRecord } = require('./brain/schema');
const { createRetriever, createSearchIndex } = require('./brain/retrieve');
const { estimateTokens } = require('./budget');

// Source priority (spec order): correspondence > assigned papers > personal records > primary scholarship > supplementary.
const KINDS = {
  correspondence: { confidence: 1, evidence: 'meeting', sensitivity: 'private', group: 'meeting' },
  logistics: { confidence: 1, evidence: 'meeting', sensitivity: 'private', group: 'meeting' },
  personal: { confidence: 0.95, evidence: 'built', sensitivity: 'internal', group: 'personal' },
  story: { confidence: 0.95, evidence: 'built', sensitivity: 'internal', group: 'personal' },
  paper: { confidence: 0.92, evidence: 'research', sensitivity: 'public', group: 'research' },
  concept: { confidence: 0.85, evidence: 'research', sensitivity: 'public', group: 'research' },
  method: { confidence: 0.85, evidence: 'research', sensitivity: 'public', group: 'research' },
  supplementary: { confidence: 0.75, evidence: 'research', sensitivity: 'public', group: 'research' },
};
const URL_RE = /\s*\(?https?:\/\/\S+\)?/g;
// Prepared-answer usage classes (FABEL PRD v2, Stage 10). FACT_SOURCE feeds the ledger; STRUCTURE/STYLE
// may steer; DO_NOT_COPY is never shown as prose; DEPRECATED is excluded from retrieval and prompts.
const PREP_CLASSES = new Set(['FACT_SOURCE', 'STRUCTURE_EXAMPLE', 'STYLE_EXAMPLE', 'DO_NOT_COPY', 'DEPRECATED']);

function meetingSettings(config = {}, env = process.env) {
  const m = { enabled: false, profile: '', dir: 'meeting-packs', allowGeneralKnowledge: true, allowMeetingSources: true, requirePersonalClaimSources: true, ...(config.meeting || {}) };
  if (env.MEETING_PROFILE !== undefined) m.profile = env.MEETING_PROFILE;
  if (env.MEETING_MODE_ENABLED !== undefined) m.enabled = env.MEETING_MODE_ENABLED === 'true';
  if (env.ALLOW_GENERAL_KNOWLEDGE !== undefined) m.allowGeneralKnowledge = env.ALLOW_GENERAL_KNOWLEDGE === 'true';
  if (env.ALLOW_MEETING_SOURCES !== undefined) m.allowMeetingSources = env.ALLOW_MEETING_SOURCES === 'true';
  if (env.REQUIRE_PERSONAL_CLAIM_SOURCES !== undefined) m.requirePersonalClaimSources = env.REQUIRE_PERSONAL_CLAIM_SOURCES === 'true';
  return m;
}

// What kind of meeting a pack prepares. "research" keeps the scholarly-collaboration rules the first
// pack was built with; "interview" and "general" use the generic meeting rules.
// An explicit meeting_kind wins; otherwise the session's meeting type, then literature terms, decide.
const MEETING_KINDS = new Set(['research', 'interview', 'general']);
function meetingKindOf(pack) {
  const explicit = String(pack.meeting_kind || '').toLowerCase();
  if (MEETING_KINDS.has(explicit)) return explicit;
  const type = String((pack.session && pack.session.meetingType) || '');
  if (/interview|screen|recruit/i.test(type)) return 'interview';
  if (/research/i.test(type)) return 'research';
  return (pack.literature_terms || []).length ? 'research' : 'general';
}

/** Line span of `"id": "<id>"` in the raw pack, for provenance. */
function spanOf(raw, id) {
  const m = new RegExp(`"id"\\s*:\\s*"${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).exec(raw);
  const i = m ? m.index : -1;
  if (i < 0) return 'L1-L1';
  const line = raw.slice(0, i).split('\n').length;
  return `L${line}-L${line}`;
}

/**
 * Loads and validates a pack. Returns null when meeting mode is off, the pack is missing or it has expired.
 * @param {{ settings: any, root: string, readFile?: (p: string) => string, today?: string, log?: (m: string) => void }} p
 */
function loadMeetingPack({ settings, root, readFile = (p) => fs.readFileSync(p, 'utf8'), today = new Date().toISOString().slice(0, 10), log = () => {} }) {
  if (!settings || !settings.enabled || !settings.profile) return null;
  if (!/^[\w.-]+$/.test(settings.profile)) throw new Error('MEETING_PROFILE must be a plain folder name');
  const dir = path.isAbsolute(settings.dir) ? settings.dir : path.join(root, settings.dir);
  const file = path.join(dir, settings.profile, 'pack.json');
  let raw;
  try { raw = String(readFile(file)).replace(/^\uFEFF/, ''); } catch (e) {
    if (e && e.code === 'ENOENT') { log(`meeting pack not found: ${file}`); return null; }
    throw e;
  }
  const pack = JSON.parse(raw);
  if (pack.expires && today > pack.expires) { log(`meeting pack ${pack.id} expired on ${pack.expires}; not loaded`); return null; }
  const updated = /^\d{4}-\d{2}-\d{2}$/.test(pack.updated || '') ? pack.updated : today;
  // "include" lists sibling files holding more records ([...]) or {records, exemplars}; each keeps its own provenance.
  const sources = [{ file, raw, records: pack.records || [] }];
  const extraExemplars = [];
  for (const inc of pack.include || []) {
    if (!/^[\w.-]+\.json$/.test(inc)) throw new Error(`meeting pack include must be a plain .json file name: ${inc}`);
    const f = path.join(path.dirname(file), inc);
    const r = String(readFile(f)).replace(/^\uFEFF/, '');
    const data = JSON.parse(r);
    sources.push({ file: f, raw: r, records: Array.isArray(data) ? data : data.records || [] });
    if (!Array.isArray(data) && data.exemplars) extraExemplars.push(...data.exemplars);
  }

  const all = sources.flatMap((s) => s.records.map((r) => ({ r, s })));
  const records = (settings.allowMeetingSources === false ? [] : all).map(({ r, s }) => {
    const k = KINDS[r.kind];
    if (!k) throw new Error(`meeting record ${r.id}: unknown kind ${r.kind}`);
    const isStory = r.kind === 'story';
    /** @type {any} */
    const rec = {
      id: r.id, type: isStory ? 'star_story' : 'fact', title: String(r.title || '').trim(), text: String(r.text || '').replace(URL_RE, '').trim(),
      source_path: s.file, source_span: spanOf(s.raw, r.id), effective_from: r.effective_from || null, effective_to: r.effective_to || null, updated_at: updated,
      confidence: k.confidence, sensitivity: k.sensitivity, entities: r.entities || [], tags: [r.kind, 'meeting', ...(r.tags || [])].map((t) => String(t).toLowerCase()),
      approved: r.approved !== false, evidence: k.evidence, fields: { kind: r.kind, group: k.group, source: r.source || '', access: r.access || '', pin: r.pin || [], fallback: r.fallback || [], setting: String(r.setting || '').trim().toLowerCase() },
    };
    if (isStory) {
      rec.star = { situation: '', task: '', action: '', result: '', parent_id: r.id, ...(r.star || {}) };
      if (rec.star.competency) rec.tags.push(rec.star.competency);
    }
    const errs = validateRecord(rec);
    if (errs.length) throw new Error(`meeting record ${r.id}: ${errs.join('; ')}`);
    return rec;
  });
  // Approved statements behave like corrections ("COR-" ids): the validator accepts gated claims they support.
  const approved = (pack.approved_statements || []).map((s) => {
    if (!/^COR-MTG-[\w-]+$/.test(s.id)) throw new Error(`approved statement id must start with COR-MTG-: ${s.id}`);
    return { id: s.id, target: s.target || '', text: String(s.text || '').trim(), source: s.source || '' };
  });
  const ids = new Set();
  for (const r of records) { if (ids.has(r.id)) throw new Error(`duplicate meeting record id ${r.id}`); ids.add(r.id); }
  // Hand-written examples default to a small priority bonus over imported banks (which set priority 0).
  const exemplars = [...(pack.exemplars || []), ...extraExemplars].map((x) => {
    const priority = typeof x.priority === 'number' ? x.priority : 0.25;
    const storyId = x.story_id || null;
    // Prepared-answer classification (FABEL_PREPARED_ANSWERS_AS_EVIDENCE): an explicit class wins;
    // otherwise a story-bound hand-written example teaches structure, a bare bank answer teaches style.
    const explicit = String(x.usage_class || x.class || '').toUpperCase();
    const usageClass = PREP_CLASSES.has(explicit) ? explicit : (storyId || priority >= 0.45 ? 'STRUCTURE_EXAMPLE' : 'STYLE_EXAMPLE');
    return { id: x.id, question: x.question, kind: x.kind || null, answer: String(x.answer || '').replace(/^\s*SAY:\s*/i, '').trim(), sourceIds: x.source_ids || [], storyId, priority, usageClass };
  });
  const forbidden = (pack.forbidden || []).map((f) => ({ re: new RegExp(f.pattern, f.flags || 'i'), reason: f.reason }));
  return {
    id: pack.id, person: pack.person || '', file, summary: String(pack.summary || '').trim(),
    records: records.filter((r) => r.type !== 'star_story'), stories: records.filter((r) => r.type === 'star_story'),
    approved, exemplars, forbidden, profileQuery: String(pack.profile_query || ''),
    keyterms: pack.keyterms || [], literatureTerms: pack.literature_terms || [], expires: pack.expires || null,
    // Written by the prep window (src/main/prep); optional in hand-made packs.
    preferences: pack.preferences && typeof pack.preferences === 'object' ? pack.preferences : null,
    session: pack.session && typeof pack.session === 'object' ? pack.session : null,
    meetingKind: meetingKindOf(pack),
  };
}

/** Per-turn retrieval over a loaded pack: a few records plus at most `exemplarCount` answer examples. */
function createMeetingContext(pack, { now = () => Date.now() } = {}) {
  const retriever = createRetriever({ records: pack.records, now });
  const exIndex = pack.exemplars.length ? createSearchIndex(pack.exemplars.map((x) => ({ id: x.id, title: x.question, entities: '', tags: x.kind || '', text: '' }))) : null;
  const byId = new Map(pack.records.map((r) => [r.id, r]));
  const exById = new Map(pack.exemplars.map((x) => [x.id, x]));
  const vocabulary = [...new Set(pack.records.flatMap((r) => r.entities))];

  // Records pinned to a question kind are always offered first for that kind ("what I built for him" for fit questions).
  /** @param {string} query @param {{ session?: any, budgetTokens?: number, maxItems?: number, kind?: string|null }} [opts] */
  function search(query, { session = undefined, budgetTokens = 1300, maxItems = 3, kind = null } = {}) {
    const pinned = kind ? pack.records.filter((r) => r.fields.pin.includes(kind)) : [];
    const out = [];
    let used = 0;
    for (const r of pinned) {
      const t = estimateTokens(r.title + r.text);
      if (out.length >= maxItems || used + t > budgetTokens) break;
      out.push({ record: r, score: 1, pinned: true });
      used += t;
    }
    for (const it of retriever.search(query, { session, budgetTokens: budgetTokens - used, maxItems }).items) {
      if (out.length >= maxItems) break;
      if (out.some((o) => o.record.id === it.record.id)) continue;
      out.push(it);
      used += estimateTokens(it.record.title + it.record.text);
    }
    // Fallback records fill the remaining room when a broad question ("what did you read?") matches little.
    for (const r of kind ? pack.records.filter((x) => x.fields.fallback.includes(kind)) : []) {
      const t = estimateTokens(r.title + r.text);
      if (out.length >= maxItems || out.some((o) => o.record.id === r.id) || used + t > budgetTokens) continue;
      out.push({ record: r, score: 0.5, fallback: true });
      used += t;
    }
    return out;
  }

  function exemplarsFor(question, kind, { exclude = [], count = 2 } = {}) {
    if (!exIndex) return [];
    const hits = exIndex.search(String(question || ''), { boost: { title: 3 }, prefix: true, fuzzy: 0.2 });
    const max = hits.reduce((m, h) => Math.max(m, h.score), 0);
    return hits
      .map((h) => ({ x: exById.get(h.id), score: h.score / (max || 1) + (exById.get(h.id).kind === kind ? 0.3 : 0) + exById.get(h.id).priority }))
      .filter((h) => h.score >= 0.35 && !exclude.includes(h.x.id))
      .sort((a, b) => b.score - a.score || (a.x.id < b.x.id ? -1 : 1))
      // A second example only when it is nearly as close as the first.
      .filter((h, i) => i === 0 || h.score >= 0.6)
      .slice(0, count).map((h) => h.x);
  }

  const groupOf = (id) => { const r = byId.get(id); return r ? r.fields.group : null; };
  return { search, exemplarsFor, groupOf, vocabulary, byId };
}

module.exports = { meetingSettings, loadMeetingPack, createMeetingContext, meetingKindOf, KINDS };
