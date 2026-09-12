#!/usr/bin/env node
/**
 * ONE-TIME SETUP, per person per checkout: `npm run coord:setup`.
 *
 * Verifies the configured repository is private BEFORE anything is ever published to it, wires
 * the `coord` remote, and proves the round trip by publishing this machine's first claim. If
 * the private check fails, nothing is pushed and nothing is written — the remote is not even
 * added, so a later `npm run coord` cannot quietly start using it.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, assertPrivate, ensureRemote, explainUnconfigured, fetchBoard, loadConfig, readClaims,
} from './lib.mjs';

const cfg = loadConfig();
if (!cfg) {
  console.error(explainUnconfigured());
  process.exit(1);
}

console.log(`[coord] name   ${cfg.name}`);
console.log(`[coord] remote ${cfg.remote}`);

const priv = assertPrivate(cfg.remote);
if (!priv.ok) {
  console.error(`\n[coord] REFUSING TO SET UP — ${priv.why}`);
  console.error('[coord] The board records what three people are building, live and unreviewed.');
  console.error('[coord] Point `remote` at a PRIVATE repository and run this again.');
  process.exit(2);
}
console.log(`[coord] ${priv.slug} is private ✓`);

ensureRemote(cfg.remote);

// .coord.json names a private repository from inside a public one. It must never be committed.
const ignorePath = join(ROOT, '.gitignore');
const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
if (!ignore.split('\n').some((l) => l.trim() === '.coord.json')) {
  appendFileSync(ignorePath, `${ignore.endsWith('\n') || !ignore ? '' : '\n'}.coord.json\n`);
  console.log('[coord] added .coord.json to .gitignore');
}

fetchBoard();
const before = readClaims().length;

const { spawnSync } = await import('node:child_process');
const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'coord', 'publish.mjs'), '--verbose'], {
  cwd: ROOT,
  stdio: 'inherit',
  windowsHide: true,
});
if (r.status !== 0) {
  console.error('[coord] the first publish failed — the output above says why.');
  process.exit(r.status ?? 1);
}

fetchBoard();
console.log(`[coord] board now holds ${readClaims().length} claim(s) (was ${before}).`);
console.log('[coord] Ready. `npm run coord` shows the board.');
console.log('[coord] From here it republishes itself at the end of every turn. Nothing else to do.');
