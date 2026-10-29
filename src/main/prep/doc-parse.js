// @ts-check
'use strict';
// Local document parsing for the prep window (PRD Phase 3). Everything runs on this machine; nothing
// is uploaded. Imported text is untrusted data: it only ever becomes meeting-pack records, which the
// engine wraps as sources and the validator checks like any other evidence.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 50 * 1024 * 1024;

const SUPPORTED = Object.freeze(['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm', '.docx', '.pdf']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// JSON: keep the human-readable strings ("key: value" lines), drop structure noise.
function jsonToText(raw) {
  const data = JSON.parse(raw);
  const lines = [];
  const walk = (v, key) => {
    if (lines.length > 20000) return;
    if (typeof v === 'string') { if (v.trim()) lines.push(key ? `${key}: ${v.trim()}` : v.trim()); }
    else if (typeof v === 'number' || typeof v === 'boolean') { if (key) lines.push(`${key}: ${v}`); }
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) if (!/^(id|_id|uuid|url|href|src)$/i.test(k)) walk(x, k);
      lines.push('');
    }
  };
  walk(data, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Minimal zip reader (stored + deflate) for .docx. Returns the named entry or null. */
function readZipEntry(buf, wanted) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== wanted) continue;
    if (size > MAX_UNZIPPED_BYTES) throw new Error(`${wanted} is too large`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('corrupt zip local header');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED_BYTES });
    throw new Error(`unsupported zip compression method ${method}`);
  }
  return null;
}

function docxToText(buf) {
  const xml = readZipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('not a Word document (word/document.xml missing)');
  const paras = xml.toString('utf8').split(/<\/w:p>/);
  const out = [];
  for (const p of paras) {
    const heading = /<w:pStyle w:val="(?:Heading|Title)(\d?)"/i.exec(p);
    const parts = [];
    const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g;
    let m;
    while ((m = re.exec(p))) parts.push(m[1] !== undefined ? m[1] : m[0] === '<w:tab/>' ? '\t' : '\n');
    const t = decodeEntities(parts.join('')).trim();
    if (!t) { out.push(''); continue; }
    out.push(heading ? `${'#'.repeat(Number(heading[1]) || 1)} ${t}` : t);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function pdfToText(buf) {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (err) {
    throw new Error(`PDF support is not installed (pdfjs-dist): ${err && err.message}`);
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      const lines = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) { lines.push(line); line = ''; } else if (item.str && !/\s$/.test(item.str)) line += ' ';
      }
      if (line.trim()) lines.push(line);
      pages.push(lines.map((l) => l.replace(/\s+/g, ' ').trim()).join('\n'));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  // Re-join lines that a PDF wrapped mid-sentence; keep blank lines between paragraphs.
  const text = pages.join('\n\n').replace(/([a-z,;])\n(?=[a-z])/g, '$1 ');
  return { text, pages: pages.length };
}

/**
 * @param {string} filePath
 * @param {{ readFile?: (p: string) => Promise<Buffer>, stat?: (p: string) => Promise<{ size: number }> }} [deps]
 * @returns {Promise<{ text: string, format: string, pages: number|null, chars: number, truncated: boolean, warnings: string[] }>}
 */
async function parseDocument(filePath, deps = {}) {
  const readFile = deps.readFile || ((p) => fs.promises.readFile(p));
  const stat = deps.stat || ((p) => fs.promises.stat(p));
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED.includes(ext)) throw new Error(`unsupported file type ${ext || '(none)'}; supported: ${SUPPORTED.join(' ')}`);
  const { size } = await stat(filePath);
  if (size > MAX_FILE_BYTES) throw new Error(`file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  const buf = await readFile(filePath);
  const warnings = [];
  let text = '';
  let pages = null;
  const utf8 = () => buf.toString('utf8').replace(/^\uFEFF/, '');
  if (ext === '.pdf') ({ text, pages } = await pdfToText(buf));
  else if (ext === '.docx') text = docxToText(buf);
  else if (ext === '.html' || ext === '.htm') text = htmlToText(utf8());
  else if (ext === '.json') text = jsonToText(utf8());
  else text = utf8();
  // eslint-disable-next-line no-control-regex -- strip control characters from extracted text
  text = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  if (ext === '.pdf' && text.length < 40 * (pages || 1)) warnings.push('very little text found; this PDF may be scanned images (OCR is not applied to documents)');
  let truncated = false;
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    truncated = true;
    warnings.push('text was truncated to the first 2 MB');
  }
  if (!text) warnings.push('no text found');
  return { text, format: ext.slice(1), pages, chars: text.length, truncated, warnings };
}

module.exports = { parseDocument, readZipEntry, docxToText, htmlToText, jsonToText, decodeEntities, SUPPORTED };
