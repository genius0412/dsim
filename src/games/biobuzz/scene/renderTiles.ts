import type { MeshDetail } from '../graphics/settings';
import { BB_TILE_SEAMS } from '../config';

/**
 * THE FIELD MAT'S SURFACE — what a FIRST Tech Challenge soft tile actually looks like, at the
 * higher graphics settings (owner, 2026-09-21: "For higher graphics settings, have proper
 * texture and the proper pattern of the field tile (where two tiles meet). More accurate colour
 * would be good too"; 2026-09-28: "Borders between field tiles are not accurate to real life").
 *
 * ⚠️ **THIS FILE IS THE MAT'S SKIN AND NOTHING ELSE.** It moves no geometry, it is imported by
 * `renderField.ts` and the physical-materials floor, and every number in it is painted into a
 * texture or a shader. The field is authoritative and the sim never sees any of this. It imports
 * no `three`: everything here is plain geometry, so the RENDER lane can measure it directly.
 *
 * ── WHAT THE TILE IS, MEASURED OFF THE SHA-PINNED FIELD STEP ────────────────────────────────
 * The part is **`am-2499: FIRST Tech Challenge Field Soft Tiles`**, 36 of them in three
 * variants — plan bbox in inches, measured over every instance:
 *
 *   | variant            | n  | plan bbox       | what that means                       |
 *   |--------------------|----|-----------------|---------------------------------------|
 *   | `am-2499-Center`   | 16 | 24.313 × 24.313 | tabbed on all FOUR edges              |
 *   | `am-2499-Side`     | 16 | 24.313 × 23.986 | three tabbed edges, one cut STRAIGHT  |
 *   | `am-2499-Corner`   |  4 | 23.986 × 23.986 | two tabbed edges, two cut STRAIGHT    |
 *
 * The PERIMETER edge of the mat is straight (AndyMark ships the tabs to be cut off there), and
 * only the interior joints interlock.
 *
 * ── THE INTERLOCK IS A DOVETAIL (2026-09-28) ─────────────────────────────────────────────────
 * Traced off the B-rep top face of `am-2499-Center` (its outer wire: 164 lines and 144 arcs, no
 * inner loops) and off all 36 placed tiles in the field frame, and it agrees with AndyMark's own
 * product photo. Every tab is WIDER AT ITS HEAD THAN AT ITS NECK:
 *
 *   - tab heads and socket floors are flats **1.247 in** long, **0.810 in** apart across the
 *     joint, repeating every **2.369 in**;
 *   - the flanks between them lean back **32.6°** from square, so a head overhangs its own neck
 *     by 0.031 in each side, with a **0.1247-in** fillet at all four corners of every tab.
 *
 * The version before this was a square castellation at the same period and depth, read off the
 * outline's crossings of its own midline — which is exactly the one line a dovetail and a square
 * wave agree on. The owner's report is what that looked like from above.
 *
 * Three places break the lattice, and all three are 45° straight cuts through a point where
 * four or two tiles meet — which is how one moulding mates with its own copy, turned or not:
 *   - **every junction is an X**: each of the four corners is cut at 45°, so the joint along x
 *     and the joint along y each run straight through the junction on a diagonal;
 *   - **every edge flips at its middle**: the flank there is replaced by a 45° cut through the
 *     edge's midpoint, so an edge is point-symmetric about it;
 *   - between them the lattice is continuous — a tab head on one side of the middle and a socket
 *     on the other are the same comb, 5 × 2.369 apart.
 *
 * ── WHERE THE JOINTS ARE ─────────────────────────────────────────────────────────────────────
 * `BB_TILE_SEAMS` (`fieldDims.gen.ts`): the two perimeter edges and five joints, **evenly** spaced
 * at 23.502 in (= 24.3125 − 0.810: a tile's bbox less one interlock). They used to be the tiles'
 * bounding-box MINIMA, which for an interior tile is the tip of its tabs, half an interlock
 * (0.405 in) off the joint; that is also where the "uneven 23.176 … 23.986 spacing" came from.
 * The outermost cells run from the perimeter to a VIRTUAL junction 0.079 in inside it, where the
 * straight cut crosses the corner's own 45° line (`tileJunctions`).
 *
 * ── THE COLOUR ──────────────────────────────────────────────────────────────────────────────
 * A foam tile is NEUTRAL GREY. `TILE_MAT` carries the measurement that says how light it may go.
 */

// ─────────────────────────────────────────────────────────────────────────── the tier ladder ──

/** `flat` is exactly what shipped before the tiled mat existed; `tiles` is the measured mat. */
export type BbTileDetail = 'flat' | 'tiles';

/**
 * WHICH LEVEL A DEVICE GETS. Same shape of answer as `bbVenueDetail`/`bbWheelDetail` — read off
 * a dial that already exists.
 *
 * ⚠️ IT READS `meshDetail` ALONE, and that is not a shortcut: `meshDetail` is the ONE value
 * `createBiobuzzScene` hands `buildBiobuzzField` (the field is built before the scene object
 * exists, so there is no `tier` to read there), and it is already resolved against the fixed
 * tier an EXPORT runs at. §4.4 has `meshDetail: 'low'` on the Low column alone, so this is the
 * same Low/everything-else split the venue makes, reached without a new argument.
 */
export function bbTileDetail(meshDetail: MeshDetail): BbTileDetail {
  return meshDetail === 'low' ? 'flat' : 'tiles';
}

/** floor-texture edge, in texels. 2048 over the 141.35-in field is 14.5 texels to the inch: a
 * 0.81-in interlock spans twelve of them and a 0.27-in flank lean four, so the dovetail reads as a
 * dovetail. 2048² RGBA + mips is ~22 MB, against ~5.6 at 1024. */
export const TILE_TEX_SIZE: Record<BbTileDetail, number> = { flat: 1024, tiles: 2048 };

// ──────────────────────────────────────────────────────────────── the measured tile geometry ──

/** the interlock, measured off the STEP (see the header). Inches. */
export const BB_TILE_TOOTH = {
  /** one tab plus one socket, along the joint. */
  period: 2.369,
  /** a tab head, and a socket floor, fillet tangent to fillet tangent. */
  flat: 1.247,
  /** tab tip to socket floor, across the joint. */
  depth: 0.81,
  /** half of `depth`: how far a tab head / socket floor sits off the joint line. */
  amplitude: 0.405,
  /** the fillet at every corner of a tab. */
  fillet: 0.1247,
  /** tab heads on one tile edge (the two at its ends and the one at its middle are cut short). */
  perEdge: 10,
} as const;

/**
 * THE FLANK'S NUMBERS, in the flank's own frame (see `tileFlankPoints`): `e` how far each flat runs
 * past the flank's centre, `r` the fillet, `t1` where the lower fillet meets the straight flank,
 * `arcEnd` that point's angle about the fillet's centre (the fillet runs from −π/2 to it), `lean`
 * the flank's angle off square, and `clear` how far the whole flank reaches along the joint either
 * side of its centre. The physical-materials floor draws the same flank from these.
 */
export function tileFlankGeometry(): { e: number; r: number; t1: [number, number]; arcEnd: number; lean: number; clear: number } {
  const { period: P, flat: W, amplitude: A, fillet: r } = BB_TILE_TOOTH;
  const e = W / 2 - P / 4;
  // the lower flat's fillet, and the tangent line through the origin that touches it
  const cx = e;
  const cy = -A + r;
  const phi = Math.atan2(cy, cx) + Math.asin(r / Math.hypot(cx, cy));
  const k = cx * Math.cos(phi) + cy * Math.sin(phi);
  const t1: [number, number] = [k * Math.cos(phi), k * Math.sin(phi)];
  return {
    e,
    r,
    t1,
    arcEnd: Math.atan2(t1[1] - cy, t1[0] - cx),
    lean: Math.PI / 2 + phi,
    // the fillet bulges furthest along the joint where it faces straight along it
    clear: e + r,
  };
}

/**
 * THE FLANK, DERIVED — the four measured numbers above fix it. A flank is the common internal
 * tangent of the two fillets it joins, and it passes through the midpoint between a tab head's
 * centre and the next socket floor's (the flank's own centre). `e` is how far a flat runs past
 * that point: half a flat less a quarter period, 0.031 in — positive, which is the overhang.
 *
 * In a flank's own frame `(u, w)`: `u` along the joint from the flank's centre, `w` across it,
 * the LOWER flat (`w = −A`) on the left. Returns the path from the lower flat's end to the upper
 * flat's start, arcs sampled `arcSteps` segments each.
 */
export function tileFlankPoints(arcSteps = 6): [number, number][] {
  const { e, r, arcEnd } = tileFlankGeometry();
  const cx = e;
  const cy = -BB_TILE_TOOTH.amplitude + r;
  const a0 = -Math.PI / 2;
  const out: [number, number][] = [];
  for (let i = 0; i <= arcSteps; i++) {
    const a = a0 + ((arcEnd - a0) * i) / arcSteps;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  // the upper fillet is the lower one turned about the origin, walked the other way
  for (let i = arcSteps; i >= 0; i--) {
    const [x, y] = out[i];
    out.push([-x, -y]);
  }
  return out;
}

/**
 * THE JUNCTIONS a seam's interlock is laid out between: the five interior joints of
 * `BB_TILE_SEAMS`, plus one VIRTUAL junction a joint pitch beyond each end. The perimeter lines
 * (`BB_TILE_SEAMS[0]`/`[6]`) are not junctions — the outer tiles are cut straight 0.079 in past
 * the virtual one — so the outermost run is laid out from the virtual junction and carried on to
 * the perimeter along the corner's own 45° line.
 */
export function tileJunctions(): number[] {
  const s = BB_TILE_SEAMS;
  const inner = s.slice(1, s.length - 1);
  const lo = inner[0] - (inner[1] - inner[0]);
  const hi = inner[inner.length - 1] + (inner[inner.length - 1] - inner[inner.length - 2]);
  return [lo, ...inner, hi];
}

/**
 * WHICH WAY A SEAM'S CUTS LEAN, off the placed CAD tiles: a joint at constant x (`axis 'x'`) leaves
 * each junction toward +x as it runs toward +y; a joint at constant y leaves it toward −y as it
 * runs toward +x. The two together make each junction's X.
 */
export function tileSeamLean(axis: 'x' | 'y'): 1 | -1 {
  return axis === 'x' ? 1 : -1;
}

/**
 * THE SEAM between two junctions, as world-inch points — a PURE function, so the RENDER lane
 * measures the real polyline instead of grepping for one.
 *
 * `at` is the joint's own coordinate, `a`→`b` the two junctions along it (`tileJunctions`), and
 * `axis` says which world axis `at` is on: `'x'` is a joint running along y, `'y'` one along x.
 * In the run's own frame `s` goes from `a` (0) to `b` (L) and `t` across the joint:
 *
 *   junction cut   (0, 0) → (A, σA)
 *   the comb       flats at +σA centred L/2 + P/4 + nP, at −σA centred L/2 − P/4 + nP, joined by
 *                  `tileFlankPoints` at every L/2 + nP/2 that is clear of the three cuts
 *   middle cut     (L/2 − A, −σA) → (L/2 + A, σA)
 *   junction cut   (L − A, −σA) → (L, 0)
 *
 * with σ = `tileSeamLean(axis)`. Nothing is stretched: L is the CAD's own joint pitch, and the
 * comb is phase-locked to the middle of the run, which is where the CAD locks it.
 */
export function tileSeamPolyline(at: number, a: number, b: number, axis: 'x' | 'y', arcSteps = 6): [number, number][] {
  const { period: P, amplitude: A } = BB_TILE_TOOTH;
  const sigma = tileSeamLean(axis);
  const L = b - a;
  const mid = L / 2;
  const flank = tileFlankPoints(arcSteps);
  const { clear } = tileFlankGeometry();
  const st: [number, number][] = [
    [0, 0],
    [A, sigma * A],
  ];
  const nLo = Math.ceil((A + clear - mid) / (P / 2));
  const nHi = Math.floor((L - A - clear - mid) / (P / 2));
  for (let n = nLo; n <= nHi; n++) {
    const g = mid + (n * P) / 2;
    if (n === 0) {
      // the middle cut replaces this flank
      st.push([mid - A, -sigma * A], [mid + A, sigma * A]);
      continue;
    }
    // n even climbs −σA → +σA; n odd is the same flank with w mirrored (+σA → −σA)
    const flip = n % 2 === 0 ? sigma : -sigma;
    for (const [u, w] of flank) st.push([g + u, flip * w]);
  }
  st.push([L - A, -sigma * A], [L, 0]);
  return st.map(([s, t]) => (axis === 'x' ? [at + t, a + s] : [a + s, at + t]));
}

/**
 * ONE TILE'S OUTLINE, as a closed world-inch polygon: the four seams around tile (`ix`, `iy`),
 * 0…5 from −x/−y, each walked junction to junction. Built from the SAME `tileSeamPolyline` its
 * neighbours use, so the 36 of them tile the mat with no gap and no overlap.
 *
 * ⚠️ AN OUTER TILE'S WALL-SIDE EDGE IS STILL TABBED HERE, laid out about the virtual junction, and
 * reaches past the perimeter. The caller clips to the tiled span (`BB_TILE_SEAMS[0]`…`[6]`), and
 * that clip IS the CAD's straight cut: it takes the tabs off 0.079 in outside the joint line, and
 * the sockets between them survive as 0.48-in notches along every wall — which is what the
 * `-Side` and `-Corner` parts carry, and what cutting the tabs at the perimeter leaves on a real
 * field.
 */
export function tileOutline(ix: number, iy: number, arcSteps = 6): [number, number][] {
  const J = tileJunctions();
  const bottom = tileSeamPolyline(J[iy], J[ix], J[ix + 1], 'y', arcSteps);
  const right = tileSeamPolyline(J[ix + 1], J[iy], J[iy + 1], 'x', arcSteps);
  const top = tileSeamPolyline(J[iy + 1], J[ix], J[ix + 1], 'y', arcSteps).reverse();
  const left = tileSeamPolyline(J[ix], J[iy], J[iy + 1], 'x', arcSteps).reverse();
  // each run ends on the junction the next one starts on
  return [...bottom, ...right.slice(1), ...top.slice(1), ...left.slice(1, -1)];
}

/** a straight seam, as the same shape of polyline — the PERIMETER edge of the mat, which the
 * `-Side`/`-Corner` variants really do cut straight (see the header's table). */
export function straightSeamPolyline(at: number, a: number, b: number, axis: 'x' | 'y'): [number, number][] {
  return axis === 'x' ? [[at, a], [at, b]] : [[a, at], [b, at]];
}

/**
 * every seam of the mat, as `{ points, interior }`. The two OUTER lines of `BB_TILE_SEAMS` are the
 * mat's own edge at the wall and are straight; the five interior joints are the interlock, one run
 * per junction-to-junction cell, the two end runs carried on to the perimeter along their cut.
 */
export function tileSeamPaths(detail: BbTileDetail, arcSteps = 6): { points: [number, number][]; interior: boolean }[] {
  const seams = BB_TILE_SEAMS;
  const lo = seams[0];
  const hi = seams[seams.length - 1];
  const junctions = tileJunctions();
  const out: { points: [number, number][]; interior: boolean }[] = [];
  for (const axis of ['x', 'y'] as const) {
    const sigma = tileSeamLean(axis);
    for (let i = 0; i < seams.length; i++) {
      const interior = i > 0 && i < seams.length - 1;
      if (!interior || detail === 'flat') {
        out.push({ points: straightSeamPolyline(seams[i], lo, hi, axis), interior: false });
        continue;
      }
      const at = seams[i];
      const pt = (s: number, t: number): [number, number] => (axis === 'x' ? [at + t, s] : [s, at + t]);
      for (let j = 0; j < junctions.length - 1; j++) {
        const points = tileSeamPolyline(at, junctions[j], junctions[j + 1], axis, arcSteps);
        // the outer runs, on to the perimeter along the junction's own 45° cut
        if (j === 0) points.unshift(pt(lo, sigma * (lo - junctions[0])));
        if (j === junctions.length - 2) points.push(pt(hi, sigma * (hi - junctions[j + 1])));
        out.push({ points, interior: true });
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────── the mat colour ──

/**
 * THE MAT — NEUTRAL GREY, AND LIGHT, WHICH IS WHAT A REAL TILE IS.
 *
 * SOURCED: AndyMark **am-2499** ships a 2 ft x 2 ft x 5/8 in EVA foam tile whose published
 * specification colour is simply **"Gray"**, and FTC lays it **smooth side up** (the vendor's own
 * setup note). ⚠️ **NO HEX IS PUBLISHED ANYWHERE**, and the field CAD carries a placeholder
 * `808080`, so the HUE is sourced and the LUMINANCE is JUDGED.
 *
 * ⚠️ **THE CEILING IS ON-FIELD TEXT.** The on-field HUD tokens are canvas text over whatever the
 * field is, and they are tuned for a dark one. MEASURED against `--ds-on-field-dim` (#b9beb8) at
 * the AA floor of 4.5:
 *
 *     mat        on-field   on-field-dim   on-field-accent
 *     #3a3a3a      10.86         6.02            4.63
 *     #454545       9.15         5.08            3.90
 *     #585858       6.79         3.77 ✗          2.89 ✗
 *
 * So **#585858 was tried and backed out**. #454545 is the lightest grey at which every on-field
 * TEXT token still clears 4.5. Going lighter is a re-tune of the whole `--ds-on-field*` family.
 *
 * ⚠️ **3D ONLY. `COLORS.mat`/`COLORS.tile` ARE UNTOUCHED**, because those are the 2D canvas
 * field for all three games.
 */
export const TILE_MAT = '#454545';

/**
 * THE JOINT — a DARK HAIRLINE, and nothing lighter than the mat anywhere near it.
 *
 * Two die-cut foam edges pressed together: what shows from above is the hairline gap and the
 * shadow of the two slightly rounded top edges either side of it. So the seam is painted as a
 * dark core over a softer shade, both darker than the mat. The previous seam was a 0.24-in LIGHT
 * lip over a 0.44-in dark groove, which reads as an embossed outline — no tile has one — and its
 * light/dark pair broke into a beaded line wherever the teeth were a few pixels apart.
 *
 * Darker than the mat means these can only WIDEN a `contrast.mjs` ratio: nothing measured there
 * is ever compared against a ground below the mat.
 */
export const TILE_JOINT = '#232323';
/** the rounded edges either side of the gap, falling off into the mat */
export const TILE_JOINT_SHADE = '#383838';
/** stroke widths, in INCHES (the caller converts with its own texels-per-inch). The core is about
 * one texel at 2048: thinner than that and the canvas would only paint it as a fainter line. */
export const TILE_JOINT_W = 0.07;
export const TILE_JOINT_SHADE_W = 0.2;
/** where there is no tile inside the wall — the 0.089-in strip the tiles stop short of it, and the
 * socket notches the straight cut leaves along it (`tileOutline`): the floor 5/8 in down, in the
 * wall's shadow. */
export const TILE_VOID = '#161616';

// ───────────────────────────────────────────────────────────────────────── per-tile variation ──

/** DETERMINISTIC per-tile noise — the same field on every machine and in every exported frame.
 * Same hash `renderVenue.ts`'s crowd and `renderEnvironment.ts`'s stars use. */
function tRand(i: number): number {
  let t = (i * 0x9e3779b1) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * A REAL FIELD IS 36 MATS, NOT A SHEET, and the second-biggest reason it reads that way (after
 * the seam) is that no two of them are the same tone — foam takes scuffs and takes them per
 * tile, and AndyMark warns of batch variance. This is a 0…−8 % multiplier on the mat,
 * deterministic in the tile's own grid index.
 *
 * ⚠️ DOWNWARD ONLY. `TILE_MAT` is the measured ceiling (see its own note) and a jitter that
 * could go UP is a jitter that could quietly walk a measured pair past its floor without
 * anything failing. Nothing this paints is ever lighter than `TILE_MAT`.
 *
 * ⚠️ AND IT LANDS ON A HANDFUL OF VALUES, NOT THIRTY-SIX — that is 8-BIT sRGB, not a weak
 * hash. The mat is `0x45`, so 0…−8 % spans 63.6…69 and every tile rounds into one of seven
 * steps. The RENDER lane DERIVES the count from the base rather than pinning it.
 */
export function tileTone(ix: number, iy: number): string {
  const f = 1 - 0.08 * tRand(ix * 131 + iy * 7919 + 17);
  const base = parseInt(TILE_MAT.slice(1, 3), 16);
  const v = Math.max(0, Math.min(255, Math.round(base * f)));
  const h = v.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}

/*
 * ⚠️ THERE IS NO GRAIN MAP ON THE STANDARD FLOOR ANY MORE (2026-09-28), and that is the owner's
 * "nothing in graphics that mesh and create weird visual effects". It was a 256² value-noise
 * normal + roughness pair REPEATED 24 times across the field — four identical copies per tile,
 * 5.9 in apart — with 65 % of its relief in a 0.19-in octave, ten times coarser than EVA's closed
 * cells. It read as a mottle that visibly repeated, and a normal map that coarse shimmers in
 * motion. A smooth-side-up EVA tile has no relief a camera here can resolve: its cells are
 * 0.005–0.02 in, far under a pixel at any camera this game has. The physical-materials floor
 * (Extreme) draws that scale as its own filtered stipple (`graphics/finishes.ts`, `tile`).
 */
