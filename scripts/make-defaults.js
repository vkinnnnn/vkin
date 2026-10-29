// @ts-check
'use strict';
// Builds defaults/ — the neutral files a packaged Vkin build ships and seeds into a new user's data folder.
// Personal fields (career profile paths, keyterms, the active meeting pack, overrides) are blanked so an
// installer never carries the developer's profile. Run before `npm run dist` (wired as predist).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'defaults');

/**
 * @param {any} config
 * @param {{ apiUrl?: string, supabaseUrl?: string, supabaseAnonKey?: string }} [pub] public endpoints baked into installers
 */
function neutralConfig(config, pub = {}) {
  const c = JSON.parse(JSON.stringify(config));
  // Installed builds have no .env: they use the hosted Vkin server and the public Supabase project
  // (anon key only; it is designed to be public and every table is protected by RLS).
  c.hosted = { enabled: true, apiUrl: pub.apiUrl || '' };
  c.vkin = { supabaseUrl: pub.supabaseUrl || '', supabaseAnonKey: pub.supabaseAnonKey || '' };
  c.stt.keyterms = [];
  c.profile = {
    ...c.profile,
    displayName: '',
    careerPro: '',
    partsDir: '',
    alwaysParts: [],
    brief: '',
    replacements: [],
    restrictedClaims: [],
    correctionAliases: [],
    excludeRecords: [],
  };
  c.meeting = { ...c.meeting, enabled: false, profile: '' };
  c.ui = { ...(c.ui || {}), openPrepOnStart: true };
  return c;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  require('dotenv').config({ path: path.join(ROOT, '.env'), override: false });
  const env = process.env;
  const pub = { apiUrl: env.VKIN_PUBLIC_API_URL || '', supabaseUrl: env.VKIN_SUPABASE_URL || '', supabaseAnonKey: env.VKIN_SUPABASE_ANON_KEY || '' };
  // Refuse to bake anything but a public key or an https endpoint into an installer.
  const { checkApiUrl } = require('../src/main/hosted');
  pub.apiUrl = checkApiUrl(pub.apiUrl);
  if (pub.supabaseUrl || pub.supabaseAnonKey) {
    const { configFromEnv } = require('../src/main/vkin/auth');
    const cloud = configFromEnv({ VKIN_SUPABASE_URL: pub.supabaseUrl, VKIN_SUPABASE_ANON_KEY: pub.supabaseAnonKey });
    if (!cloud.configured) throw new Error(`refusing to package Supabase settings: ${/** @type {any} */ (cloud).reason}`);
  }
  if (!pub.apiUrl) console.warn('WARNING: VKIN_PUBLIC_API_URL is not set; the installer will not reach the Vkin server.');
  fs.writeFileSync(path.join(OUT, 'config.json'), `${JSON.stringify(neutralConfig(config, pub), null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'profile_overrides.md'), '# Profile overrides (facts you confirmed; these win over anything else in your profile)\n');
  fs.copyFileSync(path.join(ROOT, 'meeting.md'), path.join(OUT, 'meeting.md'));
  console.log(`defaults written to ${OUT}`);
}

if (require.main === module) main();
module.exports = { neutralConfig };
