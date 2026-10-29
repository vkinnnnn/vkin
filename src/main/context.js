// @ts-check
'use strict';
// Profile context: chunking, retrieval and prompt building. Profile sources are read-only.
const fs = require('node:fs');
const path = require('node:path');
const MiniSearch = /** @type {any} */ (require('minisearch'));
const { compileRestricted } = require('./validate');

const ROOT = path.resolve(__dirname, '..', '..');
const ID = '(?:EXP|PRJ|ACA|CERT|VOL|AWD)-\\d{3}';
const LIST = `${ID}(?:\\s*(?:,|;|&|and)\\s*${ID})*`;
const RE = {
  src: /[ \t]*\[src:[^\]]*\]/gi,
  wrap: new RegExp(`[ \\t]*[(\\[]\\s*${LIST}\\s*[)\\]]`, 'g'),
  colonList: new RegExp(`[ \\t]*:[ \\t]*${LIST}(?=[ \\t]*$)`, 'gm'),
  lead: new RegExp(`\\b${ID}:[ \\t]*`, 'g'),
  bare: new RegExp(`\\b${LIST}\\b`, 'g'),
};
const STOP = new Set('a an and are as at be but by can did do does for from had has have how i in into is it its me my of on or our so than that the their them then there they this to was we were what when where which who why will with would you your tell about walk through'.split(' '));
const TAGS = /<\/?(?:meeting_notes|profile_evidence|untrusted_transcript|profile_overrides|usage_rules|quick_facts|candidate_brief)[^>]*>/gi;

/** Remove entry IDs and [src: ...] tags and tidy what is left behind. */
function stripIds(text) {
  return String(text ?? '')
    .replace(RE.src, '').replace(RE.wrap, '').replace(RE.colonList, '').replace(RE.lead, '').replace(RE.bare, '')
    .replace(/\(\s*,\s*/g, '(').replace(/,\s*\)/g, ')').replace(/\(\s*\)/g, '')
    .replace(/[ \t]+([,.;:!?)])/g, '$1').replace(/(\S)[ \t]{2,}/g, '$1 ').replace(/[ \t]+$/gm, '')
    .replace(/^\|.*$/gm, (l) => l.replace(/\|[ \t]*(?=\|)/g, '')); // drop table cells emptied by ID removal
}

/** Streaming-safe ID stripper for model output: push(delta) -> safe text, flush() -> remainder. */
function createIdFilter() {
  let buf = '', endsWs = true;
  const partial = /(?:^|[ \t\n])[([]?(?:E|EX|EXP|P|PR|PRJ|A|AC|ACA|AW|AWD|C|CE|CER|CERT|V|VO|VOL)?(?:-\d*)?[,:)\]]?$/;
  return {
    push(d) {
      buf += d;
      const open = buf.lastIndexOf('[');
      let cut = open >= 0 && buf.indexOf(']', open) < 0 && buf.length - open < 120 ? open : buf.length;
      const br = /[([][A-Z0-9\s,;&-]*$/.exec(buf.slice(0, cut));
      if (br && cut - br.index < 60) cut = br.index;
      const m = partial.exec(buf.slice(0, cut));
      if (m) cut = m.index + (/^[ \t\n]/.test(m[0]) ? 1 : 0);
      const seg = buf.slice(0, cut);
      let out = stripIds(seg) + /[ \t]*$/.exec(seg)[0]; // stripIds trims trailing blanks; keep them between deltas
      if (endsWs) out = out.replace(/^[ \t]+/, '');
      if (out) endsWs = /\s$/.test(out);
      buf = buf.slice(cut);
      return out;
    },
    flush() { const out = stripIds(buf); buf = ''; return endsWs ? out.replace(/^[ \t]+/, '') : out; },
  };
}

const est = (s) => Math.ceil(String(s).length / 4);
const clean = (s) => stripIds(s).replace(TAGS, ' ').replace(/[ \t]{2,}/g, ' ');

function evidenceOf(id, type) {
  const [pre, n] = [id.split('-')[0], Number(id.split('-')[1])];
  if (pre === 'EXP') return /venture/i.test(type) ? 'listed-only' : 'employment';
  if (pre === 'PRJ') return n >= 16 && n <= 21 ? 'evaluated' : 'built';
  return { ACA: 'coursework', CERT: 'certification', VOL: 'recognition', AWD: 'recognition' }[pre] || 'built';
}

function makeChunk({ id, title, section, type, body }) {
  const c = { id, title: stripIds(title).trim(), section, type: type || '', evidence: evidenceOf(id, type), text: stripIds(body).trim() };
  if (c.evidence === 'built' && /deployed/i.test(c.text)) c.deployed = true;
  return c;
}

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * config.profile.excludeRecords: names (literal, case-insensitive, whole word) whose profile entries, stories
 * and identity lines are left out entirely, so they are never retrieved or spoken. Empty list: nothing excluded.
 * @param {unknown} list
 * @returns {(text: string) => boolean}
 */
function excludeMatcher(list) {
  const terms = (Array.isArray(list) ? list : []).map((t) => String(t == null ? '' : t).trim()).filter(Boolean);
  if (!terms.length) return () => false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map((t) => escRe(t).replace(/\s+/g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
  return (text) => re.test(String(text ?? ''));
}

/**
 * One chunk per entry in sections 6-10, one per story bullet in section 13.
 * @param {string} src @param {{ exclude?: (text: string) => boolean }} [opts]
 */
function parseChunks(src, { exclude = () => false } = {}) {
  const raw = [];
  const entries = new Map();
  let sec = 0, secTitle = '', theme = '', cur = null;
  const close = () => { if (cur) raw.push(cur); cur = null; };
  for (const line of src.split(/\r?\n/)) {
    const h2 = /^## (\d+)\.\s*(.*)$/.exec(line);
    if (h2) { close(); sec = Number(h2[1]); secTitle = h2[2].trim(); theme = ''; continue; }
    const h3 = /^### (.*)$/.exec(line);
    if (h3) {
      close();
      const e = /^\[([A-Z]+-\d+)\]\s*(.*)$/.exec(h3[1]);
      if (e && sec >= 6 && sec <= 10) cur = { id: e[1], title: e[2], section: secTitle, lines: [], story: false };
      else theme = h3[1].trim();
      continue;
    }
    if (sec === 13) {
      const s = /^- \*\*([A-Z]+-\d+):\s*(.*?)\*\*\s*(.*)$/.exec(line);
      if (s) { close(); cur = { id: s[1], title: s[2], section: `${secTitle}: ${theme}`, lines: [s[3]], story: true }; continue; }
    }
    if (cur && !/^---+\s*$/.test(line)) cur.lines.push(line);
  }
  close();
  const chunks = [];
  let excluded = 0;
  for (const r of raw) {
    const body = r.lines.join('\n');
    if (exclude(`${r.title}\n${body}`)) { excluded++; continue; }
    const type = r.story ? (entries.get(r.id)?.type || '') : (/^\*\*Type:\*\*\s*(.*)$/m.exec(body)?.[1] || '').trim();
    const parent = r.story ? entries.get(r.id) : null;
    const c = makeChunk({ id: r.id, title: r.title, section: r.section, type, body: parent ? `Project: ${parent.title}. ${body}` : body });
    if (!r.story) entries.set(r.id, { type: c.type, title: c.title });
    chunks.push(c);
  }
  return { chunks, excluded };
}

function loadProfileFile(readFile, p, replacements, optional) {
  let t;
  try { t = readFile(p); } catch (e) {
    if (optional && e.code === 'ENOENT') return '';
    throw new Error(`Cannot read profile file ${p}: ${e.message}`);
  }
  for (const { find, replace } of replacements) if (find) t = t.split(find).join(replace ?? '');
  return t;
}

// Overlay quick chips -> explicit rewrite instructions (plain-word requests were applied too weakly).
const REFINE_PRESETS = {
  shorter: 'Shorter: SAY must be 1 to 2 sentences and under 35 words. Keep only the single most important point.',
  'more detail': 'More detail: SAY may be 4 to 5 sentences; add one more concrete detail from the evidence (tool, decision or result). No new facts beyond the evidence.',
  'add an example': 'Add an example: work in one specific example from the evidence (a concrete situation, decision or result) as the second sentence.',
  'simpler words': 'Simpler words: say it in plain everyday language a non-technical person follows; replace jargon and acronyms.',
  'ask them a question back': 'Ask a question back: keep my answer to one or two sentences, then end SAY with one short, natural question back to them related to their team, role or problem.',
};

// Contact details are never needed for spoken answers, so they are not sent to the LLM provider.
const CONTACT_LABEL = /^\s*[-*]\s*(email|phone|linkedin|github|portfolio|tableau public|databricks credentials? wallet|website)\s*:/i;
const CONTACT_INLINE = /https?:\/\/\S+|\bwww\.\S+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b|\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b|\b(?:github|linkedin)\.com\/\S+/gi;
function dropContact(text) {
  const out = [];
  let inContact = false;
  for (const line of String(text).split('\n')) {
    if (/^#{2,4}\s/.test(line)) inContact = /^#{2,4}\s*Contact\b/i.test(line);
    if (inContact || CONTACT_LABEL.test(line)) continue;
    out.push(line.replace(CONTACT_INLINE, '').replace(/[ \t]*[;,][ \t]*$/, '').replace(/[ \t]{2,}/g, ' '));
  }
  return out.join('\n');
}

function contentRules(md) {
  const m = /^### Content rules\s*$([\s\S]*?)(?=^### |(?![\s\S]))/m.exec(md);
  // Drop lines that only make sense on a resume or whose meaning depends on entry IDs.
  return (m ? m[1] : md).split(/\r?\n/).filter((l) => !/bullet bank|Strip all entry IDs|\b(?:EXP|PRJ|ACA|CERT)-\d{3}\b.*\bto\b.*\b(?:EXP|PRJ|ACA|CERT)-\d{3}/i.test(l)).join('\n').trim();
}

function createContext(config, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const pc = config.profile;
  const rep = pc.replacements || [];
  const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(ROOT, p));
  const load = (p, optional) => {
    const t = loadProfileFile(readFile, abs(p), rep, optional);
    return pc.dropContact === false ? t : dropContact(t);
  };

  const { chunks, excluded } = parseChunks(load(pc.careerPro), { exclude: excludeMatcher(pc.excludeRecords) });
  const uidOf = (c, i) => `${c.id}#${i}`;
  const byUid = new Map(chunks.map((c, i) => [uidOf(c, i), c]));
  const index = new MiniSearch({
    idField: 'uid', fields: ['title', 'text', 'type'],
    processTerm: (t) => { t = t.toLowerCase(); return STOP.has(t) ? null : t; },
    searchOptions: { boost: { title: 2 }, prefix: true, fuzzy: 0.2 },
  });
  index.addAll(chunks.map((c, i) => ({ uid: uidOf(c, i), title: c.title, text: c.text, type: c.type })));

  const section = (tag, body) => `<${tag}>\n${stripIds(body).trim()}\n</${tag}>`;
  const parts = (pc.alwaysParts || []).map((f) => {
    const t = load(path.join(pc.partsDir, f));
    return /usage_rules/i.test(f) ? ['usage_rules', contentRules(t)] : [f.replace(/\.md$/i, ''), t];
  });
  const named = Object.fromEntries(parts);
  // This path has no validator, so the profile's own restrictions (config.profile.restrictedClaims) are given to
  // the model as presentation rules.
  const restrictions = compileRestricted(pc.restrictedClaims).map((f) => f.reason).filter(Boolean).map((r) => `- Restriction: ${r}`);
  const usageRules = [named.usage_rules || '', ...restrictions].filter(Boolean).join('\n');
  const systemPrompt = [
    // The prompt names the user with {{USER_NAME}} (config.profile.displayName, else "the user").
    stripIds(loadProfileFile(readFile, path.join(__dirname, 'prompt.md'), [{ find: '{{USER_NAME}}', replace: String(pc.displayName || '').trim() || 'the user' }]).trim()),
    section('profile_overrides', load(pc.overrides, true)),
    section('usage_rules', usageRules),
    section('quick_facts', named.quick_facts || ''),
    section('candidate_brief', load(pc.brief)),
  ].join('\n\n');

  function retrieve(query, budgetTokens = pc.retrievalTokenBudget || 3000) {
    const out = [], perId = {};
    let used = 0;
    for (const h of index.search(String(query || ''))) {
      if (out.length >= 5) break;
      const c = byUid.get(h.id);
      if ((perId[c.id] || 0) >= 2) continue;
      const cost = est(c.title) + est(c.text);
      if (used + cost > budgetTokens) {
        if (out.length) continue;
        out.push({ ...c, text: c.text.slice(0, Math.max(0, budgetTokens * 4 - c.title.length)) });
        used = budgetTokens; perId[c.id] = 1; continue;
      }
      out.push(c); used += cost; perId[c.id] = (perId[c.id] || 0) + 1;
    }
    return out;
  }

  /** history: [{channel:'them'|'me', text}] oldest first (speaker/role also accepted). */
  // request: something the user typed privately in the overlay chat (never said by the other person).
  // previousAnswer: the suggestion being refined, when the request is a rewrite ("shorter", "add an example").
  function buildMessages({ question, history = [], meetingNotes = '', request = '', previousAnswer = '' }) {
    const q = clean(question || '').trim();
    const raw = clean(request).trim().slice(0, 1000);
    const req = REFINE_PRESETS[raw.toLowerCase()] || raw;
    const prev = clean(previousAnswer).trim().slice(0, 2000);
    const turns = history.slice(-(pc.historyTurns || 8)).map((h) => ({ who: String(h.channel || h.speaker || h.role).toLowerCase() === 'me' ? 'ME' : 'THEM', text: clean(h.text).trim() })).filter((t) => t.text);
    const lastThem = [...turns].reverse().find((t) => t.who === 'THEM')?.text;
    const query = [req, q, lastThem && lastThem !== q ? lastThem : ''].filter(Boolean).join(' ');
    let ask = `The other person just said: "${q}". Write what I should say next.`;
    if (req && prev) {
      const about = q ? `The other person asked: "${q}".` : 'This suggestion answered a private question I typed earlier.';
      ask = `${about} The current suggestion is:\n${prev}\n\nI typed this private request to you (the other person did not say it): "${req}". Rewrite the suggestion accordingly, same SAY/POINTS format, same grounding rules.`;
    } else if (req && q) {
      ask = `The other person asked: "${q}". I typed this private request to you (the other person did not say it): "${req}". Write what I should say next, applying the request, same SAY/POINTS format.`;
    } else if (req) {
      ask = `I typed this private question to you during the call (the other person did not say it): "${req}". Help me with it for this conversation. If it is something I should say out loud, use the SAY/POINTS format; otherwise answer briefly. Same grounding rules.`;
    }
    const ev = retrieve(query).map((c) => `[evidence: ${c.evidence}] ${c.title}\n${c.text}`).join('\n\n') || '(none)';
    const notes = clean(meetingNotes).trim().slice(0, 4000) || '(none)';
    const content = [
      `<meeting_notes>\n${notes}\n</meeting_notes>`,
      `<profile_evidence>\n${ev}\n</profile_evidence>`,
      `<untrusted_transcript>\n${turns.map((t) => `${t.who}: ${t.text}`).join('\n') || '(none)'}\n</untrusted_transcript>`,
      ask,
    ].join('\n\n');
    return [{ role: 'system', content: systemPrompt }, { role: 'user', content }];
  }

  const byEvidence = {};
  for (const c of chunks) byEvidence[c.evidence] = (byEvidence[c.evidence] || 0) + 1;
  return { systemPrompt, retrieve, buildMessages, stats: { chunks: chunks.length, excluded, systemPromptChars: systemPrompt.length, byEvidence } };
}

module.exports = { createContext, stripIds, createIdFilter, parseChunks, excludeMatcher, evidenceOf, dropContact, contentRules };
