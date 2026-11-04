/**
 * FIELD OF VIEW — the slider is HORIZONTAL degrees, and a camera turns it into the VERTICAL FOV
 * `three` takes for its own screen shape (owner, 2026-09-24: "For the fov slider, keep human fov
 * in mind").
 *
 * Horizontal because that is the figure human vision and every game quote, and because it is
 * the one that means the same thing on every screen. The old slider was 60–90° VERTICAL, which is
 * 91–121° across on a 16:9 screen but 150° on a 21:9 one: past the ~120° that both human eyes see
 * together, so an ultrawide player got a fish-eye view no person has. `GFX_FOV_MAX` is that 120.
 *
 * Pure math, DOM-free, no `three` (the rule every `graphics/` file keeps), and `dtan`/`datan`
 * rather than engine trig: `scripts/smoke.ts`'s source guard scans this directory.
 */

import { datan, dtan } from '../../../math';

/** the horizontal field both human eyes see together, degrees — the slider's ceiling */
export const HUMAN_BINOCULAR_HFOV_DEG = 120;

const RAD = Math.PI / 180;

/** the VERTICAL FOV (degrees) that shows `hDeg` across a screen of `aspect` (width / height) */
export function vFovFromH(hDeg: number, aspect: number): number {
  const a = Math.max(1e-3, aspect);
  return (2 * datan(dtan((hDeg * RAD) / 2) / a)) / RAD;
}

/**
 * THE VERTICAL FOV A CAMERA TAKES FROM THE SLIDER on a screen of `aspect`: the slider's angle spans
 * the screen's LONGER side. On every landscape screen that is `vFovFromH`, unchanged. On a portrait
 * one, holding it across the short side made the vertical view explode (2026-11-04, measured
 * through the real cameras at 390 × 844: the chase camera 138° tall, the orbit 123°, the frame a
 * fish-eye of floor and ceiling with the field a speck in the middle); now it is the slider across
 * the height (100°), whose corner stretch matches a 16:9 screen's at the same setting.
 */
export function vFovForScreen(hDeg: number, aspect: number): number {
  return vFovFromH(hDeg, Math.max(1, aspect));
}

/** the HORIZONTAL FOV (degrees) a vertical `vDeg` shows across a screen of `aspect` */
export function hFovFromV(vDeg: number, aspect: number): number {
  const a = Math.max(1e-3, aspect);
  return (2 * datan(dtan((vDeg * RAD) / 2) * a)) / RAD;
}
