// @ts-check
'use strict';
// Corrections store: profile_overrides.md bullets (read-only, version 1) plus an append-only user file
// (<dataDir>/corrections.jsonl). Corrections never mutate records; they are separate `correction` records
// that retrieval and prompting rank above whatever they supersede.
const fs = require('node:fs');
const path = require('node:path');
const { validateRecord } = require('./schema');

const FILE = 'corrections.jsonl';
// Best-effort target for an override bullet: first match wins. None are built in; each profile lists its own in
// config.profile.correctionAliases (see compileAliases).
/** @type {Array<[RegExp, string]>} */
const DEFAULT_ALIASES = [];

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * config.profile.correctionAliases ([[pattern, recordId], ...]) -> [[RegExp, recordId], ...]. Each pattern is a
 * case-insensitive regex source; one that is not a valid regex is matched as a literal phrase. Malformed pairs
 * are skipped.
 * @param {unknown} list
 * @returns {Array<[RegExp, string]>}
 */
function compileAliases(list) {
  /** @type {Array<[RegExp, string]>} */
  const out = [];
  for (const pair of Array.isArray(list) ? list : []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const src = String(pair[0] == null ? '' : pair[0]).trim();
    const id = String(pair[1] == null ? '' : pair[1]).trim();
    if (!src || !id) continue;
    let re;
    try { re = new RegExp(src, 'i'); } catch (_e) { re = new RegExp(escRe(src), 'i'); }
    out.push([re, id]);
  }
  return out;
}

const textHash = (s) => require('node:crypto').createHash('sha256').update(String(s).trim()).digest('hex').slice(0, 12);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-') || 'misc';
const today = () => new Date().toISOString().slice(0, 10);

/** @param {{ dataDir?: string, overridesPath?: string, readFile?: (p: string) => string, aliases?: Array<[RegExp, string]>, now?: () => Date }} [opts] */
function createCorrections({ dataDir, overridesPath, readFile = (p) => fs.readFileSync(p, 'utf8'), aliases = DEFAULT_ALIASES, now = () => new Date() } = {}) {
  if (!dataDir) throw new Error('createCorrections: dataDir is required');
  const file = path.join(dataDir, FILE);

  function safeRead(p) {
    try { return String(readFile(p)); } catch (e) {
      if (e && e.code === 'ENOENT') return '';
      throw new Error(`Cannot read ${p}: ${e.message}`);
    }
  }

  function loadOverrides() {
    if (!overridesPath) return [];
    const lines = safeRead(overridesPath).split(/\r?\n/);
    const out = [];
    lines.forEach((line, i) => {
      const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
      if (!m) return;
      const text = m[1];
      const hit = aliases.find(([re]) => re.test(text));
      const n = out.length + 1;
      out.push({
        id: `COR-OVR-${n}`, type: 'correction', title: text.split(/[:(]/)[0].trim().slice(0, 80) || `Override ${n}`, text,
        source_path: overridesPath, source_span: `L${i + 1}-L${i + 1}`, effective_from: null, effective_to: null,
        updated_at: today(), confidence: 1, sensitivity: 'internal', entities: [], tags: ['correction', 'override'],
        approved: true, evidence: 'correction', supersedes: hit ? hit[1] : `fact:${slug(text)}`, version: 1, source: 'override',
      });
    });
    return out;
  }

  /** Every parsed line of the user file, in order. Malformed lines are skipped. */
  function userLines() {
    const out = [];
    for (const line of safeRead(file).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && typeof o === 'object' && typeof o.id === 'string' && typeof o.supersedes === 'string' && Number.isInteger(o.version)) out.push(o);
      } catch { /* skip a corrupt line, keep the rest */ }
    }
    return out;
  }

  const toRecord = (l) => ({
    id: l.id, type: 'correction', title: String(l.text || l.id).split(/[:(]/)[0].trim().slice(0, 80) || l.id, text: String(l.text || ''),
    source_path: file, source_span: 'L1-L1', effective_from: null, effective_to: null,
    updated_at: l.created_at || today(), confidence: 1, sensitivity: 'internal', entities: [], tags: ['correction', 'user'],
    approved: true, evidence: 'correction', supersedes: l.supersedes, version: l.version, source: 'user',
  });

  /** Latest line per id; an id whose latest line is a tombstone is deleted. */
  function liveUser() {
    const last = new Map();
    for (const l of userLines()) last.set(l.id, l);
    return [...last.values()].filter((l) => !l.deleted);
  }

  // Every override is its own fact. A user correction starts its own lineage unless it explicitly
  // `replaces` an existing correction id; only then does it hide that override or earlier version.
  const lineageOf = (l) => l.lineage || l.id;

  function list() {
    const overrides = loadOverrides();
    const latest = new Map();
    for (const l of liveUser()) {
      const key = lineageOf(l);
      const cur = latest.get(key);
      if (!cur || l.version >= cur.version) latest.set(key, l);
    }
    // A user line hides an override only while that override still has the text it replaced
    // (override ids are positional, so editing or reordering profile_overrides.md must not hide the wrong rule).
    const hides = (o) => [...latest.values()].some((l) => lineageOf(l) === o.id && (!l.replacesHash || l.replacesHash === textHash(o.text)));
    return [...overrides.filter((o) => !hides(o)), ...[...latest.values()].filter((l) => !/^COR-OVR-/.test(lineageOf(l)) || overrides.some((o) => o.id === lineageOf(l) && hides(o))).map(toRecord)];
  }

  /** @param {string} supersedes */
  function history(supersedes) {
    const rows = [
      ...loadOverrides().filter((r) => r.supersedes === supersedes),
      ...userLines().filter((l) => l.supersedes === supersedes),
    ];
    return rows.map((r, i) => [i, r]).sort((a, b) => a[1].version - b[1].version || a[0] - b[0]).map((x) => x[1]);
  }

  // replaces: id of an existing correction (override or user) this one supersedes; omit to add a new fact.
  /** @param {{ supersedes?: string, text?: string, replaces?: string }} [opts] */
  function add({ supersedes, text, replaces } = {}) {
    if (typeof supersedes !== 'string' || !supersedes.trim()) throw new Error('add: supersedes is required');
    if (typeof text !== 'string' || !text.trim()) throw new Error('add: text is required');
    const target = supersedes.trim();
    const all = userLines();
    let lineage = null;
    let version = 1;
    if (replaces) {
      const ov = loadOverrides().find((o) => o.id === replaces);
      const ul = all.filter((l) => l.id === replaces || lineageOf(l) === replaces);
      if (!ov && !ul.length) throw new Error(`add: unknown correction to replace: ${replaces}`);
      lineage = ov ? ov.id : lineageOf(ul[0]);
      version = Math.max(ov ? ov.version : 0, ...all.filter((l) => lineageOf(l) === lineage).map((l) => l.version)) + 1;
    }
    const ids = new Set(all.map((l) => l.id));
    let n = ids.size + 1;
    while (ids.has(`COR-${String(n).padStart(4, '0')}`)) n++;
    const id = `COR-${String(n).padStart(4, '0')}`;
    const replacedOverride = replaces ? loadOverrides().find((o) => o.id === lineage) : null;
    const line = { id, supersedes: target, text: text.trim(), created_at: now().toISOString(), version, source: 'user', lineage: lineage || id,
      ...(replaces ? { replaces } : {}), ...(replacedOverride ? { replacesHash: textHash(replacedOverride.text) } : {}) };
    const errs = validateRecord(toRecord(line));
    if (errs.length) throw new Error(`Invalid correction: ${errs.join('; ')}`);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
    return toRecord(line);
  }

  function remove(id) {
    const live = userLines().filter((l) => l.id === id);
    if (!live.length) throw new Error(/^COR-OVR-/.test(String(id)) ? 'remove: overrides live in profile_overrides.md; edit that file' : `remove: unknown correction ${id}`);
    const last = live[live.length - 1];
    if (last.deleted) return { id, removed: false };
    const tomb = { id, supersedes: last.supersedes, text: last.text, created_at: now().toISOString(), version: last.version, source: 'user', lineage: lineageOf(last), deleted: true };
    fs.appendFileSync(file, `${JSON.stringify(tomb)}\n`, 'utf8');
    return { id, removed: true };
  }

  /** JSON string of the override records and every raw line of the user file (tombstones included). */
  function exportAll() {
    return JSON.stringify({ overrides: loadOverrides(), user: userLines() }, null, 2);
  }

  /** @param {{ confirm?: boolean }} [opts] */
  function purge({ confirm } = {}) {
    if (confirm !== true) throw new Error('purge requires { confirm: true }');
    try { fs.unlinkSync(file); return { deleted: true }; } catch (e) {
      if (e && e.code === 'ENOENT') return { deleted: false };
      throw e;
    }
  }

  return { list, history, add, remove, exportAll, purge, file };
}

module.exports = { createCorrections, compileAliases, DEFAULT_ALIASES };
