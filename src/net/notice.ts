import { useSyncExternalStore } from 'react';

/**
 * Tiny global store for server-pushed notices (scheduled restarts / info) so any
 * screen can show a banner regardless of which net object (LobbyClient vs
 * ServerSession) currently owns the socket. Both write here on `serverNotice`.
 */
export interface ServerNotice {
  kind: 'restart' | 'info';
  message: string;
  /** epoch ms the restart lands (drives the countdown); omitted for plain info */
  until?: number;
}

let current: ServerNotice | null = null;
const subs = new Set<() => void>();
const emit = (): void => subs.forEach((f) => f());

export function setServerNotice(n: ServerNotice | null): void {
  current = n;
  emit();
}
export function getServerNotice(): ServerNotice | null {
  return current;
}

/** React hook: the current notice, auto-cleared once its `until` has passed. */
export function useServerNotice(): ServerNotice | null {
  const n = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    getServerNotice,
    getServerNotice,
  );
  return n;
}
