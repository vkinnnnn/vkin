// @ts-check
'use strict';
// Personal-brain records: CareerPro entries (sections 6-10), STAR stories (section 13) and identity lines
// (quick_facts.md). Every record satisfies the locked schema (schema.js). Sources are read-only.
const fs = require('node:fs');
const path = require('node:path');
const { stripIds, dropContact, evidenceOf, excludeMatcher } = require('../context');
const { COMPETENCIES, validateRecord } = require('./schema');

const MAX_TEXT = 2400;
const CONFIDENCE = { employment: 0.95, certification: 0.95, deployed: 0.9, built: 0.9, evaluated: 0.85, coursework: 0.85, recognition: 0.8, 'listed-only': 0.6, identity: 1 };
const TYPE_BY_PREFIX = { EXP: 'experience', PRJ: 'experience', ACA: 'fact', CERT: 'fact', VOL: 'fact', AWD: 'fact' };
const THEME_TO_COMPETENCY = {
  'technical challenge': 'technical_challenge',
  teamwork: 'teamwork',
  'competing requirements and trade-offs': 'tradeoffs',
  deadline: 'deadline',
  'failure and recovery': 'failure',
  'learning fast': 'learning',
  'stakeholder communication': 'stakeholder',
  ambiguity: 'ambiguity',
};
const STORY_FIELD = { 'situation and task': 'situation', situation: 'situation', task: 'task', action: 'action', result: 'result' };
const CONTACT_LEFT = /[\w.+-]+@[\w-]+\.[\w.]+|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|https?:\/\//;

// ---------- text helpers ----------

/** stripIds + tidy the fragments ID removal leaves behind ("(see )", "(preparation coursework for)"). */
function scrub(text) {
  return stripIds(text)
    .replace(/[ \t]*\([^()\n]*\b(?:for|see|from|per|of|and|with|in)\)/gi, '')
    .replace(/\b(?:Verification|Credential|wallet|credential URL)[ \t]*:[ \t]*(?=[.;,)]|$)/gim, '')
    .replace(/[ \t]*\(\s*\)/g, '')
    .replace(/\*\*/g, '')
    .replace(/[ \t]+([,.;:!?)])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const clean = (text) => scrub(dropContact(text));

function cap(text, max = MAX_TEXT) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const cut = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('. '), head.lastIndexOf('; '));
  return (cut > max * 0.6 ? head.slice(0, cut + 1) : head.replace(/\s+\S*$/, '')).trimEnd();
}

/** Split on `sep` outside parentheses. */
function splitTop(str, sep) {
  const out = [];
  let depth = 0, cur = '';
  const re = sep instanceof RegExp ? new RegExp(`^(?:${sep.source})`, sep.flags.replace('g', '')) : null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const m = re ? re.exec(str.slice(i)) : (str.startsWith(sep, i) ? [sep] : null);
      if (m && m[0].length) { out.push(cur); cur = ''; i += m[0].length - 1; continue; }
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// ---------- dates ----------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const SEASONS = 'spring|summer|fall|autumn|winter';
const MON = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';
const SINGLE_RE = new RegExp(`^(?:issued\\s+)?(?:${MON}\\s+(?:\\d{1,2},?\\s*)?)?(\\d{4})$`, 'i');
const SEASON_RE = new RegExp(`^(?:${SEASONS})\\s+(\\d{4})$`, 'i');
const DAY_RANGE_RE = new RegExp(`^${MON}\\s+\\d{1,2}\\s+to\\s+(?:${MON}\\s+)?\\d{1,2},?\\s*(\\d{4})$`, 'i');
const PRESENT_RE = /^(?:present|current|ongoing|now)$/i;
const ym = (y, m) => (m ? `${y}-${String(m).padStart(2, '0')}` : String(y));

/** A single date token -> {from, to}; null when it is not exactly one date. */
function parseToken(s) {
  s = s.trim().replace(/[.,]$/, '');
  let m = SINGLE_RE.exec(s);
  if (m) { const v = ym(m[2], m[1] ? MONTHS[m[1].toLowerCase()] : 0); return { from: v, to: v }; }
  m = SEASON_RE.exec(s); // a season names a year, not a month: never guess the months
  if (m) return { from: m[1], to: m[1] };
  m = DAY_RANGE_RE.exec(s);
  if (m) {
    const mons = [...s.matchAll(new RegExp(MON, 'gi'))].map((x) => MONTHS[x[1].toLowerCase()]);
    const y = m[m.length - 1];
    return { from: ym(y, mons[0]), to: ym(y, mons[mons.length - 1]) };
  }
  return null;
}

/** One expression without ';' or top-level 'and': a token, "A to B", "A to Present", "valid to B". */
function parseExpr(s) {
  s = s.trim();
  let m = /^valid\s+(?:to|until|through)\s+(.+)$/i.exec(s);
  if (m) { const t = parseToken(m[1]); return t ? { from: null, to: t.to, open: false } : null; }
  m = /^(.+?)\s+to\s+(.+)$/i.exec(s);
  if (m && !DAY_RANGE_RE.test(s)) {
    const a = parseToken(m[1]);
    if (!a) return null;
    if (PRESENT_RE.test(m[2].trim())) return { from: a.from, to: null, open: true };
    const b = parseToken(m[2]);
    if (!b) return null;
    return a.from > b.to ? null : { from: a.from, to: b.to, open: false };
  }
  if (PRESENT_RE.test(s)) return null;
  const t = parseToken(s);
  return t ? { ...t, open: false } : null;
}

/** Prefer a month-precise reading (main text, then parentheses) over a year-level one. */
function parsePart(part) {
  const main = part.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const parens = [...part.matchAll(/\(([^()]*)\)/g)].map((x) => x[1]);
  const mainRes = main ? parseExpr(main) : null;
  const precise = (r) => r && [r.from, r.to].some((v) => v && v.includes('-'));
  if (precise(mainRes)) return mainRes;
  const inner = parens.map(parseExpr);
  return inner.find(precise) || mainRes || inner.find(Boolean) || null;
}

/**
 * Parse a "When"/"Term"/"Date" value into {from, to} ("YYYY-MM" | "YYYY" | null), or null if unparseable.
 * "Present" gives to=null. Lists ("A; B", "A and B") become the covering span when every part parses;
 * extra unparseable clauses are ignored only if every year they mention lies inside the parsed span.
 */
function parseWhen(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = splitTop(value, ';').flatMap((p) => splitTop(p, /\s+and\s+/i));
  const parsed = parts.map(parsePart);
  const ok = parsed.filter(Boolean);
  if (!ok.length) return null;
  const froms = ok.map((r) => r.from).filter(Boolean);
  const tos = ok.map((r) => r.to).filter(Boolean);
  const open = ok.some((r) => r.open);
  const from = froms.length ? froms.reduce((a, b) => (b < a ? b : a)) : null;
  const to = open ? null : (tos.length ? tos.reduce((a, b) => (b > a ? b : a)) : null);
  if (!from && !to && !open) return null;
  const lo = Number((from || to).slice(0, 4)), hi = open ? Infinity : Number((to || from).slice(0, 4));
  let failed = false;
  parts.forEach((p, i) => {
    if (parsed[i]) return;
    const years = (p.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
    if (years.some((y) => y < lo || y > hi)) failed = true;
  });
  if (failed) return null;
  return { from, to };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2022-01" -> "Jan 2022"; "2022" -> "2022"; null -> ''. */
function formatYm(v) {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})$/.exec(v);
  return m ? `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}` : v;
}

// ---------- markdown parsing ----------

function parseFrontmatter(lines) {
  const fm = {};
  if (lines[0] !== '---') return fm;
  for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
    const m = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

function trimTail(lines) {
  let end = lines.length - 1;
  while (end >= 0 && (!lines[end].trim() || /^---+\s*$/.test(lines[end]))) end--;
  return lines.slice(0, end + 1);
}

/** Raw labelled fields: "**Label:** value" plus the continuation lines that follow. */
function parseFields(bodyLines) {
  const fields = {};
  let key = null;
  for (const line of bodyLines) {
    const m = /^\*\*([^*:]+?):\*\*\s*(.*)$/.exec(line);
    if (m) { key = m[1].trim(); fields[key] = m[2]; continue; }
    if (key) fields[key] += `\n${line}`;
  }
  for (const k of Object.keys(fields)) fields[k] = fields[k].trim();
  return fields;
}

function parseDoc(src) {
  const lines = src.split(/\r?\n/);
  const meta = parseFrontmatter(lines);
  const entries = [], stories = [];
  let sec = 0, secTitle = '', theme = '', cur = null, story = null;
  const closeEntry = () => {
    if (!cur) return;
    const body = trimTail(cur.lines);
    entries.push({ ...cur, body, span: `L${cur.startIdx + 1}-L${cur.startIdx + 1 + body.length}` });
    cur = null;
  };
  const closeStory = () => {
    if (!story) return;
    stories.push({ ...story, span: `L${story.startIdx + 1}-L${story.endIdx + 1}` });
    story = null;
  };
  lines.forEach((line, idx) => {
    const h2 = /^## (\d+)\.\s*(.*)$/.exec(line);
    const h3 = /^### (.*)$/.exec(line);
    if (h2 || h3) {
      closeEntry(); closeStory();
      if (h2) { sec = Number(h2[1]); secTitle = h2[2].trim(); theme = ''; return; }
      const e = /^\[([A-Z]+-\d+)\]\s*(.*)$/.exec(h3[1]);
      if (e && sec >= 6 && sec <= 10) cur = { id: e[1], title: e[2].trim(), sec, secTitle, startIdx: idx, lines: [] };
      else theme = h3[1].trim();
      return;
    }
    if (sec === 13) {
      const s = /^- \*\*([A-Z]+-\d+):\s*(.*?)\*\*\s*(.*)$/.exec(line);
      if (s) { closeStory(); story = { parentId: s[1], title: s[2].replace(/[.\s]+$/, ''), hook: s[3].trim(), theme, startIdx: idx, endIdx: idx, parts: {}, last: null }; return; }
      if (story && line.trim()) {
        const f = /^\s+-\s*([A-Za-z ]+?):\s*(.*)$/.exec(line);
        if (f && STORY_FIELD[f[1].trim().toLowerCase()]) {
          story.last = STORY_FIELD[f[1].trim().toLowerCase()];
          story.parts[story.last] = ((story.parts[story.last] || '') + ' ' + f[2]).trim();
          story.endIdx = idx; return;
        }
        if (/^\s{2,}\S/.test(line) && story.last) { story.parts[story.last] += ` ${line.trim()}`; story.endIdx = idx; return; }
        if (/^---+\s*$/.test(line)) return;
      }
      return;
    }
    if (cur) cur.lines.push(line);
  });
  closeEntry(); closeStory();
  return { meta, entries, stories, lineCount: lines.length };
}

// ---------- record building ----------

function listItems(value) {
  return splitTop(String(value || ''), ',').map((s) => s.trim()).filter(Boolean);
}

function entitiesOf({ id, title, fields }) {
  const out = [];
  const add = (v) => { v = String(v || '').replace(/\s+/g, ' ').replace(/^[\s,;:.]+|[\s,;:.]+$/g, '').trim(); if (v && v.length <= 80 && !CONTACT_LEFT.test(v) && !/^https?:/i.test(v)) out.push(v); };
  for (const item of listItems(fields.Stack)) {
    const m = /^([^(]+?)\s*\((.*)\)\s*$/.exec(item);
    if (m) { add(m[1]); listItems(m[2]).forEach(add); } else add(item);
  }
  const where = stripParens(fields.Where || fields.Organization || '');
  const wherePieces = splitTop(where, ',').map((s) => s.replace(/https?:\/\/\S+/g, '').trim()).filter(Boolean);
  if (wherePieces[0]) add(wherePieces[0]);
  if (id.startsWith('EXP')) wherePieces.slice(1, 3).forEach(add); // city and country of a workplace
  const head = /^([^:(]+?)\s*(?::|\()/.exec(title);
  if (head && head[1].split(/\s+/).length <= 4) add(head[1]);
  for (const m of title.matchAll(/\b[A-Z][\w-]*(?:\s+[A-Z][\w-]*)+/g)) add(m[0]);
  const seen = new Set();
  return out.filter((e) => { const k = e.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 30);
}
const stripParens = (s) => String(s).replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();

/** Parent entities the story itself mentions (case-insensitive), else the parent's first few. */
function storyEntities(parent, text) {
  const t = text.toLowerCase();
  const hit = parent.entities.filter((e) => t.includes(e.toLowerCase()));
  return (hit.length ? hit : parent.entities.slice(0, 3)).slice(0, 12);
}

function competenciesIn(text) {
  const t = text.toLowerCase();
  return Object.keys(COMPETENCIES).filter((k) => COMPETENCIES[k].some((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(t)));
}

function entryText(type, fields, body) {
  if (type === 'experience') {
    const order = ['Summary', 'Situation', 'Task', 'Action', 'Result', 'Interview talking points'];
    const parts = order.filter((k) => fields[k]).map((k) => (/\n|^- /.test(fields[k]) ? `${k}:\n${fields[k]}` : `${k}: ${fields[k]}`));
    if (parts.length) return parts.join('\n');
  }
  return body.filter((l) => !/^\*\*Credential:\*\*/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n');
}

// Detail records ("fact sheets"): the full entry split by what a question usually asks for, so "what data did
// you use", "which stack", "what accuracy" retrieve the exact facts instead of a summary. Same evidence class.
const DETAIL_PARTS = [
  { part: 'setup', label: 'setup, data and scope', keys: ['Type', 'When', 'Where', 'Team', 'Role', 'Summary', 'Situation', 'Task'] },
  { part: 'method', label: 'what I built and how: methods and tech stack', keys: ['Stack', 'Action', 'Architecture and key decisions'] },
  { part: 'result', label: 'results, metrics and lessons', keys: ['Result', 'Interview talking points'] },
];
const DETAIL_SKIP = new Set(['Resume bullets', 'Keywords', 'Credential']);
const DETAIL_MAX = 2600;

function detailRecords(e, base, rawFields, ctx) {
  const known = new Set(DETAIL_PARTS.flatMap((d) => d.keys));
  // Fields outside the standard set (data sources, datasets, metrics definitions...) go with the setup.
  const extraKeys = Object.keys(rawFields).filter((k) => !known.has(k) && !DETAIL_SKIP.has(k));
  const out = [];
  for (const d of DETAIL_PARTS) {
    const keys = d.part === 'setup' ? [...d.keys, ...extraKeys] : d.keys;
    const blocks = keys.filter((k) => rawFields[k]).map((k) => `${k}: ${clean(rawFields[k])}`);
    // No links, emails or phone numbers in the text (the record schema forbids them).
    let text = blocks.join('\n').replace(/https?:\/\/\S+/g, '').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '').replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, '').trim();
    if (!text) continue;
    // Long sections are split at line breaks so each chunk stays small enough to retrieve alongside others.
    const chunks = [];
    while (text.length > DETAIL_MAX) {
      const cutAt = Math.max(text.lastIndexOf('\n', DETAIL_MAX), text.lastIndexOf('. ', DETAIL_MAX));
      const at = cutAt > DETAIL_MAX * 0.5 ? cutAt + 1 : DETAIL_MAX;
      chunks.push(text.slice(0, at).trim());
      text = text.slice(at).trim();
    }
    if (text) chunks.push(text);
    chunks.forEach((chunk, i) => {
      out.push(makeRecordBase({
        id: `${e.id}-${d.part}${chunks.length > 1 ? i + 1 : ''}`,
        type: 'experience', title: `${base.title}: ${d.label}${chunks.length > 1 ? ` (part ${i + 1})` : ''}`, text: chunk,
        source_span: e.span, effective_from: base.effective_from, effective_to: base.effective_to, confidence: base.confidence,
        entities: base.entities, tags: [...new Set([...base.tags, 'detail', d.part])], evidence: base.evidence,
        fields: { parent_id: e.id, part: d.part },
      }, ctx));
    });
  }
  return out;
}

function makeRecordBase(extra, ctx) {
  return { source_path: ctx.sourcePath, updated_at: ctx.updated, sensitivity: 'internal', approved: true, ...extra };
}

/** @param {{ config?: any, readFile?: (p: string) => string, root?: string }} [opts] */
function loadRecords({ config, readFile = (p) => fs.readFileSync(p, 'utf8'), root } = {}) {
  const pc = (config && config.profile) || {};
  const base = root || path.resolve(__dirname, '..', '..', '..');
  const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(base, p));
  const replacements = pc.replacements || [];
  const applyRep = (t) => { for (const { find, replace } of replacements) if (find) t = t.split(find).join(replace ?? ''); return t; };
  // config.profile.excludeRecords: names whose entries, stories and identity lines are left out (and counted).
  const isExcluded = excludeMatcher(pc.excludeRecords);

  // No career profile (not configured, or the file is gone) is a valid start: the engine then has no personal
  // records and says so instead of inventing any.
  const careerPath = pc.careerPro ? abs(pc.careerPro) : '';
  let src = '';
  if (careerPath) {
    try { src = applyRep(String(readFile(careerPath))); } catch (e) {
      if (!(e && (e.code === 'ENOENT' || /\bENOENT\b|no such file/i.test(String(e.message))))) throw e;
    }
  }
  const { meta, entries, stories } = parseDoc(src);
  const updated = /^\d{4}-\d{2}-\d{2}/.test(meta.updated || '') ? meta.updated : new Date().toISOString().slice(0, 10);
  const ctx = { sourcePath: careerPath, updated };

  const records = [];
  const stats = { total: 0, byType: {}, byEvidence: {}, excluded: 0, skipped: 0 };
  const dropped = new Set(); // entry ids whose stories must go with them
  const entryInfo = new Map();

  for (const e of entries) {
    const raw = e.body.join('\n');
    if (isExcluded(`${e.title}\n${raw}`)) { stats.excluded++; dropped.add(e.id); continue; }
    const prefix = e.id.split('-')[0];
    const type = TYPE_BY_PREFIX[prefix];
    if (!type) { stats.skipped++; dropped.add(e.id); continue; }
    const rawFields = parseFields(e.body);
    const fields = {};
    for (const [k, v] of Object.entries(rawFields)) fields[k] = clean(v);
    const title = scrub(e.title);
    const text = cap(clean(entryText(type, rawFields, e.body)));
    if (!text || CONTACT_LEFT.test(text)) { stats.skipped++; dropped.add(e.id); continue; }
    const evidence = evidenceOf(e.id, fields.Type || '');
    const when = parseWhen(fields.When || fields.Term || fields.Date || '');
    const kwTags = listItems(fields.Keywords).map((k) => k.toLowerCase()).slice(0, 40);
    const rec = makeRecordBase({
      id: e.id, type, title, text, source_span: e.span,
      effective_from: when ? when.from : null, effective_to: when ? when.to : null,
      confidence: CONFIDENCE[evidence] ?? 0.6,
      entities: entitiesOf({ id: e.id, title, fields }),
      tags: [...new Set([evidence, e.secTitle.toLowerCase(), ...kwTags, ...competenciesIn(text)])],
      evidence, fields,
    }, ctx);
    records.push(rec);
    entryInfo.set(e.id, rec);
    if (pc.detailRecords && (prefix === 'PRJ' || prefix === 'EXP') && evidence !== 'listed-only') records.push(...detailRecords(e, rec, rawFields, ctx));
  }

  const counters = {};
  for (const s of stories) {
    const parent = entryInfo.get(s.parentId);
    const comp = THEME_TO_COMPETENCY[s.theme.toLowerCase()];
    const raw = `${s.title}\n${s.hook}\n${Object.values(s.parts).join('\n')}`;
    if (dropped.has(s.parentId) || isExcluded(raw)) { stats.excluded++; continue; }
    if (!comp) { stats.skipped++; continue; }
    const n = (counters[s.parentId] = (counters[s.parentId] || 0) + 1);
    const evidence = parent ? parent.evidence : evidenceOf(s.parentId, '');
    const star = {
      situation: clean(s.parts.situation || ''), task: clean(s.parts.task || ''),
      action: clean(s.parts.action || ''), result: clean(s.parts.result || ''),
      competency: comp, parent_id: s.parentId,
    };
    const lines = [clean(s.hook)];
    if (star.situation) lines.push(`Situation and task: ${star.situation}`);
    if (star.action) lines.push(`Action: ${star.action}`);
    if (star.result) lines.push(`Result: ${star.result}`);
    const text = cap(lines.filter(Boolean).join('\n'));
    if (!text || CONTACT_LEFT.test(text) || !star.action || !star.result) { stats.skipped++; counters[s.parentId]--; continue; }
    records.push(makeRecordBase({
      id: `STORY-${s.parentId}-${n}`, type: 'star_story', title: scrub(s.title) || `Story ${n}`, text, source_span: s.span,
      effective_from: parent ? parent.effective_from : null, effective_to: parent ? parent.effective_to : null,
      confidence: parent ? parent.confidence : (CONFIDENCE[evidence] ?? 0.6),
      entities: parent ? storyEntities(parent, text) : [],
      tags: [...new Set([comp, 'story', evidence])], evidence, star,
    }, ctx));
  }

  records.push(...loadIdentity({ pc, base, readFile, applyRep, ctx, stats, isExcluded }));

  const bad = [];
  const ids = new Set();
  for (const r of records) {
    const errs = validateRecord(r);
    if (ids.has(r.id)) errs.push('duplicate id');
    ids.add(r.id);
    if (errs.length) bad.push(`${r.id}: ${errs.join('; ')}`);
  }
  if (bad.length) throw new Error(`Invalid brain records (${bad.length}): ${bad.slice(0, 5).join(' | ')}`);

  stats.total = records.length;
  for (const r of records) {
    stats.byType[r.type] = (stats.byType[r.type] || 0) + 1;
    stats.byEvidence[r.evidence] = (stats.byEvidence[r.evidence] || 0) + 1;
  }
  return { records, byId: new Map(records.map((r) => [r.id, r])), stats };
}

// ---------- identity (quick_facts.md: name, Degrees, Experience, Target role tracks) ----------

function sectionOf(lines, heading) {
  const start = lines.findIndex((l) => new RegExp(`^###\\s*${heading}\\s*$`, 'i').test(l));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length && !/^#{2,3}\s/.test(lines[i]); i++) out.push({ line: lines[i], no: i + 1 });
  return out.filter((x) => /^\s*[-*]\s+/.test(x.line)).map((x) => ({ text: x.line.replace(/^\s*[-*]\s+/, '').trim(), no: x.no }));
}

function loadIdentity({ pc, base, readFile, applyRep, ctx, stats, isExcluded = excludeMatcher(pc.excludeRecords) }) {
  if (!pc.partsDir) return [];
  const qfPath = path.isAbsolute(pc.partsDir) ? path.join(pc.partsDir, 'quick_facts.md') : path.resolve(base, pc.partsDir, 'quick_facts.md');
  let raw;
  try { raw = applyRep(String(readFile(qfPath))); } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw new Error(`Cannot read profile file ${qfPath}: ${e.message}`);
  }
  const lines = raw.split(/\r?\n/);
  const mk = (id, kind, title, text, from, to, no, endNo, extra = {}) => {
    const body = clean(text);
    if (!body || CONTACT_LEFT.test(body) || isExcluded(body)) { stats[isExcluded(text) ? 'excluded' : 'skipped']++; return null; }
    return {
      id, type: 'identity', title: scrub(title), text: body, source_path: qfPath, source_span: `L${no}-L${endNo || no}`,
      effective_from: from, effective_to: to, updated_at: ctx.updated, confidence: 1, sensitivity: 'internal',
      entities: [], tags: ['identity', kind], approved: true, evidence: 'identity', fields: { kind, ...extra },
    };
  };
  const out = [];

  // Name and city only: the Contact section is never copied.
  const contact = sectionOf(lines, 'Contact');
  const pick = (label) => contact.find((c) => new RegExp(`^${label}\\s*:`, 'i').test(c.text));
  const name = pick('Name'), loc = pick('Location');
  if (name) {
    const n = name.text.replace(/^Name\s*:\s*/i, '').trim();
    const l = loc ? loc.text.replace(/^Location\s*:\s*/i, '').trim() : '';
    const r = mk('ID-name', 'name', n, l ? `${n}, ${l}` : n, null, null, name.no, loc ? Math.max(name.no, loc.no) : name.no, { name: n, location: l });
    if (r) { r.entities = [n, l].filter(Boolean); out.push(r); }
  }

  sectionOf(lines, 'Degrees').forEach((d, i) => {
    const parts = splitTop(d.text, ',');
    const iu = parts.findIndex((p) => /University|Academy|College|Institute/i.test(p));
    const title = iu >= 0 ? parts.slice(0, iu + 1).join(', ') : parts.slice(0, 2).join(', ');
    let when = null;
    const range = /\b((?:19|20)\d{2})\s+to\s+((?:19|20)\d{2})\b/.exec(d.text);
    if (range) when = { from: range[1], to: range[2] };
    else { const one = [...d.text.matchAll(new RegExp(`${MON}\\s+((?:19|20)\\d{2})`, 'gi'))].pop(); if (one) when = { from: null, to: ym(one[2], MONTHS[one[1].toLowerCase()]) }; }
    const r = mk(`ID-degree-${i + 1}`, 'degree', title, d.text, when && when.from, when && when.to, d.no, d.no);
    if (r) { if (iu >= 0) r.entities = [parts[iu]]; out.push(r); }
  });

  sectionOf(lines, 'Experience').forEach((x, i) => {
    const parentId = (/\(((?:EXP)-\d{3})\)\s*$/.exec(x.text) || [])[1] || null;
    const line = stripIds(x.text).replace(/\s+/g, ' ').trim();
    const segs = splitTop(line.replace(/^LinkedIn only[^:]*:\s*/i, ''), ',');
    const last = segs[segs.length - 1] || '';
    const dm = /^((?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* )?\d{4}(?: to (?:(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* )?\d{4}|Present))?)\s*(?:\(([^)]*)\))?$/i.exec(last);
    const when = dm ? parseWhen(dm[1]) : null;
    const head = segs.slice(0, dm ? -1 : undefined);
    const role = (head[0] || '').trim();
    const org = head[1] || '';
    const place = head.slice(2).join(', ');
    const rec = mk(`ID-role-${i + 1}`, 'role', [role, org].filter(Boolean).join(', ') || line, line, when && when.from, when && when.to, x.no, x.no,
      { parent_id: parentId, role, org, place, when: dm ? dm[1] : '', note: dm && dm[2] ? dm[2] : '', unlisted: /\bnever on resumes\b|\bLinkedIn only\b/i.test(x.text) });
    if (rec) { rec.entities = [org].filter(Boolean); out.push(rec); }
  });

  sectionOf(lines, 'Target role tracks').forEach((t, i) => {
    if (/^Preferences\s*:/i.test(t.text)) return;
    const r = mk(`ID-target-${i + 1}`, 'target', t.text.split(':')[0], t.text, null, null, t.no, t.no);
    if (r) out.push(r);
  });
  return out;
}

module.exports = { loadRecords, parseWhen, formatYm, parseDoc, scrub, splitTop, CONFIDENCE };
