// Imports a Markdown Q&A bank ("#### ID. Question" headings, answer paragraphs below) into a meeting pack as
// answer examples, keeping only answers whose every claim the validator finds in the pack or profile and that
// trip no forbidden pattern ($0, no network).
//   node scripts/import-qa.js <bank.md> [--profile <pack id>] [--out <file name in the pack folder>] [--exclude <regex>]
// Writes <out> ({ records: [], exemplars: [...] }) and <out>.report.md listing what was dropped and why.
// Add <out> to the pack's "include" list to use it.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { createEngine } = require('../src/main/engine');
const { createRegistry } = require('../src/main/providers/registry');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const src = args[0];
if (!src || !fs.existsSync(src)) { console.error('usage: node scripts/import-qa.js <bank.md> [--profile id] [--out qa-bank.json]'); process.exit(1); }
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const profile = flag('--profile', config.meeting && config.meeting.profile);
const outName = flag('--out', 'qa-bank.json');
if (!/^[\w.-]+\.json$/.test(outName)) { console.error('--out must be a plain .json file name'); process.exit(1); }
const packDir = path.join(ROOT, (config.meeting && config.meeting.dir) || 'meeting-packs', profile);

/** "**Situation:** text" lines and "> Tip" notes become plain spoken text. */
function spoken(md) {
  return md.split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l) && !/^\s*---+\s*$/.test(l) && !/^\s*\|/.test(l))
    .map((l) => l.replace(/^\s*\*\*(Situation|Task|Action|Result)s?:\*\*\s*/i, '').replace(/^\s*[-*]\s+/, '').replace(/\*\*/g, '').replace(/`/g, '').trim())
    .filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
}

function parse(text) {
  const out = [];
  let section = '';
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const h3 = /^###\s+(.*)$/.exec(line);
    const h4 = /^####\s+([A-Z]-\d{3})\.\s+(.*)$/.exec(line);
    if (h4) { if (cur) out.push(cur); cur = { id: h4[1], question: h4[2].trim(), section, body: [] }; continue; }
    if (/^#{1,3}\s/.test(line)) { if (cur) out.push(cur); cur = null; if (h3) section = h3[1].trim(); continue; }
    if (cur) cur.body.push(line);
  }
  if (cur) out.push(cur);
  return out.map((x) => ({ ...x, answer: spoken(x.body.join('\n')) })).filter((x) => x.answer);
}

// Validate against the pack and profile only: the bank itself is not loaded while it is being vetted.
config.meeting = { ...(config.meeting || {}), enabled: true, profile };
const pack = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8').replace(/^\uFEFF/, ''));
const include = (pack.include || []).filter((f) => f !== outName);
const readFile = (p) => (path.resolve(p) === path.resolve(path.join(packDir, 'pack.json'))
  ? JSON.stringify({ ...pack, include }) : fs.readFileSync(p, 'utf8'));
const engine = createEngine({ config, root: ROOT, registry: createRegistry(config, {}), env: {}, readFile });
if (!engine.meeting) { console.error(`pack ${profile} did not load`); process.exit(1); }

const items = parse(fs.readFileSync(src, 'utf8'));
const kept = [];
const dropped = [];
// --exclude <regex>: answers that are stale or not speakable to the person (e.g. third-person coaching notes).
const exclude = args.includes('--exclude') ? new RegExp(flag('--exclude'), 'i') : null;
for (const x of items) {
  if (exclude && exclude.test(x.answer)) { dropped.push({ ...x, reasons: [`excluded: ${(x.answer.match(exclude) || [''])[0]}`] }); continue; }
  const b = engine.build({ question: x.question, history: [] });
  // Vetted against the whole verified fact base (at answer time the example itself is sent as support).
  const meta = { ...b.meta, validation: { ...b.meta.validation, evidence: engine.allEvidence() } };
  const v = engine.validate(`SAY: ${x.answer}`, meta);
  const words = x.answer.split(/\s+/).length;
  if (v.ok) kept.push({ id: `QA-${x.id}`, kind: b.meta.understanding.kind, question: x.question, answer: x.answer, section: x.section, priority: 0 });
  else dropped.push({ ...x, words, reasons: v.unsupported_claims.map((c) => `${c.kind}: ${c.claim}`) });
}
fs.writeFileSync(path.join(packDir, outName), JSON.stringify({ source: path.basename(src), imported: new Date().toISOString(), records: [], exemplars: kept }, null, 2));
const report = [`# Q&A import report: ${path.basename(src)}`, '', `Parsed ${items.length}; kept ${kept.length} grounded answers; dropped ${dropped.length}.`, '',
  '| ID | Question | Why dropped |', '|---|---|---|',
  ...dropped.map((x) => `| ${x.id} | ${x.question.replace(/\|/g, '/')} | ${x.reasons.join('; ').replace(/\|/g, '/')} |`)].join('\n');
fs.writeFileSync(path.join(packDir, `${outName}.report.md`), report);
const bySection = {};
for (const x of kept) bySection[x.id[3]] = (bySection[x.id[3]] || 0) + 1;
console.log(`Parsed ${items.length} Q&As; kept ${kept.length} (by section ${JSON.stringify(bySection)}); dropped ${dropped.length}. Report: ${outName}.report.md`);
