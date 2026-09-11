import type {
  Alliance,
  Artifact,
  GameMode,
  GameSettings,
  GoalState,
  RobotSpec,
  RobotState,
  StartPose,
  Vec2,
  World,
} from '../../types';
import * as C from '../../config';
import { clamp, datan2, dcos, dsin, nextRandom, rot, wrapAngle } from '../../math';
import {
  DEFAULT_ASSISTS,
  MOTIFS,
  coerceAssists,
  coerceAutoPath,
  coerceStartPose,
  type RobotSetup,
} from '../../sim/spawn';
import { emptyScore } from '../../sim/scoring';
import { BB_HALF_X, BB_HALF_Y, BB_POLLEN_R, BB_POLLEN_SIM, BB_START_POSES } from './config';
import { bbCoerceSpec } from './robotConfig';
import { bbFootprint } from './robot';
import { emptyBiobuzzState } from './state';
import { isTurreted, type BbScoreMode } from './mounts';

/**
 * BIOBUZZ world spawn — a PLAYABLE, UNSCORED match.
 *
 * Robots start at their alliance's two anchors; the field is seeded with `BB_POLLEN_SIM`
 * placeholder POLLEN in a deterministic scatter. BIOBUZZ state rides `world.biobuzz`, and the
 * shared `goals`/`scores`/`motif`/`match` are kept INERT-BUT-PRESENT because `worldHash`, the
 * snapshot diff and the HUD all read them and a missing field is a crash rather than a zero.
 *
 * DETERMINISM. A mulberry32 chain off `seed` places every POLLEN, and the advanced state is
 * stored back on `world.rngState` so the match continues the same chain. Nothing here reads a
 * clock, the DOM or `Math.random`: same seed, same world, on the client and on the server,
 * which is what makes a replay and a multiplayer match agree.
 */

interface Pose {
  pos: Vec2;
  heading: number;
}

/**
 * SANITIZE ONE SETUP — the BIOBUZZ replacement for the shared `coerceSetup`.
 *
 * The shared one CANNOT be used here, and it is worth being precise about why rather than
 * quietly writing a second copy: `coerceSetup` clamps `startIndex` to DECODE's
 * `C.START_POSES.length` (5) and repairs a custom pose with `snapStartToLegal`, which is
 * DECODE's G304 geometry — launch lines, goal faces, alliance halves. BIOBUZZ has two anchors
 * and no published legality at all (`startLegality: false`), so running it would clamp against
 * the wrong count and snap poses against zones this game does not have.
 *
 * What it DOES do is exactly what matters, and none of it is DECODE-specific:
 *   • ALLIANCE — an enum, defaulted rather than trusted.
 *   • STARTINDEX — finite, integral, in range for THIS game's anchor count.
 *   • STARTPOSE  — structurally validated and field-clamped (`coerceStartPose`).
 *   • AUTOPATH   — structurally validated and field-clamped, with `autoPathEnabled` forced
 *                  false when there is no usable path (an enabled-but-absent path is what
 *                  drives `pathTraversal` into a null target).
 *   • ASSISTS    — every flag validated independently.
 *
 * CHAIN REACTION SKIPS ALL OF THIS. `createChainWorld` calls `coerceSpec` and `coerceAssists`
 * but never `coerceSetup`, so a CR setup arriving off the wire with `startIndex: 1e9` or a
 * malformed auto path is spawned as-is. That is a KNOWN GAP in CR and it is deliberately NOT
 * copied here — this is the last line of defence before a robot exists, and it runs on every
 * spawn path (localStorage, the wire, a staged match, smoke).
 */
function coerceBiobuzzSetup(s: RobotSetup): RobotSetup {
  const alliance: Alliance = s.alliance === 'red' || s.alliance === 'blue' ? s.alliance : 'blue';
  const autoPath = s.autoPath !== undefined ? coerceAutoPath(s.autoPath) : null;
  const spec = bbCoerceSpec(s.spec);
  return {
    id: s.id, // PRESERVED — it keys the per-tick command map for the whole match
    alliance,
    spec,
    assists: coerceAssists(s.assists, DEFAULT_ASSISTS),
    startIndex: Number.isFinite(s.startIndex)
      ? clamp(Math.round(s.startIndex), 0, BB_START_POSES.length - 1)
      : 0,
    startPose: coerceStartPose(s.startPose) ?? undefined,
    autoPath: autoPath ?? undefined,
    autoPathEnabled: autoPath ? s.autoPathEnabled === true : false,
    passive: s.passive,
  };
}

/**
 * THE FOOTPRINT FITS INSIDE THE FIELD — the containment invariant a start pose has to satisfy,
 * enforced on the FINAL pose (after the alliance mirror) by sliding the chassis in.
 *
 * A custom pose used to be validated on its CENTRE ALONE: `coerceStartPose` (`src/sim/
 * spawn.ts`) clamps `x`/`y` to ±`FIELD_HALF` and nothing else, so a pose at the corner spawned
 * a robot with half its frame — and all of its sweeper — through the wall. BIOBUZZ has no
 * published start legality (`startLegality: false`), so there is no G304 analogue to snap to
 * the way `coerceSetup` does for DECODE; what there IS, and what does not need a manual, is
 * that a robot must begin the match inside the field. Rapier will not fix it either: the
 * perimeter invariant in `solveRobots` clamps GROWTH past the wall and deliberately leaves a
 * body that was ALREADY outside alone, so an out-of-bounds spawn simply stays out of bounds.
 *
 * The FOOTPRINT, not the chassis box, for the same reason `footprintExtents` is what the
 * solver collides on: the sweeper is a physical part of the robot and `bbFootprint` grows the
 * box by its reach on whichever edge(s) it is mounted. And the ROTATED footprint, measured as
 * the axis-aligned box the turned rectangle actually occupies — a robot at 45° reaches further
 * toward a wall than its half-length.
 *
 * It SLIDES rather than rejects: a translation is the smallest repair that keeps the driver's
 * chosen heading and their intent (a pose against the wall stays against the wall), and the
 * AABB translates exactly with the centre, so the fix is a single subtraction with no search.
 * A footprint too large for the field at all cannot be made to fit, so it is centred on that
 * axis — unreachable today (the size envelope is an 18in cube on a 144in field) and it must
 * not silently produce an inverted clamp.
 *
 * Applied to the ANCHORS too, deliberately: they are hand-placed `APPROX` numbers, and this is
 * a no-op for them (`npm run test:bb` asserts every anchor's footprint is already inside) but
 * it means there is no spawn path left that can place a robot through a wall. Deterministic
 * and idempotent — `f(f(x)) === f(x)`, so it cannot walk a pose across repeated coercion.
 */
function bbFitPose(spec: RobotSpec, pose: Pose): Pose {
  const e = bbFootprint(spec);
  const c = dcos(pose.heading);
  const s = dsin(pose.heading);
  // the footprint's own centre — offset from the robot's origin whenever the sweeper makes it
  // asymmetric fore-and-aft (a front-only mount), and it rotates with the chassis
  const half = (e.front + e.rear) / 2;
  const off = (e.front - e.rear) / 2;
  const cx = pose.pos.x + off * c;
  const cy = pose.pos.y + off * s;
  // the axis-aligned half-extents of the rotated rectangle
  const ax = Math.abs(half * c) + Math.abs(e.half * s);
  const ay = Math.abs(half * s) + Math.abs(e.half * c);
  const limX = Math.max(0, BB_HALF_X - ax);
  const limY = Math.max(0, BB_HALF_Y - ay);
  return {
    pos: { x: pose.pos.x + (clamp(cx, -limX, limX) - cx), y: pose.pos.y + (clamp(cy, -limY, limY) - cy) },
    heading: pose.heading,
  };
}

/**
 * A robot's start pose. The named `BB_START_POSES` anchors are CANONICAL for BLUE; RED is the
 * x-mirror, and the mirror is applied HERE and nowhere else so no other file has to know which
 * alliance is which side.
 *
 * The mirror is `x → −x` with `heading → π − heading`, which is a reflection rather than a
 * rotation: reflecting the position without reflecting the heading would leave the red robot
 * facing out of the field. Wrapped, because `π − heading` leaves the range for a heading
 * already past π/2 and an unwrapped heading breaks every angle comparison downstream.
 *
 * A CUSTOM pose wins over the anchor index (the same contract DECODE uses) and is stored in
 * the canonical blue frame, so it is mirrored on the same path. It is NOT snapped legal,
 * because there is no legality to snap to — but it IS fitted inside the perimeter
 * (`bbFitPose`), AFTER the mirror, because "the whole robot starts on the field" is an
 * invariant no manual is needed for and `coerceStartPose`'s centre clamp does not give it.
 */
function bbStartPose(spec: RobotSpec, alliance: Alliance, index: number, custom?: StartPose | null): Pose {
  const base: Pose = custom
    ? { pos: { x: custom.x, y: custom.y }, heading: (custom.headingDeg * Math.PI) / 180 }
    : (() => {
        const n = BB_START_POSES.length;
        const p = BB_START_POSES[((index % n) + n) % n];
        return { pos: { ...p.pos }, heading: p.heading };
      })();
  const actual: Pose =
    alliance === 'blue'
      ? { pos: { ...base.pos }, heading: base.heading }
      : { pos: { x: -base.pos.x, y: base.pos.y }, heading: wrapAngle(Math.PI - base.heading) };
  return bbFitPose(spec, actual);
}

/** the shared goal state, present and INERT. BIOBUZZ has no goal — Section 9 lands at
 * Kickoff — but `worldHash`, the snapshot diff and the score HUD all read `world.goals`, so
 * the field is populated with zeroes rather than omitted. */
function inertGoal(alliance: Alliance): GoalState {
  return {
    alliance,
    gateOpen: false,
    gatePos: 0,
    gateVel: 0,
    gateHoldTime: 0,
    gateLatch: 0,
    classifiedCount: 0,
    overflowCount: 0,
  };
}

function makeBiobuzzRobot(setup: RobotSetup, nth: number): RobotState {
  const spec: RobotSpec = setup.spec;
  const assists = setup.assists;
  // honour the chosen start (the selector's `startIndex`); default a 2-robot alliance to its
  // two anchors, so the pair never stacks
  const pose = bbStartPose(spec, setup.alliance, setup.startIndex ?? nth, setup.startPose);
  // A TURRET starts ALREADY POINTED. It slews at a finite rate (`BB_TURRET_SLEW`), so a
  // turreted robot that spawned on the chassis heading would spend the first second of auto
  // swinging round. There is no target to point AT yet, so it points at the field CENTRE —
  // the one direction that is equally wrong for every target Section 9 might add, and the one
  // a human would pick. Turretless launchers keep the chassis heading, which IS their aim.
  const turreted = isTurreted((spec.scoreMode ?? 'turret') as BbScoreMode);
  const turretHeading = turreted ? datan2(0 - pose.pos.y, 0 - pose.pos.x) : pose.heading;
  return {
    id: setup.id,
    alliance: setup.alliance,
    spec,
    pos: { ...pose.pos },
    heading: pose.heading,
    vel: { x: 0, y: 0 },
    angVel: 0,
    turretHeading,
    // `catalystRail` is DELIBERATELY ABSENT. It is Chain Reaction's rail-carriage position
    // and BIOBUZZ has no catalyst; it used to be written as an INERT-BUT-PRESENT 0 only
    // because the shared `RobotState` required it. It is optional now, absent reads as 0
    // everywhere, and a BIOBUZZ robot no longer carries a field describing hardware it does
    // not have.
    moduleAngles: [0, 0, 0, 0],
    moduleTargets: [0, 0, 0, 0],
    // BUTTERFLY starts on its MECANUM set — a robot that begins holonomic can always drop
    // traction, and the reverse costs a driver a surprise on tick one.
    butterflyTank: false,
    driveModeHeld: false,
    twinBarrel: false,
    hopper: [],
    fieldCentric: assists.fieldCentric,
    aimAssist: assists.aimAssist,
    autoIntake: assists.autoIntake,
    autoFire: assists.autoFire,
    passive: setup.passive,
    lastFireAt: -10,
    lastIntakeAt: -10,
    fireReadyAt: 0,
    flywheelSpin: 0,
    flywheelSpinRate: 0,
    powerDraw: 0,
    autoPathActive: false,
    currentPathSegmentIndex: 0,
    pathSegmentProgress: 0,
    pathWaitTimer: 0,
    pathSequenceIndex: 0,
    pathTargetPoint: null,
    pathTargetHeading: null,
    isAligningHeading: false,
    targetAlignmentHeading: null,
  };
}

/**
 * THE POLLEN SCATTER — `BB_POLLEN_SIM` placeholder POLLEN across the tile.
 *
 * PLACEHOLDER, and it says so: Section 10 (Game Details) is what decides how many POLLEN
 * there are and where they start, and it lands at Kickoff. What this scatter has to be RIGHT
 * about is everything else — that it is deterministic, that no two POLLEN start inside one
 * another, and that none starts inside a robot.
 *
 * REJECTION SAMPLING with a bounded attempt count. Each candidate is drawn from the world RNG
 * and rejected if it overlaps a placed POLLEN or any robot's footprint; after `TRIES` attempts
 * the last candidate is accepted anyway. Accepting is better than looping forever OR than
 * reducing the count: the separation pass on tick one settles a residual overlap in two
 * iterations, whereas an unbounded loop is a hang and a short scatter would make the count
 * depend on the seed — and the count is the thing smoke asserts is conserved.
 *
 * The attempt COUNT varies with the seed, which is fine and is not a determinism hole: the
 * draws happen in a fixed order for a given seed, so the same seed always produces the same
 * scatter and the same final `rngState`.
 */
function scatterPollen(rand: () => number, robots: RobotState[], startId: number): Artifact[] {
  const out: Artifact[] = [];
  // keep POLLEN off the wall by a full diameter: one resting against the wall is inside the
  // clamp's dead zone, so it can never be pushed out of a pile and reads as stuck
  const margin = BB_POLLEN_R * 2;
  const lim = BB_HALF_X - margin;
  const limY = BB_HALF_Y - margin;
  const minD = BB_POLLEN_R * 2;
  const minD2 = minD * minD;
  const TRIES = 30;

  let id = startId;
  for (let i = 0; i < BB_POLLEN_SIM; i++) {
    let x = 0;
    let y = 0;
    for (let t = 0; t < TRIES; t++) {
      x = (rand() * 2 - 1) * lim;
      y = (rand() * 2 - 1) * limY;
      let clash = false;
      for (const o of out) {
        const dx = o.pos.x - x;
        const dy = o.pos.y - y;
        if (dx * dx + dy * dy < minD2) {
          clash = true;
          break;
        }
      }
      if (!clash) {
        for (const r of robots) {
          const e = bbFootprint(r.spec);
          const local = rot({ x: x - r.pos.x, y: y - r.pos.y }, -r.heading);
          if (
            local.x < e.front + BB_POLLEN_R &&
            local.x > -e.rear - BB_POLLEN_R &&
            Math.abs(local.y) < e.half + BB_POLLEN_R
          ) {
            clash = true;
            break;
          }
        }
      }
      if (!clash) break;
    }
    out.push({
      id: id++,
      // colour is cosmetic in BIOBUZZ — POLLEN are one kind — but the shared `Artifact` type
      // requires it and the renderer reads it, so every POLLEN gets the same value.
      color: 'green',
      state: { kind: 'ground' },
      pos: { x, y },
      vel: { x: 0, y: 0 },
      z: 0,
      vz: 0,
    });
  }
  return out;
}

export function createBiobuzzWorld(
  mode: GameMode,
  seed: number,
  setups: RobotSetup[],
  gameSettings?: GameSettings,
): World {
  let rng = nextRandom(seed || 1);
  const rand = (): number => {
    rng = nextRandom(rng.state);
    return rng.value;
  };

  // SORTED BY ID before spawning. The setups arrive from a Map or a wire array whose order is
  // not guaranteed, and the spawn order decides the order of RNG draws — so an unsorted list
  // is a hash divergence between two peers with the same seed.
  const robots: RobotState[] = [];
  const allianceCount: Record<Alliance, number> = { red: 0, blue: 0 };
  for (const s of [...setups].sort((p, q) => p.id - q.id)) {
    const safe = coerceBiobuzzSetup(s);
    robots.push(makeBiobuzzRobot(safe, allianceCount[safe.alliance]++));
  }

  const biobuzz = emptyBiobuzzState();
  const balls = scatterPollen(rand, robots, biobuzz.nextBallId);
  // continue the id sequence past the initial scatter, so a runtime spawn can never alias one
  biobuzz.nextBallId = balls.length ? balls[balls.length - 1].id + 1 : biobuzz.nextBallId;

  return {
    game: 'biobuzz',
    biobuzz,
    mode,
    time: 0,
    tick: 0,
    rngState: rng.state,
    motif: MOTIFS[0], // inert: BIOBUZZ has no motif, but the HUD and the hash read the field
    robots,
    balls,
    goals: { red: inertGoal('red'), blue: inertGoal('blue') },
    humanPlayers: {
      red: { box: [], nextPlaceAt: 0 },
      blue: { box: [], nextPlaceAt: 0 },
    },
    match: {
      phase: mode === 'match' ? 'pre' : 'freeplay',
      phaseTimeLeft: mode === 'match' ? C.AUTO_DURATION : 0,
      scores: { red: emptyScore(), blue: emptyScore() },
      provisionalPattern: { red: 0, blue: 0 },
      fouls: { red: { minor: 0, major: 0 }, blue: { minor: 0, major: 0 } },
    },
    events: [],
    rrContacts: [],
    penalties: {
      episodes: {},
      pins: {},
      pinFouls: {},
      possession: {},
      possessionBilled: {},
      possessionRebill: {},
      controlHeld: {},
      ballHold: {},
      ballAnchor: {},
      controlInstances: {},
      carded: {},
      gateCulprit: { red: null, blue: null },
      rampBallIds: { red: [], blue: [] },
    },
    gameSettings,
  };
}
