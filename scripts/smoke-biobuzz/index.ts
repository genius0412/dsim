import { initPhysics } from '../../src/sim/physicsEngine';
import { fieldChecks, roomChecks } from './field';
import { robotChecks } from './robot';
import { coreChecks } from './core';
import { sponsorChecks } from './sponsor';
import type { Check } from './harness';

/**
 * THE BIOBUZZ SMOKE ENTRY POINT. Run with: `npx tsx scripts/smoke-biobuzz/index.ts`
 *
 * Two lanes, one process, one exit code. `field.ts` owns the field, the wire, the server and
 * the performance budget; `robot.ts` owns the specs and the mechanisms. The split is what lets
 * both lanes add checks without touching one file, and the shared `check` counter is what lets
 * the whole thing be a single `npm run test:bb`.
 *
 * ── WHY `initPhysics` IS AWAITED HERE AND NOWHERE ELSE ─────────────────────
 * `solveRobots` needs the Rapier WASM module resolved before the first step, and
 * `@dimforge/rapier2d-compat` resolves it asynchronously. The browser gets this from
 * `main.tsx`, which awaits it before rendering; the server gets it at boot. A headless script
 * has neither, so it awaits at the top — top-level, once, before any world is built. Every
 * check below is synchronous precisely so this is the only await in the suite and there is no
 * ordering question about it.
 *
 * A THROW anywhere below is a suite-level failure, not a check failure. That is why each lane
 * is called inside its own try: one lane throwing must still let the other run and report,
 * because "BIOBUZZ mechanisms are fine, the perf harness blew up" is a different morning from
 * "everything is broken".
 */
await initPhysics();

let failures = 0;
let ran = 0;
const check: Check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ran++;
  if (!ok) failures++;
};

/** run one lane, counting a throw as a failure rather than as an aborted suite. */
function lane(name: string, fn: (c: Check) => void): void {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`);
  try {
    fn(check);
  } catch (e) {
    check(`${name}: the lane ran to completion`, false, e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  }
}

lane('CORE', coreChecks);
lane('FIELD', fieldChecks);
lane('SERVER', roomChecks);
lane('ROBOT', robotChecks);
// app-level, not a game lane — see the header of sponsor.ts for why it rides this suite
lane('SPONSOR', sponsorChecks);

console.log(failures === 0 ? `\n${ran} CHECKS, ALL PASS` : `\n${failures} FAILURES of ${ran} checks`);
process.exit(failures === 0 ? 0 : 1);
