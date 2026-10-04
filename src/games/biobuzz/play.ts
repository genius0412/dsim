import type { Alliance, Artifact, RobotCommand, RobotSpec, RobotState, Vec2, World } from '../../types';
import * as C from '../../config';
import { clamp, dcos, dsin, hyp, nextRandom, rot, wrapAngle } from '../../math';
import { solveArtifacts, type SweepFrom } from '../../sim/physicsEngine';
import { simModuleFor } from '../sim';
import { stepGroundBall } from '../../sim/physics';
import { robotSolids, type RobotSolids } from '../../sim/artifactSolids';
import {
  BB_AIM_GAIN,
  BB_AIM_TOL,
  BB_FIXED_AIM_TOL_PRE4,
  BB_FLOWERS,
  BB_FLOWER_RETRIEVE_S,
  BB_FLOWER_UNLOCK_S,
  BB_HALF_X,
  BB_HALF_Y,
  BB_HIVE_OPEN_Z,
  BB_HOOD_DEFAULT_DEG,
  BB_NECTAR_R,
  BB_POLLEN_R,
  BB_POLLEN_WALL_REST,
  BB_RAMP_OUT,
  bbFlowerReachOf,
  bbHopperCap,
  bbLoadingZoneSpot,
  BB_SIDE_ROLLER_PROTRUDE,
  type BbFlowerReach,
} from './config';
import { biobuzzColliders } from './colliders';
import {
  BB_PASS_PRESET_DEFAULT,
  bbPassPresetPoint,
  isBbPassPreset,
} from './passTargets';
import { capturePollen, hiveCellTarget, scoreTargets, takeHeld } from './elements';
import { bbBites, bbElementRadius, flowerFits, flowerRetrieve, flowerStackZ, type BbElementKind } from './flower';
import { hiveAccepts, hiveCellPos, hiveDeflect, hiveStep, hiveTakingSide, spillPoses } from './hive';
import { bbIntakeKindOf, bbIsTurreted, bbLauncherOf, bbLiftOf } from './mechs';
import { bbDumpZ, bbSideRollerOffsets, importSideRollersPre6 } from './importMech';
import {
  type BbMouthAxes,
  type BbShot,
  bbAimHeading,
  bbDumpCluster,
  bbDumpSolution,
  bbFlowerInReach,
  bbIntakeAct,
  bbIntakeExtraReach,
  bbLaunch,
  bbMouths,
  bbRampReverse,
  bbRampSettled,
  bbRampStep,
  bbRampSwingProgress,
  bbSlewTurret,
  bbTurretRelease,
  bbFixedRelease,
  bbFixedFacing,
  bbFootprint,
  bbTurretOnTarget,
  bbTurretSolution,
  mouthAxes,
} from './robot';
import { type BiobuzzState, type ScoreTarget, type Vec3 } from './state';
import { flyExitSpeed, flyStep } from '../../sim/flywheel';
import { fixedAimTurn } from '../../sim/aimTurn';

/**
 * BIOBUZZ GAMEPLAY TICK — POLLEN physics and the intake/launch loop.
 *
 * The element loop: POLLEN and NECTAR roll, settle, get collected, get launched into the HIVE
 * or placed into a FLOWER, and spill back out of a TIPPED HIVE. The points themselves are
 * `score.ts`'s (the module is `scored: true`, `sim.ts`); what this file owns, and what has to
 * be right before anything is built on top of it, is an element model that CONSERVES COUNT
 * and NEVER LEAKS OUT OF THE FIELD under every input a driver can produce.
 *
 * ── THERE IS ONE SOLVER, AND IT IS NOT IN THIS FILE ────────────────────────
 * GROUND POLLEN are solved by the SHARED artifact solve, `solveArtifacts`
 * (`src/sim/physicsEngine.ts`), with `BB_POLLEN_R` as the radius. Each ground POLLEN is a real
 * Rapier body that sees every static this game's `colliders` declares plus every robot's
 * artifact-solid geometry (`robotSolids`, built at the same radius), with each chassis an
 * IMMOVABLE SWEEP from its pose at the start of the tick to where the robot solve left it.
 *
 * NOTHING IN THIS DIRECTORY INTEGRATES, SEPARATES, CLAMPS OR EVICTS A GROUND POLLEN, and that
 * is a decision rather than an omission. The repo OWNER owns artifact physics and reworked it
 * on `alpha` around one rule: **every element ends the tick somewhere it is allowed to be, with
 * ONE POSITION AUTHORITY per element.** Some forty bespoke position-writing passes used to take
 * turns in DECODE, and every "the balls go on top of the robot" report was two of them
 * disagreeing. A second ball integrator living here would be exactly that failure, imported
 * into a new game on purpose — and it would also have to be re-derived every time the owner
 * moves the shared solve, which he is doing. So BIOBUZZ passes a RADIUS and nothing else.
 *
 * There used to be a `BB_BALL_SOLVER` switch with a second, bespoke arm here (CR's
 * friction/rest-speed integrator, a spatial-hash separation pass, an explicit wall clamp with
 * restitution) built so Phase 0.5 could compare the two. It is GONE, and the comparison it
 * was for is not the question any more: the question was "which model feels like pollen", and
 * the answer to "who owns ball physics" settles it first. `docs/biobuzz-plan.md` Phase 0.5 and
 * `docs/biobuzz/feedback/000-solver-observations.md` record what the shared solver actually
 * does with a 1.5" element.
 *
 * The two DECODE-only exemption sets `solveArtifacts` takes are EMPTY here, and both are facts
 * about this game rather than stubs:
 *   · `claimed` names the artifacts an intake has hold of but has not yet taken. BIOBUZZ has
 *     no such state: `interact()` either captures a POLLEN outright this tick
 *     (`capturePollen` → `state.kind === 'held'`) or leaves it to the solver.
 *   · `doorway` names the artifact a gate is expelling, and BIOBUZZ has no gates.
 *
 * TWO THINGS ARE STILL THIS FILE'S. FLIGHT pollen, because the shared solve only looks at
 * ground elements — the ballistic step below is the only writer of a flying POLLEN's position
 * and competes with nothing. And the PERIMETER INVARIANT for ground pollen
 * (`clampPollenToWalls`), because the solve does not hold it: measured, removing that pass put
 * a POLLEN 2.02" through the wall in `wall-row-sweep`. DECODE holds the same invariant the same
 * way, inside its round loop. See that function's own note.
 */

/**
 * THE CONTAINMENT INVARIANT — put a POLLEN back inside the perimeter, bouncing it off the wall
 * it reached.
 *
 * THE SOLVE DOES NOT HOLD THE PERIMETER FOR ARTIFACTS ON ITS OWN, and that was MEASURED here
 * rather than assumed: with this pass removed, `wall-row-sweep` put a POLLEN **2.02" past the
 * wall plane** (tick 105) and `pile-fast` 1.52", on a 1.5" element. DECODE holds the same
 * invariant the same way — `src/sim/world.ts` runs `clampBallPosToStatics` on every ground
 * artifact INSIDE its round loop — so a containment clamp is part of the sanctioned design,
 * not a competing authority: the solve decides where an artifact goes and this only acts where
 * the solve had no answer to give.
 *
 * WHY THE SOLVE CANNOT WIN THAT SQUEEZE, and it is worth writing down because it is not the
 * radius: BIOBUZZ does not run the PIN half of DECODE's round loop (`pinnedArtifacts` →
 * `PinnedCircle` → re-run `solveRobots`). Nothing tells the robot solve that a POLLEN against
 * a wall is a wall, so the chassis drives on through the space the POLLEN is in and the POLLEN
 * has nowhere to be. That is the first item in `docs/biobuzz/feedback/000-solver-observations.md`
 * "For the owner", and it is NOT fixed here — porting the round loop is shared-physics work.
 *
 * ⚠️ THE BOUNCE TERM IS A KNOWN DISAGREEMENT WITH THE SHARED SOLVE, also for the owner. DECODE
 * does not reverse the velocity at its clamp, it REMOVES the component pointing into the wall
 * (`fieldPushback` beside the clamp in `world.ts`), having measured that a reversal reads as an
 * impact on the next tick and bounces artifact and robot apart. This reverses it, scaled by
 * `BB_POLLEN_WALL_REST`. It is left exactly as it was because re-deriving it here would be a
 * BIOBUZZ copy of shared physics, which is the thing this file just stopped doing.
 */
function clampPollenToWalls(b: Artifact): void {
  /**
   * ⚠️ THE ELEMENT'S OWN RADIUS, NOT THE POLLEN'S. This field carries two sizes at once —
   * POLLEN 1.4 and NECTAR 1.8 — and a NECTAR entered by the human player is a GROUND element
   * for as long as it takes a robot to come and get it. Clamped at the POLLEN radius it came
   * to rest with 0.4 in of its skin through the wall, which is the "0.4 in past the wall" note
   * in HANDOFF-field. `bbElementRadius` is the same answer `land`, the spawner and the
   * renderer give, so there is one definition of how big a NECTAR is.
   */
  const r = bbElementRadius(bbKindOf(b));
  const lim = BB_HALF_X - r;
  const limY = BB_HALF_Y - r;
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

/** put an element back on the tile at `pos`, dead stopped. The single landing path, so a lob, a
 * dump and an eviction all come to rest the same way — and all of them CLEAR OF THE STATICS
 * (`clearOfStatics`). */
function land(b: Artifact, x: number, y: number): void {
  b.state = { kind: 'ground' };
  b.pos = clearOfStatics(x, y, bbElementRadius(bbKindOf(b)));
  b.vel = { x: 0, y: 0 };
  b.z = 0;
  b.vz = 0;
}

/**
 * THE LANDING PUSH-OUT — move a point that is about to become a ground element out of every
 * static it overlaps, onto the nearest face that is still inside the field.
 *
 * A FLIGHT element is not solved, so it flies over a FLOWER foot or a HIVE frame bar. With the
 * flower flight branch gone (nothing launched enters a FLOWER), a missed lob coming down over a
 * foot used to LAND INSIDE the collider, and the solve cannot clear an element buried in a
 * static — it has no normal to push it along. So the landing point is cleared here, from the
 * colliders' own geometry (`biobuzzColliders`, the same boxes the solve sees), before the solve
 * ever meets it. This is a spawn-placement rule for a state flip, not a second position authority
 * for a ground element: it runs once, on the tick the element lands.
 *
 * Every BIOBUZZ static is axis-aligned (`rot: 0`). Of the four face-pushes the shortest one that
 * leaves the element inside the field wins — so a ball landing in a foot against the wall is
 * pushed along or away from the wall, never through it.
 */
function clearOfStatics(x: number, y: number, r: number): Vec2 {
  let px = x;
  let py = y;
  const limX = BB_HALF_X - r;
  const limY = BB_HALF_Y - r;
  for (const s of biobuzzColliders.statics) {
    if (Math.abs(px - s.tx) >= s.hx + r || Math.abs(py - s.ty) >= s.hy + r) continue;
    const options: [number, number][] = [
      [s.tx - s.hx - r, py],
      [s.tx + s.hx + r, py],
      [px, s.ty - s.hy - r],
      [px, s.ty + s.hy + r],
    ];
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (const [cx, cy] of options) {
      if (Math.abs(cx) > limX || Math.abs(cy) > limY) continue;
      const d = Math.abs(cx - px) + Math.abs(cy - py);
      if (d < bestD) {
        bestD = d;
        best = [cx, cy];
      }
    }
    if (best) {
      px = best[0];
      py = best[1];
    }
  }
  return { x: px, y: py };
}

/**
 * ONE ROBOT'S INTAKE, THIS TICK — the rollers PULL, then whatever has arrived at the throat is
 * swallowed.
 *
 * The decision is `bbIntakeAct`'s (`robot.ts`), because it is GEOMETRY and hardware and because
 * the 3D pipeline has to make exactly the same one (`sim3d/elements3d.ts` calls it too). This
 * function is the 2D APPLICATION of it, and it writes exactly two kinds of thing:
 *
 *  · a VELOCITY on a ground element the rollers have hold of. Not a position — the shared solve
 *    is still the one position authority (`docs/biobuzz-contract.md` §1), and this runs BEFORE
 *    it, so the pull is simply the speed the element is trying to move at and what it actually
 *    does is what the solve leaves behind. DECODE's `intakeSuction` is the same shape at the
 *    same point in the tick, and its own header says why writing it AFTER the solve is a lie.
 *  · a CAPTURE, through `capturePollen`, which is still what enforces the hopper cap and G408.
 *
 * There used to be a PLOW branch here — if the POLLEN was inside the footprint and not
 * collected, it was pushed out along the minimum-penetration axis and given the robot's speed.
 * That was a second POSITION writer for a ground pollen and it is gone for good; the chassis,
 * the intake structure and the held pollen are all colliders in `solveArtifacts`.
 */
function intakeTick(
  world: World,
  rob: RobotState,
  cmd: RobotCommand | undefined,
  enabled: boolean,
): void {
  if (!(enabled && (rob.autoIntake || (cmd?.intake ?? false)))) return;
  // ⚠️ `extraReach` — same predicate as 3D's `elements3dCapture` (owner report 2026-09-20). 2D
  // HAS NO RAMP COLLIDER (`docs/area/biobuzz.md`: "2D stays DRAWING-ONLY"), so nothing here is
  // solid for the element to meet — it is simply pulled from further out, the same shape as the
  // sweeper's own reach, and a real bar's push is not modelled here on purpose.
  const act = bbIntakeAct(world, rob, { extraReach: bbIntakeExtraReach(rob, world.time) });
  for (const p of act.pull) p.ball.vel = p.vel;
  for (const b of act.take) capturePollen(world, rob, b);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ELEMENT LOOKUPS — what an element IS, and where the parked ones live
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What an element is FOR SCORING, read off the one field that always carries it: its COLOUR.
 *
 * POLLEN are yellow and NECTAR are their alliance's colour (§9.8), so the ball array alone
 * answers "is this a NECTAR, and whose" — no parallel map, and nothing to fall out of step
 * when an element changes state. `Artifact.color` is on the wire and in every snapshot, which
 * is exactly what a lookup used by the tip table and by FLOWER ownership has to be.
 */
export function bbKindOf(b: Artifact): BbElementKind {
  return b.color === 'red' || b.color === 'blue' ? b.color : 'pollen';
}

/** the same lookup by ID, for the pure modules (`hiveLoad`, `flowerScore`) that hold ids.
 * An id the world does not have reads as POLLEN rather than throwing: a dangling id in a
 * stack draws nothing and must not take a match down. */
function kindById(byId: ReadonlyMap<number, Artifact>): (id: number) => BbElementKind {
  return (id) => {
    const b = byId.get(id);
    return b ? bbKindOf(b) : 'pollen';
  };
}

/** the two alliances, in a stable order, shared rather than re-allocated per tick. Red first
 * everywhere in this file so a hive loop, a spill and a human-player entry are ordered the same
 * way — the RNG is drawn inside one of those loops, so the order IS part of determinism. */
const ALLIANCES: readonly Alliance[] = ['red', 'blue'];

/**
 * `ScoreTarget.id` → what that target IS, built once at module load off `scoreTargets`' own
 * naming (`hive:<alliance>`, `flower:<index>`).
 *
 * Parsing the id with a `slice` and a `Number` is what `bbIndexElements` does and it is how
 * `flower:F1` became un-indexable in a scene — a string convention nobody owns. These two maps
 * are the convention, written once, so a capture that walks the target list resolves a target
 * to a hive or a flower by lookup rather than by string surgery.
 */
const HIVE_OF: ReadonlyMap<string, Alliance> = new Map(ALLIANCES.map((a) => [`hive:${a}`, a]));

/** mid-height of the CELL opening (in) — where a parked element is drawn to sit. A parked
 * element is not solved and has no position of its own; this is somewhere to point at. */
const CELL_MID_Z = (BB_HIVE_OPEN_Z[0] + BB_HIVE_OPEN_Z[1]) / 2;

/**
 * Park one element INSIDE a field element: out of the ball physics, into `el`'s order, and
 * still in `world.balls` so the count is conserved in one array (`state.ts`).
 *
 * The order list is the caller's (`hives[a].contents` or `flowers[i].stack`) and the `slot`
 * written on the ball is its index in it, so `bbIndexElements` can rebuild the list from the
 * array alone and the two views cannot drift.
 */
function park(b: Artifact, el: string, order: number[], pos: Vec2, z: number): void {
  b.state = { kind: 'element', el, slot: order.length };
  order.push(b.id);
  b.pos = { x: pos.x, y: pos.y };
  b.vel = { x: 0, y: 0 };
  b.z = z;
  b.vz = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE HUMAN PLAYER (field-plan §2.4, G426/G427)
// ─────────────────────────────────────────────────────────────────────────────

/** one draw from the WORLD's seeded chain, advancing it. Every randomised thing in this file
 * goes through here — the spill scatter and the human player's jitter — so "the rng was drawn
 * N times this tick, in this order" is one readable fact rather than two inline closures that
 * can be reordered without anyone noticing the replay changed. */
function nextRandomValue(world: World): number {
  const n = nextRandom(world.rngState);
  world.rngState = n.state;
  return n.value;
}

/** how far off the LOADING ZONE spot an entered NECTAR is placed, in inches, each way. A human
 * putting five elements on the same tile does not stack them. APPROX. */
const NECTAR_ENTRY_JITTER = 4.0; // APPROX

/** the `held` key the human player button's rising edge is remembered under, per robot. A
 * namespaced string because `BiobuzzState.held` is the shared per-robot latch bag and every
 * future held-thing goes in it under its own key. */
const NECTAR_PRESS_KEY = 'nectarPress';

/**
 * The BIOBUZZ gameplay tick.
 *
 * ORDER IS THE CONTRACT (and `step.ts` documents the pipeline this sits inside):
 *   1. HELD pollen ride their robot — position only, no physics.
 *   2. FLIGHT elements integrate ballistically, then are offered to the up-CELLS and the
 *      FLOWERS, and LAND if neither took them.
 *   3. the HIVES step: a loaded cell starts its swing, a swing passing LEVEL spills its
 *      contents back onto the field as GROUND elements carrying the spill velocity, and a
 *      settled swing completes its TIP. AFTER the flight stage, so the element that completes
 *      a load tips the cell on the tick it arrives rather than on the next one.
 *   4. GROUND pollen: the shared rolling-friction/rest-snap pass (`stepGroundBall`, velocity
 *      only), then the robots — CAPTURE only, nothing is moved here.
 *   5. the SHARED artifact solve runs, at `BB_POLLEN_R` — the ONE position authority for a
 *      ground pollen: no integration, no separation pass and no eviction. Then the perimeter
 *      invariant, which the solve does not hold on its own (see `clampPollenToWalls`).
 *   5b. the ROBOT MECHANISMS aim: each turret (both of a double turret) slews onto the own
 *      HIVE on both axes, and a dumper solves its dump — and each says whether it is ON TARGET.
 *      After the solve so a launcher aims from where the chassis ended the tick; before the
 *      launch so a turret that slewed this tick fires on this tick's bearing.
 *   5c. the BOX TUBE PLACES: an edge on the place-POLLEN / place-NECTAR buttons, with a FLOWER
 *      in reach, moves one held element into that FLOWER's stack. Before the launch, so an
 *      held fire on the same tick cannot throw away the element being placed.
 *   6. LAUNCHERS fire, which is what creates tick-N+1's flight pollen.
 *   7. the HUMAN PLAYERS enter what they are owed (G426), as ground elements in their own
 *      LOADING ZONE.
 *   8. the endgame reset and the score FLOOR — the Table 10-2 rows themselves belong to the
 *      RULES lane and land after this file runs; stage 8 only clears the slate they add to.
 *
 * Launching LAST (of the mechanisms) is deliberate: a POLLEN released this tick should not be
 * integrated, collected and re-collected within the same tick, and firing at the end gives it
 * exactly one clean tick of flight before anything looks at it. The human player enters after
 * it for the same reason — an element put on the tiles this tick meets the solve next tick,
 * never a robot that has already driven.
 */
export function updateBiobuzz(
  world: World,
  dt: number,
  cmds: Map<number, RobotCommand>,
  enabled: boolean,
  /**
   * Each robot's pose at the START of this tick (`step.ts`, stage 0) — the artifact solve
   * sweeps the chassis from there to where the robot solve left it.
   *
   * REQUIRED, and it used to be optional with a fall back to the END pose. A missing sweep is
   * not a degraded mode, it is a WRONG one that still runs: the chassis is placed in the solve
   * already overlapping whatever it drove into, and the only thing acting on the POLLEN inside
   * it is soft penetration recovery — which is the "the balls go on top of the robot" failure
   * the sweep exists to prevent. A silent fallback made that a plausible-looking tick instead
   * of a compile error, so it is a compile error now: every caller (`step.ts`, and every smoke
   * loop that drives this directly) captures stage 0 the way `src/sim/world.ts` does, or it
   * does not build. A caller with genuinely nothing to sweep passes an EMPTY map and says so.
   */
  from: ReadonlyMap<number, SweepFrom>,
): void {
  const bb = world.biobuzz as BiobuzzState | undefined;
  if (!bb) return; // an old snapshot from before this game existed; nothing to do

  const byId = new Map<number, RobotState>();
  for (const r of world.robots) byId.set(r.id, r);
  // the element lookup every rule below shares: built ONCE per tick, off the array that IS the
  // conservation authority, so the tip table, the FLOWER owner and the smoke lane all read the
  // same answer to "what is element 37".
  const ballById = new Map<number, Artifact>();
  for (const b of world.balls) ballById.set(b.id, b);
  const kindOf = kindById(ballById);
  /**
   * EVERY OPENING ON THE FIELD, once per tick — the UNION of both alliances' lists, merged by
   * id.
   *
   * ONE call used to cover it, because `scoreTargets` listed both up-CELLS whichever alliance
   * asked. Since the owner's ruling of 2026-09-12 it lists only the asking alliance's own CELL
   * (the opponent's is not a place that alliance can score), so a single call would leave one
   * HIVE with no capture test at all — every shot into it would fall through to the floor,
   * including the ones that are supposed to go in. The FLOWERS are neutral and appear in both
   * lists, hence the id set.
   *
   * The merge is the CAPTURE side's business only. Aim asks per alliance and gets the filtered
   * list, which is the point of the ruling; the field still has to know where all six openings
   * are in order to refuse a shot at one of them.
   */
  const targets: ScoreTarget[] = [];
  {
    const seen = new Set<string>();
    for (const a of ALLIANCES) {
      for (const t of scoreTargets(world, a)) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        targets.push(t);
      }
    }
  }

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

  // ── 2. FLIGHT: ballistic, then the HIVE cells, then land ──────────────────
  /**
   * THE TARGETS ARE TESTED AFTER THE INTEGRATION AND BEFORE THE LANDING, and that ordering is
   * the whole of "did it go in". A shot is offered to the geometry at the position and
   * velocity it actually has this tick — descending, over the opening — which is what
   * `hiveAccepts` is written against. Testing before the step would ask about last tick's arc;
   * testing after the landing would mean an element that reached the CELL at 59 in had already
   * been put on the floor.
   *
   * ⚠️ A LAUNCHED ELEMENT NEVER ENTERS A FLOWER (owner ruling 2026-09-12). FLOWER scoring is the
   * Box Tube's proximity placement (stage 5c) and nothing else, so the flower branch that used to
   * sit here is gone; `flowerAccepts` (`flower.ts`) stays as a pure function. A lob that comes
   * down over a FLOWER lands beside it (`land` clears the foot).
   *
   * A miss is NOT a foul (G417.H) but it is no longer NOTHING: an element that meets the HIVE
   * structure anywhere but the taking cell's mouth BOUNCES OFF IT and drops beside it
   * (`hiveDeflect`, after the capture test below) — the shot taken from the pivot side that the
   * open-face gate in `hiveAccepts` refuses hits the closed back and comes down next to the
   * cell, instead of passing through the assembly and landing downrange.
   */
  for (const b of world.balls) {
    if (b.state.kind !== 'flight') continue;
    // WHO THREW IT, read before the arc is stepped because `park` replaces `b.state` below.
    // Absent on an old snapshot and on anything that did not come out of `releasePollen`; see
    // the CELL branch for what that fallback means.
    const launchedBy = b.state.by;
    // where it WAS, for the structure test: a face is something you cross, not somewhere you are
    const prev: Vec3 = { x: b.pos.x, y: b.pos.y, z: b.z };
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.z += b.vz * dt;
    b.vz -= C.GRAVITY * dt;
    // a POLLEN thrown at the wall lands against it rather than through it
    clampPollenToWalls(b);
    const vel = { x: b.vel.x, y: b.vel.y, z: b.vz };

    /**
     * CAPTURE RUNS OFF `scoreTargets()`, WHICH IS THE ONE GEOMETRY AUTHORITY FOR A TARGET.
     *
     * Lane B aims at that list, the gallery draws from the same constants, and now the
     * capture test walks it too — so "where the opening is" and "what counts as going in"
     * cannot drift apart. A target this list does not carry is one nothing can score in.
     *
     * `mouth` is the target's OUTWARD normal (`state.ts`), and it is the approach-side
     * constraint for a CELL: the up-cell is open at its OUTER end only (field-plan §2.1), so
     * the only way in is a shot arriving over that lip and running down the tray toward the
     * pivot. `hiveAccepts` says the same thing through `hiveApproachSign`, and the smoke lane
     * pins the two together (`field.ts`) rather than letting them be two descriptions of one
     * face that can drift. The FLOWER targets on the list are skipped: nothing launched enters one.
     */
    let took = false;
    for (const t of targets) {
      const owner = HIVE_OF.get(t.id);
      // a FLOWER target is skipped: nothing launched enters one (owner ruling 2026-09-12).
      if (!owner) continue;
      /**
       * A CELL TAKES ONLY ITS OWN ALLIANCE'S ELEMENT (owner ruling 2026-09-12, field-plan
       * §2.1). Nothing in the manual bans launching into the opponent's up-CELL, and the
       * geometry does not stop you — the two HIVES are 25.5 in apart and either opening is
       * reachable from most of the field — so without this a red robot could TIP blue's cell
       * and hand them the 20. The ruling is that it simply does not go in: the shot MISSES,
       * which here means falling through to the landing at the bottom of the loop and coming
       * to rest as a ground element. It is not a foul and it is not special-cased anywhere
       * else.
       *
       * An element with no `by` is accepted by either cell. That is every flight in DECODE
       * and Chain Reaction, and any BIOBUZZ snapshot recorded before the field stamped it —
       * refusing those would silently break replays of matches that were legal when they were
       * played.
       */
      if (launchedBy && launchedBy !== owner) continue;
      const hive = bb.hives[owner];
      if (!hiveAccepts(hive, owner, b.pos, b.z, vel)) continue;
      // PARKED IN THE CELL THAT TOOK IT, which through a swing is not always `up`
      // (`hiveTakingSide`): before the release it is the tray still holding its load, after it
      // the tray coming up. Reading `hive.up` here would draw a post-release capture inside the
      // cell it is NOT in, on the far side of the pivot.
      park(b, t.id, hive.contents, hiveCellPos(owner, hiveTakingSide(hive)), CELL_MID_Z);
      took = true;
      break;
    }
    if (took) continue;

    /**
     * THE STRUCTURE (owner feedback, 2026-09-13). Either HIVE — a red shot can hit blue's
     * assembly, and a refused shot at the opponent's cell is the commonest way to. `hiveDeflect`
     * is an ENTRY test, so an element the capture loop refused over the taking cell (already
     * inside the footprint, at the mouth) is left to drop through, and one that met a side, the
     * underside or the pivot is put back on that surface with a dumped velocity and falls from
     * there. At most one hive can be entered in one tick — they are 25.5 in apart.
     */
    for (const a of ALLIANCES) {
      const hit = hiveDeflect(bb.hives[a], a, prev, { x: b.pos.x, y: b.pos.y, z: b.z }, vel);
      if (!hit) continue;
      b.pos = { x: hit.pos.x, y: hit.pos.y };
      b.z = hit.pos.z;
      b.vel = { x: hit.vel.x, y: hit.vel.y };
      b.vz = hit.vel.z;
      break;
    }

    if (b.z <= 0) land(b, b.pos.x, b.pos.y);
  }

  // ── 3. THE HIVES ──────────────────────────────────────────────────────────
  /**
   * The swing, the spill and the TIP — three moments of one see-saw, and `hive.ts` keeps them
   * apart (see `hiveStep`). This is the only thing that writes `hives[a]`, and it is where a
   * spilled element re-enters the world.
   *
   * A SPILLED ELEMENT COMES BACK AS A GROUND ARTIFACT CARRYING THE SPILL VELOCITY. It leaves
   * the tray over the cell's open outer end and lands just outboard of the cell centre, and it
   * arrives ALREADY MOVING (`BB_SPILL_SPEED`, aimed within `BB_SPILL_FAN` of outboard), so it
   * rolls out from under its own structure the way the manual describes — G409: it "hits the
   * TILE floor before it is collected" — rather than sitting in a pile under the down cell. The
   * fan is narrow (owner feedback, 2026-09-12): a spill runs STRAIGHT-ISH outboard and most of
   * what spreads it is the elements pushing each other apart once they are on the tiles, which
   * the shared solve below does on the very tick they land there.
   *
   * GROUND AND NOT FLIGHT, which is a decision about WHO OWNS IT from here: a ground element
   * belongs to `solveArtifacts` from the very next stage of this same tick, so a spill that
   * lands on a robot, on another element or against the structure is resolved by the one
   * position authority instead of by the ballistic step above. `spillPoses` reports the tray
   * height (`BB_HIVE_BOTTOM_Z`) as its `pos.z` and the drop is not simulated: nothing in this
   * game scores or fouls on an element's height between the tray and the tiles, and a 25-inch
   * fall the solve cannot see is a second position authority for a third of a second.
   *
   * The RNG is the world's seeded chain, drawn four times per spilled element in
   * `spillPoses`' own order, which is what makes a spill identical on every peer and in every
   * replay.
   */
  for (const a of ALLIANCES) {
    const res = hiveStep(bb.hives[a], dt, kindOf);
    if (res.spilled.length > 0) {
      const poses = spillPoses(bb.hives[a], a, res.spilled.length, () => nextRandomValue(world));
      res.spilled.forEach((id, i) => {
        const ball = ballById.get(id);
        if (!ball) return; // a dangling id: nothing to put back, and nothing to break over
        const p = poses[i];
        ball.state = { kind: 'ground' };
        ball.pos = { x: p.pos.x, y: p.pos.y };
        ball.vel = { x: p.vel.x, y: p.vel.y };
        ball.z = 0;
        ball.vz = 0;
      });
      world.events.push(`${a.toUpperCase()} HIVE SPILLS ${res.spilled.length}`);
    }
    bb.hives[a] = res.hive;
    if (res.tipped) {
      // NO POINTS ARE ADDED HERE. The TIP is worth 20 (Table 10-2) and the score pass counts
      // them off `hives[a].tips`, recomputed from the world every tick like CR's — so a
      // replayed or reconciled tick cannot bank a tip twice. Scoring is the RULES lane's file
      // (`docs/biobuzz/prompts.md`, "A4 split"); what happens HERE is the entitlement the tip
      // earns, which is the human player's and therefore this lane's: one NECTAR entry.
      bb.nectarDue[a] += 1;
      world.events.push(`${a.toUpperCase()} HIVE TIP`);
    }
  }

  // ── 4. GROUND: roll, then meet the robots ─────────────────────────────────
  /**
   * ROLLING RESISTANCE AND THE REST SNAP ARE THE SHARED CORE'S — `stepGroundBall`
   * (`src/sim/physics.ts`), the same call `src/sim/world.ts` makes at the same point in the
   * tick, with the same `BALL_ROLL_FRICTION` / `BALL_REST_SPEED`. It is VELOCITY ONLY and moves
   * nothing, so it is not a second position authority: it sets the speed the solve below starts
   * from, which is exactly the contract its own comment states.
   *
   * It is NOT optional and it is NOT cosmetic. `solveArtifacts` runs in a plane with no
   * gravity, so there is no floor contact for Rapier to bleed speed through — a POLLEN it has
   * pushed keeps that speed forever. Measured with this call missing: five seconds after the
   * robot stopped, `pile-slow`'s pile was still travelling at 18.98 in/s and `wall-row-sweep`'s
   * row at 19.54, and nothing in any scene ever came to rest.
   *
   * BIOBUZZ's own `BB_POLLEN_FRICTION` (42) and `BB_POLLEN_REST_SPEED` (1.5) are deleted rather
   * than passed in. The shared numbers (32 / 2) are tuned for a 5" artifact and a 3" POLLEN may
   * well want different ones — but that is a shared-constant question for the repo owner, and a
   * BIOBUZZ copy of them is the two-descriptions-of-one-contact bug in another costume. See
   * `docs/biobuzz/feedback/000-solver-observations.md`.
   */
  for (const b of world.balls) if (b.state.kind === 'ground') stepGroundBall(b, dt);

  // THE INTAKES: the rollers PULL, then swallow whatever has arrived at the throat. Nothing
  // here moves a POLLEN — the pull is a VELOCITY, handed to the solve below, which is still the
  // one position authority. Per ROBOT in array order (a captured element is `held` and cannot
  // be taken twice), and BEFORE the solve so an element at the roller is drawn in rather than
  // plowed by the frame arriving behind it.
  for (const rob of world.robots) intakeTick(world, rob, cmds.get(rob.id), enabled);

  // ── 4b. INTAKE OFF A FLOWER (G418.B) ──────────────────────────────────────
  // After the ground capture, so a robot that took a loose element this tick has spent its
  // `lastIntakeAt` on it; before the solve, which never sees a parked or held element either way.
  for (const rob of world.robots) {
    if (rob.passive) continue;
    retrieveFromFlower(world, bb, rob, cmds.get(rob.id), enabled, ballById, kindOf);
  }

  // ── 5. SOLVE ──────────────────────────────────────────────────────────────
  /**
   * THE SHARED ARTIFACT SOLVE, AT THE POLLEN RADIUS, AND IT IS THE ONLY WRITER OF A GROUND
   * POLLEN'S POSITION. No integrator above it, no separation pass and no eviction after it: the
   * perimeter, every robot's chassis, its intake structure and the pollen it is holding are all
   * colliders in this one solve, so there is nothing left to take turns with. The only pass
   * after it is the perimeter invariant, which it does not hold on its own.
   *
   * It reads `world.balls` itself and only touches GROUND pollen, which is why it runs after
   * the capture pass rather than before it — a POLLEN taken this tick is already `held` and is
   * out of the solve by the time it runs.
   *
   * Driven the way `src/sim/world.ts` drives it: the robot solids are built ONCE from the held
   * pollen at `BB_POLLEN_R` (a full hopper is a physical plug in the mouth, and the plug has to
   * be the size of a POLLEN), the two DECODE-only exemption sets are empty (see this file's
   * header), and each chassis is swept from the pose `step.ts` captured before the drivetrain
   * ran to where the robot solve put it (`from`, which is REQUIRED — see the parameter).
   *
   * THE SOLIDS COME FROM THE GAME, NOT FROM DECODE. `GameSimModule.artifactSolids` is the seam
   * (`src/games/types.ts`), read here the way every optional slot is read — the module's if it
   * has one, the shared `robotSolids` unchanged if it does not. BIOBUZZ fills it with
   * `bbRobotSolids`, because the shared geometry is DECODE's front funnel and a BIOBUZZ sweeper
   * is a roller bar on whichever edge `intakeMount` names: run through the shared shapes, a
   * back-sweeper robot met its POLLEN through wedges it does not have while the edge its roller
   * is on had nothing solid at all. DECODE and CR leave the slot empty and are untouched.
   */
  const heldBalls = world.balls.filter((b) => b.state.kind === 'held');
  const mod = simModuleFor(world.game);
  const solids = new Map<number, RobotSolids>();
  for (const rob of world.robots) {
    solids.set(
      rob.id,
      mod.artifactSolids
        ? mod.artifactSolids(rob, heldBalls, BB_POLLEN_R)
        : robotSolids(rob, heldBalls, BB_POLLEN_R),
    );
  }
  solveArtifacts(world, dt, biobuzzColliders, NO_IDS, NO_IDS, solids, from, BB_POLLEN_R);
  // ...then the perimeter invariant, which the solve does not hold on its own — see
  // `clampPollenToWalls`, where the measured penetration without this is written down.
  for (const b of world.balls) if (b.state.kind === 'ground') clampPollenToWalls(b);

  // ── 5b. MECHANISMS: THE LAUNCHER AIMS ─────────────────────────────────────
  // ⚠️ A MECHANISM IS NOT WIRED BECAUSE ITS FUNCTION EXISTS AND ITS TESTS PASS. `bbSlewTurret`
  // once had no caller at all and the removed lift's step had only smoke callers, so both were
  // green on code no match could reach. The checks that matter step the WORLD.
  //
  // AFTER THE SOLVE AND BEFORE THE LAUNCH, both deliberately: a launcher aims from where the
  // chassis ENDED the tick, and a turret that has slewed this tick fires on this tick's bearing.
  //
  // The result rides a LOCAL map to stage 6 (`BbShot`) rather than a `RobotState` field: it is
  // read one stage after it is written, and a per-tick robot field is wire cost on every
  // snapshot to every client.
  const shots = new Map<number, BbShot>();
  for (const rob of world.robots) {
    if (rob.passive) continue; // a practice dummy has no mechanisms to run
    // THE RAMP TOGGLE — here, alongside the turret slew, because both are per-tick mechanism
    // updates that run after the solve and before the launch. UNLIKE the turret's own tracking
    // just below, a ramp press IS driver control (like drive/intake/fire) and is gated on
    // `enabled`, so a press during `pre`/a phase transition/`post` is dropped, not queued.
    bbRampStep(rob, cmds.get(rob.id), enabled, world.time);
    // THE SWING GUARD, right after the toggle — the 2D half of it (`bbRampSwingStep2d`).
    bbRampSwingStep2d(world, rob);
    // A TURRET TRACKS WHETHER OR NOT THE ROBOTS ARE ENABLED. `robotsEnabled` gates DRIVER
    // CONTROL — drive, intake, fire — and a turret auto-tracking is none of those; `bbLaunch`
    // still refuses to fire while disabled. Spawn aims a turret at FIELD CENTRE, so gating this
    // on `enabled` would start every match with a swing off that bearing on the first live tick.
    const launcher = bbLauncherOf(rob.spec, BB_HOOD_DEFAULT_DEG);
    // AIM ASSIST (owner, 2026-09-13): the NEARER cell of the own HIVE, and whether a shot would
    // land in it is asked of a copy of the HIVE with THAT cell up and settled — the assist knows
    // where the cells are, not which way the HIVE will be tilted when the shot arrives, and not
    // how many elements are already on their way. The real capture (stage 2) still reads the real
    // HIVE, so a shot at a down or swinging cell misses.
    /**
     * A PASS RETARGETS THE SAME SOLVER (`bbPassTargetOf`) and is judged differently: it is a
     * delivery to a point on the tiles, so “will it land” is `sol.reachable` and nothing more.
     * The hive's pretend-tilt, the cell side and `bbTurretShotEnters` are all about arriving
     * through a HOLE and mean nothing here — `pretend` is therefore still built from the HIVE
     * target, never from the pass one, or `bbCellSideOf` would be asked which side of a floor
     * point is open. TURRETED BUILDS ONLY: a dumper heaves its whole hopper a short way into a
     * cell and is not a passing mechanism, so it ignores the button.
     */
    const passing = enabled && bbIsTurreted(launcher) && (cmds.get(rob.id)?.bbPass ?? false);
    const target = passing ? bbPassTargetOf(rob) : bbAimTarget(world, rob);
    const pretend = bbPretendHive(bb.hives[rob.alliance], bbCellSideOf(bbAimTarget(world, rob)));
    // `lands` is read only while the driver is holding fire (or pass), so only then is it predicted.
    const asking = enabled && ((cmds.get(rob.id)?.fire ?? false) || passing) && rob.hopper.length > 0;
    // A SETPOINT FLYWHEEL ramps, and its preset button steps, every tick (nothing for any other
    // build). BEFORE the landing prediction, so it predicts the speed the wheel has this tick.
    flyStep(rob, cmds.get(rob.id), enabled, world.time, dt);
    if (launcher.kind === 'fixed') {
      // A FIXED LAUNCHER lands when the release it would make NOW — at this tick's wheel speed,
      // along the chassis it does not aim — runs forward into the pretend-up cell. The assist
      // turns the chassis while fire is held (step.ts); nothing here can change the arc's reach.
      shots.set(rob.id, { target, speed: [], lands: [asking && bbFixedShotEnters(pretend, rob, dt)] });
    } else if (bbIsTurreted(launcher)) {
      // EVERY TURRET: one for a single turret, both for a double (POLLEN turret 0, NECTAR 1).
      const speed: (number | undefined)[] = [];
      const lands: boolean[] = [];
      const exits: readonly (0 | 1)[] = launcher.kind === 'twinturret' ? [0, 1] : [0];
      for (const which of exits) {
        const sol = bbTurretSolution(rob, target, which);
        bbSlewTurret(rob, sol?.yaw ?? null, sol?.pitch ?? null, dt, which);
        speed[which] = sol?.speed;
        // WILL IT LAND — `bbTurretShotEnters`, the ONE predicate `shotPath.ts` draws off.
        lands[which] = passing
          ? asking && !!sol && sol.reachable && bbTurretOnTarget(rob, sol, which)
          : asking && !!sol && sol.reachable && bbTurretShotEnters(pretend, rob, which, sol.speed, dt);
      }
      shots.set(rob.id, { target, speed, lands });
    } else {
      // A DUMPER lands when the chassis is within `BB_AIM_TOL` of its aim heading (the assist
      // steers it there while fire is held — step.ts) AND every throw of the dump runs forward
      // into the pretend-up cell. 2D's dump CONVERGES (`cluster` false) — see `BbShot.cluster`.
      shots.set(rob.id, {
        target,
        speed: [],
        lands: [asking && bbDumpShotEnters(pretend, rob, target, rob.hopper.length, false, dt)],
      });
    }
  }

  // ── 5c. THE BOX TUBE PLACES ───────────────────────────────────────────────
  /**
   * FLOWER SCORING IS PROXIMITY PLACEMENT (owner ruling 2026-09-12): a point on the robot
   * (`bbPlacePointLocal`) near a FLOWER ring, and one button per element kind — `bbPlace` for a
   * POLLEN, `bbPlaceNectar` for a NECTAR. There is no raise and no height.
   *
   * EDGE-TRIGGERED through `bb.held[r.id]` (`placeP` / `placeN` — namespaced, because the penalty
   * engine keeps `g417warned` in the same per-robot map). The latch is updated EVERY tick — out
   * of reach, without a tube, and while disabled (step.ts hands a disabled robot a zero command)
   * — so a button held while driving INTO reach does not place: only a fresh press does. Only
   * TRUE keys are stored.
   *
   * G410 (`penalties.ts`) bills a NECTAR found in a stack before the 1:00 cue on its own, as a
   * state predicate, so nothing here has to announce the placement.
   */
  for (const rob of world.robots) {
    if (rob.passive) continue;
    const c = cmds.get(rob.id);
    placeLatch(world, bb, rob, 'placeP', enabled && !!c?.bbPlace, false, kindOf);
    placeLatch(world, bb, rob, 'placeN', enabled && !!c?.bbPlaceNectar, true, kindOf);
  }

  // ── 6. LAUNCH ────────────────────────────────────────────
  for (const rob of world.robots) {
    if (rob.passive) continue; // a practice dummy has no mechanisms to run
    bbLaunch(world, rob, cmds.get(rob.id) ?? ZERO_CMD, enabled, shots.get(rob.id));
  }

  // ── 7. THE HUMAN PLAYERS ──────────────────────────────────────────────────
  /**
   * NECTAR ENTERS THE FIELD FROM A PAIR OF HANDS, ON A BUTTON PRESS (field-plan §2.4, G426).
   *
   * Each alliance sets up with five NECTAR in its ALLIANCE AREA (`nectarStock`, staged by
   * `spawn.ts` as `state.kind === 'stock'` balls that are already sitting on their entry spot).
   * A press of `RobotCommand.bbNectar` puts ONE of them on the tiles, and the press is granted
   * iff the alliance has stock AND is entitled to an entry:
   *   · a completed TIP earns ONE entry (`nectarDue`, incremented in stage 3), or
   *   · TELEOP has `BB_FLOWER_UNLOCK_S` (60 s) or less left, at which point the whole
   *     remaining stock may go in.
   * Otherwise the press does nothing at all — no foul, no queue, no "it will happen in a
   * moment" — and `nectarWhy` says which of the three refusals it was.
   *
   * ── IT WAS A DRIP, AND THE DRIP WAS THE BUG ────────────────────────────────
   * This used to be a clock: a TIP set `nectarTimer` and the sim put the nectar out 1.5 s
   * later on its own, and the 1:00 cue ran the remaining stock out at one per second. It
   * worked, and it decided the one thing about the entitlement that is actually a decision.
   * A real drive team SAVES entries — you hold the last two until your robot is at the zone to
   * collect them, because a NECTAR sitting in the LOADING ZONE is a NECTAR the opponent can
   * also drive to. A timer spends them the instant they are earned. So the beat is gone,
   * `BB_NECTAR_ENTRY_S` / `BB_NECTAR_DUMP_S` / `nectarTimer` with it, and the human player is
   * now exactly as fast as the driver who presses the button.
   *
   * ENTRY IS A STATE FLIP, NEVER A SPAWN. The element already exists in `world.balls` — that
   * is what makes conservation a count over ONE array across the whole match (`state.ts`), and
   * it is why an entered NECTAR does not need an id: `stock` → `ground` is the entry.
   *
   * EITHER ROBOT MAY PRESS, AND A TICK ENTERS AT MOST ONE PER ALLIANCE. The edge is remembered
   * PER ROBOT (`bb.held[id].nectarPress`) rather than per alliance, so one driver holding the
   * button down does not swallow their partner's press — a per-alliance latch would do exactly
   * that, and the bug would only ever appear with two humans on one alliance. The ENTRY is per
   * alliance and capped at one a tick: the human player is one person, and two simultaneous
   * presses are one instruction shouted twice. Robots are walked in `world.robots` order, so
   * which of two same-tick presses wins is deterministic and replays identically.
   *
   * NOTHING ENTERS WHILE THE FIELD IS FROZEN. `enabled` is the shared "robots may run" flag,
   * which is false in `pre`, in the auto→teleop transition and after the buzzer; a human player
   * reaching over the wall during the transition is exactly what G426 forbids. `step.ts`
   * already zeroes every command while disabled, so through the real pipeline the button
   * cannot even be pressed — the explicit gate below is for the smoke lane and any other
   * direct caller of this function, which pass their own command map.
   */
  bbHumanPlayerTick(world, bb, cmds, enabled);

  // ── 8. SCORE + ENDGAME ────────────────────────────────────────────────────
  /**
   * THE FLOOR, NOT THE SCORE. Every Table 10-2 row — TIPS, CELL contents, the FLOWERS, the
   * GARDEN, LEAVE and PARK — is the RULES lane's, recomputed from the world in its own file
   * (`docs/biobuzz/prompts.md`, "A4 split"); this lane's job ended at putting the elements
   * where the score pass can count them.
   *
   * What stays here is the ZEROING, and it is not a stub: it runs BEFORE that pass every tick,
   * so the score pass only ever ADDS to a clean slate and a stale non-zero from a snapshot,
   * a reconcile or an older build cannot survive into a live world. Remove it and a score
   * becomes a running total that never comes down when the field does.
   */
  for (const rob of world.robots) bb.endgame[rob.id] = 'none';
  for (const a of ALLIANCES) {
    bb.scored[a] = 0;
    bb.points[a] = 0;
    world.match.scores[a].total = world.match.scores[a].foulPoints;
  }
}

/** the per-robot flag map in `bb.held`, or `null` when there is none OR the entry is not an
 * object — `bb.held` is plain JSON off the wire, and a smoke wire test writes a NUMBER there. */
function heldFlags(bb: BiobuzzState, id: number): Record<string, boolean> | null {
  const f = bb.held[id] as unknown;
  return typeof f === 'object' && f !== null ? (f as Record<string, boolean>) : null;
}

/** one place button's edge latch — see stage 5c. Fires `placeInFlower` on a fresh press only,
 * and stores the latch as a TRUE key or no key at all. */
function placeLatch(
  world: World,
  bb: BiobuzzState,
  rob: RobotState,
  key: 'placeP' | 'placeN',
  pressed: boolean,
  nectar: boolean,
  kindOf: (id: number) => BbElementKind,
): void {
  const was = heldFlags(bb, rob.id)?.[key] === true;
  if (pressed && !was) placeInFlower(world, bb, rob, nectar, kindOf);
  if (pressed) {
    let f = heldFlags(bb, rob.id);
    if (!f) {
      f = {};
      bb.held[rob.id] = f;
    }
    f[key] = true;
  } else {
    const f = heldFlags(bb, rob.id);
    if (f && key in f) delete f[key];
  }
}

/**
 * PLACE one held element of the named kind into the FLOWER this robot's Box Tube is in reach of.
 * Returns whether it happened; every refusal is an ordinary outcome, not an error:
 *  · no Box Tube, or no FLOWER ring within `BB_PLACE_TOL` of the placement point;
 *  · nothing of that kind in the hopper;
 *  · the FLOWER is full (`flowerFits`).
 *
 * The element is the LAST of that kind in `r.hopper`, taken through `takeHeld` so the hopper and
 * the held set stay one multiset, and `park`ed into the stack at the height it rests at
 * (`flowerStackZ`). A NECTAR placed makes its alliance the FLOWER's owner by the ordinary stack
 * rule (`flowerScore`), whoever placed it.
 */
export function placeInFlower(
  world: World,
  bb: BiobuzzState,
  rob: RobotState,
  nectar: boolean,
  kindOf: (id: number) => BbElementKind,
): boolean {
  if (!bbLiftOf(rob.spec)) return false;
  const i = bbFlowerInReach(world, rob);
  if (i === null) return false;
  let color: Artifact['color'] | null = null;
  for (let j = rob.hopper.length - 1; j >= 0; j--) {
    const c = rob.hopper[j];
    if ((c === 'red' || c === 'blue') === nectar) {
      color = c;
      break;
    }
  }
  if (color === null) return false;
  const stack = bb.flowers[i].stack;
  const kind: BbElementKind = color === 'red' || color === 'blue' ? color : 'pollen';
  if (!flowerFits(stack, kindOf, bbElementRadius(kind))) return false;
  const ball = takeHeld(world, rob, color);
  if (!ball) return false;
  const zs = flowerStackZ([...stack, ball.id], kindOf);
  const f = BB_FLOWERS[i];
  park(ball, `flower:${i}`, stack, { x: f.x, y: f.y }, zs[zs.length - 1]);
  return true;
}

/**
 * WHICH FLOWER'S RETRIEVAL OPENING one of this robot's intake mouths can actually REACH INTO,
 * or `null` — ARCHETYPE-AWARE (owner, 2026-09-20: "intaking from the flower should now only be
 * done if it is physically possible"). `reach` is the hardware box the caller already resolved
 * (`bbFlowerReachOf(bbIntakeKindOf(spec), bbRampSettled(...))`) — a sweeper, or a folded / still-
 * swinging ramp, has no reach at all and the caller bails before this ever runs.
 *
 * ⚠️ **THE "TIP LINE" `config.ts`'s ARCHETYPE NUMBERS ARE MEASURED FROM IS THE MOUTH'S OWN
 * OUTWARD BOUND (`ax.uOut`), NOT THE BARE CHASSIS FRAME.** The frame face (`ax.dist`) reads
 * right off `BB_PLACE_REACH`'s own derivation ("a chassis face flush on the flower foot") and a
 * first pass measured from there — every number in `config.ts`'s header still checks out against
 * it, because a pure call can put the chassis anywhere. It cannot in a real match: `bbFootprint`
 * (`footprintExtents`) grows the Rapier collision box on this SAME edge by the sweeper's own
 * `bbIntakeReach` (3–5in, every archetype's shared base hardware), so the chassis FRAME can never
 * close nearer than that — measured, a robot driven flush against the foot settles with its frame
 * ~5.2–5.4in from the ring, past every archetype's reach, and the retrieve TUTORIAL STEP (which
 * drives a real robot in) never completed. `ax.uOut` is exactly the footprint's own edge (for an
 * END mouth it is `hl + bbIntakeReach`, the same sum `bbFootprint.front` is), so a robot driven
 * flush rests with `uOut` ON the foot's own face — `u ≈ BB_PLACE_REACH`, the SAME number, reached
 * by the collision the field actually enforces rather than by a pose only a test can reach.
 *
 * For each mouth (`bbMouths`, the same rects the ground capture uses) this puts the FLOWER's ring
 * CENTRE — not a padded point on the foot — into that mouth's own frame (`mouthAxes`: `n`/`p` the
 * mouth's outward/lateral axes) and asks two things: the POLLEN's centre sits within `reach.half`
 * of the mouth's centreline (or the mouth's own half-span, for a full-width part like the ramp),
 * and the X-BITE — `bbBites` — the overlap of `reach.out` against the POLLEN's own `[u − r, u + r]`
 * reaches at least `BB_FLOWER_BITE`.
 *
 * VERIFIED NUMERICALLY at `u = BB_PLACE_REACH` (flush, `standoff = 0`): the sweeper's reach is
 * `null`, so it never gets a box to test at all; the ramp bites **2.04 in** in x and **1.02 in**
 * in z (`BB_RAMP_L`/`BB_RAMP_ANGLE` lengthened 2026-09-20 — see `config.ts`'s own header). The
 * standoff a build may back off flush and still bite (`BB_FLOWER_BITE`, 0.5 in of overlap) is
 * **≈1.54 in** for the ramp, pinned by the ROBOT lane's own standoff checks and the pure
 * CAD-geometry block next to them.
 *
 * ⚠️ **SIDE ROLLERS ARE `edgeGrip`, NOT `half`** (owner, 2026-09-20: "situated on the edges of the
 * robot, not near the center. It is to funnel things from the edge"). The pair sits at
 * `±bbSideRollerY(ax.half)`, 12–17 in apart on a real chassis, which cannot straddle a 2.8-in
 * POLLEN — so `reach.half` (a band about the mouth's CENTRELINE) is the wrong test for this
 * hardware. `reach.edgeGrip` set means ONE wheel does the gripping: the lateral test becomes
 * "is the POLLEN's centre within `edgeGrip` of EITHER wheel's own axis"
 * (`min(|v − wy|, |v + wy|) ≤ edgeGrip`), so a driver lines an END of the intake up on the
 * opening rather than the middle of it.
 */
/** which FLOWER, and through which of this robot's mouths — the richer answer `flowerRetrieve3d`
 * needs (3D only) to place a physically-released ramp POLLEN in that SAME mouth's own frame,
 * rather than re-deriving it. `bbFlowerAtIntake` below is the thin `.i`-only mirror every other
 * caller (2D, and the 3D gate check itself) has always used. */
export interface BbFlowerIntakeHit {
  i: number;
  ax: BbMouthAxes;
}

/**
 * How the gate is asked. `pre6`: a replay recorded before `SIM_PATCH` 6 (`importSideRollersPre6`),
 * which places an import's side rollers by the standard rule and measures them from the roller
 * line in 2D too. `twoD`: the caller is 2D's `retrieveFromFlower`.
 */
export interface BbFlowerGateOpts {
  pre6?: boolean;
  twoD?: boolean;
}

export function bbFlowerAtIntakeMouth(r: RobotState, reach: BbFlowerReach, opts: BbFlowerGateOpts = {}): BbFlowerIntakeHit | null {
  const mouths = bbMouths(r.spec);
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const pre6 = opts.pre6 ?? false;
  for (let i = 0; i < BB_FLOWERS.length; i++) {
    const f = BB_FLOWERS[i];
    const local = rot({ x: f.x - r.pos.x, y: f.y - r.pos.y }, -r.heading);
    for (const m of mouths) {
      const ax = mouthAxes(m, hl, hw);
      const v = local.x * ax.p.x + local.y * ax.p.y - ax.vc;
      const u = local.x * ax.n.x + local.y * ax.n.y - ax.uOut;
      if (reach.edgeGrip !== undefined) {
        // SIDE ROLLERS ARE A SOLID WHEEL NOW, SO THE GATE IS CONTACT, NOT A LATERAL BAND PLUS A
        // SEPARATE X-BITE (owner, 2026-09-20: "it should also be colliding with everything. It
        // is a physical thing"). `reach.out`'s own midpoint is the wheel's axis past the tip
        // line; each wheel sits at `±bbSideRollerY(ax.half)` off the centreline (an IMPORT's
        // inside its own hull, `bbSideRollerOffsets`); the POLLEN is
        // gripped when its centre is within `edgeGrip` (a RADIUS — `BB_SIDE_ROLLER_GRIP`) of
        // EITHER wheel's own axis, in the full (u, v) plane. Same predicate in 2D (which has no
        // solid wheel, so the robot CAN overlap) and 3D (`flowerRetrieve3d` calls this same
        // function) — see `config.ts`'s own header on `BB_SIDE_ROLLER_R` for why the box-BITE
        // test this replaced stopped matching a real drive-in once the wheel became solid.
        const [wl, wr] = bbSideRollerOffsets(r.spec, ax, pre6);
        let uw = (reach.out[0] + reach.out[1]) / 2;
        /**
         * ⚠️ **AN IMPORT IN 2D IS MEASURED FROM ITS HULL'S FRONT** (`SIM_PATCH` 6). The 2D FLOWER
         * foot is one solid rectangle, with no retrieval window in it. A standard robot's 2D
         * footprint ends at the roller line and its wheel (drawing only) overlaps the foot by
         * `BB_SIDE_ROLLER_PROTRUDE`; an import's hull HOLDS its CAD wheels, so the hull's front,
         * `BB_SIDE_ROLLER_PROTRUDE` past the roller line, is what meets the foot, and the wheel
         * axis then sat 3.88 in from the ring axis against a 3.25 grip: 2D took a POLLEN only
         * when a yawed corner happened to swing a wheel in. In 3D the body ends at the roller line
         * and the wheel goes that far into the window (`bbImportClipReach`), so 2D credits the
         * same depth.
         */
        if (opts.twoD && !pre6 && r.spec.imported) uw += BB_SIDE_ROLLER_PROTRUDE;
        const near = Math.min(hyp(u - uw, v - wl), hyp(u - uw, v + wr));
        if (near > reach.edgeGrip) continue;
        return { i, ax };
      }
      if (Math.abs(v) > (reach.half ?? ax.half)) continue;
      if (bbBites(reach.out[0], reach.out[1], u, BB_POLLEN_R)) return { i, ax };
    }
  }
  return null;
}

export function bbFlowerAtIntake(r: RobotState, reach: BbFlowerReach, opts: BbFlowerGateOpts = {}): number | null {
  return bbFlowerAtIntakeMouth(r, reach, opts)?.i ?? null;
}

/**
 * INTAKE OFF A FLOWER — G418.B: a ROBOT may "only remove POLLEN from the bottom of a FLOWER".
 *
 * A running intake (the same `autoIntake || cmd.intake` the ground capture reads) whose archetype
 * can physically reach the opening (`bbFlowerReachOf`) with a mouth on it (`bbFlowerAtIntake`)
 * pulls the BOTTOM element into the hopper — only when it is a POLLEN (`flowerRetrieve`: a 3.6-in
 * NECTAR does not pass the 3.55-in opening, so a NECTAR at the bottom LOCKS the FLOWER), only with
 * hopper room, only when the Z-BITE (`bbBites`, `reach.z` against the bottom element's own centre
 * height — `ball.z`, already a centre in this model, see `flowerStackZ`) reaches, and at most one
 * per `BB_FLOWER_RETRIEVE_S`, paced off `lastIntakeAt` (which the ground capture also stamps) so a
 * stack does not empty in four ticks.
 *
 * The element goes through `capturePollen`, so the hopper and the held set stay one multiset and
 * every intake rule applies. What is left in the stack is RE-SLOTTED and re-seated
 * (`flowerStackZ`): `slot` is what `bbIndexElements` rebuilds the stack from, and the column drops
 * by the element removed — except above a NECTAR seated on the middle ring, which the geometry
 * already holds up.
 */
export function retrieveFromFlower(
  world: World,
  bb: BiobuzzState,
  rob: RobotState,
  cmd: RobotCommand | undefined,
  enabled: boolean,
  ballById: ReadonlyMap<number, Artifact>,
  kindOf: (id: number) => BbElementKind,
): boolean {
  if (!enabled || !(rob.autoIntake || (cmd?.intake ?? false))) return false;
  if (world.time - rob.lastIntakeAt < BB_FLOWER_RETRIEVE_S) return false;
  if (rob.hopper.length >= bbHopperCap(rob.spec)) return false;
  const reach = bbFlowerReachOf(bbIntakeKindOf(rob.spec), bbRampSettled(rob, world.time));
  if (!reach) return false; // a sweeper, or a ramp not yet settled: nothing to reach with
  const i = bbFlowerAtIntake(rob, reach, { pre6: importSideRollersPre6(world), twoD: true });
  if (i === null) return false;
  const flower = bb.flowers[i];
  const { id } = flowerRetrieve(flower.stack, kindOf);
  if (id === null) return false;
  const ball = ballById.get(id);
  if (!ball) return false;
  if (!bbBites(reach.z[0], reach.z[1], ball.z, BB_POLLEN_R)) return false;
  const was = ball.state;
  ball.state = { kind: 'ground' };
  if (!capturePollen(world, rob, ball)) {
    ball.state = was; // refused (an intake rule said no): the element never left the FLOWER
    return false;
  }
  flower.stack.splice(0, 1);
  const zs = flowerStackZ(flower.stack, kindOf);
  flower.stack.forEach((sid, k) => {
    const b = ballById.get(sid);
    if (!b || b.state.kind !== 'element') return;
    b.state = { ...b.state, slot: k };
    b.z = zs[k];
  });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE RAMP SWING GUARD — 2D's half (owner, 2026-09-20: "if it collides with the flower or any
// non-moving solid thing as it is being deployed, it should fold back up... same with
// un-deploying"). See `sim3d/elements3d.ts`'s `bbRampSwingStep3d` for the 3D twin, which tests the
// SWINGING shape against real Rapier statics at the current eased angle; 2D has no z and no
// partial-swing geometry (`docs/area/biobuzz.md`: "2D stays DRAWING-ONLY"), so this tests the
// FULL DEPLOYED FOOTPRINT — the flat rect a `ramp` build's reach already draws from
// (`BB_RAMP_REACH`) — against the 2D field's own static rects, every tick a swing is in flight
// (which covers "at the press" for free: the press tick is the first tick `bbRampSwingProgress`
// returns non-null for).
// ─────────────────────────────────────────────────────────────────────────────

/** the ramp's flat, fully-deployed footprint rect's 4 corners, in WORLD space, for one mouth. */
function bbRampFootprintCorners(rob: RobotState, ax: BbMouthAxes): Vec2[] {
  const corners: Vec2[] = [];
  for (const u of [ax.uOut, ax.uOut + BB_RAMP_OUT]) {
    for (const v of [ax.vc - ax.half, ax.vc + ax.half]) {
      const local = { x: u * ax.n.x + v * ax.p.x, y: u * ax.n.y + v * ax.p.y };
      const w = rot(local, rob.heading);
      corners.push({ x: rob.pos.x + w.x, y: rob.pos.y + w.y });
    }
  }
  return corners;
}

/** SAT overlap between an arbitrary (already WORLD-space) quad and an axis-aligned rect — every
 * 2D BIOBUZZ static (`biobuzzColliders.statics`) carries `rot: 0`, so the rect's own two axes are
 * always world x/y and need no per-static rotation. `extraAxes` are the quad's own edge normals
 * (the ramp rect's, rotated to the robot's current heading). */
function bbSatOverlap(quad: readonly Vec2[], rect: { x0: number; x1: number; y0: number; y1: number }, extraAxes: readonly Vec2[]): boolean {
  const rectCorners: Vec2[] = [
    { x: rect.x0, y: rect.y0 },
    { x: rect.x1, y: rect.y0 },
    { x: rect.x1, y: rect.y1 },
    { x: rect.x0, y: rect.y1 },
  ];
  const axes: Vec2[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, ...extraAxes];
  for (const ax of axes) {
    let aMin = Infinity;
    let aMax = -Infinity;
    for (const c of quad) {
      const p = c.x * ax.x + c.y * ax.y;
      aMin = Math.min(aMin, p);
      aMax = Math.max(aMax, p);
    }
    let bMin = Infinity;
    let bMax = -Infinity;
    for (const c of rectCorners) {
      const p = c.x * ax.x + c.y * ax.y;
      bMin = Math.min(bMin, p);
      bMax = Math.max(bMax, p);
    }
    if (aMax < bMin || bMax < aMin) return false;
  }
  return true;
}

function bbRampSwingStep2d(world: World, rob: RobotState): void {
  if (rob.bbRampBlocked) return;
  const e = bbRampSwingProgress(rob, world.time);
  if (e === null) return; // no swing in flight — settled either way
  const hl = rob.spec.length / 2;
  const hw = rob.spec.width / 2;
  const edgeAxes = [rot({ x: 1, y: 0 }, rob.heading), rot({ x: 0, y: 1 }, rob.heading)];
  let hit = false;
  for (const m of bbMouths(rob.spec)) {
    const ax = mouthAxes(m, hl, hw);
    const corners = bbRampFootprintCorners(rob, ax);
    for (const s of biobuzzColliders.statics) {
      const rect = { x0: s.tx - s.hx, x1: s.tx + s.hx, y0: s.ty - s.hy, y1: s.ty + s.hy };
      if (bbSatOverlap(corners, rect, edgeAxes)) {
        hit = true;
        break;
      }
    }
    if (hit) break;
  }
  if (hit) {
    const elapsed = world.time - (rob.bbRampAt ?? world.time);
    bbRampReverse(rob, world.time, elapsed);
  }
}

/**
 * AIM ASSIST'S TARGET — the NEARER of the robot's OWN HIVE's two CELLS, as if that cell were up
 * (owner, 2026-09-13).
 *
 * ⚠️ IT DOES NOT KNOW WHICH CELL IS UP, ON PURPOSE. It used to aim at the real up cell and an
 * auto-fire released a shot whenever the up cell would take it, holding back when the elements
 * already in the air would tip it. No robot can sense either of those things. So the assist aims
 * at the nearer cell, whichever way the HIVE is tilted, and stage 5b asks whether a shot would
 * land in THAT cell pretending it is up and settled (`bbCellSideOf` → a copy of the HIVE). The
 * driver decides when to shoot; the capture in stage 2 reads the real HIVE, so a shot at a cell
 * that is down, or that tips before the shot arrives, misses.
 *
 * ⚠️ OWN HIVE ONLY. An element launched by the other alliance does not enter a CELL (owner ruling
 * 2026-09-12), and the two HIVES are 25.5 in apart across field centre, so on the far side of the
 * centreline the opponent's HIVE is nearer — nearest-over-both would aim at a target no shot can
 * score in. Never a FLOWER either: nothing launched enters one.
 *
 * The two cells open in opposite directions (`mouth` is ±y), so from between them the nearer cell
 * is on its CLOSED side. The assist still points there, and no shot from there lands
 * (`hiveAccepts` needs an inboard arrival), so fire simply does nothing.
 */
/**
 * WHERE A PASS THROWS — the player's own point, or the preset.
 *
 * ⚠️ **IT NEVER READS THE PARTNER'S POSE.** Owner, 2026-09-21: “in real life, you can't know
 * where your opponent is accurately. So, people should be able to choose a point to shoot
 * towards, but there should also be a simple preset.” A pass that tracked the partner would
 * be an aimbot for the one thing a real driver has to eyeball, so the target is a FIXED point.
 *
 * TWO WAYS TO SET IT, and the more specific one wins:
 *   1. `spec.bbPassTarget` — an arbitrary point dropped on the field map.
 *   2. `spec.bbPassPreset` — a NAMED spot (`passTargets.ts`), absent meaning the default.
 *
 * ⚠️ THE FALLBACK USED TO BE THE LOADING ZONE and is now `pastGoal`. That is the owner's own
 * correction (2026-09-22: "Pass should be passing towards the other side of the goal at a
 * specific point"), and the geometry backs it: an alliance's two robots start at OPPOSITE ENDS
 * with the hive between them, so the far side of the hive is where a partner is and the loading
 * zone is not. `passTargets.ts` carries the measurement.
 */
export function bbPassPoint(r: RobotState): Vec2 {
  const t = r.spec.bbPassTarget;
  if (t && Number.isFinite(t.x) && Number.isFinite(t.y)) return { x: t.x, y: t.y };
  const preset = isBbPassPreset(r.spec.bbPassPreset) ? r.spec.bbPassPreset : BB_PASS_PRESET_DEFAULT;
  return bbPassPresetPoint(preset, r.alliance, r.pos);
}

/**
 * The pass point as a `ScoreTarget`, so the ONE turret solver answers it too. `alliance` is
 * null (it scores nothing — it is a delivery), `z` is an element resting on the tiles, and `r`
 * is the POLLEN radius: a pass is judged by whether the arc REACHES, not by entering a hole,
 * so there is no `face` and nothing here pretends the hive is tilted.
 */
export function bbPassTargetOf(r: RobotState): ScoreTarget {
  return { id: 'pass', alliance: null, pos: bbPassPoint(r), z: BB_POLLEN_R, r: BB_POLLEN_R };
}

export function bbAimTarget(world: World, r: RobotState, passing = false): ScoreTarget {
  if (passing) return bbPassTargetOf(r);
  void world; // the pick is geometry alone — which cell is up is exactly what it must not read
  const north = hiveCellTarget(r.alliance, 'north');
  const south = hiveCellTarget(r.alliance, 'south');
  const dn = (north.pos.x - r.pos.x) ** 2 + (north.pos.y - r.pos.y) ** 2;
  const ds = (south.pos.x - r.pos.x) ** 2 + (south.pos.y - r.pos.y) ** 2;
  return ds < dn ? south : north;
}

/** which cell of its HIVE a `hiveCellTarget` is — its mouth opens along its own side. */
export function bbCellSideOf(t: ScoreTarget): 'north' | 'south' {
  return (t.mouth?.y ?? t.pos.y) < 0 ? 'south' : 'north';
}

/**
 * ⚠️ **THE HIVE AS AIM ASSIST BELIEVES IT** — a copy of `hive` with `side` up and settled.
 *
 * The assist knows where the cells are, not which way the HIVE will be tilted when the shot
 * arrives and not how many elements are already on their way (owner, 2026-09-13). The REAL
 * capture reads the real HIVE, so a shot at a down or swinging cell is released and misses,
 * which is what a driver would get on a real field.
 *
 * THE DRAWN PATH ASKS THIS SAME COPY (owner ruling, 2026-09-19 — `shotPath.ts`'s header). It used
 * to ask the REAL hive, which made the gate and the path differ by design; they are one verdict
 * now, and a path is drawn exactly when holding fire would release.
 */
export function bbPretendHive(hive: BiobuzzState['hives'][Alliance], side: 'north' | 'south'): BiobuzzState['hives'][Alliance] {
  return { ...hive, up: side, tipping: 0, released: false };
}

/**
 * ⚠️ **WOULD TURRET `which`'S SHOT GO IN — THE ONE PREDICATE, THREE READERS.**
 *
 * The release this turret would make RIGHT NOW (its CURRENT yaw and pitch, the muzzle's own
 * inherited velocity, at the speed `bbLaunch` will use), run forward through the flight stage.
 * A turret still slewing predicts a miss, so Aim Assist holds the shot; that is the whole of the
 * "wait for it" behaviour, and with the lead solve it is also what holds a shot through a
 * direction reversal, when the solution jumps faster than the barrel can follow.
 *
 * Stage 5b (2D), `sim3d/elements3d.ts` (3D) and `shotPath.ts` all call THIS — which is what makes
 * the dotted path and the fire gate one verdict rather than two that agree by inspection.
 */
export function bbTurretShotEnters(
  hive: BiobuzzState['hives'][Alliance],
  r: RobotState,
  which: 0 | 1,
  speed: number,
  dt: number,
  trace?: BbFlightTrace,
): boolean {
  const rel = bbTurretRelease(r, which, speed);
  // FROM `rel.z`, NOT `BB_LAUNCH_Z0`: a turret's muzzle is the hood lip and it drops as the
  // barrel elevates. Predicting from the wrong height is predicting a different shot.
  return bbFlightEnters(hive, r.alliance, rel.origin, rel.z, rel.vel, dt, trace);
}

/**
 * WOULD A FIXED LAUNCHER'S SHOT GO IN — the release it would make NOW (`bbFixedRelease`, at the
 * speed the wheel is turning this tick) run forward through the flight stage. Stage 5b, 3D's stage
 * 11 and `shotPath.ts` all ask this one predicate, the `bbTurretShotEnters` rule.
 */
export function bbFixedShotEnters(
  hive: BiobuzzState['hives'][Alliance],
  r: RobotState,
  dt: number,
  trace?: BbFlightTrace,
): boolean {
  const rel = bbFixedRelease(r, flyExitSpeed(r));
  return bbFlightEnters(hive, r.alliance, rel.origin, rel.z, rel.vel, dt, trace);
}

/** one band per BUILD (`bbFixedBand`) — a pure function of the spec, measured once */
const FIXED_BAND_CACHE = new Map<string, readonly [number, number] | null>();

/**
 * WHERE A FIXED LAUNCHER SCORES FROM — the range of distances (robot centre to cell centre, on the
 * cell's mouth axis, the robot facing it, parked, the wheel at its first setpoint) from which the
 * shot enters a settled up-cell: the run nearest the cell, or `null` when it scores from nowhere.
 * Measured by running `bbFixedShotEnters` itself at every inch, so it is the fire gate's own
 * answer and not a second ballistics. The AI stands in it (`ai/policy.ts`); smoke prints it.
 *
 * Cached per build, keyed on everything the release reads. Pure, so the cache cannot make two
 * machines disagree.
 */
export function bbFixedBand(spec: RobotSpec): readonly [number, number] | null {
  const l = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
  if (l.kind !== 'fixed') return null;
  const key = JSON.stringify([spec.length, spec.width, l, spec.flywheel, spec.imported?.hull, spec.imported?.mech, spec.imported?.heightIn]);
  const hit = FIXED_BAND_CACHE.get(key);
  if (hit !== undefined) return hit;
  const hive: BiobuzzState['hives'][Alliance] = { up: 'north', contents: [], tips: 0, tipping: 0, released: false };
  const cell = hiveCellTarget('blue', 'north');
  const face = bbFixedFacing(spec);
  const rpm = spec.flywheel?.rpm[0] ?? 0;
  // ...and only where the robot fits on the field: past the wall is a pose nobody can drive to.
  // The footprint's reach toward the wall (+y) at the pose the robot is parked in: its rear for a
  // front launcher, its FRONT (the sweeper's reach included) for a back one, a flank for a side one.
  const fp = bbFootprint(spec);
  const heading = -Math.PI / 2 - face;
  const sh = dsin(heading);
  const ch = dcos(heading);
  let toWall = 0;
  for (const [x, y] of [[fp.front, fp.half], [fp.front, -fp.half], [-fp.rear, fp.half], [-fp.rear, -fp.half]]) {
    toWall = Math.max(toWall, x * sh + y * ch);
  }
  let lo = -1;
  let hi = -1;
  for (let d = 4; cell.pos.y + d + toWall <= BB_HALF_Y + 1e-9; d++) {
    const r = {
      id: -1,
      alliance: 'blue',
      spec,
      pos: { x: cell.pos.x, y: cell.pos.y + d },
      heading,
      vel: { x: 0, y: 0 },
      angVel: 0,
      flyRpm: rpm,
    } as unknown as RobotState;
    if (bbFixedShotEnters(hive, r, C.SIM_DT)) {
      if (lo < 0) lo = d;
      hi = d;
    } else if (lo >= 0) {
      break;
    }
  }
  const band = lo < 0 ? null : ([lo, hi] as const);
  FIXED_BAND_CACHE.set(key, band);
  return band;
}

/**
 * WOULD THIS DUMP GO IN — every element of it, which is the same verdict a dump gets when it is
 * fired: one arc short is a dump that drops elements on the tiles.
 *
 * `cluster` picks the 3D CATAPULT solve (one fling, one velocity, parallel arcs) over the 2D
 * CONVERGING one, exactly as `BbShot.cluster` picks it at the release — see `bbDumpCluster`.
 * `traceMid` records the middle arc for the drawn path.
 */
export function bbDumpShotEnters(
  hive: BiobuzzState['hives'][Alliance],
  r: RobotState,
  target: ScoreTarget,
  n: number,
  cluster: boolean,
  dt: number,
  traceMid?: BbFlightTrace,
): boolean {
  // A DUMPER TURNS THE WHOLE ROBOT, and nothing fires until the chassis is there.
  const want = bbAimHeading(r, target);
  if (want === null || Math.abs(wrapAngle(want - r.heading)) >= BB_AIM_TOL) return false;
  if (cluster) {
    const fling = bbDumpCluster(r, target, n);
    if (!fling) return false;
    const mid = (fling.seats.length - 1) >> 1;
    for (let i = 0; i < fling.seats.length; i++) {
      // A DUMPER STAYS FLAT — no hood, no swing — but the BUCKET is two high, so the seat's own
      // release height is what each element of the cluster is predicted from.
      const st = fling.seats[i];
      const ok = bbFlightEnters(hive, r.alliance, st.pos, st.z, fling.vel, dt, i === mid ? traceMid : undefined);
      if (!ok) return false;
    }
    return true;
  }
  const throws = bbDumpSolution(r, target, n);
  if (!throws || throws.length === 0) return false;
  const mid = (throws.length - 1) >> 1;
  for (let i = 0; i < throws.length; i++) {
    const ok = bbFlightEnters(hive, r.alliance, throws[i].origin, bbDumpZ(r.spec), throws[i].vel, dt, i === mid ? traceMid : undefined);
    if (!ok) return false;
  }
  return true;
}

/**
 * WILL A FLIGHT ELEMENT ENTER `owner`'s up-CELL — stage 2 of this file, run forward, against the
 * `hive` it is given (Aim Assist hands it a copy with the aimed cell up — stage 5b).
 *
 * ⚠️ IT IS THE SAME STEP, IN THE SAME ORDER, AND IT HAS TO STAY THAT WAY: integrate position,
 * height, then gravity; the wall clamp; the `hiveAccepts` test; land at `z <= 0`. An element
 * released at tick N is first integrated at the start of tick N+1, and so is the first step here,
 * so a release predicted to enter a HIVE in that state does enter one. A predictor with its own
 * ballistics would be a second answer to "did it go in", and Aim Assist would release shots that
 * miss the cell it is aimed at.
 *
 * Pure: the element is copied, nothing in the world is written. `trace` is the ONE exception and
 * it is an OUT-PARAMETER the caller owns — see `BbFlightTrace`.
 */
export function bbFlightEnters(
  hive: BiobuzzState['hives'][Alliance],
  owner: Alliance,
  pos: Vec2,
  z: number,
  vel: Vec3,
  dt: number,
  trace?: BbFlightTrace,
): boolean {
  if (!(dt > 0)) return false;
  const b = { pos: { x: pos.x, y: pos.y }, vel: { x: vel.x, y: vel.y } } as Artifact;
  let zz = z;
  let vz = vel.z;
  // four seconds of flight is well past any arc a legal launch speed can make
  const steps = Math.ceil(4 / dt);
  if (trace) trace.n = 0;
  for (let i = 0; i < steps; i++) {
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    zz += vz * dt;
    vz -= C.GRAVITY * dt;
    clampPollenToWalls(b);
    if (trace && i % trace.every === 0) traceWrite(trace, b.pos.x, b.pos.y, zz);
    if (hiveAccepts(hive, owner, b.pos, zz, { x: b.vel.x, y: b.vel.y, z: vz })) {
      if (trace) traceWrite(trace, b.pos.x, b.pos.y, zz);
      return true;
    }
    if (zz <= 0) {
      if (trace) traceWrite(trace, b.pos.x, b.pos.y, zz);
      return false;
    }
  }
  return false;
}

/**
 * THE ARC A PREDICTED FLIGHT ACTUALLY FLEW — the optional out-parameter of `bbFlightEnters`, and
 * the reason the shot-path preview is not a second set of ballistics.
 *
 * `renderLanding.ts` used to carry a COPY of the loop above, because that one answers a boolean
 * and a drawn path needs positions; its own header said in as many words that the two would drift.
 * They are one loop again: a caller that wants the path hands in a buffer it owns, the sim writes
 * every `every`-th step into it plus the terminal point, and a caller that does not (every call in
 * the 2D and 3D pipelines) passes nothing and the branch is never taken.
 *
 * `pts` is `[x, y, z]` per point and is NEVER reallocated here — a short buffer simply stops being
 * written, so a preview cannot make the sim allocate. `n` is written back.
 */
export interface BbFlightTrace {
  /** caller-owned `[x,y,z]` triples, written in place */
  pts: Float32Array;
  /** record one point per `every` integration steps (≥ 1) */
  every: number;
  /** how many points were written (OUT) */
  n: number;
}

/** append one point to a trace, if its buffer still has room. */
function traceWrite(t: BbFlightTrace, x: number, y: number, z: number): void {
  const i = t.n * 3;
  if (i + 3 > t.pts.length) return;
  t.pts[i] = x;
  t.pts[i + 1] = y;
  t.pts[i + 2] = z;
  t.n++;
}

/**
 * THE AIM HOOK — the rotate override a turretless launcher gets while its fire button is held,
 * or `null` to leave the driver's rotate command alone.
 *
 * A dumper fires along one chassis EDGE, so "aim" means "turn the robot", and the
 * override has to replace the command before the drivetrain model runs (see `step.ts`, stage
 * 2). A turret aims itself and never gets an override — steering the chassis for a turret
 * would fight the driver for no benefit.
 *
 * A DUMPER: a P-controller on the heading error, dead-banded by `BB_AIM_TOL` so a robot already
 * lined up does not oscillate. A FIXED launcher: the shared chassis-aim controller
 * (`fixedAimTurn`, DECODE's fixed launcher uses the same one), which brakes onto the heading and
 * holds it — its arc is not re-solved for where the robot points, so it has to stand ON the line,
 * not somewhere inside a dead band. Both steer toward `bbAimTarget` — the nearer own cell,
 * whichever way the HIVE is tilted — exactly the cell stage 5b asks the shot to land in.
 */
export function bbAimAssist(
  world: World,
  r: RobotState,
  cmd: RobotCommand,
  enabled: boolean,
): number | null {
  if (!enabled || !cmd.fire || !r.aimAssist) return null;
  // a replay recorded before `SIM_PATCH` 4 keeps the fixed launcher's old aim: led by the muzzle's
  // spin velocity too, and the dumper's P-controller dead-banded at `BB_FIXED_AIM_TOL_PRE4`
  const pre4 = !C.simPatchAtLeast(world, 4);
  const want = bbAimHeading(r, bbAimTarget(world, r), pre4);
  if (want === null) return null; // turreted: the turret does this
  const err = wrapAngle(want - r.heading);
  const fixed = bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG).kind === 'fixed';
  if (fixed && !pre4) return fixedAimTurn(r, err);
  if (Math.abs(err) < (fixed ? BB_FIXED_AIM_TOL_PRE4 : BB_AIM_TOL)) return 0; // lined up — hold still rather than hunt
  return clamp(err * BB_AIM_GAIN, -1, 1);
}

/** the two DECODE-only exemption sets `solveArtifacts` takes, empty for BIOBUZZ and shared
 * rather than re-allocated per tick. See this file's header for why each is empty. */
const NO_IDS: ReadonlySet<number> = new Set<number>();

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

/**
 * THE HUMAN PLAYER, stage 7 of `updateBiobuzz` -- pulled out into its own exported function
 * (Day 1 3D seam, `docs/biobuzz/plan-3d.md` section 3.8) so `sim3d/elements3d.ts` can call the
 * SAME bookkeeping the 2D pipeline does, rather than a second copy of it. A PURE EXTRACTION:
 * the body below is byte-for-byte what stage 7 always did, called from exactly the point it
 * used to sit inline -- see `updateBiobuzz`'s stage 7 for why it runs where it does.
 *
 * Returns the NECTAR that entered this tick, per alliance (`null` when none did) -- the one
 * thing 2D never needed to know and 3D does: `land()` puts an entered element on the tiles at
 * `z = 0`, vel zero, which is correct for the 2D pipeline (nothing there simulates the drop)
 * and WRONG for 3D, where a NECTAR is meant to fall a short drop in from the human player's
 * hand (plan section 3.8) rather than appear already resting. `sim3d/elements3d.ts` uses the
 * return value to bump `z` on whichever ball actually entered, right after calling this; the
 * 2D call site in `updateBiobuzz` simply ignores it.
 */
export function bbHumanPlayerTick(
  world: World,
  bb: BiobuzzState,
  cmds: Map<number, RobotCommand>,
  enabled: boolean,
): Record<Alliance, Artifact | null> {
  const entered: Record<Alliance, Artifact | null> = { red: null, blue: null };
  const teleop = world.match.phase === 'teleop';
  // THE 1:00 CUE. Past it the alliance may enter everything it still holds — it is a larger
  // ENTITLEMENT, not a faster one, which is why it sits beside `nectarDue` in the test rather
  // than replacing it. `BB_FLOWER_UNLOCK_S` is the same 60 s G410 unlocks the FLOWERS at; one
  // cue, read in one place.
  const dumping = teleop && world.match.phaseTimeLeft <= BB_FLOWER_UNLOCK_S;
  // ONE ENTRY PER ALLIANCE PER TICK. A second robot's rising edge on the same tick is still
  // CONSUMED (its latch is written above the test) rather than ignored, so a partner holding
  // the button does not fire on the tick after.
  const enteredOnce: Record<Alliance, boolean> = { red: false, blue: false };

  for (const rob of world.robots) {
    if (rob.passive) continue; // a practice dummy has no drive team
    const a = rob.alliance;
    const latch = (bb.held[rob.id] ??= {});
    const now = enabled && (cmds.get(rob.id)?.bbNectar ?? false);
    const rising = now && !latch[NECTAR_PRESS_KEY];
    // A TRUE key, or NO key — the convention `placeLatch` sets for this same per-robot bag,
    // and what the lane's smoke asserts about it. `bb.held` is plain JSON on `world.biobuzz`,
    // so it rides every 30 Hz snapshot and every replay: a `false` parked under a robot id
    // for the rest of the match is bytes on the wire that say nothing.
    if (now) latch[NECTAR_PRESS_KEY] = true;
    else delete latch[NECTAR_PRESS_KEY];
    if (!rising || enteredOnce[a]) continue;
    if (bb.nectarStock[a] <= 0) continue;
    if (!(bb.nectarDue[a] > 0 || dumping)) continue;

    // OLDEST FIRST, by id. `world.balls` order is stable but is not a promise; the id is,
    // and the human player's five are staged consecutively (`spawn.ts`), so the lowest id
    // still in hand is the one that has been waiting longest.
    let next: Artifact | null = null;
    for (const ball of world.balls) {
      if (ball.state.kind !== 'stock' || ball.state.alliance !== a) continue;
      if (!next || ball.id < next.id) next = ball;
    }
    if (!next) {
      // the counter and the array disagree — trust the ARRAY, which is the conservation
      // authority, and stop claiming a stock that is not there.
      bb.nectarStock[a] = 0;
      bb.nectarDue[a] = 0;
      continue;
    }
    // The jitter is the world's seeded chain, drawn twice per entry, so five NECTAR entering
    // one LOADING ZONE make a small scatter rather than a stack of five discs on one tile —
    // and the same scatter on every peer. Drawn ONLY on an entry that actually happens: a
    // refused press must not advance the chain, or a client that predicted a refusal and a
    // server that granted it would disagree about every later draw in the match.
    const spot = bbLoadingZoneSpot(a, BB_NECTAR_R);
    const jx = (nextRandomValue(world) * 2 - 1) * NECTAR_ENTRY_JITTER;
    const jy = (nextRandomValue(world) * 2 - 1) * NECTAR_ENTRY_JITTER;
    land(next, spot.x + jx, spot.y + jy);
    entered[a] = next; // reported to the caller (sim3d/elements3d.ts sets the 3D fall height)
    bb.nectarStock[a] -= 1;
    // `max(0, …)`: in the dump window an alliance may enter stock it was never OWED, and a
    // negative debt would make the next TIP's entitlement free.
    bb.nectarDue[a] = Math.max(0, bb.nectarDue[a] - 1);
    enteredOnce[a] = true;
    world.events.push(`${a.toUpperCase()} NECTAR ENTERS`);
  }

  // WHY THE BUTTON WOULD REFUSE, recomputed for BOTH alliances every tick — AFTER the
  // entries above, so the HUD reads the situation the driver is now in rather than the one
  // they were in before their own press. Most permanent answer first: an empty stock never
  // becomes anything else, so it outranks a frozen field and a missing entitlement.
  for (const a of ALLIANCES) {
    if (bb.nectarStock[a] <= 0) {
      // owed an entry with nothing left to enter: the debt is void, not banked
      bb.nectarDue[a] = 0;
      bb.nectarWhy[a] = 'none-left';
    } else if (!enabled) {
      bb.nectarWhy[a] = 'locked';
    } else if (bb.nectarDue[a] > 0 || dumping) {
      bb.nectarWhy[a] = 'ok';
    } else {
      bb.nectarWhy[a] = 'none-owed';
    }
  }
  return entered;
}
