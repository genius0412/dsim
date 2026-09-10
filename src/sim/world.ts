import type { Alliance, Artifact, RobotCommand, RobotState, Vec2, World } from '../types';
import * as C from '../config';
import {
  clampBallPosToStatics,
  collideBallBall,
  collideBallRect,
  bounceFirstContacts,
  clumpDrag,
  collideBallRobot,
  landOnIntakeLid,
  collideBallStatic,
  scatterBalls,
  squareUpRobots,
  stepFlightBall,
  stepGroundBall,
  heldSlotPos,
} from './physics';
import { rot, approach, hyp } from '../math';
import { fieldPushback, pinnedArtifacts, solveArtifacts, solveRobots, type PinnedCircle, type SweepFrom } from './physicsEngine';
import { robotPenetration, robotSolids, type RobotSolids } from './artifactSolids';
import { decodeColliders } from '../games/decode/colliders';
import { classifierRect } from './field';
import { intakeClaims, intakeSuction, updateRobot, updateRobotActions, type DriveWrench } from './robot';
import { driveParams } from './drivetrain';
import { checkGoalEntry, doorwayArtifact, gateColliderPos, updateBasins, updateGates, updateRails } from './goal';
import { updateHumanPlayers } from './humanPlayer';
import { robotsEnabled, stepMatch } from './match';
import { updateProvisionalPattern } from './scoring';
import { updatePenalties } from './penalties';
import { initializePathTraversal, updatePathTraversal } from './pathTraversal';

const ZERO_CMD: RobotCommand = {
  driveX: 0,
  driveY: 0,
  rotate: 0,
  leftDrive: 0,
  rightDrive: 0,
  intake: false,
  fire: false,
};

/** everything the robot solve writes, so a round can be re-run from the same start */
interface RobotSnapshot {
  r: RobotState;
  pos: Vec2;
  vel: Vec2;
  heading: number;
  angVel: number;
  slipX: number | undefined;
  slipY: number | undefined;
  slipW: number | undefined;
}

function snapshotRobots(world: World): RobotSnapshot[] {
  return world.robots.map((r) => ({
    r,
    pos: { x: r.pos.x, y: r.pos.y },
    vel: { x: r.vel.x, y: r.vel.y },
    heading: r.heading,
    angVel: r.angVel,
    slipX: r.slipX,
    slipY: r.slipY,
    slipW: r.slipW,
  }));
}

function restoreRobots(snap: RobotSnapshot[]): void {
  for (const s of snap) {
    s.r.pos = { x: s.pos.x, y: s.pos.y };
    s.r.vel = { x: s.vel.x, y: s.vel.y };
    s.r.heading = s.heading;
    s.r.angVel = s.angVel;
    s.r.slipX = s.slipX;
    s.r.slipY = s.slipY;
    s.r.slipW = s.slipW;
  }
}

/**
 * Put a ground artifact somewhere it can be — once, at a STATE TRANSITION.
 *
 * The artifact solve is the only thing that moves a ground artifact, and it can only move
 * one that began the tick outside every solid. A flight artifact that lands inside a chassis
 * (its arc never asked), or one the rail released where a robot has since arrived, would
 * otherwise start its ground life with its centre inside a solid, where no contact normal is
 * honest. So the moment an artifact BECOMES ground it is walked out of any robot and any
 * static it is inside, along the shortest way out. This is a placement, not a pass: it runs
 * once per artifact per transition and never on a resting one.
 */
export function placeGroundArtifact(world: World, b: Artifact, solids: ReadonlyMap<number, RobotSolids>): void {
  for (let i = 0; i < 3; i++) {
    let moved = false;
    for (const r of world.robots) {
      const sol = solids.get(r.id);
      if (!sol) continue;
      const q = robotPenetration(r, sol, b.pos, C.BALL_RADIUS);
      if (!q || q.pen <= 0) continue;
      b.pos.x += q.nx * q.pen;
      b.pos.y += q.ny * q.pen;
      moved = true;
    }
    const c = clampBallPosToStatics(b.pos);
    if (c.x !== b.pos.x || c.y !== b.pos.y) {
      b.pos.x = c.x;
      b.pos.y = c.y;
      moved = true;
    }
    if (!moved) return;
  }
}

/** how many rounds the last tick's two-solve loop ran — a diagnostic for tests, not state */
export let lastTickRounds = 0;

/** advance the world by one fixed timestep. Deterministic: consumes only the
 * given commands and the world's own seeded PRNG. */
export function step(world: World, dt: number, commands: Map<number, RobotCommand>): void {
  world.time += dt;
  world.tick++;

  const enabled = robotsEnabled(world);

  // Create a map for the actual commands being executed by each robot this tick
  const actualCommands = new Map<number, RobotCommand>();
  // where each robot's motion began this tick — the artifact solve sweeps it from here
  const sweepFrom = new Map<number, SweepFrom>();

  for (const r of world.robots) {
    sweepFrom.set(r.id, { x: r.pos.x, y: r.pos.y, heading: r.heading });
    let currentCmd = enabled ? (commands.get(r.id) ?? ZERO_CMD) : ZERO_CMD;

    // Auto pathing logic: if active, override driver commands
    if (world.match.phase === 'auto' && r.autoPathActive) {
      // Use r.autoPath directly, which is already mirrored if necessary
      if (r.autoPath) {
        // Initialize auto path once at the very beginning of the auto phase
        if (
          r.pathSequenceIndex === 0 &&
          r.pathSegmentProgress === 0 &&
          r.pathWaitTimer === 0
        ) {
          initializePathTraversal(r);
        }
        // Update robot's position and heading directly via path traversal
        // Capture the command returned by updatePathTraversal, which now includes intake/fire states.
        const wasAt = { x: r.pos.x, y: r.pos.y };
        currentCmd = updatePathTraversal(r, world, dt);
        /**
         * ...AND `vel` IS THE SWEEP IT JUST MADE, not zero.
         *
         * The path TELEPORTS the chassis (1.56 in/tick at the default spec), and the velocity
         * used to be zeroed here on the reasoning that physics must not move a path robot from
         * its old velocity. Physics no longer can — the body is KINEMATIC now — but the solver
         * still needs to know it is moving, or the only thing acting on whatever is in its way
         * is the soft positional correction, which cannot keep up with a teleport. Measured
         * with the velocity zeroed: overlap grew monotonically to 15.2 in on an 17.5 in pair
         * until the SAT min axis flipped and the bystander was squirted 4 in sideways and 3 in
         * backwards, after which the path robot passed straight through it. With the sweep
         * velocity set, peak penetration is 0.00 in and the bystander is pushed along.
         *
         * A JUMP IS NOT A SWEEP. `initializePathTraversal` places the chassis on the path's
         * start point, and a sequence can step between segments that do not touch — both are
         * teleports of arbitrary size, and dividing one by `dt` gives thousands of in/s that
         * would fire everything nearby across the field (measured: the initial placement alone
         * blasted a bystander 60 in). A displacement the robot could not have driven is not
         * motion this model can represent, so it reports none. The margin is slack for a path
         * whose nominal speed sits a hair above the drivetrain's own.
         */
        const swept = { x: (r.pos.x - wasAt.x) / dt, y: (r.pos.y - wasAt.y) / dt };
        const walkable = driveParams(r.spec, r.butterflyTank).maxSpeed * 1.5;
        const isSweep = hyp(swept.x, swept.y) <= walkable;
        r.vel = isSweep ? swept : { x: 0, y: 0 };
        r.angVel = 0;
        // a jump is not a sweep for the artifact solve either: it starts where the jump ended
        if (!isSweep) sweepFrom.set(r.id, { x: r.pos.x, y: r.pos.y, heading: r.heading });
      } else {
        // If autoPathActive was true but no path data found in robot, deactivate
        r.autoPathActive = false;
      }
    }
    actualCommands.set(r.id, currentCmd);
  }

  // ---- ground artifacts: the velocity-only pre-passes ----------------------
  // Rolling friction + rest snap, the bounce of any impact that will land this tick (the
  // solver's speculative contacts carry none), and the kick that separates two artifacts on one
  // point. Velocities only: the artifact solve below is the ONLY thing that moves a ground
  // artifact, and these are what it starts from.
  const ground = world.balls.filter((b) => b.state.kind === 'ground');
  for (const b of ground) stepGroundBall(b, dt);
  bounceFirstContacts(ground, dt);
  for (let i = 0; i < ground.length; i++) {
    for (let j = i + 1; j < ground.length; j++) scatterBalls(ground[i], ground[j], world.time);
  }
  // ...and the ONE robot-side feel term, a damper on the speed a robot arrives at a clump
  // with. It runs BEFORE the drive so the wrench is built on the damped velocity and the
  // tyres never read it as slip — see `clumpDrag`, which also explains why it is kept.
  // the robot solids are what every artifact pass measures against, so they are built once,
  // here, and handed to the drag, the pin test and both solves
  const heldBalls = world.balls.filter((b) => b.state.kind === 'held');
  const solids = new Map<number, RobotSolids>();
  for (const r of world.robots) solids.set(r.id, robotSolids(r, heldBalls));
  for (const b of ground) {
    for (const r of world.robots) if (!r.autoPathActive) clumpDrag(b, r, solids.get(r.id)!);
  }

  // ...and the intake's pull on whatever is in its mouth, which the solve then answers
  // (see : written after the solve it was a velocity the artifact never had)
  for (const r of world.robots) {
    if (r.passive) continue;
    intakeSuction(world, r, actualCommands.get(r.id) ?? ZERO_CMD);
  }

  // ---- robots (movement) -------------------------------------------------
  // The drive model no longer writes velocity: it returns the FORCE the wheels are asking
  // for and the solve below applies it (see `updateRobot`). A robot on an auto path is
  // posed by the path and asks for nothing.
  const drive = new Map<number, DriveWrench>();
  for (const r of world.robots) {
    if (!r.autoPathActive) {
      drive.set(r.id, updateRobot(world, r, actualCommands.get(r.id) ?? ZERO_CMD, dt));
    }
  }

  // anticipate this tick's gate-arm lift so the handle collider retracts on the SAME
  // tick a robot rams it open (no 1-tick jolt) — updateGates applies the matching lift.
  const gateCol: Record<Alliance, number> = {
    red: gateColliderPos(world, dt, actualCommands, 'red'),
    blue: gateColliderPos(world, dt, actualCommands, 'blue'),
  };
  // CLEARED HERE, NOT AT THE TOP OF THE TICK. The drive phase above reads `rrContacts` to
  // tell a robot being LEANED ON from one stopping itself (see `MOTOR_SHOVE_BRAKE`), and it
  // runs before the pass that records them — so the list has to survive the drive phase and
  // carry last tick's contacts into it. Nothing between the top of `step` and here reads it.
  world.rrContacts.length = 0;

  /**
   * THE TWO SOLVES, AND THE LOOP THAT MAKES THEM ONE.
   *
   * The robot solve decides where every robot ends up: walls, the gate handle, other robots,
   * the drive. Artifacts are not in it. The artifact solve then sweeps each robot from where
   * it began the tick to where the robot solve put it, as an immovable body, and moves every
   * artifact that can get out of its way. Whatever is STILL inside a robot afterwards is an
   * artifact that could not — it is against a wall, a corner, another robot, or a pile that
   * is — and that is the one thing the robot solve needed to know and did not.
   *
   * So the tick is put back to its start and the robot solve is re-run with those artifacts
   * as walls. The robot stops against them the way it stops against anything else, the
   * artifact solve runs again on the corrected motion, and if nothing new is pinned the tick
   * stands. Every element ends the tick somewhere it is allowed to be: the robot cannot
   * occupy an artifact's space, an artifact cannot occupy a robot's, a wall's, or another
   * artifact's, and nothing has been written by hand to make it so. There is no configuration
   * with nowhere to go, because the one body that can yield — the robot — is the one made to.
   *
   * Almost every tick runs once. A robot leaning on a pinned artifact re-finds it and runs
   * twice, which is what `ARTIFACT_PIN_SLOP` explains. The set of pinned artifacts can only
   * grow within a tick, so the loop converges; `PHYS_PIN_ROUNDS` is a cap, not the count.
   */
  const claimed = intakeClaims(world, actualCommands);
  const doorway = new Set<number>();
  for (const a of ['red', 'blue'] as const) {
    const d = doorwayArtifact(world, a);
    if (d) doorway.add(d.id);
  }

  const robotsAtStart = snapshotRobots(world);
  const ballsAtStart = ground.map((b) => ({ b, pos: { x: b.pos.x, y: b.pos.y }, vel: { x: b.vel.x, y: b.vel.y } }));
  /**
   * LAST TICK'S PINS SEED THIS TICK'S FIRST ROUND. A robot resting on a pinned artifact rests a
   * hair outside it (the pinned circle carries the robot world's own slop), so a tick that
   * started with no pins would let it advance that hair, re-find the pin, and re-solve — every
   * tick, creeping. The seed is filtered the same way the loop keeps a pin: still resting
   * against a robot, and still with something behind it. Everything else is re-derived.
   */
  const wasPinned = new Set(world.pinnedArtifacts ?? []);
  const pinnedIds = new Set<number>();
  if (wasPinned.size > 0) {
    for (const b of pinnedArtifacts(world, claimed, doorway, solids, wasPinned).pinned) {
      if (wasPinned.has(b.id)) pinnedIds.add(b.id);
    }
  }
  const startOf = new Map(ballsAtStart.map((s) => [s.b.id, s]));
  // where each pinned artifact began the tick, and the velocity it has: for the seed that is its
  // resting velocity from last tick; inside the loop it is what this round's artifact solve gave it
  const circles = (): PinnedCircle[] =>
    ground
      .filter((b) => pinnedIds.has(b.id))
      .map((b) => {
        const s = startOf.get(b.id)!;
        // a pinned ball at rest is a FIXED wall: the fraction of an inch a second the solver
        // leaves on a squeezed ball is not motion, and carried into the circle it walked a
        // robot stalled square on a wall ball 13 degrees off its heading in two seconds
        const moving = hyp(b.vel.x, b.vel.y) >= C.BALL_REST_SPEED;
        return { x: s.pos.x, y: s.pos.y, vx: moving ? b.vel.x : 0, vy: moving ? b.vel.y : 0 };
      });
  let pinned: PinnedCircle[] = circles();
  let preVels = new Map<number, Vec2>();
  let buried: ReturnType<typeof pinnedArtifacts>['buried'] = [];
  let finalPinned: number[] = [];
  for (let round = 0; round < C.PHYS_PIN_ROUNDS; round++) {
    lastTickRounds = round + 1;
    if (round > 0) {
      restoreRobots(robotsAtStart);
      /**
       * The artifacts go back to where they BEGAN the tick, but keep the VELOCITY the last round
       * gave them. Restoring the velocity too threw away the one thing the round had found out:
       * a ball squeezed a few degrees off square between a bumper and a wall squirts out along
       * the wall at 100+ in/s under the robot's push, and with the robot now stopped on its pin
       * the re-solve gave it 5-20 in/s instead — so the ball crept, the robot sat on it, and the
       * next tick did it all again ("artifacts act like they are fixed in place"). The velocity
       * is what the push did to the ball; the pin only decides how far the ROBOT gets to go.
       */
      for (const s of ballsAtStart) s.b.pos = { x: s.pos.x, y: s.pos.y };
    }
    preVels = solveRobots(world, dt, decodeColliders, gateCol, drive, pinned, solids);
    solveArtifacts(world, dt, decodeColliders, claimed, doorway, solids, sweepFrom);
    /**
     * THE FIELD IS AN INVARIANT FOR ARTIFACTS TOO, and it is held HERE, before the pin test —
     * the same shape as  for robots. The artifact solve holds the perimeter,
     * the goal faces and the classifier itself to within its resting slop; this only acts past
     * , which an honest contact never reaches. But a squeeze the solve could
     * not satisfy is split between BOTH things squeezing — an artifact swept into a wall by a
     * chassis came out 0.4in into the wall and 0.07in into the chassis, and a pin test that saw
     * only the chassis side missed it while a clamp run after the test then pushed the whole
     * 0.47in into the chassis where nothing would look again until next tick. Walking it out of
     * the field first puts the shortfall where the pin test measures it.
     */
    for (const b of ground) {
      const c = clampBallPosToStatics(b.pos);
      if (hyp(c.x - b.pos.x, c.y - b.pos.y) > C.BALL_CONTAIN_SLOP) {
        b.pos.x = c.x;
        b.pos.y = c.y;
      }
      /**
       * ...AND AN ARTIFACT ON THE FIELD HAS NO VELOCITY INTO IT. A ball squeezed between a
       * kinematic chassis and a static wall is between two things the solver cannot move, and
       * the compromise it leaves is a velocity into the wall — 58 in/s, measured — on a ball
       * whose position the clamp above has just put back on the wall. Carried into the pinned
       * circle that velocity told the robot solve the ball was leaving; carried into the next
       * tick it read as an impact and bounced the ball back off the wall at 29 in/s, and the
       * robot off the ball. The wall is an invariant for the velocity too: whatever the solve
       * left pointing into it is removed, and the sideways part — the squirt — is kept.
       */
      const u = fieldPushback(b.pos);
      if (u) {
        const into = b.vel.x * u.x + b.vel.y * u.y;
        if (into < 0) {
          b.vel.x -= into * u.x;
          b.vel.y -= into * u.y;
        }
      }
    }
    const found = pinnedArtifacts(world, claimed, doorway, solids, pinnedIds);
    buried = found.buried;
    finalPinned = found.pinned.map((b) => b.id);
    let grew = false;
    for (const b of found.pinned) {
      if (pinnedIds.has(b.id)) continue;
      pinnedIds.add(b.id);
      grew = true;
    }
    if (!grew) break;
    /**
     * The walls for the next round: the pinned artifacts where they BEGAN the tick, MOVING at
     * the velocity this round's artifact solve gave them. A ball that truly cannot move has
     * none, and is the fixed wall it always was. A ball squirting out of a squeeze — a few
     * degrees off square between a bumper and a wall, sliding along the wall at 100+ in/s — is
     * a wall that gets out of the way during the step, and the robot solve lets the robot
     * follow it. A fixed circle at either position deadlocked: it stopped the robot dead, the
     * restore threw the squirt away, and the next tick repeated it, the ball creeping at 5 in/s
     * under a robot parked on it.
     */
    pinned = circles();
  }
  world.pinnedArtifacts = finalPinned;
  /**
   * An artifact whose CENTRE ended inside a robot was never a contact — a state transition put
   * it there (a landing, a release) before the solve could see it, and the honest fix is the
   * placement rule, applied late: out along the nearest way, then back inside the field.
   */
  for (const q of buried) {
    q.b.pos.x += q.nx * q.pen;
    q.b.pos.y += q.ny * q.pen;
    placeGroundArtifact(world, q.b, solids);
  }
  // The bespoke square-up pass rotates tilted chassis flush and records the robot-robot
  // contacts (rrContacts) the penalty engine consumes.
  squareUpRobots(world, preVels);

  // ---- robots (actions: intake/fire/turret) ------------------------------
  // passive dummies never act — skip the aim solve / flywheel / fire / intake work
  for (const r of world.robots) {
    if (r.passive) continue;
    updateRobotActions(world, r, actualCommands.get(r.id) ?? ZERO_CMD, dt);
  }

  // ---- penalties: rrContacts + final robot poses are settled for this tick -
  updatePenalties(world, dt, actualCommands);

  // ---- balls: FLIGHT (ground balls resolved above) -------------------------
  // Flight stays bespoke: ballistic arc + z axis (Rapier 2D has no z), goal-face
  // bounce below the lip, and the ground-bounce landing transition. A ball that
  // lands becomes 'ground' and joins the ground solve next tick.
  for (const b of world.balls) {
    if (b.state.kind !== 'flight') continue;
    const prevZ = b.z;
    stepFlightBall(b, dt);
    if (checkGoalEntry(world, b, prevZ)) continue;
    // ...and it does not fall THROUGH an intake on the way down. The mouth is open at ball
    // height so an artifact can roll in under the rollers; from above, the rollers are in
    // the way. Without this an artifact dropped on the intake landed inside the throat and
    // was swallowed — which is not a thing an intake can do.
    for (const r of world.robots) if (landOnIntakeLid(b, r, prevZ)) break;
    if (b.z < C.GOAL_WALL_TOP) collideBallStatic(b);
    if (b.z <= 0 && b.vz < 0) {
      b.z = 0;
      b.vz = -b.vz * C.BALL_GROUND_RESTITUTION;
      b.vel.x *= C.BALL_BOUNCE_H_RETAIN;
      b.vel.y *= C.BALL_BOUNCE_H_RETAIN;
      if (b.vz < 20) {
        b.vz = 0;
        b.state = { kind: 'ground' };
        // it lands where its arc ended — unless that is inside something (see the placement)
        placeGroundArtifact(world, b, solids);
      }
    }
  }

  // low flight balls collide bespoke with robots + other low flight balls (rare
  // — the shooter never misses, so a shot is almost never near a robot in the
  // plane). Ground balls are Rapier bodies and handled there; a flight↔ground
  // cross-collision is the accepted deferral of the ground-only slice.
  const activeFlight = world.balls.filter(
    (b) => b.state.kind === 'flight' && b.z < C.BALL_RADIUS * 4,
  );
  for (let pass = 0; pass < C.BALL_SOLVER_ITERATIONS; pass++) {
    for (let i = 0; i < activeFlight.length; i++) {
      for (let j = i + 1; j < activeFlight.length; j++) {
        collideBallBall(activeFlight[i], activeFlight[j]);
      }
    }
    for (const b of activeFlight) {
      if (b.z > C.ROBOT_HEIGHT) continue;
      for (const r of world.robots) collideBallRobot(b, r);
    }
  }
  for (const b of activeFlight) {
    if (b.z > C.CLASSIFIER_HEIGHT) continue;
    collideBallRect(b, classifierRect('red'));
    collideBallRect(b, classifierRect('blue'));
  }
  for (const b of activeFlight) collideBallStatic(b);

  // ---- goals: basin jumble, rail flow, gate ---------------------------------
  updateGates(world, dt, actualCommands);
  updateBasins(world, dt);
  updateRails(world, dt, actualCommands);
  updateHumanPlayers(world);

  // ---- match flow ----------------------------------------------------------
  stepMatch(world, dt);
  updateProvisionalPattern(world);

  // ---- held balls: slide each captured ball toward its storage slot ----------
  positionHeldBalls(world, dt);
}

/** Park each HELD ball at its robot's storage slot, moving rigidly WITH the robot
 * but SLIDING (in the robot frame) toward its slot — so the triangle's front ball
 * slides aside when a 3rd arrives. A held ball whose robot is gone drops to the floor. */
function positionHeldBalls(world: World, dt: number): void {
  for (const b of world.balls) {
    if (b.state.kind !== 'held') continue;
    const st = b.state;
    const r = world.robots.find((rr) => rr.id === st.robot);
    if (!r) {
      b.state = { kind: 'ground' };
      continue;
    }
    // slide the STORED local offset toward the slot (no world round-trip, so the
    // ball tracks the robot rigidly — no lag when it drives)
    const target = heldSlotPos(r.spec, st.slot, st.side);
    st.lx = approach(st.lx, target.x, C.HELD_SLIDE_SPEED * dt);
    st.ly = approach(st.ly, target.y, C.HELD_SLIDE_SPEED * dt);
    const wp = rot({ x: st.lx, y: st.ly }, r.heading);
    b.pos = { x: r.pos.x + wp.x, y: r.pos.y + wp.y };
    b.vel = { x: r.vel.x, y: r.vel.y };
    b.z = 0;
    b.vz = 0;
  }
}
