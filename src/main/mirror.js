// @ts-check
// LAN phone mirror: read-only live view of the answer cards. Only allowlisted answer events and
// allowlisted fields ever leave this process.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { ANSWER_EVENTS: E, MIRROR_ALLOWED } = require('../shared/contracts');

const FIELDS = {
  genId: 'string', turnId: 'string', revision: 'number', kind: 'string',
  question: 'string', text: 'string', reason: 'string', message: 'string',
  ok: 'boolean', action: 'string', warnings: 'number', confidence: 'number', revisionOf: 'string',
  seq: 'number', // stale-turn guard (contracts.js)
};
const MAX_STR = 120;
const MAX_UNSUPPORTED = 20;

// Pure card state machine; phone.html mirrors this logic inline (and overlay.js semantics).
// state = {current, previous, maxSeq?}; card = {genId, turnId, revision, kind, question, text, done?, error?, timings?}
function reduceCard(state, msg) {
  const s = state || { current: null, previous: null };
  const cur = s.current;
  if (!msg) return s;
  if (msg.type === 'snapshot') return { current: msg.current || null, previous: msg.previous || null, maxSeq: msg.maxSeq };
  if (msg.type === E.START) {
    const { genId, turnId, revision, kind, question } = msg;
    const next = { genId, turnId, revision, kind, question, text: '' };
    // A corrected answer replaces the rejected draft it revises; the draft never becomes `previous`.
    if (msg.revisionOf != null && cur && cur.genId === msg.revisionOf) return { ...s, current: next };
    const previous = cur && !cur.error && cur.kind !== 'speculative' && cur.done ? cur : s.previous;
    return { current: next, previous };
  }
  if (msg.type === E.REPLACE) { // live card or the card kept as `previous`
    if (typeof msg.text !== 'string') return s;
    const put = (c) => (c && c.genId === msg.genId ? { ...c, text: msg.text } : c);
    const current = put(cur);
    const previous = put(s.previous);
    return current === cur && previous === s.previous ? s : { current, previous };
  }
  if (!cur || cur.genId !== msg.genId) return s; // stale / unknown genId: ignore
  switch (msg.type) {
    case E.DELTA: return { ...s, current: { ...cur, text: cur.text + (msg.text || '') } };
    case E.PROMOTE: return { ...s, current: { ...cur, kind: 'confirmed' } };
    case E.INVALIDATE: return { ...s, current: null };
    case E.VALIDATED: return {
      ...s,
      current: {
        ...cur,
        validation: {
          ok: msg.ok !== false, action: msg.action || '', unsupported: Array.isArray(msg.unsupported) ? msg.unsupported : [],
          warnings: msg.warnings || 0, confidence: typeof msg.confidence === 'number' ? msg.confidence : null,
        },
      },
    };
    case E.DONE:
      if (cur.validation && cur.validation.action === 'regenerating') return s; // a rejected draft never finishes
      return { ...s, current: { ...cur, done: true, timings: msg.timings } };
    case E.ERROR: return { ...s, current: { ...cur, error: `Error: ${msg.message}` } };
    default: return s;
  }
}

// Stale-turn guard (contracts.js, FABEL_STALE_TURN_GUARD): drop an answer event from an older
// generation than the newest seen. Events without a seq (guard off / snapshot) take the unchanged path.
function reduce(state, msg) {
  const s = state || { current: null, previous: null };
  if (msg && typeof msg.seq === 'number' && typeof s.maxSeq === 'number' && msg.seq < s.maxSeq) return s;
  const next = reduceCard(s, msg);
  if (!msg || typeof msg.seq !== 'number') return next;
  const max = typeof s.maxSeq === 'number' ? Math.max(s.maxSeq, msg.seq) : msg.seq;
  return next.maxSeq === max ? next : { ...next, maxSeq: max };
}

// Whitelist copy: nothing but FIELDS (and numeric timings) survives.
function sanitize(msg) {
  const out = { type: msg.type };
  for (const [k, t] of Object.entries(FIELDS)) if (typeof msg[k] === t) out[k] = msg[k];
  if (msg.timings && typeof msg.timings === 'object') {
    const t = {};
    for (const k of ['eotToFirstTokenMs', 'totalMs']) if (typeof msg.timings[k] === 'number') t[k] = msg.timings[k];
    out.timings = t;
  }
  if (Array.isArray(msg.unsupported)) {
    out.unsupported = msg.unsupported.slice(0, MAX_UNSUPPORTED).filter((u) => u && typeof u === 'object').map((u) => {
      const item = {};
      for (const k of ['claim', 'kind', 'reason']) if (typeof u[k] === 'string') item[k] = u[k].slice(0, MAX_STR);
      return item;
    });
  }
  return out;
}

function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function pickHost() {
  let best = null;
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && /** @type {unknown} */ (a.family) !== 4) continue;
      if (a.internal) continue;
      const ip = a.address;
      let score = 0;
      if (/^192\.168\./.test(ip)) score += 4;
      else if (/^10\./.test(ip)) score += 3;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) score += 3;
      else if (/^169\.254\./.test(ip)) score -= 5;
      if (/wi-?fi|wlan|wireless|^en\d|^eth|ethernet/i.test(name)) score += 2;
      if (/virtual|vethernet|vmware|vbox|docker|wsl|hyper-v|tailscale|bluetooth|loopback|vpn|tap/i.test(name)) score -= 4;
      if (!best || score > best.score) best = { ip, score };
    }
  }
  return best ? best.ip : '127.0.0.1';
}

function createMirror({ port = 4747, log = /** @type {(...a: any[]) => void} */ (() => {}) } = {}) {
  const token = crypto.randomBytes(16).toString('base64url');
  let state = { current: null, previous: null };
  let server = null;
  let wss = null;
  let hb = null;
  let info = null;
  let page = null;
  const safeLog = (...a) => { try { log(...a); } catch { /* never throw from logging */ } };

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const u = new URL(req.url, 'http://x');
    if (req.method !== 'GET' || u.pathname !== '/' || !safeEq(u.searchParams.get('t'), token)) return res.status(404).end();
    // Explicit ws://host too: older Safari does not match ws: against 'self'.
    const host = /^[\w.[\]:-]+$/.test(req.headers.host || '') ? ` ws://${req.headers.host}` : '';
    res.setHeader('Content-Security-Policy',
      `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'${host}`);
    res.type('html').send(page);
    return undefined;
  });

  function listen(p) {
    return new Promise((resolve, reject) => {
      const s = http.createServer(app);
      s.once('error', reject);
      s.listen(p, '0.0.0.0', () => { s.removeListener('error', reject); resolve(s); });
    });
  }

  async function start() {
    if (info) return info;
    page = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'phone.html'));
    let lastErr;
    for (let i = 0; i <= (port === 0 ? 0 : 5) && !server; i++) {
      try { server = await listen(port + i); } catch (e) {
        lastErr = e;
        if (e.code !== 'EADDRINUSE') break;
      }
    }
    if (!server) throw lastErr;
    server.on('error', (e) => safeLog('mirror server error:', e.message));

    wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
    wss.on('error', (e) => safeLog('mirror ws error:', e.message));
    wss.on('connection', (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', (e) => safeLog('mirror client error:', e.message));
      ws.on('message', () => {}); // read-only: inbound data ignored
      try { ws.send(JSON.stringify({ type: 'snapshot', ...state })); } catch (e) { safeLog('mirror snapshot failed:', e.message); }
    });
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {});
      let ok = false;
      try {
        const u = new URL(req.url, 'http://x');
        ok = u.pathname === '/ws' && safeEq(u.searchParams.get('t'), token);
      } catch { /* bad URL: reject */ }
      if (!ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    hb = setInterval(() => {
      for (const ws of wss.clients) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }
    }, 25000);
    hb.unref();

    const actual = server.address().port;
    if (actual !== port) safeLog(`mirror port ${port} busy, using ${actual}`);
    const url = `http://${pickHost()}:${actual}/?t=${token}`;
    info = { url, token, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 240 }) };
    return info;
  }

  function broadcast(msg) {
    try {
      if (!msg || !MIRROR_ALLOWED.has(msg.type)) return;
      const clean = sanitize(msg);
      state = reduce(state, clean);
      if (!wss) return;
      const data = JSON.stringify(clean);
      for (const ws of wss.clients) if (ws.readyState === 1) ws.send(data, (e) => e && safeLog('mirror send failed:', e.message));
    } catch (e) { safeLog('mirror broadcast failed:', e.message); }
  }

  function stop() {
    try {
      clearInterval(hb);
      if (wss) { for (const ws of wss.clients) ws.terminate(); wss.close(); }
      if (server) { server.close(); if (server.closeAllConnections) server.closeAllConnections(); }
    } catch (e) { safeLog('mirror stop failed:', e.message); }
    wss = null; server = null; info = null;
  }

  return { start, broadcast, stop };
}

module.exports = { createMirror, reduce, sanitize };
