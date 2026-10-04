import * as THREE from 'three';
import type { EnvironmentDef } from '../graphics/environments';
import {
  CONCRETE_BAY_IN,
  FINISHES,
  MAPLE_RACK_IN,
  MAPLE_STRIP_IN,
  VENUE_FLOOR_FINISH,
  VINYL_ROLL_IN,
  type FinishId,
} from '../graphics/finishes';
import { TwinCache, restoreTree, swapTree, type TwinRecipe } from './renderSurfaceKit';

/**
 * THE VENUE'S AND THE ELEMENTS' PHYSICAL FINISHES, for the `materials: 'physical'` row — the
 * scenery around and on the field. Part of the lazy `renderSurfaces` chunk; match only (the
 * builder preview has no venue and no elements).
 *
 * ── THE FLOORS ──────────────────────────────────────────────────────────────────────────────
 * Every floor in `renderVenue.ts` is the same matte mottle (`groundTexture`: 128² over 48 in,
 * roughness 0.94), whatever the room. Physical mode lays the floor the room actually has
 * (`VENUE_FLOOR_FINISH`), generated here in code — no download, the same floor on every machine:
 *
 *   floor           where                      tile           texels/in  what is painted
 *   maple strip     gym, school-hall           90 × 45 in     11 × 23    20 strips, racked board
 *                                                                        joints, board tone and
 *                                                                        warmth, growth lines
 *   sheet vinyl     room, arena                144 × 144 in   7.1        two 72-in rolls, welded
 *                                                                        seams, printed pepper
 *   sealed concrete workshop                   288 × 288 in   3.6        2 × 2 bays, saw cuts,
 *                                                                        trowel mottle; + a
 *                                                                        roughness map (patchy sheen)
 *   asphalt         overcast, sunset, night    48 × 48 in     21         exposed stones in binder
 *   studio paint    the three studios          (the base's own mottle; roughness only)
 *
 * THE TEXEL DENSITIES ARE WHAT THE CAMERAS RESOLVE, not a round number. From the driver the
 * ground is only ever past the far wall, 230+ in off at ≤ 15° grazing, where a 2.25-in strip is ~8
 * px across at Extreme and nothing finer survives the mips; from orbit (90–620 in) the ground is a
 * large part of the frame at ~3–6 px per inch. So the maple is dense ACROSS its strips (a strip
 * edge is a line the eye follows) and half that along them, where the wood barely changes; the
 * concrete, whose features are feet across, is the sparsest; the asphalt, whose stones ARE the
 * surface, is the densest and the smallest tile, because a stochastic speckle does not show that
 * it repeats. Anything finer than a texel — the wood's fibres, the vinyl's emboss, the concrete's
 * fines, a stone's relief — is the kit's triplanar DETAIL at the size the finish table gives it.
 * Every tile is 1024² RGBA8 (5.6 MB with mips; the concrete's 256² roughness map 0.35 MB), ONE per
 * venue, freed with it, and costs 40–70 ms of arithmetic to paint (measured in Node, per floor) —
 * once per venue build, never per frame.
 *
 * ⚠️ THE TINT RULES STILL HOLD. The venue ground must be "a tint, not a colour" (chroma ≤ 0.26)
 * and averages to the environment's `floor` (the RENDER lane pins both on the standard path). Every
 * floor is painted AROUND that colour: each channel's MEAN is normalised to exactly the floor's
 * own (`packAlbedo`), so the ground averages to the value, hue and chroma it always had whatever
 * the pattern did, and the twin's `color` stays white (`color` multiplies `map` — the
 * squared-albedo bug the ground shipped once). A board a few percent warmer than the next is
 * wood; a floor that averages warmer than its spec is a different floor.
 *
 * ⚠️ THE MAPLE'S COAT REFLECTS THE PROBE, AND ONLY THE PROBE. A gym floor's gloss is a picture of
 * the lamp grid over it, and the probe (`renderSurfaceProbe.ts`) holds exactly that grid, box-
 * projected to the room — with the field's structures and the robots hidden, so the floor mirrors
 * the ROOM and never a frozen copy of the field. The rig's SUN is not in that picture and must not
 * be added on top: in a hall it stands in for those same lamps, and its direct term on a 0.12-rough
 * coat is a single white disc on the floor wherever a camera looks back toward the sun (measured
 * from a high orbit in `school-hall`: up to 79/255 over the damped frame, clipping to white) — the
 * lamps counted twice, once as a grid and once as a sun. So the coat's direct specular is scaled
 * out in an enclosed venue (`dampCoatDirect`); the base layer under it (roughness 0.55) keeps the
 * sun, which is the soft sheen a lit wood floor really has.
 *
 * ── THE WALLS AND THE STRUCTURE ─────────────────────────────────────────────────────────────
 * Out of focus from every camera, so they change MATERIAL only — no detail, no texture: eggshell
 * wall paint, a flat ceiling, a painted-steel truss, and a studio's cyclorama in the same paint as
 * its floor. The crowd, the seating, the horizon and the mast poles keep `surface()`'s matte
 * roughness (cloth and far silhouettes have no better answer), and the lamp fittings are never
 * twinned (the kit refuses anything tagged `bloomBase`). None of this adds a draw, a triangle or a
 * caster: a twin is a material on the SAME mesh, so the venue's budget checks hold as they are.
 *
 * ── THE ELEMENTS ────────────────────────────────────────────────────────────────────────────
 * `applyElements` is the scenery applier's hook and is a no-op in the core pass. POLLEN and
 * NECTAR carry a small emissive (0.12 / 0.05, a legibility fudge from 2026-09-18); a physical twin
 * would copy it, not add to it, but whether a PE ball should keep it is the owner's call, and their
 * colours are pinned by the element-contrast measurements. `elementPolyethylene` is in the table.
 */

// ═══════════════════════════════════════════════════════════════════ the floors, as data ══

/** every generated floor tile's edge, texels (the header's table) */
const FLOOR_PX = 1024;
/** 20 strips of `MAPLE_STRIP_IN` across the maple tile — 45 in, a whole number of strips, so it
 * repeats without a half-strip seam — and twice that ALONG them: a board is 12–72 in long, and a
 * tile as long as it is wide holds too few of them per strip to look random. */
const MAPLE_STRIPS = 20;
const MAPLE_RUN_IN = 90;
/** two rolls to the vinyl tile and two bays each way to the concrete's: ONE of either, repeated,
 * is a grid of identical panels that reads as a texture at once; two is not */
const VINYL_ROLLS = 2;
const CONCRETE_BAYS = 2;
/** the asphalt tile, inches. A stochastic speckle cannot be seen to repeat, so it is the smallest
 * tile and the densest */
const ASPHALT_TILE_IN = 48;
/** the concrete's roughness map: its patches are feet across, so 1.1 in per texel is plenty */
const CONCRETE_ROUGH_PX = 256;

/** ONE GENERATED FLOOR TILE, as plain bytes — pure arithmetic, no canvas and no GL, so the RENDER
 * lane can pin a floor (its mean against the environment's `floor`, that two builds agree) in Node. */
export interface FloorTile {
  /** the albedo's edge in texels (square); RGBA8, sRGB */
  px: number;
  albedo: Uint8Array;
  /** inches of floor one repeat covers, along u (x) and v (y) */
  inU: number;
  inV: number;
  /** roughness in every colour channel (three reads G), linear, averaging the finish's own
   * `roughness`; only a finish whose sheen is really patchy has one */
  rough: { px: number; data: Uint8Array } | null;
}

/**
 * A 32-BIT HASH, 0–1, exact for any integer input. The kit's `surfaceRand` multiplies in DOUBLES
 * first, which is exact only below ~3.4 M, and a floor hashes a million texel indices per seed:
 * past that bound the product's low bits are rounded away before the mixer sees them. `Math.imul`
 * throughout costs nothing and takes the question away. Same mixer otherwise, so the same floor on
 * every machine.
 */
function fhash(seed: number, i: number): number {
  let t = Math.imul(Math.imul(seed | 0, 0x27d4eb2d) ^ (i | 0), 0x9e3779b1);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * PERIODIC VALUE NOISE, 0–1, on a `gx` × `gy` lattice over the unit square — the kit's
 * `tileNoise` with the lattice PRECOMPUTED, because a floor samples it millions of times.
 */
function lattice(gx: number, gy: number, seed: number): (u: number, v: number) => number {
  const L = new Float32Array(gx * gy);
  for (let i = 0; i < L.length; i++) L[i] = fhash(seed, i);
  return (u, v) => {
    const x = (u - Math.floor(u)) * gx;
    const y = (v - Math.floor(v)) * gy;
    const i = Math.floor(x) % gx;
    const j = Math.floor(y) % gy;
    let fx = x - Math.floor(x);
    let fy = y - Math.floor(y);
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const i1 = i + 1 === gx ? 0 : i + 1;
    const r0 = j * gx;
    const r1 = (j + 1 === gy ? 0 : j + 1) * gx;
    const top = L[r0 + i] + (L[r0 + i1] - L[r0 + i]) * fx;
    return top + (L[r1 + i] + (L[r1 + i1] - L[r1 + i]) * fx - top) * fy;
  };
}

type Channels = [Float32Array, Float32Array, Float32Array];

function channels(n: number): Channels {
  return [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
}

/**
 * PACK per-channel factors around `hex`, each channel scaled so its MEAN is exactly that channel
 * of `hex` — the floor then averages to the environment's `floor` in value, hue and chroma
 * whatever the pattern did (the header's tint rule). Nothing comes near clipping: the brightest
 * floor painted is `gym`'s 0x8a6e49, and no factor reaches 1.8.
 */
function packAlbedo(hex: number, f: Channels): Uint8Array {
  const n = f[0].length;
  const out = new Uint8Array(n * 4);
  for (let c = 0; c < 3; c++) {
    const base = (hex >> (16 - 8 * c)) & 255;
    const ch = f[c];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += ch[i];
    const k = sum > 0 ? (base * n) / sum : 0;
    for (let i = 0; i < n; i++) out[i * 4 + c] = Math.min(255, Math.round(ch[i] * k));
  }
  for (let i = 0; i < n; i++) out[i * 4 + 3] = 255;
  return out;
}

/**
 * MAPLE STRIP. Twenty strips across the tile, running along u, each cut into boards at 1–3 joints
 * placed at random but RACKED: no joint within `MAPLE_RACK_IN` of one in the strip either side and
 * no board under a foot, because joints that line up are the first thing that reads as a pattern
 * instead of a floor. Each board has its own tone (±7 %) and warmth (±3 % red against blue), and
 * growth lines that wander along it; about one board in nine carries a thin grey mineral streak,
 * hard maple's own tell. A one-texel hairline (1.1 mm across, 2.2 mm along) marks each strip edge
 * and board end — the joint a finished floor really shows.
 */
function mapleTile(hex: number, seed: number): FloorTile {
  const S = FLOOR_PX;
  const stripPx = S / MAPLE_STRIPS;
  const pxIn = S / MAPLE_RUN_IN;
  const rack = MAPLE_RACK_IN * pxIn;
  const minBoard = 12 * pxIn;
  const gap = (a: number, b: number): number => {
    const d = Math.abs(a - b);
    return Math.min(d, S - d);
  };
  const joints: number[][] = [];
  for (let s = 0; s < MAPLE_STRIPS; s++) {
    const want = 1 + Math.floor(fhash(seed, s * 64) * 3);
    // the strips either side: the one before, and for the last one the first (the tile wraps)
    const beside = [...(joints[s - 1] ?? []), ...(s === MAPLE_STRIPS - 1 ? joints[0] : [])];
    const cuts: number[] = [];
    for (let t = 1; cuts.length < want && t < 48; t++) {
      const c = Math.floor(fhash(seed, s * 64 + t) * S);
      if (beside.every((j) => gap(c, j) >= rack) && cuts.every((j) => gap(c, j) >= minBoard)) cuts.push(c);
    }
    // never one board the length of the floor
    if (cuts.length === 0) cuts.push(Math.floor(fhash(seed + 1, s) * S));
    joints.push(cuts.sort((a, b) => a - b));
  }
  // which board of its strip each texel column is on (a strip's last board wraps to its first cut)
  const boardAt = new Uint8Array(MAPLE_STRIPS * S);
  for (let s = 0; s < MAPLE_STRIPS; s++) {
    const cuts = joints[s];
    for (let x = 0; x < S; x++) {
      let k = cuts.length - 1;
      for (let j = 0; j < cuts.length; j++) if (x >= cuts[j]) k = j;
      boardAt[s * S + x] = k;
    }
  }
  const B = MAPLE_STRIPS * 4;
  const tone = new Float32Array(B);
  const warm = new Float32Array(B);
  const phase = new Float32Array(B);
  const rings = new Float32Array(B);
  const streak = new Float32Array(B);
  for (let b = 0; b < B; b++) {
    const h = 5000 + b * 8;
    tone[b] = 1 + 0.07 * (2 * fhash(seed, h) - 1);
    warm[b] = 0.03 * (2 * fhash(seed, h + 1) - 1);
    phase[b] = fhash(seed, h + 2);
    // growth lines across the strip: a board cut near the pith shows few, a quartered one many
    rings[b] = 5 + 8 * fhash(seed, h + 5);
    streak[b] = fhash(seed, h + 3) < 0.11 ? 0.2 + 0.6 * fhash(seed, h + 4) : -1;
  }
  // growth lines wander along the board; fibre is long along it and fine across it
  const warp = lattice(3, 40, seed + 11);
  const fibre = lattice(6, 480, seed + 12);
  const fade = lattice(12, 1, seed + 13);
  const f = channels(S * S);
  for (let y = 0; y < S; y++) {
    const s = Math.min(MAPLE_STRIPS - 1, Math.floor(y / stripPx));
    const into = y - s * stripPx;
    const across = into / stripPx;
    const edge = into < 1;
    const cuts = joints[s];
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const b = s * 4 + boardAt[s * S + x];
      const u = x / S;
      const lines = Math.sin(2 * Math.PI * (rings[b] * across + 3.5 * warp(u, v + phase[b]) + phase[b]));
      let t = tone[b] * (1 + 0.016 * lines * lines * lines + 0.03 * (fibre(u, v) - 0.5));
      if (streak[b] >= 0) {
        const d = Math.abs(across - streak[b]) * stripPx;
        if (d < 2) t *= 1 - 0.1 * (1 - d / 2) * fade(u + phase[b], 0);
      }
      if (edge || cuts.includes(x)) t *= 0.8;
      const i = y * S + x;
      f[0][i] = t * (1 + warm[b]);
      f[1][i] = t;
      f[2][i] = t * (1 - warm[b]);
    }
  }
  return { px: S, albedo: packAlbedo(hex, f), inU: MAPLE_RUN_IN, inV: MAPLE_STRIPS * MAPLE_STRIP_IN, rough: null };
}

/**
 * SHEET VINYL. Two rolls across the tile, running along u. Each roll is its own dye lot (±2 %); the
 * welded seam between them is a texel (0.14 in, the weld rod's own width) a shade darker than the
 * sheet, with a hair of groove shadow either side — kept visible on purpose, because the seams are
 * the floor's only SCALE and parallax cue once the standard ground's 48-in grid is gone (the reason
 * `renderVenue.ts` gives for having one). The sheet itself is a printed pepper at three scales,
 * ±3–6 %, the texture a sports vinyl really has and invisible past a few yards.
 */
function vinylTile(hex: number, seed: number): FloorTile {
  const S = FLOOR_PX;
  const rollPx = S / VINYL_ROLLS;
  const broad = lattice(4, 4, seed + 21);
  const mid = lattice(64, 64, seed + 22);
  const pepper = lattice(256, 256, seed + 23);
  const lot = Array.from({ length: VINYL_ROLLS }, (_, r) => 1 + 0.02 * (2 * fhash(seed, 7000 + r) - 1));
  const f = channels(S * S);
  for (let y = 0; y < S; y++) {
    const r = Math.floor(y / rollPx);
    const into = y - r * rollPx;
    const seam = into === 0 ? 0.8 : into === 1 || into === rollPx - 1 ? 0.93 : 1;
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const t = lot[r] * seam * (1 + 0.03 * (broad(u, v) - 0.5)) * (1 + 0.04 * (mid(u, v) - 0.5)) * (1 + 0.06 * (pepper(u, v) - 0.5));
      const i = y * S + x;
      f[0][i] = t;
      f[1][i] = t;
      f[2][i] = t;
    }
  }
  const inches = VINYL_ROLLS * VINYL_ROLL_IN;
  return { px: S, albedo: packAlbedo(hex, f), inU: inches, inV: inches, rough: null };
}

/**
 * SEALED CONCRETE. Two by two bays between saw-cut control joints. Each bay is its own pour (±3 %);
 * over it, trowel clouds about two feet across (±6 %), smaller blotches, and sand-scale grain; each
 * joint is one texel (0.28 in) darkened to what a 1/8-in cut and the dirt in it average to, with a
 * faintly dirty margin. The ROUGHNESS map follows the same clouds: a burnished patch is both darker
 * and glossier, which is why a sealed slab's reflections break up into pools instead of a sheet.
 */
function concreteTile(hex: number, seed: number): FloorTile {
  const S = FLOOR_PX;
  const bayPx = S / CONCRETE_BAYS;
  const cloud = lattice(12, 12, seed + 31);
  const mid = lattice(48, 48, seed + 32);
  const fine = lattice(256, 256, seed + 33);
  const pour = Array.from({ length: CONCRETE_BAYS * CONCRETE_BAYS }, (_, b) => 1 + 0.03 * (2 * fhash(seed, 8000 + b) - 1));
  const f = channels(S * S);
  for (let y = 0; y < S; y++) {
    const by = Math.floor(y / bayPx);
    const jy = y - by * bayPx;
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const bx = Math.floor(x / bayPx);
      const jx = x - bx * bayPx;
      const toJoint = Math.min(jx, bayPx - jx, jy, bayPx - jy);
      const u = x / S;
      const i = y * S + x;
      let t = pour[by * CONCRETE_BAYS + bx] * (1 + 0.12 * (cloud(u, v) - 0.5)) * (1 + 0.06 * (mid(u, v) - 0.5));
      t *= (1 + 0.05 * (fine(u, v) - 0.5)) * (1 + 0.05 * (fhash(seed + 34, i) - 0.5));
      if (toJoint === 0) t *= 0.7;
      else if (toJoint <= 3) t *= 0.97;
      f[0][i] = t;
      f[1][i] = t;
      f[2][i] = t;
    }
  }
  // the sealer's sheen: 0.45–0.8, glossier where the trowel burnished it darker, then shifted so
  // its mean is the finish's own `roughness`
  const R = CONCRETE_ROUGH_PX;
  const patch = lattice(40, 40, seed + 35);
  const r = new Float32Array(R * R);
  let sum = 0;
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      const val = 0.3 * (cloud(x / R, y / R) - 0.5) + 0.12 * (patch(x / R, y / R) - 0.5);
      r[y * R + x] = val;
      sum += val;
    }
  }
  const shift = FINISHES.sealedConcrete.roughness - sum / (R * R);
  const rough = new Uint8Array(R * R * 4);
  for (let i = 0; i < R * R; i++) {
    const g = Math.round(Math.max(0, Math.min(1, r[i] + shift)) * 255);
    rough[i * 4] = g;
    rough[i * 4 + 1] = g;
    rough[i * 4 + 2] = g;
    rough[i * 4 + 3] = 255;
  }
  const inches = CONCRETE_BAYS * CONCRETE_BAY_IN;
  return { px: S, albedo: packAlbedo(hex, f), inU: inches, inV: inches, rough: { px: R, data: rough } };
}

/**
 * ASPHALT, WEATHERED DOWN TO ITS STONES. A binder darker than the mean, blotched (±3 %) and grained
 * (±6 %); on it, one candidate stone per 0.22-in cell (85 % of cells filled, so neighbours touch
 * the way a worn surface course's do), each an ellipse 0.08–0.32 in across at its own angle, a
 * spread of greys around the mean (×0.8–1.3) with one in seven dark, each a couple of percent warm
 * or cool, and a darker rim where it sinks into the binder. The first cut was sparse WHITE flecks on
 * a flat ground, which read as terrazzo; a road is mostly stone, and the stones are grey.
 *
 * ⚠️ AND LOW CONTRAST, because a stone is 1–4 px from the driver's seat. The first grey cut (binder
 * 0.72, stones ×0.8–1.3, texel grain ±6 %) sparkled: a 0.07-in camera shift changed the near
 * ground by a mean 8.1/255 per pixel where standard's ground changes by 0.22 and the maple by 0.8
 * (phase 3, 2026-09-27, the driver view in overcast). A worn surface course seen from a few feet
 * is a fine grey tooth, not salt and pepper: binder 0.82, stones ×0.88–1.18 (the dark one in
 * seven ×0.7–0.85), grain ±4 %. That takes the same shift to 4.9: what is left is the stones
 * themselves sliding with the ground under a mipmapped, anisotropic lookup — detail, not
 * aliasing — and any less contrast and the ground reads as the flat grey it replaced.
 * Drawn per stone, not searched per texel, and wrapped at the tile's edges like everything else.
 */
function asphaltTile(hex: number, seed: number): FloorTile {
  const S = FLOOR_PX;
  const pxIn = S / ASPHALT_TILE_IN;
  const blot = lattice(8, 8, seed + 41);
  const f = channels(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const t = 0.82 * (1 + 0.06 * (blot(x / S, y / S) - 0.5)) * (1 + 0.08 * (fhash(seed + 42, i) - 0.5));
      f[0][i] = t;
      f[1][i] = t;
      f[2][i] = t;
    }
  }
  const G = Math.round(ASPHALT_TILE_IN / 0.22);
  const cell = S / G;
  for (let cy = 0; cy < G; cy++) {
    for (let cx = 0; cx < G; cx++) {
      const h = (cy * G + cx) * 8;
      if (fhash(seed + 43, h) > 0.85) continue;
      const px0 = (cx + fhash(seed + 43, h + 1)) * cell;
      const py0 = (cy + fhash(seed + 43, h + 2)) * cell;
      const a = (0.04 + 0.12 * fhash(seed + 43, h + 3) ** 1.5) * pxIn;
      const b = a * (0.55 + 0.45 * fhash(seed + 43, h + 4));
      const th = Math.PI * fhash(seed + 43, h + 5);
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      const tone = fhash(seed + 43, h + 6) < 0.86 ? 0.88 + 0.3 * fhash(seed + 43, h + 7) : 0.7 + 0.15 * fhash(seed + 43, h + 7);
      const hue = 0.02 * (2 * fhash(seed + 44, h) - 1);
      const reach = Math.ceil(a);
      const x0 = Math.floor(px0);
      const y0 = Math.floor(py0);
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const ox = x0 + dx + 0.5 - px0;
          const oy = y0 + dy + 0.5 - py0;
          const p = (ox * cs + oy * sn) / a;
          const q = (oy * cs - ox * sn) / b;
          const d2 = p * p + q * q;
          if (d2 > 1) continue;
          const i = ((y0 + dy + S) % S) * S + ((x0 + dx + S) % S);
          const k = tone * (d2 > 0.55 ? 0.93 : 1);
          f[0][i] = k * (1 + hue);
          f[1][i] = k;
          f[2][i] = k * (1 - hue);
        }
      }
    }
  }
  return { px: S, albedo: packAlbedo(hex, f), inU: ASPHALT_TILE_IN, inV: ASPHALT_TILE_IN, rough: null };
}

/** the floors that are PAINTED, by finish; one not listed (studio paint) keeps the base's own map */
const FLOOR_TILES: Partial<Record<FinishId, (hex: number, seed: number) => FloorTile>> = {
  mapleFloor: mapleTile,
  sportsVinyl: vinylTile,
  sealedConcrete: concreteTile,
  outdoorAggregate: asphaltTile,
};

/** THE FLOOR `finish` paints around `floorHex`, or null for one that paints none. `seed` keeps two
 * venues with the same finish from being the same boards (`venueSeed`). */
export function venueFloorTile(finish: FinishId, floorHex: number, seed: number): FloorTile | null {
  return FLOOR_TILES[finish]?.(floorHex, seed) ?? null;
}

/** a stable seed per environment, from its id (FNV-1a) */
export function venueSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function floorTexture(data: Uint8Array, px: number, srgb: boolean, name: string): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, px, px, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  // the albedo is a COLOUR and decodes from sRGB; a roughness map is data and must not
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

/**
 * LAY a tile on the ground. `buildGround`'s UVs run 0–1 across the ground's whole width (a plane's
 * own, or a disc's rebuilt in inches), so that width IS the inches per UV unit — derived from the
 * geometry, not mirrored from `GROUND_TILE`. The phase puts a strip edge, a roll seam or a joint on
 * x = 0 and y = 0: the field sits square on the floor's own grid, the way a hall lays one out, and
 * the concrete's joints fall under the field and at ±144 in rather than along its perimeter.
 */
function layTile(tex: THREE.Texture, span: number, inU: number, inV: number): void {
  const phase = (repeats: number): number => {
    const o = -repeats / 2;
    return o - Math.floor(o);
  };
  tex.repeat.set(span / inU, span / inV);
  tex.offset.set(phase(span / inU), phase(span / inV));
}

/** the ground's full width, inches, off its geometry's own parameters (a plane or a disc) */
function groundSpan(mesh: THREE.Mesh): number {
  const p = (mesh.geometry as THREE.BufferGeometry & { parameters?: { width?: number; radius?: number } }).parameters;
  return p?.width ?? (p?.radius ?? 0) * 2;
}

/**
 * DROP A COAT'S DIRECT SPECULAR (the header's maple note): in an enclosed venue the probe already
 * holds every lamp the coat can mirror, and the rig's sun is those lamps again. Composed OVER the
 * kit's hook (called first, key extended); if three's composition line ever changes shape the coat
 * keeps three's own sum. Idempotent per twin.
 */
const COAT_SUM = '( clearcoatSpecularDirect + clearcoatSpecularIndirect )';

function dampCoatDirect(twin: THREE.MeshPhysicalMaterial, k: number): void {
  if (twin.userData.bbCoatDirect !== undefined) return;
  const uniform = { value: k };
  // the uniform itself, so a capture script can put the sun back to see what it did
  twin.userData.bbCoatDirect = uniform;
  const hook = twin.onBeforeCompile;
  const key = twin.customProgramCacheKey;
  twin.onBeforeCompile = (shader, renderer): void => {
    hook.call(twin, shader, renderer);
    if (!shader.fragmentShader.includes(COAT_SUM)) return;
    shader.uniforms.bbCoatDirect = uniform;
    shader.fragmentShader = `uniform float bbCoatDirect;\n${shader.fragmentShader.replace(
      COAT_SUM,
      '( clearcoatSpecularDirect * bbCoatDirect + clearcoatSpecularIndirect )',
    )}`;
  };
  twin.customProgramCacheKey = (): string => `${key.call(twin)}|coat`;
  twin.needsUpdate = true;
}

/** the venue's structure by mesh name (`renderVenue.ts`'s names); the ground and the shell's two
 * faces are picked in `apply`. What is not here keeps its base — see the header. */
const STRUCTURE: Readonly<Record<string, FinishId>> = {
  'bb-venue:truss': 'venueSteelPaint',
  'bb-venue:columns': 'venueWallPaint',
  'bb-venue:cyc': 'studioPaint',
};

export interface VenueSurfaces {
  apply(venue: THREE.Object3D, def: EnvironmentDef): void;
  revert(venue: THREE.Object3D): void;
  applyElements(group: THREE.Object3D): void;
  revertElements(group: THREE.Object3D): void;
  dispose(): void;
}

export function createVenueSurfaces(): VenueSurfaces {
  // a venue is rebuilt per environment and per scene; its twins and textures die with it
  const cache = new TwinCache(true);
  const textures = new Set<THREE.Texture>();
  // bumped on every revert: the cache keeps a released twin under its key, and a floor re-applied
  // to the same base must be built fresh, textures and all, rather than handed that one back
  let gen = 0;

  /** the ground's twin: the finish, and in `tweak` the floor it paints, laid to the ground's inches */
  const floorRecipe = (id: FinishId, def: EnvironmentDef, mesh: THREE.Mesh): TwinRecipe => ({
    id: `${id}:${def.id}:${gen}`,
    finish: FINISHES[id],
    // one flat plane in field inches; the maple's grain runs along its strips (x)
    space: 'world',
    axis: 0,
    tweak: (twin) => {
      const span = groundSpan(mesh);
      const tile = span > 0 ? venueFloorTile(id, def.venue.floor, venueSeed(def.id)) : null;
      if (!tile) return; // studio paint: the base's own map, a new roughness
      const albedo = floorTexture(tile.albedo, tile.px, true, `bb-venue:${id}`);
      layTile(albedo, span, tile.inU, tile.inV);
      textures.add(albedo);
      twin.map = albedo;
      if (!tile.rough) return;
      const rough = floorTexture(tile.rough.data, tile.rough.px, false, `bb-venue:${id}:rough`);
      layTile(rough, span, tile.inU, tile.inV);
      textures.add(rough);
      twin.roughnessMap = rough;
      // the map carries the roughness itself (its mean is the finish's), so the factor is 1
      twin.roughness = 1;
      // `tuneMaterials` gives `.map` the anisotropy row and nothing else; the roughness map follows
      // it here, at no cost until the row actually changes
      twin.onBeforeRender = (): void => {
        const a = albedo.anisotropy;
        if (rough.anisotropy !== a) {
          rough.anisotropy = a;
          rough.needsUpdate = true;
        }
      };
    },
  });

  return {
    apply(venue, def): void {
      const floor = VENUE_FLOOR_FINISH[def.id];
      const enclosed = def.venue.kind !== 'outdoor';
      swapTree(venue, (m, mesh) => {
        let twin: THREE.MeshPhysicalMaterial | null;
        if (mesh.name === 'bb-venue:ground') {
          twin = cache.get(m, floorRecipe(floor, def, mesh));
        } else {
          // the shell is one box with six face materials: index 4 is the ceiling (+z)
          const id =
            mesh.name === 'bb-venue:shell'
              ? Array.isArray(mesh.material) && mesh.material[4] === m
                ? 'venueCeiling'
                : 'venueWallPaint'
              : STRUCTURE[mesh.name];
          if (!id) return null;
          twin = cache.get(m, { id: `${id}:${gen}`, finish: FINISHES[id], space: 'world' });
        }
        if (twin && twin.clearcoat > 0 && enclosed) dampCoatDirect(twin, 0);
        return twin;
      });
    },
    revert(venue): void {
      const off = restoreTree(venue);
      for (const t of off) {
        const p = t as THREE.MeshPhysicalMaterial;
        for (const map of [p.map, p.roughnessMap]) if (map && textures.delete(map)) map.dispose();
      }
      cache.release(off);
      gen++;
    },
    applyElements(): void {
      /* the scenery applier's hook — see the header */
    },
    revertElements(group): void {
      cache.release(restoreTree(group));
    },
    dispose(): void {
      cache.releaseAll();
      for (const t of textures) t.dispose();
      textures.clear();
    },
  };
}
