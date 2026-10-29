// @ts-check
// Pure PCM helpers. Works in Node (module.exports) and the browser (globalThis.PCM).
(function () {
  const TARGET = 16000;

  // Stateful box-filter resampler: carries leftover samples/phase across blocks.
  class Downsampler {
    constructor(inRate, outRate = TARGET) {
      this.ratio = inRate / outRate;
      this.carry = new Float32Array(0);
      this.pos = 0;
    }

    process(x) {
      const r = this.ratio;
      if (r === 1) return Float32Array.from(x);
      const buf = new Float32Array(this.carry.length + x.length);
      buf.set(this.carry);
      buf.set(x, this.carry.length);
      const out = [];
      let pos = this.pos;
      while (pos + r <= buf.length + 1e-9) {
        const end = pos + r;
        let sum = 0;
        for (let i = Math.floor(pos); i < Math.min(Math.ceil(end), buf.length); i++) {
          sum += buf[i] * (Math.min(i + 1, end) - Math.max(i, pos));
        }
        out.push(sum / r);
        pos = end;
      }
      const drop = Math.min(Math.floor(pos), buf.length);
      this.carry = buf.slice(drop);
      this.pos = pos - drop;
      return Float32Array.from(out);
    }
  }

  function downsampleTo16k(float32, inRate) {
    return new Downsampler(inRate).process(float32);
  }

  function floatToInt16(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = Math.round(s < 0 ? s * 32768 : s * 32767);
    }
    return out;
  }

  function rms(float32) {
    if (!float32.length) return 0;
    let sum = 0;
    for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
    return Math.sqrt(sum / float32.length);
  }

  class FrameAssembler {
    constructor(frameSamples = 1280) {
      this.n = frameSamples;
      this.buf = new Int16Array(0);
    }

    push(int16) {
      const all = new Int16Array(this.buf.length + int16.length);
      all.set(this.buf);
      all.set(int16, this.buf.length);
      const frames = [];
      let off = 0;
      for (; off + this.n <= all.length; off += this.n) frames.push(all.slice(off, off + this.n));
      this.buf = all.slice(off);
      return frames;
    }
  }

  const api = { downsampleTo16k, Downsampler, floatToInt16, rms, FrameAssembler };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.PCM = api;
})();
