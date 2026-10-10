import { useMemo, useState } from 'react';
import { discordInstanceId, inDiscordActivity, roomCodeForInstance } from '../net/discordActivity';
import { isValidRoomCode, normalizeRoomCode, ROOM_CODE_LENGTH } from '../net/roomCode';
import { MenuTile } from './MenuTile';
import { QueueCounts } from './QueueCounts';
import { useLanEnabled } from './useLanEnabled';

/**
 * The online half of what PLAY used to be. Every start action is still wrapped in App's
 * `guardStart()` by the caller (stale-build refresh, restart block, already-in-a-game), so
 * nothing here bypasses it.
 */
export function MultiplayerMenu({
  multiplayer,
  signedIn,
  compete = true,
  activeGame,
  onRejoin,
  onRanked,
  onCustomRoom,
  onJoinCode,
  onWatch,
  onCompetitions,
  onLan,
}: {
  multiplayer: boolean;
  signedIn: boolean;
  /** show Find match and Competitions. Off inside a Discord Activity, which has no account (auth
   * is CSP-blocked in the embed), so ranked would only show as a dead tile. */
  compete?: boolean;
  /** a multiplayer game this browser is mid-way through (offer to rejoin it), or null */
  activeGame: { kind: 'ranked' | 'custom' | 'record' } | null;
  onRejoin: () => void;
  onRanked: () => void;
  onCustomRoom: () => void;
  /** a valid room code typed into the box at the top */
  onJoinCode: (code: string) => void;
  onWatch: () => void;
  /** the competitions list (0059). Absent: no tile (an older caller). */
  onCompetitions?: () => void;
  /** host or join a game on this network (docs/lan-selfhost.md) */
  onLan: () => void;
}) {
  const lanOn = useLanEnabled();
  /**
   * ⚠️ TWO OF THESE TILES ARE DEAD ENDS INSIDE A DISCORD ACTIVITY, and the embed asks the question
   * itself rather than taking a prop: `inDiscordActivity()` is HOST-BASED, the one predicate for
   * "am I in an activity", which cannot be lost the way the instance id can (see the note on it in
   * `discordActivity.ts`). `activityCode` needs the instance id, which a storage-blocked reload can
   * lose, so it is computed separately and the copy degrades to "you need a room code" rather than
   * printing `roomCodeForInstance('')`, a valid-looking code for nothing.
   */
  const inActivity = useMemo(() => inDiscordActivity(), []);
  const activityCode = useMemo(() => {
    const id = discordInstanceId();
    return id ? roomCodeForInstance(id) : '';
  }, []);
  const [code, setCode] = useState('');
  const [bad, setBad] = useState(false);

  function submitCode(): void {
    // a pasted link carries the code as its last path segment
    const tail = code.trim().split(/[/?#]/).filter(Boolean).pop() ?? '';
    const c = normalizeRoomCode(tail);
    if (!isValidRoomCode(c)) {
      setBad(true);
      return;
    }
    setBad(false);
    onJoinCode(c);
  }

  return (
    <div className="ds-menupage">
      {!multiplayer && (
        <p className="ds-sub" role="status">
          Online play is unavailable: this build has no game server.
        </p>
      )}
      {activeGame && (
        <div className="ds-rejoin" role="alert">
          <b>You’re already in a game.</b>
          <button className="ds-btn primary" onClick={onRejoin}>
            Rejoin match →
          </button>
        </div>
      )}
      <div className="ds-codebar">
        <input
          className="ds-input"
          value={code}
          disabled={!multiplayer}
          onChange={(e) => {
            setCode(e.target.value);
            setBad(false);
          }}
          onKeyDown={(e) => e.key === 'Enter' && submitCode()}
          placeholder="Room code or link, then Enter"
          aria-label="Join a room by code"
          aria-invalid={bad}
        />
        {bad && <p className="ds-form-err">Enter a valid {ROOM_CODE_LENGTH}-character room code.</p>}
      </div>
      <nav className="ds-tilestack" aria-label="Multiplayer">
        {compete && (
          <MenuTile
            title="Find match"
            mono="1v1"
            hue="coral"
            disabled={!multiplayer || !signedIn}
            hint={multiplayer && !signedIn ? 'Sign in to play ranked' : 'Ranked 1v1 and 2v2'}
            stat={<QueueCounts className="tile" />}
            onClick={onRanked}
          />
        )}
        {compete && onCompetitions && (
          <MenuTile
            title="Competitions"
            mono="CMP"
            hue="violet"
            disabled={!multiplayer}
            hint="Organised events"
            onClick={onCompetitions}
          />
        )}
        <MenuTile
          title="Room"
          mono="RM"
          hue="blue"
          disabled={!multiplayer}
          hint="Host one for friends, or join with a code"
          onClick={onCustomRoom}
        />
        {/* ⚠️ THE LIST BEHIND THIS TILE CAN NEVER HOLD THIS ACTIVITY'S OWN MATCH. `isPublicLive`
            admits ranked matches and record runs only — a custom room is private to the code its
            host handed out — and every activity room is a custom room. So in the embed the tile
            opens on a page about strangers, while the match four people in this voice channel are
            playing is reachable by the code box above. A participant who was not in the lobby can
            learn that code from the instance they are already in, so the hint prints it. */}
        <MenuTile
          title="Watch live"
          mono="LIVE"
          hue="mint"
          disabled={!multiplayer}
          hint={
            inActivity
              ? activityCode
                ? `This activity’s lobbies aren’t listed. The main one is code ${activityCode}.`
                : 'This activity’s lobbies aren’t listed. You need a room code to watch one.'
              : 'Spectate public matches'
          }
          onClick={onWatch}
        />
        {/* LAN is hidden where `LAN_ENABLED` is off, and in a Discord activity: hosting a tab needs
            an account and joining needs the other machine on this network, neither of which a
            cross-origin iframe in a voice channel has. Never disabled on `multiplayer`: not
            needing our servers is the point of it. */}
        {lanOn && !inActivity && (
          <MenuTile title="LAN" mono="LAN" hue="amber" hint="Host or join on this network" onClick={onLan} />
        )}
      </nav>
    </div>
  );
}
