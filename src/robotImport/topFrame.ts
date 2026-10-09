/**
 * THE TOP-DOWN PICTURE'S FRAME: where the importer's 512-px PNG sits in the robot frame. A leaf
 * (types only), split out of `geometry.ts` so the 2D renderers and the asset seam can read it
 * without pulling the importer's measuring code into the main chunk.
 */
import type { Vec2 } from '../types';
import { TOP_IMAGE_PX } from './types';

/** the side a degenerate hull falls back to: the 18-in cube */
const TOP_FALLBACK_SIDE_IN = 18;

export interface TopImageFrame {
  /** robot-local point at the image centre, inches */
  cx: number;
  cy: number;
  /** inches the square image spans */
  sideIn: number;
  inPerPx: number;
  px: number;
}

/**
 * The top-down PNG's mapping, from the descriptor's hull alone (so a renderer recomputes it from
 * `spec.imported.hull` and nothing else). Centre = the hull's box centre; side = the larger box
 * side plus 0.5 in a side. Front = image up, robot left = image left.
 */
export function topImageFrame(hull: readonly Vec2[], px = TOP_IMAGE_PX): TopImageFrame {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of hull) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const b = { minX, maxX, minY, maxY };
  const ok = Number.isFinite(b.minX);
  const cx = ok ? (b.minX + b.maxX) / 2 : 0;
  const cy = ok ? (b.minY + b.maxY) / 2 : 0;
  const sideIn = (ok ? Math.max(b.maxX - b.minX, b.maxY - b.minY) : TOP_FALLBACK_SIDE_IN) + 1;
  return { cx, cy, sideIn, inPerPx: sideIn / px, px };
}

/** robot-local inches → image pixel (continuous, origin top-left) */
export function robotToTopPixel(p: Vec2, f: TopImageFrame): { u: number; v: number } {
  return { u: f.px / 2 - (p.y - f.cy) / f.inPerPx, v: f.px / 2 - (p.x - f.cx) / f.inPerPx };
}

/** image pixel → robot-local inches */
export function topPixelToRobot(u: number, v: number, f: TopImageFrame): Vec2 {
  return { x: f.cx + (f.px / 2 - v) * f.inPerPx, y: f.cy + (f.px / 2 - u) * f.inPerPx };
}
