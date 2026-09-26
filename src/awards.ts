import { podiumBadge, type BadgeId } from './badges';
import type { GameId } from './games/types';
import { seasonFor } from './seasons';
import { DRIVETRAIN_LABELS } from './ui/labelData';
import type { DrivetrainType } from './types';

/**
 * SEASON AWARDS, the client's half — the trophy case's SENTENCE and the badge each row shows.
 *
 * The server reads the rows (the retired `season_awards`, and the claimed competitive grants'
 * reasons) and dedupes them by `awardKey`; this file turns one into words. The split is
 * deliberate and it is the same one `labelData.ts` exists for: an id is a stable thing that
 * goes in a database and a URL, a sentence is a thing a designer rewrites. Storing the
 * sentence would have frozen every past award's wording at the moment it was minted.
 *
 * DOM-free and dependency-light so `scripts/smoke.ts` can drive it directly.
 */

/** the public shape of an award row — what the API sends, mirroring `SeasonAward`. */
export interface AwardRow {
  game: GameId;
  balanceVersion: number;
  act: number;
  /** the season's number within its act — "Act 2 Season 3" */
  seasonNo: number;
  /**
   * `ranked_act` is the CURRENT ranked award: a final placement on a ranked ladder when an ACT
   * ends (0048, owner 2026-09-22). `ranked` is the RETIRED per-season one 0045 minted; its
   * rows stay in the trophy case, so the kind stays readable, but nothing mints it any more.
   */
  kind: 'ranked' | 'ranked_act' | 'record_overall' | 'record_drivetrain';
  mode: '1v1' | '2v2' | 'solo' | 'duo';
  drivetrain: string | null;
  rank: number;
  score: number | null;
}

/**
 * RANK 1..3 AS A WORD (owner, 2026-09-21: "Finalist, Semifinalist sounds good").
 *
 * ⚠️ A PER-DRIVETRAIN AWARD IS ALWAYS `Champion`, whatever its rank says, because that
 * board's award depth is ONE (`AWARD_DEPTH`, repo.ts) and there is no 2nd or 3rd there for
 * the word to be relative to. "Finalist" on a field of one is a lie, and the rank column
 * being 1 on every such row is exactly what would make that lie easy to ship.
 */
export function awardRankWord(kind: AwardRow['kind'], rank: number): string {
  if (kind === 'record_drivetrain') return 'Champion';
  if (rank === 1) return 'Champion';
  if (rank === 2) return 'Finalist';
  if (rank === 3) return 'Semifinalist';
  return `#${rank}`;
}

/** what the award is OF — the board, in the fewest words that stay unambiguous. */
export function awardBoardWord(a: Pick<AwardRow, 'kind' | 'mode' | 'drivetrain'>): string {
  if (a.kind === 'ranked' || a.kind === 'ranked_act') return a.mode; // '1v1' | '2v2'
  const dt = a.drivetrain ? (DRIVETRAIN_LABELS[a.drivetrain as DrivetrainType] ?? a.drivetrain) : null;
  const solo = a.mode === 'duo' ? 'Duo ' : '';
  // "Record" is the board's own name on the site, so a record award says so rather than
  // inventing a synonym the player would have to map back to a page they know.
  return dt ? `${solo}${dt} Record` : `${solo}Record`;
}

/**
 * THE FULL SENTENCE — `DECODE · Act 2 Season 3 · 1v1 Champion`, one trophy-case row.
 *
 * The separator is ` · `, which is what `seasons.ts` already uses for a period label, so an
 * award reads like the rest of the site rather than like a new kind of string.
 */
export function awardSentence(a: AwardRow): string {
  const season = seasonFor(a.game).name;
  // an ACT award names the act alone: the ladder it is a placement on spans every season in it
  if (a.kind === 'ranked_act') return `${season} · Act ${a.act} · ${awardBoardWord(a)} ${awardRankWord(a.kind, a.rank)}`;
  return `${season} · Act ${a.act} Season ${a.seasonNo} · ${awardBoardWord(a)} ${awardRankWord(a.kind, a.rank)}`;
}

/**
 * THE BADGE A TROPHY-CASE ROW IS DRAWN WITH. A ranked placement is its podium crest; a record
 * placement is the Record Holder ribbon.
 *
 * ⚠️ ART, NOT A COUNT. A retired per-season `ranked` award (0045) is drawn with the crest of
 * its rank, but it never added to `ranked-gold`'s counter — that counts ACT podiums, and
 * `badgeCounts` (repo.ts) reads the grants, never this.
 */
export function awardBadge(a: Pick<AwardRow, 'kind' | 'rank'>): BadgeId {
  if (a.kind === 'ranked' || a.kind === 'ranked_act') return podiumBadge(a.rank) ?? 'ranked-bronze';
  return 'record-holder';
}

/**
 * ONE KEY PER AWARD SLOT — `award:<game>:<version>:<kind>:<mode>[:<dt>]:<rank>`, or
 * `award:<game>:act<N>:ranked_act:<mode>:<rank>` for an act podium, whose period is the act.
 *
 * It used to be the id of a wearable TITLE, and the leaderboard parsed it back; titles are gone
 * (0049), and what is left is the trophy case's dedupe (`trophyCase`, repo.ts): a placement the
 * retired `season_awards` table and the award job both paid is one row, because both rows
 * produce the same key. `act` and `seasonNo` are not in it for a season award — a season is
 * identified by its `balanceVersion`.
 */
export function awardKey(
  a: Pick<AwardRow, 'game' | 'balanceVersion' | 'kind' | 'mode' | 'drivetrain' | 'rank'> & { act?: number },
): string {
  if (a.kind === 'ranked_act') return `award:${a.game}:act${a.act ?? 0}:ranked_act:${a.mode}:${a.rank}`;
  const dt = a.drivetrain ? `:${a.drivetrain}` : '';
  return `award:${a.game}:${a.balanceVersion}:${a.kind}:${a.mode}${dt}:${a.rank}`;
}

/**
 * SORT for a profile's award list: newest season first, then the most impressive.
 *
 * Rank ascends before board, so a player's 1st places group ahead of their 3rds within a
 * season — which is the order somebody reads their own trophy case in.
 */
export function compareAwards(a: AwardRow, b: AwardRow): number {
  if (a.balanceVersion !== b.balanceVersion) return b.balanceVersion - a.balanceVersion;
  // an act podium outranks anything else from the same close — it is the prestigious one
  if ((a.kind === 'ranked_act') !== (b.kind === 'ranked_act')) return a.kind === 'ranked_act' ? -1 : 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.mode !== b.mode) return a.mode < b.mode ? -1 : 1;
  return (a.drivetrain ?? '') < (b.drivetrain ?? '') ? -1 : 1;
}
