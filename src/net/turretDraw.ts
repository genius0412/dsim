import type { RobotState } from '../types';

/**
 * A TURRET IS DRAWN ON ITS CHASSIS'S CLOCK (owner, 2026-11-04: "Driving in the chase POV, I noticed
 * that the turret is either jittery or it looks like it has motion blur").
 *
 * `turretHeading` (and a double turret's `bbTurret2Heading`) is a WORLD angle, and the 3D scene
 * draws the turret at `turretHeading − heading` on the chassis. So whatever pose the chassis is
 * drawn at, the turret's world angle has to come from the SAME moment, or the difference between
 * the two moments shows up as the turret swinging on its ring. `displayWorld` (`game.ts`) took the
 * chassis from one clock and the turret from another in three places, measured:
 *  · a REMOTE robot's chassis was lerped at the interpolation clock and its turret read off the
 *    newest world, `INTERP_DELAY_TICKS` ahead and stepping at the 30 Hz snapshot rate;
 *  · the LOCAL robot in a BIOBUZZ 3D room is predicted, chassis only (`PredictedPose` has no
 *    turret), so its turret was the last snapshot's: 30 Hz steps, a round trip old;
 *  · the local robot's `localSmooth` offset turned the chassis and not the turret, so every
 *    reconcile correction swung the turret by the correction.
 *
 * DOM-free, so the smoke run checks it directly ("turret draw:", NET3D lane).
 */

/** the turret angles a robot is drawn with, besides its chassis pose */
export interface TurretPose {
  /** `turretHeading`, world */
  yaw: number;
  /** `bbTurretPitch`, when the robot has one */
  pitch?: number;
  /** a double turret's `bbTurret2Heading`, world */
  yaw2?: number;
  /** a double turret's `bbTurret2Pitch` */
  pitch2?: number;
}

export function turretPoseOf(r: RobotState): TurretPose {
  return { yaw: r.turretHeading, pitch: r.bbTurretPitch, yaw2: r.bbTurret2Heading, pitch2: r.bbTurret2Pitch };
}

const TAU = 2 * Math.PI;
/** `a` into [−π, π) — modular, no engine trig (this file is read by the sim-adjacent smoke run) */
function wrap(a: number): number {
  return a - TAU * Math.floor((a + Math.PI) / TAU);
}
/** shortest-arc angle lerp */
export function lerpAngleShort(a: number, b: number, t: number): number {
  return a + wrap(b - a) * t;
}
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpOpt = (a: number | undefined, b: number | undefined, t: number): number | undefined =>
  a === undefined || b === undefined ? b : lerp(a, b, t);
const lerpAngleOpt = (a: number | undefined, b: number | undefined, t: number): number | undefined =>
  a === undefined || b === undefined ? b : lerpAngleShort(a, b, t);

/** the turret `t` of the way from `a` to `b`: yaws along the short arc, pitches straight */
export function lerpTurret(a: TurretPose, b: TurretPose, t: number): TurretPose {
  return {
    yaw: lerpAngleShort(a.yaw, b.yaw, t),
    pitch: lerpOpt(a.pitch, b.pitch, t),
    yaw2: lerpAngleOpt(a.yaw2, b.yaw2, t),
    pitch2: lerpOpt(a.pitch2, b.pitch2, t),
  };
}

/**
 * `r`'s turret fields set from `tp`, turned by `dHeading` — the angle the chassis is drawn turned
 * by against the heading `tp` was measured with, so the turret keeps its angle ON THE CHASSIS (a
 * `localSmooth` or contact-blend offset turns the whole robot, mechanisms included). Only the
 * fields the robot carries are written: a build without a second turret does not gain one.
 */
export function withTurret(r: RobotState, tp: TurretPose, dHeading = 0): RobotState {
  const out: RobotState = { ...r, turretHeading: tp.yaw + dHeading };
  if (r.bbTurretPitch !== undefined && tp.pitch !== undefined) out.bbTurretPitch = tp.pitch;
  if (r.bbTurret2Heading !== undefined && tp.yaw2 !== undefined) out.bbTurret2Heading = tp.yaw2 + dHeading;
  if (r.bbTurret2Pitch !== undefined && tp.pitch2 !== undefined) out.bbTurret2Pitch = tp.pitch2;
  return out;
}
