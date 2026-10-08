import { useEffect, useRef, useState } from 'react';
import type { GameSettings, MatchPhase } from '../../types';
import type { PaceState } from './PaceTag';
import { PACE_TAG, resolvePace, type PaceRun } from './resolve';
import { curveFor, PaceStale } from './store';

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
        const curve = await curveFor(t.key, settings.game, t.load, t.alliance, t.pin);
        if (live) setState({ tag, curve, why: '' });
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

