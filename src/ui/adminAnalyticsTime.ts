/**
 * THE ANALYTICS TAB'S CLOCK: every range, bucket and label in UTC.
 *
 * The server buckets in UTC days and hours, the daily rollups are UTC days, and the imported
 * Vercel history is whole UTC days, so a day on this page can only ever be a UTC day. The page
 * used to pick ranges on the operator's LOCAL calendar and label some charts in local time and
 * others in UTC, so an evening in New York showed tomorrow's date (owner, 2026-11-01: "sometimes
 * it records stuff in the future in my time"). Everything here is UTC and says so.
 *
 * DOM-free, so `npm test` imports it.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export type Grain = 'hour' | 'day';
export type PresetId = '24h' | '7d' | '30d' | '90d' | 'month';

export interface Span {
  from: Date;
  to: Date;
  grain: Grain;
}

/** `YYYY-MM-DD` of the UTC day holding `ms` */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** the instant a `YYYY-MM-DD` UTC day starts */
export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

const floorTo = (ms: number, size: number): number => Math.floor(ms / size) * size;

/**
 * A PRESET, ALIGNED TO UTC BUCKETS. "7 days" is today and the six UTC days before it, from
 * midnight; it used to be the last 168 hours, whose first and last day buckets were both
 * partial, so every daily chart began and ended on a dip. "24 hours" is the current hour and
 * the 23 before it. `to` is now: the last bucket is the one still filling.
 */
export function presetSpan(id: PresetId, now: number): Span {
  const end = new Date(now);
  if (id === '24h') return { from: new Date(floorTo(now, HOUR_MS) - 23 * HOUR_MS), to: end, grain: 'hour' };
  if (id === 'month') {
    const d = new Date(now);
    return {
      from: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)),
      to: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)),
      grain: 'day',
    };
  }
  const days = id === '7d' ? 7 : id === '30d' ? 30 : 90;
  return { from: new Date(floorTo(now, DAY_MS) - (days - 1) * DAY_MS), to: end, grain: 'day' };
}

/** two picked UTC days, both inclusive. Two days or fewer are drawn by the hour. */
export function customSpan(fromDay: string, toDay: string): Span {
  const a = dayStart(fromDay);
  const b = dayStart(toDay) + DAY_MS; // an end DAY is inclusive to a person and exclusive to SQL
  return { from: new Date(a), to: new Date(b), grain: b - a <= 2 * DAY_MS ? 'hour' : 'day' };
}

/** every bucket start in `[from, to)`, as the ISO instant the server names it by */
export function bucketsOf(from: Date, to: Date, grain: Grain): string[] {
  const size = grain === 'hour' ? HOUR_MS : DAY_MS;
  const out: string[] = [];
  // a range of years at hour grain is not something this page asks for; the cap is a seatbelt
  for (let t = floorTo(from.getTime(), size); t < to.getTime() && out.length < 5000; t += size) {
    out.push(new Date(t).toISOString());
  }
  return out;
}

/** every UTC day in `[from, to)` as `YYYY-MM-DD` */
export function daysOf(from: Date, to: Date): string[] {
  return bucketsOf(from, to, 'day').map((t) => t.slice(0, 10));
}

/**
 * A SERIES WITH EVERY BUCKET IN IT. The server returns only the buckets that had traffic, and
 * the chart spaced whatever came back evenly, so a quiet night vanished and the hours either
 * side of it were drawn as neighbours.
 */
export function fillSeries<T extends { t: string }>(points: T[], span: Span, grain: Grain, zero: (t: string) => T): T[] {
  const byT = new Map(points.map((p) => [new Date(p.t).toISOString(), p]));
  return bucketsOf(span.from, span.to, grain).map((t) => byT.get(t) ?? zero(t));
}

/** is the bucket starting at `t` still filling, i.e. does the range end inside it */
export function isPartial(t: string, grain: Grain, to: Date): boolean {
  return Date.parse(t) + (grain === 'hour' ? HOUR_MS : DAY_MS) > to.getTime();
}

// ---- labels -----------------------------------------------------------------

const fmtDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtDayYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fmtMonth = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const pad = (n: number): string => String(n).padStart(2, '0');

/** "Oct 31" */
export function dayLabel(t: string | number): string {
  return fmtDay.format(new Date(typeof t === 'string' && t.length === 10 ? dayStart(t) : t));
}

/** "Oct 31, 2026" */
export function dayYearLabel(t: string | number): string {
  return fmtDayYear.format(new Date(typeof t === 'string' && t.length === 10 ? dayStart(t) : t));
}

/** "14:00", on the 24-hour clock that UTC is always written in */
export function hourLabel(t: string | number): string {
  return `${pad(new Date(t).getUTCHours())}:00`;
}

/** "Oct 31, 14:05 UTC" */
export function instantLabel(ms: number): string {
  const d = new Date(ms);
  return `${fmtDay.format(d)}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "October 2026" */
export function monthLabel(ms: number): string {
  return fmtMonth.format(new Date(ms));
}

/**
 * THE RANGE IN WORDS, as the page states it under the toolbar: "Oct 26 – Nov 1, 07:40 UTC".
 * `to` is exclusive; a range ending on a midnight is named by its last whole day.
 */
export function spanLabel(span: Span): string {
  const to = span.to.getTime();
  const end = to % DAY_MS === 0 ? dayLabel(to - DAY_MS) : instantLabel(to);
  const start = span.grain === 'hour' ? instantLabel(span.from.getTime()) : dayLabel(span.from.getTime());
  return `${start} – ${end}${to % DAY_MS === 0 ? ' (UTC)' : ''}`;
}

// ---- the sponsor report's periods ------------------------------------------

export interface ReportPeriod {
  /** `YYYY-MM`, or the term's first day for the opening partial month */
  id: string;
  label: string;
  from: Date;
  to: Date;
  /** the month is not over yet */
  inProgress: boolean;
  /** the previous period, for month-over-month; null for the first */
  prev: { from: Date; to: Date; label: string } | null;
}

/**
 * ONE PERIOD PER CALENDAR MONTH OF THE TERM, newest first. The first runs from the term's start
 * (BIOBUZZ kickoff, 2026-09-12) to the end of that month; the last is the month in progress,
 * up to now. Nothing before the term or after it ends.
 */
export function reportPeriods(term: { from: string; until: string }, now: number): ReportPeriod[] {
  const start = dayStart(term.from);
  const until = Math.min(dayStart(term.until), now);
  if (!Number.isFinite(start) || !Number.isFinite(until) || until <= start) return [];
  const out: ReportPeriod[] = [];
  let a = start;
  while (a < until && out.length < 36) {
    const d = new Date(a);
    const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const b = Math.min(monthEnd, dayStart(term.until));
    const first = a === start && d.getUTCDate() !== 1;
    const label = first ? `${dayLabel(a)} – ${dayYearLabel(b - DAY_MS)}` : monthLabel(a);
    const prev = out[out.length - 1];
    out.push({
      id: first ? term.from : `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`,
      label,
      from: new Date(a),
      to: new Date(Math.min(b, now)),
      inProgress: now < b,
      prev: prev ? { from: prev.from, to: prev.to, label: prev.label } : null,
    });
    a = b;
  }
  return out.reverse();
}
