import { useCallback, useEffect, useRef, useState } from 'react';
import { saveBlob } from './saveBlob';
import { onUserActive, userIdle } from './userActivity';
import type { GameId } from '../games/types';
import { cmTable } from '../competition/manual';
import { bonusLabel } from '../competition/copy';

/**
 * The competition pages' own small helpers. The console has twins of these in `adminBits.tsx`,
 * and importing those here would pull a module shared by two lazy chunks into a third chunk of
 * its own, which `npm run bundleaudit` cannot route; these are a few lines each.
 */

/**
 * Poll `load` every `ms`, paused while the tab is hidden or nobody is at the keyboard
 * (`userIdle`), and caught up the moment somebody is back. A failed poll keeps the last good
 * data on screen. `load` is read through a ref so an inline closure does not restart the timer.
 */
export function useCompPoll<T>(load: () => Promise<T | null>, ms: number): { data: T | null; err: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState(false);
  const fn = useRef(load);
  fn.current = load;
  const alive = useRef(true);
  const run = useCallback(() => {
    void fn.current().then((d) => {
      if (!alive.current) return;
      setErr(d === null);
      if (d !== null) setData(d);
    });
  }, []);
  useEffect(() => {
    alive.current = true;
    run();
    const t = window.setInterval(() => {
      if (document.visibilityState === 'hidden' || userIdle()) return;
      run();
    }, ms);
    const onVis = (): void => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVis);
    const unwake = onUserActive(run);
    return () => {
      alive.current = false;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
      unwake();
    };
  }, [ms, run]);
  return { data, err, reload: run };
}

/** a CSV the way a spreadsheet opens it: quoted cells, CRLF, and a BOM so non-ASCII names survive */
export function saveCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]): void {
  const cell = (v: string | number | null | undefined): string => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = [headers.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n');
  saveBlob(new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' }), filename);
}

/**
 * "Movement RP needs two robots: one scores at most 13." — one sentence per bonus RP a one-robot
 * alliance can never earn (`unreachableBonus`). The overview prints it as information for entrants,
 * the editor as a warning to the organizer.
 */
export function unreachableLine(game: GameId, ids: readonly string[]): string {
  const rows = cmTable(game)?.bonus ?? [];
  return ids
    .map((id) => {
      const max = rows.find((b) => b.id === id)?.perRobotMax;
      return max === undefined ? `${bonusLabel(id)} needs two robots.` : `${bonusLabel(id)} needs two robots: one scores at most ${max}.`;
    })
    .join(' ');
}

/** coarse "how long ago", with the exact time in the tooltip */
export function Ago({ at }: { at: number }) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  const text =
    s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86_400 ? `${Math.floor(s / 3600)}h ago` : new Date(at).toLocaleDateString();
  return (
    <time className="ds-muted" dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
      {text}
    </time>
  );
}
