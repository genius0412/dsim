import type { GameSettings } from '../game';
import type { DrivetrainType } from '../types';
import { APP_NAME, CURRENT_SEASON } from '../seasons';

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
  multiplayer,
  onFreeDrive,
  onSoloMatch,
  onRecordRun,
  onRanked,
  onCustomRoom,
  onEditRobot,
}: {
  settings: GameSettings;
  multiplayer: boolean;
  onFreeDrive: () => void;
  onSoloMatch: () => void;
  onRecordRun: () => void;
  onRanked: () => void;
  onCustomRoom: () => void;
  onEditRobot: () => void;
}) {
  const spec = settings.spec;
  return (
    <>
      <p className="ds-eyebrow">
        {APP_NAME} · {CURRENT_SEASON.fullName} · 2D Driver Sim
      </p>
      <h1 className="ds-h1">Ready to run.</h1>
      <p className="ds-sub">
        Practice free, run a full scored match, or scrim a custom room. Driving{' '}
        <b style={{ color: 'var(--ds-ink)' }}>{spec.name}</b> · {DRIVETRAIN_LABELS[spec.drivetrain]} ·{' '}
        {spec.teamNumber ? `#${spec.teamNumber}` : 'no team'}.{' '}
        <button className="ds-btn ghost" style={{ padding: '2px 8px', fontSize: 13 }} onClick={onEditRobot}>
          Edit robot →
        </button>
      </p>

      <div className="ds-grid-bg">
        <div className="ds-tiles">
          <button className="ds-tile primary" onClick={onSoloMatch}>
            <span className="k">Solo · Match</span>
            <span>
              <span className="t">Solo Match</span>
              <span className="d">30s auto · 2:00 teleop · full DECODE scoring</span>
            </span>
          </button>

          <button className="ds-tile" onClick={onFreeDrive}>
            <span className="k">Practice</span>
            <span>
              <span className="t">Free Drive</span>
              <span className="d">No clock, no stakes — just drive</span>
            </span>
          </button>

          <button className="ds-tile" onClick={onCustomRoom} disabled={!multiplayer}>
            <span className="k">Custom</span>
            <span>
              <span className="t">Custom Room</span>
              <span className="d">
                {multiplayer ? 'Invite by code · up to 2v2' : 'Needs the game server'}
              </span>
            </span>
          </button>

          <button className="ds-tile" onClick={onRecordRun} disabled={!multiplayer}>
            <span className="k">Records</span>
            <span>
              <span className="t">Record Run</span>
              <span className="d">
                {multiplayer ? 'Solo score-attack — sets a leaderboard time' : 'Needs the game server'}
              </span>
            </span>
          </button>

          <button className="ds-tile" onClick={onRanked} disabled={!multiplayer}>
            <span className="k">Ranked</span>
            <span>
              <span className="t">Find Match</span>
              <span className="d">
                {multiplayer ? '1v1 / 2v2 head-to-head ELO' : 'Needs the game server'}
              </span>
            </span>
          </button>
        </div>
      </div>
    </>
  );
}
