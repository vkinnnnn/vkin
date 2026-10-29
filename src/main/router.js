// @ts-check
'use strict';
// Deterministic route policy (ADR 0001). No LLM decides routing.

// Output caps leave room for the longer, STAR-structured answers at ANSWER_LENGTH=medium.
const SHAPE_TOKENS = { star: 500, explain: 380, compare: 340, recommend: 320, direct: 260, clarify: 80 };
const LENGTH_SCALE = { short: 0.8, medium: 1, long: 1.4 };

function createRouter({ config, registry }) {
  const llm = config.llm || {};
  const ans = config.answer || {};
  let liveCalls = 0;
  let deepCalls = 0;

  // Complexity is about independent constraints, calculation and conflicts, never raw length.
  function complexityScore(meta, ctx = {}) {
    let s = 0;
    s += Math.min(3, meta.complexity.constraints) * 0.15;
    if (meta.complexity.needsCalc) s += 0.3;
    if (meta.stakes === 'high') s += 0.2;
    if (ctx.contradictions) s += 0.25;
    if (ctx.previousFailure) s += 0.3;
    if (ctx.retrievalConfidence != null && ctx.retrievalConfidence < 0.3 && meta.needs_personal_evidence) s += 0.1;
    if (/\b(in depth|deep dive|walk me through the math|step by step)\b/i.test(meta.literal_question)) s += 0.2;
    return Math.min(1, s);
  }

  function route(meta, ctx = {}) {
    const shapeTokens = SHAPE_TOKENS[meta.expected_answer_shape] || SHAPE_TOKENS.direct;
    const scale = LENGTH_SCALE[ans.length || 'short'] || 1;
    const maxOutputTokens = Math.round((meta.kind === 'casual' ? 60 : shapeTokens) * (meta.expected_answer_shape === 'star' ? 1 : scale));
    const score = complexityScore(meta, ctx);
    const reasons = [`${meta.question_type}/${meta.expected_answer_shape}`, `complexity ${score.toFixed(2)}`];

    let chosen = 'default';
    const deepThreshold = llm.deepComplexityThreshold ?? 0.6;
    // Defined deep triggers only: complexity at/above the threshold, or an explicit user request
    // ("Deeper answer"). The share cap limits automatic escalation only; a user's explicit request
    // skips it. Every other gate (enabled, budget floor, model) applies to both.
    if (ctx.requestDeep) reasons.push('deep requested');
    if (score >= deepThreshold || ctx.requestDeep) {
      // Share including this call; the first calls of a session can never exceed the cap.
      const shareIfDeep = (deepCalls + 1) / (liveCalls + 1);
      const budgetOk = ctx.remainingUsableUsd == null || ctx.remainingUsableUsd > (llm.deepMinRemainingUsd ?? 5);
      if (!llm.enableDeepRoute) reasons.push('deep disabled');
      else if (!ctx.requestDeep && shareIfDeep > (llm.deepMaxShare ?? 0.05)) reasons.push('deep share cap');
      else if (!budgetOk) reasons.push('deep budget floor');
      else if (!registry.modelFor('deep')) reasons.push('no deep model');
      else chosen = 'deep';
    }
    if (chosen === 'default' && meta.needs_personal_evidence && registry.modelFor('personal') !== registry.modelFor('default')) {
      chosen = 'personal';
      reasons.push('personal model configured');
    }
    const uncertain = chosen !== 'deep' && score >= deepThreshold && !ctx.requestDeep;
    return {
      route: chosen,
      model: registry.modelFor(chosen),
      maxOutputTokens: chosen === 'deep' ? Math.round(maxOutputTokens * 1.3) : maxOutputTokens,
      deep: chosen === 'deep',
      addUncertainty: uncertain, // DEEP-class question answered on DEFAULT: say briefly what is uncertain
      complexity: score,
      reason: reasons.join('; '),
    };
  }

  function recordCall(r) {
    liveCalls += 1;
    if (r && r.route === 'deep') deepCalls += 1;
  }

  return { route, recordCall, complexityScore, stats: () => ({ liveCalls, deepCalls }) };
}

module.exports = { createRouter, SHAPE_TOKENS };
