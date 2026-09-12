/**
 * THE LAN DATA PATH — an `RTCDataChannel` pair between two browsers on one subnet.
 *
 * This is step 3 of `docs/lan-webrtc.md`. The cloud introduces the peers
 * (`server/lanSignal.ts`); everything after the introduction happens here, and once it has
 * happened the internet is out of the path entirely. A dropped hotspot mid-match is not
 * something the match notices.
 *
 * ## Two channels, because `Transport` already promised two lanes
 *
 * `src/net/transport.ts` takes a `{ reliable }` hint on every send and `WebSocketTransport`
 * ignores it — it has one ordered TCP stream and cannot honour it. That hint has been waiting
 * for a backend that can:
 *
 *   - **control** — ordered, reliable. `join` / `matchStart` / `roster` / `restart` / `rejoin`
 *     / results. Losing or reordering one of these breaks the match.
 *   - **hot** — unordered, `maxRetransmits: 0`. `input` upstream, `snapshot` and `pong` down.
 *     The next message supersedes a lost one, so waiting for a retransmit buys nothing and
 *     costs a stall.
 *
 * On a clean LAN the difference is small. On venue Wi-Fi it is the difference between a hitch
 * and a freeze, and head-of-line blocking under loss is the exact failure `docs/netcodeplan.md`
 * was written to remove.
 *
 * ## ICE, and why there is no STUN or TURN here
 *
 * `iceServers: []` is deliberate and is not an omission. Both peers are on the same subnet, so
 * the host candidates each gathers from its own interfaces are enough to connect directly. STUN
 * exists to discover a public reflexive address and TURN to relay when direct fails — both are
 * about traversing the internet, which is the thing this design is avoiding. Leaving them out
 * also means a LAN match cannot silently become a relayed internet match that merely feels slow.
 *
 * ⚠️ **Chrome will hand out `<uuid>.local` mDNS candidates rather than raw private IPs**, unless
 * the page holds a camera/mic permission. That is fine here and needs no action: the PEER
 * resolves the name over mDNS, and both peers are on the same subnet by construction. It is
 * worth knowing because it is easy to see `.local` in a candidate and conclude something is
 * broken. It is also NOT the thing `docs/lan-webrtc.md` §3 struck — that was mDNS *discovery*
 * from a page, which has no API. Resolution of a candidate is the browser's own business.
 *
 * ## What this is not
 *
 * Not a mesh. `docs/netcodeplan.md` deleted a full mesh of lockstep peers over a shared TURN
 * server, where one failing edge wedged the match for everybody. This is a STAR: N guests, one
 * host, one authoritative room, no cross-peer determinism requirement. What carries over from
 * that experience is the one lesson written into `watchConnection` below — `disconnected` and
 * `failed` are different states, and treating them the same is what made a recoverable blip
 * indistinguishable from a real drop.
 */
import type { Transport } from './transport';

/** ordered + reliable: the control plane */
const CONTROL_LABEL = 'dsim-control';
/** unordered + no retransmits: the hot path */
const HOT_LABEL = 'dsim-hot';

/**
 * How long a guest waits for the whole handshake — introduction, offer, answer, ICE — before
 * calling it off. Generous for a LAN (where this is normally well under a second) and short
 * enough that a player staring at a spinner gets an answer they can act on.
 */
export const LAN_CONNECT_TIMEOUT_MS = 15_000;

/**
 * How long a transient `disconnected` is tolerated before it is treated as a real failure.
 * ICE recovers from brief interruptions on its own; this is the budget for that.
 */
export const LAN_DISCONNECT_GRACE_MS = 8_000;

/** the signalling side, supplied by whatever owns the cloud socket */
export interface LanSignalBus {
  /** send one opaque blob to `peer` (the server forwards it verbatim) */
  signal(peer: string, data: string): void;
  /** register for blobs addressed to us; returns an unsubscribe */
  onSignal(cb: (peer: string, data: string) => void): () => void;
  /** a peer went away (the host's tab closed, or a guest left) */
  onPeerGone(cb: (peer: string) => void): () => void;
}

/** what travels over the signalling channel. Small, and ours — the server never reads it. */
type SignalFrame =
  | { k: 'offer'; sdp: string }
  | { k: 'answer'; sdp: string }
  | { k: 'ice'; candidate: RTCIceCandidateInit };

const rtcConfig: RTCConfiguration = {
  // see the header: a LAN match connects on host candidates or not at all
  iceServers: [],
};

/**
 * A live pair of channels to one peer, plus the connection they ride on.
 *
 * `control` and `hot` are both open by the time this resolves — a half-open pair is exactly the
 * "room that half-connects" failure that makes this feature hard to debug in a gym, so it is
 * never handed out.
 */
export interface LanLink {
  pc: RTCPeerConnection;
  control: RTCDataChannel;
  hot: RTCDataChannel;
  /** the signalling peer id on the other end */
  peer: string;
  /**
   * Frames that arrived before the consumer attached its own listener — see `bufferEarly`.
   *
   * Stops the buffering and hands the queue over. **Call it and attach your listeners in the
   * SAME synchronous block**: JavaScript dispatches an event as a task, so nothing can arrive
   * between two adjacent statements, and doing it in two ticks re-opens the hole this closes.
   */
  takeEarly(): string[];
}

/**
 * ⚠️ **A DATACHANNEL DELIVERS TO WHOEVER IS LISTENING AT THE MOMENT A FRAME ARRIVES, AND
 * BUFFERS NOTHING FOR A LISTENER THAT ATTACHES LATER.**
 *
 * That is a real race here rather than a theoretical one, because the first frame of the whole
 * protocol is sent the instant the channel opens: a guest's `LobbyClient` sends `join` as soon
 * as its transport reports open, and the host cannot attach its own `message` listener until
 * `acceptLanGuest` has resolved and `admit` has stored the link — a microtask or two later.
 * Measured between two tabs: the link came up, the host counted the guest, and then both sides
 * sat there, the guest showing CONNECTING forever because its `join` had been dispatched into
 * a channel nobody was listening to and `welcome` was therefore never sent.
 *
 * So both ends buffer from the moment the channel objects exist. The queue is bounded by the
 * handshake being milliseconds long and by the fact that a peer sends one frame before it hears
 * back; it is handed over by `takeEarly` and the listeners are dropped at the same time.
 */
function bufferEarly(control: RTCDataChannel, hot: RTCDataChannel): () => string[] {
  const early: string[] = [];
  const onEarly = (e: MessageEvent): void => {
    if (typeof e.data === 'string') early.push(e.data);
  };
  control.addEventListener('message', onEarly);
  hot.addEventListener('message', onEarly);
  return () => {
    control.removeEventListener('message', onEarly);
    hot.removeEventListener('message', onEarly);
    return early.splice(0);
  };
}

function waitOpen(ch: RTCDataChannel): Promise<void> {
  if (ch.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    ch.addEventListener('open', () => resolve(), { once: true });
    ch.addEventListener('error', () => reject(new Error(`${ch.label} failed to open`)), { once: true });
    ch.addEventListener('close', () => reject(new Error(`${ch.label} closed before opening`)), { once: true });
  });
}

/**
 * Trickle ICE, in both directions, for one peer connection.
 *
 * Trickled rather than gathered-then-sent because waiting for `icegatheringstate === 'complete'`
 * means waiting for every candidate including ones a LAN will never need. The first host
 * candidate is usually the one that connects, and it arrives almost immediately.
 */
function wireIce(pc: RTCPeerConnection, bus: LanSignalBus, peer: string): void {
  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) bus.signal(peer, JSON.stringify({ k: 'ice', candidate: e.candidate.toJSON() } satisfies SignalFrame));
  });
}

/**
 * GUEST SIDE. Offer to a host we have just been introduced to, and resolve once both channels
 * are open.
 *
 * The guest creates the channels because the guest makes the offer: `createDataChannel` before
 * `createOffer` is what puts them in the SDP, and the host then receives them through
 * `ondatachannel` rather than having to negotiate a second time.
 */
export async function connectToLanHost(
  bus: LanSignalBus,
  hostId: string,
  opts: { timeoutMs?: number } = {},
): Promise<LanLink> {
  const pc = new RTCPeerConnection(rtcConfig);
  const control = pc.createDataChannel(CONTROL_LABEL, { ordered: true });
  const hot = pc.createDataChannel(HOT_LABEL, { ordered: false, maxRetransmits: 0 });
  // see `bufferEarly`: the host's first frame can land before the transport exists
  const takeEarly = bufferEarly(control, hot);

  wireIce(pc, bus, hostId);
  /* Candidates can arrive before the answer has been applied, and `addIceCandidate` throws if
     there is no remote description yet. Queue until there is one — this is ordinary trickle-ICE
     bookkeeping, not a workaround. */
  const pending: RTCIceCandidateInit[] = [];
  let remoteSet = false;

  const offSignal = bus.onSignal((peer, data) => {
    if (peer !== hostId) return;
    let frame: SignalFrame;
    try {
      frame = JSON.parse(data) as SignalFrame;
    } catch {
      return;
    }
    if (frame.k === 'answer') {
      void pc
        .setRemoteDescription({ type: 'answer', sdp: frame.sdp })
        .then(() => {
          remoteSet = true;
          for (const c of pending.splice(0)) void pc.addIceCandidate(c).catch(() => {});
        })
        .catch(() => {});
    } else if (frame.k === 'ice') {
      if (remoteSet) void pc.addIceCandidate(frame.candidate).catch(() => {});
      else pending.push(frame.candidate);
    }
  });

  let offGone = (): void => {};
  const gone = new Promise<never>((_, reject) => {
    offGone = bus.onPeerGone((peer) => {
      if (peer === hostId) reject(new Error('The host closed the game.'));
    });
  });

  const timeoutMs = opts.timeoutMs ?? LAN_CONNECT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Could not reach the host on this network.')), timeoutMs);
  });

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    bus.signal(hostId, JSON.stringify({ k: 'offer', sdp: offer.sdp ?? '' } satisfies SignalFrame));
    await Promise.race([Promise.all([waitOpen(control), waitOpen(hot)]), gone, timeout]);
    return { pc, control, hot, peer: hostId, takeEarly };
  } catch (e) {
    pc.close();
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    offSignal();
    offGone();
  }
}

/**
 * HOST SIDE. Answer one guest's offer and resolve once both of its channels are open.
 *
 * Called per guest, from the `lanPeer` introduction. The host holds one of these per player and
 * hands each one's channels to the room as a `Client`.
 */
export async function acceptLanGuest(
  bus: LanSignalBus,
  guestId: string,
  opts: { timeoutMs?: number } = {},
): Promise<LanLink> {
  const pc = new RTCPeerConnection(rtcConfig);
  wireIce(pc, bus, guestId);

  const pending: RTCIceCandidateInit[] = [];
  let remoteSet = false;
  let control: RTCDataChannel | null = null;
  let hot: RTCDataChannel | null = null;
  let takeEarly: (() => string[]) | null = null;

  /**
   * ⚠️ **A GUEST LEAVING THE RENDEZVOUS IS NOT A GUEST LEAVING** — and after a SUCCESSFUL join
   * it is the normal case, not an edge one. `joinLanRoom` closes its signalling socket the
   * instant both channels are open ("the introduction is over"), so the server reports that
   * guest gone to the host moments after the link comes up. Honouring it unconditionally tore
   * down the connection that had just succeeded: the guest reached the lobby and was
   * immediately told it had lost the game server, while the host went back to "waiting for
   * players". Found by running it between two tabs; it would have done the same through the
   * cloud.
   *
   * So `gone` is disarmed the moment the guest's channels EXIST. That is the last point at
   * which the rendezvous is still telling us something we cannot find out for ourselves: a
   * guest that dies after it has created channels is a dead `RTCPeerConnection`, which the
   * timeout below, `waitOpen`'s own rejection, and the transport's `close`/`failed` handling
   * all see directly. Before that point the report is real and still ends the handshake.
   */
  let channelsSeen = false;

  const bothOpen = new Promise<void>((resolve, reject) => {
    const ready = (): void => {
      if (control && hot) {
        channelsSeen = true;
        Promise.all([waitOpen(control), waitOpen(hot)]).then(() => resolve(), reject);
      }
    };
    pc.addEventListener('datachannel', (e) => {
      if (e.channel.label === CONTROL_LABEL) control = e.channel;
      else if (e.channel.label === HOT_LABEL) hot = e.channel;
      /* The guest sends `join` the moment ITS side opens, which is before `admit` can attach a
         listener on this one. Buffer from here — see `bufferEarly`. */
      if (control && hot && !takeEarly) takeEarly = bufferEarly(control, hot);
      ready();
    });
  });

  const offSignal = bus.onSignal((peer, data) => {
    if (peer !== guestId) return;
    let frame: SignalFrame;
    try {
      frame = JSON.parse(data) as SignalFrame;
    } catch {
      return;
    }
    if (frame.k === 'offer') {
      void (async () => {
        await pc.setRemoteDescription({ type: 'offer', sdp: frame.sdp });
        remoteSet = true;
        for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        bus.signal(guestId, JSON.stringify({ k: 'answer', sdp: answer.sdp ?? '' } satisfies SignalFrame));
      })().catch(() => {});
    } else if (frame.k === 'ice') {
      if (remoteSet) void pc.addIceCandidate(frame.candidate).catch(() => {});
      else pending.push(frame.candidate);
    }
  });

  let offGone = (): void => {};
  const gone = new Promise<never>((_, reject) => {
    offGone = bus.onPeerGone((peer) => {
      // see `channelsSeen` above: after that point this report says nothing the connection
      // itself does not say, and a successful join always produces one
      if (peer === guestId && !channelsSeen) reject(new Error('That player left.'));
    });
  });

  const timeoutMs = opts.timeoutMs ?? LAN_CONNECT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('That player could not be reached.')), timeoutMs);
  });

  try {
    await Promise.race([bothOpen, gone, timeout]);
    return { pc, control: control!, hot: hot!, peer: guestId, takeEarly: takeEarly ?? (() => []) };
  } catch (e) {
    pc.close();
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    offSignal();
    offGone();
  }
}

/**
 * A `Transport` over a `LanLink`, so the client's existing `LobbyClient` / `ServerSession`
 * cannot tell it is not talking to a WebSocket.
 *
 * ⚠️ **THERE IS NO RECONNECT HERE, AND THAT IS THE HONEST BEHAVIOUR.** `WebSocketTransport`
 * retries because its far end is a server that outlives the socket: the room is still there,
 * holding your slot. A LAN room is not — it lives in another player's tab, reached by a
 * connection that was negotiated once through a rendezvous that has since forgotten both of us.
 * A silent retry loop would spend the reconnect budget on something that cannot succeed while
 * telling the player it was working on it. So `onDown` fires for a transient ICE hiccup that
 * may still recover, and `onFail` fires when it does not — and re-joining is a deliberate act
 * with the room code, which is a thing the player can actually do.
 */
export class DataChannelTransport implements Transport {
  private messageCb: ((data: string) => void) | null = null;
  private openCb: (() => void) | null = null;
  private reopenCb: (() => void) | null = null;
  private downCb: (() => void) | null = null;
  private failCb: (() => void) | null = null;
  /** frames received before the owner registered `onMessage` */
  private readonly pending: string[] = [];
  /**
   * ⚠️ **OPEN IS A STATE, NOT AN EVENT — see `onOpen`.** A LAN transport is already open when
   * its owner first sees it, so a one-shot `open` callback is registered too late by
   * construction and the client never sends its `join`.
   */
  private opened = false;
  private disposed = false;
  private down = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly link: LanLink) {
    /* The same race `bufferEarly` exists for, one layer up: this object is constructed before
       its owner calls `onMessage`, so a frame arriving in between has nowhere to go. It is
       held rather than dropped. */
    const onMessage = (e: MessageEvent): void => {
      if (typeof e.data !== 'string') return;
      if (this.messageCb) this.messageCb(e.data);
      else this.pending.push(e.data);
    };
    /* Take the handshake's buffer and attach in ONE synchronous block — see `takeEarly`. */
    const early = link.takeEarly();
    link.control.addEventListener('message', onMessage);
    link.hot.addEventListener('message', onMessage);
    this.pending.push(...early);
    link.control.addEventListener('close', () => this.fail());
    this.watchConnection();
    // both channels were open before the link was handed over, so the first open is immediate;
    // deferred by a microtask so a caller still assigning callbacks does not miss it — and
    // LATCHED, because a caller that arrives after even that gets it from `onOpen`
    queueMicrotask(() => {
      if (this.disposed) return;
      this.opened = true;
      this.openCb?.();
    });
  }

  /**
   * ICE state, with `disconnected` and `failed` kept apart.
   *
   * `mesh.ts` ignored `disconnected` outright and acted only on `failed`/`closed`, which made a
   * recoverable blip and a real drop look identical to the sim (`docs/netcodeplan.md` §25).
   * Here a `disconnected` says so immediately — the player sees the connection-quality HUD react
   * — and starts a grace timer; recovery cancels it, expiry gives up for real.
   */
  private watchConnection(): void {
    const { pc } = this.link;
    pc.addEventListener('iceconnectionstatechange', () => {
      if (this.disposed) return;
      const s = pc.iceConnectionState;
      if (s === 'disconnected') {
        if (!this.down) {
          this.down = true;
          this.downCb?.();
        }
        if (!this.graceTimer) this.graceTimer = setTimeout(() => this.fail(), LAN_DISCONNECT_GRACE_MS);
      } else if (s === 'connected' || s === 'completed') {
        if (this.graceTimer) {
          clearTimeout(this.graceTimer);
          this.graceTimer = null;
        }
        if (this.down) {
          this.down = false;
          this.reopenCb?.();
        }
      } else if (s === 'failed' || s === 'closed') {
        this.fail();
      }
    });
  }

  private fail(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.failCb?.();
  }

  send(data: string, opts?: { reliable?: boolean }): void {
    if (this.disposed) return;
    /* The lane the caller asked for, and a fallback to control if the hot channel is not open —
       a dropped unreliable channel must not silently swallow input. */
    const wantHot = opts?.reliable === false;
    const ch = wantHot && this.link.hot.readyState === 'open' ? this.link.hot : this.link.control;
    if (ch.readyState !== 'open') return;
    try {
      ch.send(data);
    } catch {
      /* a full SCTP send buffer throws. The hot lane's whole contract is that the next message
         supersedes this one, so dropping it is correct; on control it means the link is going
         and `close`/ICE will report it. */
    }
  }

  onMessage(cb: (data: string) => void): void {
    this.messageCb = cb;
    // whatever arrived before there was anywhere to put it, in arrival order
    for (const d of this.pending.splice(0)) cb(d);
  }
  /**
   * ⚠️ **FIRES IMMEDIATELY IF THIS TRANSPORT IS ALREADY OPEN**, and that is the whole reason
   * this override exists.
   *
   * `LobbyClient.join` sends its `join` frame from `onOpen` and from nowhere else, which is
   * correct for a `WebSocketTransport` — that one is handed over still dialling, so the
   * callback is always registered before the socket opens. A LAN transport is the opposite:
   * the handshake finished on the LAN screen and the connection is live by the time the lobby
   * mounts, adopts it and registers anything. Measured between two tabs: the link came up, the
   * host counted the guest, and the guest sat on CONNECTING forever — because its `join` was
   * waiting on an event that had already happened. Same bug as `bufferEarly` one layer up, and
   * it must be fixed on the LISTENER side: a transport cannot know how late its owner will be.
   */
  onOpen(cb: () => void): void {
    this.openCb = cb;
    if (this.opened && !this.disposed) cb();
  }
  onReopen(cb: () => void): void {
    this.reopenCb = cb;
  }
  onDown(cb: () => void): void {
    this.downCb = cb;
  }
  onFail(cb: () => void): void {
    this.failCb = cb;
  }

  close(): void {
    this.disposed = true;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    try {
      this.link.control.close();
      this.link.hot.close();
      this.link.pc.close();
    } catch {
      /* already gone */
    }
  }

  get isOpen(): boolean {
    return !this.disposed && this.link.control.readyState === 'open';
  }
}
