import type { Artifact, RobotState } from '../../types';
import * as C from '../../config';
import { drawWheels, roundRect } from '../../render/drawRobot';
import {
  CHAIN_INTAKES,
  CHAIN_DEFAULT_INTAKE,
  CHAIN_DEFAULT_SCORE_MODE,
  chainHopperCap,
  CHAIN_DRUM_MAX,
  CHAIN_LAUNCH_LINE_FRAC,
} from './config';

/**
 * Chain Reaction robot sprite (top-down). Shares the chassis + drivetrain wheels with
 * DECODE (drawWheels/roundRect) but draws the CR-specific mechanisms so the build reads
 * at a glance: the INTAKE DESIGN at the front (roller / funnel / sweeper) and the SCORING
 * ARCHETYPE launcher (turret on top · chassis-wide drum · chassis-wide catapult). A slim
 * hopper-fill bar shows how full it is. Front = robot +x (heading).
 */
const GREEN = '#22c55e';
const GREEN_DK = '#166534';
const STEEL = '#3a4150';
const STEEL_DK = '#2a3140';
const IDLE = '#4b5563';


export function drawChainRobot(
  ctx: CanvasRenderingContext2D,
  r: RobotState,
  intakeOn: boolean,
  _held: Artifact[] = [],
): void {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const color = r.alliance === 'blue' ? C.COLORS.blue : C.COLORS.red;
  const loaded = r.hopper.length > 0;
  const mode = r.spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE;

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

  drawWheels(ctx, r, color);

  drawChainIntake(ctx, r, intakeOn, hl, hw);

  // scoring-archetype launcher (chassis-fixed part). Drum + catapult sit just inside the
  // front; the turret is drawn last, in the world frame, so it rotates independently.
  if (mode === 'drum') drawDrum(ctx, hl, hw, loaded);
  else if (mode === 'dumper') drawCatapult(ctx, hl, hw, loaded);

  drawHopperFill(ctx, r, hw);

  // heading chevron (near the rear so it doesn't fight the front mechanisms)
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-hl + 4.6, 0);
  ctx.lineTo(-hl + 1.8, 1.9);
  ctx.lineTo(-hl + 1.8, -1.9);
  ctx.closePath();
  ctx.fill();

  ctx.restore();

  if (mode === 'turret') drawTurret(ctx, r, loaded);
}

/** CR intake at the front, styled by design: roller = full-width bar, sweeper = wider
 * (overhangs the frame), funnel = two wedges into a narrow center throat. */
function drawChainIntake(
  ctx: CanvasRenderingContext2D,
  r: RobotState,
  on: boolean,
  hl: number,
  hw: number,
): void {
  const it = CHAIN_INTAKES[r.spec.chainIntake ?? CHAIN_DEFAULT_INTAKE];
  const half = hw * it.widthFrac + it.overhang;
  const x0 = hl; // chassis front edge
  const x1 = hl + Math.min(it.reach, 4); // roller sits just ahead (visual cap)
  const barFill = on ? GREEN_DK : '#333a45';
  const tickFill = on ? GREEN : '#6b7280';

  const rollerTicks = (h: number): void => {
    const n = Math.max(2, Math.round(h / 2.4));
    for (let i = -n; i <= n; i++) {
      ctx.fillStyle = tickFill;
      ctx.fillRect(x1 - 1.2, (i * h) / (n + 0.5) - 0.65, 1.1, 1.3);
    }
  };

  if (r.spec.chainIntake === 'funnel') {
    // two side wedges funnel to a narrow throat + a small roller at the tip
    ctx.fillStyle = on ? 'rgba(34,197,94,0.45)' : '#2a303c';
    ctx.beginPath();
    ctx.moveTo(x0, -hw);
    ctx.lineTo(x0, hw);
    ctx.lineTo(x1, half);
    ctx.lineTo(x1, -half);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = barFill;
    ctx.fillRect(x1 - 1.4, -half, 1.4, half * 2);
    rollerTicks(half);
  } else {
    // roller / sweeper: a full-width bar (sweeper overhangs the frame sides)
    ctx.fillStyle = barFill;
    ctx.fillRect(x0, -half, x1 - x0, half * 2);
    rollerTicks(half);
  }
}

/** chassis-wide flywheel DRUM: a thick rounded cylinder across the launch-line width,
 * just inside the front, with the drum's slot divisions. Greens when loaded. */
function drawDrum(ctx: CanvasRenderingContext2D, hl: number, hw: number, loaded: boolean): void {
  const half = hw * CHAIN_LAUNCH_LINE_FRAC;
  const th = 3.4; // drum thickness (along x)
  const cx = hl - th - 0.6;
  ctx.fillStyle = STEEL_DK;
  ctx.strokeStyle = loaded ? GREEN : IDLE;
  ctx.lineWidth = 0.7;
  roundRect(ctx, cx - th / 2, -half, th, half * 2, 1.2);
  ctx.fill();
  ctx.stroke();
  // drum slot divisions (the 6 pockets)
  ctx.strokeStyle = loaded ? 'rgba(34,197,94,0.7)' : 'rgba(150,163,180,0.5)';
  ctx.lineWidth = 0.5;
  for (let i = 1; i < CHAIN_DRUM_MAX; i++) {
    const y = -half + (i * (half * 2)) / CHAIN_DRUM_MAX;
    ctx.beginPath();
    ctx.moveTo(cx - th / 2, y);
    ctx.lineTo(cx + th / 2, y);
    ctx.stroke();
  }
}

/** chassis-wide CATAPULT: a wide bucket/paddle across the front the whole hopper is
 * flung from. Reads as a curved throwing lip. Greens when loaded. */
function drawCatapult(ctx: CanvasRenderingContext2D, hl: number, hw: number, loaded: boolean): void {
  const half = hw * CHAIN_LAUNCH_LINE_FRAC;
  const back = hl - 6; // bucket floor
  const lip = hl - 1; // throwing lip near the front
  ctx.fillStyle = STEEL_DK;
  ctx.strokeStyle = loaded ? GREEN : IDLE;
  ctx.lineWidth = 0.8;
  // bucket: a wide trapezoid opening toward the front, with a raised lip
  ctx.beginPath();
  ctx.moveTo(back, -half * 0.7);
  ctx.lineTo(lip, -half);
  ctx.lineTo(lip, half);
  ctx.lineTo(back, half * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // throwing lip
  ctx.strokeStyle = loaded ? GREEN : STEEL;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(lip, -half);
  ctx.lineTo(lip, half);
  ctx.stroke();
}

/** turret on top (world orientation), ring + barrel toward the aim heading. */
function drawTurret(ctx: CanvasRenderingContext2D, r: RobotState, loaded: boolean): void {
  const hl = r.spec.length / 2;
  const hw = r.spec.width / 2;
  const off = Math.abs(r.spec.length * C.TURRET_OFFSET_FRAC);
  const reach = Math.min(hl - off, hw) - 0.5;
  const ring = Math.min(4.4, reach);
  // turret sits at the chassis center offset (rear of center), in the robot frame
  const localX = -off;
  const cx = r.pos.x + Math.cos(r.heading) * localX;
  const cy = r.pos.y + Math.sin(r.heading) * localX;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(r.turretHeading);
  ctx.strokeStyle = loaded ? GREEN : '#6b7280';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.arc(0, 0, ring, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = STEEL;
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(ring - 1, 1.5), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#525b6b';
  ctx.fillRect(0, -1.2, reach, 2.4);
  ctx.restore();
}

/** a slim hopper-fill bar (stored particles ÷ capacity) near the rear of the chassis. */
function drawHopperFill(ctx: CanvasRenderingContext2D, r: RobotState, hw: number): void {
  const cap = chainHopperCap(r.spec);
  const frac = Math.max(0, Math.min(1, r.hopper.length / cap));
  const w = hw * 1.1; // bar width
  const x = -w / 2;
  const y = hw - 2.6;
  ctx.fillStyle = 'rgba(10,14,20,0.75)';
  roundRect(ctx, x, y, w, 1.7, 0.6);
  ctx.fill();
  if (frac > 0) {
    ctx.fillStyle = GREEN;
    roundRect(ctx, x, y, Math.max(0.8, w * frac), 1.7, 0.6);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(150,163,180,0.5)';
  ctx.lineWidth = 0.35;
  roundRect(ctx, x, y, w, 1.7, 0.6);
  ctx.stroke();
}
