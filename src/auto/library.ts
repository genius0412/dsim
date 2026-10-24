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
import { coerceZenithAuto, ZENITH_AUTO_MAX_BYTES } from './coerce';
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

/** Why Import and New in Zenith are off: the panel's words for the refusal Zenith's Save gets. */
export const LIBRARY_FULL = `The library is full (${AUTO_LIBRARY_MAX}). Delete an auto to add another.`;

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
    // other screens that show the auto AUTO plays (the Start position note) read it again
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTO_LIBRARY_CHANGED));
    return true;
  } catch {
    return false;
  }
}

/** Fired on `window` after every library write in this tab (a write in another tab fires `storage`). */
export const AUTO_LIBRARY_CHANGED = 'dsim:autolibrary';

/** The auto AUTO plays for `game`, or null when none is on. */
export function activeZenithAuto(game: GameId): (ZenithAutoSetup & { name: string }) | null {
  const lib = loadAutoLibrary(game);
  if (!lib.enabled) return null;
  const e = lib.entries.find((x) => x.id === lib.activeId);
  return e ? { name: e.name, auto: e.auto, ...(e.waypoints ? { waypoints: e.waypoints } : {}) } : null;
}

/**
 * The sentence refusing an auto file too big to keep, or null. `saveAutoLibrary` coerces every
 * entry through `coerceZenithAuto`, which DROPS one over the byte cap without a word, so a caller
 * that stores an auto (Zenith's Save, an import) asks this first and says so instead: otherwise
 * the save reports success, the auto is not in the library, and AUTO plays nothing.
 */
export function autoTooLarge(text: string): string | null {
  if (text.length <= ZENITH_AUTO_MAX_BYTES) return null;
  return `This auto is ${Math.ceil(text.length / 1024)} KB and DSIM keeps autos up to ${ZENITH_AUTO_MAX_BYTES / 1024} KB. Split it into shorter routines.`;
}

/** A fresh entry id: time plus a counter, unique within one device's library. */
let seq = 0;
export function newAutoId(): string {
  seq = (seq + 1) % 1000;
  return `${Date.now().toString(36)}${seq.toString(36)}`;
}

/**
 * Can an auto named `name` go into `lib`? A name the library already holds is REPLACED, so it
 * always can; a new one needs a free slot. Every caller that adds asks this first and refuses with
 * a sentence (`libraryFullFor`), because `upsertAuto`'s cap below is only the last line.
 */
export function libraryHasRoom(lib: GameAutoLibrary, name: string): boolean {
  return lib.entries.length < AUTO_LIBRARY_MAX || lib.entries.some((e) => e.name === name);
}

/**
 * The sentence for files an import could not add to a full library: it names them (three, then a
 * count), then says why and what to do. Zenith's Save has its own wording (`LIBRARY_FULL_SAVE`).
 */
export function libraryFullFor(files: readonly string[]): string {
  const shown = files.slice(0, 3).join(', ');
  const more = files.length > 3 ? ` and ${files.length - 3} more` : '';
  return `Couldn’t import ${shown}${more}. ${LIBRARY_FULL}`;
}

/**
 * Add or replace an entry by name (Zenith's Save sends the same auto again as it is edited),
 * newest first, capped. Returns the library as saved.
 *
 * ⚠️ THE CAP IS THE LAST LINE, NOT THE POLICY. Past it, the entry dropped is the OLDEST ONE THAT
 * IS NOT THE AUTO AUTO PLAYS: it used to be the oldest, full stop, and when that was the active
 * one `activeId` moved to the new, unreviewed file with `enabled` still on. A caller that must not
 * lose anything asks `libraryHasRoom` first.
 */
export function upsertAuto(lib: GameAutoLibrary, entry: Omit<AutoLibraryEntry, 'id'> & { id?: string }): GameAutoLibrary {
  const existing = lib.entries.find((e) => (entry.id ? e.id === entry.id : e.name === entry.name));
  const id = existing?.id ?? entry.id ?? newAutoId();
  const next: AutoLibraryEntry = { ...entry, id };
  const entries = [next, ...lib.entries.filter((e) => e.id !== id)];
  while (entries.length > AUTO_LIBRARY_MAX) {
    let drop = entries.length - 1;
    while (drop > 1 && entries[drop].id === lib.activeId) drop--;
    entries.splice(drop, 1);
  }
  const activeId = lib.activeId && entries.some((e) => e.id === lib.activeId) ? lib.activeId : id;
  return { entries, activeId, enabled: lib.enabled };
}

/**
 * IMPORT SEVERAL FILES (the Autonomous panel's Import, `AutonomousSetup.tsx`). Each is added or,
 * when the library holds an auto of that name, REPLACES it; a NEW name into a full library is
 * refused and its FILE is listed in `refused` instead (the panel says so with `libraryFullFor`).
 * Without the check `upsertAuto`'s cap dropped the oldest auto in silence, and the second file of a
 * multi-file import could drop the first. `items` are files the caller already parsed.
 */
export function importAutos(
  lib: GameAutoLibrary,
  items: readonly { file: string; name: string; auto: string; waypoints?: string }[],
  now: number = Date.now(),
): { lib: GameAutoLibrary; added: string[]; refused: string[] } {
  let next = lib;
  const added: string[] = [];
  const refused: string[] = [];
  for (const it of items) {
    if (!libraryHasRoom(next, it.name)) {
      refused.push(it.file);
      continue;
    }
    next = upsertAuto(next, {
      name: it.name,
      auto: it.auto,
      ...(it.waypoints ? { waypoints: it.waypoints } : {}),
      source: 'file',
      savedAt: now,
    });
    added.push(it.name);
  }
  return { lib: next, added, refused };
}

/** What a delete took out: enough for Undo to put it back where it was, and as the auto AUTO plays. */
export interface RemovedAuto {
  entry: AutoLibraryEntry;
  index: number;
  /** it was the auto AUTO plays (`activeId`), switched on or not */
  wasActive: boolean;
  /** `enabled` as it was, which only matters when `wasActive` */
  wasEnabled: boolean;
}

/** Delete one entry. The library has no active auto after it when that was the active one. */
export function removeAuto(lib: GameAutoLibrary, id: string): { lib: GameAutoLibrary; removed: RemovedAuto } | null {
  const index = lib.entries.findIndex((e) => e.id === id);
  if (index < 0) return null;
  const wasActive = lib.activeId === id;
  const activeId = wasActive ? null : lib.activeId;
  return {
    lib: { entries: lib.entries.filter((e) => e.id !== id), activeId, enabled: lib.enabled && activeId !== null },
    removed: { entry: lib.entries[index], index, wasActive, wasEnabled: lib.enabled },
  };
}

/**
 * UNDO a delete, against the library AS IT IS NOW (an import or a Save may have landed since): back
 * at its index, and as the auto AUTO plays only if it was and nothing else has taken that since. It
 * is refused, with a sentence, when the library is full or an auto of that name is in it now.
 */
export function restoreAuto(lib: GameAutoLibrary, r: RemovedAuto): { ok: true; lib: GameAutoLibrary } | { ok: false; error: string } {
  if (lib.entries.some((e) => e.id === r.entry.id || e.name === r.entry.name)) {
    return { ok: false, error: `Couldn’t restore ${r.entry.name}. The library has an auto with that name now.` };
  }
  if (lib.entries.length >= AUTO_LIBRARY_MAX) return { ok: false, error: `Couldn’t restore ${r.entry.name}. ${LIBRARY_FULL}` };
  const entries = [...lib.entries];
  entries.splice(Math.min(r.index, entries.length), 0, r.entry);
  const takes = r.wasActive && lib.activeId === null;
  return { ok: true, lib: { entries, activeId: takes ? r.entry.id : lib.activeId, enabled: takes ? r.wasEnabled : lib.enabled } };
}
