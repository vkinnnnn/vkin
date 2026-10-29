// @ts-check
'use strict';
// In-memory session memory for the personal-brain (ADR 0002). Never persisted: no fs, no network.
// Tracks recent questions, which records/stories were already used (repetition penalty) and topic terms
// that bias retrieval. Everything is bounded and expires after a period of inactivity.

const STOP_WORDS = new Set((
  'a an the and or but if then else of to in on at by for with without from into onto over under about above below up down out off ' +
  'is are was were be been being am do does did done doing have has had having will would shall should can could may might must ' +
  'i me my mine we us our ours you your yours he him his she her hers it its they them their theirs this that these those ' +
  'what which who whom whose when where why how as so than too very just also not no nor only own same such some any all each ' +
  'both few more most other here there again once while because until during before after through between against'
).split(/\s+/));

// Interview filler that carries no topical signal ("Tell me about a time ...").
const FILLER_WORDS = new Set((
  'tell describe explain give share walk talk discuss please example examples story stories time times ever recall ' +
  'situation question questions answer say let know like want need get got sure maybe really actually'
).split(/\s+/));

const MAX_TOPIC_TERMS = 40;
const MAX_KEPT_QUESTIONS = 20;
const TOPIC_QUESTIONS = 10;
const SNAPSHOT_QUESTIONS = 5;
const MAX_QUESTION_CHARS = 500;

function tokenize(text) {
  const raw = String(text || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]*/gu) || [];
  return raw.map((t) => t.replace(/[.-]+$/, '')).filter(Boolean);
}

function topicTokens(text) {
  return tokenize(text).filter((t) => t.length >= 2 && !STOP_WORDS.has(t) && !FILLER_WORDS.has(t));
}

function createSession({ ttlMinutes = 120, now = () => Date.now(), meetingNotes = '' } = {}) {
  const ttlMs = ttlMinutes * 60000;
  let notes = String(meetingNotes || '');
  let questions = [];
  let usage = new Map();
  let activeStoryId = null; // the story currently being discussed (FABEL_ACTIVE_CONTEXT_V2)
  let lastActivity = now();

  const expired = () => now() - lastActivity > ttlMs;

  function noteQuestion(text) {
    if (expired()) return; // stays empty until reset()
    const q = String(text || '').trim().slice(0, MAX_QUESTION_CHARS);
    if (!q) return;
    questions.push(q);
    if (questions.length > MAX_KEPT_QUESTIONS) questions = questions.slice(-MAX_KEPT_QUESTIONS);
    lastActivity = now();
  }

  function noteUsed(recordIds, storyId) {
    if (expired()) return;
    const list = Array.isArray(recordIds) ? recordIds : recordIds ? [recordIds] : [];
    const ids = new Set([...list, ...(storyId ? [storyId] : [])]);
    for (const id of ids) if (typeof id === 'string' && id) usage.set(id, (usage.get(id) || 0) + 1);
    lastActivity = now();
  }

  function usageCount(id) {
    return expired() ? 0 : usage.get(id) || 0;
  }

  // Active story: the one a follow-up should continue ("what did you do there?") rather than replace.
  function setActiveStory(id) { activeStoryId = typeof id === 'string' && id ? id : null; lastActivity = now(); }

  function recentQuestions(n = SNAPSHOT_QUESTIONS) {
    if (expired() || !(n > 0)) return [];
    return questions.slice(-Math.floor(n));
  }

  function computeTopicTerms() {
    if (expired()) return [];
    const out = [];
    const seen = new Set();
    const add = (t) => { if (!seen.has(t) && out.length < MAX_TOPIC_TERMS) { seen.add(t); out.push(t); } };
    // Most recent questions first, so long meeting notes cannot crowd out the live topic.
    for (const q of questions.slice(-TOPIC_QUESTIONS).reverse()) topicTokens(q).forEach(add);
    topicTokens(notes).forEach(add);
    return out;
  }

  function snapshot() {
    const isExpired = expired();
    return {
      expired: isExpired,
      ttlMinutes,
      lastActivity,
      questionCount: isExpired ? 0 : questions.length,
      recentQuestions: recentQuestions(SNAPSHOT_QUESTIONS),
      usage: isExpired ? {} : Object.fromEntries(usage),
      topicTerms: computeTopicTerms(),
    };
  }

  // Clears questions and usage and restarts the TTL clock. Meeting notes are kept unless replaced.
  function reset(newMeetingNotes) {
    questions = [];
    usage = new Map();
    activeStoryId = null;
    if (typeof newMeetingNotes === 'string') notes = newMeetingNotes;
    lastActivity = now();
  }

  return {
    noteQuestion,
    noteUsed,
    usageCount,
    setActiveStory,
    get activeStoryId() { return expired() ? null : activeStoryId; },
    get topicTerms() { return computeTopicTerms(); },
    recentQuestions,
    snapshot,
    expired,
    reset,
  };
}

module.exports = { createSession, STOP_WORDS, FILLER_WORDS, tokenize, topicTokens };
