#!/usr/bin/env node
/**
 * PUBLISH THIS MACHINE'S CLAIM. Run directly, or spawned detached by the Stop hook.
 *
 * ── WHAT IT SENDS, AND WHAT IT CANNOT SEND ─────────────────────────────────
 * Exactly one JSON document: the publisher's name, their deliberate LABEL and PATHS (set only
 * by `npm run coord:claim`), and a machine-derived snapshot — current branch, short HEAD, the
 * subject line of the last commit, and the paths `git status --porcelain` reports dirty.
 *
 * Nothing else can reach the board, and that is the point rather than a policy. The automatic
 * publisher runs every turn with nobody reading its output, so its payload is built ONLY from
 * `git` output: it never reads the conversation, never reads a file's CONTENTS, never copies
 * the environment, and cannot be handed free text. The worst thing an accidental paste into a
 * chat can do here is nothing, because the chat is not an input. A descriptive label exists,
 * but a person has to type it deliberately into `coord:claim`.
 *
 * ── WHY IT RE-CHECKS THAT THE REMOTE IS PRIVATE, EVERY TIME ────────────────
 * Visibility is not a property of a URL. Someone with admin on the board repository can make
 * it public later, and this process would go on pushing to it silently. So the check is per
 * run, and "cannot tell" refuses.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  RETIRE_STRIKES, RETIRED_PATH, assertPrivate, ensureRemote, explainUnconfigured, fetchBoard,
  gitDir, loadConfig, localState, readClaims, retire, retireStrikes, writeFileToBranch,
} from './lib.mjs';

const verbose = process.argv.includes('--verbose');
const log = (...a) => { if (verbose) console.log(...a); };
const fail = (...a) => { if (verbose) console.error(...a); };

const cfg = loadConfig();
if (!cfg) {
  if (verbose) console.error(explainUnconfigured());
  process.exit(verbose ? 1 : 0); // unconfigured is a silent no-op on the hook path
}

const priv = assertPrivate(cfg.remote);

// THE KILL SWITCH. Deleting the board repository, or removing somebody from it, is how the
// owner turns this off for everyone without having to reach three machines — so a board that
// has gone away must make the tooling disarm ITSELF rather than refuse forever. Two
// consecutive runs, because one 404 is not proof and a blip must not tear down three people's
// setup; `assertPrivate` has already established that `gh` works on this machine, so this is
// not a network wobble. Afterwards `.coord.json` no longer exists, every entry point is a
// silent no-op, and nothing here makes another network call.
if (priv.reason === 'retired') {
  const n = retireStrikes(true);
  if (n < RETIRE_STRIKES) {
    fail(`[coord] ${priv.why} — confirming on the next run before standing down.`);
    process.exit(verbose ? 2 : 0);
  }
  const { stamp } = retire(priv.why);
  log(`[coord] THE BOARD IS RETIRED — ${priv.why}`);
  log(`[coord] Stood down at ${stamp}. Config kept at ${RETIRED_PATH}; nothing publishes now.`);
  process.exit(0);
}
retireStrikes(false); // any other answer means the board is reachable; forget earlier strikes.

if (!priv.ok) {
  // Refuse on every path, but leave a breadcrumb where a person will find it — a hook that
  // silently does nothing forever is indistinguishable from a hook that is working.
  const note = join(gitDir(), 'coord-refused');
  try {
    mkdirSync(dirname(note), { recursive: true });
    writeFileSync(note, `${new Date().toISOString()} ${priv.why}\n`);
  } catch { /* a breadcrumb is a nicety; never fail the turn over it */ }
  fail(`[coord] REFUSING TO PUBLISH — ${priv.why}`);
  process.exit(verbose ? 2 : 0);
}

ensureRemote(cfg.remote);
fetchBoard();

// keep whatever the person deliberately claimed; only the machine-derived half is refreshed.
const mine = readClaims().find((c) => c.name === cfg.name) || {};
const state = localState();

const claim = {
  name: cfg.name,
  updatedAt: state.at,
  label: typeof mine.label === 'string' ? mine.label : '',
  paths: Array.isArray(mine.paths) ? mine.paths : [],
  auto: state,
};

// A publish per turn is a commit per turn. Skip when nothing a reader would see has changed,
// so an afternoon of thinking does not become five hundred identical commits.
const fingerprint = createHash('sha256')
  .update(JSON.stringify({ ...claim, updatedAt: null, auto: { ...state, at: null } }))
  .digest('hex');
const stamp = join(gitDir(), 'coord-last');
const previous = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : '';
if (previous === fingerprint && !process.argv.includes('--force')) {
  log('[coord] unchanged since the last publish — nothing to do.');
  process.exit(0);
}

const body = `${JSON.stringify(claim, null, 2)}\n`;
const subject = `${cfg.name}: ${state.branch}${claim.label ? ` — ${claim.label}` : ''}`.slice(0, 72);
const res = writeFileToBranch(`claims/${cfg.name}.json`, body, subject);

if (!res.ok) {
  fail('[coord] publish failed:', res.error?.message || res.error);
  process.exit(verbose ? 1 : 0); // never fail somebody's turn over a coordination push
}

try {
  writeFileSync(stamp, fingerprint);
} catch { /* the stamp is an optimisation, not state anything depends on */ }

log(`[coord] published ${claim.name} → ${priv.slug} (${res.commit.slice(0, 8)})`);
