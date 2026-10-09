import type { ImportedMech, RobotSpec } from '../../types';
import { hyp } from '../../math';
import { importPlaceExit } from '../../sim/importedMech';
import { coercedMech, defaultSpans, heightIssue, inches, inward, mouthIssues, spanHandles, unplacedIssue, withoutMech } from '../importChecks';
import type { ImportMechHandle, ImportMechIssue, ImportMechSlot } from '../types';
import { BB_DECK_Z, BB_LAUNCH_LINE_FRAC, BB_LAUNCH_Z0 } from './config';
import {
  BB_IMPORT_DUMP_Z,
  BB_IMPORT_MOUTH_MIN_HALF,
  BB_IMPORT_TURRET_Z,
  bbDumpZ,
  bbImportLaunchLine,
  bbImportMouths,
  bbImportTurretAxleZ,
} from './importMech';
import { bbIntakeEdges, bbIntakeMountOf, bbShooterEdgeOf, EDGE_ANGLE, edgeGeom, MOUNT_DIR, turretLocal } from './mounts';
import { bbLauncherOf, bbLiftOf } from './mechs';
import { bbHead } from './config';

/**
 * BIOBUZZ's placement handles, pre-fills and checks for an imported robot (`GameSimModule.
 * importMech`). The archetype controls (launcher and intake kinds, the intake mount, the Box Tube
 * and its direction) stay the builder's; the CAD gives the positions.
 */

/** two turret heads closer than this would hit each other (in) */
export const BB_IMPORT_TWIN_MIN_GAP = 6;

function launcherOf(spec: RobotSpec) {
  return bbLauncherOf(spec, 45);
}

function handles(spec: RobotSpec): ImportMechHandle[] {
  const out: ImportMechHandle[] = [...spanHandles(bbIntakeEdges(bbIntakeMountOf(spec)))];
  const l = launcherOf(spec);
  if (l.kind === 'dumper') {
    out.push({ key: 'shooter', kind: 'point', label: 'Dumper lip', z: bbDumpZ(spec), zMin: BB_IMPORT_DUMP_Z.min, zMax: BB_IMPORT_DUMP_Z.max });
  } else if (l.kind === 'fixed') {
    // the FIXED shooter's release lip, at the dumper's height range (both read `bbDumpZ`), and the
    // direction it fires — its edge until the player turns it
    const facingDeg = spec.imported?.mech?.shooterYawDeg ?? Math.round((EDGE_ANGLE[bbShooterEdgeOf({ shooterMount: l.mount })] * 180) / Math.PI);
    out.push({ key: 'shooter', kind: 'point', label: 'Fixed shooter', z: bbDumpZ(spec), zMin: BB_IMPORT_DUMP_Z.min, zMax: BB_IMPORT_DUMP_Z.max, facingDeg });
  } else {
    const zOf = (which: 0 | 1) => bbImportTurretAxleZ(spec, which) + bbHead(which).pathR;
    out.push({ key: 'shooter', kind: 'point', label: l.kind === 'twinturret' ? 'Pollen turret' : 'Turret', z: zOf(0), zMin: BB_IMPORT_TURRET_Z.min, zMax: BB_IMPORT_TURRET_Z.max });
    if (l.kind === 'twinturret') {
      out.push({ key: 'shooter2', kind: 'point', label: 'Nectar turret', z: zOf(1), zMin: BB_IMPORT_TURRET_Z.min, zMax: BB_IMPORT_TURRET_Z.max });
    }
  }
  if (bbLiftOf(spec)) out.push({ key: 'place', kind: 'point', label: 'Box Tube' });
  return out;
}

function defaults(spec: RobotSpec): ImportedMech {
  const bare = withoutMech(spec);
  const imp = bare.imported!;
  const mech: ImportedMech = { intakes: defaultSpans(bbImportMouths(bare)) };
  const l = launcherOf(bare);
  const cap = (z: number) => Math.min(z, imp.heightIn);
  if (l.kind === 'dumper' || l.kind === 'fixed') {
    const edge = bbShooterEdgeOf({ shooterMount: l.mount });
    const line = bbImportLaunchLine(bare, edge, edgeGeom(bare, edge).span * BB_LAUNCH_LINE_FRAC);
    // a hair inside the hull's edge, so coercion keeps it where it is
    const o = inward(line.origin, MOUNT_DIR[edge], 0.5);
    mech.shooter = { x: o.x, y: o.y, z: cap(BB_LAUNCH_Z0) };
    // a FIXED shooter faces straight out of its edge until the player turns it
    if (l.kind === 'fixed') mech.shooterYawDeg = Math.round((EDGE_ANGLE[edge] * 180) / Math.PI);
  } else {
    const t0 = turretLocal(bare, l.mount);
    mech.shooter = { x: t0.x, y: t0.y, z: cap(bbImportTurretAxleZ(bare, 0) + bbHead(0).pathR) };
    if (l.kind === 'twinturret' && l.mount2) {
      const t1 = turretLocal(bare, l.mount2);
      mech.shooter2 = { x: t1.x, y: t1.y, z: cap(bbImportTurretAxleZ(bare, 1) + bbHead(1).pathR) };
    }
  }
  const lift = bbLiftOf(bare);
  if (lift) {
    const dir = MOUNT_DIR[lift.mount];
    const b = inward(importPlaceExit(imp, dir), dir, 2);
    mech.place = { x: b.x, y: b.y, z: cap(BB_DECK_Z) };
  }
  return coercedMech(imp, mech);
}

function issues(spec: RobotSpec): ImportMechIssue[] {
  const imp = spec.imported!;
  const out = mouthIssues(imp, bbImportMouths(spec), BB_IMPORT_MOUTH_MIN_HALF, 'Pick that edge in the intake mount to use it.');
  const l = launcherOf(spec);
  const m = imp.mech;
  if (!m?.shooter) out.push(unplacedIssue('shooter', l.kind === 'dumper' ? 'The dumper' : l.kind === 'fixed' ? 'The fixed shooter' : 'The turret'));
  if (l.kind === 'fixed') {
    out.push(...heightIssue('shooter', 'Fixed shooter', m?.shooter?.z, BB_IMPORT_DUMP_Z.min, BB_IMPORT_DUMP_Z.max));
  } else if (l.kind === 'dumper') {
    out.push(...heightIssue('shooter', 'Dumper', m?.shooter?.z, BB_IMPORT_DUMP_Z.min, BB_IMPORT_DUMP_Z.max));
  } else {
    out.push(...heightIssue('shooter', 'Turret', m?.shooter?.z, BB_IMPORT_TURRET_Z.min, BB_IMPORT_TURRET_Z.max));
    if (l.kind === 'twinturret') {
      if (!m?.shooter2) out.push(unplacedIssue('shooter2', 'The nectar turret'));
      out.push(...heightIssue('shooter2', 'Nectar turret', m?.shooter2?.z, BB_IMPORT_TURRET_Z.min, BB_IMPORT_TURRET_Z.max));
      const a = turretLocal(spec, l.mount);
      const b = turretLocal(spec, l.mount2 ?? l.mount);
      const gap = hyp(a.x - b.x, a.y - b.y);
      if (gap < BB_IMPORT_TWIN_MIN_GAP) {
        out.push({
          level: 'block',
          code: 'twin-too-close',
          text: `The two turrets are ${inches(gap)} apart. Move them at least ${inches(BB_IMPORT_TWIN_MIN_GAP)} apart.`,
          handle: 'shooter2',
        });
      }
    }
  }
  if (bbLiftOf(spec) && !m?.place) out.push(unplacedIssue('place', 'The Box Tube'));
  if (imp.heightIn > 8 && !(imp.bands && imp.bands.length > 0)) {
    out.push({
      level: 'warn',
      code: 'no-bands',
      text: `This model has no height profile, so in 3D its whole footprint is solid up to ${inches(imp.heightIn)}. It can catch under the hive where the real robot would pass.`,
    });
  }
  return out;
}

export const BB_IMPORT_MECH: ImportMechSlot = { issues, defaults, handles };
