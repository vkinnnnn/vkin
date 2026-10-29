const test = require('node:test');
const assert = require('node:assert');
const { validateRecord } = require('../src/main/brain/schema');
const { estimateTokens } = require('../src/main/budget');
const { createRetriever, recencyOf, DEFAULT_WEIGHTS } = require('../src/main/brain/retrieve');
const { createStorySelector, inferCompetencies } = require('../src/main/brain/stories');
const { createSession } = require('../src/main/brain/session');

const NOW = Date.parse('2026-10-14T12:00:00Z');
const now = () => NOW;
const ids = (res) => res.items.map((i) => i.record.id);

// ---------- synthetic records (all pass validateRecord) ----------

function rec(o) {
  const r = {
    id: 'FACT-000', type: 'fact', title: 'Untitled', text: 'Placeholder body.', source_path: 'brain/synthetic.md', source_span: 'L1-L5',
    effective_from: null, effective_to: null, updated_at: '2026-01-01', confidence: 0.8, sensitivity: 'internal',
    entities: [], tags: [], approved: true, evidence: 'built', ...o,
  };
  const errs = validateRecord(r);
  assert.deepStrictEqual(errs, [], `synthetic record ${r.id} must be valid: ${errs.join('; ')}`);
  return r;
}

function story(o) {
  const star = { situation: 'S.', task: '', action: 'A.', result: 'R.', competency: 'teamwork', parent_id: 'PRJ-900', ...(o.star || {}) };
  return rec({
    type: 'star_story', title: 'Story', evidence: 'built', effective_from: '2025-01', effective_to: null,
    text: `${star.situation} ${star.action} ${star.result}`, ...o, star, tags: o.tags || ['star', star.competency],
  });
}

function corpus() {
  return [
    rec({ id: 'EXP-001', type: 'experience', title: 'Backend Engineer at Orbitly', evidence: 'employment', effective_from: '2023-06', effective_to: null,
      text: 'Backend engineer at Orbitly building event ingestion on Kafka and Postgres for logistics customers.',
      entities: ['Orbitly', 'Kafka', 'Postgres'], tags: ['employment', 'backend'], confidence: 0.95 }),
    rec({ id: 'EXP-002', type: 'experience', title: 'Data Engineering Intern at Brightwell', evidence: 'employment', effective_from: '2021-06', effective_to: '2021-09',
      text: 'Maintained Airflow pipelines that loaded sales data into Snowflake for the analytics team.',
      entities: ['Brightwell', 'Airflow', 'Snowflake'], tags: ['employment', 'data'], confidence: 0.9 }),
    rec({ id: 'PRJ-001', type: 'experience', title: 'Capstone Campus Routing Optimizer', evidence: 'built', effective_from: '2025-09', effective_to: '2026-04',
      text: 'Capstone project that plans campus shuttle routes with a constraint solver and a small web interface.',
      entities: ['Riverside University', 'OR-Tools', 'Python', 'Routing'], tags: ['built', 'capstone', 'project'] }),
    rec({ id: 'PRJ-002', type: 'experience', title: 'ESLint Plugin for Async Rules', evidence: 'built', effective_from: '2024-01', effective_to: '2024-03',
      text: 'Open source lint plugin that flags unawaited promises in TypeScript services.', entities: ['ESLint', 'TypeScript'], tags: ['built', 'open-source'] }),
    rec({ id: 'PRJ-003', type: 'experience', title: 'Photo Gallery Android App', evidence: 'built', effective_from: '2020-01', effective_to: '2020-05',
      text: 'Native Android photo gallery with offline caching and cloud sync.', entities: ['Kotlin', 'Firebase'], tags: ['built', 'mobile'] }),
    rec({ id: 'PRJ-004', type: 'experience', title: 'Latency Dashboard', evidence: 'deployed', effective_from: '2022-02', effective_to: '2022-08',
      text: 'Dashboard showing service latency percentiles for an internal platform team.', entities: ['React', 'D3'], tags: ['deployed', 'frontend'] }),
    rec({ id: 'FACT-001', title: 'Programming languages', text: 'Comfortable with Python, TypeScript and Java for backend work.', entities: ['Python', 'TypeScript', 'Java'], tags: ['skills'] }),
    rec({ id: 'FACT-002', title: 'Cloud platforms', text: 'Has deployed services on AWS using Terraform and Docker.', entities: ['AWS', 'Terraform', 'Docker'], tags: ['skills', 'cloud'] }),
    rec({ id: 'FACT-003', title: 'Education', evidence: 'coursework', text: 'Master of Science in computer science, graduating in 2026.', entities: ['Riverside University'], tags: ['education'] }),
    rec({ id: 'FACT-004', title: 'Work authorization', evidence: 'identity', text: 'Needs sponsorship for full-time roles after the OPT period.', entities: [], tags: ['work_authorization'] }),
    // recency tie pair: same everything except the end date and the last word
    rec({ id: 'FACT-010', title: 'Rust tooling', effective_to: '2019', text: 'Wrote small Rust command line tools for log parsing.', entities: ['Rust', 'Cargo'], tags: ['skills'] }),
    rec({ id: 'FACT-011', title: 'Rust tooling', effective_to: '2025', text: 'Wrote small Rust command line tools for log reading.', entities: ['Rust', 'Clippy'], tags: ['skills'] }),
    // competency reorder pair
    rec({ id: 'FACT-020', title: 'Database migration notes', text: 'Planned a database migration with a rollback path.', entities: ['Flyway'], tags: ['migration'] }),
    rec({ id: 'FACT-021', title: 'Database migration lessons', text: 'Planned a database migration with a staged rollback path.', entities: ['Liquibase'], tags: ['migration', 'leadership'] }),
    // repetition pair
    rec({ id: 'FACT-030', title: 'Observability stack', text: 'Built dashboards and alerts with Grafana and Prometheus.', entities: ['Grafana', 'Prometheus'], tags: ['observability'] }),
    rec({ id: 'FACT-031', title: 'Observability stack', text: 'Built dashboards and alerts with Grafana and Loki.', entities: ['Grafana', 'Loki'], tags: ['observability'] }),
    rec({ id: 'FACT-040', title: 'Salary history', sensitivity: 'restricted', text: 'Zebracorn compensation details that must never leave the machine.', entities: ['Zebracorn'], tags: ['private'] }),
    rec({ id: 'FACT-041', title: 'Draft claim', approved: false, text: 'Quokkaware unreviewed claim awaiting approval.', entities: ['Quokkaware'], tags: ['draft'] }),
    rec({ id: 'COR-0001', type: 'correction', evidence: 'correction', title: 'Correction Brightwell internship dates', supersedes: 'EXP-002', version: 1,
      text: 'The Brightwell internship ended in September 2021, not December 2021.', entities: ['Brightwell'], tags: ['correction'] }),
    rec({ id: 'COR-0002', type: 'correction', evidence: 'correction', title: 'Correction work authorization', supersedes: 'work_authorization', version: 1,
      text: 'Old wording about visa status that was later replaced.', entities: [], tags: ['correction'] }),
    rec({ id: 'COR-0003', type: 'correction', evidence: 'correction', title: 'Correction work authorization', supersedes: 'work_authorization', version: 2,
      text: 'Current wording: needs sponsorship starting after the OPT period ends.', entities: [], tags: ['correction'] }),
    // STAR stories
    story({ id: 'STORY-PRJ-001-1', title: 'Capstone solver speedup', entities: ['OR-Tools', 'Python', 'Riverside University'], tags: ['star', 'technical_challenge', 'capstone'],
      effective_from: '2025-09', effective_to: '2026-04', evidence: 'built',
      star: { competency: 'technical_challenge', parent_id: 'PRJ-001', situation: 'For my capstone I had to route campus shuttles and the solver was far too slow.',
        task: 'Cut solve time so planners could iterate.', action: 'I profiled the solver, I wrote a custom pruning heuristic in Python, and I designed a warm start using OR-Tools.',
        result: 'Solve time dropped from 40 minutes to 6 minutes, an 85% reduction.' } }),
    story({ id: 'STORY-PRJ-001-2', title: 'Capstone team integration', entities: ['GitHub', 'Riverside University'], tags: ['star', 'teamwork', 'capstone'],
      effective_from: '2025-09', effective_to: '2026-04', evidence: 'built',
      star: { competency: 'teamwork', parent_id: 'PRJ-001', situation: 'In the capstone our team of four split the routing model, the data pipeline and the interface.',
        action: 'I set up weekly integration demos, I wrote the shared data contract, and I ran code reviews in GitHub.',
        result: 'We shipped on time with 0 merge-blocking regressions across 12 weeks.' } }),
    story({ id: 'STORY-PRJ-001-3', title: 'Capstone vague brief', entities: ['Riverside University'], tags: ['star', 'ambiguity', 'capstone'],
      effective_from: '2025-09', effective_to: '2026-04', evidence: 'built',
      star: { competency: 'ambiguity', parent_id: 'PRJ-001', situation: 'The capstone sponsor gave an open-ended brief with no clear success metric.',
        action: 'I interviewed planners, I mapped their decisions and I proposed three measurable goals.',
        result: 'The sponsor adopted two of the goals and the project gained a clear scope.' } }),
    story({ id: 'STORY-EXP-001-1', title: 'Schema change disagreement', entities: ['Orbitly', 'Postgres'], tags: ['star', 'conflict', 'teamwork'],
      effective_from: '2023-06', effective_to: null, evidence: 'employment',
      star: { competency: 'conflict', parent_id: 'EXP-001', situation: 'A teammate and I disagreed about changing the Postgres schema before a release.',
        action: 'I wrote a short comparison of both options, I ran a load test on Postgres, and I proposed a staged migration.',
        result: 'We agreed on the staged plan and cut migration downtime to 3 minutes.' } }),
    story({ id: 'STORY-EXP-001-2', title: 'Moved-up launch', entities: ['Orbitly', 'Kafka'], tags: ['star', 'deadline'],
      effective_from: '2023-06', effective_to: null, evidence: 'employment',
      star: { competency: 'deadline', parent_id: 'EXP-001', situation: 'A customer launch moved up by two weeks.',
        action: 'I cut scope with the product manager, I built the ingestion path first and I deployed behind a flag on Kafka.',
        result: 'We launched on the new date and handled 2 million events on day one.' } }),
    story({ id: 'STORY-EXP-002-1', title: 'Overwritten reporting table', entities: ['Brightwell', 'Airflow'], tags: ['star', 'failure'],
      effective_from: '2021-06', effective_to: '2021-09', evidence: 'employment',
      star: { competency: 'failure', parent_id: 'EXP-002', situation: 'My first Airflow job overwrote a reporting table at Brightwell.',
        action: 'I restored the table from a snapshot, I wrote a dry-run check, and I documented the runbook.',
        result: 'No further overwrites happened and the dry-run check was adopted by the team.' } }),
    story({ id: 'STORY-PRJ-002-1', title: 'First compiler plugin', entities: ['ESLint', 'TypeScript'], tags: ['star', 'learning'],
      effective_from: '2024-01', effective_to: '2024-03', evidence: 'built',
      star: { competency: 'learning', parent_id: 'PRJ-002', situation: 'I had never written a TypeScript lint plugin before.',
        action: 'I read the ESLint source, I built a prototype in a weekend and I wrote 30 test cases.',
        result: 'The plugin merged upstream after 2 review rounds.' } }),
    story({ id: 'STORY-PRJ-005-1', title: 'Robot design disagreement', entities: ['Zephyr Robotics Club'], tags: ['star', 'conflict'],
      effective_from: '2024-01', effective_to: null, evidence: 'listed-only',
      star: { competency: 'conflict', parent_id: 'PRJ-005', situation: 'Two club members disagreed over the robot design.',
        action: 'I led a discussion and I designed a vote for Zephyr Robotics Club.', result: 'The club chose a design with 100% agreement.' } }),
  ];
}

const retrieverFor = (records, extra = {}) => createRetriever({ records, now, ...extra });

// ---------- corpus sanity ----------

test('synthetic corpus: 20-30 valid records with the required shapes', () => {
  const c = corpus();
  assert.ok(c.length >= 20 && c.length <= 30, `corpus size ${c.length}`);
  assert.ok(c.filter((r) => r.type === 'star_story').length >= 6);
  assert.ok(c.some((r) => r.sensitivity === 'restricted'));
  assert.ok(c.some((r) => r.approved === false));
  assert.ok(c.some((r) => r.type === 'correction'));
  assert.ok(c.some((r) => r.type === 'fact') && c.some((r) => r.type === 'experience'));
});

// ---------- retrieval ----------

test('exact keyword and entity hits rank first', () => {
  const r = retrieverFor(corpus());
  const res = r.search('Orbitly Kafka');
  assert.strictEqual(res.items[0].record.id, 'EXP-001');
  assert.strictEqual(res.items[0].breakdown.entity, 1);
  assert.strictEqual(res.items[0].breakdown.keyword, 1);
  assert.deepStrictEqual(res.sourceIds, ids(res));

  const edu = r.search('Tell me about your education at Riverside University');
  assert.strictEqual(edu.items[0].record.id, 'FACT-003');
  assert.ok(edu.items[0].breakdown.entity > 0);

  const lower = r.search('anything about snowflake');
  const top = lower.items.find((i) => i.record.type !== 'correction');
  assert.strictEqual(top.record.id, 'EXP-002', 'known entities match case-insensitively');
  assert.strictEqual(top.breakdown.entity, 1);
});

test('breakdown exposes every feature plus the repetition penalty', () => {
  const res = retrieverFor(corpus()).search('Grafana');
  for (const k of ['keyword', 'entity', 'competency', 'recency', 'confidence', 'session', 'penalty']) assert.ok(k in res.items[0].breakdown, k);
});

test('competency boost reorders results', () => {
  const r = retrieverFor(corpus());
  const base = ids(r.search('database migration', { types: ['fact'] }));
  assert.deepStrictEqual(base.slice(0, 2), ['FACT-020', 'FACT-021']);
  const boosted = r.search('database migration', { types: ['fact'], competencies: ['leadership'] });
  assert.deepStrictEqual(ids(boosted).slice(0, 2), ['FACT-021', 'FACT-020']);
  assert.strictEqual(boosted.items[0].breakdown.competency, 1);
  assert.strictEqual(boosted.items[1].breakdown.competency, 0);
});

test('recency breaks ties', () => {
  const r = retrieverFor(corpus());
  const res = r.search('Rust');
  assert.deepStrictEqual(ids(res).slice(0, 2), ['FACT-011', 'FACT-010']);
  const [a, b] = res.items;
  assert.ok(Math.abs(a.breakdown.keyword - b.breakdown.keyword) < 1e-9, 'keyword scores tie');
  assert.ok(a.score > b.score);
});

test('recency feature: ongoing is 1, linear over six years, falls back to updated_at', () => {
  const base = { effective_from: null, effective_to: null, updated_at: '2026-10-14' };
  assert.strictEqual(recencyOf({ ...base, effective_from: '2020-01', effective_to: null }, NOW), 1);
  assert.ok(recencyOf({ ...base, effective_to: '2026-10' }, NOW) > 0.99);
  assert.strictEqual(recencyOf({ ...base, effective_to: '2019' }, NOW), 0);
  const mid = recencyOf({ ...base, effective_to: '2023-10' }, NOW);
  assert.ok(mid > 0.45 && mid < 0.55, `three years ago is about 0.5, got ${mid}`);
  assert.ok(recencyOf({ ...base, updated_at: '2026-10-01' }, NOW) > 0.99);
});

test('repetition penalty demotes a record used twice (capped at 0.3)', () => {
  const r = retrieverFor(corpus());
  const session = createSession({ now });
  const before = r.search('Grafana', { session });
  assert.deepStrictEqual(ids(before).slice(0, 2), ['FACT-030', 'FACT-031']);
  const s0 = before.items[0].score;
  session.noteUsed(['FACT-030']);
  session.noteUsed(['FACT-030']);
  const after = r.search('Grafana', { session });
  assert.deepStrictEqual(ids(after).slice(0, 2), ['FACT-031', 'FACT-030']);
  const demoted = after.items.find((i) => i.record.id === 'FACT-030');
  assert.ok(Math.abs(demoted.breakdown.penalty - 0.2) < 1e-9);
  assert.ok(Math.abs(s0 - demoted.score - 0.2) < 1e-9);
  session.noteUsed(['FACT-030']);
  session.noteUsed(['FACT-030']);
  const capped = r.search('Grafana', { session }).items.find((i) => i.record.id === 'FACT-030');
  assert.ok(Math.abs(capped.breakdown.penalty - 0.3) < 1e-9);
});

test('session topic terms feed the session feature', () => {
  const r = retrieverFor(corpus());
  const session = createSession({ now, meetingNotes: 'Interview about Loki log aggregation' });
  const res = r.search('Grafana', { session });
  assert.strictEqual(res.items[0].record.id, 'FACT-031');
  assert.strictEqual(res.items[0].breakdown.session, 1);
  assert.strictEqual(res.items[1].breakdown.session, 0);
});

test('restricted and unapproved records are never returned', () => {
  const r = retrieverFor(corpus());
  for (const q of ['Zebracorn compensation', 'Quokkaware unreviewed claim', 'salary history draft claim']) {
    const res = r.search(q, { maxItems: 50, budgetTokens: 100000 });
    assert.ok(!ids(res).includes('FACT-040') && !ids(res).includes('FACT-041'), q);
  }
  // also when supplied as corrections
  const hidden = rec({ id: 'COR-0099', type: 'correction', evidence: 'correction', title: 'Secret correction', supersedes: 'EXP-001', version: 1,
    text: 'Restricted correction text.', sensitivity: 'restricted', tags: ['correction'] });
  const res = createRetriever({ records: corpus(), corrections: [hidden], now }).search('Orbitly Kafka');
  assert.ok(!ids(res).includes('COR-0099'));
});

test('a correction is included first when its target is returned', () => {
  const r = retrieverFor(corpus());
  const res = r.search('Airflow pipelines');
  assert.ok(ids(res).includes('EXP-002'));
  assert.strictEqual(res.items[0].record.id, 'COR-0001');
  assert.ok(res.sourceIds.includes('COR-0001'));
  // no target, no correction
  assert.ok(!ids(r.search('Orbitly Kafka')).includes('COR-0001'));
});

test('a correction is included on keyword match, and only the latest version', () => {
  const res = retrieverFor(corpus()).search('work authorization status');
  assert.strictEqual(res.items[0].record.id, 'COR-0003');
  assert.ok(!ids(res).includes('COR-0002'));
  assert.ok(ids(res).includes('FACT-004'));
});

test('a correction survives a tight budget even when a record would crowd it out', () => {
  const big = rec({ id: 'FACT-050', title: 'Airflow handbook', text: 'Airflow '.repeat(200), entities: ['Airflow'], tags: ['data'] });
  const cor = rec({ id: 'COR-0050', type: 'correction', evidence: 'correction', title: 'Airflow correction', supersedes: 'FACT-050', version: 1,
    text: 'Short fix for the Airflow handbook.', entities: ['Airflow'], tags: ['correction'] });
  const budget = estimateTokens(cor.title + cor.text) + 40;
  const res = createRetriever({ records: [big], corrections: [cor], now }).search('Airflow', { budgetTokens: budget });
  assert.strictEqual(res.items[0].record.id, 'COR-0050');
  assert.ok(res.tokensEst <= budget);
  assert.ok(!res.items[0].truncated);
});

test('token budget is respected', () => {
  const recs = ['a', 'b', 'c', 'd', 'e'].map((x, i) => rec({
    id: `FACT-1${i}`, title: `Kubernetes note ${x}`, text: `Kubernetes operations detail ${x}. `.repeat(12), entities: [`Tool${x}`], tags: ['ops'],
  }));
  const per = estimateTokens(recs[0].title + recs[0].text);
  const budget = per * 2 + 10;
  const res = retrieverFor(recs).search('Kubernetes', { budgetTokens: budget, maxItems: 10 });
  assert.strictEqual(res.items.length, 2);
  assert.ok(res.tokensEst <= budget);
  assert.strictEqual(res.tokensEst, res.items.reduce((n, i) => n + estimateTokens(i.record.title + i.record.text), 0));
  assert.ok(res.items.every((i) => !i.truncated));
  assert.strictEqual(retrieverFor(recs).search('Kubernetes', { maxItems: 3 }).items.length, 3);
});

test('the first item is truncated when it alone exceeds the budget', () => {
  const big = rec({ id: 'FACT-060', title: 'Kubernetes deep dive', text: 'Kubernetes cluster operations and upgrade runbooks. '.repeat(120), entities: ['Kubernetes'], tags: ['ops'] });
  const small = rec({ id: 'FACT-061', title: 'Kubernetes cheat sheet', text: 'Short note.', entities: ['Helm'], tags: ['ops'] });
  const full = estimateTokens(big.title + big.text);
  const budget = 200;
  assert.ok(full > budget);
  const res = retrieverFor([big, small]).search('Kubernetes', { budgetTokens: budget });
  assert.strictEqual(res.items[0].truncated, true);
  assert.ok(res.items[0].record.text.endsWith('…'));
  assert.ok(res.items[0].record.text.length < big.text.length);
  assert.ok(estimateTokens(res.items[0].record.title + res.items[0].record.text) <= budget);
  assert.ok(res.tokensEst <= budget);
  assert.strictEqual(big.text.length, 'Kubernetes cluster operations and upgrade runbooks. '.length * 120, 'original record is not mutated');
});

test('at most 2 items share a parent', () => {
  const res = retrieverFor(corpus()).search('capstone', { maxItems: 20, budgetTokens: 100000 });
  const family = res.items.filter((i) => ((i.record.star && i.record.star.parent_id) || i.record.id) === 'PRJ-001');
  assert.strictEqual(family.length, 2);
  assert.strictEqual(new Set(ids(res)).size, ids(res).length);
});

test('exact duplicate texts are dropped', () => {
  const a = rec({ id: 'FACT-070', title: 'Terraform modules', text: 'Wrote reusable Terraform modules.', entities: ['Terraform'], tags: [] });
  const b = rec({ id: 'FACT-071', title: 'Terraform modules again', text: 'Wrote  reusable terraform modules.', entities: ['Terraform', 'AWS'], tags: [] });
  const res = retrieverFor([a, b]).search('Terraform modules');
  assert.deepStrictEqual(ids(res), ['FACT-070']);
});

test('diversity skips a near-duplicate entity set unless the score is above 0.9', () => {
  const mk = (id, text, entities) => rec({ id, title: 'Pipeline work', text, entities, tags: [] });
  const records = [
    mk('FACT-080', 'Pipeline work on ingestion for the platform team.', ['Orbitly', 'Kafka', 'Postgres']),
    mk('FACT-081', 'Pipeline work on ingestion for the billing team.', ['Orbitly', 'Kafka', 'Postgres']),
    mk('FACT-082', 'Pipeline work on ingestion for the data team.', ['Orbitly', 'Kafka', 'Redis']),
  ];
  const res = retrieverFor(records).search('pipeline ingestion');
  assert.deepStrictEqual(ids(res), ['FACT-080', 'FACT-082']);
  const boosted = retrieverFor(records, { weights: { keyword: 2 } }).search('pipeline ingestion');
  assert.ok(boosted.items.every((i) => i.score > 0.9));
  assert.deepStrictEqual(ids(boosted), ['FACT-080', 'FACT-081', 'FACT-082']);
});

test('order is deterministic: score desc, then id asc, independent of input order', () => {
  const c = corpus();
  const shuffled = [...c].reverse();
  const q = 'Orbitly Kafka Postgres teamwork migration';
  const opts = { competencies: ['teamwork'], maxItems: 20, budgetTokens: 100000 };
  const a = retrieverFor(c).search(q, opts);
  const b = retrieverFor(shuffled).search(q, opts);
  const again = retrieverFor(c).search(q, opts);
  assert.deepStrictEqual(ids(a), ids(b));
  assert.deepStrictEqual(ids(a), ids(again));
  assert.deepStrictEqual(a.items.map((i) => i.score), b.items.map((i) => i.score));
  for (let i = 1; i < a.items.length; i++) {
    const p = a.items[i - 1];
    const n = a.items[i];
    if (p.record.type === 'correction' || n.record.type === 'correction') continue;
    assert.ok(p.score > n.score || (p.score === n.score && p.record.id < n.record.id));
  }
  // exact ties fall back to id order
  const t1 = rec({ id: 'FACT-091', title: 'Zig tool', text: 'Wrote a Zig tool alpha.', entities: ['ZigA'], tags: [] });
  const t2 = rec({ id: 'FACT-090', title: 'Zig tool', text: 'Wrote a Zig tool bravo.', entities: ['ZigB'], tags: [] });
  assert.deepStrictEqual(ids(retrieverFor([t1, t2]).search('Zig tool')), ['FACT-090', 'FACT-091']);
});

test('weights are configurable and default weights match the spec', () => {
  assert.deepStrictEqual({ ...DEFAULT_WEIGHTS }, { keyword: 0.45, entity: 0.15, competency: 0.15, recency: 0.10, confidence: 0.10, session: 0.05 });
  const r = retrieverFor(corpus(), { weights: { keyword: 0, entity: 0, competency: 0, recency: 0, confidence: 1, session: 0 } });
  const res = r.search('Grafana', { maxItems: 3 });
  assert.ok(res.items.every((i) => Math.abs(i.score - i.record.confidence) < 1e-9));
});

test('empty and unmatched queries return nothing without throwing', () => {
  const r = retrieverFor(corpus());
  assert.deepStrictEqual(r.search(''), { items: [], sourceIds: [], tokensEst: 0 });
  assert.strictEqual(r.search('xyzzyplugh qqqqq').items.length, 0);
});

// ---------- inferCompetencies ----------

test('inferCompetencies: conflict + teamwork, case-insensitive, ordered and unique', () => {
  const out = inferCompetencies('Tell me about a time you had a conflict with a teammate');
  assert.ok(out.includes('conflict') && out.includes('teamwork'));
  assert.deepStrictEqual(inferCompetencies('TELL ME ABOUT A CONFLICT WITH A TEAMMATE'), out);
  assert.strictEqual(new Set(out).size, out.length);
  assert.deepStrictEqual(inferCompetencies('team team team and a teammate collaborated'), ['teamwork']);
  assert.deepStrictEqual(inferCompetencies('What is your favourite colour?'), []);
  assert.deepStrictEqual(inferCompetencies('Describe a deadline you missed and what you learned from it'), ['deadline', 'failure', 'learning']);
  assert.ok(!inferCompetencies('I checked the ledger').includes('leadership'), 'short keywords need a whole-word match');
  assert.ok(inferCompetencies('Who led the effort?').includes('leadership'));
});

// ---------- story selector ----------

test('story selector picks the matching-competency story with a full breakdown', () => {
  const sel = createStorySelector({ records: corpus(), now });
  const res = sel.select({ query: 'How do you handle a disagreement with a colleague?' });
  assert.ok(res);
  assert.strictEqual(res.story.id, 'STORY-EXP-001-1');
  for (const k of ['competency', 'completeness', 'specificity', 'result', 'recency', 'voice', 'repetition', 'keyword']) {
    assert.strictEqual(typeof res.breakdown[k], 'number', k);
  }
  assert.strictEqual(res.breakdown.competency, 1);
  assert.strictEqual(res.breakdown.voice, 0.5);
  assert.strictEqual(res.breakdown.result, 1);
  assert.ok(res.score >= 0.45);

  const dl = sel.select({ query: 'Tell me about working under a tight deadline', competencies: ['deadline'] });
  assert.strictEqual(dl.story.id, 'STORY-EXP-001-2');
  const fail = sel.select({ query: 'Tell me about a mistake you made' });
  assert.strictEqual(fail.story.id, 'STORY-EXP-002-1');
});

test('story selector: "the capstone" prefers a PRJ-001 story, with or without a retriever', () => {
  const recs = corpus();
  const sel = createStorySelector({ records: recs, now });
  const res = sel.select({ query: 'the capstone' });
  assert.ok(res);
  assert.strictEqual(res.story.star.parent_id, 'PRJ-001');
  assert.ok(res.breakdown.keyword > 0);
  const viaRetriever = sel.select({ query: 'the capstone', retriever: retrieverFor(recs) });
  assert.strictEqual(viaRetriever.story.star.parent_id, 'PRJ-001');
  const comp = sel.select({ query: 'the capstone', competencies: ['teamwork'] });
  assert.strictEqual(comp.story.id, 'STORY-PRJ-001-2');
});

test('story selector honours the threshold', () => {
  const sel = createStorySelector({ records: corpus(), now });
  assert.strictEqual(sel.select({ query: 'What is the weather like in Lisbon tomorrow?' }), null);
  assert.strictEqual(sel.select({ query: '' }), null);
  const strict = createStorySelector({ records: corpus(), now, threshold: 5 });
  assert.strictEqual(strict.select({ query: 'a conflict with a teammate' }), null);
  // a story that only fits through its tags, with thin content, stays below the default threshold
  const weak = story({ id: 'STORY-PRJ-950-1', evidence: 'employment', entities: ['Quux'], tags: ['star', 'leadership'], effective_from: '2016-01', effective_to: '2016-02',
    star: { competency: 'ambiguity', parent_id: 'PRJ-950', situation: '', action: 'Helped out.', result: '' } });
  assert.strictEqual(createStorySelector({ records: [weak], now }).select({ query: 'zzz', competencies: ['leadership'] }), null);
  const lenient = createStorySelector({ records: [weak], now, threshold: 0.2 }).select({ query: 'zzz', competencies: ['leadership'] });
  assert.ok(lenient && lenient.breakdown.competency === 0.5);
});

test('story selector avoids repeating the last-used story when an equal alternative exists', () => {
  const mk = (id) => story({ id, title: 'Deadline crunch', entities: ['Orbitly'], tags: ['star', 'deadline'], evidence: 'employment',
    star: { competency: 'deadline', parent_id: 'EXP-777', situation: 'A release date moved up.', action: 'I cut scope and I built the core path first.', result: 'We shipped on the new date with 2 fewer features.' } });
  const sel = createStorySelector({ records: [mk('STORY-EXP-777-2'), mk('STORY-EXP-777-1')], now });
  const session = createSession({ now });
  const first = sel.select({ query: 'tight deadline', competencies: ['deadline'], session });
  assert.strictEqual(first.story.id, 'STORY-EXP-777-1', 'id asc breaks exact ties');
  session.noteUsed([], first.story.id);
  const second = sel.select({ query: 'tight deadline', competencies: ['deadline'], session });
  assert.strictEqual(second.story.id, 'STORY-EXP-777-2');
  assert.ok(second.breakdown.repetition > 0.99);
  session.noteUsed([], second.story.id);
  session.noteUsed([], second.story.id);
  const third = sel.select({ query: 'tight deadline', competencies: ['deadline'], session });
  assert.strictEqual(third.story.id, 'STORY-EXP-777-1', 'back to the least-used story');
  assert.ok(Math.abs(third.breakdown.repetition - 0.5) < 1e-9);
});

test('story selector keeps listed-only stories out unless the query names the entity', () => {
  const sel = createStorySelector({ records: corpus(), now });
  const res = sel.select({ query: 'a conflict with a teammate' });
  assert.notStrictEqual(res.story.id, 'STORY-PRJ-005-1');
  const only = createStorySelector({ records: corpus().filter((r) => r.type !== 'star_story' || r.id === 'STORY-PRJ-005-1'), now });
  assert.strictEqual(only.select({ query: 'a conflict with a teammate' }), null);
  const named = only.select({ query: 'Tell me about a conflict at the Zephyr Robotics Club' });
  assert.ok(named);
  assert.strictEqual(named.story.id, 'STORY-PRJ-005-1');
});

test('story result scoring: numbers need strong evidence, qualitative results score lower', () => {
  const mk = (evidence, result) => story({ id: `STORY-PRJ-96${evidence.length}-1`, evidence, star: { competency: 'teamwork', parent_id: 'PRJ-960', situation: 'S.', action: 'A.', result } });
  const score = (r) => createStorySelector({ records: [r], now }).select({ query: 'teamwork', competencies: ['teamwork'], threshold: 0 }).breakdown.result;
  assert.strictEqual(score(mk('employment', 'Cut latency by 40%.')), 1);
  assert.strictEqual(score(mk('built', 'Served 3 teams.')), 1);
  assert.strictEqual(score(mk('coursework', 'Scored 95 on the review.')), 0.8);
  assert.strictEqual(score(mk('evaluated', 'Scored 95 on the review.')), 0.8);
  assert.strictEqual(score(mk('employment', 'The team was happy with it.')), 0.4);
});

test('story specificity counts first-person verbs and named tools, capped at 1', () => {
  const mk = (action, entities) => story({ id: 'STORY-PRJ-970-1', entities, star: { competency: 'teamwork', parent_id: 'PRJ-970', situation: 'S.', action, result: 'R 1.' } });
  const spec = (r) => createStorySelector({ records: [r], now }).select({ query: 'teamwork', competencies: ['teamwork'], threshold: 0 }).breakdown.specificity;
  assert.strictEqual(spec(mk('We did it together.', [])), 0);
  assert.strictEqual(spec(mk('I built a parser.', [])), 0.25);
  assert.strictEqual(spec(mk('I built a parser in Rust and I wrote tests with Cargo.', ['Rust', 'Cargo'])), 1);
  assert.strictEqual(spec(mk('I built it. I wrote it. I designed it. I ran it. I fixed it.', [])), 1);
});

// ---------- session ----------

test('session: topic terms come from notes and recent questions, minus stop words, max 40', () => {
  const s = createSession({ now, meetingNotes: 'Interview with the Platform team about Kubernetes and Terraform' });
  let t = s.topicTerms;
  assert.ok(t.includes('platform') && t.includes('kubernetes') && t.includes('terraform'));
  assert.ok(!t.includes('the') && !t.includes('with') && !t.includes('about'));
  assert.ok(t.every((x) => x === x.toLowerCase()));
  s.noteQuestion('Tell me about your experience with Kafka streaming');
  t = s.topicTerms;
  assert.ok(t.includes('kafka') && t.includes('streaming'));
  assert.ok(t.indexOf('kafka') < t.indexOf('kubernetes'), 'recent questions come first');
  s.noteQuestion(Array.from({ length: 80 }, (_, i) => `term${i}`).join(' '));
  assert.strictEqual(s.topicTerms.length, 40);
  assert.strictEqual(new Set(s.topicTerms).size, 40);
});

test('session: usage counts and recent questions', () => {
  const s = createSession({ now });
  assert.strictEqual(s.usageCount('EXP-001'), 0);
  s.noteUsed(['EXP-001', 'PRJ-001'], 'STORY-PRJ-001-1');
  s.noteUsed(['EXP-001']);
  s.noteUsed(['PRJ-001'], 'PRJ-001');
  assert.strictEqual(s.usageCount('EXP-001'), 2);
  assert.strictEqual(s.usageCount('PRJ-001'), 2, 'an id listed twice in one call counts once');
  assert.strictEqual(s.usageCount('STORY-PRJ-001-1'), 1);
  for (let i = 1; i <= 8; i++) s.noteQuestion(`question ${i}`);
  assert.deepStrictEqual(s.recentQuestions(2), ['question 7', 'question 8']);
  assert.strictEqual(s.recentQuestions(100).length, 8);
});

test('session: snapshot keeps at most the last 5 questions and no raw notes', () => {
  const s = createSession({ now, meetingNotes: 'Confidential agenda about Zebracorn' });
  for (let i = 1; i <= 9; i++) s.noteQuestion(`question number ${i}`);
  s.noteUsed(['EXP-001']);
  const snap = s.snapshot();
  assert.strictEqual(snap.recentQuestions.length, 5);
  assert.deepStrictEqual(snap.recentQuestions[4], 'question number 9');
  assert.strictEqual(snap.usage['EXP-001'], 1);
  assert.strictEqual(snap.expired, false);
  assert.ok(!JSON.stringify(snap).includes('Confidential agenda'));
  assert.ok(!JSON.stringify(snap).includes('question number 1"'));
});

test('session: expiry empties every getter until reset()', () => {
  let t = NOW;
  const clock = () => t;
  const s = createSession({ ttlMinutes: 10, now: clock, meetingNotes: 'notes about Kafka' });
  s.noteQuestion('What about Postgres?');
  s.noteUsed(['EXP-001']);
  assert.strictEqual(s.expired(), false);
  t += 10 * 60000;
  assert.strictEqual(s.expired(), false, 'exactly at the ttl is still live');
  t += 1;
  assert.strictEqual(s.expired(), true);
  assert.strictEqual(s.usageCount('EXP-001'), 0);
  assert.deepStrictEqual(s.topicTerms, []);
  assert.deepStrictEqual(s.recentQuestions(5), []);
  const snap = s.snapshot();
  assert.strictEqual(snap.expired, true);
  assert.deepStrictEqual(snap.recentQuestions, []);
  assert.deepStrictEqual(snap.usage, {});
  s.noteQuestion('ignored while expired');
  s.noteUsed(['EXP-001']);
  assert.strictEqual(s.expired(), true, 'writes do not revive an expired session');
  assert.strictEqual(s.usageCount('EXP-001'), 0);

  s.reset();
  assert.strictEqual(s.expired(), false);
  assert.strictEqual(s.usageCount('EXP-001'), 0);
  assert.deepStrictEqual(s.recentQuestions(5), []);
  assert.ok(s.topicTerms.includes('kafka'), 'meeting notes survive reset');
  assert.ok(!s.topicTerms.includes('postgres'));
  s.noteQuestion('Fresh question about Redis');
  assert.ok(s.topicTerms.includes('redis'));
  s.reset('new notes about Rust');
  assert.deepStrictEqual(s.topicTerms, ['new', 'notes', 'rust'].filter((x) => s.topicTerms.includes(x)));
  assert.ok(!s.topicTerms.includes('kafka'));
});

test('session: activity extends the ttl and an expired session is ignored by the retriever and selector', () => {
  let t = NOW;
  const clock = () => t;
  const s = createSession({ ttlMinutes: 10, now: clock });
  t += 8 * 60000;
  s.noteQuestion('still here');
  t += 8 * 60000;
  assert.strictEqual(s.expired(), false);
  s.noteUsed(['FACT-030']);
  t += 11 * 60000;
  assert.strictEqual(s.expired(), true);
  const res = retrieverFor(corpus()).search('Grafana', { session: s });
  assert.deepStrictEqual(ids(res).slice(0, 2), ['FACT-030', 'FACT-031'], 'no penalty once the session expired');
  assert.strictEqual(res.items[0].breakdown.penalty, 0);
});
