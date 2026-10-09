/**
 * The few things the robot page and the lazy importer hand each other, in the MAIN chunk so
 * neither has to load the other to say them. Module state on purpose: none of it is a preference
 * (nothing here belongs in `GameSettings`), and none of it should survive a reload.
 *
 *  - FILES dropped on the "Import a robot" card, for the editor to read when it mounts.
 *  - A NOTICE ("Saved Ironclad.") for the robot page to show once in the Start from title.
 *  - LIBRARY CHANGES, so every view of the library (the row, the hero, the panel, another tab)
 *    re-reads it after a save, rename, duplicate or delete.
 */

let handed: File[] | null = null;

/** files dropped on the robot page's add card, for the editor to pick up */
export function handOffFiles(files: File[]): void {
  handed = files.length ? files : null;
}

/** the handed files, once */
export function takeHandedFiles(): File[] | null {
  const f = handed;
  handed = null;
  return f;
}

let notice: string | null = null;

/** a one-line confirmation for the robot page ("Saved Ironclad.") */
export function postRobotNotice(text: string): void {
  notice = text;
  for (const fn of noticeListeners) fn();
}

/** the posted notice, without taking it (a render must not consume: StrictMode renders twice) */
export function peekRobotNotice(): string | null {
  return notice;
}

/** the posted notice, once */
export function takeRobotNotice(): string | null {
  const n = notice;
  notice = null;
  return n;
}

const noticeListeners = new Set<() => void>();
export function onRobotNotice(fn: () => void): () => void {
  noticeListeners.add(fn);
  return () => noticeListeners.delete(fn);
}

// ---- library changes -----------------------------------------------------------------------

const CHANNEL = 'dsim-robot-library';
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function ensureChannel(): void {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = () => {
      for (const fn of listeners) fn();
    };
  } catch {
    channel = null;
  }
}

/** tell every reader of the library (this tab and the others) to look again */
export function libraryChanged(): void {
  for (const fn of listeners) fn();
  ensureChannel();
  try {
    channel?.postMessage(1);
  } catch {
    /* a closed channel: this tab already heard */
  }
}

export function onLibraryChange(fn: () => void): () => void {
  ensureChannel();
  listeners.add(fn);
  return () => listeners.delete(fn);
}
