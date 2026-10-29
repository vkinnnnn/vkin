// @ts-check
'use strict';
// One canonical, session-scoped dialogue-state contract (FABEL PRD v2, Stage 7 / Stage 17),
// gated at the call sites by FABEL_DIALOGUE_STATE_V2. In-memory only: no fs, no network.
//
// It makes the three states an answer can be in EXPLICIT and SEPARATE:
//   generated  - the model produced it (it may never be shown).
//   displayed  - it reached the overlay/phone (the user may never have spoken it).
//   spoken     - the user actually said it (inferred only from the ME transcript or an explicit action).
// A cancelled or superseded answer can never contribute a "delivered" claim, and corrections are
// appended (the audit history is never rewritten). Every transition is explicit, atomic and bounded.

const CAPS = {
  recentTurnIds: 12,
  answers: 60, // keep the most recent answer records for audit + novelty; older ones are pruned
  openings: 5,
  transitions: 5,
  phrases: 40,
  corrections: 50,
  commitments: 50,
};

const ANSWER_STATE = Object.freeze({ GENERATED: 'generated', DISPLAYED: 'displayed', SPOKEN: 'spoken', CANCELLED: 'cancelled', SUPERSEDED: 'superseded' });
const DELIVERED = new Set([ANSWER_STATE.DISPLAYED, ANSWER_STATE.SPOKEN]); // content that actually reached the user
const str = (v) => (typeof v === 'string' ? v : '');
const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);

function createDialogueState({ sessionId = '', now = () => Date.now() } = {}) {
  /** @type {Map<string, any>} */
  let answers = new Map(); // answerId -> record (insertion-ordered; audit history)
  let state = fresh();

  function fresh() {
    return {
      activeTopicId: null,
      activeStoryId: null,
      recentTurnIds: [],
      openQuestions: [], // {turnId, question}
      commitments: [],
      corrections: [], // appended, never erased
      recentOpenings: [],
      recentTransitions: [],
      recentDistinctivePhrases: [],
      lastDisplayedAnswerId: null,
      lastUserSpokenTurnId: null,
    };
  }

  const pushCapped = (arr, v, cap) => { arr.push(v); if (arr.length > cap) arr.splice(0, arr.length - cap); };
  const record = (id) => answers.get(str(id)) || null;

  function pruneAnswers() {
    if (answers.size <= CAPS.answers) return;
    const keys = [...answers.keys()];
    for (const k of keys.slice(0, answers.size - CAPS.answers)) answers.delete(k);
  }

  // ---- turns / topic / story ----
  function noteTurn(turnId) {
    const id = str(turnId);
    if (!id) return;
    if (state.recentTurnIds[state.recentTurnIds.length - 1] !== id) pushCapped(state.recentTurnIds, id, CAPS.recentTurnIds);
  }
  function setActiveTopic(topicId) { state.activeTopicId = topicId == null ? null : str(topicId) || null; }
  function setActiveStory(storyId) { state.activeStoryId = storyId == null ? null : str(storyId) || null; }

  // ---- answer lifecycle: generated -> displayed -> spoken (or cancelled/superseded) ----
  /** @param {{ answerId: string, turnId?: string|null, kind?: string, storyId?: string|null, exampleIds?: string[], claims?: string[], opening?: string, phrases?: string[] }} rec */
  function answerGenerated({ answerId, turnId = null, kind = '', storyId = null, exampleIds = [], claims = [], opening = '', phrases = [] }) {
    const id = str(answerId);
    if (!id) return null;
    const rec = {
      answerId: id, turnId: turnId == null ? null : str(turnId), kind: str(kind),
      storyId: storyId == null ? null : str(storyId), exampleIds: strArr(exampleIds),
      claims: strArr(claims), opening: str(opening), phrases: strArr(phrases),
      state: ANSWER_STATE.GENERATED, generatedAt: now(), displayedAt: null, spokenAt: null,
    };
    answers.set(id, rec);
    pruneAnswers();
    return rec;
  }

  // `enrich` carries facts known only once the answer is built (its story, examples, claims, opening,
  // distinctive phrases). It fills empty fields; it never overwrites what generation already recorded.
  /** @param {{ storyId?: string|null, exampleIds?: string[], claims?: string[], opening?: string, phrases?: string[] }} [enrich] */
  function answerDisplayed(answerId, enrich) {
    const rec = record(answerId);
    if (!rec || rec.state === ANSWER_STATE.CANCELLED || rec.state === ANSWER_STATE.SUPERSEDED) return false;
    if (enrich) {
      if (!rec.storyId && enrich.storyId) rec.storyId = str(enrich.storyId);
      if (!rec.exampleIds.length && enrich.exampleIds) rec.exampleIds = strArr(enrich.exampleIds);
      if (!rec.claims.length && enrich.claims) rec.claims = strArr(enrich.claims);
      if (!rec.opening && enrich.opening) rec.opening = str(enrich.opening);
      if (!rec.phrases.length && enrich.phrases) rec.phrases = strArr(enrich.phrases);
    }
    if (rec.state === ANSWER_STATE.GENERATED) { rec.state = ANSWER_STATE.DISPLAYED; rec.displayedAt = now(); }
    state.lastDisplayedAnswerId = rec.answerId;
    if (rec.opening) pushCapped(state.recentOpenings, rec.opening, CAPS.openings);
    for (const p of rec.phrases) if (!state.recentDistinctivePhrases.includes(p)) pushCapped(state.recentDistinctivePhrases, p, CAPS.phrases);
    return true;
  }

  // The user actually spoke an answer (from ME transcript / explicit action). Marks spoken; never
  // assumes it from "displayed".
  function answerSpoken(answerId) {
    const rec = record(answerId);
    if (!rec) return false;
    if (rec.state === ANSWER_STATE.CANCELLED || rec.state === ANSWER_STATE.SUPERSEDED) return false;
    rec.state = ANSWER_STATE.SPOKEN;
    rec.spokenAt = now();
    if (rec.turnId) state.lastUserSpokenTurnId = rec.turnId;
    return true;
  }

  // A generated answer that is cancelled/superseded before (or instead of) display: it can never
  // contribute a delivered claim. A displayed/spoken answer keeps its delivered state (audit).
  function answerCancelled(answerId) { return endAnswer(answerId, ANSWER_STATE.CANCELLED); }
  function answerSuperseded(answerId) { return endAnswer(answerId, ANSWER_STATE.SUPERSEDED); }
  function endAnswer(answerId, endState) {
    const rec = record(answerId);
    if (!rec) return false;
    if (DELIVERED.has(rec.state)) return false; // already reached the user: keep the audit truth
    rec.state = endState;
    return true;
  }

  // ---- other episodic facts ----
  function noteOpenQuestion({ turnId = null, question = '' } = {}) {
    const q = str(question).trim();
    if (!q) return;
    state.openQuestions.push({ turnId: turnId == null ? null : str(turnId), question: q });
  }
  function resolveOpenQuestion(turnId) {
    const id = str(turnId);
    state.openQuestions = state.openQuestions.filter((o) => o.turnId !== id);
  }
  function noteCommitment(text) { const t = str(text).trim(); if (t) pushCapped(state.commitments, t, CAPS.commitments); }
  function noteCorrection(text) { const t = str(text).trim(); if (t) pushCapped(state.corrections, t, CAPS.corrections); }
  function noteTransition(text) { const t = str(text).trim(); if (t) pushCapped(state.recentTransitions, t, CAPS.transitions); }

  // ---- derived views (exclude cancelled/superseded answers) ----
  const delivered = () => [...answers.values()].filter((r) => DELIVERED.has(r.state));
  function claimsDelivered() { return delivered().flatMap((r) => r.claims); }
  function storiesUsed() { return [...new Set(delivered().map((r) => r.storyId).filter(Boolean))]; }
  function examplesUsed() { return [...new Set(delivered().flatMap((r) => r.exampleIds))]; }
  function answerState(answerId) { const r = record(answerId); return r ? r.state : null; }
  function wasDelivered(answerId) { const r = record(answerId); return !!r && DELIVERED.has(r.state); }

  function snapshot() {
    return {
      sessionId,
      activeTopicId: state.activeTopicId,
      activeStoryId: state.activeStoryId,
      recentTurnIds: [...state.recentTurnIds],
      displayedAnswerIds: [...answers.values()].filter((r) => r.state === ANSWER_STATE.DISPLAYED || r.state === ANSWER_STATE.SPOKEN).map((r) => r.answerId),
      generatedButUndisplayedAnswerIds: [...answers.values()].filter((r) => r.state === ANSWER_STATE.GENERATED).map((r) => r.answerId),
      claimsDelivered: claimsDelivered(),
      storiesUsed: storiesUsed(),
      examplesUsed: examplesUsed(),
      openQuestions: state.openQuestions.map((o) => ({ ...o })),
      commitments: [...state.commitments],
      corrections: [...state.corrections],
      recentOpenings: [...state.recentOpenings],
      recentTransitions: [...state.recentTransitions],
      recentDistinctivePhrases: [...state.recentDistinctivePhrases],
      lastDisplayedAnswerId: state.lastDisplayedAnswerId,
      lastUserSpokenTurnId: state.lastUserSpokenTurnId,
    };
  }

  function reset() { answers = new Map(); state = fresh(); }

  return {
    ANSWER_STATE,
    noteTurn, setActiveTopic, setActiveStory,
    answerGenerated, answerDisplayed, answerSpoken, answerCancelled, answerSuperseded,
    noteOpenQuestion, resolveOpenQuestion, noteCommitment, noteCorrection, noteTransition,
    claimsDelivered, storiesUsed, examplesUsed, answerState, wasDelivered,
    get activeTopicId() { return state.activeTopicId; },
    get activeStoryId() { return state.activeStoryId; },
    get lastDisplayedAnswerId() { return state.lastDisplayedAnswerId; },
    get lastUserSpokenTurnId() { return state.lastUserSpokenTurnId; },
    snapshot, reset,
  };
}

module.exports = { createDialogueState, ANSWER_STATE, CAPS };
