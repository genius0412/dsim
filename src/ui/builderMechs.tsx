import type { ChainScoreMode, IntakeStyle, RobotSpec } from '../types';
import type { GameId } from '../games/types';
import {
  CHAIN_CLEARANCE_DEFAULT,
  CHAIN_CLEARANCE_MAX,
  CHAIN_CLEARANCE_MIN,
  CHAIN_STORAGE_DEFAULT,
  CHAIN_STORAGE_MIN,
  CHAIN_SCORE_MODES,
  CHAIN_DEFAULT_SCORE_MODE,
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
import { lengthLimits, massLimits, widthLimits } from '../sim/drivetrain';
import { ToggleRow } from './OptRow';
import { rangeFill } from './rangeFill';
import { DecodeLauncherRows } from './LauncherRows';

/**
 * DECODE's and Chain Reaction's MECHANISM BLOCKS — Scoring, Intake, Catalyst and Frame — moved
 * here VERBATIM out of `Menu.tsx` (2026-10-01) so the robot importer can render the same controls.
 *
 * ── WHY A MOVE AND NOT A `GameModule.Builder` SLOT ───────────────────────────────────────────
 * `games/module.ts` records why DECODE and Chain Reaction fill no `Builder` slot: their inline
 * branches are the two games people play, and routing them through a slot would put a behaviour
 * change inside a commit whose job is something else. This is the same code in a file of its own;
 * `Menu` renders it in exactly the place the inline block was, with the same props, so the builder's
 * DOM is unchanged (the importer lane captured Configure ▸ Robot before and after to prove it).
 *
 * ── `hideFrame` (the importer) ──────────────────────────────────────────────────────────────
 * An imported robot's length, width and mass come from its CAD and its scale, so the importer hides
 * those three sliders. What the frame block holds beyond them stays: Chain Reaction's ground
 * clearance and ball storage are build choices a CAD file does not state.
 */

const INTAKE_LABELS: Record<IntakeStyle, string> = {
  sloped: 'Sloped',
  vector: 'Vector wheel',
  triangle: 'Triangle',
  none: 'Hand loaded',
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

export function BuiltinMechRows({
  spec,
  setSpec,
  game,
  hideFrame = false,
}: {
  spec: RobotSpec;
  /** apply a partial edit; the host re-coerces (Menu's `setSpec`) */
  setSpec: (patch: Partial<RobotSpec>) => void;
  game: GameId;
  /** the importer: no length, width or mass sliders (they come from the CAD) */
  hideFrame?: boolean;
}) {
  const isDecode = game === 'decode';
  function selectIntake(intake: IntakeStyle) {
    // setSpec re-clamps chassis length into the new preset's range (18in cube)
    setSpec({ intake });
  }
  // SIZE envelopes, mirroring coerceSpec's game-aware clamp exactly (see Menu.tsx)
  const crSize = chainSizeLimits(spec);
  const { min: minLength, max: maxLength } = isDecode
    ? lengthLimits(spec.intake)
    : { min: crSize.minLength, max: crSize.maxLength };
  const dtWidth = widthLimits(spec.intake, spec.drivetrain);
  const { min: minWidth, max: maxWidth } = isDecode
    ? dtWidth
    : { min: crSize.minWidth, max: crSize.maxWidth };
  const { min: minMass, max: maxMass } = massLimits(
    spec.drivetrain,
    spec.flywheelInertia,
    // CR mechanisms that weigh something (today: the twin turret's second flywheel). Same
    // value coerceSpec uses, so the slider floor IS the enforced floor.
    isDecode ? 0 : chainMassFloorBump(spec),
  );
  return (
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
          {/* the LAUNCHER: turret or fixed, adjustable or fixed hood, solved or setpoint speed */}
          <DecodeLauncherRows spec={spec} setSpec={setSpec} />
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
      {(!hideFrame || !isDecode) && (
        <>
      <h3 className="ds-subh">Frame</h3>
      <div className="ds-fields">
            {!hideFrame && (
              <>
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
              </>
            )}
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
    </>
  );
}
