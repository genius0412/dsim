import type { RobotSetup } from '../sim/spawn';
import type { Transport } from './transport';
import { getAuthToken } from '../lib/authClient';
import { setServerNotice } from './notice';
import {
  encodeMsg,
  decodeServerMsg,
  type LobbyPlayer,
  type PlayerIntro,
  type PlayerPatch,
  type QueueMode,
  type RoomConfig,
} from './protocol';

export interface MatchStart {
  seed: number;
  setups: RobotSetup[];
  yourRobotId: number;
  /** ranked rooms only: drives the pre-match ELO intro overlay */
  ranked?: boolean;
  intros?: PlayerIntro[];
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
  /** ranked match found on a `?mm=1` connection: reconnect to `?room=<room>` (the
   * server routes it to `hostRegion`) to actually play */
  matchAssigned: (room: string, hostRegion: string, mode: QueueMode) => void;
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

  /** enter the ranked queue on this `?mm=1` connection. On a match the server sends
   * `matchAssigned` (reconnect to the host region). (Re)sends on open + reconnect,
   * with the auth JWT. `homeRegion`/`accessMs` are the client's network position (so
   * the matchmaker can pick a fair host); `noWiden` ⇒ never widen past my region. */
  queue(
    mode: QueueMode,
    player: Omit<LobbyPlayer, 'clientId'>,
    homeRegion: string,
    accessMs: number,
    noWiden?: boolean,
  ): void {
    const doQueue = async (): Promise<void> => {
      const authToken = (await getAuthToken()) ?? undefined;
      this.transport.send(
        encodeMsg({ t: 'queue', mode, player, authToken, homeRegion, accessMs, noWiden }),
      );
    };
    this.transport.onOpen(() => void doQueue());
    this.transport.onReopen(() => void doQueue());
  }

  /** widen the search radius now (impatient player) */
  expandSearch(): void {
    this.transport.send(encodeMsg({ t: 'expandSearch' }));
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
    } else if (m.t === 'matchAssigned') {
      this.handlers.matchAssigned?.(m.room, m.hostRegion, m.mode);
    } else if (m.t === 'error') {
      this.handlers.error?.(m.message);
    } else if (m.t === 'serverNotice') {
      setServerNotice(m.message ? { kind: m.kind, message: m.message, until: m.until } : null);
    }
  }
}
