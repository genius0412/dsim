import RAPIER from '@dimforge/rapier2d-compat';
import type { RobotState, Vec2, World } from '../types';
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
 * plan calls out as not a Rapier primitive. Balls remain fully bespoke in this
 * slice.
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

/** static field colliders: perimeter walls, goal-face hypotenuses, classifier
 * channels. Rebuilt each step (constant geometry — cheap). */
function buildStatics(rw: RAPIER.World): void {
  const f = C.FIELD_HALF;
  // 4 perimeter walls: inner faces exactly at ±FIELD_HALF
  rw.createCollider(RAPIER.ColliderDesc.cuboid(WALL_T, WALL_L).setTranslation(f + WALL_T, 0));
  rw.createCollider(RAPIER.ColliderDesc.cuboid(WALL_T, WALL_L).setTranslation(-f - WALL_T, 0));
  rw.createCollider(RAPIER.ColliderDesc.cuboid(WALL_L, WALL_T).setTranslation(0, f + WALL_T));
  rw.createCollider(RAPIER.ColliderDesc.cuboid(WALL_L, WALL_T).setTranslation(0, -f - WALL_T));

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
      RAPIER.ColliderDesc.cuboid(len / 2, GOAL_FACE_T)
        .setTranslation(mx - n.x * GOAL_FACE_T, my - n.y * GOAL_FACE_T)
        .setRotation(ang),
    );

    // classifier channel (axis-aligned rect along the side wall)
    const r = classifierRect(a);
    rw.createCollider(
      RAPIER.ColliderDesc.cuboid((r.x1 - r.x0) / 2, (r.y1 - r.y0) / 2).setTranslation(
        (r.x0 + r.x1) / 2,
        (r.y0 + r.y1) / 2,
      ),
    );
  }
}

/**
 * Resolve robot translation + velocity for one tick via Rapier: build bodies at
 * the robots' current poses (rotation locked, linvel = r.vel, mass = massLb),
 * step once, and write the resolved translation + velocity back into RobotState.
 * Returns each robot's PRE-solve velocity (keyed by id) so the bespoke square-up
 * pass can scale contact torque by how hard the robot was driving in.
 */
export function solveRobots(world: World, dt: number): Map<number, Vec2> {
  const preVels = new Map<number, Vec2>();
  const robots = world.robots;
  if (robots.length === 0) return preVels;

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