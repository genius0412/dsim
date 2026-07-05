export type Alliance = 'red' | 'blue';
export type ArtifactColor = 'purple' | 'green';
export type Motif = readonly [ArtifactColor, ArtifactColor, ArtifactColor];

export type GameMode = 'match' | 'free';

export interface Vec2 {
  x: number;
  y: number;
}

/** Per-tick, per-robot, serializable driver command. Translation is in the
 * DRIVER frame (screen frame): +y = away from the driver, +x = driver's right.
 * Robot configuration (drive style, assists) is menu-only, not keybinds. */
export interface RobotCommand {
  driveX: number; // -1..1
  driveY: number; // -1..1
  rotate: number; // -1..1, CCW positive in driver frame
  intake: boolean;
  fire: boolean;
}

/** menu-configured driver assists */
export interface AssistConfig {
  fieldCentric: boolean;
  aimAssist: boolean;
  autoIntake: boolean;
  autoFire: boolean;
}

export type IntakeStyle = 'sloped' | 'vector' | 'triangle';

export interface RobotSpec {
  /** chassis length (front-back) and width, inches; chassis + intake reach must fit 18in */
  length: number;
  width: number;
  intake: IntakeStyle;
}

export type BallState =
  | { kind: 'ground' }
  | { kind: 'flight'; target: Alliance }
  /** jumbling inside the goal's triangular basin, funnelling toward the
   * classifier entrance under gravity */
  | { kind: 'basin'; goal: Alliance }
  /** on the classifier rail: 1D coordinate s from the gate (s=0), flowing
   * down under gravity and stacking by contact. overflow balls ride over the
   * stack and always continue out over the gate. pending balls have boarded
   * but not yet met the stack — classified vs overflow is decided at first
   * contact (9 retained below at that moment ⇒ overflow). */
  | { kind: 'rail'; goal: Alliance; s: number; v: number; overflow: boolean; pending?: boolean }
  | { kind: 'stock'; alliance: Alliance }; // held by the human player, off-field

export interface Artifact {
  id: number;
  color: ArtifactColor;
  state: BallState;
  pos: Vec2;
  vel: Vec2;
  z: number;
  vz: number;
}

export interface RobotState {
  id: number;
  alliance: Alliance;
  spec: RobotSpec;
  pos: Vec2;
  heading: number; // field frame, radians, 0 = +x, CCW positive
  vel: Vec2; // field frame, in/s
  angVel: number;
  turretHeading: number; // field frame
  hopper: ArtifactColor[]; // FIFO, max 3
  fieldCentric: boolean;
  aimAssist: boolean;
  autoIntake: boolean; // intake runs whenever the hopper has room
  autoFire: boolean; // fire automatically when in the zone and on target
  lastFireAt: number;
  lastIntakeAt: number;
}

export interface GoalState {
  alliance: Alliance;
  gateOpen: boolean;
  gateHoldTime: number; // accumulated time a robot has been in the gate zone
  classifiedCount: number; // cumulative, for stats
  overflowCount: number;
}

export type MatchPhase = 'pre' | 'auto' | 'transition' | 'teleop' | 'post' | 'freeplay';

export interface ScoreBreakdown {
  leave: number;
  autoClassified: number;
  autoOverflow: number;
  autoPattern: number;
  teleClassified: number;
  teleOverflow: number;
  telePattern: number;
  depot: number;
  base: number;
  total: number;
}

export interface MatchState {
  phase: MatchPhase;
  /** seconds remaining in the current phase (match mode) */
  phaseTimeLeft: number;
  scores: Record<Alliance, ScoreBreakdown>;
  /** live provisional pattern points for the current ramp arrangement */
  provisionalPattern: Record<Alliance, number>;
}

export interface HumanPlayerState {
  /** colors waiting to be placed into the loading zone, per alliance */
  stock: ArtifactColor[];
  nextPlaceAt: number;
}

export interface World {
  mode: GameMode;
  time: number;
  tick: number;
  rngState: number;
  motif: Motif;
  robots: RobotState[];
  balls: Artifact[];
  goals: Record<Alliance, GoalState>;
  humanPlayers: Record<Alliance, HumanPlayerState>;
  match: MatchState;
  /** transient UI events emitted by the sim this tick (toasts) */
  events: string[];
}
