import { Room, type Client } from './room';
import { persistMatch } from './persist';
import { getRating, createPendingMatch } from './db/repo';
import { dbEnabled } from './db/pool';
import { BALANCE_VERSION } from '../src/config';
import type { GameId } from '../src/types';
import { bestHost, type PingInfo } from './regions';
import type { PendingMatch, PendingRosterEntry } from './matchTypes';
import { QUEUE_NEED, type LobbyPlayer, type QueueMode, type ServerMsg } from '../src/net/protocol';

/**
 * Region-aware ranked matchmaking. Runs on the DESIGNATED matchmaker machine (all
 * `?mm=1` connections are fly-replayed here), so it holds ONE global queue per
 * bucket across every region. Pairing is region-local first and widens over time:
 *
 *  - Each entry reports `homeRegion` + `accessMs`; the matchmaker estimates every
 *    player's latency to every region (`bestHost`) and hosts a match on the fair
 *    MIDPOINT region (minimax).
 *  - A pairing is only allowed once its cross-region `spread` fits under every
 *    member's SEARCH RADIUS, which starts at 0 (same region only) and widens with
 *    wait time / an explicit `expandSearch`. So you get a local match if one is
 *    available soon, and a farther one only after waiting.
 *
 * On a match the matchmaker STAGES the roster (Postgres `pending_matches`) and sends
 * `matchAssigned`; the clients reconnect to the host region, which builds the real
 * match. When the DB is off (local dev) it falls back to hosting the match right
 * here (`localStart`), which only works for same-machine players — fine for dev.
 */

// search-radius schedule, in CROSS-REGION ms (not absolute ping — a player's own
// access latency never counts against the gate, so a bad local link can't block a
// local match). Starts region-local, widens one region-hop every interval.
export const RADIUS_BASE_MS = 0;
export const RADIUS_STEP_MS = 60;
export const RADIUS_INTERVAL_MS = 8000;
export const RADIUS_MAX_MS = 300;

/** the widening ceiling for one waiting entry (cross-region ms it will tolerate) */
export function radiusCeiling(waitedMs: number, expandBumps: number, noWiden?: boolean): number {
  if (noWiden) return 0; // stay region-local forever
  const steps = Math.floor(Math.max(0, waitedMs) / RADIUS_INTERVAL_MS) + expandBumps;
  return Math.min(RADIUS_MAX_MS, RADIUS_BASE_MS + RADIUS_STEP_MS * steps);
}

export interface QueueEntry {
  id: string;
  send: (m: ServerMsg) => void;
  player: Omit<LobbyPlayer, 'clientId'>;
  userId?: string;
  mode: QueueMode;
  homeRegion: string;
  accessMs: number;
  /** true ⇒ never widen past my own region */
  noWiden?: boolean;
  /** protocol capabilities this client build advertised (mixed-version safe) */
  caps?: string[];
  /** which game this client queued for (part of the bucket key — see bucketKey).
   * Absent ⇒ 'decode'. */
  game?: GameId;
  /** release channel ('alpha' | 'stable' | …). The matchmaker ONLY pairs entries
   * of the same channel — alpha and stable run different src/sim, so a shared
   * authoritative match would desync. Absent ⇒ 'stable'. */
  channel?: string;
  /** this client build's id (the git sha, `__BUILD_ID__`). The matchmaker ALSO
   * segregates by build so two different builds NEVER share an authoritative match
   * even inside one channel — the exact "same code" invariant (a channel is only a
   * coarse, manually-set proxy). This is what actually keeps alpha and main apart
   * automatically: their shas always differ, no `VITE_APP_CHANNEL` required. Matches
   * the client-side version gate ("everyone on the same version for multiplayer"),
   * enforced authoritatively here. Absent (old client that predates this) ⇒ falls
   * back to channel-only separation. */
  build?: string;
  /** set by enqueue (this.now()); drives the widening ceiling */
  enqueuedAt: number;
  /** extra manual widen steps from `expandSearch` */
  expandBumps: number;
  /** DEV FALLBACK only: told which local Room this connection landed in */
  onRoom?: (room: Room) => void;
}

/** how a paired group is handed off to its host machine. Production stages it to
 * Postgres; tests inject a recorder. */
export type StageFn = (m: PendingMatch) => Promise<void>;

export interface MatchmakerDeps {
  /** injectable clock (tests control widening); when set, the auto-widen timer is off */
  now?: () => number;
  /** override the staging step (default: Postgres pending_matches when dbEnabled) */
  stage?: StageFn;
}

let roomSeq = 0;
const rand6 = (): string => Math.floor(Math.random() * 0x7fffffff).toString(36).padStart(6, '0').slice(-6);

export class Matchmaker {
  private readonly queues: Record<QueueMode, QueueEntry[]> = { '1v1': [], '2v2': [] };
  private readonly rooms = new Set<Room>();
  private readonly now: () => number;
  private readonly stage?: StageFn;
  private readonly timer: ReturnType<typeof setInterval> | null;

  constructor(deps: MatchmakerDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    // default staging: write to Postgres so the host machine can claim it. Absent
    // (no injected stage AND no DB) ⇒ localStart fallback.
    this.stage = deps.stage ?? (dbEnabled ? (m) => createPendingMatch(m) : undefined);
    // auto-widen: re-attempt matches as ceilings grow. Disabled when a clock is
    // injected (deterministic tests drive matching via enqueue/expand/tick).
    this.timer = deps.now ? null : setInterval(() => this.tick(), 1000);
    if (this.timer?.unref) this.timer.unref(); // never keep the process alive
  }

  enqueue(entry: QueueEntry): void {
    this.remove(entry.id); // never double-queue a connection
    // never let one ACCOUNT hold two queue entries at once (a second tab, or a
    // stale entry a `?mm=1` reconnect left behind under a fresh connection id).
    // Otherwise the matchmaker could pair a user with THEMSELF, staging a roster
    // with two slots for one identity — on the host, `byUser` collapses to one
    // client, so one robot takes the driver's input (a "ghost" they control) and
    // the other is left unmapped + frozen. Drop any prior entry for this user.
    if (entry.userId) this.removeUser(entry.userId, entry.id);
    entry.enqueuedAt = this.now();
    entry.expandBumps = entry.expandBumps ?? 0;
    this.queues[entry.mode].push(entry);
    this.tryMatch(entry.mode);
    this.broadcastStatus(entry.mode);
  }

  remove(id: string): void {
    for (const mode of Object.keys(this.queues) as QueueMode[]) {
      const q = this.queues[mode];
      const i = q.findIndex((e) => e.id === id);
      if (i >= 0) {
        q.splice(i, 1);
        this.broadcastStatus(mode);
      }
    }
  }

  /** drop every queue entry belonging to `userId` EXCEPT connection `keepId`
   * (the fresh entry). Prevents one account from holding two queue slots. */
  private removeUser(userId: string, keepId: string): void {
    for (const mode of Object.keys(this.queues) as QueueMode[]) {
      const q = this.queues[mode];
      const before = q.length;
      this.queues[mode] = q.filter((e) => e.userId !== userId || e.id === keepId);
      if (this.queues[mode].length !== before) this.broadcastStatus(mode);
    }
  }

  /** impatient player: widen their radius one step now, then retry */
  expand(id: string): void {
    for (const mode of Object.keys(this.queues) as QueueMode[]) {
      const e = this.queues[mode].find((x) => x.id === id);
      if (e) {
        e.expandBumps++;
        this.tryMatch(mode);
        return;
      }
    }
  }

  /** periodic re-attempt as wait-driven ceilings grow (auto-widen) */
  tick(): void {
    this.tryMatch('1v1');
    this.tryMatch('2v2');
  }

  private ceilingOf(e: QueueEntry, now: number): number {
    return radiusCeiling(now - e.enqueuedAt, e.expandBumps, e.noWiden);
  }

  private tryMatch(mode: QueueMode): void {
    let m = this.findMatch(mode);
    while (m) {
      const ids = new Set(m.group.map((g) => g.id));
      this.queues[mode] = this.queues[mode].filter((e) => !ids.has(e.id));
      void this.startMatch(mode, m.group, m.hostRegion);
      m = this.findMatch(mode);
    }
  }

  /**
   * FIFO-anchored greedy pairing: for the oldest waiting entry, add later entries
   * that keep the group hostable under EVERY member's current radius, until the
   * bucket is full. Returns the group + its fair host region, or null.
   */
  private findMatch(mode: QueueMode): { group: QueueEntry[]; hostRegion: string } | null {
    const need = QUEUE_NEED[mode];
    const q = this.queues[mode];
    const now = this.now();
    for (let i = 0; i < q.length; i++) {
      const group = [q[i]];
      for (let j = 0; j < q.length && group.length < need; j++) {
        if (j === i) continue;
        // never pair across compatibility buckets (channel + build) — different
        // src/sim (alpha vs stable) OR different builds run different code, so a
        // shared authoritative match would desync both clients
        if (bucketKey(q[j]) !== bucketKey(q[i])) continue;
        // never put the same account in a group twice (backstop for the userId
        // dedup above) — a self-pair produces a frozen "ghost" robot
        if (q[j].userId && group.some((g) => g.userId === q[j].userId)) continue;
        const trial = [...group, q[j]];
        const { spread } = bestHost(trial.map(toPing));
        const ceiling = Math.min(...trial.map((e) => this.ceilingOf(e, now)));
        if (spread <= ceiling) group.push(q[j]);
      }
      if (group.length === need) {
        const { hostRegion } = bestHost(group.map(toPing));
        return { group, hostRegion };
      }
    }
    return null;
  }

  /** current overall ELO for a driver's intro card (best-effort; null on DB-off /
   * signed-out / read failure — the intro just shows "Unranked") */
  private async introElo(entry: QueueEntry, mode: QueueMode): Promise<number | null> {
    if (!dbEnabled || !entry.userId) return null;
    try {
      return await getRating(entry.userId, mode, BALANCE_VERSION);
    } catch {
      return null;
    }
  }

  private async startMatch(mode: QueueMode, group: QueueEntry[], hostRegion: string): Promise<void> {
    if (this.stage) await this.assign(mode, group, hostRegion);
    else this.localStart(mode, group); // dev fallback: host here (same-machine only)
  }

  /** stage the roster for the host region + tell each client to reconnect there */
  private async assign(mode: QueueMode, group: QueueEntry[], hostRegion: string): Promise<void> {
    const half = group.length / 2;
    const seed = (this.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const code = `${hostRegion}-${mode}${roomSeq++}${rand6()}`;
    const roster: PendingRosterEntry[] = await Promise.all(
      group.map(async (e, i) => ({
        userId: e.userId,
        name: e.player.name,
        teamName: e.player.teamName,
        teamNumber: e.player.teamNumber,
        spec: e.player.spec,
        assists: e.player.assists,
        // distinct START_POSES index per alliance (not trusted from the client)
        startIndex: i < half ? i : i - half,
        alliance: (i < half ? 'red' : 'blue') as PendingRosterEntry['alliance'],
        introElo: await this.introElo(e, mode),
        channel: e.channel,
        // stash the game in the roster jsonb so the host recovers it (no schema col)
        game: e.game,
      })),
    );
    await this.stage!({ code, hostRegion, mode, seed, roster, ranked: true, channel: group[0].channel, game: group[0].game });
    for (const e of group) e.send({ t: 'matchAssigned', mode, room: code, hostRegion });
  }

  /** DEV/no-DB fallback: run the match on THIS machine. Only reachable when
   * DATABASE_URL is unset, where everyone is on one machine anyway. Routes through
   * the SAME staged-roster path (`applyPending`) as production so the pre-match
   * STRATEGY window runs in dev too — dev clients may be anonymous, so synthesize a
   * stable per-connection id for the userId→slot mapping. */
  private localStart(mode: QueueMode, group: QueueEntry[]): void {
    const code = `mm-${mode}-${roomSeq++}`;
    const room = new Room(code, () => this.rooms.delete(room), { kind: 'versus', game: group[0].game }, persistMatch);
    this.rooms.add(room);
    const half = group.length / 2;
    const seed = (this.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const roster: PendingRosterEntry[] = group.map((e, i) => ({
      userId: e.userId ?? e.id, // dev: a stable id so the host can map roster slots
      name: e.player.name,
      teamName: e.player.teamName,
      teamNumber: e.player.teamNumber,
      spec: e.player.spec,
      assists: e.player.assists,
      startIndex: i < half ? i : i - half,
      alliance: (i < half ? 'red' : 'blue') as PendingRosterEntry['alliance'],
      introElo: null,
    }));
    group.forEach((e, i) => {
      const client: Client = {
        id: e.id,
        send: e.send,
        player: { ...e.player, clientId: e.id, alliance: roster[i].alliance },
        connected: true,
        disconnectAt: 0,
        userId: roster[i].userId,
        caps: e.caps,
        channel: e.channel,
      };
      room.add(client);
      e.onRoom?.(room);
    });
    room.applyPending({ code, hostRegion: '', mode, seed, roster, ranked: true });
  }

  /** live queue depth per bucket, for the public presence endpoint */
  queueSizes(): Record<QueueMode, number> {
    return { '1v1': this.queues['1v1'].length, '2v2': this.queues['2v2'].length };
  }

  private broadcastStatus(mode: QueueMode): void {
    // report each waiter the depth of ITS OWN bucket (channel + build) — pairing is
    // bucket-scoped, so a mixed count would falsely read "enough players" and never
    // match (a lone alpha queuer must not be told a pool of stable/older builds is ready)
    for (const e of this.queues[mode]) {
      const key = bucketKey(e);
      const size = this.queues[mode].reduce((n, x) => n + (bucketKey(x) === key ? 1 : 0), 0);
      e.send({ t: 'queued', mode, size, need: QUEUE_NEED[mode] });
    }
  }
}

const toPing = (e: QueueEntry): PingInfo => ({ homeRegion: e.homeRegion, accessMs: e.accessMs });

/** matchmaking compatibility bucket: two entries may only be paired when this key
 * matches — same release channel AND same client build. Absent build ⇒ '' (old
 * clients fall back to channel-only separation). */
// GAME is part of the bucket: a Chain-Reaction queuer and a DECODE queuer run
// DIFFERENT `step()`s, so they must NEVER share one authoritative room (instant
// desync). Old clients advertise no game ⇒ 'decode', so they only ever bucket with
// other DECODE players.
const bucketKey = (e: QueueEntry): string => `${e.game ?? 'decode'}|${e.channel ?? 'stable'}|${e.build ?? ''}`;
