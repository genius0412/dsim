import type { Alliance, Artifact, RobotCommand, RobotState, Vec2, World } from '../types';
import * as C from '../config';
import {
  clampBallPosToStatics,
  collideBallBall,
  collideBallRect,
  bounceFirstContacts,
  clumpDrag,
  driveIntent,
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
  let seedReport: ReturnType<typeof pinnedArtifacts> | null = null;
  if (wasPinned.size > 0) {
    seedReport = pinnedArtifacts(world, claimed, doorway, solids, wasPinned);
    for (const b of seedReport.pinned) {
      if (wasPinned.has(b.id)) pinnedIds.add(b.id);
    }
  }
  const startOf = new Map(ballsAtStart.map((s) => [s.b.id, s]));
  const robotStartOf = new Map(robotsAtStart.map((s) => [s.r.id, s]));
  /**
   * THE PINNED CIRCLES, built from the pin report: where each pinned artifact began the tick, the
   * velocity it has, and a radius chosen so that A PIN MAY UNDO THE ROBOT'S OWN ADVANCE AND
   * NOTHING MORE.
   *
   * The circle is sized against the robot's START pose and every one of its solids: tangent to
   * the nearest solid, plus `PHYS_PIN_INFLATE` only for a robot PUSHING it (`pushingPin` — the
   * drive intent along the pin normal), capped at the full inflated ball. So a robot that drove
   * into a pinned ball this tick is re-solved from where it started and stops at the inflation
   * (which keeps it clear of the robot world's own slop), and a robot not driving at the ball is
   * not pushed at all, however deep a ball buried itself in it. Before this the circle was
   * always the full inflated ball, and a drain rolling onto a parked intake shoved it 0.8in
   * ("when gate intaking, the balls that come down should not be pushing the robot away"). The
   * circle MOVES only when the robot is pushing the ball, and then only across or away from the
   * robot: the component pointing at the robot's centre is the ball's own motion and is dropped;
   * what is left is the squirt, and the robot may follow it.
   *
   * A pinned ball at rest is a FIXED wall: the fraction of an inch a second the solver leaves on
   * a squeezed ball is not motion, and carried into the circle it walked a robot stalled square
   * on a wall ball 13 degrees off its heading in two seconds.
   */
  /**
   * Is the robot PUSHING this pinned artifact — driving into it, by its command, along the
   * robot→artifact normal? Not "did it advance": a robot stopped on its pin has no advance and
   * was still driving, and reading that as not-pushing froze the squirt it was driving (the
   * flat-back squeeze went from 50in along the wall to 5). The drive intent is what a driver
   * means; a parked intake with the drain arriving on it means nothing, whatever hits it.
   */
  const pushingPin = (pin: { r: RobotState; nx: number; ny: number }): boolean => {
    const intent = driveIntent(pin.r, actualCommands.get(pin.r.id));
    return intent.x * pin.nx + intent.y * pin.ny > C.ARTIFACT_PIN_DRIVE;
  };
  const circles = (pins: ReadonlyMap<number, { r: RobotState; pen: number; nx: number; ny: number }>): PinnedCircle[] =>
    ground
      .filter((b) => pinnedIds.has(b.id))
      .map((b) => {
        const s = startOf.get(b.id)!;
        const pin = pins.get(b.id);
        let vx = 0;
        let vy = 0;
        let radius = C.BALL_RADIUS + C.PHYS_PIN_INFLATE;
        if (pin) {
          /**
           * Sized against the robot's START pose and EVERY one of its solids — the pin test
           * skips the held artifacts for the doorway ball and the chassis for a claimed one, but
           * the robot solve's colliders skip nothing, and a circle tangent to the wrong shape
           * overlapped the right one and crept a parked intake back 0.3in over a drain. The
           * circle is the full inflated ball where the robot has at least the inflation of room
           * to drive in, and tangent to the nearest solid where it does not: a robot that drove
           * into a pinned ball this tick is re-solved from where it started and stops at the
           * inflation (no forming-tick overshoot), and a robot standing still is not moved.
           */
          const snap = robotStartOf.get(pin.r.id);
          const rStart: RobotState = snap ? { ...pin.r, pos: snap.pos, heading: snap.heading } : pin.r;
          const sol = solids.get(pin.r.id);
          const q0 = sol ? robotPenetration(rStart, sol, s.pos, C.BALL_RADIUS, false, false, -10) : null;
          const penStart = q0 ? q0.pen : -Infinity;
          /**
           * The inflation belongs to a robot DRIVING into the pin: it is what the robot world's
           * soft contact compresses under the drive force (0.14in at full throttle), so without
           * it a tangent circle re-sized each tick to the compressed pose let the robot creep
           * into the ball 0.14in a tick and the ball 0.2in into the wall. A robot not driving
           * toward the ball has nothing compressing it and gets the tangent circle: it is never
           * moved, however the ball arrived.
           */
          const pushing = pushingPin(pin);
          radius = Math.min(C.BALL_RADIUS + C.PHYS_PIN_INFLATE, C.BALL_RADIUS - penStart + (pushing ? C.PHYS_PIN_INFLATE : 0));
          // ...and it MOVES only when the robot is the one pushing it: a ball's velocity is the
          // robot's doing only if the robot is driving into it. A parked intake with the drain
          // arriving on it is not, and a moving circle beside its held artifacts found something
          // to shove whichever way it was clipped (0.4in over a drain); a fixed circle tangent to
          // the chassis cannot
          if (pushing && hyp(b.vel.x, b.vel.y) >= C.BALL_REST_SPEED) {
            // "into the robot" is toward its CENTRE, not along the one contact normal the pin
            // test reported: a ball against a HELD artifact at the mouth's edge has a diagonal
            // normal, and what was left after dropping that component still ran into the
            // chassis face and shoved a parked intake back at 24 in/s
            const ox = b.pos.x - pin.r.pos.x;
            const oy = b.pos.y - pin.r.pos.y;
            const ol = hyp(ox, oy) || 1;
            const into = (b.vel.x * ox + b.vel.y * oy) / ol; // < 0: toward the robot
            vx = b.vel.x - (Math.min(0, into) * ox) / ol;
            vy = b.vel.y - (Math.min(0, into) * oy) / ol;
          }
        }
        return { x: s.pos.x, y: s.pos.y, vx, vy, r: Math.max(radius, 0.1) };
      });
  let pinned: PinnedCircle[] = circles(seedReport?.pins ?? new Map());
  let preVels = new Map<number, Vec2>();
  let buried: ReturnType<typeof pinnedArtifacts>['buried'] = [];
  let finalPinned: number[] = [];
  let lastPins: ReadonlyMap<number, { r: RobotState; pen: number; nx: number; ny: number }> = seedReport?.pins ?? new Map();
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
      /**
       * (Only the field. The same clip against a ROBOT the ball touches was tried and removed: it
       * projected along the one contact normal the pin test reports, which in a funnel throat is
       * a wedge slope's diagonal, so a compromise velocity pointing at the robot came out as a
       * sideways drift — a dead-centre wall ball crept 6.7in along the wall under a stalled robot
       * and a squeezed artifact jittered at 40 Hz. The solver's compromise on a ball squeezed
       * against a chassis stays where it is harmless: the pinned circle ignores it unless the
       * robot is pushing, and the field clip catches the part that would bounce.)
       */
    }
    const found = pinnedArtifacts(world, claimed, doorway, solids, pinnedIds);
    buried = found.buried;
    finalPinned = found.pinned.map((b) => b.id);
    lastPins = found.pins;
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
    pinned = circles(found.pins);
  }
  world.pinnedArtifacts = finalPinned;
  /**
   * A PINNED ARTIFACT UNDER A ROBOT THAT IS NOT PUSHING IT IS WHERE IT WAS. Squeezed between a
   * kinematic chassis and the field the solver has no answer it can settle on — position or
   * velocity — and what it leaves alternates sign: an artifact under a robot parked 1.25in onto
   * the human-player column jittered 0.19in a tick, forty reversals a second, for as long as the
   * robot stood there. Its position goes back to where it began the tick and its velocity to
   * zero; the robot, which is not driving, is not moved either. A robot pushing the ball is a
   * different case: its squirt is the robot's doing and the solve's answer stands.
   */
  for (const b of ground) {
    if (!world.pinnedArtifacts.includes(b.id)) continue;
    const pin = lastPins.get(b.id);
    if (!pin || pushingPin(pin)) continue;
    const s = startOf.get(b.id);
    if (s) {
      b.pos.x = s.pos.x;
      b.pos.y = s.pos.y;
    }
    b.vel.x = 0;
    b.vel.y = 0;
  }

  /**
   * A STRUCK ARTIFACT MAY NOT LEAVE FASTER THAN WHATEVER DROVE IT.
   *
   * Two EQUAL masses with restitution e <= 1 give the struck body ((1+e)/2)*v, which is never
   * more than the striker's own v. The solve breaks that when the striker is an artifact pressed
   * against a KINEMATIC chassis and re-driven every tick: it cannot recoil, so the solver reads
   * it as infinite mass and delivers (1+e)*v instead. Measured, a robot ramming a pile at 85 in/s
   * sent the ball beyond it at exactly `BALL_MAX_SPEED` — the clamp catching a collision that
   * wanted to give it still more — and a ball faster than the robot can never be caught again:
   * "if I drive in full speed, third ball bumps with the second ball and doesn't get intaked".
   *
   * So the round's answer is bounded by what could physically have driven it: the artifact's own
   * speed at the START of the tick, the start speed of everything in its contact CLUMP, and the
   * speed of any robot touching that clump. A clump rather than one hop because a chassis pushes
   * a chain in a single pass by design — capping a ball on its neighbour's start speed alone
   * froze the back of a pile for a tick and reintroduced the burial the look-ahead exists to
   * prevent. Every velocity pre-pass (`bounceFirstContacts`, `scatterBalls`, `clumpDrag`,
   * `intakeSuction`) runs BEFORE the snapshot, so their impulses are already in the bound and
   * only what the SOLVER added past it is clipped.
   *
   * A PINNED artifact is exempt. A ball squeezed a few degrees off square between a bumper and a
   * wall has to travel 1/tan(theta) times the robot's own advance just to stay clear of the
   * closing wedge — that is the geometry, not an error — and holding it to the robot's speed
   * shuts the wedge and parks the robot on the ball, which is the failure the pin work removed.
   */
  {
    const look = C.PHYS_BALL_PREDICTION * C.PHYS_LENGTH_UNIT;
    const touch = 2 * C.BALL_RADIUS + look;
    const parent = ballsAtStart.map((_, i) => i);
    const find = (i: number): number => {
      let k = i;
      while (parent[k] !== k) {
        parent[k] = parent[parent[k]];
        k = parent[k];
      }
      return k;
    };
    for (let i = 0; i < ballsAtStart.length; i++) {
      for (let j = i + 1; j < ballsAtStart.length; j++) {
        const a = ballsAtStart[i];
        const c = ballsAtStart[j];
        if (hyp(a.pos.x - c.pos.x, a.pos.y - c.pos.y) > touch) continue;
        const ra = find(i);
        const rb = find(j);
        if (ra !== rb) parent[ra] = rb;
      }
    }
    const capOf = new Map<number, number>();
    const raise = (root: number, v: number) => capOf.set(root, Math.max(capOf.get(root) ?? 0, v));
    for (let i = 0; i < ballsAtStart.length; i++) {
      const s = ballsAtStart[i];
      raise(find(i), hyp(s.vel.x, s.vel.y));
      for (const r of world.robots) {
        const sol = solids.get(r.id);
        if (!sol) continue;
        if (!robotPenetration(r, sol, s.pos, C.BALL_RADIUS, false, false, -look)) continue;
        raise(find(i), hyp(r.vel.x, r.vel.y));
      }
    }
    for (let i = 0; i < ballsAtStart.length; i++) {
      const b = ballsAtStart[i].b;
      if (b.state.kind !== 'ground') continue;
      if (world.pinnedArtifacts.includes(b.id)) continue;
      const cap = capOf.get(find(i)) ?? 0;
      const now = hyp(b.vel.x, b.vel.y);
      if (now <= cap || now <= C.BALL_REST_SPEED) continue;
      const k = cap / now;
      b.vel.x *= k;
      b.vel.y *= k;
    }
  }
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
