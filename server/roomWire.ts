/**
 * THE MESSAGES BETWEEN THE SOCKET THREAD AND A SIM WORKER (`SIM_WORKERS` > 0).
 *
 * `docs/scaling-multicore.md` Option A: rooms run in worker threads, the main thread keeps every
 * socket, the HTTP server, the matchmaker, the DB pool and presence. This file is the whole
 * vocabulary the two sides speak — types only, plus one pure helper — so neither side can grow a
 * message the other has never heard of without it showing up here.
 *
 * Both directions are BATCHED: each side queues items and posts one array per event-loop turn
 * (the worker once per clock turn, so a turn's snapshots for every room travel in one post).
 * Order within a direction is preserved, and that is load-bearing — a `welcome` a reattach sends
 * must reach the socket before the reply that tells main the reattach succeeded, and a socket's
 * `detach` must reach the worker after every frame it sent before closing.
 *
 * ⚠️ PLAIN DATA ONLY. Everything here crosses `postMessage`, i.e. the structured-clone algorithm:
 * no functions (a `Client`'s `send`/`sendRaw`/`backlog` stay on main, keyed by a SINK KEY), no
 * class instances, no Maps where a record will do.
 */
import type { Client, DodgeReport, BehaviourReport, MatchOutcome, PersistOutcome } from './room';
import type { PendingMatch } from './matchTypes';
import type { DodgeVerdict } from '../src/dodge';
import type { ClientMsg, LiveRoom, RoomConfig, RoomKind } from '../src/net/protocol';
import type { GameId, Physics } from '../src/types';

/** a `Client` with its three socket functions removed; `sink` says which of them main has */
export type ClientDesc = Omit<Client, 'send' | 'sendRaw' | 'backlog'> & { hasRaw: boolean; hasBacklog: boolean };

/** strip the functions off a `Client` so it can cross the thread boundary */
export function describeClient(c: Client): ClientDesc {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { send, sendRaw, backlog, ...rest } = c;
  return { ...rest, hasRaw: typeof sendRaw === 'function', hasBacklog: typeof backlog === 'function' };
}

export type LobbySummary = {
  code: string;
  players: number;
  capacity: number;
  kind: RoomKind;
  game: GameId;
  joinable: boolean;
  state: 'lobby' | 'strategy' | 'match' | 'full';
};

/**
 * WHAT MAIN MAY READ ABOUT A ROOM WITHOUT ASKING. Pushed by the worker after anything that can
 * change it and at a low rate regardless; `index.ts`'s synchronous reads (`canJoin`,
 * `lobbySummary`, `summary`, `presenceSnapshot`, …) are answered from the newest copy.
 *
 * `ack` is the last main→worker sequence number the worker had processed when it built this
 * mirror, so main can tell a mirror that predates its own latest mutation from one that saw it.
 */
export interface RoomMirror {
  ack: number;
  config: RoomConfig;
  gameId: GameId;
  physics: Physics;
  staging: boolean;
  canJoin: boolean;
  lobby: LobbySummary;
  abandonable: boolean;
  summary: LiveRoom | null;
  presence: { players: { userId: string; act: 'lobby' | 'match' }[]; guests: { id: string; act: 'lobby' | 'match' }[] };
  holdsCapacity: boolean;
  spectators: number;
  hasWorld: boolean;
  tick: number;
  /** userId → the client id holding that account's seat (`Room.seatFor`) */
  seats: Record<string, string>;
  snapGap: { n: number; sumMs: number; maxMs: number };
}

export interface RoomCallbacksPresent {
  result: boolean;
  active: boolean;
  inactive: boolean;
  dodge: boolean;
  behaviour: boolean;
}

// ─── main → worker ──────────────────────────────────────────────────────────
export type ToWorker =
  /** `has` mirrors which constructor callbacks main was given: a room behaves differently with
   *  and without `onResult` (it only waits for a persist it has somewhere to send), so the
   *  worker must pass exactly the same set */
  | { k: 'create'; seq: number; roomId: number; code: string; config: RoomConfig; group: string; has: RoomCallbacksPresent }
  | { k: 'add'; seq: number; roomId: number; key: number; client: ClientDesc }
  | { k: 'spectate'; seq: number; roomId: number; key: number; client: ClientDesc }
  | { k: 'reattach'; seq: number; roomId: number; req: number; key: number; id: string; hasRaw: boolean; hasBacklog: boolean; token?: string; trusted: boolean }
  | { k: 'detach'; seq: number; roomId: number; id: string; key: number; clean: boolean }
  | { k: 'msg'; seq: number; roomId: number; id: string; msg: ClientMsg }
  | { k: 'applyPending'; seq: number; roomId: number; req: number; pending: PendingMatch }
  | { k: 'resolveReport'; seq: number; roomId: number; req: number; id: string; robotId: number }
  | { k: 'resolveScoreReport'; seq: number; roomId: number; req: number; id: string }
  | { k: 'do'; seq: number; roomId: number; op: 'maybeStartRanked' | 'releaseSeatLock' | 'abandonSlot' | 'hideSpectator' | 'resetSnapGap' | 'setGroup'; a?: string; b?: string }
  | { k: 'dispose'; seq: number; roomId: number }
  | { k: 'reply'; req: number; value: unknown }
  | { k: 'backlog'; vals: [number, number][] }
  /** TEST SEAM (`RoomPool.advanceForTest`): pump a room's match synchronously in its worker */
  | { k: 'testAdvance'; seq: number; roomId: number; req: number; ticks: number; toPost: boolean };

// ─── worker → main ──────────────────────────────────────────────────────────
export type FromWorker =
  /** a string for one sink — already encoded exactly as main would have encoded it */
  | { k: 'out'; key: number; s: string }
  | { k: 'mirror'; roomId: number; m: RoomMirror }
  | { k: 'empty'; roomId: number }
  | { k: 'refused'; roomId: number; key: number }
  | { k: 'active'; roomId: number; uid: string }
  | { k: 'inactive'; roomId: number; uid: string }
  | { k: 'behaviour'; roomId: number; b: BehaviourReport }
  /** the room awaits these: main runs the DB work and answers with `reply` */
  | { k: 'result'; roomId: number; req: number; o: MatchOutcome }
  | { k: 'dodge'; roomId: number; req: number; d: DodgeReport }
  | { k: 'reply'; req: number; value: unknown }
  | { k: 'ready'; warm: { ms: number; ticks: number } | null };

export type { PersistOutcome, DodgeVerdict };
