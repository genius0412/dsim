import type { Alliance, World } from '../../types';
import { biobuzzPhysics, type BbHiveState } from './state';

/**
 * THE HIVE TRAYS ON THE INTERPOLATION CLOCK — what `game.ts`'s `displayWorld` needs to draw a
 * tipping tray at the same moment as the elements riding it.
 *
 * DOM-free and pure, so the headless smoke suite can measure it against a real 3D tip
 * (`scripts/smoke-biobuzz/hive3d.ts`, "tray draw:"). `game.ts` itself cannot be imported there.
 *
 * ⚠️ **WHY IT EXISTS.** In a 3D room on the interpolated path (prediction Off, Light or Balanced,
 * and every spectator), `displayWorld` lerped each element between the two snapshots bracketing
 * the render clock but drew the tray's `hives[a].angle` straight off `this.world`, the NEWEST
 * snapshot. So the tray stepped at 30 Hz, and it sat `INTERP_DELAY_TICKS` ahead of the elements
 * seated in it, which opened a gap between a ball and the cell floor under it through the whole
 * swing. Full prediction never had it: that tier steps the whole world, tray included, and
 * draws everything off it.
 */

/** one snapshot's tray poses, and which elements were seated on each tray at that tick —
 *  `snapBuf.hives` in `game.ts`. `contents` is at most a cell's worth of ids per hive. */
export type TraySnap = Record<Alliance, { angle?: number; tipping: number; contents: number[] }>;

const ALLIANCES: readonly Alliance[] = ['red', 'blue'];

/** a tray that turns less than this between two snapshots is at rest (rad; the readback rounds to 1e-4) */
const TRAY_STILL_RAD = 1e-4;

/** the tray poses of a 3D-physics world, or null for anything else (a 2D world draws its tray
 *  off the newest world, which is the same clock as its un-interpolated balls). */
export function traySnap(w: World): TraySnap | null {
  const bb = w.biobuzz;
  if (!bb || biobuzzPhysics(w) !== '3d') return null;
  const snap = (h: BbHiveState) => ({ angle: h.angle, tipping: h.tipping, contents: [...h.contents] });
  return { red: snap(bb.hives.red), blue: snap(bb.hives.blue) };
}

/**
 * The world's `biobuzz` with each tray at the interpolation clock: `angle` and `tipping` lerped
 * between the two bracketing snapshots at fraction `a`.
 *
 * Each field lerps only when BOTH snapshots carry it. `angle` is absent on a kinematic-tray world
 * (the timer's formula draws that tray, off `tipping`), and `tipping` is 0 at rest, so a lerp
 * across a swing's first or last snapshot would draw a countdown the sim never had; either way
 * that field comes from the newest world, as before. The scoring state (`up`, `tips`,
 * `contents`, `released`) is never touched: this is the pose and nothing else.
 *
 * Returns the world's OWN object when no tray moved, so a settled field allocates nothing per frame.
 */
export function interpTrays(
  bb: World['biobuzz'],
  s0: TraySnap | null,
  s1: TraySnap | null,
  a: number,
): World['biobuzz'] {
  if (!bb || !s0 || !s1) return bb;
  const lerp = (p: number, q: number): number => p + (q - p) * a;
  const tray = (side: Alliance): BbHiveState => {
    const now = bb.hives[side];
    const p = s0[side];
    const q = s1[side];
    const angle = typeof p.angle === 'number' && typeof q.angle === 'number' ? lerp(p.angle, q.angle) : now.angle;
    const tipping = p.tipping > 0 && q.tipping > 0 ? lerp(p.tipping, q.tipping) : now.tipping;
    return angle === now.angle && tipping === now.tipping ? now : { ...now, angle, tipping };
  };
  const red = tray('red');
  const blue = tray('blue');
  return red === bb.hives.red && blue === bb.hives.blue ? bb : { ...bb, hives: { red, blue } };
}

/**
 * THE ELEMENTS RIDING A MOVING TRAY — the ids `displayWorld` must draw on the interpolation clock
 * with the tray, never off the prediction.
 *
 * An element that LANDED while the predictor carried it keeps being drawn predicted
 * (`drawPredictedElements`), so a shot does not jump back up its own flight path as it seats. The
 * predictor only PINS a seated element at the newest snapshot's pose, though, so once its tray
 * starts to swing that ball would ride the newest clock while the tray under it rides the
 * interpolated one.
 *
 * ⚠️ **READ OFF THE TWO BRACKETING SNAPSHOTS, NOT THE NEWEST WORLD.** The newest world empties the
 * cell at the spill tick while the render clock is still `INTERP_DELAY_TICKS` before it, with the
 * balls drawn seated on a tray that has not reached the release yet. Asking the newest world
 * dropped them off the tray's clock for exactly those frames (smoke: "tray draw: … rides its
 * clock"). An id rides when BOTH snapshots have it seated and the tray is moving between them:
 * their angles disagree, or a swing countdown is running.
 */
export function trayRiders(s0: TraySnap | null, s1: TraySnap | null): ReadonlySet<number> {
  const ids = new Set<number>();
  if (!s0 || !s1) return ids;
  for (const side of ALLIANCES) {
    const p = s0[side];
    const q = s1[side];
    const turning =
      typeof p.angle === 'number' && typeof q.angle === 'number' && Math.abs(q.angle - p.angle) > TRAY_STILL_RAD;
    if (!turning && !(p.tipping > 0) && !(q.tipping > 0)) continue;
    const later = new Set(q.contents);
    for (const id of p.contents) if (later.has(id)) ids.add(id);
  }
  return ids;
}
