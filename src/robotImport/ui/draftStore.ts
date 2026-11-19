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
  live.set(d.doc.key, d);
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

async function persist(key: string): Promise<void> {
  const d = live.get(key);
  if (!d || !d.model) return;
  const record = { ...d.doc, updated: Date.now() } as unknown as DraftRecord;
  const r = await putDraft(record, d.modelStored ? undefined : d.model);
  if (r.ok) {
    d.modelStored = true;
    setFailure(null);
  } else {
    console.warn('[import] draft not saved', r.message);
    setFailure(r.error);
  }
}

/** write now (the editor is leaving) */
export function flushDraft(key: string): void {
  const t = timers.get(key);
  if (!t) return;
  window.clearTimeout(t);
  timers.delete(key);
  void persist(key);
}

/** forget a draft everywhere (saved, or discarded) */
export async function dropDraft(key: string): Promise<void> {
  const t = timers.get(key);
  if (t) window.clearTimeout(t);
  timers.delete(key);
  live.delete(key);
  await deleteDraft(key);
}
