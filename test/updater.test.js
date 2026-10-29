'use strict';
// Phase 6 safe auto-update: opt-in, packaged builds only, https feed, never installs mid-session.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createUpdater } = require('../src/main/updater');

function fakeAu() {
  const e = new EventEmitter();
  e.feed = null;
  e.installed = 0;
  e.setFeedURL = (f) => { e.feed = f; };
  e.checkForUpdates = async () => { e.emit('checking-for-update'); e.emit('update-available', { version: '0.2.0' }); e.emit('update-downloaded', { version: '0.2.0' }); };
  e.quitAndInstall = () => { e.installed += 1; };
  return e;
}

const packaged = { isPackaged: true };

test('disabled by default, in dev builds, and without an https feed', async () => {
  assert.equal((await createUpdater({ app: packaged, config: {} }).check()).status, 'disabled');
  assert.match(createUpdater({ app: { isPackaged: false }, config: { updates: { enabled: true, url: 'https://x' } } }).status().reason, /installed builds/);
  assert.match(createUpdater({ app: packaged, config: { updates: { enabled: true, url: 'http://insecure' } } }).status().reason, /https/);
});

test('enabled: generic https feed, download then ready; install refused while listening', async () => {
  const au = fakeAu();
  let busy = true;
  const events = [];
  const u = createUpdater({ app: packaged, config: { updates: { enabled: true, url: 'https://updates.example.com/vkin/' } }, loadUpdater: () => au, isBusy: () => busy, emit: (t, p) => events.push(p.status) });
  const s = await u.check();
  assert.deepEqual(au.feed, { provider: 'generic', url: 'https://updates.example.com/vkin/' });
  assert.equal(au.autoInstallOnAppQuit, true);
  assert.equal(au.allowDowngrade, false);
  assert.equal(s.status, 'ready');
  assert.deepEqual(events, ['checking', 'downloading', 'ready']);
  assert.throws(() => u.installNow(), /stop listening/);
  busy = false;
  assert.equal(u.installNow(), true);
  assert.equal(au.installed, 1);
});

test('startup check is scheduled only when enabled', () => {
  let scheduled = 0;
  const fakeTimer = () => { scheduled += 1; };
  assert.equal(createUpdater({ app: packaged, config: {} }).scheduleStartupCheck(fakeTimer), false);
  assert.equal(createUpdater({ app: packaged, config: { updates: { enabled: true, url: 'https://a/' } }, loadUpdater: fakeAu }).scheduleStartupCheck(fakeTimer), true);
  assert.equal(scheduled, 1);
});
