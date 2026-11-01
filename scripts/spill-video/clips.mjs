#!/usr/bin/env node
/**
 * Cut one clip per chosen match out of an event stream.
 *
 *   node scripts/spill-video/clips.mjs <EVENT> --match1 1:02:03 --url https://youtu.be/...
 *   node scripts/spill-video/clips.mjs <EVENT> --match1 1:02:03 --video D:\vods\salk1.mp4
 *
 *   --match1 T   video time (h:mm:ss or seconds) where the FIRST played match's AUTO starts.
 *                Read it off the stream once; every other match follows from FTCScout's FMS
 *                start times in plan.json.
 *   --matches L  comma list of match ids (default: plan.json's `chosen`, the top by tips).
 *   --fix  id=T  override one match's start when the stream had a cut (repeatable).
 *   --pre S      seconds kept before the match start (default 5).
 *   --len S      clip length in seconds (default 170: 30 auto + 8 transition + 120 teleop + slack).
 *   --height H   max video height for --url (default 1080).
 *   --dry        print the plan and the commands, run nothing.
 *
 * --url uses yt-dlp (install it yourself: `pip install yt-dlp` or `winget install yt-dlp`) and
 * downloads ONLY the clip sections. --video cuts from a file you already have with ffmpeg.
 * Clips go to `scripts/spill-video/data/<EVENT>/clips/Q03.mp4` and so on. That folder is
 * gitignored: commit the `.spill.json` annotations, never the video.
 *
 * Runs on Windows PowerShell 5.1, macOS and Linux (it only spawns yt-dlp / ffmpeg).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const flags = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const event = args[0];
if (!event || event.startsWith('--')) {
  console.error('usage: node scripts/spill-video/clips.mjs <EVENT> --match1 h:mm:ss (--url URL | --video FILE) [--matches 3,9] [--dry]');
  process.exit(2);
}

/** "1:02:03.5" | "62:03" | "3723.5" -> seconds */
function parseT(s) {
  if (s == null) return NaN;
  return String(s).split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}
function fmt(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t - h * 3600 - m * 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'data', event);
const planPath = join(dir, 'plan.json');
if (!existsSync(planPath)) {
  console.error(`No ${planPath}. Run: node scripts/spill-video/plan.mjs ${event}`);
  process.exit(1);
}
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const match1 = parseT(flag('match1'));
if (!Number.isFinite(match1)) {
  console.error('--match1 is required: the video time where the first played match starts (auto begins).');
  process.exit(2);
}
const url = flag('url');
const video = flag('video');
const dry = args.includes('--dry');
if (!url && !video) {
  console.error('Give --url (downloads with yt-dlp) or --video (cuts a local file with ffmpeg).');
  process.exit(2);
}
const pre = Number(flag('pre', '5'));
const len = Number(flag('len', '170'));
const height = Number(flag('height', '1080'));
const ids = (flag('matches') ? flag('matches').split(',').map(Number) : plan.chosen);
const fixes = new Map(flags('fix').map((f) => { const [id, t] = f.split('='); return [Number(id), parseT(t)]; }));

const outDir = join(dir, 'clips');
mkdirSync(outDir, { recursive: true });
const index = [];
for (const id of ids) {
  const m = plan.matches.find((x) => x.id === id);
  if (!m) { console.error(`match ${id} is not in plan.json`); continue; }
  const startInVideo = fixes.has(id) ? fixes.get(id) : match1 + m.offsetS;
  const from = Math.max(0, startInVideo - pre);
  const out = join(outDir, `${m.label}.mp4`);
  index.push({ id, label: m.label, file: `clips/${m.label}.mp4`, clipStartInVideoS: from, matchStartInClipS: startInVideo - from });
  let cmd;
  if (url) {
    cmd = ['yt-dlp', '--download-sections', `*${from.toFixed(2)}-${(from + len).toFixed(2)}`, '--force-keyframes-at-cuts',
      '-f', `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/b[height<=${height}]`, '--merge-output-format', 'mp4', '-o', out, url];
  } else {
    // Re-encode rather than stream-copy: a copy can only start on a keyframe, which can be
    // seconds early and would shift every time in the annotation file.
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-ss', from.toFixed(3), '-i', video, '-t', String(len),
      '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-c:a', 'aac', out];
  }
  console.log(`${m.label}  tips ${m.totalTips}  stream ${fmt(startInVideo)}  ->  ${out}`);
  if (dry) { console.log('   ', cmd.join(' ')); continue; }
  if (existsSync(out)) { console.log('    exists, skipped (delete it to re-cut)'); continue; }
  // No shell, on every platform: the format string carries [ ] * + that cmd.exe would mangle,
  // and both tools install as real executables (yt-dlp.exe, ffmpeg.exe) that spawn finds on PATH.
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`    ${cmd[0]} failed (exit ${r.status}). Is it installed and on PATH?`);
    process.exitCode = 1;
  }
}
writeFileSync(join(dir, 'clips.json'), JSON.stringify({ event, match1VideoS: match1, pre, len, source: url ?? video, clips: index }, null, 2) + '\n');
console.log(`\nWrote ${join(dir, 'clips.json')}. Open ${join(here, 'annotate.html')} in a browser and load a clip.`);
