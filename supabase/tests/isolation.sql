-- Vkin isolation test. Paste into the Supabase SQL editor AFTER running migrations/0001_vkin_init.sql.
--
-- It creates two throwaway users (A and B), impersonates them with `set local role authenticated` plus
-- `request.jwt.claims` (exactly what PostgREST does for a signed-in request), and asserts that A can never
-- read, change, delete, claim or attach to B's rows, and that the rev-conflict, tombstone, forget,
-- commitment and transcript rules fire. Everything runs in one transaction and is ROLLED BACK at the end.
--
-- Pass: the last result row says "ALL CHECKS PASSED". Fail: the run stops with an error starting "FAIL".
--
-- Fixed ids (hex only):  A = a000...0001, B = b000...0001
--   copilots ...0c0x, threads ...0d0x, sessions ...0e0x, memory ...0f0x, transcript lines ...0a0x

begin;

-- ---------------------------------------------------------------------------------------------------------
-- 0. Throwaway auth users (as the SQL editor's owner role).
-- ---------------------------------------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'vkin-isolation-a@example.invalid', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('b0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'vkin-isolation-b@example.invalid', '{}'::jsonb, '{}'::jsonb, now(), now());

-- ---------------------------------------------------------------------------------------------------------
-- 1. As B: a full tree (profile, fact, copilot, thread, session with transcript, memory, line).
-- ---------------------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

insert into public.profiles (id, display_name, about)
  values ('b0000000-0000-4000-8000-000000000001', 'B', 'B private about');
insert into public.profile_facts (id, text, shareable)
  values ('b0000000-0000-4000-8000-000000000b01', 'B private fact', true);
insert into public.copilots (id, name, purpose)
  values ('b0000000-0000-4000-8000-000000000c01', 'B copilot', 'B purpose');
insert into public.threads (id, copilot_id, title)
  values ('b0000000-0000-4000-8000-000000000d01', 'b0000000-0000-4000-8000-000000000c01', 'B thread');
insert into public.sessions (id, copilot_id, thread_id, save_transcript)
  values ('b0000000-0000-4000-8000-000000000e01', 'b0000000-0000-4000-8000-000000000c01',
          'b0000000-0000-4000-8000-000000000d01', true);
insert into public.memory_items (id, copilot_id, thread_id, session_id, kind, text, status, origin)
  values ('b0000000-0000-4000-8000-000000000f01', 'b0000000-0000-4000-8000-000000000c01',
          'b0000000-0000-4000-8000-000000000d01', 'b0000000-0000-4000-8000-000000000e01',
          'decision', 'B secret decision', 'approved', 'their_speech');
insert into public.transcript_lines (id, session_id, speaker, text)
  values ('b0000000-0000-4000-8000-000000000a01', 'b0000000-0000-4000-8000-000000000e01', 'them', 'B secret line');

-- ---------------------------------------------------------------------------------------------------------
-- 2. As A: two copilots with one thread each; session e01 saves no transcript, e02 does.
-- ---------------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

insert into public.profiles (id, display_name) values ('a0000000-0000-4000-8000-000000000001', 'A');
insert into public.copilots (id, name, purpose, instructions) values
  ('a0000000-0000-4000-8000-000000000c01', 'A copilot 1', 'A purpose', 'A instructions'),
  ('a0000000-0000-4000-8000-000000000c02', 'A copilot 2', '', '');
insert into public.threads (id, copilot_id, title) values
  ('a0000000-0000-4000-8000-000000000d01', 'a0000000-0000-4000-8000-000000000c01', 'A thread 1'),
  ('a0000000-0000-4000-8000-000000000d02', 'a0000000-0000-4000-8000-000000000c02', 'A thread 2');
insert into public.sessions (id, copilot_id, thread_id, save_transcript) values
  ('a0000000-0000-4000-8000-000000000e01', 'a0000000-0000-4000-8000-000000000c01', 'a0000000-0000-4000-8000-000000000d01', false),
  ('a0000000-0000-4000-8000-000000000e02', 'a0000000-0000-4000-8000-000000000c02', 'a0000000-0000-4000-8000-000000000d02', true);
insert into public.memory_items (id, copilot_id, thread_id, session_id, kind, text, status, origin) values
  ('a0000000-0000-4000-8000-000000000f01', 'a0000000-0000-4000-8000-000000000c01', 'a0000000-0000-4000-8000-000000000d01',
   'a0000000-0000-4000-8000-000000000e01', 'topic', 'A topic', 'approved', 'their_speech'),
  ('a0000000-0000-4000-8000-000000000f02', 'a0000000-0000-4000-8000-000000000c02', 'a0000000-0000-4000-8000-000000000d02',
   'a0000000-0000-4000-8000-000000000e02', 'commitment', 'A will send the draft', 'approved', 'my_speech');
insert into public.transcript_lines (id, session_id, speaker, text) values
  ('a0000000-0000-4000-8000-000000000a02', 'a0000000-0000-4000-8000-000000000e02', 'me', 'A line');

-- ---------------------------------------------------------------------------------------------------------
-- 3. A cannot see anything of B's.
-- ---------------------------------------------------------------------------------------------------------
do $$
begin
  if (select auth.uid()) is distinct from 'a0000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'FAIL 3.0: setup is not impersonating A';
  end if;
  if exists (select 1 from public.profiles where user_id <> (select auth.uid()))
     or exists (select 1 from public.profile_facts where user_id <> (select auth.uid()))
     or exists (select 1 from public.copilots where user_id <> (select auth.uid()))
     or exists (select 1 from public.threads where user_id <> (select auth.uid()))
     or exists (select 1 from public.sessions where user_id <> (select auth.uid()))
     or exists (select 1 from public.memory_items where user_id <> (select auth.uid()))
     or exists (select 1 from public.transcript_lines where user_id <> (select auth.uid())) then
    raise exception 'FAIL 3.1: A can select rows owned by someone else';
  end if;
  if exists (select 1 from public.copilots where id = 'b0000000-0000-4000-8000-000000000c01')
     or exists (select 1 from public.profiles where id = 'b0000000-0000-4000-8000-000000000001')
     or exists (select 1 from public.memory_items where text like 'B secret%')
     or exists (select 1 from public.transcript_lines where text like 'B secret%') then
    raise exception 'FAIL 3.2: A can select B''s rows by id or content';
  end if;
  if (select count(*) from public.copilots) <> 2 or (select count(*) from public.memory_items) <> 2 then
    raise exception 'FAIL 3.3: A does not see exactly A''s own rows';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 4. A cannot update or delete B's rows (0 rows affected, no error leaks existence).
-- ---------------------------------------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  update public.copilots set name = 'pwned', rev = rev + 1 where id = 'b0000000-0000-4000-8000-000000000c01';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 4.1: A updated B''s copilot'; end if;
  update public.profiles set about = 'pwned', rev = rev + 1 where id = 'b0000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 4.2: A updated B''s profile'; end if;
  update public.memory_items set text = 'pwned', rev = rev + 1 where id = 'b0000000-0000-4000-8000-000000000f01';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 4.3: A updated B''s memory'; end if;
  update public.transcript_lines set text = 'pwned', rev = rev + 1 where user_id = 'b0000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 4.4: A updated B''s transcript'; end if;
  delete from public.copilots where id = 'b0000000-0000-4000-8000-000000000c01';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 4.5: A deleted B''s copilot'; end if;
  delete from public.memory_items where user_id = 'b0000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 4.6: A deleted B''s memory'; end if;
  delete from public.profile_facts where id = 'b0000000-0000-4000-8000-000000000b01';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 4.7: A deleted B''s fact'; end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 5. A cannot write rows owned by B, hijack B's id by upsert, or give away its own rows.
-- ---------------------------------------------------------------------------------------------------------
do $$
begin
  begin
    insert into public.copilots (id, user_id, name)
      values ('a0000000-0000-4000-8000-000000000c09', 'b0000000-0000-4000-8000-000000000001', 'spoof');
    raise exception 'FAIL 5.1: A inserted a copilot owned by B';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.memory_items (id, user_id, copilot_id, thread_id, kind, text, origin)
      values ('a0000000-0000-4000-8000-000000000f09', 'b0000000-0000-4000-8000-000000000001',
              'b0000000-0000-4000-8000-000000000c01', 'b0000000-0000-4000-8000-000000000d01', 'fact', 'spoof', 'note');
    raise exception 'FAIL 5.2: A inserted memory owned by B';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.profiles (id, display_name) values ('b0000000-0000-4000-8000-000000000001', 'spoof');
    raise exception 'FAIL 5.3: A created a profile with B''s id';
  exception when check_violation or insufficient_privilege or unique_violation then null;
  end;
  begin
    insert into public.copilots (id, name) values ('b0000000-0000-4000-8000-000000000c01', 'hijack')
      on conflict (id) do update set name = excluded.name, rev = public.copilots.rev + 1;
    raise exception 'FAIL 5.4: A upserted over B''s copilot';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.copilots set user_id = 'b0000000-0000-4000-8000-000000000001', rev = rev + 1
      where id = 'a0000000-0000-4000-8000-000000000c02';
    raise exception 'FAIL 5.5: A handed its copilot to B';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 6. A cannot attach children to B's parents (composite FKs), nor mix its own copilots/threads.
-- ---------------------------------------------------------------------------------------------------------
do $$
begin
  begin
    insert into public.threads (id, copilot_id, title)
      values ('a0000000-0000-4000-8000-000000000d09', 'b0000000-0000-4000-8000-000000000c01', 'attach');
    raise exception 'FAIL 6.1: A attached a thread to B''s copilot';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.documents (id, copilot_id, title)
      values ('a0000000-0000-4000-8000-000000000909', 'b0000000-0000-4000-8000-000000000c01', 'attach');
    raise exception 'FAIL 6.2: A attached a document to B''s copilot';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.memory_items (id, copilot_id, thread_id, kind, text, origin)
      values ('a0000000-0000-4000-8000-000000000f08', 'b0000000-0000-4000-8000-000000000c01',
              'b0000000-0000-4000-8000-000000000d01', 'fact', 'attach', 'note');
    raise exception 'FAIL 6.3: A attached memory to B''s thread';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.transcript_lines (id, session_id, speaker, text)
      values ('a0000000-0000-4000-8000-000000000a09', 'b0000000-0000-4000-8000-000000000e01', 'me', 'attach');
    raise exception 'FAIL 6.4: A attached a transcript line to B''s session';
  exception when foreign_key_violation then null;
  end;
  begin
    -- A's own thread d02 belongs to copilot c02, not c01.
    insert into public.sessions (id, copilot_id, thread_id)
      values ('a0000000-0000-4000-8000-000000000e09', 'a0000000-0000-4000-8000-000000000c01',
              'a0000000-0000-4000-8000-000000000d02');
    raise exception 'FAIL 6.5: a session mixed one copilot with another copilot''s thread';
  exception when foreign_key_violation then null;
  end;
  begin
    -- Parent links are frozen: moving a transcript line into the no-transcript session e01 is refused.
    update public.transcript_lines set session_id = 'a0000000-0000-4000-8000-000000000e01', rev = rev + 1
      where id = 'a0000000-0000-4000-8000-000000000a02';
    raise exception 'FAIL 6.6: a transcript line was moved to another session';
  exception when sqlstate 'PT400' then null;
  end;
  begin
    update public.memory_items set copilot_id = 'a0000000-0000-4000-8000-000000000c02',
      thread_id = 'a0000000-0000-4000-8000-000000000d02', session_id = null, rev = rev + 1
      where id = 'a0000000-0000-4000-8000-000000000f01';
    raise exception 'FAIL 6.7: a memory item was moved to another copilot';
  exception when sqlstate 'PT400' then null;
  end;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 7. vkin_delete_thread: B's thread id does nothing for A; A's own thread cascades.
-- ---------------------------------------------------------------------------------------------------------
do $$
declare
  r jsonb;
begin
  r := public.vkin_delete_thread('b0000000-0000-4000-8000-000000000d01');
  if (r ->> 'threads')::int <> 0 or (r ->> 'sessions')::int <> 0 or (r ->> 'memory_items')::int <> 0
     or (r ->> 'transcript_lines')::int <> 0 then
    raise exception 'FAIL 7.1: vkin_delete_thread touched B''s rows: %', r;
  end if;
  r := public.vkin_delete_thread('a0000000-0000-4000-8000-000000000d02');
  if (r ->> 'threads')::int <> 1 or (r ->> 'sessions')::int <> 1 or (r ->> 'memory_items')::int <> 1
     or (r ->> 'transcript_lines')::int <> 1 then
    raise exception 'FAIL 7.2: vkin_delete_thread did not tombstone A''s thread tree: %', r;
  end if;
  if exists (select 1 from public.memory_items where id = 'a0000000-0000-4000-8000-000000000f02' and (deleted_at is null or text <> ''))
     or exists (select 1 from public.transcript_lines where id = 'a0000000-0000-4000-8000-000000000a02' and (deleted_at is null or text <> ''))
     or exists (select 1 from public.threads where id = 'a0000000-0000-4000-8000-000000000d02' and (deleted_at is null or title <> '')) then
    raise exception 'FAIL 7.3: tombstoned rows kept their content';
  end if;
  -- Idempotent: a second call finds nothing left.
  r := public.vkin_delete_thread('a0000000-0000-4000-8000-000000000d02');
  if (r ->> 'threads')::int <> 0 then
    raise exception 'FAIL 7.4: vkin_delete_thread is not idempotent: %', r;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 8. rev rules on A's copilot c01 (rev 1).
-- ---------------------------------------------------------------------------------------------------------
do $$
declare
  t0 timestamptz;
  t1 timestamptz;
  v integer;
begin
  select updated_at into t0 from public.copilots where id = 'a0000000-0000-4000-8000-000000000c01';
  begin
    update public.copilots set name = 'stale write' where id = 'a0000000-0000-4000-8000-000000000c01';
    raise exception 'FAIL 8.1: an update without rev + 1 was accepted';
  exception when sqlstate 'PT409' then null;
  end;
  begin
    update public.copilots set name = 'skip ahead', rev = rev + 2 where id = 'a0000000-0000-4000-8000-000000000c01';
    raise exception 'FAIL 8.2: an update with rev + 2 was accepted';
  exception when sqlstate 'PT409' then null;
  end;
  -- Idempotent replay of the stored row: accepted, nothing changes.
  update public.copilots set rev = rev where id = 'a0000000-0000-4000-8000-000000000c01';
  select updated_at, rev into t1, v from public.copilots where id = 'a0000000-0000-4000-8000-000000000c01';
  if t1 <> t0 or v <> 1 then
    raise exception 'FAIL 8.3: an identical replay changed the row';
  end if;
  update public.copilots set name = 'A copilot 1 renamed', rev = rev + 1 where id = 'a0000000-0000-4000-8000-000000000c01';
  select updated_at, rev into t1, v from public.copilots where id = 'a0000000-0000-4000-8000-000000000c01';
  if v <> 2 or t1 <= t0 then
    raise exception 'FAIL 8.4: a valid update did not bump rev/updated_at';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 9. Memory rules: commitment origin, forget, length limits, transcript opt-in.
-- ---------------------------------------------------------------------------------------------------------
do $$
begin
  begin
    insert into public.memory_items (id, copilot_id, thread_id, kind, text, origin)
      values ('a0000000-0000-4000-8000-000000000f03', 'a0000000-0000-4000-8000-000000000c01',
              'a0000000-0000-4000-8000-000000000d01', 'commitment', 'They promised', 'their_speech');
    raise exception 'FAIL 9.1: a commitment from their speech was accepted';
  exception when check_violation then null;
  end;
  update public.memory_items set status = 'forgotten', rev = rev + 1 where id = 'a0000000-0000-4000-8000-000000000f01';
  if not exists (select 1 from public.memory_items
                 where id = 'a0000000-0000-4000-8000-000000000f01' and text = '' and deleted_at is not null) then
    raise exception 'FAIL 9.2: forget did not clear text and tombstone the item';
  end if;
  begin
    insert into public.copilots (id, name) values ('a0000000-0000-4000-8000-000000000c08', repeat('x', 121));
    raise exception 'FAIL 9.3: a 121-character copilot name was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.memory_items (id, copilot_id, thread_id, kind, text, origin)
      values ('a0000000-0000-4000-8000-000000000f04', 'a0000000-0000-4000-8000-000000000c01',
              'a0000000-0000-4000-8000-000000000d01', 'fact', repeat('x', 2001), 'note');
    raise exception 'FAIL 9.4: 2001 characters of memory text were accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.transcript_lines (id, session_id, speaker, text)
      values ('a0000000-0000-4000-8000-000000000a03', 'a0000000-0000-4000-8000-000000000e01', 'me', 'not saved');
    raise exception 'FAIL 9.5: a transcript line was stored for a session with save_transcript = false';
  exception when sqlstate 'PT403' then null;
  end;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 10. Tombstones: deleting copilot c01 clears content, cascades, cannot be revived; late children are dead.
-- ---------------------------------------------------------------------------------------------------------
do $$
begin
  update public.copilots set deleted_at = now(), rev = rev + 1 where id = 'a0000000-0000-4000-8000-000000000c01';
  if not exists (select 1 from public.copilots where id = 'a0000000-0000-4000-8000-000000000c01'
                 and name = '' and purpose = '' and instructions = '' and keyterms = '{}') then
    raise exception 'FAIL 10.1: tombstoned copilot kept its content';
  end if;
  if exists (select 1 from public.threads where copilot_id = 'a0000000-0000-4000-8000-000000000c01' and deleted_at is null)
     or exists (select 1 from public.sessions where copilot_id = 'a0000000-0000-4000-8000-000000000c01' and deleted_at is null) then
    raise exception 'FAIL 10.2: copilot tombstone did not cascade to threads and sessions';
  end if;
  begin
    update public.copilots set deleted_at = null, name = 'back', rev = rev + 1 where id = 'a0000000-0000-4000-8000-000000000c01';
    raise exception 'FAIL 10.3: a tombstone was revived';
  exception when sqlstate 'PT410' then null;
  end;
  insert into public.threads (id, copilot_id, title)
    values ('a0000000-0000-4000-8000-000000000d03', 'a0000000-0000-4000-8000-000000000c01', 'late');
  if not exists (select 1 from public.threads where id = 'a0000000-0000-4000-8000-000000000d03'
                 and deleted_at is not null and title = '') then
    raise exception 'FAIL 10.4: a child created under a tombstoned parent is live';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 11. anon gets nothing.
-- ---------------------------------------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  begin
    perform 1 from public.copilots limit 1;
    raise exception 'FAIL 11.1: anon can read copilots';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.vkin_delete_thread('b0000000-0000-4000-8000-000000000d01');
    raise exception 'FAIL 11.2: anon can call vkin_delete_thread';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 12. As B: everything of B's is intact.
-- ---------------------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $$
begin
  if not exists (select 1 from public.copilots where id = 'b0000000-0000-4000-8000-000000000c01'
                 and name = 'B copilot' and rev = 1 and deleted_at is null)
     or not exists (select 1 from public.threads where id = 'b0000000-0000-4000-8000-000000000d01' and deleted_at is null and rev = 1)
     or not exists (select 1 from public.memory_items where id = 'b0000000-0000-4000-8000-000000000f01' and text = 'B secret decision')
     or not exists (select 1 from public.transcript_lines where id = 'b0000000-0000-4000-8000-000000000a01' and text = 'B secret line')
     or not exists (select 1 from public.profiles where id = 'b0000000-0000-4000-8000-000000000001' and about = 'B private about')
     or not exists (select 1 from public.profile_facts where id = 'b0000000-0000-4000-8000-000000000b01') then
    raise exception 'FAIL 12.1: B''s rows were changed by A';
  end if;
  if exists (select 1 from public.copilots where user_id <> (select auth.uid())) then
    raise exception 'FAIL 12.2: B can see A''s rows';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 13. Storage paths. Skipped (with a notice) if this project's storage schema rejects direct SQL inserts;
--     scripts/vkin-isolation-test.js covers storage over the real API.
-- ---------------------------------------------------------------------------------------------------------
do $$
begin
  insert into storage.objects (bucket_id, name)
    values ('documents', 'b0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-000000000c01/doc');
  perform set_config('vkin.storage_test', 'on', true);
exception when others then
  if sqlstate = '42501' then
    raise exception 'FAIL 13.0: B cannot write into its own storage folder';
  end if;
  raise notice 'SKIP storage checks: direct insert into storage.objects failed (%: %)', sqlstate, sqlerrm;
  perform set_config('vkin.storage_test', 'off', true);
end $$;

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $$
declare
  n integer;
begin
  if coalesce(current_setting('vkin.storage_test', true), 'off') <> 'on' then
    return;
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'documents'
             and name like 'b0000000-0000-4000-8000-000000000001/%') then
    raise exception 'FAIL 13.1: A can list B''s storage objects';
  end if;
  begin
    insert into storage.objects (bucket_id, name)
      values ('documents', 'b0000000-0000-4000-8000-000000000001/x/planted');
    raise exception 'FAIL 13.2: A wrote into B''s storage folder';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name)
      values ('documents', 'a0000000-0000-4000-8000-000000000001/x/stolen-name');
  exception when insufficient_privilege then
    raise exception 'FAIL 13.3: A cannot write into its own storage folder';
  end;
  update storage.objects set name = 'a0000000-0000-4000-8000-000000000001/x/moved'
    where bucket_id = 'documents' and name like 'b0000000-0000-4000-8000-000000000001/%';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 13.4: A renamed B''s object'; end if;
  begin
    delete from storage.objects where bucket_id = 'documents' and name like 'b0000000-0000-4000-8000-000000000001/%';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL 13.5: A deleted B''s object'; end if;
  exception when others then
    -- Supabase may block direct deletes from storage tables entirely: also a pass.
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
end $$;

select 'vkin isolation: ALL CHECKS PASSED (everything below is rolled back)' as result;

rollback;
