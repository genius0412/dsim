import type { Alliance, World } from '../types';
import * as C from '../config';
import {
  baseZone,
  classifierRect,
  gateZone,
  goalTriangle,
  launchSegments,
  loadZone,
  driverSide,
  tunnelStrip,
  type Rect,
} from '../sim/field';

const F = C.FIELD_HALF;

function allianceColor(a: Alliance, dim = false): string {
  if (dim) return a === 'blue' ? C.COLORS.blueDim : C.COLORS.redDim;
  return a === 'blue' ? C.COLORS.blue : C.COLORS.red;
}

function other(a: Alliance): Alliance {
  return a === 'blue' ? 'red' : 'blue';
}

function fillRect(ctx: CanvasRenderingContext2D, r: Rect, fill: string): void {
  ctx.fillStyle = fill;
  ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
}

function strokeRect(ctx: CanvasRenderingContext2D, r: Rect, stroke: string): void {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = C.TAPE_W;
  ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
}

export function drawField(ctx: CanvasRenderingContext2D, world: World): void {
  // mat + tiles
  ctx.fillStyle = C.COLORS.mat;
  ctx.fillRect(-F, -F, 2 * F, 2 * F);
  ctx.strokeStyle = C.COLORS.tile;
  ctx.lineWidth = 0.6;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(i * C.TILE, -F);
    ctx.lineTo(i * C.TILE, F);
    ctx.moveTo(-F, i * C.TILE);
    ctx.lineTo(F, i * C.TILE);
    ctx.stroke();
  }

  // alliance station bands outside the side walls (red = left, blue = right)
  ctx.fillStyle = C.COLORS.redDim;
  ctx.fillRect(-F - 7, -F, 5, 2 * F);
  ctx.fillStyle = 'rgba(239,68,68,0.55)';
  ctx.fillRect(-F - 4.4, -F, 2.4, 2 * F);
  ctx.fillStyle = C.COLORS.blueDim;
  ctx.fillRect(F + 2, -F, 5, 2 * F);
  ctx.fillStyle = 'rgba(59,130,246,0.55)';
  ctx.fillRect(F + 2, -F, 2.4, 2 * F);

  // shared launch zones (large far triangle + audience triangle)
  ctx.fillStyle = C.COLORS.launchTint;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-F, F);
  ctx.lineTo(F, F);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, -C.AUD_ZONE_APEX_Y);
  ctx.lineTo(-C.AUD_ZONE_HALF_W, -F);
  ctx.lineTo(C.AUD_ZONE_HALF_W, -F);
  ctx.closePath();
  ctx.fill();

  // white launch-line tape (incl. depot lines near the goals)
  ctx.strokeStyle = C.COLORS.white;
  ctx.lineWidth = C.TAPE_W;
  for (const [a, b] of launchSegments()) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (const a of ['red', 'blue'] as Alliance[]) {
    // base zone (alliance tape, translucent fill)
    const bz = baseZone(a);
    fillRect(ctx, bz, allianceColor(a, true));
    strokeRect(ctx, bz, allianceColor(a));

    // loading zone (white tape corner)
    const lz = loadZone(a);
    fillRect(ctx, lz, 'rgba(229,231,235,0.05)');
    strokeRect(ctx, lz, C.COLORS.white);

    // secret tunnel floor strip beneath the OTHER alliance's classifier
    fillRect(ctx, tunnelStrip(other(a)), allianceColor(a, true));

    // classifier ramp structure (robot obstacle) next to this alliance's goal
    const cr = classifierRect(a);
    fillRect(ctx, cr, '#191d24');
    strokeRect(ctx, cr, allianceColor(a));

    // gate zone tape
    const gz = gateZone(a);
    fillRect(ctx, gz, allianceColor(a, true));
    strokeRect(ctx, gz, allianceColor(a));

    // spike marks: 10in horizontal white tape rows on the drive-team side
    const d = driverSide(a);
    ctx.strokeStyle = C.COLORS.white;
    ctx.lineWidth = C.TAPE_W;
    for (const y of C.SPIKE_ROW_YS) {
      const cx = d * C.SPIKE_COL_X;
      ctx.beginPath();
      ctx.moveTo(cx - C.SPIKE_MARK_LEN / 2, y);
      ctx.lineTo(cx + C.SPIKE_MARK_LEN / 2, y);
      ctx.stroke();
    }

    // goal structure in the far corner
    const tri = goalTriangle(a);
    ctx.fillStyle = a === 'blue' ? '#14235a' : '#4f1414';
    ctx.beginPath();
    ctx.moveTo(tri[0].x, tri[0].y);
    ctx.lineTo(tri[1].x, tri[1].y);
    ctx.lineTo(tri[2].x, tri[2].y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = allianceColor(a);
    ctx.lineWidth = 1.4;
    ctx.stroke();

  }

  // field perimeter
  ctx.strokeStyle = C.COLORS.wall;
  ctx.lineWidth = 2;
  ctx.strokeRect(-F - 1, -F - 1, 2 * F + 2, 2 * F + 2);

  // obelisk (outside the far wall, centered) with the motif
  ctx.save();
  ctx.translate(0, F + 8);
  ctx.fillStyle = '#30343c';
  ctx.beginPath();
  ctx.moveTo(0, 5.5);
  ctx.lineTo(-5.5, -3.5);
  ctx.lineTo(5.5, -3.5);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = C.COLORS.wall;
  ctx.lineWidth = 0.7;
  ctx.stroke();
  world.motif.forEach((color, i) => {
    ctx.fillStyle = color === 'purple' ? C.COLORS.purple : C.COLORS.green;
    ctx.beginPath();
    ctx.arc((i - 1) * 3.4, -1, 1.3, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}
