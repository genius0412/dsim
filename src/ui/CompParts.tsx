/**
 * The small pieces every competition page draws: a driver's name (with the badge every name
 * carries, `docs/area/accounts.md`), an entry, a match's two alliances and its score, a status
 * badge. One spelling each, so the schedule, the rankings and the bracket cannot disagree about
 * what an entry looks like.
 */
import type { ReactNode } from 'react';
import { SupporterBadge } from './SupporterBadge';
import { BadgeMarks } from './BadgeMark';
import { STATUS_LABEL, statusTone } from '../competition/copy';
import type { CompStatus, CompSlot, CompResult } from '../competition/types';
import type { CompEntryView, CompMatchView, CompPlayer } from '../competition/wire';

/** a driver: the name (a profile link when they have a username), then the badges as siblings */
export function PlayerName({ p, onProfile }: { p: CompPlayer; onProfile?: (username: string) => void }) {
  const name = p.username ? `@${p.username}` : p.handle;
  return (
    <>
      {p.username && onProfile ? (
        <button className="mh-player link" onClick={() => onProfile(p.username as string)}>
          {name}
        </button>
      ) : (
        <span>{name}</span>
      )}
      <SupporterBadge supporter={p.supporter} role={p.role ?? null} />
      <BadgeMarks badges={p.badges} />
    </>
  );
}

/** an entry as one line: its name, then (when that is not just the driver's own name) who drives */
export function EntryLine({ e, onProfile }: { e: CompEntryView; onProfile?: (username: string) => void }) {
  const solo = e.players.length === 1 && (e.players[0].handle === e.name || `@${e.players[0].username}` === e.name);
  return (
    <span className="ds-comp-side">
      <b>{e.name}</b>
      {e.number ? <span className="ds-muted">#{e.number}</span> : null}
      {!solo &&
        e.players.map((p, i) => (
          <span key={p.userId ?? i} className="ds-muted">
            <PlayerName p={p} onProfile={onProfile} />
          </span>
        ))}
    </span>
  );
}

export function StatusBadge({ status }: { status: CompStatus }) {
  const tone = statusTone(status);
  return <span className={`ds-badge${tone ? ` ${tone}` : ''}`}>{STATUS_LABEL[status]}</span>;
}

/** one alliance of a match, by entry name, in alliance ink */
export function Side({
  slots,
  alliance,
  entries,
  dq,
  mine,
}: {
  slots: CompSlot[];
  alliance: 'red' | 'blue';
  entries: Map<number, CompEntryView>;
  dq: number[];
  mine: number | null;
}) {
  if (!slots.length) return <span className="ds-muted">—</span>;
  return (
    <span className={`ds-comp-side ${alliance}`}>
      {slots.map((s, i) => {
        const e = entries.get(s.entry);
        const cls = [dq.includes(s.entry) ? 'dq' : '', s.entry === mine ? 'me' : ''].filter(Boolean).join(' ');
        return (
          <span key={`${s.entry}-${i}`} className={cls || undefined}>
            {e?.name ?? `#${s.entry}`}
            {s.surrogate && <span className="sur"> (surrogate)</span>}
          </span>
        );
      })}
    </span>
  );
}

/** "88 – 54", the winner heavier; a forfeit says so; nothing yet is a dash */
export function ScoreCell({ r }: { r: CompResult | null }): ReactNode {
  if (!r) return <span className="ds-muted">—</span>;
  if (r.source === 'forfeit' || r.red === null || r.blue === null) {
    return <span className="ds-comp-score">{r.winner === 'tie' ? 'Tie' : `${r.winner === 'red' ? 'Red' : 'Blue'} by forfeit`}</span>;
  }
  return (
    <span className="ds-comp-score">
      <span className={`red${r.winner === 'red' ? ' w' : ''}`}>{r.red}</span>
      <span className="ds-muted"> – </span>
      <span className={`blue${r.winner === 'blue' ? ' w' : ''}`}>{r.blue}</span>
      {r.source === 'manual' && <span className="ds-muted"> (entered)</span>}
    </span>
  );
}

/** the state a match is in, as a badge: live beats called, and a result says nothing more */
export function MatchState({ m }: { m: CompMatchView }) {
  if (m.live) return <span className="ds-badge accent">Live</span>;
  if (m.status === 'called') return <span className="ds-badge warn">Called</span>;
  if (m.status === 'void') return <span className="ds-badge">Void</span>;
  if (m.status === 'done') return null;
  return <span className="ds-muted">Up next</span>;
}

/** is this entry in this match (as either alliance) */
export const inMatch = (m: Pick<CompMatchView, 'red' | 'blue'>, entry: number | null): boolean =>
  entry !== null && [...m.red, ...m.blue].some((s) => s.entry === entry);

/** which alliance an entry plays in a match */
export const allianceOf = (m: Pick<CompMatchView, 'red' | 'blue'>, entry: number): 'red' | 'blue' | null =>
  m.red.some((s) => s.entry === entry) ? 'red' : m.blue.some((s) => s.entry === entry) ? 'blue' : null;
