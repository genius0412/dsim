import type { Alliance, GameId, GameMode, MatchPhase, Physics, RobotCommand, RobotSpec, World, AutoPathData, StartPose } from '../types';
import * as C from '../config';
import { DEFAULT_ASSISTS, type RobotSetup } from './spawn';
import { simModuleFor } from '../games/sim';
import { MATCH_SETTLE_MAX_S } from './settle';
import {
  dequantizeCommand,
  localizeCommand,
  quantizeCommand,
  type QCommand,
} from '../net/protocol';
import { worldHash } from '../net/checksum';
import { REPLAY_FORMAT_IMPORTED, REPLAY_FORMAT_TUNED, setupsHaveImported, setupsHaveTune } from '../net/imported';

/**
 * Deterministic REPLAYS + record-chasing (score-attack) scaffolding — Phase 3
 * foundation (docs/netcodeplan.md). A replay is NOT video/snapshots: it is the
 * seed + robot setups + a hold-last-compressed per-tick command log. Because the
 * sim is a pure, command-driven state machine, re-running `step()` over that log
 * reproduces the match byte-for-byte — which makes replays (a) tiny (~10–30 KB),
 * (b) a continuous determinism check, and (c) the server's anti-cheat verifier
 * (re-simulate a submitted replay, trust only the score IT computes).
 *
 * Determinism rule (from net/protocol.ts): the sim must step on the value the
 * wire round-trips (`localizeCommand`), so a captured command re-simulates to
 * the same result. `runRecordMatch`/`ReplayRecorder` localize + quantize on the
 * same lattice, so record → simulate is exact. A record run is fully SIM-DRIVEN
 * (preCountdown → auto → transition → teleop → post), so no controller state
 * leaks in — {seed, setups, commands} alone reproduce it.
 */

const ZERO_CMD: RobotCommand = { driveX: 0, driveY: 0, rotate: 0, leftDrive: 0, rightDrive: 0, intake: false, fire: false };
const ZERO_Q: QCommand = { dx: 0, dy: 0, rot: 0, buttons: 0 };

/**
 * Bump on a change to the replay container schema.
 *
 * 2: command entries carry the TANK AXES (`ld`/`rd`). Format 1 stored only
 *    `[tick, dx, dy, rot, buttons]`, and tank drive is commanded EXCLUSIVELY through
 *    leftDrive/rightDrive (see robot.ts `saturation === 'tank'`) — so a tank or butterfly
 *    robot's entire drive input was thrown away and its replay played back with a dead
 *    drivetrain. The READER still understands format 1, so old replays keep playing.
 * 3: the container holds an IMPORTED ROBOT (`RobotSpec.imported`). The stride is format 2's; the
 *    number exists so a build that predates imports reads it as `'future'` and refuses to play
 *    it, instead of re-simulating a rectangle robot and showing a match that never happened.
 *    ⚠️ ONLY STAMPED WHEN A SETUP CARRIES AN IMPORT (`ReplayRecorder.finish`): every replay
 *    without one is still written as format 2, byte for byte as it was.
 * 4: an imported robot with PRACTICE TUNING (`ImportedRobot.tune`), which a format-3 build's coercer
 *    drops, so it would re-simulate the untuned robot. Stamped only then; format 3 is unchanged.
 */
export const REPLAY_FORMAT = 4;

/** what a container WITHOUT an imported robot is written as — the format before imports existed */
export const REPLAY_FORMAT_BASE = 2;

/** numbers per command entry, by container format. 1: [tick,dx,dy,rot,buttons] ·
 *  2: + [ld,rd] */
export const trackStride = (format: number): number => (format >= 2 ? 7 : 5);

/**
 * One robot's command timeline, HOLD-LAST compressed: a flat number array of
 * 5-tuples `[tick, dx, dy, rot, buttons]`, one entry only when the quantized
 * command CHANGES. The command in effect at any tick is the newest entry with
 * `entry.tick <= tick` (ZERO before the first). Flat numbers (not objects) keep
 * it compact and JSON-trivial.
 */
export type CommandTrack = number[];

export interface Replay {
  format: number; // REPLAY_FORMAT
  /** C.BALANCE_VERSION when recorded — a replay only re-sims exactly under its
   * own balance version's sim build (see config.ts BALANCE_VERSION) */
  balanceVersion: number;
  /**
   * C.SIM_VERSION when recorded — which sim BEHAVIOUR this log was captured
   * against. Separate from `balanceVersion` on purpose: a determinism fix moves
   * what `step()` produces without being a balance decision, and without this the
   * only options are resetting the competitive season over a bug fix or letting
   * stored replays re-simulate into a different game than the one that was
   * played. ABSENT ⇒ 0 (recorded before this existed), correctly read as "cannot
   * be replayed accurately on this build".
   */
  sim?: number;
  /** C.SIM_PATCH when recorded — a behaviour fix inside one `sim` that keeps older replays
   * playable (see `SIM_PATCH`). ABSENT ⇒ 0. */
  patch?: number;
  /** which game this replay is of — picks the sim module to re-simulate it (createWorld
   * + step). Absent on old replays ⇒ DECODE. */
  game?: GameId;
  /**
   * WHICH PHYSICS BACKEND THIS REPLAY WAS RECORDED UNDER (Day 1 seam,
   * `docs/biobuzz/plan-3d.md`). Re-simulating a replay must step the SAME physics it was
   * recorded with, or a re-sim of a `'3d'` match against `step2d` produces a different game
   * from the one that was played. Absent ⇒ `'2d'` — every replay recorded before the 3D solve
   * existed, which is the only physics any of them could have run.
   */
  physics?: Physics;
  mode: GameMode;
  seed: number;
  setups: RobotSetup[];
  /** total ticks recorded (== the final world.tick) */
  ticks: number;
  /** per-robot-id command track (absent id ⇒ ZERO the whole match) */
  tracks: Record<number, CommandTrack>;
}

/** when `SIM_PATCH` 1 reached the site — a build from then on ran it but did not stamp it */
const PATCH1_SITE_AT = Date.parse('2026-09-27T08:34:35Z');

/**
 * A replay the BROWSER kept (a local practice run or LAN archive) and saved at `savedAt`: an
 * unstamped one saved after patch 1 reached the site ran patch 1. Stored server rows are
 * backfilled by migration 0055 instead.
 */
export function withLocalPatch(r: Replay, savedAt: number | undefined): Replay {
  if (r.patch !== undefined || savedAt === undefined || savedAt < PATCH1_SITE_AT) return r;
  return { ...r, patch: 1 };
}

function packKey(q: QCommand): string {
  // dx/dy/rot/ld/rd ∈ [-127,127] (8 bits signed), buttons ∈ [0, 0xffff]; pack for cheap
  // change-detection (not stored — just an equality key).
  //
  // MULTIPLICATION, not bit shifts: five bytes is 40 bits and JS bitwise operators truncate
  // to 32, which would silently fold ld/rd out of the key. That is not a hypothetical — the
  // key omitted them entirely before, so a TANK robot (whose only drive input IS ld/rd) had
  // every change after its first look identical, and the recorder skipped all of them.
  //
  // ⚠️ THE BUTTONS RIDE ALONGSIDE, NOT INSIDE. They were `& 0xff` in the same number, and the
  // day the field grew to 16 bits (`BTN_BBRAMP`) that mask made a ramp press INVISIBLE to the
  // recorder: bit 256 masked to 0, the key never changed, the toggle was never written, and the
  // replay drove a robot whose ramp stayed folded. 40 + 16 bits is past a double's 53, so the
  // key is a string of the two halves rather than one number.
  const b = (n: number): number => n & 0xff;
  const axes = (((b(q.dx) * 256 + b(q.dy)) * 256 + b(q.rot)) * 256 + b(q.ld ?? 0)) * 256 + b(q.rd ?? 0);
  return `${axes}:${q.buttons & 0xffff}`;
}

/**
 * Captures a replay while a match is stepped. Feed it the SAME command map you
 * pass to `step()` each tick (already localized — see the determinism rule); it
 * records only the quantized changes per robot.
 */
export class ReplayRecorder {
  private readonly tracks = new Map<number, CommandTrack>();
  private readonly last = new Map<number, string>(); // robotId -> last recorded packKey
  private ticks = 0;

  constructor(
    readonly seed: number,
    readonly setups: RobotSetup[],
    readonly mode: GameMode = 'match',
    readonly game: GameId = 'decode',
    /** which physics backend the run being recorded is stepping (`Replay.physics`). Default
     *  `'2d'` so every existing caller records exactly what it always did. */
    readonly physics: Physics = '2d',
  ) {}

  /** record the command map applied at `tick` (1-based, == world.tick after the
   * step it drove). Only stores an entry when a robot's quantized command differs
   * from its last stored one (hold-last). */
  record(tick: number, commands: Map<number, RobotCommand>): void {
    this.ticks = tick;
    for (const s of this.setups) {
      const cmd = commands.get(s.id);
      const q = cmd ? quantizeCommand(cmd) : ZERO_Q;
      const key = packKey(q);
      if (this.last.get(s.id) === key) continue;
      this.last.set(s.id, key);
      let track = this.tracks.get(s.id);
      if (!track) {
        track = [];
        this.tracks.set(s.id, track);
      }
      track.push(tick, q.dx, q.dy, q.rot, q.buttons, q.ld ?? 0, q.rd ?? 0);
    }
  }

  finish(): Replay {
    const tracks: Record<number, CommandTrack> = {};
    for (const [id, t] of this.tracks) tracks[id] = t;
    return {
      // format 3 ONLY with an imported robot in the line-up; every other container is the format-2
      // container it was before imports (see REPLAY_FORMAT)
      format: setupsHaveTune(this.setups) ? REPLAY_FORMAT_TUNED : setupsHaveImported(this.setups) ? REPLAY_FORMAT_IMPORTED : REPLAY_FORMAT_BASE,
      balanceVersion: C.BALANCE_VERSION,
      sim: C.SIM_VERSION,
      patch: C.SIM_PATCH,
      game: this.game,
      // OMITTED when it is `'2d'`, never written as the string: absent already READS `'2d'`
      // everywhere, and a container that gained a key would no longer be byte-identical to
      // the one this build produced yesterday — which is exactly what the 2D-regression half
      // of the NET3D lane compares.
      physics: this.physics === '3d' ? '3d' : undefined,
      mode: this.mode,
      seed: this.seed,
      setups: this.setups.map((s) => ({
        ...s,
        spec: { ...s.spec },
        assists: { ...s.assists },
        autoPath: s.autoPath, // Include autoPath
        autoPathEnabled: s.autoPathEnabled, // Include autoPathEnabled
      })),
      ticks: this.ticks,
      tracks,
    };
  }
}

/**
 * WHAT is different about a container — five genuinely different situations, and the viewer
 * has to tell them apart because they mean different things to the person who clicked the
 * link. Three of them are FATAL and two are merely a DRIFT; `replayFidelity` below is what
 * sorts them, and this type carries only the reason.
 *
 *  • `future`     — recorded by a build NEWER than this one; the reader cannot parse it.
 *  • `balance`    — a different BALANCE_VERSION, i.e. robots perform differently now.
 *  • `behaviour`  — a different SIM_VERSION: same balance, changed physics/rules.
 *  • `unstamped`  — recorded before DSIM stamped SIM_VERSION at all, so which behaviour
 *                    produced it is genuinely UNKNOWN rather than known-different.
 *  • `tank`       — a FORMAT-1 replay of a tank-steered robot, whose drive input the
 *                    container had nowhere to store.
 */
export type ReplayRefusal = 'future' | 'balance' | 'behaviour' | 'unstamped' | 'tank';

/**
 * WHAT, if anything, differs between that container and this build — the ONE authority.
 * `replayFidelity` and `replayPlayable` are both derived from it, so there is never a second
 * description of this rule to disagree with.
 *
 * Two different questions, kept apart on purpose:
 *  • can we PARSE it — any format up to ours, since the reader still understands the older
 *    strides. A newer one from a future build we cannot read.
 *  • can we REPRODUCE it — the balance version has to match, or `step()` produces a
 *    different game than the one that was played.
 *
 * Plus one honest refusal: a FORMAT-1 replay of a tank-steered robot never had its drive
 * input recorded at all (the container had nowhere to put `ld`/`rd`). It parses and it
 * re-simulates, but it re-simulates a robot that sits still — so it is refused rather than
 * played back looking broken, which is indistinguishable from a bug in the sim.
 *
 * ⚠️ **THE FATAL TESTS COME FIRST, AND `tank` MUST PRECEDE THE SIM TEST.** A SIM mismatch is
 * only a drift (see `replayFidelity`), so if it were checked first then a format-1 tank replay
 * that ALSO predates the current SIM_VERSION — which is every one of them, format 1 being the
 * older container — would be reported as a drift and PLAYED, showing a robot that sits still.
 * The order is load-bearing, not stylistic.
 *
 * `unstamped` is a MESSAGE distinction, never a policy one: the version test stays exactly
 * `(r.sim ?? 0) !== simVersion`, so an absent stamp reads as a drift on any build past
 * SIM_VERSION 0 and as an exact match on one running 0, which is what it has always done.
 * Splitting it out changes only whether the viewer can say "recorded before we tracked this"
 * instead of naming a version the recorder never claimed.
 */
export function replayRefusal(
  r: Pick<Replay, 'format' | 'balanceVersion' | 'sim' | 'setups'>,
  balanceVersion: number,
  simVersion: number,
): ReplayRefusal | null {
  if (r.format > REPLAY_FORMAT) return 'future';
  if (r.balanceVersion !== balanceVersion) return 'balance';
  if (r.format < 2 && r.setups.some((s) => tankSteered(s.spec.drivetrain))) return 'tank';
  if ((r.sim ?? 0) !== simVersion) return r.sim === undefined ? 'unstamped' : 'behaviour';
  return null;
}

/**
 * How faithfully can this build re-run that container?
 *
 *  • `'ok'`     re-simulates exactly as recorded.
 *  • `'drift'`  PLAYS, but the sim has changed since it was recorded, so the ending may not
 *                land on precisely the saved score.
 *  • `'stale'`  cannot be played at all.
 *
 * **THE MIDDLE CASE IS THE POINT, and it was learned the hard way.** Gating playback on
 * SIM_VERSION as well as the season once marked every DECODE match of a whole live season
 * unavailable over a float-level determinism fix — a correction worth a point or two of drift
 * took away every replay on the board. A changed SIM_VERSION moves what `step()` produces,
 * which over a three-minute match can move a score, but the recording is still a valid input
 * log against the same physics, the same field and the same season: it is not a different
 * match, only a slightly different rounding of the same one. Showing it with a note is
 * strictly better than refusing it.
 *
 * A REFUSAL is therefore reserved for the cases where playback would be MEANINGLESS rather
 * than merely imprecise: a container this build cannot parse, a different SEASON
 * (BALANCE_VERSION) where the tuning constants themselves differ, and the format-1 tank
 * replay whose drive input was never recorded at all.
 *
 * The leaderboard figure always remains the authority — the server stored the score it
 * computed at the time and never re-derives it from a replay — so a drifting playback can
 * never restate a record.
 */
export type ReplayFidelity = 'ok' | 'drift' | 'stale';

/** the two situations that are a DRIFT rather than a refusal — both of them "the sim moved" */
const DRIFT_REASONS: ReadonlySet<ReplayRefusal> = new Set<ReplayRefusal>([
  'behaviour',
  'unstamped',
]);

export function replayFidelity(
  r: Pick<Replay, 'format' | 'balanceVersion' | 'sim' | 'setups'>,
  balanceVersion: number,
  simVersion: number,
): ReplayFidelity {
  const why = replayRefusal(r, balanceVersion, simVersion);
  if (!why) return 'ok';
  return DRIFT_REASONS.has(why) ? 'drift' : 'stale';
}

/**
 * Can it be PLAYED at all — exactly or with drift? This is the gate the viewer and BOTH
 * exports read, so a drifting replay can still be watched and still be downloaded. That is
 * deliberate: the video export is the one form that outlives the sim, so the moment a replay
 * starts to drift is exactly when saving it matters most.
 */
export function replayPlayable(
  r: Pick<Replay, 'format' | 'balanceVersion' | 'sim' | 'setups'>,
  balanceVersion: number,
  simVersion: number,
): boolean {
  return replayFidelity(r, balanceVersion, simVersion) !== 'stale';
}

/** drivetrains commanded through the TANK AXES — the ones a format-1 replay lost. Butterfly
 *  counts: half its life is tank mode, and that half was recorded as zeros. */
const tankSteered = (dt: RobotSpec['drivetrain']): boolean => dt === 'tank' || dt === 'butterfly';

/**
 * Plays a replay forward one tick at a time, rebuilding the exact world and
 * feeding the recorded (hold-last) commands. `world` is live for rendering; the
 * UI replay viewer drives this at 60 Hz, the verifier runs it to completion.
 */
/** one line the sim emitted, with WHEN — see `ReplayPlayer.log` */
export interface ReplayLogEntry {
  tick: number;
  text: string;
  phase: MatchPhase;
  /** seconds left in that phase when it landed */
  timeLeft: number;
}

export class ReplayPlayer {
  readonly world: World;
  /**
   * Every line the sim emitted, with the TICK it landed on — fouls, cards, the phase
   * transitions, LEAVE credits, all of it. `world.events` is the same list, but it is only a
   * list of strings: the live game drains it each frame into toasts and nothing ever needed
   * to know WHEN one of them happened. A replay does. "MINOR FOUL - BLUE +5 (G424)" with no
   * time against it cannot be seeked to, and a watcher asking why the score jumped at 1:12 is
   * asking exactly that question.
   *
   * Recorded here rather than in the viewer because both of the viewer's step loops — play
   * and seek — would otherwise have to wrap the call and stay in step with each other, and a
   * seek that stepped 4,000 ticks in one synchronous burst would stamp all 4,000 ticks'
   * events with the moment the seek finished.
   *
   * `world.events` is NOT drained: the world is the replay's own, nobody else reads it, and
   * emptying an array the sim owns to keep a local index tidy is a side effect this class has
   * no business having.
   */
  readonly log: ReplayLogEntry[] = [];
  private logged = 0; // how much of world.events has been stamped
  private readonly cursor: Record<number, number> = {}; // robotId -> next entry index
  private readonly current = new Map<number, RobotCommand>();
  private readonly mod; // CR vs DECODE re-sim module (createWorld/step)

  constructor(private readonly replay: Replay) {
    this.mod = simModuleFor(replay.game);
    // THE CONTAINER'S physics, not this build's preference — re-simulating a `'3d'` log
    // against `step2d` reproduces a different match from the same inputs, which is the one
    // thing a replay may never do. Absent reads `'2d'`, which every pre-Day-2 container is.
    //
    // ⚠️ A `'3d'` replay needs the 3D physics module RESOLVED before this constructor runs —
    // `createWorld` only stages it, but `stepOnce` steps it on the very next call. The viewer
    // awaits `initPhysics3d()` (see `ReplayView`); a headless caller awaits it at the top of
    // its script, exactly as it already awaits `initPhysics()`.
    this.world = this.mod.createWorld(
      replay.mode,
      replay.seed,
      replay.setups,
      undefined,
      replay.physics ?? '2d',
    );
    if (replay.mode === 'match') this.world.match.preCountdown = C.PRE_COUNTDOWN;
    // the rules this log was RECORDED under — an unstamped replay predates `SIM_PATCH` 1
    this.world.simPatch = replay.patch ?? 0;
    for (const s of this.replay.setups) this.current.set(s.id, { ...ZERO_CMD });
  }

  get done(): boolean {
    return this.world.tick >= this.replay.ticks;
  }

  /** advance exactly one tick; false once fully played */
  stepOnce(): boolean {
    if (this.done) return false;
    const tick = this.world.tick + 1;
    for (const s of this.replay.setups) {
      const track = this.replay.tracks[s.id];
      if (!track) continue;
      let ei = this.cursor[s.id] ?? 0;
      // the stride is the CONTAINER's, not this build's — a format-1 replay has no tank
      // axes stored and reads them as zero, which is exactly what it recorded
      const stride = trackStride(this.replay.format);
      const entries = Math.floor(track.length / stride);
      // apply every entry that has come due (normally 0 or 1 per tick)
      while (ei < entries && track[ei * stride] <= tick) {
        const q: QCommand = {
          dx: track[ei * stride + 1],
          dy: track[ei * stride + 2],
          rot: track[ei * stride + 3],
          buttons: track[ei * stride + 4],
          ld: stride >= 7 ? track[ei * stride + 5] : 0,
          rd: stride >= 7 ? track[ei * stride + 6] : 0,
        };
        this.current.set(s.id, dequantizeCommand(q));
        ei++;
      }
      this.cursor[s.id] = ei;
    }
    this.mod.step(this.world, C.SIM_DT, this.current);
    const evs = this.world.events;
    for (; this.logged < evs.length; this.logged++) {
      // the PHASE and the clock are stamped with it, because "1:23 into the file" is not how
      // anybody reads a match — a call lands in AUTO with 4 seconds left, or in the last ten
      // of ENDGAME, and that is the sentence a watcher wants back
      this.log.push({
        tick: this.world.tick,
        text: evs[this.logged],
        phase: this.world.match.phase,
        timeLeft: Math.max(0, Math.round(this.world.match.phaseTimeLeft)),
      });
    }
    return true;
  }
}

/**
 * WHOSE VIEW a replay is watched from: the robot to highlight as "yours", and the
 * alliance whose driver station the camera sits behind.
 *
 * This is not cosmetic polish. The camera rotates a full 180° between alliances
 * (`viewAngleOf`: red +π/2, blue −π/2), so watching your own match from the other
 * side shows every robot on the wrong end of the field driving the wrong way —
 * indistinguishable, to the person who played it, from the replay having
 * diverged. The viewer defaulted to `setups[0]`, and a matchmaker-staged roster
 * always puts red at index 0, so it was right for exactly half the players in
 * every 1v1 and wrong for the other half — including which robot got labelled as
 * theirs. Two people watching the same replay saw mirror images of each other.
 *
 * `viewerRobotId` is the robot the watcher actually drove. Absent (a leaderboard
 * replay by someone who wasn't in the match, an old link) falls back to the first
 * setup, which is correct for the opponent-free record runs that make up the
 * boards — those have one alliance on the field.
 */
export function replayViewpoint(
  setups: RobotSetup[],
  viewerRobotId?: number | null,
): { robotId: number; alliance: Alliance } {
  const me =
    (viewerRobotId != null ? setups.find((s) => s.id === viewerRobotId) : undefined) ?? setups[0];
  return { robotId: me?.id ?? 0, alliance: me?.alliance ?? 'blue' };
}

/** re-simulate a replay to completion and return the final world (playback +
 * verification share this). Deterministic: identical to the recorded run on the
 * same balance version. */
export function simulateReplay(replay: Replay): World {
  const p = new ReplayPlayer(replay);
  while (p.stepOnce());
  return p.world;
}

export interface ReplayResult {
  /** each alliance's final total (the record score is the run alliance's) */
  score: Record<Alliance, number>;
  /** each alliance's penalty POINTS (points it was AWARDED from the opponent's
   * fouls). In an opponent-free record run these belong to the empty opposing
   * alliance and represent the fouls the PLAYER committed — subtracted from the
   * player's score by `recordScore()`. */
  foulPoints: Record<Alliance, number>;
  hash: number;
  ticks: number;
}

/** the net leaderboard score for an opponent-free record run by `alliance`: the
 * alliance's earned total MINUS the penalty points it handed the (empty) opponent
 * — i.e. its own committed fouls. Clamped at 0 (a run can't score negative). */
export function recordScore(result: ReplayResult, alliance: Alliance): number {
  const opp: Alliance = alliance === 'blue' ? 'red' : 'blue';
  return Math.max(0, result.score[alliance] - result.foulPoints[opp]);
}

/** the server's anti-cheat entry point: re-simulate a submitted replay and
 * return the authoritative score it produces — never trust a client-posted one */
export function verifyReplay(replay: Replay): ReplayResult {
  return worldResult(simulateReplay(replay));
}

/** the record/score of a finished world — read directly, no re-simulation (the
 * server already holds the authoritative world at phase 'post') */
export function worldResult(world: World): ReplayResult {
  return {
    score: { red: world.match.scores.red.total, blue: world.match.scores.blue.total },
    foulPoints: { red: world.match.scores.red.foulPoints, blue: world.match.scores.blue.foulPoints },
    hash: worldHash(world),
    ticks: world.tick,
  };
}

// ---- record-chasing (score-attack) setups -----------------------------------

/** solo = 1 robot alone (1v0); duo = 2 co-op robots, same alliance, one field
 * (2v0). Both are OPPONENT-FREE — the record is the alliance's total score. */
export type RecordMode = 'solo' | 'duo';

/**
 * Build the RobotSetup[] for a record-chasing run. Score-attack has no opponent,
 * so a single (blue) alliance holds the run robot(s); alliance is viewpoint-only.
 * A DUO has TWO drivers, each with their OWN build — pass `partnerSpec` for slot 1
 * (it falls back to `spec` only when a second build isn't supplied). Distinct start
 * poses keep the two robots from spawning on top of each other. (In production the
 * server builds a duo's setups from each client's spec; this helper is for
 * headless runs + tests.)
 */
export function recordSetups(
  spec: RobotSpec,
  mode: RecordMode,
  assists = DEFAULT_ASSISTS,
  autoPath?: AutoPathData, // Add autoPath parameter
  autoPathEnabled?: boolean, // Add autoPathEnabled parameter
  startPose?: StartPose, // custom start pose (applied to slot 0 only)
  partnerSpec?: RobotSpec, // duo slot 1's own build (defaults to `spec`)
): RobotSetup[] {
  const alliance: Alliance = 'blue';
  const slot = (id: number, startIndex: number, robotSpec: RobotSpec, pose?: StartPose): RobotSetup => ({
    id,
    alliance,
    spec: { ...robotSpec },
    assists: { ...assists },
    startIndex,
    startPose: pose,
    autoPath: autoPath, // Pass autoPath
    autoPathEnabled: autoPathEnabled, // Pass autoPathEnabled
  });
  // slot 1 stays on a preset so a duo can't spawn both robots on one custom spot
  return mode === 'solo'
    ? [slot(0, 0, spec, startPose)]
    : [slot(0, 0, spec, startPose), slot(1, 1, partnerSpec ?? spec)];
}

/** the alliance a record run scores for (the run robots' alliance) */
export function recordAlliance(setups: RobotSetup[]): Alliance {
  return setups[0]?.alliance ?? 'blue';
}

// ---- headless record runner (verifier / tooling / tests) --------------------

/** per-tick command provider: returns the RAW intended command map for `tick`
 * (localization is applied by the runner). Absent robot ⇒ ZERO that tick. */
export type CommandSource = (tick: number, world: World) => Map<number, RobotCommand>;

export interface RecordRun {
  world: World; // final world (phase 'post' unless stopped early)
  replay: Replay;
  result: ReplayResult;
}

/** upper bound on a full match's ticks (+ slack), so a runaway can't spin forever. The settle
 *  after the buzzer ends when the field comes to rest, so the bound carries its CAP. */
export function maxMatchTicks(): number {
  const secs =
    C.PRE_COUNTDOWN + C.AUTO_DURATION + C.TRANSITION_DURATION + C.TELEOP_DURATION + MATCH_SETTLE_MAX_S + 2;
  return Math.ceil(secs / C.SIM_DT);
}

/**
 * Run a full, deterministic, SIM-DRIVEN record-chasing match headlessly and
 * capture its replay. Commands from `src` are localized (quantize round-trip)
 * before BOTH stepping and recording, so `simulateReplay(run.replay)` reproduces
 * `run.world` exactly. Stops at phase 'post' (or `opts.stopTick` for a short run).
 */
export function runRecordMatch(
  seed: number,
  setups: RobotSetup[],
  src: CommandSource,
  opts: { mode?: GameMode; stopTick?: number; game?: GameId; physics?: Physics } = {},
): RecordRun {
  const mode = opts.mode ?? 'match';
  const game = opts.game ?? 'decode';
  const physics = opts.physics ?? '2d';
  const mod = simModuleFor(game);
  const world = mod.createWorld(mode, seed, setups, undefined, physics);
  if (mode === 'match') world.match.preCountdown = C.PRE_COUNTDOWN;
  const rec = new ReplayRecorder(seed, setups, mode, game, physics);
  const cap = opts.stopTick ?? maxMatchTicks();
  while (world.match.phase !== 'post' && world.tick < cap) {
    const tick = world.tick + 1;
    const raw = src(tick, world);
    const local = new Map<number, RobotCommand>();
    for (const s of setups) {
      const c = raw.get(s.id);
      local.set(s.id, c ? localizeCommand(c) : { ...ZERO_CMD });
    }
    mod.step(world, C.SIM_DT, local);
    rec.record(tick, local);
  }
  return { world, replay: rec.finish(), result: worldResult(world) };
}