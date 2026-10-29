// @ts-check
// Turn state machine + answer lifecycle.
// Only the THEM channel triggers answers. ME is context only (experimental echo filter).
const crypto = require('crypto');
const { smallTalkKind } = require('./understand');
const { ANSWER_EVENTS, UI_EVENTS, newGenId, nextSeq } = require('../shared/contracts');

const QUESTION_START = /^(so,?\s+|and\s+|okay,?\s+|ok,?\s+|alright,?\s+|great,?\s+)?(what|why|how|when|where|which|who|whose|can|could|would|will|do|does|did|are|is|have|has|tell|walk|describe|explain|talk|give|share|help)\b/i;
const PROMPT_PHRASE = /\b(tell me|walk me through|talk (me )?(through|about)|can you|could you|would you|what('s| is| was| are)|how (do|did|would|have)|why (did|do|would)|give me an example|describe|explain)\b/i;
// "Answer that again", "that's not what I asked": they want the previous question answered better, not a new one.
const REASK = /\b(answer (that|it|this|the question|my question) again|(you )?(didn'?t|did not|haven'?t) (really |quite )?answer(ed)?( (that|it|my question|the question))?|that'?s not (really |quite )?what i (asked|meant|was asking)|not what i (asked|was asking)|let me (rephrase|ask (it|that|you) again|ask again|try again)|(can|could|would) you (try|answer) (that |it |this )?again|try (that|it) again|go back to (my|the) question|(can|could) you be more specific|more specifically|i('m| am| was) asking (about|you)|what i('m| am| was) asking (is|was)|no,? i mean|i meant)\b/i;

// Typed edit commands for the current answer (the overlay chips and similar), as opposed to a new question.
const REFINE = /^\s*(shorter|longer|more detail|less detail|add an example|simpler( words)?|simplify|ask them a question back|rephrase|reword|rewrite|make it|say it|in fewer words|more concise|less technical|more technical|more formal|more casual|more confident|tone it|drop the|remove|cut the|add )/i;
const ACK = /^(ok(ay)?|great|thanks?( you)?|thank you|right|sure|got it|perfect|cool|nice|yes|yeah|yep|no|hmm+|mm+|uh-?huh|i see|makes sense|interesting|wonderful|awesome|good)\b[\s\S]{0,30}$/i;
const CONTINUATION = /^(and|or|but|also|plus|the|a|an|for|in|on|of|about|with|without|from|to|at|by|like|specifically|especially|particularly|including|which|that|when|where|whether|if|as well|in terms of|regarding|on the|for the|you know|i mean)\b/i;

// A history line as the answer engine sees it; `at` (when it ended) orders typed and spoken instructions in screen coding mode.
const snap = ({ speaker, text, endedAt }) => ({ speaker, text, at: endedAt });

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
}

// Stable hash of the normalized transcript, so an answer can be tied to the exact text it answered.
function textHash(text) {
  return crypto.createHash('sha256').update(normalize(text)).digest('hex').slice(0, 16);
}

function wordCount(text) {
  const n = normalize(text);
  return n ? n.split(' ').length : 0;
}

// Decides whether a finished THEM utterance deserves a suggested reply.
function assessUtterance(text, minWords = 6) {
  const words = wordCount(text);
  const questionLike = /\?\s*$/.test(String(text).trim()) || QUESTION_START.test(String(text).trim()) || PROMPT_PHRASE.test(text);
  if (words < 3) return { eligible: false, questionLike, words };
  return { eligible: questionLike || words >= minWords, questionLike, words };
}

function jaccard(a, b) {
  const A = new Set(normalize(a).split(' ').filter(Boolean));
  const B = new Set(normalize(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

class AnswerController {
  // deps: {buildMessages(question, history) -> messages, llm:{stream}, emit(type, payload), now(), staleTurnGuard?}
  constructor(deps) {
    this.deps = deps;
    this.current = null; // {genId, seq, turnId, revision, kind, question, text, controller, done, triggeredAt}
    this.lastConfirmed = null; // {genId, question, text}
    this.log = []; // finished answers in order: {question, text}; the conversation memory for later turns
    this.logSeq = 0; // increments on every remembered answer (the log is capped, so its length is no version)
  }

  // Partial-transcript preparation (FABEL_PARTIAL_PREP, PRD Phase 4): on a stable partial (Flux
  // EagerEndOfTurn) the local build (understanding, retrieval, prompt) runs ahead of the confirmed end of
  // turn. Nothing billable happens here. The confirmed answer reuses the build only when the text,
  // history and conversation are unchanged; any material revision drops it.
  prepSig(question, history) {
    const last = history.length ? history[history.length - 1].text : '';
    return `${textHash(question)}:${history.length}:${textHash(last)}:${this.logSeq}`;
  }

  prepare({ question, history = [] }) {
    if (!this.deps.partialPrep) return false;
    const sig = this.prepSig(question, history);
    if (this.prepared && this.prepared.sig === sig) return true;
    const extra = { conversation: this.log.slice(-6), prepare: true };
    const startedAt = this.deps.now();
    const promise = Promise.resolve().then(() => this.deps.buildMessages(question, history, extra))
      .then((built) => ({ built, buildMs: this.deps.now() - startedAt }));
    promise.catch(() => {});
    this.prepared = { sig, promise };
    return true;
  }

  invalidatePrepared() {
    this.prepared = null;
  }

  takePrepared(question, history) {
    const p = this.prepared;
    this.prepared = null;
    return p && p.sig === this.prepSig(question, history) ? p.promise : null;
  }

  remember(question, text) {
    const answer = String(text || '').replace(/^\s*SAY:\s*/i, '').trim();
    if (!answer || !String(question || '').trim()) return;
    this.log.push({ question: String(question).trim(), answer });
    this.logSeq += 1;
    if (this.log.length > 20) this.log.shift();
  }

  // Every answer event of a generation carries its seq when the stale-turn guard is on (contracts.js).
  emitGen(gen, type, payload) {
    this.deps.emit(type, gen.seq === undefined ? payload : { ...payload, seq: gen.seq });
  }

  // Dialogue state (FABEL_DIALOGUE_STATE_V2): a non-speculative answer reaching `done` has been shown.
  markDisplayed(gen, meta) {
    if (!this.deps.dialogueState) return;
    this.deps.dialogueState.answerDisplayed(gen.genId, { storyId: meta && meta.storyId, exampleIds: meta && meta.exemplarIds });
  }

  // The user actually spoke the suggested answer (an explicit action, e.g. Copy). Only then is it "spoken".
  markSpoken(genId) {
    return this.deps.dialogueState ? this.deps.dialogueState.answerSpoken(genId) : false;
  }

  start({ question, turnId = null, revision = 0, textHash: hash = null, kind, history = [], triggeredAt, extra = null }) {
    this.cancelCurrent('superseded');
    // A plain confirmed answer may reuse a build prepared from the partial transcript (same text/history).
    const prepared = !extra ? this.takePrepared(question, history) : (this.prepared = null);
    // Every answer sees the recent exchanges (questions asked and what was already answered).
    extra = { conversation: this.log.slice(-6), ...(extra || {}) };
    const genId = newGenId();
    // Allocated after cancelCurrent(), so the superseded generation's invalidate carries the lower seq.
    const seq = this.deps.staleTurnGuard ? nextSeq() : undefined;
    const controller = new AbortController();
    const gen = { genId, seq, turnId, revision, kind, question, text: '', controller, done: false, triggeredAt: triggeredAt ?? this.deps.now() };
    this.current = gen;
    if (this.deps.dialogueState) {
      this.deps.dialogueState.noteTurn(turnId || genId);
      this.deps.dialogueState.answerGenerated({ answerId: genId, turnId: turnId || genId, kind });
    }
    const emit = (type, payload) => this.emitGen(gen, type, payload);
    emit(ANSWER_EVENTS.START, { genId, turnId, revision, textHash: hash, kind, question, request: extra ? extra.request : undefined, revisionOf: extra ? extra.revisionOf : undefined });
    const isLive = () => this.current === gen && !controller.signal.aborted;
    let firstAt = 0;
    // Per-stage timing (PRD Phase 4): local build, end-of-turn -> dispatch, provider TTFT, streaming, validation.
    const stage = { buildMs: null, prepHit: Boolean(prepared) };
    gen.prepHit = stage.prepHit;
    // A regeneration of a prepared answer must also defer its side effects: the prepared build's deferred
    // question note is never committed, because the rejected draft is never delivered.
    const prepFlag = stage.prepHit ? { prepare: true } : {};
    const telemetry = (row) => { if (this.deps.telemetry) this.deps.telemetry.record({ turn: turnId || genId, ...row }); };

    const buildStartedAt = this.deps.now();
    Promise.resolve()
      .then(() => (prepared
        ? prepared.then((p) => { stage.buildMs = p.buildMs; return p.built; })
        : Promise.resolve(this.deps.buildMessages(question, history, extra)).then((b) => { stage.buildMs = this.deps.now() - buildStartedAt; return b; })))
      .then((built) => {
        // buildMessages returns a messages array (legacy) or { messages, meta } (answer engine).
        const { messages, meta } = Array.isArray(built) ? { messages: built, meta: null } : built;
        gen.meta = meta;
        return this.deps.llm.stream({
          messages,
          turnId: genId,
          signal: controller.signal,
          ...(meta ? { maxOutputTokens: meta.maxOutputTokens, route: meta.route } : {}),
          onDelta: (t) => {
            if (!isLive()) return;
            if (!firstAt) firstAt = this.deps.now();
            gen.text += t;
            emit(ANSWER_EVENTS.DELTA, { genId, text: t });
          },
        });
      })
      .then((res) => {
        if (!isLive()) return;
        const meta = gen.meta;
        const doneAt = this.deps.now();
        const timings = {
          eotToFirstTokenMs: firstAt ? firstAt - gen.triggeredAt : null,
          totalMs: doneAt - gen.triggeredAt,
          buildMs: stage.buildMs,
          eotToDispatchMs: res && Number.isFinite(res.dispatchedAt) ? res.dispatchedAt - gen.triggeredAt : null,
          providerTtftMs: res && Number.isFinite(res.ttftMs) ? res.ttftMs : null,
          streamMs: firstAt ? doneAt - firstAt : null,
          validateMs: null,
          prepHit: stage.prepHit,
        };
        const row = {
          kind: gen.kind, route: res && res.route, provider: res && res.provider, model: res && res.model, fallback: res && res.fallbackReason,
          ...timings, inputTokens: res && res.usage && res.usage.prompt_tokens, outputTokens: res && res.usage && res.usage.completion_tokens,
          estimatedUsd: res && res.estimatedUsd, finalUsd: res && res.finalUsd,
          question_type: meta && meta.understanding.question_type, shape: meta && meta.understanding.expected_answer_shape,
          storyId: meta && meta.storyId, sourceCount: meta && meta.sourceIds.length, promptTokensEst: meta && meta.promptTokensEst,
          regenerated: Boolean(extra && extra.regenerate),
          // Which screen route fed this answer (label only; the screen text never reaches telemetry).
          screen: extra && extra.screen ? extra.screen.source : undefined,
        };
        const validateStartedAt = this.deps.now();
        const v = this.deps.validate && meta ? this.deps.validate(gen.text, meta) : null;
        timings.validateMs = v ? this.deps.now() - validateStartedAt : null;
        row.validateMs = timings.validateMs;
        const claims = v ? v.unsupported_claims.map((u) => ({ claim: String(u.claim).slice(0, 80), kind: u.kind, reason: u.reason })) : [];
        // Stable mode: the answer on screen changes at most once. Unsupported sentences are cut at once; a
        // rewrite happens only when too much was cut, runs hidden, and replaces the text in one step.
        if (v && !v.ok && !(extra && extra.regenerate) && this.deps.stableRewrite && this.deps.trim) {
          return this.stableFix({ gen, meta, v, claims, row, question, history, extra, isLive, telemetry, res, timings });
        }
        if (v && !v.ok && !(extra && extra.regenerate) && this.deps.regenerateOnFail !== false) {
          // Reject once and regenerate; the flawed draft never becomes "done", so displays drop it.
          emit(ANSWER_EVENTS.VALIDATED, { genId, ok: false, action: 'regenerating', unsupported: claims, confidence: v.confidence });
          telemetry({ ...row, validated: false, unsupported: claims.length });
          gen.done = true;
          gen.rejected = true;
          // Same kind (a speculative draft stays speculative so promote/invalidate still apply) and the same evidence.
          this.start({ question, turnId, revision, textHash: hash, kind: gen.kind, history, triggeredAt: gen.triggeredAt,
            extra: { ...(extra || {}), ...prepFlag, regenerate: { unsupported: v.unsupported_claims, previous: gen.text, meta }, revisionOf: genId } });
          return;
        }
        gen.done = true;
        let trimmed = false;
        if (v && !v.ok) {
          // Second failure: remove unsupported sentences rather than show them.
          gen.text = this.deps.trim ? this.deps.trim(gen.text, v.unsupported_claims, meta) : gen.text;
          trimmed = true;
          emit(ANSWER_EVENTS.REPLACE, { genId, text: gen.text });
        }
        if (this.deps.polish && meta) {
          const polished = this.deps.polish(gen.text, meta);
          if (polished !== gen.text) { gen.text = polished; emit(ANSWER_EVENTS.REPLACE, { genId, text: gen.text }); }
        }
        if (v) emit(ANSWER_EVENTS.VALIDATED, { genId, ok: v.ok || trimmed, action: trimmed ? 'trimmed' : 'checked', unsupported: claims, warnings: v.warnings.length, confidence: v.confidence });
        if (gen.kind !== 'speculative') { this.lastConfirmed = { genId, question, text: gen.text }; this.remember(question, gen.text); this.markDisplayed(gen, meta); }
        // A speculative draft is not "told" until it is promoted (see promote()).
        if (this.deps.onAnswerDone && meta && gen.kind !== 'speculative') this.deps.onAnswerDone(meta);
        emit(ANSWER_EVENTS.DONE, { genId, model: res && res.model, route: res && res.route, provider: res && res.provider, fallback: res && res.fallbackReason, hedged: false, timings });
        telemetry({ ...row, validated: v ? v.ok : undefined, unsupported: claims.length, trimmed });
      })
      .catch((err) => {
        if (!isLive()) return;
        gen.done = true;
        const regen = extra && extra.regenerate;
        if (regen && this.deps.trim && regen.meta) {
          // The rewrite failed (blocked, 5xx...): show the first draft with unsupported parts removed instead of an error.
          gen.text = this.deps.trim(regen.previous, regen.unsupported, regen.meta);
          emit(ANSWER_EVENTS.REPLACE, { genId, text: gen.text });
          emit(ANSWER_EVENTS.VALIDATED, { genId, ok: true, action: 'trimmed', unsupported: regen.unsupported.map((u) => ({ claim: String(u.claim).slice(0, 80), kind: u.kind, reason: u.reason })), warnings: 0, confidence: 0.5 });
          if (gen.kind !== 'speculative') {
            this.lastConfirmed = { genId, question, text: gen.text };
            this.remember(question, gen.text);
            this.markDisplayed(gen, regen.meta);
            if (this.deps.onAnswerDone) this.deps.onAnswerDone(regen.meta);
          }
          gen.meta = regen.meta;
          emit(ANSWER_EVENTS.DONE, { genId, timings: { eotToFirstTokenMs: null, totalMs: this.deps.now() - gen.triggeredAt } });
          telemetry({ kind: gen.kind, regenerated: true, trimmed: true, error: String((err && err.code) || 'error').slice(0, 60) });
          return;
        }
        gen.error = true;
        emit(ANSWER_EVENTS.ERROR, { genId, message: String((err && err.message) || err) });
        telemetry({ kind: gen.kind, error: String((err && err.code) || 'error').slice(0, 60) });
      });
    return genId;
  }

  /** Stable-mode repair of a draft that failed validation (see start()). */
  async stableFix({ gen, meta, v, claims, row, question, history, extra, isLive, telemetry, res, timings }) {
    const emit = (type, payload) => this.emitGen(gen, type, payload);
    const words = (s) => String(s || '').replace(/^\s*SAY:\s*/i, '').split(/\s+/).filter(Boolean).length;
    const finish = (text, action, ok, extraRow = {}) => {
      if (!isLive()) return;
      const finalText = this.deps.polish ? this.deps.polish(text, meta) : text;
      if (finalText !== gen.text) { gen.text = finalText; emit(ANSWER_EVENTS.REPLACE, { genId: gen.genId, text: gen.text }); }
      gen.done = true;
      emit(ANSWER_EVENTS.VALIDATED, { genId: gen.genId, ok, action, unsupported: claims, warnings: v.warnings.length, confidence: v.confidence });
      if (gen.kind !== 'speculative') { this.lastConfirmed = { genId: gen.genId, question, text: gen.text }; this.remember(question, gen.text); this.markDisplayed(gen, meta); }
      if (this.deps.onAnswerDone && gen.kind !== 'speculative') this.deps.onAnswerDone(meta);
      emit(ANSWER_EVENTS.DONE, { genId: gen.genId, model: res && res.model, route: res && res.route, provider: res && res.provider, fallback: res && res.fallbackReason, hedged: false, timings: { ...timings, totalMs: this.deps.now() - gen.triggeredAt } });
      telemetry({ ...row, validated: false, unsupported: claims.length, trimmed: action === 'trimmed', regenerated: action === 'rewritten', ...extraRow });
    };
    const trimmed = this.deps.trim(gen.text, v.unsupported_claims, meta);
    const keep = words(trimmed) / Math.max(1, words(gen.text));
    // Enough is left: show the trimmed answer and stop. One visible change.
    if (keep >= 0.6 && words(trimmed) >= 45) return finish(trimmed, 'trimmed', true);
    // Too much was cut: show the trimmed text now, then rewrite out of sight and swap once.
    gen.text = trimmed;
    emit(ANSWER_EVENTS.REPLACE, { genId: gen.genId, text: gen.text });
    emit(ANSWER_EVENTS.VALIDATED, { genId: gen.genId, ok: true, action: 'improving', unsupported: claims, warnings: v.warnings.length, confidence: v.confidence });
    try {
      const built = await this.deps.buildMessages(question, history, { ...(extra || {}), ...(gen.prepHit ? { prepare: true } : {}), regenerate: { unsupported: v.unsupported_claims, previous: gen.text, meta } });
      const { messages, meta: meta2 } = Array.isArray(built) ? { messages: built, meta } : built;
      let text = '';
      const r2 = await this.deps.llm.stream({ messages, turnId: gen.genId, signal: gen.controller.signal, ...(meta2 ? { maxOutputTokens: meta2.maxOutputTokens, route: meta2.route } : {}), onDelta: (t) => { text += t; } });
      if (!isLive()) return;
      const v2 = this.deps.validate ? this.deps.validate(text, meta2 || meta) : { ok: true };
      const fixed = v2.ok ? text : this.deps.trim(text, v2.unsupported_claims, meta2 || meta);
      // Keep whichever version says more of what was asked.
      return finish(words(fixed) >= words(trimmed) ? fixed : trimmed, 'rewritten', true, { finalUsd2: r2 && r2.finalUsd });
    } catch (_err) {
      return finish(trimmed, 'trimmed', true, { error: 'rewrite_failed' });
    }
  }

  // Speculative answer for this exact turn/revision becomes confirmed.
  promote(turnId, revision) {
    const g = this.current;
    if (!g || g.error || g.kind !== 'speculative' || g.turnId !== turnId || g.revision !== revision) return false;
    g.kind = 'confirmed';
    this.emitGen(g, ANSWER_EVENTS.PROMOTE, { genId: g.genId });
    if (g.done) {
      this.lastConfirmed = { genId: g.genId, question: g.question, text: g.text };
      this.remember(g.question, g.text);
      this.markDisplayed(g, g.meta);
      if (this.deps.onAnswerDone && g.meta) this.deps.onAnswerDone(g.meta);
    }
    // Not finished yet: kind is now 'confirmed', so the normal done path in start()/stableFix() records it.
    return true;
  }

  // Drop the speculative answer for a turn (speech resumed or final text differed).
  invalidateSpeculative(turnId, reason) {
    const g = this.current;
    if (!g || g.kind !== 'speculative' || g.turnId !== turnId) return false;
    return this.cancelCurrent(reason);
  }

  cancelCurrent(reason) {
    const g = this.current;
    if (!g) return false;
    this.current = null;
    g.controller.abort();
    // Dialogue state: a cancelled/superseded generation can never count as delivered (the module keeps
    // an already-displayed answer's truth, so this is a no-op once it has reached the user).
    if (this.deps.dialogueState) {
      if (reason === 'superseded') this.deps.dialogueState.answerSuperseded(g.genId);
      else this.deps.dialogueState.answerCancelled(g.genId);
    }
    // A finished confirmed/manual answer is not invalidated; displays move it to "previous".
    if (g.kind === 'speculative' || !g.done) {
      this.emitGen(g, ANSWER_EVENTS.INVALIDATE, { genId: g.genId, reason });
      if (!g.done && !g.rejected && this.deps.telemetry) this.deps.telemetry.record({ turn: g.turnId || g.genId, kind: g.kind, cancelled: true, error: String(reason).slice(0, 40) });
    }
    return true;
  }
}

class TurnManager {
  // deps: AnswerController deps + {sessionId, config:{minWords, echoWindowMs, echoJaccard, historyTurns}}
  constructor(deps) {
    this.deps = deps;
    this.cfg = { minWords: 6, echoWindowMs: 5000, echoJaccard: 0.6, historyTurns: 8, speculativeLlm: true, ...(deps.config || {}) };
    this.answers = deps.answers || new AnswerController(deps);
    this.dialogueState = deps.dialogueState || null;
    this.open = { them: null, me: null };
    this.epochs = { them: 0, me: 0 };
    this.history = []; // {speaker:'THEM'|'ME', text, endedAt, turnId}
    this.lastQuestion = null;
    // Manual mode (PRD runtime control): questions are tracked but nothing is generated until the
    // user asks (hotkey/Answer button).
    this.autoAnswer = this.cfg.autoAnswer !== false;
    this.pendingManual = null; // {question, turnId} waiting for the Answer hotkey in manual mode
  }

  setAutoAnswer(value) {
    this.autoAnswer = value !== false;
    if (this.autoAnswer) this.pendingManual = null;
    return this.autoAnswer;
  }

  // "Clear topic": the next THEM fragment can no longer merge into, or re-ask, the previous question.
  clearTopic() {
    this.lastQuestion = null;
    this.lastQuestionAt = 0;
    this.pendingManual = null;
  }

  // Flux restarts turn_index at 0 on every new connection, so each Start/reconnect gets a new epoch.
  newEpoch(channel) {
    this.epochs[channel] = (this.epochs[channel] || 0) + 1;
    this.open[channel] = null;
    if (channel === 'them') {
      // A reconnect must not let a fragment merge/re-ask against a question from before the gap.
      this.lastQuestion = null;
      this.lastQuestionAt = 0;
      if (this.answers.current) this.answers.invalidateSpeculative(this.answers.current.turnId, 'restarted');
    }
  }

  turnId(channel, turnIndex) {
    return `${channel}:${this.deps.sessionId}.${this.epochs[channel] || 0}:${turnIndex}`;
  }

  historyFor(excludeTurnId) {
    return this.history.filter((h) => h.turnId !== excludeTurnId).slice(-this.cfg.historyTurns)
      .map(snap);
  }

  onSttEvent(ev) {
    if (!ev || !ev.event) return;
    if (ev.channel === 'me') return this.onMe(ev);
    if (ev.channel === 'them') return this.onThem(ev);
  }

  ensureTurn(ev) {
    const id = this.turnId(ev.channel, ev.turnIndex);
    let t = this.open[ev.channel];
    if (!t || t.turnId !== id) {
      t = { turnId: id, channel: ev.channel, revision: 0, text: '', status: 'open', eagerText: null };
      this.open[ev.channel] = t;
    }
    if (ev.transcript) t.text = ev.transcript;
    return t;
  }

  emitTranscript(t, extra = {}) {
    this.deps.emit(UI_EVENTS.TRANSCRIPT, { channel: t.channel, turnId: t.turnId, text: t.text, status: t.status, ...extra });
  }

  onThem(ev) {
    const t = this.ensureTurn(ev);
    const now = this.deps.now();
    switch (ev.event) {
      case 'StartOfTurn':
      case 'Update':
        this.emitTranscript(t);
        break;
      case 'EagerEndOfTurn': {
        t.status = 'eager';
        t.eagerText = t.text;
        this.emitTranscript(t);
        // Speculate only on question-like text: monologues flap Eager/Resumed and would burn LLM calls.
        const a = assessUtterance(t.text, this.cfg.minWords);
        // $40 mode (speculativeLlm=false): EagerEndOfTurn never starts a billable call.
        if (this.cfg.speculativeLlm && this.autoAnswer && a.eligible && a.questionLike) {
          this.answers.start({ question: t.text, turnId: t.turnId, revision: t.revision, textHash: textHash(t.text), kind: 'speculative', history: this.historyFor(t.turnId), triggeredAt: now });
        } else if (this.autoAnswer && a.eligible && a.questionLike) {
          // Prepare early, spend late: local preparation only; the paid call waits for EndOfTurn.
          this.answers.prepare({ question: t.text, history: this.historyFor(t.turnId) });
        }
        break;
      }
      case 'TurnResumed':
        t.status = 'open';
        t.revision += 1;
        t.eagerText = null;
        this.answers.invalidatePrepared();
        this.answers.invalidateSpeculative(t.turnId, 'resumed');
        this.emitTranscript(t);
        break;
      case 'EndOfTurn': {
        t.status = 'final';
        this.emitTranscript(t);
        this.open.them = null;
        if (!t.text.trim()) break;
        this.history.push({ speaker: 'THEM', text: t.text, endedAt: now, turnId: t.turnId });
        const sameText = t.eagerText !== null && normalize(t.eagerText) === normalize(t.text);
        if (sameText && this.answers.promote(t.turnId, t.revision)) {
          this.lastQuestion = t.text;
          break;
        }
        this.answers.invalidateSpeculative(t.turnId, 'final-text-changed');
        if (!this.autoAnswer) {
          // Manual mode: remember the question for the hotkey and tell the displays one is waiting.
          const m = assessUtterance(t.text, this.cfg.minWords);
          if (m.eligible && m.questionLike) {
            this.lastQuestion = t.text;
            this.lastQuestionAt = now;
            // The question shown as waiting is the one Answer will answer, even if they keep talking.
            this.pendingManual = { question: t.text, turnId: t.turnId };
            this.deps.emit('manualPending', { turnId: t.turnId, question: t.text });
          }
          break;
        }
        // Not satisfied ("answer that again"): answer the previous question again, better and differently.
        if (this.lastQuestion && REASK.test(t.text)) {
          const prev = this.answers.lastConfirmed && this.answers.lastConfirmed.question === this.lastQuestion ? this.answers.lastConfirmed.text
            : (this.answers.current && this.answers.current.question === this.lastQuestion ? this.answers.current.text : '');
          // A re-ask that also contains the real question ("no, I mean what data did you use?") keeps both.
          const rest = t.text.replace(new RegExp(REASK.source, 'gi'), ' ')
            .replace(/\b(hmm+|um+|uh+|okay|ok|so|well|can you|could you|please|i don'?t think|i do not think|sorry)\b/gi, ' ');
          const question = wordCount(rest) >= 5 ? `${this.lastQuestion} ${t.text}` : this.lastQuestion;
          this.lastQuestionAt = now;
          this.answers.start({ question, turnId: t.turnId, revision: t.revision, textHash: textHash(question), kind: 'confirmed', history: this.historyFor(t.turnId), triggeredAt: now,
            extra: { reask: t.text, previousAnswer: prev || '' } });
          break;
        }
        // A pause split one question in two: a fragment right after a question continues it.
        // Only when it reads as a continuation ("and...", "in the...", "where..."), never for acknowledgements
        // like "okay, great" or statements like "take your time".
        const frag = t.text.trim();
        const continuing = this.lastQuestion && this.lastQuestionAt && now - this.lastQuestionAt <= (this.cfg.mergeWindowMs || 8000)
          && !QUESTION_START.test(frag) && wordCount(frag) <= 25 && !ACK.test(frag) && CONTINUATION.test(frag);
        if (continuing) {
          const question = `${this.lastQuestion} ${t.text}`;
          this.lastQuestion = question;
          this.lastQuestionAt = now;
          this.answers.start({ question, turnId: t.turnId, revision: t.revision, textHash: textHash(question), kind: 'confirmed', history: this.historyFor(t.turnId), triggeredAt: now });
          break;
        }
        // Auto-answer questions only; statements ('take your time...') would replace the answer being read.
        const a = assessUtterance(t.text, this.cfg.minWords);
        if (a.eligible && a.questionLike) {
          this.lastQuestion = t.text;
          this.lastQuestionAt = now;
          this.answers.start({ question: t.text, turnId: t.turnId, revision: t.revision, textHash: textHash(t.text), kind: 'confirmed', history: this.historyFor(t.turnId), triggeredAt: now });
        }
        break;
      }
      default:
        break;
    }
  }

  isEcho(text, now) {
    return this.history.some((h) => h.speaker === 'THEM' && now - h.endedAt <= this.cfg.echoWindowMs && jaccard(h.text, text) >= this.cfg.echoJaccard)
      || (this.open.them && jaccard(this.open.them.text, text) >= this.cfg.echoJaccard);
  }

  onMe(ev) {
    const t = this.ensureTurn(ev);
    if (ev.event !== 'EndOfTurn') {
      this.emitTranscript(t);
      return;
    }
    t.status = 'final';
    this.open.me = null;
    const now = this.deps.now();
    const echo = this.isEcho(t.text, now);
    this.emitTranscript(t, { echo });
    if (!echo && t.text.trim()) this.history.push({ speaker: 'ME', text: t.text, endedAt: now, turnId: t.turnId });
  }

  // Hotkey: answer whatever THEM is saying now, else their last finished turn.
  manualAnswer() {
    if (this.pendingManual) {
      const p = this.pendingManual;
      this.pendingManual = null;
      this.lastQuestion = p.question;
      return this.answers.start({ question: p.question, turnId: p.turnId, revision: 0, kind: 'manual', history: this.historyFor(p.turnId) });
    }
    const live = this.open.them && this.open.them.text.trim() ? this.open.them : null;
    const lastThem = [...this.history].reverse().find((h) => h.speaker === 'THEM');
    const question = live ? live.text : lastThem && lastThem.text;
    if (!question) return null;
    this.lastQuestion = question;
    const excludeId = live ? live.turnId : lastThem.turnId;
    return this.answers.start({ question, turnId: excludeId, revision: live ? live.revision : 0, kind: 'manual', history: this.historyFor(excludeId) });
  }

  // Screen context (PRD Phase 5): ONE answer that also sees what was on the screen. Uses the question
  // typed in the screen panel, else what THEM is asking now or asked last, else a general help request.
  /** @param {{ screen?: { text: string, source: string }, question?: string }} [req] */
  answerWithScreen({ screen, question = '' } = {}) {
    if (!screen || !screen.text) return null;
    const typed = String(question || '').trim();
    const live = this.open.them && this.open.them.text.trim() ? this.open.them : null;
    const lastThem = [...this.history].reverse().find((h) => h.speaker === 'THEM');
    const q = typed || (live ? live.text : lastThem ? lastThem.text : '');
    const history = this.history.slice(-this.cfg.historyTurns).map(snap);
    if (!q) return this.answers.start({ question: 'Help me respond to what is on my screen.', kind: 'manual', history, extra: { typed: true, screen } });
    if (!typed) { this.lastQuestion = q; this.lastQuestionAt = this.deps.now(); }
    return this.answers.start({ question: q, kind: 'manual', history, extra: { screen, ...(typed ? { typed: true } : {}) } });
  }

  // Typed request from the overlay chat. Refines the given (or last) answer when there is one.
  /** @param {{ text?: string, question?: string, previousAnswer?: string }} [req] */
  chat({ text, question, previousAnswer } = {}) {
    const request = String(text || '').trim();
    if (!request) return null;
    // A typed question (often what the other person just asked) gets its own answer, informed by the
    // conversation so far. Only edit commands ("shorter", "simpler words") rewrite the previous answer.
    // Questions to the copilot itself ("what should I say?") stay private requests.
    const toCoach = /\b(should i|do i|can i|could i|shall i|how (do|should|can|could) i|what (do|should|can|could) i|help me|for me to (say|answer)|my answer|i want to (say|mention)|tell me what to say)\b/i.test(request);
    // A greeting or small talk ("hey how are you", no question mark) is a new thing to answer, never an edit of the last answer.
    if (!REFINE.test(request) && (smallTalkKind(request) || (!toCoach && (assessUtterance(request, this.cfg.minWords).questionLike || wordCount(request) >= 6)))) {
      this.lastQuestion = request;
      this.lastQuestionAt = this.deps.now();
      const history = this.history.slice(-this.cfg.historyTurns).map(snap);
      return this.answers.start({ question: request, kind: 'manual', history, extra: { typed: true } });
    }
    const q = question !== undefined ? question : this.lastQuestion;
    const prev = previousAnswer !== undefined ? previousAnswer : (this.answers.lastConfirmed && this.answers.lastConfirmed.question === q ? this.answers.lastConfirmed.text : '');
    const history = this.history.slice(-this.cfg.historyTurns).map(snap);
    return this.answers.start({ question: q || '', kind: 'manual', history, extra: { request, previousAnswer: prev || '' } });
  }

  // The user acted on a suggested answer (e.g. copied it): mark it spoken in the dialogue state.
  markSpoken(genId) {
    return this.answers.markSpoken(genId);
  }

  // deep: the user asked for a deeper answer; the router may use the gated deep route (Phase 4).
  regenerate({ deep = false } = {}) {
    if (!this.lastQuestion) return this.manualAnswer();
    const prior = this.history.filter((h) => h.text !== this.lastQuestion);
    return this.answers.start({ question: this.lastQuestion, kind: 'manual', history: prior.slice(-this.cfg.historyTurns).map(snap),
      ...(deep ? { extra: { requestDeep: true } } : {}) });
  }
}

module.exports = { TurnManager, AnswerController, assessUtterance, jaccard, normalize, textHash };
