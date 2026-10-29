// @ts-check
'use strict';
// Renderer trust: IPC and permissions are honoured only for the exact bundled page a window is meant
// to show (a dropped or navigated-to file can never inherit a window's privileges).
const path = require('node:path');
const { fileURLToPath } = require('node:url');

/** True when `url` is the file:// URL of `file` inside rendererDir (case-insensitive on Windows paths). */
function isPage(url, file, rendererDir) {
  try {
    if (!/^file:\/\//i.test(String(url || ''))) return false;
    return path.normalize(fileURLToPath(String(url))).toLowerCase() === path.join(rendererDir, file).toLowerCase();
  } catch {
    return false;
  }
}

module.exports = { isPage };
