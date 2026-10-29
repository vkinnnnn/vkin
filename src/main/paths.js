// @ts-check
'use strict';
// Where the app reads code assets and where it writes data (PRD Phase 6 packaging).
//   dev:      both are the repository root (unchanged behaviour)
//   packaged: code assets come from the read-only app bundle; config.json, .env, data/, meeting-packs/,
//             notes and transcripts live in the per-user data folder, seeded on first run.
const fs = require('node:fs');
const path = require('node:path');

// Copied from the bundle into the data folder once (never overwritten: they become the user's files).
const SEED_FILES = Object.freeze(['config.json', 'meeting.md', 'profile_overrides.md', '.env.example']);

/**
 * @param {{ appRoot: string, packaged: boolean, userData?: string|null }} p
 * @returns {{ packaged: boolean, appRoot: string, dataRoot: string, asset: (rel: string) => string }}
 */
function resolvePaths({ appRoot, packaged, userData = null }) {
  const dataRoot = packaged && userData ? userData : appRoot;
  // A relative path resolves in the data folder when the user has their own copy there, else in the bundle.
  const asset = (rel) => {
    if (!rel || path.isAbsolute(rel)) return rel;
    const own = path.join(dataRoot, rel);
    return fs.existsSync(own) ? own : path.join(appRoot, rel);
  };
  return { packaged, appRoot, dataRoot, asset };
}

/** First packaged run: copy the default files into the data folder. Returns the names copied. */
function seedDataRoot({ appRoot, dataRoot, packaged }) {
  if (!packaged || appRoot === dataRoot) return [];
  fs.mkdirSync(dataRoot, { recursive: true });
  const copied = [];
  for (const f of SEED_FILES) {
    const src = path.join(appRoot, f);
    const dst = path.join(dataRoot, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      copied.push(f);
    }
  }
  return copied;
}

module.exports = { resolvePaths, seedDataRoot, SEED_FILES };
