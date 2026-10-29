// @ts-check
'use strict';
const path = require('path');
const crypto = require('crypto');
const { createLedger } = require('./ledger');

const BUDGET_CODES = {
  KILL_SWITCH: 'BUDGET_KILL_SWITCH',
  PRICE_UNKNOWN: 'BUDGET_PRICE_UNKNOWN',
  GUARD_UNAVAILABLE: 'BUDGET_GUARD_UNAVAILABLE',
  HARD_STOP: 'BUDGET_HARD_STOP',
  RESERVE: 'BUDGET_RESERVE_PROTECTED',
  BUCKET_LIMIT: 'BUDGET_BUCKET_LIMIT',
  DAILY_LIMIT: 'BUDGET_DAILY_LIMIT',
  SESSION_LIMIT: 'BUDGET_SESSION_LIMIT',
};

const NOTE = 'Engineering control only; provider billing may differ.';
const EPS = 1e-9;
const DAY_MS = 86400000;
const WARN_LEVELS = [50, 75, 90];
const SETTLE_STATUS = new Set(['completed', 'aborted', 'failed']);

const isNum = (...vs) => vs.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
const over = (value, cap) => value > cap + EPS;
const hash12 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const str = (v) => (typeof v === 'string' && /^[\w.:/@+-]{1,120}$/.test(v) ? v : null);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const grouped = (m) => Object.fromEntries(m);

const isImagePart = (p) => p && typeof p === 'object' && (p.type === 'image_url' || p.type === 'input_image');
// Image parts (screen context, PRD Phase 5) are priced by their declared tile tokens, never by the length
// of their base64 data. Unknown size: a pessimistic 1,600 tokens (six 768-px Gemini tiles plus margin).
const IMAGE_TOKENS_DEFAULT = 1600;
function imageTokensOf(m) {
  const c = m && typeof m === 'object' && !Array.isArray(m) && 'content' in m ? m.content : null;
  if (!Array.isArray(c)) return 0;
  return c.filter(isImagePart).reduce((n, p) => n + (Number.isFinite(p.tokens) && p.tokens > 0 ? p.tokens : IMAGE_TOKENS_DEFAULT), 0);
}

function textOf(m) {
  const c = m && typeof m === 'object' && !Array.isArray(m) && 'content' in m ? m.content : m;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : isImagePart(p) ? '' : JSON.stringify(p))).join('');
  return JSON.stringify(c ?? '');
}

// Deliberately pessimistic: dense JSON, code and non-Latin text tokenize far worse than 4 chars/token.
function estimateTokens(messagesOrString) {
  const msgs = Array.isArray(messagesOrString) ? messagesOrString : [messagesOrString];
  return msgs.reduce((n, m) => {
    const t = textOf(m);
    return n + Math.ceil(Math.max(t.length / 2.5, Buffer.byteLength(t, 'utf8') / 3)) + 8 + imageTokensOf(m);
  }, 0);
}

function derive(entries) {
  const s = { opening: 0, res: new Map(), rejected: { total: 0, byCode: {} } };
  for (const e of entries) {
    if (e.type === 'open') {
      s.opening = e.cum_usd;
    } else if (e.type === 'reserve') {
      s.res.set(e.id, {
        id: e.id, ts: e.ts, route: e.route, model: e.model, bucket: e.bucket, session: e.session,
        estUsd: e.est_usd, estIn: e.est_in, estOut: e.est_out_max,
        priceVersion: e.price_version, priceIn: e.price_in, priceOut: e.price_out,
        finalUsd: null, actIn: 0, actOut: 0, reasoning: 0,
      });
    } else if (e.type === 'settle') {
      Object.assign(s.res.get(e.id), { finalUsd: e.final_usd, actIn: e.act_in, actOut: e.act_out, reasoning: e.reasoning });
    } else if (e.type === 'reject') {
      s.rejected.total++;
      s.rejected.byCode[e.code] = (s.rejected.byCode[e.code] || 0) + 1;
    }
  }
  return s;
}

function summarize(s, opening, today, session) {
  let settledUsd = Math.max(opening, s.opening);
  let openReservedUsd = 0;
  let requestsToday = 0;
  let requestsSession = 0;
  const tokens = { input: 0, output: 0, reasoning: 0 };
  const by = { model: new Map(), route: new Map(), bucket: new Map(), session: new Map() };
  const openReservations = [];
  for (const r of s.res.values()) {
    const usd = r.finalUsd ?? r.estUsd;
    if (r.finalUsd === null) {
      openReservedUsd += usd;
      openReservations.push({ id: r.id, model: r.model, estUsd: r.estUsd, ts: r.ts });
    } else {
      settledUsd += usd;
      tokens.input += r.actIn;
      tokens.output += r.actOut;
      tokens.reasoning += r.reasoning;
    }
    if (r.ts.slice(0, 10) === today) requestsToday++;
    if (r.session === session) requestsSession++;
    for (const [k, v] of [['model', r.model], ['route', r.route], ['bucket', r.bucket], ['session', r.session]]) {
      const g = by[k].get(v) || { requests: 0, usd: 0 };
      g.requests++;
      g.usd += usd;
      by[k].set(v, g);
    }
  }
  return {
    settledUsd, openReservedUsd, committedUsd: settledUsd + openReservedUsd,
    requestsToday, requestsSession, tokens, by, openReservations,
  };
}

function createBudgetGuard(opts) {
  const { provider, dataDir, prices, config, sessionId, now = () => Date.now() } = opts;
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('dataDir must be an absolute path');
  const ledger = createLedger(dataDir, provider);
  const session = hash12(sessionId);
  const opening = provider === 'nebius' ? config?.openingSpentUsd ?? 0 : 0;
  const cache = { hits: 0, misses: 0 };
  const unlogged = { total: 0, byCode: {} };
  let live = opts.liveEnabled === true;

  const countUnlogged = (code) => {
    unlogged.total++;
    unlogged.byCode[code] = (unlogged.byCode[code] || 0) + 1;
  };

  function checkedConfig() {
    const c = config?.[provider];
    const ok = c && isNum(c.totalBudgetUsd, c.hardStopUsd, c.dailyRequestLimit, c.sessionRequestLimit, c.protectedReserveUsd ?? 0, opening)
      && isNum(c.safetyMultiplier) && c.safetyMultiplier >= 1
      // The sweeper must never close a reservation that may still be streaming.
      && (config.reservationTtlMinutes === undefined || (isNum(config.reservationTtlMinutes) && config.reservationTtlMinutes >= 2));
    if (!ok) throw new Error(`invalid budget config for ${provider}`);
    return c;
  }

  function inLock(fn) {
    return ledger.withLock(() => {
      if (!isNum(opening)) throw new Error('invalid openingSpentUsd');
      const rd = ledger.read();
      if (rd.corrupt) throw new Error(`ledger corrupt at line ${rd.badLine}`);
      const entries = rd.entries;
      if (!entries.length) {
        entries.push(ledger.append({
          type: 'open', id: 'open', ts: new Date(now()).toISOString(), provider,
          price_version: prices?.version ?? null, cum_usd: opening,
        }));
      }
      sweepExpired(entries);
      return fn(entries);
    });
  }

  // Reservations never settled (crash, stuck stream) are closed at their worst-case estimate after a TTL.
  function sweepExpired(entries) {
    const ttl = (config?.reservationTtlMinutes ?? 10) * 60000;
    const t = now();
    for (const r of derive(entries).res.values()) {
      if (r.finalUsd !== null || t - Date.parse(r.ts) < ttl) continue;
      entries.push(ledger.append({
        type: 'settle', id: r.id, ts: new Date(t).toISOString(), provider, route: r.route, model: r.model, bucket: r.bucket, session: r.session,
        est_in: r.estIn, est_out_max: r.estOut, act_in: r.estIn, act_out: r.estOut, reasoning: 0,
        est_usd: r.estUsd, final_usd: r.estUsd, cum_usd: null, usage_source: 'estimate', status: 'failed',
        price_version: r.priceVersion, price_in: r.priceIn, price_out: r.priceOut,
      }));
    }
  }

  function lookupPrice(entries, model, t) {
    const unknown = (error) => ({ error });
    if (typeof prices?.version !== 'string' || !prices.version) return unknown('price registry has no version');
    if (!isNum(prices.unit_tokens) || prices.unit_tokens <= 0) return unknown('price registry unit_tokens invalid');
    const refreshed = Date.parse(prices.refreshed_at);
    if (!Number.isFinite(refreshed) || !isNum(prices.max_age_days)) return unknown('price registry date invalid');
    if (t - refreshed > prices.max_age_days * DAY_MS) return unknown('price registry is stale');
    const models = prices.providers?.[provider]?.models;
    if (typeof model !== 'string' || !models || !Object.hasOwn(models, model)) return unknown(`no price for model ${str(model)}`);
    const p = models[model];
    if (!p || !isNum(p.input, p.output)) return unknown('price entry invalid');
    if ((p.input === 0 || p.output === 0) && p.free_tier !== true) return unknown('zero price without free_tier');
    const changed = entries.some((e) => e.type === 'reserve' && e.price_version === prices.version && e.model === model
      && (e.price_in !== p.input || e.price_out !== p.output));
    if (changed) return unknown('price changed under the same registry version');
    return { input: p.input, output: p.output };
  }

  function decide(entries, req, t) {
    const c = checkedConfig();
    const { inputTokens, maxOutputTokens } = req;
    if (!isNum(inputTokens, maxOutputTokens)) throw new Error('invalid token counts');
    const sum = summarize(derive(entries), opening, dayOf(t), session);
    const price = lookupPrice(entries, req.model, t);
    if (price.error) return { code: BUDGET_CODES.PRICE_UNKNOWN, message: price.error, sum };
    const est = ((inputTokens * price.input + maxOutputTokens * price.output) / prices.unit_tokens) * c.safetyMultiplier;
    const fail = (code, message) => ({ code, message, sum, price, est });
    const after = sum.committedUsd + est;
    if (over(after, c.hardStopUsd)) return fail(BUDGET_CODES.HARD_STOP, 'hard stop would be exceeded');
    if (over(after, c.totalBudgetUsd - (c.protectedReserveUsd ?? 0))) return fail(BUDGET_CODES.RESERVE, 'protected reserve would be used');
    if (typeof req.bucket !== 'string' || !c.buckets || !Object.hasOwn(c.buckets, req.bucket)) return fail(BUDGET_CODES.BUCKET_LIMIT, `unknown bucket ${str(req.bucket)}`);
    const cap = c.buckets[req.bucket];
    if (!isNum(cap)) throw new Error('invalid bucket cap');
    if (over((sum.by.bucket.get(req.bucket)?.usd ?? 0) + est, cap)) return fail(BUDGET_CODES.BUCKET_LIMIT, `bucket ${req.bucket} cap would be exceeded`);
    if (sum.requestsToday >= c.dailyRequestLimit) return fail(BUDGET_CODES.DAILY_LIMIT, 'daily request limit reached');
    if (sum.requestsSession >= c.sessionRequestLimit) return fail(BUDGET_CODES.SESSION_LIMIT, 'session request limit reached');
    return { price, est, sum };
  }

  function recordReject(entries, req, t, d) {
    const sum = d.sum ?? summarize(derive(entries), opening, dayOf(t), session);
    ledger.append({
      type: 'reject', id: crypto.randomBytes(8).toString('hex'), ts: new Date(t).toISOString(), provider,
      route: str(req.route), model: str(req.model), bucket: str(req.bucket), session,
      est_in: isNum(req.inputTokens) ? req.inputTokens : null,
      est_out_max: isNum(req.maxOutputTokens) ? req.maxOutputTokens : null,
      est_usd: d.est ?? null, cum_usd: sum.settledUsd, code: d.code,
      price_version: prices?.version ?? null, price_in: d.price?.input ?? null, price_out: d.price?.output ?? null,
    });
    return { ok: false, code: d.code, message: d.message };
  }

  async function admit(req = {}) {
    const t = now();
    if (!live) {
      const d = { code: BUDGET_CODES.KILL_SWITCH, message: 'Live LLM calls are disabled' };
      try {
        await inLock((entries) => recordReject(entries, req, t, d));
      } catch {
        countUnlogged(d.code);
      }
      return { ok: false, code: d.code, message: d.message };
    }
    try {
      return await inLock((entries) => {
        const d = decide(entries, req, t);
        if (d.code) return recordReject(entries, req, t, d);
        const id = crypto.randomBytes(8).toString('hex');
        ledger.append({
          type: 'reserve', id, ts: new Date(t).toISOString(), provider,
          route: str(req.route), model: req.model, bucket: str(req.bucket), session,
          est_in: req.inputTokens, est_out_max: req.maxOutputTokens, est_usd: d.est, cum_usd: d.sum.settledUsd,
          price_version: prices.version, price_in: d.price.input, price_out: d.price.output,
        });
        return { ok: true, reservationId: id, estimatedUsd: d.est };
      });
    } catch (e) {
      countUnlogged(BUDGET_CODES.GUARD_UNAVAILABLE);
      return { ok: false, code: BUDGET_CODES.GUARD_UNAVAILABLE, message: `Budget guard unavailable: ${e.message}` };
    }
  }

  async function settle(reservationId, usage = {}) {
    if (!SETTLE_STATUS.has(usage.status)) throw new TypeError('settle: status must be completed, aborted or failed');
    return inLock((entries) => {
      const t = now();
      const r = derive(entries).res.get(reservationId);
      if (!r) throw new Error(`settle: unknown reservation ${reservationId}`);
      if (r.finalUsd !== null) throw new Error(`settle: reservation ${reservationId} already settled`);
      const inTok = isNum(usage.inputTokens) ? usage.inputTokens : r.estIn;
      const outKnown = isNum(usage.outputTokens);
      // Unknown output (failed/aborted/no usage) is charged at the reserved worst case.
      const outTok = outKnown ? usage.outputTokens : r.estOut;
      const reasoning = isNum(usage.reasoningTokens) ? usage.reasoningTokens : 0;
      const exact = isNum(usage.inputTokens) && outKnown && usage.usageSource === 'provider';
      // OpenAI-compatible completion_tokens already include reasoning tokens.
      const finalUsd = (inTok * r.priceIn + Math.max(outTok, reasoning) * r.priceOut) / prices.unit_tokens;
      const cumulativeUsd = summarize(derive(entries), opening, dayOf(t), session).settledUsd + finalUsd;
      ledger.append({
        type: 'settle', id: reservationId, ts: new Date(t).toISOString(), provider,
        route: r.route, model: r.model, bucket: r.bucket, session: r.session,
        est_in: r.estIn, est_out_max: r.estOut, act_in: inTok, act_out: outTok, reasoning,
        est_usd: r.estUsd, final_usd: finalUsd, cum_usd: cumulativeUsd,
        usage_source: exact ? 'provider' : 'estimate', status: usage.status,
        price_version: r.priceVersion, price_in: r.priceIn, price_out: r.priceOut,
      });
      return { finalUsd, cumulativeUsd };
    });
  }

  // Why the next call would be refused regardless of model, or null. Lets the UI avoid showing "AI on" while blocked.
  function blockedReason(rd, sum, c, usable) {
    if (rd.corrupt) return BUDGET_CODES.GUARD_UNAVAILABLE;
    if (!live) return BUDGET_CODES.KILL_SWITCH;
    const refreshed = Date.parse(prices?.refreshed_at);
    if (!Number.isFinite(refreshed) || !isNum(prices?.max_age_days) || now() - refreshed > prices.max_age_days * DAY_MS) return BUDGET_CODES.PRICE_UNKNOWN;
    // Any real call costs something; treat less than blockMarginUsd left as already blocked.
    const margin = isNum(c.blockMarginUsd) ? c.blockMarginUsd : 0.01;
    if (!Number.isFinite(usable) || usable - sum.committedUsd < margin) return BUDGET_CODES.HARD_STOP;
    const appBucket = config?.appBucket ?? 'production_test';
    const cap = c.buckets && Object.hasOwn(c.buckets, appBucket) ? c.buckets[appBucket] : null;
    if (isNum(cap) && cap > 0 && cap - (sum.by.bucket.get(appBucket)?.usd ?? 0) < margin) return BUDGET_CODES.BUCKET_LIMIT;
    if (isNum(c.dailyRequestLimit) && sum.requestsToday >= c.dailyRequestLimit) return BUDGET_CODES.DAILY_LIMIT;
    if (isNum(c.sessionRequestLimit) && sum.requestsSession >= c.sessionRequestLimit) return BUDGET_CODES.SESSION_LIMIT;
    return null;
  }

  function status() {
    const c = config?.[provider] ?? {};
    let rd;
    try {
      rd = ledger.read();
    } catch {
      rd = { entries: [], corrupt: true, badLine: null };
    }
    const s = derive(rd.entries);
    const sum = summarize(s, isNum(opening) ? opening : 0, dayOf(now()), session);
    const usable = Math.min(c.hardStopUsd, c.totalBudgetUsd - (c.protectedReserveUsd ?? 0));
    const money = (v) => (rd.corrupt ? null : v);
    let warnLevel = null;
    if (!rd.corrupt && Array.isArray(c.warnUsd)) {
      c.warnUsd.forEach((w, i) => { if (sum.committedUsd >= w - EPS) warnLevel = WARN_LEVELS[i] ?? warnLevel; });
    }
    const rejected = { total: s.rejected.total + unlogged.total, byCode: { ...s.rejected.byCode } };
    for (const [k, n] of Object.entries(unlogged.byCode)) rejected.byCode[k] = (rejected.byCode[k] || 0) + n;
    return {
      provider, liveEnabled: live, corrupt: rd.corrupt, badLine: rd.badLine, blocked: blockedReason(rd, sum, c, usable),
      priceMaxAgeDays: prices?.max_age_days ?? null,
      priceVersion: prices?.version ?? null, priceRefreshedAt: prices?.refreshed_at ?? null,
      totalBudgetUsd: c.totalBudgetUsd ?? null, protectedReserveUsd: c.protectedReserveUsd ?? 0, hardStopUsd: c.hardStopUsd ?? null,
      committedUsd: money(sum.committedUsd), settledUsd: money(sum.settledUsd), openReservedUsd: money(sum.openReservedUsd),
      remainingUsableUsd: rd.corrupt || !Number.isFinite(usable) ? 0 : Math.max(0, usable - sum.committedUsd),
      warnLevel,
      byModel: grouped(sum.by.model), byRoute: grouped(sum.by.route), byBucket: grouped(sum.by.bucket), bySession: grouped(sum.by.session),
      tokens: sum.tokens, requestsToday: sum.requestsToday, requestsSession: sum.requestsSession,
      rejected, cache: { ...cache }, openReservations: sum.openReservations, note: NOTE,
    };
  }

  return {
    admit,
    settle,
    status,
    setLiveEnabled(v) { live = v === true; },
    isLiveEnabled: () => live,
    recordCache(hit) { if (hit) cache.hits++; else cache.misses++; },
  };
}

module.exports = { createBudgetGuard, estimateTokens, BUDGET_CODES };
