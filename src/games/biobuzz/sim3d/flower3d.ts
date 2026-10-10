import type { Artifact, RobotCommand, RobotState, World } from '../../../types';
import type { BiobuzzState } from '../state';
import type { BbElementKind } from '../flower';
import type { Vec2 } from '../../../types';
import { rot } from '../../../math';
import { bbBites, bbElementRadius, bbFlowerDropSlack, bbFlowerScatter } from '../flower';
import {
  BB_FLOWERS,
  BB_FLOWER_RETRIEVE_S,
  BB_RAMP_LIFT_Z,
  BB_RAMP_ROLLER_V,
  BB_SIDE_ROLLER_RELEASE_CLEAR,
  FLOWER_RING_Z,
  bbFlowerReachOf,
  bbHopperCap,
} from '../config';
import { capturePollen, takeHeld } from '../elements';
import { bbIntakeKindOf, bbLiftOf } from '../mechs';
import { bbFlowerAtIntake, bbFlowerAtIntakeMouth } from '../play';
import { bbFlowerInReach, bbRampSettled } from '../robot';
import { importSideRollersPre6 } from '../importMech';
import type { BbMouthAxes } from '../robot';
import { flowerAtRetrieval } from './flowerTube';

/**
 * BIOBUZZ 3D PHYSICS — FLOWERS (Day 2, `docs/biobuzz/plan-3d.md` §3.7).
 *
 * THE STATICS are not here: the supports are CAD hulls built with every other static
 * (`bodies.ts`) and the three RING PLATES are trimeshes built by `flowerTube.ts`. This file
 * owns the GAMEPLAY half — placement and retrieval — and the whole of it is now different from
 * Day 1 in one way:
 *
 * ⚠️ **THE COLUMN IS PHYSICS, NOT BOOKKEEPING.** Day 1 called the 2D `placeInFlower` and
 * `retrieveFromFlower` outright, because a flower element was a FIXED body parked at whatever
 * height `flowerStackZ` modelled, and those two functions owned that height. The tube is real
 * now, so:
 *
 *  • **PLACE** drops the element at the top ring with zero velocity and lets it fall. Where it
 *    stops is the bores' business, and on this field's measurements that is NOT where the 2D
 *    model says (a NECTAR clears the 3.896 middle bore and lands on the lower plate — see
 *    `flowerTube.ts`'s header). Nothing here re-seats it afterwards.
 *  • **RETRIEVE** pops the element `derive.ts` has ordered LOWEST, if it is a POLLEN and if it
 *    is actually down at the retrieval opening. Nothing re-seats the column either: the elements
 *    above simply fall, which is what happens when you pull the bottom one out of a tube.
 *
 * What is REUSED, deliberately, is every gate that is a rule rather than a height: the Box Tube
 * reach test (`bbFlowerInReach`), the intake-mouth test (`bbFlowerAtIntake`), the hopper cap,
 * G418.B's "POLLEN only", and the `BB_FLOWER_RETRIEVE_S` pacing. Those are the same in both
 * pipelines because they are the same rules.
 */

export { bbFlowerAtIntake };

/**
 * THE DROP POINT: the element's CENTRE starts at the top plate's own UNDERSIDE, on the bore
 * axis, at rest. §3.7's words are "dropped at the top ring with zero velocity", and this is the
 * highest point that is honestly inside the ring.
 *
 * ⚠️ **NOT ABOVE THE PLATE, AND THE BACKSTOP IS WHY.** `Flower Backstop` is a real part and a
 * real collider: measured, its hull is a 0.25-in plate at z 22.40 … 22.65 whose field-side face
 * passes **0.375 in from the tube's axis**. An element created resting ON the top plate has its
 * centre at 21.4 + r and its own cross-section at the backstop's height is wider than that 0.375,
 * so it starts INTERPENETRATING the backstop and the solver's first act is to shove it sideways
 * — measured, 0.94 in for a POLLEN and 1.36 in for a NECTAR, which is enough to wedge it on the
 * ring's rim instead of dropping it down the bore. Starting one radius lower puts the whole
 * element inside the bore, clear of everything, which is also what a Box Tube depositing into a
 * tube actually does.
 *
 * The highest centre that clears the backstop is 21.05 for a POLLEN and 20.64 for a NECTAR
 * (`sqrt(r² − 0.375²)` below 22.40); the top plate's underside, 20.254, is below both with room
 * to spare and is a MEASURED feature rather than a number tuned against that arithmetic.
 *
 * ⚠️ **THE DROP IS SCATTERED, AND IT COULD NOT BE UNTIL THE TUBE HAD A WALL.** This comment used
 * to say "DEAD ON THE AXIS ON PURPOSE, DO NOT JITTER IT", and the table it carried was real:
 * through `step3d` in flower 0 at `BB3_CONTACT_FREQ` = 30, worst pollen-pollen centre gap
 * against the ideal 2.800 (4-stack / 8-stack overlap, max dxy), **with no cage in the tube**:
 *
 *   offset 0      0.065 / 0.152 in, dxy 0.000
 *   offset 0.032  0.795 / 0.834,    dxy 1.015
 *   offset 0.160  0.790 / 0.829,    dxy 1.015
 *
 * An offset of 15 % of the slack toppled the column and cost an ORDER OF MAGNITUDE of
 * interpenetration, and the response was not proportional — 0.032 and 0.160 toppled the same
 * amount — so there was no small safe value. That was never a fact about the drop point. It was
 * the same fact as the JAM the owner reported: above the mid plate the tube had **no wall at
 * all**, only four HIPS pipes at the diagonals, so a POLLEN centre could reach 1.046 in off-axis
 * through the gaps between them and a column simply fell onto its own shoulders. See
 * `BB3_FLOWER_CAGE_SEGMENTS` in `config.ts` for that measurement.
 *
 * With the cage in (`flowerTube.ts`) the same sweep is FLAT, because there is nowhere left to
 * topple to. Re-measured the same way, worst pollen-pollen interpenetration as a TRUE 3D centre
 * distance (the old table's z gap and the centre distance are the same number only for a column
 * that is dead on the axis, which is exactly what this change stops being true):
 *
 *   offset   4-stack / 8-stack   max dxy
 *   0.000    0.066 / 0.151       0.000
 *   0.032    0.059 / 0.145       0.668
 *   0.160    0.064 / 0.133       0.671   ← a POLLEN's scatter today (0.158)
 *   0.411    0.054 / 0.126       0.664
 *   0.548    0.061 / 0.133       0.669   ← the whole of the cage's slack
 *
 * So the scatter is free: it costs no interpenetration at any magnitude the cage allows, and the
 * dxy it produces is bounded by the tube rather than by the drop point. What the drop point IS
 * still bounded by is the fall — `bbFlowerDropSlack` in `flower.ts`, which is a BORE and not
 * the cage, and whose header carries the ejection that settled it. `BB3_FLOWER_SCATTER_FRAC`
 * sizes the draw; `bbFlowerScatter` is the draw, and it is a HASH and not the world's PRNG chain,
 * for the reason written there. The pre-match STAGED columns take the same draw in `spawn.ts`,
 * under a `'3d'` gate, so the first four columns of a match are scattered too.
 */
const PLACE_CENTRE_Z = FLOWER_RING_Z.top[0];

/**
 * THE SCATTER MIX for a PLACED element: the world's own `rngState` (read, never advanced) with
 * the TICK folded in. `bbFlowerScatter` (`../flower.ts`) is the draw and its header carries why
 * it is a hash rather than a chain; the tick is added here and not there because it is what tells
 * two placements of the SAME element apart — a POLLEN retrieved out of the bottom and put back in
 * later should not land in the same spot it did the first time, and its id has not changed.
 */
function placeMix(world: World): number {
  return (world.rngState ^ Math.imul(world.tick + 1, 0x9e3779b1)) | 0;
}

/**
 * Is there ROOM in flower `i` for one more element of radius `r`?
 *
 * A PHYSICAL test, not `flowerFits`: that helper answers the question against the 2D stacking
 * MODEL, and the 3D column's heights are the bodies' own. The column is full when something
 * already occupies the space the new element would be created in — i.e. when any element in the
 * tube reaches above the drop point's underside. That is the same rule `flowerFits` expresses
 * ("does the stack's top clear the ring"), asked of the stack that actually exists.
 */
function flowerHasRoom3d(world: World, bb: BiobuzzState, i: number, r: number, kindOf: (id: number) => BbElementKind): boolean {
  const dropBottom = PLACE_CENTRE_Z - r;
  for (const id of bb.flowers[i].stack) {
    const b = world.balls.find((x) => x.id === id);
    if (!b) continue;
    const top = b.z + 2 * (b.r ?? bbElementRadius(kindOf(id)));
    if (top > dropBottom) return false;
  }
  return true;
}

/**
 * PLACE one held element of the named kind into the FLOWER this robot's Box Tube is in reach of,
 * by DROPPING it at the top ring. Returns whether it happened; every refusal is an ordinary
 * outcome (no Box Tube, no flower in reach, nothing of that kind in the hopper, the column
 * already reaches the ring).
 *
 * The element is tagged `element`/`flower:i` immediately so `engine.ts` keeps its body and
 * `derive.ts` reads it as part of that tube from the next tick; the `slot` written here is a
 * placeholder that `derive.ts` overwrites by height on that same tick.
 */
export function flowerPlace3d(
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
  const kind: BbElementKind = color === 'red' || color === 'blue' ? color : 'pollen';
  const r = bbElementRadius(kind);
  if (!flowerHasRoom3d(world, bb, i, r, kindOf)) return false;
  const ball = takeHeld(world, rob, color);
  if (!ball) return false;
  const f = BB_FLOWERS[i];
  // the room the TIGHTEST BORE THIS ELEMENT FITS THROUGH leaves its centre — a POLLEN 0.211 in,
  // a NECTAR 0.148. NOT the cage's 0.548: see `bbFlowerDropSlack` for the ejection that measured
  // the difference.
  const off = bbFlowerScatter(placeMix(world), ball.id, i, bbFlowerDropSlack(r));
  ball.state = { kind: 'element', el: `flower:${i}`, slot: 0 };
  ball.pos.x = f.x + off.x;
  ball.pos.y = f.y + off.y;
  ball.z = PLACE_CENTRE_Z - r;
  // STILL ZERO VELOCITY (§3.7's "dropped at the top ring with zero velocity"). The scatter is a
  // seat, not a throw: a lateral velocity would have to be small enough not to bounce the element
  // off the cage and large enough to see, and the offset already does the visible half.
  ball.vel.x = 0;
  ball.vel.y = 0;
  ball.vz = 0;
  return true;
}

/**
 * RETRIEVE off a FLOWER's bottom opening — G418.B: a ROBOT may "only remove POLLEN from the
 * bottom of a FLOWER".
 *
 * Same gates as the 2D pipeline (a running intake, a mouth on the retrieval opening, hopper
 * room, one per `BB_FLOWER_RETRIEVE_S` off `lastIntakeAt`), and one extra that only a physical
 * column can ask: the candidate has to BE at the opening (`flowerAtRetrieval`, the 0.354 … 3.904
 * band the plates leave between them). In the 2D model "bottom of the stack" and "at the
 * opening" are the same statement; here they are not, because a column of two can have its
 * lowest element halfway up the tube while the one under it is still falling.
 *
 * A NECTAR at the bottom LOCKS the flower exactly as it does in 2D, and for the same reason
 * measured rather than assumed: a 3.6-in nectar passes neither the 3.222-in lower bore nor the
 * 3.550-in opening.
 *
 * ARCHETYPE-AWARE exactly as 2D is (owner, 2026-09-20): `bbFlowerReachOf` resolves what this
 * build's intake can reach, `bbFlowerAtIntake` asks the X/lateral bite against the flower's own
 * ring centre, and — the one test only a physical column can ask — the Z-BITE (`bbBites`) against
 * the candidate's ACTUAL height, on top of `flowerAtRetrieval`'s coarser "is it in the opening's
 * band at all". `ball.z` is the element's BOTTOM in this pipeline, so `ball.z + r` is its centre.
 *
 * ⚠️ **A `siderollers` BUILD DOES NOT `capturePollen` — IT RELEASES A `ground` ELEMENT
 * PHYSICALLY** (owner ruling 2026-09-20: "it should also be colliding with everything... a
 * physical thing", which means the wheel can never overlap a POLLEN either). `derive.ts`'s tube
 * test (`flowerTubeOf`, a plain radius from the flower's own axis, `BB_FLOWER_OPEN_R`) would
 * otherwise re-tag a release right back to `element`/`flower:i` on the very next `deriveTick`, so
 * the wheel's own release point is offset — `BB_SIDE_ROLLER_RELEASE_CLEAR`, retreating INWARD
 * (the wheel's own inward-drawing tangent, toward the mouth) — from the FLOWER's own true axis
 * (`i` already names it). `releaseFromFlowerGround` below is that mechanism.
 *
 * ⚠️ **A `ramp` BUILD IS DIFFERENT AGAIN, SINCE THE WEDGE (2026-09-20)** — see this branch's own
 * header below. A flat crossbar's proximity gate used to always fire before the physical push had
 * a tick to act (MEASURED, 10 runs, seeds 5001–5010: the ball's centre moved under 0.6 in before
 * the gate released it), so the crossbar's own branch did the same two-step `ground` release the
 * side roller does. The wedge (`config.ts`'s "THE DEPLOYABLE RAMP") changes that: it is shaped to
 * lift a bottom POLLEN over its own crest under an ordinary forward push, so the branch below no
 * longer releases on the gate at all — it only shoves the LEANING element as a fallback once the
 * SAME candidate has stalled for `BB_RAMP_STALL_S`, and only teleports (the old mechanism,
 * `BB_RAMP_RELEASE_V`) if there is nothing left to unlean.
 *
 * The direct proximity path (a sweeper's own `null` reach never reaches this far) is otherwise
 * unchanged, and a `siderollers` release must spend AT LEAST ONE TICK as `ground` before it can
 * be in the hopper.
 */
function releaseFromFlowerGround(
  world: World,
  bb: BiobuzzState,
  rob: RobotState,
  i: number,
  stack: readonly number[],
  ball: Artifact,
  worldPos: Vec2,
  z: number,
  vel: Vec2,
): void {
  ball.pos.x = worldPos.x;
  ball.pos.y = worldPos.y;
  ball.z = z;
  ball.vel.x = vel.x;
  ball.vel.y = vel.y;
  ball.vz = 0;
  ball.state = { kind: 'ground' };
  rob.lastIntakeAt = world.time; // the release is the paced action now, same as a capture was
  bb.flowers[i].stack = stack.slice(1);
}

/**
 * ⚠️ **THE RAMP'S LIP IS DRIVEN, AND WITHOUT THAT A RIGID RAMP CANNOT DO THIS AT ALL.** The
 * free-body argument is worked in `config.ts`'s "THE DEPLOYABLE RAMP": a lip meeting a POLLEN's
 * flank pushes it along the contact normal, `d(h)/r` sideways against `(r−h)/r` up, so the ball
 * RETREATS while it climbs. MEASURED (`scratch/rampx.ts`): it retreats **0.458 in** before it
 * wedges between the two `flower_peanut_support` hulls, and from there the lip would have to
 * reach `d(h) + 0.458` = **1.541 in** past the ball's own centre to be under it — against a hard
 * **1.136 in** ceiling, because the same supports stop the ramp at `BB_FLOWER_PEANUT_U`
 * (measured: they occupy `u 1.19…2.45` at `|v| 0.62…1.89`, so the only lane past them is 1.24 in
 * wide and moves with the driver's own lateral offset — a tongue that fits it is not a mechanism,
 * it is a 0.1-in alignment requirement). So no PASSIVE profile extracts this ball, at any lip
 * height that also clears the lower plate's 0.354 rim: the honest bound is `h ≤ 0.175`, and the
 * plate is at 0.354.
 *
 * What a real ramp intake has at the top of its lip is a ROLLER, and that is what closes it: a
 * DRIVEN surface drags the ball up the slope instead of shoving it along the normal. This is that
 * surface — the friction drive, not a teleport: it raises the ball's velocity COMPONENT along the
 * lip's own rise direction to `BB_RAMP_ROLLER_V` and never reduces it, leaving every other
 * component to the solver, so the ball still has to physically climb the plate's rim, ride the
 * nose and reach the deck, and every collision on the way is Rapier's. It runs only while the
 * driver holds the intake (the roller is on the same motor), only on the candidate the retrieval
 * gates have already agreed on, and it stops the tick the release fires.
 */
function rampRollerDrive(rob: RobotState, ax: BbMouthAxes, ball: Artifact): void {
  /**
   * ⚠️ **ALONG THE DECK, AND FLAT — WHICH IS THE OPPOSITE OF THE FIRST THREE DRAFTS.** A roller on
   * a TILTED lip drives up the slope, and the first three drafts of this did, because the ramp was
   * a wedge. The blade is LEVEL, so the surface it presents is level too — but the measurement is
   * what settled it rather than the geometry. Sweeping the drive's own rise angle over 400 real
   * drive-ins at the hardest column height (ONE pollen, dead on the axis, free to retreat, so
   * nothing behind it stops the lip pushing it away): **0 deg 400/400, 10 deg 381/400, 18 deg
   * 360/400, 25 deg 314/400, 35 deg 193/400, 45 deg 56/400.** Every degree of lift pops the ball
   * off the deck instead of walking it along, and a ball in the air is one `derive.ts` re-claims
   * into the tube on the next tick.
   *
   * A version aimed at the mouth's own SEAT rather than straight down the deck — a funnel, which
   * is what a pair of rollers is — was tried and measured NO BETTER: 1200 runs across three column
   * heights, 3 failures against this one's 2, both in the same skewed corner of the envelope.
   */
  const dir = rot({ x: -ax.n.x, y: -ax.n.y }, rob.heading);
  const along = ball.vel.x * dir.x + ball.vel.y * dir.y;
  if (along < BB_RAMP_ROLLER_V) {
    ball.vel.x += (BB_RAMP_ROLLER_V - along) * dir.x;
    ball.vel.y += (BB_RAMP_ROLLER_V - along) * dir.y;
  }
}

export function flowerRetrieve3d(
  world: World,
  bb: BiobuzzState,
  rob: RobotState,
  cmd: RobotCommand | undefined,
  enabled: boolean,
  ballById: ReadonlyMap<number, Artifact>,
  kindOf: (id: number) => BbElementKind,
): boolean {
  if (!enabled || !(rob.autoIntake || (cmd?.intake ?? false))) return false;
  if (rob.hopper.length >= bbHopperCap(rob.spec)) return false;
  // ⚠️ **THE PACING GATE MOVED BELOW THE ROLLER, AND IT IS WORTH FOUR TIMES THE RETRIEVAL RATE.**
  // `BB_FLOWER_RETRIEVE_S` paces how often a POLLEN may be TAKEN; it was never meant to pace the
  // hardware. With the check up here, the ramp's own roller (`rampRollerDrive`) turned for one
  // tick in nine. Every other path still reads it, one line before it acts, so no other cadence
  // moves.
  const kind = bbIntakeKindOf(rob.spec);
  const reach = bbFlowerReachOf(kind, bbRampSettled(rob, world.time));
  if (!reach) return false; // a sweeper, or a ramp not yet settled: nothing to reach with
  const hit = bbFlowerAtIntakeMouth(rob, reach, { pre6: importSideRollersPre6(world) });
  if (!hit) return false;
  const { i, ax } = hit;
  const stack = bb.flowers[i].stack;
  if (stack.length === 0) return false;
  const id = stack[0]; // `derive.ts` orders the stack bottom to top by the bodies' own heights
  if (kindOf(id) !== 'pollen') return false;
  const ball = ballById.get(id);
  if (!ball) return false;
  const r = ball.r ?? bbElementRadius('pollen');
  const zc = ball.z + r; // ball.z is the BOTTOM; the bite tests want the CENTRE
  const zEligible = flowerAtRetrieval(zc) && bbBites(reach.z[0], reach.z[1], zc, r);
  const paced = world.time - rob.lastIntakeAt >= BB_FLOWER_RETRIEVE_S;

  /**
   * ⚠️ **A `ramp` RETRIEVAL HAS ONE GATE AND IT IS THE BALL'S OWN HEIGHT.** Not a proximity
   * bite, not a timer: the POLLEN has to have been PICKED UP — its bottom above `BB_RAMP_LIFT_Z`,
   * which is the ramp's own underside and is above the lower plate's rim (0.354). Inside the tube
   * a POLLEN can only rest on the TILES (bottom 0) or on the element under it (bottom ≥ 2.8), so
   * a POLLEN standing at deck height in the retrieval opening is standing on the ROBOT.
   *
   * Nothing here moves it. The release is a RE-TAG IN PLACE — same position, same velocity, same
   * height, the body untouched — and `bbIntakeAct`'s own extended pull (`bbIntakeExtraReach`,
   * which reaches `BB_RAMP_OUT` further out for exactly this) draws it down the deck and into the
   * hopper from there, which is what the owner described: it collides with the ramp and slides
   * down towards the intake. It replaced a 0.25-s STALL CLOCK whose expiry teleported the POLLEN
   * out from under the column, because the wedge of the day could not lift one at all — see
   * `config.ts`'s "THE DEPLOYABLE RAMP" for the two geometric reasons and the free-body bound that
   * fixed them.
   *
   * The z-BITE below (`zEligible`) is deliberately NOT asked of this branch: it tests the reach
   * box against a POLLEN sitting where the 2D model says, and this one is on the robot's deck by
   * the time the gate is true.
   */
  if (kind === 'ramp') {
    if (paced && ball.z >= BB_RAMP_LIFT_Z) {
      ball.state = { kind: 'ground' };
      rob.lastIntakeAt = world.time; // the release is the paced action, same as a capture was
      bb.flowers[i].stack = stack.slice(1);
      return true;
    }
    rampRollerDrive(rob, ax, ball);
    return false;
  }

  // every remaining path (siderollers, and the direct sweeper/lift capture below) DOES need the
  // real z-bite AND the pacing — only the ramp's own roller (above) turns between takes.
  if (!paced) return false;
  if (!zEligible) return false;

  if (kind === 'siderollers') {
    // PHYSICAL HALF-STEP, generalised from the ramp's own — TWO EARLIER DRAFTS of this teleported
    // the ball somewhere along `u` (retreating INWARD past the flower's own axis, then past the
    // wheel's own solid span) and both were measured wrong: `u` unchanged is the one direction
    // that is ALREADY clear — the true position sits just past the wheel's own outer edge (the
    // contact condition puts it there), and retreating INWARD in `u` at all drives it into either
    // the wheel (a first draft) or, past that, has under 2 in of pocket depth for a 2.8-in POLLEN
    // to occupy without touching the frame face too (a second draft, MEASURED 0.2 in of headroom
    // — not enough). See `BB_SIDE_ROLLER_RELEASE_CLEAR`'s own header for both measurements.
    //
    // What actually needs to move is `v`: leaving it at the true axis (`v0`) is what a THIRD
    // draft got wrong the other way — the ball's WORLD position is still exactly the FLOWER's own
    // axis at that point (that is what "resting in the tube" means), so `derive.ts`'s tube test
    // (a bare `BB_FLOWER_OPEN_R` radius from THAT axis) re-tagged it `element`/`flower:i` again on
    // the very next tick, undoing the release in a way invisible from outside (the STACK never
    // shrank; only `lastIntakeAt` kept climbing as the same cycle repeated every qualifying tick).
    // `v0`'s size relative to the MOUTH's centreline was never the relevant distance — the tube
    // test measures from the FLOWER's own world position, which the ball had not moved from at
    // all. Shifting `v` TOWARD the centreline (magnitude `BB_SIDE_ROLLER_RELEASE_CLEAR`, more than
    // `BB_FLOWER_OPEN_R`) is a real world-space displacement off that axis and lands inside the
    // retrieval opening's own OPEN band (`config.ts`'s "the full plate width" — no support stands
    // in it), clear of the wheel's own lateral span in the same move.
    const f = BB_FLOWERS[i];
    const trueLocal = rot({ x: f.x - rob.pos.x, y: f.y - rob.pos.y }, -rob.heading);
    const u0 = trueLocal.x * ax.n.x + trueLocal.y * ax.n.y;
    const v0 = trueLocal.x * ax.p.x + trueLocal.y * ax.p.y;
    const v = v0 - Math.sign(v0 || 1) * BB_SIDE_ROLLER_RELEASE_CLEAR;
    const local = { x: u0 * ax.n.x + v * ax.p.x, y: u0 * ax.n.y + v * ax.p.y };
    const off = rot(local, rob.heading);
    // the wheel's own inward-drawing tangent — toward the mouth (−n), the same direction the
    // ramp nudges with, since a vertical roller's whole job is to walk something back over the
    // bumper rather than centre it laterally (that is the funnel's job, once it is `ground`).
    const nudge = rot({ x: -10 * ax.n.x, y: -10 * ax.n.y }, rob.heading);
    releaseFromFlowerGround(
      world,
      bb,
      rob,
      i,
      stack,
      ball,
      { x: rob.pos.x + off.x, y: rob.pos.y + off.y },
      FLOWER_RING_Z.lower[1], // resting on the lower plate's own rim — ball.z is the BOTTOM
      nudge,
    );
    return true;
  }

  const was = ball.state;
  ball.state = { kind: 'ground' };
  if (!capturePollen(world, rob, ball)) {
    ball.state = was; // refused (an intake rule said no): the element never left the FLOWER
    return false;
  }
  // NOTHING RE-SEATS THE COLUMN. `retrieveFromFlower`'s 2D twin re-slots and re-computes every
  // remaining element's `z` from `flowerStackZ`, because in that model the stack IS the column.
  // Here the elements above are real bodies that were resting on this one: they fall, and
  // `derive.ts` re-reads the order next tick.
  bb.flowers[i].stack = stack.slice(1);
  return true;
}
