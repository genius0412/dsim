import { useEffect, useState } from 'react';
import type { GameId } from '../types';
import { compareAwards } from '../awards';
import { BADGE_EARN, BADGE_KEYS, BADGE_LABELS } from '../badges';
import { authEnabled } from '../lib/authClient';
import { fetchUserStats, type UserStats } from '../net/api';
import { gameServerConfigured } from '../net/env';
import { AwardList } from './AwardList';
import { BadgeArt } from './BadgeMark';

/**
 * ACHIEVEMENTS (`/records/achievements`): every badge there is, which ones this account holds and how
 * many times, and the awards that earned them. The data is what Career already loads (`awards`,
 * `badgeCounts` on `UserStats`, both account-wide and never season-scoped, so a new season cannot
 * empty it); this page is where it gets a home of its own instead of a block inside Career.
 *
 * Every badge is listed, earned or not, because a badge is a category and its name alone does not
 * say what puts a count on it: `BADGE_EARN` is the sentence that does. An unearned badge is shown
 * dimmed (not hidden) so the page doubles as the list of what to go and do.
 */
export function AchievementsPage({ myUserId, game }: { myUserId: string | null; game?: GameId }) {
  const [stats, setStats] = useState<UserStats | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error' | 'ok'>('idle');
  const configured = gameServerConfigured();

  useEffect(() => {
    if (!configured || !myUserId) return;
    let alive = true;
    setState('loading');
    fetchUserStats(myUserId, undefined, game)
      .then((s) => {
        if (!alive) return;
        setStats(s);
        setState('ok');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        console.warn('[achievements] stats failed', e);
        setState('error');
      });
    return () => {
      alive = false;
    };
  }, [configured, myUserId, game]);

  const counts = stats?.badgeCounts ?? {};
  const awards = stats?.awards ?? [];

  return (
    <>
      <h1 className="ds-h1">Achievements</h1>
      <div className="ds-panel">
        <div className="ds-panel-h">
          <h2 className="ds-panel-title">Badges</h2>
        </div>
        {!authEnabled || !configured ? (
          <div className="ds-empty">
            <div className="big">Achievements are unavailable</div>
            This build has no accounts or game server, and badges are kept on your account.
          </div>
        ) : !myUserId ? (
          <div className="ds-empty">
            <div className="big">Sign in to see your achievements</div>
            Badges and awards belong to your account.
          </div>
        ) : state === 'error' ? (
          <div className="ds-empty">
            <div className="big">Couldn’t load your achievements</div>
            Check your connection and reopen this page.
          </div>
        ) : state !== 'ok' ? (
          <div className="ds-loading">Loading achievements…</div>
        ) : (
          <ul className="ds-badge-list">
            {BADGE_KEYS.map((id) => {
              const n = counts[id] ?? 0;
              return (
                <li key={id} className={`ds-badge-row${n > 0 ? ' earned' : ''}`}>
                  <BadgeArt id={id} n={n} />
                  <span className="bd-text">
                    <b>{BADGE_LABELS[id]}</b>
                    <span className="bd-earn">{BADGE_EARN[id]}</span>
                  </span>
                  <span className="bd-state">{n > 0 ? (n > 1 ? `Earned ×${n}` : 'Earned') : 'Not yet'}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {state === 'ok' && awards.length > 0 && (
        <div className="ds-panel">
          <div className="ds-panel-h">
            <h2 className="ds-panel-title">Awards</h2>
          </div>
          <div className="ds-panel-body">
            <AwardList awards={[...awards].sort(compareAwards)} />
          </div>
        </div>
      )}
    </>
  );
}
