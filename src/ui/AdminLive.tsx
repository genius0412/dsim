import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  adminFetchPresence,
  adminFetchMaintenance,
  adminFetchMatches,
  adminSetMaintenance,
  type AdminMatchRow,
  type AdminPresence,
  type AdminPresencePlayer,
  type AdminPresenceGuest,
  type MaintenanceWindow,
} from '../net/api';
import { SEASONS } from '../seasons';
import { ACCESS_GROUPS, ACCESS_GROUP_LABEL, type AccessGroup, type LockdownScope } from '../net/protocol';
import { windowLabel } from './MaintenanceBanner';
import { adminFail } from './adminCopy';
import { AccountName, ListState, When, confirmed, downloadCsv, shortId, usePolled } from './adminBits';

/**
 * The operator's live view: who is connected, what each of them is doing, which
 * matches are running and which just finished, and the maintenance lockdown.
 *
 * EVERY SESSION IS A ROW — signed-in accounts and guests alike. Guests are keyed by
 * the server's per-socket connection id, which is not an IP, not a fingerprint, is
 * written nowhere else, and dies with the socket. It tells two live sessions apart
 * right now; it cannot connect either to a past one. Nobody's screen, menu or inputs
 * are reported, and the PRESENCE half has no history — its source is a ~5s snapshot
 * that overwrites itself. "Recent games" is the one section that looks backwards,
 * and only at finished match RESULTS, each of which already appears in its own
 * players' public match history. The privacy policy states this; if it widens, that
 * moves too.
 */
const REFRESH_MS = 5000;
const GAME_LABEL: Record<string, string> = Object.fromEntries(SEASONS.map((s) => [s.key, s.name]));
const gameName = (g?: string): string => (g ? (GAME_LABEL[g] ?? g) : '');

/** what kind of game a live room is, in the operator's words */
function roomKind(r: { ranked: boolean; kind?: 'versus' | 'record' }): string {
  if (r.kind === 'record') return 'Record';
  return r.ranked ? 'Ranked' : 'Custom';
}

export function AdminLive({
  onWatch,
  onWatchReplay,
  onOpenUser,
}: {
  /** spectate a LIVE room (read-only, hidden from the spectator count) */
  onWatch?: (room: string, region?: string) => void;
  /** open a FINISHED game's replay — the only way to review one after the fact */
  onWatchReplay?: (replayId: string) => void;
  /** open the account behind a session, in the Users tab */
  onOpenUser?: (userId: string) => void;
}) {
  const [filter, setFilter] = useState('');
  // PAUSES WHILE THE TAB IS HIDDEN (see `usePolled`). This used to be a bare
  // `setInterval(load, 5000)` that ran forever: an admin tab left open behind an editor was
  // by itself enough to keep the game server — which auto-stops when idle — permanently
  // awake, at a database round trip every five seconds for a screen nobody was looking at.
  const { data, err } = usePolled(adminFetchPresence, REFRESH_MS);

  if (err && !data) return <ListState error="read live status" />;
  if (!data) return <ListState loading="Reading live status…" />;

  // MERGE the database aggregate with this machine's own numbers: the heartbeat is
  // ~5s behind, so without the local row a session that appeared a moment ago is
  // missing from the very machine holding its socket.
  const machines = mergeMachines(data);
  const players = machines.flatMap((m) => m.players.map((p) => ({ ...p, region: m.region })));
  const guests = machines.flatMap((m) => (m.guests ?? []).map((g) => ({ ...g, region: m.region })));
  const sockets = machines.reduce((n, m) => n + m.online, 0);

  const q = filter.trim().toLowerCase();
  const match = (s: string | undefined | null): boolean => !!s && s.toLowerCase().includes(q);
  const shownPlayers = q
    ? players.filter((p) => match(p.handle) || match(p.username) || match(p.room) || match(p.region))
    : players;
  const shownGuests = q ? guests.filter((g) => match(g.id) || match(g.room) || match(g.region)) : guests;

  // ONE FRAME PER SECTION, as Analytics does (design review 10-15): the tab was ten stacked
  // blocks with nothing to scan by. `.ds-sec` owns the gap between them.
  return (
    <div className="ds-sec">
      <MaintenancePanel />

      <div className="adm-stats">
        {/* the tiles' `title`s carry what each one counts; the arithmetic sentence that sat under
            them is gone (design review 10-15). One player with two tabs is two sessions. */}
        <Stat label="Sessions" value={sockets} hint="open sockets across every region; one player with two tabs is two" />
        <Stat label="Accounts" value={players.length} hint="distinct signed-in players" />
        <Stat label="Guests" value={guests.length} hint="sessions with no account" />
        <Stat
          label="In a match"
          value={players.filter((p) => p.act === 'match').length + guests.filter((g) => g.act === 'match').length}
        />
        <Stat label="Queued" value={players.filter((p) => p.queue).length} hint="waiting for a ranked match" />
        <Stat label="Live matches" value={data.rooms.length} />
      </div>

      <LivePanel title="Regions">
      <div className="adm-regions">
        {machines.length === 0 && <p className="ds-hint">No machine is reporting.</p>}
        {machines.map((m) => (
          <div key={m.machine} className="adm-region">
            <b>{m.region || 'local'}</b>
            <span className="ds-muted">{m.online} sessions</span>
            <span className="ds-muted">
              {m.players.length} account{m.players.length === 1 ? '' : 's'} · {(m.guests ?? []).length} guest
              {(m.guests ?? []).length === 1 ? '' : 's'}
            </span>
            <span className="ds-muted">{beatAge(m.updatedAt)}</span>
          </div>
        ))}
      </div>
      </LivePanel>

      <input
        type="search"
        className="ds-input adm-filter"
        aria-label="Filter sessions"
        placeholder="Filter every session by name, id, room or region…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <LivePanel
        title="Signed in"
        count={shownPlayers.length}
        action={shownPlayers.length > 0 && (
          <button
            className="ds-btn ghost small"
            onClick={() =>
              downloadCsv(
                'sessions.csv',
                ['userId', 'handle', 'username', 'doing', 'game', 'queue', 'queuedS', 'room', 'region', 'sockets'],
                shownPlayers.map((p) => [
                  p.userId, p.handle ?? '', p.username ?? '', p.act, p.game ?? '',
                  p.queue ?? '', p.queuedS ?? '', p.room ?? '', p.region, p.sessions ?? 1,
                ]),
              )
            }
          >
            Export CSV
          </button>
        )}
      >
      <SessionTable
        rows={shownPlayers.map((p) => ({
          key: p.userId + p.region,
          who: (
            <>
              {/* ⚠️ ONE function decides what a nameless account reads as — see `AccountName`.
                  This line used to be `p.handle ?? '(no profile)'`, which said the same
                  wrong thing about three different situations. */}
              <AccountName
                userId={p.userId}
                handle={p.handle}
                username={p.username}
                known={p.known}
                role={p.role}
                onOpen={onOpenUser}
              />
              {(p.sessions ?? 1) > 1 && <span className="ds-badge">×{p.sessions}</span>}
            </>
          ),
          act: p.act,
          actLabel: actLabel(p),
          queue: p.queue ? `${gameName(p.queueGame ?? p.game) || ''} ${p.queue.toUpperCase()} · ${waitLabel(p.queuedS ?? 0)}`.trim() : null,
          room: p.room,
          region: p.region,
        }))}
        empty={players.length === 0 ? 'Nobody signed in is connected' : 'No match for that filter'}
        onWatch={onWatch}
      />
      </LivePanel>

      <LivePanel title="Guests" count={shownGuests.length}>
      <SessionTable
        rows={shownGuests.map((g) => ({
          key: g.id + g.region,
          who: <code className="adm-guest-id">{shortId(g.id)}</code>,
          act: g.act,
          actLabel: actLabel(g),
          queue: null, // ranked needs an account, so a guest is never in a queue
          room: g.room,
          region: g.region,
        }))}
        empty={guests.length === 0 ? 'No guest sessions' : 'No match for that filter'}
        onWatch={onWatch}
      />
      </LivePanel>

      <LivePanel title="Live matches" count={data.rooms.length}>
      {data.rooms.length === 0 ? (
        <ListState empty="No live matches">Nothing is being played anywhere right now.</ListState>
      ) : (
        <div className="adm-rooms">
          {data.rooms.map((r) => (
            <div key={r.room} className="adm-room">
              <div>
                <b>{r.players.map((p) => p.name).join(' vs ') || r.room}</b>
                <span className="ds-muted">
                  {' '}
                  · {gameName(r.game)} · {roomKind(r)} {r.mode} · {r.phase} · {r.score.red}–
                  {r.score.blue}
                  {r.spectators > 0 ? ` · ${r.spectators} watching` : ''}
                  {r.region ? ` · ${r.region}` : ''} · <code>{r.room}</code>
                </span>
              </div>
              {onWatch && (
                <button className="ds-btn small" onClick={() => onWatch(r.room, r.region)}>
                  Watch (hidden)
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      </LivePanel>

      <RecentGames onWatchReplay={onWatchReplay} />

      <p className="ds-hint adm-privacy">
        <b>Scope of this page.</b> Nobody’s screen, menu, inputs or messages are recorded. The
        presence figures above are a live snapshot that overwrites itself every few seconds, so they
        cannot answer “what was X doing an hour ago”; <b>Recent games</b> is the only backward-looking
        section, and it shows finished match results, each of which already appears in its own
        players’ public match history. Watching a live match from here does <b>not</b> appear in the
        spectator count players see. A guest row is keyed by the server’s per-socket connection
        id, which is not an IP or a fingerprint and dies with the socket. All of this is stated
        in the privacy policy.
      </p>
    </div>
  );
}

/** one Live section in the `.ds-panel` frame, title (+ count) left and its one action right */
function LivePanel({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ds-panel">
      <div className="ds-panel-h">
        <h3 className="ds-panel-title">
          {title}
          {count != null && <span className="ds-count"> ({count})</span>}
        </h3>
        {action}
      </div>
      <div className="ds-panel-body">{children}</div>
    </section>
  );
}

/**
 * Games that have FINISHED, newest first.
 *
 * Refreshed far more slowly than presence: a completed match is settled history,
 * so polling it at the live rate would be a database query every five seconds to
 * re-read rows that cannot change. The list is capped rather than paginated — this
 * answers "what just happened", and an operator chasing something older has the
 * player's own match history to open.
 */
function RecentGames({ onWatchReplay }: { onWatchReplay?: (replayId: string) => void }) {
  const { data: rows, err } = usePolled(() => adminFetchMatches(40), 30_000);

  // FOLDED by default (10-15): the one backward-looking list, and 40 rows long, so on an
  // incident view it stays out of the way until somebody asks for it
  return (
    <LivePanel title="Recent games" count={rows?.length}>
      <details className="ds-fold">
      <summary>Show finished games</summary>
      <div className="ds-fold-body">
      {err && !rows ? (
        <ListState error="read match history" />
      ) : !rows ? (
        <ListState loading="Reading recent games…" />
      ) : rows.length === 0 ? (
        <ListState empty="No games have finished yet" />
      ) : (
        <div className="adm-rooms">
          {rows.map((m) => (
            <div key={m.kind + m.id} className="adm-room">
              <div>
                <b>{rosterLabel(m)}</b>
                <span className="ds-muted">
                  {' '}
                  · {gameName(m.game)} · {matchKind(m)} {m.mode} · {scoreLabel(m)} ·{' '}
                  <When at={m.createdAt} />
                  {' · s'}
                  {m.balanceVersion}
                </span>
              </div>
              {m.replayId && onWatchReplay ? (
                <button className="ds-btn small ghost" onClick={() => onWatchReplay(m.replayId as string)}>
                  Watch replay
                </button>
              ) : (
                <span className="ds-muted" title="This match saved no replay">
                  no replay
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      </div>
      </details>
    </LivePanel>
  );
}

/** "red names vs blue names" for a versus match, or the runner for a record run */
function rosterLabel(m: AdminMatchRow): string {
  if (m.kind === 'record') return m.players.map((p) => p.handle).join(' + ') || 'Record run';
  const side = (a: 'red' | 'blue'): string =>
    m.players.filter((p) => p.alliance === a).map((p) => p.handle).join(' + ') || a.toUpperCase();
  return `${side('red')} vs ${side('blue')}`;
}

function matchKind(m: AdminMatchRow): string {
  if (m.kind === 'record') return 'Record';
  return m.ranked ? 'Ranked' : 'Custom';
}

function scoreLabel(m: AdminMatchRow): string {
  if (m.kind === 'record') return `${m.score ?? 0} pts`;
  return `${m.redScore ?? 0}–${m.blueScore ?? 0}`;
}

/** one shared table for both kinds of session, so a guest row and an account row
 *  can never drift into showing different things about the same situation */
function SessionTable({
  rows,
  empty,
  onWatch,
}: {
  rows: {
    key: string;
    who: React.ReactNode;
    act: 'menu' | 'lobby' | 'match';
    actLabel: string;
    queue: string | null;
    room?: string;
    region: string;
  }[];
  empty: string;
  onWatch?: (room: string, region?: string) => void;
}) {
  if (rows.length === 0) return <ListState empty={empty} />;
  return (
    <div className="ds-table-scroll">
      <table className="ds-table adm-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Doing</th>
            <th>Queue</th>
            <th>Room</th>
            <th>Region</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.who}</td>
              <td>
                <span className={`ds-badge${r.act === 'match' ? ' ok' : ''}`}>{r.actLabel}</span>
              </td>
              <td>
                {r.queue ? <span className="ds-badge accent">{r.queue}</span> : <span className="ds-muted">—</span>}
              </td>
              <td>
                {r.room ? (
                  onWatch ? (
                    // the session's region IS the room's: a client's socket lives on
                    // the machine hosting its room, which is what a bare custom code
                    // cannot tell the spectate connection on its own
                    <button
                      className="ds-btn small ghost"
                      onClick={() => onWatch(r.room as string, r.region || undefined)}
                    >
                      {r.room} ↗
                    </button>
                  ) : (
                    <code>{r.room}</code>
                  )
                ) : (
                  <span className="ds-muted">—</span>
                )}
              </td>
              <td className="ds-muted">{r.region || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The LOCKDOWN control (0023 + 0051).
 *
 * SCOPE first, because it decides everything below it: "New matches" is the old maintenance
 * window (players keep the menus, nothing new starts); "Whole site" closes the app for
 * everyone the lockdown does not let through, and the server refuses their writes too.
 *
 * A window with a FUTURE start is still the normal path for maintenance: it announces itself
 * before it bites. Open-ended is allowed (the alpha closure is one) and lasts until lifted.
 * Admins always pass; the ticked ACCESS GROUPS pass too.
 */
function MaintenancePanel() {
  const [w, setW] = useState<MaintenanceWindow | null>(null);
  const [biting, setBiting] = useState(false);
  const [scope, setScope] = useState<LockdownScope>('matches');
  const [mins, setMins] = useState(10);
  const [dur, setDur] = useState(30);
  const [openEnded, setOpenEnded] = useState(false);
  const [msg, setMsg] = useState('Scheduled maintenance');
  const [redirect, setRedirect] = useState('');
  const [redirectLabel, setRedirectLabel] = useState('');
  const [bypass, setBypass] = useState<AccessGroup[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // also visibility-aware — a lockdown window changes when somebody sets one, which is a
  // couple of times a month, and the panel was asking every five seconds forever
  const { data: served, reload: load } = usePolled(adminFetchMaintenance, REFRESH_MS);
  const seeded = useRef(false);
  useEffect(() => {
    if (!served) return;
    setW(served.maintenance);
    setBiting(served.biting);
    // the form is SEEDED from the server once, not BOUND to it: overwriting it on every poll
    // would wipe what an admin is halfway through typing
    if (seeded.current || !served.maintenance.active) return;
    seeded.current = true;
    const m = served.maintenance;
    if (m.message) setMsg(m.message);
    setScope(m.scope ?? 'matches');
    setRedirect(m.redirectUrl ?? '');
    setRedirectLabel(m.redirectLabel ?? '');
    setBypass(m.bypass ?? []);
    setOpenEnded(!m.endsAt);
  }, [served]);

  const apply = async (next: MaintenanceWindow, okMsg: string): Promise<void> => {
    setBusy(true);
    const ok = await adminSetMaintenance(next);
    setBusy(false);
    setStatus(ok ? okMsg : adminFail('apply that change'));
    load();
  };

  const redirectOk = !redirect.trim() || /^https:\/\/\S+$/i.test(redirect.trim());
  const schedule = (): void => {
    // "starts in 0" is not a schedule, it is locking every player out on this click — the
    // one action on the incident view that needs asking about. A scheduled one announces
    // itself first, which is its own warning.
    const what = scope === 'site' ? 'The whole site closes' : 'New matches, queueing and custom rooms stop';
    const who = bypass.length ? `everyone except admins and ${bypass.join(', ')}` : 'everyone except admins';
    if (mins <= 0 && !confirmed('Lock down', 'every region now', `${what} for ${who}${openEnded ? ', until you lift it' : `, for ${dur} min`}.`)) return;
    const startsAt = Date.now() + Math.max(0, mins) * 60_000;
    void apply(
      {
        active: true,
        startsAt,
        endsAt: openEnded ? null : startsAt + Math.max(1, dur) * 60_000,
        message: msg,
        scope,
        redirectUrl: redirect.trim() || null,
        redirectLabel: redirectLabel.trim() || null,
        bypass,
      },
      mins > 0 ? `Scheduled in ${mins} min.` : 'Locked down.',
    );
  };
  const lift = (): void =>
    void apply({ active: false, startsAt: null, endsAt: null, message: '' }, 'Lockdown lifted.');

  const live = w?.active ?? false;
  const liveScope = w?.scope === 'site' ? 'Whole site' : 'New matches';
  const liveBypass = w?.bypass?.length ? ` · passes: admins, ${w.bypass.join(', ')}` : ' · passes: admins';
  const toggle = (g: AccessGroup): void =>
    setBypass((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]));
  return (
    <div className={`admin-card adm-maint${biting ? ' biting' : ''}`}>
      <div className="adm-maint-h">
        {/* a heading for the section list, not a restyle: .adm-maint-h lays the <b> out */}
        <b role="heading" aria-level={3}>
          Lockdown
        </b>
        <span className={`ds-badge${biting ? ' danger' : live ? ' warn' : ''}`}>
          {biting ? `LOCKED: ${liveScope.toLowerCase()}` : live ? 'SCHEDULED' : 'Off'}
        </span>
      </div>
      {live && w && (
        <p className="ds-hint">
          {liveScope} · {w.message || 'no message'} · {windowLabel({ ...w, biting }) || 'until lifted'}
          {liveBypass}
          {w.redirectUrl ? ` · sends players to ${w.redirectUrl}` : ''}
        </p>
      )}
      <div className="ds-segs" role="radiogroup" aria-label="What closes">
        <button role="radio" aria-checked={scope === 'matches'} className={`ds-seg${scope === 'matches' ? ' on' : ''}`} onClick={() => setScope('matches')}>
          New matches
        </button>
        <button role="radio" aria-checked={scope === 'site'} className={`ds-seg${scope === 'site' ? ' on' : ''}`} onClick={() => setScope('site')}>
          Whole site
        </button>
      </div>
      <label className="admin-field">
        <span>Starts in</span>
        <input type="number" className="ds-input" min={0} max={1440} value={mins} onChange={(e) => setMins(Math.max(0, Number(e.target.value) || 0))} />
        <span>min, lasting</span>
        <input type="number" className="ds-input" min={1} max={1440} value={dur} disabled={openEnded} onChange={(e) => setDur(Math.max(1, Number(e.target.value) || 1))} />
        <span>min</span>
      </label>
      <label className="ds-checkline">
        <input type="checkbox" checked={openEnded} onChange={(e) => setOpenEnded(e.target.checked)} />
        Until lifted (no end time)
      </label>
      <label className="admin-field col">
        <span>Message shown to players</span>
        <input type="text" className="ds-input" maxLength={200} value={msg} onChange={(e) => setMsg(e.target.value)} />
      </label>
      {scope === 'site' && (
        <div className="adm-pair">
          <label className="admin-field col">
            <span>Button link (https)</span>
            <input type="url" className="ds-input" placeholder="https://playdsim.com" value={redirect} aria-invalid={!redirectOk} onChange={(e) => setRedirect(e.target.value)} />
          </label>
          <label className="admin-field col">
            <span>Button label</span>
            <input type="text" className="ds-input" maxLength={40} placeholder="Go to DSIM" value={redirectLabel} onChange={(e) => setRedirectLabel(e.target.value)} />
          </label>
        </div>
      )}
      <fieldset className="adm-groups">
        <legend>Also let through</legend>
        {ACCESS_GROUPS.map((g) => (
          <label key={g} className="ds-checkline">
            <input type="checkbox" checked={bypass.includes(g)} onChange={() => toggle(g)} />
            {ACCESS_GROUP_LABEL[g]}s
          </label>
        ))}
      </fieldset>
      <div className="admin-buttons">
        <button className={mins > 0 ? 'ds-btn' : 'ds-btn danger'} disabled={busy || !redirectOk} onClick={schedule}>
          {mins > 0 ? 'SCHEDULE LOCKDOWN' : 'LOCK DOWN NOW'}
        </button>
        <button className="ds-btn ghost" disabled={busy || !live} onClick={lift}>
          LIFT LOCKDOWN
        </button>
      </div>
      <p className="ds-hint">
        {redirectOk ? 'Admins always get in. Matches already running finish.' : 'The link must start with https://.'}
      </p>
      {status && <p className="ds-hint">{status}</p>}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="adm-stat" title={hint}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

/**
 * The DB aggregate plus THIS machine's own row, deduped by machine id.
 *
 * ⚠️ THE LOCAL ROW WINS ON NUMBERS AND THE DATABASE ROW WINS ON NAMES, and getting that
 * backwards is the whole of the "(no profile)" bug. `local` is assembled from live socket
 * state, so it is the FRESHER of the two — a session that connected two seconds ago is in it
 * and not yet in the heartbeat — which is why it replaces the database row outright. But the
 * heartbeat is where handles are resolved (`adminPresence` joins `profiles` over it), so
 * replacing the row threw every name on this machine away. On a single-region deploy that is
 * every signed-in session, all the time.
 *
 * The server now names its own snapshot, so on a current server this loop finds nothing to
 * fill in. It stays because ONE FLY APP SERVES EVERY CLIENT VERSION: a console loaded from a
 * newer Vercel deploy talks to whatever server is live, and against an older one `local`
 * still arrives nameless. `known` is only ever trusted from the row that actually carries a
 * name, so an old server's silence never asserts "this account has no profile".
 */
function mergeMachines(d: AdminPresence): AdminPresence['machines'] {
  const out = [...d.machines];
  const i = out.findIndex((m) => m.machine === d.local.machine);
  if (i >= 0) {
    const fromDb = new Map(out[i].players.map((p) => [p.userId, p]));
    out[i] = {
      ...d.local,
      players: d.local.players.map((p) => {
        if (p.handle) return p;
        const known = fromDb.get(p.userId);
        return known
          ? { ...p, handle: known.handle, username: known.username, role: known.role, known: known.known }
          : p;
      }),
    };
  } else if (d.local.online > 0 || d.local.players.length > 0 || (d.local.guests ?? []).length > 0) {
    out.push(d.local);
  }
  return out;
}

function actLabel(p: AdminPresencePlayer | AdminPresenceGuest): string {
  if (p.act === 'match') return `In a match${p.game ? ` · ${gameName(p.game)}` : ''}`;
  if (p.act === 'lobby') return `In a lobby${p.game ? ` · ${gameName(p.game)}` : ''}`;
  return 'Idle · in menus';
}

function waitLabel(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function beatAge(iso?: string): string {
  if (!iso) return 'live';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 10 ? 'just now' : `${s}s ago`;
}
