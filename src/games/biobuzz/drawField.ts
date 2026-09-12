import type { Alliance, Vec2, World } from '../../types';
import * as C from '../../config';
import {
  BB_FLOWERS,
  BB_FLOWER_FOOT_R,
  BB_FLOWER_OPEN_R,
  BB_FRAME_BAR,
  BB_FRAME_X,
  BB_FRAME_Y,
  BB_GARDEN,
  BB_HALF_X,
  BB_HALF_Y,
  BB_HIVE_CELL_DY,
  BB_HIVE_LEN,
  BB_HIVE_TAGS,
  BB_HIVE_UP_STAGED,
  BB_HIVE_W,
  BB_HIVE_X,
  BB_LZ,
  BB_TAPE_1,
  BB_TAPE_2,
  type BbRect,
} from './config';

/**
 * BIOBUZZ field renderer — THE MAT, THE ZONES, THE HIVE STRUCTURE, THE FLOWERS, THE WALL.
 *
 * This file used to draw an empty 12-ft square and say so at length, because Section 9 (ARENA)
 * of the V0 pre-season manual was one page promising Kickoff. Kickoff happened. Everything
 * drawn below is the V1 manual, distilled in `docs/biobuzz-reference.md` §2 with a figure
 * number against every value, and EVERY dimension on this canvas is an import from
 * `./config` — there is not one literal field number in here. That is the whole discipline:
 * `grep APPROX src/games/biobuzz/config.ts` is the tape-measure list, and a dimension typed
 * into a renderer is a dimension that list cannot find.
 *
 * WHAT THIS VIEW HAS TO SOLVE. BIOBUZZ is the first DSIM game whose central structure is
 * genuinely THREE-DIMENSIONAL: the HIVE pivots 43.95 in overhead, one CELL tilts up to 53.5+
 * in and the other tilts down toward the tiles, and a driver's whole job is knowing WHICH ONE
 * IS UP. A flat top-down plan cannot say that, so two devices do:
 *  • the DOWN cell is FORESHORTENED by cos 30° (see `COS30`) — it is tilted away from the
 *    camera, so its plan-view projection really is shorter, and the eye reads short-and-dim
 *    as "far side / away" without being told;
 *  • the frame CROSSBAR is DASHED, because it joins the two triangles at the apex, 43.95 in
 *    over your head. A solid bar across the middle of the field would read as something a
 *    robot can hit. A dashed one reads as "above you, not on the tile", which is what it is.
 *
 * THEMING: colours come from `C.COLORS` (the `--ds-on-field*` token family) so the field
 * reads in both themes — with ONE deliberate exception, `TAPE_GAFFER`, documented at its
 * declaration. `screenUp` is the camera's up axis in WORLD space and is USED here: it is what
 * every piece of text is counter-rotated by so the labels read upright whichever wall the
 * driver is sitting behind.
 *
 * `world.biobuzz` may be absent (a DECODE or Chain Reaction world handed to the wrong slot,
 * or a snapshot from before the state grew a field), so every read of it is guarded and falls
 * back to the manual's STAGED pose. A field that throws is worse than a field that is stale.
 */

// ─────────────────────────────────────────────────────────────────────────────
// COLOUR + DRAWING CHOICES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE ZONE TAPE IS THE ONE THING HERE THAT IS NOT A THEME TOKEN.
 *
 * §9.3 specifies red and electric-blue gaffer, and on this field the tape COLOUR is the
 * marking — it is what tells a driver whose LOADING ZONE and whose GARDEN they are looking
 * at. A token that flipped with the light/dark theme would be drawing a different field in
 * one of the two. So these two are fixed, and everything else on this canvas is `C.COLORS`.
 */
const TAPE_GAFFER: Record<Alliance, string> = { red: '#e02020', blue: '#0a5cff' };

/**
 * The 30° tilt's plan-view projection factor (Fig 9-10 — each HIVE rests 30° off level).
 *
 * DERIVED, never typed as 0.866: it is the same cosine `BB_HIVE_CELL_DY` was read off
 * (15.4 · cos 30° ≈ 13.4), so writing the decimal here would be a second, silently
 * disagreeable copy of a number the config already owns the meaning of.
 */
const COS30 = Math.cos(Math.PI / 6);

/**
 * Half the drawn length of one CELL along y — DERIVED from two config constants rather than
 * being a constant of its own, because it is not a manual fact: the assembly is `BB_HIVE_LEN`
 * end to end (Fig 9-9) and a cell centre sits `BB_HIVE_CELL_DY` from the pivot, so whatever
 * is left between that centre and the outer end IS the cell's half-length. The gap it leaves
 * around the pivot is the connecting bar the two cells ride on.
 */
const CELL_HALF = BB_HIVE_LEN / 2 - BB_HIVE_CELL_DY;

/**
 * DRAWING CHOICES — a corner radius, a dash pitch, a badge size, a type size. The manual says
 * nothing about how to draw a line, so these are local, unexported and unflagged: they are
 * not APPROX field dimensions waiting for a tape measure, they are this renderer's taste.
 * Anything that IS a field dimension is an import at the top of the file.
 */
const HIVE_R = 2; // rounded-rect corner radius on a HIVE body and its CELLS
const DASH: readonly number[] = [3.2, 2.4]; // crossbar dash pitch, in WORLD INCHES
const BADGE_R = 2.2; // the FLOWER stack-count disc
const WALL_INSET = 3; // how far OUTSIDE a wall a tile letter/number sits, in the view margin
const GARDEN_LABEL_IN = 12; // how far off its wall a GARDEN caption sits — see the label block
const TAG_SIZE = 2.2; // AprilTag id groups — deliberately small, see below
const LABEL_SIZE = 3; // zone / flower / tile labels
const HIVE_LABEL_SIZE = 2.6; // "BLUE HIVE" is nine glyphs in a BB_HIVE_W-wide box
const COUNT_SIZE = 6; // the up-CELL content count

const ALLIANCES: readonly Alliance[] = ['red', 'blue'];

/** which way the FIELD is, from each FLOWER's wall. A badge or a label placed the other way
 * is outside the perimeter, where the wall clips it. */
const FIELD_SIDE: Record<(typeof BB_FLOWERS)[number]['wall'], Vec2> = {
  left: { x: 1, y: 0 },
  rear: { x: 0, y: -1 },
  right: { x: -1, y: 0 },
  audience: { x: 0, y: 1 },
};

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL HELPERS — there is no shared rounded-rect, dashed-line or canvas-text helper in the
// render layer, and three callers inside one file do not justify inventing a shared one.
// ─────────────────────────────────────────────────────────────────────────────

function allianceColor(a: Alliance, dim = false): string {
  if (dim) return a === 'blue' ? C.COLORS.blueDim : C.COLORS.redDim;
  return a === 'blue' ? C.COLORS.blue : C.COLORS.red;
}

function fillRect(ctx: CanvasRenderingContext2D, r: BbRect, fill: string): void {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  ctx.restore();
}

function strokeRect(ctx: CanvasRenderingContext2D, r: BbRect, stroke: string, w: number): void {
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = w;
  ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  ctx.restore();
}

/** a rounded-rect PATH (no fill, no stroke — the caller decides). The radius is clamped to
 * half the shorter side, because `arcTo` with a radius larger than the corner it is rounding
 * draws a shape nobody asked for, and a degenerate rect is skipped entirely rather than
 * handed a negative one. */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
): void {
  if (x1 <= x0 || y1 <= y0) return;
  const rr = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  ctx.beginPath();
  ctx.moveTo(x0 + rr, y0);
  ctx.lineTo(x1 - rr, y0);
  ctx.arcTo(x1, y0, x1, y0 + rr, rr);
  ctx.lineTo(x1, y1 - rr);
  ctx.arcTo(x1, y1, x1 - rr, y1, rr);
  ctx.lineTo(x0 + rr, y1);
  ctx.arcTo(x0, y1, x0, y1 - rr, rr);
  ctx.lineTo(x0, y0 + rr);
  ctx.arcTo(x0, y0, x0 + rr, y0, rr);
  ctx.closePath();
}

/**
 * Upright, unmirrored text at a WORLD point.
 *
 * The camera maps a world vector v to the screen as scale(s, −s) ∘ rotate(θ) v, and
 * `screenUp` is (sin θ, cos θ) — so undoing the rotation and the y-flip is exactly
 * `rotate(−θ)` then `scale(1, −1)`, and the glyphs come out the right way up whichever wall
 * the driver is behind. `size` is in WORLD INCHES (a 4 is a 4-inch-tall glyph), the same
 * convention `renderer.ts` uses for robot name labels.
 *
 * The HALO STROKE BEFORE THE FILL is not decoration: half of these labels sit over tape, over
 * a bright alliance fill or over the dashed crossbar, and a bare fill disappears into
 * whichever of those it lands on.
 */
function text(
  ctx: CanvasRenderingContext2D,
  screenUp: Vec2,
  x: number,
  y: number,
  size: number,
  fill: string,
  t: string,
  alpha = 1,
): void {
  const theta = Math.atan2(screenUp.x, screenUp.y);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(-theta);
  ctx.scale(1, -1);
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = size * 0.18;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(20,22,26,0.8)';
  ctx.strokeText(t, 0, 0);
  ctx.fillStyle = fill;
  ctx.fillText(t, 0, 0);
  ctx.restore();
}

/** tile-centre coordinate of column/row `i` (0..5) — derived from `C.TILE` so a 24-in tile
 * stays the only place the field's module is written down. */
function tileCentre(i: number): number {
  return (i - 2.5) * C.TILE;
}

/** the drawn y-extent of one CELL. `side` is +1 for the north cell (y > 0) and −1 for the
 * south one; `f` is the length factor — 1 for the UP cell, `COS30` for the foreshortened
 * DOWN one. The PIVOT-SIDE edge is fixed and the OUTER end moves, because that is what
 * rotating about the pivot away from the camera actually does to the projection. */
function cellSpan(side: number, f: number): { y0: number; y1: number } {
  const inner = side * (BB_HIVE_CELL_DY - CELL_HALF);
  const outer = inner + side * 2 * CELL_HALF * f;
  return { y0: Math.min(inner, outer), y1: Math.max(inner, outer) };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE RENDERER
// ─────────────────────────────────────────────────────────────────────────────

export function drawBiobuzzField(
  ctx: CanvasRenderingContext2D,
  world: World,
  screenUp: Vec2 = { x: 0, y: 1 },
): void {
  const hx = BB_HALF_X;
  const hy = BB_HALF_Y;

  // The BIOBUZZ state bag, or nothing. A non-biobuzz world reaching this slot draws the
  // STAGED field rather than throwing — see the header.
  const bb = world.biobuzz;
  const upCell = (a: Alliance): 'north' | 'south' => bb?.hives?.[a]?.up ?? BB_HIVE_UP_STAGED[a];
  const cellCount = (a: Alliance): number => bb?.hives?.[a]?.contents?.length ?? 0;
  const stackCount = (i: number): number => bb?.flowers?.[i]?.stack?.length ?? 0;

  // MAT — the soft tile floor.
  ctx.fillStyle = C.COLORS.mat;
  ctx.fillRect(-hx, -hy, 2 * hx, 2 * hy);

  // TILE GRID — every 24" tile. Not decoration: the tile grid is how a driver judges distance
  // on an FTC field, and §9.3 says every tape line stays inside one tile, so the seams are
  // also what the zone rectangles below were measured against.
  ctx.save();
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
  ctx.restore();

  // CENTRE MARK — a small cross at the origin. The tile grid alone has a LINE through the
  // centre of the field (144" is six 24" tiles, so x=0 and y=0 are both grid lines), which
  // means "the middle" is a crossing indistinguishable from five others. The mark is what
  // makes a still self-orienting: it says where the origin is, so a reviewer can tell whether
  // a scatter is centred and whether a robot's pose is where the scene claims.
  const MARK = 4;
  ctx.save();
  ctx.strokeStyle = C.COLORS.white;
  ctx.lineWidth = C.TAPE_W;
  ctx.beginPath();
  ctx.moveTo(-MARK, 0);
  ctx.lineTo(MARK, 0);
  ctx.moveTo(0, -MARK);
  ctx.lineTo(0, MARK);
  ctx.stroke();
  ctx.restore();

  // LOADING ZONES (§9.3, Fig 9-2/9-3) — ~23 × 11 against the side wall, bounded by tape and
  // the wall, tape included. The layout is POINT-SYMMETRIC, so red's is at y > 0 on the LEFT
  // wall and blue's is the diagonal opposite; `BB_LZ` carries that, and a loop that
  // "corrected" it into an x-mirror would produce a field that is internally consistent and
  // wrong.
  for (const a of ALLIANCES) {
    fillRect(ctx, BB_LZ[a], allianceColor(a, true));
    strokeRect(ctx, BB_LZ[a], TAPE_GAFFER[a], BB_TAPE_1);
  }

  // GARDENS (§9.3, §10.5.3) — a 23 × 2 strip in the alliance's own corner, "defined by the
  // outside edge of tape". Drawn as the strip it is: a wash plus a BB_TAPE_2-wide edge. Its
  // wall-side edge is overdrawn by the perimeter at the end of this function, which is
  // correct — that edge IS the wall.
  for (const a of ALLIANCES) {
    fillRect(ctx, BB_GARDEN[a], allianceColor(a, true));
    strokeRect(ctx, BB_GARDEN[a], TAPE_GAFFER[a], BB_TAPE_2);
  }

  // HIVE FRAME (§9.6.1, Fig 9-8) — two triangular structures joined at the apex. Top-down,
  // each triangle is its BASE BAR: a strip along y at x = ±BB_FRAME_X, which is the only part
  // of it a robot can actually hit, so it is the only part drawn solid.
  ctx.save();
  ctx.fillStyle = C.COLORS.wall;
  for (const sx of [-1, 1]) {
    ctx.fillRect(sx * BB_FRAME_X - BB_FRAME_BAR / 2, -BB_FRAME_Y, BB_FRAME_BAR, 2 * BB_FRAME_Y);
  }
  ctx.restore();

  // …and the CROSSBAR, DASHED. It joins the two triangles at the apex, which §9.6.1 puts
  // 43.95 in above the tiles — a robot drives straight under it, and G409 assumes so. Drawn
  // solid it would read as a wall bisecting the field; dashed it reads as structure overhead,
  // which is the one thing a plan view has to say about it. The dash pitch is in WORLD INCHES
  // like every other length here, and the pattern is reset explicitly as well as by restore().
  ctx.save();
  ctx.setLineDash([...DASH]);
  ctx.strokeStyle = C.COLORS.wall;
  ctx.lineWidth = BB_FRAME_BAR;
  ctx.beginPath();
  ctx.moveTo(-BB_FRAME_X, 0);
  ctx.lineTo(BB_FRAME_X, 0);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // THE TWO HIVES (§9.6, Figs 9-9/9-10) — red's pivot at −x, blue's at +x, 25.5 in apart.
  // Each is one rounded rect for the assembly with its two CELLS drawn inside it, north and
  // south of the pivot. Which cell is UP is game state, not geometry: it flips on every TIP.
  for (const a of ALLIANCES) {
    const px = a === 'red' ? -BB_HIVE_X : BB_HIVE_X;
    const x0 = px - BB_HIVE_W / 2;
    const x1 = px + BB_HIVE_W / 2;
    const up = upCell(a);

    // the assembly body — the connecting bar and shell the two cells ride on.
    ctx.save();
    roundRectPath(ctx, x0, -BB_HIVE_LEN / 2, x1, BB_HIVE_LEN / 2, HIVE_R);
    ctx.fillStyle = C.COLORS.tile;
    ctx.fill();
    ctx.strokeStyle = C.COLORS.wall;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.restore();

    for (const side of ['north', 'south'] as const) {
      const s = side === 'north' ? 1 : -1;
      const isUp = up === side;
      // THE FORESHORTENING. The DOWN cell is rotated 30° away from the camera about the
      // pivot, so in plan view its length really is cos 30° of the up cell's — and shrinking
      // it about the PIVOT side (the end that does not move) is what makes the pair read as
      // one rigid thing see-sawing, rather than as two rectangles that change size.
      const { y0, y1 } = cellSpan(s, isUp ? 1 : COS30);

      ctx.save();
      roundRectPath(ctx, x0, y0, x1, y1, HIVE_R);
      ctx.fillStyle = isUp ? allianceColor(a) : allianceColor(a, true);
      ctx.fill();
      ctx.globalAlpha = isUp ? 1 : 0.45;
      ctx.strokeStyle = allianceColor(a);
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.restore();

      const cy = (y0 + y1) / 2;

      // CONTENT COUNT — only the up-CELL holds anything scoreable (Table 10-2: 2 points per
      // element left in an upward-facing CELL), and it is the number a driver is playing for.
      if (isUp) text(ctx, screenUp, px, cy, COUNT_SIZE, C.COLORS.white, String(cellCount(a)));

      // APRILTAG ID GROUPS (§9.9, Figs 9-15…9-17) — four 36h11 tags on the bottom face of
      // every CELL. Drawn ALWAYS, not only under the label toggle, and drawn small and low
      // contrast so they never compete with the count: a published tag id is the ONE thing
      // that pins this drawing to the real field, so a still that prints them can be checked
      // against the manual without opening it (`docs/biobuzz-reference.md` §9, the mirror
      // test). Pushed toward the cell's outer end, away from the count in the middle.
      // Ink follows the cell: white at low alpha reads on the DIMMED cell and disappears on
      // the bright alliance fill, which is the cell whose ids a reviewer checks first.
      const tags = BB_HIVE_TAGS[a][side].join('·');
      const tagInk = isUp ? C.COLORS.mat : C.COLORS.white;
      text(ctx, screenUp, px, cy + s * (y1 - y0) * 0.31, TAG_SIZE, tagInk, tags, isUp ? 0.9 : 0.55);
    }
  }

  // THE FOUR FLOWERS (§9.7, Fig 9-12) — one per perimeter wall, on the tile seam one tile off
  // centre. A filled FOOT (the footprint a robot collides with) and, on top of it, the top
  // ring's 4.0-in opening as a stroked circle — the thing a POLLEN has to arrive through, so
  // it is drawn as an opening rather than as another disc.
  BB_FLOWERS.forEach((f, i) => {
    ctx.save();
    ctx.fillStyle = C.COLORS.wall;
    ctx.beginPath();
    ctx.arc(f.x, f.y, BB_FLOWER_FOOT_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = C.COLORS.white;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.arc(f.x, f.y, BB_FLOWER_OPEN_R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // STACK BADGE — how many elements are in this FLOWER. An EMPTY flower gets no badge at
    // all: a "0" on all four of them is four pieces of furniture saying nothing, and the
    // empty ring already says empty. Placed on the FIELD side, because on the other side the
    // perimeter is BB_FLOWER_D away and would clip it.
    const n = stackCount(i);
    if (n > 0) {
      const d = FIELD_SIDE[f.wall];
      const bx = f.x + d.x * (BB_FLOWER_FOOT_R + BADGE_R);
      const by = f.y + d.y * (BB_FLOWER_FOOT_R + BADGE_R);
      ctx.save();
      ctx.fillStyle = C.COLORS.mat;
      ctx.strokeStyle = C.COLORS.white;
      ctx.lineWidth = 0.4;
      ctx.beginPath();
      ctx.arc(bx, by, BADGE_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      text(ctx, screenUp, bx, by, BADGE_R * 1.4, C.COLORS.white, String(n));
    }
  });

  // PERIMETER — drawn last, so it sits over the grid lines and the garden tape that run into
  // it.
  ctx.save();
  ctx.strokeStyle = C.COLORS.white;
  ctx.lineWidth = C.TAPE_W;
  ctx.strokeRect(-hx, -hy, 2 * hx, 2 * hy);
  ctx.restore();

  // ── LABELS ─────────────────────────────────────────────────────────────────
  // OPT-IN, because they are a documentation device and not part of the field. On in the
  // gallery stills, where a reviewer needs to know which corner is whose GARDEN without
  // counting tiles; off in a match, where they would be a dozen pieces of text over the thing
  // a driver is actually looking at.
  if (world.biobuzz?.labels !== true) return;

  for (const a of ALLIANCES) {
    const name = a.toUpperCase();

    // LOADING ZONE — INSIDE its own rect, which is 11 × 24 and has the room. Offset a quarter
    // of the rect's height toward field centre rather than sitting dead centre: the rect's
    // centre is also a tile-row centre, which is where the row number on that same wall goes.
    const lz = BB_LZ[a];
    const lzy = (lz.y0 + lz.y1) / 2;
    text(
      ctx,
      screenUp,
      (lz.x0 + lz.x1) / 2,
      lzy - Math.sign(lzy) * ((lz.y1 - lz.y0) / 4),
      LABEL_SIZE,
      C.COLORS.white,
      `${name} LZ`,
    );

    // GARDEN — the strip is 2 in deep, so nothing legible fits inside it, and it runs INTO
    // the corner. The label sits beside it, `GARDEN_LABEL_IN` off its own wall: a caption is
    // drawn upright on the SCREEN, so its length runs along the axis the strip is thin in,
    // and a label centred on the strip itself would run off the field at the corner.
    const g = BB_GARDEN[a];
    const gy = (g.y0 + g.y1) / 2;
    text(
      ctx,
      screenUp,
      (g.x0 + g.x1) / 2,
      Math.sign(gy) * (BB_HALF_Y - GARDEN_LABEL_IN),
      LABEL_SIZE,
      C.COLORS.white,
      `${name} GARDEN`,
    );

    // HIVE — in the gap between the two CELLS, which is the connecting bar and the only part
    // of the assembly with nothing else printed on it. A size down from the rest, because
    // "BLUE HIVE" is nine glyphs and the body is only BB_HIVE_W wide.
    text(
      ctx,
      screenUp,
      a === 'red' ? -BB_HIVE_X : BB_HIVE_X,
      0,
      HIVE_LABEL_SIZE,
      C.COLORS.white,
      `${name} HIVE`,
    );
  }

  // FLOWER ids, offset ALONG the wall rather than into the field — the field side is where
  // the stack badge goes, and a label that moves depending on whether a flower happens to be
  // empty is worse than one that is always in the same place.
  for (const f of BB_FLOWERS) {
    const d = FIELD_SIDE[f.wall];
    const off = BB_FLOWER_FOOT_R + LABEL_SIZE;
    text(ctx, screenUp, f.x - d.y * off, f.y + d.x * off, LABEL_SIZE, C.COLORS.white, f.id);
  }

  // TILE LETTERS AND NUMBERS — columns A–F along the audience wall, rows 1–6 up the left wall
  // (`docs/biobuzz-reference.md` §2: row 1 is the audience side, column A is red's).
  //
  // OUTSIDE THE PERIMETER, in the camera's own view margin, the way a manual figure prints
  // them. Inside the wall they cannot work on this field: the layout is point-symmetric, so
  // whichever two walls carry the ruler also carry one alliance's GARDEN strip and the other's
  // LOADING ZONE, and every scheme that keeps the ruler on the tile puts a letter under a
  // zone. `BB_VIEW_MARGIN` is 8 in and this needs 3, so nothing is clipped.
  for (let i = 0; i < 6; i++) {
    const c = tileCentre(i);
    text(
      ctx,
      screenUp,
      c,
      -hy - WALL_INSET,
      LABEL_SIZE,
      C.COLORS.white,
      String.fromCharCode(65 + i),
      0.7,
    );
    text(ctx, screenUp, -hx - WALL_INSET, c, LABEL_SIZE, C.COLORS.white, String(i + 1), 0.7);
  }
}
