#!/usr/bin/env node
// Export Vercel Web Analytics for this project as DAILY AGGREGATES, so the history survives
// removing `@vercel/analytics`. Zero dependencies, read-only; the owner runs it.
//
//   VERCEL_TOKEN=… node scripts/vercel-analytics-export.mjs \
//     [--project dsim] [--team <teamId>] [--since 2026-09-01] [--until <today>] [--env production]
//     [--out scratch/vercel-analytics-production.json]
//
// Then load it with `scripts/import-vercel-analytics.ts` (see that file).
//
// Uses the public Web Analytics API (`/v1/query/web-analytics/{visits,events}/aggregate`). What
// it can give is what is written here: page views and daily-unique visitors per day, broken down
// by one dimension at a time, plus custom events by name and by each property. No sessions, no
// bounce rate, no cross-filters. Each breakdown keeps the top 100 values over the whole range and
// folds the rest into "Others", so a per-day row can be missing from a long tail.
//
// ⚠️ The API only answers inside the plan's REPORTING WINDOW, so run this before the oldest days
// age out. The token needs read access to the team that owns the project.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const TOKEN = process.env.VERCEL_TOKEN;
if (!TOKEN) {
  console.error('VERCEL_TOKEN is not set (vercel.com → Account → Tokens).');
  process.exit(2);
}
const PROJECT = opt('project', 'dsim');
const TEAM = opt('team', '');
const ENV = opt('env', 'production');
const SINCE = opt('since', '2026-07-01');
const UNTIL = opt('until', new Date().toISOString().slice(0, 10));
const OUT = opt('out', `scratch/vercel-analytics-${ENV}.json`);

const API = 'https://api.vercel.com/v1/query/web-analytics';

/** A day-grain query may span at most 62 days, so the range is walked in 60-day windows. */
const WINDOWS = [];
for (let a = new Date(`${SINCE}T00:00:00Z`); a <= new Date(`${UNTIL}T00:00:00Z`); ) {
  const b = new Date(Math.min(a.getTime() + 59 * 86_400_000, new Date(`${UNTIL}T00:00:00Z`).getTime()));
  WINDOWS.push([a.toISOString().slice(0, 10), b.toISOString().slice(0, 10)]);
  a = new Date(b.getTime() + 86_400_000);
}

async function get(dataset, by, filter) {
  const rows = [];
  for (const [since, until] of WINDOWS) rows.push(...(await getWindow(dataset, by, filter, since, until)));
  return rows;
}

async function getWindow(dataset, by, filter, since, until) {
  const p = new URLSearchParams({ projectId: PROJECT, since, until, limit: '100' });
  if (TEAM) p.set('teamId', TEAM);
  for (const b of by) p.append('by', b);
  // An explicit environment term replaces the API's production-only default.
  p.set('filter', [`environment eq '${ENV}'`, filter].filter(Boolean).join(' and '));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/${dataset}/aggregate?${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 10_000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`${dataset} by=${by.join(',')} → ${res.status} ${await res.text()}`);
    return (await res.json()).data;
  }
}

const day = (ts) => String(ts).slice(0, 10);

/** Vercel's dimension name → the key it comes back under in a row */
const VISIT_DIMS = [
  'requestPath',
  'route',
  'referrerHostname',
  'country',
  'deviceType',
  'osName',
  'browserName',
  'utmSource',
  'utmMedium',
  'utmCampaign',
];

const out = {
  source: 'vercel',
  project: PROJECT,
  environment: ENV,
  since: SINCE,
  until: UNTIL,
  exportedAt: new Date().toISOString(),
  visits: { total: [], by: {} },
  events: { byName: [], byProp: [] },
};

out.visits.total = (await get('visits', ['day'])).map((r) => ({ day: day(r.timestamp), pageviews: r.pageviews, visitors: r.visitors }));
out.unavailable = [];
for (const d of VISIT_DIMS) {
  let rows;
  try {
    rows = await get('visits', ['day', d]);
  } catch (e) {
    // UTM breakdowns are a paid add-on; a 402 means this plan never exposed them.
    if (!/→ 402 /.test(String(e))) throw e;
    out.unavailable.push(d);
    console.log(`visits by ${d}: not available on this plan`);
    continue;
  }
  out.visits.by[d] = rows
    .filter((r) => r.pageviews > 0)
    .map((r) => ({ day: day(r.timestamp), value: r[d] ?? null, pageviews: r.pageviews, visitors: r.visitors }));
  console.log(`visits by ${d}: ${out.visits.by[d].length} rows`);
}

const names = await get('events', ['day', 'eventName']);
out.events.byName = names
  .filter((r) => r.count > 0)
  .map((r) => ({ day: day(r.timestamp), name: r.eventName, count: r.count, visitors: r.visitors }));
console.log(`events by name: ${out.events.byName.length} rows`);

// Property keys are discovered rather than listed, so an event added later still comes along.
for (const name of [...new Set(out.events.byName.map((r) => r.name))].filter((n) => n && n !== 'Others')) {
  const q = `eventName eq '${name.replace(/'/g, "''")}'`;
  const keys = [...new Set((await get('events', ['eventData'], q)).map((r) => r.eventData))].filter((k) => k && k !== 'Others');
  for (const key of keys) {
    const safe = /^[A-Za-z0-9_]+$/.test(key) ? key : `'${key.replace(/'/g, "''")}'`;
    const rows = await get('events', ['day', `eventData/${safe}`], q);
    for (const r of rows) {
      // the value comes back under the dimension's own name, `eventData/<key>`
      const value = r[`eventData/${safe}`] ?? r[`eventData/${key}`] ?? null;
      if (r.count > 0) out.events.byProp.push({ day: day(r.timestamp), name, key, value, count: r.count, visitors: r.visitors });
    }
  }
  console.log(`event ${name}: ${keys.length} properties`);
}

const days = out.visits.total.filter((r) => r.pageviews > 0).map((r) => r.day);
out.firstDay = days[0] ?? null;
out.lastDay = days[days.length - 1] ?? null;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`wrote ${OUT}: ${out.firstDay} → ${out.lastDay}, ${out.visits.total.reduce((s, r) => s + r.pageviews, 0)} page views`);
