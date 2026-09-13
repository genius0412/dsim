import type { RobotSpec } from '../../types';
import { rangeFill } from '../../ui/rangeFill';
import { BB_HOOD_DEFAULT_DEG, BB_STORAGE_MIN } from './config';
import {
  BB_MOUNT_POSITIONS,
  BB_SCORE_MODES,
  BB_SHOOTER_EDGES,
  BB_INTAKE_MOUNTS,
  type BbMountPos,
  type BbScoreMode,
  bbIntakeMountOf,
  mountsClash,
} from './mounts';
import {
  BB_LIFT_KINDS,
  type BbLauncherSpec,
  type BbLiftKind,
  type BbLiftSpec,
  bbCellsAdjacent,
  bbFoldTwinMount,
  bbIsTurreted,
  bbLauncherBlocker,
  bbLauncherOf,
  bbLiftOf,
  bbResolveLiftMount,
  bbResolveMount2,
} from './mechs';
import {
  BB_INTAKE_LABELS,
  BB_INTAKE_MOUNT_BLURBS,
  BB_INTAKE_MOUNT_LABELS,
  BB_LIFT_KIND_BLURBS,
  BB_MODE_BLURBS,
  BB_MODE_LABELS,
  BB_MOUNT_POS_LABELS,
  bbLiftKindLabel,
} from './labels';
import { bbDials } from './robotConfig';

/**
 * The BIOBUZZ half of the My Robot builder — the `GameModule.Builder` slot.
 *
 * ── WHY THIS IS A MODULE SLOT AND NOT A BRANCH IN `Menu.tsx` ────────────────
 * `Menu.tsx` renders the builder for whichever game is loaded, and it used to do it with an
 * `isDecode ? … : …` down the middle of every block. A third game turns each of those into a
 * three-way and the file grows a season every year. So the per-game blocks move OUT: the host
 * renders the game-neutral chrome (name, team, drivetrain, RPM, the chassis colour row) OUTSIDE
 * the slot, and drops this component in for everything only BIOBUZZ knows about.
 *
 * ── WHAT IS IN HERE, AND WHY IT INCLUDES THE FRAME DIALS ───────────────────
 * LAUNCHER, FLOWER SCORING, INTAKE and FRAME. Every robot carries exactly one launcher (owner
 * ruling 2026-09-12) — a single turret, a double turret or a dumper — and may carry a Box Tube,
 * the only mechanism that scores a FLOWER (see `mechs.ts`). The frame sliders look shared, and
 * their fields are — but their RANGES are not: `bbDials` intersects the R102 expansion prism with
 * the mounted sweepers' reach, so a front+back sweeper genuinely has a shorter legal chassis
 * than a front one. A host rendering the dials from DECODE's limits would offer lengths the
 * coercer then claws back, which reads to the player as the slider snapping out from under them.
 *
 * ── ORDER IS LOAD-BEARING ──────────────────────────────────────────────────
 * FRAME LAST, because every block above it clamps it: the launcher and the Box Tube set the
 * mass floor, and the intake mount sets the size envelope and the hopper cap. Picking a
 * mechanism and watching the slider below re-clamp reads as cause and effect; the reverse reads
 * as the builder fighting you.
 *
 * Presentational and STATELESS: it renders `spec` and reports edits through `setSpec`. It does
 * NOT coerce — `coerceBiobuzzSpec` is the one chokepoint, and a component that clamped as well
 * would be a second opinion about what is legal. Where it greys a cell out, it asks the SAME
 * predicates the coercer resolves with (`bbCellsAdjacent`, `mountsClash`, `bbLauncherBlocker`),
 * so the click and the coerced result agree before the round-trip.
 */
export interface BiobuzzBuilderProps {
  /** the spec being edited — already coerced by the host. */
  spec: RobotSpec;
  /** apply a partial edit. The host re-coerces and re-renders; this component does not. */
  setSpec(patch: Partial<RobotSpec>): void;
}

/** hover text for a double turret's cell that cannot take `which` turret, or undefined. */
function twinCellBlock(m: BbMountPos, at: BbMountPos, other: BbMountPos, otherName: string): string | undefined {
  if (m === 'center') return 'A double turret can’t use the centre: it neighbours every cell';
  if (m === other) return `The ${otherName} turret is here`;
  if (m !== at && bbCellsAdjacent(m, other)) return `Too close to the ${otherName} turret`;
  return undefined;
}

/** one 3x3 chassis map for a double turret's POLLEN or NECTAR turret. The other turret's cell,
 * its neighbours and the centre are disabled: two turret rings in neighbouring cells overlap on
 * every legal chassis (`BB_TWIN_PARTNER`, `mechs.ts`). */
function TwinTurretGrid(props: {
  caption: string;
  at: BbMountPos;
  other: BbMountPos;
  otherName: string;
  onPick(m: BbMountPos): void;
}) {
  const { caption, at, other, otherName, onPick } = props;
  return (
    <>
      <p className="ds-hint">{caption}</p>
      <div className="ds-opts three">
        {BB_MOUNT_POSITIONS.map((m) => {
          const why = twinCellBlock(m, at, other, otherName);
          return (
            <button
              key={m}
              className={`ds-opt mini ${at === m ? 'on' : ''}`}
              disabled={why !== undefined}
              title={why}
              onClick={() => onPick(m)}
            >
              <span className="ot">{BB_MOUNT_POS_LABELS[m]}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

export function BiobuzzBuilder({ spec, setSpec }: BiobuzzBuilderProps) {
  // THE TWO SLOTS, READ THROUGH THE CANONICAL RESOLVERS — never off the raw `scoreMode`/
  // `shooterMount`/`bbMech` fields directly, for the same reason `robot.ts` and `elements.ts`
  // don't either: `bbLauncherOf`/`bbLiftOf` are the ONE place "what launcher, and is there a
  // Box Tube" is decided, migration included.
  const launcher = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
  const lift = bbLiftOf(spec);
  const dials = bbDials(spec);
  const store = Math.min(spec.ballStorage ?? dials.storage.max, dials.storage.max);

  // ── WHY EVERY EDIT RE-SENDS `scoreMode`/`shooterMount` ALONGSIDE `bbMech` ──────────────
  // The container is what `coerceBbMech` (`./coerce.ts`) resolves, and the two flat fields are
  // its MIRROR — the half the shared `coerceSpec` and an older peer that has never heard of
  // `bbMech` read. An edit that changed one without the other would hand the next coercion two
  // disagreeing answers about the same launcher. So every edit goes through `send`, which writes
  // both from the one launcher it is given. The NECTAR turret's cell and the Box Tube have no
  // flat field, so they live in the container alone.
  function send(next: BbLauncherSpec, nextLift: BbLiftSpec | null) {
    setSpec({ scoreMode: next.kind, shooterMount: next.mount, bbMech: { launcher: next, lift: nextLift } });
  }

  /** LAUNCHER pick. The mount and hood survive the swap. A corner a turret was bolted to folds
   * to its nearest edge for a dumper on the next coercion. A DOUBLE turret cannot use `center`,
   * so its POLLEN turret folds off it here, and its NECTAR turret is placed at once, so the second
   * grid below opens already agreeing with the coercer. */
  function pickLauncher(kind: BbScoreMode) {
    if (kind === 'twinturret') {
      const mount = bbFoldTwinMount(launcher.mount);
      send({ kind, mount, mount2: bbResolveMount2(mount, launcher.mount2), hoodDeg: launcher.hoodDeg }, lift);
    } else {
      send({ kind, mount: launcher.mount, hoodDeg: launcher.hoodDeg }, lift);
    }
  }

  /** the launcher's (POLLEN turret's) cell. A double turret's NECTAR cell is re-resolved against
   * it, which is a no-op for any cell the grid lets you click. */
  function pickLauncherMount(m: BbMountPos) {
    send(
      launcher.kind === 'twinturret'
        ? { ...launcher, mount: m, mount2: bbResolveMount2(m, launcher.mount2) }
        : { ...launcher, mount: m },
      lift,
    );
  }

  /** a double turret's NECTAR-turret cell. */
  function pickMount2(m: BbMountPos) {
    send({ ...launcher, mount2: m }, lift);
  }

  /** HOOD angle — a dumper's only dial. */
  function setHood(hoodDeg: number) {
    send({ ...launcher, hoodDeg }, lift);
  }

  /** BOX TUBE pick: none, or a tube. A new tube starts at the back when that is free, else at
   * the first free perimeter cell — the same fallback `coerceBbMech` itself uses. Re-picking the
   * tube you have keeps its cell. */
  function pickLift(kind: BbLiftKind | null) {
    if (kind === null) {
      send(launcher, null);
      return;
    }
    const mount = bbResolveLiftMount('back', bbLauncherBlocker(launcher)) ?? 'back';
    send(launcher, lift ?? { kind, mount });
  }

  function pickLiftMount(m: BbMountPos) {
    if (!lift) return;
    send(launcher, { ...lift, mount: m });
  }

  const blockers = bbLauncherBlocker(launcher);

  return (
    <>
      {/* ---- LAUNCHER ---- */}
      <h3 className="ds-subh">Launcher</h3>
      {/* THREE cards: a launcher is mandatory, so there is no "none" to offer. */}
      <div className="ds-opts three">
        {BB_SCORE_MODES.map((m) => (
          <button
            key={m}
            className={`ds-opt ${launcher.kind === m ? 'on' : ''}`}
            onClick={() => pickLauncher(m)}
          >
            <span className="ot">{BB_MODE_LABELS[m]}</span>
            <span className="od">{BB_MODE_BLURBS[m]}</span>
          </button>
        ))}
      </div>
      {/* The mount means a different thing per launcher, so it is a different picker.
          SINGLE TURRET: where the turret is BOLTED. It aims itself, so this is a position, not
          a facing. Nine positions laid out as a 3x3 map of the chassis (front row on top).
          DOUBLE TURRET: two such maps, one per turret, each greying out where the other turret
          already is.
          DUMPER: which chassis EDGE it throws over — four sides, since the launch line spans a
          whole side.

          NO CELL IS GATED against the sweeper: the launcher sits ABOVE the deck and the sweeper
          on the floor, so a front sweeper feeding a front dumper is a legal build. */}
      {launcher.kind === 'turret' && (
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
      )}
      {launcher.kind === 'twinturret' && (
        <>
          <TwinTurretGrid
            caption="POLLEN turret"
            at={launcher.mount}
            other={launcher.mount2 ?? bbResolveMount2(launcher.mount, undefined)}
            otherName="NECTAR"
            onPick={pickLauncherMount}
          />
          <TwinTurretGrid
            caption="NECTAR turret"
            at={launcher.mount2 ?? bbResolveMount2(launcher.mount, undefined)}
            other={launcher.mount}
            otherName="POLLEN"
            onPick={pickMount2}
          />
        </>
      )}
      {launcher.kind === 'dumper' && (
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
      {/* HOOD vs PITCH: a dumper's elevation is a fixed piece of hardware, so it gets a slider,
          and the range is where a dumper can still reach the HIVE (`BB_HOOD_DEFAULT_DEG`). A
          turret solves its own elevation per shot, so a slider would offer a control the sim
          never reads; one line says why there is none. */}
      {bbIsTurreted(launcher) ? (
        <p className="ds-hint">A turret sets its own elevation for every shot.</p>
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

      {/* ---- FLOWER SCORING: the Box Tube ---- */}
      <h3 className="ds-subh">Flower scoring</h3>
      <div className="ds-opts two">
        <button className={`ds-opt ${lift === null ? 'on' : ''}`} onClick={() => pickLift(null)}>
          <span className="ot">None</span>
        </button>
        {BB_LIFT_KINDS.map((k) => (
          <button key={k} className={`ds-opt ${lift?.kind === k ? 'on' : ''}`} onClick={() => pickLift(k)}>
            <span className="ot">{bbLiftKindLabel(k)}</span>
            <span className="od">{BB_LIFT_KIND_BLURBS[k]}</span>
          </button>
        ))}
      </div>
      {lift && (
        /* The same 3x3 chassis map. A tube and a launcher both sit ABOVE the deck, so this grid
           CAN clash with the launcher — both turrets of a double turret, or a dumper's whole
           edge (`bbLauncherBlocker`). The centre is never offered: the placement point has to
           sit past a chassis edge to reach a FLOWER. No height dial — a tube places at a point. */
        <div className="ds-opts three">
          {BB_MOUNT_POSITIONS.map((m) => {
            const centre = m === 'center';
            const clash =
              !centre && lift.mount !== m && blockers.some((b) => mountsClash({ pos: m, spansEdge: false }, b));
            return (
              <button
                key={m}
                className={`ds-opt mini ${lift.mount === m ? 'on' : ''}`}
                disabled={centre || clash}
                title={centre ? 'The tube sits on the frame edge' : clash ? 'The launcher is mounted here' : undefined}
                onClick={() => pickLiftMount(m)}
              >
                <span className="ot">{BB_MOUNT_POS_LABELS[m]}</span>
              </button>
            );
          })}
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
            cap is footprint × archetype × intake mount (`bbStorageMax`), clamped to G407's 4.
            Full-width on its own row deliberately — a fourth 140px column would orphan-wrap.
            POLLEN, not "balls": it is the word on the field. */}
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
