/**
 * READING AN ENVIRONMENT VARIABLE FROM CODE THAT ALSO RUNS IN A BROWSER.
 *
 * `server/room.ts` and the handful of modules it pulls in are no longer node-only: the LAN
 * host runs the SAME room in a tab (see `docs/lan-webrtc.md`), so every module on that
 * import graph has to survive being loaded where there is no `process`. A bare
 * `process.env.X` at module scope does not — it throws `ReferenceError: process is not
 * defined` while the module is still initialising, which takes the whole bundle with it and
 * reports the failure at an import site rather than at the line responsible.
 *
 * Reading through `globalThis` is what makes it a MISS instead of a CRASH. In Node nothing
 * changes; in a tab every lookup returns `undefined` and each caller's own default applies —
 * which is the behaviour those defaults were already written for, since a self-hosted server
 * runs with almost none of these set either.
 *
 * ⚠️ **This is not a way to configure the browser host.** It is the read side only, and in a
 * tab it always misses. Anything the host genuinely needs to vary is passed to it explicitly.
 */
type ProcessLike = { env?: Record<string, string | undefined> };

/** `process.env[name]`, or `undefined` where there is no `process` (a browser, a Worker). */
export function envVar(name: string): string | undefined {
  const proc = (globalThis as { process?: ProcessLike }).process;
  return proc?.env?.[name];
}
