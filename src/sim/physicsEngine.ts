import RAPIER from '@dimforge/rapier2d-compat';
import type { Alliance, Artifact, RobotState, Vec2, World } from '../types';
import * as C from '../config';
import { classifierRect, goalFaceNormal, goalFacePoints, goalSide } from './field';
import { robotExtents } from './physics';
import { datan2, dcos, hyp, clamp } from '../math';

/**
 * Rapier 2D physics bridge (netcodeplan Phase 2, robots-first slice).
 *
 * The sim's `World` stays the single canonical, JSON-serializable source of
 * truth. Each `step()` builds a FRESH Rapier world from the robots' current
 * poses, steps it once, and writes the resolved translation + velocity back —
 * then frees it. Statelessness is deliberate: `game.ts` reconcile swaps
 * `this.world` for a fresh snapshot up to 60×/s, so a Rapier world keyed to
 * object identity would rebuild-and-leak WASM every frame. Rebuild-per-step
 * makes reconcile and bit-for-bit determinism trivially correct, and building
 * a handful of colliders + N bodies is microseconds.
 *
 * Rapier OWNS robot translation + velocity (→ wall/robot velocity-kill,
 * mass-weighted shoving, restitution-0 inelastic contact, and — because
 * RobotState is canonical and rebuilt each tick — pinned-ball feedback, all for
 * free). Rotation is LOCKED on the bodies; the bespoke contact-torque "square
 * up flush" nudge stays in physics.ts (`squareUpRobots`), the one piece the
 * plan calls out as not a Rapier primitive.
 *
 * Slice 2 adds GROUND balls to the SAME unified solve (circle bodies, tiny
 * mass), so ball↔ball / ball↔robot / ball↔wall / ball↔goal-face /
 * ball↔classifier resolve together — and the pinned-ball → robot feedback falls
 * out of a real mass ratio. Rolling friction + rest-snap + the hard field clamp
 * stay bespoke around the solve (top-down plane has no floor to rub on, and
 * Rapier's soft contacts allow ~0.2in penetration the containment invariant
 * won't tolerate). Restitution combines with `Min` across every collider so the
 * per-pair coefficients fall straight out of the BALL_* constants. FLIGHT balls
 * (ballistic + rare low collisions) stay bespoke in world.ts / physics.ts.
 */


let ready = false;

/** Load + init the Rapier WASM (async). MUST resolve before any `step()` runs;
 * awaited at every entry point (smoke, server, browser). Idempotent. */
export async function initPhysics(): Promise<void> {
  if (ready) return;
  await RAPIER.init();
  ready = true;
}

export function physicsReady(): boolean {
  return ready;
}

const ALLIANCES = ['red', 'blue'] as const;
const WALL_T = 10; // perimeter wall half-thickness (well outside the field)
const WALL_L = C.FIELD_HALF + 20; // wall half-length (overlaps corners)
const GOAL_FACE_T = 4; // goal-face slab half-thickness (behind the hypotenuse)

/** give a static field collider a ball-bounce restitution combined with Min, so
 * a ground ball caroms off it at BALL_WALL_RESTITUTION while a robot (restitution
 * 0) still resolves fully inelastically against it — slice-1 robot feel intact. */
function statics(desc: RAPIER.ColliderDesc): RAPIER.ColliderDesc {
  return desc
    .setRestitution(C.BALL_WALL_RESTITUTION)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min);
}

/** one static cuboid collider, as plain numbers (world-independent) */
interface StaticSpec {
  hx: number;
  hy: number;
  tx: number;
  ty: number;
  rot: number;
}

/** The static field geometry (perimeter walls, goal-face hypotenuses, classifier
 * channels) is CONSTANT — but a fresh Rapier world is built ~120×/s, so computing
 * the goal trig/points + allocating on every build is pure waste. Compute the
 * cuboid params ONCE (identical numbers ⇒ bit-for-bit identical colliders ⇒
 * determinism preserved) and just recreate colliders from the cache each step. */
let STATIC_SPECS: StaticSpec[] | null = null;

function computeStaticSpecs(): StaticSpec[] {
  const f = C.FIELD_HALF;
  const specs: StaticSpec[] = [
    // 4 perimeter walls: inner faces exactly at ±FIELD_HALF
    { hx: WALL_T, hy: WALL_L, tx: f + WALL_T, ty: 0, rot: 0 },
    { hx: WALL_T, hy: WALL_L, tx: -f - WALL_T, ty: 0, rot: 0 },
    { hx: WALL_L, hy: WALL_T, tx: 0, ty: f + WALL_T, rot: 0 },
    { hx: WALL_L, hy: WALL_T, tx: 0, ty: -f - WALL_T, rot: 0 },
  ];
  for (const a of ALLIANCES) {
    // goal FACE: a thin slab lying along the hypotenuse, offset toward the
    // corner so its field-side face IS the hypotenuse (robots pushed out)
    const [far, side] = goalFacePoints(a);
    const mx = (far.x + side.x) / 2;
    const my = (far.y + side.y) / 2;
    const len = hyp(side.x - far.x, side.y - far.y);
    const ang = datan2(side.y - far.y, side.x - far.x);
    const n = goalFaceNormal(a); // unit, points into the field
    specs.push({ hx: len / 2, hy: GOAL_FACE_T, tx: mx - n.x * GOAL_FACE_T, ty: my - n.y * GOAL_FACE_T, rot: ang });

    // classifier channel (axis-aligned rect along the side wall)
    const r = classifierRect(a);
    specs.push({
      hx: (r.x1 - r.x0) / 2,
      hy: (r.y1 - r.y0) / 2,
      tx: (r.x0 + r.x1) / 2,
      ty: (r.y0 + r.y1) / 2,
      rot: 0,
    });
  }
  return specs;
}

/** static field colliders from the cached specs. Rebuilt each step onto the fresh
 * world (the geometry math is memoized above). */
function buildStatics(rw: RAPIER.World): void {
  if (!STATIC_SPECS) STATIC_SPECS = computeStaticSpecs();
  for (const s of STATIC_SPECS) {
    rw.createCollider(
      statics(RAPIER.ColliderDesc.cuboid(s.hx, s.hy).setTranslation(s.tx, s.ty).setRotation(s.rot)),
    );
  }
}

/** the physical GATE handle as a one-way door: a thin solid slab spanning the SHORT
 * arm's (foreshortened) reach from the field-edge pivot OUT into the gate zone. A robot
 * CANNOT strafe/drive through it — the only way to nose past is to OPEN the gate: a push
 * lifts `gatePos` and the handle RETRACTS toward the pivot, so the opening robot glides in
 * rather than being shoved. (It won't shove a resting robot either — touch-hold keeps an
 * open gate open so it never swings closed against you.) The LONG paddle needs no collider
 * (it lies over the already-solid classifier channel). Robot-solve ONLY (never the ball
 * solve): released artifacts roll out beneath the lifted paddle. Rebuilt each step from the
 * live `gatePos` (one-tick lag vs updateGates, like power draw — deterministic). */
function buildGateArms(
  rw: RAPIER.World,
  world: World,
  gateCol?: Record<Alliance, number>,
): void {
  for (const a of ALLIANCES) {
    const g = goalSide(a);
    // use the ANTICIPATED open fraction (this tick's lift already folded in by
    // gateColliderPos) when provided, so a robot ramming the gate open glides through
    // on the same tick instead of hard-stopping against last tick's closed stub.
    const pos = gateCol ? gateCol[a] : world.goals[a].gatePos;
    const proj = C.GATE_ARM_SHORT * dcos(pos * C.GATE_LIFT);
    if (proj <= 0) continue;
    const pivotX = g * (C.FIELD_HALF - C.CLASSIFIER_W); // classifier field-side edge (pivot)
    rw.createCollider(
      statics(
        RAPIER.ColliderDesc.cuboid(proj / 2, C.GATE_ARM_THICK / 2)
          .setTranslation(pivotX - g * (proj / 2), C.GATE_TAPE_Y), // handle reaches into the field (−g)
      ),
    );
  }
}

/** a fresh Rapier world with our inch-scale tolerances + the static field
 * colliders. Shared by the robot and ball solves. Robots use SOFT contacts
 * (a robot can start a step deep inside a wall via its intake reach — a stiff
 * contact would eject it explosively); balls are small and slow and never start
 * deeply embedded, so they use STIFF contacts (`freq`/`allowedError`) that push
 * an overlapping pair fully apart in one step instead of leaving them visibly
 * interpenetrating for several ticks. */
function makeWorld(
  dt: number,
  freq: number = C.PHYS_CONTACT_FREQ,
  allowedError: number = C.PHYS_ALLOWED_ERROR,
): RAPIER.World {
  const rw = new RAPIER.World({ x: 0, y: 0 }); // top-down plane: no gravity
  rw.timestep = dt;
  // Rapier's tolerances default to METERS; our world is in INCHES (~40× bigger),
  // so tell it the typical object scale. Without this the penetration-error and
  // corrective-velocity caps are mis-scaled and a robot driven full-speed into a
  // wall-pinned robot out-runs the solver — penetration grows until the min-axis
  // flips and the pair is ejected sideways. Extra iterations keep deep contacts
  // (a full-speed pin) fully projected out each step, like the old solver did.
  rw.integrationParameters.lengthUnit = C.PHYS_LENGTH_UNIT;
  rw.integrationParameters.numSolverIterations = C.PHYS_SOLVER_ITERS;
  rw.integrationParameters.contact_natural_frequency = freq;
  rw.integrationParameters.normalizedAllowedLinearError = allowedError;
  buildStatics(rw);
  return rw;
}

/**
 * Resolve robot translation + velocity for one tick via Rapier: build bodies at
 * the robots' current poses (rotation locked, linvel = r.vel, mass = massLb),
 * step once, and write the resolved translation + velocity back into RobotState.
 * Returns each robot's PRE-solve velocity (keyed by id) so the bespoke square-up
 * pass can scale contact torque by how hard the robot was driving in.
 *
 * Robots only — BALLS are a SEPARATE solve (`solveBalls`) followed by the bespoke
 * `collideBallRobot`. Ball↔robot is NOT a Rapier contact on purpose: the "gate
 * outflow can't shove a parked robot" rule (product decision #7) is deliberately
 * NON-physical, and a light ball can't stall a force-set-velocity robot in a
 * single solve. Keeping ball↔robot bespoke preserves both the pin stall and the
 * outflow-no-shove feel. Robots therefore never see ball bodies here (slice-1
 * robot behavior is byte-for-byte unchanged).
 */
export function solveRobots(
  world: World,
  dt: number,
  gateCol?: Record<Alliance, number>,
): Map<number, Vec2> {
  const preVels = new Map<number, Vec2>();
  const robots = world.robots;
  if (robots.length === 0) return preVels;

  const rw = makeWorld(dt);
  const bodies: { r: RobotState; body: RAPIER.RigidBody }[] = [];
  for (const r of robots) {
    // Always record preVels for all robots, even if not simulated by Rapier
    preVels.set(r.id, { x: r.vel.x, y: r.vel.y });

    // Only create physics bodies for robots NOT on an auto path
    if (!r.autoPathActive) {
      const e = robotExtents(r);
      const hx = (e.front + e.rear) / 2;
      const forward = (e.front - e.rear) / 2; // intake reach shifts the box forward
      const body = rw.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(r.pos.x, r.pos.y)
          .setRotation(r.heading)
          .lockRotations()
          .setLinvel(r.vel.x, r.vel.y),
      );
      // PUSHING POWER (effective shove mass): real mass × drivetrain traction
      // × wheel torque (geared for speed ⇒ less push, inverse RPM) × available
      // current (1 − power draw). driveParams.accel uses the REAL massLb, so
      // inflating the shove mass here never touches linear accel. At the DEFAULT
      // reference (mecanum, 435 rpm, at rest) all factors = 1 ⇒ shove unchanged.
      const p = C.DRIVETRAIN_PRESETS[r.spec.drivetrain];
      const rpmPush = clamp(C.REF_DRIVE_RPM / r.spec.driveRpm, 0.6, 1.8);
      const shoveMass = r.spec.massLb * p.pushMult * rpmPush * (1 - r.powerDraw);
      rw.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, e.half)
          .setTranslation(forward, 0) // body-local (rotated by heading)
          .setMass(shoveMass)
          .setRestitution(0)
          .setFriction(C.PHYS_FRICTION),
        body,
      );
      bodies.push({ r, body });
    }
  }

  // the physical gate handles (one-way doors) — after the robot bodies, before the step
  buildGateArms(rw, world, gateCol);

  rw.step();

  for (const { r, body } of bodies) {
    const p = body.translation();
    const v = body.linvel();
    r.pos.x = p.x;
    r.pos.y = p.y;
    r.vel.x = v.x;
    r.vel.y = v.y;
  }

  rw.free();
  return preVels;
}

/**
 * Resolve GROUND-ball translation + velocity for one tick via a separate Rapier
 * solve: light circle bodies (linvel = b.vel, mass = BALL_MASS) against the
 * static field only — ball↔ball and ball↔wall / ball↔goal-face / ball↔classifier
 * contact. Robots are ABSENT (ball↔robot is the bespoke `collideBallRobot` pass,
 * run after this, for the reasons in `solveRobots`). Friction/rest-snap (velocity
 * pre-pass) and the hard field clamp are applied around this call in world.ts.
 * Bodies are built in stable `world.balls` id order so the solve is deterministic.
 */
export function solveBalls(world: World, dt: number): void {
  const groundBalls = world.balls.filter((b) => b.state.kind === 'ground');
  if (groundBalls.length === 0) return;

  const rw = makeWorld(dt, C.PHYS_BALL_CONTACT_FREQ, C.PHYS_BALL_ALLOWED_ERROR);
  const ballBodies: { b: Artifact; body: RAPIER.RigidBody }[] = [];
  for (const b of groundBalls) {
    const body = rw.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(b.pos.x, b.pos.y)
        .lockRotations()
        .setLinvel(b.vel.x, b.vel.y),
    );
    rw.createCollider(
      RAPIER.ColliderDesc.ball(C.BALL_RADIUS)
        .setMass(C.BALL_MASS)
        .setRestitution(C.BALL_BALL_RESTITUTION)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setFriction(C.PHYS_FRICTION),
      body,
    );
    ballBodies.push({ b, body });
  }

  rw.step();

  for (const { b, body } of ballBodies) {
    const p = body.translation();
    const v = body.linvel();
    b.pos.x = p.x;
    b.pos.y = p.y;
    b.vel.x = v.x;
    b.vel.y = v.y;
  }

  rw.free();
}
