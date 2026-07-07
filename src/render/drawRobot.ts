import type { RobotState } from '../types';
import * as C from '../config';
import { turretWorldPos } from '../sim/robot';
import { hasTurret, shooterCount } from '../sim/archetype';

export function drawRobot(
  ctx: CanvasRenderingContext2D,
  r: RobotState,
  intakeOn: boolean,
): void {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const color = r.alliance === 'blue' ? C.COLORS.blue : C.COLORS.red;
  // cosmetic paint job — absent (old saves/clients) renders the classic look.
  // Alliance identity (bumper outline + chevron) is deliberately NOT painted.
  const app = r.spec.appearance ?? C.DEFAULT_APPEARANCE;

  ctx.save();
  ctx.translate(r.pos.x, r.pos.y);
  ctx.rotate(r.heading);

  // chassis
  ctx.fillStyle = app.body;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  roundRect(ctx, -hl, -hw, r.spec.length, r.spec.width, 1.6);
  ctx.fill();
  if (app.pattern !== 'none') {
    ctx.save();
    ctx.clip(); // pattern stays inside the chassis
    drawPattern(ctx, app.pattern, app.accent, hl, hw);
    ctx.restore();
    roundRect(ctx, -hl, -hw, r.spec.length, r.spec.width, 1.6); // path for the stroke
  }
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
  ctx.fillStyle = intakeOn ? 'rgba(34,197,94,0.85)' : app.accent;
  if (preset.overhang) {
    // vector / tridexer: a bar of VERTICAL compliant wheels ahead of the
    // chassis — from above they read as a row of small rectangles along the
    // wheel line at the tip (the tridexer's bar spans the full 18in front)
    ctx.fillRect(hl - 0.6, -preset.halfWidth, preset.reach + 0.6, preset.halfWidth * 2);
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
    ctx.fillStyle = app.body;
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

  // shooter on top (world orientation) — sized so nothing pokes past the
  // chassis in ANY turret direction: max reach is the distance from the
  // turret center to the nearest chassis edge. For the turretless tridexer
  // r.turretHeading IS the chassis heading (the sim locks it), so the fixed
  // shooter bank rotates with the chassis.
  const tp = turretWorldPos(r);
  const off = Math.abs(r.spec.length * C.TURRET_OFFSET_FRAC);
  const reach = Math.min(hl - off, hw) - 0.5;
  const ring = Math.min(4.4, reach);
  const ready = r.hopper.length > 0 ? '#22c55e' : '#6b7280';
  ctx.save();
  ctx.translate(tp.x, tp.y);
  ctx.rotate(r.turretHeading);
  if (shooterCount(r.spec) >= 3) {
    if (hasTurret(r.spec)) {
      // turreted tridexer: ring + three shooters in a triangle on the turret
      ctx.strokeStyle = ready;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.arc(0, 0, ring, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = app.accent;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(ring - 1, 1.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#525b6b';
      const verts = [
        [0.45 * ring, 0],
        [-0.35 * ring, 0.55 * ring],
        [-0.35 * ring, -0.55 * ring],
      ] as const;
      for (const [vx, vy] of verts) {
        ctx.fillRect(vx, vy - 0.7, reach - vx, 1.4);
        ctx.beginPath();
        ctx.arc(vx, vy, 1.0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // tridexer: three chassis-fixed barrels side by side behind the intake
      const s = C.VOLLEY_MUZZLE_SPACING;
      ctx.fillStyle = app.accent;
      ctx.fillRect(-2.8, -s - 1.6, 3.2, 2 * s + 3.2); // shooter housing
      ctx.strokeStyle = ready;
      ctx.lineWidth = 0.7;
      ctx.strokeRect(-2.8, -s - 1.6, 3.2, 2 * s + 3.2);
      ctx.fillStyle = '#525b6b';
      for (const lat of [-s, 0, s]) ctx.fillRect(0, lat - 1.0, reach, 2.0);
    }
  } else {
    ctx.strokeStyle = ready;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(0, 0, ring, 0, Math.PI * 2);
    ctx.stroke();
    // turret body + barrel
    ctx.fillStyle = app.accent;
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(ring - 1, 1.5), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#525b6b';
    ctx.fillRect(0, -1.2, reach, 2.4);
  }
  ctx.restore();
}

/** cosmetic chassis pattern, drawn clipped to the chassis in the accent color */
function drawPattern(
  ctx: CanvasRenderingContext2D,
  pattern: 'stripes' | 'diagonal',
  accent: string,
  hl: number,
  hw: number,
): void {
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.55;
  if (pattern === 'stripes') {
    // twin racing stripes running the length of the chassis
    const w = hw * 0.24;
    ctx.fillRect(-hl, -hw * 0.42 - w / 2, hl * 2, w);
    ctx.fillRect(-hl, hw * 0.42 - w / 2, hl * 2, w);
  } else {
    // diagonal hazard bands across the deck
    const step = 4.2;
    for (let x = -hl - 2 * hw; x < hl + 2 * hw; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, -hw);
      ctx.lineTo(x + 2 * hw, hw);
      ctx.lineTo(x + 2 * hw + step * 0.4, hw);
      ctx.lineTo(x + step * 0.4, -hw);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
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
