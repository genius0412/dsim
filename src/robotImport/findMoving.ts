/**
 * THE MOVING-PART SEARCH, FROM PLAIN INPUTS (`docs/area/robot-import.md`, "Workers"): the build a
 * model shows (`readBuild`) and every kind of moving part in it, run where the model is held. That is
 * the measure worker (`engine/measureWorker.ts`); this thread runs it only when no worker can start.
 * On a big robot it is seconds of work, and on the page's thread it froze the editor (Offset, 2.8 s
 * after 205 s was cut, 2026-11-09). DOM-free and game-free: the editor turns its build into the flags
 * below, so the worker chunk carries no game.
 */
import type { DrivetrainType, ImportedEdge, Vec2 } from '../types';
import type { MeshPart } from './geometry';
import {
  boxTubeGroups,
  findBoxTubes,
  findDeployedGroup,
  findDriveGears,
  findEdgeRollers,
  findFlywheelGroups,
  findIntakeArm,
  findLauncherFeed,
  findOverhang,
  findRollerGroups,
  findSpokedRollers,
  findStageRollers,
  findTurretGroup,
  findTurretRing,
  findWheelGroups,
  liftPayload,
  readBuild,
  readLauncher,
  ridersOf,
  wheelAxleVotes,
  type CadBuild,
} from './motion';
import type { MotionGroup } from './types';

type V3 = [number, number, number];

/** where the drive wheels are, and what they are: the wheel search's inputs */
export interface WheelInputs {
  /** the wheel spots the measurement uses (MODEL frame), or null when it has none */
  wheels: Vec2[] | null;
  drivetrain: DrivetrainType;
  wheelDiaIn: number;
}

/** read the build the model shows (`readBuild`), with the drive wheels' bodies left out */
export interface BuildSearch extends WheelInputs {
  kind: 'build';
  /** an element's diameter, inches (`launchElementD`) */
  elementD: number;
  /** also count the wheels' axles (`wheelAxleVotes`): a front the geometry left assumed */
  axles: boolean;
}

/** every kind of moving part, among the bodies `have` does not hold (`findMoving`) */
export interface MotionSearch extends WheelInputs {
  kind: 'motion';
  have: MotionGroup[];
  intakes: { edge: ImportedEdge; from: number; to: number; ramp?: boolean }[];
  /** the launcher's placed point (MODEL frame), when the build has a launcher */
  shooter: V3 | null;
  /** the launcher sits on a turret, so one is worth looking for */
  turret: boolean;
  /** the build's intake is a ramp (BIOBUZZ), so a deployed or tucked-in arm is one */
  rampIntake: boolean;
  elementD: number;
}

export type Search = BuildSearch | MotionSearch;
export type Found = { kind: 'build'; cad: CadBuild; axles: { x: number; y: number } } | { kind: 'motion'; motion: MotionGroup[] };

/** run `s` on MODEL-frame `parts` */
export function runSearch(parts: readonly MeshPart[], s: Search): Found {
  if (s.kind === 'motion') return { kind: 'motion', motion: findMoving(parts, s) };
  const wheels = new Set(wheelGroups(parts, s).flatMap((g) => g.bodies));
  const cad = readBuild(parts, wheels, s.elementD);
  const axles = s.axles && s.wheels ? wheelAxleVotes(parts, s.wheels) : { x: 0, y: 0 };
  return { kind: 'build', cad, axles };
}

const wheelGroups = (parts: readonly MeshPart[], w: WheelInputs): MotionGroup[] => (w.wheels ? findWheelGroups(parts, w.wheels, w.drivetrain, w.wheelDiaIn) : []);

/**
 * EVERY KIND OF MOVING PART the model shows, among the bodies `s.have` does not hold: the drive wheels
 * (when there are none yet) and the gears they drive, the intake rollers on the intake spans, any
 * other spoked roller, flywheels by the launcher, a turret under it (a turreted build), and a part
 * the file shows deployed past 18 in at an intake edge (BIOBUZZ's ramp, else a folding part).
 * Suggestions, marked `found`.
 */
export function findMoving(parts: readonly MeshPart[], s: MotionSearch): MotionGroup[] {
  const have = s.have;
  const out: MotionGroup[] = [];
  const taken = (): Set<number> => new Set([...have, ...out].flatMap((g) => g.bodies));
  // a wheel per corner no row has yet (a player's own wheel row keeps its corner); a 6WD's middle
  // pair has no corner, and the bodies a kept row holds already keep it from coming back twice
  for (const w of wheelGroups(parts, s)) {
    if (w.corner !== undefined && have.some((g) => g.role === 'wheel' && g.corner === w.corner)) continue;
    const t = taken();
    const bodies = w.bodies.filter((b) => !t.has(b));
    if (bodies.length) out.push({ ...w, bodies });
  }
  // the gears the wheels drive (a motor's pinion), each geared to its wheel; their leaders are
  // indices into the rows before them, which is `[...have, ...out]` as the caller lays it out
  out.push(...findDriveGears(parts, [...have, ...out], taken()));
  // box tubes before the rollers: a slide's pulleys and bearings ride on its stages
  // (their moving stages, numbered where they land in the setup's motion)
  const tubes = have.some((g) => g.role === 'slide') ? [] : findBoxTubes(parts, taken());
  out.push(...boxTubeGroups(tubes, have.length + out.length));
  const intakes = s.intakes;
  // the edges the rollers are looked for at are the robot's own, not a ramp's the file shows down
  const over = findOverhang(parts, taken(), 18, intakes.map((i) => i.edge));
  if (intakes.length) {
    out.push(...findRollerGroups(parts, intakes, taken(), new Set(over?.bodies ?? [])));
    // and the intake-sized rollers at the other edges (a robot that takes in at both ends)
    out.push(...findEdgeRollers(parts, intakes, taken(), new Set(over?.bodies ?? [])));
  }
  // spoked axles anywhere else (a transfer column of surgical tubing)
  out.push(...findSpokedRollers(parts, taken()));
  // where an element is carried to: the flywheel the model shows, where there is one; else the
  // launcher's placed point
  let launcherAt: V3 | null = null;
  if (s.shooter) {
    const cad = readLauncher(parts, taken());
    const at: V3 = cad ? cad.at : s.shooter;
    launcherAt = at;
    // the flywheels before the turret: they stand on it, and it would take them (Offset's transfer
    // roller under the ring was offered as its flywheel, 2026-10-04); on a turret, none below its ring
    const turret = s.turret && !have.some((g) => g.role === 'turret');
    const ring = turret ? findTurretRing(parts, at, taken()) : null;
    const wheels = have.some((g) => g.role === 'flywheel') ? [] : findFlywheelGroups(parts, at, taken(), ring ? ring.z0 : -Infinity);
    if (turret) {
      const t = findTurretGroup(parts, at, new Set([...taken(), ...wheels.flatMap((g) => g.bodies)]));
      if (t) out.push(t);
    }
    out.push(...wheels);
  }
  if (intakes.length && !have.some((g) => g.role === 'ramp' || g.role === 'fold')) {
    const dep = findDeployedGroup(parts, intakes, s.rampIntake ? 'ramp' : 'fold', taken());
    if (dep) out.push(dep);
    else if (s.rampIntake) {
      // a ramp the file shows tucked in: an arm swinging on an intake roller's shaft (Offset's front)
      const rollers = [...have, ...out].filter((g) => g.role === 'roller');
      const flagged = intakes.filter((i) => i.ramp);
      for (const i of flagged.length ? flagged : intakes) {
        const arm = findIntakeArm(parts, rollers, i.edge, taken());
        if (!arm) continue;
        out.push({ role: 'ramp', bodies: arm.bodies, filePose: 'folded', deployDeg: arm.deployDeg, ...(arm.shaft >= 0 ? { axisBody: arm.shaft } : {}), found: true });
        break;
      }
    }
  }
  // what a lift's stages push up as they rise: the payload hung from them (a chute on a Box Tube),
  // and the rollers it holds ride with it
  const payload = liftPayload(parts, [...have, ...out], tubes);
  for (const [gi, add] of payload.carried) {
    if (gi < have.length) continue;
    const g = out[gi - have.length];
    out[gi - have.length] = { ...g, bodies: [...new Set([...g.bodies, ...add])].sort((a, b) => a - b) };
  }
  for (const [gi, on] of payload.riders) if (gi >= have.length) out[gi - have.length] = { ...out[gi - have.length], rideOn: on };
  // what a turret, a ramp or a slide carries that its finder missed (it would stay put as it moved)
  const rows = [...have, ...out];
  const foundAt = new Set(out.map((_, i) => have.length + i));
  for (const [gi, add] of ridersOf(parts, rows, foundAt)) {
    const g = out[gi - have.length];
    out[gi - have.length] = { ...g, bodies: [...new Set([...g.bodies, ...add])].sort((a, b) => a - b) };
  }
  // the rollers that feed the flywheel inside a found turret: out of the turret, riding it
  const ti = out.findIndex((g) => g.role === 'turret');
  if (ti >= 0) {
    const turretRow = out[ti];
    const others = new Set([...have, ...out].filter((g) => g !== turretRow).flatMap((g) => g.bodies));
    const feed = findLauncherFeed(parts, turretRow.bodies, [...have, ...out].filter((g) => g.role === 'flywheel'), others);
    if (feed.length) {
      const gone = new Set(feed.flatMap((g) => g.bodies));
      out[ti] = { ...turretRow, bodies: turretRow.bodies.filter((b) => !gone.has(b)) };
      out.push(...feed);
    }
  }
  // the intake's later stages inside the robot, on the way from a roller found to the launcher; last,
  // so a turret, a flywheel, a slide and a ramp have their parts first
  if (intakes.length) out.push(...findStageRollers(parts, [...have, ...out].filter((g) => g.role === 'roller'), taken(), s.elementD, launcherAt));
  return out;
}
