// @ts-check
'use strict';
// Encrypted API-key storage (PRD Phase 6). Keys are encrypted with Electron safeStorage (Windows DPAPI /
// macOS Keychain / libsecret), bound to this OS user, and kept in data/secrets.json. Only the three
// provider keys are handled; values are never logged or returned to a renderer, only key NAMES are.
const fs = require('node:fs');
const path = require('node:path');

const ALLOWED = Object.freeze(['DEEPGRAM_API_KEY', 'NEBIUS_API_KEY', 'GEMINI_API_KEY']);
const ENV_LINE = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/;

function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = ENV_LINE.exec(line);
    if (!m || !ALLOWED.includes(m[1])) continue;
    const v = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (v) out[m[1]] = v;
  }
  return out;
}

/**
 * @param {{ file: string, envFile: string, safeStorage: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string } }} deps
 */
function createSecretStore({ file, envFile, safeStorage }) {
  const available = () => { try { return Boolean(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; } };

  function readStore() {
    if (!fs.existsSync(file)) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && data.v === 1 && data.keys && typeof data.keys === 'object' ? data.keys : {};
  }

  /** Decrypted keys (main process only). Unreadable entries are skipped, never thrown to the caller. */
  function load() {
    if (!available()) return {};
    const out = {};
    for (const [name, b64] of Object.entries(readStore())) {
      if (!ALLOWED.includes(name)) continue;
      try { out[name] = safeStorage.decryptString(Buffer.from(String(b64), 'base64')); } catch {}
    }
    return out;
  }

  /** Fills env with stored keys that are not already set (a real environment variable always wins). */
  function applyTo(env) {
    const applied = [];
    for (const [k, v] of Object.entries(load())) {
      if (!env[k] && v) { env[k] = v; applied.push(k); }
    }
    return applied;
  }

  function status() {
    const stored = Object.keys(readStore()).filter((k) => ALLOWED.includes(k));
    const plain = fs.existsSync(envFile) ? Object.keys(parseEnv(fs.readFileSync(envFile, 'utf8'))) : [];
    return { encryptionAvailable: available(), encrypted: stored, plaintextInEnvFile: plain };
  }

  /**
   * Moves the provider keys from .env into encrypted storage: encrypt, write, read back and verify, and
   * only then remove those lines from .env (other lines are kept as they are).
   */
  function protectFromEnvFile() {
    if (!available()) throw new Error('OS encryption is not available for this user');
    if (!fs.existsSync(envFile)) throw new Error('.env not found');
    const envText = fs.readFileSync(envFile, 'utf8');
    const keys = parseEnv(envText);
    const names = Object.keys(keys);
    if (!names.length) return { moved: [] };
    const store = { ...readStore() };
    for (const n of names) store[n] = safeStorage.encryptString(keys[n]).toString('base64');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, keys: store }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    const check = load();
    for (const n of names) if (check[n] !== keys[n]) throw new Error(`verification failed for ${n}; .env was not changed`);
    const kept = envText.split(/\r?\n/).filter((line) => { const m = ENV_LINE.exec(line); return !(m && names.includes(m[1])); });
    fs.writeFileSync(envFile, kept.join('\n'), 'utf8');
    return { moved: names };
  }

  return { available, load, applyTo, status, protectFromEnvFile };
}

module.exports = { createSecretStore, parseEnv, ALLOWED };
