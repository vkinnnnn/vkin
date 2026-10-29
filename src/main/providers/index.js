// @ts-check
'use strict';
// Provider-neutral model interface. Every billable call goes through the budget guard first.
// $40 mode: no hedging, no parallel races, at most one retry (transient errors only, before any token).

const { estimateTokens } = require('../budget');

const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const isAbort = (e, signal) => Boolean(signal && signal.aborted) || (e && (e.name === 'AbortError' || /Abort/.test((e.constructor && e.constructor.name) || '')));
const TRANSIENT_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'];
const isTransient = (e) => Boolean(e) && (TRANSIENT_STATUS.has(e.status) || TRANSIENT_CODES.includes(e.code)
  || /fetch failed|socket hang up|network|connection error|timed out/i.test(`${e.message || ''} ${e.causeMessage || ''}`));

const defaultClientFactory = (baseURL, apiKey, headers) => {
  const OpenAI = /** @type {any} */ (require('openai'));
  // retries are ours, so they are counted
  return new OpenAI({ baseURL, apiKey, maxRetries: 0, ...(headers ? { defaultHeaders: headers } : {}) });
};
const { hostedCodeOf, hostedError } = require('../hosted');

function createProviders({ config, registry, guards, prices, env = process.env, endpoint = null, clientFactory = defaultClientFactory, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random, log = /** @type {(...a: any[]) => void} */ (() => {}) }) {
  const llm = config.llm;
  const clients = new Map();
  const inflight = new Map(); // turnId -> Set<AbortController>
  const health = { nebius: { lastOkAt: null, lastError: null }, gemini: { lastOkAt: null, lastError: null } };

  const redact = (msg, key) => {
    let m = String(msg == null ? '' : msg);
    if (key) m = m.split(key).join('[redacted]');
    return m.replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]');
  };

  // Hosted mode: endpoint(provider) gives the Vkin server URL, the user's token and the session lease;
  // no provider key is read on this computer.
  async function clientFor(provider) {
    const spec = llm.providers[provider];
    if (!spec) throw Object.assign(new Error(`Unknown provider "${provider}"`), { code: 'PROVIDER_UNKNOWN' });
    if (endpoint) {
      const ep = await endpoint(provider);
      const cacheKey = `${ep.baseURL}|${ep.apiKey}|${JSON.stringify(ep.headers || {})}`;
      let h = clients.get(provider);
      if (!h || h.cacheKey !== cacheKey) { h = { cacheKey, key: ep.apiKey, client: clientFactory(ep.baseURL, ep.apiKey, ep.headers) }; clients.set(provider, h); }
      return h;
    }
    const key = env[spec.keyEnv];
    if (!key) throw Object.assign(new Error(`Missing API key: set ${spec.keyEnv}`), { code: 'PROVIDER_NO_KEY' });
    let c = clients.get(provider);
    if (!c || c.key !== key) { c = { key, client: clientFactory(spec.baseURL, key) }; clients.set(provider, c); }
    return c;
  }

  function track(turnId, ctl) {
    if (!turnId) return () => {};
    if (!inflight.has(turnId)) inflight.set(turnId, new Set());
    inflight.get(turnId).add(ctl);
    return () => { const s = inflight.get(turnId); if (s) { s.delete(ctl); if (!s.size) inflight.delete(turnId); } };
  }

  // Settle must not throw into the caller; if the ledger stays unavailable, the open reservation
  // keeps counting at worst case and the guard's sweeper closes it later.
  async function settleSafely(guard, reservationId, usage) {
    for (let i = 0; i < 3; i++) {
      try {
        return await guard.settle(reservationId, usage);
      } catch (e) {
        if (/already settled/.test(e.message)) return { finalUsd: null, sweptBeforeSettle: true };
        if (i === 2) { log('settle failed; reservation left open', reservationId, e.message); return { finalUsd: null, settleError: e.message }; }
        await sleep(100 * 3 ** i);
      }
    }
    return { finalUsd: null };
  }

  // One admitted, ledgered call. Never retries itself.
  /** @param {{ provider: any, model: any, route: any, bucket: any, messages: any, maxOutputTokens: any, temperature: any, reasoning?: any, signal: any, onDelta: any, turnId: any }} args */
  async function attempt({ provider, model, route, bucket, messages, maxOutputTokens, temperature, reasoning, signal, onDelta, turnId }) {
    const guard = guards[provider];
    if (!guard) return { blocked: { code: 'BUDGET_GUARD_UNAVAILABLE', message: `No budget guard for ${provider}` } };
    if (signal && signal.aborted) return { aborted: true, text: '', emitted: false, provider, model, route };
    // Kill switch first, so "AI off" is reported (and ledgered) even when no key is configured.
    if (guard.isLiveEnabled && !guard.isLiveEnabled()) {
      return { blocked: await guard.admit({ route, model, bucket, inputTokens: estimateTokens(messages), maxOutputTokens }) };
    }
    let client;
    let key;
    try {
      ({ client, key } = await clientFor(provider)); // fail before reserving anything
    } catch (e) {
      return { error: Object.assign(new Error(e.message), { code: e.code, hostedCode: e.hostedCode }), emitted: false, provider, model, route };
    }
    const inputTokens = estimateTokens(messages);
    const adm = await guard.admit({ route, model, bucket, inputTokens, maxOutputTokens });
    if (!adm.ok) return { blocked: adm };

    const t0 = now();
    const ctl = new AbortController();
    let timedOut = null;
    const onOuter = () => ctl.abort();
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onOuter, { once: true }); }
    const untrack = track(turnId, ctl);
    const timeout = (kind) => { if (!ctl.signal.aborted) { timedOut = kind; ctl.abort(); } };
    const firstTimer = setTimeout(() => timeout('first_token'), llm.firstTokenTimeoutMs || 10000);
    const totalTimer = setTimeout(() => timeout('request'), llm.requestTimeoutMs || 30000);
    let text = '';
    let ttftMs = null;
    let usage = null;
    /** @type {any} */
    let error = null;
    try {
      if (!ctl.signal.aborted) {
        const body = registry.buildBody(model, { messages, maxOutputTokens, temperature, reasoning });
        const it = await client.chat.completions.create(body, { signal: ctl.signal });
        for await (const chunk of it) {
          if (chunk && chunk.usage) usage = chunk.usage;
          if (ctl.signal.aborted) break;
          const d = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
          if (!d) continue;
          if (ttftMs === null) { ttftMs = now() - t0; clearTimeout(firstTimer); }
          text += d;
          if (onDelta) onDelta(d);
        }
      }
    } catch (e) {
      if (!isAbort(e, ctl.signal)) {
        const cause = (e && e.cause) || {};
        const hc = endpoint ? hostedCodeOf(e) : null;
        error = hc ? hostedError(hc, e && e.status)
          : Object.assign(new Error(redact(e && e.message, key)), { status: e && e.status, code: (e && e.code) || cause.code, causeMessage: redact(cause.message, key) });
      }
    } finally {
      clearTimeout(firstTimer);
      clearTimeout(totalTimer);
      if (signal) signal.removeEventListener('abort', onOuter);
      untrack();
    }
    // A timeout is our own abort: report it as a transient error, not as a caller cancellation.
    if (timedOut && !(signal && signal.aborted)) error = Object.assign(new Error(`${provider} ${timedOut} timed out`), { code: 'ETIMEDOUT' });
    const aborted = !error && ctl.signal.aborted;
    const fromProvider = Boolean(usage && Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens));
    const settled = await settleSafely(guard, adm.reservationId, {
      inputTokens: fromProvider ? usage.prompt_tokens : inputTokens,
      // Without provider usage the guard charges the reserved worst-case output.
      ...(fromProvider ? { outputTokens: usage.completion_tokens } : (!error && !aborted ? { outputTokens: estimateTokens(text) } : {})),
      reasoningTokens: (usage && usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0,
      usageSource: fromProvider ? 'provider' : 'estimate',
      status: error ? 'failed' : aborted ? 'aborted' : 'completed',
    });
    if (error) health[provider].lastError = { at: now(), message: error.message, status: error.status };
    else if (!aborted) health[provider].lastOkAt = now();
    return {
      // dispatchedAt: when the admitted request left for the provider (per-stage latency, PRD Phase 4).
      text, ttftMs, totalMs: now() - t0, dispatchedAt: t0, aborted, error, provider, model, route,
      usage: usage || null, usageSource: fromProvider ? 'provider' : 'estimate',
      estimatedUsd: adm.estimatedUsd, finalUsd: settled.finalUsd, settleError: settled.settleError, emitted: text.length > 0,
    };
  }

  async function stream(req) {
    const route = req.route || 'default';
    const model = registry.modelFor(route);
    const provider = registry.providerOf(model);
    const base = {
      route, bucket: req.bucket || 'production_test', messages: req.messages, signal: req.signal, onDelta: req.onDelta, turnId: req.turnId,
      maxOutputTokens: req.maxOutputTokens || llm.maxTokens || 300, temperature: req.temperature != null ? req.temperature : llm.temperature,
      // Caller's reasoning level (models with reasoning control only; e.g. the vision route asks for none so
      // hidden reasoning cannot use up the output budget).
      reasoning: req.reasoning,
    };
    if (!model || !provider) throw Object.assign(new Error(`No capable model configured for route "${route}"`), { code: 'CAPABILITY_UNKNOWN' });

    let res = await attempt({ ...base, provider, model });
    // One retry: transient error only, nothing shown yet, not cancelled. When a different Nebius fallback model
    // is configured (e.g. Qwen behind Nemotron-Ultra), that one retry goes to it instead of the same model.
    // A refusal from the Vkin server (minutes, lease, capacity, sign-in) is final: no retry, no fallback.
    if (res.error && !res.emitted && !res.aborted && !res.error.hostedCode && isTransient(res.error) && !(req.signal && req.signal.aborted)) {
      await sleep(200 + Math.floor(random() * 400));
      if (!(req.signal && req.signal.aborted)) {
        const alt = registry.modelFor('nebius_fallback');
        const useAlt = provider === 'nebius' && alt && alt !== model && registry.providerOf(alt) === 'nebius';
        log('llm retry', useAlt ? `-> ${alt}` : provider, res.error.status || res.error.code || '');
        res = useAlt ? { ...(await attempt({ ...base, provider, model: alt, route: 'nebius_fallback' })), fallbackReason: 'retry_on_fallback_model' }
          : await attempt({ ...base, provider, model });
      }
    }

    const needFallback = provider === 'nebius' && llm.geminiFallback === 'auto' && req.allowFallback !== false
      && !(req.signal && req.signal.aborted) && (res.blocked || (res.error && !res.emitted && !res.error.hostedCode));
    if (needFallback) {
      const fbModel = registry.modelFor('gemini_fallback');
      const reason = res.blocked ? res.blocked.code : `nebius_error_${res.error.status || res.error.code || 'unknown'}`;
      if (fbModel && registry.providerOf(fbModel) === 'gemini') {
        const fb = await attempt({ ...base, provider: 'gemini', model: fbModel, route: 'gemini_fallback', reasoning: req.deep ? 'medium' : (llm.geminiReasoning || 'low') });
        if (!fb.blocked && !fb.error) return { ...fb, fallbackReason: reason };
        res = { ...res, fallbackFailed: fb.blocked ? fb.blocked.code : fb.error.message };
      }
    }
    if (res.blocked) throw Object.assign(new Error(res.blocked.message || res.blocked.code), { code: res.blocked.code, fallbackFailed: res.fallbackFailed });
    if (res.error) throw res.error;
    return res;
  }

  async function generate(req) {
    return stream({ ...req, onDelta: null });
  }

  function cancel(turnId) {
    const s = inflight.get(turnId);
    if (!s) return 0;
    for (const ctl of s) ctl.abort();
    return s.size;
  }

  // Worst-case admission estimate (same formula the guard uses); null when the price is unknown.
  function estimate_cost({ route = 'default', messages, maxOutputTokens, model: forModel = null }) {
    const model = forModel || registry.modelFor(route);
    const provider = registry.providerOf(model);
    const p = prices && prices.providers && prices.providers[provider] && prices.providers[provider].models[model];
    if (!p || !Number.isFinite(p.input) || !Number.isFinite(p.output)) return null;
    const mult = (config.budget && config.budget[provider] && config.budget[provider].safetyMultiplier) || 1.2;
    const inputTokens = estimateTokens(messages);
    const out = maxOutputTokens || llm.maxTokens || 300;
    return { provider, model, inputTokens, maxOutputTokens: out, estimatedUsd: ((inputTokens * p.input + out * p.output) / (prices.unit_tokens || 1e6)) * mult };
  }

  return {
    stream,
    generate,
    cancel,
    estimate_cost,
    reconcile_usage: (response) => (response && response.usage) || null,
    health: () => ({
      nebius: { ...health.nebius, liveEnabled: guards.nebius ? guards.nebius.isLiveEnabled() : false },
      gemini: { ...health.gemini, liveEnabled: guards.gemini ? guards.gemini.isLiveEnabled() : false },
    }),
    capabilities: (modelId) => registry.capabilities(modelId),
  };
}

module.exports = { createProviders, isTransient };
