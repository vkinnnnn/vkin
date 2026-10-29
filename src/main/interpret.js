// @ts-check
'use strict';
// Question interpreter v2 (FABEL PRD v2, Stage 8), behind FABEL_QUESTION_INTERPRETER_V2.
// Deterministic only (no LLM call): it re-shapes the existing understand() metadata into the PRD's
// structured "interpreted question" and resolves elliptical follow-ups against the active topic/story.

// Map FABEL's internal `kind` onto the PRD question-type enum.
const TYPE = {
  behavioral: 'behavioral', biographical: 'biographical', walkthrough: 'biographical', strengths: 'biographical',
  role_fit: 'biographical', factual: 'biographical', project_detail: 'biographical',
  motivation: 'motivation', technical: 'technical', literature: 'literature', methodological: 'methodology',
  situational: 'situational', compare: 'comparison', availability: 'availability', clarification: 'clarification',
  casual: 'casual', check_in: 'casual', questions_for_them: 'casual', opinion: 'unknown', authorization: 'unknown',
  compensation: 'unknown', other: 'unknown',
};

// Default spoken duration (seconds) by PRD question type; the midpoint of the PRD length table.
const SECONDS = {
  behavioral: 90, behavioral_follow_up: 32, motivation: 45, technical: 67, methodology: 67, literature: 67,
  biographical: 40, situational: 45, comparison: 45, availability: 20, clarification: 8, casual: 10, unknown: 30,
};

const has = (re, s) => re.test(String(s || ''));

// A follow-up that drills into one past experience (used to classify behavioral_follow_up even when the
// bare utterance, e.g. "what did you personally do there?", would classify as a plain factual question).
const STAR_DRILL = /\b(what did you (personally )?do|how did you (do|handle|decide|measure|approach|figure)|why did you|what (was|were) (the|your) (result|results|outcome|impact|role|responsib\w*|situation|context|challenge|hardest|difficult|part)|what was the (result|outcome|hardest|difficult)|what did you learn)\b/i;
// Follow-up kinds that are NOT behavioral even when phrased as "why did you ..." (keep them as-is).
const NON_BEHAVIORAL = new Set(['technical', 'literature', 'methodological', 'compare', 'motivation', 'availability', 'authorization', 'compensation', 'clarification', 'casual']);

// Which STAR component a behavioral follow-up asks for.
function focusedShape(surface) {
  const s = String(surface || '');
  if (has(/\b(results?|outcome|impact|turn(ed)? out|end(ed)? up|effect)\b/i, s)) return 'focused_star_result';
  if (has(/\b(situation|context|challenge|difficult\w*|hard(est)?|tough|problem|obstacle)\b/i, s)) return 'focused_star_situation';
  if (has(/\bresponsib\w*\b|\byour (role|job|part)\b|\bwhat were you (meant|supposed) to\b/i, s)) return 'focused_star_task';
  return 'focused_star_action'; // "what did you do", "why", "how did you measure", "what did you decide"
}

const REQUIRED = {
  behavioral: ['situation', 'personal actions', 'result'],
  behavioral_follow_up: ['the requested STAR component'],
  biographical: ['verified background facts'],
  motivation: ['genuine reason', 'supporting evidence'],
  technical: ['direct answer', 'application', 'limitation'],
  methodology: ['method', 'limitations'],
  literature: ['the finding', 'its scope'],
  situational: ['approach (not a claimed past event)'],
  comparison: ['both sides', 'a recommendation'],
  availability: ['already-stated commitments only'],
  clarification: ['a concise restatement'],
  casual: [], unknown: ['closest verified knowledge'],
};

/**
 * @param {{
 *   meta: any, surfaceQuestion: string, turnId?: string|null,
 *   followUp?: boolean, lastTopicQuestion?: string, lastTopicTurnId?: string|null, activeStoryId?: string|null
 * }} p
 */
function interpretQuestion({ meta, surfaceQuestion, turnId = null, followUp = false, lastTopicQuestion = '', lastTopicTurnId = null, activeStoryId = null }) {
  const surface = String(surfaceQuestion || '').trim();
  const kind = meta.kind;
  let questionType = TYPE[kind] || 'unknown';
  // A rhetorical check-in / "any questions?" expects no substantive answer.
  if (kind === 'questions_for_them' || kind === 'check_in') questionType = 'casual';
  const isBehavioralFollowUp = followUp && !NON_BEHAVIORAL.has(kind)
    && (kind === 'behavioral' || meta.expected_answer_shape === 'star' || STAR_DRILL.test(surface));
  if (isBehavioralFollowUp) questionType = 'behavioral_follow_up';

  let answerShape = meta.expected_answer_shape;
  if (isBehavioralFollowUp) answerShape = focusedShape(surface);

  // Reference resolution: an elliptical follow-up is resolved against the topic/story it follows.
  const referencedTurnIds = followUp && lastTopicTurnId ? [lastTopicTurnId] : [];
  const resolvedQuestion = followUp && lastTopicQuestion
    ? `${surface} (regarding: ${String(lastTopicQuestion).trim()})`
    : surface;

  const secondsKey = isBehavioralFollowUp ? 'behavioral_follow_up' : questionType;
  // Low confidence when the model itself wants clarification, or an unresolved elliptical with nothing to resolve against.
  const ambiguous = Boolean(meta.needs_clarification)
    || (followUp && !lastTopicQuestion && !activeStoryId && (meta.complexity && meta.complexity.words <= 3));
  const confidence = ambiguous ? 0.4 : (meta.ambiguities && meta.ambiguities.length ? 0.7 : 0.9);

  return {
    turnId: turnId == null ? null : String(turnId),
    surfaceQuestion: surface,
    resolvedQuestion,
    questionType,
    kind, // keep FABEL's internal kind alongside the PRD enum
    intent: meta.underlying_intent || '',
    referencedTurnIds,
    referencedEntities: Array.isArray(meta.entities) ? meta.entities : [],
    requiredEvidence: REQUIRED[questionType] || [],
    answerShape,
    expectedSeconds: SECONDS[secondsKey] || 30,
    needsRetrieval: kind !== 'casual' && kind !== 'check_in' && kind !== 'questions_for_them',
    needsClarification: Boolean(meta.needs_clarification),
    activeStoryId: activeStoryId || null,
    confidence,
  };
}

module.exports = { interpretQuestion, TYPE, SECONDS, focusedShape };
