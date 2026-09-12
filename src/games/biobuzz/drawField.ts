import type { Alliance, Artifact, ArtifactColor, Vec2, World } from '../../types';
import * as C from '../../config';
import {
  BB_FLOWERS,
  BB_FLOWER_D,
  BB_FLOWER_FOOT,
  BB_FLOWER_OPEN_R,
  BB_FRAME_BAR_IN,
  BB_FRAME_BAR_OUT,
  BB_FRAME_Y,
  BB_GARDEN,
  BB_HALF_X,
  BB_HALF_Y,
  BB_HIVE_CELL_DY,
  BB_HIVE_CELL_LEN,
  BB_HIVE_LEN,
  BB_HIVE_TAGS,
  BB_HIVE_UP_STAGED,
  BB_HIVE_W,
  BB_HIVE_X,
  BB_LZ,
  BB_POLLEN_R,
  BB_TAPE_1,
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
 * IS UP.
 *
 * ⚠️ THE PLAN VIEW CANNOT SAY IT WITH SHAPE. The first pass drew the down cell SHORT, on the
 * reasoning that a cell tilted away from the camera projects shorter. It does — and so does
 * the other one. The two CELLS ride ONE RIGID BAR at 30° (owner CAD, 2026-09-12; reference
 * §2.2), so a top-down view foreshortens BOTH ends by the same cos 30° and only `z` tells
 * them apart. Drawing one short and one long says the bar bends. So the two cells are drawn
 * IDENTICAL in size and the up one is said with BRIGHTNESS and with its CONTENT COUNTS —
 * which is all a plan view honestly has, and the content counts are the part a driver acts
 * on anyway. Every length here is already the projected one: `BB_HIVE_LEN` is 37.16, not the
 * 42.91 the assembly measures in three dimensions.
 *
 * The frame CROSSBAR is DASHED, because it joins the two triangles at the apex, 43.95 in over
 * your head. A solid bar across the middle of the field would read as something a robot can
 * hit. A dashed one reads as "above you, not on the tile", which is what it is.
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

/** frame BASE BAR thickness and centreline x (in) — both DERIVED from the two measured edges
 * so the bar's INNER edge stays exactly on the ±24 tile seam, which is the measured fact. */
const FRAME_BAR_W = BB_FRAME_BAR_OUT - BB_FRAME_BAR_IN;
const FRAME_BAR_MID = (BB_FRAME_BAR_IN + BB_FRAME_BAR_OUT) / 2;

/**
 * DRAWING CHOICES — a corner radius, a dash pitch, a badge size, a type size. The manual says
 * nothing about how to draw a line, so these are local, unexported and unflagged: they are
 * not APPROX field dimensions waiting for a tape measure, they are this renderer's taste.
 * Anything that IS a field dimension is an import at the top of the file.
 */
const HIVE_R = 2; // rounded-rect corner radius on a HIVE body and its CELLS
const DASH: readonly number[] = [3.2, 2.4]; // crossbar dash pitch, in WORLD INCHES
const WALL_INSET = 2.5; // how far OUTSIDE a wall a tile letter/number sits, in the view margin
const STACK_OUT = 6.5; // how far OUTSIDE a wall a FLOWER's stack readout sits
const STACK_GAP = 0.5; // clear air between two discs of a stack
const GARDEN_LABEL_IN = 12; // how far off its wall a GARDEN caption sits — see the label block
const TAG_SIZE = 2.2; // AprilTag id groups — deliberately small, see below
const LABEL_SIZE = 3; // zone / flower / tile labels
const HIVE_LABEL_SIZE = 2.6; // "BLUE HIVE" is nine glyphs in a BB_HIVE_W-wide box
const TALLY_SIZE = 3.4; // the up-CELL per-type counts
const TALLY_PIP = 1.3; // the coloured disc beside each of those counts
const TALLY_ROW = 4.2; // pitch between the (at most three) tally rows, along x

/**
 * ELEMENT INK — how a POLLEN and each alliance's NECTAR are drawn in a readout.
 *
 * FIXED, not theme tokens, for the reason `draw.ts` fixes its pollen fill: the mat is
 * hardcoded dark and these discs are always on it or on the backdrop, so a colour that
 * flipped with the theme would be a pale ball on a pale ground half the time. Yellow matches
 * `draw.ts`'s `POLLEN_FILL` on purpose — the readout and the element itself must be the same
 * colour or the readout is a second vocabulary.
 */
const POLLEN_INK = '#f2d14b';

/** which of the THREE element types a ball is: 0 POLLEN, 1 RED NECTAR, 2 BLUE NECTAR. POLLEN
 * is the DEFAULT rather than a named colour, because the scenes call them `green` (the shared
 * `ArtifactColor` has no `pollen`) and a renderer that tested for one spelling would silently
 * count a differently-spelled pollen as nothing. A NECTAR is the only thing that is ever an
 * ALLIANCE colour, so alliance-or-not is the whole classification. */
function elementType(color: ArtifactColor): 0 | 1 | 2 {
  return color === 'red' ? 1 : color === 'blue' ? 2 : 0;
}

function elementInk(color: ArtifactColor): string {
  const t = elementType(color);
  return t === 1 ? C.COLORS.red : t === 2 ? C.COLORS.blue : POLLEN_INK;
}

const ALLIANCES: readonly Alliance[] = ['red', 'blue'];

/** which way the FIELD is, from each FLOWER's wall. A badge or a label placed the other way
 * is outside the perimeter, where the wall clips it. */
const FIELD_SIDE: Record<(typeof BB_FLOWERS)[number]['wall'], Vec2> = {
  left: { x: 1, y: 0 },
  rear: { x: 0, y: -1 },
  right: { x: -1, y: 0 },
  audience: { x: 0, y: 1 },
};

/** the point on a FLOWER's own wall PLANE level with it, and the direction to run its stack
 * readout ALONG that wall. The stack runs toward the middle of the wall — every FLOWER sits
 * one tile off centre, so that direction always has the whole half-wall of room, where the
 * other one runs into a corner after 48 in. */
function stackAxis(f: (typeof BB_FLOWERS)[number]): { base: Vec2; along: Vec2 } {
  const out = FIELD_SIDE[f.wall];
  const onY = f.wall === 'left' || f.wall === 'right';
  return {
    base: {
      x: onY ? -out.x * (BB_HALF_X + STACK_OUT) : f.x,
      y: onY ? f.y : -out.y * (BB_HALF_Y + STACK_OUT),
    },
    along: onY ? { x: 0, y: -Math.sign(f.y) } : { x: -Math.sign(f.x), y: 0 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL HELPERS — there is no shared rounded-rect, dashed-line or canvas-text helper in the
// render layer, and three callers inside one file do not justify inventing a shared one.
// ─────────────────────────────────────────────────────────────────────────────

function allianceColor(a: Alliance, dim = false): string {
  if (dim) return a === 'blue' ? C.COLORS.blueDim : C.COLORS.redDim;
  return a === 'blue' ? C.COLORS.blue : C.COLORS.red;
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

/**
 * the drawn y-extent of one CELL. `side` is +1 for the north cell (y > 0) and −1 for the south
 * one, and THAT IS THE ONLY ARGUMENT — there is no per-cell length factor.
 *
 * Both cells are `BB_HIVE_CELL_LEN` long centred `BB_HIVE_CELL_DY` from the pivot, because
 * both numbers are ALREADY the plan projection of one rigid bar at 30° (reference §2.2): the
 * cell spans 8.16 to 18.58 from the pivot whichever end is up. Foreshortening one of the two
 * would draw a see-saw that changes length as it tips.
 */
function cellSpan(side: number): { y0: number; y1: number } {
  const c = side * BB_HIVE_CELL_DY;
  const h = BB_HIVE_CELL_LEN / 2;
  return { y0: Math.min(c - h, c + h), y1: Math.max(c - h, c + h) };
}

/**
 * A FLOWER's FOOTPRINT — a RECTANGLE FLUSH TO ITS WALL, not a disc (measured; reference §2.3).
 *
 * Derived from the ring centre rather than stored, because `BB_FLOWERS` gives the RING and the
 * foot is hung off the WALL: back up `BB_FLOWER_D` along the inward normal to reach the wall
 * face, then run `BB_FLOWER_FOOT.deep` into the field and `along / 2` each way along the wall.
 * Doing it in that order is what keeps the foot flush when the stand-off changes.
 */
function flowerFoot(f: (typeof BB_FLOWERS)[number]): BbRect {
  const n = FIELD_SIDE[f.wall]; // unit inward normal — one component is 0, the other ±1
  const wx = f.x - n.x * BB_FLOWER_D;
  const wy = f.y - n.y * BB_FLOWER_D;
  const half = BB_FLOWER_FOOT.along / 2;
  const ix = wx + n.x * BB_FLOWER_FOOT.deep;
  const iy = wy + n.y * BB_FLOWER_FOOT.deep;
  const tx = n.x === 0 ? half : 0; // the tangent extent is on whichever axis the normal is not
  const ty = n.y === 0 ? half : 0;
  return {
    x0: Math.min(wx, ix) - tx,
    x1: Math.max(wx, ix) + tx,
    y0: Math.min(wy, iy) - ty,
    y1: Math.max(wy, iy) + ty,
  };
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

  /**
   * ELEMENTS ARE LOOKED UP IN `world.balls`, BY ID.
   *
   * A HIVE cell and a FLOWER stack hold ids (`state.ts`), and the elements themselves stay in
   * `world.balls` in the `element` state — one array, so conservation is one count. So every
   * readout below is a JOIN, and an id with no element behind it draws NOTHING rather than a
   * placeholder: a readout that invents a colour is worse than one that is short, because the
   * colour is the whole message (bottom NECTAR = the 5-point bonus, top NECTAR = ownership).
   */
  const byId = new Map<number, Artifact>();
  for (const b of world.balls) byId.set(b.id, b);
  const elements = (ids: readonly number[] | undefined): Artifact[] =>
    (ids ?? []).map((id) => byId.get(id)).filter((b): b is Artifact => b !== undefined);

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
  //
  // ⚠️ TAPE, NOT STRUCTURE (owner ruling, 2026-09-12). Nothing collides with a zone — robots
  // drive over it and elements roll across it, and `colliders.ts` has never had an entry for
  // one. So it is drawn as the 1-in tape line it is, with the MAT showing through. A filled
  // bar reads as a wall, which is a drawing that tells a driver something false about what
  // they can drive on.
  for (const a of ALLIANCES) strokeRect(ctx, BB_LZ[a], TAPE_GAFFER[a], BB_TAPE_1);

  // GARDENS (§9.3, §10.5.3) — a 23 × 2 strip in the alliance's own corner, "defined by the
  // outside edge of tape", TWO 1-IN TAPES. Same ruling as the LOADING ZONE above: TAPE, never
  // a filled bar.
  //
  // Stroked at BB_TAPE_1, not at the 2-in strip depth. The depth is `BB_GARDEN`'s own — the
  // rect IS the strip — so stroking it at 2 paints the whole thing solid and puts back
  // exactly the filled bar the ruling removed. At the tape's own width the two long edges
  // come out as the two 1-in tapes they are, with the mat between them, which is what a
  // driver sees. The wall-side edge is overdrawn by the perimeter at the end of this
  // function, and that is correct: that edge IS the wall.
  for (const a of ALLIANCES) strokeRect(ctx, BB_GARDEN[a], TAPE_GAFFER[a], BB_TAPE_1);

  // HIVE FRAME (§9.6.1, Fig 9-8) — two triangular structures joined at the apex. Top-down,
  // each triangle is its BASE BAR, the only part of it a robot can actually hit, so it is the
  // only part drawn solid. MEASURED (owner CAD, 2026-09-12): 1 in thick with its INNER edge ON
  // the ±24 tile seam, extending OUTWARD — so the bar is drawn from the seam out, never
  // straddling it. That matters in a still: a driver lines up on the seam, and a bar centred
  // on it would put half an inch of structure on the wrong side of the line they aim at.
  ctx.save();
  ctx.fillStyle = C.COLORS.wall;
  for (const sx of [-1, 1]) {
    const x0 = sx < 0 ? -BB_FRAME_BAR_OUT : BB_FRAME_BAR_IN;
    ctx.fillRect(x0, -BB_FRAME_Y, FRAME_BAR_W, 2 * BB_FRAME_Y);
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
  ctx.lineWidth = FRAME_BAR_W;
  ctx.beginPath();
  ctx.moveTo(-FRAME_BAR_MID, 0);
  ctx.lineTo(FRAME_BAR_MID, 0);
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
      // SAME SIZE, BOTH ENDS. See `cellSpan` — one rigid bar at 30° projects both cells by the
      // same cosine, so UP is said by the bright fill and the counts below, not by shape.
      const { y0, y1 } = cellSpan(s);

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
      if (!isUp) continue;

      /**
       * THE UP-CELL READOUT IS PER TYPE, NOT A TOTAL (owner ruling, 2026-09-12).
       *
       * A single number cannot tell a driver anything they can act on, for two reasons that
       * both come out of the rules. ANY alliance may LAUNCH into ANY cell (§10.5.1 — legal and
       * pointless, but legal), so a cell's contents are not one alliance's; and the tip table
       * is indexed by the NECTAR COUNT (`BB_TIP_POLLEN`, measured), so "how close is this to
       * tipping" is a question about the split, not about the sum. A cell holding 3 NECTAR
       * tips on 3 POLLEN; the same 6 elements as 1 NECTAR and 5 POLLEN does not tip at all.
       *
       * Drawn as up to three rows — a coloured pip and its count — stacked along the cell's
       * SHORT axis, which is the screen's vertical, so the rows read as rows. A type with
       * nothing in it is omitted rather than shown as a zero.
       */
      const held = elements(bb?.hives?.[a]?.contents);
      const rows = ([POLLEN_INK, C.COLORS.red, C.COLORS.blue] as const)
        .map((ink, i) => ({ ink, n: held.filter((b) => elementType(b.color) === i).length }))
        .filter((r) => r.n > 0);

      rows.forEach((r, i) => {
        const rx = px + (i - (rows.length - 1) / 2) * TALLY_ROW;
        ctx.save();
        ctx.fillStyle = r.ink;
        ctx.beginPath();
        ctx.arc(rx, cy - TALLY_SIZE * 0.75, TALLY_PIP, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        text(ctx, screenUp, rx, cy + TALLY_SIZE * 0.55, TALLY_SIZE, C.COLORS.white, String(r.n));
      });
    }
  }

  // THE FOUR FLOWERS (§9.7, Fig 9-12) — one per perimeter wall, on the tile seam one tile off
  // centre, each exactly on the seam CENTRELINE (measured; reference §2.3).
  //
  // The FOOT is a 6 × 4.9 RECTANGLE FLUSH TO THE WALL (measured), not the APPROX 2.6-in disc
  // the first pass drew. It is the shape a robot running the wall actually meets, and the two
  // readings differ in the way that matters to a driver: the rectangle is wider along the wall
  // (you catch it sooner) and its corners are square (you do not slide off it). On top of it
  // the top ring's 4.0-in opening is a STROKED circle — the thing a POLLEN has to arrive
  // through — so an opening never reads as another solid disc.
  BB_FLOWERS.forEach((f, i) => {
    const foot = flowerFoot(f);
    ctx.save();
    ctx.fillStyle = C.COLORS.wall;
    ctx.fillRect(foot.x0, foot.y0, foot.x1 - foot.x0, foot.y1 - foot.y0);
    ctx.strokeStyle = C.COLORS.white;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.arc(f.x, f.y, BB_FLOWER_OPEN_R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    /**
     * THE STACK READOUT — THE STACK ITSELF, OUTSIDE THE PERIMETER (owner ruling, 2026-09-12).
     *
     * One disc per element, at element scale, in its own colour, in STACK ORDER, running along
     * the wall with the BOTTOM of the stack nearest the FLOWER. It replaces a count badge,
     * which said the one thing about a FLOWER that a driver cannot use: the number of elements
     * in it decides nothing. The COLOURS decide everything — the BOTTOM-most NECTAR is the
     * 5-point bonus AND the thing that locks retrieval (a 3.6 NECTAR does not fit the 3.55
     * opening, G418), and the TOP-most NECTAR is who OWNS the flower and collects 2 per
     * element in it (§10.5.2). A badge also read as an unexplained second circle beside a ring.
     *
     * OUTSIDE the wall because inside it there is no room: the ring is BB_FLOWER_D from the
     * perimeter and a six-element stack is two feet long. `BB_VIEW_MARGIN` was widened to
     * carry this.
     */
    const stack = elements(bb?.flowers?.[i]?.stack);
    if (stack.length > 0) {
      const { base, along } = stackAxis(f);
      // a stem from the ring out to the stack, so the readout belongs to THIS flower and not
      // to the wall in general.
      ctx.save();
      ctx.strokeStyle = C.COLORS.white;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 0.4;
      ctx.beginPath();
      ctx.moveTo(f.x, f.y);
      ctx.lineTo(base.x, base.y);
      ctx.stroke();
      ctx.restore();

      let t = 0;
      for (const b of stack) {
        const r = b.r ?? BB_POLLEN_R;
        t += r;
        ctx.save();
        ctx.fillStyle = elementInk(b.color);
        ctx.strokeStyle = 'rgba(12,14,18,0.65)';
        ctx.lineWidth = 0.3;
        ctx.beginPath();
        ctx.arc(base.x + along.x * t, base.y + along.y * t, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        t += r + STACK_GAP;
      }
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
  const bbLabels = world.biobuzz;

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

  // APRILTAG ID GROUPS (§9.9, Figs 9-15…9-17) — four 36h11 tags on the bottom face of every
  // CELL. BEHIND THE FLAG (owner ruling, 2026-09-12): a published tag id is the one thing that
  // pins this drawing to the real field, so a still that is checked against the manual wants
  // them — and a driver does not, so in a match they are noise over the cell they are reading.
  //
  // Printed as the RANGE ("30-33"), not the four ids: they are always four CONSECUTIVE ids, so
  // the middle two carry nothing.
  //
  // ON THE CELL'S SHORT AXIS (x), NOT ALONG IT. Canvas text is upright on SCREEN, so the
  // string's LENGTH runs along world y — the same axis the cell is only BB_HIVE_CELL_LEN
  // (10.43) long in. Placed at the cell's far end it overflowed that end and ran straight
  // through the per-type counts, which sit on the centre. Across the 20-in width there is
  // room for both: the counts keep the middle and the ids sit against the outer edge.
  for (const a of ALLIANCES) {
    const px = a === 'red' ? -BB_HIVE_X : BB_HIVE_X;
    for (const side of ['north', 'south'] as const) {
      const ids = BB_HIVE_TAGS[a][side];
      const sgn = side === 'north' ? 1 : -1;
      const isUp = (bbLabels?.hives?.[a]?.up ?? BB_HIVE_UP_STAGED[a]) === side;
      const { y0, y1 } = cellSpan(sgn);
      text(
        ctx,
        screenUp,
        px + BB_HIVE_W / 2 - TAG_SIZE,
        (y0 + y1) / 2,
        TAG_SIZE,
        isUp ? C.COLORS.mat : C.COLORS.white,
        `${ids[0]}-${ids[ids.length - 1]}`,
        isUp ? 0.9 : 0.55,
      );
    }
  }

  // FLOWER ids, offset ALONG the wall rather than into the field — the field side is where
  // the stack badge goes, and a label that moves depending on whether a flower happens to be
  // empty is worse than one that is always in the same place.
  for (const f of BB_FLOWERS) {
    const d = FIELD_SIDE[f.wall];
    const off = BB_FLOWER_FOOT.along / 2 + LABEL_SIZE;
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
