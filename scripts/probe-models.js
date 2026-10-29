// Live probe of Nebius models with real meeting prompts (spends from the benchmark bucket):
//   node scripts/probe-models.js --max-usd 0.10 [--models a,b] [--yes]
// Prints the worst-case cost first and asks for "yes" unless --yes is given after the user approved in chat.
// Reports, per model: visible answer or empty, time to first token, total time, words, cost, grounding.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), override: false });
const { createEngine } = require('../src/main/engine');
const { createGateway } = require('../src/main/llm-gateway');
const { CAPABILITIES } = require('../src/main/providers/registry');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const maxUsd = Number(flag('--max-usd', '0.10'));
if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 1) { console.error('--max-usd must be in (0, 1]'); process.exit(1); }
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
// --params '{"<model>": {"extraBody": {...}, "systemPrefix": "..."}}' tries request settings without editing config.
// "@file.json" reads the settings from a file (shells mangle quotes in JSON arguments).
const paramsArg = flag('--params');
if (paramsArg) config.llm.modelParams = { ...(config.llm.modelParams || {}), ...JSON.parse(paramsArg.startsWith('@') ? fs.readFileSync(paramsArg.slice(1), 'utf8') : paramsArg) };
const qFlag = flag('--questions');
const env = { ...process.env, NEBIUS_LIVE_CALLS_ENABLED: 'true', GEMINI_LIVE_CALLS_ENABLED: 'false' };
const gateway = createGateway({ config, root: ROOT, env, sessionId: `probe-${Date.now()}` });
const engine = createEngine({ config, root: ROOT, registry: gateway.registry, env });
const models = flag('--models', Object.keys(CAPABILITIES).filter((m) => CAPABILITIES[m].provider === 'nebius').join(',')).split(',');
const allQuestions = ['Tell me about a time you had to learn a difficult subject quickly.', 'How would you measure the overlap between different social capital indices?'];
const questions = qFlag ? allQuestions.slice(0, Number(qFlag)) : allQuestions;

(async () => {
  let worst = 0;
  const plans = [];
  for (const m of models) for (const q of questions) {
    const b = engine.build({ question: q, history: [] });
    const est = gateway.providers.estimate_cost({ messages: b.messages, maxOutputTokens: b.meta.maxOutputTokens, model: m });
    if (!est) { console.error(`No approved price for ${m}`); process.exit(1); }
    worst += est.estimatedUsd;
    plans.push({ m, q, b });
  }
  console.log(`Probe: ${models.length} models x ${questions.length} questions. Worst-case cost $${worst.toFixed(4)} (cap $${maxUsd.toFixed(2)}, benchmark bucket).`);
  if (worst > maxUsd) { console.error('Projected worst case exceeds --max-usd; refusing.'); process.exit(1); }
  if (!args.includes('--yes')) {
    const a = await new Promise((r) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question('type yes to spend: ', (x) => { rl.close(); r(x); }); });
    if (a.trim().toLowerCase() !== 'yes') { console.log('Cancelled; nothing spent.'); process.exit(0); }
  }
  for (const { m, q, b } of plans) {
    gateway.registry.setOverride('default', m);
    const t0 = Date.now();
    let text = '';
    try {
      const res = await gateway.llm.stream({ messages: b.messages, signal: new AbortController().signal, onDelta: (d) => { text += d; }, bucket: 'benchmark', maxOutputTokens: b.meta.maxOutputTokens, route: 'default' });
      const v = engine.validate(text, b.meta);
      const words = text.replace(/^\s*SAY:\s*/i, '').split(/\s+/).filter(Boolean).length;
      console.log(`${m.padEnd(36)} ${q.slice(0, 28).padEnd(28)} | ${text.trim() ? 'visible' : 'EMPTY  '} | TTFT ${String(res.ttftMs).padStart(5)} ms | total ${String(Date.now() - t0).padStart(5)} ms | ${String(words).padStart(3)} words | $${(res.finalUsd || 0).toFixed(4)} | ${v.ok ? 'grounded' : `unsupported: ${v.unsupported_claims.map((c) => c.claim).join(', ')}`}${res.model !== m ? ` | served by ${res.model}` : ''}`);
      fs.appendFileSync(path.join(ROOT, 'eval', 'results', 'probe-answers.md'), `\n## ${m} | ${q}\n\n${text}\n`);
    } catch (e) {
      console.log(`${m.padEnd(36)} ${q.slice(0, 28).padEnd(28)} | ERROR ${e.code || ''} ${e.message}`);
    }
  }
  console.log(`Ledger committed: $${gateway.budget().nebius.committedUsd.toFixed(4)}`);
})();
