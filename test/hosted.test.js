'use strict';
// Hosted mode (docs/vkin-hosted-api.md): the desktop carries only the user's token and the session lease;
// provider keys are never read; server refusals stop the session and are never retried. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('node:events');
const { createHosted, checkApiUrl, hostedCodeOf } = require('../src/main/hosted');
const { createGateway } = require('../src/main/llm-gateway');
const { FluxClient } = require('../src/main/stt');
const { neutralConfig } = require('../scripts/make-defaults');

const ROOT = path.join(__dirname, '..');
const baseConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const API = 'https://api.vkin.test';
const TOKEN = 'user-jwt-abc';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const key = `${init.method} ${url.replace(API, '')}`;
    const r = typeof routes[key] === 'function' ? routes[key]() : routes[key];
    if (!r) throw new Error('offline');
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

function timers() {
  const t = { fns: [], set: (fn) => { t.fns.push(fn); return { unref() {} }; }, clear: () => { t.fns = []; } };
  return t;
}

const hostedWith = (routes, extra = {}) => {
  const fetchImpl = fakeFetch(routes);
  const tm = timers();
  const ended = [];
  const h = createHosted({ config: { hosted: { enabled: true } }, env: { VKIN_API_URL: API }, getToken: async () => TOKEN, fetchImpl, setTimer: tm.set, clearTimer: tm.clear, onEnded: (r) => ended.push(r), ...extra });
  return { h, fetchImpl, tm, ended };
};

test('hosted: off without an API URL; the URL must be https (http only for localhost)', () => {
  assert.equal(createHosted({ config: {}, env: {}, getToken: async () => TOKEN }).enabled, false);
  assert.equal(createHosted({ config: { hosted: { enabled: false } }, env: { VKIN_API_URL: API }, getToken: async () => TOKEN }).enabled, false);
  assert.throws(() => checkApiUrl('http://api.vkin.test'), /https/);
  assert.equal(checkApiUrl('http://localhost:8080/'), 'http://localhost:8080');
  assert.throws(() => checkApiUrl('https://api.vkin.test/?token=x'), /plain/);
});

test('hosted: start sends the token in a header, beats on a timer, stop closes the lease', async () => {
  const { h, fetchImpl, tm } = hostedWith({
    'POST /v1/sessions/start': { status: 201, body: { leaseId: 'L1', remainingSeconds: 600, beatEverySec: 15 } },
    'POST /v1/sessions/L1/beat': { status: 200, body: { remainingSeconds: 585, status: 'active' } },
    'POST /v1/sessions/L1/stop': { status: 200, body: { remainingSeconds: 580 } },
  });
  const s = await h.start('Windows desktop');
  assert.equal(s.leaseId, 'L1');
  const first = fetchImpl.calls[0];
  assert.equal(first.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!first.url.includes(TOKEN), 'token never in the URL');
  assert.equal(tm.fns.length, 1);
  await tm.fns[0]();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.state().remainingSeconds, 585);
  await h.stop();
  assert.equal(h.hasLease(), false);
  assert.equal(tm.fns.length, 0, 'beat timer cleared');
  assert.match(fetchImpl.calls.at(-1).url, /\/v1\/sessions\/L1\/stop$/);
});

test('hosted: the server refuses start with no minutes or another live device -> friendly errors, no lease', async () => {
  const a = hostedWith({ 'POST /v1/sessions/start': { status: 402, body: { error: 'no_minutes' } } });
  await assert.rejects(a.h.start(), (e) => e.code === 'HOSTED_NO_MINUTES' && /minutes are used up/.test(e.message));
  assert.equal(a.h.hasLease(), false);
  const b = hostedWith({ 'POST /v1/sessions/start': { status: 409, body: { error: 'lease_active' } } });
  await assert.rejects(b.h.start(), (e) => e.code === 'HOSTED_LEASE_ACTIVE');
  const c = createHosted({ config: {}, env: { VKIN_API_URL: API }, getToken: async () => null, fetchImpl: fakeFetch({}) });
  await assert.rejects(c.start(), (e) => e.code === 'HOSTED_UNAUTHORIZED');
});

test('hosted: a beat that finds no minutes ends the session; a network blip does not', async () => {
  let mode = 'offline';
  const { h, tm, ended } = hostedWith({
    'POST /v1/sessions/start': { status: 201, body: { leaseId: 'L2', remainingSeconds: 20 } },
    'POST /v1/sessions/L2/beat': () => (mode === 'offline' ? null : { status: 402, body: { error: 'no_minutes' } }),
  });
  await h.start();
  await tm.fns[0]();
  assert.equal(h.hasLease(), true, 'offline beat keeps the lease (server sweeps on its own)');
  mode = 'exhausted';
  await tm.fns[0]();
  assert.equal(h.hasLease(), false);
  assert.deepEqual(ended, ['no_minutes']);
});

test('hosted: a passing server error on beat (5xx) keeps the session; a refusal ends it', async () => {
  let reply = { status: 503, body: { error: 'auth_unavailable' } };
  const { h, tm, ended } = hostedWith({
    'POST /v1/sessions/start': { status: 201, body: { leaseId: 'L4', remainingSeconds: 300 } },
    'POST /v1/sessions/L4/beat': () => reply,
  });
  await h.start();
  await tm.fns[0]();
  assert.equal(h.hasLease(), true);
  reply = { status: 409, body: { error: 'lease_inactive' } };
  await tm.fns[0]();
  assert.equal(h.hasLease(), false);
  assert.deepEqual(ended, ['lease_inactive']);
});

test('hosted: endpoint and speech target need a lease; token goes in headers only', async () => {
  const { h } = hostedWith({ 'POST /v1/sessions/start': { status: 201, body: { leaseId: 'L3', remainingSeconds: 600 } } });
  await assert.rejects(h.endpoint(), (e) => e.code === 'HOSTED_NO_SESSION');
  await h.start();
  assert.deepEqual(await h.endpoint(), { baseURL: `${API}/v1`, apiKey: TOKEN, headers: { 'X-Vkin-Lease': 'L3' } });
  const t = await h.sttTarget('me');
  assert.equal(t.url, 'wss://api.vkin.test/v1/stt');
  assert.deepEqual(t.params, { lease: 'L3', channel: 'me' });
  assert.equal(t.headers.Authorization, `Bearer ${TOKEN}`);
});

test('hosted: server error bodies map to hosted codes', () => {
  assert.equal(hostedCodeOf({ status: 503, error: { error: 'capacity', message: 'x' } }), 'capacity');
  assert.equal(hostedCodeOf({ status: 402, error: {} }), 'no_minutes');
  assert.equal(hostedCodeOf({ status: 500, error: { error: 'boom' } }), null);
  // mid-stream SSE error event from the server: { error: { code, message } }
  assert.equal(hostedCodeOf({ status: undefined, error: { code: 'lease_inactive', message: 'The session ended.' } }), 'lease_inactive');
  assert.equal(hostedCodeOf({ status: 429, error: { error: 'user_cap' } }), 'user_cap');
});

function gatewayCfg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vkin-hosted-gw-'));
  return { ...baseConfig, budget: { ...baseConfig.budget, dataDir: dir, pricesFile: path.join(ROOT, 'src/main/budget/prices.json') } };
}
const msgs = [{ role: 'user', content: 'What is RAG?' }];

test('hosted gateway: calls go to the Vkin server with the user token and lease; no provider key needed', async () => {
  const seen = [];
  const factory = (baseURL, apiKey, headers) => ({
    chat: { completions: { create: async (body) => {
      seen.push({ baseURL, apiKey, headers, model: body.model });
      return (async function* () { yield { choices: [{ delta: { content: 'SAY: hello' } }] }; })();
    } } },
  });
  const hosted = { enabled: true, apiUrl: API, endpoint: async () => ({ baseURL: `${API}/v1`, apiKey: TOKEN, headers: { 'X-Vkin-Lease': 'L9' } }) };
  const g = createGateway({ config: gatewayCfg(), root: ROOT, env: {}, sessionId: 's', clientFactory: factory, hosted });
  assert.equal(g.mode, 'hosted');
  assert.equal(g.llm.info().liveEnabled, true, 'hosted starts live: Start already opened a metered session');
  const res = await g.llm.stream({ messages: msgs, signal: new AbortController().signal });
  assert.match(res.text, /hello/);
  assert.deepEqual(seen, [{ baseURL: `${API}/v1`, apiKey: TOKEN, headers: { 'X-Vkin-Lease': 'L9' }, model: 'nvidia/Nemotron-3_5-Lightning' }]);
});

test('hosted gateway: "Deeper answer" routes to Nemotron Ultra', async () => {
  const models = [];
  const factory = () => ({ chat: { completions: { create: async (body) => {
    models.push(body.model);
    return (async function* () { yield { choices: [{ delta: { content: 'ok' } }] }; })();
  } } } });
  const hosted = { enabled: true, apiUrl: API, endpoint: async () => ({ baseURL: `${API}/v1`, apiKey: TOKEN, headers: {} }) };
  const g = createGateway({ config: gatewayCfg(), root: ROOT, env: {}, sessionId: 's', clientFactory: factory, hosted });
  await g.llm.stream({ messages: msgs, route: 'deep', signal: new AbortController().signal });
  assert.deepEqual(models, ['nvidia/Nemotron-3-Ultra-550b-a55b']);
});

test('hosted gateway: a server refusal is final (one call, no retry, no Gemini fallback)', async () => {
  let n = 0;
  const factory = () => ({ chat: { completions: { create: async () => {
    n += 1;
    throw Object.assign(new Error('503'), { status: 503, error: { error: 'capacity', message: 'full' } });
  } } } });
  const hosted = { enabled: true, apiUrl: API, endpoint: async () => ({ baseURL: `${API}/v1`, apiKey: TOKEN, headers: {} }) };
  const g = createGateway({ config: gatewayCfg(), root: ROOT, env: {}, sessionId: 's', clientFactory: factory, hosted });
  await assert.rejects(g.llm.stream({ messages: msgs, signal: new AbortController().signal }), (e) => e.code === 'HOSTED_CAPACITY' && /capacity/.test(e.message));
  assert.equal(n, 1);
});

test('hosted gateway: without a session the call is refused before any request', async () => {
  let n = 0;
  const factory = () => ({ chat: { completions: { create: async () => { n += 1; } } } });
  const h = createHosted({ config: {}, env: { VKIN_API_URL: API }, getToken: async () => TOKEN, fetchImpl: fakeFetch({}) });
  const g = createGateway({ config: gatewayCfg(), root: ROOT, env: {}, sessionId: 's', clientFactory: factory, hosted: h });
  await assert.rejects(g.llm.stream({ messages: msgs, signal: new AbortController().signal }), (e) => e.code === 'HOSTED_NO_SESSION');
  assert.equal(n, 0);
});

class FakeWS extends EventEmitter {
  constructor(url, opts) { super(); FakeWS.made.push({ url, opts, ws: this }); this.readyState = 0; }
  send() {}
  close() {}
}
FakeWS.made = [];

test('hosted speech: relay URL carries lease and channel, token only in the header; refusal close stops reconnects', async () => {
  FakeWS.made = [];
  const stt = { url: 'wss://api.deepgram.com/v2/listen', model: 'flux-general-en', keyterms: ['Nemotron'] };
  const target = async () => ({ url: 'wss://api.vkin.test/v1/stt', params: { lease: 'L5', channel: 'them' }, headers: { Authorization: `Bearer ${TOKEN}` } });
  const c = new FluxClient({ channel: 'them', stt, target, WebSocketImpl: FakeWS });
  const fatal = [];
  c.on('fatal', (f) => fatal.push(f));
  c.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(FakeWS.made.length, 1);
  const { url, opts, ws } = FakeWS.made[0];
  assert.ok(url.startsWith('wss://api.vkin.test/v1/stt?'));
  assert.match(url, /lease=L5/);
  assert.match(url, /channel=them/);
  assert.match(url, /keyterm=Nemotron/);
  assert.ok(!url.includes(TOKEN));
  assert.equal(opts.headers.Authorization, `Bearer ${TOKEN}`);
  ws.emit('close', 4402, Buffer.from('no minutes'));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(fatal, [{ channel: 'them', code: 'no_minutes' }]);
  assert.equal(FakeWS.made.length, 1, 'no reconnect after a refusal');
  assert.equal(c.running, false);
});

test('installer defaults: hosted on, public endpoints only, personal profile blank', () => {
  const c = neutralConfig(baseConfig, { apiUrl: API, supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon' });
  assert.deepEqual(c.hosted, { enabled: true, apiUrl: API });
  assert.equal(c.vkin.supabaseUrl, 'https://x.supabase.co');
  assert.equal(c.profile.displayName, '');
  assert.deepEqual(c.profile.restrictedClaims, []);
});
