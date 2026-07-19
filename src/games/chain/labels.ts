import type { ChainIntakeStyle, ChainScoreMode } from '../../types';

/**
 * Shared display labels for Chain Reaction robot-config choices, so the builder
 * (Menu) and the leaderboard config summary name the same thing identically —
 * a CR record must show the CR archetype/intake, never a DECODE stat.
 */
export const CHAIN_MODE_LABELS: Record<ChainScoreMode, string> = {
  turret: 'Turret shooter',
  drum: 'Drum shooter',
  dumper: 'Dumper',
};

export const CHAIN_INTAKE_LABELS: Record<ChainIntakeStyle, string> = {
  sweeper: 'Sweeper',
};
