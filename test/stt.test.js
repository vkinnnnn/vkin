const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { FluxClient, buildFluxUrl, normalizeTurnInfo } = require('../src/main/stt');
const config = require('../config.json');

class FakeWS extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    FakeWS.instances.push(this);
  }
  send(d) { this.sent.push(d); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.emit('open'); }
}
FakeWS.instances = [];

const mk = () => {
  FakeWS.instances = [];
  return new FluxClient({ channel: 'them', apiKey: 'sekret-key', stt: config.stt, WebSocketImpl: FakeWS });
};
const json = (o) => Buffer.from(JSON.stringify(o));

test('buildFluxUrl has required params, thresholds and repeated keyterms', () => {
  const url = buildFluxUrl(config.stt);
  const u = new URL(url);
  assert.ok(url.includes('mip_opt_out=true'));
  assert.strictEqual(u.searchParams.get('model'), 'flux-general-en');
  assert.strictEqual(u.searchParams.get('encoding'), 'linear16');
  assert.strictEqual(u.searchParams.get('sample_rate'), '16000');
  assert.strictEqual(u.searchParams.get('eot_threshold'), String(config.stt.eotThreshold));
  assert.strictEqual(u.searchParams.get('eager_eot_threshold'), '0.5');
  assert.strictEqual(u.searchParams.get('eot_timeout_ms'), '4000');
  assert.deepStrictEqual(u.searchParams.getAll('keyterm'), config.stt.keyterms);
});

test('normalizeTurnInfo coerces string numerics', () => {
  const ev = normalizeTurnInfo({
    type: 'TurnInfo', event: 'EagerEndOfTurn', turn_index: '3', transcript: 'hello there',
    audio_window_start: '0.5', audio_window_end: '2.25', end_of_turn_confidence: '0.62',
  }, 'me');
  assert.deepStrictEqual(ev, {
    channel: 'me', event: 'EagerEndOfTurn', turnIndex: 3, transcript: 'hello there',
    audioStart: 0.5, audioEnd: 2.25, eotConfidence: 0.62,
  });
});

test('normalizeTurnInfo returns null for non-TurnInfo or unknown event', () => {
  assert.strictEqual(normalizeTurnInfo({ type: 'Connected', request_id: 'x' }, 'me'), null);
  assert.strictEqual(normalizeTurnInfo({ type: 'TurnInfo', event: 'Bogus' }, 'me'), null);
  assert.strictEqual(normalizeTurnInfo(null, 'me'), null);
});

test('FluxClient sends auth header, buffers before open, flushes on open, CloseStream on stop', () => {
  const c = mk();
  c.start();
  const ws = FakeWS.instances[0];
  assert.strictEqual(ws.opts.headers.Authorization, 'Token sekret-key');
  assert.ok(!ws.url.includes('sekret-key'));
  c.sendPcm(Buffer.from([1, 2]));
  c.sendPcm(new Uint8Array([3, 4]).buffer);
  assert.strictEqual(ws.sent.length, 0);
  ws.open();
  assert.strictEqual(ws.sent.length, 2);
  assert.ok(ws.sent.every(Buffer.isBuffer));
  c.forceEndTurn();
  assert.strictEqual(ws.sent.at(-1), '{"type":"ForceEndTurn"}');
  c.stop();
  assert.strictEqual(ws.sent.at(-1), '{"type":"CloseStream"}');
  assert.ok(ws.closed);
});

test('pre-open buffer keeps at most 2 s, dropping oldest', () => {
  const c = mk();
  c.start();
  const ws = FakeWS.instances[0];
  for (let i = 0; i < 40; i++) c.sendPcm(Buffer.alloc(2560, i)); // 40 x 80 ms = 3.2 s
  ws.open();
  assert.strictEqual(ws.sent.length, 25);
  assert.strictEqual(ws.sent[0][0], 15);
  assert.strictEqual(ws.sent.at(-1)[0], 39);
});

test('emits normalized events and never leaks the key in status', () => {
  const c = mk();
  const events = [];
  const statuses = [];
  c.on('event', (e) => events.push(e));
  c.on('status', (s) => statuses.push(s));
  c.start();
  const ws = FakeWS.instances[0];
  ws.open();
  ws.emit('message', json({ type: 'Connected', request_id: 'r1' }), false);
  ws.emit('message', json({ type: 'TurnInfo', event: 'Update', turn_index: 0, transcript: 'hi' }), false);
  ws.emit('message', json({ type: 'Warning', description: 'slow sekret-key' }), false);
  ws.emit('error', new Error('boom sekret-key'));
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].transcript, 'hi');
  assert.ok(statuses.length >= 4);
  assert.ok(!JSON.stringify(statuses).includes('sekret-key'));
  c.stop();
});

test('reconnects with exponential backoff after unexpected close, not after stop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = mk();
  c.start();
  FakeWS.instances[0].emit('close', 1006, Buffer.alloc(0));
  t.mock.timers.tick(499);
  assert.strictEqual(FakeWS.instances.length, 1);
  t.mock.timers.tick(1);
  assert.strictEqual(FakeWS.instances.length, 2);
  FakeWS.instances[1].emit('close', 1006, Buffer.alloc(0));
  t.mock.timers.tick(999);
  assert.strictEqual(FakeWS.instances.length, 2);
  t.mock.timers.tick(1);
  assert.strictEqual(FakeWS.instances.length, 3);
  c.stop();
  t.mock.timers.tick(10000);
  assert.strictEqual(FakeWS.instances.length, 3);
});
