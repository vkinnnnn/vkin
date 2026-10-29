'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { A, createClock, createFakeDb, createFakeOpenAI, startServer } = require('./helpers');
const { loadPrices } = require('../src/prices');

const QWEN = 'Qwen/Qwen3-235B-A22B-Instruct-2507';
const NEMO = 'nvidia/Nemotron-3_5-Lightning';

async function withLease(opts = {}) {
  const s = await startServer(opts);
  const { json } = await s.req('POST', '/v1/sessions/start', { token: 'tok-a', body: { device: 'laptop' } });
  s.leaseId = json.leaseId;
  s.chat = (body, extra = {}) => s.req('POST', '/v1/chat/completions', {
    token: 'tok-a', headers: { 'x-vkin-lease': s.leaseId, ...(extra.headers || {}) }, body,
  });
  return s;
}

const usageChunks = [
  { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] },
  { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }] },
  { id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } },
];

test('model not in the allowlist gives 400 model_not_allowed with no upstream call', async (t) => {
  const s = await withLease();
  t.after(s.close);
  for (const model of ['gpt-4o', 'deepseek-ai/DeepSeek-V4-Flash-0731', undefined]) {
    const r = await s.chat({ model, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'model_not_allowed');
  }
  assert.equal(s.nebius.calls.length + s.gemini.calls.length, 0);
});

test('a lease is required: missing header 409, ended lease 409, no minutes 402', async (t) => {
  const s = await withLease();
  t.after(s.close);
  const body = { model: QWEN, messages: [{ role: 'user', content: 'hi' }] };
  const missing = await s.req('POST', '/v1/chat/completions', { token: 'tok-a', body });
  assert.equal(missing.status, 409);
  assert.equal(missing.json.error, 'lease_inactive');
  const unknown = await s.req('POST', '/v1/chat/completions', {
    token: 'tok-a', body, headers: { 'x-vkin-lease': '00000000-0000-4000-8000-000000000000' },
  });
  assert.equal(unknown.status, 404);
  s.db.ents.get(A).used = 600;
  s.clock.advance(16); // the 15 s prepaid at start is used up
  const broke = await s.chat(body);
  assert.equal(broke.status, 402);
  assert.equal(broke.json.error, 'no_minutes');
  s.db.ents.get(A).used = 0;
  await s.req('POST', `/v1/sessions/${s.leaseId}/stop`, { token: 'tok-a' });
  const ended = await s.chat(body);
  assert.equal(ended.status, 409);
  assert.equal(ended.json.error, 'lease_inactive');
  assert.equal(s.nebius.calls.length, 0);
});

test('over the spend cap gives 503 capacity with zero upstream calls', async (t) => {
  const clock = createClock();
  const db = createFakeDb(clock);
  db.baseSpend = { nebius: 9.9995 };
  const s = await withLease({ clock, db });
  t.after(s.close);
  // Estimate: 1200 max_tokens on Nemotron-Ultra ($3/1M out) = $0.0036 > $0.0005 headroom.
  const r = await s.chat({ model: 'nvidia/Nemotron-3-Ultra-550b-a55b', messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'capacity');
  assert.equal(r.json.message, 'Vkin trial capacity is used up for now. Please try again later.');
  assert.equal(s.nebius.calls.length, 0);
  // Gemini is free tier (cost 0) and not affected by the Nebius cap.
  const g = await s.chat({ model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'hi' }] });
  assert.notEqual(g.status, 503);
});

test('unknown model price gives 503 price_unknown with zero upstream calls', async (t) => {
  const prices = loadPrices();
  delete prices.providers.nebius.models[QWEN];
  const s = await withLease({ prices });
  t.after(s.close);
  const r = await s.chat({ model: QWEN, messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'price_unknown');
  assert.equal(s.nebius.calls.length, 0);
});

test('SSE passthrough with forced include_usage, clamp, field filtering and metered cost', async (t) => {
  const nebius = createFakeOpenAI({ chunks: usageChunks });
  const s = await withLease({ nebius });
  t.after(s.close);
  const r = await s.chat({
    model: QWEN,
    messages: [{ role: 'system', content: 'be brief', name: 'x' }, { role: 'user', content: 'hello' }],
    stream: true,
    max_tokens: 5000,
    temperature: 0.3,
    stream_options: { include_usage: false },
    tools: [{ type: 'function' }],
    user: 'someone',
    logit_bias: { 1: 100 },
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const events = r.text.split('\n\n').filter(Boolean);
  assert.equal(events.length, 4);
  assert.deepEqual(JSON.parse(events[0].slice(6)), usageChunks[0]);
  assert.equal(events[3], 'data: [DONE]');

  const sent = nebius.calls[0].body;
  assert.deepEqual(sent, {
    model: QWEN,
    messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hello' }],
    max_tokens: 1200,
    stream: true,
    temperature: 0.3,
    stream_options: { include_usage: true },
  });

  assert.equal(s.db.usage.length, 1);
  const u = s.db.usage[0];
  assert.equal(u.provider, 'nebius');
  assert.equal(u.model, QWEN);
  assert.equal(u.unitsIn, 1000);
  assert.equal(u.unitsOut, 500);
  assert.equal(u.leaseId, s.leaseId);
  assert.ok(Math.abs(u.costUsd - (1000 * 0.2 + 500 * 0.6) / 1e6) < 1e-12);
  assert.equal(s.vkin.spend.inflight.nebius, 0);
});

test('non-stream completion is passed through and metered', async (t) => {
  const completion = { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
  const nebius = createFakeOpenAI({ completion });
  const s = await withLease({ nebius });
  t.after(s.close);
  const r = await s.chat({ model: QWEN, messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, completion);
  assert.equal(nebius.calls[0].body.max_tokens, 50);
  assert.equal(nebius.calls[0].body.stream_options, undefined);
  assert.equal(s.db.usage[0].unitsOut, 2);
});

test('Nemotron chat_template_kwargs pass through; thinking defaults off', async (t) => {
  const nebius = createFakeOpenAI({ chunks: usageChunks });
  const s = await withLease({ nebius });
  t.after(s.close);
  await s.chat({ model: NEMO, messages: [{ role: 'user', content: 'hi' }], stream: true, chat_template_kwargs: { enable_thinking: true } });
  await s.chat({ model: NEMO, messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.deepEqual(nebius.calls[0].body.chat_template_kwargs, { enable_thinking: true });
  assert.deepEqual(nebius.calls[1].body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(nebius.calls[1].body.reasoning_effort, undefined);
});

test('gemini-3.5-flash routes to Gemini with image_url data-URL parts; cost is 0', async (t) => {
  const gemini = createFakeOpenAI({ chunks: usageChunks });
  const s = await withLease({ gemini });
  t.after(s.close);
  const img = 'data:image/png;base64,iVBORw0KGgo=';
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'what is on screen?' }, { type: 'image_url', image_url: { url: img } }] }];
  const r = await s.chat({ model: 'gemini-3.5-flash', messages, stream: true, reasoning_effort: 'low', chat_template_kwargs: { x: 1 } });
  assert.equal(r.status, 200);
  assert.equal(s.nebius.calls.length, 0);
  const sent = gemini.calls[0].body;
  assert.deepEqual(sent.messages, messages);
  assert.equal(sent.reasoning_effort, 'low');
  assert.equal(sent.chat_template_kwargs, undefined);
  assert.equal(s.db.usage[0].provider, 'gemini');
  assert.equal(s.db.usage[0].costUsd, 0);

  const remote = await s.chat({ model: 'gemini-3.5-flash', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://evil.example/x.png' } }] }] });
  assert.equal(remote.status, 400);
  const nebImg = await s.chat({ model: QWEN, messages });
  assert.equal(nebImg.status, 400);
  assert.equal(gemini.calls.length, 1);
});

test('M6/N1: a 5xx upstream error gives 502, releases the reservation and records input + 25% of max_tokens', async (t) => {
  const nebius = createFakeOpenAI({ fail: 500 });
  const s = await withLease({ nebius });
  t.after(s.close);
  const r = await s.chat({ model: QWEN, messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.equal(r.status, 502);
  assert.equal(r.json.error, 'upstream_error');
  assert.equal(s.vkin.spend.inflight.nebius, 0);
  assert.equal(s.db.usage.length, 1);
  const u = s.db.usage[0];
  assert.equal(u.unitsIn, Math.ceil(Buffer.byteLength('hi') / 3) + 4); // recorded estimate: bytes/3
  assert.equal(u.unitsOut, 300);
  assert.ok(Math.abs(u.costUsd - ((5 * 0.2) + (300 * 0.6)) / 1e6) < 1e-12);
});

test('missing provider key gives 503 provider_unavailable', async (t) => {
  const s = await withLease({ nebius: null });
  t.after(s.close);
  const r = await s.chat({ model: QWEN, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'provider_unavailable');
});
