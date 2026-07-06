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
export type DrivetrainType = 'mecanum' | 'tank' | 'swerve' | 'xdrive';

export interface RobotSpec {
  /** robot display name, team name, team number (0 = unset) */
  name: string;
  teamName: string;
  teamNumber: number;
  /** chassis length (front-back) and width, inches; chassis + intake reach must fit 18in */
  length: number;
  width: number;
  intake: IntakeStyle;
  /** mass in lb (20–42): heavier shoves harder, accelerates slower */
  massLb: number;
  drivetrain: DrivetrainType;
  /** wheel RPM abstraction (200–600): top speed up, acceleration down */
  driveRpm: number;
  /** 0–1: high inertia keeps rapid fire fast on long (high-speed) shots;
   * low inertia is quick up close but recovers slowly after far shots */
  flywheelInertia: number;
  /** robot can pick which hopper color to fire (chases the motif) */
  canSort: boolean;
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
  /** earliest world.time the shooter may fire again (transfer cadence +
   * flywheel recovery after energetic shots) */
  fireReadyAt: number;
  /** G427: an opponent contacted this robot in its BASE during endgame — it
   * counts as fully returned at match end regardless of where it ends up */
  baseAwarded?: boolean;
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
  /** points awarded to THIS alliance from the opponent's fouls */
  foulPoints: number;
  total: number;
}

export interface MatchState {
  phase: MatchPhase;
  /** seconds remaining in the current phase (match mode) */
  phaseTimeLeft: number;
  scores: Record<Alliance, ScoreBreakdown>;
  /** live provisional pattern points for the current ramp arrangement */
  provisionalPattern: Record<Alliance, number>;
  /** fouls COMMITTED BY each alliance (counts, for the HUD); the resulting
   * points land on the OTHER alliance's ScoreBreakdown.foulPoints */
  fouls: Record<Alliance, { minor: number; major: number }>;
  /** seconds left in a sim-driven pre-match countdown (multiplayer: the
   * pre→auto transition runs INSIDE step() so every peer fires it on the same
   * tick). undefined ⇒ no auto-countdown (solo waits for a keypress instead). */
  preCountdown?: number;
}

export interface HumanPlayerState {
  /** out-of-play artifacts in the off-field 2x3 loading-zone box (capacity 6).
   * At setup it holds the 3 pre-staged loading-zone artifacts (PGP, manual setup)
   * plus any unclaimed alliance-area preload set. The HP does nothing until
   * teleop; then it stages the grab row from here one at a time and recycles
   * returned balls back in. */
  box: ArtifactColor[];
  nextPlaceAt: number;
}

/** accumulator for one ordered pinner→pinned pair (G422). Plain numbers so
 * the whole World stays JSON-serializable / lockstep-safe. */
export interface PinState {
  /** seconds the pin condition has held continuously */
  seconds: number;
  /** where the pinned robot was when the pin began (escape = 24" from here) */
  ox: number;
  oy: number;
  /** pinned robot pos last tick, to measure actual (post-solver) speed */
  px: number;
  py: number;
  /** this pin already drew a foul — don't re-fire until the pair separates
   * (a genuine repeat pin), so a sustained push isn't a foul every 3 s */
  fired?: boolean;
}

/** deterministic penalty-engine state (all plain JSON — serializable) */
export interface PenaltyState {
  /** episode debounce: `${rule}:${key}` -> last world.time the rule was active
   * for that subject; a rule re-arms only after PENALTY_CLEAR s of no activity */
  episodes: Record<string, number>;
  /** pinning accumulators, keyed `${pinnerId}-${pinnedId}` */
  pins: Record<string, PinState>;
  /** how many pin fouls a given pinner (by id) has already committed, for the
   * MINOR -> MAJOR escalation on a repeat pin */
  pinFouls: Record<number, number>;
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
  /** robot-robot contact pairs registered THIS tick (transient, by robot id,
   * a < b) — consumed by the penalty engine */
  rrContacts: { a: number; b: number }[];
  /** persistent penalty-engine state (Section 11 fouls) */
  penalties: PenaltyState;
}
