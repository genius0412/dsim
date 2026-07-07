import type { Alliance, DrivetrainType } from '../src/types';
import type { MatchOutcome, MatchParticipant } from './room';
import { addMatchParticipant, getRating, saveMatch, upsertRating } from './db/repo';

/**
 * Ranked ELO. The rating math (`computeElo`) is PURE + unit-tested; `applyMatchElo`
 * wraps it with the DB reads/writes at match end.
 *
 * Boards (per the leaderboards spec): the OVERALL board always updates for every
 * player. The (mode × drivetrain) board updates ONLY when every participant shares
 * one drivetrain — a mixed-drivetrain game is cross-cutting, so it counts to
 * Overall alone. `mode` is inferred from the head count: 2 players ⇒ 1v1, 4 ⇒ 2v2.
 */

const K = 32;

export interface EloParticipant {
  userId: string;
  alliance: Alliance;
  drivetrain: DrivetrainType;
  ratingOverall: number;
  ratingDrivetrain: number;
}

export interface EloBoardUpdate {
  userId: string;
  board: 'overall' | DrivetrainType;
  before: number;
  after: number;
}

/** the OVERALL-board rating change for one player, returned to the room so it can
 * show each driver their ELO delta on the results screen */
export interface EloOutcome {
  userId: string;
  before: number;
  after: number;
}

/** standard team-Elo: team rating = mean of members; each member moves toward the
 * team's actual result by K·(actual − expected). Winner = higher alliance score
 * (equal ⇒ draw, 0.5 each). Returns the per-board rating changes. */
export function computeElo(
  participants: EloParticipant[],
  scores: Record<Alliance, number>,
): EloBoardUpdate[] {
  const sRed = scores.red > scores.blue ? 1 : scores.red < scores.blue ? 0 : 0.5;
  const actual = (a: Alliance): number => (a === 'red' ? sRed : 1 - sRed);
  const updates: EloBoardUpdate[] = [];

  const applyBoard = (
    board: 'overall' | DrivetrainType,
    rating: (p: EloParticipant) => number,
  ): void => {
    const red = participants.filter((p) => p.alliance === 'red');
    const blue = participants.filter((p) => p.alliance === 'blue');
    if (!red.length || !blue.length) return;
    const avg = (ps: EloParticipant[]): number =>
      ps.reduce((s, p) => s + rating(p), 0) / ps.length;
    const rAvg = avg(red);
    const bAvg = avg(blue);
    const eRed = 1 / (1 + Math.pow(10, (bAvg - rAvg) / 400));
    for (const p of participants) {
      const expected = p.alliance === 'red' ? eRed : 1 - eRed;
      const before = rating(p);
      const after = Math.round(before + K * (actual(p.alliance) - expected));
      updates.push({ userId: p.userId, board, before, after });
    }
  };

  applyBoard('overall', (p) => p.ratingOverall);
  const drivetrains = new Set(participants.map((p) => p.drivetrain));
  if (drivetrains.size === 1) applyBoard([...drivetrains][0], (p) => p.ratingDrivetrain);
  return updates;
}

/** infer the ranked mode from the roster size */
export function eloMode(count: number): '1v1' | '2v2' {
  return count >= 4 ? '2v2' : '1v1';
}

/** read current ratings, apply Elo, persist ratings + match history. Requires
 * both alliances present (≥2 authed players). Called from persistMatch. */
export async function applyMatchElo(
  authed: MatchParticipant[],
  outcome: MatchOutcome,
  balanceVersion: number,
  replayId: string,
): Promise<EloOutcome[]> {
  const reds = authed.filter((p) => p.alliance === 'red');
  const blues = authed.filter((p) => p.alliance === 'blue');
  if (!reds.length || !blues.length) return []; // not a rankable head-to-head
  const mode = eloMode(authed.length);

  const parts: EloParticipant[] = [];
  for (const p of authed) {
    parts.push({
      userId: p.userId!,
      alliance: p.alliance,
      drivetrain: p.drivetrain,
      ratingOverall: await getRating(p.userId!, mode, 'overall', balanceVersion),
      ratingDrivetrain: await getRating(p.userId!, mode, p.drivetrain, balanceVersion),
    });
  }
  const updates = computeElo(parts, outcome.result.score);
  for (const u of updates) await upsertRating(u.userId, mode, u.board, balanceVersion, u.after);

  const matchId = await saveMatch(mode, balanceVersion, replayId);
  const { red, blue } = outcome.result.score;
  for (const p of authed) {
    const overall = updates.find((u) => u.userId === p.userId && u.board === 'overall');
    if (!overall) continue;
    await addMatchParticipant({
      matchId,
      userId: p.userId!,
      alliance: p.alliance,
      drivetrain: p.drivetrain,
      score: p.score,
      won: p.alliance === 'red' ? red > blue : blue > red,
      ratingBefore: overall.before,
      ratingAfter: overall.after,
    });
  }

  // the overall-board delta per player, for the results-screen ELO reveal
  return updates
    .filter((u) => u.board === 'overall')
    .map((u) => ({ userId: u.userId, before: u.before, after: u.after }));
}
