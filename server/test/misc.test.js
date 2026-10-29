'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers');
const { MODEL_PROVIDER, loadPrices, priceFor } = require('../src/prices');
const { bearerToken, createTokenVerifier } = require('../src/auth');
const { createDb } = require('../src/db');

test('CORS: only configured origins get Access-Control-Allow-Origin', async (t) => {
  const s = await startServer({ corsOrigins: ['https://vkin.example'] });
  t.after(s.close);
  const ok = await s.req('GET', '/healthz', { headers: { origin: 'https://vkin.example' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://vkin.example');
  const evil = await s.req('GET', '/healthz', { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const pre = await s.req('OPTIONS', '/v1/chat/completions', {
    headers: { origin: 'https://vkin.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,x-vkin-lease' },
  });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  assert.match(pre.headers.get('access-control-allow-headers'), /X-Vkin-Lease/);
  const preEvil = await s.req('OPTIONS', '/v1/me', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
  assert.equal(preEvil.headers.get('access-control-allow-origin'), null);
  assert.equal(preEvil.headers.get('access-control-allow-headers'), null);
});

test('server prices match src/main/budget/prices.json and cover the whole allowlist', (t) => {
  const server = loadPrices();
  for (const [model, provider] of Object.entries(MODEL_PROVIDER)) {
    assert.ok(priceFor(server, provider, model), `${model} has a price`);
  }
  const rootFile = path.join(__dirname, '..', '..', 'src', 'main', 'budget', 'prices.json');
  if (!fs.existsSync(rootFile)) return t.skip('desktop prices.json not present (server-only checkout)');
  const root = JSON.parse(fs.readFileSync(rootFile, 'utf8'));
  assert.equal(server.unit_tokens, root.unit_tokens);
  for (const [model, provider] of Object.entries(MODEL_PROVIDER)) {
    const a = server.providers[provider].models[model];
    const b = root.providers[provider].models[model];
    assert.ok(b, `${model} exists in the desktop prices`);
    assert.equal(a.input, b.input, `${model} input price`);
    assert.equal(a.output, b.output, `${model} output price`);
  }
});

test('priceFor rejects paid Gemini and malformed prices', () => {
  const p = { unit_tokens: 1e6, providers: { gemini: { models: { g: { input: 0.1, output: 0 } } }, nebius: { models: { n: { input: 'x', output: 1 } } } } };
  assert.equal(priceFor(p, 'gemini', 'g'), null);
  assert.equal(priceFor(p, 'nebius', 'n'), null);
  assert.equal(priceFor(p, 'nebius', 'missing'), null);
});

test('bearerToken reads only the Authorization header', () => {
  assert.equal(bearerToken({ authorization: 'Bearer abc.def.ghi' }), 'abc.def.ghi');
  assert.equal(bearerToken({ authorization: 'bearer abc' }), 'abc');
  assert.equal(bearerToken({ authorization: 'Token abc' }), null);
  assert.equal(bearerToken({}), null);
  assert.equal(bearerToken({ authorization: 'Bearer a b' }), null);
});

test('token verifier caches at most 60 s and never caches a rejection', async () => {
  let t = 0;
  let calls = 0;
  const supabase = {
    auth: {
      async getUser(token) {
        calls += 1;
        if (token === 'good') return { data: { user: { id: 'u1', email: 'e' } }, error: null };
        if (token === 'down') return { data: { user: null }, error: { status: 0, message: 'fetch failed' } };
        return { data: { user: null }, error: { status: 401, message: 'bad jwt' } };
      },
    },
  };
  const verify = createTokenVerifier({ supabase, ttlMs: 600_000, now: () => t });
  assert.deepEqual(await verify('good'), { id: 'u1', email: 'e' });
  await verify('good');
  assert.equal(calls, 1);
  t += 61_000;
  await verify('good');
  assert.equal(calls, 2);
  assert.equal(await verify('bad'), null);
  assert.equal(await verify('bad'), null);
  assert.equal(calls, 4);
  await assert.rejects(() => verify('down'));
});

test('db layer calls the SQL functions and maps PT errors', async () => {
  const calls = [];
  const replies = {
    vkin_start_lease: { data: null, error: { code: 'PT409', message: 'vkin_lease_active' } },
    vkin_bill_lease: { data: null, error: { code: 'PT402' } },
    vkin_lease_state: { data: null, error: { code: 'PT404' } },
    vkin_expire_leases: { data: ['l1'], error: null },
    vkin_spend_totals: { data: { nebius: '1.5', gemini: 0, deepgram: '0.25' }, error: null },
    vkin_me: { data: null, error: { code: '42501', message: 'permission denied' } },
  };
  const db = createDb({ async rpc(fn, args) { calls.push([fn, args]); return replies[fn] || { data: null, error: null }; } });
  await assert.rejects(() => db.startLease('u', 'd'), (e) => e.status === 409 && e.code === 'lease_active');
  await assert.rejects(() => db.billLease('u', 'l'), (e) => e.status === 402 && e.code === 'no_minutes');
  await assert.rejects(() => db.leaseState('u', 'l'), (e) => e.status === 404 && e.code === 'not_found');
  await assert.rejects(() => db.me('u'), (e) => !e.status && !/permission/.test(e.message));
  assert.deepEqual(await db.expireLeases(), ['l1']);
  assert.deepEqual(await db.spendTotals(), { nebius: 1.5, gemini: 0, deepgram: 0.25, geminiRequestsToday: 0 });
  await db.recordUsage({ userId: 'u', leaseId: 'l', provider: 'nebius', model: 'm', unitsIn: 1, unitsOut: 2, costUsd: 0.1234567 });
  assert.deepEqual(calls.at(-1), ['vkin_record_usage', { p_user: 'u', p_lease: 'l', p_provider: 'nebius', p_model: 'm', p_units_in: 1, p_units_out: 2, p_cost_usd: 0.123457 }]);
  assert.deepEqual(calls[0], ['vkin_start_lease', { p_user: 'u', p_device: 'd' }]);
});

test('index.js refuses to start without SUPABASE_SERVICE_ROLE_KEY', () => {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env, SUPABASE_URL: 'https://example.invalid', PORT: '0' };
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SUPABASE_SERVICE_ROLE_KEY/);
});
