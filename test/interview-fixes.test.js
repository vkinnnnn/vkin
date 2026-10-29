'use strict';
// Fixes from a mock-interview review (2026-10-23).
const test = require('node:test');
const assert = require('node:assert');
const { isFollowUp, splitCourtesy } = require('../src/main/brain/question-focus');
const { validateAnswer } = require('../src/main/validate');

test('[1] a polite opener before a new question is not a follow-up', () => {
  for (const q of [
    "Thanks for sharing that detailed experience. Next, I'd like to discuss your SQL and database skills. Can you describe how you've used SQL?",
    "Thanks for that explanation of your database work. Next, I'd like to ask: What kinds of analytics or business intelligence tools have you used?",
    "Thanks for that overview of your analytics and BI tool experience. Now, what's your experience coordinating data work across teams?",
    'Thanks for that thorough overview. For the final question, what experience do you have with website-related projects?',
  ]) assert.equal(isFollowUp(q), false, q);
  assert.equal(splitCourtesy('Thanks for that thorough overview. For the final question, what experience do you have?').core, 'For the final question, what experience do you have?');
});

test('[1] real follow-ups are still follow-ups, even after thanks or a transition', () => {
  for (const q of ['Thanks. Can you tell me more about that dashboard?', 'Why did you choose Airflow for that?', 'Next, tell me more about the dashboard you mentioned.', 'So how does that work now?', 'That is interesting. How did you decide which sources to check first?']) {
    assert.equal(isFollowUp(q), true, q);
  }
  assert.equal(isFollowUp('Why did you choose Airflow?', { hasConversation: false }), false, 'nothing to follow');
});

const evidence = [
  { id: 'OTM-CONCEPT-DQ', background: true, text: 'Typical checks are required-field rules, allowed values per category, duplicate detection and reconciliation against supplier feeds.' },
  { id: 'PRJ-009', text: 'Implemented the core tables in PostgreSQL 16, loaded synthetic data generated in Python through SQLAlchemy, and wrote 8 SQL queries.' },
  { id: 'EXP-001', text: 'I ran data quality checks on every source before analysis, resolving missing and inconsistent records.' },
];

test('[2] a background note cannot become an account of my own work', () => {
  const bad = validateAnswer({ answer: 'SAY: I applied required-field rules, allowed-value lists, duplicate-key checks and reconciliation against the source models to keep the catalog accurate.', evidence });
  assert.equal(bad.ok, false);
  assert.equal(bad.unsupported_claims[0].kind, 'borrowed');
});

test('[2] verified work, hypotheticals and explanations stay allowed', () => {
  assert.equal(validateAnswer({ answer: 'SAY: I ran data quality checks on every source before analysis, resolving missing and inconsistent records.', evidence }).ok, true);
  assert.equal(validateAnswer({ answer: 'SAY: Here I would start with required-field rules and allowed values per category, then reconcile against supplier feeds.', evidence }).ok, true);
  assert.equal(validateAnswer({ answer: 'SAY: Typical catalog checks are required-field rules and allowed values per category.', evidence }).ok, true);
  // No background sources at all (ordinary interviews without a pack): the check is off.
  assert.equal(validateAnswer({ answer: 'SAY: I applied required-field rules and allowed-value lists.', evidence: evidence.filter((e) => !e.background) }).ok, true);
});

test('[3] long dash-chained sentences are split for speaking; short ones are left alone', () => {
  const { splitDashChains } = require('../src/main/render');
  const long = 'SAY: In my capstone I was one of four people building a system for the sponsor over 15 weeks — we ran two-week sprints with progress presentations every two weeks — we closed with a live demo.';
  assert.equal(splitDashChains(long), 'SAY: In my capstone I was one of four people building a system for the sponsor over 15 weeks. We ran two-week sprints with progress presentations every two weeks. We closed with a live demo.');
  const short = 'SAY: Yeah — it worked well.';
  assert.equal(splitDashChains(short), short);
});

test('[3] invented acceptance, schedule and leadership outcomes need evidence', () => {
  const ev = [{ id: 'PRJ-001', text: 'A 4-person team delivered the system to Contoso with a 15-minute live demo.' }];
  for (const s of ['The sponsor accepted it as their analytics foundation.', 'We delivered it on schedule.', 'I took charge of the sprint plan.', 'The final demo ran clean without rework.']) {
    assert.equal(validateAnswer({ answer: `SAY: ${s}`, evidence: ev, kind: 'behavioral' }).ok, false, s);
  }
  assert.equal(validateAnswer({ answer: 'SAY: We delivered the system to Contoso with a live demo.', evidence: ev, kind: 'behavioral' }).ok, true);
});
test('[3] an appositive after a dash stays attached instead of becoming a fragment', () => {
  const { splitDashChains } = require('../src/main/render');
  const s = 'SAY: I designed fifteen cleaning and feature modules for the retail transactions in that public dataset project — handling nulls, duplicates, outliers and price errors — then orchestrated them in Airflow.';
  assert.equal(splitDashChains(s), 'SAY: I designed fifteen cleaning and feature modules for the retail transactions in that public dataset project, handling nulls, duplicates, outliers and price errors, then orchestrated them in Airflow.');
});
test('[3] more invented details need evidence: requests, running the team, "to minutes", a single warehouse', () => {
  const ev = [{ id: 'EXP-001', text: 'Consolidated about 15 sources into SQL-backed Tableau and Power BI dashboards, replacing about 4 hours of manual daily reporting.' }];
  for (const s of ['When the sponsor asked for a new split, I re-ran the pipeline.', 'I coordinated a four-person team over 15 weeks.', 'The dashboards cut reporting from four hours to minutes.', 'I pulled the feeds into a single warehouse.']) {
    assert.equal(validateAnswer({ answer: `SAY: ${s}`, evidence: ev, kind: 'behavioral' }).ok, false, s);
  }
  assert.equal(validateAnswer({ answer: 'SAY: I consolidated about 15 sources into Tableau and Power BI dashboards, replacing about 4 hours of manual daily reporting.', evidence: ev, kind: 'behavioral' }).ok, true);
});test('[5] a personal or course project must be named as one, not passed off as paid work', () => {
  const { trimUnsupported } = require('../src/main/validate');
  const ev = [
    { id: 'PRJ-015', setting: 'personal project', text: 'Segmented customers of a UK online retailer across about 500K transactions with RFM features, delivering a 25% ROI lift.' },
    { id: 'EXP-001', text: 'Consolidated about 15 sources into Tableau and Power BI dashboards.' },
  ];
  const bad = 'SAY: My e-commerce analytics project segmented about 500K transactions and delivered a 25 percent ROI lift.';
  const v = validateAnswer({ answer: bad, evidence: ev, kind: 'experience' });
  assert.equal(v.ok, false);
  assert.equal(v.unsupported_claims[0].kind, 'setting');
  for (const ok of [
    'SAY: In a personal project on public retail data I segmented about 500K transactions, which showed a 25 percent ROI lift.',
    'SAY: On my own, with a public retail dataset, I segmented about 500K transactions.',
    'SAY: I consolidated about 15 sources into dashboards.', // a figure the paid work also has
  ]) assert.equal(validateAnswer({ answer: ok, evidence: ev, kind: 'experience' }).ok, true, ok);
  assert.equal(validateAnswer({ answer: 'SAY: Of course, my project segmented about 500K transactions.', evidence: ev, kind: 'experience' }).ok, false, '"of course" names no setting');
  // Trimming one sentence at a time keeps a figure whose setting another sentence already named.
  const framed = 'SAY: In a personal project I segmented about 500K transactions. It showed a 25 percent ROI lift. I used Snowflake there.';
  assert.equal(trimUnsupported(framed, { evidence: ev, kind: 'experience' }).text, 'SAY: In a personal project I segmented about 500K transactions. It showed a 25 percent ROI lift.');
});
test('[6] a closing line in the same mould as an earlier one is cut; a fresh one stays', () => {
  const { dropRepeatedClosing, splitDashChains } = require('../src/main/render');
  const prev = ['I built dashboards over about 15 sources. Both experiences show I can keep catalog-style data accurate, complete, and current — exactly what this role needs.'];
  // Only the dash tail repeats: the tail goes, the rest of the sentence stays.
  assert.equal(dropRepeatedClosing('SAY: I wrote SQL daily. I modeled 10 entity types. The schema kept every record consistent — exactly what your catalog needs.', prev),
    'SAY: I wrote SQL daily. I modeled 10 entity types. The schema kept every record consistent.');
  // The whole closing repeats the formula: it is dropped.
  assert.equal(dropRepeatedClosing('SAY: I segmented about 500K transactions. I tracked quality in MLflow. Both experiences show I can turn noisy data into clean records.', prev),
    'SAY: I segmented about 500K transactions. I tracked quality in MLflow.');
  // Too short to lose a sentence, a fresh closing, or no earlier answer: unchanged.
  for (const [t, p] of [['SAY: I built dashboards. That shows I can report clearly.', prev], ['SAY: I built dashboards. I used Tableau. Clean product data is what keeps a storefront trustworthy.', prev], ['SAY: A. B. That shows I can do it.', []]]) assert.equal(dropRepeatedClosing(t, p), t);
  // An interjection after a dash starts a new sentence instead of ", Yeah," mid-sentence.
  const yeah = 'SAY: At FabrikamTechserve I used SQL to pull and validate manufacturing data from about 15 sources before it reached the dashboards — yeah, I wrote the queries that fed Tableau and Power BI.';
  assert.equal(splitDashChains(yeah), 'SAY: At FabrikamTechserve I used SQL to pull and validate manufacturing data from about 15 sources before it reached the dashboards. Yeah, I wrote the queries that fed Tableau and Power BI.');
});
