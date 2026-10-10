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
import { DEFAULT_ROOM_CONFIG, encodeMsg } from '../net/protocol';
import { importerEnabled } from '../seasonVisibility';
import { coerceGameId, type GameId } from '../games/types';
import { LanSignalClient } from '../net/lanSignalClient';
import { acceptLanGuest, type LanLink } from '../net/lanPeer';
import { HOST_SEAT, REFUSE_CLOSE_MS, type HostIn, type HostOut } from './hostProtocol';

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
  /** the page → Worker post, kept so `transport` can build a replacement loopback */
  private toWorker: ((m: HostIn) => void) | null = null;
  /** the Worker has said `ready`: the room exists */
  private booted = false;
  private roomConfig: RoomConfig = DEFAULT_ROOM_CONFIG;
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

  /** true from `start()` resolving until `stop()` — a parked room that is not live is over */
  get live(): boolean {
    return this.booted && !this.stopped;
  }

  /** the game this room was built for, so a screen adopting it back can join as that game */
  get game(): GameId {
    return coerceGameId(this.roomConfig.game);
  }

  /**
   * The host's own transport, handed to the stock LobbyClient.
   *
   * ⚠️ **A FRESH ONE EVERY TIME THE LAST WAS CLOSED.** The lobby disposes its transport on the
   * way out (`Lobby.tsx`, unmount), which for a loopback drops the host's seat — correct — and
   * leaves the object closed for good. The room is still running in this tab, the LAN screen
   * adopts it back and offers GO TO THE ROOM again, and that click used to hand the lobby a
   * transport that could never open: the host sat on CONNECTING in a room they were hosting.
   * The seat was released on close, so a new loopback re-seats the host by the same `join`
   * a first visit does.
   */
  get transport(): Transport {
    if (this.stopped || !this.toWorker) throw new Error('start() first');
    if (!this.local || !this.local.isOpen) {
      this.local = this.makeLocal(this.toWorker);
      if (this.booted) this.local.open();
    }
    return this.local;
  }

  private makeLocal(toWorker: (m: HostIn) => void): LoopbackTransport {
    return new LoopbackTransport(
      (raw) => this.fromSeat(HOST_SEAT, raw, toWorker),
      () => {
        this.seated.delete(HOST_SEAT);
        toWorker({ k: 'drop', id: HOST_SEAT });
      },
    );
  }

  /**
   * `imports`: may an imported robot play in this room? The client's own gate by default
   * (`importerEnabled`, the same one that offers the import to this room, `roomTakesImportedRobots`);
   * the Worker's room has no server gate to read.
   */
  async start(
    code: string,
    config: RoomConfig = DEFAULT_ROOM_CONFIG,
    imports: boolean = importerEnabled(),
  ): Promise<string> {
    this.stopped = false;
    this.booted = false;
    this.roomConfig = config;
    const signals = new LanSignalClient();
    this.signals = signals;
    // claim the code FIRST: if it is taken, or the account is missing, nothing else should
    // have been built yet
    const claimed = await signals.host(code);
    this.roomCode = claimed.code;

    const worker = new Worker(new URL('./hostWorker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    const toWorker = (m: HostIn): void => worker.postMessage(m);
    this.toWorker = toWorker;
    this.local = this.makeLocal(toWorker);

    /* ⚠️ START() DOES NOT RESOLVE UNTIL THE ROOM EXISTS. Claiming the code and building the room are separate steps on separate
       threads, and resolving on the claim alone published a code for a room that had not been
       built — measured: a guest connected over WebRTC, the host counted it, and the guest sat
       on CONNECTING forever because the frames it sent were landing in a Worker whose `room`
       was still null. A Worker that fails to load is SILENT (`error` fires for a load or a
       synchronous throw, `failed` covers the async half, and neither is guaranteed), so the
       timeout is what makes the wait terminate in every case. */
    let onBoot: () => void = () => {};
    let onBootFail: (e: Error) => void = () => {};
    const roomReady = new Promise<void>((res, rej) => {
      onBoot = res;
      onBootFail = rej;
    });
    /** a Worker problem before the room exists fails `start()`; after it, it stops hosting */
    const workerDied = (reason: string): void => {
      if (this.booted) this.stop(reason);
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
        this.booted = true;
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
      /* EVERYONE LEFT — AND THE ROOM STAYS OPEN. It used to end hosting here, on the theory
         that an empty room is a Worker stepping nothing until the tab closes. It is not: the
         room's loop runs only during a match (`Room.startMatch`) and the room has already
         stopped it on its own, so an empty room is an idle object, exactly what it was the
         moment after START HOSTING. Ending hosting here meant a host who went to the lobby
         alone and pressed Back — to re-read the code, to change a setting — killed their own
         room, and every guest about to type that code was told nobody hosts it. Hosting ends
         when the host says so (Stop hosting) or the tab goes; the LAN screen shows the room
         as "Waiting for players…" meanwhile, which is the truth. */
      if (m.k === 'empty') return;
      /* THE ROOM WOULD NOT SEAT THIS PEER — tell it so, then let it go.
         An `error` frame is what the cloud sends a client it turns away, and the stock
         `LobbyClient` already surfaces one, so a refused LAN guest reads the same sentence
         over the same path instead of watching a link it cannot use go quiet. The link is
         closed a beat later (`REFUSE_CLOSE_MS`) so the frame is actually gone before the
         peer connection is torn down. */
      if (m.k === 'refused') {
        const raw = encodeMsg({ t: 'error', message: m.message });
        if (m.id === HOST_SEAT) {
          // the host's own seat was refused: nothing it can do about it, and a room it
          // cannot sit in is not a room it can host
          this.local?.deliver(raw);
          this.stop(m.message);
          return;
        }
        const link = this.links.get(m.id);
        if (link && link.control.readyState === 'open') {
          try {
            link.control.send(raw);
          } catch {
            /* the close below is the refusal either way */
          }
        }
        setTimeout(() => this.dropGuest(m.id, toWorker), REFUSE_CLOSE_MS);
        return;
      }
      if (m.k === 'health') {
        this.events.onHealth?.({ tickHz: m.tickHz, behind: m.behind });
      }
    });

    toWorker({ k: 'open', code: claimed.code, config, imports });

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
      let intro: {
        player?: Omit<LobbyPlayer, 'clientId'>;
        config?: RoomConfig;
        caps?: string[];
        channel?: string;
      } = {};
      try {
        intro = JSON.parse(raw) as typeof intro;
      } catch {
        /* fall through with an empty intro; the room sanitizes whatever it is given */
      }
      if (intro.player) {
        toWorker({
          k: 'add',
          id,
          player: intro.player,
          config: intro.config,
          caps: intro.caps,
          channel: intro.channel,
        });
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
    } catch (e) {
      // the guest gave up or could not be reached; nothing to clean up — but SAY SO, on the
      // one machine that can see both halves of a failed introduction (the guest only ever
      // sees its own side)
      console.warn('[lan] a guest could not be connected:', e instanceof Error ? e.message : e);
      return;
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
    this.toWorker = null;
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
