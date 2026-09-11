import type { Vec2, World } from '../../types';
import * as C from '../../config';
import { BB_HALF_X, BB_HALF_Y } from './config';

/**
 * BIOBUZZ field renderer — THE MAT, THE TILE GRID, THE PERIMETER, AND A CENTRE MARK.
 *
 * That is the whole field, and it is the whole field because Section 9 (ARENA) of the V0
 * pre-season manual is one page saying it lands at Kickoff. There are no zones, no goals, no
 * tape lines and no structures to draw, and drawing invented ones would produce the single
 * worst outcome available here: a field that LOOKS finished. Someone would open the gallery,
 * see a complete-looking arena, and build against geometry that came from nowhere.
 *
 * So the shell draws exactly what is known and marks the centre so the frame is legible —
 * which is what makes a robot's position, heading and scale readable in a still, and a still
 * is how this game gets reviewed before Kickoff.
 *
 * THEMING: colours come from the shared `C.COLORS` (the `--ds-on-field*` token family), never
 * from literals, so the field reads correctly in both themes. `screenUp` is the camera's up
 * axis in WORLD space — it is what anything with apparent height would be offset along, and
 * it is accepted here (unused) because the signature is the shared `drawField` slot's and a
 * field that grows a raised structure should not change shape to get it.
 */
export function drawBiobuzzField(
  ctx: CanvasRenderingContext2D,
  _world: World,
  screenUp: Vec2 = { x: 0, y: 1 },
): void {
  void screenUp; // nothing is raised off the tile yet — see the note above
  const hx = BB_HALF_X;
  const hy = BB_HALF_Y;

  // MAT — the soft tile floor.
  ctx.fillStyle = C.COLORS.mat;
  ctx.fillRect(-hx, -hy, 2 * hx, 2 * hy);

  // TILE GRID — every 24" tile. Not decoration: the tile grid is how a driver judges
  // distance on an FTC field, and it is the only scale reference an empty field has.
  ctx.strokeStyle = C.COLORS.tile;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let x = -hx; x <= hx + 0.01; x += C.TILE) {
    ctx.moveTo(x, -hy);
    ctx.lineTo(x, hy);
  }
  for (let y = -hy; y <= hy + 0.01; y += C.TILE) {
    ctx.moveTo(-hx, y);
    ctx.lineTo(hx, y);
  }
  ctx.stroke();

  // CENTRE MARK — a small cross at the origin. The tile grid alone has a LINE through the
  // centre of the field (144" is six 24" tiles, so x=0 and y=0 are both grid lines), which
  // means "the middle" is a crossing indistinguishable from five others. The mark is what
  // makes a still self-orienting: it says where the origin is, so a reviewer can tell whether
  // a scatter is centred and whether a robot's pose is where the scene claims.
  const MARK = 4;
  ctx.strokeStyle = C.COLORS.white;
  ctx.lineWidth = C.TAPE_W;
  ctx.beginPath();
  ctx.moveTo(-MARK, 0);
  ctx.lineTo(MARK, 0);
  ctx.moveTo(0, -MARK);
  ctx.lineTo(0, MARK);
  ctx.stroke();

  // PERIMETER — drawn last, so it sits over the grid lines that run into it.
  ctx.strokeStyle = C.COLORS.white;
  ctx.lineWidth = C.TAPE_W;
  ctx.strokeRect(-hx, -hy, 2 * hx, 2 * hy);
}
