import type { Vec2, World } from '../../types';
import { BB_POLLEN_R } from './config';

/**
 * BIOBUZZ POLLEN renderer (the `drawBalls` slot — drawn AFTER the robots, so a POLLEN at an
 * intake reads as being at the intake rather than under the chassis).
 *
 * POLLEN are drawn in three states and only three:
 *  • GROUND — flat on the tile.
 *  • FLIGHT — lifted along the camera's up axis with a ground shadow beneath, which is the
 *    only way a top-down view can say "this is in the air" at all.
 *  • HELD   — NOT DRAWN HERE. A held POLLEN is inside a hopper; the robot sprite draws its
 *    own hopper fill from `hopper.length` (see `drawRobot.ts`), and drawing the individual
 *    balls as well would show them sitting on top of the robot.
 *
 * ONE BATCHED PATH. Every POLLEN is the same colour, so all of them go into a SINGLE path
 * that is filled and stroked once, rather than two draw calls per element. At the shell's 60
 * that is a minor win; at whatever count Section 10 lands on it is the difference between a
 * frame budget and a slideshow, and the batching costs nothing to write now. `moveTo` before
 * each `arc` is what keeps the subpaths disjoint — without it the arcs are joined by a chord
 * and the fill bleeds between neighbours.
 */

/** POLLEN are drawn as a pale ball with a dark rim — high contrast against the mat in both
 * themes, which is why these are fixed rather than themed: the mat token already flips, and a
 * pollen that also flipped would be a light ball on a light field half the time. */
const POLLEN_FILL = '#f2d14b';
const POLLEN_LINE = 'rgba(28,22,6,0.6)';

export function drawBiobuzzBalls(
  ctx: CanvasRenderingContext2D,
  world: World,
  screenUp: Vec2,
): void {
  // SHADOWS first, so every airborne pollen's shadow is under every pollen. Drawn at the true
  // ground position (no lift), fading with height — a shadow that stayed solid at altitude
  // reads as the ball itself.
  for (const b of world.balls) {
    if (b.state.kind !== 'flight') continue;
    const k = Math.max(0.3, 1 - b.z / 100);
    ctx.fillStyle = `rgba(0,0,0,${0.3 * k})`;
    ctx.beginPath();
    ctx.arc(b.pos.x, b.pos.y, BB_POLLEN_R * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = POLLEN_FILL;
  ctx.strokeStyle = POLLEN_LINE;
  ctx.lineWidth = 0.35;
  ctx.beginPath();
  for (const b of world.balls) {
    if (b.state.kind === 'held') continue; // inside a hopper — the robot draws its own fill
    const lift = b.state.kind === 'flight' ? b.z * 0.12 : 0;
    const x = b.pos.x + screenUp.x * lift;
    const y = b.pos.y + screenUp.y * lift;
    ctx.moveTo(x + BB_POLLEN_R, y);
    ctx.arc(x, y, BB_POLLEN_R, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
}
