// @ts-check
'use strict';
// Builds the LLM object the TurnManager uses. With budget.enabled, every call goes
// providers -> budget guard -> provider; otherwise the legacy llm.js path is used (rollback).
const fs = require('fs');
const path = require('path');
const { createLlm } = require('./llm');
const { createRegistry } = require('./providers/registry');
const { createProviders } = require('./providers');
const { createBudgetGuard } = require('./budget');

const FRIENDLY = {
  BUDGET_KILL_SWITCH: 'Live AI is off. Turn it on with the "AI off" pill or the ⋮ menu.',
  BUDGET_PRICE_UNKNOWN: 'No approved price for this model, so the call was blocked (BUDGET_PRICE_UNKNOWN).',
  BUDGET_GUARD_UNAVAILABLE: 'Budget ledger unavailable or unreadable; live calls blocked (BUDGET_GUARD_UNAVAILABLE).',
  BUDGET_HARD_STOP: 'Nebius budget hard stop reached; live calls blocked (BUDGET_HARD_STOP).',
  BUDGET_RESERVE_PROTECTED: 'This call would use the protected reserve; blocked (BUDGET_RESERVE_PROTECTED).',
  BUDGET_BUCKET_LIMIT: 'This budget bucket is used up; blocked (BUDGET_BUCKET_LIMIT).',
  BUDGET_DAILY_LIMIT: 'Daily request limit reached (BUDGET_DAILY_LIMIT).',
  BUDGET_SESSION_LIMIT: 'Session request limit reached (BUDGET_SESSION_LIMIT).',
  PROVIDER_NO_KEY: 'No API key configured for the AI provider (set it in .env).',
};

// Hosted mode: the Vkin server admits, meters and caps every call (docs/vkin-hosted-api.md), so the local
// dollar guard steps aside. The "AI off" switch still works and starts ON, because pressing Start already
// opens a metered session the user chose.
/** @param {string} provider */
function createHostedGuard(provider) {
  let live = true;
  return {
    isLiveEnabled: () => live,
    setLiveEnabled: (v) => { live = Boolean(v); },
    admit: async () => (live ? { ok: true, reservationId: null, estimatedUsd: null }
      : { ok: false, code: 'BUDGET_KILL_SWITCH', message: FRIENDLY.BUDGET_KILL_SWITCH }),
    settle: async () => ({ finalUsd: null }),
    status: () => ({ provider, hosted: true, liveEnabled: live, blocked: null, committedUsd: null, remainingUsableUsd: null }),
  };
}

/**
 * @param {{ config: any, root: string, env?: Record<string, string|undefined>, sessionId: string,
 *   log?: (...args: any[]) => void, onBudgetChange?: (b: any) => void, clientFactory?: any, hosted?: any }} opts
 */
function createGateway({ config, root, env = process.env, sessionId, log = () => {}, onBudgetChange = () => {}, clientFactory, hosted = null }) {
  if (!config.budget || !config.budget.enabled) {
    // The legacy llm.js path has NO budget admission and can hedge: it is an unguarded provider bypass.
    // It stays only as a deliberate emergency rollback and must be opted into explicitly, so a dropped
    // or mistyped `budget.enabled` can never silently run paid calls without the guard (fail closed).
    if (!(config.budget && config.budget.allowLegacyUnguarded === true)) {
      throw new Error('budget.enabled is false but budget.allowLegacyUnguarded is not true: refusing to run the unguarded legacy LLM path. Set budget.enabled=true (recommended), or budget.allowLegacyUnguarded=true to deliberately accept an unguarded, ungoverned provider path.');
    }
    log('WARNING: running the UNGUARDED legacy LLM path (budget.allowLegacyUnguarded=true); no budget admission, hedging possible.');
    const legacy = createLlm(config, { env, ...(clientFactory ? { clientFactory } : {}) });
    return { llm: legacy, budget: () => null, setLive: () => false, mode: 'legacy' };
  }
  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(root, p));
  const prices = JSON.parse(fs.readFileSync(resolve(config.budget.pricesFile), 'utf8'));
  const dataDir = resolve(config.budget.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });

  // Optional env overrides for the $40-mode numbers (config.json holds the defaults).
  const num = (name) => (env[name] !== undefined && env[name] !== '' && Number.isFinite(Number(env[name])) ? Number(env[name]) : undefined);
  const nb = { ...config.budget.nebius };
  // Env values may only make the limits stricter than config.json, never looser.
  /** @type {Array<[string, string, (...v: number[]) => number]>} */
  const TIGHTEN = [['totalBudgetUsd', 'NEBIUS_TOTAL_BUDGET_USD', Math.min], ['hardStopUsd', 'NEBIUS_HARD_STOP_USD', Math.min], ['protectedReserveUsd', 'NEBIUS_PROTECTED_RESERVE_USD', Math.max], ['safetyMultiplier', 'NEBIUS_COST_SAFETY_MULTIPLIER', Math.max]];
  for (const [key, name, pick] of TIGHTEN) {
    if (num(name) !== undefined) nb[key] = pick(nb[key], num(name));
  }
  config = { ...config, budget: { ...config.budget, nebius: nb } };
  const envLive = (name) => (env[name] === undefined ? null : env[name] === 'true');
  const startLive = config.budget.liveCallsEnabledAtStartup === true;
  for (const name of ['NEBIUS_LIVE_CALLS_ENABLED', 'GEMINI_LIVE_CALLS_ENABLED']) if (env[name] === 'true') log(`WARNING: ${name}=true, live calls are ON at startup`);
  const isHosted = Boolean(hosted && hosted.enabled);
  if (isHosted) log('llm hosted mode via', hosted.apiUrl);
  const guards = isHosted ? { nebius: createHostedGuard('nebius'), gemini: createHostedGuard('gemini') } : {
    nebius: createBudgetGuard({ provider: 'nebius', dataDir, prices, config: config.budget, sessionId, liveEnabled: envLive('NEBIUS_LIVE_CALLS_ENABLED') ?? startLive }),
    gemini: createBudgetGuard({ provider: 'gemini', dataDir, prices, config: config.budget, sessionId, liveEnabled: envLive('GEMINI_LIVE_CALLS_ENABLED') ?? startLive }),
  };
  const registry = createRegistry(config, env);
  const providers = createProviders({ config, registry, guards, prices, env, log, ...(isHosted ? { endpoint: () => hosted.endpoint() } : {}), ...(clientFactory ? { clientFactory } : {}) });
  let primary = { provider: 'nebius', route: 'default' };

  const budget = () => ({
    nebius: guards.nebius.status(),
    gemini: guards.gemini.status(),
    routes: registry.routes(),
    geminiFallback: config.llm.geminiFallback || 'manual',
  });

  const llm = {
    info() {
      const model = registry.modelFor(primary.route);
      const spec = config.llm.providers[primary.provider] || {};
      return { provider: primary.provider, model, privacyNote: spec.privacyNote || '', liveEnabled: guards[primary.provider].isLiveEnabled() };
    },
    setProvider(provider, model) {
      const spec = config.llm.providers[provider];
      if (!spec || (spec.models && !spec.models.includes(model))) throw new Error(`Model "${model}" is not configured for "${provider}"`);
      if (registry.providerOf(model) !== provider) throw new Error(`No capability entry for "${model}"`);
      if (provider === 'gemini') {
        registry.setOverride('gemini_fallback', model);
        primary = { provider, route: 'gemini_fallback' };
      } else {
        registry.setOverride('default', model);
        primary = { provider, route: 'default' };
      }
      return llm.info();
    },
    async stream({ messages, signal, onDelta, turnId, bucket, maxOutputTokens, route, reasoning, allowFallback }) {
      // Screen interpretation always uses the vision route and never falls back to a text-only model.
      const vision = route === 'vision';
      try {
        const res = await providers.stream({
          // The router may pick deep/personal for Nebius; a manually chosen Gemini model always uses its own route.
          route: vision ? 'vision' : primary.provider === 'gemini' ? primary.route : (route || primary.route), messages, signal, onDelta, turnId, maxOutputTokens, reasoning,
          bucket: bucket || 'production_test', allowFallback: !vision && allowFallback !== false && primary.provider === 'nebius',
        });
        if (res.fallbackReason) log('fallback ->', res.model, res.fallbackReason);
        return res;
      } catch (e) {
        throw Object.assign(new Error(FRIENDLY[e.code] || e.message), { code: e.code });
      } finally {
        onBudgetChange(budget());
      }
    },
  };

  function setLive(provider, value) {
    if (!guards[provider]) return false;
    guards[provider].setLiveEnabled(Boolean(value));
    log('live calls', provider, value ? 'ON' : 'OFF');
    onBudgetChange(budget());
    return true;
  }

  return { llm, budget, setLive, providers, registry, guards, mode: isHosted ? 'hosted' : 'budget' };
}

module.exports = { createGateway, FRIENDLY };
