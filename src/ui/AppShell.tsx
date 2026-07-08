import type { ReactNode } from 'react';
import { APP_NAME, CURRENT_SEASON, LINKS } from '../seasons';
import { Logo } from './Logo';
import { usePresence } from './usePresence';
import type { Presence } from '../net/api';

export type ShellNav = 'home' | 'robot' | 'stats' | 'leaderboard' | 'download' | 'admin';

/** ambient "who's around" chip in the top bar: a live-green dot + the online /
 * signed-in tally, with the ranked-queue depth in the tooltip. Renders nothing
 * until presence lands (server unconfigured / asleep / first poll pending). */
function PresenceChip({ p }: { p: Presence }) {
  const queued = p.queues['1v1'] + p.queues['2v2'];
  const title =
    `${p.online} connected to multiplayer · ${p.signedIn} signed in` +
    (queued ? ` · ${queued} in ranked queue (1v1 ${p.queues['1v1']}, 2v2 ${p.queues['2v2']})` : '');
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
        whiteSpace: 'nowrap',
        color: 'var(--ds-dim, #93a1ad)',
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: '#3ad17a',
          boxShadow: '0 0 6px #3ad17a',
          flex: 'none',
        }}
      />
      <b style={{ color: 'var(--ds-ink, #e8edf2)', fontWeight: 600 }}>{p.online}</b> online
      {p.signedIn > 0 && <span style={{ opacity: 0.7 }}>· {p.signedIn} signed in</span>}
    </span>
  );
}

/**
 * Direction A "Driver Station" top-bar shell. Wraps the routed content screens
 * (Home, Stats, Leaderboard, Download); full-screen surfaces (game, lobby, the
 * robot builder) render outside it. `right` is the rank/auth slot. A footer
 * carries the brand + the external repo/Discord links.
 */
export function AppShell({
  active,
  onNav,
  right,
  children,
  showAdmin,
}: {
  active: ShellNav;
  onNav: (n: ShellNav) => void;
  right?: ReactNode;
  children: ReactNode;
  /** show the Admin tab (only the signed-in admin account) */
  showAdmin?: boolean;
}) {
  const presence = usePresence();
  const item = (id: ShellNav, label: string) => (
    <button className={active === id ? 'on' : ''} onClick={() => onNav(id)}>
      {label}
    </button>
  );
  return (
    <div className="ds-app">
      <header className="ds-bar">
        <button className="ds-mark" onClick={() => onNav('home')} aria-label={`${APP_NAME} home`}>
          <Logo size={24} />
          {APP_NAME}
        </button>
        <nav className="ds-nav">
          {item('home', 'Home')}
          {item('robot', 'My Robot')}
          {item('stats', 'My Stats')}
          {item('leaderboard', 'Leaderboard')}
          {item('download', 'Download')}
          {showAdmin && item('admin', 'Admin')}
        </nav>
        <div className="ds-bar-right">
          {presence && <PresenceChip p={presence} />}
          {right}
        </div>
      </header>
      <main className="ds-main">{children}</main>
      <footer className="ds-foot">
        <span className="ds-foot-brand">
          {APP_NAME} · {CURRENT_SEASON.name} {CURRENT_SEASON.years}
        </span>
        <span className="ds-foot-links">
          <a href={LINKS.repo} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href={LINKS.discord} target="_blank" rel="noreferrer">
            Discord
          </a>
        </span>
      </footer>
    </div>
  );
}
