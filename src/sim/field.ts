import type { Alliance, Vec2 } from '../types';
import * as C from '../config';
import { datan2 } from '../math';

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

/** the opposing alliance */
export const other = (a: Alliance): Alliance => (a === 'blue' ? 'red' : 'blue');

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

/** the two endpoints of the goal FACE (hypotenuse): one on the far wall,
 * one on the side wall. The right-angle corner is the field corner between
 * them. Legs: GOAL_FACE_WIDTH along the far wall, GOAL_DEPTH down the side. */
export function goalFacePoints(a: Alliance): [Vec2, Vec2] {
  const g = goalSide(a);
  const f = C.FIELD_HALF;
  return [
    { x: g * (f - C.GOAL_FACE_WIDTH), y: f }, // far-wall endpoint
    { x: g * f, y: f - C.GOAL_DEPTH }, // side-wall endpoint
  ];
}

/** unit normal of the goal face pointing out into the field (not 45° — the
 * face is the hypotenuse of the 26.5x18.3 corner triangle) */
export function goalFaceNormal(a: Alliance): Vec2 {
  return {
    x: -goalSide(a) * (C.GOAL_DEPTH / C.GOAL_FACE_LEN),
    y: -(C.GOAL_FACE_WIDTH / C.GOAL_FACE_LEN),
  };
}

/** signed PERPENDICULAR distance (in) from the goal face; > 0 = behind the
 * face (inside the goal footprint), < 0 = in front (field side) */
export function goalLineValue(p: Vec2, a: Alliance): number {
  const [far] = goalFacePoints(a);
  const n = goalFaceNormal(a);
  return n.x * (far.x - p.x) + n.y * (far.y - p.y);
}

/** aim target: centroid of the triangular goal opening */
export function goalCenter(a: Alliance): Vec2 {
  const g = goalSide(a);
  const f = C.FIELD_HALF;
  return {
    x: (g * (f - C.GOAL_FACE_WIDTH) + 2 * g * f) / 3,
    y: (2 * f + (f - C.GOAL_DEPTH)) / 3,
  };
}

/** corners of the goal footprint: a right triangle tucked into the far
 * corner, legs flush along the far wall (GOAL_FACE_WIDTH) and side wall
 * (GOAL_DEPTH); the hypotenuse is the FACE. Order: far-wall face pt,
 * side-wall face pt, corner. */
export function goalTriangle(a: Alliance): [Vec2, Vec2, Vec2] {
  const g = goalSide(a);
  const f = C.FIELD_HALF;
  const [far, side] = goalFacePoints(a);
  return [far, side, { x: g * f, y: f }];
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

/** the official GATE ZONE marking: two parallel alliance-colored tape LINES,
 * 10in long, running from the side wall into the field, spaced GATE_TAPE_W
 * (2.75in) apart and centered on the gate. The zone is the 2.75x10 strip
 * between them; the interaction rect gateZone() is larger and undrawn. */
export function gateTapeSegments(a: Alliance): [[Vec2, Vec2], [Vec2, Vec2]] {
  const g = goalSide(a);
  // the lines start at the CLASSIFIER edge (not the field wall) and run
  // GATE_TAPE_LEN further into the field
  const xOut = g * (C.FIELD_HALF - C.CLASSIFIER_W);
  const xIn = g * (C.FIELD_HALF - C.CLASSIFIER_W - C.GATE_TAPE_LEN);
  const yc = C.GATE_TAPE_Y;
  const h = C.GATE_TAPE_W / 2;
  return [
    [{ x: xOut, y: yc - h }, { x: xIn, y: yc - h }],
    [{ x: xOut, y: yc + h }, { x: xIn, y: yc + h }],
  ];
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
  return sideRect(
    g,
    C.FIELD_HALF,
    C.FIELD_HALF - C.TUNNEL_W,
    C.GATE_ZONE.y0 - C.TUNNEL_STRIP_LEN,
    C.GATE_ZONE.y0,
  );
}

/** ALLIANCE AREA: the taped drive-team rectangle OUTSIDE the alliance's own
 * wall (red left, blue right), running from the audience wall toward the far
 * wall — not wall-centered (per the Section 9 figures) */
export function allianceArea(a: Alliance): Rect {
  const d = driverSide(a);
  return sideRect(
    d,
    C.FIELD_HALF,
    C.FIELD_HALF + C.ALLIANCE_AREA_DEEP,
    -C.FIELD_HALF,
    -C.FIELD_HALF + C.ALLIANCE_AREA_ALONG,
  );
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

/** the DEPOT tape line: white tape running flush ALONG the goal face (the
 * hypotenuse), from the far-wall corner up to the CLASSIFIER edge (it stops
 * at the classifier — it does not run through the channel to the side wall).
 * It is a LAUNCH LINE. */
export function depotSegment(a: Alliance): [Vec2, Vec2] {
  const [far, side] = goalFacePoints(a);
  // clip the side end where the face crosses the classifier's inner edge
  const t = (C.GOAL_FACE_WIDTH - C.CLASSIFIER_W) / C.GOAL_FACE_WIDTH;
  return [far, { x: far.x + t * (side.x - far.x), y: far.y + t * (side.y - far.y) }];
}

/** clip a segment running from the field toward a goal corner so it stops at
 * the goal FACE instead of continuing into the goal footprint */
function clipToGoalFace(apex: Vec2, corner: Vec2, a: Alliance): Vec2 {
  const g0 = goalLineValue(apex, a); // < 0 in front of the face
  const g1 = goalLineValue(corner, a); // > 0 inside the goal
  if (g1 <= 0) return corner;
  const t = g0 / (g0 - g1);
  return { x: apex.x + t * (corner.x - apex.x), y: apex.y + t * (corner.y - apex.y) };
}

/** all white launch-line tape segments (incl. depot lines) for LEAVE checks.
 * The big-triangle diagonals stop at the goal face (they don't run into the
 * goal). */
export function launchSegments(): [Vec2, Vec2][] {
  const f = C.FIELD_HALF;
  const apex = { x: 0, y: 0 };
  return [
    [apex, clipToGoalFace(apex, { x: f, y: f }, 'red')],
    [apex, clipToGoalFace(apex, { x: -f, y: f }, 'blue')],
    [{ x: 0, y: -C.AUD_ZONE_APEX_Y }, { x: C.AUD_ZONE_HALF_W, y: -f }],
    [{ x: 0, y: -C.AUD_ZONE_APEX_Y }, { x: -C.AUD_ZONE_HALF_W, y: -f }],
    // depot lines (they are launch lines too), flush along each goal face
    depotSegment('red'),
    depotSegment('blue'),
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

/** grab row: the 3 pre-staged artifacts, laid out in a row along field-x
 * (vertical on the driver's rotated screen) so a robot sweeps all 3 driving
 * along x. PGP order reading from the field-interior side inward. */
export function loadSlots(a: Alliance): Vec2[] {
  const d = driverSide(a);
  return C.LOAD_COL_XS.map((x) => ({ x: d * x, y: C.LOAD_ROW_Y }));
}

/** the 3 pre-staged loading-zone artifacts at match setup (manual): PGP, touching
 * each other, flush against the alliance (side) wall, stacked up from the very
 * corner of the loading zone. Distinct from the grab row — the HP moves them into
 * the grab row once teleop starts. */
export function loadPreStage(a: Alliance): { pos: Vec2; color: 'purple' | 'green' }[] {
  const d = driverSide(a);
  const x = d * (C.FIELD_HALF - C.BALL_RADIUS); // flush against the side wall
  const colors: ('purple' | 'green')[] = ['purple', 'green', 'purple'];
  return colors.map((color, i) => ({
    pos: { x, y: -C.FIELD_HALF + C.BALL_RADIUS + i * 2 * C.BALL_RADIUS }, // touching, from the corner up
    color,
  }));
}

/** the 6 cell centers of the human player's 2x3 out-of-play box, which sits OFF
 * the field just beyond the audience wall, row-major (nearer row first),
 * side-wall-inward within each row. */
export function loadBoxSlots(a: Alliance): Vec2[] {
  const d = driverSide(a);
  const out: Vec2[] = [];
  for (const y of C.LOAD_BOX_YS) for (const x of C.LOAD_COL_XS) out.push({ x: d * x, y });
  return out;
}

/** ground ball resting in the depot band in front of the alliance's goal */
export function inDepot(p: Vec2, a: Alliance): boolean {
  const gv = goalLineValue(p, a); // signed perpendicular distance from the face
  return gv < 0 && gv > -C.DEPOT_DEPTH;
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

export function startPose(a: Alliance, index = 0): { pos: Vec2; heading: number } {
  // robots stage inside the big launch zone near their own goal; `index`
  // picks one of the named START_POSES (mirrored per alliance)
  const g = goalSide(a);
  const p = C.START_POSES[Math.min(Math.max(index, 0), C.START_POSES.length - 1)];
  const pos = { x: g * p.x, y: p.y };
  const gc = goalCenter(a);
  return { pos, heading: datan2(gc.y - pos.y, gc.x - pos.x) };
}

/** the classifier SQUARE (rail entrance) — top of the ramp, below the goal */
export function railEntrance(a: Alliance): Vec2 {
  return { x: goalSide(a) * (C.FIELD_HALF - C.RAMP_RAIL_INSET), y: C.CLASSIFIER_Y0 + C.RAIL_S_MAX };
}

/** the archway inside the goal where basin balls funnel toward the SQUARE
 * (top of the rail). Must sit just INSIDE the goal footprint (behind the
 * face) so the basin's face-containment doesn't fence balls off from it. */
export function basinFunnelTarget(a: Alliance): Vec2 {
  return { x: goalSide(a) * (C.FIELD_HALF - C.RAMP_RAIL_INSET), y: C.CLASSIFIER_Y0 + C.RAIL_S_MAX };
}

/** rail coordinate s -> world position along the classifier */
export function railPos(a: Alliance, s: number): Vec2 {
  return { x: goalSide(a) * (C.FIELD_HALF - C.RAMP_RAIL_INSET), y: C.CLASSIFIER_Y0 + s };
}
