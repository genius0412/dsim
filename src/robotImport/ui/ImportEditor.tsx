import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GameSettings } from '../../game';
import type { GameId, ImportedMech, RobotSpec, Vec2 } from '../../types';
import { coerceSpec } from '../../sim/spawn';
import { bbIntakeKindOf, bbIsTurreted, bbLauncherOf } from '../../games/biobuzz/mechs';
import { BB_HOOD_DEFAULT_DEG } from '../../games/biobuzz/config';
import { decodeFixedLauncher } from '../../sim/fixedShot';
import { seasonFor } from '../../seasons';
import { FOCUSABLE } from '../../ui/PadNavLayer';
import { loadImporterEngine, type ImporterEngine } from '../engineLoader';
import type { ImportProgress, NormalisedModel, PreparedModel } from '../engine/importerEngine';
import type { LoadStage } from '../engine/load';
import { wheelDiameterMm } from '../drive';
import { defaultImportSetup, orientKey, transformParts } from '../geometry';
import { coaxialBodies, findDeployedGroup, findFlywheelGroups, findRollerGroups, findTurretGroup, findWheelGroups, isSpin, motionAsStored, mountedBodies } from '../motion';
import { deleteRobot, getRobot, listRobots, newRobotId, putRobot } from '../library';
import { editSaveId, planShareAdd } from '../libraryIds';
import { readShareFile, type SharePayload } from '../shareFile';
import { STORED_MESH_TO_ROBOT, type ImportSetup, type LibraryRobot, type MotionGroup, type WheelLayout } from '../types';
import { defaultMechFor, mechHandlesFor, mechRobotToModel, validateMechFor } from './placement';
import { invalidateImportedAssets, registerImportedAssets, unregisterImportedAssets } from '../../render/importedAssets';
import { COPY } from './copy';
import { DrivetrainStep } from './DrivetrainStep';
import { dropDraft, flushDraft, keepDraft, liveDraft, restoreDraft, type LiveDraft } from './draftStore';
import type { DropError, Phase } from './DropZone';
import {
  baseName,
  blocks,
  buildSpec,
  draftKey,
  frontAssumed,
  driveNumbers,
  layoutPatch,
  moveWheel,
  rectangleWheels,
  keepEditedMotion,
  reviewItems,
  reviewSummary,
  setRectNumber,
  stepOf,
  wheelLayoutOf,
  type EditorDoc,
  type RectNumber,
  type ReviewItem,
  type StepIndex,
} from './editorModel';
import { downloadBytes, shareBytes, shareFileName } from './exportRobot';
import { libraryChanged, postRobotNotice, takeHandedFiles } from './handoff';
import { ConfirmDialog, DuplicateDialog } from './LibraryDialogs';
import { MechanismsStep } from './MechanismsStep';
import { ModelStep } from './ModelStep';
import { MotionPanel, type PickTarget } from './MotionPanel';
import { TunePanel } from './TunePanel';
import { driveTuneFields, mechTuneFields } from './tuneFields';
import { PreviewPane } from './PreviewPane';
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

const STAGE_LABEL = (stage: LoadStage, file: string): string => {
  const p = COPY.phase[stage];
  return typeof p === 'function' ? p(file) : p;
};

/** does this build's launcher sit on a turret (so a turret is worth looking for in the model)? */
function turretBuild(game: GameId, spec: RobotSpec): boolean {
  if (game === 'biobuzz') return bbIsTurreted(bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG));
  if (game === 'chain') return spec.scoreMode === 'turret' || spec.scoreMode === 'twinturret';
  return !decodeFixedLauncher(spec);
}

/** the drop box's line for an import stage reported by the engine (worker or not) */
const progressLabel = (p: ImportProgress, file: string): string =>
  p.stage === 'simplify' ? COPY.phase.simplify((p.tris ?? 0).toLocaleString('en-US')) : p.stage === 'measure' ? COPY.phase.measure : STAGE_LABEL(p.stage, file);

/** a measurement still running after this long says so; a shorter one would only flicker */
const MEASURING_NOTICE_MS = 300;

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

export default function ImportEditor({ settings, editId, onBack, onSaved, onTestDrive }: ImportEditorProps) {
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
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    { kind: 'discard' } | { kind: 'dup'; name: string; replace: () => void; keepBoth: () => void } | null
  >(null);
  const gen = useRef(0);
  /** the import in flight: aborting it terminates its workers (Cancel, a new drop) */
  const importAbort = useRef<AbortController | null>(null);
  const pendingFocus = useRef<string | null>(null);

  const setDraft = useCallback((d: LiveDraft | null) => {
    draftRef.current = d;
    setDraftState(d);
    if (d) keepDraft(d);
  }, []);
  /** edit the document (and keep the draft) */
  const update = useCallback(
    (fn: (d: EditorDoc) => EditorDoc) => {
      const cur = draftRef.current;
      if (!cur) return;
      setDraft({ ...cur, doc: { ...fn(cur.doc), updated: Date.now() } });
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

  /** read dropped files into a prepared model and a fresh measurement */
  const readModel = useCallback(
    async (files: File[], opts: { setup?: Partial<ImportSetup>; savedModel?: boolean; spec?: RobotSpec; keepSource?: EditorDoc['source'] } = {}) => {
      const my = ++gen.current;
      // one import at a time: a new drop stops the last one's workers
      importAbort.current?.abort();
      const abort = new AbortController();
      importAbort.current = abort;
      const name = files[0]?.name ?? '';
      setError(null);
      setActionError(null);
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
      try {
        // read, weld and simplify in the import worker; the main thread only paints the progress
        const prepared = await e.importModel(files, {
          budget: draftRef.current?.doc.setup.triBudget ?? defaultImportSetup().triBudget,
          signal: abort.signal,
          onProgress: (p) => {
            if (my !== gen.current) return;
            // a big STEP reads for minutes: once a quarter of it is read, say how long is left (any
            // earlier, the pieces still in flight make the guess run long: 4 min for a 70 s read)
            if (p.stage === 'step-parse' && !stepStart) stepStart = performance.now();
            const elapsed = stepStart ? (performance.now() - stepStart) / 1000 : 0;
            const left = p.stage === 'step-parse' && p.frac && p.frac >= 0.25 && p.frac < 1 && elapsed >= 10 ? (elapsed * (1 - p.frac)) / p.frac : null;
            setPhase({ title: name, label: left === null ? progressLabel(p, name) : COPY.phase.stepLeft(name, left), frac: p.frac });
          },
        });
        if (my !== gen.current) return;
        setPhase({ title: name, label: COPY.phase.measure });
        const cur = draftRef.current;
        const baseDoc = cur?.doc ?? freshDoc(settings, key, editId);
        // a new file is a new robot: everything about how it stands, where its wheels are and what
        // moves is found again (the wheel layout too: its wheels decide it; the moving parts too: the
        // bodies are numbered per file), unless the caller says otherwise
        let setup: ImportSetup = { ...baseDoc.setup, units: 'auto', up: 'auto', yaw: 0, wheels: null, wheelLayout: undefined, motion: undefined, ...opts.setup };
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
          notes: model.notes.length ? model.notes : undefined,
          updated: Date.now(),
        };
        const replaced = draftRef.current?.model;
        if (replaced && replaced !== prepared) e.releaseModel(replaced as PreparedModel);
        setActiveMotion(null);
        setPlaying(false);
        sourceFiles.current = opts.savedModel ? null : files;
        setDraft({ doc, model: prepared, modelStored: false, baked: null });
        setPhase(null);
      } catch (err) {
        if (my !== gen.current || (err instanceof Error && err.name === 'AbortError')) return;
        console.warn('[import] read failed', err);
        setPhase(null);
        const msg = err instanceof Error && err.name === 'ImportError' ? err.message : `Couldn’t read ${name}. Export it again and retry.`;
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
      setError(null);
      if (payload.game !== game) {
        const season = seasonFor(game).name;
        setError({
          text: COPY.wrongGame(payload.name, season, seasonFor(payload.game).name),
          extra: {
            label: COPY.setUpFor(season),
            run: () => void readModel([file], { setup: { units: 'm', up: '+y', yaw: 0, drive: payload.setup.drive }, savedModel: true }),
          },
        });
        return;
      }
      setPhase({ title: file.name, label: COPY.phase.adding(payload.name) });
      try {
        const e = await ensureEngine();
        const spec: RobotSpec = { ...coerceSpec(payload.spec, undefined, game), name: payload.name.slice(0, 24) };
        if (!spec.imported) throw new Error('share file without an import');
        const model = await e.loadModel([file]);
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
        console.warn('[import] share file failed', err);
        setPhase(null);
        setError({ text: COPY.bakeFailed });
      }
    },
    [game, ensureEngine, readModel, onSaved],
  );

  /** files from the drop box, the picker, Replace, or the robot page's add card */
  const onFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 1 && /\.glb$/i.test(files[0].name)) {
        try {
          const res = readShareFile(await files[0].arrayBuffer());
          if (res.ok) return void addShared(files[0], res.payload);
          if (res.error === 'newer-version') {
            setError({ text: COPY.newer, extra: { label: COPY.setUpAgain, run: () => void readModel(files) } });
            return;
          }
        } catch (err) {
          console.warn('[import] share check failed', err);
        }
      }
      void readModel(files);
    },
    [addShared, readModel],
  );

  // ---- boot: a handed file, the live draft, the stored draft, a library robot, or empty ----
  useEffect(() => {
    let dead = false;
    void (async () => {
      const files = takeHandedFiles();
      let d = liveDraft(key);
      if (!d && !files) {
        setRestoring(true);
        d = await restoreDraft(key).catch(() => null);
        if (dead) return;
        setRestoring(false);
      }
      if (d) {
        setDraft(d);
        if (d.model) void ensureEngine().catch(() => setError({ text: COPY.engineFailed }));
        if (files) void onFiles(files);
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
        setDraft({ doc: { ...base, id: rec.id, spec: { ...rec.spec }, created: rec.created, setup: rec.setup }, model: null, modelStored: false, baked: null });
        const file = new File([rec.mesh], `${baseName(rec.source.name)}.glb`);
        await readModel([file], {
          setup: { ...rec.setup, units: 'm', up: '+y', yaw: 0, wheels: rec.setup.wheels },
          savedModel: true,
          spec: { ...rec.spec },
          keepSource: rec.source,
        });
        // the saved placements, back into the model frame
        const cur = draftRef.current;
        const imp = rec.spec.imported;
        if (cur?.model && imp?.mech && engRef.current) {
          const n = engRef.current.normalise(cur.model, cur.doc.setup);
          setDraft({ ...cur, doc: { ...cur.doc, mech: mechRobotToModel(imp.mech, n.measurement.origin) } });
        }
        return;
      }
      setDraft({ doc: freshDoc(settings, key, null), model: null, modelStored: false, baked: null });
      if (files) void onFiles(files);
    })();
    return () => {
      dead = true;
      flushDraft(key);
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
    eng.prepareMeasure(model as PreparedModel, doc.setup).then(
      () => live && setMeasured((t) => t + 1),
      (err) => console.warn('[import] measure failed', err),
    );
    return () => {
      live = false;
    };
    // once per orientation: a wheel or drivetrain edit has the same key and is never `ready: false`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eng, model, okey, ready]);
  const fresh: NormalisedModel | null = useMemo(() => {
    if (!eng || !model || !doc || !ready) return null;
    try {
      return eng.normalise(model as PreparedModel, doc.setup);
    } catch (err) {
      console.warn('[import] normalise failed', err);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eng, model, doc?.setup, ready]);
  const lastMeasured = useRef<{ model: unknown; n: NormalisedModel } | null>(null);
  if (fresh) lastMeasured.current = { model, n: fresh };
  const normalised = fresh ?? (lastMeasured.current?.model === model ? lastMeasured.current.n : null);
  /** a new orientation is being measured; what is shown is the last one */
  const measuring = !!model && !fresh;
  const [measuringLong, setMeasuringLong] = useState(false);
  useEffect(() => {
    if (!measuring) return setMeasuringLong(false);
    const t = window.setTimeout(() => setMeasuringLong(true), MEASURING_NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [measuring]);
  const m = normalised?.measurement ?? null;
  const built = useMemo(() => (doc && m ? buildSpec(doc, m) : null), [doc, m]);
  const defs = useMemo(() => (built ? mechHandlesFor(game, built.spec) : []), [built, game]);
  const assumedFront = frontAssumed(doc);
  const readNotes = doc?.notes;
  const items = useMemo(() => reviewItems(m, built, game, assumedFront, readNotes ?? []), [m, built, game, assumedFront, readNotes]);
  const mechChecks = useMemo(() => (built ? validateMechFor(built.spec, game) : []), [built, game]);
  const numbers = useMemo(() => (built ? driveNumbers(built, game) : null), [built, game]);

  // placements default in once there is a footprint, and again when a mechanism appears
  // (never from a measurement of the orientation being replaced: the placements would land on it)
  useEffect(() => {
    if (!doc || !m || !built || m.hull.length < 3 || measuring) return;
    const next = defaultMechFor(game, built.spec, m.origin, doc.mech);
    if (JSON.stringify(next) !== JSON.stringify(doc.mech)) update((d) => ({ ...d, mech: next }));
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
  const goStep = (s: StepIndex, focus?: string): void => {
    pendingFocus.current = focus ?? null;
    update((d) => ({ ...d, step: s }));
  };
  const blocked = blocks(items) > 0;

  /** the setup as the stored mesh needs it: the hinged parts already folded (`motionAsStored`) */
  const storedSetup = (s: ImportSetup): ImportSetup =>
    s.motion ? { ...s, motion: motionAsStored(s.motion, normalised?.measurement.motion) } : s;

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
      modelParts: normalised.modelParts,
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

  const save = (): void =>
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
      flushDraft(key);
      focusOnReturn = 'ri-testdrive';
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
  const commitWheels = (next: Vec2[]): void => update((d) => ({ ...d, setup: { ...d.setup, wheels: next, wheelLayout: layout } }));
  const onWheel = (i: number, p: Vec2, final: boolean): void => {
    // not while a new orientation is measured: the wheels shown are in the frame it replaces
    if (!m || !baseWheels || measuring) return;
    const next = moveWheel(baseWheels, i, p, layout);
    if (!final) return setWheelDrag(next);
    setWheelDrag(null);
    commitWheels(next);
  };
  const onRect = (key: RectNumber, v: number): void => {
    if (!m || !baseWheels || measuring) return;
    commitWheels(setRectNumber(baseWheels, key, v));
  };
  const onLayout = (next: WheelLayout): void => {
    if (!m || measuring || next === layout) return;
    update((d) => ({ ...d, setup: { ...d.setup, ...layoutPatch(d.setup, next) } }));
  };

  // ---- detail: the triangle budget the file is read at -----------------------------------------
  // A new detail re-reads the files still in memory, keeping everything set so far: the bodies are
  // the file's own, so the moving parts still name the same ones, and the placements go back once
  // the new model is measured. Without the files (a reload, a saved robot) it applies next read.
  const onDetail = (budget: number): void => {
    if (!doc || doc.savedModel || budget === doc.setup.triBudget) return;
    const files = sourceFiles.current;
    const setup = { ...doc.setup, triBudget: budget };
    update((d) => ({ ...d, setup: { ...d.setup, triBudget: budget } }));
    if (!files) return;
    const keepMech = doc.mech;
    void readModel(files, { setup, spec: doc.spec }).then(() => {
      if (keepMech) update((d) => ({ ...d, mech: keepMech }));
    });
  };

  // ---- moving parts ----------------------------------------------------------------------------
  const motion = doc?.setup.motion;
  const findWheels = (): MotionGroup[] =>
    normalised && baseWheels && doc
      ? findWheelGroups(normalised.modelParts, baseWheels, doc.setup.drive.drivetrain, wheelDiameterMm(doc.setup.drive.wheel) / 25.4)
      : [];
  /**
   * EVERY KIND OF MOVING PART the model shows, among the bodies `have` does not hold: the drive wheels
   * (when there are none yet), the intake rollers on the intake spans, flywheels by the launcher, a
   * turret under it (a turreted build), and a part the file shows deployed past 18 in at an intake
   * edge (BIOBUZZ's ramp, else a folding part). Suggestions, marked `found`.
   */
  const findAll = (have: readonly MotionGroup[]): MotionGroup[] => {
    if (!normalised || !doc) return [];
    const parts = normalised.modelParts;
    const out: MotionGroup[] = [];
    const taken = (): Set<number> => new Set([...have, ...out].flatMap((g) => g.bodies));
    // a wheel per corner no row has yet (a player's own wheel row keeps its corner)
    for (const w of findWheels()) {
      if (have.some((g) => g.role === 'wheel' && g.corner === w.corner)) continue;
      const t = taken();
      const bodies = w.bodies.filter((b) => !t.has(b));
      if (bodies.length) out.push({ ...w, bodies });
    }
    const intakes = doc.mech?.intakes ?? [];
    if (intakes.length) out.push(...findRollerGroups(parts, intakes, taken()));
    const shooter = doc.mech?.shooter;
    if (shooter && built) {
      const at: [number, number, number] = [shooter.x, shooter.y, shooter.z];
      if (turretBuild(game, built.spec) && !have.some((g) => g.role === 'turret')) {
        const t = findTurretGroup(parts, at, taken());
        if (t) out.push(t);
      }
      if (!have.some((g) => g.role === 'flywheel')) out.push(...findFlywheelGroups(parts, at, taken()));
    }
    if (intakes.length && !have.some((g) => g.role === 'ramp' || g.role === 'fold')) {
      const ramp = game === 'biobuzz' && built && bbIntakeKindOf(built.spec) === 'ramp';
      const dep = findDeployedGroup(parts, intakes, ramp ? 'ramp' : 'fold', taken());
      if (dep) out.push(dep);
    }
    return out;
  };
  // the moving parts are looked for once, on a setup that has never had any, once the placements are
  // in (rollers, flywheels and a turret are looked for by the intake spans and the launcher)
  useEffect(() => {
    if (!doc || !normalised || measuring || !baseWheels || doc.setup.motion !== undefined || !doc.mech) return;
    const found = findAll([]);
    update((d) => (d.setup.motion === undefined ? { ...d, setup: { ...d.setup, motion: found } } : d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.setup.motion, normalised, measuring, baseWheels, !doc?.mech]);
  const setMotion = (next: MotionGroup[]): void => update((d) => ({ ...d, setup: { ...d.setup, motion: next } }));
  /** Find moving parts: every row the player has not touched goes, and is looked for again */
  const refindMotion = (): void => {
    const kept = keepEditedMotion(motion ?? []);
    setActiveMotion(null);
    setHoverMotion(null);
    setMotion([...kept, ...findAll(kept)]);
  };
  // a selected row is being edited: a click in the preview adds or takes out its parts
  const picking = step === MOVING_STEP && activeMotion !== null && !!motion?.[activeMotion];
  // a click in the preview: the part under it (and, for something that spins, its axle; for the rest,
  // what is mounted on it) joins the group being picked, or leaves it when it is already in it.
  // A body belongs to one moving part at a time.
  const onPickBody = (body: number, shift: boolean): void => {
    if (!picking || !normalised || !motion || activeMotion === null) return;
    const g = motion[activeMotion];
    if (pickTarget === 'axis') {
      // naming a joint's axle (or a slide's rail): one click, and the picking ends
      setMotion(motion.map((o, i) => (i === activeMotion ? { ...o, axis: 'part' as const, axisBody: body, found: undefined } : o)));
      setActiveMotion(null);
      return;
    }
    const parts = normalised.modelParts;
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
  const highlight = useMemo(() => {
    if (step !== MOVING_STEP || !motion) return null;
    // the selected row, or else the one under the pointer
    const shown = activeMotion ?? (hoverMotion !== null && hoverMotion < motion.length ? hoverMotion : null);
    const active = shown !== null ? (motion[shown]?.bodies ?? []) : [];
    const others = motion.flatMap((g, i) => (i === shown ? [] : g.bodies));
    return active.length || others.length ? { active, others } : null;
  }, [step, motion, activeMotion, hoverMotion]);

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
  const stepCounts = [0, 0, 0, 0];
  const stepBlocks = [0, 0, 0, 0];
  for (const it of items) {
    if (it.level === 'block' || it.level === 'warn') stepCounts[stepOf(it)]++;
    if (it.level === 'block') stepBlocks[stepOf(it)]++;
  }
  const title = doc.editId ? COPY.titleEdit(doc.spec.name || 'robot') : COPY.titleNew;
  // each step draws what it is about: the wheels and the contacts on the Model step, the placements
  // on Mechanisms, the moving parts on theirs, and all of it on Review
  const previewState = m && normalised
    ? {
        parts: normalised.modelParts,
        hull: m.hull,
        wheels: step === 0 || step === 1 || step === REVIEW_STEP ? shownWheels : null,
        contacts: step === 0 ? m.wheels.contacts : null,
        origin: step === 0 ? m.origin : null,
        mech: step === 2 || step === REVIEW_STEP ? doc.mech : null,
        size: m.size,
        showCube: true,
        motion: m.motion ?? null,
        playing: playing && step === MOVING_STEP && !picking,
        highlight: playing ? null : highlight,
        picking,
      }
    : null;
  const legend = !m
    ? null
    : step === 0
      ? COPY.legend.model
      : step === 1
        ? COPY.legend.drive
        : step === 2
          ? COPY.legend.mech({ intake: !!doc.mech?.intakes?.length, shooter: !!doc.mech?.shooter, place: !!doc.mech?.place })
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
        onSpec={(patch) => update((d) => ({ ...d, spec: { ...d.spec, ...patch } }))}
        hull={m.hull}
        heightIn={m.heightIn}
        mech={doc.mech}
        home={defaultMechFor(game, built.spec, m.origin, null)}
        defs={defs}
        checks={mechChecks}
        selected={selHandle}
        onSelect={setSelHandle}
        onMech={(next: ImportedMech) => update((d) => ({ ...d, mech: next }))}
        onReset={() => update((d) => ({ ...d, mech: null }))}
        tuning={
          <TunePanel
            id="ri-tune-mech"
            title={COPY.tuneMech}
            fields={mechTuneFields(game, built.spec)}
            tune={doc.setup.tune}
            onTune={(tune) => update((d) => ({ ...d, setup: { ...d.setup, tune } }))}
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
        onPlay={(on) => {
          setPlaying(on);
          if (on) setActiveMotion(null);
        }}
      />
    ) : null;

  const why = blocked ? COPY.fixFirst : undefined;
  return (
    <>
      <div className="ds-head">
        <button
          type="button"
          className="ds-back"
          onClick={() => {
            flushDraft(key);
            onBack();
          }}
        >
          {COPY.back}
        </button>
        <span className="ds-head-spacer" />
        {hasModel ? (
          <button type="button" className="ds-btn ghost small" onClick={() => setDialog({ kind: 'discard' })}>
            {doc.editId ? COPY.discardEdit : COPY.discardNew}
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

        <section className="ds-panel ds-import-body">
          <div className="ds-panel-h">
            {step === REVIEW_STEP && hasModel ? (
              <h2 className={`ds-panel-title notice${blocked ? ' error' : ''}`} role="status">
                {actionError ?? (busy ? COPY.working : measuring ? COPY.phase.measure : reviewSummary(items))}
              </h2>
            ) : (
              // a measurement past `MEASURING_NOTICE_MS` takes the title's place, as a status does on
              // the Controls screen: the slot keeps its line, so nothing below it moves
              <h2 className={`ds-panel-title${measuringLong ? ' notice' : ''}`} role={measuringLong ? 'status' : undefined}>
                {actionError ?? (measuringLong ? COPY.phase.measure : COPY.steps[step])}
              </h2>
            )}
          </div>
          <div className="ds-panel-body stack">
            {step === 0 || !hasModel ? (
              <ModelStep
                doc={doc}
                m={m}
                // a restored draft's model is measured before the step can show it
                phase={phase ?? (model && !normalised ? { title: doc.source?.name ?? doc.sourceName ?? '', label: COPY.phase.measure } : null)}
                error={error}
                wheels={shownWheels}
                selectedWheel={selWheel}
                layout={layout}
                onFiles={(f) => void onFiles(f)}
                onCancel={() => {
                  gen.current++;
                  // terminates the import's workers: the CPU stops with the bar
                  importAbort.current?.abort();
                  setPhase(null);
                }}
                onSetup={(patch) =>
                  update((d) => ({
                    ...d,
                    setup: { ...d.setup, ...patch },
                    // units, up and yaw move the model frame, and the placements with it
                    mech: 'units' in patch || 'up' in patch || 'yaw' in patch ? null : d.mech,
                  }))
                }
                onWheel={onWheel}
                onRect={onRect}
                onSelectWheel={setSelWheel}
                onLayout={onLayout}
                onDetail={onDetail}
                canReread={!!sourceFiles.current}
              />
            ) : step === 1 ? (
              <DrivetrainStep
                drive={doc.setup.drive}
                numbers={numbers}
                onDrive={(patch) => update((d) => ({ ...d, setup: { ...d.setup, drive: { ...d.setup.drive, ...patch } } }))}
                tuning={
                  built ? (
                    <TunePanel
                      id="ri-tune-drive"
                      title={COPY.tuneDrive}
                      fields={driveTuneFields(built.spec)}
                      tune={doc.setup.tune}
                      onTune={(tune) => update((d) => ({ ...d, setup: { ...d.setup, tune } }))}
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
                onIdentity={(patch) => update((d) => ({ ...d, spec: { ...d.spec, ...patch } }))}
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
              <button type="button" className="ds-btn" disabled={blocked || busy || measuring} aria-describedby={why ? 'ri-why' : undefined} onClick={exportIt}>
                {COPY.exportFile}
              </button>
              <button
                type="button"
                id="ri-testdrive"
                className="ds-btn"
                disabled={blocked || busy || measuring}
                aria-describedby={why ? 'ri-why' : undefined}
                onClick={testDrive}
              >
                {COPY.testDrive}
              </button>
              <button
                type="button"
                className="ds-btn primary"
                disabled={blocked || busy || measuring}
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
