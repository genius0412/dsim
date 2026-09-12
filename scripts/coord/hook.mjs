#!/usr/bin/env node
/**
 * THE PER-TURN PUBLISHER, wired to the `Stop` hook.
 *
 * ── THE ONLY RULE THAT MATTERS HERE: NEVER GET IN THE WAY ──────────────────
 * This runs at the end of every assistant turn, in a session somebody is working in. So it
 * does the cheapest possible checks and then hands the network work to a DETACHED child and
 * exits — measured in milliseconds, whatever the state of the network. A hook that pushes
 * inline adds its latency to every turn, and on a venue Wi-Fi that is the difference between
 * a coordination board and a reason to turn the coordination board off.
 *
 * It also exits 0 unconditionally. A non-zero hook is feedback to the model; a coordination
 * push failing is not something anybody's session should have to hear about, let alone act on.
 *
 * Rate-limited on its own clock so a burst of short turns is one publish rather than ten.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_PATH, ROOT, gitDir } from './lib.mjs';

const MIN_GAP_MS = 20_000;

try {
  // Unconfigured is the normal state for a checkout nobody has set up — say nothing.
  if (!existsSync(CONFIG_PATH)) process.exit(0);

  const tick = join(gitDir(), 'coord-tick');
  const last = existsSync(tick) ? Number(readFileSync(tick, 'utf8').trim()) : 0;
  if (Number.isFinite(last) && Date.now() - last < MIN_GAP_MS) process.exit(0);
  writeFileSync(tick, String(Date.now()));

  const child = spawn(process.execPath, [join(ROOT, 'scripts', 'coord', 'publish.mjs')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
} catch {
  // Anything at all going wrong here is strictly less important than the turn that is ending.
}

process.exit(0);
