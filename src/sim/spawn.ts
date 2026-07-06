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

export const DEFAULT_SPEC: RobotSpec = {
  name: 'Standard Issue',
  teamName: 'Baseline Robotics',
  teamNumber: 1234,
  length: 18,
  width: 18,
  intake: 'sloped',
  massLb: 30,
  drivetrain: 'mecanum',
  driveRpm: 435,
  flywheelInertia: 0.5,
  canSort: false,
};

export const DEFAULT_ASSISTS: AssistConfig = {
  fieldCentric: true,
  aimAssist: true,
  autoIntake: false,
  autoFire: false,
};

/** one robot slot in a match: only filled slots spawn robots */
export interface RobotSetup {
  id: number; // slot index, fixed for the whole match (command-map key)
  alliance: Alliance;
  spec: RobotSpec;
  assists: AssistConfig;
  /** index into START_POSES (mirrored per alliance) */
  startIndex: number;
}

function goalState(alliance: Alliance): GoalState {
  return {
    alliance,
    gateOpen: false,
    gateHoldTime: 0,
    classifiedCount: 0,
    overflowCount: 0,
  };
}

export function createWorld(mode: GameMode, seed: number, setups: RobotSetup[]): World {
  const rng = nextRandom(seed || 1);
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

  // preloads come from the alliance area's 6 balls (4P+2G). With one robot
  // the leftover 3 become human-player stock; with two robots per alliance
  // the second robot takes those 3 and the HP stock starts empty.
  const robots: RobotState[] = [];
  const allianceCount: Record<Alliance, number> = { red: 0, blue: 0 };
  for (const s of [...setups].sort((p, q) => p.id - q.id)) {
    const pose = startPose(s.alliance, s.startIndex);
    const nth = allianceCount[s.alliance]++;
    robots.push({
      id: s.id,
      alliance: s.alliance,
      spec: s.spec,
      pos: pose.pos,
      heading: pose.heading,
      vel: { x: 0, y: 0 },
      angVel: 0,
      turretHeading: pose.heading,
      hopper: nth === 0 ? [...C.PRELOAD] : [...C.HP_INITIAL_STOCK],
      fieldCentric: s.assists.fieldCentric,
      aimAssist: s.assists.aimAssist,
      autoIntake: s.assists.autoIntake,
      autoFire: s.assists.autoFire,
      lastFireAt: -10,
      lastIntakeAt: -10,
      fireReadyAt: 0,
    });
  }

  return {
    mode,
    time: 0,
    tick: 0,
    rngState: rng.state,
    motif,
    robots,
    balls,
    goals: { red: goalState('red'), blue: goalState('blue') },
    humanPlayers: {
      red: { stock: allianceCount.red >= 2 ? [] : [...C.HP_INITIAL_STOCK], nextPlaceAt: 0 },
      blue: { stock: allianceCount.blue >= 2 ? [] : [...C.HP_INITIAL_STOCK], nextPlaceAt: 0 },
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
    penalties: { episodes: {}, pins: {}, pinFouls: {} },
  };
}
