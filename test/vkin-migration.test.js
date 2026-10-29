'use strict';
// Static checks of the Supabase migration and isolation tooling (no database is available in CI), plus a
// cross-check that the SQL schema and src/main/vkin/schema.js agree.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { TABLES, COMMON_COLUMNS, SERVER_ONLY_COLUMNS, CONTENT_COLUMNS, TOMBSTONE_CLEAR, PARENTS, LIMITS } = require('../src/main/vkin/schema');
const { runIsolation, checkEnv } = require('../scripts/vkin-isolation-test');

const ROOT = path.join(__dirname, '..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '0001_vkin_init.sql'), 'utf8');
const ISO = fs.readFileSync(path.join(ROOT, 'supabase', 'tests', 'isolation.sql'), 'utf8');
const code = SQL.replace(/--[^\n]*/g, ''); // without comments

function tableBody(t) {
  const m = new RegExp(`create table public\\.${t} \\(([\\s\\S]*?)\\n\\);`).exec(code);
  assert.ok(m, `create table public.${t}`);
  return m[1];
}

function columnsOf(t) {
  return tableBody(t).split('\n')
    .map((l) => /^ {2}([a-z_]+) (uuid|integer|timestamptz|text|jsonb|boolean|text\[\])\b/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
}

test('migration: every contract table exists with exactly the columns schema.js pushes', () => {
  for (const t of TABLES) {
    const expected = [...COMMON_COLUMNS, ...SERVER_ONLY_COLUMNS, ...CONTENT_COLUMNS[t]].sort();
    assert.deepEqual(columnsOf(t).sort(), expected, t);
    const body = tableBody(t);
    assert.match(body, /id uuid primary key/, `${t}: client-generated uuid id`);
    assert.match(body, /user_id uuid not null default auth\.uid\(\) references auth\.users \(id\) on delete cascade/, `${t}: owner column`);
    assert.match(body, /rev integer not null default 1 check \(rev >= 1\)/, `${t}: rev`);
    assert.match(body, new RegExp(`constraint ${t}_id_user_key unique \\(id, user_id\\)`), `${t}: (id, user_id) unique`);
  }
});

test('migration: RLS enabled and forced, four per-operation policies to authenticated using (select auth.uid())', () => {
  for (const t of TABLES) {
    assert.match(code, new RegExp(`alter table public\\.${t} enable row level security;`), `${t} enable`);
    assert.match(code, new RegExp(`alter table public\\.${t} force row level security;`), `${t} force`);
    const own = 'user_id = \\(select auth\\.uid\\(\\)\\)';
    assert.match(code, new RegExp(`on public\\.${t} for select to authenticated\\s+using \\(${own}\\);`), `${t} select`);
    assert.match(code, new RegExp(`on public\\.${t} for insert to authenticated\\s+with check \\(${own}\\);`), `${t} insert`);
    assert.match(code, new RegExp(`on public\\.${t} for update to authenticated\\s+using \\(${own}\\) with check \\(${own}\\);`), `${t} update`);
    assert.match(code, new RegExp(`on public\\.${t} for delete to authenticated\\s+using \\(${own}\\);`), `${t} delete`);
  }
  const policies = code.match(/create policy[\s\S]*?;/g) || [];
  assert.equal(policies.length, TABLES.length * 4 + 4);
  for (const p of policies) {
    assert.match(p, /to authenticated/, p);
    assert.doesNotMatch(p.replace(/\(select auth\.uid\(\)\)/g, ''), /auth\.uid\(\)/, `unwrapped auth.uid(): ${p}`);
  }
});

test('migration: triggers for guard, tombstone, rev check and server updated_at on every table', () => {
  for (const t of TABLES) {
    assert.match(code, new RegExp(`create trigger vkin_10_guard before update on public\\.${t} `), `${t} guard`);
    assert.match(code, new RegExp(`create trigger vkin_20_tombstone before insert or update on public\\.${t} for each row execute function public\\.vkin_tombstone_${t}\\(\\)`), `${t} tombstone`);
    assert.match(code, new RegExp(`create trigger vkin_30_check_rev before update on public\\.${t} for each row execute function public\\.vkin_check_rev\\(\\)`), `${t} rev`);
    assert.match(code, new RegExp(`create trigger vkin_40_updated_at before insert or update on public\\.${t} `), `${t} updated_at`);
    assert.match(code, new RegExp(`create index ${t}_user_updated_idx on public\\.${t} \\(user_id, updated_at, id\\)`), `${t} cursor index`);
  }
  assert.match(code, /errcode = 'PT409'/);
  assert.match(code, /errcode = 'PT410'/);
  assert.match(code, /new\.updated_at := clock_timestamp\(\)/);
  assert.match(code, /if new\.user_id is distinct from old\.user_id then/);
});

test('migration: vkin_guard_row freezes id, owner and every parent link column', () => {
  const guard = /function public\.vkin_guard_row\(\)[\s\S]*?\$\$;/.exec(code);
  assert.ok(guard);
  const parentCols = new Set(Object.values(PARENTS).flat().map((l) => l.column));
  parentCols.add('session_id'); // memory_items.session_id is an optional parent link
  for (const col of parentCols) {
    assert.ok(guard[0].includes(`(to_jsonb(new) -> '${col}') is distinct from (to_jsonb(old) -> '${col}')`), col);
  }
  assert.match(guard[0], /vkin_parent_immutable[\s\S]*errcode = 'PT400'/);
  assert.ok(ISO.includes('FAIL 6.6') && ISO.includes('FAIL 6.7'), 'isolation.sql exercises the freeze');
});

test('migration: tombstone triggers clear the same columns the local store clears', () => {
  for (const t of TABLES) {
    const fn = new RegExp(`function public\\.vkin_tombstone_${t}\\(\\)[\\s\\S]*?\\$\\$;`).exec(code);
    assert.ok(fn, `vkin_tombstone_${t}`);
    for (const col of Object.keys(TOMBSTONE_CLEAR[t])) assert.match(fn[0], new RegExp(`new\\.${col} :=`), `${t}.${col}`);
  }
  assert.match(code, /if new\.status = 'forgotten' then\s+new\.deleted_at := coalesce\(new\.deleted_at, clock_timestamp\(\)\)/);
});

test('migration: children use composite FKs to (parent id, user_id); commitment/enums/length checks present', () => {
  for (const [t, links] of Object.entries(PARENTS)) {
    for (const { column, parent } of links) {
      const fk = new RegExp(`foreign key \\(${column}(, [a-z_]+)*, user_id\\)\\s+references public\\.${parent} \\(id(, [a-z_]+)*, user_id\\)`);
      assert.match(tableBody(t), fk, `${t}.${column} -> ${parent}`);
    }
  }
  assert.match(tableBody('memory_items'), /check \(kind <> 'commitment' or origin in \('my_speech', 'confirmed'\)\)/);
  assert.match(tableBody('copilots'), /check \(memory_scope in \('thread', 'copilot'\)\)/);
  assert.match(tableBody('transcript_lines'), /check \(speaker in \('me', 'them'\)\)/);
  const lengths = { copilots: { name: LIMITS.copilot_name, purpose: LIMITS.purpose, instructions: LIMITS.instructions }, profiles: { about: LIMITS.about, today_context: LIMITS.today_context }, profile_facts: { text: LIMITS.fact_text }, threads: { title: LIMITS.thread_title }, sessions: { summary: LIMITS.summary }, memory_items: { text: LIMITS.memory_text }, transcript_lines: { text: LIMITS.transcript_text } };
  for (const [t, cols] of Object.entries(lengths)) {
    for (const [c, n] of Object.entries(cols)) assert.match(tableBody(t), new RegExp(`check \\(char_length\\(${c}\\) <= ${n}\\)`), `${t}.${c} <= ${n}`);
  }
});

test('migration: functions are invoker with a pinned search_path; anon gets nothing', () => {
  assert.doesNotMatch(code, /security definer/i);
  const fns = code.match(/create or replace function[\s\S]*?\$\$;/g) || [];
  assert.ok(fns.length >= 16);
  for (const f of fns) assert.match(f, /set search_path = ''/, f.slice(0, 80));
  assert.match(code, /function public\.vkin_delete_thread\(p_id uuid\)\s+returns jsonb\s+language plpgsql\s+security invoker/);
  assert.match(code, /function public\.vkin_delete_account_data\(\)\s+returns jsonb\s+language plpgsql\s+security invoker/);
  assert.doesNotMatch(code, /grant [^;]* to [^;]*\banon\b/i);
  assert.match(code, /revoke all on table public\.profiles,[\s\S]*? from anon, authenticated, public;/);
  assert.match(code, /revoke all on function public\.vkin_delete_thread\(uuid\) from public, anon;/);
});

test('migration: private documents bucket with first-folder = auth.uid() policies for every operation', () => {
  assert.match(code, /insert into storage\.buckets \(id, name, public, file_size_limit\)\s+values \('documents', 'documents', false,/);
  assert.match(code, /on conflict \(id\) do update set public = false/);
  for (const op of ['select', 'insert', 'update', 'delete']) {
    assert.match(code, new RegExp(`on storage\\.objects for ${op} to authenticated`), op);
  }
  const folder = /\(storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text/g;
  assert.equal((code.match(folder) || []).length, 5, 'select, insert, update (using + check), delete');
});

test('isolation.sql: one rolled-back transaction impersonating two users, covering every rule', () => {
  const sql = ISO.replace(/--[^\n]*/g, '').trim();
  assert.match(sql, /^begin;/);
  assert.match(sql, /rollback;$/);
  assert.doesNotMatch(sql, /\bcommit\b/i);
  assert.match(sql, /set local role authenticated;/);
  assert.match(sql, /set_config\('request\.jwt\.claims', '\{"sub":"a0000000-0000-4000-8000-000000000001"/);
  assert.match(sql, /set_config\('request\.jwt\.claims', '\{"sub":"b0000000-0000-4000-8000-000000000001"/);
  for (const needle of [
    'FAIL 3.1', 'FAIL 4.1', 'FAIL 4.5', 'FAIL 5.1', 'FAIL 5.4', 'FAIL 6.1', 'FAIL 6.5', 'FAIL 7.1', 'FAIL 7.2',
    'FAIL 8.1', 'FAIL 8.3', 'FAIL 9.1', 'FAIL 9.2', 'FAIL 9.5', 'FAIL 10.1', 'FAIL 10.3', 'FAIL 10.4', 'FAIL 11.1',
    'FAIL 12.1', 'FAIL 13.2', "sqlstate 'PT409'", "sqlstate 'PT410'", 'foreign_key_violation', 'insufficient_privilege',
  ]) assert.ok(sql.includes(needle), needle);
});

test('isolation script: refuses without every env var or with a service_role key, and never echoes secrets', async () => {
  const lines = [];
  let created = 0;
  const createClient = () => { created += 1; return {}; };
  const r1 = await runIsolation({ env: {}, createClient, log: (l) => lines.push(l) });
  assert.match(r1.refused, /VKIN_SUPABASE_URL/);
  const secretPw = 'pw-should-never-print';
  const svc = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"role":"service_role"}').toString('base64url')}.sig`;
  const env = {
    VKIN_SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co', VKIN_SUPABASE_ANON_KEY: svc,
    VKIN_TEST_A_EMAIL: 'a@example.invalid', VKIN_TEST_A_PASSWORD: secretPw, VKIN_TEST_B_EMAIL: 'b@example.invalid', VKIN_TEST_B_PASSWORD: secretPw,
  };
  const r2 = await runIsolation({ env, createClient, log: (l) => lines.push(l) });
  assert.match(r2.refused, /service_role/);
  assert.equal(checkEnv({ ...env, VKIN_SUPABASE_ANON_KEY: 'sb_publishable_x', VKIN_TEST_B_EMAIL: 'A@example.invalid ' }).ok, false, 'A and B must differ');
  assert.equal(checkEnv({ ...env, VKIN_SUPABASE_ANON_KEY: 'sb_publishable_x' }).ok, true);
  assert.equal(created, 0, 'no client created when refusing');
  const out = lines.join('\n');
  assert.ok(!out.includes(secretPw) && !out.includes(svc) && !out.includes('a@example.invalid'));
});
