import type { RobotSpec } from '../../types';
import { BB_HOOD_DEFAULT_DEG, type BbIntakeStyle } from './config';
import {
  BB_DEFAULT_INTAKE_MOUNT,
  type BbIntakeMount,
  type BbMountPos,
  type BbScoreMode,
  bbIntakeMountOf,
} from './mounts';
import { type BbLauncherSpec, type BbLiftKind, bbLauncherOf, bbLiftOf } from './mechs';

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
 * blurb says why you would choose it, which is the only thing a picker really has to convey.
 *
 * ⚠️ NONE OF THESE MAY MENTION HOPPER SIZE ANY MORE. Three of the four used to — "smallest
 * hopper" twice and "whole hopper at once" — from back when `BB_STORAGE_MAX` was 24 and the
 * archetype multipliers really did separate a turret from a dumper by a factor of two. G407
 * caps CONTROL at 4 SCORING ELEMENTS, so every archetype now reaches the same ceiling and a
 * blurb selling one on capacity is selling a difference that no longer exists. What still
 * separates them is CADENCE and how they aim, so that is what these say. */
export const BB_MODE_BLURBS: Record<BbScoreMode, string> = {
  turret: 'Aims itself · one at a time',
  twinturret: 'Fastest cadence · heaviest',
  drum: 'Streams a wide burst · turn to aim',
  dumper: 'Empties in one heave · turn to aim',
};

/**
 * THE LAUNCHER SLOT'S FIFTH OPTION — no launcher at all. `BbScoreMode` has no member for it
 * (the four archetypes above are all real MECHANISMS, and "none" is not a fifth kind of one),
 * so it cannot join `BB_MODE_LABELS`/`BB_MODE_BLURBS` as a key; it lives beside them for a
 * picker that offers the four kinds plus this genuinely fifth option — Studica's published
 * StarterBot ships exactly this build (`presets.ts`).
 *
 * ⚠️ NEVER SUBSTITUTE A `BB_MODE_LABELS` ENTRY FOR AN ABSENT LAUNCHER. Reading a launcher-less
 * spec as, say, a default turret is the phantom-turret bug `mechs.ts`'s header is written
 * against — a build with no launcher has to say so, not read as a default one.
 */
export const BB_LAUNCHER_NONE_LABEL = 'No launcher';
export const BB_LAUNCHER_NONE_BLURB = 'Drivetrain + intake only — a real, legal build';

/** the label for a resolved LAUNCHER slot, including the NONE case. One function so a picker
 * option, a preset card and a config summary can never describe the same robot differently —
 * the same reasoning `BB_MODE_LABELS` above already follows for the four real kinds. */
export function bbLauncherLabel(launcher: BbLauncherSpec | null): string {
  return launcher ? BB_MODE_LABELS[launcher.kind] : BB_LAUNCHER_NONE_LABEL;
}

/** the one-line blurb for a resolved LAUNCHER slot, including the NONE case. */
export function bbLauncherBlurb(launcher: BbLauncherSpec | null): string {
  return launcher ? BB_MODE_BLURBS[launcher.kind] : BB_LAUNCHER_NONE_BLURB;
}

/** LIFT kind labels. One entry today (`vslide`) but kept a `Record` rather than a single
 * string for the reason `BB_LIFT_KINDS` (`mechs.ts`) is an enum rather than a boolean: a second
 * lift archetype (a pivoting arm, a telescoping boom) is an added member here, not a rewritten
 * picker or a second constant somebody has to remember to add. */
export const BB_LIFT_KIND_LABELS: Record<BbLiftKind, string> = {
  vslide: 'Vertical slide',
};

/** the LIFT's tradeoff: what it reaches, and — just as importantly — what it structurally
 * cannot. See `BB_R105_HEIGHT_CAP` (`config.ts`) for why the HIVE is out of reach for any
 * carriage a robot could legally build. */
export const BB_LIFT_KIND_BLURBS: Record<BbLiftKind, string> = {
  vslide: 'Places into a FLOWER · the HIVE stays out of reach',
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
 * not. "FRONT · grabs from the front" is noise; the trade you are actually making is not.
 *
 * ⚠️ THESE USED TO NAME A STORAGE COST — "Least storage" / "Less storage" — and that is now
 * false for the same reason the archetype blurbs' was: G407 caps every build at 4, so the
 * mount multipliers in `bbMountStoreMult` no longer change what a robot can hold. What a mount
 * genuinely changes is WHERE the robot can collect from, which is what these say instead. */
export const BB_INTAKE_MOUNT_BLURBS: Partial<Record<BbIntakeMount, string>> = {
  side: 'Strafe-collect along a line',
  frontback: 'Collect driving either way',
};

/** Position labels, short enough to sit in a 3x3 chassis-map cell. Shared by the turretless
 * firing-edge picker, the turret POSITION picker AND the lift's mast-mount picker — the same
 * nine points every time. */
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
 * Reads through the MECHANISM RESOLVERS (`bbLauncherOf`, `bbLiftOf`, `bbIntakeMountOf`) rather
 * than the raw `scoreMode`/`shooterMount`/`bbMech` fields, so a build saved before `bbMech`
 * existed — or routed through an older peer that dropped it — is summarised as the mechanism
 * it will actually spawn with. That is what keeps a launcher-less build (Studica) from reading
 * as some particular archetype it does not have: `bbLauncherOf` returns `null` for it and
 * `bbLauncherLabel` says so directly, rather than this function falling back to
 * `spec.scoreMode`'s legacy MIRROR value the way it used to.
 *
 * A LIFT is now HALF THE BUILD, same as Chain Reaction's catalyst — see the stat-chip comment
 * in `src/ui/Menu.tsx` ("THE CATALYST, which this summary never mentioned. It is half the
 * build ... and changing any of that left every tile on the card reading exactly the same,
 * which looks like the picker did nothing."). Two BIOBUZZ builds that differ only by a lift
 * must not produce the same summary line, so it is appended whenever one exists.
 */
export function bbConfigSummary(spec: RobotSpec): string {
  const launcher = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
  const lift = bbLiftOf(spec);
  const mount = bbIntakeMountOf(spec) ?? BB_DEFAULT_INTAKE_MOUNT;
  const parts = [bbLauncherLabel(launcher), `${BB_INTAKE_MOUNT_LABELS[mount]} sweeper`];
  if (launcher) parts.push(`${BB_MOUNT_POS_LABELS[launcher.mount]} launcher`);
  if (lift) parts.push(`${BB_LIFT_KIND_LABELS[lift.kind]} · ${BB_MOUNT_POS_LABELS[lift.mount]}`);
  // POLLEN, never "balls" — the user-visible word for this game's scoring element.
  parts.push(`${spec.ballStorage ?? 0} pollen`);
  return parts.join(' · ');
}
