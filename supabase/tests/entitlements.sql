-- Vkin entitlements test. Paste into the Supabase SQL editor AFTER running migrations/0002_vkin_entitlements.sql.
--
-- It creates throwaway users, drives the billing functions as service_role (what the hosted API uses), then
-- impersonates user A with `set local role authenticated` plus `request.jwt.claims` (exactly what PostgREST
-- does for a signed-in request) and asserts that A can read only A's own entitlement and leases, can never
-- insert, update or delete entitlements, leases or usage_events, can never read usage_events or B's rows, and
-- cannot execute any vkin_* billing function. anon gets nothing. Everything runs in one transaction and is
-- ROLLED BACK at the end.
--
-- Pass: the last result row says "ALL CHECKS PASSED". Fail: the run stops with an error starting "FAIL".
--
-- Fixed ids (hex only): A = a000...0002 (confirmed email), B = b000...0002 (confirmed email),
--   C = c000...0002 (unconfirmed, email identity only), D = d000...0002 (unconfirmed, Google identity),
--   E = e000...0002 (phone identity only: not eligible)

begin;

-- ---------------------------------------------------------------------------------------------------------
-- 0. Throwaway auth users (as the SQL editor's owner role).
-- ---------------------------------------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'vkin-ent-a@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('b0000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'vkin-ent-b@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('c0000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'vkin-ent-c@example.invalid', null, '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('d0000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'vkin-ent-d@example.invalid', null, '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('e0000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   null, null, '{}'::jsonb, '{}'::jsonb, now(), now());

insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values
  ('c0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002',
   '{"sub":"c0000000-0000-4000-8000-000000000002"}'::jsonb, 'email', now(), now()),
  ('vkin-test-google-d', 'd0000000-0000-4000-8000-000000000002',
   '{"sub":"vkin-test-google-d"}'::jsonb, 'google', now(), now()),
  ('e0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002',
   '{"sub":"e0000000-0000-4000-8000-000000000002"}'::jsonb, 'phone', now(), now());

-- ---------------------------------------------------------------------------------------------------------
-- 1. As service_role (the hosted API): trial grant, leases and billing behave as documented.
-- ---------------------------------------------------------------------------------------------------------
set local role service_role;

do $$
declare
  a uuid := 'a0000000-0000-4000-8000-000000000002';
  b uuid := 'b0000000-0000-4000-8000-000000000002';
  r jsonb;
  la uuid;
  lb uuid;
begin
  -- 1.1 trial: confirmed email and OAuth identity get it, unconfirmed email does not; grant is idempotent.
  if not public.vkin_ensure_entitlement(a) or not public.vkin_ensure_entitlement(a) then
    raise exception 'FAIL 1.1: confirmed user A did not get a trial';
  end if;
  if (select count(*) from public.entitlements where user_id = a) <> 1
     or (select trial_seconds from public.entitlements where user_id = a) <> 600 then
    raise exception 'FAIL 1.2: trial grant is not exactly one 600 s row';
  end if;
  if public.vkin_ensure_entitlement('c0000000-0000-4000-8000-000000000002') then
    raise exception 'FAIL 1.3: unconfirmed email user C got a trial';
  end if;
  if not public.vkin_ensure_entitlement('d0000000-0000-4000-8000-000000000002') then
    raise exception 'FAIL 1.4: OAuth user D did not get a trial';
  end if;
  if public.vkin_ensure_entitlement('e0000000-0000-4000-8000-000000000002') then
    raise exception 'FAIL 1.4b: an unconfirmed phone-only user E got a trial';
  end if;
  if ((public.vkin_me(b)) ->> 'remainingSeconds')::int <> 600 then
    raise exception 'FAIL 1.5: vkin_me did not grant B a 600 s trial';
  end if;

  -- 1.6 one active lease per user; start charges the 15 s minimum and prepays last_beat_at.
  r := public.vkin_start_lease(b, 'B laptop');
  lb := (r ->> 'leaseId')::uuid;
  r := public.vkin_start_lease(a, 'A laptop');
  la := (r ->> 'leaseId')::uuid;
  if (r ->> 'remainingSeconds')::int <> 585 or (r ->> 'chargedSeconds')::int <> 15
     or (select used_seconds from public.entitlements where user_id = a) <> 15 then
    raise exception 'FAIL 1.6: start did not charge the 15 s minimum: %', r;
  end if;
  begin
    perform public.vkin_start_lease(a, 'A phone');
    raise exception 'FAIL 1.6b: A started a second active lease';
  exception when sqlstate 'PT409' then null;
  end;
  begin
    perform public.vkin_start_lease('c0000000-0000-4000-8000-000000000002', 'C');
    raise exception 'FAIL 1.7: C started a lease without an entitlement';
  exception when sqlstate 'PT402' then null;
  end;

  -- 1.8 beat bills ceil(elapsed DB time) with no 30 s forgiveness (up to 45 s).
  update public.leases set last_beat_at = clock_timestamp() - interval '19.5 seconds' where id = la;
  r := public.vkin_bill_lease(a, la);
  if (r ->> 'billedSeconds')::int <> 20 or (r ->> 'remainingSeconds')::int <> 565 or r ->> 'status' <> 'active' then
    raise exception 'FAIL 1.8: 19.5 s beat billed wrongly: %', r;
  end if;
  update public.leases set last_beat_at = clock_timestamp() - interval '39.5 seconds' where id = la;
  r := public.vkin_bill_lease(a, la);
  if (r ->> 'billedSeconds')::int <> 40 or (r ->> 'remainingSeconds')::int <> 525 then
    raise exception 'FAIL 1.9: a 39.5 s gap was not billed 40 s: %', r;
  end if;

  -- 1.10 another user's lease is not found.
  begin
    perform public.vkin_bill_lease(a, lb);
    raise exception 'FAIL 1.10: A billed B''s lease';
  exception when sqlstate 'PT404' then null;
  end;
  begin
    perform public.vkin_stop_lease(a, lb);
    raise exception 'FAIL 1.11: A stopped B''s lease';
  exception when sqlstate 'PT404' then null;
  end;
  begin
    perform public.vkin_lease_state(a, lb);
    raise exception 'FAIL 1.12: A read B''s lease state';
  exception when sqlstate 'PT404' then null;
  end;

  -- 1.13 a stale-but-unswept lease reads as ended; billing it ends it and charges the 45 s window.
  update public.leases set last_beat_at = clock_timestamp() - interval '60 seconds' where id = la;
  if public.vkin_lease_state(a, la) ->> 'status' <> 'ended' then
    raise exception 'FAIL 1.13: a stale lease still reads as active';
  end if;
  r := public.vkin_bill_lease(a, la);
  if r ->> 'status' <> 'ended' or (r ->> 'billedSeconds')::int <> 45 or (r ->> 'remainingSeconds')::int <> 480 then
    raise exception 'FAIL 1.14: stale lease was not ended with a 45 s charge: %', r;
  end if;

  -- 1.15 start then stop at once still costs the 15 s minimum; stop again is a no-op.
  r := public.vkin_start_lease(a, 'A laptop');
  la := (r ->> 'leaseId')::uuid;
  if (public.vkin_lease_state(a, la) ->> 'usableSeconds')::int < 465 then
    raise exception 'FAIL 1.15: usableSeconds does not include prepaid time';
  end if;
  r := public.vkin_stop_lease(a, la);
  if r ->> 'status' <> 'ended' or (r ->> 'remainingSeconds')::int <> 465 then
    raise exception 'FAIL 1.15b: immediate stop did not keep the 15 s minimum: %', r;
  end if;
  if (public.vkin_stop_lease(a, la) ->> 'remainingSeconds')::int <> 465 then
    raise exception 'FAIL 1.15c: second stop billed again';
  end if;

  -- 1.16 the start charge is capped at what is left; exhaustion ends the lease; further starts get PT402.
  update public.entitlements set used_seconds = 595 where user_id = a;
  r := public.vkin_start_lease(a, 'A laptop');
  la := (r ->> 'leaseId')::uuid;
  if (r ->> 'chargedSeconds')::int <> 5 or (r ->> 'remainingSeconds')::int <> 0 then
    raise exception 'FAIL 1.16: start with 5 s left charged wrongly: %', r;
  end if;
  r := public.vkin_bill_lease(a, la);
  if r ->> 'status' <> 'ended' or (r ->> 'remainingSeconds')::int <> 0 then
    raise exception 'FAIL 1.17: exhaustion did not end the lease at 0: %', r;
  end if;
  if (select used_seconds from public.entitlements where user_id = a) <> 600 then
    raise exception 'FAIL 1.18: used_seconds went past the entitlement';
  end if;
  begin
    perform public.vkin_start_lease(a, 'A laptop');
    raise exception 'FAIL 1.19: A started a lease with 0 remaining';
  exception when sqlstate 'PT402' then null;
  end;

  -- 1.20 sweep ends stale leases, bills the 45 s window and returns their ids.
  update public.leases set last_beat_at = clock_timestamp() - interval '50 seconds' where id = lb;
  r := public.vkin_expire_leases();
  if not (r @> jsonb_build_array(lb)) then
    raise exception 'FAIL 1.20: sweep did not end B''s stale lease: %', r;
  end if;
  if (select used_seconds from public.entitlements where user_id = b) <> 60 then
    raise exception 'FAIL 1.21: sweep did not bill B 15 s start + 45 s stale window';
  end if;

  -- 1.22 usage and totals.
  perform public.vkin_record_usage(b, lb, 'nebius', 'Qwen/Qwen3-235B-A22B-Instruct-2507', 1000, 500, 0.0005);
  perform public.vkin_record_usage(b, lb, 'gemini', 'gemini-3.5-flash', 10, 5, 0);
  if (public.vkin_spend_totals() ->> 'nebius')::numeric < 0.0005 then
    raise exception 'FAIL 1.22: spend totals miss a recorded event';
  end if;
  if (public.vkin_user_spend(b) ->> 'nebius')::numeric <> 0.0005
     or (public.vkin_user_spend(b) ->> 'nebiusToday')::numeric <> 0.0005
     or (public.vkin_user_spend(b) ->> 'geminiRequestsToday')::int <> 1
     or (public.vkin_user_spend(a) ->> 'nebius')::numeric <> 0 then
    raise exception 'FAIL 1.23: per-user spend is wrong';
  end if;

  perform set_config('vkin.lease_b', lb::text, true);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 2. As A (authenticated): read own only, write nothing, execute nothing.
-- ---------------------------------------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

do $$
declare
  a uuid := 'a0000000-0000-4000-8000-000000000002';
  b uuid := 'b0000000-0000-4000-8000-000000000002';
  lb uuid := current_setting('vkin.lease_b')::uuid;
begin
  if (select auth.uid()) is distinct from a then
    raise exception 'FAIL 2.0: setup is not impersonating A';
  end if;

  -- 2.1 reads: own rows only.
  if (select count(*) from public.entitlements) <> 1 or not exists (select 1 from public.entitlements where user_id = a) then
    raise exception 'FAIL 2.1: A does not see exactly its own entitlement';
  end if;
  if exists (select 1 from public.entitlements where user_id <> a)
     or exists (select 1 from public.leases where user_id <> a)
     or exists (select 1 from public.leases where id = lb) then
    raise exception 'FAIL 2.2: A can read B''s entitlement or leases';
  end if;
  if not exists (select 1 from public.leases where user_id = a) then
    raise exception 'FAIL 2.3: A cannot read its own leases';
  end if;
  begin
    perform 1 from public.usage_events;
    raise exception 'FAIL 2.4: A can read usage_events';
  exception when insufficient_privilege then null;
  end;

  -- 2.5 writes: none.
  begin
    insert into public.entitlements (user_id, trial_seconds) values (a, 999999);
    raise exception 'FAIL 2.5: A inserted an entitlement';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.entitlements set used_seconds = 0 where user_id = a;
    raise exception 'FAIL 2.6: A updated its entitlement';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.entitlements set purchased_seconds = 999999 where user_id = b;
    raise exception 'FAIL 2.7: A updated B''s entitlement';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.entitlements where user_id = a;
    raise exception 'FAIL 2.8: A deleted its entitlement';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.leases (user_id, device) values (a, 'forged');
    raise exception 'FAIL 2.9: A inserted a lease';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.leases set last_beat_at = now(), status = 'active', ended_at = null where user_id = a;
    raise exception 'FAIL 2.10: A updated its leases';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.leases set status = 'ended', ended_at = now() where id = lb;
    raise exception 'FAIL 2.11: A updated B''s lease';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.leases where user_id = a;
    raise exception 'FAIL 2.12: A deleted its leases';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.usage_events (user_id, provider, cost_usd) values (a, 'nebius', 0);
    raise exception 'FAIL 2.13: A inserted a usage event';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.usage_events set cost_usd = 0;
    raise exception 'FAIL 2.14: A updated usage events';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.usage_events;
    raise exception 'FAIL 2.15: A deleted usage events';
  exception when insufficient_privilege then null;
  end;

  -- 2.16 functions: none executable.
  begin perform public.vkin_ensure_entitlement(a); raise exception 'FAIL 2.16: A executed vkin_ensure_entitlement';
  exception when insufficient_privilege then null; end;
  begin perform public.vkin_trial_eligible(a); raise exception 'FAIL 2.17: A executed vkin_trial_eligible';
  exception when insufficient_privilege then null; end;
  begin perform public.vkin_me(a); raise exception 'FAIL 2.18: A executed vkin_me';
  exception when insufficient_privilege then null; end;
  begin perform public.vkin_start_lease(a, 'x'); raise exception 'FAIL 2.19: A executed vkin_start_lease';
  exception when insufficient_privilege then null; end;
  begin perform public.vkin_bill_lease(b, lb); raise exception 'FAIL 2.20: A executed vkin_bill_lease';
  exception when insufficient_privilege then null; end;
  begin perform public.vkin_stop_lease(b, lb); raise exception 'FAIL 2.21: A executed vkin_stop_lease';
  exception when insufficient_privilege then null; end;
  begin perform public.vkin_bill(b, lb, true); raise exception 'FAIL 2.22: A executed vkin_bill';
  exception when insufficient_privilege then null; end;
  begin perform public.vkin_lease_state(b, lb); raise exception 'FAIL 2.23: A executed vkin_lease_state';
  exception when insufficient_privilege then null; end;
  begin perform public.vkin_expire_leases(); raise exception 'FAIL 2.24: A executed vkin_expire_leases';
  exception when insufficient_privilege then null; end;
  begin perform public.vkin_expire_user_stale(b); raise exception 'FAIL 2.25: A executed vkin_expire_user_stale';
  exception when insufficient_privilege then null; end;
  begin perform public.vkin_record_usage(a, null, 'nebius', 'x', 0, 0, 0); raise exception 'FAIL 2.26: A executed vkin_record_usage';
  exception when insufficient_privilege then null; end;
  begin perform public.vkin_spend_totals(); raise exception 'FAIL 2.27: A executed vkin_spend_totals';
  exception when insufficient_privilege then null; end;
  begin perform public.vkin_user_spend(a); raise exception 'FAIL 2.28: A executed vkin_user_spend';
  exception when insufficient_privilege then null; end;
  begin perform public.vkin_close_stale(b, lb); raise exception 'FAIL 2.29: A executed vkin_close_stale';
  exception when insufficient_privilege then null; end;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 3. As anon: nothing at all.
-- ---------------------------------------------------------------------------------------------------------
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
begin
  begin perform 1 from public.entitlements; raise exception 'FAIL 3.1: anon read entitlements';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.leases; raise exception 'FAIL 3.2: anon read leases';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.usage_events; raise exception 'FAIL 3.3: anon read usage_events';
  exception when insufficient_privilege then null; end;
  begin perform public.vkin_me('a0000000-0000-4000-8000-000000000002'); raise exception 'FAIL 3.4: anon executed vkin_me';
  exception when insufficient_privilege then null; end;
  begin perform public.vkin_start_lease('a0000000-0000-4000-8000-000000000002', 'x'); raise exception 'FAIL 3.5: anon executed vkin_start_lease';
  exception when insufficient_privilege then null; end;
end $$;

reset role;

select 'vkin entitlements: ALL CHECKS PASSED (everything below is rolled back)' as result;

rollback;
