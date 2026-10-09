import { useEffect, useState } from 'react';
import { fetchPresence, type Presence } from '../net/api';
import { gameServerConfigured } from '../net/env';
import { onUserActive, userIdle } from './userActivity';

/**
 * Poll the game server's live presence (online / signed-in / per-queue depth).
 * Returns null until the first successful fetch, and stays null when the game
 * server isn't configured or a fetch fails (callers just render nothing).
 *
 * ONE POLLER FOR THE WHOLE PAGE, however many components ask. The shell's online
 * chip and the App's maintenance check each ran their own interval, so every menu
 * tab fetched `/api/presence` twice every 8 seconds (seen in the browser on
 * 2026-10-02). Subscribers now share a single loop: it runs at the FASTEST cadence
 * any of them asked for, asks for the fresh `full` aggregate while any of them
 * wants it (a fresher answer serves the ambient chip just as well), and stops when
 * the last one unmounts.
 *
 * Polls only while something is mounted, so navigating away stops the requests -
 * deliberate, because each poll costs the server and the database. The default 8s
 * cadence keeps queue counts fresh enough to decide on without hammering it.
 *
 * AN UNATTENDED PAGE DOES NOT POLL - hidden, or visible with nobody at the
 * keyboard for five minutes (see userActivity.ts). Nobody reads a chip they
 * cannot see, and a tab left open for hours otherwise keeps both the Fly machine
 * and the Neon compute awake for all of it - the database bills by the hour it is
 * awake, so this is the difference between "someone forgot a tab" and a month of
 * compute. Coming back catches up on the idle→active edge, so the only visible
 * effect is that the first frame after returning can be one beat stale.
 * (`useFriends` and `NoticePoller` do the same thing for the same reason.)
 *
 * `full` asks for a fresher aggregate than the server's default cache - see
 * `fetchPresence`. Pass it where the number decides something (ranked queue depth);
 * leave it off for the ambient online chip, which is the one that sits on screen
 * for hours and is happy with a value up to a minute old.
 */
export function usePresence(pollMs = 8000, full = false): Presence | null {
  const [presence, setPresence] = useState<Presence | null>(latest);
  useEffect(() => {
    if (!gameServerConfigured()) return;
    const sub: Sub = { pollMs, full, set: setPresence };
    subs.add(sub);
    restart(true, full);
    return () => {
      subs.delete(sub);
      restart(false, false);
    };
  }, [pollMs, full]);
  return presence;
}

interface Sub {
  pollMs: number;
  full: boolean;
  set: (p: Presence) => void;
}

const subs = new Set<Sub>();
let latest: Presence | null = null;
let timer: number | null = null;
let timerMs = 0;
let unwake: (() => void) | null = null;
let lastAt = 0;
let inFlight = false;

function tick(): void {
  if (userIdle() || inFlight || subs.size === 0) return;
  const full = [...subs].some((s) => s.full);
  inFlight = true;
  lastAt = Date.now();
  fetchPresence(full)
    .then((p) => {
      latest = p;
      for (const s of subs) s.set(p);
    })
    .catch(() => {
      /* server asleep / unreachable - keep the last value, try again next tick */
    })
    .finally(() => {
      inFlight = false;
    });
}

/** re-fit the one interval to the current subscribers; `joined` fetches now unless a read
 *  just went out, so a newly mounted component is not left on null for a whole period */
function restart(joined: boolean, wantsFull: boolean): void {
  if (subs.size === 0) {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    timerMs = 0;
    document.removeEventListener('visibilitychange', tick);
    unwake?.();
    unwake = null;
    return;
  }
  const want = Math.min(...[...subs].map((s) => s.pollMs));
  if (timer === null || want !== timerMs) {
    if (timer !== null) window.clearInterval(timer);
    timer = window.setInterval(tick, want);
    timerMs = want;
  }
  if (!unwake) {
    document.addEventListener('visibilitychange', tick);
    unwake = onUserActive(tick);
  }
  if (joined && (wantsFull || Date.now() - lastAt > 1000)) tick();
}
