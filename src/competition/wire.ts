/**
 * COMPETITIONS ON THE WIRE — what `/api/competitions/*` answers, shared by `server/competitions.ts`
 * (which builds it) and the client (which renders it).
 *
 * Every timestamp is epoch MILLISECONDS, every id an entry id or a match id as the database numbers
 * it. Names ride with the badge fields every name surface carries (`docs/area/accounts.md`, "THE
 * BADGE GOES ON EVERY NAME"), written out here rather than imported from `src/net/api.ts`, which
 * the server must not type-check against.
 */
import type { EquippedBadge } from '../badges';
import type { GameId } from '../games/types';
import type {
  CompFormat,
  CompMatchCore,
  CompRole,
  CompSettings,
  CompStatus,
  CompetitionSummary,
  EntryStatus,
  Placement,
  PlayoffAlliance,
  RankRow,
  SelectionState,
  SeriesState,
  TeamMode,
} from './types';

/** one driver, as every name surface prints one */
export interface CompPlayer {
  /** null once the account is deleted */
  userId: string | null;
  handle: string;
  username: string | null;
  role?: 'owner' | 'admin' | null;
  supporter?: boolean;
  badges?: EquippedBadge[] | null;
}

export interface CompEntryView {
  id: number;
  status: EntryStatus;
  /** team name, or the captain's handle */
  name: string;
  number: number | null;
  checkedIn: boolean;
  seed: number | null;
  placement: number | null;
  registeredAt: number;
  /** captain first, then the partner of a duo (absent until they accept) */
  players: CompPlayer[];
  /** a duo whose partner has not accepted: who was invited */
  invited?: CompPlayer | null;
  /** organizer's private note — only in a staff read */
  note?: string | null;
}

/** what a live room says about a called match (from the cross-region live list) */
export interface CompLive {
  phase: string;
  timeLeft: number;
  score: { red: number; blue: number };
  spectators: number;
  /** the room's region, for spectating */
  region?: string;
}

export interface CompMatchView extends CompMatchCore {
  /** "Q12", "SF1-2", "F-3" */
  label: string;
  attempt: number;
  /** the room of the current call; present while called, kept after for the record */
  roomCode: string | null;
  calledAt: number | null;
  /** when the call stops waiting for drivers who have not arrived */
  graceEndsAt: number | null;
  finishedAt: number | null;
  replayId: string | null;
  /** public note beside the result */
  note: string | null;
  /** why the last call did not become a match — staff reads only */
  callNote?: string | null;
  live: CompLive | null;
}

export interface CompStaffView extends CompPlayer {
  role2: 'organizer' | 'referee';
}

export interface CompLogView {
  id: number;
  at: number;
  /** the actor's name, resolved on read; 'DSIM' for the runner */
  actor: string;
  kind: string;
  data: Record<string, unknown>;
  public: boolean;
}

export interface CompetitionFull extends CompetitionSummary {
  description: string;
  rules: string;
  settings: CompSettings;
  region: string | null;
  createdBy: string;
  startedAt: number | null;
  cancelledAt: number | null;
  updatedAt: number;
}

/** what the viewer may do and what they are in */
export interface CompViewer {
  signedIn: boolean;
  role: CompRole | null;
  /** the viewer's own entry (as captain or partner) */
  entryId: number | null;
  /** an invitation to join a duo, waiting on the viewer's answer */
  inviteEntryId: number | null;
  /** registration is open to this viewer right now */
  canRegister: boolean;
  /** why not, in a sentence, when it is closed to them */
  registerBlock: string | null;
  canCheckIn: boolean;
  /** the viewer is the captain on turn in alliance selection */
  canPick: boolean;
}

export interface CompBracketView {
  series: SeriesState[];
  placements: Placement[];
  champion: number | null;
  complete: boolean;
}

export interface CompetitionDetail {
  competition: CompetitionFull;
  entries: CompEntryView[];
  matches: CompMatchView[];
  /** qualification rankings, once there are qualification matches */
  rankings: RankRow[] | null;
  /** live alliance selection while `status === 'selection'` in captains mode */
  selection: SelectionState | null;
  /** the playoff alliances: frozen once the bracket exists, else the preview */
  alliances: PlayoffAlliance[] | null;
  bracket: CompBracketView | null;
  staff: CompStaffView[];
  log: CompLogView[];
  viewer: CompViewer;
  /** server clock, so a countdown is not at the mercy of the viewer's */
  now: number;
}

export interface CompetitionList {
  competitions: CompetitionSummary[];
  more: boolean;
}

/** one competition the signed-in player is in, for the call bar and the profile */
export interface MyCompetition {
  slug: string;
  name: string;
  game: GameId;
  status: CompStatus;
  entryId: number;
  entryStatus: EntryStatus;
  checkedIn: boolean;
  checkIn: boolean;
  checkinOpensAt: number | null;
  /** the viewer's called match, if there is one */
  called: {
    matchId: number;
    label: string;
    roomCode: string;
    graceEndsAt: number;
    alliance: 'red' | 'blue';
  } | null;
  /** the viewer's next scheduled match, for "you are up in about N matches" */
  next: { matchId: number; label: string; ahead: number } | null;
}

export interface MyCompetitions {
  competitions: MyCompetition[];
  now: number;
}

/** the editable fields of a competition, as the editor posts them */
export interface CompEditInput {
  name?: string;
  game?: GameId;
  format?: CompFormat;
  teamMode?: TeamMode;
  visibility?: 'public' | 'unlisted';
  summary?: string;
  description?: string;
  rules?: string;
  capacity?: number;
  region?: string | null;
  regOpensAt?: number | null;
  regClosesAt?: number | null;
  checkinOpensAt?: number | null;
  startsAt?: number | null;
  settings?: Partial<CompSettings> | CompSettings;
}

/**
 * The label a match carries everywhere: `Q12` for a qualification match; for a playoff match the
 * series' short label, plus the game number inside the series when the series can run past one
 * game (`SF1-2`), or when a tie or a void forced a second game in a best-of-one.
 *
 * A playoff match's own `number` is its place in the playoff ORDER of play (unique across the
 * playoffs, P1, P2, …); `game` is its place inside its series.
 */
export function matchLabel(stage: 'qual' | 'playoff', number: number, seriesShort?: string | null, game = 1, bestOf = 1): string {
  if (stage === 'qual') return `Q${number}`;
  const base = seriesShort || `P${number}`;
  return bestOf > 1 || game > 1 ? `${base}-${game}` : base;
}
