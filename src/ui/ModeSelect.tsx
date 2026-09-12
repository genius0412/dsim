import { APP_NAME } from '../seasons';
import { QueueCounts } from './QueueCounts';

/**
 * Game-mode select — reached from PLAY. These are the tiles that used to live on
 * Home. Every start action is still wrapped in App's `guardStart()` (stale-build
 * refresh + scheduled-restart block) by the caller, so nothing here bypasses it.
 */
export function ModeSelect({
  multiplayer,
  signedIn,
  onLan,
  activeGame,
  onRejoin,
  onFreeDrive,
  onSoloMatch,
  onRecordRun,
  onDuoRecord,
  onRanked,
  onCustomRoom,
  onWatch,
  compete = true,
}: {
  multiplayer: boolean;
  signedIn: boolean;
  /** show the "Compete · online" tileset (ranked + records). Off inside a Discord
   * Activity, which has no account (auth is CSP-blocked in the embed) and is meant
   * as a drop-in casual lobby — so ranked/records would only show as dead tiles. */
  compete?: boolean;
  /** a multiplayer game this browser is mid-way through (offer to rejoin it), or null */
  activeGame: { kind: 'ranked' | 'custom' | 'record' } | null;
  onRejoin: () => void;
  onFreeDrive: () => void;
  onSoloMatch: () => void;
  onRecordRun: () => void;
  onDuoRecord: () => void;
  onRanked: () => void;
  onCustomRoom: () => void;
  onWatch: () => void;
  /** host or join a game on this network (docs/lan-selfhost.md) */
  onLan: () => void;
}) {
  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Play</p>
      <h1 className="ds-h1">Pick a mode</h1>

      {activeGame && (
        <div className="ds-rejoin" role="alert">
          <b>You’re already in a game.</b>
          <button className="ds-btn primary" onClick={onRejoin}>
            Rejoin match →
          </button>
        </div>
      )}

      {/* Offline, always available — the safe default (Solo Practice is primary) */}
      <section className="ds-tileset">
        <p className="ds-tileset-label">Practice · offline</p>
        <div className="ds-tiles">
          <button className="ds-tile primary" onClick={onSoloMatch}>
            <span className="k">Solo</span>
            <span>
              <span className="t">Solo Practice</span>
            </span>
          </button>

          <button className="ds-tile" onClick={onFreeDrive}>
            <span className="k">Practice</span>
            <span>
              <span className="t">Free Drive</span>
            </span>
          </button>
        </div>
      </section>

      {/* Online — ranked + score-attack records (need the game server / sign-in) */}
      {compete && (
      <section className="ds-tileset">
        <p className="ds-tileset-label">Compete · online</p>
        <div className="ds-tiles">
          <button className="ds-tile" onClick={onRanked} disabled={!multiplayer || !signedIn}>
            <span className="k">Ranked</span>
            <span>
              <span className="t">
                Find Match
                <QueueCounts className="tile" />
              </span>
              {/* ⚠️ CONDITIONAL, and it must stay that way. A previous pass rendered
                  this line ALWAYS, with a non-breaking space when there was nothing to
                  say, to stop the tile growing when `signedIn` resolves asynchronously.
                  That trade is backwards: `.ds-tiles` is a grid, so the reserved line
                  made Find Match, Solo Record AND Duo Record permanently a line taller
                  for everyone, to spare signed-in users one shrink at first paint —
                  and most visitors are signed out, where the line is there from the
                  start and never moves at all. If the shift is worth fixing, thread an
                  `authReady` flag down from AccountSync; do not reserve the line. */}
              {(!multiplayer || !signedIn) && (
                <span className="d">
                  {!multiplayer ? 'Needs the game server' : 'Sign in to play ranked'}
                </span>
              )}
            </span>
          </button>

          <button className="ds-tile" onClick={onRecordRun} disabled={!multiplayer}>
            <span className="k">Records</span>
            <span>
              <span className="t">Solo Record</span>
              {!multiplayer && <span className="d">Needs the game server</span>}
            </span>
          </button>

          <button className="ds-tile" onClick={onDuoRecord} disabled={!multiplayer}>
            <span className="k">Records</span>
            <span>
              <span className="t">Duo Record</span>
              {!multiplayer && <span className="d">Needs the game server</span>}
            </span>
          </button>
        </div>
      </section>
      )}

      {/* LAN — the only mode that needs NEITHER the internet nor an account to play.
          It sits above Custom because at a competition venue it is the one that works:
          the wifi is saturated, the cloud is far away, and the whole team is on one
          network. Never disabled on `multiplayer` — not needing our servers is the
          entire point. */}
      <section className="ds-tileset">
        <p className="ds-tileset-label">LAN · same network</p>
        <div className="ds-tiles">
          <button className="ds-tile" onClick={onLan}>
            <span className="k">LAN</span>
            <span>
              <span className="t">Host or Join</span>
              <span className="d">Unofficial — not rated</span>
            </span>
          </button>
        </div>
      </section>

      {/* Custom room — last, per its niche use */}
      <section className="ds-tileset">
        <p className="ds-tileset-label">Custom · online</p>
        <div className="ds-tiles">
          <button className="ds-tile" onClick={onCustomRoom} disabled={!multiplayer}>
            <span className="k">Custom</span>
            <span>
              <span className="t">Custom Room</span>
              {!multiplayer && <span className="d">Needs the game server</span>}
            </span>
          </button>
          <button className="ds-tile" onClick={onWatch} disabled={!multiplayer}>
            <span className="k">Live</span>
            <span>
              <span className="t">Watch Live</span>
              {!multiplayer && <span className="d">Needs the game server</span>}
            </span>
          </button>
        </div>
      </section>
    </>
  );
}
