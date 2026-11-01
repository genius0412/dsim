import type { RobotSpec } from '../../types';
// `src/sponsor.ts` is DOM-free and imports nothing, so this is safe from the headless smoke run.
// It is NOT safe from the server — see `bbLiftKindLabel` for why nothing server-reachable reads
// this file.
import { sponsorActive } from '../../sponsor';
// TYPE-ONLY, and it has to stay that way: `../module` is reached from `games/index.ts`, so a
// VALUE import here would close the registry cycle `presets.ts` already hit once at boot
// (`Cannot access 'BB_PRESET_LIST' before initialization`). `import type` is erased.
import type { GameStatTile } from '../module';
import { MOUNT_WORDS, mountPhrase } from '../../ui/labelData';
import { BB_HOOD_DEFAULT_DEG, bbHopperCap } from './config';
import {
  BB_DEFAULT_INTAKE_MOUNT,
  type BbIntakeMount,
  type BbMountPos,
  type BbScoreMode,
  bbIntakeMountOf,
} from './mounts';
import {
  type BbIntakeFeed,
  type BbIntakeKind,
  type BbLauncherSpec,
  type BbNectarReject,
  type BbLiftKind,
  type BbLiftSpec,
  bbHasRampBar,
  bbIntakeFeedOf,
  bbIntakeKindOf,
  bbIsTurreted,
  bbLauncherOf,
  bbLiftOf,
  bbNectarRejectOf,
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
  fixed: 'Fixed shooter',
};

/** the one-line TRADEOFF each launcher is actually picked for. A label says what it is; a
 * blurb says why you would choose it, which is the only thing a picker really has to convey.
 *
 * What separates them is HOW THEY AIM (a turret aims itself, a dumper and a fixed shooter turn
 * the robot) and how they release. WHICH ELEMENTS a robot carries is the INTAKE's feed since
 * 2026-10-24 (`bbIntakeFeedOf`), so no blurb here may say POLLEN only: a single turret fires a
 * NECTAR the intake took. The double turret is the one launcher that fixes the feed (it has a
 * NECTAR turret to feed). ⚠️ None of these may sell a launcher on hopper size: the hopper is
 * capped at 4 for every build (owner ruling 2026-09-12), so that difference does not exist. */
export const BB_MODE_BLURBS: Record<BbScoreMode, string> = {
  turret: 'Aims itself · fires whatever the intake takes',
  twinturret: 'One POLLEN turret, one NECTAR turret',
  dumper: 'Heaves the whole hopper · turn to aim',
  fixed: 'Turn to aim, one range',
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

/** THE LIFT SLOT'S ABSENT CASE: a build with no Box Tube has to SAY so. The StarterBot ships
 * without one, so this is the common reading, not the edge case. */
export const BB_LIFT_NONE_LABEL = 'No box tube';

/** the label for a resolved LIFT slot, including the NONE case — `bbLauncherLabel`'s twin. */
export function bbLiftLabel(lift: BbLiftSpec | null, now?: number): string {
  return lift ? bbLiftKindLabel(lift.kind, now) : BB_LIFT_NONE_LABEL;
}

export const BB_INTAKE_LABELS: Record<BbIntakeKind, string> = {
  sweeper: 'Sweeper',
  siderollers: 'Side rollers',
  ramp: 'Deployable ramp',
};

/** the one-line TRADEOFF each intake archetype is picked for. All three take a ground POLLEN
 * identically (`mechs.ts`); what differs is whether the hardware can also reach the POLLEN
 * sitting at the bottom of a FLOWER's opening, which the sweeper's roller line never does. */
export const BB_INTAKE_KIND_BLURBS: Record<BbIntakeKind, string> = {
  sweeper: 'From the ground only · can’t reach into a FLOWER’s opening',
  siderollers: 'Reaches into a FLOWER’s opening and pulls the bottom POLLEN out',
  ramp: 'Deploy to wedge under a FLOWER’s bottom POLLEN · folded, it takes nothing',
};

/** what the intake is sized for (`BbIntakeFeed`, `mechs.ts`) */
export const BB_FEED_LABELS: Record<BbIntakeFeed, string> = {
  pollen: 'POLLEN only',
  mixed: 'POLLEN + NECTAR',
};

/** ...and the tradeoff. A roller cannot see colour, so a NECTAR intake takes the opponent's too. */
export const BB_FEED_BLURBS: Record<BbIntakeFeed, string> = {
  pollen: 'No NECTAR fits, so nothing to sort',
  mixed: 'Takes the opponent’s NECTAR too · holding one is G408',
};

/** what a POLLEN + NECTAR intake does with the opponent's NECTAR (`BbNectarReject`, `mechs.ts`) */
export const BB_REJECT_LABELS: Record<BbNectarReject, string> = {
  none: 'No sorter',
  reverse: 'Auto-reverse',
  passthrough: 'Pass-through',
  bar: 'NECTAR bar',
};

/** what each sorter does. A ramp intake is offered no `bar`: its ramp is one (`bbHasRampBar`), and
 * the builder says so under the choices (`BB_RAMP_BAR_NOTE`). */
export const BB_REJECT_BLURBS: Record<BbNectarReject, string> = {
  none: 'Reverse the intake yourself to spit it out',
  reverse: 'Sees it, reverses, spits it back out · still G408',
  passthrough: 'Routes it through and back out · never stops · still G408',
  bar: 'Drop the bar to keep every NECTAR out',
};

/** under a ramp intake's sorter choices: the ramp doubles as the NECTAR bar, on its own button */
export const BB_RAMP_BAR_NOTE = 'The ramp doubles as a NECTAR bar: the NECTAR bar button holds it at bar height';

/** MOUNT labels — kept SHORT, because they sit in a 4-up button grid. The buttons carry no
 * blurb (owner, 2026-09-24). */
export const BB_INTAKE_MOUNT_LABELS: Record<BbIntakeMount, string> = {
  front: 'FRONT',
  back: 'BACK',
  side: 'SIDES',
  frontback: 'FRONT+BACK',
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
 * THE SPEC SHEET a leaderboard record and a strategy card print (`GameModule.specSheet`): one row
 * per job the robot does, in the builder's own words.
 *
 * It replaced `bbConfigSummary`, a sentence that joined every part with ` · ` (`Double turret ·
 * FRONT+BACK sweeper · F·RIGHT + F·LEFT launcher · 4 pollen`). A reader had to parse it, its
 * mounts were the builder's 3x3 grid labels in capitals, and it called every intake a SWEEPER
 * because it never read the intake's kind: the deployable ramp most of the board's top runs carry
 * was described as the one intake that cannot reach into a FLOWER.
 *
 * Reads through the MECHANISM RESOLVERS (`bbLauncherOf`, `bbLiftOf`, `bbIntakeKindOf`, …), never
 * the flat mirrors, so a build saved before `bbMech` existed is described as the robot it spawns
 * as. A DOUBLE turret names both cells, POLLEN turret first, because two double turrets that
 * differ only by the NECTAR turret's cell are two different robots. An absent Box Tube is a row of
 * its own (`absent`): only a Box Tube scores a FLOWER, so "cannot" is a fact about the robot.
 */
export function bbSpecSheet(spec: RobotSpec): GameStatTile[] {
  const launcher = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
  const lift = bbLiftOf(spec);
  const feed = bbIntakeFeedOf(spec);
  const reject = bbNectarRejectOf(spec);
  const rows: GameStatTile[] = [
    { label: 'Launcher', value: bbLauncherLabel(launcher), sub: bbLauncherWhere(launcher) },
    {
      label: 'Intake',
      value: BB_INTAKE_LABELS[bbIntakeKindOf(spec)],
      sub: `${mountPhrase(bbIntakeMountOf(spec) ?? BB_DEFAULT_INTAKE_MOUNT)} · ${BB_FEED_LABELS[feed]}`,
    },
  ];
  // a SORTER is a question only a POLLEN + NECTAR intake has to answer: a POLLEN-only one takes no NECTAR
  if (feed === 'mixed') {
    rows.push(
      reject !== 'none'
        ? { label: 'Sorter', value: BB_REJECT_LABELS[reject] }
        : bbHasRampBar(spec)
          ? { label: 'Sorter', value: 'Ramp as NECTAR bar' }
          : { label: 'Sorter', value: BB_REJECT_LABELS.none, absent: true },
    );
  }
  rows.push(
    { label: 'Flower scoring', value: bbLiftLabel(lift), sub: lift ? mountPhrase(lift.mount) : undefined, absent: !lift },
    // the capacity the sim enforces (`bbHopperCap`), in the builder's word for it
    { label: 'Hopper', value: `${bbHopperCap(spec)} pollen` },
  );
  return rows;
}

/** where a launcher sits, as a spec-sheet line: a double turret names which turret is where, a
 * fixed shooter its hood, and a single turret or a dumper its one cell. */
function bbLauncherWhere(launcher: BbLauncherSpec): string {
  if (launcher.kind === 'twinturret' && launcher.mount2) {
    return `POLLEN ${MOUNT_WORDS[launcher.mount]} · NECTAR ${MOUNT_WORDS[launcher.mount2]}`;
  }
  const at = mountPhrase(launcher.mount);
  return launcher.kind === 'fixed' ? `${at} · ${launcher.hoodDeg}° hood` : at;
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
 * names both cells; a dumper fires over its edge, and lobs each dump for its distance, so the edge
 * is all there is to say (it used to print a HOOD, which no longer exists — owner, 2026-09-13).
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
        : launcher.kind === 'fixed'
          ? `${BB_MOUNT_POS_LABELS[launcher.mount]} · ${launcher.hoodDeg}° hood`
          : BB_MOUNT_POS_LABELS[launcher.mount],
    },
    {
      value: bbLiftLabel(lift),
      label: 'flower scoring',
      sub: lift ? BB_MOUNT_POS_LABELS[lift.mount] : undefined,
      absent: !lift,
    },
  ];
}
