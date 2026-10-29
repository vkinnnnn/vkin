const test = require('node:test');
const assert = require('node:assert');
const { TurnManager, assessUtterance, jaccard } = require('../src/main/turns');

// Controllable fake LLM: each stream() call is held until the test pushes tokens / finishes.
function fakeLlm() {
  const calls = [];
  return {
    calls,
    stream({ messages, signal, onDelta }) {
      return new Promise((resolve) => {
        const call = {
          messages, signal,
          push: (t) => onDelta(t),
          finish: () => resolve({ text: '', model: 'fake', aborted: signal.aborted }),
        };
        signal.addEventListener('abort', () => resolve({ aborted: true }));
        calls.push(call);
      });
    },
  };
}

function setup() {
  const events = [];
  const llm = fakeLlm();
  let t = 1000;
  const tm = new TurnManager({
    sessionId: 's1',
    config: { minWords: 6 },
    llm,
    buildMessages: (q, h) => [{ role: 'user', content: q, history: h }],
    emit: (type, payload) => events.push({ type, ...payload }),
    now: () => (t += 10),
  });
  const them = (event, transcript, turnIndex = 0) => tm.onSttEvent({ channel: 'them', event, turnIndex, transcript });
  const me = (event, transcript, turnIndex = 0) => tm.onSttEvent({ channel: 'me', event, turnIndex, transcript });
  const flush = () => new Promise((r) => setImmediate(r));
  const of = (type) => events.filter((e) => e.type === type);
  return { tm, llm, events, them, me, flush, of };
}

const Q = 'Can you walk me through your capstone project?';

test('assessUtterance gates small talk and accepts questions', () => {
  assert.equal(assessUtterance('Okay great').eligible, false);
  assert.equal(assessUtterance('What do you do?').eligible, true);
  assert.equal(assessUtterance('So we have a team of about twenty people here').eligible, true);
  assert.equal(assessUtterance('Yeah that makes sense').eligible, false);
});

test('eager -> final with same text promotes the speculative answer (no regeneration)', async () => {
  const { llm, them, flush, of } = setup();
  them('StartOfTurn', 'Can you');
  them('EagerEndOfTurn', Q);
  await flush();
  assert.equal(of('answer:start').length, 1);
  assert.equal(of('answer:start')[0].kind, 'speculative');
  llm.calls[0].push('Yeah, so ');
  them('EndOfTurn', Q);
  await flush();
  assert.equal(of('answer:promote').length, 1);
  assert.equal(of('answer:start').length, 1, 'no second generation');
  llm.calls[0].push('basically...');
  llm.calls[0].finish();
  await flush();
  assert.equal(of('answer:delta').length, 2);
  assert.equal(of('answer:done').length, 1);
});

test('TurnResumed invalidates speculative answer and late tokens never surface', async () => {
  const { llm, them, flush, of } = setup();
  them('EagerEndOfTurn', 'Can you walk me through your capstone');
  await flush();
  const genId = of('answer:start')[0].genId;
  llm.calls[0].push('first ');
  them('TurnResumed', 'Can you walk me through your capstone');
  const inv = of('answer:invalidate');
  assert.equal(inv.length, 1);
  assert.equal(inv[0].genId, genId);
  llm.calls[0].push('STALE');
  await flush();
  assert.ok(!of('answer:delta').some((d) => d.text === 'STALE'), 'stale token leaked');
  // Turn finishes with different text -> confirmed generation with revision 1
  them('EndOfTurn', `${Q} and what was your role?`);
  await flush();
  const starts = of('answer:start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1].kind, 'confirmed');
  assert.equal(starts[1].revision, 1);
  assert.equal(of('answer:promote').length, 0);
});

test('final text differs from eager text -> speculative invalidated, confirmed regenerated', async () => {
  const { them, flush, of } = setup();
  them('EagerEndOfTurn', 'Tell me about your work at the company');
  await flush();
  them('EndOfTurn', 'Tell me about your work at the company and the tools you used');
  await flush();
  assert.equal(of('answer:invalidate').length, 1);
  assert.equal(of('answer:start').length, 2);
  assert.equal(of('answer:start')[1].kind, 'confirmed');
});

test('two quick turns: second question supersedes first answer', async () => {
  const { llm, them, flush, of } = setup();
  them('EndOfTurn', Q, 0);
  await flush();
  llm.calls[0].push('a');
  them('EndOfTurn', 'And what tools did you use for the dashboard?', 1);
  await flush();
  llm.calls[0].push('LATE');
  await flush();
  assert.equal(of('answer:start').length, 2);
  assert.equal(of('answer:invalidate').length, 1, 'unfinished first answer invalidated');
  assert.ok(!of('answer:delta').some((d) => d.text === 'LATE'));
});

test('ME channel never triggers answers; echo of THEM is dropped from history', async () => {
  const { tm, them, me, flush, of } = setup();
  them('EndOfTurn', Q, 0);
  await flush();
  me('EndOfTurn', 'can you walk me through your capstone project', 0);
  me('EndOfTurn', 'Sure so my capstone was with Contoso', 1);
  await flush();
  assert.equal(of('answer:start').length, 1);
  const speakers = tm.history.map((h) => h.speaker);
  assert.deepEqual(speakers, ['THEM', 'ME']);
  assert.ok(of('transcript').some((e) => e.channel === 'me' && e.echo === true));
});

test('manual answer uses live THEM text, else last finished THEM turn', async () => {
  const { tm, them, flush, of } = setup();
  assert.equal(tm.manualAnswer(), null);
  them('EndOfTurn', 'Hi there nice to meet you', 0);
  them('Update', 'So what are you', 1);
  tm.manualAnswer();
  await flush();
  assert.equal(of('answer:start').at(-1).question, 'So what are you');
  assert.equal(of('answer:start').at(-1).kind, 'manual');
});

test('history passed to the prompt excludes the current question', async () => {
  const { llm, them, flush } = setup();
  them('EndOfTurn', 'Hi Avery thanks for joining the call today', 0);
  await flush();
  them('EndOfTurn', Q, 1);
  await flush();
  const last = llm.calls.at(-1).messages[0];
  assert.equal(last.content, Q);
  assert.ok(!last.history.some((h) => h.text === Q));
  assert.ok(last.history.some((h) => h.text.startsWith('Hi Avery')));
});

test('jaccard sanity', () => {
  assert.ok(jaccard('a b c', 'a b c') === 1);
  assert.ok(jaccard('a b c', 'x y z') === 0);
});

test('a speculative answer that errored is not promoted; final EOT regenerates', async () => {
  const events = [];
  let n = 0;
  const llm = { stream: () => (n++ === 0 ? Promise.reject(new Error('boom')) : new Promise(() => {})) };
  const tm = new TurnManager({ sessionId: 's', llm, buildMessages: () => [], emit: (type, p) => events.push({ type, ...p }), now: () => Date.now() });
  tm.onSttEvent({ channel: 'them', event: 'EagerEndOfTurn', turnIndex: 0, transcript: Q });
  await new Promise((r) => setImmediate(r));
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: Q });
  await new Promise((r) => setImmediate(r));
  assert.equal(events.filter((e) => e.type === 'answer:promote').length, 0);
  assert.equal(events.filter((e) => e.type === 'answer:start').length, 2);
});

test('new epoch after reconnect: reused Flux turn_index does not collide', async () => {
  const { tm, them, flush, of } = setup();
  tm.newEpoch('them');
  them('EndOfTurn', Q, 0);
  await flush();
  tm.newEpoch('them');
  them('EndOfTurn', 'And what tools did you use for the dashboard?', 0);
  await flush();
  const starts = of('answer:start');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].turnId, starts[1].turnId);
  assert.ok(tm.history.some((h) => h.text === Q), 'first question kept in history');
});

test('statements are not auto-answered, so they do not replace the answer being read', async () => {
  const { them, flush, of } = setup();
  them('EndOfTurn', 'Got it. Next question. Tell me about a time you explained something complex.', 0);
  await flush();
  them('EndOfTurn', "Take your time and let me know when you're ready with your answer.", 1);
  await flush();
  assert.equal(of('answer:start').length, 1);
  assert.equal(of('answer:invalidate').length, 0);
});

test('chat refines the last confirmed answer and is labelled as a private request', async () => {
  const { tm, llm, them, flush, of } = setup();
  them('EndOfTurn', Q, 0);
  await flush();
  llm.calls[0].push('SAY: long answer');
  llm.calls[0].finish();
  await flush();
  tm.chat({ text: 'Shorter' });
  await flush();
  const start = of('answer:start').at(-1);
  assert.equal(start.kind, 'manual');
  assert.equal(start.request, 'Shorter');
  assert.equal(start.question, Q);
  const built = llm.calls.at(-1).messages[0];
  assert.equal(built.content, Q);
});

test('chat with no prior question still answers the typed request', async () => {
  const events = [];
  const seen = [];
  const tm = new TurnManager({ sessionId: 's', llm: { stream: () => new Promise(() => {}) }, buildMessages: (q, h, extra) => { seen.push({ q, extra }); return []; }, emit: (type, p) => events.push({ type, ...p }), now: () => Date.now() });
  assert.equal(tm.chat({ text: '   ' }), null);
  tm.chat({ text: 'What salary range should I mention?' });
  await new Promise((r) => setImmediate(r));
  assert.equal(seen[0].q, '');
  assert.equal(seen[0].extra.request, 'What salary range should I mention?');
});

test('$40 mode: EagerEndOfTurn starts no billable call; EndOfTurn starts one confirmed answer with a text hash', async () => {
  const events = [];
  const calls = [];
  const tm = new TurnManager({
    sessionId: 's', config: { speculativeLlm: false },
    llm: { stream: (req) => { calls.push(req); return new Promise(() => {}); } },
    buildMessages: () => [], emit: (type, p) => events.push({ type, ...p }), now: () => Date.now(),
  });
  tm.onSttEvent({ channel: 'them', event: 'EagerEndOfTurn', turnIndex: 0, transcript: Q });
  tm.onSttEvent({ channel: 'them', event: 'TurnResumed', turnIndex: 0, transcript: Q });
  tm.onSttEvent({ channel: 'them', event: 'EagerEndOfTurn', turnIndex: 0, transcript: Q });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 0, 'no call on speculative speech');
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: Q });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  const start = events.find((e) => e.type === 'answer:start');
  assert.equal(start.kind, 'confirmed');
  assert.match(start.textHash, /^[0-9a-f]{16}$/);
  assert.equal(calls[0].turnId, start.genId, 'call is cancellable by generation id');
});

function engineSetup({ answers, validate }) {
  const events = [];
  const calls = [];
  const tel = [];
  const tm = new TurnManager({
    sessionId: 's', config: { speculativeLlm: false },
    llm: { stream: (req) => { calls.push(req); const text = answers[Math.min(calls.length - 1, answers.length - 1)]; req.onDelta(text); return Promise.resolve({ text, model: 'm', route: req.route, usage: { prompt_tokens: 10, completion_tokens: 5 }, finalUsd: 0.0001 }); } },
    buildMessages: (q, h, extra) => ({ messages: [{ role: 'user', content: q, extra }], meta: { understanding: { question_type: 'behavioral', expected_answer_shape: 'star' }, route: 'default', maxOutputTokens: 450, storyId: 'STORY-1', sourceIds: ['A'], promptTokensEst: 100, validation: {} } }),
    validate,
    trim: (text) => text.replace(/ 35%/, ''),
    telemetry: { record: (r) => tel.push(r) },
    emit: (type, p) => events.push({ type, ...p }), now: () => Date.now(),
  });
  return { tm, events, calls, tel, of: (t) => events.filter((e) => e.type === t) };
}

test('answer engine: maxOutputTokens and route from meta reach the LLM; validated answers are marked checked', async () => {
  const { tm, calls, of, tel } = engineSetup({ answers: ['SAY: fine'], validate: () => ({ ok: true, unsupported_claims: [], warnings: [], confidence: 1 }) });
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: Q });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls[0].maxOutputTokens, 450);
  assert.equal(calls[0].route, 'default');
  assert.equal(of('answer:validated')[0].action, 'checked');
  assert.equal(of('answer:done').length, 1);
  assert.equal(tel[0].validated, true);
  assert.equal(tel[0].storyId, 'STORY-1');
  assert.ok(!JSON.stringify(tel).includes('fine'), 'no answer text in telemetry');
});

test('unsupported claim: regenerate once (flawed draft never done), then pass', async () => {
  let n = 0;
  const { tm, calls, of } = engineSetup({
    answers: ['SAY: I cut downtime 35%', 'SAY: I cut downtime 28%'],
    validate: () => (n++ === 0 ? { ok: false, unsupported_claims: [{ claim: '35%', kind: 'number', reason: 'x' }], warnings: [], confidence: 0.75 } : { ok: true, unsupported_claims: [], warnings: [], confidence: 1 }),
  });
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: Q });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 2);
  assert.ok(calls[1].messages[0].extra.regenerate, 'second call carries the regenerate instruction');
  const starts = of('answer:start');
  assert.equal(starts[1].revisionOf, starts[0].genId);
  assert.equal(of('answer:validated')[0].action, 'regenerating');
  assert.equal(of('answer:done').length, 1, 'only the clean answer is done');
  assert.equal(of('answer:done')[0].genId, starts[1].genId);
});

test('second validation failure trims instead of regenerating again', async () => {
  const { tm, calls, of } = engineSetup({
    answers: ['SAY: I cut downtime 35%'],
    validate: () => ({ ok: false, unsupported_claims: [{ claim: '35%', kind: 'number', reason: 'x' }], warnings: [], confidence: 0.75 }),
  });
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: Q });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 2, 'exactly one regeneration');
  const rep = of('answer:replace');
  assert.equal(rep.length, 1);
  assert.ok(!rep[0].text.includes('35%'));
  assert.equal(of('answer:validated').at(-1).action, 'trimmed');
  assert.equal(of('answer:done').length, 1);
});

test('[M3] a failed speculative draft regenerates as speculative, so EndOfTurn promotes it (no third call)', async () => {
  const events = [];
  const calls = [];
  let n = 0;
  const tm = new TurnManager({
    sessionId: 's', config: { speculativeLlm: true },
    llm: { stream: (req) => { calls.push(req); req.onDelta('SAY: x'); return Promise.resolve({ text: 'SAY: x' }); } },
    buildMessages: () => ({ messages: [], meta: { understanding: { question_type: 'factual', expected_answer_shape: 'direct' }, route: 'default', maxOutputTokens: 200, sourceIds: [], promptTokensEst: 1, validation: {} } }),
    validate: () => (n++ === 0 ? { ok: false, unsupported_claims: [{ claim: '9', kind: 'number' }], warnings: [], confidence: 0.75 } : { ok: true, unsupported_claims: [], warnings: [], confidence: 1 }),
    trim: (t) => t, emit: (type, p) => events.push({ type, ...p }), now: () => Date.now(),
  });
  tm.onSttEvent({ channel: 'them', event: 'EagerEndOfTurn', turnIndex: 0, transcript: Q });
  await new Promise((r) => setTimeout(r, 10));
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: Q });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 2, 'draft + one regeneration, no extra confirmed answer');
  assert.equal(events.filter((e) => e.type === 'answer:start')[1].kind, 'speculative');
  assert.equal(events.filter((e) => e.type === 'answer:promote').length, 1);
});

test('[m1] if the regeneration fails, the trimmed first draft is shown instead of an error', async () => {
  const events = [];
  let n = 0;
  const tm = new TurnManager({
    sessionId: 's', config: { speculativeLlm: false },
    llm: { stream: (req) => { n += 1; if (n === 1) { req.onDelta('SAY: I cut downtime 35% at Contoso.'); return Promise.resolve({}); } return Promise.reject(Object.assign(new Error('blocked'), { code: 'BUDGET_HARD_STOP' })); } },
    buildMessages: () => ({ messages: [], meta: { understanding: { question_type: 'factual', expected_answer_shape: 'direct' }, route: 'default', maxOutputTokens: 200, sourceIds: [], promptTokensEst: 1, validation: {} } }),
    validate: () => ({ ok: false, unsupported_claims: [{ claim: '35%', kind: 'number' }], warnings: [], confidence: 0.75 }),
    trim: (t) => t.replace(' 35%', ''), emit: (type, p) => events.push({ type, ...p }), now: () => Date.now(),
  });
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: Q });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(events.filter((e) => e.type === 'answer:error').length, 0);
  assert.ok(!events.find((e) => e.type === 'answer:replace').text.includes('35%'));
  assert.equal(events.filter((e) => e.type === 'answer:done').length, 1);
});

test('[re-review] a speculative draft counts as told only when promoted', async () => {
  const mk = () => {
    const commits = [];
    const tm = new TurnManager({
      sessionId: 's', config: { speculativeLlm: true },
      llm: { stream: (req) => { req.onDelta('SAY: x'); return Promise.resolve({}); } },
      buildMessages: () => ({ messages: [], meta: { understanding: { question_type: 'behavioral', expected_answer_shape: 'star' }, route: 'default', maxOutputTokens: 450, storyId: 'S1', sourceIds: [], promptTokensEst: 1, validation: {}, selection: { storyId: 'S1', itemIds: [] } } }),
      validate: () => ({ ok: true, unsupported_claims: [], warnings: [], confidence: 1 }),
      onAnswerDone: (m) => commits.push(m.storyId), emit: () => {}, now: () => Date.now(),
    });
    return { tm, commits };
  };
  const a = mk();
  a.tm.onSttEvent({ channel: 'them', event: 'EagerEndOfTurn', turnIndex: 0, transcript: Q });
  await new Promise((r) => setTimeout(r, 10));
  a.tm.onSttEvent({ channel: 'them', event: 'TurnResumed', turnIndex: 0, transcript: Q });
  assert.deepEqual(a.commits, [], 'invalidated draft is not told');
  const b = mk();
  b.tm.onSttEvent({ channel: 'them', event: 'EagerEndOfTurn', turnIndex: 0, transcript: Q });
  await new Promise((r) => setTimeout(r, 10));
  b.tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: Q });
  assert.deepEqual(b.commits, ['S1'], 'promoted draft is told once');
});

// ---------- stable mode, re-asks and paused questions ----------

function stableSetup({ answers, validate, trim = (t) => t.replace(/ I cut downtime 35%\./, ''), config = {} }) {
  const events = [];
  const calls = [];
  let clock = 1000;
  const tm = new TurnManager({
    sessionId: 's', config: { speculativeLlm: false, ...config }, stableRewrite: true,
    llm: { stream: (req) => { calls.push(req); const text = answers[Math.min(calls.length - 1, answers.length - 1)]; req.onDelta(text); return Promise.resolve({ text, model: 'm', usage: {} }); } },
    buildMessages: (q, h, extra) => ({ messages: [{ role: 'user', content: q, extra }], meta: { understanding: {}, route: 'default', maxOutputTokens: 300, sourceIds: [], validation: {} } }),
    validate, trim, emit: (type, p) => events.push({ type, ...p }), now: () => (clock += 100),
  });
  const advance = (ms) => { clock += ms; };
  return { tm, events, calls, advance, of: (t) => events.filter((e) => e.type === t), wait: () => new Promise((r) => setTimeout(r, 15)) };
}
const LONG = 'SAY: ' + 'I built dashboards over about 15 data sources at FabrikamTechserve and removed four hours of daily reporting. '.repeat(4) + 'I cut downtime 35%.';
const bad = { ok: false, unsupported_claims: [{ claim: '35%', kind: 'number', reason: 'x' }], warnings: [], confidence: 0.75 };
const good = { ok: true, unsupported_claims: [], warnings: [], confidence: 1 };

test('stable mode: a mostly-supported draft is trimmed once, with no rewrite and no second stream', async () => {
  const { tm, calls, of, wait } = stableSetup({ answers: [LONG], validate: (t) => (/35%/.test(t) ? bad : good) });
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: Q });
  await wait();
  assert.equal(calls.length, 1, 'no second LLM call');
  assert.equal(of('answer:start').length, 1, 'one card only');
  assert.equal(of('answer:replace').length, 1, 'the text changes exactly once');
  assert.doesNotMatch(of('answer:replace')[0].text, /35%/);
  assert.equal(of('answer:validated').at(-1).action, 'trimmed');
  assert.equal(of('answer:done').length, 1);
});

test('stable mode: when too much is cut, the rewrite runs hidden and replaces the card once', async () => {
  const { tm, calls, of, wait } = stableSetup({
    answers: ['SAY: I cut downtime 35%.', LONG.replace(' I cut downtime 35%.', '')],
    validate: (t) => (/35%/.test(t) ? bad : good), trim: (t) => t.replace(/I cut downtime 35%\./, '').trim() || 'SAY:',
  });
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: Q });
  await wait();
  assert.equal(calls.length, 2, 'one hidden rewrite');
  assert.ok(calls[1].messages[0].extra.regenerate, 'the rewrite carries the regenerate instruction');
  assert.equal(of('answer:start').length, 1, 'no new card for the rewrite');
  assert.equal(of('answer:delta').length, 1, 'the rewrite is not streamed to the screen');
  assert.deepEqual(of('answer:validated').map((e) => e.action), ['improving', 'rewritten']);
  assert.match(of('answer:replace').at(-1).text, /FabrikamTechserve/);
  assert.equal(of('answer:done').length, 1);
});

test('"answer that again" re-answers the previous question with the earlier answer and the complaint', async () => {
  const { tm, calls, of, wait } = stableSetup({ answers: ['SAY: first answer', 'SAY: better answer'], validate: () => good });
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: 'What dataset did you use for the no-show project?' });
  await wait();
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 1, transcript: "Hmm, I don't think you answered my question. Can you answer that again?" });
  await wait();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].messages[0].content, 'What dataset did you use for the no-show project?', 'the original question is answered again');
  assert.match(calls[1].messages[0].extra.reask, /answer that again/);
  assert.equal(calls[1].messages[0].extra.previousAnswer, 'SAY: first answer');
  assert.equal(of('answer:done').length, 2);
});

test('a question split by a pause is merged; an acknowledgement right after a question is not', async () => {
  const { tm, calls, wait } = stableSetup({ answers: ['SAY: a', 'SAY: b'], validate: () => good });
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: 'Can you tell me about the data you used' });
  await wait();
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 1, transcript: 'in the no-show project, where it came from?' });
  await wait();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].messages[0].content, 'Can you tell me about the data you used in the no-show project, where it came from?');
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 2, transcript: 'Okay, great, thanks.' });
  await wait();
  assert.equal(calls.length, 2, 'acknowledgement does not restart the answer');
});

test('a fragment long after the question is not merged', async () => {
  const { tm, calls, advance, wait } = stableSetup({ answers: ['SAY: a'], validate: () => good });
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: 'Can you tell me about your capstone?' });
  await wait();
  advance(60000);
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 1, transcript: 'and the team was four people' });
  await wait();
  assert.equal(calls.length, 1);
});

test('memory: each answer carries the earlier exchanges; a typed question is answered fresh; chips still refine', async () => {
  const { tm, calls, wait } = stableSetup({ answers: ['SAY: I built a no-show model on 180,000 appointments.', 'SAY: On the features, I started from attendance history.', 'SAY: shorter'], validate: () => good });
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: 'Tell me in detail about the no-show project.' });
  await wait();
  tm.chat({ text: 'how did you figure out the features and how did the rate fall from 22 to 14?' });
  await wait();
  const second = calls[1].messages[0];
  assert.equal(second.content, 'how did you figure out the features and how did the rate fall from 22 to 14?', 'typed question is the question, not a rewrite request');
  assert.equal(second.extra.request, undefined);
  assert.deepEqual(second.extra.conversation.map((c) => c.question), ['Tell me in detail about the no-show project.']);
  assert.match(second.extra.conversation[0].answer, /180,000/);
  tm.chat({ text: 'Shorter' });
  await wait();
  assert.equal(calls[2].messages[0].extra.request, 'Shorter', 'an edit chip still refines the last answer');
  assert.equal(calls[2].messages[0].extra.conversation.length, 2);
});

test('stale guard on: answer events carry a monotonic seq across generations', async () => {
  const events = [];
  const tm = new TurnManager({
    sessionId: 's', config: { minWords: 6 }, staleTurnGuard: true,
    llm: { stream: (req) => { req.onDelta('x'); return Promise.resolve({ text: 'x', model: 'fake' }); } },
    buildMessages: (q, h) => [{ role: 'user', content: q, history: h }],
    emit: (type, p) => events.push({ type, ...p }),
    now: () => Date.now(),
  });
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: Q });
  await new Promise((r) => setImmediate(r));
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 1, transcript: 'And what tools did you use for the dashboard?' });
  await new Promise((r) => setImmediate(r));
  const answerEvents = events.filter((e) => e.type.startsWith('answer:'));
  assert.ok(answerEvents.every((e) => typeof e.seq === 'number'), 'every answer event carries a seq');
  const starts = events.filter((e) => e.type === 'answer:start');
  assert.equal(starts.length, 2);
  assert.ok(starts[1].seq > starts[0].seq, 'the later generation has a higher seq');
  // all events of the first generation share its seq
  const firstSeq = starts[0].seq;
  assert.ok(events.filter((e) => e.genId === starts[0].genId).every((e) => e.seq === firstSeq));
});

test('stale guard off by default: answer events carry no seq', async () => {
  const { them, flush, of } = setup();
  them('EndOfTurn', Q, 0);
  await flush();
  assert.equal(of('answer:start')[0].seq, undefined);
});

test('newEpoch on THEM resets lastQuestion so a post-reconnect fragment cannot merge', () => {
  const { tm } = setup();
  tm.lastQuestion = 'Tell me about your capstone';
  tm.lastQuestionAt = tm.deps.now();
  tm.newEpoch('them');
  assert.equal(tm.lastQuestion, null);
  assert.equal(tm.lastQuestionAt, 0);
});

test('manual mode: a complete question is not answered until requested (PRD matrix "Manual mode")', async () => {
  const { tm, llm, them, flush, of } = setup();
  tm.setAutoAnswer(false);
  them('StartOfTurn', 'Can you');
  them('EagerEndOfTurn', Q);
  them('EndOfTurn', Q);
  await flush();
  assert.equal(of('answer:start').length, 0, 'no generation in manual mode');
  assert.equal(llm.calls.length, 0, 'no LLM request');
  assert.equal(of('manualPending').length, 1);
  assert.equal(of('manualPending')[0].question, Q);
  tm.manualAnswer();
  await flush();
  assert.equal(of('answer:start').length, 1);
  assert.equal(of('answer:start')[0].kind, 'manual');
  assert.equal(of('answer:start')[0].question, Q);
});

test('manual mode: statements raise no pending question; back to auto answers again', async () => {
  const { tm, them, flush, of } = setup();
  tm.setAutoAnswer(false);
  them('EndOfTurn', 'Okay great, take your time with that one.', 0);
  await flush();
  assert.equal(of('manualPending').length, 0);
  tm.setAutoAnswer(true);
  them('EndOfTurn', Q, 1);
  await flush();
  assert.equal(of('answer:start').length, 1);
  assert.equal(of('answer:start')[0].kind, 'confirmed');
});

test('clear topic: a continuation fragment no longer merges into the previous question', async () => {
  const { tm, them, flush, of } = setup();
  them('EndOfTurn', Q, 0);
  await flush();
  tm.clearTopic();
  them('EndOfTurn', 'and in the second phase of it too?', 1);
  await flush();
  const starts = of('answer:start');
  assert.ok(!starts.some((s) => s.question.includes(Q) && s.question.includes('second phase')), 'not merged after clearTopic');
});

test('Phase 4 partial prep: EagerEndOfTurn builds locally (no LLM call); EndOfTurn with the same text reuses it', async () => {
  const builds = [];
  const events = [];
  const llm = fakeLlm();
  let t = 1000;
  const tm = new TurnManager({
    sessionId: 's1', config: { minWords: 6, speculativeLlm: false }, llm, partialPrep: true,
    buildMessages: (q, h, extra) => { builds.push({ q, prepare: Boolean(extra && extra.prepare) }); return [{ role: 'user', content: q }]; },
    emit: (type, payload) => events.push({ type, ...payload }),
    now: () => (t += 10),
  });
  const them = (event, transcript, turnIndex = 0) => tm.onSttEvent({ channel: 'them', event, turnIndex, transcript });
  const flush = () => new Promise((r) => setImmediate(r));
  them('StartOfTurn', 'Can you');
  them('EagerEndOfTurn', Q);
  await flush();
  assert.equal(builds.length, 1);
  assert.equal(builds[0].prepare, true);
  assert.equal(llm.calls.length, 0, 'no paid call on the partial');
  them('EndOfTurn', Q);
  await flush();
  assert.equal(builds.length, 1, 'confirmed answer reused the prepared build');
  assert.equal(llm.calls.length, 1);
  llm.calls[0].push('Sure.');
  llm.calls[0].finish();
  await flush();
  const done = events.find((e) => e.type === 'answer:done');
  assert.equal(done.timings.prepHit, true);
  assert.ok(Number.isFinite(done.timings.buildMs));
  assert.ok(Number.isFinite(done.timings.streamMs));
});

test('Phase 4 partial prep: a revision (TurnResumed) or changed final text drops the prepared build', async () => {
  const builds = [];
  const llm = fakeLlm();
  let t = 1000;
  const tm = new TurnManager({
    sessionId: 's1', config: { minWords: 6, speculativeLlm: false }, llm, partialPrep: true,
    buildMessages: (q, h, extra) => { builds.push({ q, prepare: Boolean(extra && extra.prepare) }); return [{ role: 'user', content: q }]; },
    emit: () => {}, now: () => (t += 10),
  });
  const them = (event, transcript, turnIndex = 0) => tm.onSttEvent({ channel: 'them', event, turnIndex, transcript });
  const flush = () => new Promise((r) => setImmediate(r));
  them('EagerEndOfTurn', 'Can you walk me through your project?');
  them('TurnResumed', 'Can you walk me through your project and the data');
  them('EndOfTurn', 'Can you walk me through your project and the data you used?');
  await flush();
  assert.deepEqual(builds.map((b) => b.prepare), [true, false], 'rebuilt for the final text');
  assert.equal(builds[1].q, 'Can you walk me through your project and the data you used?');
});

test('Phase 4 partial prep off (default): EagerEndOfTurn does not build', async () => {
  const { tm, them, flush } = setup();
  let built = 0;
  tm.answers.deps.buildMessages = () => { built += 1; return []; };
  tm.cfg.speculativeLlm = false;
  them('EagerEndOfTurn', Q);
  await flush();
  assert.equal(built, 0);
});
