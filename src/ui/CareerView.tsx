import { useEffect, useState, type ReactNode } from 'react';
import {
  fetchSeasons,
  type MatchHistoryOpts,
  type MatchHistoryPage,
  type SeasonInfo,
  type UserStats,
} from '../net/api';
import { periodLabel } from '../seasons';
import { CareerPanel } from './CareerPanel';
import { MatchHistory } from './MatchHistory';
import { PeriodPicker } from './PeriodPicker';
import type { CareerNav } from './Stats';

/**
 * The Career body shared by "My Stats" and the public profile page. Owns ONE
 * Act/Season period picker that drives BOTH the stats panel and the match-history
 * list, so selecting a PAST period shows that season's FINAL standings + its
 * matches (historical stats). Callers inject how to load stats (by user id or by
 * username) and a bound match-history fetcher; a 404 from `loadStats` renders the
 * `notFound` slot (the profile page's "no such player").
 */
export function CareerView({
  loadStats,
  fetchPage,
  nameFallback,
  head,
  headerAction,
  nav = {},
  notFound,
}: {
  loadStats: (season?: number) => Promise<UserStats>;
  fetchPage: (opts: MatchHistoryOpts) => Promise<MatchHistoryPage>;
  /** display name when the loaded stats carry no handle */
  nameFallback: string;
  /** page heading rendered above the picker (may use the loaded stats) */
  head?: (stats: UserStats | null) => ReactNode;
  /** header control (e.g. a Share button), may use the loaded stats */
  headerAction?: (stats: UserStats | null) => ReactNode;
  nav?: CareerNav;
  /** shown instead of the panels when `loadStats` 404s (unknown profile) */
  notFound?: ReactNode;
}) {
  const [seasons, setSeasons] = useState<SeasonInfo[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [season, setSeason] = useState<number | null>(null); // null = live period

  const [stats, setStats] = useState<UserStats | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error' | 'notfound'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    fetchSeasons(nav.game)
      .then((r) => {
        if (!alive) return;
        setSeasons(r.seasons);
        setCurrent(r.current);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [nav.game]);

  // Keyed on WHETHER there is a not-found slot, never on the element itself: Profile builds a
  // fresh `notFound` every render and re-renders on every friends poll, so depending on the
  // element re-fetched the stats and flashed "Loading…" each time.
  const hasNotFound = notFound != null;
  useEffect(() => {
    let alive = true;
    setStatus('loading');
    loadStats(season ?? undefined)
      .then((s) => {
        if (!alive) return;
        setStats(s);
        setStatus('ok');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (/404/.test(msg) && hasNotFound) {
          setStatus('notfound');
        } else {
          console.warn('career: load failed', e);
          setError(msg);
          setStatus('error');
        }
      });
    return () => {
      alive = false;
    };
  }, [loadStats, season, hasNotFound]);

  const viewing = season ?? current;
  const info = seasons.find((s) => s.season === viewing);
  const archived = viewing != null && current != null && viewing < current;
  const seasonLabel = info ? periodLabel(info) : 'Current period';
  const name = stats?.handle ?? nameFallback;

  return (
    <>
      {head?.(stats)}
      {status === 'notfound' ? (
        notFound
      ) : (
        <>
          {/* the SAME period heading the Leaderboard tab prints (design review 07-08) — the
              period used to live only in the panel title, beside a second FINAL chip */}
          <h2 className="ds-h2 ds-period-head">
            {seasonLabel}
            {archived ? ' · final' : ''}
          </h2>
          <PeriodPicker seasons={seasons} current={current} value={season} onChange={setSeason} label="Period" />
          <CareerPanel
            stats={stats}
            status={status}
            error={error}
            name={name}
            archived={archived}
            headerAction={headerAction?.(stats)}
          />
          <MatchHistory
            fetchPage={fetchPage}
            season={season}
            seasonLabel={info ? periodLabel(info) : 'this period'}
            onWatch={nav.onWatch}
            onOpenProfile={nav.onOpenProfile}
          />
        </>
      )}
    </>
  );
}
