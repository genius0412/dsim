import { useEffect } from 'react';
import { fetchPresence } from '../net/api';
import { gameServerConfigured } from '../net/env';
import { setServerNotice } from '../net/notice';
import { getSiteState, loadSiteStatus, siteStatusAge } from '../net/siteStatus';
import { onUserActive, userIdle } from './userActivity';

/**
 * Poll the SITE STATUS (`GET /api/status`: lockdown, banners, the restart countdown) so every
 * page has it, including the ones with no WebSocket (Home, solo, the closed screen). Connected
 * screens also get changes pushed (`siteStatus`); this is what makes it global, and what lifts
 * a closed screen without a refresh.
 *
 * AGAINST AN OLDER SERVER (no `/api/status`, a 404) it falls back to what it did before: read
 * the restart notice off `/api/presence`.
 *
 * Mounted once at the app root. Renders nothing. Skips UNATTENDED pages (hidden, or nobody at
 * the keyboard for five minutes) and re-checks the moment someone is back — see `usePresence`
 * for why a background tab must not poll forever.
 */
export function NoticePoller({ pollMs = 20000 }: { pollMs?: number }) {
  useEffect(() => {
    if (!gameServerConfigured()) return;
    let alive = true;
    const tick = (): void => {
      if (userIdle()) return;
      if (siteStatusAge() < 5000) return; // the boot read, or a push-driven one, just ran
      void loadSiteStatus().then(() => {
        if (!alive || !getSiteState().unsupported) return;
        return fetchPresence()
          .then((p) => {
            if (alive) setServerNotice(p.notice ?? null);
          })
          .catch(() => {
            /* server asleep / unreachable - keep the last value, retry next tick */
          });
      });
    };
    tick();
    const iv = window.setInterval(tick, pollMs);
    document.addEventListener('visibilitychange', tick);
    const unwake = onUserActive(tick);
    return () => {
      alive = false;
      window.clearInterval(iv);
      document.removeEventListener('visibilitychange', tick);
      unwake();
    };
  }, [pollMs]);
  return null;
}
