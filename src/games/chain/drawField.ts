import type { World } from '../../types';
import * as C from '../../config';
import type { Alliance } from '../../types';
import {
  CHAIN_ACCEL_DEPTH,
  CHAIN_ACCEL_HALF_Y,
  CHAIN_DIAMOND_R,
  CHAIN_HALF_X,
  CHAIN_HALF_Y,
  CHAIN_RINGSTAND_XY,
} from './config';
import { labAreas } from './state';

/**
 * Chain Reaction field renderer (manual §2–4 terminology).
 *
 * A standard FTC tile field with: the two ACCELERATORS protruding OUT of the side
 * walls (red left, blue right, centered in y); the four HOOKS on the accelerator
 * walls (hold Catalysts); the central PARTICLE ZONE diamond (red-left/blue-right);
 * and the four RING STAND climb posts near the corners. Accelerator + hook geometry
 * is exact (manual values); the Particle-Zone diamond and Ring-Stand positions are
 * APPROXIMATE (see config.ts) pending exact field-zone coordinates. Reuses DECODE's
 * `COLORS` so it themes/reads identically on the dark field.
 */
export function drawChainField(ctx: CanvasRenderingContext2D, _world: World): void {
  const hx = CHAIN_HALF_X;
  const hy = CHAIN_HALF_Y;

  // mat
  ctx.fillStyle = C.COLORS.mat;
  ctx.fillRect(-hx, -hy, 2 * hx, 2 * hy);

  // tile grid (every 24" tile)
  ctx.strokeStyle = C.COLORS.tile;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let x = -hx; x <= hx + 0.01; x += C.TILE) {
    ctx.moveTo(x, -hy);
    ctx.lineTo(x, hy);
  }
  for (let y = -hy; y <= hy + 0.01; y += C.TILE) {
    ctx.moveTo(-hx, y);
    ctx.lineTo(hx, y);
  }
  ctx.stroke();

  // PARTICLE ZONE — central diamond (APPROX). Left edges red, right edges blue,
  // matching the red-left / blue-right alliance split, plus a vertical divider.
  const R = CHAIN_DIAMOND_R;
  ctx.lineWidth = C.TAPE_W;
  ctx.strokeStyle = C.COLORS.red;
  ctx.beginPath();
  ctx.moveTo(0, R);
  ctx.lineTo(-R, 0);
  ctx.lineTo(0, -R);
  ctx.stroke();
  ctx.strokeStyle = C.COLORS.blue;
  ctx.beginPath();
  ctx.moveTo(0, R);
  ctx.lineTo(R, 0);
  ctx.lineTo(0, -R);
  ctx.stroke();
  ctx.strokeStyle = C.COLORS.white;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.moveTo(0, -hy);
  ctx.lineTo(0, hy);
  ctx.stroke();
  ctx.globalAlpha = 1;
  // center marker
  ctx.strokeStyle = C.COLORS.white;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.arc(0, 0, 3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // ACCELERATORS — protrude OUT of each alliance side wall (red left, blue right),
  // centered in y. Filled box + outline, matching the manual.
  const accelerator = (side: -1 | 1, fill: string, stroke: string): void => {
    const xInner = side * hx;
    const xOuter = side * (hx + CHAIN_ACCEL_DEPTH);
    const x0 = Math.min(xInner, xOuter);
    ctx.fillStyle = fill;
    ctx.fillRect(x0, -CHAIN_ACCEL_HALF_Y, CHAIN_ACCEL_DEPTH, 2 * CHAIN_ACCEL_HALF_Y);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = C.TAPE_W;
    ctx.strokeRect(x0, -CHAIN_ACCEL_HALF_Y, CHAIN_ACCEL_DEPTH, 2 * CHAIN_ACCEL_HALF_Y);
  };
  accelerator(-1, C.COLORS.redDim, C.COLORS.red);
  accelerator(1, C.COLORS.blueDim, C.COLORS.blue);

  // (HOOKS + seated rings are drawn dynamically in drawChainBalls so each hook
  // slot's occupancy is visible — see draw.ts.)

  // LAB AREAS — start/park corner squares, alliance-tinted (red owns x<0 corners,
  // blue x>0). Robots start here and PARK here in endgame.
  for (const a of ['red', 'blue'] as Alliance[]) {
    const stroke = a === 'red' ? C.COLORS.red : C.COLORS.blue;
    for (const lab of labAreas(a)) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = C.TAPE_W;
      ctx.strokeRect(lab.x0, lab.y0, lab.x1 - lab.x0, lab.y1 - lab.y0);
    }
  }

  // RING STANDS — vertical climb posts near the four corners (APPROX positions).
  // Drawn as a filled post with a ring collar (the purple-ringed corner objects).
  for (const sx of [-1, 1] as const) {
    for (const sy of [-1, 1] as const) {
      const cx = sx * CHAIN_RINGSTAND_XY;
      const cy = sy * CHAIN_RINGSTAND_XY;
      ctx.fillStyle = C.COLORS.tile;
      ctx.beginPath();
      ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#7c3aed'; // catalyst-purple collar
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, 3.4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // perimeter outline (drawn last so the accelerators read as attached to the wall)
  ctx.strokeStyle = C.COLORS.white;
  ctx.lineWidth = C.TAPE_W;
  ctx.strokeRect(-hx, -hy, 2 * hx, 2 * hy);
}
