'use strict';
// Configuration regressions that are not reachable through the HTTP surface.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('M6: provider SDK clients never retry (no double billing)', () => {
  const src = read('src', 'index.js');
  assert.match(src, /maxRetries:\s*0/);
  assert.doesNotMatch(src, /maxRetries:\s*[1-9]/);
});

test('Minor 3: request and header timeouts are set', () => {
  const src = read('src', 'index.js');
  assert.match(src, /server\.requestTimeout\s*=\s*30_000/);
  assert.match(src, /server\.headersTimeout\s*=\s*15_000/);
});

test('Minor 5: render.yaml pins one instance and NODE_ENV=production; new caps listed', () => {
  const y = read('render.yaml');
  assert.match(y, /numInstances:\s*1/);
  assert.match(y, /key: NODE_ENV\s*\n\s*value: production/);
  for (const k of ['NEBIUS_USER_CAP_USD', 'GEMINI_DAILY_REQUEST_CAP', 'GEMINI_USER_DAILY_CAP']) assert.match(y, new RegExp(`key: ${k}`));
});

test('Minor 1: trial eligibility is confirmed email or a Google/GitHub identity only', () => {
  const sql = read('..', 'supabase', 'migrations', '0002_vkin_entitlements.sql');
  assert.match(sql, /i\.provider in \('google', 'github'\)/);
  assert.doesNotMatch(sql, /provider <> 'email'/);
});

test('Verification minor 1: no comment claims stale leases end without billing', () => {
  for (const f of ['app.js', 'stt.js', 'chat.js', 'db.js']) {
    assert.doesNotMatch(read('src', f), /no (further )?billing/i, f);
  }
});
