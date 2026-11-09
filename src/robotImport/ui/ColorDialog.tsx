import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { parseHex } from '../geometry';
import { rangeFill } from '../../ui/rangeFill';
import { COPY } from './copy';
import { Shell } from './LibraryDialogs';
import { PAGE_COPY } from './pageCopy';

/**
 * THE PARTS' COLOUR (Model step, Select parts → Color): an HSV wheel (hue round it, saturation out from
 * the centre), a brightness slider and a hex field, all one colour. Apply hands back `#rrggbb` (sRGB);
 * Use file colour puts the selection back to what the file gave it.
 */

type Hsv = { h: number; s: number; v: number };

function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number): number => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  const b = (x: number): string => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${b(f(5))}${b(f(3))}${b(f(1))}`;
}

function hexToHsv(hex: string, keepHue = 0): Hsv {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = keepHue;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s: max > 0 ? d / max : 0, v: max };
}

/** the wheel's drawn size, CSS px (one-off geometry: the canvas is square and draws its own marker) */
const WHEEL = 200;

function Wheel({ hsv, onPick }: { hsv: Hsv; onPick: (h: number, s: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  // the wheel itself at this brightness, redrawn only when the brightness moves
  const disc = useRef<{ v: number; img: ImageData } | null>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const px = Math.round(WHEEL * Math.min(2, window.devicePixelRatio || 1));
    if (c.width !== px) {
      c.width = px;
      c.height = px;
      disc.current = null;
    }
    const R = px / 2;
    if (!disc.current || disc.current.v !== hsv.v) {
      const img = ctx.createImageData(px, px);
      for (let y = 0; y < px; y++) {
        for (let x = 0; x < px; x++) {
          const dx = x + 0.5 - R;
          const dy = y + 0.5 - R;
          const r = Math.hypot(dx, dy);
          if (r > R) continue;
          const h = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
          const hex = hsvToHex({ h, s: Math.min(1, r / R), v: hsv.v });
          const i = 4 * (y * px + x);
          img.data[i] = parseInt(hex.slice(1, 3), 16);
          img.data[i + 1] = parseInt(hex.slice(3, 5), 16);
          img.data[i + 2] = parseInt(hex.slice(5, 7), 16);
          // a soft edge one pixel wide
          img.data[i + 3] = Math.round(255 * Math.min(1, R - r + 0.5));
        }
      }
      disc.current = { v: hsv.v, img };
    }
    ctx.putImageData(disc.current.img, 0, 0);
    // the marker: a ring that reads on the colour under it
    const a = (hsv.h * Math.PI) / 180;
    const mx = R + Math.cos(a) * hsv.s * R;
    const my = R - Math.sin(a) * hsv.s * R;
    const ink = hsv.v > 0.6 ? 0 : 255;
    ctx.lineWidth = px / 100;
    ctx.strokeStyle = `rgb(${ink},${ink},${ink})`;
    ctx.beginPath();
    ctx.arc(mx, my, px / 28, 0, 2 * Math.PI);
    ctx.stroke();
  }, [hsv]);

  const pick = (e: PointerEvent<HTMLCanvasElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const h = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
    onPick(h, Math.min(1, Math.hypot(dx, dy) / (r.width / 2)));
  };
  const onKey = (e: KeyboardEvent<HTMLCanvasElement>): void => {
    const step = e.shiftKey ? 15 : 5;
    let { h, s } = hsv;
    if (e.key === 'ArrowLeft') h = (h + 360 - step) % 360;
    else if (e.key === 'ArrowRight') h = (h + step) % 360;
    else if (e.key === 'ArrowUp') s = Math.min(1, s + step / 100);
    else if (e.key === 'ArrowDown') s = Math.max(0, s - step / 100);
    else return;
    e.preventDefault();
    onPick(h, s);
  };
  return (
    <canvas
      ref={ref}
      className="ds-import-wheel"
      tabIndex={0}
      role="slider"
      aria-label={COPY.colorWheel}
      aria-valuetext={COPY.colorWheelValue(Math.round(hsv.h), Math.round(hsv.s * 100))}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        pick(e);
      }}
      onPointerMove={(e) => {
        if (dragging.current) pick(e);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onKeyDown={onKey}
    />
  );
}

export function ColorDialog({
  count,
  initial,
  canReset,
  onApply,
  onReset,
  onClose,
}: {
  /** bodies selected */
  count: number;
  /** the first selected body's colour now, `#rrggbb` */
  initial: string;
  /** some of the selection has a colour of the player's (Use file colour has something to undo) */
  canReset: boolean;
  onApply: (hex: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(initial));
  const hex = hsvToHex(hsv);
  const [text, setText] = useState(hex);
  // the field follows the wheel and the slider, except while it is being typed in
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setText(hex);
  }, [hex]);
  const typed = parseHex(text);
  const swatch = (c: string): CSSProperties => ({ ['--ri-swatch' as string]: c }) as CSSProperties;
  return (
    <Shell
      title={COPY.colorTitle(count)}
      onClose={onClose}
      actions={
        <>
          {canReset ? (
            <button type="button" className="ds-btn ghost" onClick={onReset}>
              {COPY.colorReset}
            </button>
          ) : null}
          <button type="button" className="ds-btn ghost" data-padnav-back onClick={onClose}>
            {PAGE_COPY.cancel}
          </button>
          <button type="button" className="ds-btn primary" onClick={() => onApply(hex)}>
            {COPY.colorApply}
          </button>
        </>
      }
    >
      <div className="ds-import-color">
        <Wheel hsv={hsv} onPick={(h, s) => setHsv((c) => ({ ...c, h, s }))} />
        <label className="ds-field">
          <span className="cap">
            {COPY.colorBrightness} <span className="val">{Math.round(hsv.v * 100)}%</span>
          </span>
          <input
            className="ds-range"
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(hsv.v * 100)}
            style={rangeFill(hsv.v * 100, 0, 100)}
            onChange={(e) => setHsv((c) => ({ ...c, v: Number(e.target.value) / 100 }))}
          />
        </label>
        <div className="ds-import-colorrow">
          <label className="ds-field">
            <span className="cap">{COPY.colorHex}</span>
            <input
              className="ds-input"
              type="text"
              maxLength={7}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!typed}
              value={text}
              onFocus={() => (typing.current = true)}
              onBlur={() => {
                typing.current = false;
                setText(hex);
              }}
              onChange={(e) => {
                setText(e.target.value);
                const h = parseHex(e.target.value);
                if (h) setHsv((c) => hexToHsv(h, c.h));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && typed) {
                  e.preventDefault();
                  onApply(typed);
                }
              }}
            />
          </label>
          <div className="ds-import-swatches" aria-hidden="true">
            <span className="ds-import-swatch" style={swatch(initial)} title={COPY.colorWas} />
            <span className="ds-import-swatch" style={swatch(hex)} title={COPY.colorNew} />
          </div>
        </div>
      </div>
    </Shell>
  );
}
