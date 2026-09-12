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
  BB_TIP_POLLEN,
} from '../../src/games/biobuzz/config';
import {
  BB_FLOWER_FLOOR_Z,
  BB_FLOWER_MID_Z,
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
  BB_SPILL_FAN,
  BB_SPILL_SPEED,
  BB_TIP_RELEASE_S,
  BB_TIP_SWING_S,
  hiveAccepts,
  hiveApproachSign,
  hiveCellPos,
  hivePivot,
  hiveLoad,
  hiveStep,
  hiveWillTip,
  spillPoses,
  type HiveState,
  type SpillPose,
} from '../../src/games/biobuzz/hive';
import { nextRandom } from '../../src/math';
import {
  BB_FLOWER_D,
  BB_FLOWER_UNLOCK_S,
  BB_GARDEN,
  BB_LZ,
  BB_NECTAR_COUNT,
  BB_POLLEN_COUNT,
  BB_START_POSES,
  bbMirror,
  type BbRect,
} from '../../src/games/biobuzz/config';
import { BB_SOLID_COUNT, BB_WALL_COUNT, biobuzzColliders } from '../../src/games/biobuzz/colliders';
import { createBiobuzzWorld, stageBiobuzz } from '../../src/games/biobuzz/spawn';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import { scoreTargets } from '../../src/games/biobuzz/elements';
import type { ScoreTarget } from '../../src/games/biobuzz/state';
import { BB_NECTAR_DUMP_S, BB_NECTAR_ENTRY_S, updateBiobuzz } from '../../src/games/biobuzz/play';
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

/** every element the staged field holds: 40 POLLEN + 16 NECTAR (Fig 10-2). The number the
 * conservation checks are written against, so a staging change that leaks one fails here. */
const BB_STAGED_TOTAL = BB_POLLEN_COUNT + 2 * BB_NECTAR_COUNT;

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
    // Flipped 2026-09-12 (kickoff evening) once score.ts covered Table 10-2. Alpha-only via
    // `channels`, so what persists lands on an alpha board nobody competes on yet.
    check('registry: BIOBUZZ declares scored:true (Table 10-2 is live; persists per game)', mod.scored === true);
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
    // Only the first `BB_WALL_COUNT` statics are walls — the HIVE frame bars and the FLOWER
    // feet follow them in the array and are INSIDE the field on purpose, so measuring their
    // faces against the bound would be measuring the wrong thing.
    const faces = biobuzzColliders.statics
      .slice(0, BB_WALL_COUNT)
      .map((w) => (w.hx < w.hy ? Math.abs(w.tx) - w.hx : Math.abs(w.ty) - w.hy));
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
    // RED IS THE POINT MIRROR OF BLUE, applied once in `spawn.ts`. Asserted because a second
    // mirror anywhere else would cancel this one and put both alliances on the same side.
    //
    // POINT, not x-reflection, and this check is the one that pins it: BIOBUZZ's layout is
    // symmetric under a 180 degree ROTATION (S9.3), so red's LOADING ZONE is on the far half
    // of the left wall rather than at blue's y. An x-mirror spawns red at the right side of
    // the field and the wrong end of it, beside a zone that is not its own -- a bug that
    // looks entirely plausible in a screenshot, which is why it is asserted numerically.
    const red = w.robots.filter((r) => r.alliance === 'red');
    check(
      'anchors: RED is the POINT mirror of BLUE (x AND y negated, not just x)',
      Math.abs(blue[0].pos.x + red[0].pos.x) < 1e-9 && Math.abs(blue[0].pos.y + red[0].pos.y) < 1e-9,
      `blue=${blue[0].pos.x.toFixed(3)},${blue[0].pos.y.toFixed(3)} red=${red[0].pos.x.toFixed(3)},${red[0].pos.y.toFixed(3)}`,
    );
  }

  // -- A CUSTOM START POSE IS HONOURED ---------------------------------------
  /**
   * A CUSTOM POSE IS NOT SNAPPED TO A WALL. `bbSnapStart` drags the two hand-placed anchors
   * out of the LOADING ZONE band and onto their own side wall, and it must run on THOSE and
   * nothing else: a custom pose is a deliberate placement, and a spawner that repaired it
   * would make "put the robot under the HIVE" or "put the robot 18 in off a FRAME leg"
   * inexpressible -- exactly the two gallery scenes that exist to show those cases.
   *
   * The regression it guards is invisible in every other check here (the anchors still land
   * against their walls, staging still conserves) and is loud in a screenshot: a scene asking
   * for the field centre renders a robot parked on the perimeter. Asserted at the CENTRE,
   * which is the furthest a pose can be from any wall, so a snap of any strength fails it.
   */
  {
    const w = createBiobuzzWorld('match', 5, [
      { ...setup(0, 'blue'), startPose: { x: 0, y: 0, headingDeg: 180 } },
      { ...setup(1, 'red'), startPose: { x: 30, y: 12, headingDeg: 0 } },
    ]);
    const r0 = w.robots[0];
    check(
      'start pose: a custom pose at the field centre stays at the field centre',
      Math.hypot(r0.pos.x, r0.pos.y) < 1e-9,
      `pos=${r0.pos.x.toFixed(3)},${r0.pos.y.toFixed(3)}`,
    );
    // RED's custom pose goes through the SAME point mirror as its anchors -- one definition of
    // "the other alliance's version of this" -- so it lands at the negation, unsnapped.
    const r1 = w.robots[1];
    check(
      'start pose: a RED custom pose is point-mirrored, not snapped',
      Math.abs(r1.pos.x + 30) < 1e-9 && Math.abs(r1.pos.y + 12) < 1e-9,
      `pos=${r1.pos.x.toFixed(3)},${r1.pos.y.toFixed(3)}`,
    );
  }

  // -- THE ANCHORS ARE LEGAL AS WRITTEN -------------------------------------
  /**
   * `BB_START_POSES` SATISFIES G304 WITHOUT REPAIR.
   *
   * `bbSnapStart` was carrying these: the old pair stopped 2 in short of the wall and the
   * BOTTOM one sat inside `BB_LZ.blue`, so the anchor a builder places, the anchor the
   * selector labels TOP/BOTTOM, and the pose the robot got were three different things. The
   * repair still exists -- the seating is spec-dependent and a deep sweeper still needs it --
   * but it must now have nothing to move.
   *
   * MEASURED AS DISPLACEMENT, not as "is the result legal": the spawned pose was already legal
   * before this change, which is exactly why the bad anchors survived so long. What is asserted
   * is that spawning MOVED the anchor by less than `WALL_SEAT` and a hair -- the 0.01 in
   * float-tangency seat is the only correction left, and any real repair is orders above it.
   */
  {
    const SEAT_TOL = 0.05; // WALL_SEAT is 0.01; anything larger is a genuine repair
    const w = createBiobuzzWorld('match', 13, [
      setup(0, 'blue', {}, 0),
      setup(1, 'blue', {}, 1),
      setup(2, 'red', {}, 0),
      setup(3, 'red', {}, 1),
    ]);
    const e = bbFootprint(BB_DEFAULT_SPEC);
    const half = (e.front + e.rear) / 2;
    for (const r of w.robots) {
      const i = r.id % BB_START_POSES.length;
      const raw = BB_START_POSES[i].pos;
      // RED is the POINT mirror, the same one `spawn.ts` applies -- an x-mirror here would
      // "pass" against a red robot standing at blue's y.
      const want = r.alliance === 'blue' ? raw : { x: -raw.x, y: -raw.y };
      const moved = Math.hypot(r.pos.x - want.x, r.pos.y - want.y);
      check(
        `anchors: ${r.alliance} anchor ${i} spawns where it is written, unsnapped`,
        moved < SEAT_TOL,
        `moved=${moved.toFixed(3)}" want=(${want.x},${want.y}) got=(${r.pos.x.toFixed(2)},${r.pos.y.toFixed(2)})`,
      );
      // AND IT IS LEGAL: touching its own side wall, and clear of its own LOADING ZONE. Both
      // are read off the RAW anchor, not off the spawned pose, so the check cannot be
      // satisfied by the repair it exists to make unnecessary.
      const b = {
        x0: want.x - half, x1: want.x + half,
        y0: want.y - e.half, y1: want.y + e.half,
      };
      const gap = BB_HALF_X - Math.max(Math.abs(b.x0), Math.abs(b.x1));
      const z = BB_LZ[r.alliance];
      const inLz = b.x1 > z.x0 && b.x0 < z.x1 && b.y1 > z.y0 && b.y0 < z.y1;
      const ownSide = r.alliance === 'red' ? b.x1 < 0 : b.x0 > 0;
      check(
        `anchors: ${r.alliance} anchor ${i} contacts its own wall, on its own side, outside its LOADING ZONE`,
        gap >= 0 && gap <= C.START_TOUCH_TOL && !inLz && ownSide,
        `wall gap=${gap.toFixed(2)}" (tol ${C.START_TOUCH_TOL}) · inLZ=${inLz} · ownSide=${ownSide}`,
      );
    }
  }

  // -- EVERY SCORE TARGET SAYS WHICH WAY IT OPENS ---------------------------
  /**
   * `ScoreTarget.mouth` IS A UNIT VECTOR OUT OF THE OPENING, and every BIOBUZZ target has one.
   *
   * `pos` alone does not say which side of a solid thing is the open side. A CELL is a box on
   * a see-saw and a FLOWER is a column against the perimeter; an arc solved to `pos` from the
   * wrong side arrives through the cell floor or through the wall -- a shot that scores in the
   * sim and cannot be taken on a real field. Lane B aims at these, so the direction is part of
   * the contract rather than something an aimer re-derives from geometry it should not know.
   *
   * THE CELL'S MOUTH IS ASSERTED AGAINST ITS OWN PIVOT rather than against a literal: the up
   * CELL is offset from the HIVE pivot along y and opens AWAY from it, so `mouth` must have
   * the SAME SIGN as `pos.y` for that hive. That is one statement that stays true through a
   * TIP, where a hard-coded (0, -1) for red would silently become wrong.
   */
  {
    const w = createBiobuzzWorld('match', 14, [setup(0, 'blue', {}, 0)]);
    const bb = w.biobuzz!;
    // THE LIST IS PER ALLIANCE SINCE THE 2026-09-12 RULING: `scoreTargets(w, a)` carries a's
    // OWN up-CELL and the four neutral FLOWERS, and NOT the opponent's cell, because an element
    // launched by a does not enter it. `both` is the field-wide union `play.ts` builds for the
    // capture pass; the per-alliance lists are what a launcher sees.
    const both = (): ScoreTarget[] => {
      const out: ScoreTarget[] = [];
      const seen = new Set<string>();
      for (const a of ['red', 'blue'] as const) {
        for (const t of scoreTargets(w, a)) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          out.push(t);
        }
      }
      return out;
    };
    for (const tilt of ['staged', 'tipped'] as const) {
      if (tilt === 'tipped') {
        bb.hives.red.up = 'north';
        bb.hives.blue.up = 'south';
      }
      const own = scoreTargets(w, 'red');
      check(
        `targets [${tilt}]: RED is offered its OWN CELL and four FLOWERS — never blue's cell`,
        own.length === 1 + BB_FLOWERS.length &&
          own.filter((t) => t.id.startsWith('hive:')).map((t) => t.id).join() === 'hive:red',
        `${own.length} targets · cells [${own.filter((t) => t.id.startsWith('hive:')).map((t) => t.id).join(' ')}]`,
      );
      const ts = both();
      check(
        `targets [${tilt}]: two CELLS and four FLOWERS in the union, every one with a mouth`,
        ts.length === 2 + BB_FLOWERS.length && ts.every((t) => t.mouth !== undefined),
        `${ts.length} targets · ${ts.filter((t) => t.mouth).length} with mouth`,
      );
      check(
        `targets [${tilt}]: every mouth is a unit vector`,
        ts.every((t) => Math.abs(Math.hypot(t.mouth!.x, t.mouth!.y) - 1) < 1e-9),
        ts.map((t) => `${t.id}=(${t.mouth!.x},${t.mouth!.y})`).join(' '),
      );
      for (const a of ['red', 'blue'] as const) {
        const t = ts.find((x) => x.id === `hive:${a}`)!;
        check(
          `targets [${tilt}]: the ${a} up-CELL opens AWAY from its pivot`,
          t.mouth!.x === 0 && Math.sign(t.mouth!.y) === Math.sign(t.pos.y) && t.pos.y !== 0,
          `up=${bb.hives[a].up} pos.y=${t.pos.y.toFixed(1)} mouth=(${t.mouth!.x},${t.mouth!.y})`,
        );
      }
    }
    // A FLOWER OPENS INTO THE FIELD: step one inch along the mouth and you are further from
    // the wall the flower stands against than the flower itself is.
    const ts = both();
    BB_FLOWERS.forEach((f, i) => {
      const t = ts.find((x) => x.id === `flower:${i}`)!;
      const wallDist = (p: { x: number; y: number }): number =>
        Math.min(BB_HALF_X - Math.abs(p.x), BB_HALF_Y - Math.abs(p.y));
      const stepped = { x: f.x + t.mouth!.x, y: f.y + t.mouth!.y };
      check(
        `targets: FLOWER ${f.id} (${f.wall} wall) opens INTO the field`,
        wallDist(stepped) > wallDist(f) + 0.5 && t.alliance === null,
        `mouth=(${t.mouth!.x},${t.mouth!.y}) wallDist ${wallDist(f).toFixed(1)} -> ${wallDist(stepped).toFixed(1)}`,
      );
    });
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
      w.balls.length === n0 && n0 === BB_STAGED_TOTAL,
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
    // The lane is y = 40 rather than the field centreline: the HIVE frame's base bars stand at
    // x = +/-BB_FRAME_X spanning y in [-BB_FRAME_Y, BB_FRAME_Y], so a push along y = 0 now ends
    // against a bar a third of the way across and measures a jam instead of a carry. At y = 40
    // the robot clears the bars and the FLOWER feet and runs all the way to the +x wall, which
    // is what this check wants: a pollen pinned between a chassis face and something immovable.
    const w2 = mkWorld('free', 3);
    const r = w2.robots[0];
    r.pos = { x: -40, y: 40 };
    r.heading = 0;
    r.vel = { x: 0, y: 0 };
    w2.balls.length = 0;
    w2.balls.push(bbPollen(1, -20, 40));
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

  // ── THE LAYOUT IS POINT-SYMMETRIC, NOT X-MIRRORED ─────────────────────────
  /**
   * THE SINGLE MOST LIKELY LAYOUT BUG IN THIS GAME, and the one no other check can see.
   *
   * Every FTC field before this one was close enough to an x-mirror that reflecting it is the
   * reflex — and BIOBUZZ is not one: the layout is a 180° ROTATION about the origin, so RED's
   * LOADING ZONE is at y > 0 on the LEFT wall and BLUE's is at y < 0 on the RIGHT wall
   * (`config.ts` §9.3, `docs/biobuzz-reference.md` §2.1). An x-mirror of red's zone lands at
   * y > 0 on the RIGHT wall — the correct wall for blue, the WRONG HALF of it — and a field
   * built that way is internally consistent: the zones are the right size, against the right
   * walls, one per alliance, and every containment, staging and scoring check in this suite
   * still passes. It is wrong only against the manual, which is the one thing a test cannot
   * read. So the TRANSFORM is asserted, on the constants, at the top of the lane.
   *
   * MIRRORING A RECT SWAPS WHICH CORNER IS THE MIN. `bbMirror` negates both coordinates, so
   * `(x0, y0)` becomes the MAX corner of the image and `(x1, y1)` the MIN one; comparing `x0`
   * to `x0` after the map compares a max against a min and fails on a CORRECT field.
   * `mirrorRect` therefore maps both corners and re-sorts them — it compares the corner PAIR
   * as a set.
   *
   * The x-mirror arm is a NEGATIVE CONTROL and is not decoration: it is what proves the
   * assertion above would actually fail on the reflected layout, rather than being true of any
   * pair of zones on opposite walls.
   */
  {
    /** `p` mirrored through the origin, re-sorted so `x0 < x1` and `y0 < y1` hold again. */
    const mirrorRect = (p: BbRect): BbRect => {
      const a = bbMirror({ x: p.x0, y: p.y0 });
      const b = bbMirror({ x: p.x1, y: p.y1 });
      return {
        x0: Math.min(a.x, b.x),
        x1: Math.max(a.x, b.x),
        y0: Math.min(a.y, b.y),
        y1: Math.max(a.y, b.y),
      };
    };
    /** the same rect REFLECTED IN X — the WRONG transform, kept so the control below has one. */
    const flipRect = (p: BbRect): BbRect => ({ x0: -p.x1, x1: -p.x0, y0: p.y0, y1: p.y1 });
    const sameRect = (p: BbRect, q: BbRect): boolean =>
      Math.abs(p.x0 - q.x0) < 1e-9 &&
      Math.abs(p.x1 - q.x1) < 1e-9 &&
      Math.abs(p.y0 - q.y0) < 1e-9 &&
      Math.abs(p.y1 - q.y1) < 1e-9;
    const fmtRect = (p: BbRect): string => `x ${p.x0}..${p.x1} · y ${p.y0}..${p.y1}`;

    for (const [name, zone] of [
      ['LOADING ZONE', BB_LZ],
      ['GARDEN', BB_GARDEN],
    ] as const) {
      const want = mirrorRect(zone.red);
      check(
        `layout: ${name} blue is the POINT mirror of red (180°, not a reflection)`,
        sameRect(want, zone.blue),
        `red ${fmtRect(zone.red)} ⇒ ${fmtRect(want)}; blue is ${fmtRect(zone.blue)}`,
      );
      // ...and the reflection really is a DIFFERENT rect, so the check above has something to
      // catch. If the two ever coincide the zone is symmetric about y and the assertion has
      // gone vacuous — worth being told, because it means the field moved.
      check(
        `layout: an x-MIRROR of red's ${name} is NOT blue's (so the check above can fail)`,
        !sameRect(flipRect(zone.red), zone.blue),
        `x-mirror ${fmtRect(flipRect(zone.red))} vs blue ${fmtRect(zone.blue)}`,
      );
    }
  }

  // ── THE FOUR FLOWERS: ONE PER WALL, AT ±24, CLOSED UNDER THE POINT MIRROR ──
  /**
   * A FLOWER IS PLACED BY THREE NUMBERS AND EACH IS A SEPARATE WAY TO BE WRONG.
   *
   *  1. THE OFF-WALL COORDINATE IS EXACTLY ±24 — one tile off the field centreline, read off
   *     the tile seam in Fig 9-2/9-4. A flower at ±23 or ±25 sits mid-tile, which is not where
   *     an FTC field puts anything, and it moves every approach a robot can take to it.
   *  2. IT SITS ON THE WALL IT IS NAMED FOR, at the `BB_FLOWER_D` stand-off. `BB_FLOWERS`
   *     carries `wall` as a STRING and the coordinates separately, so the two can disagree in
   *     silence — and the collider array (`flowerFeet`) is built from the coordinates while
   *     every renderer and every future rule reads the name.
   *  3. THE SET IS CLOSED UNDER `bbMirror` — F1↔F3 (left/right) and F2↔F4 (rear/audience).
   *     Same argument as the zones above: the four are hand-placed, and a set x-mirrored
   *     instead of rotated puts F2 and F4 on the wrong halves of their walls while still
   *     looking exactly like four flowers on four walls.
   *
   * The stand-off is asserted to 1e-9 rather than to a tolerance because the constants are
   * BUILT from `BB_FLOWER_D` (`-72 + BB_FLOWER_D`), so anything but exact equality means
   * somebody typed a literal in place of the derivation.
   */
  {
    for (const f of BB_FLOWERS) {
      const onX = f.wall === 'left' || f.wall === 'right';
      // the coordinate ALONG the wall — the one that has to land on a tile seam
      const along = onX ? f.y : f.x;
      check(
        `flower [${f.id}]: sits one tile off centre along its wall (|${onX ? 'y' : 'x'}| = 24)`,
        Math.abs(Math.abs(along) - 24) < 1e-9,
        `${f.id} at (${f.x}, ${f.y}) on the ${f.wall} wall`,
      );
      const want =
        f.wall === 'left'
          ? -BB_HALF_X + BB_FLOWER_D
          : f.wall === 'right'
            ? BB_HALF_X - BB_FLOWER_D
            : f.wall === 'rear'
              ? BB_HALF_Y - BB_FLOWER_D
              : -BB_HALF_Y + BB_FLOWER_D;
      const got = onX ? f.x : f.y;
      check(
        `flower [${f.id}]: stands ${BB_FLOWER_D}" off the ${f.wall} wall, and off no other`,
        Math.abs(got - want) < 1e-9,
        `${onX ? 'x' : 'y'}=${got} against ${want}`,
      );
    }
    // F1↔F3 and F2↔F4, asserted as "every flower's mirror IS another flower" rather than by
    // index pairs, so a re-ordering of the array cannot make it pass for the wrong reason.
    const at = (x: number, y: number): boolean =>
      BB_FLOWERS.some((g) => Math.abs(g.x - x) < 1e-9 && Math.abs(g.y - y) < 1e-9);
    const closed = BB_FLOWERS.every((f) => {
      const m = bbMirror({ x: f.x, y: f.y });
      return at(m.x, m.y);
    });
    check(
      'flowers: the set of four is closed under the POINT mirror (F1↔F3, F2↔F4)',
      closed && BB_FLOWERS.length === 4,
      BB_FLOWERS.map((f) => `${f.id}(${f.x}, ${f.y})`).join(' · '),
    );
  }

  // ── EVERY NON-WALL SOLID IS STRICTLY INSIDE THE FIELD ─────────────────────
  /**
   * THE WALLS ARE OUTSIDE THE FIELD AND EVERYTHING ELSE IS INSIDE IT, and the perimeter check
   * above can only see the first half of that.
   *
   * `biobuzzColliders.statics` is one flat array: four walls whose bodies sit ENTIRELY outside
   * the play area with their inner faces exactly on the bound, then the HIVE frame's two base
   * bars and the four FLOWER feet, which are real obstacles standing ON the tiles. A solid
   * appended with a wall's geometry by accident — a `tx` built from `BB_HALF_X + hx` instead
   * of a field coordinate — shrinks the playable field by its own width along a whole wall,
   * and nothing else in this suite notices: containment passes (the robot is still inside the
   * bounds), conservation passes, and the pictures look very nearly right.
   *
   * `<`, not `<=`: a solid whose face lands exactly ON the bound is a solid fused into the
   * wall, and this field has no such thing — the frame bars reach x = ±25.48 and the furthest
   * flower foot 71.6 — so the strict form costs nothing and catches the degenerate case.
   *
   * `rot === 0` is asserted alongside because the overlap test in the push-off check below
   * (and `flowerFeet`'s own circumscribing-square argument) treats these as AXIS-ALIGNED
   * rects; a rotated one would make both measure the wrong box without failing.
   *
   * The COUNT is the other half. `BB_SOLID_COUNT` is DERIVED from the array, so it can never
   * disagree with it — what it can do is GROW, and pinning it to `walls + 2 frame bars + 4
   * flower feet` means a solid added without a check for it fails here, on the count, which is
   * the cheapest tripwire there is.
   */
  {
    const extras = biobuzzColliders.statics.slice(BB_WALL_COUNT);
    check(
      'solids: the array is the walls + 2 HIVE frame bars + 4 FLOWER feet, and nothing else',
      BB_SOLID_COUNT === BB_WALL_COUNT + 2 + 4 && extras.length === 6,
      `BB_SOLID_COUNT=${BB_SOLID_COUNT} against ${BB_WALL_COUNT} walls + 6`,
    );
    let worst = -Infinity;
    let worstAt = -1;
    let rotated = -1;
    extras.forEach((s, i) => {
      if (s.rot !== 0) rotated = i;
      // how close this solid's furthest face comes to the bound; >= 0 means it touches or
      // crosses it, which is a WALL's behaviour and not an obstacle's
      const slack = Math.max(Math.abs(s.tx) + s.hx - BB_HALF_X, Math.abs(s.ty) + s.hy - BB_HALF_Y);
      if (slack > worst) {
        worst = slack;
        worstAt = i;
      }
    });
    check(
      'solids: every non-wall static is inside the field bounds (FLOWER feet are flush to the wall, measured)',
      worst <= 1e-6,
      `closest is static ${BB_WALL_COUNT + worstAt}, ${(-worst).toFixed(2)}" clear of the bound`,
    );
    check(
      'solids: every non-wall static is AXIS-ALIGNED (rot = 0)',
      rotated < 0,
      rotated < 0 ? 'all six axis-aligned' : `static ${BB_WALL_COUNT + rotated} has rot=${extras[rotated].rot}`,
    );
  }

  // ── STAGING: WHAT A SPAWNED MATCH ACTUALLY HAS ON THE FIELD ───────────────
  /**
   * `stageBiobuzz` replaces the old random `scatterPollen` with the MANUAL's own staging
   * (§10.3.1), and the difference is that a scatter only has to be DETERMINISTIC while a
   * staging has to be RIGHT. 40 POLLEN and 16 NECTAR, each in a named place:
   *
   *   POLLEN  16 in the four FLOWERS (4 each, slots 0..3) · 8 on the GARDEN tiles (4 per
   *           garden) · 16 preloaded into the four robots
   *   NECTAR  6 in the up-CELLs (3 red in `hive:red`, 3 blue in `hive:blue`) · 10 in the two
   *           human players' hands (5 per alliance)
   *
   * THE PRELOAD IS THE PART THAT MOVES WITH THE ROSTER, and this world spawns only TWO robots
   * — one per alliance, the shape every other check in this file uses. So the two ABSENT
   * robots' 4 POLLEN each go to their own alliance's LOADING ZONE centre as `ground`, and a
   * robot whose hopper cap is under 4 spills the remainder onto the tiles beside it. Three
   * possible homes for the same 16 elements, so they are accounted for as a PARTITION rather
   * than as three independent counts — held, else ground in a LOADING ZONE, else ground beside
   * a robot — and what is asserted is that the partition covers all 16 with nothing left over.
   * A pollen that fell through the staging rules entirely lands in none of the three and fails
   * here with its own position printed.
   *
   * THE GARDEN FOUR ARE A LINE ONE DIAMETER APART, not merely inside the strip. The strip is
   * ~23 × 2 in, so four POLLEN in it are geometrically forced into a row whatever the code
   * does; what is NOT forced is the PITCH, and a row staged at a 4" pitch is the difference
   * between a robot sweeping all four in one pass and making four approaches. It is also the
   * cheapest statement that the row was placed by a rule rather than by a loop that happened
   * to fit.
   *
   * ⚠️ The garden and LOADING ZONE membership tests pad the rect by `BB_POLLEN_R`, because the
   * garden strip is 2" deep and a 2.8" POLLEN cannot have its centre inside it and its body on
   * the tiles at the same time. That pad is the MANUAL's own test — §10.5.3 credits an element
   * "at least partially in a GARDEN" — and not a tolerance invented to make a check pass.
   */
  {
    /** §10.3.1's per-place counts, named rather than spelled as literals in the assertions. */
    const PER_FLOWER = 4;
    const PER_GARDEN = 4;
    const HIVE_NECTAR = 3;
    const STOCK_NECTAR = 5;
    /** how far a robot's preload may have spilled and still be "on the tiles touching that
     * robot" — its footprint half-diagonal plus a couple of diameters of room for the solve to
     * have settled the spill. Generous on purpose: this arm exists to say a pollen is BESIDE A
     * ROBOT rather than lost, and it is the COUNT that binds. */
    const SPILL_NEAR = 26;

    const w = createBiobuzzWorld('match', 808, [setup(0, 'blue'), setup(1, 'red', {}, 1)]);
    const pollen = w.balls.filter((b) => b.color === 'yellow');
    const nectar = w.balls.filter((b) => b.color === 'red' || b.color === 'blue');

    check(
      `staging: ${BB_POLLEN_COUNT} POLLEN and ${2 * BB_NECTAR_COUNT} NECTAR, and nothing else`,
      pollen.length === BB_POLLEN_COUNT &&
        nectar.length === 2 * BB_NECTAR_COUNT &&
        w.balls.length === BB_POLLEN_COUNT + 2 * BB_NECTAR_COUNT,
      `${pollen.length} pollen + ${nectar.length} nectar = ${w.balls.length} balls`,
    );
    // THE RADIUS is what the renderer reads (and one day the solve), and it is the one field
    // that can be silently ABSENT — `Artifact.r` is optional, and an omitted one falls back to
    // the game's default, i.e. a NECTAR simulated and drawn as a POLLEN.
    check(
      'staging: every POLLEN carries r = BB_POLLEN_R and every NECTAR r = BB_NECTAR_R',
      pollen.every((b) => b.r === BB_POLLEN_R) && nectar.every((b) => b.r === BB_NECTAR_R),
      `pollen r=[${[...new Set(pollen.map((b) => b.r))].join(',')}] · ` +
        `nectar r=[${[...new Set(nectar.map((b) => b.r))].join(',')}]`,
    );
    // IDS ARE UNIQUE AND THE COUNTER IS PAST THEM. `nextBallId` is what a runtime spawn takes,
    // so a counter seeded at or below the highest staged id aliases a live element the first
    // time anything is created — and an aliased id is invisible until two balls begin tracking
    // one another.
    const ids = new Set(w.balls.map((b) => b.id));
    const maxId = Math.max(...w.balls.map((b) => b.id));
    check(
      'staging: every ball id is unique and nextBallId is seeded past the highest',
      ids.size === w.balls.length && (w.biobuzz?.nextBallId ?? 0) > maxId,
      `${ids.size}/${w.balls.length} unique · max id ${maxId} · nextBallId ${w.biobuzz?.nextBallId}`,
    );

    // -- POLLEN IN THE FLOWERS --------------------------------------------
    const inFlowers = pollen.filter(
      (b) => b.state.kind === 'element' && b.state.el.startsWith('flower:'),
    );
    check(
      `staging: ${BB_FLOWERS.length * PER_FLOWER} POLLEN are in FLOWERS`,
      inFlowers.length === BB_FLOWERS.length * PER_FLOWER,
      `${inFlowers.length} element-pollen with el "flower:*"`,
    );
    let flowersOk = true;
    let flowerDetail = '';
    for (let i = 0; i < BB_FLOWERS.length; i++) {
      const mine = inFlowers.filter((b) => b.state.kind === 'element' && b.state.el === `flower:${i}`);
      const slots = mine
        .map((b) => (b.state.kind === 'element' ? b.state.slot : -1))
        .sort((p, q) => p - q);
      const ok = mine.length === PER_FLOWER && slots.every((s, k) => s === k);
      if (!ok) {
        flowersOk = false;
        flowerDetail += `${flowerDetail ? ' · ' : ''}flower:${i} n=${mine.length} slots=[${slots.join(',')}]`;
      }
    }
    check(
      `staging: each of the four FLOWERS holds ${PER_FLOWER}, on slots 0..${PER_FLOWER - 1} exactly once`,
      flowersOk,
      flowerDetail || `all four full, slots 0..${PER_FLOWER - 1}`,
    );

    // -- POLLEN ON THE GARDEN TILES ---------------------------------------
    /** the §10.5.3 credit test — the element is AT LEAST PARTIALLY in the rect. */
    const inRect = (p: { x: number; y: number }, r: BbRect, pad: number): boolean =>
      p.x >= r.x0 - pad && p.x <= r.x1 + pad && p.y >= r.y0 - pad && p.y <= r.y1 + pad;
    const ground = pollen.filter((b) => b.state.kind === 'ground');
    const gardens = {
      red: ground.filter((b) => inRect(b.pos, BB_GARDEN.red, BB_POLLEN_R)),
      blue: ground.filter((b) => inRect(b.pos, BB_GARDEN.blue, BB_POLLEN_R)),
    };
    check(
      `staging: ${PER_GARDEN} POLLEN on the tiles in EACH GARDEN`,
      gardens.red.length === PER_GARDEN && gardens.blue.length === PER_GARDEN,
      `red ${gardens.red.length} · blue ${gardens.blue.length}`,
    );
    for (const a of ['red', 'blue'] as const) {
      const rect = BB_GARDEN[a];
      // the strip's LONG axis — x for both gardens today, DERIVED rather than assumed so a
      // garden moved onto a side wall by a V2 revision still measures the right spacing
      const alongX = rect.x1 - rect.x0 >= rect.y1 - rect.y0;
      const row = [...gardens[a]].sort((p, q) => (alongX ? p.pos.x - q.pos.x : p.pos.y - q.pos.y));
      let worstGap = 0;
      let worstOff = 0;
      for (let i = 1; i < row.length; i++) {
        const gap = alongX ? row[i].pos.x - row[i - 1].pos.x : row[i].pos.y - row[i - 1].pos.y;
        worstGap = Math.max(worstGap, Math.abs(gap - 2 * BB_POLLEN_R));
        worstOff = Math.max(
          worstOff,
          Math.abs(alongX ? row[i].pos.y - row[0].pos.y : row[i].pos.x - row[0].pos.x),
        );
      }
      check(
        `staging [${a} GARDEN]: the ${PER_GARDEN} POLLEN are a LINE, one POLLEN DIAMETER apart`,
        row.length === PER_GARDEN && worstGap <= 0.05 && worstOff <= 0.05,
        `worst pitch error ${worstGap.toFixed(3)}" off ${(2 * BB_POLLEN_R).toFixed(2)}" · ` +
          `worst cross-axis drift ${worstOff.toFixed(3)}"`,
      );
    }

    // -- THE 16 PRELOADED POLLEN, AS A PARTITION --------------------------
    const placed = new Set([...inFlowers, ...gardens.red, ...gardens.blue]);
    const rest = pollen.filter((b) => !placed.has(b));
    const held = rest.filter((b) => b.state.kind === 'held');
    const loose = rest.filter((b) => b.state.kind !== 'held');
    const inLz = loose.filter(
      (b) =>
        b.state.kind === 'ground' &&
        (inRect(b.pos, BB_LZ.red, BB_POLLEN_R) || inRect(b.pos, BB_LZ.blue, BB_POLLEN_R)),
    );
    const spilled = loose.filter(
      (b) =>
        !inLz.includes(b) &&
        b.state.kind === 'ground' &&
        w.robots.some((r) => Math.hypot(b.pos.x - r.pos.x, b.pos.y - r.pos.y) <= SPILL_NEAR),
    );
    const lost = loose.filter((b) => !inLz.includes(b) && !spilled.includes(b));
    const preload = BB_POLLEN_COUNT - BB_FLOWERS.length * PER_FLOWER - 2 * PER_GARDEN;
    check(
      `staging: the remaining ${preload} POLLEN are all accounted for by the PRELOAD rule`,
      rest.length === preload && lost.length === 0,
      `${held.length} held · ${inLz.length} in a LOADING ZONE · ${spilled.length} spilled beside a robot` +
        (lost.length
          ? ` · ${lost.length} UNACCOUNTED, first at (${lost[0].pos.x.toFixed(1)}, ${lost[0].pos.y.toFixed(1)}) state=${lost[0].state.kind}`
          : ''),
    );
    // A robot is preloaded with FOUR and no more. The hopper cap decides how many of those four
    // actually fit and the overflow is the `spilled` arm above, so no robot may ever be holding
    // a fifth — that would be the staging writing past a cap the intake then has to honour.
    const overFilled = w.robots
      .map((r) => ({
        id: r.id,
        n: held.filter((b) => b.state.kind === 'held' && b.state.robot === r.id).length,
      }))
      .filter((x) => x.n > 4);
    check(
      'staging: no robot is preloaded with more than its 4 POLLEN',
      overFilled.length === 0,
      overFilled.map((x) => `robot ${x.id} holds ${x.n}`).join(' · ') ||
        `${held.length} held across ${w.robots.length} robots`,
    );
    // AN ABSENT ROBOT'S SHARE GOES TO ITS OWN ALLIANCE'S ZONE. There are two absent robots
    // here, one per alliance, so BOTH zones have to be used: a rule that sent every orphan
    // share to one alliance's zone satisfies the partition above and is still wrong.
    const lzRed = inLz.filter((b) => inRect(b.pos, BB_LZ.red, BB_POLLEN_R)).length;
    const lzBlue = inLz.filter((b) => inRect(b.pos, BB_LZ.blue, BB_POLLEN_R)).length;
    check(
      'staging: an ABSENT robot’s share goes to its OWN alliance’s LOADING ZONE',
      lzRed === lzBlue && lzRed > 0,
      `red LZ ${lzRed} · blue LZ ${lzBlue}`,
    );

    // -- NECTAR: THE UP-CELLS AND THE HUMAN PLAYERS ------------------------
    const cells = nectar.filter((b) => b.state.kind === 'element');
    const stock = nectar.filter((b) => b.state.kind === 'stock');
    check(
      `staging: ${2 * HIVE_NECTAR} NECTAR in the up-CELLs and ${2 * STOCK_NECTAR} in the human players’ hands`,
      cells.length === 2 * HIVE_NECTAR && stock.length === 2 * STOCK_NECTAR,
      `${cells.length} element · ${stock.length} stock · ${nectar.length - cells.length - stock.length} elsewhere`,
    );
    for (const a of ['red', 'blue'] as const) {
      // A NECTAR IS IN ITS OWN ALLIANCE'S HIVE. `el` and `color` are two independent fields, so
      // a staging that filled the cells in array order puts red nectar in the blue hive while
      // still counting 3 and 3.
      const mine = cells.filter((b) => b.state.kind === 'element' && b.state.el === `hive:${a}`);
      const slots = mine
        .map((b) => (b.state.kind === 'element' ? b.state.slot : -1))
        .sort((p, q) => p - q);
      check(
        `staging [hive:${a}]: ${HIVE_NECTAR} NECTAR, all ${a}-coloured, on slots 0..${HIVE_NECTAR - 1}`,
        mine.length === HIVE_NECTAR && mine.every((b) => b.color === a) && slots.every((s, k) => s === k),
        `n=${mine.length} colours=[${[...new Set(mine.map((b) => b.color))].join(',')}] slots=[${slots.join(',')}]`,
      );
      const hand = stock.filter((b) => b.state.kind === 'stock' && b.state.alliance === a);
      check(
        `staging [${a} human player]: ${STOCK_NECTAR} NECTAR in hand, all ${a}-coloured`,
        hand.length === STOCK_NECTAR && hand.every((b) => b.color === a),
        `n=${hand.length} colours=[${[...new Set(hand.map((b) => b.color))].join(',')}]`,
      );
    }
  }

  // -- THE STATE BAG AGREES WITH world.balls --------------------------------
  /**
   * `flowers[i].stack`, `hives[a].contents` and `nectarStock[a]` are a SECOND VIEW of
   * `world.balls`, and this is the check that keeps them one thing.
   *
   * They exist for speed and for ORDER: `drawField.ts` reads a FLOWER's depth and a CELL's
   * count every frame, and both FLOWER scoring rules are about which NECTAR is top-most and
   * which is bottom-most (S10.5.2). None of that is derivable from the array cheaply, and all
   * of it is wrong the instant the two disagree -- a FLOWER that DRAWS 4 deep and CONSERVES 3
   * is invisible to every other check here, because conservation only ever counts the array.
   *
   * BOTH DIRECTIONS. An id in a stack must be a ball with that exact `el` tag, and a ball with
   * an `el` tag must be in that stack -- a one-way check passes a staging that simply forgot
   * to list the fourth POLLEN. ORDER too, since "bottom-most" is a scoring rule: the stack is
   * asserted to be the ball ids sorted by `slot`, not merely to hold the right set.
   *
   * RUN AFTER 300 TICKS as well as at t = 0. Nothing writes these fields at runtime yet, so
   * the second pass is trivially true today -- which is the point of writing it today. The
   * capture path, the tip machine and G418.B retrieval all land on this state next, and the
   * check that catches a bad writer has to exist BEFORE the writer does.
   */
  {
    const w = createBiobuzzWorld('match', 11, [
      setup(0, 'blue', {}, 0),
      setup(1, 'red', {}, 0),
    ]);
    const audit = (when: string): void => {
      const bb = w.biobuzz!;
      const byId = new Map(w.balls.map((b) => [b.id, b]));
      // FORWARD: every listed id is a ball, and it is tagged for the thing that lists it.
      const listed: number[] = [];
      const bad: string[] = [];
      const view = (tag: string, ids: readonly number[]): void => {
        for (const id of ids) {
          listed.push(id);
          const b = byId.get(id);
          if (!b) bad.push(`${tag}:${id} is not a ball`);
          else if (b.state.kind !== 'element' || b.state.el !== tag) {
            bad.push(`${tag}:${id} is ${b.state.kind === 'element' ? b.state.el : b.state.kind}`);
          }
        }
      };
      bb.flowers.forEach((f, i) => view(`flower:${i}`, f.stack));
      for (const a of ['red', 'blue'] as const) view(`hive:${a}`, bb.hives[a].contents);
      check(
        `state view [${when}]: every id in a FLOWER stack or a CELL is a ball with that el tag`,
        bad.length === 0,
        bad.length ? bad.join(' · ') : `${listed.length} ids`,
      );
      // REVERSE: every element-state ball is listed exactly once, by the thing it names.
      const elements = w.balls.filter((b) => b.state.kind === 'element');
      const seen = new Set(listed);
      const missing = elements.filter((b) => !seen.has(b.id));
      check(
        `state view [${when}]: every element-state ball is listed exactly once`,
        missing.length === 0 && listed.length === elements.length && seen.size === listed.length,
        `${elements.length} element balls · ${listed.length} listed · ${missing.length} unlisted`,
      );
      // ORDER: the stack is the ids sorted by slot, which is what "bottom-most" means.
      const slotOf = (id: number): number => {
        const b = byId.get(id);
        return b && b.state.kind === 'element' ? b.state.slot : -1;
      };
      const ordered = (ids: readonly number[]): boolean =>
        ids.every((id, k) => k === 0 || slotOf(ids[k - 1]) <= slotOf(id));
      check(
        `state view [${when}]: every stack runs bottom to top by slot`,
        bb.flowers.every((f) => ordered(f.stack)) &&
          (['red', 'blue'] as const).every((a) => ordered(bb.hives[a].contents)),
        bb.flowers.map((f) => `[${f.stack.map(slotOf).join('')}]`).join(''),
      );
      // THE COUNT: nectarStock is the stock balls, not a number typed next to them.
      const stockOf = (a: Alliance): number =>
        w.balls.filter((b) => b.state.kind === 'stock' && b.state.alliance === a).length;
      check(
        `state view [${when}]: nectarStock is the count of stock balls`,
        bb.nectarStock.red === stockOf('red') && bb.nectarStock.blue === stockOf('blue'),
        `state ${bb.nectarStock.red}/${bb.nectarStock.blue} · balls ${stockOf('red')}/${stockOf('blue')}`,
      );
    };
    audit('staged');
    w.match.phase = 'auto';
    for (let t = 0; t < 300; t++) biobuzzStep(w, C.SIM_DT, new Map());
    audit('300 ticks');
  }

  // -- THE UP-CELL COMES FROM THE STATE, NOT THE CONSTANT --------------------
  /**
   * Staging reads `hives[a].up` rather than `BB_HIVE_UP_STAGED`. At t = 0 the two agree by
   * construction (`emptyBiobuzzState` builds the staged tilt), so the only way to tell them
   * apart is to stage a world whose hives have ALREADY been tipped -- which is what a restored
   * snapshot or a mid-match scene is. Against the constant, the three NECTAR would go into the
   * cell facing the FLOOR.
   */
  {
    const PER_CELL = 3;
    const w = createBiobuzzWorld('match', 12, [setup(0, 'blue', {}, 0)]);
    const bb = w.biobuzz!;
    bb.hives.red.up = 'north';
    bb.hives.blue.up = 'south';
    stageBiobuzz(w);
    for (const a of ['red', 'blue'] as const) {
      const want = bb.hives[a].up === 'south' ? -BB_HIVE_CELL_DY : BB_HIVE_CELL_DY;
      const got = bb.hives[a].contents.map((id) => w.balls.find((b) => b.id === id)!.pos.y);
      check(
        `state view: re-staging a TIPPED ${a} HIVE fills the cell that is UP`,
        got.length === PER_CELL && got.every((y) => Math.abs(y - want) < 1e-9),
        `up=${bb.hives[a].up} want y=${want.toFixed(1)} got=[${got.map((y) => y.toFixed(1)).join(',')}]`,
      );
    }
  }

  // ── CONSERVATION: 56 ELEMENTS, EVERY TICK, WITH TWO ROBOTS DRIVING ───────
  /**
   * THE INVARIANT THE WHOLE STAGING MODEL RESTS ON — and the reason it is its own check rather
   * than an extension of the POLLEN conservation above.
   *
   * The old shell had ONE kind of element in ONE state: 60 POLLEN, all `ground`, and
   * "conserved" meant `world.balls.length` did not change. Staging replaced that with 56
   * elements distributed across FIVE states that hand off to one another all match — a POLLEN
   * goes `element` → `ground` when it is knocked out of a FLOWER, `ground` → `held` when a
   * sweeper takes it, `held` → `flight` when it is launched, `flight` → `element` when it
   * lands in a CELL, and a NECTAR goes `stock` → `ground` when a human player puts one in.
   * Every one of those is a hand-written transition, and the failure mode of a hand-written
   * transition is that it writes the destination and forgets to clear the source (a DUPLICATE)
   * or clears the source and never writes the destination (a DELETION). `world.balls.length`
   * catches neither on its own: a ball moved into a state nothing reads is still in the array.
   *
   * So this sums the FIVE buckets and demands the total. A ball that has fallen into `basin`
   * or `rail` — DECODE states this game does not use and cannot legitimately reach — is in no
   * bucket and fails here, which is the whole reason to count buckets instead of the array.
   *
   * EVERY TICK, NOT THE LAST ONE, for the same reason the containment checks read every tick:
   * a duplicate created and reaped inside a second is invisible at the end of a run and is
   * exactly as much of a bug.
   *
   * ⚠️ A 'match' world spawns in `pre` with `preCountdown` null — the CONTROLLER starts a solo
   * match — so its robots are DISABLED, and 600 ticks of commands would move nobody. The phase
   * is advanced to `auto` by hand first, which is what that start does; without it this is 600
   * ticks of a still field and proves nothing about a robot driving through a staged FLOWER.
   * It is still the real staged `match` world, which is the state being conserved.
   */
  {
    const w = createBiobuzzWorld('match', 1212, [setup(0, 'blue'), setup(1, 'red', {}, 1)]);
    w.match.phase = 'auto';
    w.match.phaseTimeLeft = C.AUTO_DURATION;
    const total = BB_STAGED_TOTAL;
    // two DIFFERENT drives on purpose: one straight across the field, one arcing, so between
    // them the pair sweeps the staged rows, the FLOWER feet and the frame bars instead of
    // running the same line twice
    const cmds = new Map([
      [0, cmd({ driveY: 1, intake: true })],
      [1, cmd({ driveY: 1, rotate: 0.4, intake: true })],
    ]);
    let worstSum = total;
    let worstAt = -1;
    let pollenOff = 0;
    let nectarOff = 0;
    let dupAt = -1;
    for (let i = 0; i < 600; i++) {
      biobuzzStep(w, C.SIM_DT, cmds);
      let ground = 0;
      let inHand = 0;
      let flight = 0;
      let element = 0;
      let stock = 0;
      let pollen = 0;
      let nectar = 0;
      const seen = new Set<number>();
      for (const b of w.balls) {
        seen.add(b.id);
        if (b.color === 'yellow') pollen++;
        else nectar++;
        switch (b.state.kind) {
          case 'ground':
            ground++;
            break;
          case 'held':
            inHand++;
            break;
          case 'flight':
            flight++;
            break;
          case 'element':
            element++;
            break;
          case 'stock':
            stock++;
            break;
          default:
            break; // basin / rail — DECODE's, unreachable here, and OUT of the sum on purpose
        }
      }
      const sum = ground + inHand + flight + element + stock;
      if (Math.abs(sum - total) > Math.abs(worstSum - total)) {
        worstSum = sum;
        worstAt = i;
      }
      pollenOff = Math.max(pollenOff, Math.abs(pollen - BB_POLLEN_COUNT));
      nectarOff = Math.max(nectarOff, Math.abs(nectar - 2 * BB_NECTAR_COUNT));
      if (dupAt < 0 && seen.size !== w.balls.length) dupAt = i;
    }
    check(
      `conservation: ground|held|flight|element|stock sums to ${total} on ALL 600 ticks of a 2-robot drive`,
      worstSum === total,
      worstAt < 0 ? `held ${total} throughout` : `worst ${worstSum} at tick ${worstAt}`,
    );
    check(
      `conservation: ${BB_POLLEN_COUNT} POLLEN and ${2 * BB_NECTAR_COUNT} NECTAR throughout (nothing changes KIND)`,
      pollenOff === 0 && nectarOff === 0,
      `worst drift: pollen ${pollenOff}, nectar ${nectarOff}`,
    );
    check(
      'conservation: ball ids stay unique on every one of those ticks',
      dupAt < 0,
      dupAt < 0 ? `${w.balls.length} distinct ids` : `first duplicate at tick ${dupAt}`,
    );
  }

  // ── EVERY NEW SOLID PUSHES A ROBOT OFF ITSELF ─────────────────────────────
  /**
   * A COLLIDER THAT IS IN THE ARRAY BUT NOT IN THE SOLVE IS INVISIBLE TO EVERY OTHER CHECK
   * HERE. The geometry checks above read `biobuzzColliders.statics` directly, so they would
   * pass on a field whose frame bars and FLOWER feet are perfectly placed and completely
   * INTANGIBLE — a robot drives through an absent collider without complaint and a POLLEN
   * rolls over it.
   *
   * So each of the six new solids is measured THROUGH THE SOLVE, in the shape the `pin-wall`
   * and wall-containment checks use: one world per solid (a robot already shoved off one bar
   * is not a clean start for the next), a robot placed ON the solid, a couple of seconds of
   * ZERO command, and the same `aabb` footprint measure at the same `WALL_EPS` resting slop
   * those checks are stated in. Zero command rather than a drive, deliberately: this asks what
   * the SOLVER does about an overlap, not whether a driver can escape one.
   *
   * ⚠️ THE START POSE IS THE SOLID'S CENTRE, SLID INSIDE THE PERIMETER, and the slide is not a
   * fudge. A FLOWER foot stands `BB_FLOWER_D` (3") off its wall, so a 17" chassis centred
   * exactly on it BEGINS with most of its footprint through the wall — and `solveRobots`'
   * containment invariant clamps GROWTH only, deliberately leaving a body that was ALREADY
   * outside where it is, so the in-bounds arm of this check would fail on a correct solve.
   * Sliding the start in by exactly its overshoot keeps the robot ON the foot (a 2.6"
   * half-extent sits well inside a chassis half-extent) while making "still inside the field"
   * a claim the solver is actually answerable for. The `starts on it` assertion is what proves
   * the slide did not slide the robot off the thing it is meant to be sitting on — without it
   * this check could pass by never testing anything.
   */
  {
    /** the penetration depth of footprint box `b` into axis-aligned static `s`; <= 0 is clear. */
    const overlapOf = (
      b: { x0: number; x1: number; y0: number; y1: number },
      s: { hx: number; hy: number; tx: number; ty: number },
    ): number =>
      Math.min(
        Math.min(b.x1, s.tx + s.hx) - Math.max(b.x0, s.tx - s.hx),
        Math.min(b.y1, s.ty + s.hy) - Math.max(b.y0, s.ty - s.hy),
      );

    biobuzzColliders.statics.slice(BB_WALL_COUNT).forEach((s, i) => {
      const name = i < 2 ? `frame bar ${i}` : `flower foot ${i - 2}`;
      const w = mkWorld('free', 31 + i);
      const r = w.robots[0];
      r.heading = 0;
      r.vel = { x: 0, y: 0 };
      r.pos = { x: s.tx, y: s.ty };
      // ...then slide the START pose inside the perimeter by exactly its overshoot, so the
      // containment invariant applies to it at all (see the block comment).
      const b0 = aabb(r);
      r.pos = {
        x: r.pos.x + Math.max(0, -BB_HALF_X - b0.x0) - Math.max(0, b0.x1 - BB_HALF_X),
        y: r.pos.y + Math.max(0, -BB_HALF_Y - b0.y0) - Math.max(0, b0.y1 - BB_HALF_Y),
      };
      const before = overlapOf(aabb(r), s);
      check(
        `solid [${name}]: the robot really does START on it (so this check is not vacuous)`,
        before > 0,
        `overlap ${before.toFixed(2)}" at (${r.pos.x.toFixed(1)}, ${r.pos.y.toFixed(1)})`,
      );
      run(w, cmd({}), 2); // 120 ticks, no command at all
      const b1 = aabb(r);
      const after = overlapOf(b1, s);
      check(
        `solid [${name}]: 2 s later the solve has pushed the robot off it`,
        after <= WALL_EPS,
        `overlap ${after.toFixed(3)}" (was ${before.toFixed(2)}") · now at (${r.pos.x.toFixed(1)}, ${r.pos.y.toFixed(1)})`,
      );
      check(
        `solid [${name}]: and it was not pushed out of the FIELD to get there`,
        b1.x0 >= -BB_HALF_X - WALL_EPS &&
          b1.x1 <= BB_HALF_X + WALL_EPS &&
          b1.y0 >= -BB_HALF_Y - WALL_EPS &&
          b1.y1 <= BB_HALF_Y + WALL_EPS,
        `x ${b1.x0.toFixed(2)}..${b1.x1.toFixed(2)} · y ${b1.y0.toFixed(2)}..${b1.y1.toFixed(2)}`,
      );
    });
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

  // ── NO SCENE CARRIES A DANGLING ELEMENT ID ──────────────────────────────
  /**
   * `flowers[i].stack` and `hives[a].contents` hold IDS; the elements themselves live in
   * `world.balls`. The readout is that JOIN, so an id with no ball behind it draws NOTHING and
   * the world still looks plausible — until the id ALIASES something else and the miss becomes
   * a ball drawn in the wrong place. `hive-ground` lost three floor POLLEN to F1's staged stack
   * exactly that way: `createBiobuzzWorld` stages a full field, `bbWorld` then replaces
   * `world.balls` with the scene's own layout, and the staged ids stayed in the bag.
   *
   * EVERY SCENE, AT EVERY STILL, and both directions. The forward check is the one the fix
   * buys (`bbWorld` reindexes after its replace); the reverse one is what stops the fix being
   * "clear the stacks" — an element ball that exists and is listed by nobody renders as a disc
   * floating where its parked position happens to be, which is the same picture from the other
   * side. The tag has to agree too: a ball tagged `flower:2` listed under F1 is a stack that
   * scores the wrong FLOWER.
   */
  for (const scene of BB_SCENES.filter((s) => s.lane === 'field')) {
    for (const { tick, world } of bbSceneStills(scene)) {
      const bb = world.biobuzz;
      if (!bb) continue;
      const byId = new Map(world.balls.map((b) => [b.id, b]));
      const listed: number[] = [];
      const bad: string[] = [];
      const view = (tag: string, ids: readonly number[]): void => {
        for (const id of ids) {
          listed.push(id);
          const b = byId.get(id);
          if (!b) bad.push(`${tag} lists ${id}, which is not a ball`);
          else if (b.state.kind !== 'element') bad.push(`${tag}:${id} is ${b.state.kind}`);
          else if (b.state.el !== tag) bad.push(`${tag}:${id} is tagged ${b.state.el}`);
        }
      };
      bb.flowers.forEach((f, i) => view(`flower:${i}`, f.stack));
      for (const a of ['red', 'blue'] as const) view(`hive:${a}`, bb.hives[a].contents);
      check(
        `scene [${scene.id}@${tick}]: every id in a FLOWER stack or an up-CELL resolves to a ball`,
        bad.length === 0,
        bad.length ? bad.join(' · ') : `${listed.length} ids resolve`,
      );
      const seen = new Set(listed);
      const orphans = world.balls.filter((b) => b.state.kind === 'element' && !seen.has(b.id));
      check(
        `scene [${scene.id}@${tick}]: every element ball is listed exactly once`,
        orphans.length === 0 && seen.size === listed.length,
        `${listed.length} listed · ${seen.size} distinct · ${orphans.length} unlisted`,
      );
    }
  }

  // -- THE FIELD IS LIVE: A REAL TIP, THROUGH THE REAL PIPELINE --------------
  /**
   * Everything above tests a PURE function. This drives `updateBiobuzz` itself, tick by tick,
   * and watches one HIVE go all the way round: three POLLEN launched into the up-CELL, the
   * swing starting on the tick the load completes, the contents leaving the tray as it passes
   * LEVEL, and the TIP landing two seconds later with the cells swapped.
   *
   * It is the check the pure ones cannot make: `hiveStep` is correct in isolation and still
   * useless if `play.ts` calls it before the capture stage, drops the spilled ids on the floor
   * as a count rather than as the ELEMENTS they are, or lets the swing run while the cell is
   * still accepting. Every one of those is a conservation bug, and conservation is asserted
   * here on EVERY TICK rather than at the end — a leak that cancels a duplicate is invisible
   * to an end-state count, and a bucket-by-bucket per-tick partition is what catches it.
   */
  {
    const w = createBiobuzzWorld('match', 7, [setup(0, 'red', {}, 0), setup(1, 'blue', {}, 0)]);
    const bb = w.biobuzz!;
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 120;
    const TOTAL = w.balls.length;
    const A: Alliance = 'red';
    const upAt0 = bb.hives[A].up;
    const cellAt0 = hiveCellPos(A, upAt0);
    const zMid = (BB_HIVE_OPEN_Z[0] + BB_HIVE_OPEN_Z[1]) / 2;
    const sign = hiveApproachSign(upAt0); // +1 for a south-up cell: it takes vy > 0

    // THE LOAD. The staged cell already holds 3 NECTAR (10.3.1), and `BB_TIP_POLLEN[3]` is 3,
    // so three POLLEN is exactly the row that tips it — the threshold is READ from the table
    // rather than typed, so a revised table revises the scene instead of breaking it.
    const NEED = BB_TIP_POLLEN[3];
    const shots = w.balls
      .filter((b) => b.state.kind === 'ground' && b.color !== 'red' && b.color !== 'blue')
      .slice(0, NEED);
    for (const b of shots) {
      b.state = { kind: 'flight', target: A };
      b.pos = { x: cellAt0.x, y: cellAt0.y - sign * 2 };
      b.vel = { x: 0, y: sign * 24 };
      b.z = zMid + 1;
      b.vz = -18;
    }

    // THE PARTITION. Every ball is in exactly one of five states, and the five have to add up
    // to the array they are drawn from — on every tick, not at the end.
    const buckets = (): Record<string, number> => {
      const n: Record<string, number> = { ground: 0, flight: 0, held: 0, element: 0, stock: 0, other: 0 };
      for (const b of w.balls) n[b.state.kind in n ? b.state.kind : 'other']++;
      return n;
    };
    const inCells = (): number => bb.hives.red.contents.length + bb.hives.blue.contents.length;
    const inFlowers = (): number => bb.flowers.reduce((s, f) => s + f.stack.length, 0);

    let leak = '';
    let loadedAt = -1;
    let swingAt = -1;
    let spillAt = -1;
    let tipAt = -1;
    let spilledGround = 0;
    let contentsAtRelease: number[] = [];
    // measured ON THE SPILL TICK: these are ground elements from that moment on, so the shared
    // solve and the rolling-friction pass have them by the end of the very next tick and the
    // velocity they LEFT THE TRAY with is gone. Reading it at the end of the scene would assert
    // that a spilled element comes to rest, which it should, and nothing about the spill.
    let spillVel: { v: number; out: boolean }[] = [];
    const TICKS = Math.round((BB_TIP_SWING_S + BB_NECTAR_ENTRY_S + 0.5) / C.SIM_DT);
    for (let t = 0; t < TICKS; t++) {
      const before = [...bb.hives[A].contents];
      updateBiobuzz(w, C.SIM_DT, new Map(), true, NO_SWEEP);
      const n = buckets();
      const sum = n.ground + n.flight + n.held + n.element + n.stock;
      if (!leak) {
        if (sum !== TOTAL || n.other !== 0 || w.balls.length !== TOTAL) {
          leak = `tick ${t}: ${JSON.stringify(n)} sums to ${sum}, array ${w.balls.length}, expected ${TOTAL}`;
        } else if (n.element !== inCells() + inFlowers()) {
          leak = `tick ${t}: ${n.element} element-state balls but ${inCells()} in cells + ${inFlowers()} in flowers`;
        }
      }
      if (loadedAt < 0 && bb.hives[A].contents.length === before.length + NEED) loadedAt = t;
      if (swingAt < 0 && bb.hives[A].tipping > 0) swingAt = t;
      if (spillAt < 0 && before.length > 0 && bb.hives[A].contents.length === 0) {
        spillAt = t;
        contentsAtRelease = before;
        const back = before.map((id) => w.balls.find((x) => x.id === id));
        spilledGround = back.filter((b) => !!b && b.state.kind === 'ground').length;
        spillVel = back
          .filter((b): b is Artifact => !!b)
          .map((b) => ({ v: Math.hypot(b.vel.x, b.vel.y), out: b.vel.y * sign < 0 }));
      }
      if (tipAt < 0 && bb.hives[A].tips > 0) tipAt = t;
    }

    check(
      'live: three POLLEN launched INBOARD over the opening are taken by the up-CELL',
      loadedAt === 0,
      loadedAt === 0
        ? `captured on the first tick; the cell holds ${NEED} POLLEN over the 3 staged NECTAR`
        : `loaded at tick ${loadedAt} (expected 0); contents ${bb.hives[A].contents.length}`,
    );
    check(
      'live: element conservation holds on EVERY tick — ground + flight + held + element + stock',
      leak === '',
      leak || `${TICKS} ticks, ${TOTAL} elements, five buckets, no tick off by one`,
    );
    // The swing starts on the SAME tick the load completes: stage 3 runs after the capture
    // stage, on purpose, so the element that fills the cell tips it on arrival.
    check(
      'live: the swing starts on the tick the load completes, not the tick after',
      swingAt === loadedAt && swingAt === 0,
      `loaded at ${loadedAt}, swinging at ${swingAt}`,
    );
    // RELEASE AT LEVEL, i.e. half way: `BB_TIP_RELEASE_S` of a `BB_TIP_SWING_S` swing REMAIN,
    // so the spill lands after SWING - RELEASE seconds. One tick of slack, because the swing
    // is started partway through the tick that triggers it.
    const wantSpill = Math.round((BB_TIP_SWING_S - BB_TIP_RELEASE_S) / C.SIM_DT);
    check(
      `live: the tray empties as it passes LEVEL, ~${(BB_TIP_SWING_S - BB_TIP_RELEASE_S).toFixed(1)}s into the swing`,
      spillAt >= 0 && Math.abs(spillAt - wantSpill) <= 1,
      `spilled at tick ${spillAt} (expected ~${wantSpill})`,
    );
    check(
      'live: the release puts EXACTLY the contents back on the tiles, as GROUND elements',
      contentsAtRelease.length === NEED + 3 && spilledGround === contentsAtRelease.length,
      `${contentsAtRelease.length} in the cell (expected ${NEED + 3}) → ${spilledGround} on the ground`,
    );
    // ...AND THEY ARE MOVING. A spill that arrives at rest piles under the down cell; the whole
    // point of `spillPoses` is that the elements leave over the open OUTER end with outboard
    // speed and cross the field (G409).
    //
    // ⚠️ THE EXACT RANGE IS PINNED BY THE PURE `spillPoses` CHECK, NOT HERE, because six elements
    // land in one 20 × 10.43 in cell mouth OVERLAPPING (a real tray dumps a pile, not a rank) and
    // with the ±`BB_SPILL_FAN` fan they now diverge INTO each other — measured, one pair of the
    // six starts 3.44 in apart on 3.60 in of diameter. The shared solve separates them on this
    // very tick, so what is readable here is each element's speed AFTER its first collision, and
    // two of six come out under the draw. Under the old straight-outboard model every element
    // went the same way and nothing collided, which is the only reason a hard per-element band
    // ever passed. So this asserts what the LIVE path can honestly assert: everything is
    // outboard, nothing GAINED speed, nothing arrived near rest, and most of them still carry
    // their draw.
    {
      const moving = spillVel;
      const inBand = moving.filter((m) => m.v >= BB_SPILL_SPEED[0] - 1 && m.v <= BB_SPILL_SPEED[1] + 1);
      const fastest = Math.max(...moving.map((m) => m.v));
      check(
        'live: spilled elements carry the spill velocity — outboard, none faster than the draw, none at rest',
        moving.length > 0 &&
          moving.every((m) => m.out && m.v <= BB_SPILL_SPEED[1] + 1 && m.v > C.BALL_REST_SPEED * 4) &&
          fastest >= BB_SPILL_SPEED[0] &&
          inBand.length * 2 >= moving.length,
        `speeds ${moving.map((m) => m.v.toFixed(1)).join(', ')} in/s (draw ${BB_SPILL_SPEED[0]}..${BB_SPILL_SPEED[1]})` +
          ` · ${inBand.length}/${moving.length} still in band after the first solve · fastest ${fastest.toFixed(1)}` +
          ` · all outboard ${moving.every((m) => m.out)}`,
      );
    }
    const wantTip = Math.round(BB_TIP_SWING_S / C.SIM_DT);
    check(
      `live: the TIP completes after BB_TIP_SWING_S (${BB_TIP_SWING_S}s) and flips the up cell`,
      tipAt >= 0 && Math.abs(tipAt - wantTip) <= 1 && bb.hives[A].up !== upAt0 && bb.hives[A].tips === 1,
      `tipped at tick ${tipAt} (expected ~${wantTip}) · up ${upAt0} → ${bb.hives[A].up} · tips ${bb.hives[A].tips}`,
    );
    // `released` is the latch that makes the spill happen ONCE. Back to false at the settle, or
    // the next swing would empty the tray the instant it started.
    check(
      'live: `released` latches through the swing and resets at the settle',
      bb.hives[A].released === false && bb.hives[A].tipping === 0,
      `released=${bb.hives[A].released} tipping=${bb.hives[A].tipping}`,
    );
    // THE ENTITLEMENT THE TIP EARNS (G426) — this lane's half of the human player.
    check(
      'live: a completed TIP earns one NECTAR entry, and the human player makes it',
      bb.nectarStock[A] === 4 && bb.nectarDue[A] === 0,
      `stock ${bb.nectarStock[A]} (5 at setup, 4 after one entry) · still due ${bb.nectarDue[A]}`,
    );
    {
      const entered = w.balls.filter(
        (b) => b.state.kind === 'ground' && b.color === A && Math.abs(b.pos.x) > BB_HALF_X - 24,
      );
      check(
        'live: the entered NECTAR is a GROUND element in its own LOADING ZONE, not a new ball',
        entered.length >= 1 && w.balls.length === TOTAL,
        `${entered.length} red NECTAR near the red wall · ${w.balls.length} balls (was ${TOTAL})`,
      );
    }
  }

  // -- THE HUMAN PLAYER: A DRIP, THEN THE 1:00 DUMP -------------------------
  /**
   * G426 gives an alliance ONE NECTAR entry per completed TIP and, at the 1:00 cue, everything
   * still in its hands. Those are two ENTITLEMENTS running through one clock, and the check is
   * that the second does not become a teleport: five NECTAR appear one at a time over about
   * five seconds, never as a pile on one tile on one tick.
   *
   * NOTHING IS SPAWNED. The five exist from setup as `stock` balls (`spawn.ts`) already sitting
   * on their entry spot, so an entry is a STATE FLIP and the array length never changes — which
   * is the whole reason conservation is a count over one array.
   */
  {
    const w = createBiobuzzWorld('match', 9, [setup(0, 'red', {}, 0), setup(1, 'blue', {}, 0)]);
    const bb = w.biobuzz!;
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = BB_FLOWER_UNLOCK_S; // exactly at the cue
    const TOTAL = w.balls.length;
    const STOCK0 = bb.nectarStock.red;
    const onGround = (a: Alliance): number =>
      w.balls.filter((b) => {
        const z = BB_LZ[a];
        return (
          b.state.kind === 'ground' &&
          b.color === a &&
          b.pos.x >= z.x0 && b.pos.x <= z.x1 && b.pos.y >= z.y0 && b.pos.y <= z.y1
        );
      }).length;
    let maxPerTick = 0;
    let prev = onGround('red');
    const N = Math.round((STOCK0 * BB_NECTAR_DUMP_S + 1) / C.SIM_DT);
    for (let t = 0; t < N; t++) {
      updateBiobuzz(w, C.SIM_DT, new Map(), true, NO_SWEEP);
      const now = onGround('red');
      maxPerTick = Math.max(maxPerTick, now - prev);
      prev = now;
    }
    check(
      'human player: the 1:00 cue empties the alliance stock, ONE NECTAR AT A TIME',
      bb.nectarStock.red === 0 && maxPerTick === 1 && onGround('red') === STOCK0 && w.balls.length === TOTAL,
      `stock ${STOCK0} → ${bb.nectarStock.red} · ${onGround('red')} in the LOADING ZONE · ` +
        `most entered on one tick: ${maxPerTick} · balls ${w.balls.length} (was ${TOTAL})`,
    );
    // …and the beat is real: five entries at `BB_NECTAR_DUMP_S` apart cannot be done in one.
    check(
      'human player: the entries are spread over the dump, not delivered on one tick',
      N * C.SIM_DT >= STOCK0 * BB_NECTAR_DUMP_S,
      `${STOCK0} entries at ${BB_NECTAR_DUMP_S}s apart over ${(N * C.SIM_DT).toFixed(1)}s`,
    );
    // NOTHING ENTERS WHILE THE FIELD IS FROZEN — `enabled` false is the transition and the
    // period after the buzzer, which is exactly when G426 forbids a human player reaching in.
    {
      const f = createBiobuzzWorld('match', 9, [setup(0, 'red', {}, 0)]);
      const fb = f.biobuzz!;
      f.match.phase = 'teleop';
      f.match.phaseTimeLeft = BB_FLOWER_UNLOCK_S;
      for (let t = 0; t < 600; t++) updateBiobuzz(f, C.SIM_DT, new Map(), false, NO_SWEEP);
      check(
        'human player: nothing enters while the field is frozen (enabled === false)',
        fb.nectarStock.red === STOCK0 && fb.nectarStock.blue === STOCK0,
        `stock ${fb.nectarStock.red}/${fb.nectarStock.blue} after 10s disabled (was ${STOCK0} each)`,
      );
    }
  }

  // -- THE OPEN FACE IS ONE FACE: A SHOT FROM THE CLOSED SIDE IS A MISS ------
  /**
   * The ruling (field-plan 2.1) is that a CELL is open at its OUTER end ONLY, so the two shots
   * below differ in NOTHING but the sign of `vy` — same point, same height, same descent — and
   * exactly one of them scores. A miss is not a foul (G417.H): the element keeps flying and
   * lands on the tiles, which is what the second half asserts.
   */
  {
    const shoot = (toward: 1 | -1): { took: boolean; kind: string; balls: number } => {
      const w = createBiobuzzWorld('match', 11, [setup(0, 'red', {}, 0)]);
      const bb = w.biobuzz!;
      w.match.phase = 'teleop';
      w.match.phaseTimeLeft = 120;
      const A: Alliance = 'red';
      const up = bb.hives[A].up;
      const cell = hiveCellPos(A, up);
      const s = hiveApproachSign(up) * toward; // toward=+1 inboard, -1 through the closed back
      const before = bb.hives[A].contents.length;
      const b = w.balls.find((x) => x.state.kind === 'ground')!;
      b.state = { kind: 'flight', target: A };
      b.pos = { x: cell.x, y: cell.y - s * 2 };
      b.vel = { x: 0, y: s * 24 };
      b.z = (BB_HIVE_OPEN_Z[0] + BB_HIVE_OPEN_Z[1]) / 2 + 1;
      b.vz = -18;
      updateBiobuzz(w, C.SIM_DT, new Map(), true, NO_SWEEP);
      return { took: bb.hives[A].contents.length > before, kind: b.state.kind, balls: w.balls.length };
    };
    const inbound = shoot(1);
    const closed = shoot(-1);
    check(
      'live: a shot travelling TOWARD THE PIVOT is accepted by the up-CELL',
      inbound.took && inbound.kind === 'element',
      `took=${inbound.took} state=${inbound.kind}`,
    );
    check(
      'live: the same shot from the CLOSED side is rejected and stays a live element',
      !closed.took && closed.kind === 'flight' && closed.balls === inbound.balls,
      `took=${closed.took} state=${closed.kind} — a miss keeps flying (G417.H), it is not consumed`,
    );
  }

  // -- A CELL TAKES ONLY ITS OWN ALLIANCE'S ELEMENT (owner ruling 2026-09-12) -
  /**
   * Nothing in the manual bans launching into the OPPONENT's up-CELL, and nothing in the
   * geometry stops it: the two HIVES are 25.5 in apart across field centre, so either opening
   * is reachable from most of the field, and a TIP is worth 20 to whoever owns the cell. The
   * owner's ruling is that the shot simply DOES NOT ENTER — it is a miss, it lands as ground,
   * and it is not penalised (field-plan 2.1, ruling 2).
   *
   * The two shots below differ in NOTHING but `by`, the alliance that launched them: same
   * cell, same point, same approach, same descent. One goes in and one does not, which is the
   * ruling and nothing else. The third case is the fallback: a flight element with NO `by` —
   * every DECODE and Chain Reaction flight, and any BIOBUZZ snapshot recorded before the field
   * stamped it — is still accepted, because refusing those would break replays of matches that
   * were legal when they were played.
   *
   * A REFUSED SHOT IS STILL A LIVE ELEMENT. It is not consumed, not teleported and not fouled;
   * it keeps the arc it had and reaches the tiles, which is the second check.
   */
  {
    const shoot = (by: Alliance | undefined): { took: boolean; kind: string; balls: number; landed: string } => {
      const w = createBiobuzzWorld('match', 23, [setup(0, 'red', {}, 0), setup(1, 'blue', {}, 0)]);
      const bb = w.biobuzz!;
      w.match.phase = 'teleop';
      w.match.phaseTimeLeft = 120;
      // THE HIVE UNDER TEST IS BLUE'S, FIXED, so `by` is the only thing that varies.
      const H: Alliance = 'blue';
      const up = bb.hives[H].up;
      const cell = hiveCellPos(H, up);
      const sgn = hiveApproachSign(up);
      const before = bb.hives[H].contents.length;
      const b = w.balls.find((x) => x.state.kind === 'ground')!;
      b.state = by ? { kind: 'flight', target: by, by } : { kind: 'flight', target: H };
      b.pos = { x: cell.x, y: cell.y - sgn * 2 };
      b.vel = { x: 0, y: sgn * 24 };
      b.z = (BB_HIVE_OPEN_Z[0] + BB_HIVE_OPEN_Z[1]) / 2 + 1;
      b.vz = -18;
      updateBiobuzz(w, C.SIM_DT, new Map(), true, NO_SWEEP);
      const took = bb.hives[H].contents.length > before;
      const kind = b.state.kind;
      // and then let the miss finish its arc: 1 s is well past the fall from the opening.
      for (let t = 0; t < 60; t++) updateBiobuzz(w, C.SIM_DT, new Map(), true, NO_SWEEP);
      return { took, kind, balls: w.balls.length, landed: b.state.kind };
    };
    const own = shoot('blue');
    const opp = shoot('red');
    const legacy = shoot(undefined);
    check(
      'live: BLUE\u2019s up-CELL takes a shot launched BY BLUE',
      own.took && own.kind === 'element',
      `took=${own.took} state=${own.kind}`,
    );
    check(
      'live: the SAME shot launched BY RED is refused — it is a miss, not a TIP for blue',
      !opp.took && opp.kind === 'flight' && opp.balls === own.balls,
      `took=${opp.took} state=${opp.kind} \u00b7 balls ${opp.balls} vs ${own.balls} \u2014 nothing consumed`,
    );
    check(
      'live: ...and the refused element lands on the tiles as GROUND, un-fouled',
      opp.landed === 'ground',
      `after 1 s it is ${opp.landed}`,
    );
    check(
      'live: a flight element with NO `by` is still accepted — old snapshots keep working',
      legacy.took && legacy.kind === 'element',
      `took=${legacy.took} state=${legacy.kind}`,
    );
  }

  // -- THE AIM LIST AND THE CAPTURE TEST DESCRIBE THE SAME OPENING -----------
  /**
   * `play.ts` captures by walking `scoreTargets()`, and `hiveAccepts` decides whether a CELL
   * took the shot. Those are two descriptions of one face — `ScoreTarget.mouth` is the outward
   * normal, `hiveApproachSign` is the direction an element must TRAVEL to get in — and they
   * are opposite by construction. Nothing at run time notices if they stop being opposite:
   * Lane B would aim at a cell the field then refuses, which reads as "my shots do not score"
   * and is invisible to every pure test on either side.
   */
  {
    const w = createBiobuzzWorld('match', 3, [setup(0, 'red', {}, 0)]);
    const bb = w.biobuzz!;
    const bad: string[] = [];
    for (const a of ['red', 'blue'] as const) {
      for (const up of ['north', 'south'] as const) {
        bb.hives[a].up = up;
        const t = scoreTargets(w, a).find((x) => x.id === `hive:${a}`)!;
        const m = t.mouth!;
        if (m.x !== 0 || m.y !== -hiveApproachSign(up)) {
          bad.push(`${a}/${up}: mouth (${m.x},${m.y}) vs approach ${hiveApproachSign(up)}`);
        }
        const c = hiveCellPos(a, up);
        if (Math.abs(t.pos.x - c.x) > 1e-9 || Math.abs(t.pos.y - c.y) > 1e-9) {
          bad.push(`${a}/${up}: target at (${t.pos.x},${t.pos.y}) vs cell (${c.x},${c.y})`);
        }
      }
    }
    check(
      'live: ScoreTarget.mouth is the exact opposite of hiveApproachSign, on both hives',
      bad.length === 0,
      bad.length
        ? bad.join(' · ')
        : 'four cases: an element enters AGAINST the mouth normal, and the target sits on the up cell',
    );
  }

  // -- THE TIP TABLE IS A TABLE ---------------------------------------------
  /**
   * `BB_TIP_POLLEN` is MEASURED, indexed by the NECTAR already in the cell, and nothing
   * interpolates it — a see-saw is torque and packing, not weight. Pinned as literal values
   * because the row IS the rule: an interpolation that happened to pass through two of these
   * points would still be a mass model, which the owner ruled out (config.ts, 2026-09-12).
   */
  {
    const want = [8, 7, 6, 3, 1, 0];
    check(
      'hive: BB_TIP_POLLEN is the measured table [8,7,6,3,1,0], unchanged',
      BB_TIP_POLLEN.length === want.length && want.every((v, i) => BB_TIP_POLLEN[i] === v),
      `[${BB_TIP_POLLEN.join(',')}]`,
    );
    const bad: string[] = [];
    for (let nectar = 0; nectar < want.length; nectar++) {
      const need = want[nectar];
      if (need > 0 && hiveWillTip({ pollen: need - 1, nectar })) bad.push(`${nectar}n + ${need - 1}p tipped`);
      if (!hiveWillTip({ pollen: need, nectar })) bad.push(`${nectar}n + ${need}p did NOT tip`);
    }
    // past the end of the table the LAST row holds, which is 0 pollen: five nectar are enough
    // on their own, and so are six.
    if (!hiveWillTip({ pollen: 0, nectar: want.length })) bad.push('past the table, 0p did not tip');
    check(
      'hive: every row tips at its own threshold and not one element below it',
      bad.length === 0,
      bad.length
        ? bad.join(' · ')
        : `${want.length} rows, each at need-1 and need, plus the past-the-end row`,
    );
  }

  // -- `released` SURVIVES THE WIRE -----------------------------------------
  /**
   * A HIVE mid-swing is the one state where `released` carries information nothing else does,
   * and a snapshot reaches a client as JSON. Lose the field there and the arriving peer spills
   * a tray that has already emptied — the same elements a second time, which is a duplicate in
   * `world.balls` and the end of the conservation invariant asserted above.
   *
   * BOTH trips are checked, because they can fail separately: `JSON.parse(JSON.stringify(x))`
   * is what a replay and `localStorage` do, and `slimWorld`/`unslimWorld` is what the socket
   * does — the second one REBUILDS the world rather than copying it.
   */
  {
    const w = createBiobuzzWorld('match', 5, [setup(0, 'red', {}, 0)]);
    const bb = w.biobuzz!;
    bb.hives.red = { up: 'south', contents: [], tips: 2, tipping: 1.5, released: true };
    bb.hives.blue = { up: 'north', contents: [], tips: 0, tipping: 0, released: false };
    const plain = JSON.parse(JSON.stringify(w.biobuzz)) as typeof bb;
    const specOf = (id: number): RobotSpec => w.robots.find((r) => r.id === id)!.spec;
    const wire = unslimWorld(JSON.parse(JSON.stringify(slimWorld(w))), w.balls, specOf).biobuzz!;
    check(
      '`released` survives a JSON round-trip and the snapshot codec, on both hives',
      plain.hives.red.released === true &&
        plain.hives.blue.released === false &&
        wire.hives.red.released === true &&
        wire.hives.blue.released === false &&
        wire.hives.red.tipping === 1.5,
      `json red=${plain.hives.red.released}/blue=${plain.hives.blue.released} · ` +
        `wire red=${wire.hives.red.released}/blue=${wire.hives.blue.released} tipping=${wire.hives.red.tipping}`,
    );
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
   * and a colour lookup, so it is checked here directly, with no world.
   *
   * THE THRESHOLD IS A MEASURED TABLE, NOT A MASS (`BB_TIP_POLLEN`, config.ts): a cell tips at
   * `pollen >= BB_TIP_POLLEN[min(nectar, 5)]`, and nothing interpolates it. The staged row is
   * the one that decides how a match opens — 3 NECTAR are in the cell at setup (§10.3.1), so
   * the first TIP costs 3 POLLEN.
   *
   * THE SWING HAS THREE MOMENTS AND THESE CHECKS KEEP THEM APART, because the gameplay
   * consequence lives in the gap: the load starts the swing, the contents fall out as the bar
   * passes LEVEL (`BB_TIP_RELEASE_S`), and the 20 points land two seconds later when it
   * SETTLES. A check that only looked at the endpoints would pass with the spill welded to the
   * score, which is the behaviour the ruling exists to prevent.
   */
  {
    const dt = C.SIM_DT;
    const kindOf = (kinds: Map<number, BbElementKind>) => (id: number): BbElementKind => kinds.get(id) ?? 'pollen';
    const settled = (contents: number[]): HiveState => ({ up: 'south', contents, tips: 0, tipping: 0 });
    /** n nectar then p pollen, with ids that say which is which */
    const mix = (nectar: number, pollen: number): { ids: number[]; kinds: Map<number, BbElementKind> } => {
      const kinds = new Map<number, BbElementKind>();
      const ids: number[] = [];
      for (let i = 0; i < nectar; i++) {
        kinds.set(100 + i, 'red');
        ids.push(100 + i);
      }
      for (let i = 0; i < pollen; i++) {
        kinds.set(200 + i, 'pollen');
        ids.push(200 + i);
      }
      return { ids, kinds };
    };

    // 1. THE MEASURED TABLE IS THE RULE, every row of it. One short of the row does not tip;
    // the row itself does. This is the check that fails if anyone reintroduces a mass model.
    {
      const wrong: string[] = [];
      for (let n = 0; n < BB_TIP_POLLEN.length; n++) {
        const need = BB_TIP_POLLEN[n];
        const at = mix(n, need);
        if (!hiveWillTip(hiveLoad(at.ids, kindOf(at.kinds)))) wrong.push(`${n}n+${need}p should tip`);
        if (need > 0) {
          const under = mix(n, need - 1);
          if (hiveWillTip(hiveLoad(under.ids, kindOf(under.kinds)))) wrong.push(`${n}n+${need - 1}p should not tip`);
        }
      }
      check(
        'hive: the tip threshold is BB_TIP_POLLEN, row by row (no mass model)',
        wrong.length === 0,
        wrong.length ? wrong.join('; ') : `${BB_TIP_POLLEN.length} rows: [${BB_TIP_POLLEN.join(', ')}] pollen at 0..${BB_TIP_POLLEN.length - 1} nectar`,
      );
    }

    // 2. the STAGED cell: 3 nectar and nothing else, stable for as long as anyone waits.
    {
      const staged = mix(3, 0);
      let h = settled([...staged.ids]);
      let everTipped = false;
      let everSwung = false;
      for (let i = 0; i < 300; i++) {
        const r = hiveStep(h, dt, kindOf(staged.kinds));
        h = r.hive;
        if (r.tipped) everTipped = true;
        if (h.tipping !== 0) everSwung = true;
      }
      check(
        'hive: the staged cell (3 nectar, no pollen) is stable',
        !everTipped && !everSwung && h.contents.length === 3 && h.tips === 0,
        `3 nectar needs ${BB_TIP_POLLEN[3]} pollen; 5 s of steps: tipped=${everTipped} swung=${everSwung} contents=${h.contents.length}`,
      );
    }

    // 3. one pollen SHORT of the staged row: 3 nectar + 2 pollen, nothing starts.
    {
      const short = mix(3, BB_TIP_POLLEN[3] - 1);
      const r = hiveStep(settled([...short.ids]), dt, kindOf(short.kinds));
      check(
        'hive: one pollen below the staged row does not start a swing',
        r.hive.tipping === 0 && !r.tipped && r.spilled.length === 0,
        `3n+${BB_TIP_POLLEN[3] - 1}p vs a row of ${BB_TIP_POLLEN[3]}; tipping=${r.hive.tipping} tipped=${r.tipped}`,
      );
    }

    // 4. AT the staged row: 3 nectar + 3 pollen. The swing STARTS on this step, nothing has
    // tipped, and the contents are still IN the cell — they do not leave until level.
    const staged = mix(3, BB_TIP_POLLEN[3]);
    {
      const r = hiveStep(settled([...staged.ids]), dt, kindOf(staged.kinds));
      check(
        'hive: the staged row starts the swing, and nothing has left the cell yet',
        r.hive.tipping > 0 && !r.tipped && r.spilled.length === 0 && r.hive.contents.join() === staged.ids.join(),
        `3n+${BB_TIP_POLLEN[3]}p; tipping=${r.hive.tipping.toFixed(3)} (swing ${BB_TIP_SWING_S}) tipped=${r.tipped} contents=${r.hive.contents.length}`,
      );
    }

    // 5 + 6 + 7. RUN THE WHOLE SWING and record WHEN each thing happens. The release must come
    // first, at the half way point, and the points must come at the end.
    {
      let h = settled([...staged.ids]);
      let swingSteps = 0;
      let releaseStep = -1;
      let settleStep = -1;
      let spilled: number[] = [];
      let contentsAtRelease = -1;
      let spillEvents = 0;
      for (let i = 0; i < 1200 && settleStep < 0; i++) {
        const swinging = h.tipping > 0;
        const r = hiveStep(h, dt, kindOf(staged.kinds));
        if (swinging) swingSteps++;
        h = r.hive;
        if (r.spilled.length > 0) {
          spillEvents++;
          if (releaseStep < 0) {
            releaseStep = swingSteps;
            spilled = r.spilled;
            contentsAtRelease = h.contents.length;
          }
        }
        if (r.tipped) settleStep = swingSteps;
      }
      const releaseAt = releaseStep * dt;
      const settleAt = settleStep * dt;
      check(
        'hive: the contents RELEASE at level, before the TIP settles',
        releaseStep > 0 &&
          settleStep > releaseStep &&
          Math.abs(releaseAt - (BB_TIP_SWING_S - BB_TIP_RELEASE_S)) <= dt + 1e-9 &&
          contentsAtRelease === 0 &&
          spillEvents === 1,
        `release at ${releaseAt.toFixed(4)} s (expect ${(BB_TIP_SWING_S - BB_TIP_RELEASE_S).toFixed(4)}), settle at ${settleAt.toFixed(4)} s ` +
          `(swing ${BB_TIP_SWING_S}); cell empty at release=${contentsAtRelease === 0}; spill events=${spillEvents}`,
      );
      check(
        'hive: the swing settles after BB_TIP_SWING_S and flips the up cell',
        settleStep > 0 && Math.abs(settleAt - BB_TIP_SWING_S) <= dt + 1e-9 && h.up === 'north' && h.tips === 1 && h.contents.length === 0 && h.tipping === 0,
        `tipped after ${settleStep} swing steps = ${settleAt.toFixed(4)} s (swing ${BB_TIP_SWING_S}); up=${h.up} tips=${h.tips} contents=[${h.contents.join(',')}] tipping=${h.tipping}`,
      );
      check(
        'hive: spilled ids == the contents that tipped it',
        spilled.length === staged.ids.length && [...spilled].sort((a, b) => a - b).join() === [...staged.ids].sort((a, b) => a - b).join(),
        `spilled=[${spilled.join(',')}] expected=[${staged.ids.join(',')}]`,
      );
    }

    // 8. spill poses: `count` of them, under the cell that is emptying, at the hive bottom, each
    // carrying an OUTBOARD velocity. Both alliances, because the pivot x and the staged up-cell
    // both flip with the alliance — and the hive handed in is MID-SWING, which is when the
    // release actually happens.
    for (const a of ['red', 'blue'] as const) {
      let rngState = a === 'red' ? 7 : 8;
      const rng = (): number => {
        const r = nextRandom(rngState);
        rngState = r.state;
        return r.value;
      };
      // the staged cell, half way through its swing: still `up`, already emptying
      const emptying = BB_HIVE_UP_STAGED[a];
      const mid: HiveState = { up: emptying, contents: [], tips: 0, tipping: BB_TIP_RELEASE_S, released: true };
      const sign = emptying === 'north' ? 1 : -1;
      const pivot = hivePivot(a);
      const count = 6;
      const poses = spillPoses(mid, a, count, rng);
      const eps = 1e-6;
      const badPos = poses.filter(
        (p) =>
          Math.abs(p.pos.x - pivot.x) > BB_CELL_OPEN.w / 2 + eps ||
          Math.sign(p.pos.y) !== sign ||
          Math.abs(p.pos.y) < BB_HIVE_CELL_DY - eps ||
          Math.abs(p.pos.y) > BB_HIVE_CELL_DY + BB_CELL_OPEN.d + eps ||
          p.pos.z !== BB_HIVE_BOTTOM_Z,
      );
      // THE SPEED is what `BB_SPILL_SPEED` says and the FAN is the direction it left along — two
      // independent facts, which is exactly what the ±lateral model could not express (its fan
      // narrowed as the speed rose). `vel.y` alone is now only a COMPONENT and bounds nothing.
      const speedOf = (p: SpillPose): number => Math.hypot(p.vel.x, p.vel.y);
      const fanOf = (p: SpillPose): number => Math.abs(Math.atan2(p.vel.x, sign * p.vel.y)) * (180 / Math.PI);
      const badVel = poses.filter(
        (p) =>
          Math.sign(p.vel.y) !== sign ||
          speedOf(p) < BB_SPILL_SPEED[0] - eps ||
          speedOf(p) > BB_SPILL_SPEED[1] + eps ||
          fanOf(p) > BB_SPILL_FAN + eps ||
          p.vel.z !== 0,
      );
      check(
        `hive [${a}]: spill poses land under the emptying cell and leave it OUTBOARD`,
        poses.length === count && badPos.length === 0 && badVel.length === 0,
        `${poses.length}/${count} poses, ${badPos.length} misplaced, ${badVel.length} wrong velocity; emptying=${emptying} pivot x=${pivot.x}; ` +
          `pos x ${Math.min(...poses.map((p) => p.pos.x)).toFixed(2)}..${Math.max(...poses.map((p) => p.pos.x)).toFixed(2)} ` +
          `y ${Math.min(...poses.map((p) => p.pos.y)).toFixed(2)}..${Math.max(...poses.map((p) => p.pos.y)).toFixed(2)} ` +
          `z ${[...new Set(poses.map((p) => p.pos.z))].join('/')} · ` +
          `speed ${Math.min(...poses.map(speedOf)).toFixed(1)}..${Math.max(...poses.map(speedOf)).toFixed(1)} in/s ` +
          `(range ${BB_SPILL_SPEED[0]}..${BB_SPILL_SPEED[1]}) · ` +
          `fan ${Math.max(...poses.map(fanOf)).toFixed(1)}° of ±${BB_SPILL_FAN}°`,
      );
    }

    // 9. the ACCEPT test: through the OPEN OUTER END, descending, inside the footprint — and
    // nothing else. The wrong-side case is the one the ruling added: a shot crossing the same
    // rectangle OUTBOUND is arriving through the cell's closed back wall.
    {
      const a: Alliance = 'red';
      const h = settled([]); // up: south, so the way in is travelling +y, toward the pivot
      const up = hiveCellPos(a, 'south');
      const downPos = hiveCellPos(a, 'north');
      const zMid = (BB_HIVE_OPEN_Z[0] + BB_HIVE_OPEN_Z[1]) / 2;
      const inbound = { x: 0, y: 30, z: -10 };
      const outbound = { x: 0, y: -30, z: -10 };
      const cases: [string, boolean, boolean][] = [
        ['centre of the up cell, descending INBOARD', hiveAccepts(h, a, up, zMid, inbound), true],
        ['within the margin above the opening top', hiveAccepts(h, a, up, BB_HIVE_OPEN_Z[1] + BB_HIVE_ACCEPT_MARGIN / 2, inbound), true],
        ['WRONG SIDE: same point, travelling outboard', hiveAccepts(h, a, up, zMid, outbound), false],
        ['WRONG SIDE: no along-axis velocity at all', hiveAccepts(h, a, up, zMid, { x: 30, y: 0, z: -10 }), false],
        ['ASCENDING through the same point', hiveAccepts(h, a, up, zMid, { ...inbound, z: +10 }), false],
        ['off the footprint across the hive (dx = w/2 + 1)', hiveAccepts(h, a, { x: up.x + BB_CELL_OPEN.w / 2 + 1, y: up.y }, zMid, inbound), false],
        ['off the footprint along the hive (dy = d/2 + 1)', hiveAccepts(h, a, { x: up.x, y: up.y + BB_CELL_OPEN.d / 2 + 1 }, zMid, inbound), false],
        ['the DOWN cell', hiveAccepts(h, a, downPos, zMid, inbound), false],
        ['above the margin', hiveAccepts(h, a, up, BB_HIVE_OPEN_Z[1] + BB_HIVE_ACCEPT_MARGIN + 1, inbound), false],
        ['below the opening bottom', hiveAccepts(h, a, up, BB_HIVE_OPEN_Z[0] - 1, inbound), false],
        ['mid-swing', hiveAccepts({ ...h, tipping: BB_TIP_SWING_S / 2 }, a, up, zMid, inbound), false],
      ];
      const wrong = cases.filter(([, got, want]) => got !== want);
      check(
        'hive: accepts only a descending INBOARD element inside the up-cell opening',
        wrong.length === 0,
        wrong.length
          ? `wrong: ${wrong.map(([n, got]) => `${n} → ${got}`).join('; ')}`
          : `${cases.length} cases as expected; up cell at (${up.x}, ${up.y}) takes vy ${hiveApproachSign('south') > 0 ? '> 0' : '< 0'}, z ${BB_HIVE_OPEN_Z[0]}..${BB_HIVE_OPEN_Z[1]}+${BB_HIVE_ACCEPT_MARGIN}`,
      );
      // the north-up hive is the mirror, and getting this backwards is silent
      check(
        'hive: the approach side follows the up cell',
        hiveApproachSign('south') === 1 &&
          hiveApproachSign('north') === -1 &&
          hiveAccepts({ ...h, up: 'north' }, a, downPos, zMid, outbound) &&
          !hiveAccepts({ ...h, up: 'north' }, a, downPos, zMid, inbound),
        `south takes vy>0, north takes vy<0`,
      );
    }

    // 10. purity, on the two steps that CHANGE something: the release (which empties the
    // contents on the output) and the settle (which flips `up`).
    {
      const cases: [string, HiveState][] = [
        ['release', { up: 'south', contents: [...staged.ids], tips: 0, tipping: BB_TIP_RELEASE_S + dt / 2, released: false }],
        ['settle', { up: 'south', contents: [], tips: 0, tipping: dt / 2, released: true }],
      ];
      const bad = cases.filter(([, input]) => {
        const before = JSON.stringify(input);
        const r = hiveStep(input, dt, kindOf(staged.kinds));
        return JSON.stringify(input) !== before || r.hive === input || r.hive.contents === input.contents;
      });
      check(
        'hive: hiveStep does not mutate its input',
        bad.length === 0,
        bad.length ? `mutated on: ${bad.map(([n]) => n).join(', ')}` : 'release and settle both left the input untouched and returned fresh arrays',
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
   * The geometry that decides the interesting cases: a bottom POLLEN passes the middle ring and
   * rests on the LOWER ring, so its top is 3.23, BELOW the volume floor at 3.98, and it does NOT
   * score. A NECTAR cannot pass the ring and SEATS on it (`BB_FLOWER_MID_Z`, field-plan §2.2),
   * so it spans 3.98-7.58 and ALWAYS scores. That is the manual's "on the tiles under the lower
   * ring does not count", and the reason A has 3 in volume of 4 and C has 4 of 4.
   *
   * ⚠️ EVERY OUTCOME BELOW IS UNCHANGED BY THE SORTER RULING and four of the z ROWS moved. That
   * is the ruling working: a bottom nectar used to score because 0.43 + 3.6 = 4.03 cleared 3.98
   * BY 0.05 IN, an accident of two APPROX numbers, and case H's nectar cleared it by the same
   * 0.05. Seated on the ring they clear it by construction, so these outcomes survive the ring's
   * height being re-measured and the old ones would not have.
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
      // nectar SEATED ON THE RING at 5.78 (spans 3.98-7.58) / 8.98 / 11.78 / 14.58 — all 4 in
      { id: 'C', what: 'red nectar at the bottom, 3 pollen above', stack: [R, P, P, P], owner: 'red', ownerPts: 4 * O, bonus: 'red', inVolume: 4 },
      // seated nectar 5.78 / 8.98 / 11.78 / nectar 16.38 — owner is the TOP nectar, bonus the BOTTOM one
      { id: 'D', what: 'red nectar bottom, blue nectar top, pollen between', stack: [R, P, P, B], owner: 'blue', ownerPts: 4 * O, bonus: 'red', inVolume: 4 },
      // seated nectar 5.78 / 9.38 / 12.98 — three nectars; only the FIRST one meets the ring
      { id: 'E', what: 'blue, red, blue nectars', stack: [B, R, B], owner: 'blue', ownerPts: 3 * O, bonus: 'blue', inVolume: 3 },
      { id: 'F', what: 'empty', stack: [], owner: null, ownerPts: 0, bonus: null, inVolume: 0 },
      // 7 pollen (top 20.03) + nectar centred 21.83: ABOVE the top ring but its underside is
      // below it, so it is partially inside and counts (the backstop case). 6 pollen + nectar in.
      { id: 'G', what: '7 pollen + red nectar held on the backstop', stack: [P, P, P, P, P, P, P, R], owner: 'red', ownerPts: 7 * O, bonus: 'red', inVolume: 7 },
      // pollen 1.83 (out, top 3.23) / nectar SEATED ON THE RING at 5.78, not stacked on the
      // pollen — the pollen passed the ring and sits in the space underneath it. The owner's
      // points count only the in-volume elements, so the bottom pollen earns nothing
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

    // 10. CAPACITY by height, AND THE SORTER COSTS THE COLUMN A NECTAR. Floor 0.43, top ring
    // 21.5. POLLEN pass the middle ring and stack from the floor: the 8th's top lands at 22.83,
    // so 8. NECTAR seat ON the ring at 3.98 — 3.55 in of clearance the old arithmetic spent on a
    // sixth nectar the column does not have room for, since 3.98 + 5*3.6 = 21.98 is already over
    // the ring. So FIVE. Both are filled one at a time through `flowerFits`, which since the
    // ruling is the only stacking rule there is.
    {
      const capP = flowerCapacity('pollen');
      const capN = flowerCapacity('red');
      const fill = (kind: BbElementKind): number[] => {
        const stack: number[] = [];
        while (flowerFits(stack, () => kind, bbElementRadius(kind)) && stack.length < 50) {
          stack.push(400 + stack.length);
        }
        return stack;
      };
      const byP = fill(P);
      const byN = fill(R);
      const zN = flowerStackZ(byN, () => R);
      check(
        'flower: capacity by height — 8 POLLEN, and only 5 NECTAR because the ring seats the first',
        capP === 8 && capN === 5 && byP.length === capP && byN.length === capN,
        `pollen ${capP} (expect 8, filled ${byP.length}), nectar ${capN} (expect 5, filled ${byN.length}); ` +
          `nectar zs [${zN.map((z) => z.toFixed(2)).join(', ')}] under TOP_Z ${BB_FLOWER_TOP_Z}`,
      );
    }

    // 10b. THE SORTER ITSELF (field-plan §2.2, owner ruling 2026-09-12). Three cases, each an
    // OUTCOME the seat rule exists to produce rather than a restatement of its arithmetic.
    {
      // (a) a bare NECTAR spans the ring to its own diameter above it, and SCORES.
      const bare = flowerStackZ([1], () => R);
      const bareScore = flowerScore([1], () => R);
      const lo = bare[0] - BB_NECTAR_R;
      const hi = bare[0] + BB_NECTAR_R;
      check(
        'flower sorter: a bare NECTAR seats ON the middle ring — 3.98 to 7.58, scoring by geometry',
        Math.abs(lo - BB_FLOWER_MID_Z) < 1e-9 &&
          Math.abs(hi - (BB_FLOWER_MID_Z + 2 * BB_NECTAR_R)) < 1e-9 &&
          bareScore.inVolume === 1 &&
          bareScore.owner === 'red',
        `spans ${lo.toFixed(2)}..${hi.toFixed(2)} (ring ${BB_FLOWER_MID_Z}) · inVolume ${bareScore.inVolume} owner ${bareScore.owner}` +
          ` · it used to rest on the floor at 0.43..4.03 and clear the volume by 0.05 in`,
      );

      // (b) a POLLEN UNDER a seated NECTAR is in the space the ring leaves. Retrieval pops the
      // pollen (G418.B) and the NECTAR DOES NOT DROP — it was never resting on it.
      const kinds = new Map<number, BbElementKind>([[10, P], [11, R]]);
      const kindOf = (id: number): BbElementKind => kinds.get(id) ?? 'pollen';
      const before = flowerStackZ([10, 11], kindOf);
      const got = flowerRetrieve([10, 11], kindOf);
      const after = flowerStackZ(got.stack, kindOf);
      check(
        'flower sorter: retrieving the POLLEN from under a ring-seated NECTAR does not lower the NECTAR',
        got.id === 10 && got.stack.join() === '11' && Math.abs(after[0] - before[1]) < 1e-9,
        `popped ${got.id}, stack [${got.stack}] · nectar z ${before[1].toFixed(2)} → ${after[0].toFixed(2)} · ` +
          `the pollen was at ${before[0].toFixed(2)}, under the ring`,
      );

      // (c) the STAGED flower (§10.3.1, four POLLEN) still reads 3 in volume and 0 points — the
      // outcome `spawn.ts` now stages through this same function.
      const staged = [20, 21, 22, 23];
      const stagedZ = flowerStackZ(staged, () => P);
      const stagedScore = flowerScore(staged, () => P);
      check(
        'flower sorter: the STAGED 4 POLLEN still read 3 in volume and 0 points',
        stagedScore.inVolume === 3 && stagedScore.ownerPts === 0 && stagedScore.owner === null && stagedScore.bonusPts === 0,
        `inVolume ${stagedScore.inVolume} pts ${stagedScore.ownerPts} owner ${stagedScore.owner} bonus ${stagedScore.bonusPts} · ` +
          `zs [${stagedZ.map((z) => z.toFixed(2)).join(', ')}] · the bottom one tops out at ` +
          `${(stagedZ[0] + BB_POLLEN_R).toFixed(2)} < ${BB_FLOWER_MID_Z}`,
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
  /**
   * A MATCH NOBODY DROVE SCORES THE STAGED LAYOUT, AND BOTH ALLIANCES SCORE THE SAME.
   *
   * This check asserted 0-0 while the shell was unscored; `score.ts` landed and the setup
   * itself is now worth points, because Table 10-2 counts what is IN the up-CELL and what is
   * in the GARDEN and the spawn stages both. So the assertion moved from "nothing scores" to
   * the two things that are still load-bearing here:
   *
   *  • EQUAL. The layout is point-symmetric, so four idle robots must leave the two alliances
   *    on the same number. An x-MIRRORED garden or loading zone is internally consistent and
   *    wrong (reference §2.1), and this is the cheapest place that difference shows up.
   *  • THE STAGED VALUE, derived from the tariff rather than typed: 3 elements in the up-CELL
   *    and 4 POLLEN in the GARDEN. A hard-coded 10 would pin the staging from the server lane,
   *    which is not this file's business; the arithmetic is.
   *
   * The score being live is ALSO what makes the game persist — `simModuleFor('biobuzz').scored`
   * is checked below and is what `persistMatch` reads. It flipped to true 2026-09-12.
   */
  const staged = 3 * BB_PTS.cell + 4 * BB_PTS.garden;
  check(
    'room: a BIOBUZZ match nobody drove scores the staged layout, equally for both alliances',
    res?.result.score.blue === staged && res?.result.score.red === staged,
    `blue=${res?.result.score.blue} red=${res?.result.score.red} staged=${staged}`,
  );
  // The outcome has to be GAME-TAGGED: it is what `persistMatch` keys the write on, and an
  // absent `game` defaults to DECODE — which would file a BIOBUZZ run onto the DECODE boards.
  check('room: the MatchOutcome carries game:"biobuzz"', outcomeGame === 'biobuzz', `game=${outcomeGame}`);
  check(
    'room: the SERVER-SAFE registry declares BIOBUZZ scored, so persistMatch writes it (per game)',
    simModuleFor('biobuzz').scored === true,
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
