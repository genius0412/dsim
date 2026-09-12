import type { Alliance, Vec2 } from '../../types';
import { BB_CELL_OPEN, BB_HIVE_BOTTOM_Z, BB_HIVE_CELL_DY, BB_HIVE_OPEN_Z, BB_HIVE_X } from './config';
import type { Vec3 } from './state';
import type { BbElementKind } from './flower';

/**
 * HIVE logic — capture, load, the TIP, the spill (§9.6 Figs 9-7…9-11, §10.5.1), PURE.
 *
 * Each alliance has one HIVE: two CELLS on a bar that rocks about a pivot 43.95 in up, one
 * CELL up at a time, bi-stable. Elements LAUNCHED into the up-CELL accumulate until their
 * load overcomes the damper; then the bar swings, the other CELL comes up, and what was in
 * the old up-CELL falls onto the tiles under it (G409's "hit the TILE floor").
 *
 * Nothing here reads or writes `World`. A HIVE is `{up, contents, tips, tipping}` (field-plan
 * §2 shape, declared locally until `state.ts` carries it); functions take it and return a NEW
 * one. Mass and colour lookups belong to the caller, and so does the RNG — `spillPoses` takes
 * a `() => number` so `play.ts` can hand it the world's mulberry32 and a smoke check can hand
 * it a counter. Printed numbers are imported from `config.ts`; the ones the manual does not
 * print are module-local and marked APPROX so the move into `config.ts` is one import line.
 */

/** which CELL is up — the HIVE axis runs along y, north = +y (rear), south = −y (audience). */
export type BbCellSide = 'north' | 'south';

export interface HiveState {
  up: BbCellSide;
  /** element ids in the UP cell, oldest first */
  contents: number[];
  /** TIPS completed this match */
  tips: number;
  /** seconds left in the swing; 0 = settled in a stable state */
  tipping: number;
}

/**
 * Load that tips a HIVE, in POLLEN-EQUIVALENTS. NOT PUBLISHED (§9.6 says only "enough").
 * Bounded below by the staged pose — 3 NECTAR sit in the up-cell and it is stable — so it is
 * > 3 × `BB_NECTAR_MASS` ≈ 4.95. Measure on 09-14: count pollen lobbed into a staged cell
 * until it tips. APPROX.
 */
export const BB_TIP_LOAD = 6; // APPROX

/**
 * Mass of one NECTAR in POLLEN-EQUIVALENTS. Neither mass is published; the ratio is the cube
 * of the diameter ratio (3.6 / 2.8)³ ≈ 2.1 for equal density, discounted because the larger
 * ball of the same family is thinner-walled. Weigh both on 09-14. APPROX.
 */
export const BB_NECTAR_MASS = 1.65; // APPROX

/** duration of the swing from one stable state to the other, seconds. APPROX. */
export const BB_TIP_SWING_S = 0.8; // APPROX

/** how far ABOVE the opening's top a descending element is still taken as entering — the
 * opening is 14 in tall and a lob comes in from above. APPROX. */
export const BB_HIVE_ACCEPT_MARGIN = 2.0; // APPROX

/** mass of an element in POLLEN-EQUIVALENTS, for `hiveLoad`. */
export function bbElementMass(kind: BbElementKind): number {
  return kind === 'pollen' ? 1 : BB_NECTAR_MASS;
}

export function otherSide(side: BbCellSide): BbCellSide {
  return side === 'north' ? 'south' : 'north';
}

/** the HIVE's pivot on the tiles — red x = −BB_HIVE_X, blue +BB_HIVE_X, both on y = 0 (Fig 9-10). */
export function hivePivot(alliance: Alliance): Vec2 {
  return { x: alliance === 'red' ? -BB_HIVE_X : BB_HIVE_X, y: 0 };
}

/** horizontal centre of one CELL's opening: the pivot displaced along y by the tilted arm's
 * projection (`BB_HIVE_CELL_DY`, Fig 9-9/9-10). */
export function hiveCellPos(alliance: Alliance, side: BbCellSide): Vec2 {
  const p = hivePivot(alliance);
  return { x: p.x, y: p.y + (side === 'north' ? BB_HIVE_CELL_DY : -BB_HIVE_CELL_DY) };
}

/**
 * CAPTURE test for one flight element: inside the up-CELL's accept footprint (`BB_CELL_OPEN`,
 * centred on the up cell), at opening height (`BB_HIVE_OPEN_Z`, plus `margin` above), and
 * DESCENDING. A HIVE mid-swing accepts nothing — its opening is moving. Anything that fails
 * this and still meets the structure is the caller's bounce (G417.H: a miss is not a foul).
 */
export function hiveAccepts(
  hive: HiveState,
  alliance: Alliance,
  pos: Vec2,
  z: number,
  vz: number,
  margin: number = BB_HIVE_ACCEPT_MARGIN,
): boolean {
  if (hive.tipping > 0 || vz >= 0) return false;
  const c = hiveCellPos(alliance, hive.up);
  if (Math.abs(pos.x - c.x) > BB_CELL_OPEN.w / 2 || Math.abs(pos.y - c.y) > BB_CELL_OPEN.d / 2) return false;
  return z >= BB_HIVE_OPEN_Z[0] && z <= BB_HIVE_OPEN_Z[1] + margin;
}

/** total load in the cell, in POLLEN-EQUIVALENTS. */
export function hiveLoad(contents: readonly number[], massOf: (id: number) => number): number {
  let sum = 0;
  for (const id of contents) sum += massOf(id);
  return sum;
}

export interface HiveStepResult {
  hive: HiveState;
  /** the swing SETTLED this step — the TIP is complete (§10.5.1 A+B), award it now */
  tipped: boolean;
  /** ids that fell out of the cell that just went down; empty unless `tipped` */
  spilled: number[];
}

/**
 * One tick of HIVE mechanics. Settled and loaded to `BB_TIP_LOAD` ⇒ the swing STARTS (no tip
 * yet — the manual scores a TIP when the damper contacts the frame, i.e. when it settles).
 * Mid-swing ⇒ the clock runs down; on reaching zero the cells swap, `tips` increments and the
 * old contents are returned as `spilled` for the caller to re-spawn on the tiles under the
 * now-down cell (`spillPoses`). The new up-cell starts empty. Never mutates `hive`.
 */
export function hiveStep(hive: HiveState, dt: number, massOf: (id: number) => number): HiveStepResult {
  if (hive.tipping > 0) {
    const left = hive.tipping - dt;
    if (left > 0) return { hive: { ...hive, contents: [...hive.contents], tipping: left }, tipped: false, spilled: [] };
    return {
      hive: { up: otherSide(hive.up), contents: [], tips: hive.tips + 1, tipping: 0 },
      tipped: true,
      spilled: [...hive.contents],
    };
  }
  if (hiveLoad(hive.contents, massOf) >= BB_TIP_LOAD) {
    return { hive: { ...hive, contents: [...hive.contents], tipping: BB_TIP_SWING_S }, tipped: false, spilled: [] };
  }
  return { hive: { ...hive, contents: [...hive.contents] }, tipped: false, spilled: [] };
}

/**
 * Where spilled elements re-enter the world: under the now-DOWN cell of a HIVE that has just
 * settled (`hive.up` is the NEW up cell). The down cell hangs at `BB_HIVE_BOTTOM_Z` with its
 * mouth facing out along the HIVE axis, so the contents fall in a patch one cell footprint
 * wide, just outboard of the cell centre (field-plan §2.1: y ≈ ∓(13.4 + 6)). `rng` yields
 * [0, 1); `count` draws, two per pose, in order — deterministic for a deterministic rng.
 */
export function spillPoses(hive: HiveState, alliance: Alliance, count: number, rng: () => number): Vec3[] {
  const down = otherSide(hive.up);
  const c = hiveCellPos(alliance, down);
  const sign = down === 'north' ? 1 : -1;
  const cy = c.y + sign * (BB_CELL_OPEN.d / 2);
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const x = c.x + (rng() * 2 - 1) * (BB_CELL_OPEN.w / 2);
    const y = cy + (rng() * 2 - 1) * (BB_CELL_OPEN.d / 2);
    out.push({ x, y, z: BB_HIVE_BOTTOM_Z });
  }
  return out;
}
