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
import { loadPreStage, spikeMarkBalls, startPose } from './field';
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

/** the off-field human-player box holds ONLY the alliance-area preload set(s) no
 * present robot claimed (each present robot consumes one 3-ball set): 2 robots ->
 * 0 (empty), 1 -> 3 (PPG), 0 -> 6 (PGP+PPG). The 3 pre-staged loading-zone
 * artifacts are NOT in here — they sit on the field in the loading-zone corner. */
function hpBox(present: number): ArtifactColor[] {
  return [[...C.PRELOAD], [...C.HP_INITIAL_STOCK]].slice(present).flat();
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
    // the 3 pre-staged loading-zone artifacts (manual setup), in the corner
    // against the alliance wall — on the field from the start; the human player
    // arranges them into the grab row once teleop begins.
    for (const s of loadPreStage(a)) addBall(s.pos, s.color);
  }

  // preloads come from the alliance area's 6 balls (4P+2G): the first robot
  // takes PRELOAD (PGP), the second takes HP_INITIAL_STOCK (PPG). Any set no
  // present robot claims seeds the human-player box instead (see hpBox).
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
      red: { box: hpBox(allianceCount.red), nextPlaceAt: 0 },
      blue: { box: hpBox(allianceCount.blue), nextPlaceAt: 0 },
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
