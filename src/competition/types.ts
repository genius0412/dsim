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
 *   avgNoFoul   — average alliance score minus the foul points the alliance was GIVEN (never below 0)
 *   avgScore    — average alliance score
 *   highScore   — best alliance score (fouls included)
 *   avgMargin   — average (own score − opponent score)
 *   wins        — total wins
 *   fewestFouls — average foul points GIVEN AWAY to the opponent, lower is better
 *
 * and the four that read a MEASURE the game reports at the end of a match (`AllianceFacts`), each
 * an average of it over the matches that have it (`MEASURE_TIEBREAKERS`):
 *
 *   avgAuto     — AUTO points
 *   avgBase     — DECODE BASE points
 *   avgTips     — BIOBUZZ HIVE TIPS
 *   avgAscent   — Chain Reaction ring-stand ascent points
 *
 * Under the Competition Manual scheme the order is the manual's Table 13-1, not the organizer's
 * (`manual.ts`). A final deterministic coin (a hash of the competition seed and the entry id)
 * settles anything left — the manual's "random sort" — so two reads of the same results always give
 * the same order.
 */
export type Tiebreaker =
  | 'avgNoFoul'
  | 'avgScore'
  | 'highScore'
  | 'avgMargin'
  | 'wins'
  | 'fewestFouls'
  | 'avgAuto'
  | 'avgBase'
  | 'avgTips'
  | 'avgAscent';

export const TIEBREAKERS: readonly Tiebreaker[] = [
  'avgNoFoul',
  'avgScore',
  'highScore',
  'avgMargin',
  'wins',
  'fewestFouls',
  'avgAuto',
  'avgBase',
  'avgTips',
  'avgAscent',
];

/** the tiebreakers that average a reported measure, and the measure (fact key) each reads */
export const MEASURE_TIEBREAKERS: Readonly<Partial<Record<Tiebreaker, string>>> = {
  avgAuto: 'auto',
  avgBase: 'base',
  avgTips: 'tips',
  avgAscent: 'ascent',
};

/**
 * HOW RANKING POINTS ARE AWARDED.
 *
 * `cm`: the game's Competition Manual (`manual.ts`): its win/tie values, its bonus RPs at the
 * thresholds of `level`, its Table 13-1 tiebreakers, and its rule that a DISQUALIFIED match
 * "contributes 0 to all sort criteria" (counted in every average, as a 0).
 * `custom`: the organizer's `points` and `tiebreakers`, no bonus RPs, and a DQ match left out of
 * the averages (the rule every competition ranked by before the manual scheme existed).
 */
export type RpScheme = 'cm' | 'custom';

/**
 * WHICH COLUMN OF THE MANUAL'S RP-THRESHOLD TABLE (Table 10-3): `event` is "All Other Events",
 * `regional` "Regional Championships", `championship` "FIRST Championship". A column the manual
 * has not published yet (TBA) is not offered. `custom` reads `RpSettings.thresholds` — the
 * manual's footnote lets Premier Events set their own.
 */
export type RpLevel = 'event' | 'regional' | 'championship' | 'custom';

export interface RpSettings {
  scheme: RpScheme;
  level: RpLevel;
  /** organizer thresholds keyed by bonus id, read when `level` is `custom` */
  thresholds: Record<string, number>;
}

/** one bonus RP as a competition applies it: the manual's row with the threshold chosen */
export interface ResolvedBonus {
  /** 'movement' | 'goal' | 'pattern' (DECODE), 'swarm' | 'pollinator1' | 'pollinator2' (BIOBUZZ) */
  id: string;
  /** the fact it reads (`AllianceFacts` key) */
  measure: string;
  threshold: number;
  /** a fact that AWARDS this RP whatever was scored, when > 0 (DECODE: the opponent's G417) */
  awardFact?: string;
  /** a rule in the manual can award it to an alliance (a referee may rule 'award') */
  award: boolean;
  /** a rule in the manual can make an alliance ineligible for it (a referee may rule 'deny') */
  deny: boolean;
}

/**
 * A COMPETITION'S RANKING RULES, RESOLVED: what `rankings.ts` actually applies. Built by
 * `effectiveRanking` from the settings and the game's manual table, and FROZEN into
 * `competitions.rp_table` when qualifications start under `cm`, so a later edit of a manual table
 * (a Team Update) cannot re-rank an event that already began.
 */
export interface ResolvedRanking {
  scheme: RpScheme;
  level: RpLevel;
  /** the manual and edition the table is from ('cm' only), e.g. "DECODE Competition Manual, Team Update 32" */
  source: string | null;
  win: number;
  tie: number;
  loss: number;
  bonus: ResolvedBonus[];
  tiebreakers: Tiebreaker[];
  /** the measures the game reports (fact keys), for validation and the referee's inputs */
  measures: string[];
}

/**
 * WHAT THE GAME MEASURED for one alliance in one match: plain numbers keyed by measure id
 * (`manual.ts` lists each game's). Reported by the room from the authoritative world
 * (`GameSimModule.rankFacts`), or typed by a referee. A missing key is UNKNOWN, never 0.
 */
export type AllianceFacts = Record<string, number>;

/** a referee's ruling on one bonus RP for one alliance (Table 10-4 / 10-6 of the DECODE manual) */
export type RpRuling = 'award' | 'deny';

export type CardColour = 'yellow' | 'red';

/**
 * WHY AN ENTRY TAKES NOTHING FROM A MATCH (`effectiveDq` in `rankings.ts`, derived on read):
 *   dq       — `match.dq`: a referee's DQ, a no-show (G208/G203), or an entry not in the
 *              competition any more when the match was played
 *   red      — a red card in this match (the sim's or a referee's), or two yellows in it
 *   yellow2  — a yellow card while carrying one from an earlier qualification match (§10.6.1)
 *   surrogate — a card from the entry's surrogate appearance, applied here (Table 10-5)
 */
export type DqReason = 'dq' | 'red' | 'yellow2' | 'surrogate';

export interface EffectiveDq {
  entry: number;
  why: DqReason;
}

export interface CompSettings {
  quals: {
    kind: QualKind;
    /** balanced: matches per entry; roundRobin: cycles; swiss: rounds */
    matchesPerEntry: number;
    /** balanced only: the fewest matches between two appearances of one entry it tries to keep */
    minGap: number;
  };
  /** ranking points for a qualification win, tie and loss — read under the `custom` scheme only */
  points: { win: number; tie: number; loss: number };
  /** read under the `custom` scheme only; `cm` uses the manual's Table 13-1 */
  tiebreakers: Tiebreaker[];
  /**
   * The ranking-point scheme. A stored row WITHOUT this key coerces to `custom` (it was ranked by
   * `points` before the manual scheme existed); a new competition starts at `cm`.
   */
  rp: RpSettings;
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
  /**
   * What the game measured per alliance (0060). Absent or null = unknown: a forfeit, a result typed
   * without them, or a row from before 0060. Optional on the wire — an older server sends none.
   */
  facts?: Record<Alliance, AllianceFacts> | null;
  /** a referee's bonus-RP rulings per alliance, keyed by bonus id */
  rulings?: Record<Alliance, Record<string, RpRuling>> | null;
  /** cards the SIM showed, per entry id (as a string — jsonb keys), from the played match */
  cards?: Record<string, CardColour> | null;
  /** cards a REFEREE showed in this match, per entry id */
  refCards?: Record<string, CardColour> | null;
  /** when the result was FIRST decided (a correction keeps it), epoch ms: the order cards escalate in */
  finishedAt?: number | null;
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
  /** bonus RP earned, per bonus id: in how many matches. Optional on the wire (older server). */
  bonus?: Record<string, number>;
  /** the average of each measure the game reports; null until a counted match the entry was not
   *  disqualified in reports it */
  avg?: Record<string, number | null>;
  /** counted matches this entry was disqualified in (`effectiveDq`) */
  dqs?: number;
  /** holds a yellow card into its next qualification match (meaningless once qualifications end) */
  yellow?: boolean;
}

/** the ranking points one match gave, per alliance and per entry (qualification matches only) */
export interface MatchRp {
  /** the alliance's own: win/tie/loss points, the bonus RPs it earned, and their sum */
  alliance: Record<Alliance, { result: number; bonus: string[]; total: number }>;
  /** per entry id (string key): what that entry took — 0 when it was disqualified */
  entries: Record<string, number>;
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
