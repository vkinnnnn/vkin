// @ts-check
'use strict';
// Hosted mode (docs/vkin-hosted-api.md): the Vkin server holds every provider key and meters the free
// trial and paid minutes. The desktop only carries the signed-in user's Supabase token and the id of
// its session lease. Electron-free so it can be tested with a fake fetch and fake timers.

const FRIENDLY = {
  unauthorized: 'Sign in to Vkin (Copilots & memory) to use the hosted copilot.',
  no_minutes: 'Your Vkin minutes are used up. Paid minutes are coming soon.',
  lease_active: 'Vkin is already live on another device or window. Stop it there first.',
  lease_inactive: 'This copilot session has ended. Press Start to begin a new one.',
  not_found: 'This copilot session has ended. Press Start to begin a new one.',
  capacity: 'Vkin trial capacity is used up for now. Please try again later.',
  price_unknown: 'The Vkin server has no approved price for this model right now.',
  no_session: 'Press Start to use the hosted copilot (it counts toward your minutes).',
  network: 'Cannot reach the Vkin server. Check your connection.',
  user_cap: "This account has reached its AI usage limit for now.",
  too_many_requests: 'Too many answers at once. Wait a moment and try again.',
  too_large: 'That request is too large for the Vkin server.',
};

/** Accepts https URLs, and http only for localhost (development). Returns the URL without a trailing slash. */
function checkApiUrl(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { throw new Error('VKIN_API_URL is not a valid URL'); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('VKIN_API_URL must use https');
  if (u.search || u.hash || u.username || u.password) throw new Error('VKIN_API_URL must be a plain origin or path');
  return s;
}

const hostedError = (code, status) => Object.assign(new Error(FRIENDLY[code] || code), { code: `HOSTED_${String(code).toUpperCase()}`, hostedCode: code, status });

/**
 * @param {{ config: any, env?: Record<string, string|undefined>, getToken: () => Promise<string|null>,
 *   fetchImpl?: typeof fetch, setTimer?: typeof setInterval, clearTimer?: typeof clearInterval,
 *   onState?: (s: any) => void, onEnded?: (reason: string) => void, log?: (...a: any[]) => void }} opts
 */
function createHosted({ config, env = process.env, getToken, fetchImpl = fetch, setTimer = setInterval, clearTimer = clearInterval, onState = () => {}, onEnded = () => {}, log = () => {} }) {
  const h = config.hosted || {};
  const apiUrl = checkApiUrl(env.VKIN_API_URL || h.apiUrl || '');
  const enabled = Boolean(apiUrl) && h.enabled !== false;
  let lease = null; // { id, remainingSeconds, beatEverySec }
  let timer = null;
  let beating = false;

  const state = () => ({ enabled, leaseId: lease ? lease.id : null, remainingSeconds: lease ? lease.remainingSeconds : null });

  async function token() {
    const t = await getToken().catch(() => null);
    if (!t) throw hostedError('unauthorized', 401);
    return t;
  }

  async function call(method, path, body) {
    const t = await token();
    let res;
    try {
      res = await fetchImpl(`${apiUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw hostedError('network');
    }
    let json = {};
    try { json = await res.json(); } catch {}
    if (!res.ok) throw hostedError((json && json.error) || (res.status === 401 ? 'unauthorized' : 'network'), res.status);
    return json;
  }

  function stopTimer() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  function end(reason) {
    stopTimer();
    lease = null;
    onState(state());
    onEnded(reason);
  }

  async function beat() {
    if (!lease || beating) return;
    beating = true;
    const id = lease.id;
    try {
      const r = await call('POST', `/v1/sessions/${encodeURIComponent(id)}/beat`);
      if (!lease || lease.id !== id) return;
      lease.remainingSeconds = Number(r.remainingSeconds) || 0;
      onState(state());
      if (r.status === 'ended') end('ended');
    } catch (e) {
      // A lost network or a passing server error keeps trying; the server ends the lease on its own
      // after 45 s without a beat. Only a definite refusal (minutes, ended lease, sign-in) ends it here.
      if (e.hostedCode === 'network' || (e.status >= 500 && e.hostedCode !== 'no_minutes')) log('hosted beat failed; retrying', e.status || '');
      else if (lease && lease.id === id) end(e.hostedCode || 'error');
    } finally {
      beating = false;
    }
  }

  async function start(device) {
    if (!enabled) return null;
    if (lease) return state();
    const r = await call('POST', '/v1/sessions/start', { device: String(device || 'Windows').slice(0, 80) });
    lease = { id: String(r.leaseId), remainingSeconds: Number(r.remainingSeconds) || 0, beatEverySec: Math.max(5, Math.min(30, Number(r.beatEverySec) || 15)) };
    timer = setTimer(() => beat(), lease.beatEverySec * 1000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    onState(state());
    return state();
  }

  async function stop() {
    if (!lease) return state();
    const id = lease.id;
    stopTimer();
    lease = null;
    try {
      const r = await call('POST', `/v1/sessions/${encodeURIComponent(id)}/stop`);
      onState({ ...state(), remainingSeconds: Number(r.remainingSeconds) || 0 });
    } catch (e) {
      log('hosted stop failed', e.hostedCode || e.message);
      onState(state());
    }
    return state();
  }

  /** OpenAI-compatible endpoint for a provider's calls; both Nebius and Gemini models go to the Vkin server. */
  async function endpoint() {
    if (!lease) throw hostedError('no_session');
    return { baseURL: `${apiUrl}/v1`, apiKey: await token(), headers: { 'X-Vkin-Lease': lease.id } };
  }

  /** WebSocket target for one speech channel. The token goes in a header, never in the URL. */
  async function sttTarget(channel) {
    if (!lease) throw hostedError('no_session');
    const ws = apiUrl.replace(/^http/, 'ws');
    return { url: `${ws}/v1/stt`, params: { lease: lease.id, channel }, headers: { Authorization: `Bearer ${await token()}` } };
  }

  return { enabled, apiUrl, start, stop, beat, endpoint, sttTarget, me: () => call('GET', '/v1/me'), state, hasLease: () => Boolean(lease) };
}

/** Maps a server error body/status from the OpenAI SDK (APIError) to a hosted code, or null. */
function hostedCodeOf(e) {
  // The OpenAI SDK puts the parsed error body here; a mid-stream SSE error may carry just the code.
  const body = e && e.error;
  const code = typeof body === 'string' ? body
    : body && typeof body === 'object' ? (typeof body.error === 'string' ? body.error : body.code) : null;
  if (typeof code === 'string' && FRIENDLY[code]) return code;
  if (e && e.status === 401) return 'unauthorized';
  if (e && e.status === 402) return 'no_minutes';
  return null;
}

// Close codes the relay uses for permanent refusals; the client must not reconnect after these.
const STT_FATAL_CLOSE = { 4401: 'unauthorized', 4402: 'no_minutes', 4404: 'not_found', 4409: 'lease_inactive', 4429: 'lease_active', 4503: 'capacity' };

module.exports = { createHosted, checkApiUrl, hostedCodeOf, hostedError, STT_FATAL_CLOSE, HOSTED_FRIENDLY: FRIENDLY };
