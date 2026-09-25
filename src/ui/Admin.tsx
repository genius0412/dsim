import { lazy, useCallback, useEffect, useState } from 'react';
import { LoadBoundary } from './LoadBoundary';
import {
  adminAnnounce,
  adminCancelNotice,
  adminPurgeReplays,
  adminStartSeason,
  adminFetchRecords,
  adminDeleteRecord,
  adminClearUserRecords,
  adminSearchUsers,
  type AdminUserRow,
  adminPublishAnnouncement,
  adminDeleteAnnouncement,
  fetchAnnouncements,
  fetchSeasons,
  type AdminRecordRow,
  type Announcement,
  type AnnouncementKind,
} from '../net/api';
import { KindBadge } from './Announcements';
import { Markdown } from './markdown';
import { SEASONS } from '../seasons';
import type { GameId } from '../types';
import { AdminLive } from './AdminLive';
import { AdminReports, type WatchReplay } from './AdminReports';
import { AdminAudit } from './AdminAudit';
import { AdminUser } from './AdminUser';
import { adminFail } from './adminCopy';
import { AccountName, When, confirmed, downloadCsv } from './adminBits';

const AdminAnalytics = lazy(() => import('./AdminAnalytics').then((m) => ({ default: m.AdminAnalytics })));

type AdminTab = 'live' | 'users' | 'moderation' | 'content' | 'server' | 'audit' | 'analytics';
/* ⚠️ APPEND, DO NOT REORDER. The tab order is the order of an incident: Live is what you
   open when something is happening, Users is where you land from every name on the page,
   and the deliberate, unhurried jobs follow. Audit sits last because it is read after the
   fact. A new tab goes on the end. */
const TABS: { id: AdminTab; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'users', label: 'Users' },
  { id: 'moderation', label: 'Moderation' },
  { id: 'content', label: 'Content' },
  { id: 'server', label: 'Server' },
  { id: 'audit', label: 'Audit' },
  { id: 'analytics', label: 'Analytics' },
];
const TAB_IDS = new Set<string>(TABS.map((t) => t.id));

/**
 * THE CONSOLE'S OWN URL STATE, IN THE HASH.
 *
 * `#tab=moderation&user=<id>` — so a tab and an open account survive a refresh, go Back
 * correctly, and above all can be PASTED to another moderator. "Look at this person" was a
 * uuid in a message and an instruction to go and paste it into a search box.
 *
 * The HASH specifically, not the path: `src/ui/App.tsx` owns routing, canonicalizes the
 * address bar on mount and compares `pathname + search` when it does. A query string here
 * would be stripped on the next canonicalize and a path segment would need a route parser
 * this component does not own. The hash is ignored by all of it.
 */
function readHash(): { tab: AdminTab; user: string | null } {
  const p = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const t = p.get('tab');
  return { tab: TAB_IDS.has(t ?? '') ? (t as AdminTab) : 'live', user: p.get('user') };
}
function writeHash(tab: AdminTab, user: string | null): void {
  const p = new URLSearchParams();
  p.set('tab', tab);
  if (user) p.set('user', user);
  const next = `#${p.toString()}`;
  if (window.location.hash !== next) window.history.replaceState(null, '', next);
}

/** the console's title + tab bar. Split out so the Live tab (which renders a very
 *  different body) shares exactly the same chrome instead of a near-copy of it. */
function AdminHeader({ tab, setTab }: { tab: AdminTab; setTab: (t: AdminTab) => void }) {
  return (
    <>
      {/* "Control Panel" is a deliberate title-case exception (user request) to the
          house sentence-case rule for headings. */}
      <h1 className="ds-h1">Control Panel</h1>
      {/* Visual style matches Records' .ds-tabs/.ds-tab; role/aria-selected stay
          (unlike Records' nav+aria-current) because these tabs switch content
          in place with no URL change — the real ARIA-tablist case. */}
      <div className="ds-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`ds-tab${tab === t.id ? ' on' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </>
  );
}

type RecMode = 'solo' | 'duo';
const DRIVETRAINS = ['overall', 'mecanum', 'tank', 'swerve', 'xdrive', 'butterfly'] as const;
const ANN_KINDS: { value: AnnouncementKind; label: string }[] = [
  { value: 'patch', label: 'Patch notes / bug fixes' },
  { value: 'season', label: 'New season (cinematic)' },
  { value: 'act', label: 'New act (cinematic)' },
];

/** admin console — only reachable by the account(s) in the server's ADMIN_USER_IDS.
 * Broadcasts a scheduled-restart countdown to every connected player; then you
 * deploy when it reaches 0. Also manages competitive SEASONS. */
export function Admin({
  onWatch,
  onWatchReplay,
}: {
  /** spectate a live room (hidden — an admin watcher is not counted) */
  onWatch?: (room: string, region?: string) => void;
  /** open a finished game's replay — with the MATCH it belongs to, when that is known, so a
   *  moderator can correct what it scored while watching it */
  onWatchReplay?: WatchReplay;
}) {
  // LIVE first: it is the tab you open during an incident, and the panel's other
  // jobs are all deliberate, unhurried ones you go looking for. Both this and the open
  // account are seeded from the hash, so a pasted link lands where it says it does.
  const [tab, setTabState] = useState<AdminTab>(() => readHash().tab);
  const [openUser, setOpenUser] = useState<string | null>(() => readHash().user);
  const setTab = useCallback((t: AdminTab): void => {
    setTabState(t);
    // LEAVING the Users tab closes the account with it. Keeping it open would mean coming
    // back to Users later and finding somebody you looked at an hour ago already loaded,
    // which reads as the panel having decided who you are moderating.
    setOpenUser((cur) => (t === 'users' ? cur : null));
  }, []);
  /** every name in the console routes through here — the Live table, the report queue, the
   *  audit log — so "open this person" means the same thing from all three */
  const openAccount = useCallback((userId: string): void => {
    setTabState('users');
    setOpenUser(userId);
  }, []);
  useEffect(() => {
    writeHash(tab, openUser);
  }, [tab, openUser]);
  // A LINK PASTED INTO AN ALREADY-OPEN CONSOLE. `writeHash` uses `replaceState`, which fires
  // nothing, so this only ever hears a hash the PERSON changed — pasting a colleague's
  // `#tab=users&user=…` into the address bar of a tab that is already on /admin. Without it
  // the URL changes and the page does not, which reads as the link being broken.
  useEffect(() => {
    const onHash = (): void => {
      const h = readHash();
      setTabState(h.tab);
      setOpenUser(h.user);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const [minutes, setMinutes] = useState(5);
  const [message, setMessage] = useState('Scheduled server update');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [seasonName, setSeasonName] = useState('');
  const [seasonStatus, setSeasonStatus] = useState<string | null>(null);
  const [seasonBusy, setSeasonBusy] = useState(false);

  // moderation — leaderboard records
  const [recGame, setRecGame] = useState<GameId>('decode');
  const [recMode, setRecMode] = useState<RecMode>('solo');
  const [recDt, setRecDt] = useState<string>('overall');
  const [records, setRecords] = useState<AdminRecordRow[]>([]);
  const [recStatus, setRecStatus] = useState<string | null>(null);
  const [recBusy, setRecBusy] = useState(false);

  // announcements — patch notes / new-season + new-act reveals
  const [annKind, setAnnKind] = useState<AnnouncementKind>('patch');
  const [annTitle, setAnnTitle] = useState('');
  const [annTagline, setAnnTagline] = useState('');
  const [annBody, setAnnBody] = useState('');
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [annStatus, setAnnStatus] = useState<string | null>(null);
  const [annBusy, setAnnBusy] = useState(false);

  // USERS — the search that feeds the detail panel. It used to be six controls per row
  // (rename, months, grant, revoke, history, standing) stacked in the Moderation tab, which
  // is how a search result ended up being the place every account action lived. The row is
  // now a result; the actions are on the account.
  const [userQuery, setUserQuery] = useState('');
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [userMore, setUserMore] = useState(false);
  const [userStatus, setUserStatus] = useState<string | null>(null);
  const [userBusy, setUserBusy] = useState(false);

  const loadRecords = async (): Promise<void> => {
    setRecBusy(true);
    const rows = await adminFetchRecords(recMode, recDt, recGame);
    setRecBusy(false);
    setRecords(rows);
    const gameName = SEASONS.find((s) => s.key === recGame)?.name ?? recGame;
    setRecStatus(rows.length ? `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} · ${gameName}.` : 'No records in this bucket. If you expected some, check that you are still signed in as an admin.');
  };

  const deleteRecord = async (row: AdminRecordRow): Promise<void> => {
    if (
      !confirmed(
        'Delete the',
        `${row.score}-pt ${row.drivetrain} run by ${row.handle}`,
        'The run and its replay go. This cannot be undone.',
      )
    )
      return;
    setRecBusy(true);
    const ok = await adminDeleteRecord(row.recordId);
    setRecBusy(false);
    if (ok) setRecords((rs) => rs.filter((r) => r.recordId !== row.recordId));
    setRecStatus(ok ? `Deleted ${row.handle}’s run.` : adminFail('delete the run'));
  };

  const clearUser = async (row: AdminRecordRow): Promise<void> => {
    if (
      !confirmed(
        'Delete every record run by',
        row.handle,
        'Every mode and drivetrain, plus their replays. For a confirmed cheater. This cannot be undone.',
      )
    )
      return;
    setRecBusy(true);
    const removed = await adminClearUserRecords(row.userId);
    setRecBusy(false);
    if (removed != null) setRecords((rs) => rs.filter((r) => r.userId !== row.userId));
    setRecStatus(
      removed != null
        ? `Cleared ${removed} run${removed === 1 ? '' : 's'} by ${row.handle}.`
        : adminFail('clear the runs'),
    );
  };

  /**
   * FIND AN ACCOUNT. Paged — a common display name matched more people than one page holds
   * and the box silently showed the first 25 as though they were everybody, which for a
   * moderation search is not a cosmetic limit but the wrong answer to "is this account here".
   */
  const searchUsers = async (next = 0): Promise<void> => {
    const query = userQuery.trim();
    if (!query) return;
    setUserBusy(true);
    const found = await adminSearchUsers(query, { limit: 25, offset: next });
    setUserBusy(false);
    setUsers((cur) => (next > 0 ? [...cur, ...found.users] : found.users));
    setUserMore(found.more);
    const total = next + found.users.length;
    setUserStatus(
      total
        ? `${total} match${total === 1 ? '' : 'es'}${found.more ? ', more available' : ''}.`
        : 'No matches. If you expected some, check that you are still signed in as an admin.',
    );
  };

  const run = async (fn: () => Promise<boolean>, okMsg: string): Promise<void> => {
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    setStatus(ok ? okMsg : adminFail('apply that change'));
  };

  const startSeason = async (newAct: boolean): Promise<void> => {
    const what = newAct ? 'ACT' : 'season';
    // NAME THE PERIOD THIS CREATES, so the moderator is not confirming blind: the next
    // Act/Season number off the live one, plus the custom title if one was typed. If the
    // season list will not load, the sentence still carries the title and the kind.
    const title = seasonName.trim();
    const list = await fetchSeasons().catch(() => null);
    const live = list?.seasons.find((s) => s.season === list.current);
    const target = live
      ? `Act ${newAct ? live.act + 1 : live.act} · Season ${newAct ? 1 : live.seasonNo + 1}` +
        (title ? ` “${title}”` : '')
      : `a fresh ${what.toLowerCase()}${title ? ` “${title}”` : ''}`;
    if (
      !confirmed(
        'Start',
        target,
        'The live leaderboards are archived; old boards stay viewable.' +
          (newAct ? ' A new act resets the season count to 1.' : ''),
      )
    )
      return;
    setSeasonBusy(true);
    const season = await adminStartSeason(seasonName, { newAct });
    setSeasonBusy(false);
    setSeasonStatus(
      season != null
        ? `Started a new ${what}. New runs now score onto it; older periods are archived but still viewable.`
        : adminFail(`start the new ${what.toLowerCase()}`),
    );
  };

  const purgeReplays = async (): Promise<void> => {
    if (
      !confirmed(
        'Delete the replays of',
        'every ARCHIVED season',
        'Boards stay; those runs stop being watchable. This frees storage and cannot be undone.',
      )
    )
      return;
    setSeasonBusy(true);
    const freed = await adminPurgeReplays();
    setSeasonBusy(false);
    setSeasonStatus(
      freed != null
        ? `Purged ${freed} archived-season replay${freed === 1 ? '' : 's'}.`
        : adminFail('purge the replays'),
    );
  };

  const loadAnnouncements = async (): Promise<void> => {
    const rows = await fetchAnnouncements(50);
    setAnnouncements(rows);
  };
  // pull the current feed once so the admin sees what's live + can retire old ones
  useEffect(() => {
    void loadAnnouncements();
  }, []);

  const publishAnnouncement = async (): Promise<void> => {
    const title = annTitle.trim();
    if (title.length < 2) {
      setAnnStatus('Give it a title (2+ characters).');
      return;
    }
    setAnnBusy(true);
    const created = await adminPublishAnnouncement({
      kind: annKind,
      title,
      body: annBody,
      tagline: annTagline.trim() || undefined,
    });
    setAnnBusy(false);
    if (created) {
      setAnnouncements((rows) => [created, ...rows]);
      setAnnTitle('');
      setAnnTagline('');
      setAnnBody('');
      setAnnStatus(`Published. Players see it on their next load. ${created.kind === 'patch' ? '' : 'It plays a cinematic reveal.'}`);
    } else {
      setAnnStatus(adminFail('publish the announcement'));
    }
  };

  const retireAnnouncement = async (a: Announcement): Promise<void> => {
    if (!confirmed('Retire', `“${a.title}”`, 'It stops appearing for anyone who hasn’t seen it yet.')) return;
    setAnnBusy(true);
    const ok = await adminDeleteAnnouncement(a.id);
    setAnnBusy(false);
    if (ok) setAnnouncements((rows) => rows.filter((r) => r.id !== a.id));
    setAnnStatus(ok ? `Retired "${a.title}".` : adminFail('retire the announcement'));
  };

  const isCinematic = annKind !== 'patch';

  // TABS rather than one long scroll. The panel had grown to five unrelated jobs
  // stacked vertically, so the one you actually needed was always a scroll away —
  // and the live ops view (the thing you open during an incident) would have been
  // furthest down. It leads instead.
  if (tab === 'live') {
    return (
      <div className="ds-section adm-wide">
        <AdminHeader tab={tab} setTab={setTab} />
        {/* every tab opens on an h2 under the page h1, so AdminLive's section h3s nest */}
        <h2 className="ds-h2">Live</h2>
        <AdminLive onWatch={onWatch} onWatchReplay={onWatchReplay} onOpenUser={openAccount} />
      </div>
    );
  }

  return (
    <div className="ds-section adm-wide">
      <AdminHeader tab={tab} setTab={setTab} />

      {/* USERS. The search is a way IN to an account, not a place to act on one — every
          action moved onto the detail panel, where the standing, the reports and the
          matches that decide which button to press are on the same screen. */}
      {tab === 'users' && (
        <>
          {openUser ? (
            <AdminUser userId={openUser} onClose={() => setOpenUser(null)} onWatchReplay={onWatchReplay} />
          ) : (
            <>
              <h2 className="ds-h2">Find an account</h2>
              <div className="adm-toolbar">
                <input
                  type="search"
                  className="ds-input adm-grow"
                  aria-label="Search accounts"
                  value={userQuery}
                  placeholder="Name, @username or account id"
                  onChange={(e) => setUserQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void searchUsers(0)}
                />
                <button className="ds-btn small" disabled={userBusy || !userQuery.trim()} onClick={() => void searchUsers(0)}>
                  Search
                </button>
                {users.length > 0 && (
                  <button
                    className="ds-btn ghost small"
                    onClick={() =>
                      downloadCsv(
                        'accounts.csv',
                        ['userId', 'handle', 'username', 'role', 'supporter', 'supporterUntil'],
                        users.map((u) => [
                          u.userId,
                          u.handle,
                          u.username ?? '',
                          u.role ?? '',
                          u.supporter ? 'yes' : 'no',
                          u.supporterUntil ?? '',
                        ]),
                      )
                    }
                  >
                    Export CSV
                  </button>
                )}
              </div>
              {users.length === 0 ? (
                <div className="ds-empty">
                  <div className="big">No account open</div>
                  {userStatus ?? 'Search above, or open a name from the Live, Moderation or Audit tab.'}
                </div>
              ) : (
                <div className="ds-table-scroll">
                  <table className="ds-table adm-table">
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th>Membership</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u) => (
                        <tr key={u.userId}>
                          <td>
                            <AccountName
                              userId={u.userId}
                              handle={u.handle}
                              username={u.username}
                              role={u.role}
                              known
                              onOpen={openAccount}
                            />
                          </td>
                          <td className="ds-muted">
                            {u.supporter ? (
                              <>
                                Supporter until{' '}
                                {u.supporterUntil ? new Date(u.supporterUntil).toLocaleDateString() : '—'}
                                {u.autoRenews ? ' · auto-renews' : ''}
                              </>
                            ) : u.role ? (
                              'Perks by role'
                            ) : (
                              <>No paid membership{u.autoRenews ? ' · Ko-fi linked (lapsed)' : ''}</>
                            )}
                          </td>
                          <td>
                            <button className="ds-btn ghost small" onClick={() => openAccount(u.userId)}>
                              Open
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {userMore && (
                <div className="adm-more">
                  <button
                    className={`ds-btn ghost small${userBusy ? ' busy' : ''}`}
                    aria-busy={userBusy}
                    disabled={userBusy}
                    onClick={() => void searchUsers(users.length)}
                  >
                    Load more
                  </button>
                </div>
              )}
              {users.length > 0 && userStatus && <p className="ds-hint">{userStatus}</p>}
            </>
          )}
        </>
      )}

      {tab === 'audit' && <AdminAudit onOpenUser={openAccount} />}

      {/* LAZY, unlike every other tab here, and for the reason `GraphicsSection` is:
          the dashboard and its hand-rolled SVG charts are ~20 KB that only an admin who
          opens this tab will ever look at, and the client bundle is meant to stay React +
          Rapier 2D. One extra request behind the `.ds-loading` line every list already has. */}
      {tab === 'analytics' && (
        <LoadBoundary what="analytics" fallback={<p className="ds-loading">Loading analytics…</p>}>
          <AdminAnalytics />
        </LoadBoundary>
      )}

      {tab === 'server' && (
        <>
      <h2 className="ds-h2">Server restart</h2>

      <div className="admin-card">
        <label className="admin-field">
          <span>Restart in</span>
          <input
            type="number"
            className="ds-input"
            min={0}
            max={60}
            value={minutes}
            onChange={(e) => setMinutes(Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
          />
          <span>minutes</span>
        </label>
        <label className="admin-field col">
          <span>Message</span>
          <input type="text" className="ds-input" value={message} maxLength={90} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <div className="admin-buttons">
          <button
            className="ds-btn"
            disabled={busy}
            onClick={() =>
              // a banner on EVERY connected player's screen, so it is asked about like the
              // other console actions that reach past this one account
              confirmed(
                'Announce a restart to',
                'every connected player',
                `They see “${message}” with a ${minutes}-minute countdown. It only warns; it doesn’t restart anything.`,
              ) && run(() => adminAnnounce(minutes * 60, message), `Announced. Restart in ${minutes} min.`)
            }
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
        {status && <p className="ds-hint">{status}</p>}
      </div>
      <p className="ds-hint adm-gap">
        This only warns players. It doesn’t restart the server. Run your deploy when the
        countdown reaches 0.
      </p>
        </>
      )}

      {tab === 'content' && (
        <>
      <h2 className="ds-h2">Announcements</h2>
      <div className="admin-card">
        <label className="admin-field col">
          <span>Type</span>
          <select className="ds-select" value={annKind} onChange={(e) => setAnnKind(e.target.value as AnnouncementKind)}>
            {ANN_KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
        </label>
        <label className="admin-field col">
          <span>{isCinematic ? 'Title (the big reveal headline)' : 'Title'}</span>
          <input
            type="text"
            className="ds-input"
            value={annTitle}
            maxLength={80}
            placeholder={isCinematic ? 'e.g. Act II - The Rising Tide' : 'e.g. Build 42 - gate + intake fixes'}
            onChange={(e) => setAnnTitle(e.target.value)}
          />
        </label>
        {isCinematic && (
          <label className="admin-field col">
            <span>Tagline (optional subtitle under the reveal)</span>
            <input
              type="text"
              className="ds-input"
              value={annTagline}
              maxLength={80}
              placeholder="e.g. A NEW SEASON BEGINS"
              onChange={(e) => setAnnTagline(e.target.value)}
            />
          </label>
        )}
        <label className="admin-field col">
          <span>{isCinematic ? 'Details (shown in “What’s new”) · Markdown' : 'Notes · Markdown'}</span>
          <textarea
            className="ds-input admin-textarea"
            value={annBody}
            maxLength={8000}
            rows={8}
            placeholder={'## Gate & Intake\n- Fixed the gate lever swinging closed on a **resting** robot\n- Faster basin drain\n\n## Drivetrain\n- New swerve pod wobble tuning - see [the notes](https://example.com)'}
            onChange={(e) => setAnnBody(e.target.value)}
          />
          <span className="ds-hint">
            Supports Markdown: <code>## headings</code>, <code>**bold**</code>, <code>- bullets</code>{' '}
            (indent to nest), <code>[links](url)</code>, <code>---</code> rules.
          </span>
        </label>
        {annBody.trim() && (
          <div className="admin-field col">
            <span className="ds-hint">Preview</span>
            <div className="ann-item ann-preview">
              <Markdown text={annBody} className="ann-md" />
            </div>
          </div>
        )}
        <div className="admin-buttons">
          <button className="ds-btn" disabled={annBusy} onClick={publishAnnouncement}>
            PUBLISH
          </button>
        </div>
        {annStatus && <p className="ds-hint">{annStatus}</p>}
        {announcements.length > 0 && (
          <div className="admin-list">
            {announcements.map((a) => (
              <div key={a.id} className="admin-row">
                <KindBadge kind={a.kind} />
                <span className="admin-grow">
                  <strong>{a.title}</strong>
                  <span className="ds-hint"> · {new Date(a.publishedAt).toLocaleDateString()}</span>
                </span>
                <button className="ds-btn danger small" disabled={annBusy} onClick={() => retireAnnouncement(a)}>
                  RETIRE
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* the season/act difference lives on the two buttons' titles, and the confirm names the
          period each one creates (design review 10-15) */}
      <h2 className="ds-h2 adm-sec">Acts and seasons</h2>
      <div className="admin-card">
        <label className="admin-field col">
          <span>Custom title (optional)</span>
          <input
            type="text"
            className="ds-input"
            value={seasonName}
            maxLength={40}
            placeholder="e.g. Spring Showdown · blank ⇒ Act X · Season Y"
            onChange={(e) => setSeasonName(e.target.value)}
          />
        </label>
        <div className="admin-buttons">
          <button
            className="ds-btn"
            disabled={seasonBusy}
            title="Resets the boards within the current act. Past periods stay viewable in the leaderboard’s picker."
            onClick={() => startSeason(false)}
          >
            START NEW SEASON
          </button>
          <button
            className="ds-btn"
            disabled={seasonBusy}
            title="Rolls the act, restarts the season count at 1 and plays the “A NEW ACT” cinematic."
            onClick={() => startSeason(true)}
          >
            START NEW ACT
          </button>
          {/* irreversible, unlike the two beside it: a new period archives the old one, a
              purge deletes its replays for good */}
          <button className="ds-btn danger" disabled={seasonBusy} onClick={purgeReplays}>
            PURGE ARCHIVED REPLAYS
          </button>
        </div>
        {seasonStatus && <p className="ds-hint">{seasonStatus}</p>}
      </div>

        </>
      )}

      {tab === 'moderation' && (
        <>
      {/* REPORTS FIRST. The records tool below is something a moderator goes looking for;
          the report queue is the thing that arrives on its own and has people waiting on it. */}
      <AdminReports onWatchReplay={onWatchReplay} onOpenUser={openAccount} />
      <hr className="adm-sep" />
      <h2 className="ds-h2">Moderation · records</h2>
      <p className="ds-sub adm-sub">
        Inspect a leaderboard bucket (live season) and remove cheated or invalid runs. Deleting a
        run also deletes its replay. “Clear all” wipes every run by that player, for confirmed
        cheaters. Both are written to the audit log.
      </p>
      <div className="admin-card">
        <div className="admin-field">
          <span>Board</span>
          <select className="ds-select" aria-label="Game" value={recGame} onChange={(e) => setRecGame(e.target.value as GameId)}>
            {SEASONS.map((g) => (
              <option key={g.key} value={g.key}>{g.name}</option>
            ))}
          </select>
          <select className="ds-select" aria-label="Mode" value={recMode} onChange={(e) => setRecMode(e.target.value as RecMode)}>
            <option value="solo">Solo</option>
            <option value="duo">Duo</option>
          </select>
          <select className="ds-select" aria-label="Drivetrain" value={recDt} onChange={(e) => setRecDt(e.target.value)}>
            {DRIVETRAINS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <button className="ds-btn small" disabled={recBusy} onClick={loadRecords}>
            LOAD
          </button>
          {records.length > 0 && (
            <button
              className="ds-btn ghost small"
              onClick={() =>
                downloadCsv(
                  `records-${recGame}-${recMode}-${recDt}.csv`,
                  ['rank', 'userId', 'handle', 'score', 'drivetrain', 'recordId', 'replayId', 'createdAt'],
                  records.map((r, i) => [
                    i + 1, r.userId, r.handle, r.score, r.drivetrain, r.recordId, r.replayId ?? '', r.createdAt,
                  ]),
                )
              }
            >
              Export CSV
            </button>
          )}
        </div>
        {records.length > 0 && (
          <div className="admin-list adm-gap">
            {records.map((r, i) => (
              <div key={r.recordId} className="admin-row">
                <span className="admin-rank">{i + 1}</span>
                <span className="admin-grow">
                  <AccountName userId={r.userId} handle={r.handle} known onOpen={openAccount} />
                  <span className="ds-hint">
                    {' '}
                    · {r.score} pts · {r.drivetrain} · <When at={r.createdAt} />
                  </span>
                </span>
                {r.replayId && onWatchReplay && (
                  <button className="ds-btn ghost small" onClick={() => onWatchReplay(r.replayId as string)}>
                    WATCH
                  </button>
                )}
                <button className="ds-btn danger small" disabled={recBusy} onClick={() => deleteRecord(r)}>
                  DELETE
                </button>
                <button className="ds-btn danger small" disabled={recBusy} onClick={() => clearUser(r)}>
                  CLEAR ALL
                </button>
              </div>
            ))}
          </div>
        )}
        {recStatus && <p className="ds-hint">{recStatus}</p>}
      </div>
        </>
      )}
    </div>
  );
}
