import type {
  Alliance,
  Artifact,
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
import { CHAIN_HALF_X, CHAIN_HALF_Y, CHAIN_PARTICLE_R, CHAIN_PARTICLE_SIM, CHAIN_CATALYST_COUNT } from './config';
import { emptyChainState, type ChainCatalyst } from './state';

/**
 * Chain Reaction world spawn — a PLAYABLE match.
 *
 * Robots start in their half; the field is seeded with `CHAIN_PARTICLE_SIM`
 * PARTICLES (scattered, the manual's pre-match randomization) and
 * `CHAIN_CATALYST_COUNT` CATALYSTS. CR-specific state (catalysts / scoring /
 * endgame) rides `world.chain`; the shared `goals`/`scores`/`motif`/`match` are
 * kept inert-but-present (worldHash/HUD read them). Deterministic: a mulberry32
 * chain off `seed` places every particle/catalyst.
 */

interface Pose {
  pos: Vec2;
  heading: number;
}

const POSES: readonly Pose[] = [
  { pos: { x: 42, y: -18 }, heading: Math.PI },
  { pos: { x: 42, y: 18 }, heading: Math.PI },
  { pos: { x: 24, y: 0 }, heading: Math.PI },
  { pos: { x: 58, y: 0 }, heading: Math.PI },
];

function chainStartPose(alliance: Alliance, nth: number): Pose {
  const p = POSES[((nth % POSES.length) + POSES.length) % POSES.length];
  if (alliance === 'blue') return { pos: { ...p.pos }, heading: p.heading };
  return { pos: { x: -p.pos.x, y: p.pos.y }, heading: wrapAngle(Math.PI - p.heading) };
}

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
    hopper: [],
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
  let rng = nextRandom(seed || 1);
  const rand = (): number => {
    rng = nextRandom(rng.state);
    return rng.value;
  };

  const robots: RobotState[] = [];
  const allianceCount: Record<Alliance, number> = { red: 0, blue: 0 };
  for (const s of [...setups].sort((p, q) => p.id - q.id)) {
    robots.push(makeChainRobot(s, allianceCount[s.alliance]++));
  }

  // scatter the particles across the playing area (pre-match randomization)
  const margin = CHAIN_PARTICLE_R + 2;
  const spanX = 2 * (CHAIN_HALF_X - margin);
  const spanY = 2 * (CHAIN_HALF_Y - margin);
  const balls: Artifact[] = [];
  let id = 1;
  for (let i = 0; i < CHAIN_PARTICLE_SIM; i++) {
    balls.push({
      id: id++,
      color: 'green', // rendered white in CR; color unused
      state: { kind: 'ground' },
      pos: { x: -CHAIN_HALF_X + margin + rand() * spanX, y: -CHAIN_HALF_Y + margin + rand() * spanY },
      vel: { x: 0, y: 0 },
      z: 0,
      vz: 0,
    });
  }

  // catalysts near the center, on the field (free to be picked up)
  const chain = emptyChainState();
  chain.nextBallId = id; // runtime spawns continue past the initial particle ids
  for (let i = 0; i < CHAIN_CATALYST_COUNT; i++) {
    const cat: ChainCatalyst = {
      id: i,
      pos: { x: (rand() - 0.5) * 60, y: (rand() - 0.5) * 60 },
      carriedBy: null,
      hook: null,
    };
    chain.catalysts.push(cat);
  }

  return {
    game: 'chain',
    chain,
    mode,
    time: 0,
    tick: 0,
    rngState: rng.state,
    motif: MOTIFS[0],
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
      gateCulprit: { red: null, blue: null },
      rampBallIds: { red: [], blue: [] },
    },
    gameSettings,
  };
}
