/* global module */
// Pure overlay state: answer history reducer, live-question strip reducer and text helpers.
// Loaded with a plain <script> in the renderer (globalThis.OverlayState) and via require() in tests.
(function (root) {
  'use strict';

  const ID_RE = /\s*[([]?\b(?:PRJ|EXP|ACA|CERT|AWD|VOL)-\d{3}\b(?:\s*,\s*\b(?:PRJ|EXP|ACA|CERT|AWD|VOL)-\d{3}\b)*[)\]]?:?/g;
  const SRC_RE = /\[src:[^\]]*\]/gi;
  const SPEC = 'speculative';

  const tidy = (t) => t.replace(SRC_RE, '').replace(ID_RE, '').replace(/[ \t]{2,}/g, ' ');

  // Fenced code (```lang ... ```) alternates with prose. An unterminated fence (a streaming answer) runs to the end.
  function splitFences(text) {
    const parts = [];
    let cur = [];
    let inCode = false;
    for (const line of String(text || '').split('\n')) {
      const fence = /^\s*```/.test(line);
      if (!inCode && fence) { if (cur.length) parts.push({ code: false, lines: cur }); cur = [line]; inCode = true; } else if (inCode && fence) { cur.push(line); parts.push({ code: true, lines: cur }); cur = []; inCode = false; } else cur.push(line);
    }
    if (cur.length) parts.push({ code: inCode, lines: cur });
    return parts;
  }
  const hasFence = (t) => /^\s*```/m.test(String(t || ''));

  // Prose is tidied; code keeps its indentation and is never rewritten.
  function clean(text) {
    const t = String(text || '');
    if (!hasFence(t)) return tidy(t);
    return splitFences(t).map((p) => (p.code ? p.lines.join('\n') : tidy(p.lines.join('\n')))).join('\n');
  }

  // The say text as renderable pieces: {type: 'text', text} and {type: 'code', lang, code}. The renderer uses
  // textContent only, so nothing in a code block is ever interpreted as HTML or run.
  function segments(say) {
    const s = String(say || '');
    if (!hasFence(s)) return [{ type: 'text', text: s }];
    const out = [];
    for (const p of splitFences(s)) {
      if (!p.code) {
        const text = p.lines.join('\n').replace(/^\n+|\n+$/g, '');
        if (text.trim()) out.push({ type: 'text', text });
        continue;
      }
      const lang = (/^\s*```\s*([\w+#.-]{1,20})/.exec(p.lines[0]) || [])[1] || '';
      const body = p.lines.slice(1);
      if (body.length && /^\s*```\s*$/.test(body[body.length - 1])) body.pop();
      out.push({ type: 'code', lang, code: body.join('\n') });
    }
    return out;
  }

  // Parses streaming "SAY: ... POINTS: - a - b" text.
  function parse(text) {
    const t = clean(text);
    const m = hasFence(t) ? [t] : t.split(/\n?\s*POINTS:\s*/i);
    const say = m[0].replace(/^\s*SAY:\s*/i, '').trim();
    const points = (m[1] || '').split(/\n/).map((l) => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
    return { say, points };
  }

  // Plain text of a card for Copy / feedback / chat refinement: SAY text then the bullet points.
  function answerText(card) {
    if (!card) return '';
    const { say, points } = parse(card.text);
    return [say, ...points.map((p) => `- ${p}`)].filter(Boolean).join('\n');
  }

  // mm:ss since session start; '' when the start time or the card time is unknown.
  function clock(at, startedAt) {
    if (at == null || startedAt == null) return '';
    const s = Math.max(0, Math.floor((at - startedAt) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  // Last n words of a live utterance; `more` is true when earlier words were cut.
  function lastWords(text, n = 12) {
    const w = String(text || '').trim().split(/\s+/).filter(Boolean);
    return { words: w.slice(-n), more: w.length > n };
  }

  // ---- answer history --------------------------------------------------------------------
  // history: finished cards. live: the current card (streaming, speculative-and-done, or errored).
  // view: null = follow the newest item; a number = the user pinned an older card by index.
  function initial() {
    return { history: [], live: null, view: null, blank: false, newPill: false, ended: false };
  }

  const items = (s) => (s.live ? s.history.concat(s.live) : s.history);

  function viewIndex(s) {
    const n = items(s).length;
    if (!n) return -1;
    return s.view == null ? n - 1 : Math.min(s.view, n - 1);
  }

  // What the UI should show: {card, index (0-based), total, isLive}.
  function viewed(s) {
    const list = items(s);
    const index = viewIndex(s);
    if (s.blank || index < 0) return { card: null, index: -1, total: list.length, isLive: false };
    return { card: list[index], index, total: list.length, isLive: !!s.live && index === list.length - 1 };
  }

  // Move a finished card from live into history (once).
  function commit(s, card) {
    const history = s.history.some((c) => c.genId === card.genId) ? s.history : s.history.concat(card);
    return { ...s, history, live: null };
  }

  const isCurrent = (s, ev) => !!s.live && s.live.genId === ev.genId;
  const isRegenerating = (c) => !!c && !!c.validation && c.validation.action === 'regenerating';

  // answer:validated payload -> card.validation (bounded; only the known fields survive).
  function validationOf(ev) {
    const str = (v) => (typeof v === 'string' ? v : '');
    const unsupported = (Array.isArray(ev.unsupported) ? ev.unsupported : []).filter((u) => u && typeof u === 'object')
      .map((u) => ({ claim: str(u.claim), kind: str(u.kind), reason: str(u.reason) }));
    return {
      ok: ev.ok !== false, action: str(ev.action), unsupported,
      warnings: typeof ev.warnings === 'number' ? ev.warnings : 0,
      confidence: typeof ev.confidence === 'number' ? ev.confidence : null,
    };
  }

  // Badge for a card's validation state: {cls: 'checking'|'grounded'|'trimmed', text, title} or null.
  // Shared in spirit with the inline copy in phone.html.
  function validationBadge(card, maxClaims = 5, maxLen = 80) {
    const v = card && card.validation;
    if (!v) return null;
    if (v.action === 'regenerating') return { cls: 'checking', text: 'checking facts… rewriting', title: 'The draft failed a fact check; a corrected answer is being written.' };
    // Stable mode: the trimmed answer stays on screen while a fuller one is written; it swaps once.
    if (v.action === 'improving') return { cls: 'checking', text: '✂ trimmed · improving…', title: 'Unsupported sentences were removed; a fuller answer will replace this once.' };
    if (v.action === 'rewritten') return { cls: 'grounded', text: '✓ grounded (rewritten)', title: 'The first draft had unsupported claims; this is the checked rewrite.' };
    if (v.action === 'checked') {
      const n = v.warnings > 0 ? v.warnings : 0;
      return { cls: 'grounded', text: '✓ grounded', title: n ? `✓ grounded (${n} note${n === 1 ? '' : 's'})` : '✓ grounded' };
    }
    if (v.action === 'trimmed') {
      const cut = (t) => (t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t);
      const claims = (v.unsupported || []).map((u) => u.claim).filter(Boolean);
      const lines = claims.slice(0, maxClaims).map((t) => `- ${cut(t)}`);
      if (claims.length > maxClaims) lines.push(`…and ${claims.length - maxClaims} more`);
      return { cls: 'trimmed', text: '✂ trimmed unsupported claims', title: ['Removed (not supported by your profile):', ...lines].join('\n') };
    }
    return null;
  }

  function reduceCard(s, ev) {
    switch (ev && ev.type) {
      case 'answer:start': {
        const live = {
          genId: ev.genId, kind: ev.kind, question: ev.question || '', request: ev.request || '',
          text: '', at: ev.at == null ? null : ev.at, rating: null, done: false, error: null,
        };
        if (ev.revisionOf != null && isCurrent(s, { genId: ev.revisionOf })) {
          // Corrected answer replacing a rejected draft: swap the live slot silently. The view is not
          // moved (pinned stays pinned, following stays following) and no "new answer" pill is raised.
          return { ...s, live: { ...live, revisionOf: ev.revisionOf }, blank: false, ended: false };
        }
        const pinned = s.view != null; // user is looking at an older card
        if (pinned && ev.kind === SPEC) return { ...s, live, newPill: true, blank: false, ended: false };
        return { ...s, live, view: null, blank: false, newPill: false, ended: false };
      }
      case 'answer:delta':
        return isCurrent(s, ev) ? { ...s, live: { ...s.live, text: s.live.text + (ev.text || '') } } : s;
      case 'answer:promote': {
        if (!isCurrent(s, ev)) return s;
        const card = { ...s.live, kind: 'confirmed' };
        return card.done && !card.error && !isRegenerating(card) ? commit(s, card) : { ...s, live: card };
      }
      case 'answer:invalidate':
        return isCurrent(s, ev) ? { ...s, live: null, newPill: false } : s; // history untouched
      case 'answer:validated': {
        if (!isCurrent(s, ev)) return s;
        return { ...s, live: { ...s.live, validation: validationOf(ev) } };
      }
      case 'answer:replace': {
        if (typeof ev.text !== 'string') return s;
        const put = (c) => (c.genId === ev.genId ? { ...c, text: ev.text } : c);
        const known = isCurrent(s, ev) || s.history.some((c) => c.genId === ev.genId);
        return known ? { ...s, history: s.history.map(put), live: s.live ? put(s.live) : null } : s;
      }
      case 'answer:done': {
        if (!isCurrent(s, ev) || isRegenerating(s.live)) return s; // a rejected draft never finishes
        const t = ev.timings || {};
        const card = {
          ...s.live, done: true, model: ev.model || null, hedged: !!ev.hedged,
          firstTokenMs: t.eotToFirstTokenMs == null ? null : t.eotToFirstTokenMs,
          totalMs: t.totalMs == null ? null : t.totalMs,
        };
        return card.kind === SPEC || card.error ? { ...s, live: card } : commit(s, card);
      }
      case 'answer:error':
        return isCurrent(s, ev) ? { ...s, live: { ...s.live, error: ev.message || 'error' } } : s;
      case 'nav': {
        const list = items(s);
        if (!list.length) return s;
        const base = s.blank ? list.length : viewIndex(s); // a cleared view sits just past the newest card
        const next = Math.max(0, Math.min(list.length - 1, base + (ev.dir < 0 ? -1 : 1)));
        const atEnd = next === list.length - 1;
        // Reaching the live card resumes following; otherwise pin the chosen card.
        const view = atEnd && s.live ? null : next;
        return { ...s, view, blank: false, newPill: atEnd ? false : s.newPill };
      }
      case 'jumpLive':
        return { ...s, view: null, blank: false, newPill: false };
      case 'clear': // hide the displayed card when it is the newest one; history is kept
        if (s.blank || viewIndex(s) !== items(s).length - 1) return s;
        return { ...s, live: null, view: null, blank: true, newPill: false };
      case 'rate': {
        const rating = ev.rating || null;
        const mark = (c) => (c.genId === ev.genId ? { ...c, rating } : c);
        return { ...s, history: s.history.map(mark), live: s.live ? mark(s.live) : null };
      }
      case 'sessionEnd':
        return { ...s, ended: true };
      case 'sessionStart':
        return { ...s, ended: false };
      default:
        return s;
    }
  }

  // ---- stale-turn guard (contracts.js, FABEL_STALE_TURN_GUARD) ---------------------------
  // With the guard on, every answer event carries its generation's seq. An event from an older
  // generation than the newest one seen is dropped before the card logic runs. Events without a
  // seq (guard off, and all non-answer events) take the unchanged path.
  function withMaxSeq(next, s, ev) {
    const prev = typeof s.maxSeq === 'number' ? s.maxSeq : null;
    const seq = ev && typeof ev.seq === 'number' ? ev.seq : null;
    let max = prev;
    if (seq !== null) max = prev === null ? seq : Math.max(prev, seq);
    return max === null || next.maxSeq === max ? next : { ...next, maxSeq: max };
  }

  function reduce(s, ev) {
    if (ev && typeof ev.seq === 'number' && typeof s.maxSeq === 'number' && ev.seq < s.maxSeq) return s;
    return withMaxSeq(reduceCard(s, ev), s, ev);
  }

  // ---- live question strip (THEM's open utterance) ---------------------------------------
  // strip: null | {turnId, text, final, dismissed}
  function stripReduce(st, ev) {
    if (ev && ev.type === 'clearStrip') return st ? { ...st, dismissed: true } : st;
    if (!ev || ev.type !== 'transcript' || ev.channel !== 'them' || ev.echo) return st;
    const final = ev.status === 'final';
    if (st && st.turnId === ev.turnId) {
      if (st.dismissed) return st;
      if (st.final && !final) return st; // late partial after the turn closed
    }
    return { turnId: ev.turnId, text: ev.text || '', final, dismissed: false };
  }

  const api = { clean, parse, segments, answerText, clock, lastWords, validationBadge, initial, reduce, viewed, items, stripReduce };
  root.OverlayState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
