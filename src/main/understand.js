// @ts-check
'use strict';
// Deterministic question understanding: no LLM call. Returns machine-readable metadata only.
const { COMPETENCIES } = require('./brain/schema');

const P = {
  casual: /^(hi|hey|hello|good (morning|afternoon|evening)|nice to (meet|see) you|thanks?( you)?|thank you|how are you|how's it going|great|awesome|cool|ok(ay)?|sounds good|perfect|got it)\b[\s\S]{0,40}$/i,
  clarification: /\b(what do you mean|could you clarify|can you clarify|sorry,? (what|come again)|say that again|can you repeat|did you mean)\b/i,
  behavioral: /\b(was there (ever )?a time|tell me about (a|the|another|one) time|give me (an|another|one more|a different) example|(another|a different|one more) example|describe (a|another) (time|situation)|walk me through a time|have you ever (had|faced|dealt|worked|led|failed|made)|share an example|a time when you|an instance where|a situation (where|in which) you|a project where you (had|needed|were)|what('s| is| was) (a|the) (challenge|hardest|toughest|biggest challenge|biggest mistake) you('ve)? (faced|had|made)|tell me about (a|an|your) (conflict|challenge|failure|mistake|disagreement|setback|difficult|tough|hardest|biggest (challenge|mistake|failure))|how did you (handle|deal with|resolve))\b/i,
  // Explicit past-experience cue: these stay behavioral even if the sentence also says "would".
  pastCue: /\b(tell me about (a|the|another|one) time|have you ever|a time when you|describe a time|when did you|walk me through a time|what did you do|(give me|share) (an|another|one more|a different) example (of a (time|project)|from your|where you|when you)|an example of a (time|project) (where|when) you)\b/i,
  motivation: /\b(why (do you want|are you interested|this (role|company|team|position)|us|our company|did you apply|did you choose)|what (interests|excites|attracts) you|what draws you|what do you hope to (learn|get|gain)|what (are you|do you want to be) hoping to (learn|get))\b/i,
  biographical: /\b(tell me (a little )?(bit )?about yourself|walk me through your (background|resume|cv|experience|journey)|introduce yourself|your background|what are you (doing|working on) (now|currently|these days)|where are you (based|from)|what do you do|(an |me an )?overview of (the |your )?(work|background|experience|career)|what('s| is) next for you|where do you (want|see yourself)|your career (goals|plans)|tell me (a little |a bit )?(more )?about your (work )?(experience|background|career|education|studies|degree|master'?s|undergrad\w*|program|internship|job|jobs|work history)|what did you (do|work on) at|what did you study|your (master'?s|undergrad\w*|bachelor'?s|degree|education|coursework)\b|your volunteer\w*|volunteer(ing)? experience)\b/i,
  // Work authorization and compensation: never answered from model knowledge; only approved statements or a deferral.
  authorization: /\b(authori[sz]ed to work|work authori[sz]ation|visa|sponsor(ship)?|f-?1|opt|stem opt|h-?1b|green card|citizen(ship)?|work permit|immigration status)\b/i,
  compensation: /\b(salary|compensation|base pay|pay range|comp(ensation)? range|bonus|equity|expected pay|expectations? (for|on) (pay|comp|salary)|(pay|salary|rate|wage|compensation) expectations?|hourly (rate|pay|wage)|desired (pay|salary|rate|wage)|how much (are you|do you) (expect|want|hope) to (make|earn|be paid))\b/i,
  questionsForThem: /\b(what questions (can i answer|do you have)|(do you have )?any questions (for me|for us)|anything (you'd|you would) like to ask|what can i answer for you)\b/i,
  checkIn: /\bany (other )?questions (on|about) (anything|what) (i've|i have|we've) (mentioned|said|covered|discussed)\b|\bdoes that (sound good|make sense)\b|\bhow does that sound\b/i,
  strengths: /\b(strengths?|strongest|weakness(es)?|what are you (good|bad) at|area(s)? (of|for) improvement|biggest accomplishment|proudest|(your|core|main|key) (technical )?skills|skill set|tech stack|do you have experience (with|in)|how (comfortable|experienced) are you with)\b/i,
  walkthrough: /\bhow did you (build|make|create|approach|put together|design) (the|your|that|this)\b|\b(walk me through|tell me (more )?about|talk (me )?(through|about)|describe|explain) (your|the|that|a|an|one) ([\w-]+ ){0,3}(project|capstone|work|role|internship|job|pipeline|system|dashboard|thesis|research|experience at)\b/i,
  situational: /\b(what would you do|how would you|would you (handle|approach|deal|respond|do)|(how |where |when |which )?you would|if you (were|had to|joined)|imagine|suppose|hypothetically|in your first \d+ days|(your )?(first|next) (two|three|few|couple of|\d+) (weeks|days|months)|what would your first)\b/i,
  compare: /\b(difference between|compare|comparison|versus|vs\.?|pros and cons|trade-?offs? between|better than)\b/i,
  technical: /\b(how (does|do|would|could) (an? |the )?[\w-]+( [\w-]+){0,4} work|explain|what is (an? |the )?[\w-]+|what are [\w-]+|how do you (design|build|implement|scale|optimi[sz]e|evaluate|test|deploy|handle)|design an?|architecture|algorithm|complexity|latency|throughput|scal(e|ing)|rag|llm|sql|model)\b/i,
  factual: /\b(when (did|were|was)|how long (did|have|were)|what (was|is) your (role|title|gpa|degree|major|stack)|which (tools|languages|technologies|frameworks|company|companies)|did you use|how many|what year|where did you (study|work))\b/i,
  opinion: /\b(what do you think (about|of)|your (view|opinion|take) on|do you (like|prefer|enjoy)|favo(u)?rite|how do you feel about)\b/i,
  calc: /\b(calculate|estimate|how many|what percent(age)?|compute|ratio|probability|expected value|math)\b|\d+\s*[x*/+-]\s*\d+/i,
  highStakes: /\b(salary|compensation|pay|rate|offer|negotiat|visa|sponsor(ship)?|work authori[sz]ation|authori[sz]ed to work|f-?1|opt|h-?1b|green card|citizen|work permit|relocat|start date|notice period|references?|background check|legal|contract|equity|bonus)\b/i,
  constraint: /\b(and also|as well as|while|without|given that|assuming|but also|at the same time|under the constraint|within)\b/gi,
  projectDetail: /\b(projects?|capstone|model|models|dashboard|pipeline|dataset|data ?sets?|data source|data|tech stack|stack|tools?|library|libraries|framework|accuracy|precision|recall|auc|roc|f1|rmse|mae|brier|kpis?|metrics?|results?|features?|baseline|validation|train(ed|ing)?|deploy\w*|architecture|how many (rows|records|images|messages|appointments|users|counties)|sample size|units?)\b/i,
  // Meeting-mode kinds (research or volunteer conversations). Only used when a meeting pack is active.
  availability: /\b(how (much|many hours|many) (time|hours)|hours (a|per) week|time commitment|commit(ment)? to|how soon|when (could|can|would) you (start|begin)|start date|availability|available (to|for|from)|your schedule|how long (can|could|would) you (stay|help|work))\b/i,
  methodological: /\b(data|values|records|survey)\b[^.?]{0,20}\b(incomplete|missing|messy|sparse|unreliable|biased)\b|\b(measur(e|es|ed|ing|ement)|indicators?|valid(ity|ate|ation)?|reliab(le|ility)|causal(ity)?|caus(e|es|ation)|counterfactual|attribution|contribution analysis|confound|bias(ed)?|missing (data|values)|incomplete data|weight(s|ing)?|normali[sz]|aggregat|robust(ness)?|sensitivity analysis|quantitative|qualitative|mixed methods?|survey|sampl(e|ing)|operationali[sz]|proxy|proxies|overlap|correlat|convergent|factor analysis|composite)\b/i,
  literature: /\b(literature|paper|papers|article|study|studies|research(ers)?|read(ing)?|you('ve| have)? read|the (index|update|framework)|authors?|book|findings?|argu(e|es|ment)|theory|theories|concept)\b/i,
  // A broad ask about a capability ("what's your experience managing data", "how have you used SQL", "what kinds of tools have you used").
  experienceAsk: /\b(what('s| is| has been) your experience (with|in|managing|working|coordinating|using|handling|leading|building|on)|what experience do you have|tell me about your experience|(can you )?describe (your experience|how you('ve| have) (used|worked|handled|managed|kept|approached))|how have you (used|kept|handled|managed|worked|ensured|approached|maintained)|what kinds? of ([\w-]+ ){0,4}(tools|data|projects|work|systems|platforms)( [\w-]+){0,3} (have you|did you)|which (tools|systems|platforms) have you used)\b/i,
  roleFit: /\b(what (skills|value) (can|could|would) you (bring|contribute|add|offer)|how (can|could|would) you (help|contribute|be useful)|what (can|could|would) you (bring|contribute|do for)|why should (i|we) (work with|take|bring) you|what would you (work on|do first|want to work on)|how do you see yourself (helping|contributing)|what role)\b/i,
};

// Social pleasantries. They are detected only when nothing but a name is left once the pleasantries are
// removed, so "Hi, tell me about yourself" stays a real question. Small talk is answered without any profile
// or memory evidence (engine.js), so an invented anecdote has nothing to be built from.
const SOCIAL = {
  small_talk: [
    /\bhow (?:are|r) (?:you|u)(?: (?:doing|going|feeling))?(?: (?:today|this (?:morning|afternoon|evening)|so far))?/gi,
    /\bhow(?:'s| is| has) (?:it going|everything|life|things|your (?:day|morning|afternoon|evening|week|weekend)(?: (?:going|been|so far))?|the (?:day|weather|week)(?: (?:going|been|so far|(?:over )?(?:there|where you are)))?)/gi,
    /\bhow (?:have|has) you(?:r (?:day|week))? been\b/gi,
    /\bhow (?:was|were) (?:your|the) (?:day|morning|weekend|week|commute|trip|flight|holiday|holidays|vacation|break|evening)/gi,
    /\bwhat(?:'s| is) up\b|\bwhat are you up to\b/gi,
    /\bwhat did you do (?:over |on |this |last |for )?(?:the )?(?:weekend|holiday|holidays|break|evening|day)/gi,
    /\b(?:did|do) you have a (?:good|great|nice|lovely|relaxing|busy) (?:weekend|holiday|break|day|night|rest|week)/gi,
    /\b(?:have|had) you had a (?:good|great|nice|busy|long) (?:day|week|morning)/gi,
    /\bhope you(?:'re| are) (?:doing )?(?:well|good|ok|okay|having a (?:good|great|nice) (?:day|week|morning|afternoon))/gi,
    /\b(?:are|r) you (?:doing )?(?:well|good|ok|okay|alright)/gi,
    /\b(?:how|what) about you\b|\band you\b/gi,
    /\bwhere are you (?:joining|dialing|calling|logging) (?:in )?from\b/gi,
    /\b(?:nice|lovely|terrible|awful|hot|cold|rainy) (?:weather|day) (?:today|we're having|we are having)?/gi,
  ],
  rapport: [
    /\b(?:very |really |so )?(?:nice|great|good|lovely|wonderful|pleasure|a pleasure|pleased|glad|happy) (?:to (?:finally )?(?:meet|see|talk to|speak (?:with|to)|connect with|have|hear from) (?:you|u)|meeting you)(?: (?:in person|too|again|finally|today))?/gi,
    /\bthank(?:s| you)(?: so much| very much| again)? for (?:joining|making (?:the )?time|taking (?:the |some )?time|coming|being here|your time|having me|meeting (?:with )?me|hopping on|jumping on|connecting|setting this up|the invite|the opportunity)(?: today| (?:out )?of your (?:day|busy schedule))?/gi,
    /\b(?:glad|happy) (?:you|we) (?:could|were able to) (?:make it|join|connect|do this|do this today)/gi,
    /\bappreciate (?:you )?(?:joining|making time|your time|you being here|you taking the time|the time)/gi,
    /\bwelcome(?: back| to the (?:call|meeting))?\b/gi,
    /\bhave a (?:great|good|nice|lovely|wonderful) (?:day|one|weekend|evening|week|rest of your day)/gi,
    /\btake care\b|\bsee you (?:later|soon|next time)|\btalk (?:to you )?soon\b|\bgood luck\b/gi,
  ],
  greeting: [
    /\b(?:hi|hey|hello|howdy|hiya|greetings|yo|good (?:morning|afternoon|evening)|morning|afternoon|evening)\b(?: (?:there|everyone|everybody|all|folks|team|again))?/gi,
  ],
};
// Words that may remain once the pleasantries are removed (everything else must be a capitalised name).
const SOCIAL_FILLER = new Set('and so um uh well ok okay yeah yes great good fine thanks thank you i im i\'m am too today there again please just really very so it is the a to be'.split(' '));

/**
 * 'small_talk' | 'rapport' | 'greeting' when the whole utterance is a pleasantry, else null.
 * @param {string} text
 * @returns {'small_talk'|'rapport'|'greeting'|null}
 */
function smallTalkKind(text) {
  const t = String(text || '').trim();
  if (!t || words(t).length > 18) return null;
  const hits = new Set();
  let rest = t;
  for (const [kind, res] of Object.entries(SOCIAL)) {
    for (const re of res) {
      const next = rest.replace(re, ' ');
      if (next !== rest) { hits.add(kind); rest = next; }
    }
  }
  if (!hits.size) return null;
  const left = rest.replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter((w) => w && !SOCIAL_FILLER.has(w.toLowerCase()));
  // Names are capitalised ("Hi Sarah"); one lowercase leftover is tolerated only beside a real pleasantry ("hey sam how are you").
  const names = left.filter((w) => /^\p{Lu}/u.test(w));
  const stray = left.length - names.length;
  if (names.length > 2 || stray > (hits.size === 1 && hits.has('greeting') ? 0 : 1)) return null;
  return hits.has('small_talk') ? 'small_talk' : hits.has('rapport') ? 'rapport' : 'greeting';
}

// Pleasantry types (meta.small_talk) answered with no profile, pack, story, exemplar or memory evidence.
const SMALL_TALK_KINDS = new Set(['greeting', 'small_talk', 'rapport']);

const INTENT = {
  greeting: 'A greeting; greet them back warmly in one short sentence.',
  small_talk: 'Friendly small talk; answer neutrally and turn the conversation back to them.',
  rapport: 'A courtesy exchange; reply graciously in one short sentence.',
  casual: 'Social nicety; respond briefly and naturally.',
  clarification: 'They are asking me to clarify what I said; restate it more simply.',
  behavioral: 'Assess a competency through one real past example.',
  motivation: 'Understand why I want this opportunity, tied to my verified experience.',
  biographical: 'A relevant professional narrative, not a full biography.',
  walkthrough: 'A clear walk-through of one specific piece of my work: problem, what I built, how, and the result.',
  strengths: 'Self-awareness about strengths or growth areas, backed by evidence.',
  situational: 'How I would think through a hypothetical; do not invent a past story.',
  compare: 'A balanced comparison with a clear recommendation.',
  technical: 'A direct, correct technical explanation at the right depth.',
  factual: 'A specific fact about my background; answer precisely.',
  opinion: 'My view, grounded in my experience where possible.',
  other: 'Respond directly to what was said.',
  authorization: 'Work authorization: only an approved statement or an honest deferral; never invented status, dates or sponsorship claims.',
  compensation: 'Compensation: acknowledge without committing; the decision stays with the user.',
  questions_for_them: 'They invite my questions: ask one or two specific, informed questions back.',
  check_in: 'A check-in: brief natural reply, then let them continue.',
  literature: 'Show I understood the assigned literature: the finding, its scope, and what it means for the project.',
  methodological: 'How I would measure or test something: a sound method, its limits, and no overstated causality.',
  availability: 'My time and commitment: only commitments I have already stated; nothing new promised.',
  role_fit: 'Why working with me is useful: concrete things I have already done for them and can do next.',
  project_detail: 'A precise fact about one of my projects (data, source, stack, metric, result): state it exactly, then how I got it.',
  experience: 'My experience with one capability: the one or two strongest real examples and what they achieved, tied to the role.',
};

const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean);

function inferCompetencies(text) {
  const t = String(text || '').toLowerCase();
  // Keyword must start a word and not be part of a hyphenated compound ("non-technical" is not "technical").
  const hit = (k) => new RegExp(`(?<![\\w-])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t);
  return Object.entries(COMPETENCIES).filter(([, kws]) => kws.some(hit)).map(([k]) => k);
}

function entitiesIn(text, known = []) {
  const found = new Set();
  const t = String(text || '');
  const lower = t.toLowerCase();
  for (const e of known) if (e && e.length > 2 && lower.includes(e.toLowerCase())) found.add(e);
  // Capitalised words that are not sentence-initial filler.
  const SKIP = new Set(['I', 'So', 'And', 'But', 'Can', 'Could', 'Would', 'What', 'Why', 'How', 'When', 'Where', 'Which', 'Who', 'Tell', 'Walk', 'Describe', 'Give', 'Have', 'Do', 'Did', 'Are', 'Is', 'Okay', 'Ok', 'Yeah', 'Great', 'Thanks', 'Hi', 'Hello', 'Sure', 'Also', 'Now', 'Let', 'Please', 'The', 'A', 'An', 'If', 'In', 'On', 'For', 'Your', 'You', 'My']);
  for (const m of t.matchAll(/\b([A-Z][a-zA-Z0-9.+#-]*(?:\s+[A-Z][a-zA-Z0-9.+#-]*)*)\b/g)) {
    // Drop leading filler words ("So Contoso" -> "Contoso").
    const parts = m[1].trim().split(/\s+/);
    while (parts.length && SKIP.has(parts[0])) parts.shift();
    if (parts.length) found.add(parts.join(' '));
  }
  return [...found];
}

/** @param {string} text @param {{ meeting?: { literatureTerms?: string[], research?: boolean } | null }} [opts] */
function classify(text, { meeting = null } = {}) {
  // Only a research meeting reads "what is X" and reading words as questions about the literature.
  const research = Boolean(meeting) && meeting.research !== false;
  const t = String(text || '').trim();
  const n = words(t).length;
  if (!t) return 'other';
  // Pleasantries next: whatever the profile or pack holds must never be pulled into them.
  const social = smallTalkKind(t);
  // A bare greeting keeps the legacy kind (router and render pin 'casual' to one short sentence); meta.small_talk
  // carries which pleasantry it was, and the engine keys its evidence-free path on that.
  if (social) return social === 'greeting' ? 'casual' : social;
  // Logistics first: these must never fall into a personal-story or technical shape.
  if (P.authorization.test(t)) return 'authorization';
  if (P.compensation.test(t)) return 'compensation';
  if (P.questionsForThem.test(t)) return 'questions_for_them';
  if (P.checkIn.test(t) && n <= 20) return 'check_in';
  if (P.clarification.test(t)) return 'clarification';
  if (meeting) {
    if (P.availability.test(t)) return 'availability';
    if (P.roleFit.test(t)) return 'role_fit';
    // Questions about him (background, education, skills) stay personal even when they mention research words.
    if (P.biographical.test(t) && !P.pastCue.test(t)) return 'biographical';
    // "Tell me about your capstone" is a story; "what accuracy did you get?" is a precise fact.
    if (P.walkthrough.test(t)) return 'walkthrough';
    // A broad capability question is not a precise project fact; with "how did you..." it wants a story.
    if (P.experienceAsk.test(t)) return /\bhow did you\b|\bwhen (different|multiple|other|several)\b/i.test(t) || P.pastCue.test(t) ? 'behavioral' : 'experience';
    // "What accuracy did you get?", "which dataset did you use?": a precise question about his own project.
    if (P.projectDetail.test(t) && /\b(did you|have you|were you|was your|you('ve)? (used|got|get|built|chose|picked|trained|deployed|measured|tracked|collected|reached|achieved|found)|your (own )?([\w-]+ ){0,2}(projects?|models?|capstone|dashboard|pipeline|data|dataset|stack|results?|work|accuracy|metrics?))\b/i.test(t) && !P.pastCue.test(t)
      && !/\b(literature|papers?|articles?|read|reading|social capital|index)\b/i.test(t)) return 'project_detail';
    if (P.strengths.test(t)) return 'strengths';
    if (P.situational.test(t) && !P.pastCue.test(t) && !P.methodological.test(t)) return 'situational';
    // A past-experience request stays a story even when it mentions measurement or reading.
    if (P.behavioral.test(t) && P.pastCue.test(t)) return 'behavioral';
    if (P.methodological.test(t) && !P.motivation.test(t)) return 'methodological';
    // Whole-word matches only: "JEC" must not match inside "project".
    const terms = (meeting.literatureTerms || []).filter((x) => x && x.length > 2)
      .map((x) => new RegExp(`(?<![\\w-])${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i'));
    if (P.walkthrough.test(t)) return 'walkthrough';
    // "Why did you use SVI in your model?" is about his own work, not the literature, unless reading is named.
    const aboutOwnWork = /\b(why|how|when) did you\b|\bdid you (use|build|choose|pick|decide|make)\b|\byour (own )?(project|model|dashboard|pipeline|work|analysis|map|code|background|training)\b/i.test(t)
      && !/\b(literature|paper|papers|article|read|reading)\b/i.test(t);
    if (research && !aboutOwnWork && (P.literature.test(t) || terms.some((re) => re.test(t))) && !P.motivation.test(t) && !P.biographical.test(t)) return 'literature';
  }
  // Hypotheticals win over behavioral wording unless there is an explicit past-experience cue.
  if (P.situational.test(t) && !P.pastCue.test(t)) return 'situational';
  if (P.behavioral.test(t)) return 'behavioral';
  if (P.walkthrough.test(t)) return 'walkthrough';
  if (P.motivation.test(t)) return 'motivation';
  if (P.biographical.test(t)) return 'biographical';
  if (P.strengths.test(t)) return 'strengths';
  if (P.compare.test(t)) return 'compare';
  if (P.factual.test(t)) return 'factual';
  if (P.opinion.test(t)) return 'opinion';
  // In a research meeting, "what is X / explain X" is about the literature, answered from the pack.
  if (P.technical.test(t)) return research ? 'literature' : 'technical';
  if (n <= 8 && P.casual.test(t)) return 'casual';
  return 'other';
}

// Spec types + shapes. Internal kinds (motivation, situational, strengths, compare) map onto the spec enums.
const MAP = {
  greeting: ['casual', 'direct'],
  small_talk: ['casual', 'direct'],
  rapport: ['casual', 'direct'],
  casual: ['casual', 'direct'],
  clarification: ['clarification', 'clarify'],
  behavioral: ['behavioral', 'star'],
  motivation: ['biographical', 'direct'],
  walkthrough: ['biographical', 'explain'],
  biographical: ['biographical', 'direct'],
  strengths: ['biographical', 'direct'],
  situational: ['strategic', 'recommend'],
  compare: ['technical', 'compare'],
  technical: ['technical', 'explain'],
  factual: ['factual', 'direct'],
  opinion: ['opinion', 'direct'],
  other: ['factual', 'direct'],
  authorization: ['factual', 'direct'],
  compensation: ['factual', 'direct'],
  questions_for_them: ['strategic', 'direct'],
  check_in: ['casual', 'direct'],
  literature: ['technical', 'explain'],
  methodological: ['technical', 'explain'],
  availability: ['factual', 'direct'],
  role_fit: ['biographical', 'direct'],
  project_detail: ['factual', 'direct'],
  experience: ['biographical', 'direct'],
};

/** @param {string} text @param {{ knownEntities?: string[], history?: any[], live?: boolean, meeting?: any }} [opts] */
function understand(text, { knownEntities = [], history = [], live = true, meeting = null } = {}) {
  const literal = String(text || '').trim();
  const kind = classify(literal, { meeting });
  const [questionType, shape] = MAP[kind];
  const n = words(literal).length;
  const personal = /\b(you|your|yourself)\b/i.test(literal);
  const ambiguities = [];
  if (n > 0 && n < 4 && kind !== 'casual' && !SMALL_TALK_KINDS.has(kind)) ambiguities.push('fragment');
  if ((literal.match(/\?/g) || []).length > 1) ambiguities.push('multiple_questions');
  if (/^(and |so )?(what about|how about) (it|that|this)\b/i.test(literal) && !history.length) ambiguities.push('unresolved_reference');
  const timeHorizon = /\b(would|will|going to|plan|future|next|in your first)\b/i.test(literal) ? (/\b(did|was|were|have you|had|time when)\b/i.test(literal) ? 'mixed' : 'future')
    : /\b(did|was|were|have you|had|time when|previous|last)\b/i.test(literal) ? 'past' : 'present';
  const stakes = P.highStakes.test(literal) || kind === 'authorization' || kind === 'compensation' ? 'high'
    : ['behavioral', 'situational', 'motivation', 'strengths', 'availability', 'role_fit'].includes(kind) ? 'medium' : 'low';
  const constraints = (literal.match(P.constraint) || []).length + Math.max(0, (literal.match(/\?/g) || []).length - 1);
  const needsCalc = P.calc.test(literal);
  const needsPersonal = ['behavioral', 'motivation', 'biographical', 'walkthrough', 'strengths', 'factual', 'opinion', 'role_fit', 'availability', 'project_detail'].includes(kind) || (personal && kind !== 'casual' && kind !== 'clarification' && !SMALL_TALK_KINDS.has(kind));
  // In live meetings we cannot pause to ask; only a contentless fragment needs a clarification.
  const needsClarification = ambiguities.includes('fragment') && n < 3 && !live ? true : (ambiguities.includes('unresolved_reference') && !live);
  return {
    literal_question: literal,
    underlying_intent: INTENT[kind],
    question_type: questionType,
    kind,
    // 'greeting' | 'small_talk' | 'rapport' when the whole utterance is a pleasantry, else null.
    small_talk: smallTalkKind(literal),
    expected_answer_shape: shape,
    competencies_being_tested: kind === 'behavioral' || kind === 'strengths' || kind === 'situational' ? inferCompetencies(literal) : [],
    entities: entitiesIn(literal, knownEntities),
    time_horizon: timeHorizon,
    stakes,
    ambiguities,
    needs_personal_evidence: needsPersonal,
    needs_clarification: needsClarification,
    complexity: { constraints, needsCalc, words: n },
  };
}

module.exports = { understand, inferCompetencies, classify, smallTalkKind, SMALL_TALK_KINDS };
