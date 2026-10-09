/**
 * THE WIRE BETWEEN THE SOCKET THREAD AND A ROOM WORKER (`SIM_WORKERS`, docs/scaling-multicore.md).
 *
 * Types only, so both ends can import it: `server/roomHost.ts` (the socket thread) and
 * `server/roomWorker.ts` (a worker). Neither end's runtime code may leak into the other — the
 * worker must not pull in `ws`, `pg` or the HTTP server, and the socket thread must not pull in
 * the worker's `parentPort` handling.
 *
 * Every message crosses by structured clone, so everything here is plain data.
 */
import type { ClientMsg, LiveRoom, RoomConfig } from '../src/net/protocol';
import type { PendingMatch } from './matchTypes';
import type { BehaviourReport, Client, Room } from './room';

/** a `Client` with its three socket functions removed — the part that can be cloned. The
 *  worker rebuilds the functions around the socket KEY (`sock`) it is sent with. */
export type ClientData = Omit<Client, 'send' | 'sendRaw' | 'backlog'>;

/** which optional Room callbacks the socket thread supplied, so the worker's Room is built
 *  with exactly the same set (a Room with no `onResult` behaves differently from one with). */
export const CB_RESULT = 1;
export const CB_ACTIVE = 2;
export const CB_INACTIVE = 4;
export const CB_DODGE = 8;
export const CB_BEHAVIOUR = 16;

/**
 * Socket thread → worker. `rid` is a per-process room INSTANCE id, never the code: a code is
 * reused as soon as its room empties, and a late message for the old room must not land on the
 * new one.
 *
 * `seq` rides only on the ops that can put somebody INTO a room (add, spectate, reattach,
 * applyPending). The worker echoes the newest one it has applied in `RoomFacts.ack`, which is
 * how the socket thread knows whether its mirror already reflects them (see `RemoteRoom`).
 *
 * `call` is a request id: the worker answers it with a `reply` event.
 */
export type Op =
  | { k: 'create'; rid: number; code: string; config: RoomConfig; group: string; cbs: number }
  | { k: 'group'; rid: number; group: string }
  | { k: 'add'; rid: number; seq: number; sock: number; client: ClientData }
  | { k: 'spec'; rid: number; seq: number; sock: number; client: ClientData }
  | { k: 'hide'; rid: number; id: string }
  /** `sock` 0 = this socket never attached (the socket thread's `conn` was still 0) */
  | { k: 'detach'; rid: number; id: string; sock: number; clean: boolean }
  /** `caps`: the returning socket's, which replace the seat's (`Room.reattach`); absent keeps them */
  | { k: 'reattach'; rid: number; seq: number; call: number; id: string; sock: number; token?: string; trusted: boolean; caps?: string[] }
  /** `sock`: the socket key the message arrived on, so a REPLACED socket is dropped (`Room.onMessage`'s `conn`) */
  | { k: 'msg'; rid: number; id: string; msg: ClientMsg; sock?: number }
  | { k: 'closeIdle'; rid: number; message: string }
  | { k: 'pending'; rid: number; seq: number; call: number; p: PendingMatch }
  | { k: 'maybeStart'; rid: number }
  | { k: 'abandon'; rid: number; id: string; token?: string }
  | { k: 'unlock'; rid: number; uid: string }
  | { k: 'report'; rid: number; call: number; id: string; robotId: number }
  | { k: 'scoreReport'; rid: number; call: number; id: string }
  /** the socket thread holds no reference to this room any more; the worker may forget it */
  | { k: 'dispose'; rid: number }
  /** bytes a socket still has queued (post-deflate), for `Client.backlog` */
  | { k: 'backlog'; sock: number; bytes: number }
  /** the answer to a worker's `call` event */
  | { k: 'reply'; call: number; value?: unknown; error?: string }
  | { k: 'perfReset' };

/**
 * What the socket thread must be able to answer about a room WITHOUT asking the worker, because
 * it answers synchronously today: the join door (`canJoin`, `seatFor`, `lobbySummary`), the
 * one-game lock (`staging`), `/api/live`, the presence beat and admission control. The worker
 * recomputes these whenever the room could have changed and sends them only when they did.
 */
export interface RoomFacts {
  /** the newest populating `seq` the worker has applied */
  ack: number;
  lobby: ReturnType<Room['lobbySummary']>;
  /** the config as the room holds it NOW (a host can unlock a record room), for the socket thread's copy */
  cfg: ReturnType<Room['cfgFacts']>;
  /** [userId, clientId] for every signed-in seat, for `seatFor` */
  seats: [string, string][];
  staging: boolean;
  summary: LiveRoom | null;
  presence: ReturnType<Room['presenceSnapshot']>;
  holds: boolean;
  abandonable: boolean;
  spectators: number;
  /** `Room.countsTowardHostCap` and `Room.isPlainLobby`, for the admission guards */
  hostCap: boolean;
  plainLobby: boolean;
  /**
   * What the room holds as far as imported robots go (`Room.importState`, minus `allows`, which
   * the socket thread answers itself from the config and the staged roster). The join, rejoin
   * and spectate doors read it through `RemoteRoom.importState`. `ids`: the robot ids the seats
   * hold, so the join door can refuse a second seat claiming one.
   */
  imports: { hasImport: boolean; capless: boolean; ids: string[] };
}

/** per-worker load, pushed once a second for `/api/perf` */
export interface WorkerStats {
  rooms: number;
  /** event-loop delay since the last `perfReset`, in ms */
  lag: { mean: number; p50: number; p99: number; max: number };
  /** share of the last second this worker's loop spent busy (0..1) */
  busy: number;
}

/** Worker → socket thread, inside a `Batch`. */
export type Ev =
  | { k: 'ready' }
  | { k: 'facts'; rid: number; f: RoomFacts }
  | { k: 'empty'; rid: number }
  | { k: 'lock'; rid: number; uid: string; on: boolean }
  | { k: 'call'; rid: number; call: number; fn: 'result' | 'dodge'; arg: unknown }
  | { k: 'behaviour'; rid: number; b: BehaviourReport }
  | { k: 'reply'; call: number; value: unknown }
  | { k: 'disposed'; rid: number }
  /** snapshot-spacing samples since the last push: [rid, n, sumMs, maxMs] */
  | { k: 'gaps'; list: [number, number, number, number][] }
  | { k: 'stats'; s: WorkerStats };

/**
 * One flush from a worker: every frame it wrote since the last one, then every event.
 *
 * Frames are `w` = [sock, index into `s`, sock, index, …]. A broadcast is encoded once by the
 * room (`Client.sendRaw`), so the same string is handed to several sockets and is cloned across
 * the thread boundary once, not once per recipient.
 */
export interface Batch {
  s: string[];
  w: number[];
  e: Ev[];
}
