# Feedback on Nebius Token Factory and NVIDIA Nemotron

Written from building Vkin, a real-time meeting copilot where the first token has to arrive in well under
a second and every answer must stay grounded in the user's own evidence.

## What worked well

- **OpenAI-compatible API.** We pointed the official `openai` Node SDK at
  `https://api.tokenfactory.nebius.com/v1/` and changed nothing else: chat completions, streaming and
  error handling worked with our existing provider abstraction. Adding a model is one line in our
  allowlist.
- **Free `/models` endpoint.** Before a benchmark we confirmed that all five models we configure were
  available by calling `GET /v1/models`, which costs nothing. That made "is this model ID still valid?" a
  safe automated check.
- **Model range on one platform.** Having Nemotron-3.5-Lightning, Nemotron-3-Ultra and Qwen3 models behind
  one key and one API let us run a fair same-run comparison and keep a fallback on the same platform.
- **Nemotron-3.5-Lightning for real time.** On our 23-question grounded-answer set, Lightning matched
  Ultra's raw grounding (78% each) with a 295 ms first-token p50 versus 845 ms, at about $0.0003 versus
  $0.0043 per answer. For live conversation that is the difference between usable and not.
- **Nemotron-3-Ultra as the "think harder" option.** Users click "Deeper answer" for the cases where
  depth matters more than speed; Ultra fits that role well.
- **Low cost for experimentation.** The full live benchmark across models cost us $0.159.

## Friction we hit

- **Pricing page needs JavaScript.** Our budget guard refuses any call whose model has no known price, so
  we keep a local price list. The pricing page did not render without JavaScript, so we could not fetch
  or verify it from a script; prices were copied by hand, and our app treats the list as stale after
  30 days.
- **Reasoning toggles differ per model.** Nemotron Ultra and Lightning needed
  `chat_template_kwargs: { enable_thinking: false }` for live use; in an early probe, Ultra wrote its
  reasoning as the answer when thinking was on. Another model on the platform needed
  `chat_template_kwargs: { thinking: false }` instead, and before we found that, its hidden reasoning used
  the whole token budget and returned empty answers. We discovered each of these by probing.
- **Raw grounding has headroom.** Both Nemotron models reached 78% raw grounding on our set, below our
  90% policy bar, and Lightning made one forbidden-claim slip (which our validator blocked). That is
  partly our prompts; clearer guidance on grounding and refusal behaviour for these models would help.

## Suggestions

1. **Machine-readable pricing,** for example price fields in `/v1/models` or a small pricing JSON
   endpoint, so cost guards can verify prices automatically instead of relying on hand-copied lists.
2. **Capability metadata in `/v1/models`:** whether a model reasons, the exact parameter to turn thinking
   off, context length and maximum output tokens. One documented, uniform switch across reasoning models
   would be even better.
3. **Docs for real-time use:** a short page on getting the lowest first-token latency (thinking off,
   streaming, recommended `max_tokens`), with typical p50 numbers per model.
4. **Streaming usage guidance:** a clear statement of how and when token usage is reported in streamed
   responses, so proxies can meter every request precisely.
5. **Provider-side hard caps per key** (if not already offered): we built our own pre-request guard and
   spend caps; a cap enforced by the platform would be a valuable second layer.

Thank you to the Nebius and NVIDIA teams: the combination of fast Nemotron models and a drop-in
OpenAI-compatible API made it possible to build and measure this in a hackathon timeframe.
