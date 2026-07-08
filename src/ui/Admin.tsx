import { useState } from 'react';
import {
  adminAnnounce,
  adminCancelNotice,
  adminPurgeReplays,
  adminStartSeason,
  adminFetchRecords,
  adminDeleteRecord,
  adminClearUserRecords,
  adminSearchUsers,
  adminRenameUser,
  type AdminRecordRow,
} from '../net/api';

type RecMode = 'solo' | 'duo';
const DRIVETRAINS = ['overall', 'mecanum', 'tank', 'swerve', 'xdrive'] as const;

/** admin console — only reachable by the account(s) in the server's ADMIN_USER_IDS.
 * Broadcasts a scheduled-restart countdown to every connected player; then you
 * deploy when it reaches 0. Also manages competitive SEASONS. */
export function Admin() {
  const [minutes, setMinutes] = useState(5);
  const [message, setMessage] = useState('Scheduled server update');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [seasonName, setSeasonName] = useState('');
  const [seasonStatus, setSeasonStatus] = useState<string | null>(null);
  const [seasonBusy, setSeasonBusy] = useState(false);

  // moderation — leaderboard records
  const [recMode, setRecMode] = useState<RecMode>('solo');
  const [recDt, setRecDt] = useState<string>('overall');
  const [records, setRecords] = useState<AdminRecordRow[]>([]);
  const [recStatus, setRecStatus] = useState<string | null>(null);
  const [recBusy, setRecBusy] = useState(false);

  // moderation — user display names
  const [userQuery, setUserQuery] = useState('');
  const [users, setUsers] = useState<{ userId: string; handle: string }[]>([]);
  const [rename, setRename] = useState<Record<string, string>>({});
  const [userStatus, setUserStatus] = useState<string | null>(null);
  const [userBusy, setUserBusy] = useState(false);

  const loadRecords = async (): Promise<void> => {
    setRecBusy(true);
    const rows = await adminFetchRecords(recMode, recDt);
    setRecBusy(false);
    setRecords(rows);
    setRecStatus(rows.length ? `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}.` : 'No records in this bucket (or not signed in as admin).');
  };

  const deleteRecord = async (row: AdminRecordRow): Promise<void> => {
    if (!window.confirm(`Delete ${row.handle}'s ${row.score}-pt ${row.drivetrain} run? This removes the run + its replay and cannot be undone.`)) return;
    setRecBusy(true);
    const ok = await adminDeleteRecord(row.recordId);
    setRecBusy(false);
    if (ok) setRecords((rs) => rs.filter((r) => r.recordId !== row.recordId));
    setRecStatus(ok ? `Deleted ${row.handle}'s run.` : 'Failed — check admin sign-in.');
  };

  const clearUser = async (row: AdminRecordRow): Promise<void> => {
    if (!window.confirm(`Delete ALL of ${row.handle}'s record runs (every mode/drivetrain)? For a confirmed cheater. Cannot be undone.`)) return;
    setRecBusy(true);
    const removed = await adminClearUserRecords(row.userId);
    setRecBusy(false);
    if (removed != null) setRecords((rs) => rs.filter((r) => r.userId !== row.userId));
    setRecStatus(removed != null ? `Cleared ${removed} run${removed === 1 ? '' : 's'} by ${row.handle}.` : 'Failed — check admin sign-in.');
  };

  const searchUsers = async (): Promise<void> => {
    setUserBusy(true);
    const found = await adminSearchUsers(userQuery);
    setUserBusy(false);
    setUsers(found);
    setRename(Object.fromEntries(found.map((u) => [u.userId, u.handle])));
    setUserStatus(found.length ? `${found.length} match${found.length === 1 ? '' : 'es'}.` : 'No matches (or not signed in as admin).');
  };

  const renameUser = async (userId: string, current: string): Promise<void> => {
    const next = (rename[userId] ?? '').trim();
    if (next === current) return;
    if (next.length < 2 || next.length > 24) {
      setUserStatus('Name must be 2–24 characters.');
      return;
    }
    if (!window.confirm(`Rename "${current}" to "${next}"?`)) return;
    setUserBusy(true);
    const saved = await adminRenameUser(userId, next);
    setUserBusy(false);
    if (saved) setUsers((us) => us.map((u) => (u.userId === userId ? { ...u, handle: saved } : u)));
    setUserStatus(saved ? `Renamed to "${saved}".` : 'Failed — check admin sign-in.');
  };

  const run = async (fn: () => Promise<boolean>, okMsg: string): Promise<void> => {
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    setStatus(ok ? okMsg : 'Failed — are you still signed in as an admin?');
  };

  const startSeason = async (): Promise<void> => {
    if (!window.confirm('Archive the live leaderboards and start a fresh season? Old boards stay viewable.')) return;
    setSeasonBusy(true);
    const season = await adminStartSeason(seasonName);
    setSeasonBusy(false);
    setSeasonStatus(
      season != null
        ? `Started Season ${season}. New runs now score onto it; older seasons are archived but still viewable.`
        : 'Failed — are you still signed in as an admin (and is the DB configured)?',
    );
  };

  const purgeReplays = async (): Promise<void> => {
    if (!window.confirm('Delete the replays of every ARCHIVED season? Boards stay; those runs just stop being watchable. This frees storage and cannot be undone.')) return;
    setSeasonBusy(true);
    const freed = await adminPurgeReplays();
    setSeasonBusy(false);
    setSeasonStatus(
      freed != null ? `Purged ${freed} archived-season replay${freed === 1 ? '' : 's'}.` : 'Failed — check admin sign-in / DB.',
    );
  };

  return (
    <div className="ds-section" style={{ maxWidth: 520 }}>
      <p className="ds-eyebrow">Admin</p>
      <h1 className="ds-h1">Server controls</h1>
      <p className="ds-sub" style={{ margin: '0 0 20px' }}>
        Announce a restart to every connected player with a live countdown, then deploy the
        server when it hits zero. Players see a banner; anyone already playing gets warned.
      </p>

      <div className="admin-card">
        <label className="admin-field">
          <span>Restart in</span>
          <input
            type="number"
            min={0}
            max={60}
            value={minutes}
            onChange={(e) => setMinutes(Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
          />
          <span>minutes</span>
        </label>
        <label className="admin-field col">
          <span>Message</span>
          <input type="text" value={message} maxLength={90} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <div className="admin-buttons">
          <button
            className="ds-btn"
            disabled={busy}
            onClick={() => run(() => adminAnnounce(minutes * 60, message), `Announced — restart in ${minutes} min.`)}
          >
            ANNOUNCE RESTART
          </button>
          <button
            className="ds-btn ghost"
            disabled={busy}
            onClick={() => run(() => adminCancelNotice(), 'Notice cleared.')}
          >
            CANCEL NOTICE
          </button>
        </div>
        {status && <p className="ds-hint" style={{ marginTop: 12 }}>{status}</p>}
      </div>
      <p className="ds-hint" style={{ marginTop: 16 }}>
        Reminder: this only warns players — it doesn’t restart the server. Run your deploy when
        the countdown reaches 0.
      </p>

      <h2 className="ds-h2" style={{ marginTop: 32 }}>Seasons</h2>
      <p className="ds-sub" style={{ margin: '0 0 20px' }}>
        Start a fresh competitive season (records + ranked ELO). Past seasons stay fully viewable
        in the leaderboard’s season picker; only new runs score onto the live one.
      </p>
      <div className="admin-card">
        <label className="admin-field col">
          <span>New season name (optional)</span>
          <input
            type="text"
            value={seasonName}
            maxLength={40}
            placeholder="e.g. Season 2 — Spring"
            onChange={(e) => setSeasonName(e.target.value)}
          />
        </label>
        <div className="admin-buttons">
          <button className="ds-btn" disabled={seasonBusy} onClick={startSeason}>
            START NEW SEASON
          </button>
          <button className="ds-btn ghost" disabled={seasonBusy} onClick={purgeReplays}>
            PURGE ARCHIVED REPLAYS
          </button>
        </div>
        {seasonStatus && <p className="ds-hint" style={{ marginTop: 12 }}>{seasonStatus}</p>}
      </div>

      <h2 className="ds-h2" style={{ marginTop: 32 }}>Moderation — records</h2>
      <p className="ds-sub" style={{ margin: '0 0 20px' }}>
        Inspect a leaderboard bucket (live season) and remove cheated or invalid runs. Deleting a
        run also deletes its replay. “Clear all” wipes every run by that player — for confirmed
        cheaters.
      </p>
      <div className="admin-card">
        <div className="admin-field">
          <span>Board</span>
          <select value={recMode} onChange={(e) => setRecMode(e.target.value as RecMode)}>
            <option value="solo">Solo</option>
            <option value="duo">Duo</option>
          </select>
          <select value={recDt} onChange={(e) => setRecDt(e.target.value)}>
            {DRIVETRAINS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <button className="ds-btn" disabled={recBusy} onClick={loadRecords}>
            LOAD
          </button>
        </div>
        {records.length > 0 && (
          <div className="admin-list" style={{ marginTop: 12 }}>
            {records.map((r, i) => (
              <div key={r.recordId} className="admin-row">
                <span className="admin-rank">{i + 1}</span>
                <span className="admin-grow">
                  <strong>{r.handle}</strong> · {r.score} pts · {r.drivetrain}
                  <span className="ds-hint"> · {new Date(r.createdAt).toLocaleDateString()}</span>
                </span>
                <button className="ds-btn ghost sm" disabled={recBusy} onClick={() => deleteRecord(r)}>
                  DELETE
                </button>
                <button className="ds-btn ghost sm danger" disabled={recBusy} onClick={() => clearUser(r)}>
                  CLEAR ALL
                </button>
              </div>
            ))}
          </div>
        )}
        {recStatus && <p className="ds-hint" style={{ marginTop: 12 }}>{recStatus}</p>}
      </div>

      <h2 className="ds-h2" style={{ marginTop: 32 }}>Moderation — display names</h2>
      <p className="ds-sub" style={{ margin: '0 0 20px' }}>
        Find a player by display name (or exact user id) and force an inappropriate name to
        something clean. The change is immediate across the leaderboards.
      </p>
      <div className="admin-card">
        <div className="admin-field">
          <span>Search</span>
          <input
            type="text"
            value={userQuery}
            placeholder="name or user id"
            onChange={(e) => setUserQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && searchUsers()}
          />
          <button className="ds-btn" disabled={userBusy} onClick={searchUsers}>
            SEARCH
          </button>
        </div>
        {users.length > 0 && (
          <div className="admin-list" style={{ marginTop: 12 }}>
            {users.map((u) => (
              <div key={u.userId} className="admin-row">
                <input
                  type="text"
                  className="admin-grow"
                  maxLength={24}
                  value={rename[u.userId] ?? ''}
                  onChange={(e) => setRename((m) => ({ ...m, [u.userId]: e.target.value }))}
                />
                <button
                  className="ds-btn ghost sm"
                  disabled={userBusy || (rename[u.userId] ?? '').trim() === u.handle}
                  onClick={() => renameUser(u.userId, u.handle)}
                >
                  RENAME
                </button>
              </div>
            ))}
          </div>
        )}
        {userStatus && <p className="ds-hint" style={{ marginTop: 12 }}>{userStatus}</p>}
      </div>
    </div>
  );
}
