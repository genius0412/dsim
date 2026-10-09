import type { ImportedCut, RobotSpec, Vec2 } from '../../types';
import { INTAKE_RAIL_T, simPatchAtLeast } from '../../config';
import { clamp } from '../../math';
import {
  carveImportPlates,
  clipHalf,
  importHalfChordThrough,
  importMouthRect,
  importPlacePoint,
  IMPORT_PIECE_MIN_AREA,
  rayExit,
  resolveImportMouth,
  spanToV,
  type ImportMouth,
} from '../../sim/importedMech';
import { polyArea, polyBounds } from '../../sim/imported';
import {
  BB_DEFAULT_INTAKE,
  BB_INTAKES,
  BB_LAUNCH_LINE_FRAC,
  BB_LAUNCH_Z0,
  BB_PLACE_REACH,
  BB_SIDE_ROLLER_OUT,
  BB_SIDE_ROLLER_PROTRUDE,
  BB_SIDE_ROLLER_R,
  BB_TURRET_AXLE_Z,
  bbHead,
  bbIntakeReach,
  bbSideRollerY,
} from './config';
import { EDGE_DIR, EDGE_PERP, MOUNT_DIR, bbIntakeEdges, bbIntakeMountOf, edgeGeom, type BbEdge } from './mounts';
import { bbIntakeKindOf, bbLauncherOf, bbLiftOf } from './mechs';
import type { LocalRect } from './state';

/**
 * BIOBUZZ MECHANISMS ON AN IMPORTED ROBOT — the game's half of `src/sim/importedMech.ts`. Every
 * reader in this game that asks "where is the mouth / the turret / the release / the Box Tube"
 * branches here on `spec.imported`, and nowhere else, so a standard robot never reaches it.
 *
 * Kept out of `robot.ts` so `config.ts` (which `robot.ts` imports) can share the Box Tube point
 * without a cycle, and out of `mounts.ts`, which stays a leaf that imports only `types`.
 */

/** the narrowest BIOBUZZ mouth an import gets, half-width (in): a NECTAR plus a plate each side */
export const BB_IMPORT_MOUTH_MIN_HALF = 3;
/** ...and the widest */
export const BB_IMPORT_MOUTH_MAX_HALF = 9;
/** release heights an import may place (in): a turret's axle above the deck, a dumper's lip */
export const BB_IMPORT_TURRET_Z = { min: 7.5, max: 18 } as const;
export const BB_IMPORT_DUMP_Z = { min: 6, max: 18 } as const;

/**
 * The mouths on the edges `intakeMount` names, fitted to the hull (`resolveImportMouth`). The
 * archetype's own hardware that stands past the roller line — a `siderollers` wheel's front
 * quadrant, `BB_SIDE_ROLLER_PROTRUDE` — is INSIDE the CAD hull, so the roller line is that much
 * behind where the hull ends: the wheels land on the hull's front face, and every FLOWER window
 * measured from the roller line holds.
 */
export function bbImportMouths(spec: RobotSpec): ImportMouth[] {
  const imp = spec.imported!;
  const reach = bbIntakeReach(spec);
  const protrude = bbIntakeKindOf(spec) === 'siderollers' ? BB_SIDE_ROLLER_PROTRUDE : 0;
  return bbIntakeEdges(bbIntakeMountOf(spec)).map((edge) =>
    resolveImportMouth(imp, edge, {
      reach,
      depth: BB_INTAKES[BB_DEFAULT_INTAKE].depth,
      protrude,
      minHalf: BB_IMPORT_MOUTH_MIN_HALF,
      maxHalf: BB_IMPORT_MOUTH_MAX_HALF,
    }),
  );
}

/** the mouths as the `LocalRect`s `bbMouths` publishes, each carrying its chassis `face` */
export function bbImportMouthRects(spec: RobotSpec): LocalRect[] {
  return bbImportMouths(spec).map((m) => ({ edge: m.edge, ...importMouthRect(m), face: m.face }));
}

/** what on an imported robot is solid to a ground POLLEN: the hull with its mouths open, a side
 *  plate each side of each (`carveImportPlates`) */
export function bbImportSolids(spec: RobotSpec): { chassis: Vec2[]; structure: Vec2[][] } {
  return carveImportPlates(spec.imported!.hull, bbImportMouths(spec), INTAKE_RAIL_T);
}

/** does `world` place an IMPORT's side rollers as before `SIM_PATCH` 6 — a replay recorded then
 *  (a live world never does)? Read by `bbSideRollerOffsets`' and `import3dShapes`' callers and by
 *  the FLOWER gate. A standard robot steps the same either way. */
export function importSideRollersPre6(world: { simPatch?: number }): boolean {
  return !simPatchAtLeast(world, 6);
}

/** does `world` build an import's 3D bands without their cuts (`bbImportClipReach`), as before
 *  `SIM_PATCH` 7? Only a replay recorded then. */
export function importBandCutsPre7(world: { simPatch?: number }): boolean {
  return !simPatchAtLeast(world, 7);
}

/** the mouth frame a side roller is placed in: `mouthAxes`' fields, or an `ImportMouth`'s */
export interface BbSideRollerFrame {
  n: Vec2;
  p: Vec2;
  uOut: number;
  vc: number;
  half: number;
}

/**
 * ⚠️ **AN IMPORT'S SIDE ROLLERS ARE INSIDE ITS OWN HULL** (`SIM_PATCH` 6; owner, 2026-10-04: "side
 * rollers cant actually intake from flower because of weird footprint"). The standard rule puts
 * each wheel `bbSideRollerY(half)` off the mouth's centre, 0.1 in inside the span's end. On an
 * import the span is the hull's width and the CAD's own wheels sit in its front CORNERS, which a
 * convex hull rounds: on the vendor mecanum starter bot the hull's corner vertices lie on the CAD
 * wheel's own circle, and the standard rule put the sim's wheel 1.14 in outboard of it, poking
 * 0.9 in out of the robot's side where the CAD has nothing.
 *
 * So the wheel moves inboard, at the same `u` (its front on the hull's front line), until the
 * whole `BB_SIDE_ROLLER_R` circle is inside the hull: one half-plane test per hull edge that leans
 * toward side `s`, closed form, no iteration. A hull with square corners never binds (its flank is
 * `R` from the axis where the standard rule leaves `R + 0.1`), so an import shaped like a standard
 * chassis keeps the standard wheel. Measured on that starter bot: 6.06 in off the centre against
 * the CAD wheel's 6.14. Never past the mouth's centre. NO TRIG: `Math.sqrt` for each edge's length.
 */
export function bbImportSideRollerV(hull: readonly Vec2[], ax: BbSideRollerFrame, s: 1 | -1): number {
  const u = ax.uOut + BB_SIDE_ROLLER_OUT;
  // the axis at v = 0, robot-local: the mouth's centre on the axis line
  const ox = ax.n.x * u + ax.p.x * ax.vc;
  const oy = ax.n.y * u + ax.p.y * ax.vc;
  let v = bbSideRollerY(ax.half);
  const k = hull.length;
  for (let i = 0; i < k; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % k];
    // outward normal of a CCW edge, unnormalised; inside is N·x ≤ N·a
    const nx = b.y - a.y;
    const ny = -(b.x - a.x);
    const np = s * (nx * ax.p.x + ny * ax.p.y);
    if (!(np > 0)) continue; // this edge does not bound the wheel's lateral travel toward `s`
    const len = Math.sqrt(nx * nx + ny * ny);
    // N·(o + s·v·p) + R·|N| ≤ N·a, i.e. v·np ≤ room
    const room = nx * a.x + ny * a.y - BB_SIDE_ROLLER_R * len - (nx * ox + ny * oy);
    // an edge the wheel stands proud of even on the mouth's centre is a FRONT edge (a front that
    // is not dead square to the wheelbase: the vendor bot's leans 0.015 in over 12.6), and moving
    // inboard cannot clear it — it does not bound the lateral travel
    if (room < 0) continue;
    v = Math.min(v, room / np);
  }
  return Math.max(0, v);
}

/**
 * THE SIDE ROLLERS' LATERAL OFFSETS off one mouth's centre `vc`: `[+p side, −p side]`, both ≥ 0.
 * A standard robot (and an import in a replay recorded before `SIM_PATCH` 6, `pre6`) has
 * `bbSideRollerY(half)` both sides; an import has `bbImportSideRollerV`. The ONE placement the
 * FLOWER gate (`play.ts`), the 3D wheels (`chassis3dReachShapes`), the tutorial and both
 * renderers read.
 */
export function bbSideRollerOffsets(spec: RobotSpec, ax: BbSideRollerFrame, pre6 = false): readonly [number, number] {
  if (!spec.imported || pre6) {
    const y = bbSideRollerY(ax.half);
    return [y, y];
  }
  const hull = spec.imported.hull;
  return [bbImportSideRollerV(hull, ax, 1), bbImportSideRollerV(hull, ax, -1)];
}

/**
 * ⚠️ **AN IMPORT'S 3D BODY STOPS AT THE ROLLER LINE INSIDE A SIDE-ROLLER MOUTH** (`SIM_PATCH` 6).
 * `bbImportMouths` already says the hull's last `BB_SIDE_ROLLER_PROTRUDE` past the roller line,
 * across the span, is the side rollers' own front quadrant. Before patch 6 the 3D bands stayed
 * solid there, floor to band top: the vendor mecanum starter bot's lowest band is one prism from
 * the tiles to 5 in whose front IS its rollers' front, so a FLOWER's lower plate (z ≤ 0.354) and
 * mid plate (z ≥ 3.904) both stopped it on their edge and its wheels, whose front is that same
 * face, stood 0.85 in short of the bottom POLLEN. Its CAD has nothing there at those heights: under
 * 1 in the front is the drive wheels at x ≤ 6.9, and over the mid plate's height it is x ≤ 8.7.
 *
 * So, exactly as on a standard side-roller robot, the body ends at the roller line inside the span
 * and the two wheel cylinders are what stands past it (`chassis3dReachShapes`). Returns `poly`
 * less the strip `n·x > uOut`, `|p·x − vc| < half`, per mouth, as convex pieces (the part behind
 * the line and whatever of the hull lies past it outside the span), slivers dropped. A polygon the
 * strip misses comes back as itself, vertex for vertex.
 *
 * ⚠️ **INSIDE THE SPAN, THE BODY ALSO STOPS AT THE MODEL'S OWN EDGE** (`SIM_PATCH` 7, the band's
 * `cuts`). A band is one convex prism, so between two side rollers it bridges the gap at the
 * roller line. The same bot's frame between its rollers stands 0.3–0.5 in behind that line at a
 * FLOWER's middle plate (z 3.9–5.3); on the real robot the plate goes into that gap, and in 3D it
 * stopped on the bridge. Each cut on the mouth's edge, clipped to the span, takes the band back
 * to its `at`, never behind the mouth's `face`: it only removes what the model says is empty.
 */
export function bbImportClipReach(poly: readonly Vec2[], mouths: readonly ImportMouth[], cuts: readonly ImportedCut[] = []): Vec2[][] {
  let pieces: Vec2[][] = [poly.map((q) => ({ x: q.x, y: q.y }))];
  for (const m of mouths) {
    const next: Vec2[][] = [];
    for (const q of pieces) {
      const behind = clipHalf(q, m.n.x, m.n.y, m.uOut);
      const beyond = clipHalf(q, -m.n.x, -m.n.y, -m.uOut);
      if (beyond.length === 0 || polyArea(beyond) < IMPORT_PIECE_MIN_AREA) {
        next.push(q); // the strip does not cut it
        continue;
      }
      if (behind.length > 0) next.push(behind);
      // past the line, only what is outside the span: p·x ≥ vc + half, and p·x ≤ vc − half
      next.push(clipHalf(beyond, -m.p.x, -m.p.y, -(m.vc + m.half)));
      next.push(clipHalf(beyond, m.p.x, m.p.y, m.vc - m.half));
    }
    pieces = next.filter((q) => q.length >= 3 && polyArea(q) >= IMPORT_PIECE_MIN_AREA);
    for (const c of cuts) {
      if (c.edge !== m.edge) continue;
      const [v0, v1] = spanToV(c.edge, c.from, c.to);
      const a = Math.max(v0, m.vc - m.half);
      const b = Math.min(v1, m.vc + m.half);
      const line = clamp(c.at * (m.n.x + m.n.y), m.face, m.uOut);
      if (!(b > a) || !(line < m.uOut)) continue;
      const notched: Vec2[][] = [];
      for (const q of pieces) {
        // what the cut removes: a ≤ v ≤ b, past the line
        let gone = clipHalf(q, -m.n.x, -m.n.y, -line);
        gone = clipHalf(clipHalf(gone, m.p.x, m.p.y, b), -m.p.x, -m.p.y, -a);
        if (gone.length < 3 || polyArea(gone) < IMPORT_PIECE_MIN_AREA) {
          notched.push(q);
          continue;
        }
        notched.push(clipHalf(q, m.p.x, m.p.y, a)); // v ≤ a
        notched.push(clipHalf(q, -m.p.x, -m.p.y, -b)); // v ≥ b
        notched.push(clipHalf(clipHalf(clipHalf(q, -m.p.x, -m.p.y, -a), m.p.x, m.p.y, b), m.n.x, m.n.y, line));
      }
      pieces = notched.filter((q) => q.length >= 3 && polyArea(q) >= IMPORT_PIECE_MIN_AREA);
    }
  }
  return pieces;
}

/** the placed launcher point for turret `which` (`shooter`, or a double turret's `shooter2`) */
function placedHead(spec: RobotSpec, which: 0 | 1): { x: number; y: number; z: number } | undefined {
  const mech = spec.imported?.mech;
  if (!mech) return undefined;
  return which === 1 ? mech.shooter2 : mech.shooter;
}

/**
 * The turret's FLYWHEEL AXLE height on an import (in): the placed release height less the head's
 * path radius — `BB_TURRET_PITCH_MIN` is 0, so the rest-pitch muzzle `axle + pathR` is exactly the
 * height the player set, and elevating drops it by `pathR(1 − cos p)` as on a standard head. No
 * placed head ⇒ the standard axle.
 */
export function bbImportTurretAxleZ(spec: RobotSpec, which: 0 | 1): number {
  const p = placedHead(spec, which);
  if (!p) return BB_TURRET_AXLE_Z;
  return clamp(p.z, BB_IMPORT_TURRET_Z.min, BB_IMPORT_TURRET_Z.max) - bbHead(which).pathR;
}

/** a turretless launcher's release height on an import: the placed lip, else the standard tray */
export function bbImportDumpZ(spec: RobotSpec): number {
  const p = spec.imported?.mech?.shooter;
  return p ? clamp(p.z, BB_IMPORT_DUMP_Z.min, BB_IMPORT_DUMP_Z.max) : BB_LAUNCH_Z0;
}

/** the release height a DUMPER's elements leave at, any robot (`BB_LAUNCH_Z0` on a standard one) */
export function bbDumpZ(spec: RobotSpec): number {
  return spec.imported ? bbImportDumpZ(spec) : BB_LAUNCH_Z0;
}

/**
 * A turretless launcher's release LINE on an import, robot-local: centred on the placed lip
 * (`mech.shooter`), else where the hull ends along the firing edge's normal from the hull's
 * bounding-box centre; spread across the edge no further than the hull reaches through that point.
 */
export function bbImportLaunchLine(spec: RobotSpec, edge: BbEdge, spanHalf: number): { origin: Vec2; half: number } {
  const imp = spec.imported!;
  const sh = imp.mech?.shooter;
  const b = polyBounds(imp.hull);
  const origin = sh ? { x: sh.x, y: sh.y } : rayExit(imp.hull, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, EDGE_DIR[edge]);
  const perp = { x: -EDGE_DIR[edge].y, y: EDGE_DIR[edge].x };
  return { origin, half: Math.min(spanHalf, importHalfChordThrough(imp, origin, perp)) };
}

/**
 * A turretless launcher's release line IN ITS FIRING EDGE'S FRAME, for the renderers: `dist` out
 * along the edge's normal to the line's centre, `lateral` across the edge, `span` the half-length
 * the line takes before `BB_LAUNCH_LINE_FRAC`. A standard robot's is its edge, centred
 * (`edgeGeom`); an IMPORT's is `bbImportLaunchLine`, asked with exactly the arguments `robot.ts`'s
 * `launchLine` asks it with — so the drawn tray's lip is where the sim releases from.
 */
export function bbDumperFrame(spec: RobotSpec, edge: BbEdge): { dist: number; span: number; lateral: number; room?: number } {
  const g = edgeGeom(spec, edge);
  if (!spec.imported) return { dist: g.dist, span: g.span, lateral: 0 };
  const line = bbImportLaunchLine(spec, edge, g.span * BB_LAUNCH_LINE_FRAC);
  const n = EDGE_DIR[edge];
  const p = EDGE_PERP[edge];
  // how much hull there is BEHIND the lip along the firing direction — the tray (render-only) is
  // sized to it, since a placed lip can sit anywhere on the hull, not only on its edge
  const back = rayExit(spec.imported.hull, line.origin, { x: -n.x, y: -n.y });
  return {
    dist: line.origin.x * n.x + line.origin.y * n.y,
    span: line.half / BB_LAUNCH_LINE_FRAC,
    lateral: line.origin.x * p.x + line.origin.y * p.y,
    room: (line.origin.x - back.x) * n.x + (line.origin.y - back.y) * n.y,
  };
}

/** the Box Tube's placement point on an import: out of the hull from its base along the mount's
 *  direction, then `BB_PLACE_REACH` (`importPlacePoint`) */
export function bbImportPlacePoint(spec: RobotSpec): Vec2 | null {
  const lift = bbLiftOf(spec);
  if (!lift || !spec.imported) return null;
  return importPlacePoint(spec.imported, MOUNT_DIR[lift.mount], BB_PLACE_REACH);
}

/** is launcher `which` a placed head on this import? (validation and the editor read it) */
export function bbImportHasHead(spec: RobotSpec, which: 0 | 1): boolean {
  if (which === 1 && bbLauncherOf(spec, 45).kind !== 'twinturret') return false;
  return !!placedHead(spec, which);
}
