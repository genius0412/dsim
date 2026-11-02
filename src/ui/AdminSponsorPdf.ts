import type { ProductReport, Report } from './AdminAnalytics';
import { DAY_MS, dayLabel, daysOf, dayYearLabel, instantLabel } from './adminAnalyticsTime';
import { PdfDoc, hex, textWidth, wrapText, type PdfPage, type Rgb } from './pdfWriter';

/**
 * THE MONTHLY SPONSOR REPORT AS A PDF (`docs/sponsor.md`, "The monthly attribution report").
 *
 * Its own lazy chunk, loaded when somebody presses Download PDF and never otherwise. Everything
 * here is layout over numbers the dashboard already reads: `/api/analytics` for the month and the
 * month before, `/api/analytics/product`, and `/api/analytics/events-daily` for the per-day
 * sponsor events. No identifier is in any of them, so none can be in the file.
 *
 * DOM-free apart from `logoJpeg`, so `npm test` builds a report from fixed numbers.
 */

export interface SponsorReportInput {
  period: { label: string; from: Date; to: Date; inProgress: boolean };
  prev: { label: string; from: Date; to: Date } | null;
  sponsor: { name: string; url: string; campaign: string };
  placements: readonly string[];
  generatedAt: Date;
  cur: Report;
  prevReport: Report | null;
  product: ProductReport | null;
  /** named events per UTC day; null from a server too old to answer */
  daily: { day: string; name: string; n: number }[] | null;
  logo: { bytes: Uint8Array; w: number; h: number } | null;
}

// ---- page geometry and colour ----------------------------------------------

const W = 612; // US Letter
const H = 792;
const M = 48;
const CW = W - 2 * M;

const INK = hex('#191c1b');
const DIM = hex('#404945');
const MUT = hex('#5c645f');
const LINE = hex('#c0c9c4');
const TILE = hex('#f1f3f1');
const ACCENT = hex('#366758');
const VIZ = [hex('#1f9e89'), hex('#9061f9'), hex('#d97706'), hex('#d6409f')];
const UP = hex('#1f7a45');
const DOWN = hex('#ba1a1a');

const PLACEMENT_NAMES: Record<string, string> = {
  home: 'Home menu',
  footer: 'Site footer',
  game: 'In-game chip',
  download: 'Download page',
  splash: 'Desktop splash',
  replay: 'Exported replay videos',
  loading: 'Loading screen',
  strip: 'Banner strip',
};

// ---- numbers ----------------------------------------------------------------

const exact = (n: number): string => new Intl.NumberFormat('en-US').format(Math.round(n));
const pct = (v: number): string => (!Number.isFinite(v) ? '–' : v > 0 && v < 10 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`);
const ratio = (a: number, b: number): string => (b ? pct((a / b) * 100) : '–');

function regionName(code: string): string {
  if (!code) return 'Unknown';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---- the report ---------------------------------------------------------------

export function sponsorReportPdf(input: SponsorReportInput): Uint8Array<ArrayBuffer> {
  const { period, prev, cur, prevReport, product } = input;
  const doc = new PdfDoc(W, H, { title: `DSIM sponsorship report, ${period.label}`, created: input.generatedAt });
  if (input.logo) doc.setImage(input.logo.bytes, input.logo.w, input.logo.h);

  // -- the numbers every page draws from --
  const count = (r: Report | null, name: string): number => r?.events.find((e) => e.name === name)?.views ?? 0;
  const values = (r: Report | null, name: string, key: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const p of r?.eventProps ?? []) if (p.name === name && p.key === key) m.set(p.val, (m.get(p.val) ?? 0) + p.views);
    return m;
  };
  const shown = values(cur, 'sponsor_shown', 'placement');
  const clicks = values(cur, 'sponsor_click', 'placement');
  const known = [...input.placements];
  const placements = [...known, ...[...shown.keys(), ...clicks.keys()].filter((p) => !known.includes(p))].filter(
    (p, i, all) => all.indexOf(p) === i && ((shown.get(p) ?? 0) > 0 || (clicks.get(p) ?? 0) > 0),
  );
  const imp = count(cur, 'sponsor_shown');
  const clk = count(cur, 'sponsor_click');
  const prevImp = count(prevReport, 'sponsor_shown');
  const prevClk = count(prevReport, 'sponsor_click');
  const days = daysOf(period.from, period.to);
  const spanDays = (period.to.getTime() - period.from.getTime()) / DAY_MS;
  const prevDays = prev ? (prev.to.getTime() - prev.from.getTime()) / DAY_MS : 0;
  const sum = <T>(xs: T[] | undefined, f: (x: T) => number): number => (xs ?? []).reduce((s, x) => s + f(x), 0);
  const matches = sum(product?.matches, (m) => m.n);
  const signups = sum(product?.signups, (s) => s.n);
  const peak = product?.concurrencyTotal?.length
    ? Math.max(...product.concurrencyTotal.map((c) => c.peak))
    : Math.max(0, ...(product?.concurrency ?? []).map((c) => c.peak));

  /**
   * MONTH-OVER-MONTH, PER DAY. The periods are not the same length (12th to 11th runs 28 to 31
   * days, and the current one is partial), so totals are compared as daily rates.
   */
  // "Sep 12–Oct 11": it has to fit a tile
  const prevShort = prev ? shortPeriod(prev.from, prev.to) : '';
  // a period a few days old against a whole one is noise, not a trend
  const comparable = !!prev && !!prevReport && prevDays > 0 && spanDays >= 7;
  const change = (now: number, before: number): { text: string; color: Rgb } | null => {
    if (!comparable || !prev || !before) return null;
    const d = ((now / spanDays) / (before / prevDays) - 1) * 100;
    if (!Number.isFinite(d)) return null;
    const sign = d > 0.05 ? '+' : d < -0.05 ? '-' : '';
    return { text: `${sign}${pct(Math.abs(d))} a day vs ${prevShort}`, color: d > 0.05 ? UP : d < -0.05 ? DOWN : MUT };
  };
  const ctrChange = (): { text: string; color: Rgb } | null => {
    if (!comparable || !prevImp || !imp) return null;
    const d = (clk / imp - prevClk / prevImp) * 100;
    const sign = d > 0.005 ? '+' : d < -0.005 ? '-' : '';
    return { text: `${sign}${Math.abs(d).toFixed(2)} pts vs ${prevShort}`, color: d > 0.005 ? UP : d < -0.005 ? DOWN : MUT };
  };

  const hist = cur.history;
  const importedUntil = hist?.inRange && hist.ownFrom ? hist.ownFrom : null;

  // -- page 1: the summary --
  const p1 = doc.addPage();
  let y = header(p1, input);
  p1.text(M, y + 26, period.label, { size: 24, bold: true, color: INK });
  y += 44;
  const range = `${dayYearLabel(period.from.getTime())} – ${
    period.inProgress ? `${instantLabel(period.to.getTime())} (in progress)` : `${dayYearLabel(period.to.getTime() - DAY_MS)}, UTC`
  }`;
  p1.text(M, y, range, { size: 10, color: DIM });
  y += 14;
  p1.text(M, y, `${input.sponsor.name}, presenting sponsor of DSIM`, { size: 10, color: DIM });
  y += 22;

  const tw = (CW - 3 * 10) / 4;
  const tiles: [string, string, { text: string; color: Rgb } | null, string?][] = [
    ['Impressions', exact(imp), change(imp, prevImp)],
    ['Clicks', exact(clk), change(clk, prevClk)],
    ['Click-through rate', ratio(clk, imp), ctrChange()],
    ['Videos carrying the mark', exact(sum([...values(cur, 'sponsor_shown', 'format').values()], (n) => n)), null, 'files exported'],
    // the imported days counted no sessions, so a period that holds some cannot be compared
    ['Site sessions', exact(cur.totals.sessions), change(cur.totals.sessions, prevReport?.history?.inRange ? 0 : (prevReport?.totals.sessions ?? 0)), importedUntil ? `from ${dayLabel(importedUntil)}` : undefined],
    ['Visitors', exact(cur.totals.visitors), change(cur.totals.visitors, prevReport?.totals.visitors ?? 0), 'daily uniques, summed'],
    ['Page views', exact(cur.totals.views), change(cur.totals.views, prevReport?.totals.views ?? 0)],
    ['Desktop downloads', exact(count(cur, 'desktop_download')), change(count(cur, 'desktop_download'), count(prevReport, 'desktop_download'))],
    ['Matches played', product ? exact(matches) : '–', null],
    ['New accounts', product ? exact(signups) : '–', null],
    ['Peak players online', product ? exact(peak) : '–', null, 'at one moment'],
    ['New players (sign-up step)', exact(count(cur, 'player_joined')), change(count(cur, 'player_joined'), count(prevReport, 'player_joined'))],
  ];
  tiles.forEach(([label, value, ch, sub], i) => {
    tile(p1, M + (i % 4) * (tw + 10), y + Math.floor(i / 4) * 62, tw, 56, label, value, ch, sub);
  });
  y += 3 * 62 + 10;

  y = sectionTitle(p1, y, 'Impressions and clicks per day');
  const byDay = new Map<string, Map<string, number>>();
  for (const r of input.daily ?? []) {
    const m = byDay.get(r.day) ?? new Map<string, number>();
    m.set(r.name, (m.get(r.name) ?? 0) + r.n);
    byDay.set(r.day, m);
  }
  const dayVal = (day: string, name: string): number => byDay.get(day)?.get(name) ?? 0;
  if (input.daily) {
    columns(p1, M, y + 10, CW, 64, days.map((d) => dayVal(d, 'sponsor_shown')), days, VIZ[0], 'Impressions');
    y += 10 + 64 + 26;
    columns(p1, M, y, CW, 38, days.map((d) => dayVal(d, 'sponsor_click')), days, VIZ[1], 'Clicks');
    y += 38 + 26;
  } else {
    y = p1.paragraph(M, y + 9, CW, 'The game server this report was read from is too old to break events down by day.', { size: 9, color: MUT }) + 8;
  }

  y = sectionTitle(p1, y, 'By placement');
  table(
    p1,
    y,
    [
      { title: 'Placement', w: 196 },
      { title: 'Impressions', w: 80, right: true },
      { title: 'Share', w: 70, right: true },
      { title: 'Clicks', w: 80, right: true },
      { title: 'Click-through', w: 90, right: true },
    ],
    placements.length
      ? [
          ...placements.map((p) => [
            PLACEMENT_NAMES[p] ?? p,
            exact(shown.get(p) ?? 0),
            ratio(shown.get(p) ?? 0, imp),
            exact(clicks.get(p) ?? 0),
            ratio(clicks.get(p) ?? 0, shown.get(p) ?? 0),
          ]),
          ['All placements', exact(imp), imp ? '100%' : '–', exact(clk), ratio(clk, imp)],
        ]
      : [],
    { boldLast: true, rowH: 16, empty: 'No sponsor placement was seen or clicked in this period.' },
  );

  // -- page 2: exposure and audience --
  const p2 = doc.addPage();
  y = header(p2, input);
  y = sectionTitle(p2, y + 8, 'Time on screen');
  y = p2.paragraph(M, y + 8, CW, 'How long the mark stayed in view each time it was shown, across all placements.', { size: 9, color: MUT });
  const dwell = values(cur, 'sponsor_dwell', 'dwell');
  const DWELL = ['<5s', '5-15s', '15-60s', '1-5m', '5m+'];
  const dwellNames: Record<string, string> = { '<5s': 'Under 5 seconds', '5-15s': '5 to 15 seconds', '15-60s': '15 to 60 seconds', '1-5m': '1 to 5 minutes', '5m+': 'Over 5 minutes' };
  const dwellRows = [...DWELL, ...[...dwell.keys()].filter((k) => !DWELL.includes(k))].filter((k) => dwell.has(k)).map((k) => ({ label: dwellNames[k] ?? k, value: dwell.get(k) ?? 0 }));
  const leftW = (CW - 24) / 2;
  const yDwell = hbars(p2, M, y, leftW, dwellRows, VIZ[0], 'No time on screen was recorded.');
  const formats = [...values(cur, 'sponsor_shown', 'format')].map(([k, v]) => ({ label: k.toUpperCase(), value: v }));
  const oses = [...values(cur, 'desktop_download', 'os')].map(([k, v]) => ({ label: osName(k), value: v })).sort((a, b) => b.value - a.value);
  let yr = y;
  p2.text(M + leftW + 24, yr + 8, 'Replay videos exported with the mark', { size: 9, bold: true, color: DIM });
  yr = hbars(p2, M + leftW + 24, yr + 14, leftW, formats, VIZ[2], 'No videos were exported.');
  p2.text(M + leftW + 24, yr + 8, 'Desktop app downloads', { size: 9, bold: true, color: DIM });
  yr = hbars(p2, M + leftW + 24, yr + 14, leftW, oses, VIZ[3], 'No downloads.');
  y = Math.max(yDwell, yr) + 16;

  y = sectionTitle(p2, y, 'Site traffic per day');
  const series = new Map((cur.series ?? []).map((s) => [s.t.slice(0, 10), s]));
  columns(p2, M, y + 10, CW, 96, days.map((d) => series.get(d)?.views ?? 0), days, ACCENT, 'Page views', days.map((d) => series.get(d)?.visitors ?? 0));
  y += 10 + 96 + 22;
  legend(p2, M, y, [
    ['Page views', ACCENT, false],
    ['Visitors', VIZ[1], true],
  ]);
  y += 20;

  y = sectionTitle(p2, y, 'Audience');
  const dim = (d: string): { val: string; views: number; total?: number }[] => cur.breakdowns.filter((b) => b.dim === d);
  const share = (rows: { val: string; views: number; total?: number }[], name: (v: string) => string, n: number) => {
    const total = rows[0]?.total ?? rows.reduce((s, r) => s + r.views, 0);
    return rows.slice(0, n).map((r) => ({ label: name(r.val), value: r.views, total }));
  };
  const yA = y;
  p2.text(M, y + 8, 'Countries, by page views', { size: 9, bold: true, color: DIM });
  const yC = hbars(p2, M, y + 14, leftW, share(dim('country'), regionName, 8), VIZ[0], 'No country recorded.');
  p2.text(M + leftW + 24, yA + 8, 'Devices', { size: 9, bold: true, color: DIM });
  let yD = hbars(p2, M + leftW + 24, yA + 14, leftW, share(dim('device'), (v) => cap(v) || 'Unknown', 4), VIZ[1], 'No devices recorded.');
  p2.text(M + leftW + 24, yD + 8, 'Where visits came from', { size: 9, bold: true, color: DIM });
  yD = hbars(p2, M + leftW + 24, yD + 14, leftW, share(dim('ref'), (v) => v || 'Direct or none', 6), VIZ[2], 'No referrers recorded.');
  y = Math.max(yC, yD) + 6;
  const web = dim('surface').find((r) => r.val === 'web')?.views ?? 0;
  const app = dim('surface').find((r) => r.val === 'electron')?.views ?? 0;
  if (web + app > 0) {
    p2.paragraph(M, y + 6, CW, `Web ${ratio(web, web + app)} and the desktop app ${ratio(app, web + app)} of page views.`, { size: 9, color: MUT });
  }

  // -- page 3: engagement, and how it is counted --
  const p3 = doc.addPage();
  y = header(p3, input);
  y = sectionTitle(p3, y + 8, 'Players');
  if (product) {
    const perGame = new Map<string, number>();
    const perKind = new Map<string, number>();
    const perDay = new Map<string, number>();
    for (const m of product.matches) {
      perGame.set(m.game, (perGame.get(m.game) ?? 0) + m.n);
      perKind.set(m.kind, (perKind.get(m.kind) ?? 0) + m.n);
      perDay.set(m.day, (perDay.get(m.day) ?? 0) + m.n);
    }
    const GAME_NAMES: Record<string, string> = { decode: 'DECODE', chain: 'Chain Reaction', biobuzz: 'BIOBUZZ' };
    const KIND_NAMES: Record<string, string> = { ranked: 'Ranked matches', custom: 'Rooms', record: 'Record runs' };
    const active = product.active;
    const playerDays = sum(active, (a) => a.active);
    const best = active.reduce((b, a) => (a.active > (b?.active ?? -1) ? a : b), null as (typeof active)[number] | null);
    const sentences = [
      `${exact(matches)} matches and record runs were played.`,
      playerDays > 0 && best
        ? `On an average day ${exact(playerDays / Math.max(1, days.length))} signed-in accounts played; the busiest day was ${dayLabel(best.day)}, with ${exact(best.active)}.`
        : '',
      `${exact(signups)} accounts were created${peak > 0 ? `, and at the busiest moment ${exact(peak)} people were online at once` : ''}.`,
    ];
    y = p3.paragraph(M, y + 9, CW, sentences.filter(Boolean).join(' '), { size: 10, color: INK }) + 4;
    columns(p3, M, y + 10, CW, 80, days.map((d) => perDay.get(d) ?? 0), days, VIZ[0], 'Matches per day');
    y += 10 + 80 + 26;
    const yG = y;
    p3.text(M, y + 8, 'By game', { size: 9, bold: true, color: DIM });
    const games = [...perGame].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: GAME_NAMES[k] ?? k, value: v, total: matches }));
    const y1 = hbars(p3, M, y + 14, leftW, games, VIZ[0], 'No matches.');
    p3.text(M + leftW + 24, yG + 8, 'By kind', { size: 9, bold: true, color: DIM });
    const kinds = [...perKind].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: KIND_NAMES[k] ?? k, value: v, total: matches }));
    const y2 = hbars(p3, M + leftW + 24, yG + 14, leftW, kinds, VIZ[1], 'No matches.');
    y = Math.max(y1, y2) + 16;
  } else {
    y = p3.paragraph(M, y + 9, CW, 'Player numbers could not be read for this period.', { size: 9, color: MUT }) + 12;
  }

  y = sectionTitle(p3, y, 'How these numbers are counted') + 9;
  const notes = [
    'An impression is a view, not a page load: the mark has to be at least half on screen for one unbroken second, and a tab in the background counts as off screen. That is the MRC display standard.',
    'Click-through rate is clicks divided by impressions, per placement. A click is counted when it is made; arrivals on your site are yours to count. Every link carries utm_source=dsim, utm_medium=<placement> and utm_campaign=' +
      input.sponsor.campaign + '.',
    'Visitors are counted without cookies or identifiers, as a salted hash that changes every day, so the same person on two days counts twice. Sessions end after 30 idle minutes.',
    'Replay videos are files exported with the mark burned in. Views of those files after they are shared are not visible to us, so the count is a floor.',
    'The desktop app’s splash screen cannot report a view, so desktop downloads stand in for it. The loading screen shows the mark as a text link before any analytics loads; its clicks are visible only in your UTM numbers.',
    'New accounts and matches are counted from DSIM’s own database. "New players (sign-up step)" also counts older accounts finishing the newer username step once, so it reads higher than new accounts.',
    ...(comparable ? ['Month-over-month changes compare daily averages, because the periods differ in length.'] : []),
    ...(importedUntil
      ? [`Days before ${dayLabel(importedUntil)} were counted by Vercel Web Analytics, before DSIM counted its own traffic. Those days have page views, visitors and events but no sessions, so the sessions figure covers ${dayLabel(importedUntil)} onward. The two counters filter bots differently.`]
      : []),
    'All dates and times are UTC.',
  ];
  for (const n of notes) {
    p3.text(M, y, '•', { size: 9, color: MUT });
    y = p3.paragraph(M + 12, y, CW - 12, n, { size: 9, color: DIM, leading: 12.5 }) + 4;
  }

  // -- page 4: the days --
  const p4 = doc.addPage();
  y = header(p4, input);
  y = sectionTitle(p4, y + 8, 'Daily figures');
  table(
    p4,
    y,
    [
      { title: 'Day (UTC)', w: 116 },
      { title: 'Page views', w: 80, right: true },
      { title: 'Visitors', w: 80, right: true },
      { title: 'Impressions', w: 80, right: true },
      { title: 'Clicks', w: 70, right: true },
      { title: 'Matches', w: 90, right: true },
    ],
    [
      ...days.map((d) => [
        dayLabel(d),
        exact(series.get(d)?.views ?? 0),
        exact(series.get(d)?.visitors ?? 0),
        input.daily ? exact(dayVal(d, 'sponsor_shown')) : '–',
        input.daily ? exact(dayVal(d, 'sponsor_click')) : '–',
        product ? exact(sum(product.matches.filter((m) => m.day === d), (m) => m.n)) : '–',
      ]),
      [
        'Total',
        exact(sum(days, (d) => series.get(d)?.views ?? 0)),
        exact(sum(days, (d) => series.get(d)?.visitors ?? 0)),
        input.daily ? exact(sum(days, (d) => dayVal(d, 'sponsor_shown'))) : '–',
        input.daily ? exact(sum(days, (d) => dayVal(d, 'sponsor_click'))) : '–',
        product ? exact(matches) : '–',
      ],
    ],
    { rowH: 16, boldLast: true, empty: 'No days in this period.' },
  );

  // footers, now that the page count is known
  doc.pages.forEach((p, i) => {
    p.line(M, H - 40, W - M, H - 40, { color: LINE, width: 0.5 });
    p.text(M, H - 26, `DSIM sponsorship report · ${period.label}`, { size: 8, color: MUT });
    p.text(W - M, H - 26, `Generated ${instantLabel(input.generatedAt.getTime())} · page ${i + 1} of ${doc.pages.length}`, { size: 8, color: MUT, align: 'right' });
  });
  return doc.toBytes();
}

// ---- drawing pieces ---------------------------------------------------------

/** the band at the top of every page; returns the y under it */
function header(p: PdfPage, input: SponsorReportInput): number {
  p.text(M, M + 14, 'DSIM', { size: 18, bold: true, color: ACCENT });
  p.text(M + textWidth('DSIM', 18, true) + 8, M + 14, 'Sponsorship report', { size: 11, color: DIM });
  if (input.logo) {
    const h = 22;
    const w = (input.logo.w / input.logo.h) * h;
    p.image(W - M - w, M - 2, w, h);
  } else {
    p.text(W - M, M + 14, input.sponsor.name, { size: 11, bold: true, color: INK, align: 'right' });
  }
  p.line(M, M + 28, W - M, M + 28, { color: LINE, width: 0.75 });
  return M + 36;
}

function sectionTitle(p: PdfPage, y: number, title: string): number {
  p.text(M, y + 12, title, { size: 12, bold: true, color: INK });
  return y + 22;
}

function tile(p: PdfPage, x: number, y: number, w: number, h: number, label: string, value: string, ch: { text: string; color: Rgb } | null, sub?: string): void {
  p.rect(x, y, w, h, { fill: TILE });
  p.text(x + 8, y + 12, label.toUpperCase(), { size: 6.5, bold: true, color: MUT });
  p.text(x + 8, y + 31, value, { size: 16, bold: true, color: INK });
  const foot = ch?.text ?? sub ?? '';
  if (foot) {
    const line = wrapText(foot, w - 16, 6.5)[0];
    p.text(x + 8, y + 46, line, { size: 6.5, color: ch?.color ?? MUT });
  }
}

/**
 * Columns per day on one scale, with the top value and the day labels thinned to fit. An optional
 * second series is drawn as a line over them, on the SAME scale (visitors are a subset of views).
 */
function columns(p: PdfPage, x: number, y: number, w: number, h: number, vals: number[], days: string[], color: Rgb, name: string, line?: number[]): void {
  const top = Math.max(1, ...vals, ...(line ?? []));
  const left = 34;
  const iw = w - left;
  p.line(x + left, y + h, x + w, y + h, { color: LINE, width: 0.5 });
  p.line(x + left, y, x + w, y, { color: LINE, width: 0.25, dash: [2, 2] });
  p.text(x + left - 4, y + 3, exact(top), { size: 6.5, color: MUT, align: 'right' });
  p.text(x + left - 4, y + h, '0', { size: 6.5, color: MUT, align: 'right' });
  p.text(x + left, y - 4, name, { size: 7, color: MUT });
  const n = Math.max(1, vals.length);
  const slot = iw / n;
  const bw = Math.max(1, Math.min(slot * 0.72, 22));
  vals.forEach((v, i) => {
    const bh = (v / top) * h;
    if (bh > 0) p.rect(x + left + i * slot + (slot - bw) / 2, y + h - bh, bw, bh, { fill: color });
  });
  if (line) {
    p.polyline(
      line.map((v, i) => [x + left + i * slot + slot / 2, y + h - (v / top) * h]),
      { color: VIZ[1], width: 1.2, dash: [3, 2] },
    );
  }
  const every = Math.max(1, Math.ceil(n / 10));
  days.forEach((d, i) => {
    if (i % every === 0) p.text(x + left + i * slot + slot / 2, y + h + 10, dayLabel(d), { size: 6.5, color: MUT, align: 'center' });
  });
}

function legend(p: PdfPage, x: number, y: number, keys: [string, Rgb, boolean][]): void {
  let at = x + 34;
  for (const [name, color, dashed] of keys) {
    if (dashed) p.line(at, y - 3, at + 12, y - 3, { color, width: 1.2, dash: [3, 2] });
    else p.rect(at, y - 7, 10, 8, { fill: color });
    p.text(at + 16, y, name, { size: 7.5, color: DIM });
    at += 16 + textWidth(name, 7.5) + 18;
  }
}

/** a ranked list, each row with its bar, count and share; returns the y under it */
function hbars(p: PdfPage, x: number, y: number, w: number, rows: { label: string; value: number; total?: number }[], color: Rgb, empty: string): number {
  if (!rows.length) {
    p.text(x, y + 10, empty, { size: 8.5, color: MUT });
    return y + 20;
  }
  const total = rows[0].total ?? rows.reduce((s, r) => s + r.value, 0);
  const top = Math.max(1, ...rows.map((r) => r.value));
  const labelW = w * 0.42;
  const numW = 76;
  const barW = w - labelW - numW;
  for (const r of rows) {
    const label = wrapText(r.label, labelW - 6, 8.5)[0];
    p.text(x, y + 10, label, { size: 8.5, color: INK });
    p.rect(x + labelW, y + 3, barW, 8, { fill: TILE });
    if (r.value > 0) p.rect(x + labelW, y + 3, Math.max(0.5, (r.value / top) * barW), 8, { fill: color });
    p.text(x + w - 34, y + 10, exact(r.value), { size: 8.5, color: INK, align: 'right' });
    p.text(x + w, y + 10, ratio(r.value, total), { size: 7.5, color: MUT, align: 'right' });
    y += 15;
  }
  return y + 4;
}

function table(
  p: PdfPage,
  y: number,
  cols: { title: string; w: number; right?: boolean }[],
  rows: string[][],
  o: { boldLast?: boolean; rowH?: number; empty: string },
): number {
  const rowH = o.rowH ?? 18;
  let x = M;
  for (const c of cols) {
    p.text(c.right ? x + c.w - 6 : x + 6, y + 11, c.title.toUpperCase(), { size: 6.5, bold: true, color: MUT, align: c.right ? 'right' : 'left' });
    x += c.w;
  }
  y += 16;
  p.line(M, y, M + cols.reduce((s, c) => s + c.w, 0), y, { color: LINE, width: 0.75 });
  if (!rows.length) {
    p.text(M + 6, y + 14, o.empty, { size: 9, color: MUT });
    return y + 24;
  }
  rows.forEach((r, ri) => {
    const bold = !!o.boldLast && ri === rows.length - 1;
    if (ri % 2 === 1) p.rect(M, y, cols.reduce((s, c) => s + c.w, 0), rowH, { fill: hex('#f6f7f6') });
    let cx = M;
    r.forEach((cell, ci) => {
      const c = cols[ci];
      p.text(c.right ? cx + c.w - 6 : cx + 6, y + rowH - 6, cell, { size: 9, bold, color: INK, align: c.right ? 'right' : 'left' });
      cx += c.w;
    });
    y += rowH;
  });
  p.line(M, y, M + cols.reduce((s, c) => s + c.w, 0), y, { color: LINE, width: 0.5 });
  return y + 8;
}

/** "Sep 12–Oct 11", or "Sep 12–30" inside one month */
function shortPeriod(from: Date, to: Date): string {
  const last = new Date(to.getTime() - 1);
  return from.getUTCMonth() === last.getUTCMonth() ? `${dayLabel(from.getTime())}–${last.getUTCDate()}` : `${dayLabel(from.getTime())}–${dayLabel(last.getTime())}`;
}

function osName(v: string): string {
  return v === 'mac' ? 'macOS' : v === 'windows' ? 'Windows' : v === 'linux' ? 'Linux' : cap(v);
}

/**
 * THE SPONSOR'S LOGO AS A JPEG, flattened onto white. The report's pages are white, so the
 * on-light cut needs no transparency, and a JPEG goes into a PDF as its own bytes: no PNG decoder
 * and no compressor in this file. Null if it cannot be loaded, and the header prints the name.
 */
export async function logoJpeg(url: string): Promise<{ bytes: Uint8Array; w: number; h: number } | null> {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const h = 160;
    const w = Math.round((img.naturalWidth / img.naturalHeight) * h);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.92));
    return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()), w, h } : null;
  } catch {
    return null;
  }
}
