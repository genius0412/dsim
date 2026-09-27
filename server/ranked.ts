import type { Alliance, GameId } from '../src/types';
import { eloMode } from './eloMode';
import type { MatchOutcome, MatchParticipant } from './room';
import {
  actForSeason,
  addMatchParticipants,
  dropUntouchedRatings,
  getRatingsFull,
  saveMatch,
  upsertEloHistory,
  upsertRating,
} from './db/repo';
import { tx } from './db/pool';

/**
 * Ranked ratings — Glicko-2 (the chess.com model). Beyond a single Elo number,
 * each rating carries a rating DEVIATION (RD, the confidence interval) and a
 * VOLATILITY. A fresh/idle player has a high RD, so early games swing the rating
 * hard; as RD shrinks with games the rating settles. `computeGlicko` is PURE +
 * unit-tested; `persistVersusMatch` wraps it with the DB reads/writes at match end
 * (ranked matches only — custom rooms persist the match but move no rating).
 *
 * Boards: one rating per (mode × season) — ranked is NOT divided by drivetrain.
 * `mode` is inferred from the head count: 2 players ⇒ 1v1, 4 ⇒ 2v2.
 */

// Glicko-2 constants. SCALE/CENTER map the public rating onto the internal (μ, φ)
// scale; TAU constrains volatility change; below RD_PROVISIONAL a rating is
// "established" (shown without the provisional "?").
const SCALE = 173.7178;
const CENTER = 1500;
const TAU = 0.5;
export const RD_PROVISIONAL = 110;

export interface Glicko {
  rating: number;
  rd: number;
  vol: number;
}

const gphi = (phi: number): number => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expect = (mu: number, muj: number, phij: number): number =>
  1 / (1 + Math.exp(-gphi(phij) * (mu - muj)));

/** one Glicko-2 update for a player against a single (possibly team-aggregate)
 * opponent, given the game score s (1 win / 0.5 draw / 0 loss). Pure.
 *
 * `expRating` is the rating the EXPECTED score is computed from. It defaults to the
 * player's own, which is plain Glicko-2; in a 2v2 it is the player's ALLIANCE mean (see
 * `computeGlicko`), so the question asked is "how surprising was this result for your
 * team", while the answer still moves the player's own rating by their own RD. */
export function glicko2Update(
  player: Glicko,
  oppRating: number,
  oppRd: number,
  s: number,
  expRating = player.rating,
): Glicko {
  const mu = (player.rating - CENTER) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.vol;
  const muj = (oppRating - CENTER) / SCALE;
  const phij = oppRd / SCALE;

  const gj = gphi(phij);
  const e = expect((expRating - CENTER) / SCALE, muj, phij);
  const v = 1 / (gj * gj * e * (1 - e));
  const delta = v * gj * (s - e);

  // new volatility via the Illinois (regula-falsi) root find on Glicko-2's f(x)
  const d2 = delta * delta;
  const phi2 = phi * phi;
  const a = Math.log(sigma * sigma);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    return (
      (ex * (d2 - phi2 - v - ex)) / (2 * Math.pow(phi2 + v + ex, 2)) - (x - a) / (TAU * TAU)
    );
  };
  let A = a;
  let B: number;
  if (d2 > phi2 + v) {
    B = Math.log(d2 - phi2 - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  let iter = 0;
  while (Math.abs(B - A) > 1e-6 && iter++ < 100) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  const newVol = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi2 + newVol * newVol);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * gj * (s - e);

  return { rating: SCALE * newMu + CENTER, rd: SCALE * newPhi, vol: newVol };
}

export interface EloParticipant {
  userId: string;
  alliance: Alliance;
  rating: Glicko;
  /** games on this board BEFORE this match. Drives the calibration RD floor; absent ⇒ no
   *  floor (treated as established), which is what every pre-existing caller gets. */
  games?: number;
  /** whole days since this board's rating last changed. Drives the idle RD growth. */
  idleDays?: number;
  /** the verified challenge token this player queued under (a premade, or a rated 1v1) */
  party?: string;
  /** share of the live match this driver was away for, 0..1 (1 = AFK). See `room.ts`. */
  away?: number;
  /** absent for the whole opening window (`EARLY_ABSENT_TICKS`) or never connected */
  early?: boolean;
}

export interface EloBoardUpdate {
  userId: string;
  before: number; // rating before, rounded
  after: number; // rating after, rounded
  rd: number; // new RD, rounded (drives the provisional "?" indicator)
  state: Glicko; // full new state to persist
  /** the match did not count for this player (a partner absent from the start): nothing is
   *  written — no rating, no RD, no game on the board */
  voided?: boolean;
}

/*
 * ── RATING ADJUSTMENTS (2026-09-27 ranked review) ────────────────────────────────────
 *
 * Plain Glicko-2 with one game per rating period had three measured failures:
 *
 *  - A strong player who lost early took ~40–60 straight wins to reach their level. RD had
 *    collapsed below 180 by the end of placement, and VOLATILITY NEVER MOVES with one-game
 *    periods (it sat at exactly 0.060 through 39 straight wins) — Glickman designed the
 *    update for 10–15 games a period. Lichess, which also rates per game, keeps RD in a band
 *    instead; so do we: a CALIBRATION FLOOR that decays with games, and idle growth.
 *  - A win was a win: 550–300 moved the rating exactly as much as 301–300. A MARGIN
 *    multiplier, ×0.8 for a close result up to ×1.5 at the DECISIVE_MARGIN, with 538's
 *    damping so a favourite's blowout adds little and ratings don't inflate.
 *  - In 2v2 each player was scored on THEIR OWN rating against the opposing mean, so a 1500
 *    carrying a 900 lost −23 while the 900 lost −4 (and a win paid +4 / +23). The expected
 *    score is now the ALLIANCE's (TrueSkill/OpenSkill's team model), and a partner who
 *    walked out reduces or voids the loss (LoL / Overwatch 2 / Rocket League), never when that
 *    partner is your own premade.
 *
 * None of it rewrites a stored row: the floor and the idle growth are applied when the
 * rating is READ, so an existing account is affected from its next game and no standing
 * resets.
 */

/** the margin (|R−B| / (R+B)) at which a win or loss counts in full. One number for every
 *  game (owner, 2026-09-27): 550–300 in BIOBUZZ, 0.29, is "a massive margin". */
export const DECISIVE_MARGIN = 0.3;
/** the multiplier on a result at a zero margin, and at DECISIVE_MARGIN or wider */
export const MOV_MIN = 0.8;
export const MOV_MAX = 1.5;
/** calibration RD floor: `max(RD_FLOOR_MIN, RD_FLOOR_START − RD_FLOOR_PER_GAME · games)`,
 *  which reaches the minimum at game 20. The minimum is Lichess's per-game floor. */
export const RD_FLOOR_START = 250;
export const RD_FLOOR_PER_GAME = 9.5;
export const RD_FLOOR_MIN = 60;
/** idle RD growth: after IDLE_GRACE_DAYS, `√(RD² + IDLE_RD_PER_DAY² · days)`, capped at
 *  IDLE_RD_CAP so a returning player is loosened without swinging like a new account */
export const IDLE_GRACE_DAYS = 14;
export const IDLE_RD_PER_DAY = 15;
export const IDLE_RD_CAP = 150;
export const RD_MAX = 350;
/** a premade whose two ratings are further apart than this moves at WIDE_PREMADE_MULT —
 *  team expectation otherwise makes carrying a friend up the ladder cheap (Valorant's party
 *  rank-disparity rule, Overwatch 2's wide groups) */
export const WIDE_PREMADE_GAP = 400;
export const WIDE_PREMADE_MULT = 0.5;
/** below this share of the match, an absence is a connection blip, not a partner leaving */
export const ABSENT_MIN = 0.05;

/** the RD a board's rating is rated at: the stored RD, grown by idleness and held up by
 *  the calibration floor. Pure. */
export function effectiveRd(rd: number, games = Infinity, idleDays = 0): number {
  let r = rd;
  if (idleDays > IDLE_GRACE_DAYS) {
    const grown = Math.sqrt(r * r + IDLE_RD_PER_DAY * IDLE_RD_PER_DAY * (idleDays - IDLE_GRACE_DAYS));
    // never LOWER an RD that is already above the cap (a new account's 350)
    r = Math.max(r, Math.min(IDLE_RD_CAP, grown));
  }
  const floor = Math.max(RD_FLOOR_MIN, RD_FLOOR_START - RD_FLOOR_PER_GAME * games);
  return Math.min(RD_MAX, Math.max(r, floor));
}

/** the margin-of-victory multiplier for one match. `eWinner` is the winning alliance's
 *  expected score going in; the part above ×1 is scaled by `2·(1 − eWinner)`, so an even
 *  match pays the full bonus and a 90% favourite a fifth of it. A draw is ×1. Pure. */
export function marginMultiplier(red: number, blue: number, eWinner: number): number {
  if (red === blue) return 1;
  const total = red + blue;
  const m = total > 0 ? Math.abs(red - blue) / total : 1;
  let k = MOV_MIN + (MOV_MAX - MOV_MIN) * Math.min(1, m / DECISIVE_MARGIN);
  if (k > 1) k = 1 + (k - 1) * Math.min(1, 2 * (1 - eWinner));
  return k;
}

/** the OVERALL-board rating change for one player, returned to the room so it can
 * show each driver their rating delta (+ provisional flag) on the results screen.
 * `games` is the player's OVERALL-board game count AFTER this match — it drives
 * the games-based placement / provisional "?" (see PLACEMENT_GAMES). */
export interface EloOutcome {
  userId: string;
  before: number;
  after: number;
  rd: number;
  games: number;
}

/** a participant's absence share, with a connection blip read as none */
const awayOf = (p: EloParticipant): number => {
  const a = Math.min(1, Math.max(0, p.away ?? 0));
  return a < ABSENT_MIN ? 0 : a;
};

/**
 * Glicko-2 team update. Winner = higher alliance score (equal ⇒ draw). Returns one update
 * per participant.
 *
 * Each player is rated against the OPPOSING alliance as one aggregate opponent (mean
 * rating, RMS RD), with the EXPECTED score taken from their own alliance's mean — in 1v1
 * that is their own rating, so 1v1 is plain Glicko-2. Then, in order:
 *
 *  1. RD is raised to `effectiveRd` (calibration floor, idle growth) before the update.
 *  2. The change is scaled by `marginMultiplier` — except a rated 1v1 challenge (a closed
 *     party: the same token on both alliances), which could otherwise farm blowouts.
 *  3. A WIDE premade (partners more than WIDE_PREMADE_GAP apart) moves at half.
 *  4. PARTNER ABSENCE, 2v2 only:
 *     - somebody absent from the start (`early`, or a seat with nobody in it at all) VOIDS
 *       the match for everyone else, and the absentee takes a loss;
 *     - otherwise a LOSS is scaled by `clamp(1 − 2a, 0, 1)` for the teammate of a partner
 *       away for share `a` — never when that partner is their own premade, and never for
 *       somebody who was away at least as long themselves — and the OPPONENTS' win over a
 *       short-handed alliance by `1 − a`. A win is never reduced for the one who stayed.
 */
export function computeGlicko(
  participants: EloParticipant[],
  scores: Record<Alliance, number>,
  opts: { mode?: '1v1' | '2v2' } = {},
): EloBoardUpdate[] {
  const sRed = scores.red > scores.blue ? 1 : scores.red < scores.blue ? 0 : 0.5;
  const updates: EloBoardUpdate[] = [];

  const red = participants.filter((p) => p.alliance === 'red');
  const blue = participants.filter((p) => p.alliance === 'blue');
  if (!red.length || !blue.length) return updates;
  const mode = opts.mode ?? eloMode(participants.length);
  const rdOf = (p: EloParticipant): number => effectiveRd(p.rating.rd, p.games, p.idleDays);
  const agg = (ps: EloParticipant[]): { rating: number; rd: number } => ({
    rating: ps.reduce((s, p) => s + p.rating.rating, 0) / ps.length,
    rd: Math.sqrt(ps.reduce((s, p) => s + rdOf(p) * rdOf(p), 0) / ps.length),
  });
  const team = { red: agg(red), blue: agg(blue) };
  const other = (a: Alliance): Alliance => (a === 'red' ? 'blue' : 'red');
  const members = { red, blue };

  // a CLOSED party (a rated 1v1 challenge) is one token on both alliances
  const closed = participants.some(
    (a) => a.party && participants.some((b) => b.alliance !== a.alliance && b.party === a.party),
  );
  let k = 1;
  if (!closed && sRed !== 0.5) {
    const w: Alliance = sRed === 1 ? 'red' : 'blue';
    const eWinner = expect(
      (team[w].rating - CENTER) / SCALE,
      (team[other(w)].rating - CENTER) / SCALE,
      team[other(w)].rd / SCALE,
    );
    k = marginMultiplier(scores.red, scores.blue, eWinner);
  }

  // a 2v2 with somebody missing from the start is voided for everybody who was there
  const voided =
    mode === '2v2' && (red.length < 2 || blue.length < 2 || participants.some((p) => p.early));
  // the share of the match each alliance was short-handed for
  const shortBy = (a: Alliance): number => Math.max(0, ...members[a].map(awayOf));

  for (const p of participants) {
    const before = p.rating.rating;
    if (voided && !p.early) {
      updates.push({
        userId: p.userId,
        before: Math.round(before),
        after: Math.round(before),
        rd: Math.round(p.rating.rd),
        state: p.rating,
        voided: true,
      });
      continue;
    }
    // an early absentee in a voided match concedes it, whatever the score said
    const s = voided ? 0 : p.alliance === 'red' ? sRed : 1 - sRed;
    const opp = team[other(p.alliance)];
    const cur: Glicko = { rating: before, rd: rdOf(p), vol: p.rating.vol };
    const next = glicko2Update(cur, opp.rating, opp.rd, s, team[p.alliance].rating);

    let mult = voided ? 1 : k;
    const mates = members[p.alliance].filter((q) => q !== p);
    if (!voided) {
      const wide = mates.some(
        (q) => p.party && q.party === p.party && Math.abs(q.rating.rating - before) > WIDE_PREMADE_GAP,
      );
      if (wide) mult *= WIDE_PREMADE_MULT;
      if (mode === '2v2' && s === 0) {
        const mine = awayOf(p);
        let protect = 1;
        for (const q of mates) {
          if (p.party && q.party === p.party) continue; // your own premade: no protection
          const a = awayOf(q);
          if (a > mine) protect = Math.min(protect, Math.max(0, 1 - 2 * a));
        }
        mult *= protect;
      }
      if (mode === '2v2' && s === 1) mult *= 1 - shortBy(other(p.alliance));
    }

    const after = before + mult * (next.rating - before);
    updates.push({
      userId: p.userId,
      before: Math.round(before),
      after: Math.round(after),
      rd: Math.round(next.rd),
      state: { rating: after, rd: next.rd, vol: next.vol },
    });
  }
  return updates;
}

/** did this player queue as a premade with somebody on their OWN alliance? (A rated 1v1
 *  challenge shares its token with the opponent, which is not a premade.) */
type PartyView = Pick<MatchParticipant, 'userId' | 'alliance' | 'party'>;
export function isPremade(p: PartyView, all: readonly PartyView[]): boolean {
  return !!p.party && all.some((q) => q.userId !== p.userId && q.alliance === p.alliance && q.party === p.party);
}

/* `eloMode` now lives in `./eloMode` so `server/room.ts` can have it without importing
   `./db/repo` (and therefore `pg`) — see that file. Imported (this module uses it too) and
   re-exported, so every existing caller is unchanged. */
export { eloMode };

/** Persist a finished VERSUS match + its participants (for the match history and
 * replay). Requires both alliances present (≥2 authed players). When `ranked`, it
 * also reads current ratings, applies Glicko-2, upserts the new ratings, and
 * stores each player's rating before/after — returning the per-player overall
 * deltas for the results-screen reveal. When NOT ranked (a custom room) it records
 * the match with `ranked=false` and NULL ratings, moves NO ELO, and returns [].
 * Called from persistMatch. */
export async function persistVersusMatch(
  authed: MatchParticipant[],
  outcome: MatchOutcome,
  balanceVersion: number,
  replayId: string,
  ranked: boolean,
  game?: GameId,
  /** filled with the row id of the match this wrote, so the caller can hand it to anything
   *  that needs to point AT the match later — the misscore queue opens the replay by it. */
  out?: { matchId?: string },
): Promise<EloOutcome[]> {
  const reds = authed.filter((p) => p.alliance === 'red');
  const blues = authed.filter((p) => p.alliance === 'blue');
  // a RANKED result needs both sides; a custom game is kept one-sided (vs a guest, alone, vs
  // bots) so the people in it can still find it in their history and watch it back
  if (ranked && (!reds.length || !blues.length)) return [];
  /**
   * THE ROOM'S OWN FORMAT FIRST, a head-count only as the fallback.
   *
   * `eloMode(authed.length)` asks how many people were still in it at the end, which is a
   * different question from what was played: a 2v2 that finished with three participants was
   * filed AND RATED as a 1v1 — wrong row in the history, and a 2v2 result moving somebody's
   * 1v1 rating. `MatchOutcome.mode` is the room's answer (the staged queue bucket, else the
   * roster it fielded); absent only for a LAN upload or a caller that predates the field.
   */
  const mode = outcome.mode ?? eloMode(authed.length);
  const { red, blue } = outcome.result.score;

  let updates: EloBoardUpdate[] = [];
  const gamesAfter = new Map<string, number>(); // userId -> board games after this match
  // ELO is keyed by ACT (persists across seasons); resolve this season's act once, OUTSIDE the
  // transaction — it is a read of `seasons`, and nothing here writes that table.
  const act = ranked ? await actForSeason(balanceVersion, game) : 0;

  /**
   * ONE TRANSACTION for the ratings, the season snapshot, the match row and its participants.
   *
   * They used to be separate `q()` calls, several of them racing in a `Promise.all`, and any
   * failure part-way — a pool timeout, a Neon wake error, one participant's FK — left some
   * players' ratings moved with NO match row behind them, no history entry and no reveal, with
   * `persistMatch` swallowing the throw. Now the result lands whole or not at all.
   *
   * ⚠️ AND THE RATING ROWS ARE LOCKED FROM THE READ TO THE WRITE (`getRatingsFull(…, lock)`).
   * Glicko-2 is read → compute → write an absolute number, and two writers meet on the same row
   * more often than it looks: the behaviour charge fires at the same instant as this (see
   * `chargeRatingForBehaviour`), and a player who left one ranked match — still rated, as
   * `departed` — can finish another one around the time the first ends. Unlocked, the later
   * write erased the earlier one.
   *
   * Sequential inside, on the one connection a transaction owns: that costs a few round trips
   * the old `Promise.all` did not, which is the price of the result being atomic.
   */
  const matchId = await tx(async (query) => {
    if (ranked) {
      // ONE query for every player's rating, not one per player. Glicko-2's sequencing lives
      // in `computeGlicko`, which takes the whole set at once.
      const ratingsBefore = await getRatingsFull(authed.map((p) => p.userId!), mode, act, game, query, true);
      const parts: EloParticipant[] = authed.map((p) => {
        const r = ratingsBefore.get(p.userId!)!;
        return {
          userId: p.userId!,
          alliance: p.alliance,
          rating: { rating: r.rating, rd: r.rd, vol: r.vol },
          games: r.games,
          idleDays: r.idleDays,
          party: p.party,
          away: p.away,
          early: p.early,
        };
      });
      updates = computeGlicko(parts, outcome.result.score, { mode });
      // a voided player gets nothing written — including the default row the lock seeded
      const voided = updates.filter((u) => u.voided).map((u) => u.userId);
      await dropUntouchedRatings(voided, mode, act, game, query);
      for (const u of updates) {
        if (u.voided) {
          // the match did not count for this player: nothing is written to their board
          gamesAfter.set(u.userId, ratingsBefore.get(u.userId)?.games ?? 0);
          continue;
        }
        const games = await upsertRating(u.userId, mode, act, u.state.rating, u.state.rd, u.state.vol, game, query);
        gamesAfter.set(u.userId, games);
        // snapshot the post-match rating for THIS SEASON — freezes into the season's final
        // standings once it rolls (the live act board keeps evolving in elo_ratings).
        await upsertEloHistory(u.userId, mode, balanceVersion, u.state.rating, u.state.rd, u.state.vol, games, game, query);
      }
    }

    // TAGGED WITH THE SOLVE THAT PRODUCED IT (0039), read off the replay the room just recorded
    // rather than from a room flag: the container is what a later re-simulation will run, so
    // taking both facts from one place means the row can never disagree with its own replay.
    const id = await saveMatch(mode, balanceVersion, replayId, ranked, game, outcome.replay.physics, query);
    // one multi-row insert rather than one per player — same rows, same conflict handling
    await addMatchParticipants(
      id,
      authed.map((p) => {
        const u = ranked ? updates.find((x) => x.userId === p.userId) : undefined;
        return {
          userId: p.userId!,
          alliance: p.alliance,
          drivetrain: p.drivetrain,
          score: p.score,
          won: p.alliance === 'red' ? red > blue : blue > red,
          ratingBefore: u ? u.before : null,
          ratingAfter: u ? u.after : null,
          premade: ranked ? isPremade(p, authed) : null,
        };
      }),
      query,
    );
    return id;
  });
  if (out) out.matchId = String(matchId);

  // the rating change per player, for the results-screen reveal (ranked only;
  // custom returns nothing so no reveal fires)
  return updates.map((u) => ({
    userId: u.userId,
    before: u.before,
    after: u.after,
    rd: u.rd,
    games: gamesAfter.get(u.userId) ?? 0,
  }));
}
