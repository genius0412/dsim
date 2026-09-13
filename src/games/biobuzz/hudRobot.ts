import type { ArtifactColor, World } from '../../types';
import { BB_HOOD_DEFAULT_DEG, bbHopperCap } from './config';
import type { BbScoreMode } from './mounts';
import { bbLauncherOf } from './mechs';
import { bbFlowerInReach } from './robot';
import { biobuzzFieldHud, type BiobuzzFieldHud } from './hud';

/**
 * The ROBOT half of the BIOBUZZ HUD slice (`docs/biobuzz-contract.md` §5, Lane B), plus the
 * assembled slice the sim module's `hud` slot returns.
 *
 * DOM-free, like `hud.ts`, and for the same reason: the server computes it too.
 *
 * WHAT A DRIVER ACTUALLY NEEDS TO SEE, and why it is these:
 *  • `held` / `cap` — WHAT you are carrying, not just how much. A count cannot say whether the
 *    next element out is POLLEN or NECTAR, and that decides where you go: POLLEN is launched,
 *    NECTAR is carried by fewer builds and costs a foul if placed too early. The live HUD draws
 *    one disc per element in hopper order and marks the one that leaves next; it prints no
 *    count (owner ruling 2026-09-12). `hopper` stays as the plain count for readers that only
 *    want a number (the dev gallery).
 *  • `mode` — which launcher's rules are in force. It decides whether the fire button STEERS
 *    the robot (a turretless dumper turns to aim) or not (a turret slews itself), and whether
 *    the intake takes NECTAR at all (a single turret does not).
 *  • `flowerInReach` — a Box Tube robot's placement point is near a FLOWER ring, so the place
 *    buttons will do something. Proximity is hard to judge top-down, so the HUD says it.
 */
export interface BiobuzzRobotHud {
  /** how many elements are held — `held.length`, kept for readers that want only the count. */
  hopper: number;
  /** the held elements' colours in HOPPER ORDER: index 0 is the first captured (the bottom),
   * the LAST entry is the next to leave (the top — `r.hopper` is LIFO). A COPY, so a HUD reader
   * can never mutate the sim's hopper. `yellow` is POLLEN; `red`/`blue` are NECTAR. */
  held: ArtifactColor[];
  /** this build's hopper capacity. */
  cap: number;
  /** the launcher in force — read through `bbLauncherOf`, never the flat mirror. */
  mode: BbScoreMode;
  /** a FLOWER ring is within `BB_PLACE_TOL` of this robot's Box Tube placement point. Always
   * false for a build with no Box Tube. */
  flowerInReach: boolean;
}

/** The full HUD slice — the shape the contract fixes, `{ field, robot }`. */
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
      held: [...r.hopper],
      cap: bbHopperCap(r.spec),
      mode: bbLauncherOf(r.spec, BB_HOOD_DEFAULT_DEG).kind,
      flowerInReach: bbFlowerInReach(world, r) !== null,
    },
  };
}
