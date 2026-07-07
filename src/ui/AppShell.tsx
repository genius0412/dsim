import type { ReactNode } from 'react';
import { APP_NAME, CURRENT_SEASON, LINKS } from '../seasons';
import { Logo } from './Logo';

export type ShellNav = 'home' | 'robot' | 'stats' | 'leaderboard' | 'download';

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
}: {
  active: ShellNav;
  onNav: (n: ShellNav) => void;
  right?: ReactNode;
  children: ReactNode;
}) {
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
        </nav>
        <div className="ds-bar-right">{right}</div>
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
