import { useSyncExternalStore, useEffect } from 'react';

// `__BUILD_ID__` is injected by vite.config.ts (the git sha at build time); the
// deployed `/version.json` carries the same id, so a running client can tell when
// a newer build has shipped.
declare const __BUILD_ID__: string;
export const BUILD_ID: string = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';

let stale = false;
const subs = new Set<() => void>();

// Every ask is a Vercel Edge Request, billed per request past the plan's allowance. A
// visible tab asks every 2 minutes, a hidden one never, and a tab coming back into view
// asks at once. Until 2026-10-12 every open tab asked every 90 s, hidden or not: ~40
// requests an hour per tab left open in the background. Not longer than this for a
// visible tab: the matchmaker splits the queue by build, so a tab that missed a deploy
// waits on a smaller pool until it notices.
const POLL_MS = 2 * 60_000;
// focus and visibilitychange fire together on an alt-tab: one ask per minute is enough
const MIN_GAP_MS = 60_000;
let lastPoll = 0;

async function poll(): Promise<void> {
  if (stale) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const now = Date.now();
  if (now - lastPoll < MIN_GAP_MS) return;
  lastPoll = now;
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

/** true once the DEPLOYED client build differs from the one running here. Polls
 * while the tab is visible (see POLL_MS) and when it comes back into view. */
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
    const id = window.setInterval(poll, POLL_MS);
    const onShow = (): void => void poll();
    window.addEventListener('focus', onShow);
    document.addEventListener('visibilitychange', onShow);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onShow);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, []);
  return v;
}
