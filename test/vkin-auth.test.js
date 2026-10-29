'use strict';
// Vkin auth: OTP flow, encrypted session persistence, key checks, sign-out cleanup. No network: a fake client,
// plus the real supabase-js client wired to a fake fetch to prove the storage adapter is what persists tokens.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createVkinAuth, createEncryptedStorage, configFromEnv, assertPublicKey, safeStorageCrypto,
} = require('../src/main/vkin/auth');
const { createVkinStore } = require('../src/main/vkin/store');

const USER = '11111111-1111-4111-8111-111111111111';
const URL_OK = 'https://abcdefghijklmnop.supabase.co';

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.c2lnbmF0dXJl`;
const ANON = jwt({ iss: 'supabase', ref: 'abcdefghijklmnop', role: 'anon' });
const SERVICE = jwt({ iss: 'supabase', ref: 'abcdefghijklmnop', role: 'service_role' });

// Reversible fake of safeStorage: XOR, so ciphertext never contains the plaintext.
const fakeCrypto = (available = true) => ({
  isAvailable: () => available,
  encrypt: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8'),
});

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vkin-auth-')), 'data', 'vkin-session.json');
}

function fakeClient({ verifyError = null } = {}) {
  const calls = [];
  let session = null;
  return {
    calls,
    auth: {
      signInWithOtp: async (args) => { calls.push(['otp', args]); return { data: {}, error: null }; },
      verifyOtp: async (args) => {
        calls.push(['verify', args]);
        if (verifyError) return { data: { user: null, session: null }, error: { message: verifyError } };
        session = { access_token: 'acc', refresh_token: 'ref', user: { id: USER, email: args.email } };
        return { data: { user: session.user, session }, error: null };
      },
      getSession: async () => ({ data: { session }, error: null }),
      signOut: async (args) => { calls.push(['signOut', args]); session = null; return { error: null }; },
      stopAutoRefresh: () => {},
    },
  };
}

test('assertPublicKey: anon JWT and publishable keys pass; service_role and secret keys are rejected', () => {
  assert.equal(assertPublicKey(ANON), 'anon_jwt');
  assert.equal(assertPublicKey('sb_publishable_abc123'), 'publishable');
  assert.throws(() => assertPublicKey(SERVICE), (e) => e.code === 'E_SERVICE_ROLE_KEY');
  assert.throws(() => assertPublicKey('sb_secret_abc123'), (e) => e.code === 'E_SERVICE_ROLE_KEY');
  assert.throws(() => assertPublicKey(jwt({ role: 'authenticated' })), (e) => e.code === 'E_BAD_KEY');
  assert.throws(() => assertPublicKey('garbage'), (e) => e.code === 'E_BAD_KEY');
  assert.throws(() => assertPublicKey(''), (e) => e.code === 'E_BAD_KEY');
});

test('configFromEnv: unset, service_role and plain-http configs are not configured; reasons never echo the key', () => {
  assert.equal(configFromEnv({}).configured, false);
  const svc = configFromEnv({ VKIN_SUPABASE_URL: URL_OK, VKIN_SUPABASE_ANON_KEY: SERVICE });
  assert.equal(svc.configured, false);
  assert.ok(!JSON.stringify(svc).includes(SERVICE));
  assert.equal(configFromEnv({ VKIN_SUPABASE_URL: 'http://example.com', VKIN_SUPABASE_ANON_KEY: ANON }).configured, false);
  assert.deepEqual(configFromEnv({ VKIN_SUPABASE_URL: `${URL_OK}/`, VKIN_SUPABASE_ANON_KEY: ANON }), { configured: true, url: URL_OK, anonKey: ANON });
  assert.equal(configFromEnv({ VKIN_SUPABASE_URL: 'http://127.0.0.1:54321', VKIN_SUPABASE_ANON_KEY: ANON }).configured, true);
});

test('createVkinAuth: a service_role key is refused before any client is created', () => {
  let created = 0;
  assert.throws(() => createVkinAuth({
    url: URL_OK, anonKey: SERVICE, sessionFile: tmpFile(), crypto: fakeCrypto(), createClient: () => { created += 1; return fakeClient(); },
  }), (e) => e.code === 'E_SERVICE_ROLE_KEY');
  assert.equal(created, 0);
});

test('OTP flow: email and 6-digit code validated, client called with type email, user returned', async () => {
  const client = fakeClient();
  let opts = null;
  const auth = createVkinAuth({
    url: URL_OK, anonKey: ANON, sessionFile: tmpFile(), crypto: fakeCrypto(),
    createClient: (_u, _k, o) => { opts = o; return client; },
  });
  assert.equal(opts.auth.detectSessionInUrl, false, 'no deep links');
  assert.equal(opts.auth.persistSession, true);
  assert.equal(typeof opts.auth.storage.getItem, 'function');
  await assert.rejects(auth.signIn('not-an-email'), (e) => e.code === 'E_INVALID_EMAIL');
  assert.deepEqual(await auth.signIn(' Me@Example.com '), { sent: true, email: 'me@example.com' });
  assert.deepEqual(client.calls[0], ['otp', { email: 'me@example.com', options: { shouldCreateUser: true } }]);
  await assert.rejects(auth.verify('me@example.com', '12345'), (e) => e.code === 'E_INVALID_CODE');
  await assert.rejects(auth.verify('me@example.com', 'abcdef'), (e) => e.code === 'E_INVALID_CODE');
  const r = await auth.verify('me@example.com', '123 456');
  assert.deepEqual(client.calls[1], ['verify', { email: 'me@example.com', token: '123456', type: 'email' }]);
  assert.deepEqual(r, { userId: USER, email: 'me@example.com', persisted: true });
  const st = await auth.status();
  assert.equal(st.signedIn, true);
  assert.equal(st.userId, USER);
  assert.equal(await auth.userId(), USER);
});

test('OTP flow: a wrong code maps to E_AUTH_CODE without leaking server detail', async () => {
  const auth = createVkinAuth({
    url: URL_OK, anonKey: ANON, sessionFile: tmpFile(), crypto: fakeCrypto(),
    createClient: () => fakeClient({ verifyError: 'Token has expired or is invalid' }),
  });
  await assert.rejects(auth.verify('me@example.com', '000000'), (e) => e.code === 'E_AUTH_CODE');
});

test('encrypted storage: ciphertext only, survives restart, nothing written without encryption, bad file dropped', () => {
  const file = tmpFile();
  const token = JSON.stringify({ access_token: 'ACCESS-SECRET-123', refresh_token: 'REFRESH-SECRET-456' });
  const s1 = createEncryptedStorage({ file, crypto: fakeCrypto() });
  s1.setItem('vkin-auth', token);
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /SECRET/);
  assert.equal(JSON.parse(raw).v, 1);
  const s2 = createEncryptedStorage({ file, crypto: fakeCrypto() });
  assert.equal(s2.getItem('vkin-auth'), token);
  s2.removeItem('vkin-auth');
  assert.equal(fs.existsSync(file), false, 'empty map removes the file');

  const plainFile = tmpFile();
  const s3 = createEncryptedStorage({ file: plainFile, crypto: fakeCrypto(false) });
  s3.setItem('vkin-auth', token);
  assert.equal(s3.getItem('vkin-auth'), token, 'kept in memory');
  assert.equal(fs.existsSync(plainFile), false, 'never written in plain text');

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, blob: Buffer.from('not decryptable').toString('base64') }));
  const bad = { ...fakeCrypto(), decrypt: () => { throw new Error('other OS user'); } };
  const s4 = createEncryptedStorage({ file, crypto: bad });
  assert.equal(s4.getItem('vkin-auth'), null);
  assert.equal(fs.existsSync(file), false);
});

test('safeStorageCrypto adapts Electron safeStorage and reports unavailability safely', () => {
  const c = safeStorageCrypto({ isEncryptionAvailable: () => { throw new Error('not ready'); }, encryptString: (s) => Buffer.from(s), decryptString: (b) => String(b) });
  assert.equal(c.isAvailable(), false);
  assert.equal(c.decrypt(c.encrypt('x')), 'x');
});

test('signOut: removes the session file and memory, notifies listeners, wipes the store only on request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vkin-auth-store-'));
  const store = createVkinStore({ dataRoot: root, account: USER });
  store.createCopilot({ name: 'private' });
  const sessionFile = tmpFile();
  const client = fakeClient();
  const auth = createVkinAuth({
    url: URL_OK, anonKey: ANON, sessionFile, crypto: fakeCrypto(), createClient: () => client,
    storeFor: (acct) => { assert.equal(acct, USER); return store; },
  });
  await auth.verify('me@example.com', '123456');
  auth.getClient().auth; // client is exposed for sync
  /** @type {any[]} */
  const seen = [];
  auth.onSignOut((info) => seen.push(info));
  // A stored session (as GoTrue would write it).
  createEncryptedStorage({ file: sessionFile, crypto: fakeCrypto() }).setItem('vkin-auth', '{"refresh_token":"R"}');
  const r1 = await auth.signOut();
  assert.deepEqual(r1, { signedOut: true, wiped: false });
  assert.deepEqual(client.calls.at(-1), ['signOut', { scope: 'local' }]);
  assert.deepEqual(seen, [{ userId: USER }]);
  assert.equal(fs.existsSync(sessionFile), false);
  assert.equal((await auth.status()).signedIn, false);
  assert.equal(fs.existsSync(store.file), true, 'device data kept by default');

  await auth.verify('me@example.com', '123456');
  const r2 = await auth.signOut({ clearDeviceData: true });
  assert.deepEqual(r2, { signedOut: true, wiped: true });
  assert.equal(fs.existsSync(path.join(root, 'vkin', USER)), false);
});

test('real supabase-js + fake fetch: the session is persisted encrypted, restored after restart, removed on sign-out', async () => {
  const { createClient: realCreate } = require('@supabase/supabase-js');
  const sessionFile = tmpFile();
  const ACCESS = jwt({ sub: USER, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, email: 'me@example.com' });
  const REFRESH = 'REFRESH-TOKEN-SECRET-789';
  const requests = [];
  const fetchFake = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);
    requests.push(`${init.method || 'GET'} ${new URL(url).pathname}`);
    const json = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/auth/v1/otp')) return json(200, {});
    if (url.endsWith('/auth/v1/verify')) {
      return json(200, {
        access_token: ACCESS, refresh_token: REFRESH, token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: USER, aud: 'authenticated', role: 'authenticated', email: 'me@example.com', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
      });
    }
    if (url.includes('/auth/v1/logout')) return new Response(null, { status: 204 });
    return json(404, { message: 'not faked' });
  };
  const make = (u, k, o) => realCreate(u, k, { ...o, global: { fetch: fetchFake } });
  const opts = { url: URL_OK, anonKey: ANON, sessionFile, crypto: fakeCrypto(), createClient: make, autoRefreshToken: false };

  const a1 = createVkinAuth(opts);
  await a1.signIn('me@example.com');
  const v = await a1.verify('me@example.com', '654321');
  assert.equal(v.userId, USER);
  const raw = fs.readFileSync(sessionFile, 'utf8');
  assert.ok(!raw.includes(REFRESH) && !raw.includes(ACCESS), 'tokens are never on disk in plain text');
  a1.dispose();

  const a2 = createVkinAuth(opts); // app restart
  const st = await a2.status();
  assert.equal(st.signedIn, true);
  assert.equal(st.userId, USER);
  await a2.signOut();
  assert.equal(fs.existsSync(sessionFile), false);
  assert.equal((await a2.status()).signedIn, false);
  a2.dispose();
  assert.ok(requests.includes('POST /auth/v1/otp') && requests.includes('POST /auth/v1/verify'), requests.join(', '));
});
