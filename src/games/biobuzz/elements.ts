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
import { rectContains, type LocalRect, type ScoreTarget, type Vec3 } from './state';

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
 */
export function capturePollen(world: World, r: RobotState, ball: Artifact): boolean {
  if (ball.state.kind !== 'ground') return false;
  if (r.hopper.length >= bbHopperCap(r.spec)) return false;
  ball.state = { kind: 'held', robot: r.id, slot: r.hopper.length, lx: 0, ly: 0, side: 0 };
  ball.vel = { x: 0, y: 0 };
  ball.z = 0;
  ball.vz = 0;
  // colour is cosmetic in BIOBUZZ — POLLEN are one kind — but the field is required by the
  // shared `Artifact` type and read by the shared hopper HUD, so it is written consistently.
  r.hopper.push('green');
  r.lastIntakeAt = world.time;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// RELEASE
// ─────────────────────────────────────────────────────────────────────────────

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
 * LIFO — the last POLLEN in is the first out. A hopper is a stack, not a queue: the feed path
 * is at the top.
 */
export function releasePollen(
  world: World,
  r: RobotState,
  v: Vec3,
  target?: ScoreTarget,
  origin?: Vec2,
): void {
  void target; // no targets exist yet — see the note above
  if (r.hopper.length === 0) return;
  // the LAST held pollen of this robot, matching the `pop` below
  let held: Artifact | null = null;
  for (let i = world.balls.length - 1; i >= 0; i--) {
    const b = world.balls[i];
    if (b.state.kind === 'held' && b.state.robot === r.id) {
      held = b;
      break;
    }
  }
  // Hopper and held-pollen set out of sync means something wrote one without the other. Bail
  // rather than invent a POLLEN: a spawned ball would break the conservation invariant, which
  // is the one property this game's smoke actually proves.
  if (!held) return;
  r.hopper.pop();
  const o = origin ?? { x: r.pos.x, y: r.pos.y };
  held.state = { kind: 'flight', target: r.alliance };
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

/** the CELL of `a`'s HIVE that currently faces UP.
 *
 * BRIDGE, and deliberately a cast: the tip machine will keep this on
 * `world.biobuzz.hives[a].up`, but `BiobuzzState` has no `hives` member yet, and `state.ts`
 * is not this commit's to edit. Reading it optionally means the day that field lands, aim
 * follows a real TIP with no edit here; until then every HIVE is in its STAGED pose
 * (`BB_HIVE_UP_STAGED`, §10.3.1 Fig 10-2), which is exactly where the field is at t = 0.
 * Delete the cast when `hives` exists. */
function upCell(world: World, a: Alliance): 'north' | 'south' {
  const hives = (world.biobuzz as { hives?: Record<Alliance, { up: 'north' | 'south' }> } | undefined)
    ?.hives;
  return hives?.[a]?.up ?? BB_HIVE_UP_STAGED[a];
}

/**
 * Every place `a` can aim POLLEN, nearest-in-value first: its OWN up-CELL, the opponent's
 * up-CELL, then the four FLOWER tops.
 *
 * The opponent's CELL is in the list because it is a LEGAL shot that simply scores nothing —
 * `alliance` is set on both cells so a launcher can tell them apart and skip the one that
 * wastes a POLLEN, rather than the field pretending the opening is not there. The FLOWERS are
 * `alliance: null`: a FLOWER is owned at run time by whoever holds the top-most NECTAR in it
 * (§10.5.2), so it belongs to nobody at aim time.
 *
 * STATIC GEOMETRY ONLY. Positions come from the constants and from which CELL is up; nothing
 * here runs the tip, counts contents or decides whether a shot went in. A CELL centre sits
 * `BB_HIVE_CELL_DY` from its pivot along y (15.4 along the assembly, foreshortened by the 30°
 * tilt — Fig 9-9/9-10), and the pivots are at x = -/+`BB_HIVE_X` for red/blue (Fig 9-10,
 * centre to centre 25.5).
 */
export function scoreTargets(world: World, a: Alliance): ScoreTarget[] {
  const opp: Alliance = a === 'red' ? 'blue' : 'red';
  const cell = (owner: Alliance): ScoreTarget => ({
    id: `hive:${owner}`,
    alliance: owner,
    pos: {
      x: owner === 'red' ? -BB_HIVE_X : BB_HIVE_X,
      y: upCell(world, owner) === 'south' ? -BB_HIVE_CELL_DY : BB_HIVE_CELL_DY,
    },
    z: CELL_AIM_Z,
    r: CELL_ACCEPT_R,
  });
  return [
    cell(a),
    cell(opp),
    ...BB_FLOWERS.map((f, i) => ({
      id: `flower:${i}`,
      alliance: null,
      pos: { x: f.x, y: f.y },
      z: BB_FLOWER_TOP_Z,
      r: BB_FLOWER_OPEN_R,
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
