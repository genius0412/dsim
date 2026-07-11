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

/** the gate LEVER (manual Figure 9-15). It is a class-1 lever hinged at the CLASSIFIER
 * EDGE, where the gate-zone tape starts: a SHORT handle pokes OUT into the gate zone
 * (what a robot pushes), and a LONG paddle lies ACROSS the channel to the WALL edge,
 * COVERING the artifacts. Pushed, the lever SWINGS UP out of plane — shown top-down by
 * FORESHORTENING each arm toward the pivot (proj shrinks, uncovering the channel) plus a
 * faint ghost of the long paddle's closed reach so the lift reads. */
function drawGateArm(ctx: CanvasRenderingContext2D, a: Alliance, pos: number): void {
  const g = goalSide(a);
  const px = g * (C.FIELD_HALF - C.CLASSIFIER_W); // pivot x: the classifier edge (gate-tape start)
  const py = C.GATE_TAPE_Y; // centered between the two gate-zone tape lines
  const toWall = g; // long paddle reaches ACROSS the channel toward the wall
  const toField = -g; // short handle pokes OUT into the field (gate-zone side)
  const cos = Math.cos(pos * C.GATE_LIFT); // foreshortens as it lifts
  const longProj = C.GATE_ARM_LONG * cos;
  const shortProj = C.GATE_ARM_SHORT * cos;

  // faint ghost of the long paddle's closed (fully-covering) reach to the wall
  ctx.strokeStyle = 'rgba(148,163,184,0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + toWall * C.GATE_ARM_LONG, py);
  ctx.stroke();

  // the LONG paddle over the channel: steel when down/covering, greening as it lifts clear
  ctx.strokeStyle = pos >= C.GATE_PASS_FRAC ? '#22c55e' : '#8896a8';
  ctx.lineWidth = 2.0;
  ctx.lineCap = 'square';
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + toWall * longProj, py);
  ctx.stroke();

  // the SHORT handle poking into the field (always steel — the pushable stub)
  ctx.strokeStyle = '#8896a8';
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + toField * shortProj, py);
  ctx.stroke();
  ctx.lineCap = 'butt';

  // pivot at the classifier's field-side edge
  ctx.fillStyle = '#94a3b8';
  ctx.beginPath();
  ctx.arc(px, py, 1.1, 0, Math.PI * 2);
  ctx.fill();
}
