'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { composeNotes } = require('../src/main/meeting-notes');
const { createVkinStore } = require('../src/main/vkin/store');
const { createVkinController } = require('../src/main/vkin-controller');

test('notes: only approved items, grouped, with who said it; nothing approved gives no notes', () => {
  const items = [
    { kind: 'decision', text: 'Use county-level data.', origin: 'their_speech', status: 'approved' },
    { kind: 'commitment', text: "I'll send the dataset Friday.", origin: 'my_speech', status: 'approved', due_at: '2026-10-31T12:00:00Z' },
    { kind: 'action_item', text: 'Draft the methods section.', origin: 'their_speech', status: 'draft' },
    { kind: 'fact', text: '', origin: 'note', status: 'approved' },
  ];
  const n = composeNotes({ startedAt: '2026-10-29T15:00:00Z', items });
  assert.match(n, /Decisions:\n- Use county-level data\. \(they said\)/);
  assert.match(n, /My commitments:\n- I'll send the dataset Friday\. \(I said, due /);
  assert.doesNotMatch(n, /methods section/, 'drafts are never in notes');
  assert.equal(composeNotes({ items: [items[2]] }), '');
});

test('notes: the controller saves notes as the meeting summary and refuses with nothing approved', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vkin-notes-'));
  const history = [];
  const ctl = createVkinController({ dataRoot, createStore: createVkinStore, getEngine: () => null, getHistory: () => history, isRunning: () => false, now: () => 1000 });
  const c = await ctl.handle('vkin.copilots.create', { fields: { name: 'C' } });
  const t = await ctl.handle('vkin.threads.create', { copilotId: c.id, title: 'T' });
  await ctl.handle('vkin.select', { copilotId: c.id, threadId: t.id });
  ctl.startSession();
  history.push({ speaker: 'ME', text: "I'll share the revised slides with the team tomorrow.", endedAt: 2000 });
  ctl.finishSession();
  const [s] = await ctl.handle('vkin.sessions.list', { threadId: t.id });
  await assert.rejects(ctl.handle('vkin.notes.compose', { threadId: t.id, sessionId: s.id }), /approve some memory/);
  const mem = await ctl.handle('vkin.memory.list', { threadId: t.id });
  await ctl.handle('vkin.memory.approve', { ids: mem.map((m) => m.id) });
  const saved = await ctl.handle('vkin.notes.compose', { threadId: t.id, sessionId: s.id });
  assert.match(saved.summary, /revised slides/);
});
