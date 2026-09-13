import type { RobotSpec } from '../../types';
import { massLimits } from '../../sim/drivetrain';
import { DRIVETRAIN_LABELS } from '../../ui/labelData';
import { BB_DEFAULT_SCORE_MODE, BB_HOOD_DEFAULT_DEG, BB_PRESETS, BB_STORAGE_MAX, bbMassFloorBump } from './config';
import { bbIntakeMountOf, bbShooterMountOf } from './mounts';
import { type BbMechSpec, bbLauncherOf, bbLiftOf } from './mechs';
import {
  BB_INTAKE_MOUNT_LABELS,
  BB_MODE_LABELS,
  BB_MOUNT_POS_LABELS,
  bbLauncherMountLabel,
  bbLiftKindLabel,
} from './labels';
import { bbCoerceSpec } from './robotConfig';

/**
 * BIOBUZZ PRESET ROBOTS — the StarterBot, then the archetype demos.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM `config.ts` ────────────────────────
 * `config.ts` holds `BB_PRESETS`, and it has to: `coerce.ts` reads `BB_PRESETS[0]` to build
 * `BB_DEFAULT_SPEC`, and `coerce.ts` is a LEAF — it is a dependency of `src/sim/spawn.ts`'s
 * `coerceSpec`, so it may not import anything that reaches back to the spawn chokepoint.
 * Everything in THIS file does reach it (the match test and the card lines are UI-side, and
 * `massLimits` pulls in the drivetrain model), so the display list lives here and the
 * coercer's base stays where the leaf can see it.
 *
 * ── ONE STARTERBOT, AND NO VENDOR NAMES ─────────────────────────────────────
 * The card is the robot a rookie kit builds, not any one company's kit: a 6WD drop-centre tank
 * with a chassis-fixed launcher over the front and a sweeper feeding it. Several kits ship that
 * shape, and they differ in details this sim does not model, so one card stands for all of them
 * (owner ruling 2026-09-12: the kit cards collapse into one, and no card, team line or comment
 * here names a vendor). It is the first entry so a player meets an ordinary buildable robot
 * before an invented one — the same ordering Chain Reaction uses (`CHAIN_REAL_PRESETS`).
 *
 * ⚠️ WHAT IS SOURCED AND WHAT IS NOT. Kit documentation publishes drivetrain topology, motors
 * and wheel sizes; it does not publish an overall footprint, a height or a weight. So the
 * footprint below is `APPROX` and the mass is the sim's own floor (see `BB_STARTER_BOTS`).
 *
 * ── HOW `driveRpm` IS DERIVED (this is not a gearmotor's RPM) ───────────────
 * `RobotSpec.driveRpm` is not a real wheel RPM: `SPEED_PER_RPM` is normalised to a 104 mm
 * reference wheel (`src/config.ts`), so the sim's speed is `SPEED_PER_RPM · driveRpm ·
 * speedMult`. Entering a published RPM directly would overstate a robot that does not run a
 * 104 mm wheel, so the entry converts:
 *
 *     free speed (in/s) = π · (wheel_mm / 25.4) · motor_rpm / 60
 *     driveRpm          = free speed / (SPEED_PER_RPM · speedMult)
 *
 * These are FREE speeds; `SPEED_PER_RPM` already carries a 0.95 loaded-efficiency factor, so
 * they remain a few percent optimistic — the same optimism every other preset in the repo has.
 *
 * ── THE MECHANISM LOADOUT (`bbMech`) ────────────────────────────────────────
 * The StarterBot carries an explicit `bbMech` rather than leaning on `coerceBiobuzzSpec`'s
 * migration from `scoreMode`/`shooterMount`, so its loadout is a fact you can read off the
 * object rather than one you have to trust a coercer to derive.
 */

/** the assists a StarterBot loads with. A rookie build is robot-centric and fully assisted:
 * these are the robots a new player picks, and the point of them is to drive well immediately.
 * Same set the archetype demos use. */
const BB_STARTER_ASSISTS = {
  fieldCentric: false,
  aimAssist: true,
  autoIntake: true,
  autoFire: true,
} as const;

/**
 * The hopper is capped at FOUR elements (owner ruling 2026-09-12, `BB_STORAGE_MAX`), and the
 * StarterBot is built to it. The field stages exactly 4 pre-loaded per robot (§10.3.1).
 *
 * Read from `BB_STORAGE_MAX` rather than written as `4` here: two independent spellings of one
 * number is how they drift apart.
 */
const BB_G407_CAP = BB_STORAGE_MAX;

/** The StarterBot, as a BUILD. Mass and the legacy mirrors are filled in below. */
const BB_STARTER_BUILDS: readonly RobotSpec[] = [
  {
    // ── StarterBot: the common rookie kit shape ──────────────────────────────
    // A 6WD drop-centre tank: four driven traction wheels chained per side plus two undriven
    // omni wheels at the dropped centre, one gearmotor a side. A single chassis-fixed launcher
    // over the front, fed by a front sweeper. No Box Tube — the kit has no placement mechanism.
    //   driveRpm: a 96 mm wheel on a ~312 rpm drive gearmotor,
    //             π·(96/25.4)·312/60 = 61.7 in/s ÷ (0.20367 · 1.06 tank) = 286
    // The launcher is modelled as a front DUMPER at the default hood: chassis-fixed, so the
    // robot turns to aim, and it carries both POLLEN and NECTAR.
    name: 'StarterBot', teamName: 'Kit robot · 6WD tank', teamNumber: 0,
    length: 15, width: 16, // APPROX — kit side rails are ~15"; no kit publishes a width
    intake: 'sloped', massLb: 0, drivetrain: 'tank',
    driveRpm: 286, flywheelInertia: 0.5, canSort: false, // inertia APPROX: a direct-drive flywheel
    scoreMode: 'dumper',
    intakeMount: 'front', shooterMount: 'front',
    ballStorage: BB_G407_CAP,
    bbMech: { launcher: { kind: 'dumper', mount: 'front', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null },
    assists: { ...BB_STARTER_ASSISTS },
  },
] as const;

/**
 * The StarterBot, with MASS derived rather than typed and the whole build run through the ONE
 * coercion chokepoint.
 *
 * MASS. No kit publishes a weight, so a typed number would be a guess with a decimal point. The
 * mass FLOOR is the honest answer instead: it is what the sim already believes a given
 * drivetrain plus its mechanisms has to weigh, it moves when those constants move, and it is the
 * same choice Chain Reaction makes for its real robots.
 *
 * COERCION. A card must be a fixed point of `coerceSpec` or it can never read as selected —
 * the builder compares against a spec that has been through the coercer, so a card carrying
 * anything the coercer would touch is a card that never lights up. Rather than hand-maintain
 * that property across a dozen fields, the builds are DEFINED as their own coerced form (which
 * also writes the legacy `intakeSide` / `shooterRear` mirrors no literal declares). Idempotence
 * makes this sound, and smoke asserts both halves.
 */
export const BB_STARTER_BOTS: readonly RobotSpec[] = BB_STARTER_BUILDS.map((s) =>
  bbCoerceSpec({ ...s, massLb: massLimits(s.drivetrain, s.flywheelInertia, bbMassFloorBump(s)).min }),
);

/** how many leading entries of `BB_PRESET_LIST` are real, buildable kit robots. The builder rules
 * off after these so "the robot a kit builds" is visibly a different kind of thing from "what a
 * double turret feels like". Mirrors `CHAIN_REAL_PRESETS`. */
export const BB_REAL_PRESETS = BB_STARTER_BOTS.length;

/**
 * A BOX TUBE for exactly one archetype demo, keyed by NAME.
 *
 * The demos (Sniper / Hauler / Skimmer) are DEFINED in `config.ts`, not here — `BB_PRESETS` is a
 * dependency of the leaf `coerce.ts` (it reads `BB_PRESETS[0]` to build `BB_DEFAULT_SPEC`), so it
 * cannot move into this file without dragging a spawn-chokepoint import into a leaf. A tube is
 * therefore attached at THIS boundary instead — the display list this file already owns. A
 * launcher needs nothing here: a bare `scoreMode` + `shooterMount` already migrates to the
 * matching launcher (`bbLauncherOf`'s legacy path). A Box Tube has no such path — `bbLiftOf`
 * never migrates one into existence — which is why this map exists and has exactly one entry.
 *
 * SNIPER is the one that gets it. A single turret launches POLLEN into the HIVE by itself, and
 * nothing launched ever enters a FLOWER, so the tube is what gives that build its FLOWER half.
 * Keyed by NAME rather than array index so a reordering of `BB_PRESETS` cannot silently hand the
 * tube to the wrong card.
 */
const BB_DEMO_LIFT: Partial<Record<string, BbMechSpec['lift']>> = {
  Sniper: { kind: 'vslide', mount: 'back' }, // a Box Tube at the back: FLOWER placement beside a HIVE turret
};

/**
 * What the builder's `Presets` section offers: the StarterBot, then the archetype demos in
 * `config.ts`.
 *
 * The demos exist to show every launcher and a Box Tube in one click, which the StarterBot
 * cannot: it is a front-sweeper, front-launcher tank, because that is what a rookie kit builds.
 *
 * The demos are coerced here too, for the same reason the StarterBot is: `BB_PRESETS` is built
 * for `coerce.ts` to take its default from, not for a picker to compare against, and it carries
 * no legacy mirror fields. `BB_DEMO_LIFT`'s one entry rides through the same coercion, so the
 * tube it adds is mount-resolved exactly as a Builder edit would be.
 */
export const BB_PRESET_LIST: readonly RobotSpec[] = [
  ...BB_STARTER_BOTS,
  ...BB_PRESETS.map((p) => {
    const lift = BB_DEMO_LIFT[p.name];
    return bbCoerceSpec(lift ? { ...p, bbMech: { launcher: bbLauncherOf(p, BB_HOOD_DEFAULT_DEG), lift } } : p);
  }),
];

/**
 * Does `spec` carry `preset`'s BUILD?
 *
 * The shared chassis fields plus this game's whole loadout. Identity (name / team / number) is
 * excluded on purpose: applying a card keeps the player's own identity, so comparing it would
 * make every card stop reading as selected the instant it was clicked.
 *
 * `flywheelInertia` IS compared, unlike Chain Reaction's matcher — BIOBUZZ launchers store
 * energy and it is a real dial here.
 */
export function bbSpecMatches(spec: RobotSpec, preset: RobotSpec): boolean {
  return (
    spec.length === preset.length &&
    spec.width === preset.width &&
    spec.massLb === preset.massLb &&
    spec.drivetrain === preset.drivetrain &&
    spec.driveRpm === preset.driveRpm &&
    (spec.tankRpm ?? 0) === (preset.tankRpm ?? 0) &&
    spec.flywheelInertia === preset.flywheelInertia &&
    spec.intake === preset.intake &&
    (spec.scoreMode ?? BB_DEFAULT_SCORE_MODE) === (preset.scoreMode ?? BB_DEFAULT_SCORE_MODE) &&
    bbIntakeMountOf(spec) === bbIntakeMountOf(preset) &&
    bbShooterMountOf(spec) === bbShooterMountOf(preset) &&
    (spec.ballStorage ?? 0) === (preset.ballStorage ?? 0) &&
    bbMechMatches(spec, preset)
  );
}

/**
 * Does the MECHANISM LOADOUT match — the half of the comparison `scoreMode`/`shooterMount`
 * cannot see: a dumper's HOOD, a double turret's NECTAR-turret cell (`mount2`), and the Box
 * Tube, none of which has a flat field of its own.
 *
 * Read through the resolvers (`bbLauncherOf`/`bbLiftOf`), never the raw `bbMech` field, so a
 * spec still on the legacy migration path — no container yet, same archetype — reads as
 * matching a preset that has since been given one explicitly; the two describe the same robot.
 */
function bbMechMatches(spec: RobotSpec, preset: RobotSpec): boolean {
  const sl = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
  const pl = bbLauncherOf(preset, BB_HOOD_DEFAULT_DEG);
  const launcherEq = sl.hoodDeg === pl.hoodDeg && sl.mount2 === pl.mount2;
  const sf = bbLiftOf(spec);
  const pf = bbLiftOf(preset);
  const liftEq = sf === null || pf === null ? sf === pf : sf.mount === pf.mount;
  return launcherEq && liftEq;
}

/**
 * The two detail lines under a preset's name.
 *
 * `meta` is the BUILD, in the same order the builder's own blocks run so a card reads like a
 * summary of the panel below it. `zone` is the MECHANISM LOADOUT — the thing a player actually
 * chooses a card for — given the same emphasis DECODE gives its optimised-range line.
 *
 * Read through `bbLauncherOf`/`bbLiftOf` rather than the raw `scoreMode` field. A single turret
 * aims itself from wherever it is bolted, so naming its cell would be noise; a double turret's
 * two cells and a dumper's firing edge are the point of the build and are named. A Box Tube gets
 * its own segment — same reasoning as `bbConfigSummary` (`labels.ts`): a build that differs from
 * another only by its tube must not print the same line, or the card reads as inert.
 */
export function bbPresetLines(preset: RobotSpec): { meta: string; zone?: string } {
  const launcher = bbLauncherOf(preset, BB_HOOD_DEFAULT_DEG);
  const lift = bbLiftOf(preset);
  const meta = [
    DRIVETRAIN_LABELS[preset.drivetrain],
    `${preset.massLb} lb`,
    `${preset.driveRpm} rpm`,
    `${BB_INTAKE_MOUNT_LABELS[bbIntakeMountOf(preset)]} sweeper`,
    // POLLEN, never "balls" — `docs/biobuzz-contract.md` §6.
    `${preset.ballStorage ?? 0} pollen`,
  ].join(' · ');
  const zoneParts = [
    launcher.kind === 'turret'
      ? BB_MODE_LABELS.turret
      : `${BB_MODE_LABELS[launcher.kind]} · ${bbLauncherMountLabel(launcher)}`,
  ];
  if (lift) zoneParts.push(`${bbLiftKindLabel(lift.kind)} · ${BB_MOUNT_POS_LABELS[lift.mount]}`);
  // 🎯 marks the shooting mechanism, which every build now has.
  return { meta, zone: `🎯 ${zoneParts.join(' · ')}` };
}
