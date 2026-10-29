'use strict';
// Vkin hosted API (docs/vkin-hosted-api.md). createApp(deps) wires everything with injected dependencies so
// tests run fully offline.

const express = require('express');
const { ApiError, sendError } = require('./errors');
const { bearerToken } = require('./auth');
const { createChatHandler, UUID } = require('./chat');
const { createSpendGuard } = require('./spend');
const { createSttRelay, CLOSE } = require('./stt');

const BEAT_EVERY_SEC = 15;
const SWEEP_INTERVAL_MS = 15_000;
const MAX_DEVICE_CHARS = 80;

const silentLog = { info() {}, warn() {}, error() {} };

/**
 * deps:
 *   verifyToken(token) -> Promise<{ id, email } | null>
 *   db: { me, startLease, billLease, stopLease, leaseState, expireLeases, recordUsage, spendTotals }
 *   nebius(), gemini(): OpenAI SDK instances (or null when not configured)
 *   deepgramConnect(url, headers) -> ws-like; deepgramApiKey; deepgramUrl
 *   prices (prices.json shape); caps: { nebiusUsd, deepgramUsd, deepgramUsdPerMin }
 *   corsOrigins: string[]; now(); log: { info, warn, error }; sweepIntervalMs
 */
function createApp(deps) {
  const log = deps.log || silentLog;
  const now = deps.now || (() => Date.now());
  const caps = deps.caps || {};
  const db = deps.db;
  const spend = createSpendGuard({
    db,
    caps: {
      nebiusUsd: caps.nebiusUsd ?? 10,
      deepgramUsd: caps.deepgramUsd ?? 10,
      nebiusUserUsd: caps.nebiusUserUsd ?? 0.5,
      geminiDailyRequests: caps.geminiDailyRequests ?? 300,
      geminiUserDailyRequests: caps.geminiUserDailyRequests ?? 40,
    },
    now,
    log,
  });
  const relays = createSttRelay({
    verifyToken: deps.verifyToken,
    db,
    spend,
    deepgramConnect: deps.deepgramConnect,
    deepgramApiKey: deps.deepgramApiKey,
    deepgramUrl: deps.deepgramUrl || 'wss://api.deepgram.com/v2/listen',
    usdPerMin: caps.deepgramUsdPerMin,
    log,
    now,
  });
  const chat = createChatHandler({
    db,
    spend,
    prices: deps.prices,
    clients: { nebius: deps.nebius || (() => null), gemini: deps.gemini || (() => null) },
    log,
    now,
    limits: deps.limits,
  });

  // A lease ended (stop, sweep, stale, exhaustion): close its STT relays and abort its chat streams.
  function endLease(id, code, reason) {
    relays.closeLease(id, code, reason);
    chat.abortLease(id);
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // CORS: only the configured web origins. The desktop is not a browser and sends no Origin.
  const allowedOrigins = new Set((deps.corsOrigins || []).filter(Boolean));
  app.use((req, res, next) => {
    res.vary('Origin');
    const origin = req.headers.origin;
    const allowed = typeof origin === 'string' && allowedOrigins.has(origin);
    if (allowed) res.set('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      if (allowed) {
        res.set({
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Vkin-Lease',
          'Access-Control-Max-Age': '600',
        });
      }
      return res.status(204).end();
    }
    return next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Auth before body parsing: unauthenticated bodies are never read.
  app.use('/v1', wrap(async (req, res, next) => {
    const token = bearerToken(req.headers);
    if (!token) return sendError(res, 401, 'unauthorized');
    let user;
    try {
      user = await deps.verifyToken(token);
    } catch {
      return sendError(res, 503, 'auth_unavailable');
    }
    if (!user || !user.id) return sendError(res, 401, 'unauthorized');
    req.user = user;
    return next();
  }));
  // 1 MB bodies, except chat (6 MB parse limit; chat.js allows > 1 MB only for a Gemini request with an image).
  app.use('/v1/chat/completions', express.json({ limit: '6mb', verify: (req, res, buf) => { req.rawBodyBytes = buf.length; } }));
  app.use('/v1', express.json({ limit: '1mb' }));

  app.get('/v1/me', wrap(async (req, res) => {
    const m = await db.me(req.user.id);
    res.json({
      userId: req.user.id,
      email: req.user.email || null,
      trialSeconds: m.trialSeconds,
      purchasedSeconds: m.purchasedSeconds,
      usedSeconds: m.usedSeconds,
      remainingSeconds: m.remainingSeconds,
      activeLease: m.activeLease || null,
    });
  }));

  app.post('/v1/sessions/start', wrap(async (req, res) => {
    const raw = req.body && req.body.device;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new ApiError(400, 'bad_request', 'device must be a string.');
    const device = (raw || '').trim();
    if (device.length > MAX_DEVICE_CHARS) throw new ApiError(400, 'bad_request', 'device must be at most 80 characters.');
    const r = await db.startLease(req.user.id, device);
    for (const id of r.expired || []) endLease(id, CLOSE.leaseEnded, 'lease ended');
    log.info({ event: 'lease_start', chargedSeconds: r.chargedSeconds, remainingSeconds: r.remainingSeconds });
    res.status(201).json({ leaseId: r.leaseId, remainingSeconds: r.remainingSeconds, beatEverySec: BEAT_EVERY_SEC });
  }));

  const leaseParam = (req) => {
    if (!UUID.test(req.params.id)) throw new ApiError(404, 'not_found');
    return req.params.id;
  };

  app.post('/v1/sessions/:id/beat', wrap(async (req, res) => {
    const id = leaseParam(req);
    const r = await db.billLease(req.user.id, id);
    if (r.remainingSeconds <= 0) {
      endLease(id, CLOSE.noMinutes, 'no minutes');
      return sendError(res, 402, 'no_minutes');
    }
    if (r.status !== 'active') endLease(id, CLOSE.leaseEnded, 'lease ended');
    return res.json({ remainingSeconds: r.remainingSeconds, status: r.status === 'active' ? 'active' : 'ended' });
  }));

  app.post('/v1/sessions/:id/stop', wrap(async (req, res) => {
    const id = leaseParam(req);
    const r = await db.stopLease(req.user.id, id);
    endLease(id, r.remainingSeconds <= 0 ? CLOSE.noMinutes : CLOSE.leaseEnded, 'lease ended');
    log.info({ event: 'lease_stop', billedSeconds: r.billedSeconds, remainingSeconds: r.remainingSeconds });
    res.json({ remainingSeconds: r.remainingSeconds });
  }));

  app.post('/v1/chat/completions', wrap(chat.handle));

  app.use((req, res) => sendError(res, 404, 'not_found'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) return sendError(res, err.status, err.code, err.message);
    if (err && err.type === 'entity.parse.failed') return sendError(res, 400, 'bad_request', 'Body is not valid JSON.');
    if (err && err.type === 'entity.too.large') return sendError(res, 413, 'too_large', 'Request body is too large.');
    log.error({ event: 'unhandled_error', path: req.path, name: err && err.name, dbCode: err && err.dbCode });
    return sendError(res, 500, 'internal');
  });

  // Sweep: end stale leases (billed their 45 s window), close their relays and abort their chat streams; retry
  // failed usage writes; flush STT metering; enforce the STT cap.
  async function tick() {
    try {
      const ended = await db.expireLeases();
      for (const id of ended) endLease(id, CLOSE.leaseEnded, 'lease ended');
      if (ended.length) log.info({ event: 'sweep', ended: ended.length });
    } catch {
      log.error({ event: 'sweep_failed' });
    }
    try {
      await spend.retryFailed();
    } catch {
      log.error({ event: 'usage_retry_failed' });
    }
    try {
      await relays.flushAll();
    } catch {
      log.error({ event: 'stt_flush_failed' });
    }
  }

  let timer = null;
  function start() {
    if (timer) return;
    timer = setInterval(tick, deps.sweepIntervalMs || SWEEP_INTERVAL_MS);
    if (timer.unref) timer.unref();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    relays.closeAll(1001);
  }

  // Only /v1/stt upgrades are accepted; everything else is dropped.
  function handleUpgrade(req, socket, head) {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* invalid */ }
    if (pathname !== '/v1/stt') {
      socket.destroy();
      return;
    }
    relays.handleUpgrade(req, socket, head).catch(() => socket.destroy());
  }

  return { app, handleUpgrade, tick, start, stop, relays, chat, spend, endLease };
}

module.exports = { createApp, BEAT_EVERY_SEC };
