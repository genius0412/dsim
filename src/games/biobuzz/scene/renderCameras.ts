import * as THREE from 'three';
import type { SceneCamera, SceneFrame } from '../../module';
import type { RobotState, World } from '../../../types';
import { wrapAngle } from '../../../math';
import { BB_HALF_X, BB_HALF_Y, BB_VIEW_MARGIN, bbRoleLabel } from '../config';
import { WALL_H } from '../fieldDims.gen';
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
import {
  DRIVER_DEFAULT_HEIGHT_IN,
  STAND_BACK_IN,
  driverEyePoint,
  driverShotWindow,
  eyeHeightFromPersonHeight,
  fieldViewPoints,
  fitDriverShot,
  type DriverRole,
  type DriverShot,
  type Eye3,
} from '../graphics/driverEye';
import { vFovForScreen } from '../graphics/fov';
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
// THE DRIVER CAMERA (2026-11-04, owner: "The driver POV is too wide and too far back ... There HAS
// to be a solution that shows both the field and the hive contents"). A standing driver at their
// station, facing straight across the field, pitched down, seen through a SHIFTED lens: the window
// is the player's own lens for this screen, placed over the part of the image the field and both
// hives occupy, and the eye steps back from the wall only as far as that window needs. The math
// and the history are `graphics/driverEye.ts`'s (`fitDriverShot`, `driverShotWindow`); this file
// picks the station and turns the solved window into a projection.
//
// It replaced two cameras with one rule. The FIT (no height set) raised a 62-in eye to 72 and
// stepped it 53 in back to frame the 40-in COLLIDER wall through a symmetric lens; the HEIGHT
// view stepped a real eye 89 in back to frame the field in 80 % of a symmetric, yawed lens. Both
// now stand where `fitDriverShot` says: 42 in back at 16:9 and the default 100°.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** plan-3d.md §4.3's own range for the eye-height key (`i`/`o`), in — the unset view's eye
 * (`DRIVER_DEFAULT_HEIGHT_IN`'s 63.5) plus the nudge stays inside it. */
const DRIVER_EYE_H_MIN = 44;
const DRIVER_EYE_H_MAX = 72;
/** clamp a driver eye height into plan §4.3's own 44–72 envelope. */
function clampEye(h: number): number {
  return Math.max(DRIVER_EYE_H_MIN, Math.min(DRIVER_EYE_H_MAX, h));
}
/** the eye's near plane, in: the near wall's top rail can stand a foot in front of it */
const DRIVER_NEAR = 1;

// ─────────────────────────────────────────────────────────── graphics-settings tuning (Day 3) ──
//
// Two of §4.4's sixteen settings — FIELD OF VIEW and CAMERA MOTION — are camera properties, and
// this is where they land. MODULE scope rather than per-`createCameras`, because they are a
// property of the DEVICE (the preference store is per device). A page with two live scenes (the
// gallery) shares them, which is correct: they are one player's preference, not one scene's.
//
// The FOV is the driver window's SIZE: the eye steps back until the field fits in it, so a
// narrower setting stands further back rather than cropping a corner.

/**
 * The player's FOV setting, HORIZONTAL degrees (`graphics/fov.ts`), or `null` before any has been
 * applied — every camera then uses `GFX_FOV_DEFAULT`'s conversion, or its old fixed value.
 */
let tunedHfovDeg: number | null = null;

/** the chase camera's vertical FOV, degrees — the slider exactly, for this screen (across its
 * longer side: `vFovForScreen`) */
function chaseFovDeg(aspect: number): number {
  return tunedHfovDeg == null ? 68 : vFovForScreen(tunedHfovDeg, aspect);
}
/** orbit and free cam: a framing shot, so the tighter of the two, as before */
function orbitFovDeg(aspect: number): number {
  return tunedHfovDeg == null ? 55 : Math.max(ORBIT_FOV_MIN, vFovForScreen(tunedHfovDeg, aspect) - 15);
}
/** the driver window's vertical angle, radians — the slider for this screen: across the width on
 * landscape, across the height on portrait (`vFovForScreen`) */
function driverLensRad(aspect: number): number {
  return (vFovForScreen(tunedHfovDeg ?? GFX_FOV_DEFAULT, aspect) * Math.PI) / 180;
}
/** the player's own "reduced" pick, OR-ed with `prefers-reduced-motion` (which always wins). */
let tunedReducedMotion = false;
/** "Your height" (owner, 2026-09-21) — per-device, `null` = unset. Set by `renderScene.ts` on
 * every settings change, same as the tuning above. Unset, the driver stands at the station's
 * centre at `DRIVER_DEFAULT_HEIGHT_IN`; set, at their own height and TOP/BOTTOM place
 * (`graphics/driverEye.ts`). */
let tunedDriverHeightIn: number | null = null;

/**
 * Apply §4.4's two camera rows. Called by `renderScene.ts` on every settings change; cheap enough
 * to call every time rather than diffing. The driver shot's cache key carries the lens, so the
 * next frame re-solves against it.
 */
export function setCameraTuning(hfovDeg: number | null, motion: 'full' | 'reduced'): void {
  // `null` is "never set" — the state a fresh module starts in, which a test restores
  tunedHfovDeg = hfovDeg == null ? null : Math.min(GFX_FOV_MAX, Math.max(GFX_FOV_MIN, hfovDeg));
  tunedReducedMotion = motion === 'reduced';
}

/** apply "Your height" (`graphics/driverEye.ts`'s per-device setting). Called by `renderScene.ts`
 * beside `setCameraTuning`; `null` puts the driver back at the station's centre. */
export function setDriverHeightIn(heightIn: number | null): void {
  tunedDriverHeightIn = heightIn;
}

/** how fast the driver window slides toward the robot — a glance, not a snap */
const EYE_FOLLOW_HALFLIFE = 0.18; // s
/** what the driver view frames: the whole field at the wall the player SEES (`WALL_H`, 11.6 in —
 * not the 40-in collider), and both hives to a tipped tray's top */
const EYE_FIT_POINTS = fieldViewPoints(BB_HALF_X, BB_HALF_Y, WALL_H);

/** the driver's station for this frame and the way it faces (straight across the field). A
 * height-set view whose robot or role is not known yet stands at the unset station. */
function driverStation(
  viewAngle: number,
  robot: RobotState | null,
  startCat: SceneFrame['localStartCat'],
  eyeOffset: number,
): { at: Eye3; fwd: { x: number; y: number }; key: string } {
  if (tunedDriverHeightIn != null && robot) {
    const role = bbRoleLabel(startCat, robot.alliance);
    if (role === 'TOP' || role === 'BOTTOM') {
      // THE PLAYER'S OWN PLACE: their height, their half of the wall, square to it. No `i`/`o`
      // nudge — a standing person moves their eyes, not their height.
      const at = driverEyePoint(robot.alliance, role as DriverRole, tunedDriverHeightIn);
      return { at, fwd: { x: -(Math.sign(at.x) || 1), y: 0 }, key: `${robot.alliance}|${role}|${tunedDriverHeightIn}` };
    }
  }
  // THE STATION'S CENTRE, behind whichever wall `viewAngle` puts the driver at, at the default
  // driver's height plus the `i`/`o` nudge (plan §4.3), in the 44–72 envelope.
  const fwd = forwardOf(viewAngle);
  const back = BB_HALF_X + STAND_BACK_IN; // the field is square: one half-extent is every wall
  const z = clampEye(eyeHeightFromPersonHeight(DRIVER_DEFAULT_HEIGHT_IN) + eyeOffset);
  return { at: { x: -fwd.x * back, y: -fwd.y * back, z }, fwd, key: `c|${viewAngle}|${z}` };
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
 * never reallocated (the driver shot is solved once per station, screen and lens, not per
 * frame). `left`/`top` are the CSS-px insets, `w`/`h` the safe rect's size, `fullW`/`fullH`
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

/**
 * THE DRIVER'S SHIFTED LENS: the SAFE RECT shows the window `[cu ± w/2] × [cv ± h/2]` of the image
 * plane at unit depth (`u` right, `v` up), and the canvas spills past it by the insets at the same
 * scale, exactly as `applyViewOffset` does for a centred lens.
 *
 * An off-axis frustum IS a window onto a larger centred one, which is what `setViewOffset` already
 * renders: the camera's own `fov`/`aspect` describe the smallest centred frustum that contains the
 * canvas's window (half-extents `X`, `Y`), and the view offset cuts the canvas out of it. Every
 * reader of the projection (`GameScene.project`, culling, the labels) sees the shifted matrix,
 * and a later `updateProjectionMatrix` rebuilds the same one.
 */
function applyShiftedLens(cam: THREE.PerspectiveCamera, cu: number, cv: number, w: number, h: number): void {
  const k = w / safe.w; // image-plane units per CSS pixel
  const left = cu - w / 2 - k * safe.left;
  const top = cv + h / 2 + k * safe.top;
  const right = left + k * safe.fullW;
  const bottom = top - k * safe.fullH;
  const X = Math.max(Math.abs(left), Math.abs(right), 1e-6);
  const Y = Math.max(Math.abs(top), Math.abs(bottom), 1e-6);
  cam.zoom = 1;
  cam.fov = (2 * Math.atan(Y) * 180) / Math.PI;
  // `setViewOffset` reads ratios only; this scale just keeps its numbers in a sane range
  const s = 1000 / Y;
  cam.setViewOffset(2 * X * s, 2 * Y * s, (left + X) * s, (Y - top) * s, (right - left) * s, (top - bottom) * s);
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
/** the orbit and free cams' floor under the slider, degrees vertical (the old driver fit's 60°
 * floor, less the 15° these framing shots run tighter) */
const ORBIT_FOV_MIN = 45;
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
 * keys may accumulate. On the unset driver view it rides on the default driver's eye, clamped into
 * the plan's own 44–72 envelope, and the shot re-solves for the new eye. */
const EYE_NUDGE_STEP = 4;
const EYE_OFFSET_MAX = 24;

/** one `MediaQueryList`, constructed once — `matchMedia()` per frame is the cost
 * `GameController.mqCoarse` exists to avoid, and this is read on every camera update. Null in a
 * non-DOM host (a headless harness), which reads as "motion is fine". */
const reducedMotionMq: MediaQueryList | null =
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/**
 * A ROOM THE ORBIT AND FREE CAMERAS MAY NOT LEAVE (2026-10-11) — the space in front of a venue's
 * seating banks (`venueCameraRoom`, `renderVenue.ts`). A procedural venue's walls are built wider
 * than the cameras reach (`VENUE_MIN_HALF`), but its stands are not. The boom from the look-at point
 * to the eye is shortened to stay inside, the way a follow camera stops at a wall: the direction is
 * kept, only the distance gives. Null (a venue without stands) changes nothing.
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

/** the overhead camera's height, inches (orthographic: the height sets only what its near plane cuts) */
export const OVERHEAD_EYE_Z = 800;

/** scratch target for `driver.lookAt` — one object, mutated every frame, never reallocated. */
const scratchTarget = new THREE.Vector3();

export function createCameras(): BbCameras {
  const driver = new THREE.PerspectiveCamera(60, 1, DRIVER_NEAR, 4000);
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
   * THE DRIVER SHOT (`graphics/driverEye.ts`'s `fitDriverShot`). It depends on the station (the
   * alliance's wall, the player's height and role, or the unset centre with its `i`/`o` nudge), the
   * screen shape and the lens, and on NOTHING that moves in a match, so it is solved once per change
   * of those. Only the window's place moves, toward the robot, inside the room the shot left.
   */
  let shotKey = '';
  let shot: DriverShot | null = null;
  /** the eased window centre — it slides toward the robot at `EYE_FOLLOW_HALFLIFE`, and snaps when
   *  the shot itself changes (a new match, a resize, a new lens) */
  let winU = 0;
  let winV = 0;
  let winHave = false;

  function updateDriver(frame: SceneFrame, world: World, dt: number): void {
    // THE SHOT IS AGAINST THE SAFE RECT, not the canvas — the field has to land inside the part
    // of the viewport the HUD is not covering, so that is the aspect (and the window) it is solved
    // for; `applyShiftedLens` then spills the canvas past it at the same scale.
    resolveSafeRect(frame);
    const aspect = Math.max(1e-3, safe.w / safe.h);
    const lens = driverLensRad(aspect);
    const robot = localRobot(world, frame);
    const station = driverStation(frame.viewAngle, robot, frame.localStartCat, eyeOffset);
    const key = `${station.key}|${aspect}|${lens}`;
    if (key !== shotKey || !shot) {
      shotKey = key;
      winHave = false;
      shot = fitDriverShot(station.at, station.fwd, EYE_FIT_POINTS, aspect, lens);
    }
    // FOLLOW: the window slides toward the robot, clamped so every point stays in (a clamp, so it
    // glides to the edge of its room and stops there), and eased here
    const want = driverShotWindow(shot, robot ? { x: robot.pos.x, y: robot.pos.y, z: robot.z ?? 0 } : null);
    if (!winHave || !(dt > 0)) {
      winU = want.cu;
      winV = want.cv;
      winHave = true;
    } else {
      const k = blend(dt, reducedMotion() ? REDUCED_HALFLIFE : EYE_FOLLOW_HALFLIFE);
      winU += (want.cu - winU) * k;
      winV += (want.cv - winV) * k;
    }
    driver.near = DRIVER_NEAR;
    driver.position.set(shot.eye.x, shot.eye.y, shot.eye.z);
    driver.up.set(0, 0, 1);
    // look along the pitched forward direction F(θ) = F0·cosθ − Z·sinθ; any positive distance
    // along that ray is a valid look-at target
    const cosP = Math.cos(shot.pitch);
    const sinP = Math.sin(shot.pitch);
    const lookDist = 100;
    scratchTarget.set(
      shot.eye.x + shot.fwd.x * cosP * lookDist,
      shot.eye.y + shot.fwd.y * cosP * lookDist,
      shot.eye.z - sinP * lookDist,
    );
    driver.lookAt(scratchTarget);
    applyShiftedLens(driver, winU, winV, shot.w, shot.h);
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
    // ⚠️ THE NEAR PLANE CUTS AT THE ROOM'S CEILING (2026-11-04). This eye stands at z 800, above
    // any modeled venue's roof, which would otherwise be all it sees. Nothing stands between the
    // room's top and the field (`graphics/venueRoom.ts`), so the cut takes the roof and nothing else.
    overhead.near = room && Number.isFinite(room.max[2]) ? Math.max(1, OVERHEAD_EYE_Z - room.max[2]) : 1;
    overhead.far = 4000;
    // the ortho box just set IS the virtual image; the window onto it is the whole canvas
    applyViewOffset(overhead);
    overhead.position.set(0, 0, OVERHEAD_EYE_Z);
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
    // inside the venue's camera room (`CameraRoom`): the boom gives, the direction holds
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
