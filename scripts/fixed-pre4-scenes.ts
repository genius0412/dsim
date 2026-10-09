/**
 * FIXED-LAUNCHER SCENES FOR `SIM_PATCH` 4 (`src/config.ts`): five held, aimed shots (DECODE's kit
 * tank off its aim, pressed on the goal face, a mecanum; BIOBUZZ's kit in 2D and 3D), each hashed
 * after four seconds. `smoke.ts` holds them, stepped as a replay recorded under patch 3, to the pins
 * the code before patch 4 produced. `npx tsx scripts/fixed-pre4-scenes.ts 3` (or `live`) prints them.
 */
import type { RobotCommand, RobotSpec, World } from '../src/types';
import { TURRET_OFFSET_FRAC, SIM_DT } from '../src/config';
import { createWorld, DEFAULT_SPEC, coerceSpec } from '../src/sim/spawn';
import { step } from '../src/sim/world';
import { goalCenter, goalFaceNormal } from '../src/sim/field';
import { ROBOT_PRESETS } from '../src/config';
import { worldHash } from '../src/net/checksum';
import { createBiobuzzWorld } from '../src/games/biobuzz/spawn';
import { biobuzzStep } from '../src/games/biobuzz/step';
import { hiveCellTarget } from '../src/games/biobuzz/elements';
import { BB_FIXED_FLY_DEFAULT, BB_FIXED_HOOD_DEFAULT_DEG } from '../src/games/biobuzz/config';
import { cmd, setup } from './smoke-biobuzz/harness';
import { initPhysics } from '../src/sim/physicsEngine';
import { initPhysics3d } from '../src/games/biobuzz/sim3d/engine';

const fnv = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};
const hashOf = (w: World): string => `${worldHash(w)}:${fnv(JSON.stringify({ ...w, simPatch: undefined }))}`;

function decodeScene(patch: number | undefined, spec: RobotSpec, o: { yawErr: number; press?: number; fwd?: number }): string {
  const w = createWorld('match', 5, [{ id: 0, alliance: 'blue', spec: { ...DEFAULT_SPEC, ...spec } as RobotSpec, assists: { fieldCentric: false, aimAssist: true, autoIntake: false, autoFire: false }, startIndex: 0 }]);
  if (patch !== undefined) w.simPatch = patch;
  w.match.phase = 'teleop';
  w.match.phaseTimeLeft = 100;
  const r = w.robots[0];
  r.aimAssist = true;
  const g = goalCenter('blue');
  const n = goalFaceNormal('blue');
  const head = Math.atan2(-n.y, -n.x);
  const fwd = o.fwd ?? 0;
  if (o.press !== undefined) {
    r.pos = { x: g.x + n.x * 30 - n.y * o.press, y: g.y + n.y * 30 + n.x * o.press };
    r.heading = head + o.yawErr;
    r.turretHeading = r.heading;
    for (let k = 0; k < 90; k++) step(w, SIM_DT, new Map([[0, { driveX: 0, driveY: fwd, rotate: 0, leftDrive: fwd, rightDrive: fwd, intake: false, fire: false }]]));
  } else {
    const back = r.spec.length * TURRET_OFFSET_FRAC;
    r.pos = { x: g.x + n.x * 50 - Math.cos(head) * back, y: g.y + n.y * 50 - Math.sin(head) * back };
    r.heading = head + o.yawErr;
    r.turretHeading = r.heading;
  }
  const c: RobotCommand = { driveX: 0, driveY: fwd, rotate: 0, leftDrive: fwd, rightDrive: fwd, intake: false, fire: true };
  let fired = 0;
  for (let k = 0; k < 240; k++) {
    while (r.hopper.length < 3) r.hopper.push('green');
    step(w, SIM_DT, new Map([[0, c]]));
    if (r.lastFireAt === w.time) fired++;
  }
  return `fired=${fired} ${hashOf(w)}`;
}

const BB_KIT: Partial<RobotSpec> = {
  drivetrain: 'tank',
  driveRpm: 286,
  length: 15,
  width: 16,
  intakeMount: 'front',
  ballStorage: 4,
  scoreMode: 'dumper',
  shooterMount: 'front',
  bbMech: { launcher: { kind: 'fixed', mount: 'front', hoodDeg: BB_FIXED_HOOD_DEFAULT_DEG }, lift: null, intake: { kind: 'sweeper' } },
  flywheel: { ...BB_FIXED_FLY_DEFAULT, rpm: [...BB_FIXED_FLY_DEFAULT.rpm] },
};

function bbScene(patch: number | undefined, physics: '2d' | '3d', spec: Partial<RobotSpec>, yaw: number, d: number): string {
  const w = createBiobuzzWorld('match', 3, [setup(0, 'blue', spec)], undefined, physics);
  if (patch !== undefined) w.simPatch = patch;
  w.match.phase = 'teleop';
  w.match.phaseTimeLeft = 100;
  const r = w.robots[0];
  r.aimAssist = true;
  const t = hiveCellTarget('blue', 'north');
  r.pos = { x: t.pos.x, y: t.pos.y + d };
  r.heading = -Math.PI / 2 + yaw;
  r.turretHeading = r.heading;
  const held = w.balls.find((b) => b.state.kind === 'held' && (b.state as { robot: number }).robot === r.id)!;
  const heldState = JSON.stringify(held.state);
  const cap = r.spec.ballStorage ?? 4;
  let id = 100000;
  let fired = 0;
  const cmds = new Map([[0, cmd({ fire: true })]]);
  for (let k = 0; k < 240; k++) {
    while (r.hopper.length < cap) {
      r.hopper.push(held.color);
      w.balls.push({ ...held, id: id++, state: JSON.parse(heldState), pos: { ...r.pos }, vel: { x: 0, y: 0 } });
    }
    biobuzzStep(w, SIM_DT, cmds);
    if (r.lastFireAt === w.time) fired++;
  }
  return `fired=${fired} ${hashOf(w)}`;
}

export async function pre4Pins(patch: number | undefined): Promise<Record<string, string>> {
  await initPhysics();
  await initPhysics3d();
  const kit = ROBOT_PRESETS.find((p) => p.name === 'StarterBot')!;
  const tw = coerceSpec({ ...DEFAULT_SPEC, ...ROBOT_PRESETS[0], launcher: 'fixed', hoodDeg: kit.hoodDeg, flywheel: kit.flywheel } as RobotSpec);
  return {
    decodeKit: decodeScene(patch, kit, { yawErr: 0.5 }),
    decodeKitPress: decodeScene(patch, kit, { yawErr: 0, press: 6, fwd: 0.4 }),
    decodeMecanum: decodeScene(patch, tw, { yawErr: -0.6 }),
    bb2d: bbScene(patch, '2d', BB_KIT, 0.4, 46),
    bb3d: bbScene(patch, '3d', BB_KIT, -0.5, 44),
  };
}

if (process.argv[1]?.endsWith('fixed-pre4-scenes.ts')) {
  const p = process.argv[2] === 'live' ? undefined : Number(process.argv[2] ?? 3);
  pre4Pins(p).then((x) => console.log(JSON.stringify(x, null, 1)));
}
