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

/**
 * THE SAME ROBOT AS THE PRODUCTION EDITOR SAVES IT SINCE `SIM_PATCH` 7 (2026-10-04, same CAD, Full
 * detail, `realcadprobe.cjs`): five bands, the FLOWER's middle plate (3.89 … 5.27 in) one of its own
 * with 0.1 in either side in no band, each band at or above it carrying its cuts (`computeBands`,
 * `bandCuts`). Between its side
 * rollers the frame at the plate's heights reaches x 7.67 and the cut says 7.70; the convex band
 * said 8.25, and the roller line 8.08. `SIDE_ROLLER_IMPORT` stays as the editor saved it before,
 * the descriptor every replay recorded under patch 6 carries.
 */
export const SIDE_ROLLER_IMPORT_V7: ImportedRobot = {
  ...SIDE_ROLLER_IMPORT,
  bands: [
    {
      z0: 0,
      z1: 1,
      hull: [
        { x: -7.875, y: -4.875 }, { x: -6.875, y: -8.1875 }, { x: -6.390625, y: -8.8125 }, { x: 6.15625, y: -8.890625 },
        { x: 6.625, y: -8.515625 }, { x: 6.9375, y: -7.8125 }, { x: 6.921875, y: 8.40625 }, { x: 6.640625, y: 8.859375 },
        { x: -6.71875, y: 8.84375 }, { x: -6.9375, y: 8.53125 }, { x: -7.875, y: 4.890625 },
      ],
    },
    {
      z0: 1,
      z1: 3.796875,
      hull: [
        { x: -8.046875, y: -7.09375 }, { x: -7.125, y: -8.8125 }, { x: -6.796875, y: -8.90625 }, { x: 6.90625, y: -8.890625 },
        { x: 9.265625, y: -6.953125 }, { x: 9.546875, y: -6.375 }, { x: 9.546875, y: 6.375 }, { x: 9.265625, y: 6.9375 },
        { x: 7, y: 8.875 }, { x: -7.078125, y: 8.84375 }, { x: -7.171875, y: 8.796875 }, { x: -8.046875, y: 7.078125 },
      ],
    },
    {
      z0: 3.890625,
      z1: 5.265625,
      hull: [
        { x: -6.609375, y: 1.703125 }, { x: -6.546875, y: -1.640625 }, { x: -6.078125, y: -8.015625 }, { x: -5.78125, y: -8.71875 },
        { x: -5.609375, y: -8.828125 }, { x: 5.65625, y: -8.796875 }, { x: 7.75, y: -4.234375 }, { x: 8.21875, y: 5.046875 },
        { x: 6, y: 8.421875 }, { x: 5.1875, y: 8.859375 }, { x: -5.34375, y: 8.796875 }, { x: -6.078125, y: 8.5 },
      ],
      cuts: [
        { edge: 'front', from: -3.296875, to: 3.328125, at: 7.703125 },
        { edge: 'front', from: 5.546875, to: 6.65625, at: 5.53125 },
        { edge: 'back', from: 2.234375, to: 3.328125, at: -3.171875 },
        { edge: 'back', from: 3.328125, to: 4.4375, at: -4.96875 },
        { edge: 'left', from: -2.90625, to: -0.125, at: 7.234375 },
        { edge: 'left', from: 1.734375, to: 3.578125, at: 5.25 },
        { edge: 'right', from: -1.96875, to: -0.125, at: -1.90625 },
        { edge: 'right', from: 0.8125, to: 2.65625, at: -3.84375 },
      ],
    },
    {
      z0: 5.359375,
      z1: 8.5,
      hull: [
        { x: -7.96875, y: -1.78125 }, { x: -5.828125, y: -6.578125 }, { x: -5.546875, y: -6.8125 }, { x: -5.1875, y: -6.890625 },
        { x: 7.234375, y: -4.890625 }, { x: 7.5625, y: -4.421875 }, { x: 7.640625, y: -4.171875 }, { x: 8.21875, y: 5.046875 },
        { x: -5.25, y: 6.875 }, { x: -5.59375, y: 6.78125 }, { x: -5.8125, y: 6.5625 }, { x: -7.9375, y: 1.828125 },
      ],
      cuts: [
        { edge: 'front', from: -6.890625, to: -5.171875, at: -4.421875 },
        { edge: 'front', from: -3.453125, to: 4.296875, at: 7.625 },
        { edge: 'back', from: 3.4375, to: 4.296875, at: -4.96875 },
        { edge: 'back', from: 4.296875, to: 5.15625, at: -2.859375 },
        { edge: 'left', from: -2.90625, to: -0.890625, at: 5.65625 },
        { edge: 'left', from: -0.890625, to: 3.15625, at: 3.671875 },
        { edge: 'right', from: -7.96875, to: -6.953125, at: -2.046875 },
        { edge: 'right', from: -1.890625, to: 3.15625, at: -3.6875 },
      ],
    },
    {
      z0: 8.5,
      z1: 12.171875,
      hull: [
        { x: -4.90625, y: -3.625 }, { x: -3.015625, y: -3.625 }, { x: 1.8125, y: -3.46875 }, { x: 2.5, y: 3.453125 },
        { x: 2.5, y: 3.46875 }, { x: -3.015625, y: 3.609375 }, { x: -4.90625, y: 3.609375 },
      ],
      cuts: [
        { edge: 'back', from: -1.359375, to: 1.34375, at: -3.0625 },
        { edge: 'back', from: 2.25, to: 3.15625, at: -3.234375 },
      ],
    },
  ],
};

export const SIDE_ROLLER_IMPORT_V7_BUILD: Partial<RobotSpec> = { ...SIDE_ROLLER_IMPORT_BUILD, imported: SIDE_ROLLER_IMPORT_V7 };

/**
 * Where the real robot stops, driven straight at a FLOWER (`stageFlowerDriveIn`, the point (9.7, 0)
 * at the ring axis): how far that point is short of the axis when the CAD first meets anything the
 * 3D robot meets there (the middle and top plates over their measured outlines, the four HIPS pipes
 * and supports from the field CAD, the wall). Every triangle of the full mesh, clipped to each
 * obstacle's heights and swept exactly. It is the middle plate, on the intake's cross bar at z 3.9.
 */
export const SIDE_ROLLER_IMPORT_REAL_STOP_IN = 0.38;
