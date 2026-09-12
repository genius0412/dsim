#!/usr/bin/env node
/**
 * DECLARE WHAT YOU ARE ABOUT TO TOUCH: `npm run coord:claim -- "<what>" <path> [path…]`
 *
 *   npm run coord:claim -- "field geometry from Section 9" src/games/biobuzz/config.ts docs/biobuzz-reference.md
 *   npm run coord:claim -- --clear
 *
 * ── WHY PATHS AND NOT TASK NAMES ───────────────────────────────────────────
 * "Working on scoring" and "doing the scoring rules" are the same work under two names, and no
 * program can tell. `src/games/biobuzz/elements.ts` collides with `src/games/biobuzz/` exactly,
 * mechanically, with no judgement — so the board can flag the overlap itself instead of hoping
 * somebody reads a list. It also matches how this repo already divides work: the lane prompts
 * say a lane must never edit files another lane owns, and a path claim is that rule, visible.
 *
 * The label is free text and is the ONE thing on the board a person types. Everything else is
 * derived from git, which is what keeps the automatic half of this incapable of leaking
 * anything from a conversation.
 *
 * A claim is a note, not a lock. Nothing here can stop anyone editing anything.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { RETIRED_PATH, ROOT, explainUnconfigured, fetchBoard, loadConfig, readClaims, writeFileToBranch } from './lib.mjs';

const cfg = loadConfig();
if (!cfg) {
  const retired = existsSync(RETIRED_PATH);
  console[retired ? 'log' : 'error'](explainUnconfigured());
  process.exit(retired ? 0 : 1);
}

const argv = process.argv.slice(2);
const clear = argv.includes('--clear');
const rest = argv.filter((a) => a !== '--clear');
const label = clear ? '' : (rest.shift() || '');
const paths = clear ? [] : rest.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '').trim()).filter(Boolean);

if (!clear && !label) {
  console.error('usage: npm run coord:claim -- "<what you are doing>" <path> [path…]');
  console.error('       npm run coord:claim -- --clear');
  process.exit(2);
}

fetchBoard();
const mine = readClaims().find((c) => c.name === cfg.name);
if (!mine) {
  console.error('[coord] no claim published from this machine yet — run `npm run coord:setup` first.');
  process.exit(1);
}

const next = { ...mine, label, paths, updatedAt: new Date().toISOString() };
const subject = `${cfg.name}: ${label || 'cleared claim'}`.slice(0, 72);
const res = writeFileToBranch(`claims/${cfg.name}.json`, `${JSON.stringify(next, null, 2)}\n`, subject);
if (!res.ok) {
  console.error('[coord] could not publish the claim:', res.error?.message || res.error);
  process.exit(1);
}

console.log(clear ? '[coord] claim cleared.' : `[coord] claimed: ${label}`);
for (const p of paths) console.log(`[coord]   ◆ ${p}`);

// Show the board straight away — the point of claiming is to find out whether anyone else is
// already there, and making that a second command people have to remember loses the habit.
spawnSync(process.execPath, [join(ROOT, 'scripts', 'coord', 'board.mjs')], {
  cwd: ROOT, stdio: 'inherit', windowsHide: true,
});
