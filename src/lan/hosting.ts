/**
 * IS THIS TAB RUNNING THE ROOM?
 *
 * One boolean, in its own leaf module, for the same reason `src/net/roomRegion.ts` is one:
 * **the rule it carries fails SILENTLY.** A match that nobody keeps produces no error, no
 * warning and no missing screen — it just is not in your history the next morning, by which
 * point the scrimmage is over and the replay never existed.
 *
 * That is not hypothetical. `App.tsx`'s `keepLanRun` gates on `lanActive()`, which is the
 * DESKTOP/terminal LAN path (`setLanServer()` in `src/net/env.ts` — a room reached by typing an
 * address). A tab-hosted room is reached by adopting a live `Transport` instead, so it sets no
 * LAN server, `lanActive()` stays false, and every condition after it is never even evaluated.
 * Meanwhile the Worker room is built with no persistence callbacks ON PURPOSE
 * (`hostWorker.ts`), so if the page does not keep the match, nothing anywhere does.
 *
 * ⚠️ **THE HOST'S TAB IS THE ONLY ONE THAT MAY SAY YES.** This is set by the screen that
 * actually started a `LanHost`, so a guest's tab reads false — which is what keeps the
 * one-uploader rule intact and stops a room of six people filing six copies of one match.
 */
let hosting = false;

/** called by the LAN screen when it starts hosting, and again when hosting ends */
export function setTabHosting(on: boolean): void {
  hosting = on;
}

/** true while THIS tab is running the authoritative room for the live session */
export function tabHosting(): boolean {
  return hosting;
}
