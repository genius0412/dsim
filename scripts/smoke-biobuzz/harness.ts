/**
 * The tiny check harness for the BIOBUZZ smoke suite.
 *
 * Same `check()` / `failures` / `process.exit` shape as `scripts/smoke.ts` — one
 * line per check, `PASS`/`FAIL` first so `npm test 2>&1 | grep '^FAIL'` reads the
 * same across both suites — but its own module, so a THIRD game does not append
 * to a 16 000-line file two other people are editing at the same time.
 *
 * `failures` is module state, shared by every file the entry point imports, and
 * `report()` is what turns it into an exit code. Nothing here knows anything
 * about BIOBUZZ: the field and robot halves own their own worlds.
 */

let failures = 0;

/** one assertion. `detail` is printed after an em dash when the check fails or
 * when a measured value is worth seeing in the log. */
export function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** a section heading in the log — the suite is read as a transcript, like smoke.ts */
export function section(title: string): void {
  console.log(`\n---- ${title} ${'-'.repeat(Math.max(0, 70 - title.length))}`);
}

/** how many checks have failed so far (for a sub-suite that wants to branch) */
export const failureCount = (): number => failures;

/**
 * Print the tally and exit. Called ONCE, by `index.ts`, after every sub-suite has
 * run — a sub-suite must never exit on its own or the later ones never run.
 */
export function report(): never {
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}
