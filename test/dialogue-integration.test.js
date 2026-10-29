'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TurnManager } = require('../src/main/turns');
const { createDialogueState } = require('../src/main/brain/dialogue-state');

// Held fake LLM: each stream() is controllable (push tokens, finish) like test/turns.test.js.
function heldLlm() {
  const calls = [];
  return {
    calls,
    stream({ signal, onDelta }) {
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ aborted: true }));
        calls.push({ push: (t) => onDelta(t), finish: () => resolve({ text: '', model: 'fake' }) });
      });
    },
  };
}

function setup() {
  const events = [];
  const llm = heldLlm();
  const dialogueState = createDialogueState({ sessionId: 's', now: () => Date.now() });
  const tm = new TurnManager({
    sessionId: 's', config: { minWords: 6 }, llm, dialogueState,
    buildMessages: (q, h) => [{ role: 'user', content: q, history: h }],
    emit: (type, p) => events.push({ type, ...p }), now: () => Date.now(),
  });
  const them = (event, transcript, turnIndex = 0) => tm.onSttEvent({ channel: 'them', event, turnIndex, transcript });
  const flush = () => new Promise((r) => setImmediate(r));
  const of = (t) => events.filter((e) => e.type === t);
  return { tm, llm, dialogueState, them, flush, of };
}

const Q = 'Can you walk me through your capstone project?';

test('a delivered answer is recorded as displayed in the dialogue state', async () => {
  const { tm, llm, dialogueState, them, flush, of } = setup();
  them('EndOfTurn', Q, 0);
  await flush();
  const genId = of('answer:start')[0].genId;
  llm.calls[0].push('Yeah, so the capstone...');
  llm.calls[0].finish();
  await flush();
  const s = dialogueState.snapshot();
  assert.deepEqual(s.displayedAnswerIds, [genId]);
  assert.deepEqual(s.generatedButUndisplayedAnswerIds, []);
  assert.equal(dialogueState.answerState(genId), dialogueState.ANSWER_STATE.DISPLAYED);
  // displayed is not spoken
  assert.equal(s.lastUserSpokenTurnId, null);
  // markSpoken (e.g. the user copied it) moves it to spoken
  tm.markSpoken(genId);
  assert.equal(dialogueState.answerState(genId), dialogueState.ANSWER_STATE.SPOKEN);
});

test('interruption: the superseded generation is never counted as delivered', async () => {
  const { llm, dialogueState, them, flush, of } = setup();
  them('EndOfTurn', Q, 0);
  await flush();
  const first = of('answer:start')[0].genId;
  llm.calls[0].push('partial of the first answer');
  // a second question arrives before the first finishes -> first is superseded
  them('EndOfTurn', 'And what tools did you use for the dashboard?', 1);
  await flush();
  const second = of('answer:start')[1].genId;
  llm.calls[1].push('the second answer');
  llm.calls[1].finish();
  await flush();
  assert.equal(dialogueState.answerState(first), dialogueState.ANSWER_STATE.SUPERSEDED);
  assert.equal(dialogueState.answerState(second), dialogueState.ANSWER_STATE.DISPLAYED);
  const s = dialogueState.snapshot();
  assert.deepEqual(s.displayedAnswerIds, [second], 'only the delivered answer is displayed');
  assert.ok(!s.displayedAnswerIds.includes(first));
});

test('the dialogue state tracks the turn id of each generation', async () => {
  const { dialogueState, them, flush } = setup();
  them('EndOfTurn', Q, 0);
  await flush();
  const s = dialogueState.snapshot();
  assert.ok(s.recentTurnIds.length >= 1);
});

test('no dialogueState wired (default): the lifecycle still works', async () => {
  const events = [];
  const llm = heldLlm();
  const tm = new TurnManager({
    sessionId: 's', config: { minWords: 6 }, llm,
    buildMessages: (q) => [{ role: 'user', content: q }],
    emit: (type, p) => events.push({ type, ...p }), now: () => Date.now(),
  });
  tm.onSttEvent({ channel: 'them', event: 'EndOfTurn', turnIndex: 0, transcript: Q });
  await new Promise((r) => setImmediate(r));
  llm.calls[0].push('answer'); llm.calls[0].finish();
  await new Promise((r) => setImmediate(r));
  assert.equal(events.filter((e) => e.type === 'answer:done').length, 1);
  assert.equal(tm.markSpoken('whatever'), false, 'markSpoken is a safe no-op without a dialogue state');
});