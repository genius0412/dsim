import { Fragment, useEffect, useState } from 'react';
import {
  fetchElo,
  fetchRecords,
  fetchSeasons,
  type Board,
  type EloMode,
  type EloRow,
  type RecordConfig,
  type RecordMode,
  type RecordRow,
  type SeasonInfo,
} from '../net/api';
import { gameServerConfigured } from '../net/env';
import type { DrivetrainType, IntakeStyle } from '../types';

type Kind = 'records' | 'ranked';

const BOARDS: { id: Board; label: string }[] = [
  { id: 'overall', label: 'Overall' },
  { id: 'mecanum', label: 'Mecanum' },
  { id: 'tank', label: 'Tank' },
  { id: 'swerve', label: 'Swerve' },
  { id: 'xdrive', label: 'X-Drive' },
];

const DT_LABEL: Record<DrivetrainType, string> = {
  mecanum: 'Mecanum',
  tank: 'Tank',
  swerve: 'Swerve',
  xdrive: 'X-drive',
};
const INTAKE_LABEL: Record<IntakeStyle, string> = {
  sloped: 'Sloped',
  vector: 'Vector',
  triangle: 'Triangle',
};

/** the robot config a record was set with — spec stats + assists */
function ConfigSummary({ cfg }: { cfg: RecordConfig }) {
  const { spec, assists } = cfg;
  const chip = (label: string, on: boolean) => (
    <span className={`ds-chip ${on ? 'on' : 'off'}`}>{label}</span>
  );
  return (
    <div className="lb-config">
      <div className="lb-config-name">
        {spec.name}
        {spec.teamNumber ? ` · #${spec.teamNumber}` : ''}
        {spec.teamName ? ` · ${spec.teamName}` : ''}
      </div>
      <div className="ds-stats">
        <div className="ds-stat"><span className="sv" style={{ fontSize: 14 }}>{DT_LABEL[spec.drivetrain]}</span><span className="sl">drivetrain</span></div>
        <div className="ds-stat"><span className="sv">{spec.massLb}</span><span className="sl">lb mass</span></div>
        <div className="ds-stat"><span className="sv">{spec.driveRpm}</span><span className="sl">drive rpm</span></div>
        <div className="ds-stat"><span className="sv" style={{ fontSize: 14 }}>{INTAKE_LABEL[spec.intake]}{spec.canSort ? ' +sort' : ''}</span><span className="sl">intake</span></div>
        <div className="ds-stat"><span className="sv">{spec.flywheelInertia.toFixed(2)}</span><span className="sl">flywheel</span></div>
        <div className="ds-stat"><span className="sv">{spec.length}×{spec.width}"</span><span className="sl">size</span></div>
      </div>
      <div className="lb-config-assists">
        {chip(assists.fieldCentric ? 'Field-centric' : 'Robot-centric', true)}
        {chip('Aim assist', assists.aimAssist)}
        {chip('Auto intake', assists.autoIntake)}
        {chip('Auto fire', assists.autoFire)}
      </div>
    </div>
  );
}

/**
 * Ranked + record leaderboards. Segmented by board type (records / ranked),
 * mode, and drivetrain, read live from the server's public API. Empty and error
 * states are first-class (the boards start empty and fill as matches are played).
 */
export function Leaderboard({ onWatch }: { onWatch?: (replayId: string) => void }) {
  const [kind, setKind] = useState<Kind>('records');
  const [recMode, setRecMode] = useState<RecordMode>('solo');
  const [eloMode, setEloMode] = useState<EloMode>('1v1');
  const [board, setBoard] = useState<Board>('overall');

  const [rows, setRows] = useState<(RecordRow | EloRow)[]>([]);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [error, setError] = useState('');
  const [openRow, setOpenRow] = useState<string | null>(null);

  // seasons: null selection = the live season (server default)
  const [seasons, setSeasons] = useState<SeasonInfo[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [season, setSeason] = useState<number | null>(null);

  const configured = gameServerConfigured();

  useEffect(() => {
    if (!configured) return;
    let alive = true;
    fetchSeasons()
      .then((r) => {
        if (!alive) return;
        setSeasons(r.seasons);
        setCurrent(r.current);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [configured]);

  useEffect(() => {
    if (!configured) {
      setStatus('error');
      setError('Leaderboards need the game server (set VITE_GAME_SERVER_URL).');
      return;
    }
    let alive = true;
    setStatus('loading');
    const s = season ?? undefined;
    const req =
      kind === 'records'
        ? fetchRecords(recMode, board, s).then((r) => r.rows)
        : fetchElo(eloMode, board, s).then((r) => r.rows);
    req
      .then((rows) => {
        if (!alive) return;
        setRows(rows);
        setStatus('ok');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
    return () => {
      alive = false;
    };
  }, [kind, recMode, eloMode, board, season, configured]);

  const isRecords = kind === 'records';
  const valueLabel = isRecords ? 'Score' : 'ELO';
  const viewing = season ?? current;
  const viewingSeason = seasons.find((s) => s.season === viewing);
  const seasonLabel = viewingSeason?.name ?? (viewing != null ? `Season ${viewing}` : 'Current season');
  const isArchived = viewing != null && current != null && viewing < current;

  return (
    <>
      <p className="ds-eyebrow">
        {seasonLabel}
        {isArchived ? ' · archived' : ''}
      </p>
      <h1 className="ds-h1">Leaderboards</h1>
      <p className="ds-sub">Score-attack records and ranked ELO, split by drivetrain. Every entry is a replay.</p>

      {seasons.length > 1 && (
        <div className="ds-panel-h" style={{ marginBottom: 8 }}>
          <span className="ds-panel-title">Season</span>
          <select
            className="ds-select"
            value={viewing ?? ''}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSeason(current != null && v === current ? null : v);
            }}
          >
            {seasons.map((s) => (
              <option key={s.season} value={s.season}>
                {s.name}
                {s.season === current ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="ds-panel">
        <div className="ds-panel-h">
          <div className="ds-segs">
            <button className={`ds-seg ${isRecords ? 'on' : ''}`} onClick={() => setKind('records')}>
              Records
            </button>
            <button className={`ds-seg ${!isRecords ? 'on' : ''}`} onClick={() => setKind('ranked')}>
              Ranked
            </button>
          </div>
          <div className="ds-segs">
            {isRecords ? (
              <>
                <button className={`ds-seg ${recMode === 'solo' ? 'on' : ''}`} onClick={() => setRecMode('solo')}>
                  Solo
                </button>
                <button className={`ds-seg ${recMode === 'duo' ? 'on' : ''}`} onClick={() => setRecMode('duo')}>
                  Duo
                </button>
              </>
            ) : (
              <>
                <button className={`ds-seg ${eloMode === '1v1' ? 'on' : ''}`} onClick={() => setEloMode('1v1')}>
                  1v1
                </button>
                <button className={`ds-seg ${eloMode === '2v2' ? 'on' : ''}`} onClick={() => setEloMode('2v2')}>
                  2v2
                </button>
              </>
            )}
          </div>
        </div>

        <div className="ds-panel-h">
          <span className="ds-panel-title">Drivetrain</span>
          <div className="ds-segs">
            {BOARDS.map((b) => (
              <button key={b.id} className={`ds-seg ${board === b.id ? 'on' : ''}`} onClick={() => setBoard(b.id)}>
                {b.label}
              </button>
            ))}
          </div>
        </div>

        {status === 'loading' && <div className="ds-loading">Loading…</div>}
        {status === 'error' && (
          <div className="ds-empty">
            <div className="big">Couldn’t load the board</div>
            {error}
          </div>
        )}
        {status === 'ok' && rows.length === 0 && (
          <div className="ds-empty">
            <div className="big">No entries yet</div>
            Be the first to set a time on this board.
          </div>
        )}
        {status === 'ok' && rows.length > 0 && (
          <table className="ds-table">
            <thead>
              <tr>
                <th className="rk">#</th>
                <th>Driver</th>
                {isRecords && <th>Robot</th>}
                {!isRecords && <th>Games</th>}
                <th style={{ textAlign: 'right' }}>{valueLabel}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const rec = r as RecordRow;
                const watchable = isRecords && !!rec.replayId && !!onWatch;
                const cfg = isRecords ? rec.config : null;
                const isOpen = openRow === r.userId;
                return (
                  <Fragment key={r.userId}>
                    <tr
                      className={watchable ? 'ds-clickable' : ''}
                      onClick={watchable ? () => onWatch!(rec.replayId!) : undefined}
                      title={watchable ? 'Watch replay' : undefined}
                    >
                      <td className="rk">{i + 1}</td>
                      <td>
                        {r.handle}
                        {isRecords && rec.partnerId && (
                          <span className="ds-dt" style={{ marginLeft: 8 }}>DUO</span>
                        )}
                      </td>
                      {isRecords && (
                        <td>
                          {cfg ? (
                            <button
                              className="lb-robot"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenRow(isOpen ? null : r.userId);
                              }}
                              title="View robot"
                            >
                              {DT_LABEL[cfg.spec.drivetrain]}
                              <span className="tw">{isOpen ? '▴' : '▾'}</span>
                            </button>
                          ) : (
                            <span style={{ color: 'var(--ds-mut)' }}>—</span>
                          )}
                        </td>
                      )}
                      {!isRecords && <td>{(r as EloRow).games}</td>}
                      <td className="sc">
                        {isRecords ? rec.score : (r as EloRow).rating}
                        {watchable && <span className="ds-watch"> ▶</span>}
                      </td>
                    </tr>
                    {isRecords && isOpen && cfg && (
                      <tr className="lb-detail">
                        <td colSpan={4}>
                          <ConfigSummary cfg={cfg} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
