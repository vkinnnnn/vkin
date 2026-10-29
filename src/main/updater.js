// @ts-check
'use strict';
// Safe automatic updating (PRD Phase 6), opt-in via config.updates.enabled. Only a packaged build
// checks. electron-updater verifies the downloaded installer against the sha512 in the feed's
// latest.yml; the update installs on quit or when the user presses Restart, never during a session.
// Without a code-signing certificate Windows cannot additionally verify the publisher (see docs).

/**
 * @param {{ app: any, config: any, log?: (...a: any[]) => void, emit?: (type: string, payload: any) => void,
 *   isBusy?: () => boolean, loadUpdater?: () => any }} deps
 */
function createUpdater(deps) {
  const log = deps.log || (() => {});
  const emit = deps.emit || (() => {});
  const cfg = { enabled: false, url: '', checkOnStartDelayMs: 20000, ...(deps.config && deps.config.updates) };
  let state = { status: 'idle', version: null, error: null };
  let au = null;

  const enabled = () => Boolean(cfg.enabled) && Boolean(deps.app && deps.app.isPackaged) && /^https:\/\//.test(String(cfg.url || ''));
  function reason() {
    if (!cfg.enabled) return 'updates are off (config.updates.enabled)';
    if (!(deps.app && deps.app.isPackaged)) return 'only installed builds update themselves';
    if (!/^https:\/\//.test(String(cfg.url || ''))) return 'config.updates.url must be an https feed';
    return '';
  }
  function set(next) {
    state = { ...state, ...next };
    emit('update', { ...state });
  }

  function updater() {
    if (au) return au;
    const load = deps.loadUpdater || (() => require('electron-updater').autoUpdater);
    au = load();
    au.autoDownload = true;
    au.autoInstallOnAppQuit = true;
    au.allowPrerelease = false;
    au.allowDowngrade = false;
    au.setFeedURL({ provider: 'generic', url: cfg.url });
    au.on('checking-for-update', () => set({ status: 'checking', error: null }));
    au.on('update-not-available', () => set({ status: 'current' }));
    au.on('update-available', (i) => set({ status: 'downloading', version: i && i.version }));
    au.on('update-downloaded', (i) => { set({ status: 'ready', version: i && i.version }); log('update ready', i && i.version); });
    au.on('error', (e) => { set({ status: 'error', error: String((e && e.message) || e).slice(0, 200) }); log('update error', e && e.message); });
    return au;
  }

  async function check() {
    if (!enabled()) return { ...state, status: 'disabled', error: reason() };
    try {
      await updater().checkForUpdates();
    } catch (e) {
      set({ status: 'error', error: String((e && e.message) || e).slice(0, 200) });
    }
    return { ...state };
  }

  /** Restarts into the downloaded update; refused while listening. */
  function installNow() {
    if (state.status !== 'ready') throw new Error('no update is ready');
    if (deps.isBusy && deps.isBusy()) throw new Error('stop listening before restarting to update');
    updater().quitAndInstall(false, true);
    return true;
  }

  function scheduleStartupCheck(setTimeoutFn = setTimeout) {
    if (!enabled()) return false;
    setTimeoutFn(() => { check().catch(() => {}); }, cfg.checkOnStartDelayMs);
    return true;
  }

  return { check, installNow, scheduleStartupCheck, status: () => ({ ...state, enabled: enabled(), reason: reason(), url: cfg.url || '' }) };
}

module.exports = { createUpdater };
