import RAPIER from '@dimforge/rapier2d-compat';
import type { Alliance, Artifact, RobotState, Vec2, World } from '../types';
import * as C from '../config';
import { clampBallPosToStatics, robotExtents } from './physics';
import { robotPenetration, type RobotSolids, type SolidShape } from './artifactSolids';
import { shoveMass } from './drivetrain';
import type { DriveWrench } from './robot';
import { chassisInertia } from './robot';
import { clamp, dcos, dsin, hyp, wrapAngle } from '../math';
import type { FieldColliders } from '../games/types';

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
 * Rapier OWNS robot translation, velocity AND rotation (→ wall/robot velocity-kill,
 * mass-weighted shoving, restitution-0 inelastic contact). The drive reaches it as a
 * FORCE + TORQUE (`DriveWrench`), so the angular half of a contact is the solver's own
 * answer rather than a heuristic; the bespoke contact-torque "square up flush" nudge stays
 * in physics.ts (`squareUpRobots`), the one piece the plan calls out as not a Rapier
 * primitive.
 *
 * GROUND artifacts are a second solve (`solveArtifacts`) in the same tick, and the two are
 * run as ROUNDS (the loop in `world.ts` `step`): the robot solve first, with every artifact
 * PINNED against the field or another robot standing in it as a fixed circle (`R_PIN`) that
 * the chassis solids (`R_CSOL`, from `artifactSolids`) cannot pass; then the artifact solve,
 * with every robot a KINEMATIC body sweeping from where it began the tick to where the robot
 * solve put it, carrying the same `artifactSolids` shapes as colliders. `pinnedArtifacts`
 * then asks which artifacts are being squeezed (with hysteresis and a transitive support
 * test), and if the set GREW the tick is re-run from the snapshot with the new pins — so an
 * artifact pressed between a bumper and a wall is the thing the ROBOT stops on, not the thing
 * the artifact solve is asked to squirt out of the way. ONE geometry authority for what on a
 * robot is solid (`artifactSolids.ts`) is what lets the two solves and the pin test agree;
 * the intake mouth is open in all three by design. Restitution and friction both combine
 * with `Min` on the artifact side, so the per-pair coefficients fall straight out of the
 * BALL_* and INTAKE_* constants. FLIGHT balls (ballistic + rare low collisions) stay bespoke
 * in world.ts / physics.ts, as do the basin, the rail and the gate.
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

/** give a static field collider a ball-bounce restitution combined with Min, so
 * a ground ball caroms off it at BALL_WALL_RESTITUTION while a robot (restitution
 * 0) still resolves fully inelastically against it — slice-1 robot feel intact. */
function statics(desc: RAPIER.ColliderDesc, groups?: number, friction: number = C.PHYS_WALL_FRICTION): RAPIER.ColliderDesc {
  const d = desc
    // stated, not inherited — see PHYS_WALL_FRICTION; the artifact world passes its own
    .setFriction(friction)
    .setRestitution(C.BALL_WALL_RESTITUTION)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min);
  // Only the ARTIFACT solve names a group here (see FIELD_GROUP). Left unset everywhere else,
  // so the robot solve gets Rapier's default membership and is untouched to the digit.
  return groups === undefined ? d : d.setCollisionGroups(groups);
}

/** build a game's static field colliders (perimeter walls + structures) onto the
 * fresh world, in the module's stable spec order (determinism). The geometry math
 * is memoized in the game module (`FieldColliders.statics`). */
function buildStatics(rw: RAPIER.World, colliders: FieldColliders, groups?: number, friction?: number): void {
  for (const s of colliders.statics) {
    rw.createCollider(
      statics(
        RAPIER.ColliderDesc.cuboid(s.hx, s.hy).setTranslation(s.tx, s.ty).setRotation(s.rot),
        groups,
        friction,
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
  colliders: FieldColliders,
  freq: number = C.PHYS_CONTACT_FREQ,
  allowedError: number = C.PHYS_ALLOWED_ERROR,
  staticGroups?: number,
  staticFriction?: number,
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
  buildStatics(rw, colliders, staticGroups, staticFriction);
  return rw;
}

/**
 * How much of `now`'s overhang has to be given back: whatever takes it past the larger of what
 * the robot already had and the resting slop. Signed — + is past the high wall, − the low.
 *
 * THE SLOP IS LOAD-BEARING. Ordinary soft contact leaves a chassis resting a little into a wall
 * (0.57in at the worst measured shove), and a containment pass that fought that every tick is
 * precisely the two-passes-taking-turns failure the artifact solve had to be rebuilt to avoid —
 * tried without it, and the wall square-up lost flush by 1.4 degrees while artifacts started
 * jittering against the classifier again. Above the worst honest penetration, far below
 * "outside the field", so it only ever acts once the solver has already given up.
 */
function grewOut(now: number, was: number): number {
  const allowed = Math.max(Math.abs(was), C.PHYS_CONTAIN_SLOP);
  const over = Math.abs(now) - allowed;
  return over > 0 ? (now > 0 ? over : -over) : 0;
}

/**
 * How far a robot's footprint sticks out past the perimeter, as an outward vector (0 inside).
 *
 * Used by `solveRobots` to hold a containment invariant the colliders alone cannot: a robot
 * that began a tick INSIDE the field may not be pushed out of it. That was true for free while
 * every body in the solve was dynamic and would yield, and stopped being true the moment one
 * of them could not — a chassis crushed between the far wall and a robot on an AUTO PATH
 * (kinematic; it does not give) was driven 15.2in past the wall, and with a longer path left
 * the field entirely. No speed guard can see that: Rapier's positional correction does not feed
 * velocity, so the victim's `r.vel` read 0.00 for every tick it was being pushed through. The
 * violation is positional, so the answer has to be.
 *
 * IT CLAMPS THE GROWTH, NOT THE VALUE. A robot may legitimately be outside already — DECODE's
 * outflow mouth sits at x = -69 inside the classifier channel, and a probe parked on it has its
 * whole chassis past the wall plane — and a pass that hauled such a robot back in would be
 * overriding a pose nothing put it in. Containment keeps you in; it does not teleport you in.
 */
function outsideBy(r: RobotState, bounds: { halfX: number; halfY: number }): Vec2 {
  const e = robotExtents(r);
  const c = dcos(r.heading);
  const s = dsin(r.heading);
  // the footprint's axis-aligned half-extents, which is all an axis-aligned wall can see
  const hx = (e.front + e.rear) / 2;
  const cx = r.pos.x + ((e.front - e.rear) / 2) * c;
  const cy = r.pos.y + ((e.front - e.rear) / 2) * s;
  const ax = Math.abs(hx * c) + Math.abs(e.half * s);
  const ay = Math.abs(hx * s) + Math.abs(e.half * c);
  return {
    x: Math.max(0, cx + ax - bounds.halfX) + Math.min(0, cx - ax + bounds.halfX),
    y: Math.max(0, cy + ay - bounds.halfY) + Math.min(0, cy - ay + bounds.halfY),
  };
}

/**
 * Resolve robot translation + velocity for one tick via Rapier: build bodies at
 * the robots' current poses (rotation locked, linvel = r.vel, mass = `shoveMass` — push
 * AUTHORITY, not weight; see drivetrain.ts),
 * step once, and write the resolved translation + velocity back into RobotState.
 * Returns each robot's PRE-solve velocity (keyed by id) so the bespoke square-up
 * pass can scale contact torque by how hard the robot was driving in.
 *
 * Robots only — ARTIFACTS are a SEPARATE solve (`solveArtifacts`), which builds its own chassis
 * bodies and is where ball↔robot momentum is exchanged in BOTH directions. Two solves rather
 * than one because they want different contact stiffness (a robot can start a step deep
 * inside a wall via its intake reach; an artifact never does) and because the artifact solve
 * must see the CHASSIS where this one sees the whole footprint, intake included.
 */
export function solveRobots(
  world: World,
  dt: number,
  colliders: FieldColliders,
  gateCol?: Record<Alliance, number>,
  /** the DRIVE, as a force + torque per robot id (`updateRobot`). Absent ⇒ this robot is
   *  coasting: the solver still owns its motion, nothing is being asked of the wheels. */
  drive?: Map<number, DriveWrench>,
  /** ground artifacts that could not get out of a robot's way this tick (see
   *  `pinnedArtifacts`), at the positions they began the tick in. Each becomes a fixed
   *  circle the robots' artifact-solid geometry stops against — a pinned artifact is a wall. */
  pinned?: readonly Vec2[],
  /** each robot's artifact-solid geometry (`robotSolids`), needed only when `pinned` is not
   *  empty: the footprint box is what meets walls and other robots, but what meets an
   *  artifact is the chassis and the intake's structure with the mouth left open. */
  solids?: ReadonlyMap<number, RobotSolids>,
): Map<number, Vec2> {
  const preVels = new Map<number, Vec2>();
  const robots = world.robots;
  if (robots.length === 0) return preVels;

  const rw = makeWorld(dt, colliders, undefined, undefined, R_STAT);
  const bodies: { r: RobotState; body: RAPIER.RigidBody; wasOut: Vec2 }[] = [];
  for (const r of robots) {
    // Always record preVels for all robots, even if Rapier will not move this one
    preVels.set(r.id, { x: r.vel.x, y: r.vel.y });

    const e = robotExtents(r);
    const hx = (e.front + e.rear) / 2;
    const forward = (e.front - e.rear) / 2; // intake reach shifts the box forward
    /**
     * A ROBOT ON AN AUTO PATH IS STILL A SOLID OBJECT.
     *
     * It used to get no body at all, so for the whole 30 s of AUTO it was a GHOST: an
     * opponent drove clean through it (measured — the pusher crossed it end to end and the
     * path robot never moved a thousandth of an inch) and it passed through walls too. The
     * path is authoritative over where it goes, which is a reason not to let physics MOVE it
     * — not a reason to let the world reach through it.
     *
     * KINEMATIC is exactly that distinction, and it is the same call `solveArtifacts` makes for
     * the chassis: everyone collides with it, nothing pushes it. Its pose for this tick was
     * already written by `updatePathTraversal` before this pass runs, so the body is built
     * where the path put it.
     *
     * IT GETS THE SWEEP VELOCITY TOO, and that is not cosmetic. A path robot TELEPORTS
     * (1.56 in/tick at the default spec); a kinematic body the solver believes is stationary
     * leaves nothing but the soft positional correction acting on whatever is in the way, and
     * that cannot keep up. Measured with a zero linvel: overlap grew monotonically to 15.2 in
     * on a 17.5 in pair until the SAT min axis flipped, the bystander was ejected 4 in sideways
     * and 3 in backwards, and the path robot then passed clean through it — the same
     * min-axis-flip failure `makeWorld` above warns about. With the velocity set, peak
     * penetration is 0.00 in. `world.ts` writes it from the pose delta.
     *
     * Chain Reaction never sets the flag (`makeChainRobot` hard-codes false and CR has no
     * path system), so this branch is DECODE-only in practice.
     */
    const body = rw.createRigidBody(
      r.autoPathActive
        ? RAPIER.RigidBodyDesc.kinematicVelocityBased()
            .setTranslation(r.pos.x, r.pos.y)
            .setRotation(r.heading)
            .setLinvel(r.vel.x, r.vel.y)
        : /**
           * ROTATION IS NOT LOCKED ANY MORE — slice A.
           *
           * It was, and everything angular had to be hand-built around that: the two-body
           * impulse in `squareUpPair`, the settling nudge, `CONTACT_PAIR_SPIN`, the slip
           * relief. A locked body cannot yaw from a contact, so an off-centre hit produced
           * nothing at all and the bespoke pass existed to put it back.
           *
           * With the drive arriving as a force (see `updateRobot`), the solver can answer the
           * angular half itself, from the same normal and friction impulses it already
           * computes — a flank drag yaws you because the friction acts off the centre of mass,
           * not because a heuristic says so.
           */
          RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(r.pos.x, r.pos.y)
            .setRotation(r.heading)
            .setLinvel(r.vel.x, r.vel.y)
            .setAngvel(r.angVel),
    );
    // PUSHING POWER. `shoveMass` is the collider mass that DELIVERS this robot's
    // `pushForce` given the accel the motor model used — see drivetrain.ts, which owns
    // the whole model and documents why the force cannot simply be written here as a
    // mass. BUTTERFLY: the set that is DOWN decides both the traction factor and the
    // gearing, so dropping the traction wheels really does turn it into a pusher
    // mid-match (and back) — `r.butterflyTank` carries that into both terms.
    /**
     * ...AND THE MASS PROPERTIES ARE STATED, not derived from the box.
     *
     * `setMass` alone would put the centre of mass at the FOOTPRINT's centre, which sits
     * forward of the chassis by half the intake reach — so a robot would pivot about a point
     * out in front of itself and the drive model's `maxTurn` (worked out about the chassis
     * centre, from its half-diagonal) would no longer be the free-space answer. The COM is
     * pinned back to the body origin and the inertia is the chassis rectangle's, which is the
     * same expression `squareUpPair`'s impulse already used — so nothing in the sim disagrees
     * about how hard this robot is to spin.
     */
    const m = shoveMass(r.spec, r.butterflyTank, r.powerDraw);
    rw.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, e.half)
        .setTranslation(forward, 0) // body-local (rotated by heading)
        .setMassProperties(m, { x: -forward, y: 0 }, chassisInertia(m, r.spec))
        .setRestitution(0)
        .setFriction(C.PHYS_FRICTION)
        .setCollisionGroups(R_FOOT),
      body,
    );
    /**
     * ...AND, WHEN AN ARTIFACT IS PINNED SOMEWHERE ON THE FIELD, WHAT AN ARTIFACT TOUCHES.
     *
     * The footprint above is the right box for walls, the gate handle and other robots — the
     * intake is structure to all of those. It is the WRONG box for an artifact, whose way into
     * the mouth is open by design. So a pinned artifact is met by the same chassis + intake
     * structure + held-artifact geometry the artifact solve uses (`artifactSolids.ts`), as
     * massless colliders in their own collision group that touch nothing but pinned artifacts.
     * The body's mass properties stay exactly what the footprint collider states — density 0
     * adds nothing — so this changes nothing about how the robot moves unless it is actually
     * driving into a pinned artifact.
     */
    const sol = pinned && pinned.length > 0 ? solids?.get(r.id) : undefined;
    if (sol) {
      for (const sh of [sol.chassis, ...sol.structure, ...sol.held]) {
        const d = solidDesc(sh);
        if (!d) continue;
        rw.createCollider(
          d.setDensity(0).setRestitution(0).setFriction(C.PHYS_PIN_FRICTION).setCollisionGroups(R_CSOL),
          body,
        );
      }
    }
    // the DRIVE, for this tick. A pure force acts at the centre of mass and a pure torque
    // about it, so the two are independent: driving forward never yaws you by itself.
    const w = drive?.get(r.id);
    if (w && !r.autoPathActive) {
      if (w.fx !== 0 || w.fy !== 0) body.addForce({ x: w.fx, y: w.fy }, true);
      if (w.tau !== 0) body.addTorque(w.tau, true);
    }
    // ...and only a DYNAMIC body has a result worth reading back.
    if (!r.autoPathActive) bodies.push({ r, body, wasOut: outsideBy(r, colliders.bounds) });
  }

  // the physical gate handles (one-way doors) — after the robot bodies, before
  // the step, in the module's stable order (matches the old buildGateArms call site)
  for (const s of colliders.dynamic?.(world, dt, gateCol) ?? []) {
    rw.createCollider(
      statics(RAPIER.ColliderDesc.cuboid(s.hx, s.hy).setTranslation(s.tx, s.ty).setRotation(s.rot), R_STAT),
    );
  }

  /**
   * A PINNED ARTIFACT IS A WALL. It is a fixed circle here, at the position it began the tick
   * in, and it meets only the robots' artifact-solid colliders — so a robot driving into it is
   * stopped by the solver exactly the way a wall stops it, the drive re-applies its force next
   * tick and is refused again, and the tyres read the refusal as slip. Nothing is written by
   * hand. It has low friction because a ball rolls under a chassis sliding past it.
   */
  if (pinned) {
    for (const p of pinned) {
      rw.createCollider(
        RAPIER.ColliderDesc.ball(C.BALL_RADIUS + C.PHYS_PIN_INFLATE)
          .setTranslation(p.x, p.y)
          .setRestitution(0)
          .setFriction(C.PHYS_PIN_FRICTION)
          .setCollisionGroups(R_PIN),
      );
    }
  }

  rw.step();

  for (const { r, body, wasOut } of bodies) {
    const p = body.translation();
    const v = body.linvel();
    r.pos.x = p.x;
    r.pos.y = p.y;
    // ...and it may not have been pushed FURTHER out than it already was (see `outsideBy`).
    const nowOut = outsideBy(r, colliders.bounds);
    r.pos.x -= grewOut(nowOut.x, wasOut.x);
    r.pos.y -= grewOut(nowOut.y, wasOut.y);
    /**
     * A SOLVER-EXPLOSION GUARD, not a gameplay lever.
     *
     * Nothing on this field can legitimately carry a robot past a couple of times its own top
     * speed: the hardest thing that can happen to it is being rammed by another robot, and no
     * robot goes faster than ~94 in/s. A larger number is the solver failing to satisfy an
     * over-constrained contact, and there is exactly one way to over-constrain it — squeeze a
     * dynamic chassis between something immovable and something that will not yield.
     *
     * That case now exists: a robot on an AUTO PATH is kinematic, so it advances regardless of
     * what is in front of it, and when the bystander it has been carrying reaches a wall the
     * two demands cannot both be met. Measured, the pair squirted out at 959 in/s — six field
     * widths a second. The squeeze itself is inherent (the path is authoritative over where it
     * goes, which is the whole design), so the answer is to make it a bounded shove rather than
     * a launch. Everywhere else this is dead code, and it should stay that way: if it starts
     * binding in ordinary play, something upstream is wrong — which is why the ceiling is an
     * ABSOLUTE speed and not a multiple of this robot's own (see `PHYS_MAX_ROBOT_SPEED`; the
     * per-robot version fired on ordinary shoves of a slow chassis by a fast one).
     */
    /**
     * A CONTACT MAY NOT SLING YOU SIDEWAYS PAST WHAT THE TYRES HOLD — IN THE SAME TICK.
     *
     * The per-wheel traction answers a tick late, which is right for a sustained drag and
     * wrong for an impact: driving into the gate structure at 30 in/s came out at 10.7 in/s
     * pointing somewhere else, and the wheels then spent a tenth of a second clawing the
     * sideways half back. Reported as a surge of strafing speed at the gate, and the old model
     * never showed it because it re-imposed the commanded velocity every tick, so no impact
     * could redirect anybody.
     *
     * ONLY THE SIDEWAYS HALF, and that is the whole point. The normal component still stops
     * you, the ROTATION an off-centre hit produces is untouched — "the turning should honestly
     * happen" — and what goes is the part a real tyre would simply refuse: a wall cannot
     * accelerate a chassis along itself harder than friction allows.
     */
    let vx = v.x;
    let vy = v.y;
    const w = drive?.get(r.id);
    if (w) {
      const rc = dcos(r.heading);
      const rs = dsin(r.heading);
      const latV = -vx * rs + vy * rc; // the solver's sideways velocity, robot-left positive
      const latW = -w.wantX * rs + w.wantY * rc; // ...and the sideways velocity the drive asked for
      /**
       * BEING STOPPED IS NOT BEING SLUNG. The clip exists for a contact that DRAGS the chassis
       * sideways faster than the tyres could ever allow. It used to measure the whole
       * difference between the solver's answer and the drive's request, which also includes a
       * contact that merely REFUSED a sideways request — a mecanum strafing into a wall — and
       * "corrected" that by handing the commanded strafe back: the chassis sat against the
       * wall reporting 34 in/s sideways, the drive fed on that, and every tick the solver had
       * to stop it again from scratch while the penetration ratcheted. So only an EXCESS
       * counts: sideways motion beyond what was asked, in the direction the robot is already
       * going, or a reversal against it. Motion that fell short of the request was stopped
       * by a contact, and a contact is allowed to stop you.
       */
      let over = 0;
      let dir = 0;
      if (latV * latW > 0) {
        if (Math.abs(latV) > Math.abs(latW)) {
          over = Math.abs(latV) - Math.abs(latW) - w.latCap;
          dir = Math.sign(latV);
        }
      } else if (latV !== 0) {
        over = Math.abs(latV) - w.latCap;
        dir = Math.sign(latV);
      }
      if (over > 0) {
        const back = dir * over;
        vx += rs * back;
        vy -= rc * back;
      }
    }
    const speed = hyp(vx, vy);
    const scale = speed > C.PHYS_MAX_ROBOT_SPEED ? C.PHYS_MAX_ROBOT_SPEED / speed : 1;
    r.vel.x = vx * scale;
    r.vel.y = vy * scale;
    /**
     * THE SOLVER OWNS THE HEADING NOW. `updateRobot` used to integrate it, because a
     * rotation-locked body had no rotation to report; the drive arrives as a torque instead
     * and this reads back what the wheels and every contact did between them.
     *
     * The spin guard is the angular twin of `PHYS_MAX_ROBOT_SPEED` and is dead code in
     * ordinary play for the same reason: nothing on this field can legitimately spin a robot
     * past a few times its own top rate, so a larger number is the solver failing an
     * over-constrained contact rather than a hit anybody felt.
     */
    /**
     * The spin the solver worked out, guarded only against its own explosions. The tyres have
     * already had their say — four lateral traction forces went INTO this solve (see the wheel
     * loop in `updateRobot`), so a contact that spun the chassis anyway did it against grip
     * that was resisting at the time, which is the whole point of slice B.
     */
    const av = body.angvel();
    /**
     * ...AND WHAT THE CONTACTS DID, kept for the wheels to resist next tick.
     *
     * The drive asked for `wantX/wantY/wantW`; anything else in the solver's answer arrived
     * through a contact. The per-wheel traction model in `updateRobot` turns this into four
     * lateral forces, each clipped to one tyre's grip — which is why a sustained lean is
     * refused outright and an impact is not.
     */
    r.slipX = w ? vx - w.wantX : 0;
    r.slipY = w ? vy - w.wantY : 0;
    r.slipW = w ? av - w.wantW : 0;
    r.angVel = clamp(av, -C.PHYS_MAX_ROBOT_SPIN, C.PHYS_MAX_ROBOT_SPIN);
    /**
     * THE HEADING IS INTEGRATED FROM THAT, NOT READ OFF THE BODY.
     *
     * `body.rotation()` carries Rapier's positional PENETRATION CORRECTION as well as the
     * motion — a bias applied straight to the pose, with no angular velocity behind it — and
     * that is not a rotation anything did. A robot placed a hair inside the gate stub, idle,
     * with `angvel` reading 0.0000 the whole time, was quietly turned 7.2° by it. The tyres'
     * refusal above governs the rotation, so the heading follows the rotation it governs.
     */
    r.heading = wrapAngle(r.heading + r.angVel * dt);
  }

  rw.free();
  return preVels;
}

/**
 * COLLISION GROUPS. Rapier packs these as `(membership << 16) | filter`, and two colliders
 * interact only if each one's membership is in the other's filter — BOTH directions have to
 * agree, which is why everything here names a membership of its own rather than the default
 * "member of everything".
 *
 * ROBOT solve:
 *  · FOOT — a robot's footprint (chassis + intake reach). Meets the field and other footprints.
 *  · STAT — walls, goal faces, classifier, gate handles. Meet footprints.
 *  · CSOL — a robot's artifact-solid geometry (chassis + intake structure + held artifacts, the
 *    mouth open). Meets PINNED artifacts and nothing else.
 *  · PIN  — a pinned artifact, as a fixed circle. Meets CSOL and nothing else.
 *
 * ARTIFACT solve — every robot is an immovable sweep here, so robot-robot and robot-field pairs
 * never arise; the bits exist to state two exclusions:
 *  · an artifact the INTAKE has hold of (CLAIMED) does not meet the CHASSIS of the claiming
 *    robot, because the funnel is drawing it onto the chassis face and the two would fight
 *    (measured 1.45s to swallow one 7in off-centre against 0.33s). It still meets the intake's
 *    structure, which is what guides it in.
 *  · the artifact a gate is EXPELLING into an occupied mouth (DOOR) does not meet the HELD
 *    artifacts, or a full hopper would plug the outflow for as long as the robot stood there.
 *    It still meets the chassis: excluding that let it travel straight through a robot.
 */
const R_FOOT = 0x0001_0003;
const R_STAT = 0x0002_0001;
const R_CSOL = 0x0004_0008;
const R_PIN = 0x0008_0004;

const A_LOOSE = 0x0001;
const A_CLAIMED = 0x0002;
const A_CHASSIS = 0x0004;
const A_FIELD = 0x0008;
const A_STRUCT = 0x0010;
const A_HELD = 0x0020;
const A_DOOR = 0x0040;
const A_BALLS = A_LOOSE | A_CLAIMED | A_DOOR;
const groups = (membership: number, filter: number): number => (membership << 16) | filter;

/** a Rapier collider for one artifact-solid shape, in the parent body's frame */
function solidDesc(sh: SolidShape): RAPIER.ColliderDesc | null {
  if (sh.kind === 'box') return RAPIER.ColliderDesc.cuboid(sh.hx, sh.hy).setTranslation(sh.cx, sh.cy);
  if (sh.kind === 'circle') return RAPIER.ColliderDesc.ball(sh.r).setTranslation(sh.cx, sh.cy);
  const flat = new Float32Array(sh.pts.length * 2);
  sh.pts.forEach((p, i) => {
    flat[2 * i] = p.x;
    flat[2 * i + 1] = p.y;
  });
  return RAPIER.ColliderDesc.convexHull(flat);
}

/** where a robot's sweep began this tick, for the artifact solve */
export interface SweepFrom {
  x: number;
  y: number;
  heading: number;
}

/**
 * Resolve GROUND-artifact translation + velocity for one tick: light circle bodies against
 * the static field and against every robot's artifact-solid geometry, with each robot an
 * IMMOVABLE SWEEP from where it began the tick to where the robot solve put it.
 *
 * THE ROBOT IS KINEMATIC HERE, ON PURPOSE, AND THAT IS THE WHOLE DESIGN. Its position was
 * decided by the robot solve, which owns walls, other robots, the gate handle, the perimeter
 * invariant — and any artifact that turned out to be pinned. Nothing in this solve may move it,
 * so there is no second answer to reconcile: an artifact that can get out of the way is pushed
 * out of the way at the robot's own speed, and one that cannot is reported back
 * (`pinnedArtifacts`) so the ROBOT solve can be re-run with it as a wall. Product decision #7
 * ("outflow cannot shove a parked robot") falls out for free: a kinematic body is pushed by
 * nothing.
 *
 * A POSITION-BASED kinematic body, from the START pose to the END pose, rather than a body
 * placed at the end pose. Placed at the end it is already overlapping whatever it drove into,
 * and the only thing acting on that artifact is penetration recovery, which is soft and slow
 * by design — that is where "the balls go on top of the robot" came from. Swept, the contact
 * happens at the surface: Rapier derives the sweep velocity from the two poses, the
 * speculative contact (`PHYS_BALL_PREDICTION`) exists before the pair touch, and the artifact
 * is pushed ahead of the chassis with the chassis's own velocity.
 *
 * This is the ONLY writer of a ground artifact's position. There is no clamp, no relaxation
 * pass, no eviction and no revert after it; the field, the classifier, the goal faces and every
 * robot are colliders in the same solve, so there is nothing left to take turns with.
 */
export function solveArtifacts(
  world: World,
  dt: number,
  colliders: FieldColliders,
  /** artifacts the intake has hold of — allowed onto the claiming chassis's face */
  claimed: ReadonlySet<number>,
  /** the artifact each gate is expelling — allowed past a robot's held artifacts */
  doorway: ReadonlySet<number>,
  solids: ReadonlyMap<number, RobotSolids>,
  from: ReadonlyMap<number, SweepFrom>,
): void {
  const groundBalls = world.balls.filter((b) => b.state.kind === 'ground');
  if (groundBalls.length === 0) return;

  const rw = makeWorld(
    dt,
    colliders,
    C.PHYS_BALL_CONTACT_FREQ,
    C.PHYS_BALL_ALLOWED_ERROR,
    groups(A_FIELD, A_BALLS),
    C.PHYS_BALL_WALL_FRICTION,
  );
  rw.integrationParameters.normalizedPredictionDistance = C.PHYS_BALL_PREDICTION;

  const ballBodies: { b: Artifact; body: RAPIER.RigidBody }[] = [];
  for (const b of groundBalls) {
    const body = rw.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(b.pos.x, b.pos.y)
        .lockRotations()
        .setLinvel(b.vel.x, b.vel.y),
    );
    const isClaimed = claimed.has(b.id);
    const isDoor = doorway.has(b.id);
    const membership = (isClaimed ? A_CLAIMED : A_LOOSE) | (isDoor ? A_DOOR : 0);
    const filter =
      A_BALLS | A_FIELD | A_STRUCT | (isClaimed ? 0 : A_CHASSIS) | (isDoor ? 0 : A_HELD);
    rw.createCollider(
      RAPIER.ColliderDesc.ball(C.BALL_RADIUS)
        .setMass(C.BALL_MASS)
        .setRestitution(C.BALL_BALL_RESTITUTION)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setCollisionGroups(groups(membership, filter))
        .setFriction(C.PHYS_BALL_FRICTION),
      body,
    );
    ballBodies.push({ b, body });
  }

  // ...then the robots, AFTER the artifacts so the artifact collider creation order is
  // untouched (Rapier resolution depends on it, and replays re-sim through this)
  for (const r of world.robots) {
    const f = from.get(r.id) ?? { x: r.pos.x, y: r.pos.y, heading: r.heading };
    const body = rw.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(f.x, f.y).setRotation(f.heading),
    );
    // the sweep: Rapier derives the velocity from these two poses. The rotation is handed
    // over as the SHORTEST turn from the start heading, or a wrap at ±π reads as a full spin.
    body.setNextKinematicTranslation({ x: r.pos.x, y: r.pos.y });
    body.setNextKinematicRotation(f.heading + wrapAngle(r.heading - f.heading));
    const sol = solids.get(r.id);
    if (!sol) continue;
    const add = (sh: SolidShape, membership: number, filter: number, friction: number) => {
      const d = solidDesc(sh);
      if (!d) return;
      rw.createCollider(
        d.setRestitution(C.BALL_ROBOT_RESTITUTION)
          .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
          .setFriction(friction)
          .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
          .setCollisionGroups(groups(membership, filter)),
        body,
      );
    };
    add(sol.chassis, A_CHASSIS, A_LOOSE | A_DOOR, C.PHYS_BALL_FRICTION);
    // the intake's slopes and rails GUIDE an artifact toward the throat; the rollers are
    // compliant wheels, not a brake, so what slides along them is barely held back
    for (const sh of sol.structure) add(sh, A_STRUCT, A_BALLS, C.INTAKE_STRUCT_FRICTION);
    for (const sh of sol.held) add(sh, A_HELD, A_LOOSE | A_CLAIMED, C.INTAKE_STRUCT_FRICTION);
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

export interface PinnedReport {
  /** artifacts still inside a robot's solid geometry after the artifact solve — the ones that
   *  could not get out of the way. In id order. */
  pinned: Artifact[];
  /** artifacts whose CENTRE is inside a robot — not a contact, a misplacement (a state
   *  transition put it there). The caller evicts these once, geometrically. */
  buried: { b: Artifact; r: RobotState; nx: number; ny: number; pen: number }[];
}

/**
 * Is there something IMMOVABLE behind this artifact — the field, a second robot, or a chain of
 * artifacts that ends at one? A pinned artifact stays pinned only while there is. A free clump
 * is not support: a robot pushing artifacts across open floor pushes them, and the moment the
 * front one was called pinned because it touched the one behind it, the robot could push
 * nothing at all (measured: every open-floor herding scene went to zero fouls).
 */
function supported(world: World, b: Artifact, by: RobotState, solids: ReadonlyMap<number, RobotSolids>): boolean {
  const eps = C.ARTIFACT_PIN_SUPPORT;
  const nearStatic = (p: Vec2): boolean => {
    const c = clampBallPosToStatics(p);
    if (c.x !== p.x || c.y !== p.y) return true;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const q = { x: p.x + dcos(a) * eps, y: p.y + dsin(a) * eps };
      const r = clampBallPosToStatics(q);
      if (r.x !== q.x || r.y !== q.y) return true;
    }
    return false;
  };
  const nearOtherRobot = (p: Vec2): boolean => {
    for (const r of world.robots) {
      if (r === by) continue;
      const sol = solids.get(r.id);
      if (!sol) continue;
      const q = robotPenetration(r, sol, p, C.BALL_RADIUS, false, false, -eps);
      if (q && q.pen > -eps) return true;
    }
    return false;
  };
  // breadth-first over touching artifacts, in id order (deterministic), looking for one that
  // rests on the field or on another robot
  const seen = new Set<number>([b.id]);
  const queue: Artifact[] = [b];
  const touch = 2 * C.BALL_RADIUS + eps;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (nearStatic(cur.pos) || nearOtherRobot(cur.pos)) return true;
    for (const o of world.balls) {
      if (o.state.kind !== 'ground' || seen.has(o.id)) continue;
      if (hyp(o.pos.x - cur.pos.x, o.pos.y - cur.pos.y) < touch) {
        seen.add(o.id);
        queue.push(o);
      }
    }
  }
  return false;
}

/**
 * Which ground artifacts the artifact solve could NOT get out of a robot's way — measured on
 * the poses the two solves left, against the same geometry both solves used.
 *
 * The ordering is the whole argument: the artifact solve has just moved every artifact that
 * could move, so anything still inside a robot by more than the solver's own resting slop is
 * one that could not — it is against a wall, a corner, another robot, or a pile that is. No
 * probe, no prediction of which way the robot meant to push.
 *
 * WITH HYSTERESIS. An artifact enters the set by being overlapped (`ARTIFACT_PIN_SLOP`) and
 * leaves it only when the robot has backed clear of it (`ARTIFACT_PIN_RELEASE`) or whatever
 * was behind it has gone. Without that a robot LEANING on a pinned artifact rests a hair
 * outside it — the pinned circle is inflated by the robot world's own slop — so the next tick
 * finds no overlap, drops the pin, lets the robot advance a hair, finds the overlap again, and
 * the pair creep into the wall together at a tick's advance per two ticks: measured, 0.1in of
 * wall penetration on an artifact under a robot doing nothing but holding forward.
 */
export function pinnedArtifacts(
  world: World,
  claimed: ReadonlySet<number>,
  doorway: ReadonlySet<number>,
  solids: ReadonlyMap<number, RobotSolids>,
  /** artifacts already pinned (last tick's set, or this tick's earlier rounds): these stay
   *  pinned on the RELEASE threshold rather than the entry one */
  held: ReadonlySet<number>,
): PinnedReport {
  const out: PinnedReport = { pinned: [], buried: [] };
  for (const b of world.balls) {
    if (b.state.kind !== 'ground') continue;
    const keep = held.has(b.id);
    // a squeeze the solve could not satisfy is split between the two things squeezing, so
    // what the artifact is still inside of the FIELD counts toward the pin too
    const cl = clampBallPosToStatics(b.pos);
    const inField = hyp(cl.x - b.pos.x, cl.y - b.pos.y);
    let isPinned = false;
    for (const r of world.robots) {
      const sol = solids.get(r.id);
      if (!sol) continue;
      const q = robotPenetration(r, sol, b.pos, C.BALL_RADIUS, claimed.has(b.id), doorway.has(b.id), -C.ARTIFACT_PIN_RELEASE);
      if (!q) continue;
      if (q.pen > C.ARTIFACT_PIN_SLOP && q.buried) {
        out.buried.push({ b, r, nx: q.nx, ny: q.ny, pen: q.pen });
        continue;
      }
      if (q.pen > 0 && q.pen + inField > C.ARTIFACT_PIN_SLOP) isPinned = true;
      else if (keep && q.pen > -C.ARTIFACT_PIN_RELEASE && supported(world, b, r, solids)) isPinned = true;
    }
    if (isPinned) out.pinned.push(b);
  }
  return out;
}
