import type { ControlBindings } from './input/bindings';
import type { GameId, Physics } from './games/types';
import type { ChainState } from './games/chain/state';
import type { BiobuzzState } from './games/biobuzz/state';
import type { BbMechSpec } from './games/biobuzz/mechs';
export type { GameId, Physics } from './games/types';

export type Alliance = 'red' | 'blue';
/** DECODE artifacts are purple/green; BIOBUZZ POLLEN is yellow and NECTAR carries its alliance
 * colour. One union, so the renderer and the hopper HUD read one field. */
export type ArtifactColor = 'purple' | 'green' | 'yellow' | 'red' | 'blue';
export type Motif = readonly [ArtifactColor, ArtifactColor, ArtifactColor];

export type GameMode = 'match' | 'free';

export interface Vec2 {
  x: number;
  y: number;
}

/** Per-tick, per-robot, serializable driver command. Translation is in the
 * DRIVER frame (screen frame): +y = away from the driver, +x = driver's right.
 * Robot configuration (drive style, assists) is menu-only, not keybinds. */
export interface RobotCommand {
  driveX: number; // -1..1
  driveY: number; // -1..1
  rotate: number; // -1..1, CCW positive in driver frame
  leftDrive: number; // -1..1, for tank drive (left side)
  rightDrive: number; // -1..1, for tank drive (right side)
  intake: boolean;
  fire: boolean;
  /** Chain Reaction: pick up a nearby ring / place a carried ring on a hook. Edge-
   * triggered in the sim (acts once per press). Optional (DECODE omits it). */
  catalyst?: boolean;
  /** BIOBUZZ, Box Tube: PLACE one held NECTAR into the FLOWER the robot's placement point is
   * near (`bbPlacePointLocal`). EDGE-triggered — a held button places once. Protocol bit 32,
   * which used to be the removed hold-to-raise `bbLift`; BIOBUZZ is alpha-only and version-gated,
   * so the bit is reused rather than burning the last spare one. Optional; absent reads false. */
  bbPlaceNectar?: boolean;
  /** BIOBUZZ, Box Tube: PLACE one held POLLEN into the FLOWER in reach. Edge-triggered.
   *
   * ITS OWN BUTTONS (one per element kind) rather than reusing `fire`: a robot's fire button
   * always launches, and overloading it by proximity would be a mode with no on-screen
   * transition. */
  bbPlace?: boolean;
  /** BIOBUZZ, the HUMAN PLAYER button: put ONE NECTAR from the alliance's own stock into the
   * alliance's own LOADING ZONE (G426). Edge-triggered in the sim, like `catalyst`.
   *
   * It is a DRIVER ACTION and not a drip, because the human player is a person standing at
   * the wall waiting for a cue, not a timer: the sim used to enter nectar on its own clock,
   * which meant the one thing a drive team actually decides about their entitlement — WHEN to
   * spend it — was decided for them. Either robot of the alliance may press it; the rule is
   * per ALLIANCE, so the two share one entitlement counter.
   *
   * Optional: every DECODE and CR command, and every replay recorded before this, omits it. */
  bbNectar?: boolean;
  /** Chain Reaction, LAUNCHER catalyst: THROW the carried ring downfield from the catapult.
   * Its own button so it is never ambiguous with the claw's grab/place. Edge-triggered in
   * the sim. Optional (old clients/replays omit it). */
  fling?: boolean;
  /** BUTTERFLY drivetrain: drop the other wheel set (tank ⇄ mecanum). Edge-triggered
   * in the sim like `catalyst`, so a held button flips once. Ignored by every other
   * drivetrain. Optional (old clients/replays omit it). */
  driveMode?: boolean;
  /** BIOBUZZ, the `ramp` intake archetype: drop / fold the deployable ramp. EDGE-triggered like
   * `driveMode` (a held button toggles once, off `RobotState.bbRampHeld`); ignored by every
   * other intake. Protocol bit 256 — the first button past the old uint8 (`src/net/protocol.ts`).
   * Optional; absent reads false. */
  bbRamp?: boolean;
  /**
   * BIOBUZZ, PASS TO YOUR PARTNER: launch the held element at a POINT ON THE FIELD rather than
   * at your own hive. Edge-triggered like `fire`, and it needs a launcher — an intake-only build
   * has nothing to throw with.
   *
   * ⚠️ **THE TARGET IS A POINT, NOT YOUR PARTNER.** Owner, 2026-09-21: "in real life, you can't
   * know where your opponent is accurately. So, people should be able to choose a point to shoot
   * towards, but there should also be a simple preset." A pass that TRACKED the partner's robot
   * would be an aimbot for a thing a real driver has to eyeball, so the sim never reads the
   * partner's pose: it solves to `RobotSpec.bbPassTarget` if the player set one, and otherwise to
   * their own alliance's LOADING ZONE, which is a fixed, named, point-symmetric spot
   * that both halves of an alliance already know. Protocol bit 512 — the next one past `bbRamp`. Optional; absent reads false.
   */
  bbPass?: boolean;
  /**
   * DECODE, a flywheel built with SPEED PRESETS (`RobotSpec.flywheel.mode === 'presets'`): step to
   * the next preset setpoint, wrapping (BIOBUZZ's fixed launcher runs one setpoint). EDGE-triggered and debounced like `driveMode`
   * (`RobotState.flyPresetHeld`); ignored by every other build. Protocol bit 1024. Optional; absent
   * reads false.
   */
  flyPreset?: boolean;
}

/**
 * A FLYWHEEL WITH A SETPOINT (`src/sim/flywheel.ts`) — the speed half of a launcher that does not
 * solve its own speed per shot. Absent on a spec = today's solved speed (`auto`).
 *
 *   • `fixed`   — one setpoint, `rpm[0]`, whatever the range.
 *   • `presets` — up to three setpoints the driver steps through (`RobotCommand.flyPreset`).
 *
 * The artifact leaves at `FLY_EXIT_EFFICIENCY · π · wheelMm · rpm / 60` (in/s), where `rpm` is what
 * the wheel is doing when the feeder runs, not the setpoint. `feedS` is the feeder's time per shot.
 * Clamped in `coerceFlywheel`.
 */
export interface FlywheelSpec {
  mode: 'fixed' | 'presets';
  /** wheel setpoints, rpm: one for `fixed`, one to three for `presets` */
  rpm: number[];
  /** flywheel wheel diameter, mm */
  wheelMm: number;
  /** feeder time per shot, s */
  feedS: number;
}

/** menu-configured driver assists */
export interface AssistConfig {
  fieldCentric: boolean;
  aimAssist: boolean;
  autoIntake: boolean;
  autoFire: boolean;
}

/** `none` is DECODE only: no intake, the human player loads the robot by hand in its LOADING
 *  ZONE (G432). Chain Reaction and BIOBUZZ coerce it to `sloped`. */
export type IntakeStyle = 'sloped' | 'vector' | 'triangle' | 'none';
export type DrivetrainType = 'mecanum' | 'tank' | 'swerve' | 'xdrive' | 'butterfly';

export interface RobotSpec {
  /** robot display name, team name, team number (0 = unset) */
  name: string;
  teamName: string;
  teamNumber: number;
  /** chassis length (front-back) and width, inches; chassis + intake reach must fit 18in */
  length: number;
  width: number;
  intake: IntakeStyle;
  /** mass in lb (20–42): heavier shoves harder, accelerates slower */
  massLb: number;
  drivetrain: DrivetrainType;
  /** wheel RPM abstraction (200–600): top speed up, acceleration down.
   * For BUTTERFLY this is the MECANUM-mode gearing; `tankRpm` is the other set. */
  driveRpm: number;
  /** BUTTERFLY only: the TANK-mode wheel RPM. A butterfly carries two independently
   * geared wheel sets, so it gets its own slider — teams routinely gear the traction
   * set for torque and the mecanum set for speed. Range is the TANK envelope
   * (`butterflyTankRpmLimits`), which is torque-biased and tops out lower than the
   * mecanum one. Optional so every non-butterfly spec omits it (defaulted in
   * `coerceSpec`, which also clamps it). */
  tankRpm?: number;
  /** 0–1: high inertia keeps rapid fire fast on long (high-speed) shots;
   * low inertia is quick up close but recovers slowly after far shots */
  flywheelInertia: number;
  /** robot can pick which hopper color to fire (chases the motif) */
  canSort: boolean;
  /** DRIVER ASSISTS saved WITH THE ROBOT — BOTH games. Drive frame (field/robot-centric)
   * plus the aim/intake/fire automation. They live on the spec so they travel with
   * everything a spec travels with: saved robot slots, the per-game loadout `switchGame`
   * swaps, presets, and account sync — rather than being a separate global preference.
   * EVERY assist DEFAULTS ON (`PLAYER_ASSISTS` in sim/spawn.ts).
   * This is the STORED preference. The sim still reads the resolved `RobotSetup.assists`
   * (which the UI fills from here), so the spawn seam and the wire are unchanged.
   * Optional so old saves omit it (defaulted in `coerceSpec`). */
  assists?: AssistConfig;
  /** SUPPORTER COSMETIC: a `CHASSIS_COLORS` key for the chassis fill. Purely
   * decorative — the alliance is carried by the OUTLINE, never this — and
   * optional, so every existing spec, save, and replay stays valid. */
  chassisColor?: string;
  /** COSMETIC: an `ACCENT_KEYS` key for the wheels/rollers fill (`'match'` follows
   * the chassis). Closed set, `src/cosmetics.ts`; optional so every existing spec,
   * save, and replay stays valid. */
  accent?: string;
  /** COSMETIC: a `DECAL_KEYS` key for the vector shape drawn over the chassis
   * fill, under the alliance outline. Closed set, `src/cosmetics.ts`; optional so
   * every existing spec, save, and replay stays valid. */
  decal?: string;
  /** COSMETIC: a `PLATE_KEYS` key for the frame drawn around the sign placard —
   * the placard's own fill stays alliance. Closed set, `src/cosmetics.ts`;
   * optional so every existing spec, save, and replay stays valid. */
  plate?: string;
  /** Chain Reaction: how many Particles the robot's hopper holds (1–30 slider).
   * Optional so DECODE specs/old saves omit it (defaulted in coerceSpec). */
  ballStorage?: number;
  /** Chain Reaction: ground clearance in inches (slider). Must be ≥ a beam's height
   * to drive over it, but more clearance RAISES the center of gravity → sluggish
   * handling. Optional (defaulted in coerceSpec). */
  groundClearance?: number;
  /** Chain Reaction: the SCORING archetype (the robot's expansion mechanism).
   *  • 'turret' — a dye-rotor + turreted single-shooter: indexes Particles ONE at a
   *    time and launches them into the Accelerator from ANYWHERE (auto-aimed arc).
   *  • 'dumper' — no shooter: drive up to the Accelerator mouth and DUMP the whole
   *    hopper at once (huge burst, but zero range — you must cycle to the wall).
   * Optional (defaulted in coerceSpec). */
  scoreMode?: ChainScoreMode;
  /** Chain Reaction: the intake DESIGN. For now the only option is the full-width sweeper
   *  ('sweeper') — a roller spanning the whole chassis width that gulps Particles on contact.
   * Optional (defaulted in coerceSpec). */
  chainIntake?: ChainIntakeStyle;
  /** Chain Reaction: which chassis edge(s) the sweeper rollers ride on. Same roller, different
   * position — it moves the CAPTURE band AND the collision footprint together. Open edges cost
   * hopper volume ⇒ lower storage cap (see `chainStorageMax`). Optional (defaulted in
   * coerceSpec, which also migrates the legacy `intakeSide` flag). */
  intakeMount?: ChainIntakeMount;
  /** Chain Reaction: which chassis edge the drum/dumper launcher fires over. The robot turns
   * THAT edge to the goal to shoot. No effect on a turret (top-mounted). Optional (defaulted in
   * coerceSpec, which also migrates the legacy `shooterRear` flag). */
  shooterMount?: ChainShooterMount;
  /** Chain Reaction: the CATALYST mechanism archetype (arm / launcher / turret). Optional
   * (defaulted in coerceSpec). */
  catalystType?: ChainCatalystType;
  /** Chain Reaction: where on the chassis the catalyst mechanism is BOLTED. Optional
   * (defaulted in coerceSpec). */
  catalystMount?: ChainCatalystMount;
  /**
   * Chain Reaction: the mechanism is on a SWING — one arm on a pivot that rotates between
   * two working ends, so it serves both without turning the chassis — and WHICH WAY it
   * swings. Absent ⇒ it does not swing.
   *
   *   'fb' — front↔back: the classic swing, reaching over both ends
   *   'lr' — left↔right: the same arm turned 90°, reaching over both flanks
   *
   * SEPARATE from the mount on purpose. The swing used to BE a mount (`'frontback'`, welded
   * to the centre cell), which made "a swing" and "on the right" mutually exclusive choices
   * in one picker — so a fore-aft swing arm bolted to the right rail, a real build, could not
   * be expressed at all. The mount now says where the pivot IS and this says how it MOVES,
   * which is also what makes the two axes possible: which positions a pivot can use follows
   * from the direction it swings (see `SWING_MOUNTS`). Legacy `true` reads as 'fb'. */
  catalystSwing?: ChainSwingAxis;
  /** Chain Reaction, LAUNCHER archetype only: the fixed YAW the catapult is bolted at,
   * in DEGREES relative to chassis forward (−180..180, 15° steps). The catapult is NOT on
   * a turret — it throws wherever the chassis is pointed plus this offset — so which way
   * you mount it is a real build decision, and it is INDEPENDENT of the claw's mount edge.
   * Optional (defaulted in coerceSpec). */
  catapultYaw?: number;
  /** Chain Reaction, LAUNCHER archetype only: how far the catapult is built to throw, in
   * INCHES (the nominal range; the actual landing scatters around it). A longer throw
   * needs more stored energy, so it costs weight and takes longer to re-cock. Optional
   * (defaulted in coerceSpec). */
  catapultRange?: number;
  /** @deprecated superseded by `intakeMount`. Kept so older saves migrate and older peers/
   * servers (which only know this flag) still see the closest equivalent — `coerceSpec`
   * MIRRORS it from `intakeMount`. Never read it directly; use `intakeMountOf`. */
  intakeSide?: boolean;
  /** @deprecated superseded by `shooterMount` (same mirroring contract as `intakeSide`).
   * Never read it directly; use `shooterMountOf`. */
  shooterRear?: boolean;
  /**
   * BIOBUZZ: the robot's MECHANISM LOADOUT — a launcher, a vertical extension slide, either,
   * both, or neither. See `src/games/biobuzz/mechs.ts` for the vocabulary and the mount-clash
   * rule; `coerceBiobuzzSpec` validates and mounts it.
   *
   * ⚠️ IT IS A CONTAINER, AND THE CONTAINER IS LOAD-BEARING. `bbMech === undefined` means "a
   * spec written before mechanisms were composable — migrate it from `scoreMode`", while
   * a stored `bbMech.launcher === null` is an OLD launcher-less save: a launcher is MANDATORY
   * (owner ruling 2026-09-12), so both migrate from the flat `scoreMode`/`shooterMount` mirror,
   * which the shared pass in `coerceSpec` always writes.
   *
   * `scoreMode` / `shooterMount` above stay real, primary fields for CHAIN REACTION and become
   * MIRRORS for BIOBUZZ, kept in step by the coercer so a spec routed through an older peer or
   * server (which drops fields it does not know) returns as the nearest hardware it can name.
   */
  bbMech?: BbMechSpec;
  /**
   * BIOBUZZ, WHERE `bbPass` THROWS — a field point in inches, or ABSENT for the preset.
   *
   * It is on the SPEC and not in `GameSettings` for the reason every other sim input is: the
   * sim may not read a preference. A setup crosses the wire and seeds the world, so the server
   * and every client solve the same arc from the same number; a value read out of localStorage
   * at launch time would make one client's pass land somewhere else and reconcile with a snap.
   *
   * ABSENT MEANS "USE THE PRESET", and absent is the default: `bbPassPoint`
   * (`games/biobuzz/play.ts`) falls through to `bbPassPreset` below, so a player who never opens
   * the setting still has a working pass and the field stays off the wire for everyone who has
   * not moved it. Clamped into the field (and dropped when either component is not finite) by
   * `coerceBiobuzzSpec`.
   *
   * ⚠️ THIS IS THE MAP PICK. `bbPassPreset` is the NAMED choice; this is the arbitrary point
   * somebody dropped on the field map, and it WINS when both are set — a custom pick is a more
   * specific instruction than a preset, and the picker clears it when a preset is chosen again.
   */
  bbPassTarget?: Vec2;
  /**
   * BIOBUZZ: WHICH NAMED PASS PRESET, when `bbPassTarget` is not set
   * (`games/biobuzz/passTargets.ts`). Absent is `BB_PASS_PRESET_DEFAULT` — `pastGoal`, just
   * beyond the thrower's own hive on the far side from wherever it is standing, which is what
   * the owner asked a pass to mean (2026-09-22: "passing towards the other side of the goal").
   *
   * A STRING ID, never a point: the ids are a closed set the coercer folds unknown values onto,
   * so a preset's geometry can be re-tuned without rewriting every saved robot, and an old
   * replay keeps meaning what it meant. Same reasoning as the cosmetic axes.
   */
  bbPassPreset?: string;
  /**
   * BIOBUZZ 3D PHYSICS ONLY (Day 1 seam, `docs/biobuzz/plan-3d.md` §2.4/§3.3): the robot's
   * height in inches (12..18, absent 14) — see `BB3_HEIGHT_MIN`/`_DEFAULT`/`_MAX` in
   * `src/games/biobuzz/config.ts`, R105.A's vertical dimension of the expansion prism. The 2D
   * pipeline ignores it entirely; `sim3d/robot3d.ts` extrudes the chassis collider to it.
   * Clamped (and dropped when not a finite number) in `coerceBiobuzzSpec`.
   */
  heightIn?: number;
  /**
   * BIOBUZZ 3D ONLY (Day 3, R102): the height the robot STOWS to at the start, when it is built
   * taller than the 18-in cube. Optional and DECLARED — `bbStowHeightIn` reads it structurally,
   * `coerceBiobuzzSpec` normalises it to [BB3_HEIGHT_MIN, heightIn] and deliberately does not
   * clamp it to 18 (the RULE refuses at `startLegal`; clamping would make it true by construction).
   */
  stowHeightIn?: number;
  /**
   * IMPORTED ROBOT (`docs/robot-import-plan.md` §3.1): the measured geometry of a robot the
   * player imported from CAD. Absent on every standard robot, and every sim branch that reads it
   * runs only when it is present, so standard robots step byte-identically. An imported spec
   * still carries the ordinary parametric fields (`length`/`width` = the hull's bounding box,
   * `massLb`, `driveRpm`, the game's mechanism fields), so a reader that knows nothing about
   * imports sees a legal rectangle robot. Sanitised by `coerceImported` (`src/sim/imported.ts`).
   */
  imported?: ImportedRobot;
  /**
   * DECODE: how the launcher is AIMED. Absent (or `'turret'`) is the turret every DECODE robot has
   * always had; `'fixed'` is bolted to the chassis, firing along the chassis heading (an import:
   * along `imported.mech.shooterYawDeg`), so the driver — or aim assist, while fire is held —
   * turns the robot to aim. Only `'fixed'` is ever stored (`coerceSpec`).
   */
  launcher?: 'turret' | 'fixed';
  /**
   * DECODE: a FIXED HOOD, degrees above level (20..80). Absent = the adjustable hood that solves its
   * own elevation per shot. BIOBUZZ keeps its hood on `bbMech.launcher.hoodDeg`.
   */
  hoodDeg?: number;
  /**
   * DECODE and BIOBUZZ: a flywheel run at a SETPOINT rather than at a speed solved per shot. Absent
   * = solved (DECODE's `auto`). BIOBUZZ carries it only on the `fixed` launcher kind. See
   * `FlywheelSpec`.
   */
  flywheel?: FlywheelSpec;
}

/**
 * The sim descriptor of an imported robot. Robot-local inches, +x forward, +y left, origin at
 * the wheelbase centre (the hull's bounding-box centre when wheels are unknown). Plain numbers
 * only, no free text: it rides the roster, `matchStart` and replay setups like any spec field.
 */
export interface ImportedRobot {
  v: 1;
  /** library id, 16 lowercase hex chars. Names the mesh on the owner's device; never read by
   *  the sim. */
  id: string;
  /** whole-robot footprint seen from above in the starting configuration: convex, CCW, 3..16
   *  vertices, quantised to 1/64 in, bounding box within 18 × 18 in. */
  hull: Vec2[];
  /** top of the model above the floor, inches, (0, 18]. */
  heightIn: number;
  /** wheel contact points FL, FR, BL, BR, each inside the hull. Absent = the rectangle default. */
  wheels?: Vec2[];
  /** 3D only: up to 5 stacked convex prisms for the tall parts (z0 < z1 within [0, heightIn],
   *  each hull ≤ 12 vertices). Absent = one prism of `hull` up to `heightIn`. */
  bands?: ImportedBand[];
  /** mechanism placements; each game reads the fields it knows. */
  mech?: ImportedMech;
  /** PRACTICE TUNING (`docs/area/robot-import.md`, "Practice tuning"): numbers the player sets to
   *  make the robot behave like their real one. Read by the sim only beside an import, never in a
   *  room (`Room.beginMatch` strips it), so it changes nothing ranked, recorded or shared. */
  tune?: ImportTuning;
}

/**
 * An imported robot's practice tuning. Every field is optional; an absent one is what the sim
 * derives today. Ranges and steps: `IMPORT_TUNE` (`src/sim/imported.ts`), which `coerceImported`
 * clamps and quantises to.
 */
export interface ImportTuning {
  /** top drive speed, in/s */
  topSpeed?: number;
  /** drive acceleration, in/s² (the turn's follows it) */
  accel?: number;
  /** top turn rate, degrees/s */
  turnRate?: number;
  /** a FIXED launcher's aim assist turns the chassis no faster than this, degrees/s */
  aimTurn?: number;
  /** the shortest time between two shots, s (a turret's cadence; a setpoint wheel's feed) */
  shotInterval?: number;
  /** a setpoint flywheel's spin-up, rpm/s */
  spinUp?: number;
  /** the intake's time per element, as a multiple of what the sim derives */
  intakeTime?: number;
  /** a dumper's re-arm after a throw, s */
  reload?: number;
  /** a turret's top slew rate, degrees/s */
  turretSlew?: number;
  /** BIOBUZZ: the ramp's swing time, s */
  rampDeployS?: number;
}

export interface ImportedBand {
  z0: number;
  z1: number;
  hull: Vec2[];
  /** where `hull` stands proud of the model at these heights (at most 8) */
  cuts?: ImportedCut[];
}

/**
 * A RECESS IN A BAND'S EDGE. Across `from..to` (the `ImportedMech.intakes` span convention:
 * lateral for front/back, longitudinal for left/right, `from < to`) the model at the band's
 * heights reaches no further out than `at` (robot-local x for front/back, y for left/right). A
 * convex hull bridges the gap between two side rollers; a cut says how deep the gap really is.
 */
export interface ImportedCut {
  edge: ImportedEdge;
  from: number;
  to: number;
  at: number;
}

/** An edge of the hull's bounding box, as a robot-local direction. */
export type ImportedEdge = 'front' | 'back' | 'left' | 'right';

/**
 * Mechanism placements on an imported robot, robot-local inches. POSITIONS only: WHICH edge an
 * intake rides and which way a placer reaches stay the game's own mount fields (`intakeMount`,
 * `shooterMount`, `bbMech.lift.mount`, `catalystMount`), and a span on an edge the mount does not
 * use is ignored. Every point is inside the hull and every `z` in `[0, heightIn]`
 * (`coerceImported`); each game clamps further when it READS (`src/sim/importedMech.ts`).
 */
export interface ImportedMech {
  /** the launcher: a turret's AXIS, or a turretless launcher's release LIP centre. `z` is the
   *  release height (a turret's at rest pitch). */
  shooter?: { x: number; y: number; z: number };
  /** a TURRETLESS launcher's facing, degrees CCW from robot forward, wrapped to (−180, 180] and
   *  rounded to whole degrees; kept only beside `shooter`. DECODE's fixed launcher fires along it
   *  (absent = forward); BIOBUZZ's fixed launcher reads it when present, else its mount edge. */
  shooterYawDeg?: number;
  /** BIOBUZZ double turret: the second (NECTAR) head, as `shooter`. */
  shooter2?: { x: number; y: number; z: number };
  /** intake mouths: which bounding-box edge, and the span along it (lateral coordinate for
   *  front/back, longitudinal for left/right), `from < to`. At most one per edge, ordered
   *  front, back, left, right. */
  intakes?: { edge: ImportedEdge; from: number; to: number }[];
  /** the BASE of the placer (BIOBUZZ Box Tube, Chain Reaction catalyst): it reaches out of the
   *  hull from here along its mount's direction. `z` is for drawing only. */
  place?: { x: number; y: number; z: number };
}

/** Chain Reaction scoring archetype (see `RobotSpec.scoreMode`).
 *  • turret — turreted single-shooter, indexes one at a time, aims itself, any range.
 *  • twinturret — TWO shooters on one turret, fired alternately from two barrels: far more
 *    throughput than a single turret but well short of double (they share one indexer and
 *    one aim solution), and the second assembly costs hopper volume and weight.
 *  • drum   — a chassis-wide flywheel drum (no turret): the robot turns to face the goal,
 *    then fires up to 6 at once in a parallel line from ANY range (uniform velocity).
 *  • dumper — a chassis-wide catapult (no turret): turns to face the goal, then flings the
 *    WHOLE hopper at once from LIMITED range (side-to-side velocity variance ⇒ scatter). */
export type ChainScoreMode = 'turret' | 'twinturret' | 'drum' | 'dumper';
/** Chain Reaction intake design (see `RobotSpec.chainIntake`). Only the full-width sweeper
 * exists for now; the type is kept open for future designs. */
export type ChainIntakeStyle = 'sweeper';

/** Chain Reaction intake MOUNT (see `RobotSpec.intakeMount`) — which chassis edge(s) carry the
 * sweeper rollers. The mount moves the capture band AND the collision footprint together.
 *  • front     — one bar across the chassis front (the default).
 *  • back      — the same bar across the REAR: a mirror of front, so it costs nothing.
 *  • side      — rollers on BOTH flanks: collect a stream you drive alongside, but the open
 *    flanks eat into the hopper ⇒ the smallest storage cap.
 *  • frontback — rollers on BOTH ends: collect driving either way (no turning around), at a
 *    milder storage cost than `side`. */
export type ChainIntakeMount = 'front' | 'back' | 'side' | 'frontback';

/** Where a Chain Reaction mechanism sits on the chassis, in the robot frame (+x forward,
 * +y the robot's LEFT). The four EDGE positions are the mid-points of each side; the four
 * CORNERS are the actual corner points; `center` is the chassis middle — a turret only,
 * since anything that has to reach outward cannot live there. */
export type ChainMountPos =
  | 'front' | 'back' | 'left' | 'right'
  | 'frontleft' | 'frontright' | 'backleft' | 'backright'
  | 'center';

/** Chain Reaction shooter MOUNT (see `RobotSpec.shooterMount`). It means two related but
 * distinct things, resolved by `isTurreted`:
 *  • TURRETLESS (drum / dumper) — the chassis EDGE the launcher fires over, i.e. the edge the
 *    robot turns to the goal. Only the four edges are legal; `coerceSpec` folds a corner or
 *    centre to the nearest edge, because a launch LINE has to span a side.
 *  • TURRETED (turret / twin turret) — where the turret is BOLTED. A turret aims itself, so
 *    this is not a facing; it is the point the Particle is actually born at, which is why a
 *    back-mounted turret visibly shoots from the back of the robot. Any `ChainMountPos`. */
export type ChainShooterMount = ChainMountPos;

/** Chain Reaction CATALYST mechanism (see `RobotSpec.catalystType`) — how the robot handles
 * the 6" rings. Three real archetypes, each with a genuinely different reach envelope:
 *  • arm      — a claw on a LONG arm out the mounted edge. The longest reach of the three,
 *    but it must roughly FACE what it is grabbing and the arm is slow to cycle.
 *  • launcher — a short ground-intake CLAW plus a CATAPULT. The claw grabs and places as
 *    normal (shortest reach of the three); the catapult is a separate trick that FLINGS a
 *    carried ring far downfield to reposition it, deliberately inaccurately. Transport,
 *    not scoring.
 *  • turret   — a claw on a rail + turret that auto-tracks the nearest hook. Reaches in
 *    ANY direction (no need to point the chassis) and cycles fastest, but is the heaviest
 *    and its reach is middling. */
/**
 * How the catalyst mechanism is built.
 *  - `arm`      — a fixed arm + claw at one mount
 *  - `launcher` — a low scoop that flings a ring onto a hook
 *  - `turret`   — a claw on a rotating turret: aims anywhere, stays put
 *  - `rail`     — a turret claw on a linear TRACK that also traverses the chassis side,
 *                 so the claw can be positioned as well as aimed. The track spans a whole
 *                 side, which is why `CHAIN_RAIL_MOUNTS` allows only the four edges.
 */
export type ChainCatalystType = 'arm' | 'launcher' | 'turret' | 'rail';

/**
 * Where the catalyst mechanism is BOLTED. Sets where it reaches from and which way its reach
 * cone points (the `turret` type is omnidirectional, so the mount only moves the pivot).
 *
 * Any `ChainMountPos`, including `center` — which is only meaningful together with
 * `RobotSpec.catalystSwing`, since a claw cannot reach anything from the middle of a chassis
 * unless it is on an arm that swings out to an end.
 *
 * `'frontback'` is the LEGACY value for what is now `{ mount: 'center', swing: true }`. It is
 * still accepted on the wire and from old saves; `coerceSpec` migrates it. */
export type ChainCatalystMount = ChainMountPos | 'frontback';

/** which way a swing arm rotates: front↔back, or left↔right */
export type ChainSwingAxis = 'fb' | 'lr';

export type BallState =
  | { kind: 'ground' }
  /** in the air. `target` = the accelerator it was launched at. Chain Reaction:
   * once it enters that accelerator it is `scored`, then FUNNELS down inside the goal
   * for `funnelT` seconds before the wall-side launcher flings it back onto the field
   * (same ball, still 'flight' until it lands). `staged` = pre-match: HELD inside the goal
   * (inert) until the launcher ejects it during field randomization (see prematchRandomize).
   *
   * `by` is the alliance that LAUNCHED it, which is not the same fact as `target` and cannot be
   * derived from it: BIOBUZZ's up-CELL takes only its own alliance's element (owner ruling
   * 2026-09-12), so a red shot arriving over blue's open cell is a MISS that lands as ground
   * rather than a TIP for blue. Optional because DECODE and Chain Reaction never ask — an older
   * snapshot, and every non-BIOBUZZ flight, carries nothing here and is accepted by whatever it
   * reaches, which is the pre-ruling behaviour. Plain JSON, so it survives `slimWorld`. */
  | { kind: 'flight'; target: Alliance; by?: Alliance; scored?: boolean; funnelT?: number; staged?: boolean }
  /** jumbling inside the goal's triangular basin, funnelling toward the
   * classifier entrance under gravity */
  | { kind: 'basin'; goal: Alliance }
  /** on the classifier rail: 1D coordinate s from the gate (s=0), flowing
   * down under gravity and stacking by contact. overflow balls ride over the
   * stack and always continue out over the gate. pending balls have boarded
   * but not yet met the stack — classified vs overflow is decided at first
   * contact (9 retained below at that moment ⇒ overflow). */
  | { kind: 'rail'; goal: Alliance; s: number; v: number; overflow: boolean; pending?: boolean }
  /** captured and PHYSICALLY stored in a robot's intake: parked at storage slot
   * `slot` of robot `robot`. `lx`/`ly` are the ball's CURRENT offset in the robot
   * frame — it tracks the robot rigidly (no lag) and slides these toward the slot
   * target. `side` (−1/+1/0) is which side of the triangle front row it sits on
   * (a 3rd ball entering a side pushes the resident ball to the other side). The
   * robot's `hopper` color array mirrors these (count + colors synced). */
  | { kind: 'held'; robot: number; slot: number; lx: number; ly: number; side: number }
  | { kind: 'stock'; alliance: Alliance } // held by the human player, off-field
  /** parked INSIDE a field element (a BIOBUZZ HIVE cell or FLOWER stack): `el` names the
   * element (`'hive:red'`, `'flower:2'`), `slot` its position in that element's order. The
   * ball stays in `world.balls` so conservation is one array; it is not solved or drawn as a
   * loose ball while in this state. */
  | { kind: 'element'; el: string; slot: number };

export interface Artifact {
  id: number;
  color: ArtifactColor;
  /** radius in inches when it differs from the game's default (BIOBUZZ NECTAR 1.8 vs POLLEN
   * 1.4). Read as `b.r ?? radius` by the renderers AND by the whole shared artifact solve —
   * `solveArtifacts`, `bounceFirstContacts`, `clampBallPosToStatics`, `fieldPushback`,
   * `supported`, `pinnedArtifacts` and the held plugs in `artifactSolids`. DECODE sets it on
   * nothing, so a game that leaves it undefined behaves exactly as it did before it existed.
   * ⚠️ `bbRobotSolids` (the robot lane) is the one held-plug builder still using its `radius`
   * argument for every plug; see docs/biobuzz/feedback/000-solver-observations.md. */
  r?: number;
  state: BallState;
  pos: Vec2;
  vel: Vec2;
  z: number;
  vz: number;
}

export interface RobotState {
  id: number;
  alliance: Alliance;
  spec: RobotSpec;
  pos: Vec2;
  heading: number; // field frame, radians, 0 = +x, CCW positive
  vel: Vec2; // field frame, in/s
  /**
   * 3D PHYSICS ONLY (Day 1 seam, `docs/biobuzz/plan-3d.md` §2.4/§3.3): height above the tile
   * plane and its rate of change, in inches / inches per second. Written by `sim3d/step3d.ts`'s
   * readback every tick a `'3d'`-physics world steps; the 2D pipeline (`step2d`, DECODE, Chain
   * Reaction) never writes either field. Absent reads 0 (on the floor, no vertical motion) —
   * which is exactly right for every robot that has never run the 3D solve.
   */
  z?: number;
  vz?: number;
  /**
   * WHAT A CONTACT DID TO THIS CHASSIS LAST TICK — the velocity (and spin) the solver produced
   * that the drivetrain did not ask for. Written by `solveRobots`, read one tick later by the
   * per-wheel traction model in `updateRobot`, which is what a tyre resists.
   *
   * It has to be carried, because a force handed to the solver is computed BEFORE the solve
   * and a contact happens DURING it. One tick of lag is not a fudge here: a real tyre has a
   * relaxation length for exactly this reason, and the lag is what lets an IMPACT through (its
   * first tick meets no resisting force) while a sustained lean is refused every tick after
   * the first. Plain numbers, so snapshots and replays carry them like everything else.
   */
  slipX?: number;
  slipY?: number;
  slipW?: number;
  angVel: number;
  turretHeading: number; // field frame
  /**
   * BIOBUZZ turreted launcher: the ELEVATION angle in RADIANS above level — the pitch twin of
   * `turretHeading`, the axis that lets a turret put an arc into the 53.5-65.6in HIVE CELL.
   * Eased toward the arc solution at a finite rate, exactly as the yaw is: an actuator, not a
   * promise. For a DOUBLE turret this is the POLLEN turret (turret 0).
   *
   * Optional, and an absent value reads as 0 (level) everywhere — the same convention
   * `catalystRail` uses, so a DECODE or Chain Reaction robot never writes it and never pays for
   * it on the wire.
   */
  bbTurretPitch?: number;
  /**
   * BIOBUZZ DOUBLE turret only: the NECTAR turret's (turret 1's) field-frame YAW, the twin of
   * `turretHeading`. Seeded at spawn and slewed by `bbSlewTurret(…, 1)`; written ONLY for a
   * `twinturret` build, so no other robot carries it on the wire. Absent reads as
   * `turretHeading`.
   */
  bbTurret2Heading?: number;
  /**
   * BIOBUZZ DOUBLE turret only: the NECTAR turret's elevation in RADIANS, the twin of
   * `bbTurretPitch`. Written ONLY for a `twinturret` build. Absent reads as 0 (level).
   */
  bbTurret2Pitch?: number;
  /**
   * ⚠️ **BIOBUZZ TURRET AXIS VELOCITIES (rad/s) — THE STATE AN ACCELERATION LIMIT NEEDS.**
   *
   * `bbSlewTurret` is a rate- AND acceleration-limited profile (owner, 2026-09-19: "animate the
   * turret properly"), and an acceleration limit is a constraint on the CHANGE of a velocity, so
   * the velocity has to survive the tick. It cannot be derived from the angle alone — the previous
   * angle is not carried either, and deriving one from the other is the same field under a
   * different name.
   *
   * `bbTurretYawVel` is turret 0's yaw rate in the FIELD frame (the frame `turretHeading` is in),
   * `bbTurretPitchVel` its elevation rate; the `bbTurret2*` pair is a DOUBLE turret's second
   * turret, written only for a `twinturret` build exactly as its angles are.
   *
   * Optional plain numbers; **absent reads as 0 (at rest)** everywhere, so an old snapshot, an old
   * replay and a DECODE or Chain Reaction robot all load unchanged and carry nothing. QUANTIZED to
   * 1e-4 rad/s by the slew (the same rounding the 3D readback uses) — 0.0014% of the yaw rate, and
   * it is what keeps a 30 Hz snapshot from shipping four 17-digit floats per robot.
   */
  bbTurretYawVel?: number;
  bbTurretPitchVel?: number;
  bbTurret2YawVel?: number;
  bbTurret2PitchVel?: number;
  /** SWERVE per-module steer angles (robot frame, rad), one per wheel in the
   * corner order [FL, FR, BL, BR] — `WHEEL_CORNERS`, so pod i is `wheelLocals(spec)[i]`. Each module has
   * its OWN imperfect steering loop, so their small INDEPENDENT angle errors don't
   * cancel — producing the real drift + yaw wobble when driving straight. The net
   * chassis motion is the forward-kinematics of the four modules. Unused by other
   * drivetrains (all stay 0). Drives the per-pod wheel rendering. */
  moduleAngles: number[];
  /** SWERVE per-module TARGET steer angles (robot frame, rad) — the last COMMANDED
   * direction the pods are slewing to. Updated from the drive command; HELD when the
   * stick is released so the pods finish turning to (and keep) the commanded angle
   * even after a brief tap, instead of freezing partway. `moduleAngles` chases these
   * (plus the wobble). */
  moduleTargets: number[];
  /** CHAIN REACTION, `rail` catalyst only: where the claw's CARRIAGE sits along its track,
   * −1 .. +1 across the mounted side (0 = centred). Runtime state, not a build choice — the
   * carriage traverses toward whatever the claw is working at, at a finite rate
   * (`CHAIN_RAIL_RATE`), which is the point of buying a rail instead of a fixed turret.
   * Every other catalyst type leaves it at 0.
   *
   * OPTIONAL, and ABSENT means 0 — every reader spells that `?? 0`. It is a Chain Reaction
   * mechanism, and requiring it made every other game write `catalystRail: 0` with an
   * INERT-BUT-PRESENT comment to satisfy the type, which is a field describing hardware the
   * robot does not have. Nothing shared reads it: `worldHash` mixes pose + turret only, and
   * the snapshot codec spreads the robot and back-fills a different list, so a missing value
   * cannot poison a hash or NaN a sim. CR's own `spawn.ts` still writes it at 0 — for that
   * game it is real state and the absent case is only an old snapshot. */
  catalystRail?: number;
  /** BUTTERFLY drivetrain: is the TRACTION (tank) set the one on the ground right now?
   * false ⇒ the mecanum set is down (the spawn default). RUNTIME state, not a build
   * choice — the driver drops the other set mid-match with the `driveMode` command, and
   * it selects BOTH the mode's handling multipliers and which RPM slider applies (see
   * `driveParams`). Always present so snapshots/replays carry it; every other drivetrain
   * ignores it. */
  butterflyTank: boolean;
  /** TWIN TURRET: which of the two barrels fires NEXT (they alternate). Plain bool so
   * snapshots/replays reproduce the same muzzle; unused by every other archetype. */
  twinBarrel: boolean;
  /** was the `driveMode` button held last tick? The sim edge-triggers the butterfly swap
   * off this, so holding the button swaps once (not every tick). Plain bool ⇒ snapshot-safe. */
  driveModeHeld: boolean;
  /** `world.time` the driveMode button went up while `driveModeHeld` is still latched
   * (`debouncedPress`); absent otherwise. */
  driveModeUpAt?: number;
  /** BIOBUZZ `ramp` intake: is the ramp DEPLOYED (dropped forward)? Absent reads false, the
   * folded start R102 requires. RUNTIME state the driver toggles with `bbRamp`; the sim credits
   * the ramp's reach only `BB_RAMP_DEPLOY_S` after `bbRampAt`, and the renderer eases the swing
   * over the same interval off the same stamp. Every other intake leaves both absent. */
  bbRampOut?: boolean;
  /** `world.time` of the last ramp toggle (either direction). */
  bbRampAt?: number;
  /** the edge latch, `driveModeHeld`'s twin — but DEBOUNCED: it stays set through a release
   * shorter than `TOGGLE_DEBOUNCE_S` (`debouncedPress`). */
  bbRampHeld?: boolean;
  /** `world.time` the ramp button went up while `bbRampHeld` is still latched; absent otherwise. */
  bbRampUpAt?: number;
  /** OSCILLATION GUARD (owner, 2026-09-20: a swing that would carry the ramp into a static — the
   * flower it is deploying into, or a wall it would fold up through — reverses back where it
   * came from, `bbRampSwingStep`). Once a swing has reversed, 2D skips re-testing for the REST of
   * that swing; 3D skips only a reversed FOLD, and a reversed deploy that hits again folds for
   * good, because a moving robot can close on the static meanwhile (`bbRampSwingStep3d`). Absent reads false;
   * cleared on the next fresh press (`bbRampStep`), which is what lets a later, different swing
   * test again. Every other intake leaves this absent, same as the other `bbRamp*` fields. */
  bbRampBlocked?: boolean;
  /**
   * A SETPOINT FLYWHEEL's wheel speed right now, rpm (`src/sim/flywheel.ts`). Written ONLY for a
   * build with `spec.flywheel`, so no other robot carries it on the wire or in its JSON. It ramps
   * toward the setpoint, drops on every shot, and the feeder waits for it (`flyReady`).
   */
  flyRpm?: number;
  /** a `presets` flywheel's selected setpoint index into `spec.flywheel.rpm`; absent reads 0. */
  flyPreset?: number;
  /** the `flyPreset` button's debounced edge latch (`debouncedPress`); presets builds only. */
  flyPresetHeld?: boolean;
  /** `world.time` the preset button went up while `flyPresetHeld` is still latched. */
  flyPresetUpAt?: number;
  hopper: ArtifactColor[]; // FIFO, max 3
  fieldCentric: boolean;
  aimAssist: boolean;
  autoIntake: boolean; // intake runs whenever the hopper has room
  autoFire: boolean; // fire automatically when in the zone and on target
  lastFireAt: number;
  lastIntakeAt: number;
  /** earliest world.time the shooter may fire again (transfer cadence +
   * flywheel recovery after energetic shots) */
  fireReadyAt: number;
  /** 0..1 flywheel spin level, ramped by distance to this robot's own goal
   * (set in updateRobotActions; feeds power draw one tick later) */
  flywheelSpin: number;
  /** positive rate of change of flywheelSpin (1/s) — how fast the wheel is
   * SPINNING UP as the robot drives away from its goal (0 when idle or spinning
   * down; set in updateRobotActions; feeds power draw one tick later) */
  flywheelSpinRate: number;
  /** 0..POWER_DRAW_MAX current drawn from the drive motors by the flywheel +
   * intake (set in updateRobot); slows the robot and weakens its shove */
  powerDraw: number;
  /** G427: an opponent contacted this robot in its BASE during endgame — it
   * counts as fully returned at match end regardless of where it ends up */
  baseAwarded?: boolean;

  /** an INERT obstacle (a free-drive practice dummy): still collides + drive-brakes
   * like any robot, but skips ALL per-tick action compute — aim/shot-solve, flywheel
   * spin, fire, intake, and the CR turret slew — since it never acts. Keeps idle bots
   * from burning CPU on work they'll never use. Optional (real robots omit it). */
  passive?: boolean;

  // --- Auto Pathing State ---
  autoPathActive: boolean;
  currentPathSegmentIndex: number;
  pathSegmentProgress: number; // 0.0 to 1.0 along the current segment
  pathWaitTimer: number; // countdown for waitBeforeMs/waitAfterMs
  /** which sequence index's `waitBeforeMs` has already been served (-1 = none). A wait that
   * cannot say it has HAPPENED re-arms itself: the before-wait fires while segment progress
   * is 0, and progress is still 0 when its own timer expires, so the robot waited for that
   * segment forever and the whole auto stalled on it. */
  pathWaitedBefore: number;
  pathSequenceIndex: number; // index in the overall sequence
  pathTargetPoint: Vec2 | null;
  pathTargetHeading: number | null;
  autoPath?: AutoPathData; // Add autoPath to RobotState
  isAligningHeading: boolean; // New state for heading alignment
  targetAlignmentHeading: number | null; // The heading to align to
  // --- End Auto Pathing State ---
}

export interface GoalState {
  alliance: Alliance;
  gateOpen: boolean; // DERIVED: an artifact can pass (gatePos >= GATE_PASS_FRAC)
  gatePos: number; // physical arm open fraction 0 (closed) .. 1 (fully lifted)
  gateVel: number; // arm swing rate (1/s) — gravity accelerates it shut
  gateHoldTime: number; // accumulated time a robot has been pushing the gate arm
  gateLatch: number; // s remaining the arm stays latched open after a tap (no need to hold)
  classifiedCount: number; // cumulative, for stats
  overflowCount: number;
}

export type MatchPhase = 'pre' | 'auto' | 'transition' | 'teleop' | 'post' | 'freeplay';

/** how much of the in-match performance read-out to print — see `GameSettings.perfDisplay`.
 * Ordered least→most, and `PERF_DISPLAY_LEVELS` in `settings.ts` is the runtime list. */
export type PerfDisplay = 'off' | 'simple' | 'detailed' | 'graphs';

export interface ScoreBreakdown {
  leave: number;
  autoClassified: number;
  autoOverflow: number;
  autoPattern: number;
  teleClassified: number;
  teleOverflow: number;
  telePattern: number;
  depot: number;
  base: number;
  /** points awarded to THIS alliance from the opponent's fouls */
  foulPoints: number;
  /** a RED CARD was issued to one of this alliance's ROBOTS, so its MATCH points are
   * VOIDED — `total` reads 0 however much was earned. Optional so old snapshots and
   * replays (which have no card model) stay valid. */
  voided?: boolean;
  total: number;
}

/** A card issued by the Head REFEREE — per the DECODE glossary, "a warning issued by the
 * Head REFEREE for egregious ROBOT or team member behavior or rule violations". Cards
 * attach to a TEAM (a ROBOT here); a second yellow becomes a RED, and a RED voids that
 * robot's ALLIANCE score for the MATCH. */
export type CardColor = 'yellow' | 'red';

export interface MatchState {
  phase: MatchPhase;
  /** seconds remaining in the current phase (match mode) */
  phaseTimeLeft: number;
  scores: Record<Alliance, ScoreBreakdown>;
  /** live provisional pattern points for the current ramp arrangement */
  provisionalPattern: Record<Alliance, number>;
  /** fouls COMMITTED BY each alliance (counts, for the HUD); the resulting
   * points land on the OTHER alliance's ScoreBreakdown.foulPoints */
  fouls: Record<Alliance, { minor: number; major: number }>;
  /** how many of each alliance's ROBOTS are carded (for the HUD and the results screen).
   * A red is not also counted as a yellow — a carded robot appears once, at its current
   * colour. Optional for back-compat with snapshots/replays predating cards. */
  cards?: Record<Alliance, { yellow: number; red: number }>;
  /** seconds left in a sim-driven pre-match countdown (multiplayer: the
   * pre→auto transition runs INSIDE step() so every peer fires it on the same
   * tick). undefined ⇒ no auto-countdown (solo waits for a keypress instead). */
  preCountdown?: number;
}

export interface HumanPlayerState {
  /** out-of-play artifacts in the off-field 2x3 loading-zone box (capacity 6).
   * At setup it holds the 3 pre-staged loading-zone artifacts (PGP, manual setup)
   * plus any unclaimed alliance-area preload set. The HP does nothing until
   * teleop; then it stages the grab row from here one at a time and recycles
   * returned balls back in. */
  box: ArtifactColor[];
  nextPlaceAt: number;
}

/** accumulator for one ordered pinner→pinned pair (G422). Plain numbers so
 * the whole World stays JSON-serializable / lockstep-safe. */
export interface PinState {
  /** seconds the PIN has counted. Not wall-clock: it pauses (see below) and never resets, so
   * it is the total the rule bills against — a MINOR at 3 s and another every 3 s after. */
  seconds: number;
  /** where each robot was when the PIN initiated — criterion B measures both against these */
  ox: number;
  oy: number;
  pox: number;
  poy: number;
  /** pinned robot pos last tick, to measure actual (post-solver) progress away */
  px: number;
  py: number;
  /** how many MINOR FOULs this PIN has already drawn. G422 bills one at 3 s "and an additional
   * MINOR FOUL for every 3 seconds in which the situation is not corrected", so a pin held for
   * nine seconds is three fouls, not one — and not a MAJOR, which the rule never mentions. */
  billed: number;
  /** seconds criterion A has held (the pair at least PIN_ESCAPE_DIST apart) */
  sepFor: number;
  /** seconds criterion B has held (EITHER robot that far from where the pin initiated) */
  awayFor: number;
  /** `world.time` of the last tick `seconds` advanced — what tells a HUD a COUNTING pin from a
   * PAUSED one. Optional: set by BIOBUZZ only, and absent on older snapshots. */
  at?: number;
}


/** deterministic penalty-engine state (all plain JSON — serializable) */
export interface PenaltyState {
  /** episode debounce: `${rule}:${key}` -> last world.time the rule was active
   * for that subject; a rule re-arms only after PENALTY_CLEAR s of no activity */
  episodes: Record<string, number>;
  /** pinning accumulators, keyed `${pinnerId}-${pinnedId}` */
  pins: Record<string, PinState>;
  /** how many G422 fouls a given pinner (by id) has committed this match. Bookkeeping only —
   * the rule has no escalation, every PIN foul is a MINOR — but a per-robot tally is what the
   * HUD and a post-match breakdown want. */
  pinFouls: Record<number, number>;
  /** G408 over-possession: an ACCUMULATED, leaky clock of seconds a robot (by id) has
   * controlled more than POSSESSION_LIMIT artifacts. It fills while over the limit and
   * drains at POSSESSION_LEAK while under, so a violation broken into repeated flicks still
   * reaches POSSESSION_GRACE. It is NOT reset when the foul fires — the continuing tariff is
   * measured against this same reading, so it has to keep running for as long as the
   * violation does. Cleared outside auto/teleop. */
  possession: Record<number, number>;
  /** how many artifacts OVER the limit have already been billed in the current G408
   * episode, so a pile that grows while the violation is held tops the tariff up rather
   * than riding free on the first assessment */
  possessionBilled: Record<number, number>;
  /** the `possession` reading at which the CONTINUING tariff was last charged. Anchored to
   * the clock on the opening tick and clamped to it, so the first continuing charge lands one
   * POSSESSION_REBILL_S after the violation opens rather than two, and a partial drain cannot
   * leave the cursor ahead of the clock. */
  possessionRebill: Record<number, number>;
  /** G408 clause-B bookkeeping: seconds a robot has continuously controlled
   * CARD_CONTROL_FREQUENT or more artifacts. Drains rather than resetting, so a pile that
   * dips under four for a tick does not wipe a nearly-complete instance. */
  controlHeld: Record<number, number>;
  /** PER-ARTIFACT hold: `"<robotId>:<ballId>"` -> seconds this robot has been HERDING this
   * artifact (touching a non-corner face and moving it, per CONTROL clause B), draining at
   * POSSESSION_LEAK when contact is lost. An artifact counts toward the limit once its own
   * clock passes POSSESSION_CONFIRM, and KEEPS counting while contact holds — which is what
   * separates herding (the same artifacts, over and over) from crossing a littered field (a
   * different artifact each moment). Entries are deleted at 0, and swept when the artifact
   * stops being a loose ground ball. */
  ballHold: Record<string, number>;
  /** ...and WHERE that artifact sat, in the ROBOT'S OWN FRAME, when the hold began:
   * `"<robotId>:<ballId>"` -> {x,y}. Being in the robot frame is the point — a rigid rotation
   * does not move it, so turning with an artifact held in front of you keeps its station,
   * while one you slide past sweeps the chassis and re-anchors. Re-seeded when an artifact
   * moves to a new station, deleted with the hold. */
  ballAnchor: Record<string, Vec2>;
  /** ...and how far it has actually been CARRIED, in inches, in the direction the robot has
   * been taking it: `"<robotId>:<ballId>"` -> distance. This is how "the ROBOT is MOVING the
   * SCORING ELEMENT in a preferred direction" is measured, and it has to be a projected
   * DISTANCE rather than a speed. Contact in this sim is a train of micro-impacts, so a pile
   * jammed on the perimeter reads as moving fast while going nowhere — it squirts sideways out
   * of the squeeze, which earns nothing here. Unlike `ballAnchor` it survives a re-station, so
   * a pile that rattles along a bumper still shows the ground it has covered. OPTIONAL, and
   * read through `??=`: `world.penalties` has no `unslimWorld` backfill, so a snapshot from an
   * older server would otherwise arrive without it and the first index would throw. */
  ballCarry?: Record<string, number>;
  /** how many clause-B stretches have run longer than MOMENTARY this match */
  controlInstances: Record<number, number>;
  carded: Record<number, CardColor>;
  /** which OPPONENT alliance (if any) is responsible for each goal's gate being
   * open — set when an opponent operates the gate, held through the drain, and
   * cleared once the gate shuts. Artifacts leaving that ramp meanwhile are billed
   * to them (G418.B). null = closed, or opened legally by the owner. */
  gateCulprit: Record<Alliance, Alliance | null>;
  /** ids of the classified (committed, non-overflow) artifacts resting on each
   * goal's ramp last tick, to detect ones that leave (G418.B) */
  rampBallIds: Record<Alliance, number[]>;
}

// --- Auto Pathing Types ---
export type HeadingType = 'linear' | 'constant' | 'tangential';

export interface PathPoint extends Vec2 {
  heading: HeadingType;
  startDeg?: number; // For 'linear'
  endDeg?: number;   // For 'linear'
  degrees?: number;  // For 'constant'
  reverse?: boolean; // For 'tangential'
}

export interface ControlPoint extends Vec2 {}

export interface PathLine {
  id: string;
  endPoint: PathPoint;
  controlPoints?: ControlPoint[]; // For Bezier curves
  waitBeforeMs?: number;
  waitAfterMs?: number;
  waitBeforeName?: string;
  waitAfterName?: string;
}

export type SequenceItemKind = 'path' | 'wait' | 'action'; // 'action' is a placeholder

export interface SequenceItem {
  kind: SequenceItemKind;
  id?: string; // For 'wait' kind
  durationMs?: number; // For 'wait' kind
  lineId?: string; // For 'path' kind
  // Add other properties for 'action' if needed
}

export interface AutoPathData {
  fileName: string; // To store the name of the imported file
  startPoint: PathPoint;
  lines: PathLine[];
  sequence?: SequenceItem[];
  version?: string;
  timestamp?: string;
}
// --- End Auto Pathing Types ---

/** a robot start pose (field frame, heading in degrees). Custom poses are stored
 * in the CANONICAL goalSide=+1 (red) frame like START_POSES and mirrored per
 * alliance at spawn. Defined here (not sim/field) so settings can reference it
 * without a circular import. */
export interface StartPose {
  x: number;
  y: number;
  headingDeg: number;
}

/** start positions are grouped by proximity to the goal: 'close' (goal-side) vs
 * 'far' (audience side). In a 2v2 an alliance fills one Close and one Far slot. */
export type StartCat = 'close' | 'far';

/** a remembered start selection within a category: a preset (by index) OR a
 * custom/saved pose (`pose` set, `index` = -1). */
export interface StartSel {
  index: number;
  pose: StartPose | null;
}

/** the PER-GAME loadout: robot build + saved-robot library + start position state. DECODE and
 * Chain Reaction each keep their own — switching games swaps the active fields to that game's
 * copy so nothing bleeds across (a CR 18"-long build never clamps under DECODE, and each game's
 * saved robots / start positions stay separate). Archived in `GameSettings.loadouts`. */
export interface GameLoadout {
  spec: RobotSpec;
  /** the most recent STANDARD robot this game had active — what ranked and record runs use while
   *  the active robot is imported (`standardRobotFor`, `src/settings.ts`). Never an import. */
  lastStandardSpec?: RobotSpec;
  savedRobots: RobotSpec[];
  startIndex: number;
  startPose?: StartPose | null;
  startCat: StartCat;
  savedStartPoses: { close: StartPose[]; far: StartPose[] };
  startMemory: { close: StartSel; far: StartSel };
}

/** one practice seat beside the player (`GameSettings.practiceSeats`). `tier` is kept while the
 *  seat is not AI, so switching a seat Dummy → AI brings its difficulty back. */
export type PracticeSeatKind = 'none' | 'dummy' | 'ai';
export interface PracticeSeat {
  kind: PracticeSeatKind;
  tier: string;
}
/** partner, opponent 1, opponent 2 */
export type PracticeSeats = [PracticeSeat, PracticeSeat, PracticeSeat];

/** what the pace read-out compares against — see `GameSettings.pace` */
export type PaceSource = 'off' | 'pb' | 'wr' | 'replay';

/** a replay picked as the pace (`GameSettings.paceReplays`) */
export interface PaceReplayRef {
  /** the curve's store key (`src/ui/pace/store.ts`): `r:<replay id>` or `l:<local key>` */
  key: string;
  /** the server replay id, when it has one — what lets another device rebuild the curve */
  replayId?: string;
  /** whose score in that replay is the pace */
  alliance: Alliance;
  /** who and what, for Configure: "Saket · 212" */
  label: string;
}

export interface GameSettings {
  /** which game the player has selected (DECODE / Chain Reaction). Drives spawn,
   * step, render, HUD, the builder, and the room/queue game key. Persists + syncs. */
  game: GameId;
  mode: GameMode;
  alliance: Alliance;
  spec: RobotSpec;
  /**
   * The most recent STANDARD robot this game had active (per game, archived with the loadout).
   * Ranked, rated challenges and record runs refuse an imported robot, so while `spec` is one they
   * play this instead, and the swap picker preselects it. Absent until a standard robot has been
   * active; never an imported spec (`coerceSettings` drops one that is).
   */
  lastStandardSpec?: RobotSpec;
  /** the player's saved robot library (up to MAX_SAVED_ROBOTS). `spec` is the
   * ACTIVE robot; loading a slot copies it into `spec`, saving copies `spec` in. */
  savedRobots: RobotSpec[];
  /** the player's saved auto library (up to MAX_SAVED_AUTOS). `autoPath` is the
   * ACTIVE auto; selecting a slot copies it into `autoPath`. */
  savedAutos: AutoPathData[];
  startIndex: number;
  /** a fully-placed CUSTOM start pose (canonical goalSide=+1 frame). When set it
   * OVERRIDES startIndex; validated against G304 and snapped legal at spawn.
   * `startIndex`/`startPose` are the ACTIVE start (what spawns / goes on the wire);
   * the fields below are the client-side library + per-category memory. */
  startPose?: StartPose | null;
  /** which category the ACTIVE start belongs to (solo picks it; a 2v2 role locks it) */
  startCat: StartCat;
  /** the player's own saved start positions, up to MAX_SAVED_STARTS per category */
  savedStartPoses: { close: StartPose[]; far: StartPose[] };
  /** last-used selection in each category, so switching tabs restores your choice */
  startMemory: { close: StartSel; far: StartSel };
  /** the NON-active games' loadouts (robot + saved robots + start positions), archived so
   * switching games restores that game's own build/library instead of bleeding across. The
   * flat fields above are always the ACTIVE game's copy; `switchGame` swaps them. */
  loadouts?: Partial<Record<GameId, GameLoadout>>;
  practiceDummies: boolean;
  /**
   * SOLO PRACTICE ONLY (Day 1 seam, `docs/biobuzz/plan-3d.md` §2.1): which physics backend a
   * solo BIOBUZZ practice world steps on — the player's own pick, defaulting `'3d'`. Ranked,
   * matchmade and record rooms are NOT decided by this field; the server always stages those
   * `'3d'`. Absent (every non-BIOBUZZ settings blob, and every save from before this field
   * existed) reads `'2d'` wherever the physics itself is read (`biobuzzPhysics`), but
   * `coerceSettings` fills the default below so a fresh settings object already reads `'3d'`.
   * Persists + syncs like every other `GameSettings` field (the account sync sends the whole
   * blob, so this rides along with no protocol change).
   */
  practicePhysics?: Physics;
  /** THE RUN LENGTH THIS PLAYER ASKS FOR: 'auto' ends the match at the AUTO buzzer (`World.runLength`).
   *  Absent / 'full' = the whole match. Read by solo practice, and sent as the ASK when this player
   *  creates a record room or a room (`RoomSettings.runLength`); a room already made decides for itself. */
  runLength?: 'full' | 'auto';
  /**
   * SOLO PRACTICE OPPONENTS (plan §6): `'off'`, or a TIER from the active game's own
   * `GameSimModule.bot.tiers`. Absent reads `'off'`, which is every settings blob that predates
   * this field and every game that has no AI driver.
   *
   * ⚠️ **THE TIER IS AN OPAQUE STRING, DELIBERATELY.** The seam declares `tiers` as
   * `readonly string[]` so a game can add or rename a difficulty without a shared type edit, and
   * typing this field as a union of BIOBUZZ's three would be the shared type edit that rule
   * exists to avoid. It is validated the only way it honestly can be — against the live module's
   * own `coerceTier` — in `coerceSettings`, which is the same chokepoint every other untrusted
   * settings field goes through.
   *
   * Practice only. A ROOM's bots are the host's choice, seated server-side (`addBot`), and a
   * ranked or record room refuses them outright.
   */
  practiceBots?: string;
  /**
   * WHO ELSE IS ON A PRACTICE FIELD, PER GAME: the three seats beside the player — partner,
   * opponent 1, opponent 2, in that order — each None, a Dummy (an inert `passive` robot) or an
   * AI driver at its own tier. Read by Solo practice AND Free drive. Absent, or absent for a game,
   * is three None.
   *
   * A NEW SIBLING, like `bindings.perGame`: it supersedes `practiceBots` / `practiceDummies`,
   * which stay in the blob untouched so an older client still reads the shape it knows. Per game
   * because AI is one game's today, and an AI seat set there must not read as None in another
   * game and come back cleared. The tier is opaque for the reason `practiceBots` gives, resolved
   * through the game's own `coerceTier` where it is used.
   */
  practiceSeats?: Partial<Record<GameId, PracticeSeats>>;
  /** the ACTIVE resolved driver assists (what spawns + goes on the wire).
   * MIRRORED from `spec.assists`, which is where the preference is actually STORED — the
   * robot owns its assists, so loading a saved robot / preset / the other game's loadout
   * brings its own. Kept as a flat field because spawn, the lobby, matchmaking and record
   * runs all read it, so the wire and the spawn seam never had to change. */
  assists: AssistConfig;
  bindings: ControlBindings;
  audio: {
    /** per-category levels, 0–1 — the source of truth. `master` scales the other
     * the rest. ONE PER EMITTER — `game` = the FIRST field-recording WAV cues;
     * `shoot`/`intake`/`gate` = the three synthesized mechanism effects; `beep` =
     * the countdown beep; `voice` = announcer speech (at 0 the countdown falls back
     * to beeps, exactly as the old toggle did).
     *
     * `shoot`/`intake`/`gate`/`beep` replaced a single `sfx` level whose slider was
     * labelled "Beeping" — one control for four unrelated sounds, named after the
     * least frequent of them. `coerceSettings` migrates an old `sfx` value onto all
     * four so nobody's existing choice is lost. */
    volume: {
      master: number;
      game: number;
      shoot: number;
      intake: number;
      gate: number;
      beep: number;
      alert: number;
      voice: number;
    };
    /** LEGACY mirrors, re-derived from `volume` on every coerce — never read these
     * on the new path. Settings sync per ACCOUNT and one account is shared across
     * client versions (an old browser tab, an old Electron install), and those
     * builds only understand these two booleans. Without the mirrors, muting on a
     * new build would silently un-mute on an old one. */
    sounds: boolean;
    voice: boolean;
  };
  /** show the in-match EVENT LOG — the stack of messages in the field's top-left
   *  corner (scoring, gate, penalty notices). Off hides it entirely; it is a
   *  read-out, never a control, so nothing is lost but the reading. */
  showEventLog: boolean;
  /**
   * THE IN-MATCH PERFORMANCE READ-OUT, and how much of it to print.
   *
   * ONE setting for ONE display. It used to be three things at once — a `?perf=1` frame-time
   * line, a 3D-only corner overlay behind a Graphics row, and a connection chip you clicked to
   * open a ping graph — which is why the levels are a LEVEL and not a set of switches: the
   * display decides what it shows from this alone, and nothing on it is clickable.
   *
   *   off       nothing
   *   simple    frame rate, and the ping when there is a server (the DEFAULT)
   *   detailed  + frame/sim/render timings, the 3D counters, the link's numbers
   *   graphs    + a frame-time and a ping sparkline
   */
  perfDisplay: PerfDisplay;
  /**
   * THE PACE READ-OUT: a +/- beside your score, against what another run had at the same point
   * on the match clock (`src/ui/pace`). Solo practice and record runs only. Absent reads `off`,
   * which is every blob written before it existed.
   *   pb      your own best: the best record in the mode you are running, or in solo practice
   *           your best practice run. Looked up again each match, so it follows a new best.
   *   wr      the top of the record board for the mode (solo practice reads the solo board)
   *   replay  one replay you picked (`paceReplays`, per game)
   */
  pace?: PaceSource;
  /** the replay `pace: 'replay'` runs against, per game — a replay belongs to one game */
  paceReplays?: Partial<Record<GameId, PaceReplayRef>>;
  // New fields for auto pathing
  autoPath: AutoPathData | null;
  autoPathEnabled: boolean;
  /** park mode's speed cap, 0-100 (% of normal max speed); activation is
   * gated to endgame / free drive regardless of this value */
  parkSpeedPct: number;
  /** preferred game server id (multi-region). Remembered across sessions and,
   * for signed-in players, synced to the account. Undefined ⇒ auto-pick fastest. */
  preferredServerId?: string;
  /** tank drive control: 'traditional' (separate sticks) or 'normal' (Arcade-style) */
  tankControlMode: 'traditional' | 'normal';
  /** on-screen touch-control layout (mobile). Positions are the CENTRE of each
   * control as a FRACTION of the viewport (x,y in 0..1), so a layout scales across
   * screen sizes/orientations. LOCAL setting (persists + account-syncs). */
  mobileLayout: MobileLayout;
}

/** one on-screen control's centre, as a fraction (0..1) of the viewport. */
export interface MobilePos {
  x: number;
  y: number;
}
/** editable positions for the two joysticks + the action buttons. */
export interface MobileLayout {
  drive: MobilePos;
  turn: MobilePos;
  shoot: MobilePos;
  intake: MobilePos;
  catalyst: MobilePos;
  /** Chain Reaction, LAUNCHER catalyst only: the CATAPULT throw. Its own button for the
   * same reason it has its own keybind — a throw is not the claw's grab/place, and a
   * driver must never have to guess which one a press means. */
  fling: MobilePos;
  /** BIOBUZZ, the HUMAN PLAYER button: enter one NECTAR into the own LOADING ZONE. Its own
   * position because it is the one touch control that acts on the ALLIANCE rather than on the
   * robot, and a driver reaches for it at a moment (a TIP completing, the 1:00 cue) rather
   * than in a drive rhythm — so it wants to be somewhere the thumb does not pass by accident. */
  bbNectar: MobilePos;
  /** overall control size multiplier (0.7..1.5). */
  scale: number;
}

export interface World {
  /** which game this world simulates. Optional for back-compat: an absent value
   * (old snapshots/replays) resolves to `'decode'` via `gameOf`/`moduleFor`. */
  game?: GameId;
  /** Chain Reaction runtime state (catalysts / scoring / endgame). Present only
   * when `game === 'chain'`; DECODE worlds omit it. */
  chain?: ChainState;
  /** BIOBUZZ runtime state. Present only when `game === 'biobuzz'`; the other
   * games omit it. (Empty for now — the season's rules land at kickoff.) */
  biobuzz?: BiobuzzState;
  mode: GameMode;
  time: number;
  tick: number;
  rngState: number;
  /** the `SIM_PATCH` a REPLAY was recorded under, set only by `ReplayPlayer`. Absent (every
   * live world) ⇒ the current rules. See `SIM_PATCH` in `config.ts`. */
  simPatch?: number;
  /** 'auto' = an AUTO-ONLY run: the match ends when AUTO does (no transition, no TELEOP). ABSENT
   * for a full run, so every full-run world and golden pin is byte-identical. Set after
   * `createWorld`, the way `simPatch` is; see `autoOnly` in `sim/match.ts`. */
  runLength?: 'auto';
  motif: Motif;
  robots: RobotState[];
  balls: Artifact[];
  goals: Record<Alliance, GoalState>;
  humanPlayers: Record<Alliance, HumanPlayerState>;
  match: MatchState;
  /** transient UI events emitted by the sim this tick (toasts) */
  events: string[];
  /** robot-robot contact pairs registered THIS tick (transient, by robot id,
   * a < b) — consumed by the penalty engine */
  rrContacts: { a: number; b: number }[];
  /** ground artifacts the collision engine found PINNED at the end of the last tick (ids) —
   *  ones a robot could not move because a wall, another artifact or another robot was behind
   *  them. Carried into the next tick so a robot resting on one keeps resting on it, instead of
   *  re-discovering the pin a hair later every tick. Derived state, plain JSON, in every
   *  snapshot; absent from an older snapshot ⇒ empty. See . */
  pinnedArtifacts?: number[];
  /** the next artifact id to hand out (`allocBallId`, sim/ballIds.ts): a HIGH-WATER MARK, so an
   *  id is never reused within a match. Absent from an older world or snapshot ⇒ the old
   *  `max(id) + 1`. BIOBUZZ keeps its own counter on `world.biobuzz`. */
  nextBallId?: number;
  /** persistent penalty-engine state (Section 11 fouls) */
  penalties: PenaltyState;
  // Add gameSettings to World interface
  gameSettings?: GameSettings;
}