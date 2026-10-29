'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGateway } = require('../src/main/llm-gateway');

const ROOT = path.join(__dirname, '..');
const baseConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

function cfg(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabel-gw-'));
  // Pinned to Qwen3-235B so price assertions do not depend on the configured default model.
  const llm = { ...baseConfig.llm, model: 'Qwen/Qwen3-235B-A22B-Instruct-2507', routes: { ...baseConfig.llm.routes, default: 'Qwen/Qwen3-235B-A22B-Instruct-2507', nebius_fallback: '' } };
  return { ...baseConfig, llm, budget: { ...baseConfig.budget, dataDir: dir, pricesFile: path.join(ROOT, 'src/main/budget/prices.json'), ...over } };
}

const calls = [];
const mockFactory = (baseURL) => ({
  chat: {
    completions: {
      create: async (body) => {
        calls.push({ baseURL, model: body.model });
        return (async function* () {
          yield { choices: [{ delta: { content: 'SAY: hi' } }] };
          yield { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 10 } };
        })();
      },
    },
  },
});
const env = { NEBIUS_API_KEY: 'k1', GEMINI_API_KEY: 'k2' };
const msgs = [{ role: 'user', content: 'Can you walk me through your capstone?' }];

test('budget disabled WITHOUT explicit opt-in fails closed: no unguarded provider bypass', () => {
  assert.throws(
    () => createGateway({ config: { ...baseConfig, budget: { ...baseConfig.budget, enabled: false } }, root: ROOT, env, sessionId: 's' }),
    /unguarded legacy LLM path|allowLegacyUnguarded/,
  );
});

test('budget disabled WITH explicit allowLegacyUnguarded -> legacy llm.js path (deliberate emergency rollback)', () => {
  const g = createGateway({ config: { ...baseConfig, budget: { ...baseConfig.budget, enabled: false, allowLegacyUnguarded: true } }, root: ROOT, env, sessionId: 's' });
  assert.equal(g.mode, 'legacy');
  assert.equal(typeof g.llm.stream, 'function');
});

test('default config (budget.enabled true) uses the guarded path, not the legacy bypass', () => {
  const g = createGateway({ config: cfg(), root: ROOT, env, sessionId: 's', clientFactory: mockFactory });
  assert.equal(g.mode, 'budget');
});

test('kill switches off at startup: no provider is called and the error is friendly', async () => {
  calls.length = 0;
  const budgets = [];
  const g = createGateway({ config: cfg(), root: ROOT, env, sessionId: 's', clientFactory: mockFactory, onBudgetChange: (b) => budgets.push(b) });
  assert.equal(g.mode, 'budget');
  assert.equal(g.llm.info().liveEnabled, false);
  await assert.rejects(g.llm.stream({ messages: msgs, signal: new AbortController().signal }), (e) => e.code === 'BUDGET_KILL_SWITCH' && /Live AI is off/.test(e.message));
  assert.equal(calls.length, 0);
  assert.ok(budgets.length >= 1, 'dashboard refreshed after the attempt');
  assert.ok(budgets.at(-1).nebius.rejected.total >= 1);
});

test('turning Nebius on: call admitted, ledgered and reconciled; Gemini untouched', async () => {
  calls.length = 0;
  const c = cfg();
  const g = createGateway({ config: c, root: ROOT, env, sessionId: 's', clientFactory: mockFactory });
  g.setLive('nebius', true);
  const got = [];
  const r = await g.llm.stream({ messages: msgs, signal: new AbortController().signal, onDelta: (d) => got.push(d) });
  assert.equal(r.provider, 'nebius');
  assert.deepEqual(got, ['SAY: hi']);
  assert.equal(calls.length, 1);
  const b = g.budget().nebius;
  assert.ok(Math.abs(b.settledUsd - (1000 * 0.2 + 10 * 0.6) / 1e6) < 1e-9, `settled ${b.settledUsd}`);
  const ledger = fs.readFileSync(path.join(c.budget.dataDir, 'nebius-ledger.jsonl'), 'utf8');
  assert.ok(!ledger.includes('capstone'), 'no message text in the ledger');
  assert.ok(!ledger.includes('k1'), 'no key in the ledger');
});

test('Nebius blocked by hard stop -> automatic Gemini fallback when Gemini is on', async () => {
  calls.length = 0;
  const g = createGateway({ config: cfg(), root: ROOT, env: { ...env, NEBIUS_HARD_STOP_USD: '0', NEBIUS_LIVE_CALLS_ENABLED: 'true', GEMINI_LIVE_CALLS_ENABLED: 'true' }, sessionId: 's', clientFactory: mockFactory });
  const r = await g.llm.stream({ messages: msgs, signal: new AbortController().signal });
  assert.equal(r.provider, 'gemini');
  assert.equal(r.model, 'gemini-3.5-flash');
  assert.ok(calls.every((x) => x.baseURL.includes('generativelanguage')));
  assert.equal(g.budget().gemini.requestsSession, 1);
});

test('picking a model without capability or price is refused; picking Gemini makes it primary with no fallback', async () => {
  const g = createGateway({ config: cfg(), root: ROOT, env: { ...env, GEMINI_LIVE_CALLS_ENABLED: 'true' }, sessionId: 's', clientFactory: mockFactory });
  assert.throws(() => g.llm.setProvider('nebius', 'made/up-model'));
  g.llm.setProvider('gemini', 'gemini-3.5-flash');
  assert.equal(g.llm.info().provider, 'gemini');
  const r = await g.llm.stream({ messages: msgs, signal: new AbortController().signal });
  assert.equal(r.provider, 'gemini');
});

test('[review #10] env overrides can tighten but never loosen budget limits', () => {
  const g = createGateway({ config: cfg(), root: ROOT, env: { ...env, NEBIUS_HARD_STOP_USD: '500', NEBIUS_PROTECTED_RESERVE_USD: '0', NEBIUS_COST_SAFETY_MULTIPLIER: '1.0' }, sessionId: 's', clientFactory: mockFactory });
  const b = g.budget().nebius;
  assert.equal(b.hardStopUsd, 32);
  assert.equal(b.protectedReserveUsd, 8);
  const t = createGateway({ config: cfg(), root: ROOT, env: { ...env, NEBIUS_HARD_STOP_USD: '5' }, sessionId: 's', clientFactory: mockFactory });
  assert.equal(t.budget().nebius.hardStopUsd, 5);
});
