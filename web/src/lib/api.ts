// Calls to the hosted Vkin API (docs/vkin-hosted-api.md). The Supabase access token goes in the
// Authorization header only, never in a URL or query string.

export interface ActiveLease {
  id: string;
  device: string;
  startedAt: string;
}

/** GET /v1/me response. All durations are in seconds. */
export interface Me {
  userId: string;
  email: string | null;
  trialSeconds: number;
  purchasedSeconds: number;
  usedSeconds: number;
  remainingSeconds: number;
  activeLease: ActiveLease | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** The part of a Supabase client used to read the current access token. */
export interface SessionSource {
  auth: { getSession(): Promise<{ data: { session: { access_token: string } | null } }> };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0);

function parseMe(body: unknown): Me {
  const b = (body ?? {}) as Record<string, unknown>;
  const lease = b.activeLease as Record<string, unknown> | null | undefined;
  return {
    userId: String(b.userId ?? ''),
    email: typeof b.email === 'string' ? b.email : null,
    trialSeconds: num(b.trialSeconds),
    purchasedSeconds: num(b.purchasedSeconds),
    usedSeconds: num(b.usedSeconds),
    remainingSeconds: num(b.remainingSeconds),
    activeLease:
      lease && typeof lease === 'object'
        ? { id: String(lease.id ?? ''), device: String(lease.device ?? 'another device'), startedAt: String(lease.startedAt ?? '') }
        : null,
  };
}

function friendlyError(status: number, code: string): string {
  if (status === 401) return 'Your session has expired. Sign out and sign in again.';
  if (status === 503) return 'The Vkin server is busy right now. Try again in a moment.';
  if (code === 'network') return 'Could not reach the Vkin server. Check your connection and try again.';
  return 'Could not load your minutes. Try again.';
}

/** GET {baseUrl}/v1/me with a bearer token. Throws ApiError with a short, human message. */
export async function fetchMe(
  baseUrl: string,
  accessToken: string,
  opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<Me> {
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await doFetch(`${baseUrl.replace(/\/+$/, '')}/v1/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(friendlyError(0, 'network'), 0, 'network');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const code = typeof (body as { error?: unknown } | null)?.error === 'string' ? (body as { error: string }).error : 'http_error';
    throw new ApiError(friendlyError(res.status, code), res.status, code);
  }
  return parseMe(body);
}

/** Reads the signed-in user's access token from Supabase, then calls GET /v1/me. */
export async function getMe(client: SessionSource, baseUrl: string, opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {}): Promise<Me> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError(friendlyError(401, 'unauthorized'), 401, 'unauthorized');
  return fetchMe(baseUrl, token, opts);
}

/** "7 min 30 s", "10 min", "45 s". */
export function fmtMinutes(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m === 0) return `${rest} s`;
  return rest === 0 ? `${m} min` : `${m} min ${rest} s`;
}
