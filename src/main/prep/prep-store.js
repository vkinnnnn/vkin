// @ts-check
'use strict';
// Storage behind the prep window ("AI Background", PRD Phase 3). A session is a meeting pack folder
// (meeting-packs/<id>/, gitignored) so everything the prep window writes is read by the existing
// loader (meeting.js) with no second format. Imported documents become include files
// (docs-<docId>.json) with provenance; typed notes go to typed.json. pack.json keeps any fields it
// does not know about, so hand-made packs survive edits.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadMeetingPack, KINDS } = require('../meeting');
const { sanitizePreferences } = require('../render');
const { parseDocument } = require('./doc-parse');
const { toPackRecords } = require('./chunk');
const { TEMPLATES } = require('./templates');
const { estimateTokens } = require('../budget');

const ID_RE = /^[a-z0-9][\w.-]{0,80}$/i;
const DOC_ID_RE = /^[a-z0-9-]{1,40}$/;
const SIDE_KINDS = Object.freeze({
  me: ['personal', 'story'],
  them: ['correspondence', 'logistics', 'paper', 'concept', 'method', 'supplementary'],
});
const SESSION_FIELDS = ['title', 'person', 'organization', 'meetingType', 'date', 'durationMin', 'mode'];
const TYPED_FILE = 'typed.json';

function slug(s, max = 40) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, max).replace(/^-|-$/g, '');
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {{ root: string, config: any, configPath?: string, now?: () => number, log?: (...a: any[]) => void, parse?: typeof parseDocument }} deps
 */
function createPrepStore(deps) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || (() => {});
  const parse = deps.parse || parseDocument;
  const cfg = deps.config;
  const packsDir = () => {
    const d = (cfg.meeting && cfg.meeting.dir) || 'meeting-packs';
    return path.isAbsolute(d) ? d : path.join(deps.root, d);
  };
  const today = () => new Date(now()).toISOString().slice(0, 10);

  function dirOf(id) {
    if (!ID_RE.test(String(id)) || String(id).startsWith('_')) throw new Error('invalid session id');
    return path.join(packsDir(), id);
  }
  function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  }
  // Atomic write: a crash mid-write never leaves a half-written pack the meeting depends on.
  function writeJson(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }
  const packFile = (id) => path.join(dirOf(id), 'pack.json');
  function readPack(id) {
    const f = packFile(id);
    if (!fs.existsSync(f)) throw new Error(`session ${id} not found`);
    return readJson(f);
  }
  const activeId = () => (cfg.meeting && cfg.meeting.enabled ? cfg.meeting.profile : '');

  function typedRecords(id) {
    const f = path.join(dirOf(id), TYPED_FILE);
    return fs.existsSync(f) ? (readJson(f).records || []) : [];
  }

  function listSessions() {
    const dir = packsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_') && ID_RE.test(d.name) && fs.existsSync(path.join(dir, d.name, 'pack.json')))
      .map((d) => {
        try {
          const p = readJson(path.join(dir, d.name, 'pack.json'));
          const s = p.session || {};
          return { id: d.name, title: s.title || p.id || d.name, person: p.person || s.person || '', organization: s.organization || '', date: s.date || p.updated || '', expires: p.expires || null, expired: Boolean(p.expires && today() > p.expires), active: activeId() === d.name, documents: (p.documents || []).length };
        } catch (err) {
          return { id: d.name, title: d.name, error: `pack.json unreadable: ${err.message}`, active: activeId() === d.name };
        }
      })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }

  function getSession(id) {
    const p = readPack(id);
    return {
      id,
      active: activeId() === id,
      session: { title: '', person: p.person || '', organization: '', meetingType: '', date: '', durationMin: 45, mode: 'auto', ...(p.session || {}) },
      summary: p.summary || '',
      keyterms: p.keyterms || [],
      expires: p.expires || null,
      preferences: sanitizePreferences(p.preferences || {}),
      documents: p.documents || [],
      typed: typedRecords(id).map((r) => ({ id: r.id, kind: r.kind, title: r.title, text: r.text, side: SIDE_KINDS.me.includes(r.kind) ? 'me' : 'them' })),
      restricted: (p.forbidden || []).map((f) => ({ phrase: f.phrase || f.pattern, reason: f.reason || '', custom: !f.phrase })),
      approvedStatements: (p.approved_statements || []).map((s) => ({ id: s.id, text: s.text })),
      handWrittenRecords: (p.records || []).length + (p.include || []).filter((f) => !/^docs-|^typed\.json$/.test(f)).reduce((n, f) => {
        try { const d = readJson(path.join(dirOf(id), f)); return n + (Array.isArray(d) ? d.length : (d.records || []).length); } catch { return n; }
      }, 0),
    };
  }

  function createSession(input = {}) {
    const tpl = TEMPLATES.find((t) => t.id === input.templateId) || null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date || '') ? input.date : today();
    const base = slug(input.person || input.title || 'meeting') || 'meeting';
    let id = `${date}-${base}`;
    for (let n = 2; fs.existsSync(path.join(packsDir(), id)); n += 1) id = `${date}-${base}-${n}`;
    fs.mkdirSync(path.join(packsDir(), id), { recursive: true });
    const session = {
      title: String(input.title || (tpl ? tpl.name : 'Meeting')).slice(0, 120),
      person: String(input.person || '').slice(0, 120),
      organization: String(input.organization || '').slice(0, 120),
      meetingType: String(input.meetingType || (tpl ? tpl.meetingType : '')).slice(0, 80),
      date,
      durationMin: Math.min(240, Math.max(5, Number(input.durationMin || (tpl ? tpl.durationMin : 45)) || 45)),
      mode: (input.mode || (tpl ? tpl.mode : 'auto')) === 'manual' ? 'manual' : 'auto',
      template: tpl ? tpl.id : null,
    };
    const pack = {
      id, updated: today(), expires: addDays(date, 7), person: session.person,
      summary: tpl ? tpl.summary : '', keyterms: [], literature_terms: [], profile_query: '',
      session, preferences: tpl ? { ...tpl.preferences } : {}, documents: [], records: [], include: [], exemplars: [], forbidden: [], approved_statements: [],
    };
    writeJson(path.join(packsDir(), id, 'pack.json'), pack);
    log('prep: created session', id);
    return getSession(id);
  }

  function updateSession(id, patch = {}) {
    const p = readPack(id);
    p.session = p.session || {};
    for (const k of SESSION_FIELDS) {
      if (patch[k] === undefined) continue;
      if (k === 'durationMin') p.session[k] = Math.min(240, Math.max(5, Number(patch[k]) || 45));
      else if (k === 'mode') p.session[k] = patch[k] === 'manual' ? 'manual' : 'auto';
      else if (k === 'date') { if (/^\d{4}-\d{2}-\d{2}$/.test(patch[k])) p.session[k] = patch[k]; }
      else p.session[k] = String(patch[k]).slice(0, 120);
    }
    if (patch.person !== undefined) p.person = p.session.person;
    if (patch.summary !== undefined) p.summary = String(patch.summary).slice(0, 8000);
    if (patch.expires !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(patch.expires)) p.expires = patch.expires;
    if (Array.isArray(patch.keyterms)) p.keyterms = [...new Set(patch.keyterms.map((k) => String(k).trim()).filter((k) => k && k.length <= 60))].slice(0, 50);
    if (patch.preferences) p.preferences = { ...(p.preferences || {}), ...sanitizePreferences(patch.preferences) };
    if (Array.isArray(patch.restricted)) {
      // Restricted facts are plain phrases: matched literally (case-insensitive, whole words), never as
      // user-supplied regex. Hand-written regex rules in the pack are kept.
      const custom = (p.forbidden || []).filter((f) => !f.phrase);
      const phrases = patch.restricted.map((r) => ({ phrase: String(r.phrase || '').trim().slice(0, 200), reason: String(r.reason || 'Restricted for this meeting').slice(0, 200) }))
        .filter((r) => r.phrase.length >= 2);
      p.forbidden = [...custom, ...phrases.map((r) => ({ phrase: r.phrase, pattern: `\\b${escapeRegex(r.phrase)}\\b`, flags: 'i', reason: r.reason }))];
    }
    p.updated = today();
    writeJson(packFile(id), p);
    return getSession(id);
  }

  async function importDocument(id, { filePath, side, kind, approved }) {
    if (!SIDE_KINDS[side]) throw new Error('side must be "me" or "them"');
    if (!SIDE_KINDS[side].includes(kind)) throw new Error(`kind for ${side} must be one of ${SIDE_KINDS[side].join(', ')}`);
    const p = readPack(id);
    const parsed = await parse(filePath);
    const buf = fs.readFileSync(filePath);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    if ((p.documents || []).some((d) => d.sha256 === sha256)) throw new Error('this document is already imported in this session');
    const name = path.basename(filePath).slice(0, 100);
    let docId = slug(path.basename(filePath, path.extname(filePath)), 30) || 'doc';
    for (let n = 2; (p.documents || []).some((d) => d.id === docId); n += 1) docId = `${slug(name, 26)}-${n}`;
    // Story records need STAR fields the importer cannot invent: imported "story" text is kept as a
    // personal record instead.
    const recordKind = kind === 'story' ? 'personal' : kind;
    const records = toPackRecords(parsed.text, { docId, docName: name, kind: recordKind, side, approved: side === 'me' ? approved === true : true });
    const file = `docs-${docId}.json`;
    writeJson(path.join(dirOf(id), file), { source: name, sha256, records });
    const warnings = [...parsed.warnings];
    if (side === 'me' && approved !== true) warnings.push('not marked as verified: indexed but not used as evidence until you verify it');
    const doc = {
      id: docId, name, side, kind, file, format: parsed.format, pages: parsed.pages, chars: parsed.chars, records: records.length,
      tokens: records.reduce((n, r) => n + estimateTokens(`${r.title} ${r.text}`), 0), sha256, approved: side === 'me' ? approved === true : true,
      importedAt: new Date(now()).toISOString(), status: records.length ? (warnings.length ? 'indexed-with-warnings' : 'indexed') : 'empty', warnings,
    };
    p.documents = [...(p.documents || []), doc];
    p.include = [...new Set([...(p.include || []), file])];
    p.updated = today();
    writeJson(packFile(id), p);
    log('prep: imported', name, `${records.length} records`);
    return { document: doc, session: getSession(id) };
  }

  function setDocumentApproved(id, docId, approved) {
    if (!DOC_ID_RE.test(String(docId))) throw new Error('invalid document id');
    const p = readPack(id);
    const doc = (p.documents || []).find((d) => d.id === docId);
    if (!doc) throw new Error('document not found');
    const f = path.join(dirOf(id), doc.file);
    const data = readJson(f);
    data.records = (data.records || []).map((r) => ({ ...r, approved: approved === true }));
    writeJson(f, data);
    doc.approved = approved === true;
    doc.warnings = (doc.warnings || []).filter((w) => !w.startsWith('not marked as verified'));
    if (!doc.approved && doc.side === 'me') doc.warnings.push('not marked as verified: indexed but not used as evidence until you verify it');
    writeJson(packFile(id), p);
    return getSession(id);
  }

  function removeDocument(id, docId) {
    if (!DOC_ID_RE.test(String(docId))) throw new Error('invalid document id');
    const p = readPack(id);
    const doc = (p.documents || []).find((d) => d.id === docId);
    if (!doc) throw new Error('document not found');
    p.documents = p.documents.filter((d) => d.id !== docId);
    p.include = (p.include || []).filter((f) => f !== doc.file);
    writeJson(packFile(id), p);
    const f = path.join(dirOf(id), doc.file);
    if (/^docs-[a-z0-9-]+\.json$/.test(doc.file) && fs.existsSync(f)) fs.unlinkSync(f);
    return getSession(id);
  }

  // Typed notes ("I can start November 3, 20 hours a week") become records like imported text.
  function addTypedRecord(id, { side, kind, title, text }) {
    if (!SIDE_KINDS[side] || !SIDE_KINDS[side].includes(kind) || kind === 'story') throw new Error('invalid kind for a typed note');
    const t = String(text || '').trim();
    if (t.length < 5) throw new Error('note text is too short');
    const p = readPack(id);
    const f = path.join(dirOf(id), TYPED_FILE);
    const data = fs.existsSync(f) ? readJson(f) : { records: [] };
    const n = (data.records || []).reduce((m, r) => Math.max(m, Number(String(r.id).split('-').pop()) || 0), 0) + 1;
    const [rec] = toPackRecords(t, { docId: 'typed', docName: String(title || (side === 'me' ? 'Note about me' : 'Note about them')).slice(0, 80), kind, side, approved: true, maxChars: 4000 });
    if (!rec) throw new Error('note text is too short');
    rec.id = `NOTE-${String(n).padStart(3, '0')}`;
    rec.title = String(title || rec.title).slice(0, 120);
    data.records = [...(data.records || []), rec];
    writeJson(f, data);
    p.include = [...new Set([...(p.include || []), TYPED_FILE])];
    writeJson(packFile(id), p);
    return getSession(id);
  }

  function removeTypedRecord(id, recordId) {
    const f = path.join(dirOf(id), TYPED_FILE);
    if (!fs.existsSync(f)) return getSession(id);
    const data = readJson(f);
    data.records = (data.records || []).filter((r) => r.id !== recordId);
    writeJson(f, data);
    return getSession(id);
  }

  /** Structural + loader validation ($0, no network). */
  function validate(id) {
    const errors = [];
    const warnings = [];
    let pack = null;
    let raw = null;
    try { raw = readPack(id); } catch (err) { return { ok: false, errors: [err.message], warnings, stats: null }; }
    try {
      pack = loadMeetingPack({ settings: { enabled: true, profile: id, dir: packsDir(), allowMeetingSources: true }, root: deps.root, today: today() });
      if (!pack) errors.push(raw.expires && today() > raw.expires ? `expired on ${raw.expires}: it will not load (change the expiry date)` : 'pack did not load');
    } catch (err) {
      errors.push(`pack does not load: ${err.message}`);
    }
    if (!String(raw.summary || '').replace(/^[^:\n]+:\s*$/gm, '').trim()) warnings.push('summary is empty: say who they are and what the meeting is for');
    if (!raw.person && !(raw.session && raw.session.person)) warnings.push('no participant name');
    if (!(raw.keyterms || []).length) warnings.push('no key terms: names and jargon help speech recognition');
    for (const d of raw.documents || []) {
      if (d.status === 'empty') warnings.push(`${d.name}: no text was extracted`);
      for (const w of d.warnings || []) warnings.push(`${d.name}: ${w}`);
    }
    for (const f of raw.forbidden || []) {
      try { new RegExp(f.pattern, f.flags || 'i'); } catch { errors.push(`restricted rule "${f.phrase || f.pattern}" is not a valid pattern`); }
    }
    const records = pack ? [...pack.records, ...pack.stories] : [];
    const tokens = records.reduce((n, r) => n + estimateTokens(`${r.title} ${r.text}`), 0);
    const byKind = {};
    for (const r of records) byKind[r.fields.kind] = (byKind[r.fields.kind] || 0) + 1;
    const unapproved = records.filter((r) => !r.approved).length;
    if (unapproved) warnings.push(`${unapproved} record(s) are not verified and will not be used as evidence`);
    if (pack && !records.length) warnings.push('no records yet: import documents or add notes');
    return {
      ok: errors.length === 0,
      errors,
      warnings,
      stats: pack ? { records: records.length, byKind, tokens, exemplars: pack.exemplars.length, restricted: pack.forbidden.length, expires: pack.expires } : null,
    };
  }

  // Makes this session the one the copilot loads (takes effect after a restart).
  function activate(id, writeConfig) {
    readPack(id); // must exist
    const v = validate(id);
    if (!v.ok) throw new Error(`fix these first: ${v.errors.join('; ')}`);
    cfg.meeting = { ...(cfg.meeting || {}), enabled: true, profile: id };
    if (writeConfig) writeConfig(cfg);
    return { activated: id, restartRequired: true };
  }

  function deactivate(writeConfig) {
    cfg.meeting = { ...(cfg.meeting || {}), enabled: false };
    if (writeConfig) writeConfig(cfg);
    return { restartRequired: true };
  }

  /** Rough cost of a session from its length and the recent average cost per answer. */
  function estimateBudget(id, { avgAnswerUsd = 0.0068, questionsPerMinute = 0.5 } = {}) {
    const s = getSession(id).session;
    const answers = Math.round((Number(s.durationMin) || 45) * questionsPerMinute);
    return { expectedAnswers: answers, estimatedUsd: Math.round(answers * avgAnswerUsd * 1.3 * 1000) / 1000, assumptions: `${questionsPerMinute} questions/min, $${avgAnswerUsd}/answer, +30% for regenerations` };
  }

  return {
    listSessions, getSession, createSession, updateSession, importDocument, setDocumentApproved, removeDocument,
    addTypedRecord, removeTypedRecord, validate, activate, deactivate, estimateBudget,
    templates: () => TEMPLATES.map((t) => ({ id: t.id, name: t.name, meetingType: t.meetingType, durationMin: t.durationMin, mode: t.mode, preferences: t.preferences })),
    sideKinds: () => SIDE_KINDS,
    kinds: () => Object.keys(KINDS),
  };
}

module.exports = { createPrepStore, SIDE_KINDS, slug };
