/**
 * COMPETITIONS — the shapes every half agrees on (migration 0059, `docs/area/competitions.md`).
 *
 * DOM-free and dependency-free apart from the two id types, so the server, the client and
 * `npm test` all read one definition. The database stores what is decided (entries, matches,
 * results, the selection actions); everything DERIVED from them — rankings, the alliance
 * selection, the bracket's progress, placements — is recomputed by the pure modules beside this
 * one (`rankings.ts`, `selection.ts`, `bracket.ts`) on every read, so a corrected result moves the
 * rankings and the bracket with it and there is no second copy to drift.
 */
import type { GameId } from '../games/types';

export type Alliance = 'red' | 'blue';

/** robots per alliance */
export type CompFormat = '1v1' | '2v2';

/**
 * WHO AN ENTRY IS.
 *
 * `solo`: one player. In a 2v2 competition each qualification match draws two solo entries per
 * alliance, with partners shuffled from match to match (FTC's qualification model), and playoff
 * alliances are formed by alliance selection or serpentine seeding.
 *
 * `duo`: two players registered together, captain and partner, who always play on the same
 * alliance. Only meaningful in a 2v2 competition; a duo fills a whole alliance on its own.
 */
export type TeamMode = 'solo' | 'duo';

/**
 * THE LIFECYCLE. Every move between these is an organizer's deliberate action, never a timer:
 * a competition is run by people, and a clock that started qualifications while the organizer was
 * still fixing the entrant list would be a bug with no undo.
 *
 *   draft → published → qualification → selection → playoffs → completed
 *                                  ╰──────────────→ completed   (no playoffs)
 *   any state but completed → cancelled
 *
 * `published` is the registration phase: the page is public, and signing up is open inside the
 * registration window (or always, when no window is set). Check-in, when required, is open from
 * `checkinOpensAt` until qualifications start.
 */
export type CompStatus =
  | 'draft'
  | 'published'
  | 'qualification'
  | 'selection'
  | 'playoffs'
  | 'completed'
  | 'cancelled';

export const COMP_STATUSES: readonly CompStatus[] = [
  'draft',
  'published',
  'qualification',
  'selection',
  'playoffs',
  'completed',
  'cancelled',
];

/**
 * An entry's standing in the competition.
 *
 * `pending` is a duo whose partner has not accepted yet: it holds no place and does not count
 * against capacity. `waitlist` is a full competition's queue, promoted in registration order when
 * a place frees up. `withdrawn` and `disqualified` keep their row (and their played matches) so
 * the schedule and the results stay whole.
 */
export type EntryStatus = 'registered' | 'waitlist' | 'pending' | 'withdrawn' | 'disqualified';

/**
 * HOW QUALIFICATIONS ARE DRAWN.
 *
 * `balanced`: FTC's model. Every entry plays `matchesPerEntry` matches; partners and opponents are
 * spread as evenly as the numbers allow, red and blue are balanced, and an entry is kept out of
 * back-to-back matches where it can be. When the slots do not divide evenly, the spare places are
 * filled by SURROGATE appearances that do not count for the entry that plays them.
 *
 * `roundRobin`: every entry meets every other (one robot per alliance only: 1v1, or 2v2 duos).
 * `matchesPerEntry` is the number of full cycles, and the second cycle swaps colours.
 *
 * `swiss`: rounds generated one at a time from the current rankings, with no rematches (one robot
 * per alliance only). `matchesPerEntry` is the number of rounds.
 *
 * `none`: straight to playoffs, seeded by `seed` overrides and then registration order.
 */
export type QualKind = 'balanced' | 'roundRobin' | 'swiss' | 'none';

export type BracketFormat = 'single' | 'double';

/**
 * HOW PLAYOFF ALLIANCES FORM in a 2v2 competition of solo entries.
 *
 * `captains`: FTC alliance selection. The top N ranked entries are captains; in seed order each
 * captain invites one partner. A pick may be a lower captain (the alliances below move up and the
 * next ranked entry becomes the new last captain); an entry that declines can no longer be picked
 * but can still become a captain.
 *
 * `serpentine`: no selection; alliance i is rank i with rank 2N + 1 − i.
 *
 * Ignored where an entry already fills an alliance (1v1, duo): alliance i is rank i.
 */
export type SelectionMode = 'captains' | 'serpentine';

/**
 * RANKING TIEBREAKERS, after the ranking score (ranking points per match played).
 *
 *   avgNoFoul   — average alliance score minus the foul points the alliance was GIVEN
 *   avgScore    — average alliance score
 *   highScore   — best alliance score
 *   avgMargin   — average (own score − opponent score)
 *   wins        — total wins
 *   fewestFouls — average foul points GIVEN AWAY to the opponent, lower is better
 *
 * A final deterministic coin (a hash of the competition seed and the entry id) settles anything
 * left, so two reads of the same results always give the same order.
 */
export type Tiebreaker = 'avgNoFoul' | 'avgScore' | 'highScore' | 'avgMargin' | 'wins' | 'fewestFouls';

export const TIEBREAKERS: readonly Tiebreaker[] = [
  'avgNoFoul',
  'avgScore',
  'highScore',
  'avgMargin',
  'wins',
  'fewestFouls',
];

export interface CompSettings {
  quals: {
    kind: QualKind;
    /** balanced: matches per entry; roundRobin: cycles; swiss: rounds */
    matchesPerEntry: number;
    /** balanced only: the fewest matches between two appearances of one entry it tries to keep */
    minGap: number;
  };
  /** ranking points for a qualification win, tie and loss */
  points: { win: number; tie: number; loss: number };
  tiebreakers: Tiebreaker[];
  playoffs: {
    enabled: boolean;
    /** how many alliances (or entries, where an entry fills an alliance) advance */
    alliances: 2 | 4 | 8 | 16;
    format: BracketFormat;
    /** every series but the final */
    bestOf: 1 | 3 | 5;
    finalsBestOf: 1 | 3 | 5;
    selection: SelectionMode;
  };
  run: {
    /** how long a called match waits for its drivers, seconds */
    joinGraceSec: number;
    /** what a driver who never arrives costs: the match (forfeit) or nothing (the referee decides) */
    noShow: 'forfeit' | 'hold';
    /** the server calls the next match whose drivers are free, up to `maxConcurrent` at once */
    autoCall: boolean;
    maxConcurrent: number;
    /** the least time between one driver's matches, seconds */
    restSec: number;
  };
  /** entrants must check in before qualifications start; those who did not are left out */
  checkIn: boolean;
}

/** an entry's place in one alliance of one match */
export interface CompSlot {
  entry: number;
  /** a surrogate appearance: the entry plays, but the result does not count for it */
  surrogate?: boolean;
}

export type MatchStage = 'qual' | 'playoff';

/**
 * A match's own state. `live` is not one of them: it is derived on read from the live-room list
 * (the room is on a game server, which may not be the machine answering), so it can never go stale
 * in the database.
 */
export type CompMatchStatus = 'scheduled' | 'called' | 'done' | 'void';

export type Winner = Alliance | 'tie';

/** how a result came to be: the sim decided it, a no-show or a ruling forfeited it, or a referee
 *  entered or corrected it by hand */
export type ResultSource = 'played' | 'forfeit' | 'manual';

export interface CompResult {
  /** alliance totals, null for a forfeit (a forfeit has a winner and no score) */
  red: number | null;
  blue: number | null;
  /** foul points each alliance was GIVEN by the other's fouls (`ReplayResult.foulPoints`) */
  redFoul: number;
  blueFoul: number;
  winner: Winner;
  source: ResultSource;
}

/** the parts of a match the pure modules read */
export interface CompMatchCore {
  id: number;
  stage: MatchStage;
  /** qualification: the round it was drawn in (1-based); playoff: 0 */
  round: number;
  /** order of play within the stage (Q1, Q2, …), 1-based */
  number: number;
  /** playoff matches only: the series key they belong to */
  series: string | null;
  red: CompSlot[];
  blue: CompSlot[];
  status: CompMatchStatus;
  result: CompResult | null;
  /** entries disqualified IN THIS MATCH: they take no ranking points from it */
  dq: number[];
}

/** what the pure modules need to know about an entry */
export interface CompEntryCore {
  id: number;
  status: EntryStatus;
  /** organizer's manual seed, used where there are no qualifications (lower is better) */
  seed: number | null;
  /** registration order, the last resort for seeding */
  registeredAt: number;
}

/** one row of the qualification rankings */
export interface RankRow {
  rank: number;
  entry: number;
  played: number;
  wins: number;
  losses: number;
  ties: number;
  rp: number;
  /** ranking score: rp / played (0 when nothing has been played) */
  rs: number;
  /** matches with a score (forfeits and DQs have none) */
  scored: number;
  avgScore: number;
  avgNoFoul: number;
  highScore: number;
  avgMargin: number;
  /** average foul points given away to the opponent */
  avgFouls: number;
  /** a disqualified entry is ranked last, whatever it scored */
  disqualified: boolean;
}

/** one alliance in the playoffs. `entries[0]` is the captain. */
export interface PlayoffAlliance {
  seed: number;
  entries: number[];
}

/** where a series takes one of its alliances from */
export interface SeriesFeed {
  series: string;
  take: 'winner' | 'loser';
}

export type BracketSide = 'upper' | 'lower' | 'final';

/**
 * ONE SERIES OF THE BRACKET, AS GENERATED. Static once the playoffs start: what changes is which
 * matches have been played, and the state below is derived from those.
 */
export interface SeriesSpec {
  /** stable key, unique within the competition: `U1-1`, `L2-1`, `F` … */
  key: string;
  side: BracketSide;
  /** 1-based round within its side */
  round: number;
  /** 1-based position within the round, top to bottom */
  position: number;
  /** "Upper round 1, series 1", "Semifinal 2", "Final" */
  label: string;
  /** short label for a match card: "U1-1", "SF2", "F" */
  short: string;
  bestOf: number;
  /** first-round series name their alliances by seed; later ones by feed */
  redSeed: number | null;
  blueSeed: number | null;
  redFrom: SeriesFeed | null;
  blueFrom: SeriesFeed | null;
}

export interface SeriesState extends SeriesSpec {
  /** the alliance seeds in this series once known (red is the better seed) */
  red: number | null;
  blue: number | null;
  redWins: number;
  blueWins: number;
  /** the winning ALLIANCE SEED, once decided */
  winner: number | null;
  loser: number | null;
  /** matches of this series that have been played or are scheduled, in order */
  matches: number[];
}

/** a final placement: 1 is the champion. Equal placements share a number (two semifinal losers). */
export interface Placement {
  place: number;
  alliance: number;
  entries: number[];
}

/** one recorded alliance-selection action, replayed in order to derive the alliances */
export type SelectionAction =
  | { kind: 'pick'; entry: number }
  | { kind: 'decline'; entry: number };

export interface SelectionState {
  alliances: PlayoffAlliance[];
  /** index into `alliances` of the captain whose turn it is, null when complete */
  turn: number | null;
  /** entries that may be picked now, best ranked first */
  available: number[];
  declined: number[];
  complete: boolean;
}

/** who may do what on a competition. `admin` is the site staff, always. */
export type CompRole = 'admin' | 'organizer' | 'referee';

/** the parts of the competition row every reader needs */
export interface CompetitionSummary {
  id: string;
  slug: string;
  name: string;
  game: GameId;
  format: CompFormat;
  teamMode: TeamMode;
  status: CompStatus;
  visibility: 'public' | 'unlisted';
  official: boolean;
  summary: string;
  capacity: number;
  /** entries holding a place (registered) */
  entrants: number;
  waitlist: number;
  regOpensAt: number | null;
  regClosesAt: number | null;
  checkinOpensAt: number | null;
  startsAt: number | null;
  createdAt: number;
  completedAt: number | null;
  /** the champions' names, once there are some */
  champions: string[];
}
