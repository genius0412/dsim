import type { Vec2, World } from '../types';
import * as C from '../config';

export function drawBalls(
  ctx: CanvasRenderingContext2D,
  world: World,
  screenUp: Vec2,
): void {
  // shadows for airborne balls
  for (const b of world.balls) {
    if (b.state.kind !== 'flight' && b.state.kind !== 'basin') continue;
    const k = Math.max(0.25, 1 - b.z / 120);
    ctx.fillStyle = `rgba(0,0,0,${0.35 * k})`;
    ctx.beginPath();
    ctx.ellipse(b.pos.x, b.pos.y, C.BALL_RADIUS * k, C.BALL_RADIUS * k * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const b of world.balls) {
    if (b.state.kind === 'stock') continue;
    let x = b.pos.x;
    let y = b.pos.y;
    let rad = C.BALL_RADIUS;
    // only truly airborne balls get the height offset — balls in the
    // classifier draw exactly where they are so the flow reads correctly
    const airborne = b.state.kind === 'flight' || b.state.kind === 'basin';
    if (airborne && b.z > 0) {
      x += screenUp.x * b.z * 0.5;
      y += screenUp.y * b.z * 0.5;
      rad *= 1 + b.z / 140;
    }
    const base = b.color === 'purple' ? C.COLORS.purple : C.COLORS.green;
    const grad = ctx.createRadialGradient(x - rad * 0.35, y + rad * 0.35, rad * 0.15, x, y, rad);
    grad.addColorStop(0, lighten(base));
    grad.addColorStop(1, base);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.4;
    ctx.stroke();
  }
}

function lighten(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 0xff) + 70);
  const g = Math.min(255, ((n >> 8) & 0xff) + 70);
  const b = Math.min(255, (n & 0xff) + 70);
  return `rgb(${r},${g},${b})`;
}
