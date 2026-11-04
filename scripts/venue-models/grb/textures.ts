/**
 * THE GRB VENUE'S TEXTURES, GENERATED (2026-11-04): no photograph, no download. Each is a few lines of
 * seeded noise and straight lines, encoded to PNG with `sharp` (the build then makes it KTX2). Sizes
 * are what each surface needs at the distance a camera can get to it; `TEX_TILE_IN` is how many inches
 * one repeat covers, which `generate.ts` uses for the UVs, so a texel is a real size on the floor.
 */

/** inches covered by one repeat of each texture */
export const TEX_TILE_IN = {
  concrete: 360,
  carpet: 96,
  slats: 24,
  deck: 24,
  block: 96,
} as const;
export type TexName = keyof typeof TEX_TILE_IN;

/** mulberry32: the build is deterministic, so a rebuild makes the same bytes */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** tileable value noise: a `cells`-periodic lattice, smoothstepped */
function valueNoise(size: number, cells: number, seed: number): Float32Array {
  const r = rng(seed);
  const lat = new Float32Array(cells * cells).map(() => r());
  const out = new Float32Array(size * size);
  const s = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cells;
    const y0 = Math.floor(fy);
    const ty = s(fy - y0);
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells;
      const x0 = Math.floor(fx);
      const tx = s(fx - x0);
      const a = lat[(y0 % cells) * cells + (x0 % cells)];
      const b = lat[(y0 % cells) * cells + ((x0 + 1) % cells)];
      const c = lat[((y0 + 1) % cells) * cells + (x0 % cells)];
      const d = lat[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
      out[y * size + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

/** the sum of `octaves` of value noise, zero-mean, roughly ±0.5 */
function fbm(size: number, base: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(size, base << o, seed + o * 101);
    for (let i = 0; i < out.length; i++) out[i] += (n[i] - 0.5) * amp;
    norm += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

type Rgb = [number, number, number];
const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

async function png(sharp: any, size: number, px: (i: number, x: number, y: number) => Rgb): Promise<Uint8Array> {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const [r, g, b] = px(i, x, y);
      buf[i * 4] = clamp8(r);
      buf[i * 4 + 1] = clamp8(g);
      buf[i * 4 + 2] = clamp8(b);
      buf[i * 4 + 3] = 255;
    }
  }
  return new Uint8Array(await sharp(buf, { raw: { width: size, height: size, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer());
}

/**
 * SEALED EXHIBIT-HALL CONCRETE, one 30-ft bay per repeat (the CAD's floor-pocket grid): mottled the
 * way a trowelled slab is, a saw-cut joint on the bay's two edges, and the bay's floor pocket, a steel
 * lid ~12 × 18 in, at the bay's centre. `generate.ts` starts the UVs half a bay before a CAD pocket
 * (`layout.ts`, FLOOR_POCKET), so every drawn pocket lands where the CAD has one.
 */
async function concrete(sharp: any): Promise<Uint8Array> {
  const size = 1024;
  const inPx = TEX_TILE_IN.concrete / size;
  const low = fbm(size, 4, 4, 11);
  const fine = fbm(size, 64, 2, 23);
  const r = rng(5);
  const speck = new Float32Array(size * size).map(() => (r() < 0.012 ? r() - 0.6 : 0));
  const half = TEX_TILE_IN.concrete / 2;
  const pu0 = (half - 6) / inPx;
  const pu1 = (half + 6) / inPx;
  const pv0 = (half - 9) / inPx;
  const pv1 = (half + 9) / inPx;
  return png(sharp, size, (i, x, y) => {
    let v = 138 + low[i] * 22 + fine[i] * 7 + speck[i] * 26;
    // saw-cut joints on the bay edges, ~3/16 in wide with a slightly darker shoulder
    const dx = Math.min(x, size - 1 - x);
    const dy = Math.min(y, size - 1 - y);
    if (dx < 1 || dy < 1) v -= 46;
    else if (dx < 3 || dy < 3) v -= 10;
    if (x >= pu0 && x <= pu1 && y >= pv0 && y <= pv1) {
      const edge = x < pu0 + 2 || x > pu1 - 2 || y < pv0 + 2 || y > pv1 - 2;
      v = edge ? 70 : 150 + fine[i] * 10;
    }
    return [v, v * 0.985, v * 0.96];
  });
}

/** CHARCOAL EVENT CARPET (needle-punch): fibre noise only, so the 8-ft repeat does not show */
async function carpet(sharp: any): Promise<Uint8Array> {
  const size = 512;
  const fine = fbm(size, 128, 2, 31);
  const mid = fbm(size, 16, 3, 37);
  return png(sharp, size, (i) => {
    const v = 44 + fine[i] * 18 + mid[i] * 6;
    return [v, v * 1.01, v * 1.06];
  });
}

/** ROLL-UP DOOR SLATS, 3-in pitch: a lit crown and a shadowed joint per slat (grey; the material
 * colours it) */
async function slats(sharp: any): Promise<Uint8Array> {
  const size = 256;
  const pitchPx = (3 / TEX_TILE_IN.slats) * size;
  const n = fbm(size, 8, 2, 41);
  return png(sharp, size, (i, _x, y) => {
    const t = (y % pitchPx) / pitchPx;
    const shade = t < 0.08 ? 0.55 : t < 0.5 ? 1 - (0.5 - t) * 0.25 : 1 - (t - 0.5) * 0.35;
    const v = 220 * shade + n[i] * 8;
    return [v, v, v];
  });
}

/** ROOF DECK FLUTES, 6-in pitch, seen from below (grey; the material darkens it) */
async function deck(sharp: any): Promise<Uint8Array> {
  const size = 256;
  const pitchPx = (6 / TEX_TILE_IN.deck) * size;
  return png(sharp, size, (_i, x) => {
    const t = (x % pitchPx) / pitchPx;
    const v = t < 0.35 ? 150 : t < 0.5 ? 190 : t < 0.85 ? 205 : 170;
    return [v, v, v];
  });
}

/** PAINTED CONCRETE BLOCK, 16 × 8 in units, running bond, the mortar a shade darker */
async function block(sharp: any): Promise<Uint8Array> {
  const size = 512;
  const inPx = TEX_TILE_IN.block / size;
  const n = fbm(size, 32, 2, 53);
  return png(sharp, size, (i, x, y) => {
    const yi = y * inPx;
    const course = Math.floor(yi / 8);
    const xi = x * inPx + (course % 2 ? 8 : 0);
    const inMortar = yi % 8 < 0.45 || xi % 16 < 0.45;
    const v = (inMortar ? 200 : 232) + n[i] * 6;
    return [v, v, v * 0.98];
  });
}

export async function makeTextures(sharp: any): Promise<Record<TexName, Uint8Array>> {
  return {
    concrete: await concrete(sharp),
    carpet: await carpet(sharp),
    slats: await slats(sharp),
    deck: await deck(sharp),
    block: await block(sharp),
  };
}
