/**
 * Message transport abstraction with automatic reconnection. Phase 0 ships a
 * plain WebSocket; Phase 1 slots a WebTransport (QUIC datagram) implementation in
 * behind the same interface so neither the LobbyClient nor the ServerSession
 * changes.
 *
 * A single listener per event (set, not add): ownership of the socket is HANDED
 * OFF from the LobbyClient to the ServerSession at match start — the new owner
 * re-registers the callbacks it cares about and takes over routing.
 *
 * On an unexpected drop the transport transparently reconnects (fixed backoff up
 * to a budget): `onDown` fires while it's down, `onReopen` when it comes back
 * (distinct from the FIRST `onOpen`), and `onFail` if the budget is exhausted.
 * The lobby re-sends `join` on reopen; the in-match session re-sends `rejoin`.
 */
export interface Transport {
  send(data: string): void;
  onMessage(cb: (data: string) => void): void;
  /** first successful connection */
  onOpen(cb: () => void): void;
  /** a reconnection after a drop (NOT the first open) */
  onReopen(cb: () => void): void;
  /** the socket dropped; an auto-reconnect is now in progress */
  onDown(cb: () => void): void;
  /** could not (re)connect within the retry budget — give up */
  onFail(cb: () => void): void;
  close(): void;
  readonly isOpen: boolean;
}

const RECONNECT_DELAY_MS = 1000;
/** ~40 s of auto-retries before giving up — roughly matches the server-side reconnect
 * grace (45 s) so a transient outage recovers on its own; a longer absence falls back
 * to the manual "rejoin your match" flow from Home. */
const MAX_RECONNECT_ATTEMPTS = 40;

export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private messageCb: ((data: string) => void) | null = null;
  private openCb: (() => void) | null = null;
  private reopenCb: (() => void) | null = null;
  private downCb: (() => void) | null = null;
  private failCb: (() => void) | null = null;
  private opened = false; // has it ever successfully opened
  private disposed = false;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string) {
    this.connect();
  }

  private connect(): void {
    if (this.disposed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') this.messageCb?.(e.data);
    };
    ws.onopen = () => {
      this.attempts = 0;
      if (!this.opened) {
        this.opened = true;
        this.openCb?.();
      } else {
        this.reopenCb?.();
      }
    };
    ws.onclose = () => {
      if (this.disposed) return;
      this.downCb?.();
      this.scheduleReconnect();
    };
    ws.onerror = () => {}; // a close event always follows; reconnect drives there
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.attempts >= MAX_RECONNECT_ATTEMPTS) {
      this.failCb?.();
      return;
    }
    this.attempts++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }

  send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  onMessage(cb: (data: string) => void): void {
    this.messageCb = cb;
  }

  onOpen(cb: () => void): void {
    if (this.opened) cb();
    else this.openCb = cb;
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
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}
