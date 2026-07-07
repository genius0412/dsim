import { Room, type Client } from './room';
import { persistMatch } from './persist';
import { getRating } from './db/repo';
import { dbEnabled } from './db/pool';
import { BALANCE_VERSION } from '../src/config';
import {
  QUEUE_NEED,
  type LobbyPlayer,
  type PlayerIntro,
  type QueueMode,
  type ServerMsg,
} from '../src/net/protocol';

/**
 * Ranked matchmaking: an in-memory FIFO queue per bucket (1v1 / 2v2). When a
 * bucket fills, the matchmaker creates a versus Room, splits the group into red /
 * blue alliances, adds everyone (with their verified user id), and auto-starts.
 * The paired clients then receive `matchStart` and run exactly like a custom-room
 * match. ELO is applied on match end by `persistMatch`. (A first cut: FIFO, not
 * ELO-banded — ELO-band pairing is a later refinement over the same queue.)
 */
export interface QueueEntry {
  id: string;
  send: (m: ServerMsg) => void;
  player: Omit<LobbyPlayer, 'clientId'>;
  userId?: string;
  mode: QueueMode;
  /** told which Room this connection landed in, so the socket layer routes to it */
  onRoom: (room: Room) => void;
}

let roomSeq = 0;

export class Matchmaker {
  private readonly queues: Record<QueueMode, QueueEntry[]> = { '1v1': [], '2v2': [] };
  private readonly rooms = new Set<Room>();

  enqueue(entry: QueueEntry): void {
    // never double-queue a connection
    this.remove(entry.id);
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

  private tryMatch(mode: QueueMode): void {
    const need = QUEUE_NEED[mode];
    const q = this.queues[mode];
    while (q.length >= need) {
      // splice removes the group synchronously (no double-match) before the async
      // ELO fetch; fire-and-forget so the queue keeps draining
      void this.startMatch(mode, q.splice(0, need));
    }
  }

  /** current overall ELO for one queued driver's intro card (best-effort: null
   * when the DB is off, the driver is signed out, or the read fails — the intro
   * then shows "Unranked" rather than blocking the match on the DB) */
  private async introElo(entry: QueueEntry, mode: QueueMode): Promise<number | null> {
    if (!dbEnabled || !entry.userId) return null;
    try {
      return await getRating(entry.userId, mode, 'overall', BALANCE_VERSION);
    } catch {
      return null;
    }
  }

  private async startMatch(mode: QueueMode, group: QueueEntry[]): Promise<void> {
    const code = `mm-${mode}-${roomSeq++}`;
    const room = new Room(
      code,
      () => this.rooms.delete(room),
      { kind: 'versus' },
      persistMatch,
    );
    this.rooms.add(room);
    const half = group.length / 2;
    // robot ids are assigned by add-order in room.startMatch, so build the intro
    // keyed by index i (= robotId) and read each driver's ELO in parallel
    const intros: PlayerIntro[] = await Promise.all(
      group.map(async (e, i) => ({ id: i, elo: await this.introElo(e, mode) })),
    );
    group.forEach((e, i) => {
      const alliance = i < half ? 'red' : 'blue';
      const client: Client = {
        id: e.id,
        send: e.send,
        player: { ...e.player, clientId: e.id, alliance },
        connected: true,
        disconnectAt: 0,
        userId: e.userId,
      };
      room.add(client);
      e.onRoom(room); // the socket layer now routes this connection's msgs to `room`
    });
    room.setRankedIntro(intros);
    room.startMatchNow();
  }

  private broadcastStatus(mode: QueueMode): void {
    const size = this.queues[mode].length;
    for (const e of this.queues[mode]) {
      e.send({ t: 'queued', mode, size, need: QUEUE_NEED[mode] });
    }
  }
}
