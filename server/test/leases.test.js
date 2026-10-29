'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { A, startServer, waitFor } = require('./helpers');

const start = (s, token = 'tok-a', device = 'laptop') => s.req('POST', '/v1/sessions/start', { token, body: { device } });
const beat = (s, id, token = 'tok-a') => s.req('POST', `/v1/sessions/${id}/beat`, { token });
const stop = (s, id, token = 'tok-a') => s.req('POST', `/v1/sessions/${id}/stop`, { token });

test('GET /healthz needs no auth', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const r = await s.req('GET', '/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
});

test('missing or forged token gives 401; tokens are never read from the query string', async (t) => {
  const s = await startServer();
  t.after(s.close);
  for (const r of [
    await s.req('GET', '/v1/me'),
    await s.req('GET', '/v1/me', { token: 'forged' }),
    await s.req('GET', '/v1/me', { headers: { authorization: 'Basic tok-a' } }),
    await s.req('GET', '/v1/me?access_token=tok-a&token=tok-a'),
    await s.req('POST', '/v1/sessions/start?access_token=tok-a', { body: { device: 'x' } }),
  ]) {
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'unauthorized');
  }
  assert.ok(!s.verifyCalls.includes('tok-a'), 'a query-string token must never reach verification');
});

test('trial is granted once (idempotent) and only to eligible users', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const first = await s.req('GET', '/v1/me', { token: 'tok-a' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, {
    userId: A, email: 'a@example.invalid', trialSeconds: 600, purchasedSeconds: 0, usedSeconds: 0, remainingSeconds: 600, activeLease: null,
  });
  await s.req('GET', '/v1/me', { token: 'tok-a' });
  await start(s);
  assert.equal(s.db.stats.grants, 1);

  const c = await s.req('GET', '/v1/me', { token: 'tok-c' });
  assert.equal(c.json.remainingSeconds, 0);
  const cs = await start(s, 'tok-c');
  assert.equal(cs.status, 402);
  assert.equal(cs.json.error, 'no_minutes');
});

test('start returns a lease (charging the 15 s minimum); a second start gives 409; /me shows it', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const r = await start(s);
  assert.equal(r.status, 201);
  assert.equal(r.json.remainingSeconds, 585);
  assert.equal(r.json.beatEverySec, 15);
  assert.match(r.json.leaseId, /^[0-9a-f-]{36}$/);
  const again = await start(s, 'tok-a', 'phone');
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'lease_active');
  assert.ok(again.json.message);
  const me = await s.req('GET', '/v1/me', { token: 'tok-a' });
  assert.equal(me.json.activeLease.id, r.json.leaseId);
  assert.equal(me.json.activeLease.device, 'laptop');
  assert.equal(me.json.usedSeconds, 15);

  const long = await start(s, 'tok-b', 'x'.repeat(81));
  assert.equal(long.status, 400);
});

test('beat bills ceil(elapsed) DB time with no 30 s forgiveness, and returns remaining', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const { json: { leaseId } } = await start(s); // 585, prepaid through start+15
  s.clock.advance(15);
  let r = await beat(s, leaseId);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { remainingSeconds: 585, status: 'active' }); // prepaid window consumed
  s.clock.advance(15);
  r = await beat(s, leaseId);
  assert.deepEqual(r.json, { remainingSeconds: 570, status: 'active' });
  s.clock.advance(40);
  r = await beat(s, leaseId);
  assert.deepEqual(r.json, { remainingSeconds: 530, status: 'active' });
  s.clock.advance(4.2);
  r = await stop(s, leaseId);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { remainingSeconds: 525 }); // ceil(4.2) = 5
  r = await beat(s, leaseId);
  assert.deepEqual(r.json, { remainingSeconds: 525, status: 'ended' });
});

test('C1b: beating every 44 s pays for all 44 s', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const { json: { leaseId } } = await start(s);
  s.clock.advance(15);
  await beat(s, leaseId);
  for (let i = 0; i < 3; i += 1) {
    s.clock.advance(44);
    const r = await beat(s, leaseId);
    assert.equal(r.json.status, 'active');
  }
  assert.equal(s.db.ents.get(A).used, 15 + 3 * 44);
});

test('C1c: start then stop within a second still costs the 15 s minimum', async (t) => {
  const s = await startServer();
  t.after(s.close);
  for (let i = 0; i < 3; i += 1) {
    const { json: { leaseId } } = await start(s);
    s.clock.advance(0.9);
    const r = await stop(s, leaseId);
    assert.equal(r.status, 200);
  }
  assert.equal(s.db.ents.get(A).used, 45);
});

test('exhaustion gives 402 and closes the lease relays', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const { json: { leaseId } } = await start(s);
  s.db.ents.get(A).used = 590; // 10 s left
  const me = s.openWs(`lease=${leaseId}&channel=me`);
  const them = s.openWs(`lease=${leaseId}&channel=them`);
  assert.equal(await me.opened, true);
  assert.equal(await them.opened, true);
  assert.equal(s.vkin.relays.count(leaseId), 2);
  s.clock.advance(25);
  const r = await beat(s, leaseId);
  assert.equal(r.status, 402);
  assert.equal(r.json.error, 'no_minutes');
  assert.equal((await me.closed).code, 4402);
  assert.equal((await them.closed).code, 4402);
  assert.ok(await waitFor(() => s.upstreams.every((u) => u.readyState === 3)), 'upstream sockets closed');
  assert.equal(s.vkin.relays.count(leaseId), 0);
  const again = await start(s);
  assert.equal(again.status, 402);
});

test('C1a: a stale lease is swept, billed its 45 s window, and its relays close', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const { json: { leaseId } } = await start(s);
  const ws = s.openWs(`lease=${leaseId}&channel=me`);
  assert.equal(await ws.opened, true);
  s.clock.advance(15 + 46);
  await s.vkin.tick();
  assert.equal((await ws.closed).code, 4409);
  assert.equal(s.db.leases.get(leaseId).status, 'ended');
  assert.equal(s.db.ents.get(A).used, 15 + 45);
  assert.ok(await waitFor(() => s.upstreams[0].readyState === 3));
  const r = await start(s);
  assert.equal(r.status, 201);
});

test('C1a: start, never beat, start again after the stale window: every lease is billed', async (t) => {
  const s = await startServer();
  t.after(s.close);
  await start(s, 'tok-a', 'crashed');
  s.clock.advance(15 + 50);
  const r = await start(s);
  assert.equal(r.status, 201);
  assert.equal(r.json.remainingSeconds, 600 - 15 - 45 - 15);
});

test('C1d: a stale-but-unswept lease cannot be used for chat or STT', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const { json: { leaseId } } = await start(s);
  s.clock.advance(15 + 46); // no tick: the sweep has not run
  const chat = await s.req('POST', '/v1/chat/completions', {
    token: 'tok-a', headers: { 'x-vkin-lease': leaseId },
    body: { model: 'Qwen/Qwen3-235B-A22B-Instruct-2507', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(chat.status, 409);
  assert.equal(chat.json.error, 'lease_inactive');
  const ws = s.openWs(`lease=${leaseId}&channel=me`);
  assert.equal((await ws.closed).code, 4409);
  assert.equal(s.nebius.calls.length, 0);
  assert.equal(s.upstreams.length, 0);
});

test("user A cannot beat, stop or use B's lease (404)", async (t) => {
  const s = await startServer();
  t.after(s.close);
  const { json: { leaseId } } = await start(s, 'tok-b', 'b');
  for (const path of [`/v1/sessions/${leaseId}/beat`, `/v1/sessions/${leaseId}/stop`]) {
    const r = await s.req('POST', path, { token: 'tok-a' });
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'not_found');
  }
  const chat = await s.req('POST', '/v1/chat/completions', {
    token: 'tok-a',
    headers: { 'x-vkin-lease': leaseId },
    body: { model: 'Qwen/Qwen3-235B-A22B-Instruct-2507', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(chat.status, 404);
  assert.equal(s.nebius.calls.length, 0);
  const ws = s.openWs(`lease=${leaseId}&channel=me`);
  assert.equal((await ws.closed).code, 4404);
  assert.equal(s.upstreams.length, 0);
  const bad = await s.req('POST', '/v1/sessions/not-a-uuid/beat', { token: 'tok-a' });
  assert.equal(bad.status, 404);
  assert.equal(s.db.leases.get(leaseId).status, 'active');
});

test('stop closes the lease relays within 1 s', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const { json: { leaseId } } = await start(s);
  const ws = s.openWs(`lease=${leaseId}&channel=them`);
  assert.equal(await ws.opened, true);
  const started = Date.now();
  s.clock.advance(3);
  const r = await stop(s, leaseId);
  assert.deepEqual(r.json, { remainingSeconds: 585 });
  assert.equal((await ws.closed).code, 4409);
  assert.ok(await waitFor(() => s.upstreams[0].readyState === 3));
  assert.ok(Date.now() - started < 1000);
});
