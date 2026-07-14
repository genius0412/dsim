import { dbEnabled } from './db/pool';
import {
  currentSeasonNumber,
  ensureProfile,
  ensureSeason,
  personalBest,
  recordRank,
  saveReplay,
  submitRecord,
} from './db/repo';
import { persistVersusMatch } from './ranked';
import { recordScore } from '../src/sim/replay';
import { simModuleFor } from '../src/games/sim';
import type { MatchOutcome, PersistOutcome } from './room';

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
  // UNSCORED games (the Chain Reaction shell) never touch ELO/records/history —
  // they have no scoring yet, so a 0-0 result would just pollute the boards. The DB
  // is already keyed for game (via the room's game); scored games persist as before.
  if (!simModuleFor(o.game).scored) {
    console.log(`[persist] SKIP — unscored game (${o.game ?? 'decode'})`);
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
    // so an admin-started season stamps new results without a redeploy. Stamp the
    // replay row with the same season so a season purge can delete it directly.
    const bv = await currentSeasonNumber(o.replay.balanceVersion);
    o.replay.balanceVersion = bv;
    await ensureSeason(bv);
    for (const p of authed) await ensureProfile(p.userId!, p.handle ?? 'Player');
    const replayId = await saveReplay(o.replay);

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
      const prevBest = await personalBest(primary.userId!, mode, drivetrain, bv);
      const id = await submitRecord({
        userId: primary.userId!,
        partnerId: partner?.userId,
        mode,
        drivetrain,
        score,
        balanceVersion: bv,
        replayId,
        // each driver brings their OWN robot; a duo stores both so the board can
        // show both drivetrains (partner absent ⇒ solo run)
        config: { spec: primary.spec, assists: primary.assists, partnerSpec: partner?.spec },
      });
      const { rank, total } = await recordRank(primary.userId!, mode, drivetrain, bv);
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
      const elo = await persistVersusMatch(authed, o, bv, replayId, o.ranked);
      console.log(
        `[persist] WROTE versus match (ranked=${o.ranked}) — ${elo.length} ratings updated` +
          (elo.length === 0 && o.ranked ? ' (not a two-sided match)' : ''),
      );
      return { elo };
    }
  } catch (e) {
    console.error('[persist] FAILED writing to DB:', e);
  }
  return {};
}
