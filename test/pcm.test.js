const test = require('node:test');
const assert = require('node:assert');
const { downsampleTo16k, Downsampler, floatToInt16, rms, FrameAssembler } = require('../src/shared/pcm');

const sine = (n, rate, hz) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));

test('48k -> 16k gives ~1/3 length and keeps RMS of a 1 kHz sine', () => {
  const x = sine(48000, 48000, 1000);
  const y = downsampleTo16k(x, 48000);
  assert.ok(Math.abs(y.length - 16000) <= 2);
  assert.ok(Math.abs(rms(y) - rms(x)) / rms(x) < 0.1);
});

test('chunked downsampling matches one-shot length (44.1k, 128-sample blocks)', () => {
  const x = sine(44100, 44100, 440);
  const ds = new Downsampler(44100);
  let n = 0;
  for (let i = 0; i < x.length; i += 128) n += ds.process(x.subarray(i, i + 128)).length;
  assert.ok(Math.abs(n - 16000) <= 2, `got ${n}`);
});

test('16k input passes through unchanged', () => {
  const x = Float32Array.from([0.1, -0.2, 0.3]);
  assert.deepStrictEqual(Array.from(downsampleTo16k(x, 16000)), Array.from(x));
});

test('floatToInt16 clamps and scales', () => {
  const y = floatToInt16(Float32Array.from([1.5, -1.5, -1, 1, 0]));
  assert.deepStrictEqual(Array.from(y), [32767, -32768, -32768, 32767, 0]);
});

test('FrameAssembler emits whole frames across uneven pushes', () => {
  const a = new FrameAssembler(1280);
  assert.strictEqual(a.push(new Int16Array(1000)).length, 0);
  const f = a.push(new Int16Array(1700).fill(7));
  assert.strictEqual(f.length, 2);
  assert.ok(f.every((x) => x.length === 1280 && x.buffer.byteLength === 2560));
  assert.strictEqual(f[0][1279], 7);
  assert.strictEqual(f[0][999], 0);
  assert.strictEqual(f[1][0], 7);
  assert.strictEqual(a.push(new Int16Array(1140)).length, 1);
});
