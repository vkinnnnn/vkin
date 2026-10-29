import { useState, type FormEvent } from 'react';
import { Check, SelectField, TextArea, TextField } from '../components/ui';
import { DEFAULT_ANSWER_PREFS, parseLines, parseTerms } from '../lib/data';
import type {
  AnswerFormat, AnswerLength, AnswerTone, Copilot, CopilotInput, FillerMode, MemoryScope, StarMode, TechnicalDepth,
} from '../lib/types';

const LENGTHS: { value: AnswerLength; label: string }[] = [
  { value: 'short', label: 'Short' }, { value: 'balanced', label: 'Balanced' }, { value: 'detailed', label: 'Detailed' },
];
const TONES: { value: AnswerTone; label: string }[] = [
  { value: 'conversational', label: 'Conversational' }, { value: 'professional', label: 'Professional' }, { value: 'formal', label: 'Formal' },
];
const STARS: { value: StarMode; label: string }[] = [
  { value: 'auto', label: 'Automatic' }, { value: 'manual', label: 'Manual' }, { value: 'off', label: 'Off' },
];
const FILLERS: { value: FillerMode; label: string }[] = [
  { value: 'none', label: 'None' }, { value: 'subtle', label: 'Subtle' },
];
const DEPTHS: { value: TechnicalDepth; label: string }[] = [
  { value: 'light', label: 'Light' }, { value: 'medium', label: 'Medium' }, { value: 'deep', label: 'Deep' },
];
const FORMATS: { value: AnswerFormat; label: string }[] = [
  { value: 'prose', label: 'Prose' }, { value: 'bullets', label: 'Bullets' },
];
const SCOPES: { value: MemoryScope; label: string }[] = [
  { value: 'thread', label: 'This thread only' }, { value: 'copilot', label: 'All threads of this copilot' },
];

export default function CopilotForm({
  initial, submitLabel, busy, onSubmit,
}: {
  initial?: Copilot;
  submitLabel: string;
  busy: boolean;
  onSubmit: (input: CopilotInput) => void | Promise<void>;
}) {
  const p = { ...DEFAULT_ANSWER_PREFS, ...(initial?.answer_prefs ?? {}) };
  const [name, setName] = useState(initial?.name ?? '');
  const [purpose, setPurpose] = useState(initial?.purpose ?? '');
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [length, setLength] = useState(p.length);
  const [tone, setTone] = useState(p.tone);
  const [star, setStar] = useState(p.star);
  const [filler, setFiller] = useState(p.filler);
  const [depth, setDepth] = useState(p.technical_depth);
  const [format, setFormat] = useState(p.format);
  const [claims, setClaims] = useState((initial?.restricted_claims ?? []).join('\n'));
  const [scope, setScope] = useState<MemoryScope>(initial?.memory_scope ?? 'thread');
  const [useFacts, setUseFacts] = useState(initial?.use_profile_facts ?? true);
  const [keyterms, setKeyterms] = useState((initial?.keyterms ?? []).join('\n'));

  function submit(e: FormEvent) {
    e.preventDefault();
    void onSubmit({
      name,
      purpose,
      instructions,
      answer_prefs: { length, tone, star, filler, technical_depth: depth, format },
      restricted_claims: parseLines(claims),
      memory_scope: scope,
      use_profile_facts: useFacts,
      keyterms: parseTerms(keyterms),
    });
  }

  return (
    <form onSubmit={submit}>
      <fieldset>
        <legend>Basics</legend>
        <TextField label="Name" value={name} onChange={setName} maxLength={120} required hint="For example, “Backend interviews” or “Weekly check-in”." />
        <TextArea label="Purpose" value={purpose} onChange={setPurpose} maxLength={2000} rows={3} hint="What this copilot is for." />
        <TextArea
          label="Instructions" value={instructions} onChange={setInstructions} maxLength={20000} tall
          hint="Standing guidance the copilot follows in every session."
        />
      </fieldset>

      <fieldset>
        <legend>Answer preferences</legend>
        <div className="grid-2">
          <SelectField label="Length" value={length} onChange={setLength} options={LENGTHS} />
          <SelectField label="Tone" value={tone} onChange={setTone} options={TONES} />
          <SelectField label="STAR structure" value={star} onChange={setStar} options={STARS} hint="Situation, Task, Action, Result for behavioral questions." />
          <SelectField label="Filler words" value={filler} onChange={setFiller} options={FILLERS} />
          <SelectField label="Technical depth" value={depth} onChange={setDepth} options={DEPTHS} />
          <SelectField label="Format" value={format} onChange={setFormat} options={FORMATS} />
        </div>
      </fieldset>

      <fieldset>
        <legend>Guardrails and memory</legend>
        <TextArea
          label="Restricted claims" value={claims} onChange={setClaims} rows={4}
          hint="Things the copilot must never claim on your behalf. One per line."
        />
        <TextArea
          label="Keyterms" value={keyterms} onChange={setKeyterms} rows={3}
          hint="Names and terms to recognize correctly in live transcription. One per line or comma-separated."
        />
        <SelectField
          label="Memory scope" value={scope} onChange={setScope} options={SCOPES}
          hint="Whether approved memory is shared across this copilot's threads. It never crosses to other copilots."
        />
        <Check
          label="Use profile facts" checked={useFacts} onChange={setUseFacts}
          hint="Allow this copilot to use the facts you marked as shareable on your profile."
        />
      </fieldset>

      <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
    </form>
  );
}
