import type {
  Alliance,
  GameMode,
  GameSettings,
  GoalState,
  RobotState,
  Vec2,
  World,
} from '../../types';
import * as C from '../../config';
import { nextRandom, wrapAngle } from '../../math';
import {
  DEFAULT_ASSISTS,
  DEFAULT_SPEC,
  MOTIFS,
  coerceAssists,
  coerceSpec,
  type RobotSetup,
} from '../../sim/spawn';
import { emptyScore } from '../../sim/scoring';
import { CHAIN_HALF_X } from './config';

/**
 * Chain Reaction world spawn — the "empty field shell".
 *
 * Robots ONLY: no balls, no goals-with-scoring, no G304 start legality. Robots
 * are placed at simple mirrored poses in their own half and are fully drivable
 * (shared drivetrain + Rapier). The world still carries INERT `goals`, `scores`,
 * `motif`, and `match` because `worldHash` / the HUD / snapshots read those — but
 * nothing in `chainStep` ever mutates them. When Chain Reaction's real rules land,
 * this grows preloads/goals/zones the way DECODE's `createWorld` does.
 */

interface Pose {
  pos: Vec2;
  heading: number;
}

/** canonical spawn poses (blue side, +x). Red mirrors across x=0. Distinct poses
 * per alliance member so a 2v2 alliance never overlaps at spawn. */
const POSES: readonly Pose[] = [
  { pos: { x: 42, y: -18 }, heading: Math.PI },
  { pos: { x: 42, y: 18 }, heading: Math.PI },
  { pos: { x: 24, y: 0 }, heading: Math.PI },
  { pos: { x: 58, y: 0 }, heading: Math.PI },
];

function chainStartPose(alliance: Alliance, nth: number): Pose {
  const p = POSES[((nth % POSES.length) + POSES.length) % POSES.length];
  // blue drives from the +x wall (like DECODE); red is the mirror image
  if (alliance === 'blue') return { pos: { ...p.pos }, heading: p.heading };
  return { pos: { x: -p.pos.x, y: p.pos.y }, heading: wrapAngle(Math.PI - p.heading) };
}

/** an inert goal (no gate/classifier activity in the shell) — shape only, so the
 * shared `World`/`worldHash`/HUD reads never trip on a missing goal. */
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

function makeChainRobot(setup: RobotSetup, nth: number): RobotState {
  const spec = coerceSpec(setup.spec, DEFAULT_SPEC);
  const assists = coerceAssists(setup.assists, DEFAULT_ASSISTS);
  const pose = chainStartPose(setup.alliance, nth);
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
    hopper: [], // no artifacts in the shell
    fieldCentric: assists.fieldCentric,
    aimAssist: assists.aimAssist,
    autoIntake: assists.autoIntake,
    autoFire: assists.autoFire,
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

export function createChainWorld(
  mode: GameMode,
  seed: number,
  setups: RobotSetup[],
  gameSettings?: GameSettings,
): World {
  const rng = nextRandom(seed || 1);
  const robots: RobotState[] = [];
  const allianceCount: Record<Alliance, number> = { red: 0, blue: 0 };
  for (const s of [...setups].sort((p, q) => p.id - q.id)) {
    robots.push(makeChainRobot(s, allianceCount[s.alliance]++));
  }
  void CHAIN_HALF_X; // (field extents are consumed by the module's colliders/bounds)

  return {
    game: 'chain',
    mode,
    time: 0,
    tick: 0,
    rngState: rng.state,
    motif: MOTIFS[0], // inert (no motif gameplay in the shell)
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
      gateCulprit: { red: null, blue: null },
      rampBallIds: { red: [], blue: [] },
    },
    gameSettings,
  };
}
