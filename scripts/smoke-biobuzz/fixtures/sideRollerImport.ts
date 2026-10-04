import type { ImportedRobot, RobotSpec } from '../../../src/types';
import { BB_FIXED_HOOD_DEFAULT_DEG } from '../../../src/games/biobuzz/config';

/**
 * A REAL SIDE-ROLLER IMPORT, AS NUMBERS: the descriptor the production editor saved for a vendor's
 * BIOBUZZ mecanum starter bot (17.8 × 17.8 × 12.2 in, Full detail, 2026-10-04,
 * `scripts/robot-import/realcadprobe.cjs`). Only derived numbers: the hull, the three height bands,
 * the wheel contacts and the placed mechanisms, robot-local inches. The vendor's file is never
 * committed.
 *
 * Its intake is a horizontal roller bar across the front and two UPRIGHT side rollers (72 mm
 * compliant wheels, axle vertical) at the front corners. The hull's front corners ARE those
 * wheels: the vertices at (9.734, −6.281), (9.578, −6.813), (9.234, −7.234) lie on one circle.
 */
export const SIDE_ROLLER_IMPORT: ImportedRobot = {
  v: 1,
  id: '151653d97fac7c66',
  hull: [
    { x: -8.046875, y: -7.09375 }, { x: -7.234375, y: -8.703125 }, { x: -7.125, y: -8.8125 }, { x: -6.796875, y: -8.90625 },
    { x: 6.90625, y: -8.890625 }, { x: 9.234375, y: -7.234375 }, { x: 9.578125, y: -6.8125 }, { x: 9.734375, y: -6.28125 },
    { x: 9.71875, y: 6.34375 }, { x: 9.5625, y: 6.828125 }, { x: 9.234375, y: 7.21875 }, { x: 7, y: 8.875 },
    { x: -6.15625, y: 8.890625 }, { x: -7.078125, y: 8.84375 }, { x: -7.171875, y: 8.796875 }, { x: -8.046875, y: 7.078125 },
  ],
  heightIn: 12.171875,
  wheels: [{ x: 5.1875, y: 8.140625 }, { x: 5.1875, y: -8.140625 }, { x: -5.1875, y: 8.140625 }, { x: -5.1875, y: -8.140625 }],
  bands: [
    {
      z0: 0,
      z1: 5,
      hull: [
        { x: -8.046875, y: -7.09375 }, { x: -7.125, y: -8.8125 }, { x: -6.796875, y: -8.90625 }, { x: 6.90625, y: -8.890625 },
        { x: 9.265625, y: -6.953125 }, { x: 9.546875, y: -6.375 }, { x: 9.546875, y: 6.375 }, { x: 9.265625, y: 6.9375 },
        { x: 7, y: 8.875 }, { x: -7.171875, y: 8.796875 }, { x: -8.046875, y: 7.078125 },
      ],
    },
    {
      z0: 5,
      z1: 8.5,
      hull: [
        { x: -7.96875, y: -1.78125 }, { x: -5.78125, y: -6.625 }, { x: -5.375, y: -6.875 }, { x: -5.1875, y: -6.890625 },
        { x: 7.28125, y: -4.890625 }, { x: 7.59375, y: -4.421875 }, { x: 8.21875, y: 5.046875 }, { x: 0.234375, y: 6.9375 },
        { x: -1.03125, y: 7.140625 }, { x: -5.4375, y: 6.84375 }, { x: -5.8125, y: 6.5625 }, { x: -7.96875, y: 1.71875 },
      ],
    },
    {
      z0: 8.5,
      z1: 12.171875,
      hull: [
        { x: -4.90625, y: -3.625 }, { x: -3.015625, y: -3.625 }, { x: 1.8125, y: -3.46875 }, { x: 2.5, y: 3.453125 },
        { x: 2.5, y: 3.46875 }, { x: -3.015625, y: 3.609375 }, { x: -4.90625, y: 3.609375 },
      ],
    },
  ],
  mech: { shooter: { x: 0.84375, y: 0, z: 9.640625 }, intakes: [{ edge: 'front', from: -8.890625, to: 8.875 }] },
};

/**
 * THE CAD'S OWN SIDE ROLLERS, measured off the stored mesh's vertices (robot-local inches): the
 * two wheel solids span x 6.91 … 9.73, y ±(4.72 … 7.55), z 1.06 … 2.06, so each is a 1.41-in
 * wheel about (8.32, ±6.14). Nothing else on the robot stands past x 8.7 at the FLOWER's
 * plate heights (z ≤ 0.354 and 3.904 … 5.254); between z 1.0 and 2.25 the rollers are the front.
 */
export const SIDE_ROLLER_IMPORT_CAD_WHEEL = { x: 8.32, y: 6.14, r: 1.41 } as const;

/** the build the owner made of it: side rollers on the front, a fixed launcher, no Box Tube —
 *  the fields the BIOBUZZ Builder writes (`Builder.tsx` `send`) */
export const SIDE_ROLLER_IMPORT_BUILD: Partial<RobotSpec> = {
  intakeMount: 'front',
  scoreMode: 'dumper',
  shooterMount: 'back',
  bbMech: { launcher: { kind: 'fixed', mount: 'back', hoodDeg: BB_FIXED_HOOD_DEFAULT_DEG }, lift: null, intake: { kind: 'siderollers' } } as RobotSpec['bbMech'],
  imported: SIDE_ROLLER_IMPORT,
};
