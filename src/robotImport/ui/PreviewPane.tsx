import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ImporterEngine } from '../engineLoader';
import type { PreviewController, PreviewState, PreviewView } from '../engine/preview';
import { COPY } from './copy';

/**
 * THE PERSISTENT PREVIEW: the engine's orbit view (`createPreview`) of the normalised model on a
 * field tile, with the 18-in cube, the measured hull, the wheels, the front arrow and the mechanism
 * markers. One WebGL context for as long as the editor is mounted; unmounting disposes it
 * (`forceContextLoss`), so a test drive's match never shares the browser's context budget with it.
 *
 * When a context cannot be made (no WebGL, a lost context) the camera segments go `.off` (dashed,
 * the reason in their title) and `fallback` takes the picture's place, the BIOBUZZ preview's rule:
 * no sentence inside the picture.
 */
export function PreviewPane({
  eng,
  state,
  fallback,
  empty,
  legend,
  onPickBody,
}: {
  eng: ImporterEngine | null;
  /** null before a model: the empty frame */
  state: Partial<PreviewState> | null;
  fallback: ReactNode;
  empty: ReactNode;
  /** what the marks drawn over the model mean, on the steps that draw any */
  legend?: string | null;
  /** a click on a part while `state.picking` (`shift`: that one body, not its axle) */
  onPickBody?: (body: number, shift: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const ctl = useRef<PreviewController | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<PreviewView>('iso');
  const [collision, setCollision] = useState(false);
  const ready = !!eng && !!state;

  useEffect(() => {
    if (!ready || failed || !canvasHost.current || !host.current) return;
    // A FRESH CANVAS PER CONTROLLER: `dispose()` ends with `forceContextLoss()`, and a canvas hands
    // back the SAME (now lost) context forever after, so a re-run of this effect on a reused
    // element (a remount, a hot reload) built a renderer on a dead context.
    const el = document.createElement('canvas');
    el.className = 'ds-import-canvas';
    canvasHost.current.appendChild(el);
    let c: PreviewController;
    try {
      c = eng.createPreview(el, { ...state, showCollision: collision });
    } catch (e) {
      console.warn('[import] preview could not start', e);
      el.remove();
      setFailed(true);
      return;
    }
    ctl.current = c;
    const onLost = (ev: Event): void => {
      ev.preventDefault();
      setFailed(true);
    };
    el.addEventListener('webglcontextlost', onLost);
    const fit = (): void => {
      const r = host.current?.getBoundingClientRect();
      if (r && r.width > 0) c.resize(Math.round(r.width), Math.round(r.height));
    };
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    ro?.observe(host.current);
    return () => {
      ro?.disconnect();
      el.removeEventListener('webglcontextlost', onLost);
      ctl.current = null;
      c.dispose();
      el.remove();
    };
    // the controller is made once per engine and model presence; `state` flows in below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, failed, eng]);

  useEffect(() => {
    if (state) ctl.current?.update({ ...state, showCollision: collision });
  }, [state, collision]);

  // the latest handler, through a ref, so the controller's callback is set once per controller
  const pickRef = useRef(onPickBody);
  pickRef.current = onPickBody;
  useEffect(() => {
    ctl.current?.onPickBody((b, shift) => pickRef.current?.(b, shift));
  }, [ready, failed, eng]);

  const pick = (v: PreviewView): void => {
    setView(v);
    ctl.current?.setView(v);
  };

  const off = failed;
  return (
    <aside className="ds-import-preview ds-panel" aria-label={COPY.cameraAria}>
      <div className="ds-import-preview-stage" ref={host}>
        {!state ? empty : failed ? fallback : <div className="ds-import-canvas-host" ref={canvasHost} />}
      </div>
      <div className="ds-import-preview-tools">
        <div className="ds-segs" role="group" aria-label={COPY.cameraAria}>
          {COPY.cameras.map(([v, label]) => (
            <button
              key={v}
              type="button"
              className={`ds-seg${view === v && !off ? ' on' : ''}${off ? ' off' : ''}`}
              aria-pressed={view === v && !off}
              disabled={!ready}
              title={off ? COPY.previewOff : undefined}
              onClick={() => {
                if (off) setFailed(false);
                pick(v);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ds-segs">
        <button
          type="button"
          className={`ds-seg${collision ? ' on' : ''}`}
          aria-pressed={collision}
          disabled={!ready || off}
          onClick={() => setCollision((v) => !v)}
        >
          {COPY.collision}
        </button>
        </div>
      </div>
      {legend && !off ? <p className="ds-hint ds-import-legend">{legend}</p> : null}
      <span className="ds-sr" role="status">
        {off ? COPY.previewOff : ''}
      </span>
    </aside>
  );
}
