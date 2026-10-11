/**
 * ⚠️ A CHUNK THE APP RUNS WITHOUT MUST NOT RELOAD THE PAGE WHEN IT FAILS TO LOAD (2026-10-11).
 *
 * `main.tsx` reloads once on Vite's `vite:preloadError`, so a tab left open across a deploy picks up
 * the new build instead of asking for a hashed file that is gone. That is right for a screen the
 * player opened, and wrong for a part fetched without them asking: BIOBUZZ's bay (`renderRobots.ts`,
 * `bbLoadBay`) is fetched by the first High robot built, which can be mid-match after a switch to
 * High, or as a fixed-High replay export starts on a Low device. The reload dropped the match or
 * the export for hardware under the deck.
 *
 * Such a loader goes through `loadOptionalChunk`. While it is in flight, `main.tsx` leaves a failure
 * that is its own (`optionalChunkFailed`) to the loader's rejection handler. Vite dispatches the
 * event from inside the import's own `catch`, so the chunk is still counted in flight when the
 * listener asks. `main.tsx`'s listener runs first whatever else listens: Chromium (Electron 43)
 * calls a window's listeners in the order they were added, capture or not, so a late listener
 * cannot cancel the reload itself.
 *
 * DOM-free: the RENDER lane imports `renderRobots.ts` in node.
 */
const inFlight = new Map<string, number>();

/** run `load` (a dynamic `import()`) as the optional chunk `name`, its built file's name prefix */
export function loadOptionalChunk<T>(name: string, load: () => Promise<T>): Promise<T> {
  inFlight.set(name, (inFlight.get(name) ?? 0) + 1);
  const done = (): void => {
    const n = (inFlight.get(name) ?? 1) - 1;
    if (n > 0) inFlight.set(name, n);
    else inFlight.delete(name);
  };
  return load().then(
    (v) => {
      done();
      return v;
    },
    (e: unknown) => {
      done();
      throw e;
    },
  );
}

/**
 * is this `vite:preloadError` (its `payload`) an optional chunk's? Chromium and Firefox name the file
 * in the message, so a failure naming one in flight is its own and one naming any other `.js` file
 * is not. Safari names none ("Importing a module script failed."), so there any failure while one
 * is in flight counts as its own: a page chunk failing in those few milliseconds shows its own
 * error (`LoadBoundary`) instead of reloading.
 */
export function optionalChunkFailed(payload: unknown): boolean {
  if (!inFlight.size) return false;
  const msg = String((payload as { message?: unknown } | null | undefined)?.message ?? payload ?? '');
  for (const name of inFlight.keys()) if (msg.includes(name)) return true;
  return !/\.js\b/.test(msg);
}
