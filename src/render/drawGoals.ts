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

/** the gate LEVER (manual Figure 9-15). It pivots at the classifier face and its paddle
 * sticks OUT toward the field (the gate-zone side), centered between the two gate-zone
 * tape lines. Closed (by gravity) it lies out at full reach; pushed, it SWINGS UP out of
 * the plane — shown top-down by FORESHORTENING the paddle toward the pivot (proj shrinks)
 * plus a faint ghost of the closed reach so the lift reads. */
function drawGateArm(ctx: CanvasRenderingContext2D, a: Alliance, pos: number): void {
  const g = goalSide(a);
  const px = g * (C.FIELD_HALF - C.CLASSIFIER_W); // pivot x: classifier face
  const py = C.GATE_TAPE_Y; // centered between the two gate-zone tape lines
  const dir = -g; // points OUT of the classifier into the field (toward smaller |x|)
  const proj = C.GATE_ARM_LEN * Math.cos(pos * C.GATE_LIFT); // foreshortens as it lifts

  // faint ghost of the closed (fully-extended, blocking) reach
  ctx.strokeStyle = 'rgba(148,163,184,0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + dir * C.GATE_ARM_LEN, py);
  ctx.stroke();

  // the paddle: steel when down/closed, greening as it swings up open
  ctx.strokeStyle = pos >= C.GATE_PASS_FRAC ? '#22c55e' : '#8896a8';
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + dir * proj, py);
  ctx.stroke();
  ctx.lineCap = 'butt';

  // pivot at the classifier face
  ctx.fillStyle = '#94a3b8';
  ctx.beginPath();
  ctx.arc(px, py, 1.1, 0, Math.PI * 2);
  ctx.fill();
}
