import { useEffect, useRef, useState } from 'react';
import { fetchMyCompetitions } from '../net/myCompetitions';
import type { MyCompetition } from '../competition/wire';
import { countdown } from '../competition/clock';
import { startPollLoop } from './pollLoop';
import { onUserActive, userIdle } from './userActivity';
import { MatchAudio } from '../audio';
import { useParkedQueue } from './QueueBar';

/** how often to ask, by what the player is in: a called match is a countdown, a running
 *  competition can call one any moment, a competition still in registration cannot */
const CALLED_MS = 5_000;
const RUNNING_MS = 10_000;
const WAITING_MS = 120_000;

/**
 * "YOUR MATCH IS CALLED" — wherever the player is in the menus.
 *
 * A competition match waits minutes for its drivers, and a driver reading the leaderboard
 * between matches would otherwise only learn their match was called by going back to the
 * competition page. This is the queue bar's twin, in its place and its look (`.ds-queuebar`),
 * and it never shows while a ranked search is parked there (that one is the more urgent clock).
 *
 * IT ASKS ONLY WHILE THERE IS SOMETHING TO ASK ABOUT: nothing at all for a player in no
 * competition (one read on sign-in, then silence), every two minutes during registration, every
 * ten seconds while one of theirs is running, and never while the tab is hidden or the player is
 * away from the keyboard (`userIdle`). The game server and the database bill by the hour awake,
 * and this poll is per signed-in player.
 */
export function CompCallBar({
  signedIn,
  onJoin,
  muted,
}: {
  signedIn: boolean;
  onJoin: (slug: string, game: MyCompetition['game']) => void;
  muted: boolean;
}) {
  const [mine, setMine] = useState<MyCompetition[]>([]);
  const [skew, setSkew] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const parked = useParkedQueue();
  const chimed = useRef(new Set<number>());

  useEffect(() => {
    if (!signedIn) {
      setMine([]);
      return;
    }
    let alive = true;
    const loop = startPollLoop<number>({
      run: () => {
        if (userIdle() || document.visibilityState === 'hidden') return WAITING_MS;
        return fetchMyCompetitions().then((r) => {
          if (!alive) return 0;
          const list = r?.competitions ?? [];
          setMine(list);
          if (r) setSkew(r.now - Date.now());
          if (list.some((c) => c.called)) return CALLED_MS;
          if (list.some((c) => c.status === 'qualification' || c.status === 'selection' || c.status === 'playoffs')) return RUNNING_MS;
          if (list.length) return WAITING_MS;
          // in nothing: stop. Entering a competition reloads the page's own state, and the next
          // sign-in or page load asks again.
          loop.stop();
          return WAITING_MS;
        });
      },
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (t) => window.clearTimeout(t),
      fallbackMs: RUNNING_MS,
    });
    loop.wake();
    const unwake = onUserActive(() => loop.wake());
    const onVis = (): void => {
      if (document.visibilityState === 'visible') loop.wake();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      loop.stop();
      unwake();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [signedIn]);

  const called = mine.find((c) => c.called) ?? null;

  // one chime per call, and a clock only while one is showing
  useEffect(() => {
    if (!called?.called) return;
    if (!chimed.current.has(called.called.matchId)) {
      chimed.current.add(called.called.matchId);
      if (!muted) new MatchAudio().sfxMatchFound();
    }
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [called?.called?.matchId, muted]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!called?.called || parked) return null;
  const left = called.called.graceEndsAt - (now + skew);
  return (
    <div className="ds-queuebar found">
      <span className="qb-dot" aria-hidden />
      <span className="qb-txt">
        <span role="status">
          <b>
            {called.name} · {called.called.label}
          </b>{' '}
          is called
        </span>
        {left > 0 && ` · ${countdown(left)} to join`}
      </span>
      <button className="ds-btn primary small" onClick={() => onJoin(called.slug, called.game)}>
        Join
      </button>
    </div>
  );
}
