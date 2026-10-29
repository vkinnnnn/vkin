// @ts-check
'use strict';
// Hybrid retrieval over parsed BrainRecords (ADR 0002): MiniSearch keyword score + entity, competency,
// recency, confidence and session features, then dedupe / diversity / token-budget selection.
// Local and deterministic: no embeddings, no LLM, no network.

/** @type {typeof import('minisearch').default} */
const MiniSearch = /** @type {any} */ (require('minisearch'));
const { estimateTokens } = require('../budget');
const { EVIDENCE } = require('./schema');
const { STOP_WORDS, FILLER_WORDS } = require('./session');

const DEFAULT_WEIGHTS = Object.freeze({
  keyword: 0.45, entity: 0.15, competency: 0.15, recency: 0.10, confidence: 0.10, session: 0.05,
});
const RECENCY_YEARS = 6;
const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const MAX_PARENT_ITEMS = 2;
const DIVERSITY_OVERLAP = 0.8;
const DIVERSITY_SCORE_BYPASS = 0.9;
const GENERIC_CORRECTION_TAGS = new Set(['correction', 'corrections', ...EVIDENCE]);

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lc = (s) => String(s).toLowerCase();
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (s) => lc(s).match(/[\p{L}\p{N}]+/gu) || [];
const meaningful = (s) => words(s).filter((w) => w.length >= 2 && !STOP_WORDS.has(w) && !FILLER_WORDS.has(w));

/** Case-insensitive, word-bounded containment test (handles entities like "C++"). */
function wordMatch(text, term) {
  if (!term) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

function parseWhen(s) {
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(String(s));
  if (m) {
    const y = Number(m[1]);
    // end of the stated period: a record that ended in "2024" is as recent as December 2024
    return m[2] ? Date.UTC(y, Number(m[2]), 1) - 1 : Date.UTC(y + 1, 0, 1) - 1;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** 1 for ongoing (effective_from set, effective_to null) or future-dated, linear to 0 over six years. */
function recencyOf(record, nowMs) {
  let t;
  if (record.effective_to) t = parseWhen(record.effective_to);
  else if (record.effective_from) return 1;
  else t = parseWhen(record.updated_at);
  if (t === null || t === undefined) return 0;
  return clamp01(1 - (nowMs - t) / YEAR_MS / RECENCY_YEARS);
}

function estimate(record) {
  return estimateTokens(record.title + record.text);
}

/** Truncate a record's text so that title + text fits the token budget. */
function fitRecord(record, budget) {
  const full = estimate(record);
  if (full <= budget) return { record, tokens: full, truncated: false };
  let lo = 0;
  let hi = record.text.length;
  const make = (n) => {
    let end = n;
    const c = record.text.charCodeAt(end - 1);
    if (end > 0 && c >= 0xd800 && c <= 0xdbff) end -= 1; // never split a surrogate pair
    return end > 0 ? `${record.text.slice(0, end).trimEnd()}…` : '';
  };
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimateTokens(record.title + make(mid)) <= budget) lo = mid; else hi = mid - 1;
  }
  const copy = { ...record, text: make(lo) };
  return { record: copy, tokens: estimate(copy), truncated: true };
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const eligible = (r) => r && r.sensitivity !== 'restricted' && r.approved !== false;
// Stories and detail records ("PRJ-019-method") count toward their entry's per-parent limit.
const parentOf = (r) => (r.star && r.star.parent_id) || (r.fields && r.fields.parent_id) || r.id;
const normText = (s) => lc(s).replace(/\s+/g, ' ').trim();

function createSearchIndex(docs, { fuzzy = 0.2 } = {}) {
  const index = new MiniSearch({
    fields: ['title', 'entities', 'tags', 'text'],
    idField: 'id',
    processTerm: (term) => {
      const t = lc(term);
      return STOP_WORDS.has(t) ? null : t;
    },
    searchOptions: { prefix: true, fuzzy },
  });
  index.addAll(docs);
  return index;
}

/** @param {{ records?: any[], corrections?: any[], weights?: any, now?: () => number }} [opts] */
function createRetriever({ records = [], corrections = [], weights, now = () => Date.now() } = {}) {
  const W = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const byId = new Map();
  const correctionById = new Map();
  for (const r of [...records, ...corrections]) {
    if (!eligible(r)) continue;
    if (r.type === 'correction') { if (!correctionById.has(r.id)) correctionById.set(r.id, r); } else if (!byId.has(r.id)) byId.set(r.id, r);
  }
  // Sorted by id so scores (BM25 sums are order sensitive) do not depend on the order records arrive in.
  const pool = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Only the latest version of each correction target stays active.
  const latest = new Map();
  for (const c of correctionById.values()) {
    const k = lc(c.supersedes || c.id);
    const cur = latest.get(k);
    const v = c.version || 0;
    if (!cur || v > (cur.version || 0) || (v === (cur.version || 0) && c.id > cur.id)) latest.set(k, c);
  }
  const activeCorrections = [...latest.values()].sort((a, b) => (a.id < b.id ? -1 : 1));

  const index = createSearchIndex(pool.map((r) => ({
    id: r.id, title: r.title, entities: (r.entities || []).join(' '), tags: (r.tags || []).join(' '), text: r.text,
  })));

  // Known entities, longest first so "State University" masks before "State".
  const entitySet = new Map();
  for (const r of pool) for (const e of r.entities || []) if (e && e.length >= 2 && !STOP_WORDS.has(lc(e))) entitySet.set(lc(e), e);
  const knownEntities = [...entitySet.keys()]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map((lower) => ({ lower, re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(lower)}(?![\\p{L}\\p{N}])`, 'giu') }));

  function extractQueryEntities(query) {
    const known = [];
    const loose = [];
    let masked = query;
    for (const { lower, re } of knownEntities) {
      const next = masked.replace(re, ' ');
      if (next !== masked) { known.push(lower); masked = next; }
    }
    const caps = masked.match(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}+#]*/gu) || [];
    for (const c of caps) {
      const t = lc(c);
      if (t.length < 2 || STOP_WORDS.has(t) || FILLER_WORDS.has(t) || known.includes(t) || loose.includes(t)) continue;
      loose.push(t);
    }
    return { known, loose };
  }

  /** Normalized (0..1, by the max in the result set) MiniSearch score per record id. */
  /** @param {any} query @param {{ types?: any }} [opts] */
  function keywordScores(query, { types } = {}) {
    const hits = index.search(String(query || ''), {
      boost: { title: 3, entities: 2, tags: 1.5 },
      prefix: true,
      fuzzy: 0.2,
      filter: (res) => !types || types.includes(byId.get(res.id).type),
    });
    const max = hits.reduce((m, h) => Math.max(m, h.score), 0);
    const out = new Map();
    if (max > 0) for (const h of hits) out.set(h.id, h.score / max);
    return out;
  }

  function matchCorrections(returned, qLower, qWords) {
    const out = [];
    for (const c of activeCorrections) {
      const sup = lc(c.supersedes || '');
      let hit = returned.some((it) => {
        const r = it.record;
        return lc(r.id) === sup || lc(parentOf(r)) === sup || (r.entities || []).some((e) => lc(e) === sup);
      });
      if (!hit) {
        const kw = new Set([
          ...meaningful(c.title),
          ...(c.entities || []).flatMap((e) => [lc(e), ...words(e)]),
          ...(c.tags || []).map(lc).filter((t) => !GENERIC_CORRECTION_TAGS.has(t)),
        ]);
        const supWords = sup.split(/[_\-\s]+/).filter((w) => w && !STOP_WORDS.has(w));
        hit = qWords.some((w) => kw.has(w)) ||
          (sup.length >= 3 && qLower.includes(sup)) ||
          (supWords.length > 1 && supWords.every((w) => qWords.includes(w)));
      }
      if (hit) out.push(c);
    }
    return out;
  }

  function choose(ranked, pre, budget, maxItems) {
    const chosen = [...pre];
    const parents = new Map();
    const texts = new Set();
    let used = 0;
    for (const it of pre) {
      used += it.tokens;
      parents.set(parentOf(it.record), (parents.get(parentOf(it.record)) || 0) + 1);
      texts.add(normText(it.record.text));
    }
    for (const cand of ranked) {
      if (chosen.length >= maxItems) break;
      const r = cand.record;
      const parent = parentOf(r);
      // An entry fact sheet (setup / method / result) may take one extra slot next to its siblings.
      if ((parents.get(parent) || 0) >= MAX_PARENT_ITEMS + (r.fields && r.fields.part ? 1 : 0)) continue;
      const nt = normText(r.text);
      if (texts.has(nt)) continue;
      const ents = new Set((r.entities || []).map(lc));
      // Near-duplicate entity sets are skipped, except parts of the same entry (its fact sheets complement it).
      if (chosen.length && cand.score <= DIVERSITY_SCORE_BYPASS &&
          chosen.some((c) => parentOf(c.record) !== parent && jaccard(ents, new Set((c.record.entities || []).map(lc))) > DIVERSITY_OVERLAP)) continue;
      let fitted;
      if (chosen.length === 0) fitted = fitRecord(r, budget); // only the very first item may be truncated
      else {
        const tokens = estimate(r);
        if (used + tokens > budget) continue;
        fitted = { record: r, tokens, truncated: false };
      }
      chosen.push({ ...cand, record: fitted.record, tokens: fitted.tokens, truncated: fitted.truncated });
      used += fitted.tokens;
      parents.set(parent, (parents.get(parent) || 0) + 1);
      texts.add(nt);
    }
    return chosen;
  }

  function search(query, opts = {}) {
    const { competencies = [], session, budgetTokens = 2200, maxItems = 6, types } = opts;
    const q = String(query || '');
    const qLower = lc(q);
    const qWords = words(q).filter((w) => !STOP_WORDS.has(w));
    const nowMs = now();
    const wantedComps = new Set((competencies || []).map(lc));
    const topic = new Set(session && Array.isArray(session.topicTerms) ? session.topicTerms.map(lc) : []);
    const usageOf = (id) => (session && typeof session.usageCount === 'function' ? session.usageCount(id) : 0);

    const kw = keywordScores(q, { types });
    const { known, loose } = extractQueryEntities(q);
    const qEntityCount = known.length + loose.length;

    const ranked = [];
    for (const r of pool) {
      if (types && !types.includes(r.type)) continue;
      const ents = new Set((r.entities || []).map(lc));
      const entWords = new Set([...ents].flatMap(words));
      let entityHits = 0;
      for (const e of known) if (ents.has(e)) entityHits += 1;
      for (const e of loose) if (ents.has(e) || entWords.has(e)) entityHits += 1;
      const tags = (r.tags || []).map(lc);
      const f = {
        keyword: kw.get(r.id) || 0,
        entity: qEntityCount ? entityHits / qEntityCount : 0,
        competency: wantedComps.size && (tags.some((t) => wantedComps.has(t)) || wantedComps.has(lc((r.star && r.star.competency) || ''))) ? 1 : 0,
        recency: recencyOf(r, nowMs),
        confidence: clamp01(Number(r.confidence) || 0),
        session: topic.size && ([...ents].some((e) => topic.has(e) || words(e).some((w) => topic.has(w))) || tags.some((t) => topic.has(t))) ? 1 : 0,
      };
      if (!(f.keyword > 0 || f.entity > 0 || f.competency > 0)) continue; // no relevance signal at all
      const penalty = Math.min(0.3, 0.1 * usageOf(r.id));
      let score = -penalty;
      for (const k of Object.keys(DEFAULT_WEIGHTS)) score += (W[k] || 0) * f[k];
      ranked.push({ record: r, score, breakdown: { ...f, penalty } });
    }
    ranked.sort((a, b) => b.score - a.score || (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0));

    // Pass 1 finds which records would be returned; corrections that target them are then reserved first.
    let chosen = choose(ranked, [], budgetTokens, maxItems);
    const matched = matchCorrections(chosen, qLower, qWords);
    if (matched.length) {
      const pre = [];
      let used = 0;
      for (const c of matched) {
        if (pre.length >= maxItems) break;
        let fitted;
        if (pre.length === 0) fitted = fitRecord(c, budgetTokens);
        else {
          const tokens = estimate(c);
          if (used + tokens > budgetTokens) continue;
          fitted = { record: c, tokens, truncated: false };
        }
        pre.push({ record: fitted.record, score: 1, breakdown: { correction: 1 }, tokens: fitted.tokens, truncated: fitted.truncated });
        used += fitted.tokens;
      }
      chosen = choose(ranked, pre, budgetTokens, maxItems);
    }

    const items = chosen.map((it) => {
      const out = { record: it.record, score: it.score, breakdown: it.breakdown };
      if (it.truncated) out.truncated = true;
      return out;
    });
    return { items, sourceIds: items.map((it) => it.record.id), tokensEst: chosen.reduce((n, it) => n + it.tokens, 0) };
  }

  return { search, keywordScores };
}

module.exports = { createRetriever, createSearchIndex, DEFAULT_WEIGHTS, recencyOf, wordMatch, fitRecord, clamp01 };
