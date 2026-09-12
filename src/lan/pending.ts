/**
 * HOW A TAB-HOSTED LAN ROOM REACHES THE LOBBY SCREEN.
 *
 * Every other room the lobby opens is named by a URL — `roomServerUrl()` answers with the
 * cloud or with a LAN box, the lobby builds a `WebSocketTransport`, done. A WebRTC LAN room has
 * no URL: it is reached through a handshake that has already happened by the time the player
 * gets to the lobby, and what comes out of that handshake is a live `Transport` object.
 *
 * So the LAN screen leaves one here and navigates, and the lobby picks it up. Deliberately the
 * same shape as `setLanServer()` / `lanActive()` in `src/net/env.ts` — module state that one
 * screen writes and another reads — because the alternative is threading a `Transport` through
 * `App.tsx`'s screen union and every component between, to carry a value that is only ever
 * non-null for the one navigation that just happened.
 *
 * ⚠️ **IT IS TAKEN, NOT READ.** `take` clears as it returns, so a transport is consumed exactly
 * once. A lobby that re-mounts (a remount, a back-and-forward, a StrictMode double-invoke) must
 * not silently adopt a connection that belongs to a session the player already left — it gets
 * nothing and falls back to the ordinary URL path, which fails visibly.
 */
import type { Transport } from '../net/transport';

export interface PendingLanRoom {
  transport: Transport;
  /** the room code both ends agreed on, so the lobby can display and join it */
  code: string;
  /** true when this tab is the one running the room */
  hosting: boolean;
}

let pending: PendingLanRoom | null = null;

export function setPendingLanRoom(room: PendingLanRoom): void {
  pending = room;
}

/** consume the pending room, if there is one. Clears as it returns — see the header. */
export function takePendingLanRoom(): PendingLanRoom | null {
  const p = pending;
  pending = null;
  return p;
}

/** drop a pending room without using it (the player backed out before the lobby mounted) */
export function clearPendingLanRoom(): void {
  pending?.transport.close();
  pending = null;
}
