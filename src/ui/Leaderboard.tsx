import { useEffect, useState } from 'react';
import {
  fetchElo,
  fetchRecords,
  type Board,
  type EloMode,
  type EloRow,
  type RecordMode,
  type RecordRow,
} from '../net/api';
import { gameServerConfigured } from '../net/env';

type Kind = 'records' | 'ranked';

const BOARDS: { id: Board; label: string }[] = [
  { id: 'overall', label: 'Overall' },
  { id: 'mecanum', label: 'Mecanum' },
  { id: 'tank', label: 'Tank' },
  { id: 'swerve', label: 'Swerve' },
  { id: 'xdrive', label: 'X-Drive' },
];

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

  const configured = gameServerConfigured();

  useEffect(() => {
    if (!configured) {
      setStatus('error');
      setError('Leaderboards need the game server (set VITE_GAME_SERVER_URL).');
      return;
    }
    let alive = true;
    setStatus('loading');
    const req =
      kind === 'records'
        ? fetchRecords(recMode, board).then((r) => r.rows)
        : fetchElo(eloMode, board).then((r) => r.rows);
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
  }, [kind, recMode, eloMode, board, configured]);

  const isRecords = kind === 'records';
  const valueLabel = isRecords ? 'Score' : 'ELO';

  return (
    <>
      <p className="ds-eyebrow">Season 1 · balance v1</p>
      <h1 className="ds-h1">Leaderboards</h1>
      <p className="ds-sub">
        Record boards are solo/duo score-attack; ranked is head-to-head ELO. Both are split by
        drivetrain, plus an overall board. Every entry is a watchable replay.
      </p>

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
                {!isRecords && <th>Games</th>}
                <th style={{ textAlign: 'right' }}>{valueLabel}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const rec = r as RecordRow;
                const watchable = isRecords && !!rec.replayId && !!onWatch;
                return (
                  <tr
                    key={r.userId}
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
                    {!isRecords && <td>{(r as EloRow).games}</td>}
                    <td className="sc">
                      {isRecords ? rec.score : (r as EloRow).rating}
                      {watchable && <span className="ds-watch"> ▶</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
