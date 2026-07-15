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
import { CHAIN_BEAMS } from './beams';

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

  // BEAMS — four 1"-tall black tubes (difficult terrain) on the x/y axes, wall→diamond.
  // Drawn FIRST so the alliance divider tape reads over the vertical beams.
  for (const beam of CHAIN_BEAMS) {
    const r = beam.rect;
    ctx.fillStyle = '#0a0c0f';
    ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    ctx.strokeStyle = 'rgba(120,130,140,0.7)';
    ctx.lineWidth = 0.4;
    ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  }

  // ALLIANCE DIVIDER — red (left) / blue (right) boundary down the center that wraps
  // around the particle-zone diamond (the vertical line splits red|blue at the middle).
  const R = CHAIN_DIAMOND_R;
  const d = 0.7; // small offset from x=0 so red + blue read as two lines
  ctx.lineWidth = C.TAPE_W;
  const divider = (color: string, s: -1 | 1): void => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(s * d, hy);
    ctx.lineTo(s * d, R);
    ctx.lineTo(s * R, 0);
    ctx.lineTo(s * d, -R);
    ctx.lineTo(s * d, -hy);
    ctx.stroke();
  };
  divider(C.COLORS.red, -1);
  divider(C.COLORS.blue, 1);

  // PARTICLE ZONE — the central WHITE diamond (tape), drawn over the divider.
  ctx.strokeStyle = C.COLORS.white;
  ctx.lineWidth = C.TAPE_W;
  ctx.beginPath();
  ctx.moveTo(0, R);
  ctx.lineTo(-R, 0);
  ctx.lineTo(0, -R);
  ctx.lineTo(R, 0);
  ctx.closePath();
  ctx.stroke();

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

  // LAB AREAS / corners — WHITE tape corner squares (start + park zones).
  ctx.strokeStyle = C.COLORS.white;
  ctx.lineWidth = C.TAPE_W;
  for (const a of ['red', 'blue'] as Alliance[]) {
    for (const lab of labAreas(a)) {
      ctx.strokeRect(lab.x0, lab.y0, lab.x1 - lab.x0, lab.y1 - lab.y0);
    }
  }

  // RING STANDS — a vertical square POST rising from a triangular corner base plate
  // (rings hang around the post — the catalysts are drawn encircling it in draw.ts).
  const POST = 1.4; // post half-size (top-down square cross-section)
  const BASE = 12; // triangular base plate leg length
  for (const sx of [-1, 1] as const) {
    for (const sy of [-1, 1] as const) {
      const cx = sx * CHAIN_RINGSTAND_XY;
      const cy = sy * CHAIN_RINGSTAND_XY;
      // triangular base plate tucked into the corner
      ctx.fillStyle = '#33383e';
      ctx.beginPath();
      ctx.moveTo(sx * hx, sy * hy - sy * BASE);
      ctx.lineTo(sx * hx - sx * BASE, sy * hy);
      ctx.lineTo(cx, cy);
      ctx.closePath();
      ctx.fill();
      // black square post
      ctx.fillStyle = '#0a0c0f';
      ctx.fillRect(cx - POST, cy - POST, 2 * POST, 2 * POST);
      ctx.strokeStyle = 'rgba(120,130,140,0.7)';
      ctx.lineWidth = 0.4;
      ctx.strokeRect(cx - POST, cy - POST, 2 * POST, 2 * POST);
    }
  }

  // perimeter outline (drawn last so the accelerators read as attached to the wall)
  ctx.strokeStyle = C.COLORS.white;
  ctx.lineWidth = C.TAPE_W;
  ctx.strokeRect(-hx, -hy, 2 * hx, 2 * hy);
}
