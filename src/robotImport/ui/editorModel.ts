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
import type { FrontDetection, ImportCheck, ImportMeasurement, ImportSetup, LengthUnit, LibrarySource, MotionGroup, QuarterTurns, UpAxis, WheelLayout } from '../types';
import { validateMechFor } from './placement';
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
