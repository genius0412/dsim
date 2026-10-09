/**
 * WHICH LIBRARY RECORD IS THE ACTIVE ROBOT, ON THIS DEVICE — and which id a share file's robot
 * gets when it is added here. Main-safe and DOM-free: types only, so the robot page, the lobby and
 * the library (a lazy chunk) can all read the one rule, and the smoke suite can test it.
 *
 * ── THE TWO-DEVICE PROBLEM ──────────────────────────────────────────────────────────────────
 * The ACCOUNT syncs the active robot's SPEC (`settings.spec`, with `spec.imported`: id, hull,
 * mechanisms). It never syncs the model: the mesh and pictures live in each DEVICE's library,
 * keyed by `ImportedRobot.id`. So a robot made on device A arrives on device B as a spec whose id
 * B's library does not have ("Model not on this device"), and B's way to fix that is to import
 * the share file A exported.
 *
 * A share-file import used to ALWAYS mint a fresh id (`LibraryRobot.sharedFrom` keeps the file's),
 * because a room refuses two seats with one id and two teammates who load one file must be able
 * to sit together. But the add also made that robot ACTIVE, so B's fresh id synced back to the
 * account and A's own robot became "not on this device". Re-importing on A moved it back. The id
 * ping-ponged between the devices.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────────
 * 1. A record answers for an id when it HAS that id, or failing that, when it was added from a
 *    share file that carried it (`sharedFrom`). `libraryEntryFor` is that lookup, and every place
 *    that turns `spec.imported.id` into a library record uses it (the robot page, the lobby's
 *    picker, the renderers' assets, the relay's upload).
 * 2. Adding a share file whose robot IS the account's active robot (`sameImportedRobot`: the same
 *    descriptor, whatever its id) KEEPS THE ACTIVE ID. It is the same player's same robot arriving
 *    on another device; one player holds one seat, so the room's one-id-per-seat rule is not at
 *    stake, and the synced spec then resolves on both devices. A copy already here under another id
 *    (an older add) is replaced by it rather than kept beside it.
 * 3. Any other share file still gets a FRESH id per device (or, when this device already has the
 *    file's robot, the replace / keep-both question), exactly as before.
 * The descriptor and not the file's id decides (2), because a teammate's copy of a file has its
 * own id (3): their second device must adopt THEIR id, which the file does not carry.
 */
import type { ImportedRobot } from '../types';

/** the fields of a library row this rule reads (`LibraryEntry` has them) */
export interface LibraryIdRow {
  id: string;
  sharedFrom?: string;
}

/**
 * The record that answers for imported-robot `id` on this device: the one WITH that id, else the
 * first (the caller's order; the library lists newest first) that was added from a share file
 * carrying it. Null when neither is here.
 */
export function libraryEntryFor<E extends LibraryIdRow>(entries: readonly E[] | null | undefined, id: string | null | undefined): E | null {
  if (!entries || !id) return null;
  return entries.find((e) => e.id === id) ?? entries.find((e) => e.sharedFrom === id) ?? null;
}

/** does library row `e` answer for `id`? (`libraryEntryFor` over that one row) */
export function answersFor(e: LibraryIdRow, id: string | null | undefined): boolean {
  return !!id && (e.id === id || e.sharedFrom === id);
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** two descriptors of the SAME robot: everything but the id equal (hull, bands, height, mechanisms) */
export function sameImportedRobot(a: ImportedRobot | null | undefined, b: ImportedRobot | null | undefined): boolean {
  if (!a || !b) return false;
  // practice tuning is not the robot: a retune on one device must not make the other's model "out of date"
  return same({ ...a, id: '', tune: undefined }, { ...b, id: '', tune: undefined });
}

/**
 * The id an EDIT of library robot `editId` saves under. Its own, except for a copy that answers for
 * the account's active robot through `sharedFrom` (rule 1): a copy added from a share file BEFORE
 * rule 2 got a fresh id of its own, and saving it under that id made the edit the active robot under
 * a NEW id, which synced, and the device the robot came from then said "Model not on this device"
 * (the ping-pong rule 2 exists to stop, reached by editing). That copy saves under the ACTIVE id, and
 * the old record is retired by the caller. A record that HAS the active id, or that answers for
 * nothing active, keeps its own.
 */
export function editSaveId<E extends LibraryIdRow>(editId: string, activeId: string | null | undefined, entries: readonly E[]): string {
  if (!activeId || editId === activeId) return editId;
  return libraryEntryFor(entries, activeId)?.id === editId ? activeId : editId;
}

/** what adding a share file does on this device (see THE RULE above) */
export type ShareAddPlan<E extends LibraryIdRow> =
  /** the account's active robot: saved under `id` (the active one); `retire` is an older copy of it here under another id */
  | { kind: 'adopt'; id: string; retire: string | null }
  /** this device already has the file's robot under `have.id`: replace it, or keep both */
  | { kind: 'ask'; have: E }
  /** a new robot here: a fresh id */
  | { kind: 'fresh' };

/**
 * Plan the add of a share file whose robot is `file` (its descriptor, carrying the file's id),
 * given the account's active robot and this device's library rows. `specOf` reads a row's
 * descriptor (rows in the list carry their spec).
 */
export function planShareAdd<E extends LibraryIdRow>(
  file: ImportedRobot,
  active: ImportedRobot | null | undefined,
  entries: readonly E[],
  specOf: (e: E) => ImportedRobot | undefined,
): ShareAddPlan<E> {
  if (active && sameImportedRobot(file, active)) {
    const here = libraryEntryFor(entries, active.id);
    const retire = here && here.id !== active.id && sameImportedRobot(specOf(here), file) ? here.id : null;
    return { kind: 'adopt', id: active.id, retire };
  }
  const have = entries.find((e) => e.sharedFrom === file.id || e.id === file.id);
  return have ? { kind: 'ask', have } : { kind: 'fresh' };
}
