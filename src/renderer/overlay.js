const api = window.copilot.ui;
const OS = globalThis.OverlayState;
const BV = globalThis.BudgetView;
const { parse, answerText, clock, lastWords, viewed } = OS; // parse: ID stripping + SAY parsing
/** @param {string} id @returns {HTMLInputElement & HTMLImageElement} */
const $ = (id) => /** @type {any} */ (document.getElementById(id));

let state = { running: false, providers: {}, llm: {}, startedAt: null };
let ov = OS.initial(); // answer history + live card (pure reducer)
let strip = null; // THEM's open utterance
let compact = false;
let shownKey = null; // genId of the card last rendered, to reset scroll on change

function dispatch(ev) {
  ov = OS.reduce(ov, ev);
  renderAnswer();
}

// Validation badge ("✓ grounded", "✂ trimmed…", "checking facts…"). Created here because overlay.html
// is outside this change; it sits between the Answer label and the text. textContent/title only.
const valBadge = document.createElement('div');
valBadge.id = 'valBadge';
valBadge.className = 'valbadge hidden';
$('say').parentNode.insertBefore(valBadge, $('say'));

// ---- rendering -----------------------------------------------------------------------------
// Prose goes in as plain text, as before. A fenced code block (coding answers) becomes <pre><code> built with
// textContent only: whatever the model or the screen produced is displayed, never interpreted or run.
function renderSay(el, say) {
  const parts = OS.segments(say);
  if (parts.length === 1 && parts[0].type === 'text') { el.textContent = parts[0].text; return; }
  el.textContent = '';
  for (const part of parts) {
    if (part.type === 'text') {
      const d = document.createElement('div');
      d.className = 'sayText';
      d.textContent = part.text;
      el.appendChild(d);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'codeBlock';
      if (part.lang) pre.setAttribute('data-lang', part.lang);
      const code = document.createElement('code');
      code.textContent = part.code;
      pre.appendChild(code);
      el.appendChild(pre);
    }
  }
}
function renderAnswer() {
  const v = viewed(ov);
  const c = v.card;
  const card = $('card');
  card.className = 'card';
  $('reqLine').classList.add('hidden');
  $('qLine').classList.add('hidden');
  $('points').innerHTML = '';

  if (!c) {
    card.classList.add('empty');
    $('ansLab').classList.add('hidden');
    $('say').textContent = state.running ? 'Listening…' : 'Press Start, then Ctrl+Shift+Space to answer.';
  } else {
    if (c.kind === 'speculative') card.classList.add('speculative');
    if (c.error) card.classList.add('error');
    if (c.validation && c.validation.action === 'regenerating') card.classList.add('regenerating');
    if (c.request) {
      $('reqLine').textContent = `You asked: ${c.request}`;
      $('reqLine').classList.remove('hidden');
    }
    if (c.question) {
      $('qText').textContent = c.question;
      $('qLine').classList.toggle('small', !!c.request);
      $('qLine').classList.remove('hidden');
    }
    $('ansLab').classList.remove('hidden');
    const { say, points } = parse(c.text);
    renderSay($('say'), c.error ? `Error: ${c.error}` : say || '…');
    for (const p of points) {
      const li = document.createElement('li');
      li.textContent = p;
      $('points').appendChild(li);
    }
  }
  const badge = c && !c.error ? OS.validationBadge(c) : null;
  valBadge.className = badge ? `valbadge ${badge.cls}` : 'valbadge hidden';
  valBadge.textContent = badge ? badge.text : '';
  valBadge.title = badge ? badge.title : '';

  if ((c ? c.genId : null) !== shownKey) {
    shownKey = c ? c.genId : null;
    $('scroll').scrollTop = 0;
  }

  // history bar
  $('pos').textContent = v.total ? `${c ? v.index + 1 : '–'}/${v.total}` : '–';
  $('prevBtn').disabled = !v.total || (!!c && v.index <= 0);
  $('nextBtn').disabled = !c || v.index >= v.total - 1;
  $('liveTag').classList.toggle('hidden', !v.isLive);
  $('newPill').classList.toggle('hidden', !ov.newPill);
  $('ended').classList.toggle('hidden', !ov.ended);

  // footer
  const parts = [];
  if (c) {
    parts.push(c.kind || 'answer');
    const t = clock(c.at, state.startedAt);
    if (t) parts.push(t);
    if (c.firstTokenMs != null) parts.push(`first token ${c.firstTokenMs} ms${c.hedged ? ' (backup request)' : ''}`);
  }
  $('meta').textContent = parts.join(' · ');
  for (const id of ['copyBtn', 'upBtn', 'downBtn', 'cardClear']) $(id).disabled = !c;
  $('cardClear').disabled = !c || v.index !== v.total - 1; // only the newest card can be cleared
  $('upBtn').classList.toggle('on', !!c && c.rating === 'up');
  $('downBtn').classList.toggle('on', !!c && c.rating === 'down');
  for (const b of /** @type {HTMLButtonElement[]} */ ([...$('chatChips').children])) b.disabled = !c;
}

function renderStrip() {
  const el = $('qchips');
  el.textContent = '';
  const live = strip && !strip.dismissed && strip.text.trim();
  $('qstrip').classList.toggle('final', !!(strip && strip.final));
  if (!live) {
    const s = document.createElement('span');
    s.className = 'empty-strip';
    s.textContent = 'Listening for a question…';
    el.appendChild(s);
    return;
  }
  const { words, more } = lastWords(strip.text, 12);
  for (const w of more ? ['…', ...words] : words) {
    const s = document.createElement('span');
    s.className = 'chip';
    s.textContent = w;
    el.appendChild(s);
  }
}

function dotClass(s) {
  if (!s) return 'dot';
  if (String(s).startsWith('error')) return 'dot err';
  if (s === 'open' || s === 'live') return 'dot ok';
  if (s === 'connecting' || s === 'starting') return 'dot warn';
  return 'dot';
}

function renderStatus() {
  const run = $('runBtn');
  run.textContent = state.running ? 'Stop' : 'Start';
  run.classList.toggle('live', !!state.running);
  const auto = state.autoAnswer !== false;
  $('autoMark').textContent = auto ? 'on' : 'off (manual)';
  $('autoMark').classList.toggle('on', auto);
  $('autoBtn').setAttribute('aria-checked', String(auto));
  if (auto && $('pendingNote').textContent.startsWith('Question waiting')) showNote('');
  for (const [ch, id] of [['them', 'dotThem'], ['me', 'dotMe']]) {
    const cap = state.capture && state.capture[ch];
    const st = state.stt && state.stt[ch];
    const worst = [cap, st].find((s) => String(s || '').startsWith('error')) || (cap === 'live' ? st : cap);
    $(id).className = dotClass(worst);
    const a = state.audio && state.audio.health && state.audio.health[ch];
    const src = state.audio && state.audio.source !== 'none'
      ? ` | source: ${state.audio.source}${state.audio.aec && ch === 'me' ? ' (echo-cancelled)' : ''}${a ? `, ${a.state}${a.dropouts ? `, ${a.dropouts} dropouts` : ''}` : ''}`
      : '';
    const fb = state.audio && state.audio.fallbackReason ? ` | fallback: ${state.audio.fallbackReason}` : '';
    $(id).title = `capture: ${cap || '-'} | stt: ${st || '-'}${src}${fb}`;
  }
  const sel = $('modelSel');
  const want = `${state.llm.provider}|${state.llm.model}`;
  if (sel.dataset.sig !== JSON.stringify(state.providers)) {
    sel.innerHTML = '';
    for (const [prov, p] of Object.entries(state.providers || {})) {
      for (const m of p.models) {
        const o = document.createElement('option');
        o.value = `${prov}|${m}`;
        o.textContent = `${prov}: ${m.split('/').pop()}`;
        sel.appendChild(o);
      }
    }
    sel.dataset.sig = JSON.stringify(state.providers);
  }
  sel.value = want;
  const note = state.llm.provider && state.llm.provider !== 'nebius' ? state.llm.privacyNote : '';
  $('privacy').textContent = note || '';
  $('privacy').classList.toggle('hidden', !note);
  if (state.mirror) {
    $('phoneBody').innerHTML = '';
    const img = document.createElement('img');
    img.src = state.mirror.qr;
    const p = document.createElement('div');
    p.textContent = 'Scan on your phone (same Wi-Fi), or type:';
    const u = document.createElement('code');
    u.textContent = state.mirror.url;
    $('phoneBody').append(img, p, u);
  }
}

// ---- budget dashboard + live-call kill switch ------------------------------------------------
let budget = null; // last `budget` payload from main
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const kv = (parent, pairs) => {
  const g = el('div', 'kv');
  for (const [k, v, cls] of pairs) g.append(el('span', null, k), el('span', cls, v));
  parent.append(g);
};
function table(parent, title, byX, keyFmt = (k) => k) {
  const r = BV.rows(byX);
  if (!r.length) return;
  const t = el('div', 'tbl');
  for (const x of r) {
    const k = el('span', null, keyFmt(x.key));
    k.title = x.key;
    t.append(k, el('span', null, BV.usd(x.usd)), el('span', null, x.count == null ? '' : `×${x.count}`));
  }
  parent.append(el('h4', null, title), t);
}
function banners(parent, S, label) {
  const p = label ? `${label}: ` : '';
  if (S.corrupt) parent.append(el('div', 'banner err', `${p}Ledger unreadable (line ${S.badLine == null ? '?' : S.badLine}): all live calls blocked`));
  const w = BV.warnBanner(S.warnLevel);
  if (w) parent.append(el('div', `banner ${w.tone}`, p + w.text));
}
function section(parent, name, S) {
  parent.append(el('h3', null, name));
  const tk = S.tokens || {}, n = (v) => (v == null ? '–' : v);
  const open = Array.isArray(S.openReservations) ? S.openReservations.length : 0;
  const rej = S.rejected || {};
  kv(parent, [
    ['Live calls', S.liveEnabled ? 'on' : 'off', S.liveEnabled ? null : 'red'],
    ['Committed', BV.usd(S.committedUsd)],
    ['Settled', BV.usd(S.settledUsd)],
    ['Open reservations', `${open} · ${BV.usd(S.openReservedUsd)}`],
    ['Requests today / session', `${n(S.requestsToday)} / ${n(S.requestsSession)}`],
    ['Tokens in / out / reasoning', `${n(tk.input)} / ${n(tk.output)} / ${n(tk.reasoning)}`],
    ['Cache hit rate', BV.cacheRate(S.cache)],
    ['Rejected', n(rej.total)],
  ]);
  const codes = Object.entries(rej.byCode || {}).sort((a, b) => b[1] - a[1]);
  if (codes.length) kv(parent, codes.map(([c, k]) => [`  ${c}`, String(k)]));
  table(parent, 'By model', S.byModel, BV.shortModel);
  table(parent, 'By route', S.byRoute);
  table(parent, 'By bucket', S.byBucket);
  table(parent, 'By session', S.bySession, (k) => BV.shortId(k));
}
function renderBudget() {
  const body = $('budgetBody'), top = body.scrollTop, b = budget;
  if (!b) {
    body.textContent = 'No budget data yet.';
    return;
  }
  const f = document.createDocumentFragment(), N = b.nebius || {}, G = b.gemini || {};
  const used = BV.pct(N.committedUsd, N.hardStopUsd);
  const head = el('div', 'bhead');
  head.append(el('span', 'bbig', `${BV.usd(N.remainingUsableUsd, 2)} of ${BV.usd(N.hardStopUsd, 2)}`), el('span', 'muted', 'remaining usable'));
  const bar = el('div', `bbar${used >= 90 ? ' err' : used >= 75 ? ' warn' : ''}`);
  bar.style.setProperty('--w', `${used}%`);
  f.append(head, bar);
  kv(f, [
    ['Committed / hard stop', `${BV.usd(N.committedUsd)} (${used}%)`],
    ['Protected reserve', `${BV.usd(N.protectedReserveUsd, 2)} (locked)`],
    ['Total budget', BV.usd(N.totalBudgetUsd, 2)],
  ]);
  banners(f, N, '');
  section(f, 'Nebius', N);
  section(f, 'Gemini', G);
  banners(f, G, 'Gemini');

  f.append(el('h3', null, 'Price registry'));
  const now = Date.now();
  kv(f, [['Nebius', N], ['Gemini', G]].map(([name, S]) => {
    const d = BV.dateOnly(S.priceRefreshedAt), stale = BV.isStale(S.priceRefreshedAt, now, S.priceMaxAgeDays || 30);
    return [name, `${S.priceVersion || '–'} · ${d || 'refresh date unknown'}${stale ? ' · stale' : ''}`, stale ? 'amber' : null];
  }));

  f.append(el('h3', null, 'Routes'));
  const r = b.routes || {};
  kv(f, ['default', 'utility', 'deep', 'personal', 'gemini_fallback'].map((k) => [k, BV.shortModel(r[k]) || '–']).concat([['gemini fallback mode', b.geminiFallback || '–']]));

  const foot = el('div', 'bfoot');
  const list = el('ul');
  for (const t of [
    'Nebius: set a spending alert and lower your quota in the Token Factory console (Billing/Limits).',
    'Gemini: set a budget alert in Google Cloud Billing, or keep the free tier and its rate limits.',
    'Deepgram: set a usage alert in the Deepgram console.',
  ]) list.append(el('li', null, t));
  foot.append(el('div', null, 'Engineering control only; provider billing may differ.'), el('div', null, 'Set provider-side protection too:'), list);
  f.append(foot);
  body.replaceChildren(f);
  body.scrollTop = top;
}
function renderLive() {
  const N = budget && budget.nebius, G = budget && budget.gemini, pill = $('aiPill');
  pill.disabled = !N;
  const mark = (id, S) => {
    $(id).textContent = S ? (S.liveEnabled ? 'On' : 'Off') : '–';
    $(id).classList.toggle('on', !!(S && S.liveEnabled));
  };
  mark('liveMark', N);
  mark('gemMark', G);
  if (!N) return;
  // 'blocked' = switched on, but the guard would refuse the next call (hard stop, stale price, limits, corrupt ledger).
  const on = !!N.liveEnabled, blocked = on && N.blocked && N.blocked !== 'BUDGET_KILL_SWITCH' ? N.blocked : null;
  const lvl = N.corrupt || blocked || N.warnLevel >= 90 ? 'err' : N.warnLevel === 75 ? 'warn' : null;
  pill.className = `pill ${on && !blocked ? 'on' : 'off'}`;
  $('aiPillTxt').textContent = blocked ? 'AI blocked' : on ? 'AI on' : 'AI off';
  $('aiWarn').className = `wdot${lvl === 'err' ? ' err' : ''}${lvl ? '' : ' hidden'}`;
  pill.title = (on ? 'Live AI calls are on. Click to turn off.' : "Live AI calls are off; answers won't be generated. Click to turn on.") +
    (blocked ? ` Calls are blocked: ${blocked}.` : N.corrupt ? ' Ledger unreadable: calls are blocked.' : N.warnLevel ? ` Budget ${N.warnLevel}% used.` : '');
}
function onBudget(b) {
  if (!b || typeof b !== 'object') return;
  budget = b;
  renderLive();
  if (!$('budgetPanel').classList.contains('hidden')) renderBudget();
}
async function refreshBudget() {
  try {
    onBudget(await api.invoke('getBudget'));
  } catch (_) { /* main may not expose it yet */ }
}
function toggleLive(provider) {
  const S = budget && budget[provider];
  if (!S) return;
  api.send('setLive', { provider, value: !S.liveEnabled });
  refreshBudget(); // same IPC channel, so this runs after the toggle; also covers a missing push event
}

// ---- chat box ------------------------------------------------------------------------------
function setChat(open) {
  $('chatBox').classList.toggle('hidden', !open);
  $('chatBtn').classList.toggle('on', open);
  if (open) $('chatInput').focus();
}

function sendChat(text) {
  text = String(text || '').trim();
  if (!text) return;
  const c = viewed(ov).card; // refinements apply to the card being looked at
  api.send('chat', c ? { text, question: c.question || c.request || '', previousAnswer: answerText(c) } : { text });
}

// ---- events from main ----------------------------------------------------------------------
const watchWarnings = new Map(); // 'channel:code' -> message, from the transcription watchdog
let lastLeaseId = null; // hosted mode: the current Vkin session lease
api.onEvent((msg) => {
  switch (msg.type) {
    case 'status': {
      const wasRunning = state.running;
      state = { ...state, ...msg };
      renderStatus();
      if (state.running && !wasRunning) ov = OS.reduce(ov, { type: 'sessionStart' });
      renderAnswer();
      break;
    }
    case 'watchdog': {
      // Audio/transcription health warnings stay visible until their condition clears.
      const key = `${msg.channel}:${msg.code}`;
      if (msg.state === 'warn') watchWarnings.set(key, `${msg.channel === 'them' ? 'Meeting audio' : 'Your mic'}: ${msg.message}`);
      else watchWarnings.delete(key);
      showNote([...watchWarnings.values()].join(' '));
      break;
    }
    case 'level': {
      const el = $(msg.channel === 'them' ? 'lvlThem' : 'lvlMe');
      el.style.setProperty('--l', `${Math.min(100, Math.round(Math.sqrt(msg.level || 0) * 140))}%`);
      break;
    }
    case 'transcript':
      strip = OS.stripReduce(strip, msg);
      renderStrip();
      break;
    case 'answer:start':
      showNote('');
      dispatch({ ...msg, at: Date.now() });
      break;
    case 'manualPending':
      showNote(`Question waiting: press Answer (Ctrl+Shift+Space). "${String(msg.question || '').slice(0, 90)}"`);
      break;
    case 'topicCleared':
      showNote('Topic cleared: the next question starts fresh.', 4000);
      break;
    case 'screenRequest':
      openScreen();
      break;
    case 'screenDiscarded':
      // Main dropped the screenshot (timeout, panic): nothing of it stays on screen either.
      $('screenPanel').classList.add('hidden');
      $('screenQ').value = '';
      resetScreen();
      break;
    case 'answer:delta':
    case 'answer:promote':
    case 'answer:invalidate':
    case 'answer:done':
    case 'answer:error':
    case 'answer:validated':
    case 'answer:replace':
    case 'nav':
    case 'sessionEnd':
      dispatch(msg);
      break;
    case 'budget':
      onBudget(msg);
      break;
    case 'hostedNotice':
      showNote(String(msg.message || ''), 10000);
      break;
    case 'hosted': {
      // Minutes left on the Vkin account (server-metered). Shown when a session starts and near the end.
      const left = Number.isFinite(msg.remainingSeconds) ? Math.max(0, Math.ceil(msg.remainingSeconds / 60)) : null;
      const fresh = msg.leaseId && msg.leaseId !== lastLeaseId;
      lastLeaseId = msg.leaseId || null;
      if (left != null && msg.leaseId && (fresh || msg.remainingSeconds <= 120)) showNote(`Vkin: ${left} min left`, fresh ? 5000 : 0);
      break;
    }
    case 'focusChat':
      setChat(true);
      break;
    case 'clickThrough':
      $('ctNote').classList.toggle('hidden', !msg.value);
      break;
    case 'scroll':
      $('scroll').scrollBy({ top: msg.dir * 80 });
      break;
    default:
      break;
  }
});

// ---- UI handlers ---------------------------------------------------------------------------
let noteTimer = null;
function showNote(text, ms = 0) {
  clearTimeout(noteTimer);
  $('pendingNote').textContent = text;
  $('pendingNote').classList.toggle('hidden', !text);
  if (text && ms) noteTimer = setTimeout(() => showNote(''), ms);
}

const closeMenu = () => {
  $('menu').classList.add('hidden');
  $('menuBtn').setAttribute('aria-expanded', 'false');
};
const menuItem = (id, fn) => {
  $(id).onclick = () => {
    closeMenu();
    fn();
  };
};

$('runBtn').onclick = () => api.send(state.running ? 'stop' : 'start');
$('answerBtn').onclick = () => api.send('answer');
$('chatBtn').onclick = () => setChat($('chatBox').classList.contains('hidden'));
$('endBtn').onclick = () => api.send('end');
$('hideBtn').onclick = () => api.send('hide');
$('modelSel').onchange = (e) => {
  const [provider, model] = /** @type {HTMLSelectElement} */ (e.target).value.split('|');
  api.send('setModel', { provider, model });
};

$('menuBtn').onclick = (e) => {
  e.stopPropagation();
  const open = $('menu').classList.toggle('hidden') === false;
  $('menuBtn').setAttribute('aria-expanded', String(open));
};
document.addEventListener('click', (e) => {
  if (!/** @type {Element} */ (e.target).closest('.menuWrap')) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeMenu();
  $('budgetPanel').classList.add('hidden');
});
menuItem('notesBtn', async () => {
  $('notesText').value = await api.invoke('getNotes');
  $('notesPanel').classList.remove('hidden');
});
menuItem('liveBtn', () => toggleLive('nebius'));
menuItem('gemBtn', () => toggleLive('gemini'));
menuItem('budgetBtn', () => {
  $('budgetPanel').classList.remove('hidden');
  renderBudget();
  refreshBudget();
});
$('aiPill').onclick = () => toggleLive('nebius');
$('budgetClose').onclick = () => $('budgetPanel').classList.add('hidden');
menuItem('phoneBtn', () => $('phonePanel').classList.toggle('hidden'));
menuItem('opacityBtn', () => api.send('cycleOpacity'));
menuItem('regenBtn', () => api.send('regenerate'));
menuItem('prepBtn', () => api.send('openPrep'));
menuItem('autoBtn', () => api.send('setAutoAnswer', { value: state.autoAnswer === false }));
menuItem('clearTopicBtn', () => api.send('clearTopic'));
menuItem('panicBtn', () => api.send('panic'));
menuItem('screenBtn', () => openScreen());

// ---- screen context (PRD Phase 5): manual, previewed, one turn, discarded after use ----
let shotId = null;
const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
function screenStatus(text, isErr = false) {
  $('screenStatus').textContent = text;
  $('screenStatus').classList.toggle('err', isErr);
}
function resetScreen() {
  shotId = null;
  $('screenImg').classList.add('hidden');
  $('screenImg').removeAttribute('src');
  $('screenText').classList.add('hidden');
  $('screenText').textContent = '';
  $('screenAnswerBtn').disabled = true;
}
async function openScreen() {
  $('screenPanel').classList.remove('hidden');
  resetScreen();
  screenStatus('Capturing…');
  try {
    const s = await api.invoke('screenCapture');
    shotId = s.id;
    $('screenImg').src = s.preview;
    $('screenImg').classList.remove('hidden');
    screenStatus(`${s.width}×${s.height}. Nothing is sent until you choose.`);
  } catch (e) {
    screenStatus(`Capture failed: ${errText(e)}`, true);
  }
}
async function interpretScreen(cmd, label) {
  if (!shotId) return screenStatus('Take a screenshot first.', true);
  screenStatus(`${label}…`);
  $('screenOcrBtn').disabled = true;
  $('screenVisionBtn').disabled = true;
  try {
    const r = await api.invoke(cmd, { id: shotId, question: $('screenQ').value });
    $('screenText').textContent = r.text || '(no text found)';
    $('screenText').classList.remove('hidden');
    $('screenAnswerBtn').disabled = !r.text;
    screenStatus(r.source === 'ocr' ? `Read on this PC in ${r.ms} ms.` : `Described by ${r.model || 'Gemini'}.`);
  } catch (e) {
    const msg = errText(e);
    screenStatus(/KILL_SWITCH|Live AI is off|AI off/i.test(msg) ? 'Gemini is off: turn on "Gemini fallback" in the ⋮ menu (free tier; Google may use what you send).' : msg, true);
  } finally {
    $('screenOcrBtn').disabled = false;
    $('screenVisionBtn').disabled = false;
  }
}
$('screenOcrBtn').onclick = () => interpretScreen('screenOcr', 'Reading text on this PC');
$('screenVisionBtn').onclick = () => interpretScreen('screenVision', 'Asking Gemini');
$('screenAnswerBtn').onclick = async () => {
  try {
    await api.invoke('screenAnswer', { question: $('screenQ').value });
    $('screenPanel').classList.add('hidden');
    $('screenQ').value = '';
    resetScreen();
  } catch (e) { screenStatus(errText(e), true); }
};
$('screenSaveBtn').onclick = async () => {
  try { if (await api.invoke('screenSave')) screenStatus('Saved.'); } catch (e) { screenStatus(errText(e), true); }
};
$('screenDiscardBtn').onclick = () => {
  api.invoke('screenDiscard').catch(() => {});
  $('screenPanel').classList.add('hidden');
  $('screenQ').value = '';
  resetScreen();
};
menuItem('compactBtn', () => {
  compact = !compact;
  document.body.classList.toggle('compact', compact);
  $('compactBtn').setAttribute('aria-checked', String(compact));
  $('compactMark').textContent = compact ? 'on' : 'off';
  $('compactMark').classList.toggle('on', compact);
});

$('notesSave').onclick = async () => {
  await api.invoke('saveNotes', { text: $('notesText').value });
  $('notesPanel').classList.add('hidden');
};
$('notesClose').onclick = () => $('notesPanel').classList.add('hidden');
$('phoneClose').onclick = () => $('phonePanel').classList.add('hidden');

$('prevBtn').onclick = () => dispatch({ type: 'nav', dir: -1 });
$('nextBtn').onclick = () => dispatch({ type: 'nav', dir: 1 });
$('newPill').onclick = () => dispatch({ type: 'jumpLive' });
$('qClear').onclick = () => {
  strip = OS.stripReduce(strip, { type: 'clearStrip' });
  renderStrip();
};

$('copyBtn').onclick = () => {
  const c = viewed(ov).card;
  if (c) api.send('copy', { text: answerText(c), genId: c.genId });
};
for (const [id, rating] of [['upBtn', 'up'], ['downBtn', 'down']]) {
  $(id).onclick = () => {
    const c = viewed(ov).card;
    if (!c) return;
    api.send('feedback', { genId: c.genId, rating, question: c.question || '', text: answerText(c) });
    dispatch({ type: 'rate', genId: c.genId, rating });
  };
}
$('cardClear').onclick = () => dispatch({ type: 'clear' });

$('chatInput').onkeydown = (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    setChat(false);
  } else if (e.key === 'Enter' && !e.isComposing) {
    sendChat($('chatInput').value);
    $('chatInput').value = '';
  }
};
for (const b of /** @type {HTMLElement[]} */ ([...$('chatChips').children])) b.onclick = () => (b.id === 'deepChip' ? api.send('regenerate', { deep: true }) : sendChat(b.dataset.t));

renderStatus();
renderStrip();
renderAnswer();
api.send('ready');
refreshBudget();

// Dropped files are never opened in this window (main also refuses navigation).
for (const ev of ['dragover', 'drop']) document.addEventListener(ev, (e) => e.preventDefault());
