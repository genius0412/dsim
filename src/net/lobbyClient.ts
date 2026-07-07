import type { RobotSetup } from '../sim/spawn';
import type { Transport } from './transport';
import { getAuthToken } from '../lib/authClient';
import {
  encodeMsg,
  decodeServerMsg,
  type LobbyPlayer,
  type PlayerPatch,
  type QueueMode,
  type RoomConfig,
} from './protocol';

export interface MatchStart {
  seed: number;
  setups: RobotSetup[];
  yourRobotId: number;
}

/**
 * Client-side lobby over the game-server socket. Replaces the old Supabase
 * Realtime presence/signaling lobby: the server is authoritative for the roster
 * and the host, so this is a thin relay — join a room, patch your own state,
 * render the server's roster, and (host) press start. At `matchStart` the
 * caller mints a ServerSession that TAKES OVER this same transport.
 */
type Handlers = {
  roster: (players: LobbyPlayer[], hostId: string) => void;
  matchStart: (m: MatchStart) => void;
  queued: (mode: QueueMode, size: number, need: number) => void;
  error: (message: string) => void;
  closed: () => void;
};

export class LobbyClient {
  clientId = '';
  hostId = '';
  players: LobbyPlayer[] = [];
  private readonly handlers: Partial<Handlers> = {};

  constructor(readonly transport: Transport) {
    transport.onMessage((d) => this.onMessage(d));
    // a transient drop auto-reconnects (see below); only a give-up is terminal
    transport.onFail(() => this.handlers.closed?.());
  }

  on<K extends keyof Handlers>(event: K, cb: Handlers[K]): void {
    this.handlers[event] = cb;
  }

  /** join (or create) a room; (re)sends on open AND on any reconnect. `config`
   * (set only by the room CREATOR) picks versus vs. record-chasing. Attaches the
   * Neon Auth JWT (if signed in) so the server attributes the run. */
  join(room: string, player: Omit<LobbyPlayer, 'clientId'>, config?: RoomConfig): void {
    const doJoin = async (): Promise<void> => {
      const authToken = (await getAuthToken()) ?? undefined;
      this.transport.send(encodeMsg({ t: 'join', room, player, config, authToken }));
    };
    this.transport.onOpen(() => void doJoin());
    this.transport.onReopen(() => void doJoin());
  }

  /** change our own alliance / start pose / ready / spec */
  update(patch: PlayerPatch): void {
    this.transport.send(encodeMsg({ t: 'update', patch }));
  }

  /** host only: begin the match */
  start(): void {
    this.transport.send(encodeMsg({ t: 'start' }));
  }

  /** enter the ranked queue; on a match the server sends `matchStart` (handled
   * exactly like a lobby start). (Re)sends on open + reconnect, with the auth JWT. */
  queue(mode: QueueMode, player: Omit<LobbyPlayer, 'clientId'>): void {
    const doQueue = async (): Promise<void> => {
      const authToken = (await getAuthToken()) ?? undefined;
      this.transport.send(encodeMsg({ t: 'queue', mode, player, authToken }));
    };
    this.transport.onOpen(() => void doQueue());
    this.transport.onReopen(() => void doQueue());
  }

  leaveQueue(): void {
    this.transport.send(encodeMsg({ t: 'leaveQueue' }));
  }

  isHost(): boolean {
    return this.clientId !== '' && this.clientId === this.hostId;
  }

  dispose(): void {
    this.transport.close();
  }

  private onMessage(data: string): void {
    const m = decodeServerMsg(data);
    if (m.t === 'welcome') {
      this.clientId = m.clientId;
    } else if (m.t === 'roster') {
      this.players = m.players;
      this.hostId = m.hostId;
      this.handlers.roster?.(m.players, m.hostId);
    } else if (m.t === 'matchStart') {
      this.handlers.matchStart?.(m);
    } else if (m.t === 'queued') {
      this.handlers.queued?.(m.mode, m.size, m.need);
    } else if (m.t === 'error') {
      this.handlers.error?.(m.message);
    }
  }
}
