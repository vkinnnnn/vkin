// Record shapes follow docs/vkin-contracts.md. user_id is server-owned and is never sent by this app.

export interface BaseRow {
  id: string;
  user_id?: string;
  rev: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type AnswerLength = 'short' | 'balanced' | 'detailed';
export type AnswerTone = 'conversational' | 'professional' | 'formal';
export type StarMode = 'auto' | 'manual' | 'off';
export type FillerMode = 'none' | 'subtle';
export type TechnicalDepth = 'light' | 'medium' | 'deep';
export type AnswerFormat = 'prose' | 'bullets';

export interface AnswerPrefs {
  length: AnswerLength;
  tone: AnswerTone;
  star: StarMode;
  filler: FillerMode;
  technical_depth: TechnicalDepth;
  format: AnswerFormat;
}

export type MemoryScope = 'thread' | 'copilot';

export interface Copilot extends BaseRow {
  name: string;
  purpose: string;
  instructions: string;
  answer_prefs: Partial<AnswerPrefs> | null;
  restricted_claims: string[];
  memory_scope: MemoryScope;
  use_profile_facts: boolean;
  keyterms: string[];
}

export interface CopilotInput {
  name: string;
  purpose: string;
  instructions: string;
  answer_prefs: AnswerPrefs;
  restricted_claims: string[];
  memory_scope: MemoryScope;
  use_profile_facts: boolean;
  keyterms: string[];
}

export type ThreadStatus = 'active' | 'archived';

export interface Thread extends BaseRow {
  copilot_id: string;
  title: string;
  status: ThreadStatus;
}

export interface Session extends BaseRow {
  copilot_id: string;
  thread_id: string;
  started_at: string;
  ended_at: string | null;
  save_transcript: boolean;
  summary: string; // NOT NULL in the schema; '' means no summary
}

export const MEMORY_KINDS = ['topic', 'decision', 'open_question', 'action_item', 'commitment', 'fact'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_STATUSES = ['draft', 'approved', 'forgotten'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export const MEMORY_ORIGINS = ['my_speech', 'their_speech', 'confirmed', 'note'] as const;
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];

export interface MemoryItem extends BaseRow {
  copilot_id: string;
  thread_id: string;
  session_id: string | null;
  kind: MemoryKind;
  text: string;
  status: MemoryStatus;
  origin: MemoryOrigin;
  source_at: string | null;
  due_at: string | null;
}

export interface ProfileSettings {
  save_transcripts_default?: boolean;
  memory_enabled?: boolean;
  [key: string]: unknown;
}

export interface Profile extends BaseRow {
  display_name: string;
  about: string;
  today_context: string;
  settings: ProfileSettings | null;
}

export interface ProfileFact extends BaseRow {
  text: string;
  shareable: boolean;
  source: string | null;
}

export interface TranscriptLine extends BaseRow {
  session_id: string;
  speaker: 'me' | 'them';
  text: string;
  at: string;
}

export interface DocumentRow extends BaseRow {
  copilot_id: string;
  title: string;
  kind: 'about_me' | 'about_them' | 'notes' | 'other';
  storage_path: string | null;
  chars: number | null;
  approved: boolean;
}
