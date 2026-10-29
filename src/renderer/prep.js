// Prep window ("AI Background"). All data goes through window.copilot.prep.invoke; this page never
// touches files or keys. User text is always inserted with textContent.
(function () {
  const api = window.copilot.prep;
  /** @param {string} id @returns {HTMLInputElement & HTMLImageElement} */
  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  let info = null; // list payload: sessions, templates, brain, model, running...
  let cur = null; // selected session

  const PREFS = [
    { key: 'length', label: 'Length', options: [['short', 'Short'], ['medium', 'Balanced'], ['long', 'Detailed']] },
    { key: 'tone', label: 'Tone', options: [['conversational', 'Conversational'], ['professional', 'Professional'], ['formal', 'Formal']] },
    { key: 'star', label: 'STAR stories', options: [['auto', 'Automatic'], ['manual', 'Only when asked for an example'], ['disabled', 'Never']] },
    { key: 'fillerIntensity', label: 'Filler words', options: [['none', 'None'], ['subtle', 'Subtle'], ['normal', 'Normal']] },
    { key: 'technicalDepth', label: 'Technical depth', options: [['light', 'Light'], ['standard', 'Standard'], ['deep', 'Deep']] },
    { key: 'format', label: 'Format', options: [['prose', 'Spoken prose'], ['bullets', 'Short talking points']] },
    { key: 'language', label: 'Answer language', options: ['English', 'Spanish', 'French', 'German', 'Hindi', 'Portuguese', 'Mandarin Chinese', 'Japanese'].map((l) => [l, l]) },
    { key: 'showStarLabels', label: 'Show STAR labels', options: [['false', 'No'], ['true', 'Yes']] },
  ];

  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }

  let toastTimer = null;
  function toast(msg, isErr = false) {
    clearTimeout(toastTimer);
    $('toast').textContent = msg;
    $('toast').classList.toggle('err', isErr);
    $('toast').classList.remove('hidden');
    toastTimer = setTimeout(() => $('toast').classList.add('hidden'), isErr ? 7000 : 3500);
  }
  async function call(cmd, args, okMsg) {
    try {
      const r = await api.invoke(cmd, args);
      if (okMsg) toast(okMsg);
      return r;
    } catch (err) {
      toast(String(err && err.message ? err.message : err).replace(/^Error invoking remote method 'prep:cmd': (Error: )?/, ''), true);
      throw err;
    }
  }

  // ---- sessions list ----
  async function refreshList(selectId) {
    info = await call('list', {});
    const ul = $('sessions');
    ul.textContent = '';
    for (const s of info.sessions) {
      const li = el('li', { tabindex: '0', role: 'button' },
        el('span', { class: 't', text: s.title || s.id }),
        el('span', { class: 'm', text: [s.person, s.date, s.active ? 'active' : '', s.expired ? 'expired' : ''].filter(Boolean).join(' · ') }));
      if (cur && cur.id === s.id) li.classList.add('sel');
      li.onclick = () => select(s.id);
      li.onkeydown = (e) => { if (e.key === 'Enter') select(s.id); };
      ul.append(li);
    }
    $('loaded').textContent = info.loadedMeeting ? `Loaded now: ${info.loadedMeeting}` : 'No meeting loaded (general mode).';
    $('empty').classList.toggle('hidden', Boolean(cur) || !$('newForm').classList.contains('hidden'));
    if (selectId) await select(selectId);
  }

  async function select(id) {
    cur = await call('get', { id });
    $('newForm').classList.add('hidden');
    $('empty').classList.add('hidden');
    $('detail').classList.remove('hidden');
    for (const li of $('sessions').children) li.classList.toggle('sel', li.querySelector('.t').textContent === (cur.session.title || cur.id));
    render();
  }

  // ---- new session ----
  function openNew() {
    cur = null;
    $('detail').classList.add('hidden');
    $('empty').classList.add('hidden');
    $('newForm').classList.remove('hidden');
    const sel = $('nfTemplate');
    sel.textContent = '';
    sel.append(el('option', { value: '', text: 'Blank' }));
    for (const t of info.templates) sel.append(el('option', { value: t.id, text: t.name }));
    $('nfDate').value = new Date().toISOString().slice(0, 10);
    $('nfTitle').focus();
  }
  $('nfTemplate').onchange = () => {
    const t = info.templates.find((x) => x.id === $('nfTemplate').value);
    if (t) { if (!$('nfTitle').value) $('nfTitle').value = t.name; $('nfDuration').value = t.durationMin; }
  };
  $('newBtn').onclick = openNew;
  $('emptyNew').onclick = openNew;
  $('nfCancel').onclick = () => { $('newForm').classList.add('hidden'); $('empty').classList.toggle('hidden', Boolean(cur)); };
  $('newForm').onsubmit = async (e) => {
    e.preventDefault();
    const s = await call('create', { input: { templateId: $('nfTemplate').value, title: $('nfTitle').value, person: $('nfPerson').value, organization: $('nfOrg').value, date: $('nfDate').value, durationMin: Number($('nfDuration').value) } }, 'Session created');
    await refreshList(s.id);
  };

  // ---- tabs ----
  for (const t of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.tab'))) {
    t.onclick = () => {
      for (const x of document.querySelectorAll('.tab')) x.classList.toggle('on', x === t);
      for (const p of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.pane'))) p.classList.toggle('hidden', p.dataset.pane !== t.dataset.tab);
    };
  }

  // ---- render selected session ----
  function render() {
    const s = cur.session;
    $('dTitle').textContent = s.title || cur.id;
    $('dSub').textContent = [s.person, s.organization, s.meetingType, s.date, cur.id].filter(Boolean).join(' · ');
    $('dActive').classList.toggle('hidden', !cur.active);
    $('sTitle').value = s.title || '';
    $('sPerson').value = s.person || '';
    $('sOrg').value = s.organization || '';
    $('sType').value = s.meetingType || '';
    $('sDate').value = s.date || '';
    $('sDuration').value = s.durationMin || 45;
    $('sMode').value = s.mode === 'manual' ? 'manual' : 'auto';
    $('sExpires').value = cur.expires || '';
    $('sSummary').value = cur.summary || '';
    $('sKeyterms').value = (cur.keyterms || []).join(', ');
    $('sEstimate').textContent = cur.estimate ? `Estimated cost: about $${cur.estimate.estimatedUsd} for ~${cur.estimate.expectedAnswers} answers (${cur.estimate.assumptions}). Budget left: ${budgetLeft()}.` : '';
    $('sModel').textContent = info.model ? `Model policy: ${info.model.default || 'default'} for answers; deep route ${info.model.deepRoute ? 'on' : 'off'}; live AI is ${info.model.liveAi ? 'on' : 'off'} (toggle it in the overlay).` : '';
    renderDocs('them');
    renderDocs('me');
    renderNotes();
    renderBrain();
    renderPrefs();
    $('vResult').textContent = '';
    $('aMsg').textContent = info.running ? 'Stop listening in the overlay before switching meetings.' : '';
    $('aActivate').disabled = info.running;
    $('aActivate').textContent = cur.active ? 'Reload this meeting' : 'Use this meeting';
  }

  function budgetLeft() {
    const b = info.budget && info.budget.nebius;
    if (!b || typeof b.remainingUsableUsd !== 'number') return 'unknown';
    return `$${b.remainingUsableUsd.toFixed(2)} before the hard stop`;
  }

  function renderDocs(side) {
    const tb = $(side === 'them' ? 'themDocs' : 'meDocs');
    tb.textContent = '';
    const docs = cur.documents.filter((d) => d.side === side);
    if (side === 'them' && cur.handWrittenRecords) tb.append(el('tr', {}, el('td', { colspan: '6', class: 'sub', text: `This pack also has ${cur.handWrittenRecords} hand-written records from its own files (kept as they are).` })));
    if (!docs.length) tb.append(el('tr', {}, el('td', { colspan: '6', class: 'sub', text: 'No imported documents yet.' })));
    for (const d of docs) {
      const second = side === 'them'
        ? el('td', { text: d.kind })
        : el('td', {}, (() => {
          const cb = el('input', { type: 'checkbox', 'aria-label': `Verified: ${d.name}` });
          cb.checked = d.approved === true;
          cb.onchange = async () => { cur = { ...(await call('approveDoc', { id: cur.id, docId: d.id, approved: cb.checked }, cb.checked ? 'Marked verified' : 'Marked unverified')), estimate: cur.estimate }; render(); };
          return cb;
        })());
      const warn = (d.warnings || []).length ? el('div', { class: 'warn', text: d.warnings.join('; ') }) : null;
      tb.append(el('tr', {},
        el('td', {}, el('div', { text: d.name }), el('div', { class: 'sub', text: `${d.format}${d.pages ? `, ${d.pages} pages` : ''}, ${d.chars} characters` }), warn),
        second,
        el('td', { text: String(d.records) }),
        el('td', { text: String(d.tokens) }),
        el('td', { class: `status-${d.status}`, text: d.status.replace(/-/g, ' ') }),
        el('td', {}, el('button', { class: 'btn small', text: 'Remove', onclick: async () => { cur = { ...(await call('removeDoc', { id: cur.id, docId: d.id }, 'Removed')), estimate: cur.estimate }; render(); } }))));
    }
  }

  async function importFor(side) {
    const files = await call('pickFiles', {});
    if (!files.length) return;
    const kind = side === 'them' ? $('themKind').value : 'personal';
    let ok = 0;
    for (const f of files) {
      try {
        const r = await call('import', { id: cur.id, filePath: f.path, side, kind, approved: side === 'me' && $('meVerified').checked });
        cur = { ...r.session, estimate: cur.estimate };
        ok += 1;
      } catch { /* toast already shown */ }
    }
    if (ok) toast(`Imported ${ok} of ${files.length} document(s)`);
    render();
  }
  $('themImport').onclick = () => importFor('them');
  $('meImport').onclick = () => importFor('me');

  function renderNotes() {
    for (const side of ['them', 'me']) {
      const box = $(side === 'them' ? 'themNotes' : 'meNotes');
      box.textContent = '';
      for (const n of cur.typed.filter((x) => x.side === side)) {
        box.append(el('div', { class: 'note' },
          el('div', {}, el('div', { class: 'nt', text: n.title }), el('div', { class: 'nx', text: n.text })),
          el('button', { class: 'btn small', text: 'Remove', onclick: async () => { cur = { ...(await call('removeNote', { id: cur.id, recordId: n.id })), estimate: cur.estimate }; render(); } })));
      }
    }
    const r = $('restricted');
    r.textContent = '';
    cur.restricted.forEach((x, i) => {
      r.append(el('div', { class: 'note' },
        el('div', {}, el('div', { class: 'nt', text: x.phrase }), el('div', { class: 'nx', text: x.reason })),
        x.custom ? el('span', { class: 'sub', text: 'pack rule' }) : el('button', { class: 'btn small', text: 'Remove', onclick: () => saveRestricted(cur.restricted.filter((_, j) => j !== i)) })));
    });
  }

  async function addNote(side) {
    const kind = side === 'them' ? $('themNoteKind').value : 'personal';
    const title = $(side === 'them' ? 'themNoteTitle' : 'meNoteTitle').value;
    const text = $(side === 'them' ? 'themNoteText' : 'meNoteText').value;
    cur = { ...(await call('addNote', { id: cur.id, note: { side, kind, title, text } }, 'Note added')), estimate: cur.estimate };
    $(side === 'them' ? 'themNoteTitle' : 'meNoteTitle').value = '';
    $(side === 'them' ? 'themNoteText' : 'meNoteText').value = '';
    render();
  }
  $('themNoteAdd').onclick = () => addNote('them');
  $('meNoteAdd').onclick = () => addNote('me');

  async function saveRestricted(list) {
    const own = list.filter((x) => !x.custom).map((x) => ({ phrase: x.phrase, reason: x.reason }));
    cur = { ...(await call('update', { id: cur.id, patch: { restricted: own } }, 'Restricted facts saved')), estimate: cur.estimate };
    render();
  }
  $('rAdd').onclick = () => {
    const phrase = $('rPhrase').value.trim();
    if (phrase.length < 2) return toast('Enter a phrase of at least 2 characters', true);
    saveRestricted([...cur.restricted, { phrase, reason: $('rReason').value.trim() }]);
    $('rPhrase').value = '';
    $('rReason').value = '';
  };

  function renderBrain() {
    const b = info.brain;
    if (!b) { $('brain').textContent = 'Personal brain not loaded.'; return; }
    const parts = Object.entries(b.byType || {}).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ');
    $('brain').textContent = `Your personal brain: ${b.total} verified records (${parts}). It comes from your CareerPro profile files; edit those to change it. What you add below applies to this meeting only.`;
  }

  function renderPrefs() {
    const g = $('prefGrid');
    g.textContent = '';
    for (const p of PREFS) {
      const sel = el('select', { id: `pref-${p.key}` });
      for (const [v, label] of p.options) sel.append(el('option', { value: v, text: label }));
      // Unsaved preferences show the app-wide default (config.answer).
      const val = cur.preferences[p.key] !== undefined ? cur.preferences[p.key] : (info.answerDefaults || {})[p.key];
      sel.value = String(val);
      if (sel.selectedIndex < 0) sel.selectedIndex = 0;
      g.append(el('label', {}, p.label, sel));
    }
    const max = el('input', { id: 'pref-maxSeconds', type: 'number', min: '0', max: '300', step: '5' });
    max.value = cur.preferences.maxSeconds || 0;
    g.append(el('label', {}, 'Longest answer (seconds, 0 = no limit)', max));
  }
  $('pSave').onclick = async () => {
    const prefs = {};
    for (const p of PREFS) {
      const v = $(`pref-${p.key}`).value;
      prefs[p.key] = p.key === 'showStarLabels' ? v === 'true' : v;
    }
    prefs.maxSeconds = Number($('pref-maxSeconds').value) || 0;
    cur = { ...(await call('update', { id: cur.id, patch: { preferences: prefs } }, cur.active ? 'Saved; applies to the next answer' : 'Saved')), estimate: cur.estimate };
    render();
  };

  $('sSave').onclick = async () => {
    const patch = {
      title: $('sTitle').value, person: $('sPerson').value, organization: $('sOrg').value, meetingType: $('sType').value,
      date: $('sDate').value, durationMin: Number($('sDuration').value), mode: $('sMode').value, expires: $('sExpires').value,
      summary: $('sSummary').value, keyterms: $('sKeyterms').value.split(',').map((x) => x.trim()).filter(Boolean),
    };
    await call('update', { id: cur.id, patch }, 'Saved');
    await refreshList(cur.id);
  };

  // ---- check & activate ----
  $('vRun').onclick = async () => {
    const v = await call('validate', { id: cur.id });
    const box = $('vResult');
    box.textContent = '';
    box.append(el('p', { class: v.ok ? 'ok' : 'err', text: v.ok ? 'Ready: the meeting pack loads cleanly.' : 'Needs fixing before it can be used.' }));
    if (v.errors.length) box.append(el('ul', { class: 'plain err' }, ...v.errors.map((e) => el('li', { text: e }))));
    if (v.warnings.length) box.append(el('ul', { class: 'plain warnTxt' }, ...v.warnings.map((w) => el('li', { text: w }))));
    if (v.stats) {
      const kinds = Object.entries(v.stats.byKind).map(([k, n]) => `${n} ${k}`).join(', ') || 'none';
      box.append(el('p', { class: 'sub', text: `${v.stats.records} records (${kinds}), about ${v.stats.tokens} tokens; ${v.stats.restricted} restricted rules; ${v.stats.exemplars} answer examples; expires ${v.stats.expires || 'never'}.` }));
    }
  };
  $('aActivate').onclick = async () => {
    await call('activate', { id: cur.id });
    $('aMsg').textContent = 'Saved. Restart the copilot to load this meeting.';
    $('aRestart').classList.remove('hidden');
    await refreshList(cur.id);
  };
  $('aRestart').onclick = () => call('restart', {});

  // ---- settings: encrypted API keys + updates ----
  async function openSettings() {
    cur = null;
    for (const id of ['detail', 'newForm', 'empty']) $(id).classList.add('hidden');
    $('settings').classList.remove('hidden');
    const k = await call('secretsStatus', {});
    const parts = [
      k.encryptionAvailable ? 'OS encryption is available.' : 'OS encryption is NOT available for this account.',
      k.encrypted.length ? `Encrypted: ${k.encrypted.join(', ')}.` : 'No keys are encrypted yet.',
      k.plaintextInEnvFile.length ? `Still in plain text in .env: ${k.plaintextInEnvFile.join(', ')}.` : 'No provider keys in plain text in .env.',
    ];
    $('keyStatus').textContent = parts.join(' ');
    $('keyProtect').disabled = !k.encryptionAvailable || !k.plaintextInEnvFile.length;
    renderUpdate(await call('updateStatus', {}));
  }
  function renderUpdate(u) {
    const s = { idle: 'Not checked yet.', checking: 'Checking…', current: 'You have the latest version.', downloading: `Downloading ${u.version || 'an update'}…`, ready: `Version ${u.version} is ready.`, error: `Update error: ${u.error || ''}`, disabled: '' }[u.status] || u.status;
    $('updStatus').textContent = u.enabled ? `${s} Feed: ${u.url}` : `Automatic updates are off: ${u.reason || u.error || ''}.`;
    $('updCheck').disabled = !u.enabled;
    $('updInstall').classList.toggle('hidden', u.status !== 'ready');
  }
  $('settingsBtn').onclick = () => openSettings();
  $('keyProtect').onclick = async () => {
    const r = await call('secretsProtect', {});
    toast(r.moved.length ? `Encrypted and removed from .env: ${r.moved.join(', ')}` : 'Nothing to move');
    openSettings();
  };
  $('updCheck').onclick = async () => renderUpdate(await call('updateCheck', {}));
  $('updInstall').onclick = () => call('updateInstall', {});
  const hideSettings = () => $('settings').classList.add('hidden');
  $('newBtn').addEventListener('click', hideSettings);
  $('emptyNew').addEventListener('click', hideSettings);
  $('sessions').addEventListener('click', hideSettings);

  refreshList().catch(() => {});
})();

// Dropped files are never opened in this window (main also refuses navigation).
for (const ev of ['dragover', 'drop']) document.addEventListener(ev, (e) => e.preventDefault());
