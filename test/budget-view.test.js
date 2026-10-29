const test = require('node:test');
const assert = require('node:assert/strict');
const BV = require('../src/renderer/budget-view.js');

test('usd: 4 decimals, negatives, and missing input', () => {
  assert.equal(BV.usd(1.5), '$1.5000');
  assert.equal(BV.usd(0), '$0.0000');
  assert.equal(BV.usd(0.00004), '$0.0000');
  assert.equal(BV.usd(-2.5), '-$2.5000');
  assert.equal(BV.usd(32, 2), '$32.00');
  for (const bad of [null, undefined, NaN, Infinity, 'x', {}]) assert.equal(BV.usd(bad), '–');
});

test('pct: ratio, clamping, zero/invalid cap', () => {
  assert.equal(BV.pct(8, 32), 25);
  assert.equal(BV.pct(1, 3), 33.3);
  assert.equal(BV.pct(40, 32), 100);
  assert.equal(BV.pct(-5, 32), 0);
  assert.equal(BV.pct(5, 0), 0);
  assert.equal(BV.pct(5, -1), 0);
  assert.equal(BV.pct(0, 0), 0);
  assert.equal(BV.pct(null, 32), 0);
  assert.equal(BV.pct(5, undefined), 0);
  assert.equal(BV.pct(NaN, 32), 0);
});

test('warnBanner: 50/75/90 map to tones, everything else is null', () => {
  assert.equal(BV.warnBanner(50).tone, 'info');
  assert.equal(BV.warnBanner(75).tone, 'warn');
  assert.equal(BV.warnBanner(90).tone, 'err');
  assert.match(BV.warnBanner(75).text, /75%/);
  for (const bad of [null, undefined, 0, 60, '', 'x']) assert.equal(BV.warnBanner(bad), null);
  assert.equal(BV.warnBanner('90').level, 90);
});

test('rows: numbers and {usd,count} objects, sorted by usd desc', () => {
  assert.deepEqual(BV.rows({ a: 0.5, b: 2, c: 1 }).map((r) => r.key), ['b', 'c', 'a']);
  assert.deepEqual(BV.rows({ a: { usd: 1, count: 3 }, b: 2 }), [
    { key: 'b', usd: 2, count: null },
    { key: 'a', usd: 1, count: 3 },
  ]);
  assert.deepEqual(BV.rows({ a: { usd: 1 } }), [{ key: 'a', usd: 1, count: null }]);
  assert.deepEqual(BV.rows({ a: null, b: 'x', c: {} }).map((r) => r.usd), [0, 0, 0]);
  assert.deepEqual(BV.rows({ b: 1, a: 1 }).map((r) => r.key), ['a', 'b']); // stable tie-break
  for (const bad of [null, undefined, [], 5, 'x']) assert.deepEqual(BV.rows(bad), []);
});

test('cacheRate: percentage, zero calls, missing input', () => {
  assert.equal(BV.cacheRate({ hits: 3, misses: 1 }), '75%');
  assert.equal(BV.cacheRate({ hits: 0, misses: 4 }), '0%');
  assert.equal(BV.cacheRate({ hits: 4, misses: 0 }), '100%');
  assert.equal(BV.cacheRate({ hits: 0, misses: 0 }), 'n/a');
  assert.equal(BV.cacheRate({}), 'n/a');
  assert.equal(BV.cacheRate(null), 'n/a');
  assert.equal(BV.cacheRate(undefined), 'n/a');
});

test('isStale: 30-day boundary, ISO and epoch input, unknown', () => {
  const DAY = 86400000, now = Date.parse('2026-10-14T00:00:00Z');
  assert.equal(BV.isStale(now - 30 * DAY, now), false); // exactly 30 days is still fresh
  assert.equal(BV.isStale(now - 30 * DAY - 1, now), true);
  assert.equal(BV.isStale(now - DAY, now), false);
  assert.equal(BV.isStale('2026-09-14T00:00:00Z', now), false);
  assert.equal(BV.isStale('2026-09-13T23:59:59Z', now), true);
  assert.equal(BV.isStale(now - 8 * DAY, now, 7), true); // custom window
  assert.equal(BV.isStale(now + DAY, now), false); // future date
  for (const bad of [null, undefined, '', 'not a date', NaN]) assert.equal(BV.isStale(bad, now), true);
});

test('shortModel: strips the org prefix, tolerates empties', () => {
  assert.equal(BV.shortModel('meta-llama/Llama-3.3-70B-Instruct'), 'Llama-3.3-70B-Instruct');
  assert.equal(BV.shortModel('a/b/c'), 'c');
  assert.equal(BV.shortModel('gemini-2.5-flash'), 'gemini-2.5-flash');
  for (const bad of [null, undefined, '']) assert.equal(BV.shortModel(bad), '');
});

test('shortId and dateOnly: display helpers', () => {
  assert.equal(BV.shortId('abcdef1234567890'), 'abcdef12…');
  assert.equal(BV.shortId('abc'), 'abc');
  assert.equal(BV.shortId(null), '');
  assert.equal(BV.dateOnly('2026-10-14T12:00:00Z'), '2026-10-14');
  assert.equal(BV.dateOnly(Date.parse('2026-01-02T00:00:00Z')), '2026-01-02');
  assert.equal(BV.dateOnly(null), '');
  assert.equal(BV.dateOnly('nope'), '');
});
