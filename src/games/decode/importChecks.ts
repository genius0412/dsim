import type { ImportedMech, RobotSpec } from '../../types';
import * as C from '../../config';
import {
  chordAt,
  decodeImportLaunchZ,
  decodeImportMouth,
  decodeImportTurret,
  decodeMouthHalfRange,
  DECODE_IMPORT_LAUNCH_MIN,
} from '../../sim/importedMech';
import { coercedMech, defaultSpans, heightIssue, inches, mouthIssues, spanHandles, unplacedIssue, withoutMech } from '../importChecks';
import type { ImportMechHandle, ImportMechIssue, ImportMechSlot } from '../types';

/**
 * DECODE's placement handles, pre-fills and checks for an imported robot (`GameSimModule.
 * importMech`). DECODE's intake faces FORWARD — the preset funnels and the vector row are front
 * hardware, and the sim reads the `front` span only — so a robot whose intake is at its back turns
 * its front in the importer's Model step.
 */

function handles(spec: RobotSpec): ImportMechHandle[] {
  // a FIXED launcher (`spec.launcher`) fires along its facing, which the editor sets beside the
  // point; a turret aims itself and has none
  const facing = spec.launcher === 'fixed' ? { facingDeg: spec.imported?.mech?.shooterYawDeg ?? 0 } : {};
  return [
    // NO INTAKE has no span to place (the human player loads it)
    ...(C.noIntake(spec) ? [] : spanHandles(['front'])),
    { key: 'shooter', kind: 'point', label: spec.launcher === 'fixed' ? 'Fixed launcher' : 'Launcher', z: decodeImportLaunchZ(spec), zMin: DECODE_IMPORT_LAUNCH_MIN, zMax: 18, ...facing },
  ];
}

function defaults(spec: RobotSpec): ImportedMech {
  const bare = withoutMech(spec);
  const imp = bare.imported!;
  const t = decodeImportTurret(bare);
  return coercedMech(imp, {
    ...(C.noIntake(spec) ? {} : { intakes: defaultSpans([decodeImportMouth(bare).m]) }),
    shooter: { x: t.x, y: t.y, z: Math.min(C.LAUNCH_HEIGHT, imp.heightIn) },
    // a FIXED launcher starts facing forward, the way the standard one fires
    ...(spec.launcher === 'fixed' ? { shooterYawDeg: 0 } : {}),
  });
}

function issues(spec: RobotSpec): ImportMechIssue[] {
  const imp = spec.imported!;
  if (C.noIntake(spec)) {
    // NO INTAKE: only the launcher to check; its artifacts are stored on the centreline by hand
    const sh = imp.mech?.shooter;
    const out: ImportMechIssue[] = [];
    if (!sh) out.push(unplacedIssue('shooter', 'The launcher'));
    out.push(...heightIssue('shooter', 'Launcher', sh?.z, DECODE_IMPORT_LAUNCH_MIN, 18));
    return out;
  }
  const d = decodeImportMouth(spec);
  const out = mouthIssues(imp, [d.m], decodeMouthHalfRange(spec.intake).min, 'DECODE intakes face forward: turn the robot’s front in the Model step.');
  const sh = imp.mech?.shooter;
  if (!sh) out.push(unplacedIssue('shooter', 'The launcher'));
  out.push(...heightIssue('shooter', 'Launcher', sh?.z, DECODE_IMPORT_LAUNCH_MIN, 18));
  // three artifacts are stored in a line behind the roller (a triangle: one deep, two beside)
  const back = chordAt(imp.hull, { x: 0, y: 1 }, { x: 1, y: 0 }, d.yc);
  const room = back ? d.tip - back[0] : 0;
  const need = spec.intake === 'triangle' ? d.tip - d.face + 6 + C.BALL_RADIUS : 6 * C.BALL_RADIUS;
  if (room < need) {
    out.push({
      level: 'warn',
      code: 'held-room',
      text: `There’s ${inches(room)} behind the intake to store three artifacts, which need ${inches(need)}. They will overlap the back of the robot.`,
      handle: 'intake:front',
    });
  }
  if (imp.heightIn < C.intakeLidZ(spec)) {
    out.push({
      level: 'warn',
      code: 'top-below-roller',
      text: `The robot is ${inches(imp.heightIn)} tall, lower than this intake’s rollers (${inches(C.intakeLidZ(spec))}). Check the units in the Model step.`,
    });
  }
  return out;
}

export const DECODE_IMPORT_MECH: ImportMechSlot = { issues, defaults, handles };
