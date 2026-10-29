// @ts-check
'use strict';
// Vkin isolation test against a REAL Supabase project, over the public REST + Storage APIs.
//
//   VKIN_SUPABASE_URL, VKIN_SUPABASE_ANON_KEY            the project's URL and anon/publishable key
//   VKIN_TEST_A_EMAIL, VKIN_TEST_A_PASSWORD             two throwaway test accounts (create them in the
//   VKIN_TEST_B_EMAIL, VKIN_TEST_B_PASSWORD             dashboard: Authentication > Add user > auto-confirm)
//
//   node scripts/vkin-isolation-test.js
//
// Refuses to run unless every variable is set, and refuses service_role / secret keys. Never prints keys,
// passwords, tokens or emails. Creates a few rows and one storage object, then deletes them.
const nodeCrypto = require('node:crypto');
const { assertPublicKey, assertProjectUrl } = require('../src/main/vkin/auth');

const REQUIRED_ENV = Object.freeze([
  'VKIN_SUPABASE_URL', 'VKIN_SUPABASE_ANON_KEY',
  'VKIN_TEST_A_EMAIL', 'VKIN_TEST_A_PASSWORD', 'VKIN_TEST_B_EMAIL', 'VKIN_TEST_B_PASSWORD',
]);
const TABLES = Object.freeze(['profiles', 'profile_facts', 'copilots', 'documents', 'threads', 'sessions', 'memory_items', 'transcript_lines']);

/** @returns {{ ok: boolean, reason?: string }} */
function checkEnv(env) {
  const missing = REQUIRED_ENV.filter((k) => !String(env[k] || '').trim());
  if (missing.length) return { ok: false, reason: `missing environment variables: ${missing.join(', ')}` };
  try {
    assertProjectUrl(env.VKIN_SUPABASE_URL);
    assertPublicKey(env.VKIN_SUPABASE_ANON_KEY);
  } catch (err) {
    return { ok: false, reason: /** @type {any} */ (err).message };
  }
  if (env.VKIN_TEST_A_EMAIL.trim().toLowerCase() === env.VKIN_TEST_B_EMAIL.trim().toLowerCase()) {
    return { ok: false, reason: 'test accounts A and B must be different' };
  }
  return { ok: true };
}

const errText = (e) => (e ? `${e.code || e.statusCode || e.status || ''} ${String(e.message || e.error || '').slice(0, 120)}`.trim() : 'no error');

/**
 * @param {{ env?: Record<string, string|undefined>, createClient?: (url: string, key: string, opts: any) => any, log?: (line: string) => void }} [p]
 * @returns {Promise<{ refused?: string, passed: number, failed: number }>}
 */
async function runIsolation({ env = process.env, createClient, log = (l) => console.log(l) } = {}) {
  const pre = checkEnv(env);
  if (!pre.ok) {
    log(`refusing to run: ${pre.reason}`);
    return { refused: pre.reason, passed: 0, failed: 0 };
  }
  const make = createClient || require('@supabase/supabase-js').createClient;
  const url = assertProjectUrl(env.VKIN_SUPABASE_URL);
  const key = String(env.VKIN_SUPABASE_ANON_KEY).trim();
  const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const A = make(url, key, opts);
  const B = make(url, key, opts);
  const anon = make(url, key, opts);

  const signIn = async (client, who, email, password) => {
    const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (error || !data || !data.user) throw new Error(`sign-in failed for test account ${who}: ${errText(error)}`);
    return String(data.user.id);
  };

  let passed = 0;
  let failed = 0;
  let n = 0;
  async function check(name, fn) {
    n += 1;
    try {
      const why = await fn();
      if (why) { failed += 1; log(`FAIL ${String(n).padStart(2)} ${name}: ${why}`); } else { passed += 1; log(`PASS ${String(n).padStart(2)} ${name}`); }
    } catch (err) {
      failed += 1;
      log(`FAIL ${String(n).padStart(2)} ${name}: ${String((err && err.message) || err).slice(0, 160)}`);
    }
  }
  const must = async (label, promise) => {
    const { error } = await promise;
    if (error) throw new Error(`setup failed (${label}): ${errText(error)}`);
  };

  const id = () => nodeCrypto.randomUUID();
  const ids = { bc: id(), bt: id(), bs: id(), bm: id(), bl: id(), doc: id(), ac: id() };
  let uidA = '';
  let uidB = '';
  let pathB = '';
  const body = Buffer.from('vkin isolation probe (safe to delete)');

  try {
    uidA = await signIn(A, 'A', env.VKIN_TEST_A_EMAIL, env.VKIN_TEST_A_PASSWORD);
    uidB = await signIn(B, 'B', env.VKIN_TEST_B_EMAIL, env.VKIN_TEST_B_PASSWORD);
    if (uidA === uidB) throw new Error('A and B signed in as the same user');
    pathB = `${uidB}/${ids.bc}/${ids.doc}`;

    // Setup as B.
    await must('B copilot', B.from('copilots').insert({ id: ids.bc, name: 'B isolation copilot', purpose: 'probe' }));
    await must('B thread', B.from('threads').insert({ id: ids.bt, copilot_id: ids.bc, title: 'B thread' }));
    await must('B session', B.from('sessions').insert({ id: ids.bs, copilot_id: ids.bc, thread_id: ids.bt, save_transcript: true }));
    await must('B memory', B.from('memory_items').insert({ id: ids.bm, copilot_id: ids.bc, thread_id: ids.bt, session_id: ids.bs, kind: 'decision', text: 'B secret', status: 'approved', origin: 'their_speech' }));
    await must('B line', B.from('transcript_lines').insert({ id: ids.bl, session_id: ids.bs, speaker: 'them', text: 'B secret line' }));
    await must('B object', B.storage.from('documents').upload(pathB, body, { contentType: 'text/plain', upsert: false }));
    // Setup as A.
    await must('A copilot', A.from('copilots').insert({ id: ids.ac, name: 'A isolation copilot' }));

    const bCopilot = async () => (await B.from('copilots').select('name, rev, deleted_at').eq('id', ids.bc).maybeSingle()).data;

    await check('A cannot select B\'s copilot by id', async () => {
      const { data } = await A.from('copilots').select('id').eq('id', ids.bc);
      return data && data.length ? 'row visible' : '';
    });
    for (const t of TABLES) {
      await check(`A sees no foreign rows in ${t}`, async () => {
        const { data } = await A.from(t).select('id').neq('user_id', uidA).limit(1);
        return data && data.length ? 'foreign row visible' : '';
      });
    }
    await check('A cannot update B\'s copilot', async () => {
      const { data } = await A.from('copilots').update({ name: 'pwned', rev: 2 }).eq('id', ids.bc).select();
      const b = await bCopilot();
      return (data && data.length) || !b || b.name !== 'B isolation copilot' ? 'B\'s row changed' : '';
    });
    await check('A cannot delete B\'s memory item', async () => {
      await A.from('memory_items').delete().eq('id', ids.bm);
      const { data } = await B.from('memory_items').select('text').eq('id', ids.bm).maybeSingle();
      return data && data.text === 'B secret' ? '' : 'B\'s memory item is gone or changed';
    });
    await check('A cannot insert a row owned by B', async () => {
      const { error } = await A.from('copilots').insert({ id: id(), user_id: uidB, name: 'spoof' });
      return error ? '' : 'insert accepted';
    });
    await check('A cannot upsert over B\'s id', async () => {
      const { error } = await A.from('copilots').upsert({ id: ids.bc, name: 'hijack', rev: 2 }, { onConflict: 'id' });
      const b = await bCopilot();
      return !error || !b || b.name !== 'B isolation copilot' ? 'upsert accepted' : '';
    });
    await check('A cannot attach a thread to B\'s copilot', async () => {
      const { error } = await A.from('threads').insert({ id: id(), copilot_id: ids.bc, title: 'attach' });
      return error ? '' : 'insert accepted';
    });
    await check('A cannot attach a transcript line to B\'s session', async () => {
      const { error } = await A.from('transcript_lines').insert({ id: id(), session_id: ids.bs, speaker: 'me', text: 'attach' });
      return error ? '' : 'insert accepted';
    });
    await check('vkin_delete_thread on B\'s thread is a no-op for A', async () => {
      await A.rpc('vkin_delete_thread', { p_id: ids.bt });
      const { data } = await B.from('threads').select('deleted_at').eq('id', ids.bt).maybeSingle();
      return data && !data.deleted_at ? '' : 'B\'s thread was tombstoned';
    });
    await check('a stale rev is rejected with PT409', async () => {
      const { error } = await A.from('copilots').update({ name: 'stale', rev: 1 }).eq('id', ids.ac);
      return error && error.code === 'PT409' ? '' : `expected PT409, got ${errText(error)}`;
    });
    await check('a tombstone clears content', async () => {
      const { error } = await A.from('copilots').update({ deleted_at: new Date().toISOString(), rev: 2 }).eq('id', ids.ac);
      const { data } = await A.from('copilots').select('name, deleted_at').eq('id', ids.ac).maybeSingle();
      return !error && data && data.deleted_at && data.name === '' ? '' : `tombstone not applied (${errText(error)})`;
    });
    await check('a tombstone cannot be revived (PT410)', async () => {
      const { error } = await A.from('copilots').update({ deleted_at: null, name: 'back', rev: 3 }).eq('id', ids.ac);
      return error && error.code === 'PT410' ? '' : `expected PT410, got ${errText(error)}`;
    });

    // Storage.
    const docs = (c) => c.storage.from('documents');
    await check('A cannot download B\'s object', async () => {
      const { data, error } = await docs(A).download(pathB);
      return error || !data ? '' : 'download succeeded';
    });
    await check('A cannot list B\'s folder', async () => {
      const { data } = await docs(A).list(`${uidB}/${ids.bc}`);
      return data && data.length ? 'listing visible' : '';
    });
    await check('A cannot upload into B\'s folder', async () => {
      const { error } = await docs(A).upload(`${uidB}/${ids.bc}/planted-${id()}`, body, { contentType: 'text/plain' });
      return error ? '' : 'upload accepted';
    });
    await check('A cannot overwrite B\'s object', async () => {
      const { error } = await docs(A).upload(pathB, Buffer.from('pwned'), { contentType: 'text/plain', upsert: true });
      const own = await docs(B).download(pathB);
      const text = own.data ? Buffer.from(await own.data.arrayBuffer()).toString('utf8') : '';
      return !error || text !== body.toString('utf8') ? 'object overwritten' : '';
    });
    await check('A cannot sign a URL for B\'s object', async () => {
      const { data, error } = await docs(A).createSignedUrl(pathB, 60);
      return error || !data || !data.signedUrl ? '' : 'signed URL issued';
    });
    await check('A cannot remove B\'s object', async () => {
      await docs(A).remove([pathB]);
      const own = await docs(B).download(pathB);
      return own.error ? 'B\'s object is gone' : '';
    });
    await check('B can read its own object (positive control)', async () => {
      const { error } = await docs(B).download(pathB);
      return error ? `B download failed: ${errText(error)}` : '';
    });
    await check('anon reads no rows', async () => {
      const { data } = await anon.from('copilots').select('id').limit(1);
      return data && data.length ? 'anon saw rows' : '';
    });
    await check('anon cannot download B\'s object', async () => {
      const { data, error } = await docs(anon).download(pathB);
      return error || !data ? '' : 'download succeeded';
    });
  } catch (err) {
    failed += 1;
    log(`ABORT ${String((err && err.message) || err).slice(0, 200)}`);
  } finally {
    // Cleanup (hard delete of the probe rows; composite FKs cascade children).
    try { if (pathB) await B.storage.from('documents').remove([pathB]); } catch {}
    try { if (uidB) await B.from('copilots').delete().eq('id', ids.bc); } catch {}
    try { if (uidA) await A.from('copilots').delete().eq('id', ids.ac); } catch {}
    for (const c of [A, B]) { try { await c.auth.signOut({ scope: 'local' }); } catch {} }
  }
  log(`${passed} passed, ${failed} failed`);
  return { passed, failed };
}

module.exports = { runIsolation, checkEnv, REQUIRED_ENV };

if (require.main === module) {
  runIsolation().then((r) => { process.exitCode = r.refused ? 2 : r.failed ? 1 : 0; });
}
