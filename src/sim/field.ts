import type { Alliance, Vec2 } from '../types';
import * as C from '../config';

/**
 * DECODE field geometry (verified against Competition Manual Section 9 figures
 * and the official ftc-docs field diagrams):
 *
 * World frame: origin at field center, +x = audience's right, +y = away from
 * the audience. Red Wall (red ALLIANCE AREA) is the LEFT wall (x = -72),
 * Blue Wall is the RIGHT wall (x = +72). Goals are CROSS-COURT from their
 * drive teams: BLUE GOAL in the far-LEFT corner (tag 20), RED GOAL in the
 * far-RIGHT corner (tag 24). The obelisk is centered outside the far wall.
 * Each goal's classifier ramp descends along the adjacent side wall to its
 * GATE near mid-wall; released/overflow artifacts roll out beneath it through
 * the (opposing) SECRET TUNNEL strip toward the audience corner.
 * The two LAUNCH ZONES are shared: a large triangle from the far corners to
 * the field center, and a small triangle centered on the audience wall.
 */

/** which side wall the alliance's GOAL corner is on: blue -1 (left), red +1 */
export const goalSide = (a: Alliance): number => (a === 'blue' ? -1 : 1);
/** which side wall the alliance's DRIVE TEAM / loading zone is on */
export const driverSide = (a: Alliance): number => -goalSide(a);

/** camera/world rotation so the driver views the field from their wall:
 * screen-up points from the driver's wall into the field */
export const viewAngleOf = (a: Alliance): number =>
  driverSide(a) === 1 ? -Math.PI / 2 : Math.PI / 2;

export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export const inRect = (p: Vec2, r: Rect): boolean =>
  p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;

const sideRect = (side: number, x0: number, x1: number, y0: number, y1: number): Rect => ({
  x0: Math.min(side * x0, side * x1),
  x1: Math.max(side * x0, side * x1),
  y0,
  y1,
});

// ------------------------------------------------------------------ goal ----

/** signed value of the goal front-face line; > 0 means behind the face
 * (inside the goal footprint). blue: y - x - 117, red: y + x - 117 */
export function goalLineValue(p: Vec2, a: Alliance): number {
  return p.y + goalSide(a) * p.x - C.GOAL_LINE_C;
}

/** unit normal of the goal face pointing out into the field */
export function goalFaceNormal(a: Alliance): Vec2 {
  const s = Math.SQRT1_2;
  return { x: -goalSide(a) * s, y: -s };
}

export function goalCenter(a: Alliance): Vec2 {
  const g = goalSide(a);
  return { x: g * C.GOAL_CENTER.x, y: C.GOAL_CENTER.y };
}

/** corners of the goal footprint wedge: it sits against the far wall with
 * its corner cut off by the classifier channel along the side wall */
export function goalTriangle(a: Alliance): [Vec2, Vec2, Vec2] {
  const f = C.FIELD_HALF;
  const g = goalSide(a);
  const edge = f - C.CLASSIFIER_W; // channel edge
  return [
    { x: g * C.GOAL_FACE_FAR_X, y: f },
    { x: g * edge, y: C.GOAL_FACE_SIDE_Y },
    { x: g * edge, y: f },
  ];
}

/** the classifier channel along the side wall (gate up into the far corner)
 * — an obstacle for ROBOTS (released balls exit beneath the gate) */
export function classifierRect(a: Alliance): Rect {
  const g = goalSide(a);
  return sideRect(g, C.FIELD_HALF, C.FIELD_HALF - C.CLASSIFIER_W, C.GATE_ZONE.y0, C.CLASSIFIER_Y1);
}

export function gateZone(a: Alliance): Rect {
  const g = goalSide(a);
  return sideRect(g, C.GATE_ZONE.xNear, C.GATE_ZONE.xFar, C.GATE_ZONE.y0, C.GATE_ZONE.y1);
}

export function tunnelExit(a: Alliance): Vec2 {
  const g = goalSide(a);
  return { x: g * C.TUNNEL_EXIT.x, y: C.TUNNEL_EXIT.y };
}

export function tunnelExitVel(a: Alliance): Vec2 {
  const g = goalSide(a);
  return { x: -g * C.TUNNEL_EXIT_VEL.inward, y: -C.TUNNEL_EXIT_VEL.along };
}

/** the SECRET TUNNEL floor strip beneath a goal's classifier (belongs to the
 * OPPOSING alliance — it is on their wall) */
export function tunnelStrip(a: Alliance): Rect {
  const g = goalSide(a);
  return sideRect(g, C.FIELD_HALF, C.FIELD_HALF - C.CLASSIFIER_W, -46.5, C.GATE_ZONE.y0);
}

// ----------------------------------------------------------------- zones ----

/** shared launch zones: big far triangle (apex at field center) + small
 * audience triangle. Both alliances launch from the same zones. */
export function inLaunchZone(p: Vec2, _a: Alliance): boolean {
  if (Math.abs(p.x) > C.FIELD_HALF || Math.abs(p.y) > C.FIELD_HALF) return false;
  const main = p.y >= Math.abs(p.x); // triangle (0,0) (-72,72) (72,72)
  const aud = p.y <= -C.AUD_ZONE_APEX_Y - Math.abs(p.x) * (C.TILE / C.AUD_ZONE_HALF_W); // small triangle at audience wall
  return main || aud;
}

/** all white launch-line tape segments (incl. depot lines) for LEAVE checks */
export function launchSegments(): [Vec2, Vec2][] {
  const f = C.FIELD_HALF;
  const dep = C.GOAL_LINE_C - C.DEPOT_DEPTH * Math.SQRT2;
  return [
    [{ x: 0, y: 0 }, { x: f, y: f }],
    [{ x: 0, y: 0 }, { x: -f, y: f }],
    [{ x: 0, y: -C.AUD_ZONE_APEX_Y }, { x: C.AUD_ZONE_HALF_W, y: -f }],
    [{ x: 0, y: -C.AUD_ZONE_APEX_Y }, { x: -C.AUD_ZONE_HALF_W, y: -f }],
    // depot lines (they are launch lines too), parallel to each goal face
    [{ x: -(dep - f), y: f }, { x: -f, y: dep - f }],
    [{ x: dep - f, y: f }, { x: f, y: dep - f }],
  ];
}

export function baseZone(a: Alliance): Rect {
  const d = driverSide(a);
  const c = { x: d * C.BASE_CENTER.x, y: C.BASE_CENTER.y };
  return { x0: c.x - 9, x1: c.x + 9, y0: c.y - 9, y1: c.y + 9 };
}

export function loadZone(a: Alliance): Rect {
  const d = driverSide(a);
  return sideRect(d, C.FIELD_HALF, C.FIELD_HALF - C.LOAD_ZONE_SIZE, -C.FIELD_HALF, -C.FIELD_HALF + C.LOAD_ZONE_SIZE);
}

/** artifact rest slots in the loading zone, against the perimeter, PGP order */
export function loadSlots(a: Alliance): Vec2[] {
  const d = driverSide(a);
  return [0, 1, 2].map((i) => ({
    x: d * (C.FIELD_HALF - 3.5),
    y: -C.FIELD_HALF + 4 + i * 6,
  }));
}

/** ground ball resting in the depot band in front of the alliance's goal */
export function inDepot(p: Vec2, a: Alliance): boolean {
  const gv = goalLineValue(p, a);
  return gv < 0 && gv > -C.DEPOT_DEPTH * Math.SQRT2;
}

/** spike marks: three 3-ball rows per side (balls in a horizontal row on the
 * 10in tape). near (audience) = GPP, middle = PGP, far = PPG, read from the
 * side wall inward. */
export function spikeMarkBalls(a: Alliance): { pos: Vec2; color: 'purple' | 'green' }[] {
  const d = driverSide(a);
  const rows: ('purple' | 'green')[][] = [
    ['green', 'purple', 'purple'], // near
    ['purple', 'green', 'purple'], // middle
    ['purple', 'purple', 'green'], // far
  ];
  const out: { pos: Vec2; color: 'purple' | 'green' }[] = [];
  C.SPIKE_ROW_YS.forEach((y, i) => {
    const cx = d * C.SPIKE_COL_X;
    rows[i].forEach((color, j) => {
      // j=0 nearest the side wall, reading inward
      out.push({ pos: { x: cx - d * (j - 1) * C.SPIKE_BALL_SPACING, y }, color });
    });
  });
  return out;
}

export function startPose(a: Alliance): { pos: Vec2; heading: number } {
  // robots stage inside the big launch zone near their own goal
  const g = goalSide(a);
  const pos = { x: g * C.START.x, y: C.START.y };
  const gc = goalCenter(a);
  return { pos, heading: Math.atan2(gc.y - pos.y, gc.x - pos.x) };
}

/** the classifier SQUARE (rail entrance) — top of the ramp, below the goal */
export function railEntrance(a: Alliance): Vec2 {
  return { x: goalSide(a) * (C.FIELD_HALF - C.RAMP_RAIL_INSET), y: C.CLASSIFIER_Y0 + C.RAIL_S_MAX };
}

/** the archway inside the goal where basin balls funnel toward the SQUARE */
export function basinFunnelTarget(a: Alliance): Vec2 {
  return { x: goalSide(a) * (C.FIELD_HALF - C.CLASSIFIER_W - 2), y: C.CLASSIFIER_Y0 + C.RAIL_S_MAX + 4 };
}

/** rail coordinate s -> world position along the classifier */
export function railPos(a: Alliance, s: number): Vec2 {
  return { x: goalSide(a) * (C.FIELD_HALF - C.RAMP_RAIL_INSET), y: C.CLASSIFIER_Y0 + s };
}
