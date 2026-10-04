/**
 * ROBOT IMPORT — the importer's own types. Types only, plus three frame constants: no DOM, no
 * three.js, safe for the main chunk and the server. The contract (`ImportedRobot`) lives in
 * `src/types.ts`; `docs/robot-import-plan.md` §3 binds both; `docs/area/robot-import.md` names the
 * frames every number below is in.
 */
import type { DrivetrainType, GameId, ImportTuning, RobotSpec, Vec2 } from '../types';

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';
/** a signed source axis; `+z` means "the file's +Z points up" */
export type UpAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
export type ModelFormat = 'glb' | 'gltf' | 'stl' | 'obj' | '3mf' | 'ply' | 'step';
/** counter-clockwise quarter turns about +z (seen from above), applied after the default front */
export type QuarterTurns = 0 | 1 | 2 | 3;

export const LENGTH_UNITS: readonly LengthUnit[] = ['mm', 'cm', 'm', 'in', 'ft'];
export const UP_AXES: readonly UpAxis[] = ['+z', '+y', '+x', '-z', '-y', '-x'];
/** inches per one source unit */
export const INCHES_PER_UNIT: Readonly<Record<LengthUnit, number>> = {
  mm: 1 / 25.4,
  cm: 1 / 2.54,
  m: 1 / 0.0254,
  in: 1,
  ft: 12,
};

// ---- the stored mesh frame ---------------------------------------------------------------

/** metres per inch: the stored GLB is in metres (glTF 2.0), every descriptor number in inches */
export const MESH_METRES_PER_INCH = 0.0254;

/**
 * STORED GLB → ROBOT-LOCAL, as a column-major 4×4 (`THREE.Matrix4.fromArray` order).
 *
 * The stored mesh follows glTF so any viewer shows it upright, life-size and facing the viewer:
 * metres, +Y up, +Z front, +X left, origin at the robot-local origin on the floor. The sim and
 * the BIOBUZZ scene work in robot-local inches, +x front, +y left, +z up. So
 *   robot.x = gltf.z / 0.0254,  robot.y = gltf.x / 0.0254,  robot.z = gltf.y / 0.0254.
 * A cyclic permutation times a positive scale: a proper rotation, so triangle winding and
 * normals survive it unchanged.
 */
export const STORED_MESH_TO_ROBOT: readonly number[] = (() => {
  const k = 1 / MESH_METRES_PER_INCH;
  // columns: the images of gltf +X, +Y, +Z, and the translation
  return [0, k, 0, 0, /**/ 0, 0, k, 0, /**/ k, 0, 0, 0, /**/ 0, 0, 0, 1];
})();

/** the inverse of `STORED_MESH_TO_ROBOT`: robot-local inches → stored GLB metres */
export const ROBOT_TO_STORED_MESH: readonly number[] = (() => {
  const k = MESH_METRES_PER_INCH;
  // gltf.x = robot.y·k, gltf.y = robot.z·k, gltf.z = robot.x·k
  return [0, 0, k, 0, /**/ k, 0, 0, 0, /**/ 0, k, 0, 0, /**/ 0, 0, 0, 1];
})();

/** the top-down PNG's side, px */
export const TOP_IMAGE_PX = 512;
/** the card thumbnail's side, px */
export const THUMB_PX = 192;

// ---- the drivetrain choice -----------------------------------------------------------------

/** a motor from the catalogue in `drive.ts`, or a free rpm the player typed */
export type MotorChoice =
  | { kind: 'gobilda'; ratio: string } // a `GOBILDA_RATIOS` key, e.g. '19.2'
  | { kind: 'revHdHex'; cartridges: (3 | 4 | 5)[] } // nominal UltraPlanetary stages, motor side first
  | { kind: 'revCoreHex' }
  | { kind: 'neverest'; model: 'orbital20' | 'orbital3.7' }
  | { kind: 'custom'; freeRpm: number }; // output free rpm, gearbox included

/** a wheel from the catalogue in `drive.ts`, or a diameter the player typed */
export type WheelChoice = { kind: 'catalogue'; id: string } | { kind: 'custom'; diameterMm: number };

export interface DriveSetup {
  drivetrain: DrivetrainType;
  motor: MotorChoice;
  /** belts/gears after the gearbox: driven ÷ driving teeth. > 1 is a reduction, 1 is direct */
  externalRatio: number;
  wheel: WheelChoice;
  /** the measured robot weight, lb */
  massLb: number;
  /** BUTTERFLY only: the traction set's own wheel and external ratio (same motor). Absent = the
   *  mecanum set's. */
  tankWheel?: WheelChoice;
  tankExternalRatio?: number;
}

// ---- the setup the editor re-opens with ----------------------------------------------------

/**
 * How the Model step moves the wheels. `rect`: the four sit on four lines (the front and back
 * axles, the left and right sides), so moving one moves its axle and its side and the four stay an
 * exact rectangle. `free`: each wheel on its own, for a robot whose wheels are not one.
 */
export type WheelLayout = 'rect' | 'free';

/**
 * Everything needed to re-run normalisation and re-open the editor exactly as it was left.
 * `units`/`up` may be `'auto'`; a stored setup keeps `'auto'` so a re-import re-detects.
 */
export interface ImportSetup {
  v: 1;
  units: LengthUnit | 'auto';
  up: UpAxis | 'auto';
  /** quarter turns applied after the default front (`docs/area/robot-import.md`, Detection) */
  yaw: QuarterTurns;
  /** cap on the footprint hull's vertex count, 3..16 */
  hullMaxVerts: number;
  /** wheel contacts the player placed, MODEL frame, FL FR BL BR. Null = detect. The UI clears
   *  them when units, up axis or yaw change, because the model frame moves with those. */
  wheels: Vec2[] | null;
  /**
   * The wheel layout the player picked (`WheelLayout`). Absent in setups from before it existed,
   * and until the player moves a wheel or picks one: then it is `rect` when the wheels are a
   * rectangle (placed ones exactly, detected ones within `WHEEL_SQUARE_TOL_IN`, which are then
   * lined up) and `free` when they are not, so nothing placed by hand moves (`wheelLayoutOf`).
   * In `rect`, detected wheels are lined up into a rectangle however far off they are.
   */
  wheelLayout?: WheelLayout;
  /** compute BIOBUZZ 3D height bands */
  bands: boolean;
  /** the detail a CAD file is read at: `FULL_DETAIL` (0) keeps every triangle, a positive number is
   *  the budget the stored mesh is simplified to (`LIGHT_TRI_BUDGET`; 400k was "Maximum" once) */
  triBudget: number;
  drive: DriveSetup;
  /** the parts that move in a match (`docs/area/robot-import.md`, "Moving parts"). Absent = not yet
   *  looked for (the editor finds the wheels once); `[]` = none. */
  motion?: MotionGroup[];
  /** practice tuning (`ImportedRobot.tune`), copied onto the descriptor by `buildSpec` */
  tune?: ImportTuning;
}

// ---- moving parts ----------------------------------------------------------------------------

/**
 * What a group of CAD bodies does in a match. `wheel`, `roller` and `flywheel` SPIN about their own
 * axle; `turret` turns about a vertical axis; `ramp` (BIOBUZZ's deployable intake) and `fold` (any
 * part the file shows deployed) swing about a HINGE, and are measured folded, which is the robot's
 * starting configuration.
 */
export type MotionRole = 'wheel' | 'roller' | 'flywheel' | 'turret' | 'ramp' | 'fold' | 'spin' | 'swing' | 'slide';

/**
 * THE GENERIC JOINTS, for a mechanism the named roles do not cover (`docs/area/robot-import.md`,
 * "Moving parts"): `spin` turns continuously about an axle, `swing` turns to an angle and back (an arm,
 * a kicker, a claw), `slide` moves along a line and back (a lift, an extension). Each is DRIVEN by one
 * of the robot's own signals (`MotionDrive`), or GEARED to another moving part at a ratio.
 */
export const JOINT_ROLES: readonly MotionRole[] = ['spin', 'swing', 'slide'];

/**
 * What moves a generic joint, read off the robot's state the way the standard parts read it (BIOBUZZ
 * 3D draws them; the other games are drawn from above): the intake running, the launcher spun up, a
 * shot just fired (a pulse), the ramp out, the chassis's speed (a fraction of its top speed), or
 * always on.
 */
export type MotionDrive = 'intake' | 'shooter' | 'fire' | 'ramp' | 'drive' | 'always';
export const MOTION_DRIVES: readonly MotionDrive[] = ['intake', 'shooter', 'fire', 'ramp', 'drive', 'always'];

/** a generic joint's direction: one of the robot's own axes (+x front, +y left, +z up), or a picked
 *  part's (`axisBody`: its round axle, or a slide rail's long side) */
export type JointAxis = 'forward' | 'left' | 'up' | 'part';

export const SPIN_ROLES: readonly MotionRole[] = ['wheel', 'roller', 'flywheel', 'spin'];
export const HINGE_ROLES: readonly MotionRole[] = ['ramp', 'fold'];

/** one moving part as the player set it up (frame-free: bodies and choices, never positions) */
export interface MotionGroup {
  role: MotionRole;
  /** the model's bodies in it (`MeshPart.body` ids), ascending */
  bodies: number[];
  /** spin (or swing) the other way */
  flip?: boolean;
  /** `wheel`: which wheel, 0..3 (FL, FR, BL, BR) */
  corner?: number;
  /** `ramp`, `fold`: how the FILE shows it. `deployed` (the default): it is turned up about its hinge
   *  for the starting configuration; `folded`: the file already is the starting configuration */
  filePose?: 'deployed' | 'folded';
  /** `filePose: 'deployed'`: degrees it folds up by (absent: until it stands upright) */
  foldDeg?: number;
  /** `filePose: 'folded'`: degrees it swings down to deploy (absent: `DEFAULT_DEPLOY_DEG`) */
  deployDeg?: number;
  /** the editor found it (`findWheelGroups`, `findRollerGroups`, …), not the player: said beside it
   *  until the player edits it */
  found?: boolean;
  /** `spin`, `swing`, `slide`: what moves it (absent: `always` for a spin, `intake` otherwise) */
  drive?: MotionDrive;
  /** `spin`, `swing`, `slide`: its direction (absent: its own round axle for a spin, `left` for a
   *  swing, `up` for a slide) */
  axis?: JointAxis;
  /** `axis: 'part'`: the body whose axle (or, for a slide, long side) it takes; a swing also turns
   *  about that axle's line */
  axisBody?: number;
  /** `spin`: turns a second at full drive; `swing`: degrees at full drive; `slide`: inches at full
   *  drive (absent: `JOINT_DEFAULT_AMOUNT`) */
  amount?: number;
  /** moves as another group does, times `ratio` (a gear train, a belt, a cascade's second stage): its
   *  own drive and amount are then not used. An index into the setup's `motion`. */
  follows?: { group: number; ratio: number };
  /** rides on another group (an arm on a slide, a claw on an arm): moves with it. An index into the
   *  setup's `motion`. */
  rideOn?: number;
}

/** a generic joint's amount when the player has not said: turns a second, degrees, inches */
export const JOINT_DEFAULT_AMOUNT: Readonly<Record<'spin' | 'swing' | 'slide', number>> = { spin: 2, swing: 90, slide: 10 };

/** how far a part the file shows folded swings down to deploy, when the player has not said */
export const DEFAULT_DEPLOY_DEG = 90;

/**
 * A moving part as MEASURED: MODEL frame, inches, in the STARTING pose (a ramp folded). A positive
 * turn about `axis` is the part's own sense: a wheel rolling the robot forward, a roller drawing in,
 * a flywheel throwing outward over its top, a turret turning left, a ramp deploying.
 */
export interface MotionPart {
  role: MotionRole;
  bodies: number[];
  /** a point on the axis */
  pivot: [number, number, number];
  /** unit direction */
  axis: [number, number, number];
  /** wheel: its rolling radius; roller, flywheel: its outer radius (inches; 0 for the rest) */
  radius: number;
  /** ramp, fold: radians from the starting pose to deployed (0 for the rest) */
  deploy: number;
  /** the part this one rides on (a roller on a ramp, a flywheel on a turret), by index, or -1 */
  parent: number;
  corner?: number;
  /** the `ImportSetup.motion` group it was measured from */
  group: number;
  /** `spin`, `swing`, `slide`: its drive and amount (turns a second, RADIANS, inches) */
  drive?: MotionDrive;
  amount?: number;
  /** moves as part `index` does (an index into the measured parts), times `ratio` */
  follows?: { index: number; ratio: number };
}

/**
 * THE STORED MESH'S MOVING PARTS: every moving part is its own node in the stored GLB, translated to
 * its pivot (its geometry relative to it), with this in the node's `extras` under `dsim` (GLTFLoader
 * puts it in `userData.dsim`). Stored-mesh frame: `axis` is a unit vector there; `radius` is inches.
 * A viewer that knows nothing of it draws the node where it is: the starting pose.
 */
export interface StoredMotion {
  v: 1;
  role: MotionRole;
  axis: [number, number, number];
  radius: number;
  deploy: number;
  corner?: number;
  /** its place among the stored moving parts, for `follow` */
  id?: number;
  /** `spin`, `swing`, `slide`: what moves it, and how far at full drive (turns a second, radians, inches) */
  drive?: MotionDrive;
  amount?: number;
  /** moves as stored part `id` does, times `ratio` */
  follow?: { id: number; ratio: number };
}

const MOTION_ROLES: readonly MotionRole[] = ['wheel', 'roller', 'flywheel', 'turret', 'ramp', 'fold', 'spin', 'swing', 'slide'];
/** a generic joint's amount, at most: 50 turns a second, two full turns of swing, 60 in of slide */
const AMOUNT_MAX: Readonly<Record<'spin' | 'swing' | 'slide', number>> = { spin: 50, swing: 4 * Math.PI, slide: 60 };

/**
 * A node's `userData.dsim` as a `StoredMotion`, or null. Read on a mesh that may be another player's
 * (a room's relay), so every field is checked: a known role, a finite axis made unit, a radius in
 * [0, 20] in, a deploy angle in [0, π], a joint's drive one of `MOTION_DRIVES` and its amount within
 * `AMOUNT_MAX`, ids and a follow's ratio in range. An older viewer reads a joint's unknown role as no
 * moving part at all, and draws it where it is.
 */
export function readStoredMotion(x: unknown): StoredMotion | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (o.v !== 1 || !MOTION_ROLES.includes(o.role as MotionRole)) return null;
  const a = o.axis;
  if (!Array.isArray(a) || a.length !== 3 || !a.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const l = Math.hypot(a[0], a[1], a[2]);
  if (l < 1e-6) return null;
  const num = (v: unknown, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
  const out: StoredMotion = { v: 1, role: o.role as MotionRole, axis: [a[0] / l, a[1] / l, a[2] / l], radius: num(o.radius, 0, 20), deploy: num(o.deploy, 0, Math.PI) };
  if (typeof o.corner === 'number' && Number.isInteger(o.corner) && o.corner >= 0 && o.corner < 4) out.corner = o.corner;
  const int = (v: unknown, hi: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < hi ? v : null);
  const id = int(o.id, 64);
  if (id !== null) out.id = id;
  if (out.role === 'spin' || out.role === 'swing' || out.role === 'slide') {
    if (MOTION_DRIVES.includes(o.drive as MotionDrive)) out.drive = o.drive as MotionDrive;
    out.amount = num(o.amount, 0, AMOUNT_MAX[out.role]);
  }
  if (o.follow && typeof o.follow === 'object') {
    const f = o.follow as Record<string, unknown>;
    const fid = int(f.id, 64);
    if (fid !== null && typeof f.ratio === 'number' && Number.isFinite(f.ratio)) out.follow = { id: fid, ratio: Math.max(-100, Math.min(100, f.ratio)) };
  }
  return out;
}

/**
 * The stored GLB's ceiling: a bake over it is simplified until it fits (`bakeSceneHere`). About 14M
 * triangles at ~9 bytes each, over twice the largest kit measured (goBILDA's DECODE bot, 6.24M);
 * it was 4 MiB while every robot was simplified to 250k.
 */
export const MAX_MESH_BYTES = 128 * 1024 * 1024;

// ---- measurement ---------------------------------------------------------------------------

export type ImportCheckCode =
  | 'empty'
  | 'oversize'
  | 'units-suspect'
  | 'up-uncertain'
  | 'no-floor'
  | 'few-wheels'
  | 'wheels-picked'
  | 'wheels-off-hull'
  | 'mass-low'
  | 'mass-high'
  | 'rpm-low'
  | 'rpm-high'
  | 'tank-rpm-clamped'
  | 'hull-simplified'
  | 'mesh-simplified'
  | 'front-assumed';

/**
 * Which way the robot faces, from its geometry (`detectFront`, `docs/area/robot-import.md`). Three
 * cues, each a vote along the footprint's two axes: an INTAKE (low geometry across the robot that
 * reaches out past the wheels further at one end than the other), the WHEELS set back from one
 * end, and the MASS (surface area) sitting toward the other end. When they agree strongly enough the
 * front is DETECTED; otherwise it is ASSUMED to be the CAD front view (`defaultFront`) and the
 * editor says so.
 */
export interface FrontDetection {
  /** the quarter turns (the setup's `yaw`, from the CAD front) that put the found front at +x */
  yaw: QuarterTurns;
  /** 0..1, how far the strongest direction is ahead of the rest */
  confidence: number;
  /** confidence ≥ `FRONT_MIN_CONFIDENCE`: the front was found, not assumed */
  detected: boolean;
  /** the cue that carried it: 'intake', 'wheels' or 'mass'; null when none did */
  cue: 'intake' | 'wheels' | 'mass' | null;
}

/** one plain-language check, for the Review step (copy follows `docs/area/ui.md`) */
export interface ImportCheck {
  code: ImportCheckCode;
  /** `block`: Save stays disabled. `warn`: shown, Save allowed. `info`: a note */
  level: 'block' | 'warn' | 'info';
  message: string;
}

export interface WheelDetection {
  /** FL FR BL BR, MODEL frame, or null when detection failed */
  wheels: Vec2[] | null;
  /** every floor-contact cluster's centre, MODEL frame, for the editor's inset */
  contacts: Vec2[];
  /** why detection failed or what it chose, a plain sentence */
  note: string;
}

/** what `measureParts` (and the engine's `normalise`) reports */
export interface ImportMeasurement {
  units: LengthUnit;
  unitsDetected: boolean;
  up: UpAxis;
  upDetected: boolean;
  /** best-minus-second up-axis score; under 0.15 the UI should ask */
  upMargin: number;
  yaw: QuarterTurns;
  /** source → MODEL frame, column-major 4×4 (scale, up rotation, front, yaw, floor, centring) */
  sourceToModel: number[];
  /** bounding box of the whole model in the MODEL frame, inches */
  size: { length: number; width: number; height: number };
  /** footprint hull, MODEL frame, CCW, ≤ hullMaxVerts, quantised to 1/64 in */
  hull: Vec2[];
  /** vertex count of the raw hull before reduction */
  hullRawVerts: number;
  /** largest distance from a raw hull vertex to the reduced hull, inches */
  hullDeviation: number;
  wheels: WheelDetection;
  /** which way the geometry says the robot faces (measured in this orientation, given as a yaw) */
  front: FrontDetection;
  /** wheels in force: the override, else detected (lined up into a rectangle when the layout asks
   *  for one, `squareWheels`), else null */
  wheelsUsed: Vec2[] | null;
  wheelSource: 'manual' | 'detected' | 'none';
  /** the detected wheels were moved to line them up into a rectangle (absent when they were not,
   *  an exact rectangle included) */
  wheelsSquared?: true;
  /** the robot-local origin (wheelbase centre, else hull box centre), MODEL frame */
  origin: Vec2;
  heightIn: number;
  /** robot-local frame (already shifted), absent when one prism is close enough */
  bands?: { z0: number; z1: number; hull: Vec2[] }[];
  trisIn: number;
  checks: ImportCheck[];
  /** the moving parts, MODEL frame, starting pose (absent when the setup has none) */
  motion?: MotionPart[];
}

// ---- the library record (plan §3.2) ------------------------------------------------------

export interface LibrarySource {
  name: string;
  format: string;
  bytes: number;
  trisIn: number;
  trisOut: number;
}

export interface LibraryRobot {
  /** = spec.imported.id */
  id: string;
  game: GameId;
  spec: RobotSpec;
  /** normalised GLB (stored mesh frame above), ≤ `MAX_MESH_BYTES`: every triangle at Full detail, 250k
   *  at Light (≤ 4 MB and ≤ 400k before 2026-10-04); quantised and meshopt-packed since 2026-10-03
   *  (engine/storedGlb.ts), a float GLB when saved before */
  mesh: Blob;
  /** top-down orthographic PNG, `TOP_IMAGE_PX`, transparent; frame: `topImageFrame` */
  top: Blob;
  /** 3/4 view PNG for cards, `THUMB_PX` */
  thumb: Blob;
  /** a lighter GLB (same frame) for a room's visuals relay, made once by the engine's `liteMesh` when
   *  `mesh` is over the relay's 1 MiB cap; absent when `mesh` already fits or has not been needed. A
   *  re-save of the robot drops it, because the mesh it was cut from may have changed. */
  meshLite?: Blob;
  /** the import id inside the share file this robot was added from. A share-file import always gets
   *  a FRESH id (a room refuses two seats with one id, so two teammates who loaded the same file
   *  could not sit together); this is how a second import of that file on this device is still
   *  recognised as the same robot. Absent on robots imported from CAD. */
  sharedFrom?: string;
  source: LibrarySource;
  setup: ImportSetup;
  created: number;
  updated: number;
}

/** a library row without its blobs, for lists */
export type LibraryEntry = Omit<LibraryRobot, 'mesh' | 'top' | 'thumb' | 'meshLite'>;
