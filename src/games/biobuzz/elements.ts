import type { Alliance, Artifact, RobotSpec, RobotState, StartPose, Vec2, World } from '../../types';
import { rot } from '../../math';
import {
  BB_FLOWER_OPEN_R,
  BB_FLOWER_TOP_Z,
  BB_FLOWERS,
  BB_HIVE_CELL_DY,
  BB_HIVE_OPEN_Z,
  BB_HIVE_UP_STAGED,
  BB_HIVE_X,
  BB_LAUNCH_Z0,
  BB_POLLEN_R,
  bbHopperCap,
} from './config';
import { otherSide } from './hive';
import { bbIntakeAccepts } from './mechs';
import { rectContains, type BbCellSide, type LocalRect, type ScoreTarget, type Vec3 } from './state';

/**
 * BIOBUZZ ELEMENTS — the contract surface Lane A exports to Lane B
 * (`docs/biobuzz-contract.md` §3).
 *
 * Everything about a POLLEN that is not its physics lives behind these six functions. Lane B's
 * mechanisms never touch `world.balls` or `world.biobuzz` directly; they ask here. That is
 * what lets Lane A change how a POLLEN is stored, scored or spawned without a single edit in
 * `robot.ts`, `drawRobot.ts` or the builder.
 *
 * ── WHAT IS REAL AND WHAT IS A STUB, AND WHY ────────────────────────────────
 * REAL: `pollenIn`, `capturePollen`, `releasePollen`. Capturing a ball you drove over and
 * throwing it back out is ROBOT behaviour, and R102's 18" cube plus the mount geometry are
 * enough to model it. These work, and the smoke checks drive them.
 *
 * STUBS, deliberately: `scoreTargets` returns `[]`, `evalStart` says legal, `actOnElement`
 * says false. All three answer questions only the manual can answer, and Sections 9 (ARENA),
 * 10 (Game Details) and 11 (Game Rules) of the V0 pre-season manual are each a single page
 * reading "will be updated with the Kickoff Competition Manual release on September 12, 2026".
 * A stub that returns nothing is honest. A guessed goal at a guessed coordinate worth a
 * guessed number of points is a thing that LOOKS finished, and the difference matters most on
 * the day someone opens the gallery to check the field.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every POLLEN currently inside `mouth` — a ROBOT-LOCAL rect, which is why the world-frame
 * position has to be rotated back into the robot frame here rather than by the caller.
 *
 * The POLLEN radius pads only the mouth's OUTWARD lip (see `rectContains`), so a POLLEN just
 * touching the roller counts as in while the inner and lateral bounds stay exact — a mouth
 * must never reach THROUGH the chassis and swallow something from behind the robot.
 *
 * Only GROUND pollen are candidates: one already held by a robot, or in flight, is not
 * something a roller can pick up, and letting a held POLLEN match would let two robots claim
 * the same one on the same tick.
 */
export function pollenIn(world: World, r: RobotState, mouth: LocalRect): Artifact[] {
  const found: Artifact[] = [];
  for (const b of world.balls) {
    if (b.state.kind !== 'ground') continue;
    const local = rot({ x: b.pos.x - r.pos.x, y: b.pos.y - r.pos.y }, -r.heading);
    if (rectContains(mouth, local.x, local.y, BB_POLLEN_R)) found.push(b);
  }
  return found;
}

/**
 * Take one POLLEN off the ground and into `r`'s hopper. Returns whether it happened.
 *
 * FALSE when the hopper is full or the POLLEN is not on the ground — both are ordinary
 * outcomes rather than errors, and returning a boolean (rather than throwing, or silently
 * doing nothing) is what lets the intake loop decide whether to keep looking.
 *
 * THE POLLEN STAYS IN `world.balls`, with `state.kind === 'held'`. Chain Reaction instead
 * DROPS the ball object on capture and tracks the count in `robot.hopper` alone, which makes
 * "is the count conserved" a sum over two places and a snapshot's ball array silently
 * incomplete. Keeping it in the array means `world.balls.length` is an invariant of the whole
 * match — which is exactly the thing `smoke-biobuzz` asserts over 600 ticks under both ball
 * solvers, and a far stronger check than CR can make.
 *
 * `r.hopper` still gets a colour pushed, because the shared renderer, HUD and wire all read
 * hopper LENGTH; the two are mirrored, and `releasePollen` unmirrors them in the same step.
 *
 * ── WHICH ELEMENTS AN INTAKE REFUSES (owner ruling 2026-09-12) ─────────────
 * A NECTAR (colour `red`/`blue`) is refused when:
 *  · it belongs to the OTHER alliance — G408, for every build; and
 *  · this robot's launcher cannot carry NECTAR at all (`bbCarriesNectar`: a SINGLE turret
 *    feeds POLLEN only; a double turret and a dumper take their own NECTAR).
 * Both are the one pure predicate `bbIntakeAccepts` (`mechs.ts`). A refused element is simply
 * not taken: it stays on the floor for the solve to push, exactly like one meeting a full hopper.
 */
export function capturePollen(world: World, r: RobotState, ball: Artifact): boolean {
  if (ball.state.kind !== 'ground') return false;
  if (!bbIntakeAccepts(r.spec, r.alliance, ball.color)) return false;
  if (r.hopper.length >= bbHopperCap(r.spec)) return false;
  ball.state = { kind: 'held', robot: r.id, slot: r.hopper.length, lx: 0, ly: 0, side: 0 };
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  // POLLEN are YELLOW (§9.8). `r.hopper` is the colour array the shared hopper HUD renders,
  // so it has to carry the element's real colour rather than a placeholder — a hopper full of
  // DECODE green under a BIOBUZZ robot is the kind of wrong that only shows up in a screenshot.
  r.hopper.push(ball.color);
  r.lastIntakeAt = world.time;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// RELEASE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TAKE ONE HELD ELEMENT OF `color` OUT OF `r` — the ONE place the hopper and the held set are
 * unmirrored, used by the launch (`releasePollen`) and the Box Tube's placement (`play.ts`).
 *
 * Removes the LAST occurrence of `color` from `r.hopper` and returns the held ball of THIS robot
 * with THAT colour at the highest `world.balls` index. It changes NOTHING and returns `null` when
 * either half is missing: hopper and held set out of sync means something wrote one without the
 * other, and inventing an element would break the conservation invariant this game's smoke
 * proves. The returned ball is still `held` — the caller decides where it goes.
 */
export function takeHeld(world: World, r: RobotState, color: Artifact['color']): Artifact | null {
  const j = r.hopper.lastIndexOf(color);
  if (j < 0) return null;
  for (let i = world.balls.length - 1; i >= 0; i--) {
    const b = world.balls[i];
    if (b.state.kind === 'held' && b.state.robot === r.id && b.color === color) {
      r.hopper.splice(j, 1);
      return b;
    }
  }
  return null;
}

/**
 * Throw one held POLLEN back out, with velocity `v`.
 *
 * A LOB, NOT A SHOT. `scoreTargets()` is empty, so there is nothing to solve an arc against;
 * the caller hands over the velocity it wants and this puts a POLLEN on that trajectory. When
 * Section 9 gives BIOBUZZ real targets, the `target` argument is where the arc solution goes,
 * and every existing caller keeps working because it is optional.
 *
 * `origin` is an extension past the contract signature (which is `(world, r, v, target?)`) and
 * is optional for that reason: a turret fires from its ring and a turretless launcher from a
 * point along its edge, and without it every archetype's POLLEN would be born at the chassis
 * centre — inside the robot, which the separation pass then has to shove out through the
 * frame. Callers that do not care omit it and get the chassis centre.
 *
 * LIFO — the last element in is the first out. A hopper is a stack, not a queue: the feed path
 * is at the top.
 *
 * ⚠️ THE HELD ELEMENT RELEASED IS THE ONE WHOSE COLOUR LEAVES THE HOPPER (`takeHeld`). This
 * used to release the held ball with the highest `world.balls` index while popping the hopper's
 * last colour, which is the same ball only while every element is a POLLEN. Once NECTAR and
 * POLLEN mix, the two drifted: a NECTAR could leave the robot while the hopper said a POLLEN
 * had.
 *
 * `color` (trailing, optional) names which colour to release; absent, it is the hopper's top.
 */
export function releasePollen(
  world: World,
  r: RobotState,
  v: Vec3,
  target?: ScoreTarget,
  origin?: Vec2,
  color?: Artifact['color'],
): void {
  void target; // the caller has already solved the arc
  if (r.hopper.length === 0) return;
  const held = takeHeld(world, r, color ?? r.hopper[r.hopper.length - 1]);
  if (!held) return;
  const o = origin ?? { x: r.pos.x, y: r.pos.y };
  // `by` is what makes the opponent's CELL refuse this element (`play.ts`, owner ruling
  // 2026-09-12). It is stamped HERE, at the one place a POLLEN becomes a flight, so no launcher
  // archetype can forget it.
  held.state = { kind: 'flight', target: r.alliance, by: r.alliance };
  held.pos = { x: o.x, y: o.y };
  held.vel = { x: v.x, y: v.y };
  held.z = BB_LAUNCH_Z0;
  held.vz = v.z;
}

// ─────────────────────────────────────────────────────────────────────────────
// STUBS — the manual has not published the rules these answer
// ─────────────────────────────────────────────────────────────────────────────

/** the mid-height of the up-CELL opening (in) — Fig 9-10 gives the opening as a band from
 * 53.5 to 65.6, and an arc solves for one number. */
const CELL_AIM_Z = (BB_HIVE_OPEN_Z[0] + BB_HIVE_OPEN_Z[1]) / 2;

/**
 * ACCEPTING RADIUS of a CELL opening (in).
 *
 * APPROX: the opening is a 20 x 12 rect (`BB_CELL_OPEN`, Fig 9-11), and `ScoreTarget` carries
 * one radius. 8 is the inscribed-ish compromise — under the 10 half-width so a shot at the
 * radius limit is still over the opening, over the 6 half-depth so the target is not
 * artificially harder than the real mouth. Replace with the rect when `ScoreTarget` grows one.
 */
const CELL_ACCEPT_R = 8;

/**
 * The CELL of `a`'s HIVE that a launcher should be POINTED AT.
 *
 * Settled, that is the one facing up — `world.biobuzz.hives[a].up`.
 *
 * ⚠️ THROUGH A SWING IT IS THE INCOMING CELL, FROM THE FIRST TICK OF THE TIP (owner feedback,
 * 2026-09-12). `up` goes on naming the tray that is going DOWN until the swing settles, so a
 * target list built off `up` held every turret on the emptying cell for four seconds and then
 * snapped across the pivot at the settle — which is the opposite of tracking. A TIP is a
 * four-second announcement that the target is moving, and the aim should start moving with it
 * immediately; by the time the bar is level the turret is already on the cell that will be
 * taking elements.
 *
 * AIM IS NOT CAPTURE, and the two answers are deliberately different for the first half of the
 * swing: `hiveTakingSide` (`hive.ts`) still says `up` until the release, because a shot already
 * in the air belongs to the tray that is still holding its load. So a volley in flight lands in
 * the old cell while the turret is already slewing to the new one, and AUTO-FIRE holds the gap
 * (`bbCellTaking`, `play.ts`) until the release hands over.
 *
 * `world.biobuzz` is optional on `World` (it is absent in a DECODE or Chain Reaction world),
 * and the STAGED pose is the fallback for that one case rather than a `!`: a missing bag means
 * the caller is not in a BIOBUZZ match at all, and the field's own t = 0 tilt (§10.3.1
 * Fig 10-2) is the only honest answer to "which cell is up" when there is no match to ask.
 */
function aimCell(world: World, a: Alliance): BbCellSide {
  const hive = world.biobuzz?.hives[a];
  if (!hive) return BB_HIVE_UP_STAGED[a];
  return hive.tipping > 0 ? otherSide(hive.up) : hive.up;
}

/**
 * Every place `a` can aim POLLEN, nearest-in-value first: its OWN up-CELL, then the four
 * FLOWER tops.
 *
 * ⚠️ **THE OPPONENT'S CELL IS NOT ON THIS LIST** (owner ruling 2026-09-12, field-plan §2.1).
 * It used to be, on the reading that it was a legal shot which simply scored nothing. The
 * ruling is stronger than that: an element launched by the other alliance does NOT ENTER at
 * all — it misses and lands as ground, and it is not penalised. So the opponent's opening is
 * not a place `a` can put a POLLEN, and a list of "where may `a` score" that carries it is
 * telling a launcher about a target that cannot exist. `play.ts` enforces the same ruling at
 * the capture end, off the flight element's `by`; this is the AIM end of one rule.
 *
 * The consequence for a caller that wants EVERY opening on the field — the capture pass is the
 * only one — is that it must ask for both alliances and merge. `play.ts` does, by id.
 *
 * The FLOWERS are `alliance: null` and appear for both: a FLOWER is owned at run time by
 * whoever holds the top-most NECTAR in it (§10.5.2), so it belongs to nobody at aim time.
 *
 * STATIC GEOMETRY ONLY. Positions come from the constants and from which CELL is up; nothing
 * here runs the tip, counts contents or decides whether a shot went in. A CELL centre sits
 * `BB_HIVE_CELL_DY` from its pivot along y (15.4 along the assembly, foreshortened by the 30°
 * tilt — Fig 9-9/9-10), and the pivots are at x = -/+`BB_HIVE_X` for red/blue (Fig 9-10,
 * centre to centre 25.5).
 */
/**
 * WHICH WAY A FLOWER'S MOUTH FACES — out of the wall it stands against, into the field.
 *
 * The FLOWER is a column on the perimeter, so its open top is reachable from one half-space
 * only: the field side. The wall side is the wall.
 *
 * EXPORTED because it is also the only direction a badge or a stack readout can be drawn from
 * a FLOWER without the perimeter clipping it — `drawField.ts` held a private `FIELD_SIDE` with
 * exactly this table, and two copies of a four-entry map is two chances to disagree about
 * which way `rear` is. There is one table now, and this is it.
 */
export const FLOWER_MOUTH: Record<(typeof BB_FLOWERS)[number]['wall'], Vec2> = {
  left: { x: 1, y: 0 }, // F1 stands on −x, opens toward +x
  rear: { x: 0, y: -1 }, // F2 stands on +y, opens toward −y
  right: { x: -1, y: 0 }, // F3 stands on +x, opens toward −x
  audience: { x: 0, y: 1 }, // F4 stands on −y, opens toward +y
};

export function scoreTargets(world: World, a: Alliance): ScoreTarget[] {
  // THE CELL'S MOUTH IS ITS TILT DIRECTION. Both CELLS sit on the same pivot, offset along y
  // by ±`BB_HIVE_CELL_DY`, and the one facing UP opens AWAY from that pivot — the see-saw has
  // lifted its far end, so the opening looks back down the +y or −y the cell was raised along.
  // It is the SAME sign as the cell's own offset, which is why this reads off `aimCell` once
  // and uses it for both the position and the direction: they cannot disagree.
  const cell = (owner: Alliance): ScoreTarget => {
    const s = aimCell(world, owner) === 'south' ? -1 : 1;
    return {
      id: `hive:${owner}`,
      alliance: owner,
      pos: {
        x: owner === 'red' ? -BB_HIVE_X : BB_HIVE_X,
        y: s * BB_HIVE_CELL_DY,
      },
      z: CELL_AIM_Z,
      r: CELL_ACCEPT_R,
      mouth: { x: 0, y: s },
    };
  };
  return [
    cell(a),
    ...BB_FLOWERS.map((f, i) => ({
      id: `flower:${i}`,
      alliance: null,
      pos: { x: f.x, y: f.y },
      z: BB_FLOWER_TOP_Z,
      r: BB_FLOWER_OPEN_R,
      mouth: { ...FLOWER_MOUTH[f.wall] },
    })),
  ];
}

/**
 * Is this robot's start pose legal? ALWAYS YES, and the sim module says so out loud with
 * `startLegality: false`, which is what keeps the server's DECODE-only start gate off this
 * game entirely.
 *
 * Start legality is a rule about ZONES, and Section 9 is the page that defines them. Making
 * one up would be worse than having none: a fabricated zone would reject poses a real BIOBUZZ
 * rule allows, and players would build around a constraint that does not exist.
 */
export function evalStart(
  spec: RobotSpec,
  a: Alliance,
  pose: StartPose,
): { legal: boolean; reason?: string } {
  void spec;
  void a;
  void pose;
  return { legal: true };
}

/**
 * Perform a named game ACTION on a field element — the generic hook for "press the button",
 * "release the gate", "seat the thing on the other thing". Returns whether anything happened.
 *
 * ALWAYS FALSE: Section 10 has not said what BIOBUZZ's actions are. The hook exists now so
 * that the command plumbing, the mobile button slot and the penalty engine's edge triggers
 * all have something to call, and so adding the first real action is a case in a switch rather
 * than a new path through four files.
 */
export function actOnElement(world: World, r: RobotState, act: string): boolean {
  void world;
  void r;
  void act;
  return false;
}
