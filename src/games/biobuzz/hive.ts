import type { Alliance, Vec2 } from '../../types';
import { dcos, dsin } from '../../math';
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
 * Nothing here reads or writes `World`. A HIVE is exactly `BbHiveState` (`state.ts`);
 * functions take one and return a NEW one. The colour lookup belongs to the caller, and so does
 * the RNG — `spillPoses` takes a `() => number` so `play.ts` can hand it the world's mulberry32
 * and a smoke check can hand it a counter.
 */

export type { BbCellSide };

/**
 * A HIVE — now exactly `BbHiveState`, and this is a RE-EXPORT rather than an interface.
 *
 * It used to widen the state's shape with an optional `released`, because the spill and the
 * TIP happen at DIFFERENT moments of one swing (see `hiveStep`) and `state.ts` did not carry
 * the latch that tells a bar still holding its load from one that has already emptied. The
 * field landed at the wiring pass, so the widening is gone: there is ONE hive shape, the
 * state's, and a hive read off `world.biobuzz` and a hive this module returns are the same
 * type. The alias stays so every existing caller and check keeps its name.
 */
export type HiveState = BbHiveState;

/**
 * Duration of the swing from one stable state to the other, seconds.
 *
 * RULING (field-plan §2.1, 2026-09-12): **4.0**. A 43.95-in bar carrying a dozen elements is a
 * slow, damped see-saw, not a trigger. Not APPROX: it is a decision, not a measurement.
 *
 * It is gameplay-load-bearing because of what the swing does to the TARGET, which is no longer
 * "the cell takes nothing for four seconds" (owner feedback, 2026-09-12): the tray keeps taking
 * throughout, and the release HANDS OVER from the filled tray to the incoming one half way
 * through (`hiveTakingSide`). What the length costs a launcher is the two seconds in which its
 * own opening is the one about to empty, and the aim change at the hand-over.
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
 * WHICH CELL IS TAKING ELEMENTS RIGHT NOW — the ONE answer, and every capture, park, aim and
 * readout has to come through it.
 *
 * Settled, it is `up`, as it always was. THROUGH A SWING IT FOLLOWS THE RELEASE (owner
 * feedback, 2026-09-12):
 *
 *  • BEFORE the bar passes level (`released` false) it is still `up` — the tray that just
 *    filled. It is tilted back, it is holding its load, and a shot already in the air when the
 *    swing started arrives at a cell that is still a cell. Refusing those was the old
 *    behaviour, and the thing it produced was a driver watching a volley he had already fired
 *    pass through the tray and land on the tiles.
 *  • AFTER the release it is `otherSide(up)` — the tray coming UP, now empty, whose opening is
 *    rising into the launch window. It is what a turret tracking the incoming cell is aiming
 *    at, and what auto-fire resumes on.
 *
 * So the HIVE is never a hole in the field; the only thing a swing changes is WHICH tray your
 * element lands in, and the handover is the same instant as the spill. `hiveStep` carries a
 * post-release load through the settle for exactly this reason.
 */
export function hiveTakingSide(hive: HiveState): BbCellSide {
  return hive.tipping > 0 && hive.released ? otherSide(hive.up) : hive.up;
}

/**
 * CAPTURE test for one flight element: inside the TAKING cell's accept footprint
 * (`BB_CELL_OPEN`, centred on `hiveTakingSide`), at opening height (`BB_HIVE_OPEN_Z`, plus
 * `margin` above), DESCENDING, and travelling INBOARD along the HIVE axis
 * (`hiveApproachSign`).
 *
 * MID-SWING IT STILL ACCEPTS, into whichever tray `hiveTakingSide` names — see that function
 * for which one and why. The opening is genuinely moving through the swing and this test does
 * not model that: it uses the taking cell's SETTLED footprint throughout. That is the honest
 * trade. The alternative the code had was refusing everything for four seconds, and a cell
 * that is 10.43 in deep in plan sweeps most of its own footprint anyway.
 */
export function hiveAccepts(
  hive: HiveState,
  alliance: Alliance,
  pos: Vec2,
  z: number,
  vel: Vec3,
  margin: number = BB_HIVE_ACCEPT_MARGIN,
): boolean {
  if (vel.z >= 0) return false;
  const side = hiveTakingSide(hive);
  if (vel.y * hiveApproachSign(side) <= 0) return false;
  const c = hiveCellPos(alliance, side);
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
 * ⚠️ `contents` SURVIVES THE SETTLE ONCE THE TRAY HAS RELEASED. The cell goes on taking
 * elements through the swing (`hiveTakingSide`), and after the release the tray filling is the
 * one coming UP — the one that `up` names a tick later. Emptying `contents` unconditionally at
 * the settle threw those away, silently, a second or two after they were captured. So the
 * settle keeps them when `released` is set, and only clears (and spills) when it is not, which
 * is the `dt`-longer-than-half-a-swing fallback and nothing else.
 *
 * The spill therefore lands while the bar is still moving, a couple of seconds before the
 * points — which is what a real HIVE does, and what makes the elements available to a robot
 * under the structure before the score changes. Never mutates `hive`.
 */
export function hiveStep(hive: HiveState, dt: number, kindOf: (id: number) => BbElementKind): HiveStepResult {
  if (hive.tipping > 0) {
    const left = hive.tipping - dt;
    const released = hive.released;
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
      hive: {
        up: otherSide(hive.up),
        // the load the INCOMING tray took after the release — see the note above. Empty in the
        // ordinary case, because nothing was launched during the second half of the swing.
        contents: released ? [...hive.contents] : [],
        tips: hive.tips + 1,
        tipping: 0,
        released: false,
      },
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
  return { hive: { ...hive, contents: [...hive.contents] }, tipped: false, spilled: [] };
}

/**
 * How hard a TIP throws its contents, and how wide.
 *
 * CALIBRATED TO THE OWNER'S LANDING LINES (ruling 2026-09-12, off the visuals chat's field-v4
 * page): the pile leaves at **50-88 in/s** in a **±55° fan** about the outboard axis and comes
 * to rest **57-107 in from the PIVOT**, median about 70, wall to wall once the bounces are in.
 * A TIP is a THROW, not a drop — the tray is a ramp on a see-saw that has been accelerating for
 * two seconds when it passes level, and the spill crossing half the field is the point of it.
 *
 * BOTH STILL APPROX. V1 prints no spill kinematics at all; these two numbers are fitted to
 * where the elements LAND on a drawing, which is the observable a person can actually read off
 * a field, and the landing distance is what should be re-checked against a real tip — not the
 * speed. The previous pair (40-60 in/s straight outboard, ±12 in/s across, i.e. a ±13° fan)
 * landed the six staged elements in a strip about 20 in wide; see
 * `docs/biobuzz/feedback/001-spill-kinematics.md` for the measurement either side of this change.
 *
 * ⚠️ THE FAN IS AN ANGLE, NOT A CROSS-SPEED. `BB_SPILL_LATERAL` was ±12 in/s added across the
 * throw, so the widest possible fan was `atan(12 / 50)` — the FASTER an element left, the
 * NARROWER its spread, which is backwards: a ramp scatters by direction, and how far a given
 * element goes is then a consequence of its own angle and speed rather than a cap on the width.
 */
export const BB_SPILL_SPEED: readonly [number, number] = [50, 88]; // APPROX
export const BB_SPILL_FAN = 55; // degrees off the outboard axis, half-angle. APPROX

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
 * centre and are thrown along a direction drawn from the ±`BB_SPILL_FAN` fan about the outboard
 * axis, at a speed drawn from `BB_SPILL_SPEED`. `z` is `BB_HIVE_BOTTOM_Z` — the underside of the
 * structure, the height the tray is at when it empties — and `vel.z` is 0, leaving the drop to
 * the caller's flight step.
 *
 * THE FAN IS APPLIED AS A ROTATION of the outboard unit vector, so the element's SPEED is what
 * `BB_SPILL_SPEED` says whatever direction it took. Building the velocity as "outboard speed
 * plus a cross term" instead makes the drawn speed the outboard COMPONENT, which is a different
 * and larger number, and makes the fan narrow as the speed rises.
 *
 * `rng` yields [0, 1) and is drawn FOUR TIMES PER POSE in order (x, y, speed, angle), so a
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
    // the outboard axis is ±y; a fan angle of 0 throws straight out, ±FAN swings it toward ±x.
    // `dsin`/`dcos` take RADIANS — the constant is in DEGREES because that is how the ruling is
    // written and how a fan is read off a drawing.
    const a = (rng() * 2 - 1) * BB_SPILL_FAN * (Math.PI / 180);
    out.push({
      pos: { x, y, z: BB_HIVE_BOTTOM_Z },
      vel: { x: speed * dsin(a), y: sign * speed * dcos(a), z: 0 },
    });
  }
  return out;
}
