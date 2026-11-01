import type { AssistConfig, RobotSpec } from '../types';
import type { GameId } from '../games/types';
import type { GameStatTile } from '../games/module';
import { moduleFor } from '../games';
import {
  CHAIN_CATALYST_LABELS,
  CHAIN_CATALYST_MOUNT_LABELS,
  CHAIN_INTAKE_LABELS,
  CHAIN_MODE_LABELS,
  CHAIN_SHOOTER_MOUNT_LABELS,
} from '../games/chain/labels';
import {
  CHAIN_CLEARANCE_DEFAULT,
  CHAIN_DEFAULT_CATALYST,
  CHAIN_DEFAULT_INTAKE,
  CHAIN_DEFAULT_SCORE_MODE,
  CHAIN_STORAGE_DEFAULT,
} from '../games/chain/config';
import { catalystMountOf, catalystSwingOf, intakeMountOf, isTurreted, shooterMountOf } from '../games/chain/mounts';
import { DRIVETRAIN_LABELS, INTAKE_SHORT, mountPhrase } from './labelData';

/**
 * The two label maps moved to the LEAF `./labelData` and are RE-EXPORTED here, so every
 * existing importer of this module is unchanged. They had to move: this file imports
 * `moduleFor`, so anything importing it pulls in every game module — and a game module that
 * wants to label a drivetrain on its own preset card would close that loop at evaluation
 * time. See the header of `./labelData`.
 */
export { DRIVETRAIN_LABELS, INTAKE_SHORT };

/**
 * A BUILD AS A SPEC SHEET — one row per job the robot does, in the terms that game actually has:
 * DECODE names the intake, the sorter and the shot, Chain Reaction the shooter, intake and
 * catalyst, and a game that fills `GameModule.specSheet` (BIOBUZZ) says its own. What a
 * leaderboard record and the ranked strategy card print about somebody else's robot
 * (`RobotSheet`, `SpecList`); the drivetrain, mass, speed and size are the sheet's own strip.
 *
 * It was `buildSummary`, the same facts joined into one ` · ` sentence. A reader looking for one
 * part had to parse the whole line, so it reads as rows now.
 */
export function specSheet(spec: RobotSpec, game: GameId): GameStatTile[] {
  const own = moduleFor(game).specSheet;
  if (own) return [...own(spec)];
  if (game === 'chain') {
    const mode = spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE;
    const swing = catalystSwingOf(spec);
    return [
      // a turret aims itself from wherever it is bolted, so its mount says nothing
      {
        label: 'Shooter',
        value: CHAIN_MODE_LABELS[mode],
        sub: isTurreted(mode) ? undefined : mountPhrase(shooterMountOf(spec)),
      },
      {
        label: 'Intake',
        value: CHAIN_INTAKE_LABELS[spec.chainIntake ?? CHAIN_DEFAULT_INTAKE],
        sub: mountPhrase(intakeMountOf(spec)),
      },
      {
        label: 'Catalyst',
        value: CHAIN_CATALYST_LABELS[spec.catalystType ?? CHAIN_DEFAULT_CATALYST],
        sub: `${mountPhrase(catalystMountOf(spec))}${swing ? `, swings ${swing === 'fb' ? 'front to back' : 'side to side'}` : ''}`,
      },
      { label: 'Hopper', value: `${Math.round(spec.ballStorage ?? CHAIN_STORAGE_DEFAULT)} particles` },
      { label: 'Clearance', value: `${(spec.groundClearance ?? CHAIN_CLEARANCE_DEFAULT).toFixed(1)}"` },
    ];
  }
  return [
    { label: 'Intake', value: INTAKE_SHORT[spec.intake], absent: spec.intake === 'none' },
    { label: 'Sorter', value: spec.canSort ? 'Colour sorter' : 'No sorter', absent: !spec.canSort },
    { label: 'Shooter', value: shotRange(spec.flywheelInertia), sub: `${spec.flywheelInertia.toFixed(2)} flywheel inertia` },
  ];
}

/**
 * HOW A RUN WAS DRIVEN, as the words a record prints: one per choice the game's Driving panel
 * actually offers, each a fact on its own ("Manual fire", not a grey "Auto fire").
 *
 * The leaderboard used to print all four assists for every game. BIOBUZZ has no auto fire
 * (`offersAutoFire: false`, forced off at spawn), yet its rows read "Auto fire" for some drivers
 * and not others, because a row stored before `Room.assistsOf` carried the player's DECODE / CR
 * menu setting. The menu is the authority on what a game has, so this asks the same slot it does.
 * AIM ASSIST is not offered anywhere (`coerceAssists` forces it on), so a chip for it said nothing.
 */
export function drivingWords(assists: AssistConfig, spec: RobotSpec, game: GameId): string[] {
  const mod = moduleFor(game);
  const words = [assists.fieldCentric ? 'Field-centric' : 'Robot-centric'];
  // a hand-loaded DECODE robot has no intake for the assist to run (`mobileActions` drops the button)
  if (!(mod.id === 'decode' && spec.intake === 'none')) words.push(assists.autoIntake ? 'Auto intake' : 'Manual intake');
  if (mod.offersAutoFire !== false) words.push(assists.autoFire ? 'Auto fire' : 'Manual fire');
  return words;
}

/**
 * THE SHORT FORM OF A BUILD: the drivetrain, then the mechanisms that make it this robot and
 * not another. What a robot CARD prints under its name (a saved robot, a preset, the swap row in
 * the lobby and the ranked strategy window) and what the builder hero prints under the team.
 *
 * `specSheet` above is the LONG form a leaderboard record or a strategy card prints, and it stays:
 * it carries the detail (mounts, feed, sorter) a card leaves out. This one has no numbers at all,
 * because every card that prints it sits beside a control that already shows them, and a card
 * whose line is a spec dump is the clutter the owner asked to be rid of (2026-09-22).
 *
 * A game that fills `statTiles` gets ITS mechanisms, read through its own resolvers — the same
 * slot rule `specSheet` follows for `GameModule.specSheet`, and for the same reason: an `else`
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
