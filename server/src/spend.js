'use strict';
// Spend caps. Server-wide totals come from summing usage_events per provider; per-user totals from summing
// one user's usage_events. Both are cached 30 s, then this process adds:
//   * spend committed locally since the last refresh (commit),
//   * spend whose usage write failed and is queued for retry (never forgotten until written),
//   * in-flight estimates (reservations).
// Gemini is free tier only, so it is capped by request counts per UTC day instead of dollars.

const PROVIDERS = ['nebius', 'gemini', 'deepgram'];
const zero = () => ({ nebius: 0, gemini: 0, deepgram: 0, geminiRequestsToday: 0, nebiusToday: 0 });
const MAX_FAILED = 10_000;
const MAX_USERS_CACHED = 20_000;

function createSpendGuard({ db, caps, now = () => Date.now(), cacheMs = 30_000, log }) {
  let totals = null;
  let fetchedAt = -Infinity;
  let refreshing = null;
  const users = new Map(); // userId -> { t, fetchedAt, refreshing }
  const inflight = { nebius: 0, gemini: 0, deepgram: 0 };
  const userInflight = new Map(); // userId -> { nebius, gemini, deepgram }
  const failed = []; // usage events whose write failed; retried by retryFailed()

  const norm = (t) => ({ ...zero(), ...Object.fromEntries(Object.entries(t || {}).map(([k, v]) => [k, Number(v) || 0])) });

  async function refresh() {
    if (totals && now() - fetchedAt < cacheMs) return totals;
    if (!refreshing) {
      refreshing = db.spendTotals()
        .then((t) => { totals = norm(t); fetchedAt = now(); return totals; })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function refreshUser(userId) {
    let u = users.get(userId);
    if (u && u.t && now() - u.fetchedAt < cacheMs) return u.t;
    if (!u) {
      if (users.size >= MAX_USERS_CACHED) users.clear();
      u = { t: null, fetchedAt: -Infinity, refreshing: null };
      users.set(userId, u);
    }
    if (!u.refreshing) {
      const entry = u;
      entry.refreshing = db.userSpend(userId)
        .then((t) => { entry.t = norm(t); entry.fetchedAt = now(); return entry.t; })
        .finally(() => { entry.refreshing = null; });
    }
    return u.refreshing;
  }

  const failedSum = (provider, userId) => failed.reduce((s, e) => (
    e.provider === provider && (userId === undefined || e.userId === userId) ? s + (e.costUsd || 0) : s), 0);
  const failedGeminiCount = (userId) => failed.filter((e) => e.provider === 'gemini' && (userId === undefined || e.userId === userId)).length;
  const uInflight = (userId) => {
    if (!userInflight.has(userId)) userInflight.set(userId, { nebius: 0, gemini: 0, deepgram: 0 });
    return userInflight.get(userId);
  };

  function capFor(provider) {
    if (provider === 'nebius') return caps.nebiusUsd;
    if (provider === 'deepgram') return caps.deepgramUsd;
    return Infinity;
  }

  function reserve(provider, usd, userId) {
    let held = Math.max(usd || 0, 0);
    inflight[provider] += held;
    if (userId) uInflight(userId)[provider] += held;
    const snap = () => {
      if (inflight[provider] < 1e-9) inflight[provider] = 0; // float residue from many small adds
      if (userId) {
        const ui = uInflight(userId);
        if (ui[provider] < 1e-9) ui[provider] = 0;
        if (!ui.nebius && !ui.gemini && !ui.deepgram) userInflight.delete(userId);
      }
    };
    return {
      add(more) {
        const m = Math.max(more || 0, 0);
        held += m;
        inflight[provider] += m;
        if (userId) uInflight(userId)[provider] += m;
      },
      release(part) {
        const r = part === undefined ? held : Math.min(Math.max(part, 0), held);
        held -= r;
        inflight[provider] = Math.max(inflight[provider] - r, 0);
        if (userId) uInflight(userId)[provider] = Math.max(uInflight(userId)[provider] - r, 0);
        snap();
      },
      get held() { return held; },
    };
  }

  // Checks every applicable cap and, if there is room, reserves the estimate in the same synchronous step
  // (no race between concurrent requests). Returns { ok: true, reservation } or { ok: false, reason } with
  // reason 'capacity' (server-wide) or 'user_cap' (this user). Unknown totals mean reject.
  async function tryReserve(provider, estimateUsd, userId) {
    const est = Math.max(estimateUsd || 0, 0);
    let t;
    let ut = null;
    try {
      t = await refresh();
      if (userId && (provider === 'nebius' || provider === 'gemini')) ut = await refreshUser(userId);
    } catch {
      if (log) log.warn({ event: 'spend_totals_failed' });
      return { ok: false, reason: 'capacity' };
    }
    const cap = capFor(provider);
    if (cap !== Infinity && t[provider] + failedSum(provider) + inflight[provider] + est > cap) {
      return { ok: false, reason: 'capacity' };
    }
    if (provider === 'nebius' && ut) {
      const userCap = caps.nebiusUserUsd ?? 0.5;
      const ui = userInflight.get(userId);
      // Per user per UTC day.
      if (ut.nebiusToday + failedSum('nebius', userId) + (ui ? ui.nebius : 0) + est > userCap) return { ok: false, reason: 'user_cap' };
    }
    if (provider === 'gemini') {
      // Every request sent upstream is recorded (also on failure), so counting at reservation matches the DB.
      if (t.geminiRequestsToday + failedGeminiCount() >= (caps.geminiDailyRequests ?? 300)) return { ok: false, reason: 'capacity' };
      if (ut && ut.geminiRequestsToday + failedGeminiCount(userId) >= (caps.geminiUserDailyRequests ?? 40)) return { ok: false, reason: 'user_cap' };
      t.geminiRequestsToday += 1;
      if (ut) ut.geminiRequestsToday += 1;
    }
    return { ok: true, reservation: reserve(provider, est, userId) };
  }

  // True when recorded + queued + in-flight spend is over the cap (used by long-running relays).
  function overCap(provider) {
    const cap = capFor(provider);
    if (cap === Infinity) return false;
    return ((totals && totals[provider]) || 0) + failedSum(provider) + inflight[provider] > cap;
  }

  function commit(provider, usd, userId) {
    const c = Math.max(usd || 0, 0);
    if (totals) totals[provider] = (totals[provider] || 0) + c;
    const u = userId && users.get(userId);
    if (u && u.t) {
      u.t[provider] = (u.t[provider] || 0) + c;
      if (provider === 'nebius') u.t.nebiusToday += c;
    }
  }

  // Commits locally and writes the usage event. A failed write is queued and keeps counting toward the caps
  // until a retry succeeds (then the DB totals include it).
  async function record(evt) {
    commit(evt.provider, evt.costUsd, evt.userId);
    try {
      await db.recordUsage(evt);
    } catch {
      if (log) log.error({ event: 'usage_record_failed', provider: evt.provider });
      if (failed.length < MAX_FAILED) failed.push(evt);
    }
  }

  async function retryFailed() {
    const batch = failed.splice(0, failed.length);
    for (const evt of batch) {
      try {
        await db.recordUsage(evt);
      } catch {
        failed.push(evt);
      }
    }
  }

  return { tryReserve, overCap, reserve, commit, record, retryFailed, refresh, inflight, failed, capFor, PROVIDERS };
}

module.exports = { createSpendGuard };
