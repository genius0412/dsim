import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useDialog } from './useDialog';
import {
  GameController,
  type GameSettings,
  type HudSnapshot,
  type IntroPlayer,
  type PerfSnapshot,
  type GameControllerZenithAuto,
} from '../game';
import { PerfHud } from './PerfHud';
import { PERF_DISPLAY_LEVELS } from '../settings';
import type { PerfDisplay } from '../types';
import { effectiveBindings, keyLabel, padBindLabel, padBinds } from '../input/bindings';
import { POWER_DRAW_MAX } from '../config';
import { MobileControls } from './MobileControls';
import { timerPanel } from './timerPanel';
import { FoulChip } from './FoulChip';
import { AdSlot, useAdUnitActive } from './AdSlot';
import { SponsorGameChip } from './Sponsor';
import { Results } from './Results';

import { DEFAULT_MOBILE_LAYOUT } from '../settings';
import type { NetSession } from '../net/session';
import { clearActiveGame } from '../net/activeGame';
import { TutorialCard } from './TutorialCard';
import type { Replay, ReplayResult } from '../sim/replay';
import { moduleFor } from '../games';
import { activeZenithAuto } from '../auto/library';
import { seasonFor } from '../seasons';
import { useCoarsePointer } from './useCoarsePointer';
import type { Alliance, DrivetrainType } from '../types';
import { initPhysics3d, physics3dReady } from '../games/biobuzz/sim3d/engine';
import { getCameraPref, getViewPref, subscribeCameraPref, subscribeViewPref, type CameraPref } from '../games/biobuzz/graphics/store';
import { requestFreeCamReset } from '../games/biobuzz/graphics/freeCam';
import { resumePadNav, suspendPadNav } from '../input/padNav';
import { setPadMenuHandler } from './PadNavLayer';

/**
 * ── WHERE THE CONNECTION CHIP AND THE PING GRAPH WENT ──────────────────────────────────────
 *
 * Into `PerfHud`, with the frame rate (owner, 2026-09-19: "the ping display should be combined
 * with the performance display … with the fps and other things").
 *
 * The chip (`NetQuality`) printed ping · Hz · jitter and doubled as a toggle for a ping GRAPH
 * (`PingGraph`). The toggle never worked, in any game, in any view: `.hud` is
 * `pointer-events: none` so the canvas keeps a drag, and every OTHER clickable thing inside it
 * re-enables them on itself (`.game-btn`, `.sponsor-chip`, `.mobile-btn` all say so in
 * styles.css) — the chip did not, so its `onClick` never received a click and the graph could
 * not be opened. Rather than re-enable them, the graph moved to the `graphs` level of the
 * display setting, which is what the owner asked for and costs the HUD no click target at all.
 */

/** top-right drive power-draw gauge: how much current the flywheel spin-up + intake
 * are pulling off the drive motors right now (0 → POWER_DRAW_MAX). Bar on top (fills
 * upward toward the cap, green→amber→red), the actual % the drive is slowed at that
 * instant underneath — vertical to sit beside DECODE's storage+gate column. */
function PowerGauge({ draw }: { draw: number }) {
  const frac = Math.max(0, Math.min(1, draw)); // literal 0-100%, matches pct below
  const pct = Math.round(draw * 100); // actual drive slowdown right now
  const cls = draw > POWER_DRAW_MAX * 0.75 ? 'hot' : draw > POWER_DRAW_MAX * 0.4 ? 'warm' : '';
  return (
    <span
      className="power-gauge"
      role="img"
      aria-label={`Drive power draw: ${pct}% slower right now.`}
    >
      <span className="v-gauge">
        {/* the LEVEL, not a height: the fill is full-size and clipped to it, so the bar
            animates without laying anything out — see .v-gauge-fill */}
        <span className={`v-gauge-fill ${cls}`} style={{ ['--vg' as string]: String(frac) }} />
      </span>
      <span className="pg-num">{pct}%</span>
    </span>
  );
}

const DT_LABEL: Record<DrivetrainType, string> = {
  mecanum: 'Mecanum',
  tank: 'Tank',
  swerve: 'Swerve',
  xdrive: 'X-drive',
  butterfly: 'Butterfly',
};

/**
 * THE MOTIF, which the whole DECODE match is scored against — never by hue alone (design
 * review 17-06). A reader gets the sequence as words; a colour-blind driver gets a SHAPE,
 * purple round and green square (`.motif-dot.green` in styles.css).
 */
function MotifDots({ motif, className }: { motif: readonly string[]; className?: string }) {
  return (
    <span className={className} role="img" aria-label={`Motif: ${motif.join(', ')}`}>
      {motif.map((c, i) => (
        <span key={i} className={`motif-dot ${c}`} />
      ))}
    </span>
  );
}

/**
 * ONE IN-MATCH OVERLAY as a dialog (design review C07): the card is the dialog, labelled by
 * its title, and `useDialog` moves focus in and traps Tab. NO `onClose` for any of them —
 * Escape already reaches `onExit` through the screen's own window listener (the same thing
 * MENU / BACK TO MENU do), and a second handler here would exit twice.
 */
function MatchOverlay({
  titleId,
  scrim = 'overlay',
  card = 'overlay-panel',
  children,
}: {
  titleId: string;
  scrim?: string;
  card?: string;
  children: ReactNode;
}) {
  const ref = useDialog();
  return (
    <div className={scrim}>
      <div ref={ref} className={card} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}

/**
 * THE 3D LOADING SCREEN — the physics chunk and the 3D view, each with its own line.
 *
 * Opaque, over the HUD, on the fixed dark stage (`--ds-stage-bg`, the results screen's ground),
 * because what it replaces is a frame of the 2D field and a HUD with nothing under it. Not a
 * dialog: there is nothing to answer, and Esc still leaves the match. `role="status"` so a step
 * finishing is announced.
 */
function LoadingScreen({
  game,
  physics,
  view,
  hold,
}: {
  game: string;
  physics: boolean;
  view: boolean;
  /** the room is holding the match for other drivers (`NetStatus.hold`) */
  hold?: { secs: number; waiting: number } | null;
}) {
  // a step is listed once it has been waited on, and stays listed (as Ready) after. A 2D-physics
  // practice on the 3D view never waits on physics, and a room on the 2D view never waits on a
  // view, so neither gets a line claiming something it did not do.
  const seen = useRef({ physics, view });
  seen.current.physics ||= physics;
  seen.current.view ||= view;
  const steps: { k: string; busy: boolean }[] = [];
  if (seen.current.physics) steps.push({ k: '3D physics', busy: physics });
  if (seen.current.view) steps.push({ k: '3D view', busy: view });
  const waiting = hold && hold.waiting > 0 ? hold : null;
  return (
    <div className="game-loading" role="status">
      <div className="game-loading-card">
        <div className="game-loading-game">{game}</div>
        <div className="game-loading-title">Getting the field ready</div>
        <div className="game-loading-bar" aria-hidden="true">
          <span />
        </div>
        <ul className="game-loading-steps">
          {steps.map((st) => (
            <li key={st.k} className={st.busy ? 'busy' : 'done'}>
              <span>{st.k}</span>
              <span>{st.busy ? 'Loading…' : 'Ready'}</span>
            </li>
          ))}
          {waiting && (
            <li className="busy">
              <span>{waiting.waiting === 1 ? 'Another driver' : `${waiting.waiting} drivers`}</span>
              <span>{`Loading… starts in ${waiting.secs}s`}</span>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

/** count an integer from `from` to `target` over `duration` ms once `active` flips
 * true (ease-out cubic). Used for the results score reveal (from 0) and the ELO
 * change (from the old rating, so the delta ticks in). */
function useCountUp(target: number, active: boolean, duration = 900, from = 0): number {
  const [val, setVal] = useState(from);
  useEffect(() => {
    if (!active) {
      setVal(from);
      return;
    }
    let raf = 0;
    let t0 = 0;
    const tick = (t: number): void => {
      if (!t0) t0 = t;
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, active, duration, from]);
  return active ? val : from;
}

interface Props {
  settings: GameSettings;
  onExit: () => void;
  /** null in solo; a live lockstep session in multiplayer */
  session?: NetSession | null;
  /** watch the just-played run's replay (a server match, or a solo practice run) */
  onWatchReplay?: (replay: Replay) => void;
  /** open the account screen. The results screen offers it to a signed-out RECORD run, whose
   *  score cannot reach the leaderboard until there is an account to hang it on. */
  onSignIn?: () => void;
  /** a SOLO PRACTICE run just finished — the app keeps it (locally, and on the account) */
  onPracticeRun?: (replay: Replay, result: ReplayResult) => void;
  /** whether the player is signed in — drives the record results "sign in to
   * save & rank" prompt vs the live PB / WR / rank line */
  signedIn?: boolean;
  /** persist a settings change from in-game (currently: the mobile control layout) */
  onSettingsChange?: (s: GameSettings) => void;
  /** start in mobile-control-layout EDIT mode (launched from the Controls menu) */
  editLayout?: boolean;
  /** solo RECORD runs only: abandon this run and start a fresh one. Tears the
   * session down and re-enters the record flow rather than rebuilding the world
   * in place — an in-place reset desyncs against a server that is still running
   * the old match (that is what made the drivetrain stick/jitter before). */
  onRestartRun?: () => void;
  /** RANKED only: leave this room and go straight back into the queue. The
   *  counterpart to the rematch vote — that plays the same people again, this
   *  finds new ones. */
  onQueueAgain?: () => void;
  /**
   * CUSTOM ROOMS: take the whole room back to its own lobby (host only).
   *
   * The third thing you can do with a finished match, beside REMATCH and MENU, and the one
   * the other two cannot cover. A rematch replays the roster frozen at the first start — it
   * cannot drop the player who left, take a new one, or see a side anyone re-picked — and
   * MENU abandons the room entirely, which is what made "make a new code and everyone
   * re-join" the only way to play a second, differently-arranged game together.
   *
   * Absent unless the App has a room this can apply to; the button also waits on the
   * session's own `isHost`, which tracks the crown as it migrates.
   */
  onBackToLobby?: () => void;
  /**
   * RUN THE TUTORIAL (roadmap item 6) — a scripted solo practice, offered from the Modes page
   * and from Controls.
   *
   * A PROP rather than a `GameSettings` field, and `GameController` says why: settings persist
   * and sync to the account, so "I am in the tutorial right now" does not belong in them. It also
   * means the tutorial does not survive a reload, which is the honest behaviour — the staged world
   * it was on cannot be rebuilt from a URL.
   *
   * This screen forces FREE DRIVE with no dummies and no bots for the run; see
   * `src/games/biobuzz/tutorial.ts` for why free drive is the right mode. A game with no
   * `GameModule.tutorial` ignores the flag entirely and plays an ordinary practice.
   */
  tutorial?: boolean;
}

export function GameView({
  settings,
  onExit,
  session = null,
  onWatchReplay,
  onSignIn,
  onPracticeRun,
  signedIn = false,
  onSettingsChange,
  editLayout = false,
  onRestartRun,
  onQueueAgain,
  onBackToLobby,
  tutorial = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // BIOBUZZ 3D SEAM: the box a 3D scene mounts its own canvas into, UNDER the 2D one
  // (`docs/biobuzz/plan-3d.md` §4.1/§4.7) — see `.game-viewport` in styles.css. Handed to
  // `GameController` as `sceneHost`; unused by every game/session with no `scene` module.
  const viewportRef = useRef<HTMLDivElement>(null);
  // HUD-SAFE CAMERA FRAMING: `.game-root` is the containing block every absolutely-positioned
  // HUD overlay is laid out against, so it is the subtree `GameController` measures the
  // `[data-hud-band]` elements in — the bands a 3D camera must keep the field out from under
  // (`SceneInsets`, `games/module.ts`). Handed over as `hudHost`; a 2D view never reads it.
  const rootRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<GameController | null>(null);

  /**
   * THE IN-MATCH CONTRACT: while this screen is mounted, THE PAD IS THE ROBOT'S.
   *
   * `PadNavLayer` would otherwise keep moving focus and firing synthetic clicks off the same
   * stick and buttons the driver is steering with, so the layer stands down for the whole
   * mount and the only thing it still listens for is the MENU button — `PadBindings.menuButton`
   * (default D-RIGHT/15, the one standard-mapping index no default bind uses). That press is
   * masked out of `GamepadInput.sample` on its way through, so the button that leaves the match
   * cannot also fire a shot on the way out; `src/input/padNav.ts` says why.
   *
   * ⚠️ MOUNT-ONCE, with `onExit` in a ref. It is a fresh arrow every render and `App`
   * re-renders on its own every few seconds (the presence poll) — depending on it would tear
   * the suspension down and rebuild it mid-match, which is the same trap the Controls screen's
   * capture effects document.
   */
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  useEffect(() => {
    suspendPadNav('match');
    setPadMenuHandler(() => exitRef.current());
    return () => {
      setPadMenuHandler(null);
      resumePadNav('match');
    };
  }, []);
  const [hud, setHud] = useState<HudSnapshot | null>(null);
  const [intro, setIntro] = useState<IntroPlayer[] | null>(null);
  const [editingLayout, setEditingLayout] = useState(editLayout);
  // gates the flanking ad columns. When false the <aside>s are not rendered at all
  // (not merely empty), so an unconfigured or supporter build leaves the field
  // exactly where it was. GameController watches the canvas with a ResizeObserver,
  // so the camera re-fits the moment this flips.
  const ads = useAdUnitActive('game');
  // one subscription, not five MediaQueryList constructions per render at the 10 Hz HUD poll
  // — and, unlike reading the query during render, this actually updates when it changes
  const coarsePointer = useCoarsePointer();
  /**
   * HOW MUCH OF THE PERFORMANCE READ-OUT TO DRAW — the setting, with `?perf` as an override.
   *
   * `?perf=1` used to be the ONLY way to see a frame time, which made the ad sign-off a query
   * string somebody had to remember. It is a setting now (`GameSettings.perfDisplay`, default
   * `simple`), and the flag survives as a shortcut to the level that sign-off actually wants:
   * `?perf` forces `detailed`, `?perf=graphs` (or any level name) asks for that one. Read ONCE,
   * since a query string cannot change without a reload.
   */
  const [perfOverride] = useState<PerfDisplay | null>(() => {
    if (typeof location === 'undefined') return null;
    const q = new URLSearchParams(location.search).get('perf');
    if (q === null) return null;
    return PERF_DISPLAY_LEVELS.includes(q as PerfDisplay) ? (q as PerfDisplay) : 'detailed';
  });
  const perfLevel = perfOverride ?? settings.perfDisplay;
  const [perfStats, setPerfStats] = useState<PerfSnapshot | null>(null);
  /**
   * BIOBUZZ 3D SEAM: does STARTING this practice need the 3D physics chunk loaded first?
   *
   * ⚠️ **SOLO ONLY — `!session` IS LOAD-BEARING, NOT A CONVENIENCE.** This branch owns the
   * FALLBACK TO 2D below, and falling back is legitimate for exactly one kind of run: an
   * offline practice, which reaches no board. Everything with a `session` is a server room,
   * every server room of a 3D-capable game is 3D (`Room.physics`, owner ruling 2026-09-18),
   * and a record run that quietly re-ran on the 2D solve would put a score on a 3D board.
   * Those refuse instead: `RecordRun` preflights the chunk and says so if it will not load,
   * and a room already under way surfaces the failure through the controller's own latch
   * (`onPhysicsPending` and the event-log line in `game.ts`). Never widen this condition to
   * cover a session.
   *
   * `practicePhysics` absent reads `'3d'`, the seam's default. A lazy initializer so the FIRST
   * render already knows, same pattern as `perf`/`editingLayout` below — this effect is
   * mount-only (see the trailing eslint-disable), so the decision is frozen at mount like every
   * other setting it reads.
   */
  const [physicsLoading, setPhysicsLoading] = useState(() => {
    const need3d =
      !session &&
      (settings.practicePhysics ?? '3d') === '3d' &&
      !!moduleFor(settings.game).physicsOptions?.includes('3d');
    return need3d && !physics3dReady();
  });
  /**
   * THE ONLINE HALF OF THE SAME PANEL (Day 3).
   *
   * `physicsLoading` above is the SOLO answer and it is a decision this screen can make for
   * itself: it awaits `initPhysics3d()` before it constructs anything, so it knows. A ROOM is
   * the opposite — `session` arrives already built from a `matchStart` that landed on a socket,
   * and whether that room is a 3D one is a fact only the controller reads (off the world, so it
   * also covers a spectator and a mid-match joiner). So the CONTROLLER tells this screen, and
   * this is the second flag it sets. Two flags rather than one because they are set from
   * different places at different times and `||`ing them at the render site is clearer than a
   * single flag two owners write.
   */
  const [roomPhysicsLoading, setRoomPhysicsLoading] = useState(false);
  /** the 3D VIEW is still loading (`GameController.sceneLoading`). Starts true when a solo 3D
   * practice is about to load the physics, so the view step shows as pending from frame one. */
  const [sceneLoading, setSceneLoading] = useState(physicsLoading && getViewPref() === '3d');

  /**
   * WAS THIS SCREEN OPENED TO RUN THE TUTORIAL? Frozen at mount, like `perf` and `editingLayout`
   * above and for the same reason: the boot effect runs once, and a prop that changed afterwards
   * would describe a run that is already going.
   */
  const [runTutorial] = useState(() => tutorial && !session);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current!;
    const sceneHost = viewportRef.current!;
    const hudHost = rootRef.current!;
    const need3d =
      !session &&
      (settings.practicePhysics ?? '3d') === '3d' &&
      !!moduleFor(settings.game).physicsOptions?.includes('3d');

    let hudTimer = 0;
    let clearTimer = 0;
    let onKey: ((e: KeyboardEvent) => void) | null = null;

    async function boot(): Promise<void> {
      // GameView.tsx: load the 3D physics chunk BEFORE the world exists, never after — a
      // world built with `practicePhysics: '3d'` steps into `step3d` on its very first
      // tick, and stepping one before `initPhysics3d()` resolves is the bug this await
      // exists to rule out. Idempotent: a second solo practice in the same tab resolves
      // immediately (`physicsLoading` never went true above), so this never re-shows the
      // loading panel or re-fetches the chunk.
      /**
       * THE TUTORIAL'S RUN SETTINGS, applied to this run only and never persisted.
       *
       * FREE DRIVE, no dummies, no bots — three separate things, each of them needed:
       *  · free drive is drivable from tick 0 (no countdown, no AUTO to sit through six times),
       *    bills no fouls (so the NECTAR step cannot hand out a G410 MAJOR for doing as it says),
       *    and is never recorded — which is what keeps a STAGED world out of the replay store;
       *  · a step that says "drive to your garden" must not have three strangers in the way.
       *
       * `settings` on disk is untouched, so the player's own Practice setup is exactly as they
       * left it when the tutorial finishes.
       */
      let effectiveSettings = runTutorial
        ? { ...settings, mode: 'free' as const, practiceSeats: {} }
        : settings;
      let physicsFallbackNotice: string | undefined;
      if (need3d && !physics3dReady()) {
        try {
          await initPhysics3d();
        } catch (err) {
          if (cancelled) return;
          // OFFLINE, or a stale build whose physics chunk 404s — fall back to 2D physics
          // for this session only (never persisted): `settings.practicePhysics` on disk is
          // untouched, so the player's next practice tries 3D again.
          //
          // ⚠️ PRACTICE ONLY. See `physicsLoading` above: a run that can reach a board refuses
          // instead of degrading, because the board is one solve.
          // eslint-disable-next-line no-console
          console.warn('BIOBUZZ 3D physics failed to load; playing this practice on 2D physics.', err);
          effectiveSettings = { ...settings, practicePhysics: '2d' };
          physicsFallbackNotice = 'Couldn’t load 3D physics. Playing this practice on 2D physics.';
        }
      }
      /**
       * THE ZENITH AUTO CHUNK, before the world exists, for the same reason as the 3D one: the
       * controller seats the robot at the auto's start and builds its seat inside `makeWorld`.
       * Solo practice and Free Drive only — never a room, a record run (both have a session) or
       * the tutorial. A failed load plays the practice without the auto and says so.
       */
      let zenithAuto: GameControllerZenithAuto | undefined;
      const activeAuto =
        !session && !runTutorial && moduleFor(settings.game).zenithAutos ? activeZenithAuto(settings.game) : null;
      if (activeAuto) {
        try {
          zenithAuto = { ...activeAuto, module: await import('./zenithEditor') };
        } catch (err) {
          if (cancelled) return;
          // eslint-disable-next-line no-console
          console.warn('The Zenith auto chunk failed to load; playing without the auto.', err);
          physicsFallbackNotice = physicsFallbackNotice ?? 'Couldn’t load the autonomous routine. Playing without it.';
        }
      }
      if (cancelled) return;
      setPhysicsLoading(false);
      // the controller reports the view from here on; a 2D fallback or a 2D view has none
      setSceneLoading(false);

      const controller = new GameController(canvas, effectiveSettings, session, {
        sceneHost,
        hudHost,
        physicsFallbackNotice,
        // the controller's own chunk latch, for the room case this screen cannot answer.
        // `cancelled` guards the unmount race: the load can settle after the effect tore down.
        onPhysicsPending: (pending) => {
          if (!cancelled) setRoomPhysicsLoading(pending);
        },
        onSceneLoading: (loading) => {
          if (!cancelled) setSceneLoading(loading);
        },
        // THE TUTORIAL, when this screen was opened to run one and the game HAS one. A game with
        // no `tutorial` slot gets `undefined` and plays an ordinary free drive, which is the
        // right outcome for DECODE and Chain Reaction today.
        tutorial: runTutorial ? moduleFor(settings.game).tutorial : undefined,
        zenithAuto,
      });
      controllerRef.current = controller;
      setIntro(controller.getIntro()); // ranked matches only; null otherwise
      hudTimer = window.setInterval(() => setHud(controller.getHud()), 100);
      onKey = (e: KeyboardEvent) => {
        // Escape is reserved (never rebindable); restart is handled by the
        // InputManager through the user's bindings
        if (e.key === 'Escape') onExit();
      };
      window.addEventListener('keydown', onKey);
      // once a networked match is DECIDED (phase 'post') or its slot is gone (failed),
      // there's nothing to rejoin — forget the saved active-game record so Home stops
      // offering "rejoin your match" for a finished/dead game.
      clearTimer = window.setInterval(() => {
        if (!session) return;
        const h = controller.getHud();
        if (h && (h.phase === 'post' || h.net?.failed)) clearActiveGame();
      }, 250);
    }

    void boot();

    return () => {
      cancelled = true;
      window.clearInterval(hudTimer);
      window.clearInterval(clearTimer);
      if (onKey) window.removeEventListener('keydown', onKey);
      const controller = controllerRef.current;
      if (controller) {
        // Check ONCE MORE on the way out. The poll above runs every 250ms, so leaving
        // promptly after the final buzzer could beat it — and the cost of losing that race
        // is Home still offering to rejoin a match that has already been decided.
        if (session) {
          const h = controller.getHud();
          if (h && (h.phase === 'post' || h.net?.failed)) clearActiveGame();
        }
        controller.dispose();
        controllerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * THE PERFORMANCE READ-OUT'S POLL — 4 Hz, and only while something is drawing it.
   *
   * Its OWN effect, not a line in the mount effect above, for two reasons: the level can
   * change (it is a prop, and the `?perf` override resolves at mount), and a read-out set to
   * `off` must cost exactly one `clearInterval` rather than a timer that samples into a state
   * nobody renders.
   *
   * 4 Hz is the ceiling, deliberately. A per-frame React update to display a frame-time number
   * would itself be the slowest thing on the page, which is a memorably useless way to measure
   * performance; a quarter of a second is also about as fast as a number can change and still
   * be readable. `getPerfStats` returns ONE object, so `PerfHud` (memoized) re-renders on this
   * beat rather than on the HUD's 10 Hz one. The series is only built for `graphs`.
   *
   * `controllerRef.current` is null until `boot()` resolves — the poll simply reads null and
   * React bails out on an unchanged value, so there is no coordination to get wrong.
   */
  useEffect(() => {
    if (perfLevel === 'off') {
      setPerfStats(null);
      return;
    }
    const wantSeries = perfLevel === 'graphs';
    const tick = (): void => setPerfStats(controllerRef.current?.getPerfStats(wantSeries) ?? null);
    tick();
    const t = window.setInterval(tick, 250);
    return () => window.clearInterval(t);
  }, [perfLevel]);

  // Keep the restart binding pointed at the CURRENT callback. The controller is
  // built in a mount-only effect, so registering it there would capture a stale
  // closure; this re-registers whenever the prop changes and clears it (null) when
  // the screen isn't a record run, leaving the binding inert in a versus match.
  useEffect(() => {
    controllerRef.current?.setRestartRequest(onRestartRun ?? null);
  }, [onRestartRun]);

  /** RUN IN ZENITH: the auto that just drove, opened in Zenith with the recorded path over it */
  const openRunInZenith = (): void => {
    const c = controllerRef.current;
    const mod = c?.zenithModule();
    const name = c?.getHud().auto?.name;
    if (!c || !mod || !name) return;
    const error = mod.launchZenith({ settings, open: name, trace: c.autoTrace() ?? undefined });
    c.logEvent(error ?? 'Zenith is open in another window with this run over the plan.');
  };

  // A REMATCH IS A NEW MATCH IN THE SAME GameView. The intro used to be read once at mount,
  // so a rematch replayed the first match's intro, ratings and all. Re-read it every time a
  // match enters its countdown: `getIntro` reads the session's CURRENT `matchStart` intros.
  useEffect(() => {
    if (hud?.phase === 'pre') setIntro(controllerRef.current?.getIntro() ?? null);
  }, [hud?.phase]);

  /**
   * SOLO PRACTICE finishing is the only end-of-run event this client owns — every other mode
   * is told by the server. Keeping the run is the app's job, so the controller just hands it
   * over (see `keepPracticeRun` in App).
   *
   * Registered HERE, not in the mount effect, for the reason the restart binding above spells
   * out: the mount effect captures the prop from the FIRST render, and this callback closes
   * over `signedIn`, which starts false and flips when the auth session resolves ASYNCHRONOUSLY.
   * A run finished after that would have been handed to a closure that still believed nobody
   * was signed in, and the upload would never have been attempted at all.
   */
  useEffect(() => {
    const c = controllerRef.current;
    if (c) c.onPracticeRun = onPracticeRun ? (r, res) => onPracticeRun(r, res) : null;
  }, [onPracticeRun]);

  /**
   * IS A 3D SCENE ON SCREEN RIGHT NOW? — the flag behind the HUD's fixed dark scrim
   * (`docs/biobuzz/plan-3d.md` §4.7: "HUD stays React at 10 Hz with a fixed dark scrim in 3D").
   *
   * NOT simply `getViewPref() === '3d'`. The preference is a WISH; what the HUD has to react to
   * is a scene that is actually drawing, and the two come apart in three ordinary ways: the game
   * may have no `scene` module at all (DECODE, Chain Reaction), the chunk load may fail or the
   * GPU may refuse WebGL2 (`GameController.syncScene` falls back to the 2D view with a console
   * warning), and the scene mounts ASYNCHRONOUSLY a beat after the preference flips. Scrimming
   * the HUD over the ordinary dark 2D field would be a visible regression in all three.
   *
   * So the truth is read off the DOM: `GameController` inserts the scene's own canvas into
   * `.game-viewport` as its first child, so a SECOND canvas in that box IS a live scene. A
   * `MutationObserver` on that one box's children costs nothing (it fires on a view switch, not
   * per frame), and the view-pref subscription is kept alongside it so a flip back to 2D is
   * reflected even if the teardown order ever changes.
   */
  /**
   * THE EFFECTIVE MAP for whatever season is on the field — what the pre-match overlay must
   * name. Main plus this season's overrides, with the actions the season does not use emptied;
   * the controller resolves the same thing for the input layer. Read `hud.game` first (the
   * world is authoritative in a room) and fall back to the setting before the first HUD poll.
   */
  const effBindings = useMemo(
    () => effectiveBindings(settings.bindings, hud?.game ?? settings.game),
    [settings.bindings, settings.game, hud?.game],
  );
  const [scene3d, setScene3d] = useState(false);
  useEffect(() => {
    const host = viewportRef.current;
    if (!host) return;
    const sync = (): void => setScene3d(host.querySelectorAll('canvas').length > 1);
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(host, { childList: true });
    const stopPref = subscribeViewPref(sync);
    return () => {
      obs.disconnect();
      stopPref();
    };
  }, []);

  /** the device's camera pick — read here only to gate the "Reset view" chip below, which exists
   * only while a live 3D scene is actually showing the free camera (`scene3d`, not the bare
   * preference: a scene that failed to mount or fell back to 2D has no free camera to reset). */
  const [cameraPref, setCameraPrefState] = useState<CameraPref>(() => getCameraPref());
  useEffect(() => subscribeCameraPref(setCameraPrefState), []);

  // MOBILE zoom/select guard: iOS Safari ignores `user-scalable=no`, so a two-finger
  // pinch still zooms and a two-finger touch can pop the text-selection callout. Kill
  // the iOS `gesture*` events and any multi-touch default while the game is up, plus
  // the double-tap zoom. (touch-action:none on .game-root covers scroll-zoom.)
  useEffect(() => {
    const prevent = (e: Event): void => e.preventDefault();
    let lastTouchEnd = 0;
    const onTouchEnd = (e: TouchEvent): void => {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) e.preventDefault(); // double-tap zoom
      lastTouchEnd = now;
    };
    // passive:false is required for preventDefault to take effect
    document.addEventListener('gesturestart', prevent, { passive: false });
    document.addEventListener('gesturechange', prevent, { passive: false });
    document.addEventListener('gestureend', prevent, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: false });
    return () => {
      document.removeEventListener('gesturestart', prevent);
      document.removeEventListener('gesturechange', prevent);
      document.removeEventListener('gestureend', prevent);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  return (
    /* `.game-shell` is a flex row: ad column | field | ad column. `.game-root` stays
       the stage and the containing block for every absolutely-positioned overlay
       (.hud is inset:0, .scorebar is left:50%, .status-wrap is right:12px) — if the
       ads were siblings of those instead, the scorebar would centre on the window
       rather than the field and the status chips would land on the right-hand ad.

       The columns cost the field NOTHING. `camera.ts` fits with
       `min(w / spanW, usableH / spanH)` and DECODE's field is square, so on any
       landscape desktop the HEIGHT term binds and the horizontal slack is already
       going unused. The CSS gate below only reveals the columns at widths where
       that still holds — see the media query in styles.css. */
    <div className="game-shell">
      {/* NOT aria-hidden. It was, and that hid the "Advertisement" label along
          with the unit — the label exists precisely so an ad is distinguishable
          from content, and hiding it from the one group that cannot see the
          visual difference defeats it. `aria-label` names the region instead, so
          a screen-reader user can skip past it knowingly. */}
      {ads && (
        <aside className="game-ad" aria-label="Advertisement">
          <AdSlot unit="game" />
        </aside>
      )}
      {/* `view-3d` is the HUD's fixed dark scrim (plan-3d.md §4.7) — see `scene3d` above for why
          it tracks a live scene rather than the view preference, and the `.game-root.view-3d`
          block in styles.css for what it actually changes. */}
      <div className={scene3d ? 'game-root view-3d' : 'game-root'} ref={rootRef}>
      {/* BIOBUZZ 3D SEAM: the box a live scene mounts its own canvas into, UNDER this one
          (`docs/biobuzz/plan-3d.md` §4.1/§4.7) — see `.game-viewport` in styles.css. Every
          game/session with no `scene` module renders exactly the plain `.game-canvas` this
          always was; `GameController` is what decides whether anything else ever occupies it. */}
      <div className="game-viewport" ref={viewportRef}>
        {/* A screen-reader-playable driving sim is out of scope (see the Phase 6 audit,
            F7). The label at least stops this being an unlabelled interactive region;
            score/timer/gate state is announced by the live regions below. */}
        <canvas
          ref={canvasRef}
          className="game-canvas"
          role="img"
          aria-label={`${seasonFor(hud?.game ?? 'decode').name} field, top-down view. Match state is announced in the event log.`}
        />
      </div>
      {/* THE LOADING SCREEN. Physics has two owners: solo decides before the controller
          exists, a room's answer comes back from the controller (`roomPhysicsLoading`). The
          view is always the controller's. It covers the field and the HUD, so a 3D match no
          longer opens on a flash of the 2D render. */}
      {(physicsLoading || roomPhysicsLoading || sceneLoading || !!hud?.net?.hold) && (
        <LoadingScreen
          game={seasonFor(hud?.game ?? settings.game).name}
          physics={physicsLoading || roomPhysicsLoading}
          view={sceneLoading}
          hold={hud?.net?.hold}
        />
      )}
      {coarsePointer && controllerRef.current && (
        <MobileControls
          inputManager={controllerRef.current.getInputManager()}
          hud={hud}
          spec={settings.spec}
          layout={settings.mobileLayout}
          editing={editingLayout}
          onLayoutChange={(l) => onSettingsChange?.({ ...settings, mobileLayout: l })}
        />
      )}
      {editingLayout && (
        <div className="mobile-edit-bar">
          <span className="meb-hint">Drag the sticks and buttons to reposition</span>
          <button
            className="game-btn"
            onClick={() => onSettingsChange?.({ ...settings, mobileLayout: DEFAULT_MOBILE_LAYOUT })}
          >
            RESET
          </button>
          <button className="game-btn primary" onClick={() => setEditingLayout(false)}>
            DONE
          </button>
        </div>
      )}
      {hud?.net && (hud.net.failed || hud.net.waitingFor === 'server') && (
        <MatchOverlay titleId="gv-net-title" scrim="net-overlay" card="net-overlay-card">
          {hud.net.failed ? (
            <>
              <h3 className="ds-dialog-title" id="gv-net-title">Connection lost</h3>
              <p>The server may have restarted. Refresh the page to reconnect.</p>
              <div className="overlay-buttons">
                <button onClick={() => window.location.reload()}>REFRESH</button>
                <button className="secondary" onClick={onExit}>
                  MENU
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="net-spinner" />
              <h3 className="ds-dialog-title" id="gv-net-title">Reconnecting…</h3>
              <p>Your run keeps going.</p>
            </>
          )}
        </MatchOverlay>
      )}
      {hud && (
        <Hud
          hud={hud}
          showEventLog={settings.showEventLog}
          perfLevel={perfLevel}
          perfStats={perfStats}
        />
      )}
      {/* THE TUTORIAL STEP CARD — a HUD band, never an overlay over the field
          (`docs/area/ui.md`). It is a sibling of `<Hud>` rather than a child because `.hud` is
          `pointer-events: none` and this card has buttons; see `TutorialCard.tsx` for why
          `data-hud-band` on it is load-bearing for the 3D camera fit. */}
      {hud?.tutorial && (
        <TutorialCard
          view={hud.tutorial}
          onSkip={() => controllerRef.current?.tutorialSkip()}
          onReplay={() => controllerRef.current?.tutorialReplay()}
          onExit={() => controllerRef.current?.tutorialExit()}
        />
      )}
      {/* `data-hud-band` — a HUD cluster that covers part of the field. The 3D camera keeps the
          field out from under every one of them (`SceneInsets`, `games/module.ts`); nothing
          visual reads it. See `GameController.refreshHudInsets` for what is NOT marked and why. */}
      <div className="game-buttons" data-hud-band>
        <button className="game-btn" onClick={onExit} title="Menu (Esc)">
          <span aria-hidden="true">◄</span> MENU
        </button>
        {/* RESET is a LOCAL rebuild — meaningless (and desyncing) in lockstep, so
            solo only. In multiplayer use REMATCH on the results screen (host). */}
        {!session && (
          <button
            className="game-btn"
            onClick={() => controllerRef.current?.restart()}
            title="Restart"
          >
            <span aria-hidden="true">⟲</span> RESET
          </button>
        )}
        {/* THE AUTO'S RUN, SENT TO ZENITH: once the auto has driven, its recorded path opens in
            Zenith laid over the plan (`zenithLaunch.ts`). Solo only, like the auto itself. */}
        {!session && hud?.auto && (hud.auto.state === 'done' || hud.auto.state === 'stopped') && (
          <button className="game-btn" onClick={openRunInZenith} title="Open this auto in Zenith with the path the robot drove">
            <span aria-hidden="true">↗</span> RUN IN ZENITH
          </button>
        )}
        {/* CO-OP (duo record): restarting is a VOTE — the run belongs to both
            drivers, so neither can pull it out from under the other. Available
            MID-MATCH as well as on the results screen, and the R binding does
            exactly this. */}
        {session && hud?.rematch && hud.rematch.need > 1 && (
          <button
            className={`game-btn${hud.rematch.mine ? ' on' : ''}`}
            aria-pressed={hud.rematch.mine}
            onClick={() => controllerRef.current?.toggleRematch()}
            title={
              hud.rematch.mine
                ? 'You want a rematch. Press again to take it back'
                : 'Vote to restart. Everyone still connected has to agree'
            }
          >
            <span aria-hidden="true">⟲</span> REMATCH {hud.rematch.votes}/{hud.rematch.need}
          </button>
        )}
        {/* a SOLO record run is server-hosted, so RESET's local rebuild is unsafe
            here; this starts a whole fresh run instead (new room, new seed). */}
        {session && onRestartRun && !hud?.rematch?.need && (
          <button className="game-btn" onClick={onRestartRun}>
            <span aria-hidden="true">⟲</span> NEW RUN
          </button>
        )}
        {/* FREE CAM's own on-field affordance (owner, 2026-09-21): the camera has no keyboard
            binding (mouse-only, see `renderScene.ts`'s pointer handling), so double-click is the
            only other way back to the default framing. Gated on `scene3d`, not the bare
            preference — a scene that failed to mount or fell back to 2D has nothing to reset. */}
        {scene3d && cameraPref === 'free' && (
          <button className="game-btn" onClick={requestFreeCamReset} title="Double-click the field to do the same">
            <span aria-hidden="true">⟲</span> RESET VIEW
          </button>
        )}
        {/* THE IN-GAMEPLAY PLACEMENT, LAST on this line — after RESET, and after
            REMATCH / NEW RUN in a multiplayer or record run. The controls are what
            a driver reaches for mid-match, so they keep the corner; the mark reads
            as the line's credit rather than as the first button.

            On this line at all because `.game-buttons` is the top-corner cluster with
            room on every layout — the status card opposite is sized to a phone's gutter.
            Outside the `ads` gate entirely: see the note at the top of Sponsor.tsx.
            It renders on a phone, in the Electron build, and for supporters, all
            three of which the ad path deliberately skips. */}
        <SponsorGameChip />
      </div>
      {hud?.phase === 'pre' && hud.countdown === null && !session && (
        <MatchOverlay titleId="gv-pre-title">
          {/* FILLED, not ink (design review 05-12): which side you are on is the one fact this
              panel exists for, and DESIGN reserves the alliance chip fill for exactly it. */}
          <h2 id="gv-pre-title">
            <span className={`chip alliance-${hud.alliance}`}>{hud.alliance.toUpperCase()} ALLIANCE</span>
          </h2>
          {hud.game === 'decode' && (
            <p>
              {/* the dots' own label says "Motif", so the visible word is not read twice */}
              <span aria-hidden="true">MOTIF</span> <MotifDots motif={hud.motif} />
            </p>
          )}
          {!coarsePointer && (
            <p className="big">
              Press {keyLabel(effBindings.keys.start[0] ?? 'enter')} or{' '}
              {padBindLabel(padBinds(effBindings.pad, 'start')[0] ?? [9])} to start
            </p>
          )}
          {/* `.overlay-buttons`, not `.ds-cta`: every other button in every
              `.overlay-panel` — including the net overlay's REFRESH/MENU a few
              lines up — is that one, and `.ds-cta.secondary` grounds on `--ds-line`,
              which is the wrong edge for a card floating on a dark scrim. */}
          {coarsePointer && (
            <div className="overlay-buttons stack">
              <button onClick={() => controllerRef.current?.startMatch()}>START MATCH</button>
              <button className="secondary" onClick={onExit}>
                BACK TO MENU
              </button>
            </div>
          )}
          {/* KEYBOARD ONLY. A phone has just been handed START MATCH and BACK TO
              MENU precisely because it has no keys to press. */}
          {!coarsePointer && (
            <p className="ds-hint">
              Esc · menu &nbsp;·&nbsp; {keyLabel(effBindings.keys.restart[0] ?? '?')} · restart
            </p>
          )}
        </MatchOverlay>
      )}
      {intro && hud?.phase === 'pre' && (
        <RankedIntro players={intro} viewAlliance={hud.alliance} />
      )}
      {hud?.phase === 'pre' && hud.countdown !== null && (
        <div
          className={hud.countdown > 3 ? 'countdown-text' : 'countdown-num'}
          key={hud.countdown}
        >
          {hud.countdown > 3 ? 'MATCH BEGINS IN' : hud.countdown}
        </div>
      )}
      {/* THE KEYS ARE GOING SOMEWHERE ELSE, AND NOTHING USED TO SAY SO.
          A non-host never clicks into a match — the session is built straight off the server's
          `matchStart` — so in a Discord Activity a driver who tapped the chat box beside the
          iframe to type "ready" is pulled into a live match with the focus still over there.
          The sim keeps stepping, W goes to Discord, and the robot sits still.

          Not on a COARSE pointer: a phone has no keyboard to lose and nothing to click, and
          the touch pad's own presses reach the canvas whatever the window thinks. Not in
          `post` either — the results overlay is up, it is interactive, and the match is over,
          so there is nothing left to drive. */}
      {hud && !hud.windowFocused && !coarsePointer && hud.phase !== 'post' && (
        <div className="focus-hint">
          Your keystrokes are going somewhere else. Click the field to drive.
        </div>
      )}
      {hud?.phase === 'post' && (
        <Results
          hud={hud}
          final={hud.resultFinal}
          lost={hud.resultLost}
          ranked={!!session?.ranked}
          eloResults={controllerRef.current?.getEloResults() ?? null}
          canRematch={!session}
          onRematch={() => controllerRef.current?.rematch()}
          onRunAgain={onRestartRun}
          rematchVote={hud.rematch}
          onQueueAgain={session?.ranked ? onQueueAgain : undefined}
          /* Host only, and read fresh on every results render rather than captured once:
             the crown migrates when a host leaves, and this overlay re-renders off the HUD
             clock, so the player who inherits the room sees the control appear. */
          onBackToLobby={onBackToLobby && session?.isHost() ? onBackToLobby : undefined}
          onRematchVote={() => controllerRef.current?.toggleRematch()}
          onExit={onExit}
          /* every OTHER driver in this match, by robot id + the name they played under.
             Built from the session's own roster, so it is exactly the set the server will
             accept a report for. */
          reportable={
            session && signedIn
              ? session.setups
                  .filter((su) => su.id !== session.localRobotId)
                  .map((su) => ({ robotId: su.id, name: su.spec.name || `Driver ${su.id}` }))
              : []
          }
          onReport={
            session?.sendReport
              ? (rid, reason, detail) => session.sendReport?.(rid, reason, detail)
              : undefined
          }
          onReportScore={
            session?.sendScoreReport ? (detail) => session.sendScoreReport?.(detail) : undefined
          }
          matchResult={controllerRef.current?.getMatchResult() ?? null}
          lanHost={!!session?.isHost()}
          practiceRun={controllerRef.current?.getPracticeRun() ?? null}
          recordResult={controllerRef.current?.getRecordResult() ?? null}
          signedIn={signedIn}
          onWatchReplay={onWatchReplay}
          onSignIn={onSignIn}
          /* marks the "YOU" row in the results roster (built from the match's own
             recorded setups) — slot 0 in solo, the lobby-assigned id in multiplayer. */
          localRobotId={controllerRef.current?.localRobotId}
          /* who was in each seat — the roster's badge/title source. Empty in solo and
             against a server older than the fields, where a row simply renders bare. */
          drivers={session?.drivers}
        />
      )}
      </div>
      {/* NOT aria-hidden. It was, and that hid the "Advertisement" label along
          with the unit — the label exists precisely so an ad is distinguishable
          from content, and hiding it from the one group that cannot see the
          visual difference defeats it. `aria-label` names the region instead, so
          a screen-reader user can skip past it knowingly. */}
      {ads && (
        <aside className="game-ad" aria-label="Advertisement">
          <AdSlot unit="game" />
        </aside>
      )}
    </div>
  );
}

/** styled after the FTC live scoring audience display: red panel | timer | blue panel */
function Hud({
  hud,
  showEventLog,
  perfLevel,
  perfStats,
}: {
  hud: HudSnapshot;
  showEventLog: boolean;
  perfLevel: PerfDisplay;
  perfStats: PerfSnapshot | null;
}) {
  const coarsePointer = useCoarsePointer();
  // MODULE UI SLOTS. Neither current game fills either, so both branches below are
  // the ones that were already there.
  const GameScoreBar = moduleFor(hud.game).scoreBar;
  const GameChips = moduleFor(hud.game).hudChips;
  const GamePinnedNotice = moduleFor(hud.game).pinnedNotice;
  const timer = timerPanel(hud);
  // the auto's line on the second card: which step it is on, while AUTO (or a Free Drive trial) runs
  const autoLine =
    hud.auto && hud.auto.state === 'running'
      ? `AUTO · ${(hud.auto.stepId ?? hud.auto.name).toUpperCase()}`
      : hud.auto && hud.auto.state === 'done' && (hud.phase === 'auto' || hud.phase === 'freeplay')
        ? 'AUTO DONE'
        : null;
  const redScore = hud.alliance === 'red' ? hud.score.total : hud.oppTotal;
  const blueScore = hud.alliance === 'blue' ? hud.score.total : hud.oppTotal;
  // Chain Reaction is scored (its own breakdown); DECODE shows motif + its breakdown.
  const cr = hud.game === 'chain';
  /**
   * ...and DECODE is DECODE, named POSITIVELY.
   *
   * The motif dots, the CLASSIFIED / OVERFLOW / PATTERN / RAMP row and the hopper
   * pips + power gauge + gate chip are DECODE's elements, and they were gated on
   * `!cr` — "every game that is not Chain Reaction", which was the same set as
   * DECODE right up until there was a third game, and then silently put DECODE's
   * chrome on it. Byte-identical for both games that existed: `!cr` and `dec` agree
   * on `decode` (true) and on `chain` (false).
   */
  const dec = hud.game === 'decode';

  return (
    <div className="hud">
      {/* A game that owns its whole bottom bar replaces it wholesale — the shared bar is
          red | timer | blue with a motif, which is not a given for every game. It replaces
          only the BAR: the chip row below is shared chrome (net, gamepad, cards, spectators)
          that every game wants, and a game's own chips go into it through `hudChips`. */}
      {GameScoreBar ? (
        <GameScoreBar hud={hud} />
      ) : hud.mode === 'match' ? (
        <div className="scorebar" data-hud-band>
          <div className={`score-panel red ${hud.alliance === 'red' ? 'mine' : ''}`} role="group" aria-label="Red alliance score">
            {hud.alliance === 'red' && <span className="you-tag">YOU</span>}
            <span className="panel-score">{redScore}</span>
          </div>
          <div className={`timer-panel ${timer.cls}`}>
            {/* status on the PHASE only — the digits beside it retick every frame and
                would flood a screen reader. This changes ~4 times a match. */}
            <span className="timer-phase" role="status">
              {timer.label}
            </span>
            <span className="timer-time">{timer.time}</span>
            {dec && <MotifDots className="timer-motif" motif={hud.motif} />}
          </div>
          <div className={`score-panel blue ${hud.alliance === 'blue' ? 'mine' : ''}`} role="group" aria-label="Blue alliance score">
            {hud.alliance === 'blue' && <span className="you-tag">YOU</span>}
            <span className="panel-score">{blueScore}</span>
          </div>
        </div>
      ) : (
        <div className="scorebar" data-hud-band>
          <div className="timer-panel">
            <span className="timer-phase">FREE DRIVE</span>
            {dec && <MotifDots className="timer-motif" motif={hud.motif} />}
          </div>
        </div>
      )}

      {hud.mode === 'match' && dec && (
        <div className="breakdown-row" data-hud-band>
          {/* artifact COUNTS, not points (points live in the score panels).
              PATTERN shows only BANKED points — it is assessed solely at the
              end of AUTO and the end of the match, never live. */}
          <span>CLASSIFIED {hud.classifiedCount}</span>
          <span>OVERFLOW {hud.overflowCount}</span>
          <span>
            PATTERN{' '}
            {hud.score.autoPattern + (hud.phase === 'post' ? hud.score.telePattern : 0)} PTS
          </span>
          <span>RAMP {hud.rampCount}/9</span>
          <FoulChip hud={hud} />
        </div>
      )}

      {hud.mode === 'match' && cr && hud.chain && (
        <div className="breakdown-row" data-hud-band>
          {/* EACH FACT ONCE (design review 05-14, 22-11). MULT and CATALYSTS were printed here
              AND drawn as the badge + pips in `ChainHudChips`, which every pointer now gets, so
              the card is their one home. ASCENDED / PARKED is the `.park-status` card on a fine
              pointer and this chip on a coarse one, never both: a landscape gutter has no height
              for a third card, and this row is the one a phone renders at full size. */}
          <span>PARTICLES {hud.chain.scored}</span>
          {coarsePointer && hud.chain.endgame !== 'none' && (
            <span>{hud.chain.endgame === 'ascended' ? 'ASCENDED' : 'PARKED'}</span>
          )}
          <FoulChip hud={hud} />
        </div>
      )}

      {/* EVERY POINTER GETS THE CARD (design review 05-05). It used to be fine-pointer only, so
          a phone lost the hopper, the gate, the power draw, every game's own column, the card
          icon, the frame rate and DESYNC — facts a driver cannot get anywhere else. The compact
          blocks in styles.css shrink the card and keep it in the gutter; what a phone skips is
          listed at each gate below, and each skip has another home. */}
      {(
        /**
         * ⚠️ `data-hud-band` IS ON THE CHIP ROW, NOT ON THE WRAPPER.
         *
         * It used to be on `.status-wrap`, which also holds whatever is stacked UNDER the
         * chips — and a band's rect is what `GameController.refreshHudInsets` reserves for the
         * 3D camera. So opening the old ping graph, or the old prediction panel, grew the band and
         * reframed the field; `.breakdown-row`'s own note records what that looks like
         * (measured: a 25px inset change visibly jumped the field). The chips are the part that
         * actually covers the corner, so they are the part that is measured, and the read-out
         * below them is deliberately NOT — a diagnostic that changed the shot would ruin every
         * before/after comparison somebody turned it on to make.
         *
         * Not on a coarse pointer: there the card floats over a field corner, as camera.ts
         * says, rather than shrinking a phone's 3D field by the card's height.
         *
         * The 3D scrim still reaches everything in here: `.game-root.view-3d .status-wrap`
         * redefines the tokens for the whole cluster (styles.css).
         */
        <div className="status-wrap">
          {/* ONE LINE: the status card and the presenting sponsor's mark, right-
              aligned together. The mark used to sit in its own line above and push
              the whole cluster down, which read as a floating badge over the field
              rather than as part of the HUD chrome. */}
          <div className="status-row" data-hud-band={coarsePointer ? undefined : true}>
            <div className="robot-status">
              {GameChips && <GameChips hud={hud} />}
              {dec && (
                <div className="dec-hud">
                  <div className="dec-hud-left">
                    {/* spoken like Chain's and BIOBUZZ's columns (design review 22-12): the pips
                        are colour alone, and `.hud` takes no pointer, so a `title` never shows */}
                    <div
                      className="hopper vertical"
                      role="img"
                      aria-label={`Hopper ${hud.hopper.length} of 3${hud.hopper.length ? `: ${hud.hopper.join(', ')}` : ''}.`}
                    >
                      {[0, 1, 2].map((i) => (
                        <span key={i} className={`hopper-pip ${hud.hopper[i] ?? 'empty'}`} />
                      ))}
                    </div>
                    {/* the gate lever always renders — closed is a real, visible state, unlike
                        the old chip that vanished entirely when the gate wasn't open */}
                    <span
                      className={`gate-icon${hud.gateOpen ? ' open' : ''}${hud.gateOpen && hud.gateForced ? ' forced' : ''}`}
                      role="img"
                      aria-label={
                        hud.gateOpen
                          ? hud.gateForced
                            ? 'Gate forced open by the opponent.'
                            : 'Gate open.'
                          : 'Gate closed.'
                      }
                    />
                  </div>
                  <div className="dec-hud-right">
                    <PowerGauge draw={hud.powerDraw} />
                  </div>
                </div>
              )}
              {/* ⚠️ NOTHING ELSE GOES IN THIS CARD. It is the GAME's card — a column of dots,
                  a gauge, a lever — and every text/emoji chip that used to sit beside them was
                  relocated by the owner's own pass over this corner (`HUD-RELOCATION.md`, which
                  names a destination per chip):
                    · SERVER <region>, WATCHING <n>, ⚠ DESYNC → the bottom-right `.net-corner`,
                      below (on a phone, DESYNC alone, at the foot of this cluster);
                    · WAITING · <name>, PIN / CONTROL 5+ → pinned lines in the event log
                      (`GamePinnedNotice` / `eventlog-pinned`), because each is a call to action
                      rather than a standing fact — shown whatever the messages toggle says;
                    · FOULS → `FoulChip`, in every game's breakdown row (design review C39);
                    · REVERSED / butterfly / card → the `.sub-hud` under this card;
                    · Chain Reaction's mult/catalyst/hold state → `ChainHudChips` (`GameChips`
                      above), its ASCENDED/PARKED status → the `.park-status` card below;
                    · 🎮 gamepad → nowhere. A pad that is plugged in says so by driving the
                      robot, and one that is not is a menu problem, not a match one.
                  A chip added back here also widens `[data-hud-band]` (it is on the row), and a
                  band that changes width mid-match re-frames the 3D field — measured at 1440px:
                  one spectator chip took the band from 83px to 227px in BIOBUZZ. */}
            </div>
          </div>
          {/* a SECOND card, below the first — rows for state that's active only sometimes
              (reversed drive, a butterfly's wheel set, a card), so it appears and grows downward
              rather than permanently reserving chip width in the row above.
              EACH GLYPH CARRIES A VISIBLE WORD (design review 05-06). They explained themselves
              through `title`, and `.hud` is `pointer-events: none`, so no tooltip ever showed —
              a new driver could not learn what two amber rings meant. The word is `aria-hidden`
              because the glyph's own `aria-label` already says it in full. This card is NOT in
              `[data-hud-band]`, so a word here never re-frames the 3D field. */}
          {(hud.frontFlipped || hud.butterflyMode || hud.card || autoLine) && (
            <div className="sub-hud">
              {/* THE ZENITH AUTO driving this robot, and the step it is on: a standing fact while
                  AUTO runs, so it lives on this card (HUD-RELOCATION.md), in words */}
              {autoLine && (
                <span className="sub-hud-item" role="status">
                  <span className="sub-hud-lbl">{autoLine}</span>
                </span>
              )}
              {hud.frontFlipped && (
                <span className="sub-hud-item">
                  <span className="reversed-icon" role="img" aria-label="Front flipped: driving reversed." />
                  <span className="sub-hud-lbl" aria-hidden="true">
                    REVERSED
                  </span>
                </span>
              )}
              {hud.butterflyMode && (
                <span className="sub-hud-item">
                  <span
                    className={`butterfly-icon ${hud.butterflyMode}`}
                    role="img"
                    aria-label={`Butterfly drivetrain: ${hud.butterflyMode === 'tank' ? 'traction' : 'mecanum'} wheels down.`}
                  />
                  <span className="sub-hud-lbl" aria-hidden="true">
                    {hud.butterflyMode === 'tank' ? 'TRACTION' : 'MECANUM'}
                  </span>
                </span>
              )}
              {hud.card && (
                <span className="sub-hud-item">
                  <span
                    className={`card-icon ${hud.card}`}
                    role="img"
                    aria-label={`${hud.card === 'red' ? 'Red' : 'Yellow'} card issued.`}
                  >
                    {/* a LETTER as well as the fill (design review 17-06): yellow and red must not
                        be told apart by hue alone */}
                    {hud.card === 'red' ? 'R' : 'Y'}
                  </span>
                  <span className="sub-hud-lbl" aria-hidden="true">
                    CARD
                  </span>
                </span>
              )}
            </div>
          )}
          {/* a THIRD card CR's ring-stand/lab-area endgame status. Only while it's actually
              true (`hud.chain.endgame` is already phase-gated to 'none' outside endgame by
              the sim itself, see `chainStep`), so no default/reminder state to render.
              Border colour matches the existing on-canvas badge over the robot
              (`drawChain.ts`: ascended gold, parked white) see HUD-RELOCATION.md. */}
          {/* NOT on a phone: there the breakdown row prints ASCENDED / PARKED instead (and only
              there — see that row), because a landscape gutter has no height for a third card. */}
          {!coarsePointer && cr && hud.chain && (hud.chain.endgame === 'ascended' || hud.chain.endgame === 'parked') && (
            <div className={`park-status ${hud.chain.endgame}`}>
              {hud.chain.endgame === 'ascended' ? 'ASCENDED' : 'PARKED'}
            </div>
          )}
          {/* a phone gets the `simple` line at most, HERE: frame rate and ping fit the gutter,
              the detailed rows and graphs do not (the review's own suggestion, 05-05), and the
              bottom-right corner a desktop uses is the thumb pad's. */}
          {coarsePointer && <PerfHud level={perfLevel === 'off' ? 'off' : 'simple'} stats={perfStats} />}
          {/* DESYNC, on a phone, at the foot of this cluster: the bottom-right corner is the
              thumb pad's. It is the one net chip that is a state rather than a fact (see the
              corner below); WATCHING and SERVER stay desktop-only. */}
          {coarsePointer && hud.net?.desync && (
            <span className="chip desync" role="status">
              <span aria-hidden="true">⚠</span> DESYNC
            </span>
          )}
        </div>
      )}

      {/* THE BOTTOM-RIGHT NET CLUSTER — who is WATCHING, and WHERE the match is hosted. Its
          own corner, per the owner's destinations in `HUD-RELOCATION.md`: these are facts about
          the SESSION, and parking them in the top-right card made that card grow sideways every
          time somebody joined to watch. Same anchor idiom as `.status-wrap`, mirrored to the
          opposite corner and edge.

          NO `data-hud-band`. The cluster's width follows the spectator count and the region
          name, and a band's box is what the 3D camera fits the field around — a band that
          changes size mid-match moves the field under the driver (`.breakdown-row`'s note
          records the measurement). It takes the 3D scrim by name instead, exactly like
          `.status-wrap` does (`.game-root.view-3d .net-corner` in styles.css).

          The connection READ-OUT is not here: ping, jitter and snapshot rate live on `PerfHud`
          with the frame rate (see the note at the top of this file). Only DESYNC stayed a chip,
          because a link that has gone actively wrong is a state, not a measurement. */}
      {/* gated on the three things inside it, not on `hud.net` alone: main could gate on the
          connection because the connection chip was always in here to fill the cluster, and
          that chip is on `PerfHud` now — a bare `hud.net` would mount an empty corner.
          Fine pointer only: on a phone this corner is the thumb pad's, and DESYNC moved up into
          the status cluster above. */}
      {/* THE PERFORMANCE READ-OUT sits here on a desktop, above the net chips. It used to hang
          under the top-right chip column, so it moved with every game's column height (under
          BIOBUZZ's storage pips it floated a third of the way down the edge). This corner is
          anchored to the bottom and holds only the connection chips it belongs with. */}
      {!coarsePointer && (
        <div className="net-corner">
          <PerfHud level={perfLevel} stats={perfStats} />
          {(hud.spectators > 0 || !!hud.net?.desync || !!hud.net?.server) && (
            <div className="net-corner-row">
              {/* who is watching. Shown only when somebody IS: a standing "0 watching" is
                  noise, and the moment worth surfacing is the one where it stops being zero. */}
              {hud.spectators > 0 && (
                // the WORD, not SPEC plus a `title` nobody could hover (`.hud` is pointer-events: none)
                <span className="chip">WATCHING {hud.spectators}</span>
              )}
              {hud.net?.desync && (
                <span className="chip desync" role="status">
                  <span aria-hidden="true">⚠</span> DESYNC
                </span>
              )}
              {/* plain `.chip`, like SPEC: both are neutral facts, and `.chip.on` is the ready/ok green */}
              {hud.net?.server && <span className="chip">SERVER {hud.net.server}</span>}
            </div>
          )}
        </div>
      )}

      {/* polite: match events shouldn't interrupt, but they are the only non-visual channel for
          scoring/gate/penalty state, so the REGION IS ALWAYS MOUNTED (design review C39: 05-11,
          17-10). The "In-match messages" toggle hides the fading TOASTS from the eye only — they
          go `.ds-sr`, still announced — and never the pinned lines, which are calls to action
          (a PIN counting, CONTROL 5+, WAITING) and were the one thing a driver who cleared the
          corner could not afford to lose. With the toggle off and nothing pinned the column is
          empty and draws nothing. The canvas label's promise ("announced in the event log")
          holds either way. */}
      <div className="eventlog" aria-live="polite">
        {GamePinnedNotice && <GamePinnedNotice hud={hud} />}
        {hud.net?.waitingFor && (
          <div className="eventlog-line eventlog-pinned">WAITING · {hud.net.waitingFor}</div>
        )}
        {/* the pre-match countdown, spoken: the big digits are keyed per tick and in no live
            region, so "3, 2, 1" was never announced (17-10). A changing text node in a polite
            region is. */}
        {hud.phase === 'pre' && hud.countdown !== null && (
          <div className="ds-sr">{hud.countdown > 3 ? 'Match begins in' : hud.countdown}</div>
        )}
        {hud.toasts.map((t) => (
          <div key={t.id} className={showEventLog ? 'eventlog-line' : 'ds-sr'}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

/** one driver card in the ranked intro (team/name, drivetrain badge, count-up ELO) */
function IntroCard({ p, index }: { p: IntroPlayer; index: number }) {
  const elo = useCountUp(p.elo ?? 0, true, 1100);
  return (
    <div
      className={`intro-card ${p.alliance} ${p.isLocal ? 'you' : ''}`}
      style={{ animationDelay: `${0.15 + index * 0.12}s` }}
    >
      <div className="intro-card-head">
        <span className="intro-team">{p.teamNumber ? `#${p.teamNumber}` : '-'}</span>
        {p.isLocal && <span className="intro-you">YOU</span>}
      </div>
      <div className="intro-name">{p.name || 'Unnamed'}</div>
      <div className="intro-sub">{p.teamName || 'No team'}</div>
      <div className="intro-meta">
        <span className="intro-dt">{DT_LABEL[p.drivetrain]}</span>
        <span className="intro-elo">{p.elo === null ? 'UNRANKED' : elo}</span>
      </div>
    </div>
  );
}

/** ranked pre-match intro: RED vs BLUE cards fly in from their sides, drivetrains
 * shown, ELO counting up. Runs during the ~4s pre-match countdown (the "MATCH
 * BEGINS IN" / 3-2-1 digits render on top). */
function RankedIntro({
  players,
  viewAlliance,
}: {
  players: IntroPlayer[];
  viewAlliance: Alliance;
}) {
  const red = players.filter((p) => p.alliance === 'red');
  const blue = players.filter((p) => p.alliance === 'blue');
  // put the local player's alliance on the left so it reads as "us vs them"
  const [left, leftName, right, rightName] =
    viewAlliance === 'blue'
      ? ([blue, 'BLUE', red, 'RED'] as const)
      : ([red, 'RED', blue, 'BLUE'] as const);
  return (
    <div className="intro-overlay">
      <div className="intro-eyebrow">RANKED MATCH</div>
      <div className="intro-cols">
        <div className="intro-col">
          <div className={`intro-side-label ${leftName.toLowerCase()}`}>{leftName}</div>
          {left.map((p, i) => (
            <IntroCard key={p.robotId} p={p} index={i} />
          ))}
        </div>
        <div className="intro-vs">VS</div>
        <div className="intro-col right">
          <div className={`intro-side-label ${rightName.toLowerCase()}`}>{rightName}</div>
          {right.map((p, i) => (
            <IntroCard key={p.robotId} p={p} index={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** RankedIntro / Results / RecordResults + their helpers moved to `./Results.tsx` —
 * see that file. */

