import type { RobotState } from '../types';
import * as C from '../config';
import { goalCenter } from '../sim/field';
import { turretWorldPos } from '../sim/robot';

export function drawRobot(
  ctx: CanvasRenderingContext2D,
  r: RobotState,
  intakeOn: boolean,
): void {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const color = r.alliance === 'blue' ? C.COLORS.blue : C.COLORS.red;

  // aim ray
  if (r.aimAssist) {
    const tp = turretWorldPos(r);
    const g = goalCenter(r.alliance);
    ctx.strokeStyle = 'rgba(229,231,235,0.12)';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(tp.x, tp.y);
    ctx.lineTo(g.x, g.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.save();
  ctx.translate(r.pos.x, r.pos.y);
  ctx.rotate(r.heading);

  // wheels (mecanum pods)
  ctx.fillStyle = '#111318';
  const wx = hl - 3.2;
  const wy = hw - 0.6;
  for (const [px, py] of [
    [wx, wy],
    [wx, -wy - 2.2],
    [-wx - 4.4, wy],
    [-wx - 4.4, -wy - 2.2],
  ] as const) {
    ctx.fillRect(px - 0, py, 4.4, 2.2);
  }

  // chassis
  ctx.fillStyle = '#1f242c';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  roundRect(ctx, -hl, -hw, r.spec.length, r.spec.width, 1.6);
  ctx.fill();
  ctx.stroke();

  // intake bar at the front
  const preset = C.INTAKE_PRESETS[r.spec.intake];
  const reach = r.spec.intake === 'extended' ? preset.reach - 1.5 : 1.2;
  ctx.fillStyle = intakeOn ? 'rgba(34,197,94,0.85)' : '#3a4150';
  ctx.fillRect(hl - 0.6, -preset.halfWidth, reach + 1.2, preset.halfWidth * 2);

  // heading chevron
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(hl - 2.4, 0);
  ctx.lineTo(hl - 5.4, 2.2);
  ctx.lineTo(hl - 5.4, -2.2);
  ctx.closePath();
  ctx.fill();

  // hopper pips (held artifacts)
  for (let i = 0; i < C.HOPPER_CAPACITY; i++) {
    const c = r.hopper[i];
    ctx.fillStyle = c ? (c === 'purple' ? C.COLORS.purple : C.COLORS.green) : '#101216';
    ctx.beginPath();
    ctx.arc(-hl + 3.4, (i - 1) * 4, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // turret on top (world orientation)
  const tp = turretWorldPos(r);
  ctx.save();
  ctx.translate(tp.x, tp.y);
  ctx.rotate(r.turretHeading);
  ctx.strokeStyle = r.hopper.length > 0 ? '#22c55e' : '#6b7280';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.arc(0, 0, 4.4, 0, Math.PI * 2);
  ctx.stroke();
  // turret body + barrel
  ctx.fillStyle = '#3a4150';
  ctx.beginPath();
  ctx.arc(0, 0, 3.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#525b6b';
  ctx.fillRect(0, -1.2, 7, 2.4);
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
