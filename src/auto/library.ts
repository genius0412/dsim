/**
 * THE ZENITH AUTO LIBRARY — the player's auto files, per game, on this device (docs/area/autos.md).
 * CLIENT ONLY and in the main chunk: no Zenith import (the text is checked by `load.ts` when an
 * auto is added, through the lazy chunk), and nothing in the sim reads it.
 *
 * ── WHY IT IS NOT IN `GameSettings` ───────────────────────────────────────────────────────────
 * `GameSettings` syncs to Postgres per account, and the server caps that blob at 64 KB
 * (`server/api.ts`) because it is keybinds and toggles. One auto file may be most of that on its
 * own. So the library is its own `localStorage` key (`ZENITH_AUTOS_KEY`), device-local like the
 * theme, and the team's real copy of a file is its robot repository.
 */
import type { GameId } from '../games/types';
import { ZENITH_AUTOS_KEY } from '../storageKeys';
import { coerceZenithAuto } from './coerce';
import type { ZenithAutoSetup } from './types';

/** one auto in the library */
export interface AutoLibraryEntry {
  /** stable within this device's library */
  id: string;
  /** the file's `name`, or the file name it was imported from */
  name: string;
  auto: string;
  waypoints?: string;
  /** where it came from, for the panel's label */
  source: 'file' | 'paste' | 'zenith';
  /** ms since the epoch, for ordering; UI code, never read by the sim */
  savedAt: number;
}

export interface GameAutoLibrary {
  entries: AutoLibraryEntry[];
  /** the entry AUTO plays, when `enabled` */
  activeId: string | null;
  /** the "Run this auto in AUTO" toggle */
  enabled: boolean;
}

/** twelve autos a game: several routines per start and alliance, well inside a quota */
export const AUTO_LIBRARY_MAX = 12;

const EMPTY: GameAutoLibrary = { entries: [], activeId: null, enabled: false };

type Stored = Partial<Record<GameId, GameAutoLibrary>>;

function readAll(): Stored {
  try {
    const raw = localStorage.getItem(ZENITH_AUTOS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

/** field-by-field, like `coerceSettings`: a bad entry is dropped, never the whole library */
function coerceLibrary(raw: unknown): GameAutoLibrary {
  if (!raw || typeof raw !== 'object') return { ...EMPTY, entries: [] };
  const r = raw as Record<string, unknown>;
  const entries: AutoLibraryEntry[] = [];
  if (Array.isArray(r.entries)) {
    for (const e of r.entries.slice(0, AUTO_LIBRARY_MAX)) {
      if (!e || typeof e !== 'object') continue;
      const x = e as Record<string, unknown>;
      const z = coerceZenithAuto(x);
      if (!z || typeof x.id !== 'string' || typeof x.name !== 'string') continue;
      entries.push({
        id: x.id.slice(0, 40),
        name: x.name.slice(0, 80),
        auto: z.auto,
        ...(z.waypoints ? { waypoints: z.waypoints } : {}),
        source: x.source === 'paste' || x.source === 'zenith' ? x.source : 'file',
        savedAt: Number.isFinite(x.savedAt) ? (x.savedAt as number) : 0,
      });
    }
  }
  const activeId = typeof r.activeId === 'string' && entries.some((e) => e.id === r.activeId) ? r.activeId : null;
  return { entries, activeId, enabled: r.enabled === true && activeId !== null };
}

export function loadAutoLibrary(game: GameId): GameAutoLibrary {
  return coerceLibrary(readAll()[game]);
}

/** Returns false when the browser refused the write (quota, private mode). */
export function saveAutoLibrary(game: GameId, lib: GameAutoLibrary): boolean {
  try {
    const all = readAll();
    all[game] = coerceLibrary(lib);
    localStorage.setItem(ZENITH_AUTOS_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

/** The auto AUTO plays for `game`, or null when none is on. */
export function activeZenithAuto(game: GameId): (ZenithAutoSetup & { name: string }) | null {
  const lib = loadAutoLibrary(game);
  if (!lib.enabled) return null;
  const e = lib.entries.find((x) => x.id === lib.activeId);
  return e ? { name: e.name, auto: e.auto, ...(e.waypoints ? { waypoints: e.waypoints } : {}) } : null;
}

/** A fresh entry id: time plus a counter, unique within one device's library. */
let seq = 0;
export function newAutoId(): string {
  seq = (seq + 1) % 1000;
  return `${Date.now().toString(36)}${seq.toString(36)}`;
}

/**
 * Add or replace an entry by name (Zenith's Save sends the same auto again as it is edited),
 * newest first, capped. Returns the library as saved.
 */
export function upsertAuto(lib: GameAutoLibrary, entry: Omit<AutoLibraryEntry, 'id'> & { id?: string }): GameAutoLibrary {
  const existing = lib.entries.find((e) => (entry.id ? e.id === entry.id : e.name === entry.name));
  const id = existing?.id ?? entry.id ?? newAutoId();
  const next: AutoLibraryEntry = { ...entry, id };
  const entries = [next, ...lib.entries.filter((e) => e.id !== id)].slice(0, AUTO_LIBRARY_MAX);
  const activeId = lib.activeId && entries.some((e) => e.id === lib.activeId) ? lib.activeId : id;
  return { entries, activeId, enabled: lib.enabled };
}
