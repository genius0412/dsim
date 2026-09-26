/**
 * OPEN ZENITH FOR THIS PLAYER'S AUTO LIBRARY — the one place a DSIM screen does it, so the
 * Autonomous section's "Edit in Zenith" and the match screen's "Open run in Zenith" hand Zenith the
 * same project and take a Save back the same way (`zenith-host/1`, `zenithHost.ts`).
 *
 * SYNCHRONOUS on purpose: `window.open` must run inside the click that asked for it or the browser
 * blocks the popup. So this file is reached only through the lazy `zenithEditor.ts` entry, which a
 * screen has already loaded by the time its button can be clicked, and it is not in the main chunk.
 */
import type { GameSettings } from '../types';
import { loadAutoLibrary, saveAutoLibrary, upsertAuto, type GameAutoLibrary } from '../auto/library';
import { autoAdapterFor, parseAutoText, runAutoHeadless } from '../auto/zenithAutos';
import { openZenith, ZENITH_URL } from './zenithHost';

export interface LaunchOptions {
  settings: GameSettings;
  /** the auto to open, by library name; null starts a new one */
  open: string | null;
  /** a recorded run of `open` to lay over the plan as soon as Zenith has it */
  trace?: unknown;
  /** the library after a Save from Zenith landed in it */
  onLibrary?(lib: GameAutoLibrary, savedName: string): void;
}

/** Returns null when Zenith opened, or the sentence to show when it could not. */
export function launchZenith(o: LaunchOptions): string | null {
  const { settings } = o;
  const game = settings.game;
  const adapter = autoAdapterFor(game);
  if (!adapter) return 'This game has no Zenith autos.';
  const lib = loadAutoLibrary(game);
  const entry = o.open === null ? null : (lib.entries.find((e) => e.name === o.open) ?? null);
  let waypoints: unknown;
  try {
    waypoints = entry?.waypoints ? JSON.parse(entry.waypoints) : undefined;
  } catch {
    waypoints = undefined;
  }
  const autos: Record<string, string> = {};
  for (const e of lib.entries) autos[e.name] = e.auto;
  const session = openZenith({
    project: {
      name: 'DSIM',
      hostLabel: settings.spec.name?.trim() || 'DSIM robot',
      robot: adapter.robot(settings.spec),
      field: adapter.field(),
      ...(waypoints ? { waypoints } : {}),
      // a new auto sends no autos, so Zenith starts from its template
      autos: entry ? autos : {},
    },
    ...(entry ? { open: entry.name } : {}),
    ...(entry && o.trace !== undefined ? { trace: o.trace } : {}),
    onSave: async (name, text) => {
      try {
        parseAutoText(text);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const current = loadAutoLibrary(game);
      const prior = current.entries.find((e) => e.name === name);
      const wp = prior?.waypoints ?? entry?.waypoints;
      const next = upsertAuto(current, {
        ...(prior ? { id: prior.id } : {}),
        name,
        auto: text,
        ...(wp ? { waypoints: wp } : {}),
        source: 'zenith',
        savedAt: Date.now(),
      });
      if (!saveAutoLibrary(game, next)) return 'DSIM couldn’t store it on this device: browser storage is full.';
      o.onLibrary?.(next, name);
      return null;
    },
    onRun: async (name, text) => {
      const wp = loadAutoLibrary(game).entries.find((e) => e.name === name)?.waypoints ?? entry?.waypoints;
      return runAutoHeadless({ game, spec: settings.spec, setup: { auto: text, ...(wp ? { waypoints: wp } : {}) } }).trace;
    },
  });
  if (!session) return `Couldn’t open Zenith. Allow pop-ups for this site, or open ${ZENITH_URL} yourself.`;
  return null;
}
