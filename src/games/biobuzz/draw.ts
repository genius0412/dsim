import type { Artifact, ArtifactColor, Vec2, World } from '../../types';
import { BB_POLLEN_R } from './config';

/**
 * BIOBUZZ element renderer (the `drawBalls` slot — drawn AFTER the robots, so an element at
 * an intake reads as being at the intake rather than under the chassis).
 *
 * TWO SIZES, THREE COLOURS. POLLEN are 2.8 in and yellow; NECTAR are 3.6 in and carry their
 * alliance's colour (§9.8). Both roll on the tiles, so the renderer cannot assume one radius
 * or one fill the way the pre-Kickoff shell did — it reads `b.color` and `b.r` off each
 * element and falls back to `BB_POLLEN_R` for anything that predates the per-ball radius.
 *
 * Elements are drawn in two states and only two:
 *  • GROUND — flat on the tile.
 *  • FLIGHT — lifted along the camera's up axis with a ground shadow beneath, which is the
 *    only way a top-down view can say "this is in the air" at all.
 *
 * NOT DRAWN HERE:
 *  • HELD — inside a hopper. The robot sprite draws what it is holding itself, as small discs
 *    in these same colours at fixed slots on the deck read off `r.hopper` (see `drawRobot.ts`,
 *    which imports `ELEMENT_FILL`/`ELEMENT_LINE` from here). A held ball's own position is the
 *    chassis centre, so drawing it here would stack every held element on one point.
 *  • ELEMENT — parked inside a FLOWER stack or a HIVE CELL. Those are STRUCTURES with their
 *    own renderers: a FLOWER's contents belong in its stacked-pips badge and a CELL's in the
 *    hive's content count (`drawField.ts`), both of which can say "4 deep" in a top-down view
 *    where four concentric circles at the same (x, y) would say nothing at all.
 *  • STOCK — in a human player's hands, off the field entirely.
 *
 * ONE BATCHED PATH PER COLOUR. All the elements of a colour go into a SINGLE path that is
 * filled and stroked once, so a full field is three draw calls rather than two per element.
 * `moveTo` before each `arc` is what keeps the subpaths disjoint — without it the arcs are
 * joined by a chord and the fill bleeds between neighbours.
 */

/** Fixed rather than themed: the mat token already flips between light and dark, and an
 * element that also flipped would be a light ball on a light field half the time. The rim is
 * shared — one dark outline reads against the mat in both themes and against all three
 * fills. */
export const ELEMENT_LINE = 'rgba(28,22,6,0.6)';
export const ELEMENT_FILL: Record<ArtifactColor, string> = {
  yellow: '#f2d14b', // POLLEN
  red: '#e2564d', // red NECTAR
  blue: '#4d8fe2', // blue NECTAR
  // DECODE's two, unreachable in a BIOBUZZ world but the record has to be total
  purple: '#9b6bd6',
  green: '#59c08a',
};

/** the batching order, so a full field is a fixed three passes and the z-order of two
 * touching elements does not depend on their ids. */
const BATCH_ORDER: readonly ArtifactColor[] = ['yellow', 'red', 'blue'];

/** is this element loose on the field — on the tiles or in the air — and therefore ours to
 * draw? `held`, `element` and `stock` all belong to something else's renderer. */
function isLoose(b: Artifact): boolean {
  return b.state.kind === 'ground' || b.state.kind === 'flight';
}

/** an element's radius. `r` is optional on `Artifact` (DECODE has one size and does not set
 * it), so POLLEN is the fallback — never a hard-coded 1.4. */
function radiusOf(b: Artifact): number {
  return b.r ?? BB_POLLEN_R;
}

export function drawBiobuzzBalls(
  ctx: CanvasRenderingContext2D,
  world: World,
  screenUp: Vec2,
): void {
  // SHADOWS FIRST, all of them, so a shadow never lands on top of an element that is lower
  // than the one casting it.
  for (const b of world.balls) {
    if (b.state.kind !== 'flight') continue;
    const k = Math.max(0.3, 1 - b.z / 100);
    ctx.fillStyle = `rgba(0,0,0,${0.3 * k})`;
    ctx.beginPath();
    ctx.arc(b.pos.x, b.pos.y, radiusOf(b) * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = ELEMENT_LINE;
  ctx.lineWidth = 0.35;
  for (const color of BATCH_ORDER) {
    let any = false;
    ctx.beginPath();
    for (const b of world.balls) {
      if (b.color !== color || !isLoose(b)) continue;
      const r = radiusOf(b);
      const lift = b.state.kind === 'flight' ? b.z * 0.12 : 0;
      const x = b.pos.x + screenUp.x * lift;
      const y = b.pos.y + screenUp.y * lift;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
      any = true;
    }
    // an empty path still costs a fill and a stroke, and a field with no NECTAR loose on it
    // is the normal case for most of a match
    if (!any) continue;
    ctx.fillStyle = ELEMENT_FILL[color];
    ctx.fill();
    ctx.stroke();
  }
}
