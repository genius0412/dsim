import type { Alliance, Artifact, RobotCommand, RobotSpec, World } from '../../src/types';
import * as C from '../../src/config';
import { worldHash } from '../../src/net/checksum';
import { slimWorld, unslimWorld } from '../../src/net/protocol';
import { moduleFor } from '../../src/games';
import { simModuleFor } from '../../src/games/sim';
import { createChainWorld } from '../../src/games/chain/spawn';
import { chainStep } from '../../src/games/chain/step';
import { DEFAULT_ASSISTS, DEFAULT_SPEC } from '../../src/sim/spawn';
import {
  BB_CELL_OPEN,
  BB_FLOWERS,
  BB_FLOWER_TOP_Z,
  BB_HALF_X,
  BB_HALF_Y,
  BB_HIVE_BOTTOM_Z,
  BB_HIVE_CELL_DY,
  BB_HIVE_OPEN_Z,
  BB_HIVE_UP_STAGED,
  BB_NECTAR_R,
  BB_POLLEN_R,
  BB_POLLEN_SIM,
  BB_PTS,
} from '../../src/games/biobuzz/config';
import {
  BB_FLOWER_FLOOR_Z,
  BB_FLOWER_VOL_Z,
  bbElementRadius,
  flowerAccepts,
  flowerCapacity,
  flowerFits,
  flowerRetrieve,
  flowerScore,
  flowerStackZ,
  type BbElementKind,
} from '../../src/games/biobuzz/flower';
import {
  BB_HIVE_ACCEPT_MARGIN,
  BB_NECTAR_MASS,
  BB_TIP_LOAD,
  BB_TIP_SWING_S,
  bbElementMass,
  hiveAccepts,
  hiveCellPos,
  hivePivot,
  hiveLoad,
  hiveStep,
  otherSide,
  spillPoses,
  type HiveState,
} from '../../src/games/biobuzz/hive';
import { nextRandom } from '../../src/math';
import { BB_WALL_COUNT, biobuzzColliders } from '../../src/games/biobuzz/colliders';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import { updateBiobuzz } from '../../src/games/biobuzz/play';
import { bbFootprint } from '../../src/games/biobuzz/robot';
import { BB_IDLE, BB_SCENES, bbPollen, bbSceneAt, bbSceneStills, type Scene } from '../../src/games/biobuzz/scenes';
import { bbRobotSolids } from '../../src/games/biobuzz/robot';
import { robotPenetration } from '../../src/sim/artifactSolids';
import { solveArtifacts, type SweepFrom } from '../../src/sim/physicsEngine';
import { stepGroundBall } from '../../src/sim/physics';
import { maxMatchTicks } from '../../src/sim/replay';
import type { ServerMsg } from '../../src/net/protocol';
import { Room, type Client } from '../../server/room';
import { BB_DEFAULT_SPEC } from '../../src/games/biobuzz/robotConfig';
import { cmd, mkWorld, run, setup, type Check } from './harness';

/**
 * LANE A's smoke: THE FIELD.
 *
 * Registry integrity, the perimeter, containment, POLLEN conservation, determinism, the wire
 * round-trip, a headless server match, and the performance budget. Everything whose subject is
 * the field or the world rather than a mechanism.
 *
 * Every check here is one that would still be TRUE AND MEANINGFUL at Kickoff. Nothing asserts a
 * score, a zone or an element count, because Sections 8-11 of the V0 manual are placeholders
 * and a check written against a guess is worse than no check: it passes, so nobody looks, and
 * then it fails on Kickoff day for a reason that has nothing to do with a regression.
 */

/** The containment slop. `solveRobots` guarantees a robot that STARTED a tick inside cannot be
 * pushed out; it does not guarantee zero penetration at rest, because a soft contact resolves
 * over a few ticks. Half an inch is a resting contact; anything more is a robot leaving the
 * field, which is the bug this is looking for. */
const WALL_EPS = 0.5;

/**
 * THE STEP-COST BUDGET, as a multiple of a 2v2 Chain Reaction step. RE-READ when the pollen
 * solver changed, and the number moved for a reason worth recording.
 *
 * The plan wrote 1.2x, against a BIOBUZZ that ran CR's own bespoke ground integrator plus a
 * spatial-hash separation pass. POLLEN now ride the SHARED artifact solve, which builds a fresh
 * Rapier world every tick with one body per ground pollen plus every robot's artifact solids -
 * real physics where there used to be arithmetic. Measured as the median of five PAIRED rounds
 * on this machine, the ratio is ~1.3-1.5x where it used to sit under 1.2, and the absolute cost
 * is ~0.47 ms for a 2v2, i.e. under 3% of a 16.7 ms frame.
 *
 * 1.8 is that measurement plus room for a loaded CI box, and it is still a real budget: a
 * BIOBUZZ step that had genuinely doubled would fail. The ROOM check below deliberately keeps
 * 1.2, because a room tick also pays for the snapshot and CR's 300 particles make that side
 * much fatter - it measures 0.75x with plenty of margin.
 */
const STEP_BUDGET = 1.8;

/** the same budget for a whole SERVER room tick (`roomChecks`). See that check for why it
 * kept 1.2x where the step budget had to move. */
const ROOM_BUDGET = 1.2;

/**
 * How many PAIRED rounds a perf check runs. Five is the smallest odd count whose median still
 * survives two bad rounds, which is the failure this is built around: a laptop that thermally
 * throttles, or a gallery capture running in another process, contaminates a CONTIGUOUS stretch
 * of wall clock rather than a random sample.
 */
const PERF_ROUNDS = 5;

/** the middle value of a sample (the upper of the two for an even count — these are odd). */
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** the robot's axis-aligned half-extents at its current heading — the same measure the
 * solver's containment invariant is stated in (footprint INCLUDING intake reach, not the bare
 * chassis), so this check cannot pass a robot whose sweeper is through the wall. */
function aabb(r: { pos: { x: number; y: number }; heading: number; spec: RobotSpec }): {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
} {
  const e = bbFootprint(r.spec);
  const c = Math.cos(r.heading);
  const s = Math.sin(r.heading);
  const hx = (e.front + e.rear) / 2;
  const cx = r.pos.x + ((e.front - e.rear) / 2) * c;
  const cy = r.pos.y + ((e.front - e.rear) / 2) * s;
  const ax = Math.abs(hx * c) + Math.abs(e.half * s);
  const ay = Math.abs(hx * s) + Math.abs(e.half * c);
  return { x0: cx - ax, x1: cx + ax, y0: cy - ay, y1: cy + ay };
}

/**
 * How far a POLLEN's SKIN is past the nearest wall plane; 0 when it is inside.
 *
 * The measure rather than a boolean, because "it left the field" and "it left the field by two
 * inches" are different reports and the second is the one worth printing.
 */
const outBy = (b: Artifact): number =>
  Math.max(Math.abs(b.pos.x) - (BB_HALF_X - BB_POLLEN_R), Math.abs(b.pos.y) - (BB_HALF_Y - BB_POLLEN_R), 0);

/** the containment tolerance. Any soft solver leaves a hair of penetration in a resting
 * contact; a quarter inch on a 1.5" pollen is that, and anything more is a pollen leaving the
 * field, which is the bug these checks are looking for. */
const WALL_SLOP = 0.25;

/** how far two RESTING pollen may sit inside one another. A tenth of an inch on a 3" diameter
 * is the solver's resting slop, and the threshold is meaningful rather than generous: the same
 * measure reads 2.13" on a row being pressed into a wall (see the settle block). */
const OVERLAP_SLOP = 0.1;

/** the two DECODE-only exemption sets `solveArtifacts` takes — empty for BIOBUZZ, exactly as
 * `play.ts` passes them, so a check that drives the solve directly drives the same solve. */
const NO_IDS: ReadonlySet<number> = new Set<number>();

/** an EMPTY sweep map: every robot's start pose is its end pose, i.e. NO sweep at all. What a
 * caller with nothing to sweep now has to ask for explicitly, since `updateBiobuzz`'s `from` is
 * required — a scene with no robot, or the deliberately blind arm of the sweep check. */
const NO_SWEEP: ReadonlyMap<number, SweepFrom> = new Map<number, SweepFrom>();

/** a copy of `scene` whose stills are EVERY tick up to its last, so `bbSceneStills` - the ONE
 * stepping path - hands back the whole run in a single forward pass. Stepping a scene by hand
 * here would make these checks a check of a different run from the one the gallery draws. */
const everyTick = (scene: Scene): Scene => ({
  ...scene,
  stills: Array.from({ length: Math.max(...scene.stills) + 1 }, (_, i) => i),
});

export function fieldChecks(check: Check): void {
  // ── REGISTRY INTEGRITY ────────────────────────────────────────────────────
  // The module has to BE in the registry and be the right one. `moduleFor` falls back to
  // DECODE for an unknown id, which is the correct back-compat rule and also the reason this
  // check exists: an unregistered BIOBUZZ silently plays DECODE, and every other check in this
  // file would pass while testing the wrong game.
  {
    const mod = moduleFor('biobuzz');
    check('registry: moduleFor("biobuzz") resolves to the BIOBUZZ module', mod.id === 'biobuzz', `id=${mod.id}`);
    check('registry: BIOBUZZ declares scored:false (never persists ELO/records)', mod.scored === false);
    check('registry: BIOBUZZ declares startLegality:false (no published G304 analogue)', mod.startLegality === false);
    check(
      'registry: bounds are the 144x144 field',
      mod.bounds.halfX === BB_HALF_X && mod.bounds.halfY === BB_HALF_Y,
      `${mod.bounds.halfX}x${mod.bounds.halfY}`,
    );
    check('registry: every UI renderer slot is filled', typeof mod.drawField === 'function' && typeof mod.drawBalls === 'function' && typeof mod.drawRobot === 'function');
  }

  // ── THE PERIMETER ─────────────────────────────────────────────────────────
  {
    check('field: exactly four perimeter walls', BB_WALL_COUNT === 4, `count=${BB_WALL_COUNT}`);
    check('field: no dynamic colliders (BIOBUZZ has no known moving geometry)', biobuzzColliders.dynamic === undefined);
    // Every wall's INNER FACE must sit exactly on the bound it is the wall for. A wall placed
    // a hair inside shrinks the field silently; a hair outside leaves a gap a pollen rests in.
    const faces = biobuzzColliders.statics.map((w) =>
      w.hx < w.hy ? Math.abs(w.tx) - w.hx : Math.abs(w.ty) - w.hy,
    );
    check(
      'field: every wall inner face sits exactly on the field bound',
      faces.every((f, i) => Math.abs(f - (i < 2 ? BB_HALF_X : BB_HALF_Y)) < 1e-9),
      faces.join(', '),
    );
  }

  // ── WALL CONTAINMENT: drive at each wall for 3 s ──────────────────────────
  // Three seconds is well past however long the drivetrain needs to reach top speed and pin,
  // so this is a check on the SOLVER's containment invariant rather than on acceleration.
  // Each heading is run in its own world: a robot that has already been slammed into one wall
  // is not a clean starting state for the next.
  for (const [name, headingDeg, at] of [
    ['+x', 0, { x: 40, y: 0 }],
    ['-x', 180, { x: -40, y: 0 }],
    ['+y', 90, { x: 0, y: 40 }],
    ['-y', 270, { x: 0, y: -40 }],
  ] as const) {
    const w = mkWorld('free', 7);
    const r = w.robots[0];
    r.pos = { ...at };
    r.heading = (headingDeg * Math.PI) / 180;
    r.vel = { x: 0, y: 0 };
    run(w, cmd({ driveY: 1 }), 3);
    const b = aabb(r);
    const ok =
      b.x0 >= -BB_HALF_X - WALL_EPS &&
      b.x1 <= BB_HALF_X + WALL_EPS &&
      b.y0 >= -BB_HALF_Y - WALL_EPS &&
      b.y1 <= BB_HALF_Y + WALL_EPS;
    check(
      `containment: driving at the ${name} wall for 3 s keeps the footprint inside bounds`,
      ok,
      `x ${b.x0.toFixed(2)}..${b.x1.toFixed(2)} · y ${b.y0.toFixed(2)}..${b.y1.toFixed(2)}`,
    );
  }

  // ── THE START ANCHORS ARE INSIDE THE FIELD ────────────────────────────────
  /**
   * A robot spawned at any anchor, in either alliance, must be fully inside `bounds` BEFORE
   * anything steps.
   *
   * The anchors are hand-placed APPROX numbers (there is no published BIOBUZZ start geometry —
   * `startLegality: false`), and an anchor an inch too far out spawns a robot intersecting the
   * wall, which Rapier then resolves by shoving it — so the match begins with four robots
   * sliding. This is the cheapest possible guard on a number a human typed, and it is checked
   * on the FOOTPRINT, so an anchor that fits a bare chassis but not its sweeper fails here.
   */
  {
    const w = createBiobuzzWorld('match', 4, [
      setup(0, 'blue', {}, 0),
      setup(1, 'blue', {}, 1),
      setup(2, 'red', {}, 0),
      setup(3, 'red', {}, 1),
    ]);
    check('anchors: BIOBUZZ spawns four robots', w.robots.length === 4);
    for (const r of w.robots) {
      const b = aabb(r);
      const slack = Math.min(BB_HALF_X - Math.max(Math.abs(b.x0), Math.abs(b.x1)), BB_HALF_Y - Math.max(Math.abs(b.y0), Math.abs(b.y1)));
      check(
        `anchors: robot ${r.id} (${r.alliance}) starts fully inside bounds`,
        slack >= 0,
        `slack=${slack.toFixed(2)}"`,
      );
    }
    // The two anchors per alliance exist so an alliance's robots cannot spawn on top of each
    // other; a mirrored pair that collapsed to one point would pass every other check here.
    const blue = w.robots.filter((r) => r.alliance === 'blue');
    check(
      'anchors: the two anchors of an alliance are distinct',
      Math.hypot(blue[0].pos.x - blue[1].pos.x, blue[0].pos.y - blue[1].pos.y) > 18,
      `apart=${Math.hypot(blue[0].pos.x - blue[1].pos.x, blue[0].pos.y - blue[1].pos.y).toFixed(1)}"`,
    );
    // RED IS THE X-MIRROR OF BLUE, applied once in `spawn.ts`. Asserted because a second
    // mirror anywhere else would cancel this one and put both alliances on the same side.
    const red = w.robots.filter((r) => r.alliance === 'red');
    check(
      'anchors: RED is the x-mirror of BLUE',
      Math.abs(blue[0].pos.x + red[0].pos.x) < 1e-9 && Math.abs(blue[0].pos.y - red[0].pos.y) < 1e-9,
      `blue=${blue[0].pos.x},${blue[0].pos.y} red=${red[0].pos.x},${red[0].pos.y}`,
    );
  }

  // -- POLLEN CONSERVATION ---------------------------------------------------
  /**
   * A POLLEN MUST NEVER VANISH - the invariant every other pollen check is judged under.
   * Deletion is the failure mode a penetration test eventually reaches on its own, and it is
   * invisible in a screenshot.
   *
   * The loop drives `updateBiobuzz` DIRECTLY and sweeps the robot KINEMATICALLY rather than
   * through the drivetrain, so the sweep speed is a number this check sets rather than a
   * consequence of the gearing. The sweep ORIGIN is captured before the pose is written,
   * exactly as `step.ts` stage 0 does it - without it the solve gets no `from`, falls back to
   * the end pose, and the chassis is spawned already overlapping whatever it drove into (the
   * "balls go on top of the robot" failure).
   *
   * It used to run TWICE, once per `BB_BALL_SOLVER` arm. There is one solver now (the shared
   * `solveArtifacts` at `BB_POLLEN_R`) and `updateBiobuzz` has no solver argument to pass.
   */
  {
    const w = createBiobuzzWorld('free', 11, []);
    const rob = createBiobuzzWorld('free', 11, [setup(0, 'blue')]).robots[0];
    w.robots.push(rob);
    rob.heading = 0;
    rob.pos = { x: -BB_HALF_X + 12, y: 0 };
    const n0 = w.balls.length;
    const cmds = new Map<number, RobotCommand>([[rob.id, cmd({ driveY: 1, intake: false })]]);
    let everOut = 0;
    for (let i = 0; i < 600; i++) {
      const from = new Map([[rob.id, { x: rob.pos.x, y: rob.pos.y, heading: rob.heading }]]);
      rob.pos = { x: rob.pos.x + 40 * C.SIM_DT, y: 0 }; // 40 in/s straight across the field
      rob.vel = { x: 40, y: 0 };
      w.tick++;
      w.time += C.SIM_DT;
      updateBiobuzz(w, C.SIM_DT, cmds, true, from);
      // EVERY tick, not just the last one: a pollen can be pushed through a wall and pulled
      // back by the containment clamp within one tick, and a check that only looked at the end
      // of the run would never see it.
      for (const b of w.balls) if (b.state.kind === 'ground') everOut = Math.max(everOut, outBy(b));
    }
    check(
      'pollen: count conserved over 600 ticks of a robot sweeping the field',
      w.balls.length === n0 && n0 === BB_POLLEN_SIM,
      `${n0} -> ${w.balls.length}`,
    );
    check(
      'pollen: never left the field on ANY of those 600 ticks',
      everOut <= WALL_SLOP,
      `worst ${everOut.toFixed(3)}" past the wall plane`,
    );
  }

  // -- THE PERIMETER IS AN INVARIANT ON EVERY TICK OF EVERY PHYSICS SCENE ----
  /**
   * `solveArtifacts` holds the perimeter to within its own resting slop and `play.ts` holds the
   * rest (`clampPollenToWalls`). THAT CLAMP IS WHAT THIS CHECK IS FOR, and it is not
   * theoretical: measured with it removed, `wall-row-sweep` put a POLLEN **2.02" past the wall
   * plane** at tick 105 and `pile-fast` 1.52", because BIOBUZZ does not run DECODE's pin/round
   * loop and so nothing stops a chassis driving through the space a wall pollen occupies.
   * Delete the clamp and this check goes red on two scenes.
   *
   * EVERY TICK, NOT THE LAST ONE. A pollen shoved through a wall and pulled back within one
   * tick is invisible at the end of a run, and the worst frame in `wall-row-sweep` is tick 105
   * of 300. Each scene is stepped ONCE and every intermediate world is read, through
   * `bbSceneStills` - the same single stepping path the gallery and the hash checks use, so
   * this cannot be checking a run the pictures never showed.
   */
  for (const id of ['pile-slow', 'pile-med', 'pile-fast', 'wall-row-sweep', 'corner-pile', 'squeeze-2robots', 'settle-60']) {
    const scene = BB_SCENES.find((sc) => sc.id === id);
    if (!scene) {
      check(`containment [${id}]: the scene is registered`, false, 'no such scene id');
      continue;
    }
    let worst = 0;
    let worstAt = -1;
    let n = -1;
    let conserved = true;
    for (const { tick, world } of bbSceneStills(everyTick(scene))) {
      if (n < 0) n = world.balls.length;
      else if (world.balls.length !== n) conserved = false;
      for (const b of world.balls) {
        if (b.state.kind !== 'ground') continue;
        const out = outBy(b);
        if (out > worst) {
          worst = out;
          worstAt = tick;
        }
      }
    }
    check(
      `containment [${id}]: every pollen inside bounds on all ${Math.max(...scene.stills) + 1} ticks`,
      worst <= WALL_SLOP,
      worst > 0 ? `worst ${worst.toFixed(3)}" out at tick ${worstAt}` : 'never outside',
    );
    check(`containment [${id}]: pollen count conserved across the whole run`, conserved, `n=${n}`);
  }

  // -- A SETTLED PILE DOES NOT REST INSIDE ITSELF ----------------------------
  /**
   * Two POLLEN at rest may not occupy the same space. A pile allowed to do it looks like fewer
   * balls than there are and explodes when something next touches it.
   *
   * Asserted on SETTLED states only, and that distinction is the whole check. While a chassis
   * is pressing a row into a wall the solve genuinely has no answer - it is being asked to fit
   * 14 pollen into less space than 14 pollen occupy - and measured, `wall-row-sweep` holds
   * 2.13" of overlap on a 3.00" diameter for as long as the robot sits there. That is written
   * up for the owner (`docs/biobuzz/feedback/000-solver-observations.md`), not asserted away
   * here. What IS asserted is that once the pushing stops and the pile comes to rest it is a
   * pile of SEPARATE balls: the untouched scatter and a pile plowed at 20 in/s then left alone
   * both reach zero overlap and zero speed.
   *
   * The AT REST half is not decoration either - it is the check that fails if the shared
   * rolling-friction pass (`stepGroundBall`) is ever dropped from `play.ts`. Without it there
   * is no floor friction anywhere in the pipeline (the solve runs in a plane with no gravity),
   * and `pile-slow`'s pile was measured still travelling at 18.98 in/s five seconds after the
   * robot stopped.
   */
  for (const [id, idle] of [['settle-60', 0], ['pile-slow', 240]] as const) {
    const scene = BB_SCENES.find((sc) => sc.id === id)!;
    const w = bbSceneAt(scene, Math.max(...scene.stills));
    const idleCmds = new Map(w.robots.map((r) => [r.id, BB_IDLE]));
    for (let t = 0; t < idle; t++) biobuzzStep(w, C.SIM_DT, idleCmds);
    const g = w.balls.filter((b) => b.state.kind === 'ground');
    let overlap = 0;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        overlap = Math.max(overlap, 2 * BB_POLLEN_R - Math.hypot(g[i].pos.x - g[j].pos.x, g[i].pos.y - g[j].pos.y));
      }
    }
    let fastest = 0;
    for (const b of g) fastest = Math.max(fastest, Math.hypot(b.vel.x, b.vel.y));
    check(
      `settle [${id}+${idle}]: no two resting pollen overlap by more than ${OVERLAP_SLOP}"`,
      g.length > 1 && overlap <= OVERLAP_SLOP,
      `${g.length} ground, worst overlap ${overlap.toFixed(3)}" of ${(2 * BB_POLLEN_R).toFixed(2)}"`,
    );
    check(
      `settle [${id}+${idle}]: the pile is actually AT REST (the shared rolling pass ran)`,
      fastest < C.BALL_REST_SPEED,
      `fastest ${fastest.toFixed(3)} in/s`,
    );
  }

  // -- A ROBOT AT FULL THROTTLE DOES NOT PUT A POLLEN THROUGH THE WALL ------
  /**
   * `pin-wall` is one POLLEN against the wall with a robot driving into it at full throttle for
   * five seconds - the narrowest case in the set, and the one where a position authority that
   * cannot resolve the squeeze either eats the pollen or posts it through the perimeter.
   *
   * Checked on all 300 ticks, on both outcomes that would be wrong: gone, or through the wall.
   * The pollen is ALLOWED to squirt sideways and allowed to stay put, and this deliberately
   * does NOT assert that the robot stalls on it - DECODE's stall comes from the pin half of the
   * round loop, which BIOBUZZ does not run (see the owner notes).
   */
  {
    const scene = BB_SCENES.find((sc) => sc.id === 'pin-wall')!;
    let worst = 0;
    let worstAt = -1;
    let gone = false;
    for (const { tick, world } of bbSceneStills(everyTick(scene))) {
      const g = world.balls.filter((b) => b.state.kind === 'ground');
      if (g.length !== 1) gone = true;
      for (const b of g) {
        const out = outBy(b);
        if (out > worst) {
          worst = out;
          worstAt = tick;
        }
      }
    }
    check('pin-wall: the pollen is never deleted, on any tick', !gone);
    check(
      'pin-wall: a robot at full throttle never drives the pollen through the wall',
      worst <= WALL_SLOP,
      worst > 0 ? `worst ${worst.toFixed(3)}" out at tick ${worstAt}` : 'never outside',
    );
  }

  // -- THE SOLVE RUNS AT THE POLLEN'S OWN SIZE, MEASURED ON CONTACT ---------
  /**
   * THE RADIUS IS A PARAMETER AND EVERY CALLER HAS TO PASS IT — asserted on the distance the
   * SOLVER actually settles a contact at, not on the constant existing.
   *
   * `solveArtifacts` and `robotSolids` / `bbRobotSolids` all default to `C.BALL_RADIUS` (2.5",
   * DECODE's artifact) so that every DECODE call site stays byte-identical. The failure mode
   * that buys is silent and total: a caller that forgets the argument runs 3" POLLEN through
   * the solver as 5" balls, they collide at nearly twice the size they are DRAWN at (`draw.ts`
   * draws `BB_POLLEN_R`), and every picture still looks like pollen because the renderer is the
   * half that is right. Nothing else in this suite could see it.
   *
   * Two contacts, because there are two places the radius enters: the POLLEN's own collider
   * (pollen to pollen) and the robot solids it is measured against (pollen to chassis). Both
   * numbers are the SOLVE's, read after it has settled, so a wrong radius misses by a whole
   * inch on a 1.5" element.
   */
  {
    check(
      'radius: BIOBUZZ and DECODE really are different sizes (so the two checks below mean something)',
      BB_POLLEN_R !== C.BALL_RADIUS,
      `pollen ${BB_POLLEN_R}" vs artifact ${C.BALL_RADIUS}"`,
    );

    // (a) POLLEN against POLLEN. Two overlapping pollen, no robot: the solve pushes them apart
    // to exactly touching and the shared rolling pass stops them there.
    const w = createBiobuzzWorld('free', 3, []);
    w.robots.length = 0;
    w.balls.length = 0;
    w.balls.push(bbPollen(1, -0.5, 0), bbPollen(2, 0.5, 0));
    for (let i = 0; i < 240; i++) updateBiobuzz(w, C.SIM_DT, new Map(), true, NO_SWEEP);
    const d = Math.hypot(w.balls[0].pos.x - w.balls[1].pos.x, w.balls[0].pos.y - w.balls[1].pos.y);
    check(
      'radius: two settled pollen rest one POLLEN diameter apart, not one artifact diameter',
      Math.abs(d - 2 * BB_POLLEN_R) <= 0.1,
      `${d.toFixed(3)}" apart; pollen ${(2 * BB_POLLEN_R).toFixed(2)}", artifact ${(2 * C.BALL_RADIUS).toFixed(2)}"`,
    );

    // (b) POLLEN against CHASSIS, through the whole pipeline: a robot walking a pollen ahead of
    // it holds it a POLLEN RADIUS off its front face, less the solver's own soft penetration.
    const w2 = mkWorld('free', 3);
    const r = w2.robots[0];
    r.pos = { x: -40, y: 0 };
    r.heading = 0;
    r.vel = { x: 0, y: 0 };
    w2.balls.length = 0;
    w2.balls.push(bbPollen(1, -20, 0));
    const push = new Map([[r.id, cmd({ driveY: 0.35 })]]);
    let ahead = 0;
    for (let i = 0; i < 420; i++) {
      biobuzzStep(w2, C.SIM_DT, push);
      const b = w2.balls[0];
      ahead =
        (b.pos.x - r.pos.x) * Math.cos(r.heading) +
        (b.pos.y - r.pos.y) * Math.sin(r.heading) -
        r.spec.length / 2;
    }
    check(
      'radius: a pushed pollen rides one POLLEN RADIUS off the chassis face',
      Math.abs(ahead - BB_POLLEN_R) <= 0.35,
      `${ahead.toFixed(3)}" ahead of the face; pollen R=${BB_POLLEN_R}", artifact R=${C.BALL_RADIUS}"`,
    );
  }

  // -- WHAT THE SOLVE ITSELF DOES ABOUT THE PERIMETER, WITH NO CLAMP OVER IT -
  /**
   * EVERY OTHER CONTAINMENT CHECK IN THIS FILE READS THE WORLD AFTER `clampPollenToWalls` HAS
   * RUN, so all of them measure the CLAMP and none of them can see the solve. That is a real
   * blind spot rather than a theoretical one: the clamp is unconditional, so the shared solve
   * could regress from "a hair of resting penetration" to "posts a pollen through the wall
   * every tick" and this suite would stay green at 0.000" everywhere.
   *
   * So this runs the stages `play.ts` stage 3+4 runs — the shared rolling pass, this game's own
   * robot solids, `solveArtifacts` at `BB_POLLEN_R` — on a chassis sweeping a row of pollen
   * ALONG a wall (the `wall-row-sweep` geometry, the hard case), and measures the escape BEFORE
   * putting anything back. The pollen ARE put back after the measurement, so every tick starts
   * legal and the number is the solve's own PER-TICK escape rather than a compounding drift.
   *
   * Measured when this was written: 1.00" at 40 in/s, 1.74" at 80 in/s, on a 1.5" pollen. That
   * is the clamp carrying real weight, exactly as owner note 1 describes — BIOBUZZ runs no
   * pin/round loop, so nothing tells the robot solve that a wall pollen is a wall and the
   * chassis occupies the space it is in. The budget is a CEILING on that, not a target: it goes
   * red if the solve starts losing pollen outright, and it does not pretend the solve holds the
   * perimeter on its own, because it does not.
   */
  {
    const SOLVE_ESCAPE_BUDGET = 2.5; // in — measured worst 1.74" at 80 in/s, see above
    for (const speed of [40, 80]) {
      const w = createBiobuzzWorld('free', 5, [setup(0, 'blue')]);
      const r = w.robots[0];
      w.balls.length = 0;
      for (let i = 0; i < 14; i++) {
        w.balls.push(bbPollen(100 + i, -40 + (i * 80) / 13, BB_HALF_Y - BB_POLLEN_R));
      }
      r.heading = 0;
      r.pos = { x: -52, y: BB_HALF_Y - 10 };
      r.vel = { x: speed, y: 0 };
      let worst = 0;
      let worstAt = -1;
      let lost = false;
      for (let i = 0; i < 300; i++) {
        const from: ReadonlyMap<number, SweepFrom> = new Map([
          [r.id, { x: r.pos.x, y: r.pos.y, heading: r.heading }],
        ]);
        r.pos = { x: r.pos.x + speed * C.SIM_DT, y: r.pos.y };
        for (const b of w.balls) if (b.state.kind === 'ground') stepGroundBall(b, C.SIM_DT);
        const solids = new Map([[r.id, bbRobotSolids(r, [], BB_POLLEN_R)]]);
        solveArtifacts(w, C.SIM_DT, biobuzzColliders, NO_IDS, NO_IDS, solids, from, BB_POLLEN_R);
        for (const b of w.balls) {
          const out = outBy(b);
          if (out > worst) {
            worst = out;
            worstAt = i;
          }
          if (!Number.isFinite(b.pos.x) || !Number.isFinite(b.pos.y)) lost = true;
        }
        // ...and only NOW put them back, so the next tick starts from a legal state
        for (const b of w.balls) {
          b.pos.x = Math.max(-(BB_HALF_X - BB_POLLEN_R), Math.min(BB_HALF_X - BB_POLLEN_R, b.pos.x));
          b.pos.y = Math.max(-(BB_HALF_Y - BB_POLLEN_R), Math.min(BB_HALF_Y - BB_POLLEN_R, b.pos.y));
        }
      }
      check(
        `solve-only containment [${speed} in/s]: the SOLVE's own per-tick escape stays under ${SOLVE_ESCAPE_BUDGET}"`,
        worst <= SOLVE_ESCAPE_BUDGET && !lost,
        `worst ${worst.toFixed(3)}" past the wall plane at tick ${worstAt}${lost ? ' — and a pollen went non-finite' : ''}`,
      );
    }
  }

  // -- WHAT A POLLEN WEIGHS AND HOW IT BOUNCES, MEASURED THROUGH THE SOLVE ---
  /**
   * The radius is the only thing BIOBUZZ passes into the shared solve. MASS (`C.BALL_MASS`),
   * ball-ball RESTITUTION (`C.BALL_BALL_RESTITUTION`) and the speed cap (`C.BALL_MAX_SPEED`)
   * are DECODE's numbers applied to a 3" element, by design — this game owns no ground-pollen
   * physics constant — so they are pinned here as BEHAVIOUR rather than left unmeasured,
   * because "the pollen model changed" should be a failing check and not a report.
   *
   * EQUAL MASS is read off the SPEED SUM. Two equal masses in a head-on contact hand over
   * `(1±e)/2` of the approach each, so the two speeds after impact SUM to the approach speed
   * whatever the restitution is; an unequal pair does not. One measurement, and it proves the
   * mass is shared without depending on the bounce.
   *
   * The BOUNCE is bounded rather than pinned to a value, deliberately: BIOBUZZ does not run
   * DECODE's `bounceFirstContacts` pre-pass (it lives in `src/sim/world.ts`), so what a POLLEN
   * actually gets is the speculative contact's restitution, well under the configured
   * `C.BALL_BALL_RESTITUTION` — measured 0.02 to 0.21 against a set 0.68. That gap is an owner
   * item (`docs/biobuzz/feedback/000-solver-observations.md`), so what is asserted is the
   * physical envelope: never negative, never more than the coefficient the config asks for. It
   * stays true if the owner closes the gap, and fails if a pollen starts gaining energy.
   */
  for (const v0 of [50, 70, 90]) {
    const w = createBiobuzzWorld('free', 3, []);
    w.robots.length = 0;
    w.balls.length = 0;
    const striker = bbPollen(1, -12, 0);
    striker.vel = { x: v0, y: 0 };
    w.balls.push(striker, bbPollen(2, 0, 0));
    let approach = v0;
    let after: [number, number] = [0, 0];
    let hit = false;
    for (let i = 0; i < 90; i++) {
      const pre = w.balls[0].vel.x;
      updateBiobuzz(w, C.SIM_DT, new Map(), true, NO_SWEEP);
      if (!hit && w.balls[1].vel.x > 0.01) {
        hit = true;
        approach = pre;
        after = [w.balls[0].vel.x, w.balls[1].vel.x];
      }
    }
    const sum = (after[0] + after[1]) / approach;
    const e = (after[1] - after[0]) / approach;
    check(
      `pollen physics [${v0} in/s]: the pair really is EQUAL MASS (the two speeds sum to the approach)`,
      hit && Math.abs(sum - 1) <= 0.1,
      `approach ${approach.toFixed(2)} -> ${after[0].toFixed(2)} + ${after[1].toFixed(2)} = ${(sum * 100).toFixed(1)}%`,
    );
    check(
      `pollen physics [${v0} in/s]: the bounce is inside the physical envelope (0 <= e <= ${C.BALL_BALL_RESTITUTION})`,
      hit && e >= -0.02 && e <= C.BALL_BALL_RESTITUTION + 0.05,
      `effective e=${e.toFixed(3)} against a configured ${C.BALL_BALL_RESTITUTION} — no bounceFirstContacts here, see the owner notes`,
    );
    check(
      `pollen physics [${v0} in/s]: the struck pollen never outruns what struck it`,
      hit && after[1] <= approach + 0.5 && after[1] <= C.BALL_MAX_SPEED,
      `struck ${after[1].toFixed(2)} in/s off an approach of ${approach.toFixed(2)}`,
    );
  }

  // -- THE TICK-START SWEEP IS THE REAL ONE, AND IT IS WHAT KEEPS POLLEN OUT -
  /**
   * `updateBiobuzz` takes each robot's pose from BEFORE the drivetrain ran (`step.ts` stage 0)
   * and the solve sweeps the chassis from there to where the robot solve left it. That argument
   * is REQUIRED; it used to be optional and fall back to the END pose, which is a chassis placed
   * in the solve already overlapping whatever it drove into, with nothing but soft penetration
   * recovery acting on the POLLEN inside it.
   *
   * Measured rather than trusted: the same run twice, once through the REAL `biobuzzStep`
   * (which captures stage 0) and once with an EMPTY sweep map — what a caller that skips it now
   * has to ask for explicitly — scored on how deep a POLLEN ever gets into the robot. The swept
   * run has to be strictly better, or the sweep is not doing the job the required argument
   * exists for.
   */
  {
    const worstPen = (swept: boolean): number => {
      const w = mkWorld('free', 21);
      const r = w.robots[0];
      r.heading = 0;
      r.pos = { x: -50, y: 0 };
      r.vel = { x: 0, y: 0 };
      w.balls.length = 0;
      for (let i = 0; i < 8; i++) w.balls.push(bbPollen(200 + i, -20 + i * 3.1, 0));
      const drive = new Map([[r.id, cmd({ driveY: 1 })]]);
      let worst = 0;
      for (let i = 0; i < 240; i++) {
        if (swept) {
          biobuzzStep(w, C.SIM_DT, drive);
        } else {
          // the same tick WITHOUT stage 0: the robot is moved, then gameplay is told nothing
          // about where it came from
          w.tick++;
          w.time += C.SIM_DT;
          r.pos = { x: r.pos.x + 60 * C.SIM_DT, y: r.pos.y };
          r.vel = { x: 60, y: 0 };
          updateBiobuzz(w, C.SIM_DT, drive, true, NO_SWEEP);
        }
        const sol = bbRobotSolids(r, [], BB_POLLEN_R);
        for (const b of w.balls) {
          if (b.state.kind !== 'ground') continue;
          const q = robotPenetration(r, sol, b.pos, BB_POLLEN_R);
          if (q && q.pen > worst) worst = q.pen;
        }
      }
      return worst;
    };
    const swept = worstPen(true);
    const blind = worstPen(false);
    check(
      'sweep: the real tick-start pose keeps pollen further out of the chassis than no sweep at all',
      swept < blind,
      `swept ${swept.toFixed(3)}" deep against ${blind.toFixed(3)}" unswept`,
    );
  }

  // ── DETERMINISM ───────────────────────────────────────────────────────────
  // Same seed, same setups, same commands ⇒ the same world, bit for bit as `worldHash` reads
  // it. This is THE check the multiplayer lockstep and every replay depend on, and a scatter
  // built off `world.rngState` is exactly the kind of thing that breaks it silently.
  {
    const setups = [setup(0, 'blue'), setup(1, 'red', {}, 1)];
    const a = createBiobuzzWorld('match', 12345, setups);
    const b = createBiobuzzWorld('match', 12345, setups);
    check('determinism: same seed ⇒ identical worldHash at spawn', worldHash(a) === worldHash(b), `${worldHash(a)} vs ${worldHash(b)}`);
    const c = cmd({ driveY: 1, intake: true });
    const cmds = new Map([[0, c], [1, c]]);
    for (let i = 0; i < 600; i++) {
      biobuzzStep(a, C.SIM_DT, cmds);
      biobuzzStep(b, C.SIM_DT, cmds);
    }
    check('determinism: same seed ⇒ identical worldHash after 600 ticks', worldHash(a) === worldHash(b), `${worldHash(a)} vs ${worldHash(b)}`);
    const d = createBiobuzzWorld('match', 999, setups);
    check('determinism: a DIFFERENT seed gives a different world (the scatter is really seeded)', worldHash(d) !== worldHash(a));
  }

  // ── THE WIRE ROUND-TRIP ───────────────────────────────────────────────────
  /**
   * `slimWorld` strips the balls (they ride their own delta channel) and every robot's static
   * spec, then `unslimWorld` puts both back. What must survive that is `game` and the whole
   * `biobuzz` state bag — if either is dropped, a joining client resolves the module to DECODE
   * and renders a BIOBUZZ world with DECODE's field, which is the exact failure the `game`
   * field was added for.
   */
  {
    const w = createBiobuzzWorld('match', 77, [setup(0, 'blue')]);
    w.biobuzz!.scored.blue = 3;
    w.biobuzz!.held[0] = 2;
    const slim = slimWorld(w);
    const back = unslimWorld(slim, w.balls, () => w.robots[0].spec);
    check('wire: slim/unslim preserves world.game', back.game === 'biobuzz', `game=${back.game}`);
    check('wire: slim/unslim preserves the whole world.biobuzz bag', JSON.stringify(back.biobuzz) === JSON.stringify(w.biobuzz));
    check('wire: slim/unslim preserves the pollen count', back.balls.length === w.balls.length);
    check('wire: the round-tripped world hashes the same', worldHash(back) === worldHash(w));
  }

  // ── EVERY FIELD SCENE HASHES DETERMINISTICALLY ────────────────────────────
  /**
   * A scene is a determinism check for free: step it to its last still twice and the two
   * worlds must hash the same. The value is that it covers the FULL pipeline over hundreds of
   * ticks with pollen piled in corners and robots pinned against walls — situations nobody
   * would hand-write an assertion for, and exactly where a non-deterministic tie-break
   * (iteration order in the separator, a `Math.random`, a `Date.now`) actually hides.
   */
  for (const scene of BB_SCENES.filter((s) => s.lane === 'field')) {
    const last = Math.max(...scene.stills);
    const h1 = worldHash(bbSceneAt(scene, last));
    const h2 = worldHash(bbSceneAt(scene, last));
    check(`scene [${scene.id}@${last}]: hashes deterministically`, h1 === h2, `${h1} vs ${h2}`);
  }

  // -- PERFORMANCE BUDGET ---------------------------------------------------
  /**
   * A 2v2 BIOBUZZ world must not cost more than `STEP_BUDGET` x a 2v2 Chain Reaction world per
   * step, MEASURED IN THE SAME RUN.
   *
   * Same run matters more than the threshold does: an absolute millisecond budget is a
   * statement about the machine that happened to run CI, and it either fails on a loaded laptop
   * or passes on anything. A RATIO against a game already known to hold 60 Hz on the hardware
   * people actually play on is a statement about this game.
   *
   * Both sides get a warm-up before the timed windows so the comparison is not "interpreted
   * BIOBUZZ vs JIT-compiled CR", which is a ~3x artefact and was the first version of this
   * check.
   *
   * THE ROUNDS ARE PAIRED AND THE ANSWER IS A MEDIAN OF RATIOS. Each round times CR and then
   * BIOBUZZ back to back and divides THOSE TWO NUMBERS; the check reads the median of the
   * per-round ratios. It used to take each side's own BEST window and divide the two minima,
   * which is a ratio of two measurements that never happened together: the CR minimum could
   * come from a quiet round and the BIOBUZZ minimum from a loaded one (or the reverse, which is
   * worse — it flatters BIOBUZZ and the budget stops binding). A paired ratio cancels whatever
   * the machine was doing during THAT round, which is the only reason a ratio is being measured
   * at all, and the median throws away a round that went bad on both sides together.
   *
   * The pairing is also what makes the alternation matter. Run as N CR windows and then N
   * BIOBUZZ windows the two sides are measured at different MOMENTS, so a few seconds of load
   * lands on one side only: measured, on a box also running an Electron gallery capture, that
   * layout read 1.77x (bb=1.249ms, cr=0.707ms — both inflated, BIOBUZZ's
   * fresh-Rapier-world-per-tick inflated harder) against the same code that reads 1.37-1.51x
   * idle.
   */
  {
    const bbSetups = [setup(0, 'blue'), setup(1, 'blue', {}, 1), setup(2, 'red'), setup(3, 'red', {}, 1)];
    const crSetup = (id: number, alliance: 'red' | 'blue', startIndex: number) => ({
      id,
      alliance,
      spec: { ...DEFAULT_SPEC },
      assists: { ...DEFAULT_ASSISTS },
      startIndex,
    });
    const crSetups = [crSetup(0, 'blue', 0), crSetup(1, 'blue', 1), crSetup(2, 'red', 0), crSetup(3, 'red', 1)];
    const drive = cmd({ driveY: 1, rotate: 0.3, intake: true, fire: true });
    const cmds = new Map([0, 1, 2, 3].map((id) => [id, drive] as const));

    type Side = { build: () => World; step: (w: World, dt: number, c: Map<number, RobotCommand>) => void };
    const warm = (side: Side): void => {
      const w = side.build();
      for (let i = 0; i < 300; i++) side.step(w, C.SIM_DT, cmds as Map<number, RobotCommand>);
    };
    /** one timed window, in ms per step */
    const window_ = (side: Side): number => {
      const w = side.build();
      const n = 600;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) side.step(w, C.SIM_DT, cmds as Map<number, RobotCommand>);
      return (performance.now() - t0) / n;
    };
    const sides: Side[] = [
      { build: () => createChainWorld('match', 5, crSetups), step: chainStep },
      { build: () => createBiobuzzWorld('match', 5, bbSetups), step: biobuzzStep },
    ];
    for (const side of sides) warm(side);
    const rounds: { cr: number; bb: number; ratio: number }[] = [];
    for (let k = 0; k < PERF_ROUNDS; k++) {
      // BACK TO BACK, both sides inside one round, and the ratio taken from THAT ROUND's two
      // numbers — see the block comment.
      const cr = window_(sides[0]);
      const bb = window_(sides[1]);
      rounds.push({ cr, bb, ratio: bb / cr });
    }
    const ratio = median(rounds.map((x) => x.ratio));
    check(
      `perf: a 2v2 BIOBUZZ step costs <= ${STEP_BUDGET}x a 2v2 Chain Reaction step`,
      ratio <= STEP_BUDGET,
      `median paired ratio=${ratio.toFixed(2)} of [${rounds.map((x) => x.ratio.toFixed(2)).join(', ')}] ` +
        `· bb median ${median(rounds.map((x) => x.bb)).toFixed(3)}ms · cr median ${median(rounds.map((x) => x.cr)).toFixed(3)}ms`,
    );
  }

  // ── HIVE: the tip, PURE (`hive.ts`, field-plan §2.1) ──────────────────────
  /**
   * `hiveStep` is the one place a HIVE decides to tip, and it is a pure function of the state
   * and a mass lookup, so it is checked here directly, with no world. Everything the manual
   * does not print is APPROX (`BB_TIP_LOAD`, `BB_NECTAR_MASS`, the swing time), and these do
   * not assert those numbers — they assert the RELATIONS the game needs of them: a staged cell
   * (3 nectar, §10.3.1) is stable, one pollen short of the threshold does nothing, the
   * threshold starts a swing that takes the swing time to settle, and what tipped is exactly
   * what spills, under the cell that is now down. A retuned threshold on 09-14 leaves every one
   * of these true.
   */
  {
    const dt = C.SIM_DT;
    const massOf = (kinds: Map<number, BbElementKind>) => (id: number): number => bbElementMass(kinds.get(id) ?? 'pollen');
    const settled = (contents: number[]): HiveState => ({ up: 'south', contents, tips: 0, tipping: 0 });

    // 1. the STAGED load: 3 nectar, stable for as long as anyone waits
    {
      const kinds = new Map<number, BbElementKind>([[1, 'red'], [2, 'red'], [3, 'red']]);
      const load = hiveLoad([1, 2, 3], massOf(kinds));
      let h = settled([1, 2, 3]);
      let everTipped = false;
      let everSwung = false;
      for (let i = 0; i < 180; i++) {
        const r = hiveStep(h, dt, massOf(kinds));
        h = r.hive;
        if (r.tipped) everTipped = true;
        if (h.tipping !== 0) everSwung = true;
      }
      check(
        'hive: staged load (3 nectar) is below the tip threshold',
        load < BB_TIP_LOAD && !everTipped && !everSwung && h.contents.length === 3 && h.tips === 0,
        `load ${load.toFixed(2)} (3 × ${BB_NECTAR_MASS}) vs threshold ${BB_TIP_LOAD}; 3 s of steps: tipped=${everTipped} swung=${everSwung}`,
      );
    }

    // 2. one pollen SHORT of the threshold: 3 nectar + 1 pollen = 5.95, nothing starts
    {
      const kinds = new Map<number, BbElementKind>([[1, 'red'], [2, 'red'], [3, 'red'], [4, 'pollen']]);
      const load = hiveLoad([1, 2, 3, 4], massOf(kinds));
      const r = hiveStep(settled([1, 2, 3, 4]), dt, massOf(kinds));
      check(
        'hive: load one pollen below the threshold does not start a swing',
        load < BB_TIP_LOAD && r.hive.tipping === 0 && !r.tipped && r.spilled.length === 0,
        `load ${load.toFixed(2)} vs ${BB_TIP_LOAD}; tipping=${r.hive.tipping} tipped=${r.tipped}`,
      );
    }

    // 3. AT the threshold: 6 pollen. The swing STARTS on this step and nothing has tipped yet.
    const six = [11, 12, 13, 14, 15, 16];
    const sixKinds = new Map<number, BbElementKind>(six.map((id) => [id, 'pollen'] as const));
    {
      const load = hiveLoad(six, massOf(sixKinds));
      const r = hiveStep(settled([...six]), dt, massOf(sixKinds));
      check(
        'hive: load at exactly the threshold starts the swing',
        load >= BB_TIP_LOAD && r.hive.tipping > 0 && !r.tipped && r.hive.contents.join() === six.join() && r.hive.tips === 0,
        `load ${load} >= ${BB_TIP_LOAD}; tipping=${r.hive.tipping.toFixed(3)} tipped=${r.tipped} contents=[${r.hive.contents.join(',')}]`,
      );
    }

    // 4 + 5. step until it tips: the swing lasts BB_TIP_SWING_S, the up cell flips, and what
    // spills is exactly what was in it.
    {
      let h = settled([...six]);
      let swingSteps = 0;
      let tipped = false;
      let spilled: number[] = [];
      for (let i = 0; i < 600 && !tipped; i++) {
        const swinging = h.tipping > 0;
        const r = hiveStep(h, dt, massOf(sixKinds));
        if (swinging) swingSteps++;
        h = r.hive;
        tipped = r.tipped;
        spilled = r.spilled;
      }
      const elapsed = swingSteps * dt;
      check(
        'hive: the swing settles after BB_TIP_SWING_S and flips the up cell',
        tipped && Math.abs(elapsed - BB_TIP_SWING_S) <= dt + 1e-9 && h.up === 'north' && h.tips === 1 && h.contents.length === 0 && h.tipping === 0,
        `tipped=${tipped} after ${swingSteps} swing steps = ${elapsed.toFixed(4)} s (swing ${BB_TIP_SWING_S}); up=${h.up} tips=${h.tips} contents=[${h.contents.join(',')}] tipping=${h.tipping}`,
      );
      check(
        'hive: spilled ids == the contents that tipped it',
        spilled.length === six.length && [...spilled].sort((a, b) => a - b).join() === [...six].sort((a, b) => a - b).join(),
        `spilled=[${spilled.join(',')}] expected=[${six.join(',')}]`,
      );
    }

    // 6. spill poses: `count` of them, all under the cell that is now DOWN, at the hive bottom.
    // Both alliances, because the pivot x and the staged up-cell both flip with the alliance.
    for (const a of ['red', 'blue'] as const) {
      let rngState = a === 'red' ? 7 : 8;
      const rng = (): number => {
        const r = nextRandom(rngState);
        rngState = r.state;
        return r.value;
      };
      // a settled post-tip hive for this alliance: staged up cell has just gone DOWN
      const post: HiveState = { up: otherSide(BB_HIVE_UP_STAGED[a]), contents: [], tips: 1, tipping: 0 };
      const down = otherSide(post.up);
      const sign = down === 'north' ? 1 : -1;
      const pivot = hivePivot(a);
      const count = 6;
      const poses = spillPoses(post, a, count, rng);
      const eps = 1e-6;
      const bad = poses.filter(
        (p) =>
          Math.abs(p.x - pivot.x) > BB_CELL_OPEN.w / 2 + eps ||
          Math.sign(p.y) !== sign ||
          Math.abs(p.y) < BB_HIVE_CELL_DY - eps ||
          Math.abs(p.y) > BB_HIVE_CELL_DY + BB_CELL_OPEN.d + eps ||
          p.z !== BB_HIVE_BOTTOM_Z,
      );
      check(
        `hive [${a}]: spill poses count == spilled count and lie under the now-down cell`,
        poses.length === count && bad.length === 0,
        `${poses.length}/${count} poses, ${bad.length} outside; down=${down} pivot x=${pivot.x}; ` +
          `x ${Math.min(...poses.map((p) => p.x)).toFixed(2)}..${Math.max(...poses.map((p) => p.x)).toFixed(2)} ` +
          `y ${Math.min(...poses.map((p) => p.y)).toFixed(2)}..${Math.max(...poses.map((p) => p.y)).toFixed(2)} ` +
          `z ${[...new Set(poses.map((p) => p.z))].join('/')}`,
      );
    }

    // 7. the ACCEPT test: inside the up cell's opening and descending, and nothing else
    {
      const a: Alliance = 'red';
      const h = settled([]); // up: south
      const up = hiveCellPos(a, 'south');
      const downPos = hiveCellPos(a, 'north');
      const zMid = (BB_HIVE_OPEN_Z[0] + BB_HIVE_OPEN_Z[1]) / 2;
      const cases: [string, boolean, boolean][] = [
        ['centre of the up cell, descending', hiveAccepts(h, a, up, zMid, -10), true],
        ['within the margin above the opening top', hiveAccepts(h, a, up, BB_HIVE_OPEN_Z[1] + BB_HIVE_ACCEPT_MARGIN / 2, -10), true],
        ['ASCENDING through the same point', hiveAccepts(h, a, up, zMid, +10), false],
        ['off the footprint across the hive (dx = w/2 + 1)', hiveAccepts(h, a, { x: up.x + BB_CELL_OPEN.w / 2 + 1, y: up.y }, zMid, -10), false],
        ['off the footprint along the hive (dy = d/2 + 1)', hiveAccepts(h, a, { x: up.x, y: up.y + BB_CELL_OPEN.d / 2 + 1 }, zMid, -10), false],
        ['the DOWN cell', hiveAccepts(h, a, downPos, zMid, -10), false],
        ['above the margin', hiveAccepts(h, a, up, BB_HIVE_OPEN_Z[1] + BB_HIVE_ACCEPT_MARGIN + 1, -10), false],
        ['below the opening bottom', hiveAccepts(h, a, up, BB_HIVE_OPEN_Z[0] - 1, -10), false],
        ['mid-swing', hiveAccepts({ ...h, tipping: BB_TIP_SWING_S / 2 }, a, up, zMid, -10), false],
      ];
      const wrong = cases.filter(([, got, want]) => got !== want);
      check(
        'hive: accepts a descending element inside the up-cell opening; rejects outside/ascending/down cell/mid-swing',
        wrong.length === 0,
        wrong.length ? `wrong: ${wrong.map(([n, got]) => `${n} → ${got}`).join('; ')}` : `${cases.length} cases as expected; up cell at (${up.x}, ${up.y}), z ${BB_HIVE_OPEN_Z[0]}..${BB_HIVE_OPEN_Z[1]}+${BB_HIVE_ACCEPT_MARGIN}`,
      );
    }

    // 8. purity: the input is not written, on the step that SETTLES (the one that clears
    // contents and flips `up` on the output).
    {
      const input: HiveState = { up: 'south', contents: [...six], tips: 0, tipping: dt / 2 };
      const before = JSON.stringify(input);
      const r = hiveStep(input, dt, massOf(sixKinds));
      const after = JSON.stringify(input);
      check(
        'hive: hiveStep does not mutate its input',
        before === after && r.tipped && r.hive !== input && r.hive.contents !== input.contents,
        `input ${before === after ? 'unchanged' : `CHANGED: ${before} → ${after}`}; output tipped=${r.tipped} up=${r.hive.up}`,
      );
    }
  }

  // ── FLOWER: Fig 10-5 A–H, TABLE-DRIVEN (`flower.ts`, §10.5.2) ─────────────
  /**
   * The manual's figure is not in the repo, so the eight cases are RECONSTRUCTED from the
   * §10.5.2 rule text and named A–H here; the labels are ours, not read off Fig 10-5. Each
   * expected value is derived BY HAND from the rules (owner = top-most nectar in the volume,
   * `BB_PTS.owned` per element in the volume, bonus = bottom-most nectar in the volume) and the
   * stack geometry (`flowerStackZ`: floor 0.43, pollen r 1.4, nectar r 1.8, volume from 3.98),
   * and written as a NUMBER, so a change to `flowerScore` that happens to agree with itself
   * still has to agree with the arithmetic.
   *
   * The geometry that decides the interesting cases: a bottom POLLEN's top is 3.23, BELOW the
   * volume floor at 3.98, so it does NOT score; a bottom NECTAR's top is 4.03, so it does
   * (partially). That is the manual's "on the tiles under the lower ring does not count" and
   * the reason A has 3 in volume of 4 and C has 4 of 4.
   */
  {
    type Row = {
      id: string;
      what: string;
      stack: BbElementKind[];
      owner: Alliance | null;
      ownerPts: number;
      bonus: Alliance | null;
      inVolume: number;
    };
    const P: BbElementKind = 'pollen';
    const R: BbElementKind = 'red';
    const B: BbElementKind = 'blue';
    const O = BB_PTS.owned;
    const rows: Row[] = [
      // zs 1.83 / 4.63 / 7.43 / 10.23 — the bottom pollen tops out at 3.23 < 3.98
      { id: 'A', what: '4 pollen, no nectar', stack: [P, P, P, P], owner: null, ownerPts: 0, bonus: null, inVolume: 3 },
      // zs 1.83 / 4.63 / 7.43 / nectar 10.63 — 2 pollen + nectar in
      { id: 'B', what: '3 pollen + red nectar on top', stack: [P, P, P, R], owner: 'red', ownerPts: 3 * O, bonus: 'red', inVolume: 3 },
      // nectar 2.23 (top 4.03, partially in) / 5.43 / 8.23 / 11.03 — all 4 in
      { id: 'C', what: 'red nectar at the bottom, 3 pollen above', stack: [R, P, P, P], owner: 'red', ownerPts: 4 * O, bonus: 'red', inVolume: 4 },
      // 2.23 / 5.43 / 8.23 / nectar 11.43 — owner is the TOP nectar, bonus the BOTTOM one
      { id: 'D', what: 'red nectar bottom, blue nectar top, pollen between', stack: [R, P, P, B], owner: 'blue', ownerPts: 4 * O, bonus: 'red', inVolume: 4 },
      // 2.23 / 5.83 / 9.43 — three nectars, alternating
      { id: 'E', what: 'blue, red, blue nectars', stack: [B, R, B], owner: 'blue', ownerPts: 3 * O, bonus: 'blue', inVolume: 3 },
      { id: 'F', what: 'empty', stack: [], owner: null, ownerPts: 0, bonus: null, inVolume: 0 },
      // 7 pollen (top 20.03) + nectar centred 21.83: ABOVE the top ring but its underside is
      // below it, so it is partially inside and counts (the backstop case). 6 pollen + nectar in.
      { id: 'G', what: '7 pollen + red nectar held on the backstop', stack: [P, P, P, P, P, P, P, R], owner: 'red', ownerPts: 7 * O, bonus: 'red', inVolume: 7 },
      // pollen 1.83 (out) / nectar 5.03 (in: underside 3.23 < 3.98, so PARTIALLY, not fully) —
      // the owner's points count only the in-volume elements, so the bottom pollen earns nothing
      { id: 'H', what: 'pollen bottom, blue nectar second', stack: [P, B], owner: 'blue', ownerPts: 1 * O, bonus: 'blue', inVolume: 1 },
    ];
    for (const row of rows) {
      const kinds = new Map<number, BbElementKind>(row.stack.map((k, i) => [100 + i, k] as const));
      const kindOf = (id: number): BbElementKind => kinds.get(id) ?? 'pollen';
      const stack = [...kinds.keys()];
      const zs = flowerStackZ(stack, kindOf);
      const s = flowerScore(stack, kindOf);
      const bonusPts = row.bonus ? BB_PTS.bottomNectar : 0;
      check(
        `flower [${row.id}]: ${row.what} → owner ${row.owner ?? 'none'} ${row.ownerPts}, bonus ${row.bonus ?? 'none'}, ${row.inVolume} in volume`,
        s.owner === row.owner && s.ownerPts === row.ownerPts && s.bonusAlliance === row.bonus && s.bonusPts === bonusPts && s.inVolume === row.inVolume,
        `got owner=${s.owner} pts=${s.ownerPts} bonus=${s.bonusAlliance}/${s.bonusPts} inVolume=${s.inVolume} · zs=[${zs.map((z) => z.toFixed(2)).join(', ')}] volume ${BB_FLOWER_VOL_Z[0]}..${BB_FLOWER_VOL_Z[1]}`,
      );
    }

    // G's other half: CAPACITY. The stack can take the backstop nectar and then nothing more.
    {
      const seven = new Map<number, BbElementKind>(Array.from({ length: 7 }, (_, i) => [200 + i, P] as const));
      const kindOf = (id: number): BbElementKind => seven.get(id) ?? 'red';
      const stack = [...seven.keys()];
      const fitsNectar = flowerFits(stack, kindOf, BB_NECTAR_R);
      const withNectar = [...stack, 299];
      const fitsAfter = flowerFits(withNectar, kindOf, BB_POLLEN_R);
      const eight = Array.from({ length: 8 }, (_, i) => 300 + i);
      const fitsEight = flowerFits(eight, () => P, BB_POLLEN_R);
      const topOf = (st: number[], k: (id: number) => BbElementKind): number => {
        const zs = flowerStackZ(st, k);
        return zs.length ? zs[zs.length - 1] + bbElementRadius(k(st[st.length - 1])) : BB_FLOWER_FLOOR_Z;
      };
      check(
        'flower [G]: a nectar still fits on 7 pollen, nothing fits on top of it, and 8 pollen is full',
        fitsNectar && !fitsAfter && !fitsEight,
        `7 pollen top ${topOf(stack, kindOf).toFixed(2)} → nectar fits=${fitsNectar}; +nectar top ${topOf(withNectar, kindOf).toFixed(2)} → fits=${fitsAfter}; 8 pollen top ${topOf(eight, () => P).toFixed(2)} → fits=${fitsEight}; TOP_Z ${BB_FLOWER_TOP_Z}`,
      );
    }

    // 9. RETRIEVAL pops the bottom element only when it is POLLEN (G418.B)
    {
      const kinds = new Map<number, BbElementKind>([[1, P], [2, R]]);
      const kindOf = (id: number): BbElementKind => kinds.get(id) ?? 'pollen';
      const a = flowerRetrieve([1, 2], kindOf);
      const b = flowerRetrieve([2, 1], kindOf);
      const c = flowerRetrieve([], kindOf);
      check(
        'flower: retrieve pops the bottom POLLEN only',
        a.id === 1 && a.stack.join() === '2' && b.id === null && b.stack.join() === '2,1' && c.id === null && c.stack.length === 0,
        `[pollen,nectar] → id ${a.id} stack [${a.stack}]; [nectar,pollen] → id ${b.id} stack [${b.stack}]; [] → id ${c.id}`,
      );
    }

    // 10. CAPACITY by height. floor 0.43, top ring 21.5: pollen (2.8) — the 8th's top lands at
    // 22.83, so 8; nectar (3.6) — the 6th's top at 22.03, so 6. And `flowerFits` agrees with
    // `flowerCapacity` when an empty flower is filled one pollen at a time.
    {
      const capP = flowerCapacity(BB_POLLEN_R);
      const capN = flowerCapacity(BB_NECTAR_R);
      const stack: number[] = [];
      let placed = 0;
      while (flowerFits(stack, () => P, BB_POLLEN_R) && placed < 50) {
        stack.push(400 + placed);
        placed++;
      }
      check(
        'flower: capacity by height',
        capP === 8 && capN === 6 && placed === capP,
        `pollen ${capP} (expect 8), nectar ${capN} (expect 6); filled one pollen at a time: ${placed}`,
      );
    }

    // 11. TOP entry only: over the ring, descending; not ascending, not off-centre, not the side
    {
      const f = { x: BB_FLOWERS[0].x, y: BB_FLOWERS[0].y };
      const above = BB_FLOWER_TOP_Z + 1;
      const cases: [string, boolean, boolean][] = [
        ['centre, z TOP+1, descending', flowerAccepts(f, f, above, -20, BB_POLLEN_R), true],
        ['same point, vz = 0', flowerAccepts(f, f, above, 0, BB_POLLEN_R), false],
        ['same point, ascending', flowerAccepts(f, f, above, +20, BB_POLLEN_R), false],
        ['2.5 in off centre', flowerAccepts(f, { x: f.x + 2.5, y: f.y }, above, -20, BB_POLLEN_R), false],
        ['z = 5 (the side of the tube)', flowerAccepts(f, f, 5, -20, BB_POLLEN_R), false],
      ];
      const wrong = cases.filter(([, got, want]) => got !== want);
      check(
        'flower: top entry only',
        wrong.length === 0,
        wrong.length ? `wrong: ${wrong.map(([n, got]) => `${n} → ${got}`).join('; ')}` : `${cases.length} cases as expected at ${BB_FLOWERS[0].id} (${f.x}, ${f.y}), TOP_Z ${BB_FLOWER_TOP_Z}`,
      );
    }

    // 12. purity
    {
      const kinds = new Map<number, BbElementKind>([[1, P], [2, R], [3, P]]);
      const kindOf = (id: number): BbElementKind => kinds.get(id) ?? 'pollen';
      const stack = [1, 2, 3];
      const before = stack.join();
      const r = flowerRetrieve(stack, kindOf);
      flowerScore(stack, kindOf);
      check(
        'flower: flowerRetrieve/flowerScore do not mutate the input stack',
        stack.join() === before && r.stack !== stack,
        `stack [${stack}] (was [${before}]); retrieve returned ${r.stack === stack ? 'the SAME array' : 'a new array'}`,
      );
    }
  }
}

/**
 * THE SERVER SIDE: real `Room`s configured for BIOBUZZ run whole headless matches.
 *
 * Split out of `fieldChecks` because it imports `server/**`, and a lane file that pulls the
 * server in is a lane file that cannot run in a browser context.
 *
 * WHAT IT PROVES, and it is more than it looks: the authoritative server can host this game
 * at all. `Room` resolves the game through the DOM-FREE registry (`games/sim.ts`), steps it
 * with that module's `step`, slims it over the wire, and finalizes it — so anything in the
 * BIOBUZZ pipeline that only breaks WITHOUT a DOM (a stray `document`, a `window`, a
 * renderer import leaking into `sim.ts`) fails HERE and nowhere else. It is also the only
 * check that runs the whole two-minute match clock, phases and all, to `post`.
 *
 * `advanceForTest` pumps ticks synchronously with the real-time timer dropped, which is what
 * makes a two-minute match take a fraction of a second.
 */
export function roomChecks(check: Check): void {
  /** four drivers, 2v2, the roster a versus room is built for. */
  const roster = (): { id: string; alliance: 'blue' | 'red'; startIndex: number }[] => [
    { id: 'bb-b1', alliance: 'blue', startIndex: 0 },
    { id: 'bb-b2', alliance: 'blue', startIndex: 1 },
    { id: 'bb-r1', alliance: 'red', startIndex: 0 },
    { id: 'bb-r2', alliance: 'red', startIndex: 1 },
  ];

  const mkClient = (
    seat: { id: string; alliance: 'blue' | 'red'; startIndex: number },
    spec: RobotSpec,
    sink: ServerMsg[],
  ): Client => ({
    id: seat.id,
    send: (m: ServerMsg) => sink.push(m),
    player: {
      clientId: seat.id,
      name: seat.id,
      teamName: 'Smoke',
      teamNumber: 1,
      alliance: seat.alliance,
      startIndex: seat.startIndex,
      ready: true,
      spec: { ...spec },
      assists: { ...DEFAULT_ASSISTS },
    },
    connected: true,
    disconnectAt: 0,
  });

  /** a started room for `game` (2v2 unless `seats` says otherwise), plus the message log of
   *  its first seat. */
  const started = (
    code: string,
    game: 'biobuzz' | 'chain',
    spec: RobotSpec,
    onOutcome?: (game: string | undefined) => void,
    seats = roster(),
  ): { room: Room; msgs: ServerMsg[] } => {
    const msgs: ServerMsg[] = [];
    const room = new Room(code, () => {}, { kind: 'versus', game }, (o) => onOutcome?.(o.game));
    for (const seat of seats) room.add(mkClient(seat, spec, seat.id === 'bb-b1' ? msgs : []));
    room.onMessage('bb-b1', { t: 'start' });
    return { room, msgs };
  };

  // ── A FULL HEADLESS BIOBUZZ MATCH ─────────────────────────────────────────
  let outcomeGame: string | undefined = '<onResult never called>';
  let threw: unknown = null;
  let room: Room | null = null;
  let msgs: ServerMsg[] = [];
  try {
    const r = started('smoke-bb', 'biobuzz', BB_DEFAULT_SPEC, (g) => {
      outcomeGame = g;
    });
    room = r.room;
    msgs = r.msgs;
    // +5 past the cap: the last ticks are what finalize the match, and stopping exactly at
    // the cap would test everything except the transition this check is named for.
    room.advanceForTest(maxMatchTicks() + 5);
  } catch (e) {
    threw = e;
  }
  check(
    'room: a 2v2 BIOBUZZ room starts and runs a full match without throwing',
    threw === null,
    threw ? String(threw) : '',
  );
  if (threw !== null || !room) return;

  const start = msgs.find((m) => m.t === 'matchStart') as Extract<ServerMsg, { t: 'matchStart' }> | undefined;
  check('room: matchStart advertises game:"biobuzz"', start?.game === 'biobuzz', `game=${start?.game}`);
  check('room: matchStart carries all four setups', start?.setups.length === 4, `n=${start?.setups.length}`);

  // The wire snapshot has to say WHICH GAME it is, because that is the client's fallback when
  // it joined without a `matchStart` (a reconnect, a spectator) — a snapshot that forgets
  // `game` renders BIOBUZZ with the DECODE module and looks almost right.
  const snaps = msgs.filter((m) => m.t === 'snapshot') as Extract<ServerMsg, { t: 'snapshot' }>[];
  check('room: the room broadcasts snapshots', snaps.length > 0, `n=${snaps.length}`);
  check(
    'room: every snapshot is tagged game:"biobuzz"',
    snaps.length > 0 && snaps.every((m) => m.w.game === 'biobuzz'),
    `games=${[...new Set(snaps.map((m) => m.w.game))].join(',')}`,
  );

  // REACHING `post` IS THE POINT. `matchResult` is broadcast from the finalizer, so its
  // presence is the proof the match ran the clock out and ended instead of stalling.
  const res = msgs.find((m) => m.t === 'matchResult') as Extract<ServerMsg, { t: 'matchResult' }> | undefined;
  check('room: the BIOBUZZ match reaches post and broadcasts matchResult', !!res);
  check(
    'room: the finished BIOBUZZ match scored nothing (an unscored shell must stay 0-0)',
    res?.result.score.blue === 0 && res?.result.score.red === 0,
    `blue=${res?.result.score.blue} red=${res?.result.score.red}`,
  );
  // The outcome still has to be GAME-TAGGED even though nothing is written: it is what
  // `persistMatch` reads to decide to skip, and an absent `game` defaults to DECODE — which
  // would file a BIOBUZZ run onto the DECODE boards.
  check('room: the MatchOutcome carries game:"biobuzz"', outcomeGame === 'biobuzz', `game=${outcomeGame}`);
  check(
    'room: the SERVER-SAFE registry declares BIOBUZZ unscored, so persistMatch skips it',
    simModuleFor('biobuzz').scored === false,
  );

  // -- THE START-POSE DE-CONFLICT LOOP READS THIS GAME'S ANCHOR COUNT ------------
  /**
   * FOUR ROBOTS ON ONE ALLIANCE, every one of them asking for anchor 0.
   *
   * `Room` de-conflicts start poses per alliance by walking the index forward until it finds
   * an unused one, stopping after a full cycle so an over-full alliance reuses a pose rather
   * than spinning the tick loop forever. That walk used DECODE's five anchors for every game,
   * so a BIOBUZZ alliance of four was handed 0, 1, 2 and 3 against TWO anchors: indices 2 and
   * 3 do not exist in this game and resolve to whatever its spawn does with a miss. It now
   * reads `simModuleFor(this.game).startPoseCount`.
   *
   * Four on ONE alliance and all at index 0 is what makes the check bite: a 2v2 at 0/1/0/1
   * never walks the index at all, which is why the full-match check above passed throughout.
   * With the bug: 0, 1, 2, 3. Without it: 0, 1, 0, 0 (the cycle gives up and reuses).
   */
  {
    const seats = (['bb-b1', 'bb-b2', 'bb-b3', 'bb-b4'] as const).map((id) => ({
      id,
      alliance: 'blue' as const,
      startIndex: 0,
    }));
    const n = simModuleFor('biobuzz').startPoseCount;
    const { msgs: m4 } = started('smoke-bb-anchors', 'biobuzz', BB_DEFAULT_SPEC, undefined, [...seats]);
    const st = m4.find((x) => x.t === 'matchStart') as Extract<ServerMsg, { t: 'matchStart' }> | undefined;
    const idx = (st?.setups ?? []).map((x) => x.startIndex ?? 0);
    check(
      `room: a 4-robot BIOBUZZ alliance is only ever assigned anchors 0..${n - 1}`,
      idx.length === 4 && idx.every((v) => Number.isInteger(v) && v >= 0 && v < n),
      `startPoseCount=${n} assigned=[${idx.join(', ')}]`,
    );
  }


  // -- PERFORMANCE, ROOM AGAINST ROOM, IN THE SAME RUN ----------------------
  /**
   * The `ROOM_BUDGET` ratio, measured through the SERVER's whole per-tick path: input draining,
   * the step, `slimWorld`, the ball delta and the broadcast to four sockets. That is the cost
   * that actually decides whether a machine can host a room, and it is not the same shape as
   * the step cost - a game whose step is cheap but whose snapshot is fat fails here and passes
   * there.
   *
   * RE-READ after the pollen solver changed, like the step check, and it kept 1.2x where the
   * step check had to move: a room tick pays for a snapshot too, and CR's 300 particles make
   * that side much fatter than BIOBUZZ's 60 pollen, so the shared solve's extra cost
   * disappears into it. Measured 0.75x and 0.99x on two runs - which is exactly why it takes
   * several rounds, PAIRED, and reads their median: a single window put the same code within
   * noise of the threshold.
   *
   * Both rooms are built and warmed inside this block so the comparison is same-run,
   * same-process, same-JIT state, for the reason spelled out on the world-step check.
   */
  {
    const WARM = 300;
    const N = 600;
    type RoomSide = { code: string; game: 'biobuzz' | 'chain'; spec: RobotSpec };
    /** one timed window, in ms per room tick */
    const roomWindow = (side: RoomSide, k: number): number => {
      const timed = started(`${side.code}-${k}`, side.game, side.spec).room;
      const t0 = performance.now();
      timed.advanceForTest(N);
      return (performance.now() - t0) / N;
    };
    const sides: RoomSide[] = [
      { code: 'smoke-perf-cr', game: 'chain', spec: DEFAULT_SPEC },
      { code: 'smoke-perf-bb', game: 'biobuzz', spec: BB_DEFAULT_SPEC },
    ];
    for (const side of sides) started(`${side.code}-warm`, side.game, side.spec).room.advanceForTest(WARM);
    // PAIRED, for the reason spelled out on the world-step check: both sides in one round, the
    // ratio from that round's own two numbers, the median over rounds. Three rounds here where
    // the step check takes five — a room window builds and steps two whole rooms, so the rounds
    // are expensive, and the pairing is what was doing the work anyway.
    const rounds: { cr: number; bb: number; ratio: number }[] = [];
    for (let k = 0; k < 3; k++) {
      const cr = roomWindow(sides[0], k);
      const bb = roomWindow(sides[1], k);
      rounds.push({ cr, bb, ratio: bb / cr });
    }
    const ratio = median(rounds.map((x) => x.ratio));
    check(
      `perf: a 2v2 BIOBUZZ ROOM tick costs <= ${ROOM_BUDGET}x a 2v2 Chain Reaction room tick`,
      ratio <= ROOM_BUDGET,
      `median paired ratio=${ratio.toFixed(2)} of [${rounds.map((x) => x.ratio.toFixed(2)).join(', ')}] ` +
        `· bb median ${median(rounds.map((x) => x.bb)).toFixed(3)}ms · cr median ${median(rounds.map((x) => x.cr)).toFixed(3)}ms`,
    );
  }
}
