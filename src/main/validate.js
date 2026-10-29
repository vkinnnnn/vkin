// @ts-check
'use strict';
// Deterministic grounding check. No LLM is the authority on facts.
// Personal claims (numbers, dates, spoken numbers, ratios, named entities) in first-person sentences, or in
// sentences naming something from the profile, must appear in the retrieved evidence / identity card /
// corrections, or in what the other person said. General-knowledge sentences are not checked.

const MONTHS = { jan: 'jan', january: 'jan', feb: 'feb', february: 'feb', mar: 'mar', march: 'mar', apr: 'apr', april: 'apr', may: 'may', jun: 'jun', june: 'jun', jul: 'jul', july: 'jul', aug: 'aug', august: 'aug', sep: 'sep', sept: 'sep', september: 'sep', oct: 'oct', october: 'oct', nov: 'nov', nov_: 'nov', november: 'nov', dec: 'dec', december: 'dec' };
const STOP = new Set(('I Im Ive Id Ill Yeah Yes No So Sure Well Honestly Basically Actually Okay Ok Right Great Thanks Thank Hi Hello Absolutely Definitely Totally Also And But Or Then That This These Those There Here It Its We Our My Me You Your They Their He She His Her The A An In On At For From With Without By Of To As If When While Because Since After Before During Once One Two Three First Second Third Next Last Finally Overall Plus What Why How Which Who Where Both Each Every Most Many Some SAY POINTS ' +
  'Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April June July August September October November December Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec ' +
  'AI ML LLM LLMs RAG API APIs SQL ETL KPI KPIs UI UX QA PR CI CD OK').split(/\s+/));


// Descriptive words that commonly appear inside capitalised phrases; not themselves claims.
const GENERIC = new Set(['level', 'wide', 'specific', 'related', 'scale', 'powered', 'based', 'driven', 'self', 'taught', 'built', 'tool', 'tools', 'app', 'system', 'pipeline', 'project', 'team', 'data', 'model', 'models', 'front', 'end', 'back', 'variant', 'cluster', 'agent', 'agents', 'assistant', 'bi', 'genai', 'gen', 'ai', 'ml', 'llm', 'rag', 'api', 'sql', 'etl', 'ui', 'ux']);

// Units that turn a small spoken number into a claim ("three years", "two sites"); casual durations ("two weeks") and "two teams" are not.
const UNIT_WORDS = new Set(['years', 'year', 'months', 'people', 'engineers', 'analysts', 'sites', 'plants', 'users', 'customers', 'clients', 'percent', 'times', 'countries', 'brands', 'stores', 'regions', 'vendors']);
// Outcome claims that must be stated by the evidence (families of word stems).
const OUTCOMES = [
  { re: /\bapprov(ed|al|ing)\b/i, stems: ['approv'] },
  { re: /\bexpan(d|ded|ding|sion)\b/i, stems: ['expan'] },
  { re: /\broll(ed|ing)? (it )?out\b|\brollout\b/i, stems: ['roll out', 'rolled out', 'rollout'] },
  { re: /\badopt(ed|ion)\b/i, stems: ['adopt'] },
  { re: /\bpromot(ed|ion)\b/i, stems: ['promot'] },
  { re: /\bacross (more|other|all|multiple|several) (sites|plants|teams|regions|vendors|stores|countries|brands)\b/i, stems: ['across'] },
  // Mock-interview review 2026-10-23: invented acceptance, schedule and leadership outcomes.
  { re: /\baccept(ed|ance)\b/i, stems: ['accept'] },
  { re: /\b(on schedule|on time|ahead of schedule|under budget)\b/i, stems: ['on schedule', 'on time', 'ahead of schedule', 'under budget'] },
  { re: /\btook (charge|ownership) of\b|\bI led (the|our) (team|project|sprints?|group)\b|\b(team|project) lead\b/i, stems: ['took charge', 'took ownership', 'led the team', 'led the project', 'team lead', 'project lead'] },
  { re: /\bwithout (any )?rework\b|\bran (clean|smoothly)\b/i, stems: ['rework', 'ran clean', 'ran smoothly'] },
  // What someone else asked for, a team he ran, a time cut "to minutes", a "single warehouse/schema".
  { re: /\b(?:the |our |my )?(?:sponsor|client|manager|stakeholders?|customer|professor)s? (?:asked|requested|wanted)\b/i, stems: ['asked', 'requested', 'wanted'], narrative: true },
  { re: /\bI (?:coordinated|managed|organized|ran|directed) (?:a |the |our )?(?:[\w-]+ ){0,2}(?:team|group|squad)\b/i, stems: ['coordinated the team', 'managed the team', 'led the team', 'team lead'] },
  { re: /\b(?:to|in|within|down to) (?:a few |mere |just )?(?:minutes|seconds)\b/i, stems: ['minutes', 'seconds'] },
  { re: /\b(?:a|one|single) (?:central |unified |single )?(?:data )?(?:warehouse|schema)\b/i, stems: ['warehouse', 'schema'] },
];

const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };
const RATIOS = [
  { re: /\b(half|halved|cut in half)\b/i, key: 'half', equiv: ['half', 'halved', '50%', '50 percent'] },
  { re: /\b(doubled|twice|two times|2x)\b/i, key: 'double', equiv: ['double', 'doubled', 'twice', '2x', 'two times', '100%'] },
  { re: /\b(tripled|three times|3x)\b/i, key: 'triple', equiv: ['triple', 'tripled', 'three times', '3x'] },
];

// Protections that hold for every user. Person-specific restrictions come from config.profile.restrictedClaims
// (see compileRestricted) and from the active copilot's restricted_claims.
const GENERIC_FORBIDDEN = [
  { re: /[\w.+-]+@[\w-]+\.[\w.]+|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|https?:\/\//i, reason: 'Contact details or URLs must not be spoken' },
  { re: /\b(?:PRJ|EXP|ACA|CERT|AWD|VOL)-\d{3}\b|\[src:/i, reason: 'Internal IDs leaked into the answer' },
  // Work authorization is only ever stated from an approved correction (supportKey must appear in the evidence).
  { re: /\b(?:(?:do not|don't|won't|will not|never) (?:require|need)(?: any)?(?: visa)? sponsorship|no (?:need for |)sponsorship|(?:permit|visa|authori[sz]ation|status)[^.]{0,30}valid (?:through|until) 20\d\d|foreseeable future|(?:i'?m|i am) (?:a )?(?:us |u\.s\. )?citizen|green card holder|permanent resident|fully authori[sz]ed|(?:my )?eligib(?:le|ility) to work|(?:i'?m|i am) authori[sz]ed to work)\b/i, supportKey: /authori[sz]|sponsor|visa|opt\b/, reason: 'Work-authorization statement not in an approved correction' },
  // Pay is only ever stated from an approved correction: a number the user "would accept" or "expects" is a negotiation.
  { re: /\b(?:I(?:'d| would|'ll| will)? (?:accept|take|settle for|need|want|require|expect|be (?:happy|fine|ok|okay) with)|I(?:'m| am) (?:looking for|asking for|expecting|targeting)|my (?:salary|pay|compensation|rate|number|target|ask|expectations?) (?:is|are|would be|will be|range is)|(?:salary|compensation|pay|rate) (?:expectation|requirement)s? (?:is|are|of))\b[^.!?]{0,50}(?:\$\s?\d[\d,.]*\s?k?\b|\b\d{2,3}(?:,\d{3})*\s?k\b|\b\d{5,}\b|\b\d[\d,.]*\s?(?:per|an?|\/) ?(?:hour|hr|year|yr|month)\b|\b\d+\s?(?:lpa|lakhs?|usd|dollars)\b)/i, supportKey: /salary|compensation|\bpay\b|\brate\b/, reason: 'Pay figure or acceptance not in an approved correction' },
];

// No person-specific rules are built in. Each profile lists its own in config.profile.restrictedClaims (see
// compileRestricted); createEngine() composes them with GENERIC_FORBIDDEN. Kept as an empty export so older
// imports keep working.
/** @type {any[]} */
const LEGACY_PROFILE_FORBIDDEN = [];
// Default of the standalone validateAnswer(): the generic protections only.
const DEFAULT_FORBIDDEN = [...GENERIC_FORBIDDEN];

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const literalRe = (phrase) => new RegExp(`(?<![\\p{L}\\p{N}])${escRe(String(phrase).trim()).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu');
const tryRe = (src, flags = 'i') => { try { return new RegExp(src, flags.replace(/[gy]/g, '')); } catch (_e) { return null; } };

/**
 * Turns restricted-claim config into forbidden entries. A plain string is a literal phrase (escaped, whole-word,
 * case-insensitive); an object is {pattern, reason, flags?, needs?, unless?}: pattern is a regex source, and with
 * needs/unless it applies per sentence (flagged only if it also matches needs and does not match unless).
 * A pattern that is not a valid regex falls back to a literal phrase, so a typo never drops the protection.
 * @param {Array<string | { pattern: string, reason?: string, label?: string, flags?: string, needs?: string, unless?: string }>} list
 * @param {{ reason?: string }} [opts]
 */
function compileRestricted(list, { reason = 'Restricted claim' } = {}) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ re: literalRe(item), reason: `${reason}: ${item.trim().slice(0, 80)}` });
      continue;
    }
    if (!item || typeof item !== 'object' || !String(item.pattern || '').trim()) continue;
    const re = tryRe(item.pattern, item.flags) || literalRe(item.pattern);
    const why = String(item.reason || `${reason}: ${String(item.pattern).slice(0, 60)}`);
    const needs = item.needs ? tryRe(item.needs) : null;
    const unless = item.unless ? tryRe(item.unless) : null;
    if (needs || unless) {
      out.push({ test: (t) => splitSentences(t).some((s) => re.test(s) && (!needs || needs.test(s)) && !(unless && unless.test(s))), label: String(item.label || item.pattern).slice(0, 60), reason: why });
    } else out.push({ re, reason: why });
  }
  return out;
}

// Fenced code (```lang ... ```). Only a coding answer (kind 'coding') exempts it from claim extraction; every
// answer is still checked in full (forbidden, restricted, work authorization, contact details). An unterminated
// fence is prose here (a model that forgot to close it must not hide text); `unclosedIsCode` is for polish.
/** @param {string} text @param {{ unclosedIsCode?: boolean }} [o] @returns {{ code: boolean, text: string }[]} */
function splitFences(text, { unclosedIsCode = false } = {}) {
  const parts = [];
  let cur = [];
  let inCode = false;
  for (const line of String(text || '').split('\n')) {
    const fence = /^\s*```/.test(line);
    if (!inCode && fence) { if (cur.length) parts.push({ code: false, text: cur.join('\n') }); cur = [line]; inCode = true; } else if (inCode && fence) { cur.push(line); parts.push({ code: true, text: cur.join('\n') }); cur = []; inCode = false; } else cur.push(line);
  }
  if (cur.length) parts.push({ code: inCode && unclosedIsCode, text: cur.join('\n') });
  return parts;
}
const hasFence = (text) => /^\s*```/m.test(String(text || ''));
const hasClosedFence = (text) => hasFence(text) && splitFences(text).some((p) => p.code);
const withoutCode = (text) => (hasFence(text) ? splitFences(text).filter((p) => !p.code).map((p) => p.text).join('\n') : String(text || ''));

// Small talk answers use no profile evidence, so a first-person account of something the user did ("I watched",
// "I went", "I had a great weekend") has nothing to be true from; only today_context can support one.
const SMALL_TALK_KINDS = new Set(['greeting', 'small_talk', 'rapport']);
const ANECDOTE = /\b(?:I|we)(?:'ve| have| had)?\s+(?:just |also |recently |actually |really |only |finally |even |all )?(?:watched|went|gone|saw|seen|had|read|visited|traveled|travelled|took|taken|spent|met|got|gotten|did|done|ate|eaten|tried|played|heard|listened|started|finished|caught|enjoyed|binged|attended|drove|flew|cooked|baked|climbed|hiked|ran|cycled|swam)\b|\b(?:I|we)(?:'m| am| was| were)\s+(?:just\s+)?(?:back from|coming back from|returning from|at|in|on)\s+(?:a|an|the|my|our)\b|\bI(?:'ve| have)? been (?:to|watching|reading|binge|working on|traveling|travelling|busy with)\b|\bmy (?:weekend|day|week|morning|trip|holiday|vacation|commute) (?:was|has been|had|went)\b|\bjust (?:got back|came back|returned|finished|started)\b|\blast (?:night|weekend|week),? I\b|\bover the (?:weekend|holidays?),? I\b/i;
const ANECDOTE_STOP = new Set('just also recently really great good that this with have been last what back from your about they them then than very much some more over after before while still here there were will would could should into onto'.split(' '));
const contentWords = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !ANECDOTE_STOP.has(w));
function anecdoteSupported(sentence, today) {
  const words = contentWords(sentence);
  if (!words.length || !today.length) return false;
  const known = new Set(today.flatMap((e) => contentWords(e.text)));
  return words.filter((w) => known.has(w)).length / words.length >= 0.5;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[‐-―]/g, '-').replace(/,(?=\d{3}\b)/g, '').replace(/\s+/g, ' ')
  .replace(/\b(\d+(?:\.\d+)?)\s?k\b/g, (_, n) => String(Math.round(Number(n) * 1000)))
  .replace(/\b(\d+(?:\.\d+)?)\s?m\b(?!s)/g, (_, n) => String(Math.round(Number(n) * 1e6)));
const normDates = (s) => norm(s).replace(/\b(january|february|march|april|june|july|august|september|october|november|december|sept)\b/g, (m) => MONTHS[m]);

function splitSentences(text) {
  return String(text || '').replace(/^\s*(SAY|POINTS):\s*/gim, '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim().replace(/^[-*•·–]\s+/, '')).filter(Boolean);
}

const FIRST_PERSON = /\b(I|I'm|I've|I'd|I'll|me|my|mine|we|we've|we'd|our|us)\b/i;

// "a hundred and twenty thousand" -> 120000; "forty" -> 40
function spokenNumbers(sentence) {
  const out = [];
  const words = sentence.toLowerCase().replace(/-/g, ' ').split(/[^a-z]+/).filter(Boolean);
  let i = 0;
  while (i < words.length) {
    if (!(words[i] in UNITS || words[i] in TENS || words[i] in SCALES || (words[i] === 'a' && words[i + 1] in SCALES))) { i += 1; continue; }
    let total = 0;
    let current = 0;
    const start = i;
    let any = false;
    while (i < words.length) {
      const w = words[i];
      if (w in UNITS) { current += UNITS[w]; any = true; } else if (w in TENS) { current += TENS[w]; any = true; } else if (w in SCALES) { current = (current || 1) * SCALES[w]; if (SCALES[w] >= 1000) { total += current; current = 0; } any = true; } else if ((w === 'and' || w === 'a') && i > start) { /* glue */ } else if (w === 'a' && words[i + 1] in SCALES) { /* "a hundred" */ } else break;
      i += 1;
    }
    const value = total + current;
    const text = words.slice(start, i).join(' ');
    // Small counts ("two teams", "one example") are not metrics, unless they quantify a claim ("three years").
    if (any && (value >= 10 || UNIT_WORDS.has(words[i]))) out.push({ value, text: UNIT_WORDS.has(words[i]) ? `${text} ${words[i]}` : text });
  }
  return out;
}

// Question kinds whose answers are mostly general knowledge; every other kind (walkthrough, biographical,
// behavioral, factual...) treats every sentence as a personal claim.
const GENERAL_KINDS = new Set(['technical', 'compare', 'situational']);
// A coding answer (screen mode) is general knowledge except where it claims the user's own experience.
const CODING_PERSONAL = /\b(?:I|we)(?:'ve| have| had)?\s+(?:also\s+|personally\s+|always\s+)?(?:built|used|worked|led|shipped|deployed|wrote|managed|owned|ran|designed|delivered|handled)\b|\b(?:in|at|during) my (?:last|previous|current|first|old)\b|\bmy (?:experience|project|team|job|role|internship|degree)\b/i;
const EMPLOYER_VERB = /^\s*[A-Z][\w.&-]*\s+(?:hired|offered|employed|recruited|interviewed|paid|acquired|sponsored|gave me|is where|was where|brought me)\b/;

/** @param {string} answer @param {{ vocabulary?: Set<string>, kind?: string|null, strictGeneral?: boolean }} [opts] */
function extractClaims(answer, { vocabulary, kind, strictGeneral = false } = {}) {
  const claims = [];
  const vocab = vocabulary || new Set();
  const namesProfile = (s) => { const l = s.toLowerCase(); for (const v of vocab) if (v.length > 3 && l.includes(v)) return true; return false; };
  const parts = String(answer || '').split(/\n\s*POINTS:\s*/i);
  const sentences = [
    ...splitSentences(parts[0]).map((s) => ({ s, bullet: false })),
    ...splitSentences(parts.slice(1).join('\n')).map((s) => ({ s, bullet: true })),
  ];
  for (const { s: sentence, bullet } of sentences) {
    // In explanatory answers, general-knowledge sentences ("HTTP uses TCP") are not personal claims.
    // POINTS bullets are always cues about his own work, so they are always checked.
    if (!bullet && !strictGeneral && GENERAL_KINDS.has(kind) && !FIRST_PERSON.test(sentence) && !namesProfile(sentence)) continue;
    if (!bullet && kind === 'coding' && !CODING_PERSONAL.test(sentence)) continue;
    // A question asked back to them ("how are you rolling out dashboards?") makes no claim about his work.
    if (!bullet && /\?\s*$/.test(sentence)) continue;
    const dateYears = new Set();
    for (const m of sentence.matchAll(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+((?:19|20)\d{2})\b/g)) {
      claims.push({ kind: 'date', text: m[0], key: `${MONTHS[m[1].toLowerCase()] || m[1].slice(0, 3).toLowerCase()} ${m[2]}`, sentence });
      dateYears.add(m[2]);
    }
    // Thousands separators must be groups of exactly three digits, so "ARIMA(1,1,1)" is not the number 111.
    for (const m of sentence.matchAll(/(\$)?(?<![\d:.,])\b(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(%|percent\b|k\b|m\b|ms\b|milliseconds?\b|seconds?\b|x\b|hours?\b|days?\b|weeks?\b|months?\b|years?\b)?(?![\d:]|,\d)/gi)) {
      let raw = m[2].replace(/,/g, '');
      let value = Number(raw);
      const unit = (m[3] || '').toLowerCase().replace('percent', '%');
      if (!Number.isFinite(value)) continue;
      if (unit === 'k') { value *= 1000; raw = String(Math.round(value)); }
      if (unit === 'm' && !/ms/.test(m[0].toLowerCase())) { value *= 1e6; raw = String(Math.round(value)); }
      if (/^(19|20)\d{2}$/.test(raw) && !unit) { if (!dateYears.has(raw)) claims.push({ kind: 'date', text: raw, key: raw, sentence }); continue; }
      if (value < 10 && !unit && !m[1] && !raw.includes('.')) continue;
      claims.push({ kind: 'number', text: m[0].trim(), key: raw, unit, sentence });
    }
    // Idioms are not metrics: "half of my time", "twice a week", "a hundred percent sure".
    const idiomless = sentence.replace(/\b(half|twice) (of (my|the|our)|a (day|week|month|year)|as (much|many|long))\b/gi, ' ').replace(/\b(a )?hundred percent (sure|certain|confident|honest)\b/gi, ' ');
    for (const n of spokenNumbers(idiomless)) claims.push({ kind: 'number', text: n.text, key: String(n.value), sentence, spoken: true });
    for (const r of RATIOS) { const m = idiomless.match(r.re); if (m) claims.push({ kind: 'ratio', text: m[0], key: r.key, equiv: r.equiv, sentence }); }
    // A conditional or pending outcome ("once the data is approved", "needs approval") claims nothing happened.
    for (const o of OUTCOMES) {
      const m = sentence.match(o.re);
      if (!m) continue;
      const before = sentence.slice(0, m.index);
      // "When the sponsor asked..." narrates an event, so the conditional exemption does not apply to it.
      if (!o.narrative && /\b(when|once|if|until|after|unless|pending|needs?|need to be|waiting (for|on)|awaiting|hasn't been|has not been|not yet)\b[^.;]{0,40}$/i.test(before)) continue;
      claims.push({ kind: 'outcome', text: m[0], key: o.stems[0], equiv: o.stems, sentence });
    }
    // "and" separates entities ("Gemini and GPT-3.5" is two names); "of"/"for" can be part of one ("Bank of America").
    const tokens = [...sentence.matchAll(/\b[A-Z][A-Za-z0-9.+#&-]*(?:\s+(?:[A-Z][A-Za-z0-9.+#&-]*|of|for))*\b/g)];
    for (const t of tokens) {
      const parts = t[0].replace(/\s+(of|for)$/i, '').trim().split(/\s+/);
      let stripped = 0;
      while (parts.length && STOP.has(parts[0].replace(/[.'’]/g, ''))) { parts.shift(); stripped += 1; }
      while (parts.length && STOP.has(parts[parts.length - 1].replace(/[.'’]/g, ''))) parts.pop();
      const phrase = parts.join(' ');
      if (!phrase || phrase.length < 2 || STOP.has(phrase)) continue;
      // A single capitalised word that merely opens the sentence is ordinary English ("Sometimes", "Anyway"),
      // unless it is a profile name, or the sentence makes it an employer ("Amazon hired me", "Google is where...").
      // "At Meta" keeps "Meta" because a stop word was stripped before it.
      const sentenceInitial = t.index === 0 && stripped === 0 && parts.length === 1 && !/[A-Z].*[A-Z]|\d/.test(phrase.slice(1));
      if (sentenceInitial && !vocab.has(phrase.toLowerCase()) && !EMPLOYER_VERB.test(sentence)) continue;
      const employerContext = new RegExp(`\\b(?:at|for|joined|interned at|worked at)\\s+(?:the\\s+)?${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(sentence) || EMPLOYER_VERB.test(sentence);
      claims.push({ kind: 'entity', text: phrase, key: phrase.toLowerCase(), sentence, employer: employerContext });
    }
  }
  const seen = new Set();
  return claims.filter((c) => { const k = `${c.kind}:${c.key}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * @param {Object} p
 * @param {string} p.answer
 * @param {{id:string,text:string,background?:boolean,setting?:string}[]} p.evidence  records actually sent to the model (plus identity card / corrections); background = a concept/method/posting/paper note; setting = "personal project"/"course project"
 * @param {string} [p.question] @param {string} [p.meetingNotes] @param {string} [p.context] extra support: history, typed request, previous answer
 * @param {string[]} [p.profileVocabulary]  entities from the whole profile (outside the bundle => warning only)
 * @param {string|null} [p.kind]  question kind; general-knowledge kinds skip impersonal sentences
 * @param {boolean} [p.strictGeneral]  meeting mode without general knowledge: impersonal sentences are checked too
 * @param {any[]} [p.forbidden]
 * @param {string[]} [p.previousAnswers]  answers already given in this conversation; sentences repeated from them fail
 * @param {boolean} [p.novelty]  FABEL_NOVELTY_CONTROLLER: also flag repeated openings and distinctive phrases
 * @param {boolean} [p.framed]  the whole answer already names the project's setting (set when trimming one sentence at a time)
 */
function validateAnswer({ answer: rawAnswer, evidence = [], question = '', meetingNotes = '', context = '', profileVocabulary = [], kind = null, strictGeneral = false, forbidden = DEFAULT_FORBIDDEN, previousAnswers = [], novelty = false, framed = false }) {
  // A coding answer's fenced code is shown, not spoken, so its claims are not extracted. Everything else is
  // checked as written, and the forbidden checks below always see the full text, code included.
  const fullAnswer = String(rawAnswer || '');
  const answer = kind === 'coding' ? withoutCode(fullAnswer) : fullAnswer;
  const support = evidence.map((e) => ({ id: e.id, n: normDates(e.text) }));
  const ctx = normDates(`${question}\n${meetingNotes}\n${context}`);
  const vocab = new Set(profileVocabulary.map((v) => String(v).toLowerCase()));
  const unsupported = [];
  const warnings = [];
  const supported = [];
  const numRe = (key) => new RegExp(`(?<![\\d.])${key.replace('.', '\\.')}(?![\\d]|\\.\\d)`);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Whole-word match: "Intel" is not supported by "intelligence", "Go" not by "goal".
  const wordRe = (key) => new RegExp(`(?<![a-z0-9])${esc(key)}(?![a-z0-9])`);
  const find = (test) => support.filter((s) => test(s.n)).map((s) => s.id);

  for (const c of extractClaims(answer, { vocabulary: vocab, kind, strictGeneral })) {
    let ids;
    let inCtx;
    if (c.kind === 'number') { ids = find((n) => numRe(c.key).test(n)); inCtx = numRe(c.key).test(ctx); } else if (c.kind === 'outcome') { ids = find((n) => c.equiv.some((e) => n.includes(e))); inCtx = false; } else if (c.kind === 'ratio') { ids = find((n) => c.equiv.some((e) => n.includes(e))); inCtx = c.equiv.some((e) => ctx.includes(e)); } else {
      // A multi-word or hyphenated phrase ("Airflow DAG", "GenAI-powered BI") is supported when the whole phrase,
      // or every significant token in it, appears as a whole word in the same source.
      // Plural of a profile name ("Ducatis" for "Ducati North America") counts as the name.
      const re = /[a-z]s$/.test(c.key) && c.key.length > 4 ? new RegExp(`${wordRe(c.key).source}|${wordRe(c.key.slice(0, -1)).source}`) : wordRe(c.key);
      const toks = c.key.split(/[\s-]+/).filter((w) => w.length >= 2 && !GENERIC.has(w) && !STOP.has(w.charAt(0).toUpperCase() + w.slice(1)));
      const multi = c.key.split(/[\s-]+/).length > 1;
      const all = (n) => toks.length >= 1 && multi && toks.every((w) => wordRe(w).test(n));
      ids = find((n) => re.test(n) || all(n));
      // A phrase made only of descriptive words ("GenAI-powered BI") names nothing checkable.
      inCtx = re.test(ctx) || all(ctx) || (multi && toks.length === 0);
    }
    const rec = { claim: c.text, kind: c.kind, sentence: c.sentence };
    if (ids.length) supported.push({ ...rec, sourceIds: ids });
    else if (inCtx) supported.push({ ...rec, sourceIds: ['conversation'] });
    // A profile tool or project outside the bundle is only a warning, but an employer claim must be in the evidence.
    else if (c.kind === 'entity' && !c.employer && vocab.has(c.key)) warnings.push({ ...rec, reason: 'in profile but not in retrieved evidence' });
    else unsupported.push({ ...rec, reason: `${c.kind}${c.employer ? ' (employer)' : ''} not in retrieved evidence or conversation` });
  }
  for (const f of forbidden) {
    if (f.test) { if (f.test(fullAnswer)) unsupported.push({ claim: f.label, kind: 'forbidden', reason: f.reason }); continue; }
    const m = fullAnswer.match(f.re);
    if (m && f.supportKey && support.some((s) => /^cor-/i.test(s.id) && f.supportKey.test(s.n))) continue; // approved by a correction
    if (m) unsupported.push({ claim: m[0], kind: 'forbidden', reason: f.reason });
  }
  if (SMALL_TALK_KINDS.has(String(kind))) {
    const today = evidence.filter((e) => e.id === 'TODAY');
    for (const s of splitSentences(answer)) {
      // A question asked back claims nothing.
      if (/\?\s*$/.test(s) || !ANECDOTE.test(s) || anecdoteSupported(s, today)) continue;
      unsupported.push({ claim: s.slice(0, 80), kind: 'anecdote', sentence: s, reason: 'first-person past-activity anecdote in small talk that today_context does not support' });
    }
  }
  // Repetition: a sentence of 8+ words that mostly repeats a sentence already said (token overlap >= 0.7).
  if (previousAnswers.length) {
    const toks = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9%.\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
    const said = previousAnswers.map((p) => (kind === 'coding' ? withoutCode(p) : String(p || ''))).flatMap(splitSentences).map(toks).filter((t) => t.size >= 6);
    for (const s of splitSentences(String(answer || '').replace(/\n\s*POINTS:[\s\S]*$/i, ''))) {
      const t = toks(s);
      if (t.size < 6) continue;
      const overlap = said.some((p) => { let inter = 0; for (const w of t) if (p.has(w)) inter += 1; return inter / (t.size + p.size - inter) >= 0.7; });
      if (overlap) unsupported.push({ claim: s.slice(0, 80), kind: 'repeat', sentence: s, reason: 'repeats an earlier answer in this conversation' });
    }
    // Novelty controller (FABEL_NOVELTY_CONTROLLER): also catch a repeated opening and a reused
    // distinctive phrase, which lexical-overlap on whole sentences can miss.
    if (novelty) {
      const wordsOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9%.\s]/g, ' ').split(/\s+/).filter(Boolean);
      const firstSent = (s) => splitSentences(String(s || '').replace(/^\s*SAY:\s*/i, ''))[0] || '';
      const ansOpen = wordsOf(firstSent(answer)).slice(0, 8);
      if (ansOpen.length >= 4) {
        for (const p of previousAnswers) {
          const po = new Set(wordsOf(firstSent(p)).slice(0, 8));
          let inter = 0; for (const w of ansOpen) if (po.has(w)) inter += 1;
          if (po.size && inter / (ansOpen.length + po.size - inter) >= 0.6) {
            unsupported.push({ claim: firstSent(answer).slice(0, 80), kind: 'repeat', sentence: firstSent(answer), reason: 'opening repeats a recent answer' });
            break;
          }
        }
      }
      // A distinctive phrase = an 8-word window with >= 4 significant (non-function) tokens that recurs
      // verbatim. Longer windows + a significance floor avoid flagging ordinary wording, and a safety/
      // honesty qualifier may legitimately repeat (PRD: repetition is allowed for a necessary qualification).
      const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9%\s]/g, ' ').replace(/\s+/g, ' ').trim();
      const prevNorm = previousAnswers.map(norm);
      const significant = (arr) => arr.filter((x) => x.length > 2 && !NOVELTY_FUNCTION.has(x)).length;
      for (const s of splitSentences(String(answer || '').replace(/\n\s*POINTS:[\s\S]*$/i, ''))) {
        if (NOVELTY_SAFETY.test(s)) continue; // a necessary safety/honesty qualifier may recur
        const w = norm(s).split(' ').filter(Boolean);
        let hit = null;
        for (let i = 0; i + 8 <= w.length && !hit; i += 1) {
          const winArr = w.slice(i, i + 8);
          if (significant(winArr) < 4) continue;
          const win = winArr.join(' ');
          if (prevNorm.some((p) => p.includes(win))) hit = win;
        }
        if (hit) unsupported.push({ claim: hit.slice(0, 80), kind: 'repeat', sentence: s, reason: 'reuses a distinctive phrase from an earlier answer' });
      }
    }
  }
  // Background borrowing: a first-person account of my own work ("I applied required-field rules...")
  // must not be built from a background note (concept, method, job posting, paper). Such a sentence has
  // no number or name for the checks above to catch, so compare its distinctive word pairs with the
  // background sources and with my verified work.
  const background = evidence.filter((e) => e.background);
  if (background.length) {
    const bg = new Set(background.flatMap((e) => [...pairsOf(e.text)]));
    const own = new Set(evidence.filter((e) => !e.background).flatMap((e) => [...pairsOf(e.text)]));
    for (const s of splitSentences(String(answer || '').replace(/\n\s*POINTS:[\s\S]*$/i, ''))) {
      const m = DOING.exec(s);
      if (!m || HYPOTHETICAL.test(s.slice(0, m.index + m[0].length))) continue;
      const borrowed = [...pairsOf(s.slice(m.index))].filter((p) => bg.has(p) && !own.has(p));
      if (borrowed.length >= 2) unsupported.push({ claim: s.slice(0, 80), kind: 'borrowed', sentence: s, reason: `describes my own work with wording from a background note (${borrowed.slice(0, 3).join(', ')}), not from my verified work` });
    }
  }
  // Project setting: figures from a personal or course project told without saying so read as paid work
  // ("delivered a 25% ROI lift" from a Kaggle project). A figure only that project has needs its setting
  // named somewhere in the answer.
  const projects = evidence.filter((e) => e.setting);
  const say = String(answer || '').replace(/\n\s*POINTS:[\s\S]*$/i, '');
  if (projects.length && !framed && !SETTING_FRAME.test(say)) {
    const elsewhere = new Set([...evidence.filter((e) => !e.setting).map((e) => e.text), question, meetingNotes, context].flatMap(figuresOf));
    for (const e of projects) {
      const own = new Set(figuresOf(e.text).filter((n) => !elsewhere.has(n)));
      const s = splitSentences(say).find((x) => figuresOf(x).some((n) => own.has(n)));
      if (s) { unsupported.push({ claim: s.slice(0, 80), kind: 'setting', sentence: s, setting: e.setting, reason: `uses my ${e.setting} without saying it was one, so it sounds like paid work` }); break; }
    }
  }
  const confidence = Math.max(0, 1 - 0.25 * unsupported.length - 0.05 * warnings.length);
  return { ok: unsupported.length === 0, unsupported_claims: unsupported, warnings, supported, confidence: Number(confidence.toFixed(2)) };
}

// First-person statement that I did something (not "I would", "I'd start by").
const DOING = /\b(?:I|we)(?:'ve| have| had)?\s+(?:also\s+|then\s+|personally\s+|always\s+)?(?:applied|built|implemented|designed|created|set up|enforced|ran|used|wrote|added|managed|maintained|kept|developed|defined|introduced|established|automated|validated|ensured|handled|owned|led|deployed|delivered|put in place|configured)\b/i;
const HYPOTHETICAL = /\b(?:would|'d|will|'ll|could|can|might|plan to|going to|want to|like to|if i|i'?d start)\b/i;
// Words that tell the listener a project was not paid work ("of course" does not count).
const SETTING_FRAME = /\b(?:personal|side|(?<!of )course|class|coursework|capstone|academic|school|kaggle|portfolio|hobby|on my own|public(?:ly available)? (?:[\w-]+ ){0,3}data(?:set)?|open (?:[\w-]+ )?data(?:set)?|sample data(?:set)?|synthetic data)\b/i;
/** Figures of 10 or more ("25%", "about 500K", "541,909"), as plain digits; years are not figures. */
function figuresOf(text) {
  return (String(text || '').match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, ''))
    .filter((n) => Number(n) >= 10 && !/^(?:19|20)\d\d$/.test(n));
}
const PAIR_STOP = new Set('the a an and or but of to in on at by for with from into onto against per via is are was were be been being i we you it its that this these those my our your their me us do did does done have has had not no so as if then than also every each all any some such about across over under before after up out off more most less only just very own same both other another which who what when where how there here them they he she his her'.split(' '));

/** Consecutive significant-word pairs, lower-cased, with a plural "s" dropped ("allowed-value lists" -> "allowed value", "value list"). */
function pairsOf(text) {
  const toks = String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !PAIR_STOP.has(w)).map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  const out = new Set();
  for (let i = 0; i + 1 < toks.length; i += 1) out.add(`${toks[i]} ${toks[i + 1]}`);
  return out;
}

// Novelty controller (FABEL_NOVELTY_CONTROLLER) helpers: function words (ignored when judging how
// "distinctive" a repeated window is) and safety/honesty qualifiers that may legitimately recur.
const NOVELTY_FUNCTION = new Set('the a an and or but of to in on at by for with from into is are was were be been i we you it that this my our your their do did does have has had not no so as if then than at it s t re ve ll'.split(' '));
const NOVELTY_SAFETY = /\b(don'?t have|do not have|haven'?t|have not|not sure|can'?t confirm|cannot confirm|would want to (double-?check|verify|confirm)|double-?check|i'?m not certain|no direct experience|to be clear|just to be clear)\b/i;

const SAFE_FALLBACK = "SAY: I'd want to double-check the specifics on that before I quote them, but I'm happy to walk through how I approached it.";
// Small talk that could not be kept: neutral, true of anyone, and hands the conversation back.
const SMALL_TALK_FALLBACK = "SAY: Doing well, thanks. How's your day going?";

// Drops every sentence/bullet that still fails validation on its own, then re-validates the whole answer.
function trimUnsupported(answer, opts) {
  const fallback = SMALL_TALK_KINDS.has(String(opts && opts.kind)) ? SMALL_TALK_FALLBACK : SAFE_FALLBACK;
  if (hasClosedFence(answer)) return trimFenced(answer, opts, fallback);
  const m = String(answer).match(/^([\s\S]*?)(\n?\s*POINTS:[\s\S]*)?$/i);
  const say = (m[1] || '').replace(/^\s*SAY:\s*/i, '');
  // A sentence checked on its own may rely on another sentence naming the project's setting.
  const framed = SETTING_FRAME.test(say);
  const segmentOk = (s, bullet) => validateAnswer({ ...opts, framed, answer: bullet ? `SAY:\nPOINTS:\n- ${s}` : s }).ok;
  const keptSay = splitSentences(say).filter((s) => segmentOk(s, false)).join(' ');
  const bullets = (m[2] || '').split('\n').map((l) => l.trim()).filter((l) => /^[-*•·–]\s+/.test(l)).filter((l) => segmentOk(l.replace(/^[-*•·–]\s+/, ''), true));
  if (!keptSay) return { text: fallback, ok: true, fallback: true };
  const text = `SAY: ${keptSay}${bullets.length ? `\nPOINTS:\n${bullets.map((b) => `- ${b.replace(/^[-*•·–]\s+/, '')}`).join('\n')}` : ''}`;
  const v = validateAnswer({ ...opts, answer: text });
  return v.ok ? { text, ok: true } : { text: fallback, ok: true, fallback: true };
}

// Same as above for an answer with fenced code: prose lines are checked sentence by sentence and the line structure
// ("Assumptions:", "Complexity:") stays as written. A fence is kept only if it passes the same checks as the rest
// (contact details, restricted claims, work authorization...); otherwise it is dropped.
function trimFenced(answer, opts, fallback) {
  const parts = splitFences(answer);
  const framed = SETTING_FRAME.test(parts.filter((p) => !p.code).map((p) => p.text).join('\n'));
  const sentenceOk = (s) => validateAnswer({ ...opts, framed, answer: s }).ok;
  let keptProse = false;
  const out = parts.map((p) => {
    if (p.code) return validateAnswer({ ...opts, framed, answer: p.text }).ok ? p.text : '';
    return p.text.split('\n').map((line) => {
      const m = /^(\s*(?:SAY:\s*)?(?:[-*•·–]\s+)?)([\s\S]*)$/i.exec(line);
      if (!m[2].trim()) return line;
      const kept = splitSentences(m[2]).filter(sentenceOk).join(' ');
      if (kept) keptProse = true;
      return kept ? `${m[1]}${kept}` : null;
    }).filter((l) => l !== null).join('\n');
  }).filter((x) => x !== '').join('\n');
  if (!keptProse) return { text: fallback, ok: true, fallback: true };
  const text = /^\s*SAY:/i.test(out) ? out : `SAY: ${out.replace(/^\s+/, '')}`;
  return validateAnswer({ ...opts, answer: text }).ok ? { text, ok: true } : { text: fallback, ok: true, fallback: true };
}

// Back-compat helper used by older callers: trims by claim text.
function removeUnsupported(answer, unsupported, opts = {}) {
  if (opts && opts.evidence) return trimUnsupported(answer, opts).text;
  const bad = unsupported.map((u) => String(u.claim).toLowerCase()).filter(Boolean);
  const hits = (s) => bad.some((b) => s.toLowerCase().includes(b));
  const m = String(answer).match(/^([\s\S]*?)(\n?\s*POINTS:[\s\S]*)?$/i);
  const keptSay = splitSentences((m[1] || '').replace(/^\s*SAY:\s*/i, '')).filter((s) => !hits(s)).join(' ');
  const points = (m[2] || '').split('\n').filter((l) => !(/^\s*[-*•·–]\s+/.test(l) && hits(l))).join('\n');
  return keptSay ? `SAY: ${keptSay}${points.trim() ? `\n${points.trim()}` : ''}` : SAFE_FALLBACK;
}

module.exports = { validateAnswer, removeUnsupported, trimUnsupported, extractClaims, spokenNumbers, DEFAULT_FORBIDDEN, GENERIC_FORBIDDEN, LEGACY_PROFILE_FORBIDDEN, SAFE_FALLBACK, SMALL_TALK_FALLBACK, compileRestricted, splitFences, splitSentences, hasFence, withoutCode };
