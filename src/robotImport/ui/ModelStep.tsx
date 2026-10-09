import { useRef } from 'react';
import type { Vec2 } from '../../types';
import { OptRow } from '../../ui/OptRow';
import { FULL_DETAIL, isFullDetail, isRectangle, LIGHT_TRI_BUDGET, WHEEL_SQUARE_TOL_IN } from '../geometry';
import type { ImportMeasurement, ImportSetup, LengthUnit, QuarterTurns, UpAxis, WheelLayout } from '../types';
import { LENGTH_UNITS, UP_AXES } from '../types';
import { COPY, FORMAT_LABEL, UNIT_LABEL, sizeLabel, upLabel } from './copy';
import { ACCEPT, DropZone, type DropError, type Phase } from './DropZone';
import { rectNumbers, snapWheel, WHEEL_MIN_SPAN_IN, wheelHomes, type EditorDoc, type RectNumber } from './editorModel';
import { NumberField } from './NumberField';
import { TopDownMap, type MapHandle } from './TopDownMap';

const fmt = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);
const ROBOT_MAX = 18;
/** the wheel number fields' step, inches: every value on it is typed exactly */
const WHEEL_STEP = 1 / 16;

/**
 * DELETING PARTS (`docs/area/robot-import.md`, "Deleting parts"): the mode in which a click in the
 * preview selects bodies, and the offer to delete what floats apart from the robot.
 */
export interface PartsControls {
  /** bodies deleted so far */
  deleted: number;
  /** bodies selected while `deleting` */
  selected: number;
  deleting: boolean;
  /** what floats apart from the robot and has not been kept: bodies, and the nearest and farthest gap */
  floating: { count: number; near: number; far: number } | null;
  onDeleting: (on: boolean) => void;
  onDelete: () => void;
  onRestore: () => void;
  onDeleteFloating: () => void;
  onKeepFloating: () => void;
}

export function ModelStep({
  doc,
  m,
  phase,
  error,
  wheels,
  selectedWheel,
  layout,
  onFiles,
  onCancel,
  onSetup,
  onWheel,
  onRect,
  onSelectWheel,
  onLayout,
  onDetail,
  canReread,
  parts,
}: {
  doc: EditorDoc;
  m: ImportMeasurement | null;
  phase: Phase | null;
  error: DropError | null;
  /** FL FR BL BR, MODEL frame, with any drag in flight applied */
  wheels: Vec2[] | null;
  selectedWheel: number;
  /** how the wheels move (`wheelLayoutOf`) */
  layout: WheelLayout;
  onFiles: (files: File[]) => void;
  onCancel: () => void;
  onSetup: (patch: Partial<ImportSetup>) => void;
  onWheel: (i: number, p: Vec2, final: boolean) => void;
  /** one of the rectangle's numbers, typed */
  onRect: (key: RectNumber, v: number) => void;
  onSelectWheel: (i: number) => void;
  onLayout: (layout: WheelLayout) => void;
  /** the triangle budget the file is read at (`ImportSetup.triBudget`) */
  onDetail: (budget: number) => void;
  /** the dropped files are still in memory, so a new detail can re-read them */
  canReread: boolean;
  /** deleting parts (`PartsControls`) */
  parts: PartsControls;
}) {
  const replace = useRef<HTMLInputElement>(null);
  if (!m || phase || error) {
    return (
      <>
        <DropZone phase={phase} error={error} onFiles={onFiles} onCancel={onCancel} />
        {!phase ? <p className="ds-hint">{COPY.sidecarHint}</p> : null}
      </>
    );
  }
  const s = doc.source;
  const over = Math.max(m.size.length, m.size.width, m.size.height) > ROBOT_MAX + 1 / 64;
  const hint = (v: string): string => (doc.savedModel ? COPY.savedModel : COPY.detected(v));
  const handles: MapHandle[] = (wheels ?? []).map((w, i) => ({
    key: `w${i}`,
    label: COPY.wheelNames[i],
    x: w.x,
    y: w.y,
    shape: 'wheel',
  }));
  const sel = wheels?.[selectedWheel] ?? null;
  const rect = layout === 'rect' && wheels ? rectNumbers(wheels) : null;
  const det = m.wheels.wheels;
  const wheelFact =
    m.wheelSource === 'manual'
      ? COPY.wheelsManual
      : m.wheelSource === 'none' || !det
        ? COPY.wheelsNone
        : m.wheelsSquared
          ? COPY.wheelsSquared
          : isRectangle(det, WHEEL_SQUARE_TOL_IN)
            ? COPY.wheelsFound
            : COPY.wheelsUneven;
  const wheelField = (key: RectNumber, label: string, min: number, max: number): JSX.Element => (
    <NumberField label={label} unit="in" value={rect![key]} min={min} max={max} step={WHEEL_STEP} digits={2} onCommit={(v) => onRect(key, v)} />
  );
  const b0 = m.hull.length ? m.hull : [];
  // turned from where the file was read: the detected front, or the CAD front when it was assumed
  const base = doc.detected?.yaw ?? 0;
  const turned = ((((doc.setup.yaw - base) % 4) + 4) % 4) * 90;
  const assumed = doc.detected?.front === 'assumed';
  const frontLabel = doc.savedModel
    ? turned
      ? COPY.frontTurned(turned)
      : COPY.savedModel
    : turned
      ? assumed
        ? COPY.frontTurnedAssumed(turned)
        : COPY.frontTurned(turned)
      : assumed
        ? COPY.frontAssumed
        : doc.detected?.cue
          ? COPY.frontFound[doc.detected.cue]
          : COPY.frontDetected;
  const turn = (by: 1 | 3): void => onSetup({ yaw: (((doc.setup.yaw + by) % 4) as QuarterTurns), wheels: null });
  return (
    <>
      <div className="ds-field">
        <span className="cap">{COPY.fileCap}</span>
        <div className="ds-import-filerow">
          <span>
            {s
              ? COPY.fileVal(s.name, FORMAT_LABEL[s.format] ?? s.format.toUpperCase(), sizeLabel(s.bytes))
              : ''}
            {doc.savedModel ? ` · ${COPY.savedModel}` : ''}
          </span>
          <button type="button" className="ds-btn small" onClick={() => replace.current?.click()}>
            {COPY.replace}
          </button>
          <input
            ref={replace}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length) onFiles(files);
            }}
          />
        </div>
      </div>

      <dl className="ds-facts">
        <dt>{COPY.size}</dt>
        <dd>
          {fmt(m.size.length)} × {fmt(m.size.width)} × {fmt(m.size.height)} in{' '}
          <span className={`ds-badge ${over ? 'danger' : 'ok'}`}>{over ? COPY.over : COPY.fits}</span>
        </dd>
        <dt>{COPY.triangles}</dt>
        <dd>
          {(s?.trisIn ?? m.trisIn).toLocaleString('en-US')} → {(s?.trisOut ?? m.trisIn).toLocaleString('en-US')}
        </dd>
        <dt>{COPY.wheels}</dt>
        <dd>{wheelFact}</dd>
      </dl>

      <div className="ds-field" id="ri-parts">
        <span className="cap">
          {COPY.parts}
          {parts.selected || parts.deleted ? <span>{COPY.partsState(parts.deleting ? parts.selected : 0, parts.deleted)}</span> : null}
        </span>
        {parts.floating ? (
          <>
            <p className="ds-hint" role="status">
              {COPY.floating(parts.floating.count, parts.floating.near, parts.floating.far)}
            </p>
            <div className="ds-import-turns">
              <button type="button" className="ds-btn ghost small" onClick={parts.onKeepFloating}>
                {COPY.floatKeep}
              </button>
              <button type="button" className="ds-btn danger small" onClick={parts.onDeleteFloating}>
                {COPY.floatDelete}
              </button>
            </div>
          </>
        ) : null}
        {parts.deleting ? <p className="ds-hint">{COPY.deleteHint}</p> : null}
        <div className="ds-import-turns">
          <button
            type="button"
            className={`ds-btn small${parts.deleting ? ' primary' : ''}`}
            aria-pressed={parts.deleting}
            onClick={() => parts.onDeleting(!parts.deleting)}
          >
            {parts.deleting ? COPY.deleteDone : COPY.deleteParts}
          </button>
          {parts.deleting ? (
            <button type="button" className="ds-btn danger small" disabled={!parts.selected} onClick={parts.onDelete}>
              {COPY.deleteSelected}
            </button>
          ) : null}
          {parts.deleted ? (
            <button type="button" className="ds-btn ghost small" onClick={parts.onRestore}>
              {COPY.restoreAll}
            </button>
          ) : null}
        </div>
      </div>

      <div id="ri-detail">
        <OptRow<number>
          label={COPY.detail}
          hint={doc.savedModel ? COPY.detailSaved : canReread ? undefined : COPY.detailFile}
          value={isFullDetail(doc.setup.triBudget) ? FULL_DETAIL : LIGHT_TRI_BUDGET}
          cols="two"
          disabled={doc.savedModel}
          options={[
            { v: FULL_DETAIL, t: COPY.detailFull, d: COPY.detailFullNote },
            { v: LIGHT_TRI_BUDGET, t: COPY.detailLight, d: COPY.detailLightNote(LIGHT_TRI_BUDGET) },
          ]}
          onPick={onDetail}
        />
      </div>

      <p className="ds-hint">{COPY.orientHint}</p>
      <div className="ds-field" id="ri-front">
        <span className="cap">
          {COPY.front}
          <span>{frontLabel}</span>
        </span>
        <div className="ds-import-turns">
          <button type="button" className="ds-btn small" onClick={() => turn(1)}>
            {COPY.turnLeft}
          </button>
          <button type="button" className="ds-btn small" onClick={() => turn(3)}>
            {COPY.turnRight}
          </button>
        </div>
      </div>
      <div className="ds-fields">
        <label className="ds-field narrow" id="ri-up">
          <span className="cap">
            {COPY.up}
            {doc.detected ? <span>{hint(upLabel(doc.detected.up))}</span> : null}
          </span>
          <select className="ds-select" value={m.up} onChange={(e) => onSetup({ up: e.target.value as UpAxis, wheels: null })}>
            {UP_AXES.map((a) => (
              <option key={a} value={a}>
                {upLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <label className="ds-field narrow" id="ri-units">
          <span className="cap">
            {COPY.units}
            {doc.detected ? <span>{hint(UNIT_LABEL[doc.detected.units])}</span> : null}
          </span>
          <select className="ds-select" value={m.units} onChange={(e) => onSetup({ units: e.target.value as LengthUnit, wheels: null })}>
            {LENGTH_UNITS.map((u) => (
              <option key={u} value={u}>
                {UNIT_LABEL[u]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="ds-field" id="ri-wheels">
        <span className="cap">{COPY.footprint}</span>
        <TopDownMap
          hull={b0}
          handles={handles}
          contacts={m.wheels.contacts}
          // FL FR BR BL: round the rectangle, not across it
          frame={rect && wheels ? [wheels[0], wheels[1], wheels[3], wheels[2]] : null}
          origin={m.origin}
          selected={`w${selectedWheel}`}
          ariaLabel={COPY.footprintAria}
          status={sel ? COPY.placed(COPY.wheelNames[selectedWheel], sel.x, sel.y) : m.wheels.note}
          onSelect={(k) => onSelectWheel(Number(k.slice(1)))}
          onMove={(k, p, final) => onWheel(Number(k.slice(1)), p, final)}
          onHome={(k) => {
            const i = Number(k.slice(1));
            const home = wheelHomes(m, layout)?.[i];
            if (home) onWheel(i, home, true);
          }}
          snap={(_, p) => snapWheel(p, m.wheels.contacts)}
        />
        <OptRow<WheelLayout>
          label={COPY.wheelLayout}
          value={layout}
          cols="two"
          mini
          options={[
            { v: 'rect', t: COPY.layoutRect },
            { v: 'free', t: COPY.layoutFree },
          ]}
          onPick={onLayout}
        />
        {rect ? (
          <>
            <div className="ds-fields">
              {wheelField('wheelbase', COPY.wheelbase, WHEEL_MIN_SPAN_IN, 24)}
              {wheelField('track', COPY.track, WHEEL_MIN_SPAN_IN, 24)}
            </div>
            <div className="ds-fields">
              {wheelField('forward', COPY.centreForward, -12, 12)}
              {wheelField('left', COPY.centreLeft, -12, 12)}
            </div>
          </>
        ) : sel ? (
          <div className="ds-fields">
            <NumberField
              label={COPY.forward}
              unit="in"
              value={sel.x}
              min={-12}
              max={12}
              step={WHEEL_STEP}
              digits={2}
              onCommit={(x) => onWheel(selectedWheel, { x, y: sel.y }, true)}
            />
            <NumberField
              label={COPY.left}
              unit="in"
              value={sel.y}
              min={-12}
              max={12}
              step={WHEEL_STEP}
              digits={2}
              onCommit={(y) => onWheel(selectedWheel, { x: sel.x, y }, true)}
            />
          </div>
        ) : null}
        {m.wheelSource === 'manual' ? (
          <div>
            <button type="button" className="ds-btn ghost small" onClick={() => onSetup({ wheels: null })}>
              {COPY.useDetected}
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
