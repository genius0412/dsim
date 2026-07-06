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

export interface LobbyPlayer {
  peerId: string;
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
  closed: () => void;
};

export class SupabaseLobby {
  readonly peerId: string;
  private channel: RealtimeChannel | null = null;
  private self: LobbyPlayer;
  private players: LobbyPlayer[] = [];
  private readonly handlers: Partial<Handlers> = {};

  constructor(self: Omit<LobbyPlayer, 'peerId'>) {
    this.peerId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `p${Math.floor(Math.random() * 1e9).toString(36)}`;
    this.self = { ...self, peerId: this.peerId };
  }

  on<K extends keyof Handlers>(event: K, cb: Handlers[K]): void {
    this.handlers[event] = cb;
  }

  /** true if this client is the host (smallest peerId among present players) */
  isHost(): boolean {
    if (!this.players.length) return true;
    return this.players.every((p) => this.peerId <= p.peerId);
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
      // one player PER presence key: re-tracking (e.g. an alliance switch) can
      // stack several presence entries under the same key — take the most
      // recent so a player never appears twice
      this.players = Object.values(state)
        .map((entries) => entries[entries.length - 1] as unknown as LobbyPlayer)
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
  async updateSelf(patch: Partial<Omit<LobbyPlayer, 'peerId'>>): Promise<void> {
    this.self = { ...this.self, ...patch };
    await this.channel?.track(this.self);
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
      await this.channel.unsubscribe();
      this.channel = null;
    }
  }
}
