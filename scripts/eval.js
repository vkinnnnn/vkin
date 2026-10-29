// FABEL evaluation harness.
//   node scripts/eval.js                 mocked: deterministic checks only, $0, no network
//   node scripts/eval.js --live [--models a,b] [--sample 8] [--max-usd 3]
//        live: prints the worst-case projected cost, asks for "yes", spends from the "benchmark" bucket,
//        stops when --max-usd is reached, and writes a blind A/B file for human review.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), override: false });
const { createEngine } = require('../src/main/engine');
const { createGateway } = require('../src/main/llm-gateway');
const { createRegistry } = require('../src/main/providers/registry');
const { assessUtterance } = require('../src/main/turns');

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i === -1 ? def : args[i + 1]; };
const LIVE = args.includes('--live');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
// --flags brain | a,b,c : run the engine with FABEL feature flags ("brain" = every Phase-1 flag), so the
// conversation brain and the compact envelope can be benchmarked live, not only mocked.
const BRAIN_FLAGS = ['dialogueStateV2', 'questionInterpreterV2', 'activeContextV2', 'evidenceLedger', 'answerPlanner', 'noveltyController', 'preparedAnswersAsEvidence'];
const evalFlags = Object.fromEntries(String(flag('--flags', '')).split(',').filter(Boolean).flatMap((f) => (f === 'brain' ? BRAIN_FLAGS : [f])).map((f) => [f, true]));
const golden = JSON.parse(fs.readFileSync(path.join(ROOT, flag('--set', 'eval/golden/seed.json')), 'utf8'));
// A set names the meeting pack it tests; every other set runs without one.
config.meeting = golden.meetingProfile ? { ...(config.meeting || {}), enabled: true, profile: golden.meetingProfile } : { enabled: false };
const MAX_PROMPT = golden.maxPromptTokens || 6500;
const outDir = path.join(ROOT, 'eval', 'results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

// The phrase may appear only inside one of the data blocks, never in instructions.
function dataOnly(userMsg, phrase) {
  const i = userMsg.indexOf(phrase);
  if (i === -1) return true;
  return ['meeting_notes', 'untrusted_transcript', 'meeting_sources', 'latest_utterance'].some((tag) => {
    const open = userMsg.lastIndexOf(`<${tag}>`, i);
    const close = userMsg.indexOf(`</${tag}>`, i);
    return open !== -1 && close !== -1 && userMsg.lastIndexOf(`</${tag}>`, i) < open;
  });
}

function mockEval() {
  const registry = createRegistry(config, process.env);
  const engine = createEngine({ config, root: ROOT, registry, flags: evalFlags });
  const rows = [];
  for (const item of golden.items) {
    const e = item.expect || {};
    const checks = [];
    const n = item.repeat || 1;
    const stories = [];
    let meta;
    let user = '';
    for (let k = 0; k < n; k++) {
      const built = engine.build({ question: item.question, history: item.history || [], meetingNotes: item.meetingNotes || '' });
      meta = built.meta;
      user = built.messages[1].content;
      stories.push(meta.storyId);
      engine.commit(meta); // as if the answer was shown

    }
    const u = meta.understanding;
    const add = (name, pass, detail = '') => checks.push({ name, pass, detail });
    if (e.question_type) add('intent', u.question_type === e.question_type, u.question_type);
    if (e.shape) add('structure', u.expected_answer_shape === e.shape, u.expected_answer_shape);
    if (e.competency) add('competency', u.competencies_being_tested.includes(e.competency), u.competencies_being_tested.join(','));
    if (e.story_required) add('story_found', Boolean(meta.storyId), meta.storyId || 'none');
    if (e.no_story) add('no_story', !meta.storyId, meta.storyId || 'none');
    if (e.sources_any) add('retrieval', e.sources_any.some((s) => meta.sourceIds.includes(s)), meta.sourceIds.slice(0, 6).join(','));
    if (e.stakes) add('stakes', u.stakes === e.stakes, u.stakes);
    if (e.kind) add('kind', u.kind === e.kind, u.kind);
    if (e.no_auto_answer) {
      const a = assessUtterance(item.question);
      add('no_auto_answer', !(a.eligible && a.questionLike), `eligible=${a.eligible} questionLike=${a.questionLike}`);
    }
    if (e.needs_clarification !== undefined) add('clarification', u.needs_clarification === e.needs_clarification, String(u.needs_clarification));
    if (e.data_only) for (const p of e.data_only) add('injection_contained', dataOnly(user, p));
    if (e.distinct_stories_min) add('story_variety', new Set(stories.filter(Boolean)).size >= e.distinct_stories_min, stories.join(','));
    if (e.meeting_sources_any) add('meeting_retrieval', e.meeting_sources_any.some((s) => (meta.selection.meetingIds || []).includes(s) || meta.storyId === s), (meta.selection.meetingIds || []).join(','));
    if (e.story_any) add('story_choice', e.story_any.includes(meta.storyId), meta.storyId || 'none');
    add(`prompt_tokens<=${MAX_PROMPT}`, meta.promptTokensEst <= MAX_PROMPT, String(meta.promptTokensEst));
    rows.push({ id: item.id, category: item.category, checks, promptTokensEst: meta.promptTokensEst, route: meta.route, storyId: meta.storyId });
  }
  // Validator accuracy on labelled candidate answers; plus an optional prepared-answer-copying check.
  const tokset = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9%\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  const overlap = (a, b) => { const A = tokset(a); const B = tokset(b); if (!A.size || !B.size) return 0; let i = 0; for (const w of A) if (B.has(w)) i += 1; return i / A.size; };
  const cand = golden.candidates.map((c) => {
    const built = engine.build({ question: c.question, history: [], meetingNotes: golden.meetingNotes || '' });
    const v = engine.validate(c.answer, built.meta);
    // must_not_copy: the answer may not reproduce this prepared text near-verbatim (>=0.8 token overlap).
    const copied = c.must_not_copy ? overlap(c.answer, c.must_not_copy) >= 0.8 : false;
    const pass = (v.ok === c.expect_valid) && !copied;
    return { id: c.id, expect_valid: c.expect_valid, got_valid: v.ok, copied, pass, unsupported: v.unsupported_claims.map((x) => x.claim) };
  });
  return { rows, cand };
}

function printMock({ rows, cand }) {
  let pass = 0;
  let total = 0;
  const byName = {};
  for (const r of rows) {
    for (const c of r.checks) {
      total += 1;
      if (c.pass) pass += 1;
      byName[c.name] = byName[c.name] || { pass: 0, total: 0 };
      byName[c.name].total += 1;
      if (c.pass) byName[c.name].pass += 1;
      if (!c.pass) console.log(`FAIL ${r.id} [${r.category}] ${c.name}: ${c.detail}`);
    }
  }
  console.log('\nCheck                 pass/total');
  for (const [k, v] of Object.entries(byName)) console.log(`${k.padEnd(22)}${v.pass}/${v.total}`);
  const cp = cand.filter((c) => c.pass).length;
  for (const c of cand.filter((x) => !x.pass)) console.log(`VALIDATOR MISS ${c.id}: expected ${c.expect_valid}, got ${c.got_valid}${c.copied ? ' COPIED' : ''} ${c.unsupported.join('|')}`);
  console.log(`validator             ${cp}/${cand.length}`);
  const toks = rows.map((r) => r.promptTokensEst).sort((a, b) => a - b);
  console.log(`\nTOTAL ${pass}/${total} deterministic checks | validator ${cp}/${cand.length} | prompt tokens p50 ${toks[Math.floor(toks.length / 2)]} max ${toks.at(-1)}`);
  fs.writeFileSync(path.join(outDir, `mock-${stamp}.json`), JSON.stringify({ rows, cand }, null, 2));
  return pass === total && cp === cand.length;
}

// Discourse markers at the start of a clause ("Yeah—", "So,", "Honestly"), plus "um/uh/you know" anywhere.
// Conjunction uses ("so I could", "like Neo4j") are not fillers.
const FILLERS = /(?:^|[.!?—:]\s*|,\s+)(yeah|so|sure|honestly|basically|actually|well|okay|alright)\b(?=[,—\s])|\b(um|uh|you know)\b/gi;
const ask = (q) => new Promise((r) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); r(a); }); });

async function liveEval() {
  const maxUsd = Number(flag('--max-usd', '3'));
  const sampleN = Number(flag('--sample', '8'));
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 3) { console.error('--max-usd must be in (0, 3] (benchmark bucket)'); process.exit(1); }
  const env = { ...process.env, NEBIUS_LIVE_CALLS_ENABLED: 'true', GEMINI_LIVE_CALLS_ENABLED: 'false' };
  const gateway = createGateway({ config, root: ROOT, env, sessionId: `eval-${stamp}` });
  const models = (flag('--models', gateway.registry.modelFor('default'))).split(',');
  // Stratified sample: one item per category, in file order, up to N.
  const seen = new Set();
  // Statements the app would not answer are not sent to the model.
  const answerable = (i) => !i.repeat && !(i.expect && i.expect.no_auto_answer);
  // --spread: round-robin across categories up to --sample N (a stratified sample larger than one per category).
  const roundRobin = () => {
    const byCat = new Map();
    for (const i of golden.items.filter(answerable)) { if (!byCat.has(i.category)) byCat.set(i.category, []); byCat.get(i.category).push(i); }
    const out = [];
    for (let k = 0; out.length < sampleN && [...byCat.values()].some((l) => l.length > k); k++) for (const l of byCat.values()) if (l[k] && out.length < sampleN) out.push(l[k]);
    return out;
  };
  const sample = args.includes('--all') ? golden.items.filter(answerable)
    : args.includes('--spread') ? roundRobin()
      : golden.items.filter((i) => answerable(i) && !seen.has(i.category) && seen.add(i.category)).slice(0, sampleN);
  for (const it of sample) if (!it.meetingNotes && golden.meetingNotes) it.meetingNotes = golden.meetingNotes;
  const engine = createEngine({ config, root: ROOT, registry: gateway.registry, env, flags: evalFlags });
  let worst = 0;
  for (const m of models) {
    gateway.registry.setOverride('default', m);
    for (const it of sample) {
      const b = engine.build({ question: it.question, history: it.history || [], meetingNotes: it.meetingNotes || '' });
      const est = gateway.providers.estimate_cost({ messages: b.messages, maxOutputTokens: b.meta.maxOutputTokens });
      if (!est) { console.error(`No approved price for ${m}; refusing (BUDGET_PRICE_UNKNOWN).`); process.exit(1); }
      worst += est.estimatedUsd * 2; // worst case includes one regeneration per answer
    }
  }
  console.log(`Live eval: ${sample.length} items x ${models.length} model(s) [${models.join(', ')}]${Object.keys(evalFlags).length ? ` flags: ${Object.keys(evalFlags).join(',')}` : ''}`);
  console.log(`Worst-case projected cost: $${worst.toFixed(4)} (includes a regeneration per answer). Stop at $${maxUsd.toFixed(2)} (benchmark bucket).`);
  if (worst > maxUsd) { console.error('Projected worst case exceeds --max-usd; refusing.'); process.exit(1); }
  if ((await ask('Proceed and spend from the Nebius benchmark bucket? type yes: ')).trim().toLowerCase() !== 'yes') { console.log('Cancelled; nothing spent.'); process.exit(0); }

  const results = [];
  for (const m of models) {
    gateway.registry.setOverride('default', m);
    for (const it of sample) {
      const spent = gateway.budget().nebius.byBucket.benchmark;
      if ((spent ? spent.usd ?? spent : 0) >= maxUsd) { console.log('Benchmark budget reached; stopping.'); break; }
      const b = engine.build({ question: it.question, history: it.history || [], meetingNotes: it.meetingNotes || '' });
      const t0 = Date.now();
      let text = '';
      let res;
      try {
        res = await gateway.llm.stream({ messages: b.messages, signal: new AbortController().signal, onDelta: (d) => { text += d; }, bucket: 'benchmark', maxOutputTokens: b.meta.maxOutputTokens, route: b.meta.route });
      } catch (e) { results.push({ model: m, id: it.id, error: e.code || e.message }); continue; }
      const v = engine.validate(text, b.meta);
      // An empty or contentless answer is a failure, never "grounded".
      if (!/SAY:\s*\S/.test(text) && text.trim().length < 20) v.ok = false;
      const e = it.expect || {};
      const say = (text.match(/SAY:\s*([\s\S]*?)(\n\s*POINTS:|$)/i) || [null, text])[1];
      results.push({
        model: m, id: it.id, category: it.category, text,
        ttftMs: res.ttftMs, totalMs: Date.now() - t0, usd: res.finalUsd,
        grounded: v.ok, unsupported: v.unsupported_claims.map((x) => x.claim),
        words: say.split(/\s+/).filter(Boolean).length, fillers: (say.match(FILLERS) || []).length,
        mustNotSay: (e.must_not_say || []).filter((r) => new RegExp(r, 'i').test(text)),
        mustMention: e.must_mention_any ? e.must_mention_any.some((r) => new RegExp(r, 'i').test(text)) : null,
        bullets: /\n\s*(POINTS:|[-*•]\s)/i.test(text),
        tooLong: e.max_words ? say.split(/\s+/).filter(Boolean).length > e.max_words : false,
        danglingOffer: /let me know if|happy to (elaborate|go deeper|share more)|if you('d| would) like (more|me to)/i.test(say),
      });
      process.stdout.write('.');
    }
  }
  console.log('');
  const by = {};
  for (const r of results.filter((x) => !x.error)) {
    const s = by[r.model] = by[r.model] || { n: 0, grounded: 0, ttft: [], usd: 0, violations: 0, fillers: 0 };
    s.n += 1; s.grounded += r.grounded ? 1 : 0; s.ttft.push(r.ttftMs); s.usd += r.usd || 0; s.violations += r.mustNotSay.length; s.fillers += r.fillers;
    s.format = (s.format || 0) + (r.bullets || r.tooLong || r.danglingOffer ? 1 : 0);
    s.missedMention = (s.missedMention || 0) + (r.mustMention === false ? 1 : 0);
  }
  for (const [m, s] of Object.entries(by)) {
    const t = s.ttft.filter(Number.isFinite).sort((a, b) => a - b);
    console.log(`${m}: grounded ${s.grounded}/${s.n} | must-not-say violations ${s.violations} | TTFT p50 ${t[Math.floor(t.length / 2)]} ms p95 ${t[Math.min(t.length - 1, Math.ceil(t.length * 0.95) - 1)]} ms | $${s.usd.toFixed(4)} | fillers/answer ${(s.fillers / s.n).toFixed(1)} | format issues ${s.format || 0} | missed must-mention ${s.missedMention || 0}`);
  }
  // Blind file: answers per item with shuffled labels; key stored separately.
  const key = {};
  let md = '# Blind review\nRate each answer 1-5 on intent, structure, grounding, naturalness, brevity.\n';
  for (const it of sample) {
    const answers = results.filter((r) => r.id === it.id && !r.error).sort(() => crypto.randomInt(3) - 1);
    md += `\n## ${it.id}: ${it.question}\n`;
    answers.forEach((a, i) => { const label = String.fromCharCode(65 + i); key[`${it.id}:${label}`] = a.model; md += `\n**${label}.** ${a.text.replace(/\n/g, ' ')}\n`; });
  }
  fs.writeFileSync(path.join(outDir, `live-${stamp}-blind.md`), md);
  fs.writeFileSync(path.join(outDir, `live-${stamp}-key.json`), JSON.stringify({ key, flags: Object.keys(evalFlags), set: flag('--set', 'eval/golden/seed.json'), results: results.map(({ text: _text, ...r }) => r) }, null, 2));
  console.log(`Wrote eval/results/live-${stamp}-blind.md (answers) and -key.json (labels, metrics). Ledger: committed $${gateway.budget().nebius.committedUsd.toFixed(4)}`);
}

if (LIVE) liveEval();
else process.exit(printMock(mockEval()) ? 0 : 1);
