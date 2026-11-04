import type { RobotSpec } from '../types';
import * as C from '../config';
import { activeDrive } from './drivetrain';
import { clamp, dcos, dsin } from '../math';

/**
 * DRIVE MOTORS AT ZERO POWER: BRAKE OR COAST (`RobotSpec.zeroPower`, FTC's `ZeroPowerBehavior`).
 *
 * BRAKE is the model as it always was, and a spec without the field is brake: `updateRobot` does
 * not come here for it, so it steps bit for bit as before. COAST changes only the wheels whose
 * power is exactly zero this tick (`C.ZERO_POWER_EPS`); a wheel with any power drives the same in
 * both modes, and so does a robot with every wheel powered.
 *
 * THE DRIVE MODEL IS CHASSIS-LEVEL, SO THE WHEELS ARE RECOVERED FROM IT. `motorStepVec` and
 * `motorStep` give the chassis velocity the drivetrain reaches this tick. In the chassis's
 * NORMALISED coordinates (forward / Vf, strafe / Vs, turn / W, each axis over its own free
 * speed), a wheel's power is a fixed row of signs times the command (mecanum: f ∓ s ∓ r), so the
 * same rows split the brake step into each wheel's part of it. A traction wheel (tank, swerve,
 * butterfly's traction set) has a second, sideways row: that part is the tyre's, and it is kept
 * whatever the motor does. Coast removes the zero-power wheels' ROLL parts (no electrical torque)
 * and adds their friction instead (`coastDecel`, a force at that wheel along its roll row). So a
 * coasting tank rolls on forward and is held sideways exactly as a braked one is.
 *
 * A TRACTION CHASSIS CANNOT SPIN WITHOUT SCRUBBING ITS TYRES SIDEWAYS (`scrub`), and that is
 * friction, not the motors: a coasting tank stops turning about as fast as a braked one. Roller
 * drivetrains have no such limit: with the hub free, a mecanum or omni wheel rolls in every
 * direction, which is also why a coasting roller wheel holds nothing sideways (`updateRobot`).
 */

export type ZeroPowerMode = 'brake' | 'coast';

export function zeroPowerOf(spec: Pick<RobotSpec, 'zeroPower'>): ZeroPowerMode {
  return spec.zeroPower === 'coast' ? 'coast' : 'brake';
}

/** is this wheel's commanded power off, as the hub would read it */
export function wheelOff(power: number): boolean {
  return Math.abs(power) < C.ZERO_POWER_EPS;
}

/** a mecanum, omni or butterfly-mecanum set: rollers that roll freely once the hub does */
export function rollerDrive(saturation: 'sum' | 'tank' | 'vec'): boolean {
  return saturation === 'sum';
}

/**
 * THE FULL-ROBOT DECELERATION of four freewheeling drive wheels, in/s². Two terms:
 *  • motor friction through the gearbox: the no-load current is the torque a free-spinning motor
 *    spends on its own bearings, brushes and gears (`kt · I0`), and back-driven through the
 *    reduction (`MOTOR_FREE_RPM / rpm`) it reaches the wheel multiplied — so a torquier gearing
 *    coasts shorter, and a heavier robot carries further against the same friction;
 *  • rolling resistance, a fraction of weight (`COAST_ROLL_*`).
 */
export function coastDecel(spec: RobotSpec, tankMode = false): number {
  const { p, rpm } = activeDrive(spec, tankMode);
  const wheelR = C.WHEEL_DIAMETER_MM / 25.4 / 2;
  const motorFrictionLbIn = (C.MOTOR_STALL_TORQUE_OZIN / 16) * (C.MOTOR_NO_LOAD_AMPS / C.MOTOR_STALL_AMPS);
  const lbf = (motorFrictionLbIn * (C.MOTOR_FREE_RPM / rpm) * C.DRIVE_MOTORS) / wheelR;
  const roll = rollerDrive(p.saturation) ? C.COAST_ROLL_ROLLER : C.COAST_ROLL_TRACTION;
  return (lbf * C.GRAVITY) / spec.massLb + roll * C.GRAVITY;
}

type Row = readonly [number, number, number];
/** FL, FR, BL, BR (`WHEEL_CORNERS`), +y left, +turn counter-clockwise */
const ROWS_SUM: readonly Row[] = [[1, -1, -1], [1, 1, 1], [1, 1, -1], [1, -1, 1]];
const ROWS_TANK: readonly Row[] = [[1, 0, -1], [1, 0, 1], [1, 0, -1], [1, 0, 1]];

/**
 * Each wheel's ROLL coordinate in the normalised chassis velocity, and for TRACTION wheels its
 * TYRE coordinate (sideways across the wheel) too. A swerve pod rolls along its own angle, so
 * its rows are the pod direction and its moment arm about the centre. Roller wheels get no tyre
 * row: with the hub free, nothing holds them sideways.
 */
export function wheelRows(
  saturation: 'sum' | 'tank' | 'vec',
  wheels: readonly { x: number; y: number }[],
  pods: readonly number[] | undefined,
  vf: number,
  vs: number,
  w: number,
): { roll: readonly Row[]; tyre: readonly Row[] } {
  if (saturation === 'sum') return { roll: ROWS_SUM, tyre: [] };
  const s1 = (vs > 0 ? vs : vf) / vf;
  const k = w / vf;
  const tyre = wheels.map((p, i) => {
    const c = dcos(pods?.[i] ?? 0);
    const s = dsin(pods?.[i] ?? 0);
    return [-s, c * s1, (p.x * c + p.y * s) * k] as const;
  });
  if (saturation === 'tank') return { roll: ROWS_TANK, tyre };
  const roll = wheels.map((p, i) => {
    const c = dcos(pods?.[i] ?? 0);
    const s = dsin(pods?.[i] ?? 0);
    return [c, s * s1, (p.x * s - p.y * c) * k] as const;
  });
  return { roll, tyre };
}

/** (M + εI)⁻¹ for a symmetric 3×3; the ε only guards a degenerate wheel layout. */
function invReg(m: number[][]): number[][] {
  const e = 1e-9;
  const a = m[0][0] + e, b = m[0][1], c = m[0][2];
  const d = m[1][1] + e, f = m[1][2];
  const g = m[2][2] + e;
  const A = d * g - f * f;
  const B = c * f - b * g;
  const Cc = b * f - c * d;
  const det = a * A + b * B + c * Cc;
  const D = a * g - c * c;
  const E = b * c - a * f;
  const F = a * d - b * b;
  return [
    [A / det, B / det, Cc / det],
    [B / det, D / det, E / det],
    [Cc / det, E / det, F / det],
  ];
}

const mul = (m: number[][], v: readonly number[]): number[] => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

export interface CoastInput {
  /** `wheelRows` */
  roll: readonly Row[];
  tyre: readonly Row[];
  /** this tick's wheels with power, in `WHEEL_CORNERS` order */
  powered: readonly boolean[];
  /** robot-frame velocity and spin at the start of the tick */
  vx: number;
  vy: number;
  w: number;
  /** ...and what the brake model steps them to */
  nx: number;
  ny: number;
  nw: number;
  /** the normalisers: free speed, strafe speed (0 for a tank), turn rate */
  vf: number;
  vs: number;
  wf: number;
  /** `coastDecel` */
  decel: number;
  /** mass over yaw inertia, 1 / in² */
  mOverI: number;
  /** rad/s² of spin a traction chassis's tyres can stop by scrubbing; 0 on rollers */
  scrub: number;
  dt: number;
}

/** The coast answer to the brake step, robot frame. Called only with a wheel at zero power. */
export function coastStep(c: CoastInput): { x: number; y: number; w: number } {
  const vs = c.vs > 0 ? c.vs : c.vf;
  const scale = [c.vf, vs, c.wf];
  const db = [(c.nx - c.vx) / c.vf, (c.ny - c.vy) / vs, (c.nw - c.w) / c.wf];
  const q0 = [c.vx / c.vf, c.vy / vs, c.w / c.wf];
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const rows = [...c.roll, ...c.tyre];
  for (const r of rows) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += r[i] * r[j];
  // the brake step split across every roll and tyre row: keep the powered wheels' rolls, drop the
  // unpowered wheels' rolls, and keep a tyre's part only where it stops that tyre sliding — a
  // tyre opposes motion and never creates it (the same rule as the traction loop in `updateRobot`)
  const kept = [0, 0, 0];
  for (let k = 0; k < rows.length; k++) {
    const tyre = k >= c.roll.length;
    if (!tyre && !c.powered[k]) continue;
    const r = rows[k];
    let e = r[0] * db[0] + r[1] * db[1] + r[2] * db[2];
    if (tyre) {
      const slide = r[0] * q0[0] + r[1] * q0[1] + r[2] * q0[2];
      e = e * slide < 0 ? Math.sign(e) * Math.min(Math.abs(e), Math.abs(slide)) : 0;
    }
    for (let i = 0; i < 3; i++) kept[i] += r[i] * e;
  }
  const dq = mul(invReg(m), kept);
  let dx = dq[0] * scale[0];
  let dy = dq[1] * scale[1];
  let dw = dq[2] * scale[2];
  // the zero-power wheels' friction, each a quarter of `decel`, as a force along its roll
  for (let k = 0; k < c.roll.length; k++) {
    if (c.powered[k]) continue;
    const r = c.roll[k];
    const u = (r[0] * q0[0] + r[1] * q0[1] + r[2] * q0[2]) * c.vf;
    if (u === 0) continue;
    const f = (Math.sign(u) * c.decel * Math.min(1, Math.abs(u) / C.COAST_STICTION_SPEED)) / c.roll.length;
    dx -= r[0] * f * c.dt;
    dy -= ((r[1] * f * c.vf) / vs) * c.dt;
    dw -= ((r[2] * f * c.vf) / c.wf) * c.mOverI * c.dt;
  }
  // a traction chassis's spin is stopped by its tyres scrubbing, up to what brake would do
  if (c.scrub > 0) {
    const gap = c.nw - c.w - dw;
    if (gap * (c.w + dw) < 0) dw += clamp(gap, -c.scrub * c.dt, c.scrub * c.dt);
  }
  return { x: c.vx + dx, y: c.vy + dy, w: c.w + dw };
}
