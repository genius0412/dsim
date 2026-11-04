/**
 * THE GRB VENUE'S BAKED LIGHT (2026-11-04, second pass): the event lighting the photographs show, as a
 * per-vertex and per-instance colour the build bakes into the venue's own geometry. The sim lights
 * every surface with one rig (a key light, a hemisphere, the dome), the field included; a real
 * championship hall is a DIM HOUSE with white light pooled on each division from its truss. A colour
 * multiplied into the venue's albedo is what makes the house dim where the truss light does not reach
 * while leaving the field, which is not in this file, exactly as lit as before. No light is added at
 * runtime and nothing here touches a robot.
 *
 *   house     the competition half (B3) at a fraction of its albedo; the pit half (A3) under work light
 *   pool      each division's carpet and drive areas at full, falling off over `POOL_FT`
 *   spill     the near rows of each stand catch the front truss's spill, over `SPILL_FT`
 *   height    the pool is aimed down: it weakens with height above the floor
 *   roof      over B3 the roof steel sits in the blue uplight wash (`generate.ts`'s `*Wash` materials
 *             carry the wash itself; this tints and dims the structure under it)
 */
import * as L from './layout';

const FT = 12;
/** the competition half's house level, the pit half's, and the line between them (the airwall) */
const HOUSE_B3 = 0.26;
const HOUSE_A3 = 0.8;
const AIRWALL_IN = L.AIRWALL_X * FT;
const POOL_FT = 26;
const SPILL_FT = 70;

const smooth = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/** 1 inside a rectangle (inches) grown by `grow`, falling to 0 over `fall` */
function near(r: L.Rect, grow: number, fall: number, x: number, y: number): number {
  const dx = Math.max(r.x0 * FT - grow - x, 0, x - r.x1 * FT - grow);
  const dy = Math.max(r.y0 * FT - grow - y, 0, y - r.y1 * FT - grow);
  return 1 - smooth(Math.hypot(dx, dy) / fall);
}

/** the house level at x: B3's dim house, A3's work light, blended across the airwall bay */
export function houseAt(x: number): number {
  return HOUSE_B3 + (HOUSE_A3 - HOUSE_B3) * smooth((AIRWALL_IN - x) / (30 * FT));
}

/** the baked light at a point (inches, field frame): an RGB multiplier for the albedo */
export function bakedLight(x: number, y: number, z: number): [number, number, number] {
  const house = houseAt(x);
  if (z > (L.CEILING_FT - 2) * FT) {
    // the roof: in B3 a blue-tinted dim (the wash itself is emissive on the `*Wash` materials)
    const b3 = 1 - smooth((AIRWALL_IN - x) / (30 * FT));
    const v = house + 0.15;
    return [v * (1 - 0.35 * b3), v * (1 - 0.2 * b3), v];
  }
  let pool = 0;
  let spill = 0;
  for (const d of L.DIVISIONS) {
    pool = Math.max(pool, near(d.carpet, 4 * FT, POOL_FT * FT, x, y));
    spill = Math.max(spill, near(d.carpet, 4 * FT, SPILL_FT * FT, x, y));
  }
  const h = smooth(z / (18 * FT));
  const lit = house + (1 - house) * pool * (1 - 0.55 * h) + 0.32 * spill * (1 - pool);
  const v = Math.min(1, lit);
  return [v, v, v * 1.02];
}
