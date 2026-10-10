import { useRef, useState } from 'react';
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

export const ACCEPT = '.glb,.gltf,.bin,.step,.stp,.stl,.obj,.mtl,.3mf,.ply,.zip,.png,.jpg,.jpeg';

/**
 * THE DROP BOX: one `.ds-opt-add` tile of a fixed height (`.ds-import-drop`) whose CONTENT swaps
 * between empty, reading and failed, so none of the three moves the page. The file picker is a
 * real button that clicks a hidden input: a `<label>` is not focusable, so a controller could not
 * reach it.
 */
export function DropZone({
  phase,
  error,
  onFiles,
  onCancel,
}: {
  phase: Phase | null;
  error: DropError | null;
  onFiles: (files: File[]) => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const pick = (): void => input.current?.click();
  const pct = phase?.frac === undefined ? 2 : Math.max(2, Math.round(phase.frac * 100));
  return (
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
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(files);
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
          if (files.length) onFiles(files);
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
      ) : (
        <>
          <span className="ot">{over ? COPY.dropNow : COPY.dropTitle}</span>
          <button type="button" className="ds-btn primary" id="ri-choose" onClick={pick}>
            {COPY.choose}
          </button>
          <span className="od">{COPY.dropFormats}</span>
        </>
      )}
    </div>
  );
}
