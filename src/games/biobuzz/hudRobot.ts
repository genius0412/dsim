import type { World } from '../../types';
import { BB_DEFAULT_SCORE_MODE, bbHopperCap } from './config';
import type { BbScoreMode } from './mounts';
import { biobuzzFieldHud, type BiobuzzFieldHud } from './hud';

/**
 * The ROBOT half of the BIOBUZZ HUD slice (`docs/biobuzz-contract.md` §5, Lane B), plus the
 * assembled slice the sim module's `hud` slot returns.
 *
 * DOM-free, like `hud.ts`, and for the same reason: the server computes it too.
 *
 * WHAT A DRIVER ACTUALLY NEEDS TO SEE, and why it is these three:
 *  • `hopper` / `cap` — how full you are. It is the only number that changes what you should
 *    do next: full means go score, empty means go collect. Shown as a pair rather than a
 *    percentage because the absolute count is what a driver counts against a pile.
 *  • `mode` — which archetype's rules are in force. It decides whether the fire button
 *    STEERS the robot (a turretless drum or dumper turns to aim) or not (a turret slews
 *    itself), which is the single most surprising difference between two BIOBUZZ builds, so
 *    the HUD names it rather than leaving the driver to infer it from the robot's behaviour.
 */
export interface BiobuzzRobotHud {
  /** POLLEN currently held. */
  hopper: number;
  /** this build's hopper capacity. */
  cap: number;
  /** the scoring archetype in force. */
  mode: BbScoreMode;
}

/** The full HUD slice — exactly the shape the contract fixes:
 * `{ field: { scored }, robot: { hopper, cap, mode } }`. */
export interface BiobuzzHud {
  field: BiobuzzFieldHud;
  robot: BiobuzzRobotHud | null;
}

/**
 * `robotId` is the robot whose chrome is being drawn — a spectator or a replay scrubbing with
 * no robot selected passes one that is not in the world, and the robot half comes back NULL
 * rather than as zeroes. That distinction matters: zeroes would render an empty hopper meter
 * for a robot nobody is driving, which reads as a bug.
 */
export function biobuzzHud(world: World, robotId: number): BiobuzzHud {
  const r = world.robots.find((x) => x.id === robotId);
  if (!r) return { field: biobuzzFieldHud(world), robot: null };
  return {
    field: biobuzzFieldHud(world),
    robot: {
      hopper: r.hopper.length,
      cap: bbHopperCap(r.spec),
      mode: (r.spec.scoreMode ?? BB_DEFAULT_SCORE_MODE) as BbScoreMode,
    },
  };
}
