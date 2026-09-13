import type { Alliance, Artifact, RobotCommand, RobotState, Vec2, World } from '../../types';
import * as C from '../../config';
import { clamp, nextRandom, rot, wrapAngle } from '../../math';
import { solveArtifacts, type SweepFrom } from '../../sim/physicsEngine';
import { simModuleFor } from '../sim';
import { stepGroundBall } from '../../sim/physics';
import { robotSolids, type RobotSolids } from '../../sim/artifactSolids';
import {
  BB_AIM_GAIN,
  BB_AIM_TOL,
  BB_FLOWERS,
  BB_FLOWER_D,
  BB_FLOWER_FOOT,
  BB_FLOWER_RETRIEVE_PAD,
  BB_FLOWER_RETRIEVE_S,
  BB_FLOWER_UNLOCK_S,
  BB_HALF_X,
  BB_HALF_Y,
  BB_HIVE_OPEN_Z,
  BB_HOOD_DEFAULT_DEG,
  BB_LAUNCH_Z0,
  BB_NECTAR_R,
  BB_ON_TARGET_TOL,
  BB_POLLEN_R,
  BB_POLLEN_WALL_REST,
  bbHopperCap,
  bbLoadingZoneSpot,
} from './config';
import { biobuzzColliders } from './colliders';
import { FLOWER_MOUTH, capturePollen, scoreTargets, takeHeld } from './elements';
import { bbElementRadius, flowerFits, flowerRetrieve, flowerStackZ, type BbElementKind } from './flower';
import { hiveAccepts, hiveCellPos, hiveLoad, hiveStep, hiveTakingSide, hiveWillTip, spillPoses } from './hive';
import { bbIsTurreted, bbLauncherOf, bbLiftOf } from './mechs';
import {
  type BbShot,
  bbAimHeading,
  bbDumpSolution,
  bbFlowerInReach,
  bbLaunch,
  bbMouths,
  bbSlewTurret,
  bbTurretRelease,
  bbTurretSolution,
} from './robot';
import { rectContains, type BiobuzzState, type ScoreTarget, type Vec3 } from './state';

/**
 * BIOBUZZ GAMEPLAY TICK — POLLEN physics and the intake/launch loop.
 *
 * This is the shell's only real gameplay: pollen roll, settle, get collected, and get thrown
 * back out. There is no scoring, because Section 10 of the V0 manual is a Kickoff placeholder
 * (`scored: false` on the sim module says so at the seam). What there IS, and what has to be
 * right before anything is built on top of it, is a POLLEN model that CONSERVES COUNT and
 * NEVER LEAKS OUT OF THE FIELD under every input a driver can produce.
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
 * Resolve one ground POLLEN against one robot: CAPTURE IT, OR LEAVE IT ALONE.
 *
 * Capture and nothing else. There used to be a PLOW branch here — if the POLLEN was inside the
 * footprint and not collected, this pushed it out along the minimum-penetration axis by the
 * whole penetration depth and gave it the robot's speed. That was a SECOND POSITION WRITER for
 * a ground pollen, fighting the shared solve for the same element on the same tick, which is
 * the one thing the artifact rework on `alpha` forbids. It is gone. The chassis, the intake
 * structure and the held pollen are all colliders in `solveArtifacts` (via `robotSolids`), so
 * everything the plow was reaching for — a pollen shoved ahead of a driving frame, a pollen
 * squeezed against a wall popping out sideways — is the solve's own answer, computed from the
 * chassis sweep rather than from a normal guessed off a box.
 *
 * A POLLEN AT THE ROLLER IS STILL COLLECTED BEFORE THE FRAME REACHES IT, because this runs
 * BEFORE the solve in `updateBiobuzz`'s stage order. Driving into a pile collects it instead of
 * scattering it, which is the single biggest difference between an intake that feels real and
 * one that feels like a bulldozer.
 */
function interact(
  world: World,
  b: Artifact,
  rob: RobotState,
  cmd: RobotCommand | undefined,
  enabled: boolean,
): 'collected' | 'none' {
  const intakeActive = enabled && (rob.autoIntake || (cmd?.intake ?? false));
  if (!intakeActive) return 'none';
  const local = rot({ x: b.pos.x - rob.pos.x, y: b.pos.y - rob.pos.y }, -rob.heading);
  // ANY mounted edge grabs: one mouth for front/back, two for `side` (both flanks) and
  // `frontback` (both ends). `capturePollen` is what enforces the hopper cap, so a full robot
  // simply leaves the POLLEN on the floor for the solve to push around.
  for (const m of bbMouths(rob.spec)) {
    if (rectContains(m, local.x, local.y, BB_POLLEN_R) && capturePollen(world, rob, b)) return 'collected';
  }
  return 'none';
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

/**
 * How long after a TIP the human player's NECTAR reaches the tiles, and how fast the ≤ 60 s
 * dump runs, in seconds. APPROX, and local here rather than in `config.ts` for the same
 * reason `flower.ts`'s are: the manual sets the ENTITLEMENT (one per TIP, all remaining at
 * ≤ 60 s — G426) and says nothing about the hands. Moving them into `config.ts` is a one-line
 * import change when a real field says what a human player actually takes.
 */
export const BB_NECTAR_ENTRY_S = 1.5; // APPROX
export const BB_NECTAR_DUMP_S = 1.0; // APPROX

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
 *      auto-fire on the same tick cannot throw away the element being placed.
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
   * A miss is NOT a foul and not special-cased: an element that meets the structure anywhere
   * else simply keeps flying and lands on the tiles (G417.H), which is also what the open-face
   * gate in `hiveAccepts` produces for a shot taken from the pivot side.
   */
  for (const b of world.balls) {
    if (b.state.kind !== 'flight') continue;
    // WHO THREW IT, read before the arc is stepped because `park` replaces `b.state` below.
    // Absent on an old snapshot and on anything that did not come out of `releasePollen`; see
    // the CELL branch for what that fallback means.
    const launchedBy = b.state.by;
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
   * arrives ALREADY MOVING (`BB_SPILL_SPEED` outboard, `BB_SPILL_LATERAL` across), so it rolls
   * out from under its own structure the way the manual describes — G409: it "hits the TILE
   * floor before it is collected" — rather than sitting in a pile under the down cell.
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

  // CAPTURE. Nothing here moves a POLLEN — stage 4 is the one position authority, and this runs
  // first so a POLLEN at the roller is taken before the frame reaches it.
  for (const b of world.balls) {
    if (b.state.kind !== 'ground') continue;
    for (const rob of world.robots) {
      if (interact(world, b, rob, cmds.get(rob.id), enabled) === 'collected') break;
    }
  }

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
  // "is the own up-CELL still taking elements for a shot fired now" — once per alliance per tick,
  // and only when some robot asks, because it runs every in-flight element of that alliance
  // forward (`bbCellTaking`).
  const taking = new Map<Alliance, boolean>();
  const cellTaking = (a: Alliance): boolean => {
    let t = taking.get(a);
    if (t === undefined) {
      t = bbCellTaking(world, a, dt, kindOf);
      taking.set(a, t);
    }
    return t;
  };
  for (const rob of world.robots) {
    if (rob.passive) continue; // a practice dummy has no mechanisms to run
    // A TURRET TRACKS WHETHER OR NOT THE ROBOTS ARE ENABLED. `robotsEnabled` gates DRIVER
    // CONTROL — drive, intake, fire — and a turret auto-tracking is none of those; `bbLaunch`
    // still refuses to fire while disabled. Spawn aims a turret at FIELD CENTRE, so gating this
    // on `enabled` would start every match with a swing off that bearing on the first live tick.
    const launcher = bbLauncherOf(rob.spec, BB_HOOD_DEFAULT_DEG);
    const target = bbPickTarget(world, rob);
    // `scores` is read only by AUTO-FIRE, so only a robot that would auto-fire pays for predicting it.
    const predict = rob.autoFire && rob.hopper.length > 0 && target !== null;
    const hive = bb.hives[rob.alliance];
    if (bbIsTurreted(launcher)) {
      // EVERY TURRET: one for a single turret, both for a double (POLLEN turret 0, NECTAR 1).
      const speed: (number | undefined)[] = [];
      const onTarget: boolean[] = [];
      const scores: boolean[] = [];
      const exits: readonly (0 | 1)[] = launcher.kind === 'twinturret' ? [0, 1] : [0];
      for (const which of exits) {
        const sol = target ? bbTurretSolution(rob, target, which) : null;
        // `null` on either axis means "hold where you are" — a turret with nothing on its open
        // side stops rather than drifting.
        bbSlewTurret(rob, sol?.yaw ?? null, sol?.pitch ?? null, dt, which);
        speed[which] = sol?.speed;
        const yaw = which === 1 ? (rob.bbTurret2Heading ?? rob.turretHeading) : rob.turretHeading;
        const pitch = which === 1 ? (rob.bbTurret2Pitch ?? 0) : (rob.bbTurretPitch ?? 0);
        onTarget[which] =
          sol !== null &&
          sol.reachable &&
          Math.abs(wrapAngle(sol.yaw - yaw)) < BB_ON_TARGET_TOL &&
          Math.abs(sol.pitch - pitch) < BB_ON_TARGET_TOL;
        // WILL IT SCORE: the release this turret would make now (its current yaw and pitch, at the
        // speed `bbLaunch` will use), run forward through the flight stage, into a cell still taking.
        let will = false;
        if (predict && onTarget[which] && sol && cellTaking(rob.alliance)) {
          const rel = bbTurretRelease(rob, which, sol.speed);
          will = bbFlightEnters(hive, rob.alliance, rel.origin, BB_LAUNCH_Z0, rel.vel, dt);
        }
        scores[which] = will;
      }
      shots.set(rob.id, { target, speed, onTarget, scores });
    } else {
      // A DUMPER is on target when the chassis is within `BB_AIM_TOL` of its aim heading AND the
      // whole load has an accepted arc (`bbDumpSolution`). The assist steers it there (step.ts).
      // It WILL SCORE when, on top of that, every throw of the dump runs forward into a cell that
      // is still taking elements.
      let on = false;
      let will = false;
      if (target) {
        const want = bbAimHeading(rob, target);
        const throws =
          want !== null && Math.abs(wrapAngle(want - rob.heading)) < BB_AIM_TOL
            ? bbDumpSolution(rob, target, rob.hopper.length)
            : null;
        on = throws !== null;
        will =
          predict &&
          throws !== null &&
          cellTaking(rob.alliance) &&
          throws.every((t) => bbFlightEnters(hive, rob.alliance, t.origin, BB_LAUNCH_Z0, t.vel, dt));
      }
      shots.set(rob.id, { target, speed: [], onTarget: [on], scores: [will] });
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
   * NECTAR ENTERS THE FIELD FROM A PAIR OF HANDS, NOT FROM A SPAWNER (field-plan §2.4, G426).
   *
   * Each alliance sets up with five NECTAR in its ALLIANCE AREA (`nectarStock`, staged by
   * `spawn.ts` as `state.kind === 'stock'` balls that are already sitting on their entry spot).
   * Two things let one of them onto the tiles:
   *   · a completed TIP earns ONE entry (`nectarDue`, incremented in stage 3), and
   *   · at the 1:00 cue everything still in hand goes in, one at a time.
   * They compose rather than compete: the dump simply means the alliance is owed whatever it
   * still holds, so both paths run through the same counter and the same clock.
   *
   * ENTRY IS A STATE FLIP, NEVER A SPAWN. The element already exists in `world.balls` — that
   * is what makes conservation a count over ONE array across the whole match (`state.ts`), and
   * it is why an entered NECTAR does not need an id: `stock` → `ground` is the entry.
   *
   * THE BEAT IS A CLOCK ON THE WORLD (`nectarTimer`), not an `every N ticks` test on
   * `world.time`: a modulus on an accumulated float is a coin toss at the tick boundary, and a
   * countdown reconciles and replays correctly because it IS state. The jitter is the world's
   * seeded chain, drawn twice per entry, so five NECTAR entering a LOADING ZONE make a small
   * scatter rather than a stack of five discs on one tile — and the same scatter on every peer.
   *
   * NOTHING ENTERS WHILE THE FIELD IS FROZEN. `enabled` is the shared "robots may run" flag,
   * which is false in `pre`, in the auto→teleop transition and after the buzzer; a human player
   * reaching over the wall during the transition is exactly what G426 forbids.
   */
  if (enabled) {
    const teleop = world.match.phase === 'teleop';
    for (const a of ALLIANCES) {
      if (bb.nectarStock[a] <= 0) {
        bb.nectarDue[a] = 0; // owed an entry with nothing left to enter: the debt is void
        bb.nectarTimer[a] = 0;
        continue;
      }
      // THE 1:00 CUE. Past it the alliance is owed everything it still holds — it is not a
      // faster drip, it is a larger entitlement, which is why it writes `nectarDue` rather
      // than shortening the beat. `BB_FLOWER_UNLOCK_S` is the same 60 s G410 unlocks the
      // FLOWERS at; one cue, read in one place.
      const dumping = teleop && world.match.phaseTimeLeft <= BB_FLOWER_UNLOCK_S;
      if (dumping && bb.nectarDue[a] < bb.nectarStock[a]) bb.nectarDue[a] = bb.nectarStock[a];
      if (bb.nectarDue[a] <= 0) {
        bb.nectarTimer[a] = 0; // nothing owed — the next entry starts its beat when it is earned
        continue;
      }
      if (bb.nectarTimer[a] <= 0) bb.nectarTimer[a] = dumping ? BB_NECTAR_DUMP_S : BB_NECTAR_ENTRY_S;
      bb.nectarTimer[a] -= dt;
      if (bb.nectarTimer[a] > 0) continue;

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
        bb.nectarTimer[a] = 0;
        continue;
      }
      const spot = bbLoadingZoneSpot(a, BB_NECTAR_R);
      const jx = (nextRandomValue(world) * 2 - 1) * NECTAR_ENTRY_JITTER;
      const jy = (nextRandomValue(world) * 2 - 1) * NECTAR_ENTRY_JITTER;
      land(next, spot.x + jx, spot.y + jy);
      bb.nectarStock[a] -= 1;
      bb.nectarDue[a] -= 1;
      bb.nectarTimer[a] = 0;
      world.events.push(`${a.toUpperCase()} NECTAR ENTERS`);
    }
  }

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
function placeInFlower(
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
 * WHICH FLOWER'S RETRIEVAL OPENING one of this robot's intake mouths is up against, or `null`.
 *
 * The opening is at the BOTTOM of the FLOWER on its field side (§9.7 Fig 9-12, the 3.55-in hole
 * above the lower ring), so the point tested is the centre of the foot's FIELD-SIDE FACE: the ring
 * centre pushed `BB_FLOWER_FOOT.deep − BB_FLOWER_D` along `FLOWER_MOUTH`, which is where a robot
 * driven square into the foot has its roller. It must lie inside a mouth rect (`bbMouths`, the
 * same rects the ground capture uses), padded OUTWARD only by `BB_FLOWER_RETRIEVE_PAD` — so the
 * mounted edge has to be the one facing the FLOWER, and laterally the opening has to be within
 * the roller's span.
 */
export function bbFlowerAtIntake(r: RobotState): number | null {
  const out = BB_FLOWER_FOOT.deep - BB_FLOWER_D;
  const mouths = bbMouths(r.spec);
  for (let i = 0; i < BB_FLOWERS.length; i++) {
    const f = BB_FLOWERS[i];
    const n = FLOWER_MOUTH[f.wall];
    const local = rot({ x: f.x + n.x * out - r.pos.x, y: f.y + n.y * out - r.pos.y }, -r.heading);
    for (const m of mouths) if (rectContains(m, local.x, local.y, BB_FLOWER_RETRIEVE_PAD)) return i;
  }
  return null;
}

/**
 * INTAKE OFF A FLOWER — G418.B: a ROBOT may "only remove POLLEN from the bottom of a FLOWER".
 *
 * A running intake (the same `autoIntake || cmd.intake` the ground capture reads) with a mouth on
 * a FLOWER's retrieval opening (`bbFlowerAtIntake`) pulls the BOTTOM element into the hopper —
 * only when it is a POLLEN (`flowerRetrieve`: a 3.6-in NECTAR does not pass the 3.55-in opening,
 * so a NECTAR at the bottom LOCKS the FLOWER), only with hopper room, and at most one per
 * `BB_FLOWER_RETRIEVE_S`, paced off `lastIntakeAt` (which the ground capture also stamps) so a
 * stack does not empty in four ticks.
 *
 * The element goes through `capturePollen`, so the hopper and the held set stay one multiset and
 * every intake rule applies. What is left in the stack is RE-SLOTTED and re-seated
 * (`flowerStackZ`): `slot` is what `bbIndexElements` rebuilds the stack from, and the column drops
 * by the element removed — except above a NECTAR seated on the middle ring, which the geometry
 * already holds up.
 */
function retrieveFromFlower(
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
  const i = bbFlowerAtIntake(rob);
  if (i === null) return false;
  const flower = bb.flowers[i];
  const { id } = flowerRetrieve(flower.stack, kindOf);
  if (id === null) return false;
  const ball = ballById.get(id);
  if (!ball) return false;
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

/**
 * THE TARGET A ROBOT IS ACTUALLY TRYING TO SCORE IN, or `null` when there is not one.
 *
 * `scoreTargets()` reports every opening on the field, INCLUDING ones this robot should not
 * shoot at, and it is this function's job — not the field's — to say which of them is worth
 * turning toward.
 *
 * ⚠️ HIVE CELLS ONLY (owner ruling 2026-09-12). Launchers stopped auto-aiming at FLOWERS: a
 * FLOWER is scored only by the Box Tube's placement, and nothing launched ever enters one, so a
 * FLOWER on this list would be a target no shot can score in.
 *
 * ⚠️ **THE OPPONENT'S CELL MUST NOT BE AIMED AT, AND THE ALLIANCE FILTER BELOW STAYS.**
 * `scoreTargets(world, a)` no longer lists it (owner ruling 2026-09-12: an element launched by
 * the other alliance does not enter, so it is not a place `a` can score), which makes the
 * filter a second line of defence rather than the only one. It is kept because the failure it
 * prevents is severe and silent: the two HIVES sit at x = ∓`BB_HIVE_X`, **25.5 in apart**
 * across field centre, so a robot anywhere on the far side of the centreline is NEARER the
 * opponent's opening than its own, and nearest-by-distance cannot tell them apart. Before the
 * ruling, unfiltered, the aim assist would have held the robot pointed at the opponent's HIVE
 * and fed it on the driver's own fire button for as long as it was held; a future target list
 * that carries an opponent-owned opening for any other reason would do the same.
 *
 * ⚠️ **A TARGET IS ONLY A TARGET FROM ITS OPEN SIDE** (`ScoreTarget.mouth`). Every BIOBUZZ
 * target is a hole in something solid and `pos` alone does not say which side of that solid is
 * the open one: a FLOWER is a column standing against the perimeter, so from behind it the
 * "target" is the wall, and an up-CELL opens back along the axis its see-saw was tipped. An
 * arc solved from the closed side arrives through the floor of the cell or through the
 * perimeter — a shot that cannot be taken on a real field. The test is the half-space: the
 * robot must lie on the side `mouth` points to.
 *
 * WHETHER A SHOT SCORES IS NOT DECIDED HERE. Lane A owns the acceptance gate, including the
 * approach-side half of it; this is only about where a launcher POINTS, so the test is the
 * plain half-space rather than a second, competing copy of that gate. An ABSENT `mouth` is
 * "no constraint" and never a default direction — a plain volume (a zone, a basket open at the
 * top) has no approach side to report, and guessing one is the bug the field exists to stop.
 */
export function bbPickTarget(world: World, r: RobotState): ScoreTarget | null {
  let best: ScoreTarget | null = null;
  let bestD = Infinity;
  for (const t of scoreTargets(world, r.alliance)) {
    // HIVE cells only — a FLOWER is never a launch target.
    if (!HIVE_OF.has(t.id)) continue;
    // a target owned by the OTHER alliance scores nothing.
    if (t.alliance !== r.alliance) continue;
    const dx = t.pos.x - r.pos.x;
    const dy = t.pos.y - r.pos.y;
    // ON THE OPEN SIDE? `mouth` points OUT of the opening, so the vector from the target TO
    // the robot must agree with it. (dx,dy) points target-ward, hence the negation.
    if (t.mouth && -dx * t.mouth.x + -dy * t.mouth.y <= 0) continue;
    const d = dx * dx + dy * dy; // squared — no sqrt needed for a comparison
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/**
 * WILL A FLIGHT ELEMENT ENTER `owner`'s up-CELL — stage 2 of this file, run forward, against the
 * hive as it is now.
 *
 * ⚠️ IT IS THE SAME STEP, IN THE SAME ORDER, AND IT HAS TO STAY THAT WAY: integrate position,
 * height, then gravity; the wall clamp; the `hiveAccepts` test; land at `z <= 0`. An element
 * released at tick N is first integrated at the start of tick N+1, and so is the first step here,
 * so a release predicted to enter does enter unless the HIVE changes under it — which is what
 * `bbCellTaking` is for. A predictor with its own ballistics would be a second answer to "did it
 * go in", and auto-fire would fire on the wrong one.
 *
 * Pure: the element is copied, nothing in the world is written.
 */
export function bbFlightEnters(
  hive: BiobuzzState['hives'][Alliance],
  owner: Alliance,
  pos: Vec2,
  z: number,
  vel: Vec3,
  dt: number,
): boolean {
  if (!(dt > 0)) return false;
  const b = { pos: { x: pos.x, y: pos.y }, vel: { x: vel.x, y: vel.y } } as Artifact;
  let zz = z;
  let vz = vel.z;
  // four seconds of flight is well past any arc a legal launch speed can make
  const steps = Math.ceil(4 / dt);
  for (let i = 0; i < steps; i++) {
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    zz += vz * dt;
    vz -= C.GRAVITY * dt;
    clampPollenToWalls(b);
    if (hiveAccepts(hive, owner, b.pos, zz, { x: b.vel.x, y: b.vel.y, z: vz })) return true;
    if (zz <= 0) return false;
  }
  return false;
}

/**
 * WILL `owner`'s up-CELL STILL BE TAKING ELEMENTS when a shot fired now arrives?
 *
 * ── THROUGH A SWING, AUTO-FIRE RESUMES AT THE RELEASE (owner feedback, 2026-09-12) ─────────
 * No in the FIRST half. The cell has not refused since `hiveTakingSide` landed, but the tray
 * taking elements there is the one about to empty, so a shot fired into it is a shot thrown on
 * the floor two seconds later. The turret is already slewing to the incoming cell through this
 * window (`aimCell`, `elements.ts`); what holds is the trigger, not the aim.
 *
 * Yes in the SECOND half. The release hands the opening over to the incoming tray, and from
 * that instant a shot aimed at the cell the turret has been tracking for two seconds goes in
 * and stays in — `hiveStep` carries a post-release load through the settle. Waiting for the
 * settle instead threw away the two seconds the tracking existed to buy.
 *
 * ── AND NO WHEN THE LOAD IS ABOUT TO TIP ───────────────────────────────────────────────────
 * No when what is already in it PLUS every element of that alliance already in the air and
 * predicted to enter (`bbFlightEnters`) will tip it: the element that completes the load goes
 * in and starts the swing, so anything arriving after it reaches a tray on its way down. A shot
 * that would itself complete the load is fine — it is the one that goes in.
 *
 * Measured before this existed, a turret on a steady feed auto-fired 61 elements and 58 missed,
 * every one of them launched at a settled cell that the shots ahead of it were about to tip.
 */
export function bbCellTaking(
  world: World,
  owner: Alliance,
  dt: number,
  kindOf: (id: number) => BbElementKind,
): boolean {
  const bb = world.biobuzz as BiobuzzState | undefined;
  if (!bb) return false;
  const hive = bb.hives[owner];
  if (hive.tipping > 0 && !hive.released) return false;
  const load = [...hive.contents];
  for (const b of world.balls) {
    if (b.state.kind !== 'flight' || b.state.by !== owner) continue;
    if (bbFlightEnters(hive, owner, b.pos, b.z, { x: b.vel.x, y: b.vel.y, z: b.vz }, dt)) load.push(b.id);
  }
  return !hiveWillTip(hiveLoad(load, kindOf));
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
 * A P-controller on the heading error, dead-banded by `BB_AIM_TOL` so a robot already lined up
 * does not oscillate. Returning `null` when `bbPickTarget` finds nothing is the right answer
 * and not a failure: a robot with no scorable opening on its open side has nothing to be
 * steered toward, and the driver keeps their own rotate command.
 */
export function bbAimAssist(
  world: World,
  r: RobotState,
  cmd: RobotCommand,
  enabled: boolean,
): number | null {
  if (!enabled || !cmd.fire || !r.aimAssist) return null;
  const best = bbPickTarget(world, r);
  if (!best) return null;
  const want = bbAimHeading(r, best);
  if (want === null) return null; // turreted: the turret does this
  const err = wrapAngle(want - r.heading);
  if (Math.abs(err) < BB_AIM_TOL) return 0; // lined up — hold still rather than hunt
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
