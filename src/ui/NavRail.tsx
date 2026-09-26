import { inDiscordActivity } from '../net/discordActivity';
import type { ShellNav } from './AppShell';
import { QueueCounts } from './QueueCounts';

/** the four top-level destinations, in the order they appear on the home menu.
 *
 * A hint NAMES WHAT IS BEHIND THE LABEL; it never restates it. "Play → Pick a
 * game mode" said nothing the word Play did not. It renders twice: under the home
 * keycap (`.mh`) and under the rail label (`.rh`, hidden once the rail turns
 * horizontal). The rail's hints were cut on 2026-09-22 and restored on 2026-09-23
 * (owner). */
export const RAIL_ITEMS: ReadonlyArray<{ id: ShellNav; label: string; hint: string }> = [
  { id: 'play', label: 'Play', hint: 'Practice & compete' },
  { id: 'configure', label: 'Configure', hint: 'Robot & match setup' },
  { id: 'records', label: 'Records', hint: 'Leaderboard & career' },
  { id: 'profile', label: 'Profile', hint: 'Appearance & account' },
];

/**
 * ⚠️ PROFILE IS NOT OFFERED INSIDE A DISCORD ACTIVITY, because both halves of it are an
 * account and the embed can never have one: the page is a cross-origin iframe whose CSP
 * admits only Discord's own URL mappings, the auth host is not one, and the participant is
 * therefore ALWAYS signed out. Behind the item, Appearance is name/title/badges (all
 * server-held) and Account is sign-in, email, password, linked accounts and membership —
 * so the destination is a sign-in offer wearing two labels, which is the dead end this
 * whole ruling is about (the app bar's "?" avatar and the ranked tiles went the same way).
 *
 * The page itself is NOT deleted: it stays routable and, in the embed, says where the
 * account went and keeps the one local control on it (Reset all settings). Somebody who
 * has an account on the website is owed that sentence — what they are not owed is a
 * top-level menu entry that only ever leads to it.
 *
 * Host-based, and asked per render rather than at module load: `discordGroup()` is empty
 * after a storage-blocked reload, which would quietly put the item back on the one client
 * where it is most confusing.
 */
export function railItems(inActivity: boolean): typeof RAIL_ITEMS {
  return inActivity ? RAIL_ITEMS.filter((it) => it.id !== 'profile') : RAIL_ITEMS;
}

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
      <div className="ds-rail-items">
        {/* a PEER item, not a breadcrumb: the arrow-glyph "← Home" at 13px sat above 15px
            items like a second component (design review 01-22) */}
        <button className="ds-rail-btn home" onClick={() => onNav('home')}>
          <span className="rl">Home</span>
          <span className="rh">Main menu</span>
        </button>
        {railItems(inDiscordActivity()).map((it) => (
          <button
            key={it.id}
            className={`ds-rail-btn${active === it.id ? ' on' : ''}`}
            aria-current={active === it.id ? 'page' : undefined}
            onClick={() => onNav(it.id)}
          >
            <span className="rl">
              {it.label}
              {it.id === 'play' && <QueueCounts className="rail" />}
            </span>
            <span className="rh">{it.hint}</span>
          </button>
        ))}
        {showAdmin && (
          <button
            className={`ds-rail-btn${active === 'admin' ? ' on' : ''}`}
            aria-current={active === 'admin' ? 'page' : undefined}
            onClick={() => onNav('admin')}
          >
            <span className="rl">Admin</span>
            <span className="rh">Server control</span>
          </button>
        )}
      </div>
    </nav>
  );
}
