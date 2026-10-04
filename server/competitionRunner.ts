/**
 * THE COMPETITION RUNNER (0059) — the one timer competitions need, and the rule it lives by.
 *
 * A called match whose drivers never arrive has no room to report that it is over, and a
 * competition with auto-calling on needs somebody to call its next match when a room finishes.
 * Both are `runnerPass` in `server/competitions.ts`; this file decides WHEN it runs.
 *
 * IDLE MEANS SILENT (see the block of that name in `server/index.ts`): Neon bills the hours the
 * database is awake, and a timer that queried it every few seconds forever would keep it awake
 * forever. So the runner is ASLEEP until something says a competition may be running — one read
 * at boot, and then any competition request that touches a running one (`setCompetitionWake`) —
 * and it goes back to sleep the first pass that finds nothing running. While a competition IS
 * running the database is awake anyway: its players are polling the page and finishing matches.
 *
 * It runs on ONE machine, the matchmaker's (`index.ts` passes `enabled`), because two runners
 * would race to call the same match. The calls themselves are conditional updates, so even a
 * second runner could not call a match twice; it would only waste queries.
 */
import { anyRunning, runnerPass, setCompetitionWake } from './competitions';

const PASS_MS = 10_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let enabled = false;

function schedule(delay: number): void {
  if (!enabled || timer) return;
  timer = setTimeout(() => {
    timer = null;
    void pass();
  }, delay);
  timer.unref?.();
}

async function pass(): Promise<void> {
  if (running) return;
  running = true;
  let again = false;
  try {
    const r = await runnerPass();
    if (r.stale || r.called) console.log(`[comp] runner: ${r.stale} stale call(s) returned, ${r.called} match(es) called`);
    again = r.busy;
  } catch (e) {
    console.error('[comp] runner pass failed:', e);
    again = true; // a failed read is usually the database waking; try again on the next beat
  } finally {
    running = false;
  }
  if (again) schedule(PASS_MS);
}

/** start the runner on this machine (or not), and arm it if a competition is already running */
export function startCompetitionRunner(on: boolean): void {
  enabled = on;
  if (!on) return;
  setCompetitionWake(() => schedule(1_000));
  anyRunning()
    .then((yes) => {
      if (yes) schedule(PASS_MS);
    })
    .catch((e) => console.error('[comp] runner boot read failed:', e));
}
