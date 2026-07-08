import { useState } from 'react';
import { adminAnnounce, adminCancelNotice, adminPurgeReplays, adminStartSeason } from '../net/api';

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
    </div>
  );
}
