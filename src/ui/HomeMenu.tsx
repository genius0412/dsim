import { useEffect, useState } from 'react';
import type { GameSettings } from '../game';
import type { DrivetrainType } from '../types';
import { APP_NAME, APP_TAGLINE, CURRENT_SEASON } from '../seasons';
import { fetchGlobalStats, type GlobalStats } from '../net/api';
import { RAIL_ITEMS } from './NavRail';
import type { ShellNav } from './AppShell';

const DRIVETRAIN_LABELS: Record<DrivetrainType, string> = {
  mecanum: 'Mecanum',
  tank: 'Tank',
  swerve: 'Swerve',
  xdrive: 'X-Drive',
};

/**
 * The main menu. The four top-level destinations sit CENTERED as chunky keycaps
 * — on every other screen the same four live in the left rail (`NavRail`), and
 * both read from `RAIL_ITEMS` so they can never drift apart.
 */
export function HomeMenu({
  settings,
  multiplayer,
  onNav,
}: {
  settings: GameSettings;
  /** the game server is configured — gates the live player counters */
  multiplayer: boolean;
  onNav: (n: ShellNav) => void;
}) {
  const spec = settings.spec;

  // site-wide counters (players + games played), when the server is configured
  const [stats, setStats] = useState<GlobalStats | null>(null);
  useEffect(() => {
    if (!multiplayer) return;
    let alive = true;
    fetchGlobalStats()
      .then((s) => alive && setStats(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [multiplayer]);

  return (
    <div className="ds-home">
      <p className="ds-eyebrow">
        {CURRENT_SEASON.fullName} · {APP_TAGLINE}
      </p>
      <h1 className="ds-home-title">{APP_NAME}</h1>

      <nav className="ds-menu" aria-label="Main">
        {RAIL_ITEMS.map((it, i) => (
          <button
            key={it.id}
            className={`ds-menu-btn${i === 0 ? ' primary' : ''}`}
            onClick={() => onNav(it.id)}
          >
            <span className="ml">{it.label}</span>
            <span className="mh">{it.hint}</span>
          </button>
        ))}
      </nav>

      <p className="ds-home-loadout">
        Driving <b>{spec.name}</b> · {DRIVETRAIN_LABELS[spec.drivetrain]} ·{' '}
        {spec.teamNumber ? `#${spec.teamNumber}` : 'no team'}
      </p>

      {stats && (
        <div className="ds-homestats">
          <div className="ds-stat">
            <span className="sv">{stats.users.toLocaleString()}</span>
            <span className="sl">Players</span>
          </div>
          <div className="ds-stat">
            <span className="sv">{stats.games.toLocaleString()}</span>
            <span className="sl">Games played</span>
          </div>
          <span className="ds-homestats-break">
            solo {stats.byCategory.solo} · duo {stats.byCategory.duo} · 1v1{' '}
            {stats.byCategory['1v1']} · 2v2 {stats.byCategory['2v2']}
          </span>
        </div>
      )}
    </div>
  );
}
