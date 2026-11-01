import type { RobotState, World } from '../types';
import { simPatchAtLeast } from '../config';

/**
 * THE ASSISTS A DECODE ROBOT IS RUNNING THIS TICK: its driver's, plus all three while a legacy
 * AUTO PATH drives it (`pathTraversal.ts`).
 *
 * The path used to WRITE them, `r.aimAssist = r.autoIntake = r.autoFire = true`, on every tick
 * it drove, and nothing ever wrote them back. A driver who had auto fire or auto intake off
 * therefore had both on for the whole of DRIVER-CONTROLLED, and `Room.assistsOf`, which reads
 * these flags at the end of the match, filed the record as driven with them. From `SIM_PATCH` 12
 * the path is READ as an assist instead, so the flags on the robot stay the driver's and the path
 * still runs with all three. A replay recorded before 12 runs the old write
 * (`legacyPathAssists`) and reads the flags raw, which is the old rule bit for bit.
 *
 * Every reader of `autoIntake` / `autoFire` / `aimAssist` in the DECODE sim goes through these,
 * because a reader left on the raw flag would turn the assist OFF for the path from 12 on.
 */
function pathRunsAssists(world: World, r: RobotState): boolean {
  return r.autoPathActive && simPatchAtLeast(world, 12);
}

export function autoIntakeOn(world: World, r: RobotState): boolean {
  return r.autoIntake || pathRunsAssists(world, r);
}

export function autoFireOn(world: World, r: RobotState): boolean {
  return r.autoFire || pathRunsAssists(world, r);
}

export function aimAssistOn(world: World, r: RobotState): boolean {
  return r.aimAssist || pathRunsAssists(world, r);
}

/** BEFORE `SIM_PATCH` 12: an auto path writes all three assists on, and nothing writes them back. */
export function legacyPathAssists(world: World, r: RobotState): void {
  if (!r.autoPathActive || simPatchAtLeast(world, 12)) return;
  r.aimAssist = true;
  r.autoIntake = true;
  r.autoFire = true;
}
