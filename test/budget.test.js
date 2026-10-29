const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createBudgetGuard, estimateTokens, BUDGET_CODES: C } = require('../src/main/budget');
const { crcOf } = require('../src/main/budget/ledger');

const T0 = Date.parse('2026-10-14T12:00:00Z');
const DAY = 86400000;
const Q = 'Qwen/Qwen3-235B-A22B-Instruct-2507';
const Q30 = 'Qwen/Qwen3-30B-A3B-Instruct-2507';
const ULTRA = 'nvidia/Nemotron-3-Ultra-550b-a55b';
const REQ = { route: 'answer', model: Q, bucket: 'live_dev', inputTokens: 1000, maxOutputTokens: 220 };
const EST = ((1000 * 0.2 + 220 * 0.6) / 1e6) * 1.2;

const PRICES = {
  version: 'v-test',
  refreshed_at: '2026-10-14T00:00:00Z',
  max_age_days: 30,
  unit_tokens: 1000000,
  providers: {
    nebius: {
      models: {
        [Q]: { input: 0.2, output: 0.6 },
        [Q30]: { input: 0.1, output: 0.3 },
        [ULTRA]: { input: 1, output: 3 },
      },
    },
    gemini: { models: { 'gemini-3.5-flash': { input: 0, output: 0, free_tier: true } } },
  },
};
const CONFIG = {
  openingSpentUsd: 0,
  nebius: {
    totalBudgetUsd: 40, protectedReserveUsd: 8, hardStopUsd: 32, warnUsd: [16, 24, 28.8], safetyMultiplier: 1.2,
    dailyRequestLimit: 400, sessionRequestLimit: 150, buckets: { live_dev: 2, benchmark: 3, x: 1000, free: 1000 },
  },
  gemini: { totalBudgetUsd: 0, hardStopUsd: 0, safetyMultiplier: 1.2, dailyRequestLimit: 200, sessionRequestLimit: 60, buckets: { x: 0, free: 0 } },
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const hardCap = (usd) => ({ hardStopUsd: usd, totalBudgetUsd: usd, protectedReserveUsd: 0 });

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mk(o = {}) {
  const dir = o.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'));
  if (!o.dir) tmpDirs.push(dir);
  const provider = o.provider || 'nebius';
  const config = clone(CONFIG);
  if (o.opening !== undefined) config.openingSpentUsd = o.opening;
  Object.assign(config[provider], o.pcfg);
  const clock = o.clock || { t: T0 };
  const prices = o.prices || clone(PRICES);
  const guard = createBudgetGuard({
    provider, dataDir: dir, prices, config, sessionId: o.session || 'sess-1', now: () => clock.t,
    liveEnabled: o.live !== false,
  });
  const file = path.join(dir, `${provider}-ledger.jsonl`);
  const lines = () => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return { guard, dir, clock, file, lines, entries: () => lines().map((l) => JSON.parse(l)), prices, config };
}

test('happy path: admit then settle, cumulative and crc verified', async () => {
  const { guard, entries, lines } = mk();
  const a = await guard.admit(REQ);
  assert.equal(a.ok, true);
  assert.ok(a.reservationId);
  const s = await guard.settle(a.reservationId, { inputTokens: 900, outputTokens: 100, usageSource: 'provider', status: 'completed' });
  const final = (900 * 0.2 + 100 * 0.6) / 1e6;
  assert.ok(Math.abs(s.finalUsd - final) < 1e-12);
  assert.ok(Math.abs(s.cumulativeUsd - final) < 1e-12);
  const es = entries();
  assert.deepStrictEqual(es.map((e) => e.type), ['open', 'reserve', 'settle']);
  for (const l of lines()) {
    const { crc, ...rest } = JSON.parse(l);
    assert.equal(crc, crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16));
  }
  assert.equal(es[0].price_version, 'v-test');
  assert.equal(es[1].session, crypto.createHash('sha256').update('sess-1').digest('hex').slice(0, 12));
  assert.equal(es[2].usage_source, 'provider');
  assert.equal(es[2].id, a.reservationId);
  const st = guard.status();
  assert.ok(Math.abs(st.settledUsd - final) < 1e-12);
  assert.equal(st.openReservations.length, 0);
  assert.deepStrictEqual(st.tokens, { input: 900, output: 100, reasoning: 0 });
  assert.equal(st.requestsToday, 1);
  assert.equal(st.requestsSession, 1);
});

test('worst-case estimate uses maxOutputTokens and the 1.20 multiplier', async () => {
  const { guard } = mk();
  const a = await guard.admit({ route: 'r', model: Q30, bucket: 'x', inputTokens: 5000, maxOutputTokens: 1000 });
  assert.ok(Math.abs(a.estimatedUsd - ((5000 * 0.1 + 1000 * 0.3) / 1e6) * 1.2) < 1e-15);
  assert.ok(Math.abs(a.estimatedUsd - 0.00096) < 1e-12);
  const s = await guard.settle(a.reservationId, { inputTokens: 5000, outputTokens: 10, usageSource: 'provider', status: 'completed' });
  assert.ok(s.finalUsd < a.estimatedUsd / 1.2);
});

test('kill switch rejects before any other check', async () => {
  const { guard, entries } = mk({ live: false });
  const r = await guard.admit({ route: 'r', model: 'no-such-model', bucket: 'nope', inputTokens: -1, maxOutputTokens: NaN });
  assert.equal(r.code, C.KILL_SWITCH);
  assert.equal(guard.isLiveEnabled(), false);
  assert.equal(entries().at(-1).code, C.KILL_SWITCH);
  assert.equal(guard.status().rejected.byCode[C.KILL_SWITCH], 1);
  guard.setLiveEnabled(true);
  assert.equal((await guard.admit({ ...REQ, model: 'no-such-model' })).code, C.PRICE_UNKNOWN);
  assert.equal((await guard.admit(REQ)).ok, true);
  guard.setLiveEnabled(false);
  assert.equal((await guard.admit(REQ)).code, C.KILL_SWITCH);
});

test('unknown or invalid model price rejects PRICE_UNKNOWN', async () => {
  const prices = clone(PRICES);
  Object.assign(prices.providers.nebius.models, {
    neg: { input: -1, output: 1 }, nan: { input: 'x', output: 1 }, missing: { input: 1 },
  });
  const { guard, entries } = mk({ prices });
  for (const model of ['unknown/model', Q.toLowerCase(), ` ${Q}`, 'neg', 'nan', 'missing', '__proto__', 'constructor']) {
    assert.equal((await guard.admit({ ...REQ, model })).code, C.PRICE_UNKNOWN, model);
  }
  assert.equal(entries().filter((e) => e.type === 'reject').length, 8);
  assert.equal(entries().some((e) => e.type === 'reserve'), false);
});

test('stale registry rejects once now passes max_age_days', async () => {
  const { guard, clock } = mk();
  clock.t = T0 + 29 * DAY;
  assert.equal((await guard.admit(REQ)).ok, true);
  clock.t = T0 + 31 * DAY;
  const r = await guard.admit(REQ);
  assert.equal(r.code, C.PRICE_UNKNOWN);
  assert.match(r.message, /stale/);
});

test('silent price change under the same registry version rejects', async () => {
  const first = mk();
  assert.equal((await first.guard.admit(REQ)).ok, true);
  const changed = clone(PRICES);
  changed.providers.nebius.models[Q].input = 0.25;
  const second = mk({ dir: first.dir, prices: changed });
  const r = await second.guard.admit(REQ);
  assert.equal(r.code, C.PRICE_UNKNOWN);
  assert.match(r.message, /same registry version/);
  assert.equal((await second.guard.admit({ ...REQ, model: Q30 })).ok, true);
  changed.version = 'v-test-2';
  const third = mk({ dir: first.dir, prices: changed });
  assert.equal((await third.guard.admit(REQ)).ok, true);
});

test('zero price needs free_tier', async () => {
  const prices = clone(PRICES);
  prices.providers.nebius.models.zero = { input: 0, output: 0 };
  prices.providers.nebius.models.half = { input: 0, output: 1 };
  prices.providers.nebius.models.freebie = { input: 0, output: 0, free_tier: true };
  const { guard } = mk({ prices });
  assert.equal((await guard.admit({ ...REQ, model: 'zero' })).code, C.PRICE_UNKNOWN);
  assert.equal((await guard.admit({ ...REQ, model: 'half' })).code, C.PRICE_UNKNOWN);
  const ok = await guard.admit({ ...REQ, model: 'freebie' });
  assert.equal(ok.ok, true);
  assert.equal(ok.estimatedUsd, 0);

  const g = mk({ provider: 'gemini', opening: 31.9998 });
  const r = await g.guard.admit({ route: 'answer', model: 'gemini-3.5-flash', bucket: 'x', inputTokens: 500, maxOutputTokens: 200 });
  assert.equal(r.ok, true);
  assert.equal(g.guard.status().committedUsd, 0);
});

test('hard stop: committed never exceeds hardStopUsd', async () => {
  const { guard } = mk({ pcfg: hardCap(0.01) });
  let ok = 0;
  let codes = new Set();
  for (let i = 0; i < 40; i++) {
    const r = await guard.admit({ ...REQ, bucket: 'free' });
    if (r.ok) ok++; else codes.add(r.code);
    assert.ok(guard.status().committedUsd <= 0.01 + 1e-9);
  }
  assert.equal(ok, Math.floor(0.01 / EST));
  assert.deepStrictEqual([...codes], [C.HARD_STOP]);
});

test('protected reserve is enforced when hardStop is above total - reserve', async () => {
  const { guard } = mk({ pcfg: { totalBudgetUsd: 10, protectedReserveUsd: 4, hardStopUsd: 9 } });
  const big = { route: 'r', model: ULTRA, bucket: 'x', inputTokens: 1000000, maxOutputTokens: 0 };
  for (let i = 0; i < 5; i++) assert.equal((await guard.admit(big)).ok, true);
  const r = await guard.admit(big);
  assert.equal(r.code, C.RESERVE);
  assert.ok(Math.abs(guard.status().committedUsd - 6) < 1e-9);
  assert.equal(guard.status().remainingUsableUsd < 1.2, true);
});

test('50 parallel admits never exceed the cap and exactly N are admitted', async () => {
  const N = 10;
  const { guard, entries } = mk({ pcfg: hardCap((N + 0.5) * EST) });
  const results = await Promise.all(Array.from({ length: 50 }, () => guard.admit({ ...REQ, bucket: 'free' })));
  assert.equal(results.filter((r) => r.ok).length, N);
  assert.equal(results.filter((r) => !r.ok && r.code === C.HARD_STOP).length, 50 - N);
  assert.ok(guard.status().committedUsd <= (N + 0.5) * EST + 1e-9);
  assert.equal(entries().filter((e) => e.type === 'reserve').length, N);
  assert.equal(guard.status().corrupt, false);
});

const CHILD = `
const { createBudgetGuard } = require(process.env.BUDGET_MOD);
const a = JSON.parse(process.env.ARGS);
(async () => {
  const g = createBudgetGuard({ ...a, now: () => a.t, liveEnabled: true });
  let ok = 0;
  for (let i = 0; i < a.n; i++) {
    let r;
    for (let k = 0; k < 5; k++) { r = await g.admit(a.req); if (r.code !== 'BUDGET_GUARD_UNAVAILABLE') break; }
    if (r.ok) ok++;
  }
  console.log(JSON.stringify({ ok }));
})();`;

test('cross-process: two guard processes on one dataDir never exceed the cap', async () => {
  const N = 20;
  const { dir, config, entries, guard } = mk({ pcfg: hardCap((N + 0.5) * EST) });
  const run = (sessionId) => new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      BUDGET_MOD: path.resolve(__dirname, '../src/main/budget'),
      ARGS: JSON.stringify({ provider: 'nebius', dataDir: dir, prices: PRICES, config, sessionId, t: T0, n: 30, req: { ...REQ, bucket: 'free' } }),
    };
    execFile(process.execPath, ['-e', CHILD], { env }, (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(JSON.parse(out))));
  });
  const [a, b] = await Promise.all([run('child-a'), run('child-b')]);
  assert.equal(a.ok + b.ok, N);
  assert.equal(entries().filter((e) => e.type === 'reserve').length, N);
  const st = guard.status();
  assert.equal(st.corrupt, false);
  assert.ok(st.committedUsd <= (N + 0.5) * EST + 1e-9);
  assert.equal(fs.existsSync(path.join(dir, 'nebius.lock')), false);
});

test('fresh held lock gives GUARD_UNAVAILABLE in about 1s; stale lock is reclaimed', async () => {
  const { guard, dir } = mk();
  const lock = path.join(dir, 'nebius.lock');
  fs.writeFileSync(lock, 'other-process');
  const t0 = Date.now();
  const r = await guard.admit(REQ);
  const took = Date.now() - t0;
  assert.equal(r.code, C.GUARD_UNAVAILABLE);
  assert.ok(took >= 900 && took < 3000, `took ${took}ms`);
  assert.equal(fs.existsSync(lock), true);

  const past = new Date(Date.now() - 60000);
  fs.utimesSync(lock, past, past);
  assert.equal((await guard.admit(REQ)).ok, true);
  assert.equal(fs.existsSync(lock), false);
});

test('corrupt ledger makes every admit GUARD_UNAVAILABLE and is never repaired', async (t) => {
  const crcLine = (o) => JSON.stringify({ ...o, crc: crcOf(o) });
  const cases = {
    'tampered crc': [2, (l) => { l[1] = l[1].replace(/"crc":"[0-9a-f]{16}"/, '"crc":"0000000000000000"'); return l; }],
    'garbage line': [3, (l) => [...l, 'not json at all']],
    'unknown version': [3, (l) => [...l, crcLine({ v: 2, type: 'reserve', id: 'zz' })]],
    'truncated line': [2, (l) => { l[1] = l[1].slice(0, 40); return l; }],
    'blank line in the middle': [2, (l) => [l[0], '', l[1]]],
  };
  for (const [name, [badLine, mutate]] of Object.entries(cases)) {
    await t.test(name, async () => {
      const m = mk();
      assert.equal((await m.guard.admit(REQ)).ok, true);
      fs.writeFileSync(m.file, mutate(m.lines()).join('\n') + '\n');
      const before = fs.readFileSync(m.file, 'utf8');
      for (let i = 0; i < 3; i++) assert.equal((await m.guard.admit(REQ)).code, C.GUARD_UNAVAILABLE);
      const st = m.guard.status();
      assert.equal(st.corrupt, true);
      assert.equal(st.badLine, badLine);
      assert.equal(st.remainingUsableUsd, 0);
      assert.equal((await mk({ dir: m.dir }).guard.admit(REQ)).code, C.GUARD_UNAVAILABLE);
      assert.equal(fs.readFileSync(m.file, 'utf8'), before);
    });
  }
});

test('an unsettled reservation keeps counting in a new guard instance', async () => {
  const first = mk();
  const a = await first.guard.admit(REQ);
  assert.equal(a.ok, true);
  const second = mk({ dir: first.dir, pcfg: hardCap(EST * 1.5) });
  const st = second.guard.status();
  assert.equal(st.openReservations.length, 1);
  assert.equal(st.openReservations[0].id, a.reservationId);
  assert.ok(Math.abs(st.openReservedUsd - EST) < 1e-12);
  assert.ok(Math.abs(st.committedUsd - EST) < 1e-12);
  assert.equal((await second.guard.admit(REQ)).code, C.HARD_STOP);
});

test('bucket cap is enforced separately from the hard stop', async () => {
  const { guard } = mk({ pcfg: { buckets: { live_dev: 0.001, uncapped: 1000 } } });
  assert.equal((await guard.admit(REQ)).ok, true);
  assert.equal((await guard.admit(REQ)).ok, true);
  assert.equal((await guard.admit(REQ)).code, C.BUCKET_LIMIT);
  assert.equal((await guard.admit({ ...REQ, bucket: 'uncapped' })).ok, true);
  // Unknown buckets (including prototype keys) fail closed.
  assert.equal((await guard.admit({ ...REQ, bucket: 'constructor' })).code, C.BUCKET_LIMIT);
  assert.equal((await guard.admit({ ...REQ, bucket: 'never-configured' })).code, C.BUCKET_LIMIT);
  const st = guard.status();
  assert.equal(st.byBucket.live_dev.requests, 2);
  assert.ok(st.committedUsd < st.hardStopUsd);
});

test('daily limit rolls over at the UTC date; session limit is per session', async () => {
  const day = mk({ pcfg: { dailyRequestLimit: 2 }, clock: { t: Date.parse('2026-10-14T23:59:00Z') } });
  assert.equal((await day.guard.admit(REQ)).ok, true);
  assert.equal((await day.guard.admit(REQ)).ok, true);
  assert.equal((await day.guard.admit(REQ)).code, C.DAILY_LIMIT);
  assert.equal(day.guard.status().requestsToday, 2);
  day.clock.t = Date.parse('2026-10-15T00:00:30Z');
  assert.equal(day.guard.status().requestsToday, 0);
  assert.equal((await day.guard.admit(REQ)).ok, true);

  const s1 = mk({ pcfg: { sessionRequestLimit: 2 }, session: 's1' });
  await s1.guard.admit(REQ);
  await s1.guard.admit(REQ);
  assert.equal((await s1.guard.admit(REQ)).code, C.SESSION_LIMIT);
  const s2 = mk({ dir: s1.dir, pcfg: { sessionRequestLimit: 2 }, session: 's2' });
  assert.equal((await s2.guard.admit(REQ)).ok, true);
  assert.equal(s2.guard.status().requestsSession, 1);
  assert.equal(s2.guard.status().requestsToday, 3);
  assert.deepStrictEqual(Object.keys(s2.guard.status().bySession).sort(),
    ['s1', 's2'].map((s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)).sort());
});

test('opening balance counts for nebius only', async () => {
  const n = mk({ opening: 31.9998 });
  assert.ok(Math.abs(n.guard.status().committedUsd - 31.9998) < 1e-12);
  assert.equal((await n.guard.admit(REQ)).code, C.HARD_STOP);
  assert.equal(n.entries()[0].cum_usd, 31.9998);
  assert.equal(mk({ opening: 0 }).guard.status().committedUsd, 0);
  assert.equal((await mk({ opening: 31 }).guard.admit(REQ)).ok, true);

  const g = mk({ provider: 'gemini', opening: 31.9998 });
  assert.equal(g.guard.status().committedUsd, 0);
});

test('settle: twice or unknown id throws; aborted/failed fall back to estimates', async () => {
  const { guard, entries } = mk();
  const a = await guard.admit(REQ);
  await guard.settle(a.reservationId, { inputTokens: 10, outputTokens: 5, usageSource: 'provider', status: 'completed' });
  await assert.rejects(() => guard.settle(a.reservationId, { inputTokens: 10, outputTokens: 5, usageSource: 'provider', status: 'completed' }), /already settled/);
  await assert.rejects(() => guard.settle('nope', { status: 'failed', usageSource: 'estimate' }), /unknown reservation/);
  await assert.rejects(() => guard.settle(a.reservationId, { status: 'weird' }), TypeError);

  const b = await guard.admit(REQ);
  const s = await guard.settle(b.reservationId, { outputTokens: 10, usageSource: 'estimate', status: 'aborted' });
  assert.ok(Math.abs(s.finalUsd - (1000 * 0.2 + 10 * 0.6) / 1e6) < 1e-12);
  const last = entries().at(-1);
  assert.equal(last.usage_source, 'estimate');
  assert.equal(last.status, 'aborted');

  const c = await guard.admit(REQ);
  const done = await guard.settle(c.reservationId, { usageSource: 'estimate', status: 'completed', reasoningTokens: 0 });
  assert.ok(Math.abs(done.finalUsd - (1000 * 0.2 + 220 * 0.6) / 1e6) < 1e-12);
  const d = await guard.admit(REQ);
  const withReasoning = await guard.settle(d.reservationId, { inputTokens: 100, outputTokens: 50, reasoningTokens: 30, usageSource: 'provider', status: 'completed' });
  // completion_tokens (50) already include the 30 reasoning tokens; they are not billed twice.
  assert.ok(Math.abs(withReasoning.finalUsd - (100 * 0.2 + 50 * 0.6) / 1e6) < 1e-12);
  assert.equal(guard.status().tokens.reasoning, 30);
});

test('no message text or secret ever appears in the ledger file', async () => {
  const sentinel = 'SENTINEL-MESSAGE-TEXT-9f3a';
  const secret = 'sk-SENTINEL-KEY-77c1';
  const { guard, file } = mk({ session: secret });
  const messages = [{ role: 'system', content: `key=${secret}` }, { role: 'user', content: sentinel }];
  const a = await guard.admit({ ...REQ, inputTokens: estimateTokens(messages) });
  await guard.settle(a.reservationId, { inputTokens: 5, outputTokens: 5, usageSource: 'provider', status: 'completed' });
  await guard.admit({ ...REQ, model: `${sentinel} user said hello` });
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes('SENTINEL'), false);
  assert.equal(text.includes(crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12)), true);
  assert.equal(JSON.stringify(guard.status()).includes('SENTINEL'), false);
});

test('estimateTokens is conservative', () => {
  // max(chars / 2.5, utf8 bytes / 3) + 8 per message
  assert.equal(estimateTokens('a'.repeat(35)), 14 + 8);
  assert.equal(estimateTokens([{ content: 'a'.repeat(35) }, { content: 'abc' }]), 14 + 8 + 2 + 8);
  assert.equal(estimateTokens([{ content: [{ type: 'text', text: 'a'.repeat(7) }] }]), 3 + 8);
  assert.ok(estimateTokens('漢'.repeat(1000)) >= 1000, 'CJK is not under-counted');
  assert.equal(estimateTokens([]), 0);
});

test('status snapshot: shape, warn level, cache counters, rejected totals', async () => {
  const { guard } = mk({ opening: 24 });
  guard.recordCache(true);
  guard.recordCache(false);
  guard.recordCache(true);
  await guard.admit({ ...REQ, model: 'bad' });
  const st = guard.status();
  assert.equal(st.warnLevel, 75);
  assert.deepStrictEqual(st.cache, { hits: 2, misses: 1 });
  assert.deepStrictEqual(st.rejected, { total: 1, byCode: { [C.PRICE_UNKNOWN]: 1 } });
  assert.equal(st.hardStopUsd, 32);
  assert.equal(st.protectedReserveUsd, 8);
  assert.equal(st.priceVersion, 'v-test');
  assert.equal(st.priceRefreshedAt, '2026-10-14T00:00:00Z');
  assert.ok(Math.abs(st.remainingUsableUsd - 8) < 1e-9);
  assert.equal(st.note, 'Engineering control only; provider billing may differ.');
  assert.equal(mk({ opening: 0 }).guard.status().warnLevel, null);
  assert.equal(mk({ opening: 16 }).guard.status().warnLevel, 50);
  assert.equal(mk({ opening: 29 }).guard.status().warnLevel, 90);
});

test('invalid request or config fails closed', async () => {
  const { guard } = mk();
  assert.equal((await guard.admit({ ...REQ, inputTokens: -5 })).code, C.GUARD_UNAVAILABLE);
  assert.equal((await guard.admit({ ...REQ, maxOutputTokens: NaN })).code, C.GUARD_UNAVAILABLE);
  assert.equal((await mk({ pcfg: { hardStopUsd: undefined } }).guard.admit(REQ)).code, C.GUARD_UNAVAILABLE);
  assert.equal((await mk({ pcfg: { safetyMultiplier: 0.5 } }).guard.admit(REQ)).code, C.GUARD_UNAVAILABLE);
  assert.equal(guard.status().rejected.byCode[C.GUARD_UNAVAILABLE], 2);
  const noFlag = createBudgetGuard({ provider: 'nebius', dataDir: mk().dir, prices: PRICES, config: CONFIG, sessionId: 's' });
  assert.equal(noFlag.isLiveEnabled(), false);
  assert.throws(() => createBudgetGuard({ provider: 'nebius', dataDir: 'relative/dir', prices: PRICES, config: CONFIG, sessionId: 's' }), TypeError);
});

test('unknown output on failed/aborted settle is charged at the reserved worst case', async () => {
  const { guard } = mk();
  const a = await guard.admit(REQ);
  const s = await guard.settle(a.reservationId, { inputTokens: 1000, usageSource: 'estimate', status: 'failed' });
  assert.ok(Math.abs(s.finalUsd - (1000 * 0.2 + 220 * 0.6) / 1e6) < 1e-12);
});

test('sweeper closes reservations older than the TTL at their worst-case estimate', async () => {
  const clock = { t: T0 };
  const { guard, entries } = mk({ clock });
  const a = await guard.admit(REQ);
  assert.equal(guard.status().openReservations.length, 1);
  clock.t = T0 + 11 * 60000;
  await guard.admit(REQ); // any locked operation sweeps
  const swept = entries().find((e) => e.type === 'settle' && e.id === a.reservationId);
  assert.ok(swept, 'expired reservation settled');
  assert.equal(swept.status, 'failed');
  assert.ok(Math.abs(swept.final_usd - EST) < 1e-12);
  assert.equal(guard.status().openReservations.length, 1, 'only the new reservation is open');
  await assert.rejects(() => guard.settle(a.reservationId, { status: 'completed', usageSource: 'estimate' }), /already settled/);
});

test('status().blocked explains why the next call would be refused', async () => {
  const off = mk({ live: false });
  assert.equal(off.guard.status().blocked, C.KILL_SWITCH);
  const ok = mk();
  assert.equal(ok.guard.status().blocked, null);
  const stale = mk({ clock: { t: T0 + 40 * DAY } });
  assert.equal(stale.guard.status().blocked, C.PRICE_UNKNOWN);
  const full = mk({ opening: 32 });
  assert.equal(full.guard.status().blocked, C.HARD_STOP);
});

test('[re-review] blocked reports an exhausted app bucket and a nearly-empty budget; bad TTL is rejected', async () => {
  const b = mk({ pcfg: { buckets: { production_test: 0.0001, live_dev: 2 } } });
  assert.equal(b.guard.status().blocked, C.BUCKET_LIMIT);
  const near = mk({ opening: 31.995 });
  assert.equal(near.guard.status().blocked, C.HARD_STOP);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ttl-'));
  tmpDirs.push(dir);
  const config = { ...clone(CONFIG), reservationTtlMinutes: 0 };
  const g = createBudgetGuard({ provider: 'nebius', dataDir: dir, prices: clone(PRICES), config, sessionId: 's', now: () => T0, liveEnabled: true });
  assert.equal((await g.admit(REQ)).code, C.GUARD_UNAVAILABLE);
});
