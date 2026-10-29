'use strict';
// WS /v1/stt: authenticated, lease-bound, metered relay to Deepgram Flux. The server holds DEEPGRAM_API_KEY.

const { WebSocketServer } = require('ws');
const { bearerToken } = require('./auth');
const { UUID } = require('./chat');

const FLUX_MODEL = 'flux-general-en';
const BYTES_PER_SECOND = 16000 * 2; // linear16 @ 16 kHz mono
const MAX_RELAYS_PER_LEASE = 2;
const MAX_KEYTERMS = 50;
const MAX_KEYTERM_CHARS = 100;
const MAX_PENDING_BYTES = 1024 * 1024; // audio buffered while the upstream socket opens
const ESTIMATE_SECONDS = 60; // in-flight capacity reservation per relay
const RATE_FACTOR = 1.25; // audio may arrive at most 1.25x real time ...
const RATE_WINDOW_SEC = 15; // ... averaged over 15 s (token bucket): absorbs a TCP burst after a stall
const CAP_CHECK_BYTES = 5 * BYTES_PER_SECOND; // inline spend-cap check every ~5 s of audio
const CLIENT_CONTROL = new Set(['CloseStream', 'ForceEndTurn', 'KeepAlive']);
const OPEN = 1;
const WS_KEY = /^[+/0-9A-Za-z]{22}==$/;
const WS_PROTOCOLS = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+(\s*,\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+)*$/;

const CLOSE = Object.freeze({
  unauthorized: 4401,
  noMinutes: 4402,
  notFound: 4404,
  leaseEnded: 4409,
  tooMany: 4429,
  capacity: 4503,
});

const NUMERIC_PARAMS = [
  // name, min, max, integer
  ['eot_threshold', 0, 1, false],
  ['eager_eot_threshold', 0, 1, false],
  ['eot_timeout_ms', 100, 20000, true],
];

// Allowlisted Flux params only; model/encoding/sample_rate are fixed (metering assumes 16 kHz linear16) and
// mip_opt_out=true is always added. lease, channel and anything else are dropped.
function buildFluxUpstreamUrl(base, searchParams) {
  const p = new URLSearchParams();
  p.set('model', FLUX_MODEL);
  p.set('encoding', 'linear16');
  p.set('sample_rate', '16000');
  for (const [name, min, max, integer] of NUMERIC_PARAMS) {
    const raw = searchParams.get(name);
    if (raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n))) p.set(name, String(n));
  }
  let terms = 0;
  for (const term of searchParams.getAll('keyterm')) {
    if (terms >= MAX_KEYTERMS) break;
    if (term.trim() && term.length <= MAX_KEYTERM_CHARS) {
      p.append('keyterm', term);
      terms += 1;
    }
  }
  p.set('mip_opt_out', 'true');
  return `${base}?${p.toString()}`;
}

// The same checks ws.handleUpgrade makes. Done first, so ws can never abort the handshake after we have
// reserved capacity or registered a relay (its callback would then never run).
function validHandshake(req) {
  const h = req.headers;
  if (req.method !== 'GET') return false;
  if (typeof h.upgrade !== 'string' || h.upgrade.toLowerCase() !== 'websocket') return false;
  if (typeof h['sec-websocket-key'] !== 'string' || !WS_KEY.test(h['sec-websocket-key'].trim())) return false;
  if (h['sec-websocket-version'] !== '13' && h['sec-websocket-version'] !== '8') return false;
  if (h['sec-websocket-protocol'] !== undefined && !WS_PROTOCOLS.test(String(h['sec-websocket-protocol']).trim())) return false;
  return true;
}

function safeClose(sock, code, reason) {
  if (!sock) return;
  try {
    if (sock.readyState === 0 || sock.readyState === OPEN) sock.close(code, reason);
  } catch {
    try { sock.terminate(); } catch { /* already gone */ }
  }
}

function createSttRelay({ verifyToken, db, spend, deepgramConnect, deepgramApiKey, deepgramUrl, usdPerMin, log, now = () => Date.now() }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false, clientTracking: false });
  const registry = new Map(); // leaseId -> Set<relay>
  const priceKnown = Number.isFinite(usdPerMin) && usdPerMin > 0;
  const costOfBytes = (bytes) => (priceKnown ? ((bytes / BYTES_PER_SECOND) / 60) * usdPerMin : 0);

  function unregister(relay) {
    const set = registry.get(relay.leaseId);
    if (!set) return;
    set.delete(relay);
    if (set.size === 0) registry.delete(relay.leaseId);
  }

  // A relay whose handshake never completed: drop it and give its reservation back.
  function abandon(relay, code) {
    if (relay.started || relay.finished) return;
    relay.finished = true;
    relay.closeCode = code;
    unregister(relay);
    relay.reservation.release();
  }

  function rejectWith(req, socket, head, code, reason) {
    if (socket.destroyed) return;
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(code, reason));
  }

  async function handleUpgrade(req, socket, head) {
    socket.on('error', () => {});
    if (!validHandshake(req)) {
      try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch { /* gone */ }
      socket.destroy();
      return;
    }
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    const reject = (code, reason) => rejectWith(req, socket, head, code, reason);

    // 1. Auth: header only, never the query string.
    const token = bearerToken(req.headers);
    let user = null;
    try {
      user = token ? await verifyToken(token) : null;
    } catch {
      return reject(1013, 'auth unavailable');
    }
    if (!user) return reject(CLOSE.unauthorized, 'unauthorized');

    // 2. Unknown price (or no key) means reject.
    if (!priceKnown || !deepgramApiKey) return reject(CLOSE.capacity, 'stt price unknown');

    // 3. Lease and channel.
    const leaseId = url.searchParams.get('lease') || '';
    if (!UUID.test(leaseId)) return reject(CLOSE.notFound, 'lease not found');
    const channel = url.searchParams.get('channel');
    if (channel !== 'me' && channel !== 'them') return reject(1008, 'channel must be me or them');
    let state;
    try {
      state = await db.leaseState(user.id, leaseId);
    } catch (err) {
      if (err && err.status === 404) return reject(CLOSE.notFound, 'lease not found');
      log.error({ event: 'stt_lease_check_failed' });
      return reject(1011, 'server error');
    }
    if (state.status !== 'active') return reject(CLOSE.leaseEnded, 'lease ended');
    if (!((state.usableSeconds ?? state.remainingSeconds) > 0)) return reject(CLOSE.noMinutes, 'no minutes');

    // 4. Capacity, then the relay slot (checked and taken synchronously after the last await).
    const r = await spend.tryReserve('deepgram', costOfBytes(ESTIMATE_SECONDS * BYTES_PER_SECOND), user.id);
    if (!r.ok) return reject(CLOSE.capacity, 'capacity');
    const { reservation } = r;
    const set = registry.get(leaseId) || new Set();
    if (set.size >= MAX_RELAYS_PER_LEASE || [...set].some((x) => x.channel === channel)) {
      reservation.release();
      return reject(CLOSE.tooMany, 'too many relays');
    }
    if (socket.destroyed) {
      reservation.release();
      return;
    }
    const relay = {
      channel, leaseId, userId: user.id, client: null, upstream: null, reservation, started: false, finished: false,
    };
    set.add(relay);
    registry.set(leaseId, set);

    // If the socket dies before ws completes the upgrade (ws then never calls back), clean up.
    const onEarlyClose = () => abandon(relay, 1006);
    socket.once('close', onEarlyClose);
    wss.handleUpgrade(req, socket, head, (client) => {
      socket.removeListener('close', onEarlyClose);
      relay.client = client;
      startRelay(relay, url.searchParams);
    });
  }

  function startRelay(relay, searchParams) {
    const { client, reservation } = relay;
    if (relay.finished) {
      // The lease ended while the upgrade was completing (reservation already released).
      safeClose(client, relay.closeCode || CLOSE.leaseEnded, 'lease ended');
      return;
    }
    relay.started = true;
    let pending = [];
    let pendingBytes = 0;
    let unflushedBytes = 0;
    let totalBytes = 0;
    let bytesSinceCapCheck = 0;
    const bucketMax = RATE_FACTOR * BYTES_PER_SECOND * RATE_WINDOW_SEC;
    const bucketRate = RATE_FACTOR * BYTES_PER_SECOND; // bytes per second
    let bucket = bucketMax;
    let bucketAt = now();

    const flush = async () => {
      if (unflushedBytes <= 0) return;
      const bytes = unflushedBytes;
      unflushedBytes = 0;
      const seconds = bytes / BYTES_PER_SECOND;
      const costUsd = costOfBytes(bytes);
      reservation.release(costUsd);
      await spend.record({
        userId: relay.userId, leaseId: relay.leaseId, provider: 'deepgram', model: FLUX_MODEL,
        unitsIn: Math.round(seconds * 1000) / 1000, unitsOut: 0, costUsd,
      });
    };
    relay.flush = flush;

    const finish = (code, reason) => {
      if (relay.finished) return;
      relay.finished = true;
      unregister(relay);
      pending = [];
      safeClose(client, code || 1000, reason || '');
      safeClose(relay.upstream, 1000, '');
      // Guarantee both sockets are gone within 1 s even if a peer ignores the close handshake.
      const killTimer = setTimeout(() => {
        try { if (client.readyState !== 3) client.terminate(); } catch { /* gone */ }
        try { if (relay.upstream && relay.upstream.readyState !== 3) relay.upstream.terminate(); } catch { /* gone */ }
      }, 500);
      if (killTimer.unref) killTimer.unref();
      flush().finally(() => reservation.release());
      log.info({ event: 'stt_relay_closed', channel: relay.channel, code: code || 1000, audioSeconds: Math.round(totalBytes / BYTES_PER_SECOND) });
    };
    relay.finish = finish;

    let upstream;
    try {
      upstream = deepgramConnect(buildFluxUpstreamUrl(deepgramUrl, searchParams), { Authorization: `Token ${deepgramApiKey}` });
    } catch {
      finish(1011, 'upstream unavailable');
      return;
    }
    relay.upstream = upstream;

    upstream.on('open', () => {
      if (relay.finished) return safeClose(upstream, 1000, '');
      for (const frame of pending) upstream.send(frame.data, { binary: frame.binary });
      pending = [];
      pendingBytes = 0;
    });
    upstream.on('message', (data, isBinary) => {
      if (relay.finished || isBinary === true) return;
      if (client.readyState === OPEN) client.send(data, { binary: false });
    });
    upstream.on('error', () => {
      log.warn({ event: 'stt_upstream_error', channel: relay.channel });
      finish(1011, 'upstream error');
    });
    upstream.on('close', (code) => {
      finish(code === 1000 ? 1000 : 1011, code === 1000 ? '' : 'upstream closed');
    });

    client.on('message', (data, isBinary) => {
      if (relay.finished) return;
      let frame;
      if (isBinary) {
        const len = data.length;
        // Token bucket: at most 1.25x real-time audio averaged over 15 s.
        const t = now();
        bucket = Math.min(bucketMax, bucket + ((t - bucketAt) / 1000) * bucketRate);
        bucketAt = t;
        if (len > bucket) return finish(1008, 'audio rate exceeded');
        bucket -= len;
        totalBytes += len;
        unflushedBytes += len;
        reservation.add(costOfBytes(len));
        bytesSinceCapCheck += len;
        if (bytesSinceCapCheck >= CAP_CHECK_BYTES) {
          bytesSinceCapCheck = 0;
          if (spend.overCap('deepgram')) return finish(CLOSE.capacity, 'capacity');
        }
        frame = { data, binary: true };
      } else {
        // Only small Flux control messages (CloseStream, ForceEndTurn, KeepAlive) are relayed.
        if (data.length > 256) return;
        let msg;
        try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
        if (!msg || !CLIENT_CONTROL.has(msg.type)) return;
        frame = { data: JSON.stringify({ type: msg.type }), binary: false };
      }
      if (upstream.readyState === OPEN) {
        upstream.send(frame.data, { binary: frame.binary });
      } else {
        pendingBytes += frame.data.length;
        if (pendingBytes > MAX_PENDING_BYTES) return finish(1009, 'too much audio before upstream opened');
        pending.push(frame);
      }
    });
    client.on('error', () => finish(1011, 'client error'));
    client.on('close', () => finish(1000, ''));
    log.info({ event: 'stt_relay_open', channel: relay.channel });
  }

  // Closes every relay of a lease (stop, sweep, exhaustion). Both sockets are gone within 1 s; a relay whose
  // upgrade has not completed yet is dropped and its reservation released.
  function closeLease(leaseId, code = CLOSE.leaseEnded, reason = 'lease ended') {
    const set = registry.get(leaseId);
    if (!set) return 0;
    const relays = [...set];
    for (const r of relays) {
      if (r.started && r.finish) r.finish(code, reason);
      else abandon(r, code);
    }
    return relays.length;
  }

  // Periodic: writes metered audio to usage_events and enforces the Deepgram cap on open relays.
  async function flushAll() {
    const all = [...registry.values()].flatMap((s) => [...s]);
    await Promise.all(all.map((r) => (r.flush ? r.flush() : null)));
    if (spend.overCap('deepgram')) {
      for (const leaseId of [...registry.keys()]) closeLease(leaseId, CLOSE.capacity, 'capacity');
    }
  }

  function closeAll(code = 1001) {
    for (const leaseId of [...registry.keys()]) closeLease(leaseId, code, 'server shutting down');
  }

  return {
    handleUpgrade,
    closeLease,
    flushAll,
    closeAll,
    count: (leaseId) => (registry.get(leaseId) ? registry.get(leaseId).size : 0),
    registry,
  };
}

module.exports = { createSttRelay, buildFluxUpstreamUrl, validHandshake, CLOSE, BYTES_PER_SECOND, MAX_KEYTERMS };
