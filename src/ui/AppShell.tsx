import type { ReactNode } from 'react';

export type ShellNav = 'home' | 'robot' | 'leaderboard';

/**
 * Direction A "Driver Station" top-bar shell. Wraps the routed content screens
 * (Home, Leaderboard); full-screen surfaces (game, lobby, the robot builder)
 * render outside it. `right` is the rank/auth slot.
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
        <button className="ds-mark" onClick={() => onNav('home')} aria-label="DECODE home">
          <span className="glyph">D</span>DECODE
        </button>
        <nav className="ds-nav">
          {item('home', 'Home')}
          {item('robot', 'My Robot')}
          {item('leaderboard', 'Leaderboard')}
        </nav>
        <div className="ds-bar-right">{right}</div>
      </header>
      <main className="ds-main">{children}</main>
    </div>
  );
}
