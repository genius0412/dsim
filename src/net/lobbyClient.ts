import type { RobotSetup } from '../sim/spawn';
import type { Transport } from './transport';
import {
  encodeMsg,
  decodeServerMsg,
  type LobbyPlayer,
  type PlayerPatch,
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

  /** join (or create) a room; (re)sends on open AND on any reconnect */
  join(room: string, player: Omit<LobbyPlayer, 'clientId'>): void {
    const doJoin = (): void => this.transport.send(encodeMsg({ t: 'join', room, player }));
    this.transport.onOpen(doJoin);
    this.transport.onReopen(doJoin);
  }

  /** change our own alliance / start pose / ready / spec */
  update(patch: PlayerPatch): void {
    this.transport.send(encodeMsg({ t: 'update', patch }));
  }

  /** host only: begin the match */
  start(): void {
    this.transport.send(encodeMsg({ t: 'start' }));
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
    } else if (m.t === 'error') {
      this.handlers.error?.(m.message);
    }
  }
}
