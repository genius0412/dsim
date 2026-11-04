import type { DrivetrainType, IntakeStyle } from '../types';

/**
 * The SHARED robot-build label maps, as a LEAF module.
 *
 * ── WHY THEY ARE NOT IN `robotLabels.ts` WITH THEIR ONLY OTHER NEIGHBOUR ────
 * They were, and that made them unreachable from the place that most wants them. These two
 * maps are pure data with no dependency of their own, but `robotLabels.ts` also exports
 * `specSheet`, which calls `moduleFor` — so importing `robotLabels` pulls in the whole game
 * registry, and therefore every game module. A GAME MODULE that imports it back closes the
 * loop, and because the registry reads the module objects at evaluation time the failure is
 * not a lint warning, it is `ReferenceError: Cannot access 'X' before initialization` at boot.
 * That is the same class of bug `src/sim/specDefaults.ts` exists to document.
 *
 * A game's own preset cards and config summaries legitimately want to say "Tank" the same way
 * the shared builder says it, so the DATA lives here where anything may import it and the
 * function that needs the registry stays where it was. `robotLabels.ts` re-exports both, so
 * every existing importer is unchanged.
 */

/** Short human labels for robot-build enums, shared across the My Robot builder
 * (Menu), the pre-match strategy screen (MatchStrategy) and the per-game preset
 * cards, so none of them ever drift. */
export const DRIVETRAIN_LABELS: Record<DrivetrainType, string> = {
  mecanum: 'Mecanum',
  tank: 'Tank',
  swerve: 'Swerve',
  xdrive: 'X-drive',
  butterfly: 'Butterfly',
};

/** The drive motors' ZERO-POWER behaviour (`RobotSpec.zeroPower`): the builder's and the
 * importer's row, each choice with what the driver feels. */
export const ZERO_POWER_LABEL = 'Zero power';
export const ZERO_POWER_CHOICES: readonly { v: 'brake' | 'coast'; t: string; d: string }[] = [
  { v: 'brake', t: 'Brake', d: 'Stops within inches when you let go' },
  { v: 'coast', t: 'Coast', d: 'Rolls on for feet when you let go; easier to push' },
];

export const INTAKE_SHORT: Record<IntakeStyle, string> = {
  sloped: 'Sloped',
  vector: 'Vector',
  triangle: 'Triangle',
  none: 'Hand loaded',
};

/**
 * WHERE A PART IS BOLTED, in words — for a spec sheet or a sentence. Both games' builders name the
 * same nine chassis cells and four intake mounts, but their labels (`F·LEFT`, `FRONT+BACK`) are
 * sized for a 3x3 button grid and read as shouting anywhere else. Keyed by the shared position
 * strings, so either game's mount resolves here without a per-game copy.
 */
export const MOUNT_WORDS: Readonly<Record<string, string>> = {
  frontleft: 'front left',
  front: 'front',
  frontright: 'front right',
  left: 'left',
  center: 'center',
  right: 'right',
  backleft: 'back left',
  back: 'back',
  backright: 'back right',
  side: 'both sides',
  frontback: 'front and back',
};

/** `MOUNT_WORDS` starting a line: "Front left". An unknown key prints as itself. */
export function mountPhrase(pos: string): string {
  const w = MOUNT_WORDS[pos] ?? pos;
  return w.charAt(0).toUpperCase() + w.slice(1);
}
