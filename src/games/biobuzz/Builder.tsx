import type { RobotSpec } from '../../types';
import { rangeFill } from '../../ui/rangeFill';
import {
  BB3_HEIGHT_MAX,
  BB3_HEIGHT_MIN,
  BB_DUMP_MAX_DIST,
  BB_HOOD_DEFAULT_DEG,
  BB_SIZE_STEP,
  BB_MASS_STEP,
  BB_STORAGE_MIN,
  bbDeployedHeightIn,
} from './config';
import {
  BB_MOUNT_POSITIONS,
  BB_SCORE_MODES,
  BB_SHOOTER_EDGES,
  BB_INTAKE_MOUNTS,
  type BbMountPos,
  type BbScoreMode,
  bbIntakeMountOf,
  mountsClash,
  occupiedCells,
} from './mounts';
import {
  BB_INTAKE_KINDS,
  BB_LIFT_KINDS,
  BB_LIFT_POSITIONS,
  type BbIntakeKind,
  type BbLauncherSpec,
  type BbLiftKind,
  type BbLiftSpec,
  bbCellsAdjacent,
  bbFoldTwinMount,
  bbIntakeKindOf,
  bbIsTurreted,
  bbLauncherBlocker,
  bbLauncherOf,
  bbLiftOf,
  bbResolveLiftMount,
  bbResolveMount2,
} from './mechs';
import {
  BB_INTAKE_KIND_BLURBS,
  BB_INTAKE_LABELS,
  BB_INTAKE_MOUNT_LABELS,
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
 * FRAME, INTAKE, LAUNCHER and FLOWER SCORING. Every robot carries exactly one launcher (owner
 * ruling 2026-09-12) — a single turret, a double turret or a dumper — and may carry a Box Tube,
 * the only mechanism that scores a FLOWER (see `mechs.ts`). The frame sliders look shared, and
 * their fields are — but their RANGES are not: `bbDials` intersects the R102 expansion prism with
 * the mounted sweepers' reach, so a front+back sweeper genuinely has a shorter legal chassis
 * than a front one. A host rendering the dials from DECODE's limits would offer lengths the
 * coercer then claws back, which reads to the player as the slider snapping out from under them.
 *
 * ── ORDER ──────────────────────────────────────────────────────────────────
 * FRAME, INTAKE, LAUNCHER, FLOWER SCORING (owner, 2026-09-23 — it used to be frame LAST). The
 * mechanisms below the frame still clamp it (the launcher and the Box Tube set the mass floor,
 * the intake mount the size envelope and the hopper cap), so a pick further down can move a
 * frame slider above it. Where PASS throws lives in the Driving panel (`BiobuzzDrivingSlot`).
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

/**
 * A DIAL'S VALUE, AT ITS OWN STEP'S PRECISION — the belt to `coerceBiobuzzSpec`'s braces.
 *
 * The coercer snaps every size onto its slider's grid, which is where the 15-digit width was
 * actually fixed (owner re-report, 2026-09-18). This is the second line of defence: a value that
 * reaches this component off-grid anyway — a hand-edited save, a spec from a peer running an
 * older coercer — prints as `16.3` rather than as `16.331227996399747`. A slider can never mean
 * more precision than one step, so printing more is never right.
 */
function dialText(v: number, step: number): string {
  const decimals = step >= 1 ? 0 : String(step).split('.')[1]?.length ?? 1;
  return v.toFixed(decimals);
}

/** hover text for a double turret's cell that cannot take `which` turret, or undefined. */
function twinCellBlock(m: BbMountPos, at: BbMountPos, other: BbMountPos, otherName: string): string | undefined {
  if (m === 'center') return 'A double turret can’t use the centre: it neighbours every cell';
  if (m === other) return `The ${otherName} turret is here`;
  if (m !== at && bbCellsAdjacent(m, other)) return `Too close to the ${otherName} turret`;
  return undefined;
}

/** what a chassis-map cell carries on top of its own name: the mechanism already bolted there. */
type BbCellMark = 'turret' | 'nectar' | 'dumper' | 'tube';

/** a cell's mark in words, for its accessible name — the glyph itself is `aria-hidden`. */
const BB_CELL_MARK_NAMES: Record<BbCellMark, string> = {
  turret: 'turret',
  nectar: 'NECTAR turret',
  dumper: 'dumper',
  tube: 'Box tube',
};

/**
 * ONE mounted mechanism, as a 16x16 glyph.
 *
 * NOSE-UP, like everything else that draws this robot: the top of a cell is the FRONT of the
 * chassis (`ROBOT_FRAME` in `RobotPreview.tsx`), so a turret's barrel points at the top of the
 * cell and a dumper's tray lies across the side it throws over. The shapes are the preview's,
 * cut down — a ring with a barrel, a tray on two arms, a nested three-section mast.
 */
function BbMountGlyph({ mark }: { mark: BbCellMark }) {
  const s = 'currentColor';
  return (
    <svg className="bb-cell-g" viewBox="0 0 16 16" aria-hidden="true">
      {mark === 'dumper' ? (
        <>
          <rect x="2" y="3" width="12" height="3" rx="1.2" fill={s} />
          <line x1="4" y1="6" x2="4" y2="12" stroke={s} strokeWidth="1.4" strokeLinecap="round" />
          <line x1="12" y1="6" x2="12" y2="12" stroke={s} strokeWidth="1.4" strokeLinecap="round" />
        </>
      ) : mark === 'tube' ? (
        // the box-tube lift: three nested tubes, widest at the base, drawn as one stack
        <>
          <rect x="3" y="10.5" width="10" height="4.5" rx="0.8" fill="none" stroke={s} strokeWidth="1.5" />
          <rect x="5" y="6" width="6" height="4.5" fill="none" stroke={s} strokeWidth="1.4" />
          <rect x="6.5" y="1.5" width="3" height="4.5" fill={s} />
        </>
      ) : (
        <>
          <circle cx="8" cy="9" r="4.4" fill="none" stroke={s} strokeWidth="1.5" />
          {mark === 'nectar' ? <circle cx="8" cy="9" r="1.8" fill={s} /> : null}
          <line x1="8" y1="9" x2="8" y2="1.5" stroke={s} strokeWidth="1.8" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

/**
 * THE CHASSIS MAP — where a mechanism is bolted, as a picture of the robot instead of a list of
 * nine words.
 *
 * ── WHY IT REPLACED THE 3x3 BUTTON GRID (owner, 2026-09-22) ─────────────────
 * The grid it replaces was already in map ORDER — `BB_MOUNT_POSITIONS` has been since Chain
 * Reaction — but nothing on screen said so. No frame around it, no front, and no sign of what
 * was already bolted to the robot, so nine cells reading `F·LEFT … B·RIGHT` were nine words you
 * had to hold the chassis in your head to read. Three things fix that and all three are here:
 * the cells sit INSIDE a chassis outline, the FRONT is named and marked at the top of it, and
 * every cell shows the mechanism sitting on it.
 *
 * ⚠️ FRONT IS UP AND THE ROBOT'S LEFT IS THE SCREEN'S LEFT — `BB_MOUNT_POSITIONS` order, the
 * same nose-up frame the 2D preview draws in (`ROBOT_FRAME`; CLAUDE.md Gotchas). A mirrored map
 * is invisible on a symmetric build and wrong on every asymmetric one.
 *
 * A cell this particular map cannot pick is still DRAWN, as inert frame. That is the context the
 * old grid had no way to show: a dumper spans a whole side, so the tube's map draws three
 * blocked cells for one launcher, and the corners of a dumper's own map are frame.
 */
function BbChassisMap({
  caption,
  mark,
  cells,
  at,
  marks,
  blocked,
  onPick,
}: {
  /** the map's LABEL — a `.ds-field` `.cap`, so it reads as the same kind of row as every other
   * pick on the screen. */
  caption: string;
  /** the glyph of the mechanism this map places, drawn in front of the caption. */
  mark?: BbCellMark;
  /** the positions this map can pick. Everything else is drawn as frame. */
  cells: readonly BbMountPos[];
  at: BbMountPos;
  /** what the OTHER mechanisms occupy, so a placement is made against the whole robot. */
  marks: Partial<Record<BbMountPos, BbCellMark>>;
  /** why this cell cannot take the mechanism (its hover text). An ENABLED cell gets none. */
  blocked?: (m: BbMountPos) => string | undefined;
  onPick(m: BbMountPos): void;
}) {
  return (
    <div className="ds-field">
      {/* the caption carries the SAME glyph the other map draws on this mechanism's cell, so two
          maps side by side (a double turret) say which is which without reading the words */}
      <span className="cap">
        <span className="bb-map-cap">
          {mark ? <BbMountGlyph mark={mark} /> : null}
          {caption}
        </span>
      </span>
      <div className="bb-map">
        <span className="bb-map-front">
          <svg className="bb-map-nose" viewBox="0 0 12 6" aria-hidden="true">
            <path
              d="M1 5 L6 1 L11 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Front
        </span>
        <div className="bb-map-grid">
          {BB_MOUNT_POSITIONS.map((m) => {
            const mark = marks[m];
            const body = (
              <>
                {mark ? <BbMountGlyph mark={mark} /> : null}
                <span className="bb-cell-l">{BB_MOUNT_POS_LABELS[m]}</span>
              </>
            );
            if (!cells.includes(m)) {
              return (
                <span className="bb-cell dead" key={m}>
                  {body}
                </span>
              );
            }
            const why = blocked?.(m);
            const on = at === m;
            return (
              <button
                key={m}
                type="button"
                className={`bb-cell${on ? ' on' : ''}`}
                disabled={why !== undefined}
                title={why}
                aria-pressed={on}
                aria-label={mark ? `${BB_MOUNT_POS_LABELS[m]}, ${BB_CELL_MARK_NAMES[mark]}` : BB_MOUNT_POS_LABELS[m]}
                onClick={() => onPick(m)}
              >
                {body}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function BiobuzzBuilder({ spec, setSpec }: BiobuzzBuilderProps) {
  // THE TWO SLOTS, READ THROUGH THE CANONICAL RESOLVERS — never off the raw `scoreMode`/
  // `shooterMount`/`bbMech` fields directly, for the same reason `robot.ts` and `elements.ts`
  // don't either: `bbLauncherOf`/`bbLiftOf` are the ONE place "what launcher, and is there a
  // Box Tube" is decided, migration included.
  const launcher = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
  const lift = bbLiftOf(spec);
  const intakeKind = bbIntakeKindOf(spec);
  const dials = bbDials(spec);
  const store = Math.min(spec.ballStorage ?? dials.storage.max, dials.storage.max);
  // THE HEIGHT, read through the resolver rather than off the raw field (same rule as the
  // launcher above) so an absent height shows the default.
  const deployed = bbDeployedHeightIn(spec);

  // ── WHY EVERY EDIT RE-SENDS `scoreMode`/`shooterMount` ALONGSIDE `bbMech` ──────────────
  // The container is what `coerceBbMech` (`./coerce.ts`) resolves, and the two flat fields are
  // its MIRROR — the half the shared `coerceSpec` and an older peer that has never heard of
  // `bbMech` read. An edit that changed one without the other would hand the next coercion two
  // disagreeing answers about the same launcher. So every edit goes through `send`, which writes
  // both from the one launcher it is given. The NECTAR turret's cell and the Box Tube have no
  // flat field, so they live in the container alone.
  //
  // `nextIntake` DEFAULTS TO THE CURRENT KIND, not to the sweeper: a launcher or Box Tube edit
  // rebuilds `bbMech` from scratch (it is a container, not a set of independent fields), and
  // without this default every one of those edits would silently fold the intake back to the
  // sweeper on the next coercion (`coerceBbMech` reads `bbMech.intake` off exactly what is sent).
  function send(next: BbLauncherSpec, nextLift: BbLiftSpec | null, nextIntake: BbIntakeKind = intakeKind) {
    setSpec({
      scoreMode: next.kind,
      shooterMount: next.mount,
      bbMech: { launcher: next, lift: nextLift, intake: { kind: nextIntake } },
    });
  }

  /** INTAKE pick. The launcher and the Box Tube survive the swap — same reasoning as `pickLift`
   * keeping the launcher, the other way round. */
  function pickIntake(kind: BbIntakeKind) {
    send(launcher, lift, kind);
  }

  /** LAUNCHER pick. The mount and hood survive the swap. A corner a turret was bolted to folds
   * to its nearest edge for a dumper on the next coercion. A DOUBLE turret cannot use `center`,
   * so its POLLEN turret folds off it here, and its NECTAR turret is placed at once, so the second
   * map below opens already agreeing with the coercer. */
  function pickLauncher(kind: BbScoreMode) {
    if (kind === 'twinturret') {
      const mount = bbFoldTwinMount(launcher.mount);
      send({ kind, mount, mount2: bbResolveMount2(mount, launcher.mount2), hoodDeg: launcher.hoodDeg }, lift);
    } else {
      send({ kind, mount: launcher.mount, hoodDeg: launcher.hoodDeg }, lift);
    }
  }

  /** the launcher's (POLLEN turret's) cell. A double turret's NECTAR cell is re-resolved against
   * it, which is a no-op for any cell the map lets you click. */
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
  // WHAT IS ALREADY ON THE CHASSIS, for the maps below. Each map draws the OTHER mechanisms so a
  // placement is made against the whole robot rather than against nine bare words.
  // A dumper spans its whole side (`occupiedCells`), which is why this is a set of cells and not
  // one cell: the tube's map has to show all three as taken, and it is the same expansion
  // `bbResolveLiftMount` folds around.
  const launcherMarks: Partial<Record<BbMountPos, BbCellMark>> = {};
  for (const c of occupiedCells(launcher.mount, launcher.kind === 'dumper')) {
    launcherMarks[c] = launcher.kind === 'dumper' ? 'dumper' : 'turret';
  }
  if (launcher.kind === 'twinturret' && launcher.mount2) launcherMarks[launcher.mount2] = 'nectar';
  const tubeMarks: Partial<Record<BbMountPos, BbCellMark>> = lift ? { [lift.mount]: 'tube' } : {};
  const mount2 = launcher.mount2 ?? bbResolveMount2(launcher.mount, undefined);

  return (
    <>
      {/* ---- FRAME: first, and re-clamped live by the mechanism blocks below it ---- */}
      <h3 className="ds-subh">Frame</h3>
      <div className="ds-fields">
        <label className="ds-field">
          <span className="cap">
            Length <span className="val">{dialText(spec.length, BB_SIZE_STEP)}&quot;</span>
          </span>
          <input
            className="ds-range"
            type="range"
            min={dials.length.min}
            max={dials.length.max}
            step={BB_SIZE_STEP}
            value={spec.length}
            aria-valuetext={`${dialText(spec.length, BB_SIZE_STEP)} inches`}
            style={rangeFill(spec.length, dials.length.min, dials.length.max)}
            onChange={(e) => setSpec({ length: Number(e.target.value) })}
          />
        </label>
        <label className="ds-field">
          <span className="cap">
            Width <span className="val">{dialText(spec.width, BB_SIZE_STEP)}&quot;</span>
          </span>
          <input
            className="ds-range"
            type="range"
            min={dials.width.min}
            max={dials.width.max}
            step={BB_SIZE_STEP}
            value={spec.width}
            aria-valuetext={`${dialText(spec.width, BB_SIZE_STEP)} inches`}
            style={rangeFill(spec.width, dials.width.min, dials.width.max)}
            onChange={(e) => setSpec({ width: Number(e.target.value) })}
          />
        </label>
        <label className="ds-field">
          <span className="cap">
            Mass <span className="val">{dialText(spec.massLb, BB_MASS_STEP)} lb</span>
          </span>
          <input
            className="ds-range"
            type="range"
            min={dials.mass.min}
            max={dials.mass.max}
            step={BB_MASS_STEP}
            value={spec.massLb}
            aria-valuetext={`${dialText(spec.massLb, BB_MASS_STEP)} pounds`}
            style={rangeFill(spec.massLb, dials.mass.min, dials.mass.max)}
            onChange={(e) => setSpec({ massLb: Number(e.target.value) })}
          />
        </label>
        {/* HOPPER sits with the FRAME, under the dimensions, because that is what sets it: the
            cap is footprint × archetype × intake mount (`bbStorageMax`), clamped to the owner's
            4-element cap (2026-09-12).
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
            aria-valuetext={`${store} of ${dials.storage.max} pollen`}
            style={rangeFill(store, BB_STORAGE_MIN, dials.storage.max)}
            onChange={(e) => setSpec({ ballStorage: Number(e.target.value) })}
          />
        </label>
        {/* HEIGHT, the robot's TOTAL height — the third chassis dimension (the 3D chassis
            collider is capped at it). It sits with LENGTH and WIDTH because it is the same kind
            of number. It stops at `BB3_HEIGHT_MAX` (18), R102's starting cube, so no build has
            to fold to start and there is no stow height to declare. */}
        <label className="ds-field">
          <span className="cap">
            Height <span className="val">{dialText(deployed, 1)}&quot;</span>
          </span>
          <input
            className="ds-range"
            type="range"
            min={BB3_HEIGHT_MIN}
            max={BB3_HEIGHT_MAX}
            step={1}
            value={deployed}
            aria-valuetext={`${dialText(deployed, 1)} inches`}
            style={rangeFill(deployed, BB3_HEIGHT_MIN, BB3_HEIGHT_MAX)}
            onChange={(e) => setSpec({ heightIn: Number(e.target.value) })}
          />
        </label>
      </div>

      {/* ---- INTAKE ---- */}
      <h3 className="ds-subh">Intake</h3>
      {/* THREE cards, same anatomy as the launcher picker below: every build carries an intake,
          so there is no "none" to offer. All three take a ground POLLEN identically; the blurb
          says the one thing that actually differs — whether it reaches into a FLOWER. */}
      <div className="ds-opts card4">
        {BB_INTAKE_KINDS.map((k) => (
          <button
            key={k}
            className={`ds-opt ${intakeKind === k ? 'on' : ''}`}
            aria-pressed={intakeKind === k}
            onClick={() => pickIntake(k)}
          >
            <span className="ot">{BB_INTAKE_LABELS[k]}</span>
            <span className="od">{BB_INTAKE_KIND_BLURBS[k]}</span>
          </button>
        ))}
      </div>
      <div className="ds-opts four">
        {BB_INTAKE_MOUNTS.map((m) => (
          <button
            key={m}
            className={`ds-opt mini ${bbIntakeMountOf(spec) === m ? 'on' : ''}`}
            aria-pressed={bbIntakeMountOf(spec) === m}
            onClick={() => setSpec({ intakeMount: m })}
          >
            <span className="ot">{BB_INTAKE_MOUNT_LABELS[m]}</span>
          </button>
        ))}
      </div>


      {/* ---- LAUNCHER ---- */}
      <h3 className="ds-subh">Launcher</h3>
      {/* THREE cards: a launcher is mandatory, so there is no "none" to offer. `card4`, not
          `three`: a fixed three-up squeezed each blurb to one word a line on a phone. */}
      <div className="ds-opts card4">
        {BB_SCORE_MODES.map((m) => (
          <button
            key={m}
            className={`ds-opt ${launcher.kind === m ? 'on' : ''}`}
            aria-pressed={launcher.kind === m}
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
        <BbChassisMap
          caption="Turret position"
          cells={BB_MOUNT_POSITIONS}
          at={launcher.mount}
          marks={tubeMarks}
          onPick={pickLauncherMount}
        />
      )}
      {launcher.kind === 'twinturret' && (
        // SIDE BY SIDE in a `.ds-fields` row, not stacked: the two turrets are picked against
        // each other — each map greys out where the other one is — and stacked they were two
        // screens apart on a narrow build column.
        <div className="ds-fields">
          <BbChassisMap
            caption="POLLEN turret"
            mark="turret"
            cells={BB_MOUNT_POSITIONS}
            at={launcher.mount}
            marks={{ ...tubeMarks, [mount2]: 'nectar' }}
            blocked={(m) => twinCellBlock(m, launcher.mount, mount2, 'NECTAR')}
            onPick={pickLauncherMount}
          />
          <BbChassisMap
            caption="NECTAR turret"
            mark="nectar"
            cells={BB_MOUNT_POSITIONS}
            at={mount2}
            marks={{ ...tubeMarks, [launcher.mount]: 'turret' }}
            blocked={(m) => twinCellBlock(m, mount2, launcher.mount, 'POLLEN')}
            onPick={pickMount2}
          />
        </div>
      )}
      {launcher.kind === 'dumper' && (
        // FOUR targets on the same nine-cell chassis. The corners and the centre are drawn as
        // frame rather than left out: a dumper's launch line spans a whole side, so a corner is
        // not a place it can be built, and showing the frame is what says so.
        <BbChassisMap
          caption="Firing edge"
          cells={BB_SHOOTER_EDGES}
          at={launcher.mount}
          marks={tubeMarks}
          onPick={pickLauncherMount}
        />
      )}
      {/* NO ELEVATION DIAL FOR EITHER. A turret solves its own elevation per shot, and a dumper
          lobs each dump for its distance (owner, 2026-09-13 — `bbLobThrow`), so a Hood slider
          would offer a control the sim never reads.
          ONLY THE DUMPER SAYS SO. Its line carries a NUMBER that is nowhere else on the screen;
          the turret's said that the control it does not have is not needed, which is a sentence
          about an absence (`docs/ui-standard.md` §8). */}
      {!bbIsTurreted(launcher) && (
        <p className="ds-hint">Lobs its load from up to {BB_DUMP_MAX_DIST} in away.</p>
      )}


      {/* ---- FLOWER SCORING: the Box Tube ---- */}
      <h3 className="ds-subh">Flower scoring</h3>
      {/* label-only, so `mini` chips — the same size as every other label-only pick in the builder */}
      <div className="ds-opts two">
        <button className={`ds-opt mini ${lift === null ? 'on' : ''}`} aria-pressed={lift === null} onClick={() => pickLift(null)}>
          <span className="ot">None</span>
        </button>
        {BB_LIFT_KINDS.map((k) => (
          <button
            key={k}
            className={`ds-opt mini ${lift?.kind === k ? 'on' : ''}`}
            aria-pressed={lift?.kind === k}
            onClick={() => pickLift(k)}>
            <span className="ot">{bbLiftKindLabel(k)}</span>
          </button>
        ))}
      </div>
      {lift && (
        /* The same chassis map. A tube and a launcher both sit ABOVE the deck, so this one CAN
           clash with the launcher — both turrets of a double turret, or a dumper's whole edge
           (`bbLauncherBlocker`), which is why the map draws where the launcher is. The centre is
           frame, never a target: the placement point has to sit past a chassis edge to reach a
           FLOWER. No height dial — a tube places at a point. */
        <BbChassisMap
          caption="Tube position"
          cells={BB_LIFT_POSITIONS}
          at={lift.mount}
          marks={launcherMarks}
          blocked={(m) =>
            lift.mount !== m && blockers.some((b) => mountsClash({ pos: m, spansEdge: false }, b))
              ? 'The launcher is mounted here'
              : undefined
          }
          onPick={pickLiftMount}
        />
      )}

    </>
  );
}
