// In-memory stand-in for the parts of supabase-js that src/lib/data.ts uses. It models the server rules
// from docs/vkin-contracts.md that matter for tests: user_id set by the server, RLS owner scoping,
// the vkin_check_rev trigger (rev must be stored + 1) and ids supplied by the client.
import type { SbError, SbLike, StorageLike } from '../lib/data';

type Row = Record<string, unknown> & { id: string; rev: number };
type Result = { data: unknown; error: SbError | null };

export interface WriteLog {
  op: 'insert' | 'update' | 'upsert';
  table: string;
  payload: Record<string, unknown>;
}

export class FakeSupabase implements SbLike {
  tables: Record<string, Row[]> = {};
  writes: WriteLog[] = [];
  rpcCalls: { fn: string; args?: Record<string, unknown> }[] = [];
  removedPaths: string[] = [];
  signOutCalls: { scope?: string }[] = [];
  signOutError: SbError | null = null;
  rpcError: SbError | null = null;
  uid: string;
  clock = 0;

  constructor(uid = '00000000-0000-4000-8000-000000000001') {
    this.uid = uid;
  }

  seed(table: string, rows: Record<string, unknown>[]): void {
    this.tables[table] = [
      ...(this.tables[table] ?? []),
      ...rows.map((r) => ({
        user_id: this.uid,
        rev: 1,
        created_at: this.stamp(),
        updated_at: this.stamp(),
        deleted_at: null,
        ...r,
      })) as unknown as Row[],
    ];
  }

  /** Simulates another device changing a row behind the web app's back. */
  bump(table: string, id: string, patch: Record<string, unknown> = {}): void {
    const r = this.rows(table).find((x) => x.id === id)!;
    Object.assign(r, patch, { rev: r.rev + 1, updated_at: this.stamp() });
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  stamp(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 9, 28, 12, 0, this.clock)).toISOString();
  }

  from(table: string): Query {
    return new Query(this, table);
  }

  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<Result> {
    this.rpcCalls.push({ fn, args });
    return Promise.resolve({ data: null, error: this.rpcError });
  }

  /** Object paths in the documents bucket, e.g. <uid>/<copilot>/<doc>. */
  objects: string[] = [];
  listCalls: { path: string; limit?: number; offset?: number }[] = [];
  removeBatches: string[][] = [];

  storage = {
    from: (_bucket: string) => ({
      remove: (paths: string[]): PromiseLike<Result> => {
        this.removedPaths.push(...paths);
        this.removeBatches.push([...paths]);
        this.objects = this.objects.filter((o) => !paths.includes(o));
        return Promise.resolve({ data: null, error: null });
      },
      list: (
        path = '',
        opts: { limit?: number; offset?: number } = {},
      ): PromiseLike<{ data: { name: string; id: string | null }[] | null; error: SbError | null }> => {
        this.listCalls.push({ path, ...opts });
        const prefix = path ? path + '/' : '';
        const entries = new Map<string, string | null>();
        for (const o of this.objects) {
          if (!o.startsWith(prefix)) continue;
          const rest = o.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash === -1) entries.set(rest, 'obj-' + rest);
          else entries.set(rest.slice(0, slash), null);
        }
        const all = [...entries].map(([name, id]) => ({ name, id })).sort((a, b) => a.name.localeCompare(b.name));
        const offset = opts.offset ?? 0;
        return Promise.resolve({ data: all.slice(offset, offset + (opts.limit ?? 100)), error: null });
      },
    }),
  };
  auth = {
    signOut: (options?: { scope?: string }): PromiseLike<{ error: SbError | null }> => {
      this.signOutCalls.push({ scope: options?.scope });
      return Promise.resolve({ error: this.signOutError });
    },
  };
}

class Query implements PromiseLike<Result> {
  private op: 'select' | 'insert' | 'update' | 'upsert' = 'select';
  private payload: Record<string, unknown> = {};
  private filters: ((r: Row) => boolean)[] = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private window: [number, number] | null = null;
  private wantRows = false;
  private mode: 'many' | 'single' | 'maybe' = 'many';

  constructor(
    private db: FakeSupabase,
    private table: string,
  ) {}

  select(_cols = '*'): this {
    if (this.op !== 'select') this.wantRows = true;
    return this;
  }
  upsert(payload: Record<string, unknown>, _opts?: unknown): this {
    this.op = 'upsert';
    this.payload = payload;
    return this;
  }
  update(payload: Record<string, unknown>): this {
    this.op = 'update';
    this.payload = payload;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  is(col: string, val: null): this {
    this.filters.push((r) => (r[col] ?? null) === val);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { col, asc: opts?.ascending !== false };
    return this;
  }
  range(from: number, to: number): this {
    this.window = [from, to];
    return this;
  }
  single(): this {
    this.mode = 'single';
    return this;
  }
  maybeSingle(): this {
    this.mode = 'maybe';
    return this;
  }

  then<A = Result, B = never>(
    onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  private shape(live: Row[]): Result {
    const rows = structuredClone(live); // the real server never hands back live references
    if (this.mode === 'many') return { data: rows, error: null };
    if (rows.length === 0) {
      return this.mode === 'maybe'
        ? { data: null, error: null }
        : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
    }
    return { data: rows[0], error: null };
  }

  private run(): Result {
    const db = this.db;
    const rows = db.rows(this.table);
    const mine = () => rows.filter((r) => r.user_id === db.uid && this.filters.every((f) => f(r)));

    if (this.op === 'select') {
      let out = mine();
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
      }
      if (this.window) out = out.slice(this.window[0], this.window[1] + 1);
      return this.shape(out);
    }

    if ('user_id' in this.payload && this.payload.user_id !== db.uid) {
      return { data: null, error: { message: 'new row violates row-level security policy', code: '42501' } };
    }

    if (this.op === 'upsert') {
      db.writes.push({ op: 'upsert', table: this.table, payload: { ...this.payload } });
      const existing = rows.find((r) => r.id === this.payload.id);
      if (existing) {
        if (existing.user_id !== db.uid) {
          return { data: null, error: { message: 'new row violates row-level security policy', code: '42501' } };
        }
        return this.applyUpdate([existing]);
      }
      const row = {
        user_id: db.uid,
        created_at: db.stamp(),
        updated_at: db.stamp(),
        deleted_at: null,
        ...this.payload,
      } as unknown as Row;
      rows.push(row);
      return this.wantRows ? this.shape([row]) : { data: null, error: null };
    }

    // update
    db.writes.push({ op: 'update', table: this.table, payload: { ...this.payload } });
    return this.applyUpdate(mine());
  }

  private applyUpdate(targets: Row[]): Result {
    const db = this.db;
    for (const r of targets) {
      if (this.payload.rev !== r.rev + 1) {
        return { data: null, error: { message: 'vkin_rev_conflict: row is at a different rev', code: 'PT409' } };
      }
    }
    for (const r of targets) {
      Object.assign(r, this.payload, { updated_at: db.stamp() });
    }
    return this.wantRows ? this.shape(targets) : { data: null, error: null };
  }
}

export class FakeStorage implements StorageLike {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  keys(): string[] {
    return [...this.m.keys()];
  }
}
