#!/usr/bin/env node
/**
 * SHOW THE BOARD: `npm run coord`.
 *
 * Collisions first, because they are the only thing here anybody has to ACT on. Everything
 * below them is context.
 *
 * ── WHY STALE CLAIMS ARE SHOWN, NOT HIDDEN ─────────────────────────────────
 * A claim nobody has refreshed in an hour and a half is probably finished, and it is possibly
 * somebody who walked away mid-edit with a dirty tree. Those need different responses, and the
 * board cannot tell them apart — so it says how old every claim is and lets a person decide.
 * Hiding them would turn "I do not know" into a confident wrong answer, which is the failure
 * mode a coordination tool can least afford.
 */
import { RETIRED_PATH, STALE_MIN, ageMin, claimPaths, collisions, explainUnconfigured, fetchBoard, loadConfig, readClaims } from './lib.mjs';
import { existsSync } from 'node:fs';

const C = process.stdout.isTTY
  ? { red: '\x1b[31m', yel: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { red: '', yel: '', dim: '', bold: '', off: '' };

const cfg = loadConfig();
if (!cfg) {
  // A RETIRED board is not a misconfiguration and must not read as one: the owner switched the
  // system off, everything is working as intended, and there is nothing for anybody to fix.
  // Exit 0 so it cannot be mistaken for a failure by anything reading the status.
  const retired = existsSync(RETIRED_PATH);
  console[retired ? 'log' : 'error'](explainUnconfigured());
  process.exit(retired ? 0 : 1);
}

fetchBoard();
const claims = readClaims();

if (claims.length === 0) {
  console.log('[coord] the board is empty — nobody has published a claim yet.');
  process.exit(0);
}

const hits = collisions(claims);
if (hits.length) {
  console.log(`${C.red}${C.bold}── COLLISIONS ────────────────────────────────────────────────${C.off}`);
  for (const h of hits) {
    console.log(`${C.red}  ${h.a.name} and ${h.b.name} are both on:${C.off}`);
    for (const p of h.paths) console.log(`${C.red}      ${p}${C.off}`);
  }
  console.log(`${C.dim}  Talk before either of you commits. Git will merge these; it will not${C.off}`);
  console.log(`${C.dim}  tell you that you both solved the same problem two different ways.${C.off}`);
  console.log('');
}

const age = (m) => (m === Infinity ? '   ?' : m < 60 ? `${Math.round(m)}m` : `${(m / 60).toFixed(1)}h`);

for (const c of claims) {
  const m = ageMin(c.updatedAt);
  const stale = m > STALE_MIN;
  const you = c.name === cfg.name ? ' (you)' : '';
  const tint = stale ? C.dim : '';
  console.log(`${tint}${C.bold}${c.name}${you}${C.off}${tint}  ${age(m)} ago${stale ? `  ${C.yel}STALE${C.off}${tint}` : ''}`);
  if (c.label) console.log(`${tint}    ${c.label}${C.off}`);
  const a = c.auto || {};
  console.log(`${tint}    branch ${a.branch || '?'}  @ ${a.head || '?'}${a.headSubject ? `  ${C.dim}${a.headSubject}${C.off}${tint}` : ''}${C.off}`);
  const paths = claimPaths(c);
  if (paths.length === 0) console.log(`${tint}    ${C.dim}(no paths claimed, working tree clean)${C.off}`);
  for (const p of paths.slice(0, 12)) {
    const named = (c.paths || []).includes(p);
    console.log(`${tint}    ${named ? '◆' : '·'} ${p}${C.off}`);
  }
  if (paths.length > 12) console.log(`${tint}    ${C.dim}… and ${paths.length - 12} more${C.off}`);
  console.log('');
}

console.log(`${C.dim}◆ claimed deliberately   · dirty in their working tree${C.off}`);
console.log(`${C.dim}The board is intent. Git is truth — it says what actually landed.${C.off}`);
