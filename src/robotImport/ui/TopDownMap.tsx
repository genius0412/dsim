import { useId, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type { Vec2 } from '../../types';
import { bbox } from '../geometry';
import { COPY } from './copy';
import { padIsActive, useHandleGrab } from './useHandleGrab';

/**
 * THE TOP-DOWN EDITOR — the footprint seen from above, nose up, with handles to drag: the wheels
 * (Model step) or the mechanism placements (Mechanisms step).
 *
 * Nose up, and the robot's LEFT on the screen's left: MODEL (x, y) → screen (−y, −x), the matrix
 * the bird's-eye gotcha in CLAUDE.md names. A mirrored map is invisible on a symmetric robot and
 * wrong on every other one.
 *
 * The drawing is an SVG in field inches; the HANDLES are real buttons laid over it by percent, so
 * the keyboard, the screen reader and the controller all reach them as ordinary controls:
 *  · pointer: drag, the drawing follows, the move commits on release (StartPositionEditor's rule);
 *    `snap` (the wheels: onto a floor contact, else a 1/16-in grid) applies to the pointer only;
 *  · keyboard: arrows move 1/4 in, Shift+arrows 1/16 in, each press commits; Home puts it back
 *    where the import put it (`onHome`);
 *  · controller: A grabs (`useHandleGrab`), the D-pad or the left stick moves, A drops, B cancels.
 */

export interface MapHandle {
  key: string;
  label: string;
  /** MODEL frame, inches */
  x: number;
  y: number;
  z?: number;
  shape: 'wheel' | 'point' | 'end' | 'mid' | 'aim';
  /** constrain moves to one model axis (a span end slides along its edge) */
  axis?: 'x' | 'y';
  bad?: boolean;
}

export interface MapSpan {
  key: string;
  a: Vec2;
  b: Vec2;
  bad?: boolean;
}

const VIEW_MIN = 22;

export function TopDownMap({
  hull,
  handles,
  spans = [],
  contacts = [],
  frame,
  origin,
  selected,
  ariaLabel,
  readOnly = false,
  status,
  onSelect,
  onMove,
  onHome,
  snap,
}: {
  hull: readonly Vec2[];
  handles: readonly MapHandle[];
  spans?: readonly MapSpan[];
  contacts?: readonly Vec2[];
  /** a closed outline through these points, drawn thin: the rectangle the wheels sit on */
  frame?: readonly Vec2[] | null;
  origin?: Vec2 | null;
  selected: string | null;
  ariaLabel: string;
  readOnly?: boolean;
  /** the one-line status slot under the map (fixed height, so nothing moves) */
  status?: string;
  onSelect?: (key: string) => void;
  /** `final` is false while a drag is in flight, true when it is let go */
  onMove?: (key: string, p: Vec2, final: boolean) => void;
  /** Home on a handle: put it back where the import placed it */
  onHome?: (key: string) => void;
  /** where a POINTER drag puts a handle (keys and the pad move by their own steps) */
  snap?: (key: string, p: Vec2) => Vec2;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ key: string; moved: boolean; last: Vec2 } | null>(null);
  const grab = useHandleGrab();
  const keysId = useId();
  const latest = useRef(handles);
  latest.current = handles;
  /** where a handle was last MOVED TO, until the props catch up: two key presses inside one render
   *  must add up, not both start from the same stale prop */
  const moved = useRef<Record<string, Vec2>>({});
  moved.current = {};

  const b = hull.length ? bbox(hull) : { minX: -9, maxX: 9, minY: -9, maxY: 9 };
  const span = Math.max(VIEW_MIN, b.maxX - b.minX + 4, b.maxY - b.minY + 4);
  const half = span / 2;
  // MODEL → svg (screen inches): (−y, −x)
  const pct = (p: { x: number; y: number }): { left: string; top: string } => ({
    left: `${((-p.y + half) / span) * 100}%`,
    top: `${((-p.x + half) / span) * 100}%`,
  });
  const toModel = (clientX: number, clientY: number): Vec2 | null => {
    const r = box.current?.getBoundingClientRect();
    if (!r || !r.width) return null;
    const sx = ((clientX - r.left) / r.width) * span - half;
    const sy = ((clientY - r.top) / r.height) * span - half;
    return { x: -sy, y: -sx };
  };
  const constrain = (h: MapHandle, p: Vec2): Vec2 => {
    const c = { x: Math.max(-half, Math.min(half, p.x)), y: Math.max(-half, Math.min(half, p.y)) };
    if (h.axis === 'x') return { x: c.x, y: h.y };
    if (h.axis === 'y') return { x: h.x, y: c.y };
    return c;
  };
  const find = (key: string): MapHandle | undefined => {
    const h = latest.current.find((x) => x.key === key);
    const m = moved.current[key];
    return h && m ? { ...h, ...m } : h;
  };
  const emit = (key: string, p: Vec2, final: boolean): void => {
    moved.current[key] = p;
    onMove?.(key, p, final);
  };
  /** screen nudge (dx right, dy up) → model: up = +x, right = −y */
  const nudged = (h: MapHandle, dx: number, dy: number): Vec2 => constrain(h, { x: h.x + dy, y: h.y - dx });

  const onDown = (e: PointerEvent<HTMLButtonElement>, h: MapHandle): void => {
    if (readOnly || e.button !== 0) return;
    onSelect?.(h.key);
    drag.current = { key: h.key, moved: false, last: { x: h.x, y: h.y } };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPMove = (e: PointerEvent<HTMLButtonElement>, h: MapHandle): void => {
    const d = drag.current;
    if (!d || d.key !== h.key) return;
    const p = toModel(e.clientX, e.clientY);
    if (!p) return;
    d.moved = true;
    d.last = constrain(h, snap ? snap(h.key, p) : p);
    onMove?.(h.key, d.last, false);
  };
  const onUp = (e: PointerEvent<HTMLButtonElement>): void => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d?.moved) onMove?.(d.key, d.last, true);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, h: MapHandle): void => {
    if (readOnly) return;
    if (e.key === 'Home' && onHome) {
      e.preventDefault();
      onHome(h.key);
      return;
    }
    const step = e.shiftKey ? 1 / 16 : 0.25;
    const dir: Record<string, [number, number]> = {
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
    };
    const d = dir[e.key];
    if (!d) return;
    e.preventDefault();
    emit(h.key, nudged(find(h.key) ?? h, d[0], d[1]), true);
  };
  const onClick = (h: MapHandle): void => {
    onSelect?.(h.key);
    if (readOnly || !padIsActive() || grab.grabbed) return;
    const start = { x: h.x, y: h.y };
    grab.start(h.key, {
      nudge(dx, dy) {
        const cur = find(h.key);
        if (cur) emit(h.key, nudged(cur, dx, dy), false);
      },
      drop() {
        const cur = find(h.key);
        grab.stop();
        if (cur) onMove?.(h.key, { x: cur.x, y: cur.y }, true);
      },
      cancel() {
        grab.stop();
        onMove?.(h.key, start, true);
      },
    });
  };

  const g = grab.glyphs;
  const line = grab.grabbed ? COPY.grabPad('✚', g.confirm, g.back) : status;
  const pts = hull.map((p) => `${(-p.y).toFixed(3)},${(-p.x).toFixed(3)}`).join(' ');
  return (
    <div className="ds-import-map-wrap">
      {/* ABOVE the map, not on it: the front edge is where an intake's handles sit, and a handle
          (32 px under a finger) covered the label */}
      <span className="ds-import-map-front" aria-hidden="true">
        ▲ {COPY.frontMark}
      </span>
      <div className="ds-import-map" ref={box} role="group" aria-label={ariaLabel}>
        <svg viewBox={`${-half} ${-half} ${span} ${span}`} aria-hidden="true">
          <rect className="cube" x={-9} y={-9} width={18} height={18} />
          {hull.length >= 3 ? <polygon className="hull" points={pts} /> : null}
          {contacts.map((c, i) => (
            <circle key={i} className="contact" cx={-c.y} cy={-c.x} r={0.35} />
          ))}
          {frame && frame.length >= 3 ? <polygon className="frame" points={frame.map((p) => `${-p.y},${-p.x}`).join(' ')} /> : null}
          {spans.map((s) => (
            <line key={s.key} className={`span${s.bad ? ' bad' : ''}`} x1={-s.a.y} y1={-s.a.x} x2={-s.b.y} y2={-s.b.x} />
          ))}
          {origin ? (
            <g className="origin">
              <line x1={-origin.y - 0.8} y1={-origin.x} x2={-origin.y + 0.8} y2={-origin.x} />
              <line x1={-origin.y} y1={-origin.x - 0.8} x2={-origin.y} y2={-origin.x + 0.8} />
            </g>
          ) : null}
        </svg>
        {handles.map((h) => (
          <button
            key={h.key}
            id={`ri-h-${h.key}`}
            type="button"
            className={`ds-import-handle ${h.shape}${selected === h.key ? ' on' : ''}${grab.grabbed === h.key ? ' held' : ''}${h.bad ? ' bad' : ''}`}
            style={pct(h)}
            aria-label={COPY.handleAria(h.label, h.x, h.y, h.z)}
            aria-pressed={selected === h.key}
            aria-describedby={keysId}
            disabled={readOnly}
            onPointerDown={(e) => onDown(e, h)}
            onPointerMove={(e) => onPMove(e, h)}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onKeyDown={(e) => onKey(e, h)}
            onFocus={() => onSelect?.(h.key)}
            onClick={() => onClick(h)}
          />
        ))}
      </div>
      <span id={keysId} className="ds-sr">
        {COPY.grabKeys}
      </span>
      <p className="ds-import-map-status" role="status">
        {line ?? ''}
      </p>
    </div>
  );
}
