/**
 * BIOBUZZ 3D — THE BAY UNDER THE DECK (High), a lazy chunk of its own.
 *
 * The drive motors, the REV hubs, the battery and the motors' leads, and the pure-number layout
 * that places them (`bbBayLayout`). `renderRobots.ts` fetches this module the first time it builds
 * a High robot (`bbLoadBay`) and calls it through the hooks this file registers at its bottom
 * (`bbRegisterBay`); the note on `BbBayHooks` there says why it is not in the scene chunk.
 */
import * as THREE from 'three';
import type { RobotSpec } from '../../../types';
import { WHEEL_CORNERS } from '../../../config';
import type { RobotFamily } from '../graphics/finishes';
import { BB_DECK_Z } from '../config';
import { bbMouths } from '../robot';
import { bbSpecKey } from '../specKey';
import { bbIntakeMountOf } from '../mounts';
import { bbIntakeKindOf } from '../mechs';
import {
  ALU,
  axleXs,
  BB_DECK_T,
  BB_DRIVE_MOTOR,
  BB_OMNI,
  BB_PAN_T,
  BB_PAN_Z,
  BB_PLATE_H,
  BB_PLATE_T,
  BB_POD_INSET,
  BB_PROUD,
  BB_RAIL_T,
  BB_SIGN_LAND_HALF,
  BB_WHEEL_PARTS,
  BB_XDRIVE_INSET_X,
  BB_XDRIVE_INSET_Y,
  bbInnerHalfWidth as innerHalfWidth,
  bbPanLength,
  bbRegisterBay,
  chamferBox,
  chamferBoxAt,
  framePart,
  intakeArmKeepOuts,
  MM,
  MOTOR,
  SCREW,
  solidMat,
  SWEEPER,
  tag,
  turnedPart,
  wheelKindOf,
} from './renderRobots';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE BAY (High) — 2026-10-11: the drive motors, hubs, battery and leads an open end shows
// ═══════════════════════════════════════════════════════════════════════════════════════════
/**
 * ⚠️ **WHAT IS UNDER THE DECK, AND ONLY WHERE SOMETHING CAN SEE IT** (owner, 2026-10-10: "Make the
 * robots more high quality"). The deck covers the whole chassis (2026-09-21) and the back plate
 * closes the rear (2026-09-20), so the space between the inner side plates is seen through two
 * openings only:
 *  - an END that carries an intake mouth, where the end plate is two corner plates and the bay is
 *    open from the tiles to the cross member — the builder's turntable goes down to 1° and looks
 *    straight in, and so does any camera low and in front of the robot;
 *  - a swerve or X-drive's outer side plate, which has no inner plate behind its cuts.
 * A build with neither (a side intake on a channel drivetrain) shows nothing of the bay and builds
 * none of it (`bbBayShown`). Before this the bay was an empty box: a belly pan, two plates and the
 * back of the back plate.
 *
 * What goes in is what an FTC robot carries there: a goBILDA 5203 on each driven wheel, a REV
 * Control Hub with an Expansion Hub stacked on it, the REV slim battery, and each motor's lead to
 * the Control Hub. Placement is pure numbers (`bbBayLayout`): the drive motors on fixed poses per
 * drivetrain, then the hubs and the battery as one pair, trying a fixed list of poses and taking
 * the first that clears everything already placed and every obstacle under the deck by
 * `BAY_CLEAR`, then the leads, routed round all of it (`bayWires`). An item that fits nowhere is
 * left out rather than forced; the motors and the leads are all four or none, so a drivetrain is
 * never drawn half driven or half wired.
 *
 * Nothing here is a collider or reads one: the chassis box is solid to the 3D solve at every
 * height under the deck already, and an element never enters it (the mouth's pocket is in front
 * of the frame face). All of it is High only, casts no shadow (it is under a deck), and it is 4
 * meshes — 5 on an X-drive (the motors' brackets), 6 on a narrow channel chassis (belts and mount
 * plates).
 */
/** REV Control Hub (REV-31-1595) and Expansion Hub (REV-31-1153): 143 × 103 × 29.5 mm, M3 holes on
 *  a 128 × 88 mm pattern (the Expansion Hub's drawing; the Control Hub manual gives the same case) */
export const BB_HUB = { l: 143 * MM, w: 103 * MM, h: 29.5 * MM, holeL: 128 * MM, holeW: 88 * MM } as const;
/** REV 12 V slim battery (REV-31-1302): 113.5 × 90.5 × 23 mm */
export const BB_BATTERY = { l: 113.5 * MM, w: 90.5 * MM, h: 23 * MM } as const;
/** M3 nylon hex standoffs, 6 mm across: 6 mm under the Control Hub, 10 mm between the two hubs, and
 *  48 mm when the Control Hub stands over an X-drive's motors */
const HUB_STANDOFF_R = (6 * MM) / 2;
const HUB_STANDOFF_LOW = 6 * MM;
const HUB_STANDOFF_MID = 10 * MM;
const HUB_STANDOFF_TALL = 48 * MM;
/** the clearance every bay item keeps to every other part (in) */
export const BAY_CLEAR = 0.1;
/** a narrow channel chassis: how far each motor of an axle pair is set off its axle (in), one
 *  forward and one back, so the two clear each other — `2 × gearR + BAY_CLEAR` apart, rounded up */
const BAY_STAGGER = 0.8;
/** ...and the belt between the axle's pulley and the motor's: pulley radius and width, the belt's
 *  thickness, and the mount plate's */
const BAY_PULLEY_R = 0.45;
const BAY_PULLEY_W = 0.3;
const BAY_BELT_T = 0.08;
const BAY_MOUNT_T = 0.1;
/** the mount plate's half-height: it stays `BAY_CLEAR` over the pan on a tank's lower axle */
const BAY_MOUNT_HALF = 0.8;
/** the mount plate's four standoffs, above and below the belt: radius, and height off the axle */
const BAY_MOUNT_STANDOFF_R = 0.08;
const BAY_MOUNT_STANDOFF_DZ = 0.68;
/** inner plate face → 0.1 → pulley (0.3) → 0.1 → mount plate (0.1): where the motor's face sits */
const BAY_MOUNT_OFF = 0.1 + BAY_PULLEY_W + 0.1 + BAY_MOUNT_T;
/** an X-drive motor's face, off its omni's own centre along the axle: half the wheel and a gap */
const BAY_XDRIVE_FACE = BB_OMNI.w / 2 + 0.15;
/** ...and the bracket it is bolted to: a plate across the axle between the wheel and the motor's
 *  face, hung from the deck — its thickness, half-width, and how far below the axle it reaches */
const BAY_BRACKET_T = 0.1;
const BAY_BRACKET_HALF = 0.95;
const BAY_BRACKET_DROP = 0.8;
/** the strip of connector housings along each long side of a hub: inset from each end, how far
 *  its outer face stands off the case, its own thickness and height, and its centre under the
 *  case's top. Its face clears the case by more than the depth buffer resolves at orbit range. */
const HUB_PORT_INSET = 0.5;
const HUB_PORT_PROUD = 0.05;
const HUB_PORT_T = 0.08;
const HUB_PORT_H = 0.4;
const HUB_PORT_DROP = 0.32;
/** the same strip's numbers, for the RENDER lane (a lead must end inside one) */
export const BB_HUB_PORT_STRIP = { inset: HUB_PORT_INSET, proud: HUB_PORT_PROUD, t: HUB_PORT_T, h: HUB_PORT_H, drop: HUB_PORT_DROP } as const;
/** A DRIVE MOTOR'S LEAD (2026-10-11): the 5203's two 18 AWG leads (~2.2 mm each over the
 *  insulation) drawn as one 2.5 mm lead — APPROX: a pair is wider than it is deep, and the
 *  encoder's own 4-wire lead is not drawn. Its radius, the gap it keeps to every other part (it is
 *  tied down, so less than `BAY_CLEAR`), the grid it is routed on, the radius of its bends, how far
 *  off the case it rises before it turns into its port, the port pitch along a strip, and its
 *  centre height lying on the pan. */
export const BAY_WIRE_R = 0.05;
export const BAY_WIRE_CLEAR = 0.04;
/** ...and between two leads, which may run side by side the way a tied bundle does, but never
 *  through each other */
export const BAY_WIRE_GAP = 0.01;
const BAY_WIRE_GRID = 0.125;
const BAY_WIRE_BEND = 0.2;
const BAY_PORT_OUT = 0.3;
const BAY_PORT_PITCH = 0.3;
export const BAY_WIRE_Z = BB_PAN_Z + BB_PAN_T / 2 + BAY_WIRE_R + 0.01;

/** one drive motor: the centre of its mounting face, and its axis in plan (unit, face → encoder) */
export interface BbBayMotor {
  x: number;
  y: number;
  z: number;
  ux: number;
  uy: number;
  /** its output shaft is drawn — where it runs into a wheel in the open (X-drive) */
  shaft: boolean;
}
/** a staggered motor's drive: the axle's pulley at `x0`, the motor's at `x1`, at height `z`, on the
 *  `sy` side, in the plane between the inner plate and the motor's mount plate */
export interface BbBayBelt {
  sy: 1 | -1;
  x0: number;
  x1: number;
  z: number;
}
/** a box lying square in the bay: a hub or the battery */
export interface BbBayBox {
  cx: number;
  cy: number;
  z0: number;
  /** half-extents along x and y — the part's long side is along x when `hx > hy` */
  hx: number;
  hy: number;
  h: number;
}
export interface BbBayLayout {
  motors: BbBayMotor[];
  belts: BbBayBelt[];
  /** the Control Hub, then the Expansion Hub stacked on it when there is headroom */
  hubs: BbBayBox[];
  battery: BbBayBox | null;
  standoffs: { x: number; y: number; z0: number; z1: number }[];
  /** each drive motor's lead to the Control Hub (`bayWires`); a lead with no clear route is left out */
  wires: BbBayWire[];
}
/** a drive motor's lead: `motors[motor]`'s, from inside its encoder cover to inside a port on the
 *  Control Hub's side, its corners already rounded (`pts`), and the port it ends in */
export interface BbBayWire {
  motor: number;
  pts: [number, number, number][];
  /** the lead's last point is in this port: the side's outward normal in plan, and its centre */
  port: { nx: number; ny: number; x: number; y: number; z: number };
}

/** the bay solver's one shape: a box in plan, turned `a` about z, over [z0, z1] — or, with `r`, a
 *  vertical cylinder (a swerve pod's sweep) */
export interface BbBayShape {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  a: number;
  z0: number;
  z1: number;
  r?: number;
  /** what it is, for an obstacle: `pan`, `cross`, `channel`, `pod`, `omni<i>` or `intakeArm` */
  what?: string;
}
const bayBox = (cx: number, cy: number, hx: number, hy: number, z0: number, z1: number, a = 0, what?: string): BbBayShape => ({ cx, cy, hx, hy, a, z0, z1, what });
/** do two shapes come closer than `pad`? Separating axes in plan (each box's own two), a z gap.
 *  EXPORTED for the RENDER lane's pure-number sweep (`robot/bay`). */
export function bbBayHit(p: BbBayShape, q: BbBayShape, pad: number): boolean {
  if (p.z1 + pad <= q.z0 || q.z1 + pad <= p.z0) return false;
  if (q.r !== undefined || p.r !== undefined) {
    const [b, d] = q.r !== undefined ? [p, q] : [q, p];
    const c = Math.cos(b.a);
    const s = Math.sin(b.a);
    const dx = d.cx - b.cx;
    const dy = d.cy - b.cy;
    const ex = Math.max(0, Math.abs(dx * c + dy * s) - b.hx);
    const ey = Math.max(0, Math.abs(-dx * s + dy * c) - b.hy);
    return Math.hypot(ex, ey) < d.r! + pad;
  }
  for (const ang of [p.a, p.a + Math.PI / 2, q.a, q.a + Math.PI / 2]) {
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const span = (b: BbBayShape): [number, number] => {
      const m = b.cx * ux + b.cy * uy;
      const e = Math.abs(b.hx * (Math.cos(b.a) * ux + Math.sin(b.a) * uy)) + Math.abs(b.hy * (Math.cos(b.a) * uy - Math.sin(b.a) * ux));
      return [m - e, m + e];
    };
    const [a0, a1] = span(p);
    const [b0, b1] = span(q);
    if (a1 + pad <= b0 || b1 + pad <= a0) return false;
  }
  return true;
}
/** a motor as the solver sees it: the box round its gearbox, face to encoder */
function bayMotorShape(m: BbBayMotor): BbBayShape {
  const L = BB_DRIVE_MOTOR.len;
  const R = BB_DRIVE_MOTOR.gearR;
  return bayBox(m.x + (m.ux * L) / 2, m.y + (m.uy * L) / 2, L / 2, R, m.z - R, m.z + R, Math.atan2(m.uy, m.ux));
}
/** a belt drive as the solver sees it: from the inner plate to the motor's face, over the mount
 *  plate's whole outline */
function bayBeltShape(b: BbBayBelt, innerHW: number): BbBayShape {
  const x0 = Math.min(b.x0, b.x1) - BAY_PULLEY_R - 0.3;
  const x1 = Math.max(b.x0, b.x1) + BAY_PULLEY_R + 0.3;
  const yIn = innerHW - BAY_MOUNT_OFF;
  return bayBox((x0 + x1) / 2, (b.sy * (innerHW + yIn)) / 2, (x1 - x0) / 2, BAY_MOUNT_OFF / 2, b.z - BAY_MOUNT_HALF, b.z + BAY_MOUNT_HALF);
}
/** an X-drive motor's bracket as the solver sees it */
function bayBracketShape(m: BbBayMotor): BbBayShape {
  return bayBox(m.x - (m.ux * BAY_BRACKET_T) / 2, m.y - (m.uy * BAY_BRACKET_T) / 2, BAY_BRACKET_T / 2, BAY_BRACKET_HALF, m.z - BAY_BRACKET_DROP, BB_BAY_CEILING, Math.atan2(m.uy, m.ux));
}
/** each drive motor's whole assembly: the motor, and its belt drive (`belts[k]` is `motors[k]`'s)
 *  or its bracket. `own` is the motor's index — one assembly's parts touch each other by design. */
function bayAssemblies(motors: readonly BbBayMotor[], belts: readonly BbBayBelt[], innerHW: number): { own: number; s: BbBayShape }[] {
  const out: { own: number; s: BbBayShape }[] = [];
  motors.forEach((m, k) => {
    out.push({ own: k, s: bayMotorShape(m) });
    if (m.shaft) out.push({ own: k, s: bayBracketShape(m) });
  });
  belts.forEach((b, k) => out.push({ own: k, s: bayBeltShape(b, innerHW) }));
  return out;
}
/** every placed bay item as the solver saw it, by ASSEMBLY (`motor<k>` with its belt drive or
 *  bracket, `hubs` with their standoffs, `battery`): parts of one assembly touch by design, two
 *  assemblies never do. The RENDER lane's sweep checks these pairwise and against
 *  `bbUnderDeckObstacles`. */
export function bbBayShapes(spec: RobotSpec, lay: BbBayLayout): { what: string; s: BbBayShape }[] {
  const innerHW = innerHalfWidth(spec);
  const out: { what: string; s: BbBayShape }[] = [];
  for (const a of bayAssemblies(lay.motors, lay.belts, innerHW)) out.push({ what: `motor${a.own}`, s: a.s });
  for (const b of lay.hubs) out.push({ what: 'hubs', s: bayBox(b.cx, b.cy, b.hx, b.hy, b.z0, b.z0 + b.h) });
  for (const p of lay.standoffs) out.push({ what: 'hubs', s: bayBox(p.x, p.y, HUB_STANDOFF_R, HUB_STANDOFF_R, p.z0, p.z1) });
  if (lay.battery) out.push({ what: 'battery', s: bayBox(lay.battery.cx, lay.battery.cy, lay.battery.hx, lay.battery.hy, lay.battery.z0, lay.battery.z0 + lay.battery.h) });
  return out;
}

/** does any part of the bay show? See the section header. */
export function bbBayShown(spec: RobotSpec): boolean {
  if (spec.imported) return false;
  if (spec.drivetrain === 'swerve' || spec.drivetrain === 'xdrive') return true;
  return bbMouths(spec).some((m) => m.edge === 'front' || m.edge === 'back');
}

/** the bay's ceiling: the deck's underside, less `BB_PROUD` (in) */
export const BB_BAY_CEILING = BB_DECK_Z - BB_DECK_T - BB_PROUD;
/** the bay's floor: the belly pan's top face (in) */
export const BB_BAY_FLOOR = BB_PAN_Z + BB_PAN_T / 2;

/**
 * EVERYTHING UNDER THE DECK THE BAY MUST CLEAR, from the numbers the builders draw by: the belly
 * pan, the cross members, the wheel channels (inner plate outward), a swerve's pods (their whole
 * sweep), an X-drive's omnis, and the intake arms' slices inside the frame (`intakeArmKeepOuts`).
 * Mechanisms on the deck do not reach under it: measured over 720 High builds (5 drivetrains × 3
 * sizes × 3 intakes × 4 mounts × 4 launcher/lift sets), the intake arms are the only part that
 * does, 1.1 in deep at the frame's sides and above z 3.6. EXPORTED for the RENDER lane.
 */
export function bbUnderDeckObstacles(spec: RobotSpec): BbBayShape[] {
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  const innerHW = innerHalfWidth(spec);
  const out: BbBayShape[] = [];
  // the pan, and everything under its top face
  out.push(bayBox(0, 0, hl, hw, -1, BB_BAY_FLOOR, 0, 'pan'));
  // the cross members (`buildFrame`)
  for (const sx of [1, -1] as const) out.push(bayBox(sx * (hl - BB_PLATE_T - BB_RAIL_T / 2), 0, BB_RAIL_T / 2, hw - BB_PLATE_T, BB_BAY_CEILING - BB_RAIL_T, BB_DECK_Z, 0, 'cross'));
  const dt = spec.drivetrain;
  if (dt === 'swerve') {
    for (const [sx, sy] of WHEEL_CORNERS) out.push({ ...bayBox(sx * (hl - BB_POD_INSET), sy * (hw - BB_POD_INSET), 0, 0, 0, BB_DECK_Z, 0, 'pod'), r: BB_POD_INSET });
  } else if (dt === 'xdrive') {
    // `buildWheels`' own placement and cant, in `WHEEL_CORNERS` order
    const ax = Math.max(0.5, hl - BB_XDRIVE_INSET_X);
    const ay = Math.max(0.5, hw - BB_XDRIVE_INSET_Y);
    WHEEL_CORNERS.forEach(([sx, sy], i) => out.push(bayBox(sx * ax, sy * ay, BB_OMNI.r, BB_OMNI.w / 2, 0, 2 * BB_OMNI.r, sx * sy >= 0 ? -Math.PI / 4 : Math.PI / 4, `omni${i}`)));
  } else {
    // the wheel channels, inner plate outward
    for (const sy of [1, -1] as const) out.push(bayBox(0, (sy * (innerHW + hw)) / 2, hl, (hw - innerHW) / 2, -1, BB_DECK_Z, 0, 'channel'));
  }
  for (const k of intakeArmKeepOuts(spec)) out.push(bayBox(k.cx, k.cy, k.hx ?? 0, k.hy ?? 0, k.z0, k.z1, 0, 'intakeArm'));
  return out;
}

/** the drive motors: fixed poses per drivetrain (see `bbBayLayout`), or `null` if any of them hits */
function bayDriveMotors(spec: RobotSpec, obstacles: readonly BbBayShape[]): { motors: BbBayMotor[]; belts: BbBayBelt[] } | null {
  const hl = spec.length / 2;
  const hw = spec.width / 2;
  const innerHW = innerHalfWidth(spec);
  const M = BB_DRIVE_MOTOR;
  const motors: BbBayMotor[] = [];
  const belts: BbBayBelt[] = [];
  const dt = spec.drivetrain;
  if (dt === 'swerve') {
    // a pod carries no motor (owner, 2026-09-19), so each drives its pod through a belt that is not
    // drawn: the motor lies along y on the outer plate's inner face, behind the solid sign land, and
    // clear of the pod's sweep
    const x = Math.min(hl - 2 * BB_POD_INSET - BAY_CLEAR - M.gearR, BB_SIGN_LAND_HALF - M.gearR);
    for (const [sx, sy] of WHEEL_CORNERS) motors.push({ x: sx * x, y: sy * (hw - BB_PLATE_T), z: BB_PLATE_H * 0.5, ux: 0, uy: -sy, shaft: false });
  } else if (dt === 'xdrive') {
    // on each omni's own canted axle, inboard of the wheel, its shaft into the wheel's bore (the
    // wheel is clear of its own motor by the face gap, which is the one pair not tested below)
    const ax = Math.max(0.5, hl - BB_XDRIVE_INSET_X);
    const ay = Math.max(0.5, hw - BB_XDRIVE_INSET_Y);
    for (const [sx, sy] of WHEEL_CORNERS) {
      const ux = -sx / Math.SQRT2;
      const uy = -sy / Math.SQRT2;
      motors.push({ x: sx * ax + ux * BAY_XDRIVE_FACE, y: sy * ay + uy * BAY_XDRIVE_FACE, z: BB_OMNI.r, ux, uy, shaft: true });
    }
  } else {
    // coaxial with each END axle (a tank's middle wheel is driven from its neighbours), face-bolted
    // to the inner plate and pointing inboard — unless the pair on one axle would meet in the
    // middle: then each is set `BAY_STAGGER` off it (left back, right forward, which the pattern
    // turned 180° about z reproduces) on a mount plate, and drives its axle through a belt
    const z = BB_WHEEL_PARTS[wheelKindOf(dt)].r;
    const stagger = 2 * M.len + BAY_CLEAR > 2 * innerHW;
    for (const x of axleXs(spec)) {
      if (Math.abs(x) < 1e-9) continue;
      for (const sy of [1, -1] as const) {
        if (!stagger) motors.push({ x, y: sy * innerHW, z, ux: 0, uy: -sy, shaft: false });
        else {
          const xm = x - sy * BAY_STAGGER;
          motors.push({ x: xm, y: sy * (innerHW - BAY_MOUNT_OFF), z, ux: 0, uy: -sy, shaft: false });
          belts.push({ sy, x0: x, x1: xm, z });
        }
      }
    }
  }
  const parts = bayAssemblies(motors, belts, innerHW);
  // inside the frame — on a channel drivetrain inside the inner plates, which are what the motors
  // and their mounts are bolted to, so the channels themselves are not obstacles to them; and an
  // X-drive's motor clears its own wheel by the bracket's gap rather than by `BAY_CLEAR`
  const side = dt === 'swerve' || dt === 'xdrive' ? hw - BB_PLATE_T : innerHW;
  for (let i = 0; i < parts.length; i++) {
    const { own, s } = parts[i];
    const c = Math.abs(Math.cos(s.a));
    const sn = Math.abs(Math.sin(s.a));
    const ex = s.hx * c + s.hy * sn;
    const ey = s.hx * sn + s.hy * c;
    if (Math.abs(s.cx) + ex > hl - BB_PLATE_T + 1e-6 || Math.abs(s.cy) + ey > side + 1e-6 || s.z1 > BB_BAY_CEILING + 1e-6) return null;
    if (obstacles.some((o) => o.what !== 'channel' && o.what !== `omni${own}` && bbBayHit(s, o, BAY_CLEAR))) return null;
    for (let j = i + 1; j < parts.length; j++) if (parts[j].own !== own && bbBayHit(s, parts[j].s, BAY_CLEAR)) return null;
  }
  return { motors, belts };
}

/** the poses a box is tried at, nearest the bay's centre first: 0.25-in steps out to ±`reach` */
function bayOffsets(reach: number): [number, number][] {
  const out: [number, number][] = [];
  const n = Math.round(reach / 0.25);
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) out.push([i * 0.25, j * 0.25]);
  // nearest first; ties go to the smaller |y| (along the chassis), then to +x, then to +y
  return out.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]) || Math.abs(a[1]) - Math.abs(b[1]) || b[0] - a[0] || b[1] - a[1]);
}
const BAY_OFFSETS = bayOffsets(3);
/** ...and the battery's, which may sit out by the motors at either end (the Skimmer's does) */
const BAY_OFFSETS_WIDE = bayOffsets(5);

/**
 * WHERE A DRIVE MOTOR OR ITS BELT DRIVE IS BOLTED TO AN INNER SIDE PLATE, in the plate's own (x, z):
 * a lightening hole there would leave a motor's face over a hole — on a 15-in chassis the plate's
 * end holes (r 1.13 at x ±4.83) sat round the motors' whole faces at x ±4.75. High's inner plates
 * leave these solid (`buildFrame`). None where the bay is not drawn (`bbBayShown`): no motor is
 * bolted there, and a build that shows no bay never pays for the layout (1.8–2.5 ms median, up to
 * 20 ms, on a side-intake mecanum, tank or butterfly). Where it is drawn the layout is needed for the bay
 * anyway, and the cache hands both the same one. EXPORTED for the RENDER lane.
 */
export function bbInnerPlateLands(spec: RobotSpec): { x0: number; x1: number; z0: number; z1: number }[] {
  if (spec.imported || spec.drivetrain === 'swerve' || spec.drivetrain === 'xdrive' || !bbBayShown(spec)) return [];
  const lay = bbBayLayout(spec);
  const innerHW = innerHalfWidth(spec);
  const R = BB_DRIVE_MOTOR.gearR;
  const out = lay.motors.filter((m) => Math.abs(Math.abs(m.y) - innerHW) < 1e-6).map((m) => ({ x0: m.x - R, x1: m.x + R, z0: m.z - R, z1: m.z + R }));
  for (const b of lay.belts) {
    const s = bayBeltShape(b, innerHW);
    out.push({ x0: s.cx - s.hx, x1: s.cx + s.hx, z0: b.z - BAY_MOUNT_HALF, z1: b.z + BAY_MOUNT_HALF });
  }
  return out;
}

const BAY_LAYOUT_CACHE = new Map<string, BbBayLayout>();
/**
 * THE LAYOUT'S CACHE KEY: only what moves anything under the deck — the size, the drivetrain and
 * the mouths (mount, intake preset and kind), which are all `bbUnderDeckObstacles` and the motors
 * read. It was `bbSpecKey`, so a colour, decal or team number change re-ran the whole layout
 * (1.6 ms median, 3.5 worst) for an equal new object. The launcher and the lift stay out: nothing on the deck
 * reaches under it (the RENDER lane sweeps them and asserts the obstacles do not change). An
 * import keys on its whole descriptor, as everywhere. EXPORTED for the RENDER lane.
 */
export function bbBayLayoutKey(spec: RobotSpec): string {
  if (spec.imported) return bbSpecKey(spec);
  return [spec.length, spec.width, spec.drivetrain, bbIntakeMountOf(spec), spec.intake, bbIntakeKindOf(spec)].join('|');
}
/**
 * WHERE EVERYTHING IN THE BAY GOES — pure numbers, cached per build (`bbBayLayoutKey`). EXPORTED
 * for the RENDER lane.
 *
 *  1. THE DRIVE MOTORS, one per driven wheel: on mecanum, tank (its end axles) and butterfly (the
 *     corner set) coaxial with the axle and face-bolted to the inner plate — on a chassis under
 *     14.73 in wide, where an axle's pair would meet, each set `BAY_STAGGER` off its axle on a
 *     mount plate with a belt to it; on X-drive on each omni's canted axle, on a bracket hung
 *     from the deck; on swerve along y on the outer plate. All four or none: an X-drive's four
 *     meet in the middle under 15 in long.
 *  2. THE HUBS AND THE BATTERY, side by side as one pair, as near the middle as the pair goes: the
 *     Control Hub on 6 mm standoffs on the pan with the Expansion Hub on 10 mm standoffs on it,
 *     else the Control Hub alone, else the Control Hub raised on 48 mm standoffs over the motors
 *     (an X-drive). Placed one at a time, a hub took the middle and left the battery no room on any
 *     chassis under ~18 in wide.
 *  3. Where no pair fits, the hubs first and the battery wherever it then goes.
 *  4. THE LEADS, one per motor to the Control Hub, round everything above (`bayWires`).
 * Measured over 540 builds (`robot/bay`): motors on every channel and swerve build and on every
 * X-drive 15 in long or more, a Control Hub on all of them, a battery on 92 %, and the leads on
 * every driven build but 9 of the 81 driven X-drives. The misses are the 13.5 x 14.5 channel
 * chassis and the 14.5-in-wide X-drives; nothing is forced in.
 */
export function bbBayLayout(spec: RobotSpec): BbBayLayout {
  const key = bbBayLayoutKey(spec);
  const hit = BAY_LAYOUT_CACHE.get(key);
  if (hit) return hit;
  const obstacles = bbUnderDeckObstacles(spec);
  const drive = bayDriveMotors(spec, obstacles) ?? { motors: [], belts: [] };
  const innerHW = innerHalfWidth(spec);
  const C = BAY_CLEAR;
  // everything a hub or the battery must clear, each with its plan bounds for a cheap first test
  const avoid = [...obstacles.filter((o) => o.z1 > BB_BAY_FLOOR + 1e-6), ...bayAssemblies(drive.motors, drive.belts, innerHW).map((a) => a.s)].map(
    (o) => {
      const ex = o.r ?? o.hx * Math.abs(Math.cos(o.a)) + o.hy * Math.abs(Math.sin(o.a));
      const ey = o.r ?? o.hx * Math.abs(Math.sin(o.a)) + o.hy * Math.abs(Math.cos(o.a));
      return { o, x0: o.cx - ex, x1: o.cx + ex, y0: o.cy - ey, y1: o.cy + ey };
    },
  );
  const panHX = bbPanLength(spec) / 2;
  /** an axis-aligned box: on the pan, under the ceiling, clear of everything */
  const fits = (s: BbBayShape): boolean => {
    if (Math.abs(s.cx) + s.hx > panHX - C + 1e-9 || Math.abs(s.cy) + s.hy > innerHW - C + 1e-9 || s.z1 > BB_BAY_CEILING - C + 1e-9) return false;
    for (const q of avoid) {
      if (s.cx + s.hx + C <= q.x0 || q.x1 + C <= s.cx - s.hx || s.cy + s.hy + C <= q.y0 || q.y1 + C <= s.cy - s.hy) continue;
      if (bbBayHit(s, q.o, C)) return false;
    }
    return true;
  };
  const H = BB_HUB;
  type Stack = { shapes: BbBayShape[]; hubs: BbBayBox[]; standoffs: BbBayLayout['standoffs'] };
  /** the hub stack centred at (cx, cy): solid from the pan up — or, raised over an X-drive's
   *  motors, a hub on four standoffs that alone reach the pan */
  const stackAt = (mode: 'stack' | 'single' | 'raised', along: boolean, cx: number, cy: number): Stack => {
    const z0 = BB_BAY_FLOOR + (mode === 'raised' ? HUB_STANDOFF_TALL : HUB_STANDOFF_LOW);
    const hx = (along ? H.l : H.w) / 2;
    const hy = (along ? H.w : H.l) / 2;
    const px = (along ? H.holeL : H.holeW) / 2;
    const py = (along ? H.holeW : H.holeL) / 2;
    const holes: [number, number][] = [
      [cx + px, cy + py],
      [cx - px, cy + py],
      [cx + px, cy - py],
      [cx - px, cy - py],
    ];
    const hubs: BbBayBox[] = [{ cx, cy, z0, hx, hy, h: H.h }];
    const standoffs = holes.map(([x, y]) => ({ x, y, z0: BB_BAY_FLOOR, z1: z0 }));
    if (mode === 'stack') {
      const z2 = z0 + H.h + HUB_STANDOFF_MID;
      hubs.push({ cx, cy, z0: z2, hx, hy, h: H.h });
      standoffs.push(...holes.map(([x, y]) => ({ x, y, z0: z0 + H.h, z1: z2 })));
    }
    const top = hubs[hubs.length - 1].z0 + H.h;
    const shapes =
      mode === 'raised'
        ? [bayBox(cx, cy, hx, hy, z0, top), ...holes.map(([x, y]) => bayBox(x, y, HUB_STANDOFF_R, HUB_STANDOFF_R, BB_BAY_FLOOR, z0))]
        : [bayBox(cx, cy, hx, hy, BB_BAY_FLOOR, top)];
    return { shapes, hubs, standoffs };
  };
  const batteryAt = (along: boolean, cx: number, cy: number): BbBayBox => ({
    cx,
    cy,
    z0: BB_BAY_FLOOR,
    hx: (along ? BB_BATTERY.l : BB_BATTERY.w) / 2,
    hy: (along ? BB_BATTERY.w : BB_BATTERY.l) / 2,
    h: BB_BATTERY.h,
  });
  const batteryShape = (b: BbBayBox): BbBayShape => bayBox(b.cx, b.cy, b.hx, b.hy, b.z0, b.z0 + b.h);
  const MODES = ['stack', 'single', 'raised'] as const;
  // whether each part fits anywhere on its own: a pair is not tried round a part that does not
  // (an X-drive's motors leave no room for a low stack, which was 50 ms of pairs on a narrow one)
  const memo = new Map<string, boolean>();
  const anywhere = (k: string, test: (dx: number, dy: number) => boolean, offsets = BAY_OFFSETS): boolean => {
    let v = memo.get(k);
    if (v === undefined) memo.set(k, (v = offsets.some(([dx, dy]) => test(dx, dy))));
    return v;
  };
  let stack: Stack | null = null;
  let battery: BbBayBox | null = null;
  // ── THE HUBS AND THE BATTERY TOGETHER, side by side, the pair as near the centre as it goes. A
  // hub placed first at the centre leaves no room for the battery on any chassis under ~18 in
  // wide, though the two fit side by side on all of them.
  pairs: for (const mode of MODES) {
    for (const hubAlong of [true, false]) {
      if (!anywhere(`h${mode}${hubAlong}`, (dx, dy) => stackAt(mode, hubAlong, dx, dy).shapes.every(fits))) continue;
      for (const batAlong of [true, false]) {
        if (!anywhere(`b${batAlong}`, (dx, dy) => fits(batteryShape(batteryAt(batAlong, dx, dy))), BAY_OFFSETS_WIDE)) continue;
        for (const [sx, sy] of [
          [0, 1],
          [0, -1],
          [1, 0],
          [-1, 0],
        ] as const) {
          // the battery's centre off the hub's, then the pair's own centre off the hub's
          const h0 = stackAt(mode, hubAlong, 0, 0).hubs[0];
          const b0 = batteryAt(batAlong, 0, 0);
          const bx = sx * (h0.hx + C + b0.hx);
          const by = sy * (h0.hy + C + b0.hy);
          const mx = (Math.min(-h0.hx, bx - b0.hx) + Math.max(h0.hx, bx + b0.hx)) / 2;
          const my = (Math.min(-h0.hy, by - b0.hy) + Math.max(h0.hy, by + b0.hy)) / 2;
          // a pair longer or wider than the pan fits at no offset
          if (Math.max(h0.hx, bx + b0.hx) - mx > panHX - C || Math.max(h0.hy, by + b0.hy) - my > innerHW - C) continue;
          for (const [dx, dy] of BAY_OFFSETS) {
            const b = batteryAt(batAlong, dx - mx + bx, dy - my + by);
            if (!fits(batteryShape(b))) continue;
            const st = stackAt(mode, hubAlong, dx - mx, dy - my);
            if (!st.shapes.every(fits)) continue;
            stack = st;
            battery = b;
            break pairs;
          }
        }
      }
    }
  }
  // ── ...ELSE EACH ON ITS OWN: the hubs first, then the battery round them
  if (!stack) {
    hubs: for (const mode of MODES) {
      for (const along of [true, false]) {
        for (const [dx, dy] of BAY_OFFSETS) {
          const st = stackAt(mode, along, dx, dy);
          if (st.shapes.every(fits)) {
            stack = st;
            break hubs;
          }
        }
      }
    }
    const taken = stack?.shapes ?? [];
    bat: for (const along of [true, false]) {
      for (const [dx, dy] of BAY_OFFSETS_WIDE) {
        const b = batteryAt(along, dx, dy);
        const s = batteryShape(b);
        if (fits(s) && !taken.some((t) => bbBayHit(s, t, C))) {
          battery = b;
          break bat;
        }
      }
    }
  }
  const hubs = stack?.hubs ?? [];
  const standoffs = stack?.standoffs ?? [];
  const out: BbBayLayout = { motors: drive.motors, belts: drive.belts, hubs, battery, standoffs, wires: [] };
  // 4. THE LEADS, last, round everything placed (`bayWires`)
  out.wires = bayWires(spec, obstacles, out);
  if (BAY_LAYOUT_CACHE.size >= 64) BAY_LAYOUT_CACHE.delete(BAY_LAYOUT_CACHE.keys().next().value!);
  BAY_LAYOUT_CACHE.set(key, out);
  return out;
}

/** how far from a point to a bay shape (0 inside it). EXPORTED for the RENDER lane. */
export function bbBayDist(s: BbBayShape, x: number, y: number, z: number): number {
  const dz = Math.max(0, s.z0 - z, z - s.z1);
  const dx = x - s.cx;
  const dy = y - s.cy;
  let dp: number;
  if (s.r !== undefined) dp = Math.max(0, Math.hypot(dx, dy) - s.r);
  else {
    const c = Math.cos(s.a);
    const n = Math.sin(s.a);
    dp = Math.hypot(Math.max(0, Math.abs(dx * c + dy * n) - s.hx), Math.max(0, Math.abs(-dx * n + dy * c) - s.hy));
  }
  return Math.hypot(dp, dz);
}

type P3 = [number, number, number];
/** round each corner of a polyline: a quadratic arc from `bend` before the corner to `bend` after
 *  it (at most 0.45 of either leg, so two corners never share a stretch), in `steps` pieces */
function filletPolyline(p: readonly P3[], bend: number, steps: number): P3[] {
  const pts = p.filter((q, i) => i === 0 || Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1], q[2] - p[i - 1][2]) > 1e-6);
  const out: P3[] = [[...pts[0]]];
  for (let i = 1; i + 1 < pts.length; i++) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
    const d1 = [0, 1, 2].map((k) => (b[k] - a[k]) / l1);
    const d2 = [0, 1, 2].map((k) => (c[k] - b[k]) / l2);
    if (d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2] > 0.9999) continue;
    const t = Math.min(bend, 0.45 * l1, 0.45 * l2);
    const p1 = [0, 1, 2].map((k) => b[k] - d1[k] * t);
    const p2 = [0, 1, 2].map((k) => b[k] + d2[k] * t);
    for (let j = 0; j <= steps; j++) {
      const s = j / steps;
      out.push([0, 1, 2].map((k) => (1 - s) * (1 - s) * p1[k] + 2 * s * (1 - s) * b[k] + s * s * p2[k]) as P3);
    }
  }
  out.push([...pts[pts.length - 1]]);
  return out;
}
/** points along a polyline no more than `step` apart, both ends included */
function samplePolyline(p: readonly P3[], step: number): P3[] {
  const out: P3[] = [[...p[0]]];
  for (let i = 1; i < p.length; i++) {
    const [a, b] = [p[i - 1], p[i]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / step));
    for (let j = 1; j <= n; j++) out.push([0, 1, 2].map((k) => a[k] + ((b[k] - a[k]) * j) / n) as P3);
  }
  return out;
}

/** a lead may touch its own motor only within this much (plan) of where it leaves the cover, and
 *  the Control Hub only within this much of its own end, inside the port. EXPORTED for the lane. */
export const BAY_WIRE_OWN = 0.3;
export const BAY_WIRE_PORT_FREE = 0.12;

/**
 * THE LEADS (High, 2026-10-11) — each drive motor's to a port on the Control Hub, routed round
 * everything already in the bay and never through it. Pure numbers, part of `bbBayLayout`.
 *
 * A lead leaves its motor straight DOWN from the encoder cover, lies on the belly pan, and runs
 * along it to a port on one of the Control Hub's long sides, where it rises `BAY_PORT_OUT` off the
 * case and turns into the port. The run on the pan is a fewest-steps path on a `BAY_WIRE_GRID`
 * grid: a breadth-first fill out from the open ports, then walked downhill from the motor's drop,
 * keeping its heading while that still descends, so a lead runs square to the frame the way a
 * tied-down one does and turns only where it has to. Every cell within `BAY_WIRE_R +
 * BAY_WIRE_CLEAR` of a part that reaches down to the pan is closed (the hubs' standoffs, the
 * battery, a staggered motor's mount plate, an X-drive's brackets and omnis, the inner plates), and
 * so is every other motor's drop and every lead already routed — a lead never crosses another. A
 * lead may pass UNDER a part that stands clear of the pan by the gap (a motor's can, a hub raised
 * on 48 mm standoffs over an X-drive's motors), but not under a hub less than 0.5 in up (the
 * Control Hub on its 6 mm standoffs), where it would run hidden and come out the far side. Its
 * corners are rounded (`filletPolyline`),
 * and the rounded lead is checked again, sample by sample, against every part, the pan and the
 * other leads; one that fails takes the next port, and one with no clear port is left out rather
 * than drawn through a part. The ports are `BAY_PORT_PITCH` apart along the strip, one lead each.
 */
function bayWires(spec: RobotSpec, obstacles: readonly BbBayShape[], lay: BbBayLayout): BbBayWire[] {
  const hub = lay.hubs[0];
  if (!hub || !lay.motors.length) return [];
  const R = BAY_WIRE_R;
  const CL = BAY_WIRE_CLEAR;
  const G = BAY_WIRE_GRID;
  const Z = BAY_WIRE_Z;
  const M = BB_DRIVE_MOTOR;
  const innerHW = innerHalfWidth(spec);
  const panHX = bbPanLength(spec) / 2;
  type Solid = { what: string; s: BbBayShape; x0: number; x1: number; y0: number; y1: number };
  const bound = (what: string, s: BbBayShape): Solid => {
    const ex = s.r ?? s.hx * Math.abs(Math.cos(s.a)) + s.hy * Math.abs(Math.sin(s.a));
    const ey = s.r ?? s.hx * Math.abs(Math.sin(s.a)) + s.hy * Math.abs(Math.cos(s.a));
    return { what, s, x0: s.cx - ex, x1: s.cx + ex, y0: s.cy - ey, y1: s.cy + ey };
  };
  // every part a lead must clear but the pan, which it lies on (and keeps off by its own height)
  const solids = [...obstacles.filter((o) => o.what !== 'pan').map((s) => bound(s.what ?? '', s)), ...bbBayShapes(spec, lay).map(({ what, s }) => bound(what, s))];
  // on the pan the grid also keeps a lead out from under a hub stack standing on it, where it
  // would run hidden and come out the far side (a raised hub, over an X-drive's motors, is open)
  const low = solids.filter(({ s }) => s.z0 < Z + R + CL && s.z1 > Z - R - CL);
  if (hub.z0 - BB_BAY_FLOOR < 0.5) low.push(bound('hubs', bayBox(hub.cx, hub.cy, hub.hx, hub.hy, BB_BAY_FLOOR, hub.z0)));
  // the grid: cell centres on the pan, `R` in from its edges
  const nx = Math.floor((2 * (panHX - R - 0.01)) / G) + 1;
  const ny = Math.floor((2 * (innerHW - R - 0.01)) / G) + 1;
  const x0 = (-(nx - 1) * G) / 2;
  const y0 = (-(ny - 1) * G) / 2;
  const cellOf = (x: number, y: number): number => {
    const i = Math.round((x - x0) / G);
    const j = Math.round((y - y0) / G);
    return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i;
  };
  /** close every cell within `d` of a solid at the lead's height on the pan (or, with no solid, of
   *  a point) */
  const stamp = (grid: Uint8Array, d: number, so: Solid | null, px = 0, py = 0): void => {
    const [ax, bx, ay, by] = so ? [so.x0, so.x1, so.y0, so.y1] : [px, px, py, py];
    const i0 = Math.max(0, Math.floor((ax - d - x0) / G));
    const i1 = Math.min(nx - 1, Math.ceil((bx + d - x0) / G));
    const j0 = Math.max(0, Math.floor((ay - d - y0) / G));
    const j1 = Math.min(ny - 1, Math.ceil((by + d - y0) / G));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = x0 + i * G;
        const y = y0 + j * G;
        if ((so ? bbBayDist(so.s, x, y, Z) : Math.hypot(x - px, y - py)) < d) grid[j * nx + i] = 1;
      }
    }
  };
  const base = new Uint8Array(nx * ny);
  for (const so of low) stamp(base, R + CL + G / 2, so);
  const T = R + CL;
  /** is a part within `T` of a point — but the Control Hub, near `end`, where the lead is in its port */
  const touches = (q: P3, end: P3 | null, skip: string | null): boolean => {
    const nearEnd = end !== null && Math.hypot(q[0] - end[0], q[1] - end[1], q[2] - end[2]) < BAY_WIRE_PORT_FREE;
    for (const so of solids) {
      const s = so.s;
      if (q[0] < so.x0 - T || q[0] > so.x1 + T || q[1] < so.y0 - T || q[1] > so.y1 + T || q[2] < s.z0 - T || q[2] > s.z1 + T) continue;
      if (so.what === skip) continue;
      if (nearEnd && so.what === 'hubs') continue;
      if (bbBayDist(s, q[0], q[1], q[2]) < T) return true;
    }
    return false;
  };
  /** a port's rise off the pan and its turn into the strip, clear of everything (a motor's can
   *  over the pan closes the ports above it) */
  const tailClear = (tail: readonly P3[]): boolean => {
    const end = tail[tail.length - 1];
    return samplePolyline(filletPolyline(tail, BAY_WIRE_BEND, 3), 0.03).every((q) => !touches(q, end, null));
  };
  // ── THE PORTS: both long sides of the Control Hub, `BAY_PORT_PITCH` apart along each strip
  const along = hub.hx > hub.hy;
  const hLong = along ? hub.hx : hub.hy;
  const hShort = along ? hub.hy : hub.hx;
  const zp = hub.z0 + hub.h - HUB_PORT_DROP;
  const uMax = hLong - HUB_PORT_INSET - 0.15;
  const count = Math.floor((2 * uMax) / BAY_PORT_PITCH + 1e-9) + 1;
  /** `ok`: whether its rise and turn are clear, found the first time a search ends there */
  type Port = { nx: number; ny: number; x: number; y: number; tail: P3[]; cell: number; ok: boolean | undefined };
  const ports: Port[] = [];
  for (const side of [1, -1] as const) {
    const [nX, nY] = along ? [0, side] : [side, 0];
    const [tX, tY] = along ? [1, 0] : [0, 1];
    for (let k = 0; k < count; k++) {
      const u = (-(count - 1) * BAY_PORT_PITCH) / 2 + k * BAY_PORT_PITCH;
      const at = (off: number, z: number): P3 => [hub.cx + tX * u + nX * off, hub.cy + tY * u + nY * off, z];
      // in at the pan, up `BAY_PORT_OUT` off the case, and 0.03 into the strip's face
      const tail = [at(hShort + BAY_PORT_OUT, Z), at(hShort + BAY_PORT_OUT, zp), at(hShort + HUB_PORT_PROUD - 0.03, zp)];
      const cell = cellOf(tail[0][0], tail[0][1]);
      if (cell < 0 || base[cell]) continue;
      ports.push({ nx: nX, ny: nY, x: tail[2][0], y: tail[2][1], tail, cell, ok: undefined });
    }
  }
  // ── EACH MOTOR'S DROP: straight down from the middle of its encoder cover onto the pan
  const tc = M.len - M.encL / 2;
  const drops = lay.motors.map((m): P3 => [m.x + m.ux * tc, m.y + m.uy * tc, m.z - M.encR + 0.04]);
  /** is a lead clear of everything — the parts (its own motor near its start and the hub inside
   *  its port excepted), the pan, and the leads already routed (`near`, hashed by 0.25-in cell)? */
  const clear = (pts: readonly P3[], own: number, near: Map<number, P3[]>): boolean => {
    const start = pts[0];
    const end = pts[pts.length - 1];
    for (const q of pts) {
      if (q[2] - R < BB_BAY_FLOOR + 0.005) return false;
      const nearStart = Math.hypot(q[0] - start[0], q[1] - start[1]) < BAY_WIRE_OWN;
      if (touches(q, end, nearStart ? `motor${own}` : null)) return false;
      const ci = Math.floor(q[0] / 0.25);
      const cj = Math.floor(q[1] / 0.25);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          for (const p of near.get((ci + di) * 4096 + cj + dj) ?? NONE) if (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 2 * R + BAY_WIRE_GAP) return false;
        }
      }
    }
    return true;
  };
  const NONE: readonly P3[] = [];
  const hash = (map: Map<number, P3[]>, pts: readonly P3[]): void => {
    for (const p of pts) {
      const k = Math.floor(p[0] / 0.25) * 4096 + Math.floor(p[1] / 0.25);
      let list = map.get(k);
      if (!list) map.set(k, (list = []));
      list.push(p);
    }
  };
  // THE RUN: a breadth-first fill out from the open ports round the closed cells, then from the
  // start downhill, keeping its heading while that still descends — a shortest run in steps that
  // goes straight until it has to turn, square to the frame the way a tied-down lead runs
  const DX = [1, 0, -1, 0];
  const DY = [0, nx, 0, -nx];
  const dist = new Int32Array(nx * ny);
  const queue = new Int32Array(nx * ny);
  const step = (c: number, e: number): number => {
    const i = (c % nx) + DX[e];
    return i < 0 || i >= nx ? -1 : c + DX[e] + DY[e];
  };
  /** the run's cells from `start` to a port's foot, or null if no open port can be reached */
  const run = (grid: Uint8Array, start: number, target: Map<number, Port>): number[] | null => {
    dist.fill(-1);
    let qn = 0;
    for (const c of target.keys()) {
      dist[c] = 0;
      queue[qn++] = c;
    }
    for (let qi = 0; qi < qn; qi++) {
      const c = queue[qi];
      for (let e = 0; e < 4; e++) {
        const nc = step(c, e);
        if (nc < 0 || nc >= nx * ny || grid[nc] || dist[nc] >= 0) continue;
        dist[nc] = dist[c] + 1;
        queue[qn++] = nc;
      }
    }
    if (dist[start] < 0) return null;
    const cells = [start];
    for (let c = start, d = 0; dist[c] > 0; cells.push(c)) {
      for (const e of [d, 0, 1, 2, 3]) {
        const nc = step(c, e);
        if (nc >= 0 && nc < nx * ny && dist[nc] === dist[c] - 1) {
          [c, d] = [nc, e];
          break;
        }
      }
    }
    return cells;
  };
  /** the lead along a run: its corners, the true ends in place of the cells they are in with each
   *  end's leg kept square to the grid (a run with no corner takes up the two ends' offsets in a
   *  jog halfway), the drop and the rise, every corner rounded */
  const leadFrom = (cells: readonly number[], s0: P3, port: Port): P3[] => {
    const at = (c: number): [number, number] => [x0 + (c % nx) * G, y0 + Math.floor(c / nx) * G];
    const corners = cells.filter((c, i) => i === 0 || i === cells.length - 1 || c - cells[i - 1] !== cells[i + 1] - c).map(at);
    if (corners.length === 1) corners.push(at(cells[0]));
    const foot = port.tail[0];
    const n = corners.length;
    const firstX = corners[1][1] === corners[0][1];
    const lastX = corners[n - 1][1] === corners[n - 2][1];
    if (n === 2) {
      const m = (firstX ? s0[0] + foot[0] : s0[1] + foot[1]) / 2;
      corners.splice(1, 0, firstX ? [m, s0[1]] : [s0[0], m], firstX ? [m, foot[1]] : [foot[0], m]);
    } else {
      corners[1][firstX ? 1 : 0] = s0[firstX ? 1 : 0];
      corners[n - 2][lastX ? 1 : 0] = foot[lastX ? 1 : 0];
    }
    corners[0] = [s0[0], s0[1]];
    corners[corners.length - 1] = [foot[0], foot[1]];
    return filletPolyline([s0, ...corners.map(([x, y]): P3 => [x, y, Z]), ...port.tail.slice(1)], BAY_WIRE_BEND, 3);
  };
  /** every motor's lead in `order`, each routed round the ones before it */
  const routeAll = (order: readonly number[]): BbBayWire[] => {
    const wires: BbBayWire[] = [];
    const near = new Map<number, P3[]>();
    const used = new Set<Port>();
    const routedLow: P3[] = [];
    for (const k of order) {
      const s0 = drops[k];
      const start = cellOf(s0[0], s0[1]);
      if (start < 0) return [];
      const grid = base.slice();
      drops.forEach((d, j) => {
        if (j !== k) stamp(grid, 2 * R + BAY_WIRE_GAP + 0.005, null, d[0], d[1]);
      });
      for (const p of routedLow) stamp(grid, 2 * R + BAY_WIRE_GAP + 0.005, null, p[0], p[1]);
      if (grid[start]) return [];
      const open = ports.filter((p) => !used.has(p) && !grid[p.cell]);
      for (let attempt = 0; attempt < 4 && open.length; attempt++) {
        const target = new Map(open.map((p) => [p.cell, p]));
        const cells = run(grid, start, target);
        if (!cells) break;
        const port = target.get(cells[cells.length - 1])!;
        port.ok ??= tailClear(port.tail);
        if (!port.ok) {
          // a part over the port's foot (a motor's can) closes the port for every lead
          open.splice(open.indexOf(port), 1);
          attempt--;
          continue;
        }
        const pts = leadFrom(cells, s0, port);
        const samples = samplePolyline(pts, 0.03);
        if (clear(samples, k, near)) {
          used.add(port);
          hash(near, samples);
          for (const p of samplePolyline(pts, G / 2)) if (p[2] < Z + 2 * R + BAY_WIRE_GAP) routedLow.push(p);
          wires.push({ motor: k, pts, port: { nx: port.nx, ny: port.ny, x: port.x, y: port.y, z: zp } });
          break;
        }
        // the rounded lead touched something the grid let through: the next port
        open.splice(open.indexOf(port), 1);
      }
      if (wires.length === 0 || wires[wires.length - 1].motor !== k) return [];
    }
    return wires.sort((a, b) => a.motor - b.motor);
  };
  // ALL OR NONE, like the motors: a drivetrain is never drawn half wired. In motor order, else in
  // the reverse order (a lead routed first can wall off a later one's only way to a port).
  const ids = lay.motors.map((_, k) => k);
  const first = routeAll(ids);
  return first.length ? first : routeAll([...ids].reverse());
}


/** steps round a bay motor: a multiple of four, so it reaches its true radius on each axis */
const BAY_MOTOR_SEG = 20;
/** a 5203's two halves along +x from its mounting face (x = 0): the bare gearbox (and, where it is
 *  in the open, the output shaft ahead of the face), and the black can with its encoder cover */
function driveMotorProfiles(shaft: boolean): { metal: THREE.BufferGeometry[]; can: THREE.BufferGeometry[] } {
  const M = BB_DRIVE_MOTOR;
  const c = 0.02;
  const metal = [
    turnedPart(
      [
        [0, 0],
        [0, M.gearR - c],
        [c, M.gearR],
        [M.gearL - 0.03, M.gearR],
        [M.gearL, M.canR],
      ],
      BAY_MOTOR_SEG,
    ),
  ];
  if (shaft) {
    metal.push(
      turnedPart(
        [
          [-M.shaftL, 0],
          [-M.shaftL, M.shaftR],
          [0, M.shaftR],
        ],
        12,
      ),
    );
  }
  const can = [
    turnedPart(
      [
        [M.gearL, M.canR],
        [M.len - M.encL - 0.03, M.canR],
        [M.len - M.encL, M.canR - 0.03],
        [M.len - M.encL, M.encR],
        [M.len - 0.03, M.encR],
        [M.len, M.encR - 0.03],
        [M.len, 0],
      ],
      BAY_MOTOR_SEG,
    ),
  ];
  return { metal, can };
}

const HUB_CASE = '#1e2126';
/** JST-VH / PH housings, natural nylon — the motor and sensor ports along a hub's long sides */
const HUB_PORTS = '#cfc9bb';

/** A LEAD as a tube round its (already rounded) centreline: a ring of `radial` points at each point,
 *  turned along the line by parallel transport so it never twists. Open at both ends: they are
 *  inside the encoder cover and inside the port. */
function wireTube(pts: readonly P3[], r: number, radial: number): THREE.BufferGeometry {
  const n = pts.length;
  const sub = (a: readonly number[], b: readonly number[]): number[] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const unit = (v: number[]): number[] => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a: number[], b: number[]): number[] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const tangents = pts.map((_, i) => unit(i === 0 ? sub(pts[1], pts[0]) : i === n - 1 ? sub(pts[n - 1], pts[n - 2]) : [0, 1, 2].map((k) => unit(sub(pts[i + 1], pts[i]))[k] + unit(sub(pts[i], pts[i - 1]))[k])));
  // the first ring's reference: horizontal and square to the first leg (which drops straight down)
  let nrm = unit(cross(tangents[0], Math.abs(tangents[0][2]) > 0.9 ? [0, 1, 0] : [0, 0, 1]));
  const rings: number[][][] = [];
  const dirs: number[][][] = [];
  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    const d = nrm[0] * t[0] + nrm[1] * t[1] + nrm[2] * t[2];
    nrm = unit([nrm[0] - d * t[0], nrm[1] - d * t[1], nrm[2] - d * t[2]]);
    const bin = cross(t, nrm);
    const ring: number[][] = [];
    const dir: number[][] = [];
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const v = [0, 1, 2].map((c) => Math.cos(a) * nrm[c] + Math.sin(a) * bin[c]);
      dir.push(v);
      ring.push([0, 1, 2].map((c) => pts[i][c] + r * v[c]));
    }
    rings.push(ring);
    dirs.push(dir);
  }
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  let s = 0;
  for (let i = 0; i + 1 < n; i++) {
    const s1 = s + Math.hypot(...sub(pts[i + 1], pts[i]));
    for (let k = 0; k < radial; k++) {
      const k1 = (k + 1) % radial;
      // (i,k) → (i,k1) → (i+1,k) winds counter-clockwise seen from outside (the ring turns
      // right-handed about the tangent)
      for (const [ii, kk] of [
        [i, k],
        [i, k1],
        [i + 1, k],
        [i, k1],
        [i + 1, k1],
        [i + 1, k],
      ] as const) {
        pos.push(...rings[ii][kk]);
        nor.push(...dirs[ii][kk]);
        uv.push((kk === k1 && k1 === 0 ? radial : kk) / radial, ii === i ? s : s1);
      }
    }
    s = s1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}
/** the lead's ring: five points round — a 2.5 mm lead is 1 to 4 px across in the builder */
const BAY_WIRE_RADIAL = 5;

/** THE BAY'S MESHES (High, and only on a build that shows it): the motors' bare gearboxes, their
 *  cans, the hub cases with the battery, the standoffs and the leads, the port strips — and on a
 *  staggered build its belts and mount plates. None casts a shadow. */
function buildBay(spec: RobotSpec, id: number): THREE.Mesh[] {
  // called on High only (`ROBOT_LOD.bay`, in `buildRobotGroupParts`)
  if (!bbBayShown(spec)) return [];
  const lay = bbBayLayout(spec);
  const f = (v: number): string => v.toFixed(3);
  const out: THREE.Mesh[] = [];
  const add = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material, family: RobotFamily): void => {
    const m = tag(new THREE.Mesh(geo, mat), family);
    m.name = `robot:${id}:bay:${name}`;
    // under the deck: the physical twin occludes its view of the room (`renderSurfaceRobots.ts`)
    m.userData.bbEnclosed = true;
    out.push(m);
  };
  // a motor's parts, turned from +x onto its axis and moved to its face
  const place = (g: THREE.BufferGeometry, m: BbBayMotor): THREE.BufferGeometry => g.rotateZ(Math.atan2(m.uy, m.ux)).translate(m.x, m.y, m.z);
  if (lay.motors.length) {
    const mk = lay.motors.map((m) => `${f(m.x)},${f(m.y)},${f(m.z)},${f(m.ux)},${f(m.uy)}${m.shaft ? 's' : ''}`).join('/');
    add('gearbox', framePart(`bay:gear|${mk}`, () => lay.motors.flatMap((m) => driveMotorProfiles(m.shaft).metal.map((g) => place(g, m)))), solidMat(SCREW, 0.45, 0.5), 'steel');
    add('motor', framePart(`bay:can|${mk}`, () => lay.motors.flatMap((m) => driveMotorProfiles(false).can.map((g) => place(g, m)))), solidMat(MOTOR, 0.5, 0.4), 'dark');
  }
  if (lay.belts.length) {
    const innerHW = innerHalfWidth(spec);
    const bk = lay.belts.map((b) => `${b.sy},${f(b.x0)},${f(b.x1)},${f(b.z)}`).join('/');
    const yBelt = innerHW - 0.1 - BAY_PULLEY_W / 2;
    add(
      'belt',
      framePart(`bay:belt|${f(innerHW)}|${bk}`, () =>
        lay.belts.flatMap((b) => {
          const parts: THREE.BufferGeometry[] = [];
          for (const x of [b.x0, b.x1]) parts.push(new THREE.CylinderGeometry(BAY_PULLEY_R, BAY_PULLEY_R, BAY_PULLEY_W, 20).translate(x, b.sy * yBelt, b.z));
          // two equal pulleys: the belt's runs are straight, over the top and under the bottom
          for (const s of [1, -1] as const) {
            parts.push(new THREE.BoxGeometry(Math.abs(b.x1 - b.x0), BAY_PULLEY_W - 0.04, BAY_BELT_T).translate((b.x0 + b.x1) / 2, b.sy * yBelt, b.z + s * (BAY_PULLEY_R + BAY_BELT_T / 2)));
          }
          return parts;
        }),
      ),
      solidMat(SWEEPER, 0.6, 0.2),
      'belt',
    );
  }
  // the aluminium the motors are mounted on: a staggered pair's mount plates and their standoffs,
  // and an X-drive motor's bracket
  const brackets = lay.motors.filter((m) => m.shaft);
  if (lay.belts.length || brackets.length) {
    const innerHW = innerHalfWidth(spec);
    const bk = lay.belts.map((b) => `${b.sy},${f(b.x0)},${f(b.x1)},${f(b.z)}`).join('/');
    const mk = brackets.map((m) => `${f(m.x)},${f(m.y)},${f(m.z)},${f(m.ux)},${f(m.uy)}`).join('/');
    add(
      'mount',
      framePart(`bay:mount|${f(innerHW)}|${bk}|${mk}`, () => {
        const parts: THREE.BufferGeometry[] = [];
        for (const b of lay.belts) {
          const s = bayBeltShape(b, innerHW);
          const yPlate = innerHW - BAY_MOUNT_OFF + BAY_MOUNT_T / 2;
          parts.push(chamferBoxAt(s.hx * 2, BAY_MOUNT_T, BAY_MOUNT_HALF * 2, s.cx, b.sy * yPlate, b.z, 0.02));
          // four standoffs from the inner plate to the mount plate, above and below the belt
          const len = BAY_MOUNT_OFF - BAY_MOUNT_T;
          for (const x of [b.x0, b.x1]) {
            for (const dz of [BAY_MOUNT_STANDOFF_DZ, -BAY_MOUNT_STANDOFF_DZ]) {
              parts.push(new THREE.CylinderGeometry(BAY_MOUNT_STANDOFF_R, BAY_MOUNT_STANDOFF_R, len, 8, 1, true).translate(x, b.sy * (innerHW - len / 2), b.z + dz));
            }
          }
        }
        for (const m of brackets) {
          const s = bayBracketShape(m);
          parts.push(chamferBox(BAY_BRACKET_T, BAY_BRACKET_HALF * 2, s.z1 - s.z0, 0.02).rotateZ(s.a).translate(s.cx, s.cy, (s.z0 + s.z1) / 2));
        }
        return parts;
      }),
      solidMat(ALU, 0.45, 0.35),
      'alu',
    );
  }
  const boxes = [...lay.hubs, ...(lay.battery ? [lay.battery] : [])];
  if (boxes.length) {
    const bk = boxes.map((b) => `${f(b.cx)},${f(b.cy)},${f(b.z0)},${f(b.hx)},${f(b.hy)}`).join('/');
    // the leads are keyed on their own points: they go round everything in the bay, the intake
    // arms included, so two builds with the same boxes can still route them differently
    const wk = lay.wires.map((w) => w.pts.map((p) => p.map(f).join(',')).join(';')).join('/');
    add(
      'hub',
      framePart(`bay:case|${bk}|${lay.battery ? 'b' : ''}|w${wk}`, () => {
        const parts = lay.hubs.map((b) => chamferBoxAt(b.hx * 2, b.hy * 2, b.h, b.cx, b.cy, b.z0 + b.h / 2, 0.06));
        // the battery's shrink wrap and the leads' black PVC are drawn in the cases' dark plastic:
        // one mesh, not three, for parts only an open end shows
        if (lay.battery) {
          const b = lay.battery;
          parts.push(chamferBoxAt(b.hx * 2, b.hy * 2, b.h, b.cx, b.cy, b.z0 + b.h / 2, 0.08));
        }
        for (const s of lay.standoffs) {
          parts.push(new THREE.CylinderGeometry(HUB_STANDOFF_R, HUB_STANDOFF_R, s.z1 - s.z0, 6, 1, true).rotateX(Math.PI / 2).translate(s.x, s.y, (s.z0 + s.z1) / 2));
        }
        for (const w of lay.wires) parts.push(wireTube(w.pts, BAY_WIRE_R, BAY_WIRE_RADIAL));
        return parts;
      }),
      solidMat(HUB_CASE, 0.6, 0.05),
      'nylon',
    );
    if (lay.hubs.length) {
      add(
        'ports',
        framePart(`bay:ports|${bk}`, () =>
          lay.hubs.flatMap((b) => {
            // a strip of connector housings along each long side, under the case's top edge and
            // `HUB_PORT_PROUD` proud of its face (closer and the two faces are within the depth
            // buffer's 0.023 in at the orbit camera's reach)
            const along = b.hx > b.hy;
            const len = (along ? b.hx : b.hy) * 2 - 2 * HUB_PORT_INSET;
            const off = (along ? b.hy : b.hx) + HUB_PORT_PROUD - HUB_PORT_T / 2;
            const z = b.z0 + b.h - HUB_PORT_DROP;
            return ([1, -1] as const).map((s) =>
              along
                ? chamferBoxAt(len, HUB_PORT_T, HUB_PORT_H, b.cx, b.cy + s * off, z, 0.015)
                : chamferBoxAt(HUB_PORT_T, len, HUB_PORT_H, b.cx + s * off, b.cy, z, 0.015),
            );
          }),
        ),
        solidMat(HUB_PORTS, 0.6, 0.0),
        'nylon',
      );
    }
  }
  return out;
}

// ── registered with the scene chunk as this module loads (`bbLoadBay`) ─────────────────────────
bbRegisterBay({ build: buildBay, lands: bbInnerPlateLands });
