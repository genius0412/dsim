import type { RobotSpec } from '../../types';
// `src/sponsor.ts` is DOM-free and imports nothing, so this is safe from the headless smoke run.
// It is NOT safe from the server — see `bbLiftKindLabel` for why nothing server-reachable reads
// this file.
import { sponsorActive } from '../../sponsor';
// TYPE-ONLY, and it has to stay that way: `../module` is reached from `games/index.ts`, so a
// VALUE import here would close the registry cycle `presets.ts` already hit once at boot
// (`Cannot access 'BB_PRESET_LIST' before initialization`). `import type` is erased.
import type { GameStatTile } from '../module';
import { BB_HOOD_DEFAULT_DEG, type BbIntakeStyle } from './config';
import {
  BB_DEFAULT_INTAKE_MOUNT,
  type BbIntakeMount,
  type BbMountPos,
  type BbScoreMode,
  bbIntakeMountOf,
} from './mounts';
import {
  type BbLauncherSpec,
  type BbLiftKind,
  type BbLiftSpec,
  bbIsTurreted,
  bbLauncherOf,
  bbLiftOf,
} from './mechs';

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
  turret: 'Single turret',
  twinturret: 'Double turret',
  dumper: 'Dumper',
};

/** the one-line TRADEOFF each launcher is actually picked for. A label says what it is; a
 * blurb says why you would choose it, which is the only thing a picker really has to convey.
 *
 * What separates the three is WHICH ELEMENTS they can carry (a single turret feeds POLLEN
 * only — `bbCarriesNectar`, `mechs.ts`) and HOW THEY AIM (a turret aims itself, a dumper turns
 * the robot). ⚠️ None of these sell a launcher on hopper size. G407 once capped every build at 4; it is a warning now and the volume law differs by launcher again,
 * but the blurb names what the launcher is FOR. */
export const BB_MODE_BLURBS: Record<BbScoreMode, string> = {
  turret: 'POLLEN only · aims itself',
  twinturret: 'One POLLEN turret, one NECTAR turret',
  dumper: 'POLLEN and NECTAR · turn to aim',
};

/** the label for a resolved LAUNCHER slot. One function so a picker option, a preset card and a
 * config summary can never describe the same robot differently. A launcher is MANDATORY (owner
 * ruling 2026-09-12), so there is no NONE case. */
export function bbLauncherLabel(launcher: BbLauncherSpec): string {
  return BB_MODE_LABELS[launcher.kind];
}

/** the one-line blurb for a resolved LAUNCHER slot. */
export function bbLauncherBlurb(launcher: BbLauncherSpec): string {
  return BB_MODE_BLURBS[launcher.kind];
}

/** WHERE a resolved launcher sits, as the short position text a tile or a summary prints: one
 * cell for a single turret or a dumper, both cells for a double turret (POLLEN turret first). */
export function bbLauncherMountLabel(launcher: BbLauncherSpec): string {
  const first = BB_MOUNT_POS_LABELS[launcher.mount];
  return launcher.kind === 'twinturret' && launcher.mount2
    ? `${first} + ${BB_MOUNT_POS_LABELS[launcher.mount2]}`
    : first;
}

/**
 * The LIFT kind's display name. The one kind today (`vslide`) is the Box Tube, and while the
 * app's presenting sponsor is live it carries the sponsor's product name.
 *
 * ── WHY A FUNCTION OF TIME AND NOT A `Record` ───────────────────────────────
 * "OFFSET™ Box Tube" is part of the sponsorship, so it has to come down exactly when every other
 * placement does: at the end of `SPONSOR.term`, or immediately under the `VITE_SPONSOR=0` kill
 * switch. `sponsorActive` (`src/sponsor.ts`, DOM-free) already answers both, so the label asks it
 * rather than keeping a second copy of the term. `now` is an ARGUMENT for the same reason
 * `sponsorActive` takes one: omitted, it falls through to that function's own default clock, so
 * nothing in `src/games/biobuzz/` reads a clock itself and smoke can test either side of the term.
 *
 * ⚠️ CLIENT-ONLY. Nothing server-reachable (`games/sim.ts`, `hudRobot.ts`) may call this: a
 * label is presentation, and the sim's HUD slice carries the resolved `kind`, never words.
 */
export function bbLiftKindLabel(kind: BbLiftKind, now?: number): string {
  switch (kind) {
    case 'vslide':
      return sponsorActive(now) ? 'OFFSET™ Box Tube' : 'Box tube';
  }
}

/** the LIFT's tradeoff: how it scores. Nothing launched ever enters a FLOWER, so this is the
 * only way a robot scores one. */
export const BB_LIFT_KIND_BLURBS: Record<BbLiftKind, string> = {
  vslide: 'Places into a FLOWER · drive the marker onto it',
};

/** THE LIFT SLOT'S ABSENT CASE: a build with no Box Tube has to SAY so. The StarterBot ships
 * without one, so this is the common reading, not the edge case. */
export const BB_LIFT_NONE_LABEL = 'No box tube';

/** the label for a resolved LIFT slot, including the NONE case — `bbLauncherLabel`'s twin. */
export function bbLiftLabel(lift: BbLiftSpec | null, now?: number): string {
  return lift ? bbLiftKindLabel(lift.kind, now) : BB_LIFT_NONE_LABEL;
}

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
 * ⚠️ THESE USED TO NAME A STORAGE COST — "Least storage" / "Less storage" — and that was
 * false while G407 capped every build at 4. G407 is a warning now (owner ruling 2026-09-12), so the
 * mount multipliers in `bbMountStoreMult` change what a robot can hold again. What a mount
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
 * it will actually spawn with, not as whatever the legacy flat MIRROR happens to carry.
 *
 * A DOUBLE turret names BOTH of its cells (POLLEN turret first), because two double turrets
 * that differ only by where the NECTAR turret sits are two different robots.
 *
 * A BOX TUBE is HALF THE BUILD, same as Chain Reaction's catalyst — see the stat-chip comment
 * in `src/ui/Menu.tsx`. Two builds that differ only by a tube must not produce the same line,
 * so it is appended whenever one exists.
 */
export function bbConfigSummary(spec: RobotSpec): string {
  const launcher = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
  const lift = bbLiftOf(spec);
  const mount = bbIntakeMountOf(spec) ?? BB_DEFAULT_INTAKE_MOUNT;
  const parts = [
    bbLauncherLabel(launcher),
    `${BB_INTAKE_MOUNT_LABELS[mount]} sweeper`,
    `${bbLauncherMountLabel(launcher)} launcher`,
  ];
  if (lift) parts.push(`${bbLiftKindLabel(lift.kind)} · ${BB_MOUNT_POS_LABELS[lift.mount]}`);
  // POLLEN, never "balls" — the user-visible word for this game's scoring element.
  parts.push(`${spec.ballStorage ?? 0} pollen`);
  return parts.join(' · ');
}

/**
 * The BUILDER HERO's per-game stat tiles — `GameModule.statTiles`.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 * `Menu.tsx` chose the hero's per-game tiles with `isDecode ? <intake> : <scoring +
 * catalyst>`, so BIOBUZZ did not fall through to "no per-game tile" — it fell into the CHAIN
 * arm and advertised a **CATALYST**, which is Chain Reaction's mechanism and a word that must
 * never appear in this game.
 *
 * ── TWO TILES, ALWAYS BOTH ──────────────────────────────────────────────────
 * The launcher is mandatory and the Box Tube is optional, so a build is one of two shapes, and
 * an ABSENT tube is a fact about the robot rather than a tile to hide: only a Box Tube scores a
 * FLOWER, so "this robot cannot score a FLOWER" is exactly what the second tile has to say.
 * Its caption is what the mechanism is FOR ("flower scoring") rather than its kind, so the tile
 * reads correctly on both sides of the line.
 *
 * Read through the MECHANISM RESOLVERS, never the flat mirrors.
 *
 * The SUB line carries what the value has no room for and only what the mechanism actually
 * has: a single turret aims itself, so its mount is just where it is bolted; a double turret
 * names both cells; a dumper fires over a fixed edge at a fixed HOOD — a real dial the builder
 * offers, and the one number that changes where its elements land.
 */
export function bbStatTiles(spec: RobotSpec): readonly GameStatTile[] {
  const launcher = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
  const lift = bbLiftOf(spec);
  return [
    {
      value: bbLauncherLabel(launcher),
      label: 'launcher',
      sub: bbIsTurreted(launcher)
        ? bbLauncherMountLabel(launcher)
        : `${BB_MOUNT_POS_LABELS[launcher.mount]} · ${launcher.hoodDeg}° hood`,
    },
    {
      value: bbLiftLabel(lift),
      label: 'flower scoring',
      sub: lift ? BB_MOUNT_POS_LABELS[lift.mount] : undefined,
    },
  ];
}
