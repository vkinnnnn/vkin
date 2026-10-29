-- Vkin hosted API: entitlements, copilot-time leases and provider usage (docs/vkin-hosted-api.md).
--
-- Run once after 0001_vkin_init.sql, as the project owner. Then run supabase/tests/entitlements.sql; it rolls
-- itself back.
--
-- Security model
--   * Only the hosted API (service_role) reads or writes these tables, and only through the vkin_* functions
--     below. Every function is SECURITY INVOKER, search_path = '', and executable by service_role only.
--     The one exception is vkin_trial_eligible: a SECURITY DEFINER helper that returns a single boolean,
--     because API roles have no read access to auth.users / auth.identities.
--   * RLS enabled AND forced on every table. A signed-in user may SELECT their own entitlement and leases
--     (read-only); usage_events has no client access at all; anon gets nothing.
--   * All time is DB time (clock_timestamp()). Nothing the client reports is trusted.
--
-- Billing ("last_beat_at" means "billed through"; it may be in the future while prepaid time is unused)
--   * remaining = trial_seconds + purchased_seconds - used_seconds, floored at 0.
--   * Start charges a minimum of least(15 s, remaining) and sets last_beat_at = now + charge.
--   * A beat/stop bills ceil(now - last_beat_at) seconds (at most 45, never more than remaining) and advances
--     last_beat_at by exactly the billed seconds. The billing window equals the stale window, so a client
--     that beats rarely pays for every second.
--   * A lease whose last_beat_at is older than 45 s is stale: it is ended and billed least(45 s, remaining)
--     (by the sweep, or by that user's next beat/stop/start). A stale lease is never usable for chat or STT.
--   * Lock order everywhere: entitlement row, then lease row (no deadlock between start, beat and sweep).
--
-- Errors (SQLSTATE -> HTTP via PostgREST): PT402 vkin_no_minutes, PT409 vkin_lease_active, PT404 vkin_not_found,
-- PT400 vkin_bad_request.

-- ---------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------

create table public.entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  trial_seconds integer not null default 600 check (trial_seconds >= 0),
  purchased_seconds integer not null default 0 check (purchased_seconds >= 0),
  used_seconds integer not null default 0 check (used_seconds >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.leases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device text not null default '' check (char_length(device) <= 80),
  status text not null default 'active' check (status in ('active', 'ended')),
  started_at timestamptz not null default now(),
  last_beat_at timestamptz not null default now(),
  ended_at timestamptz,
  billed_seconds integer not null default 0 check (billed_seconds >= 0),
  constraint leases_ended_shape check ((status = 'active') = (ended_at is null))
);

-- One active lease per user; the sweep scans active leases by last beat.
create unique index leases_one_active_per_user on public.leases (user_id) where status = 'active';
create index leases_active_beat_idx on public.leases (last_beat_at) where status = 'active';
create index leases_user_idx on public.leases (user_id, started_at);

create table public.usage_events (
  id bigserial primary key,
  user_id uuid references auth.users (id) on delete set null,
  lease_id uuid references public.leases (id) on delete set null,
  provider text not null check (provider in ('nebius', 'gemini', 'deepgram')),
  model text not null default '' check (char_length(model) <= 120),
  units_in numeric not null default 0 check (units_in >= 0),
  units_out numeric not null default 0 check (units_out >= 0),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  at timestamptz not null default now()
);

create index usage_events_provider_at_idx on public.usage_events (provider, at);
create index usage_events_user_idx on public.usage_events (user_id, provider, at);

-- ---------------------------------------------------------------------------------------------------------
-- Row level security: enabled + forced. Owner may read own entitlement and leases; nothing else.
-- ---------------------------------------------------------------------------------------------------------

alter table public.entitlements enable row level security;
alter table public.entitlements force row level security;
alter table public.leases enable row level security;
alter table public.leases force row level security;
alter table public.usage_events enable row level security;
alter table public.usage_events force row level security;

create policy "vkin entitlements select own" on public.entitlements for select to authenticated
  using (user_id = (select auth.uid()));
create policy "vkin leases select own" on public.leases for select to authenticated
  using (user_id = (select auth.uid()));
-- usage_events: no policy for any client role (RLS denies everything).

-- ---------------------------------------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------------------------------------

-- True when the user has a confirmed email or a Google/GitHub identity. A phone or other identity does not
-- qualify on its own. SECURITY DEFINER because API roles cannot read auth.*; it returns one boolean only.
create or replace function public.vkin_trial_eligible(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.users u
    where u.id = p_user
      and (
        u.email_confirmed_at is not null
        or exists (select 1 from auth.identities i where i.user_id = u.id and i.provider in ('google', 'github'))
      )
  );
$$;

-- Grants the one-time trial if eligible (idempotent). Returns true when the user has an entitlement row.
create or replace function public.vkin_ensure_entitlement(p_user uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_user is null then
    raise exception 'vkin_bad_request: user required' using errcode = 'PT400';
  end if;
  if public.vkin_trial_eligible(p_user) then
    insert into public.entitlements (user_id) values (p_user) on conflict (user_id) do nothing;
  end if;
  return exists (select 1 from public.entitlements e where e.user_id = p_user);
end;
$$;

-- Ends one stale lease (last_beat_at older than 45 s) and bills least(45 s, remaining).
-- Returns the billed seconds, or null when the lease is not (or no longer) an active stale lease.
create or replace function public.vkin_close_stale(p_user uuid, p_lease uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  e public.entitlements;
  l public.leases;
  v_now timestamptz := clock_timestamp();
  v_bill integer;
begin
  select * into e from public.entitlements where user_id = p_user for update;
  select * into l from public.leases where id = p_lease and user_id = p_user for update;
  if l.id is null or l.status <> 'active' or l.last_beat_at >= v_now - interval '45 seconds' then
    return null;
  end if;
  v_bill := least(45, greatest(coalesce(e.trial_seconds + e.purchased_seconds - e.used_seconds, 0), 0));
  if e.user_id is not null and v_bill > 0 then
    update public.entitlements set used_seconds = used_seconds + v_bill, updated_at = v_now where user_id = p_user;
  end if;
  update public.leases set status = 'ended', ended_at = v_now, billed_seconds = billed_seconds + v_bill
    where id = l.id;
  return v_bill;
end;
$$;

-- Ends (and bills) this user's stale active lease, if any. Returns the ended lease id or null.
create or replace function public.vkin_expire_user_stale(p_user uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select l.id into v_id from public.leases l
    where l.user_id = p_user and l.status = 'active' and l.last_beat_at < clock_timestamp() - interval '45 seconds';
  if v_id is not null and public.vkin_close_stale(p_user, v_id) is not null then
    return v_id;
  end if;
  return null;
end;
$$;

create or replace function public.vkin_me(p_user uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  e public.entitlements;
  l public.leases;
begin
  perform public.vkin_ensure_entitlement(p_user);
  select * into e from public.entitlements where user_id = p_user;
  select * into l from public.leases
    where user_id = p_user and status = 'active' and last_beat_at >= clock_timestamp() - interval '45 seconds';
  return jsonb_build_object(
    'trialSeconds', coalesce(e.trial_seconds, 0),
    'purchasedSeconds', coalesce(e.purchased_seconds, 0),
    'usedSeconds', coalesce(e.used_seconds, 0),
    'remainingSeconds', greatest(coalesce(e.trial_seconds + e.purchased_seconds - e.used_seconds, 0), 0),
    'activeLease', case when l.id is null then null
      else jsonb_build_object('id', l.id, 'device', l.device, 'startedAt', l.started_at) end
  );
end;
$$;

-- Starts a lease and charges the 15 s minimum (or what is left). PT402 no minutes, PT409 another lease is
-- active. A stale lease of the same user is ended and billed first, and reported in "expired" so the API
-- can close its relays and chat streams.
create or replace function public.vkin_start_lease(p_user uuid, p_device text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  e public.entitlements;
  v_now timestamptz := clock_timestamp();
  v_remaining integer;
  v_charge integer;
  v_expired uuid;
  v_id uuid;
begin
  if p_device is not null and char_length(p_device) > 80 then
    raise exception 'vkin_bad_request: device is longer than 80 characters' using errcode = 'PT400';
  end if;
  perform public.vkin_ensure_entitlement(p_user);
  select * into e from public.entitlements where user_id = p_user for update;
  if e.user_id is null then
    raise exception 'vkin_no_minutes: no copilot time left' using errcode = 'PT402';
  end if;
  v_expired := public.vkin_expire_user_stale(p_user);
  select * into e from public.entitlements where user_id = p_user;
  v_remaining := greatest(e.trial_seconds + e.purchased_seconds - e.used_seconds, 0);
  if v_remaining <= 0 then
    raise exception 'vkin_no_minutes: no copilot time left' using errcode = 'PT402';
  end if;
  if exists (select 1 from public.leases where user_id = p_user and status = 'active') then
    raise exception 'vkin_lease_active: another session is active' using errcode = 'PT409';
  end if;
  v_charge := least(15, v_remaining);
  begin
    insert into public.leases (user_id, device, started_at, last_beat_at, billed_seconds)
      values (p_user, coalesce(p_device, ''), v_now, v_now + make_interval(secs => v_charge), v_charge)
      returning id into v_id;
  exception when unique_violation then
    raise exception 'vkin_lease_active: another session is active' using errcode = 'PT409';
  end;
  update public.entitlements set used_seconds = used_seconds + v_charge, updated_at = v_now where user_id = p_user;
  return jsonb_build_object(
    'leaseId', v_id,
    'remainingSeconds', v_remaining - v_charge,
    'chargedSeconds', v_charge,
    'expired', case when v_expired is null then '[]'::jsonb else jsonb_build_array(v_expired) end
  );
end;
$$;

-- Shared by beat and stop. p_end = true ends the lease after billing.
create or replace function public.vkin_bill(p_user uuid, p_lease uuid, p_end boolean)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  e public.entitlements;
  l public.leases;
  v_now timestamptz := clock_timestamp();
  v_elapsed numeric;
  v_remaining integer;
  v_bill integer := 0;
  v_status text;
  v_reason text := null;
begin
  select * into e from public.entitlements where user_id = p_user for update;
  select * into l from public.leases where id = p_lease and user_id = p_user for update;
  if l.id is null then
    raise exception 'vkin_not_found: lease not found' using errcode = 'PT404';
  end if;
  v_remaining := greatest(coalesce(e.trial_seconds + e.purchased_seconds - e.used_seconds, 0), 0);

  if l.status = 'ended' then
    return jsonb_build_object('remainingSeconds', v_remaining, 'status', 'ended', 'billedSeconds', 0, 'reason', 'already_ended');
  end if;

  v_elapsed := extract(epoch from (v_now - l.last_beat_at));
  if v_elapsed > 45 then
    -- Stale: ended and billed the full 45 s window, exactly as the sweep would.
    v_bill := coalesce(public.vkin_close_stale(p_user, p_lease), 0);
    return jsonb_build_object('remainingSeconds', v_remaining - v_bill, 'status', 'ended', 'billedSeconds', v_bill, 'reason', 'stale');
  end if;

  v_bill := least(greatest(ceil(v_elapsed), 0)::integer, v_remaining);
  if e.user_id is not null and v_bill > 0 then
    update public.entitlements set used_seconds = used_seconds + v_bill, updated_at = v_now where user_id = p_user;
  end if;
  v_remaining := v_remaining - v_bill;

  if p_end or v_remaining <= 0 then
    v_status := 'ended';
    v_reason := case when v_remaining <= 0 then 'no_minutes' else 'stopped' end;
    update public.leases
      set status = 'ended', ended_at = v_now, billed_seconds = billed_seconds + v_bill,
          last_beat_at = last_beat_at + make_interval(secs => v_bill)
      where id = l.id;
  else
    v_status := 'active';
    update public.leases
      set billed_seconds = billed_seconds + v_bill, last_beat_at = last_beat_at + make_interval(secs => v_bill)
      where id = l.id;
  end if;
  return jsonb_build_object('remainingSeconds', v_remaining, 'status', v_status, 'billedSeconds', v_bill, 'reason', v_reason);
end;
$$;

-- Heartbeat: bills the interval; ends the lease at 0 remaining. Returns {remainingSeconds, status, ...}.
create or replace function public.vkin_bill_lease(p_user uuid, p_lease uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.vkin_bill(p_user, p_lease, false);
$$;

-- Pause/End: bills the final interval and ends the lease. Idempotent on an ended lease.
create or replace function public.vkin_stop_lease(p_user uuid, p_lease uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.vkin_bill(p_user, p_lease, true);
$$;

-- Read-only lease check for chat and STT. PT404 when the lease is not this user's. A stale lease reads as
-- 'ended'. usableSeconds = remaining + prepaid seconds not yet consumed (last_beat_at in the future).
create or replace function public.vkin_lease_state(p_user uuid, p_lease uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  e public.entitlements;
  l public.leases;
  v_now timestamptz := clock_timestamp();
  v_status text;
  v_remaining integer;
begin
  select * into l from public.leases where id = p_lease and user_id = p_user;
  if l.id is null then
    raise exception 'vkin_not_found: lease not found' using errcode = 'PT404';
  end if;
  select * into e from public.entitlements where user_id = p_user;
  v_status := case when l.status = 'active' and l.last_beat_at < v_now - interval '45 seconds' then 'ended' else l.status end;
  v_remaining := greatest(coalesce(e.trial_seconds + e.purchased_seconds - e.used_seconds, 0), 0);
  return jsonb_build_object(
    'status', v_status,
    'remainingSeconds', v_remaining,
    'usableSeconds', case when v_status = 'active'
      then v_remaining + greatest(ceil(extract(epoch from (l.last_beat_at - v_now))), 0)::integer else 0 end
  );
end;
$$;

-- Sweep: ends and bills (least(45 s, remaining)) every lease that has not beaten for 45 s.
-- Returns the ended ids.
create or replace function public.vkin_expire_leases()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r record;
  v_ids jsonb := '[]'::jsonb;
begin
  for r in
    select l.id, l.user_id from public.leases l
    where l.status = 'active' and l.last_beat_at < clock_timestamp() - interval '45 seconds'
  loop
    if public.vkin_close_stale(r.user_id, r.id) is not null then
      v_ids := v_ids || to_jsonb(r.id);
    end if;
  end loop;
  return v_ids;
end;
$$;

create or replace function public.vkin_record_usage(
  p_user uuid, p_lease uuid, p_provider text, p_model text, p_units_in numeric, p_units_out numeric, p_cost_usd numeric
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.usage_events (user_id, lease_id, provider, model, units_in, units_out, cost_usd)
    values (p_user, p_lease, p_provider, coalesce(p_model, ''), coalesce(p_units_in, 0), coalesce(p_units_out, 0),
            coalesce(p_cost_usd, 0));
end;
$$;

-- Total recorded spend per provider (server-wide caps) and today's (UTC) Gemini request count.
create or replace function public.vkin_spend_totals()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'nebius', coalesce(sum(cost_usd) filter (where provider = 'nebius'), 0),
    'gemini', coalesce(sum(cost_usd) filter (where provider = 'gemini'), 0),
    'deepgram', coalesce(sum(cost_usd) filter (where provider = 'deepgram'), 0),
    'geminiRequestsToday', count(*) filter (
      where provider = 'gemini' and at >= (date_trunc('day', clock_timestamp() at time zone 'utc') at time zone 'utc'))
  )
  from public.usage_events;
$$;

-- One user's recorded spend per provider, today's (UTC) Nebius spend (the per-user daily cap) and today's
-- Gemini request count.
create or replace function public.vkin_user_spend(p_user uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'nebius', coalesce(sum(cost_usd) filter (where provider = 'nebius'), 0),
    'gemini', coalesce(sum(cost_usd) filter (where provider = 'gemini'), 0),
    'deepgram', coalesce(sum(cost_usd) filter (where provider = 'deepgram'), 0),
    'nebiusToday', coalesce(sum(cost_usd) filter (
      where provider = 'nebius' and at >= (date_trunc('day', clock_timestamp() at time zone 'utc') at time zone 'utc')), 0),
    'geminiRequestsToday', count(*) filter (
      where provider = 'gemini' and at >= (date_trunc('day', clock_timestamp() at time zone 'utc') at time zone 'utc'))
  )
  from public.usage_events
  where user_id = p_user;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Privileges: authenticated may SELECT (RLS: own rows) entitlements and leases; service_role does the rest
-- through the functions; anon and public get nothing.
-- ---------------------------------------------------------------------------------------------------------

revoke all on table public.entitlements, public.leases, public.usage_events from anon, authenticated, public;
revoke all on sequence public.usage_events_id_seq from anon, authenticated, public;
grant select on table public.entitlements, public.leases to authenticated;
grant select, insert, update, delete on table public.entitlements, public.leases, public.usage_events to service_role;
grant usage, select on sequence public.usage_events_id_seq to service_role;

revoke all on function public.vkin_trial_eligible(uuid) from public, anon, authenticated;
revoke all on function public.vkin_ensure_entitlement(uuid) from public, anon, authenticated;
revoke all on function public.vkin_close_stale(uuid, uuid) from public, anon, authenticated;
revoke all on function public.vkin_expire_user_stale(uuid) from public, anon, authenticated;
revoke all on function public.vkin_me(uuid) from public, anon, authenticated;
revoke all on function public.vkin_start_lease(uuid, text) from public, anon, authenticated;
revoke all on function public.vkin_bill(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.vkin_bill_lease(uuid, uuid) from public, anon, authenticated;
revoke all on function public.vkin_stop_lease(uuid, uuid) from public, anon, authenticated;
revoke all on function public.vkin_lease_state(uuid, uuid) from public, anon, authenticated;
revoke all on function public.vkin_expire_leases() from public, anon, authenticated;
revoke all on function public.vkin_record_usage(uuid, uuid, text, text, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function public.vkin_spend_totals() from public, anon, authenticated;
revoke all on function public.vkin_user_spend(uuid) from public, anon, authenticated;

grant execute on function public.vkin_trial_eligible(uuid) to service_role;
grant execute on function public.vkin_ensure_entitlement(uuid) to service_role;
grant execute on function public.vkin_close_stale(uuid, uuid) to service_role;
grant execute on function public.vkin_expire_user_stale(uuid) to service_role;
grant execute on function public.vkin_me(uuid) to service_role;
grant execute on function public.vkin_start_lease(uuid, text) to service_role;
grant execute on function public.vkin_bill(uuid, uuid, boolean) to service_role;
grant execute on function public.vkin_bill_lease(uuid, uuid) to service_role;
grant execute on function public.vkin_stop_lease(uuid, uuid) to service_role;
grant execute on function public.vkin_lease_state(uuid, uuid) to service_role;
grant execute on function public.vkin_expire_leases() to service_role;
grant execute on function public.vkin_record_usage(uuid, uuid, text, text, numeric, numeric, numeric) to service_role;
grant execute on function public.vkin_spend_totals() to service_role;
grant execute on function public.vkin_user_spend(uuid) to service_role;
