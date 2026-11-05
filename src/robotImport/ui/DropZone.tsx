import { useRef, useState } from 'react';
import { OptRow } from '../../ui/OptRow';
import { FULL_DETAIL, LIGHT_TRI_BUDGET } from '../geometry';
import { COPY } from './copy';

/** what the drop box shows while a file is being read */
export interface Phase {
  /** the file being read (bold line) */
  title: string;
  /** the stage, a sentence ending in … */
  label: string;
  /** 0..1, or undefined for an indeterminate stage */
  frac?: number;
}

/** what the drop box shows after a failure */
export interface DropError {
  text: string;
  /** a second action beside "Choose another file" (Try again, Set it up for …) */
  extra?: { label: string; run: () => void };
}

/** STEP is the CAD import; GLB is accepted only so ImportEditor can validate a DSIM share file. */
export const ACCEPT = '.step,.stp,.glb';
const STEP_NAME = /\.(step|stp)$/i;
const GLB_NAME = /\.glb$/i;
/** is this a STEP file? */
export const isStepFile = (file: File): boolean => STEP_NAME.test(file.name);
/** the only non-STEP candidate is a single GLB, which ImportEditor must validate as a DSIM share */
export const isImportFileSelection = (files: readonly File[]): boolean =>
  files.length > 0 && (files.every(isStepFile) || (files.length === 1 && GLB_NAME.test(files[0].name)));

/**
 * THE DROP BOX: one `.ds-opt-add` tile of a fixed height (`.ds-import-drop`) whose CONTENT swaps
 * between empty, reading and failed, so none of the three moves the page. The file picker is a
 * real button that clicks a hidden input: a `<label>` is not focusable, so a controller could not
 * reach it.
 *
 * Before a file is chosen, the box also asks the one thing a file cannot carry — the DETAIL it is
 * read at (Full keeps every triangle, Light simplifies to `LIGHT_TRI_BUDGET`) — so the choice is
 * made once, before the read starts, instead of by re-reading a big STEP afterwards.
 */
export function DropZone({
  phase,
  error,
  onFiles,
  onCancel,
  detail,
  onDetail,
  pendingFiles,
  onStartPending,
  detailDisabled,
}: {
  phase: Phase | null;
  error: DropError | null;
  onFiles: (files: File[]) => void;
  onCancel: () => void;
  /** the triangle budget the file will be read at (`ImportSetup.triBudget`) */
  detail: number;
  onDetail: (budget: number) => void;
  /** files handed from the robot page; wait for the player's Detail choice before reading them */
  pendingFiles?: File[] | null;
  onStartPending?: () => void;
  detailDisabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [notStep, setNotStep] = useState<string | null>(null);
  const pendingShare = pendingFiles?.length === 1 && GLB_NAME.test(pendingFiles[0].name);
  const pick = (): void => {
    setNotStep(null);
    input.current?.click();
  };
  /** STEP files and a single possible share file go to ImportEditor; it validates the GLB contents. */
  const take = (files: File[]): void => {
    if (!files.length) return;
    if (!isImportFileSelection(files)) {
      setNotStep(COPY.notStep(files.map((f) => f.name).slice(0, 3).join(', ')));
      onFiles(files);
      return;
    }
    setNotStep(null);
    onFiles(files);
  };
  const pct = phase?.frac === undefined ? 2 : Math.max(2, Math.round(phase.frac * 100));
  return (
    <>
      <div className="ds-import-before">
        <OptRow<number>
          label={COPY.detail}
          hint={COPY.detailBefore}
          value={detail > 0 ? LIGHT_TRI_BUDGET : FULL_DETAIL}
          cols="two"
          disabled={detailDisabled || !!pendingShare}
          options={[
            { v: FULL_DETAIL, t: COPY.detailFull, d: COPY.detailFullNote },
            { v: LIGHT_TRI_BUDGET, t: COPY.detailLight, d: COPY.detailLightNote(LIGHT_TRI_BUDGET) },
          ]}
          onPick={onDetail}
        />
      </div>
      <div
        className={`ds-opt ds-opt-add ds-import-drop${over ? ' on' : ''}`}
        role="group"
        aria-label={COPY.dropTitle}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.types).includes('Files')) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(Array.from(e.dataTransfer.files));
        }}
      >
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            take(files);
          }}
        />
        {phase ? (
          <>
            <span className="ot">{phase.title}</span>
            <div
              className="rec-track"
              role="progressbar"
              aria-label={COPY.progressAria}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={phase.frac === undefined ? undefined : pct}
            >
              <div className="rec-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="od" role="status">
              {phase.label}
            </span>
            <button type="button" className="ds-btn ghost small" onClick={onCancel}>
              {COPY.cancel}
            </button>
          </>
        ) : error ? (
          <>
            <span className="od err" role="alert">
              {error.text}
            </span>
            <span className="ds-import-drop-acts">
              {error.extra ? (
                <button type="button" className="ds-btn" onClick={error.extra.run}>
                  {error.extra.label}
                </button>
              ) : null}
              <button type="button" className="ds-btn primary" id="ri-choose" onClick={pick}>
                {COPY.chooseAnother}
              </button>
            </span>
          </>
        ) : pendingFiles?.length ? (
          <>
            <span className="ot">{COPY.pendingTitle}</span>
            <span className="od">
              {pendingShare
                ? COPY.pendingShare(pendingFiles[0].name)
                : COPY.pendingFiles(pendingFiles.map((f) => f.name).slice(0, 3).join(', '))}
            </span>
            <span className="ds-import-drop-acts">
              <button type="button" className="ds-btn primary" id="ri-start" onClick={onStartPending}>
                {COPY.startImport}
              </button>
              <button type="button" className="ds-btn" id="ri-choose" onClick={pick}>
                {COPY.chooseAnother}
              </button>
            </span>
          </>
        ) : (
          <>
            <span className="ot">{over ? COPY.dropNow : COPY.dropTitle}</span>
            <button type="button" className="ds-btn primary" id="ri-choose" onClick={pick}>
              {COPY.choose}
            </button>
            <span className={notStep ? 'od err' : 'od'} role={notStep ? 'alert' : undefined}>
              {notStep ?? COPY.dropFormats}
            </span>
          </>
        )}
      </div>
    </>
  );
}
