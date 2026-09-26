import { useMemo, useState } from 'react';
import { APP_NAME } from '../seasons';
import { QueueCounts } from './QueueCounts';
import { useLanEnabled } from './useLanEnabled';
import { discordInstanceId, inDiscordActivity, roomCodeForInstance } from '../net/discordActivity';
import { markTutorialSeen, tutorialSeen } from '../tutorial/flag';
import type { GameId } from '../games/types';

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
  onTutorial,
  game,
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
  /**
   * START THE TUTORIAL — absent when the active game has no tutorial, in which case this page
   * shows nothing about one.
   *
   * The CARD below is offered only to a device that has not been through it (`tutorialSeen`,
   * per-device and fail-open like `chainDisclaimer`). It is not a permanent tile: once you have
   * played, an offer to be taught is clutter on the page you go through to start every run, and
   * Controls keeps an entry that runs it again for anybody who wants it.
   */
  onTutorial?: () => void;
  /** the season the offer is for: the seen flag is kept PER GAME (design review 12-12).
   *  Absent ⇒ the legacy reading, "has this device been through any tutorial". */
  game?: GameId;
}) {
  const lanOn = useLanEnabled();
  /**
   * TWO OF THE TILES BELOW ARE DEAD ENDS INSIDE A DISCORD ACTIVITY, and the embed asks
   * the question itself rather than taking a prop.
   *
   * `compete` IS a prop because App already had the value; this one is
   * `inDiscordActivity()` — HOST-BASED, the one predicate for "am I in an activity",
   * which cannot be lost the way the instance id can (see the note on it in
   * `discordActivity.ts`, and App's own `inActivity`). Reading it here rather than
   * threading a second boolean keeps the two answers from ever disagreeing on one screen,
   * and it is a hostname test, so it costs nothing.
   *
   * ⚠️ `activityCode` is the party's MAIN lobby code, and it needs the instance id, which
   * `inActivity` does not — a storage-blocked reload has the second and not the first. So
   * it is computed separately and the copy below degrades to "you need a room code" rather
   * than printing `roomCodeForInstance('')`, which is a valid-looking code for nothing.
   */
  const inActivity = useMemo(() => inDiscordActivity(), []);
  const activityCode = useMemo(() => {
    const id = discordInstanceId();
    return id ? roomCodeForInstance(id) : '';
  }, []);
  /**
   * READ ONCE, at mount. A lazy initializer rather than a call in the render body: the flag is
   * set by the tutorial itself, so re-reading it on every render would make the card vanish
   * mid-interaction if this page happened to re-render while a run was finishing elsewhere.
   */
  const [seen, setSeen] = useState(() => tutorialSeen(game));
  return (
    <>
      <h1 className="ds-h1">Pick a mode</h1>
      {/* NO GAME SERVER is said ONCE, as the page's sub-line, not as a "Needs the game server"
          line on each of the five online tiles (design review 02-04). `multiplayer` is a
          build-time flag, so in practice only dev and audit builds ever show this. */}
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

      {/* THE FIRST-RUN TUTORIAL OFFER, above the modes and below the rejoin banner.
          Above them because it is the thing a new player should do first and the modes are what
          they would otherwise guess at; a single card rather than a tile in the Practice set,
          because it disappears for good once the device has been through it and a grid that
          changes shape is harder to learn than a banner that goes away. */}
      {onTutorial && !seen && (
        <div className="ds-tut-offer">
          {/* NO SUB-LINE. "Learn the controls on the real field." said what the button under it
              says, and NO STEP COUNT either: it was "Six steps", which is BIOBUZZ’s number —
              DECODE’s tutorial has four, and a build with no Box Tube is asked five. The count is
              resolved per game and per ROBOT (`TutorialStep.applies`), so the only honest place it
              can be printed is the card itself, which does print it. */}
          <b>New to {APP_NAME}?</b>
          {/* NOT NOW sets the flag that finishing or exiting a run sets (design review 12-13): an
              experienced driver on a new device should not have to start the tutorial to get
              rid of the offer for it. */}
          <span className="ds-tut-offer-acts">
            <button
              className="ds-btn ghost"
              onClick={() => {
                markTutorialSeen(game);
                setSeen(true);
              }}
            >
              Not now
            </button>
            <button className="ds-btn primary" onClick={onTutorial}>
              Start the tutorial
            </button>
          </span>
        </div>
      )}

      {/* Offline, always available — the safe default (Solo Practice is primary).
          A TILE IS ITS TITLE: the mono kicker over each one (SOLO, RECORDS, LIVE …) repeated the
          title or the set's own label, so it is gone. */}
      <section className="ds-tileset">
        <p className="ds-tileset-label">Practice · offline</p>
        <div className="ds-tiles">
          <button className="ds-tile primary" onClick={onSoloMatch}>
            <span>
              <span className="t">Solo practice</span>
            </span>
          </button>

          <button className="ds-tile" onClick={onFreeDrive}>
            <span>
              <span className="t">Free drive</span>
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
            <span>
              <span className="t">
                Find match
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
              {multiplayer && !signedIn && (
                <span className="d">
                  Sign in to play ranked
                </span>
              )}
            </span>
          </button>

          <button className="ds-tile" onClick={onRecordRun} disabled={!multiplayer}>
            <span>
              <span className="t">Solo record run</span>
            </span>
          </button>

          <button className="ds-tile" onClick={onDuoRecord} disabled={!multiplayer}>
            <span>
              <span className="t">Duo record run</span>
            </span>
          </button>
        </div>
      </section>
      )}

      {/* Custom room */}
      <section className="ds-tileset">
        <p className="ds-tileset-label">Custom · online</p>
        <div className="ds-tiles">
          <button className="ds-tile" onClick={onCustomRoom} disabled={!multiplayer}>
            <span>
              <span className="t">Custom room</span>
            </span>
          </button>
          <button className="ds-tile" onClick={onWatch} disabled={!multiplayer}>
            <span>
              <span className="t">Watch live</span>
              {/* ⚠️ THE LIST BEHIND THIS TILE CAN NEVER HOLD THIS ACTIVITY'S OWN MATCH.
                  `isPublicLive` admits ranked matches and record runs only — a custom room is
                  private to the code its host handed out — and every activity room is a custom
                  room. So in the embed the tile opens on a page about strangers, while the match
                  four people in this voice channel are playing is reachable the whole time, by
                  the code box under that list.

                  The code is the missing half: a participant who was not in the lobby has no way
                  to learn it, even though it is DERIVED from the instance they are already in.
                  Printing it here is the cheapest place to close that — the tile that needs it is
                  the one that says it. Not a restatement of the label: it names the limit and the
                  one thing to type. */}
              {inActivity && (
                <span className="d">
                  {activityCode
                    ? `This activity’s lobbies aren’t listed. The main one is code ${activityCode}.`
                    : 'This activity’s lobbies aren’t listed. You need a room code to watch one.'}
                </span>
              )}
            </span>
          </button>
        </div>
      </section>

      {/* LAN — LAST on the page (owner, 2026-09-13). Never disabled on `multiplayer`: not
          needing our servers is the point of it.

          Hidden entirely where `LAN_ENABLED` is off, rather than shown disabled: a greyed tile
          advertises a mode this build will not play, and the reason it is off is that the
          feature is being held back, not that the player is missing a prerequisite.

          ⚠️ HIDDEN IN A DISCORD ACTIVITY FOR THE SAME REASON, and it is not a theoretical
          case: `LAN_SIGNALLING` is ON in production, so this section really does render in
          the embed. Behind it, hosting a tab needs an account (`mayTabHost`) and the embed is
          always signed out because Discord's CSP blocks auth, and joining needs the other
          machine to be on this network — which a cross-origin iframe in a voice channel with
          people in four countries is not. The screen's only remedy is a sign-in that cannot
          happen, so the tile is a dead end and is not offered, exactly like the Compete set. */}
      {lanOn && !inActivity && (
        <section className="ds-tileset">
          <p className="ds-tileset-label">LAN · same network</p>
          <div className="ds-tiles">
            <button className="ds-tile" onClick={onLan}>
              <span>
                <span className="t">Host or join</span>
              </span>
            </button>
          </div>
        </section>
      )}
    </>
  );
}
