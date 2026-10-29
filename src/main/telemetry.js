// @ts-check
'use strict';
// Privacy-safe per-turn telemetry: numbers and labels only, never question or answer text.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOWED = ['ts', 'turn', 'kind', 'question_type', 'shape', 'route', 'provider', 'model', 'fallback', 'eotToFirstTokenMs', 'totalMs',
  'inputTokens', 'outputTokens', 'reasoningTokens', 'estimatedUsd', 'finalUsd', 'validated', 'unsupported', 'regenerated', 'trimmed',
  'storyId', 'sourceCount', 'promptTokensEst', 'cancelled', 'error',
  // Per-stage latency (PRD Phase 4).
  'buildMs', 'eotToDispatchMs', 'providerTtftMs', 'streamMs', 'validateMs', 'prepHit',
  // Screen route label (PRD Phase 5): 'ocr' | 'vision'. Never the screen text.
  'screen'];

// Retention: daily files older than retentionDays are deleted at startup.
function prune(dir, retentionDays, now) {
  if (!dir || !fs.existsSync(dir) || !(retentionDays > 0)) return 0;
  const cutoff = new Date(now() - retentionDays * 86400000).toISOString().slice(0, 10);
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (m && m[1] < cutoff) { fs.unlinkSync(path.join(dir, f)); n += 1; }
  }
  return n;
}

function createTelemetry({ dir, enabled = true, now = () => Date.now(), retentionDays = 30 }) {
  const file = dir ? path.join(dir, `${new Date(now()).toISOString().slice(0, 10)}.jsonl`) : null;
  if (enabled && dir) { fs.mkdirSync(dir, { recursive: true }); prune(dir, retentionDays, now); }
  const rows = [];

  function record(m) {
    const row = { ts: new Date(now()).toISOString() };
    for (const k of ALLOWED) if (m[k] !== undefined && k !== 'ts') row[k] = m[k];
    if (row.turn) row.turn = crypto.createHash('sha256').update(String(row.turn)).digest('hex').slice(0, 12);
    for (const [k, v] of Object.entries(row)) if (typeof v === 'string' && v.length > 120) row[k] = v.slice(0, 120);
    rows.push(row);
    if (enabled && file) fs.appendFile(file, `${JSON.stringify(row)}\n`, () => {});
    return row;
  }

  return { record, rows: () => rows.slice() };
}

function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[i];
}

function summarize(rows) {
  const pick = (k) => rows.map((r) => r[k]);
  const byRoute = {};
  for (const r of rows) {
    const k = r.route || 'unknown';
    byRoute[k] = byRoute[k] || { turns: 0, usd: 0 };
    byRoute[k].turns += 1;
    byRoute[k].usd += r.finalUsd || 0;
  }
  const validated = rows.filter((r) => r.validated !== undefined);
  const p = (k) => ({ p50: percentile(pick(k), 50), p95: percentile(pick(k), 95) });
  return {
    turns: rows.length,
    firstToken: p('eotToFirstTokenMs'),
    total: p('totalMs'),
    // PRD latency targets: local build/retrieval p95 < 100 ms, end-of-turn -> dispatch < 150 ms.
    stages: { build: p('buildMs'), eotToDispatch: p('eotToDispatchMs'), providerTtft: p('providerTtftMs'), stream: p('streamMs'), validate: p('validateMs') },
    prepHits: rows.filter((r) => r.prepHit === true).length,
    costPerTurnUsd: rows.length ? rows.reduce((s, r) => s + (r.finalUsd || 0), 0) / rows.length : 0,
    byRoute,
    unsupportedRate: validated.length ? validated.filter((r) => r.validated === false).length / validated.length : null,
    regenerated: rows.filter((r) => r.regenerated).length,
    fallbacks: rows.filter((r) => r.fallback).length,
  };
}

module.exports = { createTelemetry, summarize, percentile, prune, ALLOWED };
