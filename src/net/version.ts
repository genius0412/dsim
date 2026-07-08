import { useSyncExternalStore, useEffect } from 'react';

// `__BUILD_ID__` is injected by vite.config.ts (the git sha at build time); the
// deployed `/version.json` carries the same id, so a running client can tell when
// a newer build has shipped.
declare const __BUILD_ID__: string;
export const BUILD_ID: string = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';

let stale = false;
const subs = new Set<() => void>();

async function poll(): Promise<void> {
  if (stale) return;
  try {
    const r = await fetch('/version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const j = (await r.json()) as { build?: string };
    if (j.build && j.build !== BUILD_ID) {
      stale = true;
      subs.forEach((f) => f());
    }
  } catch {
    /* offline or not deployed (dev) — ignore */
  }
}

/** true once the DEPLOYED client build differs from the one running here. Polls a
 * few times a minute in the background. */
export function useNewVersion(): boolean {
  const v = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => stale,
    () => stale,
  );
  useEffect(() => {
    poll();
    const id = window.setInterval(poll, 90_000);
    const onFocus = (): void => void poll();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
  return v;
}
