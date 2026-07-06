import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Alliance, AssistConfig, RobotSpec } from '../types';
import type { NetRobotSetup } from './protocol';
import { getSupabase } from './env';

/**
 * Lobby + signaling over a single Supabase Realtime channel per room code.
 * Supabase is used as a DUMB MESSAGE RELAY only (broadcast) — NOT its presence
 * feature, whose eventual-consistency caused endless roster desync. Membership
 * is an explicit protocol we control: each client BROADCASTS a `hello` on join
 * and on a heartbeat; every client tracks members from those hellos and drops
 * anyone unheard-from past MEMBER_TIMEOUT_MS (or who sent an explicit `left`).
 * The HOST = smallest peerId currently present, and publishes the authoritative
 * roster so every screen shows the same list. No database tables.
 */

export const ROOM_CAPACITY = 4;
/** how often each client re-announces itself (hello heartbeat) */
const HEARTBEAT_MS = 2000;
/** drop a member we haven't heard a hello from within this (crashed / gone) */
const MEMBER_TIMEOUT_MS = 6000;
/** a fresh client waits this long before claiming host, so it can hear (and
 * adopt) an existing host instead of stealing it. Only a genuine cold start or
 * a host that left past this grace self-elects. */
const SETTLE_MS = 1200;

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
  /** peerId -> their latest announced state (from `hello` broadcasts) */
  private readonly members = new Map<string, LobbyPlayer>();
  /** peerId -> ms we last heard a hello; drives the timeout liveness prune */
  private readonly lastSeen = new Map<string, number>();
  /** peerId -> ms they announced leaving; filtered for a few seconds so a
   * straggler hello can't re-add a departed player before it stops arriving */
  private readonly recentlyLeft = new Map<string, number>();
  /** current host — STICKY (kept while present) + adopted from peers' declarations,
   * so a newcomer defers to the existing host instead of stealing it */
  private hostPeerId: string | null = null;
  /** ms we subscribed — the settle-grace clock for cold-start host election */
  private subscribedAt = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly handlers: Partial<Handlers> = {};

  constructor(self: Omit<LobbyPlayer, 'peerId' | 'ver' | 'joinedAt'>) {
    this.peerId = stablePeerId();
    this.self = { ...self, peerId: this.peerId, ver: 0, joinedAt: Date.now() };
  }

  on<K extends keyof Handlers>(event: K, cb: Handlers[K]): void {
    this.handlers[event] = cb;
  }

  /** STICKY host: keep the current one while it's present (a newcomer can't
   * steal it — it adopts the existing host via `adoptHost` from peers' hellos/
   * rosters). Only elect when there's no valid host: a genuine cold start, or
   * the host left — and even then a FRESH joiner waits SETTLE_MS first so it can
   * hear an existing host before claiming. Tiebreak is smallest peerId. */
  private recomputeHost(): void {
    const ids = this.players.map((p) => p.peerId);
    if (ids.length === 0) {
      this.hostPeerId = null;
      return;
    }
    if (this.hostPeerId && ids.includes(this.hostPeerId)) return; // keep it
    if (Date.now() - this.subscribedAt > SETTLE_MS) {
      this.hostPeerId = ids.reduce((a, b) => (a < b ? a : b));
    }
    // else: wait out the grace — an existing host's declaration may still arrive
  }

  /** adopt a host another peer declares (in their hello/roster), so a newcomer
   * defers to the established host; on a rare dual-host cold-start, converge to
   * the smaller peerId */
  private adoptHost(host: string | null): void {
    if (!host || !this.members.has(host)) return;
    const cur = this.hostPeerId;
    if (!cur || !this.members.has(cur) || host < cur) this.hostPeerId = host;
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

  /** host-only: publish the authoritative roster (with our host declaration) so
   * every client renders the same list and adopts us as host */
  broadcastRoster(players: LobbyPlayer[]): void {
    this.channel?.send({ type: 'broadcast', event: 'roster', payload: { players, host: this.peerId } });
  }

  getPlayers(): LobbyPlayer[] {
    return this.players;
  }

  /** join (or create — same thing) a room by code; resolves once subscribed */
  async join(code: string): Promise<void> {
    const supabase = getSupabase();
    if (!supabase) throw new Error('multiplayer not configured');
    const channel = supabase.channel(`decode:${code.toLowerCase()}`, {
      config: { broadcast: { self: false } },
    });
    this.channel = channel;

    channel.on('broadcast', { event: 'hello' }, ({ payload }) => {
      const { player: p, host } = payload as { player: LobbyPlayer; host: string | null };
      if (p.peerId === this.peerId || this.recentlyLeft.has(p.peerId)) return;
      const isNew = !this.members.has(p.peerId);
      const cur = this.members.get(p.peerId);
      if (!cur || p.ver >= cur.ver) this.members.set(p.peerId, p); // newest wins
      this.lastSeen.set(p.peerId, Date.now());
      this.adoptHost(host); // defer to the host our peers already agree on
      if (isNew) this.sendHello(); // greet a newcomer so they learn US immediately
      this.rebuildPlayers();
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
    channel.on('broadcast', { event: 'left' }, ({ payload }) => {
      const id = (payload as { peerId: string }).peerId;
      this.recentlyLeft.set(id, Date.now());
      this.members.delete(id);
      this.lastSeen.delete(id);
      this.rebuildPlayers(); // drop them from the roster right away
    });
    channel.on('broadcast', { event: 'roster' }, ({ payload }) => {
      const { players, host } = payload as { players: LobbyPlayer[]; host: string | null };
      this.adoptHost(host);
      this.handlers.roster?.(players);
    });

    await new Promise<void>((resolve, reject) => {
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          this.subscribedAt = Date.now();
          this.sendHello(); // announce ourselves; existing members greet back
          this.rebuildPlayers();
          this.heartbeat = setInterval(() => {
            this.sendHello();
            this.rebuildPlayers(); // also prunes timed-out members
          }, HEARTBEAT_MS);
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(new Error(`lobby channel ${status}`));
        } else if (status === 'CLOSED') {
          this.handlers.closed?.();
        }
      });
    });
  }

  /** broadcast our current state + who we think the host is, so every client
   * (re)learns us and newcomers adopt the established host */
  private sendHello(): void {
    this.lastSeen.set(this.peerId, Date.now());
    this.channel?.send({
      type: 'broadcast',
      event: 'hello',
      payload: { player: this.self, host: this.hostPeerId },
    });
  }

  /** rebuild the roster from tracked members: prune the timed-out and the
   * recently-left, always include ourselves, sort by peerId, re-elect the host */
  private rebuildPlayers(): void {
    const now = Date.now();
    for (const [id, t] of this.recentlyLeft) if (now - t > MEMBER_TIMEOUT_MS) this.recentlyLeft.delete(id);
    for (const [id, seen] of this.lastSeen) {
      if (id !== this.peerId && now - seen > MEMBER_TIMEOUT_MS) {
        this.members.delete(id);
        this.lastSeen.delete(id);
      }
    }
    this.members.set(this.peerId, this.self); // we always know ourselves
    this.players = [...this.members.values()]
      .filter((p) => !this.recentlyLeft.has(p.peerId))
      .sort((a, b) => (a.peerId < b.peerId ? -1 : 1));
    this.recomputeHost();
    this.handlers.players?.(this.players);
  }

  /** re-announce ourselves and rebuild — the manual Refresh button; also pokes
   * everyone else's members list to reconverge */
  resync(): void {
    this.sendHello();
    this.rebuildPlayers();
  }

  /** update and re-broadcast our own state (name/spec/alliance/ready/meshReady) */
  updateSelf(patch: Partial<Omit<LobbyPlayer, 'peerId' | 'ver' | 'joinedAt'>>): void {
    this.self = { ...this.self, ...patch, ver: this.self.ver + 1 };
    this.sendHello();
    this.rebuildPlayers();
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
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.channel) {
      const ch = this.channel;
      this.channel = null;
      // announce our departure so every client drops us at once
      try {
        ch.send({ type: 'broadcast', event: 'left', payload: { peerId: this.peerId } });
      } catch {
        /* ignore */
      }
      await ch.unsubscribe();
    }
  }
}
