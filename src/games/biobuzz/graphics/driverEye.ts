/**
 * DRIVER EYE — a real person's eye, standing where the drive team actually stands (owner,
 * 2026-09-21: "make the driver camera be perfectly accurate to a person in real life looking
 * at the field... depending on their role or starting position, it should change where they
 * are standing slightly").
 *
 * Pure math, DOM-free, no `three` — same discipline `graphics/freeCam.ts` follows and for the
 * same reason: this is read by `src/ui/GraphicsSection.tsx` (an ordinary main-bundle screen)
 * as well as by the lazy 3D scene, and the RENDER lane asserts neither `three` nor `scene/` is
 * imported from anywhere under `graphics/`. Every angle goes through `dsin`/`dcos`/`datan2`
 * (`src/math.ts`) for the same reason `freeCam.ts`'s header gives: `scripts/smoke.ts`'s source
 * guard scans every non-`draw*`/`render*` file under `src/games` for bare engine trig.
 *
 * ── THE THREE NUMBERS ───────────────────────────────────────────────────────────────────────
 * 1. **Eye height** = the player's own height, less `EYE_VERTEX_OFFSET_IN` (the mean
 *    vertex-to-eye offset — the top of the head is not where the eyes are). APPROX; nobody's
 *    own offset is on file, so this is the anatomical average.
 * 2. **Where the eye stands** — `driverEyePoint` — reads it off `ALLIANCE_AREA`
 *    (`fieldDims.gen.ts`), the CAD-measured strip of gym floor outside the perimeter on the
 *    alliance's own side. `BB_WALL_T` (`config.ts`) is documented as an oversized PHYSICS
 *    collider, not real wall geometry, and the CAD carries no separate "outer face" figure for
 *    the wall itself — so the area's own field-side edge, which is exactly where the CAD's
 *    `ALLIANCE_AREA` strip starts, is the one line this sim has for "the wall" a driver stands
 *    behind. `STAND_BACK_IN` moves the eye that far again INTO the area, away from the field.
 * 3. **Which half of the wall** — TOP or BOTTOM, the role BIOBUZZ already tracks
 *    (`config.ts`'s `bbRoleLabel`) — shifts the eye a quarter of the area's own along-wall
 *    length off its centre, the reasoning being that a real second drive team stands beside the
 *    first rather than on top of it.
 *
 * ── WHY NO MIRRORING CODE APPEARS HERE ──────────────────────────────────────────────────────
 * `ALLIANCE_AREA` already carries red's and blue's rects separately (not one canonical rect a
 * caller mirrors), and `bbRoleLabel` already resolves TOP/BOTTOM per alliance so that the label
 * always means "world y > 0" for TOP and "world y < 0" for BOTTOM on EITHER side (worked through
 * in the header of `BB_START_POSES`, `config.ts`: a canonical `close`/`far` slot flips its own
 * label, not its own sign, when point-mirrored for red). So `driverEyePoint` only ever reads
 * `ALLIANCE_AREA[alliance]` and applies the SAME `role === 'TOP' ? +quarter : -quarter` rule for
 * both alliances — the point-symmetry is already baked into the input data, not re-derived here.
 * A consequence worth stating because a check relies on it: `driverEyePoint('red', 'TOP', h)` is
 * the FIELD-CENTRE POINT MIRROR of `driverEyePoint('blue', 'BOTTOM', h)`, and vice versa — TOP
 * mirrors to BOTTOM, not to TOP, because mirroring flips the y sign the role encodes.
 */

import type { Alliance } from '../../../types';
import { datan2, dcos, dsin, dtan, hyp } from '../../../math';
import { ALLIANCE_AREA, HIVE } from '../fieldDims.gen';

/** a plain field-inches point — no `Vec2`/`Vec3` import, this file has nothing else to share
 * that shape with. */
export interface Eye3 {
  x: number;
  y: number;
  z: number;
}

// ─────────────────────────────────────────────────────────────────────────────── the setting ──

/** the "Your height" field's own clamp — the owner's own envelope (48–84 in, 4 ft to 7 ft). */
export const DRIVER_HEIGHT_MIN_IN = 48;
export const DRIVER_HEIGHT_MAX_IN = 84;

/** mean vertex (top-of-head) to eye-level offset, in — APPROX, no per-player figure exists, so
 * this is the anatomical average an unmeasured population uses. */
export const EYE_VERTEX_OFFSET_IN = 4.5;

/** the driver the view stands in for when "Your height" is unset: 5 ft 8 in, an eye at 63.5 in,
 * the height every driver-eye check in the RENDER lane was written at. It replaces the old fit's
 * 62-in eye that the search raised to 72 to clear the 40-in collider wall. */
export const DRIVER_DEFAULT_HEIGHT_IN = 68;

/** eye height from a height setting already known to be in range — the one line step 2 of the
 * brief is. Callers that have not validated their input should go through
 * `coerceDriverHeightIn` first. */
export function eyeHeightFromPersonHeight(heightIn: number): number {
  return heightIn - EYE_VERTEX_OFFSET_IN;
}

/** cm ⇄ inches, for the UI's unit toggle — the STORED value is always inches. */
export const IN_PER_CM = 1 / 2.54;
export const inFromCm = (cm: number): number => cm * IN_PER_CM;
export const cmFromIn = (inches: number): number => inches / IN_PER_CM;
export const inFromFtIn = (feet: number, inches: number): number => feet * 12 + inches;
/** inverse of `inFromFtIn`, rounded to the nearest whole inch — the ft/in boxes have no decimal
 * place to show one. */
export function ftInFromIn(totalIn: number): { feet: number; inches: number } {
  const t = Math.max(0, Math.round(totalIn));
  return { feet: Math.floor(t / 12), inches: t % 12 };
}

function clampNum(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  if (v === Infinity) return hi;
  if (v === -Infinity) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * FIELD-BY-FIELD COERCION, the same discipline every other stored setting in this repo follows
 * (`graphics/settings.ts`'s own header). `null` is not junk here — it is the explicit "Clear"
 * affordance and the file's own "unset" state, and it passes through unclamped; anything else
 * that is not a finite number falls back to whatever was already stored (never silently to
 * `null`, which would look identical to a deliberate clear). Rounded to 0.1 in: a cm entry
 * converts to a non-integer, and the setting has no use for more precision than that.
 */
export function coerceDriverHeightIn(v: unknown, fallback: number | null): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.round(clampNum(v, DRIVER_HEIGHT_MIN_IN, DRIVER_HEIGHT_MAX_IN) * 10) / 10;
}

// ──────────────────────────────────────────────────────────────────────── where the eye stands ──

/** the role BIOBUZZ's start editor already assigns (`config.ts`'s `bbRoleLabel`) — TOP/BOTTOM
 * only; `'-'` (no locked role) is the caller's problem, not this file's, and is refused by
 * `driverEyePoint`'s own type. */
export type DriverRole = 'TOP' | 'BOTTOM';

/** how far back, in, the eye stands from the alliance area's own field-side edge — the owner's
 * own figure ("12 in back from the wall's OUTER face"). */
export const STAND_BACK_IN = 12;

/** what fraction of the alliance area's along-wall length separates the two drive teams from
 * the area's own centre — the owner's own figure ("a quarter... each way"). */
export const ROLE_ALONG_WALL_FRACTION = 0.25;

/**
 * The eye's field-absolute position for a driver of `heightIn` standing at `alliance`'s own
 * wall in the `role` half of it.
 *
 * `ALLIANCE_AREA[alliance]` is a rectangle whose SHORT axis (in this field, always x — both
 * alliance areas run along a perimeter wall that is a constant-x plane) crosses the wall the
 * driver stands behind, and whose LONG axis runs along it. Neither axis is assumed by name:
 * the field-side edge is whichever of `x0`/`x1` sits closer to the field centre (smaller
 * absolute value), and "away from the field" is the sign that increases that distance — which
 * is what lets this function ask nothing about which alliance is on which side of the origin.
 */
export function driverEyePoint(alliance: Alliance, role: DriverRole, heightIn: number): Eye3 {
  const area = ALLIANCE_AREA[alliance];
  const fieldSideX = Math.abs(area.x0) < Math.abs(area.x1) ? area.x0 : area.x1;
  const awaySign = Math.sign(fieldSideX) || 1; // moving further from x=0 is moving away from the field
  const eyeX = fieldSideX + awaySign * STAND_BACK_IN;

  const wallLen = area.y1 - area.y0;
  const wallCentreY = (area.y0 + area.y1) / 2;
  const roleSign = role === 'TOP' ? 1 : -1;
  const eyeY = wallCentreY + roleSign * wallLen * ROLE_ALONG_WALL_FRACTION;

  const clampedHeight = clampNum(heightIn, DRIVER_HEIGHT_MIN_IN, DRIVER_HEIGHT_MAX_IN);
  const eyeZ = eyeHeightFromPersonHeight(clampedHeight);

  return { x: eyeX, y: eyeY, z: eyeZ };
}

// ─────────────────────────────────────────────────────────────────────────────────── the aim ──

/** the floor-level point the aim blends TOWARD the local robot from — field centre, at ground
 * level. Not the robot's own average height: this is a fixed reference point the field itself
 * defines, so the blend is well-defined even before a robot has spawned. */
export const AIM_FIELD_CENTRE: Eye3 = { x: 0, y: 0, z: 0 };

/** how much of the aim point is pulled toward the local robot, 0 (ignore it, look at field
 * centre) .. 1 (look straight at it). An even split reads as "watching the match with one eye
 * on my own robot", which is the driver-station behaviour this camera is standing in for —
 * there is no measured figure for it, it is a named design choice rather than a literal. */
export const AIM_ROBOT_WEIGHT = 0.5;

export interface DriverEyeAim {
  /** world-frame heading, radians, `0` = +x, CCW positive — `Math.atan2` convention (via
   * `datan2`), NOT the `viewAngle`-relative `forwardOf` this file deliberately does not import. */
  yaw: number;
  /** DOWN from horizontal, radians — positive tilts the look direction toward the floor, the
   * same sign convention `scene/renderCameras.ts`'s `FitResult.pitch` already uses. */
  pitch: number;
}

/**
 * Yaw/pitch from a fixed `eye` toward a blend of field centre and `robot` (`null` when there is
 * no local robot to blend toward — the eye still looks at field centre, which is what "no local
 * robot ⇒ today's framing" degrades to if a caller ever reaches this path without one).
 */
export function driverEyeAim(eye: Eye3, robot: Eye3 | null): DriverEyeAim {
  const target = robot
    ? {
        x: AIM_FIELD_CENTRE.x + (robot.x - AIM_FIELD_CENTRE.x) * AIM_ROBOT_WEIGHT,
        y: AIM_FIELD_CENTRE.y + (robot.y - AIM_FIELD_CENTRE.y) * AIM_ROBOT_WEIGHT,
        z: AIM_FIELD_CENTRE.z + (robot.z - AIM_FIELD_CENTRE.z) * AIM_ROBOT_WEIGHT,
      }
    : AIM_FIELD_CENTRE;
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const yaw = datan2(dy, dx);
  const pitch = datan2(-dz, hyp(dx, dy));
  return { yaw, pitch };
}

// ──────────────────────────────────────────────────────────────────────────── the HIVE in view ──

/**
 * THE HIVE HAS TO BE IN THE PICTURE (owner, 2026-09-24: "keep in mind that the hive should be
 * fully visible ideally as a driver").
 *
 * The aim above looks at a blend of field centre and the driver's own robot, which is right for
 * a person, and from 5 ft of eye height it tilts the view far enough down that the top of the
 * HIVE (66 in, above eye level) left the frame whenever the robot was near its own wall. These are
 * the corners of the box both hives stand in: the trays' outer ends across the field, their
 * tipped ends along it, the floor to the top of a tipped tray. The driver shot (below) holds all
 * eight in its window at every robot position.
 */
const HIVE_HALF_X = HIVE.PIVOT_X + HIVE.CELL_W / 2;
const HIVE_HALF_Y = HIVE.CELL_FAR;
/** a tipped tray's highest point, APPROX — the same 66 `scene/renderCameras.ts` fits against */
const HIVE_TOP_Z = 66;
export const HIVE_VIEW_POINTS: readonly Eye3[] = (() => {
  const pts: Eye3[] = [];
  for (const x of [-HIVE_HALF_X, HIVE_HALF_X]) {
    for (const y of [-HIVE_HALF_Y, HIVE_HALF_Y]) {
      for (const z of [0, HIVE_TOP_Z]) pts.push({ x, y, z });
    }
  }
  return pts;
})();

/**
 * THE HIVE OPENINGS — the four corners of each UP-cell mouth, both hives, both ends of each tray
 * (either end can be up after a tip). A mouth is the cell's outer end face, `CELL_FAR` along the
 * bar from the pivot, across the cell's floor-to-top span; at the rest tilt its z runs
 * `HIVE.OPEN_Z`. These are what a driver aims a shot through, and the RENDER lane checks every one
 * of them is in every driver frame. They sit inside `HIVE_VIEW_POINTS`' box by construction.
 */
export const HIVE_MOUTH_POINTS: readonly Eye3[] = (() => {
  const t = (HIVE.TILT_DEG * Math.PI) / 180;
  const c = dcos(t);
  const s = dsin(t);
  const pts: Eye3[] = [];
  for (const px of [-HIVE.PIVOT_X, HIVE.PIVOT_X]) {
    for (const side of [-1, 1]) {
      for (const w of [HIVE.CELL_FLOOR_W, HIVE.CELL_TOP_W]) {
        // along the bar (up at the rest tilt) by CELL_FAR, then across it by w
        const y = side * (HIVE.CELL_FAR * c - w * s);
        const z = HIVE.PIVOT_Z + HIVE.CELL_FAR * s + w * c;
        for (const dx of [-HIVE.CELL_W / 2, HIVE.CELL_W / 2]) pts.push({ x: px + dx, y, z });
      }
    }
  }
  return pts;
})();

/** the whole field — floor and wall-top corners — and both hives: what the driver view holds.
 * `wallH` is the wall the player SEES (`WALL_H`, the CAD's top rail, 11.6 in), not the 40-in
 * physics collider: the collider's phantom top corners stood a few feet from the eye at nearly its
 * own height and were the single tightest constraint on the old fit. */
export function fieldViewPoints(halfX: number, halfY: number, wallH: number): Eye3[] {
  const pts: Eye3[] = [...HIVE_VIEW_POINTS];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      pts.push({ x: sx * halfX, y: sy * halfY, z: 0 });
      pts.push({ x: sx * halfX, y: sy * halfY, z: wallH });
    }
  }
  return pts;
}

// ─────────────────────────────────────────────────────────────────────────── THE DRIVER SHOT ──

/**
 * THE DRIVER VIEW: A STANDING DRIVER, LOOKING STRAIGHT ACROSS, THROUGH A SHIFTED LENS (owner,
 * 2026-11-04: "The driver POV is too wide and too far back. I do recognize that I said before to
 * move it back, but I think it is way too far back. There HAS to be a solution that shows both the
 * field and the hive contents in driver POV.")
 *
 * The rulings this has to keep: the near edge of the field in frame (2026-09-18), the hive fully
 * visible (2026-09-24), the whole field visible at all times (2026-09-24), and a view that is not
 * frozen (2026-09-24, "Not fixed driver view tho"). The view that held all four stepped the eye
 * 89 in behind the wall at the default 100° lens, so the field filled a tenth of a 16:9 screen.
 *
 * ── WHERE THE DISTANCE WENT ─────────────────────────────────────────────────────────────────
 * Measured on that view (16:9, 100°, a 68-in player), three things cost it, in this order:
 *  1. **A symmetric lens aimed by yaw and pitch.** A frustum centred on its own axis wastes
 *     everything the field does not fill on the far side of the axis: sky above the hive, and on a
 *     TOP/BOTTOM station (24 in off the wall's centre) the empty side of the frame. Yawing toward
 *     the field centre recovers some of that and tilts the near wall across the screen.
 *  2. **The 40-in wall.** The fit framed the PHYSICS collider's top corners (`BB3_WALL_H`), which
 *     stand a few feet from the eye at nearly its own height; the wall a player sees is 11.6 in.
 *  3. **20 % of the lens held back for turning toward the robot** (`EYE_TURN_SLACK` 0.2).
 *
 * ── WHAT THIS DOES INSTEAD ──────────────────────────────────────────────────────────────────
 *  · The eye is the player's height, at their station (`driverEyePoint`), facing STRAIGHT ACROSS
 *    the field, square to their wall, as a person at the wall does. The near wall reads level.
 *  · The PITCH is solved: the one (within `SHOT_PITCH_MIN`..`MAX`, a standing person's look down)
 *    at which the points need the smallest window on this screen shape.
 *  · The WINDOW is off-axis (a shift lens): its size is the player's lens for this screen
 *    (`vFovForScreen`: across the width on landscape, across the height on portrait), and it is
 *    placed over whatever part of the image plane the field and hives occupy. Nothing is spent on
 *    sky or on the empty side, and nothing is widened past the player's setting.
 *  · The eye steps STRAIGHT BACK from the wall only as far as the window needs to hold every
 *    point, with `SHOT_MARGIN` to spare and `EYE_TURN_SLACK` (6 %) of room left for following.
 *  · FOLLOWING the robot slides the window inside that room (`driverShotWindow`), a clamp that is
 *    continuous in the robot's position (the 2026-09-24 "choppy" lesson), never a projection test.
 *
 * Result at the default 100°, 68-in player: 89 → 42 in behind the wall at 16:9, the field filling
 * 2.5× the screen it did. Pure math, `three`-free, engine trig only through `src/math.ts`.
 */

/** a standing person's look down at the field, radians: the pitch search's range. Beyond 45° the
 * keystone on the hive's uprights reads as a fish tank; the frame never needs below 5°. */
export const SHOT_PITCH_MIN = (5 * Math.PI) / 180;
export const SHOT_PITCH_MAX = (45 * Math.PI) / 180;
/** every point lands this fraction of the window inside its edge (the old fit's 4 %) */
export const SHOT_MARGIN = 0.04;
/** the share of the window left over for following the robot — see the header (was 0.2) */
export const EYE_TURN_SLACK = 0.06;
/** the furthest the search will step the eye back from its station, in */
const SHOT_BACK_MAX = 480;

/** the camera's basis for a horizontal facing `fwd` (unit) pitched DOWN by `pitch` — the same
 * basis `THREE.Object3D.lookAt` builds with world up +z: `f` forward, `r` = f × up, `u` = r × f */
function shotBasis(fwd: { x: number; y: number }, pitch: number) {
  const cp = dcos(pitch);
  const sp = dsin(pitch);
  return {
    f: { x: fwd.x * cp, y: fwd.y * cp, z: -sp },
    r: { x: fwd.y, y: -fwd.x, z: 0 },
    u: { x: fwd.x * sp, y: fwd.y * sp, z: cp },
  };
}

/** the box the points occupy on the image plane at unit depth (`u` right, `v` up), or null when
 * one of them is not in front of the eye */
export interface ShotBox {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}
function shotBox(eye: Eye3, fwd: { x: number; y: number }, pitch: number, points: readonly Eye3[]): ShotBox | null {
  const { f, r, u } = shotBasis(fwd, pitch);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of points) {
    const dx = p.x - eye.x;
    const dy = p.y - eye.y;
    const dz = p.z - eye.z;
    const zc = dx * f.x + dy * f.y + dz * f.z;
    if (!(zc > 1)) return null;
    const pu = (dx * r.x + dy * r.y) / zc;
    const pv = (dx * u.x + dy * u.y + dz * u.z) / zc;
    if (pu < u0) u0 = pu;
    if (pu > u1) u1 = pu;
    if (pv < v0) v0 = pv;
    if (pv > v1) v1 = pv;
  }
  return { u0, u1, v0, v1 };
}

/** the window height (tan space) a box needs on a screen of `aspect`: its height, or its width
 * over the aspect, whichever binds */
function boxNeed(b: ShotBox, aspect: number): number {
  return Math.max(b.v1 - b.v0, (b.u1 - b.u0) / aspect);
}

/** the pitch at which the points need the smallest window: a 1° scan, then a golden-section
 * refinement inside the best bracket. The need is smooth and single-troughed in pitch over this
 * range for any eye outside the field (it is the larger of two spans, each convex in pitch). */
function bestPitch(eye: Eye3, fwd: { x: number; y: number }, points: readonly Eye3[], aspect: number): { pitch: number; box: ShotBox } | null {
  const step = Math.PI / 180;
  let best = -1;
  let bestNeed = Infinity;
  const n = Math.round((SHOT_PITCH_MAX - SHOT_PITCH_MIN) / step);
  for (let i = 0; i <= n; i++) {
    const b = shotBox(eye, fwd, SHOT_PITCH_MIN + i * step, points);
    const need = b ? boxNeed(b, aspect) : Infinity;
    if (need < bestNeed) {
      bestNeed = need;
      best = i;
    }
  }
  if (best < 0) return null;
  let lo = SHOT_PITCH_MIN + Math.max(0, best - 1) * step;
  let hi = SHOT_PITCH_MIN + Math.min(n, best + 1) * step;
  const needAt = (p: number): number => {
    const b = shotBox(eye, fwd, p, points);
    return b ? boxNeed(b, aspect) : Infinity;
  };
  const g = (Math.sqrt(5) - 1) / 2;
  let a = hi - g * (hi - lo);
  let c = lo + g * (hi - lo);
  let fa = needAt(a);
  let fc = needAt(c);
  for (let i = 0; i < 24; i++) {
    if (fa <= fc) {
      hi = c;
      c = a;
      fc = fa;
      a = hi - g * (hi - lo);
      fa = needAt(a);
    } else {
      lo = a;
      a = c;
      fa = fc;
      c = lo + g * (hi - lo);
      fc = needAt(c);
    }
  }
  const pitch = (lo + hi) / 2;
  const box = shotBox(eye, fwd, pitch, points);
  return box ? { pitch, box } : null;
}

export interface DriverShot {
  /** where the eye stands */
  eye: Eye3;
  /** the horizontal unit direction it faces: straight across the field from its wall */
  fwd: { x: number; y: number };
  /** DOWN from horizontal, radians */
  pitch: number;
  /** what the points occupy on the image plane at unit depth (`u` right, `v` up) */
  box: ShotBox;
  /** the window: the player's lens on this screen, width and height on the same plane */
  w: number;
  h: number;
  /** how much further back than the station the eye had to stand, in (0 when it fits there) */
  extraBack: number;
}

/**
 * SOLVE THE SHOT from a station `at` facing `fwd`, for a screen of `aspect` and a lens of vertical
 * angle `lensV` (radians, already converted for this screen). The eye keeps its height and its
 * place along the wall and only steps back along `-fwd`, by bisection: further back only ever
 * needs a smaller window.
 */
export function fitDriverShot(
  at: Eye3,
  fwd: { x: number; y: number },
  points: readonly Eye3[],
  aspect: number,
  lensV: number,
): DriverShot {
  const h = 2 * dtan(lensV / 2);
  const w = h * aspect;
  const room = (1 - SHOT_MARGIN) * (1 - EYE_TURN_SLACK);
  const eyeAt = (back: number): Eye3 => ({ x: at.x - fwd.x * back, y: at.y - fwd.y * back, z: at.z });
  const fits = (back: number): boolean => {
    const s = bestPitch(eyeAt(back), fwd, points, aspect);
    return !!s && s.box.v1 - s.box.v0 <= h * room && s.box.u1 - s.box.u0 <= w * room;
  };
  let back = 0;
  if (!fits(0)) {
    let lo = 0;
    let hi = SHOT_BACK_MAX;
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2;
      if (fits(m)) hi = m;
      else lo = m;
    }
    back = hi;
  }
  const eye = eyeAt(back);
  const s = bestPitch(eye, fwd, points, aspect);
  const pitch = s ? s.pitch : SHOT_PITCH_MIN;
  const box = s ? s.box : { u0: -w / 2, u1: w / 2, v0: -h / 2, v1: h / 2 };
  return { eye, fwd: { x: fwd.x, y: fwd.y }, pitch, box, w, h, extraBack: back };
}

/** one point on the shot's image plane at unit depth, or null behind the eye */
export function shotProject(shot: DriverShot, p: Eye3): { u: number; v: number } | null {
  const { f, r, u } = shotBasis(shot.fwd, shot.pitch);
  const dx = p.x - shot.eye.x;
  const dy = p.y - shot.eye.y;
  const dz = p.z - shot.eye.z;
  const zc = dx * f.x + dy * f.y + dz * f.z;
  if (!(zc > 1e-6)) return null;
  return { u: (dx * r.x + dy * r.y) / zc, v: (dx * u.x + dy * u.y + dz * u.z) / zc };
}

/** the window's centre on the image plane (`cu` right, `cv` up) */
export interface ShotWindow {
  cu: number;
  cv: number;
}

/**
 * WHERE THE WINDOW SITS THIS FRAME: over the field, slid toward the robot (`driverEyeAim`'s blend
 * of field centre and robot, as the old view turned toward it) as far as keeps every point
 * `SHOT_MARGIN` inside the window, and no further.
 *
 * ⚠️ **A CLAMP, NOT A TEST** (the 2026-09-24 "extremely choppy" report): every step is continuous
 * in the robot's position. A range that is empty (a window that only just holds the box) is its
 * midpoint, where the clamp was heading anyway.
 */
export function driverShotWindow(shot: DriverShot, robot: Eye3 | null): ShotWindow {
  const b = shot.box;
  let cu = (b.u0 + b.u1) / 2;
  let cv = (b.v0 + b.v1) / 2;
  if (robot) {
    const aim = {
      x: AIM_FIELD_CENTRE.x + (robot.x - AIM_FIELD_CENTRE.x) * AIM_ROBOT_WEIGHT,
      y: AIM_FIELD_CENTRE.y + (robot.y - AIM_FIELD_CENTRE.y) * AIM_ROBOT_WEIGHT,
      z: AIM_FIELD_CENTRE.z + (robot.z - AIM_FIELD_CENTRE.z) * AIM_ROBOT_WEIGHT,
    };
    const p = shotProject(shot, aim);
    const o = shotProject(shot, AIM_FIELD_CENTRE);
    if (p && o) {
      cu += p.u - o.u;
      cv += p.v - o.v;
    }
  }
  const hw = (shot.w / 2) * (1 - SHOT_MARGIN);
  const hh = (shot.h / 2) * (1 - SHOT_MARGIN);
  return { cu: clampOrCentre(cu, b.u1 - hw, b.u0 + hw), cv: clampOrCentre(cv, b.v1 - hh, b.v0 + hh) };
}

/** is every point inside the window at `win` (with `margin` of it to spare)? The checks' own
 * reading of a shot, independent of the camera that draws it. */
export function shotHolds(shot: DriverShot, win: ShotWindow, points: readonly Eye3[], margin = 0): boolean {
  const hw = (shot.w / 2) * (1 - margin);
  const hh = (shot.h / 2) * (1 - margin);
  for (const p of points) {
    const q = shotProject(shot, p);
    if (!q) return false;
    if (Math.abs(q.u - win.cu) > hw + 1e-9 || Math.abs(q.v - win.cv) > hh + 1e-9) return false;
  }
  return true;
}

/** `v` clamped into [lo, hi]; an empty range (lo > hi) is its midpoint — continuous either way */
function clampOrCentre(v: number, lo: number, hi: number): number {
  return lo <= hi ? Math.min(hi, Math.max(lo, v)) : (lo + hi) / 2;
}
