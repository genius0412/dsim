/**
 * The small pieces every competition page draws: a driver's name (with the badge every name
 * carries, `docs/area/accounts.md`), an entry, a match's two alliances and its score, a status
 * badge. One spelling each, so the schedule, the rankings and the bracket cannot disagree about
 * what an entry looks like.
 */
import type { ReactNode } from 'react';
import { SupporterBadge } from './SupporterBadge';
import { BadgeMarks } from './BadgeMark';
import { CARD_LABEL, DQ_REASON_LABEL, STATUS_LABEL, bonusLabel, statusTone } from '../competition/copy';
import { colourIn } from '../competition/rankings';
import type { CompStatus, CompSlot, CompResult, DqReason, EffectiveDq, MatchRp } from '../competition/types';
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

/** one entry's card in one match, the sim's and the referee's together: `colourIn`, the same rule that decides what it does */
export const cardOf = colourIn;

/**
 * Who takes nothing from a match, and why. `dqEffective` (cards and their escalation included)
 * when the server sent it; otherwise the match's own `dq` list, which is all an older server or a
 * playoff match has.
 */
export function dqOf(m: Pick<CompMatchView, 'dq' | 'dqEffective'>): Map<number, DqReason> {
  const eff: EffectiveDq[] = m.dqEffective ?? m.dq.map((entry) => ({ entry, why: 'dq' as const }));
  return new Map(eff.map((d) => [d.entry, d.why]));
}

/**
 * One alliance of a match, by entry name, in alliance ink. A disqualified entry is struck through
 * and says why; a card shown in a qualification match is a chip beside the name. The chip for the
 * card that caused the DQ is left out (the reason already names it).
 */
export function Side({
  m,
  alliance,
  entries,
  mine,
}: {
  m: CompMatchView;
  alliance: 'red' | 'blue';
  entries: Map<number, CompEntryView>;
  mine: number | null;
}) {
  const slots = m[alliance];
  if (!slots.length) return <span className="ds-muted">—</span>;
  const out = dqOf(m);
  // cards only count in qualifications (a playoff card goes to the alliance, which DSIM does not model)
  const cards = m.stage === 'qual';
  return (
    <span className={`ds-comp-side ${alliance}`}>
      {slots.map((s: CompSlot, i) => {
        const e = entries.get(s.entry);
        const why = out.get(s.entry) ?? null;
        const card = cards ? cardOf(m, s.entry) : null;
        const cardShown = card && why !== 'red' && why !== 'yellow2';
        return (
          <span key={`${s.entry}-${i}`} className={s.entry === mine ? 'me' : undefined}>
            <span className={why ? 'dq' : undefined}>{e?.name ?? `#${s.entry}`}</span>
            {s.surrogate && <span className="sur"> (surrogate)</span>}
            {why && (
              <>
                {' '}
                <span className="ds-badge danger">{DQ_REASON_LABEL[why]}</span>
              </>
            )}
            {cardShown && (
              <>
                {' '}
                <span className={`ds-badge ${card === 'red' ? 'danger' : 'warn'}`}>{CARD_LABEL[card]}</span>
              </>
            )}
          </span>
        );
      })}
    </span>
  );
}

/** "Movement RP and Goal RP", or "no bonus RP" */
const bonusWords = (ids: string[]): string =>
  ids.length ? ids.map(bonusLabel).join(ids.length === 2 ? ' and ' : ', ') : 'no bonus RP';

/**
 * "88 – 54", the winner heavier; a forfeit says so; nothing yet is a dash. A qualification match
 * adds the ranking points each alliance took, as a line under the score; which bonus RPs they
 * were is spoken (`.ds-sr`) and in the tooltip, because a touch or keyboard user never sees a title.
 */
export function ScoreCell({
  r,
  rp,
  slots,
}: {
  r: CompResult | null;
  rp?: MatchRp | null;
  /** the match's alliances, so a side whose every entry was disqualified shows what it took (0) */
  slots?: Record<'red' | 'blue', CompSlot[]>;
}): ReactNode {
  if (!r) return <span className="ds-muted">—</span>;
  const line = rp ? <RpLine rp={rp} slots={slots} /> : null;
  if (r.source === 'forfeit' || r.red === null || r.blue === null) {
    return (
      <>
        <span className="ds-comp-score">{r.winner === 'tie' ? 'Tie' : `${r.winner === 'red' ? 'Red' : 'Blue'} by forfeit`}</span>
        {line}
      </>
    );
  }
  return (
    <>
      <span className="ds-comp-score">
        <span className={`red${r.winner === 'red' ? ' w' : ''}`}>{r.red}</span>
        <span className="ds-muted"> – </span>
        <span className={`blue${r.winner === 'blue' ? ' w' : ''}`}>{r.blue}</span>
        {r.source === 'manual' && <span className="ds-muted"> (entered)</span>}
      </span>
      {line}
    </>
  );
}

/**
 * THE RANKING POINTS A SIDE TOOK from a qualification match: the alliance's, unless every entry on it
 * that counts was disqualified (a 1v1, or both of a 2v2's), when they took 0 and the alliance number
 * would say otherwise. A surrogate takes nothing toward its own ranking but is no reason to hide it.
 */
export function takenRp(rp: MatchRp, slots: Record<'red' | 'blue', CompSlot[]> | undefined, a: 'red' | 'blue'): { total: number; words: string } {
  const own = rp.alliance[a];
  const counted = (slots?.[a] ?? []).filter((x) => !x.surrogate);
  const out = counted.length > 0 && own.total > 0 && counted.every((x) => rp.entries[String(x.entry)] === 0);
  return out ? { total: 0, words: 'disqualified' } : { total: own.total, words: bonusWords(own.bonus) };
}

function RpLine({ rp, slots }: { rp: MatchRp; slots?: Record<'red' | 'blue', CompSlot[]> }) {
  const side = (a: 'red' | 'blue') => takenRp(rp, slots, a);
  const red = side('red');
  const blue = side('blue');
  const said = `Ranking points: red ${red.total} (${red.words}), blue ${blue.total} (${blue.words}).`;
  return (
    <span className="ds-comp-rp" title={said}>
      <span aria-hidden="true">
        RP {red.total} – {blue.total}
      </span>
      <span className="ds-sr">{said}</span>
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
