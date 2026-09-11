import type { Alliance, Artifact, RobotCommand, RobotState, World } from '../../types';
import * as C from '../../config';
import { clamp, hyp, rot, wrapAngle } from '../../math';
import { solveArtifacts, type SweepFrom } from '../../sim/physicsEngine';
import { robotSolids, type RobotSolids } from '../../sim/artifactSolids';
import {
  BB_AIM_GAIN,
  BB_AIM_TOL,
  BB_BALL_SOLVER,
  BB_HALF_X,
  BB_HALF_Y,
  BB_POLLEN_FRICTION,
  BB_POLLEN_R,
  BB_POLLEN_REST_SPEED,
  BB_POLLEN_SEP_ITERS,
  BB_POLLEN_WALL_REST,
  type BbBallSolver,
} from './config';
import { biobuzzColliders } from './colliders';
import { capturePollen, scoreTargets } from './elements';
import { bbAimHeading, bbFootprint, bbLaunch, bbMouths } from './robot';
import { rectContains, type BiobuzzState } from './state';

/**
 * BIOBUZZ GAMEPLAY TICK — POLLEN physics and the intake/launch loop.
 *
 * This is the shell's only real gameplay: pollen roll, settle, get collected, and get thrown
 * back out. There is no scoring, because Section 10 of the V0 manual is a Kickoff placeholder
 * (`scored: false` on the sim module says so at the seam). What there IS, and what has to be
 * right before anything is built on top of it, is a POLLEN model that CONSERVES COUNT and
 * NEVER LEAKS OUT OF THE FIELD under every input a driver can produce.
 *
 * ── THE TWO SOLVERS ────────────────────────────────────────────────────────
 * `BB_BALL_SOLVER` picks between the two ball models DSIM already has, and BOTH ARMS ARE
 * BUILT because the choice needs a fact the manual has not published yet (does BIOBUZZ have
 * field structure POLLEN must roll over or rest on?). Phase 0.5 picks; this file makes the
 * comparison possible by keeping everything except the solve identical between them.
 *
 *  • `'bespoke'` — CR's model, copied and owned. A friction/rest-speed integrator, a
 *    spatial-hash separation pass so POLLEN never rest inside one another, and an explicit
 *    wall clamp with restitution. Cheap enough for hundreds of elements, and exactly
 *    deterministic because it is arithmetic in a fixed order.
 *
 *  • `'rapier'` — DECODE's model (`solveArtifacts`), where each ground POLLEN is a real Rapier
 *    body that sees every static the field declares plus every robot's artifact-solid
 *    geometry (`robotSolids`), with each chassis an IMMOVABLE SWEEP from its pose at the start
 *    of the tick to where the robot solve left it. It is driven here exactly as
 *    `src/sim/world.ts` drives it — the only differences are this game's `colliders` and the
 *    two sets DECODE needs and BIOBUZZ does not:
 *      · `claimed` is EMPTY. It names the artifacts an intake has hold of but has not yet
 *        taken, which is a state BIOBUZZ does not have: `interact()` either captures a POLLEN
 *        outright this tick (`capturePollen` → `state.kind === 'held'`) or plows it, so there
 *        is never a ground pollen mid-capture to exempt.
 *      · `doorway` is EMPTY. It names the artifact a gate is expelling, and BIOBUZZ has no
 *        gates.
 *
 * A KNOWN GAP IN THE RAPIER ARM, FOUND WHILE BUILDING IT AND STILL OPEN AFTER THE MERGE —
 * write this down, it is the whole point of doing both: `solveArtifacts` HARD-CODES
 * `C.BALL_RADIUS` (2.5", DECODE's 5" artifact) for the ball collider, its speed cap and the
 * `robotSolids` held-artifact circles, and uses DECODE's own containment helper for the field
 * pushback. A 1.5"-radius POLLEN therefore simulates as a 2.5"-radius ball under that arm —
 * it conserves count and stays in bounds (this file re-clamps to the BIOBUZZ walls
 * afterwards), but it separates at the wrong diameter, so a pile settles looser than it is
 * drawn. Choosing `'rapier'` for real means parameterizing the artifact radius in
 * `src/sim/physicsEngine.ts` + `src/sim/artifactSolids.ts`, which is shared code this lane
 * does not own and must not edit (`docs/biobuzz-contract.md` §1). That is a P0.5 decision
 * with a shared-core cost attached, and it is better known now than at Kickoff.
 */

/** the ONE place a POLLEN is put back inside the field. Both solvers end here, so containment
 * is a property of this file rather than of whichever solve ran. Returns nothing — it edits
 * in place, like every other integrator step. */
function clampPollenToWalls(b: Artifact): void {
  const lim = BB_HALF_X - BB_POLLEN_R;
  const limY = BB_HALF_Y - BB_POLLEN_R;
  if (b.pos.x > lim) {
    b.pos.x = lim;
    if (b.vel.x > 0) b.vel.x = -b.vel.x * BB_POLLEN_WALL_REST;
  } else if (b.pos.x < -lim) {
    b.pos.x = -lim;
    if (b.vel.x < 0) b.vel.x = -b.vel.x * BB_POLLEN_WALL_REST;
  }
  if (b.pos.y > limY) {
    b.pos.y = limY;
    if (b.vel.y > 0) b.vel.y = -b.vel.y * BB_POLLEN_WALL_REST;
  } else if (b.pos.y < -limY) {
    b.pos.y = -limY;
    if (b.vel.y < 0) b.vel.y = -b.vel.y * BB_POLLEN_WALL_REST;
  }
}

/**
 * Push overlapping ground POLLEN apart, position-based, over a uniform grid.
 *
 * A pile of 3" balls that are allowed to rest inside one another looks like fewer balls than
 * there are, and then explodes when something touches it. Two passes settle a pile without
 * the cost of a real constraint solver.
 *
 * DETERMINISM: the `o.id <= b.id` skip is not an optimization, it is what makes the pass
 * ORDER-INDEPENDENT — each unordered pair is resolved exactly once, from the lower id, so the
 * result does not depend on the grid's bucket iteration order. Without it the same seed can
 * produce two different piles and the world hash diverges between a client and the server.
 */
function separatePollen(ground: Artifact[]): void {
  const cell = 2 * BB_POLLEN_R;
  const minD = 2 * BB_POLLEN_R;
  const minD2 = minD * minD;
  const key = (cx: number, cy: number): number => (cx + 128) * 512 + (cy + 128);
  for (let iter = 0; iter < BB_POLLEN_SEP_ITERS; iter++) {
    const grid = new Map<number, Artifact[]>();
    for (const b of ground) {
      const k = key(Math.floor(b.pos.x / cell), Math.floor(b.pos.y / cell));
      const arr = grid.get(k);
      if (arr) arr.push(b);
      else grid.set(k, [b]);
    }
    for (const b of ground) {
      const cx = Math.floor(b.pos.x / cell);
      const cy = Math.floor(b.pos.y / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const arr = grid.get(key(cx + ox, cy + oy));
          if (!arr) continue;
          for (const o of arr) {
            if (o.id <= b.id) continue;
            const dx = o.pos.x - b.pos.x;
            const dy = o.pos.y - b.pos.y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= minD2 || d2 < 1e-9) continue;
            const d = Math.sqrt(d2);
            const push = (minD - d) / 2;
            const nx = dx / d;
            const ny = dy / d;
            b.pos.x -= nx * push;
            b.pos.y -= ny * push;
            o.pos.x += nx * push;
            o.pos.y += ny * push;
          }
        }
      }
    }
  }
}

/** put a POLLEN back on the tile at `pos`, dead stopped. The single landing path, so a lob, a
 * dump and an eviction all come to rest the same way. */
function land(b: Artifact, x: number, y: number): void {
  b.state = { kind: 'ground' };
  b.pos = { x, y };
  b.vel = { x: 0, y: 0 };
  b.z = 0;
  b.vz = 0;
}

/**
 * Resolve one ground POLLEN against one robot: collect it, or PLOW it out of the chassis.
 *
 * Order matters and is the reason the mouth reaches inside the frame: capture is tested FIRST,
 * so a POLLEN at the roller is collected before the frame would shove it forward. Driving into
 * a pile therefore collects it instead of scattering it, which is the single biggest
 * difference between an intake that feels real and one that feels like a bulldozer.
 *
 * The plow pushes along the MINIMUM-PENETRATION axis in the robot frame, BY THE WHOLE
 * PENETRATION DEPTH, and imparts the robot's speed — so a POLLEN squeezed against a wall pops
 * out sideways rather than being dragged through the chassis, at any speed the drivetrain can
 * reach. See the note at the push itself for why a fixed step was wrong.
 */
/** the hair past the surface a plowed POLLEN is placed at, so the next tick does not find the
 * same contact at zero depth. */
const PLOW_EPS = 0.02;

function interact(
  world: World,
  b: Artifact,
  rob: RobotState,
  cmd: RobotCommand | undefined,
  enabled: boolean,
): 'collected' | 'none' {
  const e = bbFootprint(rob.spec);
  const local = rot({ x: b.pos.x - rob.pos.x, y: b.pos.y - rob.pos.y }, -rob.heading);
  const r2 = BB_POLLEN_R;

  const intakeActive = enabled && (rob.autoIntake || (cmd?.intake ?? false));
  if (intakeActive) {
    // ANY mounted edge grabs: one mouth for front/back, two for `side` (both flanks) and
    // `frontback` (both ends). `capturePollen` is what enforces the hopper cap, so a full
    // robot falls through to the plow below rather than silently eating nothing.
    for (const m of bbMouths(rob.spec)) {
      if (rectContains(m, local.x, local.y, r2) && capturePollen(world, rob, b)) return 'collected';
    }
  }

  const inBox = local.x < e.front + r2 && local.x > -e.rear - r2 && Math.abs(local.y) < e.half + r2;
  if (!inBox) return 'none';

  const penX = e.front + r2 - local.x;
  const penXneg = local.x + e.rear + r2;
  const penY = e.half + r2 - Math.abs(local.y);
  let nx = 0;
  let ny = 0;
  let depth = 0;
  if (Math.min(penX, penXneg) < penY) {
    nx = penX < penXneg ? 1 : -1;
    depth = Math.min(penX, penXneg);
  } else {
    ny = local.y >= 0 ? 1 : -1;
    depth = penY;
  }
  const w = rot({ x: nx, y: ny }, rob.heading);
  /**
   * PUSH BY THE FULL PENETRATION, not by a fixed step.
   *
   * This was a flat 0.6" per tick, and that is a speed-dependent bug rather than a soft
   * contact: a robot at 50 in/s advances 0.83" per tick and one at 80 in/s advances 1.33", so
   * the frame gained on the POLLEN every tick and eventually contained it — the gallery's
   * `corner-pile` cell showed pollen centres a full radius INSIDE the chassis, which is a
   * POLLEN being dragged along inside a robot rather than plowed. Resolving the whole overlap
   * makes the plow correct at every speed the drivetrain can reach, and it is what the
   * pollen-vs-pollen separator above already does.
   *
   * `EPS` is the hair past the surface that keeps the next tick's `inBox` test from finding the
   * same contact at exactly zero depth and jittering on it.
   */
  b.pos.x += w.x * (depth + PLOW_EPS);
  b.pos.y += w.y * (depth + PLOW_EPS);
  const rv = hyp(rob.vel.x, rob.vel.y);
  b.vel.x = w.x * rv * 0.9;
  b.vel.y = w.y * rv * 0.9;
  return 'none';
}

/**
 * The BIOBUZZ gameplay tick.
 *
 * ORDER IS THE CONTRACT (and `step.ts` documents the pipeline this sits inside):
 *   1. HELD pollen ride their robot — position only, no physics.
 *   2. FLIGHT pollen integrate ballistically and LAND.
 *   3. GROUND pollen meet the robots (collect or plow).
 *   4. the chosen SOLVER runs, then everything is clamped inside the walls.
 *   5. LAUNCHERS fire, which is what creates tick-N+1's flight pollen.
 *   6. the score/endgame pass — a no-op in the shell, kept so its shape is fixed.
 *
 * Launching LAST is deliberate: a POLLEN released this tick should not be integrated,
 * collected and re-collected within the same tick, and firing at the end gives it exactly one
 * clean tick of flight before anything looks at it.
 */
export function updateBiobuzz(
  world: World,
  dt: number,
  cmds: Map<number, RobotCommand>,
  enabled: boolean,
  /** each robot's pose at the START of this tick (`step.ts`, stage 0) — the Rapier arm sweeps
   *  the chassis from there. Absent ⇒ no sweep, which is what a direct caller gets. */
  from?: ReadonlyMap<number, SweepFrom>,
  solver: BbBallSolver = BB_BALL_SOLVER,
): void {
  const bb = world.biobuzz as BiobuzzState | undefined;
  if (!bb) return; // an old snapshot from before this game existed; nothing to do

  const byId = new Map<number, RobotState>();
  for (const r of world.robots) byId.set(r.id, r);

  // ── 1. HELD: ride the robot ────────────────────────────────────────────────
  // A held POLLEN stays in `world.balls` (see `capturePollen`) so the count is conserved in
  // ONE place. It has no physics — it is inside the hopper — but its position has to track
  // the robot or the renderer would draw it where the robot used to be.
  for (const b of world.balls) {
    if (b.state.kind !== 'held') continue;
    const rob = byId.get(b.state.robot);
    if (!rob) {
      // its robot is gone (a mid-match leave). Drop it on the tile rather than deleting it:
      // deleting would break conservation, and a POLLEN that falls out of a departing robot
      // is what would physically happen.
      land(b, b.pos.x, b.pos.y);
      continue;
    }
    const off = rot({ x: b.state.lx, y: b.state.ly }, rob.heading);
    b.pos = { x: rob.pos.x + off.x, y: rob.pos.y + off.y };
  }

  // ── 2. FLIGHT: ballistic, then land ────────────────────────────────────────
  for (const b of world.balls) {
    if (b.state.kind !== 'flight') continue;
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.z += b.vz * dt;
    b.vz -= C.GRAVITY * dt;
    // a POLLEN thrown at the wall lands against it rather than through it
    clampPollenToWalls(b);
    if (b.z <= 0) land(b, b.pos.x, b.pos.y);
  }

  // ── 3. GROUND: friction, integrate, meet the robots ────────────────────────
  const ground: Artifact[] = [];
  for (const b of world.balls) {
    if (b.state.kind !== 'ground') continue;
    if (solver === 'bespoke') {
      // rolling decay, with a REST SPEED below which a POLLEN simply stops. Without the
      // snap-to-rest a ball creeps forever at 0.01 in/s, which is both a visual jitter and a
      // separation pass that never converges.
      const sp = hyp(b.vel.x, b.vel.y);
      if (sp > 0) {
        const ns = sp - BB_POLLEN_FRICTION * dt;
        if (ns <= BB_POLLEN_REST_SPEED) {
          b.vel.x = 0;
          b.vel.y = 0;
        } else {
          b.vel.x *= ns / sp;
          b.vel.y *= ns / sp;
        }
      }
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
    }
    let collected = false;
    for (const rob of world.robots) {
      if (interact(world, b, rob, cmds.get(rob.id), enabled) === 'collected') {
        collected = true;
        break;
      }
    }
    if (!collected) ground.push(b);
  }

  // ── 4. SOLVE + CONTAIN ────────────────────────────────────────────────────
  if (solver === 'bespoke') {
    separatePollen(ground);
  } else {
    /**
     * Rapier owns the integration AND the separation in this arm, so the loop above did not
     * move anything. It reads `world.balls` itself and only touches ground pollen, which is
     * why it runs after the capture pass rather than before it.
     *
     * Driven the way `src/sim/world.ts` drives it: the robot solids are built ONCE from the
     * held pollen (a full hopper is a physical plug in the mouth), the two DECODE-only
     * exemption sets are empty (see this file's header), and each chassis is swept from the
     * pose `step.ts` captured before the drivetrain ran to where the robot solve put it. With
     * no `from` — a caller that steps `updateBiobuzz` directly without the surrounding step —
     * `solveArtifacts` falls back to the END pose per robot, i.e. no sweep.
     */
    const heldBalls = world.balls.filter((b) => b.state.kind === 'held');
    const solids = new Map<number, RobotSolids>();
    for (const rob of world.robots) solids.set(rob.id, robotSolids(rob, heldBalls));
    solveArtifacts(world, dt, biobuzzColliders, NO_IDS, NO_IDS, solids, from ?? NO_SWEEP);
  }
  for (const b of ground) clampPollenToWalls(b);

  // ── 5. LAUNCH ─────────────────────────────────────────────────────────────
  for (const rob of world.robots) {
    if (rob.passive) continue; // a practice dummy has no mechanisms to run
    bbLaunch(world, rob, cmds.get(rob.id) ?? ZERO_CMD, enabled);
  }

  // ── 6. SCORE + ENDGAME ────────────────────────────────────────────────────
  // A NO-OP, on purpose. `scoreTargets()` is empty and `scored: false`, so nothing can be
  // scored and no match of this game reaches a leaderboard. The pass exists — and writes the
  // zeroes explicitly — so that the shape Lane A fills in is already wired to the HUD, the
  // results rows and `worldHash`, and so a stale non-zero value from a snapshot of some
  // future version cannot survive into a shell world.
  for (const rob of world.robots) bb.endgame[rob.id] = 'none';
  for (const a of ['red', 'blue'] as Alliance[]) {
    bb.scored[a] = 0;
    bb.points[a] = 0;
    world.match.scores[a].total = world.match.scores[a].foulPoints;
  }
}

/**
 * THE AIM HOOK — the rotate override a turretless launcher gets while its fire button is held,
 * or `null` to leave the driver's rotate command alone.
 *
 * A drum or a dumper fires along one chassis EDGE, so "aim" means "turn the robot", and the
 * override has to replace the command before the drivetrain model runs (see `step.ts`, stage
 * 2). A turret aims itself and never gets an override — steering the chassis for a turret
 * would fight the driver for no benefit.
 *
 * SHELL: ALWAYS NULL, because `scoreTargets()` is empty. The path is written and wired anyway
 * — a P-controller on the heading error, dead-banded by `BB_AIM_TOL` so a robot already lined
 * up does not oscillate — because the alternative is that the first target Section 9 publishes
 * needs a new stage in the pipeline rather than a return value here.
 */
export function bbAimAssist(
  world: World,
  r: RobotState,
  cmd: RobotCommand,
  enabled: boolean,
): number | null {
  if (!enabled || !cmd.fire || !r.aimAssist) return null;
  const targets = scoreTargets(world, r.alliance);
  if (targets.length === 0) return null;
  // nearest target: with one goal this is trivially it, and with several it is the one a
  // driver holding fire means. Chosen by squared distance — no sqrt needed for a comparison.
  let best = targets[0];
  let bestD = Infinity;
  for (const t of targets) {
    const dx = t.pos.x - r.pos.x;
    const dy = t.pos.y - r.pos.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  const want = bbAimHeading(r, best);
  if (want === null) return null; // turreted: the turret does this
  const err = wrapAngle(want - r.heading);
  if (Math.abs(err) < BB_AIM_TOL) return 0; // lined up — hold still rather than hunt
  return clamp(err * BB_AIM_GAIN, -1, 1);
}

/** the two DECODE-only exemption sets `solveArtifacts` takes, empty for BIOBUZZ and shared
 * rather than re-allocated per tick. See this file's header for why each is empty. */
const NO_IDS: ReadonlySet<number> = new Set<number>();
/** no sweep origin: `solveArtifacts` falls back to each robot's END pose. */
const NO_SWEEP: ReadonlyMap<number, SweepFrom> = new Map<number, SweepFrom>();

/** a zero command, for a robot with no driver this tick (a dummy, a dropped peer). Frozen so
 * a mechanism that mutated it could not silently affect the next robot. */
const ZERO_CMD: RobotCommand = Object.freeze({
  driveX: 0,
  driveY: 0,
  rotate: 0,
  leftDrive: 0,
  rightDrive: 0,
  intake: false,
  fire: false,
});
