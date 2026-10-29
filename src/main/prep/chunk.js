// @ts-check
'use strict';
// Turns parsed document text into meeting-pack records with provenance (document id, part number,
// character span, nearest heading). Contact data and URLs are removed: they never reach a model, and
// the record schema rejects them.

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const PHONE = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;
const URL = /\s*\(?(?:https?:\/\/|www\.)\S+\)?/gi;
const ENTRY_ID = /\b(?:PRJ|EXP|ACA|CERT|AWD|VOL)-\d{3}\b/g;

function scrub(text) {
  return String(text).replace(URL, '').replace(EMAIL, '[email]').replace(PHONE, '[phone]').replace(ENTRY_ID, '');
}

function isHeading(line) {
  const l = line.trim();
  if (/^#{1,6}\s+\S/.test(l)) return true;
  // Short title-like line with no closing punctuation ("Research Interests", "EXPERIENCE").
  return l.length >= 3 && l.length <= 70 && !/[.!?,;:]$/.test(l) && /^[A-Z0-9]/.test(l) && l.split(/\s+/).length <= 8
    && (l === l.toUpperCase() || l.split(/\s+/).filter((w) => /^[A-Z0-9]/.test(w)).length >= Math.ceil(l.split(/\s+/).length * 0.6));
}

function splitSentences(p, maxChars) {
  const out = [];
  let cur = '';
  for (const s of p.split(/(?<=[.!?])\s+/)) {
    if (cur && cur.length + s.length + 1 > maxChars) { out.push(cur); cur = ''; }
    cur = cur ? `${cur} ${s}` : s;
    while (cur.length > maxChars) { out.push(cur.slice(0, maxChars)); cur = cur.slice(maxChars); }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Paragraph-aware chunks of about maxChars, each with its character span and nearest heading.
 * @param {string} text
 * @param {{ maxChars?: number }} [opts]
 * @returns {{ text: string, start: number, end: number, heading: string }[]}
 */
function chunkText(text, { maxChars = 900 } = {}) {
  const src = String(text || '');
  const paras = [];
  const re = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g; // blocks separated by blank lines
  let m;
  while ((m = re.exec(src))) paras.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  const chunks = [];
  let heading = '';
  let cur = null;
  const flush = () => { if (cur && cur.text.trim()) chunks.push(cur); cur = null; };
  for (const p of paras) {
    const firstLine = p.text.split('\n')[0];
    if (isHeading(firstLine)) {
      flush();
      heading = firstLine.replace(/^#{1,6}\s+/, '').trim();
      const rest = p.text.slice(firstLine.length).trim();
      if (!rest) continue;
      p.text = rest;
    }
    const body = p.text.replace(/\s*\n\s*/g, ' ').trim();
    if (body.length > maxChars) {
      flush();
      for (const piece of splitSentences(body, maxChars)) chunks.push({ text: piece, start: p.start, end: p.end, heading });
      continue;
    }
    if (cur && cur.text.length + body.length + 1 > maxChars) flush();
    if (!cur) cur = { text: body, start: p.start, end: p.end, heading };
    else { cur.text = `${cur.text}\n${body}`; cur.end = p.end; }
  }
  flush();
  return chunks;
}

const STOP = new Set('The This That These Those There Their They When Where What Which While With From Into About After Before During Our We I You He She It A An And But Or For In On At By Of To As Is Are Was Were Be Been Has Have Had Do Does Did Not No Yes If Then So Also Each Both Such Many Most Some Any All'.split(' '));

/** A few likely entities (acronyms and repeated capitalised names) to help keyword retrieval. */
function extractEntities(text, max = 8) {
  const counts = new Map();
  const add = (e, w = 1) => counts.set(e, (counts.get(e) || 0) + w);
  for (const a of String(text).match(/\b[A-Z][A-Z0-9&]{1,7}\b/g) || []) if (!/^(I|A|AM|PM|OK|THE|AND)$/.test(a)) add(a, 2);
  for (const m of String(text).matchAll(/(?<![.!?]\s)(?<!^)\b([A-Z][a-z][\w-]+(?:\s+[A-Z][a-z][\w-]+){0,3})/gm)) {
    const e = m[1].split(/\s+/).filter((w) => !STOP.has(w)).join(' ');
    if (e.length >= 3) add(e);
  }
  return [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, max).map(([e]) => e);
}

/** Line lookup for source spans: newline offsets computed once, then a binary search per offset (linear overall). */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * @param {string} text parsed document text
 * @param {{ docId: string, docName: string, kind: string, side: 'me'|'them', approved?: boolean, maxChars?: number }} o
 */
function toPackRecords(text, o) {
  const chunks = chunkText(text, { maxChars: o.maxChars || 900 });
  const lineOf = lineIndex(text);
  return chunks.map((c, i) => {
    const body = scrub(c.text).replace(/[ \t]+/g, ' ').trim();
    const title = scrub(c.heading ? `${o.docName}: ${c.heading}` : `${o.docName} (part ${i + 1})`).slice(0, 120);
    return {
      id: `DOC-${o.docId}-${String(i + 1).padStart(3, '0')}`,
      kind: o.kind,
      title,
      text: body,
      source: o.docName,
      entities: extractEntities(body),
      tags: ['imported', o.side === 'me' ? 'about_me' : 'about_them'],
      approved: o.approved !== false,
      span: `L${lineOf(c.start)}-L${lineOf(c.end)}`,
    };
  }).filter((r) => r.text.length >= 20);
}

module.exports = { chunkText, toPackRecords, extractEntities, scrub, isHeading };
