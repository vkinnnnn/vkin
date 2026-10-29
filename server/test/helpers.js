'use strict';
// Offline test harness: an in-memory db with the same semantics as the SQL functions, fake OpenAI clients,
// a fake Deepgram socket and a real HTTP server on an ephemeral port.

const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createApp } = require('../src/app');
const { ApiError } = require('../src/errors');
const { loadPrices } = require('../src/prices');

const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000001';
const C = 'c0000000-0000-4000-8000-000000000001'; // unconfirmed email: not trial eligible
const TOKENS = {
  'tok-a': { id: A, email: 'a@example.invalid' },
  'tok-b': { id: B, email: 'b@example.invalid' },
  'tok-c': { id: C, email: 'c@example.invalid' },
};

function createClock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, advance: (sec) => { t += sec * 1000; } };
}

// Mirrors supabase/migrations/0002_vkin_entitlements.sql.
function createFakeDb(clock, { eligible = [A, B] } = {}) {
  const eligibleSet = new Set(eligible);
  const ents = new Map();
  const leases = new Map();
  const usage = [];
  const stats = { grants: 0, spendTotalsCalls: 0 };
  const remainingOf = (userId) => {
    const e = ents.get(userId);
    return e ? Math.max(e.trial + e.purchased - e.used, 0) : 0;
  };
  const ensure = (userId) => {
    if (eligibleSet.has(userId) && !ents.has(userId)) {
      ents.set(userId, { trial: 600, purchased: 0, used: 0 });
      stats.grants += 1;
    }
    return ents.has(userId);
  };
  const end = (l) => { l.status = 'ended'; l.endedAt = clock.now(); };
  const stale = (l) => clock.now() - l.lastBeatAt > 45_000;
  const own = (userId, leaseId) => {
    const l = leases.get(leaseId);
    if (!l || l.userId !== userId) throw new ApiError(404, 'not_found');
    return l;
  };
  const charge = (userId, sec) => { if (ents.has(userId)) ents.get(userId).used += sec; };
  // Stale (> 45 s since billed-through): end and bill least(45, remaining).
  const closeStale = (l) => {
    if (l.status !== 'active' || !stale(l)) return null;
    const billed = Math.min(45, remainingOf(l.userId));
    charge(l.userId, billed);
    l.billed += billed;
    end(l);
    return billed;
  };
  const bill = (userId, leaseId, ending) => {
    const l = own(userId, leaseId);
    let remaining = remainingOf(userId);
    if (l.status === 'ended') return { remainingSeconds: remaining, status: 'ended', billedSeconds: 0, reason: 'already_ended' };
    const elapsed = (clock.now() - l.lastBeatAt) / 1000;
    if (elapsed > 45) {
      const billed = closeStale(l) || 0;
      return { remainingSeconds: remaining - billed, status: 'ended', billedSeconds: billed, reason: 'stale' };
    }
    const billed = Math.min(Math.max(Math.ceil(elapsed), 0), remaining);
    charge(userId, billed);
    remaining -= billed;
    l.billed += billed;
    l.lastBeatAt += billed * 1000;
    if (ending || remaining <= 0) {
      end(l);
      return { remainingSeconds: remaining, status: 'ended', billedSeconds: billed, reason: remaining <= 0 ? 'no_minutes' : 'stopped' };
    }
    return { remainingSeconds: remaining, status: 'active', billedSeconds: billed, reason: null };
  };
  const spendOf = (list, base) => {
    const t = { nebius: 0, gemini: 0, deepgram: 0, geminiRequestsToday: 0, ...(base || {}) };
    for (const u of list) {
      t[u.provider] += u.costUsd;
      if (u.provider === 'gemini') t.geminiRequestsToday += 1;
    }
    return t;
  };

  return {
    ents, leases, usage, stats,
    failWrites: false,
    async ensureEntitlement(userId) { return ensure(userId); },
    async me(userId) {
      ensure(userId);
      const e = ents.get(userId) || { trial: 0, purchased: 0, used: 0 };
      const l = [...leases.values()].find((x) => x.userId === userId && x.status === 'active' && !stale(x));
      return {
        trialSeconds: e.trial, purchasedSeconds: e.purchased, usedSeconds: e.used, remainingSeconds: remainingOf(userId),
        activeLease: l ? { id: l.id, device: l.device, startedAt: new Date(l.startedAt).toISOString() } : null,
      };
    },
    async startLease(userId, device) {
      ensure(userId);
      if (!ents.has(userId)) throw new ApiError(402, 'no_minutes');
      const expired = [];
      for (const l of leases.values()) if (l.userId === userId && closeStale(l) !== null) expired.push(l.id);
      const remaining = remainingOf(userId);
      if (remaining <= 0) throw new ApiError(402, 'no_minutes');
      if ([...leases.values()].some((l) => l.userId === userId && l.status === 'active')) throw new ApiError(409, 'lease_active');
      const chargedSeconds = Math.min(15, remaining);
      charge(userId, chargedSeconds);
      const id = crypto.randomUUID();
      leases.set(id, {
        id, userId, device, status: 'active', startedAt: clock.now(), lastBeatAt: clock.now() + chargedSeconds * 1000, endedAt: null, billed: chargedSeconds,
      });
      return { leaseId: id, remainingSeconds: remaining - chargedSeconds, chargedSeconds, expired };
    },
    async billLease(userId, leaseId) { return bill(userId, leaseId, false); },
    async stopLease(userId, leaseId) { return bill(userId, leaseId, true); },
    async leaseState(userId, leaseId) {
      const l = own(userId, leaseId);
      const status = l.status === 'active' && stale(l) ? 'ended' : l.status;
      const remaining = remainingOf(userId);
      const prepaid = Math.max(Math.ceil((l.lastBeatAt - clock.now()) / 1000), 0);
      return { status, remainingSeconds: remaining, usableSeconds: status === 'active' ? remaining + prepaid : 0 };
    },
    async expireLeases() {
      const ids = [];
      for (const l of leases.values()) if (closeStale(l) !== null) ids.push(l.id);
      return ids;
    },
    async recordUsage(evt) {
      if (this.failWrites) throw new Error('db down');
      usage.push({ ...evt, at: clock.now() });
    },
    async spendTotals() {
      stats.spendTotalsCalls += 1;
      return spendOf(usage, this.baseSpend);
    },
    async userSpend(userId) {
      const mine = usage.filter((u) => u.userId === userId);
      const t = spendOf(mine, (this.baseUserSpend || {})[userId]);
      const dayStart = Math.floor(clock.now() / 86_400_000) * 86_400_000; // UTC midnight
      t.nebiusToday = (t.nebiusToday || 0) + mine.filter((u) => u.provider === 'nebius' && u.at >= dayStart).reduce((a, u) => a + u.costUsd, 0);
      t.geminiRequestsToday = ((this.baseUserSpend || {})[userId] || {}).geminiRequestsToday || 0;
      t.geminiRequestsToday += mine.filter((u) => u.provider === 'gemini' && u.at >= dayStart).length;
      return t;
    },
  };
}

function createFakeOpenAI({ chunks, completion, fail } = {}) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        async create(body, opts) {
          calls.push({ body: JSON.parse(JSON.stringify(body)), opts });
          if (fail) {
            const spec = typeof fail === 'number' ? { status: fail } : fail;
            const err = Object.assign(new Error('upstream'), spec.status ? { status: spec.status } : {});
            if (spec.name) err.name = spec.name;
            throw err;
          }
          if (body.stream) {
            const list = chunks || [];
            return (async function* gen() { for (const c of list) yield c; })();
          }
          return completion;
        },
      },
    },
  };
}

// A streaming client whose stream yields one chunk, then hangs until its AbortSignal fires.
function createHangingOpenAI() {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        async create(body, opts) {
          calls.push({ body: JSON.parse(JSON.stringify(body)), opts });
          const signal = opts && opts.signal;
          return (async function* gen() {
            yield { id: 'h', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'partial' } }] };
            await new Promise((resolve, reject) => {
              const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              if (!signal) return;
              if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
            });
          })();
        },
      },
    },
  };
}

class FakeUpstream extends EventEmitter {
  constructor(url, headers) {
    super();
    this.url = url;
    this.headers = headers;
    this.readyState = 0;
    this.sent = [];
    this.closeCalls = [];
    setImmediate(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.emit('open');
    });
  }
  send(data, opts) { this.sent.push({ data, binary: opts && opts.binary }); }
  close(code) {
    this.closeCalls.push(code);
    if (this.readyState === 3) return;
    this.readyState = 3;
    setImmediate(() => this.emit('close', code || 1000));
  }
  terminate() { this.close(1006); }
}

const silent = { info() {}, warn() {}, error() {} };

async function startServer(opts = {}) {
  const clock = opts.clock || createClock();
  const db = opts.db || createFakeDb(clock, opts.dbOptions);
  const nebius = opts.nebius === undefined ? createFakeOpenAI() : opts.nebius;
  const gemini = opts.gemini === undefined ? createFakeOpenAI() : opts.gemini;
  const upstreams = [];
  const verifyCalls = [];
  const vkin = createApp({
    verifyToken: async (token) => { verifyCalls.push(token); return TOKENS[token] || null; },
    db,
    nebius: () => nebius,
    gemini: () => gemini,
    deepgramConnect: (url, headers) => { const u = new FakeUpstream(url, headers); upstreams.push(u); return u; },
    deepgramApiKey: 'dg-test-key',
    deepgramUrl: 'wss://deepgram.test/v2/listen',
    prices: opts.prices || loadPrices(),
    caps: { nebiusUsd: 10, deepgramUsd: 10, deepgramUsdPerMin: 0.0077, ...(opts.caps || {}) },
    limits: opts.limits,
    corsOrigins: opts.corsOrigins || ['https://vkin.example'],
    now: clock.now,
    log: silent,
  });
  const server = http.createServer(vkin.app);
  server.on('upgrade', vkin.handleUpgrade);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  const req = async (method, path, { token, body, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* SSE or empty */ }
    return { status: res.status, headers: res.headers, text, json };
  };

  const openWs = (query, { token = 'tok-a', headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stt?${query}`, { headers: h });
    ws.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.opened = new Promise((resolve) => { ws.on('open', () => resolve(true)); ws.on('close', () => resolve(false)); });
    ws.on('error', () => {});
    return ws;
  };

  const close = async () => {
    vkin.stop();
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  };

  return { base, port, clock, db, nebius, gemini, upstreams, verifyCalls, vkin, req, openWs, close };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await tick(10);
  }
  return false;
}

module.exports = { A, B, C, TOKENS, createClock, createFakeDb, createFakeOpenAI, createHangingOpenAI, FakeUpstream, startServer, tick, waitFor };
