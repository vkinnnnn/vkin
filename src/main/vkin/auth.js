// @ts-check
'use strict';
// Vkin sign-in for the desktop main process: Supabase email OTP (6-digit code, no deep links).
//
// - Config comes from env VKIN_SUPABASE_URL / VKIN_SUPABASE_ANON_KEY. The anon (publishable) key is public by
//   design; a service_role / secret key is rejected outright, because it bypasses RLS.
// - The session is persisted only through an injected encrypt/decrypt pair (Electron safeStorage in the app).
//   If encryption is unavailable the session stays in memory and is never written in plain text.
// - signOut removes the session file and in-memory session, notifies listeners so other caches can be
//   dropped, and wipes the account's local store only when the user chose "clear device data".
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { VkinError, isUuid } = require('./schema');

const STORAGE_KEY = 'vkin-auth';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function b64urlJson(part) {
  const b64 = String(part).replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

/**
 * Accepts only a public client key: a legacy JWT whose role is "anon", or a new "sb_publishable_" key.
 * Throws VkinError E_SERVICE_ROLE_KEY for service_role JWTs and sb_secret_ keys, E_BAD_KEY otherwise.
 * @param {string} key
 * @returns {'anon_jwt'|'publishable'}
 */
function assertPublicKey(key) {
  const k = String(key || '').trim();
  if (!k) throw new VkinError('E_BAD_KEY', 'Supabase anon key is missing');
  if (k.startsWith('sb_secret_')) throw new VkinError('E_SERVICE_ROLE_KEY', 'a Supabase secret key must never be used in the desktop app');
  if (k.startsWith('sb_publishable_')) return 'publishable';
  const parts = k.split('.');
  if (parts.length !== 3) throw new VkinError('E_BAD_KEY', 'Supabase anon key is not a recognised key format');
  let claims;
  try {
    claims = b64urlJson(parts[1]);
  } catch {
    throw new VkinError('E_BAD_KEY', 'Supabase anon key could not be decoded');
  }
  if (claims && claims.role === 'service_role') {
    throw new VkinError('E_SERVICE_ROLE_KEY', 'a service_role key must never be used in the desktop app');
  }
  if (!claims || claims.role !== 'anon') throw new VkinError('E_BAD_KEY', 'Supabase key is not an anon key');
  return 'anon_jwt';
}

/** https everywhere; plain http only for a local Supabase stack. */
function assertProjectUrl(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    throw new VkinError('E_BAD_URL', 'VKIN_SUPABASE_URL is not a valid URL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new VkinError('E_BAD_URL', 'VKIN_SUPABASE_URL must use https');
  return u.origin;
}

/**
 * @param {Record<string, string|undefined>} env
 * @returns {{ configured: true, url: string, anonKey: string } | { configured: false, reason: string }}
 */
function configFromEnv(env = process.env) {
  const url = env.VKIN_SUPABASE_URL;
  const anonKey = env.VKIN_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return { configured: false, reason: 'VKIN_SUPABASE_URL and VKIN_SUPABASE_ANON_KEY are not set' };
  try {
    return { configured: true, url: assertProjectUrl(url), anonKey: (assertPublicKey(anonKey), anonKey.trim()) };
  } catch (err) {
    return { configured: false, reason: /** @type {any} */ (err).message };
  }
}

/**
 * @typedef {{ isAvailable: () => boolean, encrypt: (s: string) => Buffer, decrypt: (b: Buffer) => string }} SessionCrypto
 */

/** Adapts Electron's safeStorage to the SessionCrypto shape. */
function safeStorageCrypto(safeStorage) {
  return {
    isAvailable: () => { try { return Boolean(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; } },
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  };
}

/**
 * GoTrue storage adapter backed by one encrypted file. Values are kept in memory; the file holds only
 * ciphertext, and nothing is written at all when encryption is unavailable.
 * @param {{ file: string, crypto: SessionCrypto }} p
 */
function createEncryptedStorage({ file, crypto }) {
  /** @type {Map<string, string>|null} */
  let mem = null;
  const available = () => { try { return Boolean(crypto && crypto.isAvailable()); } catch { return false; } };

  function load() {
    if (mem) return mem;
    mem = new Map();
    if (!available() || !fs.existsSync(file)) return mem;
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc && doc.v === 1 && typeof doc.blob === 'string') {
        const map = JSON.parse(crypto.decrypt(Buffer.from(doc.blob, 'base64')));
        for (const [k, v] of Object.entries(map || {})) if (typeof v === 'string') mem.set(k, v);
      }
    } catch {
      // Unreadable (other OS user, corrupted): drop it rather than keep a session we cannot verify.
      try { fs.unlinkSync(file); } catch {}
    }
    return mem;
  }

  function persist() {
    const m = load();
    if (!m.size) {
      try { fs.unlinkSync(file); } catch {}
      return;
    }
    if (!available()) return;
    const blob = crypto.encrypt(JSON.stringify(Object.fromEntries(m))).toString('base64');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${nodeCrypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, blob }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  return {
    getItem: (key) => (load().has(key) ? /** @type {string} */ (load().get(key)) : null),
    setItem: (key, value) => { load().set(key, String(value)); persist(); },
    removeItem: (key) => { load().delete(key); persist(); },
    /** Drops the in-memory copy and the file. */
    clear: () => { mem = new Map(); try { fs.unlinkSync(file); } catch {} },
    encrypted: available,
  };
}

/**
 * @param {{
 *   url: string,
 *   anonKey: string,
 *   sessionFile: string,
 *   crypto: SessionCrypto,
 *   createClient?: (url: string, key: string, opts: any) => any,
 *   autoRefreshToken?: boolean,
 *   storeFor?: (account: string) => { wipeAccount: () => any },
 * }} opts
 */
function createVkinAuth({ url, anonKey, sessionFile, crypto, createClient, autoRefreshToken = true, storeFor }) {
  const origin = assertProjectUrl(url);
  assertPublicKey(anonKey);
  if (!sessionFile) throw new VkinError('E_INVALID', 'sessionFile is required');
  const storage = createEncryptedStorage({ file: sessionFile, crypto });
  const make = createClient || require('@supabase/supabase-js').createClient;
  const client = make(origin, String(anonKey).trim(), {
    auth: {
      storage,
      storageKey: STORAGE_KEY,
      persistSession: true,
      autoRefreshToken,
      detectSessionInUrl: false,
      flowType: 'implicit',
    },
  });
  /** @type {Set<(info: {userId: string|null}) => void>} */
  const signOutListeners = new Set();
  /** @type {{ id: string, email: string }|null} */
  let current = null;

  async function session() {
    const { data, error } = await client.auth.getSession();
    if (error) return null;
    return (data && data.session) || null;
  }

  async function userId() {
    const s = await session();
    const id = s && s.user && s.user.id;
    return isUuid(id) ? String(id).toLowerCase() : null;
  }

  async function status() {
    const s = await session();
    const user = s && s.user;
    current = user && isUuid(user.id) ? { id: String(user.id).toLowerCase(), email: String(user.email || '') } : null;
    return {
      configured: true,
      encryptionAvailable: storage.encrypted(),
      signedIn: Boolean(current),
      userId: current ? current.id : null,
      email: current ? current.email : null,
    };
  }

  function checkEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(e) || e.length > 254) throw new VkinError('E_INVALID_EMAIL', 'enter a valid email address');
    return e;
  }

  /** Sends the 6-digit sign-in code. Creates the account on first use. */
  async function signIn(email) {
    const e = checkEmail(email);
    const { error } = await client.auth.signInWithOtp({ email: e, options: { shouldCreateUser: true } });
    if (error) throw new VkinError('E_AUTH', `could not send the sign-in code: ${String(error.message || 'error').slice(0, 200)}`);
    return { sent: true, email: e };
  }

  /** Verifies the emailed code; the session is persisted encrypted (or kept in memory only). */
  async function verify(email, code) {
    const e = checkEmail(email);
    const token = String(code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(token)) throw new VkinError('E_INVALID_CODE', 'enter the 6-digit code from the email');
    const { data, error } = await client.auth.verifyOtp({ email: e, token, type: 'email' });
    if (error) throw new VkinError('E_AUTH_CODE', 'that code is not valid or has expired');
    const user = (data && (data.user || (data.session && data.session.user))) || null;
    if (!user || !isUuid(user.id)) throw new VkinError('E_AUTH', 'sign-in did not return a user');
    current = { id: String(user.id).toLowerCase(), email: String(user.email || e) };
    return { userId: current.id, email: current.email, persisted: storage.encrypted() };
  }

  /**
   * @param {{ clearDeviceData?: boolean }} [opts]
   */
  async function signOut({ clearDeviceData = false } = {}) {
    const uid = (await userId()) || (current && current.id) || null;
    try { await client.auth.signOut({ scope: 'local' }); } catch {}
    storage.clear();
    current = null;
    for (const fn of signOutListeners) {
      try { fn({ userId: uid }); } catch {}
    }
    let wiped = false;
    if (clearDeviceData && uid && storeFor) {
      storeFor(uid).wipeAccount();
      wiped = true;
    }
    return { signedOut: true, wiped };
  }

  /** Registers a cache-clearing callback run on sign-out. Returns an unsubscribe function. */
  function onSignOut(fn) {
    signOutListeners.add(fn);
    return () => signOutListeners.delete(fn);
  }

  function dispose() {
    try { client.auth.stopAutoRefresh(); } catch {}
  }

  return { status, signIn, verify, signOut, onSignOut, userId, getClient: () => client, dispose };
}

module.exports = {
  createVkinAuth,
  createEncryptedStorage,
  safeStorageCrypto,
  configFromEnv,
  assertPublicKey,
  assertProjectUrl,
  STORAGE_KEY,
};
