import type {
  Alliance,
  GameMode,
  GameSettings,
  GoalState,
  RobotCommand,
  RobotState,
  Vec2,
  World,
} from '../../types';
import * as C from '../../config';
import { nextRandom } from '../../math';
import { solveRobots } from '../../sim/physicsEngine';
import { squareUpRobotsWalls } from '../../sim/physics';
import { robotsEnabled } from '../../sim/match';
import { updateRobot, type DriveWrench } from '../../sim/robot';
import { emptyScore } from '../../sim/scoring';
import {
  DEFAULT_ASSISTS,
  DEFAULT_SPEC,
  MOTIFS,
  coerceAssists,
  coerceSpec,
  type RobotSetup,
} from '../../sim/spawn';
import type { FieldColliders, GameSimModule, StaticSpec } from '../types';
import { emptyBiobuzzState } from './state';

/**
 * BIOBUZZ (FTC 2026-27) SIMULATION module.
 *
 * ⚠️ PLACEHOLDER, and deliberately as small as it can be. Its only job is to make
 * the registries, `SEASONS` and `GAME_IDS` compile with a third id in them so the
 * shared-core generalization can be verified end to end BEFORE the game exists.
 * The P0-shell chat REPLACES this file (and `index.ts` / `state.ts`) with the real
 * shell: the actual field, the scoring elements, and the robot stack.
 *
 * What it is: an empty 12 ft x 12 ft box with four walls, in which robots spawn on
 * one of two anchors and drive. It runs the SHARED drivetrain, the shared Rapier
 * solve and the shared wall square-up, and NOTHING else — no scoring elements, no
 * phase assessment, no penalties. `scored: false` keeps every match off the
 * ranked/record boards, and `startLegality: false` keeps the server's DECODE-only
 * G304 gate off.
 *
 * The rules land at kickoff on 2026-09-12; do not invent geometry here in the
 * meantime — an APPROX number that nobody flagged is worse than an empty field.
 */

// the field is the standard FTC 12 ft square, same frame convention as both other
// games: origin centre, inches, +x audience-right, +y away from the audience
const BB_HALF = 72;
const BB_WALL_T = 2;
const BB_VIEW_MARGIN = 14;

// four perimeter walls, inner faces exactly at ±BB_HALF, overlapping at the
// corners so nothing can squeeze through a seam (CR's colliders, same shape)
const WALL_LEN = BB_HALF + 20;
const walls: StaticSpec[] = [
  { hx: BB_WALL_T, hy: WALL_LEN, tx: BB_HALF + BB_WALL_T, ty: 0, rot: 0 },
  { hx: BB_WALL_T, hy: WALL_LEN, tx: -BB_HALF - BB_WALL_T, ty: 0, rot: 0 },
  { hx: WALL_LEN, hy: BB_WALL_T, tx: 0, ty: BB_HALF + BB_WALL_T, rot: 0 },
  { hx: WALL_LEN, hy: BB_WALL_T, tx: 0, ty: -BB_HALF - BB_WALL_T, rot: 0 },
];

export const biobuzzColliders: FieldColliders = {
  statics: walls,
  bounds: { halfX: BB_HALF, halfY: BB_HALF },
};

/**
 * The two placeholder start anchors, CANONICAL for BLUE (x-mirrored for RED) —
 * the same convention CR uses, so a saved pose survives an alliance switch.
 *
 * Two of them because `startPoseCount` is 2 and a 2-robot alliance spawns slots
 * 0/1: they have to be far enough apart that two robots do not spawn overlapping.
 */
const BB_START_POSES: readonly { pos: Vec2; heading: number }[] = [
  { pos: { x: 48, y: 36 }, heading: Math.PI },
  { pos: { x: 48, y: -36 }, heading: Math.PI },
];

function startPose(alliance: Alliance, index: number): { pos: Vec2; heading: number } {
  const n = BB_START_POSES.length;
  const p = BB_START_POSES[((index % n) + n) % n];
  if (alliance === 'blue') return { pos: { ...p.pos }, heading: p.heading };
  return { pos: { x: -p.pos.x, y: p.pos.y }, heading: Math.PI - p.heading };
}

/** an inert DECODE goal — `World.goals` is required and the HUD/worldHash read it */
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

function makeRobot(setup: RobotSetup, nth: number): RobotState {
  const spec = coerceSpec(setup.spec, DEFAULT_SPEC, 'biobuzz');
  const assists = coerceAssists(setup.assists, DEFAULT_ASSISTS);
  const pose = startPose(setup.alliance, setup.startIndex ?? nth);
  return {
    id: setup.id,
    alliance: setup.alliance,
    spec,
    pos: { ...pose.pos },
    heading: pose.heading,
    vel: { x: 0, y: 0 },
    angVel: 0,
    turretHeading: pose.heading,
    moduleAngles: [0, 0, 0, 0],
    moduleTargets: [0, 0, 0, 0],
    catalystRail: 0,
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
 * Spawn a BIOBUZZ world: robots on their anchors, an EMPTY field.
 *
 * The shared bags DECODE owns (`goals`, `motif`, `humanPlayers`, `penalties`) are
 * present but inert, exactly as CR keeps them — `worldHash`, the HUD and the
 * snapshot codec all read them unconditionally.
 */
export function createBiobuzzWorld(
  mode: GameMode,
  seed: number,
  setups: RobotSetup[],
  gameSettings?: GameSettings,
): World {
  const rng = nextRandom(seed || 1);
  const robots: RobotState[] = [];
  const allianceCount: Record<Alliance, number> = { red: 0, blue: 0 };
  for (const s of [...setups].sort((p, q) => p.id - q.id)) {
    robots.push(makeRobot(s, allianceCount[s.alliance]++));
  }
  return {
    game: 'biobuzz',
    biobuzz: emptyBiobuzzState(),
    mode,
    time: 0,
    tick: 0,
    rngState: rng.state,
    motif: MOTIFS[0],
    robots,
    balls: [],
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

const ZERO_CMD: RobotCommand = {
  driveX: 0,
  driveY: 0,
  rotate: 0,
  leftDrive: 0,
  rightDrive: 0,
  intake: false,
  fire: false,
};

/**
 * Step a BIOBUZZ world: the SHARED drivetrain and nothing else.
 *
 * Deliberately the smallest step that still produces a drivable robot — commands
 * to `updateRobot`, then the shared Rapier solve and the wall square-up. No phase
 * machine (the placeholder never advances out of `pre`/`freeplay`), no gameplay,
 * no penalties. Deterministic, so prediction / server authority / replays already
 * hold for it.
 */
export function biobuzzStep(world: World, dt: number, commands: Map<number, RobotCommand>): void {
  world.time += dt;
  world.tick++;

  const enabled = robotsEnabled(world);
  const drive = new Map<number, DriveWrench>();
  for (const r of world.robots) {
    const cmd = enabled ? (commands.get(r.id) ?? ZERO_CMD) : ZERO_CMD;
    drive.set(r.id, updateRobot(world, r, cmd, dt));
  }
  // cleared here, not at the top of the tick: `updateRobot` above reads LAST
  // tick's contacts to tell a robot being leaned on from one stopping itself
  // (see MOTOR_SHOVE_BRAKE and the same placement in DECODE's and CR's step)
  world.rrContacts.length = 0;
  const preVels = solveRobots(world, dt, biobuzzColliders, undefined, drive);
  squareUpRobotsWalls(world, preVels, BB_HALF, BB_HALF);
}

export const BIOBUZZ_SIM: GameSimModule = {
  id: 'biobuzz',
  scored: false, // a shell: nothing reaches a leaderboard, a record or an ELO
  startLegality: false, // the two anchors are legal by construction
  initialAct: 2, // DECODE keeps act 0, CR act 1, BIOBUZZ opens at act 2
  startPoseCount: BB_START_POSES.length,
  bounds: { halfX: BB_HALF, halfY: BB_HALF, viewMargin: BB_VIEW_MARGIN },
  colliders: biobuzzColliders,
  createWorld: createBiobuzzWorld,
  step: biobuzzStep,
};
