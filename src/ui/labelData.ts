import type { DrivetrainType, IntakeStyle } from '../types';

/**
 * The SHARED robot-build label maps, as a LEAF module.
 *
 * ── WHY THEY ARE NOT IN `robotLabels.ts` WITH THEIR ONLY OTHER NEIGHBOUR ────
 * They were, and that made them unreachable from the place that most wants them. These two
 * maps are pure data with no dependency of their own, but `robotLabels.ts` also exports
 * `buildSummary`, which calls `moduleFor` — so importing `robotLabels` pulls in the whole game
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

export const INTAKE_SHORT: Record<IntakeStyle, string> = {
  sloped: 'Sloped',
  vector: 'Vector',
  triangle: 'Triangle',
};
