import type { RobotSpec } from '../../types';
import { massLimits } from '../../sim/drivetrain';
import { DRIVETRAIN_LABELS } from '../../ui/labelData';
import { BB_DEFAULT_SCORE_MODE, BB_HOOD_DEFAULT_DEG, BB_PRESETS, BB_STORAGE_MAX, bbMassFloorBump } from './config';
import {
  bbIntakeMountOf,
  bbShooterMountOf,
  isTurreted,
} from './mounts';
import { type BbMechSpec, bbLauncherOf, bbLiftOf } from './mechs';
import {
  BB_INTAKE_MOUNT_LABELS,
  BB_LAUNCHER_NONE_LABEL,
  BB_LIFT_KIND_LABELS,
  BB_MODE_LABELS,
  BB_MOUNT_POS_LABELS,
} from './labels';
import { bbCoerceSpec } from './robotConfig';

/**
 * BIOBUZZ PRESET ROBOTS — the four manufacturer STARTERBOTS, then the archetype demos.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM `config.ts` ────────────────────────
 * `config.ts` holds `BB_PRESETS`, and it has to: `coerce.ts` reads `BB_PRESETS[0]` to build
 * `BB_DEFAULT_SPEC`, and `coerce.ts` is a LEAF — it is a dependency of `src/sim/spawn.ts`'s
 * `coerceSpec`, so it may not import anything that reaches back to the spawn chokepoint.
 * Everything in THIS file does reach it (the match test and the card lines are UI-side, and
 * `massLimits` pulls in the drivetrain model), so the display list lives here and the
 * coercer's base stays where the leaf can see it. `docs/biobuzz-contract.md` §1 puts presets
 * in `robotConfig.ts`; that predates the leaf split and the contract needs the correction.
 *
 * ── THE FOUR STARTERBOTS ────────────────────────────────────────────────────
 * FIRST's four robot ecosystem partners each published a StarterBot for BIOBUZZ. These four
 * cards are those robots, and they are the first four entries so a player meets a real,
 * documented build before an invented one — the same ordering Chain Reaction uses
 * (`CHAIN_REAL_PRESETS`).
 *
 * ⚠️ WHAT IS SOURCED AND WHAT IS NOT. Every manufacturer publishes its DRIVETRAIN topology,
 * its motors and its wheel sizes. NOT ONE of them publishes an overall footprint, a height or
 * a weight — not in the build guide, the product page, or the resource guide. So every
 * dimension and every mass below is `APPROX`, and the honest description of these cards is
 * "manufacturer-INSPIRED", not "manufacturer-accurate". Each entry names its source document
 * AND that document's date, because two of the four sources are PRE-KICKOFF builds that the
 * manufacturer may yet supersede.
 *
 * ── HOW `driveRpm` IS DERIVED (this is not the manufacturer's RPM) ──────────
 * `RobotSpec.driveRpm` is not a real wheel RPM: `SPEED_PER_RPM` is normalised to a 104 mm
 * reference wheel (`src/config.ts`), so the sim's speed is `SPEED_PER_RPM · driveRpm ·
 * speedMult`. Entering a manufacturer's published RPM directly would overstate every one of
 * these robots, because none of them runs a 104 mm wheel. Each entry therefore converts:
 *
 *     free speed (in/s) = π · (wheel_mm / 25.4) · motor_rpm / 60
 *     driveRpm          = free speed / (SPEED_PER_RPM · speedMult)
 *
 * and shows its arithmetic. These are FREE speeds; `SPEED_PER_RPM` already carries a 0.95
 * loaded-efficiency factor, so they remain a few percent optimistic — which is the same
 * optimism every other preset in the repo carries.
 *
 * ── THE MECHANISM LOADOUT (`bbMech`) ────────────────────────────────────────
 * Every build below now carries an explicit `bbMech` rather than leaning on
 * `coerceBiobuzzSpec`'s migration path — an ABSENT container reads as "predates composable
 * mechanisms" and a launcher gets built out of `scoreMode`/`shooterMount` for it (`mechs.ts`,
 * `bbLauncherOf`). For three of the four StarterBots that migration already lands on the right
 * answer, and this file spells it out anyway so the loadout is a fact you can read off the
 * object rather than one you have to trust a coercer to derive. STUDICA is the one build the
 * migration CANNOT express — it assumes every legacy spec has a launcher, and Studica genuinely
 * does not — so `launcher: null` is the only way to say that, and it is the reason this pass
 * exists at all.
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
 * G407 caps CONTROL at FOUR SCORING ELEMENTS, and all four StarterBots are built to it —
 * goBILDA and REV both advertise "up to four POLLEN", and the field stages exactly 4
 * pre-loaded per robot (§10.3.1).
 *
 * Read from `BB_STORAGE_MAX` rather than written as `4` here. When these presets were first
 * authored that constant was still 24 (a volume guess), so this was a local literal saying
 * "the rule, not the ceiling"; the ceiling IS the rule now, and two independent spellings of
 * one number is how they drift apart. If G407 ever changes, it changes in one place.
 */
const BB_G407_CAP = BB_STORAGE_MAX;

/**
 * The four StarterBots, as BUILDS. Mass and the identity fields are filled in below.
 *
 * ⚠️ EVERY `scoreMode` HERE IS THE CLOSEST OF FOUR, NOT A MATCH. `BB_SCORE_MODES` is
 * `turret | twinturret | drum | dumper`, and NONE of the four StarterBots is turreted: three
 * carry a chassis-fixed launcher that fires ONE element at a time (two friction-wheel
 * flywheels and one elastic catapult), and `drum` streams a parallel line while `dumper`
 * heaves the whole hopper. The archetype set is the wrong shape for this game's real robots,
 * and the fix is the modular mechanism work, not a better guess here. Each entry says which
 * mechanism it actually wants.
 */
const BB_STARTER_BUILDS: readonly RobotSpec[] = [
  {
    // ── goBILDA FTC StarterBot ────────────────────────────────────────────
    // Source: goBILDA FTC Starter Bot Resource Guide (SKU 3200-2627-0003), kit 3200-4008-2627,
    // read 2026-09-12. Drop-center 6WD: 4 driven 96 mm Hogback traction wheels (3626-0014-0096,
    // 50A) chained 1:1 per side, plus 2 undriven 96 mm omni at the dropped centre. 2× 5203
    // Yellow Jacket 19.2:1 (5203-2402-0019, 312 rpm) drive; 1× 5203 50.9:1 (117 rpm) runs the
    // intake through a 1:5 mesh; a fourth Yellow Jacket carries the "1:1 Conversion Kit for
    // 19.2:1 Ratio Gearbox" (5105-0208-0019) — the part that exists to make a ~6000 rpm
    // direct-drive flywheel — spinning two 72 mm GripForce Gecko wheels.
    //   driveRpm: π·(96/25.4)·312/60 = 61.7 in/s ÷ (0.20367 · 1.06 tank) = 286
    // WANTS: a chassis-fixed single-barrel FLYWHEEL, sequential. `drum` is the nearest.
    name: 'goBILDA StarterBot', teamName: 'Gecko flywheel · 6WD drop-center', teamNumber: 0,
    length: 15, width: 16, // APPROX — 384 mm (15.1") side rails; width unpublished
    intake: 'sloped', massLb: 0, drivetrain: 'tank',
    driveRpm: 286, flywheelInertia: 0.5, canSort: false, // inertia APPROX: 1:1 Yellow Jacket
    scoreMode: 'drum',
    intakeMount: 'front', shooterMount: 'front',
    ballStorage: BB_G407_CAP,
    // LOADOUT: a chassis-fixed launcher (the WANTS mechanism above, nearest-archetyped as
    // `drum`), no lift — this StarterBot's manual shows no vertical mechanism at all.
    bbMech: { launcher: { kind: 'drum', mount: 'front', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null },
    assists: { ...BB_STARTER_ASSISTS },
  },
  {
    // ── REV DUO FTC Starter Bot ───────────────────────────────────────────
    // Source: revrobotics.com/duo/ftc-starter-bot/ full build guide, read 2026-09-12. REV
    // "Channel Drivetrain" 6WD: 90 mm traction front, 90 mm omni dropped centre, 90 mm grip
    // rear, #25 chain per side. 2× HD Hex (REV-41-1291) through UltraPlanetary 5.23:1 × 3.61:1
    // = 18.88:1 → 6000/18.88 = 318 rpm. Intake is two counter-rotating flap-roller shafts (8
    // flaps) on a Core Hex (REV-41-1300, 72:1). Launcher is ONE flywheel — two 90 mm Grip
    // wheels on an HD Hex at 1:1, so ~6000 rpm — fed by a Smart Servo gate.
    //   driveRpm: π·(90/25.4)·318/60 = 59.0 in/s ÷ (0.20367 · 1.06) = 273
    // WANTS: the same chassis-fixed FLYWHEEL. Heaviest flywheel of the four ⇒ highest inertia.
    // It also carries a servo "Pollen Poker" boom for combing POLLEN out of a FLOWER, which
    // no mechanism in this sim can express yet.
    name: 'REV DUO StarterBot', teamName: 'Single flywheel · 6WD channel', teamNumber: 0,
    // ⚠️ CLAMPED BY THE SIM, NOT BY REV. The 408 mm rails are 16.1", and the longest chassis
    // this sim can express is 15" — `INTAKE_PRESETS.sloped.maxLength`, which `bbSizeLimits`
    // intersects with the BIOBUZZ envelope. So this robot is modelled an inch shorter than it
    // is built. The 248 mm (9.8") cross-member is the DRIVETRAIN width and sits under
    // `BB_MIN_WIDTH` (14.5), so the width here is the built-up robot rather than the frame.
    length: 15, width: 15,
    intake: 'sloped', massLb: 0, drivetrain: 'tank',
    driveRpm: 273, flywheelInertia: 0.7, canSort: false, // inertia APPROX: HD Hex at 1:1
    scoreMode: 'drum',
    intakeMount: 'front', shooterMount: 'front',
    ballStorage: BB_G407_CAP,
    // LOADOUT: same chassis-fixed launcher as goBILDA, no lift — the "Pollen Poker" boom this
    // manual also describes is a FLOWER-combing tool no mechanism in this sim can express yet
    // (see the WANTS note above), so it is not modelled as a lift; a lift PLACES, it does not comb.
    bbMech: { launcher: { kind: 'drum', mount: 'front', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null },
    assists: { ...BB_STARTER_ASSISTS },
  },
  {
    // ── AndyMark Robits BIOBUZZ StarterBot ────────────────────────────────
    // Source: andymark.com/pages/2026-2027-robits-starterbot-base + the Robits BIOBUZZ
    // StarterBot User Manual and the published teleop source, read 2026-09-12. The teleop
    // configures exactly `left_drive`, `right_drive`, `catapult`, two CR servos and one servo
    // — a 2-motor skid-steer, belt-driven, on mixed omni + Stealth wheels. The manual offers
    // 13.7:1 (speed) or 19.2:1 (torque) and does not say which the kit ships; the torque
    // option is taken here as the conservative read. A mecanum STEP variant also exists.
    //   driveRpm: π·(101.6/25.4)·312/60 = 65.3 in/s ÷ (0.20367 · 1.06) = 303
    //   (the 13.7:1 option would be ≈425 — swap the ratio and this becomes a much faster bot)
    // The launcher is a COAXIAL FLINGER: one NeveRest 50.9:1 (am-5443) winds an elastic arm and
    // releases it, continuously, with an ADJUSTABLE HOOD that sets the release angle. Storage
    // is a passive gravity ramp.
    // WANTS: an elastic CATAPULT with a hood-angle dial. `dumper` is the nearest of four and
    // is wrong in the way that matters — a dumper throws the whole hopper, this fires singly.
    name: 'AndyMark Robits', teamName: 'Elastic catapult · skid-steer', teamNumber: 0,
    length: 15, width: 15.5, // APPROX — AndyMark publishes no frame dimensions at all
    intake: 'sloped', massLb: 0, drivetrain: 'tank',
    driveRpm: 303, flywheelInertia: 0.1, canSort: false, // inertia APPROX: bands, not a wheel
    scoreMode: 'dumper',
    intakeMount: 'front', shooterMount: 'front',
    ballStorage: BB_G407_CAP,
    // LOADOUT: a chassis-fixed launcher (nearest-archetyped as `dumper` per the WANTS note —
    // wrong in the way that matters, since this fires singly and a dumper heaves the whole
    // hopper), no lift — a passive gravity ramp is storage, not a second mechanism.
    bbMech: { launcher: { kind: 'dumper', mount: 'front', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null },
    assists: { ...BB_STARTER_ASSISTS },
  },
  {
    // ── Studica Starter Bot ───────────────────────────────────────────────
    // Source: Studica "Pre-Kickoff FTC Starter Kit 2026-27 Build Guide", rev 0.1, dated
    // 2026-05-04, read 2026-09-12. ⚠️ THIS IS THE ONLY PRE-KICKOFF SOURCE IN THE SET, and
    // Studica labels it a training reference, "not a guide to build an official competition
    // robot for the 2026-27 BIOBUZZ season". It is a DRIVETRAIN AND AN INTAKE: no launcher,
    // no lift, no FLOWER tool. As of kickoff day no post-kickoff Studica build has shipped.
    //
    // Two things about this card are honest placeholders — one of them WAS a fact this file
    // could not yet state and now is:
    //  • `bbMech.launcher: null` — Studica publishes NO launcher, and this is the shape that
    //    finally says so directly, rather than borrowing `dumper` because the spec used to
    //    require an archetype whether or not the robot had one. `scoreMode`/`shooterMount`
    //    stay set to `dumper`/`front` below — not because that is what this robot carries, but
    //    because they are now a MIRROR (`mechs.ts`, `RobotSpec.bbMech`'s header): the nearest
    //    single archetype an OLDER peer, which has never heard of `bbMech` and drops it on the
    //    wire, can still render this build as. A peer that understands `bbMech` reads
    //    `launcher: null` and draws no launcher at all — which is the real robot.
    //  • `driveRpm` — the real figure is BELOW WHAT THE SIM CAN EXPRESS. 2× Maverick 50.9:1
    //    (75001-509) at 119.84 rpm through a 1:1 bevel on 100 mm wheels is
    //      π·(100/25.4)·119.84/60 = 24.7 in/s ÷ (0.20367 · 1.06) = driveRpm 114,
    //    and `DRIVETRAIN_LIMITS.tank.minRpm` is 200. 200 is the floor, so this card drives
    //    about 1.75× faster than the real robot. Widening the floor is a shared-model change
    //    and not Lane B's to make.
    // Size is likewise clamped: the 336 × 192 mm (13.2" × 7.6") rails are under both floors.
    name: 'Studica Starter Bot', teamName: 'Base build · no launcher published', teamNumber: 0,
    length: 13.5, width: 14.5, // the BB floors; the real frame is smaller than the sim allows
    intake: 'sloped', massLb: 0, drivetrain: 'tank',
    driveRpm: 200, flywheelInertia: 0.1, canSort: false, // 200 = floor, real value is 114
    scoreMode: 'dumper',
    intakeMount: 'front', shooterMount: 'front',
    ballStorage: BB_G407_CAP,
    // LOADOUT: the whole point of this pass. `launcher: null` is a real, legal, shipping
    // build — a StarterBot with a drivetrain and an intake and nothing above the deck.
    bbMech: { launcher: null, lift: null },
    assists: { ...BB_STARTER_ASSISTS },
  },
] as const;

/**
 * The StarterBots, with MASS derived rather than typed and the whole build run through the
 * ONE coercion chokepoint.
 *
 * MASS. None of the four manufacturers publishes a weight, so inventing four numbers would be
 * four lies with a decimal point. The mass FLOOR is the honest answer instead: it is what the
 * sim already believes a given drivetrain plus its mechanisms has to weigh, it moves when
 * those constants move, and it is the same choice Chain Reaction makes for its five real
 * robots.
 *
 * COERCION. A card must be a fixed point of `coerceSpec` or it can never read as selected —
 * the builder compares against a spec that has been through the coercer, so a card carrying
 * anything the coercer would touch is a card that never lights up. Rather than hand-maintain
 * that property across a dozen fields, the builds are DEFINED as their own coerced form. Two
 * things this catches that a literal cannot: the legacy `intakeSide` / `shooterRear` mirrors
 * (which `coerceBiobuzzSpec` writes and no literal above declares), and any dial that drifts
 * outside its range when a shared constant moves — the build simply becomes the legal one
 * instead of becoming a silently-dead card. Idempotence makes this sound, and smoke asserts
 * both halves.
 */
export const BB_STARTER_BOTS: readonly RobotSpec[] = BB_STARTER_BUILDS.map((s) =>
  bbCoerceSpec({ ...s, massLb: massLimits(s.drivetrain, s.flywheelInertia, bbMassFloorBump(s)).min }),
);

/** how many leading entries of `BB_PRESET_LIST` are real, documented robots. The builder rules
 * off after these so "a real team's robot" is visibly a different kind of thing from "what a
 * drum shooter feels like". Mirrors `CHAIN_REAL_PRESETS`. */
export const BB_REAL_PRESETS = BB_STARTER_BOTS.length;

/**
 * A LIFT for exactly one archetype demo, keyed by NAME.
 *
 * The four archetype demos (Sniper / Hauler / Drummer / Skimmer) are DEFINED in `config.ts`,
 * not here — `BB_PRESETS` is a dependency of the leaf `coerce.ts` (it reads `BB_PRESETS[0]` to
 * build `BB_DEFAULT_SPEC`; see that file's own header), so it cannot move into this file
 * without dragging a spawn-chokepoint import into a leaf. A lift is therefore attached at THIS
 * boundary instead — the display list this file already owns — rather than by editing the
 * literal. Three of the four demos need nothing here at all: a bare `scoreMode` +
 * `shooterMount` already migrates to the matching launcher (`bbLauncherOf`'s legacy path,
 * which assumes a legacy spec HAS a launcher — true of all three). Only a LIFT has no such
 * path — nothing has ever modelled one, so `bbLiftOf` never migrates one into existence — which
 * is why this map exists and has exactly one entry.
 *
 * SNIPER is the one that gets it. It is the only demo built on a TURRET, and a turret already
 * aims itself into the HIVE at any elevation (its own pitch axis, not a lift, solves that) —
 * so pairing it with a LIFT is the one combination that puts BOTH of this game's targets one
 * click away: the FLOWER's top ring sits at 21.5 in, inside R105's 29 in cap, so a carriage can
 * PLACE into it; the HIVE's up-CELL opens at 53.5 in, past that same cap, so nothing but a
 * LAUNCH ever reaches it (`BB_R105_HEIGHT_CAP`, `config.ts`). Keyed by NAME rather than array
 * index so a reordering of `BB_PRESETS` cannot silently hand the lift to the wrong card.
 */
const BB_DEMO_LIFT: Partial<Record<string, BbMechSpec['lift']>> = {
  Sniper: { kind: 'vslide', mount: 'back', maxZ: 22 }, // APPROX: clears the FLOWER's 21.5 with headroom; nowhere near the HIVE's 53.5
};

/**
 * What the builder's `Presets` section offers: the four StarterBots, then the four archetype
 * demos already in `config.ts`.
 *
 * The demos are NOT dropped. They exist to demonstrate every mount and every archetype in one
 * click, which the StarterBots cannot do — all four of those are front-intake, front-launcher
 * skid-steer robots, because that is what a rookie kit builds.
 *
 * The demos are coerced here too, for the same reason the StarterBots are: `BB_PRESETS` is
 * built for `coerce.ts` to take its default from, not for a picker to compare against, and it
 * carries no legacy mirror fields. Coercing at the display boundary is what makes every card
 * in this list — real or demo — a fixed point. `BB_DEMO_LIFT`'s one entry rides through the
 * same coercion, so the lift it adds is clamped and mount-resolved exactly as a Builder edit
 * would be — never a hand-placed exception to the fixed-point rule.
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
 * energy and it is a real dial here, and it is the only field separating two otherwise
 * identical flywheel StarterBots.
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
 * Does the MECHANISM LOADOUT match — the half of the comparison above `scoreMode`/
 * `shooterMount` cannot see. Those two still distinguish every ARCHETYPE, but a coerced
 * launcher-less build mirrors to a `scoreMode` like any other (Studica's `dumper` — see its
 * entry above), so on `scoreMode` alone it would read as matching a `dumper` build that has a
 * real launcher. And neither flat field says anything about a LIFT, which has none of its own.
 *
 * Read through the resolvers (`bbLauncherOf`/`bbLiftOf`), never the raw `bbMech` field, so a
 * spec still on the legacy migration path — no container yet, same archetype — reads as
 * matching a preset that has since been given one explicitly; the two describe the same robot.
 */
function bbMechMatches(spec: RobotSpec, preset: RobotSpec): boolean {
  const sl = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
  const pl = bbLauncherOf(preset, BB_HOOD_DEFAULT_DEG);
  const launcherEq = sl === null || pl === null ? sl === pl : sl.hoodDeg === pl.hoodDeg;
  const sf = bbLiftOf(spec);
  const pf = bbLiftOf(preset);
  const liftEq = sf === null || pf === null ? sf === pf : sf.mount === pf.mount && sf.maxZ === pf.maxZ;
  return launcherEq && liftEq;
}

/**
 * The two detail lines under a preset's name.
 *
 * `meta` is the BUILD, in the same order the builder's own blocks run so a card reads like a
 * summary of the panel below it. `zone` is the MECHANISM LOADOUT — the thing a player actually
 * chooses a card for — given the same emphasis DECODE gives its optimised-range line.
 *
 * Read through `bbLauncherOf`/`bbLiftOf` rather than the raw `scoreMode` field, so a
 * launcher-less build (Studica) reads as exactly that instead of as whatever archetype its
 * legacy MIRROR happens to carry — a Studica card printing "🎯 Dumper · FRONT" would be lying
 * about the one thing this preset exists to say. A turret is top-mounted and aims itself, so
 * naming its mount would be noise; a turretless launcher's firing edge is the whole point of
 * the build and is named. A LIFT, when the build has one, is a SECOND real mechanism and gets
 * its own segment — same reasoning as `bbConfigSummary` (`labels.ts`): a build that differs
 * from another only by its lift must not print the same line, or the card reads as inert.
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
  const launcherPart = !launcher
    ? BB_LAUNCHER_NONE_LABEL
    : isTurreted(launcher.kind)
      ? BB_MODE_LABELS[launcher.kind]
      : `${BB_MODE_LABELS[launcher.kind]} · ${BB_MOUNT_POS_LABELS[launcher.mount]}`;
  const zoneParts = [launcherPart];
  if (lift) zoneParts.push(`${BB_LIFT_KIND_LABELS[lift.kind]} · ${BB_MOUNT_POS_LABELS[lift.mount]}`);
  // 🎯 marks an actual shooting mechanism; a launcher-less build gets no bullseye to live up to.
  return { meta, zone: launcher ? `🎯 ${zoneParts.join(' · ')}` : zoneParts.join(' · ') };
}
