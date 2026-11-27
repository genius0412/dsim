import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GameSettings } from '../../game';
import type { GameId, ImportedMech, RobotSpec, Vec2 } from '../../types';
import { coerceSpec } from '../../sim/spawn';
import { bbIntakeKindOf, bbIsTurreted, bbLauncherOf } from '../../games/biobuzz/mechs';
import { BB_HOOD_DEFAULT_DEG } from '../../games/biobuzz/config';
import { decodeFixedLauncher } from '../../sim/fixedShot';
import { seasonFor } from '../../seasons';
import { FOCUSABLE } from '../../ui/PadNavLayer';
import { usePageTop } from '../../ui/pageScroll';
import { loadImporterEngine, type ImporterEngine } from '../engineLoader';
import type { ImportProgress, NormalisedModel, PreparedModel } from '../engine/importerEngine';
import type { LoadStage } from '../engine/load';
import { wheelDiameterMm } from '../drive';
import { defaultImportSetup, isFullDetail, orientKey, removalMovesFrame, transformParts, type MeshPart } from '../geometry';
import { coaxialBodies, isSpin, MOTION_FINDER, motionAsStored, mountedBodies } from '../motion';
import type { Found, MotionSearch, Search, WheelInputs } from '../findMoving';
import { askPersistentStorage, deleteRobot, getRobot, listRobots, newRobotId, putRobot } from '../library';
import { editSaveId, planShareAdd } from '../libraryIds';
import { coerceImportSetup, readShareFile, SHARE_MAX_FILE_BYTES, shareHeaderRefusal, type SharePayload } from '../shareFile';
import { STORED_MESH_TO_ROBOT, type ImportSetup, type LibraryRobot, type MotionGroup, type QuarterTurns, type WheelLayout } from '../types';
import { defaultMechFor, mechHandlesFor, mechRobotToModel, validateMechFor } from './placement';
import { invalidateImportedAssets, registerImportedAssets, unregisterImportedAssets } from '../../render/importedAssets';
import { COPY } from './copy';
import { DrivetrainStep } from './DrivetrainStep';
import { dropDraft, flushDraft, forgetLiveDraft, keepDraft, liveDraft, onDraftSaveFailure, restoreDraft, type LiveDraft } from './draftStore';
import type { DropError, Phase } from './DropZone';
import {
  baseName,
  blocks,
  buildSpec,
  draftKey,
  frontAssumed,
  frontFromBuild,
  driveNumbers,
  layoutPatch,
  motionNames,
  moveWheel,
  rectangleWheels,
  buildFromCad,
  cadMechKey,
  deleteBodies,
  frameMoved,
  floatingOffer,
  includeAllBodies,
  launchElementD,
  leaveOutBodies,
  followFrame,
  keepEditedMotion,
  measuredTurretRing,
  sameFrame,
  turretOnRing,
  withoutDefaults,
  defaultsIn,
  restoreBodies,
  reviewItems,
  reviewSummary,
  savedSetup,
  setRectNumber,
  stepOf,
  wheelLayoutOf,
  type EditorDoc,
  type RectNumber,
  readFailureText,
  readKeepsBuild,
  readSetup,
  type ReadOpts,
  type ReviewItem,
  type StepIndex,
} from './editorModel';
import {
  applyEdit,
  driveEdit,
  historyShortcut,
  lowerFirst,
  mechEdit,
  motionEdit,
  nextRedo,
  nextUndo,
  ownsUndo,
  redoDoc,
  setupEdit,
  undoDoc,
  withEditMark,
  type EditHow,
} from './editorHistory';
import { downloadBytes, shareBytes, shareFileName } from './exportRobot';
import { checkImportFiles } from './fileSelection';
import { libraryChanged, postRobotNotice, takeHandedFiles } from './handoff';
import { ConfirmDialog, DuplicateDialog } from './LibraryDialogs';
import { MechanismsStep } from './MechanismsStep';
import { ModelStep } from './ModelStep';
import { MotionPanel, type PickTarget } from './MotionPanel';
import { TunePanel } from './TunePanel';
import { driveTuneFields, mechTuneFields } from './tuneFields';
import { PreviewPane } from './PreviewPane';
import { AIM, buildHandles, firstHandle, moveHandle, splitKey } from './mechMove';
import { ReviewStep } from './ReviewStep';
import { TopDownMap } from './TopDownMap';
import './../../ui/importer.css';

/**
 * THE ROBOT IMPORT EDITOR — `/<game>/configure/robot/import[/<id>]`, a lazy chunk (lane 4 spec §2).
 *
 * One screen: a step rail (Model · Drivetrain · Mechanisms · Moving parts · Review), the step's panel, and a
 * persistent preview. The document it edits (`EditorDoc`) lives in the draft store, not in this
 * component: a test drive unmounts the editor and the way back remounts it, and a reload restores it
 * from IndexedDB, so neither loses a thing.
 *
 * The engine (three.js, the loaders) is fetched on the first file, a draft resume or a re-open —
 * never on an empty editor.
 *
 * THE STATES A PLAYER CAN BE IN, and the way out of each (all of them a real button: mouse, keyboard
 * and pad reach every one). `phase` = a file is being read, `error` = what the last read or drop said,
 * `model` = a model is in the draft, `m` = it has been measured.
 *
 *   no model, no phase ........ the drop box. Out: choose a file (button), Back.
 *   phase ..................... the drop box's progress. Out: Cancel (stops the workers), Back (stops them
 *                               too, and leaves no draft behind), and, once a model exists, Discard.
 *   no model, error ........... the drop box with the sentence. Out: Choose another file, the error's own
 *                               action (Try again, Set it up for …), Back.
 *   model, error .............. the Model step as usual under a banner (`ModelStep`). Out: Dismiss, the
 *                               banner's own action, any step button; the error also clears when the player
 *                               leaves the Model step, and when a new read starts.
 *   model, not measured ....... "Measuring…" while the measure worker answers. A measurement that fails (the
 *                               worker threw, `normalise` threw, the engine never loaded) ends it: the error
 *                               says so, with Choose another file, Try again for the engine, Undo, Discard
 *                               and Back. Cancel on "Measuring…" is the same exit, not a dead button.
 *   a read in flight .......... Save, Export and Test drive wait (their title says why); everything else is
 *                               live, and a read that lands after the editor left, or after a save, is ignored.
 *   a render throws ........... `EditorBoundary`: Back to Robot (the draft is kept and resumes on the Model
 *                               step) or Discard this import.
 *
 * LEAVING (Back, a route change, a save, a discard) stops what is running: the read is aborted (its worker
 * pool, up to six occt readers, otherwise ran on for minutes and then wrote a draft nobody asked for) and
 * the draft is written. Once it is on this device the in-memory copy and the engine's measure worker are
 * let go (`forgetLiveDraft`, `releaseModel`): the whole prepared model, every triangle at Full detail,
 * stayed in memory for the session after Back. A TEST DRIVE is the one exception: it comes straight back
 * to this document, so nothing is stopped and nothing is let go.
 */
export interface ImportEditorProps {
  settings: GameSettings;
  /** the library robot being edited, or null for a new import */
  editId: string | null;
  onBack: () => void;
  /** saved (or added from a share file): the App makes it active and goes back to the robot page */
  onSaved: (spec: RobotSpec) => void;
  onTestDrive: (spec: RobotSpec) => void;
}

/** the Moving parts step and the Review step (`COPY.steps`) */
const MOVING_STEP = 3;
const REVIEW_STEP = 4;

/** focus to restore when the editor comes back from a test drive */
let focusOnReturn: string | null = null;
/** the engine module once loaded, so a remount (the way back from a test drive) has it on its
 *  first render instead of flashing the empty Model step while `import()` resolves again */
let engineCache: ImporterEngine | null = null;
/** editors mounted per draft key: an editor that leaves lets its draft's memory go only when no other has
 *  taken the key over (StrictMode's rehearsal remount, a Resume that beat the flush) */
const mountedEditors = new Map<string, number>();

const STAGE_LABEL = (stage: LoadStage, file: string): string => {
  const p = COPY.phase[stage];
  return typeof p === 'function' ? p(file) : p;
};

/** an error for a share file that cannot be used as it is: told apart from a failure of this device's own */
function fileProblem(message: string): Error {
  const e = new Error(message);
  e.name = 'ShareFileProblem';
  return e;
}

/** is this build's launcher ONE turret (its placement is the turret's centre, `turretOnRing`)? */
function singleTurret(game: GameId, spec: RobotSpec): boolean {
  if (game === 'biobuzz') return bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG).kind === 'turret';
  if (game === 'chain') return spec.scoreMode === 'turret';
  return !decodeFixedLauncher(spec);
}

/** does this build's launcher sit on a turret (so a turret is worth looking for in the model)? */
function turretBuild(game: GameId, spec: RobotSpec): boolean {
  if (game === 'biobuzz') return bbIsTurreted(bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG));
  if (game === 'chain') return spec.scoreMode === 'turret' || spec.scoreMode === 'twinturret';
  return !decodeFixedLauncher(spec);
}

/** the drop box's line for an import stage reported by the engine (worker or not); at Full detail
 *  nothing the player sees is simplified, so that stage says it is preparing the triangles */
const progressLabel = (p: ImportProgress, file: string, full: boolean): string =>
  p.stage === 'simplify'
    ? (full ? COPY.phase.prepare : COPY.phase.simplify)((p.tris ?? 0).toLocaleString('en-US'))
    : p.stage === 'measure'
      ? COPY.phase.measure
      : STAGE_LABEL(p.stage, file);

/** a measurement still running after this long says so; a shorter one would only flicker */
const MEASURING_NOTICE_MS = 300;

/** the shortcuts the Undo and Redo titles name: ⌘ on a Mac, Ctrl elsewhere */
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function freshDoc(settings: GameSettings, key: string, editId: string | null): EditorDoc {
  const base: RobotSpec = { ...settings.spec };
  delete base.imported;
  return {
    v: 1,
    key,
    game: settings.game,
    id: editId ?? newRobotId(),
    editId,
    step: 0,
    setup: defaultImportSetup({ massLb: settings.spec.massLb }),
    detected: null,
    mech: null,
    spec: base,
    source: null,
    savedModel: false,
    created: null,
    sourceName: null,
    updated: Date.now(),
  };
}

/**
 * A THROW WHILE THE EDITOR DRAWS must not strand the draft (MIMPUI-10). The shell's boundary offers only
 * Home, the draft restored on the next visit at the step it was left on, and Discard lives inside the
 * editor, so a draft that crashed its step crashed again each time. This one is inside the editor: it says
 * so, offers the robot page (a draft resumes on the Model step, the one a crash in another step does not
 * reach) and Discard, which asks first, because it removes minutes of reading. A different draft key
 * draws the editor again.
 */
class EditorBoundary extends Component<
  { resetKey: string; onBack: () => void; children: ReactNode },
  { failed: boolean; key: string; confirm: boolean; busy: boolean }
> {
  state = { failed: false, key: this.props.resetKey, confirm: false, busy: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { key: string }): { failed: boolean; key: string; confirm: boolean } | null {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey, confirm: false };
  }

  componentDidCatch(err: unknown): void {
    console.warn('[import] Couldn’t draw the editor.', err);
  }

  private discard = async (): Promise<void> => {
    const k = this.props.resetKey;
    this.setState({ busy: true });
    // whatever of the draft is still in memory, and the engine's copy of its model, go with it
    const gone = liveDraft(k);
    try {
      await dropDraft(k);
      if (gone?.model) engineCache?.releaseModel(gone.model);
      if (gone) unregisterImportedAssets(gone.doc.id);
    } catch (e) {
      console.warn('[import] discard failed', e);
    }
    this.props.onBack();
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { confirm, busy } = this.state;
    return (
      <>
        <div className="ds-head">
          <button type="button" className="ds-back" onClick={this.props.onBack}>
            {COPY.back}
          </button>
        </div>
        <div className="ds-empty" role="alert">
          <p className="big">{COPY.crashBig}</p>
          <p>{confirm ? (this.props.resetKey.endsWith(':new') ? COPY.discardBodyNew : COPY.discardBodyChanges) : COPY.crashText}</p>
          {confirm ? (
            <>
              <button type="button" className="ds-btn danger" disabled={busy} onClick={() => void this.discard()}>
                {COPY.discard}
              </button>
              <button type="button" className="ds-btn" disabled={busy} onClick={() => this.setState({ confirm: false })}>
                {COPY.cancel}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="ds-btn" onClick={this.props.onBack}>
                {COPY.backToRobot}
              </button>
              <button type="button" className="ds-btn danger" onClick={() => this.setState({ confirm: true })}>
                {COPY.discardThis}
              </button>
            </>
          )}
        </div>
      </>
    );
  }
}

export default function ImportEditor(props: ImportEditorProps) {
  return (
    <EditorBoundary resetKey={draftKey(props.settings.game, props.editId)} onBack={props.onBack}>
      <ImportEditorInner {...props} />
    </EditorBoundary>
  );
}

function ImportEditorInner({ settings, editId, onBack, onSaved, onTestDrive }: ImportEditorProps) {
  const game = settings.game;
  const key = draftKey(game, editId);
  const [draft, setDraftState] = useState<LiveDraft | null>(() => liveDraft(key));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [eng, setEng] = useState<ImporterEngine | null>(engineCache);
  const engRef = useRef<ImporterEngine | null>(engineCache);
  const [notFound, setNotFound] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [error, setError] = useState<DropError | null>(null);
  /** files handed from the robot page; kept here until Detail is chosen in the editor */
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  const [wheelDrag, setWheelDrag] = useState<Vec2[] | null>(null);
  const [selWheel, setSelWheel] = useState(0);
  const [selHandle, setSelHandle] = useState<string | null>(null);
  /** the files the model was read from, while the editor is open: a new detail re-reads them */
  const sourceFiles = useRef<File[] | null>(null);
  /** the moving part being picked in the preview, or null; and whether the preview runs them */
  const [activeMotion, setActiveMotion] = useState<number | null>(null);
  /** the moving part whose row is under the pointer, shown while none is selected */
  const [hoverMotion, setHoverMotion] = useState<number | null>(null);
  const [pickTarget, setPickTarget] = useState<PickTarget>('bodies');
  const [playing, setPlaying] = useState(false);
  /** the Model step's Delete parts mode, and the bodies selected in it */
  const [deleting, setDeleting] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    { kind: 'discard' } | { kind: 'dup'; name: string; replace: () => void; keepBoth: () => void } | null
  >(null);
  const gen = useRef(0);
  /** the import in flight: aborting it terminates its workers (Cancel, a new drop, leaving) */
  const importAbort = useRef<AbortController | null>(null);
  const pendingFocus = useRef<string | null>(null);
  /** set when the editor leaves for a test drive, which comes straight back to this document: nothing is
   *  stopped and nothing let go on that way out */
  const leavingForDrive = useRef(false);
  /** the files the robot page handed over, held while the boot reads the stored draft (see the boot effect) */
  const handedFiles = useRef<File[] | null>(null);
  /** the model whose measurement was given up on (the worker threw, or the player cancelled "Measuring…") */
  const [failedFor, setFailedFor] = useState<unknown>(null);
  /** an EDIT's unsaved changes came back from this device (MIMPUI-15): said in the status line until the next edit */
  const [restoredNote, setRestoredNote] = useState(false);
  /** the importer engine would not load, with a draft restored: there is nothing to measure it with */
  const [engineDown, setEngineDown] = useState(false);

  const setDraft = useCallback((d: LiveDraft | null) => {
    draftRef.current = d;
    setDraftState(d);
    if (d) keepDraft(d);
  }, []);
  /**
   * Edit the document (and keep the draft). An edit is the PLAYER's unless it says `'auto'`: it goes
   * on the undo history (`editorHistory.ts`), named by `how.label`, and quick repeats with the same
   * `how.key` are one step. `'auto'` is what the editor does by itself (placements defaulting in, the
   * moving parts found, a step change, a re-read putting back what it kept): applied, never recorded,
   * and the redo stack is left alone, so an effect that runs again after an undo changes neither stack.
   */
  const update = useCallback(
    (fn: (d: EditorDoc) => EditorDoc, how: EditHow = {}) => {
      const cur = draftRef.current;
      if (!cur) return;
      const r = applyEdit(cur.doc, cur.history, fn, how, Date.now());
      if (r) {
        // the player changed something: what the restore said is no longer news (the editor's own edits are 'auto'),
        // and the document is now worth keeping as a draft (`EditorDoc.edited`)
        if (how !== 'auto') setRestoredNote(false);
        setDraft({ ...cur, doc: withEditMark(r.doc, how), history: r.history });
      }
    },
    [setDraft],
  );

  const ensureEngine = useCallback(async (): Promise<ImporterEngine> => {
    if (engRef.current) return engRef.current;
    const e = await loadImporterEngine();
    engineCache = e;
    engRef.current = e;
    setEng(e);
    return e;
  }, []);

  // ---- reading files ---------------------------------------------------------------------

  /** read dropped files into a prepared model and a fresh measurement. A new file starts the undo
   *  history empty; `keepHistory` (a new Detail, the same file read again) keeps it */
  const readModel = useCallback(
    async (
      files: File[],
      opts: ReadOpts & { spec?: RobotSpec; keepSource?: EditorDoc['source'] } = {},
    ) => {
      const my = ++gen.current;
      // one import at a time: a new drop stops the last one's workers
      importAbort.current?.abort();
      const abort = new AbortController();
      importAbort.current = abort;
      const name = files[0]?.name ?? '';
      setError(null);
      setActionError(null);
      setRestoredNote(false); // a file read over the draft replaces what was restored
      setPhase({ title: name, label: COPY.phase.engine });
      let e: ImporterEngine;
      try {
        e = await ensureEngine();
      } catch (err) {
        console.warn('[import] engine failed to load', err);
        if (my === gen.current) {
          setPhase(null);
          setError({ text: COPY.engineFailed, extra: { label: COPY.tryAgain, run: () => void readModel(files, opts) } });
        }
        return;
      }
      let stepStart = 0;
      // the model once it is read, and whether the step now running is its measurement: the catch below
      // lets the model (and the measure worker holding a copy of it) go, and says which of the two failed
      let held: PreparedModel | null = null;
      let measuring = false;
      try {
        // read, weld and simplify in the import worker; the main thread only paints the progress
        const budget = opts.setup?.triBudget ?? draftRef.current?.doc.setup.triBudget ?? defaultImportSetup().triBudget;
        const full = isFullDetail(budget);
        const prepared = await e.importModel(files, {
          budget,
          // a zip is a CAD import for its STEP (`fileSelection.ts`), whatever else is in it
          zipFormats: ['step'],
          signal: abort.signal,
          onProgress: (p) => {
            if (my !== gen.current) return;
            // a big STEP reads for minutes: once a quarter of it is read, say how long is left (any
            // earlier, the pieces still in flight make the guess run long: 4 min for a 70 s read)
            if (p.stage === 'step-parse' && !stepStart) stepStart = performance.now();
            const elapsed = stepStart ? (performance.now() - stepStart) / 1000 : 0;
            const left = p.stage === 'step-parse' && p.frac && p.frac >= 0.25 && p.frac < 1 && elapsed >= 10 ? (elapsed * (1 - p.frac)) / p.frac : null;
            setPhase({ title: name, label: left === null ? progressLabel(p, name, full) : COPY.phase.stepLeft(name, left), frac: p.frac });
          },
        });
        if (my !== gen.current) return;
        held = prepared;
        measuring = true;
        setPhase({ title: name, label: COPY.phase.measure });
        const cur = draftRef.current;
        const baseDoc = cur?.doc ?? freshDoc(settings, key, editId);
        // a new file is a new robot: everything about how it stands, where its wheels are and what
        // moves is found again (`readSetup`), unless the caller says otherwise. A saved robot's stored
        // mesh is made without its deleted parts, and its body ids are not the file's
        let setup = readSetup(baseDoc.setup, opts);
        // the first measurement in the measure worker; `normalise` then answers from its cache
        await e.prepareMeasure(prepared, setup);
        if (my !== gen.current) {
          e.releaseModel(prepared);
          return;
        }
        let n = e.normalise(prepared, setup);
        // a front found in the geometry turns the robot to it, once, as the file is read. A saved
        // robot's stored mesh knows its front, and a setup that names a yaw keeps it.
        const front = n.measurement.front;
        const findFront = !opts.savedModel && opts.setup?.yaw === undefined;
        if (findFront && front.detected && front.yaw !== setup.yaw) {
          setup = { ...setup, yaw: front.yaw };
          await e.prepareMeasure(prepared, setup);
          if (my !== gen.current) {
            e.releaseModel(prepared);
            return;
          }
          n = e.normalise(prepared, setup);
        }
        const model = prepared;
        const spec = opts.spec ?? baseDoc.spec;
        const doc: EditorDoc = {
          ...baseDoc,
          step: 0,
          setup,
          detected: {
            units: n.measurement.units,
            up: n.measurement.up,
            yaw: setup.yaw,
            front: findFront ? (front.detected ? 'detected' : 'assumed') : undefined,
            cue: findFront && front.detected ? front.cue : null,
          },
          mech: null,
          // a NEW import is named after its file; an edit keeps its name
          spec: { ...spec, name: opts.spec?.name ?? (baseDoc.editId ? spec.name : baseName(model.name)) },
          source: opts.keepSource ?? {
            name: model.name,
            format: model.format,
            bytes: model.bytes,
            trisIn: model.trisIn,
            trisOut: prepared.trisOut,
          },
          sourceName: model.name,
          savedModel: !!opts.savedModel,
          // a file the player read is a change to the document; a saved robot's stored mesh read back in is not
          edited: opts.savedModel ? baseDoc.edited : (true as const),
          // a new file's mechanisms are read from it again; a re-read of the same one keeps what was set
          cadBuild: readKeepsBuild(opts) ? baseDoc.cadBuild : undefined,
          notes: model.notes.length ? model.notes : undefined,
          updated: Date.now(),
        };
        const replaced = draftRef.current?.model;
        if (replaced && replaced !== prepared) e.releaseModel(replaced as PreparedModel);
        setActiveMotion(null);
        setPlaying(false);
        setDeleting(false);
        setSelected([]);
        sourceFiles.current = opts.savedModel ? null : files;
        held = null; // the draft owns it from here
        setDraft({ doc, model: prepared, modelStored: false, baked: null, history: opts.keepHistory ? draftRef.current?.history : undefined });
        setPhase(null);
      } catch (err) {
        // a model that was read but never became the draft's: its measure worker holds a copy of every
        // triangle, and nothing else will ever let it go (the engine keeps the last two models)
        if (held) e.releaseModel(held);
        if (my !== gen.current || (err instanceof Error && err.name === 'AbortError')) return;
        console.warn('[import] read failed', err);
        setPhase(null);
        // a measurement that threw is not the file's fault and exporting it again cannot change it (RI-03): it
        // gets a sentence of its own, with what can help (memory is the usual cause)
        const budget = opts.setup?.triBudget ?? draftRef.current?.doc.setup.triBudget ?? defaultImportSetup().triBudget;
        const msg = readFailureText(err, measuring, name, isFullDetail(budget));
        // the reader that did not load (a dropped connection) is worth another go; a file it could
        // not read is not, and its sentence already says what to export instead
        const retry = err instanceof Error && (err as { code?: string }).code === 'step-reader';
        setError({ text: msg, extra: retry ? { label: COPY.tryAgain, run: () => void readModel(files, opts) } : undefined });
      }
    },
    [ensureEngine, settings, key, editId, setDraft],
  );

  /** a `.glb` that carries a DSIM setup goes straight into the library */
  const addShared = useCallback(
    async (file: File, payload: SharePayload) => {
      const my = ++gen.current;
      // one import at a time: a share file added stops a read in flight, as a new drop does, and is
      // itself stoppable (Cancel, Back, a new drop): its import worker used to run on whatever the player did
      importAbort.current?.abort();
      const abort = new AbortController();
      importAbort.current = abort;
      setError(null);
      if (payload.game !== game) {
        setPhase(null); // the read it stopped has no more to say
        const season = seasonFor(game).name;
        setError({
          text: COPY.wrongGame(payload.name, season, seasonFor(payload.game).name),
          extra: {
            label: COPY.setUpFor(season),
            // the parts left out of the footprint are the stored mesh's own bodies, so they carry over
            run: () => void readModel([file], { setup: { units: 'm', up: '+y', yaw: 0, drive: payload.setup.drive, apart: payload.setup.apart }, savedModel: true }),
          },
        });
        return;
      }
      setPhase({ title: file.name, label: COPY.phase.adding(payload.name) });
      try {
        const e = await ensureEngine();
        const spec: RobotSpec = { ...coerceSpec(payload.spec, undefined, game), name: payload.name.slice(0, 24) };
        // a robot the checks refuse (`coerceImported`) is the FILE's problem, not a failure to prepare the model
        if (!spec.imported) throw fileProblem('share file without an import');
        // read in the import worker (a share file holds every triangle of a Full robot, tens of MB),
        // at a budget no file reaches: nothing simplified, nothing measured, only the pictures drawn
        const model = await e.importModel([file], { budget: Number.MAX_SAFE_INTEGER, signal: abort.signal });
        const robotParts = transformParts(model.parts, STORED_MESH_TO_ROBOT);
        const top = await e.renderTop(robotParts, spec.imported.hull);
        const thumb = await e.renderThumb(robotParts);
        if (my !== gen.current) return;
        const now = Date.now();
        // the file's own id names the robot only inside the file: this device's copy gets a fresh
        // one (see `LibraryRobot.sharedFrom`), and a copy already added from it is offered for
        // replacement under ITS id — UNLESS it is the account's active robot arriving on a second
        // device, which keeps the active id (`planShareAdd`, `libraryIds.ts` has the rule)
        const fileId = spec.imported.id;
        const record = (s: RobotSpec): LibraryRobot => ({
          id: s.imported!.id,
          game,
          spec: s,
          mesh: file,
          top,
          thumb,
          source: { name: file.name, format: 'glb', bytes: file.size, trisIn: model.trisIn, trisOut: model.trisIn },
          setup: { ...payload.setup, units: 'm', up: '+y', yaw: 0 },
          sharedFrom: fileId,
          created: now,
          updated: now,
        });
        const finish = async (s: RobotSpec, retire: string | null = null): Promise<void> => {
          setDialog(null);
          const r = await putRobot(record(s));
          setPhase(null);
          if (!r.ok) {
            setError({ text: r.message });
            return;
          }
          // an older copy of the same robot under another id is replaced, not kept beside it
          if (retire && retire !== s.imported!.id) {
            await deleteRobot(retire);
            invalidateImportedAssets(retire);
          }
          invalidateImportedAssets(s.imported!.id);
          libraryChanged();
          postRobotNotice(COPY.added(s.name));
          onSaved(s);
        };
        const withId = (id: string, name = spec.name): RobotSpec => ({ ...spec, name, imported: { ...spec.imported!, id } });
        const listed = await listRobots(game);
        const plan = planShareAdd(spec.imported, settings.spec.imported, listed.ok ? listed.value : [], (e) => e.spec.imported);
        if (plan.kind === 'adopt') {
          // the account's active robot, arriving on this device: the file brings its MODEL, and the
          // robot stays the account's spec as it is, id included — so the synced spec resolves here
          // AND on the device it came from, and nothing new syncs back
          await finish({ ...settings.spec }, plan.retire);
          return;
        }
        if (plan.kind === 'ask') {
          const have = plan.have;
          setDialog({
            kind: 'dup',
            name: spec.name,
            replace: () => void finish(withId(have.id)),
            keepBoth: () => void finish(withId(newRobotId(), `${spec.name.slice(0, 22)} 2`)),
          });
          return;
        }
        await finish(withId(newRobotId()));
      } catch (err) {
        // cancelled, left, or replaced by a newer read: whoever did it has said what to show
        if (my !== gen.current || (err instanceof Error && err.name === 'AbortError')) return;
        console.warn('[import] share file failed', err);
        setPhase(null);
        // an unreadable mesh or a refused robot is the file's: re-trying or reloading cannot change it
        const theFile = err instanceof Error && (err.name === 'ImportError' || err.name === 'ShareFileProblem');
        setError({ text: theFile ? COPY.shareUnreadable(file.name) : COPY.bakeFailed });
      }
    },
    [game, ensureEngine, readModel, onSaved],
  );

  /** may these files be imported (`fileSelection.ts`)? A zip's directory is read by the engine */
  const checkFiles = useCallback(
    (files: readonly File[]) => checkImportFiles(files, async (zip) => (await ensureEngine()).zipFileNames(zip)),
    [ensureEngine],
  );

  /** CAD imports are STEP, or a zip holding one. A GLB is accepted only when it is a valid DSIM share
   *  file. `budget` is the Detail the drop box chose (absent: the document's) */
  const onFiles = useCallback(
    async (files: File[], budget?: number) => {
      if (!files.length) return;
      const sel = await checkFiles(files);
      if (!sel.ok) {
        setError({ text: sel.text });
        return;
      }
      if (sel.kind === 'share') {
        try {
          // THE HEADER BEFORE THE FILE (IMPUI-08): a dropped .glb was read whole before anything about it was
          // checked, so a multi-gigabyte file named .glb filled this tab's memory. Its size, then its first
          // twelve bytes, say whether it can be one DSIM wrote; only then is it read.
          const file = files[0];
          if (file.size > SHARE_MAX_FILE_BYTES) {
            setError({ text: COPY.shareTooBig(file.name) });
            return;
          }
          const bad = shareHeaderRefusal(new Uint8Array(await file.slice(0, 12).arrayBuffer()), file.size);
          if (bad) {
            // no glTF magic is not a DSIM file at all; a length that is not the file's is a download to repeat
            setError({ text: bad.error === 'bad-length' ? bad.message : COPY.notStep(file.name) });
            return;
          }
          const res = readShareFile(await file.arrayBuffer());
          if (res.ok) return void addShared(files[0], res.payload);
          if (res.error === 'newer-version') {
            setError({ text: COPY.newer, extra: { label: COPY.setUpAgain, run: () => void readModel(files) } });
            return;
          }
          // a file that opens as a glb and then falls apart (cut off in the download, a chunk or the JSON
          // damaged) says so in its own sentence, whose next step is to download it again; "choose a STEP
          // file" would send the player away from the one thing that works
          if (res.error === 'bad-length' || res.error === 'bad-chunk' || res.error === 'bad-json') {
            setError({ text: res.message });
            return;
          }
          // a model DSIM did not write is not stored, and is not offered to the editor either:
          // the sentence says what was found. A setup it did not write (a missing drivetrain, a
          // damaged list) is refused the same way: the file IS a DSIM robot, so "not a STEP file"
          // would say the wrong thing
          if (res.error === 'bad-model' || res.error === 'bad-payload') {
            setError({ text: res.message });
            return;
          }
        } catch (err) {
          console.warn('[import] share check failed', err);
          setError({ text: COPY.notStep(files[0].name) });
          return;
        }
        setError({ text: COPY.notStep(files[0].name) });
        return;
      }
      void readModel(files, budget === undefined ? {} : { setup: { triBudget: budget } });
    },
    [addShared, readModel, checkFiles],
  );

  const startPendingFiles = useCallback(
    (budget: number): void => {
      const files = pendingFiles;
      if (!files) return;
      setPendingFiles(null);
      void onFiles(files, budget);
    },
    [pendingFiles, onFiles],
  );

  const stageHandedFiles = useCallback(
    async (files: File[]): Promise<void> => {
      const sel = await checkFiles(files);
      if (sel.ok) setPendingFiles(files);
      else setError({ text: sel.text });
    },
    [checkFiles],
  );

  /** the draft is not reaching this device (`draftStore.ts`): null while it is, else whether the device is full */
  const [draftFull, setDraftFull] = useState<boolean | null>(null);
  useEffect(() => onDraftSaveFailure((e) => setDraftFull(e === null ? null : e === 'quota')), []);

  // ---- boot: a handed file, the live draft, the stored draft, a library robot, or empty ----
  useEffect(() => {
    let dead = false;
    mountedEditors.set(key, (mountedEditors.get(key) ?? 0) + 1);
    // The handed files are TAKEN once (`takeHandedFiles` is one-shot) but the boot now awaits the stored
    // draft before it stages them, so a rehearsal remount (StrictMode, in development) would cancel the
    // first boot after it had taken them and start a second that finds none. They are kept here until a
    // boot that was not cancelled has finished.
    const handed = handedFiles.current ?? takeHandedFiles();
    handedFiles.current = handed;
    const boot = async (files: File[] | null): Promise<void> => {
      let d = liveDraft(key);
      // a draft read back from this device (a reload, a Resume after Back) opens on the Model step; one
      // still in memory (the way back from a test drive) is where the player left it. The Model step is
      // where a draft that cannot be measured has its way out.
      // ⚠️ FILES HANDED TO THE EDITOR GO OVER THE STORED DRAFT, NEVER IN ITS PLACE (MIMPUI-14). The robot
      // page's Resume card takes a drop, and the draft is read back first: it was skipped when files came
      // with the open, so a fresh document was kept over it, and the 800 ms write replaced the stored
      // draft (its model, its wheels, its moving parts) with an empty one before the player chose
      // anything. Restored, the files are only STAGED (`stageHandedFiles`): the Model step offers
      // Keep current model or starting the read, and nothing is replaced until it is picked.
      const fromDisk = !d && !files;
      // whether the document below was read back from this device, with files handed or not
      const restored = !d;
      if (!d) {
        setRestoring(true);
        d = await restoreDraft(key).catch(() => null);
        if (dead) return;
        setRestoring(false);
      }
      if (d) {
        // handed files are staged on the Model step, so that is where the document opens
        const staged = files || fromDisk ? { ...d, doc: { ...d.doc, step: 0 as StepIndex } } : d;
        // an EDIT's unsaved changes are not what the player last saw: the status line says they came back
        if (restored && staged.doc.editId) setRestoredNote(true);
        setDraft(staged);
        // an engine that will not load leaves a restored model with nothing to measure it, so it says so
        // (with Try again) instead of "Measuring…" for good
        if (staged.model) void ensureEngine().catch(() => setEngineDown(true));
        if (files) void stageHandedFiles(files);
        if (focusOnReturn) {
          pendingFocus.current = focusOnReturn;
          focusOnReturn = null;
        }
        return;
      }
      if (editId) {
        setRestoring(true);
        const got = await getRobot(editId);
        if (dead) return;
        setRestoring(false);
        if (!got.ok) {
          setNotFound(true);
          return;
        }
        const rec = got.value;
        const base = freshDoc(settings, key, editId);
        // a record added from a share file before the setup checks can hold any setup: opened as the editor
        // can read it (`coerceImportSetup`), where it threw, by field, in `buildSpec` and at the top of a render
        const recSetup = coerceImportSetup(rec.setup);
        setDraft({ doc: { ...base, id: rec.id, spec: { ...rec.spec }, created: rec.created, setup: recSetup }, model: null, modelStored: false, baked: null });
        const file = new File([rec.mesh], `${baseName(rec.source.name)}.glb`);
        await readModel([file], {
          setup: { ...recSetup, units: 'm', up: '+y', yaw: 0, wheels: recSetup.wheels },
          savedModel: true,
          spec: { ...rec.spec },
          keepSource: rec.source,
        });
        // the saved placements, back into the model frame
        const cur = draftRef.current;
        const imp = rec.spec.imported;
        if (cur?.model && imp?.mech && engRef.current) {
          const n = engRef.current.normalise(cur.model, cur.doc.setup);
          setDraft({ ...cur, doc: { ...cur.doc, mech: mechRobotToModel(imp.mech, n.measurement.origin), mechAt: [...n.measurement.sourceToModel] } });
        }
        return;
      }
      setDraft({ doc: freshDoc(settings, key, null), model: null, modelStored: false, baked: null });
      if (files) void stageHandedFiles(files);
    };
    void boot(handed).finally(() => {
      if (!dead) handedFiles.current = null;
    });
    return () => {
      dead = true;
      mountedEditors.set(key, Math.max(0, (mountedEditors.get(key) ?? 1) - 1));
      // a test drive comes straight back to this document: nothing stops, nothing is let go
      if (leavingForDrive.current) {
        void flushDraft(key);
        return;
      }
      // LEAVING STOPS WHAT IS RUNNING. A read in flight (up to six occt workers and several GB, for
      // minutes) otherwise ran on under the robot page or a match, and then wrote a draft nobody asked
      // for ("Resume import" appearing from nowhere); a share file's import worker likewise. Bumping
      // `gen` makes every awaiting step of a read return before it touches the draft.
      gen.current++;
      importAbort.current?.abort();
      const gone = draftRef.current;
      // Once the draft is on this device, the in-memory copy and the engine's copy of the model go: the
      // whole prepared model (every triangle at Full detail) otherwise stayed for the session after Back,
      // through any match played. A Resume reads it back. Not while the write is failing (the live copy is
      // the only one), and not when another editor has taken the key over meanwhile (StrictMode's
      // rehearsal remount, a Resume that beat the write).
      void flushDraft(key).then((onDevice) => {
        if (!onDevice || (mountedEditors.get(key) ?? 0) > 0) return;
        forgetLiveDraft(key);
        if (gone?.model) engRef.current?.releaseModel(gone.model);
        // the pictures lent to the renderers for a test drive: a robot that was never saved is not drawn
        if (gone) unregisterImportedAssets(gone.doc.id);
      });
    };
    // the boot runs once per draft key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // ---- derived -------------------------------------------------------------------------------
  const doc = draft?.doc ?? null;
  const model = draft?.model ?? null;
  // MEASURING, IN TWO HALVES (`measureSession.ts`). A units, up-axis or turn change needs a new
  // orientation, measured in the measure worker; until it lands the editor keeps showing the last
  // measurement of this model and holds anything that would act on it. Every other edit (a wheel,
  // the drivetrain, a mechanism) finds its orientation cached and costs the light half only.
  const okey = doc ? orientKey(doc.setup) : '';
  const ready = !!(eng && model && doc) && eng.measureReady(model as PreparedModel, doc.setup);
  const [, setMeasured] = useState(0);
  useEffect(() => {
    if (!eng || !model || !doc || ready) return;
    let live = true;
    // a new try starts clean: the orientation changed (an undo, another file's units), so a failure said
    // about the last one is not this one's
    setFailedFor(null);
    eng.prepareMeasure(model as PreparedModel, doc.setup).then(
      () => live && setMeasured((t) => t + 1),
      (err) => {
        console.warn('[import] measure failed', err);
        // said, not left as "Measuring…" for good (`measureBroke`)
        if (live) setFailedFor(model);
      },
    );
    return () => {
      live = false;
    };
    // once per orientation: a wheel or drivetrain edit has the same key and is never `ready: false`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eng, model, okey, ready]);
  const freshRes = useMemo((): { n: NormalisedModel | null; threw: boolean } => {
    if (!eng || !model || !doc || !ready) return { n: null, threw: false };
    try {
      return { n: eng.normalise(model as PreparedModel, doc.setup), threw: false };
    } catch (err) {
      console.warn('[import] normalise failed', err);
      return { n: null, threw: true };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eng, model, doc?.setup, ready]);
  const fresh: NormalisedModel | null = freshRes.n;
  const lastMeasured = useRef<{ model: unknown; n: NormalisedModel } | null>(null);
  if (fresh) lastMeasured.current = { model, n: fresh };
  const normalised = fresh ?? (lastMeasured.current?.model === model ? lastMeasured.current.n : null);
  /** a new orientation is being measured; what is shown is the last one */
  const measuring = !!model && !fresh;
  /** the measurement is not coming (the worker threw, `normalise` threw, or the player gave up waiting): the
   *  editor says so and offers the ways out, where "Measuring…" with a dead Cancel was all there was. Still
   *  `measuring` (nothing acts on a model that is not measured), and it clears itself if one lands */
  const measureBroke = measuring && (failedFor === model || freshRes.threw);
  const [measuringLong, setMeasuringLong] = useState(false);
  useEffect(() => {
    if (!measuring) return setMeasuringLong(false);
    const t = window.setTimeout(() => setMeasuringLong(true), MEASURING_NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [measuring]);
  const m = normalised?.measurement ?? null;
  // what Save, Test drive, Export and Review read: the placements already in this measurement's frame
  // and a single turret's launcher on its ring, the same rules the effects below write into the
  // document a render later, so nothing read in between sees them where they were
  const built = useMemo(() => {
    if (!doc || !m) return null;
    let d = followFrame(doc, m.sourceToModel);
    if (d.mech) d = turretOnRing(d, singleTurret(game, d.spec) ? measuredTurretRing(m) : null);
    return buildSpec(d, m);
  }, [doc, m, game]);
  const defs = useMemo(() => (built ? mechHandlesFor(game, built.spec) : []), [built, game]);
  const assumedFront = frontAssumed(doc);
  const readNotes = doc?.notes;
  const apartCount = doc?.setup.apart?.length ?? 0;
  const items = useMemo(
    () => reviewItems(m, built, game, assumedFront, readNotes ?? [], apartCount),
    [m, built, game, assumedFront, readNotes, apartCount],
  );
  const mechChecks = useMemo(() => (built ? validateMechFor(built.spec, game) : []), [built, game]);
  const numbers = useMemo(() => (built ? driveNumbers(built, game) : null), [built, game]);

  // arriving on Mechanisms with nothing picked, the launcher (else the first placement) is picked ONCE,
  // so the 3D view opens with a gizmo on something instead of an empty scene. Not again while the step
  // stays: Esc in the view clears the pick, and a pick that came straight back made Esc jump there.
  const hasMech = !!doc?.mech;
  const autoPicked = useRef(false);
  useEffect(() => {
    if (doc?.step !== 2) {
      autoPicked.current = false;
      return;
    }
    if (autoPicked.current || !hasMech || !defs.length) return;
    autoPicked.current = true;
    if (!selHandle) setSelHandle(firstHandle(defs));
  }, [doc?.step, hasMech, selHandle, defs]);

  // the placements follow the model frame (`followFrame`): a fold found among the moving parts moves
  // it. Declared before every effect that reads them, which wait for it (`sameFrame`)
  const frameNow = m?.sourceToModel;
  const mechAt = doc?.mechAt;
  useEffect(() => {
    if (!frameNow || measuring || sameFrame(mechAt, frameNow)) return;
    update((d) => followFrame(d, frameNow), 'auto');
  }, [frameNow, mechAt, measuring, update]);

  // placements default in once there is a footprint, and again when a mechanism appears
  // (never from a measurement of the orientation being replaced: the placements would land on it)
  useEffect(() => {
    if (!doc || !m || !built || m.hull.length < 3 || measuring || !sameFrame(doc.mechAt, m.sourceToModel)) return;
    // the game's defaults round what the player placed, else what the model showed (`cadMech`), a
    // default nobody moved placed again on the model as it is now (`withoutDefaults`); a single
    // turret's launcher on the ring the model turns it about (`turretOnRing`)
    const base = doc.mech ?? doc.cadMech ?? null;
    const have = base ? withoutDefaults(base, doc.mechAuto) : null;
    const next = defaultMechFor(game, built.spec, m.origin, have);
    const auto = defaultsIn(next, have);
    const ring = singleTurret(game, built.spec) ? measuredTurretRing(m) : null;
    const want = turretOnRing({ ...doc, mech: next }, ring);
    if (JSON.stringify(want.mech) !== JSON.stringify(doc.mech) || want.turretRing !== doc.turretRing || JSON.stringify(auto) !== JSON.stringify(doc.mechAuto)) {
      update((d) => (sameFrame(d.mechAt, m.sourceToModel) ? { ...d, mech: want.mech, turretRing: want.turretRing, mechAuto: auto } : d), 'auto');
    }
  }, [doc, m, built, game, update, measuring]);

  // focus after a "Fix", a step change, or a return from the test drive
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    const target = el.matches(FOCUSABLE) ? el : (el.querySelector<HTMLElement>(FOCUSABLE) ?? el);
    // a control that is still disabled (the checks not yet run) keeps the request for later
    if ((target as HTMLButtonElement).disabled) return;
    pendingFocus.current = null;
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
  });

  // ---- actions -------------------------------------------------------------------------------
  const step = doc?.step ?? 0;
  // the placements as 3D handles, made again only when they change: the preview compares `gizmo` by
  // identity, and a new object every render rebuilt every handle mesh on every render and drag frame
  const mechNow = doc?.mech ?? null;
  const hullNow = m?.hull;
  const gizmoState = useMemo(
    () =>
      step === 2 && mechNow && hullNow
        ? {
            handles: buildHandles(defs, mechNow, hullNow, mechChecks).handles.flatMap((h) =>
              h.shape === 'wheel' ? [] : [{ ...h, z: h.z ?? 0, shape: h.shape }],
            ),
            selected: selHandle,
          }
        : null,
    [step, mechNow, hullNow, defs, mechChecks, selHandle],
  );
  // A STEP REPLACES THE EDITOR'S CONTENT: the page goes to its top and focus to the step's title
  // (`pageScroll.ts`); a Fix's own focus target, set in the effect above, lands after it
  const bodyRef = useRef<HTMLElement>(null);
  usePageTop(doc ? step : null, bodyRef);
  const goStep = (s: StepIndex, focus?: string): void => {
    pendingFocus.current = focus ?? null;
    // what the last read said is about the Model step: it is put away as the player leaves it (an error that
    // arrives while they are on another step waits there until they come back, so it is not lost unseen)
    if (step === 0) setError(null);
    // moving between steps is not an edit: it is kept with the draft, never undone
    update((d) => ({ ...d, step: s }), 'auto');
  };
  const blocked = blocks(items) > 0;

  /** the setup as the stored mesh needs it: the hinged parts already folded (`motionAsStored`), and no
   *  deleted parts (the mesh is made without them, `savedSetup`) */
  const storedSetup = (s: ImportSetup): ImportSetup =>
    savedSetup(s.motion ? { ...s, motion: motionAsStored(s.motion, normalised?.measurement.motion) } : s);

  const finalSpec = (): RobotSpec | null => {
    if (!built || !doc) return null;
    const name = (doc.spec.name.trim() || baseName(doc.source?.name ?? 'Robot')).slice(0, 24);
    return { ...built.spec, name, teamName: (doc.spec.teamName ?? '').slice(0, 48) };
  };

  const ensureBaked = async (): Promise<NonNullable<LiveDraft['baked']> | null> => {
    const cur = draftRef.current;
    const e = engRef.current;
    if (!cur || !e || !normalised || measuring || !built?.spec.imported) return null;
    // practice tuning moves no triangle: a retune does not re-bake
    const stamp = JSON.stringify([{ ...cur.doc.setup, tune: undefined }, cur.doc.mech, { ...built.spec.imported, tune: undefined }]);
    if (cur.baked?.stamp === stamp) return cur.baked;
    const r = await e.bake({
      // every triangle at Full detail; what was measured otherwise
      modelParts: normalised.shownParts ?? normalised.modelParts,
      origin: normalised.measurement.origin,
      descriptor: built.spec.imported,
      motion: normalised.measurement.motion,
    });
    const baked = { stamp, mesh: r.mesh, top: r.top, thumb: r.thumb, trisOut: r.trisOut };
    cur.baked = baked;
    return baked;
  };

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      console.warn('[import] action failed', err);
      setActionError(COPY.bakeFailed);
    } finally {
      setBusy(false);
    }
  };

  const save = (): void => {
    // ask the browser to keep the library from THIS click (a user gesture, the moment the robot is worth
    // keeping; Firefox shows a prompt for it). Not waited for: the save never depends on the answer
    askPersistentStorage();
    saveNow();
  };
  const saveNow = (): void =>
    void run(async () => {
      const built = finalSpec();
      const b = await ensureBaked();
      const cur = draftRef.current;
      if (!built || !b || !cur?.doc.source) return;
      // ⚠️ AN EDIT NEVER RE-KEYS THE ACTIVE ROBOT: this device's pre-rule copy of it (saved under an
      // id of its own) saves under the ACTIVE id, and the old record goes (`editSaveId`)
      const listed = cur.doc.editId ? await listRobots(game) : null;
      const id = cur.doc.editId && listed?.ok ? editSaveId(cur.doc.editId, settings.spec.imported?.id, listed.value) : cur.doc.id;
      const spec: RobotSpec = id === cur.doc.id || !built.imported ? built : { ...built, imported: { ...built.imported, id } };
      const now = Date.now();
      const r = await putRobot({
        id,
        game,
        spec,
        mesh: b.mesh,
        top: b.top,
        thumb: b.thumb,
        source: { ...cur.doc.source, trisOut: b.trisOut },
        setup: storedSetup(cur.doc.setup),
        created: cur.doc.created ?? now,
        updated: now,
      });
      if (!r.ok) {
        setActionError(r.message);
        return;
      }
      if (id !== cur.doc.id) await deleteRobot(cur.doc.id);
      // the robot is saved: a read still running (a Replace or Detail started while this baked) lands on
      // nothing, rather than writing a draft for a robot that no longer has one
      gen.current++;
      importAbort.current?.abort();
      await dropDraft(key);
      if (cur.model) engRef.current?.releaseModel(cur.model);
      // the draft's lent pictures go, and the renderers read the library's copy from now on
      unregisterImportedAssets(cur.doc.id);
      invalidateImportedAssets(cur.doc.id);
      if (id !== cur.doc.id) invalidateImportedAssets(id);
      libraryChanged();
      postRobotNotice(COPY.saved(spec.name));
      onSaved(spec);
    });

  const testDrive = (): void =>
    void run(async () => {
      const spec = finalSpec();
      const b = await ensureBaked();
      if (!spec || !b) return;
      // lent to the renderers until the draft is saved or discarded (lane 6's asset seam)
      registerImportedAssets(spec.imported!.id, { top: b.top, mesh: b.mesh });
      void flushDraft(key);
      focusOnReturn = 'ri-testdrive';
      // the way back is this same document: leaving must stop nothing and let nothing go
      leavingForDrive.current = true;
      // the App can decline a drive (a match already in progress, a new version waiting) and leave this
      // editor mounted: the intent lapses, so a Back from here is an ordinary one
      window.setTimeout(() => {
        leavingForDrive.current = false;
      }, 10_000);
      onTestDrive(spec);
    });

  const exportIt = (): void =>
    void run(async () => {
      const spec = finalSpec();
      const b = await ensureBaked();
      const cur = draftRef.current;
      if (!spec || !b || !cur) return;
      const bytes = await shareBytes(b.mesh, { game, spec, setup: storedSetup(cur.doc.setup), name: spec.name });
      downloadBytes(bytes, shareFileName(spec.name));
    });

  const discard = async (): Promise<void> => {
    setDialog(null);
    gen.current++;
    importAbort.current?.abort();
    const id = draftRef.current?.doc.id;
    const dropped = draftRef.current?.model;
    await dropDraft(key);
    if (dropped) engRef.current?.releaseModel(dropped);
    if (id) unregisterImportedAssets(id);
    onBack();
  };

  // ---- wheels ----------------------------------------------------------------------------------
  const baseWheels = m ? (m.wheelsUsed ?? (m.hull.length >= 3 ? rectangleWheels(m.hull) : null)) : null;
  const shownWheels = wheelDrag ?? baseWheels;
  const layout: WheelLayout = doc && m ? wheelLayoutOf(doc.setup, m.wheels.wheels) : 'rect';
  // a placed wheel writes the layout it was placed in, so an unpicked layout never flips under it
  const commitWheels = (next: Vec2[], how: EditHow): void => update((d) => ({ ...d, setup: { ...d.setup, wheels: next, wheelLayout: layout } }), how);
  const onWheel = (i: number, p: Vec2, final: boolean): void => {
    // not while a new orientation is measured: the wheels shown are in the frame it replaces
    if (!m || !baseWheels || measuring) return;
    const next = moveWheel(baseWheels, i, p, layout);
    if (!final) return setWheelDrag(next);
    setWheelDrag(null);
    // a run of arrow-key presses on one wheel is one step
    commitWheels(next, { label: COPY.edits.move(lowerFirst(COPY.wheelNames[i] ?? COPY.wheels)), key: `wheel:${i}` });
  };
  const onRect = (key: RectNumber, v: number): void => {
    if (!m || !baseWheels || measuring) return;
    const label = key === 'wheelbase' ? COPY.edits.change(lowerFirst(COPY.wheelbase)) : key === 'track' ? COPY.edits.change(lowerFirst(COPY.track)) : COPY.edits.wheels;
    commitWheels(setRectNumber(baseWheels, key, v), { label, key: `rect:${key}` });
  };
  const onLayout = (next: WheelLayout): void => {
    if (!m || measuring || next === layout) return;
    update((d) => ({ ...d, setup: { ...d.setup, ...layoutPatch(d.setup, next) } }), { label: COPY.edits.layout });
  };

  // ---- detail: the triangle budget the file is read at -----------------------------------------
  // A new detail re-reads the files still in memory, keeping everything set so far: the bodies are
  // the file's own, so the moving parts still name the same ones, and the placements go back once
  // the new model is measured. Without the files (a reload, a saved robot) it applies next read.
  // NOT AN UNDO STEP: the re-read can take minutes and the model is not in the document, so the
  // history keeps the detail the model was read at and goes on across the change (`restoreDoc`).
  // A file not read yet takes its detail from the drop box (`ModelStep`'s own state, passed to the
  // read), never through here: this changes the detail of the model the document HAS.
  const onDetail = (budget: number): void => {
    if (!doc || doc.savedModel || budget === doc.setup.triBudget) return;
    const files = sourceFiles.current;
    update((d) => ({ ...d, setup: { ...d.setup, triBudget: budget } }), 'auto');
    if (!files) return;
    // ⚠️ the deleted parts are not carried over: a big STEP is read in pieces, and Light leaves its
    // small parts out, so a body id names another solid at the other detail. The floating parts are
    // offered again once it is read.
    const setup: ImportSetup = { ...doc.setup, triBudget: budget, removed: undefined, apart: undefined, keepFloating: undefined };
    const keepMech = doc.mech;
    const keepAt = doc.mechAt;
    // the same file read again: the front as it was found (detected or assumed, and any turn since)
    // carries over, or the re-read, which keeps the setup's yaw, would call an assumed front detected
    const keepFront = doc.detected ? { yaw: doc.detected.yaw, front: doc.detected.front, cue: doc.detected.cue } : null;
    void readModel(files, { setup, spec: doc.spec, keepHistory: true }).then(() => {
      update((d) => ({ ...d, ...(keepMech ? { mech: keepMech, mechAt: keepAt } : {}), detected: d.detected && keepFront ? { ...d.detected, ...keepFront } : d.detected }), 'auto');
    });
  };

  // ---- moving parts ----------------------------------------------------------------------------
  const motion = doc?.setup.motion;
  /** what the finders and a click read: EVERY triangle at Full detail (the mesh the match turns), not
   *  the simplified copy measured for the footprint, where a gearbox face can sit 7 mm off and a
   *  Gecko wheel's fins lose their tips (goBILDA's BIOBUZZ mecanum bot, 2026-10-04) */
  const detectParts = (): MeshPart[] => (normalised ? (normalised.shownParts ?? normalised.modelParts) : []);
  /** what the wheel search reads: where the wheels are and what they are */
  const wheelInputs = (): WheelInputs | null =>
    doc ? { wheels: baseWheels, drivetrain: doc.setup.drive.drivetrain, wheelDiaIn: wheelDiameterMm(doc.setup.drive.wheel) / 25.4 } : null;
  /**
   * EVERY KIND OF MOVING PART the model shows, among the bodies `have` does not hold (`findMoving`):
   * the search's inputs, with the build turned into the flags it reads
   */
  const motionSearch = (have: readonly MotionGroup[]): MotionSearch | null => {
    const w = wheelInputs();
    if (!normalised || !doc || !w) return null;
    const shooter = doc.mech?.shooter;
    return {
      kind: 'motion',
      ...w,
      have: [...have],
      intakes: doc.mech?.intakes ?? [],
      shooter: shooter && built ? [shooter.x, shooter.y, shooter.z] : null,
      turret: !!built && turretBuild(game, built.spec),
      rampIntake: game === 'biobuzz' && !!built && bbIntakeKindOf(built.spec) === 'ramp',
      elementD: launchElementD(game),
    };
  };
  /** the search in flight, by its inputs: an effect that runs again while it does starts no second */
  const searching = useRef<string | null>(null);
  const [finding, setFinding] = useState(false);
  /**
   * SEARCH THE MODEL IN THE MEASURE WORKER (`findMoving.ts`; seconds on a big robot, which froze this
   * thread, 2026-11-09). `then` gets the answer, or null when the search failed, with a guard that says
   * whether the document is still the one searched: the same model in the same orientation. An answer
   * a newer search replaced is dropped.
   */
  const search = (s: Search, then: (found: Found | null, current: (d: EditorDoc) => boolean) => void): void => {
    const e = engRef.current;
    if (!e || !model || !doc) return;
    const okey0 = orientKey(doc.setup);
    const key = `${okey0}|${JSON.stringify(s)}`;
    if (searching.current === key) return;
    searching.current = key;
    setFinding(true);
    const m0 = model;
    const current = (d: EditorDoc): boolean => draftRef.current?.model === m0 && orientKey(d.setup) === okey0;
    const done = (found: Found | null): void => {
      if (searching.current !== key) return;
      searching.current = null;
      setFinding(false);
      then(found, current);
    };
    e.findMoving(m0 as PreparedModel, doc.setup, s).then(done, (err) => {
      console.warn('[import] the moving-part search failed', err);
      done(null);
    });
  };
  // the moving parts are looked for once, on a setup that has never had any, once the placements are
  // in (rollers, flywheels and a turret are looked for by the intake spans and the launcher)
  useEffect(() => {
    if (!doc || !normalised || measuring || !baseWheels || !doc.mech) return;
    // the placements are in this measurement's frame first (`followFrame`)
    const frame = normalised.measurement.sourceToModel;
    if (!sameFrame(doc.mechAt, frame)) return;
    const w = wheelInputs();
    if (!w) return;
    // the model turned before the player changed the build: the build is read again in the new frame
    if (doc.cadReread) {
      search({ kind: 'build', ...w, elementD: launchElementD(game), axles: false }, (f, current) => {
        const cad = f?.kind === 'build' ? f.cad : null;
        update((d) => {
          if (!d.cadReread || !current(d)) return d;
          const r = cad ? buildFromCad(game, d.spec, cad) : null;
          return { ...d, cadReread: undefined, ...(r ? { cadBuild: r.set, spec: r.spec, mech: r.mech ?? null, cadMech: r.mech, cadKey: cadMechKey(r.spec), mechAt: [...frame] } : {}) };
        }, 'auto');
      });
      return;
    }
    // rows found by older finders, in a draft read from its CAD file: looked for again, edits kept
    const motion0 = doc.setup.motion;
    if (motion0 !== undefined) {
      if (doc.savedModel || (doc.setup.motionFinder ?? 0) >= MOTION_FINDER || !motion0.some((g) => g.found)) return;
      const kept = keepEditedMotion(motion0);
      const s = motionSearch(kept);
      if (!s) return;
      search(s, (f, current) => {
        // a search that failed keeps the rows as they were, and is not tried again
        const again = f?.kind === 'motion' ? [...kept, ...f.motion] : motion0;
        update((d) => (d.setup.motion === motion0 && current(d) ? { ...d, setup: { ...d.setup, motion: again, motionFinder: MOTION_FINDER } } : d), 'auto');
      });
      return;
    }
    // a NEW import's mechanisms are read from its model first (`buildFromCad`): the placements then
    // default in for that build, and this runs again to find the moving parts from them
    if (doc.cadBuild === undefined && !doc.editId && !doc.savedModel) {
      // a front the geometry left ASSUMED turns to a clear intake (`frontFromBuild`), once; after a
      // turn the build is read again in the new frame
      const assumed = frontAssumed(doc);
      search({ kind: 'build', ...w, elementD: launchElementD(game), axles: assumed && m?.wheelSource === 'detected' }, (f, current) => {
        const d0 = draftRef.current?.doc;
        if (!d0 || d0.cadBuild !== undefined || !current(d0)) return;
        const cad = f?.kind === 'build' ? f.cad : null;
        if (f?.kind === 'build' && assumed) {
          const turn = frontFromBuild(f.cad, f.axles);
          if (turn !== null) {
            const yaw = ((d0.setup.yaw + turn) % 4) as QuarterTurns;
            update(
              (d) => ({
                ...d,
                setup: turn ? { ...d.setup, yaw, wheels: null } : d.setup,
                detected: d.detected ? { ...d.detected, yaw, front: 'detected', cue: 'intake' } : d.detected,
              }),
              'auto',
            );
            if (turn) return;
          }
        }
        // a search that failed reads no build: the placements default in for the one picked
        update((d) => {
          if (d.cadBuild !== undefined) return d;
          const r = cad ? buildFromCad(game, d.spec, cad) : null;
          return { ...d, cadBuild: r?.set ?? [], ...(r ? { spec: r.spec, mech: r.mech ?? null, cadMech: r.mech, cadKey: cadMechKey(r.spec), mechAt: [...frame] } : {}) };
        }, 'auto');
      });
      return;
    }
    // the placements default in first (the effect above, a render later): the build just read placed
    // only the launcher, and the rollers and a deployed ramp are looked for on the intake spans. Found
    // in the same render, a new import's intake rollers and ramp were never looked for (2026-10-04)
    if (!built || !m || JSON.stringify(defaultMechFor(game, built.spec, m.origin, doc.mech ?? doc.cadMech ?? null)) !== JSON.stringify(doc.mech)) return;
    const s = motionSearch([]);
    if (!s) return;
    search(s, (f, current) => {
      // a search that failed finds nothing: the player can add the rows, or Find moving parts again
      const found = f?.kind === 'motion' ? f.motion : [];
      update((d) => (d.setup.motion === undefined && current(d) ? { ...d, setup: { ...d.setup, motion: found, motionFinder: MOTION_FINDER } } : d), 'auto');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.setup.motion, doc?.setup.motionFinder, normalised, measuring, baseWheels, doc?.mech, doc?.cadBuild, doc?.cadReread]);
  /** a moving parts edit, named by the row it added, removed or changed */
  const setMotion = (next: MotionGroup[]): void => {
    const prev = motion ?? [];
    update((d) => ({ ...d, setup: { ...d.setup, motion: next } }), motionEdit(prev, next, motionNames(prev)));
  };
  /** Find moving parts: every row the player has not touched goes, and is looked for again. The rows
   *  land when the search ends, unless the player changed them meanwhile */
  const refindMotion = (): void => {
    const motion0 = motion;
    const kept = keepEditedMotion(motion0 ?? []);
    const s = motionSearch(kept);
    if (!s) return;
    setActiveMotion(null);
    setHoverMotion(null);
    search(s, (f, current) => {
      if (f?.kind !== 'motion') return;
      update((d) => (d.setup.motion === motion0 && current(d) ? { ...d, setup: { ...d.setup, motion: [...kept, ...f.motion], motionFinder: MOTION_FINDER } } : d), { label: COPY.edits.findMoving });
    });
  };
  // a selected row is being edited: a click in the preview adds or takes out its parts
  const picking = step === MOVING_STEP && activeMotion !== null && !!motion?.[activeMotion];
  // a click in the preview: the part under it (and, for something that spins, its axle; for the rest,
  // what is mounted on it) joins the group being picked, or leaves it when it is already in it.
  // A body belongs to one moving part at a time.
  const onPickBody = (body: number, shift: boolean): void => {
    if (deletePicking) return onSelectBody(body, shift);
    if (!picking || !normalised || !motion || activeMotion === null) return;
    const g = motion[activeMotion];
    if (pickTarget === 'axis') {
      // naming a joint's axle (or a slide's rail): one click, and the picking ends
      setMotion(motion.map((o, i) => (i === activeMotion ? { ...o, axis: 'part' as const, axisBody: body, found: undefined } : o)));
      setActiveMotion(null);
      return;
    }
    const parts = detectParts();
    const take = shift ? [body] : isSpin(g.role) ? coaxialBodies(parts, body, g.role) : mountedBodies(parts, body);
    const leaving = g.bodies.includes(body);
    const set = new Set(take);
    const next = motion.map((o, i) => {
      if (i === activeMotion) {
        const bodies = leaving ? o.bodies.filter((b) => !set.has(b)) : [...new Set([...o.bodies, ...take])].sort((a, b) => a - b);
        return { ...o, bodies, found: undefined };
      }
      return leaving ? o : { ...o, bodies: o.bodies.filter((b) => !set.has(b)) };
    });
    setMotion(next);
  };
  // ---- deleting parts --------------------------------------------------------------------------
  // The Model step's Delete parts mode: a click in the preview selects a body (Shift adds), and Delete
  // takes the selection out of everything (`withoutBodies`). What floats apart from the robot
  // (`findFloatingParts`, in the measurement) is offered for deleting; nothing goes unless the player
  // says so. A deletion, Restore all and Keep are one undo step each.
  const removed = doc?.setup.removed;
  const deletePicking = step === 0 && deleting && !!m;
  const keptFloating = doc?.setup.keepFloating;
  // keyed on the orientation's own array, not the measurement: a wheel or drivetrain edit makes a new
  // measurement, and a new list here would rebuild the preview's tint
  const floatFound = m?.floating;
  const floating = useMemo(
    () => (floatFound && !measuring ? floatingOffer({ floating: floatFound }, { keepFloating: keptFloating }) : []),
    [floatFound, keptFloating, measuring],
  );
  const floatingBodies = useMemo(() => floating.flatMap((g) => g.bodies), [floating]);
  /** delete `bodies`; the frame question is asked of the measured copy in the model frame */
  const apart = doc?.setup.apart;
  const deleteParts = (bodies: readonly number[]): void => {
    if (!normalised || !bodies.length) return;
    // the frame is the drive base's box, so a part already left out of the footprint moves nothing
    const moves = removalMovesFrame(normalised.modelParts, apart ?? [], [...(apart ?? []), ...bodies]);
    setSelected([]);
    update((d) => deleteBodies(d, bodies, moves), { label: COPY.edits.deleteParts(bodies.length) });
  };
  const restoreParts = (): void => {
    const all = model ? (model as PreparedModel).parts : null;
    if (!removed?.length || !all) return;
    const moves = removalMovesFrame(all, [...removed, ...(apart ?? [])], apart ?? []);
    update((d) => restoreBodies(d, moves), { label: COPY.edits.restoreParts });
  };
  /** leave the selection out of the footprint: drawn and stored, but the drive base is measured without it */
  const leaveOutParts = (bodies: readonly number[]): void => {
    if (!normalised || !bodies.length) return;
    const moves = removalMovesFrame(normalised.modelParts, apart ?? [], [...(apart ?? []), ...bodies]);
    setSelected([]);
    update((d) => leaveOutBodies(d, bodies, moves), { label: COPY.edits.leaveOut(bodies.length) });
  };
  const includeAllParts = (): void => {
    if (!apart?.length || !normalised) return;
    const moves = removalMovesFrame(normalised.modelParts, apart, []);
    update((d) => includeAllBodies(d, moves), { label: COPY.edits.includeAll });
  };
  const keepFloating = (): void =>
    update(
      (d) => ({ ...d, setup: { ...d.setup, keepFloating: [...new Set([...(d.setup.keepFloating ?? []), ...floatingBodies])].sort((a, b) => a - b) } }),
      { label: COPY.edits.keepFloating },
    );
  // the mode belongs to the Model step: leaving it ends the mode and drops the selection
  useEffect(() => {
    if (step === 0) return;
    setDeleting(false);
    setSelected([]);
  }, [step]);
  // the Delete (or Backspace) key deletes the selection, unless a field has the keys
  const deleteRef = useRef<() => void>(() => {});
  deleteRef.current = () => deleteParts(selected);
  useEffect(() => {
    if (!deletePicking) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      deleteRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deletePicking]);
  /** a click in the preview while deleting: that body alone is the selection, or Shift adds or takes it out */
  const onSelectBody = (body: number, shift: boolean): void =>
    setSelected((cur) => (shift ? (cur.includes(body) ? cur.filter((b) => b !== body) : [...cur, body]) : cur.length === 1 && cur[0] === body ? [] : [body]));

  const highlight = useMemo(() => {
    if (step === 0) {
      // the selection while deleting, else what floats apart from the robot while it is offered
      // (orange: what is left out of the footprint, which stays in view on this step)
      const active = deleting ? selected : floatingBodies;
      const others = apart ?? [];
      return active.length || others.length ? { active, others } : null;
    }
    if (step !== MOVING_STEP || !motion) return null;
    // the selected row, or else the one under the pointer
    const shown = activeMotion ?? (hoverMotion !== null && hoverMotion < motion.length ? hoverMotion : null);
    const active = shown !== null ? (motion[shown]?.bodies ?? []) : [];
    const others = motion.flatMap((g, i) => (i === shown ? [] : g.bodies));
    return active.length || others.length ? { active, others } : null;
  }, [step, motion, activeMotion, hoverMotion, deleting, selected, floatingBodies, apart]);

  // ---- undo and redo (`editorHistory.ts`) -------------------------------------------------------
  // The step the player is on stays: moving between steps is not an edit, and an undo that also
  // jumped to another step would move them somewhere they did not ask to go. The preview shows the
  // model on every step, and the button's title names what is taken back.
  /** not while a file is read (what it reads replaces the document) or the model is baked */
  const historyFrozen = !!phase || busy;
  const stepHistory = (dir: 'undo' | 'redo', fromButton = false): void => {
    const cur = draftRef.current;
    if (!cur || historyFrozen || dialog) return;
    const r = (dir === 'undo' ? undoDoc : redoDoc)(cur.doc, cur.history, Date.now());
    if (!r) return;
    setWheelDrag(null);
    // a row being picked that the step took away
    if (activeMotion !== null && !r.doc.setup.motion?.[activeMotion]) setActiveMotion(null);
    // the last step either way disables the button pressed, so focus goes to the other one
    if (fromButton && !(dir === 'undo' ? nextUndo(r.history) : nextRedo(r.history))) pendingFocus.current = dir === 'undo' ? 'ri-redo' : 'ri-undo';
    setDraft({ ...cur, doc: r.doc, history: r.history });
  };
  const historyKeys = useRef(stepHistory);
  historyKeys.current = stepHistory;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const dir = historyShortcut(e);
      // a text or number field, a select or an editable region keeps its own undo
      if (!dir || ownsUndo(e.target as HTMLElement | null)) return;
      e.preventDefault();
      historyKeys.current(dir);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- render ----------------------------------------------------------------------------------
  if (notFound) {
    return (
      <>
        <div className="ds-head">
          <button type="button" className="ds-back" onClick={onBack}>
            {COPY.back}
          </button>
        </div>
        <div className="ds-empty">
          <p className="big">{COPY.notFoundBig}</p>
          <p>{COPY.notFoundText}</p>
          <button type="button" className="ds-btn" onClick={onBack}>
            {COPY.backToRobot}
          </button>
        </div>
      </>
    );
  }
  if (!doc) return <div className="ds-loading">{restoring ? COPY.restoring : COPY.loading}</div>;

  const hasModel = !!m;
  const draftNote = hasModel && draftFull !== null ? COPY.draftNotSaved(draftFull) : null;
  // an edit's unsaved changes that came back from this device: said in the status line until the next edit.
  // Not on Review, whose line is the count of what is left to fix (it is the sum of the rest). Only for a
  // draft with changes in it (`EditorDoc.edited`): one that was merely opened is the saved robot (RI-02)
  const restoredLine = hasModel && restoredNote && doc.edited ? COPY.draftRestored : null;
  const stepCounts = [0, 0, 0, 0];
  const stepBlocks = [0, 0, 0, 0];
  for (const it of items) {
    if (it.level === 'block' || it.level === 'warn') stepCounts[stepOf(it)]++;
    if (it.level === 'block') stepBlocks[stepOf(it)]++;
  }
  const title = doc.editId ? COPY.titleEdit(doc.spec.name || 'robot') : COPY.titleNew;
  const toUndo = nextUndo(draft?.history);
  const toRedo = nextRedo(draft?.history);
  // WHAT THE MODEL STEP SAYS ABOUT A MODEL THAT CANNOT BE USED, besides what the last read said: the engine
  // would not load for a restored draft, or the measurement is not coming. Both end "Measuring…" (which had a
  // Cancel that did nothing and no way out but waiting) and leave the ways out on the screen
  // (the engine counts as down only while it is not loaded: a read started meanwhile may have loaded it)
  const engineMissing = engineDown && !eng;
  const shownError: DropError | null =
    error ??
    (engineMissing
      ? { text: COPY.engineFailed, extra: { label: COPY.tryAgain, run: () => { setEngineDown(false); ensureEngine().catch(() => setEngineDown(true)); } } }
      : measureBroke
        ? { text: COPY.measureFailed(hasModel && !!toUndo) }
        : null);
  const measuringPhase: Phase | null =
    model && !normalised && !engineMissing && !measureBroke ? { title: doc.source?.name ?? doc.sourceName ?? '', label: COPY.phase.measure } : null;
  // each step draws what it is about: the wheels and the contacts on the Model step, the placements
  // on Mechanisms, the moving parts on theirs, and all of it on Review
  const previewState = m && normalised
    ? {
        parts: normalised.modelParts,
        shown: normalised.shownParts ?? null,
        hull: m.hull,
        wheels: step === 0 || step === 1 || step === REVIEW_STEP ? shownWheels : null,
        contacts: step === 0 ? m.wheels.contacts : null,
        origin: step === 0 ? m.origin : null,
        // the Mechanisms step draws its placements as handles to drag (`gizmo`), Review as plain marks
        mech: step === REVIEW_STEP ? doc.mech : null,
        gizmo: gizmoState,
        size: m.size,
        showCube: true,
        motion: m.motion ?? null,
        playing: playing && step === MOVING_STEP && !picking,
        highlight: playing ? null : highlight,
        picking: picking || deletePicking,
      }
    : null;
  /** a placement handle dragged in the 3D view: one undo step per handle, the way the map's drag is */
  const gizmo = {
    select: setSelHandle,
    move: (key: string, p: { x: number; y: number; z: number }): void => {
      if (!m) return;
      const aim = key.endsWith(AIM);
      const base = aim ? key.slice(0, -AIM.length) : splitKey(key)[0];
      const name = lowerFirst(defs.find((d) => d.key === base)?.label ?? '');
      update(
        (d) => {
          const next = d.mech ? moveHandle(d.mech, defs, m.hull, key, p, m.heightIn) : null;
          return next ? { ...d, mech: next } : d;
        },
        aim ? { label: COPY.edits.aim(name), key: `mech:${base}:aim` } : { label: COPY.edits.move(name), key: `mech:${base}` },
      );
    },
  };
  const legend = !m
    ? null
    : step === 0
      ? deleting
        ? COPY.legend.deleting
        : floating.length
          ? COPY.legend.floating
          : apart?.length
            ? `${COPY.legend.model} ${COPY.legend.apart}`
            : COPY.legend.model
      : step === 1
        ? COPY.legend.drive
        : step === 2
          ? defs.length && doc.mech
            ? COPY.legend.mechEdit
            : COPY.legend.mech({ intake: !!doc.mech?.intakes?.length, shooter: !!doc.mech?.shooter, place: !!doc.mech?.place })
          : step === MOVING_STEP
            ? motion?.length
              ? COPY.legend.moving
              : null
            : null;

  const mechPanel =
    built && m && doc.mech ? (
      <MechanismsStep
        game={game}
        spec={built.spec}
        onSpec={(patch) => update((d) => ({ ...d, spec: { ...d.spec, ...patch } }), { label: COPY.edits.mechanisms, key: `spec:${Object.keys(patch).sort().join()}` })}
        hull={m.hull}
        heightIn={m.heightIn}
        mech={doc.mech}
        home={defaultMechFor(game, built.spec, m.origin, doc.cadMech ?? null)}
        defs={defs}
        checks={mechChecks}
        selected={selHandle}
        onSelect={setSelHandle}
        // a handle dragged, stepped by keys or by its slider is one step per handle
        onMech={(next: ImportedMech) => update((d) => ({ ...d, mech: next }), mechEdit(doc.mech, next, defs))}
        onReset={() => update((d) => ({ ...d, mech: null }), { label: COPY.edits.resetPlacement })}
        cadNote={doc.cadBuild?.length ? COPY.cadBuild(doc.cadBuild) : undefined}
        tuning={
          <TunePanel
            id="ri-tune-mech"
            title={COPY.tuneMech}
            fields={mechTuneFields(game, built.spec)}
            tune={doc.setup.tune}
            onTune={(tune) => update((d) => ({ ...d, setup: { ...d.setup, tune } }), { label: COPY.edits.change(lowerFirst(COPY.tuneMech)) })}
          />
        }
      />
    ) : null;

  const movingPanel =
    built && m ? (
      <MotionPanel
        rampOk={game === 'biobuzz' && bbIntakeKindOf(built.spec) === 'ramp'}
        groups={motion ?? []}
        parts={m.motion ?? []}
        active={picking ? activeMotion : null}
        target={pickTarget}
        playing={playing}
        onHover={setHoverMotion}
        onActive={(i, target = 'bodies') => {
          setActiveMotion(i);
          setPickTarget(target);
          if (i !== null) setPlaying(false);
        }}
        onChange={setMotion}
        onRefind={refindMotion}
        finding={finding}
        onPlay={(on) => {
          setPlaying(on);
          if (on) setActiveMotion(null);
        }}
      />
    ) : null;

  // a file being read holds Save, Export and Test drive: they would store or drive the model it is replacing
  const why = phase ? COPY.waitRead : blocked ? COPY.fixFirst : undefined;
  // a read goes on while the player is on another step (the rail stays live): its bar is on the Model step,
  // so the title of the step they are on says one is running, and Save says why it waits
  const readingNote = phase && step !== 0 ? COPY.phase.read(phase.title) : null;
  // what the editor reads by itself has landed: a new file's build, then its moving parts (each an
  // effect a render after the last), so a save from the header never stores a robot half-read
  const autoDone = !!doc && (doc.savedModel || !!doc.editId || (doc.cadBuild !== undefined && doc.setup.motion !== undefined));
  return (
    <>
      <div className="ds-head">
        <button
          type="button"
          className="ds-back"
          onClick={() => {
            void flushDraft(key);
            onBack();
          }}
        >
          {COPY.back}
        </button>
        <span className="ds-head-spacer" />
        {/* Discard is there whenever a model is in the draft, measured or not: a restored draft that never
            measures (`measureBroke`) has no other way to be put away */}
        {hasModel || model ? (
          <div className="ds-actions ds-import-headacts">
            {hasModel ? (
              <>
            <button
              type="button"
              id="ri-undo"
              className="ds-btn ghost small"
              disabled={!toUndo || historyFrozen}
              title={COPY.withKeys(COPY.undoAria(toUndo?.label ?? null), COPY.undoKeys(MAC))}
              aria-label={COPY.undoAria(toUndo?.label ?? null)}
              aria-keyshortcuts="Control+Z Meta+Z"
              onClick={() => stepHistory('undo', true)}
            >
              {COPY.undo}
            </button>
            <button
              type="button"
              id="ri-redo"
              className="ds-btn ghost small"
              disabled={!toRedo || historyFrozen}
              title={COPY.withKeys(COPY.redoAria(toRedo?.label ?? null), COPY.redoKeys(MAC))}
              aria-label={COPY.redoAria(toRedo?.label ?? null)}
              aria-keyshortcuts="Control+Shift+Z Control+Y Meta+Shift+Z"
              onClick={() => stepHistory('redo', true)}
            >
              {COPY.redo}
            </button>
              </>
            ) : null}
            <button type="button" className="ds-btn ghost small" onClick={() => setDialog({ kind: 'discard' })}>
              {doc.editId ? COPY.discardEdit : COPY.discardNew}
            </button>
          </div>
        ) : null}
        {/* SAVE FROM ANY STEP (2026-11-06, "as streamlined as possible"): a model the importer read right
            needs no step walked through. Review keeps its own, with Test drive and Export. Not
            `primary`: the step's own action (Next) stays the pad's Y, which presses the first
            `.ds-btn.primary` on the page (`PadNavLayer`). Its own item, so a phone puts it beside Back
            instead of alone on a line under the group (`.ds-import-headsave`) */}
        {hasModel && step < REVIEW_STEP ? (
          <button
            type="button"
            id="ri-save-head"
            className="ds-btn small ds-import-headsave"
            disabled={blocked || busy || measuring || !autoDone || !!phase}
            title={why}
            onClick={save}
          >
            {doc.editId ? COPY.saveEdit : COPY.saveNew}
          </button>
        ) : null}
      </div>
      <h1 className="ds-h1">{title}</h1>

      <div className="ds-import">
        <div className="ds-import-in">
        <nav className="ds-tabs ds-import-steps" aria-label={COPY.stepsAria} data-padnav-sections>
          {COPY.steps.map((label, i) => (
            <button
              key={label}
              type="button"
              className={`ds-tab${step === i ? ' on' : ''}`}
              aria-current={step === i ? 'step' : undefined}
              disabled={i > 0 && !hasModel}
              onClick={() => goStep(i as StepIndex)}
            >
              <span className="n">{i + 1}</span> {label}
              {/* a badge only for what needs looking at: a tick on every step said nothing, and five
                  tabs with one each did not fit a row. Review carries none: it is the sum of the rest */}
              {hasModel && i < REVIEW_STEP && stepCounts[i] ? (
                <span className={`ds-badge ${stepBlocks[i] ? 'danger' : 'warn'}`}>
                  {stepCounts[i]}
                  <span className="ds-sr"> {COPY.stepOpen(stepCounts[i])}</span>
                </span>
              ) : null}
            </button>
          ))}
        </nav>

        <PreviewPane
          eng={eng}
          state={previewState}
          legend={legend}
          onPickBody={onPickBody}
          gizmo={gizmo}
          empty={<p className="ds-hint ds-import-preview-empty">{COPY.previewEmpty}</p>}
          fallback={
            m ? (
              <TopDownMap
                hull={m.hull}
                handles={[]}
                contacts={m.wheels.contacts}
                origin={m.origin}
                selected={null}
                ariaLabel={COPY.footprintAria}
                readOnly
              />
            ) : null
          }
        />

        <div className="ds-import-dock">
        <section ref={bodyRef} className="ds-panel ds-import-body">
          <div className="ds-panel-h">
            {step === REVIEW_STEP && hasModel ? (
              <h2 className={`ds-panel-title notice${blocked ? ' error' : ''}`} role="status">
                {actionError ?? draftNote ?? (busy ? COPY.working : readingNote ?? (measuring ? COPY.phase.measure : reviewSummary(items)))}
              </h2>
            ) : (
              // a measurement past `MEASURING_NOTICE_MS` takes the title's place, as a status does on
              // the Controls screen: the slot keeps its line, so nothing below it moves. So does a
              // draft that is not being kept (`draftNote`), which a reload would lose
              <h2
                className={`ds-panel-title${measuringLong || draftNote || restoredLine || readingNote ? ' notice' : ''}`}
                role={measuringLong || draftNote || restoredLine || readingNote ? 'status' : undefined}
              >
                {actionError ?? draftNote ?? restoredLine ?? (readingNote ?? (measuringLong ? COPY.phase.measure : COPY.steps[step]))}
              </h2>
            )}
          </div>
          <div className="ds-panel-body stack">
            {step === 0 || !hasModel ? (
              <ModelStep
                doc={doc}
                m={m}
                // a restored draft's model is measured before the step can show it
                phase={phase ?? measuringPhase}
                error={shownError}
                onDismissError={
                  error
                    ? () => {
                        setError(null);
                        // the banner held focus: it goes to the step's first control, not to the page
                        pendingFocus.current = 'ri-front';
                      }
                    : undefined
                }
                wheels={shownWheels}
                selectedWheel={selWheel}
                layout={layout}
                onFiles={(f, budget) => {
                  setPendingFiles(null);
                  void onFiles(f, budget);
                }}
                pendingFiles={pendingFiles}
                onStartPending={startPendingFiles}
                onKeepPending={() => setPendingFiles(null)}
                checkFiles={async (f) => {
                  const sel = await checkFiles(f);
                  return sel.ok ? null : sel.text;
                }}
                onCancel={() => {
                  gen.current++;
                  // terminates the import's workers: the CPU stops with the bar
                  importAbort.current?.abort();
                  setPhase(null);
                  // "Measuring…" with no read behind it is the measure worker, which cannot be stopped: the
                  // player is let out of the wait instead (the ways out show; a measurement that does land
                  // takes the editor back by itself)
                  if (!phase && model && !normalised) setFailedFor(model);
                }}
                onSetup={(patch) =>
                  update((d) => {
                    // units, up and yaw move the model frame, and the placements with it; the build read
                    // from the model is read again in the new frame while the player has not changed it
                    if (!('units' in patch || 'up' in patch || 'yaw' in patch)) return { ...d, setup: { ...d.setup, ...patch } };
                    return { ...d, setup: { ...d.setup, ...patch }, ...frameMoved(d) };
                  }, setupEdit(patch))
                }
                onWheel={onWheel}
                onRect={onRect}
                onSelectWheel={setSelWheel}
                onLayout={onLayout}
                onDetail={onDetail}
                canReread={!!sourceFiles.current}
                parts={{
                  deleted: removed?.length ?? 0,
                  apart: apart?.length ?? 0,
                  selected: selected.length,
                  deleting,
                  floating: floating.length
                    ? { count: floatingBodies.length, near: floating[0].gapIn, far: floating[floating.length - 1].gapIn }
                    : null,
                  onDeleting: (on) => {
                    setDeleting(on);
                    setSelected([]);
                  },
                  onDelete: () => deleteParts(selected),
                  onLeaveOut: () => leaveOutParts(selected),
                  onIncludeAll: includeAllParts,
                  onRestore: restoreParts,
                  onDeleteFloating: () => deleteParts(floatingBodies),
                  onKeepFloating: keepFloating,
                }}
              />
            ) : step === 1 ? (
              <DrivetrainStep
                drive={doc.setup.drive}
                numbers={numbers}
                onDrive={(patch) => update((d) => ({ ...d, setup: { ...d.setup, drive: { ...d.setup.drive, ...patch } } }), driveEdit(patch))}
                tuning={
                  built ? (
                    <TunePanel
                      id="ri-tune-drive"
                      title={COPY.tuneDrive}
                      fields={driveTuneFields(built.spec)}
                      tune={doc.setup.tune}
                      onTune={(tune) => update((d) => ({ ...d, setup: { ...d.setup, tune } }), { label: COPY.edits.change(lowerFirst(COPY.tuneDrive)) })}
                    />
                  ) : null
                }
              />
            ) : step === 2 ? (
              mechPanel
            ) : step === MOVING_STEP ? (
              movingPanel
            ) : (
              <ReviewStep
                items={items}
                spec={doc.spec}
                // typing is one step per field until it pauses
                onIdentity={(patch) =>
                  update((d) => ({ ...d, spec: { ...d.spec, ...patch } }), {
                    label: 'name' in patch ? COPY.edits.rename : 'teamName' in patch ? COPY.edits.change(lowerFirst(COPY.teamName)) : COPY.edits.teamNumber,
                    key: `id:${Object.keys(patch).join()}`,
                  })
                }
                onFix={(it: ReviewItem) => it.fix && goStep(it.fix.step, it.fix.focus)}
              />
            )}
          </div>
        </section>

        <div className="ds-actions ds-import-foot">
          {step > 0 ? (
            <button type="button" className="ds-btn ghost" data-padnav-secondary onClick={() => goStep((step - 1) as StepIndex)}>
              {COPY.prev}
            </button>
          ) : null}
          <span className="ds-head-spacer" />
          {step < REVIEW_STEP ? (
            <button
              type="button"
              className="ds-btn primary"
              disabled={!hasModel}
              onClick={() => goStep((step + 1) as StepIndex)}
            >
              {COPY.next(COPY.steps[step + 1])}
            </button>
          ) : (
            <>
              <button type="button" className="ds-btn" disabled={blocked || busy || measuring || !!phase} title={why} aria-describedby={why ? 'ri-why' : undefined} onClick={exportIt}>
                {COPY.exportFile}
              </button>
              <button
                type="button"
                id="ri-testdrive"
                className="ds-btn"
                disabled={blocked || busy || measuring || !!phase}
                title={why}
                aria-describedby={why ? 'ri-why' : undefined}
                onClick={testDrive}
              >
                {COPY.testDrive}
              </button>
              <button
                type="button"
                className="ds-btn primary"
                disabled={blocked || busy || measuring || !!phase}
                title={why}
                aria-describedby={why ? 'ri-why' : undefined}
                onClick={save}
              >
                {doc.editId ? COPY.saveEdit : COPY.saveNew}
              </button>
              {why ? (
                <span id="ri-why" className="ds-sr">
                  {why}
                </span>
              ) : null}
            </>
          )}
        </div>
        </div>
        </div>
      </div>

      {dialog?.kind === 'discard' ? (
        <ConfirmDialog
          title={doc.editId ? COPY.discardTitleEdit : COPY.discardTitleNew}
          body={<p className="ds-hint">{doc.editId ? COPY.discardBodyEdit(doc.spec.name || 'This robot') : COPY.discardBodyNew}</p>}
          confirm={COPY.discard}
          danger
          onConfirm={() => void discard()}
          onClose={() => setDialog(null)}
        />
      ) : dialog?.kind === 'dup' ? (
        <DuplicateDialog
          name={dialog.name}
          onReplace={dialog.replace}
          onKeepBoth={dialog.keepBoth}
          onClose={() => {
            setDialog(null);
            setPhase(null);
          }}
        />
      ) : null}
    </>
  );
}
