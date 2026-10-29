'use strict';
// POST /v1/chat/completions: OpenAI-compatible, metered proxy to Nebius Token Factory or Gemini (free tier).

const { ApiError, sendError } = require('./errors');
const { MODEL_PROVIDER, priceFor, tokenCost } = require('./prices');

const MAX_TOKENS = 1200;
const MAX_MESSAGES = 400;
const MAX_PARTS = 64;
const MAX_NEBIUS_INPUT_BYTES = 400 * 1024;
const MAX_PLAIN_BODY_BYTES = 1024 * 1024; // larger bodies only for Gemini requests with an image
const MAX_IMAGES = 1;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ABORT_OUTPUT_SHARE = 0.25; // aborted/failed upstream calls are billed input + 25% of max_tokens
const ROLES = new Set(['system', 'user', 'assistant']);
const REASONING_EFFORT = new Set(['none', 'low', 'medium']);
const DATA_IMAGE = /^data:image\/(png|jpeg|jpg|webp|gif|heic|heif);base64,([A-Za-z0-9+/=\r\n]+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIMITS = Object.freeze({
  maxInflightPerLease: 2,
  userRequestsPerMinute: 30,
  leaseRecheckMs: 30_000,
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function bad(message) {
  return new ApiError(400, 'bad_request', message);
}

// Returns { messages, textBytes, images } with only role + content kept; image parts only for vision (Gemini).
function sanitizeMessages(messages, { vision }) {
  if (!Array.isArray(messages) || messages.length === 0) throw bad('messages must be a non-empty array.');
  if (messages.length > MAX_MESSAGES) throw bad('Too many messages.');
  let textBytes = 0;
  let images = 0;
  const out = messages.map((m) => {
    if (!isPlainObject(m) || !ROLES.has(m.role)) throw bad('Each message needs a role of system, user or assistant.');
    if (typeof m.content === 'string') {
      textBytes += Buffer.byteLength(m.content, 'utf8');
      return { role: m.role, content: m.content };
    }
    if (!Array.isArray(m.content) || m.content.length === 0 || m.content.length > MAX_PARTS) {
      throw bad('Message content must be a string or a list of parts.');
    }
    const parts = m.content.map((p) => {
      if (isPlainObject(p) && p.type === 'text' && typeof p.text === 'string') {
        textBytes += Buffer.byteLength(p.text, 'utf8');
        return { type: 'text', text: p.text };
      }
      if (isPlainObject(p) && p.type === 'image_url' && isPlainObject(p.image_url) && typeof p.image_url.url === 'string') {
        if (!vision) throw bad('This model does not accept images.');
        const match = DATA_IMAGE.exec(p.image_url.url);
        if (!match) throw bad('Images must be base64 data URLs.');
        images += 1;
        if (images > MAX_IMAGES) throw bad('At most one image per request.');
        const b64 = match[2].replace(/[\r\n]/g, '');
        const bytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
        if (bytes > MAX_IMAGE_BYTES) throw new ApiError(413, 'too_large', 'Images must be at most 4 MB.');
        const img = { url: p.image_url.url };
        if (['auto', 'low', 'high'].includes(p.image_url.detail)) img.detail = p.image_url.detail;
        return { type: 'image_url', image_url: img };
      }
      throw bad('Unsupported message part.');
    });
    return { role: m.role, content: parts };
  });
  return { messages: out, textBytes, images };
}

function sanitizeTemplateKwargs(v) {
  if (!isPlainObject(v)) return undefined;
  const out = {};
  for (const [k, val] of Object.entries(v).slice(0, 16)) {
    if (k.length > 64) continue;
    if (['boolean', 'number', 'string'].includes(typeof val) && String(val).length <= 200) out[k] = val;
  }
  return out;
}

// Builds the upstream body from the client body. Unknown top-level fields are dropped.
// The input-token estimate is the UTF-8 byte count: an upper bound for any tokenizer.
function buildUpstreamBody(body, provider) {
  const model = body.model;
  const { messages, textBytes, images } = sanitizeMessages(body.messages, { vision: provider === 'gemini' });
  if (provider === 'nebius' && textBytes > MAX_NEBIUS_INPUT_BYTES) {
    throw new ApiError(413, 'too_large', 'The prompt is too long (max 400 KB).');
  }
  const requested = Number(body.max_tokens);
  const maxTokens = Number.isInteger(requested) && requested >= 1 ? Math.min(requested, MAX_TOKENS) : MAX_TOKENS;
  const stream = body.stream === true;
  const out = { model, messages, max_tokens: maxTokens, stream };
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature) && body.temperature >= 0 && body.temperature <= 2) {
    out.temperature = body.temperature;
  }
  if (provider === 'nebius') {
    const kw = sanitizeTemplateKwargs(body.chat_template_kwargs);
    if (kw) out.chat_template_kwargs = kw;
    // Nemotron is a reasoning model: thinking stays off unless the client says otherwise (registry extraBody).
    else if (model.startsWith('nvidia/Nemotron')) out.chat_template_kwargs = { enable_thinking: false };
  }
  if (provider === 'gemini' && body.reasoning_effort !== undefined) {
    if (!REASONING_EFFORT.has(body.reasoning_effort)) throw bad('reasoning_effort must be none, low or medium.');
    out.reasoning_effort = body.reasoning_effort;
  }
  if (stream) out.stream_options = { include_usage: true }; // forced: metering needs the usage chunk
  // Reservation (cap check): UTF-8 bytes, a hard upper bound. Recorded estimates (no usage reported): bytes/3,
  // closer to real tokenizers so failed calls do not burn caps at ~4x the real cost.
  const inputTokensEstimate = textBytes + 4 * messages.length;
  const recordedInputEstimate = Math.ceil(textBytes / 3) + 4 * messages.length;
  return { body: out, inputTokensEstimate, recordedInputEstimate, maxTokens, images };
}

// Could the provider have billed a create() call that threw? Yes for an abort after sending, a timeout or a
// 5xx; no for a 4xx (400-499: rejected, rate limited, unauthorized) or a connection error with no status
// (ECONNREFUSED, ENOTFOUND: the request never arrived).
function mayHaveBilled(err, signal) {
  const status = Number(err && err.status);
  if (status >= 400 && status < 500) return false;
  if (status >= 500) return true;
  const name = String((err && (err.name || (err.constructor && err.constructor.name))) || '');
  if ((signal && signal.aborted) || name === 'AbortError' || name === 'APIUserAbortError') return true;
  if (name === 'APIConnectionTimeoutError' || /timeout/i.test(name)) return true;
  return false;
}

function deltaBytes(chunk) {
  let n = 0;
  for (const c of (chunk && chunk.choices) || []) {
    const d = c && c.delta;
    if (!d) continue;
    if (typeof d.content === 'string') n += Buffer.byteLength(d.content, 'utf8');
    if (typeof d.reasoning_content === 'string') n += Buffer.byteLength(d.reasoning_content, 'utf8');
  }
  return n;
}

function createChatHandler({ db, spend, prices, clients, log, now = () => Date.now(), limits = {} }) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const byLease = new Map(); // leaseId -> Set<entry>; entry = { ac, leaseEnded }
  const byUser = new Map(); // userId -> recent request timestamps (ms)

  function rateLimited(userId) {
    const t = now();
    const recent = (byUser.get(userId) || []).filter((x) => t - x < 60_000);
    if (recent.length >= lim.userRequestsPerMinute) {
      byUser.set(userId, recent);
      return true;
    }
    recent.push(t);
    byUser.set(userId, recent);
    if (byUser.size > 50_000) byUser.clear();
    return false;
  }

  const usable = (state) => state.status === 'active' && (state.usableSeconds ?? state.remainingSeconds) > 0;

  async function checkLease(req) {
    const leaseId = req.get('x-vkin-lease');
    if (!leaseId) throw new ApiError(409, 'lease_inactive', 'X-Vkin-Lease is required. Start a session first.');
    if (!UUID.test(leaseId)) throw new ApiError(404, 'not_found');
    const state = await db.leaseState(req.user.id, leaseId);
    if (state.status !== 'active') throw new ApiError(409, 'lease_inactive');
    if (!usable(state)) throw new ApiError(402, 'no_minutes');
    return leaseId;
  }

  // Aborts every in-flight chat request (and its upstream call) of a lease. Called when the lease ends.
  function abortLease(leaseId) {
    const set = byLease.get(leaseId);
    if (!set) return 0;
    for (const entry of set) {
      entry.leaseEnded = true;
      entry.ac.abort();
    }
    return set.size;
  }

  async function handle(req, res) {
    const body = req.body;
    if (!isPlainObject(body)) return sendError(res, 400, 'bad_request', 'Send a JSON chat body.');
    const provider = typeof body.model === 'string' ? MODEL_PROVIDER[body.model] : undefined;
    if (!provider) return sendError(res, 400, 'model_not_allowed');
    if (rateLimited(req.user.id)) return sendError(res, 429, 'too_many_requests', 'Too many requests. Wait a moment.');

    let leaseId;
    let built;
    try {
      leaseId = await checkLease(req);
      built = buildUpstreamBody(body, provider);
      if ((req.rawBodyBytes || 0) > MAX_PLAIN_BODY_BYTES && !(provider === 'gemini' && built.images > 0)) {
        throw new ApiError(413, 'too_large', 'Request body is too large.');
      }
    } catch (err) {
      if (err instanceof ApiError) return sendError(res, err.status, err.code, err.message);
      throw err;
    }

    const price = priceFor(prices, provider, body.model);
    if (!price) return sendError(res, 503, 'price_unknown');
    const client = clients[provider] ? clients[provider]() : null;
    if (!client) return sendError(res, 503, 'provider_unavailable');

    // Concurrency slot: checked and taken synchronously, before the next await.
    const set = byLease.get(leaseId) || new Set();
    if (set.size >= lim.maxInflightPerLease) {
      return sendError(res, 429, 'too_many_requests', 'At most 2 requests at a time per session.');
    }
    const entry = { ac: new AbortController(), leaseEnded: false };
    set.add(entry);
    byLease.set(leaseId, set);
    let recheck = null;
    const cleanup = () => {
      if (recheck) clearInterval(recheck);
      set.delete(entry);
      if (set.size === 0 && byLease.get(leaseId) === set) byLease.delete(leaseId);
    };

    const estimateUsd = tokenCost(price, built.inputTokensEstimate, built.maxTokens);
    const r = await spend.tryReserve(provider, estimateUsd, req.user.id);
    if (!r.ok) {
      cleanup();
      return r.reason === 'user_cap'
        ? sendError(res, 429, 'user_cap', 'Your trial model budget is used up.')
        : sendError(res, 503, 'capacity');
    }
    const { reservation } = r;
    if (entry.leaseEnded) {
      reservation.release();
      cleanup();
      return sendError(res, 409, 'lease_inactive');
    }

    let clientGone = false;
    res.on('close', () => {
      if (!res.writableEnded) { clientGone = true; entry.ac.abort(); }
    });

    let usage = null;
    let outBytes = 0;
    let metered = false;
    // billable = false: the provider certainly did not bill (4xx, or no connection). A zero row is still
    // written so Gemini request counts stay exact.
    const meter = async (billable = true) => {
      if (metered) return;
      metered = true;
      let tokensIn = 0;
      let tokensOut = 0;
      if (billable) {
        tokensIn = usage && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : built.recordedInputEstimate;
        tokensOut = usage && Number.isFinite(usage.completion_tokens)
          ? usage.completion_tokens
          : Math.max(Math.ceil(outBytes / 3), Math.ceil(built.maxTokens * ABORT_OUTPUT_SHARE));
      }
      const costUsd = tokenCost(price, tokensIn, tokensOut);
      reservation.release();
      log.info({ event: 'chat', provider, model: body.model, tokensIn, tokensOut, costUsd: Number(costUsd.toFixed(6)), estimated: !usage, stream: built.body.stream });
      await spend.record({ userId: req.user.id, leaseId, provider, model: body.model, unitsIn: tokensIn, unitsOut: tokensOut, costUsd });
    };

    // Long requests re-check the lease; a lease that ended (or ran out) aborts the upstream call.
    recheck = setInterval(async () => {
      try {
        const state = await db.leaseState(req.user.id, leaseId);
        if (!usable(state)) { entry.leaseEnded = true; entry.ac.abort(); }
      } catch (err) {
        if (err && err.status === 404) { entry.leaseEnded = true; entry.ac.abort(); }
      }
    }, lim.leaseRecheckMs);
    if (recheck.unref) recheck.unref();

    let result;
    try {
      result = await client.chat.completions.create(built.body, { signal: entry.ac.signal });
    } catch (err) {
      const upstreamStatus = Number(err && err.status) || null;
      log.warn({ event: 'chat_upstream_error', provider, model: body.model, upstreamStatus });
      cleanup();
      await meter(mayHaveBilled(err, entry.ac.signal));
      if (clientGone) return;
      if (entry.leaseEnded) return sendError(res, 409, 'lease_inactive');
      return sendError(res, 502, 'upstream_error', undefined, { upstreamStatus });
    }

    if (!built.body.stream) {
      usage = result && result.usage ? result.usage : null;
      for (const c of (result && result.choices) || []) {
        if (c && c.message && typeof c.message.content === 'string') outBytes += Buffer.byteLength(c.message.content, 'utf8');
      }
      cleanup();
      if (entry.leaseEnded) sendError(res, 409, 'lease_inactive');
      else if (!clientGone) res.status(200).json(result);
      await meter();
      return;
    }

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    try {
      for await (const chunk of result) {
        if (chunk && chunk.usage) usage = chunk.usage;
        outBytes += deltaBytes(chunk);
        if (clientGone || entry.leaseEnded) break;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      if (entry.leaseEnded && !clientGone) {
        res.write(`data: ${JSON.stringify({ error: { code: 'lease_inactive', message: 'The session ended.' } })}\n\n`);
      } else if (!clientGone) {
        res.write('data: [DONE]\n\n');
      }
    } catch (err) {
      if (!clientGone) {
        const code = entry.leaseEnded ? 'lease_inactive' : 'upstream_error';
        if (!entry.leaseEnded) log.warn({ event: 'chat_stream_error', provider, model: body.model });
        res.write(`data: ${JSON.stringify({ error: { code, message: entry.leaseEnded ? 'The session ended.' : 'The model provider stream failed.' } })}\n\n`);
      }
    } finally {
      cleanup();
      if (!res.writableEnded) res.end();
      await meter();
    }
    return undefined;
  }

  return {
    handle,
    abortLease,
    count: (leaseId) => (byLease.get(leaseId) ? byLease.get(leaseId).size : 0),
  };
}

module.exports = { createChatHandler, buildUpstreamBody, sanitizeMessages, mayHaveBilled, MAX_TOKENS, UUID };
