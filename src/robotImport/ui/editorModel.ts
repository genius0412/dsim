/**
 * THE IMPORTER EDITOR'S MODEL, DOM-free so `npm test` can hold it: the document the editor edits
 * (and the draft store keeps), how a document plus a measurement becomes the `RobotSpec` that is
 * test-driven and saved, and the Review step's checks.
 *
 * Frames (`docs/area/robot-import.md`): wheel overrides and mechanism placements are kept in the
 * MODEL frame, which does not move when a wheel is dragged; the descriptor converts them to
 * robot-local when the spec is built.
 */
import type { GameId } from '../../games/types';
import type { ImportedEdge, ImportedMech, RobotSpec, Vec2 } from '../../types';
import { coerceSpec } from '../../sim/spawn';
import { IMPORT_MIN_SIDE } from '../../sim/imported';
import { driveParams, massLimits, pushForce, rpmLimits } from '../../sim/drivetrain';
import { chainMassFloorBump } from '../../games/chain/config';
import { DRIVETRAIN_LABELS } from '../../ui/labelData';
import { bbox, buildDescriptor, isRectangle, linesToWheels, q64, squareWheels, WHEEL_SQUARE_TOL_IN, wheelLines, type WheelLines } from '../geometry';
import { driveReadout, driveRpmFor, importedDriveFields } from '../drive';
import type { FloatingGroup, FrontDetection, ImportCheck, ImportMeasurement, ImportSetup, LengthUnit, LibrarySource, MotionGroup, QuarterTurns, UpAxis, WheelLayout } from '../types';
import { validateMechFor } from './placement';
import type { CadBuild } from '../motion';
import { bbIntakeKindOf, bbLauncherOf, bbScoreModeMirror, type BbIntakeKind } from '../../games/biobuzz/mechs';
import { BB_FIXED_HOOD_MAX_DEG, BB_FIXED_HOOD_MIN_DEG, BB_HOOD_DEFAULT_DEG, BB_POLLEN_R } from '../../games/biobuzz/config';
import { BB_IMPORT_DUMP_Z, BB_IMPORT_TURRET_Z } from '../../games/biobuzz/importMech';
import { DECODE_IMPORT_LAUNCH_MIN } from '../../sim/importedMech';
import { BALL_RADIUS } from '../../config';
import { BB_DEFAULT_SHOOTER_MOUNT, isEdgePos, type BbIntakeMount, type BbMountPos, type BbScoreMode } from '../../games/biobuzz/mounts';
import { COPY } from './copy';

export const STEP_COUNT = 4;
/** Model · Drivetrain · Mechanisms · Moving parts · Review */
export type StepIndex = 0 | 1 | 2 | 3 | 4;

/** what the editor edits; plain JSON, so the draft store keeps it as is */
export interface EditorDoc {
  v: 1;
  /** `<game>:new` or `<game>:<id>` */
  key: string;
  game: GameId;
  /** the robot's id (a new one for a new import, the library id when editing) */
  id: string;
  /** the library robot being edited, or null for a new import */
  editId: string | null;
  step: StepIndex;
  setup: ImportSetup;
  /**
   * what auto-detection chose when the file was read, for the "Detected: mm" hints. `yaw` and
   * `front` (absent in drafts from before front detection): the quarter turns the file was read at,
   * and whether that front was found in the geometry or assumed to be the CAD front view.
   */
  detected: { units: LengthUnit; up: UpAxis; yaw?: QuarterTurns; front?: 'detected' | 'assumed'; cue?: FrontDetection['cue'] } | null;
  /** mechanism placements, MODEL frame */
  mech: ImportedMech | null;
  /** identity, mechanism fields and assists; the import fields are filled in by `buildSpec` */
  spec: RobotSpec;
  source: LibrarySource | null;
  /** the model is a saved robot's stored mesh (re-open), not the file it came from */
  savedModel: boolean;
  /** what reading the file left out or assumed, in the reader's words (Review shows them as notes) */
  notes?: string[];
  /** created time of the library robot being edited */
  created: number | null;
  /** the source file's name, for the robot page's "Resume import" card */
  sourceName: string | null;
  /**
   * what a NEW import's mechanisms were set to from the model (`buildFromCad`), in words for the
   * Mechanisms step; `[]` when the model showed nothing to set. Absent: not looked yet (an edit, a
   * re-open, a draft from before 2026-10-04 never looks).
   */
  cadBuild?: string[];
  /**
   * the launcher placements the same read gave (`buildFromCad`, MODEL frame): where Reset puts them
   * back, and what the game's defaults are filled in around
   */
  cadMech?: ImportedMech;
  /** the mechanism fields as that read set them (`cadMechKey`): while they still match, turning the model
   *  reads the build again in its new frame */
  cadKey?: string;
  /** the model was turned (or its units or up axis changed) before the player changed the build:
   *  read it again in the new frame */
  cadReread?: boolean;
  updated: number;
}

export const draftKey = (game: GameId, editId: string | null): string => `${game}:${editId ?? 'new'}`;

/** the file's name without its extension, cut to the name field's 24 */
export function baseName(file: string): string {
  return (file.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim() || 'Robot').slice(0, 24);
}

/** extra lb a game adds to the mass floor (the same value `coerceSpec` uses) */
export function extraMassFloor(game: GameId, spec: RobotSpec): number {
  return game === 'chain' ? chainMassFloorBump(spec) : 0;
}

export interface Built {
  spec: RobotSpec;
  /** what the player chose before the sim's clamps */
  raw: { rpm: number; tankRpm?: number; massLb: number };
}

/**
 * The spec that is test-driven and saved: the descriptor from the measurement, the drivetrain
 * numbers from the gearing, the game's mechanism fields, and `coerceSpec` with the last word on
 * every one of them. Identity text is kept as typed (it is length-capped on save).
 */
export function buildSpec(doc: EditorDoc, m: ImportMeasurement): Built {
  const descriptor = buildDescriptor({ id: doc.id, measurement: m, mech: doc.mech });
  const hb = bbox(descriptor.hull);
  const box = { length: hb.maxX - hb.minX, width: hb.maxY - hb.minY };
  const extra = extraMassFloor(doc.game, doc.spec);
  const fields = importedDriveFields(doc.spec, doc.setup.drive, box, extra);
  const raw: RobotSpec = {
    ...doc.spec,
    ...fields,
    imported: doc.setup.tune ? { ...descriptor, tune: doc.setup.tune } : descriptor,
    ...(doc.game === 'biobuzz' ? { heightIn: descriptor.heightIn } : {}),
  };
  const spec: RobotSpec = { ...coerceSpec(raw, undefined, doc.game), name: doc.spec.name, teamName: doc.spec.teamName };
  const { rpm, tankRpm } = driveRpmFor(doc.setup.drive);
  return { spec, raw: { rpm, tankRpm, massLb: doc.setup.drive.massLb } };
}

/** the four numbers the Drivetrain step shows, read off the spec that will drive */
export interface DriveNumbers {
  rpm: number;
  topSpeed: number;
  accel: number;
  pushLbf: number;
  rpmRange: { min: number; max: number };
  massRange: { min: number; max: number };
  lines: { label: string; text: string; warn: boolean }[];
  checks: ImportCheck[];
}

const G_IN_S2 = 386.0886;

export function driveNumbers(built: Built, game: GameId): DriveNumbers {
  const s = built.spec;
  const p = driveParams(s);
  const rpmRange = rpmLimits(s.drivetrain);
  const massRange = massLimits(s.drivetrain, s.flywheelInertia, extraMassFloor(game, s));
  const dt = DRIVETRAIN_LABELS[s.drivetrain].toLowerCase();
  const ro = driveReadout(s, { driveRpm: built.raw.rpm, tankRpm: built.raw.tankRpm, massLb: built.raw.massLb }, extraMassFloor(game, s));
  const rawRpm = built.raw.rpm;
  const rawMass = built.raw.massLb;
  const rpmLine =
    rawRpm > rpmRange.max
      ? { text: COPY.rpmHigh(dt, rpmRange.max), warn: true }
      : rawRpm < rpmRange.min
        ? { text: COPY.rpmLow(dt, rpmRange.min), warn: true }
        : { text: COPY.rpmOk(dt, rpmRange.min, rpmRange.max), warn: false };
  const massLine =
    rawMass < s.massLb - 0.005
      ? { text: COPY.massLow(s.massLb), warn: true }
      : rawMass > s.massLb + 0.005
        ? { text: COPY.massHigh(s.massLb), warn: true }
        : { text: COPY.massOk(massRange.min, massRange.max), warn: false };
  return {
    rpm: s.driveRpm,
    topSpeed: p.maxSpeed,
    accel: p.accel,
    pushLbf: pushForce(s) / G_IN_S2,
    rpmRange,
    massRange,
    lines: [
      { label: COPY.statRpm, ...rpmLine },
      { label: COPY.weight, ...massLine },
      { label: COPY.statSpeed, text: s.imported?.tune?.topSpeed !== undefined || s.imported?.tune?.accel !== undefined ? COPY.speedTuned : COPY.speedLine, warn: false },
      { label: COPY.statPush, text: COPY.pushLine, warn: false },
    ],
    checks: ro.checks,
  };
}

/** one line of the Review list */
export interface ReviewItem {
  id: string;
  level: 'block' | 'warn' | 'info' | 'ok';
  text: string;
  /** where "Fix" goes: the step, and the id of the control to focus */
  fix?: { step: StepIndex; focus: string };
}

/** where each engine check is fixed */
const FIX: Partial<Record<ImportCheck['code'], { step: StepIndex; focus: string }>> = {
  oversize: { step: 0, focus: 'ri-units' },
  'units-suspect': { step: 0, focus: 'ri-units' },
  'up-uncertain': { step: 0, focus: 'ri-up' },
  'no-floor': { step: 0, focus: 'ri-up' },
  'few-wheels': { step: 0, focus: 'ri-wheels' },
  'wheels-off-hull': { step: 0, focus: 'ri-wheels' },
  'mass-low': { step: 1, focus: 'ri-weight' },
  'mass-high': { step: 1, focus: 'ri-weight' },
  'rpm-low': { step: 1, focus: 'ri-motor' },
  'rpm-high': { step: 1, focus: 'ri-motor' },
  'tank-rpm-clamped': { step: 1, focus: 'ri-tank' },
  'front-assumed': { step: 0, focus: 'ri-front' },
};

/**
 * The front was ASSUMED (no cue in the geometry was strong enough) and nobody has turned it since:
 * the Review step says so, because a robot that drives backwards is the one mistake the import
 * cannot see. A saved robot's stored mesh knows its front.
 */
export function frontAssumed(doc: Pick<EditorDoc, 'detected' | 'savedModel' | 'setup'> | null): boolean {
  return !!doc && !doc.savedModel && doc.detected?.front === 'assumed' && doc.setup.yaw === (doc.detected.yaw ?? 0);
}

/** the step each check belongs to, for the step rail's counts */
export function stepOf(item: ReviewItem): StepIndex {
  return item.fix?.step ?? 4;
}

/**
 * Every check, passes included, in step order. `block` disables Save, Test drive and Export.
 * A pass line stands in for a category with nothing to say, so the list says what was checked.
 */
export function reviewItems(m: ImportMeasurement | null, built: Built | null, game: GameId, assumedFront = false, notes: readonly string[] = []): ReviewItem[] {
  if (!m || !built) return [{ id: 'empty', level: 'block', text: COPY.dropTitle, fix: { step: 0, focus: 'ri-choose' } }];
  const items: ReviewItem[] = [];
  if (assumedFront) items.push({ id: 'front-assumed', level: 'info', text: COPY.frontAssumedNote, fix: FIX['front-assumed'] });
  // the reader's own notes (a large STEP's left-out fasteners, an .obj without its .mtl)
  notes.forEach((text, i) => items.push({ id: `read-note-${i}`, level: 'info', text }));
  const codes = new Set(m.checks.map((c) => c.code));
  for (const c of m.checks) {
    if (c.code === 'mesh-simplified' || c.code === 'hull-simplified' || c.code === 'wheels-picked') continue;
    items.push({ id: c.code, level: c.level, text: c.message, fix: FIX[c.code] });
  }
  // TOO SMALL is a block too: `coerceImported` refuses a footprint under 6 in a side (or 24 in²) and the
  // robot would silently play as its parametric fallback. Almost always a units mistake.
  const imp = built.spec.imported;
  const hb = bbox(m.hull);
  const sideMin = m.hull.length >= 3 ? Math.min(hb.maxX - hb.minX, hb.maxY - hb.minY) : 0;
  if (!codes.has('empty') && !codes.has('oversize') && (!imp || sideMin < IMPORT_MIN_SIDE)) {
    items.push({ id: 'tiny', level: 'block', text: COPY.tooSmall(sideMin, IMPORT_MIN_SIDE), fix: { step: 0, focus: 'ri-units' } });
  } else if (!codes.has('oversize') && !codes.has('empty')) items.push({ id: 'fits', level: 'ok', text: COPY.passFits });
  if (!codes.has('no-floor') && !codes.has('few-wheels') && !codes.has('wheels-off-hull')) {
    items.push({ id: 'wheels', level: 'ok', text: COPY.passWheels });
  }
  const dn = driveNumbers(built, game);
  for (const c of dn.checks) items.push({ id: c.code, level: c.level, text: c.message, fix: FIX[c.code] });
  const driveCodes = new Set(dn.checks.map((c) => c.code));
  if (!driveCodes.has('mass-low') && !driveCodes.has('mass-high')) items.push({ id: 'mass-ok', level: 'ok', text: COPY.passWeight });
  if (!driveCodes.has('rpm-low') && !driveCodes.has('rpm-high')) items.push({ id: 'rpm-ok', level: 'ok', text: COPY.passRpm });
  const mech = validateMechFor(built.spec, game);
  mech.forEach((c, i) => items.push({ id: `mech-${i}`, level: c.level, text: c.text, fix: { step: 2, focus: !c.key ? 'ri-placement' : c.key.startsWith('intake:') ? `ri-h-${c.key}:mid` : `ri-h-${c.key}` } }));
  if (!mech.length) items.push({ id: 'mech-ok', level: 'ok', text: COPY.passMech });
  const rank = { block: 0, warn: 1, info: 2, ok: 3 } as const;
  return items.sort((a, b) => stepOf(a) - stepOf(b) || rank[a.level] - rank[b.level]);
}

export const blocks = (items: readonly ReviewItem[]): number => items.filter((i) => i.level === 'block').length;

/** the Review title: all pass, the number to fix, or ready with notes */
export function reviewSummary(items: readonly ReviewItem[]): string {
  const b = blocks(items);
  if (b) return COPY.toFix(b);
  const n = items.filter((i) => i.level === 'warn' || i.level === 'info').length;
  return n ? COPY.notes(n) : COPY.allPass;
}

/** the units hint maths (spec §2 Review): which unit would make the largest side robot-sized */
export function suggestUnit(largestIn: number, current: LengthUnit): LengthUnit | null {
  const asSource = largestIn / ({ mm: 1 / 25.4, cm: 1 / 2.54, m: 1 / 0.0254, in: 1, ft: 12 } as const)[current];
  for (const u of ['mm', 'cm', 'm', 'in'] as const) {
    if (u === current) continue;
    const v = asSource * ({ mm: 1 / 25.4, cm: 1 / 2.54, m: 1 / 0.0254, in: 1 } as const)[u];
    if (v > 6 && v <= 18) return u;
  }
  return null;
}

// ---- wheels: the two layouts, the rectangle's numbers, snapping --------------------------------
//
// A RECTANGLE layout keeps the four wheels on four lines (`WheelLines`: the front and back axles,
// the left and right sides). A wheel moved moves the two lines through it, so its axle partner and
// its side partner follow and the four never stop being an exact rectangle. A FREE layout moves one
// wheel at a time, for a robot whose wheels are not a rectangle. Everything is in the MODEL frame.

/** FL FR BL BR, MODEL frame, 1.5 in inside the footprint's box */
export function rectangleWheels(hull: readonly Vec2[]): Vec2[] {
  const b = bbox(hull);
  const i = 1.5;
  return [
    { x: b.maxX - i, y: b.maxY - i },
    { x: b.maxX - i, y: b.minY + i },
    { x: b.minX + i, y: b.maxY - i },
    { x: b.minX + i, y: b.minY + i },
  ];
}

/**
 * The layout the Model step works in. A picked one stands. Unpicked (`wheelLayout` absent: a new
 * import, or a setup from before layouts), it is a rectangle when the wheels are one: placed wheels
 * exactly, so nothing placed by hand moves, and detected wheels within `WHEEL_SQUARE_TOL_IN`, which
 * the measurement then lines up (`finishMeasure`). Otherwise free, with the wheels as they are.
 */
export function wheelLayoutOf(setup: Pick<ImportSetup, 'wheelLayout' | 'wheels'>, detected: readonly Vec2[] | null): WheelLayout {
  if (setup.wheelLayout === 'rect' || setup.wheelLayout === 'free') return setup.wheelLayout;
  if (setup.wheels) return isRectangle(setup.wheels) ? 'rect' : 'free';
  return !detected || isRectangle(detected, WHEEL_SQUARE_TOL_IN) ? 'rect' : 'free';
}

/** where Home puts the wheels: the detected ones (lined up, in a rectangle), else the rectangle default */
export function wheelHomes(m: Pick<ImportMeasurement, 'wheels' | 'hull'>, layout: WheelLayout): Vec2[] | null {
  const det = m.wheels.wheels;
  if (det) return layout === 'rect' ? squareWheels(det) : det.map((w) => ({ x: w.x, y: w.y }));
  return m.hull.length >= 3 ? rectangleWheels(m.hull) : null;
}

/** the closest a rectangle's axles (or sides) come to each other, inches: the lines never cross */
export const WHEEL_MIN_SPAN_IN = 1;

/**
 * A line as the rectangle edits start from it: kept when it is on a fine binary grid (anything placed
 * or typed here is, and halving it a few times keeps it there), so a number typed earlier stays
 * exactly what was typed; else on the 1/64 grid (a detected wheel's centre is a decimal no short
 * binary fraction holds).
 */
const tidy = (v: number): number => (Number.isInteger(v * 2 ** 20) ? v : q64(v));

function linesOf(wheels: readonly Vec2[]): WheelLines {
  const l = wheelLines(wheels);
  return { front: tidy(l.front), back: tidy(l.back), left: tidy(l.left), right: tidy(l.right) };
}

/**
 * Move wheel `i` to `p` (quantised to 1/64 in). RECTANGLE: its axle and its side go to `p`, the other
 * two lines stay, and the lines keep `WHEEL_MIN_SPAN_IN` apart. FREE: that wheel alone.
 */
export function moveWheel(wheels: readonly Vec2[], i: number, p: Vec2, layout: WheelLayout): Vec2[] {
  const x = q64(p.x);
  const y = q64(p.y);
  if (layout === 'free') {
    const out = wheels.map((w) => ({ x: w.x, y: w.y }));
    out[i] = { x, y };
    return out;
  }
  const l = linesOf(wheels);
  if (i < 2) l.front = Math.max(x, l.back + WHEEL_MIN_SPAN_IN);
  else l.back = Math.min(x, l.front - WHEEL_MIN_SPAN_IN);
  if (i % 2 === 0) l.left = Math.max(y, l.right + WHEEL_MIN_SPAN_IN);
  else l.right = Math.min(y, l.left - WHEEL_MIN_SPAN_IN);
  return linesToWheels(l);
}

/** the rectangle's four numbers: its size, and where its centre sits from the footprint's centre */
export type RectNumber = 'wheelbase' | 'track' | 'forward' | 'left';

export function rectNumbers(wheels: readonly Vec2[]): Record<RectNumber, number> {
  const l = wheelLines(wheels);
  return { wheelbase: l.front - l.back, track: l.left - l.right, forward: (l.front + l.back) / 2, left: (l.left + l.right) / 2 };
}

/**
 * The rectangle with one of its numbers set to exactly `v`: the wheelbase or the track about the
 * rectangle's centre, the centre with its size kept. Every result is a small binary fraction, so
 * reading the number back gives `v` bit for bit.
 */
export function setRectNumber(wheels: readonly Vec2[], key: RectNumber, v: number): Vec2[] {
  const l = linesOf(wheels);
  if (key === 'wheelbase' || key === 'forward') {
    const c = key === 'forward' ? v : (l.front + l.back) / 2;
    const h = key === 'wheelbase' ? v / 2 : (l.front - l.back) / 2;
    l.front = c + h;
    l.back = c - h;
  } else {
    const c = key === 'left' ? v : (l.left + l.right) / 2;
    const h = key === 'track' ? v / 2 : (l.left - l.right) / 2;
    l.left = c + h;
    l.right = c - h;
  }
  return linesToWheels(l);
}

/**
 * What the layout pick writes. Into a rectangle, wheels placed by hand are lined up on their
 * averaged lines (detected ones are lined up by the measurement); into free, nothing placed moves,
 * and detected wheels show as they were found.
 */
export function layoutPatch(setup: Pick<ImportSetup, 'wheels'>, layout: WheelLayout): Pick<ImportSetup, 'wheelLayout'> & Partial<Pick<ImportSetup, 'wheels'>> {
  if (layout === 'rect' && setup.wheels) return { wheelLayout: 'rect', wheels: linesToWheels(linesOf(setup.wheels)) };
  return { wheelLayout: layout };
}

/** a wheel dragged by the pointer lands on a floor contact this close, inches */
export const WHEEL_SNAP_CONTACT_IN = 0.4;
/** and otherwise on this grid, inches */
export const WHEEL_SNAP_GRID_IN = 1 / 16;

/** where a pointer drag puts a wheel: the nearest floor contact within reach, else the grid */
export function snapWheel(p: Vec2, contacts: readonly Vec2[]): Vec2 {
  let best: Vec2 | null = null;
  let bd = WHEEL_SNAP_CONTACT_IN;
  for (const c of contacts) {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d <= bd) {
      bd = d;
      best = c;
    }
  }
  if (best) return { x: best.x, y: best.y };
  const g = (v: number): number => Math.round(v / WHEEL_SNAP_GRID_IN) * WHEEL_SNAP_GRID_IN;
  return { x: g(p.x), y: g(p.y) };
}

/** an intake span's lateral range on its edge (y for front/back, x for left/right) */
export function edgeRange(edge: ImportedEdge, hull: readonly Vec2[]): { lo: number; hi: number; at: number } {
  const b = bbox(hull);
  switch (edge) {
    case 'front':
      return { lo: b.minY, hi: b.maxY, at: b.maxX };
    case 'back':
      return { lo: b.minY, hi: b.maxY, at: b.minX };
    case 'left':
      return { lo: b.minX, hi: b.maxX, at: b.maxY };
    case 'right':
      return { lo: b.minX, hi: b.maxX, at: b.minY };
  }
}

/**
 * The moving parts before Find moving parts looks again: the rows the player has edited (not
 * `found`), with what they name by index (`follows`, `rideOn`) moved to where those rows now sit,
 * and a link to a row that goes dropped.
 */
export function keepEditedMotion(groups: readonly MotionGroup[]): MotionGroup[] {
  const keep = groups.map((g, i) => (g.found ? -1 : i)).filter((i) => i >= 0);
  const at = new Map(keep.map((old, k) => [old, k]));
  return keep.map((i) => {
    const g: MotionGroup = { ...groups[i] };
    const f = g.follows ? at.get(g.follows.group) : undefined;
    if (g.follows && f !== undefined) g.follows = { ...g.follows, group: f };
    else delete g.follows;
    const r = g.rideOn !== undefined ? at.get(g.rideOn) : undefined;
    if (r !== undefined) g.rideOn = r;
    else delete g.rideOn;
    return g;
  });
}

// ---- deleting parts (`docs/area/robot-import.md`, "Deleting parts") -----------------------------

/**
 * The moving parts without the bodies in `gone`: each row loses them (a joint whose axle part went
 * turns about its own again), a row they leave empty goes, and what named the rows after it by index
 * (`follows`, `rideOn`) moves up with them. A row that was empty already (just added, not yet
 * picked) stays.
 */
export function pruneMotion(groups: readonly MotionGroup[], gone: ReadonlySet<number>): MotionGroup[] {
  const drop = new Set<number>();
  const kept = groups.map((g, i) => {
    if (!g.bodies.some((b) => gone.has(b)) && !(g.axisBody !== undefined && gone.has(g.axisBody))) return g;
    const out: MotionGroup = { ...g, bodies: g.bodies.filter((b) => !gone.has(b)) };
    if (out.axisBody !== undefined && gone.has(out.axisBody)) {
      delete out.axisBody;
      delete out.axis;
    }
    if (g.bodies.length && !out.bodies.length) drop.add(i);
    return out;
  });
  if (!drop.size) return kept;
  const at = new Map<number, number>();
  kept.forEach((_, i) => {
    if (!drop.has(i)) at.set(i, at.size);
  });
  return kept
    .filter((_, i) => !drop.has(i))
    .map((g) => {
      const out: MotionGroup = { ...g };
      const f = g.follows ? at.get(g.follows.group) : undefined;
      if (g.follows && f !== undefined) out.follows = { ...g.follows, group: f };
      else delete out.follows;
      const r = g.rideOn !== undefined ? at.get(g.rideOn) : undefined;
      if (r !== undefined) out.rideOn = r;
      else delete out.rideOn;
      return out;
    });
}

/**
 * The document with `bodies` deleted too: added to `setup.removed` and taken out of the moving parts.
 * `movesFrame` (`removalMovesFrame`): the model's box changed, and the MODEL frame with it, so the
 * wheels placed by hand and the mechanism placements are found again, as after a Units, Up axis or
 * Turn change. A deletion inside the box moves nothing and keeps them.
 */
export function deleteBodies(d: EditorDoc, bodies: readonly number[], movesFrame: boolean): EditorDoc {
  if (!bodies.length) return d;
  const gone = new Set([...(d.setup.removed ?? []), ...bodies]);
  const setup: ImportSetup = { ...d.setup, removed: [...gone].sort((a, b) => a - b) };
  if (d.setup.motion) setup.motion = pruneMotion(d.setup.motion, new Set(bodies));
  if (movesFrame) setup.wheels = null;
  return { ...d, setup, ...(movesFrame ? frameMoved(d) : {}) };
}

/**
 * What a move of the model frame (a units, up or front change, or a deletion that changes the
 * model's box) does to the document: the placements go, and with them the ones read from the model
 * (`cadMech`, in the old frame); while the player has not changed the build that read set
 * (`cadKey`), it is read again in the new frame (`cadReread`).
 */
export function frameMoved(d: EditorDoc): Pick<EditorDoc, 'mech' | 'cadMech'> & { cadReread?: boolean } {
  const reread = d.cadBuild !== undefined && d.cadKey !== undefined && d.cadKey === cadMechKey(d.spec);
  return { mech: null, cadMech: undefined, ...(reread ? { cadReread: true } : {}) };
}

/** the document with every deleted body back (the moving parts keep what they have) */
export function restoreBodies(d: EditorDoc, movesFrame: boolean): EditorDoc {
  if (!d.setup.removed) return d;
  const setup: ImportSetup = { ...d.setup };
  delete setup.removed;
  if (movesFrame) setup.wheels = null;
  return { ...d, setup, ...(movesFrame ? frameMoved(d) : {}) };
}

/** the floating groups the editor offers to delete: the ones the player has not chosen to keep */
export function floatingOffer(m: Pick<ImportMeasurement, 'floating'> | null, setup: Pick<ImportSetup, 'keepFloating'>): FloatingGroup[] {
  if (!m?.floating?.length) return [];
  const keep = new Set(setup.keepFloating ?? []);
  return m.floating.filter((g) => !g.bodies.every((b) => keep.has(b)));
}

/** the setup a saved robot keeps: no deleted bodies, since its stored mesh is made without them (and
 *  a body id names a body of the file as read, not of the stored mesh read back) */
export function savedSetup(s: ImportSetup): ImportSetup {
  if (!('removed' in s)) return s;
  const out = { ...s };
  delete out.removed;
  return out;
}

/** each moving part's name: its kind (a wheel's corner), numbered when two share one */
export function motionNames(groups: readonly MotionGroup[]): string[] {
  const base = groups.map((g) => COPY.motionRole(g.role, g.corner));
  const seen = new Map<string, number>();
  return base.map((n) => {
    if (base.filter((m) => m === n).length < 2) return n;
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return `${n} ${k}`;
  });
}

/**
 * A NEW IMPORT'S MECHANISMS FROM ITS MODEL (2026-10-04, owner on goBILDA's BIOBUZZ mecanum bot: "side
 * rollers are not selected by default, single static shooter is not selected by default, offset
 * boxtube is selected even though I dont have it"). An import starts from the player's current robot,
 * whose launcher, intake and Box Tube were nothing to do with the file. What `readBuild` saw sets them:
 * - BIOBUZZ: upright rollers at an edge are SIDE ROLLERS there, rollers along it a SWEEPER; a flywheel
 *   on a turret ring a single TURRET, else a FIXED shooter; no Box Tube (the model cannot say there is
 *   one, and the starter bots have none). What the model did not show stays as it was.
 * - DECODE: no roller at any edge is no intake (loaded by hand), and a flywheel on a ring a turret,
 *   else a fixed launcher.
 * Chain Reaction is left alone. Returns the spec and what was set, in words, or null for no change.
 */
export function buildFromCad(game: GameId, spec: RobotSpec, cad: CadBuild): { spec: RobotSpec; set: string[]; mech?: ImportedMech } | null {
  const set: string[] = [];
  const shot = cad.launcher?.shot;
  const mech = cadLauncherMech(game, cad);
  if (game === 'biobuzz') {
    const launcher = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
    let kind: BbScoreMode = launcher.kind;
    let mount: BbMountPos = launcher.mount;
    let hoodDeg = launcher.hoodDeg;
    if (cad.launcher) {
      kind = cad.launcher.turret ? 'turret' : 'fixed';
      if (kind === 'fixed' && !isEdgePos(mount)) mount = BB_DEFAULT_SHOOTER_MOUNT;
      if (kind === 'turret' && launcher.kind !== 'turret') mount = 'center';
      // a fixed launcher faces the edge its hood throws toward, at the hood's angle
      if (kind === 'fixed' && shot) {
        mount = edgeOf(shot.dir);
        hoodDeg = Math.min(BB_FIXED_HOOD_MAX_DEG, Math.max(BB_FIXED_HOOD_MIN_DEG, Math.round(shot.elevDeg)));
      }
    }
    let intake: BbIntakeKind = bbIntakeKindOf(spec);
    let intakeMount = (spec.intakeMount ?? 'front') as BbIntakeMount;
    if (cad.intake) {
      intake = cad.intake.upright ? 'siderollers' : 'sweeper';
      intakeMount = cad.intake.edge === 'front' ? 'front' : cad.intake.edge === 'back' ? 'back' : 'side';
      set.push(COPY.cadIntake(intake === 'siderollers', intakeMount));
    }
    if (cad.launcher) set.push(kind === 'turret' ? COPY.cadTurret : shot ? COPY.cadFixedAt(mount, hoodDeg) : COPY.cadFixed);
    // a Box Tube where the model shows box tubes, on the cell they stand in; else none
    const liftMount = cad.lift && cad.box ? cellOf(cad.lift.base, cad.box) : null;
    set.push(liftMount ? COPY.cadLift(cad.lift!.count, liftMount) : COPY.cadNoLift);
    const next = coerceSpec(
      {
        ...spec,
        scoreMode: bbScoreModeMirror(kind),
        shooterMount: mount,
        intakeMount,
        intakeSide: intakeMount === 'side',
        bbMech: { launcher: { kind, mount, hoodDeg }, lift: liftMount ? { kind: 'vslide', mount: liftMount } : null, intake: { kind: intake } },
      },
      undefined,
      'biobuzz',
    );
    const placed: ImportedMech | undefined =
      liftMount && cad.lift ? { ...(mech ?? {}), place: { x: q64(cad.lift.base[0]), y: q64(cad.lift.base[1]), z: q64(cad.lift.base[2]) } } : mech;
    return { spec: { ...next, name: spec.name }, set, ...(placed ? { mech: placed } : {}) };
  }
  if (game === 'decode') {
    const patch: Partial<RobotSpec> = {};
    if (!cad.intake) {
      patch.intake = 'none';
      set.push(COPY.cadHandLoaded);
    } else if (spec.intake === 'none') patch.intake = 'sloped';
    if (cad.launcher) {
      patch.launcher = cad.launcher.turret ? 'turret' : 'fixed';
      set.push(cad.launcher.turret ? COPY.cadTurret : shot ? COPY.cadFixedFacing(edgeOf(shot.dir)) : COPY.cadFixed);
    }
    if (!set.length) return null;
    return { spec: { ...coerceSpec({ ...spec, ...patch }, undefined, 'decode'), name: spec.name }, set, ...(mech ? { mech } : {}) };
  }
  return null;
}

/** the mechanism fields `buildFromCad` sets, as a key: equal while the player has not changed them */
export function cadMechKey(spec: RobotSpec): string {
  return JSON.stringify([spec.bbMech, spec.intakeMount, spec.intakeSide, spec.shooterMount, spec.scoreMode, spec.launcher, spec.intake]);
}

/** the element a launcher throws, inches across, for reading its hood (`readShot`); 0: none */
export function launchElementD(game: GameId): number {
  return game === 'biobuzz' ? 2 * BB_POLLEN_R : game === 'decode' ? 2 * BALL_RADIUS : 0;
}

/**
 * the perimeter cell of BIOBUZZ's nine-cell map a point stands in, by thirds of the footprint `box`
 * (MODEL frame: x0, y0, x1, y1); the middle cell goes to the edge it is nearest
 */
function cellOf(p: readonly number[], box: readonly number[]): BbMountPos {
  const fx = (p[0] - box[0]) / Math.max(1e-6, box[2] - box[0]);
  const fy = (p[1] - box[1]) / Math.max(1e-6, box[3] - box[1]);
  const row = fx > 2 / 3 ? 'front' : fx < 1 / 3 ? 'back' : '';
  const col = fy > 2 / 3 ? 'left' : fy < 1 / 3 ? 'right' : '';
  if (row && col) return `${row}${col}` as BbMountPos;
  if (row || col) return (row || col) as BbMountPos;
  return Math.abs(fx - 0.5) >= Math.abs(fy - 0.5) ? (fx >= 0.5 ? 'front' : 'back') : fy >= 0.5 ? 'left' : 'right';
}

/** the bounding-box edge a horizontal direction points at, MODEL frame (+x front, +y left) */
function edgeOf(d: readonly number[]): ImportedEdge {
  return Math.abs(d[0]) >= Math.abs(d[1]) ? (d[0] >= 0 ? 'front' : 'back') : d[1] >= 0 ? 'left' : 'right';
}

/**
 * WHERE THE MODEL'S LAUNCHER IS, as placements (MODEL frame): a turret's axis, at the height its hood
 * releases from, else the release point its hood gives (`readShot`) facing the way it throws. The
 * release height is held inside what the game accepts there. Undefined when the model shows neither.
 */
export function cadLauncherMech(game: GameId, cad: CadBuild): ImportedMech | undefined {
  const l = cad.launcher;
  if (!l || (game !== 'biobuzz' && game !== 'decode')) return undefined;
  const shot = l.shot;
  const zr = game === 'decode' ? { min: DECODE_IMPORT_LAUNCH_MIN, max: 18 } : l.turret ? BB_IMPORT_TURRET_Z : BB_IMPORT_DUMP_Z;
  const zOf = (z: number): number => q64(Math.min(zr.max, Math.max(zr.min, z)));
  if (l.turret && l.axis) return { shooter: { x: q64(l.axis[0]), y: q64(l.axis[1]), z: zOf(shot ? shot.release[2] : l.at[2]) } };
  if (l.turret || !shot) return undefined;
  let yaw = Math.round((Math.atan2(shot.dir[1], shot.dir[0]) * 180) / Math.PI);
  if (yaw <= -180) yaw += 360;
  return { shooter: { x: q64(shot.release[0]), y: q64(shot.release[1]), z: zOf(shot.release[2]) }, shooterYawDeg: yaw };
}
