'use strict';
// Model allowlist, routing and token prices (per 1M tokens, from server/prices.json).

const path = require('node:path');
const fs = require('node:fs');

// Contract allowlist: model id -> provider.
const MODEL_PROVIDER = Object.freeze({
  'nvidia/Nemotron-3_5-Lightning': 'nebius',
  'nvidia/Nemotron-3-Ultra-550b-a55b': 'nebius',
  'Qwen/Qwen3-235B-A22B-Instruct-2507': 'nebius',
  'gemini-3.5-flash': 'gemini',
});

function loadPrices(file = path.join(__dirname, '..', 'prices.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// { input, output, unit } or null when the price is missing or malformed (price unknown means reject).
function priceFor(prices, provider, model) {
  const p = prices && prices.providers && prices.providers[provider] && prices.providers[provider].models
    && prices.providers[provider].models[model];
  if (!p) return null;
  const input = Number(p.input);
  const output = Number(p.output);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  if (provider === 'gemini' && (input !== 0 || output !== 0)) return null; // paid Gemini usage is never enabled
  const unit = Number(prices.unit_tokens) > 0 ? Number(prices.unit_tokens) : 1_000_000;
  return { input, output, unit };
}

function tokenCost(price, tokensIn, tokensOut) {
  return (Math.max(tokensIn, 0) * price.input + Math.max(tokensOut, 0) * price.output) / price.unit;
}

module.exports = { MODEL_PROVIDER, loadPrices, priceFor, tokenCost };
