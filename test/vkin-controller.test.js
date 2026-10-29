'use strict';
// Desktop Vkin controller (review findings 3, 4, 5, 7): sessions stay with the copilot they started under,
// sync results reach the answer context at once, and accounts never switch under an open meeting.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVkinStore } = require('../src/main/vkin/store');
const { createVkinController } = require('../src/main/vkin-controller');

function setup({ auth = null, sync = null } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vkin-ctl-'));
  const engine = { ctx: undefined, setVkin(c) { this.ctx = c; } };
  const history = [];
  const state = { running: false, t: 1000 };
  const ctl = createVkinController({
    dataRoot, createStore: createVkinStore, createSync: sync, getAuth: () => auth, cloudReason: 'not configured',
    getEngine: () => engine, getHistory: () => history, isRunning: () => state.running, now: () => state.t,
  });
  return { ctl, engine, history, state, dataRoot };
}

test('controller: a paused meeting is closed under its own copilot before switching (finding 5)', async () => {
  const { ctl, history, state } = setup();
  const a = await ctl.handle('vkin.copilots.create', { fields: { name: 'A' } });
  const b = await ctl.handle('vkin.copilots.create', { fields: { name: 'B' } });
  const threadA = await ctl.handle('vkin.threads.create', { copilotId: a.id, title: 'A thread' });
  await ctl.handle('vkin.select', { copilotId: a.id, threadId: threadA.id });
  ctl.startSession();
  history.push({ speaker: 'ME', text: "I'll send the updated budget sheet tomorrow.", endedAt: state.t + 10 });
  // Paused (not running), then the user switches to B: the open session must end under A.
  await ctl.handle('vkin.select', { copilotId: b.id, threadId: null });
  assert.equal(ctl.hasOpenSession(), false);
  const aMem = await ctl.handle('vkin.memory.list', { threadId: threadA.id });
  assert.equal(aMem.length, 1, "A's thread got its own meeting's draft");
  assert.equal((await ctl.handle('vkin.memory.list', { copilotId: b.id })).length, 0, 'nothing leaked into B');
});

test('controller: deleting the selected copilot (locally or via sync) clears it instead of breaking start (review 2, finding 1)', async () => {
  const { ctl, engine } = setup();
  const a = await ctl.handle('vkin.copilots.create', { fields: { name: 'A', instructions: 'Be brief.', keyterms: ['Zeta'] } });
  await ctl.handle('vkin.select', { copilotId: a.id, threadId: null });
  assert.deepEqual(ctl.keyterms(), ['Zeta']);
  await ctl.handle('vkin.copilots.delete', { id: a.id });
  assert.equal(engine.ctx, null, 'engine no longer answers as the deleted copilot');
  assert.deepEqual(await ctl.handle('vkin.active'), { copilot: null, thread: null });
  assert.deepEqual(ctl.keyterms(), []);
  assert.equal(ctl.startSession(), null, 'start still works (general mode)');
});

test('controller: no meeting can start during sign-in or sign-out; sync refresh runs even when a pass fails (review 2, findings 2-3)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const auth = { getClient: () => ({}), userId: async () => null, status: async () => ({ signedIn: false }), verify: async () => { await gate; return { userId: '33333333-3333-4333-8333-333333333333' }; } };
  const failing = () => ({ syncNow: async () => { throw new Error('E_NOT_SIGNED_IN'); }, cancel: async () => {} });
  const { ctl, engine } = setup({ auth, sync: failing });
  const c = await ctl.handle('vkin.copilots.create', { fields: { name: 'C' } });
  await ctl.handle('vkin.select', { copilotId: c.id, threadId: null });
  const signingIn = ctl.handle('vkin.auth.verify', { email: 'a@b.co', code: '123456' });
  assert.equal(ctl.busy(), true);
  assert.throws(() => ctl.startSession(), /account change/);
  release();
  await signingIn;
  assert.equal(ctl.busy(), false);
  engine.ctx = 'stale';
  await assert.rejects(ctl.handle('vkin.sync.now'), /E_NOT_SIGNED_IN/);
  assert.notEqual(engine.ctx, 'stale', 'context refreshed despite the failed pass');
});

test('controller: copilots made before sign-in are adopted into the account only on request, once', async () => {
  const uid = '44444444-4444-4444-8444-444444444444';
  const auth = { getClient: () => ({}), userId: async () => null, status: async () => ({ signedIn: false }), verify: async () => ({ userId: uid }) };
  const { ctl } = setup({ auth, sync: () => ({ syncNow: async () => ({ ok: true }), cancel: async () => {} }) });
  await ctl.handle('vkin.copilots.create', { fields: { name: 'Before sign-in' } });
  await ctl.handle('vkin.auth.verify', { email: 'a@b.co', code: '123456' });
  assert.deepEqual(await ctl.handle('vkin.copilots.list'), [], 'nothing moves into the account by itself');
  assert.equal((await ctl.handle('vkin.local.list')).length, 1);
  const r = await ctl.handle('vkin.adoptLocal', { copilotIds: null });
  assert.equal(r.adopted.copilots, 1);
  await ctl.handle('vkin.adoptLocal', { copilotIds: null });
  assert.equal((await ctl.handle('vkin.copilots.list')).length, 1, 'a second adopt does not duplicate');
});

test('controller: select rejects a thread from another copilot', async () => {
  const { ctl } = setup();
  const a = await ctl.handle('vkin.copilots.create', { fields: { name: 'A' } });
  const b = await ctl.handle('vkin.copilots.create', { fields: { name: 'B' } });
  const tb = await ctl.handle('vkin.threads.create', { copilotId: b.id, title: 'B thread' });
  await assert.rejects(ctl.handle('vkin.select', { copilotId: a.id, threadId: tb.id }), /does not belong/);
});

test('controller: the answer context drops approved memory forgotten during a sync (finding 7)', async () => {
  let ctlStore = null;
  const fakeSync = ({ store }) => { ctlStore = store; return { syncNow: async () => ({ ok: true, pushed: 0, pulled: 1, conflicts: 0 }), cancel: async () => {} }; };
  const auth = { getClient: () => ({}), userId: async () => '11111111-1111-4111-8111-111111111111', status: async () => ({ signedIn: true }), verify: async () => ({ userId: '11111111-1111-4111-8111-111111111111' }) };
  const { ctl, engine } = setup({ auth, sync: fakeSync });
  await ctl.switchAccount('11111111-1111-4111-8111-111111111111');
  const c = await ctl.handle('vkin.copilots.create', { fields: { name: 'C' } });
  const t = await ctl.handle('vkin.threads.create', { copilotId: c.id, title: 'T' });
  await ctl.handle('vkin.select', { copilotId: c.id, threadId: t.id });
  const s = ctlStore.startSession(t.id, {});
  ctlStore.addMemoryDraft(s.id, [{ kind: 'fact', text: 'They prefer weekly updates.', origin: 'their_speech', source_at: null }]);
  ctlStore.approveMemory(ctlStore.listMemory({ threadId: t.id }).map((m) => m.id));
  ctl.applyContext();
  assert.equal(engine.ctx.threadMemory.length, 1);
  // Simulate the pull having applied a forget from the web, then a sync pass.
  ctlStore.forgetMemory(ctlStore.listMemory({ threadId: t.id })[0].id);
  await ctl.handle('vkin.sync.now');
  assert.equal(engine.ctx.threadMemory.length, 0, 'forgotten memory leaves the prompt immediately');
});

test('controller: no account switch or sign-in under an open meeting; sync is cancelled before switching (findings 3, 4)', async () => {
  let cancelled = 0;
  const fakeSync = () => ({ syncNow: async () => ({ ok: true }), cancel: async () => { cancelled += 1; } });
  const auth = { getClient: () => ({}), userId: async () => null, status: async () => ({ signedIn: false }), verify: async () => ({ userId: '22222222-2222-4222-8222-222222222222' }), signOut: async () => ({ signedOut: true }) };
  const { ctl } = setup({ auth, sync: fakeSync });
  const c = await ctl.handle('vkin.copilots.create', { fields: { name: 'C' } });
  await ctl.handle('vkin.select', { copilotId: c.id, threadId: null });
  ctl.startSession();
  await assert.rejects(ctl.switchAccount('22222222-2222-4222-8222-222222222222'), /end the current meeting/);
  await assert.rejects(ctl.handle('vkin.auth.verify', { email: 'a@b.co', code: '123456' }), /end the current meeting/);
  ctl.finishSession();
  await ctl.handle('vkin.auth.verify', { email: 'a@b.co', code: '123456' });
  assert.equal(ctl.account(), '22222222-2222-4222-8222-222222222222');
  await assert.rejects(ctl.handle('vkin.auth.verify', { email: 'a@b.co', code: '123456' }), /sign out of the current account first/);
  await ctl.handle('vkin.auth.signOut', {});
  assert.ok(cancelled >= 1, 'the running sync was cancelled before sign-out');
});
