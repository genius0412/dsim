/**
 * THE EDITOR'S DRAFTS — an import that has not been saved yet, in memory and on this device.
 *
 * In memory, a module singleton: the editor unmounts for a test drive and remounts on the way back,
 * and the lazy chunk this lives in stays loaded, so the remount finds the document, the model and
 * the baked pictures exactly as they were. On disk, IndexedDB (`library.ts`'s draft stores): the
 * document is rewritten 800 ms after the last edit, the simplified model once per file, so a reload
 * loses nothing either. A save or a discard deletes both.
 */
import type { PreparedModel } from '../engine/importerEngine';
import { deleteDraft, getDraft, putDraft, type DraftRecord, type LibraryError } from '../library';
import type { EditorHistory } from './editorHistory';
import type { EditorDoc } from './editorModel';

export interface LiveDraft {
  doc: EditorDoc;
  model: PreparedModel | null;
  /** the model has been written to IndexedDB under this key */
  modelStored: boolean;
  /** a bake of the current document, reused by test drive / save / export until it changes */
  baked: { stamp: string; mesh: Blob; top: Blob; thumb: Blob; trisOut: number } | null;
  /** the player's undo and redo (`editorHistory.ts`). Never written to disk: it lasts as long as
   *  this object, so it outlives a test drive but not a reload, and a new file starts without one */
  history?: EditorHistory;
}

const live = new Map<string, LiveDraft>();
const timers = new Map<string, number>();

export function liveDraft(key: string): LiveDraft | null {
  return live.get(key) ?? null;
}

/** the draft on disk, restored into memory (null when there is none) */
export async function restoreDraft(key: string): Promise<LiveDraft | null> {
  const have = live.get(key);
  if (have) return have;
  const got = await getDraft(key);
  if (!got.ok || !got.value) return null;
  const doc = got.value.state as unknown as EditorDoc;
  if (doc?.v !== 1 || !doc.setup) return null;
  const d: LiveDraft = { doc, model: got.value.model as PreparedModel, modelStored: true, baked: null };
  live.set(key, d);
  return d;
}

/** keep `d` in memory now and on disk shortly */
export function keepDraft(d: LiveDraft): void {
  // a draft that is new here starts with a clean slate: a failure said about an earlier one (or about a
  // robot since saved) must not show over it. It is said again by its own first failed write.
  if (!live.has(d.doc.key)) setFailure(null);
  live.set(d.doc.key, d);
  watchLifecycle();
  const key = d.doc.key;
  const t = timers.get(key);
  if (t) window.clearTimeout(t);
  timers.set(
    key,
    window.setTimeout(() => {
      timers.delete(key);
      void persist(key);
    }, 800),
  );
}

/**
 * WHY THE LAST DRAFT WRITE FAILED, or null while writes land. A draft is one transaction (the document
 * and, the first time, the model), so a full device (`quota`) keeps NEITHER, and every later edit tries
 * again and fails the same way. The write used to log and nothing else: the player edited for as long as
 * they liked, then lost it all on a reload (a mobile tab discarded) with nothing said beforehand. The
 * editor subscribes (`onDraftSaveFailure`) and says so.
 */
let failure: LibraryError | null = null;
const failureListeners = new Set<(e: LibraryError | null) => void>();

/**
 * Be told when drafts stop being written (`LibraryError`) and when they start again (null). Told ONCE
 * per change, not once per failed write, and told the current state on subscribing: the editor
 * unmounts for a test drive and comes back to a store that is still failing. Returns the unsubscribe.
 */
export function onDraftSaveFailure(fn: (e: LibraryError | null) => void): () => void {
  failureListeners.add(fn);
  if (failure) fn(failure);
  return () => {
    failureListeners.delete(fn);
  };
}

function setFailure(next: LibraryError | null): void {
  if (next === failure) return;
  failure = next;
  failureListeners.forEach((f) => f(next));
}

/** the write in flight per draft, so a flush that finds nothing pending can still wait for it */
const writing = new Map<string, Promise<boolean>>();

function persist(key: string): Promise<boolean> {
  const p = write(key);
  writing.set(key, p);
  void p.finally(() => {
    if (writing.get(key) === p) writing.delete(key);
  });
  return p;
}

/**
 * A saved robot that was only OPENED for edit, never touched and never stored: the library holds all of
 * it, so writing it was a draft of nothing. Every open wrote the whole document (and, at Full detail,
 * tens of MB of model) 800 ms later, and every later open then "restored unsaved changes" that were
 * none (merge audit RI-02). Nothing is lost by not writing it, and `flushDraft` counts it as safe to
 * forget (the way back reads the library record again).
 */
function untouched(d: LiveDraft): boolean {
  return !!d.doc.editId && !d.doc.edited && !d.modelStored;
}

/** resolves true when the write landed (or there was nothing to write: no model yet, or nothing changed) */
async function write(key: string): Promise<boolean> {
  const d = live.get(key);
  if (!d || !d.model || untouched(d)) return true;
  const record = { ...d.doc, updated: Date.now() } as unknown as DraftRecord;
  const r = await putDraft(record, d.modelStored ? undefined : d.model);
  if (r.ok) {
    d.modelStored = true;
    setFailure(null);
    return true;
  }
  console.warn('[import] draft not saved', r.message);
  setFailure(r.error);
  return false;
}

/**
 * Write now (the editor is leaving, or the tab is going away). Resolves true when forgetting the
 * in-memory copy loses nothing: the write landed, or there is nothing pending and the draft is already
 * on this device. False while a write is failing or the model has not been stored, so the caller keeps
 * the live copy for a way back in the same session.
 */
export function flushDraft(key: string): Promise<boolean> {
  const t = timers.get(key);
  if (t) {
    window.clearTimeout(t);
    timers.delete(key);
    return persist(key);
  }
  // a write already begun (the Back button flushed, then the editor unmounted) is the answer
  const begun = writing.get(key);
  if (begun) return begun;
  const d = live.get(key);
  return Promise.resolve(!d || !d.model || untouched(d) || (d.modelStored && failure === null));
}

/** let the in-memory copy go (the draft on this device stays): the editor left for good and it is stored */
export function forgetLiveDraft(key: string): void {
  live.delete(key);
}

/**
 * THE LAST 800 ms OF EDITS (IMPUI-06): a draft is written 800 ms after the last edit, so a tab closed,
 * a phone tab swiped away or a browser quit within that window lost them. Every draft with a write
 * pending is written when the page is hidden or goes away. Best effort (an IndexedDB write begun in
 * `pagehide` usually completes); attached once, by the first draft kept.
 */
let watching = false;
function watchLifecycle(): void {
  if (watching) return;
  watching = true;
  const flushAll = (): void => {
    for (const k of [...timers.keys()]) void flushDraft(k);
  };
  try {
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushAll();
      });
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', flushAll);
  } catch {
    /* no page to watch (a test, a worker): the debounce alone */
  }
}

/** forget a draft everywhere (saved, or discarded) */
export async function dropDraft(key: string): Promise<void> {
  const t = timers.get(key);
  if (t) window.clearTimeout(t);
  timers.delete(key);
  live.delete(key);
  // what was said about this draft's writes goes with it (a saved robot has no draft to lose)
  setFailure(null);
  await deleteDraft(key);
}
