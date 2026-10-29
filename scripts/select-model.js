#!/usr/bin/env node
// Benchmark-selected default model (PRD Phase 4). Reads live eval results (eval/results/live-*-key.json,
// produced by `node scripts/eval.js --live --models a,b,c ...`) and applies a fixed policy. $0: no
// provider calls. Nothing changes unless --apply is given.
//
//   node scripts/select-model.js                       # newest live run
//   node scripts/select-model.js --file eval/results/live-...-key.json
//   node scripts/select-model.js --apply               # write the winner to config.llm.routes.default
//
// Policy (deterministic):
//   1. eligible: >= 4 answered items, grounded rate >= 90%, zero must-not-say violations,
//      errors <= 10%, format issues <= 20%
//   2. no grounding regression against the current default (when it is in the same run)
//   3. among eligible models: lowest TTFT p50, then lowest cost per answer
//   The previous default becomes the deep route (still gated by llm.enableDeepRoute and its caps).
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const POLICY = Object.freeze({ minItems: 4, minGrounded: 0.9, maxViolations: 0, maxErrorRate: 0.1, maxFormatRate: 0.2, maxEmptyRate: 0 });

function pct(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
}

/** Per-model metrics from eval result rows. */
function summarize(results) {
  const by = {};
  for (const r of results) {
    const s = by[r.model] = by[r.model] || { model: r.model, n: 0, errors: 0, grounded: 0, violations: 0, format: 0, usd: 0, ttft: [], items: new Set() };
    if (r.error) { s.errors += 1; continue; }
    s.n += 1;
    s.items.add(r.id);
    // An empty answer is never grounded (older eval files counted it as grounded).
    const empty = Number.isFinite(r.words) && r.words < 5;
    s.empty = (s.empty || 0) + (empty ? 1 : 0);
    s.grounded += r.grounded && !empty ? 1 : 0;
    s.violations += (r.mustNotSay || []).length;
    s.format += r.bullets || r.tooLong || r.danglingOffer ? 1 : 0;
    s.usd += Number(r.usd) || 0;
    s.ttft.push(r.ttftMs);
  }
  return Object.values(by).map((s) => ({
    model: s.model, answered: s.n, errors: s.errors, items: [...s.items],
    groundedRate: s.n ? s.grounded / s.n : 0,
    violations: s.violations,
    emptyRate: s.n ? (s.empty || 0) / s.n : 0,
    errorRate: s.n + s.errors ? s.errors / (s.n + s.errors) : 1,
    formatRate: s.n ? s.format / s.n : 1,
    usdPerAnswer: s.n ? s.usd / s.n : null,
    ttftP50: pct(s.ttft, 0.5), ttftP95: pct(s.ttft, 0.95),
  }));
}

/** @returns {{ winner: string|null, ranked: any[], rejected: {model: string, reasons: string[]}[], baseline: any }} */
function choose(models, currentDefault, policy = POLICY) {
  const baseline = models.find((m) => m.model === currentDefault) || null;
  const rejected = [];
  const eligible = [];
  for (const m of models) {
    const reasons = [];
    if (m.answered < policy.minItems) reasons.push(`only ${m.answered} answered items`);
    if (m.groundedRate < policy.minGrounded) reasons.push(`grounded ${(m.groundedRate * 100).toFixed(0)}% < ${policy.minGrounded * 100}%`);
    if (m.violations > policy.maxViolations) reasons.push(`${m.violations} must-not-say violations`);
    if (m.emptyRate > policy.maxEmptyRate) reasons.push(`empty answers ${(m.emptyRate * 100).toFixed(0)}%`);
    if (m.errorRate > policy.maxErrorRate) reasons.push(`error rate ${(m.errorRate * 100).toFixed(0)}%`);
    if (m.formatRate > policy.maxFormatRate) reasons.push(`format issues ${(m.formatRate * 100).toFixed(0)}%`);
    if (baseline && m !== baseline && m.groundedRate < baseline.groundedRate) reasons.push('grounding below the current default');
    if (!Number.isFinite(m.ttftP50)) reasons.push('no first-token timings');
    if (reasons.length) rejected.push({ model: m.model, reasons });
    else eligible.push(m);
  }
  const ranked = eligible.sort((a, b) => a.ttftP50 - b.ttftP50 || (a.usdPerAnswer ?? Infinity) - (b.usdPerAnswer ?? Infinity));
  return { winner: ranked.length ? ranked[0].model : null, ranked, rejected, baseline };
}

function newestKeyFile(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^live-.*-key\.json$/.test(f)).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

function main(argv) {
  const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
  const file = flag('--file') ? path.resolve(flag('--file')) : newestKeyFile(path.join(ROOT, 'eval', 'results'));
  if (!file || !fs.existsSync(file)) {
    console.log('No live eval results found. Run first (costs money, prints the worst case and asks "yes"):');
    console.log('  node scripts/eval.js --live --models <a>,<b>,<c> --spread --sample 8 --max-usd 1');
    return 1;
  }
  const configPath = path.join(ROOT, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const current = config.llm.routes.default;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const models = summarize(data.results || []);
  const { winner, ranked, rejected } = choose(models, current);
  console.log(`Results: ${path.relative(ROOT, file)}${data.flags && data.flags.length ? ` (flags: ${data.flags.join(',')})` : ''}`);
  console.log(`Current default: ${current}`);
  for (const m of models) {
    console.log(`  ${m.model}: answered ${m.answered}, grounded ${(m.groundedRate * 100).toFixed(0)}%, violations ${m.violations}, TTFT p50 ${m.ttftP50} ms p95 ${m.ttftP95} ms, $${(m.usdPerAnswer || 0).toFixed(4)}/answer`);
  }
  for (const r of rejected) console.log(`  rejected ${r.model}: ${r.reasons.join('; ')}`);
  if (models.length < 2) console.log('Only one model in this run: nothing to compare. Benchmark at least two models in the same run.');
  if (!winner) { console.log('No model meets the policy; the default stays.'); return 0; }
  console.log(`Recommended default: ${winner}${winner === current ? ' (unchanged)' : ''}; ranked: ${ranked.map((m) => m.model).join(' > ')}`);
  if (!argv.includes('--apply') || winner === current) return 0;
  const disk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  disk.llm.routes.deep = current;
  disk.llm.routes.default = winner;
  disk.llm.model = winner;
  fs.writeFileSync(configPath, `${JSON.stringify(disk, null, 2)}\n`, 'utf8');
  console.log(`Applied: default -> ${winner}; deep -> ${current} (deep route stays ${disk.llm.enableDeepRoute ? 'enabled' : 'disabled'}; see llm.enableDeepRoute). Restart the copilot.`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { summarize, choose, POLICY };
