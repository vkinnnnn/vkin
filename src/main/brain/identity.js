// @ts-check
'use strict';
// Always-on identity card: who the user is, in at most ~1200 estimated tokens. Built only from brain records,
// corrections and the usage rules. No entry IDs, contact data or URLs ever appear in the text.
const { stripIds, dropContact } = require('../context');
const { estimateTokens } = require('../budget');
const { formatYm } = require('./records');

const MAX_TOKENS = 1200;

// Same filter as context.js contentRules (that helper is module-private there, and context.js is not to be modified).
function contentRules(md) {
  const m = /^### Content rules\s*$([\s\S]*?)(?=^### |(?![\s\S]))/m.exec(md);
  return (m ? m[1] : md).split(/\r?\n/).filter((l) => !/bullet bank|Strip all entry IDs|\b(?:EXP|PRJ|ACA|CERT)-\d{3}\b.*\bto\b.*\b(?:EXP|PRJ|ACA|CERT)-\d{3}/i.test(l)).join('\n').trim();
}

const DATE_RANGE = /\b(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* )?\d{4} to (?:(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* )?\d{4}|Present)\b/;

/** Cut at a word boundary, preferring the last comma once at least 40 chars in. */
function oneLine(s, max) {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const comma = head.lastIndexOf(', ');
  return (comma >= 40 ? head.slice(0, comma) : head.replace(/[\s,;:]+\S*$/, '')).trim();
}

function oneClause(text, max = 100) {
  const s = String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, '');
  return oneLine(s, max);
}

function whenOf(rec) {
  if (rec.fields && rec.fields.when) return rec.fields.when;
  return [formatYm(rec.effective_from), formatYm(rec.effective_to) || (rec.effective_from ? 'Present' : '')].filter(Boolean).join(' to ');
}

function byRecency(a, b) {
  const k = (r) => [r.confidence, r.effective_to || '', r.effective_from || ''];
  const [x, y] = [k(a), k(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? 1 : -1; // desc on all three
  return a.id < b.id ? -1 : 1;
}

function buildIdentityCard({ records: allRecords = [], corrections = [], usageRulesText = '' } = {}) {
  // Restricted or unapproved records never reach the always-on card.
  const records = allRecords.filter((r) => r.approved !== false && r.sensitivity !== 'restricted');
  const byId = new Map(records.map((r) => [r.id, r]));
  const ident = (kind) => records.filter((r) => r.type === 'identity' && r.fields && r.fields.kind === kind);
  /** @type {{section:string, text:string, pri:number, ids:string[]}[]} */
  const items = [];
  const push = (section, text, pri, ids) => { if (text) items.push({ section, text, pri, ids }); };

  const name = ident('name')[0];
  if (name) push('Name', name.text, 0, [name.id]);

  ident('degree').forEach((d, i) => push('Degrees', d.text, 1 + i * 0.01, [d.id]));

  const corrFor = (parentId) => corrections.filter((c) => parentId && c.supersedes === parentId && DATE_RANGE.test(c.text || ''));
  const roles = ident('role');
  roles.forEach((r, i) => {
    const f = r.fields;
    const parent = f.parent_id ? byId.get(f.parent_id) : null;
    const c = corrFor(f.parent_id).sort((a, b) => b.version - a.version)[0];
    const when = c ? DATE_RANGE.exec(c.text)[0] : whenOf(r);
    const venture = f.unlisted || (parent && parent.evidence === 'listed-only');
    const lead = [f.role, f.org].filter(Boolean).join(', ');
    const text = venture
      ? `${lead}, ${when}: self-directed unpaid venture, mention only if asked`
      : `${lead}${f.place ? `, ${f.place}` : ''}, ${when}${f.note ? ` (${f.note})` : ''}`;
    push('Roles', text, 2 + i * 0.01, c ? [r.id, c.id] : [r.id]);
  });
  if (!roles.length) {
    records.filter((r) => /^EXP-/.test(r.id)).forEach((r, i) => {
      const venture = r.evidence === 'listed-only';
      const lead = r.title.replace(/:\s*/, ', ');
      push('Roles', venture ? `${lead}, ${whenOf(r)}: self-directed unpaid venture, mention only if asked` : `${lead}, ${whenOf(r)}`, 2 + i * 0.01, [r.id]);
    });
  }

  const rules = [];
  corrections.forEach((c, i) => push('Rules', String(c.text || '').replace(/\s+/g, ' ').trim(), 4 + i * 0.001, [c.id]));
  contentRules(usageRulesText).split(/\r?\n/).map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean)
    .forEach((l, i) => rules.push({ text: l, pri: 8 + i * 0.001 }));
  rules.forEach((r) => push('Rules', r.text, r.pri, []));

  const cert = records.filter((r) => /^CERT-/.test(r.id) && r.evidence === 'certification').sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  if (cert) {
    const f = cert.fields || {};
    push('Certification', `${f.Name || cert.title}${f.Date ? ` (${f.Date})` : ''}`, 5, [cert.id]);
  }

  ident('target').forEach((t, i) => push('Target roles', oneLine(t.text, 140), 7 + i * 0.01, [t.id]));

  records.filter((r) => /^PRJ-/.test(r.id) && r.type === 'experience').sort(byRecency).slice(0, 5).forEach((p, i) => {
    const clause = oneClause((p.fields && p.fields.Summary) || p.text);
    const tail = p.evidence === 'evaluated' ? ' (evaluation on public or synthetic data)' : '';
    push('Projects', `${p.title}${clause ? ` - ${clause}` : ''}${tail}`, 6 + i * 0.1, [p.id]);
  });

  const SECTIONS = ['Name', 'Degrees', 'Roles', 'Certification', 'Projects', 'Target roles', 'Rules'];
  const render = (list) => {
    const out = [];
    for (const s of SECTIONS) {
      const rows = list.filter((x) => x.section === s);
      if (!rows.length) continue;
      if (s === 'Name') out.push(`Name: ${rows[0].text}`);
      else if (s === 'Certification') out.push(`Certification: ${rows[0].text}`);
      else out.push(`${s}:`, ...rows.map((x) => `- ${x.text}`));
    }
    return dropContact(stripIds(out.join('\n'))).replace(/\n{3,}/g, '\n\n').trim();
  };

  let kept = items.slice();
  let text = render(kept);
  // Trim the lowest-priority line (highest pri number; later lines first) until the card fits.
  while (estimateTokens(text) > MAX_TOKENS) {
    let worst = -1;
    kept.forEach((x, i) => { if (x.pri >= 4 && (worst < 0 || x.pri >= kept[worst].pri)) worst = i; });
    if (worst < 0) break; // only name, degrees and roles remain; never trimmed
    kept.splice(worst, 1);
    text = render(kept);
  }
  return { text, tokensEst: estimateTokens(text), sourceIds: [...new Set(kept.flatMap((x) => x.ids))] };
}

module.exports = { buildIdentityCard, MAX_TOKENS, contentRules };
