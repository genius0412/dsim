import type { RobotSpec } from '../../types';
import { rangeFill } from '../../ui/rangeFill';
import { BB_HOOD_DEFAULT_DEG, BB_STORAGE_MIN } from './config';
import {
  BB_MOUNT_POSITIONS,
  BB_SCORE_MODES,
  BB_SHOOTER_EDGES,
  BB_INTAKE_MOUNTS,
  BB_DEFAULT_SHOOTER_MOUNT,
  BB_DEFAULT_TURRET_POS,
  type BbMountPos,
  type BbScoreMode,
  bbIntakeMountOf,
  mountsClash,
} from './mounts';
import {
  BB_LIFT_KINDS,
  type BbLiftKind,
  bbIsTurreted,
  bbLauncherOf,
  bbLiftOf,
  bbSpansEdge,
} from './mechs';
import {
  BB_INTAKE_LABELS,
  BB_INTAKE_MOUNT_BLURBS,
  BB_INTAKE_MOUNT_LABELS,
  BB_LAUNCHER_NONE_BLURB,
  BB_LAUNCHER_NONE_LABEL,
  BB_LIFT_KIND_BLURBS,
  BB_LIFT_KIND_LABELS,
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
 * LAUNCHER, LIFT, INTAKE and FRAME. A robot may carry a launcher, a lift, both, or NEITHER —
 * see `mechs.ts` for the vocabulary — so LAUNCHER and LIFT are each a NONE-or-something picker
 * rather than a fixed block that is always present. The frame sliders look shared, and their
 * fields are — but their RANGES are not: `bbDials` intersects the R102 expansion prism with the
 * mounted sweepers' reach, so a front+back sweeper genuinely has a shorter legal chassis than a
 * front one. A host rendering the dials from DECODE's limits would offer lengths the coercer
 * then claws back, which reads to the player as the slider snapping out from under them. The
 * ranges have to come from the game, so the sliders come with them.
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
  // THE TWO SLOTS, READ THROUGH THE CANONICAL RESOLVERS — never off the raw `scoreMode`/
  // `shooterMount`/`bbMech` fields directly, for the same reason `robot.ts` and `elements.ts`
  // don't either: `bbLauncherOf`/`bbLiftOf` are the ONE place "does this build have a
  // launcher/lift, and what is it" is decided, migration included. `spec` here is always
  // already coerced (the component contract above says so), so in practice this just reads
  // `spec.bbMech.launcher` / `.lift` — but going through the resolvers is what keeps this file
  // agreeing with the sim if that ever stops being true.
  const launcher = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
  const lift = bbLiftOf(spec);
  const turreted = bbIsTurreted(launcher);
  const dials = bbDials(spec);
  const store = Math.min(spec.ballStorage ?? dials.storage.max, dials.storage.max);

  // ── WHY EVERY HANDLER BELOW RE-SENDS `scoreMode`/`shooterMount` ALONGSIDE `bbMech` ──────
  // `coerceBbMech` (`./coerce.ts`) reads a launcher's `kind` and `mount` off the ALREADY-FOLDED
  // `out.scoreMode`/`out.shooterMount` — not off whatever this component puts in
  // `bbMech.launcher` — because those two flat fields are what the rest of the coercer (and an
  // older peer's coercer, which mirrors them) already agrees on. Only `launcher !== null` and
  // `launcher.hoodDeg` are read from the container itself. So an edit that changed
  // `bbMech.launcher.kind` without also changing `scoreMode` would look like it worked in this
  // component's own state and then be silently overwritten back to the old archetype on the
  // very next coercion — the same class of bug the mirrors above exist to prevent. `bbMech.lift`
  // has no such mirror (nothing before it ever modelled a lift), so lift edits touch only the
  // container.

  /** LAUNCHER pick: an archetype, or NONE (the real, shippable Studica StarterBot shape). Every
   * call rebuilds the WHOLE `bbMech` container — `launcher: null` and an absent container mean
   * different things, so a patch that only ever set the half that changed could turn a real
   * "no launcher" back into "not specified yet" the moment something else round-tripped it. */
  function pickLauncher(kind: BbScoreMode | null) {
    if (kind === null) {
      setSpec({ bbMech: { launcher: null, lift } });
      return;
    }
    setSpec({
      scoreMode: kind,
      bbMech: {
        launcher: {
          kind,
          // preserved across an archetype swap — a corner a TURRET was bolted to folds to its
          // nearest edge automatically the moment `scoreMode` reads turretless (`coerceSpec`'s
          // step 1c), so there is no need to re-derive it here.
          mount: launcher?.mount ?? BB_DEFAULT_SHOOTER_MOUNT,
          hoodDeg: launcher?.hoodDeg ?? BB_HOOD_DEFAULT_DEG,
        },
        lift,
      },
    });
  }

  /** LAUNCHER mount pick — the one edit that actually changes `shooterMount`, so it is the one
   * that has to send it. */
  function pickLauncherMount(m: BbMountPos) {
    if (!launcher) return; // the picker is hidden with no launcher; guard defensively anyway
    setSpec({ shooterMount: m, bbMech: { launcher: { ...launcher, mount: m }, lift } });
  }

  /** HOOD angle — the one launcher field with no flat-field mirror, so this is the only place
   * it is ever written. */
  function setHood(hoodDeg: number) {
    if (!launcher) return;
    setSpec({ bbMech: { launcher: { ...launcher, hoodDeg }, lift } });
  }

  /** LIFT pick: NONE or a lift kind. No legacy field to keep in step — a lift is entirely a
   * `bbMech` fact — so unlike `pickLauncher` this never touches anything else on the spec. */
  function pickLift(kind: BbLiftKind | null) {
    setSpec({
      bbMech: {
        launcher,
        lift:
          kind === null
            ? null
            // keep the existing mast's mount/height if one already existed (re-picking the
            // same kind is a no-op); a brand-new mast starts centred and at full reach, the
            // same fallback `coerceBbMech` itself uses for an invalid/missing mount or height.
            : (lift ?? { kind, mount: BB_DEFAULT_TURRET_POS, maxZ: dials.lift.max }),
      },
    });
  }

  function pickLiftMount(m: BbMountPos) {
    if (!lift) return;
    setSpec({ bbMech: { launcher, lift: { ...lift, mount: m } } });
  }

  function setLiftHeight(maxZ: number) {
    if (!lift) return;
    setSpec({ bbMech: { launcher, lift: { ...lift, maxZ } } });
  }

  return (
    <>
      {/* ---- LAUNCHER ---- */}
      <h3 className="ds-subh">Launcher</h3>
      {/* FIVE cards, not four: Studica's published StarterBot is a drivetrain and an intake
          with no shooter at all (`mechs.ts` header), so NONE is exactly as real a build as any
          archetype and gets the same card treatment rather than a checkbox bolted beside the
          other four. Picking it hides the mount picker and the hood slider below — there is no
          hardware left to place or tune. */}
      <div className="ds-opts card4">
        <button className={`ds-opt ${launcher === null ? 'on' : ''}`} onClick={() => pickLauncher(null)}>
          <span className="ot">{BB_LAUNCHER_NONE_LABEL}</span>
          <span className="od">{BB_LAUNCHER_NONE_BLURB}</span>
        </button>
        {BB_SCORE_MODES.map((m) => (
          <button
            key={m}
            className={`ds-opt ${launcher?.kind === m ? 'on' : ''}`}
            onClick={() => pickLauncher(m)}
          >
            <span className="ot">{BB_MODE_LABELS[m]}</span>
            <span className="od">{BB_MODE_BLURBS[m]}</span>
          </button>
        ))}
      </div>
      {launcher && (
        <>
          {/* The mount means two different things, so it is TWO different pickers.
              TURRETLESS: which chassis EDGE the launcher fires over — four sides, and a corner
              is not buildable because the launch line spans a whole side.
              TURRETED: where the turret is BOLTED. It aims itself, so this is a position, not a
              facing — and it is where a POLLEN is actually born. Nine positions laid out as a
              3x3 map of the chassis (front row on top), so the picker reads as a top-down
              diagram of the robot rather than as a list of words.

              NO CELL IS GATED against the sweeper. Unlike CR's catalyst grid, nothing here can
              collide with it: the launcher sits ABOVE the deck and the sweeper on the floor, so
              a front sweeper feeding a front-firing drum is a legal build — and the most
              ordinary one in FTC. (The LIFT, below, is a different story — it sits at the same
              height as the launcher, which is why ITS grid can clash.) */}
          {turreted ? (
            <div className="ds-opts three">
              {BB_MOUNT_POSITIONS.map((m) => (
                <button
                  key={m}
                  className={`ds-opt mini ${launcher.mount === m ? 'on' : ''}`}
                  onClick={() => pickLauncherMount(m)}
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
                  className={`ds-opt mini ${launcher.mount === m ? 'on' : ''}`}
                  onClick={() => pickLauncherMount(m)}
                >
                  <span className="ot">{BB_MOUNT_POS_LABELS[m]}</span>
                </button>
              ))}
            </div>
          )}
          {/* HOOD vs PITCH: a TURRETLESS launcher's elevation is a fixed piece of hardware (a
              hood, per AndyMark's own StarterBot manual — see `BB_HOOD_DEFAULT_DEG`'s header),
              so it gets a slider. A TURRET solves its own elevation per shot — that is the
              entire point of putting a pitch axis on it (`bbTurretPitch`) — so a slider here
              would offer a control the sim never reads; a one-line explanation stands in for it
              instead. */}
          {turreted ? (
            <p className="ds-hint">A turret solves its own elevation per shot — no hood to tune.</p>
          ) : (
            <div className="ds-fields">
              <label className="ds-field">
                <span className="cap">
                  Hood <span className="val">{launcher.hoodDeg}&deg;</span>
                </span>
                <input
                  className="ds-range"
                  type="range"
                  min={dials.hood.min}
                  max={dials.hood.max}
                  step={1}
                  value={launcher.hoodDeg}
                  style={rangeFill(launcher.hoodDeg, dials.hood.min, dials.hood.max)}
                  onChange={(e) => setHood(Number(e.target.value))}
                />
              </label>
            </div>
          )}
        </>
      )}

      {/* ---- LIFT ---- */}
      <h3 className="ds-subh">Lift</h3>
      <div className="ds-opts two">
        <button className={`ds-opt ${lift === null ? 'on' : ''}`} onClick={() => pickLift(null)}>
          <span className="ot">None</span>
        </button>
        {BB_LIFT_KINDS.map((k) => (
          <button key={k} className={`ds-opt ${lift?.kind === k ? 'on' : ''}`} onClick={() => pickLift(k)}>
            <span className="ot">{BB_LIFT_KIND_LABELS[k]}</span>
            <span className="od">{BB_LIFT_KIND_BLURBS[k]}</span>
          </button>
        ))}
      </div>
      {lift && (
        <>
          {/* Same 3x3 chassis map the launcher's TURRET picker uses — a mast and a turret both
              sit ABOVE the deck, so unlike the sweeper this grid CAN clash with the launcher.
              A clashing cell is not rejected here: `bbResolveLiftMount` (`mechs.ts`) relocates
              it to the nearest free cell on the very next coercion, same as clicking it would
              have produced anyway. Greying the cell out first is NICE TO HAVE, not load-bearing
              — it just means the click and the result agree before the round-trip, using the
              shared `mountsClash` predicate rather than a second, drifting copy of the rule. */}
          <div className="ds-opts three">
            {BB_MOUNT_POSITIONS.map((m) => {
              const clash =
                launcher !== null &&
                lift.mount !== m &&
                mountsClash(
                  { pos: m, spansEdge: false },
                  { pos: launcher.mount, spansEdge: bbSpansEdge(launcher.kind) },
                );
              return (
                <button
                  key={m}
                  className={`ds-opt mini ${lift.mount === m ? 'on' : ''}`}
                  disabled={clash}
                  title={clash ? 'The launcher is mounted here' : undefined}
                  onClick={() => pickLiftMount(m)}
                >
                  <span className="ot">{BB_MOUNT_POS_LABELS[m]}</span>
                </button>
              );
            })}
          </div>
          <div className="ds-fields">
            <label className="ds-field">
              <span className="cap">
                Height <span className="val">{lift.maxZ}&quot;</span>
              </span>
              <input
                className="ds-range"
                type="range"
                min={dials.lift.min}
                max={dials.lift.max}
                step={0.5}
                value={lift.maxZ}
                style={rangeFill(lift.maxZ, dials.lift.min, dials.lift.max)}
                onChange={(e) => setLiftHeight(Number(e.target.value))}
              />
            </label>
          </div>
        </>
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
