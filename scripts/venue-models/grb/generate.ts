/**
 * THE GRB VENUE, GENERATED (2026-11-04) — Halls B3 and A3 at the George R. Brown Convention Center as
 * the FIRST Tech Challenge used them at the 2026 Championship, built from numbers (`layout.ts`, sourced
 * in `docs/venues/grb.md`) into a glTF `Document` that `build.ts` then places, checks and compresses
 * like any other venue source (`npx tsx scripts/venue-models/build.ts grb`).
 *
 * Everything is authored in the FIELD frame (inches, z up, our field at the origin) and written as
 * glTF (metres, y up), so the source is a normal glTF a viewer shows at real scale; `build.ts`'s
 * placement turns it back. Repeated things (columns, joists, truss sections, lamps, seats' supports,
 * fixtures, the neighbouring fields) are PARTS placed many times; the build makes each one a single
 * GPU-instanced draw. Everything else is merged into one mesh per material.
 *
 * ⚠️ NOTHING MAY STAND INSIDE `KEEP_CLEAR`. It is the box the sim's own eyes need (the RENDER lane's
 * sweep: a portrait phone's driver eye 293 in either side of centre, the menu stage's home eye at
 * y −205 and z 150, the chase eye 126 in out) grown by the build's 24-in camera margin. The real hall
 * has things in it (FRANKLIN's second field 28 ft away, the drive teams' tables, a queue cart, a run
 * of drape); each object that would be is LEFT OUT, and the build prints the list (`notes`).
 */
import { join } from 'node:path';
import * as L from './layout';
import { PIT_CELLS } from './pits';
import { TEX_TILE_IN, makeTextures, type TexName } from './textures';
import { Geo, beam, box, cyl, disc, drapeSheet, ellipsoid, placeM, type V3 } from './mesh';

const FT = 12;
const M_PER_IN = 0.0254;
const H = L.CEILING_FT * FT;

/** inches; see the header. The build's own clear box must contain it (it checks). */
export const KEEP_CLEAR = { min: [-320, -232, 0.5] as V3, max: [320, 153, 177] as V3 };

interface MatSpec {
  color: number;
  metal?: number;
  rough?: number;
  emissive?: number;
  strength?: number;
  tex?: TexName;
  /** UV origin, inches (the concrete's starts half a bay before a CAD floor pocket) */
  uvOrigin?: [number, number];
  double?: boolean;
  alpha?: number;
}

const POCKET_ORIGIN: [number, number] = [(L.FLOOR_POCKET.x0 - 15) * FT, (L.FLOOR_POCKET.y0 - 15) * FT];

/** THE MATERIALS. Colours are sRGB and deliberately desaturated: the field must stay the brightest,
 * most saturated thing on screen (`environments.ts`, THE VENUE). */
const MATS: Record<string, MatSpec> = {
  // the textures carry the pattern; these factors carry the albedo, tuned on captures against the
  // 2025 hall photographs (a sealed slab reads mid grey under event light, the walls an off-white)
  concrete: { color: 0x8a8884, rough: 0.55, tex: 'concrete', uvOrigin: POCKET_ORIGIN },
  carpet: { color: 0xdedede, rough: 0.97, tex: 'carpet' },
  wall: { color: 0xa9a7a1, rough: 0.9, tex: 'block' },
  wallBase: { color: 0x2c2d30, rough: 0.7 },
  dockDoor: { color: 0x8a2c26, rough: 0.5, metal: 0.35, tex: 'slats' },
  doorFrame: { color: 0x34373c, rough: 0.5, metal: 0.45 },
  door: { color: 0x434d5b, rough: 0.45, metal: 0.25 },
  exitSign: { color: 0x150000, emissive: 0xff2a1a, strength: 2.5 },
  column: { color: 0x4f6378, rough: 0.5, metal: 0.3 },
  fireCab: { color: 0x7c1c19, rough: 0.4, metal: 0.3 },
  steel: { color: 0x24272c, rough: 0.6, metal: 0.4 },
  deck: { color: 0x2f3236, rough: 0.8, metal: 0.2, tex: 'deck' },
  duct: { color: 0x6d737a, rough: 0.4, metal: 0.75 },
  lampBody: { color: 0x26282c, rough: 0.5, metal: 0.4 },
  lamp: { color: 0x000000, emissive: 0xfff1dc, strength: 3 },
  truss: { color: 0xa9adb2, rough: 0.33, metal: 0.85 },
  fixture: { color: 0x141518, rough: 0.45, metal: 0.3 },
  lens: { color: 0x000000, emissive: 0xfff7ec, strength: 5 },
  // a blank LED wall: lit, dark slate, no picture (no FIRST or sponsor artwork, by rule)
  screen: { color: 0x05070a, emissive: 0x1e2633, strength: 1, rough: 0.25 },
  black: { color: 0x101113, rough: 0.6 },
  drape: { color: 0x151517, rough: 1, double: true },
  standFrame: { color: 0x2e3135, rough: 0.6, metal: 0.4 },
  standDeck: { color: 0x41444a, rough: 0.7, metal: 0.25 },
  aisle: { color: 0x51545a, rough: 0.7, metal: 0.25 },
  bench: { color: 0x8a8f95, rough: 0.4, metal: 0.7 },
  rail: { color: 0x8d9298, rough: 0.35, metal: 0.8 },
  skirt: { color: 0x121214, rough: 1 },
  tableTop: { color: 0xc4c4bf, rough: 0.6 },
  tableLeg: { color: 0x6c7075, rough: 0.4, metal: 0.7 },
  monitorLit: { color: 0x020202, emissive: 0x2a3446, strength: 0.8 },
  chair: { color: 0x1c1d20, rough: 0.6, metal: 0.2 },
  cart: { color: 0x2f3237, rough: 0.5, metal: 0.4 },
  robot: { color: 0x3d4146, rough: 0.5, metal: 0.5 },
  toolbox: { color: 0x7a2a26, rough: 0.45, metal: 0.4 },
  riser: { color: 0x0f1012, rough: 0.95, double: true },
  practiceMat: { color: 0x5b5d61, rough: 0.9 },
  extrusion: { color: 0x9aa0a6, rough: 0.35, metal: 0.8 },
  polycarb: { color: 0xdfe6ee, rough: 0.08, alpha: 0.28, double: true },
  ...Object.fromEntries(Object.entries(L.PIT_DRAPE).map(([k, c]) => [`pit:${k}`, { color: c, rough: 1, double: true }])),
  ...Object.fromEntries([0x5e7f9e, 0x9c5a4d, 0x6d8a5a, 0x8a7b4e, 0x6a5f86, 0x4f7c7c, 0x9a8f86, 0x3d4a66].map((c, i) => [`banner${i}`, { color: c, rough: 0.9, double: true }])),
};

/** spectators' shirts (team colours, desaturated so no stand outshines the field) and skin tones */
const SHIRTS = [0x2c3a56, 0x70352f, 0x222326, 0x5f6368, 0x2c5759, 0x84733a, 0x96979a, 0x395b3a];
const SKINS = [0x8d5a3c, 0xb98a68, 0x5e3c2a, 0xcfa585];
Object.assign(MATS, {
  pants: { color: 0x26292e, rough: 0.85 },
  hair: { color: 0x241c17, rough: 0.8 },
  ...Object.fromEntries(SHIRTS.map((c, i) => [`shirt${i}`, { color: c, rough: 0.85 }])),
  ...Object.fromEntries(SKINS.map((c, i) => [`skin${i}`, { color: c, rough: 0.7 }])),
});

/** a seeded hash in [0, 1) of two numbers: the crowd and the pits' variety, the same every build */
function hash2(x: number, y: number): number {
  let h = Math.imul(Math.round(x * 10) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(y * 10), 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** a seated spectator at (x, y) on a bench top at z, facing the turn `rot` */
function spectator(v: Venue, x: number, y: number, z: number, rot: number, label: string): void {
  const h = hash2(x, y);
  v.place(`body${Math.floor(h * 997) % SHIRTS.length}`, x, y, z, rot, label);
  v.place(`head${Math.floor(h * 7919) % SKINS.length}`, x, y, z, rot, label);
  v.place('legs', x, y, z, rot, label);
}

/** how full the stands are between matches: ESTIMATED from the 2025–26 photographs (packed for
 * playoffs, about half full in qualification) */
const CROWD_SHARE = 0.42;
/** where a row's bench plank sits, feet back from the row's front edge (10 in deep, at the back of the
 * 32-in row so the feet have the front) */
const BENCH_FT = [1.55, 2.4] as const;

// ── THE SCENE, BEFORE IT IS GLTF ───────────────────────────────────────────────────────────────

type Part = Map<string, Geo>;

class Venue {
  batches = new Map<string, Geo>();
  parts = new Map<string, Part>();
  placements: { part: string; x: number; y: number; z: number; rot: number }[] = [];
  /** what KEEP_CLEAR dropped, by label */
  dropped = new Map<string, number>();

  private geoFor(map: Map<string, Geo>, mat: string): Geo {
    let g = map.get(mat);
    if (!g) {
      const s = MATS[mat];
      if (!s) throw new Error(`no material ${mat}`);
      g = new Geo(s.tex ? TEX_TILE_IN[s.tex] : 0);
      if (s.uvOrigin) (g as Geo & { origin?: [number, number] }).origin = s.uvOrigin;
      map.set(mat, g);
    }
    return g;
  }

  /** build one object into scratch geometry; keep it unless its standing part enters KEEP_CLEAR */
  obj(label: string, build: (g: (mat: string) => Geo) => void): boolean {
    const scratch = new Map<string, Geo>();
    build((mat) => this.geoFor(scratch, mat));
    if (blocks(scratch, null)) {
      this.dropped.set(label, (this.dropped.get(label) ?? 0) + 1);
      return false;
    }
    for (const [mat, g] of scratch) this.geoFor(this.batches, mat).append(g);
    return true;
  }

  part(name: string, build: (g: (mat: string) => Geo) => void): void {
    const p: Part = new Map();
    build((mat) => this.geoFor(p, mat));
    this.parts.set(name, p);
  }

  place(name: string, x: number, y: number, z: number, rot = 0, label = name): boolean {
    const p = this.parts.get(name);
    if (!p) throw new Error(`no part ${name}`);
    if (blocks(p, placeM(x, y, z, rot))) {
      this.dropped.set(label, (this.dropped.get(label) ?? 0) + 1);
      return false;
    }
    this.placements.push({ part: name, x, y, z, rot });
    return true;
  }
}

/** does any standing triangle of these geometries (moved by `m`) enter KEEP_CLEAR? */
function blocks(geos: Map<string, Geo>, m: number[] | null): boolean {
  const k = KEEP_CLEAR;
  for (const g of geos.values()) {
    for (let i = 0; i < g.idx.length; i += 3) {
      const lo: V3 = [Infinity, Infinity, Infinity];
      const hi: V3 = [-Infinity, -Infinity, -Infinity];
      for (let v = 0; v < 3; v++) {
        const q = g.idx[i + v] * 3;
        let x = g.pos[q], y = g.pos[q + 1], z = g.pos[q + 2];
        if (!Number.isFinite(x + y + z)) throw new Error('blocks: a vertex is not finite');
        if (m) [x, y, z] = [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
        lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); lo[2] = Math.min(lo[2], z);
        hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y); hi[2] = Math.max(hi[2], z);
      }
      if (hi[2] <= k.min[2]) continue;
      if (hi[0] < k.min[0] || lo[0] > k.max[0] || hi[1] < k.min[1] || lo[1] > k.max[1] || lo[2] > k.max[2]) continue;
      return true;
    }
  }
  return false;
}

const f = (ft: number) => ft * FT;

// ── THE HALL ───────────────────────────────────────────────────────────────────────────────────

/** the slab: concrete, with each division's carpet cut into it (no two surfaces share a plane) */
function floor(v: Venue): void {
  const W = L.WALLS;
  const carpets = L.DIVISIONS.map((d) => d.carpet);
  const xs = [...new Set([W.a3End, W.b3End, ...carpets.flatMap((c) => [c.x0, c.x1])])].sort((a, b) => a - b);
  const ys = [...new Set([W.concourse, W.dock, ...carpets.flatMap((c) => [c.y0, c.y1])])].sort((a, b) => a - b);
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      const cy = (ys[j] + ys[j + 1]) / 2;
      const onCarpet = carpets.some((c) => cx > c.x0 && cx < c.x1 && cy > c.y0 && cy < c.y1);
      v.obj('floor', (g) => g(onCarpet ? 'carpet' : 'concrete').poly([[f(xs[i]), f(ys[j]), 0], [f(xs[i + 1]), f(ys[j]), 0], [f(xs[i + 1]), f(ys[j + 1]), 0], [f(xs[i]), f(ys[j + 1]), 0]]));
    }
  }
}

interface WallRun {
  /** the wall's inside face: along x at `y` (dock/concourse) or along y at `x` (ends) */
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
  /** which way the inside faces (+1: toward +y / +x) */
  inward: 1 | -1;
}

const WALL_RUNS: WallRun[] = [
  { axis: 'x', at: L.WALLS.dock, from: L.WALLS.a3End, to: L.WALLS.b3End, inward: -1 },
  { axis: 'x', at: L.WALLS.concourse, from: L.WALLS.a3End, to: L.WALLS.b3End, inward: 1 },
  { axis: 'y', at: L.WALLS.b3End, from: L.WALLS.concourse, to: L.WALLS.dock, inward: -1 },
  { axis: 'y', at: L.WALLS.a3End, from: L.WALLS.concourse, to: L.WALLS.dock, inward: 1 },
];

/** a box on a wall's inside face: `s0..s1` along the wall, `z0..z1`, standing `d0..d1` in from it */
function onWall(g: Geo, w: WallRun, s0: number, s1: number, z0: number, z1: number, d0: number, d1: number): void {
  const a = f(w.at) + w.inward * d0;
  const b = f(w.at) + w.inward * d1;
  if (w.axis === 'x') box(g, [Math.min(s0, s1), Math.min(a, b), z0], [Math.max(s0, s1), Math.max(a, b), z1]);
  else box(g, [Math.min(a, b), Math.min(s0, s1), z0], [Math.max(a, b), Math.max(s0, s1), z1]);
}

function walls(v: Venue): void {
  const top = f(L.DECK_FT) + 6;
  for (const w of WALL_RUNS) {
    v.obj('wall', (g) => onWall(g('wall'), w, f(w.from) - 12, f(w.to) + 12, 0, top, -12, 0));
    v.obj('wall base', (g) => onWall(g('wallBase'), w, f(w.from), f(w.to), 0, 6, 0, 0.5));
  }
  // DRIVE-IN DOORS on the dock wall (CAD L3|DOORS, the 11–25 ft openings): roll-up doors, the coil
  // hood above. Height ESTIMATED: 14 ft for the 23–25 ft doors (GES's Level 1 figure), 12 ft for 11–13.5.
  const dock = WALL_RUNS[0];
  for (const [a, b] of L.DOCK_DOORS) {
    const h = b - a > 20 ? 14 : 12;
    v.obj('dock door', (g) => {
      onWall(g('dockDoor'), dock, f(a), f(b), 0, f(h), 0, 1.5);
      onWall(g('doorFrame'), dock, f(a) - 6, f(a), 0, f(h) + 6, 0, 4);
      onWall(g('doorFrame'), dock, f(b), f(b) + 6, 0, f(h) + 6, 0, 4);
      onWall(g('doorFrame'), dock, f(a) - 6, f(b) + 6, f(h), f(h) + 6, 0, 4);
      onWall(g('doorFrame'), dock, f(a) - 4, f(b) + 4, f(h) + 8, f(h) + 30, 0, 22);
    });
  }
  // PERSONNEL DOORS (CAD door swings, grouped): 3-ft leaves, 7 ft high, a lit exit sign over each set
  for (const [wi, sets] of [[0, L.PERSON_DOORS.dock], [1, L.PERSON_DOORS.concourse], [2, L.PERSON_DOORS.b3End]] as const) {
    const w = WALL_RUNS[wi];
    for (const [a, b] of sets) {
      const leaves = Math.max(1, Math.round((b - a) / 3));
      const c = (a + b) / 2;
      const s0 = f(c) - (leaves * 36) / 2;
      const s1 = f(c) + (leaves * 36) / 2;
      v.obj('door', (g) => {
        onWall(g('door'), w, s0, s1, 0, 84, 0, 1.2);
        onWall(g('doorFrame'), w, s0 - 3, s0, 0, 87, 0, 2.5);
        onWall(g('doorFrame'), w, s1, s1 + 3, 0, 87, 0, 2.5);
        onWall(g('doorFrame'), w, s0 - 3, s1 + 3, 84, 87, 0, 2.5);
        for (let k = 1; k < leaves; k++) onWall(g('doorFrame'), w, s0 + k * 36 - 0.5, s0 + k * 36 + 0.5, 0, 84, 0, 1.6);
        onWall(g('exitSign'), w, f(c) - 6, f(c) + 6, 92, 100, 0, 3);
      });
    }
  }
}

/** THE COLUMNS (CAD): a triplet per band on every interior column line: two big round columns 38 ft
 * apart and a small one between, a red hose cabinet on the small one (CAD "FH"), knee braces from each
 * big column up to the truss chord (the 2025 photographs show them). */
function columns(v: Venue): void {
  for (const d of [4, 5]) {
    v.part(`col${d}`, (g) => {
      const r = f(d) / 2;
      cyl(g('column'), [0, 0, 0], [0, 0, H], r, 24, false);
      box(g('column'), [-r - 2, -r - 2, H - 8], [r + 2, r + 2, H]);
      for (const s of [-1, 1]) beam(g('column'), [0, s * r * 0.8, H - f(7)], [0, s * f(7), H - 6], 9, 9);
    });
  }
  v.part('colMid', (g) => {
    const r = f(L.MID_COLUMN_D_FT) / 2;
    cyl(g('column'), [0, 0, 0], [0, 0, H], r, 20, false);
    box(g('fireCab'), [-15, -r - 8, 36], [15, -r, 66]);
  });
  for (const x of L.COLUMN_X) {
    if (Math.abs(x - L.WALL_COLUMN_X[0]) < 1) continue; // B3's end line has no interior triplets (CAD)
    for (const band of [L.COLUMN_Y.dock, L.COLUMN_Y.concourse]) {
      const d = L.COLUMN_D_FT(x);
      for (const y of band) v.place(`col${d}`, f(x), f(y), 0, 0, 'column');
      v.place('colMid', f(x), f((band[0] + band[1]) / 2), 0, 0, 'column');
    }
  }
}

/** THE ROOF (ESTIMATED from photographs; layout.ts): a deep primary truss along y on every interior
 * column line, open-web joists along x every 10 ft between them and to the end walls, the deck on top,
 * spiral supply ducts along y in each bay with drop diffusers, high-bay pendants on a 30-ft grid. */
function roof(v: Venue): void {
  const y0 = f(L.WALLS.concourse);
  const y1 = f(L.WALLS.dock);
  const zb = H;
  const zt = H + f(L.PRIMARY_TRUSS.depthFt);
  const ch = f(L.PRIMARY_TRUSS.chordFt);
  v.part('primary', (g) => {
    const s = g('steel');
    box(s, [-ch / 2, y0, zb], [ch / 2, y1, zb + ch]);
    box(s, [-ch / 2, y0, zt - ch], [ch / 2, y1, zt]);
    const panel = f(L.PRIMARY_TRUSS.panelFt);
    const n = Math.round((y1 - y0) / panel);
    for (let i = 0; i <= n; i++) {
      const y = y0 + ((y1 - y0) * i) / n;
      beam(s, [0, y, zb + ch], [0, y, zt - ch], 9, 9);
      if (i < n) {
        const yn = y0 + ((y1 - y0) * (i + 1)) / n;
        if (i % 2) beam(s, [0, y, zb + ch], [0, yn, zt - ch], 8, 8);
        else beam(s, [0, y, zt - ch], [0, yn, zb + ch], 8, 8);
      }
    }
  });
  const primaries = L.COLUMN_X.filter((x) => Math.abs(x - L.WALL_COLUMN_X[0]) > 1);
  for (const x of primaries) v.place('primary', f(x), 0, 0, 0, 'roof');

  // joists between consecutive bearings (primaries and the two end walls)
  const bearings = [L.WALLS.b3End, ...primaries, L.WALLS.a3End].sort((a, b) => a - b);
  const jd = f(L.JOIST.depthFt);
  const jc = f(L.JOIST.chordFt);
  for (let b = 0; b + 1 < bearings.length; b++) {
    const span = bearings[b + 1] - bearings[b];
    if (span < 10) continue;
    const name = `joist${Math.round(span)}`;
    if (!v.parts.has(name)) {
      v.part(name, (g) => {
        const s = g('steel');
        const L2 = f(span) / 2 - ch / 2;
        box(s, [-L2, -jc / 2, zt - jd], [L2, jc / 2, zt - jd + jc]);
        box(s, [-L2, -jc / 2, zt - jc], [L2, jc / 2, zt]);
        const n = Math.max(2, Math.round(f(span) / 48));
        for (let i = 0; i < n; i++) {
          const xa = -L2 + ((2 * L2) * i) / n;
          const xb = -L2 + ((2 * L2) * (i + 1)) / n;
          if (i % 2) beam(s, [xa, 0, zt - jd + jc], [xb, 0, zt - jc], 2.5, 2.5, false);
          else beam(s, [xa, 0, zt - jc], [xb, 0, zt - jd + jc], 2.5, 2.5, false);
        }
      });
    }
    const xm = f((bearings[b] + bearings[b + 1]) / 2);
    for (let y = L.WALLS.concourse + 5; y < L.WALLS.dock - 2; y += L.JOIST.pitchFt) v.place(name, xm, f(y), 0, 0, 'roof');
  }
  // the deck, seen from below
  v.obj('deck', (g) => g('deck').poly([[f(L.WALLS.a3End), y0, zt], [f(L.WALLS.a3End), y1, zt], [f(L.WALLS.b3End), y1, zt], [f(L.WALLS.b3End), y0, zt]]));

  // spiral ducts along y, two per 90-ft bay, one per 60-ft bay, none in the 30-ft airwall bay
  v.part('ductRun', (g) => {
    const r = 21;
    const z = f(33.5);
    const ya = y0 + f(6);
    const yb = y1 - f(6);
    cyl(g('duct'), [0, ya, z], [0, yb, z], r, 18);
    for (let y = ya + f(10); y < yb; y += f(10)) cyl(g('duct'), [0, y - 1, z], [0, y + 1, z], r + 1.2, 18, false);
    for (let y = ya + f(15); y < yb - f(10); y += f(30)) {
      cyl(g('duct'), [0, y, z - r + 2], [0, y, f(31)], 8, 12, false);
      cyl(g('lampBody'), [0, y, f(31)], [0, y, f(31) - 4], 15, 16);
    }
    for (const yy of [ya, yb]) cyl(g('duct'), [0, yy, z], [0, yy, zt - jd], 8, 12, false);
  });
  const ductX: number[] = [];
  for (let b = 0; b + 1 < bearings.length; b++) {
    const span = bearings[b + 1] - bearings[b];
    if (span < 45) continue;
    if (span > 75) ductX.push(bearings[b] + span / 3, bearings[b] + (2 * span) / 3);
    else ductX.push(bearings[b] + span / 2);
  }
  for (const x of ductX) v.place('ductRun', f(x), 0, 0, 0, 'roof');

  // high-bay pendants: a 30-ft grid offset from the ducts, hanging from the joists to ~31.5 ft
  v.part('highBay', (g) => {
    const zb2 = f(31.5);
    cyl(g('lampBody'), [0, 0, zb2], [0, 0, zb2 + 14], 9, 14);
    cyl(g('lampBody'), [0, 0, zb2 + 14], [0, 0, zt - jd], 0.6, 6, false);
    disc(g('lamp'), [0, 0, zb2 - 0.1], [0, 0, -1], 8, 14);
  });
  for (let x = L.WALLS.a3End + 10; x < L.WALLS.b3End - 5; x += 30) {
    if (ductX.some((d) => Math.abs(d - x) < 6)) continue;
    for (let y = L.WALLS.concourse + 12; y < L.WALLS.dock - 5; y += 30) v.place('highBay', f(x), f(y), 0, 0, 'roof');
  }
}

// ── THE EVENT ──────────────────────────────────────────────────────────────────────────────────

/** a run of black pipe and drape, `h` inches, uprights every 10 ft */
function drapeRun(g: (m: string) => Geo, x0: number, y0: number, x1: number, y1: number, h: number, mat = 'drape'): void {
  drapeSheet(g(mat), x0, y0, x1, y1, 1, h - 2);
  cyl(g('rail'), [x0, y0, h - 1], [x1, y1, h - 1], 0.8, 6, false);
  const L2 = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.round(L2 / 120));
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const y = y0 + ((y1 - y0) * i) / n;
    cyl(g('rail'), [x, y, 0.5], [x, y, h], 0.8, 6, false);
    box(g('rail'), [x - 9, y - 9, 0], [x + 9, y + 9, 0.6]);
  }
}

/** the event's furniture and rigging as reusable parts */
function eventParts(v: Venue): void {
  // a skirted 8-ft table, 30 in high
  v.part('table8', (g) => {
    box(g('skirt'), [-48, -15, 0], [48, 15, 30]);
  });
  // a monitor on its foot, screen facing +y
  v.part('monitor', (g) => {
    box(g('black'), [-11, -1.5, 34], [11, 1.5, 47]);
    box(g('monitorLit'), [-10.4, 1.5, 34.6], [10.4, 1.7, 46.4]);
    box(g('black'), [-1.5, -3, 30], [1.5, 0, 34]);
    box(g('black'), [-5, -4, 30], [5, 3, 30.5]);
  });
  // a folding chair facing −y
  v.part('chair', (g) => {
    const c = g('chair');
    box(c, [-8, -8, 17], [8, 8, 18.5]);
    box(c, [-8, 7, 18.5], [8, 8.5, 33]);
    for (const [x, y] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) box(c, [x - 0.6, y - 0.6, 0], [x + 0.6, y + 0.6, 17]);
  });
  // the drive team's station table (26 in, coach orientation) and the HP tray stand (20 in)
  v.part('dsTable', (g) => {
    box(g('skirt'), [-L.DS_TABLE.depthIn / 2, -L.DS_TABLE.lengthIn / 2, 0], [L.DS_TABLE.depthIn / 2, L.DS_TABLE.lengthIn / 2, L.DS_TABLE.heightIn]);
  });
  v.part('hpTable', (g) => {
    const s = L.HP_TABLE.sideIn / 2;
    box(g('tableTop'), [-s, -s, L.HP_TABLE.heightIn - 0.8], [s, s, L.HP_TABLE.heightIn]);
    box(g('tableTop'), [-s, -s, 0], [s, s, 0.8]);
    for (const [x, y] of [[-s + 1, -s + 1], [s - 1, -s + 1], [-s + 1, s - 1], [s - 1, s - 1]]) cyl(g('black'), [x, y, 0.8], [x, y, L.HP_TABLE.heightIn - 0.8], 0.8, 6, false);
  });
  // a robot on a cart, the cart's handle toward −y
  v.part('cart', (g) => {
    box(g('cart'), [-15, -12, 6], [15, 12, 9]);
    for (const [x, y] of [[-12, -9], [12, -9], [-12, 9], [12, 9]]) cyl(g('black'), [x, y, 3], [x, y, 6], 2.5, 8);
    cyl(g('rail'), [-12, -12, 9], [-12, -12, 36], 0.6, 6, false);
    cyl(g('rail'), [12, -12, 9], [12, -12, 36], 0.6, 6, false);
    cyl(g('rail'), [-12, -12, 36], [12, -12, 36], 0.6, 6, false);
    box(g('robot'), [-9, -8, 9], [9, 10, 22]);
  });
  // a camera on a tripod, lens toward +y
  v.part('tripod', (g) => {
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      beam(g('black'), [Math.cos(a) * 16, Math.sin(a) * 16, 0], [0, 0, 52], 1.2, 1.2);
    }
    box(g('black'), [-4, -7, 52], [4, 7, 60]);
  });
  // 10 ft of 20.5-in box truss along x, centred, its bottom chords at z 0
  const t = L.LIGHT_TRUSS.sizeIn;
  const c = t / 2 - 1;
  v.part('truss10', (g) => {
    const m = g('truss');
    const len = 120;
    for (const [y, z] of [[-c, 1], [c, 1], [-c, t - 1], [c, t - 1]]) cyl(m, [-len / 2, y, z], [len / 2, y, z], 1, 8, false);
    const n = 6;
    for (let i = 0; i < n; i++) {
      const xa = -len / 2 + (len * i) / n;
      const xb = -len / 2 + (len * (i + 1)) / n;
      const flip = i % 2 ? 1 : -1;
      beam(m, [xa, -c, 1 + (flip > 0 ? 0 : t - 2)], [xb, -c, 1 + (flip > 0 ? t - 2 : 0)], 0.9, 0.9, false);
      beam(m, [xa, c, 1 + (flip > 0 ? 0 : t - 2)], [xb, c, 1 + (flip > 0 ? t - 2 : 0)], 0.9, 0.9, false);
      beam(m, [xa, -c * flip, 1], [xb, c * flip, 1], 0.9, 0.9, false);
      beam(m, [xa, -c * flip, t - 1], [xb, c * flip, t - 1], 0.9, 0.9, false);
    }
  });
  v.part('trussCorner', (g) => box(g('truss'), [-t / 2, -t / 2, 0], [t / 2, t / 2, t]));
  // A SEATED SPECTATOR, facing +y, sitting on z 0 (a bench top): body (shirt), head (skin) and legs
  // are three parts so the crowd needs one draw per shirt and per skin tone, not one per pairing
  SHIRTS.forEach((_, i) =>
    v.part(`body${i}`, (g) => {
      const m = g(`shirt${i}`);
      box(m, [-8, -6, 3], [8, 2.5, 24]);
      for (const sx of [-1, 1]) beam(m, [sx * 9.5, -2, 22], [sx * 8.5, 6, 9], 3, 3);
    }),
  );
  SKINS.forEach((_, i) =>
    v.part(`head${i}`, (g) => {
      cyl(g(`skin${i}`), [0, -2, 23.5], [0, -2, 27], 2.2, 8);
      // a head, its hair on the top and back (the hair band is the ellipsoid's upper 42 %)
      ellipsoid(g('hair'), g(`skin${i}`), [0, -1.6, 31], [3.6, 4.2, 4.6]);
    }),
  );
  v.part('legs', (g) => {
    const m = g('pants');
    box(m, [-7, -5, 0], [7, 13, 5]);
    box(m, [-6.5, 9, -16], [-0.8, 13.5, 0]);
    box(m, [0.8, 9, -16], [6.5, 13.5, 0]);
    box(g('black'), [-6.8, 8, -17.75], [-0.6, 16, -15.5]);
    box(g('black'), [0.6, 8, -17.75], [6.8, 16, -15.5]);
  });
  // a moving head hung under a truss (base at z 0), aimed 35° off vertical toward +y
  v.part('movingHead', (g) => {
    box(g('fixture'), [-8, -7, -6], [8, 7, 0]);
    box(g('fixture'), [-8, -1.5, -20], [-6.5, 1.5, -6]);
    box(g('fixture'), [6.5, -1.5, -20], [8, 1.5, -6]);
    const tilt = (35 * Math.PI) / 180;
    const a: V3 = [0, Math.sin(tilt) * -7, -17 + Math.cos(tilt) * 7];
    const b: V3 = [0, Math.sin(tilt) * 9, -17 - Math.cos(tilt) * 9];
    cyl(g('fixture'), a, b, 6, 14);
    disc(g('lens'), [b[0], b[1] + Math.sin(tilt) * 0.2, b[2] - Math.cos(tilt) * 0.2], [0, Math.sin(tilt), -Math.cos(tilt)], 5, 14);
  });
  // a chain hoist on a truss corner, its chain to the joists' bottom chord
  v.part('hoist', (g) => {
    box(g('fixture'), [-7, -7, t + 30], [7, 7, t + 50]);
    cyl(g('fixture'), [0, 0, t], [0, 0, t + 30], 0.6, 6, false);
    cyl(g('fixture'), [0, 0, t + 50], [0, 0, f(L.DECK_FT - L.JOIST.depthFt) - f(L.LIGHT_TRUSS.trimFt)], 0.6, 6, false);
  });
  // a 16 × 9 ft LED wall, its face toward −y, hung by two cables from z `trim`
  v.part('screen', (g) => {
    const w = f(L.SCREEN.wFt) / 2;
    const z0 = f(L.SCREEN.bottomFt);
    const z1 = z0 + f(L.SCREEN.hFt);
    box(g('black'), [-w - 3, 0, z0 - 3], [w + 3, 6, z1 + 3]);
    g('screen').poly([[-w, -0.2, z0], [w, -0.2, z0], [w, -0.2, z1], [-w, -0.2, z1]]);
    for (const s of [-1, 1]) cyl(g('fixture'), [s * (w - 12), 3, z1 + 3], [s * (w - 12), 3, f(L.LIGHT_TRUSS.trimFt)], 0.4, 4, false);
  });
  // a speaker box hung from a truss, tilted toward −y
  v.part('speaker', (g) => {
    box(g('fixture'), [-10, -8, -40], [10, 8, -2]);
    cyl(g('fixture'), [0, 0, -2], [0, 0, 0], 0.6, 6, false);
  });
}

/** one division (PLAN): the stand, rails, media, the lighting grid and screens, the back zone */
function division(v: Venue, d: L.Division): void {
  const s = d.facing; // +1: audience at −y
  const fy = d.fieldY;
  const fieldFront = fy - s * 6; // the audience-side edge of the fields
  const fieldBack = fy + s * 6;

  // the neighbours' drive team tables (ours are the sim's alliance areas: left empty by KEEP_CLEAR)
  for (const fx of d.fieldX) {
    for (const side of [-1, 1]) {
      // each field's own frame: +x audience right; for a top-row field that is −x in ours
      const xw = fx * FT + side * s * (70.7 + 1 + L.DS_TABLE.depthIn / 2);
      v.place('dsTable', xw, fy * FT, 0, 0, `${d.name} drive-team table`);
      v.place('hpTable', fx * FT + side * s * (70.7 + 44), fy * FT - s * 40, 0, 0, `${d.name} human-player stand`);
    }
  }

  // the back zone: scoring tables against the centre-aisle drape, chairs behind them, monitors
  const drapeY = s > 0 ? L.AISLE_DRAPE_Y.bottom : L.AISLE_DRAPE_Y.top;
  for (const fx of d.fieldX) {
    for (const dx of [-5, 5]) {
      const tx = f(fx + dx);
      const ty = f(drapeY) - s * 33;
      v.place('table8', tx, ty, 0, 0, `${d.name} scoring table`);
      v.place('monitor', tx - 20, ty, 0, s > 0 ? Math.PI : 0, `${d.name} scoring table`);
      v.place('monitor', tx + 20, ty, 0, s > 0 ? Math.PI : 0, `${d.name} scoring table`);
      v.place('chair', tx - 24, ty + s * 26, 0, s > 0 ? 0 : Math.PI, `${d.name} scoring table`);
      v.place('chair', tx + 24, ty + s * 26, 0, s > 0 ? 0 : Math.PI, `${d.name} scoring table`);
      // field staff on half the chairs, facing the field
      for (const cx of [tx - 24, tx + 24]) if (hash2(cx, ty) < 0.5) spectator(v, cx, ty + s * 28, 18.5, s > 0 ? Math.PI : 0, `${d.name} scoring table`);
    }
  }
  // the drape (PLAN blue line): along the centre aisle, back down both carpet ends, then out along the
  // queue lanes either side
  const sideY = fy + s * 5.1;
  v.obj(`${d.name} back drape`, (g) => drapeRun(g, f(d.back.x0), f(drapeY), f(d.back.x1), f(drapeY), f(L.DRAPE.backFt)));
  for (const xe of [d.back.x0, d.back.x1]) {
    v.obj(`${d.name} end drape`, (g) => drapeRun(g, f(xe), f(drapeY), f(xe), f(sideY), f(L.DRAPE.backFt)));
    const out = xe === d.back.x0 ? -1 : 1;
    v.obj(`${d.name} queue-lane drape`, (g) => drapeRun(g, f(xe), f(sideY), f(xe + out * 10), f(sideY), f(L.DRAPE.backFt)));
  }

  // THE LIGHTING GRID: a rectangle of box truss over the carpet, front beam ahead of the fields, back
  // beam over the scoring tables, corner blocks and hoists, moving heads on both long beams, a speaker
  // at each front corner, an LED wall per field on the back beam facing the audience
  const trim = f(L.LIGHT_TRUSS.trimFt);
  const xa = f(d.carpet.x0) - 12;
  const xb = f(d.carpet.x1) + 12;
  const yF = f(fieldFront - s * L.LIGHT_TRUSS.frontFt);
  const yB = f(drapeY) - s * 18;
  const span = (a: number, b: number) => {
    const n = Math.max(1, Math.round(Math.abs(b - a) / 120));
    return { n, step: (b - a) / n };
  };
  for (const [ya, yb2, xa2, xb2] of [[yF, yF, xa, xb], [yB, yB, xa, xb], [yF, yB, xa, xa], [yF, yB, xb, xb]] as const) {
    const alongX = ya === yb2;
    const { n, step } = alongX ? span(xa2, xb2) : span(ya, yb2);
    for (let i = 0; i < n; i++) {
      if (alongX) v.place('truss10', xa2 + step * (i + 0.5), ya, trim, 0, `${d.name} lighting truss`);
      else v.place('truss10', xa2, ya + step * (i + 0.5), trim, Math.PI / 2, `${d.name} lighting truss`);
    }
  }
  for (const [x, y] of [[xa, yF], [xb, yF], [xa, yB], [xb, yB]]) {
    v.place('trussCorner', x, y, trim, 0, `${d.name} lighting truss`);
    v.place('hoist', x, y, trim, 0, `${d.name} lighting truss`);
  }
  const heads = Math.max(3, Math.round((xb - xa) / f(8)));
  for (let i = 0; i < heads; i++) {
    const x = xa + ((xb - xa) * (i + 0.5)) / heads;
    // a head on the front beam aims back at the fields, one on the back beam aims forward
    v.place('movingHead', x, yF, trim, s > 0 ? 0 : Math.PI, `${d.name} lighting truss`);
    v.place('movingHead', x, yB, trim, s > 0 ? Math.PI : 0, `${d.name} lighting truss`);
  }
  for (const x of [xa + 30, xb - 30]) v.place('speaker', x, yF - s * 14, trim, s > 0 ? 0 : Math.PI, `${d.name} speaker`);
  for (const fx of d.fieldX) v.place('screen', f(fx), yB - s * 16, 0, s > 0 ? 0 : Math.PI, `${d.name} LED wall`);

  stand(v, d);
}

/** THE GRANDSTAND (footprint PLAN; rows and rise ESTIMATED): a cross-aisle at floor level, then `rows`
 * stepped rows, aluminium benches in three sections between two stair aisles, rails on the aisles,
 * the sides and the back, the accessible platform in front with its rail, and the team-media tripods. */
function stand(v: Venue, d: L.Division): void {
  const S = L.STAND;
  const s = d.facing;
  const frontY = s > 0 ? d.stand.y1 : d.stand.y0;
  const Y = (depthFt: number) => f(frontY) - s * f(depthFt); // depth from the front → field y (inches)
  const u0 = f(d.stand.x0);
  const u1 = f(d.stand.x1);
  const rd = S.rowDepthIn / FT;
  const rowV = (i: number) => S.frontAisleFt + i * rd;
  const rowZ = (i: number) => (i + 1) * S.riseIn;
  const aisleU = [1 / 3, 2 / 3].map((t) => u0 + (u1 - u0) * t);
  const aw = f(S.aisleFt) / 2;
  const label = `${d.name} stand`;
  v.obj(label, (g) => {
    const deck = g('standDeck');
    const frame = g('standFrame');
    for (let i = 0; i < S.rows; i++) {
      const va = Y(rowV(i));
      const vb = Y(rowV(i + 1));
      const z = rowZ(i);
      const zPrev = i ? rowZ(i - 1) : 0;
      const [ya, yb] = [Math.min(va, vb), Math.max(va, vb)];
      // tread and riser, both full width (the aisles add their half-steps over them)
      deck.poly([[u0, ya, z], [u1, ya, z], [u1, yb, z], [u0, yb, z]]);
      // the riser faces the field: +y for the bottom row, −y for the top
      const riserY = va;
      deck.poly(s > 0 ? [[u1, riserY, zPrev], [u0, riserY, zPrev], [u0, riserY, z], [u1, riserY, z]] : [[u0, riserY, zPrev], [u1, riserY, zPrev], [u1, riserY, z], [u0, riserY, z]]);
      // the side panels, one rectangle per step, facing out (−x at u0, +x at u1)
      frame.poly([[u0, ya, 0], [u0, yb, 0], [u0, yb, z], [u0, ya, z]], true);
      frame.poly([[u1, ya, 0], [u1, ya, z], [u1, yb, z], [u1, yb, 0]], true);
    }
    // the back faces away from the field
    const vEnd = Y(rowV(S.rows));
    const zTop = rowZ(S.rows - 1);
    frame.poly(s > 0 ? [[u0, vEnd, 0], [u1, vEnd, 0], [u1, vEnd, zTop], [u0, vEnd, zTop]] : [[u1, vEnd, 0], [u0, vEnd, 0], [u0, vEnd, zTop], [u1, vEnd, zTop]]);
    // the side frames' diagonal bracing, visible from the floor
    for (const u of [u0 - 0.5, u1 + 0.5]) {
      for (let i = 0; i + 4 <= S.rows; i += 4) {
        const za = rowZ(i) * 0.15;
        beam(frame, [u, Y(rowV(i)), za], [u, Y(rowV(i + 4)), rowZ(i + 3) - 6], 2, 2);
      }
    }
    // benches, in three sections between the aisles
    const sections: [number, number][] = [[u0 + 6, aisleU[0] - aw], [aisleU[0] + aw, aisleU[1] - aw], [aisleU[1] + aw, u1 - 6]];
    // the bench at the back of each row, the front of the row free for the feet
    for (let i = 0; i < S.rows; i++) {
      const vb0 = Y(rowV(i) + BENCH_FT[0]);
      const vb1 = Y(rowV(i) + BENCH_FT[1]);
      const z = rowZ(i);
      for (const [a, b] of sections) {
        box(g('bench'), [a, Math.min(vb0, vb1), z + 16], [b, Math.max(vb0, vb1), z + 17.75]);
        for (let u = a + 18; u < b; u += 72) box(g('standFrame'), [u - 1, Math.min(vb0, vb1) + 2, z], [u + 1, Math.max(vb0, vb1) - 2, z + 16]);
      }
    }
    // the aisles: a half step in every row, and a centre handrail on posts
    for (const ua of aisleU) {
      for (let i = 0; i < S.rows; i++) {
        const vm = Y(rowV(i) + rd / 2);
        const ve = Y(rowV(i + 1));
        box(g('aisle'), [ua - aw, Math.min(vm, ve), rowZ(i)], [ua + aw, Math.max(vm, ve), rowZ(i) + S.riseIn / 2]);
      }
      cyl(g('rail'), [ua, Y(rowV(0)), rowZ(0) + 34], [ua, Y(rowV(S.rows) - 1), rowZ(S.rows - 1) + 34], 0.9, 8, false);
      for (let i = 0; i < S.rows; i += 3) cyl(g('rail'), [ua, Y(rowV(i) + 1), rowZ(i)], [ua, Y(rowV(i) + 1), rowZ(i) + 34 + i * 0.5], 0.9, 6, false);
    }
    // back rail and the two raked side rails
    const yBack = Y(rowV(S.rows) - 0.3);
    for (const zz of [S.railIn, S.railIn / 2]) cyl(g('rail'), [u0, yBack, zTop + zz], [u1, yBack, zTop + zz], 0.9, 8, false);
    for (let u = u0; u <= u1 + 1; u += f(8)) cyl(g('rail'), [Math.min(u, u1), yBack, zTop], [Math.min(u, u1), yBack, zTop + S.railIn], 0.9, 6, false);
    for (const u of [u0 + 2, u1 - 2]) {
      cyl(g('rail'), [u, Y(rowV(0)), rowZ(0) + S.railIn], [u, Y(rowV(S.rows) - 0.3), zTop + S.railIn], 0.9, 8, false);
      for (let i = 0; i < S.rows; i += 4) cyl(g('rail'), [u, Y(rowV(i) + 0.3), rowZ(i)], [u, Y(rowV(i) + 0.3), rowZ(i) + S.railIn], 0.9, 6, false);
    }
    // a front rail along row one, open at the aisles
    for (const [a, b] of sections) cyl(g('rail'), [a, Y(rowV(0)) + s * 2, 36], [b, Y(rowV(0)) + s * 2, 36], 0.9, 8, false);
  });
  // the crowd: a seat every 20 in along each bench, filled where a seeded hash says so
  const seatSections: [number, number][] = [[u0 + 6, aisleU[0] - aw], [aisleU[0] + aw, aisleU[1] - aw], [aisleU[1] + aw, u1 - 6]];
  for (let i = 0; i < S.rows; i++) {
    const y = Y(rowV(i) + (BENCH_FT[0] + BENCH_FT[1]) / 2) + s * 1;
    for (const [a, b] of seatSections) {
      const n = Math.floor((b - a) / 20);
      for (let k = 0; k < n; k++) {
        const x = a + 10 + k * 20 + (hash2(k, i * 31 + a) - 0.5) * 4;
        if (hash2(x, y) < CROWD_SHARE) spectator(v, x, y, rowZ(i) + 17.75, s > 0 ? 0 : Math.PI, `${d.name} crowd`);
      }
    }
  }
  // the accessible platform's rail (open toward the stand) and its chairs
  const A = d.access;
  const aFront = s > 0 ? A.y1 : A.y0;
  v.obj(`${d.name} accessible seating`, (g) => {
    const r = g('rail');
    const pts: V3[] = [[f(A.x0), f(s > 0 ? A.y0 : A.y1), 36], [f(A.x0), f(aFront), 36], [f(A.x1), f(aFront), 36], [f(A.x1), f(s > 0 ? A.y0 : A.y1), 36]];
    for (let i = 0; i + 1 < pts.length; i++) cyl(r, pts[i], pts[i + 1], 0.9, 8, false);
    for (const p of pts) cyl(r, [p[0], p[1], 0], p, 0.9, 6, false);
  });
  for (let k = 0; k < 4; k++) v.place('chair', f(A.x0 + 3 + ((A.x1 - A.x0 - 6) * k) / 3), f(aFront) - s * 30, 0, s > 0 ? Math.PI : 0, `${d.name} accessible seating`);
  for (const m of d.media) {
    for (const t of [0.3, 0.7]) v.place('tripod', f(m.x0 + (m.x1 - m.x0) * t), f((m.y0 + m.y1) / 2), 0, s > 0 ? 0 : Math.PI, `${d.name} team media`);
  }
}

/** THE PITS (PLAN, measured cell by cell): 10-ft cells back to back in strips, an 8-ft back drape and
 * 3-ft sides in the division's colour, a 6-ft table at the back, and on some a team banner, a toolbox
 * or a robot on its cart. Variety is a seeded hash of the cell, so a rebuild is the same hall. */
function pits(v: Venue): void {
  v.part('pitTable', (g) => {
    box(g('tableTop'), [-36, -15, 28.5], [36, 15, 30]);
    for (const [x, y] of [[-33, -12], [33, -12], [-33, 12], [33, 12]]) cyl(g('tableLeg'), [x, y, 0], [x, y, 28.5], 0.8, 6, false);
  });
  v.part('toolbox', (g) => box(g('toolbox'), [-10, -6, 30], [10, 6, 41]));
  const hash = (x: number, y: number) => {
    let h = Math.imul(Math.round(x * 10) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(y * 10), 0xc2b2ae35);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  };
  for (const [name, cells] of Object.entries(PIT_CELLS) as [L.DivisionName, readonly (readonly [number, number])[]][]) {
    const key = (x: number, y: number) => `${Math.round(x / 2.5)}:${Math.round(y / 2.5)}`;
    const has = new Set(cells.map(([x, y]) => key(x, y)));
    const at = (x: number, y: number) => has.has(key(x, y));
    for (const [cx, cy] of cells) {
      // the cell opens away from its back-to-back partner; a lone cell opens toward −x
      const opens = at(cx - 10, cy) && !at(cx + 10, cy) ? 1 : -1;
      const back = cx - opens * 5;
      const frontX = cx + opens * 5;
      const mat = `pit:${name}`;
      v.obj(`${name} pits`, (g) => {
        if (opens < 0 || !at(cx - 10, cy)) drapeRun(g, f(back), f(cy - 5), f(back), f(cy + 5), f(L.DRAPE.pitBackFt), mat);
        drapeRun(g, f(back), f(cy - 5), f(frontX), f(cy - 5), f(L.DRAPE.pitSideFt), mat);
        if (!at(cx, cy + 10)) drapeRun(g, f(back), f(cy + 5), f(frontX), f(cy + 5), f(L.DRAPE.pitSideFt), mat);
        const h = hash(cx, cy);
        if (h < 0.45) {
          const bx = f(back) + opens * 1.5;
          const banner = `banner${Math.floor(h * 100) % 8}`;
          g(banner).poly([[bx, f(cy) - 34, 62], [bx, f(cy) + 34, 62], [bx, f(cy) + 34, 92], [bx, f(cy) - 34, 92]]);
        }
      });
      v.place('pitTable', f(back) + opens * 17, f(cy), 0, Math.PI / 2, `${name} pits`);
      const h2 = hash(cy, cx);
      if (h2 < 0.5) v.place('toolbox', f(back) + opens * 17, f(cy) + (h2 < 0.25 ? -18 : 18), 0, Math.PI / 2, `${name} pits`);
      if (h2 > 0.35 && h2 < 0.75) v.place('cart', f(cx) + opens * 10, f(cy) + 12, 0, opens > 0 ? Math.PI / 2 : -Math.PI / 2, `${name} pits`);
    }
  }
}

/** THE PRACTICE FIELDS (PLAN): 14 at A3's west wall, 1–6 on 24-in risers. Plain fields — a mat and a
 * 12-in perimeter — because they stand 400 ft from the play, behind the pits. */
function practiceFields(v: Venue): void {
  const half = 70.7;
  for (const r of [0, 1]) {
    const z0 = r ? L.RISER_IN : 0;
    v.part(`practice${r}`, (g) => {
      if (r) box(g('riser'), [-half - 4, -half - 4, 0], [half + 4, half + 4, z0]);
      box(g('practiceMat'), [-half, -half, z0], [half, half, z0 + 0.6]);
      for (const [a, b] of [[[-half, -half], [half, -half]], [[half, -half], [half, half]], [[half, half], [-half, half]], [[-half, half], [-half, -half]]] as const) {
        const A: V3 = [a[0], a[1], z0];
        const B: V3 = [b[0], b[1], z0];
        g('polycarb').poly([A, B, [B[0], B[1], z0 + 12], [A[0], A[1], z0 + 12]]);
        beam(g('extrusion'), [A[0], A[1], z0 + 11], [B[0], B[1], z0 + 11], 1.5, 1.5);
        beam(g('extrusion'), [A[0], A[1], z0 + 0.75], [B[0], B[1], z0 + 0.75], 1.5, 1.5);
        cyl(g('extrusion'), [A[0], A[1], z0], [A[0], A[1], z0 + 12], 1, 6, false);
      }
    });
  }
  for (const pf of L.PRACTICE_FIELDS) v.place(`practice${pf.riser ? 1 : 0}`, f(pf.at[0]), f(pf.at[1]), 0, 0, 'practice field');
}

/** the drape-walled enclosures on the A3 side of the open airwall (PLAN), with their tables */
function enclosures(v: Venue): void {
  for (const e of L.ENCLOSURES) {
    const r = e.at;
    v.obj(e.name, (g) => {
      drapeRun(g, f(r.x0), f(r.y0), f(r.x1), f(r.y0), f(L.DRAPE.backFt));
      drapeRun(g, f(r.x1), f(r.y0), f(r.x1), f(r.y1), f(L.DRAPE.backFt));
      drapeRun(g, f(r.x1), f(r.y1), f(r.x0), f(r.y1), f(L.DRAPE.backFt));
      drapeRun(g, f(r.x0), f(r.y1), f(r.x0), f(r.y0) + f(8), f(L.DRAPE.backFt));
    });
    for (let k = 0; k < e.tables; k++) {
      const x = f(r.x0 + 6 + ((r.x1 - r.x0 - 12) * (k + 0.5)) / Math.max(1, e.tables));
      v.place('table8', x, f(r.y1) - 40, 0, 0, e.name);
      v.place('monitor', x, f(r.y1) - 40, 0, Math.PI, e.name);
    }
  }
  for (const r of L.STORAGE) {
    v.obj('storage', (g) => {
      drapeRun(g, f(r.x0), f(r.y0), f(r.x1), f(r.y0), f(L.DRAPE.backFt));
      drapeRun(g, f(r.x1), f(r.y0), f(r.x1), f(r.y1), f(L.DRAPE.backFt));
      drapeRun(g, f(r.x1), f(r.y1), f(r.x0), f(r.y1), f(L.DRAPE.backFt));
      drapeRun(g, f(r.x0), f(r.y1), f(r.x0), f(r.y0), f(L.DRAPE.backFt));
    });
  }
  for (const [x, y] of L.QUEUE_CARTS) v.place('cart', f(x), f(y), 0, 0, 'queue cart');
}

/** every neighbouring field: (x, y) inches and a turn */
export function neighbourFields(): { x: number; y: number; rot: number; label: string }[] {
  const out: { x: number; y: number; rot: number; label: string }[] = [];
  for (const d of L.DIVISIONS) {
    d.fieldX.forEach((fx, i) => {
      if (d.name === 'franklin' && i === 0) return; // ours: the sim draws it
      out.push({ x: f(fx), y: f(d.fieldY), rot: d.facing > 0 ? 0 : Math.PI, label: `${d.name} field ${i + 1}` });
    });
  }
  return out;
}

export function buildVenue(): Venue {
  const v = new Venue();
  floor(v);
  walls(v);
  columns(v);
  roof(v);
  eventParts(v);
  for (const d of L.DIVISIONS) division(v, d);
  pits(v);
  practiceFields(v);
  enclosures(v);
  return v;
}

// ── GLTF ───────────────────────────────────────────────────────────────────────────────────────

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hexLinear = (h: number): [number, number, number] => [srgbToLinear(((h >> 16) & 255) / 255), srgbToLinear(((h >> 8) & 255) / 255), srgbToLinear((h & 255) / 255)];

export interface GenTools {
  core: any;
  ext: any;
  fns: any;
  io: any;
  sharp: any;
}

/**
 * THE SOURCE DOCUMENT: glTF, metres, y up (x = field x, y = up, z = −field y), so `build.ts` places it
 * with `fieldAt` (0, 0), `floor` 0, `yawDeg` 0 and scale 1. The neighbouring fields are the repo's own
 * `public/models/biobuzz/field-low.glb` (the CAD field the sim draws), one copy per field, raised
 * 0.75 in so their mats stand where ours does over the venue floor.
 */
export async function generateGrb(t: GenTools, repo: string): Promise<{ doc: any; notes: string[] }> {
  const v = buildVenue();
  const { core, ext } = t;
  const doc = new core.Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('grb');
  doc.getRoot().setDefaultScene(scene);
  const strength = doc.createExtension(ext.KHRMaterialsEmissiveStrength);
  const texImages = await makeTextures(t.sharp);
  const textures = new Map<TexName, any>();
  const materials = new Map<string, any>();
  const k = M_PER_IN;

  const material = (name: string): any => {
    const got = materials.get(name);
    if (got) return got;
    const s = MATS[name];
    const m = doc.createMaterial(name).setBaseColorFactor([...hexLinear(s.color), s.alpha ?? 1]).setMetallicFactor(s.metal ?? 0).setRoughnessFactor(s.rough ?? 0.8);
    if (s.alpha !== undefined) m.setAlphaMode('BLEND');
    if (s.double) m.setDoubleSided(true);
    if (s.emissive !== undefined) {
      m.setEmissiveFactor(hexLinear(s.emissive));
      if ((s.strength ?? 1) !== 1) m.setExtension('KHR_materials_emissive_strength', strength.createEmissiveStrength().setEmissiveStrength(s.strength));
    }
    if (s.tex) {
      let tex = textures.get(s.tex);
      if (!tex) {
        tex = doc.createTexture(s.tex).setImage(texImages[s.tex]).setMimeType('image/png');
        textures.set(s.tex, tex);
      }
      m.setBaseColorTexture(tex);
    }
    materials.set(name, m);
    return m;
  };

  const prim = (g: Geo, matName: string): any => {
    const n = g.pos.length / 3;
    const P = new Float32Array(n * 3);
    const N = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      P[i * 3] = g.pos[i * 3] * k;
      P[i * 3 + 1] = g.pos[i * 3 + 2] * k;
      P[i * 3 + 2] = -g.pos[i * 3 + 1] * k;
      N[i * 3] = g.nrm[i * 3];
      N[i * 3 + 1] = g.nrm[i * 3 + 2];
      N[i * 3 + 2] = -g.nrm[i * 3 + 1];
    }
    const p = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(P).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(N).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(g.idx)).setBuffer(buffer))
      .setMaterial(material(matName));
    if (MATS[matName].tex) {
      const origin = (g as Geo & { origin?: [number, number] }).origin ?? [0, 0];
      const tile = TEX_TILE_IN[MATS[matName].tex!];
      const UV = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        // the box projection's u/v, rebased on the material's own origin (the concrete's pocket grid)
        const ax = Math.abs(g.nrm[i * 3]), ay = Math.abs(g.nrm[i * 3 + 1]), az = Math.abs(g.nrm[i * 3 + 2]);
        const flat = az >= ax && az >= ay;
        UV[i * 2] = flat ? (g.pos[i * 3] - origin[0]) / tile : g.uv[i * 2];
        UV[i * 2 + 1] = flat ? (g.pos[i * 3 + 1] - origin[1]) / tile : g.uv[i * 2 + 1];
      }
      p.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(UV).setBuffer(buffer));
    }
    return p;
  };

  let tris = 0;
  for (const [mat, g] of v.batches) {
    if (!g.tris) continue;
    tris += g.tris;
    scene.addChild(doc.createNode(`static:${mat}`).setMesh(doc.createMesh(`static:${mat}`).addPrimitive(prim(g, mat))));
  }
  const partMesh = new Map<string, any>();
  for (const [name, part] of v.parts) {
    const mesh = doc.createMesh(`part:${name}`);
    for (const [mat, g] of part) if (g.tris) mesh.addPrimitive(prim(g, mat));
    partMesh.set(name, mesh);
  }
  const yRot = (rot: number): [number, number, number, number] => [0, Math.sin(rot / 2), 0, Math.cos(rot / 2)];
  v.placements.forEach((pl, i) => {
    const part = v.parts.get(pl.part)!;
    for (const g of part.values()) tris += g.tris;
    scene.addChild(
      doc
        .createNode(`${pl.part}#${i}`)
        .setMesh(partMesh.get(pl.part))
        .setTranslation([pl.x * k, pl.z * k, -pl.y * k])
        .setRotation(yRot(pl.rot)),
    );
  });

  // the neighbouring fields: the CAD field's low-detail file, copied in once, placed per field
  const src = await t.io.read(join(repo, 'public', 'models', 'biobuzz', 'field-low.glb'));
  await src.transform(t.fns.dequantize());
  const srcMeshNodes = src.getRoot().listNodes().filter((n: any) => n.getMesh());
  const map = t.fns.copyToDocument(doc, src, src.getRoot().listMeshes());
  for (const a of doc.getRoot().listAccessors()) a.setBuffer(buffer);
  for (const b of doc.getRoot().listBuffers()) if (b !== buffer) b.dispose();
  for (const e of doc.getRoot().listExtensionsUsed()) if (e.extensionName !== 'KHR_materials_emissive_strength') e.dispose();
  for (const srcMesh of src.getRoot().listMeshes()) {
    for (const p of map.get(srcMesh).listPrimitives()) {
      const m = p.getMaterial();
      if (!m || m.getName().startsWith('field:')) continue;
      // the CAD's tile grey (0.22) is the mat's flat stand-in; the sim paints its own field's tiles
      // charcoal, so the neighbours' mats take that charcoal rather than shining beside ours
      if (/^tile#/.test(m.getName())) m.setBaseColorFactor([0.045, 0.045, 0.047, 1]).setRoughnessFactor(0.9);
      m.setName(`field:${m.getName()}`).setDoubleSided(true);
    }
  }
  let fieldTris = 0;
  for (const srcNode of srcMeshNodes) for (const p of srcNode.getMesh().listPrimitives()) fieldTris += (p.getIndices()?.getCount() ?? 0) / 3;
  const fields = neighbourFields();
  for (const nf of fields) {
    const place = doc.createNode(nf.label).setTranslation([nf.x * k, 0.75 * k, -nf.y * k]).setRotation(yRot(nf.rot));
    const zup = doc.createNode(`${nf.label}:z-up`).setRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]).setScale([k, k, k]);
    place.addChild(zup);
    for (const srcNode of srcMeshNodes) zup.addChild(doc.createNode(srcNode.getName()).setMatrix(srcNode.getWorldMatrix()).setMesh(map.get(srcNode.getMesh())));
    scene.addChild(place);
    tris += fieldTris;
  }

  const notes = [
    `generated: ${tris} triangles (${fields.length} neighbouring fields at ${fieldTris} each), ${v.batches.size} merged materials, ${v.parts.size} parts in ${v.placements.length} placements`,
    ...[...v.dropped].map(([label, n]) => `left out (inside KEEP_CLEAR): ${label} ×${n}`),
  ];
  return { doc, notes };
}

/** the entry `build.ts` calls for a source with a `generator` */
export const generate = generateGrb;
/** what the build's clear box must contain, for a generated source (inches, field frame) */
export const keepClear = KEEP_CLEAR;
