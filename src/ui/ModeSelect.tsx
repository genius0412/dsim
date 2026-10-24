import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GameSettings } from '../types';
import { QueueCounts } from './QueueCounts';
import { useLanEnabled } from './useLanEnabled';
import { discordInstanceId, inDiscordActivity, roomCodeForInstance } from '../net/discordActivity';
import { PAGE_COPY as IMPORT_COPY } from '../robotImport/ui/pageCopy';
import { SoloSetup } from './SoloSetup';
import { RobotStrip } from './Menu';
import { RobotPreview } from './RobotPreview';
import { ChainRobotPreview } from '../games/chain/RobotPreview';
import { FootprintSvg } from './FootprintSvg';
import { moduleFor } from '../games';
import { stageOrbit, useStageMode } from './MenuStage';
import { APP_NAME } from '../seasons';
import { markTutorialSeen, tutorialSeen } from '../tutorial/flag';

/**
 * THE PLAY PAGE — THE ROBOT SETUP (owner, 2026-10-18, after MoSim's robot select). It sits over the
 * menu stage, which flew the camera down to the player's robot on the way in: the robot is the
 * picture, the picker row is bottom-left, and Match setup and Practice setup are stacked in the right
 * column with Solo and Multiplayer pinned under them. Each of those two REPLACES the column with its
 * own list (Solo practice / Free drive / Solo record; the rooms, ranked, competitions and LAN), with a
 * way back. Every start action is still wrapped in App's `guardStart()` by the caller.
 *
 * The free area over the robot is the drag surface for the 3D orbit (`stageOrbit`): the stage is
 * behind the shell, so the page owns the pointer. On a 2D stage the page draws the robot itself.
 *
 * On a phone the robot is on top and the picker and the settings are two tabs under it, with the
 * two buttons pinned at the bottom.
 */
type Side = 'settings' | 'solo' | 'multi';

export function ModeSelect({
  settings,
  onChange,
  onEditRobot,
  onImport,
  multiplayer,
  signedIn,
  onLan,
  activeGame,
  onRejoin,
  onTutorial,
  onFreeDrive,
  onSoloMatch,
  onRecordRun,
  onDuoRecord,
  onRanked,
  onCustomRoom,
  onBrowse,
  onCompetitions,
  compete = true,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
  /** open the builder (Configure ▸ Robot) on the active robot */
  onEditRobot: () => void;
  /** open the robot importer: a new import, or `id` to edit a library robot */
  onImport: (id?: string) => void;
  multiplayer: boolean;
  signedIn: boolean;
  /** show ranked, records and competitions. Off inside a Discord Activity, which has no account
   * (auth is CSP-blocked in the embed) and is meant as a drop-in casual lobby. */
  compete?: boolean;
  onFreeDrive: () => void;
  onSoloMatch: () => void;
  onRecordRun: () => void;
  onDuoRecord: () => void;
  onRanked: () => void;
  onCustomRoom: () => void;
  /** the Public rooms list */
  onBrowse: () => void;
  /** the competitions list (0059). Absent: no entry (an older caller). */
  onCompetitions?: () => void;
  /** host or join a game on this network (docs/lan-selfhost.md) */
  onLan: () => void;
  /** a multiplayer game this browser is mid-way through (offer to rejoin it), or null */
  activeGame: { kind: 'ranked' | 'custom' | 'record' } | null;
  onRejoin: () => void;
  /**
   * START THE TUTORIAL — absent when the game has no tutorial. Offered only to a device that has
   * not been through it for THIS game (`tutorialSeen`, per game, fail-open); once played, an offer
   * to be taught is clutter, and Controls keeps an entry that runs it again.
   */
  onTutorial?: () => void;
}) {
  const lanOn = useLanEnabled();
  // READ PER GAME, and again when the game changes. Not re-read on every render: the flag is set by
  // the tutorial itself, and the card must not vanish mid-interaction.
  const [seen, setSeen] = useState(() => tutorialSeen(settings.game));
  useEffect(() => setSeen(tutorialSeen(settings.game)), [settings.game]);
  const stageMode = useStageMode();
  const [side, setSide] = useState<Side>('settings');
  /** the phone's two tabs under the robot; ignored from 721px up, where both are on screen */
  const [tab, setTab] = useState<'robot' | 'settings'>('robot');
  const importedActive = !!settings.spec.imported;
  /**
   * TWO OF THE ENTRIES BELOW ARE DEAD ENDS INSIDE A DISCORD ACTIVITY, and the embed asks the
   * question itself (`inDiscordActivity()`, host-based, cannot be lost). `activityCode` is the
   * party's MAIN lobby code and needs the instance id, which a storage-blocked reload can lack, so
   * the copy degrades to "you need a room code" rather than printing a code for nothing.
   */
  const inActivity = useMemo(() => inDiscordActivity(), []);
  const activityCode = useMemo(() => {
    const id = discordInstanceId();
    return id ? roomCodeForInstance(id) : '';
  }, []);

  const spec = settings.spec;
  const mod = moduleFor(settings.game);
  const GamePreview = mod.Preview;
  // THE 2D ROBOT FITS THE FREE AREA: a fixed 260 ran under the picker at 720 and was lost at 1080
  const viewRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(240);
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setFit(Math.max(96, Math.min(400, Math.floor(Math.min(width, height) - 32))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** the robot on a 2D stage: an import's footprint, else the game's own 2D schematic */
  const robot2d = spec.imported ? (
    <FootprintSvg imported={spec.imported} drivetrain={spec.drivetrain} size={fit} />
  ) : GamePreview ? (
    <GamePreview spec={spec} size={fit} alliance={settings.alliance} caption={false} />
  ) : settings.game === 'decode' ? (
    <RobotPreview spec={spec} size={fit} caption={false} />
  ) : (
    <ChainRobotPreview spec={spec} size={fit} caption={false} />
  );

  /** one entry of a Solo / Multiplayer list: a tile, as the Play page always drew them */
  const entry = (
    label: ReactNode,
    onClick: () => void,
    opts: { disabled?: boolean; note?: ReactNode; primary?: boolean } = {},
  ) => (
    <button className={`ds-tile${opts.primary ? ' primary' : ''}`} onClick={onClick} disabled={opts.disabled}>
      <span>
        <span className="t">{label}</span>
        {opts.note ? <span className="d">{opts.note}</span> : null}
      </span>
    </button>
  );
  const importNote = importedActive ? IMPORT_COPY.standardOnly : null;

  const list =
    side === 'solo' ? (
      <>
        {entry('Solo practice', onSoloMatch, { primary: true })}
        {entry('Free drive', onFreeDrive)}
        {compete && entry('Solo record', onRecordRun, { disabled: !multiplayer, note: importNote })}
      </>
    ) : side === 'multi' ? (
      <>
        {/* ORDER (owner, 2026-10-24): Ranked, Duo record, New room, Browse rooms, Competitions, LAN.
            The sign-in line is CONDITIONAL, never a reserved blank line: a reserved line made
            every tile in the old grid a line taller for everybody */}
        {compete &&
          entry(
            <>
              Ranked
              <QueueCounts className="tile" />
            </>,
            onRanked,
            { disabled: !multiplayer || !signedIn, note: multiplayer && !signedIn ? 'Sign in to play ranked' : importNote },
          )}
        {compete && entry('Duo record', onDuoRecord, { disabled: !multiplayer, note: importNote })}
        {entry('New room', onCustomRoom, { disabled: !multiplayer })}
        {/* ⚠️ THE LIST CAN NEVER HOLD THIS ACTIVITY'S OWN MATCH: every activity room is a custom
            room, reachable only by its code, so the code is printed where the player looks */}
        {entry('Browse rooms', onBrowse, {
          disabled: !multiplayer,
          note: inActivity
            ? activityCode
              ? `This activity’s lobbies aren’t listed. The main one is code ${activityCode}.`
              : 'This activity’s lobbies aren’t listed. You need a room code to watch one.'
            : null,
        })}
        {compete && onCompetitions && entry('Competitions', onCompetitions, { disabled: !multiplayer })}
        {/* LAN: never disabled on `multiplayer` (not needing our servers is the point); hidden where
            the flag is off and in a Discord activity */}
        {lanOn && !inActivity && entry('LAN', onLan)}
      </>
    ) : null;

  return (
    <div className={`ds-setup tab-${tab}`}>
      <h1 className="ds-sr">Play</h1>
      {/* THE ROBOT'S SPACE: the drag surface for the 3D orbit, or the 2D robot on a 2D stage */}
      <div
        ref={viewRef}
        className={activeGame || (onTutorial && !seen) ? 'ds-setup-view has-notice' : 'ds-setup-view'}
        onPointerDown={(e) => {
          if (stageMode === '3d') e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) stageOrbit.drag(e.movementX, e.movementY);
        }}
        onPointerUp={() => stageOrbit.release()}
        onPointerCancel={() => stageOrbit.release()}
      >
        {stageMode === '2d' && <div className="ds-setup-robot2d">{robot2d}</div>}
        {/* THE REJOIN BANNER AND THE TUTORIAL OFFER float over the robot (owner, 2026-10-18), on
            both desktop and phone. Off Home so the phone's Home fits its screen. Pointer events stop
            here, so a tap on a button is not an orbit drag. */}
        {(activeGame || (onTutorial && !seen)) && (
          <div className="ds-setup-notice" onPointerDown={(e) => e.stopPropagation()}>
            {activeGame && (
              <div className="ds-rejoin" role="alert">
                <b>You’re already in a game.</b>
                <button className="ds-btn primary small" onClick={onRejoin}>
                  Rejoin match →
                </button>
              </div>
            )}
            {onTutorial && !seen && (
              <div className="ds-tut-offer">
                <b>New to {APP_NAME}?</b>
                {/* NOT NOW sets the flag that finishing or exiting a run sets (design review 12-13) */}
                <span className="ds-tut-offer-acts">
                  <button
                    className="ds-btn ghost small"
                    onClick={() => {
                      markTutorialSeen(settings.game);
                      setSeen(true);
                    }}
                  >
                    Not now
                  </button>
                  <button className="ds-btn primary small" onClick={onTutorial}>
                    Start the tutorial
                  </button>
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* THE PHONE'S TABS. Toggle buttons, not a tablist (OptRow's ruling). Hidden from 721px up. */}
      <div className="ds-setup-tabs ds-segs" role="group" aria-label="Show">
        <button className={`ds-seg${tab === 'robot' ? ' on' : ''}`} aria-pressed={tab === 'robot'} onClick={() => setTab('robot')}>
          Robot
        </button>
        <button
          className={`ds-seg${tab === 'settings' ? ' on' : ''}`}
          aria-pressed={tab === 'settings'}
          onClick={() => setTab('settings')}
        >
          Settings
        </button>
      </div>

      <section className="ds-panel ds-setup-picker">
        <div className="ds-panel-h">
          <h2 className="ds-panel-title">Robot</h2>
          <button className="ds-btn small" onClick={() => onImport()}>
            Import
          </button>
        </div>
        <div className="ds-panel-body">
          <RobotStrip settings={settings} onChange={onChange} onEdit={onEditRobot} onImport={onImport} />
        </div>
      </section>

      <div className="ds-setup-side">
        {side === 'settings' ? (
          <div className="ds-setup-scroll">
            {!multiplayer && (
              <section className="ds-panel" role="status">
                <div className="ds-panel-body">
                  <p className="ds-hint">Online play is unavailable: this build has no game server.</p>
                </div>
              </section>
            )}
            <SoloSetup settings={settings} onChange={onChange} part="match" />
            <SoloSetup settings={settings} onChange={onChange} part="practice" />
          </div>
        ) : (
          <section className="ds-panel ds-setup-list">
            <div className="ds-panel-h">
              <button className="ds-btn ghost small" onClick={() => setSide('settings')}>
                ← Back
              </button>
              <h2 className="ds-panel-title">{side === 'solo' ? 'Solo' : 'Multiplayer'}</h2>
            </div>
            <div className="ds-panel-body ds-setup-entries">{list}</div>
          </section>
        )}
        {side === 'settings' && (
          <div className="ds-setup-go">
            <button className="ds-menu-btn primary" onClick={() => setSide('solo')}>
              <span className="ml">Solo</span>
            </button>
            <button className="ds-menu-btn" onClick={() => setSide('multi')}>
              <span className="ml">
                Multiplayer
                <QueueCounts className="menu" />
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
