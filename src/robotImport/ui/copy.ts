/**
 * EVERY STRING THE IMPORTER UI SHOWS, in one place (the lane 4 spec's copy table, §7). DOM-free,
 * so `npm test` holds it to the house rules: typographic ’ “ ” …, sentence case, `Couldn’t …` with
 * a next step, no padding words, no dash doing a full stop's job (`docs/area/ui.md`, UI COPY).
 *
 * The engine's own sentences (`ImportError.message`, `ImportCheck.message`, the drive checks, the
 * library's `LibraryResult.message`) are written to the same rules in their own files and shown as
 * they come; this file is what the UI adds around them.
 */
import type { LengthUnit, MotionPart, MotionRole, UpAxis } from '../types';

const ROLE_NAME: Record<MotionRole, string> = {
  wheel: 'Wheel',
  roller: 'Intake roller',
  flywheel: 'Flywheel',
  turret: 'Turret',
  ramp: 'Ramp',
  fold: 'Folding part',
  spin: 'Spinning part',
  swing: 'Swinging part',
  slide: 'Sliding part',
};
/** what each kind is called where a player picks one to add */
const ADD_KIND: Partial<Record<MotionRole, string>> = {
  fold: 'A part that folds out',
  spin: 'Something else that spins',
  swing: 'An arm or flap that swings',
  slide: 'A lift or a slide',
};
const CORNER_NAME = ['Front-left wheel', 'Front-right wheel', 'Back-left wheel', 'Back-right wheel'];
import { FORMAT_LABEL, PAGE_COPY } from './pageCopy';

export { FORMAT_LABEL };

export const COPY = {
  ...PAGE_COPY,
  // ---- the editor ----
  back: '← Robot',
  titleNew: 'Import a robot',
  titleEdit: (name: string) => `Edit ${name}`,
  discardNew: 'Discard import',
  discardEdit: 'Discard changes',
  discardTitleNew: 'Discard this import?',
  discardTitleEdit: 'Discard your changes?',
  discardBodyNew: 'The model and everything set here are removed.',
  discardBodyEdit: (name: string) => `${name} goes back to how it was saved.`,
  discard: 'Discard',
  steps: ['Model', 'Drivetrain', 'Mechanisms', 'Moving parts', 'Review'] as const,
  stepsAria: 'Import steps',
  stepOpen: (n: number) => `${n} to check`,
  prev: 'Back',
  next: (step: string) => `Next: ${step}`,
  notFoundBig: 'Robot not found',
  notFoundText: 'It isn’t in this device’s library.',
  backToRobot: 'Back to Robot',
  loading: 'Loading the importer…',
  restoring: 'Restoring your import…',

  // ---- undo and redo (`editorHistory.ts`): an edit's name follows the colon, in lower case ----
  undo: 'Undo',
  redo: 'Redo',
  undoAria: (what: string | null) => (what ? `Undo: ${what}` : 'Undo'),
  redoAria: (what: string | null) => (what ? `Redo: ${what}` : 'Redo'),
  /** the button's tooltip: its name and its shortcut */
  withKeys: (label: string, keys: string) => `${label} (${keys})`,
  undoKeys: (mac: boolean) => (mac ? '⌘Z' : 'Ctrl+Z'),
  redoKeys: (mac: boolean) => (mac ? '⇧⌘Z' : 'Ctrl+Y'),
  edits: {
    turn: 'turn the robot',
    up: 'change the up axis',
    units: 'change the units',
    useDetected: 'use the detected wheels',
    layout: 'change the wheel layout',
    wheels: 'move the wheels',
    mechanisms: 'change the mechanisms',
    placement: 'move a placement',
    resetPlacement: 'reset the placement',
    addMoving: 'add a moving part',
    findMoving: 'find the moving parts',
    rename: 'rename the robot',
    teamNumber: 'change the team number',
    move: (name: string) => `move the ${name}`,
    aim: (name: string) => `turn the ${name}`,
    change: (name: string) => `change the ${name}`,
    removeMoving: (name: string) => `remove the ${name}`,
  },

  // ---- Model ----
  dropTitle: 'Choose a file or drop it here',
  choose: 'Choose a file',
  dropFormats: 'GLB, glTF, STEP, STL, OBJ, 3MF or PLY, or a zip of one',
  sidecarHint: 'A glTF or OBJ comes with a .bin or .mtl file. Drop them together.',
  dropNow: 'Drop to import',
  phase: {
    read: (file: string) => `Reading ${file}…`,
    unzip: (file: string) => `Unzipping ${file}…`,
    parse: (file: string) => `Reading ${file}…`,
    'step-wasm': 'Loading the STEP reader…',
    'step-index': (file: string) => `Reading ${file}…`,
    'step-parse': (file: string) => `Reading ${file}…`,
    stepLeft: (file: string, seconds: number) =>
      `Reading ${file}, about ${seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${Math.max(10, Math.round(seconds / 10) * 10)} s`} left…`,
    convert: 'Converting the model…',
    simplify: (n: string) => `Simplifying ${n} triangles…`,
    prepare: (n: string) => `Preparing ${n} triangles…`,
    measure: 'Measuring…',
    engine: 'Loading the importer…',
    adding: (name: string) => `Adding ${name}…`,
  },
  progressAria: 'Import progress',
  fileCap: 'File',
  fileVal: (name: string, format: string, size: string) => `${name} · ${format} · ${size}`,
  savedModel: 'saved model',
  replace: 'Replace',
  size: 'Size (L × W × H)',
  fits: 'Fits 18 in',
  over: 'Over 18 in',
  triangles: 'Triangles',
  detail: 'Detail',
  detailFull: 'Full',
  detailFullNote: 'Every triangle of the CAD',
  detailLight: 'Light',
  detailLightNote: (n: number) => `Up to ${(n / 1000).toFixed(0)}k triangles, for a slower computer`,
  detailSaved: 'Set when the CAD file is read. Import the CAD file again to change it.',
  detailFile: 'Applies when the file is read. Replace the file to read it at this detail.',
  wheels: 'Wheels',
  wheelsFound: '4 found',
  wheelsSquared: '4 found, lined up as a rectangle',
  wheelsUneven: '4 found, not a rectangle',
  wheelsManual: 'Placed by hand',
  wheelsNone: 'None found. Drag all four into place.',
  units: 'Units',
  up: 'Up axis',
  detected: (v: string) => `Detected: ${v}`,
  orientHint: 'Check the preview: the robot stands on its wheels, and the arrow points to its front.',
  front: 'Front',
  frontDetected: 'Detected',
  frontFound: {
    intake: 'Detected from the intake',
    wheels: 'Detected from the wheels',
    mass: 'Detected from the weight',
  },
  frontAssumed: 'Assumed: the CAD front view',
  frontTurned: (deg: number) => `Turned ${deg}° from detected`,
  frontTurnedAssumed: (deg: number) => `Turned ${deg}° from the CAD front`,
  frontAssumedNote: 'The model shows no clear front, so the CAD front view is its front. Check the arrow in the preview, and turn it if it points the wrong way.',
  turnLeft: 'Turn left',
  turnRight: 'Turn right',
  footprint: 'Footprint and wheels',
  footprintAria: 'Footprint, seen from above, front up',
  frontMark: 'Front',
  wheelNames: ['Front left wheel', 'Front right wheel', 'Back left wheel', 'Back right wheel'] as const,
  wheelLayout: 'Wheel layout',
  layoutRect: 'Rectangle',
  layoutFree: 'Free',
  wheelbase: 'Wheelbase',
  track: 'Track width',
  centreForward: 'Centre forward',
  centreLeft: 'Centre left',
  forward: 'Forward',
  left: 'Left',
  useDetected: 'Use detected wheels',
  grabPad: (dpad: string, a: string, b: string) => `Move with ${dpad} or the left stick. ${a} to drop, ${b} to cancel.`,
  grabKeys: 'Arrow keys move it. Hold Shift for small steps. Home puts it back.',
  handleAria: (label: string, x: number, y: number, z?: number) => `${label}, ${where(x, y, z)}`,

  // ---- errors the UI adds (the engine's own come as ImportError messages) ----
  engineFailed: 'Couldn’t load the importer. Check your connection, then try again.',
  wrongGame: (name: string, season: string, other: string) => `Couldn’t add ${name} to ${season}. It was set up for ${other}.`,
  setUpFor: (season: string) => `Set it up for ${season}`,
  newer: 'Couldn’t read the DSIM setup in this file. A newer DSIM made it. Reload the page, or set it up again.',
  setUpAgain: 'Set it up again',
  chooseAnother: 'Choose another file',
  tryAgain: 'Try again',
  previewOff: 'Couldn’t start the 3D preview on this device. Showing the footprint.',
  bakeFailed: 'Couldn’t prepare the model. Try again, or reload the page.',
  storageBlocked: 'Saving needs site storage, which this browser is blocking.',

  // ---- preview ----
  cameras: [
    ['iso', '3/4'],
    ['top', 'Top'],
    ['front', 'Front'],
    ['side', 'Side'],
  ] as const,
  cameraAria: 'Preview camera',
  collision: 'Collision shape',
  previewEmpty: 'Your robot shows here, on a field tile beside the 18 in cube.',
  legend: {
    model: 'Arrow: the front. Blue line: the footprint. Green discs: the wheels.',
    drive: 'Arrow: the front. Green discs: the wheels.',
    mech: (has: { intake: boolean; shooter: boolean; place: boolean }) =>
      ['Arrow: the front.', has.intake ? 'Green bar: the intake.' : '', has.shooter ? 'Orange: the launcher.' : '', has.place ? 'Purple: where it places.' : ''].filter(Boolean).join(' '),
    moving: 'Blue: the selected part. Orange: the other moving parts.',
  },
  resetView: 'Reset view',

  // ---- Drivetrain ----
  drivetrain: 'Drivetrain',
  motor: 'Motor',
  motorFamilies: [
    ['gobilda', 'goBILDA 5203'],
    ['revHdHex', 'REV HD Hex'],
    ['revCoreHex', 'REV Core Hex'],
    ['neverest', 'NeveRest Orbital'],
    ['custom', 'Custom'],
  ] as const,
  gearbox: 'Gearbox',
  freeSpeed: 'Free speed',
  extRatio: 'External ratio',
  extRatioHint: 'motor turns per wheel turn',
  tankRatio: 'Traction ratio',
  wheel: 'Wheel',
  custom: 'Custom',
  diameter: 'Diameter',
  weight: 'Weight',
  weightHint: 'with the battery in',
  statRpm: 'Drive rpm',
  statSpeed: 'Top speed',
  statAccel: 'Accel',
  statPush: 'Push',
  limitsTitle: 'How the sim reads it',
  rpmOk: (dt: string, min: number, max: number) => `The sim drives ${dt} from ${min} to ${max} rpm.`,
  rpmHigh: (dt: string, max: number) => `Over the sim’s ${max} rpm for ${dt}. It drives at ${max}.`,
  rpmLow: (dt: string, min: number) => `Under the sim’s ${min} rpm for ${dt}. It drives at ${min}.`,
  massOk: (min: number, max: number) => `This build drives from ${min} to ${max} lb.`,
  massLow: (min: number) => `Under this build’s ${min} lb minimum. It drives as ${min} lb.`,
  massHigh: (max: number) => `Over ${max} lb. It drives as ${max} lb.`,
  speedLine: 'Follows drive rpm and the drivetrain.',
  speedTuned: 'Set under Practice tuning. Online rooms use the calculated numbers.',
  pushLine: 'Grows with weight and traction, and with gearing down.',

  // ---- Mechanisms ----
  mechanisms: 'Mechanisms',
  placement: 'Placement',
  mechAria: 'Mechanisms, seen from above, front up',
  height: 'Height',
  width: 'Width',
  centre: 'Centre',
  facing: 'Facing',
  facingHandle: (label: string) => `${label}, facing`,
  facingPlaced: (label: string, deg: number) => `${label} faces ${deg}° from forward.`,
  resetPlacement: 'Reset placement',
  placed: (label: string, x: number, y: number, z?: number) => `${label}: ${where(x, y, z)}`,
  span: (label: string, w: number, c: number) => `${label}: ${w.toFixed(1)} in wide, centred ${c.toFixed(1)} in along the edge`,
  noHandles: 'Pick the mechanisms above to place them here.',
  cadBuild: (set: readonly string[]) => `Set from the model: ${set.length > 1 ? `${set.slice(0, -1).join(', ')} and ${set[set.length - 1]}` : set[0]}. Change any of them below.`,
  cadTurret: 'a turret',
  cadFixed: 'a fixed shooter',
  cadFixedAt: (edge: string, deg: number) => `a fixed shooter facing ${edge === 'front' || edge === 'back' ? `the ${edge}` : edge} at ${deg}°`,
  cadFixedFacing: (edge: string) => `a fixed launcher facing ${edge === 'front' || edge === 'back' ? `the ${edge}` : edge}`,
  cadIntake: (side: boolean, mount: string) => `${side ? 'side rollers' : 'a sweeper'} at the ${mount === 'side' ? 'side' : mount}`,
  cadNoLift: 'no box tube',
  cadHandLoaded: 'no intake (loaded by hand)',
  moving: 'Moving parts',
  movingHint: 'Select a part to see it in the preview and change it.',
  movingNone: 'Nothing moves yet. Find moving parts looks for the wheels, rollers, flywheels and a turret.',
  motionRole: (role: MotionRole, corner?: number) =>
    role === 'wheel' && corner !== undefined ? (CORNER_NAME[corner] ?? ROLE_NAME.wheel) : (ROLE_NAME[role] ?? 'Moving part'),
  motionSummary: (role: MotionRole, n: number, p: MotionPart | undefined, found: boolean) => {
    const parts = `${n} ${n === 1 ? 'part' : 'parts'}`;
    if (!p || typeof p !== 'object') return `${parts}. Couldn’t find how it turns, so it stays still. Add its round part.`;
    const what =
      role === 'ramp' || role === 'fold'
        ? `${parts}, deploys ${Math.round((p.deploy * 180) / Math.PI)}°`
        : role === 'swing'
          ? `${parts}, swings ${Math.round(((p.amount ?? 0) * 180) / Math.PI)}°`
          : role === 'slide'
            ? `${parts}, slides ${Number((p.amount ?? 0).toFixed(2))} in`
            : parts;
    return found ? `${what} · found automatically` : what;
  },
  motionEmpty: 'No parts yet. Click them in the preview.',
  motionEdit: 'Edit',
  motionDone: 'Done',
  motionPickHint: (role: MotionRole) =>
    role === 'wheel' || role === 'roller' || role === 'flywheel' || role === 'spin'
      ? 'Click a part in the preview to add it or take it out. A click takes everything on that axle; Shift-click takes one part.'
      : 'Click a part in the preview to add it or take it out, with what is mounted on it. Shift-click takes one part.',
  motionReverse: (role: MotionRole) => (role === 'swing' ? 'Swings the other way' : role === 'slide' ? 'Slides the other way' : 'Turns the other way'),
  motionRemove: 'Remove',
  motionRemoveAria: (label: string) => `Remove ${label}`,
  motionFileAria: 'How the file shows it',
  motionFile: { deployed: 'File shows it deployed', folded: 'File shows it folded' },
  motionFoldBy: 'Folds up by',
  motionDeployBy: 'Deploys by',
  motionFind: 'Find moving parts',
  motionPickAxisHint: 'Click the part it turns about or slides along: an axle, a pin, a rail.',
  motionDriveLabel: 'Moved by',
  motionDrives: { intake: 'Intake', shooter: 'Launcher', fire: 'Each shot', ramp: 'Ramp', drive: 'Driving', always: 'Always' } as const,
  motionGearedShort: 'Its gearing',
  motionAbout: 'Turns about',
  motionAlong: 'Slides along',
  motionAxes: { forward: 'Front to back', left: 'Side to side', up: 'Upright', part: 'A part' } as const,
  motionAxisPicked: 'Picked part',
  motionAmount: {
    spin: { label: 'Speed', unit: 'turns/s' },
    swing: { label: 'Swings by', unit: '°' },
    slide: { label: 'Slides by', unit: 'in' },
  } as const,
  motionGeared: 'Geared to',
  motionRatio: 'Ratio',
  motionRides: 'Rides on',
  motionNone: 'Nothing',
  motionAddCap: 'Add a moving part',
  motionAddPick: 'Choose what it is…',
  motionAddKind: (role: MotionRole) => ADD_KIND[role] ?? ROLE_NAME[role] ?? 'Moving part',
  motionPlay: 'Play',
  motionStop: 'Stop',
  tuneDrive: 'Practice tuning',
  tuneMech: 'Mechanism tuning',
  tuneHint: 'Set these to match your real robot. They play in solo practice, Free Drive and the test drive; online rooms use the calculated numbers.',
  tuneCalculated: 'Calculated',
  tuneReset: 'Reset',
  tuneResetAria: (label: string) => `Reset ${label.toLowerCase()} to the calculated number`,
  tuneResetAll: 'Reset all to calculated',
  tune: {
    topSpeed: { label: 'Top speed', unit: 'in/s' },
    accel: { label: 'Acceleration', unit: 'in/s²' },
    turnRate: { label: 'Turn rate', unit: '°/s' },
    aimTurn: { label: 'Aim turn rate', unit: '°/s' },
    shotInterval: { label: 'Time between shots', unit: 's' },
    spinUp: { label: 'Flywheel spin-up', unit: 'rpm/s' },
    intakeTime: { label: 'Intake time', unit: '×' },
    reload: { label: 'Reload', unit: 's' },
    turretSlew: { label: 'Turret speed', unit: '°/s' },
    rampDeployS: { label: 'Ramp swing', unit: 's' },
  },

  // ---- Review ----
  checks: 'Checks',
  allPass: 'All checks pass',
  toFix: (n: number) => `${n} to fix before saving`,
  notes: (n: number) => `Ready, with ${n} ${n === 1 ? 'note' : 'notes'}`,
  passFits: 'Fits the 18 in cube',
  tooSmall: (side: number, min: number) =>
    `The footprint is only ${side.toFixed(1)} in across. The sim needs ${min} in a side, so check the units.`,
  passWheels: 'Four wheels on the footprint',
  passWeight: 'Weight in the sim’s range',
  passRpm: 'Drive rpm in the sim’s range',
  passMech: 'Mechanisms placed',
  fix: 'Fix',
  fixAria: (s: string) => `Fix: ${s}`,
  teamName: 'Team name',
  teamNumber: 'Team #',
  testDrive: 'Test drive',
  saveNew: 'Save robot',
  saveEdit: 'Save changes',
  fixFirst: 'Fix the checks above first.',
  working: 'Preparing the model…',
  levelNames: { block: 'must fix', warn: 'note', info: 'note', ok: 'passes' } as const,

  // ---- test drive (the HUD's own ALL CAPS voice) ----
  hudBack: 'EDITOR',
  hudBackTitle: 'Back to the importer (Esc)',
} as const;

/** "4.5 in forward, 5.3 in right, 12.0 in high": signs as words, from the footprint's centre */
export function where(x: number, y: number, z?: number): string {
  const a = (v: number): string => Math.abs(v).toFixed(1);
  const h = z === undefined ? '' : `, ${z.toFixed(1)} in high`;
  return `${a(x)} in ${x < 0 ? 'back' : 'forward'}, ${a(y)} in ${y < 0 ? 'right' : 'left'}${h}`;
}

export const UNIT_LABEL: Record<LengthUnit, string> = { mm: 'mm', cm: 'cm', m: 'm', in: 'in', ft: 'ft' };

/** "+Z" / "−Z": the minus is U+2212, not a hyphen */
export function upLabel(a: UpAxis): string {
  return `${a[0] === '-' ? '−' : '+'}${a[1].toUpperCase()}`;
}

/** 38.2 MB, 640 KB */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

