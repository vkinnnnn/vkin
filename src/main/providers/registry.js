// @ts-check
'use strict';
// Model routes and per-model capabilities. Model IDs come from env, then config, never from business logic.

// Capabilities are conservative: anything unverified is treated as unsupported and its params are stripped.
const CAPABILITIES = {
  'Qwen/Qwen3-235B-A22B-Instruct-2507': { provider: 'nebius', streaming: true, usageInStream: true, reasoningControl: null, contextTokens: 262000, maxOutputTokens: 4096, temperature: true, verified: true },
  'Qwen/Qwen3-30B-A3B-Instruct-2507': { provider: 'nebius', streaming: true, usageInStream: true, reasoningControl: null, contextTokens: 262000, maxOutputTokens: 4096, temperature: true, verified: true },
  // Reasoning models: verified 2026-10-14 only with thinking switched off via config.llm.modelParams.
  'deepseek-ai/DeepSeek-V4-Flash-0731': { provider: 'nebius', streaming: true, usageInStream: true, reasoningControl: null, contextTokens: 1024000, maxOutputTokens: 4096, temperature: true, verified: true },
  'nvidia/Nemotron-3_5-Lightning': { provider: 'nebius', streaming: true, usageInStream: true, reasoningControl: null, contextTokens: 1024000, maxOutputTokens: 4096, temperature: true, verified: true },
  'nvidia/Nemotron-3-Ultra-550b-a55b': { provider: 'nebius', streaming: true, usageInStream: true, reasoningControl: null, contextTokens: 1024000, maxOutputTokens: 4096, temperature: true, verified: true },
  'gemini-3.5-flash': { provider: 'gemini', vision: true, streaming: true, usageInStream: true, reasoningControl: 'reasoning_effort', reasoningLevels: ['none', 'low', 'medium'], contextTokens: 1000000, maxOutputTokens: 8192, temperature: true, verified: true },
};

const ROUTE_ENV = {
  utility: 'NEBIUS_UTILITY_MODEL',
  default: 'NEBIUS_DEFAULT_MODEL',
  deep: 'NEBIUS_DEEP_MODEL',
  personal: 'NEBIUS_PERSONAL_MODEL',
  gemini_fallback: 'GEMINI_FALLBACK_MODEL',
  nebius_fallback: 'NEBIUS_FALLBACK_MODEL',
  vision: 'GEMINI_VISION_MODEL', // screen interpretation (PRD Phase 5); a model with vision: true
};

// overrides: runtime choices from the overlay model picker; they win over env and config.
function createRegistry(config, env = process.env, overrides = {}) {
  const routesCfg = (config.llm && config.llm.routes) || {};
  const modelFor = (route) => {
    if (overrides[route]) return overrides[route];
    const fromEnv = env[ROUTE_ENV[route]];
    const value = (fromEnv !== undefined && fromEnv !== '' ? fromEnv : routesCfg[route]) || '';
    // An empty PERSONAL model cleanly falls back to DEFAULT.
    if (route === 'personal' && !value) return modelFor('default');
    return value;
  };

  function capabilities(modelId) {
    const cap = CAPABILITIES[modelId];
    if (!cap) return null;
    return { ...cap };
  }

  // Per-model request settings from config.llm.modelParams[modelId]: `extraBody` is merged into the request
  // (e.g. a reasoning model's "thinking off" switch) and `systemPrefix` is prepended to the system message.
  const modelParams = (config.llm && config.llm.modelParams) || {};

  // Builds the request body for one model, dropping anything the model is not known to support.
  function buildBody(modelId, { messages, maxOutputTokens, temperature, reasoning }) {
    const cap = capabilities(modelId) || {};
    const mp = modelParams[modelId] || {};
    const msgs = mp.systemPrefix && messages.length && messages[0].role === 'system'
      ? [{ ...messages[0], content: `${mp.systemPrefix}\n${messages[0].content}` }, ...messages.slice(1)]
      : messages;
    // Image parts carry an internal token estimate for the budget guard; providers never see it.
    const wire = msgs.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.map((p) => (p && p.type === 'image_url' ? { type: 'image_url', image_url: p.image_url } : p)) } : m));
    const body = { ...(mp.extraBody || {}), model: modelId, messages: wire, stream: true, max_tokens: Math.min(maxOutputTokens, cap.maxOutputTokens || maxOutputTokens) };
    if (cap.temperature !== false && typeof temperature === 'number') body.temperature = temperature;
    if (cap.usageInStream) body.stream_options = { include_usage: true };
    if (reasoning && cap.reasoningControl === 'reasoning_effort' && (cap.reasoningLevels || []).includes(reasoning)) body.reasoning_effort = reasoning;
    return body;
  }

  return {
    modelFor,
    capabilities,
    buildBody,
    providerOf: (modelId) => (CAPABILITIES[modelId] && CAPABILITIES[modelId].provider) || null,
    setOverride: (route, modelId) => { if (modelId) overrides[route] = modelId; else delete overrides[route]; },
    routes: () => Object.fromEntries(Object.keys(ROUTE_ENV).map((r) => [r, modelFor(r)])),
  };
}

module.exports = { createRegistry, CAPABILITIES, ROUTE_ENV };
