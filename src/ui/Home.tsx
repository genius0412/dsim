import { useEffect, useState } from 'react';
import type { GameSettings } from '../game';
import type { DrivetrainType } from '../types';
import { APP_NAME, CURRENT_SEASON } from '../seasons';
import { MatchSetup } from './MatchSetup';
import { fetchGlobalStats, type GlobalStats } from '../net/api';

const DRIVETRAIN_LABELS: Record<DrivetrainType, string> = {
  mecanum: 'Mecanum',
  tank: 'Tank',
  swerve: 'Swerve',
  xdrive: 'X-Drive',
};

/**
 * Home / landing. Play tiles for the ways to start; the current loadout summary
 * up top. Ranked is disabled until auth + a game server land (Phase 3 remainder).
 */
export function Home({
  settings,
  onChange,
  multiplayer,
  signedIn,
  activeGame,
  onRejoin,
  onFreeDrive,
  onSoloMatch,
  onRecordRun,
  onDuoRecord,
  onRanked,
  onCustomRoom,
  onEditRobot,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
  multiplayer: boolean;
  signedIn: boolean;
  /** a multiplayer game this browser is mid-way through (offer to rejoin it), or null */
  activeGame: { kind: 'ranked' | 'custom' | 'record' } | null;
  onRejoin: () => void;
  onFreeDrive: () => void;
  onSoloMatch: () => void;
  onRecordRun: () => void;
  onDuoRecord: () => void;
  onRanked: () => void;
  onCustomRoom: () => void;
  onEditRobot: () => void;
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
    <>
      <p className="ds-eyebrow">
        {APP_NAME} · {CURRENT_SEASON.fullName} · 2D Driver Sim
      </p>
      <h1 className="ds-h1">Ready to run.</h1>
      <p className="ds-sub">
        Driving <b style={{ color: 'var(--ds-ink)' }}>{spec.name}</b> ·{' '}
        {DRIVETRAIN_LABELS[spec.drivetrain]} ·{' '}
        {spec.teamNumber ? `#${spec.teamNumber}` : 'no team'}.{' '}
        <button className="ds-btn ghost" style={{ padding: '2px 8px', fontSize: 13 }} onClick={onEditRobot}>
          Edit robot →
        </button>
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
            solo {stats.byCategory.solo} · duo {stats.byCategory.duo} · 1v1 {stats.byCategory['1v1']} ·
            2v2 {stats.byCategory['2v2']}
          </span>
        </div>
      )}

      {activeGame && (
        <div className="ds-rejoin" role="alert">
          <div className="ds-rejoin-txt">
            <b>You have a game in progress.</b>{' '}
            <span className="ds-sub" style={{ fontSize: 13 }}>
              {activeGame.kind === 'ranked'
                ? 'A ranked match is waiting — hop back in.'
                : activeGame.kind === 'record'
                  ? 'Your record run is still going.'
                  : 'Your match is still going.'}
            </span>
          </div>
          <button className="ds-btn primary" onClick={onRejoin}>
            Rejoin match →
          </button>
        </div>
      )}

      <div className="ds-grid-bg">
        {/* Offline, always available — the safe default (Solo Practice is primary) */}
        <section className="ds-tileset">
          <p className="ds-tileset-label">Practice · offline</p>
          <div className="ds-tiles">
            <button className="ds-tile primary" onClick={onSoloMatch}>
              <span className="k">Solo</span>
              <span>
                <span className="t">Solo Practice</span>
                <span className="d">Full match · 30s auto · 2:00 teleop</span>
              </span>
            </button>

            <button className="ds-tile" onClick={onFreeDrive}>
              <span className="k">Practice</span>
              <span>
                <span className="t">Free Drive</span>
                <span className="d">No clock — just drive</span>
              </span>
            </button>
          </div>
        </section>

        {/* Online — ranked + score-attack records (need the game server / sign-in) */}
        <section className="ds-tileset">
          <p className="ds-tileset-label">Compete · online</p>
          <div className="ds-tiles">
            <button className="ds-tile" onClick={onRanked} disabled={!multiplayer || !signedIn}>
              <span className="k">Ranked</span>
              <span>
                <span className="t">Find Match</span>
                <span className="d">
                  {!multiplayer
                    ? 'Needs the game server'
                    : !signedIn
                      ? 'Sign in to play ranked'
                      : '1v1 / 2v2 ranked'}
                </span>
              </span>
            </button>

            <button className="ds-tile" onClick={onRecordRun} disabled={!multiplayer}>
              <span className="k">Records</span>
              <span>
                <span className="t">Record Run</span>
                <span className="d">
                  {multiplayer ? 'Solo score-attack' : 'Needs the game server'}
                </span>
              </span>
            </button>

            <button className="ds-tile" onClick={onDuoRecord} disabled={!multiplayer}>
              <span className="k">Records</span>
              <span>
                <span className="t">Duo Record</span>
                <span className="d">
                  {multiplayer ? '2v0 co-op · invite by code' : 'Needs the game server'}
                </span>
              </span>
            </button>
          </div>
        </section>

        {/* Custom room — last, per its niche use */}
        <section className="ds-tileset">
          <p className="ds-tileset-label">Custom</p>
          <div className="ds-tiles">
            <button className="ds-tile" onClick={onCustomRoom} disabled={!multiplayer}>
              <span className="k">Custom</span>
              <span>
                <span className="t">Custom Room</span>
                <span className="d">
                  {multiplayer ? 'Invite by code · up to 2v2' : 'Needs the game server'}
                </span>
              </span>
            </button>
          </div>
        </section>
      </div>

      <div style={{ marginTop: 24 }}>
        <MatchSetup settings={settings} onChange={onChange} />
      </div>
    </>
  );
}
