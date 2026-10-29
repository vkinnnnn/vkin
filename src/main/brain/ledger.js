// @ts-check
'use strict';
// Evidence ledger (FABEL PRD v2, Stage 12), behind FABEL_EVIDENCE_LEDGER. A pure derivation that sits
// between retrieval and generation: it states, in compact form, which claims are allowed (with their
// source), which must not be made, what has already been said, and what is unknown. No new retrieval,
// no LLM call. It reinforces the grounding the validator already enforces deterministically afterward.

const CAP = { allowed: 12, disallowed: 10, delivered: 6, unknown: 4, titleChars: 90, clauseChars: 120 };
// Collapse whitespace AND strip angle brackets, so a record title cannot inject a newline or forge a
// </evidence_ledger> close tag into the rendered block (m1 from the Phase-1 review).
const cut = (s, n) => { const t = String(s || '').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const firstSentence = (s) => cut(String(s || '').replace(/^\s*SAY:\s*/i, '').split(/(?<=[.!?])\s/)[0] || '', CAP.clauseChars);

/**
 * story/items/mItems are the engine's selection shapes (they carry extra fields like score/breakdown),
 * so they are typed loosely here; only id + title are read.
 * @param {{
 *   story?: any, items?: any[], mItems?: any[],
 *   convo?: { question: string, answer: string }[],
 *   forbidden?: { reason?: string }[],
 *   meta: any, activeStoryId?: string|null, turnId?: string|null
 * }} p
 */
function buildLedger({ story = null, items = [], mItems = [], convo = [], forbidden = [], meta, activeStoryId = null, turnId = null }) {
  const allowedClaims = [];
  const seen = new Set();
  const add = (id, title) => { if (id && !seen.has(id) && allowedClaims.length < CAP.allowed) { seen.add(id); allowedClaims.push({ sourceId: id, claim: cut(title, CAP.titleChars) }); } };
  if (story && story.story) add(story.story.id, story.story.title);
  for (const i of items) add(i.record.id, i.record.title);
  for (const i of mItems) add(i.record.id, i.record.title);

  const disallowedClaims = [...new Set((forbidden || []).map((f) => cut(f.reason, CAP.clauseChars)).filter(Boolean))].slice(0, CAP.disallowed);
  const alreadyDeliveredClaims = (convo || []).map((c) => firstSentence(c.answer)).filter(Boolean).slice(-CAP.delivered);
  const relevantStoryIds = [...new Set([story && story.story ? story.story.id : null, activeStoryId].filter(Boolean))];
  const unknowns = (!items.length && !(story && story.story) && meta && meta.needs_personal_evidence)
    ? ['No matching verified personal evidence was retrieved; say what is verified or acknowledge the limit.']
    : [];

  return { turnId: turnId == null ? null : String(turnId), allowedClaims, disallowedClaims, alreadyDeliveredClaims, relevantStoryIds, contradictions: [], unknowns };
}

// Compact prompt block. Returns '' when there is nothing material to add.
// compact (FABEL_COMPACT_ENVELOPE): sources by short title only, no internal ids in the prompt.
function renderLedger(ledger, { compact = false } = {}) {
  if (!ledger) return '';
  const parts = [];
  if (ledger.allowedClaims.length) {
    parts.push(compact
      ? `ALLOWED (only facts from the evidence below): ${ledger.allowedClaims.map((a) => cut(a.claim.split(':')[0], 60)).join('; ')}`
      : `ALLOWED (use only facts from these sources):\n${ledger.allowedClaims.map((a) => `- [${a.sourceId}] ${a.claim}`).join('\n')}`);
  }
  if (ledger.disallowedClaims.length) parts.push(`DO NOT SAY:\n${ledger.disallowedClaims.map((d) => `- ${d}`).join('\n')}`);
  if (ledger.alreadyDeliveredClaims.length) parts.push(`ALREADY SAID (do not repeat):\n${ledger.alreadyDeliveredClaims.map((d) => `- ${d}`).join('\n')}`);
  if (ledger.unknowns.length) parts.push(`UNKNOWN:\n${ledger.unknowns.map((u) => `- ${u}`).join('\n')}`);
  if (!parts.length) return '';
  return `<evidence_ledger>\n${parts.join('\n')}\n</evidence_ledger>`;
}

module.exports = { buildLedger, renderLedger, CAP };
