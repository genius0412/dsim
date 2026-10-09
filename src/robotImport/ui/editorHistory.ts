/**
 * UNDO AND REDO IN THE IMPORT EDITOR, DOM-free so `npm test` can hold it.
 *
 * The history is two stacks of `EditorDoc` snapshots: `past` holds the document as it was before
 * each of the player's edits, `future` what an undo took back. Only the PLAYER's edits go on it. What
 * the editor does by itself (placements defaulting in, the moving parts found, a step change, a
 * re-read putting back what it kept) is an `'auto'` edit: applied, never recorded, and it leaves the
 * redo stack alone, so an effect that runs again after an undo neither adds a step nor eats the redo.
 *
 * Quick repeats of the same thing are ONE step: an edit with a `key` joins the last one when it has
 * the same key and came within `COALESCE_MS` of it (a handle dragged, a slider, a name typed). An
 * undo or a redo ends that, so the next edit is a step of its own.
 *
 * An undo restores the player's half of the document only (`restoreDoc`): the setup, the placements
 * and the spec. The rest belongs to the file (its name, what was detected, the reader's notes), to
 * the screen (the step: an undo does not move the player to another step), or to the model in memory
 * (the Detail it was read at, see `restoreDoc`).
 *
 * The history lives on the live draft (`LiveDraft.history`), in memory only: it outlives a test
 * drive, not a reload, and a new file or another library robot starts it empty.
 */
import type { ImportedMech } from '../../types';
import type { ImportSetup, MotionGroup } from '../types';
import { COPY } from './copy';
import type { EditorDoc } from './editorModel';

/** the most steps kept; the oldest goes first */
export const HISTORY_CAP = 100;
/** edits with one key this close together are one step, ms (measured from the last of them) */
export const COALESCE_MS = 600;

export interface HistoryEntry<T> {
  doc: T;
  /** what the edit did, for the button's title ("move the launcher"); null when unnamed */
  label: string | null;
}

export interface History<T> {
  past: readonly HistoryEntry<T>[];
  future: readonly HistoryEntry<T>[];
  /** the last edit recorded, while a repeat of it can still join it */
  open: { key: string; at: number } | null;
}

/** one of the player's edits: a label for the Undo button, and a key that joins quick repeats */
export interface Edit {
  label?: string;
  key?: string;
}

/** how an edit to the document is applied: the player's (`Edit`), or the editor's own (`'auto'`) */
export type EditHow = Edit | 'auto';

export type EditorHistory = History<EditorDoc>;

export function emptyHistory<T>(): History<T> {
  return { past: [], future: [], open: null };
}

/** the step an undo would take back, or null */
export function nextUndo<T>(h: History<T> | undefined): HistoryEntry<T> | null {
  return h?.past.length ? h.past[h.past.length - 1] : null;
}

/** the step a redo would put back, or null */
export function nextRedo<T>(h: History<T> | undefined): HistoryEntry<T> | null {
  return h?.future.length ? h.future[h.future.length - 1] : null;
}

const capped = <T>(past: readonly HistoryEntry<T>[]): readonly HistoryEntry<T>[] =>
  past.length > HISTORY_CAP ? past.slice(past.length - HISTORY_CAP) : past;

/** an edit at `now` joins the last step: the same key, within `COALESCE_MS` of the last edit of it */
export function joins<T>(h: History<T>, edit: Edit, now: number): boolean {
  return edit.key !== undefined && h.open?.key === edit.key && now - h.open.at <= COALESCE_MS && h.past.length > 0;
}

/**
 * Record an edit made at `now` to a document that was `before`. A new edit clears the redo stack.
 * One that `joins` the last step adds none of its own.
 */
export function record<T>(h: History<T>, before: T, edit: Edit, now: number): History<T> {
  const open = edit.key !== undefined ? { key: edit.key, at: now } : null;
  if (joins(h, edit, now)) return { past: h.past, future: [], open };
  return { past: capped([...h.past, { doc: before, label: edit.label ?? null }]), future: [], open };
}

/** take back the last step from `current`: the snapshot to restore, and the history after */
export function undo<T>(h: History<T>, current: T): { doc: T; history: History<T> } | null {
  const e = nextUndo(h);
  if (!e) return null;
  return { doc: e.doc, history: { past: h.past.slice(0, -1), future: [...h.future, { doc: current, label: e.label }], open: null } };
}

/** put back the last step taken back */
export function redo<T>(h: History<T>, current: T): { doc: T; history: History<T> } | null {
  const e = nextRedo(h);
  if (!e) return null;
  return { doc: e.doc, history: { past: capped([...h.past, { doc: current, label: e.label }]), future: h.future.slice(0, -1), open: null } };
}

// ---- the editor's document -------------------------------------------------------------------

/** the same document, the edit time aside (an edit that changes nothing records nothing) */
export function sameDoc(a: EditorDoc, b: EditorDoc): boolean {
  return JSON.stringify({ ...a, updated: 0 }) === JSON.stringify({ ...b, updated: 0 });
}

/**
 * What an undo or a redo puts back: `target`'s setup, placements and spec, on `current`. The Detail
 * (`setup.triBudget`) stays `current`'s. A Detail change RE-READS the file, which can take minutes
 * for a big STEP, and the model in memory is not part of the document, so it is not an edit the
 * history can take back: the snapshots keep whatever Detail they were taken at, and restoring that
 * number without re-reading would leave the Detail control naming a detail the model was not read
 * at. Everything else the history holds is valid at either detail: placements and wheels are in the
 * model frame, and the moving parts name the file's own bodies.
 */
export function restoreDoc(target: EditorDoc, current: EditorDoc): EditorDoc {
  const setup = { ...target.setup, triBudget: current.setup.triBudget };
  // ⚠️ except the DELETED parts: a big STEP is read in pieces and Light leaves its small parts out, so
  // a body id names another solid at the other Detail. A snapshot from before a Detail change keeps
  // the deletions the model in memory was read with (`docs/area/robot-import.md`, "Deleting parts").
  if (target.setup.triBudget !== current.setup.triBudget) {
    setup.removed = current.setup.removed;
    setup.keepFloating = current.setup.keepFloating;
    if (setup.removed === undefined) delete setup.removed;
    if (setup.keepFloating === undefined) delete setup.keepFloating;
  }
  return {
    ...current,
    setup,
    mech: target.mech,
    spec: target.spec,
  };
}

/**
 * Apply `fn` to `doc` at `now`. The player's edit is recorded (null when it changes nothing); an
 * `'auto'` one is applied and the history is returned as it was. A run of joined edits that ends
 * where it began (a handle grabbed and put back) leaves no step.
 */
export function applyEdit(
  doc: EditorDoc,
  history: EditorHistory | undefined,
  fn: (d: EditorDoc) => EditorDoc,
  how: EditHow,
  now: number,
): { doc: EditorDoc; history: EditorHistory | undefined } | null {
  const next = { ...fn(doc), updated: now };
  if (how === 'auto') return { doc: next, history };
  if (sameDoc(doc, next)) return null;
  const h0 = history ?? emptyHistory<EditorDoc>();
  const h = record(h0, doc, how, now);
  const start = nextUndo(h);
  if (joins(h0, how, now) && start && sameDoc(start.doc, next)) return { doc: next, history: { past: h.past.slice(0, -1), future: [], open: null } };
  return { doc: next, history: h };
}

/** undo on the document: null when there is nothing to undo */
export function undoDoc(doc: EditorDoc, history: EditorHistory | undefined, now: number): { doc: EditorDoc; history: EditorHistory } | null {
  const r = history ? undo(history, doc) : null;
  return r ? { doc: { ...restoreDoc(r.doc, doc), updated: now }, history: r.history } : null;
}

/** redo on the document: null when there is nothing to redo */
export function redoDoc(doc: EditorDoc, history: EditorHistory | undefined, now: number): { doc: EditorDoc; history: EditorHistory } | null {
  const r = history ? redo(history, doc) : null;
  return r ? { doc: { ...restoreDoc(r.doc, doc), updated: now }, history: r.history } : null;
}

// ---- what each edit is called ----------------------------------------------------------------

/** a control's label as a name in a sentence: "Front intake" → "front intake"; "Box Tube" stays */
export function lowerFirst(s: string): string {
  return /\s[A-Z]/.test(s) || !s ? s : s[0].toLowerCase() + s.slice(1);
}

/** the Model step's units, up axis, turns and Use detected wheels */
export function setupEdit(patch: Partial<ImportSetup>): Edit {
  if ('yaw' in patch) return { label: COPY.edits.turn };
  if ('up' in patch) return { label: COPY.edits.up };
  if ('units' in patch) return { label: COPY.edits.units };
  return { label: COPY.edits.useDetected };
}

const DRIVE_LABEL: Record<string, string> = {
  drivetrain: COPY.drivetrain,
  motor: COPY.motor,
  externalRatio: COPY.extRatio,
  tankExternalRatio: COPY.tankRatio,
  massLb: COPY.weight,
  wheel: COPY.wheel,
};

/** a Drivetrain step field; a typed number joins the next of the same field */
export function driveEdit(patch: object): Edit {
  const keys = Object.keys(patch).sort();
  const named = keys.find((k) => DRIVE_LABEL[k]);
  return { label: COPY.edits.change(lowerFirst(named ? DRIVE_LABEL[named] : COPY.drivetrain)), key: `drive:${keys.join()}` };
}

/** a placement handle (as `MechHandleDef`): which one moved, by its label */
export interface MechHandleName {
  key: string;
  field: 'intake' | 'shooter' | 'shooter2' | 'place';
  edge?: string;
  label: string;
}

/** which placement changed between `prev` and `next`: a drag of one handle is one step */
export function mechEdit(prev: ImportedMech | null, next: ImportedMech, handles: readonly MechHandleName[]): Edit {
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const h of handles) {
    const name = lowerFirst(h.label);
    if (h.field === 'intake') {
      if (!same(prev?.intakes?.find((i) => i.edge === h.edge), next.intakes?.find((i) => i.edge === h.edge))) return { label: COPY.edits.move(name), key: `mech:${h.key}` };
      continue;
    }
    if (!same(prev?.[h.field], next[h.field])) return { label: COPY.edits.move(name), key: `mech:${h.key}` };
    if (h.field === 'shooter' && prev?.shooterYawDeg !== next.shooterYawDeg) return { label: COPY.edits.aim(name), key: `mech:${h.key}:aim` };
  }
  return { label: COPY.edits.placement, key: 'mech' };
}

/** a Moving parts edit: a row added or removed, else the first row that changed (by its name) */
export function motionEdit(prev: readonly MotionGroup[], next: readonly MotionGroup[], names: readonly string[]): Edit {
  if (next.length > prev.length) return { label: COPY.edits.addMoving };
  const i = prev.findIndex((g, j) => JSON.stringify(g) !== JSON.stringify(next[j]));
  if (i < 0) return {};
  const name = lowerFirst(names[i] ?? COPY.motionRole(prev[i].role, prev[i].corner));
  return { label: next.length < prev.length ? COPY.edits.removeMoving(name) : COPY.edits.change(name) };
}

// ---- the keys --------------------------------------------------------------------------------

/** the shortcut a key press asks for: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z and Ctrl+Y redo */
export function historyShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): 'undo' | 'redo' | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (k === 'y' && e.ctrlKey && !e.shiftKey) return 'redo';
  return null;
}

/** inputs with no text of their own to undo: the shortcut is the editor's there */
const NO_TEXT = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'color', 'image']);

/**
 * Focus is in something with its own undo (a text or number field, a select, an editable region):
 * the shortcut is left to the browser there. A checkbox or a slider has none, so it is the editor's.
 */
export function ownsUndo(el: { tagName?: string; type?: string; isContentEditable?: boolean } | null): boolean {
  if (!el?.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select' || el.isContentEditable) return true;
  return tag === 'input' && !NO_TEXT.has((el.type ?? 'text').toLowerCase());
}
