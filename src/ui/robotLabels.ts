import type { RobotSpec } from '../types';
import type { GameId } from '../games/types';
import { moduleFor } from '../games';
import { CHAIN_MODE_LABELS } from '../games/chain/labels';
import { CHAIN_DEFAULT_SCORE_MODE } from '../games/chain/config';
import { DRIVETRAIN_LABELS, INTAKE_SHORT } from './labelData';

/**
 * The two label maps moved to the LEAF `./labelData` and are RE-EXPORTED here, so every
 * existing importer of this module is unchanged. They had to move: this file imports
 * `moduleFor`, so anything importing it pulls in every game module — and a game module that
 * wants to label a drivetrain on its own preset card would close that loop at evaluation
 * time. See the header of `./labelData`.
 */
export { DRIVETRAIN_LABELS, INTAKE_SHORT };

/**
 * ONE LINE describing a build, in the terms that game actually has: DECODE names
 * the intake and the sorter, Chain Reaction names the archetype (it has no intake
 * styles and no sorter). Lives here rather than in a screen because THREE screens
 * print it now — the ranked strategy window, the custom-room lobby, and anywhere
 * else a roster card wants to say what somebody is bringing — and two hand-written
 * copies of one sentence drift the way any two drawings of one object do.
 */
export function buildSummary(spec: RobotSpec, game: GameId): string {
  // a game may own this sentence outright (the module's `labels.configSummary`
  // slot); the two branches below are DECODE's and CR's, unchanged
  const own = moduleFor(game).labels?.configSummary;
  if (own) return own(spec);
  const parts =
    game === 'chain'
      ? [
          DRIVETRAIN_LABELS[spec.drivetrain],
          CHAIN_MODE_LABELS[spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE],
          `${spec.driveRpm} rpm`,
          `${spec.massLb} lb`,
        ]
      : [
          DRIVETRAIN_LABELS[spec.drivetrain],
          INTAKE_SHORT[spec.intake],
          `${spec.driveRpm} rpm`,
          `${spec.massLb} lb`,
          ...(spec.canSort ? ['sorter'] : []),
        ];
  return parts.join(' · ');
}
