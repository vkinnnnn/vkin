// Deterministic checks for a meeting pack ($0, no network):
//   node scripts/check-pack.js [profile]
// Loads the pack through the engine, then checks every answer example the way a live answer is checked:
// grounded in the pack and profile without counting itself, no forbidden claims, spoken format.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { createEngine } = require('../src/main/engine');
const { createRegistry } = require('../src/main/providers/registry');

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const profile = process.argv[2] || (config.meeting && config.meeting.profile);
config.meeting = { ...(config.meeting || {}), enabled: true, profile };
const logs = [];
const engine = createEngine({ config, root: ROOT, registry: createRegistry(config, {}), env: {}, log: (m) => logs.push(m) });
if (!engine.meeting) { console.error(`Pack ${profile} did not load: ${logs.join('; ') || 'meeting mode off'}`); process.exit(1); }
const pack = JSON.parse(fs.readFileSync(path.join(ROOT, config.meeting.dir || 'meeting-packs', profile, 'pack.json'), 'utf8').replace(/^\uFEFF/, ''));
const exemplars = [pack, ...(pack.include || []).map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, config.meeting.dir || 'meeting-packs', profile, f), 'utf8').replace(/^\uFEFF/, '')))]
  .flatMap((d) => (Array.isArray(d) ? [] : d.exemplars || []));

const FILLERS = /(?:^|[.!?—:]\s*|,\s+)(yeah|so|sure|honestly|basically|actually|well|okay|alright)\b(?=[,—\s])|\b(um|uh|you know)\b/gi;
let fails = 0;
let warns = 0;
console.log(`Pack ${engine.meeting.id}: ${engine.stats.meetingRecords} records, ${exemplars.length} answer examples, system prompt ${engine.stats.systemPromptTokens} tokens`);
for (const x of exemplars) {
  const b = engine.build({ question: x.question, history: [] });
  // An example may not support itself. Every example is vetted against the whole verified fact base (at answer
  // time it is itself sent as support). Hand-written examples must also be speakable; for imported banks
  // (priority 0) style is only a warning.
  const imported = x.priority === 0;
  const evidence = engine.allEvidence();
  const meta = { ...b.meta, validation: { ...b.meta.validation, evidence } };
  const answer = `SAY: ${String(x.answer).replace(/^\s*SAY:\s*/i, '')}`;
  const v = engine.validate(answer, meta);
  const say = answer.slice(5);
  const sentences = say.split(/(?<=[.!?])\s+/);
  const long = sentences.filter((s) => s.split(/\s+/).length > 30);
  const fillers = (say.match(FILLERS) || []).length;
  const style = [
    ...(fillers > 2 ? [`${fillers} fillers`] : []),
    ...(long.length ? [`${long.length} sentence(s) over 30 words`] : []),
    ...(/\n\s*[-*•]|POINTS:/i.test(answer) ? ['bullets'] : []),
  ];
  const problems = [
    ...v.unsupported_claims.map((c) => `unsupported ${c.kind} "${c.claim}"`),
    ...(imported ? [] : style),
    ...(!imported && x.kind && x.kind !== b.meta.understanding.kind ? [`kind ${b.meta.understanding.kind}, example says ${x.kind}`] : []),
  ];
  if (problems.length) fails += 1;
  if (imported && style.length && !problems.length) warns += 1;
  if (problems.length || !imported) console.log(`${problems.length ? 'FAIL' : 'ok  '} ${x.id.padEnd(18)} ${String(say.split(/\s+/).length).padStart(3)} words, prompt ${b.meta.promptTokensEst} tok${problems.length ? ` | ${problems.join('; ')}` : ''}`);
}
const nImported = exemplars.filter((x) => x.priority === 0).length;
if (nImported) console.log(`${nImported} imported examples checked against the whole fact base; ${warns} have style warnings (long sentences or fillers).`);
console.log(fails ? `\n${fails} example(s) need fixing.` : '\nAll answer examples are grounded; hand-written ones are also speakable.');
process.exit(fails ? 1 : 0);
