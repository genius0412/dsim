import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gameServerHttpUrl } from '../net/env';
import { getAuthToken } from '../lib/authClient';
import { GAME_IDS } from '../games/types';
import { SEASONS } from '../seasons';
import { SPONSOR_PLACEMENTS } from '../sponsor';
import { adminFail } from './adminCopy';
// The console's own CSV writer, with the BOM and the quoting every other export here uses.
import { downloadCsv } from './adminBits';
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

interface Totals {
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
}

interface Report {
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

/** "Sep 22" for a UTC day. The server's days are UTC, so they are named in UTC here too. */
function dayName(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

interface ProductReport {
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
}

async function adminGet<T>(path: string, params: URLSearchParams): Promise<T> {
  const base = gameServerHttpUrl();
  const token = await getAuthToken();
  if (!base || !token) throw new Error('Not signed in, or this build has no game server configured.');
  const res = await fetch(`${base}${path}?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (res.status === 403) throw new Error('This account is not an admin on this server.');
  if (!res.ok) throw new Error(`Server returned ${res.status}.`);
  return (await res.json()) as T;
}

// ---- ranges -----------------------------------------------------------------

const RANGES = [
  { id: '24h', label: '24 hours', hours: 24, grain: 'hour' as const },
  { id: '7d', label: '7 days', hours: 24 * 7, grain: 'day' as const },
  { id: '30d', label: '30 days', hours: 24 * 30, grain: 'day' as const },
  { id: '90d', label: '90 days', hours: 24 * 90, grain: 'day' as const },
  // the previous calendar month: the period the sponsor report is owed for
  { id: 'month', label: 'Last month', hours: 0, grain: 'day' as const },
  { id: 'custom', label: 'Custom', hours: 0, grain: 'day' as const },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

/** `YYYY-MM-DD` for a date input — local, because the operator picks days in their own week */
function dayInput(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** today, for an export filename. A file called `dsim-countries.csv` is the file that gets
 *  overwritten by next week's; the date is what makes a folder of them readable. */
const stamp = (): string => dayInput(new Date());

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

// ---- the page ---------------------------------------------------------------

export function AdminAnalytics() {
  const [rangeId, setRangeId] = useState<RangeId>('7d');
  const [fromDay, setFromDay] = useState(() => dayInput(new Date(Date.now() - 7 * 86_400_000)));
  const [toDay, setToDay] = useState(() => dayInput(new Date()));
  const [game, setGame] = useState('*');
  const [filters, setFilters] = useState<{ dim: string; val: string }[]>([]);
  const [auto, setAuto] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [product, setProduct] = useState<ProductReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  /** set once the first load has landed, so a refresh does not blank the page under the reader */
  const loadedOnce = useRef(false);

  const spec = RANGES.find((r) => r.id === rangeId) ?? RANGES[1];
  const { from, to, grain } = useMemo(() => {
    if (rangeId === 'custom') {
      const a = new Date(`${fromDay}T00:00:00`);
      const b = new Date(`${toDay}T00:00:00`);
      b.setDate(b.getDate() + 1); // an end DAY is inclusive to a person and exclusive to SQL
      const days = (b.getTime() - a.getTime()) / 86_400_000;
      return { from: a, to: b, grain: (days <= 2 ? 'hour' : 'day') as 'hour' | 'day' };
    }
    if (rangeId === 'month') {
      const n = new Date();
      return { from: new Date(n.getFullYear(), n.getMonth() - 1, 1), to: new Date(n.getFullYear(), n.getMonth(), 1), grain: 'day' as const };
    }
    const end = new Date();
    return { from: new Date(end.getTime() - spec.hours * 3_600_000), to: end, grain: spec.grain };
  }, [rangeId, fromDay, toDay, spec]);

  const params = useMemo(() => {
    const p = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), game, grain });
    for (const f of filters) p.append('f', `${f.dim}:${f.val}`);
    return p;
  }, [from, to, game, grain, filters]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      // The product half ignores the dimension filters — a country cannot narrow a ranked
      // distribution, because a rating is not traffic and the two share no key. It takes the
      // range and the game, which are the two terms that do mean something on both sides.
      const productParams = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), game });
      const [r, p] = await Promise.all([
        adminGet<Report>('/api/analytics', params),
        adminGet<ProductReport>('/api/analytics/product', productParams),
      ]);
      setReport(r);
      setProduct(p);
      setErr(null);
      loadedOnce.current = true;
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : adminFail('load the analytics'));
    } finally {
      setBusy(false);
    }
  }, [params, from, to, game]);

  useEffect(() => {
    void load();
  }, [load]);

  // AUTO-REFRESH IS OFF BY DEFAULT and the interval is a minute, not a second. Every tick is
  // eleven aggregate queries on compute that bills by the wall-clock minute it is kept awake
  // (`server/db/pool.ts`), and a page left open in a tab would otherwise pin it on by itself.
  useEffect(() => {
    if (!auto) return;
    // ...and a hidden tab skips its turn, the same rule `usePolled` follows
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, 60_000);
    return () => clearInterval(t);
  }, [auto, load]);

  const rows = (dim: string): BreakdownRow[] => report?.breakdowns.filter((b) => b.dim === dim) ?? [];
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
  const ownOnly = mixed && h?.ownFrom ? `from ${dayName(h.ownFrom)}` : undefined;
  /** the first chart bucket that is ours, when the chart shows both sources */
  const split = mixed && h?.ownFrom ? `${h.ownFrom}T00:00:00.000Z` : undefined;
  const shownGrain = report?.grain ?? grain;

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
        onRefresh={() => void load()}
      />

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
      {busy && !loadedOnce.current && <p className="ds-loading">Loading analytics…</p>}

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
                    ['bucket', 'views', 'visitors', 'source'],
                    report.series.map((s) => [s.t, s.views, s.visitors, split && s.t < split ? 'vercel' : 'dsim']),
                  )
                }
              >
                Export CSV
              </button>
            </div>
            <div className="ds-panel-body">
              <TimeSeries data={report.series} grain={shownGrain} split={split} />
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
                    total={rows(dim).reduce((s, r) => s + r.views, 0)}
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

      {product && <ProductSection data={product} />}

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
      History starts {dayName(h.start)}.
      {h.imported &&
        (h.ownFrom
          ? ` Before ${dayName(h.ownFrom)} the numbers are Vercel Web Analytics counts.`
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

// ---- the product half -------------------------------------------------------

/** group a flat day-keyed list into the ordered columns `Columns` draws */
function byDay<T extends { day: string }>(rows: T[], keyOf: (r: T) => string, valOf: (r: T) => number) {
  const days = [...new Set(rows.map((r) => r.day))].sort();
  return days.map((d) => {
    const mine = rows.filter((r) => r.day === d);
    const parts = new Map<string, number>();
    for (const r of mine) parts.set(keyOf(r), (parts.get(keyOf(r)) ?? 0) + valOf(r));
    return { label: d.slice(5), parts: [...parts].map(([key, value]) => ({ key, value })) };
  });
}

function ProductSection({ data }: { data: ProductReport }) {
  const matchKeys = useMemo(() => [...new Set(data.matches.map((m) => m.kind))].sort(), [data.matches]);
  const matchCols = useMemo(() => byDay(data.matches, (m) => m.kind, (m) => m.n), [data.matches]);
  const physics = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of data.matches) out.set(m.physics, (out.get(m.physics) ?? 0) + m.n);
    return [...out].map(([val, n]) => ({ val: val === '3d' ? '3D' : '2D', views: n, visitors: n }));
  }, [data.matches]);
  const perGame = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of data.matches) out.set(m.game, (out.get(m.game) ?? 0) + m.n);
    return [...out]
      .map(([val, n]) => ({ val: SEASONS.find((s) => s.key === val)?.name ?? val, views: n, visitors: n }))
      .sort((a, b) => b.views - a.views);
  }, [data.matches]);

  const regions = useMemo(() => [...new Set(data.concurrency.map((c) => c.region))].sort(), [data.concurrency]);
  const totalMatches = data.matches.reduce((s, m) => s + m.n, 0);
  const totalSignups = data.signups.reduce((s, r) => s + r.n, 0);

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
            <Columns cols={data.signups.map((s) => ({ label: s.day.slice(5), parts: [{ key: 'signups', value: s.n }] }))} keys={['signups']} />
          </div>
        </section>

        <section className="ds-panel an-panel">
          <div className="ds-panel-h">
            <h3 className="ds-panel-title">Accounts that played</h3>
          </div>
          <div className="ds-panel-body">
            <Legend keys={['returning', 'new']} />
            <Columns
              cols={data.active.map((a) => ({
                label: a.day.slice(5),
                parts: [
                  { key: 'returning', value: a.returning },
                  { key: 'new', value: Math.max(0, a.active - a.returning) },
                ],
              }))}
              keys={['returning', 'new']}
            />
          </div>
        </section>

        <section className="ds-panel an-panel">
          <div className="ds-panel-h">
            <h3 className="ds-panel-title">Ranked distribution</h3>
          </div>
          <div className="ds-panel-body">
            <Columns
              cols={data.ranked.map((r) => ({ label: String(r.bucket), parts: [{ key: r.game, value: r.n }] }))}
              keys={[...new Set(data.ranked.map((r) => r.game))]}
            />
            <p className="ds-hint">Live act only — a rating carries across a season reset and is wiped by an act reset.</p>
          </div>
        </section>

        <section className="ds-panel an-panel">
          <div className="ds-panel-h">
            <h3 className="ds-panel-title">Replays stored</h3>
            <span className="ds-count">{fmtBytes(data.replayBytes)}</span>
          </div>
          <div className="ds-panel-body">
            <Columns cols={data.replays.map((r) => ({ label: r.day.slice(5), parts: [{ key: 'replays', value: r.n }] }))} keys={['replays']} />
          </div>
        </section>

        <section className="ds-panel an-panel">
          <div className="ds-panel-h">
            <h3 className="ds-panel-title">Reports</h3>
          </div>
          <div className="ds-panel-body">
            <Legend keys={['actioned', 'open']} />
            <Columns
              cols={data.reports.map((r) => ({
                label: r.day.slice(5),
                parts: [
                  { key: 'actioned', value: r.actioned },
                  { key: 'open', value: Math.max(0, r.filed - r.actioned) },
                ],
              }))}
              keys={['actioned', 'open']}
            />
          </div>
        </section>

        <section className="ds-panel an-panel">
          <div className="ds-panel-h">
            <h3 className="ds-panel-title">Supporters</h3>
          </div>
          <div className="ds-panel-body">
            <Legend keys={['claimed', 'comped']} />
            <Columns
              cols={data.supporters.map((s) => ({
                label: s.day.slice(5),
                parts: [
                  { key: 'claimed', value: s.claimed },
                  { key: 'comped', value: s.granted },
                ],
              }))}
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
              downloadCsv(`dsim-concurrency-${stamp()}.csv`, ['day', 'region', 'peak', 'mean'], data.concurrency.map((c) => [c.day, c.region, c.peak, c.mean]))
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
        ) : (
          <div className="ds-panel-body">
            <Legend keys={regions} />
            <Columns
              cols={[...new Set(data.concurrency.map((c) => c.day))].sort().map((d) => ({
                label: d.slice(5),
                parts: regions.map((r) => ({ key: r, value: data.concurrency.find((c) => c.day === d && c.region === r)?.peak ?? 0 })),
              }))}
              keys={regions}
            />
            <p className="ds-hint">Peak simultaneous sockets per day, stacked by region.</p>
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
              downloadCsv(`dsim-retention-${stamp()}.csv`, ['cohort', 'size', 'd1', 'd7', 'd30'], data.retention.map((r) => [r.cohort, r.size, r.d1, r.d7, r.d30]))
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
                    <td>{r.cohort}</td>
                    <td className="num">{r.size}</td>
                    <td className="num">{r.size ? fmtPct((r.d1 / r.size) * 100) : '—'}</td>
                    <td className="num">{r.size ? fmtPct((r.d7 / r.size) * 100) : '—'}</td>
                    <td className="num">{r.size ? fmtPct((r.d30 / r.size) * 100) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
