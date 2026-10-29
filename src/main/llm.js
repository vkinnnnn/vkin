// @ts-check
'use strict';
// OpenAI-compatible streaming client (Nebius Token Factory by default). Keys never leave this module.

const defaultClientFactory = (baseURL, apiKey) => {
  const OpenAI = /** @type {any} */ (require('openai'));
  return new OpenAI({ baseURL, apiKey });
};

function createLlm(config, { env = process.env, clientFactory = defaultClientFactory } = {}) {
  const cfg = config.llm;
  let provider = cfg.provider;
  let model = cfg.model;
  const clients = new Map();
  const spec = (p = provider) => {
    const s = cfg.providers?.[p];
    if (!s) throw new Error(`Unknown LLM provider "${p}". Configured: ${Object.keys(cfg.providers || {}).join(', ')}`);
    return s;
  };
  spec();

  const redact = (msg, key) => {
    let m = String(msg ?? '');
    if (key) m = m.split(key).join('[redacted]');
    return m.replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]');
  };
  const clientFor = (p) => {
    const s = spec(p);
    const key = env[s.keyEnv];
    if (!key) throw new Error(`Missing API key: set the ${s.keyEnv} environment variable for provider "${p}".`);
    let c = clients.get(p);
    if (!c || c.key !== key) { c = { key, client: clientFactory(s.baseURL, key) }; clients.set(p, c); }
    return c;
  };

  const info = () => ({ provider, model, privacyNote: spec().privacyNote || '' });

  return {
    info,
    hasKey: () => Boolean(env[spec().keyEnv]),
    setProvider(p, m) {
      const s = spec(p);
      const next = m || (p === provider ? model : s.models?.[0]);
      if (!next || (s.models?.length && !s.models.includes(next))) throw new Error(`Model "${next}" is not configured for provider "${p}".`);
      provider = p; model = next;
      return info();
    },
    // Hedged streaming: if no token arrives within cfg.hedgeMs, a second identical request races the
    // first. The first attempt to produce a token wins; the other is aborted and never emits.
    async stream({ messages, signal, onDelta, hedgeMs = cfg.hedgeMs, timeoutMs = cfg.timeoutMs || 15000 }) {
      const t0 = performance.now();
      const used = model;
      const s = spec();
      const done = (text, ttft, aborted, extra = {}) => ({ text, ttftMs: ttft, totalMs: Math.round(performance.now() - t0), model: used, aborted, ...extra });
      if (signal?.aborted) return done('', null, true);
      const { client, key } = clientFor(provider);
      /** @type {any} */
      let winner = null;
      let ttft = null;
      /** @type {any[]} */
      const attempts = [];

      const run = (idx) => {
        const ctl = new AbortController();
        const onOuterAbort = () => ctl.abort();
        signal?.addEventListener('abort', onOuterAbort, { once: true });
        const a = { idx, ctl, text: '' };
        a.promise = (async () => {
          try {
            const it = await client.chat.completions.create(
              { model: used, messages, stream: true, temperature: cfg.temperature, max_tokens: cfg.maxTokens, ...(s.extraParams || {}) },
              { signal: ctl.signal },
            );
            for await (const chunk of it) {
              if (ctl.signal.aborted) break;
              const d = chunk?.choices?.[0]?.delta?.content;
              if (!d) continue;
              if (winner === null) {
                winner = a;
                ttft = Math.round(performance.now() - t0);
                for (const o of attempts) if (o !== a) o.ctl.abort();
              }
              if (winner !== a) break;
              a.text += d;
              onDelta?.(d);
            }
          } catch (e) {
            if (!(ctl.signal.aborted || e?.name === 'AbortError' || /Abort/.test(e?.constructor?.name || ''))) {
              a.error = new Error(redact(e?.message, key));
              if (e?.status) a.error.status = e.status;
            }
          } finally {
            signal?.removeEventListener('abort', onOuterAbort);
          }
        })();
        attempts.push(a);
        return a;
      };

      run(0);
      const timer = hedgeMs > 0 ? setTimeout(() => { if (winner === null && !signal?.aborted) run(1); }, hedgeMs) : null;
      let timedOut = false;
      const hardStop = setTimeout(() => {
        if (winner !== null) return;
        timedOut = true;
        for (const a of attempts) a.ctl.abort();
      }, timeoutMs);
      await attempts[0].promise;
      // First attempt failed before the hedge fired: retry once immediately instead of waiting.
      if (timer && attempts.length === 1 && attempts[0].error && !signal?.aborted) {
        clearTimeout(timer);
        run(1);
      }
      for (let n = 0; n !== attempts.length;) {
        n = attempts.length;
        await Promise.all(attempts.map((a) => a.promise));
      }
      clearTimeout(timer);
      clearTimeout(hardStop);
      if (timedOut && !signal?.aborted) throw new Error(`No response from ${provider} within ${timeoutMs} ms`);
      if (winner) return done(winner.text, ttft, Boolean(signal?.aborted), { hedged: attempts.length > 1, winner: winner.idx });
      const err = attempts.find((a) => a.error)?.error;
      if (err && !signal?.aborted) throw err;
      return done('', null, Boolean(signal?.aborted));
    },
  };
}

module.exports = { createLlm };
