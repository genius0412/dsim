import type { RobotSpec } from '../types';
import type { GameId } from '../games/types';
import { moduleFor } from '../games';
import { CHAIN_CATALYST_LABELS, CHAIN_CATALYST_MOUNT_LABELS, CHAIN_MODE_LABELS, CHAIN_SHOOTER_MOUNT_LABELS } from '../games/chain/labels';
import { CHAIN_DEFAULT_CATALYST, CHAIN_DEFAULT_SCORE_MODE } from '../games/chain/config';
import { catalystMountOf, catalystSwingOf, isTurreted, shooterMountOf } from '../games/chain/mounts';
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

/**
 * THE SHORT FORM OF A BUILD: the drivetrain, then the mechanisms that make it this robot and
 * not another. What a robot CARD prints under its name (a saved robot, a preset, the swap row in
 * the lobby and the ranked strategy window) and what the builder hero prints under the team.
 *
 * `buildSummary` above is the LONG form a roster or leaderboard row prints, and it stays: it
 * carries the rpm and mass a card leaves to the hero's stat grid. This one has no numbers at all,
 * because every card that prints it sits beside a control that already shows them, and a card
 * whose line is a spec dump is the clutter the owner asked to be rid of (2026-09-22).
 *
 * A game that fills `statTiles` gets ITS mechanisms, read through its own resolvers — the same
 * slot rule `buildSummary` follows for `labels.configSummary`, and for the same reason: an `else`
 * arm here is not a default, it is somebody else's game. DECODE and Chain Reaction fill nothing
 * and take the two inline arms.
 */
export function buildWords(spec: RobotSpec, game: GameId): string[] {
  const words = [DRIVETRAIN_LABELS[spec.drivetrain]];
  const tiles = moduleFor(game).statTiles?.(spec);
  if (tiles) {
    for (const t of tiles) if (!t.absent) words.push(t.sub ? `${t.value}, ${t.sub}` : t.value);
  } else if (game === 'chain') {
    const mode = spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE;
    // a turret aims itself from wherever it is bolted, so its mount says nothing
    words.push(
      isTurreted(mode)
        ? CHAIN_MODE_LABELS[mode]
        : `${CHAIN_MODE_LABELS[mode]}, ${CHAIN_SHOOTER_MOUNT_LABELS[shooterMountOf(spec)]}`,
    );
    const swing = catalystSwingOf(spec);
    words.push(
      `${CHAIN_CATALYST_LABELS[spec.catalystType ?? CHAIN_DEFAULT_CATALYST]}${
        swing ? ` swing ${swing === 'fb' ? '↕' : '↔'}` : ''
      }, ${CHAIN_CATALYST_MOUNT_LABELS[catalystMountOf(spec)]}`,
    );
  } else {
    words.push(spec.intake === 'none' ? INTAKE_SHORT.none : `${INTAKE_SHORT[spec.intake]} intake`);
    if (spec.canSort) words.push('sorter');
    words.push(shotRange(spec.flywheelInertia));
  }
  return words;
}

/**
 * The shooting range a DECODE flywheel inertia is tuned for: a LOW-inertia wheel spins up fast
 * for close rapid-fire, a HIGH-inertia wheel holds speed to sustain long shots (matches the
 * flywheel-recovery cadence model). It was the chip on a DECODE preset card; it is a word in
 * `buildWords` now, so a saved robot and the hero say it too.
 */
export function shotRange(inertia: number): string {
  if (inertia <= 0.4) return 'Close range';
  if (inertia <= 0.7) return 'Mid range';
  return 'Long range';
}

/**
 * A robot's TEAM, the way FTC writes one: number, then name (`12345 · Robo Hornets`). Empty when
 * the build carries neither, and then the line is not printed at all — a "No team" placeholder
 * said nothing the missing line does not.
 */
export function teamLine(spec: Pick<RobotSpec, 'teamName' | 'teamNumber'>): string {
  return [spec.teamNumber ? String(spec.teamNumber) : '', spec.teamName.trim()].filter(Boolean).join(' · ');
}
