/**
 * THE ONE DOOR INTO THE IMPORTER ENGINE. Main-chunk safe: it holds a dynamic `import()` and
 * nothing else, so the three.js zone under `engine/` stays one lazy chunk (`bundleaudit`'s
 * `importer` route). Every caller — the import editor, the dev harness — goes through here; a
 * second dynamic specifier would split the chunk behind facades the audit cannot route (the same
 * rule `src/games/biobuzz/index.ts` keeps for the scene).
 */
export type ImporterEngine = typeof import('./engine/importerEngine');

let engine: Promise<ImporterEngine> | null = null;

/** fetch (once) and return the importer engine */
export function loadImporterEngine(): Promise<ImporterEngine> {
  if (!engine) {
    engine = import('./engine/importerEngine');
    // a failed fetch (offline, a deploy replaced the chunk) is retried on the next call
    engine.catch(() => {
      engine = null;
    });
  }
  return engine;
}
