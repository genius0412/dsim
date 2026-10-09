import type { Alliance, Artifact, ArtifactColor, Vec2, World } from '../../types';
import * as C from '../../config';
import { dcos, dsin } from '../../math';
import {
  BB_FLOWERS,
  BB_FLOWER_D,
  BB_FLOWER_FOOT,
  BB_FLOWER_OPEN_R,
  BB_FLOWER_TOP_Z,
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
  BB_HIVE_TILT_DEG,
  BB_HIVE_UP_STAGED,
  BB_HIVE_W,
  BB_HIVE_X,
  BB_LZ,
  BB_NECTAR_R,
  BB_POLLEN_R,
  BB_TAPE,
  BB_TAPE_W,
  BB_TILE_SEAMS,
  FLOWER_MOUTH,
  type BbRect,
} from './config';
import {
  BB_FLOWER_FLOOR_Z,
  BB_FLOWER_MID_Z,
  BB_FLOWER_VOL_Z,
  flowerRetrieve,
  flowerScore,
  flowerStackZ,
  type BbElementKind,
} from './flower';
import { BB_TIP_SWING_S, hiveTakingSide } from './hive';
import { BB_BOX_SLOTS, BB_BOX_T, bbNectarBoxRect, bbNectarBoxSlot } from './nectarBox';

/**
 * BIOBUZZ field renderer — THE MAT, THE ZONES, THE HIVE STRUCTURE, THE FLOWERS, THE WALL.
 *
 * This file used to draw an empty 12-ft square and say so at length, because Section 9 (ARENA)
 * of the V0 pre-season manual was one page promising Kickoff. Kickoff happened. Everything
 * drawn below is the V1 manual, distilled in `docs/biobuzz-reference.md` §2 with a figure
 * number against every value, and EVERY dimension on this canvas is an import — from
 * `./config` for the FIELD, and from `./nectarBox` for the one piece of furniture that stands
 * outside the perimeter — there is not one literal field number in here. That is the whole
 * discipline:
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
 * OWNER BUG 12 (2026-09-19): "the blue alliance looks too purple — are you sure that is the
 * exact colour AndyMark uses?" Measured, the complaint is right and BOTH answers the repo had
 * were wrong. In OKLCH: the old `#4d8fe2`/`#0a5cff`/`C.COLORS.blue` family sits at hue 255-262°,
 * and the field CAD's own hive Goal Ribs are `plastic#0000ff` — hue 264.1°, which is 1.7° off the
 * most violet blue sRGB can express and the WORST answer available. A STEP assembly carrying
 * pure `#ff0000` and pure `#0000ff` is carrying PLACEHOLDER part colours, not a paint spec, and
 * `renderFieldGlb.ts` already overrides the same file's `#e6e6e6` "white plastic" placeholder for
 * exactly that reason. No authoritative AndyMark blue was found, so this is not one.
 *
 * `#007be1` is a PERCEPTUAL CORRECTION and APPROX: hue 252.9°, which is the least violet a
 * saturated blue gets before it starts reading cyan, at the maximum chroma sRGB has there
 * (0.179) and L 0.583 — within 0.002 of the red tape's own lightness, so the two alliances read
 * at the same weight. It is 11.2° off the CAD's rib colour, and that gap is deliberate.
 *
 * ⚠️ ONE BIOBUZZ BLUE. Tape, NECTAR, hive accents, the constants-built fallback scene, the GLB's
 * ribs and the robot silhouette all take this value; there is no second approximation left.
 */
const ALLIANCE_BLUE = '#007be1';

/**
 * THE ZONE TAPE IS THE ONE THING HERE THAT IS NOT A THEME TOKEN.
 *
 * §9.3 specifies red and electric-blue gaffer, and on this field the tape COLOUR is the
 * marking — it is what tells a driver whose LOADING ZONE and whose GARDEN they are looking
 * at. A token that flipped with the light/dark theme would be drawing a different field in
 * one of the two. So these two are fixed, and everything else on this canvas is `C.COLORS`.
 */
const TAPE_GAFFER: Record<Alliance, string> = { red: '#e02020', blue: ALLIANCE_BLUE };


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
const PERIMETER_W = 1; // stroke on the wall line, in WORLD INCHES — a schematic edge, NOT tape
// how far out a FLOWER section's NEAR bore wall sits, from the wall FACE. Balanced between two
// neighbours it must not touch: the tile ruler, which sits WALL_INSET out and whose glyphs
// reach about 0.9 further, and the edge of the camera at BB_VIEW_MARGIN — see
// `bbFlowerSectionBox`, which the smoke lane measures against both.
const SECT_OUT = 5.6;
const SECT_RING = 1.2; // how far the TOP RING's material shows to each side of the bore
const SECT_LOCK = 2.6; // how far BELOW the lower ring the retrieval LOCK glyph sits
const SECT_LOCK_R = 1.5; // half-size of that glyph — a NECTAR's own radius, near enough
/**
 * THE PANEL'S ENDS, in column z. Both are FIXED — the panel is the same size for an empty
 * FLOWER as for a full one, because the drawing is the COLUMN and the elements are inside it.
 * The row of discs this replaced grew with the stack, which made `BB_VIEW_MARGIN` a function
 * of capacity and therefore wrong every time the capacity moved.
 *
 * `SECT_Z1` clears an element HELD ON THE BACKSTOP: `flowerFits` admits one whose centre is
 * below the top ring, so the top of a full column stands about 2.1 in proud of it (Fig 10-5
 * D/H — it still counts). It also lands the panel's far end within an inch of the field's
 * centreline, which is the whole frontage a FLOWER one tile off centre has to run into.
 */
const SECT_Z0 = -(SECT_LOCK + SECT_LOCK_R + 0.5);
const SECT_Z1 = BB_FLOWER_TOP_Z + 2.6;
const GARDEN_LABEL_IN = 12; // how far off its wall a GARDEN caption sits — see the label block
const TAG_SIZE = 2.2; // AprilTag id groups — deliberately small, see below
const LABEL_SIZE = 3; // zone / flower / tile labels
const HIVE_LABEL_SIZE = 2.6; // "BLUE HIVE" is nine glyphs in a BB_HIVE_W-wide box
const CELL_DASH: readonly number[] = [1.8, 1.4]; // the DOWN cell's outline, at cell scale
const CELL_ROW_IN = 0.7; // clear air between the contents row and the cell's OPEN edge
const CELL_ROW_PAD = 0.9; // clear air between the contents row and the cell's long sides
const CELL_EDGE_THIN = 0.5; // the OUTER short edge — the opening
const CELL_EDGE_HEAVY = 2.2; // the PIVOT-side short edge — the closed back
const CELL_TAG_IN = 3.1; // AprilTag ids, in from the cell's PIVOT edge — see the labels block

/**
 * HOW SOLID THE UP-CELL'S FILL IS.
 *
 * NOT 1, and the contents are the reason. An element in a cell is drawn in its own colour
 * (field-plan §2.5), so a RED NECTAR in the RED cell is red on red — at full saturation it
 * vanished into the box and read as an empty ring, which is exactly backwards: the NECTAR
 * count is what the tip table is indexed by, so it is the one thing in there that must not
 * disappear. Dropped to a wash, the box is still unmistakably FILLED against the down cell's
 * dashed outline, and a saturated element on top of it reads at a glance. The heavy pivot-edge
 * mark needs the same room — alliance ink on an alliance fill is invisible whatever its width.
 */
const CELL_FILL_A = 0.45;

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
  return t === 1 ? C.COLORS.red : t === 2 ? ALLIANCE_BLUE : POLLEN_INK;
}

/** the same classification as `elementType`, in the vocabulary `flower.ts` scores in. Both
 * exist because the two questions are different: a RENDERER wants an ink, a RULE wants a kind,
 * and routing one through the other is what keeps a green-spelled pollen from being a nectar in
 * one of the two. */
function elementKind(color: ArtifactColor): BbElementKind {
  const t = elementType(color);
  return t === 1 ? 'red' : t === 2 ? 'blue' : 'pollen';
}

const ALLIANCES: readonly Alliance[] = ['red', 'blue'];

/**
 * THE FLOWER SECTION'S FRAME — where its z = 0 sits, and the two axes it is drawn in.
 *
 * A FLOWER is a 21.5-in COLUMN and the field is a plan view, so its contents are the one part
 * of this game a top-down drawing cannot say at all: four discs seen from above are four discs
 * whatever height they are at, and height is the whole rule (a POLLEN below the middle ring
 * scores nothing, a NECTAR on it always scores, §10.5.2). So the readout is a SECTION — the
 * column cut open and laid out beside itself, outside the perimeter, at 1:1 with the field's
 * own inches so an element's drawn radius is its real one.
 *
 * ⚠️ `up` IS THE COLUMN'S z AND IT RUNS ALONG THE WALL, not out of it. A section drawn with z
 * pointing away from the field would be the more natural picture and there is nowhere to put
 * it: `BB_VIEW_MARGIN` is 12 in of outboard room and the column is 21.5 in tall, so an
 * outward z would need the camera pulled back by a foot on every wall — every still in the
 * gallery smaller so that four readouts can be upright. Along the wall it costs nothing: each
 * FLOWER sits one tile off centre, so the direction TOWARD the wall's midpoint has 24 in of
 * clear frontage and the section ends 2.5 in short of the centreline.
 *
 * THE SECTION IS THEREFORE ROTATED WITH ITS WALL, which is the same rule the rest of this
 * renderer follows: `up` is the tangent toward the middle of the wall, `out` is the outward
 * normal (the bore's width), and `org` is the WALL FACE level with the ring — so the base of
 * the column is level with the FLOWER it belongs to on all four walls.
 */
function sectionFrame(f: (typeof BB_FLOWERS)[number]): { org: Vec2; up: Vec2; out: Vec2 } {
  const n = FLOWER_MOUTH[f.wall]; // unit INWARD normal
  const onY = f.wall === 'left' || f.wall === 'right';
  return {
    org: { x: f.x - n.x * BB_FLOWER_D, y: f.y - n.y * BB_FLOWER_D },
    up: onY ? { x: 0, y: -Math.sign(f.y) } : { x: -Math.sign(f.x), y: 0 },
    out: { x: -n.x, y: -n.y },
  };
}

/** a SECTION coordinate — `z` above the tiles, `s` across the bore from its centreline — as a
 * point in world inches. Every line, disc and glyph below is placed through this and nothing
 * else, so the whole readout rotates with its wall by construction rather than by four cases. */
function sectionPt(fr: { org: Vec2; up: Vec2; out: Vec2 }, z: number, s: number): Vec2 {
  const d = SECT_OUT + BB_FLOWER_OPEN_R + s;
  return { x: fr.org.x + fr.up.x * z + fr.out.x * d, y: fr.org.y + fr.up.y * z + fr.out.y * d };
}

/**
 * THE OUTBOARD BOX a FLOWER's section occupies, in world inches — EXPORTED for the smoke lane.
 *
 * `BB_VIEW_MARGIN` is a promise that everything this renderer draws outside the perimeter is
 * on camera, and this readout is the widest thing out there. A box the lane can measure turns
 * that promise into a check: a section that grew past the margin is a cropped readout in every
 * still, which is exactly the kind of regression a picture hides until someone looks closely.
 */
export function bbFlowerSectionBox(f: (typeof BB_FLOWERS)[number]): BbRect {
  const fr = sectionFrame(f);
  const w = BB_FLOWER_OPEN_R + SECT_RING;
  const pts = [
    sectionPt(fr, SECT_Z0, -w),
    sectionPt(fr, SECT_Z0, w),
    sectionPt(fr, SECT_Z1, -w),
    sectionPt(fr, SECT_Z1, w),
  ];
  return {
    x0: Math.min(...pts.map((q) => q.x)),
    x1: Math.max(...pts.map((q) => q.x)),
    y0: Math.min(...pts.map((q) => q.y)),
    y1: Math.max(...pts.map((q) => q.y)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL HELPERS — there is no shared rounded-rect, dashed-line or canvas-text helper in the
// render layer, and three callers inside one file do not justify inventing a shared one.
// ─────────────────────────────────────────────────────────────────────────────

function allianceColor(a: Alliance): string {
  return a === 'blue' ? ALLIANCE_BLUE : C.COLORS.red;
}

/** an element's drawn radius. `r` is optional on `Artifact` (DECODE has one size and never
 * sets it), so POLLEN is the fallback — never a hard-coded 1.4. Same rule as `draw.ts`. */
function elementR(b: Artifact): number {
  return b.r ?? BB_POLLEN_R;
}

/**
 * A TAPE STRIP — a FILLED rectangle of the width and position the CAD puts it at.
 *
 * It replaced a `strokeRect` of the ZONE, and that is the whole tape fix (owner, 2026-09-18):
 * outlining a zone paints all four of its edges, including the one that is a WALL and carries no
 * tape on the real field, and it turns the GARDEN's solid 2-in band into a 1-in outline of a 2-in
 * rectangle — two thin lines with mat showing between them. `BB_TAPE` carries the 16 measured
 * strips; this draws them.
 */
function fillStrip(ctx: CanvasRenderingContext2D, r: BbRect, fill: string): void {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  ctx.restore();
}

/** the 2×3 of a canvas transform — what `snapTapeGroup` reads, so the RENDER lane can hand it one */
export interface BbTapeXform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/**
 * ONE ZONE'S TAPE, SNAPPED TO THE DEVICE PIXEL GRID AT ONE WIDTH — `[x, y, w, h]` per strip in
 * DEVICE pixels, or `null` when the view is not axis-aligned (a rotated strip has no pixel grid to
 * snap to, and antialiasing is then uniform anyway).
 *
 * ⚠️ THIS IS THE TAPE-WIDTH BUG, AND IT WAS NEVER IN THE DATA (owner, 2026-09-19, the fifth
 * report). Every strip in `BB_TAPE` is 1.000 in — five rounds confirmed and re-confirmed that —
 * but the map draws at 2–6 device px per inch, so a 1-in strip is e.g. 3.1 px wide and WHERE its
 * edges fall inside a pixel decides what it looks like: one strip lands as three solid columns,
 * its neighbour as two solid and two half-lit ones, and the pair read as different widths and
 * different brightnesses of the same tape. A data fix cannot touch that. So every strip of a zone
 * takes the SAME integer width `round(BB_TAPE_W · scale)` (a side-by-side band a whole multiple
 * of it), anchored on the zone's own snapped outline so the corners of a LOADING ZONE's U meet
 * exactly: an edge on the zone's bounding box takes the box's rounded edge, an end that butts a
 * neighbour one tape-width inside the box takes `box ± width`, and nothing is rounded on its own
 * unless it touches neither.
 */
export function snapTapeGroup(m: BbTapeXform, strips: readonly BbRect[]): [number, number, number, number][] | null {
  const s = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  if (!(s > 0) || strips.length === 0) return null;
  const eps = 1e-6 * s;
  const straight = Math.abs(m.b) < eps && Math.abs(m.c) < eps;
  const quarter = Math.abs(m.a) < eps && Math.abs(m.d) < eps;
  if (!straight && !quarter) return null;
  const dev = (r: BbRect): { x0: number; x1: number; y0: number; y1: number } => {
    const ax = m.a * r.x0 + m.c * r.y0 + m.e;
    const ay = m.b * r.x0 + m.d * r.y0 + m.f;
    const bx = m.a * r.x1 + m.c * r.y1 + m.e;
    const by = m.b * r.x1 + m.d * r.y1 + m.f;
    return { x0: Math.min(ax, bx), x1: Math.max(ax, bx), y0: Math.min(ay, by), y1: Math.max(ay, by) };
  };
  const ds = strips.map(dev);
  const box = {
    x0: Math.min(...ds.map((d) => d.x0)),
    x1: Math.max(...ds.map((d) => d.x1)),
    y0: Math.min(...ds.map((d) => d.y0)),
    y1: Math.max(...ds.map((d) => d.y1)),
  };
  const one = BB_TAPE_W * s;
  const wpx = Math.max(1, Math.round(one));
  const tol = 0.02 * s;
  /** one axis of one strip: `[lo, hi]` in whole device pixels */
  const axis = (lo: number, hi: number, bLo: number, bHi: number, narrow: boolean): [number, number] => {
    const rLo = Math.round(bLo);
    const rHi = Math.round(bHi);
    if (narrow) {
      const w = Math.max(1, Math.round((hi - lo) / one)) * wpx;
      if (Math.abs(lo - bLo) < tol) return [rLo, rLo + w];
      if (Math.abs(hi - bHi) < tol) return [rHi - w, rHi];
      const at = Math.round(lo);
      return [at, at + w];
    }
    const end = (v: number): number => {
      if (Math.abs(v - bLo) < tol) return rLo;
      if (Math.abs(v - bHi) < tol) return rHi;
      if (Math.abs(v - (bLo + one)) < tol) return rLo + wpx; // butts the strip along the box's low edge
      if (Math.abs(v - (bHi - one)) < tol) return rHi - wpx; // ...or its high edge
      return Math.round(v);
    };
    return [end(lo), end(hi)];
  };
  return ds.map((d) => {
    const narrowX = d.x1 - d.x0 <= d.y1 - d.y0;
    const [x0, x1] = axis(d.x0, d.x1, box.x0, box.x1, narrowX);
    const [y0, y1] = axis(d.y0, d.y1, box.y0, box.y1, !narrowX);
    return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
  });
}

/**
 * Paint one zone's strips. On a real canvas they are pixel-snapped as a group (`snapTapeGroup`);
 * a context with no `canvas` behind it — the RENDER lane's recorder — has no device grid, so it
 * gets the world rectangles untouched, which is what that lane compares against the CAD.
 */
function fillTapeGroup(
  ctx: CanvasRenderingContext2D,
  strips: readonly BbRect[],
  fill: string,
  snapAs: readonly BbRect[] = strips,
): void {
  const snapped = ctx.canvas && typeof ctx.getTransform === 'function' ? snapTapeGroup(ctx.getTransform(), snapAs) : null;
  if (!snapped) {
    for (const r of strips) fillStrip(ctx, r, fill);
    return;
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = fill;
  for (const [x, y, w, h] of snapped) ctx.fillRect(x, y, w, h);
  ctx.restore();
}

/** the bounding rectangle of strips that TILE one — the GARDEN's two side-by-side tapes and its
 * corner patch are one 2-in band, and snapping three rectangles separately can open a one-pixel
 * seam between them that snapping the band cannot. */
function bandOf(strips: readonly BbRect[]): BbRect {
  return {
    x0: Math.min(...strips.map((r) => r.x0)),
    y0: Math.min(...strips.map((r) => r.y0)),
    x1: Math.max(...strips.map((r) => r.x1)),
    y1: Math.max(...strips.map((r) => r.y1)),
  };
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

/** tile-centre coordinate of column/row `i` (0..5) — the midpoint of the two CAD seams that
 * bound it, because real tiles are not evenly spaced (`BB_TILE_SEAMS`, and see `BB_TILE_PITCH`).
 * `C.TILE`'s even 24 would put the F column's letter 0.6 in off its own tile. */
function tileCentre(i: number): number {
  return (BB_TILE_SEAMS[i] + BB_TILE_SEAMS[i + 1]) / 2;
}

/**
 * the drawn y-extent of one CELL. `side` is +1 for the north cell (y > 0) and −1 for the south
 * one; `proj` is the SWING's foreshortening factor (`tipProjection`), 1 at either stable end.
 *
 * There is still no PER-CELL length factor, and that is the invariant: both cells are
 * `BB_HIVE_CELL_LEN` long centred `BB_HIVE_CELL_DY` from the pivot, because both numbers are
 * ALREADY the plan projection of one rigid bar at 30° (reference §2.2). Foreshortening ONE of
 * the two would draw a see-saw that bends. `proj` scales BOTH, which is what a rigid bar
 * changing its tilt actually does to a plan view — see `tipProjection`.
 */
function cellSpan(side: number, proj = 1): { y0: number; y1: number } {
  const c = side * BB_HIVE_CELL_DY * proj;
  const h = (BB_HIVE_CELL_LEN * proj) / 2;
  return { y0: Math.min(c - h, c + h), y1: Math.max(c - h, c + h) };
}

/**
 * THE SWING, AS THE PLAN VIEW ACTUALLY SEES IT (owner feedback, 2026-09-12).
 *
 * `tipping` is SECONDS LEFT in the swing (`state.ts`). This turns it into the two numbers the
 * renderer needs, both derived from ONE angle so they cannot disagree:
 *
 *  • `proj` — the FORESHORTENING. Every plan length on the HIVE is a true length times
 *    cos 30°, so at tilt θ it is the true length times cos θ, i.e. the drawn length scales by
 *    `cos θ / cos 30°`. That runs 1 → 1.155 → 1 across the swing: the assembly REACHES OUT as
 *    it comes level and draws back in as it settles the other way. It is small, and it is the
 *    only honest motion a top-down camera has — but it is motion, and it is what makes a TIP
 *    read as a swing rather than as a state that changed while you were looking away.
 *
 *  • `up` — how HIGH the currently-`up` cell is, 1 at its stable top and 0 at the bottom,
 *    taken as its own height `sin θ` normalised over the ±30° travel. Not a linear ramp: a bar
 *    rocking at a steady rate moves its ends FASTEST through level, which is also the instant
 *    the load leaves, so the brightness swaps hardest exactly when the spill appears.
 *
 * At rest (`tipping` 0) this is `{ proj: 1, up: 1 }` and every drawn length is the constant it
 * always was.
 */
export function tipProjection(tipping: number): { proj: number; up: number } {
  if (!(tipping > 0)) return { proj: 1, up: 1 };
  const p = Math.min(1, Math.max(0, 1 - tipping / BB_TIP_SWING_S)); // 0 → 1 across the swing
  const rest = BB_HIVE_TILT_DEG * (Math.PI / 180);
  const tilt = rest * (1 - 2 * p); // +30° → 0 (LEVEL, the release) → −30°
  return {
    proj: dcos(tilt) / dcos(rest),
    up: (dsin(tilt) + dsin(rest)) / (2 * dsin(rest)),
  };
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
  const n = FLOWER_MOUTH[f.wall]; // unit inward normal — one component is 0, the other ±1
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

/**
 * THE FLOWER SECTION — the column cut open beside itself, outside the perimeter.
 *
 * It is the c-flower page from the visuals set with the buttons taken off: the same drawing,
 * driven by the same three functions the SCORER reads the column through (`flowerStackZ`,
 * `flowerScore`, `flowerRetrieve`), so the picture cannot disagree with the points. A readout
 * with its own copy of the stacking arithmetic would drift the first time the middle ring moves.
 *
 * WHAT EACH PART OF IT MEANS, because every one of them is a rule a driver acts on:
 *   • the SHADED BAND is the scoring volume (`BB_FLOWER_VOL_Z`, §10.5.2) — an element inside it
 *     scores 2 for whoever owns the flower and an element below it scores nothing, which is
 *     the single fact a plan view of four discs cannot show.
 *   • the DASHED line is the MIDDLE RING, the sorter: a POLLEN passes it and a NECTAR seats on
 *     it (field-plan §2.2). Dashed and not a gapped bar because V1 prints neither the ring's
 *     thickness nor its hole diameter — `docs/biobuzz/feedback/002-thresholds.md` is the
 *     measurement that would let this be drawn to size, and a drawn hole would be a field
 *     dimension invented in a renderer.
 *   • the SOLID bar at the bottom is the LOWER RING, whose 2.79-in hole passes nothing.
 *   • the TOP RING is stroked in the OWNER's colour — the alliance of the top-most scoring
 *     NECTAR, which collects for every element in the volume whoever put them there.
 *   • the LOCK under the base is G418: retrieval takes the BOTTOM element and only if it is a
 *     POLLEN, so a NECTAR at the bottom shuts the gate. It is drawn in that nectar's own
 *     colour, because the same element is the 5-point BOTTOM NECTAR bonus.
 *
 * `stack` is already JOINED to `world.balls` (ids with no element behind them are gone), so
 * every id here resolves and the z column is the one the scorer computes.
 */
function drawFlowerSection(
  ctx: CanvasRenderingContext2D,
  f: (typeof BB_FLOWERS)[number],
  stack: readonly Artifact[],
): void {
  const fr = sectionFrame(f);
  const R = BB_FLOWER_OPEN_R;
  const ids = stack.map((b) => b.id);
  const kinds = new Map<number, BbElementKind>(stack.map((b) => [b.id, elementKind(b.color)]));
  const kindOf = (id: number): BbElementKind => kinds.get(id) ?? 'pollen';
  const zs = flowerStackZ(ids, kindOf);
  const owner = flowerScore(ids, kindOf).owner;
  const locked = ids.length > 0 && flowerRetrieve(ids, kindOf).id === null;

  const pt = (z: number, t: number): Vec2 => sectionPt(fr, z, t);
  const seg = (z0: number, s0: number, z1: number, s1: number): void => {
    const a = pt(z0, s0);
    const b = pt(z1, s1);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  };
  const quad = (z0: number, z1: number, s: number): void => {
    const c = [pt(z0, -s), pt(z0, s), pt(z1, s), pt(z1, -s)];
    ctx.beginPath();
    ctx.moveTo(c[0].x, c[0].y);
    for (const q of c.slice(1)) ctx.lineTo(q.x, q.y);
    ctx.closePath();
  };

  ctx.save();

  // A STEM from the ring to the panel, so the section belongs to THIS flower and not to the
  // wall in general. It crosses the perimeter, which is drawn after the flowers and covers it.
  ctx.strokeStyle = C.COLORS.wall;
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  const near = pt(0, -(R + SECT_RING));
  ctx.moveTo(f.x, f.y);
  ctx.lineTo(near.x, near.y);
  ctx.stroke();

  /**
   * THE PANEL THE SECTION IS DRAWN ON — `COLORS.mat`, the field's own dark ground, and it is
   * the reason everything above can be drawn in the renderer's ordinary on-field ink.
   *
   * This readout lives OUTSIDE the perimeter, on the BACKDROP, and the backdrop is the one
   * surface in this view that THEMES (`#f9faf7` light, `#20262c` dark). `COLORS.white` is
   * `#e5e7eb`, so a white bore line on the light backdrop is very nearly invisible — the tile
   * ruler out there only survives because `text()` haloes every glyph in near-black. Haloing a
   * drawing is not an option, and a second ink chosen per theme would be a second vocabulary
   * for the same lines.
   *
   * A ground of its own settles it exactly the way the field mat does (`COLORS.mat` never
   * themes — see its declaration): the section is an instrument sitting on the floor beside
   * the board, its outline separates it from either floor, and one set of colours is correct
   * on both. It also says what the drawing IS — a section is a separate diagram beside the
   * plan, not more field.
   */
  const box = pt(0, 0);
  ctx.transform(fr.out.x, fr.out.y, fr.up.x, fr.up.y, box.x, box.y);
  roundRectPath(ctx, -(R + SECT_RING), SECT_Z0, R + SECT_RING, SECT_Z1, 0.9);
  ctx.fillStyle = C.COLORS.mat;
  ctx.fill();
  ctx.strokeStyle = C.COLORS.wall;
  ctx.lineWidth = 0.4;
  ctx.stroke();
  ctx.restore(); // drops the section-frame transform with it — every point below is world

  ctx.save();

  // THE SCORING VOLUME, shaded.
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = C.COLORS.white;
  quad(BB_FLOWER_VOL_Z[0], BB_FLOWER_VOL_Z[1], R);
  ctx.fill();

  // THE BORE — the two inner faces, lower ring to top ring.
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 0.35;
  ctx.beginPath();
  seg(BB_FLOWER_FLOOR_Z, -R, BB_FLOWER_TOP_Z, -R);
  seg(BB_FLOWER_FLOOR_Z, R, BB_FLOWER_TOP_Z, R);
  ctx.stroke();

  // THE MIDDLE RING — see the header: dashed, because its hole is unmeasured.
  ctx.globalAlpha = 0.65;
  ctx.lineWidth = 0.45;
  ctx.setLineDash(CELL_DASH);
  ctx.beginPath();
  seg(BB_FLOWER_MID_Z, -R, BB_FLOWER_MID_Z, R);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // THE LOWER RING — solid, the same ink as the FOOT, because it is the same object seen from
  // the side. Drawn from the tiles up so the section has a visible floor to stand on.
  ctx.save();
  ctx.fillStyle = C.COLORS.wall;
  quad(0, BB_FLOWER_FLOOR_Z, R);
  ctx.fill();
  ctx.strokeStyle = C.COLORS.white;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 0.3;
  ctx.stroke();
  ctx.restore();

  // THE TOP RING — material to each SIDE of the bore, because the bore IS its 4.0-in opening.
  // Owner colour when a NECTAR owns the flower (§10.5.2), white when nobody does.
  ctx.save();
  ctx.strokeStyle = owner ? allianceColor(owner) : C.COLORS.white;
  ctx.globalAlpha = owner ? 1 : 0.7;
  ctx.lineWidth = 0.9;
  ctx.lineCap = 'round';
  ctx.beginPath();
  seg(BB_FLOWER_TOP_Z, R, BB_FLOWER_TOP_Z, R + SECT_RING);
  seg(BB_FLOWER_TOP_Z, -R, BB_FLOWER_TOP_Z, -R - SECT_RING);
  ctx.stroke();
  ctx.restore();

  // THE ELEMENTS, at their real heights and their real radii, in their own colours.
  ctx.save();
  ctx.strokeStyle = 'rgba(12,14,18,0.65)';
  ctx.lineWidth = 0.3;
  stack.forEach((b, k) => {
    const c = pt(zs[k], 0);
    ctx.fillStyle = elementInk(b.color);
    ctx.beginPath();
    ctx.arc(c.x, c.y, elementR(b), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();

  if (!locked) return;

  /**
   * THE LOCK, at the retrieval gate — under the lower ring, where a robot reaches in.
   *
   * Drawn through the section's own axes rather than in world x/y: the glyph has an up and a
   * side of its own, and on the rear and audience walls the section is rotated 90°, so a
   * padlock laid out in world coordinates would be lying on its back on half the field.
   */
  const o = pt(-SECT_LOCK, 0);
  const ink = allianceColor(kindOf(ids[0]) as Alliance);
  // body / shackle / keyhole, in the section's own (across, height) axes. The shackle is the
  // half that makes it a padlock rather than a box, so it is drawn at a padlock's proportions
  // — a little over a third of the glyph — and the arc sweeps t = 0..π, which is the half
  // ABOVE its centre in these axes whichever way the wall has turned them.
  const bodyTop = SECT_LOCK_R * 0.13;
  const w = SECT_LOCK_R * 0.7;
  ctx.save();
  ctx.transform(fr.out.x, fr.out.y, fr.up.x, fr.up.y, o.x, o.y);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.3;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.arc(0, bodyTop, w * 0.62, 0, Math.PI);
  ctx.stroke();
  roundRectPath(ctx, -w, -SECT_LOCK_R, w, bodyTop, 0.25);
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.22;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -SECT_LOCK_R * 0.45, w * 0.3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * THE FOUR FLOWER SECTIONS, ON THEIR OWN — the same four `drawBiobuzzField` draws, callable
 * without the rest of the field.
 *
 * EXPORTED for the 3D OVERHEAD read-out (`drawFlowerReadout.ts`, owner request 2026-09-21: "for
 * the top down view of the 3d render, add a separate thing (like the 2d display) that shows
 * inside the flower"). The 3D shot has the same problem the 2D plan view has and worse — the
 * flower's own top plate is between an overhead camera and the column — and the answer is the
 * SAME DRAWING, not a second one: this function, under a transform that maps field inches onto
 * the 3D camera's own pixels. A forked copy would be a readout that disagrees with the points
 * the first time `flowerStackZ` or the middle ring moves, which is exactly the failure
 * `drawFlowerSection`'s own header was written to prevent.
 *
 * The id→element JOIN is repeated here rather than hoisted out of `drawBiobuzzField`: that
 * function builds ONE map for the hives, the flowers and the nectar boxes together, and splitting
 * it would cost the field renderer a second pass over `world.balls` every frame to save this one
 * a pass it makes only in the 3D overhead view.
 */
export function drawBiobuzzFlowerSections(ctx: CanvasRenderingContext2D, world: World): void {
  const stacks = world.biobuzz?.flowers;
  const byId = new Map<number, Artifact>();
  for (const b of world.balls) byId.set(b.id, b);
  BB_FLOWERS.forEach((f, i) => {
    const ids = stacks?.[i]?.stack ?? [];
    drawFlowerSection(
      ctx,
      f,
      ids.map((id) => byId.get(id)).filter((b): b is Artifact => b !== undefined),
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// THE RENDERER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE CONTENTS — ONE ROW OF DISCS HUGGING THE OPEN EDGE, INSIDE THE BOX.
 *
 * At element scale and in element colours, oldest at the −x end, so the row grows the same
 * way every time and a NECTAR arriving at the far end is visibly the newest thing in the
 * cell. Against the OPEN edge (`outerY`, the box's outer short edge; `s` is +1 for the north
 * cell) because that is the end everything came in through; against the closed back it would
 * read as the far wall of a container nothing can reach.
 *
 * A full cell holds more diameters than the 20-in width has room for (3 NECTAR and 8 POLLEN
 * is 30.8 in of ball), so when the row runs long the PITCH closes up and the discs overlap
 * while their RADII stay true. Shrinking the balls instead would make a NECTAR and a POLLEN
 * the same size, which is the one distinction the row exists to carry; overlapping reads as
 * packed, which is what a full cell is.
 *
 * `alpha` is the cell's own fill weight through the swing (`tipProjection`'s `up`, 1 at rest),
 * so the row fades with the tray it is in. Shared with `drawHiveCanopy`, which repaints it over
 * whatever drove under the structure.
 */
function drawCellContents(
  ctx: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  outerY: number,
  s: number,
  contents: readonly Artifact[],
  alpha: number,
): void {
  if (contents.length === 0) return;
  const rMax = contents.reduce((m, b) => Math.max(m, elementR(b)), 0);
  const rowY = outerY - s * (rMax + CELL_ROW_IN);
  const span = x1 - x0 - 2 * CELL_ROW_PAD;
  const want = contents.reduce((t, b) => t + 2 * elementR(b), 0);
  const pitch = want > span ? span / want : 1;
  let t = x0 + CELL_ROW_PAD + Math.max(0, (span - want) / 2);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = 'rgba(12,14,18,0.65)';
  ctx.lineWidth = 0.3;
  for (const b of contents) {
    const r = elementR(b);
    t += r * pitch;
    ctx.fillStyle = elementInk(b.color);
    ctx.beginPath();
    ctx.arc(t, rowY, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    t += r * pitch;
  }
  ctx.restore();
}

/**
 * HOW MUCH OF THE HIVE SHOWS THROUGH WHATEVER IS UNDER IT — the canopy's opacity.
 *
 * The robot and the pollen beneath the structure are drawn at full strength and the canopy is
 * laid over them at this alpha, so what a driver sees is the robot at `1 − CANOPY_A` of itself
 * through the assembly, only where the assembly actually is. "Slightly translucent" (owner,
 * 2026-09-13): the robot has to stay readable enough to drive by, and the structure has to
 * read as overhead rather than as a stain on the deck. 0.42 is the wash at which both hold in
 * both themes; the up cell's own fill rides on top at its usual weight times this.
 */
const CANOPY_A = 0.42;

/**
 * THE CANOPY — the HIVE assembly repainted, TRANSLUCENTLY, over everything that was drawn after
 * the field (owner feedback, 2026-09-13: "make the robot and pollen that are below the hive
 * slightly translucent… only the portion that is below the hive").
 *
 * The HIVE hangs 25.5 in over the tiles and G409 assumes robots drive under it, but the field
 * is drawn FIRST and the robots and the ground elements after it, so a robot under the
 * structure was painted ON TOP of a thing that is physically above it. This pass, called from
 * the element renderer (`draw.ts`, the last of the three drawing slots) once the robots and the
 * ground elements are down and before the airborne ones go on, puts the assembly back on top:
 * the body, the up cell's fill and its contents row, at `CANOPY_A`, over exactly the assembly's
 * own footprint and nothing else. A robot half under the hive is half dimmed; a POLLEN spilled
 * under the down cell is dimmed; the rest of both is untouched, because there is nothing over
 * them.
 *
 * It is NOT a `globalAlpha` on the robot sprite. That fades the whole robot — the part in the
 * open as much as the part under the structure — and the ruling is specifically the portion
 * below the hive. Clipping the robot instead would need every game's sprite to know about this
 * field. Repainting the structure is the one place the footprint is already known.
 *
 * ⚠️ **IT COMPOSITES THROUGH AN OFFSCREEN LAYER, AND THAT IS NOT AN OPTIMISATION — IT IS THE
 * ONLY WAY TO GET THE BLEND RIGHT.** The first version painted the structure's parts straight
 * onto the field with each part's alpha pre-multiplied by `CANOPY_A`, and that is not the same
 * arithmetic: the body wash took 42% of the CELL's colour away and the cell was added back at
 * only `0.45 × 0.42` of it, so the tray came out muted and the whole assembly read as a haze
 * over the field where nothing was under it at all. Measured on the `under-hive` cell, the mat
 * and both trays changed colour even where no robot overlapped them, which is exactly what the
 * pass must not do. Drawn into a transparent layer at FULL field-pass weight and blitted once
 * at `CANOPY_A`, the result is exactly `CANOPY_A × structure + (1 − CANOPY_A) × whatever is
 * beneath` — so a pixel with only the mat under it is repainted with the same structure that is
 * already there and does not change at all, and only a pixel with a robot or a POLLEN under it
 * is dimmed. The layer is cached and re-used; it is resized only when the canvas is.
 *
 * Reads the same state the field pass reads, through the same helpers (`tipProjection`,
 * `cellSpan`, `drawCellContents`), so the canopy swings with the swing and its contents row is
 * the field's row: two drawings of one hive that cannot disagree about where it is. The down
 * cell's dashed outline and the edge marks are not repainted — lines that thin over a robot
 * are noise, and the body wash already says "structure here".
 */
/** the canopy's compositing layer, kept between frames — see `drawHiveCanopy`. */
let canopyLayer: HTMLCanvasElement | null = null;

/**
 * THE STRUCTURE ITSELF, at full weight — the body, each cell's fill, and the taking cell's
 * contents row. Shared by the canopy layer; the FIELD pass draws the same shapes inline with
 * its own edge marks and dashed outline, which are lines too fine to repaint over a robot.
 */
function paintHiveAssembly(ctx: CanvasRenderingContext2D, world: World): void {
  const bb = world.biobuzz;
  const byId = new Map<number, Artifact>();
  for (const b of world.balls) byId.set(b.id, b);
  for (const a of ALLIANCES) {
    const h = bb?.hives?.[a];
    const up = h?.up ?? BB_HIVE_UP_STAGED[a];
    const taking = h ? hiveTakingSide(h) : BB_HIVE_UP_STAGED[a];
    const px = a === 'red' ? -BB_HIVE_X : BB_HIVE_X;
    const x0 = px - BB_HIVE_W / 2;
    const x1 = px + BB_HIVE_W / 2;
    const { proj, up: f } = tipProjection(h?.tipping ?? 0);
    const bodyHalf = (BB_HIVE_LEN / 2) * proj;

    ctx.save();
    roundRectPath(ctx, x0, -bodyHalf, x1, bodyHalf, HIVE_R);
    ctx.fillStyle = C.COLORS.tile;
    ctx.fill();
    ctx.strokeStyle = C.COLORS.wall;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.restore();

    for (const side of ['north', 'south'] as const) {
      const s = side === 'north' ? 1 : -1;
      const { y0, y1 } = cellSpan(s, proj);
      const k = up === side ? f : 1 - f;
      if (k > 0.01) {
        ctx.save();
        roundRectPath(ctx, x0, y0, x1, y1, HIVE_R);
        ctx.globalAlpha = k * CELL_FILL_A;
        ctx.fillStyle = allianceColor(a);
        ctx.fill();
        ctx.globalAlpha = k;
        ctx.strokeStyle = allianceColor(a);
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.restore();
      }
      if (side !== taking) continue;
      const outerY = s > 0 ? y1 : y0;
      const contents = (h?.contents ?? []).map((id) => byId.get(id)).filter((b): b is Artifact => b !== undefined);
      drawCellContents(ctx, x0, x1, outerY, s, contents, k);
    }
  }
}

export function drawHiveCanopy(ctx: CanvasRenderingContext2D, world: World): void {
  const { canvas } = ctx;
  const w = canvas.width;
  const h = canvas.height;
  if (w <= 0 || h <= 0) return;
  // a canvas that has not been laid out is 0x0 and `getContext` on the layer would be useless
  if (!canopyLayer) canopyLayer = document.createElement('canvas');
  if (canopyLayer.width !== w || canopyLayer.height !== h) {
    canopyLayer.width = w;
    canopyLayer.height = h;
  }
  const lc = canopyLayer.getContext('2d');
  if (!lc) return;
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.clearRect(0, 0, w, h);
  // the SAME camera transform the field was drawn under, so the layer's structure lands exactly
  // on top of the structure already on the field
  lc.setTransform(ctx.getTransform());
  paintHiveAssembly(lc, world);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = CANOPY_A;
  ctx.drawImage(canopyLayer, 0, 0);
  ctx.restore();
}

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
  /** the cell CONTENTS belong to — `up` at rest, and through a swing whichever tray is taking
   * elements (`hiveTakingSide`), which flips to the incoming one at the release. Drawing the
   * row off `up` alone puts a post-release capture in the wrong box for the rest of the swing. */
  const takingCell = (a: Alliance): 'north' | 'south' => {
    const h = bb?.hives?.[a];
    return h ? hiveTakingSide(h) : BB_HIVE_UP_STAGED[a];
  };

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

  // TILE GRID — the six real soft tiles per axis, at the CAD's own measured SEAM POSITIONS
  // (`BB_TILE_SEAMS`). Not decoration: the tile grid is how a driver judges distance on an FTC
  // field, and §9.3 says every tape line stays inside one tile, so the seams are also what the
  // zone rectangles below are measured against — which only works if they are the same seams.
  //
  // ⚠️ NOT `C.TILE`. That is 24, DECODE's nominal tile; a real FTC soft tile is `BB_TILE_PITCH`
  // 23.528 on centre and the six of them close on 141.17, not 144. Stepping by 24 from the wall
  // drew a grid that drifted almost half an inch per tile away from the tape, the flowers and the
  // GLB. The seven lines are the two perimeter edges and the five tile JOINTS, evenly spaced at
  // 23.502 (the outer tiles are cut straight and run 23.581); the 3D mat draws the dovetail about
  // the same joints (`scene/renderTiles.ts`).
  ctx.save();
  ctx.strokeStyle = C.COLORS.tile;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (const s of BB_TILE_SEAMS) {
    ctx.moveTo(s, -hy);
    ctx.lineTo(s, hy);
    ctx.moveTo(-hx, s);
    ctx.lineTo(hx, s);
  }
  ctx.stroke();
  ctx.restore();

  // ⚠️ NO CENTRE MARK (owner, 2026-09-19: "centre cross tape mark does not exist, I think").
  // It does not. Event Field Guide V1.0 §8 "Tape Placement" installs exactly three things —
  // §8.3 LOADING ZONES, §8.4 GARDENS, §8.5 ALLIANCE AREAS — and Fig 9-2 (manual p65) shows no
  // marking at the origin. It could not have one: §9.1 of the guide has you REMOVE the four
  // centre tiles for the frame's under-tile strips, so the origin is under the HIVE structure,
  // which this file already draws as the two base bars and the dashed crossbar.
  //
  // What was here was a white cross 8 in across at `C.TAPE_W`, added to make a gallery still
  // self-orienting. That is a reason to want a mark, not a reason for the field to have one, and
  // drawn in tape's own width it read as tape. The stills are oriented by the tile seams, the
  // frame bars and the two hives, all of which are real.

  // LOADING ZONES (§9.3, Fig 9-2/9-3) — ~23 × 11 against the side wall, bounded by tape and
  // the wall, tape included. The layout is POINT-SYMMETRIC, so red's is at y > 0 on the LEFT
  // wall and blue's is the diagonal opposite; `BB_LZ` carries that, and a loop that
  // "corrected" it into an x-mirror would produce a field that is internally consistent and
  // wrong.
  //
  // ⚠️ TAPE, NOT STRUCTURE (owner ruling, 2026-09-12). Nothing collides with a zone — robots
  // drive over it and elements roll across it, and `colliders.ts` has never had an entry for
  // one. So it is drawn as the 1-in tape it is, with the MAT showing through. A filled bar
  // reads as a wall, which is a drawing that tells a driver something false about what they
  // can drive on.
  //
  // ⚠️ AND IT IS THE STRIPS, NOT AN OUTLINE OF THE ZONE (owner, 2026-09-18; audit §5). A LOADING
  // ZONE has THREE tapes — two depth edges and the inner, field-side edge — because its fourth
  // side is the perimeter wall, and a wall-bounded edge carries no tape. A GARDEN has TWO, laid
  // side by side, which IS its 2-in band: nothing across its ends, nothing on the two walls it
  // sits in the corner of. Stroking `BB_LZ`/`BB_GARDEN` instead drew tape on the wall and turned
  // the garden's solid band into a 1-in outline of a 2-in rectangle. `BB_TAPE` is the CAD's own
  // 16 strips and the 3D renderer draws exactly the same rectangles.
  //
  // `gardenSupplement` is the one strip per alliance that is NOT in the CAD: the measured band
  // stops 0.573 in clear of the corner wall, while `BB_GARDEN` — the SCORED zone — snaps that
  // edge onto it, so the band as drawn stopped short of the corner it is defined to reach. See
  // `fieldDims.gen.ts`'s header for why it is a separate group.
  for (const a of ALLIANCES) {
    // each ZONE is snapped to the pixel grid as a group, at one tape width — `snapTapeGroup`
    fillTapeGroup(ctx, BB_TAPE.loadingZone[a], TAPE_GAFFER[a]);
    const garden = [...BB_TAPE.garden[a], ...BB_TAPE.gardenSupplement[a]];
    fillTapeGroup(ctx, garden, TAPE_GAFFER[a], [bandOf(garden)]);
  }

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
  //
  // ⚠️ NOTHING IN A CELL IS A LETTER OR A DIGIT (owner ruling, 2026-09-12; field-plan §2.5).
  // A ball is drawn as a ball, in its colour, wherever it is — so the contents are a ROW OF
  // DISCS at element scale and the per-type counts they replace are gone. A count is a thing
  // you read; a row of colours is a thing you SEE, and the two facts a driver acts on (how
  // many NECTAR, because the tip table is indexed by it, and how full the cell is) are both
  // in the picture without anyone parsing "3n 2p" at 60 Hz.
  for (const a of ALLIANCES) {
    const px = a === 'red' ? -BB_HIVE_X : BB_HIVE_X;
    const x0 = px - BB_HIVE_W / 2;
    const x1 = px + BB_HIVE_W / 2;
    const up = upCell(a);
    const ink = allianceColor(a);

    /**
     * THE SWING, AS THE SWING (owner feedback, 2026-09-12).
     *
     * `tipping` is SECONDS LEFT in the swing (`state.ts`), counted down by `hive.ts`, and `up`
     * still names the cell that is going DOWN until the swing completes. `tipProjection` turns
     * the countdown into the bar's ANGLE and hands back the two things the drawing needs: how
     * far the assembly is foreshortened right now (`proj`), and how high the `up` cell is
     * (`f`). Both are read off ONE angle, so the geometry and the brightness cannot animate on
     * different clocks.
     *
     * This replaces a plain linear cross-fade. The fade alone was the entire animation, at cell
     * alpha, over four seconds — slow enough per frame to be invisible and yet the only thing
     * moving, so a TIP looked like a state that had simply changed. Now the bar visibly REACHES
     * as it comes level and draws back in as it settles, the brightness swaps hardest at the
     * level crossing, and the level crossing is the instant the load falls out.
     *
     * The swing length is IMPORTED from `hive.ts` rather than written here, because a renderer
     * with its own copy of it is an animation that finishes at a different instant from the
     * flip it is animating — the one bug this whole device can have.
     */
    const tipping = bb?.hives?.[a]?.tipping ?? 0;
    const { proj, up: f } = tipProjection(tipping);
    const bodyHalf = (BB_HIVE_LEN / 2) * proj;

    // the assembly body — the connecting bar and shell the two cells ride on.
    ctx.save();
    roundRectPath(ctx, x0, -bodyHalf, x1, bodyHalf, HIVE_R);
    ctx.fillStyle = C.COLORS.tile;
    ctx.fill();
    ctx.strokeStyle = C.COLORS.wall;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.restore();

    for (const side of ['north', 'south'] as const) {
      const s = side === 'north' ? 1 : -1;
      const isUp = up === side;
      // SAME SIZE, BOTH ENDS. See `cellSpan` — one rigid bar projects both cells by the same
      // cosine at every instant of the swing, so UP is said by the FILL, not by shape.
      const { y0, y1 } = cellSpan(s, proj);
      const k = isUp ? f : 1 - f; // 1 = fully up (filled), 0 = fully down (outline)

      /**
       * UP IS A FILLED BOX; DOWN IS A DASHED OUTLINE WITH NOTHING IN IT.
       *
       * The down cell hangs 25.5 in over the tiles and G409 assumes robots drive under it, so
       * it is not a surface — a dim FILL said it was, and it also hid anything on the floor
       * beneath it. An outline says "structure overhead" the same way the frame crossbar's
       * dashes do, and the ground balls `draw.ts` paints afterwards land ON TOP of it, which
       * is how a spill reads as floor rather than as cell contents.
       */
      if (k > 0.01) {
        ctx.save();
        roundRectPath(ctx, x0, y0, x1, y1, HIVE_R);
        ctx.globalAlpha = k * CELL_FILL_A;
        ctx.fillStyle = ink;
        ctx.fill();
        ctx.globalAlpha = k;
        ctx.strokeStyle = ink;
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.restore();
      }
      if (k < 0.99) {
        ctx.save();
        ctx.globalAlpha = 1 - k;
        ctx.setLineDash([...CELL_DASH]);
        roundRectPath(ctx, x0, y0, x1, y1, HIVE_R);
        ctx.strokeStyle = ink;
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      /**
       * THE OPEN FACE, MARKED BY WEIGHT (owner ruling, 2026-09-12).
       *
       * A CELL is a prism open at its OUTER end only — the end away from the pivot — and
       * `hiveAccepts` gates a shot on arriving TOWARD the pivot along the hive axis
       * (field-plan §2.1), so which end is open is the difference between a scoring launch and
       * one that bounces off the back. Drawn as line WEIGHT rather than as a legend: the thin
       * edge is the opening, the heavy one is the closed back. Both are structure, so neither
       * fades with the swing — the box is open at the same end whichever way it is pointing.
       * Inset by the corner radius so each mark sits on its edge's flat run.
       */
      const outerY = s > 0 ? y1 : y0;
      const pivotY = s > 0 ? y0 : y1;
      ctx.save();
      ctx.strokeStyle = ink;
      ctx.lineCap = 'round';
      for (const [ey, w] of [
        [pivotY, CELL_EDGE_HEAVY],
        [outerY, CELL_EDGE_THIN],
      ] as const) {
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(x0 + HIVE_R, ey);
        ctx.lineTo(x1 - HIVE_R, ey);
        ctx.stroke();
      }
      ctx.restore();

      // the CONTENTS ride the tray that is TAKING elements, which is not `up` once the bar has
      // passed level (`hiveTakingSide`).
      if (side !== takingCell(a)) continue;

      /**
       * THE CONTENTS — ONE ROW OF DISCS HUGGING THE OPEN EDGE, INSIDE THE BOX.
       *
       * At element scale and in element colours, oldest at the −x end, so the row grows the
       * same way every time and a NECTAR arriving at the far end is visibly the newest thing
       * in the cell. Against the OPEN edge because that is the end everything came in through;
       * against the closed back it would read as the far wall of a container nothing can reach.
       *
       * A full cell holds more diameters than the 20-in width has room for (3 NECTAR and 8
       * POLLEN is 30.8 in of ball), so when the row runs long the PITCH closes up and the
       * discs overlap while their RADII stay true. Shrinking the balls instead would make a
       * NECTAR and a POLLEN the same size, which is the one distinction the row exists to
       * carry; overlapping reads as packed, which is what a full cell is.
       */
      drawCellContents(ctx, x0, x1, outerY, s, elements(bb?.hives?.[a]?.contents), k);
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
     * THE STACK READOUT — A SECTION OF THE COLUMN, OUTSIDE THE PERIMETER (owner ruling,
     * 2026-09-12; `drawFlowerSection`).
     *
     * DRAWN EVEN WHEN THE FLOWER IS EMPTY, which the row of discs it replaces was not. An
     * empty section is a rule on the field — the band an element has to reach and the ring it
     * has to pass — and a readout that appears only once something is in there makes "F1 is
     * empty" and "F1 has no readout" the same picture.
     *
     * WHY NOT A COUNT. The number of elements in a FLOWER decides nothing; the ORDER and the
     * HEIGHTS decide everything. The bottom-most NECTAR is the 5-point bonus and the thing
     * that locks retrieval (G418), the top-most NECTAR is who owns the flower and collects 2
     * per element in the volume (§10.5.2), and a POLLEN under the middle ring is worth zero.
     * A badge says none of that; the section says all four at a glance.
     */
    drawFlowerSection(ctx, f, elements(bb?.flowers?.[i]?.stack));
  });

  /**
   * THE HUMAN PLAYER'S NECTAR HOLDING BOX (owner, 2026-09-19: "Add the same andymark box in the
   * 2d game as well").
   *
   * The SAME box the 3D field builds — `am-5706 Artifact Tray`, at the same field position, from
   * the same `./nectarBox.ts`. Not a second drawing of a similar thing: a driver who switches
   * views must find the supply in the same place, and two copies of the footprint is exactly how
   * that stops being true.
   *
   * IN THE 2D IDIOM, which here means the same three moves the FLOWER FOOT and the HIVE CELLS
   * already make — a solid for the structure, a 1:1 outline for the part you interact with, and
   * the contents as DISCS AT ELEMENT SCALE rather than a number (§2.5: nothing on this field is
   * a letter or a digit). The tray reads as its dark interior inside an alliance-coloured rim,
   * which is what the 3D tray is: a dark slab inside bright side walls, seen from above.
   *
   * OUTSIDE THE PERIMETER, in the camera's own view margin, like the tile ruler and the flower
   * sections. `BB_BOX_GAP + BB_BOX_DEPTH` is 11.75 against `BB_VIEW_MARGIN`'s 12 — see
   * `nectarBox.ts`, where that quarter inch is the reason the gap is the number it is.
   *
   * THE COUNT IS READ OFF `world.balls`, never stored, exactly as the 3D box and `hud.ts` read
   * it — one pass for `stock` elements of this alliance. Over six (there are five) simply
   * under-draws beads; the supply is still whatever the world says it is.
   *
   * DRAWN BEFORE THE PERIMETER AND LONG BEFORE THE LABELS, on purpose. The tile ruler's last row
   * digit sits at `-hx - WALL_INSET` on this same wall and its centre falls inside the tray's
   * length, so in LABELLED stills (the gallery only — a match draws no labels at all) the digit
   * lands on the tray. Over the dark interior it stays legible; under it, it would not.
   */
  for (const a of ALLIANCES) {
    const box = bbNectarBoxRect(a);
    ctx.save();
    ctx.fillStyle = C.COLORS.tile;
    ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    ctx.strokeStyle = allianceColor(a);
    ctx.lineWidth = BB_BOX_T;
    // inset by half the wall thickness, so the stroke's OUTER face is the tray's real outline
    // rather than straddling it — the same rule the HIVE frame bar is drawn by above.
    ctx.strokeRect(
      box.x0 + BB_BOX_T / 2,
      box.y0 + BB_BOX_T / 2,
      box.x1 - box.x0 - BB_BOX_T,
      box.y1 - box.y0 - BB_BOX_T,
    );
    let stock = 0;
    for (const b of world.balls) if (b.state.kind === 'stock' && b.state.alliance === a) stock++;
    ctx.fillStyle = allianceColor(a);
    for (let i = 0; i < Math.min(stock, BB_BOX_SLOTS); i++) {
      const slot = bbNectarBoxSlot(a, i);
      ctx.beginPath();
      ctx.arc(slot.x, slot.y, BB_NECTAR_R, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // PERIMETER — drawn last, so it sits over the grid lines and the garden tape that run into
  // it. `PERIMETER_W` and not a tape width: this is the WALL, and no tape on this field runs
  // onto the perimeter (Field Guide §8.3/§8.4 start every strip at a tile seam). It read as
  // `C.TAPE_W` for the coincidence that both are 1 in, which made the wall line move whenever
  // the tape width did.
  ctx.save();
  ctx.strokeStyle = C.COLORS.white;
  ctx.lineWidth = PERIMETER_W;
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
  // AT THE CELL'S PIVOT END, which is the half of the box with nothing in it. Canvas text is
  // upright on SCREEN, so the string's LENGTH runs along world y — the same axis the cell is
  // only BB_HIVE_CELL_LEN (10.43) long in — and the contents row hugs the OPEN edge, so the
  // ids and the elements are competing for the same inches. The closed back is free by
  // construction: nothing ever sits against it.
  for (const a of ALLIANCES) {
    const px = a === 'red' ? -BB_HIVE_X : BB_HIVE_X;
    for (const side of ['north', 'south'] as const) {
      const ids = BB_HIVE_TAGS[a][side];
      const sgn = side === 'north' ? 1 : -1;
      const isUp = (bbLabels?.hives?.[a]?.up ?? BB_HIVE_UP_STAGED[a]) === side;
      const { y0, y1 } = cellSpan(sgn);
      const pivotY = sgn > 0 ? y0 : y1;
      text(
        ctx,
        screenUp,
        px,
        pivotY + sgn * CELL_TAG_IN,
        TAG_SIZE,
        C.COLORS.white,
        `${ids[0]}-${ids[ids.length - 1]}`,
        isUp ? 0.85 : 0.55,
      );
    }
  }

  // FLOWER ids, offset ALONG the wall rather than into the field — the field side is where
  // the stack badge goes, and a label that moves depending on whether a flower happens to be
  // empty is worse than one that is always in the same place.
  for (const f of BB_FLOWERS) {
    const d = FLOWER_MOUTH[f.wall];
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
