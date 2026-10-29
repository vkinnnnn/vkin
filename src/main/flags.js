// @ts-check
'use strict';
// Feature-flag registry for the Phase-1 conversation brain (FABEL PRD v2).
// Each flag gates one slice of new behaviour; with every flag off, the runtime
// takes the exact pre-Phase-1 code path (rollback == set the flag false).
// Resolution order (lowest to highest precedence): built-in default -> config.flags -> FABEL_* env var.
// Dependencies are validated at startup: a flag whose requirement is unmet is forced
// off and a warning is recorded, so a misconfiguration degrades to the old path
// instead of producing an impossible combination.

/**
 * @typedef {{ name: string, env: string, default: boolean, requires?: string[], note: string }} FlagDef
 */

/** @type {FlagDef[]} */
const FLAG_DEFS = [
  { name: 'staleTurnGuard', env: 'FABEL_STALE_TURN_GUARD', default: true, note: 'Monotonic seq drops stale answer events at the reducers. Backward-compatible; default on.' },
  { name: 'dialogueStateV2', env: 'FABEL_DIALOGUE_STATE_V2', default: false, note: 'Explicit dialogue-state contract; generated/displayed/spoken distinction.' },
  { name: 'questionInterpreterV2', env: 'FABEL_QUESTION_INTERPRETER_V2', default: false, note: 'Structured resolved-question object with reference resolution.' },
  { name: 'activeContextV2', env: 'FABEL_ACTIVE_CONTEXT_V2', default: false, requires: ['dialogueStateV2'], note: 'Active topic + active story tracking across turns.' },
  { name: 'evidenceLedger', env: 'FABEL_EVIDENCE_LEDGER', default: false, requires: ['dialogueStateV2'], note: 'Evidence ledger between retrieval and generation.' },
  { name: 'answerPlanner', env: 'FABEL_ANSWER_PLANNER', default: false, requires: ['dialogueStateV2'], note: 'Compact answer plan before prose; folded into the single generation call.' },
  { name: 'noveltyController', env: 'FABEL_NOVELTY_CONTROLLER', default: false, note: 'Lexical + propositional repetition control beyond the Jaccard check.' },
  { name: 'preparedAnswersAsEvidence', env: 'FABEL_PREPARED_ANSWERS_AS_EVIDENCE', default: false, note: 'Prepared answers classified (FACT_SOURCE/STRUCTURE_EXAMPLE/STYLE_EXAMPLE/DO_NOT_COPY/DEPRECATED); facts feed the ledger, prose never pasted.' },
  // Phase 2+
  { name: 'nativeAudio', env: 'FABEL_NATIVE_AUDIO', default: false, note: 'Native WASAPI capture + Windows Voice Capture DSP echo cancellation; renderer capture is the automatic fallback.' },
  { name: 'partialPrep', env: 'FABEL_PARTIAL_PREP', default: false, note: 'Local build (understanding, retrieval, prompt) starts on EagerEndOfTurn; the paid call still waits for EndOfTurn.' },
  { name: 'compactEnvelope', env: 'FABEL_COMPACT_ENVELOPE', default: false, note: 'Smaller prompt: transcript lines already in the conversation memory dropped, earlier answers shortened, whitespace collapsed.' },
];

const BY_NAME = Object.freeze(Object.fromEntries(FLAG_DEFS.map((f) => [f.name, f])));
const TRUE = new Set(['true', '1', 'on', 'yes']);
const FALSE = new Set(['false', '0', 'off', 'no']);

/** Parse an env string to a boolean, or undefined when unset/unrecognised. */
function parseEnvBool(v) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  return undefined;
}

/**
 * Resolve the effective flag values and any dependency warnings.
 * @param {{ flags?: Record<string, boolean> }} [config]
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ values: Record<string, boolean>, warnings: string[] }}
 */
function resolveFlags(config = {}, env = process.env) {
  const cfg = (config && config.flags) || {};
  /** @type {Record<string, boolean>} */
  const values = {};
  for (const def of FLAG_DEFS) {
    let v = def.default;
    if (typeof cfg[def.name] === 'boolean') v = cfg[def.name];
    const e = parseEnvBool(env[def.env]);
    if (e !== undefined) v = e;
    values[def.name] = v;
  }
  // Validate dependencies: force a flag off when a requirement is off, and record why.
  const warnings = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const def of FLAG_DEFS) {
      if (!values[def.name] || !def.requires) continue;
      for (const req of def.requires) {
        if (!values[req]) {
          values[def.name] = false;
          warnings.push(`${def.env} requires ${BY_NAME[req].env}; forced off.`);
          changed = true;
        }
      }
    }
  }
  return { values, warnings };
}

module.exports = { FLAG_DEFS, resolveFlags, parseEnvBool };
