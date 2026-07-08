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
  AutoPathData, // Import AutoPathData
  GameSettings, // Import GameSettings
  PathPoint, // Import PathPoint
  ControlPoint, // Import ControlPoint
  Vec2, // Import Vec2
} from '../types';
import * as C from '../config';
import { nextRandom, wrapAngle } from '../math'; // Import wrapAngle
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
  // New fields for auto pathing
  autoPath?: AutoPathData;
  autoPathEnabled?: boolean;
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

// Helper function to mirror a Vec2 point across the x=0 axis
function mirrorPoint(point: Vec2): Vec2 {
  return { x: -point.x, y: point.y };
}

// Helper function to mirror a PathPoint across the x=0 axis
function mirrorPathPoint(pathPoint: PathPoint): PathPoint {
  const mirrored: PathPoint = { ...pathPoint, x: -pathPoint.x };
  if (mirrored.degrees !== undefined) {
    // Mirror angle: new_angle = 180 - old_angle (in degrees)
    mirrored.degrees = wrapAngle((180 - mirrored.degrees) * Math.PI / 180) * 180 / Math.PI;
  }
  if (mirrored.startDeg !== undefined) {
    mirrored.startDeg = wrapAngle((180 - mirrored.startDeg) * Math.PI / 180) * 180 / Math.PI;
  }
  if (mirrored.endDeg !== undefined) {
    mirrored.endDeg = wrapAngle((180 - mirrored.endDeg) * Math.PI / 180) * 180 / Math.PI;
  }
  // The 'reverse' property should logically remain the same, as it indicates
  // whether to drive the segment in reverse, not a direction relative to the field.
  return mirrored;
}

// Helper function to mirror a ControlPoint across the x=0 axis
function mirrorControlPoint(controlPoint: ControlPoint): ControlPoint {
  return { ...controlPoint, x: -controlPoint.x };
}

// Helper function to deep copy and mirror AutoPathData
function mirrorAutoPathData(autoPath: AutoPathData): AutoPathData {
  const mirroredAutoPath: AutoPathData = JSON.parse(JSON.stringify(autoPath)); // Deep copy

  mirroredAutoPath.startPoint = mirrorPathPoint(mirroredAutoPath.startPoint);

  mirroredAutoPath.lines = mirroredAutoPath.lines.map((line) => {
    const mirroredLine = { ...line };
    mirroredLine.endPoint = mirrorPathPoint(mirroredLine.endPoint);
    if (mirroredLine.controlPoints) {
      mirroredLine.controlPoints = mirroredLine.controlPoints.map(mirrorControlPoint);
    }
    return mirroredLine;
  });

  // Mirror shapes if they exist and have position data
  if (mirroredAutoPath.shapes) {
    mirroredAutoPath.shapes = mirroredAutoPath.shapes.map((shape) => {
      const mirroredShape = { ...shape };
      // Assuming shapes have 'x' and 'y' properties directly or within a 'pos' object
      // This part might need adjustment based on the actual structure of PathShape
      if ('x' in mirroredShape && 'y' in mirroredShape) {
        (mirroredShape as any).x = -(mirroredShape as any).x;
      }
      if ('pos' in mirroredShape && (mirroredShape.pos as Vec2)) {
        (mirroredShape.pos as Vec2) = mirrorPoint(mirroredShape.pos as Vec2);
      }
      return mirroredShape;
    });
  }

  return mirroredAutoPath;
}


export function createWorld(mode: GameMode, seed: number, setups: RobotSetup[], gameSettings?: GameSettings): World {
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

    let robotAutoPath = s.autoPath;
    if (s.alliance === 'red' && s.autoPathEnabled && s.autoPath) {
      robotAutoPath = mirrorAutoPathData(s.autoPath);
    }

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
      // Initialize new auto pathing fields
      autoPathActive: !!(s.autoPathEnabled && robotAutoPath !== undefined),
      currentPathSegmentIndex: 0,
      pathSegmentProgress: 0,
      pathWaitTimer: 0,
      pathSequenceIndex: 0,
      pathTargetPoint: null,
      pathTargetHeading: null,
      autoPath: robotAutoPath, // Assign the (potentially mirrored) autoPath
    });

    // If auto path is enabled, override initial position and heading
    if (s.autoPathEnabled && robotAutoPath) {
      const robot = robots[robots.length - 1]; // Get the newly added robot
      robot.pos = { x: robotAutoPath.startPoint.x, y: robotAutoPath.startPoint.y };
      // Convert degrees to radians for initial heading
      if (robotAutoPath.startPoint.heading === 'constant' && robotAutoPath.startPoint.degrees !== undefined) {
        robot.heading = robotAutoPath.startPoint.degrees * Math.PI / 180;
        robot.turretHeading = robot.heading;
      } else if (robotAutoPath.startPoint.heading === 'linear' && robotAutoPath.startPoint.startDeg !== undefined) {
        robot.heading = robotAutoPath.startPoint.startDeg * Math.PI / 180;
        robot.turretHeading = robot.heading;
      }
      // For tangential, initial heading will be determined by the first path segment.
      // The path follower will handle this dynamically.
    }
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
    penalties: {
      episodes: {},
      pins: {},
      pinFouls: {},
      gateCulprit: { red: null, blue: null },
      rampBallIds: { red: [], blue: [] },
    },
    gameSettings: gameSettings, // Pass gameSettings to the world
  };
}