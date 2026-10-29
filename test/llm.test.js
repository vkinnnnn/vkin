'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLlm } = require('../src/main/llm');

const KEY = 'sk-secret-value-123';
const config = {
  llm: {
    provider: 'nebius', model: 'm1', temperature: 0.5, maxTokens: 220,
    providers: {
      nebius: { baseURL: 'https://n/v1/', keyEnv: 'NEBIUS_API_KEY', models: ['m1', 'm2'], privacyNote: 'paid' },
      gemini: { baseURL: 'https://g/v1/', keyEnv: 'GEMINI_API_KEY', models: ['g1'], privacyNote: 'free tier' },
    },
  },
};
const chunk = (t) => ({ choices: [{ delta: { content: t } }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Mock client whose iterator keeps yielding even after abort.
const mockFactory = (pieces, calls = []) => (baseURL, apiKey) => ({
  chat: {
    completions: {
      create: async (body, opts) => {
        calls.push({ baseURL, apiKey, body, opts });
        return (async function* () { for (const p of pieces) { await sleep(5); yield p === null ? { choices: [{ delta: {} }] } : chunk(p); } })();
      },
    },
  },
});

test('streams deltas and returns timings, passing params to the client', async () => {
  const calls = [];
  const llm = createLlm(config, { env: { NEBIUS_API_KEY: KEY }, clientFactory: mockFactory(['Yeah, ', null, 'so ', 'sure.'], calls) });
  const got = [];
  const ac = new AbortController();
  const r = await llm.stream({ messages: [{ role: 'user', content: 'hi' }], signal: ac.signal, onDelta: (d) => got.push(d) });
  assert.deepEqual(got, ['Yeah, ', 'so ', 'sure.']);
  assert.equal(r.text, 'Yeah, so sure.');
  assert.equal(r.aborted, false);
  assert.equal(r.model, 'm1');
  assert.ok(r.ttftMs >= 0 && r.totalMs >= r.ttftMs);
  const { baseURL, apiKey, body, opts } = calls[0];
  assert.equal(baseURL, 'https://n/v1/');
  assert.equal(apiKey, KEY);
  assert.deepEqual(body, { model: 'm1', messages: [{ role: 'user', content: 'hi' }], stream: true, temperature: 0.5, max_tokens: 220 });
  assert.ok(opts.signal instanceof AbortSignal, "inner signal linked to the caller signal");
});

test('abort mid-stream stops deltas even though the mock keeps yielding, and resolves', async () => {
  const llm = createLlm(config, { env: { NEBIUS_API_KEY: KEY }, clientFactory: mockFactory(['a', 'b', 'c', 'd', 'e', 'f']) });
  const ac = new AbortController();
  const got = [];
  const r = await llm.stream({ messages: [], signal: ac.signal, onDelta: (d) => { got.push(d); if (d === 'b') ac.abort(); } });
  await sleep(50);
  assert.deepEqual(got, ['a', 'b']);
  assert.equal(r.aborted, true);
  assert.equal(r.text, 'ab');
});

test('an already-aborted signal resolves without calling the client; AbortError from the client resolves', async () => {
  const calls = [];
  const llm = createLlm(config, { env: { NEBIUS_API_KEY: KEY }, clientFactory: mockFactory(['x'], calls) });
  const ac = new AbortController();
  ac.abort();
  const r = await llm.stream({ messages: [], signal: ac.signal, onDelta: () => assert.fail('no delta') });
  assert.deepEqual([r.aborted, r.text, r.ttftMs, calls.length], [true, '', null, 0]);
  const ac2 = new AbortController();
  const thrower = () => ({ chat: { completions: { create: async () => { ac2.abort(); const e = new Error('Request was aborted.'); e.name = 'AbortError'; throw e; } } } });
  const r2 = await createLlm(config, { env: { NEBIUS_API_KEY: KEY }, clientFactory: thrower }).stream({ messages: [], signal: ac2.signal, onDelta() {} });
  assert.equal(r2.aborted, true);
});

test('missing API key error names the env var and never contains a key value', async () => {
  const llm = createLlm(config, { env: { OTHER: KEY }, clientFactory: mockFactory(['x']) });
  assert.equal(llm.hasKey(), false);
  await assert.rejects(llm.stream({ messages: [], onDelta() {} }), (e) => {
    assert.match(e.message, /NEBIUS_API_KEY/);
    assert.ok(!e.message.includes(KEY));
    return true;
  });
});

test('provider errors are redacted of the key', async () => {
  const boom = () => ({ chat: { completions: { create: async () => { const e = new Error(`401 bad key ${KEY} Bearer ${KEY}`); e.status = 401; throw e; } } } });
  const llm = createLlm(config, { env: { NEBIUS_API_KEY: KEY }, clientFactory: boom });
  await assert.rejects(llm.stream({ messages: [], onDelta() {} }), (e) => {
    assert.ok(!e.message.includes(KEY), e.message);
    assert.equal(e.status, 401);
    return true;
  });
});

test('info and setProvider validate against config and expose no key', () => {
  const llm = createLlm(config, { env: { NEBIUS_API_KEY: KEY }, clientFactory: mockFactory([]) });
  assert.deepEqual(llm.info(), { provider: 'nebius', model: 'm1', privacyNote: 'paid' });
  assert.deepEqual(llm.setProvider('nebius', 'm2'), { provider: 'nebius', model: 'm2', privacyNote: 'paid' });
  assert.equal(llm.setProvider('gemini').model, 'g1');
  assert.throws(() => llm.setProvider('nope'), /Unknown LLM provider/);
  assert.throws(() => llm.setProvider('nebius', 'zzz'), /not configured/);
  assert.equal(llm.info().provider, 'gemini');
  assert.ok(!JSON.stringify(llm.info()).includes(KEY));
});

// Per-call scripted mock: script[i] = {delay, pieces, fail}
const scriptedFactory = (script, calls = []) => () => ({
  chat: {
    completions: {
      create: async (body, opts) => {
        const i = calls.length;
        const s = script[i] || script.at(-1);
        calls.push({ body, opts });
        if (s.fail) throw Object.assign(new Error(`upstream 503 ${KEY}`), { status: 503 });
        return (async function* () {
          await sleep(s.delay || 0);
          for (const p of s.pieces) {
            if (opts.signal.aborted) return;
            await sleep(2);
            yield chunk(p);
          }
        })();
      },
    },
  },
});

test('hedge: slow first attempt loses to the hedged second; only the winner emits', async () => {
  const calls = [];
  const llm = createLlm(config, { env: { NEBIUS_API_KEY: KEY }, clientFactory: scriptedFactory([{ delay: 300, pieces: ['SLOW'] }, { delay: 0, pieces: ['fast ', 'answer'] }], calls) });
  const got = [];
  const r = await llm.stream({ messages: [], signal: new AbortController().signal, onDelta: (d) => got.push(d), hedgeMs: 40 });
  assert.equal(calls.length, 2);
  assert.deepEqual(got, ['fast ', 'answer']);
  assert.equal(r.hedged, true);
  assert.equal(r.winner, 1);
  assert.ok(calls[0].opts.signal.aborted, 'loser aborted');
});

test('hedge: fast first attempt never triggers a second request', async () => {
  const calls = [];
  const llm = createLlm(config, { env: { NEBIUS_API_KEY: KEY }, clientFactory: scriptedFactory([{ delay: 0, pieces: ['a', 'b'] }], calls) });
  const r = await llm.stream({ messages: [], signal: new AbortController().signal, onDelta: () => {}, hedgeMs: 200 });
  await sleep(250);
  assert.equal(calls.length, 1);
  assert.equal(r.text, 'ab');
});

test('early upstream error retries once immediately; persistent errors throw redacted', async () => {
  const calls = [];
  const llm = createLlm(config, { env: { NEBIUS_API_KEY: KEY }, clientFactory: scriptedFactory([{ fail: true }, { pieces: ['ok'] }], calls) });
  const r = await llm.stream({ messages: [], signal: new AbortController().signal, onDelta: () => {}, hedgeMs: 1000 });
  assert.equal(r.text, 'ok');
  assert.equal(calls.length, 2);
  const llm2 = createLlm(config, { env: { NEBIUS_API_KEY: KEY }, clientFactory: scriptedFactory([{ fail: true }]) });
  await assert.rejects(llm2.stream({ messages: [], signal: new AbortController().signal, hedgeMs: 1000 }), (e) => !e.message.includes(KEY));
});

test('hard timeout aborts hung attempts and throws', async () => {
  const llm = createLlm(config, { env: { NEBIUS_API_KEY: KEY }, clientFactory: scriptedFactory([{ delay: 5000, pieces: ['x'] }]) });
  await assert.rejects(llm.stream({ messages: [], signal: new AbortController().signal, hedgeMs: 20, timeoutMs: 120 }), /within 120 ms/);
});

test('provider extraParams are sent in the request body', async () => {
  const calls = [];
  const cfg2 = JSON.parse(JSON.stringify(config));
  cfg2.llm.providers.gemini.extraParams = { reasoning_effort: 'none' };
  const llm = createLlm(cfg2, { env: { GEMINI_API_KEY: KEY }, clientFactory: scriptedFactory([{ pieces: ['g'] }], calls) });
  llm.setProvider('gemini', 'g1');
  await llm.stream({ messages: [], signal: new AbortController().signal, onDelta: () => {} });
  assert.equal(calls[0].body.reasoning_effort, 'none');
});
