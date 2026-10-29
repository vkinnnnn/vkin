// @ts-check
'use strict';
// End-of-session memory draft (docs/vkin-contracts.md). Built ONLY from what was actually said: the
// user's own speech (ME channel) and the other person's (THEM). Copilot suggestions are never input,
// so a suggestion can never become something the user "said". Every item starts as a draft the user
// edits and approves; nothing here is retrieved until approved.

const MAX_TEXT = 300;
const LIMITS = { commitment: 6, action_item: 6, decision: 6, open_question: 5 };

// The user promising something ("I'll send the deck by Friday").
const COMMIT = /\b(?:i(?:'ll| will| can| am going to|'m going to)\s+(?:send|share|follow up|get back|email|write|prepare|draft|review|look into|check|set up|schedule|update|finish|deliver)|let me (?:send|share|follow up|get back|check))\b/i;
// The other person asking for something.
const REQUEST = /\b(?:can you|could you|would you|please|send (?:me|us)|share (?:the|your)|we(?:'d| would) need you to)\b/i;
// A decision either side states.
const DECIDE = /\b(?:we(?:'ll| will) go with|let's go with|let's (?:do|use|move|keep|start)|we(?:'ve| have)? (?:agreed|decided)|agreed to|decided to|the plan is)\b/i;

/** @param {string} s */
const clip = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
};

/**
 * @param {{ lines?: {speaker:'me'|'them', text:string, at?:string}[] }} [p]
 * @returns {{ kind:string, text:string, origin:'my_speech'|'their_speech', source_at:string|null }[]}
 */
function draftFromTranscript({ lines = [] } = {}) {
  /** @type {{ kind:string, text:string, origin:'my_speech'|'their_speech', source_at:string|null }[]} */
  const out = [];
  const seen = new Set();
  const counts = /** @type {Record<string, number>} */ ({});
  /** @param {string} kind @param {any} line */
  const add = (kind, line) => {
    const text = clip(line.text);
    const key = `${kind}:${text.toLowerCase()}`;
    if (!text || seen.has(key) || (counts[kind] || 0) >= (LIMITS[/** @type {keyof typeof LIMITS} */ (kind)] || 5)) return;
    seen.add(key);
    counts[kind] = (counts[kind] || 0) + 1;
    out.push({ kind, text, origin: line.speaker === 'me' ? 'my_speech' : 'their_speech', source_at: line.at || null });
  };
  for (const line of lines) {
    const t = String(line.text || '');
    if (t.split(/\s+/).length < 4) continue;
    if (line.speaker === 'me' && COMMIT.test(t)) add('commitment', line);
    else if (line.speaker === 'them' && REQUEST.test(t)) add('action_item', line);
    if (DECIDE.test(t)) add('decision', line);
    if (line.speaker === 'them' && /\?\s*$/.test(t)) add('open_question', line);
  }
  return out;
}

module.exports = { draftFromTranscript, COMMIT, REQUEST, DECIDE };
