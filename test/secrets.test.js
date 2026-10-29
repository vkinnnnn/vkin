'use strict';
// Phase 6 encrypted key storage, with a fake reversible safeStorage (the real one is OS-bound).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSecretStore, parseEnv } = require('../src/main/secrets');

const fakeSafe = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('hex')}`),
  decryptString: (b) => Buffer.from(String(b).slice(4), 'hex').toString(),
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabel-secrets-'));
  return { dir, file: path.join(dir, 'data', 'secrets.json'), envFile: path.join(dir, '.env') };
}

test('parseEnv reads only the three provider keys, with or without quotes', () => {
  const env = parseEnv('NEBIUS_API_KEY="abc"\nOTHER=1\n# c\nexport DEEPGRAM_API_KEY=dg\nGEMINI_API_KEY=\nCOPILOT_DEBUG=1');
  assert.deepEqual(env, { NEBIUS_API_KEY: 'abc', DEEPGRAM_API_KEY: 'dg' });
});

test('protect moves keys to encrypted storage, verifies, then strips only those lines from .env', () => {
  const t = tmp();
  fs.writeFileSync(t.envFile, 'NEBIUS_API_KEY=neb-secret\nCOPILOT_DEBUG=1\nDEEPGRAM_API_KEY="dg-secret"\n');
  const s = createSecretStore({ file: t.file, envFile: t.envFile, safeStorage: fakeSafe() });
  assert.deepEqual(s.status().plaintextInEnvFile.sort(), ['DEEPGRAM_API_KEY', 'NEBIUS_API_KEY']);
  const r = s.protectFromEnvFile();
  assert.deepEqual(r.moved.sort(), ['DEEPGRAM_API_KEY', 'NEBIUS_API_KEY']);
  const env = fs.readFileSync(t.envFile, 'utf8');
  assert.doesNotMatch(env, /secret/);
  assert.match(env, /COPILOT_DEBUG=1/, 'other lines kept');
  const raw = fs.readFileSync(t.file, 'utf8');
  assert.doesNotMatch(raw, /neb-secret|dg-secret/, 'no plaintext at rest');
  assert.deepEqual(s.status().encrypted.sort(), ['DEEPGRAM_API_KEY', 'NEBIUS_API_KEY']);
  const target = { NEBIUS_API_KEY: 'from-real-env' };
  const applied = s.applyTo(target);
  assert.deepEqual(applied, ['DEEPGRAM_API_KEY'], 'a real environment variable wins');
  assert.equal(target.DEEPGRAM_API_KEY, 'dg-secret');
  assert.equal(target.NEBIUS_API_KEY, 'from-real-env');
});

test('no OS encryption: nothing is moved and .env is untouched', () => {
  const t = tmp();
  fs.writeFileSync(t.envFile, 'NEBIUS_API_KEY=x\n');
  const s = createSecretStore({ file: t.file, envFile: t.envFile, safeStorage: fakeSafe(false) });
  assert.throws(() => s.protectFromEnvFile(), /not available/);
  assert.equal(fs.readFileSync(t.envFile, 'utf8'), 'NEBIUS_API_KEY=x\n');
  assert.deepEqual(s.load(), {});
});

test('failed verification leaves .env unchanged', () => {
  const t = tmp();
  fs.writeFileSync(t.envFile, 'GEMINI_API_KEY=g\n');
  const broken = { ...fakeSafe(), decryptString: () => 'wrong' };
  const s = createSecretStore({ file: t.file, envFile: t.envFile, safeStorage: broken });
  assert.throws(() => s.protectFromEnvFile(), /verification failed/);
  assert.equal(fs.readFileSync(t.envFile, 'utf8'), 'GEMINI_API_KEY=g\n');
});
