import { useEffect, useRef, useState } from 'react';
import type { GameSettings, MatchPhase } from '../../types';
import type { HudSnapshot } from '../../game';
import type { MatchResultInfo } from '../../net/session';
import { recordScore } from '../../sim/replay';
import type { PaceState } from './PaceTag';
import { PaceCurveRecorder } from './curve';
import { PACE_TAG, resolvePace, type PaceRun } from './resolve';
import { curveFor, curveKey, PaceStale, playedRef, storeCurve, storedCurve } from './store';

/**
 * A RECORD RUN'S CURVE, MADE WHILE IT IS PLAYED, from the HUD's own 10 Hz reads.
 *
 * A record is simulated and stamped by the SERVER, whose sim can be behind this client's
 * (`store.ts`): then nothing on this client can re-run it, and a PB set in a record room could
 * never be raced. The run's own client saw every point of it, so it keeps them, under the replay's
 * seed and length (`playedRef`) since the server's replay id never reaches it. Only a run seen
 * from its pre-match is kept (a rejoin mid-match has a hole at the start), and its last point is
 * the result's own net score, the number its board row carries.
 */
export function useRecordedRunCurve(
  run: PaceRun | null,
  hud: HudSnapshot | null,
  result: () => MatchResultInfo | null,
): void {
  const rec = useRef<PaceCurveRecorder | null>(null);
  const kept = useRef(false);
  useEffect(() => {
    if (run?.kind !== 'record' || !hud || hud.mode !== 'match') return;
    if (hud.phase === 'pre') {
      rec.current = new PaceCurveRecorder();
      kept.current = false;
      return;
    }
    const r = rec.current;
    if (!r || kept.current) return;
    if (hud.phase !== 'post') {
      r.push(hud.phase, hud.timeLeft, Math.max(0, hud.score.total - hud.oppScore.foulPoints));
      return;
    }
    const info = result(); // lands a moment after the buzzer
    if (!info) return;
    kept.current = true;
    const game = info.replay.game ?? 'decode';
    r.push('post', 0, recordScore(info.result, hud.alliance));
    storeCurve(curveKey(playedRef(game, info.replay.seed, info.replay.ticks)), game, r.curve);
    // `result` is a getter over a ref; the HUD poll is what moves this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hud, run?.kind]);
}

/**
 * The pace for this screen, or null when the match is not one the pace runs in (or it is off).
 * Re-resolved each time a new match starts on the same screen (a restart, the next practice run),
 * which is how a fresh PB becomes the pace without leaving the game.
 */
export function usePace(
  settings: Pick<GameSettings, 'pace' | 'paceReplays' | 'game'>,
  run: PaceRun | null,
  userId: string | null,
  phase: MatchPhase,
): PaceState | null {
  const source = settings.pace ?? 'off';
  const on = source !== 'off' && run !== null;
  const picked = settings.paceReplays?.[settings.game];
  const runKey = run ? (run.kind === 'record' ? `record:${run.mode}` : 'practice') : '';

  // a new match on this screen: the phase left `post` (restart after the buzzer) or went back to
  // `pre` (a restart mid-match)
  const [round, setRound] = useState(0);
  const prev = useRef(phase);
  useEffect(() => {
    if ((prev.current === 'post' && phase !== 'post') || (prev.current !== 'pre' && phase === 'pre')) {
      setRound((n) => n + 1);
    }
    prev.current = phase;
  }, [phase]);

  const [state, setState] = useState<PaceState | null>(null);
  // what the shown curve was resolved for: a new round of the same match keeps it while the
  // target is asked again, but another game or kind of match must not read it even for a moment
  const shownFor = useRef('');
  /** the run (its store key) whose curve is on show */
  const shownRun = useRef('');
  useEffect(() => {
    if (source === 'off' || !run) {
      shownFor.current = '';
      setState(null);
      return;
    }
    const tag = PACE_TAG[source];
    const target = `${source}|${runKey}|${settings.game}|${userId ?? ''}|${picked?.key ?? ''}`;
    const same = shownFor.current === target;
    shownFor.current = target;
    let live = true;
    setState((s) => (same && s ? { ...s, why: '' } : { tag, curve: null, why: '' }));
    void (async () => {
      try {
        const res = await resolvePace(source, run, settings.game, userId, picked);
        if (!live) return;
        if (!res.ok) {
          setState({ tag, curve: null, why: res.why });
          return;
        }
        const t = res.target;
        // the SAME source can now be a DIFFERENT run (a new best since the last match): its
        // curve, not the old run's, or nothing while it is made — the old run under the new
        // run's name would be a number about a race nobody is running
        if (shownRun.current !== t.key && !storedCurve(curveKey(t.key))) setState({ tag, curve: null, why: '' });
        const curve = await curveFor(t.key, settings.game, t.load, t.alliance, t.pin, t.expect);
        if (!live) return;
        shownRun.current = t.key;
        setState({ tag, curve, why: '' });
      } catch (err) {
        if (!live) return;
        const why =
          err instanceof PaceStale
            ? err.message
            : err instanceof Error && err.message
              ? err.message
              : 'Could not load the pace run.';
        setState({ tag, curve: null, why });
      }
    })();
    return () => {
      live = false;
    };
    // `run` is read through `runKey` so a new object for the same kind does not re-resolve
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, source, runKey, settings.game, userId, picked?.key, round]);

  return on ? (state ?? { tag: PACE_TAG[source as Exclude<typeof source, 'off'>], curve: null, why: '' }) : null;
}

