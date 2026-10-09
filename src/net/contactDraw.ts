/**
 * DRAWING A REMOTE ROBOT NEXT TO YOURS — the display half of running ahead.
 *
 * The local robot is drawn from the PREDICTION, which runs a round trip ahead of the server
 * (`leadControl.ts`). A remote robot is drawn INTERPOLATED, `INTERP_DELAY_TICKS` behind the
 * newest snapshot. Far apart, nobody can see that the two are different moments. Touching,
 * everybody can: the local robot is drawn where it will be and the other one where it was, so
 * a shove draws one chassis sunk into the other. Measured through a real `Room` (DECODE, chase
 * against a robot on its own route, server contact frames only): the drawn centres were p95
 * 4.2 in closer than the server's at 66 ms RTT and 6.1 in at 130 ms, max 13.4.
 *
 * The predicted world already HAS the answer: every remote robot is stepped there on its held
 * command (`cmdMap`) and collides with the local one. So within `CONTACT_DRAW_FAR_IN` a remote
 * robot is drawn from the prediction instead, blended in by distance so it does not jump
 * clocks in one frame, and carrying its own decaying correction offset (`remoteSmooth` in
 * `game.ts`) exactly the way `localSmooth` carries the local robot's. Same runs: p95 0.3 in at
 * both pings. This is the ordinary answer for a game with physical contact — draw what you can
 * touch at the moment you touch it — and it costs a little remote wobble when the other driver
 * changes stick mid-shove (the prediction learns it a snapshot later), which the offset smooths.
 *
 * A HELD ball rides the robot AS DRAWN (`followDrawn`). It is placed by the predicted world, so
 * without this a remote robot's hopper was drawn where the prediction had the robot while the
 * chassis was drawn somewhere else, and every correction to that prediction jumped the balls:
 * 127 "pops" of more than 6 in a minute at 130 ms, all `held` → `held` on a snapshot. Zero with it.
 *
 * DOM-free, so the smoke run checks it directly. A 2D room reads the predicted remote pose off
 * its predicted world; a BIOBUZZ 3D room reads it off the FULL predictor, which steps every remote
 * robot on its held command (`Predictor.robots`, `sim3d/predict.ts`); LIGHT steps them too,
 * with a footprint push-out instead of a solver (`separateLight`).
 */

export interface Pose {
  x: number;
  y: number;
  heading: number;
}

/** inside this centre distance (in) a remote robot is drawn entirely from the prediction */
export const CONTACT_DRAW_FULL_IN = 30;
/** beyond this (in) it is drawn entirely interpolated, as every remote robot used to be */
export const CONTACT_DRAW_FAR_IN = 54;
/**
 * How fast a remote robot's correction offset decays, s. Twice the local robot's
 * `SMOOTH_HALFLIFE`: a remote correction is somebody else's stick change arriving late, which
 * the viewer did not cause and cannot anticipate, so it reads as wobble rather than as lag.
 * Measured (DECODE shove at 130 ms): per-frame jerk p99 2.04 in at 0.06 s, 1.46 at 0.12 s,
 * with the contact numbers unchanged.
 */
export const REMOTE_SMOOTH_HALFLIFE = 0.12;

/** 0 → draw interpolated, 1 → draw predicted, linear between the two distances */
export function nearDrawWeight(dist: number): number {
  if (!(dist < CONTACT_DRAW_FAR_IN)) return 0;
  if (dist <= CONTACT_DRAW_FULL_IN) return 1;
  return (CONTACT_DRAW_FAR_IN - dist) / (CONTACT_DRAW_FAR_IN - CONTACT_DRAW_FULL_IN);
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** the pose `w` of the way from `a` to `b`, heading along the short arc */
export function blendPose(a: Pose, b: Pose, w: number): Pose {
  return {
    x: a.x + (b.x - a.x) * w,
    y: a.y + (b.y - a.y) * w,
    heading: a.heading + wrap(b.heading - a.heading) * w,
  };
}

/** a point carried rigidly from where the WORLD has its robot to where that robot is DRAWN */
export function followDrawn(p: { x: number; y: number }, world: Pose, drawn: Pose): { x: number; y: number } {
  const dh = drawn.heading - world.heading;
  const rx = p.x - world.x;
  const ry = p.y - world.y;
  const c = Math.cos(dh);
  const s = Math.sin(dh);
  return { x: drawn.x + rx * c - ry * s, y: drawn.y + rx * s + ry * c };
}
