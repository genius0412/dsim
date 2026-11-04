import type { Artifact, ArtifactColor, Vec2, World } from '../../types';
import { BB_HIVE_BOTTOM_Z, BB_POLLEN_R } from './config';
import { drawHiveCanopy } from './drawField';
import { drawBiobuzzReachCue, drawBiobuzzShotPath } from './drawShot';
import { ELEMENT_FILL, ELEMENT_LINE } from './elementInk';

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
 *
 * TWO PASSES AROUND THE HIVE CANOPY (owner feedback, 2026-09-13). This slot is the LAST thing
 * drawn, after the robots, so it is also where the HIVE structure gets put back on top of
 * whatever drove under it: everything on or near the tiles — ground elements, and airborne
 * ones still below the underside of the down cell (`BB_HIVE_BOTTOM_Z`) — is drawn first, then
 * `drawHiveCanopy` (`drawField.ts`) repaints the assembly translucently over its own
 * footprint, then the elements that are genuinely above the structure go on last. A spilled
 * POLLEN under the down cell reads as under it; a lob on its way to the up cell reads as over
 * it. The split is by HEIGHT alone: the canopy covers only its footprint, so a low element out
 * in the open is drawn before it and covered by nothing.
 */

export { BB_ALLIANCE_BLUE, ELEMENT_FILL, ELEMENT_LINE } from './elementInk';

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
  localRobotId?: number,
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

  // BELOW THE STRUCTURE / ABOVE IT — split on HEIGHT alone, never on the tag. Under 3D physics
  // `ground` means "loose and at rest", which includes an element parked on the HIVE frame 39 in
  // up (`sim3d/derive.ts`); keying the lower pass on the tag drew that one UNDER the canopy it
  // is sitting on top of.
  drawLoose(ctx, world, screenUp, (b) => b.z < BB_HIVE_BOTTOM_Z);
  drawHiveCanopy(ctx, world);
  drawLoose(ctx, world, screenUp, (b) => b.z >= BB_HIVE_BOTTOM_Z);

  // ...then the two DRIVER INSTRUMENTS, over the canopy and every element, in the order the 3D
  // twin stacks them (`scene/renderReticle.ts`: the collar is renderOrder 9, the path 10). They
  // answer two unrelated questions — can I place into that FLOWER, and would this shot enter the
  // HIVE — so the one that is a field MARKING goes under the one that is a TRAJECTORY.
  drawBiobuzzReachCue(ctx, world, localRobotId);
  // Drawn only when the shot would actually go in (`drawShot.ts` / `shotPath.ts`). It is an
  // instrument, so nothing on the field is allowed to sit on top of it.
  drawBiobuzzShotPath(ctx, world, screenUp, localRobotId);
}

/** the batched colour passes over every loose element `pick` admits — see the header. */
function drawLoose(
  ctx: CanvasRenderingContext2D,
  world: World,
  screenUp: Vec2,
  pick: (b: Artifact) => boolean,
): void {
  ctx.strokeStyle = ELEMENT_LINE;
  ctx.lineWidth = 0.35;
  for (const color of BATCH_ORDER) {
    let any = false;
    ctx.beginPath();
    for (const b of world.balls) {
      if (b.color !== color || !isLoose(b) || !pick(b)) continue;
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
