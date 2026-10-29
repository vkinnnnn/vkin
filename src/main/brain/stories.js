// @ts-check
'use strict';
// STAR story selector (ADR 0002): scores star_story records on competency fit, completeness, specificity,
// result strength, recency, voice (neutral for now) and repetition, plus a keyword relevance bonus.
// Local and deterministic: no LLM, no network.

/** @type {typeof import('minisearch').default} */
const MiniSearch = /** @type {any} */ (require('minisearch'));
const { COMPETENCIES } = require('./schema');
const { STOP_WORDS, FILLER_WORDS } = require('./session');
const { recencyOf, wordMatch, clamp01 } = require('./retrieve');

const DEFAULT_WEIGHTS = Object.freeze({
  competency: 0.30, completeness: 0.20, specificity: 0.15, result: 0.15, recency: 0.10, voice: 0.05, repetition: 0.05,
  keyword: 0.15, // keyword relevance to the query, up to +0.15
});

const ACTION_VERBS = [
  'built', 'wrote', 'designed', 'ran', 'implemented', 'developed', 'created', 'led', 'deployed', 'tested', 'debugged',
  'refactored', 'migrated', 'automated', 'optimized', 'optimised', 'analyzed', 'analysed', 'configured', 'proposed',
  'organized', 'organised', 'trained', 'fixed', 'shipped', 'launched', 'integrated', 'reduced', 'improved', 'drove',
  'coordinated', 'presented', 'evaluated', 'benchmarked', 'modeled', 'modelled', 'mapped', 'scoped', 'negotiated',
  'mentored', 'documented', 'set up', 'wired', 'profiled', 'measured', 'prototyped', 'reviewed', 'split', 'replaced',
  'rewrote', 'owned', 'managed', 'delivered', 'established', 'introduced', 'diagnosed', 'traced',
];
const FIRST_PERSON_VERB = new RegExp(
  `(?<![\\p{L}\\p{N}])I\\s+(?:(?:then|also|first|quickly|later|personally|independently|soon|mostly)\\s+)?(?:${ACTION_VERBS.map((v) => v.replace(' ', '\\s+')).join('|')})(?![\\p{L}\\p{N}])`,
  'gu',
);
const STRONG_EVIDENCE = new Set(['employment', 'built', 'deployed']);
const MEDIUM_EVIDENCE = new Set(['evaluated', 'coursework']);

const lc = (s) => String(s || '').toLowerCase();
const blank = (s) => !String(s || '').trim();

/**
 * Competency keys whose COMPETENCIES keywords occur in the text. Keywords match at the start of a word
 * (so "collaborat" matches "collaborated" and "team" matches "teammate"); keywords of 3 letters or fewer
 * must match a whole word ("led" must not match "ledger"). Result follows COMPETENCIES key order.
 */
function inferCompetencies(text) {
  const t = lc(text).replace(/\s+/g, ' ');
  const out = [];
  for (const [key, kws] of Object.entries(COMPETENCIES)) {
    const hit = kws.some((kw) => {
      const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]?');
      const tail = kw.length <= 3 ? '(?![\\p{L}\\p{N}])' : '';
      return new RegExp(`(?<![\\p{L}\\p{N}])${esc}${tail}`, 'u').test(t);
    });
    if (hit && !out.includes(key)) out.push(key);
  }
  return out;
}

function completenessOf(star) {
  const parts = [star.situation, star.action, star.result];
  return parts.filter((p) => !blank(p)).length / parts.length; // task is optional
}

function specificityOf(record) {
  const action = String((record.star && record.star.action) || '');
  const verbs = (action.match(FIRST_PERSON_VERB) || []).length;
  const named = new Set();
  for (const e of record.entities || []) if (e && wordMatch(action, e)) named.add(lc(e));
  return clamp01((verbs + named.size) / 4);
}

function resultOf(record) {
  const result = String((record.star && record.star.result) || '');
  if (blank(result)) return 0;
  if (/\d/.test(result)) {
    if (STRONG_EVIDENCE.has(record.evidence)) return 1;
    if (MEDIUM_EVIDENCE.has(record.evidence)) return 0.8;
  }
  return 0.4;
}

/** @param {{ records?: any[], weights?: any, threshold?: number, now?: () => number }} [opts] */
function createStorySelector({ records = [], weights, threshold = 0.45, now = () => Date.now() } = {}) {
  const W = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const stories = [];
  const seen = new Set();
  for (const r of records) {
    if (!r || r.type !== 'star_story' || r.sensitivity === 'restricted' || r.approved === false || seen.has(r.id)) continue;
    seen.add(r.id);
    stories.push(r);
  }
  const byId = new Map(stories.map((s) => [s.id, s]));

  const index = new MiniSearch({
    fields: ['title', 'entities', 'tags', 'text'],
    idField: 'id',
    processTerm: (term) => {
      const t = lc(term);
      return STOP_WORDS.has(t) || FILLER_WORDS.has(t) ? null : t;
    },
  });
  index.addAll(stories.map((s) => ({
    id: s.id,
    title: s.title,
    entities: (s.entities || []).join(' '),
    tags: (s.tags || []).join(' '),
    text: [s.text, s.star.situation, s.star.task, s.star.action, s.star.result].filter(Boolean).join(' '),
  })));

  function ownKeywordScores(query) {
    const hits = index.search(String(query || ''), {
      boost: { title: 3, entities: 2, tags: 1.5 },
      prefix: true,
      fuzzy: (term) => (term.length >= 6 ? 0.2 : false),
    });
    const max = hits.reduce((m, h) => Math.max(m, h.score), 0);
    const out = new Map();
    if (max > 0) for (const h of hits) out.set(h.id, h.score / max);
    return out;
  }

  // exclude: story ids that must not be picked (e.g. the person asked for "another example").
  /** @param {{ query?: string, competencies?: any, session?: any, retriever?: any, exclude?: any[] }} [opts] */
  function select({ query = '', competencies, session, retriever, exclude = [] } = {}) {
    const q = String(query || '');
    const excluded = new Set(exclude);
    const wanted = (Array.isArray(competencies) && competencies.length ? competencies : inferCompetencies(q)).map(lc);
    const wantedSet = new Set(wanted);
    const nowMs = now();
    const usageOf = (id) => (session && typeof session.usageCount === 'function' ? session.usageCount(id) : 0);
    const kw = retriever && typeof retriever.keywordScores === 'function'
      ? retriever.keywordScores(q, { types: ['star_story'] })
      : ownKeywordScores(q);

    let best = null;
    for (const s of stories) {
      if (excluded.has(s.id)) continue;
      // A story that is only listed (no evidence of doing the work) is usable only when the query names it.
      if (s.evidence === 'listed-only' && !(s.entities || []).some((e) => wordMatch(q, e))) continue;
      const tags = (s.tags || []).map(lc);
      const comp = lc(s.star.competency);
      const f = {
        competency: wantedSet.has(comp) ? 1 : tags.some((t) => wantedSet.has(t)) ? 0.5 : 0,
        completeness: completenessOf(s.star),
        specificity: specificityOf(s),
        result: resultOf(s),
        recency: recencyOf(s, nowMs),
        voice: 0.5, // neutral until approved voice samples exist
        repetition: 1 - Math.min(1, usageOf(s.id) / 2),
        keyword: kw.get(s.id) || 0,
      };
      // Quality features alone must never make an unrelated story a match.
      if (!(f.competency > 0 || f.keyword > 0)) continue;
      let score = 0;
      for (const k of Object.keys(DEFAULT_WEIGHTS)) score += (W[k] || 0) * f[k];
      if (!best || score > best.score || (score === best.score && s.id < best.story.id)) best = { story: s, score, breakdown: f };
    }
    return best && best.score >= threshold ? best : null;
  }

  return { select, inferCompetencies, stories: () => stories.map((s) => s.id), get: (id) => byId.get(id) || null };
}

module.exports = { createStorySelector, inferCompetencies, DEFAULT_WEIGHTS };
