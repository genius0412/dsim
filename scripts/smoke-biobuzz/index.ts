/**
 * The BIOBUZZ smoke suite — the second half of `npm test`
 * (`tsx scripts/smoke.ts && tsx scripts/smoke-biobuzz/index.ts`).
 *
 * It is a separate process from `scripts/smoke.ts` on purpose: that file is a
 * ~16 000-line transcript two other people are editing at the same time, and its
 * PASS/FAIL list is diffed against a recorded baseline
 * (`docs/biobuzz/baseline-alpha.md`), so a new game must not append to it. The
 * `&&` means a red physics suite still stops the run — a red `npm test` keeps
 * meaning "physics broke".
 *
 * Run it alone with `npx tsx scripts/smoke-biobuzz/index.ts`.
 */
import { initPhysics } from '../../src/sim/physicsEngine';
import { report } from './harness';
import { coreChecks } from './core';
import { fieldChecks } from './field';
import { robotChecks } from './robot';

// the shared sim steps a Rapier world, so the WASM has to be loaded before any
// step() runs. tsx runs this file as ESM, so top-level await is available.
await initPhysics();

coreChecks();
fieldChecks();
robotChecks();

// ONE exit, after every sub-suite — a sub-suite that exited on its own would
// silently drop the ones after it
report();
