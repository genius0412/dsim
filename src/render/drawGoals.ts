import type { Alliance, World } from '../types';
import * as C from '../config';
import { goalSide } from '../sim/field';
import { railStack } from '../sim/goal';

/** classifier extras: a gold ring on retained balls that match the motif, and the
 * physical GATE ARM at the mouth of the channel. The arm is a hinged push-to-open
 * gate (manual 9.8.3): closed it lies across the channel; a robot swings it open and
 * gravity swings it shut. It is drawn from the goal's live `gatePos` so it animates
 * the full lift/fall rather than snapping between two states. */
export function drawRampStrips(ctx: CanvasRenderingContext2D, world: World): void {
  for (const a of ['red', 'blue'] as Alliance[]) {
    const goal = world.goals[a];
    const stack = railStack(world, a);
    stack.slice(0, C.RAMP_SLOTS).forEach((ball, i) => {
      if (ball.color !== world.motif[i % 3]) return;
      ctx.strokeStyle = '#fbbf24';
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.arc(ball.pos.x, ball.pos.y, 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
    drawGateArm(ctx, a, goal.gatePos);
  }
}

/** the hinged gate arm. Hinge sits at the channel's inner (field-side) edge; the
 * arm reaches across the channel to the side wall when closed and swings downstream
 * (toward the audience) as it opens. */
function drawGateArm(ctx: CanvasRenderingContext2D, a: Alliance, pos: number): void {
  const g = goalSide(a);
  const hx = g * (C.FIELD_HALF - C.CLASSIFIER_W); // hinge x: inner channel edge
  const hy = C.CLASSIFIER_Y0; // hinge y: gate end of the channel
  const len = C.CLASSIFIER_W; // spans the channel to the wall
  const ang = pos * C.GATE_SWING; // closed dir = (g,0), swung toward -y as it opens
  const tx = hx + g * Math.cos(ang) * len;
  const ty = hy - Math.sin(ang) * len;

  // faint ghost of the closed position, so an open gate reads as "lifted from here"
  ctx.strokeStyle = 'rgba(148,163,184,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(hx + g * len, hy);
  ctx.stroke();

  // the arm: steel when closed, greening as it opens
  const open = Math.min(1, pos / C.GATE_PASS_FRAC);
  ctx.strokeStyle = pos >= C.GATE_PASS_FRAC ? '#22c55e' : open > 0 ? '#7d8a63' : '#64748b';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  ctx.lineCap = 'butt';

  // hinge pivot
  ctx.fillStyle = '#94a3b8';
  ctx.beginPath();
  ctx.arc(hx, hy, 1.1, 0, Math.PI * 2);
  ctx.fill();
}
