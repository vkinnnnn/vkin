'use strict';
// Bearer-token verification with supabaseAdmin.auth.getUser(token), cached for at most 60 s per token
// (and never past the token's own exp). The cache is keyed by a SHA-256 of the token, never the token itself.

const crypto = require('node:crypto');

const MAX_TOKEN_CHARS = 8192;

// Reads `Authorization: Bearer <token>`. Query strings are never consulted.
function bearerToken(headers) {
  const h = headers && headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(h);
  if (!m || m[1].length > MAX_TOKEN_CHARS) return null;
  return m[1];
}

function jwtExpMs(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function createTokenVerifier({ supabase, ttlMs = 60_000, now = () => Date.now(), maxEntries = 10_000 }) {
  const cache = new Map();
  const ttl = Math.min(ttlMs, 60_000);

  function prune(t) {
    for (const [k, v] of cache) if (v.until <= t) cache.delete(k);
    while (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
  }

  return async function verifyToken(token) {
    if (!token) return null;
    const key = crypto.createHash('sha256').update(token).digest('hex');
    const t = now();
    const hit = cache.get(key);
    if (hit && hit.until > t) return hit.user;
    if (hit) cache.delete(key);

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) {
      // A rejected token is a normal 401. Network/5xx failures propagate so the caller can answer 503.
      const st = error && Number(error.status);
      if (error && !(st >= 400 && st < 500)) throw new Error('auth unavailable');
      return null;
    }
    const user = { id: data.user.id, email: data.user.email || null };
    const exp = jwtExpMs(token);
    const until = Math.min(t + ttl, exp || Infinity);
    if (until > t) {
      if (cache.size >= maxEntries) prune(t);
      cache.set(key, { user, until });
    }
    return user;
  };
}

module.exports = { bearerToken, createTokenVerifier, jwtExpMs };
