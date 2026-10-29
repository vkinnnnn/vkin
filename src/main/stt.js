// @ts-check
const { EventEmitter } = require('node:events');
const { STT_EVENTS } = require('../shared/contracts');

const MAX_BUFFER_BYTES = 2 * 16000 * 2; // 2 s of 16 kHz Int16
const OPEN = 1;

function buildFluxUrl(stt, base = stt.url, extra = null) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(extra || {})) p.set(k, String(v));
  p.set('model', stt.model);
  p.set('encoding', 'linear16');
  p.set('sample_rate', '16000');
  if (stt.eotThreshold != null) p.set('eot_threshold', String(stt.eotThreshold));
  if (stt.eagerEotThreshold != null) p.set('eager_eot_threshold', String(stt.eagerEotThreshold));
  if (stt.eotTimeoutMs != null) p.set('eot_timeout_ms', String(stt.eotTimeoutMs));
  p.set('mip_opt_out', 'true');
  for (const term of stt.keyterms || []) p.append('keyterm', term);
  return `${base}?${p.toString()}`;
}

// Close codes from the Vkin relay that mean "do not reconnect" (docs/vkin-hosted-api.md).
const { STT_FATAL_CLOSE } = require('./hosted');

function normalizeTurnInfo(msg, channel) {
  if (!msg || msg.type !== 'TurnInfo' || !STT_EVENTS.includes(msg.event)) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    channel,
    event: msg.event,
    turnIndex: num(msg.turn_index),
    transcript: msg.transcript == null ? '' : String(msg.transcript),
    audioStart: num(msg.audio_window_start),
    audioEnd: num(msg.audio_window_end),
    eotConfidence: num(msg.end_of_turn_confidence),
  };
}

class FluxClient extends EventEmitter {
  /** target (hosted mode): async () => { url, params, headers } for the Vkin relay; then no apiKey is used. */
  constructor({ channel, apiKey = null, stt, target = null, WebSocketImpl = require('ws') }) {
    super();
    this.channel = channel;
    this.stt = stt;
    this.WS = WebSocketImpl;
    this._key = apiKey;
    this.target = target;
    this.running = false;
    this.ws = null;
    this.timer = null;
    this.attempt = 0;
    this.queue = [];
    this.queued = 0;
    this.state = 'closed';
  }

  _status(state, detail) {
    this.state = state;
    let d = detail == null ? '' : String(detail);
    if (this._key) d = d.split(this._key).join('***');
    this.emit('status', { channel: this.channel, state, detail: d });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this._connect();
  }

  async _connect() {
    this.timer = null;
    if (!this.running) return;
    this._status('connecting', '');
    let ws;
    try {
      let url = buildFluxUrl(this.stt);
      let headers = { Authorization: `Token ${this._key}` };
      if (this.target) {
        const t = await this.target();
        if (!this.running) return;
        url = buildFluxUrl(this.stt, t.url, t.params);
        headers = t.headers;
      }
      ws = new this.WS(url, { headers });
    } catch (err) {
      if (err && err.hostedCode) return this._fatal(err.hostedCode);
      this._status('error', err.message);
      return this._scheduleReconnect();
    }
    this.ws = ws;
    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this._status('open', '');
      this._flush();
    });
    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws || isBinary === true) return;
      this._onMessage(data);
    });
    ws.on('error', (err) => {
      if (this.ws !== ws) return;
      this._status('error', (err && err.message) || 'socket error');
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.target && STT_FATAL_CLOSE[code]) return this._fatal(STT_FATAL_CLOSE[code]);
      this._status('closed', `code ${code}${reason && reason.length ? ` ${reason}` : ''}`);
      this._scheduleReconnect();
    });
  }

  // A permanent refusal from the Vkin relay (no minutes, ended session, sign-in): stop, never retry.
  _fatal(code) {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.queued = 0;
    this._status('error', `hosted: ${code}`);
    this.emit('fatal', { channel: this.channel, code });
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'TurnInfo') {
      const ev = normalizeTurnInfo(msg, this.channel);
      if (ev) this.emit('event', ev);
    } else if (msg.type === 'Connected') {
      this._status('open', msg.request_id ? `connected ${msg.request_id}` : 'connected');
    } else if (msg.type === 'Warning') {
      this._status(this.state, `warning: ${msg.description || msg.message || msg.code || ''}`);
    } else if (msg.type === 'Error') {
      this._status('error', msg.description || msg.message || msg.code || 'server error');
      try { this.ws && this.ws.close(); } catch {}
    }
  }

  _scheduleReconnect() {
    if (!this.running || this.timer) return;
    const delay = Math.min(500 * 2 ** this.attempt, 5000);
    this.attempt += 1;
    this.timer = setTimeout(() => this._connect(), delay);
  }

  _flush() {
    const q = this.queue;
    this.queue = [];
    this.queued = 0;
    for (const buf of q) this.ws.send(buf);
  }

  sendPcm(data) {
    if (!this.running) return;
    const buf = ArrayBuffer.isView(data)
      ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      : Buffer.from(data);
    if (this.ws && this.ws.readyState === OPEN) return void this.ws.send(buf);
    this.queue.push(buf);
    this.queued += buf.length;
    while (this.queued > MAX_BUFFER_BYTES && this.queue.length > 1) this.queued -= this.queue.shift().length;
  }

  forceEndTurn() {
    if (this.ws && this.ws.readyState === OPEN) this.ws.send(JSON.stringify({ type: 'ForceEndTurn' }));
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    this.queue = [];
    this.queued = 0;
    if (ws) {
      try { if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'CloseStream' })); } catch {}
      try { ws.close(); } catch {}
    }
    this._status('closed', 'stopped');
  }
}

module.exports = { FluxClient, buildFluxUrl, normalizeTurnInfo };
