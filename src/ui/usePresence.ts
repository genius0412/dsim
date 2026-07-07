import { useEffect, useState } from 'react';
import { fetchPresence, type Presence } from '../net/api';
import { gameServerConfigured } from '../net/env';

/**
 * Poll the game server's live presence (online / signed-in / per-queue depth).
 * Returns null until the first successful fetch, and stays null when the game
 * server isn't configured or a fetch fails (callers just render nothing).
 *
 * Polls only while mounted, so navigating away stops the requests — deliberate,
 * because each poll wakes the auto-stopping Fly machine. The default 8s cadence
 * keeps queue counts fresh enough to decide on without hammering the server.
 */
export function usePresence(pollMs = 8000): Presence | null {
  const [presence, setPresence] = useState<Presence | null>(null);
  useEffect(() => {
    if (!gameServerConfigured()) return;
    let alive = true;
    const tick = (): void => {
      fetchPresence()
        .then((p) => {
          if (alive) setPresence(p);
        })
        .catch(() => {
          /* server asleep / unreachable — keep the last value, try again next tick */
        });
    };
    tick();
    const iv = window.setInterval(tick, pollMs);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, [pollMs]);
  return presence;
}
