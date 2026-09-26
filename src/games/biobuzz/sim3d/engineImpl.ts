/**
 * BIOBUZZ 3D PHYSICS — the PERSISTENT WORLD (Day 1, `docs/biobuzz/plan-3d.md` §3.2).
 *
 * ⚠️ **HEAVY. This module is reachable ONLY through `sim3d/impl.ts`, which only
 * `initPhysics3d()` (`engine.ts`) imports — and it imports it dynamically.** Everything here
 * used to sit below the loader inside `engine.ts`, which made a static `import` of the loader
 * drag the whole 3D implementation into the MAIN chunk; `npm run bundleaudit` measured that at
 * ~17 KB gz of physics logic every player of every game downloaded whether or not they ever
 * stepped a 3D world. The loader stayed in `engine.ts`; the world moved here, unchanged.
 * Nothing under `src/` outside `sim3d/` may import this file — the RENDER lane asserts it.
 */
import { rapier3d, type Rapier3d } from './engine';

import type { Alliance, Artifact, BallState, RobotState, World } from '../../../types';
import { chassisInertia } from '../../../sim/robot';
import { shoveMass } from '../../../sim/drivetrain';
import { BALL_REST_SPEED, PHYS_WALL_FRICTION, GRAVITY, PHYS_SOLVER_ITERS, PHYS_ALLOWED_ERROR } from '../../../config';
import { BB3_CCD_SPEED, BB3_CONTACT_FREQ, BB3_FIT_DEPTH, BB3_FIT_MAX, BB3_FIT_STEP, BB3_LAUNCH_CLEAR_MAX, BB3_LAUNCH_CLEAR_SLOP, BB3_LAUNCH_CLEAR_STEP, BB3_REST_SPEED, BB3_REST_TICKS, BB3_ROLL_DECEL, BB3_ROLL_FLOOR_Z, BB3_WALL_H, BB_POLLEN_R, bbHeightNow } from '../config';
import { bbRampSettled } from '../robot';
import {
  addChassis3dColliders,
  chassis3dBaseColliderCount,
  clearChassis3dColliders,
  chassis3dShapes,
  chassis3dReachShapes,
  swapChassis3dReachColliders,
  type Chassis3dShape,
} from './bodies';
import {
  buildHiveTray3d,
  buildStatics3d,
  elementMass,
  hiveTrayRefTheta,
  robotHeightIn,
  useHiveDynamic,
  ELEMENT_FRICTION,
  ELEMENT_RESTITUTION,
  ELEMENT_ROLL_DAMP,
  GROUP_ELEMENT,
} from './bodies';
import { hyp3, hypXY, quatMul, QUAT_IDENTITY, round4, yawQuat, yawOfQuat } from './math3';
import { datan2, dcos, dsin, nextRandom, rot } from '../../../math';

/** the LAST JSON a robot body was synced to -- what `syncRobot` diffs the CURRENT `RobotState`
 * against to decide "did something outside the solve move this" (see plan section 3.2). */
interface LastRobot {
  x: number;
  y: number;
  z: number;
  heading: number;
  vx: number;
  vy: number;
  vz: number;
  angVel: number;
}

/** the LAST JSON an element body was synced to — what `syncElement` diffs against, the same way
 * `LastRobot` works. It used to carry a `fixed` flag recording which BODY KIND the element was
 * built as, back when a flower-parked element was a FIXED body; since Day 2 every element that
 * wants a body at all is dynamic (`wantsDynamicBody`), the flag was written `false` at all three
 * call sites and read nowhere, so it is gone. */
interface LastElement {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface Engine3d {
  world3d: InstanceType<Rapier3d['World']>;
  robots: Map<number, InstanceType<Rapier3d['RigidBody']>>;
  elements: Map<number, InstanceType<Rapier3d['RigidBody']>>;
  hiveTrays: Record<Alliance, InstanceType<Rapier3d['RigidBody']>>;
  /** each tray's REVOLUTE JOINT to its fixed anchor, or `null` on the Day 1 kinematic path
   * (`BB3_HIVE_DYNAMIC` off). Held so the limits can be re-read and so a future motor-based
   * brake has somewhere to live; the detent itself does not need it (see `applyHiveTilt`). */
  hiveJoints: Record<Alliance, InstanceType<Rapier3d['ImpulseJoint']> | null>;
  /** is each tray currently HELD at a stop by the detent? A per-engine cache, not state: it is
   * recomputed from the torque balance every tick and read only for the "do not re-pin a body
   * that is already exactly pinned" guard, which is what keeps a resting element from being
   * re-woken 60 times a second. */
  hiveHeld: Record<Alliance, boolean>;
  /** element id -> consecutive ticks under `BB3_REST_SPEED` (`derive.ts`'s cell-membership
   * timer). Reset to 0 the instant an element is faster than that, off by any writer. */
  restTicks: Map<number, number>;
  /** element id -> consecutive ticks spent in `groundRoll3d`'s narrow-hull "vibration" branch
   * (perched on a hull with no broad support and no cell/tube tag) — the give-up clock for that
   * branch, NOT `restTicks`. Reset to 0 the instant the element leaves the branch for any reason
   * (it falls, it reaches a broad support, it gets tagged). See `BB3_VIBE_GIVEUP_TICKS`. */
  narrowVibeTicks: Map<number, number>;
  lastRobot: Map<number, LastRobot>;
  lastElement: Map<number, LastElement>;
  /**
   * The HEIGHT each robot's chassis collider was actually BUILT to (in) — which is not always
   * `robotHeightIn(spec)`, because of R102's DEPLOY LATCH (plan §3.3).
   *
   * A build taller than R102's 18-in starting cube STOWS to get under it and DEPLOYS when the
   * MATCH begins, so its collider is one box before the `pre` edge and a taller one after, and
   * `bbHeightNow` is the single reader of the phase that decides which. It has to be RECORDED
   * rather than recomputed at each use, because READBACK converts the body's centre z into
   * `RobotState.z` (the chassis BOTTOM) by subtracting half the height: read back against a
   * height the collider was NOT built to and the robot's z jumps by the difference on the deploy
   * tick, which is a robot that visibly sinks into the tiles for one frame and a `worldHash`
   * that moves for no gameplay reason.
   */
  robotHeights: Map<number, number>;
  /**
   * The RAMP-READY state (`bbRampSettled(r, world.time)`) each robot's chassis collider was
   * actually BUILT with -- `robotHeights`'s twin (the rebuild key is now (height, rampReady)
   * together). A side-roller build needs no edge: it is built in with the body and never rebuilt.
   * A `ramp` build's reach hardware only becomes solid `BB_RAMP_DEPLOY_S` after the toggle (the
   * tick `bbRampSettled` turns true, when the sim starts crediting the reach) and stops being
   * solid the instant it folds (`bbRampOut` false makes `bbRampSettled` false immediately, no
   * settle delay on the way back in) -- so this, unlike height, can flip either direction on any
   * tick, not only once at the `pre` boundary.
   */
  robotRampReady: Map<number, boolean>;
  /** `world.tick` as of the last `engineFor` call -- a SMALLER tick next time means a restart
   * or a reseed (a fresh world reusing the same JS object is not a case that arises here, but a
   * scene or a smoke fixture rebuilding `world.tick` back to 0 on the SAME `World` object is),
   * and the engine is rebuilt from scratch rather than asked to reconcile backwards in time. */
  lastTick: number;
  /** how many times the containment safety net has fired this match -- a smoke assertion reads
   * this and expects it to STAY zero; see `containmentPass`. */
  containmentFixes: number;
}

const ENGINES = new WeakMap<World, Engine3d>();

function disposeEngine(e: Engine3d): void {
  e.world3d.free();
}

/**
 * ⚠️ **FREE A FINISHED MATCH'S 3D WORLD. A `WeakMap` CANNOT DO THIS FOR YOU.**
 *
 * `ENGINES` is keyed on the `World` object, so when the `World` is dropped the ENTRY goes — and
 * the `Engine3d` with it, and with that the only handle anyone had on the wasm world. What does
 * NOT go is the world itself: it lives in Rapier's linear memory, and the JS GC has no idea that
 * memory exists. `free()` is the only thing that returns it, and wasm linear memory never
 * shrinks, so what is not freed is held for the life of the tab or the server process. One room
 * at a time is nothing; a server that has run a few hundred matches, or a player who has started
 * a dozen practices without reloading, is a different number.
 *
 * Idempotent, and safe for a `World` that never had a 3D engine — every teardown path may call
 * it unconditionally, which is the only way it actually gets called on all of them.
 *
 * ⚠️ The world must be DEAD when this is called: anything that steps it afterwards steps a freed
 * wasm world. `engineFor` would happily build a fresh one, so the failure is silent memory
 * churn rather than a crash, which is worse — keep this on the teardown path only.
 */
export function disposeEngineFor(world: World): void {
  const e = ENGINES.get(world);
  if (!e) return;
  ENGINES.delete(world);
  disposeEngine(e);
}

function buildEngine(world: World): Engine3d {
  const RAPIER = rapier3d();
  const world3d = new RAPIER.World({ x: 0, y: 0, z: -GRAVITY });
  world3d.integrationParameters.lengthUnit = 10; // matches the Day 0 spike's inches convention
  // THE SAME SOLVER TUNING AS THE 2D ROBOT SOLVE (`physicsEngine.ts`'s `makeWorld`), not
  // Rapier3D's own defaults (4 solver iterations, unset contact frequency/allowed error).
  // Parity gap found by measurement (this lane's final report): a robot staged flush against
  // a wall (a real BIOBUZZ start position) spinning on `rotate: 1` for one second gave 2D
  // 0.298 rad/s against 3D 0.691 (ratio 2.317) even after the collider-footprint and
  // wall-friction fixes below; matching these three parameters brought it to 1.458, and the
  // remaining gap turned out to be the check comparing wall-contact friction between two
  // DIFFERENT Rapier solvers rather than the shared drivetrain model -- see the SIM3D lane's
  // drive-feel checks, which now measure in the open field instead.
  world3d.integrationParameters.numSolverIterations = PHYS_SOLVER_ITERS;
  // ⚠️ CONTACT STIFFNESS IS THE ONE PARAMETER THAT IS **NOT** THE 2D ROBOT SOLVE'S.
  // `PHYS_CONTACT_FREQ` (12 Hz) is tuned for DECODE's robot-robot shove and cannot move — its
  // own header records that 15 Hz broke the classifier-jitter ratchet and 25 Hz broke two G408
  // checks. A soft contact sags `g/(2·π·f)²` at rest, which at 12 Hz is 0.068 in of overlap on
  // every resting pair in this world: MEASURED here, an element settled in a HIVE cell sank
  // 0.127 in into the tray floor (3 or 5 elements, both alliances, 900 ticks) and a POLLEN
  // column in a FLOWER tube overlapped itself by up to 0.95 in at capacity. The 2D pipeline
  // already answered this question the other way for BALLS — `PHYS_BALL_CONTACT_FREQ` is 25,
  // "stiffer than the robot world (12 Hz), which let two grounded balls sit visibly
  // overlapping" — and the 3D engine runs ONE world, so it had been giving every element in it
  // the chassis numbers. `BB3_CONTACT_FREQ` is BIOBUZZ's own dial; at 30 Hz the same cell
  // measurement is 0.035 in. See its header in `../config` for the full sweep.
  // ⚠️ `sim3d/predict.ts` builds a SECOND world with a hand-copied parameter block and must
  // carry the same four values, or a predicted contact solves at a different stiffness from the
  // authoritative one and every landed shot reconciles with a snap. The SIM3D lane asserts it.
  world3d.integrationParameters.contact_natural_frequency = BB3_CONTACT_FREQ;
  world3d.integrationParameters.normalizedAllowedLinearError = PHYS_ALLOWED_ERROR;
  buildStatics3d(RAPIER, world3d, PHYS_WALL_FRICTION);
  // THE TRAY IS BUILT AT THE POSE THE WORLD SAYS IT IS IN, not at level: a dynamic body created
  // upright and then rotated into place is a body that falls for one tick, and an engine rebuilt
  // mid-swing (a reconcile, a scene restart) has to resume the swing, not restart it.
  const trayRed = buildHiveTray3d(RAPIER, world3d, 'red', hiveTiltAngle(world, 'red'));
  const trayBlue = buildHiveTray3d(RAPIER, world3d, 'blue', hiveTiltAngle(world, 'blue'));
  const hiveTrays: Record<Alliance, InstanceType<Rapier3d['RigidBody']>> = {
    red: trayRed.body,
    blue: trayBlue.body,
  };
  const hiveJoints: Record<Alliance, InstanceType<Rapier3d['ImpulseJoint']> | null> = {
    red: trayRed.joint,
    blue: trayBlue.joint,
  };
  const engine: Engine3d = {
    world3d,
    robots: new Map(),
    elements: new Map(),
    hiveTrays,
    hiveJoints,
    hiveHeld: { red: true, blue: true },
    restTicks: new Map(),
    narrowVibeTicks: new Map(),
    lastRobot: new Map(),
    lastElement: new Map(),
    robotHeights: new Map(),
    robotRampReady: new Map(),
    lastTick: world.tick,
    containmentFixes: 0,
  };
  // DETERMINISTIC BUILD ORDER: statics, the two trays (above), robots by ascending id, elements
  // by ascending id (plan section 3.2 / this lane's binding design point 1).
  for (const r of [...world.robots].sort((a, b) => a.id - b.id)) {
    syncRobot(RAPIER, engine, r, bbHeightNow(world, r.spec), bbRampSettled(r, world.time));
  }
  for (const b of [...world.balls].sort((a, b) => a.id - b.id)) syncElement(RAPIER, engine, world, b);
  return engine;
}

/**
 * The persistent 3D engine for `world`, building it on first use and rebuilding it from scratch
 * when `world.tick` has gone BACKWARDS (a restart or a reseed reusing the same `World` object)
 * or the set of robot ids has changed (a robot joined or left). Every other call reuses the same
 * engine and relies on `syncRobot`/`syncElement` to reconcile it to the world's current JSON.
 */
export function engineFor(world: World): Engine3d {
  let e = ENGINES.get(world);
  if (e) {
    const idsNow = world.robots.map((r) => r.id);
    const idsMatch = idsNow.length === e.robots.size && idsNow.every((id) => e!.robots.has(id));
    if (world.tick < e.lastTick || !idsMatch) {
      disposeEngine(e);
      e = undefined;
    }
  }
  if (!e) {
    e = buildEngine(world);
    ENGINES.set(world, e);
  }
  e.lastTick = world.tick;
  return e;
}

const POSE_EPS = 1e-4;
/**
 * how far an element's rounded position must move in ONE tick to count as STILL RELAXING, and so
 * be kept from sleeping — see READBACK. APPROX, and it is a KNEE, measured on the staged columns
 * of an idle 2v2 world (worst pollen-pollen interpenetration against the FLOWER3D lane's 0.2-in
 * bound / ticks until the four columns are asleep):
 *
 *   5e-5   0.132 in   > 900 ticks (4 elements still awake at tick 900)
 *   5e-4   0.131 in   ~ 400 ticks      ← here
 *   1e-3   0.529 in   ~ 300 ticks      (frozen mid-separation — FAILS the bound)
 *   3e-3   0.616 in   ~ 300 ticks
 *
 * So half a thousandth of an inch per tick (0.03 in/s) is the slowest motion that is still
 * un-jamming a column rather than polishing it.
 */
const RELAX_EPS = 5e-4;

/**
 * THE CHASSIS COLLIDER, at `heightIn`. Built twice here: once when the body is created, and
 * again at the R102 DEPLOY EDGE when a stowed robot stands up (see `Engine3d.robotHeights`).
 *
 * ⚠️ THE SHAPE ITSELF LIVES IN `bodies.ts` (`addChassis3dColliders`), next to `chassis3dShapes`;
 * this wrapper is only "which world, and off which engine". The FULL predictor deliberately does
 * NOT share it — it keeps one `robotExtents` cuboid, because the compound doubled its reconcile
 * cost (`predict.ts`, the note above `makeRobotBody`). What it does share is the HEIGHT rule
 * (`bbHeightNow`, re-fit at the deploy edge), which it used to get wrong.
 */
function addChassisCollider(
  RAPIER: Rapier3d,
  engine: Engine3d,
  body: InstanceType<Rapier3d['RigidBody']>,
  r: RobotState,
  heightIn: number,
  rampReady: boolean,
): void {
  addChassis3dColliders(RAPIER, engine.world3d, body, r.spec, heightIn, rampReady);
}

/** the height a robot's collider is CURRENTLY built to — the recorded one, falling back to the
 * build's deployed height for a body this engine has not seen yet. Readback and the containment
 * net both have to use it; see `Engine3d.robotHeights`. */
function builtHeight(engine: Engine3d, r: RobotState): number {
  return engine.robotHeights.get(r.id) ?? robotHeightIn(r.spec);
}

type Collider3 = InstanceType<Rapier3d['Collider']>;
type Shape3 = Collider3['shape'];

/** a fixed collider a placed chassis is tested against, with its world-space AABB. */
interface FitStatic {
  col: Collider3;
  groups: number;
  skin: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** built once per engine: every fixed collider never moves. */
const FIT_STATICS = new WeakMap<Engine3d, FitStatic[]>();

function rotVec(q: { x: number; y: number; z: number; w: number }, v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** a radius that bounds `shape` about its own origin; Infinity for a shape it does not know. */
function shapeRadius(shape: Shape3): number {
  const s = shape as unknown as {
    vertices?: Float32Array;
    halfExtents?: { x: number; y: number; z: number };
    radius?: number;
    halfHeight?: number;
    borderRadius?: number;
  };
  const border = s.borderRadius ?? 0;
  if (s.vertices) {
    let m = 0;
    for (let i = 0; i + 2 < s.vertices.length; i += 3) m = Math.max(m, hyp3(s.vertices[i], s.vertices[i + 1], s.vertices[i + 2]));
    return m + border;
  }
  if (s.halfExtents) return hyp3(s.halfExtents.x, s.halfExtents.y, s.halfExtents.z) + border;
  if (s.radius !== undefined && s.halfHeight !== undefined) return hypXY(s.radius, s.halfHeight) + border;
  if (s.radius !== undefined) return s.radius + border;
  return Infinity;
}

function fitStatics(engine: Engine3d): FitStatic[] {
  let list = FIT_STATICS.get(engine);
  if (list) return list;
  list = [];
  const out = list;
  engine.world3d.forEachCollider((col) => {
    const p = col.parent();
    if (!p || !p.isFixed() || col.isSensor()) return;
    const t = col.translation();
    const q = col.rotation();
    const s = col.shape as unknown as { vertices?: Float32Array };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxZ = -Infinity;
    if (s.vertices) {
      for (let i = 0; i + 2 < s.vertices.length; i += 3) {
        const v = rotVec(q, { x: s.vertices[i], y: s.vertices[i + 1], z: s.vertices[i + 2] });
        minX = Math.min(minX, t.x + v.x);
        maxX = Math.max(maxX, t.x + v.x);
        minY = Math.min(minY, t.y + v.y);
        maxY = Math.max(maxY, t.y + v.y);
        maxZ = Math.max(maxZ, t.z + v.z);
      }
    } else {
      const he = (col.shape as unknown as { halfExtents?: { x: number; y: number; z: number } }).halfExtents;
      const rad = shapeRadius(col.shape);
      // an axis-aligned box keeps its exact top, which is how the floor is told apart
      const flat = he && Math.abs(q.x) < 1e-9 && Math.abs(q.y) < 1e-9 && Math.abs(q.z) < 1e-9;
      minX = t.x - rad;
      maxX = t.x + rad;
      minY = t.y - rad;
      maxY = t.y + rad;
      maxZ = flat ? t.z + he.z : t.z + rad;
    }
    // the tiles are the floor's business: a chassis rests ON them, never beside them
    if (maxZ <= 1e-6) return;
    out.push({ col, groups: col.collisionGroups(), skin: col.contactSkin(), minX, maxX, minY, maxY });
  });
  FIT_STATICS.set(engine, list);
  return list;
}

/** a chassis collider in the body's own frame, read once per fit. */
interface FitPart {
  shape: Shape3;
  t: { x: number; y: number; z: number };
  q: { x: number; y: number; z: number; w: number };
  groups: number;
  skin: number;
}

function groupsMeet(a: number, b: number): boolean {
  return ((a >>> 16) & (b & 0xffff)) !== 0 && ((b >>> 16) & (a & 0xffff)) !== 0;
}

/** does the chassis, at (x, y, centreZ) and `heading`, sit more than `BB3_FIT_DEPTH` inside a fixed solid? */
function chassisInsideStatic(parts: FitPart[], reach: number, statics: FitStatic[], x: number, y: number, centreZ: number, heading: number): boolean {
  const yaw = yawQuat(heading);
  for (const s of statics) {
    if (x + reach < s.minX || x - reach > s.maxX || y + reach < s.minY || y - reach > s.maxY) continue;
    for (const p of parts) {
      if (!groupsMeet(p.groups, s.groups)) continue;
      const o = rotVec(yaw, p.t);
      const hit = s.col.contactShape(p.shape, { x: x + o.x, y: y + o.y, z: centreZ + o.z }, quatMul(yaw, p.q), 0);
      if (hit && hit.distance - p.skin - s.skin < -BB3_FIT_DEPTH) return true;
    }
  }
  return false;
}

/**
 * ⚠️ **A CHASSIS PLACED INSIDE THE HIVE FRAME WAS LIFTED ONTO IT AND NEVER CAME DOWN.** Runs on a
 * pose the solver did not produce: a new body, a teleport, a deploy-edge rebuild. A chassis
 * straddling a 2.15-in foot bar is 2.15 in deep vertically and 7+ in deep sideways, so Rapier's
 * shallowest way out was UP (z 0.50 after ONE tick, 2.1 after a few); the A-frame leg then ran
 * between the frame box and an intake arm, pushed from both sides (normals ±(0.83, 0.56)), and
 * the robot could not translate or turn with the full drive wrench, even at zero friction.
 * MEASURED (`scratch/rampstuck.ts`): every one of the 8/400 stuck runs started inside the frame,
 * and 0/1200 runs that started clear ever climbed; a 2v2 ram probe never lifted a robot either.
 *
 * So a chassis more than `BB3_FIT_DEPTH` inside any fixed solid is moved SIDEWAYS, at its own
 * height and heading, to the nearest clear spot on rings `BB3_FIT_STEP` apart — where a field
 * crew would set it down. Fixed bodies only: they never move, so the answer does not depend on
 * which robots or elements this sync has reached yet. No clear spot inside `BB3_FIT_MAX` leaves
 * the pose alone. Returns true when it moved the robot.
 *
 * The chassis only (boxes, pocket filler, mechanism shapes), not the reach hardware: a ramp blade
 * inside a static is the swing guard's and the embed fold's case (`elements3d.ts`), and moving
 * the robot here would take that decision away from them.
 */
function setChassisClear(engine: Engine3d, body: InstanceType<Rapier3d['RigidBody']>, r: RobotState, centreZ: number): boolean {
  const parts: FitPart[] = [];
  let reach = 0;
  // the chassis boxes, pocket filler and mechanism shapes come first; the reach hardware after
  const n = Math.min(body.numColliders(), chassis3dBaseColliderCount(r.spec, builtHeight(engine, r)));
  for (let i = 0; i < n; i++) {
    const c = body.collider(i);
    if (c.isSensor()) continue;
    const t = c.translationWrtParent() ?? { x: 0, y: 0, z: 0 };
    const q = c.rotationWrtParent() ?? QUAT_IDENTITY;
    const shape = c.shape;
    const skin = c.contactSkin();
    parts.push({ shape, t: { x: t.x, y: t.y, z: t.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w }, groups: c.collisionGroups(), skin });
    reach = Math.max(reach, hypXY(t.x, t.y) + shapeRadius(shape) + skin);
  }
  const statics = fitStatics(engine);
  if (!chassisInsideStatic(parts, reach, statics, r.pos.x, r.pos.y, centreZ, r.heading)) return false;
  const DIRS = 16;
  for (let ring = 1; ring * BB3_FIT_STEP <= BB3_FIT_MAX + 1e-9; ring++) {
    const d = ring * BB3_FIT_STEP;
    for (let k = 0; k < DIRS; k++) {
      const a = (2 * Math.PI * k) / DIRS;
      const x = round4(r.pos.x + d * dcos(a));
      const y = round4(r.pos.y + d * dsin(a));
      if (Math.abs(x) > BB_HALF_X || Math.abs(y) > BB_HALF_Y) continue;
      if (chassisInsideStatic(parts, reach, statics, x, y, centreZ, r.heading)) continue;
      r.pos.x = x;
      r.pos.y = y;
      body.setTranslation({ x, y, z: centreZ }, true);
      return true;
    }
  }
  return false;
}

/**
 * Reconcile one robot's body to its current `RobotState` JSON. Creates the body on first use;
 * afterwards, TELEPORTS it (position, rotation, both velocities) only when the JSON has moved
 * by more than `POSE_EPS` since the last sync -- a reconcile snap, a scene edit, a restart --
 * and otherwise leaves it alone so a resting/sleeping body stays asleep.
 *
 * MASS IS RECOMPUTED EVERY TICK, unconditionally, because `shoveMass` depends on `r.powerDraw`,
 * which changes tick to tick (a spun-up flywheel, a running intake) exactly the way the 2D
 * `solveRobots` picks it up fresh every rebuild. Setting mass properties does not move the body,
 * so it cannot fight the "leave a resting body alone" rule above.
 */
function syncRobot(RAPIER: Rapier3d, engine: Engine3d, r: RobotState, wantHeight: number, rampReady: boolean): void {
  const z = r.z ?? 0;
  const heightIn = wantHeight;
  const centreZ = z + heightIn / 2;
  const vz = r.vz ?? 0;

  let body = engine.robots.get(r.id);
  let placed = !body;
  if (!body) {
    body = engine.world3d.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(r.pos.x, r.pos.y, centreZ)
        .setRotation(yawQuat(r.heading))
        .setLinvel(r.vel.x, r.vel.y, vz)
        .setAngvel({ x: 0, y: 0, z: r.angVel })
        .enabledRotations(false, false, true),
    );
    /**
     * THE COLLIDER IS THE 2D SOLVE'S FOOTPRINT, NOT THE BARE CHASSIS BOX -- parity bug found by
     * measurement (this lane's final report). `solveRobots` (`src/sim/physicsEngine.ts`) builds
     * its robot-vs-wall/robot-vs-robot collider from `robotExtents` (`front`/`rear`/`half`),
     * which GROWS the box by the intake reach on whichever edge(s) it is mounted (a `frontback`
     * sweeper on both fore-and-aft ends) -- the same shared helper DECODE uses. A body built
     * from `spec.length`/`spec.width` alone is SMALLER on that edge, so a robot staged flush
     * against a wall (a BIOBUZZ start position sits exactly where `robotExtents`' footprint
     * touches it) reads NO wall contact in 3D where 2D has one: measured on the default spec
     * (frontback mount, reach 3) at a wall-flush spawn, one second of `rotate: 1` gave 2D
     * 0.298 rad/s against 3D's 9.011 rad/s (ratio 30.2) -- not an inertia gap (mass 22.657 and
     * inertia 970.49 matched to the last digit in both engines, confirmed by probe) but a
     * MISSING contact: 2D's footprint rear corner sits exactly on the wall's inner face while
     * the undersized 3D box sat 3in clear of it, so the wall's friction never resisted the spin
     * the way it does in 2D. The forward drive-feel case is the same root cause seen from the
     * other side: the same wall-flush spawn has 2D's footprint DRAGGING off the wall for the
     * first few ticks of a forward command, and the undersized 3D box has nothing to drag
     * against, reaching 95% of top speed sooner (2D 1.10s vs 3D 0.95s before this fix).
     *
     * `forward` OFFSETS the box exactly as `physicsEngine.ts` does (`setTranslation(forward, 0)`
     * on the collider) so an asymmetric mount (front-only or back-only reach) grows the correct
     * end -- `hx`/`half` collapse to `spec.length/2`/`spec.width/2` for a mount with no reach,
     * so this is a strict generalization, not a behavior change, for a robot that has none.
     */
    addChassisCollider(RAPIER, engine, body, r, heightIn, rampReady);
    engine.robots.set(r.id, body);
    engine.robotHeights.set(r.id, heightIn);
    engine.robotRampReady.set(r.id, rampReady);
  } else {
    const heightChanged = Math.abs((engine.robotHeights.get(r.id) ?? heightIn) - heightIn) > 1e-9;
    const rampChanged = (engine.robotRampReady.get(r.id) ?? false) !== rampReady;
    if (heightChanged || rampChanged) {
      /**
       * THE REBUILD EDGE — height OR ramp-ready changing. Height's is the DEPLOY EDGE (plan
       * §3.3): the robot has just stood up (or, on a rewind, sat back down), so the chassis
       * collider is REBUILT at the new height and the body re-seated so its BOTTOM stays where
       * `RobotState.z` says it is. A collider cannot be resized in place, and scaling the body
       * would scale the intake-reach footprint with it. It happens ONCE per robot per match, at
       * the `pre` boundary, and only for a build over R102's cube — every 18-in-and-under robot
       * takes the `!body` path above and never comes back here for height.
       *
       * `rampReady`'s edge is the RAMP'S OWN SETTLE — `BB_RAMP_DEPLOY_S` after a toggle turns it
       * true, and it turns false again the instant the ramp folds (no settle delay coming IN) —
       * so this can fire any number of times over a match, in either direction, for a `ramp`
       * build. Side rollers never trigger it: `rampReady` is irrelevant to them and
       * `chassis3dReachShapes` reads only the archetype and the height.
       *
       * A ramp-only change does NOT re-seat the translation (unlike height) — the body's bottom
       * has not moved — AND DOES NOT TOUCH THE CHASSIS BOXES: only the reach hardware is swapped
       * (`swapChassis3dReachColliders`'s header has the measurement — a full clear drops the
       * floor contacts and the robot sinks 0.28 in every time the ramp comes down).
       */
      if (heightChanged) {
        clearChassis3dColliders(engine.world3d, body);
        addChassisCollider(RAPIER, engine, body, r, heightIn, rampReady);
      } else {
        swapChassis3dReachColliders(RAPIER, engine.world3d, body, chassis3dBaseColliderCount(r.spec, heightIn), r.spec, heightIn, rampReady);
      }
      engine.robotHeights.set(r.id, heightIn);
      engine.robotRampReady.set(r.id, rampReady);
      if (heightChanged) {
        body.setTranslation({ x: r.pos.x, y: r.pos.y, z: centreZ }, true);
        placed = true;
      }
    }
  }

  // the SAME mass `updateRobot`'s wrench was computed against -- see `robot3d.ts`'s header for
  // why the two must agree exactly.
  const m = shoveMass(r.spec, r.butterflyTank, r.powerDraw);
  const inertia = chassisInertia(m, r.spec);
  body.setAdditionalMassProperties(m, { x: 0, y: 0, z: 0 }, { x: inertia, y: inertia, z: inertia }, QUAT_IDENTITY, true);

  const last = engine.lastRobot.get(r.id);
  const changed =
    !last ||
    Math.abs(last.x - r.pos.x) > POSE_EPS ||
    Math.abs(last.y - r.pos.y) > POSE_EPS ||
    Math.abs(last.z - z) > POSE_EPS ||
    Math.abs(last.heading - r.heading) > POSE_EPS ||
    Math.abs(last.vx - r.vel.x) > POSE_EPS ||
    Math.abs(last.vy - r.vel.y) > POSE_EPS ||
    Math.abs(last.vz - vz) > POSE_EPS ||
    Math.abs(last.angVel - r.angVel) > POSE_EPS;
  if (changed) {
    body.setTranslation({ x: r.pos.x, y: r.pos.y, z: centreZ }, true);
    body.setRotation(yawQuat(r.heading), true);
    body.setLinvel({ x: r.vel.x, y: r.vel.y, z: vz }, true);
    body.setAngvel({ x: 0, y: 0, z: r.angVel }, true);
  }
  // a POSITION the solver did not produce: new, moved by gameplay, or re-built at the deploy
  // edge. Not a heading edit: `squareUpRobotsWalls` turns every robot touching a wall a little
  // each tick, and re-testing those let the fit move a robot that another robot was pressing
  // into a static past 0.25 in (measured, 2v2 ram probe) — a solver state, not this case.
  if (
    placed ||
    !last ||
    Math.abs(last.x - r.pos.x) > POSE_EPS ||
    Math.abs(last.y - r.pos.y) > POSE_EPS ||
    Math.abs(last.z - z) > POSE_EPS
  ) {
    setChassisClear(engine, body, r, centreZ);
  }
  engine.lastRobot.set(r.id, {
    x: r.pos.x,
    y: r.pos.y,
    z,
    heading: r.heading,
    vx: r.vel.x,
    vy: r.vel.y,
    vz,
    angVel: r.angVel,
  });
}

/** sync every robot in `world.robots` -- exported so `step3d.ts` can call it without reaching
 * into this module's internals for a per-robot loop it would otherwise have to duplicate. */
export function syncRobots(world: World, engine: Engine3d): void {
  const RAPIER = rapier3d();
  for (const r of world.robots) syncRobot(RAPIER, engine, r, bbHeightNow(world, r.spec), bbRampSettled(r, world.time));
}

/** the robot a chassis-body TRANSLATION corresponds to, for `readback` and `robot3d.ts`'s yaw
 * readout -- kept here rather than duplicated, since it is one half of what `syncRobot` wrote. */
export function robotBodyOf(engine: Engine3d, id: number): InstanceType<Rapier3d['RigidBody']> | undefined {
  return engine.robots.get(id);
}

/**
 * Does this `BallState` want a DYNAMIC sphere body? Everything except `held` and `stock`.
 *
 * WARNING -- **A FLOWER-PARKED ELEMENT IS DYNAMIC SINCE DAY 2**, and that is the whole
 * flower-tube change seen from the engine's side. It used to be a FIXED body pinned at whatever
 * z the 2D `placeInFlower` computed from `flowerStackZ` -- the Day 1 shortcut, taken because the
 * tube had no geometry to fall through. It has geometry now (`flowerTube.ts`: three real plates
 * with their real bores), so a placed element is dropped at the top ring and SEATS WHERE THE
 * RINGS LET IT, and `derive.ts` reads the column back off the bodies exactly as it reads a hive
 * cell. Nothing in this file distinguishes a flower element from a hive-cell one any more.
 *
 * BIOBUZZ never produces `basin`/`rail` (DECODE/Chain Reaction only), so they fall through to
 * "no body" along with `held`/`stock` -- defensive, not expected.
 */
function wantsDynamicBody(state: BallState): boolean {
  if (state.kind === 'ground' || state.kind === 'flight') return true;
  if (state.kind === 'element') return true;
  return false;
}

function removeElementBody(engine: Engine3d, id: number): void {
  const body = engine.elements.get(id);
  if (!body) return;
  engine.world3d.removeRigidBody(body);
  engine.elements.delete(id);
  engine.lastElement.delete(id);
  engine.restTicks.delete(id);
  engine.narrowVibeTicks.delete(id);
}

/**
 * Reconcile one artifact's body to its current JSON. A body exists iff `state.kind` is
 * `'ground' | 'flight' | 'element'` (plan section 3.2 rule 2); `'held'`/`'stock'` have none, and
 * are removed here the tick they become that (a capture, a place into a FLOWER's stack, an entry
 * into a human player's hand -- none of those write a position that matters once the body is
 * gone).
 *
 * A KIND CROSSING (dynamic <-> fixed, i.e. entering or leaving a FLOWER's stack) rebuilds the
 * body outright, since a Rapier body's type is fixed at creation. Otherwise this is the same
 * create-once / diff-teleport-or-leave-alone rule `syncRobot` uses.
 */
/** the distance from a point to a `Chassis3dShape` box, both in the SAME robot frame; 0 inside. */
function boxGap(s: Chassis3dShape, lx: number, ly: number, lz: number): number {
  const dx = Math.max(Math.abs(lx - s.cx) - s.hx, 0);
  const dy = Math.max(Math.abs(ly - s.cy) - s.hy, 0);
  const dz = Math.max(Math.abs(lz - s.cz) - s.hz, 0);
  return hyp3(dx, dy, dz);
}

/** one robot's chassis compound, plus what it takes to put a world point into its frame. */
interface BirthSolid {
  px: number;
  py: number;
  /** the chassis MID-height in world z — `Chassis3dShape.cz` is measured from here */
  pz: number;
  heading: number;
  shapes: readonly Chassis3dShape[];
}

/** is this world-frame sphere centre clear of every chassis solid by at least `need`? */
function clearOfSolids(solids: readonly BirthSolid[], x: number, y: number, z: number, need: number): boolean {
  for (const s of solids) {
    const l = rot({ x: x - s.px, y: y - s.py }, -s.heading);
    const lz = z - s.pz;
    for (const box of s.shapes) if (boxGap(box, l.x, l.y, lz) < need) return false;
  }
  return true;
}

/**
 * ⚠️ **THE FIELD IS THE OTHER SOLID A BODY CAN BE BORN INSIDE, AND IT NEEDS THE OPPOSITE
 * STRATEGY TO A ROBOT'S.**
 *
 * `birthClear` escapes a chassis by marching FORWARD along the element's own arc, because the
 * element is LEAVING the robot that threw it and the far side of a 3-inch pocket is a few inches
 * along the parabola. Marching forward out of a WALL does the reverse: the perimeter cuboids are
 * `BB_WALL_T` (10 in) of solid with the play area on ONE side, so every step of the march drives
 * the element DEEPER, no clear point is found inside `BB3_LAUNCH_CLEAR_MAX`, and the element is
 * left exactly where it was — inside the wall, where Rapier's penetration recovery throws it out
 * along the contact normal at a speed the overlap depth chose. That is the owner's "launching
 * from a corner or against a wall sometimes shoots the ball in a completely different direction".
 *
 * So a static is escaped by the SHORTEST WAY OUT OF IT — straight back into the field along that
 * wall's own inward normal — with the solved VELOCITY untouched, which is what makes the next
 * step an ordinary wall bounce at the speed the shot was fired at rather than a teleport.
 *
 * ⚠️ **ANALYTIC, FROM THE SAME CONSTANTS `buildStatics3d` BUILDS THE WALLS FROM** (`BB_HALF_X`,
 * `BB_HALF_Y`, `BB3_WALL_H`), and NEVER a query of `engine.world3d`. `syncElement` runs mid-sync:
 * some bodies are already at this tick's JSON and some are still at last tick's, so a shape cast
 * would answer differently depending on where in the loop it was asked, and the nudge it produced
 * would differ between two peers reconciling the same state. The nudge has to be a pure function
 * of the world JSON — see this function's caller.
 *
 * ⚠️ **THE WALLS AND THE TILES ONLY, AND THAT IS A MEASUREMENT, NOT AN OVERSIGHT.** The rest of
 * the field's statics are CAD CONVEX HULLS (`cadStatics`, the hive frames and the flower
 * supports) and trimeshes (the flower ring plates). There is no analytic sphere-vs-hull escape to
 * be had from a point cloud, and the obvious stand-in — each hull's AABB — is worse than nothing
 * here: the A-frame leg's AABB is a 12 × 19 × 41-in box that is almost entirely the air a robot
 * legally drives through (`bodies.ts` records the same trap from the other side, when the
 * exporter really did emit AABBs), so escaping it would teleport an element several inches for no
 * reason. MEASURED instead, on the poses a match can actually reach: 576 real shots fired flush
 * against all four walls and in all four corners, at eight headings, with three turret mounts —
 * ZERO birth points inside any static, worst velocity turn 8.5° in the five ticks after the shot,
 * which is gravity. 17,000+ aim-gated poses per mount swept analytically over the whole field,
 * with the poses the robot's own collider could not occupy excluded — also zero. Every hit found
 * before that filter was a pose with the ROBOT ITSELF standing inside the flower or the hive
 * frame. So this guard is the cheap, exact half; a hull escape would be an expensive, inexact
 * half for a case nothing reaches.
 */
function fieldClamp(x: number, y: number, z: number, radius: number, need: number): { x: number; y: number; z: number } {
  let cx = x;
  let cy = y;
  let cz = z;
  // the perimeter, but only while the element is below the top of it: a scoring arc apexes at
  // 60+ in and passes clean over a 40-in wall, and clamping THAT would be a teleport of its own.
  if (cz - need < BB3_WALL_H) {
    if (cx > BB_HALF_X - need) cx = BB_HALF_X - need;
    else if (cx < -BB_HALF_X + need) cx = -BB_HALF_X + need;
    if (cy > BB_HALF_Y - need) cy = BB_HALF_Y - need;
    else if (cy < -BB_HALF_Y + need) cy = -BB_HALF_Y + need;
  }
  // the TILES. `radius`, not `need`: an element resting on the floor is legal and must not be
  // lifted by the slop — only a centre below the tile plane's own surface is inside the slab.
  if (cz < radius) cz = radius;
  return { x: cx, y: cy, z: cz };
}

/**
 * ⚠️ **A FLIGHT BODY IS BORN CLEAR OF THE ROBOT THAT THREW IT.** 3D only, by construction: this
 * runs at the moment `syncElement` CREATES a body, and 2D never creates one.
 *
 * A launch point is a point on the MECHANISM, and a mechanism lives inside the robot. On the
 * default 15x17 frame with the default `frontback` mount, `launchLine` releases a dump at
 * `mountOrigin('back')` x = −7.50, z = `BB_LAUNCH_Z0` = 10 — straddling BOTH the frame box
 * (x[−7.50,7.50], z[0,18]) and the back mouth LINTEL (x[−10.50,−7.50], z[3.60,18.00]), which is
 * a closed 3-inch pocket. 2D does not care: a flight element there collides with nothing. In 3D
 * every one of those elements is a real sphere inside a real compound, and the measurement was
 * total — all four rose ~2 in, jammed, and rode the chassis at z≈12 without ever entering
 * flight. **0/28 on the 28-pose tutorial grid; a dumper could not score at all, and 3D is every
 * server-connected match.**
 *
 * The fix belongs HERE and not in the shared release. A shared `launchClearance()` in `robot.ts`
 * was tried and reverted: it took 3D to 3/28 and regressed 2D to 24/28, because it moves the
 * release point every 2D check measures from. The sync rule — a body is teleported only when its
 * JSON differs from what the last readback wrote — is what makes a one-time nudge at CREATION
 * stick instead of being undone on the next tick.
 *
 * ⚠️ **THE MARCH IS ALONG THE ELEMENT'S OWN BALLISTIC ARC, AND THE VELOCITY IS ADVANCED WITH
 * IT** — the body is born a few milliseconds further down the parabola it was solved onto, not
 * translated off it. That distinction is the whole difference between a fix and a different
 * miss, and the measurement says so: a dumper's lob leaves at 80.6° (vh 33.6, vz 203.1 in/s),
 * so the only cheap way out of the pocket is UP, and a straight-ray nudge of 8.9 in raises the
 * RELEASE 8.9 in while leaving the solved `vz` alone. The arc then apexes at 68.5 instead of
 * 63.4, clears the top of the opening band (65.5) and hits the structure above it: 3/28 on the
 * grid, a fix that scored barely better than the bug. Advancing `vz` by `g·t` over the same path
 * puts the apex back at 63.4 and the element back through the opening, descending and inboard,
 * because it is quite literally the same throw — just started `t` later.
 *
 * ⚠️ **AND THE FIELD IS ESCAPED THE OTHER WAY — SEE `fieldClamp`.** A robot is something the
 * element is leaving, so the way out is forward along the arc; a WALL is 10 in of solid with the
 * play area on one side, so the way out is the shortest push back inside, with the velocity left
 * alone. Two solids, two strategies, and forcing either rule to do both makes the other case
 * worse.
 *
 * The JSON is written back so the 2D map, the 3D scene and the body all agree about where the
 * element is. A body that finds no clear point inside `BB3_LAUNCH_CLEAR_MAX` of path is left
 * exactly where the release put it (clamped inside the field).
 *
 * It runs on EVERY flight body this engine creates, not only on a fresh launch, so an engine
 * REBUILD (`engineFor`: a tick going backwards, a robot joining or leaving) that happens to
 * re-create a mid-air element while it is against a chassis nudges that one too. That is wanted
 * rather than tolerated: creating a body inside a solid is the failure being prevented, whatever
 * put it there, and the nudge is a pure function of the world JSON, so every peer that rebuilds
 * from the same state makes the same one.
 */
function birthClear(engine: Engine3d, world: World, b: Artifact, radius: number): void {
  const sp = hyp3(b.vel.x, b.vel.y, b.vz);
  if (!(sp > 1e-9)) return;
  const need = radius + BB3_LAUNCH_CLEAR_SLOP;
  const z0 = b.z + radius;

  /**
   * ── 1. THE FIELD, FIRST AND BY A DIFFERENT RULE ──────────────────────────
   * A release inside a WALL is pushed straight back inside along that wall's own normal, which
   * is the shortest way out of a solid the play area is on one side of. The velocity is left
   * exactly as solved, so the very next step is the wall bounce the shot earned. In the open
   * field this is the identity and everything below is byte-for-byte what it was.
   */
  const p = fieldClamp(b.pos.x, b.pos.y, z0, radius, need);
  const clamped = p.x !== b.pos.x || p.y !== b.pos.y || p.z !== z0;

  const solids: BirthSolid[] = [];
  for (const rob of world.robots) {
    const h = builtHeight(engine, rob);
    // ⚠️ THE ARCHETYPE REACH HARDWARE TOO, NOT JUST THE BARE FRAME (owner ruling 2026-09-20: a
    // side roller's wheel and a settled ramp's crossbar/rails are both solid to an ELEMENT now
    // — `chassis3dReachShapes`/`elementSolid`, `bodies.ts` — so a launch point born inside one is
    // exactly the "shoots the ball in a completely different direction" bug this function exists
    // to prevent, just against a solid `chassis3dShapes` alone never counted. `boxGap` treats a
    // CYLINDER's own `hx`/`hy` as a square box and ignores `rot` on the ramp's tilted rails —
    // both are a conservative OVER-approximation (never smaller than the real solid), so this
    // can only make the escape search look a hair further than strictly necessary, never miss a
    // real overlap.
    solids.push({
      px: rob.pos.x,
      py: rob.pos.y,
      pz: (rob.z ?? 0) + h / 2,
      heading: rob.heading,
      shapes: [...chassis3dShapes(rob.spec, h), ...chassis3dReachShapes(rob.spec, h, bbRampSettled(rob, world.time))],
    });
  }
  const writeBack = (): void => {
    if (!clamped) return;
    b.pos = { x: p.x, y: p.y };
    b.z = p.z - radius;
  };
  if (solids.length === 0 || clearOfSolids(solids, p.x, p.y, p.z, need)) {
    writeBack();
    return;
  }

  /**
   * ── 2. THE ROBOT, BY THE ARC MARCH ───────────────────────────────────────
   * the march is in TIME, one `BB3_LAUNCH_CLEAR_STEP` of path per sample at the release speed —
   * which is the same thing as stepping along the velocity over these distances (the parabola
   * drops 0.37 in over the 9 in a default dumper needs) while staying exactly on the arc.
   *
   * ⚠️ **AND IT STOPS AT THE FIELD.** A sample the field clamp would move is a sample inside a
   * wall, and every further one is deeper in: marching on would swap a body inside the chassis
   * for a body inside the wall, which is the worse of the two by the size of the ejection. The
   * fallback is the clamped release — inside the thrower, on the wall face, where the chassis
   * contact resolves it at chassis speed instead of at penetration-recovery speed.
   */
  const dt = BB3_LAUNCH_CLEAR_STEP / sp;
  const tMax = BB3_LAUNCH_CLEAR_MAX / sp;
  for (let t = dt; t <= tMax; t += dt) {
    const x = p.x + b.vel.x * t;
    const y = p.y + b.vel.y * t;
    const z = p.z + b.vz * t - 0.5 * GRAVITY * t * t;
    const q = fieldClamp(x, y, z, radius, need);
    if (q.x !== x || q.y !== y || q.z !== z) break; // the arc has left the field — stop marching
    if (clearOfSolids(solids, x, y, z, need)) {
      b.pos = { x, y };
      b.z = z - radius;
      b.vz = b.vz - GRAVITY * t;
      return;
    }
  }
  writeBack();
}

function syncElement(RAPIER: Rapier3d, engine: Engine3d, world: World, b: Artifact): void {
  let existing = engine.elements.get(b.id);

  if (!wantsDynamicBody(b.state)) {
    removeElementBody(engine, b.id);
    return;
  }

  const last = engine.lastElement.get(b.id);
  const r = b.r ?? BB_POLLEN_R;
  const isNectar = b.color === 'red' || b.color === 'blue';

  /**
   * ⚠️ **AN ELEMENT CAN REACH `flight` WITHOUT LOSING ITS OLD BODY, AND THEN THE BIRTH CLEARANCE
   * BELOW NEVER RUNS.** Owner report 2026-09-19: "similar incorrect launches happen with the
   * intake collision too — like when I'm intaking as I'm shooting". The whole chain is one tick:
   *
   *   · stage 11 runs GAMEPLAY in the order capture → aim+launch (`step3dImpl.ts`);
   *   · `capturePollen` flips a ground element to `held` and pushes its colour on the hopper. It
   *     does NOT touch the body — removal is this function's job, and this function does not run
   *     again until the NEXT tick's stage 5. The element keeps its ground body for the rest of
   *     the tick;
   *   · still stage 11, `bbLaunch` → `releasePollen` → `takeHeld` picks the held element of that
   *     colour at the HIGHEST `world.balls` index, which with an empty hopper is the one just
   *     picked up, and writes it into `flight` at the MUZZLE;
   *   · next tick, `!existing` is FALSE, so the body is simply `setTranslation`ed to the muzzle —
   *     a point on the mechanism, inside the chassis compound — and Rapier's penetration recovery
   *     throws it out along whatever normal it finds.
   *
   * MEASURED before this guard, on a robot parked in range of its own CELL with an empty hopper,
   * intake and fire both held (the ordinary "feed and shoot" loop): every shot was a same-tick
   * capture-and-launch, the release sat **7.3 in inside the chassis**, and a DUMPER's lob — the
   * deepest pocket on any build, and the one `birthClear` was written for — came out **63° to
   * 101° off the velocity it was fired at within five ticks**, apexing at 10–12 in instead of
   * 61–65 in. That is the 0/28 tutorial-grid failure, back, for exactly the elements a driver
   * picks up and fires in one motion. A turret's release is shallower and faster, and its shots
   * turned 2.4–3.6°, so the same bug is a graze there and a total loss for a dumper.
   *
   * THE GUARD IS THE LAUNCH, NOT THE KIND CHANGE. "Kind changed to `flight`" would fire on every
   * bouncing ground element, because `derive.ts` re-tags one `flight` the moment it leaves the
   * tiles — and a ball in flight near a robot must COLLIDE with it, not be teleported clear of
   * it. `by` is the discriminator: `releasePollen` is the only writer that stamps it, `derive.ts`
   * never does. Paired with "the JSON has been TELEPORTED since the last readback", it is exactly
   * "this body is about to be moved somewhere it was not flying to", which is the one case the
   * birth clearance is for. A free-flying element's JSON is written by `readback` and matches it,
   * so it never qualifies; an intake PULL edits velocity and not position, so it never qualifies
   * either.
   *
   * Destroying the body and taking the creation path (rather than nudging in place) is what buys
   * the fresh CCD decision and the initial `linvel` for free, and keeps ONE birth path.
   */
  const launched = b.state.kind === 'flight' && b.state.by !== undefined;
  const teleported =
    last !== undefined &&
    (Math.abs(last.x - b.pos.x) > POSE_EPS || Math.abs(last.y - b.pos.y) > POSE_EPS || Math.abs(last.z - b.z) > POSE_EPS);
  if (existing && launched && teleported) {
    removeElementBody(engine, b.id);
    existing = undefined;
  }

  if (!existing && b.state.kind === 'flight') birthClear(engine, world, b, r);
  const centreZ = b.z + r;

  if (!existing) {
    const body = engine.world3d.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(b.pos.x, b.pos.y, centreZ)
        .setLinvel(b.vel.x, b.vel.y, b.vz)
        .setAngularDamping(ELEMENT_ROLL_DAMP)
        .setCcdEnabled(hyp3(b.vel.x, b.vel.y, b.vz) > BB3_CCD_SPEED),
    );
    // MAX COMBINE, NOT THE DEFAULT AVERAGE: the floor is deliberately 0-friction for
    // robots (see bodies.ts's floor comment), and an element resting on it must not inherit
    // that -- MAX(elementFriction, otherSurface) keeps this element's own 0.6 against a
    // 0-friction floor while still reading the higher of the two against anything (a wall, a
    // hive wall, another element) whose own friction happens to exceed it.
    // ...and the ELEMENT GROUP, which is what lets the intake POCKET FILLER filter elements out
    // while meeting everything else (`GROUP_ELEMENT` / `GROUP_POCKET`, `bodies.ts`). Memberships
    // are narrowed to the one bit; the filter stays open, so an element still meets the floor,
    // the walls, the statics, the tray, the frame, every other chassis box and every other
    // element, exactly as it did on the default groups.
    engine.world3d.createCollider(
      RAPIER.ColliderDesc.ball(r)
        .setMass(elementMass(isNectar))
        .setFriction(ELEMENT_FRICTION)
        .setRestitution(ELEMENT_RESTITUTION)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max)
        // a NECTAR also carries the bit the FLOWER's middle-ring lip meets (`groups.ts`)
        .setCollisionGroups(isNectar ? GROUP_NECTAR : GROUP_ELEMENT),
      body,
    );
    engine.elements.set(b.id, body);
    engine.lastElement.set(b.id, { x: b.pos.x, y: b.pos.y, z: b.z, vx: b.vel.x, vy: b.vel.y, vz: b.vz });
    return;
  }

  const changed =
    !last ||
    Math.abs(last.x - b.pos.x) > POSE_EPS ||
    Math.abs(last.y - b.pos.y) > POSE_EPS ||
    Math.abs(last.z - b.z) > POSE_EPS ||
    Math.abs(last.vx - b.vel.x) > POSE_EPS ||
    Math.abs(last.vy - b.vel.y) > POSE_EPS ||
    Math.abs(last.vz - b.vz) > POSE_EPS;
  if (changed) {
    // ⚠️ A REST SNAP IS NOT A TELEPORT, AND TREATING IT AS ONE KEPT EVERY SEATED ELEMENT AWAKE
    // FOR THE WHOLE MATCH. `derive.ts` holds a settled element's JSON velocity at exactly zero;
    // the solver hands the body a residual of a few 1e-4 every step; so this diff fired EVERY
    // tick for every element at rest in a FLOWER or a CELL, and its `wakeUp: true` reset the
    // sleep timer each time. Measured in an idle 3D world at tick 900: 16 of 16 FLOWER elements
    // and 6 of 6 CELL elements awake at `vmax` 0, against 0 of 16 on the tiles. It was nearly
    // free while a column stood dead on the bore axis and stopped being free the day columns
    // SCATTERED (2026-09-19) — every leaning element is a standing wall contact the solver
    // re-solves each tick: idle step 0.168 → 0.302 ms, the 2v2 room tick from 0.77x a Chain
    // Reaction room's to 1.5x, over its 1.2x budget. So the case is told apart: the position is
    // where the body already is and the velocity asked for is zero ⇒ zero it WITHOUT waking, and
    // the body sleeps like any other resting one. Anything else is a real edit and still wakes.
    const restSnap =
      !!last &&
      b.vel.x === 0 &&
      b.vel.y === 0 &&
      b.vz === 0 &&
      Math.abs(last.x - b.pos.x) <= POSE_EPS &&
      Math.abs(last.y - b.pos.y) <= POSE_EPS &&
      Math.abs(last.z - b.z) <= POSE_EPS;
    if (restSnap) {
      existing.setLinvel({ x: 0, y: 0, z: 0 }, false);
    } else {
      existing.setTranslation({ x: b.pos.x, y: b.pos.y, z: centreZ }, true);
      existing.setLinvel({ x: b.vel.x, y: b.vel.y, z: b.vz }, true);
    }
  }
  // ONLY TOUCH CCD WHEN IT ACTUALLY CHANGES. `enableCcd` is a write even when the value is
  // unchanged, and (measured) calling any RigidBody setter every tick on a body that would
  // otherwise have gone to sleep keeps resetting its sleep timer -- a resting element then
  // never sleeps and drifts a hair every tick under residual solver noise, which is exactly
  // the "a resting element stays at rest" invariant this port has to hold.
  const wantCcd = hyp3(b.vel.x, b.vel.y, b.vz) > BB3_CCD_SPEED;
  if (existing.isCcdEnabled() !== wantCcd) existing.enableCcd(wantCcd);
  engine.lastElement.set(b.id, { x: b.pos.x, y: b.pos.y, z: b.z, vx: b.vel.x, vy: b.vel.y, vz: b.vz });
}

/** sync every artifact in `world.balls`. */
export function syncElements(world: World, engine: Engine3d): void {
  const RAPIER = rapier3d();
  for (const b of world.balls) syncElement(RAPIER, engine, world, b);
}

import { BB_HALF_X, BB_HALF_Y } from '../config';
import { hiveDetentHold, hiveTiltAngle } from './hive3d';
import { tiltQuatX } from './math3';
import { GROUP_NECTAR } from './groups';

/**
 * Drive both hive trays' KINEMATIC rotation from `hiveTiltAngle` -- the Day 1 fallback
 * (`BB3_HIVE_DYNAMIC = false`). Called every tick, unconditionally, before `world3d.step()`:
 * a position-based kinematic body only moves when told where to go NEXT, so this is not a
 * diffed sync like `syncRobot`/`syncElement`, it is the tray's whole reason for moving at all.
 *
 * SUBTRACTS `hiveTrayRefTheta(a)` FROM THE ABSOLUTE TILT -- 0 on the Day 1 fallback (a no-op),
 * the CAD's own capture angle when `BB3_FIELD_COLLIDERS` is on: `bodies.ts`'s tray colliders are
 * built at IDENTITY rotation with their RAW (as-captured) `(v, w)` as translation, so the BODY's
 * own rotation is the ONLY place either the CAD's capture-tilt correction or the live swing
 * happens. An earlier version left colliders at identity here and instead gave EACH one its own
 * extra local rotation (undone on top by this same body rotation) -- that composition checked
 * out by hand and against every geometry check, but measurably destabilized a KINEMATIC body:
 * an element resting inches clear of every collider (confirmed by a direct point-containment
 * query) got a several-hundred-in/s velocity on the very first tick, and it went away completely
 * once no collider carried its own non-identity local rotation. See `buildHiveTray3d`'s own
 * comment for how the collider side of this was simplified to match.
 */
export function applyHiveTilt(world: World, engine: Engine3d): void {
  if (useHiveDynamic()) {
    hiveDetentHold(world, engine);
    return;
  }
  for (const a of ['red', 'blue'] as const) {
    const theta = hiveTiltAngle(world, a) - hiveTrayRefTheta(a);
    engine.hiveTrays[a].setNextKinematicRotation(tiltQuatX(theta));
  }
}

/** the tray body's live tilt (rad) -- a pure x-axis rotation, since the revolute joint removes
 * every other freedom, so the same one-term read `yawOfQuat` does for a chassis about z. */
export function trayTilt(body: InstanceType<Rapier3d['RigidBody']>): number {
  const q = body.rotation();
  return 2 * datan2(q.x, q.w);
}

/** advance the persistent world one tick. A thin wrapper so `step3d.ts` never touches
 * `engine.world3d` directly -- the persistence itself (never rebuilding a fresh `RAPIER.World`
 * per tick, unlike the 2D `solveRobots`/`solveArtifacts`) is this module's whole contract. */
export function stepWorld3d(engine: Engine3d): void {
  engine.world3d.step();
}

/**
 * READBACK (plan section 3.1 step 6): every dynamic body writes `pos`/`z`/`vel`/`vz` back into
 * `world`, and a robot's `heading`/`angVel` too, all rounded to `round4` so the JSON is the
 * truth and two ticks that are physically identical serialise identically. EVERY element that
 * has a body is read back,
 * including one sitting in a FLOWER -- since Day 2 that is a dynamic sphere in a real tube, not
 * a fixed body parked at a modelled height.
 *
 * Also refreshes `engine.last*` to the JSON just written, so next tick's sync sees NO diff
 * unless gameplay (capture/launch/place/derive) changes something in between -- exactly the
 * "leave a resting body alone" contract `syncRobot`/`syncElement` need to hold.
 */
export function readback(world: World, engine: Engine3d): void {
  for (const r of world.robots) {
    const body = engine.robots.get(r.id);
    if (!body) continue;
    const t = body.translation();
    const v = body.linvel();
    const av = body.angvel();
    const z = round4(t.z - builtHeight(engine, r) / 2);
    const heading = round4(yawOfQuat(body.rotation()));
    r.pos.x = round4(t.x);
    r.pos.y = round4(t.y);
    r.z = z;
    r.heading = heading;
    r.vel.x = round4(v.x);
    r.vel.y = round4(v.y);
    r.vz = round4(v.z);
    r.angVel = round4(av.z);
    engine.lastRobot.set(r.id, {
      x: r.pos.x,
      y: r.pos.y,
      z,
      heading,
      vx: r.vel.x,
      vy: r.vel.y,
      vz: r.vz,
      angVel: r.angVel,
    });
  }
  /**
   * THE TRAY'S OWN READBACK (Day 2). Under the DYNAMIC see-saw the tray is a solved body like any
   * other, so its pose is JSON: `hives[a].angle` and `angVel`, rounded to 1e-4 like everything
   * else. `hiveTiltAngle` reads that field back and is therefore reading the joint.
   *
   * Absent on the kinematic path -- deliberately, and it is what makes `hiveTiltAngle`'s fallback
   * exact rather than approximate: a kinematic tray's angle is EXACTLY what the timer says, so
   * serialising a rounded copy of it would only introduce a discrepancy with the 2D renderer,
   * which computes the same formula from `tipping`.
   */
  if (useHiveDynamic() && world.biobuzz) {
    for (const a of ['red', 'blue'] as const) {
      const body = engine.hiveTrays[a];
      world.biobuzz.hives[a].angle = round4(trayTilt(body));
      world.biobuzz.hives[a].angVel = round4(body.angvel().x);
    }
  }
  for (const b of world.balls) {
    const body = engine.elements.get(b.id);
    if (!body) continue;
    const t = body.translation();
    const v = body.linvel();
    const r = b.r ?? BB_POLLEN_R;
    const z = round4(t.z - r);
    const x = round4(t.x);
    const y = round4(t.y);
    // ⚠️ STILL RELAXING ⇒ NOT ALLOWED TO SLEEP. Rapier sleeps a body that has been under ~4 in/s
    // (0.4 × `lengthUnit`) for two seconds, and a settling FLOWER column pushes its overlaps
    // apart far slower than that for far longer — so once seated elements COULD sleep (the REST
    // SNAP note in `syncElement`) a scattered column froze mid-separation: worst pollen-pollen
    // interpenetration 0.161 → 0.687 in. The test is whether the ROUNDED position moved this
    // tick at all: a column still relaxing keeps resetting its own timer, and one that has
    // stopped to 1e-4 in sleeps two seconds later. A sleeping body does not move, so this can
    // never wake one.
    if (Math.abs(x - b.pos.x) > RELAX_EPS || Math.abs(y - b.pos.y) > RELAX_EPS || Math.abs(z - b.z) > RELAX_EPS) body.wakeUp();
    b.pos.x = x;
    b.pos.y = y;
    b.z = z;
    b.vel.x = round4(v.x);
    b.vel.y = round4(v.y);
    b.vz = round4(v.z);
    engine.lastElement.set(b.id, { x: b.pos.x, y: b.pos.y, z, vx: b.vel.x, vy: b.vel.y, vz: b.vz });
  }
}

/**
 * THE CONTAINMENT SAFETY NET (plan section 3.1 step 9) -- a NaN, an element or robot outside
 * the perimeter, or an element centre below the tiles is placed back at the nearest interior
 * floor point, AT REST, on BOTH the body and the JSON, and `engine.containmentFixes` counts it.
 * A smoke check expects this to STAY zero over ordinary play; it exists for the tick the solver
 * genuinely has no better answer, never as the design (see `sim/physics.ts`'s 2D perimeter
 * invariant for the same idea one dimension down).
 */
export function containmentPass(world: World, engine: Engine3d): void {
  const limX = BB_HALF_X - 0.5;
  const limY = BB_HALF_Y - 0.5;
  const clampXY = (x: number, y: number): { x: number; y: number } => ({
    x: Number.isFinite(x) ? Math.max(-limX, Math.min(limX, x)) : 0,
    y: Number.isFinite(y) ? Math.max(-limY, Math.min(limY, y)) : 0,
  });

  for (const r of world.robots) {
    const bad =
      !Number.isFinite(r.pos.x) ||
      !Number.isFinite(r.pos.y) ||
      Math.abs(r.pos.x) > BB_HALF_X ||
      Math.abs(r.pos.y) > BB_HALF_Y;
    if (!bad) continue;
    const p = clampXY(r.pos.x, r.pos.y);
    r.pos.x = p.x;
    r.pos.y = p.y;
    r.vel.x = 0;
    r.vel.y = 0;
    const body = engine.robots.get(r.id);
    if (body) {
      body.setTranslation({ x: p.x, y: p.y, z: (r.z ?? 0) + builtHeight(engine, r) / 2 }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }
    engine.containmentFixes++;
  }

  for (const b of world.balls) {
    if (!wantsDynamicBody(b.state)) continue;
    const bad =
      !Number.isFinite(b.pos.x) ||
      !Number.isFinite(b.pos.y) ||
      !Number.isFinite(b.z) ||
      Math.abs(b.pos.x) > BB_HALF_X ||
      Math.abs(b.pos.y) > BB_HALF_Y ||
      b.z < -0.5;
    if (!bad) continue;
    const p = clampXY(b.pos.x, b.pos.y);
    b.pos.x = p.x;
    b.pos.y = p.y;
    b.z = 0;
    b.vel.x = 0;
    b.vel.y = 0;
    b.vz = 0;
    const r = b.r ?? BB_POLLEN_R;
    const body = engine.elements.get(b.id);
    if (body) {
      body.setTranslation({ x: p.x, y: p.y, z: r }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }
    engine.containmentFixes++;
  }
}

/**
 * ⚠️ **ROLLING RESISTANCE IS COULOMB, NOT EXPONENTIAL — AND WITHOUT IT A 3D ELEMENT NEVER
 * STOPS.** Rapier bleeds a rolling sphere's speed with `setAngularDamping`, which is a
 * PROPORTIONAL law: the speed halves, and halves again, and is never zero. The 2D pipeline
 * stops a POLLEN with the shared `stepGroundBall` — a CONSTANT deceleration
 * (`BALL_ROLL_FRICTION`) plus a hard snap under `BALL_REST_SPEED` — which is what a ball on
 * carpet actually does and what gives it a finite roll-out.
 *
 * The cost of the difference was not physical realism, it was the MATCH CLOCK: an element
 * coasting at a speed no player can see held the settle predicate open for seconds after the
 * buzzer (measured by the settle lane before this pass: 6.60 / 7.02 / 8.13 s to finalize on
 * seeds 7 / 21 / 99, against 2D's 0.52 s, every one of them held by a ground element still
 * reading as "moving").
 *
 * WHAT IT DOES, in three cases, and the third is the one that is easy to get wrong:
 *  1. **ON THE TILES** — the shared constant deceleration and the shared rest snap, applied to
 *     the BODY (linear AND angular: a sphere whose spin survived the snap simply rolls off
 *     again on the next tick's contact).
 *  2. **AT REST ON SOMETHING ELSE** — a hive frame bar, a tray floor, a FLOWER's ring plate, a
 *     pile of other elements. No rolling law (it may be on a slope and entitled to slide), but
 *     once it has read at rest for `BB3_REST_TICKS` it is snapped the same way, which is what
 *     stops the damping creep that the JSON-side snap in `derive.ts` could never reach: that one
 *     is gated on the element's TAG, and an element on structure is tagged `flight`.
 *  3. **IN THE AIR** — nothing, ever. An element at the apex of a lob is momentarily slower than
 *     any rest threshold there is, and snapping it would freeze it in mid-air. The
 *     discriminator is CONTACT, asked of the narrow phase, not height or speed.
 */
/** magnitude range (in/s) of the "vibration" nudge below — the owner's own word for what a real
 * field's impacts and motor buzz would do to an element perched somewhere a silent rest snap
 * cannot let go of. Small enough it cannot be mistaken for a shot or a shove. */
const VIBE_MIN_SPEED = 2;
const VIBE_MAX_SPEED = 5;
/**
 * How long (ticks) `groundRoll3d` keeps shaking an element before it gives up and freezes it
 * like the old snap did. Without ANY cap, a genuine multi-hull cage (measured: an exact corner
 * where three hive-frame hulls meet) shakes FOREVER, which held `bbSettled` open past
 * `MATCH_SETTLE_MAX_S` and broke match-end detection — a real pocket has to lose eventually, the
 * same way a real field's vibration cannot un-jam something truly wedged either.
 *
 * MEASURED trade-off, not a free win: every ledge the rain probe found (`docs/area/biobuzz.md`)
 * still clears comfortably inside 30 (the panel/foot-bar/top-bar checks in
 * `scripts/smoke-biobuzz/hive3d.ts` resolve in 119–192 ticks TOTAL including the drop's own
 * fall), but a wider budget (90) that clears MORE of the rain probe's harder corners (59/1404
 * stuck against 30's 88/1404) also let the pre-existing "parked elements on the HIVE finalize on
 * the HOLD" settle check regress from 31 ticks to 398 — an element can chain through several
 * narrow perches on its way down, and each restarts its own budget. 30 is the largest value that
 * keeps that settle contract intact; a future pass that reads `bbSettled` for the give-up leaves
 * more room to raise it.
 */
const BB3_VIBE_GIVEUP_TICKS = 30;

/**
 * A tiny deterministic lateral kick, PURE in `(id, tick, rngState)` — same inputs, same output,
 * forever, which is what lets a reconnecting peer or a replay agree on it without either one
 * having tracked how long this exact element has been sitting here. `rngState` is READ, never
 * advanced: `nextRandom` is called on a SEED synthesized from it, and only `.value` is taken —
 * the world's own chain is never touched, so this cannot move a later spawn's or the AI's draw.
 * `Math.random` is banned in `src/games` (the source guard in `scripts/smoke.ts`) and would not
 * be reproducible besides; `dsin`/`dcos` turn the hashed angle into a unit vector for the same
 * reason every other angle in `sim3d/` does.
 */
function elementVibeSeed(id: number, tick: number, rngState: number): { x: number; y: number } {
  const seed = (Math.imul(id, 0x9e3779b1) ^ Math.imul(tick, 0x85ebca6b) ^ rngState) | 0;
  const a = nextRandom(seed);
  const b = nextRandom(a.state);
  const angle = a.value * 2 * Math.PI;
  const mag = VIBE_MIN_SPEED + b.value * (VIBE_MAX_SPEED - VIBE_MIN_SPEED);
  return { x: dcos(angle) * mag, y: dsin(angle) * mag };
}

export function groundRoll3d(world: World, engine: Engine3d, dt: number): void {
  const RAPIER = rapier3d();
  for (const b of world.balls) {
    if (!wantsDynamicBody(b.state)) continue;
    const body = engine.elements.get(b.id);
    if (!body) continue;
    const speed = Math.sqrt(b.vel.x * b.vel.x + b.vel.y * b.vel.y);
    const onFloor = b.z <= BB3_ROLL_FLOOR_Z;

    if (onFloor) {
      // the 2D law, verbatim: constant deceleration, then the hard snap.
      let ns = speed - BB3_ROLL_DECEL * dt;
      if (ns <= 0 || ns < BALL_REST_SPEED) ns = 0;
      const k = speed > 1e-9 ? ns / speed : 0;
      b.vel.x *= k;
      b.vel.y *= k;
      // ⚠️ **THE PLANAR SNAP MUST NOT STEAL A LIVE REBOUND.** This used to read
      // `if (ns === 0) b.vz = 0`, which killed the BOUNCE of anything landing with no planar
      // speed of its own: an element dropped straight down reaches the floor band
      // (`BB3_ROLL_FLOOR_Z`) with `speed` 0, so `ns` is 0, so the `vz` the solver had just
      // given it back was zeroed on the very tick it was earned. MEASURED, a pollen dropped
      // from 24 in: with planar drift it rebounds to 1.19 in (effective e 0.223, which is the
      // element's own 0.45 averaged with the tiles'); dropped vertically it rebounded to
      // nothing at all and crept down to rest instead. The rest snap is a ROLLING law — it is
      // about a ball that will not stop sliding — so it now only takes `vz` when `vz` is
      // itself at rest, and `BALL_REST_SPEED` (2 in/s) is the same threshold the planar half
      // uses. A settled element still snaps exactly as before: its `vz` is already ~0.
      if (ns === 0 && Math.abs(b.vz) < BALL_REST_SPEED) b.vz = 0;
      // WAKE ONLY WHAT IS MOVING. The bottom element of a FLOWER column sits in this floor band,
      // and the column above it hands it a residual of a few 1e-4 every step — so zeroing it with
      // `wakeUp: true` woke it, and through it the whole column's island, on every tick of the
      // match (see `syncElement`'s REST SNAP note for the cost). A lone element on open tile
      // never showed it: one floor contact leaves no residual, so the write was a no-op.
      const moving = ns > 0 || b.vz !== 0;
      body.setLinvel({ x: b.vel.x, y: b.vel.y, z: b.vz }, moving);
      // THE SPIN GOES WITH IT. Scaled by the same factor while it is rolling, zeroed with it at
      // rest — a stopped sphere still spinning re-accelerates itself through floor contact.
      const w = body.angvel();
      body.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, moving);
      continue;
    }

    // OFF THE FLOOR: only an element that is TOUCHING something and has read at rest for a
    // while, and only to stop the creep — never a rolling law, and never in mid-air.
    const still = speed < BB3_REST_SPEED && Math.abs(b.vz) < BB3_REST_SPEED;
    if (!still || (engine.restTicks.get(b.id) ?? 0) < BB3_REST_TICKS) continue;
    /**
     * ⚠️ **A CONTACT IS NOT ALWAYS SOMETHING WORTH FREEZING ON** (owner report 2026-09-20:
     * "balls are able to get stuck on top of the biobuzz panel with seemingly nothing actually
     * holding it up. They sometimes get stuck on top of other structures as well").
     *
     * The rain probe (`scratch/rain-probe.ts`, not committed; measurements in
     * `docs/area/biobuzz.md`'s BIOBUZZ 3D section) found the mechanism: every hive-frame or
     * flower-support CAD hull this loop can touch measures narrower than a POLLEN (2.8in) or has
     * no flat top at all — a single decimated vertex or ridge, from a round tube or angled beam
     * tessellated down to 8–16 points (`scratch/ledge-table.ts`'s survey). A real ball on a knife
     * edge like that would roll off from any disturbance, but this snap zeroed its velocity every
     * qualifying tick BEFORE gravity's tangential component could build enough speed to read as
     * moving again — an unstable equilibrium the snap made permanent by never letting it start
     * sliding. Measured: disabling the snap alone let SOME of them go (an asymmetric perch drifts
     * off on its own), but a numerically SYMMETRIC one (dead centre on a ridge, or wedged with
     * equal pressure between two hulls) has no residual to grow, so it sits forever, snap or not
     * — which is what the vibration below is for.
     *
     * ⚠️ **THE GATE IS THE ELEMENT'S OWN TAG, NOT THE COLLIDER IT IS TOUCHING.** A first pass
     * tried to tell "legitimate" apart from the contact alone (a `ConvexPolyhedron` on a FIXED
     * body is always one of the two CAD hull classes above) and it broke on the hive TRAY:
     * `cadTrayHulls` builds the tray's own facet slabs as `ConvexPolyhedron` too, on the DYNAMIC
     * tray body, and a ball wedged against the tray's OWN edge without being inside a cell reads
     * exactly like the panel bug (measured: a repro near the panel/leg cluster settled dead
     * against two tray facets and never moved). `derive.ts` has already answered "is this element
     * actually IN something" by the time this runs — it is tagged `state.kind === 'element'` the
     * tick it enters a cell or a tube, off GEOMETRY, never off contact — so a TAGGED element skips
     * this whole question and gets the plain zero, unconditionally, exactly as before; only an
     * untagged `ground` element (by construction, NOT inside any cell or tube, whatever it is
     * leaning on) asks what it is touching, and for one of those a `ConvexPolyhedron` — fixed
     * frame hull or dynamic tray facet alike — is never broad. The floor/walls (`Cuboid`), a
     * FLOWER's ring plate (`trimesh`), another element (`Ball`, the documented "garden-line" pile
     * this snap was originally written for) and a robot deck stay broad.
     */
    const freeze = (): void => {
      b.vel.x = 0;
      b.vel.y = 0;
      b.vz = 0;
      // `wakeUp: false` — a zeroing write has no reason to reset the sleep timer of a body that
      // is at rest; see `syncElement`'s REST SNAP note for what waking it every tick cost.
      body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    };
    if (b.state.kind === 'element') {
      engine.narrowVibeTicks.delete(b.id);
      freeze();
      continue;
    }
    let touchingBroad = false;
    let touchingNarrow = false;
    for (let i = 0; i < body.numColliders(); i++) {
      engine.world3d.contactPairsWith(body.collider(i), (other) => {
        // ⚠️ **A CYLINDER IS NARROW FOR THE SAME REASON A HULL IS** (2026-09-21, with the drawn
        // height profile). Every cylinder in this world is a ROUND part of a robot — a turret's
        // swept disc (`bbMechEnvelopes`; the head is a hood, not a flat roof, and the disc is the
        // envelope it sweeps) or a side roller's compliant wheel. A ball perched on the flat top
        // of either is resting on something that is not drawn there, which is exactly the class
        // of report the narrow-hull vibration exists for. A robot's DECK is a `Cuboid` and stays
        // BROAD: a flat deck really can carry a ball.
        // ...and a ROUNDED box is narrow too: the one kind built is a Box Tube tower
        // (`BbMechEnvelope.narrow`), whose 1.3-in top carried a balanced POLLEN indefinitely
        const st = other.shapeType();
        if (st === RAPIER.ShapeType.ConvexPolyhedron || st === RAPIER.ShapeType.Cylinder || st === RAPIER.ShapeType.RoundCuboid) {
          touchingNarrow = true;
        } else {
          touchingBroad = true;
        }
      });
    }
    if (!touchingBroad && !touchingNarrow) {
      engine.narrowVibeTicks.delete(b.id);
      continue;
    }
    if (touchingBroad) {
      engine.narrowVibeTicks.delete(b.id);
      freeze();
      continue;
    }
    // TOUCHING ONLY A NARROW HULL: no hold, and after it has sat there this long, a tiny
    // deterministic "vibration" — the owner's own word for what a real field would do that a
    // silent physics snap cannot — UNLESS it has been shaking with no result for
    // `BB3_VIBE_GIVEUP_TICKS`, in which case it freezes like anything else (see that constant's
    // header: a real cage has to lose eventually, or `bbSettled` never closes).
    const vibeTicks = (engine.narrowVibeTicks.get(b.id) ?? 0) + 1;
    engine.narrowVibeTicks.set(b.id, vibeTicks);
    if (vibeTicks > BB3_VIBE_GIVEUP_TICKS) {
      freeze();
      continue;
    }
    // The direction/magnitude come from a HASH of (id, tick, world.rngState) — READ ONLY, never
    // advanced, and never `Math.random`: this is authority state that has to be reproducible,
    // but it must not consume a draw the AI or a spawn is waiting on. `wakeUp: true` — unlike the
    // broad case, THIS write wants the body to actually respond to the kick, not sleep through it.
    const nudge = elementVibeSeed(b.id, world.tick, world.rngState);
    b.vel.x = nudge.x;
    b.vel.y = nudge.y;
    body.setLinvel({ x: b.vel.x, y: b.vel.y, z: b.vz }, true);
  }
}
