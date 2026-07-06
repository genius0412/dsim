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
  /** this client has an OPEN mesh link to every other in-room driver. START is
   * gated on EVERYONE reporting true, so the match only begins once the full
   * mesh is up from every peer's own perspective (not just the host's). */
  meshReady: boolean;
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
  /** the host's AUTHORITATIVE roster — non-hosts render THIS instead of their own
   * presence view, so every screen shows the same list */
  roster: (players: LobbyPlayer[]) => void;
  closed: () => void;
};

/** a random peer id */
function freshPeerId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `p${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** a peerId that is STABLE across a page refresh (per tab, via sessionStorage).
 * A random id every construction meant a reload rejoined under a NEW presence
 * key while the old one lingered until timeout — a ghost that inflated the
 * roster count, made clients disagree, and churned the earliest-joiner host
 * election. Reusing the id makes a reload replace the same key cleanly. */
function stablePeerId(): string {
  try {
    const KEY = 'decodesim.peerId';
    const existing = sessionStorage.getItem(KEY);
    if (existing) return existing;
    const id = freshPeerId();
    sessionStorage.setItem(KEY, id);
    return id;
  } catch {
    return freshPeerId();
  }
}

export class SupabaseLobby {
  readonly peerId: string;
  private channel: RealtimeChannel | null = null;
  private self: LobbyPlayer;
  private players: LobbyPlayer[] = [];
  /** peerId -> ms they announced leaving; filtered from the roster for a few
   * seconds so a slow/stale presence sync can't re-add a departed player */
  private readonly recentlyLeft = new Map<string, number>();
  /** current host, held STICKY: only re-elected when it actually leaves. Keyed on
   * peerId (NOT wall-clock joinedAt) so clock skew can't make a lagging-clock peer
   * look like the earliest joiner and hijack it, and a new joiner can't steal it. */
  private hostPeerId: string | null = null;
  private readonly handlers: Partial<Handlers> = {};

  constructor(self: Omit<LobbyPlayer, 'peerId' | 'ver' | 'joinedAt'>) {
    this.peerId = stablePeerId();
    this.self = { ...self, peerId: this.peerId, ver: 0, joinedAt: Date.now() };
  }

  on<K extends keyof Handlers>(event: K, cb: Handlers[K]): void {
    this.handlers[event] = cb;
  }

  /** re-elect the host only if the current one is gone (STICKY). Base election is
   * the smallest peerId present — deterministic + clock-independent, so every
   * client agrees on the same host. */
  private recomputeHost(): void {
    const ids = this.players.map((p) => p.peerId);
    if (ids.length === 0) {
      this.hostPeerId = null;
      return;
    }
    if (this.hostPeerId && ids.includes(this.hostPeerId)) return; // keep it
    this.hostPeerId = ids.reduce((a, b) => (a < b ? a : b));
  }

  hostId(): string | null {
    return this.hostPeerId;
  }

  isHost(): boolean {
    return this.hostPeerId === this.peerId;
  }

  /** our own current lobby state (for optimistic local display) */
  getSelf(): LobbyPlayer {
    return this.self;
  }

  /** host-only: publish the authoritative roster so every client renders it */
  broadcastRoster(players: LobbyPlayer[]): void {
    this.channel?.send({ type: 'broadcast', event: 'roster', payload: { players } });
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

    channel.on('presence', { event: 'sync' }, () => this.rebuildPlayers());
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
    channel.on('broadcast', { event: 'left' }, ({ payload }) => {
      this.recentlyLeft.set((payload as { peerId: string }).peerId, Date.now());
      this.rebuildPlayers(); // drop them from the roster right away
    });
    channel.on('broadcast', { event: 'roster' }, ({ payload }) => {
      this.handlers.roster?.((payload as { players: LobbyPlayer[] }).players);
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

  /** recompute the roster from the current presence replica (one player per key,
   * highest-ver entry wins) and emit it */
  private rebuildPlayers(): void {
    const now = Date.now();
    for (const [id, t] of this.recentlyLeft) if (now - t > 6000) this.recentlyLeft.delete(id);
    const state = this.channel?.presenceState<LobbyPlayer>() ?? {};
    this.players = Object.values(state)
      .map((entries) => entries as unknown as LobbyPlayer[])
      .filter((ps) => ps.length > 0) // an empty key would throw the reduce below
      .map((ps) => ps.reduce((a, b) => (b.ver >= a.ver ? b : a)))
      .filter((p) => !this.recentlyLeft.has(p.peerId)) // hide players who just left
      .sort((a, b) => (a.peerId < b.peerId ? -1 : 1));
    this.recomputeHost();
    this.handlers.players?.(this.players);
  }

  /** re-read our presence replica AND re-broadcast ourselves (bumped ver forces a
   * fresh presence sync on every client) — called on a heartbeat + the Refresh
   * button so a client that missed an update reconverges within one interval */
  async resync(): Promise<void> {
    if (!this.channel) return;
    this.rebuildPlayers();
    this.self = { ...this.self, ver: this.self.ver + 1 };
    await this.channel.track(this.self);
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
      // announce our departure EXPLICITLY so every client drops us at once —
      // presence untrack alone can propagate slowly / be missed, leaving a ghost
      try {
        ch.send({ type: 'broadcast', event: 'left', payload: { peerId: this.peerId } });
      } catch {
        /* ignore */
      }
      try {
        await ch.untrack(); // also drop our presence entry
      } catch {
        /* ignore */
      }
      await ch.unsubscribe();
    }
  }
}
