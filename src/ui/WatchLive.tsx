import { useEffect, useState } from 'react';
import type { LiveRoom } from '../net/protocol';
import { fetchLiveRoom, fetchLiveRooms } from '../net/api';
import { gameServerConfigured } from '../net/env';
import { normalizeRoomCode, isValidRoomCode, ROOM_CODE_LENGTH } from '../net/roomCode';
import { seasonFor } from '../seasons';
import { fmtTime } from './timerPanel';
import { onUserActive, userIdle } from './userActivity';

/**
 * "Watch Live" — the games currently in progress on the game server.
 *
 * The LIST is everything live EXCEPT custom rooms (the server decides that; see
 * `isPublicLive`) — ranked matches and record runs both appear. A custom room is
 * somebody's private game reached by a code they chose to hand out, so publishing
 * it here would hand that code to every visitor. They are still fully spectatable
 * — by CODE, in the box below, which is the same key that lets you join one.
 * Friends' custom games are reachable from the friends list without typing anything.
 *
 * Polls `GET /api/live` every few seconds; clicking a card spectates that room
 * (read-only, via `onWatch`). The card's region is passed along because a match may
 * be hosted anywhere in the fleet.
 */
export function WatchLive({
  onWatch,
  onBack,
}: {
  onWatch: (roomCode: string, region?: string) => void;
  /** return to the mode-select screen */
  onBack: () => void;
}) {
  const [rooms, setRooms] = useState<LiveRoom[] | null>(null);
  const [error, setError] = useState(false);
  const configured = gameServerConfigured();

  useEffect(() => {
    if (!configured) return;
    let alive = true;
    const load = (): void => {
      // AN UNATTENDED PAGE DOES NOT POLL — hidden, or nobody at the keyboard (userActivity.ts),
      // the rule `usePresence`, `useFriends` and `NoticePoller` already follow. A 4-second poll
      // left open in a background tab otherwise kept the auto-stopping Fly machine awake for as
      // long as the tab lived. The wake below catches it up the moment somebody is back.
      if (userIdle()) return;
      fetchLiveRooms()
        .then((r) => {
          if (!alive) return;
          setRooms(r.rooms);
          setError(false);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          // the raw reason goes to the console, not the page: a player can do nothing with
          // "Server returned 502", and the poll below is already the retry
          console.warn('[watch-live] /api/live failed', e);
          setError(true);
        });
    };
    load();
    const t = window.setInterval(load, 4000); // live matches change fast — refresh often
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    const unwake = onUserActive(load);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      unwake();
    };
  }, [configured]);

  return (
    <>
      <button className="ds-back" onClick={onBack}>
        ← Back
      </button>
      <h1 className="ds-h1">Watch live</h1>

      {/* ONE panel, four bodies. The populated grid used to render with NO panel at
          all, so the page swapped a ~90px bordered card for a bare full-width grid of
          shadowed tiles the instant `/api/live` answered — and on a 4-second poll a
          room list emptying popped the card straight back in. The container is not
          allowed to appear and disappear; only its contents change. */}
      <div className="ds-panel">
        <div className="ds-panel-h">
          <h2 className="ds-panel-title">Live now</h2>
        </div>
        {!configured ? (
          <div className="ds-empty">
            <div className="big">Spectating is unavailable</div>
            This build has no game server, and live matches run on it.
          </div>
        ) : error ? (
          <div className="ds-empty">
            <div className="big">Couldn’t reach the game server</div>
            Trying again every few seconds.
          </div>
        ) : rooms === null ? (
          <div className="ds-loading">Loading live matches…</div>
        ) : rooms.length === 0 ? (
          <div className="ds-empty">
            <div className="big">Nothing live right now</div>
            Ranked matches and record runs show up here while they are being played.
          </div>
        ) : (
          // `.ds-panel-body` supplies the padding `.ds-empty`/`.ds-loading` carry
          // themselves, so all four bodies sit the same distance inside the card
          <div className="ds-panel-body ds-opts">
            {rooms.map((r) => (
              <button key={r.room} className="ds-opt" onClick={() => onWatch(r.room, r.region)}>
                <span className="ot">{title(r)}</span>
                {/* the SCORE is its own mono line and the clock is m:ss like every other
                    clock (design review 09-19) — the two live numbers were buried mid-prose,
                    and a zero clock left a double space in the template */}
                <span className="om">{score(r)}</span>
                <span className="od">
                  {[
                    seasonFor(r.game).name,
                    `${r.kind === 'record' ? 'Record' : 'Ranked'} ${r.mode}`,
                    r.timeLeft > 0 ? `${phaseLabel(r.phase)} ${fmtTime(r.timeLeft)}` : phaseLabel(r.phase),
                    r.spectators > 0 ? `${r.spectators} watching` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {configured && <WatchByCode onWatch={onWatch} />}
    </>
  );
}

/**
 * Spectate a CUSTOM room by its code.
 *
 * Resolves the code before opening a socket, for two reasons. It tells the player
 * WHY nothing happened when the match has already finished (the alternative is a
 * connection that opens and then silently reports an unknown room), and it returns
 * the hosting region — which a bare custom code cannot encode and the spectate
 * socket cannot do without.
 */
function WatchByCode({ onWatch }: { onWatch: (roomCode: string, region?: string) => void }) {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'looking' | 'missing'>('idle');
  const ready = isValidRoomCode(code);

  const go = (): void => {
    if (!ready || status === 'looking') return;
    setStatus('looking');
    void fetchLiveRoom(code).then((room) => {
      if (!room) {
        setStatus('missing');
        return;
      }
      setStatus('idle');
      onWatch(room.room, room.region);
    });
  };

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Watch a custom room</h2>
      </div>
      <div className="ds-panel-body stack">
        {/* "Enter the room code to watch one" was the heading, the input's placeholder
            and its aria-label said a third time. The sentence that stays answers a real
            question — why isn't my friend's room in the list above? */}
        <p className="ds-hint">Custom rooms aren’t listed publicly.</p>
        <div className="ds-watchcode">
          <input
            className="ds-input"
            value={code}
            onChange={(e) => {
              setCode(normalizeRoomCode(e.target.value));
              setStatus('idle');
            }}
            onKeyDown={(e) => e.key === 'Enter' && go()}
            placeholder={'X'.repeat(ROOM_CODE_LENGTH)}
            maxLength={ROOM_CODE_LENGTH}
            spellCheck={false}
            autoCapitalize="characters"
            aria-label="Room code"
          />
          {/* ONE label: a busy "Looking…" was wider than "Watch" and resized the code field
              beside it. The lookup shows as disabled + aria-busy instead. */}
          <button
            className="ds-btn"
            disabled={!ready || status === 'looking'}
            aria-busy={status === 'looking'}
            onClick={go}
          >
            Watch
          </button>
        </div>
        {status === 'missing' && (
          <p className="ds-hint">
            No live match under that code. It may have finished, or not started yet.
          </p>
        )}
      </div>
    </div>
  );
}

/** the card's headline: "red vs blue" for a match, just the runners for a record
 *  run — a solo attempt has no opponent, and "… vs BLUE" would invent one. */
function title(r: LiveRoom): React.ReactNode {
  if (r.kind === 'record') return r.players.map(driverLabel).join(' + ') || 'Record run';
  return (
    <>
      {teamLabel(r, 'red')} <span className="ds-muted">vs</span> {teamLabel(r, 'blue')}
    </>
  );
}

/** a record run scores one number; a match has two sides */
function score(r: LiveRoom): string {
  if (r.kind !== 'record') return `${r.score.red}–${r.score.blue}`;
  // the runner's robot sits on ONE alliance, so the other side is a constant 0
  return `${Math.max(r.score.red, r.score.blue)} pts`;
}

function driverLabel(p: LiveRoom['players'][number]): string {
  return p.teamNumber ? `${p.name} #${p.teamNumber}` : p.name;
}

/** the drivers on one alliance, "Name (Team)", joined — or the alliance colour if empty */
function teamLabel(r: LiveRoom, alliance: 'red' | 'blue'): string {
  const names = r.players.filter((p) => p.alliance === alliance).map(driverLabel);
  return names.length ? names.join(' + ') : alliance.toUpperCase();
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'auto': return 'Autonomous';
    case 'transition': return 'Transition';
    case 'teleop': return 'Driver-Controlled';
    case 'post': return 'Final';
    case 'pre': return 'Pre-match';
    case 'freeplay': return 'Free drive';
    default: return phase;
  }
}
