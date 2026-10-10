import * as THREE from 'three';
import type { Alliance, World } from '../../../types';
import * as C from '../../../config';
import {
  BB_FLOWERS,
  BB_FLOWER_D,
  BB_FLOWER_FOOT,
  BB_FLOWER_OPEN_R,
  BB_FLOWER_TOP_Z,
  BB_FRAME_BAR_IN,
  BB_FRAME_BAR_OUT,
  BB_FRAME_Y,
  BB_HALF_X,
  BB_HALF_Y,
  BB_HIVE_OPEN_Z,
  BB_HIVE_TILT_DEG,
  BB_HIVE_X,
  BB_NECTAR_R,
  BB_WALL_T,
  BB_TAPE,
  BB_TILE_SEAMS,
  FLOWER_MOUTH,
  type BbRect,
} from '../config';
import { snapTapeGroup } from '../drawField';
import { BB_FLOWER_FLOOR_Z, BB_FLOWER_MID_Z } from '../flower';
import {
  BB_BOX_DEPTH,
  BB_BOX_H,
  BB_BOX_LEN,
  BB_BOX_SLOTS,
  BB_BOX_T,
  bbNectarBoxCentre,
  bbNectarBoxSlot,
} from '../nectarBox';
import { hiveTiltAngle, hiveTrayRefTheta } from '../sim3d/tilt';
import { cellPanelMaterial, loadFieldGlb, wallPanelMaterial, type FieldGroups } from './renderFieldGlb';
import {
  bbTileDetail,
  tileOutline,
  tileSeamPaths,
  tileTone,
  TILE_JOINT,
  TILE_JOINT_SHADE,
  TILE_JOINT_SHADE_W,
  TILE_JOINT_W,
  TILE_TEX_SIZE,
  TILE_VOID,
  type BbTileDetail,
} from './renderTiles';

/**
 * BIOBUZZ 3D SCENE — the field: floor, walls, the two hives (frame + tilting tray) and the four
 * flowers (Day 1, `docs/biobuzz/plan-3d.md` §4.2, §13.1).
 *
 * Coordinates: field inches, z UP. Every dimension not printed in the manual (walls, uprights,
 * flower pipes, ring tube thickness) is flagged `APPROX` at its declaration, same convention as
 * `src/games/biobuzz/config.ts`. Values the plan doc's own §13.1 table gives (`BB3_HIVE_PIVOT_Z`
 * etc.) are cited by name even though they are not (yet) exported constants anywhere — Lane A's
 * `sim3d/bodies.ts` is the only other place they would need to agree with this file, and neither
 * lane has landed a shared home for them yet (see the report's gotchas).
 */

// ── HIVE — 3D-only constants (plan-3d.md §13.1; not exported anywhere in the 2D config) ───────
/** pivot height above the tiles, in — `BB3_HIVE_PIVOT_Z`. */
const HIVE_PIVOT_Z = 43.95;
/** true (unprojected) distance from the pivot to a cell's centre along the arm, in —
 * `BB3_HIVE_ARM`. The 2D `BB_HIVE_CELL_DY` (13.37) is this value's PLAN projection
 * (`15.44 * cos 30°`); the tray's own local geometry below uses the true length because it is
 * built in the tray's un-rotated local frame and Three.js applies the tilt itself. */
const HIVE_ARM = 15.44;
/** true cell depth along the arm, in — `BB3_HIVE_CELL_LEN` (12.04, the manual/CAD length; NOT
 * the same-named 2D `BB_HIVE_CELL_LEN`, which is this value's plan projection, 10.43). */
const HIVE_CELL_DEPTH = 12.04;
/** cell width across the hive (x, unforeshortened) and height (z, local, before tilt) —
 * `BB3_HIVE_CELL`'s 20 × 14 × 12.04. The 14 is the plan doc's own figure for this box; nothing
 * in `config.ts` names it, so it is APPROX here exactly as it is there. */
const HIVE_CELL_W = 20;
const HIVE_CELL_H = 14; // APPROX — plan-3d.md §13.1
/** true bar length end to end, in — the 2D `BB_HIVE_LEN` (37.16) is this value's cos 30°
 * projection; 37.16 / cos(30°) ≈ 42.91, the figure the plan doc's prose gives directly. */
const HIVE_BAR_LEN = 42.91;
const HIVE_TILT_REST = (BB_HIVE_TILT_DEG * Math.PI) / 180; // ±30°, shared with the 2D renderer

/** `BB3_HIVE_CELL_WALL` (plan-3d.md §13.1): the cell shell thickness, in. APPROX, CAD settles. */
const HIVE_CELL_WALL = 0.25;

/** local y (before tilt), measured from the pivot along the arm, of the cell's OUTER (open)
 * face — the plane the manual's opening heights (`BB_HIVE_OPEN_Z`) are measured at. */
const HIVE_CELL_OUTER_Y = HIVE_ARM + HIVE_CELL_DEPTH / 2;

/**
 * THE CELL BOX'S OWN LOCAL Z-CENTRE (before tilt), SOLVED rather than guessed, so the built
 * geometry reproduces `BB_HIVE_OPEN_Z` (53.5 / 65.6, Fig 9-10) at the true 30° stable state
 * instead of merely resembling it.
 *
 * A point at local `(x, HIVE_ARM ± HIVE_CELL_DEPTH/2, z)` on a tray tilted `HIVE_TILT_REST`
 * about the pivot lands at world height `HIVE_PIVOT_Z + y·sin(tilt) + z·cos(tilt)`. The
 * manual's BOTTOM-of-opening figure is exactly that, evaluated at the OUTER face
 * (`HIVE_CELL_OUTER_Y`) and at the box's own bottom (`z = HIVE_CELL_Z0 − HIVE_CELL_H/2`).
 * Solving for `HIVE_CELL_Z0` there (rather than centring the box at an arbitrary local z, which
 * the first pass did and which landed the opening about 3 in high) is what makes the TOP come
 * out within a few hundredths of an inch of 65.6 on its own — one equation fixes both ends
 * because `HIVE_CELL_H` (14) already matches `BB_HIVE_OPEN_Z`'s own span (12.1) to within
 * rounding.
 *
 * ⚠️ THE DOWN CELL'S OWN FLOOR DOES NOT COME OUT AT `BB_HIVE_BOTTOM_Z` (25.5) under this same
 * rigid-bar model — it lands around 32 in. The two manual figures cannot both be hit by one
 * cell box rotating rigidly about one pivot at `HIVE_ARM`: solving the up-cell's opening (this
 * constant) trades away the down-cell's floor height, and centring the box in between trades
 * away the up-cell's opening instead. This is reported as a real, unresolved discrepancy for
 * the SIM lane (`docs/biobuzz/plan-3d.md` §3.6's dynamic tray, or a future two-part CAD tray),
 * not something a fallback constants box can also get right — see the report's item (f)/(g).
 */
const HIVE_CELL_Z0 =
  (BB_HIVE_OPEN_Z[0] - HIVE_PIVOT_Z - HIVE_CELL_OUTER_Y * Math.sin(HIVE_TILT_REST)) / Math.cos(HIVE_TILT_REST) +
  HIVE_CELL_H / 2;

/** wall visual thickness and height, in — APPROX (`BB_WALL_T` is the oversized PHYSICS collider
 * half-thickness, deliberately far thicker than any real wall; this is what a driver should
 * actually see). "12 in high APPROX" per the Day 1 brief. */
const WALL_VIS_T = 2;
const WALL_VIS_H = 12; // APPROX

/** flower APPROX dimensions not named in `config.ts` (see `flower.ts`'s own APPROX comments for
 * the two heights reused here: `BB_FLOWER_FLOOR_Z`, `BB_FLOWER_MID_Z`). */
const FLOWER_LOWER_RING_R = 2.79 / 2; // APPROX — flower.ts's own comment: "2.79-in hole"
const FLOWER_MID_RING_R = 3.2 / 2; // APPROX — `BB3_FLOWER_MID_HOLE` (plan-3d.md §13.1)
const FLOWER_TUBE_R = 0.3; // APPROX — ring material thickness, undocumented
const FLOWER_PIPE_R = 0.35; // APPROX — support pipe radius, undocumented
const FLOWER_FOOT_H = 2; // APPROX — foot slab height, undocumented
/** the BACKSTOP on top of each flower (§9.7). Height is the manual's own 1.25 in; the CAD plate
 * (`am-5884`, audit §6) is 0.25 in thick, 5.49 in across and purple `#641c65` — its measured
 * colour, which is why this is a literal and not a theme token (the CAD path reads the same hex
 * out of the glTF material). Width is APPROX: the fallback's ring is built at `BB_FLOWER_OPEN_R`,
 * not at the CAD's plate outline. */
const FLOWER_BACKSTOP_H = 1.25;
const FLOWER_BACKSTOP_T = 0.25;
const FLOWER_BACKSTOP_W = 5.49; // APPROX — the CAD plate's span, on this path's own ring
const FLOWER_BACKSTOP_COLOR = '#641c65';

const ALLIANCES: readonly Alliance[] = ['red', 'blue'];

// ── materials (flat colours, MeshStandardMaterial only — no textures beyond the floor) ────────
function mat(color: string, opacity = 1): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    side: opacity < 1 ? THREE.DoubleSide : THREE.FrontSide,
  });
}

// ── the floor texture: the tile SEAM GRID, and the tape on the fallback path, on
// `drawField.ts`'s own colour tokens. Generated ONCE at scene creation, never per frame. ──────
//
// ⚠️ NO TAPE HERE ON THE CAD PATH. The previous version painted `strokeRectTex(BB_LZ[a], …)` and
// `strokeRectTex(BB_GARDEN[a], …)` — a full four-sided outline of each zone rectangle — which is
// the owner's "tape marks on the ground are also incorrect … zones bounded with the wall don't
// have tape on the wall". The CAD carries 16 real gaffer-tape parts, all 1.000 in wide, and every
// one of them is now drawn from the GLB's own `tape` node (`glbFieldToHandles`). The procedural
// tape below survives ONLY for the constants-built fallback, and it draws the CAD's own layout:
// three sides of each LOADING ZONE (the wall side bare) and the GARDEN as the solid 2-in band its
// two side-by-side 1-in tapes actually make. `docs/biobuzz/field-cad-audit.md` §5 has the parts.
//
// The SEAM GRID is painted at the CAD's own pitch and footprint when the collider set carries
// them (23.53 in over ±70.585, not `C.TILE`'s 24 over ±72 — audit §7), so the seams line up with
// the CAD tape lying on top of them. It falls back to the constants when they are absent.
// ⚠️ THE CANVAS EDGE IS THE TIER'S NOW (`TILE_TEX_SIZE`), so everything below takes it as an
// argument rather than reading a module constant. 1024 is what shipped and what the Low column
// still gets; the detailed mat needs 2048 to put a 0.405-in tooth on more than three texels.
const TEX_SCALE_AT = (size: number): number => size / (2 * BB_HALF_X);

/** world (x,y) → floor-texture canvas pixel. The canvas's row 0 is world +y (the far wall from
 * a driver standing at -y) because a `CanvasTexture`'s default `flipY` already corrects a
 * not-rotated `PlaneGeometry`'s V axis to run the same way — the same reason a ground texture
 * drawn "right side up" in 2D canvas code needs no extra flip here. */
function toTex(x: number, y: number, size: number): [number, number] {
  const s = TEX_SCALE_AT(size);
  return [(x + BB_HALF_X) * s, (BB_HALF_Y - y) * s];
}

/** `toTex` as the 2×3 `snapTapeGroup` reads — the same map, so the two cannot disagree. */
function texXform(size: number): { a: number; b: number; c: number; d: number; e: number; f: number } {
  const s = TEX_SCALE_AT(size);
  return { a: s, b: 0, c: 0, d: -s, e: BB_HALF_X * s, f: BB_HALF_Y * s };
}

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
const ALLIANCE_BLUE_HEX = 0x007be1; // same value, numeric — `THREE.MeshStandardMaterial.color` below

/** the tape colours `drawField.ts`'s `TAPE_GAFFER` uses — NOT a theme token there either (the
 * tape colour is the marking, per that file's own header). The red literal is copied, which is
 * exactly as stable as importing it would be; the blue is the local `ALLIANCE_BLUE` above, so
 * this file cannot drift from its own hive accents. */
const TAPE_GAFFER: Record<Alliance, string> = { red: '#e02020', blue: ALLIANCE_BLUE };


/** a filled world-space rectangle on the floor texture — used for a tape STRIP, which is a
 * physical band of a stated width, not a stroked outline. */
function fillStripTex(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string, size: number): void {
  const [px0, py0] = toTex(Math.min(x0, x1), Math.max(y0, y1), size);
  const [px1, py1] = toTex(Math.max(x0, x1), Math.min(y0, y1), size);
  ctx.fillStyle = color;
  ctx.fillRect(px0, py0, Math.max(1, px1 - px0), Math.max(1, py1 - py0));
}

/**
 * THE FALLBACK PATH'S TAPE — the CAD's own 16 strips, at the rectangles the CAD puts them at.
 *
 * The rule the owner named, and the one the CAD confirms part for part: **a zone edge that is a
 * WALL carries no tape.** A LOADING ZONE is bounded by the side wall and three 1-in tapes (its
 * two depth edges and its inner, field-side edge). A GARDEN is not outlined at all — it IS a
 * 2-in band of two 1-in tapes laid side by side, with nothing across its ends and nothing on the
 * two walls it sits in the corner of. `docs/biobuzz/field-cad-audit.md` §5.
 *
 * It used to RECONSTRUCT those strips from `BB_LZ`/`BB_GARDEN` by inset arithmetic, which was
 * right in shape and ~1.9 in out in position because the zone rectangles themselves were figure
 * reads. Both renderers now draw `BB_TAPE` — the measured rectangles — so the 2D panel, this
 * fallback and the GLB's own tape geometry are one layout by construction.
 */
function drawZoneTape(ctx: CanvasRenderingContext2D, a: Alliance, size: number): void {
  const colour = TAPE_GAFFER[a];
  // SNAPPED TO THE TEXEL GRID AS A GROUP, AT ONE WIDTH — `snapTapeGroup` (`drawField.ts`) has the
  // why: at 7.24 texels per inch a strip's edges land mid-texel, so two 1-in tapes came out as
  // different mixes of solid and half-lit columns and read as different widths.
  const fill = (strips: readonly BbRect[], paint: readonly BbRect[]): void => {
    const snapped = snapTapeGroup(texXform(size), strips);
    if (!snapped) {
      for (const s of paint) fillStripTex(ctx, s.x0, s.y0, s.x1, s.y1, colour, size);
      return;
    }
    ctx.fillStyle = colour;
    for (const [x, y, w, h] of snapped) ctx.fillRect(x, y, w, h);
  };
  fill(BB_TAPE.loadingZone[a], BB_TAPE.loadingZone[a]);
  // the GARDEN's two side-by-side tapes AND its corner patch tile one 2-in band; snapped as three
  // rectangles they can open a one-texel seam, snapped as the band they cannot. The patch is the
  // one strip that is not in the CAD — see `buildSupplementalTape` for why it exists at all.
  const garden = [...BB_TAPE.garden[a], ...BB_TAPE.gardenSupplement[a]];
  const band: BbRect = {
    x0: Math.min(...garden.map((r) => r.x0)),
    y0: Math.min(...garden.map((r) => r.y0)),
    x1: Math.max(...garden.map((r) => r.x1)),
    y1: Math.max(...garden.map((r) => r.y1)),
  };
  fill([band], garden);
}

/**
 * THE ONE STRIP THAT IS NOT IN THE CAD.
 *
 * The GARDEN's measured band stops 0.573 in clear of the wall at the alliance's corner (no tape
 * on this field runs onto the perimeter), while `BB_GARDEN` — the zone a GARDEN element scores in
 * — snaps that edge ONTO the wall. So the band visibly stopped short of the corner it is defined
 * to reach (2026-09-18 playtest: "you might need to add a very tiny short section of tape on the
 * bounds"). `TAPE.gardenSupplement` is the 0.573 × 2.000 in patch that closes it; see
 * `fieldDims.gen.ts`'s header for why it is generated into a group of its own and cannot move a
 * rule. The fallback texture paints it as part of the garden band (`drawZoneTape`); on the CAD
 * path the 16 real strips are GEOMETRY from the GLB, so the patch is geometry too.
 */
/** the CAD path's copy of the same patch, as real geometry at the CAD tape's own height (the
 * strips sit z 0.000–0.010 on the tiles). */
function buildSupplementalTape(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'tape:supplement';
  for (const a of ALLIANCES) {
    for (const [i, s] of BB_TAPE.gardenSupplement[a].entries()) {
      const geo = new THREE.PlaneGeometry(s.x1 - s.x0, s.y1 - s.y0);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: TAPE_GAFFER[a], roughness: 0.8, metalness: 0 }),
      );
      mesh.name = `tape:supplement:${a}:${i}`;
      mesh.position.set((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, 0.01);
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  return group;
}

/**
 * THE MAT, PAINTED (`renderTiles.ts` carries the measurements and the tier ladder).
 *
 * `detail === 'tiles'` (everything but the Low column) paints the field as the 36 `am-2499` soft
 * tiles it is: each tile its own polygon in its own tone, the CAD's dovetail where two tiles meet,
 * and the notched straight cut along the walls. `'flat'` is the 1024-texel field with straight
 * 2-px seam lines that shipped before, unchanged.
 */
function buildFloorTexture(withTape: boolean, detail: BbTileDetail): THREE.CanvasTexture {
  const size = TILE_TEX_SIZE[detail];
  const tiled = detail === 'tiles';
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);
  const pxPerIn = TEX_SCALE_AT(size);
  const tracePath = (points: readonly [number, number][], close: boolean): void => {
    ctx.beginPath();
    points.forEach(([wx, wy], i) => {
      const [px, py] = toTex(wx, wy, size);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    if (close) ctx.closePath();
  };

  if (tiled) {
    // ── the 36 MATS, each its own polygon and its own tone. A real field is thirty-six pieces
    // of foam that have taken thirty-six matches' worth of scuffing, and the tone changes where
    // the FOAM changes — along the dovetail, not along a straight line through the teeth.
    // `tileTone` is deterministic and never goes UP (`TILE_MAT` is a measured ceiling).
    //
    // Everything inside the wall that is not tile is `TILE_VOID`: the strip the tiles stop short
    // of the wall, and the socket notches the straight cut leaves along it. The clip to the tiled
    // span IS that cut (`tileOutline`).
    ctx.fillStyle = TILE_VOID;
    ctx.fillRect(0, 0, size, size);
    const lo = BB_TILE_SEAMS[0];
    const hi = BB_TILE_SEAMS[BB_TILE_SEAMS.length - 1];
    const [cx0, cy0] = toTex(lo, hi, size);
    const [cx1, cy1] = toTex(hi, lo, size);
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx0, cy0, cx1 - cx0, cy1 - cy0);
    ctx.clip();
    const outlines: [number, number][][] = [];
    for (let iy = 0; iy < BB_TILE_SEAMS.length - 1; iy++) {
      for (let ix = 0; ix < BB_TILE_SEAMS.length - 1; ix++) {
        const outline = tileOutline(ix, iy);
        outlines.push(outline);
        ctx.fillStyle = tileTone(ix, iy);
        tracePath(outline, true);
        ctx.fill();
      }
    }
    // ── THE JOINT: a dark hairline over a softer shade, both darker than any tile. Every seam
    // is stroked from both of its tiles, at the same place in the same opaque colour, and the
    // strokes also cover the hairline of background the canvas's own anti-aliasing leaves
    // between two filled polygons that share an edge.
    ctx.lineJoin = 'round';
    ctx.strokeStyle = TILE_JOINT_SHADE;
    ctx.lineWidth = TILE_JOINT_SHADE_W * pxPerIn;
    for (const o of outlines) {
      tracePath(o, true);
      ctx.stroke();
    }
    ctx.strokeStyle = TILE_JOINT;
    ctx.lineWidth = TILE_JOINT_W * pxPerIn;
    for (const o of outlines) {
      tracePath(o, true);
      ctx.stroke();
    }
    ctx.restore();
  } else {
    // tile SEAM GRID — `BB_TILE_SEAMS`, the perimeter edges and the five tile joints, which is
    // exactly what the 2D renderer draws.
    ctx.fillStyle = C.COLORS.mat;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = C.COLORS.tile;
    ctx.lineWidth = 2;
    for (const p of tileSeamPaths(detail)) {
      tracePath(p.points, false);
      ctx.stroke();
    }
  }

  // ⚠️ NO CENTRE MARK — the 2D renderer's reasoning, and the same removal (owner, 2026-09-19).
  // Event Field Guide V1.0 §8 tapes the LOADING ZONES, the GARDENS and the ALLIANCE AREAS and
  // nothing else, and the four centre tiles come OUT (§9.1) for the frame's under-tile strips,
  // so the origin is bare tile under the HIVE. Both floor texture paths therefore paint the
  // seam grid and the tape, full stop; this was a white cross at tape width on both.

  if (withTape) for (const a of ALLIANCES) drawZoneTape(ctx, a, size);
  // (the garden's corner patch is painted with its band above; the CAD path gets it as geometry,
  // beside the GLB's own real tape — a painted copy under real strips would double every line)

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** `withTape` is false on the CAD path — the tape is real geometry there (the GLB's own `tape`
 * node), and painting a second copy under it would double every line. */
function buildFloor(withTape: boolean, detail: BbTileDetail): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(2 * BB_HALF_X, 2 * BB_HALF_Y);
  // ⚠️ NO `color` HERE, EVER. `MeshStandardMaterial` MULTIPLIES `color` by `map`, so a tone
  // passed as both comes out squared and near black — the venue's ground shipped exactly that
  // bug once. The albedo is the canvas and the canvas alone.
  //
  // ⚠️ AND NO GRAIN MAP (2026-09-28): `renderTiles.ts`'s closing note has why — it repeated four
  // times per tile and read as a mottle that tiled. Foam is matte (the material's defaults,
  // roughness 1, metalness 0).
  const material = new THREE.MeshStandardMaterial({ map: buildFloorTexture(withTape, detail) });
  // which mat this is, for the physical-materials floor (`renderSurfaceField.ts`), which draws
  // the dovetail itself on the detailed one
  material.userData.bbTileDetail = detail;
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'floor';
  // a HAIR below z = 0. The CAD tape sits at z 0.000–0.010 and the GLB tile slab's top face is
  // at z = 0 exactly; a co-planar painted floor and a 0.010-in tape strip are inside the depth
  // buffer's noise at driver-camera range, and the tape materials' polygon offset
  // (`renderFieldGlb.ts`) only helps if there is something to offset against.
  mesh.position.z = -0.02;
  return mesh;
}

/**
 * TRANSPARENT POLYCARBONATE WALLS (2026-09-18 playtest, issue 3: "the field wall should be
 * transparent"). The Day 1 wall was `mat(C.COLORS.wall, 0.35)` — a `FrontSide` material at 35%
 * opacity, which is nowhere near see-through, so a wall between the camera and the field read as
 * a solid, faintly-tinted slab rather than the polycarbonate panel it is.
 *
 * ⚠️ THE NUMBERS BELOW ARE THE 2026-09-19 RE-TUNE, NOT THE FIRST PASS. This path and the CAD path
 * MUST agree: they draw the same field, and a driver who falls back to this one (a missing or
 * corrupt `field.glb`) must not get a different field. `renderFieldGlb.ts`'s policy header carries
 * the measurement in full; the short version is that a clear panel is what the LAYERS sum to, not
 * a per-material number. The first pass's 0.22 / 0.3 / `DoubleSide` put six surfaces at 22 % each
 * between the eye and a ball (1 − 0.78⁶ = 78 % opaque) and the cell skins read as white boards.
 * `FrontSide` halves the layer count and is correct here for the same reason it is correct there —
 * every panel this builds is a closed box, so its near surface always faces the camera — and the
 * alphas drop to what clear polycarbonate actually does face-on.
 *
 * `depthWrite: false` + a `renderOrder` past every opaque object stays: a transparent object that
 * WRITES depth can incorrectly occlude something drawn after it at a similar distance (here,
 * another transparent wall on the far side of the field), and Three.js does not sort transparent
 * objects by triangle depth, only by render order.
 *
 * ⚠️ AND THE MATERIAL ITSELF IS NOT THIS FILE'S ANY MORE (2026-09-19, the owner's SECOND report
 * that the hive's back panel is too transparent from behind). This file used to build its own
 * `MeshStandardMaterial` beside the CAD path's, which meant the two paths agreed on the two
 * numbers a check compared and on nothing else: the Fresnel alpha, the un-attenuated reflection,
 * the restored mirror and the additive veil all landed on the CAD path only, so the fallback field's
 * panels were still the flat constant-alpha sheets the first pass had already been shown to be
 * wrong. `cellPanelMaterial` and `wallPanelMaterial` are imported from `renderFieldGlb.ts` now — the
 * direction this file already depends in — and there is exactly TWO clear-plastic surfaces in the
 * game. The one visible consequence: the fallback's panels take `CLEAR_PANEL_TINT` like the CAD
 * path's, rather than `C.COLORS.wall` and a hand-picked `#cfd8e3`.
 */
function wallMaterial(): THREE.Material {
  return wallPanelMaterial();
}
/** drawn well after the field/robots/elements (all at the default `renderOrder` 0) so a
 * transparent wall never fights another transparent wall or a robot for a pixel. */
const WALL_RENDER_ORDER = 10;
/** the cell skins are INSIDE the field, so they draw after everything opaque and before the
 * perimeter. Same number as the CAD path's `CELL_RENDER_ORDER`. */
const CELL_RENDER_ORDER = 5;

function buildWalls(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'walls';
  const material = wallMaterial();
  const span = 2 * BB_HALF_X + 2 * WALL_VIS_T;
  const specs: { x: number; y: number; w: number; d: number }[] = [
    { x: 0, y: BB_HALF_Y + WALL_VIS_T / 2, w: span, d: WALL_VIS_T },
    { x: 0, y: -BB_HALF_Y - WALL_VIS_T / 2, w: span, d: WALL_VIS_T },
    { x: BB_HALF_X + WALL_VIS_T / 2, y: 0, w: WALL_VIS_T, d: span },
    { x: -BB_HALF_X - WALL_VIS_T / 2, y: 0, w: WALL_VIS_T, d: span },
  ];
  const names = ['wall:rear', 'wall:audience', 'wall:right', 'wall:left'] as const;
  specs.forEach((s, i) => {
    const geo = new THREE.BoxGeometry(s.w, s.d, WALL_VIS_H);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = names[i];
    mesh.position.set(s.x, s.y, WALL_VIS_H / 2);
    mesh.renderOrder = WALL_RENDER_ORDER;
    group.add(mesh);
  });
  void BB_WALL_T; // physics-only constant; visual thickness is its own, smaller, number
  return group;
}

/** a box spanning two points, `radius` thick on both cross-axes — the frame's uprights and
 * crossbar, which are slanted segments rather than axis-aligned boxes. */
function segmentMesh(a: THREE.Vector3, b: THREE.Vector3, radius: number, material: THREE.Material): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(radius, radius, Math.max(len, 1e-3), 8);
  const meshMesh = new THREE.Mesh(geo, material);
  meshMesh.position.copy(a).addScaledVector(dir, 0.5);
  meshMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return meshMesh;
}

/** the HIVE frame: one triangular base bar (§9.6.1, Fig 9-8) plus uprights converging on the
 * pivot. The base bar's x-range is the manual measurement (`BB_FRAME_BAR_IN/OUT`); the uprights
 * and their count are this renderer's own reading of "triangular structure" — APPROX, same as
 * the 2D renderer's dashed crossbar is its own reading of "joins at the apex". */
function buildHiveFrame(alliance: Alliance): THREE.Group {
  const group = new THREE.Group();
  group.name = `hive:${alliance}:frame`;
  const barMat = mat(C.COLORS.wall);
  const sign = alliance === 'red' ? -1 : 1;
  const barX = sign < 0 ? -(BB_FRAME_BAR_IN + BB_FRAME_BAR_OUT) / 2 : (BB_FRAME_BAR_IN + BB_FRAME_BAR_OUT) / 2;
  const barW = BB_FRAME_BAR_OUT - BB_FRAME_BAR_IN;

  const baseBar = new THREE.Mesh(new THREE.BoxGeometry(barW, 2 * BB_FRAME_Y, 1), barMat);
  baseBar.name = `hive:${alliance}:frame:base`;
  baseBar.position.set(barX, 0, 0.5);
  group.add(baseBar);

  const pivot = new THREE.Vector3(sign * BB_HIVE_X, 0, HIVE_PIVOT_Z);
  for (const s of [1, -1] as const) {
    const base = new THREE.Vector3(barX, s * BB_FRAME_Y, 1);
    const upright = segmentMesh(base, pivot, 0.5, barMat);
    upright.name = `hive:${alliance}:frame:upright${s > 0 ? 'N' : 'S'}`;
    group.add(upright);
  }
  return group;
}

/** the crossbar joining the two hives' pivots — solid here (no dash pattern in 3D geometry; the
 * 2D renderer's dash exists to say "this is overhead, not on the tile", which the actual height
 * already says on its own in a 3D view). */
function buildCrossbar(): THREE.Mesh {
  const a = new THREE.Vector3(-BB_HIVE_X, 0, HIVE_PIVOT_Z);
  const b = new THREE.Vector3(BB_HIVE_X, 0, HIVE_PIVOT_Z);
  const bar = segmentMesh(a, b, 0.5, mat(C.COLORS.wall));
  bar.name = 'hive:crossbar';
  return bar;
}

/** one CELL, in the TRAY's own local (un-rotated) frame: floor, back wall, two side walls, and a
 * ceiling — OPEN at the outer face (away from the pivot), five `HIVE_CELL_WALL`-thick boxes
 * (`BB3_HIVE_CELL_WALL`, plan-3d.md §13.1) exactly as `scripts/spike3d-browser/main.ts`'s Day-0
 * physics spike built them (the geometry the plan doc's "fallback five boxes per cell"
 * describes). `s` is +1 for the north cell, −1 south.
 *
 * Z placement is `HIVE_CELL_Z0 ± HIVE_CELL_H/2`, SOLVED (see that constant's own comment) so the
 * built box reproduces `BB_HIVE_OPEN_Z` at the true 30° tilt rather than a value that merely
 * looks plausible — the first pass centred the box at local z 9 (an arbitrary choice) and the
 * up-CELL opening came out roughly 3 in high of the manual figure. */
function buildCell(s: 1 | -1, accent: string, alliance: Alliance): THREE.Group {
  const group = new THREE.Group();
  group.name = `hive:${alliance}:cell:${s > 0 ? 'north' : 'south'}`;
  // CLEAR POLYCARBONATE, not a grey box (2026-09-18 playtest, issue 1). The three CAD skins a
  // CELL is made of are see-through; painting them solid hides every element in the cell and is
  // the fallback's half of "transparent panels rendered as opaque white". The FLOOR keeps the
  // alliance accent and stays solid — it is the one surface an element rests on and the one that
  // says whose hive this is.
  const structure = cellPanelMaterial();
  const accentMat = mat(accent, 0.85);
  const cellY = s * HIVE_ARM;
  const w = HIVE_CELL_WALL;
  const zBot = HIVE_CELL_Z0 - HIVE_CELL_H / 2;
  const zTop = HIVE_CELL_Z0 + HIVE_CELL_H / 2;
  const innerY = cellY - s * (HIVE_CELL_DEPTH / 2 + w / 2); // back wall, just inside the true inner face
  const half = HIVE_CELL_W / 2;

  const floor = new THREE.Mesh(new THREE.BoxGeometry(HIVE_CELL_W, HIVE_CELL_DEPTH, w), accentMat);
  floor.name = `${group.name}:floor`;
  floor.position.set(0, cellY, zBot + w / 2);
  group.add(floor);

  const back = new THREE.Mesh(new THREE.BoxGeometry(HIVE_CELL_W, w, HIVE_CELL_H), structure);
  back.name = `${group.name}:back`;
  back.position.set(0, innerY, HIVE_CELL_Z0);
  group.add(back);

  for (const sx of [1, -1] as const) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(w, HIVE_CELL_DEPTH, HIVE_CELL_H), structure);
    side.name = `${group.name}:side${sx > 0 ? 'X+' : 'X-'}`;
    side.position.set(sx * (half + w / 2), cellY, HIVE_CELL_Z0);
    group.add(side);
  }

  const ceiling = new THREE.Mesh(new THREE.BoxGeometry(HIVE_CELL_W, HIVE_CELL_DEPTH, w), structure);
  ceiling.name = `${group.name}:ceiling`;
  ceiling.position.set(0, cellY, zTop - w / 2);
  group.add(ceiling);

  for (const panel of [back, ceiling]) {
    panel.renderOrder = CELL_RENDER_ORDER;
    panel.castShadow = false; // a see-through sheet that throws a solid shadow is not see-through
  }
  for (const child of group.children) {
    if (child.name.includes(':side')) {
      child.renderOrder = CELL_RENDER_ORDER;
      child.castShadow = false;
    }
  }

  return group;
}

/** the whole TRAY — the dynamic see-saw's visual half. A single `THREE.Group` so ONE rotation
 * (`updateBiobuzzField`, about local x) tilts both cells together, matching the real hive: they
 * ride one rigid bar (plan-3d.md §3.6). */
function buildTray(alliance: Alliance): THREE.Group {
  const tray = new THREE.Group();
  tray.name = `hive:${alliance}:tray`;
  const accent = alliance === 'blue' ? ALLIANCE_BLUE : C.COLORS.red;
  tray.add(buildCell(1, accent, alliance));
  tray.add(buildCell(-1, accent, alliance));
  // CylinderGeometry's axis is local Y by default — exactly the arm direction the two cells
  // sit along (`cellY = s * HIVE_ARM` in `buildCell`), so no rotation is needed here at all.
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, HIVE_BAR_LEN, 8), mat(accent));
  bar.name = `hive:${alliance}:tray:bar`;
  tray.add(bar);
  return tray;
}

function buildFlowerFoot(f: (typeof BB_FLOWERS)[number], name: string): THREE.Mesh {
  const n = FLOWER_MOUTH[f.wall];
  const onY = f.wall === 'left' || f.wall === 'right';
  const wx = f.x - n.x * BB_FLOWER_D;
  const wy = f.y - n.y * BB_FLOWER_D;
  const cx = wx + (n.x * BB_FLOWER_FOOT.deep) / 2;
  const cy = wy + (n.y * BB_FLOWER_FOOT.deep) / 2;
  const w = onY ? BB_FLOWER_FOOT.deep : BB_FLOWER_FOOT.along;
  const d = onY ? BB_FLOWER_FOOT.along : BB_FLOWER_FOOT.deep;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, d, FLOWER_FOOT_H), mat(C.COLORS.wall));
  mesh.name = name;
  mesh.position.set(cx, cy, FLOWER_FOOT_H / 2);
  return mesh;
}

/** one FLOWER: a foot, four support pipes, the lower/middle/top rings — a fallback compound
 * shape (plan-3d.md §3.7, §13.1); the CAD-derived GLB replaces this when it lands (§8). */
function buildFlower(f: (typeof BB_FLOWERS)[number], idx: number): THREE.Group {
  const group = new THREE.Group();
  const base = `flower:${idx}`;
  group.name = base;
  group.add(buildFlowerFoot(f, `${base}:foot`));

  const ringMat = mat(C.COLORS.white, 0.9);
  const topRing = new THREE.Mesh(new THREE.TorusGeometry(BB_FLOWER_OPEN_R, FLOWER_TUBE_R, 8, 24), ringMat);
  topRing.name = `${base}:ring`;
  topRing.position.set(f.x, f.y, BB_FLOWER_TOP_Z);
  group.add(topRing);

  // THE BACKSTOP (§9.7: "a backstop on top of each FLOWER to help guide POLLEN and NECTAR into
  // the FLOWER … 1.25 in tall"). It was missing from this path entirely — the CAD path draws the
  // real part (`am-5884 Flower Backstop`, CAD purple `#641c65`, a 0.25-in plate standing on the
  // top ring), so a fallback field had no backstop at all while the CAD field did. It stands on
  // the WALL side of the bore, which is where a lob comes off: `FLOWER_MOUTH[f.wall]` is the
  // inward normal, so the plate sits one ring-radius the OTHER way.
  const n = FLOWER_MOUTH[f.wall];
  const onY = f.wall === 'left' || f.wall === 'right';
  const stand = BB_FLOWER_OPEN_R + FLOWER_TUBE_R;
  const backstop = new THREE.Mesh(
    new THREE.BoxGeometry(onY ? FLOWER_BACKSTOP_T : FLOWER_BACKSTOP_W, onY ? FLOWER_BACKSTOP_W : FLOWER_BACKSTOP_T, FLOWER_BACKSTOP_H),
    mat(FLOWER_BACKSTOP_COLOR),
  );
  backstop.name = `${base}:backstop`;
  backstop.position.set(f.x - n.x * stand, f.y - n.y * stand, BB_FLOWER_TOP_Z - FLOWER_TUBE_R + FLOWER_BACKSTOP_H / 2);
  group.add(backstop);

  const midRing = new THREE.Mesh(new THREE.TorusGeometry(FLOWER_MID_RING_R, FLOWER_TUBE_R * 0.8, 8, 24), ringMat);
  midRing.name = `${base}:midring`;
  midRing.position.set(f.x, f.y, BB_FLOWER_MID_Z);
  group.add(midRing);

  const lowerRing = new THREE.Mesh(new THREE.CylinderGeometry(FLOWER_LOWER_RING_R + 0.3, FLOWER_LOWER_RING_R + 0.3, 0.5, 16), mat(C.COLORS.wall));
  lowerRing.name = `${base}:lowerring`;
  // default CylinderGeometry axis is local Y; rotate its axis onto Z so the ring lies FLAT
  // (a thin disc on the tiles), not standing on edge.
  lowerRing.rotation.x = Math.PI / 2;
  lowerRing.position.set(f.x, f.y, BB_FLOWER_FLOOR_Z);
  group.add(lowerRing);

  // the four HIPS support pipes, standing VERTICALLY from the tiles to the top ring.
  //
  // ⚠️ BUG FOUND AND FIXED HERE: a `CylinderGeometry`'s axis is local Y by default, and the
  // first pass never rotated it, so all four pipes were lying on their SIDES (each one's axis
  // pointing along world Y, the same "sideways pole" for every flower regardless of which wall
  // it stood against) instead of standing up from the foot to the ring. `rotation.x = PI/2`
  // is the same axis-onto-Z trick `lowerRing` above already uses.
  const pipeR = BB_FLOWER_OPEN_R + 0.3;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const px = f.x + Math.cos(a) * pipeR;
    const py = f.y + Math.sin(a) * pipeR;
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(FLOWER_PIPE_R, FLOWER_PIPE_R, BB_FLOWER_TOP_Z, 6), mat(C.COLORS.wall));
    pipe.name = `${base}:pipe${i}`;
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(px, py, BB_FLOWER_TOP_Z / 2);
    group.add(pipe);
  }
  return group;
}

/**
 * ⚠️ **THE PROCEDURAL ROOM IS GONE — `scene/renderVenue.ts` IS THE SURROUND NOW** (owner,
 * 2026-09-21: "Make it render an actual environment instead of blurry lights").
 *
 * `buildRoom` was a grey floor disc and a grey cylinder, added by THIS path only: the CAD
 * `glbFieldToHandles` never called it, so the shipping field had no ground past the perimeter
 * at all and the constants fallback had two flat greys. Both are now the same real venue —
 * chosen by the ENVIRONMENT, with a coved studio, a floodlit car park or a hall with trussing,
 * seating and light fittings in it — built once per pick and owned by `renderScene.ts`.
 *
 * ⚠️ Nothing replaces it HERE, and that is deliberate: a second floor at z −0.75 under the
 * venue's own would z-fight across the whole frame, and a 424-in backdrop cylinder inside a
 * 460-in hall would intersect its walls. The field builds the FIELD.
 */

/**
 * ONE HIVE — the pivot group named `hive:<alliance>` (per the field-import seam, plan-3d.md §8:
 * the CAD `field.glb` will hand back a node under this same name), holding the static frame and
 * the tilting `tray` child. Position is the pivot itself (`±BB_HIVE_X, 0, HIVE_PIVOT_Z`), so
 * every child is authored in the pivot's own local frame — the tray's rotation is exactly the
 * see-saw's revolute joint.
 */
function buildHive(alliance: Alliance): { group: THREE.Group; tray: THREE.Group } {
  const group = new THREE.Group();
  group.name = `hive:${alliance}`;
  group.position.set(alliance === 'red' ? -BB_HIVE_X : BB_HIVE_X, 0, HIVE_PIVOT_Z);
  group.add(buildHiveFrame(alliance));
  const tray = buildTray(alliance);
  group.add(tray);
  return { group, tray };
}

// ── THE HUMAN PLAYER'S NECTAR HOLDING BOX ─────────────────────────────────────────────────────
//
// 2026-09-18 playtest: "there is a box in the drive team area. I don't know what that is.
// Honestly, it should be closer to the loading zone and should show how many nectar can be
// placed." 2026-09-19: "it should use the standard holding box instead of this table thing you
// created" — the first pass answered the complaint with a bespoke shelf on legs at table height,
// which is furniture this game does not have.
//
// THE BOX'S DIMENSIONS AND ITS PLACE LIVE IN `../nectarBox.ts`, not here, because `drawField.ts`
// draws the same footprint in the 2D view and the two must be the same box. Read that file for
// the CAD part it is (`am-5706 Artifact Tray`), for why it stands where it stands (the owner's
// 2026-09-19 note about the score bar), and for the point-symmetry rule. What is left below is
// purely how it is BUILT in three.js.
//
// THE COUNT IS READ OFF THE WORLD, never stored: `spawn.ts` stages five `stock` NECTAR per
// alliance and `play.ts` flips one to `ground` on each entry, so counting them here and counting
// them in `hud.ts` cannot drift.
//
// ⚠️ THERE IS NO SIGN OVER IT ANY MORE (owner, 2026-09-19: "Get rid of the in-game 3d display").
// A canvas plate reading "NECTAR LEFT 5" used to hang over the box, repainted whenever the count
// changed. It is gone — plate, canvas, `CanvasTexture` and repaint — and the HUD is the only
// place a number appears. If it ever comes back it comes back as HUD, not as scenery: a billboard
// standing in the field is the one piece of furniture a driver cannot look past.

export interface BbNectarBox {
  group: THREE.Group;
  /** the nectar spheres, shown/hidden by the remaining count. */
  beads: THREE.Mesh[];
}

/** one alliance's holding box, OUTSIDE the perimeter face beside its own drive team area. */
function buildNectarBox(a: Alliance): BbNectarBox {
  const group = new THREE.Group();
  group.name = `nectar-box:${a}`;
  const { x: cx, y: cy } = bbNectarBoxCentre(a);

  // DECODE's box is a dark backing inside a bright alliance frame. Here that is a floor slab
  // plus four low side walls — an OPEN-TOPPED tray, so the balls in it are visible from the
  // driver's camera and from straight above.
  const backingMat = mat('#191d24'); // `src/render/drawField.ts`'s own backing fill
  // ⚠️ THE SLAB SITS INSIDE THE WALLS, NOT UNDER THEM (owner, 2026-09-21: "the black part and the
  // red part is meshing"). Built to the box's full footprint, its four outer faces were coplanar
  // with the alliance walls' outer faces for the bottom `BB_BOX_T` — a black band z-fighting a red
  // one all the way round. Inset by one wall thickness it only ever meets a wall's INNER face.
  const floorSlab = new THREE.Mesh(
    new THREE.BoxGeometry(BB_BOX_DEPTH - 2 * BB_BOX_T, BB_BOX_LEN - 2 * BB_BOX_T, BB_BOX_T),
    backingMat,
  );
  floorSlab.name = `${group.name}:floor`;
  floorSlab.position.set(cx, cy, BB_BOX_T / 2);
  floorSlab.receiveShadow = true;
  group.add(floorSlab);

  const frameMat = mat(a === 'blue' ? ALLIANCE_BLUE : C.COLORS.red);
  const wallZ = BB_BOX_H / 2;
  for (const s of [1, -1] as const) {
    // the two long sides (across the depth, facing the wall / facing the driver)
    const long = new THREE.Mesh(new THREE.BoxGeometry(BB_BOX_T, BB_BOX_LEN, BB_BOX_H), frameMat);
    long.name = `${group.name}:side${s > 0 ? 'Out' : 'In'}`;
    long.position.set(cx + s * (BB_BOX_DEPTH / 2 - BB_BOX_T / 2), cy, wallZ);
    group.add(long);
    // and the two ends (along the wall)
    const end = new THREE.Mesh(new THREE.BoxGeometry(BB_BOX_DEPTH, BB_BOX_T, BB_BOX_H), frameMat);
    end.name = `${group.name}:end${s > 0 ? 'N' : 'S'}`;
    end.position.set(cx, cy + s * (BB_BOX_LEN / 2 - BB_BOX_T / 2), wallZ);
    group.add(end);
  }

  const beadMat = new THREE.MeshStandardMaterial({
    color: a === 'blue' ? ALLIANCE_BLUE_HEX : 0xe2564d, // red still matches `renderElements.ts`'s `NECTAR_COLORS`
    roughness: 0.4,
    metalness: 0.05,
  });
  const beads: THREE.Mesh[] = [];
  for (let i = 0; i < BB_BOX_SLOTS; i++) {
    const slot = bbNectarBoxSlot(a, i);
    const bead = new THREE.Mesh(new THREE.SphereGeometry(BB_NECTAR_R, 12, 8), beadMat);
    bead.name = `${group.name}:nectar${i}`;
    // resting ON the box floor, not floating over it
    bead.position.set(slot.x, slot.y, BB_BOX_T + BB_NECTAR_R);
    bead.castShadow = true;
    beads.push(bead);
    group.add(bead);
  }

  return { group, beads };
}

function buildNectarBoxes(): Record<Alliance, BbNectarBox> {
  return { red: buildNectarBox('red'), blue: buildNectarBox('blue') };
}

/** how many NECTAR are left in `a`'s human-player supply — the same balls `hud.ts` counts. */
function stockLeft(world: World, a: Alliance): number {
  let n = 0;
  for (const b of world.balls) if (b.state.kind === 'stock' && b.state.alliance === a) n++;
  return n;
}

function updateNectarBoxes(boxes: Record<Alliance, BbNectarBox>, world: World): void {
  for (const a of ALLIANCES) {
    const box = boxes[a];
    const left = stockLeft(world, a);
    for (let i = 0; i < box.beads.length; i++) box.beads[i].visible = i < left;
  }
}

export interface BbFieldHandles {
  /** everything, for a single `scene.add()`. */
  group: THREE.Group;
  /** named `floor` / `walls` — the flat, non-animated field furniture. */
  floor: THREE.Object3D;
  walls: THREE.Object3D;
  /** named `hive:red` / `hive:blue`, each with a `tray` child (`updateBiobuzzField` rotates it). */
  hives: Record<Alliance, THREE.Group>;
  /** named `flower:0`..`flower:3`, in `BB_FLOWERS` order. */
  flowers: THREE.Group[];
  /** the two tray groups, keyed by alliance — kept as its own map (rather than making callers
   * dig `hives[a].getObjectByName('tray')` out every frame) because `updateBiobuzzField` sets a
   * rotation on it every tick and that is a hot, tiny lookup worth keeping direct. */
  trays: Record<Alliance, THREE.Group>;
  /** the human players' NECTAR holding boxes, on the floor beside each LOADING ZONE outside the
   * wall — `updateBiobuzzField` refills them from `world.balls`. */
  boxes: Record<Alliance, BbNectarBox>;
}

/**
 * Builds the WHOLE field, CONSTANTS-ONLY, as one group of NAMED sub-groups — `floor`, `walls`,
 * `hive:<alliance>` (each with a `tray` child), `flower:<index>`. This is the Day 1 field and the
 * fallback `buildBiobuzzField` (below) uses on any CAD-load failure; nothing downstream
 * (`renderScene.ts`, `updateBiobuzzField`) reaches into this function's internals, only ever the
 * returned handles.
 */
function buildBiobuzzFieldConstants(detail: BbTileDetail): BbFieldHandles {
  const group = new THREE.Group();
  group.name = 'bb-field';

  const floor = buildFloor(true, detail);
  const walls = buildWalls();
  group.add(floor, walls, buildCrossbar());

  const hives = {} as Record<Alliance, THREE.Group>;
  const trays = {} as Record<Alliance, THREE.Group>;
  for (const a of ALLIANCES) {
    const { group: hiveGroup, tray } = buildHive(a);
    group.add(hiveGroup);
    hives[a] = hiveGroup;
    trays[a] = tray;
  }

  const flowers = BB_FLOWERS.map((f, idx) => {
    const g = buildFlower(f, idx);
    group.add(g);
    return g;
  });

  const boxes = buildNectarBoxes();
  for (const a of ALLIANCES) group.add(boxes[a].group);

  return { group, floor, walls, hives, flowers, trays, boxes };
}

/**
 * Maps a loaded CAD `FieldGroups` (`renderFieldGlb.ts`) into the SAME `BbFieldHandles` shape the
 * constants field returns, so `updateBiobuzzField` and every named-object lookup (the scene-
 * preview's own checks included) work unchanged regardless of which field is in play.
 *
 * TAPE COMES FROM THE GLB. All 16 CAD gaffer-tape parts are real geometry with the STEP's own
 * pure red (#ff0000) and blue (#0000ff), in the layout the field actually has — three sides per
 * LOADING ZONE with the wall side bare, the GARDEN as a solid 2-in band, and the two ALLIANCE
 * AREA outlines on the gym floor outside the perimeter. The procedural tape that used to be
 * painted here (a four-sided `strokeRect` of each zone rectangle, wall edge included) is gone
 * from this path; it survives only for the constants fallback, where it now draws the same
 * layout. `docs/biobuzz/field-cad-audit.md` §5.
 *
 * TILES stay PROCEDURAL, and this is the one place the CAD is deliberately not used as-is. The
 * STEP's 36 soft tiles are a ribbed, perforated foam plate — 175,536 triangles and an 8.8 MB
 * tessellation for something that reads as noise at a driver camera's distance — carrying one
 * flat 50 %-grey placeholder colour and no seam or tread detail at all. `convert.py` therefore
 * emits them as a single CAD-accurate slab (real footprint, real 0.589-in thickness) and this
 * path hides that slab in favour of a flat plane carrying a seam-grid `CanvasTexture`, painted
 * at the CAD's OWN measured pitch and footprint (`cadFloor()`, 23.53 in over ±70.585) so the
 * seams line up with the CAD tape lying on them. The tone is the sim's `COLORS.mat`/`COLORS.tile`
 * pair rather than the CAD grey, because the HUD contrast ratios (`npm run contrast`) are tuned
 * against those two tokens.
 */
function glbFieldToHandles(fg: FieldGroups, detail: BbTileDetail): BbFieldHandles {
  const group = fg.root;
  group.name = 'bb-field';

  // hide the GLB's own tile slab (kept in the tree, not removed, so `fg.root` still mounts as one
  // object with nothing missing) and use the procedural seam-grid plane instead — see the header.
  // The TAPE node is left visible: it is the real thing.
  fg.floor.visible = false;
  const floor = buildFloor(false, detail);
  group.add(floor);

  // the GLB's tape is the real thing; the ONE strip the CAD does not carry is added beside it.
  group.add(buildSupplementalTape());

  // ⚠️ `stations` IS THE UNLABELLED BOX. It is `am-5706 Artifact Tray` ×2 — a bare slab outside
  // each wall at y = 0, with nothing in it and nothing to say what it is ("there is a box in the
  // drive team area. I don't know what that is", 2026-09-18). Hidden, and the SAME BOX is rebuilt
  // below at the CAD's own dimensions beside the LOADING ZONE, carrying the supply actually left.
  if (fg.stations) fg.stations.visible = false;

  // the walls ARE used from the GLB (a real trimesh visual, not a flat token-coloured floor) —
  // `renderFieldGlb.ts` already assigns `walls` the same polycarbonate-look material the
  // constants path's `mat(C.COLORS.wall, 0.35)` was standing in for.
  const walls = fg.walls;

  // ONE HIVE GROUP PER ALLIANCE, at the pivot, holding the (world-absolute) frame and the
  // pivot-anchored tray — `attach()` re-parents each without moving it (it recomputes the local
  // offset from the current world transform), exactly like `renderFieldGlb.ts`'s own
  // `buildTrayGroup` already does for the tray itself. This gives the CAD path the SAME shape
  // (`hive:<alliance>` → `tray` child) the constants path's `buildHive` returns, so
  // `updateBiobuzzField`'s `handles.trays[a].rotation.set(...)` and the scene-preview's
  // `checkOrigin('hive:<alliance>', ...)` both work unchanged.
  const hives = {} as Record<Alliance, THREE.Group>;
  const trays = {} as Record<Alliance, THREE.Group>;
  for (const a of ALLIANCES) {
    const src = fg.hives[a];
    const hiveGroup = new THREE.Group();
    hiveGroup.name = `hive:${a}`;
    const pivot = src.tray.position; // the tray pivot group is already parked at the world pivot
    hiveGroup.position.copy(pivot);
    group.add(hiveGroup);
    hiveGroup.attach(src.frame);
    hiveGroup.attach(src.tray);
    src.tray.name = 'tray';
    hives[a] = hiveGroup;
    trays[a] = src.tray;
  }

  // flowers: named `flower:<idx>` to match the constants convention (the raw GLB node names are
  // `flower_0`..`flower_3`, already index-matched to `BB_FLOWERS`).
  const flowers = fg.flowers.map((node, idx) => {
    node.name = `flower:${idx}`;
    return node as THREE.Group;
  });

  const boxes = buildNectarBoxes();
  for (const a of ALLIANCES) group.add(boxes[a].group);

  return { group, floor, walls, hives, flowers, trays, boxes };
}

/**
 * Builds the WHOLE field. Tries the CAD-derived `field.glb`/`field-low.glb` (`loadFieldGlb`,
 * `docs/biobuzz/plan-3d.md` §8) first; on ANY failure (404, offline, a decode error, a missing
 * expected node) logs one `console.warn` and falls back to `buildBiobuzzFieldConstants()` — the
 * Day 1 field, kept complete on purpose (`public/models/biobuzz/README.md`: "these four files
 * can be deleted in one commit if FIRST objects"). `quality` selects the GLB's high/low LOD
 * (`SceneQuality.meshDetail`, `renderScene.ts`); it does nothing on the constants fallback.
 */
export async function buildBiobuzzField(quality: 'high' | 'low' = 'high'): Promise<BbFieldHandles> {
  // ONE ARGUMENT, TWO JOBS, and neither is a new setting: `quality` is `GraphicsSettings.
  // meshDetail`, which picks the GLB's LOD *and* (through `bbTileDetail`) whether the mat is
  // painted as the 36 measured soft tiles or as the flat 1024-texel grid the Low column keeps.
  // `renderTiles.ts`'s `bbTileDetail` carries why that is the right dial to read here.
  const detail = bbTileDetail(quality);
  try {
    const fg = await loadFieldGlb('models/biobuzz', quality);
    return glbFieldToHandles(fg, detail);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('BIOBUZZ 3D field: CAD field.glb failed to load; falling back to the constants-built field.', err);
    return buildBiobuzzFieldConstants(detail);
  }
}

/**
 * per-frame update: only the two trays' rotations change (everything else in the field group is
 * static geometry built once at scene creation).
 *
 * THE TRAY-ANGLE CONTRACT (owned by the hive lane, `sim3d/hive3d.ts` + `sim3d/bodies.ts` —
 * imported, never copied). `hiveTiltAngle(world, alliance)` is the tray's ABSOLUTE tilt, right-
 * hand about the shared local x axis at the pivot — the SAME number `engine.ts`'s
 * `applyHiveTilt` drives the physics tray body's kinematic rotation with. `hiveTrayRefTheta`
 * (`bodies.ts`) is the angle the CAD tray NODE was captured at (`cadCaptureTheta`, 0 for the
 * constants-built fallback, whose geometry is theta-independent by construction).
 *
 * ⚠️ BUG FIXED HERE: this used to recompute the tilt LOCALLY from `world.biobuzz.hives[a].up`/
 * `.tipping` (the 2D hive-timer state) and apply that ABSOLUTE angle directly to the tray group
 * — correct for the constants-built fallback (whose geometry sits at local zero), but WRONG for
 * the CAD-loaded tray: that node is captured already tilted to its own rest pose
 * (`hiveTrayRefTheta`), so applying the absolute angle on TOP of it drew roughly DOUBLE the real
 * physics tilt. Rotating by the DIFFERENCE (`hiveTiltAngle − hiveTrayRefTheta`) is exactly what
 * `engine.ts` already does for the physics body, so the visual and the collider agree at every
 * instant, on both the CAD path (nonzero `refTheta`) and the fallback (zero, so this is the same
 * absolute angle as before).
 */
export function updateBiobuzzField(handles: BbFieldHandles, world: World): void {
  for (const a of ALLIANCES) {
    const angle = hiveTiltAngle(world, a) - hiveTrayRefTheta(a);
    handles.trays[a].rotation.set(angle, 0, 0);
  }
  // the NECTAR holding boxes: one pass over `world.balls` and a visibility flip per bead. No
  // canvas, no texture upload — the count plate that used to be repainted here is gone.
  updateNectarBoxes(handles.boxes, world);
}
