import type { Transport } from '../net/transport';

/**
 * THE SOCKET, HANDED BACK FROM A FINISHED MATCH TO THE ROOM'S OWN LOBBY.
 *
 * When the host recycles a room the server clears its world and everyone belongs in the
 * lobby again — but the server still holds each player's seat, so the client must NOT drop
 * its connection and dial in again. Re-joining would spend a seat it already owns, take a
 * new `clientId`, and lose the room outright if somebody filled it in between.
 *
 * So the live `Transport` travels from the `ServerSession` to the `Lobby` as a value. It is
 * carried in App state rather than a module singleton (unlike `src/lan/pending.ts`, whose
 * producer and consumer are two screens that never share a parent) because the App owns both
 * ends of this handover and can clear it in the same render that navigates.
 *
 * @see `ServerSession.release` — gives the socket up without closing it
 * @see `LobbyClient.resume` — adopts it without sending a `join`
 */
export interface ResumedRoom {
  transport: Transport;
  /** the room code, so the lobby shows and shares the same one */
  code: string;
  /** which machine the room is on — the lobby locks its picker to it, as an invite does */
  region?: string;
  /** our seat's id on this socket, re-sent by the server with the recycle */
  clientId: string;
  /** THE SEAT'S SECRET (protocol.ts `welcome`). No `welcome` is re-sent on this socket, so it
   * travels with the socket, or the room's next match is built with an empty token. */
  seatToken: string;
}
