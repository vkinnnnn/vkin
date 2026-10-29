class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0].length) return true;
    const out = new Float32Array(input[0].length);
    for (const ch of input) for (let i = 0; i < out.length; i++) out[i] += ch[i] / input.length;
    this.port.postMessage(out, [out.buffer]);
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
