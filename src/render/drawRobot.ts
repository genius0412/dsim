import type { RobotState } from '../types';
import * as C from '../config';
import { turretWorldPos } from '../sim/robot';

export function drawRobot(
  ctx: CanvasRenderingContext2D,
  r: RobotState,
  intakeOn: boolean,
): void {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const color = r.alliance === 'blue' ? C.COLORS.blue : C.COLORS.red;

  ctx.save();
  ctx.translate(r.pos.x, r.pos.y);
  ctx.rotate(r.heading);

  // chassis
  ctx.fillStyle = '#1f242c';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  roundRect(ctx, -hl, -hw, r.spec.length, r.spec.width, 1.6);
  ctx.fill();
  ctx.stroke();

  // wheels (mecanum pods) — INSIDE the frame, centered on the ground-contact
  // points that base parking scores (WHEEL_INSET from the chassis edges)
  ctx.fillStyle = '#111318';
  const wx = Math.max(hl - C.WHEEL_INSET, 1);
  const wy = Math.max(hw - C.WHEEL_INSET, 1);
  for (const [px, py] of [
    [wx, wy],
    [wx, -wy],
    [-wx, wy],
    [-wx, -wy],
  ] as const) {
    ctx.fillRect(px - 2.2, py - 1.1, 4.4, 2.2);
  }

  // intake at the front — drawn at its full physical reach (it collides)
  const preset = C.INTAKE_PRESETS[r.spec.intake];
  const tip = hl + preset.reach;
  ctx.fillStyle = intakeOn ? 'rgba(34,197,94,0.85)' : '#3a4150';
  if (r.spec.intake === 'vector') {
    ctx.fillRect(hl - 0.6, -preset.halfWidth, preset.reach + 0.6, preset.halfWidth * 2);
    // compliant wheels are mounted VERTICALLY: from above they read as a
    // row of small rectangles along the wheel line at the tip
    ctx.fillStyle = intakeOn ? '#16a34a' : '#2a303c';
    for (let i = -3; i <= 3; i++) {
      ctx.fillRect(tip - 2.2, i * (preset.halfWidth / 3.4) - 0.8, 1.8, 1.6);
    }
  } else {
    // sloped / triangle: trapezoid mouth — wide opening at the tip narrowing
    // into the throat, truncated (no point), recessed within the frame. The
    // mouth never exceeds the chassis: the frame's side prongs encompass it,
    // which is what physically rules out side intake for these presets.
    const mouthHalf = Math.min(preset.halfWidth, hw - 0.75);
    const throat = mouthHalf * 0.45;
    ctx.beginPath();
    ctx.moveTo(tip, -mouthHalf);
    ctx.lineTo(tip, mouthHalf);
    ctx.lineTo(hl - 0.6, throat);
    ctx.lineTo(hl - 0.6, -throat);
    ctx.closePath();
    ctx.fill();
    // chassis side prongs alongside the mouth
    ctx.fillStyle = '#1f242c';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    for (const s of [1, -1] as const) {
      const y0 = s > 0 ? mouthHalf + 0.3 : -hw;
      const h = hw - mouthHalf - 0.3;
      if (h <= 0) continue;
      ctx.fillRect(hl - 0.6, y0, preset.reach + 0.6, h);
      ctx.strokeRect(hl - 0.6, y0, preset.reach + 0.6, h);
    }
  }

  // heading chevron
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(hl - 2.4, 0);
  ctx.lineTo(hl - 5.4, 2.2);
  ctx.lineTo(hl - 5.4, -2.2);
  ctx.closePath();
  ctx.fill();

  // hopper pips (held artifacts) — the TRIANGLE intake stores its artifacts
  // in a triangle; the others queue them in a line
  for (let i = 0; i < C.HOPPER_CAPACITY; i++) {
    const c = r.hopper[i];
    ctx.fillStyle = c ? (c === 'purple' ? C.COLORS.purple : C.COLORS.green) : '#101216';
    const [px, py] =
      r.spec.intake === 'triangle'
        ? i === 2
          ? [-hl + 6.8, 0]
          : [-hl + 3, i === 0 ? -2.2 : 2.2]
        : [-hl + 3.4, (i - 1) * 4];
    ctx.beginPath();
    ctx.arc(px, py, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // turret on top (world orientation) — sized so nothing pokes past the
  // chassis in ANY turret direction: max reach is the distance from the
  // turret center to the nearest chassis edge
  const tp = turretWorldPos(r);
  const off = Math.abs(r.spec.length * C.TURRET_OFFSET_FRAC);
  const reach = Math.min(hl - off, hw) - 0.5;
  const ring = Math.min(4.4, reach);
  ctx.save();
  ctx.translate(tp.x, tp.y);
  ctx.rotate(r.turretHeading);
  ctx.strokeStyle = r.hopper.length > 0 ? '#22c55e' : '#6b7280';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.arc(0, 0, ring, 0, Math.PI * 2);
  ctx.stroke();
  // turret body + barrel
  ctx.fillStyle = '#3a4150';
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(ring - 1, 1.5), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#525b6b';
  ctx.fillRect(0, -1.2, reach, 2.4);
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
