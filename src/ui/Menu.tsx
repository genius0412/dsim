import type { CSSProperties, ReactNode } from 'react';
import type { GameSettings } from '../types';
import type { ChainScoreMode, DrivetrainType, IntakeStyle, RobotSpec } from '../types';
import { MAX_SAVED_ROBOTS, ROBOT_PRESETS, CHASSIS_COLORS, CHASSIS_COLOR_KEYS, chassisFill } from '../config';
import {
  ACCENT_KEYS,
  DECAL_KEYS,
  PLATE_KEYS,
  OUTLINE_HALO,
  accentFill,
  clampCosmetics,
  cosmeticAllowed,
  cosmeticTier,
  type CosmeticId,
  type Decal,
  type Plate,
} from '../cosmetics';
import { useAds } from '../ads/AdsProvider';
import {
  CHAIN_CLEARANCE_DEFAULT,
  CHAIN_CLEARANCE_MAX,
  CHAIN_CLEARANCE_MIN,
  CHAIN_STORAGE_DEFAULT,
  CHAIN_STORAGE_MIN,
  CHAIN_SCORE_MODES,
  CHAIN_DEFAULT_SCORE_MODE,
  CHAIN_PRESETS,
  chainStorageMax,
  chainMassFloorBump,
  chainSizeLimits,
  CHAIN_CATALYST_TYPES,
  CHAIN_DEFAULT_CATALYST,
  CHAIN_CATAPULT_RANGE_MIN,
  CHAIN_CATAPULT_RANGE_MAX,
  CHAIN_CATAPULT_YAW_STEP,
  chainCatapultRange,
} from '../games/chain/config';
import {
  CHAIN_MODE_LABELS,
  CHAIN_INTAKE_LABELS,
  CHAIN_INTAKE_MOUNT_LABELS,
  CHAIN_INTAKE_MOUNT_BLURBS,
  CHAIN_SHOOTER_MOUNT_LABELS,
  CHAIN_CATALYST_LABELS,
  CHAIN_CATALYST_BLURBS,
  CHAIN_CATALYST_MOUNT_LABELS,
} from '../games/chain/labels';
import {
  CHAIN_CATALYST_MOUNTS,
  isEdgePos,
  mountsClash,
  CHAIN_INTAKE_MOUNTS,
  CHAIN_SHOOTER_MOUNTS,
  CHAIN_TURRET_POSITIONS,
  catalystMountOf,
  catalystSwingOf,
  intakeMountOf,
  isSwingMount,
  isTurreted,
  shooterMountOf,
  swingHomeFor,
} from '../games/chain/mounts';
import {
  butterflyTankRpm,
  butterflyTankRpmLimits,
  driveParams,
  lengthLimits,
  massLimits,
  rpmLimits,
  widthLimits,
} from '../sim/drivetrain';
import { coerceSpec, coerceAssists, PLAYER_ASSISTS } from '../sim/spawn';
import { RobotPreview } from './RobotPreview';
import { ChainRobotPreview } from '../games/chain/RobotPreview';
import { moduleFor } from '../games';
import { DRIVETRAIN_LABELS, buildWords, teamLine } from './robotLabels';
import { RobotCard } from './RobotCard';
import { Marquee } from './Marquee';
import { OptRow, ToggleRow } from './OptRow';
import { rangeFill } from './rangeFill';
import { starPoints } from '../render/drawRobot';

const INTAKE_LABELS: Record<IntakeStyle, string> = {
  sloped: 'Sloped',
  vector: 'Vector wheel',
  triangle: 'Triangle',
};

// Chain Reaction robot config blurbs (CR-only builder controls). The LABELS
// (CHAIN_MODE_LABELS / CHAIN_INTAKE_LABELS) are shared with the leaderboard config
// summary via ../games/chain/labels so both name the archetype/intake identically.
const CHAIN_MODE_BLURBS: Record<ChainScoreMode, string> = {
  turret: 'Aims itself · one at a time, from anywhere',
  twinturret: 'Aims itself · two shooters, a little faster, holds less',
  drum: 'Aim by turning · a fast stream',
  dumper: 'Aim by turning · the whole load at once, up close',
};

/** does the current spec exactly match a preset? (value compare) */
/** a preset match is about the BUILD only — name/team/number are the player's
 * own identity, never copied from (or compared against) a preset. */
function specMatches(a: RobotSpec, b: RobotSpec): boolean {
  return (
    a.length === b.length &&
    a.width === b.width &&
    a.intake === b.intake &&
    a.massLb === b.massLb &&
    a.drivetrain === b.drivetrain &&
    a.driveRpm === b.driveRpm &&
    (a.tankRpm ?? 0) === (b.tankRpm ?? 0) &&
    a.flywheelInertia === b.flywheelInertia &&
    a.canSort === b.canSort
  );
}

/** Chain Reaction preset match: the shared drivetrain/size/mass/rpm build PLUS the
 * CR-specific loadout (archetype, intake design, storage, clearance). Flywheel inertia
 * is ignored (CR doesn't use it). */
function chainSpecMatches(a: RobotSpec, b: RobotSpec): boolean {
  return (
    a.length === b.length &&
    a.width === b.width &&
    a.massLb === b.massLb &&
    a.drivetrain === b.drivetrain &&
    a.driveRpm === b.driveRpm &&
    (a.tankRpm ?? 0) === (b.tankRpm ?? 0) &&
    (a.scoreMode ?? 'turret') === (b.scoreMode ?? 'turret') &&
    (a.chainIntake ?? 'sweeper') === (b.chainIntake ?? 'sweeper') &&
    intakeMountOf(a) === intakeMountOf(b) &&
    shooterMountOf(a) === shooterMountOf(b) &&
    (a.ballStorage ?? 0) === (b.ballStorage ?? 0) &&
    (a.groundClearance ?? 0) === (b.groundClearance ?? 0)
  );
}

interface Props {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
}

/**
 * Why a locked swatch is locked, for `title`/`aria-label` — never "supporter perk" on the
 * caption itself (free users have real choices on every axis now), only on the specific
 * options they don't have yet.
 *
 * ⚠️ **AN `earned` KEY SAYS HOW TO EARN IT, BY NAME, WHEREVER THAT IS KNOWABLE.** The
 * generic fallback used to be the only answer and it pointed at Career, which is right for a
 * season award and WRONG for the only earned key that exists: no amount of playing gets you
 * `decal:star`, you star the repo. A hint that sends somebody to the wrong screen is worse
 * than a vague one, because they go and look.
 */
const EARN_HINT: Record<string, string> = {
  'decal:star': 'Star the repo on GitHub, then connect it in Account',
};

function lockReason(id: CosmeticId, supporter: boolean, earned: readonly string[]): string | undefined {
  if (cosmeticAllowed(id, supporter, earned)) return undefined;
  if (cosmeticTier(id) !== 'earned') return 'Supporter perk';
  return EARN_HINT[id] ?? 'Earned — see Career';
}

/** one swatch button, shared by all four axis rows below: same size, hover, ring and
 * disabled behavior the chassis row always had (`.chassis-sw`), whatever it paints
 * inside. A swatch with `children` (a decal/plate preview) also gets `.cosmetic-sw`,
 * which clips the SVG to the same rounded square. */
function CosmeticSwatch({
  active,
  locked,
  title,
  label,
  style,
  children,
  onClick,
}: {
  active: boolean;
  locked: boolean;
  title?: string;
  label: string;
  style?: CSSProperties;
  children?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`chassis-sw${children ? ' cosmetic-sw' : ''}${active ? ' on' : ''}`}
      style={style}
      // A locked swatch is `disabled`, not hidden: the browser skips it in the tab
      // order and announces it as unavailable, which is the right story for "you
      // could have this" — and it can't be clicked past.
      disabled={locked}
      aria-label={locked ? `${label} (${title})` : label}
      aria-pressed={active}
      title={locked ? title : undefined}
      onClick={onClick}
    >
      {children}
      {/* LOCKED READS AS A LOCK, not a fade: the fill stays the colour you would get, and the
          dashed edge + this badge say it is not yours yet (the chassis map's rule) */}
      {locked && (
        <svg className="chassis-sw-lock" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M3 4.5V3.2a2 2 0 0 1 4 0v1.3" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <rect x="2" y="4.5" width="6" height="4.5" rx="1" fill="currentColor" />
        </svg>
      )}
    </button>
  );
}

/** the decal's shape, drawn in the ACCENT colour over the swatch's chassis-coloured
 * backdrop — parametric (fractions of a 24x24 footprint), never an image, matching how
 * `drawRobot.ts` draws the real thing over the chassis footprint. */
function decalShape(decal: Decal, accentHex: string): ReactNode {
  switch (decal) {
    case 'none':
      return null;
    case 'stripe':
      return <rect x="10" y="1" width="4" height="22" fill={accentHex} />;
    case 'chevron':
      return <path d="M4 21 L12 3 L20 21 L15.5 21 L12 12 L8.5 21 Z" fill={accentHex} />;
    case 'racing':
      return (
        <>
          <rect x="7" y="1" width="3" height="22" fill={accentHex} />
          <rect x="14" y="1" width="3" height="22" fill={accentHex} />
        </>
      );
    case 'hazard':
      return (
        <g stroke={accentHex} strokeWidth="4">
          <line x1="1" y1="7" x2="7" y2="1" />
          <line x1="1" y1="17" x2="17" y2="1" />
          <line x1="7" y1="23" x2="23" y2="7" />
          <line x1="17" y1="23" x2="23" y2="17" />
        </g>
      );
    case 'checker':
      return (
        <>
          <rect x="0" y="0" width="8" height="8" fill={accentHex} />
          <rect x="16" y="0" width="8" height="8" fill={accentHex} />
          <rect x="8" y="8" width="8" height="8" fill={accentHex} />
          <rect x="0" y="16" width="8" height="8" fill={accentHex} />
          <rect x="16" y="16" width="8" height="8" fill={accentHex} />
        </>
      );
    case 'star': {
      // The one swatch that is NOT parametric off a footprint — this is a fixed 24x24 preview
      // icon, not a robot, so a literal radius is fine here and nowhere else. Still built off
      // the shared `starPoints` (`render/drawRobot.ts`) so this icon is genuinely the same
      // shape the two live renderers draw, not a hand-tuned lookalike. −90° puts the first
      // point at the TOP (r=9 lands its tip at y=3, the same tip height `chevron`'s "L12 3"
      // uses above), matching this file's convention that a decal's forward point reads "up".
      const d =
        starPoints(12, 12, 9, -Math.PI / 2)
          .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
          .join(' ') + ' Z';
      return <path d={d} fill={accentHex} />;
    }
  }
}

/** the plate frame around a placeholder placard (`OUTLINE_HALO` fill — a fixed dark
 * chip, since the real placard's fill stays alliance and no alliance is picked here),
 * stroked in the ACCENT colour. `classic` is genuinely no frame, per `PLATE_KEYS`. */
function plateShape(plate: Plate, accentHex: string): ReactNode {
  const sign = <rect x="5" y="7" width="14" height="10" rx="1" fill={OUTLINE_HALO} />;
  if (plate === 'classic') return sign;
  const frame =
    plate === 'bold' ? (
      <rect x="3" y="5" width="18" height="14" rx="1" fill="none" stroke={accentHex} strokeWidth="3" />
    ) : (
      <rect x="3" y="5" width="18" height="14" rx="5" fill="none" stroke={accentHex} strokeWidth="2" />
    );
  return (
    <>
      {sign}
      {frame}
    </>
  );
}

/**
 * ROBOT COSMETICS: four rows — chassis colour, accent, decal, plate (`src/cosmetics.ts`).
 *
 * Shown to EVERYONE, with the options an account isn't entitled to `disabled`. A perk
 * that is invisible until you pay for it sells nothing and, worse, makes the tier feel
 * like a mystery box; a visible locked option is honest about what the membership
 * actually is. Free users get a real palette on every axis now, so the caption always
 * shows the CURRENT key — never a blanket "supporter perk", which used to be the only
 * thing a free player's caption ever said.
 */
function CosmeticsRows({
  spec,
  onPick,
}: {
  spec: RobotSpec;
  onPick: (patch: Partial<RobotSpec>) => void;
}) {
  /**
   * ⚠️ **THIS WAS A HARDCODED EMPTY LIST UNTIL `decal:star` EXISTED, AND THAT MADE THE FIRST
   * EARNED COSMETIC UNSELECTABLE.** The placeholder was honest about itself — "no earned
   * cosmetic exists yet … wiring the real one in later is this one name" — and it was still
   * missed when the GitHub star reward added the first key to fall through to `earned`. The
   * owner had the title, held the decal in `profiles.cosmetics`, and found the swatch locked.
   *
   * Everything either side of this line was already correct, which is what made it quiet:
   * `/api/user/entitlements` has sent `unlockedCosmetics` since 0044, and the server strips
   * an unentitled spec on join and on every re-pick. Only the PICKER believed nobody owned
   * anything, so the one surface where you choose a cosmetic was the one that said no.
   */
  const { supporter, earnedCosmetics: earned } = useAds();
  const current = clampCosmetics(spec);
  const chassisHex = chassisFill(current.chassisColor);
  const accentHex = accentFill(current.accent, current.chassisColor);

  return (
    <>
      <div className="ds-field wide">
        <span className="cap">
          Chassis colour <span className="val">{current.chassisColor}</span>
        </span>
        <div className="chassis-swatches">
          {CHASSIS_COLOR_KEYS.map((key) => {
            const id: CosmeticId = `chassisColor:${key}`;
            const locked = !cosmeticAllowed(id, supporter, earned);
            return (
              <CosmeticSwatch
                key={key}
                active={current.chassisColor === key}
                locked={locked}
                title={lockReason(id, supporter, earned)}
                label={`Chassis colour ${key}`}
                style={{ background: CHASSIS_COLORS[key] }}
                onClick={() => onPick({ chassisColor: key })}
              />
            );
          })}
        </div>
      </div>

      <div className="ds-field wide">
        <span className="cap">
          Accent <span className="val">{current.accent}</span>
        </span>
        <div className="chassis-swatches">
          {ACCENT_KEYS.map((key) => {
            const id: CosmeticId = `accent:${key}`;
            const locked = !cosmeticAllowed(id, supporter, earned);
            // 'match' has no fixed hex of its own — a split swatch of the chassis
            // colour against the outline halo is the honest preview: "whatever the
            // chassis is."
            const style: CSSProperties =
              key === 'match'
                ? { background: `linear-gradient(135deg, ${chassisHex} 50%, ${OUTLINE_HALO} 50%)` }
                : { background: CHASSIS_COLORS[key as keyof typeof CHASSIS_COLORS] };
            return (
              <CosmeticSwatch
                key={key}
                active={current.accent === key}
                locked={locked}
                title={lockReason(id, supporter, earned)}
                label={`Accent ${key}`}
                style={style}
                onClick={() => onPick({ accent: key })}
              />
            );
          })}
        </div>
      </div>

      <div className="ds-field wide">
        <span className="cap">
          Decal <span className="val">{current.decal}</span>
        </span>
        <div className="chassis-swatches">
          {DECAL_KEYS.map((key) => {
            const id: CosmeticId = `decal:${key}`;
            const locked = !cosmeticAllowed(id, supporter, earned);
            return (
              <CosmeticSwatch
                key={key}
                active={current.decal === key}
                locked={locked}
                title={lockReason(id, supporter, earned)}
                label={`Decal ${key}`}
                style={{ background: chassisHex }}
                onClick={() => onPick({ decal: key })}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  {decalShape(key, accentHex)}
                </svg>
              </CosmeticSwatch>
            );
          })}
        </div>
      </div>

      <div className="ds-field wide">
        <span className="cap">
          Plate <span className="val">{current.plate}</span>
        </span>
        <div className="chassis-swatches">
          {PLATE_KEYS.map((key) => {
            const id: CosmeticId = `plate:${key}`;
            const locked = !cosmeticAllowed(id, supporter, earned);
            return (
              <CosmeticSwatch
                key={key}
                active={current.plate === key}
                locked={locked}
                title={lockReason(id, supporter, earned)}
                label={`Plate ${key}`}
                style={{ background: chassisHex }}
                onClick={() => onPick({ plate: key })}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  {plateShape(key, accentHex)}
                </svg>
              </CosmeticSwatch>
            );
          })}
        </div>
      </div>
    </>
  );
}

/**
 * The robot loadout builder — the ROBOT section of `Configure`, which owns the
 * page heading. Robot-only by design: presets, the custom builder, intake, and
 * driver-preference tuning (drive style, assists, park). Its sibling Configure
 * sections hold the match setup, controls, and audio; the server region and
 * identity stay in Account. Matches start from `ModeSelect` — there is
 * deliberately no "start match" here.
 */
/**
 * The eight directions a bolted catapult can be aimed, laid out as the 3x3 chassis map every
 * other mount picker uses. YAW IS CCW FROM CHASSIS FORWARD and the robot frame has +y to the
 * LEFT, so left is +90 and right is −90 — the sign nobody should have to work out from a
 * slider. The middle cell is dead: a catapult throws outward, and there is no "into itself".
 */
const CATAPULT_DIRS: { label: string; yaw: number | null; title: string }[] = [
  { label: 'F·LEFT', yaw: 45, title: 'forward-left' },
  { label: 'FRONT', yaw: 0, title: 'straight ahead' },
  { label: 'F·RIGHT', yaw: -45, title: 'forward-right' },
  { label: 'LEFT', yaw: 90, title: 'out the left flank' },
  { label: '·', yaw: null, title: '' },
  { label: 'RIGHT', yaw: -90, title: 'out the right flank' },
  { label: 'B·LEFT', yaw: 135, title: 'back-left' },
  { label: 'BACK', yaw: 180, title: 'straight backward' },
  { label: 'B·RIGHT', yaw: -135, title: 'back-right' },
];

export function Menu({ settings, onChange }: Props) {
  const set = (patch: Partial<GameSettings>) => onChange({ ...settings, ...patch });
  // Apply a fully-formed spec. ASSISTS RIDE THE ROBOT, so the ACTIVE assists always
  // re-mirror from the incoming spec — loading a preset or a saved robot (or switching
  // games, via switchGame) brings that robot's own drive frame + automation with it.
  // Used by the drivetrain buttons, the intake/slider edits (via setSpec), and loads.
  const applySpec = (next: RobotSpec) => {
    onChange({
      ...settings,
      spec: next,
      assists: coerceAssists(next.assists, PLAYER_ASSISTS),
    });
  };
  // any spec edit RE-CLAMPS all coupled values (mass floor moves with drivetrain +
  // flywheel inertia; rpm ceiling with drivetrain; length with the intake preset)
  const setSpec = (patch: Partial<GameSettings['spec']>) => {
    // STRICT: every edit runs through the SAME canonical validator as load / save /
    // server / spawn (coerceSpec), so the live spec can never hold an out-of-range
    // size, mass, speed, or inertia — length is clamped per intake preset, width to
    // the 18" cube, mass to the drivetrain×inertia floor/ceiling, rpm to the
    // drivetrain range, identity TEXT (name/team) is kept as typed;
    // it is length-capped on save, not mid-keystroke.
    const merged = { ...settings.spec, ...patch };
    const next: GameSettings['spec'] = {
      ...coerceSpec(merged, undefined, settings.game),
      name: merged.name,
      teamName: merged.teamName,
    };
    applySpec(next);
  };
  // an assist edit writes ONTO THE ROBOT (`spec.assists`) and mirrors to the active
  // `assists`, so the choice is saved with the build — it rides saved-robot slots, the
  // per-game loadout, and account sync, instead of being a separate global preference.
  const setAssist = (patch: Partial<GameSettings['assists']>) => {
    const merged = { ...settings.assists, ...patch };
    onChange({
      ...settings,
      spec: { ...settings.spec, assists: merged },
      assists: merged,
    });
  };

  const spec = settings.spec;
  // the shooter-specific build controls (intake preset, flywheel inertia, color
  // sorter) are DECODE concepts — hidden for the Chain Reaction shell, whose real
  // intakes/config arrive with its rules. The shared chassis controls
  // (drivetrain/size/mass/rpm) stay for every game.
  const isDecode = settings.game === 'decode';
  // MODULE UI SLOTS. A game that fills one of these gets its own panel/schematic
  // instead of an `isDecode` arm; both current games fill neither, so every branch
  // below is exactly the one that was there before the slots existed.
  const mod = moduleFor(settings.game);
  const Preview = mod.Preview;
  const Builder = mod.Builder;
  const DrivingRows = mod.DrivingRows;
  // the saved-robot card's THUMBNAIL, when the game draws one: BIOBUZZ renders the build on the
  // 3D view. DECODE and CR draw none, and their cards are the name and the build line.
  const SavedThumb = mod.savedThumb;
  /** the game's 2D schematic of a build — the hero's picture and a saved card's, one spelling. TWO
   * components, not one with a `chain` flag: DECODE's schematic is main's, untouched, and Chain
   * Reaction's is its own, so work on one game's mechanisms can never change how the other's robot
   * looks. A game with a `Preview` slot draws its own (BIOBUZZ's, without `allow3d`, is 2D). */
  const preview2d = (s: RobotSpec, size: number) =>
    Preview ? (
      <Preview spec={s} size={size} alliance={settings.alliance} caption={false} />
    ) : isDecode ? (
      <RobotPreview spec={s} size={size} caption={false} />
    ) : (
      <ChainRobotPreview spec={s} size={size} caption={false} />
    );
  // slider envelopes come from the SAME limit functions coerceSpec clamps with,
  // in the same dependency order (intake → size, drivetrain → rpm, drivetrain ×
  // inertia → mass), so the UI and the validator can never disagree
  // SIZE envelopes, mirroring coerceSpec's game-aware clamp exactly so the slider can never
  // offer a value the coercer would immediately rewrite. CR's is the SAME 15-18" envelope for
  // every build: the sweeper deploys, so it never competed with the chassis for the starting
  // cube, and the mount is paid for in hopper volume instead (`chainMountStoreMult`).
  const crSize = chainSizeLimits(spec);
  const { min: minLength, max: maxLength } = isDecode
    ? lengthLimits(spec.intake)
    : { min: crSize.minLength, max: crSize.maxLength };
  const dtWidth = widthLimits(spec.intake, spec.drivetrain);
  const { min: minWidth, max: maxWidth } = isDecode
    ? dtWidth
    : { min: crSize.minWidth, max: crSize.maxWidth };
  const { min: minRpm, max: maxRpm } = rpmLimits(spec.drivetrain);
  // BUTTERFLY carries two independently geared wheel sets, so it gets a SECOND rpm slider.
  // The traction set runs the torque-biased tank envelope, which tops out lower.
  const isButterfly = spec.drivetrain === 'butterfly';
  const { min: minTankRpm, max: maxTankRpm } = butterflyTankRpmLimits();
  const tankRpmValue = butterflyTankRpm(spec);
  const { min: minMass, max: maxMass } = massLimits(
    spec.drivetrain,
    spec.flywheelInertia,
    // CR mechanisms that weigh something (today: the twin turret's second flywheel). Same
    // value coerceSpec uses, so the slider floor IS the enforced floor.
    isDecode ? 0 : chainMassFloorBump(spec),
  );
  const dp = driveParams(spec);
  // The builder shows DECODE robot presets or CR archetype presets per the active game —
  // unless the game FILLS THE SLOT, which is the only way a third game gets its own. The
  // two-valued form below is not a safe default for a game that fills neither branch: it is
  // an `else`, so BIOBUZZ was being offered Chain Reaction's robots under Chain Reaction's
  // labels. `mod.presets ? <slot> : <existing branch, unchanged>` — see `games/module.ts`.
  const gamePresets = mod.presets;
  const presets = gamePresets ? gamePresets.list : isDecode ? ROBOT_PRESETS : CHAIN_PRESETS;
  const presetMatches = gamePresets ? gamePresets.matches : isDecode ? specMatches : chainSpecMatches;
  // how many leading cards are real robots rather than archetype demos; each gets a "Real robot"
  // badge. 0 ⇒ none (every current non-slot game is one or the other).
  const realPresets = gamePresets?.realCount ?? 0;
  // THE HERO'S NUMBERS: how this build drives, what it weighs and how big it is. A fixed six,
  // in every game, so the grid is the same shape whatever a season contributes. The build's
  // WORDS (drivetrain, mechanisms) are the line under the team — `buildWords`, which reads the
  // game's `statTiles` slot before either inline arm, so a third game is described in its own
  // terms and never in Chain Reaction's. Drive rpm is not here: it is a slider with its value
  // printed beside it, and top speed and accel are what it changes.
  const heroTeam = teamLine(spec);
  const heroStats: readonly (readonly [string, string, string])[] = [
    ['Top speed', dp.maxSpeed.toFixed(0), 'in/s'],
    ['Accel', dp.accel.toFixed(0), 'in/s²'],
    ['Turn', dp.maxTurn.toFixed(1), 'rad/s'],
    ['Turn accel', dp.turnAccel.toFixed(0), 'rad/s²'],
    ['Mass', String(spec.massLb), 'lb'],
    ['W × L', `${spec.width} × ${spec.length}`, 'in'],
  ];

  // ---- the player's SAVED robot library (their own full robots, up to 3) ----
  const savedRobots = settings.savedRobots;
  // a saved slot is the active one when the whole robot matches (identity + build)
  const sameRobot = (a: RobotSpec, b: RobotSpec): boolean =>
    specMatches(a, b) &&
    a.name === b.name &&
    a.teamName === b.teamName &&
    a.teamNumber === b.teamNumber;
  const alreadySaved = savedRobots.some((r) => sameRobot(spec, r));
  /** why Save is off, or undefined when it is on */
  const saveBlocked = alreadySaved
    ? 'This robot is already saved'
    : savedRobots.length >= MAX_SAVED_ROBOTS
      ? `You have ${MAX_SAVED_ROBOTS} saved robots. Delete one first`
      : undefined;
  const saveCurrentRobot = (): void => {
    if (saveBlocked) return;
    set({ savedRobots: [...savedRobots, { ...spec }] });
  };
  const deleteSavedRobot = (i: number): void =>
    set({ savedRobots: savedRobots.filter((_, j) => j !== i) });

  function selectIntake(intake: IntakeStyle) {
    // setSpec re-clamps chassis length into the new preset's range (18in cube)
    setSpec({ intake });
  }

  return (
    <>
      {/* the page heading is owned by the Configure host */}
      <div className="ds-robot">
        {/* ---------- robot hero ----------
            PINNED AT THE TOP from 1100px up (owner, 2026-09-22), and ONE card at every width: the
            picture, who the robot is, what it is built from, and how it drives. It was a strip of
            nine one-line chips wrapped inside the sprite's 96px, which scrolled in both directions
            between 1100 and 1280 and clipped its top chip; and under 1100 it was a 509px card, 690px
            on a phone. The chips said the build's words and its numbers in one wall. They are two
            things now: the WORDS are one line under the team (`buildWords`, the same line every robot
            card prints) and the NUMBERS are a fixed grid, so no stat can widen the card. The layout
            follows the CARD's width, not the viewport's — see `.ds-hero` in shell.css. */}
        <div className="ds-hero">
          <div className="ds-hero-in">
            <div className="ds-hero-view">
              {/* NO CAPTION: the dimension line is small type under a picture, and the size is
                  already a stat. */}
              {Preview ? (
                // `allow3d`: this is ONE preview on screen and it is the whole point of the
                // screen, so a game with a 3D generator may mount a live scene here. The
                // strategy cards pass no such thing — see `GamePreviewProps`.
                <Preview spec={spec} size={200} alliance={settings.alliance} allow3d caption={false} />
              ) : (
                preview2d(spec, 200)
              )}
            </div>
            <div className="ds-hero-info">
              <div className="ds-hero-name">
                <Marquee text={spec.name || 'Unnamed'} />
              </div>
              {heroTeam ? (
                <div className="ds-hero-team">
                  <Marquee text={heroTeam} />
                </div>
              ) : null}
              <div className="ds-hero-build">{buildWords(spec, settings.game).join(' · ')}</div>
            </div>
            <dl className="ds-hero-stats">
              {heroStats.map(([label, value, unit]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {value}
                    <span className="u">{unit}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        {/* ---------- START FROM: the player's own garage, then the presets ----------
            ONE panel, and the garage is in it only when there is something in it. It used to be
            the FIRST section on the page in every state, so a new player's first screen was an
            empty `SAVED ROBOTS 0/3` sitting above the presets that would actually give them a
            robot. Saving moved to where you are when you have finished building — the Build
            panel's header action. */}
        <section className="ds-panel">
          <div className="ds-panel-h">
            <h2 className="ds-panel-title">Start from</h2>
          </div>
          <div className="ds-panel-body stack">
            {/* ONE CARD SYSTEM for both rows (`RobotCard`): a name, a team when there is one, and
                one build line. `.robots` is an auto-FILL grid, so a lone saved robot is one card
                wide, the width of a preset, instead of a slab across the whole panel. */}
            {savedRobots.length > 0 && (
              <div className="ds-field">
                <span className="cap">
                  Your robots{' '}
                  <span className="val">
                    {savedRobots.length}/{MAX_SAVED_ROBOTS}
                  </span>
                </span>
                <div className="ds-opts robots">
                  {savedRobots.map((r, i) => (
                    <RobotCard
                      key={i}
                      spec={r}
                      game={settings.game}
                      on={sameRobot(spec, r)}
                      team={teamLine(r)}
                      // A PICTURE ON EVERY SAVED ROBOT, in every game (owner, 2026-09-23): the
                      // game's own when it draws one (BIOBUZZ: the 3D render, or its schematic on
                      // the 2D view), else the same 2D schematic the hero draws. The card's left
                      // column; it never replaces the line.
                      thumb={
                        SavedThumb ? (
                          <SavedThumb spec={r} alliance={settings.alliance} />
                        ) : (
                          <span className="ds-robot-card-thumb">{preview2d(r, 88)}</span>
                        )
                      }
                      onPick={() => applySpec({ ...r })}
                      onDelete={() => deleteSavedRobot(i)}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="ds-field">
              {savedRobots.length > 0 && <span className="cap">Presets</span>}
              {/* ONE ROW that scrolls sideways (owner, 2026-09-23), so every preset card is the
                  same width and, sharing the row, the same height. Focusable so the arrow keys
                  scroll it. */}
              <div className="ds-opts robots strip" role="group" aria-label="Presets" tabIndex={0}>
                {presets.map((p, i) => (
                  <RobotCard
                    key={p.name}
                    spec={p}
                    game={settings.game}
                    on={presetMatches(spec, p)}
                    // `real` badges a documented, real-world robot. Marking the CARDS rather than
                    // ruling a line between the two groups is what survives `.ds-opts` being an
                    // auto-fill grid: a divider "after the fourth card" lands mid-row the moment
                    // the grid reflows to three or five columns, but a per-card mark never lies.
                    real={i < realPresets}
                    // a REAL team's number and name are who built it. A demo's `teamName` is a
                    // tagline ("Dumper · sweeps both ends, shifts to push") that the build line
                    // under it already says, so it is not printed.
                    team={p.teamNumber ? teamLine(p) : undefined}
                    onPick={() =>
                      // copy the BUILD only — keep the player's own name/team/number.
                      // applySpec swaps assists to the preset's drivetrain slot (so the
                      // Cypher swerve preset loads field-centric, the rest robot-centric).
                      applySpec({
                        ...p,
                        name: spec.name,
                        teamName: spec.teamName,
                        teamNumber: spec.teamNumber,
                      })
                    }
                  />
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ---------- builder ----------
            SAVE IS THE PANEL'S ACTION, not a card at the top of the page: you are here when
            you have finished building, and this is the one button on the screen that adds
            something rather than changing something. */}
        <section className="ds-panel">
          <div className="ds-panel-h">
            <h2 className="ds-panel-title">Build</h2>
            {/* THE DISABLED REASON IS SPOKEN, not only hovered: a `title` never reaches a
                keyboard or a phone. Screen-reader text rather than a visible line, because the
                reason flips on and off with every edit and a line appearing would move the panel. */}
            <button
              className="ds-btn primary small"
              disabled={!!saveBlocked}
              title={saveBlocked}
              aria-describedby={saveBlocked ? 'ds-save-why' : undefined}
              onClick={saveCurrentRobot}
            >
              Save this robot
            </button>
            {saveBlocked && (
              <span id="ds-save-why" className="ds-sr">
                {saveBlocked}
              </span>
            )}
          </div>
          <div className="ds-panel-body stack">
            <div className="ds-fields">
              <label className="ds-field">
                <span className="cap">Robot name</span>
                <input
                  className="ds-input"
                  type="text"
                  maxLength={24}
                  value={spec.name}
                  onChange={(e) => setSpec({ name: e.target.value })}
                />
              </label>
              <label className="ds-field">
                <span className="cap">Team name</span>
                <input
                  className="ds-input"
                  type="text"
                  maxLength={48}
                  value={spec.teamName}
                  onChange={(e) => setSpec({ teamName: e.target.value })}
                />
              </label>
              <label className="ds-field narrow">
                <span className="cap">Team #</span>
                <input
                  className="ds-input"
                  type="number"
                  min={0}
                  max={99999}
                  value={spec.teamNumber || ''}
                  onChange={(e) =>
                    setSpec({ teamNumber: Math.max(0, Math.round(Number(e.target.value) || 0)) })
                  }
                />
              </label>
            </div>

            {/* ONE SUBSYSTEM PER BLOCK. Each mechanism's picker sits with the sliders that
                tune THAT mechanism (catapult range/yaw under Catalyst, RPM under Drivetrain,
                storage under Scoring) instead of the old layout, where every picker came
                first and every slider was pooled at the bottom — so the catapult sliders sat
                under the chassis dimensions and read as frame settings.

                ORDER IS LOAD-BEARING: FRAME (length/width/mass) comes LAST because every
                block above clamps it — the catalyst and flywheel raise the mass floor, and
                the drivetrain sets both mass and rpm. Picking
                a mechanism and watching a slider below re-clamp reads as cause and effect;
                the reverse reads as the builder fighting you. */}
            <h3 className="ds-subh">Drivetrain</h3>
            <div className="ds-opts five">
              {(Object.keys(DRIVETRAIN_LABELS) as DrivetrainType[]).map((d) => (
                <button
                  key={d}
                  aria-pressed={spec.drivetrain === d}
                  className={`ds-opt mini ${spec.drivetrain === d ? 'on' : ''}`}
                  onClick={() => setSpec({ drivetrain: d })}
                >
                  <span className="ot">{DRIVETRAIN_LABELS[d]}</span>
                </button>
              ))}
            </div>
            <div className="ds-fields">
              <label className="ds-field">
                <span className="cap">
                  {isButterfly ? 'Mecanum RPM' : 'Drive RPM'} <span className="val">{spec.driveRpm}</span>
                </span>
                <input
                  className="ds-range"
                  type="range"
                  min={minRpm}
                  max={maxRpm}
                  step={5}
                  value={spec.driveRpm}
                  aria-valuetext={`${spec.driveRpm} rpm`}
                  style={rangeFill(spec.driveRpm, minRpm, maxRpm)}
                  onChange={(e) => setSpec({ driveRpm: Number(e.target.value) })}
                />
              </label>
              {isButterfly && (
                <label className="ds-field">
                  <span className="cap">
                    Traction RPM <span className="val">{tankRpmValue}</span>
                  </span>
                  <input
                    className="ds-range"
                    type="range"
                    min={minTankRpm}
                    max={maxTankRpm}
                    step={5}
                    value={tankRpmValue}
                    aria-valuetext={`${tankRpmValue} rpm`}
                    style={rangeFill(tankRpmValue, minTankRpm, maxTankRpm)}
                    onChange={(e) => setSpec({ tankRpm: Number(e.target.value) })}
                  />
                </label>
              )}
            </div>

            {/* THE CHROME ABOVE IS EVERY GAME'S, SO IT SITS OUTSIDE THIS TERNARY. A filled
                `GameModule.Builder` slot replaces only the per-game mechanism blocks below;
                it used to replace the whole section, and BIOBUZZ lost the identity fields,
                the drivetrain picker, the RPM sliders and the chassis colour row with it. */}
            {Builder ? (
              <Builder
                spec={spec}
                onChange={setSpec}
                game={settings.game}
                alliance={settings.alliance}
                startIndex={settings.startIndex}
                startPose={settings.startPose}
              />
            ) : (
              <>
                {/* ---- SCORING ---- */}
                <h3 className="ds-subh">Scoring</h3>
                {isDecode ? (
                  <>
                    <div className="ds-fields">
                      <label className="ds-field">
                        <span className="cap">
                          Flywheel inertia <span className="val">{spec.flywheelInertia.toFixed(2)}</span>
                        </span>
                        <input
                          className="ds-range"
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={spec.flywheelInertia}
                          style={rangeFill(spec.flywheelInertia, 0, 1)}
                          // a bigger flywheel weighs more: setSpec raises the mass floor
                          // and pulls mass up with it so the loadout stays legal
                          onChange={(e) => setSpec({ flywheelInertia: Number(e.target.value) })}
                        />
                      </label>
                    </div>
                    {/* its OWN row, not a column of `.ds-fields`: as the one non-`.ds-field`
                        child of that row it was stretched to the slider's height with its
                        label pinned to the top edge, landing on the slider's caption line. */}
                    <ToggleRow
                      label="Colour sorter"
                      value={spec.canSort}
                      onPick={(canSort) => setSpec({ canSort })}
                    />
                  </>
                ) : (
                  <>
                    <div className="ds-opts card4">
                      {CHAIN_SCORE_MODES.map((m) => (
                        <button
                          key={m}
                          aria-pressed={(spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE) === m}
                          className={`ds-opt ${(spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE) === m ? 'on' : ''}`}
                          onClick={() => setSpec({ scoreMode: m })}
                        >
                          <span className="ot">{CHAIN_MODE_LABELS[m]}</span>
                          <span className="od">{CHAIN_MODE_BLURBS[m]}</span>
                        </button>
                      ))}
                    </div>
                    {/* The mount means two different things, so it is TWO different pickers.
                        TURRETLESS: which chassis EDGE the launcher fires over — four sides, and a
                        corner is not buildable because the launch line spans a side.
                        TURRETED: where the turret is BOLTED. It aims itself, so this is a position,
                        not a facing — and it is where the Particle is actually born. Nine positions
                        laid out as a 3x3 map of the chassis (front row on top), so the picker reads
                        as a top-down diagram rather than a list of words. */}
                    {isTurreted(spec.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE) ? (
                      <div className="ds-opts three">
                        {CHAIN_TURRET_POSITIONS.map((m) => (
                          <button
                            key={m}
                            aria-pressed={shooterMountOf(spec) === m}
                            className={`ds-opt mini ${shooterMountOf(spec) === m ? 'on' : ''}`}
                            onClick={() => setSpec({ shooterMount: m })}
                          >
                            <span className="ot">{CHAIN_SHOOTER_MOUNT_LABELS[m]}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="ds-opts four">
                        {CHAIN_SHOOTER_MOUNTS.map((m) => (
                          <button
                            key={m}
                            aria-pressed={shooterMountOf(spec) === m}
                            className={`ds-opt mini ${shooterMountOf(spec) === m ? 'on' : ''}`}
                            onClick={() => setSpec({ shooterMount: m })}
                          >
                            <span className="ot">{CHAIN_SHOOTER_MOUNT_LABELS[m]}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* ---- INTAKE ---- */}
                <h3 className="ds-subh">Intake</h3>
                {isDecode ? (
                  // label-only, so CHIP height like the drivetrain row above it — a 62px slab
                  // directly under 36px chips read as a different kind of control
                  <div className="ds-opts five">
                    {(Object.keys(INTAKE_LABELS) as IntakeStyle[]).map((i) => (
                      <button
                        key={i}
                        aria-pressed={spec.intake === i}
                        className={`ds-opt mini ${spec.intake === i ? 'on' : ''}`}
                        onClick={() => selectIntake(i)}
                      >
                        <span className="ot">{INTAKE_LABELS[i]}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    {/* CR has ONE intake design, so this is a statement, not a picker.
                        `.static` keeps the card look and drops the pointer affordances —
                        NOT `disabled`, which would grey it out and say "unavailable" about
                        the only intake the robot has. */}
                    <div className="ds-opts fill">
                      <div className="ds-opt on static">
                        <span className="ot">{CHAIN_INTAKE_LABELS.sweeper}</span>
                      </div>
                    </div>
                    <div className="ds-opts four">
                      {CHAIN_INTAKE_MOUNTS.map((m) => (
                        <button
                          key={m}
                          aria-pressed={intakeMountOf(spec) === m}
                          className={`ds-opt mini ${intakeMountOf(spec) === m ? 'on' : ''}`}
                          onClick={() => setSpec({ intakeMount: m })}
                        >
                          <span className="ot">{CHAIN_INTAKE_MOUNT_LABELS[m]}</span>
                          {CHAIN_INTAKE_MOUNT_BLURBS[m] ? (
                            <span className="od">{CHAIN_INTAKE_MOUNT_BLURBS[m]}</span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {/* ---- CATALYST (CR only) ---- */}
                {!isDecode && (
                  <>
                    <h3 className="ds-subh">Catalyst</h3>
                    <div className="ds-opts card4">
                      {CHAIN_CATALYST_TYPES.map((t) => (
                        <button
                          key={t}
                          aria-pressed={(spec.catalystType ?? CHAIN_DEFAULT_CATALYST) === t}
                          className={`ds-opt ${(spec.catalystType ?? CHAIN_DEFAULT_CATALYST) === t ? 'on' : ''}`}
                          onClick={() => setSpec({ catalystType: t })}
                        >
                          <span className="ot">{CHAIN_CATALYST_LABELS[t]}</span>
                          <span className="od">{CHAIN_CATALYST_BLURBS[t]}</span>
                        </button>
                      ))}
                    </div>
                    {/* SWING is a property of the MECHANISM, not a place to put it. It used to be
                        the centre cell of this grid, which made "a swing" and "on the right"
                        mutually exclusive picks — so a fore-aft swing arm bolted to the right
                        rail, an ordinary build, could not be expressed at all. The DIRECTION
                        matters as much as the fact of it: which positions a pivot can use follows
                        from which way it turns, so the grid below re-gates on this. */}
                    {/* ARM ONLY. A turret claw already aims through a full circle and a rail
                        already traverses, so a pivot adds nothing to either — it is the fixed
                        arm, the one mechanism that has to be pointed at its work, for which
                        swinging is a real build decision. `coerceSpec` drops a swing on anything
                        else, so this is a gate on an offer, not on a capability the sim keeps. */}
                    {(spec.catalystType ?? CHAIN_DEFAULT_CATALYST) === 'arm' && (
                      <div className="ds-opts three">
                        {([null, 'fb', 'lr'] as const).map((axis) => (
                          <button
                            key={axis ?? 'fixed'}
                            aria-pressed={catalystSwingOf(spec) === axis}
                            className={`ds-opt mini ${catalystSwingOf(spec) === axis ? 'on' : ''}`}
                            onClick={() => {
                              // moving to a pivot from a mount it cannot use takes the nearest one
                              // that works on THIS axis, rather than refusing the click
                              const m = catalystMountOf(spec);
                              setSpec({
                                catalystSwing: axis ?? undefined,
                                catalystMount: axis ? swingHomeFor(m, axis) : m === 'center' ? 'front' : m,
                              });
                            }}
                            // Fixed needs no tooltip — the label is the whole story. The two
                            // swings each keep the one fact the arrow glyph cannot show.
                            title={
                              axis === null
                                ? undefined
                                : axis === 'fb'
                                  ? 'Reaches from either end'
                                  : 'Reaches from either flank'
                            }
                          >
                            <span className="ot">{axis === null ? 'Fixed' : axis === 'fb' ? 'Swing ↕' : 'Swing ↔'}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {/* Same 3x3 chassis map as the turret picker: where the mechanism is BOLTED. */}
                    {(() => {
                      // A cell is unavailable for three physical reasons, and the picker says
                      // WHICH — coerceSpec would quietly relocate the mount otherwise, and a
                      // button that moves your choice somewhere else without explaining is
                      // worse than one that refuses.
                      const railed = (spec.catalystType ?? CHAIN_DEFAULT_CATALYST) === 'rail';
                      const swung = catalystSwingOf(spec);
                      const blockOf = (m: (typeof CHAIN_CATALYST_MOUNTS)[number]): string | undefined => {
                        if (railed && !isEdgePos(m))
                          return 'A rail needs a whole chassis side to run along. Corners and the centre have no span for a track';
                        if (
                          mountsClash(
                            { pos: m, spansEdge: railed, swing: swung },
                            { pos: shooterMountOf(spec), spansEdge: !isTurreted(spec.scoreMode) },
                          )
                        )
                          return 'The shooter is mounted here';
                        // a pivot needs BOTH of its working ends reachable, which depends on the
                        // axis: a fore-aft arm wants a front and a back, a lateral one wants two
                        // flanks. And with no pivot at all, the middle reaches nothing.
                        if (swung && !isSwingMount(m, swung))
                          return swung === 'lr'
                            ? 'A left-right swing pivots between the flanks. Bolt it to the centre line or an end'
                            : 'A front-back swing pivots between the ends. Bolt it to the centre line or a flank';
                        if (!swung && m === 'center')
                          return 'Nothing reaches from the middle of a chassis. Turn on the swing arm to work from here';
                        // an ENABLED cell gets none: its label already names the mount, and the
                        // swing picker above names the swing
                        return undefined;
                      };
                      // THE REASONS ALSO PRINT UNDER THE MAP: a disabled cell's `title` never
                      // reaches a keyboard (it cannot take focus) or a phone (no hover).
                      const refused = new Map<string, string[]>();
                      for (const m of CHAIN_CATALYST_MOUNTS) {
                        const why = blockOf(m);
                        if (why) refused.set(why, [...(refused.get(why) ?? []), CHAIN_CATALYST_MOUNT_LABELS[m]]);
                      }
                      return (
                        <>
                          <div className="ds-opts three">
                            {CHAIN_CATALYST_MOUNTS.map((m) => {
                              const why = blockOf(m);
                              return (
                                <button
                                  key={m}
                                  aria-pressed={catalystMountOf(spec) === m}
                                  className={`ds-opt mini ${catalystMountOf(spec) === m ? 'on' : ''}${why ? ' off' : ''}`}
                                  disabled={why !== undefined}
                                  onClick={() => setSpec({ catalystMount: m })}
                                  title={why}
                                >
                                  <span className="ot">{CHAIN_CATALYST_MOUNT_LABELS[m]}</span>
                                </button>
                              );
                            })}
                          </div>
                          {[...refused].map(([why, where]) => (
                            <p className="ds-hint" key={why}>
                              {where.join(', ')}: {why}
                            </p>
                          ))}
                        </>
                      );
                    })()}
                    {(spec.catalystType ?? CHAIN_DEFAULT_CATALYST) === 'launcher' && (
                      <div className="ds-fields">
                        <label className="ds-field">
                          <span className="cap">
                            Catapult range <span className="val">{chainCatapultRange(spec)}"</span>
                          </span>
                          <input
                            className="ds-range"
                            type="range"
                            min={CHAIN_CATAPULT_RANGE_MIN}
                            max={CHAIN_CATAPULT_RANGE_MAX}
                            step={5}
                            value={chainCatapultRange(spec)}
                            aria-valuetext={`${chainCatapultRange(spec)} inches`}
                            style={rangeFill(chainCatapultRange(spec), CHAIN_CATAPULT_RANGE_MIN, CHAIN_CATAPULT_RANGE_MAX)}
                            onChange={(e) => setSpec({ catapultRange: Number(e.target.value) })}
                          />
                        </label>
                        {/* WHICH WAY IT THROWS. The catapult is bolted, not turreted — it fires
                            along the chassis plus this offset — so the direction is a build
                            decision, and picking it off a slider means doing trigonometry to
                            answer "out of the back". Eight compass points on the same 3x3 map as
                            every other mount picker; the slider under it stays for the angles
                            between them. */}
                        <div className="ds-opts three wide">
                          {CATAPULT_DIRS.map((d) => (
                            <button
                              key={d.label}
                              aria-pressed={(spec.catapultYaw ?? 0) === d.yaw}
                              className={`ds-opt mini ${(spec.catapultYaw ?? 0) === d.yaw ? 'on' : ''}${d.yaw === null ? ' off' : ''}`}
                              disabled={d.yaw === null}
                              onClick={() => d.yaw !== null && setSpec({ catapultYaw: d.yaw })}
                              // the DEGREES are the only thing the label doesn't already say,
                              // and the sign convention is not guessable (see CATAPULT_DIRS).
                              // The dead centre cell is `disabled`, which says enough.
                              title={d.yaw === null ? undefined : `${d.yaw}°`}
                            >
                              <span className="ot">{d.label}</span>
                            </button>
                          ))}
                        </div>
                        <label className="ds-field">
                          <span className="cap">
                            Catapult yaw <span className="val">{spec.catapultYaw ?? 0}°</span>
                          </span>
                          <input
                            className="ds-range"
                            type="range"
                            min={-180}
                            max={180}
                            step={CHAIN_CATAPULT_YAW_STEP}
                            value={spec.catapultYaw ?? 0}
                            aria-valuetext={`${spec.catapultYaw ?? 0} degrees`}
                            style={rangeFill(spec.catapultYaw ?? 0, -180, 180)}
                            onChange={(e) => setSpec({ catapultYaw: Number(e.target.value) })}
                          />
                        </label>
                      </div>
                    )}
                  </>
                )}

                {/* ---- FRAME: clamped by every block above, so it comes last ---- */}
                <h3 className="ds-subh">Frame</h3>
                <div className="ds-fields">
                  <label className="ds-field">
                    <span className="cap">
                      Length <span className="val">{spec.length}"</span>
                    </span>
                    <input
                      className="ds-range"
                      type="range"
                      min={minLength}
                      max={maxLength}
                      step={0.5}
                      value={spec.length}
                      aria-valuetext={`${spec.length} inches`}
                      style={rangeFill(spec.length, minLength, maxLength)}
                      onChange={(e) => setSpec({ length: Number(e.target.value) })}
                    />
                  </label>
                  <label className="ds-field">
                    <span className="cap">
                      Width <span className="val">{spec.width}"</span>
                    </span>
                    <input
                      className="ds-range"
                      type="range"
                      min={minWidth}
                      max={maxWidth}
                      step={0.5}
                      value={spec.width}
                      aria-valuetext={`${spec.width} inches`}
                      style={rangeFill(spec.width, minWidth, maxWidth)}
                      onChange={(e) => setSpec({ width: Number(e.target.value) })}
                    />
                  </label>
                  <label className="ds-field">
                    <span className="cap">
                      Mass <span className="val">{spec.massLb} lb</span>
                    </span>
                    <input
                      className="ds-range"
                      type="range"
                      min={minMass}
                      max={maxMass}
                      step={1}
                      value={spec.massLb}
                      aria-valuetext={`${spec.massLb} pounds`}
                      style={rangeFill(spec.massLb, minMass, maxMass)}
                      onChange={(e) => setSpec({ massLb: Number(e.target.value) })}
                    />
                  </label>
                  {!isDecode && (
                    <label className="ds-field">
                      <span className="cap">
                        Ground clearance{' '}
                        <span className="val">{(spec.groundClearance ?? CHAIN_CLEARANCE_DEFAULT).toFixed(1)}"</span>
                      </span>
                      <input
                        className="ds-range"
                        type="range"
                        min={CHAIN_CLEARANCE_MIN}
                        max={CHAIN_CLEARANCE_MAX}
                        step={0.1}
                        value={spec.groundClearance ?? CHAIN_CLEARANCE_DEFAULT}
                        aria-valuetext={`${(spec.groundClearance ?? CHAIN_CLEARANCE_DEFAULT).toFixed(1)} inches`}
                        style={rangeFill(
                          spec.groundClearance ?? CHAIN_CLEARANCE_DEFAULT,
                          CHAIN_CLEARANCE_MIN,
                          CHAIN_CLEARANCE_MAX,
                        )}
                        onChange={(e) => setSpec({ groundClearance: Number(e.target.value) })}
                      />
                    </label>
                  )}
                  {/* BALL STORAGE sits with the FRAME, under the dimensions, because that is what
                      sets it: the cap is footprint x archetype x intake mount (chainStorageMax),
                      so it re-clamps as you drag Length/Width right above it. Full-width on its
                      own row deliberately — a fifth 140px column would orphan-wrap, and the
                      "12 / 24 particles" value needs the room. */}
                  {!isDecode && (() => {
                    const storeMax = chainStorageMax(spec);
                    const store = Math.min(spec.ballStorage ?? CHAIN_STORAGE_DEFAULT, storeMax);
                    return (
                      <label className="ds-field wide">
                        <span className="cap">
                          Ball storage <span className="val">{store} / {storeMax} particles</span>
                        </span>
                        <input
                          className="ds-range"
                          type="range"
                          min={CHAIN_STORAGE_MIN}
                          max={storeMax}
                          step={1}
                          value={store}
                          aria-valuetext={`${store} of ${storeMax} particles`}
                          style={rangeFill(store, CHAIN_STORAGE_MIN, storeMax)}
                          onChange={(e) => setSpec({ ballStorage: Number(e.target.value) })}
                        />
                      </label>
                    );
                  })()}
                </div>
              </>
            )}
          </div>
        </section>

        {/* ---------- LOOK ----------
            ITS OWN PANEL, IN EVERY SEASON. The four rows used to render as `.ds-field wide`
            children of the Frame row, so "what colour is it" was laid out as though it were a
            chassis dimension — and BIOBUZZ put them somewhere else again, because its module
            `Builder` owns the frame and the host appended them after it. One place now. */}
        <section className="ds-panel">
          <div className="ds-panel-h">
            <h2 className="ds-panel-title">Look</h2>
          </div>
          <div className="ds-panel-body stack">
            <div className="ds-fields">
              <CosmeticsRows spec={spec} onPick={setSpec} />
            </div>
          </div>
        </section>

        {/* ---------- DRIVING ----------
            Drive style, tank sticks, the assists and park were four `.ds-sec`s of one or two
            controls each, at the bottom of the longest page in the app. They are one panel:
            every one of them is a fact about how the robot answers the sticks, and all four
            ride `spec.assists` / `GameSettings`, so they save with the build. */}
        <section className="ds-panel">
          <div className="ds-panel-h">
            <h2 className="ds-panel-title">Driving</h2>
          </div>
          <div className="ds-panel-body stack">
            <OptRow<boolean>
              label="Drive style"
              value={settings.assists.fieldCentric}
              cols="two"
              // neither side carries a sub-line any more, so these are chip-height tiles —
              // `ToggleRow`'s rule, for the same reason: two 62px slabs for one pick is a lot
              // of screen for nothing to sit in.
              mini
              onPick={(fieldCentric) => setAssist({ fieldCentric })}
              options={[
                { v: false, t: 'Robot-centric' },
                { v: true, t: 'Field-centric' },
              ]}
            />
            {spec.drivetrain === 'tank' && (
              <OptRow<GameSettings['tankControlMode']>
                label="Tank sticks"
                value={settings.tankControlMode}
                cols="two"
                mini
                onPick={(tankControlMode) => set({ tankControlMode })}
                options={[
                  // NO SUB-LINES, and no key names. Both of these said their own label back
                  // ("One stick each · Drive on one, turn on the other"), and a key name is a
                  // claim that goes stale the moment somebody opens Controls — the same reason
                  // the tutorial's hints are functions of the bindings rather than strings.
                  { v: 'normal', t: 'One stick each' },
                  { v: 'traditional', t: 'One side each' },
                ]}
              />
            )}
            {/* AIM ASSIST IS NOT OFFERED — it is always on, in all three games. The flag and
                the sims' manual-aim paths both still exist (`coerceAssists` forces the stored
                value true), so putting the toggle back is one more row here. */}
            <ToggleRow
              label="Auto intake"
              value={settings.assists.autoIntake}
              onPick={(autoIntake) => setAssist({ autoIntake })}
            />
            {mod.offersAutoFire !== false && (
              <ToggleRow
                label="Auto fire"
                value={settings.assists.autoFire}
                onPick={(autoFire) => setAssist({ autoFire })}
              />
            )}
            <label className="ds-field">
              <span className="cap">
                Park speed cap <span className="val">{settings.parkSpeedPct}%</span>
              </span>
              <input
                className="ds-range"
                type="range"
                min={0}
                max={100}
                step={5}
                value={settings.parkSpeedPct}
                aria-valuetext={`${settings.parkSpeedPct} percent`}
                style={rangeFill(settings.parkSpeedPct, 0, 100)}
                onChange={(e) => set({ parkSpeedPct: Number(e.target.value) })}
              />
            </label>
            {DrivingRows && (
              <DrivingRows
                spec={spec}
                onChange={setSpec}
                game={settings.game}
                alliance={settings.alliance}
                startIndex={settings.startIndex}
                startPose={settings.startPose}
              />
            )}
          </div>
        </section>
      </div>
    </>
  );
}