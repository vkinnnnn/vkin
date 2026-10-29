// @ts-check
'use strict';
// Personal-brain record schema (ADR 0002). Shared contract for records, retrieval, stories and corrections.

const TYPES = ['identity', 'fact', 'experience', 'star_story', 'preference', 'voice_example', 'correction'];
const SENSITIVITY = ['public', 'internal', 'private', 'restricted'];
// Evidence class drives how a claim may be phrased (see prompt rules).
// "meeting" = this meeting's correspondence/logistics; "research" = scholarly sources in a meeting pack.
const EVIDENCE = ['employment', 'built', 'deployed', 'evaluated', 'coursework', 'certification', 'recognition', 'listed-only', 'correction', 'identity', 'meeting', 'research'];

/**
 * @typedef {Object} BrainRecord
 * @property {string} id               stable id, e.g. "PRJ-001", "STORY-PRJ-001-1", "COR-0003", "ID-name"
 * @property {string} type             one of TYPES
 * @property {string} title            short human title (no IDs)
 * @property {string} text             plain text body used for retrieval and prompting (IDs stripped, no contact data)
 * @property {string} source_path      absolute or repo-relative file path
 * @property {string} source_span      "L<start>-L<end>" (1-based, inclusive)
 * @property {string|null} effective_from  "YYYY-MM" or "YYYY"
 * @property {string|null} effective_to    "YYYY-MM", "YYYY", or null (ongoing / not dated)
 * @property {string} updated_at       ISO date of the source (e.g. CareerPro "updated:")
 * @property {number} confidence       0..1
 * @property {string} sensitivity      one of SENSITIVITY; "restricted" never leaves the machine
 * @property {string[]} entities       organisations, products, tools, places (case preserved)
 * @property {string[]} tags           lower-case: evidence class, section, competencies, keywords
 * @property {boolean} approved
 * @property {string} evidence         one of EVIDENCE
 * @property {Object} [star]           star_story only: {situation, task, action, result, competency, parent_id}
 * @property {Object} [fields]         raw labelled fields of an entry (Type, When, Where, Team, Role, Stack, ...)
 * @property {string} [supersedes]     correction only: id of the record (or fact key) it corrects
 * @property {number} [version]        correction only: monotonically increasing per supersedes target
 */

function validateRecord(r) {
  const errs = [];
  const str = (k) => { if (typeof r[k] !== 'string' || !r[k]) errs.push(`${k} must be a non-empty string`); };
  if (!r || typeof r !== 'object') return ['record must be an object'];
  ['id', 'title', 'text', 'source_path', 'source_span', 'updated_at'].forEach(str);
  if (!TYPES.includes(r.type)) errs.push(`type must be one of ${TYPES.join('|')}`);
  if (!SENSITIVITY.includes(r.sensitivity)) errs.push('invalid sensitivity');
  if (!EVIDENCE.includes(r.evidence)) errs.push('invalid evidence');
  if (!/^L\d+-L\d+$/.test(String(r.source_span))) errs.push('source_span must look like L10-L20');
  for (const k of ['effective_from', 'effective_to']) if (r[k] !== null && !/^\d{4}(-\d{2})?$/.test(String(r[k]))) errs.push(`${k} must be YYYY or YYYY-MM or null`);
  if (typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1) errs.push('confidence must be 0..1');
  if (!Array.isArray(r.entities) || !Array.isArray(r.tags)) errs.push('entities and tags must be arrays');
  if (typeof r.approved !== 'boolean') errs.push('approved must be boolean');
  if (r.type === 'star_story') {
    const s = r.star || {};
    for (const k of ['situation', 'action', 'result', 'competency', 'parent_id']) if (typeof s[k] !== 'string') errs.push(`star.${k} must be a string`);
  }
  if (r.type === 'correction' && (typeof r.supersedes !== 'string' || !Number.isInteger(r.version))) errs.push('correction needs supersedes and integer version');
  if (/\b(?:PRJ|EXP|ACA|CERT|AWD|VOL)-\d{3}\b/.test(`${r.title} ${r.text}`)) errs.push('title/text must not contain entry IDs');
  if (/[\w.+-]+@[\w-]+\.[\w.]+|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|https?:\/\//.test(r.text)) errs.push('text must not contain contact data or URLs');
  return errs;
}

// Competency vocabulary shared by story tagging (records), selection (stories) and question understanding (B3).
const COMPETENCIES = {
  technical_challenge: ['technical challenge', 'hard problem', 'difficult bug', 'complex', 'challenging project', 'technical'],
  teamwork: ['team', 'teamwork', 'collaborat', 'worked with', 'cross-functional', 'peers'],
  tradeoffs: ['trade-off', 'tradeoff', 'competing', 'prioritiz', 'balance', 'versus', 'compromise'],
  deadline: ['deadline', 'pressure', 'tight timeline', 'time crunch', 'under pressure', 'urgent'],
  failure: ['fail', 'mistake', 'went wrong', 'setback', 'learned from', 'recover'],
  learning: ['learn', 'new technology', 'quickly pick up', 'ramp up', 'unfamiliar'],
  stakeholder: ['stakeholder', 'non-technical', 'explain', 'present', 'communicat', 'client', 'manager'],
  ambiguity: ['ambigu', 'unclear', 'undefined', 'no clear', 'uncertain', 'open-ended'],
  leadership: ['lead', 'led', 'ownership', 'took charge', 'mentor', 'initiative'],
  conflict: ['conflict', 'disagree', 'pushback', 'tension', 'difficult person'],
};

module.exports = { TYPES, SENSITIVITY, EVIDENCE, COMPETENCIES, validateRecord };
