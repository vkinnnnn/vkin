import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { signOutAndClear, type StorageLike } from './data';

export interface AuthUser {
  id: string;
  email: string | null;
}

interface AuthValue {
  client: SupabaseClient;
  user: AuthUser | null;
  /** 'loading' until the stored session (or a magic-link redirect) has been read. */
  status: 'loading' | 'ready';
  /** Bumps on sign-out; the app tree is keyed on it so all React state is discarded. */
  epoch: number;
  /** Shown once on the sign-in page after signing out (or after deleting all data). */
  farewell: Farewell | null;
  clearFarewell(): void;
  signOut(opts?: { deleted?: boolean }): Promise<void>;
}

export interface Farewell {
  deleted?: boolean;
  warning?: string | null;
}

const Ctx = createContext<AuthValue | null>(null);

function browserStorages(): StorageLike[] {
  const out: StorageLike[] = [];
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try {
      out.push(window[name]);
    } catch {
      // storage blocked; nothing to clear there
    }
  }
  return out;
}

export function AuthProvider({ client, children }: { client: SupabaseClient; children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready'>('loading');
  const [epoch, setEpoch] = useState(0);
  const [farewell, setFarewell] = useState<Farewell | null>(null);

  useEffect(() => {
    let alive = true;
    const toUser = (u: { id: string; email?: string | null } | null | undefined): AuthUser | null =>
      u ? { id: u.id, email: u.email ?? null } : null;

    void client.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setUser(toUser(data.session?.user));
      setStatus('ready');
    });
    // Do not await other Supabase calls inside this callback.
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      if (!alive) return;
      setUser(toUser(session?.user));
      setStatus('ready');
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

  const signOut = useCallback(
    async (opts?: { deleted?: boolean }): Promise<void> => {
      const { warning } = await signOutAndClear(client, browserStorages());
      setFarewell({ deleted: opts?.deleted, warning });
      setUser(null);
      setEpoch((e) => e + 1);
    },
    [client],
  );

  const clearFarewell = useCallback(() => setFarewell(null), []);

  const value = useMemo(
    () => ({ client, user, status, epoch, farewell, clearFarewell, signOut }),
    [client, user, status, epoch, farewell, clearFarewell, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}

/** The signed-in user. Only call inside the authenticated app routes. */
export function useUser(): AuthUser {
  const { user } = useAuth();
  if (!user) throw new Error('No signed-in user');
  return user;
}
