import * as THREE from 'three';
import type { SceneCamera, SceneFrame } from '../../module';
import type { Alliance, RobotState, World } from '../../../types';
import { wrapAngle } from '../../../math';
import { BB3_WALL_H, BB_HALF_X, BB_HALF_Y, BB_HIVE_X, BB_VIEW_MARGIN, bbRoleLabel } from '../config';
import {
  defaultFreeCam,
  dollyFreeCam,
  dollyFreeCamToward,
  freeCamOrbitDelta,
  freeCamPanGain,
  freeCamPose,
  freeCamWheelSign,
  FREE_CAM_DIST_MIN,
  FREE_CAM_NAV_DEFAULT,
  orbitFreeCam,
  panFreeCam,
  type FreeCamNav,
  type FreeCamState,
} from '../graphics/freeCam';
import { driverEyeFollow, fieldViewPoints, fitDriverEyeFrame, type DriverEyeFrame, type DriverRole } from '../graphics/driverEye';
import { vFovFromH } from '../graphics/fov';
import { GFX_FOV_DEFAULT, GFX_FOV_MAX, GFX_FOV_MIN } from '../graphics/settings';

/**
 * BIOBUZZ 3D SCENE — cameras (Day 1, `docs/biobuzz/plan-3d.md` §4.3, §13.1).
 *
 * Coordinates throughout `scene/`: field INCHES, z UP (x right, y up-field, z up) — there is no
 * axis conversion anywhere in this directory. Every camera's `up` is (0,0,1).
 *
 * Both cameras are driven ENTIRELY by `frame.viewAngle`, the same angle the shared 2D camera
 * (`src/render/camera.ts`'s `Camera.worldToScreen`) rotates the world by so a driver's own wall
 * reads at the bottom of the screen: `rot(p, viewAngle)` then a y-flip, `screenUpWorld()` =
 * `rot({x:0,y:1}, -viewAngle)`. Re-deriving "which wall does this alliance's driver stand at"
 * from `frame.localRobotId`'s alliance would have to agree with that rotation anyway (BIOBUZZ's
 * 2D field renders under the exact same `Camera`), so this file takes the angle as its one input
 * and never looks up a robot — see `renderScene.ts`'s header for the consequence: a caller that
 * ever wants a viewAngle that is not a clean per-alliance one (a free spectator orbit, say) has
 * nowhere to plug that into a `SceneFrame` today. Noted as a gotcha for the integration lane.
 */

/** unit world-space (x,y) direction "into the field" for a given screen orientation — inlined
 * copy of `Camera.screenUpWorld()`'s `rot({x:0,y:1}, -viewAngle)` (standard CCW rotation), so
 * this file needs no import from the 2D camera (which is built around a canvas context this
 * scene does not have). */
function forwardOf(viewAngle: number): { x: number; y: number } {
  const theta = -viewAngle;
  return { x: -Math.sin(theta), y: Math.cos(theta) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// DRIVER CAMERA FIT (issue 4, 2026-09-18 playtest: "driver POV is not showing the close edge of
// the field; make sure the whole field is visible"). The Day 1 camera used a FIXED eye height,
// setback and FOV (62 / 12 / 70) and simply `lookAt` the field centre — nothing checked that the
// near edge (the wall right behind the robot, and the floor in front of it) actually landed
// inside the frustum, and at a 12-in setback it does not: the near corners of the field sit only
// a foot or so in front of the eye but 72+ in off to the side, which is a near-90° angle off the
// forward axis. `fitDriverCamera` SOLVES for a pitch + vertical FOV (and, when the geometry
// demands it, a taller eye and/or a bigger setback) that gets every corner inside the frame,
// instead of guessing a constant and hoping.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** driver eye height, in — the STARTING point of the search (a stand-height view "keeps the
 * driver feel," owner brief). Raised toward `DRIVER_EYE_H_MAX` first, before the setback is ever
 * touched, because moving the eye up costs nothing gameplay-wise and a taller eye alone is often
 * enough at a wide-enough aspect (see the report: 21:9 fits at the DEFAULT setback once the eye
 * is raised, no setback change needed at all). */
const DRIVER_EYE_H_DEFAULT = 62;
/** plan-3d.md §4.3's own range for the eye-height key (`i`/`o`) — the search never leaves it. */
const DRIVER_EYE_H_MIN = 44;
const DRIVER_EYE_H_MAX = 72;
// The FIT itself never reaches the lower bound (it only ever raises the eye above
// `DRIVER_EYE_H_DEFAULT`); the `i`/`o` NUDGE does, which is what the range was always documenting
// — `clampEye` is where both ends of it now bind.
/** clamp a driver eye height into plan §4.3's own 44–72 envelope. */
function clampEye(h: number): number {
  return Math.max(DRIVER_EYE_H_MIN, Math.min(DRIVER_EYE_H_MAX, h));
}
/** how far outside the field wall the driver's eye starts, in — the plan doc's original figure.
 * Kept as the default for a wide-enough aspect (16:9 and wider commonly fit here once the eye is
 * raised); a narrower aspect (4:3, portrait, a phone) needs more room and the search grows this,
 * never shrinks it below the default. */
const DRIVER_SETBACK_DEFAULT = 12;
/** the search's own ceiling — a generous "stagecraft" cap (20 ft) so a pathological aspect (a
 * folded phone, near-square) cannot spin the binary search forever chasing an unreachable fit;
 * past this, the fit reports its best effort rather than an ever-growing setback. Every aspect
 * this scene is actually tested at (16:9, 4:3, 9:16, a real phone's ~390:844) resolves well
 * inside this cap — see the report's measured setbacks. */
const DRIVER_SETBACK_MAX = 240;
/** vertical FOV bounds, degrees — plan-3d.md §4.3/§4.4's own range for this camera. */
const DRIVER_FOV_MIN = 60;
const DRIVER_FOV_MAX = 95;
/** the frame margin every fitted point must clear, as a fraction of the half-FOV — "a 4% margin"
 * (the brief), so a corner lands just inside the edge rather than exactly on it (where a rounding
 * error or a resize mid-frame could clip it). */
const DRIVER_MARGIN = 0.04;

const FOV_MIN_RAD = (DRIVER_FOV_MIN * Math.PI) / 180;
const FOV_MAX_RAD = (DRIVER_FOV_MAX * Math.PI) / 180;

// ─────────────────────────────────────────────────────────── graphics-settings tuning (Day 3) ──
//
// Two of §4.4's sixteen settings — FIELD OF VIEW and CAMERA MOTION — are camera properties, and
// this is where they land. MODULE scope rather than per-`createCameras`, because they are a
// property of the DEVICE (the preference store is per device) and because the alternative is
// threading a settings object through `solveFit`, whose whole design is a cache keyed on two
// raw numbers. A page with two live scenes (the gallery) shares them, which is correct: they are
// one player's preference, not one scene's.
//
// FOV is a CEILING on the driver camera and an exact value on chase and orbit, and that
// asymmetry is deliberate. The driver camera SOLVES its FOV from the fit (`fitDriverCamera`) so
// the whole field is in frame from the alliance wall; forcing 60° there would crop the far
// corners off, which is not a preference, it is a broken shot. So a smaller number pulls the eye
// BACK (the fit's own second lever) instead of narrowing the lens, and the setting reads as
// "how wide a lens will you allow" — which is what it is.

/**
 * The player's FOV setting, HORIZONTAL degrees (`graphics/fov.ts`), or `null` before any has been
 * applied — the fit then keeps its own hard maximum and chase/orbit their old fixed values, so a
 * build that never touches the setting behaves exactly as it did.
 */
let tunedHfovDeg: number | null = null;

/** the driver fit's VERTICAL ceiling on a screen of `aspect`, radians. Never above the fit's own
 * hard maximum; allowed BELOW its minimum, because on an ultrawide screen a human-width view is
 * a narrow vertical one, and the fit's other lever (stepping the eye back) is what then frames
 * the field. */
function fovCapRad(aspect: number): number {
  if (tunedHfovDeg == null) return FOV_MAX_RAD;
  return Math.min(FOV_MAX_RAD, (vFovFromH(tunedHfovDeg, aspect) * Math.PI) / 180);
}
/** the chase camera's vertical FOV, degrees — the slider exactly, for this screen */
function chaseFovDeg(aspect: number): number {
  return tunedHfovDeg == null ? 68 : vFovFromH(tunedHfovDeg, aspect);
}
/** orbit and free cam: a framing shot, so the tighter of the two, as before */
function orbitFovDeg(aspect: number): number {
  return tunedHfovDeg == null ? 55 : Math.max(DRIVER_FOV_MIN - 15, vFovFromH(tunedHfovDeg, aspect) - 15);
}
/** the height-accurate driver eye's vertical FOV, degrees — the slider exactly, for this screen */
function driverEyeFovDeg(aspect: number): number {
  return Math.min(DRIVER_FOV_MAX, vFovFromH(tunedHfovDeg ?? GFX_FOV_DEFAULT, aspect));
}
/** the player's own "reduced" pick, OR-ed with `prefers-reduced-motion` (which always wins). */
let tunedReducedMotion = false;
/** "Your height" (owner, 2026-09-21) — per-device, `null` = unset. Set by `renderScene.ts` on
 * every settings change, same as the tuning above; read only by `updateDriver`, which falls
 * straight back to the solved fit below when this is `null` or there is no local robot to
 * stand a driver behind. See `graphics/driverEye.ts` for the placement math. */
let tunedDriverHeightIn: number | null = null;

/**
 * Apply §4.4's two camera rows. Called by `renderScene.ts` on every settings change; cheap
 * enough to call every time rather than diffing, and it invalidates the driver fit's cache so
 * the next frame re-solves against the new ceiling.
 */
export function setCameraTuning(hfovDeg: number | null, motion: 'full' | 'reduced'): void {
  // `null` is "never set" — the state a fresh module starts in, which a test restores
  tunedHfovDeg = hfovDeg == null ? null : Math.min(GFX_FOV_MAX, Math.max(GFX_FOV_MIN, hfovDeg));
  tunedReducedMotion = motion === 'reduced';
  cachedAspect = NaN; // force `fitDriverCamera` to re-solve against the new ceiling
}

/** apply "Your height" (`graphics/driverEye.ts`'s per-device setting). Called by
 * `renderScene.ts` beside `setCameraTuning`; `null` reverts the driver camera to the solved fit
 * exactly as it behaved before this setting existed. */
export function setDriverHeightIn(heightIn: number | null): void {
  tunedDriverHeightIn = heightIn;
}

/** the tray's own peak height during a tip, APPROX — the manual's up-cell opening tops out at
 * `BB_HIVE_OPEN_Z[1]` (65.6), and the brief's own figure for "the hive tops" is "z ≈ 66"; this is
 * that same APPROX carried as a named constant rather than a bare literal in the point list
 * below. Not `BB3_HIVE_PIVOT_Z` (43.95, the HINGE, not the tray's highest point). */
const HIVE_TOP_Z_APPROX = 66;

/** every point the driver camera's frustum must contain, in field-absolute inches — the four
 * ground corners, the four wall-top corners (near AND far; the brief calls out the near wall by
 * name, but nothing distinguishes "near" from "far" analytically here, so both are fitted and
 * whichever the camera actually stands behind is automatically the tighter constraint), and the
 * two hive tops. Built ONCE at module load — this is field geometry, not per-frame state. */
interface FitPoint {
  x: number;
  y: number;
  z: number;
}
/** how fast the height-accurate driver view turns toward the robot — a head turn, not a snap */
const EYE_FOLLOW_HALFLIFE = 0.18; // s
/** what the height-accurate driver view frames: the whole field and both hives (`fieldViewPoints`) */
const EYE_FIT_POINTS = fieldViewPoints(BB_HALF_X, BB_HALF_Y, BB3_WALL_H);
const FIT_POINTS: readonly FitPoint[] = (() => {
  const pts: FitPoint[] = [];
  for (const sx of [1, -1] as const) {
    for (const sy of [1, -1] as const) {
      pts.push({ x: sx * BB_HALF_X, y: sy * BB_HALF_Y, z: 0 });
      pts.push({ x: sx * BB_HALF_X, y: sy * BB_HALF_Y, z: BB3_WALL_H });
    }
  }
  pts.push({ x: BB_HIVE_X, y: 0, z: HIVE_TOP_Z_APPROX });
  pts.push({ x: -BB_HIVE_X, y: 0, z: HIVE_TOP_Z_APPROX });
  return pts;
})();

interface FitResult {
  /** pitch DOWN from horizontal, radians — positive tilts the look direction toward the floor. */
  pitch: number;
  /** the vertical FOV this pitch needs to clear every `FIT_POINTS` entry at `DRIVER_MARGIN`,
   * BEFORE clamping to `[DRIVER_FOV_MIN, DRIVER_FOV_MAX]` — the caller clamps and, separately,
   * uses the unclamped value to decide whether the search must keep growing the setback. */
  vFov: number;
  /** true iff `vFov <= DRIVER_FOV_MAX` (in radians) AND every point is genuinely in front of the
   * camera (a pathological eye position — inside the field, say — could put a point behind it,
   * where an angle comparison alone would falsely read as "fits"). */
  fits: boolean;
}

/**
 * Solve the pitch and required vertical FOV for one candidate (eye height, setback, aspect).
 *
 * THE MATH, ONE PARAGRAPH. Build the camera's UN-PITCHED basis at the given yaw: forward `F0`
 * (horizontal, `forwardOf(viewAngle)`), up `Z = (0,0,1)`, right `R = F0 × Z`... — actually `R`
 * is built directly as `(F0.y, -F0.x)` (equivalent, no `Z` needed since both are horizontal/
 * vertical respectively). For any point, its offset from the eye decomposes as `x0` (along `R`,
 * UNCHANGED by pitch), `y0` (along world `Z`) and `z0` (along `F0`) — and pitching the camera
 * down by `θ` about `R` is EXACTLY a 2D rotation of `(z0, y0)` by `θ`: `zc = z0·cosθ − y0·sinθ`,
 * `yc = z0·sinθ + y0·cosθ`, `xc = x0`. So a point's ELEVATION angle `atan2(yc, zc)` is simply
 * `atan2(y0, z0) + θ` for every point — independent of `xc` — which means the pitch that
 * CENTRES the vertical spread (and so minimises the vertical FOV the fit needs) is a closed
 * form: `θ = −(βMin + βMax) / 2` where `β = atan2(y0, z0)` is each point's UN-PITCHED elevation.
 * The vertical FOV that clears the centred spread, and the horizontal FOV that clears the widest
 * `|xc/zc|` at the given `aspect` (via `hFov = 2·atan(tan(vFov/2)·aspect)`, so `vFov` is solved
 * for from the horizontal requirement too), both fold `DRIVER_MARGIN` in as a shrink on the
 * available half-angle, matching "a 4% margin" — a bigger REQUIRED fov, not a smaller one, is
 * what leaves room for the margin.
 */
function solveFit(eyeH: number, setback: number, aspect: number, viewAngle: number): FitResult {
  const fwd = forwardOf(viewAngle);
  const eyeDist = BB_HALF_X + setback; // the field is square — see `updateDriver`'s own note
  const eyeX = -fwd.x * eyeDist;
  const eyeY = -fwd.y * eyeDist;
  const rx = fwd.y;
  const ry = -fwd.x;

  let betaMin = Infinity;
  let betaMax = -Infinity;
  // pass 1: the UN-PITCHED elevation of every point, to solve the centring pitch.
  const z0s: number[] = new Array(FIT_POINTS.length);
  const y0s: number[] = new Array(FIT_POINTS.length);
  const x0s: number[] = new Array(FIT_POINTS.length);
  for (let i = 0; i < FIT_POINTS.length; i++) {
    const p = FIT_POINTS[i];
    const vx = p.x - eyeX;
    const vy = p.y - eyeY;
    const z0 = vx * fwd.x + vy * fwd.y;
    const y0 = p.z - eyeH;
    const x0 = vx * rx + vy * ry;
    z0s[i] = z0;
    y0s[i] = y0;
    x0s[i] = x0;
    const beta = Math.atan2(y0, z0);
    if (beta < betaMin) betaMin = beta;
    if (beta > betaMax) betaMax = beta;
  }
  const pitch = -(betaMin + betaMax) / 2;
  const marginScale = 1 - DRIVER_MARGIN;

  const vertHalf = Math.max(Math.abs(betaMin + pitch), Math.abs(betaMax + pitch));
  const vFovForVertical = (2 * vertHalf) / marginScale;

  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  let maxHorizRatio = 0;
  let minZc = Infinity;
  for (let i = 0; i < FIT_POINTS.length; i++) {
    const zc = z0s[i] * cosP - y0s[i] * sinP;
    if (zc < minZc) minZc = zc;
    const ratio = zc > 1e-6 ? Math.abs(x0s[i]) / zc : Infinity;
    if (ratio > maxHorizRatio) maxHorizRatio = ratio;
  }
  const vFovForHorizontal = 2 * Math.atan(maxHorizRatio / (aspect * marginScale));

  const vFov = Math.max(vFovForVertical, vFovForHorizontal);
  const fits = vFov <= fovCapRad(aspect) + 1e-9 && minZc > 1e-3 && Number.isFinite(vFov);
  return { pitch, vFov, fits };
}

export interface DriverFit {
  eyeH: number;
  setback: number;
  pitch: number;
  vFov: number;
}

/**
 * `fitDriverCamera(alliance, viewAngle, aspect)` — the eye sits behind the ALLIANCE wall centre
 * (the `alliance` the contract names), but the fit itself only ever needs `viewAngle`: the field
 * is square and every `FIT_POINTS` entry is field-absolute, so "which wall" is already fully
 * carried by the yaw `forwardOf(viewAngle)` resolves to (see `updateDriver`'s own comment on the
 * square-field shortcut this already relied on). `alliance` is kept in the signature per the
 * contract — and for a future asymmetric-field revision where it would stop being redundant —
 * but is not read here.
 *
 * THE SEARCH (the brief's own order): try the default eye height and setback; if that overshoots
 * `DRIVER_FOV_MAX`, raise the eye to `DRIVER_EYE_H_MAX` (free — no gameplay cost, and often
 * enough on its own for a wide-enough aspect); if it STILL overshoots, binary-search the setback
 * upward (monotonic: a bigger setback only ever shrinks the required FOV, so bisection is exact)
 * up to `DRIVER_SETBACK_MAX`, and use the best the search reaches even if that cap itself cannot
 * fit (reported as `!fits`, never thrown — a slightly-cropped corner beats a broken camera).
 *
 * `aspect` IS THE SAFE RECT'S, not the canvas's (see the safe-rect block below `DriverFit`): the
 * field has to fit the part of the viewport the HUD does not cover, so every number this returns
 * is solved against that, and the canvas is then rendered as a wider window onto it.
 *
 * CACHED, not recomputed every frame: `updateDriver` calls this once per render, but the search
 * only has to re-run when `viewAngle` or `aspect` actually changes (an alliance switch, a
 * resize, a HUD band appearing) — the common case (same match, same window) is two `!==`
 * comparisons against the raw numbers (no string key, no allocation at all), which is what
 * keeps this a zero-per-frame-
 * allocation camera despite the search itself allocating a small scratch array per solve.
 */
let cachedViewAngle = NaN;
let cachedAspect = NaN;
const cached: DriverFit = { eyeH: DRIVER_EYE_H_DEFAULT, setback: DRIVER_SETBACK_DEFAULT, pitch: 0, vFov: FOV_MAX_RAD };

export function fitDriverCamera(_alliance: Alliance, viewAngle: number, aspect: number): DriverFit {
  if (viewAngle === cachedViewAngle && aspect === cachedAspect) return cached;
  cachedViewAngle = viewAngle;
  cachedAspect = aspect;

  let eyeH = DRIVER_EYE_H_DEFAULT;
  let setback = DRIVER_SETBACK_DEFAULT;
  let r = solveFit(eyeH, setback, aspect, viewAngle);

  if (!r.fits) {
    eyeH = DRIVER_EYE_H_MAX;
    r = solveFit(eyeH, setback, aspect, viewAngle);
  }

  if (!r.fits) {
    const atCap = solveFit(eyeH, DRIVER_SETBACK_MAX, aspect, viewAngle);
    if (atCap.fits) {
      let lo = setback;
      let hi = DRIVER_SETBACK_MAX;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (solveFit(eyeH, mid, aspect, viewAngle).fits) hi = mid;
        else lo = mid;
      }
      setback = hi;
    } else {
      setback = DRIVER_SETBACK_MAX; // best effort — see this function's own header
    }
    r = solveFit(eyeH, setback, aspect, viewAngle);
  }

  const vFov = Math.min(fovCapRad(aspect), Math.max(FOV_MIN_RAD, r.vFov));
  cached.eyeH = eyeH;
  cached.setback = setback;
  cached.pitch = r.pitch;
  cached.vFov = vFov;
  return cached;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SAFE RECT (owner's re-test, 2026-09-18: "make sure that the scoreboard and the field can
// both fit in the screen without overlap"). The WebGL canvas fills the whole `.game-viewport`,
// and the score bar, the breakdown chips and the status/menu clusters are absolutely positioned
// ON TOP of it — so a camera fitted to the canvas puts part of the field under chrome that hides
// it. `SceneFrame.insets` (measured off the live DOM by `GameController.refreshHudInsets`) says
// how much of each edge is spoken for; the field is fitted to what is LEFT.
//
// THE TRICK IS `setViewOffset`, not a smaller viewport. Rendering into a sub-viewport would
// leave the HUD sitting on empty backdrop and waste the pixels behind it; instead the camera
// solves for a VIRTUAL IMAGE the size of the safe rect, and then renders a WINDOW onto that
// virtual image which is the whole canvas — offset so the safe rect lands exactly under the
// uncovered area. The field fills the safe rect; what spills past it is the parts of the scene
// that were always going to be behind the HUD anyway (backdrop, the near floor), drawn rather
// than blanked. Both three.js cameras implement the same `view` carve-out, so the driver
// (perspective) and the overhead (orthographic) take identical arguments.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** the resolved safe rect for THIS frame — one module-scope object, rewritten per frame and
 * never reallocated (this camera file allocates nothing per frame; see `fitDriverCamera`'s
 * cache note). `left`/`top` are the CSS-px insets, `w`/`h` the safe rect's size, `fullW`/`fullH`
 * the canvas's, and `offset` is false when there is no chrome at all (the gallery, a preview
 * harness, a `SceneFrame` from before `insets` existed) — in which case the cameras run exactly
 * as they did before this existed. */
const safe = { left: 0, top: 0, w: 1, h: 1, fullW: 1, fullH: 1, offset: false };

function resolveSafeRect(frame: SceneFrame): void {
  const fullW = Math.max(1, frame.width);
  const fullH = Math.max(1, frame.height);
  const ins = frame.insets;
  let left = ins ? Math.max(0, ins.left) : 0;
  let right = ins ? Math.max(0, ins.right) : 0;
  let top = ins ? Math.max(0, ins.top) : 0;
  let bottom = ins ? Math.max(0, ins.bottom) : 0;
  // A DEGENERATE SAFE RECT IS A BROKEN CAMERA, not a tight one: a zero or negative width hands
  // the fit an infinite aspect and `setViewOffset` a division by zero. The controller caps each
  // band at 45 % already, but this scene takes its insets from whoever hands it a `SceneFrame`
  // and must not trust them — an axis that has been over-claimed drops its chrome allowance
  // entirely rather than produce a rect nothing can be fitted into.
  if (left + right > fullW * 0.9) left = right = 0;
  if (top + bottom > fullH * 0.9) top = bottom = 0;
  safe.left = left;
  safe.top = top;
  safe.w = fullW - left - right;
  safe.h = fullH - top - bottom;
  safe.fullW = fullW;
  safe.fullH = fullH;
  safe.offset = left > 0.5 || right > 0.5 || top > 0.5 || bottom > 0.5;
}

/** apply (or clear) this frame's safe-rect window on either camera. `setViewOffset`'s first two
 * arguments are the VIRTUAL image — the safe rect — and the last four the window rendered onto
 * it, which is the whole canvas shifted back by the top/left insets. On a `PerspectiveCamera`
 * this also sets `aspect` to the safe rect's, which is exactly the aspect the fit solved for. */
function applyViewOffset(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera): void {
  if (safe.offset) cam.setViewOffset(safe.w, safe.h, -safe.left, -safe.top, safe.fullW, safe.fullH);
  else if (cam.view?.enabled) cam.clearViewOffset();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CHASE AND ORBIT (Day 2, `docs/biobuzz/plan-3d.md` §4.3: "Chase (60 in back, 40 up;
// robot-centric). Orbit (spectators, replays, gallery).")
//
// Neither is ever named by the controller — `GameController.sceneCameraFor()` still picks
// `driver` or `overhead`. They are reached through the DEVICE's camera preference
// (`graphics/store.ts`), which `renderScene.ts` resolves against the frame's camera before
// calling `update`. Both fit into `frame.insets`' safe rect through the same `setViewOffset`
// window the driver camera uses, so a chase shot is not framed under the score bar either.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** plan §4.3's own two numbers: the chase eye sits 60 in BEHIND the robot along its heading and
 * 40 in ABOVE it. */
const CHASE_BACK = 60;
const CHASE_UP = 40;
/** how far AHEAD of the robot the chase camera looks, and how high — aiming at the chassis
 * itself puts the robot dead centre with the field it is driving into squeezed into the top
 * third; a target ahead of it gives the drive direction the middle of the frame. */
const CHASE_LOOK_AHEAD = 36;
const CHASE_LOOK_Z = 14;
const CHASE_FOV = 68;

/**
 * FOLLOW SMOOTHING HALF-LIFE, seconds — the time the camera takes to close HALF the distance to
 * where it should be. Frame-rate independent by construction: the per-frame blend is
 * `1 − 2^(−dt/halfLife)`, so 144 Hz and 30 Hz converge along the same curve in WALL-CLOCK time
 * (a plain `lerp(…, 0.1)` per frame does not — it follows nearly five times faster at 144 Hz,
 * which is exactly how a camera ends up feeling different on two machines). Same trick, same
 * constant shape as `GameController`'s own `SMOOTH_HALFLIFE` error decay.
 *
 * Position lags slightly more than the aim point: a camera whose LOOK-AT snapped while its eye
 * drifted reads as a swimming horizon.
 */
const CHASE_POS_HALFLIFE = 0.12;
const CHASE_AIM_HALFLIFE = 0.08;
/** REDUCED MOTION (`prefers-reduced-motion`, and plan §4.4's "Camera motion: full / reduced")
 * does not mean "no camera" — it means the camera must not add motion of its own on top of the
 * robot's. A near-zero half-life rigidly bolts the eye to the robot, so every pixel that moves
 * is the robot actually moving; the smoothed version adds a swing the player did not command,
 * which is the part that makes people ill. Orbit's auto-rotate is switched off outright. */
const REDUCED_HALFLIFE = 0.012;
/** a JUMP this big (in) is a teleport, not driving — a reset, a respawn, a reconnect snapping a
 * remote robot into place — and the camera cuts rather than flying across the field. */
const CHASE_SNAP_DIST = 72;

/** FREE CAM's own half-life — "smooth the motion a little", not a follow camera's full damping;
 * a free-look camera that lagged as much as `CHASE_POS_HALFLIFE` would feel like driving through
 * syrup on every mouse-up. The Math.pow-based blend lives HERE, in a `render*`-named file, and
 * not in `graphics/freeCam.ts` — `scripts/smoke.ts`'s source guard scans every non-`render*`/
 * `draw*` file under `src/games` for engine trig/exp/pow, so the smoothing curve is computed
 * exactly where the chase camera's own `blend()` below already is. */
const FREE_CAM_HALFLIFE = 0.08;

/** orbit: the spectator ring's default radius and elevation, and what a wheel may zoom to. The
 * field is 141 in across, so ~250 in out at 32° holds the whole field with the hives' tops
 * inside the frame. */
const ORBIT_RADIUS_DEFAULT = 250;
export const ORBIT_RADIUS_MIN = 90;
export const ORBIT_RADIUS_MAX = 620;
const ORBIT_ELEV_DEFAULT = 0.56; // rad, ≈ 32°
export const ORBIT_ELEV_MIN = 0.08;
export const ORBIT_ELEV_MAX = 1.45; // just short of straight down, where the yaw becomes meaningless
export const ORBIT_CENTER_Z = 24;
const ORBIT_FOV = 55;
/** slow auto-rotate, rad/s — one lap in a bit over two minutes, i.e. a match. Slow enough to
 * read as a gallery turntable rather than a moving shot. */
const ORBIT_AUTO_RATE = 0.05;
/** drag sensitivity: radians per CSS pixel. A half-screen drag (≈ 700 px) is a bit under half a
 * turn, which is what "grab the field and swing it round" should cost. */
const ORBIT_DRAG_YAW = 0.006;
const ORBIT_DRAG_PITCH = 0.004;
/** free cam's own wheel-to-factor rate, same shape as `orbitZoom`'s literal below (a dedicated
 * constant here since `freeDolly` reuses it in one place rather than inline like orbit's). */
const FREE_DOLLY_RATE = 0.0012;

/** the driver/chase eye-height nudge (`i` / `o`, plan §4.3), in inches, and the total offset the
 * keys may accumulate. The driver camera SOLVES its own eye height (`fitDriverCamera`), so this
 * is an offset on top of the solved value, clamped into the plan's own 44–72 envelope. */
const EYE_NUDGE_STEP = 4;
const EYE_OFFSET_MAX = 24;

/** one `MediaQueryList`, constructed once — `matchMedia()` per frame is the cost
 * `GameController.mqCoarse` exists to avoid, and this is read on every camera update. Null in a
 * non-DOM host (a headless harness), which reads as "motion is fine". */
const reducedMotionMq: MediaQueryList | null =
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/**
 * A ROOM THE ORBIT AND FREE CAMERAS MAY NOT LEAVE (2026-10-11) — a photographed venue's real walls
 * and ceiling, less a margin (`photoCameraRoom`, `renderPhotoVenue.ts`). A procedural venue is
 * built wider than the cameras reach (`VENUE_MIN_HALF`); a photograph is the size the room was, as
 * close as 208 in from the field's centre, and a camera past a wall saw that wall's base stretched
 * across the floor for a third to a half of the frame. So the boom from the look-at point to the
 * eye is shortened to stay inside, the way a follow camera stops at a wall: the direction is kept,
 * only the distance gives. Null (every procedural venue) changes nothing.
 */
export interface CameraRoom {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

/** the longest boom, up to `len`, from `target` along the unit `dir` that keeps the eye inside
 * `room` — negative when `target` itself is outside it (the caller floors it) */
export function boomInRoom(target: readonly number[], dir: readonly number[], len: number, room: CameraRoom): number {
  let t = len;
  for (let i = 0; i < 3; i++) {
    const d = dir[i];
    if (d > 1e-9) t = Math.min(t, (room.max[i] - target[i]) / d);
    else if (d < -1e-9) t = Math.min(t, (room.min[i] - target[i]) / d);
  }
  return t;
}

function reducedMotion(): boolean {
  // THE OS PREFERENCE ALWAYS WINS. `tunedReducedMotion` is the player's own Graphics pick and can
  // only ever ADD damping — somebody who has asked their system for less motion does not get it
  // back by leaving a game setting on `full`.
  return tunedReducedMotion || (reducedMotionMq?.matches ?? false);
}

/** frame-rate-independent blend factor for a half-life (see `CHASE_POS_HALFLIFE`). */
function blend(dt: number, halfLife: number): number {
  if (!(dt > 0)) return 0;
  if (halfLife <= 0) return 1;
  return 1 - Math.pow(2, -dt / halfLife);
}

export interface BbCameras {
  driver: THREE.PerspectiveCamera;
  overhead: THREE.OrthographicCamera;
  chase: THREE.PerspectiveCamera;
  orbit: THREE.PerspectiveCamera;
  /** FREE CAM (owner, 2026-09-21) — mouse orbit/pan/dolly over the field; see
   * `graphics/freeCam.ts` for the state this camera is a pose of. */
  free: THREE.PerspectiveCamera;
  /** the camera the LAST `update` returned — what `GameScene.project` must project through, so
   * a label lands on the robot the player is actually looking at. */
  active: THREE.Camera;
  /**
   * Update the cameras for this frame and return the one `camera` names.
   *
   * `camera` is the RESOLVED pick (the device preference applied over `frame.camera` —
   * `renderScene.ts`), not `frame.camera` itself. `world` is read only for the local robot's
   * pose, and only by the chase camera.
   */
  update(frame: SceneFrame, world: World, camera: SceneCamera): THREE.Camera;
  /** raise (`+`) or lower (`−`) the driver/chase eye by one step; returns the new total offset
   * in inches, for the caller to report. */
  nudgeEye(dir: 1 | -1): number;
  /** orbit: a mouse drag of (`dx`,`dy`) CSS pixels. Takes the turntable off auto-rotate — the
   * viewer has taken the camera, and having it drift back out from under them is worse than
   * losing the effect. */
  orbitDrag(dx: number, dy: number): void;
  /** orbit: a wheel notch (`deltaY`), zooming the ring in/out between its radius bounds. */
  orbitZoom(deltaY: number): void;
  /** free cam: the per-device mouse layout, inversions, sensitivities and wheel direction
   * (`graphics/freeCam.ts`). Pushed in by `renderScene.ts` at construction and on every change;
   * the three gestures below read it rather than taking pre-adjusted numbers, so the direction
   * senses live in ONE pure, checkable place. */
  setFreeNav(nav: FreeCamNav): void;
  /** free cam: an orbit drag of (`dx`,`dy`) CSS pixels. */
  freeOrbit(dx: number, dy: number): void;
  /** free cam: a pan drag of (`dx`,`dy`) CSS pixels — moves the look-at point across the floor
   * plane, the ground following the cursor. */
  freePan(dx: number, dy: number): void;
  /** free cam: a wheel notch (`deltaY`, or a drag-zoom's pixel equivalent) — dollies toward or
   * away from the look-at point. `ndc` is the cursor in clip space, used only when the device
   * has "zoom to cursor" on; omit it and the dolly goes to the look-at point as it always did. */
  freeDolly(deltaY: number, ndc?: { x: number; y: number }): void;
  /** free cam: reset to the default framing for `viewAngle` (double-click, the HUD's "Reset
   * view" chip). Sets the GOAL only — the eased pose (`update`) eases into it over a few
   * frames, same as every other free-cam move. */
  freeReset(viewAngle: number): void;
  /** the room the orbit and free eyes stay inside (`CameraRoom`), or null for none */
  setRoom(room: CameraRoom | null): void;
}

/** scratch target for `driver.lookAt` — one object, mutated every frame, never reallocated. */
const scratchTarget = new THREE.Vector3();

export function createCameras(): BbCameras {
  const driver = new THREE.PerspectiveCamera(DRIVER_FOV_MIN, 1, 1, 4000);
  driver.up.set(0, 0, 1);
  const overhead = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4000);
  overhead.up.set(0, 0, 1);
  const chase = new THREE.PerspectiveCamera(CHASE_FOV, 1, 1, 4000);
  chase.up.set(0, 0, 1);
  const orbit = new THREE.PerspectiveCamera(ORBIT_FOV, 1, 1, 4000);
  orbit.up.set(0, 0, 1);
  const free = new THREE.PerspectiveCamera(ORBIT_FOV, 1, 1, 4000);
  free.up.set(0, 0, 1);

  // ── per-camera state, all module-free so two scenes (the gallery mounts several) never share
  //    a turntable angle or a chase position.
  /** the smoothed chase eye and aim point, in field inches. `have` is false until the first
   * frame places them, so the camera never eases in from the origin. */
  const chaseEye = new THREE.Vector3();
  const chaseAim = new THREE.Vector3();
  let chaseHave = false;
  let orbitYaw = -Math.PI / 2; // start behind the audience-near wall, looking up-field
  let orbitElev = ORBIT_ELEV_DEFAULT;
  let orbitRadius = ORBIT_RADIUS_DEFAULT;
  let orbitAuto = true;
  let eyeOffset = 0;
  /** FREE CAM state (`graphics/freeCam.ts`) — `Goal` is set IMMEDIATELY by input; `Current` is
   * what is actually rendered, eased toward the goal every frame (`dampFreeCam`). `Have` mirrors
   * `chaseHave`: the first `updateFree` call replaces both with the ALLIANCE-correct default
   * (`defaultFreeCam(frame.viewAngle)`) rather than the `viewAngle`-blind placeholder these are
   * declared with, which only ever runs for zero frames. */
  let freeGoal: FreeCamState = defaultFreeCam(0);
  let freeCurrent: FreeCamState = freeGoal;
  let freeHave = false;
  /** the device's own free-cam layout. Defaulted rather than read from storage here: this file
   * is constructed by headless harnesses too, and `renderScene.ts` pushes the real one in. */
  let freeNav: FreeCamNav = FREE_CAM_NAV_DEFAULT;
  /** see `CameraRoom` — per scene, like the rest of this state */
  let room: CameraRoom | null = null;
  const orbitTarget = [0, 0, ORBIT_CENTER_Z] as const;
  /** the orbit boom's unit direction for the current yaw/elevation */
  function orbitDir(): [number, number, number] {
    const ce = Math.cos(orbitElev);
    return [Math.cos(orbitYaw) * ce, Math.sin(orbitYaw) * ce, Math.sin(orbitElev)];
  }
  /** the orbit radius the room allows in the current direction (no room: the zoom limit) */
  function orbitReach(): number {
    if (!room) return ORBIT_RADIUS_MAX;
    return Math.max(ORBIT_RADIUS_MIN, boomInRoom(orbitTarget, orbitDir(), ORBIT_RADIUS_MAX, room));
  }
  /** `s` with its distance shortened to what the room allows along its own direction */
  function freeInRoom(s: FreeCamState): FreeCamState {
    if (!room) return s;
    const p = freeCamPose(s);
    const d = [(p.eye[0] - p.target[0]) / s.dist, (p.eye[1] - p.target[1]) / s.dist, (p.eye[2] - p.target[2]) / s.dist];
    const reach = Math.max(FREE_CAM_DIST_MIN, boomInRoom(p.target, d, s.dist, room));
    return reach < s.dist ? { ...s, dist: reach } : s;
  }
  /** wall-clock delta between updates, for the smoothing and the turntable. A RENDER file, so
   * `performance.now()` is allowed here (`scripts/smoke.ts`'s clock guard exempts `render*`/
   * `draw*` by name) — and required: `SceneFrame` carries no dt, and a camera that eased by a
   * fixed step per frame would move at the display's refresh rate. */
  let lastT = 0;

  function frameDt(): number {
    const now = performance.now();
    const dt = lastT ? (now - lastT) / 1000 : 0;
    lastT = now;
    // a backgrounded tab, a blocking GLB decode or a devtools pause hands back a dt of seconds;
    // clamping it means the camera resumes from where it was rather than teleporting.
    return dt > 0 && dt < 0.25 ? dt : 0;
  }

  function localRobot(world: World, frame: SceneFrame): RobotState | null {
    if (frame.localRobotId === undefined) return null;
    for (const r of world.robots) if (r.id === frame.localRobotId) return r;
    return null;
  }

  /**
   * HEIGHT-ACCURATE DRIVER EYE (owner, 2026-09-21) — when the player has set "Your height" AND
   * there is a local robot to resolve a TOP/BOTTOM role for, this REPLACES the solved fit below
   * entirely: the eye sits at the exact point and height a real drive-team member would stand
   * at (`graphics/driverEye.ts`), never moved to keep the field in frame. Returns `null` for
   * every case that must fall back to the fit — no height set, no local robot (a spectator, a
   * replay with no viewpoint), or a role the game has not locked yet.
   */
  /**
   * The whole-field frame from a standing driver's eye (`fitDriverEyeFrame`). It depends on the
   * alliance, the role, the height, the screen shape and the lens and on NOTHING that moves in a
   * match, so it is solved once per change of those and the camera then holds still — the owner's
   * "choppy" report was a frame that followed the robot.
   */
  let eyeKey = '';
  let eyeFrame: DriverEyeFrame | null = null;
  /** the eased aim — the view turns toward the robot at `EYE_FOLLOW_HALFLIFE`, and snaps when the
   *  frame itself changes (a new match, a resize, a new lens) */
  let eyeYaw = 0;
  let eyePitch = 0;
  let eyeHave = false;
  function driverEyePoseFor(frame: SceneFrame, world: World, vFovDeg: number, aspect: number): DriverEyeFrame | null {
    if (tunedDriverHeightIn == null) return null;
    const robot = localRobot(world, frame);
    if (!robot) return null;
    const role = bbRoleLabel(frame.localStartCat, robot.alliance);
    if (role !== 'TOP' && role !== 'BOTTOM') return null;
    const key = `${robot.alliance}|${role}|${tunedDriverHeightIn}|${aspect}|${vFovDeg}`;
    if (key !== eyeKey || !eyeFrame) {
      eyeKey = key;
      eyeHave = false;
      eyeFrame = fitDriverEyeFrame(robot.alliance, role as DriverRole, tunedDriverHeightIn, EYE_FIT_POINTS, aspect, (vFovDeg * Math.PI) / 180);
    }
    return eyeFrame;
  }

  function updateDriver(frame: SceneFrame, world: World, dt: number): void {
    // THE FIT IS AGAINST THE SAFE RECT, not the canvas — the field has to land inside the part
    // of the viewport the HUD is not covering, so that is the aspect (and the virtual image)
    // every number below is solved for.
    resolveSafeRect(frame);
    const aspect = Math.max(1e-3, safe.w / safe.h);

    const eyeFov = driverEyeFovDeg(aspect);
    const heightPose = driverEyePoseFor(frame, world, eyeFov, aspect);
    const robotNow = heightPose ? localRobot(world, frame) : null;
    if (heightPose && robotNow) {
      // THE WHOLE FIELD, ALWAYS, AND TURNED TOWARD THE ROBOT AS FAR AS THAT ALLOWS (owner,
      // 2026-09-24) — `driverEyeFollow` clamps, this eases, so the view glides to the edge of its
      // room instead of stepping.
      const want = driverEyeFollow(heightPose, EYE_FIT_POINTS, { x: robotNow.pos.x, y: robotNow.pos.y, z: robotNow.z ?? 0 }, aspect);
      if (!eyeHave || !(dt > 0)) {
        eyeYaw = want.yaw;
        eyePitch = want.pitch;
        eyeHave = true;
      } else {
        const k = blend(dt, reducedMotion() ? REDUCED_HALFLIFE : EYE_FOLLOW_HALFLIFE);
        eyeYaw += wrapAngle(want.yaw - eyeYaw) * k;
        eyePitch += (want.pitch - eyePitch) * k;
      }
      // THE WHOLE FIELD, AND STILL — no `i`/`o` nudge, no following the robot: a standing person
      // moves their eyes, not the field. The lens is the player's own FOV setting, horizontal and
      // capped at what two human eyes see (`graphics/fov.ts`). `driver.near` (1 in) already
      // clears "the wall top a foot in front of the eye".
      driver.aspect = aspect;
      driver.fov = (heightPose.vFov * 180) / Math.PI;
      applyViewOffset(driver);
      driver.position.set(heightPose.eye.x, heightPose.eye.y, heightPose.eye.z);
      driver.up.set(0, 0, 1);
      const cosP = Math.cos(eyePitch);
      const sinP = Math.sin(eyePitch);
      const lookDist = 100;
      scratchTarget.set(
        heightPose.eye.x + Math.cos(eyeYaw) * cosP * lookDist,
        heightPose.eye.y + Math.sin(eyeYaw) * cosP * lookDist,
        heightPose.eye.z - sinP * lookDist,
      );
      driver.lookAt(scratchTarget);
      driver.updateProjectionMatrix();
      return;
    }

    const fwd = forwardOf(frame.viewAngle);
    // the field is square (BB_HALF_X === BB_HALF_Y), so one half-extent is the wall distance on
    // every side regardless of which alliance's viewAngle this frame carries
    const fit = fitDriverCamera('red', frame.viewAngle, aspect);
    const eyeDist = BB_HALF_X + fit.setback;
    driver.aspect = aspect;
    driver.fov = (fit.vFov * 180) / Math.PI;
    applyViewOffset(driver);
    const eyeX = -fwd.x * eyeDist;
    const eyeY = -fwd.y * eyeDist;
    // THE `i`/`o` NUDGE (plan §4.3) rides ON TOP of the solved height, clamped into the same
    // 44–72 envelope the fit searches in. The pitch and FOV stay the SOLVED ones: re-fitting per
    // keystroke would undo the nudge (the fit would simply re-solve a height that frames the
    // field), so a nudged eye can crop a corner by the few degrees it moved — which is the
    // player asking for a different view, not a broken fit.
    const eyeH = clampEye(fit.eyeH + eyeOffset);
    driver.position.set(eyeX, eyeY, eyeH);
    driver.up.set(0, 0, 1);
    // look along the pitched forward direction F(θ) = F0·cosθ − Z·sinθ — see `solveFit`'s header
    // for the derivation; any positive distance along that ray is a valid look-at target.
    const cosP = Math.cos(fit.pitch);
    const sinP = Math.sin(fit.pitch);
    const lookDist = 100;
    scratchTarget.set(eyeX + fwd.x * cosP * lookDist, eyeY + fwd.y * cosP * lookDist, eyeH - sinP * lookDist);
    driver.lookAt(scratchTarget);
    driver.updateProjectionMatrix();
  }

  function updateOverhead(frame: SceneFrame): void {
    const fwd = forwardOf(frame.viewAngle);
    // the SAFE rect's aspect, same as the driver camera — this is the phone/touch default
    // (`sceneCameraFor`), where the score bar and the chip row take the largest share of a
    // small viewport and an unfitted overhead shot puts the far wall straight under the bar
    resolveSafeRect(frame);
    const aspect = Math.max(1e-3, safe.w / safe.h);
    // fit the field plus the same view margin the 2D bounds use (`bounds.viewMargin`), in BOTH
    // screen axes — the square field means a screen-aligned fit needs no rotation-dependent math
    const half = BB_HALF_X + BB_VIEW_MARGIN;
    const halfH = aspect >= 1 ? half : half / aspect;
    const halfW = aspect >= 1 ? half * aspect : half;
    overhead.left = -halfW;
    overhead.right = halfW;
    overhead.top = halfH;
    overhead.bottom = -halfH;
    overhead.near = 1;
    overhead.far = 4000;
    // the ortho box just set IS the virtual image; the window onto it is the whole canvas
    applyViewOffset(overhead);
    overhead.position.set(0, 0, 800);
    // screen-up on the overhead view is world "forward" (into the field from the driver's own
    // wall), matching `worldToScreen`'s rotation for the 2D view
    overhead.up.set(fwd.x, fwd.y, 0);
    overhead.lookAt(0, 0, 0);
    overhead.updateProjectionMatrix();
  }

  /**
   * CHASE — 60 in behind the robot along its own heading, 40 up, aimed a little ahead of it
   * (plan §4.3). Robot-centric: the yaw comes from `r.heading`, NOT from `frame.viewAngle`, so
   * the picture turns with the robot the way a follow camera in a driving game does.
   *
   * Falls back to the driver camera when there is no local robot to chase (a spectator, a replay
   * of somebody else's match) — see `SceneCamera`'s own note. Returns false in that case so
   * `update` can hand back the fallback rather than a camera pointing at nothing.
   */
  function updateChase(frame: SceneFrame, world: World, dt: number): boolean {
    const r = localRobot(world, frame);
    if (!r) return false;
    resolveSafeRect(frame);
    const aspect = Math.max(1e-3, safe.w / safe.h);
    const fx = Math.cos(r.heading);
    const fy = Math.sin(r.heading);
    const base = r.z ?? 0;
    const wantEyeX = r.pos.x - fx * CHASE_BACK;
    const wantEyeY = r.pos.y - fy * CHASE_BACK;
    // the `i`/`o` nudge raises the chase eye too (it is the same "let me see further over the
    // field" request), on its own bounds — this height is ABOVE THE ROBOT, not above the floor,
    // so the driver camera's 44–72 stand-height envelope does not apply to it.
    const wantEyeZ = base + Math.max(12, Math.min(96, CHASE_UP + eyeOffset));
    const wantAimX = r.pos.x + fx * CHASE_LOOK_AHEAD;
    const wantAimY = r.pos.y + fy * CHASE_LOOK_AHEAD;
    const wantAimZ = base + CHASE_LOOK_Z;

    const reduced = reducedMotion();
    const snap =
      !chaseHave ||
      dt === 0 ||
      chaseAim.distanceTo(scratchTarget.set(wantAimX, wantAimY, wantAimZ)) > CHASE_SNAP_DIST;
    if (snap) {
      chaseEye.set(wantEyeX, wantEyeY, wantEyeZ);
      chaseAim.set(wantAimX, wantAimY, wantAimZ);
      chaseHave = true;
    } else {
      const kPos = blend(dt, reduced ? REDUCED_HALFLIFE : CHASE_POS_HALFLIFE);
      const kAim = blend(dt, reduced ? REDUCED_HALFLIFE : CHASE_AIM_HALFLIFE);
      chaseEye.x += (wantEyeX - chaseEye.x) * kPos;
      chaseEye.y += (wantEyeY - chaseEye.y) * kPos;
      chaseEye.z += (wantEyeZ - chaseEye.z) * kPos;
      chaseAim.x += (wantAimX - chaseAim.x) * kAim;
      chaseAim.y += (wantAimY - chaseAim.y) * kAim;
      chaseAim.z += (wantAimZ - chaseAim.z) * kAim;
    }

    chase.aspect = aspect;
    applyViewOffset(chase);
    // §4.4's FOV row, applied live — `updateProjectionMatrix` below is already being called
    chase.fov = chaseFovDeg(aspect);
    chase.position.copy(chaseEye);
    chase.up.set(0, 0, 1);
    chase.lookAt(chaseAim);
    chase.updateProjectionMatrix();
    return true;
  }

  /**
   * ORBIT — the spectator/gallery turntable: a ring around the field centre at
   * `orbitRadius`/`orbitElev`, auto-rotating slowly until somebody drags it. Needs no robot and
   * no `viewAngle`, which is what makes it the right camera for a replay, the scene gallery and
   * a screenshot.
   */
  function updateOrbit(frame: SceneFrame, dt: number): void {
    resolveSafeRect(frame);
    orbit.aspect = Math.max(1e-3, safe.w / safe.h);
    orbit.fov = orbitFovDeg(orbit.aspect);
    if (orbitAuto && !reducedMotion()) orbitYaw += ORBIT_AUTO_RATE * dt;
    const dir = orbitDir();
    // inside the photographed room (`CameraRoom`): the boom gives, the direction holds
    const r = Math.min(orbitRadius, orbitReach());
    applyViewOffset(orbit);
    orbit.position.set(dir[0] * r, dir[1] * r, ORBIT_CENTER_Z + dir[2] * r);
    orbit.up.set(0, 0, 1);
    scratchTarget.set(0, 0, ORBIT_CENTER_Z);
    orbit.lookAt(scratchTarget);
    orbit.updateProjectionMatrix();
  }

  /**
   * FREE CAM — mouse orbit/pan/dolly about a look-at point on the floor (owner, 2026-09-21). The
   * three gestures (`freeOrbit`/`freePan`/`freeDolly` below) only ever move `freeGoal`; this is
   * the one place `freeCurrent` moves, eased toward it every frame, and the one place the state
   * becomes a `THREE.Camera` pose (`freeCamPose`). Shares the orbit camera's FOV row (`§4.4`) —
   * both are spectator-style framing shots, not the driver's solved fit.
   */
  function updateFree(frame: SceneFrame, dt: number): void {
    resolveSafeRect(frame);
    free.aspect = Math.max(1e-3, safe.w / safe.h);
    free.fov = orbitFovDeg(free.aspect);
    applyViewOffset(free);
    if (!freeHave) {
      freeGoal = defaultFreeCam(frame.viewAngle);
      freeCurrent = freeGoal;
      freeHave = true;
    }
    // EASE `freeCurrent` toward `freeGoal`, one field at a time — the same half-life `blend()`
    // the chase camera uses above, never overshooting. `yaw` wraps the SHORT way round
    // (`wrapAngle`, `src/math.ts`) so orbiting past ±π eases back rather than spinning the long
    // way to a goal that only looks different because it was never wrapped.
    // SMOOTHING OFF is a snap, not a shorter half-life: the player asked for the camera to be
    // exactly where they put it, and "nearly there, very fast" is still a frame of lag on every
    // mouse-up. Reduced motion keeps its own near-rigid half-life, which is already less motion.
    const k = !freeNav.smoothing ? 1 : blend(dt, reducedMotion() ? REDUCED_HALFLIFE : FREE_CAM_HALFLIFE);
    freeCurrent =
      k <= 0
        ? freeCurrent
        : k >= 1
          ? freeGoal
          : {
              yaw: freeCurrent.yaw + wrapAngle(freeGoal.yaw - freeCurrent.yaw) * k,
              pitch: freeCurrent.pitch + (freeGoal.pitch - freeCurrent.pitch) * k,
              dist: freeCurrent.dist + (freeGoal.dist - freeCurrent.dist) * k,
              target: [
                freeCurrent.target[0] + (freeGoal.target[0] - freeCurrent.target[0]) * k,
                freeCurrent.target[1] + (freeGoal.target[1] - freeCurrent.target[1]) * k,
              ],
            };
    const pose = freeCamPose(freeInRoom(freeCurrent));
    free.position.set(pose.eye[0], pose.eye[1], pose.eye[2]);
    free.up.set(0, 0, 1);
    scratchTarget.set(pose.target[0], pose.target[1], pose.target[2]);
    free.lookAt(scratchTarget);
    free.updateProjectionMatrix();
  }

  /**
   * THE INVERSE OF `GameScene.project`, for the free camera alone: a cursor in clip space → the
   * FLOOR point (z = 0) it is over, or `null` when there is not one.
   *
   * It unprojects through the camera that was actually RENDERED (`free`, i.e. the eased
   * `freeCurrent`), not through `freeGoal`, because the point under the cursor is a fact about
   * the picture on screen. Clip space is the right input: `setViewOffset` bakes the HUD safe
   * rect into `projectionMatrix`, so NDC from the canvas rect stays correct with chrome up.
   *
   * `null` for the three cases a floor point does not exist or is not useful: a ray parallel to
   * the floor, a ray pointing AWAY from it (the sky above the horizon), and a hit so far outside
   * the field that zooming toward it would be a pan to nowhere — the caller then does an
   * ordinary dolly toward the look-at point.
   */
  const floorScratch = new THREE.Vector3();
  const FLOOR_HIT_LIMIT = 4 * (BB_HALF_X + BB_VIEW_MARGIN);
  function floorUnder(ndcX: number, ndcY: number): [number, number] | null {
    if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return null;
    floorScratch.set(ndcX, ndcY, 0.5).unproject(free);
    const dx = floorScratch.x - free.position.x;
    const dy = floorScratch.y - free.position.y;
    const dz = floorScratch.z - free.position.z;
    if (!(Math.abs(dz) > 1e-9)) return null;
    const t = -free.position.z / dz;
    if (!(t > 0) || !Number.isFinite(t)) return null;
    const x = free.position.x + dx * t;
    const y = free.position.y + dy * t;
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > FLOOR_HIT_LIMIT || Math.abs(y) > FLOOR_HIT_LIMIT) return null;
    return [x, y];
  }

  const cams: BbCameras = {
    driver,
    overhead,
    chase,
    orbit,
    free,
    active: driver,
    update(frame: SceneFrame, world: World, camera: SceneCamera): THREE.Camera {
      const dt = frameDt();
      // THE DRIVER AND OVERHEAD CAMERAS ARE UPDATED EVERY FRAME whichever is active — they are
      // two cheap closed-form solves, and both are the fallback for a camera that cannot be
      // satisfied this frame (no local robot). Chase, orbit and free only run when asked: each
      // keeps smoothed STATE, and advancing it while it is not on screen would have it fly in
      // from wherever it last was when the player last looked.
      updateDriver(frame, world, dt);
      updateOverhead(frame);
      // A HOST-PLACED CAMERA (`SceneFrame.pose`) is drawn through `free`'s THREE camera. The free
      // cam's own eased state is not touched, so a later frame without a pose resumes it as it was.
      if (frame.pose) {
        resolveSafeRect(frame);
        free.aspect = Math.max(1e-3, safe.w / safe.h);
        free.fov = frame.pose.fovDeg;
        applyViewOffset(free);
        const { eye, target } = frame.pose;
        free.position.set(eye[0], eye[1], eye[2]);
        free.up.set(0, 0, 1);
        scratchTarget.set(target[0], target[1], target[2]);
        free.lookAt(scratchTarget);
        free.updateProjectionMatrix();
        cams.active = free;
        return free;
      }
      let picked: THREE.Camera;
      if (camera === 'chase') picked = updateChase(frame, world, dt) ? chase : driver;
      else if (camera === 'orbit') {
        updateOrbit(frame, dt);
        picked = orbit;
      } else if (camera === 'free') {
        updateFree(frame, dt);
        picked = free;
      } else picked = camera === 'overhead' ? overhead : driver;
      cams.active = picked;
      return picked;
    },
    nudgeEye(dir: 1 | -1): number {
      eyeOffset = Math.max(-EYE_OFFSET_MAX, Math.min(EYE_OFFSET_MAX, eyeOffset + dir * EYE_NUDGE_STEP));
      // the driver fit is CACHED on (viewAngle, aspect) and the nudge is applied after it, so
      // nothing has to be invalidated here — the next frame simply positions the eye higher.
      return eyeOffset;
    },
    orbitDrag(dx: number, dy: number): void {
      orbitAuto = false;
      orbitYaw -= dx * ORBIT_DRAG_YAW;
      orbitElev = Math.max(ORBIT_ELEV_MIN, Math.min(ORBIT_ELEV_MAX, orbitElev + dy * ORBIT_DRAG_PITCH));
    },
    orbitZoom(deltaY: number): void {
      // a wheel notch is ±100 on a mouse and a handful of pixels on a trackpad, so zoom
      // MULTIPLICATIVELY: the same gesture moves the same fraction of the current radius at
      // every distance, which is what stops a zoom from crawling when far out and lurching when
      // close in.
      const factor = Math.exp(deltaY * 0.0012);
      // from the radius ON SCREEN, so a wheel notch in moves at once after the room shortened the
      // boom, and a notch out stops at the wall rather than winding up a distance nobody sees
      const reach = orbitReach();
      orbitRadius = Math.max(ORBIT_RADIUS_MIN, Math.min(reach, Math.min(orbitRadius, reach) * factor));
    },
    setFreeNav(nav: FreeCamNav): void {
      freeNav = nav;
    },
    freeOrbit(dx: number, dy: number): void {
      // ⚠️ THE SENSE IS `freeCamOrbitDelta`'S, NOT THIS FILE'S. It negates `dx` so the field
      // turns with the cursor — the same direction the spectator `orbitDrag` above has always
      // gone, and the one free cam shipped backwards (owner, 2026-09-21).
      const d = freeCamOrbitDelta(freeNav, dx, dy, ORBIT_DRAG_YAW, ORBIT_DRAG_PITCH);
      freeGoal = orbitFreeCam(freeGoal, d.dYaw, d.dPitch);
    },
    freePan(dx: number, dy: number): void {
      freeGoal = panFreeCam(freeGoal, dx, dy, freeCamPanGain(freeNav));
    },
    freeDolly(deltaY: number, ndc?: { x: number; y: number }): void {
      // the engine-specific exponential lives HERE (a `render*`-named file), never in
      // `graphics/freeCam.ts` — see that file's own header. The two pure modules only multiply
      // and clamp the `factor` this computes, same shape as `orbitZoom` above.
      const factor = Math.exp(deltaY * freeCamWheelSign(freeNav) * freeNav.zoomSpeed * FREE_DOLLY_RATE);
      const at = freeNav.zoomToCursor && ndc ? floorUnder(ndc.x, ndc.y) : null;
      // the same rule as `orbitZoom`: from the distance the room allows, and back inside it after
      const base = freeInRoom(freeGoal);
      freeGoal = freeInRoom(at ? dollyFreeCamToward(base, factor, at[0], at[1]) : dollyFreeCam(base, factor));
    },
    freeReset(viewAngle: number): void {
      freeGoal = defaultFreeCam(viewAngle);
    },
    setRoom(next: CameraRoom | null): void {
      room = next;
    },
  };
  return cams;
}
