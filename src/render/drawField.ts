import type { Alliance, World } from '../types';
import * as C from '../config';
import {
  baseZone,
  classifierRect,
  gateTapeSegments,
  goalTriangle,
  launchSegments,
  loadZone,
  driverSide,
  tunnelStrip,
  type Rect,
} from '../sim/field';
// (gateZone itself is the invisible interaction rect — intentionally not drawn)

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

  for (const a of ['red', 'blue'] as Alliance[]) {
    // base zone (alliance tape, translucent fill)
    const bz = baseZone(a);
    fillRect(ctx, bz, allianceColor(a, true));
    strokeRect(ctx, bz, allianceColor(a));

    // loading zone (white tape corner)
    const lz = loadZone(a);
    fillRect(ctx, lz, 'rgba(229,231,235,0.05)');
    strokeRect(ctx, lz, C.COLORS.white);

    // SECRET TUNNEL floor strip beneath the OTHER alliance's classifier —
    // it belongs to THIS alliance (its drive team is on that wall), bounded
    // by alliance-colored tape
    const ts = tunnelStrip(other(a));
    fillRect(ctx, ts, allianceColor(a, true));
    strokeRect(ctx, ts, allianceColor(a));

    // classifier ramp structure (robot obstacle) next to this alliance's goal
    // — a neutral gray STRUCTURE, not an alliance tape line
    const cr = classifierRect(a);
    fillRect(ctx, cr, '#191d24');
    strokeRect(ctx, cr, C.COLORS.wall);

    // GATE ZONE marking: two parallel alliance-colored tape lines, 10in long,
    // 2.75in apart (the larger invisible interaction rect works the gate)
    ctx.strokeStyle = allianceColor(a);
    ctx.lineWidth = C.TAPE_W;
    for (const [p0, p1] of gateTapeSegments(a)) {
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }

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

    // goal structure in the far corner (full 26.5x18.3 corner triangle)
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

  // white launch-line tape (incl. the DEPOT lines flush on each goal face) —
  // drawn LAST so the goal outline never covers the depot tape
  ctx.strokeStyle = C.COLORS.white;
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  for (const [a, b] of launchSegments()) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';

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
