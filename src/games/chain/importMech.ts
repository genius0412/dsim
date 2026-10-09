import type { ChainMountPos, RobotSpec, Vec2 } from '../../types';
import { INTAKE_PRESETS } from '../../config';
import { clamp } from '../../math';
import { importHalfChordThrough, importMouthRect, importPlaceExit, rayExit, resolveImportMouth, type ImportMouth } from '../../sim/importedMech';
import { polyBounds } from '../../sim/imported';
import { CHAIN_DEFAULT_INTAKE, CHAIN_INTAKES, CHAIN_RAIL_MARGIN } from './config';
import { EDGE_DIR, MOUNT_DIR, RAIL_DIR, intakeMountEdges, intakeMountOf, type ChainEdge } from './mounts';

/**
 * CHAIN REACTION MECHANISMS ON AN IMPORTED ROBOT — this game's half of `src/sim/importedMech.ts`.
 * The mouths, the launch point and height, and the catalyst's working point all come off the hull
 * and `imported.mech`; every reader branches here on `spec.imported`, so a standard robot never
 * reaches it.
 */

/** the narrowest / widest Chain Reaction mouth an import gets, half-width (in): two Particles */
export const CHAIN_IMPORT_MOUTH_MIN_HALF = 3;
export const CHAIN_IMPORT_MOUTH_MAX_HALF = 9;
/** the release heights an import may place (in) */
export const CHAIN_IMPORT_LAUNCH_Z = { min: 4, max: 18 } as const;

export interface ChainImportMouthRect {
  edge: ChainEdge;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** the chassis face along the edge's outward normal (a standard mouth's is `hl`/`hw`) */
  face: number;
}

/** the mouths on the edges `intakeMount` names, fitted to the hull (`resolveImportMouth`) */
export function chainImportMouthsResolved(spec: RobotSpec): ImportMouth[] {
  const imp = spec.imported!;
  const it = CHAIN_INTAKES[spec.chainIntake ?? CHAIN_DEFAULT_INTAKE];
  return intakeMountEdges(intakeMountOf(spec)).map((edge) =>
    resolveImportMouth(imp, edge, {
      reach: INTAKE_PRESETS[spec.intake].reach,
      depth: it.depth,
      protrude: 0,
      minHalf: CHAIN_IMPORT_MOUTH_MIN_HALF,
      maxHalf: CHAIN_IMPORT_MOUTH_MAX_HALF,
    }),
  );
}

/** ...as the robot-local rects `chainIntakeMouths` publishes, each with its chassis face */
export function chainImportMouths(spec: RobotSpec): ChainImportMouthRect[] {
  return chainImportMouthsResolved(spec).map((m) => ({ edge: m.edge as ChainEdge, ...importMouthRect(m), face: m.face }));
}

/** an import's release height: its placed one (clamped), else `fallback` — the standard 8 for a
 *  turret, `CHAIN_LAUNCH_Z0` for a turretless line */
export function chainImportLaunchZ(spec: RobotSpec, fallback: number): number {
  const z = spec.imported?.mech?.shooter?.z;
  return z === undefined ? fallback : clamp(z, CHAIN_IMPORT_LAUNCH_Z.min, CHAIN_IMPORT_LAUNCH_Z.max);
}

/** a turretless launch LINE on an import: centred on the placed lip, else where the hull ends along
 *  the firing edge's normal from its bounding-box centre; half-width no more than the hull's through
 *  that point (robot-local) */
export function chainImportLaunchLine(spec: RobotSpec, edge: ChainEdge, span: number): { origin: Vec2; half: number } {
  const imp = spec.imported!;
  const sh = imp.mech?.shooter;
  const b = polyBounds(imp.hull);
  const origin = sh ? { x: sh.x, y: sh.y } : rayExit(imp.hull, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, EDGE_DIR[edge]);
  const perp = { x: -EDGE_DIR[edge].y, y: EDGE_DIR[edge].x };
  return { origin, half: Math.min(span, importHalfChordThrough(imp, origin, perp)) };
}

/**
 * Where an imported robot's catalyst mechanism works FROM at `pos`: out of the hull from its base
 * (`mech.place`, else the hull box's centre) along that position's outward direction — the
 * standard mouth sits ON the frame line, and the claw's reach is measured from there, so it is
 * measured from the hull's edge here too.
 */
export function chainCatalystImportOrigin(spec: RobotSpec, pos: Exclude<ChainMountPos, 'center'>): Vec2 {
  return importPlaceExit(spec.imported!, MOUNT_DIR[pos]);
}

/** a rail carriage's half-travel on an import: the hull through the rail's origin along the rail,
 *  to the nearer end, less the carriage margin */
export function chainImportRailHalf(spec: RobotSpec, pos: Exclude<ChainMountPos, 'center'>): number {
  const o = chainCatalystImportOrigin(spec, pos);
  return Math.max(0, importHalfChordThrough(spec.imported!, o, RAIL_DIR[pos]) - CHAIN_RAIL_MARGIN);
}
