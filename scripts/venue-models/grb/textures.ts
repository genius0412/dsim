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
  board0: 0,
  board1: 0,
  board2: 0,
  liveIdle: 0,
  fascia_edison: 0,
  fascia_franklin: 0,
  fascia_goodall: 0,
  fascia_ross: 0,
  fascia_lovelace: 0,
  fascia_jackson: 0,
  fasciaLive: 0,
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

// ── THE LED WALLS' PICTURES ──────────────────────────────────────────────────────────────────
// Generic match scoreboards: a red and a blue score, a clock, a phase bar, a few rows of results.
// Drawn in pixels with seven-segment digits, so no font, no logo and no artwork is involved. A 0
// tile size marks a picture mapped 0..1 across a screen face rather than tiled.

type Px = { w: number; h: number; d: Float32Array };
const canvasOf = (w: number, h: number): Px => ({ w, h, d: new Float32Array(w * h * 3) });
function rect(c: Px, x0: number, y0: number, x1: number, y1: number, rgb: Rgb): void {
  for (let y = Math.max(0, Math.round(y0)); y < Math.min(c.h, Math.round(y1)); y++)
    for (let x = Math.max(0, Math.round(x0)); x < Math.min(c.w, Math.round(x1)); x++) c.d.set(rgb, (y * c.w + x) * 3);
}
/** segments a..g of each digit, the usual order */
const SEG: Record<string, string> = { '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcfgd', '-': 'g' };
function digit(c: Px, ch: string, x: number, y: number, w: number, h: number, rgb: Rgb): void {
  const t = Math.max(2, w * 0.18);
  const segs = SEG[ch] ?? '';
  const hh = h / 2;
  const at: Record<string, [number, number, number, number]> = {
    a: [x + t, y, x + w - t, y + t], d: [x + t, y + h - t, x + w - t, y + h], g: [x + t, y + hh - t / 2, x + w - t, y + hh + t / 2],
    f: [x, y + t, x + t, y + hh], b: [x + w - t, y + t, x + w, y + hh], e: [x, y + hh, x + t, y + h - t], c: [x + w - t, y + hh, x + w, y + h - t],
  };
  for (const sgm of segs) rect(c, ...at[sgm], rgb);
}
function text7(c: Px, s: string, x: number, y: number, w: number, h: number, rgb: Rgb): void {
  let cx = x;
  for (const ch of s) {
    if (ch === ':') {
      rect(c, cx + w * 0.15, y + h * 0.28, cx + w * 0.35, y + h * 0.38, rgb);
      rect(c, cx + w * 0.15, y + h * 0.62, cx + w * 0.35, y + h * 0.72, rgb);
      cx += w * 0.55;
      continue;
    }
    digit(c, ch, cx, y, w, h, rgb);
    cx += w * 1.25;
  }
}
const RED: Rgb = [214, 52, 46];
const BLUE: Rgb = [46, 104, 222];
const WHITE: Rgb = [235, 238, 242];
const DIM: Rgb = [70, 76, 88];
/** the shared layout: background, two alliance panels with their scores, the clock between them */
function boardBase(red: string, blue: string, clock: string, phase: number): Px {
  const c = canvasOf(512, 288);
  rect(c, 0, 0, 512, 288, [10, 12, 18]);
  rect(c, 0, 0, 512, 22, [24, 28, 38]);
  for (let i = 0; i < 6; i++) rect(c, 14 + i * 22, 7, 30 + i * 22, 15, i < 3 ? RED : BLUE);
  rect(c, 16, 40, 200, 180, [120, 24, 22]);
  rect(c, 312, 40, 496, 180, [22, 50, 120]);
  text7(c, red, 34 + (3 - red.length) * 50, 62, 40, 96, WHITE);
  text7(c, blue, 330 + (3 - blue.length) * 50, 62, 40, 96, WHITE);
  text7(c, clock, 214, 84, 20, 46, WHITE);
  // the phase bar under the clock: how much of the match has run
  rect(c, 214, 150, 298, 158, DIM);
  rect(c, 214, 150, 214 + 84 * phase, 158, [230, 196, 70]);
  return c;
}
async function encodeBoard(sharp: any, c: Px): Promise<Uint8Array> {
  const buf = Buffer.alloc(c.w * c.h * 4);
  for (let i = 0; i < c.w * c.h; i++) {
    buf[i * 4] = clamp8(c.d[i * 3]);
    buf[i * 4 + 1] = clamp8(c.d[i * 3 + 1]);
    buf[i * 4 + 2] = clamp8(c.d[i * 3 + 2]);
    buf[i * 4 + 3] = 255;
  }
  return new Uint8Array(await sharp(buf, { raw: { width: c.w, height: c.h, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer());
}
/** three generic boards (different matches) and the live screen's idle frame (0–0, the full clock) */
async function boards(sharp: any): Promise<Pick<Record<TexName, Uint8Array>, 'board0' | 'board1' | 'board2' | 'liveIdle'>> {
  const b0 = boardBase('128', '96', '1:47', 0.25);
  // results rows under the panels
  for (let r = 0; r < 4; r++) {
    rect(b0, 16, 196 + r * 22, 248, 212 + r * 22, r % 2 ? [40, 20, 22] : [52, 22, 24]);
    rect(b0, 264, 196 + r * 22, 496, 212 + r * 22, r % 2 ? [18, 26, 48] : [22, 32, 60]);
  }
  const b1 = boardBase('212', '187', '0:23', 0.85);
  for (let r = 0; r < 4; r++) rect(b1, 16 + r * 122, 200, 126 + r * 122, 268, r % 2 ? [22, 44, 100] : [96, 24, 22]);
  // a bracket: alliance pills joined by lines
  const b2 = canvasOf(512, 288);
  rect(b2, 0, 0, 512, 288, [10, 12, 18]);
  for (let col = 0; col < 3; col++) {
    const n = 4 >> col;
    for (let k = 0; k < n; k++) {
      const y = 24 + ((k + 0.5) * 240) / n;
      rect(b2, 20 + col * 168, y - 26, 150 + col * 168, y - 4, RED);
      rect(b2, 20 + col * 168, y + 4, 150 + col * 168, y + 26, BLUE);
      text7(b2, String(40 + ((k * 37 + col * 53) % 160)), 116 + col * 168, y - 23, 8, 16, WHITE);
      text7(b2, String(30 + ((k * 61 + col * 29) % 150)), 116 + col * 168, y + 7, 8, 16, WHITE);
      if (col < 2) rect(b2, 150 + col * 168, y - 1, 188 + col * 168, y + 1, DIM);
    }
  }
  const idle = boardBase('0', '0', '2:30', 0);
  return { board0: await encodeBoard(sharp, b0), board1: await encodeBoard(sharp, b1), board2: await encodeBoard(sharp, b2), liveIdle: await encodeBoard(sharp, idle) };
}


// ── THE STAGE FASCIA (2026-11-04): the LED panels along a stage's audience face ───────────────────
// The 2025 photographs show the front of each FTC stage clad in LED panels: the season's game area at
// one end, "CHAMPIONSHIP", then each alliance's teams and score either side of the clock. Drawn here as
// a 2048 × 64 strip in plain shapes: a game area of colour blocks (no game logo), the DIVISION NAME in
// a 5 × 7 pixel face, red and blue score blocks and the clock. Our stage's strip is redrawn live.

/** a 5 × 7 pixel face, the letters the division names need */
const GLYPH: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
};
function word(c: Px, w: string, x: number, y: number, px: number, rgb: Rgb): number {
  let cx = x;
  for (const ch of w) {
    const g = GLYPH[ch];
    if (g) for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) if (g[r][q] === '1') rect(c, cx + q * px, y + r * px, cx + (q + 1) * px - 0.5, y + (r + 1) * px - 0.5, rgb);
    cx += 6 * px;
  }
  return cx;
}
/** one stage's strip */
function fasciaStrip(name: string, red: string, blue: string, clock: string): Px {
  const c = canvasOf(2048, 64);
  rect(c, 0, 0, 2048, 64, [6, 7, 10]);
  // the game area: colour blocks only
  rect(c, 8, 8, 120, 56, [30, 120, 150]);
  rect(c, 128, 8, 200, 56, [200, 160, 40]);
  rect(c, 208, 8, 236, 56, [80, 50, 120]);
  word(c, name.toUpperCase(), 270, 11, 6, WHITE);
  // the alliance strip: red score, clock, blue score
  rect(c, 820, 6, 1200, 58, [150, 26, 24]);
  rect(c, 1360, 6, 1740, 58, [24, 56, 150]);
  for (let k = 0; k < 3; k++) {
    rect(c, 836 + k * 92, 18, 916 + k * 92, 46, [90, 18, 18]);
    rect(c, 1376 + k * 92, 18, 1456 + k * 92, 46, [18, 34, 96]);
  }
  text7(c, red, 1120 - (red.length - 1) * 30, 12, 22, 40, WHITE);
  text7(c, blue, 1660 - (blue.length - 1) * 30, 12, 22, 40, WHITE);
  text7(c, clock, 1222, 12, 22, 40, WHITE);
  rect(c, 1760, 8, 2040, 56, [20, 24, 34]);
  return c;
}
async function fascias(sharp: any): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  const demo: Record<string, [string, string, string]> = {
    edison: ['54', '61', '1:12'], franklin: ['0', '0', '2:30'], goodall: ['118', '97', '0:41'],
    ross: ['33', '40', '1:58'], lovelace: ['142', '139', '0:09'], jackson: ['76', '88', '1:30'],
  };
  for (const [name, [r, b, t]] of Object.entries(demo)) out[`fascia_${name}`] = await encodeBoard(sharp, fasciaStrip(name, r, b, t));
  out.fasciaLive = await encodeBoard(sharp, fasciaStrip('franklin', '0', '0', '2:30'));
  return out;
}

export async function makeTextures(sharp: any): Promise<Record<TexName, Uint8Array>> {
  return {
    concrete: await concrete(sharp),
    carpet: await carpet(sharp),
    slats: await slats(sharp),
    deck: await deck(sharp),
    block: await block(sharp),
    ...(await boards(sharp)),
    ...(await fascias(sharp)),
  } as Record<TexName, Uint8Array>;
}
