import { fetchPracticeRuns, fetchRecords, fetchReplay, fetchUserStats } from '../../net/api';
import { listPracticeRuns, loadPracticeReplay } from '../../net/practiceRuns';
import { BALANCE_VERSION, SIM_VERSION } from '../../config';
import { replayFidelity, type Replay } from '../../sim/replay';
import { curveKey, storedCurve } from './store';
import type { GameId, PaceReplayRef, PaceSource } from '../../types';

/**
 * WHICH RUN IS THE PACE, for the match about to be played.
 *
 * Asked again at the start of every match rather than once per setting, which is what makes PB
 * and WR follow themselves: a new best is the pace from the next match on. The question is a
 * couple of small reads; the expensive half (the curve) is stored per replay (`store.ts`), so an
 * unchanged PB costs nothing to find again.
 */

/** the kind of match the pace is for — the only two it runs in */
export type PaceRun = { kind: 'practice' } | { kind: 'record'; mode: 'solo' | 'duo' };

export interface PaceTarget {
  /** the curve's store key (`r:<replay id>` or `l:<local key>`) */
  key: string;
  load: () => Promise<Replay>;
  /** whose score is the pace; absent reads the replay's first seat, which a record and a
   *  practice run both put the player in */
  alliance?: PaceReplayRef['alliance'];
  /** keep the curve whatever else is evicted (a custom pick) */
  pin?: boolean;
}

export type PaceResolution = { ok: true; target: PaceTarget } | { ok: false; why: string };

/** the HUD's short name for a source */
export const PACE_TAG: Record<Exclude<PaceSource, 'off'>, string> = {
  pb: 'PB',
  wr: 'WR',
  replay: 'REPLAY',
};

const fromServer = (replayId: string): PaceTarget => ({
  key: `r:${replayId}`,
  load: () => fetchReplay(replayId),
});

export async function resolvePace(
  source: Exclude<PaceSource, 'off'>,
  run: PaceRun,
  game: GameId,
  userId: string | null,
  picked: PaceReplayRef | undefined,
): Promise<PaceResolution> {
  // solo practice is one robot on the clock, which is what a SOLO record is
  const mode = run.kind === 'record' ? run.mode : 'solo';

  if (source === 'replay') {
    if (!picked) return { ok: false, why: 'No replay picked. Open a replay and choose Use as pace.' };
    if (picked.replayId) return { ok: true, target: { ...fromServer(picked.replayId), alliance: picked.alliance, pin: true } };
    // a run watched straight off the results screen: its curve was stored when it was picked,
    // and on this device that is the only copy
    return {
      ok: true,
      target: {
        key: picked.key,
        alliance: picked.alliance,
        pin: true,
        load: () => Promise.reject(new Error('That replay is only on the device it was picked on.')),
      },
    };
  }

  if (source === 'wr') {
    const { rows } = await fetchRecords(mode, 'overall', undefined, game);
    const best = rows[0]?.score;
    if (best == null) return { ok: false, why: 'No record on this board yet.' };
    // A TIE AT THE TOP CAN BE RACED ON ANY OF ITS RUNS, and one may be playable when another is
    // not: a record set on an older season's balance stays on the board, but its replay is a
    // different match on this build. So the first tied run this build can re-run is the pace.
    for (const r of rows) {
      if (r.score !== best) break;
      if (!r.replayId) continue;
      const target = fromServer(r.replayId);
      if (storedCurve(curveKey(target.key))) return { ok: true, target };
      const replay = await fetchReplay(r.replayId).catch(() => null);
      if (replay && replayFidelity(replay, BALANCE_VERSION, SIM_VERSION) === 'ok') {
        return { ok: true, target: { ...target, load: () => Promise.resolve(replay) } };
      }
    }
    return { ok: false, why: 'The record was set on an older version of DSIM, so it cannot be raced.' };
  }

  // PB
  if (run.kind === 'record') {
    if (!userId) return { ok: false, why: 'Sign in to race your best record.' };
    const stats = await fetchUserStats(userId, undefined, game);
    const best = stats.records.find((r) => r.mode === mode);
    return best?.replayId
      ? { ok: true, target: fromServer(best.replayId) }
      : { ok: false, why: `No ${mode} record yet. Finish a run to set one.` };
  }

  // solo practice: your best practice run in this game, on this device or on the account, that
  // this build re-runs exactly (`store.ts`): a best from before a sim change is a different match
  // now, so the best run after it is the pace. A run with other robots on the field is not a solo
  // score (`PracticeRunMeta.others`).
  const candidates: { score: number; target: PaceTarget; local?: true }[] = [];
  for (const m of listPracticeRuns()) {
    if (m.game !== game || (m.others ?? 0) > 0) continue;
    if (m.balanceVersion !== BALANCE_VERSION || m.sim !== SIM_VERSION) continue;
    candidates.push({
      score: m.score,
      local: true,
      target: {
        key: `l:${m.id}`,
        load: async () => {
          const r = loadPracticeReplay(m.id);
          if (!r) throw new Error('That run is no longer on this device.');
          return r;
        },
      },
    });
  }
  if (userId) {
    const remote = await fetchPracticeRuns(game).catch(() => null);
    for (const r of remote ?? []) if (r.replayId) candidates.push({ score: r.score, target: fromServer(r.replayId) });
  }
  candidates.sort((a, b) => b.score - a.score);
  // the account's runs say nothing of their sim until fetched, so the first few are checked
  let fetched = 0;
  for (const c of candidates) {
    if (c.local || storedCurve(curveKey(c.target.key))) return { ok: true, target: c.target };
    if (fetched++ >= 3) break;
    const replay = await c.target.load().catch(() => null);
    if (replay && replayFidelity(replay, BALANCE_VERSION, SIM_VERSION) === 'ok') {
      return { ok: true, target: { ...c.target, load: () => Promise.resolve(replay) } };
    }
  }
  return { ok: false, why: 'No practice run on this version yet. Finish one to set a best.' };
}
