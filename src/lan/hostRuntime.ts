/**
 * HOSTING A LAN MATCH FROM A TAB — the page half.
 *
 * The Worker owns the authoritative room (`hostWorker.ts`); this owns everything the Worker
 * cannot touch: the signalling socket, one `RTCPeerConnection` per guest, the host's own seat,
 * and the wake lock that keeps the machine from sleeping mid-match.
 *
 * The split is forced rather than chosen — `RTCPeerConnection` is not available in a Worker —
 * but it lands well: the thread that must hit 60 Hz has no I/O on it, and the thread doing I/O
 * is the one already pumping a render loop.
 *
 * ## The host plays through the same interface as everyone else
 *
 * `LoopbackTransport` is a `Transport` whose far end is a `postMessage` rather than a socket.
 * That means the host's own `LobbyClient` and `ServerSession` are the stock ones, talking to
 * the stock room, unaware that both are on this machine. No "am I the host" branch anywhere in
 * the client, which is the difference between this and the P2P host-authority code
 * `docs/netcodeplan.md` deleted — there, being the host changed what your client DID.
 */
import type { Transport } from '../net/transport';
import type { LobbyPlayer, RoomConfig } from '../net/protocol';
import { DEFAULT_ROOM_CONFIG } from '../net/protocol';
import { LanSignalClient } from '../net/lanSignalClient';
import { acceptLanGuest, type LanLink } from '../net/lanPeer';
import { HOST_SEAT, type HostIn, type HostOut } from './hostProtocol';

// the Worker needs this too (it reserves the room's host with it), so the constant lives in
// the module both threads already share; re-exported here, where its users look for it
export { HOST_SEAT };

/**
 * How long the Worker gets to build the room before hosting is called off.
 *
 * It loads Rapier's wasm over the same connection the page came from, so this is generous —
 * but it is FINITE, because the alternative is the failure this whole guard exists for: a
 * host reading out a room code for a room that was never built.
 */
const ROOM_BOOT_TIMEOUT_MS = 20_000;

/**
 * A `Transport` with no network under it.
 *
 * Reads as a formality and is not one: it is what lets the host be an ordinary client of its
 * own room. `send` hands the frame to the Worker; frames from the Worker arrive on
 * `onMessage`. The lane hint is accepted and ignored, honestly — there is no wire to reorder.
 */
class LoopbackTransport implements Transport {
  private messageCb: ((data: string) => void) | null = null;
  private openCb: (() => void) | null = null;
  private failCb: (() => void) | null = null;
  /** see `onOpen`: the host adopts this transport well after the room said it was ready */
  private opened = false;
  private closed = false;

  constructor(
    private readonly toWorker: (raw: string) => void,
    /** the host's client let go of this — see `close` */
    private readonly onClose: () => void,
  ) {}

  /** called by the runtime when the Worker addresses the host's seat */
  deliver(raw: string): void {
    if (!this.closed) this.messageCb?.(raw);
  }
  /** called once the room exists */
  open(): void {
    if (this.closed) return;
    this.opened = true;
    this.openCb?.();
  }
  /** called when hosting stops for any reason */
  fail(): void {
    if (this.closed) return;
    this.closed = true;
    this.failCb?.();
  }

  send(data: string): void {
    if (!this.closed) this.toWorker(data);
  }
  onMessage(cb: (data: string) => void): void {
    this.messageCb = cb;
  }
  /**
   * ⚠️ **FIRES IMMEDIATELY IF THE ROOM IS ALREADY UP.** The host clicks START HOSTING, reads
   * the code out, and only then goes to the room — so `open()` has long since run by the time
   * the lobby adopts this and registers anything, and `LobbyClient.join` sends its `join` from
   * this callback and from nowhere else. Left one-shot, the host never took a seat in its own
   * room and sat on "waiting for players" beside a guest doing the same. See the twin note on
   * `DataChannelTransport.onOpen`.
   */
  onOpen(cb: () => void): void {
    this.openCb = cb;
    if (this.opened && !this.closed) cb();
  }
  onReopen(): void {
    /* a loopback never drops, so this never fires */
  }
  onDown(): void {
    /* likewise */
  }
  onFail(cb: () => void): void {
    this.failCb = cb;
  }
  /**
   * ⚠️ **THE ROOM HAS TO HEAR ABOUT THIS.** A guest leaving arrives as a closed DataChannel and
   * the runtime drops its seat; the host leaving is a `close()` on an object with no network
   * under it, so without this callback the room keeps a seat for a client that is gone, never
   * empties, and a parked `LanHost` (see `hostKeeper.ts`) runs its Worker for the rest of the
   * tab's life with nothing attached to it.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
  get isOpen(): boolean {
    return !this.closed;
  }
}

export interface HostHealth {
  /** inbound frames per second across the room */
  tickHz: number;
  /** how far the Worker's own 2 s interval drifted, in ms. Non-zero ⇒ being throttled. */
  behind: number;
}

export interface LanHostEvents {
  /** the code is live and guests can join */
  onReady?: (code: string) => void;
  /** a guest connected or left; `count` is how many are on the room now */
  onGuests?: (count: number) => void;
  /** the Worker's self-measurement, every 2 s */
  onHealth?: (h: HostHealth) => void;
  /** hosting ended — either `stop()` or something that could not be recovered */
  onStopped?: (reason: string) => void;
}

/**
 * One hosted LAN room.
 *
 * Lifetime is `start()` → `stop()`. Nothing here retries: a host whose rendezvous socket drops
 * keeps its existing guests (their DataChannels do not care) and simply cannot admit new ones
 * until it comes back, which is reported rather than hidden.
 */
export class LanHost {
  private worker: Worker | null = null;
  private signals: LanSignalClient | null = null;
  private readonly links = new Map<string, LanLink>();
  /** seats the room has already been told about, so a `join` seats exactly once */
  private readonly seated = new Set<string>();
  private local: LoopbackTransport | null = null;
  private wakeLock: { release: () => Promise<void> } | null = null;
  private stopped = false;

  /** the code this room was claimed with, so a screen adopting it back can show it */
  private roomCode = '';

  constructor(private events: LanHostEvents = {}) {}

  /**
   * Re-point the callbacks at whoever owns this host NOW.
   *
   * A parked room outlives the screen that started it (`hostKeeper.ts`), so the events it was
   * built with belong to an unmounted component and update nothing. A screen that adopts one
   * back replaces them.
   */
  setEvents(events: LanHostEvents): void {
    this.events = events;
  }

  /** the live room code, or '' before `start()` resolves */
  get code(): string {
    return this.roomCode;
  }

  /** how many guests are connected right now — for a screen adopting a parked room */
  get guests(): number {
    return this.links.size;
  }

  /** the host's own transport, handed to the stock LobbyClient */
  get transport(): Transport {
    if (!this.local) throw new Error('start() first');
    return this.local;
  }

  async start(code: string, config: RoomConfig = DEFAULT_ROOM_CONFIG): Promise<string> {
    this.stopped = false;
    const signals = new LanSignalClient();
    this.signals = signals;
    // claim the code FIRST: if it is taken, or the account is missing, nothing else should
    // have been built yet
    const claimed = await signals.host(code);
    this.roomCode = claimed.code;

    const worker = new Worker(new URL('./hostWorker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    const toWorker = (m: HostIn): void => worker.postMessage(m);
    this.local = new LoopbackTransport(
      (raw) => this.fromSeat(HOST_SEAT, raw, toWorker),
      () => {
        this.seated.delete(HOST_SEAT);
        toWorker({ k: 'drop', id: HOST_SEAT });
      },
    );

    /* ⚠️ START() DOES NOT RESOLVE UNTIL THE ROOM EXISTS. Claiming the code and building the room are separate steps on separate
       threads, and resolving on the claim alone published a code for a room that had not been
       built — measured: a guest connected over WebRTC, the host counted it, and the guest sat
       on CONNECTING forever because the frames it sent were landing in a Worker whose `room`
       was still null. A Worker that fails to load is SILENT (`error` fires for a load or a
       synchronous throw, `failed` covers the async half, and neither is guaranteed), so the
       timeout is what makes the wait terminate in every case. */
    let booted = false;
    let onBoot: () => void = () => {};
    let onBootFail: (e: Error) => void = () => {};
    const roomReady = new Promise<void>((res, rej) => {
      onBoot = res;
      onBootFail = rej;
    });
    /** a Worker problem before the room exists fails `start()`; after it, it stops hosting */
    const workerDied = (reason: string): void => {
      if (booted) this.stop(reason);
      else onBootFail(new Error(reason));
    };
    worker.addEventListener('error', (e: ErrorEvent) => workerDied(e.message || 'The match room stopped.'));
    worker.addEventListener('messageerror', () => workerDied('The match room sent something unreadable.'));

    worker.addEventListener('message', (e: MessageEvent) => {
      const m = e.data as HostOut;
      if (m.k === 'failed') {
        workerDied(m.reason || 'The match room could not start.');
        return;
      }
      if (m.k === 'ready') {
        booted = true;
        onBoot();
        /* The host is NOT seated here. Its own `LobbyClient` sends a `join` through the
           loopback like any other client, and that frame is what carries the player — so the
           host takes a seat by the same route a guest does, with the same sanitization, and
           there is no placeholder roster entry to correct afterwards. */
        this.local?.open();
        this.events.onReady?.(claimed.code);
        return;
      }
      if (m.k === 'send') {
        if (m.id === HOST_SEAT) {
          this.local?.deliver(m.raw);
          return;
        }
        const link = this.links.get(m.id);
        if (!link) return;
        const ch = m.reliable ? link.control : link.hot;
        if (ch.readyState === 'open') {
          try {
            ch.send(m.raw);
          } catch {
            /* a full SCTP buffer. On the hot lane the next frame supersedes this one; on
               control the link is going and ICE will say so. */
          }
        }
        return;
      }
      /* EVERYONE LEFT. The Worker's room has already stopped itself; this is the page
         deciding what that means, which for a tab-hosted match is that hosting is over —
         there is nobody left to host for, and the alternative is a Worker stepping an empty
         room until the tab closes. */
      if (m.k === 'empty') {
        this.stop('Everyone left the room.');
        return;
      }
      if (m.k === 'health') {
        this.events.onHealth?.({ tickHz: m.tickHz, behind: m.behind });
      }
    });

    toWorker({ k: 'open', code: claimed.code, config });

    // a guest asked to be introduced
    signals.onPeer((peer) => {
      void this.admit(signals, peer, toWorker);
    });
    /* ⚠️ NOT `dropGuest`. A guest closes its rendezvous socket the moment its channels open
       (`joinLanRoom`, "the introduction is over"), so this fires on every SUCCESSFUL join —
       and tearing the link down here killed the connection that had just succeeded: the guest
       was told it had lost the game server while this panel went back to "waiting for
       players". The DataChannel is the authority for a guest being present; the rendezvous
       only ever knew about the introduction. A link that is still open is therefore kept, and
       one that is not was going anyway. */
    signals.onPeerGone((peer) => {
      const link = this.links.get(peer);
      if (link && (link.control.readyState === 'open' || link.hot.readyState === 'open')) return;
      this.dropGuest(peer, toWorker);
    });

    const timer = setTimeout(() => workerDied('The match room took too long to start.'), ROOM_BOOT_TIMEOUT_MS);
    try {
      await roomReady;
    } catch (e) {
      this.stop(e instanceof Error ? e.message : 'The match room could not start.');
      throw e;
    } finally {
      clearTimeout(timer);
    }

    await this.acquireWakeLock();
    return claimed.code;
  }

  /**
   * One frame in from a seat, host or guest.
   *
   * ⚠️ **THE FIRST FRAME A PLAYER SENDS IS ITS `join`, AND IT CARRIES THE PLAYER.** The room
   * cannot seat somebody it has no name for, so the seat is created from that frame rather
   * than when the link opens — which also means a peer that connects and then says nothing
   * never occupies a slot. Shared by the host's loopback and every guest's DataChannel so the
   * two cannot drift.
   */
  private fromSeat(id: string, raw: string, toWorker: (m: HostIn) => void): void {
    if (!this.seated.has(id)) {
      this.seated.add(id);
      let intro: { player?: Omit<LobbyPlayer, 'clientId'>; caps?: string[]; channel?: string } = {};
      try {
        intro = JSON.parse(raw) as typeof intro;
      } catch {
        /* fall through with an empty intro; the room sanitizes whatever it is given */
      }
      if (intro.player) {
        toWorker({ k: 'add', id, player: intro.player, caps: intro.caps, channel: intro.channel });
      } else {
        // not a join — nothing to seat with, so let the room answer the frame on its own terms
        this.seated.delete(id);
      }
    }
    toWorker({ k: 'msg', id, raw });
  }

  /** answer one guest and wire its channels to the Worker */
  private async admit(signals: LanSignalClient, peer: string, toWorker: (m: HostIn) => void): Promise<void> {
    let link: LanLink;
    try {
      link = await acceptLanGuest(signals, peer);
    } catch {
      return; // the guest gave up or could not be reached; nothing to clean up
    }
    if (this.stopped) {
      link.pc.close();
      return;
    }
    this.links.set(peer, link);

    const onFrame = (e: MessageEvent): void => {
      if (typeof e.data === 'string') this.fromSeat(peer, e.data, toWorker);
    };
    /* ⚠️ THE GUEST'S `join` HAS USUALLY ALREADY ARRIVED. It is sent the moment the guest's own
       channel opens, which is before this line can run — and a DataChannel buffers nothing for
       a listener that was not there yet, so without the handshake's own buffer the host saw a
       guest connect and then never heard from it, and the guest waited on a `welcome` that
       nothing would ever trigger. Taken and attached in ONE synchronous block; see
       `takeEarly` in lanPeer.ts. */
    const early = link.takeEarly();
    link.control.addEventListener('message', onFrame);
    link.hot.addEventListener('message', onFrame);
    for (const raw of early) this.fromSeat(peer, raw, toWorker);
    link.control.addEventListener('close', () => this.dropGuest(peer, toWorker));

    this.events.onGuests?.(this.links.size);
  }

  private dropGuest(peer: string, toWorker: (m: HostIn) => void): void {
    const link = this.links.get(peer);
    if (!link) return;
    this.links.delete(peer);
    this.seated.delete(peer);
    try {
      link.pc.close();
    } catch {
      /* already gone */
    }
    toWorker({ k: 'drop', id: peer });
    this.events.onGuests?.(this.links.size);
  }

  /**
   * Keep the screen (and therefore the tab) alive while hosting.
   *
   * Best-effort by design: `navigator.wakeLock` is unavailable on some browsers and rejects
   * outright when the page is not visible. A host who cannot hold one is not blocked from
   * hosting — they are relying on the Worker and on not minimising, which is what the health
   * readout is for.
   */
  private async acquireWakeLock(): Promise<void> {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    try {
      this.wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      this.wakeLock = null;
    }
  }

  stop(reason = 'Hosting stopped.'): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const link of this.links.values()) {
      try {
        link.pc.close();
      } catch {
        /* already gone */
      }
    }
    this.links.clear();
    this.seated.clear();
    this.worker?.postMessage({ k: 'close' } satisfies HostIn);
    this.worker?.terminate();
    this.worker = null;
    this.signals?.stopHosting();
    this.signals?.close();
    this.signals = null;
    this.local?.fail();
    this.local = null;
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.events.onStopped?.(reason);
  }
}
