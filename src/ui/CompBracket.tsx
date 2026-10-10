import type { CompetitionDetail, CompEntryView } from '../competition/wire';
import type { BracketSide, PlayoffAlliance, SeriesState } from '../competition/types';
import { compAction } from '../net/competitions';
import { entriesPerAlliance } from '../competition/settings';
import { SELECTION_LABEL } from '../competition/copy';
import type { Run } from './CompDetail';

const SIDE_LABEL: Record<BracketSide, string> = { upper: 'Upper bracket', lower: 'Lower bracket', final: 'Final' };

/**
 * THE PLAYOFFS TAB: alliance selection while it runs, then the alliances and the bracket.
 *
 * The bracket is drawn from `SeriesState` alone (derived on the server from the matches), so
 * what is on screen is exactly what the next match will be built from. Each side is its own row
 * of round columns; a single-elimination bracket has only an upper side and its final.
 */
export function CompPlayoffs({
  data,
  entries,
  run,
  busy,
  slug,
}: {
  data: CompetitionDetail;
  entries: Map<number, CompEntryView>;
  run: Run;
  busy: boolean;
  slug: string;
  onProfile: (u: string) => void;
}) {
  const c = data.competition;
  const name = (id: number): string => entries.get(id)?.name ?? `#${id}`;
  const alliances = data.alliances ?? [];
  const bySeed = new Map(alliances.map((a) => [a.seed, a]));
  const allianceName = (seed: number | null): string => {
    if (seed === null) return 'To be decided';
    const a = bySeed.get(seed);
    return a ? a.entries.map(name).join(' & ') : `Alliance ${seed}`;
  };
  return (
    <>
      {data.selection && c.status === 'selection' && <Selection data={data} name={name} run={run} busy={busy} slug={slug} />}
      {!data.selection && c.status === 'selection' && (
        <div className="ds-panel">
          <div className="ds-panel-h">
            <h2 className="ds-panel-title">Seeding</h2>
          </div>
          <p className="ds-panel-body ds-hint">
            {entriesPerAlliance(c.format, c.teamMode) === 2
              ? `${SELECTION_LABEL[c.settings.playoffs.selection]}: the alliances below are set by the rankings.`
              : 'The top entries go through in ranking order.'}{' '}
            The bracket is built when the organizer starts the playoffs.
          </p>
        </div>
      )}
      {alliances.length > 0 && <Alliances alliances={alliances} name={name} mine={data.viewer.entryId} />}
      {data.bracket && <Bracket series={data.bracket.series} allianceName={allianceName} />}
    </>
  );
}

function Alliances({ alliances, name, mine }: { alliances: PlayoffAlliance[]; name: (id: number) => string; mine: number | null }) {
  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Alliances</h2>
      </div>
      <div className="ds-panel-body ds-opts four">
        {alliances.map((a) => (
          <div key={a.seed} className={`ds-comp-alliance${mine !== null && a.entries.includes(mine) ? ' turn' : ''}`}>
            <span className="seed">{a.seed}</span>
            <span className="ds-comp-stack">
              {a.entries.map((e, i) => (
                <span key={e}>
                  {name(e)}
                  {i === 0 && a.entries.length > 1 && <span className="ds-muted"> (captain)</span>}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** FTC alliance selection, live: whose turn it is, who is still pickable, and the picks so far */
function Selection({
  data,
  name,
  run,
  busy,
  slug,
}: {
  data: CompetitionDetail;
  name: (id: number) => string;
  run: Run;
  busy: boolean;
  slug: string;
}) {
  const sel = data.selection!;
  const v = data.viewer;
  const manager = v.role === 'admin' || v.role === 'organizer';
  const canPick = manager || v.canPick;
  const turn = sel.turn !== null ? sel.alliances[sel.turn] : null;
  const stuck = (sel as { stuck?: string }).stuck;
  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Alliance selection</h2>
        {manager && (
          <span className="ds-comp-acts">
            <button className="ds-btn ghost small" disabled={busy} onClick={() => void run(() => compAction(slug, 'selection', { action: 'undo' }))}>
              Undo last
            </button>
            <button
              className="ds-btn ghost small danger"
              disabled={busy}
              onClick={() => window.confirm('Start alliance selection over?\n\nEvery pick and decline so far is cleared.') && void run(() => compAction(slug, 'selection', { action: 'reset' }))}
            >
              Start over
            </button>
          </span>
        )}
      </div>
      <div className="ds-panel-body stack">
        <p className="ds-hint">
          {sel.complete
            ? 'Every alliance is full. The organizer starts the playoffs next.'
            : turn
              ? `Alliance ${turn.seed} is picking${v.canPick ? ': that’s you.' : '.'}`
              : (stuck ?? 'Waiting for the organizer.')}
        </p>
        <div className="ds-comp-sel">
          <div className="ds-comp-stack">
            {sel.alliances.map((a, i) => (
              <div key={a.seed} className={`ds-comp-alliance${sel.turn === i ? ' turn' : ''}`}>
                <span className="seed">{a.seed}</span>
                <span className="ds-comp-stack">
                  {a.entries.map((e) => (
                    <span key={e}>{name(e)}</span>
                  ))}
                  {a.entries.length < 2 && <span className="ds-muted">Partner to come</span>}
                </span>
              </div>
            ))}
          </div>
          <div className="ds-comp-stack">
            {sel.available.length === 0 ? (
              <p className="ds-hint">Nobody left to pick.</p>
            ) : (
              sel.available.map((e) => (
                <div key={e} className="ds-comp-alliance">
                  <span className="ds-comp-stack">{name(e)}</span>
                  {canPick && turn && (
                    <span className="ds-comp-rowacts">
                      <button className="ds-btn small" disabled={busy} onClick={() => void run(() => compAction(slug, 'pick', { entry: e }))}>
                        Pick
                      </button>
                      {manager && (
                        <button className="ds-btn ghost small" disabled={busy} onClick={() => void run(() => compAction(slug, 'pick', { entry: e, decline: true }))}>
                          Declined
                        </button>
                      )}
                    </span>
                  )}
                </div>
              ))
            )}
            {sel.declined.length > 0 && <p className="ds-hint">Declined: {sel.declined.map(name).join(', ')}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Bracket({ series, allianceName }: { series: SeriesState[]; allianceName: (seed: number | null) => string }) {
  const sides: BracketSide[] = ['upper', 'lower', 'final'];
  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Bracket</h2>
      </div>
      <div className="ds-panel-body ds-comp-bracket">
        {sides.map((side) => {
          const list = series.filter((s) => s.side === side);
          if (!list.length) return null;
          const rounds = [...new Set(list.map((s) => s.round))].sort((a, b) => a - b);
          return (
            <section key={side} className="ds-comp-stack">
              {series.some((s) => s.side === 'lower') && <h3 className="ds-comp-side-label">{SIDE_LABEL[side]}</h3>}
              <div className="ds-comp-rounds">
                {rounds.map((r) => (
                  <div key={r} className="ds-comp-round">
                    {list
                      .filter((s) => s.round === r)
                      .sort((a, b) => a.position - b.position)
                      .map((s) => (
                        <SeriesCard key={s.key} s={s} allianceName={allianceName} />
                      ))}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function SeriesCard({ s, allianceName }: { s: SeriesState; allianceName: (seed: number | null) => string }) {
  const row = (seed: number | null, wins: number, alliance: 'red' | 'blue') => {
    const state = s.winner === null ? (seed === null ? 'tbd' : '') : s.winner === seed ? 'won' : 'lost';
    return (
      <div className={`ds-comp-series-row${state ? ` ${state}` : ''}`}>
        <span className="who">
          {seed !== null && <span className="seed">{seed}</span>}
          <span className={alliance}>{allianceName(seed)}</span>
        </span>
        {s.bestOf > 1 || s.matches.length > 0 ? <span className="wins">{wins}</span> : null}
      </div>
    );
  };
  return (
    <div className="ds-comp-series">
      <div className="ds-comp-series-h">
        <span>{s.label}</span>
        <span>{s.bestOf > 1 ? `Bo${s.bestOf}` : ''}</span>
      </div>
      {row(s.red, s.redWins, 'red')}
      {row(s.blue, s.blueWins, 'blue')}
    </div>
  );
}
