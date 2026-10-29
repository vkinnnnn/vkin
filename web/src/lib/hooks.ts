import { useCallback, useEffect, useRef, useState } from 'react';

export interface Loaded<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/** Runs `fn` on mount, when `deps` change, and when `reload()` is called. Every load really hits the server. */
export function useLoad<T>(fn: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fnRef.current().then(
      (d) => {
        if (!alive) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** Wraps a mutation: tracks busy state and keeps the last error for display. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { busy, error, run, clear, setError };
}

export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · Vkin`;
  }, [title]);
}
