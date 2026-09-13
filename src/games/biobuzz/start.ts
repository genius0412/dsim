import type { Alliance, RobotSpec, StartPose } from '../../types';
import * as C from '../../config';
import { clamp } from '../../math';
import {
  BB_FLOWERS,
  BB_FLOWER_D,
  BB_FLOWER_FOOT,
  BB_HALF_X,
  BB_HALF_Y,
  BB_LZ,
  FLOWER_MOUTH,
  type BbRect,
} from './config';
import { bbFootprint } from './robot';

/**
 * G304 START LEGALITY FOR BIOBUZZ — the evaluator and the snap, `evalStartPose`'s shape
 * (`src/sim/field.ts`) with this game's geometry.
 *
 * ── WHY IT IS NOT `evalStartPose` ──────────────────────────────────────────
 * The shared one is DECODE's G304: over a LAUNCH LINE, touching the GOAL, clear of the
 * classifier channel. None of those exist here. BIOBUZZ's G304 (manual-distilled §6.2, p104)
 * is five clauses about a pose, and it is a DIFFERENT five:
 *
 *   A. fully contained on the alliance's own side of the FIELD (columns A–C red, D–F blue),
 *      and — from the rule's own note — fully inside the perimeter, overhanging nothing.
 *   B. not attached to, entangled with or suspended from a FIELD element.
 *   C. touching the FIELD perimeter wall.
 *   D. not contacting, and not in the scoring volume of, a FLOWER.
 *   E. not in the LOADING ZONE.
 *   F/G/H. starting configuration, 4 POLLEN pre-loads, motionless.
 *
 * A, C, D and E are POSE properties and are what this file assesses. B and F–H are not: B and
 * F are properties of the BUILD (R102/R103 and what it is hooked onto), G is the STAGING
 * (`spawn.ts` puts four POLLEN in every hopper), and H is the match clock. A pose evaluator
 * that claimed them would be returning `true` for facts it cannot see.
 *
 * ⚠️ **C AND E TOGETHER ARE THE WHOLE PROBLEM.** A robot must TOUCH the perimeter and must NOT
 * be in its LOADING ZONE — and the LOADING ZONE is itself against the perimeter. So the legal
 * wall frontage is the perimeter MINUS that zone, minus the two FLOWER feet on the alliance's
 * own half, minus everything past x = 0. That is a short list of stretches rather than "any
 * wall", which is why the anchors moved onto the rear and audience walls: the alliance's own
 * SIDE wall is the one its LOADING ZONE eats.
 *
 * ── APPROX, AND WHERE ──────────────────────────────────────────────────────
 * The clauses are VERBATIM (manual-distilled §6.2 quotes G304 in full). The GEOMETRY they are
 * evaluated against is not all measured: `BB_LZ` is an `APPROX` figure read (±0.5 in on the
 * tape edge) and the FLOWER foot is owner CAD. Every place that matters is marked APPROX at
 * its own definition in `config.ts`; nothing here re-derives a number.
 */

/** how far inside the perimeter a seated pose sits (in). See `bbSnapStart` step 2. */
export const BB_WALL_SEAT = 0.01;

/**
 * WHY A POSE IS ILLEGAL — the first failing clause, in the order G304 lists them.
 *
 * A STRING rather than a clause enum because it is printed: the start editor would show it and
 * the smoke lane's `detail` carries it, and "in the LOADING ZONE" is what a person needs where
 * `!outOfLZ` is what a program needs. Both are returned; neither is derived from the other.
 */
export interface BbStartLegality {
  legal: boolean;
  /** G304.A note — the footprint is fully inside the FIELD perimeter, overhanging nothing. */
  contained: boolean;
  /** G304.A — the footprint is fully on the alliance's own side (red x < 0, blue x > 0). */
  ownSide: boolean;
  /** G304.C — the footprint contacts the perimeter wall (within `START_TOUCH_TOL`). */
  touching: boolean;
  /** G304.D — the footprint is clear of every FLOWER's foot and scoring volume. */
  clearFlower: boolean;
  /** G304.E — the footprint is clear of the alliance's LOADING ZONE. */
  outOfLZ: boolean;
  /** the first failing clause, in G304's order, or `null` when the pose is legal. */
  reason: string | null;
}

/** the axis-aligned box a rotated footprint occupies, plus the offset from the robot's origin
 * to that box's centre (non-zero whenever a one-ended sweeper makes the chassis asymmetric).
 *
 * AN AABB AND NOT THE ROTATED RECTANGLE, for every clause. It is CONSERVATIVE — a robot at 45°
 * whose true corner just clears a FLOWER foot is still refused — and that is the direction to
 * be wrong in: a start that is arguably legal and looks illegal costs a driver a nudge, and one
 * that is arguably illegal and looks legal costs them the MATCH (G304's remedy is DISABLED).
 * It is also the same rectangle `spawn.ts` fits inside the perimeter, so the spawner and the
 * assessor cannot disagree about what the robot occupies. */
function extents(spec: RobotSpec, headingDeg: number): { ax: number; ay: number; ox: number; oy: number } {
  const e = bbFootprint(spec);
  const h = (headingDeg * Math.PI) / 180;
  const c = Math.cos(h);
  const s = Math.sin(h);
  const half = (e.front + e.rear) / 2;
  const off = (e.front - e.rear) / 2;
  return {
    ax: Math.abs(half * c) + Math.abs(e.half * s),
    ay: Math.abs(half * s) + Math.abs(e.half * c),
    ox: off * c,
    oy: off * s,
  };
}

/** the footprint's AABB in field coordinates, for a pose. */
function box(spec: RobotSpec, pose: StartPose): BbRect {
  const { ax, ay, ox, oy } = extents(spec, pose.headingDeg);
  const cx = pose.x + ox;
  const cy = pose.y + oy;
  return { x0: cx - ax, x1: cx + ax, y0: cy - ay, y1: cy + ay };
}

function overlaps(a: BbRect, b: BbRect): boolean {
  return a.x1 > b.x0 && a.x0 < b.x1 && a.y1 > b.y0 && a.y0 < b.y1;
}

/**
 * A FLOWER's KEEP-OUT on the tiles: its FOOT, which is the rectangle flush to the wall that a
 * robot actually meets (`BB_FLOWER_FOOT`, owner CAD).
 *
 * IT COVERS THE SCORING VOLUME TOO, and that is arithmetic rather than an assumption. The
 * volume is the column through the 4.0-in top ring — radius `BB_FLOWER_OPEN_R` 2.0 about a
 * centre `BB_FLOWER_D` 2.54 off the wall face — so on the floor plan it spans 0.54…4.54 into
 * the field and ±2.0 along the wall. The foot spans 0…4.9 and ±3.0. The ring's shadow is
 * strictly inside the foot's, so a footprint clear of the foot is clear of both, and G304.D is
 * one rectangle test rather than a rectangle and a circle that can disagree in the last bit.
 *
 * Duplicated from `drawField.ts`'s `flowerFoot` only in the sense that both derive it from the
 * same two constants; the renderer's is a drawing detail and this is a rule, and a `src/games/
 * biobuzz/drawField.ts` import from a file `spawn.ts` calls would drag the canvas layer into
 * the headless server.
 */
export function bbFlowerKeepOut(f: (typeof BB_FLOWERS)[number]): BbRect {
  const n = FLOWER_MOUTH[f.wall]; // unit inward normal — one component is 0, the other ±1
  const wx = f.x - n.x * BB_FLOWER_D;
  const wy = f.y - n.y * BB_FLOWER_D;
  const half = BB_FLOWER_FOOT.along / 2;
  const ix = wx + n.x * BB_FLOWER_FOOT.deep;
  const iy = wy + n.y * BB_FLOWER_FOOT.deep;
  return {
    x0: Math.min(wx, ix) - (n.x === 0 ? half : 0),
    x1: Math.max(wx, ix) + (n.x === 0 ? half : 0),
    y0: Math.min(wy, iy) - (n.y === 0 ? half : 0),
    y1: Math.max(wy, iy) + (n.y === 0 ? half : 0),
  };
}

/** which side of x = 0 an alliance starts on: red is −x, blue is +x (`BB_LZ`, `BB_START_POSES`
 * — the canonical frame is BLUE and red is the point mirror). */
export function bbOwnSide(a: Alliance): 1 | -1 {
  return a === 'red' ? -1 : 1;
}

/**
 * EVALUATE A POSE AGAINST G304 — `pose` is in `a`'s ACTUAL field frame (already mirrored),
 * in degrees, exactly as `StartPose` is everywhere else in the repo.
 *
 * Every clause is assessed on the FOOTPRINT — chassis plus whatever the sweeper sticks out
 * (`bbFootprint`) — and never on the chassis box or the centre. The sweeper is a physical part
 * of the robot: it is what touches the wall, what sits in the LOADING ZONE, and what a FLOWER
 * foot stops. A centre-only test is how the pre-V1 anchors came to be "legal" while spawning a
 * robot with its whole sweeper through the perimeter.
 */
export function bbEvalStart(spec: RobotSpec, pose: StartPose, a: Alliance): BbStartLegality {
  const b = box(spec, pose);
  const side = bbOwnSide(a);

  const contained = b.x0 >= -BB_HALF_X && b.x1 <= BB_HALF_X && b.y0 >= -BB_HALF_Y && b.y1 <= BB_HALF_Y;
  // "fully contained on its own ALLIANCE's side" — the whole footprint past x = 0, not its
  // centre. The seam itself is the boundary: a robot straddling it is on neither side.
  const ownSide = side > 0 ? b.x0 >= 0 : b.x1 <= 0;

  // G304.C, assessed with the shared `START_TOUCH_TOL` (1.25 in) the rest of the repo assesses
  // wall contact with — one tolerance, so "touching" means the same thing to the assessor, to
  // `bbSnapStart`'s seat and to anything that later asks whether a robot is against the wall.
  const t = C.START_TOUCH_TOL;
  const touching =
    b.x0 <= -BB_HALF_X + t || b.x1 >= BB_HALF_X - t || b.y0 <= -BB_HALF_Y + t || b.y1 >= BB_HALF_Y - t;

  // G304.D — every FLOWER, not just the two on this alliance's half. A pose clear of its own
  // side cannot reach the far ones anyway, so testing all four costs nothing and means the
  // clause does not quietly depend on `ownSide` having been checked first.
  const clearFlower = !BB_FLOWERS.some((f) => overlaps(b, bbFlowerKeepOut(f)));

  // G304.E — the alliance's OWN zone. The opponent's is on their side of x = 0, so `ownSide`
  // already excludes it; naming only the own zone here keeps the two clauses independent.
  const outOfLZ = !overlaps(b, BB_LZ[a]);

  const reason = !contained
    ? 'overhangs the FIELD perimeter (G304.A)'
    : !ownSide
      ? `not fully on the ${a.toUpperCase()} side of the FIELD (G304.A)`
      : !touching
        ? 'not touching the FIELD perimeter wall (G304.C)'
        : !clearFlower
          ? 'contacting a FLOWER or in its scoring volume (G304.D)'
          : !outOfLZ
            ? 'in the LOADING ZONE (G304.E)'
            : null;

  return { legal: reason === null, contained, ownSide, touching, clearFlower, outOfLZ, reason };
}

/**
 * The perimeter stretches an alliance may legally back onto, as (wall, along-axis) pairs.
 *
 * THREE WALLS AND NOT FOUR: the fourth is the opponent's side wall, which G304.A puts out of
 * reach. Of the three, the alliance's OWN side wall is the one its LOADING ZONE sits on
 * (G304.E) and the rear and audience walls each carry one FLOWER foot (G304.D) — so all three
 * are stretches with holes in them, and `bbSnapStart` samples rather than reasons about which
 * hole a pose fell into.
 */
type Wall = 'left' | 'right' | 'rear' | 'audience';
function bbWalls(a: Alliance): Wall[] {
  return a === 'red' ? ['left', 'rear', 'audience'] : ['right', 'rear', 'audience'];
}

/** the pose that seats `spec` against `wall` at along-wall coordinate `u`, keeping `heading`. */
function seat(spec: RobotSpec, wall: Wall, u: number, headingDeg: number): StartPose {
  const { ax, ay, ox, oy } = extents(spec, headingDeg);
  // BB_WALL_SEAT is a hundredth of an inch — two orders of magnitude below anything
  // measurable and far under `START_TOUCH_TOL`, so the robot is still TOUCHING by every rule
  // that reads contact while being unambiguously INSIDE by every rule that reads containment.
  // A body cannot be both exactly tangent to the wall and provably inside it; which way the
  // float falls would depend on whoever recomputed the rotated half-extent last.
  const inX = BB_HALF_X - ax - BB_WALL_SEAT;
  const inY = BB_HALF_Y - ay - BB_WALL_SEAT;
  switch (wall) {
    case 'left':
      return { x: -inX - ox, y: u - oy, headingDeg };
    case 'right':
      return { x: inX - ox, y: u - oy, headingDeg };
    case 'rear':
      return { x: u - ox, y: inY - oy, headingDeg };
    case 'audience':
      return { x: u - ox, y: -inY - oy, headingDeg };
  }
}

/** how finely `bbSnapStart` walks a wall, in inches. Half an inch is under the `BB_LZ` figure
 * read's own ±0.5 uncertainty, so a finer grid would be measuring a number the manual does not
 * print that precisely. 288 samples a wall, three walls, one heading — microseconds. */
const SNAP_STEP = 0.5;

/**
 * SNAP A POSE TO THE NEAREST LEGAL G304 POSE for this spec and alliance. A pose that is
 * already legal is returned UNCHANGED — byte for byte, not re-seated — so a legal anchor and a
 * legal custom pose both survive the call untouched.
 *
 * THE SEARCH, and why it is a search: the legal set is the perimeter minus the LOADING ZONE
 * minus two FLOWER feet minus everything past x = 0, and it is spread over three walls that
 * meet at two corners. The old version reasoned about it — seat against the side wall, then
 * slide in y if the zone is hit — which is correct only while the anchors are on that one wall
 * and has no answer at all for a pose near a corner or beside a FLOWER. Sampling every wall at
 * `SNAP_STEP` and keeping the closest legal candidate is shorter, handles all three walls and
 * both corners, and cannot produce an illegal answer, because every candidate is passed
 * through `bbEvalStart` before it is considered.
 *
 * The HEADING IS KEPT. A translation is the smallest repair that preserves what the placement
 * was FOR — "against this wall, facing this way" — and a snap that rotated a robot would
 * change its auto path's first move without telling anyone.
 *
 * DETERMINISTIC: a fixed grid walked in a fixed order, ties broken by distance and then by the
 * lower along-wall coordinate, so both alliances resolve the mirror image of a tie the same
 * way and a replay re-derives the same pose.
 *
 * FALLBACK: a footprint for which NO sample is legal keeps its input pose, clamped inside the
 * perimeter. Unreachable today — the smoke lane sweeps the whole legal chassis envelope — and
 * the honest failure is a pose inside the field that a referee would move, not a pose outside
 * it that nothing can render.
 */
export function bbSnapStart(spec: RobotSpec, pose: StartPose, a: Alliance): StartPose {
  if (bbEvalStart(spec, pose, a).legal) return pose;

  let best: StartPose | null = null;
  let bestCost = Infinity;
  let bestU = Infinity;
  for (const wall of bbWalls(a)) {
    const lim = wall === 'left' || wall === 'right' ? BB_HALF_Y : BB_HALF_X;
    for (let u = -lim; u <= lim; u += SNAP_STEP) {
      const cand = seat(spec, wall, u, pose.headingDeg);
      if (!bbEvalStart(spec, cand, a).legal) continue;
      const cost = (cand.x - pose.x) ** 2 + (cand.y - pose.y) ** 2;
      // TIES ARE BROKEN BY THE LOWER ALONG-WALL COORDINATE, not by which wall came first in
      // `bbWalls`. A pose in a corner is equidistant from two seats on two different walls,
      // and iteration order is an implementation detail that a later edit could reverse; the
      // coordinate is a property of the candidate, so the same tie resolves the same way on
      // every peer and in every replay.
      if (cost < bestCost - 1e-9 || (cost < bestCost + 1e-9 && u < bestU)) {
        bestCost = Math.min(bestCost, cost);
        bestU = u;
        best = cand;
      }
    }
  }
  if (best) return best;

  // nothing legal anywhere on this alliance's frontage: keep the pose, inside the field.
  const { ax, ay, ox, oy } = extents(spec, pose.headingDeg);
  const limX = Math.max(0, BB_HALF_X - ax);
  const limY = Math.max(0, BB_HALF_Y - ay);
  return {
    x: clamp(pose.x + ox, -limX, limX) - ox,
    y: clamp(pose.y + oy, -limY, limY) - oy,
    headingDeg: pose.headingDeg,
  };
}

/** the footprint AABB of a pose — exported for the smoke lane and the gallery, so neither
 * re-derives the rectangle the rules above are written against. */
export function bbStartBox(spec: RobotSpec, pose: StartPose): BbRect {
  return box(spec, pose);
}
