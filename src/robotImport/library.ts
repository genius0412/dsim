/**
 * ROBOT IMPORT — THE LIBRARY: imported robots on this device (plan §3.2). IndexedDB, no three.js.
 *
 * Two object stores so a list never touches a mesh: `robots` holds each `LibraryEntry` (the spec,
 * the setup, the source facts; keyPath `id`, index `game`) and `files` holds the three blobs
 * under `<id>:mesh`, `<id>:top` and `<id>:thumb`. Every write that touches both is one
 * transaction, so a crash cannot leave a robot without its mesh.
 *
 * Every call resolves (never rejects) to a `LibraryResult`: IndexedDB is missing in some private
 * windows and embedded browsers, and a full disk is an ordinary event, so both come back as a
 * plain sentence the UI can show. The database name is registered in `src/storageKeys.ts`.
 */
import { ROBOT_LIBRARY_DB } from '../storageKeys';
import type { GameId, ImportedRobot } from '../types';
import type { LibraryEntry, LibraryRobot } from './types';
import { libraryEntryFor } from './libraryIds';

/** 2 added the two DRAFT stores (lane 4, the editor): `drafts` holds an unfinished import's editor
 *  state (keyPath `key`, index `game`), `draftModels` its simplified source-frame model, written
 *  once per file so an edit rewrites only the small state row. */
const DB_VERSION = 2;
const ROBOTS = 'robots';
const FILES = 'files';
const DRAFTS = 'drafts';
const DRAFT_MODELS = 'draftModels';
const KINDS = ['mesh', 'top', 'thumb'] as const;
/** the lighter mesh the room relay sends when the stored one is over its cap (`meshLite`); optional, never required */
const LITE = 'meshLite' as const;
type FileKind = (typeof KINDS)[number];
const fileKey = (id: string, kind: FileKind | typeof LITE): string => `${id}:${kind}`;

export type LibraryError = 'unavailable' | 'quota' | 'not-found' | 'failed';
export type LibraryResult<T> = { ok: true; value: T } | { ok: false; error: LibraryError; message: string };

const MESSAGES: Record<LibraryError, string> = {
  unavailable:
    'Couldn’t open the robot library on this device. Private browsing can block it; imported robots need a normal window.',
  quota: 'Couldn’t save the robot: this device is out of storage space for DSIM. Delete an imported robot and try again.',
  'not-found': 'Couldn’t find that robot in the library. It may have been deleted in another tab.',
  failed: 'Couldn’t update the robot library. Reload the page and try again.',
};

const err = <T>(error: LibraryError): LibraryResult<T> => ({ ok: false, error, message: MESSAGES[error] });
const ok = <T>(value: T): LibraryResult<T> => ({ ok: true, value });

/** 16 lowercase hex chars, the `ImportedRobot.id` shape */
export function newRobotId(): string {
  const bytes = new Uint8Array(8);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const ROBOT_ID_RX = /^[0-9a-f]{16}$/;

function classify(e: unknown): LibraryError {
  const name = (e as { name?: string } | null)?.name ?? '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return 'quota';
  if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'UnknownError') return 'unavailable';
  return 'failed';
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** whether this browser has IndexedDB at all (it can still refuse to open) */
export function libraryAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (!libraryAvailable()) return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(ROBOT_LIBRARY_DB, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROBOTS)) {
        const s = db.createObjectStore(ROBOTS, { keyPath: 'id' });
        s.createIndex('game', 'game', { unique: false });
      }
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
      if (!db.objectStoreNames.contains(DRAFTS)) {
        const d = db.createObjectStore(DRAFTS, { keyPath: 'key' });
        d.createIndex('game', 'game', { unique: false });
      }
      if (!db.objectStoreNames.contains(DRAFT_MODELS)) db.createObjectStore(DRAFT_MODELS);
    };
    req.onsuccess = () => {
      const db = req.result;
      // another tab upgrading the schema: let it, and reopen next time
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  // a failed open is retried on the next call rather than cached forever
  void dbPromise.then((db) => {
    if (!db) dbPromise = null;
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<LibraryError | null> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(null);
    tx.onerror = () => resolve(classify(tx.error));
    tx.onabort = () => resolve(classify(tx.error));
  });
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/**
 * ⚠️ LOOKING MUST NOT CREATE THE DATABASE. `indexedDB.open` creates a database that is not there,
 * and the renderers ask the library for a picture the first time ANY imported robot is drawn: a
 * viewer in a custom room who never imported anything got an empty `decodesim.robots` (four
 * stores) for looking at somebody else's robot, and so did every visit to Configure ▸ Robot. So a
 * READ asks whether the database exists first and answers "nothing here" when it does not; only a
 * write (a save, a draft) creates it.
 *
 * `indexedDB.databases()` answers where it exists (Chromium, Safari 14+, Firefox 126+). Elsewhere
 * the database is opened WITHOUT a version: a missing one comes back as an upgrade from version 0,
 * and aborting that upgrade leaves it missing. Either way the answer `'no'` is not cached (another
 * tab may create it), and `'yes'` becomes the open connection.
 */
async function dbExists(): Promise<'yes' | 'no' | 'unavailable'> {
  if (!libraryAvailable()) return 'unavailable';
  const idb = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
  if (typeof idb.databases === 'function') {
    try {
      return (await idb.databases()).some((d) => d.name === ROBOT_LIBRARY_DB) ? 'yes' : 'no';
    } catch {
      /* a browser that has the method and refuses it: ask the other way */
    }
  }
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = idb.open(ROBOT_LIBRARY_DB);
    } catch {
      return resolve('unavailable');
    }
    let answered = false;
    const answer = (a: 'yes' | 'no' | 'unavailable'): void => {
      if (!answered) resolve(a);
      answered = true;
    };
    req.onupgradeneeded = (e) => {
      if ((e as IDBVersionChangeEvent).oldVersion !== 0) return;
      // it was not there: abort the version change, which takes the new database away again
      answer('no');
      try {
        req.transaction?.abort();
      } catch {
        /* already finishing */
      }
    };
    req.onsuccess = () => {
      req.result.close();
      answer('yes');
    };
    // the abort above lands here as an AbortError, after the answer
    req.onerror = () => answer('unavailable');
    req.onblocked = () => answer('yes');
  });
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<LibraryResult<T>>, absent?: () => LibraryResult<T>): Promise<LibraryResult<T>> {
  // a READ (`absent` given) of a database this device never made is answered without making it
  if (absent && !dbPromise) {
    const there = await dbExists();
    if (there === 'no') return absent();
    if (there === 'unavailable') return err('unavailable');
  }
  const db = await openDb();
  if (!db) return err('unavailable');
  try {
    return await fn(db);
  } catch (e) {
    return err(classify(e));
  }
}

/** for a READ: open the database only if it exists (see `dbExists`); null when it does not */
async function dbIfThere(): Promise<IDBDatabase | null> {
  if (!dbPromise && (await dbExists()) !== 'yes') return null;
  return openDb();
}

const entryOf = (r: LibraryRobot | LibraryEntry): LibraryEntry => ({
  id: r.id,
  game: r.game,
  spec: r.spec,
  source: r.source,
  setup: r.setup,
  ...(r.sharedFrom ? { sharedFrom: r.sharedFrom } : {}),
  created: r.created,
  updated: r.updated,
});

/** the library's robots for one game (or all), newest first, without their blobs */
export function listRobots(game?: GameId): Promise<LibraryResult<LibraryEntry[]>> {
  return withDb(async (db) => {
    const tx = db.transaction(ROBOTS, 'readonly');
    const store = tx.objectStore(ROBOTS);
    const rows = (await request(game ? store.index('game').getAll(game) : store.getAll())) as LibraryEntry[];
    rows.sort((a, b) => b.updated - a.updated || (a.id < b.id ? -1 : 1));
    return ok(rows.map(entryOf));
  }, () => ok([]));
}

/** one robot with its blobs */
export function getRobot(id: string): Promise<LibraryResult<LibraryRobot>> {
  return withDb(async (db) => {
    const tx = db.transaction([ROBOTS, FILES], 'readonly');
    const entry = (await request(tx.objectStore(ROBOTS).get(id))) as LibraryEntry | undefined;
    if (!entry) return err('not-found');
    const files = tx.objectStore(FILES);
    const [mesh, top, thumb, meshLite] = (await Promise.all([...KINDS, LITE].map((k) => request(files.get(fileKey(id, k)))))) as (Blob | undefined)[];
    if (!mesh || !top || !thumb) return err('not-found');
    return ok({ ...entryOf(entry), mesh, top, thumb, ...(meshLite ? { meshLite } : {}) });
  }, () => err('not-found'));
}

/** add or replace a robot (and its three blobs) in one transaction */
export function putRobot(robot: LibraryRobot): Promise<LibraryResult<LibraryEntry>> {
  return withDb(async (db) => {
    if (!ROBOT_ID_RX.test(robot.id)) return err('failed');
    const tx = db.transaction([ROBOTS, FILES], 'readwrite');
    const entry = entryOf(robot);
    tx.objectStore(ROBOTS).put(entry);
    const files = tx.objectStore(FILES);
    files.put(robot.mesh, fileKey(robot.id, 'mesh'));
    files.put(robot.top, fileKey(robot.id, 'top'));
    files.put(robot.thumb, fileKey(robot.id, 'thumb'));
    // a replaced mesh makes any cached lighter copy stale: it goes unless this save carries one
    if (robot.meshLite) files.put(robot.meshLite, fileKey(robot.id, LITE));
    else files.delete(fileKey(robot.id, LITE));
    const e = await done(tx);
    if (e) return err(e);
    topCache.clear(); // any id may answer through this robot (`answeringId`), not only its own
    return ok(entry);
  });
}

/** change a robot's name (`spec.name`) */
export function renameRobot(id: string, name: string): Promise<LibraryResult<LibraryEntry>> {
  return withDb(async (db) => {
    const tx = db.transaction(ROBOTS, 'readwrite');
    const store = tx.objectStore(ROBOTS);
    const entry = (await request(store.get(id))) as LibraryEntry | undefined;
    if (!entry) return err('not-found');
    const next: LibraryEntry = { ...entry, spec: { ...entry.spec, name: name.trim().slice(0, 64) }, updated: Date.now() };
    store.put(next);
    const e = await done(tx);
    return e ? err(e) : ok(next);
  }, () => err('not-found'));
}

/** a copy under a new id, named "<name> copy" */
export async function duplicateRobot(id: string): Promise<LibraryResult<LibraryEntry>> {
  const got = await getRobot(id);
  if (!got.ok) return got;
  const src = got.value;
  const nid = newRobotId();
  const now = Date.now();
  const spec = {
    ...src.spec,
    name: `${src.spec.name} copy`.slice(0, 64),
    ...(src.spec.imported ? { imported: { ...src.spec.imported, id: nid } } : {}),
  };
  // a copy is a robot of its own: it does not answer for the share file the original came from
  // (`sharedFrom`, read by `libraryEntryFor`), or the synced spec could resolve to either
  const { sharedFrom: _from, ...rest } = src;
  void _from;
  return putRobot({ ...rest, id: nid, spec, created: now, updated: now });
}

/** remove a robot and its blobs */
export function deleteRobot(id: string): Promise<LibraryResult<void>> {
  return withDb(async (db) => {
    const tx = db.transaction([ROBOTS, FILES], 'readwrite');
    tx.objectStore(ROBOTS).delete(id);
    const files = tx.objectStore(FILES);
    for (const k of [...KINDS, LITE]) files.delete(fileKey(id, k));
    const e = await done(tx);
    if (e) return err(e);
    topCache.clear();
    return ok(undefined);
  }, () => ok(undefined));
}

/**
 * The id of the record that ANSWERS for imported-robot `id` here (`libraryEntryFor`): `id` itself
 * when a robot has it, else a copy added from a share file that carried it. The account syncs the
 * active robot's spec and never its model, so a renderer or the room relay asking for the synced
 * id must find this device's copy whatever id it was saved under (`libraryIds.ts`).
 */
async function answeringId(db: IDBDatabase, id: string): Promise<string> {
  const store = db.transaction(ROBOTS, 'readonly').objectStore(ROBOTS);
  if ((await request(store.getKey(id))) !== undefined) return id;
  const rows = (await request(store.getAll())) as LibraryEntry[];
  rows.sort((a, b) => b.updated - a.updated || (a.id < b.id ? -1 : 1));
  return libraryEntryFor(rows, id)?.id ?? id;
}

async function fileFor(id: string, kind: FileKind | typeof LITE): Promise<Blob | null> {
  const db = await dbIfThere(); // a look, so it never creates the database (see `dbExists`)
  if (!db) return null;
  try {
    const rid = await answeringId(db, id);
    const tx = db.transaction(FILES, 'readonly');
    const blob = (await request(tx.objectStore(FILES).get(fileKey(rid, kind)))) as Blob | undefined;
    return blob ?? null;
  } catch {
    return null;
  }
}

/** the stored GLB for the 3D renderer (frame: `STORED_MESH_TO_ROBOT`), or null on this device */
export function meshFor(id: string): Promise<Blob | null> {
  return fileFor(id, 'mesh');
}

const topCache = new Map<string, Promise<Blob | null>>();

/** the top-down PNG for the 2D renderer (frame: `topImageFrame`), cached per id */
export function topFor(id: string): Promise<Blob | null> {
  let p = topCache.get(id);
  if (!p) {
    p = fileFor(id, 'top');
    topCache.set(id, p);
    void p.then((b) => {
      if (!b) topCache.delete(id);
    });
  }
  return p;
}

/** the card thumbnail */
export function thumbFor(id: string): Promise<Blob | null> {
  return fileFor(id, 'thumb');
}

/**
 * The descriptor (`spec.imported`) of the record that answers for `id` here, or null. The account
 * syncs the active robot's SPEC, so after an edit on another device this device's record (its mesh
 * and pictures) can be an OLDER version of the robot under the same id. A reader compares this with
 * the robot it is about to draw or send (`sameImportedRobot`) and uses the files only on a match:
 * the old model on the new hull is wrong in a way the footprint is not.
 */
export async function descriptorFor(id: string): Promise<ImportedRobot | null> {
  const db = await dbIfThere();
  if (!db) return null;
  try {
    const rid = await answeringId(db, id);
    const entry = (await request(db.transaction(ROBOTS, 'readonly').objectStore(ROBOTS).get(rid))) as LibraryEntry | undefined;
    return entry?.spec.imported ?? null;
  } catch {
    return null;
  }
}

// ---- drafts: an import the editor has not saved yet (lane 4) ---------------------------------
//
// Keyed `<game>:new` (a new import) or `<game>:<id>` (unsaved edits to a library robot). The state
// row is small and rewritten on every edit (debounced by the editor); the model is the simplified
// SOURCE-frame model, structured-cloned as is (typed arrays and all), written once per file. A
// reload restores both, so corrections still re-run from the source exactly as before.

/** an unfinished import's editor state. The editor owns the shape; the library stores it. */
export interface DraftRecord {
  key: string;
  game: GameId;
  updated: number;
  [field: string]: unknown;
}

/** drafts older than this are dropped the next time the list is read */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/** save a draft's state, and its model when `model` is given */
export function putDraft(state: DraftRecord, model?: unknown): Promise<LibraryResult<void>> {
  return withDb(async (db) => {
    const stores = model === undefined ? [DRAFTS] : [DRAFTS, DRAFT_MODELS];
    const tx = db.transaction(stores, 'readwrite');
    tx.objectStore(DRAFTS).put(state);
    if (model !== undefined) tx.objectStore(DRAFT_MODELS).put(model, state.key);
    const e = await done(tx);
    return e ? err(e) : ok(undefined);
  });
}

/** a draft's state and model (null when either is missing) */
export function getDraft(key: string): Promise<LibraryResult<{ state: DraftRecord; model: unknown } | null>> {
  return withDb(async (db) => {
    const tx = db.transaction([DRAFTS, DRAFT_MODELS], 'readonly');
    const state = (await request(tx.objectStore(DRAFTS).get(key))) as DraftRecord | undefined;
    if (!state) return ok(null);
    const model = await request(tx.objectStore(DRAFT_MODELS).get(key));
    return ok(model === undefined ? null : { state, model });
  }, () => ok(null));
}

/** the drafts for one game, without their models; prunes the stale ones */
export function listDrafts(game: GameId): Promise<LibraryResult<DraftRecord[]>> {
  return withDb(async (db) => {
    const tx = db.transaction([DRAFTS, DRAFT_MODELS], 'readwrite');
    const store = tx.objectStore(DRAFTS);
    const rows = (await request(store.index('game').getAll(game))) as DraftRecord[];
    const now = Date.now();
    const keep: DraftRecord[] = [];
    for (const r of rows) {
      if (now - r.updated > DRAFT_MAX_AGE_MS) {
        store.delete(r.key);
        tx.objectStore(DRAFT_MODELS).delete(r.key);
      } else keep.push(r);
    }
    const e = await done(tx);
    return e ? err(e) : ok(keep);
  }, () => ok([]));
}

/** remove a draft and its model */
export function deleteDraft(key: string): Promise<LibraryResult<void>> {
  return withDb(async (db) => {
    const tx = db.transaction([DRAFTS, DRAFT_MODELS], 'readwrite');
    tx.objectStore(DRAFTS).delete(key);
    tx.objectStore(DRAFT_MODELS).delete(key);
    const e = await done(tx);
    return e ? err(e) : ok(undefined);
  }, () => ok(undefined));
}

/** the lighter mesh for a room's relay (`liteMesh`), when one has been made for this robot */
export function meshLiteFor(id: string): Promise<Blob | null> {
  return fileFor(id, LITE);
}

/** cache the lighter mesh on the robot's record (a no-op when the robot is gone) */
export function putMeshLite(id: string, blob: Blob): Promise<LibraryResult<void>> {
  return withDb(async (db) => {
    const rid = await answeringId(db, id); // the relay asks by the synced id (see `answeringId`)
    const tx = db.transaction([ROBOTS, FILES], 'readwrite');
    const entry = (await request(tx.objectStore(ROBOTS).get(rid))) as LibraryEntry | undefined;
    if (!entry) return err('not-found');
    tx.objectStore(FILES).put(blob, fileKey(rid, LITE));
    const e = await done(tx);
    return e ? err(e) : ok(undefined);
  }, () => err('not-found'));
}
