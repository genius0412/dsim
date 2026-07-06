import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Alliance, AssistConfig, RobotSpec } from '../types';
import type { NetRobotSetup } from './protocol';
import { getSupabase } from './env';

/**
 * Lobby + signaling over a single Supabase Realtime channel per room code.
 * Uses ONLY presence (who's here + their robot config) and broadcast (WebRTC
 * SDP/ICE relay + the host's match-start) — no database tables, so the free
 * tier is trivially sufficient. The HOST is deterministically the peer with the
 * lexicographically smallest peerId (no creator flag, no host migration in v1).
 */

export const ROOM_CAPACITY = 4;

export interface LobbyPlayer {
  peerId: string;
  /** monotonic per-client revision. Re-tracking (alliance/ready changes) can
   * STACK presence entries under one key, and their array order is not
   * chronological and differs per client — so resolve a player to their
   * highest-`ver` entry to get one consistent, current value everywhere. */
  ver: number;
  /** ms epoch when this client joined — used to cap the room at the first
   * ROOM_CAPACITY joiners (later joiners bounce themselves) */
  joinedAt: number;
  name: string;
  teamName: string;
  teamNumber: number;
  alliance: Alliance;
  startIndex: number;
  ready: boolean;
  spec: RobotSpec;
  assists: AssistConfig;
}

/** an RTC signaling envelope relayed peer→peer over the channel */
export interface SignalMsg {
  from: string;
  to: string;
  data: unknown; // RTCSessionDescriptionInit | RTCIceCandidateInit | { type:'ice' }
}

/** host → everyone: build this exact world now */
export interface StartMsg {
  seed: number;
  setups: NetRobotSetup[];
  /** peerId → robotId, so each client learns which robot is theirs */
  assign: Record<string, number>;
}

type Handlers = {
  players: (players: LobbyPlayer[]) => void;
  signal: (msg: SignalMsg) => void;
  start: (msg: StartMsg) => void;
  restart: (seed: number) => void;
  /** the host removed us from the room */
  kicked: () => void;
  closed: () => void;
};

export class SupabaseLobby {
  readonly peerId: string;
  private channel: RealtimeChannel | null = null;
  private self: LobbyPlayer;
  private players: LobbyPlayer[] = [];
  private readonly handlers: Partial<Handlers> = {};

  constructor(self: Omit<LobbyPlayer, 'peerId' | 'ver' | 'joinedAt'>) {
    this.peerId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `p${Math.floor(Math.random() * 1e9).toString(36)}`;
    this.self = { ...self, peerId: this.peerId, ver: 0, joinedAt: Date.now() };
  }

  on<K extends keyof Handlers>(event: K, cb: Handlers[K]): void {
    this.handlers[event] = cb;
  }

  /** the room host = the EARLIEST joiner (joinedAt, peerId tiebreak). Stable:
   * it only changes when the host actually leaves, and never flickers on a
   * transient empty/partial presence sync (unlike a "smallest peerId" rule that
   * returned true for everyone whenever the list was momentarily empty). */
  hostId(): string | null {
    if (!this.players.length) return null;
    return this.players.reduce((a, b) =>
      a.joinedAt < b.joinedAt || (a.joinedAt === b.joinedAt && a.peerId < b.peerId) ? a : b,
    ).peerId;
  }

  isHost(): boolean {
    return this.hostId() === this.peerId;
  }

  getPlayers(): LobbyPlayer[] {
    return this.players;
  }

  /** join (or create — same thing) a room by code; resolves once subscribed */
  async join(code: string): Promise<void> {
    const supabase = getSupabase();
    if (!supabase) throw new Error('multiplayer not configured');
    const channel = supabase.channel(`decode:${code.toLowerCase()}`, {
      config: { presence: { key: this.peerId }, broadcast: { self: false } },
    });
    this.channel = channel;

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState<LobbyPlayer>();
      // one player PER presence key, resolved to the HIGHEST-ver entry (stacked
      // presences from re-tracking are not chronologically ordered, so "last"
      // is unreliable and can differ across clients — ver is authoritative)
      this.players = Object.values(state)
        .map((entries) => {
          const ps = entries as unknown as LobbyPlayer[];
          return ps.reduce((a, b) => (b.ver >= a.ver ? b : a));
        })
        .sort((a, b) => (a.peerId < b.peerId ? -1 : 1));
      this.handlers.players?.(this.players);
    });
    channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
      const msg = payload as SignalMsg;
      if (msg.to === this.peerId) this.handlers.signal?.(msg);
    });
    channel.on('broadcast', { event: 'start' }, ({ payload }) => {
      this.handlers.start?.(payload as StartMsg);
    });
    channel.on('broadcast', { event: 'restart' }, ({ payload }) => {
      this.handlers.restart?.((payload as { seed: number }).seed);
    });
    channel.on('broadcast', { event: 'kick' }, ({ payload }) => {
      if ((payload as { peerId: string }).peerId === this.peerId) this.handlers.kicked?.();
    });

    await new Promise<void>((resolve, reject) => {
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          channel.track(this.self).then(() => resolve());
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(new Error(`lobby channel ${status}`));
        } else if (status === 'CLOSED') {
          this.handlers.closed?.();
        }
      });
    });
  }

  /** update and re-broadcast our own lobby presence (name/spec/alliance/ready) */
  async updateSelf(patch: Partial<Omit<LobbyPlayer, 'peerId' | 'ver' | 'joinedAt'>>): Promise<void> {
    this.self = { ...this.self, ...patch, ver: this.self.ver + 1 };
    await this.channel?.track(this.self);
  }

  /** host-only: remove a player from the room */
  kick(peerId: string): void {
    this.channel?.send({ type: 'broadcast', event: 'kick', payload: { peerId } });
  }

  /** relay a WebRTC signal to one peer */
  sendSignal(to: string, data: unknown): void {
    this.channel?.send({
      type: 'broadcast',
      event: 'signal',
      payload: { from: this.peerId, to, data } satisfies SignalMsg,
    });
  }

  /** host-only: tell everyone to build the match world */
  startMatch(msg: StartMsg): void {
    this.channel?.send({ type: 'broadcast', event: 'start', payload: msg });
  }

  /** host-only: tell everyone to rebuild with a fresh seed */
  restartMatch(seed: number): void {
    this.channel?.send({ type: 'broadcast', event: 'restart', payload: { seed } });
  }

  async leave(): Promise<void> {
    if (this.channel) {
      const ch = this.channel;
      this.channel = null;
      try {
        await ch.untrack(); // drop our presence immediately (no ghost entry)
      } catch {
        /* ignore */
      }
      await ch.unsubscribe();
    }
  }
}
