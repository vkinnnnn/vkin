const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, session, screen, Tray, Menu, nativeImage, clipboard, dialog } = require('electron');

const { resolvePaths, seedDataRoot } = require('./paths');
const { createVkinStore } = require('./vkin/store');
const { createVkinController } = require('./vkin-controller');
const { createWatchdog } = require('./audio/watchdog');
const { createVkinSync } = require('./vkin/sync');
const { createVkinAuth, configFromEnv, safeStorageCrypto } = require('./vkin/auth');
const { isPage: isBundledPage } = require('./trust');
// Code assets come from APP_ROOT; data (config.json, .env, data/, meeting-packs/, notes) from ROOT. Both are
// the repository in development; a packaged build keeps data in the per-user folder (paths.js).
const APP_ROOT = path.join(__dirname, '..', '..');
// The product is now "Vkin", but installed builds keep the legacy data folder so existing profiles,
// packs, keys and the budget ledger carry over (docs/vkin-contracts.md, Branding).
if (app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'meeting-copilot'));
const paths = resolvePaths({ appRoot: APP_ROOT, packaged: app.isPackaged, userData: app.isPackaged ? app.getPath('userData') : null });
const seeded = seedDataRoot(paths);
const ROOT = paths.dataRoot;
require('dotenv').config({ path: path.join(ROOT, '.env'), override: false });

const { IPC, UI_EVENTS, MIRROR_ALLOWED, AUDIO } = require('../shared/contracts');
const { FluxClient } = require('./stt');
const { createContext } = require('./context');
const { createGateway } = require('./llm-gateway');
const { createHosted, HOSTED_FRIENDLY } = require('./hosted');
const { TurnManager } = require('./turns');
const { createEngine } = require('./engine');
const { createTelemetry } = require('./telemetry');
const { createRegistry } = require('./providers/registry');
const { resolveFlags } = require('./flags');
const { createDialogueState } = require('./brain/dialogue-state');
const { createAudioSource } = require('./audio/audio-source');
const { loadNativeAudio } = require('./audio/native-loader');
const { createPrepStore } = require('./prep/prep-store');
const { createSecretStore } = require('./secrets');
const { createUpdater } = require('./updater');
const { DEFAULTS: ANSWER_DEFAULTS } = require('./render');
const { createScreenContext } = require('./screen/screen-context');
const { ocrImage } = require('./screen/ocr');

const configPath = path.join(ROOT, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
// Prices ship with the app; a copy in the data folder (if the user made one) wins.
if (config.budget && config.budget.pricesFile) config.budget.pricesFile = paths.asset(config.budget.pricesFile);
const resolveRoot = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
// Phase-1 conversation-brain feature flags (rollback == set the flag false). Env FABEL_* overrides config.flags.
const { values: flags, warnings: flagWarnings } = resolveFlags(config, process.env);
const notesPath = resolveRoot(config.profile.meetingNotes);

let overlay = null;
let prepWin = null;
let tray = null;
let capture = null;
let mirror = null;
let mirrorInfo = null;
let running = false;
let startedAt = null;
const stt = {};
const status = { capture: { them: 'stopped', me: 'stopped' }, stt: { them: 'closed', me: 'closed' } };
const sessionId = crypto.randomBytes(3).toString('hex');
const lastLevelAt = { them: 0, me: 0 };
let transcriptFile = null;

function log(...args) {
  console.log(new Date().toISOString().slice(11, 23), ...args);
}

// ---------- context + llm ----------
const ctx = createContext(config, { readFile: (p) => fs.readFileSync(resolveRoot(p), 'utf8') });
// Hosted mode (VKIN_API_URL or config.hosted.apiUrl): the Vkin server holds the provider keys and meters
// minutes; this computer sends the signed-in user's token and the session lease only.
const hosted = createHosted({
  config, env: process.env, log,
  getToken: async () => {
    const auth = getVkinAuth();
    const client = auth && auth.getClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return (data && data.session && data.session.access_token) || null;
  },
  onState: (s) => emit('hosted', s),
  onEnded: (reason) => {
    if (!running) return;
    log('hosted session ended:', reason);
    stopAll({ fromServer: true });
    emit('hostedNotice', { message: HOSTED_FRIENDLY[reason] || HOSTED_FRIENDLY.lease_inactive });
  },
});
const gateway = createGateway({ config, root: ROOT, sessionId, log, onBudgetChange: (b) => emit('budget', b), hosted });
const { llm } = gateway;
log('llm mode', gateway.mode);
log('context ready', ctx.stats || '');
log('flags', Object.entries(flags).filter(([, v]) => v).map(([k]) => k).join(',') || 'none');
for (const w of flagWarnings) log('flag warning:', w);

// ---------- renderer trust ----------
// Every window shows one bundled page. Navigation, new windows and webviews are refused app-wide, so a
// dropped or linked file can never replace a page; IPC is accepted only from the expected page.
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const isPage = (url, file) => isBundledPage(url, file, RENDERER_DIR);
function fromPage(e, win, file) {
  return Boolean(win) && !win.isDestroyed() && e.sender === win.webContents && Boolean(e.senderFrame) && isPage(e.senderFrame.url, file);
}
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (ev) => ev.preventDefault());
  wc.on('will-redirect', (ev) => ev.preventDefault());
  wc.on('will-attach-webview', (ev) => ev.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
});

// Debug: report main-thread stalls. Audio frames, STT events and answer streaming all share this
// thread, so a long synchronous task here delays everything (and trips the audio stall detector).
if (process.env.COPILOT_DEBUG === '1') {
  let expected = Date.now() + 250;
  setInterval(() => {
    const lag = Date.now() - expected;
    if (lag > 150) log('event loop blocked', `${lag}ms`);
    expected = Date.now() + 250;
  }, 250).unref();
}

function readNotes() {
  try { return fs.readFileSync(notesPath, 'utf8'); } catch { return ''; }
}

// ---------- event fan-out ----------
function emit(type, payload = {}) {
  const msg = { type, ...payload };
  // IDs are stripped on the accumulated text by each display (overlay.js, phone.html);
  // stripping per delta would eat the spaces between tokens.
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(IPC.UI_EVENT, msg);
  if (mirror && MIRROR_ALLOWED.has(type)) mirror.broadcast(msg);
  if (type === 'answer:done') log('answer done', JSON.stringify(payload.timings), payload.model, payload.hedged ? 'HEDGED' : '');
  if (type === 'answer:error') log('answer error', payload.message);
  if (process.env.COPILOT_DEBUG === '1' && type === UI_EVENTS.TRANSCRIPT && payload.channel === 'me' && payload.status === 'final') log('me final', payload.echo ? 'ECHO-DROPPED' : 'kept');
  if (transcriptFile && type === UI_EVENTS.TRANSCRIPT && payload.status === 'final') {
    fs.appendFile(transcriptFile, `${JSON.stringify({ t: Date.now(), ...payload })}\n`, () => {});
  }
}

function sendStatus() {
  refreshTray();
  emit(UI_EVENTS.STATUS, {
    running,
    startedAt,
    capture: status.capture,
    stt: status.stt,
    audio: audio.status(),
    autoAnswer: turns.autoAnswer,
    meeting: engine && engine.meeting ? { id: engine.meeting.id, title: (engine.meeting.session && engine.meeting.session.title) || engine.meeting.person || engine.meeting.id } : null,
    llm: llm.info(),
    providers: Object.fromEntries(Object.entries(config.llm.providers).map(([k, v]) => [k, { models: v.models, privacyNote: v.privacyNote }])),
    mirror: mirrorInfo ? { url: mirrorInfo.url, qr: mirrorInfo.qrDataUrl } : null,
  });
}

// Answer engine (brainV2) with validation; legacy context.js path when the flag is off (rollback).
let engine = null;
if (config.profile.brainV2) {
  try {
    engine = createEngine({ config, root: ROOT, registry: gateway.registry || createRegistry(config), flags, budgetStatus: () => (gateway.budget() || {}).nebius, log });
  } catch (err) {
    log('answer engine failed to start; using the legacy prompt path:', err.message);
  }
}
if (engine) log('answer engine', JSON.stringify(engine.stats));
// A meeting pack adds its names and terms (people, index names, "bridging") to speech recognition.
const sttConfig = engine && engine.meeting
  ? { ...config.stt, keyterms: [...new Set([...(config.stt.keyterms || []), ...engine.meeting.keyterms])].slice(0, 50) }
  : config.stt;
if (engine && engine.meeting) log('meeting pack', engine.meeting.id, 'expires', engine.meeting.expires || 'never');
const telemetry = config.telemetry && config.telemetry.enabled ? createTelemetry({ dir: resolveRoot(config.telemetry.dir), retentionDays: config.telemetry.retentionDays || 30 }) : null;

const turns = new TurnManager({
  sessionId,
  config: { ...config.turns, historyTurns: config.profile.historyTurns },
  llm,
  emit,
  now: () => Date.now(),
  buildMessages: (question, history, extra) => (engine
    ? engine.build({ question, history, meetingNotes: readNotes(), ...(extra || {}) })
    : ctx.buildMessages({ question, history, meetingNotes: readNotes(), ...(extra || {}) })),
  validate: engine && config.validation && config.validation.enabled ? (text, meta) => engine.validate(text, meta) : null,
  trim: engine ? engine.trim : null,
  onAnswerDone: engine ? (meta) => engine.commit(meta) : null,
  polish: engine ? (text, meta) => engine.polish(text, meta) : null,
  regenerateOnFail: !(config.validation && config.validation.regenerate === false),
  // "stable": the answer on screen changes at most once (cut unsupported sentences; rewrite hidden only if needed).
  stableRewrite: Boolean(config.validation && config.validation.mode === 'stable'),
  // FABEL_STALE_TURN_GUARD: stamp answer events with a monotonic seq so displays drop older generations.
  staleTurnGuard: flags.staleTurnGuard,
  // FABEL_PARTIAL_PREP: prepare the local build on EagerEndOfTurn (no paid call until EndOfTurn).
  partialPrep: flags.partialPrep,
  // FABEL_DIALOGUE_STATE_V2: one canonical dialogue state tracking generated/displayed/spoken answers.
  dialogueState: flags.dialogueStateV2 ? createDialogueState({ sessionId, now: () => Date.now() }) : null,
  telemetry,
});

// A session prepared in manual mode starts without auto-answering (the overlay can switch it).
if (engine && engine.meeting && engine.meeting.session && engine.meeting.session.mode === 'manual') turns.setAutoAnswer(false);

// ---------- encrypted API keys (PRD Phase 6) ----------
// Keys moved out of .env are decrypted (OS user-bound) into process.env at startup; a real environment
// variable or a remaining .env line still wins. Only key names are ever logged or shown.
const { safeStorage } = require('electron');
const secrets = createSecretStore({ file: path.join(ROOT, 'data', 'secrets.json'), envFile: path.join(ROOT, '.env'), safeStorage });

// ---------- safe auto-update (PRD Phase 6; opt-in, installed builds only) ----------
const updater = createUpdater({ app, config, log, emit: (t, p) => emit(t, p), isBusy: () => running });

// ---------- prep window (AI Background, PRD Phase 3) ----------
const prep = createPrepStore({ root: ROOT, config, log });
// Only files the user picked in the open dialog may be imported (the renderer cannot name a path).
const pickedFiles = new Set();
function writeMeetingConfig(c) {
  // Re-read from disk and change only the meeting selection, so nothing else in config.json moves.
  const disk = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  disk.meeting = { ...(disk.meeting || {}), enabled: c.meeting.enabled, profile: c.meeting.profile };
  fs.writeFileSync(configPath, `${JSON.stringify(disk, null, 2)}\n`, 'utf8');
}
const isActiveSession = (id) => Boolean(engine && engine.meeting && engine.meeting.id === id);

// ---- Vkin: copilot workspaces, threads, sessions, approved memory (docs/vkin-contracts.md) ----
// Logic lives in vkin-controller.js; this wires Electron pieces in. Cloud sign-in and sync are optional:
// without VKIN_SUPABASE_URL / VKIN_SUPABASE_ANON_KEY everything stays local.
const VKIN_DATA = path.join(ROOT, 'data');
// .env wins (development); installed builds carry the public project settings in config.vkin.
const vkinCloud = configFromEnv({
  VKIN_SUPABASE_URL: process.env.VKIN_SUPABASE_URL || (config.vkin && config.vkin.supabaseUrl) || '',
  VKIN_SUPABASE_ANON_KEY: process.env.VKIN_SUPABASE_ANON_KEY || (config.vkin && config.vkin.supabaseAnonKey) || '',
});
let vkinAuth = null;
function getVkinAuth() {
  if (!vkinCloud.configured) return null;
  if (!vkinAuth) {
    vkinAuth = createVkinAuth({
      url: vkinCloud.url, anonKey: vkinCloud.anonKey, sessionFile: path.join(VKIN_DATA, 'vkin', 'session.json'),
      crypto: safeStorageCrypto(safeStorage), storeFor: (acct) => createVkinStore({ dataRoot: VKIN_DATA, account: acct }),
    });
    vkinAuth.onSignOut(() => { vkinCtl.switchAccount('local').catch((err) => log('vkin account switch failed', err.message)); });
  }
  return vkinAuth;
}
const vkinCtl = createVkinController({
  dataRoot: VKIN_DATA, createStore: createVkinStore, createSync: createVkinSync, getAuth: getVkinAuth,
  cloudReason: vkinCloud.configured ? '' : vkinCloud.reason, getEngine: () => engine,
  getHistory: () => turns.history, isRunning: () => running, log,
});

async function handlePrep(cmd, a) {
  if (String(cmd).startsWith('vkin.')) return vkinCtl.handle(cmd, a);
  switch (cmd) {
    case 'list':
      return {
        sessions: prep.listSessions(), templates: prep.templates(), sideKinds: prep.sideKinds(), running,
        loadedMeeting: engine && engine.meeting ? engine.meeting.id : null,
        brain: engine ? engine.stats : null,
        answerDefaults: { ...ANSWER_DEFAULTS, ...(config.answer || {}) },
        model: { default: config.llm.routes && config.llm.routes.default, deepRoute: Boolean(config.llm.enableDeepRoute), liveAi: (llm.info() || {}).liveEnabled === true },
        budget: gateway.budget(),
      };
    case 'get': return { ...prep.getSession(a.id), estimate: prep.estimateBudget(a.id) };
    case 'create': return prep.createSession(a.input || {});
    case 'update': {
      const s = prep.updateSession(a.id, a.patch || {});
      // Preferences and mode apply immediately to the meeting that is loaded right now.
      if (isActiveSession(a.id) && a.patch && a.patch.preferences && engine) engine.setAnswerSettings(a.patch.preferences);
      if (isActiveSession(a.id) && a.patch && a.patch.mode) { turns.setAutoAnswer(a.patch.mode !== 'manual'); sendStatus(); }
      return s;
    }
    case 'pickFiles': {
      const r = await dialog.showOpenDialog(prepWin, {
        title: 'Import documents', properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md', 'markdown', 'html', 'htm', 'json', 'csv'] }],
      });
      if (r.canceled) return [];
      for (const f of r.filePaths) pickedFiles.add(f);
      return r.filePaths.map((f) => ({ path: f, name: path.basename(f) }));
    }
    case 'import': {
      // Parsing a large PDF is CPU-heavy on this thread; never during a live session.
      if (running) throw new Error('stop listening before importing documents');
      if (!pickedFiles.has(a.filePath)) throw new Error('choose the file with the Import button first');
      pickedFiles.delete(a.filePath);
      return prep.importDocument(a.id, { filePath: a.filePath, side: a.side, kind: a.kind, approved: a.approved === true });
    }
    case 'approveDoc': return prep.setDocumentApproved(a.id, a.docId, a.approved === true);
    case 'removeDoc': return prep.removeDocument(a.id, a.docId);
    case 'addNote': return prep.addTypedRecord(a.id, a.note || {});
    case 'removeNote': return prep.removeTypedRecord(a.id, a.recordId);
    case 'validate': return prep.validate(a.id);
    case 'activate':
      if (running) throw new Error('stop listening before switching meetings');
      return prep.activate(a.id, writeMeetingConfig);
    case 'deactivate':
      if (running) throw new Error('stop listening first');
      return prep.deactivate(writeMeetingConfig);
    case 'updateStatus': return updater.status();
    case 'updateCheck': return updater.check();
    case 'updateInstall': return updater.installNow();
    case 'secretsStatus': return secrets.status();
    case 'secretsProtect': {
      if (running) throw new Error('stop listening first');
      const r = secrets.protectFromEnvFile();
      secrets.applyTo(process.env);
      log('api keys moved to encrypted storage:', r.moved.join(',') || 'none');
      return { ...r, status: secrets.status() };
    }
    case 'restart':
      if (running) throw new Error('stop listening before restarting');
      app.relaunch();
      app.exit(0);
      return true;
    default:
      throw new Error(`unknown prep command ${cmd}`);
  }
}

ipcMain.handle('prep:cmd', async (e, msg = {}) => {
  if (!fromPage(e, prepWin, 'prep.html')) throw new Error('prep commands are only accepted from the prep window');
  const { cmd, ...args } = msg;
  try {
    return await handlePrep(cmd, args);
  } catch (err) {
    log('prep error', cmd, err.message);
    throw err;
  }
});

function openPrepOnStart() {
  if (process.env.COPILOT_OPEN_PREP === '1') return true;
  if (process.env.COPILOT_OPEN_PREP === '0') return false;
  return !(config.ui && config.ui.openPrepOnStart === false);
}

function openPrep() {
  if (prepWin && !prepWin.isDestroyed()) {
    prepWin.show();
    prepWin.focus();
    return;
  }
  prepWin = new BrowserWindow({
    width: 1080, height: 760, minWidth: 820, minHeight: 560, title: 'Vkin - Prepare meeting', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  prepWin.setContentProtection(process.env.COPILOT_VISIBLE !== '1');
  prepWin.loadFile(path.join(__dirname, '..', 'renderer', 'prep.html'));
  prepWin.once('ready-to-show', () => prepWin.show());
  prepWin.on('closed', () => { prepWin = null; pickedFiles.clear(); });
}

// ---------- screen context (PRD Phase 5) ----------
// One manual screenshot of the display under the cursor. The overlay and prep windows are
// content-protected, so they do not appear in it. Kept in memory only; see screen/screen-context.js.
async function grabScreen() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scale = display.scaleFactor || 1;
  const width = Math.min(2560, Math.round(display.size.width * scale));
  const height = Math.round((width * display.size.height) / display.size.width);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('the screen capture came back empty');
  const img = src.thumbnail;
  const size = img.getSize();
  const vision = size.width > 1280 ? img.resize({ width: 1280, quality: 'good' }) : img;
  const preview = img.resize({ width: 480, quality: 'good' });
  return {
    ocrPng: img.toPNG(), visionJpeg: vision.toJPEG(70), previewDataUrl: `data:image/jpeg;base64,${preview.toJPEG(60).toString('base64')}`,
    width: size.width, height: size.height, visionWidth: vision.getSize().width, visionHeight: vision.getSize().height,
  };
}
// onDiscard: the overlay clears its preview and text whenever main drops the screenshot (timeout, panic).
const screenCtx = createScreenContext({ grab: grabScreen, ocr: (png) => ocrImage(png), llm, log, onDiscard: (reason) => emit('screenDiscarded', { reason }) });

async function handleScreen(cmd, args) {
  switch (cmd) {
    case 'screenCapture': return screenCtx.capture();
    case 'screenOcr': return screenCtx.readText(args.id);
    case 'screenVision': return screenCtx.describe(args.id, args.question);
    case 'screenAnswer': {
      const c = screenCtx.take();
      if (!c) throw new Error('read the screen first (text or Gemini)');
      log('screen answer', c.source, `${c.text.length} chars`);
      return Boolean(turns.answerWithScreen({ screen: c, question: args.question }));
    }
    case 'screenSave': {
      const png = screenCtx.imageForSave();
      const r = await dialog.showSaveDialog(overlay, { title: 'Save screenshot', defaultPath: `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`, filters: [{ name: 'PNG image', extensions: ['png'] }] });
      if (r.canceled || !r.filePath) return false;
      fs.writeFileSync(r.filePath, png);
      return true;
    }
    case 'screenDiscard': return screenCtx.discard();
    default: return null;
  }
}

// ---------- capture + stt ----------
// FABEL_NATIVE_AUDIO: native WASAPI capture with signal-level echo cancellation, falling back to the
// renderer capture window on any failure. Off by default until the acoustic matrix passes (PRD Phase 2).
const nativeAudio = flags.nativeAudio ? loadNativeAudio() : { addon: null, path: '', error: 'FABEL_NATIVE_AUDIO is off' };
if (flags.nativeAudio) log('native audio', nativeAudio.addon ? `loaded ${nativeAudio.path}` : nativeAudio.error);
const HEALTH_TO_CAPTURE = { ok: 'live', silent: 'live', starting: 'starting', stalled: 'error: stalled', stopped: 'stopped' };
const audio = createAudioSource({
  mode: flags.nativeAudio ? 'native' : 'renderer',
  addon: nativeAudio.addon,
  addonError: nativeAudio.error,
  nativeOptions: (config.audio && config.audio.native) || {},
  renderer: {
    start: (channels) => capture.webContents.send(IPC.CAPTURE_CMD, { cmd: 'start', channels }),
    stop: (channels) => capture.webContents.send(IPC.CAPTURE_CMD, { cmd: 'stop', channels }),
  },
  onFrame: feedStt,
  onStatus: (s) => {
    // The renderer reports its own capture status over IPC; native capture reports through health.
    if (s.source === 'native') {
      for (const ch of AUDIO.CHANNELS) {
        const h = s.health[ch];
        status.capture[ch] = h.state === 'error' ? `error: ${h.error}` : HEALTH_TO_CAPTURE[h.state] || h.state;
      }
    }
    sendStatus();
  },
  log,
});

// Transcription watchdog: stale capture, stalled speech-to-text and long silence get a visible warning and at
// most one bounded recovery (src/main/audio/watchdog.js). Only fixed status codes are logged, never content.
const watchdog = createWatchdog({
  onWarn: (w) => { log('watchdog', w.channel, w.code); emit('watchdog', { state: 'warn', channel: w.channel, code: w.code, message: w.message }); },
  onClear: (w) => emit('watchdog', { state: 'clear', channel: w.channel, code: w.code }),
  onRecover: (r) => {
    log('watchdog recovery', r.channel, r.kind, r.reason);
    if (!running) return;
    if (r.kind === 'capture') { audio.stop(); audio.start(); return; }
    if (stt[r.channel]) { stt[r.channel].stop(); delete stt[r.channel]; }
    startStt(r.channel);
  },
});
setInterval(() => watchdog.tick(), 1000).unref();

function feedStt(channel, pcm, level) {
  watchdog.frame(channel, level);
  if (!running || !stt[channel]) return;
  stt[channel].sendPcm(pcm);
  const now = Date.now();
  if (now - lastLevelAt[channel] > 150) {
    lastLevelAt[channel] = now;
    emit(UI_EVENTS.LEVEL, { channel, level });
  }
}

function startStt(channel) {
  if (stt[channel]) return;
  const apiKey = hosted.enabled ? null : process.env.DEEPGRAM_API_KEY;
  if (!hosted.enabled && !apiKey) {
    status.stt[channel] = 'error: DEEPGRAM_API_KEY not set';
    sendStatus();
    return;
  }
  // The selected copilot's key terms join the pack's (Deepgram takes at most 50).
  const copilotTerms = vkinCtl.keyterms();
  const stt = copilotTerms.length
    ? { ...sttConfig, keyterms: [...new Set([...(sttConfig.keyterms || []), ...copilotTerms])].slice(0, 50) }
    : sttConfig;
  const client = new FluxClient({ channel, apiKey, stt, ...(hosted.enabled ? { target: () => hosted.sttTarget(channel) } : {}) });
  client.on('fatal', ({ code }) => {
    log('stt', channel, 'refused by Vkin server:', code);
    if (running) { stopAll({ fromServer: true }); emit('hostedNotice', { message: HOSTED_FRIENDLY[code] || HOSTED_FRIENDLY.lease_inactive }); }
  });
  client.on('status', (s) => {
    watchdog.sttMessage(channel);
    // A fresh connection restarts Flux turn numbering.
    if (s.state === 'connecting') turns.newEpoch(channel);
    status.stt[channel] = s.state;
    if (s.state === 'error') log('stt', channel, s.detail || '');
    sendStatus();
  });
  client.on('event', (ev) => {
    watchdog.sttMessage(channel);
    if (process.env.COPILOT_DEBUG === '1' && ev.event !== 'Update') log('stt', channel, ev.event, ev.turnIndex, JSON.stringify(ev.transcript.slice(0, 80)));
    turns.onSttEvent(ev);
  });
  client.start();
  stt[channel] = client;
}

let starting = false;
let cancelStart = false; // Pause/End pressed while the server was still answering Start
async function startAll() {
  if (running || starting) return;
  // Signing in or out swaps the account's store; a meeting must not start in the middle of that.
  if (vkinCtl.busy()) { log('start refused: Vkin account change in progress'); return; }
  if (hosted.enabled) {
    // The server decides: one live session per account, and only while minutes remain.
    starting = true;
    cancelStart = false;
    try {
      await hosted.start('Windows desktop'); // a fixed label: no computer name leaves this machine
    } catch (err) {
      log('start refused by Vkin server:', err.hostedCode || err.message);
      emit('hostedNotice', { message: err.message });
      return;
    } finally {
      starting = false;
    }
    if (cancelStart) { cancelStart = false; hosted.stop().catch(() => {}); return; }
    if (running) return;
  }
  running = true;
  startedAt = Date.now();
  // A pause (Stop) and resume keeps the same Vkin session; End closes it.
  try { vkinCtl.startSession(); } catch (err) { log('vkin session start failed', err.message); }
  if (config.saveTranscripts) {
    fs.mkdirSync(path.join(ROOT, 'transcripts'), { recursive: true });
    transcriptFile = path.join(ROOT, 'transcripts', `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  }
  for (const ch of AUDIO.CHANNELS) startStt(ch);
  audio.start();
  watchdog.start();
  sendStatus();
}

function stopAll(opts = {}) {
  if (starting) cancelStart = true;
  watchdog.stop();
  // Pause and End both close the lease, so minutes stop counting at once.
  if (hosted.enabled && !opts.fromServer) hosted.stop().catch(() => {});
  running = false;
  startedAt = null;
  audio.stop();
  for (const ch of Object.keys(stt)) {
    stt[ch].stop();
    delete stt[ch];
  }
  transcriptFile = null;
  sendStatus();
}

ipcMain.on(IPC.AUDIO_FRAME, (e, { channel, pcm, level }) => {
  if (!fromPage(e, capture, 'capture.html')) return;
  audio.rendererFrame(channel, Buffer.from(pcm), level);
});

ipcMain.on(IPC.CAPTURE_STATUS, (e, s) => {
  if (!fromPage(e, capture, 'capture.html')) return;
  log('capture', s.channel, s.state, s.sampleRate || '', s.error || '');
  audio.rendererStatus(s.channel, s.state, s.error);
  // A late "stopped" from the renderer must not overwrite native capture status.
  if (audio.status().source === 'native') return;
  status.capture[s.channel] = s.state === 'error' ? `error: ${s.error || ''}` : s.state;
  sendStatus();
});

// ---------- overlay commands ----------
function handleCmd({ cmd, ...args }) {
  switch (cmd) {
    case 'start': return startAll();
    case 'stop': return stopAll();
    case 'answer': return turns.manualAnswer();
    case 'regenerate': return turns.regenerate({ deep: args.deep === true });
    case 'chat': log('chat request', JSON.stringify(String(args.text || '').slice(0, 60))); return turns.chat({ text: args.text, question: args.question, previousAnswer: args.previousAnswer });
    case 'copy': clipboard.writeText(String(args.text || '')); if (args.genId) turns.markSpoken(args.genId); return true;
    case 'feedback': return saveFeedback(args);
    case 'end': {
      stopAll();
      let memoryDrafts = 0;
      try { memoryDrafts = vkinCtl.finishSession(); } catch (err) { log('vkin session end failed', err.message); }
      return emit('sessionEnd', { memoryDrafts });
    }
    case 'setLive':
      gateway.setLive(args.provider, args.value);
      return sendStatus();
    case 'getBudget': return gateway.budget();
    case 'setModel':
      llm.setProvider(args.provider, args.model);
      log('model ->', args.provider, args.model);
      return sendStatus();
    case 'getNotes': return readNotes();
    case 'saveNotes':
      fs.writeFileSync(notesPath, String(args.text || ''), 'utf8');
      return true;
    case 'setOpacity': return overlay.setOpacity(Math.min(1, Math.max(0.3, Number(args.value) || 1)));
    case 'clickThrough': return toggleClickThrough(args.value);
    case 'cycleOpacity': return cycleOpacity();
    case 'hide': return hideOverlay();
    case 'setAutoAnswer':
      turns.setAutoAnswer(args.value !== false);
      log('auto-answer', turns.autoAnswer ? 'on' : 'off (manual)');
      return sendStatus();
    case 'clearTopic':
      turns.clearTopic();
      if (engine) engine.clearTopic();
      return emit('topicCleared', {});
    case 'openPrep': return openPrep();
    case 'panic': screenCtx.discard(); return panicHide();
    case 'screenCapture':
    case 'screenOcr':
    case 'screenVision':
    case 'screenAnswer':
    case 'screenSave':
    case 'screenDiscard':
      return handleScreen(cmd, args);
    case 'ready':
      emit('budget', gateway.budget());
      return sendStatus();
    case 'quit': return app.quit();
    default: return null;
  }
}
ipcMain.on(IPC.UI_CMD, (e, msg) => {
  if (!fromPage(e, overlay, 'overlay.html')) return log('ui command refused from', (e.senderFrame && e.senderFrame.url) || 'unknown');
  try {
    Promise.resolve(handleCmd(msg)).catch((err) => log('cmd error', msg.cmd, err.message));
  } catch (err) { log('cmd error', msg.cmd, err.message); }
});
ipcMain.handle(IPC.UI_CMD, (e, msg) => {
  if (!fromPage(e, overlay, 'overlay.html')) throw new Error('ui commands are only accepted from the overlay');
  return handleCmd(msg);
});

const OPACITY_STEPS = [1, 0.85, 0.7, 0.55];
let opacityIdx = 0;
function cycleOpacity() {
  opacityIdx = (opacityIdx + 1) % OPACITY_STEPS.length;
  overlay.setOpacity(OPACITY_STEPS[opacityIdx]);
}

let clickThrough = false;
function toggleClickThrough(value) {
  clickThrough = typeof value === 'boolean' ? value : !clickThrough;
  overlay.setIgnoreMouseEvents(clickThrough, { forward: true });
  emit('clickThrough', { value: clickThrough });
}

// Thumbs up/down are kept locally (feedback.jsonl, gitignored) to tune prompt.md later.
function saveFeedback({ genId, rating, question, text }) {
  if (!['up', 'down'].includes(rating)) return false;
  const row = { t: new Date().toISOString(), genId, rating, model: llm.info().model, question: String(question || '').slice(0, 1000), answer: String(text || '').slice(0, 3000) };
  fs.appendFile(path.join(ROOT, 'feedback.jsonl'), `${JSON.stringify(row)}\n`, () => {});
  return true;
}

// ---------- overlay visibility + tray ----------
function showOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.showInactive();
  refreshTray();
}
function hideOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.hide();
  refreshTray();
}
function toggleOverlay() {
  if (overlay && overlay.isVisible()) hideOverlay(); else showOverlay();
}
// Panic hide: every FABEL window disappears at once; listening continues so it can come straight back
// with the toggle hotkey or the tray.
function panicHide() {
  hideOverlay();
  if (prepWin && !prepWin.isDestroyed()) prepWin.hide();
}

function refreshTray() {
  if (!tray) return;
  const visible = overlay && !overlay.isDestroyed() && overlay.isVisible();
  tray.setToolTip(`Vkin: ${running ? 'listening' : 'idle'}${visible ? '' : ' (hidden)'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? 'Hide overlay  (Ctrl+Shift+H)' : 'Show overlay  (Ctrl+Shift+H)', click: toggleOverlay },
    { label: running ? 'Stop listening' : 'Start listening', click: () => (running ? stopAll() : startAll()) },
    { label: 'Prepare meeting…', click: openPrep },
    { type: 'separator' },
    { label: 'Quit Vkin', click: () => app.quit() },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(APP_ROOT, 'assets', 'icon.png'));
  tray = new Tray(icon);
  tray.on('click', toggleOverlay);
  refreshTray();
}

// ---------- windows ----------
function createWindows() {
  const webPreferences = { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true };

  capture = new BrowserWindow({ show: false, width: 300, height: 200, webPreferences: { ...webPreferences, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  capture.loadFile(path.join(__dirname, '..', 'renderer', 'capture.html'));

  const { workArea } = screen.getPrimaryDisplay();
  const width = 660;
  const height = 420;
  overlay = new BrowserWindow({
    width, height,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 24,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // macOS: a non-activating panel floats over full-screen apps without stealing focus (untested here;
    // built and verified on Windows only).
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences,
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  // All workspaces/desktops on macOS and Linux. Windows has no API for this: the always-on-top
  // 'screen-saver' level keeps it above full-screen apps on the current desktop only.
  if (process.platform !== 'win32') overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Best effort: excludes the window from most screen captures on Win10 2004+; not guaranteed.
  // COPILOT_VISIBLE=1 turns it off so the overlay can be screenshotted while debugging.
  overlay.setContentProtection(process.env.COPILOT_VISIBLE !== '1');
  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  if (process.env.COPILOT_AUTOSTART === '1') overlay.webContents.once('did-finish-load', () => setTimeout(startAll, 1500));
  overlay.on('closed', () => app.quit());
}

function registerHotkeys() {
  const hk = config.hotkeys;
  const bind = (accel, fn) => { if (accel && !globalShortcut.register(accel, fn)) log('hotkey failed', accel); };
  bind(hk.answer, () => turns.manualAnswer());
  bind(hk.regenerate, () => turns.regenerate());
  bind(hk.toggle, () => toggleOverlay());
  bind(hk.clickThrough, () => toggleClickThrough());
  bind(hk.opacity, () => cycleOpacity());
  bind(hk.historyBack, () => emit('nav', { dir: -1 }));
  bind(hk.historyForward, () => emit('nav', { dir: 1 }));
  bind(hk.chat, () => { showOverlay(); overlay.focus(); emit('focusChat', {}); });
  bind(hk.scrollUp, () => emit('scroll', { dir: -1 }));
  bind(hk.scrollDown, () => emit('scroll', { dir: 1 }));
  bind(hk.panic, () => { screenCtx.discard(); panicHide(); });
  // Manual screenshot: the overlay opens its preview panel and requests the capture.
  bind(hk.screenshot, () => { showOverlay(); emit('screenRequest', {}); });
}

async function startMirror() {
  if (!config.mirror || !config.mirror.enabled) return;
  let createMirror;
  try { ({ createMirror } = require('./mirror')); } catch { return; }
  try {
    mirror = createMirror({ port: config.mirror.port, log });
    mirrorInfo = await mirror.start();
    log('phone mirror', mirrorInfo.url.replace(/([?&]t=)[^&]+/, '$1…'));
    sendStatus();
  } catch (err) {
    mirror = null;
    log('mirror failed (overlay unaffected):', err.message);
  }
}

// A second launch (e.g. the desktop shortcut) just brings the running overlay back.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Launching again (shortcut) brings back the overlay and the meeting board.
  app.on('second-instance', () => { showOverlay(); if (openPrepOnStart()) openPrep(); });
}

app.whenReady().then(() => {
  if (!gotLock) return;
  if (seeded.length) log('first run: copied defaults to', ROOT, seeded.join(','));
  const fromVault = secrets.applyTo(process.env);
  if (fromVault.length) log('api keys from encrypted storage:', fromVault.join(','));
  updater.scheduleStartupCheck();
  vkinCtl.loadSelection();
  vkinCtl.applyContext();
  // Reopen the signed-in Vkin account (its encrypted session needs the app to be ready).
  const vauth = getVkinAuth();
  // Never switch stores under a meeting that already started (its drafts belong to the open session).
  if (vauth) vauth.userId().then((id) => (id && !running && !vkinCtl.hasOpenSession() ? vkinCtl.switchAccount(id) : null)).catch((err) => log('vkin session restore failed', err.message));
  // Microphone and screen audio only for the hidden capture window; every other page is refused.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' && Boolean(capture) && !capture.isDestroyed() && wc === capture.webContents));
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    if (!capture || capture.isDestroyed() || !req.frame || !isPage(req.frame.url, 'capture.html')) { log('display media refused'); cb({}); return; }
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => cb({ video: sources[0], audio: 'loopback' }))
      .catch((err) => { log('display media error', err.message); cb({}); });
  });
  createWindows();
  createTray();
  registerHotkeys();
  startMirror();
  // The meeting board (prep window) opens with the tool unless config.ui.openPrepOnStart is false;
  // COPILOT_OPEN_PREP=1/0 forces it on/off for one launch.
  if (openPrepOnStart()) openPrep();
});

// Close a live Vkin lease before quitting (at most 2 s), so the account is free for another device at
// once. If this fails, the server ends the lease after 45 s without a beat and bills nothing extra.
let quitAfterLease = false;
app.on('before-quit', (e) => {
  if (quitAfterLease || !hosted.hasLease()) return;
  e.preventDefault();
  quitAfterLease = true;
  Promise.race([hosted.stop(), new Promise((r) => setTimeout(r, 2000))]).finally(() => app.quit());
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  audio.stop();
  if (vkinAuth) vkinAuth.dispose();
  for (const ch of Object.keys(stt)) stt[ch].stop();
  if (mirror) mirror.stop();
});
