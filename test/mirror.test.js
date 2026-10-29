const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { createMirror, reduce, sanitize } = require('../src/main/mirror');

const randPort = () => 30000 + Math.floor(Math.random() * 25000);
const portOf = (info) => new URL(info.url).port;

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

// Connects and collects messages; resolves once open.
function client(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${token}`);
    ws.msgs = [];
    ws.on('message', (d) => ws.msgs.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
  });
}

const until = async (fn, ms = 2000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function withMirror(fn) {
  const m = createMirror({ port: randPort() });
  const info = await m.start();
  try { await fn(m, info, portOf(info)); } finally { m.stop(); }
}

test('start returns url with token and data: QR', () => withMirror(async (m, info) => {
  assert.match(info.url, /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/\?t=/);
  assert.ok(info.url.includes(info.token));
  assert.match(info.qrDataUrl, /^data:image\/png;base64,/);
}));

test('GET: right token 200 html with headers; wrong/missing/other path 404 empty', () => withMirror(async (m, info, port) => {
  const ok = await get(port, `/?t=${info.token}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /html/);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal(ok.headers['referrer-policy'], 'no-referrer');
  assert.match(ok.headers['content-security-policy'], /script-src 'unsafe-inline'/);
  assert.match(ok.body, /<html/);
  for (const p of ['/?t=wrong', '/', `/?t=${info.token}x`, `/other?t=${info.token}`, '/ws']) {
    const r = await get(port, p);
    assert.equal(r.status, 404, p);
    assert.equal(r.body, '', p);
  }
}));

test('ws: wrong token rejected, right token receives broadcast answer events', () => withMirror(async (m, info, port) => {
  await assert.rejects(client(port, 'nope'), (e) => e.status === 401);
  const ws = await client(port, info.token);
  await until(() => ws.msgs.length === 1);
  assert.equal(ws.msgs[0].type, 'snapshot');
  m.broadcast({ type: 'answer:start', genId: 'g1', turnId: 't1', revision: 0, kind: 'confirmed', question: 'Q?' });
  m.broadcast({ type: 'answer:delta', genId: 'g1', text: 'SAY: hi' });
  await until(() => ws.msgs.length === 3);
  assert.deepEqual(ws.msgs.slice(1).map((x) => x.type), ['answer:start', 'answer:delta']);
  assert.equal(ws.msgs[2].text, 'SAY: hi');
  ws.close();
}));

test('non-allowlisted types and secret fields never reach the client', () => withMirror(async (m, info, port) => {
  const ws = await client(port, info.token);
  m.broadcast({ type: 'status', apiKey: 'SECRET', stt: {} });
  m.broadcast({ type: 'level', channel: 'me', level: 0.5 });
  m.broadcast({ type: 'answer:start', genId: 'g1', turnId: 't', revision: 1, kind: 'manual', question: 'q', apiKey: 'SECRET', config: { k: 'SECRET' } });
  m.broadcast({ type: 'answer:done', genId: 'g1', model: 'SECRET', timings: { totalMs: 5, secret: 'SECRET' } });
  await until(() => ws.msgs.some((x) => x.type === 'answer:done'));
  assert.deepEqual(ws.msgs.map((x) => x.type), ['snapshot', 'answer:start', 'answer:done']);
  assert.deepEqual(ws.msgs[2].timings, { totalMs: 5 });
  const late = await client(port, info.token);
  await until(() => late.msgs.length === 1);
  assert.ok(!JSON.stringify([ws.msgs, late.msgs]).includes('SECRET'));
  ws.close(); late.close();
}));

test('late joiner gets snapshot with accumulated text', () => withMirror(async (m, info, port) => {
  m.broadcast({ type: 'answer:start', genId: 'g1', turnId: 't1', revision: 0, kind: 'speculative', question: 'Q' });
  for (const text of ['SAY: a', 'b ', 'POINTS: - x']) m.broadcast({ type: 'answer:delta', genId: 'g1', text });
  m.broadcast({ type: 'answer:delta', genId: 'stale', text: 'ignored' });
  const ws = await client(port, info.token);
  await until(() => ws.msgs.length === 1);
  const s = ws.msgs[0];
  assert.equal(s.type, 'snapshot');
  assert.equal(s.current.text, 'SAY: ab POINTS: - x');
  assert.equal(s.current.kind, 'speculative');
  assert.equal(s.previous, null);
  ws.close();
}));

test('port in use falls back to next port', async () => {
  const p = randPort();
  const a = createMirror({ port: p });
  const b = createMirror({ port: p });
  try {
    const ia = await a.start();
    const ib = await b.start();
    assert.equal(Number(portOf(ia)), p);
    assert.equal(Number(portOf(ib)), p + 1);
  } finally { a.stop(); b.stop(); }
});

test('reduce: stale genId events ignored; matching ones apply', () => {
  let s = reduce(null, { type: 'answer:start', genId: 'g1', turnId: 't', revision: 0, kind: 'speculative', question: 'q' });
  s = reduce(s, { type: 'answer:delta', genId: 'g1', text: 'A' });
  const before = s;
  assert.equal(reduce(s, { type: 'answer:delta', genId: 'old', text: 'Z' }), before);
  assert.equal(reduce(s, { type: 'answer:invalidate', genId: 'old', reason: 'r' }), before);
  assert.equal(reduce(s, { type: 'answer:promote', genId: 'old' }), before);
  assert.equal(reduce(s, { type: 'answer:done', genId: 'old' }), before);
  assert.equal(reduce(s, { type: 'answer:error', genId: 'old', message: 'x' }), before);
  assert.equal(s.current.text, 'A');
  s = reduce(s, { type: 'answer:promote', genId: 'g1' });
  assert.equal(s.current.kind, 'confirmed');
  s = reduce(s, { type: 'answer:done', genId: 'g1', timings: { totalMs: 1 } });
  s = reduce(s, { type: 'answer:start', genId: 'g2', turnId: 't2', revision: 0, kind: 'confirmed', question: 'q2' });
  assert.equal(s.previous.genId, 'g1');
  assert.equal(s.current.text, '');
  s = reduce(s, { type: 'answer:invalidate', genId: 'g2', reason: 'r' });
  assert.equal(s.current, null);
  assert.equal(s.previous.genId, 'g1');
});

test('reduce: previous only kept when old card done, not speculative, no error', () => {
  const start = (id, kind) => ({ type: 'answer:start', genId: id, turnId: 't', revision: 0, kind, question: 'q' });
  let s = reduce(null, start('a', 'speculative'));
  s = reduce(s, { type: 'answer:done', genId: 'a' });
  s = reduce(s, start('b', 'confirmed')); // old was speculative -> not previous
  assert.equal(s.previous, null);
  s = reduce(s, start('c', 'confirmed')); // old not done -> not previous
  assert.equal(s.previous, null);
  s = reduce(s, { type: 'answer:error', genId: 'c', message: 'm' });
  s = reduce(s, { type: 'answer:done', genId: 'c' });
  s = reduce(s, start('d', 'confirmed')); // old had error -> not previous
  assert.equal(s.previous, null);
});

// ---- answer:validated / answer:replace -------------------------------------------------------
const mstart = (id, extra = {}) => ({ type: 'answer:start', genId: id, turnId: 't', revision: 0, kind: 'confirmed', question: `q${id}`, ...extra });
const mdone = (id) => ({ type: 'answer:done', genId: id, timings: { totalMs: 1 } });

test('reduce: validated checked sets current.validation; stale validated ignored', () => {
  let s = reduce(null, mstart('g1'));
  s = reduce(s, { type: 'answer:validated', genId: 'g1', ok: true, action: 'checked', unsupported: [], warnings: 1, confidence: 0.8 });
  assert.deepEqual(s.current.validation, { ok: true, action: 'checked', unsupported: [], warnings: 1, confidence: 0.8 });
  const before = s;
  assert.equal(reduce(s, { type: 'answer:validated', genId: 'old', ok: true, action: 'checked' }), before);
  s = reduce(s, mdone('g1'));
  s = reduce(s, mstart('g2'));
  assert.equal(s.previous.validation.action, 'checked');
});

test('reduce: regenerating then start with revisionOf never produces previous for the rejected draft', () => {
  let s = reduce(null, mstart('g1'));
  s = reduce(s, mdone('g1'));
  s = reduce(s, mstart('g2'));
  s = reduce(s, { type: 'answer:delta', genId: 'g2', text: 'SAY: bad' });
  s = reduce(s, { type: 'answer:validated', genId: 'g2', ok: false, action: 'regenerating' });
  assert.equal(s.current.validation.action, 'regenerating');
  s = reduce(s, mdone('g2')); // must not mark the rejected draft done
  assert.equal(s.current.done, undefined);
  s = reduce(s, mstart('g3', { revisionOf: 'g2' }));
  assert.equal(s.current.genId, 'g3');
  assert.equal(s.current.text, '');
  assert.equal(s.previous.genId, 'g1');
  // even if the rejected draft were done it must not become previous
  const s2 = reduce({ current: { genId: 'x', text: '', done: true, kind: 'confirmed' }, previous: null }, mstart('y', { revisionOf: 'x' }));
  assert.equal(s2.previous, null);
});

test('reduce: replace updates current and previous; unknown genId ignored', () => {
  let s = reduce(null, mstart('g1'));
  s = reduce(s, { type: 'answer:delta', genId: 'g1', text: 'old1' });
  s = reduce(s, mdone('g1'));
  s = reduce(s, mstart('g2'));
  s = reduce(s, { type: 'answer:delta', genId: 'g2', text: 'old2' });
  s = reduce(s, { type: 'answer:replace', genId: 'g2', text: 'new2' });
  s = reduce(s, { type: 'answer:replace', genId: 'g1', text: 'new1' });
  assert.equal(s.current.text, 'new2');
  assert.equal(s.previous.text, 'new1');
  const before = s;
  assert.equal(reduce(s, { type: 'answer:replace', genId: 'nope', text: 'z' }), before);
  assert.equal(reduce(s, { type: 'answer:replace', genId: 'g2' }), before);
  s = reduce(s, { type: 'answer:delta', genId: 'g2', text: '+' });
  assert.equal(s.current.text, 'new2+');
});

test('sanitize keeps new fields, trims nested unsupported and truncates long claims', () => {
  const out = sanitize({
    type: 'answer:validated', genId: 'g1', ok: false, action: 'trimmed', warnings: 2, confidence: 0.5, revisionOf: 'g0', text: 'SAY: t',
    secret: 'S', unsupported: [{ claim: 'c'.repeat(300), kind: 'metric', reason: 'r'.repeat(300), extra: 'S', nested: { a: 1 } }, 'junk', null, { claim: 5 }],
  });
  assert.equal(out.ok, false);
  assert.equal(out.action, 'trimmed');
  assert.equal(out.warnings, 2);
  assert.equal(out.confidence, 0.5);
  assert.equal(out.revisionOf, 'g0');
  assert.equal(out.text, 'SAY: t');
  assert.equal(out.secret, undefined);
  assert.deepEqual(Object.keys(out.unsupported[0]).sort(), ['claim', 'kind', 'reason']);
  assert.equal(out.unsupported[0].claim.length, 120);
  assert.equal(out.unsupported[0].reason.length, 120);
  assert.equal(out.unsupported[0].kind, 'metric');
  assert.deepEqual(out.unsupported[1], {}); // { claim: 5 }: non-string dropped
  assert.equal(out.unsupported.length, 2);
  assert.ok(!JSON.stringify(out).includes('"S"'));
});

test('late joiner snapshot reflects replaced text and validation; secrets never leak', () => withMirror(async (m, info, port) => {
  m.broadcast(mstart('g1'));
  m.broadcast({ type: 'answer:delta', genId: 'g1', text: 'SAY: a. Fake claim.' });
  m.broadcast({ type: 'answer:replace', genId: 'g1', text: 'SAY: a.', apiKey: 'SECRET' });
  m.broadcast({ type: 'answer:validated', genId: 'g1', ok: true, action: 'trimmed', warnings: 0, confidence: 0.7, unsupported: [{ claim: 'Fake claim', kind: 'x', reason: 'y', token: 'SECRET' }] });
  const ws = await client(port, info.token);
  await until(() => ws.msgs.length === 1);
  const s = ws.msgs[0];
  assert.equal(s.current.text, 'SAY: a.');
  assert.equal(s.current.validation.action, 'trimmed');
  assert.deepEqual(s.current.validation.unsupported, [{ claim: 'Fake claim', kind: 'x', reason: 'y' }]);
  assert.ok(!JSON.stringify(s).includes('SECRET'));
  ws.close();
}));
