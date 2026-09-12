/**
 * THE CLIENT HALF OF THE LAN RENDEZVOUS — a short-lived socket to the CLOUD whose only job is
 * to introduce two browsers to each other.
 *
 * Pairs with `server/lanSignal.ts`. See `docs/lan-webrtc.md` for the whole design; the summary
 * is that a LAN match runs in a player's tab and is reached over a DataChannel at ~1 ms, but
 * the two browsers cannot find each other unaided, so the introduction goes through the server
 * we already run.
 *
 * ## Why a socket of its own, instead of the lobby's
 *
 * The lobby socket is HANDED OFF. `src/net/transport.ts` says it plainly: ownership moves from
 * `LobbyClient` to `ServerSession` at match start, and the new owner re-registers the callbacks
 * it cares about and takes over routing. Signalling does not fit in that: a HOST signals while
 * it is also running a match, so it needs to keep receiving `lanPeer` introductions at exactly
 * the point where the lobby socket has changed owners and is carrying snapshot traffic.
 *
 * Threading a second concern through that hand-off would put the riskiest new code in the most
 * load-bearing existing path. A separate socket is idle almost all the time — bytes per minute
 * against `capacity.md`'s bytes-per-second cost cliff — and it can be closed the moment hosting
 * stops without touching anything else.
 *
 * ⚠️ **It always points at the CLOUD, never at a LAN address.** A rendezvous only works if both
 * peers reach the same one, and `lanServerUrl()` is a different machine entirely (the
 * `npm run lan` / desktop-app path, which needs none of this).
 */
import { gameServerUrl } from './env';
import { getAuthToken } from '../lib/authClient';
import { encodeMsg, decodeServerMsg, type ClientMsg, type ServerMsg } from './protocol';
import type { LanSignalBus } from './lanPeer';

/** how long to wait for the server's answer to a `lanHost` / `lanJoin` before giving up */
const REQUEST_TIMEOUT_MS = 10_000;

export class LanSignalError extends Error {
  constructor(
    message: string,
    /** the protocol reason, for callers that want to branch rather than print */
    readonly reason: string,
  ) {
    super(message);
    this.name = 'LanSignalError';
  }
}

/**
 * A connection to the rendezvous. One per tab; a host keeps it for as long as it hosts and a
 * guest only until its DataChannel is up.
 */
export class LanSignalClient implements LanSignalBus {
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private signalCbs = new Set<(peer: string, data: string) => void>();
  private peerGoneCbs = new Set<(peer: string) => void>();
  private peerCbs = new Set<(peer: string) => void>();
  private closedCbs = new Set<() => void>();
  /** resolvers for the one in-flight `lanHost` / `lanJoin` */
  private pending: { resolve: (m: ServerMsg) => void; reject: (e: Error) => void; want: string } | null = null;
  private disposed = false;

  /** open (or reuse) the socket. Safe to call repeatedly. */
  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    const url = gameServerUrl();
    this.ready = new Promise<void>((resolve, reject) => {
      if (!url) {
        reject(new LanSignalError('No game server is configured.', 'noserver'));
        return;
      }
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        reject(new LanSignalError('Could not reach the DSIM server.', 'noserver'));
        return;
      }
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new LanSignalError('Could not reach the DSIM server.', 'noserver')));
      ws.addEventListener('close', () => {
        this.ready = null;
        this.ws = null;
        this.pending?.reject(new LanSignalError('Lost the connection to the DSIM server.', 'noserver'));
        this.pending = null;
        if (!this.disposed) for (const cb of this.closedCbs) cb();
      });
      ws.addEventListener('message', (e) => this.onFrame(String(e.data)));
    });
    return this.ready;
  }

  private onFrame(raw: string): void {
    let msg: ServerMsg;
    try {
      msg = decodeServerMsg(raw);
    } catch {
      return;
    }
    if (msg.t === 'lanSignal') {
      for (const cb of this.signalCbs) cb(msg.peer, msg.data);
      return;
    }
    if (msg.t === 'lanPeer') {
      for (const cb of this.peerCbs) cb(msg.peer);
      return;
    }
    if (msg.t === 'lanPeerGone') {
      for (const cb of this.peerGoneCbs) cb(msg.peer);
      return;
    }
    if (msg.t === 'lanHosting' || msg.t === 'lanJoined') {
      if (this.pending?.want === msg.t) {
        this.pending.resolve(msg);
        this.pending = null;
      }
      return;
    }
    if (msg.t === 'lanError') {
      this.pending?.reject(new LanSignalError(msg.message, msg.reason));
      this.pending = null;
    }
  }

  private send(m: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeMsg(m));
  }

  /** send a request and wait for its one expected reply (or a `lanError`) */
  private async request(m: ClientMsg, want: 'lanHosting' | 'lanJoined'): Promise<ServerMsg> {
    await this.connect();
    if (this.pending) throw new LanSignalError('A connection request is already in progress.', 'busy');
    return new Promise<ServerMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.want === want) {
          this.pending = null;
          reject(new LanSignalError('The DSIM server did not answer.', 'timeout'));
        }
      }, REQUEST_TIMEOUT_MS);
      const done = <T,>(fn: (v: T) => void) => (v: T) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending = { resolve: done(resolve), reject: done(reject), want };
      this.send(m);
    });
  }

  /**
   * Claim a code and start hosting.
   *
   * The auth token is read here rather than passed in because hosting REQUIRES an account and
   * the server verifies the token itself — a caller cannot make itself a host by asserting one.
   */
  async host(code: string): Promise<{ code: string; hostId: string }> {
    const authToken = await getAuthToken().catch(() => undefined);
    const m = await this.request({ t: 'lanHost', code, authToken: authToken ?? undefined }, 'lanHosting');
    if (m.t !== 'lanHosting') throw new LanSignalError('Unexpected reply.', 'protocol');
    return { code: m.code, hostId: m.hostId };
  }

  /** stop hosting; the server drops the code and tells every guest */
  stopHosting(): void {
    this.send({ t: 'lanStopHosting' });
  }

  /** ask to be introduced to a code's host */
  async join(code: string): Promise<{ code: string; hostId: string }> {
    const m = await this.request({ t: 'lanJoin', code }, 'lanJoined');
    if (m.t !== 'lanJoined') throw new LanSignalError('Unexpected reply.', 'protocol');
    return { code: m.code, hostId: m.hostId };
  }

  // ---- LanSignalBus

  signal(peer: string, data: string): void {
    this.send({ t: 'lanSignal', peer, data });
  }

  onSignal(cb: (peer: string, data: string) => void): () => void {
    this.signalCbs.add(cb);
    return () => this.signalCbs.delete(cb);
  }

  onPeerGone(cb: (peer: string) => void): () => void {
    this.peerGoneCbs.add(cb);
    return () => this.peerGoneCbs.delete(cb);
  }

  /** (host) a guest asked to be introduced and may now be answered */
  onPeer(cb: (peer: string) => void): () => void {
    this.peerCbs.add(cb);
    return () => this.peerCbs.delete(cb);
  }

  /**
   * The rendezvous socket itself went away.
   *
   * For a GUEST mid-match this is nothing: the DataChannel is already up and the cloud is out
   * of the path. For a HOST it means no new guests can be introduced until it comes back, which
   * is worth saying on screen and is not worth ending a match over.
   */
  onClosed(cb: () => void): () => void {
    this.closedCbs.add(cb);
    return () => this.closedCbs.delete(cb);
  }

  close(): void {
    this.disposed = true;
    this.pending = null;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
    this.ready = null;
  }
}
