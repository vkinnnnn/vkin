// @ts-check
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 1000;
const LOCK_STALE_MS = 30000;
const CONTENDED = new Set(['EEXIST', 'EPERM', 'EBUSY', 'EACCES']);
const FIELDS = ['v', 'type', 'id', 'ts', 'provider', 'route', 'model', 'bucket', 'session', 'est_in', 'est_out_max',
  'act_in', 'act_out', 'reasoning', 'est_usd', 'final_usd', 'cum_usd', 'usage_source', 'status', 'code',
  'price_version', 'price_in', 'price_out'];

const chains = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const crcOf = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
const num = (...vs) => vs.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);

function encode(fields) {
  const e = {};
  for (const k of FIELDS) e[k] = fields[k] === undefined ? null : fields[k];
  e.v = 1;
  return JSON.stringify({ ...e, crc: crcOf(e) });
}

function parseLine(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const { crc, ...rest } = o;
  return rest.v === 1 && crc === crcOf(rest) ? rest : null;
}

function semanticOk(e, seen) {
  if ((seen.n === 0) !== (e.type === 'open')) return false;
  switch (e.type) {
    case 'open': return num(e.cum_usd);
    case 'reserve':
      if (typeof e.id !== 'string' || seen.res.has(e.id)) return false;
      seen.res.set(e.id, false);
      return num(e.est_usd, e.price_in, e.price_out, e.est_in, e.est_out_max) && typeof e.ts === 'string';
    case 'settle':
      if (seen.res.get(e.id) !== false) return false;
      seen.res.set(e.id, true);
      return num(e.final_usd, e.act_in, e.act_out, e.reasoning);
    case 'reject': return true;
    default: return false;
  }
}

function serialize(key, fn) {
  const run = (chains.get(key) || Promise.resolve()).then(fn);
  chains.set(key, run.catch(() => {}));
  return run;
}

function createLedger(dataDir, provider) {
  const file = path.join(dataDir, `${provider}-ledger.jsonl`);
  const lockPath = path.join(dataDir, `${provider}.lock`);

  function reclaimIfStale() {
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lockPath);
    } catch { /* lock vanished or is not ours to remove */ }
  }

  async function acquire() {
    fs.mkdirSync(dataDir, { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, String(process.pid));
        return () => {
          try { fs.closeSync(fd); } catch { /* already closed */ }
          try { fs.unlinkSync(lockPath); } catch { /* already removed */ }
        };
      } catch (e) {
        if (!CONTENDED.has(e.code)) throw e;
      }
      reclaimIfStale();
      if (Date.now() >= deadline) throw new Error(`ledger lock busy: ${lockPath}`);
      await sleep(LOCK_RETRY_MS);
    }
  }

  function read() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { entries: [], corrupt: false, badLine: null };
      throw e;
    }
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const entries = [];
    const seen = { n: 0, res: new Map() };
    for (let i = 0; i < lines.length; i++) {
      const e = parseLine(lines[i]);
      if (!e || !semanticOk(e, seen)) return { entries, corrupt: true, badLine: i + 1 };
      entries.push(e);
      seen.n++;
    }
    return { entries, corrupt: false, badLine: null };
  }

  function append(fields) {
    const line = encode(fields);
    const fd = fs.openSync(file, 'a');
    try {
      fs.appendFileSync(fd, line + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return JSON.parse(line);
  }

  const withLock = (fn) => serialize(file, async () => {
    const release = await acquire();
    try { return await fn(); } finally { release(); }
  });

  return { file, lockPath, read, append, withLock };
}

module.exports = { createLedger, crcOf, LOCK_WAIT_MS, LOCK_STALE_MS };
