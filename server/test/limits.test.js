'use strict';
// Regression tests for the launch review (C1e, M1, M2, M5, M6, Minor 2, Minor 3).
const test = require('node:test');
const assert = require('node:assert/strict');
const { A, B, createClock, createFakeDb, createFakeOpenAI, createHangingOpenAI, startServer, waitFor } = require('./helpers');
const { buildUpstreamBody } = require('../src/chat');

const QWEN = 'Qwen/Qwen3-235B-A22B-Instruct-2507';
const ULTRA = 'nvidia/Nemotron-3-Ultra-550b-a55b';
const GEMINI = 'gemini-3.5-flash';
const usageChunks = [
  { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' } }] },
  { id: 'c', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
];

async function withLease(opts = {}, token = 'tok-a') {
  const s = await startServer(opts);
  const { json } = await s.req('POST', '/v1/sessions/start', { token, body: { device: 'laptop' } });
  s.leaseId = json.leaseId;
  s.chat = (body, extra = {}) => s.req('POST', '/v1/chat/completions', {
    token: extra.token || token, headers: { 'x-vkin-lease': extra.leaseId || s.leaseId }, body,
  });
  return s;
}

const img = (bytes) => `data:image/png;base64,${Buffer.alloc(bytes, 7).toString('base64')}`;

test('C1e: stopping a lease aborts its in-flight chat streams and their upstream calls', async (t) => {
  const nebius = createHangingOpenAI();
  const s = await withLease({ nebius });
  t.after(s.close);
  const pending = s.chat({ model: ULTRA, messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.ok(await waitFor(() => s.vkin.chat.count(s.leaseId) === 1 && nebius.calls.length === 1));
  const r = await s.req('POST', `/v1/sessions/${s.leaseId}/stop`, { token: 'tok-a' });
  assert.equal(r.status, 200);
  const res = await pending;
  assert.equal(res.status, 200);
  assert.match(res.text, /"code":"lease_inactive"/);
  assert.doesNotMatch(res.text, /\[DONE\]/);
  assert.equal(nebius.calls[0].opts.signal.aborted, true);
  assert.equal(s.vkin.chat.count(s.leaseId), 0);
  // M6: the aborted stream is billed input + 25% of max_tokens.
  assert.ok(await waitFor(() => s.db.usage.length === 1));
  assert.equal(s.db.usage[0].unitsOut, 300);
  assert.equal(s.vkin.spend.inflight.nebius, 0);
});

test('C1e: the sweep also aborts chat streams of a stale lease', async (t) => {
  const nebius = createHangingOpenAI();
  const s = await withLease({ nebius });
  t.after(s.close);
  const pending = s.chat({ model: QWEN, messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.ok(await waitFor(() => s.vkin.chat.count(s.leaseId) === 1));
  s.clock.advance(15 + 46);
  await s.vkin.tick();
  const res = await pending;
  assert.match(res.text, /lease_inactive/);
});

test('M1: at most 2 in-flight chat requests per lease (429 too_many_requests)', async (t) => {
  const nebius = createHangingOpenAI();
  const s = await withLease({ nebius });
  t.after(s.close);
  const body = { model: QWEN, messages: [{ role: 'user', content: 'hi' }], stream: true };
  const p1 = s.chat(body);
  const p2 = s.chat(body);
  assert.ok(await waitFor(() => s.vkin.chat.count(s.leaseId) === 2));
  const third = await s.chat(body);
  assert.equal(third.status, 429);
  assert.equal(third.json.error, 'too_many_requests');
  assert.equal(nebius.calls.length, 2);
  await s.req('POST', `/v1/sessions/${s.leaseId}/stop`, { token: 'tok-a' });
  await Promise.all([p1, p2]);
});

test('M1: per-user rate limit of 30 chat requests per minute', async (t) => {
  const s = await withLease();
  t.after(s.close);
  const body = { model: QWEN, messages: [{ role: 'user', content: 'hi' }] };
  for (let i = 0; i < 30; i += 1) {
    const r = await s.req('POST', '/v1/chat/completions', { token: 'tok-a', body }); // no lease header: 409
    assert.equal(r.status, 409);
  }
  const limited = await s.chat(body);
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error, 'too_many_requests');
  s.clock.advance(61);
  const ok = await s.chat(body);
  assert.notEqual(ok.status, 429);
});

test('M1: per-user Nebius dollar cap (NEBIUS_USER_CAP_USD) gives 429 user_cap with no upstream call', async (t) => {
  const clock = createClock();
  const db = createFakeDb(clock);
  db.baseUserSpend = { [A]: { nebius: 0.499, nebiusToday: 0.499 } };
  const s = await withLease({ clock, db, caps: { nebiusUserUsd: 0.5 } });
  t.after(s.close);
  const r = await s.chat({ model: ULTRA, messages: [{ role: 'user', content: 'hi' }] }); // estimate $0.0036
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'user_cap');
  assert.equal(s.nebius.calls.length, 0);
  // Another user is unaffected.
  const { json } = await s.req('POST', '/v1/sessions/start', { token: 'tok-b', body: { device: 'b' } });
  const rb = await s.chat({ model: ULTRA, messages: [{ role: 'user', content: 'hi' }] }, { token: 'tok-b', leaseId: json.leaseId });
  assert.notEqual(rb.status, 429);
  assert.equal(s.nebius.calls.length, 1);
  assert.ok(B);
});

test('M2: input estimate is the UTF-8 byte count; Nebius input over 400 KB gives 413', async (t) => {
  const text = 'é漢😀'.repeat(10); // 2 + 3 + 4 bytes per repeat
  const built = buildUpstreamBody({ model: QWEN, messages: [{ role: 'user', content: text }] }, 'nebius');
  assert.equal(built.inputTokensEstimate, Buffer.byteLength(text, 'utf8') + 4);
  assert.equal(built.inputTokensEstimate, 94);

  const s = await withLease();
  t.after(s.close);
  const big = await s.chat({ model: QWEN, messages: [{ role: 'user', content: 'a'.repeat(400 * 1024 + 1) }] });
  assert.equal(big.status, 413);
  assert.equal(big.json.error, 'too_large');
  assert.equal(s.nebius.calls.length, 0);
});

test('M5: Gemini server-wide daily request cap gives 503 capacity', async (t) => {
  const gemini = createFakeOpenAI({ chunks: usageChunks });
  const s = await withLease({ gemini, caps: { geminiDailyRequests: 2 } });
  t.after(s.close);
  const body = { model: GEMINI, messages: [{ role: 'user', content: 'hi' }], stream: true };
  assert.equal((await s.chat(body)).status, 200);
  assert.equal((await s.chat(body)).status, 200);
  const third = await s.chat(body);
  assert.equal(third.status, 503);
  assert.equal(third.json.error, 'capacity');
  assert.equal(gemini.calls.length, 2);
});

test('M5: Gemini per-user daily request cap gives 429 user_cap', async (t) => {
  const gemini = createFakeOpenAI({ chunks: usageChunks });
  const s = await withLease({ gemini, caps: { geminiUserDailyRequests: 1 } });
  t.after(s.close);
  const body = { model: GEMINI, messages: [{ role: 'user', content: 'hi' }], stream: true };
  assert.equal((await s.chat(body)).status, 200);
  const second = await s.chat(body);
  assert.equal(second.status, 429);
  assert.equal(second.json.error, 'user_cap');
  assert.equal(gemini.calls.length, 1);
});

test('M5: Gemini allows one image of at most 4 MB and no reasoning_effort high', async (t) => {
  const gemini = createFakeOpenAI({ chunks: usageChunks });
  const s = await withLease({ gemini });
  t.after(s.close);
  const two = await s.chat({ model: GEMINI, messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: img(10) } }, { type: 'image_url', image_url: { url: img(10) } },
  ] }] });
  assert.equal(two.status, 400);
  const huge = await s.chat({ model: GEMINI, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: img(4 * 1024 * 1024 + 1) } }] }] });
  assert.equal(huge.status, 413);
  const high = await s.chat({ model: GEMINI, messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' });
  assert.equal(high.status, 400);
  assert.equal(gemini.calls.length, 0);
  // Minor 3: a ~3.5 MB image request (body > 1 MB) is allowed for Gemini.
  const ok = await s.chat({ model: GEMINI, stream: true, messages: [{ role: 'user', content: [
    { type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: img(3.5 * 1024 * 1024) } },
  ] }] });
  assert.equal(ok.status, 200);
  assert.equal(gemini.calls.length, 1);
});

test('Minor 3: bodies over 1 MB are rejected except Gemini requests with an image', async (t) => {
  const s = await withLease();
  t.after(s.close);
  // Gemini without an image: 1.2 MB body.
  const r = await s.chat({ model: GEMINI, messages: [{ role: 'user', content: 'x'.repeat(1.2 * 1024 * 1024) }] });
  assert.equal(r.status, 413);
  assert.equal(r.json.error, 'too_large');
  const startBig = await s.req('POST', '/v1/sessions/start', { token: 'tok-b', body: { device: 'x', pad: 'y'.repeat(1.2 * 1024 * 1024) } });
  assert.equal(startBig.status, 413);
  assert.equal(s.gemini.calls.length, 0);
});

test('M6: an aborted non-usage stream is billed at least input + 25% of max_tokens', async (t) => {
  const nebius = createFakeOpenAI({ chunks: [{ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'short' } }] }] });
  const s = await withLease({ nebius });
  t.after(s.close);
  const r = await s.chat({ model: QWEN, messages: [{ role: 'user', content: 'hello' }], stream: true, max_tokens: 400 });
  assert.equal(r.status, 200);
  assert.equal(s.db.usage[0].unitsIn, Math.ceil(5 / 3) + 4); // N1: recorded estimate uses bytes/3
  assert.equal(s.db.usage[0].unitsOut, 100);
});

test('Minor 2: spend whose usage write failed still counts toward the caps until it is written', async (t) => {
  const nebius = createFakeOpenAI({ chunks: [
    { id: 'c', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 0, completion_tokens: 1_000_000 } },
  ] });
  // One call costs $0.60 (Qwen output $0.60/1M); server cap $0.60, user cap high.
  const s = await withLease({ nebius, caps: { nebiusUsd: 0.6, nebiusUserUsd: 100 } });
  t.after(s.close);
  s.db.failWrites = true;
  const body = { model: QWEN, messages: [{ role: 'user', content: 'hi' }], stream: true };
  assert.equal((await s.chat(body)).status, 200);
  assert.equal(s.db.usage.length, 0);
  assert.equal(s.vkin.spend.failed.length, 1);
  s.clock.advance(31); // cache expires: the DB total is still 0, but the queued $0.60 counts
  const blocked = await s.chat(body);
  assert.equal(blocked.status, 503);
  assert.equal(blocked.json.error, 'capacity');
  s.db.failWrites = false;
  await s.vkin.tick(); // retries the failed write
  assert.equal(s.db.usage.length, 1);
  assert.equal(s.vkin.spend.failed.length, 0);
});

test('N1: 4xx and connection errors are recorded at $0 and never burn the per-user cap', async (t) => {
  for (const fail of [429, 400, 401, 404, 422, { name: 'APIConnectionError' }]) {
    const nebius = createFakeOpenAI({ fail });
    // $0.005 fits one Ultra reservation ($0.0036) but not two failures billed at the old estimate plus it.
    const s = await withLease({ nebius, caps: { nebiusUserUsd: 0.005 } });
    try {
      for (let i = 0; i < 5; i += 1) {
        const r = await s.chat({ model: ULTRA, messages: [{ role: 'user', content: 'hello there' }] });
        assert.equal(r.status, 502, `attempt ${i} for ${JSON.stringify(fail)}`);
      }
      assert.equal(nebius.calls.length, 5);
      assert.equal(s.db.usage.length, 5);
      assert.ok(s.db.usage.every((u) => u.costUsd === 0 && u.unitsIn === 0 && u.unitsOut === 0));
    } finally {
      await s.close();
    }
  }
});

test('N1: 5xx and timeouts are recorded as a bytes/3 input estimate + 25% of max_tokens', async (t) => {
  for (const fail of [500, 503, { name: 'APIConnectionTimeoutError' }]) {
    const nebius = createFakeOpenAI({ fail });
    const s = await withLease({ nebius });
    try {
      await s.chat({ model: QWEN, messages: [{ role: 'user', content: 'a'.repeat(300) }], max_tokens: 800 });
      const u = s.db.usage[0];
      assert.equal(u.unitsIn, 100 + 4);
      assert.equal(u.unitsOut, 200);
      assert.ok(Math.abs(u.costUsd - (104 * 0.2 + 200 * 0.6) / 1e6) < 1e-12);
    } finally {
      await s.close();
    }
  }
});

test('N1: the per-user Nebius cap is per UTC day', async (t) => {
  const clock = createClock();
  const db = createFakeDb(clock);
  const s = await withLease({ clock, db, caps: { nebiusUserUsd: 0.5 } });
  t.after(s.close);
  db.usage.push({ userId: A, provider: 'nebius', model: QWEN, unitsIn: 0, unitsOut: 0, costUsd: 0.499, at: clock.now() });
  const blocked = await s.chat({ model: ULTRA, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error, 'user_cap');
  clock.advance(86_400); // next UTC day (cache long expired)
  const { json } = await s.req('POST', '/v1/sessions/start', { token: 'tok-a', body: { device: 'laptop' } });
  const ok = await s.chat({ model: ULTRA, messages: [{ role: 'user', content: 'hi' }] }, { leaseId: json.leaseId });
  assert.notEqual(ok.status, 429);
  assert.equal(s.nebius.calls.length, 1);
});
