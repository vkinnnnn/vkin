// @ts-check
'use strict';
// Answer planner (FABEL PRD v2, Stage 13), behind FABEL_ANSWER_PLANNER. A compact, DETERMINISTIC plan
// computed before prose and rendered into the single generation call (no second paid planning call).
// It names the structure, the target length, and what to avoid (already-said content, canned openings).

// Canned openings to avoid regardless of history.
const CANNED = [
  'One example that comes to mind', 'What I would say is', 'Great question', "That's a great question",
  "I'm glad you asked", 'To be honest', 'At the end of the day', 'As I mentioned',
];

// FABEL answer-shape -> PRD plan structure.
function structureFor(meta, interpreted) {
  const shape = (interpreted && interpreted.answerShape) || meta.expected_answer_shape;
  if (interpreted && interpreted.needsClarification) return 'clarification';
  if (shape && shape.startsWith('focused_star_')) return shape; // behavioural follow-up component
  const kind = meta.kind;
  if (shape === 'star') return 'natural_star';
  if (kind === 'motivation') return 'motivation';
  if (kind === 'technical' || kind === 'literature' || kind === 'methodological') return 'technical';
  if (kind === 'situational') return 'situational';
  if (shape === 'compare' || kind === 'compare') return 'comparison';
  if (shape === 'clarify') return 'clarification';
  return 'direct';
}

const firstWords = (s, n = 4) => String(s || '').replace(/^\s*SAY:\s*/i, '').trim().split(/\s+/).slice(0, n).join(' ');

/**
 * @param {{ meta: any, interpreted?: any, ledger?: any, convo?: {question:string, answer:string}[], wordsPerMinute?: number }} p
 */
function buildPlan({ meta, interpreted = null, ledger = null, convo = [], wordsPerMinute = 150 }) {
  const structure = structureFor(meta, interpreted);
  const seconds = interpreted && interpreted.expectedSeconds ? interpreted.expectedSeconds
    : structure === 'natural_star' ? 90 : structure.startsWith('focused_star_') ? 32 : structure === 'technical' ? 67 : structure === 'motivation' ? 45 : 30;
  const targetWords = Math.max(20, Math.round((seconds * wordsPerMinute) / 60));
  // Avoid: everything already delivered, plus canned openings and the distinctive openings of recent answers.
  const avoidInformation = ledger && Array.isArray(ledger.alreadyDeliveredClaims) ? ledger.alreadyDeliveredClaims.slice() : (convo || []).map((c) => String(c.answer || '').slice(0, 80));
  const recentOpenings = (convo || []).map((c) => firstWords(c.answer, 5)).filter(Boolean);
  const avoidPhrases = [...new Set([...CANNED, ...recentOpenings])];
  const evidenceIds = ledger && Array.isArray(ledger.allowedClaims) ? ledger.allowedClaims.map((a) => a.sourceId) : (Array.isArray(meta.sourceIds) ? meta.sourceIds : []);
  const newInformation = structure.startsWith('focused_star_')
    ? [structure.replace('focused_star_', '') + ' of the active story, in more depth than before']
    : [];

  return {
    turnId: interpreted && interpreted.turnId ? interpreted.turnId : null,
    directAnswer: '', // the model writes the lead sentence; the plan constrains structure and length
    structure,
    evidenceIds,
    newInformation,
    avoidInformation,
    avoidPhrases,
    targetWords,
    targetSeconds: seconds,
  };
}

// Compact prompt block. Deterministic structure/length guidance for the single generation call.
function renderPlan(plan) {
  if (!plan) return '';
  const lines = [
    `structure: ${plan.structure}`,
    `target: about ${plan.targetWords} words (~${plan.targetSeconds}s spoken)`,
  ];
  if (plan.newInformation.length) lines.push(`focus on: ${plan.newInformation.join('; ')}`);
  if (plan.avoidPhrases.length) lines.push(`do not open with: ${plan.avoidPhrases.slice(0, 6).map((p) => `"${p}"`).join(', ')}`);
  if (plan.avoidInformation.length) lines.push(`do not repeat already-said points: ${plan.avoidInformation.slice(0, 4).map((p) => `"${String(p).slice(0, 60)}"`).join(', ')}`);
  return `<answer_plan>\n${lines.join('\n')}\n</answer_plan>`;
}

module.exports = { buildPlan, renderPlan, structureFor, CANNED };
