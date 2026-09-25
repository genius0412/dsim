import type {
  Alliance,
  Artifact,
  ArtifactColor,
  BallState,
  CardColor,
  ChainScoreMode,
  DrivetrainType,
  GameId,
  GameMode,
  MatchPhase,
  Motif,
  Physics,
  RobotCommand,
  RobotState,
  ScoreBreakdown,
  StartPose,
  World,
  GameSettings,
} from './types';
import * as C from './config';
import type { RobotSetup } from './sim/spawn';
import type { AutoSeatStatus, ZenithAutoSetup } from './auto/types';

/**
 * A Zenith auto handed to a solo controller: the LAZY `src/auto` module (a type-only import
 * here, so the main chunk never contains Zenith) and the file to play.
 */
export interface GameControllerZenithAuto extends ZenithAutoSetup {
  module: typeof import('./auto/zenithAutos');
  name: string;
}
import { practiceSetups } from './settings';
import { moduleFor, gameOf } from './games';
import { TutorialRunner } from './tutorial/runner';
import { markTutorialSeen } from './tutorial/flag';
import type { TutorialHintCtx, TutorialSpec, TutorialView } from './tutorial/types';
import type { GameModule } from './games';
import type { GameScene, SceneCamera, SceneFrame, SceneInsets } from './games/module';
import { getViewPref, subscribeViewPref } from './games/biobuzz/graphics/store';
import { initPhysics3d, physics3dReady, physics3dImpl, disposePhysics3dFor } from './games/biobuzz/sim3d/engine';
import { PREDICT_FULL_BUDGET_MS } from './games/biobuzz/config';
import { biobuzzPhysics } from './games/biobuzz/state';
import {
  getPredictionPref,
  markOffNoticeShown,
  offNoticeShown,
  subscribePredictionPref,
  type PredictionMode,
  type PredictionPref,
} from './net/predictionPref';
import { accelMultiplier as chainAccelMultiplier, type EndgameState } from './games/chain/state';
import { chainCatalystGeom, chainHopperCap } from './games/chain/config';
import { chainCatalystPrompt } from './games/chain/play';
import { beamRide } from './games/chain/beams';
import { robotsEnabled } from './sim/match';
import { ReplayRecorder, worldResult, type Replay, type ReplayResult } from './sim/replay';
import { MATCH_SETTLE_MAX_S, newSettleClock, settleStep } from './sim/settle';
import { practiceSaveDecision } from './replaySavePolicy';
import { readRenderStats } from './perfStats';
import { robotInLaunchZone } from './sim/robot';
import { InputManager } from './input/input';
import { effectiveBindings, type ControlBindings } from './input/bindings';
import { Renderer } from './render/renderer';
import { MatchAudio } from './audio';
import type { MatchResultInfo, NetSession, NetStatus, Snapshot } from './net/session';
import { localizeCommand } from './net/protocol';
import { clamp } from './math';
import type { RecordRankInfo } from './net/protocol';

/** online, how long after the buzzer (wall seconds) to stop waiting for the server's final score
 *  and say it never came: the longest honest settle, plus room for a slow network */
const RESULT_LOST_AFTER_S = MATCH_SETTLE_MAX_S + 10;

// GameSettings is defined canonically in ./types; re-exported here because many
// modules import it from './game'.
export type { GameSettings };

// Visual error-smoothing for the LOCAL robot on reconcile (it stays predicted for
// zero input lag; the snap correction is eased in over ~SMOOTH_HALFLIFE, or SNAPs
// past SMOOTH_MAX_DIST — a real desync, not jitter).
const SMOOTH_HALFLIFE = 0.06; // s — the offset halves every 60ms (~gone in 200ms)
const SMOOTH_MAX_DIST = 16; // in — larger corrections snap instead of floating
/**
 * The same thing for ONE ELEMENT (`ballSmooth`): the largest single reconcile CORRECTION that is
 * eased in rather than snapped. Past it the element snaps to the prediction. It was 6 in, and
 * at 200 ms RTT a predicted shot that bounced differently on the server corrected by more than
 * that often enough to read as teleporting (probe, 2026-09-24: 12 in cut the >6 in pops per
 * 3-minute run from 38 to 6). Captures and launches no longer reach this path — carried balls
 * are never predicted, and a release is handled in `displayWorld`.
 */
const BALL_SMOOTH_MAX = 12; // in
/**
 * The largest offset a SOURCE SWITCH may ease in (see `drawPredictedElements`). Much larger than
 * `BALL_SMOOTH_MAX` because it is not an error: the predicted and interpolated clocks are ~10
 * ticks apart, so a ball at 150 in/s sits 25 in apart on them. Snapping that distance was the
 * "balls keep teleporting" report (owner, 2026-09-24): measured, a shot changing clocks jumped
 * 14–25 in in one frame against 2–4 in of real motion.
 */
const BALL_SWITCH_MAX = 48; // in

// Minecraft-style entity INTERPOLATION for REMOTE robots + balls: render them a
// couple snapshots in the PAST and lerp between the two authoritative states that
// bracket the render clock — buttery smooth at any FPS regardless of tick rate.
const INTERP_DELAY_TICKS = 5; // render remotes ~5 ticks (~83ms) behind latest: one
// extra tick of cushion over the old 4 so a single 30 Hz snapshot gap (33ms) no
// longer drains the interpolation buffer and freezes/warps remotes (a stutter source)
const INTERP_BUFFER = 8; // authoritative snapshots kept for interpolation
// how fast the render clock converges on (latest - INTERP_DELAY_TICKS). Expressed as
// a HALF-LIFE so the convergence is identical at 30/60/144/240 fps; 0.11s reproduces
// what the old per-frame `* 0.1` did at exactly 60 fps, so 60 Hz feel is unchanged.
const INTERP_EASE_HALFLIFE = 0.11; // s

// PREDICTION LEAD CAP. During a snapshot stall (a ping spike / a dropped burst) the
// client keeps predicting and buffering its own inputs. Without a bound, the input
// buffer grows unboundedly and the NEXT snapshot triggers a single synchronous
// reconcile that replays hundreds of full sim steps at once — a multi-hundred-ms
// hitch that also re-simulates balls/remotes from a stale state, so everything
// "flies around" on recovery. Cap how far prediction runs ahead of the newest
// authoritative tick: past this the local robot pauses (honest "you're lagging")
// instead of building a replay bomb. ~667ms of headroom covers legitimately high
// latency; beyond it the link is unplayable anyway.
const MAX_PREDICT_LEAD = 40; // ticks

/**
 * HOW MANY RECONCILES AUTO WATCHES BEFORE IT DECIDES FULL IS TOO SLOW (plan §5's slip rule).
 *
 * Snapshots arrive at 30 Hz, so 60 of them is two seconds of evidence. Short enough that a
 * machine that cannot hold the budget is dropped early in the match rather than at the buzzer;
 * long enough that one GC pause, one tab focus change or one ad creative finishing its load
 * cannot move a p95 on its own. Auto steps down ONCE and then stops measuring — see
 * `autoDropped`.
 */
const PREDICT_SLIP_WINDOW = 60;

/**
 * The 3D predictor's shape, WITHOUT importing `sim3d/predict`.
 *
 * ⚠️ `docs/area/biobuzz.md`: only `sim3d/engine` and `sim3d/tilt` may be imported from outside
 * `sim3d/`, and the RENDER lane enforces that by GREPPING for the module name — an `import type`
 * would trip it just as a value import would, and rightly so, since the rule is about what the
 * bundler can see reaching the main chunk. So the type is derived from the loader's own
 * `physics3dImpl()` return type instead: one source of truth, zero imports.
 */
type Predictor = ReturnType<ReturnType<typeof physics3dImpl>['createLightPredictor']>;
type PredictedPose = ReturnType<Predictor['step']>;
/** one element the FULL predictor is carrying — same derivation, same no-imports reason. */
type PredictedElement = NonNullable<ReturnType<Predictor['elements']>>[number];

/**
 * IS THIS ELEMENT TAG A TELEPORT? Only the two that mean "something is CARRYING it": a hopper
 * (`held`) and a human player's hand (`stock`). Every other tag in a 3D BIOBUZZ world is
 * DERIVED from where the body already is, so a change between them is a re-description of a
 * continuous motion, never a jump. See `displayWorld`'s element block for the measurement.
 */
const isCarried = (kind: string): boolean => kind === 'held' || kind === 'stock';

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** shortest-arc angle lerp */
const lerpAngle = (a: number, b: number, t: number): number =>
  a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

export interface Toast {
  id: number;
  text: string;
  at: number; // performance.now() ms
}

/** one driver's overall-ELO change on the results screen (ranked matches only) */
export interface EloResultRow {
  robotId: number;
  name: string;
  alliance: Alliance;
  before: number;
  after: number;
  isLocal: boolean;
  /** Glicko rating deviation after the game — high ⇒ provisional rating */
  provisional: boolean;
  /** games on this board AFTER the match — the standings badge needs it to know
   *  whether the player is still in placements (see src/ranks.ts) */
  games: number;
}

/** one driver's pre-match intro card (ranked matches only) */
export interface IntroPlayer {
  robotId: number;
  name: string;
  teamName: string;
  teamNumber: number;
  drivetrain: DrivetrainType;
  alliance: Alliance;
  /** current ranked ELO, or null if unranked / signed out */
  elo: number | null;
  isLocal: boolean;
}

/**
 * A FIXED SAMPLE WINDOW that never allocates after construction.
 *
 * The frame loop pushes into three of these on EVERY frame for every player, whatever the
 * read-out is set to, so `push` has to be one typed-array write and an index bump — no
 * `Array.shift` (which is O(n) and was what the old single window did), no object per sample.
 * The sorting a percentile needs happens in `quantile`, which only the 4 Hz HUD poll calls.
 */
class PerfRing {
  private readonly buf: Float64Array;
  /** scratch for `quantile`, allocated once — sorting a copy at 4 Hz is fine, allocating one
   *  240-element array per poll per percentile is the kind of thing this class exists to avoid */
  private readonly scratch: Float64Array;
  private n = 0;
  private i = 0;
  constructor(size: number) {
    this.buf = new Float64Array(size);
    this.scratch = new Float64Array(size);
  }
  push(v: number): void {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n++;
  }
  get count(): number {
    return this.n;
  }
  mean(): number {
    if (this.n === 0) return 0;
    let sum = 0;
    for (let k = 0; k < this.n; k++) sum += this.buf[k];
    return sum / this.n;
  }
  max(): number {
    let m = 0;
    for (let k = 0; k < this.n; k++) if (this.buf[k] > m) m = this.buf[k];
    return m;
  }
  quantile(q: number): number {
    if (this.n === 0) return 0;
    const s = this.scratch.subarray(0, this.n);
    s.set(this.buf.subarray(0, this.n));
    s.sort();
    return s[Math.min(this.n - 1, Math.floor(this.n * q))];
  }
  /** oldest→newest, for a sparkline. Allocates, so it is only called at the 4 Hz poll and only
   *  when the read-out is actually drawing graphs. */
  series(max: number): number[] {
    const take = Math.min(this.n, max);
    const out: number[] = [];
    for (let k = take; k > 0; k--) out.push(this.buf[(this.i - k + this.buf.length) % this.buf.length]);
    return out;
  }
}

/** what `GameController.getPerfStats()` hands the in-match performance read-out. Every field
 * that cannot be measured on this run is null, never 0 — see the method's header. */
export interface PerfSnapshot {
  fps: number;
  /** frame PERIOD percentiles over the window, ms (the gap between presented frames) */
  p50: number;
  p95: number;
  p99: number;
  /** the single worst frame in the window, ms */
  worst: number;
  /** mean cost of one frame's fixed-timestep stepping, ms */
  simMs: number;
  /** mean sim steps per frame over the window — see `stepCounts` on why it is not the last
   *  frame's count */
  stepsPerFrame: number;
  /** mean cost of one frame's drawing (the 3D scene, if any, plus the 2D pass), ms */
  renderMs: number;
  /** which solve this world runs on */
  physics: Physics;
  /** is a 3D scene actually drawing (not merely preferred)? */
  view3d: boolean;
  /** the live 3D renderer's own counters, or null in a 2D view */
  scene: ReturnType<typeof readRenderStats>;
  /** canvas CSS size and the device pixel ratio behind it */
  width: number;
  height: number;
  dpr: number;
  /** the connection, or null in solo */
  net: NetStatus | null;
  /** how far behind the newest snapshot remotes are drawn, ms (online only) */
  interpMs: number | null;
  /** render clock vs the newest authoritative tick, in ticks (online only) */
  behindTicks: number | null;
  /** corrections applied this match (online only) */
  reconciles: number | null;
  /** the last correction's distance, inches (online only) */
  correctionIn: number | null;
  prediction: ReturnType<GameController['getPredictionStats']>;
  /** recent frame periods, oldest→newest, for the sparkline. Empty unless the caller asked —
   *  see `getPerfStats`, which only builds it for the `graphs` level. */
  frameSeries: readonly number[];
}

/** how many frame samples a sparkline draws. ~1.7 s at 60 fps: long enough to show a stutter
 * in context, short enough that one bad frame is still visible as a spike rather than a pixel. */
const PERF_SERIES_LEN = 100;

/** the ONE empty array every non-`graphs` poll hands back, so a 4 Hz poll that draws no
 * sparkline allocates nothing at all. */
const EMPTY_SERIES: readonly number[] = [];

export interface HudSnapshot {
  /** which game is being played — drives which score HUD GameView renders */
  game: GameId;
  /**
   * WHICH SOLVE THIS WORLD IS RUNNING ON (`'2d'` | `'3d'`), read off the world rather than off
   * the session so a spectator and a mid-match joiner answer it too. The in-match connection
   * panel hides the Prediction control on a 2D room, because there it would do nothing.
   */
  physics: Physics;
  /** the prediction readout for the in-match panel, or null where the setting is inert
   *  (solo, a 2D-physics room, a spectator) — see `GameController.getPredictionStats`. */
  prediction: ReturnType<GameController['getPredictionStats']>;
  /**
   * The ACTIVE game module's own HUD slice (`GameSimModule.hud`), or undefined for
   * a game that doesn't supply one.
   *
   * `unknown` on purpose: it is opaque to every shared screen and is cast back to
   * its own shape by the game's own components (the `hudChips` / `scoreBar` /
   * `resultsRows` slots). `chain` below is the pre-slot version of the same idea
   * and stays as it is — the CR HUD reads it in a dozen places.
   */
  gameHud?: unknown;
  /** Chain Reaction scoring readout (present only for CR) */
  chain?: {
    /** your alliance's particles scored (count) */
    scored: number;
    oppScored: number;
    /** your accelerator's points-per-particle (1 + catalysts on your hooks) */
    mult: number;
    oppMult: number;
    /** catalysts your alliance has seated on hooks */
    catalysts: number;
    oppCatalysts: number;
    /** particle POINTS (catalyst multiplier folded in) — for the results breakdown */
    particlePts: number;
    oppParticlePts: number;
    /** your robot's endgame status */
    endgame: EndgameState;
    /** your robot is carrying a catalyst */
    carrying: boolean;
    /** a catalyst action is available RIGHT NOW at your position (in range) */
    ringAction: 'pickup' | 'place' | 'fling' | null;
    /** your robot's ball-storage capacity (the builder slider) */
    storage: number;
    /** your robot's scoring archetype (turret shooter / dumper) */
    mode: ChainScoreMode;
    /** foul POINTS your alliance has been AWARDED (opponent's violations) */
    foulPts: number;
    oppFoulPts: number;
  };
  mode: GameMode;
  phase: MatchPhase;
  timeLeft: number;
  alliance: Alliance;
  motif: Motif;
  score: ScoreBreakdown;
  oppTotal: number;
  /** the opponent alliance's full breakdown (for the match-results screen) */
  oppScore: ScoreBreakdown;
  provisionalPattern: number;
  /** fouls committed BY each alliance (counts, for the HUD chip) */
  fouls: Record<Alliance, { minor: number; major: number }>;
  /** the CARD the local robot's team currently holds, or null. A card is issued to a TEAM
   * and a RED voids its alliance's match points, so the driver has to be able to see it. */
  card: CardColor | null;
  /** ...and whether the local alliance's score has been VOIDED by a red card, which is
   * what the score bar and the results screen have to say rather than a number. */
  voided: boolean;
  fieldCentric: boolean;
  aimAssist: boolean;
  autoIntake: boolean;
  autoFire: boolean;
  /** Chain Reaction: does the local robot's catalyst have a CATAPULT to throw with? The
   * throw is its own action, so the touch pad only shows its button on a build that
   * actually has one. False for DECODE and for claw-only catalysts. */
  catalystFling: boolean;
  hopper: ArtifactColor[];
  /** local robot's current drive power draw (0..POWER_DRAW_MAX) — flywheel
   * spin-up + intake pulling current off the drive motors; shown as the HUD gauge */
  powerDraw: number;
  inLaunchZone: boolean;
  gamepadConnected: boolean;
  /** drive controls reversed so the shooter side leads (robot-centric only) */
  frontFlipped: boolean;
  /** BUTTERFLY: which wheel set is on the floor ('tank' | 'mecanum'), or null for every
   * other drivetrain (no chip). Drives the HUD readout — the swap changes how the robot
   * handles AND whether strafe exists, so the driver has to be able to see it. */
  butterflyMode: 'tank' | 'mecanum' | null;
  /** park mode active (speed capped to parkSpeedPct); only activatable in
   * endgame / free drive, per canPark() */
  parked: boolean;
  /** can park mode be TURNED ON right now (endgame or free drive)? drives the
   * HUD hint so the driver knows why the button isn't doing anything yet */
  canPark: boolean;
  gateOpen: boolean;
  /** true when the OPPONENT is the one holding this gate open (`penalties.gateCulprit`) —
   * drives the gate icon's red "forced" state vs. green "own alliance opened it". */
  gateForced: boolean;
  rampCount: number;
  classifiedCount: number;
  overflowCount: number;
  /** pre-match "3-2-1" countdown value, or null when not counting down */
  countdown: number | null;
  /** the match's score is FINAL and the results screen may reveal it: online, the server's
   * finalized result has arrived; in solo practice, the field has settled (`src/sim/settle.ts`).
   * False before the buzzer and while the field is still settling. */
  resultFinal: boolean;
  /** online only: the match ended but the final score never arrived — the connection failed, or
   * nothing came within `RESULT_LOST_AFTER_S`. The results screen says so instead of waiting. */
  resultLost: boolean;
  toasts: Toast[];
  /** multiplayer status (null in solo): stall target + desync + connection quality */
  net: NetStatus | null;
  /** how many people are watching this match (0 when nobody is, or in solo).
   *  Hidden admin observers are excluded server-side and never reach this. */
  spectators: number;
  /** DUO RECORD rematch tally, or null when this run has no vote (solo, versus).
   *  `need > 1` is what tells the UI a vote is even in play. */
  rematch: { votes: number; need: number; mine: boolean } | null;
  /**
   * THE TUTORIAL'S CURRENT STEP CARD, or null when this run is not a tutorial.
   *
   * It rides the HUD snapshot rather than being read off the controller directly for the reason
   * every other HUD value does: `GameView` polls `getHud()` at 10 Hz and re-renders from ONE
   * object, so a card read separately would be a second source of truth that updates on a
   * different beat. The hint string is composed here, against the live bindings and the live
   * gamepad state, so a pad plugged in mid-step changes the line within 100 ms.
   */
  tutorial: TutorialView | null;
  /**
   * THE ZENITH AUTO this solo run plays, and where it is (docs/area/autos.md): the status chip
   * during AUTO, and the "Open run in Zenith" button once it has run. Null when none is playing.
   */
  auto: (AutoSeatStatus & { name: string }) | null;
}

export class GameController {
  private world: World;
  private readonly input: InputManager;
  private readonly renderer = new Renderer();
  /**
   * The renderer's driver-name lookup — one bound arrow, built once.
   *
   * It is a field rather than a literal at the call site because the call site is the rAF
   * loop: a fresh closure there is an allocation 144 times a second for a function whose
   * behaviour never changes. It reads `this.session` live, so a rematch (which re-reads
   * `drivers` on the session) needs nothing here.
   */
  private readonly driverName = (robotId: number): string | undefined =>
    this.session?.driverName?.(robotId);
  private readonly ctx: CanvasRenderingContext2D;
  private readonly audio = new MatchAudio();
  private raf = 0;
  /** re-fits the camera when the canvas resizes without the window doing so
   *  (ad columns mounting/unmounting) — see the constructor */
  private canvasObserver: ResizeObserver | null = null;
  private lastT = 0;
  private acc = 0;
  private lastCmd: RobotCommand | null = null;
  private toasts: Toast[] = [];
  private toastId = 0;
  private disposed = false;
  private prevPhase: MatchPhase;
  private warningPlayed = false;
  /** performance.now() ms when the match entered phase 'post' — WALL time, used only to give up
   * on a final score that never arrives (`resultLost`); null until the match ends */
  private matchOverAt: number | null = null;
  /**
   * The post-buzzer SETTLE CLOCK, the same one the server finalizes on (`src/sim/settle.ts`).
   * Solo practice has no server, so it decides for itself when the field has come to rest — on
   * the same per-game predicate and in TICKS, so a stuttering frame or a backgrounded tab
   * cannot shorten how much simulation the saved score sees.
   */
  private settle = newSettleClock();
  /** this match's score is final (see `HudSnapshot.resultFinal`); reset on entering `post` */
  private settleDone = false;
  /**
   * SOLO PRACTICE IS RECORDED, so it has to be REPRODUCIBLE — which it was not.
   *
   * `replay.ts` states the invariant a replay depends on: a run is fully SIM-DRIVEN
   * (preCountdown → auto → transition → teleop → post) so that no controller state leaks in
   * and `{seed, setups, commands}` alone reproduce it. Solo practice broke exactly that: the
   * countdown lived HERE (`countdownStart`, compared against `world.time`) and this controller
   * called `startMatch()` itself, while `ReplayPlayer` sets `preCountdown` and lets the sim run
   * it. The pre→auto tick therefore depended on when a key was pressed, which the container has
   * nowhere to store — so a recording would have diverged from tick 0.
   *
   * Solo now takes the multiplayer path: starting REBUILDS the world at tick 0 (invisible —
   * `robotsEnabled` is false in `pre`, so nothing has moved) with the SAME seed, and sets
   * `preCountdown` for `stepMatch` to run down. The recorder then begins at a world
   * `ReplayPlayer` can rebuild exactly.
   */
  private soloSeed = 0;
  /** the setups the current solo world was built from — the recorder needs the same array */
  private soloSetups: RobotSetup[] = [];
  /** records the solo practice run in flight; null when not recording (free drive, or
   *  multiplayer, where the SERVER owns the recording) */
  private recorder: ReplayRecorder | null = null;
  /**
   * Ticks of the run in flight on which the robots were actually ENABLED — the length
   * `src/replaySavePolicy.ts` judges an abandoned run by.
   *
   * Not the recorder's own tick count, and not wall time. The recorder opens at tick 0 of the
   * rebuilt world, `PRE_COUNTDOWN` seconds before anybody may move, so recorded ticks would
   * credit a run for a countdown nobody drove through; wall time would credit it for a paused
   * tab. `ReplayRecorder.ticks` is private and stays that way — what the policy wants is not
   * how long the log is, it is how long the driver drove.
   */
  private drivenTicks = 0;
  /** the finished solo practice run, once the match reaches `post` */
  private practice: { replay: Replay; result: ReplayResult } | null = null;
  /** fired once when a solo practice run finishes, so the app can save + upload it */
  onPracticeRun: ((replay: Replay, result: ReplayResult) => void) | null = null;
  private lastBeepAt = -1;
  private lastTransitionBeep = -1;
  private hudCountdown: number | null = null;
  /** drive controls reversed so the shooter side leads (robot-centric only) */
  private frontFlipped = false;
  /** park mode: caps drive command magnitude to settings.parkSpeedPct while on */
  private parked = false;
  // action-SFX edge trackers per robot id (seeded in seedActionAudio)
  private prevFireAt: Record<number, number> = {};
  private prevIntakeAt: Record<number, number> = {};
  private prevGateOpen: Record<Alliance, boolean> = { red: false, blue: false };
  private prevBeamOn: Record<number, number> = {}; // wheels-on-a-beam per robot (CR terrain SFX)

  /** which game this controller builds its INITIAL world for (solo: the player's
   * setting; networked: DECODE for now). Once running, the STEP/DRAW/HUD always
   * resolve the module from `this.world.game` via `this.mod` — a reconciled server
   * world carries its own game, so prediction/replay never use the wrong step. */
  private readonly gameId: GameId;
  /** the EFFECTIVE control bindings for `gameId` — see where it is assigned. */
  private readonly bindings: ControlBindings;
  /** the active game module, resolved from the CURRENT world (hot-path safe). */
  private get mod(): GameModule {
    return gameOf(this.world);
  }
  /** the local player's robot id (slot 0 in solo; assigned by the lobby in
   * multiplayer) */
  readonly localRobotId: number;
  /** read-only spectator (watching someone else's match): no local robot / input */
  private readonly spectator: boolean = false;
  /** null in solo; the server-authoritative session in multiplayer */
  private readonly session: NetSession | null;
  /** multiplayer sim-step timer (survives tab backgrounding); 0 = solo */
  private simTimer = 0;
  private lastSimT = 0;
  /** predict/reconcile input buffer: local commands not yet folded into a server
   * snapshot, replayed forward after each reconcile (keyed by the tick produced) */
  private inputBuf: { tick: number; cmd: RobotCommand }[] = [];
  /** VISUAL-only offset for the local robot, set on each reconcile so a snapshot
   * correction is eased in (render loop decays it) instead of snapping — hides
   * rubberbanding from jittery snapshots. Never affects `this.world`. */
  private localSmooth = { x: 0, y: 0, heading: 0 };
  /**
   * ⚠️ **THE ELEMENTS' OWN `localSmooth` — AND THE BUG IT EXISTS FOR IS THE ONE PEOPLE REPORT
   * AS "the balls behave really weirdly in a server game".**
   *
   * In a predicted 3D room the LOCAL ROBOT is drawn from the prediction, which sits at (about)
   * the newest server tick, while every element is drawn INTERPOLATED, which sits
   * `INTERP_DELAY_TICKS` behind it. Those are two different moments in one frame, and the gap
   * does not depend on the network at all: measured through a real `Room` at 0, 60 and 140 ms
   * RTT alike, an element was drawn **p95 8.65 in / max 8.9 in** closer to the local robot than
   * the server had it, so a POLLEN the driver was pushing sat inside their own chassis and a
   * shot leaving the field crossed it a tenth of a second late. Turning prediction OFF — which
   * draws the local robot interpolated too, at the SAME clock as the elements — took the same
   * measurement to **p95 0.01 in**, which is the whole bisect: the clocks, not the physics.
   *
   * The fix does not change either clock. The FULL predictor has always carried the near
   * elements as real dynamic bodies and pushed them with the predicted chassis, and has always
   * thrown the answer away; `displayWorld` now DRAWS them, so the robot and the things it is
   * touching are one moment again (p95 0.99 in). These three maps are the continuity machinery:
   * the offset per element, what it was last DRAWN at, and whether that drawing came from the
   * prediction — so a re-seat, or an element crossing in or out of the predictor's radius, eases
   * over `SMOOTH_HALFLIFE` instead of popping. Purely cosmetic, exactly like `localSmooth`:
   * nothing here touches `this.world`, the server still owns every element, and a LIGHT
   * predictor (which carries no elements) is unaffected.
   */
  private ballSmooth = new Map<number, { x: number; y: number; z: number }>();
  private ballDrawn = new Map<number, { x: number; y: number; z: number }>();
  private ballPredicted = new Set<number>();
  /** set by the UI for a RECORD run: the restart binding asks for a whole new run
   * (session teardown + fresh room) instead of an in-place rebuild. Null elsewhere,
   * which is what keeps the binding inert in a versus match. */
  private restartRequestCb: (() => void) | null = null;
  /** duo-record run: restarting is a mutual VOTE, never one driver's decision */
  /** last vote count we played a cue for — a vote landing is the thing worth
   *  hearing, and only when the number actually moved */
  private lastRematchVotes = 0;
  /**
   * Authoritative poses per received snapshot, for interpolating between snapshots. Captured
   * BEFORE reconcile mutates the snapshot world.
   *
   * ── WHY `balls` IS HERE FOR 3D-PHYSICS WORLDS AND NOT FOR 2D ONES ─────────
   * The 2D rule stands and is written down in `docs/area/netcode.md`: DECODE's and Chain
   * Reaction's artifacts SPAWN AND DESPAWN (a launch mints one, a capture removes one), so
   * lerping them ghost-clones a fresh ball between its predicted position and a past one it
   * never occupied, and blends two colliding balls through each other. Predicted balls are
   * more accurate than interpolated ones there, so they are rendered straight from the sim.
   *
   * A BIOBUZZ 3D-physics world has neither property. Its 56 elements are created once at
   * spawn and never destroyed — a captured element becomes `held` and a stocked one becomes
   * `stock`, both of which keep the id and only change `state.kind` — so the id set is stable
   * and the count is conserved BY CONSTRUCTION, not by luck. What is left is a body whose
   * position moves continuously between two snapshots, which is exactly the thing
   * interpolation is for, and at 30 Hz the difference is visible: an element rolling across
   * the tiles steps twice as coarsely as the robot pushing it.
   *
   * A `kind` change still SNAPS rather than lerps (see `displayWorld`): an element going into
   * or out of a hopper teleports in the sim, and easing it there would draw it travelling
   * through the chassis.
   *
   * `z` rides both halves for the same reason the wire carries it: in a 3D world the height
   * is a real degree of freedom, and interpolating x and y while snapping z produces a body
   * that glides horizontally and stutters vertically.
   */
  private snapBuf: {
    tick: number;
    robots: { id: number; x: number; y: number; z: number; heading: number }[];
    /** element poses + their `state.kind`, only for a 3D-physics world (empty otherwise, so
     *  a 2D room allocates nothing it did not allocate before) */
    balls: { id: number; x: number; y: number; z: number; kind: string; state: BallState }[];
  }[] = [];
  /** the interpolation render clock (in server ticks), lagging the latest snapshot
   * by ~INTERP_DELAY_TICKS; eased forward each frame for smooth playback */
  private renderTick = 0;
  /** each remote robot's latest command (from the newest snapshot), held to
   * PREDICT it forward so its collisions are simulated, not faked */
  private remoteCmds = new Map<number, RobotCommand>();
  /** newest authoritative tick reconciled to; prediction is capped MAX_PREDICT_LEAD
   * ticks past it so a snapshot stall can't build an unbounded replay buffer */
  private lastServerTick = 0;
  /** MULTIPLAYER event feed. `world.events` rides in every snapshot and the server
   * appends to it without clearing (a monotonic per-match log), so the SAME event
   * arrives in snapshot after snapshot — and the local predict/reconcile re-runs the
   * phase machine, re-emitting transition events speculatively. Surfacing `world.events`
   * directly therefore showed each event ~5× (the `slice(-5)` toast cap). Instead we
   * track how many authoritative events we've already shown and queue only the NEW tail
   * from each snapshot (prediction events are ignored). Solo is unaffected (it drains
   * `world.events` straight, once per frame). */
  private shownEventCount = 0;
  private netEvents: string[] = [];
  /** true once the first snapshot has arrived — the lead cap only applies after that
   * (before it, the sim-driven pre-match countdown must predict freely from tick 0) */
  private gotSnapshot = false;

  // ------------------------------------------------------- CLIENT PREDICTION (plan §5) --
  //
  // ⚠️ EVERYTHING IN THIS BLOCK IS INERT UNLESS `predicted3d()` IS TRUE. A 2D-physics room —
  // every DECODE room, every Chain Reaction room, every BIOBUZZ room an older server hosts —
  // reconciles by replaying `mod.step`, exactly as it always has. The owner's rule that the 2D
  // pipeline is permanent applies to the netcode half as much as to the sim half, and `npm test`
  // pins the 2D hashes either way.
  //
  // WHAT CHANGES IN A 3D ROOM: the client stops stepping the WORLD at all. The world is the
  // authoritative one and advances only when a snapshot lands; the LOCAL ROBOT advances every
  // tick through a predictor and its pose is written back onto that world. Everything else on
  // screen — remote robots, the 56 elements — is already interpolated from `snapBuf` there (see
  // its header), so nothing was relying on the client's own forward step to animate it. That is
  // what makes `step3d` a cost the client never pays in a room, and it is why the reconcile
  // budget is 8 ms rather than the ~10 ms forty `step3d` calls measure.

  /** the player's stored pick. `'auto'` until they choose otherwise; never overridden. */
  private predictionPref: PredictionPref = 'auto';
  /** what is actually RUNNING — `auto` resolved by the countdown probe, or by the slip rule. */
  private predictionMode: PredictionMode = 'light';
  /** the live predictor, or null (2D room, spectator, Off, or the chunk is not in hand yet). */
  private predictor: Predictor | null = null;
  /** which kind `this.predictor` is, so a mode change rebuilds and a repeat does not. */
  private predictorKind: PredictionMode | null = null;
  /** Auto has run its one probe for this match. */
  private autoProbed = false;
  /** what that probe measured, in ms — shown in the in-match panel, null before it runs. */
  private autoProbeMs: number | null = null;
  /** Auto has already stepped Full down to Light once. It does not step back up: a machine
   *  that missed the budget under load will miss it again, and flapping is worse than Light. */
  private autoDropped = false;
  /** recent reconcile costs in ms (Full only), the window the slip rule takes a p95 over. */
  private reconcileMs: number[] = [];
  /**
   * THE INPUT CLOCK IN A PREDICTED 3D ROOM.
   *
   * `world.tick` is the input clock everywhere else, because the world IS stepped forward there.
   * In a 3D room it is not — the world sits at `lastServerTick` between snapshots — so the tick
   * an input is stamped with, the lead cap, and the buffer's cut-off all read this instead. It
   * is reset to `serverTick` by every reconcile and advanced one per predicted tick, which is
   * exactly what `world.tick` does in the 2D path.
   */
  private predictTick = 0;
  /** the last reconcile's correction distance in inches (before the SNAP clamp) — the number
   *  the in-match panel prints and the one a verification run reads. */
  private lastCorrection = 0;
  /** the last reconcile's cost in ms, Full or Light. */
  private lastReconcileMs = 0;
  private unsubscribePredictionPref: () => void = () => {};

  // ─────────────────────────────────────────────────── SOLO PRACTICE BOTS (plan §6) --
  //
  // The client's half of the bot contract, and the mirror of `Room`'s: the seats are built when
  // the world is, stepped once per tick BEFORE the sim step, and their commands go into the
  // SAME map the recorder is handed — so a practice run against bots re-simulates from its log
  // without needing a bot at all, exactly as a server match does (`docs/area/netcode.md`: "the
  // recorder records every setup's command").
  //
  // ⚠️ **THE MEMORY IS THE CALLER'S, NEVER THE WORLD'S** (`BotSeat`'s own header). A bot field
  // on `World` would be snapshotted, reconciled and replayed; these live here, are disposed on
  // every rebuild, and nothing downstream knows they exist.

  /** live AI drivers for the solo world, keyed by robot id. Empty online, and
   *  while no practice seat is AI — which is the default. */
  private readonly bots = new Map<number, { step(w: World): RobotCommand; dispose?(): void }>();
  /**
   * THE ZENITH AUTO, when this solo run plays one (docs/area/autos.md): the lazy `src/auto`
   * module `GameView` loaded for it, the file, and the seat driving the LOCAL robot. The seat is
   * the bots' contract to the letter: stepped once per tick before the step, into the map the
   * recorder is handed, through `localizeCommand` — so a replay needs no seat. Rebuilt with every
   * world (`makeWorld`), like the bots. Solo only: a room, a record run and the tutorial never
   * get one (a room's auto is the server's job, and not built yet).
   */
  private readonly zenithAuto: GameControllerZenithAuto | null;
  private autoSeat: import('./auto/zenithAutos').AutoSeat | null = null;
  /**
   * THE TUTORIAL IN FLIGHT, or null — which is every other run this controller has ever done.
   *
   * Set from the constructor's `tutorial` option, and it is the ONE thing that makes this a
   * tutorial: there is no `GameSettings.tutorial` flag. That was the alternative, and it is
   * wrong for a reason the settings file states about itself — `GameSettings` persists to
   * localStorage and SYNCS TO POSTGRES per account, so a transient "I am in the tutorial right
   * now" bit would follow the account to another machine and survive a reload into a screen that
   * has no idea what step it was on. A run is not a preference.
   *
   * It is also why the tutorial does not survive a refresh, which is the honest behaviour: the
   * staged world it was on cannot be rebuilt from a URL.
   */
  private tutorial: TutorialRunner | null = null;
  /** told to the view (GameView's loading panel) whenever `physicsPending` flips. */
  private readonly onPhysicsPending: ((pending: boolean) => void) | null;
  /** told to the view whenever `sceneLoading` flips — the same panel, for the renderer. */
  private readonly onSceneLoading: ((loading: boolean) => void) | null;

  /**
   * THE 3D PHYSICS CHUNK IS STILL LOADING, SO NOTHING MAY BE STEPPED YET.
   *
   * A `'3d'`-physics world routes into `step3d` on its very first tick, and `physics3d()`
   * THROWS if `initPhysics3d()` has not resolved — so a controller built for a 3D room before
   * the wasm lands would take the whole render loop down on frame one.
   *
   * ── WHY THE LATCH IS HERE AND NOT AT THE SCREEN THAT OPENS THE MATCH ──────
   * Solo practice can await the load before constructing anything, and `GameView` does
   * exactly that (Day 1). A ROOM cannot: `matchStart` arrives on a socket, a `ServerSession`
   * is built from it synchronously, and there are six places in the UI that do so — a lobby,
   * three matchmaking paths, a record run, a spectate, and the rejoin that resumes a match
   * after a reload. Gating each of them is six chances to miss one, and the one that would be
   * missed is the rejoin, because it is the only path where the player is already mid-match.
   *
   * So the controller gates ITSELF. While this is true `stepServer` and `stepSolo` return
   * without stepping and without reconciling, the accumulator is drained so nothing
   * burst-catches-up when it clears, and the first snapshot after the load simply snaps the
   * world to the server's. The cost is that the local view holds at tick 0 for the length of
   * the load, which against a warm cache is a frame or two.
   */
  private physicsPending = false;

  // ---------------------------------------------------------------- 3D scene (Day 1 seam) --
  //
  // `docs/biobuzz/plan-3d.md` §4.1/§4.7. A game with no `scene` (DECODE, Chain Reaction, and
  // BIOBUZZ until Lane B lands one) or a controller built with no `sceneHost` never loads
  // anything past these fields staying null — see `syncScene`.

  /** the element the 3D scene mounts its own canvas into — one box shared with the 2D
   * canvas (GameView's `.game-viewport`). Null for every caller that hasn't been wired
   * for one (every call site before this seam, and a replay/spectate screen today). */
  private readonly sceneHost: HTMLElement | null;
  /** the live 3D scene, or null on the 2D view / no scene module / a failed load. Owned
   * entirely by this controller — created and disposed here, never by GameView. */
  private scene: GameScene | null = null;
  /**
   * A 3D SCENE IS WANTED AND STILL LOADING (the Three.js chunk, then the factory's own assets).
   *
   * The 2D pass used to draw the whole field for the length of that load, so a 3D match opened
   * on a flash of the 2D render. While this is true the 2D canvas is left blank and the view
   * shows its loading panel instead. Solo also holds stepping, like `physicsPending`, so a
   * practice countdown does not run behind the panel; a room keeps following the server.
   *
   * FIRST LOAD ONLY (`sceneEverShown`). A player who switches 2D → 3D mid-match keeps the 2D
   * view they were driving on until the scene lands, rather than a blank screen over a live match.
   */
  private sceneLoading = false;
  private sceneEverShown = false;
  /** bumped on every teardown so a `factory()`/`render()` that resolves AFTER the view
   * has switched away, or after a second load started (rapid toggling), is dropped
   * instead of replacing the scene the current state actually wants. */
  private sceneEpoch = 0;
  private unsubscribeViewPref: () => void = () => {};
  /** read every render frame — cached so a 3D scene's camera pick doesn't construct a
   * fresh `MediaQueryList` up to 144 times a second (`useCoarsePointer`'s complaint about
   * the old per-render `matchMedia()` calls, at render-loop frequency instead of 10 Hz). */
  private mqCoarse: MediaQueryList | null = null;

  // ------------------------------------------------------------ HUD-SAFE CAMERA FRAMING --
  //
  // The 3D canvas fills the WHOLE `.game-viewport`, and every piece of HUD chrome is
  // absolutely positioned over it — so a camera fitted to the canvas frames the field's far
  // edge underneath the score bar. Owner's re-test, 2026-09-18: "make sure that the scoreboard
  // and the field can both fit in the screen without overlap." These four numbers (CSS px) are
  // what the scene fits into instead; see `refreshHudInsets` for how they are measured and
  // `SceneInsets` in `games/module.ts` for the contract.
  //
  // The 2D path needs nothing here: `Camera.configure` has always reserved its own top/bottom
  // bands (`HUD_TOP` / `HUD_BOTTOM` in `render/camera.ts`) and letterboxes the field inside
  // them. This is the same idea, MEASURED rather than hardcoded, because a 3D camera has to
  // solve a pitch and an FOV against it rather than just scale a square.

  /** the element the HUD's own chrome is mounted in (GameView's `.game-root`) — the subtree
   * `[data-hud-band]` is queried from. Null ⇒ no measurement, insets stay zero. */
  private readonly hudHost: HTMLElement | null;
  /** the live bands. ONE object, mutated in place and handed to the scene every frame —
   * `SceneFrame.insets` documents that a scene must not retain it. */
  private readonly hudInsets: SceneInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** set by the observers below (and by `onResize`), cleared by `refreshHudInsets`. The
   * measurement is a DOM read, so it happens at most once per rendered frame and only when
   * something has actually moved — never unconditionally per frame. */
  private hudInsetsDirty = true;
  /**
   * THE LAYOUT THESE INSETS BELONG TO — `"<width>x<height>"` of the render surface, or null to
   * start fresh. Within one layout the insets only ever GROW (see `refreshHudInsets`); a resize
   * or a view switch clears this and the next measurement starts from zero.
   */
  private hudInsetsEpoch: string | null = null;
  /** fires when a HUD band changes SIZE (a chip row wrapping to a second line, the scorebar
   * switching to its compact layout) without anything mounting or unmounting. */
  private hudBandObserver: ResizeObserver | null = null;
  /** fires when a band MOUNTS or UNMOUNTS (the scorebar appears with the first HUD poll, the
   * chip row is suppressed on a coarse pointer, a game's `scoreBar` slot swaps in). */
  private hudBandMutations: MutationObserver | null = null;
  /** what `hudBandObserver` currently watches, so the set can be reconciled rather than torn
   * down and rebuilt on every measurement. */
  private readonly observedBands = new Set<Element>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private settings: GameSettings,
    session: NetSession | null = null,
    opts?: {
      /** the element the 3D scene mounts into — GameView's `.game-viewport`, which
       * already contains the 2D canvas at the same box. Absent ⇒ never load a scene,
       * whatever the view preference says. */
      sceneHost?: HTMLElement;
      /**
       * The element the HUD chrome is mounted in — GameView's `.game-root`, the containing
       * block every absolutely-positioned overlay is laid out against. Every band inside it
       * carries `data-hud-band`; `refreshHudInsets` measures those against `sceneHost` and
       * hands the result to the 3D scene as `SceneFrame.insets`.
       *
       * Absent ⇒ no measurement and no insets, which is every call site that has not been
       * wired for one. A scene then fits to the whole canvas, exactly as before.
       */
      hudHost?: HTMLElement;
      /**
       * A ONE-LINE EVENT pushed into the freshly built world (Day 1 seam): GameView
       * awaits `initPhysics3d()` before constructing a 3D solo practice and passes this
       * when that load REJECTED, so the run falls back to 2D physics for the session —
       * announced through the existing toast/event-log path (`world.events` →
       * `HudSnapshot.toasts`), the one `docs/area/ui.md` allows ("no popup toasts over
       * the field" — the muted left-edge log is exactly that path, not a new surface).
       */
      physicsFallbackNotice?: string;
      /**
       * THE 3D PHYSICS CHUNK IS LOADING — show (or hide) the "Loading 3D physics" panel.
       *
       * `GameView` can decide this for itself in SOLO practice: it awaits `initPhysics3d()`
       * before it constructs anything. It cannot for a ROOM, and the `physicsPending` header
       * says why — six UI paths build a `ServerSession` synchronously from a `matchStart` that
       * arrived on a socket, so the controller is the only place that knows. So the controller
       * TELLS the view, at construction and again when the load settles, instead of the view
       * guessing.
       *
       * Called synchronously from the constructor when the latch starts true, which is safe:
       * `GameView` builds the controller inside an async `boot()`, never during a render.
       */
      onPhysicsPending?: (pending: boolean) => void;
      /** the 3D VIEW is loading (see `sceneLoading`). Same calling rules as `onPhysicsPending`. */
      onSceneLoading?: (loading: boolean) => void;
      /**
       * RUN THE TUTORIAL (roadmap item 6) — this game's `GameModule.tutorial`, handed in by
       * `GameView` so the controller never has to decide whether a run is a lesson.
       *
       * The caller is expected to have put `settings` into FREE DRIVE with no dummies and no
       * bots; `src/games/biobuzz/tutorial.ts` explains why free drive is the right mode (no
       * countdown, no fouls outside the played periods, and no recorder — so a staged world
       * cannot be filed as a replay that would play back something else).
       */
      tutorial?: TutorialSpec;
      /** a Zenith auto for the local robot to play in AUTO (solo only; see `zenithAuto`) */
      zenithAuto?: GameControllerZenithAuto;
    },
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.session = session;
    this.sceneHost = opts?.sceneHost ?? null;
    this.hudHost = opts?.hudHost ?? null;
    this.onPhysicsPending = opts?.onPhysicsPending ?? null;
    this.onSceneLoading = opts?.onSceneLoading ?? null;
    // which game this controller builds its INITIAL world for. A networked
    // session's game is authoritative (from matchStart); solo uses the setting.
    // Once running, STEP/DRAW/HUD resolve from this.world.game (this.mod).
    this.gameId = session ? session.game : settings.game;
    this.localRobotId = session ? session.localRobotId : 0;
    // read-only spectator: no local robot, no input — every robot renders from snapshots
    this.spectator = session?.spectator ?? false;
    this.audio.masterVolume = settings.audio.volume.master;
    this.audio.gameVolume = settings.audio.volume.game;
    this.audio.shootVolume = settings.audio.volume.shoot;
    this.audio.intakeVolume = settings.audio.volume.intake;
    this.audio.gateVolume = settings.audio.volume.gate;
    this.audio.beepVolume = settings.audio.volume.beep;
    this.audio.alertVolume = settings.audio.volume.alert;
    this.audio.voiceVolume = settings.audio.volume.voice;
    /**
     * THE BINDINGS FOR THIS GAME, not the player's whole map.
     *
     * `settings.bindings` is the MAIN setting plus every season's overrides; what a match plays
     * on is `effectiveBindings(main, game)` — this season's overrides applied, and the actions
     * this season does not use emptied so they can neither fire nor (on a pad) mask and consume
     * inside the chord resolver, which reads a `PadBindings` and has no idea what a game is.
     *
     * Resolved ONCE, here, because `this.gameId` is fixed for a controller's life (a networked
     * session's game is authoritative; solo takes the setting) and so is `settings.bindings` —
     * the Controls screen is not reachable mid-match. Everything in this file that drives or
     * NAMES a control reads this field, never `this.settings.bindings`.
     */
    this.bindings = effectiveBindings(settings.bindings, this.gameId);
    this.input = new InputManager(this.bindings);

    // NO mobile assist override. A touch device used to have autoFire/autoIntake FORCED on
    // here, which dates from before every assist defaulted on and before they lived on the
    // robot — it silently threw away a preference the player had set. It also made the touch
    // pad's INTAKE and SHOOT buttons unreachable, since those are hidden precisely when the
    // robot is doing that job itself: a mobile player could never get either button back.
    // Mobile still STARTS with the assists on, because everyone does (`PLAYER_ASSISTS`).

    // BEFORE the first `makeWorld`, which is what stages step 1: the runner resolves its step
    // list against THIS robot's spec (`TutorialStep.applies`), so a build that cannot do a step
    // is never asked to. A networked session is never a tutorial — there is nothing to stage a
    // step onto but an authoritative world somebody else owns.
    if (opts?.tutorial && !session) {
      this.tutorial = new TutorialRunner(opts.tutorial, settings.spec);
    }
    this.zenithAuto = opts?.zenithAuto && !session && !this.tutorial ? opts.zenithAuto : null;
    this.world = this.makeWorld();
    // the physics-3d fallback notice (see the constructor's `opts` doc) rides the same
    // path as every other match event — the first `frameLogic()` drains it into a toast.
    if (opts?.physicsFallbackNotice) this.world.events.push(opts.physicsFallbackNotice);
    /**
     * A 3D ROOM WHOSE PHYSICS IS NOT LOADED YET: latch, load, and step nothing meanwhile.
     *
     * `interp3d()` reads the world that was just built, so this covers every route a 3D world
     * can arrive by — `matchStart.physics`, a rejoin's stored handshake, and a solo practice
     * whose `GameView` await was skipped or failed. Idempotent: a second match in the same tab
     * finds `physics3dReady()` already true and never enters the branch at all.
     *
     * A REJECTED load is not retried. It means the chunk is unreachable (offline, or a stale
     * build whose asset 404s), and retrying on a timer would spin while the player watches a
     * frozen field; the event-log line says what happened, and the connection HUD already says
     * the rest.
     */
    if (this.interp3d() && !physics3dReady()) {
      this.setPhysicsPending(true);
      // ⚠️ BOTH CONTINUATIONS CHECK `disposed`. The chunk is ~1.12 MB gz and the await can
      // easily outlive the controller — a player who leaves a room while it is still in flight.
      // `setPhysicsPending` calls back into a view that has unmounted (a React state write on a
      // dead component), and the failure branch pushes an event onto a world nobody will ever
      // drain, which then holds that world alive through the closure.
      void initPhysics3d().then(
        () => {
          if (this.disposed) return;
          this.setPhysicsPending(false);
        },
        (err: unknown) => {
          if (this.disposed) return;
          this.setPhysicsPending(false);
          // eslint-disable-next-line no-console
          console.warn('BIOBUZZ 3D physics failed to load for this match.', err);
          this.world.events.push('Couldn’t load 3D physics — reload the page to rejoin this match.');
        },
      );
    }
    // PREDICTION (plan §5). Read once here and again on every change made anywhere in this tab
    // (Controls, the in-match connection panel), exactly like the view preference above. Inert
    // for a 2D room and for a spectator — see `predicted3d`.
    this.resolvePredictionPref(getPredictionPref(), true);
    this.unsubscribePredictionPref = subscribePredictionPref((p) => this.resolvePredictionPref(p, false));
    this.prevPhase = this.world.match.phase;
    this.seedActionAudio();
    session?.onRestart(() => this.rebuildFromNet());
    this.input.attach();
    window.addEventListener('resize', this.onResize);
    // The window `resize` event is not enough on its own: the ad columns flanking
    // the field appear and disappear WITHOUT the window changing size (the supporter
    // entitlement resolves asynchronously after sign-in, and an ad blocker can
    // collapse a column at any moment). Either changes the canvas's client width
    // while the viewport is untouched, and without this observer the camera would
    // keep its stale fit and render the field stretched until the user resized.
    if (typeof ResizeObserver === 'function') {
      this.canvasObserver = new ResizeObserver(() => this.onResize());
      this.canvasObserver.observe(this.canvas);
    }
    this.mqCoarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
    // HUD-SAFE FRAMING: two observers, because a band changes in two unrelated ways and
    // neither event implies the other. A `ResizeObserver` catches a band that changes SIZE in
    // place (the chip row wrapping, the compact scorebar); a `MutationObserver` on the HUD
    // subtree catches one MOUNTING or unmounting (the scorebar arrives with the first 10 Hz
    // HUD poll, ~100 ms after this constructor runs, and would otherwise never be measured).
    // Both only set a dirty flag — the DOM read itself happens once, in the render loop.
    if (this.hudHost) {
      if (typeof ResizeObserver === 'function') {
        this.hudBandObserver = new ResizeObserver(() => {
          this.hudInsetsDirty = true;
        });
      }
      if (typeof MutationObserver === 'function') {
        this.hudBandMutations = new MutationObserver(() => {
          this.hudInsetsDirty = true;
        });
        // `childList` + `subtree` ONLY — deliberately not `characterData`, which the timer
        // digits and every score change would fire several times a second for a band whose
        // BOX never moves (the panels are min-width'd and tabular-nums). `attributeFilter` is
        // likewise left off: a class flip that actually changes a band's size shows up on the
        // ResizeObserver above, which is the cheaper of the two signals.
        this.hudBandMutations.observe(this.hudHost, { childList: true, subtree: true });
      }
    }
    this.onResize();
    // BIOBUZZ 3D SEAM: pick up the device's current view preference now, and again on
    // every change (a live switch from Configure or a future in-match toggle) — see
    // `syncScene`. A no-op whenever `this.mod.scene` or `sceneHost` is absent.
    this.unsubscribeViewPref = subscribeViewPref(() => this.syncScene());
    this.syncScene();
    // Multiplayer must keep simulating + producing inputs even when the tab is
    // unfocused (else every peer stalls waiting on it), so drive the sim from a
    // timer (+ audio keepalive to defeat background throttling) and use rAF for
    // RENDER only. Solo stays on the plain rAF loop.
    if (session) {
      this.audio.startKeepAlive();
      this.lastSimT = performance.now();
      this.simTimer = window.setInterval(this.simStep, 1000 * C.SIM_DT);
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  /** expose input manager for mobile controls */
  getInputManager() {
    return this.input;
  }

  private localRobot() {
    return this.world.robots.find((r) => r.id === this.localRobotId) ?? this.world.robots[0];
  }

  /** the alliance whose viewpoint the camera + HUD use — the LOCAL robot's
   * alliance (in multiplayer this is the lobby pick, which can differ from the
   * menu's settings.alliance; in solo they are the same) */
  private viewAlliance(): Alliance {
    return this.localRobot().alliance;
  }

  /**
   * ⚠️ **REPLACE `this.world`, AND FREE THE OUTGOING WORLD'S RAPIER 3D SOLVE.**
   *
   * A 3D BIOBUZZ world owns a wasm world, held in a `WeakMap` keyed on the `World` object
   * (`sim3d/engineImpl.ts`). Dropping the `World` drops the map ENTRY and the only handle on
   * that wasm world — it does not free it, and wasm linear memory never shrinks, so every
   * restart, every step change and (for a spectator, whose path steps each snapshot's world)
   * every snapshot would hold another one for the life of the tab.
   *
   * `disposePhysics3dFor` is the LIGHT gate, so this is a no-op for a 2D world and for a build
   * that never loaded the physics chunk. That is what lets this sit on the one path every world
   * swap goes through instead of on the three that remembered to ask.
   */
  private adoptWorld(next: World): void {
    const prev = this.world;
    if (prev && prev !== next) disposePhysics3dFor(prev);
    this.world = next;
  }

  private makeWorld(reseed = true): World {
    // multiplayer: everyone builds the identical world the host authored and
    // runs a SIM-DRIVEN countdown (transition lives in stepMatch, so it fires
    // on the same tick for every peer — no controller-local start/seed)
    const build = moduleFor(this.gameId).createWorld;
    if (this.session) {
      // THE ROOM'S physics, from `matchStart` — never `settings.practicePhysics`. The room is
      // authoritative over which pipeline is being stepped, and a client that built its
      // predicted world from its own Practice pick would be corrected on every snapshot by a
      // server running a different game. Absent on the session ⇒ '2d', which is every room an
      // older server hosts.
      const w = build('match', this.session.seed, this.session.setups, this.settings, this.session.physics);
      w.match.preCountdown = C.PRE_COUNTDOWN;
      return w;
    }
    // REUSE the seed on a rebuild (`reseed: false`). Starting a solo practice match rebuilds
    // the world so the recording begins at tick 0, and a new motif/ball layout appearing the
    // instant you press START would be a visible change to a mode that just looks like it is
    // waiting. `restart()` passes reseed: true, which is where a fresh field belongs.
    const seed = reseed || !this.soloSeed
      ? (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0
      : this.soloSeed;
    this.soloSeed = seed;
    const s = this.settings;
    const setups: RobotSetup[] = [
      {
        id: 0,
        alliance: s.alliance,
        spec: s.spec,
        assists: s.assists,
        startIndex: s.startIndex,
        startPose: s.startPose ?? undefined,
        // no `.pp` path: that import is gone (owner, 2026-09-25). Autos are Zenith files, below.
      },
    ];
    // THE ZENITH AUTO seats the robot where the file starts, which is what a team does at the
    // field. The start is still the game's to snap legal (`coerceSetup`), so an illegal start in
    // the file is moved and the follower drives from where the robot really is.
    const za = this.zenithAuto;
    const autoStart = za ? this.zenithAutoStart(za, s) : null;
    if (za) {
      setups[0].zenithAuto = { auto: za.auto, ...(za.waypoints ? { waypoints: za.waypoints } : {}) };
      if (autoStart) setups[0].startPose = autoStart;
    }
    // THE PRACTICE SEATS — partner, opponent 1, opponent 2 — in Solo practice AND Free drive
    // (`practiceSetups`, DOM-free so `npm test` holds the line-up it builds)
    const { setups: others, botTiers } = practiceSetups(s, this.gameId, seed);
    setups.push(...others);
    this.soloSetups = setups;
    const world = build(s.mode, seed, setups, this.settings);
    this.seatBots(world, seed, botTiers);
    this.seatAuto(world);
    /**
     * THE TUTORIAL STAGES ITS STEP HERE, AND NOWHERE ELSE — tick 0, on a world nothing has
     * stepped, before the recorder could exist.
     *
     * That placement IS the replay invariant (`docs/area/netcode.md`, and
     * `src/tutorial/types.ts` restates it): a run has to be reproducible from
     * `{seed, setups, commands}`, so a step cannot reach into a world that is already running.
     * Every step change goes back through this function, which is the same rebuild
     * `startMatch` and `restart` do.
     */
    this.tutorial?.stage(world, this.localRobotId);
    return world;
  }

  /**
   * SEAT (or clear) the solo AI drivers for a freshly built world.
   *
   * Seeded `(matchSeed, seat)` exactly as `Room` seeds its own, with the same mix, so a practice
   * run and a room run of the same seed put the same driver on the same robot. Called from
   * `makeWorld` and nowhere else, which is the one place a world is replaced — so a rebuild can
   * never leave a driver pointed at a world that no longer exists.
   */
  private seatBots(world: World, seed: number, tiers: ReadonlyMap<number, string>): void {
    for (const b of this.bots.values()) {
      try {
        b.dispose?.();
      } catch {
        /* a policy that throws disposing must not take the match down with it */
      }
    }
    this.bots.clear();
    const drv = moduleFor(this.gameId).bot;
    if (!drv) return;
    for (const r of world.robots) {
      const tier = tiers.get(r.id);
      if (tier === undefined || r.id === this.localRobotId) continue;
      this.bots.set(r.id, drv.create(world, r.id, tier, (seed ^ ((r.id + 1) * 0x9e3779b1)) >>> 0));
    }
  }

  /** The canonical start pose that seats the local robot where the auto begins, or null. */
  private zenithAutoStart(za: GameControllerZenithAuto, s: GameSettings): StartPose | null {
    const adapter = za.module.autoAdapterFor(this.gameId);
    if (!adapter) return null;
    try {
      const loaded = za.module.loadZenithAuto(za, s.alliance, s.spec, adapter);
      return za.module.autoStartPose(loaded, s.alliance, adapter);
    } catch {
      return null; // the seat reports the load error; the robot keeps its own start
    }
  }

  /**
   * SEAT (or clear) the local robot's Zenith auto for a freshly built world — called from
   * `makeWorld` beside `seatBots`, so a rebuild never leaves a seat on a dead world. In FREE
   * DRIVE the seat is ARMED at once: the auto plays one period from its start, then hands the
   * robot back, and Restart plays it again.
   */
  private seatAuto(world: World): void {
    this.autoSeat?.dispose();
    this.autoSeat = null;
    const za = this.zenithAuto;
    if (!za) return;
    const adapter = za.module.autoAdapterFor(this.gameId);
    if (!adapter) return;
    const seat = za.module.createAutoSeat(world, this.localRobotId, za, adapter);
    if (world.match.phase === 'freeplay') seat.arm();
    this.autoSeat = seat;
    // a file that cannot run says so in the event log, and the driver keeps the robot
    const st = seat.status();
    if (st.state === 'error') world.events.push(`AUTO OFF: ${st.error ?? 'the auto could not be loaded'}`);
  }

  /** the planned path of this run's auto, planned for the robot's alliance, cached per seat */
  private zenithLegs: { seat: unknown; legs: { x: number; y: number }[][] } | null = null;

  /**
   * SHOW THE AUTO'S PLAN on the field while it matters: before the match starts, through AUTO,
   * and while a Free Drive trial runs. From TELEOP on it is gone, so it never clutters driving.
   */
  private syncZenithPath(world: World): void {
    const seat = this.autoSeat;
    const za = this.zenithAuto;
    if (!seat || !za || !seat.loaded) {
      this.renderer.setZenithPath(null);
      return;
    }
    const phase = world.match.phase;
    const st = seat.status().state;
    const show = phase === 'pre' || phase === 'auto' || (phase === 'freeplay' && (st === 'running' || st === 'waiting'));
    if (!show) {
      this.renderer.setZenithPath(null);
      return;
    }
    if (this.zenithLegs?.seat !== seat) {
      this.zenithLegs = { seat, legs: za.module.autoView(seat.loaded).legs.map((l) => l.points) };
    }
    this.renderer.setZenithPath(this.zenithLegs.legs, this.localRobot()?.alliance ?? 'blue');
  }

  /** the auto seat's status for the HUD, or null when this run plays no auto */
  autoStatus(): (AutoSeatStatus & { name: string }) | null {
    return this.autoSeat && this.zenithAuto ? { ...this.autoSeat.status(), name: this.zenithAuto.name } : null;
  }

  /**
   * The auto's run so far as a Zenith trace IN THE FILE'S OWN FRAME (Open run in Zenith), or
   * null: a run on the alliance the file was not written for is mirrored back, so Zenith lays it
   * over the plan it drew.
   */
  autoTrace(): import('@horizon36596/zenith-core').SimTrace | null {
    const seat = this.autoSeat;
    const trace = seat?.trace() ?? null;
    if (!trace || !seat?.loaded || !this.zenithAuto) return trace;
    return this.zenithAuto.module.traceInFileFrame(trace, seat.loaded.mirrored);
  }

  /** the lazy auto module this run was handed, for a screen that opens Zenith from the match */
  zenithModule(): GameControllerZenithAuto['module'] | null {
    return this.zenithAuto?.module ?? null;
  }

  /** a line in the match's event log (the muted left-edge log; never a popup over the field) */
  logEvent(text: string): void {
    this.world.events.push(text);
  }

  /** the auto the local robot plays, planned for its alliance, for the field overlay */
  autoLoaded(): import('./auto/zenithAutos').LoadedAuto | null {
    return this.autoSeat?.loaded ?? null;
  }

  private onResize = (): void => {
    this.renderer.camera.configure(this.canvas, this.viewAlliance(), this.mod.bounds);
    this.hudInsetsDirty = true;
    this.hudInsetsEpoch = null; // a new viewport is a new layout — see `refreshHudInsets`
    this.scene?.resize(this.canvas.clientWidth, this.canvas.clientHeight, window.devicePixelRatio || 1);
  };

  /**
   * MEASURE THE HUD'S OCCUPIED BANDS off the live DOM — the safe rectangle a 3D camera fits
   * the field into (`SceneInsets`, `games/module.ts`). Owner's re-test, 2026-09-18: "make sure
   * that the scoreboard and the field can both fit in the screen without overlap."
   *
   * Called at most ONCE PER RENDERED FRAME and only when `hudInsetsDirty` is set (a resize, a
   * band resizing in place, a band mounting/unmounting, a view switch) — a `getBoundingClientRect`
   * is a layout read and this runs at up to 144 Hz. Writes into `this.hudInsets` in place, so
   * there is no per-frame allocation either.
   *
   * ── WHICH EDGE DOES A BAND CLAIM? ─────────────────────────────────────────────────────
   * Each band claims the edge it intrudes LEAST far from, measured as a FRACTION of that axis
   * (not in pixels): a 52 px top band on a 900 px viewport is a 5.8 % bite, while the same
   * element's right-edge intrusion could be 300 px of a 1600 px width — 19 %, and reserving
   * THAT would throw away a fifth of the field for a corner chip cluster. Comparing fractions
   * is what makes the choice scale-fair on a 21:9 desktop and a portrait phone alike.
   *
   * This matters because the chrome MOVES: on a landscape phone the score bar and the
   * breakdown chips leave the bottom entirely and dock into the left and right gutters (see the
   * landscape block in `styles.css`). Nothing here names a side — the geometry decides, so that
   * layout is fitted correctly without this method knowing it exists.
   *
   * ⚠️ ── A BAND'S BOX MUST NOT DEPEND ON MATCH STATE ────────────────────────────────────
   * This is the safe rect a camera frames the field into, so a band that mounts, unmounts or
   * resizes mid-match MOVES THE FIELD UNDER THE DRIVER. BIOBUZZ's cue row shipped that way —
   * `{(nectarLocked || pin) && <div data-hud-band>…}` — and at the 1:00 cue the bottom inset
   * fell 98px → 73px at 1431×649 and the whole field jumped (owner report, 2026-09-18). A HUD
   * item that comes and goes belongs INSIDE a band whose slot is reserved (see
   * `.breakdown-row`'s `min-height` in `styles.css`), never as a band of its own. Nothing here
   * can enforce that — it is a rule about the markup, and it is why the two observers below
   * exist at all: they are for a LAYOUT change (a resize, a view switch), not a score change.
   *
   * ── WHAT IS DELIBERATELY NOT A BAND ───────────────────────────────────────────────────
   * The EVENT LOG (`.eventlog`) and the touch controls. The log is the toast surface — it grows
   * and empties several times a match, and reserving a band that breathes would re-fit the
   * camera every time a foul was announced. The touch sticks are drawn OVER the field on
   * purpose (they are translucent, repositionable, and the 2D camera does not reserve for them
   * either). Full-screen overlays (the pre-match panel, the results screen, a net overlay) are
   * not bands either: they cover the field completely and briefly, and reserving for one would
   * collapse the safe rect to nothing.
   */
  private refreshHudInsets(): void {
    const ins = this.hudInsets;
    const host = this.sceneHost ?? this.canvas;
    const root = this.hudHost;
    if (!root) {
      ins.top = ins.right = ins.bottom = ins.left = 0;
      this.hudInsetsDirty = false;
      return;
    }
    const box = host.getBoundingClientRect();
    // ⚠️ A ZERO-SIZE HOST LEAVES THE FLAG SET, DELIBERATELY. Mid-teardown or `display:none` is
    // not a measurement — the last fit is kept — so the work has NOT been done and clearing
    // `hudInsetsDirty` here would swallow the request: the surface comes back with its old
    // insets and nothing left to re-fit it. That is one dirty frame on a view switch, where a
    // band has mounted but the canvas has not been laid out yet.
    if (box.width < 1 || box.height < 1) return;
    this.hudInsetsDirty = false;
    const bands = root.querySelectorAll<HTMLElement>('[data-hud-band]');
    let top = 0;
    let right = 0;
    let bottom = 0;
    let left = 0;
    for (let i = 0; i < bands.length; i++) {
      const el = bands[i];
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue; // rendered but empty (a chip row with no chips)
      // clip to the render surface — a band docked in a gutter can hang outside it, and the
      // part that does is not covering any field
      const l = Math.max(r.left, box.left);
      const rr = Math.min(r.right, box.right);
      const t = Math.max(r.top, box.top);
      const b = Math.min(r.bottom, box.bottom);
      if (rr - l < 1 || b - t < 1) continue;
      const dTop = b - box.top;
      const dBottom = box.bottom - t;
      const dLeft = rr - box.left;
      const dRight = box.right - l;
      const fTop = dTop / box.height;
      const fBottom = dBottom / box.height;
      const fLeft = dLeft / box.width;
      const fRight = dRight / box.width;
      const best = Math.min(fTop, fBottom, fLeft, fRight);
      if (best === fTop) top = Math.max(top, dTop);
      else if (best === fBottom) bottom = Math.max(bottom, dBottom);
      else if (best === fLeft) left = Math.max(left, dLeft);
      else right = Math.max(right, dRight);
    }
    // A BAND MAY NEVER EAT THE VIEWPORT. Two of these can only ever be measured together
    // mid-relayout or on a viewport too small to play on, and a safe rect at or past zero would
    // hand the scene an infinite aspect. 45 % a side leaves at least a tenth of each axis.
    const capH = box.height * 0.45;
    const capW = box.width * 0.45;
    /**
     * WITHIN ONE LAYOUT THE SAFE RECT ONLY EVER SHRINKS — the belt to the reserved-slot braces.
     *
     * The rule above says a band's box must not depend on match state, and the rows that can be
     * reserved in CSS are. The chip rows cannot be: `.robot-status` WRAPS against its 50% cap, so
     * a foul chip or a PIN countdown can add a line at a narrow width and take one back four
     * seconds later — measured at 375px wide, the top inset moved 130px → 151px. Taking the
     * MAXIMUM for as long as the layout lasts turns that into a one-way reserve: the field can
     * settle a little smaller, once, and never oscillates under a driver mid-match. A resize or a
     * view switch is a new layout and starts over (`hudInsetsEpoch`).
     */
    const epoch = `${Math.round(box.width)}x${Math.round(box.height)}`;
    const keep = this.hudInsetsEpoch === epoch;
    this.hudInsetsEpoch = epoch;
    ins.top = Math.min(Math.max(top, keep ? ins.top : 0), capH);
    ins.bottom = Math.min(Math.max(bottom, keep ? ins.bottom : 0), capH);
    ins.left = Math.min(Math.max(left, keep ? ins.left : 0), capW);
    ins.right = Math.min(Math.max(right, keep ? ins.right : 0), capW);
    this.syncBandObserver(bands);
  }

  /** reconcile `hudBandObserver` to the bands that exist NOW — bands mount and unmount as the
   * HUD relayouts, and an observer left pointing at a detached node neither fires nor frees. */
  private syncBandObserver(bands: ArrayLike<Element>): void {
    const obs = this.hudBandObserver;
    if (!obs) return;
    const seen = this.observedBands;
    for (let i = 0; i < bands.length; i++) {
      const el = bands[i];
      if (seen.has(el)) continue;
      seen.add(el);
      obs.observe(el);
    }
    if (seen.size === bands.length) return; // nothing left
    const live = new Set<Element>();
    for (let i = 0; i < bands.length; i++) live.add(bands[i]);
    for (const el of seen) {
      if (live.has(el)) continue;
      obs.unobserve(el);
      seen.delete(el);
    }
  }

  /**
   * RECONCILE the live 3D scene to (a) whether this game HAS one and (b) the device's
   * current view preference — called once at construction and again every time
   * `setViewPref` fires (Day 1 seam, `docs/biobuzz/plan-3d.md` §4.1/§4.7). A game with no
   * `scene` (DECODE, Chain Reaction, BIOBUZZ until Lane B lands one) or a controller built
   * with no `sceneHost` (GameView only supplies one when `mod.scene` exists) never loads
   * anything.
   */
  private syncScene(): void {
    const sceneFn = this.mod.scene;
    const want = !!sceneFn && !!this.sceneHost && getViewPref() === '3d';
    if (!want || !sceneFn) {
      this.teardownScene();
      return;
    }
    if (this.scene) return; // already showing one
    const host = this.sceneHost!;
    const epoch = ++this.sceneEpoch;
    if (!this.sceneEverShown) this.setSceneLoading(true);
    (async () => {
      const factory = await sceneFn();
      // Auto's preset line, the slip line and an HDRI failure go to the event log, like
      // every other thing the match wants the player to know (plan §4.6).
      const scene = await factory(host, { onQualityEvent: (line) => this.world.events.push(line) });
      // the view may have switched away, the controller may have been disposed, or a
      // second load may have started (rapid toggling) WHILE this one was in flight —
      // whichever result loses the race is disposed unused rather than replacing the
      // scene the current state actually wants.
      if (this.disposed || epoch !== this.sceneEpoch) {
        scene.dispose();
        return;
      }
      // UNDER the 2D canvas: inserted FIRST, so DOM order decides the stack (both
      // position:absolute, z-index:auto — see `.game-viewport > canvas` in styles.css).
      // Sized before its first `render()`, never after.
      host.insertBefore(scene.element, host.firstChild);
      scene.resize(this.canvas.clientWidth, this.canvas.clientHeight, window.devicePixelRatio || 1);
      // A VIEW SWITCH IS A RE-FIT. The HUD did not move, but this scene has never measured it
      // — and the 2D view it replaces may have been mounted long enough for the last reading
      // to be stale (the chip row grew, an ad column collapsed).
      this.hudInsetsDirty = true;
      this.hudInsetsEpoch = null;
      this.scene = scene;
      // the 2D overlay projects labels and auto paths through the scene's camera from here on
      this.renderer.setScene(scene);
      this.sceneEverShown = true;
      this.setSceneLoading(false);
    })().catch((err: unknown) => {
      if (epoch !== this.sceneEpoch || this.disposed) return;
      this.setSceneLoading(false);
      // ONE console warning, per plan §4.7 ("a rejected renderer import() falls back to the
      // 2D view") — never a blank canvas, and never anything the 2D game screen shows.
      // eslint-disable-next-line no-console
      console.warn('BIOBUZZ 3D scene failed to load; staying on the 2D view.', err);
    });
  }

  /** drop the live scene (view switched to 2D, the controller is disposing, or a render
   * threw). Bumps the epoch FIRST so an in-flight `syncScene()` load cannot land after. */
  private teardownScene(): void {
    this.sceneEpoch++;
    // an in-flight load is abandoned by the epoch bump, so nothing else would clear this
    if (this.sceneLoading && !this.disposed) this.setSceneLoading(false);
    if (!this.scene) return;
    const scene = this.scene;
    this.scene = null;
    this.renderer.setScene(null);
    try {
      scene.element.remove();
    } catch {
      /* not attached, or already gone — either way there is nothing left to remove */
    }
    try {
      scene.dispose();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('BIOBUZZ 3D scene threw disposing; continuing on the 2D view.', err);
    }
  }

  /** which camera a 3D scene renders for — the touch/phone layout gets the overhead shot
   * (the 2D fit), everyone else the driver's-eye view (plan §4.3), mirroring the same
   * `(pointer: coarse)` query `useCoarsePointer` uses to pick `MobileControls`. */
  private sceneCameraFor(): SceneCamera {
    return this.mqCoarse?.matches ? 'overhead' : 'driver';
  }

  private handlePhaseAudio(): void {
    const phase = this.world.match.phase;
    if (phase !== this.prevPhase) {
      if (phase === 'auto') this.audio.play('start');
      if (phase === 'transition') this.audio.play('end');
      if (phase === 'teleop' && this.prevPhase === 'transition') this.audio.play('resume');
      if (phase === 'post') {
        // THE MATCH ENDING IS THE END OF DRIVING — not of SCORING, and not of the recording.
        // Solo practice reaches `post` on its own (a real 2:30 match), so the replay is bounded by
        // the match itself plus the settle below — the same span a server-side recording covers.
        this.settle = newSettleClock();
        this.settleDone = false;
        this.audio.play('end');
        this.matchOverAt = performance.now();
      }
      this.prevPhase = phase;
    }
    /**
     * THE SCORE IS FINAL WHEN NOTHING ON THE FIELD CAN CHANGE IT, AND NOT A MOMENT BEFORE.
     *
     * The buzzer ends driving, not scoring: an artifact can still be in the air or draining the
     * ramp, a hive can still be tipping. The results screen used to reveal on a fixed 2.8 s
     * wall-clock timer, off this client's PREDICTED world, while the server finalized on its own
     * 2.8 s — so a number could land on screen that was neither settled nor the one saved.
     *
     * ONLINE the server decides: it finalizes once the game says the field has settled
     * (`src/sim/settle.ts`), and its `matchResult` is the moment the score is final here.
     * SOLO PRACTICE has no server, so it runs the same settle clock on its own world, and the
     * harvest (the saved run and its replay) happens on that same beat — so a practice score is
     * the settled one, and matches what the identical run would score online.
     *
     * The whoosh plays on the reveal, so the sound, the count-up and the saved score are one moment.
     */
    if (this.world.match.phase === 'post' && !this.settleDone) {
      const decided = this.session
        ? this.session.getMatchResult() !== null
        : settleStep(this.settle, this.world, this.mod.settled);
      if (decided) {
        this.settleDone = true;
        this.audio.play('match_result');
        this.harvestPracticeRun(true);
      }
    }
    if (
      phase === 'teleop' &&
      !this.warningPlayed &&
      this.world.match.phaseTimeLeft <= C.ENDGAME_START
    ) {
      this.warningPlayed = true;
      this.audio.play('warning');
    }
    // announcer during the transition, like a real event:
    // "Drivers, pick up your controllers" ... "3, 2, 1" -> firebell
    if (phase === 'transition') {
      const left = this.world.match.phaseTimeLeft;
      if (left <= 6.5 && this.lastTransitionBeep === -1) {
        this.lastTransitionBeep = 4;
        this.audio.say('Drivers, pick up your controllers');
      }
      const n = Math.ceil(left);
      if (n <= 3 && n >= 1 && n < this.lastTransitionBeep) {
        this.lastTransitionBeep = n;
        this.audio.say(String(n), true); // interrupt: land exactly on the beat
      }
    } else {
      this.lastTransitionBeep = -1;
    }
  }

  /** align the SFX edge trackers with a freshly created world so world
   * creation/restart never plays a phantom shoot/intake/gate cue */
  private seedActionAudio(): void {
    this.prevFireAt = {};
    this.prevIntakeAt = {};
    this.prevBeamOn = {};
    const chain = this.world.game === 'chain';
    for (const r of this.world.robots) {
      this.prevFireAt[r.id] = r.lastFireAt;
      this.prevIntakeAt[r.id] = r.lastIntakeAt;
      this.prevBeamOn[r.id] = chain ? beamRide(r).onCount : 0;
    }
    this.prevGateOpen = {
      red: this.world.goals.red.gateOpen,
      blue: this.world.goals.blue.gateOpen,
    };
  }

  /** shoot / intake / gate effects, edge-detected from world state (the sim
   * core stays event-free for these — same pattern as handlePhaseAudio).
   * All robots share the small field, so everyone's actions are audible. */
  /**
   * A rematch vote landed (or was taken back) — cue it.
   *
   * Edge-triggered on the COUNT, so it fires for your partner's vote as well as
   * your own: the whole point of "1/2" is knowing the other person acted. A vote
   * being withdrawn is cued too, with a falling figure, because a count silently
   * dropping back is exactly the thing you would otherwise miss.
   */
  private handleRematchAudio(): void {
    const v = this.rematchTally();
    const n = v?.votes ?? 0;
    if (n === this.lastRematchVotes) return;
    const rose = n > this.lastRematchVotes;
    this.lastRematchVotes = n;
    if (n > 0 || !rose) this.audio.sfxRematchVote(rose);
  }

  private handleActionAudio(): void {
    const chain = this.world.game === 'chain';
    for (const r of this.world.robots) {
      // ⚠️ `>`, NOT `!==` — a HIGH-WATER MARK, like the beam counter three rows down.
      // `reconcile` snaps the world back to the server's and REPLAYS buffered inputs, so a
      // predicted shot's `lastFireAt` goes FORWARD, back to the server's value, and forward
      // again — and `!==` fired on every one of those, re-cueing the same shot two or three
      // times per reconcile. The mark only ever rises, so the replay's re-fire is silent and
      // the next genuine shot (a later `world.time`) still sounds.
      if (r.lastFireAt > (this.prevFireAt[r.id] ?? 0)) {
        this.prevFireAt[r.id] = r.lastFireAt;
        this.audio.sfxShoot();
      }
      if (r.lastIntakeAt > (this.prevIntakeAt[r.id] ?? 0)) {
        this.prevIntakeAt[r.id] = r.lastIntakeAt;
        this.audio.sfxIntake();
      }
      // CR terrain: a "thunk" whenever a wheel newly mounts a beam (rising edge of the count)
      if (chain) {
        const on = beamRide(r).onCount;
        if (on > (this.prevBeamOn[r.id] ?? 0)) this.audio.sfxBeam();
        this.prevBeamOn[r.id] = on;
      }
    }
    for (const a of ['red', 'blue'] as Alliance[]) {
      const open = this.world.goals[a].gateOpen;
      if (open && !this.prevGateOpen[a]) this.audio.sfxGate();
      this.prevGateOpen[a] = open;
    }
  }

  /** announcer: "Match begins in 3, 2, 1". ONE path now — the SIM owns the countdown and the
   *  pre→auto transition in every mode, and this only voices it (audio is non-authoritative).
   *  Solo used to run its own off a keypress, which is what made a solo run unrecordable; see
   *  `soloSeed`. */
  private updateCountdown(): number | null {
    if (this.world.match.phase !== 'pre') return null;
    const left = this.world.match.preCountdown;
    if (left == null) return null;
    return this.voiceCountdown(left);
  }

  /** shared: emit the spoken count on each new digit, return the HUD value */
  private voiceCountdown(remaining: number): number {
    const n = Math.ceil(remaining);
    if (n !== this.lastBeepAt) {
      this.lastBeepAt = n;
      // numbers interrupt any in-flight speech so the spoken count always
      // lands exactly on the visual digit
      if (n >= C.PRE_COUNTDOWN) this.audio.say('Match begins in');
      else this.audio.say(String(n), true);
    }
    return n; // > 3 means the "Match begins in" lead-in
  }

  /** can park mode be turned ON right now? Any time the robot can actually move —
   * auto, teleop, or free drive — so precision/slow-drive is available throughout
   * a match, not only in the endgame window. */
  private canPark(): boolean {
    return robotsEnabled(this.world);
  }

  /** everything a frame does EXCEPT render: sample input, step, audio, toasts */
  private frameLogic(dtMs: number): void {
    const cmd = this.input.poll();
    // "flip front": reverse robot-centric drive so the shooter side leads.
    // Meaningless in field-centric (translation is driver-frame there).
    if (!this.localRobot().fieldCentric) {
      if (this.input.flipPressed) this.frontFlipped = !this.frontFlipped;
      if (this.frontFlipped) {
        cmd.driveX = -cmd.driveX;
        cmd.driveY = -cmd.driveY;
      }
    }
    // park mode: toggle on press. Turning it ON is gated to when the robot can
    // drive (auto/teleop/free drive); turning it back OFF is always allowed. While
    // on, cap the drive command's magnitude to the configured percentage for
    // precision, low-speed control.
    if (this.input.parkPressed) {
      if (this.parked) this.parked = false;
      else if (this.canPark()) this.parked = true;
    }
    if (this.parked) {
      const k = Math.max(0, Math.min(100, this.settings.parkSpeedPct)) / 100;
      cmd.driveX *= k;
      cmd.driveY *= k;
      cmd.rotate *= k;
    }
    // Tank control style is a PER-DRIVER input preference (not a shared world
    // setting), so resolve it here: "Normal" tank derives side-drive from arcade
    // driveY/rotate, "Traditional" keeps the raw separate-stick leftDrive/rightDrive.
    // The sim's tank branch then always reads leftDrive/rightDrive, so the choice
    // works identically in solo and multiplayer (the server never sees these
    // settings). Runs after flip/park so both still apply in Normal tank.
    // A BUTTERFLY that currently has its traction set down drives as a tank, so it takes
    // the same control-style resolution — otherwise swapping wheel sets mid-match would
    // silently stop responding (the sim's tank branch reads ONLY leftDrive/rightDrive,
    // which nothing would have been filling).
    const lr = this.localRobot();
    const drivingTank =
      lr.spec.drivetrain === 'tank' || (lr.spec.drivetrain === 'butterfly' && lr.butterflyTank);
    if (drivingTank && this.settings.tankControlMode === 'normal') {
      cmd.leftDrive = clamp(cmd.driveY - cmd.rotate, -1, 1);
      cmd.rightDrive = clamp(cmd.driveY + cmd.rotate, -1, 1);
    }
    this.lastCmd = cmd;

    this.acc += Math.min(dtMs / 1000, 0.25);
    // TWO `performance.now()` CALLS AND ONE RING WRITE, always on. This is the number the
    // read-out's SIM row prints, and it is the only way to tell "my machine cannot draw this"
    // from "my machine cannot step this" — which are the two completely different answers a
    // player reporting a slow match needs. See `PerfRing` on why it costs what it costs.
    const simT0 = performance.now();
    if (this.session) this.stepServer(cmd);
    else this.stepSolo(cmd);
    this.simTimes.push(performance.now() - simT0);

    this.hudCountdown = this.updateCountdown();
    this.handlePhaseAudio();
    this.handleActionAudio();
    this.handleRematchAudio();

    // SOLO drains world.events directly; MULTIPLAYER drains netEvents (the de-duped
    // authoritative tail collected at reconcile), ignoring prediction/replay events.
    const drain = this.session ? this.netEvents : this.world.events;
    for (const e of drain) {
      this.toasts.push({ id: ++this.toastId, text: e, at: performance.now() });
    }
    this.toasts = this.toasts.filter((x) => performance.now() - x.at < 2500).slice(-5);
    drain.length = 0;
  }

  /** rAF loop: solo advances + renders here; multiplayer only RENDERS (the sim
   * is driven by simStep so it survives tab backgrounding — rAF pauses then) */
  private loop = (t: number): void => {
    if (this.disposed) return;
    const dtMs = this.lastT ? t - this.lastT : 16;
    this.lastT = t;
    if (!this.session) this.frameLogic(dtMs);
    // decay the local robot's error-smoothing offset toward 0 (frame-rate independent)
    const dtSec = Math.min(dtMs / 1000, 0.1);
    const k = Math.pow(2, -dtSec / SMOOTH_HALFLIFE);
    this.localSmooth.x *= k;
    this.localSmooth.y *= k;
    this.localSmooth.heading *= k;
    // solo renders the predicted world directly; the networked path renders remote
    // robots + balls INTERPOLATED (smooth) with the local robot predicted
    const world = this.session ? this.displayWorld(dtMs) : this.world;
    // the DRAW half of the read-out's split (the sim half is timed in `frameLogic`) — the 3D
    // pass, if there is one, plus the 2D pass that always runs.
    const drawT0 = performance.now();
    if (this.scene) {
      try {
        // ONE DOM READ, and only when something moved — see `refreshHudInsets`. It sits here
        // rather than in the observers themselves so the read happens at a known point in the
        // frame (before anything has written to the DOM this tick), never interleaved with a
        // React commit where it would force a synchronous relayout.
        if (this.hudInsetsDirty) this.refreshHudInsets();
        const frame: SceneFrame = {
          // the fixed-timestep accumulator's leftover fraction — the same interpolation
          // alpha a fixed-timestep renderer uses between authoritative steps. The 2D
          // renderer does not need it (solo renders `this.world` as last stepped; the
          // networked path already interpolates remotes its own way), so the 3D scene is
          // its first reader.
          alpha: clamp(this.acc / C.SIM_DT, 0, 1),
          viewAngle: this.renderer.camera.viewAngle,
          camera: this.sceneCameraFor(),
          localRobotId: this.spectator ? undefined : this.localRobotId,
          localStartCat: this.spectator ? undefined : this.settings.startCat,
          width: this.canvas.clientWidth,
          height: this.canvas.clientHeight,
          dpr: window.devicePixelRatio || 1,
          // the SAME object every frame (its contract says a scene reads it and does not
          // retain it) — a fresh literal here would allocate 144 times a second
          insets: this.hudInsets,
        };
        this.scene.render(world, frame);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('BIOBUZZ 3D scene failed to render; falling back to the 2D view.', err);
        this.teardownScene();
      }
    }
    // a live scene draws the field/robots/balls beneath this canvas — the 2D pass then
    // stays transparent and draws only its cheap overlay (name labels), never the field.
    // While the scene is still LOADING it draws nothing: the view's loading panel covers it.
    if (this.sceneLoading) {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    } else {
      this.syncZenithPath(world);
      this.renderer.render(this.ctx, world, this.lastCmd, this.localRobotId, !!this.scene, this.driverName);
    }
    this.renderTimes.push(performance.now() - drawT0);
    this.sampleFrame(dtMs);
    this.raf = requestAnimationFrame(this.loop);
  };

  /**
   * Rolling FRAME, SIM and RENDER samples — everything the in-match performance read-out
   * prints, and the thing an ad sign-off is measured with.
   *
   * It began as one array behind `?perf=1`, to answer one question with a number instead of a
   * guess: what does an AdSense creative parked beside a 60 Hz canvas actually cost? An ad
   * iframe can run video, and "it feels fine" is not a measurement you can compare before and
   * after. Drive for ten seconds with the ad columns off, then again with them on, and compare
   * p95 — that is the sign-off the in-game unit needs before `VITE_ADSENSE_SLOT_GAME` is ever
   * set on a live deploy. The read-out is on by default now, so the comparison is a settings
   * change rather than a query string somebody has to remember.
   *
   * ⚠️ **THREE RINGS AND NO ALLOCATION PER FRAME.** The sampling runs always-on, in the frame
   * loop, for every player — so it has to cost three `Float64Array` writes and two
   * `performance.now()` calls, and nothing else. The sorting a percentile needs happens in
   * `getPerfStats`, which the HUD polls at 4 Hz.
   */
  private readonly frames = new PerfRing(240); // ~4 s at 60 fps
  private readonly simTimes = new PerfRing(240);
  private readonly renderTimes = new PerfRing(240);
  /**
   * Steps the fixed-timestep loop ran, per frame.
   *
   * A WINDOW AND NOT THE LAST FRAME'S COUNT, because on any machine above 60 fps most frames
   * step ZERO times and the occasional one steps once — a display bound to the last frame
   * flickered between "0 steps" and "1 step" and told a reader nothing. The mean is the
   * number that means something: 1.0 is keeping up exactly, below 1 is a display faster than
   * the sim, and above 1 is a frame loop catching up on ticks it owes.
   */
  private readonly stepCounts = new PerfRing(240);
  /** reconciles applied this match — a correction COUNT, which is the thing that says whether
   * prediction is fighting the server or agreeing with it */
  private reconciles = 0;
  private sampleFrame(dtMs: number): void {
    // a gap this long is a hidden tab (rAF paused), not a frame. Kept, it read as a 0 fps
    // "1% low" and a multi-second WORST for the whole 4 s window after the player came back.
    if (dtMs > 1000) return;
    this.frames.push(dtMs);
  }

  /**
   * EVERYTHING THE PERFORMANCE READ-OUT PRINTS, in one object, sampled at 4 Hz.
   *
   * ONE call rather than a method per number, because the display is memoized on the identity
   * of what it is handed: the HUD around it re-renders at 10 Hz off `getHud()`, and a read-out
   * that re-rendered with it would be a frame-time counter that costs frame time. Null until
   * there are enough samples for a percentile to mean anything.
   *
   * Rows the display cannot draw are null rather than 0 — a 0 ms ping and an unmeasured one
   * look identical on screen, and the whole value of this thing is that its numbers are real.
   */
  getPerfStats(withSeries = false): PerfSnapshot | null {
    if (this.frames.count < 30) return null;
    const p50 = this.frames.quantile(0.5);
    const net = this.session ? this.session.status() : null;
    const scene = readRenderStats();
    const canvas = this.canvas;
    return {
      fps: p50 > 0 ? 1000 / p50 : 0,
      p50,
      p95: this.frames.quantile(0.95),
      p99: this.frames.quantile(0.99),
      worst: this.frames.max(),
      simMs: this.simTimes.mean(),
      stepsPerFrame: this.stepCounts.mean(),
      renderMs: this.renderTimes.mean(),
      physics: this.interp3d() ? '3d' : '2d',
      view3d: !!this.scene,
      scene,
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      dpr: typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
      net,
      /** the interpolation delay is a CONSTANT, but it is the one number that explains why a
       *  remote robot is where it is rather than where the newest snapshot says, so it prints */
      interpMs: net ? INTERP_DELAY_TICKS * C.SIM_DT * 1000 : null,
      /** how far the render clock is behind the newest authoritative tick, in ticks. The
       *  interpolation delay is the floor; anything much above it is a snapshot stall. */
      behindTicks: net && this.gotSnapshot ? Math.max(0, Math.round(this.lastServerTick - this.renderTick)) : null,
      reconciles: net ? this.reconciles : null,
      correctionIn: net ? this.lastCorrection : null,
      prediction: this.getPredictionStats(),
      frameSeries: withSeries ? this.frames.series(PERF_SERIES_LEN) : EMPTY_SERIES,
    };
  }

  /** multiplayer sim driver — a timer (not rAF) so a backgrounded tab keeps
   * stepping and feeding inputs to its peers instead of freezing the match */
  private simStep = (): void => {
    if (this.disposed) return;
    const now = performance.now();
    const dtMs = this.lastSimT ? now - this.lastSimT : 8;
    this.lastSimT = now;
    this.frameLogic(dtMs);
  };

  /** solo stepping: local keypress start/restart, one local command per tick */
  private stepSolo(cmd: RobotCommand): void {
    // nothing may be stepped until the 3D wasm is in hand — see `physicsPending` — and a
    // practice does not start behind the 3D view's loading panel (`sceneLoading`)
    if (this.physicsPending || this.sceneLoading) {
      this.acc = 0;
      return;
    }
    if (this.input.startPressed) this.startMatch();
    if (this.input.restartPressed) this.restart();

    /**
     * STEP ON WHAT THE RECORDER STORES, not on the raw stick.
     *
     * A replay stores QUANTIZED commands (the same lattice the wire uses), so a run only
     * re-simulates exactly if the sim consumed the quantized value in the first place — which
     * is why `runRecordMatch` localizes before stepping and why the netcode contract makes the
     * client predict on `localizeCommand`. Solo stepped on the raw command, so recording it
     * would have drifted from playback by the rounding, every tick.
     *
     * It is applied UNCONDITIONALLY rather than only while recording: solo practice must not
     * feel like two different games depending on whether a replay is being kept, and this is
     * the same rounding every online match already runs on.
     */
    const local = localizeCommand(cmd);
    let steps = 0;
    const commands = new Map<number, RobotCommand>([[this.localRobotId, local]]);
    while (this.acc >= C.SIM_DT && steps < C.MAX_STEPS_PER_FRAME) {
      /**
       * THE BOTS DECIDE BEFORE THE STEP, once per tick, into the SAME map the recorder is
       * handed. That ordering is the whole contract: a command produced after the step would
       * be a tick late, and one produced outside this map would not be recorded — and an
       * unrecorded bot command makes the replay a different match from the run.
       */
      for (const [id, seat] of this.bots) commands.set(id, localizeCommand(seat.step(this.world)));
      // the auto drives the local robot in AUTO (and in an armed Free Drive trial); otherwise it
      // hands the driver's command straight back, so this is a no-op outside those
      if (this.autoSeat) commands.set(this.localRobotId, localizeCommand(this.autoSeat.step(this.world, local)));
      this.mod.step(this.world, C.SIM_DT, commands);
      this.recorder?.record(this.world.tick, commands);
      // counted HERE, beside the record call, because it must measure exactly the ticks that
      // went into the log — and only the ones the sim let the robot move on (`pre` and
      // `transition` are recorded but undrivable).
      if (this.recorder && robotsEnabled(this.world)) this.drivenTicks++;
      this.acc -= C.SIM_DT;
      steps++;
      /**
       * THE TUTORIAL'S PREDICATE, EVERY TICK, RIGHT AFTER THE STEP THAT COULD HAVE SATISFIED IT.
       *
       * Per tick rather than at the 10 Hz HUD poll, because several of the things a step asks for
       * are CLEANED UP by the ticks that follow them: an up CELL is emptied by the tip it caused
       * (`hiveStep`), and a spill tag clears on its element's first contact. A predicate read six
       * ticks late can look at a field where the thing it was watching for has already been tidied
       * away, and the symptom is a step that never completes however well it was played.
       *
       * Advancing REPLACES the world, so the loop has to stop here — `advanceTutorial` zeroes the
       * accumulator, and the next frame steps the newly staged world from its own tick 0.
       */
      if (this.tutorial && this.tutorial.tick(this.world, this.localRobotId)) {
        this.advanceTutorial(true);
        return;
      }
    }
    this.stepCounts.push(steps);
    if (steps === C.MAX_STEPS_PER_FRAME) this.acc = 0;
  }

  /**
   * MOVE THE TUTORIAL ON — from a completed step (`completed`) or from Skip.
   *
   * One path for both, because the world is rebuilt either way and a skipped step is not a failed
   * one. The event line goes onto the NEW world, so it drains through the ordinary
   * `world.events` → toast path (`docs/area/ui.md`: the muted left-edge log, never a popup over
   * the field).
   */
  private advanceTutorial(completed: boolean): void {
    const t = this.tutorial;
    if (!t) return;
    const was = t.step?.title ?? '';
    const more = t.advance();
    this.rebuildForTutorial();
    if (completed && was) this.world.events.push(`STEP DONE — ${was.toUpperCase()}`);
    if (!more) {
      // FINISHED: the device flag is set here rather than on the way out of the screen, because
      // this is the moment it becomes true, and a player who closes the tab on the sign-off card
      // has still been through it.
      markTutorialSeen(gameOf(this.world).id);
      this.world.events.push('TUTORIAL COMPLETE');
    }
  }

  /**
   * A QUIET REBUILD, for a step change / replay / exit.
   *
   * Everything `restart()` does except the two things that would be wrong here: it does not play
   * the ABORT cue (nothing was aborted), and it does not harvest a practice run (a tutorial is
   * free drive, so there is no recorder — see `startMatch`).
   */
  private rebuildForTutorial(): void {
    this.adoptWorld(this.makeWorld());
    this.prevPhase = this.world.match.phase;
    this.acc = 0;
    this.warningPlayed = false;
    this.matchOverAt = null;
    this.settle = newSettleClock();
    this.settleDone = false;
    this.hudCountdown = null;
    this.frontFlipped = false;
    this.parked = false;
    this.seedActionAudio();
    this.toasts = [];
  }

  /**
   * The live binding / device context every hint is composed against.
   *
   * `mqCoarse` is the media query this controller already keeps for the mobile layout, read
   * LIVE rather than latched: a tablet that has a keyboard folded behind it can go either way
   * mid-session, and the card re-renders at 10 Hz anyway.
   */
  private hintCtx(): TutorialHintCtx {
    return {
      // the EFFECTIVE map, so a hint names the key this season is actually on — and never
      // names a control for an action this season does not have.
      bindings: this.bindings,
      gamepad: this.input.gamepadConnected,
      touch: this.mqCoarse?.matches ?? false,
    };
  }

  /** the tutorial's current card, or null when this run is not a tutorial. */
  getTutorial(): TutorialView | null {
    return this.tutorial ? this.tutorial.view(this.hintCtx()) : null;
  }

  /** SKIP this step — the next one is staged on a fresh world, exactly as a completed one is. */
  tutorialSkip(): void {
    if (this.tutorial && !this.tutorial.isFinished) this.advanceTutorial(false);
  }

  /** REPLAY this step — rebuild and re-stage it, with the nudge clock back at zero. */
  tutorialReplay(): void {
    if (!this.tutorial) return;
    this.tutorial.replay();
    this.rebuildForTutorial();
  }

  /**
   * EXIT the tutorial: drop the runner, set the device flag, and rebuild into an ordinary free
   * drive on the same screen.
   *
   * The flag is set on the way out as well as on completion, and that is deliberate: somebody who
   * has decided they do not want the tutorial should not be offered it again on every Practice.
   * Controls keeps an entry that runs it, which is where they get it back.
   */
  tutorialExit(): void {
    if (!this.tutorial) return;
    this.tutorial.abandon();
    this.tutorial = null;
    markTutorialSeen(gameOf(this.world).id);
    this.rebuildForTutorial();
  }

  /** server-authoritative stepping (predict + reconcile): every tick we apply
   * our OWN command locally for instant response and send it to the server; when
   * an authoritative snapshot arrives we snap the world to it and replay the
   * local inputs it hadn't folded in yet. A dropped/laggy peer never blocks us —
   * only our own robot is predicted, remote robots are corrected by snapshots. */
  private stepServer(cmd: RobotCommand): void {
    const s = this.session!;
    /**
     * Held BEFORE the snapshot is taken, deliberately. Reconcile REPLAYS buffered inputs
     * through `mod.step`, so consuming a snapshot while the physics is missing would throw on
     * exactly the path that is meant to be safe. Leaving the snapshot unconsumed costs
     * nothing: the session keeps only the freshest one, and the first reconcile after the
     * load snaps straight to the server's authoritative world.
     */
    if (this.physicsPending) {
      this.acc = 0;
      return;
    }
    // NOTE: no IN-PLACE restart in multiplayer — a local or host-authored rebuild
    // desynced everyone (post-restart stuck/jitter). Players return to the lobby to
    // start a fresh match instead.
    // A record run is the exception: it is single-player, so the restart binding
    // asks the UI to tear the session down and open a NEW run (a fresh room). We
    // only forward the request — nothing here rebuilds `this.world`, which is what
    // made the drivetrain stick against a server still running the old match.
    // The restart binding (R by default) does exactly what the on-screen button
    // does, which differs by run type:
    //  - CO-OP (duo record): toggle this driver's rematch VOTE. It cannot tear the
    //    run down unilaterally — the run belongs to both people — so it never
    //    returns early here; the match keeps stepping while the vote sits.
    //  - SOLO record: ask the UI for a whole new run (a fresh room).
    if (this.input.restartPressed && this.rematchTally()) {
      this.toggleRematch();
    } else if (this.input.restartPressed && this.restartRequestCb) {
      this.restartRequestCb();
      return; // the session is going away this frame; don't predict into it
    }

    /**
     * A DEAD SESSION MUST NOT KEEP SIMULATING.
     *
     * Prediction is a guess at what the server will confirm, so once the server is gone
     * there is nothing left to guess — and continuing produces something worse than a
     * frozen screen: a fully playable single-player match. Remote robots never receive a
     * command, so they sit at their spawn poses while the local robot drives around a world
     * nobody is scoring. That is exactly what a failed REJOIN looked like — tapping "rejoin"
     * on a match that had already ended dropped the player into what read as an offline
     * practice field, for as long as they cared to drive.
     *
     * The lead cap below cannot catch this: it is gated on `gotSnapshot`, which is false
     * precisely when no snapshot ever arrived, so a session that never connected had no
     * bound at all on how far it would predict. Freeze instead, and let the HUD's
     * connection-lost panel be the whole story.
     */
    if (s.status().failed) {
      this.acc = 0;
      return;
    }

    // reconcile to the freshest server snapshot BEFORE predicting this frame
    const snap = s.takeSnapshot();
    if (snap) {
      this.bufferSnapshot(snap); // capture authoritative poses BEFORE reconcile mutates them
      this.remoteCmds = snap.cmds; // hold each robot's command to predict it forward
      this.reconcile(snap);
    }

    // SPECTATOR: no local robot to predict + nothing to send. Advance the world with the
    // authoritative per-robot commands so balls animate between snapshots; every robot is
    // then corrected each snapshot + interpolated for display (displayWorld). No inputBuf.
    if (this.spectator) {
      if (this.acc > 0.25) this.acc = 0.25;
      let n = 0;
      while (this.acc >= C.SIM_DT && n < 30) {
        if (this.gotSnapshot && this.world.tick - this.lastServerTick >= MAX_PREDICT_LEAD) {
          this.acc = 0;
          break;
        }
        this.mod.step(this.world, C.SIM_DT, new Map(this.remoteCmds));
        this.acc -= C.SIM_DT;
        n++;
      }
      return;
    }

    // AUTO's one measurement, taken in the countdown and nowhere else (plan §5).
    this.maybeProbeAuto();

    // predict a small amount ahead in real time (the local robot stays responsive;
    // the server accepts our slightly-late inputs by applying our latest command,
    // so we do NOT fast-forward the whole world — that flung the balls around)
    if (this.acc > 0.25) this.acc = 0.25;
    let steps = 0;
    // A 3D ROOM PREDICTS ONE ROBOT, NOT A WORLD — see the prediction block's header.
    const pred = this.predicted3d();
    while (this.acc >= C.SIM_DT && steps < 30) {
      // LEAD CAP: don't predict more than MAX_PREDICT_LEAD ticks past the newest
      // authoritative tick. During a snapshot stall this holds the local robot at
      // the lead edge instead of building an unbounded input buffer that reconcile
      // then replays in one giant hitch (the "everything flies on recovery" bug).
      // Drain the accumulator so we don't burst-catch-up when snapshots resume.
      // THE CLOCK IS `predictTick` in a 3D room, because `world.tick` does not move there.
      const lead = pred ? this.predictTick : this.world.tick;
      if (this.gotSnapshot && lead - this.lastServerTick >= MAX_PREDICT_LEAD) {
        this.acc = 0;
        break;
      }
      const tick = lead + 1;
      const local = localizeCommand(cmd);
      s.sendInput(tick, cmd);
      this.inputBuf.push({ tick, cmd: local });
      if (pred) {
        this.predictTick = tick;
        // Off writes no pose; the local robot then renders interpolated, like a remote.
        const pose = this.predictor?.step(local);
        if (pose) this.applyPredictedPose(pose);
      } else {
        this.mod.step(this.world, C.SIM_DT, this.cmdMap(local));
      }
      this.acc -= C.SIM_DT;
      steps++;
    }
    this.stepCounts.push(steps);
    // bound the buffer (only recent, unacked inputs ever matter)
    if (this.inputBuf.length > 600) this.inputBuf.splice(0, this.inputBuf.length - 600);
  }

  /** the command map to step: the local robot's live command + every remote
   * robot's held command (so remotes move + collide in the predicted world) */
  private cmdMap(local: RobotCommand): Map<number, RobotCommand> {
    const m = new Map(this.remoteCmds);
    m.set(this.localRobotId, local);
    return m;
  }

  /** record an authoritative snapshot's entity poses for interpolation. Copies the
   * poses (not the world) — the snapshot world is mutated by reconcile right after. */
  private bufferSnapshot(snap: Snapshot): void {
    const w = snap.world;
    this.snapBuf.push({
      tick: snap.serverTick,
      robots: w.robots.map((r) => ({
        id: r.id,
        x: r.pos.x,
        y: r.pos.y,
        z: r.z ?? 0,
        heading: r.heading,
      })),
      /**
       * ONLY for a 3D-physics world — see the field's own header.
       *
       * ⚠️ READ OFF `snap.world`, NOT OFF `this.world`. This runs BEFORE `reconcile`, so
       * `this.world` is still the PREVIOUS world — the one the last snapshot was adopted into.
       * `interp3d()` reads that, and its own comment used to claim the opposite ("the world
       * this snapshot was reconciled into"). They agree for every snapshot after the first,
       * which is what made it survive: the one frame they disagree is the FIRST snapshot of a
       * 3D room, whose ball poses were dropped on the floor because the outgoing world was
       * still 2D — and a spectator or a mid-match joiner starts every session on that frame.
       */
      balls: biobuzzPhysics(w) === '3d'
        ? w.balls.map((b) => ({
            id: b.id,
            x: b.pos.x,
            y: b.pos.y,
            z: b.z,
            kind: b.state.kind,
            state: { ...b.state } as BallState,
          }))
        : [],
    });
    if (this.snapBuf.length > INTERP_BUFFER) this.snapBuf.shift();
  }

  /**
   * DOES THIS WORLD'S ELEMENTS GET INTERPOLATED? Only a 3D-physics BIOBUZZ world does.
   *
   * Read off `world.biobuzz.physics` rather than off the session, because it has to answer
   * for a spectator and a mid-match joiner too — both of which learn the room's physics from
   * the keyframe rather than from a `matchStart` they were not sent. One read, used by the
   * buffer and by `displayWorld`, so the two halves cannot disagree about a frame.
   */
  private interp3d(): boolean {
    const bb = (this.world as { biobuzz?: { physics?: string } }).biobuzz;
    return bb?.physics === '3d';
  }

  // ─────────────────────────────────────────────────── prediction (plan §5) ──

  /**
   * IS THE LOCAL ROBOT PREDICTED BY `sim3d/predict` RATHER THAN BY THE WHOLE GAME STEP?
   *
   * Three conditions, and all three are load-bearing. A SESSION, because prediction is what a
   * client does about a server it cannot hear from yet — solo has no lag to hide. NOT A
   * SPECTATOR, because a spectator has no robot of its own and its path deliberately steps the
   * world so its balls animate. And a 3D-PHYSICS world, read off the world itself rather than
   * off the session, for the same reason `interp3d` is: a mid-match joiner learns the room's
   * physics from the keyframe, not from a `matchStart` it was never sent.
   */
  private predicted3d(): boolean {
    return !!this.session && !this.spectator && this.interp3d();
  }

  /** flip the chunk-loading latch and tell the view, in one place so the two cannot disagree. */
  private setPhysicsPending(pending: boolean): void {
    this.physicsPending = pending;
    this.onPhysicsPending?.(pending);
  }

  /** the same for the 3D view's latch */
  private setSceneLoading(loading: boolean): void {
    if (this.sceneLoading === loading) return;
    this.sceneLoading = loading;
    this.onSceneLoading?.(loading);
  }

  /**
   * ADOPT A STORED PREFERENCE. `auto` resolves at the countdown probe, so it starts as Light —
   * the safe answer, and the one Auto falls back to anyway.
   *
   * `initial` distinguishes construction from a live change: the two differ only in the event
   * log line Off earns, which is about a CHOICE and would be a strange thing to print at
   * kickoff for a preference somebody set weeks ago... except that it is exactly then that it
   * is useful. So both paths print it, once ever, and `initial` only decides whether the line
   * can reach a log at all (there is no log before the first frame drains one — `netEvents` is
   * drained in `frameLogic`, which has not run yet, so an early push simply waits).
   */
  private resolvePredictionPref(pref: PredictionPref, initial: boolean): void {
    this.predictionPref = pref;
    if (pref === 'auto') {
      // a live switch BACK to Auto re-arms the probe: the player has asked the game to decide
      // again, and refusing to re-measure would leave them on whatever the last explicit pick was
      if (!initial) {
        this.autoProbed = false;
        this.autoDropped = false;
      }
      this.setPredictionMode(this.autoProbed ? this.predictionMode : 'light');
      return;
    }
    this.setPredictionMode(pref);
  }

  /** switch what is running. Rebuilds the predictor, clears the slip window, and earns Off its
   *  one-time explanation. A no-op when the mode is already the one asked for. */
  private setPredictionMode(mode: PredictionMode): void {
    if (this.predictionMode === mode && (mode === 'off') === (this.predictor === null)) {
      this.ensurePredictor();
      return;
    }
    this.predictionMode = mode;
    this.reconcileMs.length = 0;
    this.ensurePredictor();
    /**
     * OFF'S ONE-TIME EXPLANATION (plan §5). A driver who turns prediction off and then finds
     * their robot answering the stick a tenth of a second late has been handed a bug, not a
     * setting, unless somebody tells them. It goes to the event log — `docs/area/ui.md`'s
     * "no popup toasts over the field" names that log as the surface — and only in a room where
     * the setting does anything at all.
     */
    if (mode === 'off' && this.predicted3d() && !offNoticeShown()) {
      markOffNoticeShown();
      this.netEvents.push('Prediction off — your robot is drawn from the server, about 80 ms behind your stick.');
    }
  }

  /** build (or drop) the predictor the current mode wants. Idempotent: called on every
   *  reconcile, and returns immediately when the live one is already the right kind. */
  private ensurePredictor(): void {
    const want = this.predictionMode;
    if (want === 'off' || !this.predicted3d()) {
      this.disposePredictor();
      return;
    }
    if (this.predictorKind === want && this.predictor) return;
    this.disposePredictor();
    // NOT AN ERROR, just early: the chunk is still in flight and `physicsPending` is holding
    // every step anyway. The next reconcile after it lands builds this.
    if (!physics3dReady()) return;
    try {
      const impl = physics3dImpl();
      this.predictor =
        want === 'full'
          ? impl.createFullPredictor(this.world, this.localRobotId)
          : impl.createLightPredictor(this.world, this.localRobotId);
      this.predictorKind = want;
    } catch (err) {
      // A FULL predictor builds ~80 Rapier colliders and can fail where Light cannot. Fall to
      // Light rather than to nothing: a room with no prediction at all is a worse answer than
      // the cheaper one, and Off is a choice the player makes, never an outcome they are given.
      // eslint-disable-next-line no-console
      console.warn('BIOBUZZ 3D prediction failed to build; falling back to Light.', err);
      this.predictor = null;
      this.predictorKind = null;
      if (want === 'full') {
        this.predictionMode = 'light';
        this.ensurePredictor();
      }
    }
  }

  private disposePredictor(): void {
    const p = this.predictor;
    this.predictor = null;
    this.predictorKind = null;
    this.clearElementSmoothing();
    try {
      p?.dispose();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('BIOBUZZ 3D predictor threw disposing.', err);
    }
  }

  /** write a predicted pose onto the local robot of the authoritative world. Six fields, the
   *  same six `step3d`'s readback writes — a partial write would leave the drive model reading
   *  a velocity that does not belong to the position beside it. */
  private applyPredictedPose(pose: PredictedPose): void {
    const r = this.world.robots.find((x) => x.id === this.localRobotId);
    if (!r) return;
    r.pos.x = pose.pos.x;
    r.pos.y = pose.pos.y;
    r.vel.x = pose.vel.x;
    r.vel.y = pose.vel.y;
    r.heading = pose.heading;
    r.angVel = pose.angVel;
    r.z = pose.z;
    r.vz = pose.vz;
  }

  /**
   * THE 3D RECONCILE: re-step every buffered input through the predictor, not through the game.
   *
   * `reset` adopts the authoritative world, `step` re-runs one buffered input, and the LAST
   * pose is the one written back — the intermediate ones are never rendered, so there is
   * nothing to do with them. The whole window is `MAX_PREDICT_LEAD` (40) inputs at the very
   * most, which is the number `PREDICT_FULL_BUDGET_MS` was measured against.
   *
   * Off still runs the clock (`predictTick`) and still buffers, so switching prediction ON
   * mid-match has a buffer to replay rather than a gap; it simply writes no pose, leaving the
   * local robot at the server's own position for `displayWorld` to interpolate like a remote.
   */
  private replayThroughPredictor(serverTick: number): void {
    this.ensurePredictor();
    this.predictTick = serverTick + this.inputBuf.length;
    const p = this.predictor;
    if (!p) return; // Off, or the chunk has not landed yet
    // THE CLOCK IS ALLOWED HERE. `sim3d/` may not read one (the source guard greps for it, and
    // a sim that can read a clock is a sim that can make a replay diverge) — this is client
    // code measuring client code, which is the reason `probeFullReconcileMs` takes `now` as an
    // argument rather than defaulting it.
    const t0 = performance.now();
    // the ELEMENTS' half of `localSmooth`, captured exactly the way the robot's is: BEFORE and
    // AFTER are the SAME predicted tick (the replay ends where the last window ended), so what
    // is left is the prediction error and nothing else. Read across a FRAME instead and every
    // correction would also carry one tick of real motion, which never decays and pins each
    // element a tick behind for the rest of the match (measured: it put the artifact straight
    // back, p95 8.1 in against 0.99).
    const before = p.elements();
    p.reset(this.world, serverTick);
    let pose: PredictedPose | null = null;
    for (const b of this.inputBuf) pose = p.step(b.cmd);
    if (pose) this.applyPredictedPose(pose);
    if (before) this.noteElementCorrection(before, p.elements());
    this.notePredictionCost(performance.now() - t0);
  }

  /** accumulate each predicted element's re-seat correction into its visual offset, so the
   *  drawn position stays continuous across a reconcile and eases onto the new prediction. */
  private noteElementCorrection(before: PredictedElement[], after: PredictedElement[] | null): void {
    if (!after) return;
    const was = new Map(before.map((e) => [e.id, e] as const));
    for (const e of after) {
      const w = was.get(e.id);
      if (!w) continue; // it entered the near set this reconcile — `displayWorld` absorbs that
      // `BALL_SMOOTH_MAX` bounds the CORRECTION, not the running offset: the offset may still be
      // easing a source switch in (`BALL_SWITCH_MAX`), and bounding the sum dropped that on the
      // next reconcile, which is the snap the switch was eased to avoid.
      if (Math.hypot(w.x - e.x, w.y - e.y, w.z - e.z) > BALL_SMOOTH_MAX) {
        this.ballSmooth.delete(e.id);
        continue;
      }
      const o = this.ballSmooth.get(e.id);
      const x = (o ? o.x : 0) + (w.x - e.x);
      const y = (o ? o.y : 0) + (w.y - e.y);
      const z = (o ? o.z : 0) + (w.z - e.z);
      if (Math.hypot(x, y, z) > BALL_SWITCH_MAX) this.ballSmooth.delete(e.id);
      else this.ballSmooth.set(e.id, { x, y, z });
    }
  }

  /** drop every element's visual offset. Called wherever the interpolation buffer is cleared
   *  and wherever the predictor goes away — an offset against a predictor that no longer exists
   *  would hold the last correction on screen for the ~200 ms it takes to decay. */
  private clearElementSmoothing(): void {
    this.ballSmooth.clear();
    this.ballDrawn.clear();
    this.ballPredicted.clear();
  }

  /**
   * AUTO'S ONE MEASUREMENT (plan §5), taken during the pre-match countdown.
   *
   * `probeFullReconcileMs` builds a real Full predictor, resets it to the real world and
   * re-steps a real forty-tick window, which is the exact work a reconcile does — so the answer
   * is about THIS machine and THIS match rather than about a synthetic benchmark. Under
   * `PREDICT_FULL_BUDGET_MS` takes Full; anything else takes Light. Off is never chosen here.
   *
   * It runs in `pre` because that is the one moment in a match with nothing else happening and
   * a guaranteed few seconds of it. A client that arrives past the countdown — a rejoin, a
   * mid-match join — takes Light without probing: probing inside a live match would spend the
   * budget it is trying to protect, at the worst possible time.
   */
  private maybeProbeAuto(): void {
    if (this.autoProbed || this.predictionPref !== 'auto' || !this.predicted3d()) return;
    if (this.world.match.phase !== 'pre') {
      if (this.gotSnapshot) {
        this.autoProbed = true;
        this.setPredictionMode('light');
      }
      return;
    }
    if (!physics3dReady()) return; // still loading; the countdown is 3 s and this is idempotent
    this.autoProbed = true;
    let ms = Number.POSITIVE_INFINITY;
    try {
      ms = physics3dImpl().probeFullReconcileMs(this.world, this.localRobotId, () => performance.now());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('BIOBUZZ 3D prediction probe threw; taking Light.', err);
    }
    this.autoProbeMs = Number.isFinite(ms) ? ms : null;
    this.setPredictionMode(ms <= PREDICT_FULL_BUDGET_MS ? 'full' : 'light');
  }

  /**
   * THE SLIP RULE (plan §5): if Full's reconcile p95 climbs past the budget in a match, Auto
   * drops to Light ONCE and says so.
   *
   * ⚠️ **ONLY WHEN THE MODE WAS AUTO'S TO PICK.** A player who chose Full explicitly keeps it,
   * however slow it gets — the plan's words are "the player's explicit choice is never
   * overridden", and silently undoing a setting somebody opened a menu to change is worse than
   * a few dropped frames. The window is `PREDICT_SLIP_WINDOW` reconciles (~2 s at 30 Hz) so one
   * GC pause cannot trigger it, and it never steps back up: a machine that missed the budget
   * under load will miss it again, and a mode that flaps is worse than the cheaper one.
   */
  private notePredictionCost(ms: number): void {
    this.lastReconcileMs = ms;
    if (this.predictorKind !== 'full') return;
    const w = this.reconcileMs;
    w.push(ms);
    if (w.length > PREDICT_SLIP_WINDOW) w.shift();
    if (this.autoDropped || this.predictionPref !== 'auto') return;
    if (w.length < PREDICT_SLIP_WINDOW) return;
    const sorted = [...w].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    if (p95 <= PREDICT_FULL_BUDGET_MS) return;
    this.autoDropped = true;
    this.setPredictionMode('light');
    this.netEvents.push('Prediction stepped down to Light — full prediction is too slow here.');
  }

  /**
   * What the in-match panel prints, and what a verification run reads.
   *
   * Null for every match where the setting does nothing (solo, a 2D room, a spectator), so the
   * control can hide itself on the one fact that decides whether it would do anything.
   */
  getPredictionStats(): {
    pref: PredictionPref;
    mode: PredictionMode;
    /** ms the Auto probe measured on this machine, or null (not Auto, or not probed yet) */
    probeMs: number | null;
    /** the last reconcile's correction distance, inches */
    correctionIn: number;
    /** the last reconcile's cost, ms */
    reconcileMs: number;
    /** p95 reconcile cost over the recent window, or null before the window fills */
    reconcileP95: number | null;
    /** Auto stepped Full down to Light this match */
    stepped: boolean;
  } | null {
    if (!this.predicted3d()) return null;
    const w = this.reconcileMs;
    let p95: number | null = null;
    if (w.length >= 8) {
      const sorted = [...w].sort((a, b) => a - b);
      p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }
    return {
      pref: this.predictionPref,
      mode: this.predictionMode,
      probeMs: this.autoProbeMs,
      correctionIn: this.lastCorrection,
      reconcileMs: this.lastReconcileMs,
      reconcileP95: p95,
      stepped: this.autoDropped,
    };
  }

  /** the world to RENDER (networked path): the local robot stays predicted (+ eased
   * error offset) for responsiveness; remote robots + balls are INTERPOLATED between
   * the two authoritative snapshots bracketing the render clock — Minecraft-style, so
   * they glide smoothly regardless of the 30 Hz snapshot rate or network jitter. */
  private displayWorld(dtMs: number): World {
    const local = (r: RobotState): RobotState =>
      ({
        ...r,
        pos: { x: r.pos.x + this.localSmooth.x, y: r.pos.y + this.localSmooth.y },
        heading: r.heading + this.localSmooth.heading,
      });
    // `z` is NOT smoothed: `localSmooth` is a 2D correction offset and a height error is not
    // a rubberbanding artifact — a robot pressed under a descending tray is where the server
    // says it is, and easing that would draw it inside the geometry.

    /**
     * PREDICTION `off` RENDERS THE LOCAL ROBOT LIKE A REMOTE (plan §5's first row).
     *
     * Not a special case in the interpolator — the ABSENCE of one. Everything below already
     * knows how to draw a robot from the two snapshots bracketing the render clock; all Off
     * does is stop exempting the local robot from it. That is what buys the mode its honesty:
     * what is on screen is what the server said, ~5 ticks ago, and nothing is guessed.
     */
    const predictLocal = !(this.predicted3d() && this.predictionMode === 'off');

    const buf = this.snapBuf;
    if (buf.length < 2) {
      // not enough history to interpolate yet — just apply local smoothing
      return {
        ...this.world,
        robots: this.world.robots.map((r) => (predictLocal && r.id === this.localRobotId ? local(r) : r)),
      };
    }

    // advance the interpolation clock at real-time rate, then gently pull it toward
    // (latest - delay) to absorb clock drift + snapshot jitter; clamp to the buffer.
    // The pull is a HALF-LIFE, not a per-frame fraction: a bare `* 0.1` each frame
    // converges at a rate that scales with the player's FPS, so the same network fed
    // a 144 Hz machine a clock yanked ~2.4x harder than a 60 Hz one — it chased jitter
    // instead of absorbing it, and high-refresh players saw MORE remote stutter than
    // everyone else on the identical connection. Matches SMOOTH_HALFLIFE's convention.
    const latest = buf[buf.length - 1].tick;
    const oldest = buf[0].tick;
    const dtSec = Math.min(dtMs / 1000, 0.1);
    this.renderTick += dtSec / C.SIM_DT;
    this.renderTick += (latest - INTERP_DELAY_TICKS - this.renderTick) * (1 - Math.pow(2, -dtSec / INTERP_EASE_HALFLIFE));
    this.renderTick = Math.max(oldest, Math.min(this.renderTick, latest));

    // find the pair of snapshots bracketing the render clock
    let s0 = buf[0];
    let s1 = buf[1];
    for (let i = buf.length - 2; i >= 0; i--) {
      if (buf[i].tick <= this.renderTick) {
        s0 = buf[i];
        s1 = buf[i + 1];
        break;
      }
    }
    const span = s1.tick - s0.tick;
    const a = span > 0 ? Math.max(0, Math.min(1, (this.renderTick - s0.tick) / span)) : 0;
    const r0 = new Map(s0.robots.map((r) => [r.id, r] as const));
    const r1 = new Map(s1.robots.map((r) => [r.id, r] as const));

    // ONLY remote robots interpolate in a 2D-physics world. Balls there are rendered
    // straight from the predicted sim: they're fast, spawn/despawn (launches), and collide —
    // interpolating them ghosts a freshly-spawned ball between its predicted and past
    // positions and lerps colliding balls THROUGH each other (the "blend"). Predicted balls
    // stay accurate. A 3D-physics world is the exception, and `snapBuf`'s header says why.
    const robots = this.world.robots.map((r) => {
      if (r.id === this.localRobotId && predictLocal) return local(r); // predicted, responsive
      const p = r0.get(r.id);
      const q = r1.get(r.id);
      if (!p || !q) return r; // just spawned/left the buffer — fall back to predicted
      return {
        ...r,
        pos: { x: lerp(p.x, q.x, a), y: lerp(p.y, q.y, a) },
        // `z` only where the world HAS one. Writing `z: 0` into a 2D world's robots would put
        // a key on every rendered robot that the 2D path never carried, which is a change to
        // what `drawRobot` sees for a game that has nothing to do with this.
        ...(this.interp3d() ? { z: lerp(p.z, q.z, a) } : null),
        heading: lerpAngle(p.heading, q.heading, a),
      };
    });
    if (!this.interp3d()) return { ...this.world, robots };

    /**
     * ELEMENTS, in a 3D-physics world only.
     *
     * Three guards, each of which is a bug if it is missing:
     *  · an id absent from either bracketing snapshot falls back to the predicted ball. It
     *    cannot happen while the count is conserved, which is exactly why it must not be
     *    ASSUMED — a future rule that spawns one would otherwise draw it at the origin.
     *  · a `state.kind` change SNAPS to the newer pose — but ONLY when `held` or `stock` is one
     *    of the two kinds. ⚠️ It used to snap on ANY kind change, which is wrong for a game
     *    whose tags are DERIVED from body positions every tick (`derive.ts`): `ground`,
     *    `flight` and `element` all describe the SAME continuously-moving sphere, and a skidding
     *    missed shot re-tags `flight`/`ground`/`flight` on consecutive ticks with its position
     *    moving smoothly the whole way. Every one of those flickers threw the element two ticks
     *    forward and then froze it for a frame — measured, the worst frame-to-frame jump any
     *    element made was **2.61 in against a true per-tick motion of 1.34**, i.e. a pop of
     *    nearly twice the distance it was actually travelling, on a ball nobody had touched.
     *    Narrowed to the two kinds that genuinely TELEPORT (into a hopper, into a human player's
     *    hand) the worst jump is **1.36 in**, which is the real motion and nothing else.
     *  · `held` and `stock` elements are left ALONE. Their position is written every tick by
     *    the thing carrying them, not by the solve, so the predicted value is the correct one
     *    and a stale snapshot pose would drag them behind their own robot.
     */
    const b0 = new Map(s0.balls.map((b) => [b.id, b] as const));
    const b1 = new Map(s1.balls.map((b) => [b.id, b] as const));
    // released this frame, per the branch below: `drawPredictedElements` must not ease FROM here
    const released = new Set<number>();
    const predicted = new Set((this.predictor?.elements() ?? []).map((e) => e.id));
    const balls = this.world.balls.map((ball) => {
      if (ball.state.kind === 'held' || ball.state.kind === 'stock') return ball;
      const p = b0.get(ball.id);
      const q = b1.get(ball.id);
      if (!p || !q) return ball;
      /**
       * ⚠️ JUST RELEASED, AND THE INTERPOLATION HAS NOT SEEN IT YET. The newest snapshot says the
       * ball is loose, but the snapshot the render clock is heading for (~5 ticks older) still
       * says `held`, and a held ball's pose there is not where it will leave from. Lerping the
       * two drew a fresh shot for a split second back where it was intaken (owner report
       * 2026-09-24). So it stays CARRIED — hidden, with that snapshot's own state — until the
       * render clock reaches the release, which is also the moment an interpolated robot fires
       * it. The one exception is a ball the predictor already has (the local robot's own shot):
       * `drawPredictedElements` draws that at the prediction's clock straight away.
       */
      if (isCarried(q.kind)) {
        released.add(ball.id);
        return predicted.has(ball.id) ? ball : { ...ball, pos: { x: q.x, y: q.y }, z: q.z, state: q.state };
      }
      if (p.kind !== q.kind && isCarried(p.kind)) {
        released.add(ball.id);
        return { ...ball, pos: { x: q.x, y: q.y }, z: q.z };
      }
      return {
        ...ball,
        pos: { x: lerp(p.x, q.x, a), y: lerp(p.y, q.y, a) },
        z: lerp(p.z, q.z, a),
      };
    });
    return { ...this.world, robots, balls: this.drawPredictedElements(balls, dtSec, released) };
  }

  /**
   * DRAW THE ELEMENTS THE PREDICTOR IS CARRYING AT THE PREDICTION'S OWN CLOCK — see `ballSmooth`
   * for the measurement this exists for.
   *
   * It runs only where the predictor has an opinion: a FULL predictor, and an element it holds a
   * body for whose tag says it is loose on the field (`ground`) or in the air (`flight`). An
   * `element` — seated in a FLOWER's bore or latched in a HIVE cell — stays on whichever clock it
   * arrived on. One that was already seated stays interpolated: the predictor only PINS it at the
   * newest snapshot's pose, so drawing it from there would step a tipping tray's contents at
   * 30 Hz. One that was being drawn PREDICTED when it landed stays predicted until it leaves the
   * predictor's set. ⚠️ It used to switch to the interpolated clock on the re-tag, and a shot the
   * predictor carried into a hive jumped back ~10 ticks up its own flight path as it landed.
   * A LIGHT predictor carries no elements at all and `elements()` returns null, so this is one
   * map lookup and out.
   */
  private drawPredictedElements(balls: Artifact[], dtSec: number, released: ReadonlySet<number>): Artifact[] {
    const pe = this.predictor?.elements();
    if (!pe && this.ballSmooth.size === 0 && this.ballDrawn.size === 0) return balls;
    const by = pe ? new Map(pe.map((e) => [e.id, e] as const)) : null;
    const k = Math.pow(2, -dtSec / SMOOTH_HALFLIFE);
    return balls.map((ball) => {
      const e = by?.get(ball.id);
      const kind = ball.state.kind;
      const use =
        !!e && (kind === 'ground' || kind === 'flight' || (kind === 'element' && this.ballPredicted.has(ball.id)));
      const base = use ? { x: e!.x, y: e!.y, z: e!.z } : { x: ball.pos.x, y: ball.pos.y, z: ball.z };
      let off = this.ballSmooth.get(ball.id) ?? null;
      // A SOURCE SWITCH is the one discontinuity `noteElementCorrection` cannot see: an element
      // crossing `PREDICT_ELEMENT_RADIUS`, or being re-tagged into or out of a structure, moves
      // between two legitimate answers that are ~`INTERP_DELAY_TICKS` apart. Absorb it whole.
      // a release is a real teleport out of a hopper, so it never eases from where it was drawn
      const prev = released.has(ball.id) ? undefined : this.ballDrawn.get(ball.id);
      if (prev && this.ballPredicted.has(ball.id) !== use) {
        off = { x: prev.x - base.x, y: prev.y - base.y, z: prev.z - base.z };
      }
      if (off && Math.hypot(off.x, off.y, off.z) > BALL_SWITCH_MAX) off = null;
      if (use) this.ballPredicted.add(ball.id);
      else this.ballPredicted.delete(ball.id);
      if (!off) {
        this.ballSmooth.delete(ball.id);
        if (!use) {
          // an interpolated ball is remembered too, or its switch INTO the prediction (a shot
          // entering the radius at speed) has no `prev` to ease from and jumps forward. A
          // carried one is not: it is hidden, and leaving a hopper is a real teleport.
          if (kind === 'held' || kind === 'stock') this.ballDrawn.delete(ball.id);
          else this.ballDrawn.set(ball.id, base);
          return ball;
        }
        this.ballDrawn.set(ball.id, base);
        return { ...ball, pos: { x: base.x, y: base.y }, z: base.z };
      }
      off = { x: off.x * k, y: off.y * k, z: off.z * k };
      this.ballSmooth.set(ball.id, off);
      const drawn = { x: base.x + off.x, y: base.y + off.y, z: base.z + off.z };
      this.ballDrawn.set(ball.id, drawn);
      return { ...ball, pos: { x: drawn.x, y: drawn.y }, z: drawn.z };
    });
  }

  /** adopt the authoritative world, discard inputs it already reflects, and
   * re-predict forward by replaying the local inputs (and held remote commands)
   * past the snapshot tick */
  /** queue the authoritative NEW events from a reconciled snapshot (see `netEvents`).
   * The snapshot's `events` is the full monotonic server log; show only the tail past
   * what we've already surfaced. On the FIRST snapshot we adopt the history silently
   * (a mid-match joiner/spectator shouldn't get a burst of past phase banners), and a
   * shrink means a fresh match/server → resync from zero. */
  /**
   * The authoritative event log, diffed by ABSOLUTE INDEX into `world.events`.
   *
   * ⚠️ THE SHRINK GUARD BELOW COVERS A RESET, NOT A TRUNCATION, AND THE DIFFERENCE IS SILENT.
   * It exists so a world REPLACEMENT (a rejoin keyframe, a restart, a rematch) re-emits the log
   * from the start instead of being skipped. It does NOT make this function safe against a
   * server that CAPS the log: a ring buffer at K makes `evs.length` SATURATE at K rather than
   * shrink (one pushed, one dropped ⇒ K stays K), so `evs.length < shownEventCount` never
   * fires, the two stay equal at K, and the loop below never runs again — every event after
   * the Kth is permanently never shown, with nothing logged and nothing thrown.
   *
   * Measured (Sept 2026, full 2v2 matches to `post`): a cap at 64 would save 0 bytes in DECODE
   * solo, CR solo and CR 2v2 — the log never reaches 64 in any of them — and 13.5% of the raw
   * frame in a foul-heavy DECODE 2v2, while silently discarding 99 of that match's 163 toasts.
   * So a cap is not worth building here, and if one is ever wanted anyway it has to ship a DROP
   * COUNT on the wire (`eventsBase`) that this function adds to `evs.length`, which is a
   * protocol change and `CLIENT_CAPS` work, not a one-liner.
   */
  private collectNetEvents(first: boolean): void {
    const evs = this.world.events;
    if (evs.length < this.shownEventCount) this.shownEventCount = 0;
    if (first) {
      this.shownEventCount = evs.length;
      return;
    }
    for (let i = this.shownEventCount; i < evs.length; i++) this.netEvents.push(evs[i]);
    this.shownEventCount = evs.length;
  }

  private reconcile(snap: Snapshot): void {
    const firstSnap = !this.gotSnapshot;
    // counted for the read-out's CORRECTIONS row. A count on its own says little; beside the
    // last correction's DISTANCE it is what separates "the server agrees with me 30 times a
    // second" from "the server is dragging me back 30 times a second".
    this.reconciles++;
    // VISUAL error smoothing (rubberbanding fix): capture where the LOCAL robot is
    // currently rendered (predicted pos + the decaying offset). After we snap to
    // the authoritative world below, we set `localSmooth` so the RENDERED position
    // stays continuous, then it eases to the real position over ~1 decay in the
    // render loop — so a late/uneven snapshot glides instead of teleporting. Purely
    // cosmetic: it never touches `this.world`, so determinism/anti-cheat are intact.
    const pre = this.world.robots.find((r) => r.id === this.localRobotId);
    const preX = pre ? pre.pos.x + this.localSmooth.x : 0;
    const preY = pre ? pre.pos.y + this.localSmooth.y : 0;
    const preH = pre ? pre.heading + this.localSmooth.heading : 0;

    this.adoptWorld(snap.world);
    this.collectNetEvents(firstSnap); // authoritative events, BEFORE replay re-emits any
    this.lastServerTick = snap.serverTick;
    this.gotSnapshot = true;
    this.inputBuf = this.inputBuf.filter((b) => b.tick > snap.serverTick);
    // Defensive replay bound: with the lead cap the buffer stays small, but never
    // replay more than MAX_PREDICT_LEAD ticks synchronously (a stale/duplicate old
    // snapshot must not stall the frame). Older inputs are already reflected.
    if (this.inputBuf.length > MAX_PREDICT_LEAD) {
      this.inputBuf.splice(0, this.inputBuf.length - MAX_PREDICT_LEAD);
    }
    /**
     * THE ONE LINE THIS WHOLE DAY IS ABOUT.
     *
     * 2D room ⇒ replay the buffered inputs through the WHOLE game step, exactly as before, so
     * every existing hash and every existing feel is untouched. 3D room ⇒ re-step them through
     * the chosen predictor instead, which answers the only question a reconcile asks (where is
     * MY robot now) at a fraction of forty `step3d` calls. Everything downstream — the
     * `localSmooth` correction below, `displayWorld`, the render loop — is identical either way.
     */
    if (this.predicted3d()) this.replayThroughPredictor(snap.serverTick);
    else for (const b of this.inputBuf) this.mod.step(this.world, C.SIM_DT, this.cmdMap(b.cmd));

    const post = this.world.robots.find((r) => r.id === this.localRobotId);
    if (pre && post) {
      let dx = preX - post.pos.x;
      let dy = preY - post.pos.y;
      let dh = Math.atan2(Math.sin(preH - post.heading), Math.cos(preH - post.heading));
      this.lastCorrection = Math.hypot(dx, dy);
      // a genuinely large correction (desync/teleport) should SNAP, not float far
      // behind for a beat — only smooth sub-robot-scale errors
      if (Math.hypot(dx, dy) > SMOOTH_MAX_DIST) {
        dx = 0;
        dy = 0;
        dh = 0;
      }
      /**
       * OFF SMOOTHS NOTHING, because there is nothing to smooth: the local robot is not
       * predicted, so `pre` and `post` are two consecutive AUTHORITATIVE positions and their
       * difference is real movement, not error. Carrying it as an offset would drag the robot
       * a snapshot behind where it is already being drawn a snapshot behind.
       */
      if (this.predicted3d() && this.predictionMode === 'off') {
        this.localSmooth = { x: 0, y: 0, heading: 0 };
      } else {
        this.localSmooth = { x: dx, y: dy, heading: dh };
      }
    }
  }

  /** host-authored restart arrived over the net: rebuild from the new seed */
  private rebuildFromNet(): void {
    this.audio.stopSpeech();
    this.adoptWorld(this.makeWorld());
    this.prevPhase = this.world.match.phase;
    this.warningPlayed = false;
    this.matchOverAt = null;
    this.settle = newSettleClock();
    this.settleDone = false;
    this.hudCountdown = null;
    this.frontFlipped = false;
    this.parked = false;
    this.acc = 0;
    this.inputBuf = [];
    this.remoteCmds = new Map();
    this.lastServerTick = 0;
    this.gotSnapshot = false;
    this.shownEventCount = 0;
    this.netEvents = [];
    this.snapBuf = [];
    this.renderTick = 0;
    this.localSmooth = { x: 0, y: 0, heading: 0 };
    this.clearElementSmoothing();
    // A REMATCH IS A NEW MATCH, so it gets a new probe and a new slip window. The predictor is
    // dropped rather than reset: `reset` re-seats bodies against a world, and the world it was
    // built from has just been replaced.
    this.predictTick = 0;
    this.lastCorrection = 0;
    this.reconcileMs.length = 0;
    this.autoProbed = false;
    this.autoProbeMs = null;
    this.autoDropped = false;
    this.disposePredictor();
    if (this.predictionPref === 'auto') this.predictionMode = 'light';
    this.seedActionAudio();
    this.toasts = [];
  }

  /** RECORD runs: route the restart binding to a full new run. Passing null (the
   * default) leaves it inert, so a versus match can't reach it. */
  setRestartRequest(cb: (() => void) | null): void {
    this.restartRequestCb = cb;
  }

  /**
   * The rematch tally, or null when no vote is in play here.
   *
   * `need <= 1` is the same as no vote: a solo record run is one driver, and asking
   * one person to agree with themselves is a button, not a ballot — that run keeps
   * its ⟲ NEW RUN control instead. Everything else (versus, ranked, custom, duo
   * record) has two or more drivers and votes.
   *
   * This used to be a `coop` flag the UI had to SET on the controller. It no longer
   * needs to: the server already broadcasts `need`, which answers the same question
   * without anyone having to remember to pass it.
   */
  private rematchTally(): { votes: number; need: number; mine: boolean } | null {
    const v = this.session?.rematchVote?.() ?? null;
    return v && v.need > 1 ? v : null;
  }

  /** toggle our rematch vote (the on-screen button; the R binding does the same) */
  toggleRematch(): void {
    const v = this.session?.rematchVote?.();
    this.session?.setRematch?.(!(v?.mine ?? false));
  }

  /**
   * Trigger the pre-match countdown (the START key, or a UI button).
   *
   * Solo only — in multiplayer the HOST starts the room and the sim countdown arrives with the
   * authoritative world. It REBUILDS the world before starting, which is what lets the run be
   * recorded: the recording then begins at tick 0 of a world `ReplayPlayer` can reconstruct
   * from `{seed, setups}` alone. The rebuild is invisible — `robotsEnabled` is false in `pre`
   * so nothing has moved, and the seed is reused so the motif and the field are unchanged.
   */
  startMatch(): void {
    if (this.session) return; // the room's host owns the start
    /**
     * A TUTORIAL IS NEVER RECORDED, and this is the belt to the braces.
     *
     * It runs in free drive, whose phase is `freeplay`, so the guard below already returns — but
     * the reason matters enough to be stated where somebody would change it: a step's situation is
     * STAGED onto the world, and a replay rebuilds a run from `{seed, setups, commands}` alone.
     * Recording a staged world would produce a replay that plays back a different situation from
     * the one the player drove, which is worse than keeping nothing.
     */
    if (this.tutorial) return;
    if (this.world.match.phase !== 'pre') return;
    if (this.world.match.preCountdown != null) return; // already counting down
    this.adoptWorld(this.makeWorld(false));
    this.world.match.preCountdown = C.PRE_COUNTDOWN;
    this.prevPhase = this.world.match.phase;
    this.practice = null;
    // free drive never reaches `pre`, so this is a solo PRACTICE match by construction
    // STAMPED WITH WHAT THE REBUILT WORLD ACTUALLY RUNS ON, read off the world rather than
    // off `settings.practicePhysics`: the two can differ for one whole run, because a failed
    // 3D chunk load falls the session back to 2D without touching the stored setting (see
    // `physicsFallbackNotice`). Stamping the setting would file that run as a 3D one and it
    // would re-simulate into a different match than the player played.
    this.recorder = new ReplayRecorder(
      this.soloSeed,
      this.soloSetups,
      'match',
      this.gameId,
      this.interp3d() ? '3d' : '2d',
    );
    this.drivenTicks = 0;
    this.settle = newSettleClock();
    this.settleDone = false;
    this.lastBeepAt = -1;
  }

  /** restart with the same settings (new random seed / motif) */
  restart(): void {
    this.audio.stopSpeech();
    if (this.world.match.phase === 'auto' || this.world.match.phase === 'teleop') {
      this.audio.play('abort');
    }
    // BEFORE the rebuild, both because the run is scored against the world it happened in and
    // because `makeWorld` is the moment it becomes unrecoverable.
    // RESET inside the settle (between the buzzer and the field coming to rest) lands here
    // rather than on the completed path, and that is right: the driver cut the settle short, so
    // the field never came to rest and the score is the partial one. It is still KEPT — a whole
    // match is far past `PRACTICE_SAVE_MIN_S`, so the policy answers `long-enough` instead of
    // `completed` — and `this.practice` is cleared below anyway, because a restart has no
    // results screen to show it on.
    this.harvestPracticeRun(false);
    this.adoptWorld(this.makeWorld());
    this.prevPhase = this.world.match.phase;
    this.warningPlayed = false;
    this.matchOverAt = null;
    this.settle = newSettleClock();
    this.settleDone = false;
    this.hudCountdown = null;
    // `harvestPracticeRun` above has already closed the recorder and either kept the run or
    // dropped it; these clear whatever it left, so the next `startMatch` opens a fresh recorder
    // on the rebuilt world. A RESTART is still not a replay of a MATCH — it is now a replay of
    // the DRIVING, which is what a practice replay was always for (see `replaySavePolicy`).
    this.recorder = null;
    this.practice = null;
    this.drivenTicks = 0;
    this.frontFlipped = false;
    this.parked = false;
    this.seedActionAudio();
    this.toasts = [];
  }

  /** REMATCH: SOLO only — rebuild locally with a fresh seed/motif. Multiplayer has
   * no rematch (it re-authored the match for everyone and desynced on rebuild);
   * networked players return to the lobby to queue a fresh match. */
  rematch(): void {
    if (this.session) return; // multiplayer: no-op (UI hides the button)
    this.restart();
  }

  /** multiplayer session? (UI gates RESET / host-only REMATCH on this) */
  isNetworked(): boolean {
    return this.session !== null;
  }

  /** the server's authoritative end-of-match result (score + recorded replay),
   * or null in solo / before phase 'post' */
  getMatchResult(): MatchResultInfo | null {
    return this.session?.getMatchResult() ?? null;
  }

  /**
   * The finished SOLO PRACTICE run, or null (mid-match, free drive, or multiplayer).
   *
   * Deliberately NOT folded into `getMatchResult`. That is documented as the SERVER's
   * authoritative end-of-match payload, and a locally produced one would be a claim this
   * client is in no position to make — a practice run is exactly the thing nothing
   * authoritative counted. Keeping them apart is what lets the results screen offer the replay
   * without ever implying the score was witnessed.
   */
  getPracticeRun(): { replay: Replay; result: ReplayResult } | null {
    return this.practice;
  }

  /** a record run's leaderboard standing (PB / WR / rank), or null until the
   * server's recordResult lands (record runs only) */
  getRecordResult(): RecordRankInfo | null {
    return this.session?.getRecordResult?.() ?? null;
  }

  /** ranked pre-match intro roster (name/team/drivetrain + ELO per driver), or
   * null for solo / free drive / non-ranked custom rooms. Drives the RankedIntro
   * overlay. Fixed for one match, but a rematch's `matchStart` carries new ratings, so the UI
   * re-reads it whenever a match enters its countdown. */
  getIntro(): IntroPlayer[] | null {
    const s = this.session;
    if (!s || !s.ranked) return null;
    return s.setups.map((su) => ({
      robotId: su.id,
      name: su.spec.name,
      teamName: su.spec.teamName,
      teamNumber: su.spec.teamNumber,
      drivetrain: su.spec.drivetrain,
      alliance: su.alliance,
      elo: s.intros.find((it) => it.id === su.id)?.elo ?? null,
      isLocal: su.id === this.localRobotId,
    }));
  }

  /** ranked results-screen ELO changes (before → after per driver), or null until
   * the server's `eloResult` lands after the match is scored. Sorted red-then-blue
   * to match the intro/results layout. */
  getEloResults(): EloResultRow[] | null {
    const s = this.session;
    if (!s || !s.ranked || s.eloResults.length === 0) return null;
    const rows = s.eloResults.map((d) => {
      const su = s.setups.find((x) => x.id === d.robotId);
      return {
        robotId: d.robotId,
        name: su?.spec.name ?? 'Driver',
        alliance: su?.alliance ?? ('red' as Alliance),
        before: d.before,
        after: d.after,
        isLocal: d.robotId === this.localRobotId,
        provisional: d.games < C.PLACEMENT_GAMES, // still in placements (games-based)
        games: d.games,
      };
    });
    return rows.sort((a, b) => (a.alliance === b.alliance ? 0 : a.alliance === 'red' ? -1 : 1));
  }

  getHud(): HudSnapshot {
    const w = this.world;
    const r = this.localRobot();
    const a = this.viewAlliance();
    const opp: Alliance = a === 'blue' ? 'red' : 'blue';
    const goal = w.goals[a];
    // Chain Reaction scoring readout (present only for CR worlds)
    const chain: HudSnapshot['chain'] = w.chain
      ? {
          scored: w.chain.scored[a],
          oppScored: w.chain.scored[opp],
          mult: chainAccelMultiplier(w.chain, a),
          oppMult: chainAccelMultiplier(w.chain, opp),
          catalysts: w.chain.catalysts.filter((c) => c.hook?.alliance === a).length,
          oppCatalysts: w.chain.catalysts.filter((c) => c.hook?.alliance === opp).length,
          particlePts: w.chain.particlePoints[a],
          oppParticlePts: w.chain.particlePoints[opp],
          endgame: w.chain.endgame[this.localRobotId] ?? 'none',
          carrying: w.chain.catalysts.some((c) => c.carriedBy === this.localRobotId),
          ringAction: chainCatalystPrompt(w.chain, r)?.action ?? null,
          storage: chainHopperCap(r.spec),
          mode: r.spec.scoreMode ?? 'turret',
          foulPts: w.match.scores[a].foulPoints,
          oppFoulPts: w.match.scores[opp].foulPoints,
        }
      : undefined;
    const mod = gameOf(w);
    return {
      game: w.game ?? 'decode',
      physics: this.interp3d() ? '3d' : '2d',
      prediction: this.getPredictionStats(),
      gameHud: mod.hud?.(w, this.localRobotId),
      chain,
      mode: w.mode,
      phase: w.match.phase,
      timeLeft: Math.max(0, w.match.phaseTimeLeft),
      alliance: a,
      motif: w.motif,
      score: w.match.scores[a],
      oppTotal: w.match.scores[opp].total,
      oppScore: w.match.scores[opp],
      provisionalPattern: w.match.provisionalPattern[a],
      fouls: { red: { ...w.match.fouls.red }, blue: { ...w.match.fouls.blue } },
      card: w.penalties.carded[r.id] ?? null,
      voided: w.match.scores[a].voided ?? false,
      fieldCentric: r.fieldCentric,
      aimAssist: r.aimAssist,
      autoIntake: r.autoIntake,
      autoFire: r.autoFire,
      catalystFling: w.game === 'chain' && chainCatalystGeom(r.spec).fling,
      hopper: [...r.hopper],
      powerDraw: r.powerDraw,
      inLaunchZone: w.mode === 'free' || robotInLaunchZone(r),
      gamepadConnected: this.input.gamepadConnected,
      frontFlipped: this.frontFlipped,
      butterflyMode:
        r.spec.drivetrain === 'butterfly' ? (r.butterflyTank ? 'tank' : 'mecanum') : null,
      parked: this.parked,
      canPark: this.canPark(),
      gateOpen: goal.gateOpen,
      gateForced: w.penalties.gateCulprit[a] !== null,
      rampCount: w.balls.filter(
        (b) => b.state.kind === 'rail' && b.state.goal === a && !b.state.overflow,
      ).length,
      classifiedCount: goal.classifiedCount,
      overflowCount: goal.overflowCount,
      countdown: this.hudCountdown,
      resultFinal: w.match.phase === 'post' && this.settleDone,
      resultLost:
        w.match.phase === 'post' &&
        !this.settleDone &&
        !!this.session &&
        (this.session.status().failed ||
          (this.matchOverAt !== null &&
            performance.now() - this.matchOverAt > RESULT_LOST_AFTER_S * 1000)),
      toasts: [...this.toasts],
      net: this.session ? this.session.status() : null,
      spectators: this.session?.spectatorCount?.() ?? 0,
      rematch: this.rematchTally(),
      tutorial: this.getTutorial(),
      auto: this.autoStatus(),
    };
  }

  /**
   * CLOSE THE RUN IN FLIGHT AND KEEP IT IF `replaySavePolicy` SAYS SO.
   *
   * The one place a practice recording ends. Every exit from a solo run routes here — the match
   * reaching `post`, a RESET/REMATCH, and leaving the screen — so the question "was that worth
   * keeping" is answered once, by a module with no DOM and no controller state, instead of
   * being re-decided at each call site. That is the replay save policy this was asked for.
   *
   * `completed` is not a synonym for "keep": it is the FACT the policy is handed, and the
   * policy decides. Today a completed run is always kept and an abandoned one needs
   * `PRACTICE_SAVE_MIN_S` of driving; changing either is one line there and none here.
   *
   * `this.practice` is set ONLY for a completed run, because that is what `getPracticeRun()`
   * feeds the RESULTS SCREEN, and an abandoned run has no results screen to appear on — the
   * caller either rebuilds the world immediately or is unmounting. The SAVE happens through
   * `onPracticeRun` either way, and that is the path that writes the device and queues the
   * upload.
   */
  private harvestPracticeRun(completed: boolean): void {
    const recorder = this.recorder;
    if (!recorder) return;
    // closed before the branch: kept or not, the run is over, and a recorder left open would
    // keep appending to a run whose world is about to be thrown away.
    this.recorder = null;
    const replay = recorder.finish();
    const decision = practiceSaveDecision({ drivenTicks: this.drivenTicks, completed });
    this.drivenTicks = 0;
    if (!decision.keep) return;
    const kept = { replay, result: worldResult(this.world) };
    if (completed) this.practice = kept;
    this.onPracticeRun?.(kept.replay, kept.result);
  }

  dispose(): void {
    this.disposed = true;
    // LEAVING THE SCREEN USED TO LOSE THE RUN SILENTLY — `dispose` never touched the recorder
    // at all, so a driver who practised for a minute and hit MENU had nothing to show for it.
    // Safe during an unmount: `onPracticeRun` writes localStorage and queues an upload, and
    // sets no React state (see `keepPracticeRun` in `src/ui/App.tsx`).
    this.harvestPracticeRun(false);
    this.audio.stopSpeech();
    this.audio.stopKeepAlive();
    // the solo AI seats: the caller owns their memory, so the caller gives it back
    this.seatBots(this.world, this.soloSeed, new Map());
    cancelAnimationFrame(this.raf);
    if (this.simTimer) window.clearInterval(this.simTimer);
    this.input.detach();
    window.removeEventListener('resize', this.onResize);
    this.canvasObserver?.disconnect();
    this.hudBandObserver?.disconnect();
    this.hudBandMutations?.disconnect();
    this.observedBands.clear();
    this.unsubscribeViewPref();
    this.unsubscribePredictionPref();
    // a FULL predictor owns a Rapier world; leaking one per match leaks wasm memory for the
    // life of the tab, which is exactly as long as somebody plays
    this.disposePredictor();
    // ...and so does the MATCH's own 3D solve, which nothing freed until now — see
    // `adoptWorld`. The predictor's world was the one anybody thought of, because it is created
    // here; the match's is created inside `step3d` and held in a `WeakMap`, which is precisely
    // why it was invisible.
    disposePhysics3dFor(this.world);
    this.teardownScene();
  }
}