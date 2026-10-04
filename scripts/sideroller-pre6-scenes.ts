/**
 * IMPORTED SIDE-ROLLER SCENES FOR `SIM_PATCH` 6 (`src/config.ts`): a real side-roller import
 * (`smoke-biobuzz/fixtures/sideRollerImport.ts`) driven into a FLOWER with the intake held, in 2D
 * and 3D, and in 3D into a standard robot beside a wall, each hashed after four seconds. `smoke.ts`
 * holds them, stepped as a replay recorded under patch 5, to the pins the code before patch 6
 * produced. `npx tsx scripts/sideroller-pre6-scenes.ts 5` (or `live`) prints them.
 */
import type { RobotSpec, World } from '../src/types';
import { SIM_DT } from '../src/config';
import { worldHash } from '../src/net/checksum';
import { createBiobuzzWorld } from '../src/games/biobuzz/spawn';
import { biobuzzStep } from '../src/games/biobuzz/step';
import { BB_FLOWERS, FLOWER_MOUTH } from '../src/games/biobuzz/config';
import { cmd, setup } from './smoke-biobuzz/harness';
import { SIDE_ROLLER_IMPORT_BUILD, SIDE_ROLLER_IMPORT_CAD_WHEEL } from './smoke-biobuzz/fixtures/sideRollerImport';
import { initPhysics } from '../src/sim/physicsEngine';
import { initPhysics3d } from '../src/games/biobuzz/sim3d/engine';

const fnv = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};
const hashOf = (w: World): string => `${worldHash(w)}:${fnv(JSON.stringify({ ...w, simPatch: undefined }))}`;

/**
 * A DRIVER'S APPROACH: the robot faces FLOWER `fi`'s foot, `yawDeg` off square, with the point
 * `wheel` (robot-local; `side` ±1 mirrors its y) on the line that ends 2.4 in out of the ring
 * axis, `delta` in to its own left of it, 20 in back along its own heading — a straight run that
 * ends on the lineup. Nothing loose or held; the FLOWERS keep their four staged POLLEN. Returns
 * the world and the id of each POLLEN in that FLOWER.
 */
export function stageFlowerDriveIn(
  patch: number | undefined,
  physics: '2d' | '3d',
  spec: Partial<RobotSpec>,
  wheel: { x: number; y: number },
  fi: number,
  side: 1 | -1,
  yawDeg: number,
  delta = 0,
): { w: World; column: number[] } {
  const w = createBiobuzzWorld('free', 4100 + fi, [setup(0, 'blue', spec)], undefined, physics);
  if (patch !== undefined) w.simPatch = patch;
  const r = w.robots[0];
  w.balls = w.balls.filter((b) => b.state.kind !== 'ground' && b.state.kind !== 'held');
  r.hopper = [];
  r.lastIntakeAt = -99;
  const f = BB_FLOWERS[fi];
  const m = FLOWER_MOUTH[f.wall];
  const base = Math.atan2(-m.y, -m.x);
  const h = base + (yawDeg * Math.PI) / 180;
  const c = Math.cos(h);
  const s = Math.sin(h);
  const L = { x: wheel.x, y: side * wheel.y };
  // the robot's own left when square to the foot
  const lx = -Math.sin(base) * delta;
  const ly = Math.cos(base) * delta;
  r.pos = { x: f.x + m.x * 2.4 + lx - (L.x * c - L.y * s) - 20 * c, y: f.y + m.y * 2.4 + ly - (L.x * s + L.y * c) - 20 * s };
  r.heading = h;
  r.vel = { x: 0, y: 0 };
  r.angVel = 0;
  return { w, column: [...w.biobuzz!.flowers[fi].stack] };
}

/** the import, its CAD side roller lined up, driven in at `stick` with the intake held; hashed */
function flowerScene(patch: number | undefined, physics: '2d' | '3d', fi: number, side: 1 | -1, yawDeg: number, stick: number): string {
  const { w } = stageFlowerDriveIn(patch, physics, SIDE_ROLLER_IMPORT_BUILD, SIDE_ROLLER_IMPORT_CAD_WHEEL, fi, side, yawDeg);
  const r = w.robots[0];
  const cm = new Map([[0, cmd({ driveY: stick, leftDrive: stick, rightDrive: stick, intake: true })]]);
  for (let k = 0; k < 240; k++) biobuzzStep(w, SIM_DT, cm);
  return `held=${r.hopper.length} stack=${w.biobuzz!.flowers[fi].stack.length} ${hashOf(w)}`;
}

/** drive a staged approach (`stageFlowerDriveIn`) in at full stick with the intake held, up to 4 s:
 *  the time the first of that FLOWER's POLLEN is held, or null */
export function flowerDriveInTakes(w: World, column: readonly number[]): number | null {
  const ids = new Set(column);
  const cm = new Map([[0, cmd({ driveY: 1, leftDrive: 1, rightDrive: 1, intake: true })]]);
  for (let k = 0; k < 240; k++) {
    biobuzzStep(w, SIM_DT, cm);
    if (w.balls.some((b) => ids.has(b.id) && b.state.kind === 'held')) return (k + 1) * SIM_DT;
  }
  return null;
}

/** in 3D the import drives its front, at 20°, into a standard side-roller robot parked against
 *  the left wall: the reach hardware against a robot and a wall */
function pushScene(patch: number | undefined): string {
  const std: Partial<RobotSpec> = { intakeMount: 'front', bbMech: { launcher: null, lift: null, intake: { kind: 'siderollers' } } as unknown as RobotSpec['bbMech'] };
  const w = createBiobuzzWorld('free', 4200, [setup(0, 'blue', SIDE_ROLLER_IMPORT_BUILD), setup(1, 'red', std, 1)], undefined, '3d');
  if (patch !== undefined) w.simPatch = patch;
  w.balls = w.balls.filter((b) => b.state.kind !== 'ground' && b.state.kind !== 'held');
  const [a, b] = w.robots;
  a.hopper = [];
  b.hopper = [];
  b.pos = { x: -60, y: 30 };
  b.heading = Math.PI / 2;
  a.pos = { x: -40, y: 22 };
  a.heading = Math.PI - 0.35;
  for (const r of w.robots) {
    r.vel = { x: 0, y: 0 };
    r.angVel = 0;
  }
  const cm = new Map([[0, cmd({ driveY: 0.8, leftDrive: 0.8, rightDrive: 0.8, intake: true })], [1, cmd({})]]);
  for (let k = 0; k < 240; k++) biobuzzStep(w, SIM_DT, cm);
  return hashOf(w);
}

/** the four scenes, hashed; both physics engines already initialised (the smoke lanes' case) */
export function pre6Scenes(patch: number | undefined): Record<string, string> {
  return {
    bb2dFlower: flowerScene(patch, '2d', 0, 1, 0, 1),
    bb3dFlower: flowerScene(patch, '3d', 0, 1, 0, 1),
    bb3dFlowerSkew: flowerScene(patch, '3d', 2, -1, -8, 0.7),
    bb3dPush: pushScene(patch),
  };
}

export async function pre6Pins(patch: number | undefined): Promise<Record<string, string>> {
  await initPhysics();
  await initPhysics3d();
  return pre6Scenes(patch);
}

if (process.argv[1]?.endsWith('sideroller-pre6-scenes.ts')) {
  const p = process.argv[2] === 'live' ? undefined : Number(process.argv[2] ?? 5);
  pre6Pins(p).then((x) => console.log(JSON.stringify(x, null, 1)));
}
