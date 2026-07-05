import type { Alliance, World } from '../types';
import * as C from '../config';
import { railPos } from '../sim/field';
import { railStack } from '../sim/goal';

/** classifier extras: a gold ring on retained balls that match the motif,
 * and the gate bar at the bottom of the channel */
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
    // gate bar at the low end of the channel
    const gatePos = railPos(a, 0);
    ctx.fillStyle = goal.gateOpen ? '#22c55e' : '#4b5563';
    ctx.fillRect(gatePos.x - 3, C.CLASSIFIER_Y0 - 1.8, 6, 1.5);
  }
}
