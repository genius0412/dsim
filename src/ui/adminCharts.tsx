import { useId, useMemo, useRef, useState } from 'react';

/**
 * THE CHARTS, hand-rolled in SVG.
 *
 * ⚠️ NO CHART LIBRARY, and that is a bundle decision rather than a preference. The CLIENT
 * bundle is React plus Rapier 2D and nothing else (CLAUDE.md), `npm run bundleaudit` ratchets
 * every chunk, and the smallest credible charting dependency is heavier than this whole
 * feature. What is actually needed here is five shapes over arrays of numbers, and five shapes
 * is less code than the adapter around a library would be.
 *
 * Everything in this file lives in the LAZY admin-analytics chunk — nothing imports it from
 * the main bundle — so it costs a player nothing at all.
 *
 * THE RULES EVERY CHART HERE FOLLOWS, because they are the ones an SVG chart gets wrong:
 *   · **Colour is never the only channel.** Each series is named in its own legend entry, and
 *     the tooltip prints the values rather than expecting a colour to be matched back.
 *   · **Every chart has a text equivalent.** `role="img"` with an `aria-label` that states the
 *     shape of the data, because a screen reader gets nothing from a `<path>`.
 *   · **Keyboard reaches the data.** The time series is focusable and the arrow keys walk its
 *     buckets, which is the same interaction the pointer gets.
 *   · **Tokens only.** No hex, no `rgb()`; `color-mix` against a token where a tint is needed,
 *     so both themes follow (`docs/ui-standard.md` §5).
 */

// ---- number formatting ------------------------------------------------------
// ONE set of formatters for the whole dashboard. A panel that prints `1200` beside one that
// prints `1.2k` reads as two products, and the misalignment is worse than either choice.

/** 1.2k / 3.4M — the compact form, for anything that shares a column with a bar */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return trim(n / 1_000_000) + 'M';
  if (abs >= 1_000) return trim(n / 1_000) + 'k';
  return String(Math.round(n));
}

/** one decimal, and no trailing `.0` — `1.2k`, never `1.0k` */
function trim(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** the exact number with thousands separators, for a tooltip or a title attribute */
export function fmtExact(n: number): string {
  return new Intl.NumberFormat().format(Math.round(n));
}

export function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `${v < 10 && v > 0 ? v.toFixed(1) : Math.round(v)}%`;
}

/** `2m 14s` — an average session length, never a bare count of seconds */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${trim(v)} ${units[i]}`;
}

/**
 * THE CHANGE AGAINST THE PREVIOUS PERIOD, as a signed percentage — or null.
 *
 * ⚠️ NULL WHEN THERE IS NOTHING TO COMPARE AGAINST. A period that starts from zero has no
 * percentage change: every product that renders `+∞%` or `+100%` there is stating a
 * measurement it did not make, and the honest cell is an em dash.
 */
export function delta(now: number, before: number): number | null {
  if (!before) return null;
  return ((now - before) / before) * 100;
}

// ---- the headline tile ------------------------------------------------------

/**
 * ⚠️ `good` IS A PROPERTY OF THE METRIC, NOT OF THE SIGN. Bounce rate falling is the good
 * direction and views falling is not, so a tile that coloured every `+` green would be wrong
 * about half the row — and this row has bounce rate in it.
 */
export function Tile({
  label,
  value,
  sub,
  change,
  good = 'up',
}: {
  label: string;
  value: string;
  sub?: string;
  change?: number | null;
  good?: 'up' | 'down' | 'none';
}) {
  const dir = change == null || Math.abs(change) < 0.05 ? 'flat' : change > 0 ? 'up' : 'down';
  const tone = good === 'none' || dir === 'flat' ? '' : dir === good ? ' up' : ' down';
  return (
    <div className="an-tile">
      <span className="an-tile-label">{label}</span>
      <span className="an-tile-value">{value}</span>
      <span className="an-tile-foot">
        {change == null ? (
          <span className="an-delta flat">—</span>
        ) : (
          <span className={`an-delta${tone}`}>
            {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '—'} {fmtPct(Math.abs(change))}
          </span>
        )}
        {sub && <span className="an-tile-sub">{sub}</span>}
      </span>
    </div>
  );
}

// ---- the time series --------------------------------------------------------

export interface SeriesPoint {
  t: string;
  views: number;
  visitors: number;
}

const W = 960;
const H = 220;
const PAD = { top: 12, right: 8, bottom: 22, left: 40 };

/**
 * VIEWS AS AN AREA, VISITORS AS A LINE, on one shared scale.
 *
 * One scale rather than two axes: visitors are a subset of views by definition, so the second
 * axis a dual-scale chart would need is a way to draw the smaller number ABOVE the larger one.
 * That is the single most common lie in an analytics chart and it is free to avoid here.
 *
 * `viewBox` with `preserveAspectRatio="none"` would stretch the stroke widths, so the chart
 * scales by its box and keeps its own coordinate system — which is also what makes it readable
 * at 375px without a second layout.
 */
export function TimeSeries({
  data,
  grain,
  split,
}: {
  data: SeriesPoint[];
  grain: 'hour' | 'day';
  /**
   * The first bucket counted by DSIM itself, when the buckets before it are Vercel Web
   * Analytics' imported days. A thin rule between the two marks the change of source.
   */
  split?: string;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);

  const { max, xs, area, viewLine, visitorLine, ticks } = useMemo(() => {
    const top = Math.max(1, ...data.map((d) => d.views));
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const base = PAD.top + innerH;
    const x = (i: number): number => PAD.left + (data.length < 2 ? innerW / 2 : (i / (data.length - 1)) * innerW);
    const y = (v: number): number => base - (v / top) * innerH;
    const path = (pick: (d: SeriesPoint) => number): string =>
      data.map((d, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(pick(d)).toFixed(1)}`).join(' ');
    const views = path((d) => d.views);
    return {
      max: top,
      xs: data.map((_, i) => x(i)),
      // the area is the views line closed down to the baseline at both ends
      area: data.length ? `M ${x(0).toFixed(1)} ${base} ${views.slice(1)} L ${x(data.length - 1).toFixed(1)} ${base} Z` : '',
      viewLine: views,
      visitorLine: path((d) => d.visitors),
      ticks: [0, 0.5, 1].map((f) => ({ v: top * f, y: base - f * innerH })),
    };
  }, [data]);

  // A day bucket is a UTC day, so it is named in UTC: in a local zone west of Greenwich its
  // midnight is the evening before, and every label read one day early.
  const label = (iso: string): string => {
    const d = new Date(iso);
    return grain === 'hour'
      ? d.toLocaleTimeString([], { hour: 'numeric' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };

  if (!data.length) return <div className="ds-empty an-empty"><div className="big">No traffic yet</div>Nothing was recorded in this range.</div>;

  const active = hover != null ? data[hover] : null;
  // the source boundary: halfway between the last imported bucket and the first of ours
  const firstOwn = split ? data.findIndex((d) => d.t >= split) : -1;
  const markX = firstOwn > 0 ? (xs[firstOwn - 1] + xs[firstOwn]) / 2 : null;
  const imported = (d: SeriesPoint): boolean => !!split && d.t < split;

  return (
    <div className="an-chart">
      <svg
        ref={ref}
        className="an-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        tabIndex={0}
        aria-label={`Page views and visitors, ${data.length} ${grain === 'hour' ? 'hours' : 'days'}, peaking at ${fmtExact(max)} views${markX != null ? `; Vercel Web Analytics counts before ${label(data[firstOwn].t)}` : ''}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = ref.current?.getBoundingClientRect();
          if (!box || !data.length) return;
          const px = ((e.clientX - box.left) / box.width) * W;
          let best = 0;
          for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - px) < Math.abs(xs[best] - px)) best = i;
          setHover(best);
        }}
        onFocus={() => setHover((h) => h ?? data.length - 1)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          setHover((h) => {
            const next = (h ?? data.length - 1) + (e.key === 'ArrowRight' ? 1 : -1);
            return Math.max(0, Math.min(data.length - 1, next));
          });
        }}
      >
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ds-accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--ds-accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            {/* `an-gridline`, NOT `an-grid` — that one is the breakdown panel grid, and two
                components sharing a container class is the `.ds-dl` bug CLAUDE.md records. */}
            <line className="an-gridline" x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} />
            <text className="an-axis" x={PAD.left - 6} y={t.y + 3} textAnchor="end">{fmt(t.v)}</text>
          </g>
        ))}
        {markX != null && (
          <g>
            <line className="an-mark" x1={markX} x2={markX} y1={PAD.top} y2={H - PAD.bottom} />
            {/* each label only where it has room, clear of the axis numbers on the left */}
            {markX - PAD.left > 56 && <text className="an-axis" x={markX - 4} y={PAD.top + 10} textAnchor="end">Vercel</text>}
            {W - PAD.right - markX > 40 && <text className="an-axis" x={markX + 4} y={PAD.top + 10} textAnchor="start">DSIM</text>}
          </g>
        )}
        <path d={area} fill={`url(#${id}-fill)`} />
        <path className="an-line views" d={viewLine} />
        <path className="an-line visitors" d={visitorLine} />
        {hover != null && (
          <line className="an-cursor" x1={xs[hover]} x2={xs[hover]} y1={PAD.top} y2={H - PAD.bottom} />
        )}
        {data.map((d, i) =>
          i % Math.ceil(data.length / 8) === 0 ? (
            <text key={d.t} className="an-axis" x={xs[i]} y={H - 6} textAnchor="middle">{label(d.t)}</text>
          ) : null,
        )}
      </svg>
      <div className="an-legend">
        <span className="an-key views">Page views</span>
        <span className="an-key visitors">Visitors</span>
      </div>
      {/* The tooltip is a normal element under the chart rather than a floating box: it never
          covers the data, it is readable at 375px, and `role="status"` means a keyboard user
          walking the buckets with the arrow keys hears each one. */}
      <p className="an-readout" role="status">
        {active
          ? `${new Date(active.t).toLocaleString([], grain === 'hour' ? { month: 'short', day: 'numeric', hour: 'numeric' } : { month: 'short', day: 'numeric', timeZone: 'UTC' })} · ${fmtExact(active.views)} views · ${fmtExact(active.visitors)} visitors${imported(active) ? ' · Vercel' : ''}`
          : 'Hover the chart, or focus it and use the arrow keys.'}
      </p>
    </div>
  );
}

// ---- the breakdown panel ----------------------------------------------------

export interface BarRow {
  val: string;
  views: number;
  visitors: number;
}

/**
 * A TOP-N TABLE WHERE THE BAR IS THE ROW'S OWN BACKGROUND.
 *
 * The bar is drawn behind the label instead of in a column of its own, which is the shape
 * every analytics product converged on for a good reason: it costs no horizontal space on a
 * phone, and the eye reads the ranking off the bar without the label moving.
 *
 * ⚠️ THE ROW IS A BUTTON WHEN IT CAN FILTER, AND A ROW WHEN IT CANNOT. `entry` has no
 * pageview column to filter on (`dimColumn` in `server/analytics.ts` says why), so its rows
 * are not made to look clickable — a control that does nothing is worse than no control.
 */
export function BarList({
  rows,
  total,
  onPick,
  active,
  empty,
  labelOf,
}: {
  rows: BarRow[];
  total: number;
  onPick?: (val: string) => void;
  active?: string | null;
  empty: string;
  labelOf?: (val: string) => string;
}) {
  if (!rows.length) return <div className="ds-empty an-empty"><div className="big">Nothing here</div>{empty}</div>;
  const top = Math.max(1, ...rows.map((r) => r.views));
  return (
    <ul className="an-bars">
      {rows.map((r) => {
        const share = total ? (r.views / total) * 100 : 0;
        const text = labelOf ? labelOf(r.val) : r.val || '—';
        const inner = (
          <>
            <span className="an-bar-fill" style={{ width: `${(r.views / top) * 100}%` }} aria-hidden="true" />
            <span className="an-bar-name">{text}</span>
            <span className="an-bar-share">{fmtPct(share)}</span>
            <span className="an-bar-num">{fmt(r.views)}</span>
          </>
        );
        const title = `${text} — ${fmtExact(r.views)} views, ${fmtExact(r.visitors)} visitors (${fmtPct(share)})`;
        return (
          <li key={r.val} className={`an-bar${active === r.val ? ' on' : ''}`}>
            {onPick ? (
              <button type="button" className="an-bar-hit" title={title} onClick={() => onPick(r.val)}>
                {inner}
              </button>
            ) : (
              <span className="an-bar-hit static" title={title}>{inner}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---- columns, for the product charts ---------------------------------------

export interface Column {
  label: string;
  /** one or more stacked parts, drawn bottom-up in the order given */
  parts: { key: string; value: number }[];
}

/** the four series colours, in order: the --ds-viz-* set, no alliance or status hue, each >=3:1 on the panel in both themes */
const SERIES = ['var(--ds-viz-1)', 'var(--ds-viz-2)', 'var(--ds-viz-3)', 'var(--ds-viz-4)'];

/**
 * A STACKED COLUMN CHART — matches per day by kind, signups, reports, replays.
 *
 * Stacked rather than grouped because the question is almost always "how much, and what was it
 * made of": grouped bars answer "which was bigger" instead, and at 30 columns on a phone they
 * are four one-pixel slivers each.
 *
 * `keys` is passed in rather than derived from the data so the colour a series gets does not
 * change when a day happens to contain no ranked matches.
 */
export function Columns({
  cols,
  keys,
  height = 160,
  format = fmt,
}: {
  cols: Column[];
  keys: string[];
  height?: number;
  format?: (n: number) => string;
}) {
  if (!cols.length) return <div className="ds-empty an-empty"><div className="big">No data</div>Nothing was recorded in this range.</div>;
  const totals = cols.map((c) => c.parts.reduce((s, p) => s + p.value, 0));
  const top = Math.max(1, ...totals);
  const grand = totals.reduce((s, v) => s + v, 0);
  return (
    <div className="an-cols" style={{ height: `${height}px` }}>
      {cols.map((c, i) => (
        <div
          key={c.label + i}
          className="an-col"
          title={`${c.label} — ${c.parts.filter((p) => p.value).map((p) => `${p.key}: ${format(p.value)}`).join(', ') || 'none'}`}
        >
          <span className="an-col-stack">
            {c.parts.map((p) => (
              p.value > 0 ? (
                <span
                  key={p.key}
                  className="an-col-part"
                  style={{
                    height: `${(p.value / top) * 100}%`,
                    background: SERIES[Math.max(0, keys.indexOf(p.key)) % SERIES.length],
                  }}
                />
              ) : null
            ))}
          </span>
          <span className="an-col-label">{c.label}</span>
        </div>
      ))}
      <span className="an-cols-total" aria-hidden="true">{format(grand)} total</span>
    </div>
  );
}

/** the legend that makes `Columns` readable — same order, same colours, named in words */
export function Legend({ keys }: { keys: string[] }) {
  return (
    <div className="an-legend">
      {keys.map((k, i) => (
        <span key={k} className="an-key">
          <span className="an-swatch" style={{ background: SERIES[i % SERIES.length] }} aria-hidden="true" />
          {k}
        </span>
      ))}
    </div>
  );
}

// CSV export is NOT here. `downloadCsv` already exists in `src/ui/adminBits.tsx`, with the
// BOM and the quoting the console's other exports rely on; a second copy in this file would be
// the beginning of two spellings of the same file format.
