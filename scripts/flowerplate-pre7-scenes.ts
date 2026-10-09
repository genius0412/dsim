/**
 * FLOWER PLATE SCENES FOR `SIM_PATCH` 7 (`src/config.ts`): robots driven at a FLOWER at an angle in
 * 3D, where a plate's corner is what they meet, each hashed after four seconds. `smoke-biobuzz` holds
 * them, stepped as a replay recorded under patch 6, to the pins the code before patch 7 produced
 * (square plate corners). `npx tsx scripts/flowerplate-pre7-scenes.ts 6` (or `live`) prints them.
 */
import type { RobotSpec, World } from '../src/types';
import { SIM_DT } from '../src/config';
import { worldHash } from '../src/net/checksum';
import { biobuzzStep } from '../src/games/biobuzz/step';
import { cmd } from './smoke-biobuzz/harness';
import { SIDE_ROLLER_IMPORT_BUILD } from './smoke-biobuzz/fixtures/sideRollerImport';
import { stageFlowerDriveIn } from './sideroller-pre6-scenes';
import { initPhysics } from '../src/sim/physicsEngine';
import { initPhysics3d } from '../src/games/biobuzz/sim3d/engine';

const fnv = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};
const hashOf = (w: World): string => `${worldHash(w)}:${fnv(JSON.stringify({ ...w, simPatch: undefined }))}`;

/** a STANDARD side-roller robot: the first preset's chassis with side rollers on the front */
export const STANDARD_SIDE_ROLLERS: Partial<RobotSpec> = {
  intakeMount: 'front',
  bbMech: { launcher: { kind: 'fixed', mount: 'back', hoodDeg: 45 }, lift: null, intake: { kind: 'siderollers' } } as RobotSpec['bbMech'],
};

/** `spec` driven at FLOWER `fi`, `yawDeg` off square, the robot-local point `at` lined up 2.4 in out of
 *  the ring axis, at `stick` with the intake held, for four seconds: the hash and how far the robot got */
export function plateScene(patch: number | undefined, spec: Partial<RobotSpec>, at: { x: number; y: number }, fi: number, yawDeg: number, stick = 0.7): string {
  const { w } = stageFlowerDriveIn(patch, '3d', spec, at, fi, 1, yawDeg, 0);
  const cm = new Map([[0, cmd({ driveY: stick, leftDrive: stick, rightDrive: stick, intake: true })]]);
  for (let k = 0; k < 240; k++) biobuzzStep(w, SIM_DT, cm);
  return hashOf(w);
}

/** the four scenes; both physics engines already initialised (the smoke lanes' case) */
export function pre7Scenes(patch: number | undefined): Record<string, string> {
  return {
    importCorner: plateScene(patch, SIDE_ROLLER_IMPORT_BUILD, { x: 9.7, y: 6.14 }, 0, 20),
    importCornerOther: plateScene(patch, SIDE_ROLLER_IMPORT_BUILD, { x: 9.7, y: 6.14 }, 2, -20),
    standardCorner: plateScene(patch, STANDARD_SIDE_ROLLERS, { x: 9, y: 5 }, 1, 25),
    standardSquare: plateScene(patch, STANDARD_SIDE_ROLLERS, { x: 9, y: 0 }, 3, 0),
  };
}

export async function pre7Pins(patch: number | undefined): Promise<Record<string, string>> {
  await initPhysics();
  await initPhysics3d();
  return pre7Scenes(patch);
}

if (process.argv[1]?.endsWith('flowerplate-pre7-scenes.ts')) {
  const p = process.argv[2] === 'live' ? undefined : Number(process.argv[2] ?? 6);
  pre7Pins(p).then((x) => console.log(JSON.stringify(x, null, 1)));
}
