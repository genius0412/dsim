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
        (lastCommand?.intake ?? false) || (r.autoIntake && r.hopper.length < 3);
      drawRobot(ctx, r, intakeOn);
    }
    drawBalls(ctx, world, screenUp);
  }
}
