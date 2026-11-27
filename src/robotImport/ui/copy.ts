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
import { ZERO_POWER_LABEL } from '../../ui/labelData';

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
    deleteParts: (n: number) => `delete ${n} ${n === 1 ? 'part' : 'parts'}`,
    restoreParts: 'restore the deleted parts',
    keepFloating: 'keep the floating parts',
    leaveOut: (n: number) => `leave ${n} ${n === 1 ? 'part' : 'parts'} out of the footprint`,
    includeAll: 'include all parts in the footprint',
  },

  // ---- Model ----
  dropTitle: 'Choose a file or drop it here',
  choose: 'Choose a file',
  dropFormats: 'STEP CAD (.step or .stp) or a zip of it, or a DSIM robot share (.glb)',
  notStep: (names: string) => `Couldn’t import ${names}. Choose a STEP CAD file (.step or .stp), a zip with one in it, or a DSIM robot share (.glb).`,
  zipNoStep: (zip: string, inside: string) =>
    `Couldn’t import ${zip}: ${inside ? `it holds ${inside} but no STEP file` : 'it is empty'}. Choose a zip with a .step or .stp file in it, or the STEP file itself.`,
  sidecarHint: 'Export the robot from your CAD program as a STEP file.',
  dropNow: 'Drop to import',
  detailBefore: 'Before the file is read',
  pendingTitle: 'File ready to import',
  pendingFiles: (names: string) => `${names} · choose Detail, then start the import.`,
  pendingShare: (name: string) => `${name} · start to restore this DSIM robot.`,
  startImport: 'Start import',
  keepCurrent: 'Keep current model',
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
  wheelsGuessed: 'None found. Placed at the drive base’s corners: drag them onto the wheels.',
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
  parts: 'Parts',
  partsState: (selected: number, deleted: number, apart = 0) =>
    [selected ? `${selected} selected` : '', deleted ? `${deleted} deleted` : '', apart ? `${apart} left out` : ''].filter(Boolean).join(', '),
  floating: (n: number, near: number, far: number) =>
    `${n} ${n === 1 ? 'part floats' : 'parts float'} ${near.toFixed(1)}${far - near >= 0.05 ? ` to ${far.toFixed(1)}` : ''} in away from the robot. Delete ${n === 1 ? 'it' : 'them'}?`,
  /** the offer when it holds more than floating parts: what floats apart, what HANGS below the floor the
   *  robot stands on (`hangingParts`) and what looks like a game ball (`findGamePieces`), each counted
   *  in bodies, then one question */
  offer: (o: { floats?: { n: number; near: number; far: number }; hangs?: { n: number; lo: number; hi: number }; balls?: { n: number; d: number[] } }) => {
    const span = (a: number, b: number): string => `${a.toFixed(1)}${b - a >= 0.05 ? ` to ${b.toFixed(1)}` : ''}`;
    const said: string[] = [];
    if (o.floats?.n) said.push(`${o.floats.n} ${o.floats.n === 1 ? 'part floats' : 'parts float'} ${span(o.floats.near, o.floats.far)} in away from the robot.`);
    if (o.hangs?.n) said.push(`${o.hangs.n} ${o.hangs.n === 1 ? 'part hangs' : 'parts hang'} ${span(o.hangs.lo, o.hangs.hi)} in below the floor the robot stands on.`);
    if (o.balls?.n) {
      const ds = [...new Set(o.balls.d.map((d) => d.toFixed(1)))].sort((a, b) => Number(a) - Number(b));
      const sizes = ds.length === 1 ? ds[0] : `${ds.slice(0, -1).join(', ')} and ${ds[ds.length - 1]}`;
      said.push(o.balls.n === 1 ? `1 part looks like a game piece, a ${sizes} in ball.` : `${o.balls.n} parts look like game pieces, ${sizes} in balls.`);
    }
    const n = (o.floats?.n ?? 0) + (o.hangs?.n ?? 0) + (o.balls?.n ?? 0);
    return `${said.join(' ')} Delete ${n === 1 ? 'it' : 'them'}?`;
  },
  floatDelete: 'Delete',
  floatKeep: 'Keep',
  deleteParts: 'Select parts',
  deleteDone: 'Done',
  deleteSelected: 'Delete selected',
  leaveOut: 'Leave out of footprint',
  includeAll: 'Include all',
  deleteHint:
    'Click a part in the preview to select it. Shift-click selects more. Leave out of footprint keeps a part (a deployed ramp) on the robot but measures the footprint and wheels without it. The Delete key removes them.',
  restoreAll: 'Restore all',
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
  /** a share file whose robot, setup or 3D model cannot be read: the FILE is the problem, not this device */
  shareUnreadable: (names: string) => `Couldn’t add ${names}. Its robot or its 3D model can’t be read. Ask for it to be exported from DSIM again.`,
  /** a dropped .glb larger than any robot file DSIM writes (`SHARE_MAX_FILE_BYTES`): refused before it is read */
  shareTooBig: (name: string) => `Couldn’t open ${name}. It is larger than any robot file DSIM saves. Export it again from DSIM.`,
  /** an error shown over a model that is still loaded (a failed Replace, a refused file): the model stays usable */
  dismiss: 'Dismiss',
  /** the model never measured (a restored draft, or a setting the measurement cannot take) */
  /** a NEW file whose first measurement threw: the file read fine, so exporting it again cannot help */
  readMeasureFailed: (name: string, full: boolean) =>
    `Couldn’t measure ${name}. Close other tabs and try again${full ? ', choose Light detail' : ''}, or choose another file.`,
  measureFailed: (canUndo: boolean) => `Couldn’t measure this model. ${canUndo ? 'Undo your last change, choose' : 'Choose'} another file, or discard this import.`,
  /** why Save, Export and Test drive wait while a file is read */
  waitRead: 'Wait for the file to finish reading.',
  /** the importer itself failed to draw: the draft is kept on this device unless it is discarded here */
  crashBig: 'Couldn’t show this import',
  crashText: 'Go back to the robot page and resume it, or discard it to start again.',
  discardThis: 'Discard this import',
  discardBodyChanges: 'Your unsaved changes are removed. The saved robot stays as it was.',
  /**
   * the draft is no longer being written to this device, so a reload would lose the import
   * (`draftStore.ts`). Storage that is blocked fails Save for the same reason, so the way out that
   * needs no storage (Export file) is named in the second case, which covers every cause but a full device.
   */
  draftNotSaved: (full: boolean) =>
    full
      ? 'Couldn’t keep this import on this device: it is out of storage space for DSIM, so a reload would lose it. Save the robot, or delete an imported robot to make room.'
      : `Couldn’t keep this import on this device, so a reload would lose it. Save the robot to keep your work. If saving fails too, ${PAGE_COPY.exportFile} on the Review step downloads a copy.`,

  /** the status line over an EDIT whose unsaved changes came back from this device, until the next edit */
  draftRestored: 'Restored your unsaved changes.',
  /** the status line once a Detail re-read's moving parts are in (`rereadNote`), until the next edit or read */
  rereadNote: {
    refound: 'Moving parts were found again at this detail. Check them under Moving parts.',
    rows: 'The moving parts you changed or removed don’t carry to another detail, so they were found again. Check them under Moving parts.',
    parts: 'Deleted and left-out parts don’t carry to another detail. Delete or leave them out again on the Model step.',
    failed: 'Couldn’t find the moving parts at this detail. Use Find moving parts under Moving parts, or add them yourself.',
  },
  /** asked before a Detail change that would lose what the player made by hand (`rereadLoses`) */
  detailLoseTitle: 'Change the detail?',
  detailLoseBody: (l: { rows: number; removedRows: number; parts: number; kept: number }) => {
    const n = (k: number, one: string, many: string): string => (k === 1 ? `1 ${one}` : `${k} ${many}`);
    const what = [
      l.rows ? `your changes to ${n(l.rows, 'moving part', 'moving parts')}` : '',
      l.removedRows ? `${n(l.removedRows, 'moving part', 'moving parts')} you removed, which may be found again` : '',
      l.parts ? `${n(l.parts, 'part', 'parts')} you deleted or left out of the footprint` : '',
      l.kept ? `${n(l.kept, 'part', 'parts')} you kept when the editor offered to delete ${l.kept === 1 ? 'it' : 'them'}, which will be offered again` : '',
    ].filter(Boolean);
    return `The file is read again at the new detail and its parts are numbered again. These don’t carry over, and Undo can’t bring them back: ${what.join('; ')}.`;
  },
  detailLoseConfirm: 'Change detail',
  /** why Save, Export and Test drive wait after a Detail change or a new file (`leaveGate`) */
  waitMoving: 'Wait for the moving parts to be found.',

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
    mechEdit: 'Click the green bar or the orange and purple marks to pick one. Drag an arrow to move it. G grabs, then X, Y or Z locks an axis. Esc puts it back.',
    moving: 'Blue: the selected part. Orange: the other moving parts.',
    deleting: 'Blue: the selected parts. Orange: the parts left out of the footprint.',
    apart: 'Orange: the parts left out of the footprint.',
    floating: 'Blue: the parts offered for deleting.',
  },

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
  tankRatio: 'Traction ratio',
  zeroPower: ZERO_POWER_LABEL,
  wheel: 'Wheel',
  custom: 'Custom',
  diameter: 'Diameter',
  weight: 'Weight',
  statRpm: 'Drive rpm',
  statSpeed: 'Top speed',
  statAccel: 'Accel',
  statPush: 'Push',
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
  /** what the model's intake was read as; `nectar`: it takes NECTAR as well (a build with a Box Tube) */
  cadIntake: (kind: string, mount: string, rampEdge?: string, nectar = false) => {
    const what = kind === 'siderollers' ? 'side rollers' : kind === 'ramp' ? 'a ramp' : 'a ground intake';
    const takes = nectar ? ' for POLLEN and NECTAR' : '';
    if (mount === 'frontback' || mount === 'side') {
      const [a, b] = mount === 'side' ? ['left', 'right'] : ['front', 'back'];
      // a ramp at one end of a two-ended intake: the other end takes in with its rollers alone
      if (kind === 'ramp' && rampEdge) return `a ramp at the ${rampEdge} and rollers at the ${rampEdge === a ? b : a}${takes}`;
      return `${what} at the ${a} and the ${b}${takes}`;
    }
    return `${what} at the ${mount}${takes}`;
  },
  cadNoLift: 'no box tube',
  cadLift: (count: number, cell: string) => `${count > 1 ? `a box tube (${count} slides)` : 'a box tube'} at the ${cell.replace(/^(front|back)(left|right)$/, '$1 $2')}`,
  cadHandLoaded: 'no intake (loaded by hand)',
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
  motionFinding: 'Looking for moving parts…',
  motionPickAxisHint: 'Click the part it turns about or slides along: an axle, a pin, a rail.',
  motionDriveLabel: 'Moved by',
  motionDrives: { intake: 'Intake', shooter: 'Launcher', fire: 'Each shot', ramp: 'Ramp', drive: 'Driving', always: 'Always', place: 'Placing' } as const,
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
  allPass: 'All checks pass',
  toFix: (n: number) => `${n} to fix before saving`,
  notes: (n: number) => `Ready, with ${n} ${n === 1 ? 'note' : 'notes'}`,
  passFits: 'Fits the 18 in cube',
  apartWarn: (n: number) => `${n} ${n === 1 ? 'part' : 'parts'} left out of the footprint: drawn, but no collision and not counted in the 18 in cube.`,
  meshReach: (parts: string, side: number, up: number) =>
    `The 3D model sticks out of the space a room can draw: ${parts}. A room draws a model within ${side} in of the robot’s middle and ${up} in high; past that every screen shows the plain outline instead. Select the parts that stick out (Model step, Parts) and delete them, or shorten them in your CAD and export again.`,
  tooSmall: (side: number, min: number) =>
    `The footprint is only ${side.toFixed(1)} in across. The sim needs ${min} in a side, so check the units.`,
  originEdge: 'The wheels sit at the edge of the footprint. Drag the wheels toward the middle.',
  passWheels: 'Four wheels on the footprint',
  passWeight: 'Weight in the sim’s range',
  passRpm: 'Drive rpm in the sim’s range',
  passMech: 'Mechanisms placed',
  fix: 'Fix',
  fixAria: (s: string) => `Fix: ${s}`,
  teamName: 'Team name',
  teamNumber: 'Team #',
  /** under the identity fields, every game: what a room sees of this robot, and what only goes if the player says so */
  reviewSharing: 'In a room, everyone sees this robot’s outline and measurements. Its picture and 3D model are sent only if you choose to share them.',
  testDrive: 'Test drive',
  saveNew: 'Save robot',
  saveEdit: 'Save changes',
  fixFirst: 'Fix the checks above first.',
  working: 'Preparing the model…',
  levelNames: { block: 'must fix', warn: 'note', info: 'note', ok: 'passes' } as const,

  // ---- test drive (the HUD's own ALL CAPS voice) ----
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

