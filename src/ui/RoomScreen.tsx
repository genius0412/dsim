import { useState, type DragEvent, type ReactNode } from 'react';
import type { Alliance } from '../types';
import { ROOM_CAPACITY, ROOM_REACTIONS, type LobbyPlayer, type RoomSettings, type RoomSettingsPatch, type RoomWatcher } from '../net/protocol';
import { SupporterBadge } from './SupporterBadge';
import { BadgeMarks } from './BadgeMark';
import { botLabel } from './SoloSetup';
import { canTakeSeat, seatMap, settingsLine, shrinkState, type PendingSeat, type Seat, type SeatTo } from './lobbyRules';
import './room.css';

/**
 * THE ONE-SCREEN ROOM (docs/rooms-redesign.md). Every seat on both alliances, the watchers, the
 * host's settings and the READY / START bar are on one screen, with nothing to scroll on a laptop:
 * the old lobby was one 1234 px column with READY at y=1089 in a 768 px window. A side always draws
 * as many cards as it has seats (`seatMap`), so a join, a leave or the crown passing moves nothing.
 * Robot and start position live in the Setup drawer, opened from your own card.
 *
 * Presentational: `Lobby` owns the socket, the roster and every decision about what may be sent;
 * this draws what it is handed and calls back.
 */

/** the bot controls, for a host whose game and server both seat bots */
export interface RoomBots {
  tiers: readonly string[];
  /** the tier "+ Bot" seats */
  tier: string;
  onTier: (t: string) => void;
  /** seat a bot on `a`, at `tier` (else the panel's tier) */
  onAdd: (a: Alliance, tier?: string) => void;
  onRemove: (id: string) => void;
}

/** the host's settings panel; absent for everyone else */
export interface RoomHostPanel {
  /** `'rooms2'` controls (seats, sides); absent on an older server or a legacy room */
  settings?: RoomSettings;
  onSettings: (patch: RoomSettingsPatch) => void;
  /** the run-length pick is offered (server `'rooms3'` + `'autoOnly'`) */
  runLength: boolean;
  /** Private/Public is offered (server `'rooms3'`); Public needs an account */
  visibility: boolean;
  signedIn: boolean;
  /** a duo record's one host control */
  onUnlock?: () => void;
}

export interface RoomScreenProps {
  title: string;
  code: string;
  /** where the room runs, when there is more than one region */
  region?: string;
  copied: boolean;
  onCopy: () => void;
  /** opens the friends panel's invite list (signed in only) */
  onInvite?: () => void;
  onLeave: () => void;
  /** a one-line notice under the header (the room turned Private, a refusal) */
  notice?: string | null;
  players: LobbyPlayer[];
  watchers: RoomWatcher[];
  /** the server names its watchers (`'rooms3'`); an older one sends no list */
  watchersKnown: boolean;
  watcherCap: number;
  hostId: string;
  myId: string;
  spectating: boolean;
  pending: PendingSeat | null;
  /** a refused move, said on the side it was for */
  seatNote: { to: SeatTo; text: string } | null;
  settings?: RoomSettings;
  capacity: number;
  isHost: boolean;
  record: boolean;
  /** the Watch button (`canWatch`) */
  canWatch: boolean;
  /** a watcher may take a seat from here (a LAN room has no watcher socket) */
  canSeat: boolean;
  onTake: (a: Alliance) => void;
  onWatch: () => void;
  /** the start position a card names */
  startLabel: (p: LobbyPlayer) => string;
  /** this seat's role control (the Close/Far swap), drawn in your own card */
  swap?: ReactNode;
  onSetup: () => void;
  /** may the host move this member? (`hostMoveOffered`) */
  canMove: (p: LobbyPlayer) => boolean;
  onMove: (id: string, a: Alliance) => void;
  bots: RoomBots | null;
  host: RoomHostPanel | null;
  /** reaction bubbles showing now, by sender id */
  bubbles: Record<string, number>;
  /** reactions are offered (server `'rooms3'`) */
  onReact?: (k: number) => void;
  reactBusy: boolean;
  bar: {
    status: string;
    warn?: string | null;
    error?: string | null;
    ready?: { on: boolean; disabled: boolean; onClick: () => void };
    start?: { label: string; disabled: boolean; onClick: () => void };
  };
  drawer: ReactNode;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
}

export function RoomScreen(props: RoomScreenProps) {
  const { players, settings, capacity, pending, myId, spectating } = props;
  const map = seatMap(players, settings, capacity, pending);
  const me = players.find((p) => p.clientId === myId) ?? null;
  const shownWatchers =
    pending?.to === 'watch' && !props.watchers.some((w) => w.id === myId)
      ? [...props.watchers, { id: myId, name: me?.name ?? 'You' }]
      : props.watchers.filter((w) => !(pending && pending.to !== 'watch' && w.id === pending.id));
  const watchingNow = spectating || pending?.to === 'watch';
  /** the side a host is dragging a card over, for the drop outline */
  const [dropOn, setDropOn] = useState<Alliance | null>(null);
  const [dragged, setDragged] = useState<{ id: string; from: Alliance } | null>(null);

  const side = (a: Alliance, seats: Seat[]) => {
    const onDragOver = (e: DragEvent): void => {
      if (!dragged || dragged.from === a) return;
      e.preventDefault();
      setDropOn(a);
    };
    const onDrop = (e: DragEvent): void => {
      e.preventDefault();
      if (dragged && dragged.from !== a) props.onMove(dragged.id, a);
      setDropOn(null);
      setDragged(null);
    };
    return (
      <section
        className={`rm-side ${a}${dropOn === a ? ' drop' : ''}`}
        aria-label={`${a === 'red' ? 'Red' : 'Blue'} alliance`}
        onDragOver={onDragOver}
        onDragLeave={() => setDropOn((d) => (d === a ? null : d))}
        onDrop={onDrop}
      >
        <h2 className="rm-side-h">
          <span className={`ds-chip ${a}`}>{a.toUpperCase()}</span>
          <span className="rm-side-n">
            {seats.filter((s) => s.p).length}/{seats.length}
          </span>
        </h2>
        <div className="rm-seats">
          {seats.map((s, i) => (s.p ? memberCard(s.p, i) : openCard(a, i)))}
        </div>
        <p className="rm-note" aria-live="polite">
          {props.seatNote && props.seatNote.to === a ? props.seatNote.text : ''}
        </p>
      </section>
    );
  };

  const openCard = (a: Alliance, i: number) => {
    // a watcher takes a seat only where it has a watcher socket (`canSeat`); a driver changes side anywhere
    const take = (!watchingNow || props.canSeat) && canTakeSeat(a, { spectating: watchingNow, me: watchingNow ? null : me, set: settings, record: props.record });
    return (
      <div key={`open-${i}`} className={`rm-seat open ${a}`}>
        <div className="rm-seat-top">
          <span className="rm-name rm-open">Open seat</span>
        </div>
        <div className="rm-seat-acts">
          {take && (
            <button type="button" className="ds-btn small" onClick={() => props.onTake(a)}>
              Take seat
            </button>
          )}
          {props.bots && (
            <button type="button" className="ds-btn small" onClick={() => props.bots?.onAdd(a)}>
              + Bot
            </button>
          )}
        </div>
      </div>
    );
  };

  const memberCard = (p: LobbyPlayer, i: number) => {
    const mine = p.clientId === myId && !watchingNow;
    const moving = props.isHost && props.canMove(p);
    const other: Alliance = p.alliance === 'red' ? 'blue' : 'red';
    const otherFull = map[other].every((s) => s.p);
    const bubble = props.bubbles[p.clientId];
    return (
      <div
        key={p.clientId || `m-${i}`}
        className={`rm-seat ${p.alliance}${mine ? ' mine' : ''}${pending && pending.id === p.clientId ? ' moving' : ''}`}
        draggable={moving}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', p.clientId);
          setDragged({ id: p.clientId, from: p.alliance });
        }}
        onDragEnd={() => {
          setDragged(null);
          setDropOn(null);
        }}
      >
        <div className="rm-seat-top">
          <span className="rm-name">
            {p.name}
            {mine ? ' (you)' : ''}
            <SupporterBadge supporter={p.supporter} role={p.role} />
            <BadgeMarks badges={p.badges} />
          </span>
          {p.clientId === props.hostId && <span className="ds-chip on">HOST</span>}
          <span className={`ds-chip ${p.ready ? 'on' : 'off'}`}>{p.ready ? 'READY' : 'NOT READY'}</span>
        </div>
        <div className="rm-seat-sub">
          <span className="rm-robot">
            {p.bot ? `${botLabel(p.bot)} bot` : p.spec.name}
            {p.bot ? '' : ` · ${p.teamNumber || '—'}`}
          </span>
          <span className="ds-chip">{props.startLabel(p)}</span>
          {p.bot && <span className="ds-chip">BOT</span>}
          {p.ready3d === false && <span className="ds-chip off">LOADING</span>}
          {p.autoName && <span className="ds-chip">AUTO</span>}
        </div>
        <div className="rm-seat-acts">
          {mine && (
            <button type="button" className="ds-btn small" onClick={props.onSetup}>
              Setup
            </button>
          )}
          {mine && props.swap}
          {moving && (
            <button type="button" className="ds-btn small" disabled={otherFull} onClick={() => props.onMove(p.clientId, other)}>
              Move to {other}
            </button>
          )}
          {p.bot && props.bots && (
            <>
              <select
                className="ds-select rm-tier"
                aria-label={`${p.name}: difficulty`}
                value={p.bot}
                onChange={(e) => {
                  // a bot's tier is fixed when it is seated, so a new one takes its seat
                  props.bots?.onRemove(p.clientId);
                  props.bots?.onAdd(p.alliance, e.target.value);
                }}
              >
                {props.bots.tiers.map((t) => (
                  <option key={t} value={t}>
                    {botLabel(t)}
                  </option>
                ))}
              </select>
              <button type="button" className="ds-btn small" aria-label={`Remove ${p.name}`} onClick={() => props.bots?.onRemove(p.clientId)}>
                Remove
              </button>
            </>
          )}
        </div>
        {bubble !== undefined && (
          <span className="rm-bubble" role="status">
            {ROOM_REACTIONS[bubble]}
          </span>
        )}
      </div>
    );
  };

  const hostPanel = props.host ? <HostPanel host={props.host} players={players} capacity={capacity} bots={props.bots} /> : null;

  return (
    <div className="rm-screen">
      <header className="rm-head">
        <button type="button" className="ds-back" onClick={props.onLeave}>
          ← Leave
        </button>
        <h1 className="rm-title">{props.title}</h1>
        <div className="rm-code">
          <span className="rm-code-v" aria-label={`Room code ${props.code.split('').join(' ')}`}>
            {props.code}
          </span>
          <button type="button" className="ds-btn small" onClick={props.onCopy}>
            {props.copied ? 'Copied' : 'Copy code'}
          </button>
          {props.onInvite && (
            <button type="button" className="ds-btn small" onClick={props.onInvite}>
              Invite
            </button>
          )}
        </div>
        {props.region && <span className="rm-region">{props.region}</span>}
      </header>
      <p className="rm-notice" aria-live="polite">
        {props.notice ?? ''}
      </p>
      <div className="rm-body">
        {side('red', map.red)}
        <section className="rm-mid" aria-label="Room">
          {hostPanel ?? (
            <div className="rm-panel">
              <h2 className="rm-panel-h">Room</h2>
              <p className="rm-line">{settings ? settingsLine(settings) : `${capacity} seats · drivers pick a side`}</p>
            </div>
          )}
          <div className="rm-panel">
            <div className="rm-panel-row">
              <h2 className="rm-panel-h">
                Spectators{' '}
                {props.watchersKnown && (
                  <span className="rm-count">
                    {shownWatchers.length}/{props.watcherCap}
                  </span>
                )}
              </h2>
              {props.canWatch && !watchingNow && (
                <button type="button" className="ds-btn small" disabled={props.watchersKnown && shownWatchers.length >= props.watcherCap} onClick={props.onWatch}>
                  Watch
                </button>
              )}
            </div>
            <ul className="rm-watchers">
              {!props.watchersKnown ? (
                <li className="rm-empty">This server doesn’t list them</li>
              ) : shownWatchers.length === 0 ? (
                <li className="rm-empty">Nobody is watching</li>
              ) : (
                shownWatchers.map((w) => (
                  <li key={w.id} className={`rm-watcher${w.id === myId ? ' mine' : ''}`}>
                    {w.name}
                    {w.id === myId ? ' (you)' : ''}
                    {props.bubbles[w.id] !== undefined && <span className="rm-bubble">{ROOM_REACTIONS[props.bubbles[w.id]]}</span>}
                  </li>
                ))
              )}
            </ul>
          </div>
          {props.onReact && (
            <div className="rm-reacts" role="group" aria-label="Reactions">
              {ROOM_REACTIONS.map((r, k) => (
                <button key={r} type="button" className="ds-btn small" disabled={props.reactBusy} onClick={() => props.onReact?.(k)}>
                  {r}
                </button>
              ))}
            </div>
          )}
        </section>
        {side('blue', map.blue)}
      </div>
      <footer className="rm-bar">
        <div className="rm-bar-text">
          <span className="rm-status" aria-live="polite">
            {props.bar.status}
          </span>
          <span className={`rm-bar-line${props.bar.error ? ' err' : ''}`} aria-live="polite">
            {props.bar.error ? `⚠ ${props.bar.error}` : (props.bar.warn ?? '')}
          </span>
        </div>
        {/* START BEFORE READY, so READY never moves: it is the one control every driver has, and a
            crown that passes to you puts START beside it rather than under your cursor. */}
        {props.bar.start && (
          <button type="button" className="ds-cta rm-cta" disabled={props.bar.start.disabled} onClick={props.bar.start.onClick}>
            {props.bar.start.label}
          </button>
        )}
        {props.bar.ready && (
          <button
            type="button"
            className={`ds-cta rm-cta${props.bar.ready.on ? ' secondary' : ''}`}
            aria-pressed={props.bar.ready.on}
            disabled={props.bar.ready.disabled}
            onClick={props.bar.ready.onClick}
          >
            {props.bar.ready.on ? '✓ READY' : 'READY UP'}
          </button>
        )}
      </footer>
      {props.drawerOpen && (
        <>
          <div className="rm-scrim" onClick={props.onCloseDrawer} aria-hidden="true" />
          <aside className="rm-drawer" role="dialog" aria-modal="true" aria-label="Your setup">
            <div className="rm-drawer-h">
              <h2 className="ds-dialog-title">Your setup</h2>
              <button type="button" className="ds-btn primary" onClick={props.onCloseDrawer}>
                Done
              </button>
            </div>
            <div className="rm-drawer-body">{props.drawer}</div>
          </aside>
        </>
      )}
    </div>
  );
}

/**
 * THE HOST'S SETTINGS, beside the seats they shape. Every control is a segment (`.ds-seg`), so a
 * change recolours a button and moves nothing. A full side cannot shrink (the server refuses it),
 * and says so on the button (`shrinkState`).
 */
function HostPanel({
  host,
  players,
  capacity,
  bots,
}: {
  host: RoomHostPanel;
  players: LobbyPlayer[];
  capacity: number;
  bots: RoomBots | null;
}) {
  const set = host.settings;
  if (!set) {
    return host.onUnlock ? (
      <div className="rm-panel">
        <h2 className="rm-panel-h">Room</h2>
        <p className="rm-line">Seats and sides are fixed for a record run. Unlocking makes this an ordinary room that posts no records.</p>
        <div className="ds-segs">
          <button type="button" className="ds-seg" onClick={host.onUnlock}>
            Unlock settings
          </button>
        </div>
      </div>
    ) : null;
  }
  const seg = (on: boolean, label: string, onClick: () => void, disabled = false, title?: string) => (
    <button type="button" className={`ds-seg${on ? ' on' : ''}`} aria-pressed={on} disabled={disabled} title={title} onClick={onClick}>
      {label}
    </button>
  );
  return (
    <div className="rm-panel">
      <h2 className="rm-panel-h">Room settings</h2>
      <dl className="rm-set">
        {(['red', 'blue'] as const).map((a) => {
          const fewer = shrinkState(players, set, a);
          return (
            <div key={a} className="rm-set-row">
              <dt>{a === 'red' ? 'Red seats' : 'Blue seats'}</dt>
              <dd className="rm-step">
                <button
                  type="button"
                  className="ds-btn small"
                  aria-label={fewer.reason ? `Fewer ${a} seats. ${fewer.reason}` : `Fewer ${a} seats`}
                  title={fewer.reason ?? undefined}
                  disabled={fewer.disabled}
                  onClick={() => host.onSettings({ perAlliance: { ...set.perAlliance, [a]: set.perAlliance[a] - 1 } })}
                >
                  −
                </button>
                <span className="rm-step-v" aria-live="polite">
                  {set.perAlliance[a]}
                </span>
                <button
                  type="button"
                  className="ds-btn small"
                  aria-label={`More ${a} seats`}
                  disabled={capacity >= ROOM_CAPACITY}
                  onClick={() => host.onSettings({ perAlliance: { ...set.perAlliance, [a]: set.perAlliance[a] + 1 } })}
                >
                  +
                </button>
              </dd>
            </div>
          );
        })}
        <div className="rm-set-row">
          <dt>Sides</dt>
          <dd className="ds-segs">
            {seg(set.teamSwitch, 'Drivers pick', () => host.onSettings({ teamSwitch: true }))}
            {seg(!set.teamSwitch, 'Host places', () => host.onSettings({ teamSwitch: false }))}
          </dd>
        </div>
        {host.runLength && (
          <div className="rm-set-row">
            <dt>Run</dt>
            <dd className="ds-segs">
              {seg(set.runLength !== 'auto', 'Full match', () => host.onSettings({ runLength: 'full' }))}
              {seg(set.runLength === 'auto', 'Auto only', () => host.onSettings({ runLength: 'auto' }))}
            </dd>
          </div>
        )}
        {host.visibility && (
          <div className="rm-set-row">
            <dt>Show in Browse</dt>
            <dd className="ds-segs">
              {seg(!set.listed, 'Private', () => host.onSettings({ listed: false }))}
              {seg(set.listed, 'Public', () => host.onSettings({ listed: true }), !host.signedIn, host.signedIn ? undefined : 'Sign in to make a room public')}
            </dd>
          </div>
        )}
        {bots && (
          <div className="rm-set-row">
            <dt>New bots</dt>
            <dd className="ds-segs">
              {bots.tiers.map((t) => (
                <button key={t} type="button" className={`ds-seg${bots.tier === t ? ' on' : ''}`} aria-pressed={bots.tier === t} onClick={() => bots.onTier(t)}>
                  {botLabel(t)}
                </button>
              ))}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
