import type { RobotSpec } from '../../types';
import { rangeFill } from '../../ui/rangeFill';
import { BB_DEFAULT_SCORE_MODE, BB_STORAGE_MIN } from './config';
import {
  BB_MOUNT_POSITIONS,
  BB_SCORE_MODES,
  BB_SHOOTER_EDGES,
  BB_INTAKE_MOUNTS,
  type BbScoreMode,
  bbIntakeMountOf,
  bbShooterEdgeOf,
  bbShooterMountOf,
  isTurreted,
} from './mounts';
import {
  BB_INTAKE_LABELS,
  BB_INTAKE_MOUNT_BLURBS,
  BB_INTAKE_MOUNT_LABELS,
  BB_MODE_BLURBS,
  BB_MODE_LABELS,
  BB_MOUNT_POS_LABELS,
} from './labels';
import { bbDials } from './robotConfig';

/**
 * The BIOBUZZ half of the My Robot builder — the `GameModule.Builder` slot.
 *
 * ── WHY THIS IS A MODULE SLOT AND NOT A BRANCH IN `Menu.tsx` ────────────────
 * `Menu.tsx` renders the builder for whichever game is loaded, and today it does it with an
 * `isDecode ? … : …` down the middle of every block — archetype, intake, mechanism, frame
 * extras. A third game turns each of those into a three-way and the file grows a season every
 * year. So the per-game blocks move OUT: the host renders the game-neutral chrome (name, team,
 * drivetrain, RPM, the chassis colour row) and drops this component in for everything only
 * BIOBUZZ knows about.
 *
 * ── WHAT IS IN HERE, AND WHY IT INCLUDES THE FRAME DIALS ───────────────────
 * SCORING, INTAKE and FRAME. The frame sliders look shared, and their fields are — but their
 * RANGES are not: `bbDials` intersects the R102 expansion prism with the mounted sweepers'
 * reach, so a front+back sweeper genuinely has a shorter legal chassis than a front one. A
 * host rendering the dials from DECODE's limits would offer lengths the coercer then claws
 * back, which reads to the player as the slider snapping out from under them. The ranges have
 * to come from the game, so the sliders come with them.
 *
 * ── ORDER IS LOAD-BEARING ──────────────────────────────────────────────────
 * FRAME LAST, because every block above it clamps it: the archetype sets the mass floor, and
 * the intake mount sets the size envelope and the hopper cap. Picking a mechanism and watching
 * the slider below re-clamp reads as cause and effect; the reverse reads as the builder
 * fighting you.
 *
 * Presentational and STATELESS: it renders `spec` and reports edits through `setSpec`. It does
 * NOT coerce — `coerceBiobuzzSpec` is the one chokepoint, and a component that clamped as well
 * would be a second opinion about what is legal.
 */
export interface BiobuzzBuilderProps {
  /** the spec being edited — already coerced by the host. */
  spec: RobotSpec;
  /** apply a partial edit. The host re-coerces and re-renders; this component does not. */
  setSpec(patch: Partial<RobotSpec>): void;
}

export function BiobuzzBuilder({ spec, setSpec }: BiobuzzBuilderProps) {
  const mode = (spec.scoreMode ?? BB_DEFAULT_SCORE_MODE) as BbScoreMode;
  const turreted = isTurreted(mode);
  const dials = bbDials(spec);
  const store = Math.min(spec.ballStorage ?? dials.storage.max, dials.storage.max);

  return (
    <>
      {/* ---- SCORING ---- */}
      <h3 className="ds-subh">Scoring</h3>
      <div className="ds-opts card4">
        {BB_SCORE_MODES.map((m) => (
          <button
            key={m}
            className={`ds-opt ${mode === m ? 'on' : ''}`}
            onClick={() => setSpec({ scoreMode: m })}
          >
            <span className="ot">{BB_MODE_LABELS[m]}</span>
            <span className="od">{BB_MODE_BLURBS[m]}</span>
          </button>
        ))}
      </div>
      {/* The mount means two different things, so it is TWO different pickers.
          TURRETLESS: which chassis EDGE the launcher fires over — four sides, and a corner is
          not buildable because the launch line spans a whole side.
          TURRETED: where the turret is BOLTED. It aims itself, so this is a position, not a
          facing — and it is where a POLLEN is actually born. Nine positions laid out as a 3x3
          map of the chassis (front row on top), so the picker reads as a top-down diagram of
          the robot rather than as a list of words.

          NO CELL IS GATED. Unlike CR's catalyst grid, nothing here can collide: the launcher
          sits ABOVE the deck and the sweeper on the floor, so a front sweeper feeding a
          front-firing drum is a legal build — and the most ordinary one in FTC. See the
          `mountsClash` header in `mounts.ts`. */}
      {turreted ? (
        <div className="ds-opts three">
          {BB_MOUNT_POSITIONS.map((m) => (
            <button
              key={m}
              className={`ds-opt mini ${bbShooterMountOf(spec) === m ? 'on' : ''}`}
              onClick={() => setSpec({ shooterMount: m })}
            >
              <span className="ot">{BB_MOUNT_POS_LABELS[m]}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="ds-opts four">
          {BB_SHOOTER_EDGES.map((m) => (
            <button
              key={m}
              className={`ds-opt mini ${bbShooterEdgeOf(spec) === m ? 'on' : ''}`}
              onClick={() => setSpec({ shooterMount: m })}
            >
              <span className="ot">{BB_MOUNT_POS_LABELS[m]}</span>
            </button>
          ))}
        </div>
      )}

      {/* ---- INTAKE ---- */}
      <h3 className="ds-subh">Intake</h3>
      {/* BIOBUZZ has ONE intake design, so this is a statement, not a picker. `.static` keeps
          the card look and drops the pointer affordances — NOT `disabled`, which would grey it
          out and say "unavailable" about the only intake the robot has. */}
      <div className="ds-opts fill">
        <div className="ds-opt on static">
          <span className="ot">{BB_INTAKE_LABELS.sweeper}</span>
        </div>
      </div>
      <div className="ds-opts four">
        {BB_INTAKE_MOUNTS.map((m) => (
          <button
            key={m}
            className={`ds-opt mini ${bbIntakeMountOf(spec) === m ? 'on' : ''}`}
            onClick={() => setSpec({ intakeMount: m })}
          >
            <span className="ot">{BB_INTAKE_MOUNT_LABELS[m]}</span>
            {BB_INTAKE_MOUNT_BLURBS[m] ? <span className="od">{BB_INTAKE_MOUNT_BLURBS[m]}</span> : null}
          </button>
        ))}
      </div>

      {/* ---- FRAME: clamped by every block above, so it comes last ---- */}
      <h3 className="ds-subh">Frame</h3>
      <div className="ds-fields">
        <label className="ds-field">
          <span className="cap">
            Length <span className="val">{spec.length}&quot;</span>
          </span>
          <input
            className="ds-range"
            type="range"
            min={dials.length.min}
            max={dials.length.max}
            step={0.5}
            value={spec.length}
            style={rangeFill(spec.length, dials.length.min, dials.length.max)}
            onChange={(e) => setSpec({ length: Number(e.target.value) })}
          />
        </label>
        <label className="ds-field">
          <span className="cap">
            Width <span className="val">{spec.width}&quot;</span>
          </span>
          <input
            className="ds-range"
            type="range"
            min={dials.width.min}
            max={dials.width.max}
            step={0.5}
            value={spec.width}
            style={rangeFill(spec.width, dials.width.min, dials.width.max)}
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
            min={dials.mass.min}
            max={dials.mass.max}
            step={1}
            value={spec.massLb}
            style={rangeFill(spec.massLb, dials.mass.min, dials.mass.max)}
            onChange={(e) => setSpec({ massLb: Number(e.target.value) })}
          />
        </label>
        {/* HOPPER sits with the FRAME, under the dimensions, because that is what sets it: the
            cap is footprint × archetype × intake mount (`bbStorageMax`), so it re-clamps as
            you drag Length/Width right above it. Full-width on its own row deliberately — a
            fourth 140px column would orphan-wrap, and the "16 / 24 pollen" value needs the
            room. POLLEN, not "balls": it is the word on the field. */}
        <label className="ds-field wide">
          <span className="cap">
            Hopper{' '}
            <span className="val">
              {store} / {dials.storage.max} pollen
            </span>
          </span>
          <input
            className="ds-range"
            type="range"
            min={BB_STORAGE_MIN}
            max={dials.storage.max}
            step={1}
            value={store}
            style={rangeFill(store, BB_STORAGE_MIN, dials.storage.max)}
            onChange={(e) => setSpec({ ballStorage: Number(e.target.value) })}
          />
        </label>
      </div>
    </>
  );
}
