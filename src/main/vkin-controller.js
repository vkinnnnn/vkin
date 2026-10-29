// @ts-check
'use strict';
// Vkin desktop controller (docs/vkin-contracts.md): the selected copilot/thread, the meeting session, the
// end-of-meeting memory draft, account switching and the prep window's vkin.* commands. Electron-free so it
// can be tested; main.js injects the engine, transcript history, auth and the store factory.
const fs = require('node:fs');
const path = require('node:path');
const { draftFromTranscript } = require('./memory-draft');
const { composeNotes } = require('./meeting-notes');

/**
 * @param {{
 *   dataRoot: string,
 *   createStore: (o: { dataRoot: string, account?: string }) => any,
 *   createSync?: ((o: { store: any, client: any, getUserId: () => Promise<string|null> }) => any) | null,
 *   getAuth?: () => any,
 *   cloudReason?: string,
 *   getEngine: () => any,
 *   getHistory: () => { speaker: string, text: string, endedAt: number }[],
 *   isRunning: () => boolean,
 *   now?: () => number,
 *   log?: (...a: any[]) => void,
 * }} deps
 */
function createVkinController({ dataRoot, createStore, createSync = null, getAuth = () => null, cloudReason = '', getEngine, getHistory, isRunning, now = () => Date.now(), log = () => {} }) {
  let account = 'local';
  let store = createStore({ dataRoot });
  let sync = null;
  const sel = { copilotId: /** @type {string|null} */ (null), threadId: /** @type {string|null} */ (null) };
  // Set while signing in or out: no meeting may start until the account change has finished.
  let transitioning = false;
  /** A copilot deleted locally or by a sync is simply gone (the store throws E_NOT_FOUND). */
  const findCopilot = (/** @type {string} */ id) => {
    try { return store.getCopilot(id); } catch (err) { if (err && /** @type {any} */ (err).code === 'E_NOT_FOUND') return null; throw err; }
  };
  const session = { id: /** @type {string|null} */ (null), threadId: /** @type {string|null} */ (null), startedAt: 0 };

  const selectionFile = () => path.join(dataRoot, 'vkin', account === 'local' ? 'local' : account.toLowerCase(), 'selection.json');
  function saveSelection() {
    try {
      fs.mkdirSync(path.dirname(selectionFile()), { recursive: true });
      fs.writeFileSync(selectionFile(), JSON.stringify({ copilotId: sel.copilotId, threadId: sel.threadId }));
    } catch (err) { log('vkin selection not saved', /** @type {any} */ (err).message); }
  }
  function loadSelection() {
    try {
      const s = JSON.parse(fs.readFileSync(selectionFile(), 'utf8'));
      const copilot = s.copilotId ? findCopilot(s.copilotId) : null;
      sel.copilotId = copilot ? copilot.id : null;
      sel.threadId = copilot && s.threadId && store.listThreads(copilot.id).some((/** @type {any} */ t) => t.id === s.threadId) ? s.threadId : null;
    } catch { sel.copilotId = null; sel.threadId = null; }
  }
  /** Drop a selection that points at something deleted (locally or by a sync). */
  function pruneSelection() {
    let changed = false;
    if (sel.copilotId && !findCopilot(sel.copilotId)) { sel.copilotId = null; sel.threadId = null; changed = true; }
    if (sel.copilotId && sel.threadId && !store.listThreads(sel.copilotId).some((/** @type {any} */ t) => t.id === sel.threadId)) { sel.threadId = null; changed = true; }
    if (changed) saveSelection();
  }

  /** Hand the engine the selected copilot plus its approved memory, or nothing in general mode. */
  function applyContext() {
    const engine = getEngine();
    if (!engine) return;
    const copilot = sel.copilotId ? findCopilot(sel.copilotId) : null;
    if (!copilot) { engine.setVkin(null); return; }
    const copilotScope = copilot.memory_scope === 'copilot';
    const threadMemory = copilotScope || sel.threadId ? store.approvedMemory({ copilotId: copilot.id, threadId: copilotScope ? null : sel.threadId, limit: 40 }) : [];
    const profileFacts = copilot.use_profile_facts ? store.factsForCopilot(copilot.id) : [];
    engine.setVkin({ copilot, threadMemory, profileFacts, todayContext: store.profile().today_context || '' });
  }

  /** Meeting started (or resumed): a pause keeps the same session; only End closes it. */
  function startSession() {
    if (transitioning) throw new Error('an account change is in progress');
    if (session.id) return session.id;
    const copilot = sel.copilotId ? findCopilot(sel.copilotId) : null;
    if (!copilot) return null;
    if (!sel.threadId) { sel.threadId = store.createThread(copilot.id, `Meeting ${new Date(now()).toLocaleDateString()}`).id; saveSelection(); }
    const settings = store.profile().settings || {};
    session.id = store.startSession(sel.threadId, { saveTranscript: settings.save_transcripts_default === true }).id;
    session.threadId = sel.threadId;
    session.startedAt = now();
    applyContext();
    return session.id;
  }

  /** End of meeting: draft memory from what was actually said (never from suggestions), for the user to approve. */
  function finishSession() {
    if (!session.id) return 0;
    const id = session.id;
    const threadId = session.threadId;
    const since = session.startedAt;
    session.id = null;
    session.threadId = null;
    const lines = getHistory().filter((h) => h.endedAt >= since)
      .map((h) => ({ speaker: /** @type {'me'|'them'} */ (h.speaker === 'ME' ? 'me' : 'them'), text: h.text, at: new Date(h.endedAt).toISOString() }));
    // The thread the session was started in, even if the selection changed since.
    const row = threadId ? store.listSessions(threadId).find((/** @type {any} */ s) => s.id === id) : null;
    if (row && row.save_transcript && lines.length) store.addTranscriptLines(id, lines);
    const settings = store.profile().settings || {};
    const drafts = settings.memory_enabled === false ? [] : draftFromTranscript({ lines });
    if (drafts.length) store.addMemoryDraft(id, drafts);
    store.endSession(id);
    return drafts.length;
  }

  /** Stop (and wait for) any sync pass still working on the current account's store. */
  async function stopSync() {
    const s = sync;
    sync = null;
    if (s && typeof s.cancel === 'function') await s.cancel();
  }
  /** Each account has its own store and selection; never switch under an open meeting. */
  async function switchAccount(next) {
    if (session.id) throw new Error('end the current meeting before switching accounts');
    await stopSync();
    if (typeof store.close === 'function') store.close();
    account = next;
    store = createStore({ dataRoot, account: next });
    const auth = getAuth();
    sync = next !== 'local' && auth && createSync ? createSync({ store, client: auth.getClient(), getUserId: () => auth.userId() }) : null;
    loadSelection();
    applyContext();
  }

  const active = () => {
    const copilot = sel.copilotId ? findCopilot(sel.copilotId) : null;
    const thread = copilot && sel.threadId ? store.listThreads(copilot.id).find((/** @type {any} */ t) => t.id === sel.threadId) || null : null;
    return { copilot, thread };
  };

  /** @param {string} cmd @param {any} a */
  async function handle(cmd, a = {}) {
    const running = isRunning();
    switch (cmd) {
      case 'vkin.auth.status': {
        const auth = getAuth();
        return auth ? { configured: true, ...(await auth.status()), canSync: Boolean(sync) } : { configured: false, reason: cloudReason };
      }
      case 'vkin.auth.signIn': {
        const auth = getAuth();
        if (!auth) throw new Error(`cloud sync is not configured: ${cloudReason}`);
        return auth.signIn(String(a.email || ''));
      }
      case 'vkin.auth.verify': {
        if (running) throw new Error('stop listening before signing in');
        const auth = getAuth();
        if (!auth) throw new Error('cloud sync is not configured');
        if (account !== 'local') throw new Error('sign out of the current account first');
        if (session.id) throw new Error('end the current meeting before signing in');
        if (transitioning) throw new Error('an account change is in progress');
        // Meetings cannot start until the new account's store is open (startSession checks this flag).
        transitioning = true;
        try {
          const r = await auth.verify(String(a.email || ''), String(a.code || ''));
          await switchAccount(r.userId);
          return r;
        } finally { transitioning = false; }
      }
      case 'vkin.auth.signOut': {
        if (running) throw new Error('stop listening before signing out');
        if (session.id) throw new Error('end the current meeting before signing out');
        if (transitioning) throw new Error('an account change is in progress');
        const auth = getAuth();
        if (!auth) return { signedOut: true, wiped: false };
        transitioning = true;
        try {
          // An in-flight sync pass must stop before the account's data is wiped or the session changes.
          await stopSync();
          const r = await auth.signOut({ clearDeviceData: a.clearDeviceData === true });
          // Close this account's store here (not only in the onSignOut listener) so nothing can write to it.
          if (account !== 'local') await switchAccount('local');
          return r;
        } finally { transitioning = false; }
      }
      case 'vkin.sync.now': {
        if (!sync) throw new Error('sign in to sync');
        try {
          return await sync.syncNow();
        } finally {
          // Items forgotten or deleted on another device leave the answer context now, even if the pass stopped early.
          pruneSelection();
          applyContext();
        }
      }
      case 'vkin.local.list': {
        // Copilots created before sign-in, offered for adoption into the signed-in account.
        if (account === 'local') return [];
        const local = createStore({ dataRoot, account: 'local' });
        try { return local.listCopilots(); } finally { if (typeof local.close === 'function') local.close(); }
      }
      case 'vkin.adoptLocal': {
        if (account === 'local') throw new Error('sign in first');
        if (running || session.id || transitioning) throw new Error('end the meeting first');
        const local = createStore({ dataRoot, account: 'local' });
        try {
          const r = store.adoptFrom(local, { copilotIds: Array.isArray(a.copilotIds) ? a.copilotIds : null, removeFromLocal: a.removeFromLocal === true });
          applyContext();
          return r;
        } finally { if (typeof local.close === 'function') local.close(); }
      }
      case 'vkin.active': return active();
      case 'vkin.select': {
        if (running) throw new Error('stop listening before switching copilots');
        const copilot = a.copilotId ? findCopilot(a.copilotId) : null;
        if (a.copilotId && !copilot) throw new Error('that copilot no longer exists');
        if (copilot && a.threadId && !store.listThreads(copilot.id).some((/** @type {any} */ t) => t.id === a.threadId)) throw new Error('that thread does not belong to this copilot');
        // A paused meeting belongs to the old selection: close it there before switching.
        if (session.id) finishSession();
        sel.copilotId = copilot ? copilot.id : null;
        sel.threadId = copilot ? a.threadId || null : null;
        saveSelection();
        applyContext();
        return active();
      }
      case 'vkin.copilots.list': return store.listCopilots();
      case 'vkin.copilots.create': return store.createCopilot(a.fields || {});
      case 'vkin.copilots.update': { const c = store.updateCopilot(a.id, a.patch || {}); applyContext(); return c; }
      case 'vkin.copilots.delete':
        if ((running || session.id) && sel.copilotId === a.id) throw new Error('end the meeting first');
        store.deleteCopilot(a.id);
        pruneSelection();
        applyContext();
        return true;
      case 'vkin.threads.list': return store.listThreads(a.copilotId);
      case 'vkin.threads.create': return store.createThread(a.copilotId, a.title || '');
      case 'vkin.threads.delete':
        if ((running || session.id) && (sel.threadId === a.id || session.threadId === a.id)) throw new Error('end the meeting first');
        store.deleteThread(a.id);
        pruneSelection();
        applyContext();
        return true;
      case 'vkin.sessions.list': return store.listSessions(a.threadId);
      case 'vkin.notes.compose': {
        // Post-call notes from approved memory only; replaces the session's summary.
        const row = store.listSessions(a.threadId).find((/** @type {any} */ s) => s.id === a.sessionId);
        if (!row) throw new Error('that meeting no longer exists');
        const notes = composeNotes({ startedAt: row.started_at, items: store.listMemory({ sessionId: row.id, status: 'approved' }) });
        if (!notes) throw new Error('approve some memory from this meeting first');
        return store.setSessionSummary(row.id, notes);
      }
      case 'vkin.memory.list': return store.listMemory({ threadId: a.threadId || null, copilotId: a.copilotId || null });
      case 'vkin.memory.update': { const m = store.updateMemory(a.id, a.patch || {}); applyContext(); return m; }
      case 'vkin.memory.approve': { const r = store.approveMemory(a.ids || []); applyContext(); return r; }
      case 'vkin.memory.forget': { const r = store.forgetMemory(a.id); applyContext(); return r; }
      case 'vkin.profile.get': return store.profile();
      case 'vkin.profile.update': { const p = store.updateProfile(a.patch || {}); applyContext(); return p; }
      case 'vkin.export': return store.exportAll();
      default: throw new Error(`unknown prep command ${cmd}`);
    }
  }

  return {
    handle, startSession, finishSession, applyContext, loadSelection, switchAccount,
    keyterms: () => { const c = sel.copilotId ? findCopilot(sel.copilotId) : null; return c && Array.isArray(c.keyterms) ? c.keyterms : []; },
    account: () => account,
    busy: () => transitioning,
    hasOpenSession: () => Boolean(session.id),
  };
}

module.exports = { createVkinController };
