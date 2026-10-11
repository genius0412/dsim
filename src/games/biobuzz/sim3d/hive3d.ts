import type { Alliance, World } from '../../../types';
import type { BbElementKind } from '../flower';
import type { BbHiveState } from '../state';
import { dsin } from '../../../math';
import { GRAVITY } from '../../../config';
import {
  BB3_HIVE_DETENT,
  BB3_HIVE_PIVOT_Z,
  BB3_HIVE_REST_W,
  BB3_HIVE_STOP_DEG,
  BB3_HIVE_SWING_EASE,
  BB_HIVE_TILT_DEG,
  BB_POLLEN_R,
} from '../config';
import { BB_TIP_SWING_S, hiveLoad, hiveSwingRate, hiveTimerStep, hiveWillTip, otherSide } from '../hive';
import { bbKindIndex } from '../score';
import { elementMass, hiveCellLocalBox, hivePivotX, hiveTrayMassProps, useHiveDynamic } from './bodies';
import type { Engine3d } from './engineImpl';
import { trayTilt } from './engineImpl';
import { rotate2, tiltQuatX } from './math3';

/**
 * BIOBUZZ 3D PHYSICS -- THE HIVE.
 *
 * Two trays, two models, one reader. `BB3_HIVE_DYNAMIC` picks between them and `hiveTiltAngle`
 * is the ONE authority both renderers and `derive.ts` read either way.
 *
 * ── THE DAY 1 FALLBACK: a KINEMATIC tray on the shared TIMER ────────────────────────────────
 * The TIP is `hiveTimerStep` (extracted from `../hive.ts`'s `hiveStep` -- a pure extraction, see
 * that file's header) run over the load table. The SPILL is not a timer: the kinematic tray
 * physically rotates and every element resting in the tipping cell is a real body on a real
 * floor that tilts out from under it, so it slides out because gravity says so and `derive.ts`
 * simply stops finding it inside the cell box.
 *
 * ── THE DAY 2 SEE-SAW: a DYNAMIC tray on a REVOLUTE JOINT (plan §3.6) ───────────────────────
 * The tray is a body. Nothing plays a swing back; the swing IS the solve. Three terms make a bar
 * on a hinge behave like the real hive, and `scripts/hive-calibrate.ts` fits all three against
 * the Event Field Setup Guide's own rows:
 *
 *  1. **the tray's own weight, above the pivot.** `hiveTrayMassProps` puts the centre of mass at
 *     the cells' mid-height, which is 5.5 in ABOVE the hinge, so the tray has an unstable
 *     equilibrium at level and a stable one at each stop. That IS §9.6's "bi-stable", and it is
 *     the tray's shape rather than a term anyone added. `BB3_HIVE_BALLAST` tunes it, the way the
 *     field guide's ballast washers tune the real one.
 *  2. **the DETENT**, `BB3_HIVE_DETENT`: a PIN that holds the bar at its stop until the load
 *     table lifts it. It used to be a breakaway torque the load had to beat — see the trigger
 *     note below for the measurement that retired that reading.
 *  3. **the DAMPING**, `BB3_HIVE_DAMPING`: angular damping on the body, which is what made the
 *     FREE stop-to-stop swing take the owner's 4.0 s instead of under two. ⚠️ Since 2026-10-11 a
 *     released swing is DRIVEN at the count's pace (`hiveSwingPace`, `BB3_HIVE_SWING_EASE`), so
 *     the damping no longer sets the swing time; it governs only an undriven tray.
 *
 * ⚠️ **WHY THE DETENT IS A HOLD AND NOT JOINT FRICTION.** Rapier has no joint friction, and the
 * two things it does have are both worse here. A MOTOR with a torque cap holds the tray at its
 * stop, but it goes on pulling toward that stop after the release, so the swing has to fight it
 * the whole way and the released tray is no longer a free see-saw. Raising the joint's own
 * limits to bite is not a detent at all. The HOLD below is instead a plain statement of what a
 * detent IS: while the bar is at a stop and nothing has called for a tip, the bar does not move
 * -- pinned exactly, at exactly the stop angle. The moment the pin lifts, it is gone and nothing
 * is left but gravity, the contents and the damping.
 *
 * It is DETERMINISTIC because it is a pure function of the JSON: the trigger reads the derived
 * `contents` list, which `derive.ts` wrote from body positions (read back last tick, rounded to
 * 1e-4), with no solver state and no clock in it. Two peers stepping the same inputs lift the
 * pin on the same tick.
 *
 * ⚠️ **AND THE TRIGGER IS THE TABLE, NOT A TORQUE.** It was a torque until 2026-09-19 -- the tray
 * tipped when the elements really in the cell out-torqued `hiveHoldTorque` at the lever arms they
 * really had -- and that is wrong for one reason that no calibration can reach: ONE COUNT DOES
 * NOT DETERMINE ONE TORQUE. Measured in one cell at the stop, at the shipped hold of 5915,
 * staging the same count four ways (the HIVE3D lane prints all of it): 8 POLLEN weigh **4608**
 * piled two-wide up the back wall and **8166** in a two-wide line down the tray; 7 POLLEN weigh
 * **4146** to **6771**. (The 8-POLLEN figures were 4560 / 8051 until the registration fix of
 * 2026-09-19 gave those rows a few ticks less settling at the stop before the pin lifts; the
 * 7-POLLEN row, which never tips, is unchanged to the digit.) The two counts' torque ranges
 * OVERLAP over most of their length, so NO
 * value of `BB3_HIVE_DETENT` separates them -- and both halves of field guide §12.3 were being
 * violated at once on the shipped numbers: 8 POLLEN crammed did NOT tip and 7 POLLEN in a line
 * DID, confirmed by running the lane's new checks against the old trigger. The lane never saw it
 * because every fixture staged one packing.
 *
 * `BB_TIP_POLLEN` is the only PUBLISHED statement of what a HIVE tips on, and `hud.ts` /
 * `HudSlots.tsx` promise it to the driver in as many words ("N MORE TO TIP"). So it is the rule,
 * and the torque is not: the trigger below is `hiveWillTip` over the same `contents` list the HUD
 * counts. One list, one predicate, two readers, which is the only arrangement in which "when it
 * says 0 more, it tips" cannot come apart. The owner's report was 1 POLLEN + 4 NECTAR: the HUD
 * read 0 more, the load weighed 5701 against a hold of 5915 -- short by 214, less than a quarter
 * of what one more POLLEN adds -- and the tray sat on its stop for the rest of the match.
 *
 * ⚠️ The detent is now a PIN THE TABLE LIFTS, not a breakaway the load beats. AND THE SWING AFTER
 * THE RELEASE RUNS AT THE COUNT'S PACE TOO (2026-10-11, `BB3_HIVE_SWING_EASE`), for the same
 * reason one level down: a free see-saw's speed is its contents' torque, so a pile against the
 * back wall swung slower with MORE in it than a minimum cell in a line. The tray is still a body
 * on its joint — the contents leave because the floor tilts out from under them, and the joint's
 * far limit ends the swing — it is the rate that is the table's, through `hiveSwingRate`. `hiveContentsTorque`
 * and `hiveRestoringTorque` stay exported and stay correct -- they are how the HIVE3D lane and
 * `scripts/hive-calibrate.ts` MEASURE the tray. They are no longer what triggers it.
 */

const ALLIANCES: readonly Alliance[] = ['red', 'blue'];

/** the rest tilt in radians -- `BB_HIVE_TILT_DEG` is in degrees because that is how §9.6 prints
 * it and how a drawing is read. */
const REST_RAD = (BB_HIVE_TILT_DEG * Math.PI) / 180;
/** the angle at which the tray counts as AT a stop: `BB3_HIVE_STOP_DEG`, §10.5.1 B's damper
 * contact expressed as an angle. */
const STOP_RAD = (BB3_HIVE_STOP_DEG * Math.PI) / 180;

/**
 * Is a point inside one CELL's interior, IN THAT CELL'S OWN CURRENT (TILTED) FRAME?
 *
 * Lives here rather than in `derive.ts` because BOTH need it now: derive to decide membership,
 * and the detent to know whose weight is on which side of the pivot. `derive.ts` imports it from
 * this file, which it already imports `hiveTiltAngle` from, so no new edge in the graph.
 *
 * world (y, z) -> the box's OWN frame is `rotate2(y, z, -theta)` with NO `refTheta` term: the CAD
 * tray is exported UN-TILTED, so `world = pivot + Rotate(theta) · (v, w)` holds directly for
 * every box on both paths -- see `HiveLocalBox.refTheta`.
 *
 * `minDepth` (inches, default 0 -- i.e. the plain interior test every existing caller makes)
 * LOWERS THE CEILING by that much: the point has to be that far below the cell's open rim rather
 * than merely inside it. It exists because the interior box alone cannot tell an element that is
 * IN the cell from a shot GRAZING across its open top, and depth can. `derive.ts` is the only
 * caller that passes it; see `BB3_CELL_SEAT_DEPTH` for the two measured bounds it sits between.
 * Keeping it here rather than as a second function is deliberate: the cell's geometry has ONE
 * authority, the way the tray's angle does.
 */
export function insideCell(
  px: number,
  py: number,
  pz: number,
  alliance: Alliance,
  sideSign: 1 | -1,
  theta: number,
  minDepth = 0,
): boolean {
  const box = hiveCellLocalBox(sideSign, alliance);
  const dx = px - hivePivotX(alliance);
  if (Math.abs(dx) > box.xHalf) return false;
  const { a: v, b: w } = rotate2(py, pz - BB3_HIVE_PIVOT_Z, -theta);
  return v >= box.vMin && v <= box.vMax && w >= box.wMin && w <= box.wMax - minDepth;
}

/**
 * THE TRAY ANGLE lives in `./tilt.ts` now and is re-exported here, unchanged, so every caller
 * that reached it through "the hive module" still does. It moved because the 3D SCENE reads it
 * on a frame where no 3D physics is loaded (a 2D-physics match in the 3D view), and importing
 * it from here dragged the whole 3D implementation — bodies, the CAD collider set, Rapier —
 * into the main chunk. See `tilt.ts`'s header and `engine.ts`'s.
 */
export { hiveTiltAngle } from './tilt';

// ---------------------------------------------------------------------------------------------
// THE DYNAMIC SEE-SAW
// ---------------------------------------------------------------------------------------------

/**
 * The torque about the pivot's x axis from everything sitting in EITHER of this hive's cells,
 * at the tray's current tilt. Signed: POSITIVE drives the north side up.
 *
 * ONE LINE OF ALGEBRA, and it is worth writing down because it looks too simple. A weight `m g`
 * acting straight down at world `(x, y, z)` has torque `r × F` about the pivot, whose x
 * component is `r_y·F_z − r_z·F_y = y·(−mg) − z·0`. The pivot is at `y = 0`, so the arm is the
 * element's own world y and nothing else: `τ = −m g y`. The tilt enters only through where the
 * element has ended up.
 *
 * It reads the BODIES' positions (via the JSON the readback wrote), not the derived `contents`
 * list, for two reasons: this runs at stage 6, BEFORE `derive.ts`, so `contents` would be a tick
 * stale; and an element bouncing in the top of the cell presses on the tray without having earned
 * its `BB3_CELL_SEAT_DEPTH` yet, so it belongs in a WEIGHT and not in a count.
 */
export function hiveContentsTorque(world: World, alliance: Alliance, theta: number): number {
  let tau = 0;
  for (const b of world.balls) {
    if (b.state.kind === 'held' || b.state.kind === 'stock') continue;
    const r = b.r ?? BB_POLLEN_R;
    const z = b.z + r;
    if (!insideCell(b.pos.x, b.pos.y, z, alliance, 1, theta) && !insideCell(b.pos.x, b.pos.y, z, alliance, -1, theta)) {
      continue;
    }
    const m = elementMass(b.color === 'red' || b.color === 'blue');
    tau += -m * GRAVITY * b.pos.y;
  }
  return tau;
}

/**
 * The tray's OWN restoring torque at tilt `theta`, positive toward +x rotation.
 *
 * The centre of mass sits at local `(v = 0, w = comW)` with `comW > 0`, which rotates to world
 * `y = −comW·sin(theta)`. By the same `τ = −m g y` as above, `τ = +M g comW sin(theta)` — the
 * same SIGN as `theta`, which is what "above the pivot" means and why the tray holds a stop
 * instead of falling to level.
 */
export function hiveRestoringTorque(alliance: Alliance, theta: number): number {
  const props = hiveTrayMassProps(alliance);
  return props.mass * GRAVITY * props.comW * dsin(theta);
}

/**
 * CALIBRATION-ONLY DETENT OVERRIDE. `scripts/hive-calibrate.ts` sweeps the hold torque to report
 * how far the see-saw's own balance sits from the published table, and it cannot do that by
 * rewriting `config.ts` between candidates — the module is already loaded. `null` (the default)
 * means "use `BB3_HIVE_DETENT`, as production does"; nothing outside that script and the HIVE3D
 * lane calls the setter, and neither leaves it set.
 *
 * It is a DIAGNOSTIC knob now, not a gameplay one: since the table became the trigger, nothing
 * the sweep finds changes which rows tip. It stays because it is how the measurement is taken.
 */
let detentOverride: number | null = null;

export function __setDetentForCalibration(value: number | null): void {
  detentOverride = value;
}

/**
 * What the tray's own weight plus the detent WOULD have held against, in torque — REPORTED by
 * the HIVE3D lane and by `scripts/hive-calibrate.ts`, and no longer what releases the tray.
 *
 * See the header: a count does not determine a torque, so this number and `BB_TIP_POLLEN`
 * disagree on real packings and the published table wins. It is kept because it is the
 * measurement that says HOW FAR apart they are, which is the number a re-weighed element set
 * would have to move, and because `BB3_HIVE_DETENT` with no reader would be a constant
 * documenting an intention nothing implements.
 */
export function hiveHoldTorque(alliance: Alliance, theta: number): number {
  return Math.abs(hiveRestoringTorque(alliance, theta)) + (detentOverride ?? BB3_HIVE_DETENT);
}

/**
 * CALIBRATION-ONLY PACE OVERRIDE. `scripts/hive-calibrate.ts` fits `BB3_HIVE_DAMPING` against
 * the FREE see-saw's swing time, and a paced swing takes `BB_TIP_SWING_S` whatever the damping
 * is, so that bisection would walk to one end of its range and write the result into
 * `config.ts`. `false` turns the pace off for the measurement; `null` (the default) is production.
 */
let paceOff = false;

export function __setSwingPaceForCalibration(on: boolean | null): void {
  paceOff = on === false;
}

/** `1 − m`, the share of the profile that the bell carries — see `BB3_HIVE_SWING_EASE`. */
const EASE_BELL = 1 - BB3_HIVE_SWING_EASE;

/** swing progress at which the tray stops counting as AT its stop: `BB3_HIVE_STOP_DEG` of the
 * `BB_HIVE_TILT_DEG` rest, as a fraction of the stop-to-stop travel. */
const P_STOP = (1 - STOP_RAD / REST_RAD) / 2;

/**
 * `∫ dp / g(p)` over the STOP-TO-STOP span `[P_STOP, 1 − P_STOP]`, for the profile's shape
 * `g(p) = m + (1 − m)·4p(1 − p)`: the time a unit-peak swing takes per unit of travel, between
 * the two moments §10.5.1 and the HIVE3D lane measure a swing by (it leaves the near stop; it
 * reaches the far one). Over the full `[0, 1]` its closed form is `atanh(√a)/√a` with `a = 1 − m`;
 * it is SUMMED here (midpoint rule, 4096 slices) because plain arithmetic is bit-identical on every
 * engine and a transcendental is not, and this lands in every server's and every replay's swing.
 */
const SWING_SHAPE_INTEGRAL = ((): number => {
  const n = 4096;
  const span = 1 - 2 * P_STOP;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const p = P_STOP + ((i + 0.5) / n) * span;
    sum += 1 / (BB3_HIVE_SWING_EASE + EASE_BELL * 4 * p * (1 - p));
  }
  return (sum / n) * span;
})();

/** the profile's PEAK rate (rad/s) at swing rate 1: whatever makes the stop-to-stop travel take
 * `BB_TIP_SWING_S` — 0.354 rad/s at the shipped numbers. */
const SWING_PEAK_W = (2 * REST_RAD * SWING_SHAPE_INTEGRAL) / BB_TIP_SWING_S;

/**
 * THE PACED SWING'S RATE at tilt `theta`, rad/s, unsigned — see `BB3_HIVE_SWING_EASE` for why a
 * released tray runs to a profile rather than to its contents' torque. `upSign` names the stop
 * the swing LEFT; `rate` is `hiveSwingRateNow`. A pure function of the JSON, like the pin.
 */
export function hiveSwingPace(theta: number, upSign: number, rate: number): number {
  const p = Math.min(1, Math.max(0, (1 - (upSign * theta) / REST_RAD) / 2));
  return rate * SWING_PEAK_W * (BB3_HIVE_SWING_EASE + EASE_BELL * 4 * p * (1 - p));
}

/**
 * THE SWING RATE IN FORCE — the timer tray's own rule (`hiveTimerStep`) on the dynamic tray.
 *
 * Until the release it is `hiveSwingRate` of the cell, so a driver who keeps firing into a
 * tipping tray speeds it up (the 2026-09-13 mechanic); it is RATCHETED with the rate already
 * latched, because a 3D cell can lose an element before level (one bouncing out of the top) and a
 * swing that slows down mid-way is the inconsistency this exists to remove. From the release on,
 * `contents` is the RISING cell (`hiveTakingSide`), so the latched `swingRate` is the only memory
 * of the load that started the swing, which is exactly why the field is state.
 */
export function hiveSwingRateNow(hive: BbHiveState, kindOf: (id: number) => BbElementKind): number {
  const latched = hive.tipping > 0 ? (hive.swingRate ?? 1) : 1;
  if (hive.tipping > 0 && hive.released) return latched;
  return Math.max(latched, hiveSwingRate(hiveLoad(hive.contents, kindOf)));
}

/**
 * set a tray turning toward the stop `far` at the paced rate for its current tilt.
 *
 * NOT pre-scaled for `BB3_HIVE_DAMPING`. MEASURED per tick on a threshold swing: a velocity set
 * here is the velocity the step moves the tray at, plus the one tick of gravity and contact the
 * solve adds on top (3–4 % through most of the swing, up to 19 % for the few ticks the cell is
 * spilling past −12°). Scaling it by `1 + dt·c` as a damping correction ran every swing 11 % fast.
 */
function paceSwing(body: Engine3d['hiveTrays'][Alliance], theta: number, far: number, rate: number): void {
  body.setAngvel({ x: far * hiveSwingPace(theta, -far, rate), y: 0, z: 0 }, true);
}

/** the angle a tray at `stop` sign should be pinned to. */
function stopAngle(sign: number): number {
  return sign >= 0 ? REST_RAD : -REST_RAD;
}

/**
 * THE DETENT, applied every tick before the solve (`engine.ts`'s `applyHiveTilt`).
 *
 * While a tray is AT a stop and the LOAD TABLE has not called for a tip, it is pinned there
 * exactly: rotation set to the stop, angular velocity zeroed. The tick the table calls for one,
 * the pin is not applied and the swing is DRIVEN at the count's pace (`hiveSwingPace`) until the
 * far stop, where the joint's limit takes it; the tray stays a dynamic body throughout, so the
 * contents still slide out because its floor tilts.
 *
 * ⚠️ **THE PIN IS SKIPPED WHEN IT WOULD BE A NO-OP**, and that guard is not an optimisation. A
 * `setRotation`/`setAngvel` pair is a WRITE even when the values are unchanged, and (measured on
 * the kinematic tray, `engine.ts`'s own CCD note) writing to a body every tick resets its sleep
 * timer, so a settled tray never sleeps and the elements resting in it jitter against a surface
 * that is being re-woken sixty times a second.
 */
export function hiveDetentHold(world: World, engine: Engine3d): void {
  const kindOf = bbKindIndex(world);
  for (const a of ALLIANCES) {
    const body = engine.hiveTrays[a];
    const theta = trayTilt(body);
    const sign = theta >= 0 ? 1 : -1;
    const atStop = Math.abs(theta) >= STOP_RAD;
    const hive = world.biobuzz?.hives[a];
    const upSign = hive?.up === 'south' ? -1 : 1;
    const load = hiveLoad(hive?.contents ?? [], kindOf);
    /**
     * ⚠️ **A TIP THE TABLE CALLED FOR RUNS TO THE FAR STOP AT THE COUNT'S PACE** — two owner
     * reports, one mechanism. 2026-09-20 ("people are still reporting hive not tipping in some
     * cases"): the mid-swing hand-over (`hiveTakingSide`) puts the driver's own continued fire into
     * the RISING cell, whose load torques the tray BACK, and a free see-saw lost that argument from
     * as far over as −24.2°. 2026-10-11 ("a lot of balls in the Hive... may sometimes tip slower
     * than... the bare minimum"): a free swing's speed is set by the contents' LEVER ARM, which is
     * packing, not count. `BB3_HIVE_SWING_EASE` carries the measurement. So a released tray is
     * DRIVEN along `hiveSwingPace` — set, not floored, every tick between the stops.
     *
     * `owed` is a pure function of the JSON — a swing counted down in `hives[a].tipping` with the
     * tray away from both stops — so a peer that rebuilds its engine mid-swing computes the same
     * thing, exactly like the pin below it. There is no engine-local latch, and `tipping` cannot
     * be set by anything but a real breakaway: the pin pins the body EXACTLY at its stop and
     * zeroes its angular velocity every tick it holds, so the tray can only leave a stop on a tick
     * the table lifted the pin.
     *
     * ⚠️ **NOT AT THE FAR STOP**: driven there, `|ω|` would never fall to the `BB3_HIVE_REST_W`
     * `hiveDynamicTick` scores the TIP on — the profile hands the tray to the joint's limit at its
     * own arrival speed and the stop does the rest. The NEAR stop is the pin-lift branch below.
     */
    const far = -upSign;
    const owed = !atStop && (hive?.tipping ?? 0) > 0;
    if (owed && hive && !paceOff) paceSwing(body, theta, far, hiveSwingRateNow(hive, kindOf));
    if (!atStop) {
      engine.hiveHeld[a] = false;
      continue;
    }
    /**
     * THE PIN LIFTS WHEN THE PUBLISHED TABLE SAYS THE CELL TIPS -- read off the SAME `contents`
     * list `hud.ts` counts its "N MORE TO TIP" from, which is what makes the HUD's promise true
     * by construction rather than by calibration. See the header for the measurement that
     * retired the torque trigger.
     *
     * It is ONE TICK behind `derive.ts` (this runs inside `applyHiveTilt`, before the solve;
     * derive is stage 10) and that one tick is now the WHOLE registration delay. It used to be
     * far more: membership waited `BB3_REST_TICKS` of stillness on top of whatever the element's
     * own settling cost, measured at a mean of 95 ticks and a p90 of 205 from the tick its centre
     * entered the cell, so a volley that landed past threshold lifted the pin a second and a half
     * late and the owner reported it as the TIP being slow ("a significant amount of lengthened
     * tipping time due to the registration time", 2026-09-19). `derive.ts` counts on geometry now
     * -- see `BB3_CELL_SEAT_DEPTH` -- and the pin lifts the tick after the element is in.
     */
    if (hiveWillTip(load)) {
      /**
       * ⚠️ **THE BREAKAWAY HAS TO WAKE THE BODY, AND FORGETTING THAT LOOKS EXACTLY LIKE A TRAY
       * THAT WILL NOT TIP.** A pinned tray stops moving, so Rapier puts it to sleep — correctly:
       * a sleeping body is the whole reason a settled hive costs nothing per tick. But a sleeping
       * body is not integrated, so GRAVITY DOES NOT WAKE IT, and the elements resting on it are
       * asleep too and cannot nudge it. The detent then releases into total silence. Measured
       * before this line existed: every row of the load table, including 6 POLLEN + 2 NECTAR at
       * 28 % over the threshold, read NO TIP, and the damping bisection reported "never reached
       * the far stop" at every value from 0 to 60.
       */
      if (engine.hiveHeld[a]) {
        body.wakeUp();
        for (const id of world.biobuzz?.hives[a].contents ?? []) {
          const el = engine.elements.get(id);
          if (el) el.wakeUp();
        }
      }
      engine.hiveHeld[a] = false;
      /**
       * AND IT LEAVES THE STOP AT THE PACE TOO. The tray only counts as swinging (`tipping`) once
       * it is `BB3_HIVE_STOP_DEG` off its stop, and a threshold load is by construction the one
       * that BARELY out-weighs the tray, so the first degree was gravity's alone: measured 10 to
       * 24 ticks depending on packing, all of it dead time between "0 MORE TO TIP" and anything
       * moving. Only from the stop the swing LEAVES — at the far one the pin-lift is a NEW tip
       * starting, which `hiveDynamicTick` has not flipped `up` for yet.
       */
      if (hive && sign === upSign && !paceOff) paceSwing(body, theta, far, hiveSwingRateNow(hive, kindOf));
      continue;
    }
    engine.hiveHeld[a] = true;
    const target = stopAngle(sign);
    const pinned = body.angvel();
    if (Math.abs(theta - target) > 1e-6) body.setRotation(tiltQuatX(target), false);
    if (pinned.x !== 0 || pinned.y !== 0 || pinned.z !== 0) body.setAngvel({ x: 0, y: 0, z: 0 }, false);
  }
}

/**
 * Derive the shared HIVE bookkeeping from the joint — the dynamic twin of `hiveTimerStep`.
 *
 * `up`, `tipping`, `released` and `tips` are COMPATIBILITY VALUES here: the tray's real state is
 * one number, its angle, and everything downstream (`score.ts`'s TIP count, `hud.ts`, the 2D
 * renderer's `tipProjection`, `hiveTakingSide`) was written against the timer's vocabulary. So
 * this translates rather than duplicates:
 *
 *  · **the swing STARTS** when the tray has left its stop — the detent broke, which is the one
 *    event this function cannot see directly and does not need to.
 *  · **`tipping`** is the timer's own countdown solved backwards out of the live angle, so
 *    `tipProjection` draws the picture the tray is actually in rather than a replay of a
 *    nominal 4 s.
 *  · **`released`** latches when the bar passes LEVEL, which is where the contents leave — and
 *    they leave because the floor tilted out from under them, not because this said so.
 *  · **the TIP scores** when the far stop is reached and the bar has stopped moving
 *    (`BB3_HIVE_REST_W`): §10.5.1's "the damper that was not contacting the frame begins to
 *    contact it", which is exactly a stop with the swing spent.
 */
function hiveDynamicTick(world: World, engine: Engine3d): void {
  const bb = world.biobuzz;
  if (!bb) return;
  const kindOf = bbKindIndex(world);
  for (const a of ALLIANCES) {
    const hive = bb.hives[a];
    const theta = hive.angle ?? trayTilt(engine.hiveTrays[a]);
    const omega = hive.angVel ?? 0;
    const upSign = hive.up === 'north' ? 1 : -1;
    const settledAtFarStop = Math.abs(theta) >= STOP_RAD && Math.sign(theta) === -upSign && Math.abs(omega) < BB3_HIVE_REST_W;

    if (hive.tipping > 0) {
      /**
       * ⚠️ **A SWING THAT ENDS BACK ON ITS OWN STOP IS A SWING THAT FAILED, AND WITHOUT THIS THE
       * HIVE NEVER TIPS AGAIN** (owner, 2026-09-20: "people are still reporting hive not tipping
       * in some cases"). There was no failure path here at all: `tipping` and `released` could
       * only be cleared by reaching the FAR stop, so a tray that started over, passed level and
       * came back — which the load landing in the rising cell did, 5 times in 420 fuzzed volleys
       * (see `BB3_HIVE_SWING_EASE`: the swing is driven now, which is why it no longer happens that way) — sat on its own
       * stop with `released` latched TRUE for the rest of the match. `hiveTakingSide` then names
       * `otherSide(up)` forever, so `derive.ts` fills `contents` from the DOWN cell, the pin reads
       * the DOWN cell, and `hud.ts` prints the DOWN cell: the up cell can be filled to the brim
       * and nothing happens. A dead hive with a lying "N MORE TO TIP".
       *
       * The reset is unconditional on the load: a tray at rest on its own stop IS a settled tray,
       * whatever brought it back, so the honest state is `tipping: 0, released: false` — and if
       * the table still calls for a tip the pin lifts again on the very next tick and the swing
       * restarts from a clean state. It is a safety net for the general case (a jam, a reconnect
       * restoring a stale angle, a robot leaning on the tray) and not only for the reversal the
       * paced swing above now prevents.
       */
      if (Math.abs(theta) >= STOP_RAD && Math.sign(theta) === upSign && Math.abs(omega) < BB3_HIVE_REST_W) {
        bb.hives[a] = { ...settledHive(hive), tipping: 0, released: false };
        continue;
      }
      if (settledAtFarStop) {
        bb.hives[a] = {
          up: otherSide(hive.up),
          contents: hive.contents,
          tips: hive.tips + 1,
          tipping: 0,
          released: false,
          angle: hive.angle,
          angVel: hive.angVel,
        };
        bb.nectarDue[a] += 1;
        world.events.push(`${a.toUpperCase()} HIVE TIP`);
        continue;
      }
      const wasReleased = hive.released;
      const released = wasReleased || Math.sign(theta) !== upSign;
      if (released && !wasReleased) {
        // THE SPILL TAG'S OWN COUNT, not `contents.length`. Originally because membership waited
        // `BB3_REST_TICKS`, so a tray loaded past its threshold in one volley was already swinging
        // before anything had settled, `contents` read 0, and the event said "SPILLS 0" over eight
        // elements visibly leaving the cell. Membership is geometry now and `contents` would
        // usually agree — but the tag is still the honest number, because it is written from the
        // POSITION test at the breakaway and therefore also counts whatever was bouncing above
        // `BB3_CELL_SEAT_DEPTH` and is leaving with the rest. `|| contents.length` is the fallback
        // for a kinematic-tray world that never wrote a tag.
        const n = Object.values(bb.spill ?? {}).filter((x) => x === a).length;
        world.events.push(`${a.toUpperCase()} HIVE SPILLS ${n || hive.contents.length}`);
      }
      // the rate is read BEFORE `released` flips: on the release tick `contents` is still the
      // emptying cell (derive ran against last tick's hand-over), and from then on it latches
      const swingRate = hiveSwingRateNow(hive, kindOf);
      bb.hives[a] = { ...hive, tipping: tippingFromAngle(theta, upSign), released, swingRate };
      continue;
    }

    // settled. Has the detent broken? The tray leaving its stop is the only evidence there is.
    if (Math.abs(theta) < STOP_RAD) {
      /**
       * Every element in the cell is tagged NOW, at the top of the swing, rather than on the
       * tick each one crosses the lip: while it is still in the tray the only thing it touches
       * IS the tray, so `contacts3d.ts`'s "first NON-TRAY contact" rule gives the identical
       * answer from a rule that needs no per-element lip test. See `BiobuzzState.spill`.
       *
       * ⚠️ IT IS THE POSITION TEST, NOT `hive.contents`, and it stays that way. It was written
       * because membership used to need `BB3_REST_TICKS` of stillness, so a tray loaded past its
       * threshold in one volley started swinging before anything had settled and `contents` read
       * an empty set — measured on a staged 8-POLLEN tip that broke away on tick 2 with
       * `contents` still 0. That reason is gone (membership is geometry now,
       * `BB3_CELL_SEAT_DEPTH`), but the test is still the RIGHT one and is now strictly the wider
       * of the two: a spill is everything the cell is about to throw out, including whatever is
       * bouncing above the entry depth on the breakaway tick and has never been counted. What is
       * leaving is a question about position, so it is asked of position.
       */
      const spill = (bb.spill ??= {});
      for (const b of world.balls) {
        if (b.state.kind === 'held' || b.state.kind === 'stock') continue;
        const z = b.z + (b.r ?? BB_POLLEN_R);
        if (insideCell(b.pos.x, b.pos.y, z, a, 1, theta) || insideCell(b.pos.x, b.pos.y, z, a, -1, theta)) {
          spill[b.id] = a;
        }
      }
      bb.hives[a] = {
        ...hive,
        tipping: tippingFromAngle(theta, upSign),
        released: false,
        swingRate: hiveSwingRateNow({ ...hive, tipping: 0 }, kindOf),
      };
    }
  }
}

/** a hive with no swing in progress carries no `swingRate`, the same as the timer tray's (which
 * builds its settled state without one) — omitted rather than `undefined`, because a key holding
 * `undefined` is still a key to anything that walks the object. */
function settledHive(hive: BbHiveState): BbHiveState {
  const { swingRate: _drop, ...rest } = hive;
  return rest;
}

/** the timer's countdown that corresponds to a live angle — the inverse of `hiveTiltAngle`'s own
 * formula, so a 2D renderer reading `tipping` draws the tray where it really is. */
function tippingFromAngle(theta: number, upSign: number): number {
  const p = Math.min(1, Math.max(0, (1 - (upSign * theta) / REST_RAD) / 2));
  return Math.max(1e-4, BB_TIP_SWING_S * (1 - p));
}

/**
 * The shared TIP bookkeeping, run over whatever `derive.ts` has ALREADY written into
 * `hives[a].contents` this tick (physically-derived membership, not a capture event) --
 * `step3d.ts`'s gameplay stage calls this AFTER `derive.ts` and it must stay that way, or the
 * timer reads last tick's membership.
 *
 * Unlike the 2D `hiveStep`, this NEVER writes `contents`: physics owns it (via `derive.ts`).
 */
export function hive3dTick(world: World, dt: number): void {
  const bb = world.biobuzz;
  if (!bb) return;
  if (useHiveDynamic()) return; // the dynamic tray's bookkeeping runs in `hive3dJointTick`
  const kindOf = bbKindIndex(world);
  for (const a of ALLIANCES) {
    const hive = bb.hives[a];
    const contents = hive.contents; // this tick's DERIVED membership -- never overwritten below
    const r = hiveTimerStep(hive, dt, kindOf);
    bb.hives[a] = { ...r.hive, contents };
    if (r.releasing) {
      world.events.push(`${a.toUpperCase()} HIVE SPILLS ${contents.length}`);
    }
    if (r.tipped) {
      bb.nectarDue[a] += 1;
      world.events.push(`${a.toUpperCase()} HIVE TIP`);
    }
  }
}

/** the dynamic tray's own bookkeeping pass, called from `step3d.ts` in place of the timer. Split
 * from `hive3dTick` so each path reads as one function rather than as two branches. */
export function hive3dJointTick(world: World, engine: Engine3d): void {
  if (!useHiveDynamic()) return;
  hiveDynamicTick(world, engine);
}
