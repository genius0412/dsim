import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gameServerHttpUrl } from '../net/env';
import { getAuthToken } from '../lib/authClient';
import { GAME_IDS } from '../games/types';
import { SEASONS } from '../seasons';
import { SPONSOR, SPONSOR_PLACEMENTS } from '../sponsor';
import { adminFail } from './adminCopy';
// The console's own CSV writer, with the BOM and the quoting every other export here uses.
import { downloadCsv } from './adminBits';
import { saveBlob } from './saveBlob';
import { SPONSOR_LOGO_LIGHT } from './sponsorAssets';
import {
  DAY_MS,
  customSpan,
  dayLabel,
  dayStart,
  daysOf,
  fillSeries,
  instantLabel,
  presetSpan,
  reportPeriods,
  spanLabel,
  utcDay,
  type ReportPeriod,
  type Span,
} from './adminAnalyticsTime';
import {
  BarList,
  Columns,
  Legend,
  Tile,
  TimeSeries,
  delta,
  fmt,
  fmtBytes,
  fmtDuration,
  fmtExact,
  fmtPct,
  type SeriesPoint,
} from './adminCharts';

/**
 * ANALYTICS — the admin console's traffic and product dashboard.
 *
 * ⚠️ THIS WHOLE FILE IS A LAZY CHUNK, loaded the first time an admin opens the tab and never
 * by anybody else. That is not an optimisation, it is the condition on the feature existing:
 * the client bundle is React plus Rapier 2D and nothing else (CLAUDE.md), `npm run bundleaudit`
 * ratchets every chunk, and a dashboard nobody but the operator opens has no business in the
 * bundle a player downloads to drive a robot. Same pattern, and the same reasoning, as
 * `GraphicsSection` in `src/ui/Configure.tsx`.
 *
 * WHAT IS ON THE PAGE AND WHY IT IS IN THIS ORDER:
 *
 *   1. the RANGE and the FILTERS, because every number below is a function of them;
 *   2. the TILES — the six numbers somebody opens this page to read;
 *   3. the time series, which is the one chart that answers "is it going up";
 *   4. the BREAKDOWNS, click-to-filter, because the next question after "is it going up" is
 *      always "where from";
 *   5. the EVENTS, which is the funnel;
 *   6. the PRODUCT half — matches, accounts, retention, ranked, moderation, money. None of it
 *      is in any third-party dashboard because none of it is traffic, and it is the half the
 *      owner actually asked for.
 *
 * ⚠️ A VISITOR COUNT OVER A RANGE IS A SUM OF DAILY UNIQUES, and the page says so in words
 * rather than leaving somebody to find out. The visitor key is salted per UTC day and the old
 * salt is destroyed (`server/analytics.ts`), so the same person on Monday and Tuesday is two
 * visitors and there is no version of this that is not. Stating it is the difference between a
 * known property and a wrong number.
 */

// ---- the wire ---------------------------------------------------------------
// The fetchers live HERE rather than in `src/net/api.ts` so they land in this lazy chunk with
// everything else they are used by. Nothing in the main bundle calls them.

export interface Totals {
  views: number;
  visitors: number;
  sessions: number;
  bounces: number;
  seconds: number;
}

interface BreakdownRow {
  dim: string;
  val: string;
  views: number;
  visitors: number;
  /** every view in this dimension, past the top 12 too; absent from an older server */
  total?: number;
}

export interface Report {
  source: 'raw' | 'aggregate';
  rawFloor: string;
  totals: Totals;
  previous: Totals;
  series: SeriesPoint[];
  breakdowns: BreakdownRow[];
  events: { name: string; views: number; visitors: number }[];
  eventProps: { name: string; key: string; val: string; views: number }[];
  online: number;
  /** first UTC day of this database's own traffic; absent from an older server */
  historyStart?: string | null;
  /** the grain `series` is at; a range reaching imported days comes back by day */
  grain?: 'hour' | 'day';
  /** which days are imported and how they entered the numbers; absent from an older server */
  history?: History;
}

type EventRow = { name: string; views: number; visitors: number };
type EventPropRow = { name: string; key: string; val: string; views: number };

/**
 * WHERE THE NUMBERS COME FROM (`HistoryInfo` in server/analytics.ts). Days before `ownFrom` are
 * Vercel Web Analytics' daily totals, from before DSIM counted itself; days from it on are ours.
 * The server folds them into every number the two share, and says what it could not fold in.
 */
interface History {
  start: string | null;
  ownFrom: string | null;
  imported: { source: string; firstDay: string; lastDay: string; channel: string } | null;
  inRange: boolean;
  traffic: 'all' | 'marginal' | 'none';
  events: boolean;
  why: 'game' | 'filter' | null;
  dims: string[];
}

export interface ProductReport {
  matches: { day: string; game: string; kind: string; mode: string; physics: string; n: number }[];
  signups: { day: string; n: number }[];
  active: { day: string; active: number; returning: number }[];
  retention: { cohort: string; size: number; d1: number; d7: number; d30: number }[];
  ranked: { game: string; bucket: number; n: number }[];
  replays: { day: string; n: number }[];
  replayBytes: number;
  reports: { day: string; filed: number; actioned: number }[];
  supporters: { day: string; claimed: number; granted: number }[];
  view: { view: string; n: number }[];
  concurrency: { day: string; region: string; peak: number; mean: number }[];
  /** the service-wide peak per day; absent from an older server */
  concurrencyTotal?: { day: string; peak: number }[];
}

/** a newer request from this page replaced this one (409), or the page aborted it */
class Superseded extends Error {}
const isSuperseded = (e: unknown): boolean => e instanceof Superseded || (e instanceof DOMException && e.name === 'AbortError');

async function adminGet<T>(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) throw new Error('Not signed in, or this build has no game server configured.');
  const res = await fetch(`${base}${path}?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal,
  });
  if (res.status === 409) throw new Superseded();
  if (res.status === 403) throw new Error('This account is not an admin on this server.');
  if (!res.ok) throw new Error(`Server returned ${res.status}.`);
  return (await res.json()) as T;
}

/**
 * ONE ID PER MOUNTED PAGE, sent as `lane`. The server keeps one live read per account, endpoint
 * and lane, and drops the queued queries of the one it replaces; with a lane per page, two open
 * tabs do not cancel each other.
 */
const newLane = (kind: string): string => `${kind}-${Math.random().toString(36).slice(2, 10)}`;

// ---- ranges -----------------------------------------------------------------

const RANGES = [
  { id: '24h', label: '24 hours', hours: 24, grain: 'hour' as const },
  { id: '7d', label: '7 days', hours: 24 * 7, grain: 'day' as const },
  { id: '30d', label: '30 days', hours: 24 * 30, grain: 'day' as const },
  { id: '90d', label: '90 days', hours: 24 * 90, grain: 'day' as const },
  // the previous UTC calendar month; the sponsor PDF has its own 12th-to-11th periods
  { id: 'month', label: 'Last month', hours: 0, grain: 'day' as const },
  { id: 'custom', label: 'Custom', hours: 0, grain: 'day' as const },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

/** the range a selection means right now. Presets are re-read at every load, so a refresh
 *  moves a rolling range forward instead of re-asking for the window it opened on. */
function spanFor(rangeId: RangeId, fromDay: string, toDay: string, now = Date.now()): Span {
  return rangeId === 'custom' ? customSpan(fromDay, toDay) : presetSpan(rangeId, now);
}

/** today (UTC), for an export filename. A file called `dsim-countries.csv` is the file that gets
 *  overwritten by next week's; the date is what makes a folder of them readable. */
const stamp = (): string => utcDay(Date.now());

const DIM_LABELS: Record<string, string> = {
  path: 'Pages',
  entry: 'Entry pages',
  ref: 'Referrers',
  utm_source: 'UTM source',
  utm_medium: 'UTM medium',
  utm_campaign: 'UTM campaign',
  country: 'Countries',
  device: 'Devices',
  os: 'Operating systems',
  browser: 'Browsers',
  screen: 'Screen sizes',
  lang: 'Languages',
  surface: 'Surface',
  channel: 'Build channel',
  build: 'Client build',
};

/** the dimensions a chip can be raised on. `entry` is a session fact with no row to filter. */
const FILTERABLE = new Set(Object.keys(DIM_LABELS).filter((d) => d !== 'entry'));

/**
 * A BLANK IS A VALUE, and every panel that can show one has to name it.
 *
 * "Direct" is the largest referrer on most sites and "Unknown" is a real answer for a country
 * we could not derive. Rendering either as an empty cell would make the most important row in
 * the table look like a bug.
 */
const BLANK_LABEL: Record<string, string> = {
  ref: 'Direct / none',
  country: 'Unknown',
  os: 'Unknown',
  browser: 'Unknown',
  lang: 'Unknown',
  screen: 'Unknown',
  device: 'Unknown',
  utm_source: 'None',
  utm_medium: 'None',
  utm_campaign: 'None',
  build: 'Unknown',
  game: 'No game',
};

const SCREEN_LABEL: Record<string, string> = {
  sm: 'Phone (under 480)',
  md: 'Small (480–767)',
  lg: 'Laptop (768–1279)',
  xl: 'Large (1280+)',
};

function labelFor(dim: string, val: string): string {
  if (!val) return BLANK_LABEL[dim] ?? '—';
  // the host's remainder past its top 100 values, on the imported days
  if (val === 'Others') return 'Other';
  if (dim === 'screen') return SCREEN_LABEL[val] ?? val;
  if (dim === 'surface') return val === 'electron' ? 'Desktop app' : 'Web';
  return val;
}

/// ---- the page ---------------------------------------------------------------

/** what a load produced, and for which selection and range */
interface View {
  key: string;
  span: Span;
  report: Report | null;
  product: ProductReport | null;
  at: number;
}

/**
 * THE LAST FEW ANSWERS, kept while the console is open. Switching 7 days → 30 days → 7 days
 * used to run the second 7-day load from scratch (~23 queries) and show the 30-day numbers
 * until it landed; a selection seen in the last two minutes now comes back at once, and
 * Refresh always reads again. Module scope, so leaving the tab and coming back keeps it.
 */
const CACHE = new Map<string, View>();
const CACHE_TTL_MS = 120_000;
const CACHE_MAX = 16;
function remember(v: View): void {
  CACHE.delete(v.key);
  CACHE.set(v.key, v);
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value as string);
}

/** how long a selection waits for the next click before it loads */
const SETTLE_MS = 150;

export function AdminAnalytics() {
  const [rangeId, setRangeId] = useState<RangeId>('7d');
  const [fromDay, setFromDay] = useState(() => utcDay(Date.now() - 6 * DAY_MS));
  const [toDay, setToDay] = useState(() => utcDay(Date.now()));
  const [game, setGame] = useState('*');
  const [filters, setFilters] = useState<{ dim: string; val: string }[]>([]);
  const [auto, setAuto] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  /** the most recent `load` — an older one landing after it is discarded */
  const loadSeq = useRef(0);
  const inflight = useRef<AbortController | null>(null);
  const lane = useMemo(() => newLane('dash'), []);

  const key = `${rangeId}|${rangeId === 'custom' ? `${fromDay}..${toDay}` : ''}|${game}|${filters.map((f) => `${f.dim}:${f.val}`).join(',')}`;

  const load = useCallback(
    async (force: boolean) => {
      // THE NEWEST REQUEST WINS. A few quick clicks start overlapping loads, and they can land
      // in any order: an older one arriving last painted numbers for a selection that was no
      // longer on screen. The older request is also ABORTED, and the server drops its queued
      // queries (`lane`), so three clicks no longer cost three dashboards' worth of database.
      const seq = ++loadSeq.current;
      inflight.current?.abort();
      inflight.current = null;
      const cached = CACHE.get(key);
      if (cached) setView(cached);
      if (cached && !force && Date.now() - cached.at < CACHE_TTL_MS) {
        setErr(null);
        setBusy(false);
        return;
      }
      const ctl = new AbortController();
      inflight.current = ctl;
      setBusy(true);
      const span = spanFor(rangeId, fromDay, toDay);
      const base = { from: span.from.toISOString(), to: span.to.toISOString(), game, lane };
      const params = new URLSearchParams({ ...base, grain: span.grain });
      for (const f of filters) params.append('f', `${f.dim}:${f.val}`);
      // The product half ignores the dimension filters — a country cannot narrow a ranked
      // distribution, because a rating is not traffic and the two share no key. It takes the
      // range and the game, which are the two terms that do mean something on both sides.
      const [r, p] = await Promise.allSettled([
        adminGet<Report>('/api/analytics', params, ctl.signal),
        adminGet<ProductReport>('/api/analytics/product', new URLSearchParams(base), ctl.signal),
      ]);
      if (seq !== loadSeq.current) return;
      inflight.current = null;
      setBusy(false);
      if ((r.status === 'rejected' && isSuperseded(r.reason)) || (p.status === 'rejected' && isSuperseded(p.reason))) return;
      // EACH HALF STANDS ON ITS OWN. One failing used to blank both, and the page said nothing
      // about which; now the half that answered is drawn and the error names the other.
      const report = r.status === 'fulfilled' ? r.value : (cached?.report ?? null);
      const product = p.status === 'fulfilled' ? p.value : (cached?.product ?? null);
      const next: View = { key, span, report, product, at: Date.now() };
      setView(next);
      if (r.status === 'fulfilled' && p.status === 'fulfilled') {
        remember(next);
        setErr(null);
        return;
      }
      if (r.status === 'rejected') console.warn('[analytics] traffic', r.reason);
      if (p.status === 'rejected') console.warn('[analytics] product', p.reason);
      const what =
        r.status === 'rejected' && p.status === 'rejected'
          ? 'load the analytics'
          : r.status === 'rejected'
            ? 'load the traffic numbers'
            : 'load the product numbers';
      setErr(`${adminFail(what)} Press Refresh to try again.`);
    },
    [key, rangeId, fromDay, toDay, game, filters, lane],
  );

  // A selection settles for SETTLE_MS before it loads: clicking across the range buttons on
  // the way to the one you wanted asks for that one only.
  useEffect(() => {
    const t = setTimeout(() => void load(false), SETTLE_MS);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => () => inflight.current?.abort(), []);

  // AUTO-REFRESH IS OFF BY DEFAULT and the interval is a minute, not a second. Every tick is
  // ~23 aggregate queries on compute that bills by the wall-clock minute it is kept awake
  // (`server/db/pool.ts`), and a page left open in a tab would otherwise pin it on by itself.
  useEffect(() => {
    if (!auto) return;
    // ...and a hidden tab skips its turn, the same rule `usePolled` follows
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load(true);
    }, 60_000);
    return () => clearInterval(t);
  }, [auto, load]);

  const report = view?.report ?? null;
  const product = view?.product ?? null;
  const stale = !!view && view.key !== key;
  const span = useMemo(() => view?.span ?? spanFor(rangeId, fromDay, toDay), [view, rangeId, fromDay, toDay]);

  const rows = (dim: string): BreakdownRow[] => report?.breakdowns.filter((b) => b.dim === dim) ?? [];
  /** a row's share is of EVERY view in the dimension, not of the twelve rows shown */
  const dimTotal = (dim: string): number => {
    const rs = rows(dim);
    return rs[0]?.total ?? rs.reduce((s, r) => s + r.views, 0);
  };
  const addFilter = (dim: string, val: string): void => {
    setFilters((f) => (f.some((x) => x.dim === dim) ? f.map((x) => (x.dim === dim ? { dim, val } : x)) : [...f, { dim, val }]));
  };
  const activeVal = (dim: string): string | null => filters.find((f) => f.dim === dim)?.val ?? null;

  const t = report?.totals;
  const prev = report?.previous;
  const bounceRate = t && t.sessions ? (t.bounces / t.sessions) * 100 : 0;
  const prevBounce = prev && prev.sessions ? (prev.bounces / prev.sessions) * 100 : 0;
  const avgSession = t && t.sessions ? t.seconds / t.sessions : 0;
  const prevAvg = prev && prev.sessions ? prev.seconds / prev.sessions : 0;

  // IMPORTED DAYS ARE IN THIS RANGE'S TRAFFIC. Anything the import never had (sessions, entry
  // pages, screens) then covers fewer days than the page views beside it, and says from when.
  const h = report?.history ?? null;
  const mixed = !!h && h.inRange && h.traffic !== 'none' && !!h.ownFrom;
  const ownOnly = mixed && h?.ownFrom ? `from ${dayLabel(h.ownFrom)}` : undefined;
  /** the first chart bucket that is ours, when the chart shows both sources */
  const split = mixed && h?.ownFrom ? `${h.ownFrom}T00:00:00.000Z` : undefined;
  const shownGrain = report?.grain ?? span.grain;
  const series = useMemo(
    () => (report ? fillSeries(report.series, span, shownGrain, (tt) => ({ t: tt, views: 0, visitors: 0 })) : []),
    [report, span, shownGrain],
  );

  return (
    <div className="an-root">
      <Toolbar
        rangeId={rangeId}
        setRangeId={setRangeId}
        fromDay={fromDay}
        setFromDay={setFromDay}
        toDay={toDay}
        setToDay={setToDay}
        game={game}
        setGame={setGame}
        auto={auto}
        setAuto={setAuto}
        busy={busy}
        onRefresh={() => void load(true)}
      />
      <p className="ds-hint" role="status">
        {stale ? 'Loading ' : ''}
        {spanLabel(spanFor(rangeId, fromDay, toDay))}
        {stale ? '…' : '.'} All times on this page are UTC
        {rangeId === 'month' || rangeId === 'custom' ? `; it is ${instantLabel(Date.now())} now.` : '.'}
      </p>

      {filters.length > 0 && (
        <div className="an-filters">
          <span className="an-filters-label">Filtered by</span>
          {filters.map((f) => (
            <button
              key={f.dim}
              type="button"
              className="an-chip"
              onClick={() => setFilters((xs) => xs.filter((x) => x.dim !== f.dim))}
            >
              {DIM_LABELS[f.dim] ?? f.dim}: <b>{labelFor(f.dim, f.val)}</b> <span aria-hidden="true">✕</span>
              <span className="ds-sr">Remove this filter</span>
            </button>
          ))}
          <button type="button" className="ds-btn ghost small" onClick={() => setFilters([])}>
            Clear all
          </button>
        </div>
      )}

      {err && (
        <p className="ds-hint err" role="status">
          {err}
        </p>
      )}
      {busy && !view && <p className="ds-loading">Loading analytics…</p>}

      {report && (
        <>
          {/* ⚠️ A PAGE OF ZEROS IS A CLAIM, and on this tier it is usually the wrong one. A
              range past the raw window is answered from `analytics_daily`, which is written by
              the hourly rollup — so a service younger than the range, or one whose rollup has
              not caught up, answers zero for every tile and draws no chart at all. Saying "read
              from the daily rollups" over that reads as "traffic collapsed". The two states get
              two different sentences. */}
          {report.source === 'aggregate' && (
            <p className="ds-hint warn" role="status">
              {t && t.views === 0 ? (
                <>
                  This range reaches past the 30 days of raw data, and the daily rollups hold
                  nothing for it. The service is younger than the range. Pick a shorter one to
                  read it exactly.
                </>
              ) : (
                <>
                  This range reaches further back than the 30 days of raw data, so it is read from
                  the daily rollups. Breakdowns and events still work; the filter chips do not, and
                  visitor counts are sums of daily uniques.
                </>
              )}
            </p>
          )}

          <HistoryNote history={h} historyStart={report.historyStart ?? null} />
          <div className="an-tiles">
            <Tile label="Visitors" value={fmt(t?.visitors ?? 0)} change={delta(t?.visitors ?? 0, prev?.visitors ?? 0)} sub="sum of daily uniques" />
            <Tile label="Page views" value={fmt(t?.views ?? 0)} change={delta(t?.views ?? 0, prev?.views ?? 0)} />
            <Tile label="Sessions" value={fmt(t?.sessions ?? 0)} change={delta(t?.sessions ?? 0, prev?.sessions ?? 0)} sub={ownOnly} />
            <Tile label="Bounce rate" value={fmtPct(bounceRate)} change={delta(bounceRate, prevBounce)} good="down" sub={ownOnly} />
            <Tile label="Avg. session" value={fmtDuration(avgSession)} change={delta(avgSession, prevAvg)} sub={ownOnly} />
            <Tile label="Online now" value={fmtExact(report.online)} good="none" sub="live sockets, every region" />
          </div>

          <section className="ds-panel">
            <div className="ds-panel-h">
              <h2 className="ds-panel-title">Traffic</h2>
              <button
                type="button"
                className="ds-btn ghost small"
                onClick={() =>
                  downloadCsv(
                    `dsim-traffic-${stamp()}.csv`,
                    ['bucket_utc', 'views', 'visitors', 'source'],
                    series.map((s) => [s.t, s.views, s.visitors, split && s.t < split ? 'vercel' : 'dsim']),
                  )
                }
              >
                Export CSV
              </button>
            </div>
            <div className="ds-panel-body">
              <TimeSeries data={series} grain={shownGrain} split={split} end={span.to} />
            </div>
          </section>

          <div className="an-grid">
            {Object.keys(DIM_LABELS).map((dim) => (
              <section key={dim} className="ds-panel an-panel">
                <div className="ds-panel-h">
                  <h2 className="ds-panel-title">
                    {DIM_LABELS[dim]}
                    {ownOnly && !h?.dims.includes(dim) && <span className="an-own"> {ownOnly}</span>}
                  </h2>
                  <button
                    type="button"
                    className="ds-btn ghost small"
                    onClick={() =>
                      downloadCsv(`dsim-${dim}-${stamp()}.csv`, [dim, 'views', 'visitors'], rows(dim).map((r) => [labelFor(dim, r.val), r.views, r.visitors]))
                    }
                  >
                    CSV
                  </button>
                </div>
                <div className="ds-panel-body">
                  <BarList
                    rows={rows(dim)}
                    total={dimTotal(dim)}
                    onPick={report.source === 'raw' && FILTERABLE.has(dim) ? (val) => addFilter(dim, val) : undefined}
                    active={activeVal(dim)}
                    labelOf={(v) => labelFor(dim, v)}
                    empty="No rows in this range."
                  />
                </div>
              </section>
            ))}
          </div>

          <EventsPanel events={report.events} props={report.eventProps} />

          <SponsorReport events={report.events} props={report.eventProps} sessions={t?.sessions ?? 0} sessionsFrom={ownOnly} />
        </>
      )}

      {product && <ProductSection data={product} span={span} />}

      <p className="ds-hint an-foot">
        Cookieless and identifier-free by construction. A visitor is a salted hash of the
        request that is thrown away with the salt every night, so nobody can be followed from one
        day to the next and a range total is a sum of daily uniques. Raw rows are kept 30 days;
        the aggregates behind longer ranges are kept indefinitely.
      </p>
    </div>
  );
}

// ---- toolbar ----------------------------------------------------------------

function Toolbar(props: {
  rangeId: RangeId;
  setRangeId: (r: RangeId) => void;
  fromDay: string;
  setFromDay: (v: string) => void;
  toDay: string;
  setToDay: (v: string) => void;
  game: string;
  setGame: (g: string) => void;
  auto: boolean;
  setAuto: (v: boolean) => void;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="an-bar">
      <div className="ds-segs" role="group" aria-label="Date range">
        {RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`ds-seg${props.rangeId === r.id ? ' on' : ''}`}
            aria-pressed={props.rangeId === r.id}
            onClick={() => props.setRangeId(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {props.rangeId === 'custom' && (
        <div className="an-dates">
          <label className="an-date">
            <span className="ds-sr">From</span>
            <input type="date" className="ds-input" value={props.fromDay} max={props.toDay} onChange={(e) => props.setFromDay(e.target.value)} />
          </label>
          <span className="an-dash" aria-hidden="true">→</span>
          <label className="an-date">
            <span className="ds-sr">To</span>
            <input type="date" className="ds-input" value={props.toDay} min={props.fromDay} onChange={(e) => props.setToDay(e.target.value)} />
          </label>
        </div>
      )}

      <label className="an-date">
        <span className="ds-sr">Game</span>
        <select className="ds-select" value={props.game} onChange={(e) => props.setGame(e.target.value)}>
          <option value="*">All games</option>
          {GAME_IDS.map((g) => (
            <option key={g} value={g}>
              {SEASONS.find((s) => s.key === g)?.name ?? g}
            </option>
          ))}
        </select>
      </label>

      <span className="an-bar-spacer" />

      <label className="ds-checkline">
        <input type="checkbox" checked={props.auto} onChange={(e) => props.setAuto(e.target.checked)} />
        <span>Auto-refresh</span>
      </label>
      <button
        type="button"
        className={`ds-btn small${props.busy ? ' busy' : ''}`}
        aria-busy={props.busy}
        disabled={props.busy}
        onClick={props.onRefresh}
      >
        Refresh
      </button>
    </div>
  );
}

// ---- events -----------------------------------------------------------------

/**
 * THE FUNNEL — the named events `src/analytics.ts` fires, with their property values nested
 * under them.
 *
 * A count on its own answers "did this happen" and almost never the question somebody arrived
 * with: `sponsor_shown` matters by PLACEMENT, `desktop_download` by OS, `support_claim_fail` by
 * REASON. The properties are already bounded at the ingest boundary, so showing them all is
 * bounded too.
 */
function EventsPanel({ events, props }: { events: EventRow[]; props: EventPropRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Events</h2>
        <button
          type="button"
          className="ds-btn ghost small"
          onClick={() => downloadCsv(`dsim-events-${stamp()}.csv`, ['event', 'count', 'visitors'], events.map((e) => [e.name, e.views, e.visitors]))}
        >
          Export CSV
        </button>
      </div>
      {events.length === 0 ? (
        <div className="ds-panel-body">
          <div className="ds-empty an-empty">
            <div className="big">No events yet</div>
            Nothing named was fired in this range.
          </div>
        </div>
      ) : (
        <div className="ds-table-scroll">
          <table className="ds-table an-table">
            <thead>
              <tr>
                <th>Event</th>
                <th className="num">Count</th>
                <th className="num">Visitors</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const detail = props.filter((p) => p.name === e.name);
                const isOpen = open === e.name;
                return (
                  // ⚠️ THE KEY GOES ON THE FRAGMENT, not on the first row inside it. The
                  // fragment IS the array element, so keying its child left every event row
                  // keyless: React warned on every render and re-created the expanded property
                  // sub-rows whenever the list re-ordered under a range change.
                  <Fragment key={e.name}>
                    <tr>
                      <td>{e.name}</td>
                      <td className="num">{fmtExact(e.views)}</td>
                      <td className="num">{fmtExact(e.visitors)}</td>
                      <td className="an-cell-act">
                        {detail.length > 0 && (
                          <button type="button" className="ds-btn ghost small" onClick={() => setOpen(isOpen ? null : e.name)}>
                            {isOpen ? 'Hide' : `${detail.length} properties`}
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen &&
                      detail.map((p) => (
                        <tr key={`${p.name}-${p.key}-${p.val}`} className="an-subrow">
                          <td>
                            <span className="an-prop-key">{p.key}</span> {p.val}
                          </td>
                          <td className="num">{fmtExact(p.views)}</td>
                          <td colSpan={2} />
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---- where the history starts -------------------------------------------------

/**
 * WHERE THE NUMBERS BEGIN, AND WHOSE THEY ARE. One line: the combined start, the day DSIM's own
 * count takes over from the imported one (the chart marks it), and, when this range reaches the
 * imported days, anything they could not be counted into.
 */
function HistoryNote({ history: h, historyStart }: { history: History | null; historyStart: string | null }) {
  if (!h) return historyStart ? <p className="ds-hint">First-party history starts {historyStart}.</p> : null;
  if (!h.start) return <p className="ds-hint">No traffic recorded yet.</p>;
  let left = '';
  if (h.imported && h.inRange && h.traffic === 'none') {
    left =
      h.why === 'game'
        ? ' Those days are left out here: Vercel did not split traffic by game.'
        : ' Those days are left out of the traffic numbers: Vercel’s counts can’t be filtered this way. Events still include them.';
  } else if (h.imported && h.inRange && h.traffic === 'marginal' && h.dims[0]) {
    left = ` With this filter, those days count in the totals, the chart and the ${DIM_LABELS[h.dims[0]] ?? h.dims[0]} panel.`;
  }
  return (
    <p className="ds-hint">
      History starts {dayLabel(h.start)}.
      {h.imported &&
        (h.ownFrom
          ? ` Before ${dayLabel(h.ownFrom)} the numbers are Vercel Web Analytics counts.`
          : ' These are Vercel Web Analytics counts.')}
      {left}
    </p>
  );
}

// ---- the sponsor report -------------------------------------------------------

/** the dwell buckets `sponsor_dwell` sends, shortest first */
const DWELL_ORDER = ['<5s', '5-15s', '15-60s', '1-5m', '5m+'];

/**
 * THE MONTHLY SPONSOR REPORT (`docs/sponsor.md`), laid out as its lines rather than left for
 * somebody to assemble from the events table. Pick "Last month" and export.
 *
 * Impressions and clicks are per placement; the dwell and format lines are distributions over
 * all placements, because each event property is counted on its own.
 */
function SponsorReport({
  events,
  props,
  sessions,
  sessionsFrom,
}: {
  events: EventRow[];
  props: EventPropRow[];
  sessions: number;
  /** "from Sep 22" when the range reaches imported days, which counted no sessions */
  sessionsFrom?: string;
}) {
  const count = (name: string): number => events.find((e) => e.name === name)?.views ?? 0;
  const values = (name: string, key: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const p of props) if (p.name === name && p.key === key) m.set(p.val, (m.get(p.val) ?? 0) + p.views);
    return m;
  };
  const shown = values('sponsor_shown', 'placement');
  const clicks = values('sponsor_click', 'placement');
  const known: string[] = [...SPONSOR_PLACEMENTS];
  const placements = [...known, ...[...shown.keys(), ...clicks.keys()].filter((p) => !known.includes(p))].filter(
    (p, i, all) => all.indexOf(p) === i && ((shown.get(p) ?? 0) > 0 || (clicks.get(p) ?? 0) > 0),
  );
  const dwellMap = values('sponsor_dwell', 'dwell');
  const dwell = [...DWELL_ORDER, ...[...dwellMap.keys()].filter((d) => !DWELL_ORDER.includes(d))]
    .filter((d) => dwellMap.has(d))
    .map((d) => ({ val: d, views: dwellMap.get(d) ?? 0, visitors: 0 }));
  const formats = [...values('sponsor_shown', 'format')].map(([val, n]) => ({ val, views: n, visitors: 0 }));
  const oses = [...values('desktop_download', 'os')].map(([val, n]) => ({ val, views: n, visitors: 0 }));
  const ctr = (c: number, s: number): string => (s ? fmtPct((c / s) * 100) : '—');

  const lines: [string, string, number | string][] = [
    ...placements.map((p): [string, string, number] => ['impressions', p, shown.get(p) ?? 0]),
    ['impressions', 'all', count('sponsor_shown')],
    ...placements.map((p): [string, string, number] => ['clicks', p, clicks.get(p) ?? 0]),
    ['clicks', 'all', count('sponsor_click')],
    ...dwell.map((d): [string, string, number] => ['time on screen', d.val, d.views]),
    ...formats.map((f): [string, string, number] => ['videos with the mark', f.val, f.views]),
    ...oses.map((o): [string, string, number] => ['desktop downloads', o.val, o.views]),
    ['sessions', sessionsFrom ? `site, ${sessionsFrom}` : 'site', sessions],
    ['new players', 'player_joined', count('player_joined')],
  ];

  return (
    <section className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Sponsor report</h2>
        <button
          type="button"
          className="ds-btn ghost small"
          onClick={() => downloadCsv(`dsim-sponsor-${stamp()}.csv`, ['line', 'breakdown', 'value'], lines)}
        >
          Export CSV
        </button>
      </div>
      <MonthlyReport />
      {count('sponsor_shown') === 0 && count('sponsor_click') === 0 ? (
        <div className="ds-panel-body">
          <div className="ds-empty an-empty">
            <div className="big">No sponsor events</div>
            Nothing from a sponsor placement was recorded in this range.
          </div>
        </div>
      ) : (
        <>
          <div className="ds-table-scroll">
            <table className="ds-table an-table">
              <thead>
                <tr>
                  <th>Placement</th>
                  <th className="num">Impressions</th>
                  <th className="num">Clicks</th>
                  <th className="num">Click-through</th>
                </tr>
              </thead>
              <tbody>
                {placements.map((p) => (
                  <tr key={p}>
                    <td>{p}</td>
                    <td className="num">{fmtExact(shown.get(p) ?? 0)}</td>
                    <td className="num">{fmtExact(clicks.get(p) ?? 0)}</td>
                    <td className="num">{ctr(clicks.get(p) ?? 0, shown.get(p) ?? 0)}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <b>All placements</b>
                  </td>
                  <td className="num">{fmtExact(count('sponsor_shown'))}</td>
                  <td className="num">{fmtExact(count('sponsor_click'))}</td>
                  <td className="num">{ctr(count('sponsor_click'), count('sponsor_shown'))}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="ds-panel-body">
            <div className="an-grid">
              <div>
                <h3 className="ds-panel-title">Time on screen</h3>
                <BarList rows={dwell} total={dwell.reduce((s, r) => s + r.views, 0)} empty="No dwell recorded." />
              </div>
              <div>
                <h3 className="ds-panel-title">Videos with the mark</h3>
                <BarList rows={formats} total={formats.reduce((s, r) => s + r.views, 0)} empty="No exports in this range." />
              </div>
              <div>
                <h3 className="ds-panel-title">Desktop downloads</h3>
                <BarList rows={oses} total={oses.reduce((s, r) => s + r.views, 0)} empty="No downloads in this range." />
              </div>
            </div>
            <p className="ds-hint">
              Sessions: {fmtExact(sessions)}
              {sessionsFrom && ` (${sessionsFrom})`}.{' '}
              New players: {fmtExact(count('player_joined'))}. An impression is a view of at least half the mark
              for one second; videos are files exported, not views of them.
            </p>
          </div>
        </>
      )}
    </section>
  );
}

// ---- the monthly PDF ----------------------------------------------------------

/** the events the PDF draws per day; the server answers for these and no others */
const DAILY_EVENTS = 'sponsor_shown,sponsor_click,player_joined,desktop_download';

/**
 * THE MONTHLY REPORT, AS A FILE TO SEND. One period per sponsor month, the 12th to the 11th
 * (`SPONSOR.term` opened at BIOBUZZ kickoff on 2026-09-12), read on its own, independent of the
 * range picked above, so the report for a month is the same whoever downloads it and whenever.
 * The PDF writer and the layout are a separate lazy chunk (`AdminSponsorPdf`), fetched on the
 * first press.
 */
function MonthlyReport() {
  const periods = useMemo(() => reportPeriods(SPONSOR.term, Date.now()), []);
  // the newest FINISHED period by default: the in-progress one is there, marked, but a report
  // that is sent is almost always the last whole one
  const [id, setId] = useState(() => (periods.find((p) => !p.inProgress) ?? periods[0])?.id ?? '');
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<{ text: string; err: boolean } | null>(null);
  if (!periods.length) return null;
  const period = periods.find((p) => p.id === id) ?? periods[0];

  const build = async (): Promise<void> => {
    setWorking(true);
    setNote({ text: `Building the ${period.label} report…`, err: false });
    try {
      const bytes = await sponsorReportBytes(period);
      saveBlob(new Blob([bytes], { type: 'application/pdf' }), `dsim-sponsor-report-${period.id}.pdf`);
      setNote({ text: `Saved dsim-sponsor-report-${period.id}.pdf.`, err: false });
    } catch (e) {
      console.warn('[analytics] sponsor report', e);
      setNote({ text: `${adminFail('build the report')} ${e instanceof Error ? e.message : ''}`.trim(), err: true });
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="ds-panel-body an-bar">
      <label className="an-date">
        <span>Monthly report</span>
        <select className="ds-select" value={period.id} onChange={(e) => setId(e.target.value)} disabled={working}>
          {periods.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.inProgress ? ' (so far)' : ''}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className={`ds-btn small${working ? ' busy' : ''}`} aria-busy={working} disabled={working} onClick={() => void build()}>
        Download PDF
      </button>
      {note && (
        <span className={`ds-hint${note.err ? ' err' : ''}`} role="status">
          {note.text}
        </span>
      )}
    </div>
  );
}

/** read one period's numbers and lay them out. Each read is its own request, one at a time. */
async function sponsorReportBytes(period: ReportPeriod): Promise<Uint8Array<ArrayBuffer>> {
  const lane = newLane('report');
  const range = (from: Date, to: Date): Record<string, string> => ({ from: from.toISOString(), to: to.toISOString(), game: '*', lane });
  const cur = await adminGet<Report>('/api/analytics', new URLSearchParams({ ...range(period.from, period.to), grain: 'day' }));
  const prevReport = period.prev
    ? await adminGet<Report>('/api/analytics', new URLSearchParams({ ...range(period.prev.from, period.prev.to), grain: 'day' }))
    : null;
  const product = await adminGet<ProductReport>('/api/analytics/product', new URLSearchParams(range(period.from, period.to))).catch((e: unknown) => {
    console.warn('[analytics] report product', e);
    return null;
  });
  // an older server has no daily breakdown (404); the report says so rather than failing
  const daily = await adminGet<{ days: { day: string; name: string; n: number }[] }>(
    '/api/analytics/events-daily',
    new URLSearchParams({ ...range(period.from, period.to), names: DAILY_EVENTS }),
  )
    .then((r) => r.days)
    .catch(() => null);
  const { sponsorReportPdf, logoJpeg } = await import('./AdminSponsorPdf');
  return sponsorReportPdf({
    period,
    prev: period.prev,
    sponsor: { name: SPONSOR.name, url: SPONSOR.url, campaign: 'biobuzz-2026' },
    placements: SPONSOR_PLACEMENTS,
    generatedAt: new Date(),
    cur,
    prevReport,
    product,
    daily,
    logo: await logoJpeg(SPONSOR_LOGO_LIGHT),
  });
}

// ---- the product half -------------------------------------------------------

/** every UTC day of the range, so a day with nothing on it is a zero column rather than no column */
function byDay<T extends { day: string }>(days: string[], rows: T[], keyOf: (r: T) => string, valOf: (r: T) => number) {
  const at = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const parts = at.get(r.day) ?? new Map<string, number>();
    parts.set(keyOf(r), (parts.get(keyOf(r)) ?? 0) + valOf(r));
    at.set(r.day, parts);
  }
  return days.map((d) => ({ label: dayLabel(d), parts: [...(at.get(d) ?? [])].map(([key, value]) => ({ key, value })) }));
}

const seasonName = (g: string): string => SEASONS.find((s) => s.key === g)?.name ?? g;

function ProductSection({ data, span }: { data: ProductReport; span: Span }) {
  const days = useMemo(() => daysOf(span.from, span.to), [span]);
  const matchKeys = useMemo(() => [...new Set(data.matches.map((m) => m.kind))].sort(), [data.matches]);
  const matchCols = useMemo(() => byDay(days, data.matches, (m) => m.kind, (m) => m.n), [days, data.matches]);
  const physics = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of data.matches) out.set(m.physics, (out.get(m.physics) ?? 0) + m.n);
    return [...out].map(([val, n]) => ({ val: val === '3d' ? '3D' : '2D', views: n, visitors: n }));
  }, [data.matches]);
  const perGame = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of data.matches) out.set(m.game, (out.get(m.game) ?? 0) + m.n);
    return [...out].map(([val, n]) => ({ val: seasonName(val), views: n, visitors: n })).sort((a, b) => b.views - a.views);
  }, [data.matches]);

  /**
   * THE RANKED DISTRIBUTION, ONE COLUMN PER 100 POINTS, games stacked in it. It was one column
   * per (game, bucket) row, so with all games picked the same "1200" appeared up to three times
   * side by side, and an empty bucket between two players closed up and drew the curve without
   * its gap.
   */
  const ranked = useMemo(() => {
    const games = [...new Set(data.ranked.map((r) => r.game))].sort();
    if (!data.ranked.length) return { games: [] as string[], cols: [] as { label: string; parts: { key: string; value: number }[] }[] };
    const lo = Math.min(...data.ranked.map((r) => r.bucket));
    const hi = Math.max(...data.ranked.map((r) => r.bucket));
    const cols = [];
    for (let b = lo; b <= hi && cols.length < 60; b += 100) {
      cols.push({
        label: String(b),
        parts: games.map((g) => ({ key: seasonName(g), value: data.ranked.find((r) => r.game === g && r.bucket === b)?.n ?? 0 })),
      });
    }
    return { games: games.map(seasonName), cols };
  }, [data.ranked]);
  const rankedTotal = data.ranked.reduce((s, r) => s + r.n, 0);

  /** a region's highest sample over the range, for the list under the service-wide chart */
  const regionPeaks = useMemo(() => {
    const out = new Map<string, number>();
    for (const c of data.concurrency) out.set(c.region, Math.max(out.get(c.region) ?? 0, c.peak));
    return [...out].map(([val, n]) => ({ val, views: n, visitors: n })).sort((a, b) => b.views - a.views);
  }, [data.concurrency]);
  const regions = useMemo(() => [...new Set(data.concurrency.map((c) => c.region))].sort(), [data.concurrency]);
  const totalPeak = data.concurrencyTotal?.length ? Math.max(...data.concurrencyTotal.map((c) => c.peak)) : null;

  const totalMatches = data.matches.reduce((s, m) => s + m.n, 0);
  const totalSignups = data.signups.reduce((s, r) => s + r.n, 0);
  const totalReplays = data.replays.reduce((s, r) => s + r.n, 0);
  const totalReports = data.reports.reduce((s, r) => s + r.filed, 0);
  const totalSupport = data.supporters.reduce((s, r) => s + r.claimed + r.granted, 0);
  const dayRow = <T extends { day: string }>(rows: T[]): Map<string, T> => new Map(rows.map((r) => [r.day, r]));
  const signups = dayRow(data.signups);
  const active = dayRow(data.active);
  const replays = dayRow(data.replays);
  const reports = dayRow(data.reports);
  const supporters = dayRow(data.supporters);

  /** a cohort younger than D days cannot have come back on day D yet: that is "—", not 0% */
  const now = Date.now();
  const reached = (cohort: string, d: number): boolean => now >= dayStart(cohort) + d * DAY_MS;

  return (
    <>
      <h2 className="ds-h2 an-h2">Product</h2>
      <p className="ds-sub an-sub">
        Read off the tables the game already writes. No extra column is recorded for any of it.
        Queue wait times, graphics tier and disconnect rates are missing because nothing stores
        them.
      </p>

      <div className="an-grid two">
        <section className="ds-panel an-panel">
          <div className="ds-panel-h">
            <h3 className="ds-panel-title">Matches played</h3>
            <span className="ds-count">{fmtExact(totalMatches)}</span>
          </div>
          <div className="ds-panel-body">
            <Legend keys={matchKeys} />
            <Columns cols={matchCols} keys={matchKeys} />
          </div>
        </section>

        <section className="ds-panel an-panel">
          <div className="ds-panel-h">
            <h3 className="ds-panel-title">Matches by game</h3>
          </div>
          <div className="ds-panel-body">
            <BarList rows={perGame} total={totalMatches} empty="No matches in this range." />
          </div>
        </section>

        <section className="ds-panel an-panel">
          <div className="ds-panel-h">
            <h3 className="ds-panel-title">Physics</h3>
          </div>
          <div className="ds-panel-body">
            <BarList rows={physics} total={totalMatches} empty="No matches in this range." />
          </div>
        </section>

        <section className="ds-panel an-panel">
          <div className="ds-panel-h">
            <h3 className="ds-panel-title">Practice view</h3>
          </div>
          <div className="ds-panel-body">
            <BarList
              rows={data.view.map((v) => ({ val: v.view === '3d' ? '3D scene' : v.view === '2d' ? '2D canvas' : 'Not recorded', views: v.n, visitors: v.n }))}
              total={data.view.reduce((s, v) => s + v.n, 0)}
              empty="No practice runs in this range."
            />
          </div>
        </section>

        <section className="ds-panel an-panel">
          <div className="ds-panel-h">
            <h3 className="ds-panel-title">Signups</h3>
            <span className="ds-count">{fmtExact(totalSignups)}</span>
          </div>
          <div className="ds-panel-body">
            <Columns cols={days.map((d) => ({ label: dayLabel(d), parts: [{ key: 'signups', value: signups.get(d)?.n ?? 0 }] }))} keys={['signups']} />
          </div>
        </section>

        <section className="ds-panel an-panel">
          <div className="ds-panel-h">
            <h3 className="ds-panel-title">Accounts that played</h3>
          </div>
          <div className="ds-panel-body">
            <Legend keys={['returning', 'new']} />
            <Columns
              cols={days.map((d) => {
                const a = active.get(d);
                return {
                  label: dayLabel(d),
                  parts: [
                    { key: 'returning', value: a?.returning ?? 0 },
                    { key: 'new', value: Math.max(0, (a?.active ?? 0) - (a?.returning ?? 0)) },
                  ],
                };
              })}
              keys={['returning', 'new']}
            />
          </div>
        </section>

        <section className="ds-panel an-panel">
          <div className="ds-panel-h">
            <h3 className="ds-panel-title">Ranked distribution</h3>
            <span className="ds-count">{fmtExact(rankedTotal)}</span>
          </div>
          <div className="ds-panel-body">
            <Legend keys={ranked.games} />
            <Columns cols={ranked.cols} keys={ranked.games} />
            <p className="ds-hint">Players per 100 rating points, live act only. A rating carries across a season reset and is wiped by an act reset.</p>
          </div>
        </section>

        <section className="ds-panel an-panel">
          <div className="ds-panel-h">
            <h3 className="ds-panel-title">Replays stored</h3>
            <span className="ds-count">
              {fmtExact(totalReplays)} · {fmtBytes(data.replayBytes)}
            </span>
          </div>
          <div className="ds-panel-body">
            <Columns cols={days.map((d) => ({ label: dayLabel(d), parts: [{ key: 'replays', value: replays.get(d)?.n ?? 0 }] }))} keys={['replays']} />
            <p className="ds-hint">Replays written per day. The size is the whole archive.</p>
          </div>
        </section>

        <section className="ds-panel an-panel">
          <div className="ds-panel-h">
            <h3 className="ds-panel-title">Reports</h3>
            <span className="ds-count">{fmtExact(totalReports)}</span>
          </div>
          <div className="ds-panel-body">
            <Legend keys={['actioned', 'open']} />
            <Columns
              cols={days.map((d) => {
                const r = reports.get(d);
                return {
                  label: dayLabel(d),
                  parts: [
                    { key: 'actioned', value: r?.actioned ?? 0 },
                    { key: 'open', value: Math.max(0, (r?.filed ?? 0) - (r?.actioned ?? 0)) },
                  ],
                };
              })}
              keys={['actioned', 'open']}
            />
          </div>
        </section>

        <section className="ds-panel an-panel">
          <div className="ds-panel-h">
            <h3 className="ds-panel-title">Supporters</h3>
            <span className="ds-count">{fmtExact(totalSupport)}</span>
          </div>
          <div className="ds-panel-body">
            <Legend keys={['claimed', 'comped']} />
            <Columns
              cols={days.map((d) => {
                const s = supporters.get(d);
                return {
                  label: dayLabel(d),
                  parts: [
                    { key: 'claimed', value: s?.claimed ?? 0 },
                    { key: 'comped', value: s?.granted ?? 0 },
                  ],
                };
              })}
              keys={['claimed', 'comped']}
            />
          </div>
        </section>
      </div>

      <section className="ds-panel">
        <div className="ds-panel-h">
          <h3 className="ds-panel-title">Concurrency</h3>
          <button
            type="button"
            className="ds-btn ghost small"
            onClick={() =>
              downloadCsv(`dsim-concurrency-${stamp()}.csv`, ['day_utc', 'region', 'peak', 'mean'], data.concurrency.map((c) => [c.day, c.region, c.peak, c.mean]))
            }
          >
            Export CSV
          </button>
        </div>
        {data.concurrency.length === 0 ? (
          <div className="ds-panel-body">
            <div className="ds-empty an-empty">
              <div className="big">Nothing sampled</div>
              Concurrency is sampled every five minutes while the service is busy, and an idle one
              writes nothing at all.
            </div>
          </div>
        ) : data.concurrencyTotal ? (
          <>
          <div className="ds-panel-body">
            {/* ONE SERIES: the most sockets online at one sample, every region added at that
                sample. Stacking each region's own daily peak added people online at different
                hours as if they were on at once, and the "total" over it summed the days too. */}
            <Columns
              cols={(() => {
                const peaks = dayRow(data.concurrencyTotal);
                return days.map((d) => ({ label: dayLabel(d), parts: [{ key: 'peak', value: peaks.get(d)?.peak ?? 0 }] }));
              })()}
              keys={['peak']}
            />
            <p className="ds-hint">
              The most people online at one moment each day, every region together
              {totalPeak != null ? `; ${fmtExact(totalPeak)} at the busiest` : ''}. Sampled every five minutes.
            </p>
          </div>
          <div className="ds-panel-body">
            <h4 className="ds-panel-title">Busiest moment per region</h4>
            <BarList rows={regionPeaks} total={0} empty="No regions sampled." />
          </div>
          </>
        ) : (
          <div className="ds-panel-body">
            <Legend keys={regions} />
            <Columns
              cols={days.map((d) => ({
                label: dayLabel(d),
                parts: regions.map((r) => ({ key: r, value: data.concurrency.find((c) => c.day === d && c.region === r)?.peak ?? 0 })),
              }))}
              keys={regions}
            />
            <p className="ds-hint">Each region’s own peak per day, stacked. This server is too old to add the regions at the same moment.</p>
          </div>
        )}
      </section>

      <section className="ds-panel">
        <div className="ds-panel-h">
          <h3 className="ds-panel-title">Retention</h3>
          <button
            type="button"
            className="ds-btn ghost small"
            onClick={() =>
              downloadCsv(`dsim-retention-${stamp()}.csv`, ['cohort_utc', 'size', 'd1', 'd7', 'd30'], data.retention.map((r) => [r.cohort, r.size, r.d1, r.d7, r.d30]))
            }
          >
            Export CSV
          </button>
        </div>
        {data.retention.length === 0 ? (
          <div className="ds-panel-body">
            <div className="ds-empty an-empty">
              <div className="big">No cohorts</div>
              Nobody signed up in this range.
            </div>
          </div>
        ) : (
          <>
            <div className="ds-table-scroll">
              <table className="ds-table an-table">
                <thead>
                  <tr>
                    <th>Signed up</th>
                    <th className="num">Accounts</th>
                    <th className="num">D1</th>
                    <th className="num">D7</th>
                    <th className="num">D30</th>
                  </tr>
                </thead>
                <tbody>
                  {data.retention.map((r) => (
                    <tr key={r.cohort}>
                      <td>{dayLabel(r.cohort)}</td>
                      <td className="num">{r.size}</td>
                      {([1, 7, 30] as const).map((d) => (
                        <td key={d} className="num">
                          {r.size && reached(r.cohort, d) ? fmtPct((r[`d${d}`] / r.size) * 100) : '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="ds-panel-body">
              <p className="ds-hint">Played again on or after that day. A dash is a cohort not that old yet.</p>
            </div>
          </>
        )}
      </section>
    </>
  );
}
