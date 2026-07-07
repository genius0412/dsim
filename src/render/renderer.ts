import type { RobotCommand, World, AutoPathData, PathPoint, PathLine, Vec2 } from '../types';
import { Camera } from './camera';
import { drawField } from './drawField';
import { drawBalls } from './drawBalls';
import { drawRobot } from './drawRobot';
import { drawRampStrips } from './drawGoals';
import { linearPoint, quadraticBezierPoint, cubicBezierPoint, dcos, dsin } from '../math';

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

    for (const r of world.robots) {
      // Draw auto paths if active for this robot
      if (r.autoPathActive && r.autoPath) {
        this.drawAutoPath(ctx, r);
      }

      const intakeOn =
        (r.id === localRobotId && (lastCommand?.intake ?? false)) ||
        (r.autoIntake && r.hopper.length < 3);
      drawRobot(ctx, r, intakeOn);

      // Draw robot's pathing state (target point, heading)
      if (r.id === localRobotId && r.autoPathActive) {
        this.drawRobotPathState(ctx, r);
      }
    }
    const screenUp = this.camera.screenUpWorld();
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

  private drawAutoPath(ctx: CanvasRenderingContext2D, robot: RobotState): void {
    const autoPath = robot.autoPath!; // We already checked for existence
    const alliance = robot.alliance;

    ctx.save();
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = alliance === 'red' ? 'rgba(200, 50, 50, 0.7)' : 'rgba(50, 50, 200, 0.7)'; // Desaturated alliance color
    ctx.fillStyle = alliance === 'red' ? 'rgba(200, 50, 50, 0.5)' : 'rgba(50, 50, 200, 0.5)'; // Desaturated alliance color

    // Draw start point
    ctx.beginPath();
    ctx.arc(autoPath.startPoint.x, autoPath.startPoint.y, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Draw path lines
    let currentPoint: PathPoint = autoPath.startPoint;
    for (const line of autoPath.lines) {
      ctx.beginPath();
      ctx.moveTo(currentPoint.x, currentPoint.y);

      if (line.controlPoints && line.controlPoints.length > 0) {
        if (line.controlPoints.length === 1) {
          // Quadratic Bezier
          ctx.quadraticCurveTo(
            line.controlPoints[0].x,
            line.controlPoints[0].y,
            line.endPoint.x,
            line.endPoint.y,
          );
        } else if (line.controlPoints.length === 2) {
          // Cubic Bezier
          ctx.bezierCurveTo(
            line.controlPoints[0].x,
            line.controlPoints[0].y,
            line.controlPoints[1].x,
            line.controlPoints[1].y,
            line.endPoint.x,
            line.endPoint.y,
          );
        }
      } else {
        // Linear
        ctx.lineTo(line.endPoint.x, line.endPoint.y);
      }
      ctx.stroke();

      // Draw control points
      if (line.controlPoints) {
        ctx.fillStyle = 'rgba(180, 180, 180, 0.7)'; // Light grey for control points
        for (const cp of line.controlPoints) {
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Draw end point of segment
      ctx.beginPath();
      ctx.arc(line.endPoint.x, line.endPoint.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      currentPoint = line.endPoint;
    }
    ctx.restore();
  }

  private drawRobotPathState(ctx: CanvasRenderingContext2D, robot: RobotState): void {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'lime'; // Green for target visuals
    ctx.fillStyle = 'lime';

    // Draw target point
    if (robot.pathTargetPoint) {
      ctx.beginPath();
      ctx.arc(robot.pathTargetPoint.x, robot.pathTargetPoint.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Draw line from robot to target point
      ctx.beginPath();
      ctx.moveTo(robot.pos.x, robot.pos.y);
      ctx.lineTo(robot.pathTargetPoint.x, robot.pathTargetPoint.y);
      ctx.stroke();
    }

    // Draw target heading
    if (robot.pathTargetHeading !== null) {
      const arrowLength = 10;
      const arrowX = robot.pos.x + dcos(robot.pathTargetHeading) * arrowLength;
      const arrowY = robot.pos.y + dsin(robot.pathTargetHeading) * arrowLength;

      ctx.beginPath();
      ctx.moveTo(robot.pos.x, robot.pos.y);
      ctx.lineTo(arrowX, arrowY);
      ctx.stroke();

      // Draw arrow head
      ctx.beginPath();
      ctx.moveTo(arrowX, arrowY);
      ctx.lineTo(arrowX - dcos(robot.pathTargetHeading - Math.PI / 6) * 3, arrowY - dsin(robot.pathTargetHeading - Math.PI / 6) * 3);
      ctx.moveTo(arrowX, arrowY);
      ctx.lineTo(arrowX - dcos(robot.pathTargetHeading + Math.PI / 6) * 3, arrowY - dsin(robot.pathTargetHeading + Math.PI / 6) * 3);
      ctx.stroke();
    }
    ctx.restore();
  }
}