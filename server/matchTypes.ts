import type { Alliance, AssistConfig, RobotSpec } from '../src/types';
import type { QueueMode } from '../src/net/protocol';

/**
 * A ranked match staged by the designated matchmaker for a DIFFERENT machine (the
 * fair host region) to build. It is written to Postgres (`pending_matches`) and the
 * host machine claims it when the paired clients reconnect with `?room=<code>`. The
 * roster is authoritative — the host ignores client-supplied specs so a client can't
 * tamper with a ranked match by lying on its `join`.
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
}

export interface PendingMatch {
  /** region-coded room code `<hostRegion>-<rand>` */
  code: string;
  hostRegion: string;
  mode: QueueMode;
  seed: number;
  roster: PendingRosterEntry[];
  ranked: boolean;
}