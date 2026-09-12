import type { RobotSpec } from '../../types';
import { BB_DEFAULT_SCORE_MODE, type BbIntakeStyle } from './config';
import {
  BB_DEFAULT_INTAKE_MOUNT,
  type BbIntakeMount,
  type BbMountPos,
  type BbScoreMode,
  bbIntakeMountOf,
  bbShooterMountOf,
} from './mounts';

/**
 * Shared display labels for BIOBUZZ robot-config choices.
 *
 * ONE source, so the builder's pickers and the leaderboard's config summary name the same
 * thing identically. That is not tidiness: a record row that described a build in different
 * words from the builder that produced it is a row nobody can match back to a robot, and it
 * is exactly what happens when two files each write their own `switch`.
 *
 * Wired into the shared UI through the module's `labels` slot, so no shared file needs a
 * per-game branch to render a BIOBUZZ robot's summary.
 */

export const BB_MODE_LABELS: Record<BbScoreMode, string> = {
  turret: 'Turret shooter',
  twinturret: 'Twin turret',
  drum: 'Drum shooter',
  dumper: 'Dumper',
};

/** the one-line TRADEOFF each archetype is actually picked for. A label says what it is; a
 * blurb says why you would choose it, which is the only thing a picker really has to convey. */
export const BB_MODE_BLURBS: Record<BbScoreMode, string> = {
  turret: 'Aims itself · smallest hopper',
  twinturret: 'Fastest · heaviest · smallest hopper',
  drum: 'Streams a wide burst · turn to aim',
  dumper: 'Whole hopper at once · turn to aim',
};

export const BB_INTAKE_LABELS: Record<BbIntakeStyle, string> = {
  sweeper: 'Sweeper',
};

/** MOUNT labels — kept SHORT, because they sit in a 4-up button grid; the tradeoff goes in
 * the blurb rather than into a label that would then wrap. */
export const BB_INTAKE_MOUNT_LABELS: Record<BbIntakeMount, string> = {
  front: 'FRONT',
  back: 'BACK',
  side: 'SIDES',
  frontback: 'FRONT+BACK',
};

/** Blurbs are PARTIAL on purpose: a mount gets one only when it says something the label does
 * not. "FRONT · grabs from the front" is noise; "SIDES · least storage" is the trade you are
 * actually making. */
export const BB_INTAKE_MOUNT_BLURBS: Partial<Record<BbIntakeMount, string>> = {
  side: 'Least storage',
  frontback: 'Less storage',
};

/** Position labels, short enough to sit in a 3x3 chassis-map cell. Shared by the turretless
 * firing-edge picker and the turret POSITION picker — the same nine points either way. */
export const BB_MOUNT_POS_LABELS: Record<BbMountPos, string> = {
  frontleft: 'F·LEFT',
  front: 'FRONT',
  frontright: 'F·RIGHT',
  left: 'LEFT',
  center: 'CENTER',
  right: 'RIGHT',
  backleft: 'B·LEFT',
  back: 'BACK',
  backright: 'B·RIGHT',
};

/**
 * The one-line config summary a leaderboard row or a match-strategy card shows.
 *
 * Reads through the same resolvers the sim uses (`bbIntakeMountOf`, `bbShooterMountOf`) rather
 * than the raw spec fields, so a build saved before a field existed — or routed through an
 * older peer that dropped it — is summarised as the mount it will actually spawn with rather
 * than as a blank.
 */
export function bbConfigSummary(spec: RobotSpec): string {
  const mode = (spec.scoreMode ?? BB_DEFAULT_SCORE_MODE) as BbScoreMode;
  const mount = bbIntakeMountOf(spec) ?? BB_DEFAULT_INTAKE_MOUNT;
  const shooter = bbShooterMountOf(spec);
  const parts = [
    BB_MODE_LABELS[mode],
    `${BB_INTAKE_MOUNT_LABELS[mount]} sweeper`,
    `${BB_MOUNT_POS_LABELS[shooter]} launcher`,
    // POLLEN, never "balls" — the user-visible word for this game's scoring element.
    `${spec.ballStorage ?? 0} pollen`,
  ];
  return parts.join(' · ');
}
