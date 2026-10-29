// @ts-check
'use strict';
// Locates and loads the native audio addon (native/fabel-audio). A missing or broken addon is a
// normal condition, not an error: the caller keeps the renderer capture path.
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..', '..');

/** Candidate locations: packaged app resources first, then the local dev build. */
function candidates(resourcesPath = /** @type {any} */ (process).resourcesPath) {
  const list = [];
  if (resourcesPath) list.push(path.join(resourcesPath, 'native', 'fabel_audio.node'));
  list.push(path.join(ROOT, 'native', 'fabel-audio', 'build', 'Release', 'fabel_audio.node'));
  return list;
}

/**
 * @param {{ requireFn?: (p: string) => any, exists?: (p: string) => boolean, platform?: string, resourcesPath?: string }} [deps]
 * @returns {{ addon: any, path: string, error: string }}
 */
function loadNativeAudio(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') return { addon: null, path: '', error: `native audio is Windows-only for now (${platform})` };
  const requireFn = deps.requireFn || require;
  const exists = deps.exists || fs.existsSync;
  const found = candidates(deps.resourcesPath).find((p) => exists(p));
  if (!found) return { addon: null, path: '', error: 'native audio addon not built (npm run build:native)' };
  try {
    const addon = requireFn(found);
    if (!addon || typeof addon.available !== 'function' || !addon.available()) return { addon: null, path: found, error: 'native audio addon unavailable on this platform' };
    return { addon, path: found, error: '' };
  } catch (err) {
    return { addon: null, path: found, error: `native audio addon failed to load: ${err && err.message}` };
  }
}

module.exports = { loadNativeAudio, candidates };
