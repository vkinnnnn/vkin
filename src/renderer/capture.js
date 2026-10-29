(function () {
  const { Downsampler, floatToInt16, rms, FrameAssembler } = globalThis.PCM;
  const api = window.copilot.capture;
  const CHANNELS = ['them', 'me'];
  const active = new Map(); // channel -> entry

  const status = (channel, state, sampleRate, error) =>
    api.sendStatus({ channel, state, sampleRate, error: error ? String(error.message || error) : undefined });

  async function openStream(channel) {
    if (channel === 'them') {
      const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      s.getVideoTracks().forEach((t) => { t.stop(); s.removeTrack(t); });
      if (!s.getAudioTracks().length) throw new Error('no loopback audio track');
      return s;
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }

  function release(e) {
    try { e.node && (e.node.port.onmessage = null, e.node.disconnect()); } catch {}
    try { e.mute && e.mute.disconnect(); } catch {}
    try { e.src && e.src.disconnect(); } catch {}
    if (e.stream) e.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    if (e.ctx && e.ctx.state !== 'closed') e.ctx.close().catch(() => {});
  }

  async function start(channel) {
    if (active.has(channel)) return;
    const e = { channel, cancelled: false };
    active.set(channel, e);
    status(channel, 'starting');
    try {
      e.stream = await openStream(channel);
      if (e.cancelled) return release(e);
      const track = e.stream.getAudioTracks()[0];
      const rate = track.getSettings().sampleRate;
      e.ctx = rate ? new AudioContext({ sampleRate: rate }) : new AudioContext();
      await e.ctx.audioWorklet.addModule('worklet.js');
      if (e.cancelled) return release(e);
      if (e.ctx.state === 'suspended') await e.ctx.resume();

      const ds = new Downsampler(e.ctx.sampleRate);
      const asm = new FrameAssembler(1280);
      let sumSq = 0;
      let count = 0;
      e.src = e.ctx.createMediaStreamSource(new MediaStream([track]));
      e.node = new AudioWorkletNode(e.ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      e.node.port.onmessage = (ev) => {
        const f = ds.process(ev.data);
        const r = rms(f);
        sumSq += r * r * f.length;
        count += f.length;
        for (const frame of asm.push(floatToInt16(f))) {
          const level = Math.min(1, Math.sqrt(sumSq / Math.max(count, 1)));
          sumSq = 0;
          count = 0;
          api.sendFrame(channel, /** @type {ArrayBuffer} */ (frame.buffer), level);
        }
      };
      e.mute = e.ctx.createGain(); // keeps the graph pulled without audible output
      e.mute.gain.value = 0;
      e.src.connect(e.node).connect(e.mute).connect(e.ctx.destination);
      track.onended = () => fail(channel, e, new Error('audio track ended'));
      status(channel, 'live', e.ctx.sampleRate);
    } catch (err) {
      fail(channel, e, err);
    }
  }

  function fail(channel, e, err) {
    release(e);
    if (e.cancelled) return;
    if (active.get(channel) === e) active.delete(channel);
    status(channel, 'error', undefined, err);
  }

  function stop(channel) {
    const e = active.get(channel);
    if (!e) return;
    e.cancelled = true;
    active.delete(channel);
    release(e);
    status(channel, 'stopped');
  }

  api.onCmd(({ cmd, channels } = /** @type {any} */ ({})) => {
    const list = (Array.isArray(channels) && channels.length ? channels : CHANNELS).filter((c) => CHANNELS.includes(c));
    if (cmd === 'start') list.forEach((c) => start(c));
    else if (cmd === 'stop') list.forEach((c) => stop(c));
  });
})();
