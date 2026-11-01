#!/usr/bin/env node
/**
 * `node scripts/spill-video/plan.mjs <EVENT_CODE> [--season 2026] [--top 8]`
 *
 * Pull an event's played matches from FTCScout (https://ftcscout.org, public REST API, no key),
 * rank them by HIVE TIPS, and write `scripts/spill-video/data/<EVENT>/plan.json`. That file is
 * what `clips.mjs` cuts clips from and what `annotate.html` shows as the expected tip count.
 *
 * Why rank by tips and not score: a match is useful here only for its tips. Score is printed
 * beside it because high-scoring matches tend to have the clean, decisive tips.
 *
 * `offsetS` is each match's FMS start time minus the first match's. With the video time of the
 * first match's start (one number you read off the stream), `clips.mjs` turns it into a video
 * time for every match, as long as the stream ran without cuts between them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const event = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true);
if (!event) {
  console.error('usage: node scripts/spill-video/plan.mjs <EVENT_CODE> [--season 2026] [--top 8]');
  process.exit(2);
}
const season = Number(flag('season', '2026'));
const top = Number(flag('top', '8'));

const url = `https://api.ftcscout.org/rest/v1/events/${season}/${encodeURIComponent(event)}/matches`;
const res = await fetch(url);
if (!res.ok) {
  console.error(`FTCScout answered ${res.status} for ${url}`);
  process.exit(1);
}
const raw = await res.json();

const played = raw.filter((m) => m.hasBeenPlayed && m.scores && m.actualStartTime);
if (played.length === 0) {
  console.error(`No played matches with scores for ${event} (${season}) yet.`);
  process.exit(1);
}
const t0 = Math.min(...played.map((m) => Date.parse(m.actualStartTime)));
const side = (s) => ({
  tips: s.tips,
  autoTips: s.autoHiveTips,
  teleopTips: s.dcHiveTips,
  points: s.totalPoints,
});
const label = (m) => `${m.tournamentLevel === 'Quals' ? 'Q' : m.tournamentLevel[0]}${String(m.id).padStart(2, '0')}`;
const matches = played
  .map((m) => ({
    id: m.id,
    label: label(m),
    level: m.tournamentLevel,
    startUtc: m.actualStartTime,
    offsetS: (Date.parse(m.actualStartTime) - t0) / 1000,
    red: side(m.scores.red),
    blue: side(m.scores.blue),
    totalTips: m.scores.red.tips + m.scores.blue.tips,
    teams: m.teams.map((t) => ({ team: t.teamNumber, alliance: t.alliance })),
  }))
  .sort((a, b) => a.offsetS - b.offsetS);

const ranked = [...matches].sort(
  (a, b) => b.totalTips - a.totalTips || b.red.points + b.blue.points - (a.red.points + a.blue.points),
);
const chosen = ranked.slice(0, top).map((m) => m.id);

const plan = {
  tool: 'dsim-spill-video',
  event,
  season,
  source: url,
  fetchedAt: new Date().toISOString(),
  note: 'offsetS = FMS start minus the first played match. A video time is match1VideoS + offsetS when the stream has no cuts.',
  chosen,
  matches,
};
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'data', event, 'plan.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');

const pad = (s, n) => String(s).padStart(n);
console.log(`${event} (${season}): ${matches.length} played matches, ${matches.reduce((s, m) => s + m.totalTips, 0)} tips.`);
console.log('match  offset   tips  red(auto+tele)  blue(auto+tele)   score');
for (const m of ranked) {
  const mark = chosen.includes(m.id) ? '*' : ' ';
  const off = `${Math.floor(m.offsetS / 60)}:${String(Math.round(m.offsetS % 60)).padStart(2, '0')}`;
  console.log(
    `${mark}${m.label}  ${pad(off, 7)}  ${pad(m.totalTips, 4)}  ${pad(`${m.red.tips} (${m.red.autoTips}+${m.red.teleopTips})`, 13)}` +
      `  ${pad(`${m.blue.tips} (${m.blue.autoTips}+${m.blue.teleopTips})`, 14)}   ${pad(m.red.points, 3)}-${m.blue.points}`,
  );
}
console.log(`\n* = the top ${top} by tips, written to ${out}`);
