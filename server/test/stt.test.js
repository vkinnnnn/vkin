'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, waitFor, tick } = require('./helpers');
const { buildFluxUpstreamUrl } = require('../src/stt');

async function withLease(opts) {
  const s = await startServer(opts);
  const { json } = await s.req('POST', '/v1/sessions/start', { token: 'tok-a', body: { device: 'laptop' } });
  s.leaseId = json.leaseId;
  return s;
}

test('missing DEEPGRAM_USD_PER_MIN refuses STT with close 4503 and no upstream', async (t) => {
  const s = await withLease({ caps: { deepgramUsdPerMin: undefined } });
  t.after(s.close);
  const ws = s.openWs(`lease=${s.leaseId}&channel=me`);
  assert.equal((await ws.closed).code, 4503);
  assert.equal(s.upstreams.length, 0);
});

test('unauthorized upgrade closes 4401; a query-string token is ignored', async (t) => {
  const s = await withLease();
  t.after(s.close);
  s.verifyCalls.length = 0;
  const noAuth = s.openWs(`lease=${s.leaseId}&channel=me&access_token=tok-a&token=tok-a`, { token: null });
  assert.equal((await noAuth.closed).code, 4401);
  const forged = s.openWs(`lease=${s.leaseId}&channel=me`, { token: 'forged' });
  assert.equal((await forged.closed).code, 4401);
  assert.ok(!s.verifyCalls.includes('tok-a'));
  assert.equal(s.upstreams.length, 0);
});

test('only allowlisted Flux params pass; keyterms capped at 50; mip_opt_out added; key stays server-side', async (t) => {
  const s = await withLease();
  t.after(s.close);
  const q = new URLSearchParams({
    lease: s.leaseId, channel: 'me', model: 'nova-3', encoding: 'mulaw', sample_rate: '48000',
    eot_threshold: '0.7', eager_eot_threshold: '0.5', eot_timeout_ms: '4000',
    callback: 'https://evil.example', mip_opt_out: 'false', tag: 'x', redact: 'true',
  });
  for (let i = 0; i < 60; i += 1) q.append('keyterm', `term${i}`);
  q.append('keyterm', 'x'.repeat(101));
  const ws = s.openWs(q.toString());
  assert.equal(await ws.opened, true);
  assert.ok(await waitFor(() => s.upstreams.length === 1));
  const up = new URL(s.upstreams[0].url);
  assert.equal(`${up.origin}${up.pathname}`, 'wss://deepgram.test/v2/listen');
  const p = up.searchParams;
  assert.equal(p.get('model'), 'flux-general-en');
  assert.equal(p.get('encoding'), 'linear16');
  assert.equal(p.get('sample_rate'), '16000');
  assert.equal(p.get('eot_threshold'), '0.7');
  assert.equal(p.get('eager_eot_threshold'), '0.5');
  assert.equal(p.get('eot_timeout_ms'), '4000');
  assert.deepEqual(p.getAll('mip_opt_out'), ['true']);
  assert.equal(p.getAll('keyterm').length, 50);
  assert.equal(p.getAll('keyterm')[49], 'term49');
  for (const k of ['callback', 'tag', 'redact', 'lease', 'channel', 'access_token']) assert.equal(p.get(k), null);
  assert.deepEqual(s.upstreams[0].headers, { Authorization: 'Token dg-test-key' });
  ws.close();
});

test('buildFluxUpstreamUrl drops out-of-range numbers', () => {
  const url = new URL(buildFluxUpstreamUrl('wss://x/v2/listen', new URLSearchParams('eot_threshold=7&eot_timeout_ms=abc&eager_eot_threshold=0.4')));
  assert.equal(url.searchParams.get('eot_threshold'), null);
  assert.equal(url.searchParams.get('eot_timeout_ms'), null);
  assert.equal(url.searchParams.get('eager_eot_threshold'), '0.4');
  assert.equal(url.searchParams.get('mip_opt_out'), 'true');
});

test('third relay on a lease closes 4429; a duplicate channel too', async (t) => {
  const s = await withLease();
  t.after(s.close);
  const me = s.openWs(`lease=${s.leaseId}&channel=me`);
  const them = s.openWs(`lease=${s.leaseId}&channel=them`);
  assert.equal(await me.opened, true);
  assert.equal(await them.opened, true);
  const third = s.openWs(`lease=${s.leaseId}&channel=me`);
  assert.equal((await third.closed).code, 4429);
  assert.equal(s.upstreams.length, 2);
  me.close();
  await me.closed;
  assert.ok(await waitFor(() => s.vkin.relays.count(s.leaseId) === 1));
  const again = s.openWs(`lease=${s.leaseId}&channel=me`);
  assert.equal(await again.opened, true);
  again.close();
  them.close();
});

test('relays audio, returns upstream text, meters bytes, and lease end closes both sockets', async (t) => {
  const s = await withLease();
  t.after(s.close);
  const me = s.openWs(`lease=${s.leaseId}&channel=me`);
  const them = s.openWs(`lease=${s.leaseId}&channel=them`);
  assert.equal(await me.opened, true);
  assert.equal(await them.opened, true);
  assert.ok(await waitFor(() => s.upstreams.length === 2 && s.upstreams.every((u) => u.readyState === 1)));
  const received = [];
  me.on('message', (d, isBinary) => received.push({ text: d.toString(), isBinary }));

  me.send(Buffer.alloc(32000)); // 1 s of 16 kHz linear16
  me.send(JSON.stringify({ type: 'ForceEndTurn' }));
  me.send(JSON.stringify({ type: 'Configure', url: 'x' })); // not a relayed control message
  assert.ok(await waitFor(() => s.upstreams.some((u) => u.sent.length === 2)));
  const up = s.upstreams.find((u) => u.sent.length === 2);
  assert.equal(up.sent[0].binary, true);
  assert.equal(up.sent[0].data.length, 32000);
  assert.deepEqual(JSON.parse(up.sent[1].data), { type: 'ForceEndTurn' });

  up.emit('message', Buffer.from(JSON.stringify({ type: 'TurnInfo', event: 'Update' })), false);
  assert.ok(await waitFor(() => received.length === 1));
  assert.equal(received[0].isBinary, false);

  await s.vkin.tick(); // flushes metering
  const dg = s.db.usage.filter((u) => u.provider === 'deepgram');
  assert.equal(dg.length, 1);
  assert.equal(dg[0].unitsIn, 1);
  assert.ok(Math.abs(dg[0].costUsd - 0.0077 / 60) < 1e-12);
  assert.equal(dg[0].leaseId, s.leaseId);

  const started = Date.now();
  await s.req('POST', `/v1/sessions/${s.leaseId}/stop`, { token: 'tok-a' });
  const [c1, c2] = await Promise.all([me.closed, them.closed]);
  assert.equal(c1.code, 4409);
  assert.equal(c2.code, 4409);
  assert.ok(await waitFor(() => s.upstreams.every((u) => u.readyState === 3)));
  assert.ok(Date.now() - started < 1000);
  await tick();
  assert.equal(s.vkin.spend.inflight.deepgram, 0);
});

test('an ended lease closes 4409 and no minutes closes 4402', async (t) => {
  const s = await withLease();
  t.after(s.close);
  await s.req('POST', `/v1/sessions/${s.leaseId}/stop`, { token: 'tok-a' });
  const ended = s.openWs(`lease=${s.leaseId}&channel=me`);
  assert.equal((await ended.closed).code, 4409);
  const { json } = await s.req('POST', '/v1/sessions/start', { token: 'tok-a', body: { device: 'laptop' } });
  s.db.ents.get('a0000000-0000-4000-8000-000000000001').used = 600;
  s.clock.advance(16); // prepaid start window used up
  const broke = s.openWs(`lease=${json.leaseId}&channel=me`);
  assert.equal((await broke.closed).code, 4402);
  assert.equal(s.upstreams.length, 0);
});

test('Deepgram over the server cap closes 4503 before any upstream call', async (t) => {
  const s = await withLease({ caps: { deepgramUsd: 0 } });
  t.after(s.close);
  const ws = s.openWs(`lease=${s.leaseId}&channel=me`);
  assert.equal((await ws.closed).code, 4503);
  assert.equal(s.upstreams.length, 0);
});

test('non-/v1/stt upgrades are dropped', async (t) => {
  const s = await withLease();
  t.after(s.close);
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/v1/other`, { headers: { authorization: 'Bearer tok-a' } });
  const err = await new Promise((resolve) => { ws.on('error', resolve); ws.on('open', () => resolve(null)); });
  assert.ok(err);
});

test('M3: a malformed handshake is rejected before any reservation or registration', async (t) => {
  const s = await withLease();
  t.after(s.close);
  const net = require('node:net');
  const reply = await new Promise((resolve) => {
    const sock = net.connect(s.port, '127.0.0.1', () => {
      sock.write([
        `GET /v1/stt?lease=${s.leaseId}&channel=me HTTP/1.1`, `Host: 127.0.0.1:${s.port}`, 'Connection: Upgrade',
        'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: not-a-valid-key',
        'Authorization: Bearer tok-a', '', '',
      ].join('\r\n'));
    });
    let data = '';
    sock.on('data', (d) => { data += d.toString(); });
    sock.on('close', () => resolve(data));
    sock.on('error', () => resolve(data));
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.equal(s.vkin.relays.count(s.leaseId), 0);
  assert.equal(s.vkin.spend.inflight.deepgram, 0);
  assert.equal(s.upstreams.length, 0);
});

test('M3: a socket that dies before the upgrade completes releases its slot and reservation', async (t) => {
  const s = await withLease();
  t.after(s.close);
  const { EventEmitter } = require('node:events');
  const socket = new EventEmitter();
  Object.assign(socket, {
    readable: false, writable: false, destroyed: false,
    destroy() { if (this.destroyed) return; this.destroyed = true; setImmediate(() => this.emit('close')); },
    end() {}, write() {}, setTimeout() {}, setNoDelay() {},
  });
  const req = {
    method: 'GET',
    url: `/v1/stt?lease=${s.leaseId}&channel=me`,
    headers: {
      upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', authorization: 'Bearer tok-a',
    },
  };
  await s.vkin.relays.handleUpgrade(req, socket, Buffer.alloc(0));
  assert.ok(await waitFor(() => socket.destroyed && s.vkin.relays.count(s.leaseId) === 0));
  assert.equal(s.vkin.spend.inflight.deepgram, 0);
  // The slot is free again.
  const ws = s.openWs(`lease=${s.leaseId}&channel=me`);
  assert.equal(await ws.opened, true);
  ws.close();
});

test('M4: audio faster than 1.25x real time (15 s average) closes 1008', async (t) => {
  const s = await withLease();
  t.after(s.close);
  const ws = s.openWs(`lease=${s.leaseId}&channel=me`);
  assert.equal(await ws.opened, true);
  // The fake clock does not move: the 15 s bucket holds 600000 bytes; 19 x 32000 exceeds it.
  for (let i = 0; i < 19; i += 1) ws.send(Buffer.alloc(32000));
  assert.equal((await ws.closed).code, 1008);
  assert.ok(await waitFor(() => s.upstreams[0].readyState === 3));
});

test('M4: real-time audio is not rate limited', async (t) => {
  const s = await withLease();
  t.after(s.close);
  const ws = s.openWs(`lease=${s.leaseId}&channel=me`);
  assert.equal(await ws.opened, true);
  assert.ok(await waitFor(() => s.upstreams[0] && s.upstreams[0].readyState === 1));
  for (let i = 0; i < 20; i += 1) {
    s.clock.advance(1);
    ws.send(Buffer.alloc(32000));
    // Let the server process this frame at this clock time before moving the clock again.
    assert.ok(await waitFor(() => s.upstreams[0].sent.length === i + 1));
  }
  assert.ok(await waitFor(() => s.upstreams[0] && s.upstreams[0].sent.length === 20));
  assert.equal(s.vkin.relays.count(s.leaseId), 1);
  ws.close();
});

test('M4: the Deepgram cap is checked inline every ~5 s of audio (closes 4503)', async (t) => {
  // 60 s reservation = $0.0077 fits under $0.0078; 5 s more audio ($0.00064) goes over.
  const s = await withLease({ caps: { deepgramUsd: 0.0078 } });
  t.after(s.close);
  const ws = s.openWs(`lease=${s.leaseId}&channel=me`);
  assert.equal(await ws.opened, true);
  for (let i = 0; i < 5; i += 1) ws.send(Buffer.alloc(32000));
  assert.equal((await ws.closed).code, 4503);
});

test('M4 minor: an 8 s TCP burst after a stall does not close a real-time relay', async (t) => {
  const s = await withLease();
  t.after(s.close);
  const ws = s.openWs(`lease=${s.leaseId}&channel=me`);
  assert.equal(await ws.opened, true);
  assert.ok(await waitFor(() => s.upstreams[0] && s.upstreams[0].readyState === 1));
  let sent = 0;
  for (let i = 0; i < 5; i += 1) {
    s.clock.advance(1);
    ws.send(Buffer.alloc(32000));
    sent += 1;
    assert.ok(await waitFor(() => s.upstreams[0].sent.length === sent));
  }
  s.clock.advance(8); // network stall; the client then flushes 8 s of buffered audio at once (256000 bytes)
  for (let i = 0; i < 8; i += 1) ws.send(Buffer.alloc(32000));
  sent += 8;
  const ok = await waitFor(() => s.upstreams[0].sent.length === sent);
  assert.ok(ok, 'sent=' + s.upstreams[0].sent.length + ' relays=' + s.vkin.relays.count(s.leaseId) + ' state=' + s.upstreams[0].readyState);
  assert.equal(s.vkin.relays.count(s.leaseId), 1);
  ws.close();
});
