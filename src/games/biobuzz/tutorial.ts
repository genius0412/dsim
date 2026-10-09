import type { Alliance, Artifact, RobotSpec, RobotState, Vec2, World } from '../../types';
import type { TutorialSpec, TutorialStep } from '../../tutorial/types';
import { control, driveHint, say } from '../../tutorial/hints';
import { robotIntersectsRect } from '../../sim/physics';
import { datan2, hyp } from '../../math';
import {
  BB_FLOWERS,
  BB_GARDEN,
  BB_HIVE_CELL_DY,
  BB_HIVE_OPEN_Z,
  BB_HIVE_X,
  BB_NECTAR_R,
  bbMirror,
  bbSideRollerY,
} from './config';
import { bbFootprint, bbHopperCap, bbMouths, bbPlacePointLocal, mouthAxes } from './robot';
import { bbSideRollerOffsets } from './importMech';
import { bbCarriesNectar, bbIntakeKindOf, bbLauncherOf, bbLiftOf } from './mechs';
import { bbIndexElements } from './spawn';
import { capturePollen } from './elements';
import { bbParkedNow } from './score';
import { bbKindOf } from './play';

/**
 * THE BIOBUZZ TUTORIAL — six steps of scripted solo practice, hung on
 * `GameModule.tutorial` (`src/games/biobuzz/index.ts`).
 *
 * Read `src/tutorial/types.ts` before changing anything here. The rule that shapes every
 * `stage` below is that a step's situation goes into a world AT CONSTRUCTION, at tick 0,
 * before the robot may move — never into a running world, because solo practice is recorded
 * and a replay rebuilds from `{seed, setups, commands}` alone. Moving to the next step
 * rebuilds the world; `GameController` owns that.
 *
 * ── WHY IT RUNS AS FREE DRIVE ─────────────────────────────────────────────────
 * `GameController` puts the tutorial in `mode: 'free'`, and three separate things follow from
 * that, all of them wanted:
 *   • the robot is drivable from tick 0 — no four-second countdown and no thirty-second AUTO
 *     to sit through six times;
 *   • `updateBiobuzzPenalties` bills NOTHING outside the played periods, so a step that asks
 *     for a NECTAR in a FLOWER cannot hand the player a G410 MAJOR for doing as they were
 *     told (entry is locked until 1:00 of TELEOP remains);
 *   • free drive is never recorded (`startMatch` returns on a phase that is not `pre`), which
 *     is the honest answer to "could a replay reproduce a staged world" — it could not, so
 *     none is kept.
 *
 * ── THE POSES ARE CANONICAL, IN THE BLUE FRAME ────────────────────────────────
 * This field is POINT-SYMMETRIC (180° about the origin), not mirrored: red's LOADING ZONE is
 * at y > 0 and its GARDEN is the audience-left corner, and blue's are the diagonal opposites
 * (`docs/biobuzz-reference.md` §2.1). So every pose below is written once, for BLUE, and red
 * gets `bbMirror` — the same discipline `BB_START_POSES` and `gardenLine` follow. Writing a
 * second set of numbers for red is how one alliance's tutorial silently ends up staged on the
 * other alliance's half.
 */

/** the z a staged CELL element rests at — the middle of the opening, same as `cellNectar`. */
const CELL_Z = (BB_HIVE_OPEN_Z[0] + BB_HIVE_OPEN_Z[1]) / 2;

/**
 * Point the robot at a canonical (BLUE-frame) pose, mirrored onto red.
 *
 * Velocity is zeroed: this runs at tick 0 on a world nothing has stepped, and a staged robot
 * that is already moving is a robot the player did not put in motion. `startWalls` is zeroed
 * with it — LEAVE is measured against the walls a robot STARTED against, free drive never runs
 * a `pre` tick to re-read them, and a staged pose clear of the perimeter has no start wall.
 */
function place(world: World, robotId: number, x: number, y: number, heading: number): void {
  const r = world.robots.find((q) => q.id === robotId);
  if (!r) return;
  const p = r.alliance === 'blue' ? { x, y, heading } : bbMirror({ x, y, heading });
  r.pos = { x: p.x, y: p.y };
  r.heading = p.heading ?? heading;
  r.vel = { x: 0, y: 0 };
  r.angVel = 0;
  if (world.biobuzz) world.biobuzz.startWalls[r.id] = 0;
}

/** the robot this tutorial is about, or null in a world that has lost it. */
function me(world: World, robotId: number): RobotState | null {
  return world.robots.find((r) => r.id === robotId) ?? null;
}

/**
 * DROP held elements until the hopper has `want` free slots, onto the tiles in the alliance's
 * own GARDEN — a legal, tidy place for them that also keeps `world.balls` conserved.
 *
 * Deleting them would be simpler and wrong: `world.balls` is the ONE conservation authority
 * this game is checked against (`scripts/smoke-biobuzz/field.ts`), and a tutorial that made
 * four POLLEN vanish would be the only thing in the repo that does.
 */
function freeHopper(world: World, r: RobotState, want: number): void {
  const g = BB_GARDEN[r.alliance];
  let k = 0;
  while (bbHopperCap(r.spec) - r.hopper.length < want) {
    const ball = [...world.balls]
      .reverse()
      .find((b) => b.state.kind === 'held' && b.state.robot === r.id);
    if (!ball) break;
    ball.state = { kind: 'ground' };
    ball.pos = { x: g.x0 + 4 + k * 4, y: (g.y0 + g.y1) / 2 };
    ball.z = 0;
    ball.vel = { x: 0, y: 0 };
    ball.vz = 0;
    // the hopper MIRRORS the held set: dropping a ball without dropping its colour leaves a
    // pip the driver can never fire (`stageBiobuzz`'s own note about the same disagreement).
    const at = r.hopper.lastIndexOf(ball.color);
    if (at >= 0) r.hopper.splice(at, 1);
    else r.hopper.pop();
    k++;
  }
}

/**
 * Put one of the alliance's off-field NECTAR into the robot's hopper, dropping a POLLEN to make
 * room. Returns it, or null when the alliance has none left in stock.
 *
 * THROUGH `capturePollen`, never by writing `state` here, and it is worth saying why: a `held`
 * ball carries `lx/ly/side` as well as `robot/slot`, and a hand-written state that omits them
 * puts `undefined` through `rot()` on the first tick `positionHeldBalls` runs. That is a NaN
 * position, which reaches Rapier as a collider translation and throws out of the solve — measured,
 * while writing this file. The real capture path is also the one that enforces the rules a preload
 * has to obey (the hopper cap, G408, and whether this launcher carries NECTAR at all), which is
 * exactly what `stageBiobuzz` uses it for.
 */
function giveNectar(world: World, r: RobotState): Artifact | null {
  const ball = world.balls.find((b) => b.state.kind === 'stock' && b.state.alliance === r.alliance);
  if (!ball) return null;
  freeHopper(world, r, 1);
  ball.state = { kind: 'ground' };
  ball.pos = { x: r.pos.x, y: r.pos.y };
  ball.z = 0;
  ball.vel = { x: 0, y: 0 };
  ball.vz = 0;
  if (!capturePollen(world, r, ball)) {
    // refused (no NECTAR capacity, or a full hopper): put it back off-field rather than
    // leaving a loose NECTAR under the robot that the solve will shove out through the frame.
    ball.state = { kind: 'stock', alliance: r.alliance };
    return null;
  }
  return ball;
}

/**
 * CAN THIS BUILD PLACE A NECTAR IN A FLOWER AT ALL? Two pieces of hardware, and both are
 * required:
 *  · a BOX TUBE — `placeInFlower` refuses at its first line without one; and
 *  · a launcher that CARRIES NECTAR (`bbCarriesNectar`: a single turret feeds POLLEN only), or
 *    the intake refuses the NECTAR the step would have to hand it.
 *
 * It is ONE predicate used by both FLOWER steps, negated for the second, so the two are exactly
 * complementary: every build is offered exactly one of them, and no build is offered neither.
 */
function canPlaceNectar(spec: RobotSpec): boolean {
  return !!bbLiftOf(spec) && bbCarriesNectar(bbLauncherOf(spec, 0));
}

/** move `n` GROUND POLLEN into the alliance's up CELL, on top of whatever is staged there. */
function loadCell(world: World, a: Alliance, n: number): void {
  const bb = world.biobuzz;
  if (!bb) return;
  const side = bb.hives[a].up;
  const x0 = a === 'red' ? -BB_HIVE_X : BB_HIVE_X;
  const y = side === 'north' ? BB_HIVE_CELL_DY : -BB_HIVE_CELL_DY;
  let slot = bb.hives[a].contents.length;
  let left = n;
  for (const b of world.balls) {
    if (left <= 0) break;
    if (b.state.kind !== 'ground' || bbKindOf(b) !== 'pollen') continue;
    b.state = { kind: 'element', el: `hive:${a}`, slot };
    b.pos = { x: x0 + (slot - 2) * BB_NECTAR_R * 2, y };
    b.z = CELL_Z;
    b.vel = { x: 0, y: 0 };
    b.vz = 0;
    slot++;
    left--;
  }
  bbIndexElements(world);
}

/**
 * How many POLLEN are in the alliance's up CELL.
 *
 * ⚠️ POLLEN, not `contents.length`, and that is the difference between a step and a
 * formality: the field STAGES three NECTAR in every up CELL (§10.3.1), so
 * `contents.length > 0` is already true on the world the shoot step is staged on and the
 * card would flash past before the player touched a control. It was written that way first,
 * and the TUTORIAL lane's non-vacuity check is what said so.
 */
function cellPollen(world: World, a: Alliance): number {
  const bb = world.biobuzz;
  if (!bb) return 0;
  const kind = new Map<number, string>();
  for (const b of world.balls) kind.set(b.id, bbKindOf(b));
  return bb.hives[a].contents.filter((id) => kind.get(id) === 'pollen').length;
}

/** does any FLOWER hold a NECTAR of this alliance? The staged FLOWERS hold POLLEN only, so a
 *  nectar in a stack can only be one the player put there — which is what makes this
 *  predicate self-contained rather than a comparison against a remembered baseline. */
function nectarPlaced(world: World, a: Alliance): boolean {
  const bb = world.biobuzz;
  if (!bb) return false;
  const kind = new Map<number, string>();
  for (const b of world.balls) kind.set(b.id, bbKindOf(b));
  return bb.flowers.some((f) => f.stack.some((id) => kind.get(id) === a));
}

/**
 * HOW MANY ELEMENTS THE FOUR FLOWERS HOLD WHEN THE FIELD IS STAGED — 4 POLLEN each (§10.3.1).
 *
 * The retrieve step's predicate is a drop BELOW this, which is the only self-contained way to
 * ask "did this robot pull one out": the count cannot rise during that step (nothing there can
 * place), so a lower number is an element in the hopper that used to be in a FLOWER.
 */
const BB_FLOWER_POLLEN = 16;

/** how many elements are in the four FLOWERS right now. */
function flowerCount(world: World): number {
  const bb = world.biobuzz;
  if (!bb) return 0;
  return bb.flowers.reduce((n, f) => n + f.stack.length, 0);
}

/**
 * THE TUTORIAL'S FLOWER — F3, on the right wall, the one nearest BLUE.
 *
 * Canonical like every pose here: `bbMirror` maps it onto F1 on the left wall, which is the one
 * nearest RED. The wall's OUTWARD direction in the blue frame is therefore +x, and that is the
 * axis both FLOWER steps back the robot off along.
 */
const FLOWER = BB_FLOWERS[2];

/**
 * Stage the robot short of the FLOWER with the named MECHANISM POINTED AT IT — a few inches
 * short, so the last of the approach is the player's.
 *
 * ⚠️ THE POSE IS DERIVED FROM THE BUILD, NOT TYPED. Both FLOWER steps act through a mechanism
 * whose position is a builder choice: a Box Tube may be bolted to any of the eight perimeter
 * cells, and a sweeper to any edge. A staged pose that assumed the front of the chassis put the
 * mechanism on the wrong side of the robot for every other mount — measured, with a dumper build
 * whose Box Tube the coercer had relocated to a flank: the tube pointed at open floor 10 in from
 * the ring and the step was impossible.
 *
 * So the caller hands in WHERE THE MECHANISM IS in the robot frame, and this turns the chassis
 * until that offset points along the wall's outward axis and backs it off by its own length plus
 * `standoff`. It works out because `bbPlacePointLocal` and `bbMouths` both reach to the
 * COLLISION footprint: a robot pressed against the FLOWER's foot has its mechanism exactly on the
 * ring, whichever edge that mechanism is on.
 */
function stageAtFlower(world: World, robotId: number, local: Vec2, standoff: number): void {
  const reach = hyp(local.x, local.y);
  // where the mechanism points in the robot's own frame; the chassis turns by the negative of it
  // so that direction becomes the blue frame's +x (the right wall's outward normal).
  const ang = datan2(local.y, local.x);
  place(world, robotId, FLOWER.x - reach - standoff, FLOWER.y, -ang);
}

/** where a build's FIRST intake mouth reaches, in the robot frame — the `local` `stageAtFlower`
 *  wants for the retrieval step. An edge's outward direction times that edge's own footprint
 *  extent, so a side-mounted sweeper is staged on the side.
 *
 * ⚠️ **SIDE ROLLERS ARE `edgeGrip`, NOT THE CENTRELINE** (owner, 2026-09-20: "situated on the
 * edges of the robot, not near the center"). This step always ends up with a `siderollers` build
 * (its own, or lent — see `stage`, this function's one caller), so the staged point is offset by
 * `bbSideRollerY` along the mouth's LATERAL axis so the lesson's pose actually has a wheel on the
 * opening rather than resting on a line neither wheel reaches. */
function mouthPoint(spec: RobotSpec): Vec2 {
  const f = bbFootprint(spec);
  const m = bbMouths(spec)[0];
  if (spec.imported && m) {
    // an IMPORTED robot: on ITS mouth's roller line and off its own centre (`mouthAxes`' `vc`)
    const ax = mouthAxes(m, 0, 0);
    const v = ax.vc + (bbIntakeKindOf(spec) === 'siderollers' ? bbSideRollerOffsets(spec, ax)[0] : 0);
    return { x: ax.n.x * ax.uOut + ax.p.x * v, y: ax.n.y * ax.uOut + ax.p.y * v };
  }
  const edge = m?.edge ?? 'front';
  const lateral = m && bbIntakeKindOf(spec) === 'siderollers' ? bbSideRollerY(mouthAxes(m, spec.length / 2, spec.width / 2).half) : 0;
  if (edge === 'front') return { x: f.front, y: lateral };
  if (edge === 'back') return { x: -f.rear, y: lateral };
  return { x: lateral, y: edge === 'left' ? f.half : -f.half };
}

const steps: TutorialStep[] = [
  // ── 1. DRIVE ────────────────────────────────────────────────────────────────
  // Staged in the middle of the alliance's own half, facing its GARDEN, which is ~55 in away
  // across open tiles — far enough to be a drive, short enough that nobody is bored, and clear
  // of the HIVE frame's base bars (x = ±24 … ±25, y = ±19.4) so the first thing a new driver
  // meets is not a collision.
  {
    id: 'drive',
    title: 'Drive to your garden',
    hint: (c) => say`${driveHint(c)}. Your garden is the taped strip in the far corner.`,
    stage: (w, id) => place(w, id, 40, -10, Math.PI / 2),
    done: (w, id) => {
      const r = me(w, id);
      return !!r && robotIntersectsRect(r, BB_GARDEN[r.alliance]);
    },
  },

  // ── 2. CAPTURE ──────────────────────────────────────────────────────────────
  // Staged square onto the GARDEN's line of four POLLEN with one hopper slot open. The four
  // preloads are what fills it, so one is dropped — into the GARDEN, where it becomes a fifth
  // thing to drive at rather than a hole in the field.
  {
    id: 'capture',
    title: 'Pick up a pollen',
    hint: (c) =>
      say`Drive onto a pollen with ${control(c, 'intake', 'intake')} held.`,
    stage: (w, id) => {
      place(w, id, 58, 50, Math.PI / 2);
      const r = me(w, id);
      if (r) freeHopper(w, r, 1);
    },
    done: (w, id) => {
      const r = me(w, id);
      return !!r && r.hopper.length >= bbHopperCap(r.spec);
    },
  },

  // ── 3. SHOOT ────────────────────────────────────────────────────────────────
  // Staged on the up CELL's OUTBOARD side (blue's up cell is `north`, so north of it), facing
  // away, at ~40 in. Facing away on purpose: with Aim Assist always on (`docs/area/ui.md`) a
  // robot parked pointing at the cell would be a step the player watched happen, and the thing
  // being taught is that you have to get to the open side of the CELL first.
  //
  // The CELL is left exactly as the field stages it — three NECTAR — and nothing about that
  // needs undoing: three NECTAR tips at three POLLEN, and this step is done on the first one.
  {
    id: 'shoot',
    title: 'Shoot into your hive',
    hint: (c) =>
      say`Line up on the open side of the up cell and hold ${control(c, 'fire', 'fire')}. The turret aims for you.`,
    stage: (w, id) => place(w, id, BB_HIVE_X + 6, BB_HIVE_CELL_DY + 38, Math.PI / 2),
    done: (w, id) => {
      const r = me(w, id);
      return !!r && cellPollen(w, r.alliance) > 0;
    },
    nudgeS: 60,
  },

  // ── 4. TIP ──────────────────────────────────────────────────────────────────
  // The measured tip table (`docs/biobuzz-reference.md` §4.1) says a CELL holding 3 NECTAR
  // tips at 3 POLLEN. The field stages the 3 NECTAR; this puts 2 POLLEN in beside them, so the
  // ONE shot the player takes is the one that tips it — which is the whole lesson, and it is
  // not a lesson you can teach by asking somebody to land eight.
  {
    id: 'tip',
    title: 'Tip the hive',
    hint: (c) =>
      say`One more pollen tips it. Hold ${control(c, 'fire', 'fire')}.`,
    stage: (w, id) => {
      const r = me(w, id);
      if (r) loadCell(w, r.alliance, 2);
      place(w, id, BB_HIVE_X + 4, BB_HIVE_CELL_DY + 26, Math.PI / 2);
    },
    done: (w, id) => {
      const r = me(w, id);
      return !!r && (w.biobuzz?.hives[r.alliance].tips ?? 0) > 0;
    },
    nudgeS: 60,
  },

  // ── 5a. PLACE A NECTAR (Box Tube builds) ────────────────────────────────────
  // `placeInFlower` refuses at its first line without a Box Tube, so this step is only OFFERED
  // to a build that has one — see `TutorialStep.applies`. The variant below teaches the same
  // FLOWER to everybody else.
  {
    id: 'nectar',
    title: 'Place a nectar in a flower',
    applies: canPlaceNectar,
    hint: (c) =>
      say`Drive up to the flower and press ${control(c, 'bbPlaceNectar', 'bbPlaceNectar')}.`,
    stage: (w, id) => {
      const r = me(w, id);
      if (!r) return;
      stageAtFlower(w, id, bbPlacePointLocal(r.spec) ?? { x: bbFootprint(r.spec).front, y: 0 }, 8);
      giveNectar(w, r);
      bbIndexElements(w);
    },
    done: (w, id) => {
      const r = me(w, id);
      return !!r && nectarPlaced(w, r.alliance);
    },
  },

  // ── 5b. TAKE A POLLEN OUT OF A FLOWER (every other build) ───────────────────
  // G418.B: a ROBOT may only remove POLLEN from the BOTTOM of a FLOWER, which is what the
  // retrieval opening at the foot is. It needs nothing but an intake on the edge facing the
  // FLOWER, so it is the step a build with no Box Tube gets instead.
  {
    id: 'retrieve',
    title: 'Take a pollen from a flower',
    applies: (spec: RobotSpec) => !canPlaceNectar(spec),
    // the lesson lends a sweeper-only build SIDE ROLLERS (see `stage`), and says so: the robot on
    // screen grows a pair for this step, and the driver should know why their own build cannot.
    // ≤ 25 WORDS, like every hint (design review 12-05): this one was 55, and on a phone the
    // bottom-anchored card grew up across the joysticks. The smoke lane holds the cap.
    hint: (c) =>
      say`This lesson lends you side rollers. Line one end of the intake up on the flower’s opening and drive in with ${control(c, 'intake', 'intake')} held.`,
    stage: (w, id) => {
      const r = me(w, id);
      if (!r) return;
      // ⚠️ A SWEEPER CANNOT REACH THE OPENING (owner, 2026-09-20: "intaking from the flower
      // should now only be done if it is physically possible" — `bbFlowerReachOf`). This step
      // teaches the MECHANIC, which a `sweeper`-only build (the default new-player loadout)
      // no longer has the hardware for, so it is LENT a `siderollers` one for the lesson —
      // the same shape of adjustment `freeHopper` below makes to hopper room, and just as
      // scoped: it mutates this practice world's live `RobotState.spec`, never the player's
      // own saved build.
      if (bbIntakeKindOf(r.spec) === 'sweeper') {
        r.spec = { ...r.spec, bbMech: { ...r.spec.bbMech!, intake: { kind: 'siderollers' } } };
      }
      stageAtFlower(w, id, mouthPoint(r.spec), 8);
      freeHopper(w, r, 1);
    },
    done: (w) => flowerCount(w) < BB_FLOWER_POLLEN,
  },

  // ── 6. PARK ─────────────────────────────────────────────────────────────────
  // PARK is "at least partially in the LOADING ZONE", its OWN one (Table 10-2, Fig 10-7), and
  // it is worth 5 at the end of AUTO and 5 again at the end of the MATCH. Staged well clear of
  // the zone so the step is a drive rather than a fact.
  {
    id: 'park',
    title: 'Park in your loading zone',
    hint: (c) =>
      // the PARK key has no on-screen button, so the clause that names it is dropped on touch
      // rather than naming a key a phone does not have.
      say`${driveHint(c)}. Get any part of the robot over the tape.${c.touch ? '' : say` ${control(c, 'park', 'park')} caps your speed near the tape.`}`,
    stage: (w, id) => place(w, id, 0, -40, Math.PI),
    done: (w, id) => {
      const r = me(w, id);
      return !!r && bbParkedNow(r);
    },
  },
];

export const BIOBUZZ_TUTORIAL: TutorialSpec = {
  game: 'biobuzz',
  steps,
};
