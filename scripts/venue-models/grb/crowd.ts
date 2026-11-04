/**
 * THE CROWD (2026-11-04, second pass): seated spectators as rounded figures, four poses (at rest,
 * leaning forward on the knees, one arm up, a phone held up), two levels of detail chosen by
 * distance from our field (the bottom row's stands and staff near; the top row's far), varied heights
 * and clothing. Every figure is four GPU-instanced parts (shirt, skin, trousers and shoes, hair) whose
 * instance colour is the garment's colour times the baked light at its seat (`light.ts`), so the
 * whole crowd is 32 draws however many people sit in it.
 */
import { Geo, cyl, ellipsoid, type V3 } from './mesh';

/** the four instanced materials: white, so the instance colour IS the garment's colour */
export const CROWD_SLOTS = ['shirt', 'skin', 'pants', 'hair'] as const;
export type CrowdSlot = (typeof CROWD_SLOTS)[number];
export const POSES = ['rest', 'lean', 'cheer', 'phone'] as const;
export type Pose = (typeof POSES)[number];
export type Lod = 'near' | 'far';

/** garment colours (sRGB): team shirts, desaturated so no stand outshines the field */
export const SHIRT_COLORS = [0x2c3a56, 0x70352f, 0x222326, 0x5f6368, 0x2c5759, 0x84733a, 0x96979a, 0x395b3a, 0x5a2f55, 0x8a5a2b, 0x1f3a6b, 0xa3a29c];
export const SKIN_COLORS = [0x8d5a3c, 0xb98a68, 0x5e3c2a, 0xcfa585, 0xa67552];
export const PANTS_COLORS = [0x2f3a4f, 0x1f2023, 0x6f6652, 0x4f5257];
export const HAIR_COLORS = [0x1a1714, 0x3a281c, 0x5a3e28, 0x8f7550];

interface Rig {
  torso: V3;
  shoulder: V3;
  neck: [V3, V3];
  head: V3;
  arms: [V3, V3, V3, V3]; // left elbow, left hand, right elbow, right hand
  phone?: boolean;
}

const BASE: Rig = {
  torso: [0, -2.2, 14.5],
  shoulder: [7.4, -1.8, 21.5],
  neck: [[0, -2, 23.5], [0, -1.8, 26.5]],
  head: [0, -1.6, 30.6],
  arms: [[-8.8, 2.5, 11], [-5.8, 10, 6.8], [8.8, 2.5, 11], [5.8, 10, 6.8]],
};
const RIGS: Record<Pose, Rig> = {
  rest: BASE,
  lean: {
    torso: [0, 0.6, 13.6],
    shoulder: [7.2, 1.2, 20.4],
    neck: [[0, 1, 22.4], [0, 2, 25.4]],
    head: [0, 2.6, 29.4],
    arms: [[-7, 8.5, 8.8], [-2.6, 11.5, 13.2], [7, 8.5, 8.8], [2.6, 11.5, 13.2]],
  },
  cheer: { ...BASE, arms: [[-8.8, 2.5, 11], [-5.8, 10, 6.8], [9.6, -0.6, 29.5], [8.8, 0.6, 39]] },
  phone: { ...BASE, arms: [[-7.6, 5, 12.5], [-2.2, 9.6, 20.5], [7.6, 5, 12.5], [2.2, 9.6, 20.5]], phone: true },
};

/** one figure's four slot geometries, seated on a bench top at z 0, facing +y */
export function figure(pose: Pose, lod: Lod): Record<CrowdSlot, Geo> {
  const g: Record<CrowdSlot, Geo> = { shirt: new Geo(), skin: new Geo(), pants: new Geo(), hair: new Geo() };
  const r = RIGS[pose];
  const near = lod === 'near';
  const cs = near ? 8 : 5;
  const es = near ? 10 : 7;
  const er = near ? 6 : 4;
  // trousers: thighs from the hips forward to the knees, shins down to the floor of the row
  for (const sx of [-1, 1]) {
    const hip: V3 = [sx * 4, -1.5, 3.4];
    const knee: V3 = [sx * 4.6, 13, 4.4];
    const ankle: V3 = [sx * 4.4, 14.4, -14.6];
    cyl(g.pants, hip, knee, 3.1, cs, false);
    cyl(g.pants, knee, ankle, 2.3, cs, false);
    if (near) ellipsoid(g.pants, g.pants, [sx * 4.4, 16.4, -16], [2, 3.6, 1.6], 6, 3);
  }
  // the torso: one rounded body, the shoulders' width at the top
  ellipsoid(g.shirt, g.shirt, r.torso, [7, 4.6, 10.6], es, er);
  // arms: a sleeve from the shoulder to the elbow, a bare forearm, a hand
  const [le, lh, re, rh] = r.arms;
  for (const [sx, elbow, hand] of [[-1, le, lh], [1, re, rh]] as const) {
    const sh: V3 = [sx * r.shoulder[0], r.shoulder[1], r.shoulder[2]];
    cyl(g.shirt, sh, elbow, 2, cs, false);
    cyl(g.skin, elbow, hand, 1.5, cs, false);
    if (near) ellipsoid(g.skin, g.skin, hand, [1.4, 1.6, 1.8], 6, 3);
  }
  if (r.phone && near) ellipsoid(g.hair, g.hair, [0, 10.4, 21.5], [3, 0.6, 1.8], 4, 2);
  cyl(g.skin, r.neck[0], r.neck[1], 2.1, cs, false);
  // the head, its hair over the crown and down the back
  ellipsoid(g.hair, g.skin, r.head, [3.5, 4.1, 4.5], es, er);
  return g;
}

/** a seeded hash in [0, 1) */
export function hash3(x: number, y: number, k: number): number {
  let h = Math.imul(Math.round(x * 10) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(y * 10) + k * 7919, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** a seated figure's parts and colours at (x, y): which pose, how tall, what it wears */
export function dress(x: number, y: number): { pose: Pose; scale: number; colors: Record<CrowdSlot, number> } {
  const pick = <T>(a: readonly T[], k: number): T => a[Math.floor(hash3(x, y, k) * a.length) % a.length];
  const p = hash3(x, y, 1);
  const pose: Pose = p < 0.55 ? 'rest' : p < 0.8 ? 'lean' : p < 0.92 ? 'phone' : 'cheer';
  return {
    pose,
    // teenagers to adults: 0.86 to 1.06 of the modelled figure
    scale: 0.86 + 0.2 * hash3(x, y, 2),
    colors: { shirt: pick(SHIRT_COLORS, 3), skin: pick(SKIN_COLORS, 4), pants: pick(PANTS_COLORS, 5), hair: pick(HAIR_COLORS, 6) },
  };
}
