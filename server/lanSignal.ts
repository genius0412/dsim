/**
 * SIGNALLING RENDEZVOUS FOR LAN MATCHES — the cloud's entire involvement in a match it does
 * not run.
 *
 * A LAN match is hosted in a player's own tab (`docs/lan-webrtc.md`): the authoritative room
 * runs there, and every other player reaches it over an `RTCDataChannel` on the same subnet at
 * ~1 ms. But two browsers cannot open that channel until they have swapped an SDP offer, an
 * answer and some ICE candidates, and neither of them can be dialled into — so that first
 * exchange needs a channel that already works. This is it.
 *
 * ## Why the cloud, when the point is to avoid the cloud
 *
 * `docs/lan-selfhost.md` left mDNS as the interesting local option. It is not available: a page
 * cannot advertise or query an mDNS service record, and WebRTC's `.local` candidates are
 * candidate OBFUSCATION the browser resolves internally rather than a directory a page can
 * read. Local discovery from a tab needs a native helper, and a native helper can just run the
 * server — which is the desktop app. So the realistic options were a cloud rendezvous or
 * copy-pasting SDP blobs by hand, and only one of those works with eight guests.
 *
 * What it costs is small and bounded, which is the reason this is worth doing at all. A cloud
 * 2v2 room is 940 KB/s of snapshots for as long as the match lasts, plus its share of the ~50%
 * of server CPU that is Rapier stepping. A signalled LAN match is roughly **10 KB per guest,
 * once**, and no room loop at all. See `docs/lan-webrtc.md` §1.
 *
 * ⚠️ **THE SERVER NEVER READS THE PAYLOAD.** `data` is an opaque string forwarded verbatim
 * between two sockets. That is deliberate: SDP is a format with a long history of parser bugs,
 * and there is nothing in it this server needs. It is bounded (`MAX_SIGNAL_BYTES`) and counted,
 * not parsed.
 *
 * ## What this is NOT
 *
 * It is not a relay for gameplay. Nothing here forwards input or snapshots, and the bounds
 * below are set low enough that trying would fail loudly rather than turning the signalling
 * path into an accidental — and uncapped — TURN server. Once ICE has a pair, the two peers talk
 * directly and this module hears nothing more until somebody leaves.
 */
import type { ServerMsg } from '../src/net/protocol';
import { isValidRoomCode, normalizeRoomCode } from '../src/net/roomCode';

/**
 * One signalling frame's ceiling. A full SDP offer with its candidates folded in is a few KB;
 * 16 KB leaves generous headroom for a verbose one and still makes bulk relaying useless.
 */
export const MAX_SIGNAL_BYTES = 16 * 1024;

/** how many guests one host may collect. A LAN room is a scrimmage, not a broadcast. */
export const MAX_PEERS_PER_HOST = 8;

/**
 * How many LAN rooms this process will hold rendezvous for at once. Each entry is a few
 * pointers, so this is not a memory bound so much as a blast radius: a bug or an abusive client
 * that claims codes in a loop stops at a number somebody chose.
 */
export const MAX_LAN_HOSTS = 500;

/** a socket, as much of one as this module needs */
export interface SignalSocket {
  id: string;
  send: (m: ServerMsg) => void;
}

interface HostEntry {
  socket: SignalSocket;
  /** the host's authenticated user id. Hosting REQUIRES an account — see `claim`. */
  userId: string;
  /** guests currently introduced to this host, by socket id */
  peers: Map<string, SignalSocket>;
  claimedAt: number;
}

export type ClaimResult =
  | { ok: true; code: string }
  | { ok: false; reason: 'badcode' | 'taken' | 'busy' | 'auth' };

export type JoinResult = { ok: true; code: string } | { ok: false; reason: 'badcode' | 'nohost' | 'full' };

export type SignalResult = { ok: true } | { ok: false; reason: 'toobig' | 'nopeer' };

/**
 * The registry. Codes are uppercase and normalized on the way in, so `abc123` and `ABC123`
 * cannot both be claimed.
 */
export class LanSignalling {
  private hosts = new Map<string, HostEntry>();
  /** socket id → the code it is a GUEST of, so a close can be resolved in O(1) */
  private guestOf = new Map<string, string>();
  /** socket id → the code it HOSTS, same reason */
  private hostOf = new Map<string, string>();

  /**
   * Claim a code as the host of a LAN room.
   *
   * `userId` is required and not optional-with-a-warning. The owner's rule for LAN is that the
   * host must be signed in, because the host is the one who uploads the match afterwards
   * (`POST /api/lan`) and an anonymous host is a match whose data has nowhere to land — which
   * defeats the reason LAN matches are allowed to exist at all.
   *
   * The ONE exception is decided by the caller and never here: a server with no auth configured
   * cannot verify anybody, so it hands in a synthetic id rather than asking for an account that
   * cannot exist on it (`LAN_ANON_HOSTS` in `server/index.ts`). This registry stays pure — it
   * refuses an absent id, always — so the exception has exactly one site and is greppable.
   *
   * `codeInUse` lets the caller refuse a code that a CLOUD room already holds. The two
   * namespaces are separate maps but they are the same six characters to a player, and a code
   * that means two different rooms is the worst possible thing to put on a projector.
   */
  claim(socket: SignalSocket, rawCode: string, userId: string | undefined, codeInUse: (code: string) => boolean): ClaimResult {
    if (!userId) return { ok: false, reason: 'auth' };
    const code = normalizeRoomCode(rawCode);
    if (!isValidRoomCode(code)) return { ok: false, reason: 'badcode' };
    if (this.hosts.size >= MAX_LAN_HOSTS) return { ok: false, reason: 'busy' };
    if (this.hosts.has(code) || codeInUse(code)) return { ok: false, reason: 'taken' };
    // one host per socket: claiming a second code silently orphans the first one's guests
    this.release(socket.id);
    this.hosts.set(code, { socket, userId, peers: new Map(), claimedAt: Date.now() });
    this.hostOf.set(socket.id, code);
    return { ok: true, code };
  }

  /**
   * Ask to be introduced to a code's host.
   *
   * The host is TOLD (`lanPeer`) and the guest is told it worked; the actual offer/answer then
   * flows through `relay`. The host speaks first because it is the one with the room — the
   * guest has nothing to offer until it knows there is somewhere to connect to.
   */
  join(socket: SignalSocket, rawCode: string): JoinResult {
    const code = normalizeRoomCode(rawCode);
    if (!isValidRoomCode(code)) return { ok: false, reason: 'badcode' };
    const host = this.hosts.get(code);
    if (!host) return { ok: false, reason: 'nohost' };
    if (host.socket.id === socket.id) return { ok: false, reason: 'nohost' }; // cannot guest your own room
    if (host.peers.size >= MAX_PEERS_PER_HOST && !host.peers.has(socket.id)) {
      return { ok: false, reason: 'full' };
    }
    host.peers.set(socket.id, socket);
    this.guestOf.set(socket.id, code);
    host.socket.send({ t: 'lanPeer', peer: socket.id });
    return { ok: true, code };
  }

  /**
   * Forward one opaque blob between a host and one of its guests.
   *
   * Routing is derived from the registry, never from the message: a sender may only reach the
   * host of the room it is a guest of, or a guest that is already in its own room. There is no
   * form of this message that reaches a socket the sender was not already introduced to, which
   * is what keeps a rendezvous from being a general-purpose message bus between strangers.
   */
  relay(from: SignalSocket, peerId: string, data: string): SignalResult {
    if (typeof data !== 'string' || data.length > MAX_SIGNAL_BYTES) return { ok: false, reason: 'toobig' };

    const hostedCode = this.hostOf.get(from.id);
    if (hostedCode) {
      const host = this.hosts.get(hostedCode);
      const guest = host?.peers.get(peerId);
      if (!guest) return { ok: false, reason: 'nopeer' };
      guest.send({ t: 'lanSignal', peer: from.id, data });
      return { ok: true };
    }

    const guestCode = this.guestOf.get(from.id);
    if (guestCode) {
      const host = this.hosts.get(guestCode);
      // a guest may only ever talk to its host, so the claimed peer id must BE the host
      if (!host || host.socket.id !== peerId) return { ok: false, reason: 'nopeer' };
      host.socket.send({ t: 'lanSignal', peer: from.id, data });
      return { ok: true };
    }

    return { ok: false, reason: 'nopeer' };
  }

  /** the socket id of the code's host, so a guest can address its first offer */
  hostIdFor(rawCode: string): string | undefined {
    return this.hosts.get(normalizeRoomCode(rawCode))?.socket.id;
  }

  /**
   * Forget everything about a socket — called on close, and on an explicit stop.
   *
   * A HOST going away takes the room with it, and every guest is told so. That is the honest
   * report: the authoritative room lived in that tab, so when it closed the match ended. The
   * alternative — leaving guests connected to a room that no longer exists — is the
   * half-connected state `docs/netcodeplan.md` was written to stop producing.
   */
  release(socketId: string): void {
    const hosted = this.hostOf.get(socketId);
    if (hosted) {
      const host = this.hosts.get(hosted);
      if (host) {
        for (const [peerId, peer] of host.peers) {
          this.guestOf.delete(peerId);
          peer.send({ t: 'lanPeerGone', peer: host.socket.id });
        }
        this.hosts.delete(hosted);
      }
      this.hostOf.delete(socketId);
    }

    const guested = this.guestOf.get(socketId);
    if (guested) {
      const host = this.hosts.get(guested);
      if (host?.peers.delete(socketId)) host.socket.send({ t: 'lanPeerGone', peer: socketId });
      this.guestOf.delete(socketId);
    }
  }

  /** live LAN rendezvous count, for `/api/perf` and the smoke */
  get size(): number {
    return this.hosts.size;
  }

  /** guests currently introduced to a code (0 when nobody hosts it) */
  peerCount(rawCode: string): number {
    return this.hosts.get(normalizeRoomCode(rawCode))?.peers.size ?? 0;
  }
}
