'use strict';
// End-to-end (mocked, $0): copilot → thread → session → draft from real speech → approve → the next
// session's answer prompt carries the approved memory → forget removes it → other copilots never see it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVkinStore } = require('../src/main/vkin/store');
const { draftFromTranscript } = require('../src/main/memory-draft');
const { makeEngine } = require('./vkin-runtime-helpers');

function contextFor(store, copilotId, threadId) {
  const copilot = store.getCopilot(copilotId);
  return { copilot, threadMemory: store.approvedMemory({ copilotId, threadId }), profileFacts: [], todayContext: '' };
}

test('vkin flow: approved memory continues into the next meeting; drafts, forgotten items and other copilots never do', () => {
  const store = createVkinStore({ dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'vkin-flow-')) });
  const research = store.createCopilot({ name: 'Research supervisor', purpose: 'Weekly research meetings', memory_scope: 'thread' });
  const other = store.createCopilot({ name: 'Client project', purpose: 'Client calls' });
  const thread = store.createThread(research.id, 'Weekly sync');

  // Meeting 1: only real speech becomes drafts.
  const s1 = store.startSession(thread.id, { saveTranscript: false });
  const drafts = draftFromTranscript({ lines: [
    { speaker: 'them', text: "Let's go with county-level data for the first paper draft.", at: '2026-10-28T15:00:00Z' },
    { speaker: 'me', text: "I'll send the merged dataset by Friday afternoon.", at: '2026-10-28T15:02:00Z' },
  ] });
  store.addMemoryDraft(s1.id, drafts);
  store.endSession(s1.id);
  assert.equal(store.approvedMemory({ copilotId: research.id, threadId: thread.id }).length, 0, 'drafts are not retrievable');

  const all = store.listMemory({ threadId: thread.id });
  store.approveMemory(all.map((m) => m.id));

  // Meeting 2 on the same thread: the engine prompt carries the approved decision and commitment.
  const engine = makeEngine();
  engine.setVkin(contextFor(store, research.id, thread.id));
  const b = engine.build({ question: 'Remind me, which data level did we agree on for the first draft?', history: [] });
  const user = b.messages[1].content;
  assert.match(user, /county-level data/);
  assert.match(user, /merged dataset/);

  // Other copilot: nothing leaks.
  engine.setVkin(contextFor(store, other.id, null));
  const b2 = engine.build({ question: 'Which data level did we agree on?', history: [] });
  assert.doesNotMatch(b2.messages[1].content, /county-level|merged dataset/);

  // Forget: the fact never returns.
  const decision = store.listMemory({ threadId: thread.id }).find((m) => /county-level/.test(m.text));
  store.forgetMemory(decision.id);
  engine.setVkin(contextFor(store, research.id, thread.id));
  const b3 = engine.build({ question: 'Which data level did we agree on?', history: [] });
  assert.doesNotMatch(b3.messages[1].content, /county-level/);
  assert.ok(!JSON.stringify(store.exportAll()).includes('county-level'), 'forgotten text is cleared everywhere');
});

test('vkin flow: a greeting uses no memory even with a copilot selected', () => {
  const store = createVkinStore({ dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'vkin-flow-')) });
  const c = store.createCopilot({ name: 'Interviews' });
  const t = store.createThread(c.id, 'Acme');
  const s = store.startSession(t.id, {});
  store.addMemoryDraft(s.id, [{ kind: 'fact', text: 'They use Snowflake for warehousing.', origin: 'their_speech', source_at: null }]);
  store.approveMemory(store.listMemory({ threadId: t.id }).map((m) => m.id));
  const engine = makeEngine();
  engine.setVkin(contextFor(store, c.id, t.id));
  const b = engine.build({ question: 'Hey, how are you doing today?', history: [] });
  assert.doesNotMatch(b.messages[1].content, /Snowflake/);
});
