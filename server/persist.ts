import { dbEnabled } from './db/pool';
import { ensureProfile, ensureSeason, saveReplay, submitRecord } from './db/repo';
import { applyMatchElo } from './ranked';
import type { MatchOutcome } from './room';

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
export async function persistMatch(o: MatchOutcome): Promise<void> {
  const authed = o.participants.filter((p) => p.userId);
  const label = o.config.kind === 'record' ? `record/${o.config.record ?? 'solo'}` : 'versus';
  console.log(
    `[persist] match end: ${label} participants=${o.participants.length} authed=${authed.length} dbEnabled=${dbEnabled}`,
  );
  if (!dbEnabled) {
    console.log('[persist] SKIP — DATABASE_URL unset (no DB)');
    return;
  }
  if (authed.length === 0) {
    console.log('[persist] SKIP — no authed participants (run is anonymous, dropped)');
    return;
  }
  try {
    const bv = o.replay.balanceVersion;
    await ensureSeason(bv);
    for (const p of authed) await ensureProfile(p.userId!, p.handle ?? 'Player');
    const replayId = await saveReplay(o.replay);

    if (o.config.kind === 'record') {
      const primary = authed[0];
      const partner = authed[1];
      const score = o.result.score[primary.alliance];
      const id = await submitRecord({
        userId: primary.userId!,
        partnerId: partner?.userId,
        mode: o.config.record ?? 'solo',
        drivetrain: primary.drivetrain,
        score,
        balanceVersion: bv,
        replayId,
      });
      console.log(
        `[persist] WROTE record ${id}: user=${primary.userId} score=${score} dt=${primary.drivetrain} season=${bv}`,
      );
    } else {
      await applyMatchElo(authed, o, bv, replayId);
      console.log(`[persist] WROTE ELO for ${authed.length} players`);
    }
  } catch (e) {
    console.error('[persist] FAILED writing to DB:', e);
  }
}
