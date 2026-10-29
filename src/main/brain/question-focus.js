// @ts-check
'use strict';
// What part of an utterance is the question, and is it a follow-up?
// Interviewers open new questions politely ("Thanks for that overview. Next, what's your experience
// with..."). The courtesy mentions the previous answer, so a plain word match ("that") used to mark every
// new question as a follow-up, which pulled the answer back to the previous topic. Here:
//   - leading acknowledgement sentences are set aside (they need no reply),
//   - an explicit transition ("Next,", "Now,", "For the final question") marks a new question,
//   - a clear reference to the previous answer ("you mentioned", "tell me more", "why did you") still
//     marks a follow-up even after a transition.

// Builds on the previous exchange: "how did you decide that?", "tell me more", "why those features?".
const FOLLOW_UP = /\b(that|those|these|them|more|further|elaborate|expand|deeper|in (more )?detail|how did you (decide|figure|choose|come up|get|arrive|know|pick|select|determine|measure|calculate|do that)|why did you|what made you|what led|tell me more|go (deeper|into)|you (just )?(mentioned|said|talked)|earlier|which ones|how exactly|walk me through how|how did (it|that|the))\b/i;
const STRONG_FOLLOW_UP = /\b(you (just )?(mentioned|said|talked about|described|brought up)|earlier you|you were (saying|talking)|tell me more|elaborate|expand on|go deeper|in more detail|why did you|how did you (decide|figure|choose|measure|calculate|do that)|what made you|what led you|walk me through how|(on|about|back to) (that|the) (project|dashboard|point|example|story))\b/i;
const ACK_START = /^(?:ok(?:ay)?|alright|all right|great|good|perfect|wonderful|awesome|excellent|nice|cool|fantastic|brilliant|lovely|got it|understood|i see|right|sure|wow|interesting|thanks|thank you|many thanks|appreciate|that(?:'s| is| was| sounds| makes| helps)|this (?:is|was)|really|very|makes sense|sounds good)\b/i;
// A transition near the start of the question: "Next, ...", "Now, ...", "For the final question, ...".
const TRANSITION = /^(?:\S+\s+){0,5}?(?:next[,:]|next (?:question|up|i'?d|let'?s|topic|we)|now[,:]|now (?:let'?s|i'?d|i want|i would|what|tell|can|could|how)|moving on|let'?s (?:move|turn|switch|start|talk|go|shift)|(?:first|second|third|fourth|fifth|final|last|next|another) (?:interview )?question|(?:another|a different|a new) (?:question|topic|area)|i'?d (?:like|love) to (?:ask|discuss|move|turn|talk|switch|start|hear)|i want to (?:ask|move|turn|talk)|switching gears|on a different note|changing topics?|shifting gears)/i;

function sentencesOf(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * The question part of an utterance: leading acknowledgement sentences removed.
 * @returns {{ core: string, courtesy: string }}
 */
function splitCourtesy(text) {
  const s = sentencesOf(text);
  let i = 0;
  while (i < s.length - 1 && ACK_START.test(s[i]) && !/\?\s*$/.test(s[i]) && s[i].split(/\s+/).length <= 25) i += 1;
  return { core: s.slice(i).join(' ') || String(text || '').trim(), courtesy: s.slice(0, i).join(' ') };
}

/** @param {string} text @param {{ hasConversation?: boolean }} [o] */
function isFollowUp(text, { hasConversation = true } = {}) {
  if (!hasConversation) return false;
  const { core } = splitCourtesy(text);
  if (STRONG_FOLLOW_UP.test(core)) return true;
  if (TRANSITION.test(core)) return false;
  return FOLLOW_UP.test(core);
}

module.exports = { splitCourtesy, isFollowUp, FOLLOW_UP, TRANSITION, STRONG_FOLLOW_UP };
