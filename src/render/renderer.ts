import type { RobotCommand, World } from '../types';
import { Camera } from './camera';
import { drawField } from './drawField';
import { drawBalls } from './drawBalls';
import { drawRobot } from './drawRobot';
import { drawRampStrips } from './drawGoals';

export class Renderer {
  readonly camera = new Camera();

  render(
    ctx: CanvasRenderingContext2D,
    world: World,
    lastCommand: RobotCommand | null,
    localRobotId = 0,
  ): void {
    const canvas = ctx.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#14161a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    this.camera.apply(ctx);
    drawField(ctx, world);
    drawRampStrips(ctx, world);
    const screenUp = this.camera.screenUpWorld();
    for (const r of world.robots) {
      const intakeOn =
        (r.id === localRobotId && (lastCommand?.intake ?? false)) ||
        (r.autoIntake && r.hopper.length < 3);
      drawRobot(ctx, r, intakeOn);
    }
    drawBalls(ctx, world, screenUp);

    // name/team labels above the OTHER robots (the local driver knows theirs)
    if (world.robots.length > 1) {
      for (const r of world.robots) {
        if (r.id === localRobotId) continue;
        ctx.save();
        ctx.translate(r.pos.x, r.pos.y);
        // undo the camera rotation + y-flip so the text reads upright
        ctx.rotate(-this.camera.viewAngle);
        ctx.scale(1, -1);
        ctx.font = '600 4px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(229,231,235,0.75)';
        const label = r.spec.teamNumber > 0 ? `${r.spec.teamNumber} ${r.spec.name}` : r.spec.name;
        ctx.fillText(label, 0, -14);
        ctx.restore();
      }
    }
  }
}
