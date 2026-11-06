/**
 * THE MENU STAGE'S CAMERA FLY, ON FRAME TIME (`MenuStage.tsx`). The fly's progress advances by each
 * frame's own time, at most `FLY_STEP_MAX_S` a frame, never by the wall clock: on the wall clock a long
 * task inside the fly (the Play click's own React commit, the first fly frame building the robot and
 * linking its shaders) counted as flight, and the camera skipped part of the path. A stall now holds
 * the camera where it is. DOM-free, so `npm test` holds it.
 */

/** the most one frame may advance the fly: 20 fps still flies in about `FLY_MS`, a stall does not skip */
export const FLY_STEP_MAX_S = 0.05;

/** the fly's progress (0..1) after a frame of `dt` seconds, for a fly of `ms` (0: it lands at once) */
export function flyStep(p: number, dt: number, ms: number): number {
  return ms > 0 ? Math.min(1, p + (Math.min(dt, FLY_STEP_MAX_S) * 1000) / ms) : 1;
}
