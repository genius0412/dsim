import RAPIER from '@dimforge/rapier2d-compat';
import type { Artifact, RobotState, Vec2, World } from '../types';
import * as C from '../config';
import { classifierRect, goalFaceNormal, goalFacePoints } from './field';
import { robotExtents } from './physics';
import { datan2, hyp } from '../math';

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

/** static field colliders: perimeter walls, goal-face hypotenuses, classifier
 * channels. Rebuilt each step (constant geometry — cheap). */
function buildStatics(rw: RAPIER.World): void {
  const f = C.FIELD_HALF;
  // 4 perimeter walls: inner faces exactly at ±FIELD_HALF
  rw.createCollider(statics(RAPIER.ColliderDesc.cuboid(WALL_T, WALL_L).setTranslation(f + WALL_T, 0)));
  rw.createCollider(statics(RAPIER.ColliderDesc.cuboid(WALL_T, WALL_L).setTranslation(-f - WALL_T, 0)));
  rw.createCollider(statics(RAPIER.ColliderDesc.cuboid(WALL_L, WALL_T).setTranslation(0, f + WALL_T)));
  rw.createCollider(statics(RAPIER.ColliderDesc.cuboid(WALL_L, WALL_T).setTranslation(0, -f - WALL_T)));

  for (const a of ALLIANCES) {
    // goal FACE: a thin slab lying along the hypotenuse, offset toward the
    // corner so its field-side face IS the hypotenuse (robots pushed out)
    const [far, side] = goalFacePoints(a);
    const mx = (far.x + side.x) / 2;
    const my = (far.y + side.y) / 2;
    const len = hyp(side.x - far.x, side.y - far.y);
    const ang = datan2(side.y - far.y, side.x - far.x);
    const n = goalFaceNormal(a); // unit, points into the field
    rw.createCollider(
      statics(
        RAPIER.ColliderDesc.cuboid(len / 2, GOAL_FACE_T)
          .setTranslation(mx - n.x * GOAL_FACE_T, my - n.y * GOAL_FACE_T)
          .setRotation(ang),
      ),
    );

    // classifier channel (axis-aligned rect along the side wall)
    const r = classifierRect(a);
    rw.createCollider(
      statics(
        RAPIER.ColliderDesc.cuboid((r.x1 - r.x0) / 2, (r.y1 - r.y0) / 2).setTranslation(
          (r.x0 + r.x1) / 2,
          (r.y0 + r.y1) / 2,
        ),
      ),
    );
  }
}

/** a fresh Rapier world with our inch-scale tolerances + the static field
 * colliders. Shared by the robot and ball solves. */
function makeWorld(dt: number): RAPIER.World {
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
  rw.integrationParameters.contact_natural_frequency = C.PHYS_CONTACT_FREQ;
  rw.integrationParameters.normalizedAllowedLinearError = C.PHYS_ALLOWED_ERROR;
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
export function solveRobots(world: World, dt: number): Map<number, Vec2> {
  const preVels = new Map<number, Vec2>();
  const robots = world.robots;
  if (robots.length === 0) return preVels;

  const rw = makeWorld(dt);
  const bodies: { r: RobotState; body: RAPIER.RigidBody }[] = [];
  for (const r of robots) {
    preVels.set(r.id, { x: r.vel.x, y: r.vel.y });
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
    rw.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, e.half)
        .setTranslation(forward, 0) // body-local (rotated by heading)
        .setMass(r.spec.massLb)
        .setRestitution(0)
        .setFriction(C.PHYS_FRICTION),
      body,
    );
    bodies.push({ r, body });
  }

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

  const rw = makeWorld(dt);
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
