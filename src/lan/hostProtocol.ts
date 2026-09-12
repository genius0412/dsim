/**
 * The wire between the host's page and the Worker that runs its room.
 *
 * `RTCPeerConnection` does not exist in a Worker, so the two halves of a tab-hosted match live
 * on different threads by necessity: the PAGE owns the peer connections and the signalling
 * socket, and the WORKER owns the authoritative `Room`. This module is the only thing they
 * agree on.
 *
 * ⚠️ **`postMessage` carries STRINGS here, not decoded messages.** The room already encodes a
 * broadcast exactly once and hands every recipient the same string (`Client.sendRaw` in
 * `server/room.ts`, which exists because a 2v2 snapshot was otherwise stringified per
 * recipient). Decoding on the page just to re-encode per DataChannel would throw that away on
 * the one machine that can least afford it — the host is simulating AND rendering.
 */
import type { LobbyPlayer, RoomConfig } from '../net/protocol';

/**
 * The host's own seat id. Not a signalling peer id — it never crosses a network.
 *
 * It lives HERE rather than beside the runtime that uses it because the Worker needs it too:
 * the room reserves this id as its host the moment it is built, so the person who started the
 * room is its host even though they take their seat LAST. (They do: a host reads the code out,
 * guests join while they are still on the LAN screen, and `Room.add` hands the crown to the
 * first client through the door — which was a guest. Measured between two tabs: the host
 * arrived at its own room to be told it was waiting for the host to start.)
 */
export const HOST_SEAT = 'host-local';

/** page → worker */
export type HostIn =
  /** start a room. Sent once, before anything else. */
  | { k: 'open'; code: string; config: RoomConfig }
  /** a player arrived (the host itself included, as a loopback peer) */
  | { k: 'add'; id: string; player: Omit<LobbyPlayer, 'clientId'>; caps?: string[]; channel?: string; userId?: string }
  /** one encoded ClientMsg from that player */
  | { k: 'msg'; id: string; raw: string }
  /** that player's link is gone */
  | { k: 'drop'; id: string }
  /** tear the room down */
  | { k: 'close' };

/** worker → page */
export type HostOut =
  /** the room is built and physics is up; the host may start admitting peers */
  | { k: 'ready' }
  /**
   * The room could not be built, and hosting is over before it began.
   *
   * ⚠️ **THIS EXISTS BECAUSE THE FAILURE IT REPORTS IS OTHERWISE COMPLETELY SILENT.** The
   * Worker's `open` handler is async (Rapier's wasm has to load), so anything that goes wrong
   * in it becomes an unhandled REJECTION — which does not fire the Worker's `error` event,
   * does not reach the page, and leaves a host looking at a room code for a room that does
   * not exist while every guest that connects waits forever for a `welcome`.
   */
  | { k: 'failed'; reason: string }
  /** deliver this already-encoded frame to one player */
  | { k: 'send'; id: string; raw: string; reliable: boolean }
  /** the room emptied and stopped */
  | { k: 'empty' }
  /**
   * The host loop's own health, sampled in the Worker.
   *
   * Reported rather than inferred because the failure this watches for is invisible from the
   * page: a throttled timer in a backgrounded context does not announce itself, it just
   * produces a match that runs slowly for everyone. See `docs/lan-webrtc.md` §6.
   */
  | { k: 'health'; tickHz: number; behind: number };

/** how often the Worker reports `health` */
export const HEALTH_INTERVAL_MS = 2000;
