import { dbEnabled, q } from './db/pool';
import {
  addActivity,
  currentSeasonNumber,
  ensureProfile,
  ensureSeason,
  personalBest,
  recentStandingCount,
  recordRank,
  saveReplay,
  submitRecord,
} from './db/repo';
import { STANDING_COST } from '../src/standing';
import { chargeStanding, creditCleanMatch } from './standing';
import { persistVersusMatch } from './ranked';
// scrubSpecNames used to live HERE. It moved to `./moderation` when `saveReplay` started
// scrubbing too: repo.ts is the one funnel all three replay writers share, and persist.ts
// imports repo.ts, so repo.ts importing it back from here would be a cycle.
import { scrubSpecNames } from './moderation';
import { recordScore } from '../src/sim/replay';
import { simModuleFor } from '../src/games/sim';
import type { BehaviourReport, DodgeReport, MatchOutcome, PersistOutcome } from './room';
import { type DodgeVerdict } from '../src/dodge';
import { WINDOW_HOURS } from '../src/standing';
import * as C from '../src/config';

/**
 * Persist a finished match (off the hot path — called at phase 'post'). The
 * SERVER is the only trusted writer; scores come from the authoritative sim.
 * Requires ≥1 AUTHED participant (else the run is anonymous and dropped). Never
 * throws into the caller. No-ops when the DB is disabled.
 *
 * - RECORD room → leaderboard row (solo = 1 player, duo = primary + partner).
 * - VERSUS room → ranked ELO + match history.
 * Both save the recorded replay first (public, watchable, re-simulatable).
 */
export async function persistMatch(o: MatchOutcome): Promise<PersistOutcome> {
  const authed = o.participants.filter((p) => p.userId);
  const label = o.config.kind === 'record' ? `record/${o.config.record ?? 'solo'}` : 'versus';
  console.log(
    `[persist] match end: ${label} participants=${o.participants.length} authed=${authed.length} dbEnabled=${dbEnabled}`,
  );
  // UNSCORED games never touch ELO/records/history (a 0-0 result would pollute the
  // boards). Both DECODE and Chain Reaction are scored; the boards/periods are keyed
  // PER GAME (`o.game`), so each game's ranked/records stay fully separate.
  const game = o.game ?? 'decode';
  if (!simModuleFor(game).scored) {
    console.log(`[persist] SKIP — unscored game (${game})`);
    return {};
  }
  if (!dbEnabled) {
    console.log('[persist] SKIP — DATABASE_URL unset (no DB)');
    return {};
  }
  if (authed.length === 0) {
    console.log('[persist] SKIP — no authed participants (run is anonymous, dropped)');
    return {};
  }
  try {
    // Season = the DB-controlled current season (>= the replay's balance version),
    // so an admin-started season stamps new results without a redeploy. Records +
    // matches key off it, per-game, each game opening in the act its own module names
    // (`initialAct`: DECODE 0/beta, Chain Reaction 1). The
    // replay row is ALSO stamped with the season (its `balance_version` column, for
    // purge-by-season) but keeps its real sim-code version in `sim_version` — the
    // playback gate compares CODE-vs-CODE, so a season bump must NOT make the replay
    // read as "recorded on an older version". Hence we do NOT overwrite
    // o.replay.balanceVersion here; saveReplay takes the season (and game) separately.
    const bv = await currentSeasonNumber(o.replay.balanceVersion, game);
    await ensureSeason(bv, game, simModuleFor(game).initialAct);
    for (const p of authed) await ensureProfile(p.userId!, p.handle ?? 'Player');
    const replayId = await saveReplay(o.replay, bv, game);

    /**
     * PLAYTIME + GAMES PLAYED, credited to everyone who was in it.
     *
     * Measured from the REPLAY's tick count, which is the authoritative length of the match
     * the server just ran — not a wall clock, and not anything the client said. A match that
     * ended early (an abandon, a cancelled room) credits the time it actually lasted.
     *
     * Counted for EVERY kind of match, record runs included: they are as much "playing the
     * game" as a ranked match, and a playtime that ignored score attack would read as broken
     * to the players who mostly do that. Departed players are in `authed` too — they played
     * the part they were there for.
     */
    await addActivity(
      authed.map((p) => p.userId!),
      o.replay.ticks * C.SIM_DT,
      game,
    ).catch((e: unknown) => console.error('[persist] activity write failed:', e));

    if (o.config.kind === 'record') {
      const primary = authed[0];
      const partner = authed[1];
      const mode = o.config.record ?? 'solo';
      // RECORD boards ARE split by drivetrain. A duo whose two robots ran DIFFERENT
      // drivetrains keys the 'overall' bucket (cross-drivetrain board only); solo
      // runs and shared-drivetrain duos key their real drivetrain. Uses ALL
      // participants (incl. an unauthed partner) so the mix is judged on the robots
      // that actually played. (Ranked ELO, by contrast, is no longer split.)
      const drivetrains = new Set(o.participants.map((p) => p.drivetrain));
      const drivetrain = drivetrains.size > 1 ? 'overall' : primary.drivetrain;
      // NET score: the alliance's earned total minus the penalty points it handed
      // the (empty) opposing alliance — i.e. the fouls the player(s) committed.
      const score = recordScore(o.result, primary.alliance);
      const prevBest = await personalBest(primary.userId!, mode, drivetrain, bv, game);
      // moderate the robot/team names before they land on the public leaderboard card
      const primarySpec = await scrubSpecNames(primary.spec);
      const partnerSpec = partner?.spec ? await scrubSpecNames(partner.spec) : undefined;
      const id = await submitRecord({
        userId: primary.userId!,
        partnerId: partner?.userId,
        mode,
        drivetrain,
        score,
        balanceVersion: bv,
        replayId,
        game,
        // each driver brings their OWN robot; a duo stores both so the board can
        // show both drivetrains (partner absent ⇒ solo run)
        config: { spec: primarySpec, assists: primary.assists, partnerSpec },
      });
      const { rank, total } = await recordRank(primary.userId!, mode, drivetrain, bv, game);
      const info = {
        mode,
        drivetrain,
        score,
        rank,
        total,
        isPB: prevBest === null || score > prevBest,
        isWR: rank === 1,
      };
      console.log(
        `[persist] WROTE record ${id}: user=${primary.userId} score=${score} dt=${drivetrain} rank=${rank}/${total} pb=${info.isPB} wr=${info.isWR} season=${bv}`,
      );
      return { record: info };
    } else {
      const ids: { matchId?: string } = {};
      const elo = await persistVersusMatch(authed, o, bv, replayId, o.ranked, game, ids);
      /* ORPHAN SWEEP — the same one `saveLanRun` does when it loses its race, for the same
       * reason: a `replays` row has no back-reference, so one nothing points at is invisible
       * to `deleteAccount` and to both prunes and is freed only by a season purge.
       * `persistVersusMatch` early-returns WITHOUT calling `saveMatch` when either alliance
       * has no authed player — a signed-in player against a guest, or a 2v2 whose two
       * accounts sat on one alliance — and the replay was already written above.
       * ⚠️ The test is `ids.matchId`, NOT `elo.length`: an UNRANKED custom room moves no ELO
       * and returns [], but it DOES write its match row, and deleting that match's replay
       * would take the Watch button off a real custom game. */
      if (!ids.matchId) await q(`delete from replays where id = $1`, [replayId]);
      // say which of the two things actually happened — the old line printed "WROTE versus
      // match" on the exact path that writes no match row and then deletes the replay again,
      // which is the one case an operator reading this log is trying to find
      console.log(
        ids.matchId
          ? `[persist] WROTE versus match (ranked=${o.ranked}) — ${elo.length} ratings updated` +
              (elo.length === 0 && o.ranked ? ' (not a two-sided match)' : '')
          : `[persist] NO versus match row (one-sided room, ranked=${o.ranked}) — replay discarded, playtime still credited`,
      );
      return { elo, matchId: ids.matchId };
    }
  } catch (e) {
    // ⚠️ A THROW ANYWHERE AFTER `saveReplay` LEAKS ITS ROW. The replay is written early (the
    // match row references it), so every later failure — `persistVersusMatch`, the record
    // write, a pool timeout — leaves a `replays` row nothing points at, invisible to
    // `deleteAccount` and to both prunes and freed only by a season purge. The one-sided-room
    // sweep above closes the COMMON member of that class (it happens on every guest game, not
    // on an outage); this one is left open deliberately rather than swept here, because a
    // `delete` issued from the handler for a DB that is already failing is as likely to throw
    // as to help, and losing a replay whose match row DID get written would be the worse bug.
    console.error('[persist] FAILED writing to DB:', e);
  }
  return {};
}

/**
 * Charge a cancelled ranked pairing to whoever caused it.
 *
 * Runs OFF the cancel path (the room fires and forgets), so a slow or failing database can
 * never delay tearing the room down or stop the innocent players from requeueing. A failed
 * write means a dodge goes uncharged, which is the right way to fail: the alternative is a
 * player stuck staring at a dead room while a transaction retries.
 *
 * The escalation is counted PER PLAYER over a rolling window, and the count is read fresh
 * for each culprit rather than shared — two people dodging the same match are not each
 * other's repeat offence.
 */
export async function persistDodges(d: DodgeReport): Promise<DodgeVerdict[]> {
  if (!dbEnabled || !d.culprits.length) return [];
  try {
    const verdicts: DodgeVerdict[] = [];
    // de-duplicate: one player can be named by two rules at once (absent AND unready), and
    // one abandoned match must never be billed twice
    const seen = new Set<string>();
    for (const c of d.culprits) {
      if (seen.has(c.userId)) continue;
      seen.add(c.userId);
      // STANDING, not rating: a dodge says nothing about how well someone drives (see
      // src/dodge.ts). Rating only enters this at the bottom of the standing ladder, and
      // `chargeStanding` is what decides that — not this call site.
      const standing = await chargeStanding(c.userId, 'dodge', {
        game: d.game,
        mode: d.mode,
        roomCode: d.roomCode,
      });
      const count = await recentStandingCount(c.userId, 'dodge', WINDOW_HOURS.dodge);
      verdicts.push({ userId: c.userId, kind: c.kind, standing, count });
    }
    // the INNOCENT get a verdict too, with nothing charged — "this wasn't billed to you" is
    // the difference between a system that reads as fair and one that reads as arbitrary
    for (const userId of d.rosterUserIds) {
      if (seen.has(userId)) continue;
      verdicts.push({ userId, kind: null, standing: null, count: 0 });
    }
    return verdicts;
  } catch (e) {
    console.error('[dodge] FAILED charging standing:', e);
    return [];
  }
}

/**
 * Charge (and credit) what a finished ranked match showed about its players.
 *
 * Fire-and-forget, like the dodge path: standing is bookkeeping ABOUT a match, and a slow
 * write must never hold up the results screen or the room teardown.
 *
 * The CLEAN CREDIT is the other half of the design and is easy to forget — a system that
 * only ever subtracts is one nobody can climb out of, so finishing a match you played is
 * how the debt actually comes off.
 */
export async function persistBehaviour(b: BehaviourReport): Promise<void> {
  if (!dbEnabled) return;
  try {
    for (const o of b.offenders) {
      await chargeStanding(o.userId, o.kind, { game: b.game, mode: b.mode, roomCode: b.roomCode });
    }
    /**
     * A CARD IS A BEHAVIOUR FINDING WITH EVIDENCE ATTACHED, so it is charged like one.
     *
     * The referee in the sim issues it for a rule broken hard enough to be sanctioned —
     * excessive over-possession, or a second offence escalating to red — and it is already in
     * the match record, on the results screen and in the replay. A RED costs more than a
     * yellow because it is the second one, and because it voids the alliance's score.
     */
    for (const c of b.carded ?? []) {
      await chargeStanding(c.userId, 'card', {
        game: b.game,
        mode: b.mode,
        roomCode: b.roomCode,
        points: c.colour === 'red' ? STANDING_COST.card * 2 : undefined,
      });
    }
    // ...and a carded driver did NOT play it clean, whatever else the participation test
    // said about them: crediting the heal beside the charge would hand part of it straight
    // back on the same match.
    const cardedIds = new Set((b.carded ?? []).map((c) => c.userId));
    await creditCleanMatch(b.cleanUserIds.filter((id) => !cardedIds.has(id)));
  } catch (e) {
    console.error('[standing] FAILED recording match behaviour:', e);
  }
}
