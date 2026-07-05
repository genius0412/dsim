import type {
  Alliance,
  Artifact,
  ArtifactColor,
  AssistConfig,
  GameMode,
  GoalState,
  Motif,
  RobotSpec,
  RobotState,
  World,
} from '../types';
import * as C from '../config';
import { nextRandom } from '../math';
import { loadSlots, spikeMarkBalls, startPose } from './field';
import { emptyScore } from './scoring';

export const MOTIFS: Motif[] = [
  ['green', 'purple', 'purple'], // obelisk AprilTag 21: GPP
  ['purple', 'green', 'purple'], // 22: PGP
  ['purple', 'purple', 'green'], // 23: PPG
];

export const DEFAULT_SPEC: RobotSpec = { length: 18, width: 18, intake: 'compact' };

function goalState(alliance: Alliance): GoalState {
  return {
    alliance,
    gateOpen: false,
    gateHoldTime: 0,
    classifiedCount: 0,
    overflowCount: 0,
  };
}

export function createWorld(
  mode: GameMode,
  playerAlliance: Alliance,
  seed: number,
  spec: RobotSpec = DEFAULT_SPEC,
  assists: AssistConfig = { fieldCentric: true, aimAssist: true, autoIntake: false, autoFire: false },
): World {
  let rng = nextRandom(seed || 1);
  const motif = MOTIFS[Math.floor(rng.value * 3) % 3];

  const balls: Artifact[] = [];
  let id = 1;
  const addBall = (pos: { x: number; y: number }, color: ArtifactColor): void => {
    balls.push({
      id: id++,
      color,
      state: { kind: 'ground' },
      pos: { x: pos.x, y: pos.y },
      vel: { x: 0, y: 0 },
      z: 0,
      vz: 0,
    });
  };

  for (const a of ['red', 'blue'] as Alliance[]) {
    for (const s of spikeMarkBalls(a)) addBall(s.pos, s.color);
    // loading zone balls, PGP against the perimeter
    const slots = loadSlots(a);
    const order: ArtifactColor[] = ['purple', 'green', 'purple'];
    slots.forEach((p, i) => addBall(p, order[i]));
  }

  const pose = startPose(playerAlliance);
  const robot: RobotState = {
    id: 0,
    alliance: playerAlliance,
    spec,
    pos: pose.pos,
    heading: pose.heading,
    vel: { x: 0, y: 0 },
    angVel: 0,
    turretHeading: pose.heading,
    hopper: [...C.PRELOAD],
    fieldCentric: assists.fieldCentric,
    aimAssist: assists.aimAssist,
    autoIntake: assists.autoIntake,
    autoFire: assists.autoFire,
    lastFireAt: -10,
    lastIntakeAt: -10,
  };

  return {
    mode,
    time: 0,
    tick: 0,
    rngState: rng.state,
    motif,
    robots: [robot],
    balls,
    goals: { red: goalState('red'), blue: goalState('blue') },
    humanPlayers: {
      red: { stock: [...C.HP_INITIAL_STOCK], nextPlaceAt: 0 },
      blue: { stock: [...C.HP_INITIAL_STOCK], nextPlaceAt: 0 },
    },
    match: {
      phase: mode === 'match' ? 'pre' : 'freeplay',
      phaseTimeLeft: mode === 'match' ? C.AUTO_DURATION : 0,
      scores: { red: emptyScore(), blue: emptyScore() },
      provisionalPattern: { red: 0, blue: 0 },
    },
    events: [],
  };
}
