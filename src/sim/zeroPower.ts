import type { RobotCommand, RobotSpec } from '../types';
import * as C from '../config';
import { activeDrive, arcadeTank } from './drivetrain';
import { clamp, dcos, dsin } from '../math';

/**
 * DRIVE MOTORS AT ZERO POWER: BRAKE OR COAST (`RobotSpec.zeroPower`, FTC's `ZeroPowerBehavior`).
 *
 * BRAKE is the model as it always was, and a spec without the field is brake: `updateRobot` does
 * not come here for it, so it steps bit for bit as before. COAST changes only the wheels whose
 * power is exactly zero this tick (`C.ZERO_POWER_EPS`); a wheel with any power drives the same in
 * both modes, and so does a robot with every wheel powered.
 *
 * ...AND A WHEEL FLOATS WHEN THE DRIVER LETS GO, NOT WHEN TWO KEYS CANCEL (`floatingWheels`).
 * A motor on any voltage, zero included, is damped by its own back-EMF; BRAKE is exactly that at
 * 0 V and FLOAT is the only state without it. A gamepad puts a wheel at an EXACT zero mid-drive
 * only if two analog axes cancel to the hub's 1/32767, which they essentially never do, while
 * DSIM's keys land on the cancellation every time: W plus a turn key zeroes a mecanum's inner
 * pair, and coasting they let the robot run on straight (113° of turn in half a second became
 * 21°; a tank's 132° became 0°). So a mixed drivetrain floats only when its whole drive command
 * is zero. A tank's two sides can each be a stick of their own ("Traditional" control), and a
 * released stick is a real zero, so a tank side floats on its own unless the command is the
 * arcade mix cancelling (`arcadeCancel`).
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
 * direction, so a coasting roller wheel has no tyre grip sideways (`updateRobot`). What it has is
 * FRICTION every way it moves: its hub's (the rows above) and its rollers' (`rollerForce`), which
 * turn whenever the wheel moves off its hub's line — strafing, spinning, or being shoved.
 */

export type ZeroPowerMode = 'brake' | 'coast';

export function zeroPowerOf(spec: Pick<RobotSpec, 'zeroPower'>): ZeroPowerMode {
  return spec.zeroPower === 'coast' ? 'coast' : 'brake';
}

/** what a DISABLED robot is commanded (before the start, after the buzzer): the field cuts its
 *  power by code, so a coast robot's wheels float at once (`RobotCommand.seat`) */
export const DISABLED_CMD: RobotCommand = {
  driveX: 0,
  driveY: 0,
  rotate: 0,
  leftDrive: 0,
  rightDrive: 0,
  intake: false,
  fire: false,
  seat: true,
};

/** is this wheel's commanded power off, as the hub would read it */
export function wheelOff(power: number): boolean {
  return Math.abs(power) < C.ZERO_POWER_EPS;
}

/** a mecanum, omni or butterfly-mecanum set: rollers that roll freely once the hub does */
export function rollerDrive(saturation: 'sum' | 'tank' | 'vec'): boolean {
  return saturation === 'sum';
}

/** is this tank command the arcade mix of one forward and one turn axis (`arcadeTank`, "Normal"
 *  control), so a side at zero is the mix cancelling with both sticks still held, rather than two
 *  independent sides. One command step (1/127, `quantizeCommand`) of slack on each side. */
export function arcadeCancel(cmd: Pick<RobotCommand, 'driveY' | 'rotate' | 'leftDrive' | 'rightDrive'>): boolean {
  if (cmd.driveY === 0 && cmd.rotate === 0) return false;
  const { left, right } = arcadeTank(cmd.driveY, cmd.rotate);
  const tol = 1.01 / 127;
  return Math.abs((cmd.leftDrive ?? 0) - left) <= tol && Math.abs((cmd.rightDrive ?? 0) - right) <= tol;
}

/**
 * WHICH WHEELS ARE POWERED THIS TICK, or null when every one is (the brake step, unchanged). The
 * header says why only a tank side floats on its own: on a mixed drivetrain a single wheel at zero
 * is two of the driver's axes cancelling, a motor still driven at 0 V, so it floats only with all
 * the others.
 */
export function floatingWheels(
  saturation: 'sum' | 'tank' | 'vec',
  power: readonly number[],
  arcade: boolean,
): boolean[] | null {
  if (!power.some(wheelOff)) return null;
  if (saturation === 'tank' && !arcade) return power.map((p) => !wheelOff(p));
  return power.every(wheelOff) ? power.map(() => false) : null;
}

/**
 * ...AND A LET-GO WHEEL BRAKES FOR `COAST_SETTLE_S` BEFORE IT FLOATS: a stick flicked through
 * centre, sampled once at zero, or springing back to it. Counts each let-go wheel's ticks on
 * `r.coastIdle` (dropped once every wheel is driven again) and returns `floatingWheels`' answer
 * with only the settled wheels still floating, or null when none is.
 *
 * A DRIVER'S ZERO ONLY. A command code set (`seat`: an auto, a bot, the field's disable) has no
 * stick: power 0 is power 0 from its first tick, as on a real robot and as Pedro's FLOAT tuners
 * measured, so its let-go wheels count as settled at once.
 */
export function settleCoast(
  r: { coastIdle?: number[] },
  powered: readonly boolean[] | null,
  dt: number,
  seat: boolean,
): boolean[] | null {
  if (!powered) {
    delete r.coastIdle;
    return null;
  }
  const settle = Math.round(C.COAST_SETTLE_S / dt);
  const idle = powered.map((on, i) => (on ? 0 : seat ? settle + 1 : Math.min((r.coastIdle?.[i] ?? 0) + 1, settle + 1)));
  r.coastIdle = idle;
  const out = powered.map((on, i) => on || idle[i] <= settle);
  return out.every(Boolean) ? null : out;
}

/**
 * THE FULL-ROBOT DECELERATION of four freewheeling drive wheels, in/s². Two terms:
 *  • motor friction through the gearbox: the no-load current is the torque a free-spinning motor
 *    spends on its own bearings, brushes and gears (`kt · I0`), and back-driven through the
 *    reduction (`MOTOR_FREE_RPM / rpm`) it reaches the wheel multiplied — so a torquier gearing
 *    coasts shorter, and a heavier robot carries further against the same friction;
 *  • rolling resistance, a fraction of weight (`COAST_ROLL_*`).
 * MEASURED, this is right: 498 FTC robots' FLOAT roll-outs (`config.ts`, `COAST_ROLL_ROLLER`) put a
 * mecanum's forward deceleration at 35 in/s² (median), and this gives 34 for the median robot.
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
  /** a roller drivetrain's wheels (`wheelLocals`) and whether they are omnis at 45° (x-drive)
   *  rather than mecanums; absent on traction wheels */
  rollers?: { pos: readonly { x: number; y: number }[]; omni: boolean };
  dt: number;
}

/**
 * ONE FREE ROLLER WHEEL'S ROLLER FRICTION, per unit robot mass, robot frame, for a wheel at `p`
 * whose contact moves at `(ux, uy)`. `COAST_ROLLER_FRICTION` of this wheel's share of the weight,
 * Coulomb, fading out under `COAST_STICTION_SPEED` of roller speed like the hub's.
 *  • MECANUM: the hub rolls along x and the rollers take the rest, so the rollers turn at √2·uy
 *    whatever the hub does; by virtual work their friction is a pure SIDEWAYS force of √2 times
 *    the roller's own. Driving straight turns no roller, which is why a mecanum coasts further
 *    forward than sideways.
 *  • OMNI at 45° (x-drive): hub and rollers are square to each other, so the roller friction acts
 *    along the roller's rolling line, (1, ±1)/√2 — the line a mecanum's rollers roll on too.
 */
export function rollerForce(i: number, ux: number, uy: number, omni: boolean, wheels: number): { x: number; y: number } {
  const f = (C.COAST_ROLLER_FRICTION * C.GRAVITY) / wheels;
  // FL and BR roll freely toward forward-left, FR and BL toward forward-right (`ROWS_SUM`)
  const s = i === 0 || i === 3 ? 1 : -1;
  if (!omni) {
    const roll = Math.SQRT2 * uy;
    if (roll === 0) return { x: 0, y: 0 };
    return { x: 0, y: -Math.SQRT2 * f * Math.sign(roll) * Math.min(1, Math.abs(roll) / C.COAST_STICTION_SPEED) };
  }
  const roll = (ux + s * uy) / Math.SQRT2;
  if (roll === 0) return { x: 0, y: 0 };
  const k = (-f * Math.sign(roll) * Math.min(1, Math.abs(roll) / C.COAST_STICTION_SPEED)) / Math.SQRT2;
  return { x: k, y: k * s };
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
    if (u !== 0) {
      const f = (Math.sign(u) * c.decel * Math.min(1, Math.abs(u) / C.COAST_STICTION_SPEED)) / c.roll.length;
      dx -= r[0] * f * c.dt;
      dy -= ((r[1] * f * c.vf) / vs) * c.dt;
      dw -= ((r[2] * f * c.vf) / c.wf) * c.mOverI * c.dt;
    }
    // ...and its rollers', at the wheel's contact (they turn even where the hub does not)
    if (c.rollers) {
      const p = c.rollers.pos[k];
      const g = rollerForce(k, c.vx - c.w * p.y, c.vy + c.w * p.x, c.rollers.omni, c.roll.length);
      dx += g.x * c.dt;
      dy += g.y * c.dt;
      dw += (p.x * g.y - p.y * g.x) * c.mOverI * c.dt;
    }
  }
  // a traction chassis's spin is stopped by its tyres scrubbing, up to what brake would do
  if (c.scrub > 0) {
    const gap = c.nw - c.w - dw;
    if (gap * (c.w + dw) < 0) dw += clamp(gap, -c.scrub * c.dt, c.scrub * c.dt);
  }
  return { x: c.vx + dx, y: c.vy + dy, w: c.w + dw };
}
