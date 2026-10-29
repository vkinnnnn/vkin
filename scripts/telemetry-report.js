// Summarize privacy-safe telemetry: node scripts/telemetry-report.js [YYYY-MM-DD]
const fs = require('fs');
const path = require('path');
const { summarize } = require('../src/main/telemetry');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const dir = path.join(ROOT, (config.telemetry && config.telemetry.dir) || 'data/telemetry');
const day = process.argv[2];
if (!fs.existsSync(dir)) { console.log('No telemetry yet.'); process.exit(0); }
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && (!day || f.startsWith(day)));
const rows = files.flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
const s = summarize(rows);
console.log(`turns ${s.turns} | first token p50 ${s.firstToken.p50} ms p95 ${s.firstToken.p95} ms | total p50 ${s.total.p50} ms p95 ${s.total.p95} ms`);
console.log(`cost/turn $${s.costPerTurnUsd.toFixed(5)} | unsupported-claim rate ${s.unsupportedRate == null ? 'n/a' : (s.unsupportedRate * 100).toFixed(1) + '%'} | regenerated ${s.regenerated} | fallbacks ${s.fallbacks}`);
for (const [route, r] of Object.entries(s.byRoute)) console.log(`  ${route}: ${r.turns} turns, $${r.usd.toFixed(5)}`);
