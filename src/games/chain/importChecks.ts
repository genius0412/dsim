import type { ImportedMech, RobotSpec } from '../../types';
import { importPlaceExit, type ImportMouth } from '../../sim/importedMech';
import { coercedMech, defaultSpans, heightIssue, inward, mouthIssues, spanHandles, unplacedIssue, withoutMech } from '../importChecks';
import type { ImportMechHandle, ImportMechIssue, ImportMechSlot } from '../types';
import { CHAIN_DEFAULT_CATALYST, CHAIN_DEFAULT_SCORE_MODE, CHAIN_LAUNCH_Z0 } from './config';
import {
  CHAIN_IMPORT_LAUNCH_Z,
  CHAIN_IMPORT_MOUTH_MIN_HALF,
  chainImportLaunchLine,
  chainImportMouthsResolved,
  chainImportLaunchZ,
  chainImportRailHalf,
} from './importMech';
import {
  MOUNT_DIR,
  catalystMountOf,
  catalystMountPositions,
  catalystSwingOf,
  edgeGeom,
  intakeMountEdges,
  intakeMountOf,
  isEdgePos,
  isTurreted,
  shooterEdgeOf,
  turretLocal,
} from './mounts';

/**
 * Chain Reaction's placement handles, pre-fills and checks for an imported robot
 * (`GameSimModule.importMech`). The archetype controls stay the builder's; the CAD gives the
 * positions: the sweeper spans, the launcher (a turret's axis or a turretless line's lip) and the
 * catalyst mechanism's base.
 */

function mouths(spec: RobotSpec): ImportMouth[] {
  return chainImportMouthsResolved(spec);
}

function turreted(spec: RobotSpec): boolean {
  return isTurreted(spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE);
}

function handles(spec: RobotSpec): ImportMechHandle[] {
  const t = turreted(spec);
  return [
    ...spanHandles(intakeMountEdges(intakeMountOf(spec))),
    {
      key: 'shooter',
      kind: 'point',
      label: t ? 'Turret' : 'Launcher',
      z: chainImportLaunchZ(spec, t ? 8 : CHAIN_LAUNCH_Z0),
      zMin: CHAIN_IMPORT_LAUNCH_Z.min,
      zMax: CHAIN_IMPORT_LAUNCH_Z.max,
    },
    { key: 'place', kind: 'point', label: 'Catalyst mechanism' },
  ];
}

function defaults(spec: RobotSpec): ImportedMech {
  const bare = withoutMech(spec);
  const imp = bare.imported!;
  const mech: ImportedMech = { intakes: defaultSpans(mouths(bare)) };
  const cap = (z: number) => Math.min(z, imp.heightIn);
  if (turreted(bare)) {
    const o = turretLocal(bare);
    mech.shooter = { x: o.x, y: o.y, z: cap(8) };
  } else {
    const edge = shooterEdgeOf(bare);
    const line = chainImportLaunchLine(bare, edge, edgeGeom(bare, edge).span);
    const o = inward(line.origin, MOUNT_DIR[edge], 0.5);
    mech.shooter = { x: o.x, y: o.y, z: cap(CHAIN_LAUNCH_Z0) };
  }
  // the catalyst's base, two inches in from where it works (its first working end for a swing)
  const pos = catalystMountPositions(catalystMountOf(bare), catalystSwingOf(bare))[0];
  const b = inward(importPlaceExit(imp, MOUNT_DIR[pos]), MOUNT_DIR[pos], 2);
  mech.place = { x: b.x, y: b.y, z: cap(6) };
  return coercedMech(imp, mech);
}

function issues(spec: RobotSpec): ImportMechIssue[] {
  const imp = spec.imported!;
  const out = mouthIssues(imp, mouths(spec), CHAIN_IMPORT_MOUTH_MIN_HALF, 'Pick that edge in the intake mount to use it.');
  const m = imp.mech;
  if (!m?.shooter) out.push(unplacedIssue('shooter', turreted(spec) ? 'The turret' : 'The launcher'));
  out.push(...heightIssue('shooter', turreted(spec) ? 'Turret' : 'Launcher', m?.shooter?.z, CHAIN_IMPORT_LAUNCH_Z.min, CHAIN_IMPORT_LAUNCH_Z.max));
  if (!m?.place) out.push(unplacedIssue('place', 'The catalyst mechanism'));
  const mount = catalystMountOf(spec);
  if ((spec.catalystType ?? CHAIN_DEFAULT_CATALYST) === 'rail' && isEdgePos(mount) && chainImportRailHalf(spec, mount) < 1) {
    out.push({
      level: 'block',
      code: 'rail-no-room',
      text: `The ${mount} edge has no room for a rail where the catalyst mechanism is. Move it along the edge or pick another edge.`,
      handle: 'place',
    });
  }
  return out;
}

export const CHAIN_IMPORT_MECH: ImportMechSlot = { issues, defaults, handles };
