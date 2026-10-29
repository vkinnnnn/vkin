// "Copilots & memory" view of the prep window (docs/vkin-contracts.md). Everything goes through
// window.copilot.prep.invoke('vkin.*'); user text is inserted with textContent only.
(function () {
  const api = window.copilot.prep;
  /** @param {string} id @returns {any} */
  const $ = (id) => document.getElementById(id);
  const ORIGIN = { my_speech: 'you said', their_speech: 'they said', confirmed: 'confirmed', note: 'note' };
  const KINDS = ['topic', 'decision', 'open_question', 'action_item', 'commitment', 'fact'];
  let copilot = null;
  let thread = null;

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
  function toast(msg, isErr = false) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', isErr);
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), isErr ? 7000 : 3500);
  }
  async function call(cmd, args = {}, okMsg = '') {
    try {
      const r = await api.invoke(cmd, args);
      if (okMsg) toast(okMsg);
      return r;
    } catch (err) {
      toast(String(err && err.message ? err.message : err).replace(/^Error invoking remote method 'prep:cmd': (Error: )?/, ''), true);
      throw err;
    }
  }

  function show() {
    for (const id of ['detail', 'newForm', 'empty', 'settings']) $(id).classList.add('hidden');
    $('vkin').classList.remove('hidden');
    refresh();
  }
  // Any other sidebar action leaves this view.
  $('side').addEventListener('click', (e) => { if (!(e.target instanceof Element) || !e.target.closest('#vkinBtn')) $('vkin').classList.add('hidden'); }, true);
  $('vkinBtn').onclick = show;

  async function refreshAuth() {
    const s = await call('vkin.auth.status');
    const signedIn = Boolean(s.configured && s.signedIn);
    $('vAuth').textContent = !s.configured
      ? `Cloud sync is not set up on this computer (${s.reason}). Everything stays local.`
      : signedIn ? `Signed in as ${s.email || 'your account'}. Approved memory, copilots and threads sync with the web dashboard.`
        : 'Not signed in. Sign in with a one-time email code to sync with the web dashboard.';
    $('vSignIn').classList.toggle('hidden', !s.configured || signedIn);
    $('vSignedIn').classList.toggle('hidden', !signedIn);
    // Copilots made before signing in stay local until the user chooses to add them to the account.
    const local = signedIn ? (await call('vkin.local.list')).filter((c) => !c.local_only) : [];
    $('vAdopt').classList.toggle('hidden', !local.length);
    $('vAdoptMsg').textContent = local.length ? `${local.length} copilot(s) were created on this computer before you signed in.` : '';
  }
  $('vAdoptBtn').onclick = async () => {
    const r = await call('vkin.adoptLocal', { copilotIds: null, removeFromLocal: $('vAdoptRemove').checked });
    toast(`Added ${r.adopted.copilots} copilot(s), ${r.adopted.threads} thread(s) and ${r.adopted.memory_items} memory item(s) to your account. Sync to upload them.`);
    refresh();
  };
  $('vSignIn').onsubmit = async (e) => { e.preventDefault(); await call('vkin.auth.signIn', { email: $('vEmail').value.trim() }, 'Code sent: check your email'); };
  $('vVerify').onclick = async () => { await call('vkin.auth.verify', { email: $('vEmail').value.trim(), code: $('vCode').value.trim() }, 'Signed in'); $('vCode').value = ''; copilot = null; thread = null; refresh(); };
  $('vSignOut').onclick = async () => { await call('vkin.auth.signOut', { clearDeviceData: $('vWipe').checked }, 'Signed out'); copilot = null; thread = null; refresh(); };
  $('vSync').onclick = async () => {
    const r = await call('vkin.sync.now');
    toast(r.ok ? `Synced: ${r.pushed} sent, ${r.pulled} received${r.conflicts ? `, ${r.conflicts} need review` : ''}` : `Sync incomplete: ${(r.errors || []).length} error(s)`, !r.ok);
    refresh();
  };

  async function refresh() {
    refreshAuth().catch(() => {});
    const active = await call('vkin.active');
    $('vActive').textContent = active && active.copilot
      ? `Next meeting uses: ${active.copilot.name}${active.thread ? ` → thread "${active.thread.title}"` : ' → a new thread'}.`
      : 'No copilot selected: meetings run in general mode with nothing remembered.';
    const list = await call('vkin.copilots.list');
    const ul = $('vCopilots');
    ul.textContent = '';
    for (const c of list) {
      const li = el('li', { tabindex: '0', role: 'button' }, el('span', { class: 't', text: c.name }), el('span', { class: 'm', text: c.purpose || '' }));
      if (copilot && copilot.id === c.id) li.classList.add('sel');
      li.onclick = () => openCopilot(c);
      li.onkeydown = (e) => { if (e.key === 'Enter') openCopilot(c); };
      ul.append(li);
    }
    if (copilot) {
      copilot = list.find((c) => c.id === copilot.id) || null;
      if (copilot) await openCopilot(copilot, true); else { $('vCopilot').classList.add('hidden'); $('vThread').classList.add('hidden'); }
    }
  }

  async function openCopilot(c, keepThread = false) {
    copilot = c;
    if (!keepThread) thread = null;
    $('vCopilot').classList.remove('hidden');
    $('vCopilotName').textContent = c.name;
    const threads = await call('vkin.threads.list', { copilotId: c.id });
    const ul = $('vThreads');
    ul.textContent = '';
    for (const t of threads) {
      const li = el('li', { tabindex: '0', role: 'button' }, el('span', { class: 't', text: t.title || 'Untitled thread' }), el('span', { class: 'm', text: new Date(t.updated_at || t.created_at).toLocaleDateString() }));
      if (thread && thread.id === t.id) li.classList.add('sel');
      li.onclick = () => openThread(t);
      li.onkeydown = (e) => { if (e.key === 'Enter') openThread(t); };
      ul.append(li);
    }
    if (thread) await openThread(threads.find((t) => t.id === thread.id) || null);
    else $('vThread').classList.add('hidden');
  }

  async function openThread(t) {
    thread = t;
    if (!t) { $('vThread').classList.add('hidden'); return; }
    $('vThread').classList.remove('hidden');
    $('vThreadName').textContent = t.title || 'Untitled thread';
    const items = await call('vkin.memory.list', { threadId: t.id });
    renderSessions(await call('vkin.sessions.list', { threadId: t.id }), items);
    renderMemory($('vDrafts'), items.filter((i) => i.status === 'draft'), true);
    renderMemory($('vApproved'), items.filter((i) => i.status === 'approved'), false);
    $('vApproveAll').disabled = !items.some((i) => i.status === 'draft');
  }

  // Meetings with their notes. Notes are built only from memory the user approved for that meeting.
  function renderSessions(sessions, items) {
    const ul = $('vSessions');
    ul.textContent = '';
    if (!sessions.length) { ul.append(el('li', { class: 'm', text: 'No meetings yet. Select this thread, then press Start in the overlay.' })); return; }
    for (const s of [...sessions].reverse()) {
      const approved = items.filter((i) => i.session_id === s.id && i.status === 'approved').length;
      const when = `${new Date(s.started_at).toLocaleString()}${s.ended_at ? '' : ' · in progress'}`;
      const li = el('li', { class: 'mem' }, el('div', { class: 'm', text: when }));
      if (s.summary) li.append(el('pre', { class: 'notes', text: s.summary }));
      li.append(el('div', { class: 'row' },
        el('button', {
          class: 'btn', text: s.summary ? 'Rebuild notes' : 'Make notes from approved memory',
          onclick: async () => { await call('vkin.notes.compose', { threadId: thread.id, sessionId: s.id }, 'Notes saved'); openThread(thread); },
          ...(approved ? {} : { disabled: 'true', title: 'Approve memory from this meeting first' }),
        })));
      ul.append(li);
    }
  }

  function renderMemory(ul, items, editable) {
    ul.textContent = '';
    if (!items.length) { ul.append(el('li', { class: 'm', text: editable ? 'No drafts.' : 'Nothing approved yet.' })); return; }
    for (const i of items) {
      const meta = `${i.kind.replace('_', ' ')} · ${ORIGIN[i.origin] || i.origin}${i.source_at ? ` · ${new Date(i.source_at).toLocaleString()}` : ''}`;
      const li = el('li', { class: 'mem' }, el('div', { class: 'm', text: meta }));
      if (editable) {
        const kind = el('select', { 'aria-label': 'Kind' }, ...KINDS.map((k) => el('option', { value: k, text: k.replace('_', ' ') })));
        kind.value = i.kind;
        const text = el('textarea', { rows: '2', maxlength: '2000', 'aria-label': 'Memory text' });
        text.value = i.text;
        li.append(kind, text, el('div', { class: 'row' },
          el('button', { class: 'btn', text: 'Save', onclick: async () => { await call('vkin.memory.update', { id: i.id, patch: { kind: kind.value, text: text.value } }, 'Saved'); openThread(thread); } }),
          el('button', { class: 'btn primary', text: 'Approve', onclick: async () => { await call('vkin.memory.approve', { ids: [i.id] }, 'Approved'); openThread(thread); } }),
          el('button', { class: 'btn', text: 'Discard', onclick: async () => { await call('vkin.memory.forget', { id: i.id }, 'Discarded'); openThread(thread); } })));
      } else {
        li.append(el('div', { text: i.text }), el('div', { class: 'row' },
          el('button', { class: 'btn', text: 'Forget', onclick: async () => { await call('vkin.memory.forget', { id: i.id }, 'Forgotten: it will not be used again'); openThread(thread); } })));
      }
      ul.append(li);
    }
  }

  $('vNewCopilot').onsubmit = async (e) => {
    e.preventDefault();
    const c = await call('vkin.copilots.create', { fields: { name: $('vcName').value.trim(), purpose: $('vcPurpose').value.trim(), instructions: $('vcInstr').value.trim(), memory_scope: $('vcScope').value } }, 'Copilot created');
    $('vNewCopilot').reset();
    copilot = c;
    refresh();
  };
  $('vtAdd').onclick = async () => {
    if (!copilot) return;
    thread = await call('vkin.threads.create', { copilotId: copilot.id, title: $('vtTitle').value.trim() || 'New thread' }, 'Thread created');
    $('vtTitle').value = '';
    refresh();
  };
  $('vUseNew').onclick = async () => { if (copilot) { await call('vkin.select', { copilotId: copilot.id, threadId: null }, 'The next meeting starts a new thread'); refresh(); } };
  $('vUseThread').onclick = async () => { if (copilot && thread) { await call('vkin.select', { copilotId: copilot.id, threadId: thread.id }, 'The next meeting continues this thread'); refresh(); } };
  $('vApproveAll').onclick = async () => {
    const items = await call('vkin.memory.list', { threadId: thread.id });
    const ids = items.filter((i) => i.status === 'draft').map((i) => i.id);
    if (ids.length) await call('vkin.memory.approve', { ids }, `Approved ${ids.length}`);
    openThread(thread);
  };
  $('vtDelete').onclick = async () => {
    if (!thread || $('vtDelete').dataset.confirm !== thread.id) { $('vtDelete').dataset.confirm = thread && thread.id; $('vtDelete').textContent = 'Click again to delete the thread and its memory'; return; }
    await call('vkin.threads.delete', { id: thread.id }, 'Thread deleted');
    $('vtDelete').textContent = 'Delete thread';
    thread = null;
    refresh();
  };
  $('vcDelete').onclick = async () => {
    if (!copilot || $('vcDelete').dataset.confirm !== copilot.id) { $('vcDelete').dataset.confirm = copilot && copilot.id; $('vcDelete').textContent = 'Click again to delete the copilot, its threads and memory'; return; }
    await call('vkin.copilots.delete', { id: copilot.id }, 'Copilot deleted');
    $('vcDelete').textContent = 'Delete copilot';
    copilot = null;
    thread = null;
    refresh();
  };
})();
