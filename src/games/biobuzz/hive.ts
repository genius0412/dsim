import type { Alliance, Vec2 } from '../../types';
import {
  BB_CELL_OPEN,
  BB_HIVE_BOTTOM_Z,
  BB_HIVE_CELL_DY,
  BB_HIVE_OPEN_Z,
  BB_HIVE_X,
  BB_TIP_POLLEN,
} from './config';
import type { BbCellSide, BbHiveState, Vec3 } from './state';
import type { BbElementKind } from './flower';

/**
 * HIVE logic — capture, the TIP, the release, the spill (§9.6 Figs 9-7…9-11, §10.5.1), PURE.
 *
 * Each alliance has one HIVE: two CELLS on one rigid bar rocking about a pivot 43.95 in up,
 * bi-stable at ±30°, one CELL up at a time. Elements LAUNCHED into the up-CELL accumulate
 * until the load overcomes the damper; the bar swings, the contents fall out as it passes
 * level, and the other CELL arrives up.
 *
 * Nothing here reads or writes `World`. A HIVE is `BbHiveState` (`state.ts`) plus one flag;
 * functions take it and return a NEW one. The colour lookup belongs to the caller, and so does
 * the RNG — `spillPoses` takes a `() => number` so `play.ts` can hand it the world's mulberry32
 * and a smoke check can hand it a counter.
 */

export type { BbCellSide };

/**
 * A HIVE, plus whether the swing in progress has already dropped its contents.
 *
 * `released` is the only field `BbHiveState` does not carry yet, and it exists because the
 * spill and the TIP happen at DIFFERENT moments of one swing (see `hiveStep`): without it a
 * caller cannot tell a bar still carrying its load from one that has already emptied, and a
 * re-entrant step would spill twice. Optional here so a plain `BbHiveState` off `world.biobuzz`
 * still typechecks as an INPUT; every hive this module returns sets it.
 *
 * REQUEST to `state.ts` (Lane A, at the wiring pass): add `released: boolean` to `BbHiveState`
 * and `released: false` to both hives in `emptyBiobuzzState()`, then this interface collapses
 * to a re-export.
 */
export interface HiveState extends BbHiveState {
  released?: boolean;
}

/**
 * Duration of the swing from one stable state to the other, seconds.
 *
 * RULING (field-plan §2.1, 2026-09-12): **4.0**. A 43.95-in bar carrying a dozen elements is a
 * slow, damped see-saw, not a trigger — and the length is gameplay-load-bearing, because the
 * CELL accepts nothing while it moves (`hiveAccepts`) so a TIP costs the launcher four seconds
 * of its own target. Not APPROX: it is a decision, not a measurement.
 */
export const BB_TIP_SWING_S = 4.0;

/**
 * When in the swing the contents fall out, in seconds REMAINING.
 *
 * RULING (field-plan §2.1): at LEVEL, i.e. half way. The CELL is a tray with an open outer
 * end; it holds while it is tilted back and empties the instant the floor passes horizontal,
 * which is the midpoint of a ±30° rock. Taking that as `SWING / 2` assumes a constant angular
 * rate, which a damped swing is not exactly — the error is at most a few tenths and moves only
 * WHEN the spill lands on the tiles, never whether it does.
 */
export const BB_TIP_RELEASE_S = BB_TIP_SWING_S / 2;

/** how far ABOVE the opening's top a descending element is still taken as entering — the
 * opening is 14 in tall (§9.6.2) and a lob arrives from above. APPROX. */
export const BB_HIVE_ACCEPT_MARGIN = 2.0; // APPROX

/** what is in an up-CELL, counted by type — the two numbers `BB_TIP_POLLEN` is indexed by. */
export interface HiveLoad {
  pollen: number;
  nectar: number;
}

export function otherSide(side: BbCellSide): BbCellSide {
  return side === 'north' ? 'south' : 'north';
}

/** the HIVE's pivot on the tiles — red x = −BB_HIVE_X, blue +BB_HIVE_X, both on y = 0 (Fig 9-10). */
export function hivePivot(alliance: Alliance): Vec2 {
  return { x: alliance === 'red' ? -BB_HIVE_X : BB_HIVE_X, y: 0 };
}

/** horizontal centre of one CELL's opening: the pivot displaced along y by the tilted arm's
 * projection (`BB_HIVE_CELL_DY`, reference §2.2). */
export function hiveCellPos(alliance: Alliance, side: BbCellSide): Vec2 {
  const p = hivePivot(alliance);
  return { x: p.x, y: p.y + (side === 'north' ? BB_HIVE_CELL_DY : -BB_HIVE_CELL_DY) };
}

/**
 * Which way along the HIVE axis an element must be TRAVELLING to get into the up-CELL: toward
 * the pivot, i.e. INBOARD.
 *
 * RULING (field-plan §2.1): the CELL is open at its OUTER end only. The up-cell's outer end is
 * its high end, so the only way in is a shot arriving over that lip and running down the tray
 * toward the pivot. A shot crossing the same rectangle outbound is going the other way through
 * the closed back wall, which is a bounce off the structure, not a capture (G417.H: a miss is
 * not a foul). `+1` means +y.
 */
export function hiveApproachSign(up: BbCellSide): 1 | -1 {
  return up === 'north' ? -1 : 1;
}

/**
 * CAPTURE test for one flight element: inside the up-CELL's accept footprint (`BB_CELL_OPEN`,
 * centred on the up cell), at opening height (`BB_HIVE_OPEN_Z`, plus `margin` above),
 * DESCENDING, and travelling INBOARD along the HIVE axis (`hiveApproachSign`).
 *
 * A HIVE mid-swing accepts nothing — its opening is moving, and the tray is tipping its load
 * out rather than taking one on.
 */
export function hiveAccepts(
  hive: HiveState,
  alliance: Alliance,
  pos: Vec2,
  z: number,
  vel: Vec3,
  margin: number = BB_HIVE_ACCEPT_MARGIN,
): boolean {
  if (hive.tipping > 0 || vel.z >= 0) return false;
  if (vel.y * hiveApproachSign(hive.up) <= 0) return false;
  const c = hiveCellPos(alliance, hive.up);
  if (Math.abs(pos.x - c.x) > BB_CELL_OPEN.w / 2 || Math.abs(pos.y - c.y) > BB_CELL_OPEN.d / 2) return false;
  return z >= BB_HIVE_OPEN_Z[0] && z <= BB_HIVE_OPEN_Z[1] + margin;
}

/** what is in the cell, by type. */
export function hiveLoad(contents: readonly number[], kindOf: (id: number) => BbElementKind): HiveLoad {
  let pollen = 0;
  let nectar = 0;
  for (const id of contents) {
    if (kindOf(id) === 'pollen') pollen++;
    else nectar++;
  }
  return { pollen, nectar };
}

/**
 * Does this load tip the CELL? `BB_TIP_POLLEN` is a MEASURED TABLE indexed by nectar count
 * (config.ts, owner 2026-09-12) and nothing interpolates it — a see-saw is torque and packing,
 * not weight, and no linear mass model fits the measured rows. Past the end of the table the
 * last row holds, which is 0 pollen: five nectar tip a cell on their own.
 */
export function hiveWillTip(load: HiveLoad): boolean {
  return load.pollen >= BB_TIP_POLLEN[Math.min(load.nectar, BB_TIP_POLLEN.length - 1)];
}

export interface HiveStepResult {
  hive: HiveState;
  /** the swing SETTLED this step — the TIP is complete (§10.5.1 A+B), award the 20 now */
  tipped: boolean;
  /** ids that left the CELL this step, as the bar passed level; empty on every other step */
  spilled: number[];
}

/**
 * One tick of HIVE mechanics. Three distinct moments, and keeping them apart is the point:
 *
 * 1. **Settled and loaded** (`hiveWillTip`) ⇒ the swing STARTS. No points: §10.5.1 scores a
 *    TIP when the damper makes contact, which is the END of the swing.
 * 2. **Mid-swing, passing LEVEL** (`BB_TIP_RELEASE_S` left) ⇒ the contents fall out, returned
 *    as `spilled` for the caller to put back on the tiles (`spillPoses`). `released` latches so
 *    a tray cannot empty twice, and the fallback at settle covers a `dt` longer than half a
 *    swing.
 * 3. **The swing reaching zero** ⇒ the cells swap, `tips` increments, `tipped` is true.
 *
 * The spill therefore lands while the bar is still moving, a couple of seconds before the
 * points — which is what a real HIVE does, and what makes the elements available to a robot
 * under the structure before the score changes. Never mutates `hive`.
 */
export function hiveStep(hive: HiveState, dt: number, kindOf: (id: number) => BbElementKind): HiveStepResult {
  if (hive.tipping > 0) {
    const left = hive.tipping - dt;
    const released = hive.released ?? false;
    if (left > 0) {
      const releasing = !released && left <= BB_TIP_RELEASE_S;
      return {
        hive: {
          ...hive,
          contents: releasing ? [] : [...hive.contents],
          tipping: left,
          released: released || releasing,
        },
        tipped: false,
        spilled: releasing ? [...hive.contents] : [],
      };
    }
    return {
      hive: { up: otherSide(hive.up), contents: [], tips: hive.tips + 1, tipping: 0, released: false },
      tipped: true,
      // normally empty — the tray emptied at level. Non-empty only when one `dt` spanned the
      // whole second half of the swing, and then the elements still have to go somewhere.
      spilled: released ? [] : [...hive.contents],
    };
  }
  if (hiveWillTip(hiveLoad(hive.contents, kindOf))) {
    return {
      hive: { ...hive, contents: [...hive.contents], tipping: BB_TIP_SWING_S, released: false },
      tipped: false,
      spilled: [],
    };
  }
  return { hive: { ...hive, contents: [...hive.contents], released: hive.released ?? false }, tipped: false, spilled: [] };
}

/** OUTBOARD speed range of a spilled element (in/s) and its lateral spread. APPROX: the tray
 * is a ramp and its contents leave with whatever the swing gave them; nothing published says
 * how much. The range is what makes a spill a scatter under the structure rather than a stack
 * on one tile. */
export const BB_SPILL_SPEED: readonly [number, number] = [40, 60]; // APPROX
export const BB_SPILL_LATERAL = 12; // APPROX

/** one spilled element: where it re-enters the world and how fast it is going. */
export interface SpillPose {
  pos: Vec3;
  vel: Vec3;
}

/**
 * Where spilled elements re-enter the world, and with what velocity.
 *
 * `hive` is the hive AS IT IS WHEN THE SPILL HAPPENS — mid-swing, still carrying the `up` of
 * the cell that is on its way down — so the emptying cell is `hive.up` while `tipping > 0`,
 * and `otherSide(hive.up)` once it has settled. Both callers work: `spillPoses` takes the side
 * explicitly through `hive`, reading the emptying side off `tipping`.
 *
 * The elements leave over the cell's open OUTER end, so they land just outboard of the cell
 * centre and carry an OUTBOARD velocity (`BB_SPILL_SPEED`, `BB_SPILL_LATERAL` across). `z` is
 * `BB_HIVE_BOTTOM_Z` — the underside of the structure, the height the tray is at when it
 * empties — and `vel.z` is 0, leaving the drop to the caller's flight step.
 *
 * `rng` yields [0, 1) and is drawn FOUR TIMES PER POSE in order (x, y, speed, lateral), so a
 * deterministic rng gives a deterministic scatter.
 */
export function spillPoses(hive: HiveState, alliance: Alliance, count: number, rng: () => number): SpillPose[] {
  const emptying = hive.tipping > 0 ? hive.up : otherSide(hive.up);
  const c = hiveCellPos(alliance, emptying);
  const sign = emptying === 'north' ? 1 : -1;
  const cy = c.y + sign * (BB_CELL_OPEN.d / 2);
  const [vMin, vMax] = BB_SPILL_SPEED;
  const out: SpillPose[] = [];
  for (let i = 0; i < count; i++) {
    const x = c.x + (rng() * 2 - 1) * (BB_CELL_OPEN.w / 2);
    const y = cy + (rng() * 2 - 1) * (BB_CELL_OPEN.d / 2);
    const speed = vMin + rng() * (vMax - vMin);
    const lateral = (rng() * 2 - 1) * BB_SPILL_LATERAL;
    out.push({ pos: { x, y, z: BB_HIVE_BOTTOM_Z }, vel: { x: lateral, y: sign * speed, z: 0 } });
  }
  return out;
}
