import type { Alliance, AssistConfig, GameId, Physics, RobotSpec } from '../src/types';
import type { QueueMode } from '../src/net/protocol';

/**
 * A ranked match staged by the designated matchmaker for a DIFFERENT machine (the
 * fair host region) to build. It is written to Postgres (`pending_matches`) and the
 * host machine claims it when the paired clients reconnect with `?room=<code>`.
 *
 * The roster is authoritative for IDENTITY (userId→slot), ALLIANCE, and SEED — a
 * client can't move itself to another side or change the seed. The `spec`/`assists`
 * here are the pre-match BASELINE only: during the pre-match strategy window a driver
 * may RE-PICK its build, and the host takes the LIVE roster spec at start (re-validated
 * by `coerceSpec`/`coerceSetup`, so it still can't exceed the build limits). So this
 * staged spec seeds the intro/fallback, not the final robot.
 */
export interface PendingRosterEntry {
  /** verified user id (ranked requires auth, so this is always set in practice) */
  userId?: string;
  name: string;
  teamName: string;
  teamNumber: number;
  spec: RobotSpec;
  assists: AssistConfig;
  /** START_POSES index, assigned per-alliance by the matchmaker (not trusted from client) */
  startIndex: number;
  alliance: Alliance;
  /** overall ELO snapshot for the pre-match intro overlay (null if unrated/DB-off) */
  introElo: number | null;
  autoPath?: string;
  autoPathEnabled?: boolean;
  /** release channel of this player (all entries share one — the matchmaker only
   * groups a single channel). Stored in the roster jsonb so the host region can
   * recover `PendingMatch.channel` without a schema column. */
  channel?: string;
  /** which game the match plays (all entries share one — bucketed by game). Stored
   * in the roster jsonb so the host recovers `PendingMatch.game` without a schema
   * column (same trick as `channel`). Absent ⇒ 'decode'. */
  game?: GameId;
  /** which PHYSICS the staged room runs on — the same jsonb trick again, for the same
   * reason: no schema column, and every entry in one staged match shares the value.
   * Absent ⇒ '2d', which is every pairing staged before Day 2. */
  physics?: Physics;
  /** the verified challenge token this player queued under, if any — the same jsonb trick.
   * The rating update reads it at match end: a premade partner who walks out does not
   * protect you, a wide premade moves at half, and a rated 1v1 challenge (one token on both
   * alliances) takes no margin multiplier. Absent ⇒ queued solo, which is also what a roster
   * staged by an older matchmaker reads as. */
  party?: string;
}

export interface PendingMatch {
  /** region-coded room code `<hostRegion>-<rand>` */
  code: string;
  hostRegion: string;
  mode: QueueMode;
  seed: number;
  roster: PendingRosterEntry[];
  ranked: boolean;
  /** which game the staged match plays (Absent ⇒ 'decode'). The host resolves the
   * sim module from it; the matchmaker only ever groups one game (bucketKey). */
  game?: GameId;
  /** release channel of the paired players ('alpha' | 'stable' | …); the matchmaker
   * only ever groups a single channel. Alpha rooms are not persisted (in-dev). */
  channel?: string;
  /**
   * WHICH PHYSICS THE HOST MUST BUILD THIS MATCH ON.
   *
   * The matchmaker decides it, not the clients and not the host region: a ranked population
   * is one population, so every staged match of a game must run the same solve or the board
   * it feeds is two boards wearing one name. Absent ⇒ '2d' (every pairing staged before
   * Day 2, and every game that declares no 3D option).
   */
  physics?: Physics;
}
