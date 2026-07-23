import type { ShellNav } from './AppShell';

/** the four top-level destinations, in the order they appear on the home menu */
export const RAIL_ITEMS: ReadonlyArray<{ id: ShellNav; label: string }> = [
  { id: 'play', label: 'Play' },
  { id: 'configure', label: 'Configure' },
  { id: 'records', label: 'Records' },
  { id: 'profile', label: 'Profile' },
];

/**
 * Persistent left navigation for every screen EXCEPT home (where the same
 * destinations sit centered as the main menu). Renders as a flex sibling of the
 * content column INSIDE `.ds-app` — never `position: fixed`, because `.ds-app`
 * is the app's only scroll container (`html, body, #root` are `overflow:hidden`
 * for the full-screen game canvas) and a fixed rail would fight it.
 */
export function NavRail({
  active,
  onNav,
  showAdmin,
}: {
  active: ShellNav;
  onNav: (n: ShellNav) => void;
  showAdmin?: boolean;
}) {
  return (
    <nav className="ds-rail" aria-label="Main">
      <button className="ds-rail-home" onClick={() => onNav('home')}>
        ← Home
      </button>
      <div className="ds-rail-items">
        {RAIL_ITEMS.map((it) => (
          <button
            key={it.id}
            className={`ds-rail-btn${active === it.id ? ' on' : ''}`}
            aria-current={active === it.id ? 'page' : undefined}
            onClick={() => onNav(it.id)}
          >
            <span className="rl">{it.label}</span>
          </button>
        ))}
        {showAdmin && (
          <button
            className={`ds-rail-btn${active === 'admin' ? ' on' : ''}`}
            aria-current={active === 'admin' ? 'page' : undefined}
            onClick={() => onNav('admin')}
          >
            <span className="rl">Admin</span>
          </button>
        )}
      </div>
    </nav>
  );
}
