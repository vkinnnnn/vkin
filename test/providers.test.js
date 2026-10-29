'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry } = require('../src/main/providers/registry');
const { createProviders } = require('../src/main/providers');

const KEY = 'sk-nebius-secret-123';
const config = {
  llm: {
    maxTokens: 220, temperature: 0.5, geminiFallback: 'auto', geminiReasoning: 'low',
    routes: { utility: 'nvidia/Nemotron-3_5-Lightning', default: 'Qwen/Qwen3-235B-A22B-Instruct-2507', deep: 'nvidia/Nemotron-3-Ultra-550b-a55b', personal: '', gemini_fallback: 'gemini-3.5-flash' },
    providers: {
      nebius: { baseURL: 'https://n/v1/', keyEnv: 'NEBIUS_API_KEY' },
      gemini: { baseURL: 'https://g/v1/', keyEnv: 'GEMINI_API_KEY' },
    },
  },
  budget: { nebius: { safetyMultiplier: 1.2 }, gemini: { safetyMultiplier: 1.2 } },
};
const env = { NEBIUS_API_KEY: KEY, GEMINI_API_KEY: 'g-key' };
const prices = { unit_tokens: 1e6, providers: { nebius: { models: { 'Qwen/Qwen3-235B-A22B-Instruct-2507': { input: 0.2, output: 0.6 } } }, gemini: { models: {} } } };
const sleep0 = () => Promise.resolve();

function fakeGuard(name, { block = null } = {}) {
  const g = {
    name, admits: [], settles: [],
    admit: async (req) => { g.admits.push(req); return block ? { ok: false, code: block, message: block } : { ok: true, reservationId: `${name}-${g.admits.length}`, estimatedUsd: 0.001 }; },
    settle: async (id, s) => { g.settles.push({ id, ...s }); return { finalUsd: 0.0004, cumulativeUsd: 0.0004 }; },
    isLiveEnabled: () => !block,
  };
  return g;
}

// script per provider: array of steps; each step = {fail:{status,message}} | {pieces:[], usage, delay}
function scripted(scripts) {
  const calls = [];
  const factory = (baseURL, apiKey) => ({
    chat: {
      completions: {
        create: async (body, opts) => {
          const provider = baseURL.includes('//n/') ? 'nebius' : 'gemini';
          const list = scripts[provider];
          const step = list[Math.min(calls.filter((c) => c.provider === provider).length, list.length - 1)];
          calls.push({ provider, apiKey, body, opts });
          if (step.fail) throw Object.assign(new Error(`${step.fail.message} ${apiKey}`), { status: step.fail.status });
          return (async function* () {
            if (step.delay) await new Promise((r) => setTimeout(r, step.delay));
            for (const p of step.pieces || []) {
              if (opts.signal.aborted) return;
              await new Promise((r) => setImmediate(r));
              yield { choices: [{ delta: { content: p } }] };
            }
            if (step.usage) yield { choices: [], usage: step.usage };
          })();
        },
      },
    },
  });
  return { calls, factory };
}

function setup(scripts, guardOpts = {}) {
  const s = scripted(scripts);
  const guards = { nebius: fakeGuard('nebius', guardOpts.nebius), gemini: fakeGuard('gemini', guardOpts.gemini) };
  const registry = createRegistry(config, {});
  const p = createProviders({ config, registry, guards, prices, env, clientFactory: s.factory, sleep: sleep0, random: () => 0 });
  return { p, guards, calls: s.calls };
}

test('modelParams: a reasoning model gets its thinking-off switch and system prefix; others are untouched', () => {
  const U = 'nvidia/Nemotron-3-Ultra-550b-a55b';
  const reg = createRegistry({ llm: { ...config.llm, modelParams: { [U]: { extraBody: { chat_template_kwargs: { enable_thinking: false } }, systemPrefix: '/x' } } } }, {});
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }];
  const b = reg.buildBody(U, { messages: msgs, maxOutputTokens: 300 });
  assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false });
  assert.equal(b.messages[0].content, '/x\nsys');
  assert.equal(b.model, U, 'extraBody cannot override the model');
  const q = reg.buildBody('Qwen/Qwen3-235B-A22B-Instruct-2507', { messages: msgs, maxOutputTokens: 300 });
  assert.equal(q.chat_template_kwargs, undefined);
  assert.equal(q.messages[0].content, 'sys');
});

test('the one retry goes to the Nebius fallback model when one is configured', async () => {
  const cfg = { ...config, llm: { ...config.llm, routes: { ...config.llm.routes, default: 'nvidia/Nemotron-3-Ultra-550b-a55b', nebius_fallback: 'Qwen/Qwen3-235B-A22B-Instruct-2507' } } };
  const s = scripted({ nebius: [{ fail: { status: 503, message: 'busy' } }, { pieces: ['SAY: ok'], usage: { prompt_tokens: 10, completion_tokens: 2 } }], gemini: [{}] });
  const guards = { nebius: fakeGuard('nebius'), gemini: fakeGuard('gemini') };
  const allPrices = { ...prices, providers: { ...prices.providers, nebius: { models: { ...prices.providers.nebius.models, 'nvidia/Nemotron-3-Ultra-550b-a55b': { input: 1, output: 3 } } } } };
  const p = createProviders({ config: cfg, registry: createRegistry(cfg, {}), guards, prices: allPrices, env, clientFactory: s.factory, sleep: sleep0, random: () => 0 });
  const r = await p.stream({ messages: [{ role: 'user', content: 'hi' }], onDelta: () => {} });
  assert.deepEqual(s.calls.map((c) => c.body.model), ['nvidia/Nemotron-3-Ultra-550b-a55b', 'Qwen/Qwen3-235B-A22B-Instruct-2507']);
  assert.equal(r.model, 'Qwen/Qwen3-235B-A22B-Instruct-2507');
  assert.equal(s.calls.filter((c) => c.provider === 'gemini').length, 0);
});

test('stream: default route, guard admitted with worst-case output, provider usage reconciled', async () => {
  const { p, guards, calls } = setup({ nebius: [{ pieces: ['Yeah, ', 'so.'], usage: { prompt_tokens: 900, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 0 } } }], gemini: [{}] });
  const got = [];
  const r = await p.stream({ messages: [{ role: 'user', content: 'hello there' }], onDelta: (d) => got.push(d), bucket: 'live_dev' });
  assert.deepEqual(got, ['Yeah, ', 'so.']);
  assert.equal(r.model, 'Qwen/Qwen3-235B-A22B-Instruct-2507');
  assert.equal(guards.nebius.admits[0].maxOutputTokens, 220);
  assert.equal(guards.nebius.admits[0].bucket, 'live_dev');
  assert.equal(guards.nebius.settles[0].inputTokens, 900);
  assert.equal(guards.nebius.settles[0].usageSource, 'provider');
  assert.equal(guards.nebius.settles[0].status, 'completed');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.stream_options, { include_usage: true });
  assert.equal(calls[0].body.reasoning_effort, undefined, 'unsupported param stripped');
});

test('no hedging: a slow first token never triggers a second request', async () => {
  const { p, calls } = setup({ nebius: [{ delay: 60, pieces: ['late'] }], gemini: [{}] });
  const r = await p.stream({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.text, 'late');
  assert.equal(calls.length, 1);
});

test('transient 503 before any token: exactly one retry, then Gemini fallback with its own guard', async () => {
  const { p, guards, calls } = setup({ nebius: [{ fail: { status: 503, message: 'busy' } }], gemini: [{ pieces: ['fallback'] }] });
  const r = await p.stream({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(calls.filter((c) => c.provider === 'nebius').length, 2, 'one retry only');
  assert.equal(r.provider, 'gemini');
  assert.equal(r.route, 'gemini_fallback');
  assert.match(r.fallbackReason, /nebius_error_503/);
  assert.equal(guards.gemini.admits.length, 1);
  assert.equal(calls.find((c) => c.provider === 'gemini').body.reasoning_effort, 'low');
  assert.ok(guards.nebius.settles.every((s) => s.status === 'failed'), 'failed attempts are still settled');
});

test('non-transient 400: no retry, falls back', async () => {
  const { calls, p } = setup({ nebius: [{ fail: { status: 400, message: 'bad' } }], gemini: [{ pieces: ['ok'] }] });
  const r = await p.stream({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(calls.filter((c) => c.provider === 'nebius').length, 1);
  assert.equal(r.provider, 'gemini');
});

test('budget block on Nebius falls back; if Gemini is blocked too, the call fails closed with the code', async () => {
  const one = setup({ nebius: [{ pieces: ['never'] }], gemini: [{ pieces: ['g'] }] }, { nebius: { block: 'BUDGET_KILL_SWITCH' } });
  const r = await one.p.stream({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.provider, 'gemini');
  assert.equal(r.fallbackReason, 'BUDGET_KILL_SWITCH');
  assert.equal(one.calls.filter((c) => c.provider === 'nebius').length, 0, 'blocked call never reaches the provider');
  const two = setup({ nebius: [{ pieces: ['never'] }], gemini: [{ pieces: ['never'] }] }, { nebius: { block: 'BUDGET_HARD_STOP' }, gemini: { block: 'BUDGET_KILL_SWITCH' } });
  await assert.rejects(two.p.stream({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'BUDGET_HARD_STOP' && e.fallbackFailed === 'BUDGET_KILL_SWITCH');
  assert.equal(two.calls.length, 0);
});

test('fallback can be disabled per request and by config', async () => {
  const { p } = setup({ nebius: [{ fail: { status: 400, message: 'bad' } }], gemini: [{ pieces: ['g'] }] });
  await assert.rejects(p.stream({ messages: [{ role: 'user', content: 'x' }], allowFallback: false }), (e) => e.status === 400 && !e.message.includes(KEY));
});

test('abort mid-stream: settled as aborted, no retry, no fallback, no deltas after abort', async () => {
  const { p, guards, calls } = setup({ nebius: [{ pieces: ['a', 'b', 'c', 'd'] }], gemini: [{ pieces: ['g'] }] });
  const ac = new AbortController();
  const got = [];
  const r = await p.stream({ messages: [{ role: 'user', content: 'x' }], signal: ac.signal, onDelta: (d) => { got.push(d); if (d === 'b') ac.abort(); } });
  assert.deepEqual(got, ['a', 'b']);
  assert.equal(r.aborted, true);
  assert.equal(guards.nebius.settles[0].status, 'aborted');
  assert.equal(calls.length, 1);
});

test('cancel(turnId) aborts the in-flight request for that turn', async () => {
  const { p, guards } = setup({ nebius: [{ delay: 30, pieces: ['x', 'y'] }], gemini: [{}] });
  const pending = p.stream({ messages: [{ role: 'user', content: 'x' }], turnId: 'g1' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(p.cancel('g1'), 1);
  const r = await pending;
  assert.equal(r.aborted, true);
  assert.equal(guards.nebius.settles[0].status, 'aborted');
  assert.equal(p.cancel('g1'), 0);
});

test('registry: empty PERSONAL routes to DEFAULT; env overrides config; unknown model has no capabilities', () => {
  const reg = createRegistry(config, { NEBIUS_DEFAULT_MODEL: 'deepseek-ai/DeepSeek-V4-Flash-0731' });
  assert.equal(reg.modelFor('personal'), 'deepseek-ai/DeepSeek-V4-Flash-0731');
  assert.equal(reg.capabilities('made/up'), null);
  const body = reg.buildBody('gemini-3.5-flash', { messages: [], maxOutputTokens: 99999, temperature: 0.3, reasoning: 'high' });
  assert.equal(body.reasoning_effort, undefined, 'unsupported reasoning level dropped');
  assert.equal(body.max_tokens, 8192, 'clamped to model maximum');
});

test('estimate_cost uses worst-case output and the safety multiplier; unknown price -> null', () => {
  const { p } = setup({ nebius: [{}], gemini: [{}] });
  const e = p.estimate_cost({ messages: 'a'.repeat(3500), maxOutputTokens: 300 });
  assert.ok(Math.abs(e.estimatedUsd - ((e.inputTokens * 0.2 + 300 * 0.6) / 1e6) * 1.2) < 1e-12);
  assert.equal(p.estimate_cost({ route: 'utility', messages: 'x' }), null);
});

test('[review #1] missing API key fails before any reservation is made', async () => {
  const s = scripted({ nebius: [{ pieces: ['x'] }], gemini: [{ pieces: ['g'] }] });
  const guards = { nebius: fakeGuard('nebius'), gemini: fakeGuard('gemini') };
  const p = createProviders({ config, registry: createRegistry(config, {}), guards, prices, env: { GEMINI_API_KEY: 'g' }, clientFactory: s.factory, sleep: sleep0, random: () => 0 });
  const r = await p.stream({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(guards.nebius.admits.length, 0, 'no orphan Nebius reservation');
  assert.equal(r.provider, 'gemini');
  assert.equal(r.fallbackReason, 'nebius_error_PROVIDER_NO_KEY');
});

test('[review #5] an already-aborted signal reserves nothing and calls nothing', async () => {
  const { p, guards, calls } = setup({ nebius: [{ pieces: ['x'] }], gemini: [{ pieces: ['g'] }] });
  const ac = new AbortController();
  ac.abort();
  const r = await p.stream({ messages: [{ role: 'user', content: 'x' }], signal: ac.signal });
  assert.equal(r.aborted, true);
  assert.equal(guards.nebius.admits.length + guards.gemini.admits.length, 0);
  assert.equal(calls.length, 0);
});

test('[review #3] first-token timeout is a transient error: one retry, then fallback; attempts settled as failed', async () => {
  const cfg = { ...config, llm: { ...config.llm, firstTokenTimeoutMs: 20, requestTimeoutMs: 1000 } };
  const s = scripted({ nebius: [{ delay: 200, pieces: ['late'] }], gemini: [{ pieces: ['g'] }] });
  const guards = { nebius: fakeGuard('nebius'), gemini: fakeGuard('gemini') };
  const p = createProviders({ config: cfg, registry: createRegistry(cfg, {}), guards, prices, env, clientFactory: s.factory, sleep: sleep0, random: () => 0 });
  const r = await p.stream({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(s.calls.filter((c) => c.provider === 'nebius').length, 2);
  assert.equal(r.provider, 'gemini');
  assert.match(r.fallbackReason, /ETIMEDOUT/);
  assert.deepEqual(guards.nebius.settles.map((x) => x.status), ['failed', 'failed']);
  assert.ok(guards.nebius.settles.every((x) => x.outputTokens === undefined), 'unknown output left to the guard (worst case)');
});

test('[review #2] a settle that keeps failing never throws into the caller', async () => {
  const s = scripted({ nebius: [{ pieces: ['ok'] }], gemini: [{}] });
  const g = fakeGuard('nebius');
  g.settle = async () => { throw new Error('ledger locked'); };
  const p = createProviders({ config, registry: createRegistry(config, {}), guards: { nebius: g, gemini: fakeGuard('gemini') }, prices, env, clientFactory: s.factory, sleep: sleep0, random: () => 0 });
  const r = await p.stream({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.text, 'ok');
  assert.match(r.settleError, /ledger locked/);
});

test('[review #8] SDK connection errors (code on cause) are retried once', async () => {
  const calls = [];
  const factory = (baseURL) => ({ chat: { completions: { create: async () => {
    calls.push(baseURL);
    if (calls.length === 1) throw Object.assign(new Error('Connection error.'), { cause: { code: 'ECONNRESET', message: 'socket hang up' } });
    return (async function* () { yield { choices: [{ delta: { content: 'second' } }] }; })();
  } } } });
  const p = createProviders({ config, registry: createRegistry(config, {}), guards: { nebius: fakeGuard('nebius'), gemini: fakeGuard('gemini') }, prices, env, clientFactory: factory, sleep: sleep0, random: () => 0 });
  const r = await p.stream({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.text, 'second');
  assert.equal(r.provider, 'nebius');
  assert.equal(calls.length, 2);
});

test('[re-review] kill switch is reported before a missing key', async () => {
  const s = scripted({ nebius: [{ pieces: ['x'] }], gemini: [{ pieces: ['g'] }] });
  const off = (name) => ({ ...fakeGuard(name, { block: 'BUDGET_KILL_SWITCH' }), isLiveEnabled: () => false });
  const guards = { nebius: off('nebius'), gemini: off('gemini') };
  const p = createProviders({ config, registry: createRegistry(config, {}), guards, prices, env: {}, clientFactory: s.factory, sleep: sleep0, random: () => 0 });
  await assert.rejects(p.stream({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'BUDGET_KILL_SWITCH');
  assert.equal(guards.nebius.admits.length, 1, 'rejection is ledgered');
  assert.equal(s.calls.length, 0);
});
