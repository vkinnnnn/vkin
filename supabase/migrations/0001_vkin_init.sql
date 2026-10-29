-- Vkin — The Meeting Copilot: schema v1 (docs/vkin-contracts.md).
--
-- Run once, as the project owner (Supabase SQL editor or `supabase db push`). Then run
-- supabase/tests/isolation.sql to prove per-user isolation; it rolls itself back.
--
-- Security model
--   * Every table: RLS enabled AND forced; one policy per operation, `to authenticated`,
--     `user_id = (select auth.uid())` (the select-wrapped form is evaluated once per statement).
--   * user_id defaults to auth.uid(), can never be set to someone else (RLS WITH CHECK) and never changes
--     (trigger). Children reference parents by (parent_id, user_id), so a child can never attach to another
--     user's parent, and the FK check leaks nothing about other users' ids.
--   * anon gets nothing on these tables or functions.
--
-- Sync model
--   * ids are client-generated UUIDs; writes are upserts on id.
--   * rev: an update must carry rev = stored rev + 1, else SQLSTATE PT409 'vkin_rev_conflict' (HTTP 409 via
--     PostgREST). Re-sending exactly the stored row (same rev, same content) is an idempotent no-op, so a retry
--     after a lost response is safe.
--   * deleted_at is a tombstone: content columns are cleared and a tombstone can never be revived
--     (SQLSTATE PT410 'vkin_tombstoned'). Tombstoning a copilot, thread or session tombstones its children.
--   * updated_at is server time (clock_timestamp()) and is the pull cursor.

-- ---------------------------------------------------------------------------------------------------------
-- Shared trigger functions
-- ---------------------------------------------------------------------------------------------------------

-- id, user_id and created_at are immutable.
create or replace function public.vkin_guard_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'vkin_owner_immutable: user_id cannot change' using errcode = '42501';
  end if;
  if new.id is distinct from old.id then
    raise exception 'vkin_id_immutable: id cannot change' using errcode = 'PT400';
  end if;
  -- Parent links are frozen: moving a row would bypass the insert-only parent-tombstone and transcript
  -- opt-in triggers. Tables without a column compare null to null.
  if (to_jsonb(new) -> 'copilot_id') is distinct from (to_jsonb(old) -> 'copilot_id')
     or (to_jsonb(new) -> 'thread_id') is distinct from (to_jsonb(old) -> 'thread_id')
     or (to_jsonb(new) -> 'session_id') is distinct from (to_jsonb(old) -> 'session_id') then
    raise exception 'vkin_parent_immutable: % % cannot move to another parent', tg_table_name, old.id
      using errcode = 'PT400';
  end if;
  new.created_at := old.created_at;
  return new;
end;
$$;

-- Optimistic concurrency. Fires after the tombstone trigger has normalised NEW.
create or replace function public.vkin_check_rev()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Idempotent replay of the stored row (lost-response retry): accept as a no-op.
  if new.rev = old.rev
     and (to_jsonb(new) - 'updated_at' - 'created_at') = (to_jsonb(old) - 'updated_at' - 'created_at') then
    new.updated_at := old.updated_at;
    return new;
  end if;
  if old.deleted_at is not null and new.deleted_at is null then
    raise exception 'vkin_tombstoned: % % was deleted and cannot be restored', tg_table_name, old.id
      using errcode = 'PT410';
  end if;
  if new.rev is distinct from old.rev + 1 then
    raise exception 'vkin_rev_conflict: % % is at rev %, an update must send rev %', tg_table_name, old.id, old.rev, old.rev + 1
      using errcode = 'PT409', hint = 'pull the row, merge, and retry with rev = stored rev + 1';
  end if;
  return new;
end;
$$;

-- Server time for every real change (an idempotent replay keeps the old timestamp).
create or replace function public.vkin_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.rev = old.rev then
    return new;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

-- A live child proposed under a tombstoned parent is stored as a tombstone (offline device race).
-- tg_argv[0] = parent table, tg_argv[1] = FK column in this table.
create or replace function public.vkin_inherit_parent_tombstone()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_id uuid;
  dead boolean;
begin
  parent_id := (to_jsonb(new) ->> tg_argv[1])::uuid;
  if new.deleted_at is null and parent_id is not null then
    execute format('select deleted_at is not null from public.%I where id = $1 and user_id = $2', tg_argv[0])
      into dead using parent_id, new.user_id;
    if dead then
      new.deleted_at := clock_timestamp();
    end if;
  end if;
  return new;
end;
$$;

-- Tombstoning a parent tombstones its live children (each child bumps rev, so devices learn of it).
create or replace function public.vkin_cascade_tombstone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    if tg_table_name = 'copilots' then
      update public.documents set deleted_at = new.deleted_at, rev = rev + 1
        where copilot_id = new.id and user_id = new.user_id and deleted_at is null;
      update public.threads set deleted_at = new.deleted_at, rev = rev + 1
        where copilot_id = new.id and user_id = new.user_id and deleted_at is null;
    elsif tg_table_name = 'threads' then
      update public.memory_items set deleted_at = new.deleted_at, rev = rev + 1
        where thread_id = new.id and user_id = new.user_id and deleted_at is null;
      update public.sessions set deleted_at = new.deleted_at, rev = rev + 1
        where thread_id = new.id and user_id = new.user_id and deleted_at is null;
    elsif tg_table_name = 'sessions' then
      update public.transcript_lines set deleted_at = new.deleted_at, rev = rev + 1
        where session_id = new.id and user_id = new.user_id and deleted_at is null;
    end if;
  end if;
  return null;
end;
$$;

-- Per-table tombstone normalisation: deleted_at set => content cleared.
create or replace function public.vkin_tombstone_profiles() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.deleted_at is not null then
    new.display_name := ''; new.about := ''; new.today_context := ''; new.settings := '{}'::jsonb;
  end if;
  return new;
end;
$$;

create or replace function public.vkin_tombstone_profile_facts() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.deleted_at is not null then
    new.text := ''; new.source := '';
  end if;
  return new;
end;
$$;

create or replace function public.vkin_tombstone_copilots() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.deleted_at is not null then
    new.name := ''; new.purpose := ''; new.instructions := ''; new.answer_prefs := '{}'::jsonb;
    new.restricted_claims := '{}'::text[]; new.keyterms := '{}'::text[];
  end if;
  return new;
end;
$$;

create or replace function public.vkin_tombstone_documents() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.deleted_at is not null then
    new.title := ''; new.chars := 0;
  end if;
  return new;
end;
$$;

create or replace function public.vkin_tombstone_threads() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.deleted_at is not null then
    new.title := '';
  end if;
  return new;
end;
$$;

create or replace function public.vkin_tombstone_sessions() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.deleted_at is not null then
    new.summary := '';
  end if;
  return new;
end;
$$;

-- Forget = status 'forgotten' + text '' + tombstone, whichever of those the client sent.
create or replace function public.vkin_tombstone_memory_items() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'forgotten' then
    new.deleted_at := coalesce(new.deleted_at, clock_timestamp());
  end if;
  if new.deleted_at is not null then
    new.text := '';
  end if;
  return new;
end;
$$;

create or replace function public.vkin_tombstone_transcript_lines() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.deleted_at is not null then
    new.text := '';
  end if;
  return new;
end;
$$;

-- Transcript lines are accepted only for sessions with save_transcript = true.
create or replace function public.vkin_transcript_allowed() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.deleted_at is null and exists (
    select 1 from public.sessions s
    where s.id = new.session_id and s.user_id = new.user_id and not s.save_transcript
  ) then
    raise exception 'vkin_transcript_disabled: session % does not save transcripts', new.session_id
      using errcode = 'PT403';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rev integer not null default 1 check (rev >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  display_name text not null default '' check (char_length(display_name) <= 120),
  about text not null default '' check (char_length(about) <= 20000),
  today_context text not null default '' check (char_length(today_context) <= 2000),
  settings jsonb not null default '{"save_transcripts_default": false, "memory_enabled": true}'::jsonb
    check (jsonb_typeof(settings) = 'object' and octet_length(settings::text) <= 2000),
  constraint profiles_id_is_user check (id = user_id),
  constraint profiles_id_user_key unique (id, user_id),
  constraint profiles_tombstone_empty check (deleted_at is null or (about = '' and today_context = '' and display_name = ''))
);

create table public.profile_facts (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rev integer not null default 1 check (rev >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  text text not null default '' check (char_length(text) <= 2000),
  shareable boolean not null default false,
  source text not null default '' check (char_length(source) <= 200),
  constraint profile_facts_id_user_key unique (id, user_id),
  constraint profile_facts_tombstone_empty check (deleted_at is null or (text = '' and source = '')),
  constraint profile_facts_text_required check (deleted_at is not null or char_length(text) >= 1)
);

create table public.copilots (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rev integer not null default 1 check (rev >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null default '' check (char_length(name) <= 120),
  purpose text not null default '' check (char_length(purpose) <= 2000),
  instructions text not null default '' check (char_length(instructions) <= 20000),
  answer_prefs jsonb not null default '{}'::jsonb
    check (jsonb_typeof(answer_prefs) = 'object' and octet_length(answer_prefs::text) <= 20000),
  restricted_claims text[] not null default '{}' check (cardinality(restricted_claims) <= 200),
  memory_scope text not null default 'thread' check (memory_scope in ('thread', 'copilot')),
  use_profile_facts boolean not null default true,
  keyterms text[] not null default '{}' check (cardinality(keyterms) <= 500),
  constraint copilots_id_user_key unique (id, user_id),
  constraint copilots_tombstone_empty check (deleted_at is null or (name = '' and purpose = '' and instructions = '')),
  constraint copilots_name_required check (deleted_at is not null or char_length(name) >= 1)
);

create table public.documents (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rev integer not null default 1 check (rev >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  copilot_id uuid not null,
  title text not null default '' check (char_length(title) <= 200),
  kind text not null default 'other' check (kind in ('about_me', 'about_them', 'notes', 'other')),
  storage_path text check (storage_path is null or char_length(storage_path) <= 200),
  chars integer not null default 0 check (chars >= 0),
  approved boolean not null default false,
  constraint documents_id_user_key unique (id, user_id),
  constraint documents_copilot_fk foreign key (copilot_id, user_id)
    references public.copilots (id, user_id) on delete cascade,
  -- The object path is <user_id>/<copilot_id>/<id>, matching the storage policy.
  constraint documents_storage_path_shape check (
    storage_path is null or storage_path = user_id::text || '/' || copilot_id::text || '/' || id::text
  ),
  constraint documents_tombstone_empty check (deleted_at is null or title = '')
);

create table public.threads (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rev integer not null default 1 check (rev >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  copilot_id uuid not null,
  title text not null default '' check (char_length(title) <= 200),
  status text not null default 'active' check (status in ('active', 'archived')),
  constraint threads_id_user_key unique (id, user_id),
  constraint threads_id_copilot_user_key unique (id, copilot_id, user_id),
  constraint threads_copilot_fk foreign key (copilot_id, user_id)
    references public.copilots (id, user_id) on delete cascade,
  constraint threads_tombstone_empty check (deleted_at is null or title = '')
);

create table public.sessions (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rev integer not null default 1 check (rev >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  copilot_id uuid not null,
  thread_id uuid not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  save_transcript boolean not null default false,
  summary text not null default '' check (char_length(summary) <= 8000),
  constraint sessions_id_user_key unique (id, user_id),
  constraint sessions_scope_key unique (id, thread_id, copilot_id, user_id),
  constraint sessions_copilot_fk foreign key (copilot_id, user_id)
    references public.copilots (id, user_id) on delete cascade,
  -- The thread must belong to the same user AND the same copilot.
  constraint sessions_thread_fk foreign key (thread_id, copilot_id, user_id)
    references public.threads (id, copilot_id, user_id) on delete cascade,
  constraint sessions_tombstone_empty check (deleted_at is null or summary = '')
);

create table public.memory_items (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rev integer not null default 1 check (rev >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  copilot_id uuid not null,
  thread_id uuid not null,
  session_id uuid,
  kind text not null check (kind in ('topic', 'decision', 'open_question', 'action_item', 'commitment', 'fact')),
  text text not null default '' check (char_length(text) <= 2000),
  status text not null default 'draft' check (status in ('draft', 'approved', 'forgotten')),
  origin text not null check (origin in ('my_speech', 'their_speech', 'confirmed', 'note')),
  source_at timestamptz,
  due_at timestamptz,
  constraint memory_items_id_user_key unique (id, user_id),
  constraint memory_items_copilot_fk foreign key (copilot_id, user_id)
    references public.copilots (id, user_id) on delete cascade,
  constraint memory_items_thread_fk foreign key (thread_id, copilot_id, user_id)
    references public.threads (id, copilot_id, user_id) on delete cascade,
  -- session_id is optional; when present it must be the same user's session in the same thread/copilot.
  constraint memory_items_session_fk foreign key (session_id, thread_id, copilot_id, user_id)
    references public.sessions (id, thread_id, copilot_id, user_id) on delete cascade,
  -- A suggestion the copilot generated is never my_speech; a commitment needs my speech or confirmation.
  constraint memory_items_commitment_origin check (kind <> 'commitment' or origin in ('my_speech', 'confirmed')),
  constraint memory_items_forgotten_empty check (status <> 'forgotten' or (text = '' and deleted_at is not null)),
  constraint memory_items_tombstone_empty check (deleted_at is null or text = ''),
  constraint memory_items_text_required check (deleted_at is not null or char_length(text) >= 1)
);

create table public.transcript_lines (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rev integer not null default 1 check (rev >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  session_id uuid not null,
  speaker text not null check (speaker in ('me', 'them')),
  text text not null default '' check (char_length(text) <= 10000),
  at timestamptz not null default now(),
  constraint transcript_lines_id_user_key unique (id, user_id),
  constraint transcript_lines_session_fk foreign key (session_id, user_id)
    references public.sessions (id, user_id) on delete cascade,
  constraint transcript_lines_tombstone_empty check (deleted_at is null or text = '')
);

-- ---------------------------------------------------------------------------------------------------------
-- Indexes: pull cursor (user_id, updated_at, id) and the composite FK columns
-- ---------------------------------------------------------------------------------------------------------

create index profiles_user_updated_idx on public.profiles (user_id, updated_at, id);
create index profile_facts_user_updated_idx on public.profile_facts (user_id, updated_at, id);
create index copilots_user_updated_idx on public.copilots (user_id, updated_at, id);
create index documents_user_updated_idx on public.documents (user_id, updated_at, id);
create index threads_user_updated_idx on public.threads (user_id, updated_at, id);
create index sessions_user_updated_idx on public.sessions (user_id, updated_at, id);
create index memory_items_user_updated_idx on public.memory_items (user_id, updated_at, id);
create index transcript_lines_user_updated_idx on public.transcript_lines (user_id, updated_at, id);

create index documents_copilot_idx on public.documents (copilot_id, user_id);
create index threads_copilot_idx on public.threads (copilot_id, user_id);
create index sessions_copilot_idx on public.sessions (copilot_id, user_id);
create index sessions_thread_idx on public.sessions (thread_id, copilot_id, user_id);
create index memory_items_copilot_idx on public.memory_items (copilot_id, user_id);
create index memory_items_thread_idx on public.memory_items (thread_id, copilot_id, user_id);
create index memory_items_session_idx on public.memory_items (session_id, thread_id, copilot_id, user_id);
create index transcript_lines_session_idx on public.transcript_lines (session_id, user_id);

-- ---------------------------------------------------------------------------------------------------------
-- Triggers. BEFORE row triggers fire in name order: 10 guard, 20 tombstone/parent, 30 rev, 40 updated_at.
-- ---------------------------------------------------------------------------------------------------------

create trigger vkin_10_guard before update on public.profiles for each row execute function public.vkin_guard_row();
create trigger vkin_10_guard before update on public.profile_facts for each row execute function public.vkin_guard_row();
create trigger vkin_10_guard before update on public.copilots for each row execute function public.vkin_guard_row();
create trigger vkin_10_guard before update on public.documents for each row execute function public.vkin_guard_row();
create trigger vkin_10_guard before update on public.threads for each row execute function public.vkin_guard_row();
create trigger vkin_10_guard before update on public.sessions for each row execute function public.vkin_guard_row();
create trigger vkin_10_guard before update on public.memory_items for each row execute function public.vkin_guard_row();
create trigger vkin_10_guard before update on public.transcript_lines for each row execute function public.vkin_guard_row();

create trigger vkin_15_parent_tombstone before insert on public.documents
  for each row execute function public.vkin_inherit_parent_tombstone('copilots', 'copilot_id');
create trigger vkin_15_parent_tombstone before insert on public.threads
  for each row execute function public.vkin_inherit_parent_tombstone('copilots', 'copilot_id');
create trigger vkin_15_parent_tombstone before insert on public.sessions
  for each row execute function public.vkin_inherit_parent_tombstone('threads', 'thread_id');
create trigger vkin_15_parent_tombstone before insert on public.memory_items
  for each row execute function public.vkin_inherit_parent_tombstone('threads', 'thread_id');
create trigger vkin_15_parent_tombstone before insert on public.transcript_lines
  for each row execute function public.vkin_inherit_parent_tombstone('sessions', 'session_id');

create trigger vkin_18_transcript_allowed before insert on public.transcript_lines
  for each row execute function public.vkin_transcript_allowed();

create trigger vkin_20_tombstone before insert or update on public.profiles for each row execute function public.vkin_tombstone_profiles();
create trigger vkin_20_tombstone before insert or update on public.profile_facts for each row execute function public.vkin_tombstone_profile_facts();
create trigger vkin_20_tombstone before insert or update on public.copilots for each row execute function public.vkin_tombstone_copilots();
create trigger vkin_20_tombstone before insert or update on public.documents for each row execute function public.vkin_tombstone_documents();
create trigger vkin_20_tombstone before insert or update on public.threads for each row execute function public.vkin_tombstone_threads();
create trigger vkin_20_tombstone before insert or update on public.sessions for each row execute function public.vkin_tombstone_sessions();
create trigger vkin_20_tombstone before insert or update on public.memory_items for each row execute function public.vkin_tombstone_memory_items();
create trigger vkin_20_tombstone before insert or update on public.transcript_lines for each row execute function public.vkin_tombstone_transcript_lines();

create trigger vkin_30_check_rev before update on public.profiles for each row execute function public.vkin_check_rev();
create trigger vkin_30_check_rev before update on public.profile_facts for each row execute function public.vkin_check_rev();
create trigger vkin_30_check_rev before update on public.copilots for each row execute function public.vkin_check_rev();
create trigger vkin_30_check_rev before update on public.documents for each row execute function public.vkin_check_rev();
create trigger vkin_30_check_rev before update on public.threads for each row execute function public.vkin_check_rev();
create trigger vkin_30_check_rev before update on public.sessions for each row execute function public.vkin_check_rev();
create trigger vkin_30_check_rev before update on public.memory_items for each row execute function public.vkin_check_rev();
create trigger vkin_30_check_rev before update on public.transcript_lines for each row execute function public.vkin_check_rev();

create trigger vkin_40_updated_at before insert or update on public.profiles for each row execute function public.vkin_touch_updated_at();
create trigger vkin_40_updated_at before insert or update on public.profile_facts for each row execute function public.vkin_touch_updated_at();
create trigger vkin_40_updated_at before insert or update on public.copilots for each row execute function public.vkin_touch_updated_at();
create trigger vkin_40_updated_at before insert or update on public.documents for each row execute function public.vkin_touch_updated_at();
create trigger vkin_40_updated_at before insert or update on public.threads for each row execute function public.vkin_touch_updated_at();
create trigger vkin_40_updated_at before insert or update on public.sessions for each row execute function public.vkin_touch_updated_at();
create trigger vkin_40_updated_at before insert or update on public.memory_items for each row execute function public.vkin_touch_updated_at();
create trigger vkin_40_updated_at before insert or update on public.transcript_lines for each row execute function public.vkin_touch_updated_at();

create trigger vkin_50_cascade after update of deleted_at on public.copilots for each row execute function public.vkin_cascade_tombstone();
create trigger vkin_50_cascade after update of deleted_at on public.threads for each row execute function public.vkin_cascade_tombstone();
create trigger vkin_50_cascade after update of deleted_at on public.sessions for each row execute function public.vkin_cascade_tombstone();

-- ---------------------------------------------------------------------------------------------------------
-- Row level security: enabled + forced, one policy per operation, signed-in owner only
-- ---------------------------------------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.profile_facts enable row level security;
alter table public.profile_facts force row level security;
alter table public.copilots enable row level security;
alter table public.copilots force row level security;
alter table public.documents enable row level security;
alter table public.documents force row level security;
alter table public.threads enable row level security;
alter table public.threads force row level security;
alter table public.sessions enable row level security;
alter table public.sessions force row level security;
alter table public.memory_items enable row level security;
alter table public.memory_items force row level security;
alter table public.transcript_lines enable row level security;
alter table public.transcript_lines force row level security;

create policy "vkin profiles select own" on public.profiles for select to authenticated
  using (user_id = (select auth.uid()));
create policy "vkin profiles insert own" on public.profiles for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "vkin profiles update own" on public.profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "vkin profiles delete own" on public.profiles for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "vkin profile_facts select own" on public.profile_facts for select to authenticated
  using (user_id = (select auth.uid()));
create policy "vkin profile_facts insert own" on public.profile_facts for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "vkin profile_facts update own" on public.profile_facts for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "vkin profile_facts delete own" on public.profile_facts for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "vkin copilots select own" on public.copilots for select to authenticated
  using (user_id = (select auth.uid()));
create policy "vkin copilots insert own" on public.copilots for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "vkin copilots update own" on public.copilots for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "vkin copilots delete own" on public.copilots for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "vkin documents select own" on public.documents for select to authenticated
  using (user_id = (select auth.uid()));
create policy "vkin documents insert own" on public.documents for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "vkin documents update own" on public.documents for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "vkin documents delete own" on public.documents for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "vkin threads select own" on public.threads for select to authenticated
  using (user_id = (select auth.uid()));
create policy "vkin threads insert own" on public.threads for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "vkin threads update own" on public.threads for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "vkin threads delete own" on public.threads for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "vkin sessions select own" on public.sessions for select to authenticated
  using (user_id = (select auth.uid()));
create policy "vkin sessions insert own" on public.sessions for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "vkin sessions update own" on public.sessions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "vkin sessions delete own" on public.sessions for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "vkin memory_items select own" on public.memory_items for select to authenticated
  using (user_id = (select auth.uid()));
create policy "vkin memory_items insert own" on public.memory_items for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "vkin memory_items update own" on public.memory_items for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "vkin memory_items delete own" on public.memory_items for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "vkin transcript_lines select own" on public.transcript_lines for select to authenticated
  using (user_id = (select auth.uid()));
create policy "vkin transcript_lines insert own" on public.transcript_lines for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "vkin transcript_lines update own" on public.transcript_lines for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "vkin transcript_lines delete own" on public.transcript_lines for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------------------------
-- RPC functions (SECURITY INVOKER: RLS applies to everything they touch)
-- ---------------------------------------------------------------------------------------------------------

-- Tombstones a thread with its sessions, memory items and transcript lines. Idempotent; a thread id that
-- is not the caller's matches nothing.
create or replace function public.vkin_delete_thread(p_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  ts timestamptz := clock_timestamp();
  n_lines integer;
  n_memory integer;
  n_sessions integer;
  n_threads integer;
begin
  if uid is null then
    raise exception 'vkin: sign in required' using errcode = '42501';
  end if;
  update public.transcript_lines tl set deleted_at = ts, rev = tl.rev + 1
    where tl.user_id = uid and tl.deleted_at is null
      and tl.session_id in (select s.id from public.sessions s where s.thread_id = p_id and s.user_id = uid);
  get diagnostics n_lines = row_count;
  update public.memory_items m set deleted_at = ts, rev = m.rev + 1
    where m.user_id = uid and m.thread_id = p_id and m.deleted_at is null;
  get diagnostics n_memory = row_count;
  update public.sessions s set deleted_at = ts, rev = s.rev + 1
    where s.user_id = uid and s.thread_id = p_id and s.deleted_at is null;
  get diagnostics n_sessions = row_count;
  update public.threads t set deleted_at = ts, rev = t.rev + 1
    where t.user_id = uid and t.id = p_id and t.deleted_at is null;
  get diagnostics n_threads = row_count;
  return jsonb_build_object('threads', n_threads, 'sessions', n_sessions, 'memory_items', n_memory, 'transcript_lines', n_lines);
end;
$$;

-- Hard-deletes every Vkin row of the signed-in user. Storage objects must be removed first through the
-- Storage API (list + remove under '<uid>/'); deleting the auth user itself needs the service role.
create or replace function public.vkin_delete_account_data()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  counts jsonb := '{}'::jsonb;
  n integer;
begin
  if uid is null then
    raise exception 'vkin: sign in required' using errcode = '42501';
  end if;
  delete from public.transcript_lines where user_id = uid; get diagnostics n = row_count; counts := counts || jsonb_build_object('transcript_lines', n);
  delete from public.memory_items where user_id = uid;     get diagnostics n = row_count; counts := counts || jsonb_build_object('memory_items', n);
  delete from public.sessions where user_id = uid;         get diagnostics n = row_count; counts := counts || jsonb_build_object('sessions', n);
  delete from public.documents where user_id = uid;        get diagnostics n = row_count; counts := counts || jsonb_build_object('documents', n);
  delete from public.threads where user_id = uid;          get diagnostics n = row_count; counts := counts || jsonb_build_object('threads', n);
  delete from public.copilots where user_id = uid;         get diagnostics n = row_count; counts := counts || jsonb_build_object('copilots', n);
  delete from public.profile_facts where user_id = uid;    get diagnostics n = row_count; counts := counts || jsonb_build_object('profile_facts', n);
  delete from public.profiles where user_id = uid;         get diagnostics n = row_count; counts := counts || jsonb_build_object('profiles', n);
  return counts;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Privileges: authenticated gets DML only (RLS decides rows); anon and public get nothing.
-- ---------------------------------------------------------------------------------------------------------

revoke all on table public.profiles, public.profile_facts, public.copilots, public.documents,
  public.threads, public.sessions, public.memory_items, public.transcript_lines from anon, authenticated, public;
grant select, insert, update, delete on table public.profiles, public.profile_facts, public.copilots, public.documents,
  public.threads, public.sessions, public.memory_items, public.transcript_lines to authenticated;

revoke all on function public.vkin_guard_row() from public, anon, authenticated;
revoke all on function public.vkin_check_rev() from public, anon, authenticated;
revoke all on function public.vkin_touch_updated_at() from public, anon, authenticated;
revoke all on function public.vkin_inherit_parent_tombstone() from public, anon, authenticated;
revoke all on function public.vkin_cascade_tombstone() from public, anon, authenticated;
revoke all on function public.vkin_transcript_allowed() from public, anon, authenticated;
revoke all on function public.vkin_tombstone_profiles() from public, anon, authenticated;
revoke all on function public.vkin_tombstone_profile_facts() from public, anon, authenticated;
revoke all on function public.vkin_tombstone_copilots() from public, anon, authenticated;
revoke all on function public.vkin_tombstone_documents() from public, anon, authenticated;
revoke all on function public.vkin_tombstone_threads() from public, anon, authenticated;
revoke all on function public.vkin_tombstone_sessions() from public, anon, authenticated;
revoke all on function public.vkin_tombstone_memory_items() from public, anon, authenticated;
revoke all on function public.vkin_tombstone_transcript_lines() from public, anon, authenticated;

revoke all on function public.vkin_delete_thread(uuid) from public, anon;
revoke all on function public.vkin_delete_account_data() from public, anon;
grant execute on function public.vkin_delete_thread(uuid) to authenticated;
grant execute on function public.vkin_delete_account_data() to authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- Storage: private bucket `documents`, objects under '<auth.uid()>/...' only
-- ---------------------------------------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "vkin documents objects select own" on storage.objects;
drop policy if exists "vkin documents objects insert own" on storage.objects;
drop policy if exists "vkin documents objects update own" on storage.objects;
drop policy if exists "vkin documents objects delete own" on storage.objects;

create policy "vkin documents objects select own" on storage.objects for select to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "vkin documents objects insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "vkin documents objects update own" on storage.objects for update to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "vkin documents objects delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
