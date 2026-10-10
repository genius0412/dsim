import { useEffect, useMemo, useState } from 'react';
import { compAction, createCompetition, fetchCompetition } from '../net/competitions';
import type { CompEditInput, CompetitionDetail } from '../competition/wire';
import type { CompFormat, CompSettings, RpLevel, RpScheme, TeamMode, Tiebreaker } from '../competition/types';
import { TIEBREAKERS } from '../competition/types';
import {
  BEST_OF,
  DEFAULT_SETTINGS,
  LIMITS,
  PLAYOFF_SIZES,
  RP_SCHEMES,
  coerceCompSettings,
  entriesPerAlliance,
  playoffEntriesNeeded,
} from '../competition/settings';
import { cmTable, effectiveRanking, levelsOf, thresholdAt, tiebreakersFor, unreachableBonus } from '../competition/manual';
import {
  BRACKET_LABEL,
  LEVEL_LABEL,
  QUAL_LABEL,
  SCHEME_LABEL,
  SELECTION_LABEL,
  TIEBREAK_LABEL,
  bonusLabel,
  measureLabel,
} from '../competition/copy';
import type { GameId } from '../games/types';
import { SEASONS } from '../seasons';
import { gameVisible } from '../seasonVisibility';
import { OptRow } from './OptRow';
import { unreachableLine } from './compBits';

/** a datetime-local value for an epoch, in the viewer's own zone, and back */
const toLocal = (ms: number | null): string => {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocal = (v: string): number | null => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

interface Draft {
  name: string;
  game: GameId;
  format: CompFormat;
  teamMode: TeamMode;
  visibility: 'public' | 'unlisted';
  summary: string;
  description: string;
  rules: string;
  capacity: number;
  region: string;
  regOpensAt: number | null;
  regClosesAt: number | null;
  checkinOpensAt: number | null;
  startsAt: number | null;
  settings: CompSettings;
}

/**
 * CREATE OR EDIT A COMPETITION. The form is every field `server/competitions.ts readEdit` takes,
 * and the server is the judge: a field that can no longer change (the shape once people have
 * entered, the qualification settings once they start) is refused there with a sentence, so
 * this form disables it too but does not have to be right about it.
 */
export function CompEditor({
  slug,
  game,
  onDone,
  onCancel,
}: {
  /** editing this competition; null creates one */
  slug: string | null;
  /** the season selected in the app: a new competition defaults to it */
  game: GameId;
  onDone: (slug: string) => void;
  onCancel: () => void;
}) {
  const [loaded, setLoaded] = useState<CompetitionDetail | null>(null);
  const [d, setD] = useState<Draft | null>(
    slug
      ? null
      : {
          name: '',
          game,
          format: '1v1',
          teamMode: 'solo',
          visibility: 'public',
          summary: '',
          description: '',
          rules: '',
          capacity: 16,
          region: '',
          regOpensAt: null,
          regClosesAt: null,
          checkinOpensAt: null,
          startsAt: null,
          settings: coerceCompSettings(DEFAULT_SETTINGS, '1v1', 'solo', game),
        },
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // a custom threshold's text while it is being typed: an emptied field would otherwise snap back
  // to the coerced number under the cursor. Dropped on blur, when the field shows the stored value.
  const [thrText, setThrText] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!slug) return;
    let alive = true;
    fetchCompetition(slug)
      .then((c) => {
        if (!alive) return;
        setLoaded(c);
        const x = c.competition;
        setD({
          name: x.name,
          game: x.game,
          format: x.format,
          teamMode: x.teamMode,
          visibility: x.visibility,
          summary: x.summary,
          description: x.description,
          rules: x.rules,
          capacity: x.capacity,
          region: x.region ?? '',
          regOpensAt: x.regOpensAt,
          regClosesAt: x.regClosesAt,
          checkinOpensAt: x.checkinOpensAt,
          startsAt: x.startsAt,
          // an older server's settings have no `rp`: coerced here they read as what it ranks by
          settings: coerceCompSettings(x.settings, x.format, x.teamMode, x.game),
        });
      })
      .catch((e: unknown) => alive && setErr(e instanceof Error ? e.message : 'Couldn’t load it.'));
    return () => {
      alive = false;
    };
  }, [slug]);

  const status = loaded?.competition.status ?? 'draft';
  const entered = loaded ? loaded.entries.filter((e) => e.status !== 'withdrawn').length : 0;
  const shapeLocked = !!loaded && (entered > 0 || (status !== 'draft' && status !== 'published'));
  const qualsLocked = status !== 'draft' && status !== 'published';
  const playoffsLocked = status === 'playoffs' || status === 'completed' || status === 'cancelled';
  const pointsLocked = status === 'selection' || playoffsLocked;
  // the scheme, level and thresholds freeze when qualifications START (the server copies the
  // resolved table then); the organizer's own points and tiebreakers keep their later lock
  const rpLocked = qualsLocked;
  const visibleGames = useMemo(() => SEASONS.filter((s) => gameVisible(s.key)), []);

  if (!d) {
    return (
      <div className="ds-comp">
        <div className="ds-panel">{err ? <div className="ds-empty"><div className="big">Couldn’t load it</div>{err}</div> : <div className="ds-loading">Loading…</div>}</div>
      </div>
    );
  }

  const put = (p: Partial<Draft>): void => {
    const next = { ...d, ...p };
    // the shape decides which settings exist (round robin needs one entry per alliance, …)
    next.teamMode = next.format === '2v2' ? next.teamMode : 'solo';
    next.settings = coerceCompSettings(next.settings, next.format, next.teamMode, next.game);
    setD(next);
  };
  const putS = (fn: (s: CompSettings) => CompSettings): void => put({ settings: fn(structuredClone(d.settings)) });
  const s = d.settings;
  const per = entriesPerAlliance(d.format, d.teamMode);
  const needForPlayoffs = playoffEntriesNeeded(s, d.format, d.teamMode);
  // THE RANKING-POINT SCHEME. A game with no manual table has no choice to make (`custom` only),
  // so the scheme row is not drawn at all; a column of Table 10-3 the manual has not published
  // is not offered, and the line under the row says why.
  const table = cmTable(d.game);
  const cm = s.rp.scheme === 'cm' ? table : null;
  const levels = levelsOf(d.game);
  const tba = (['regional', 'championship'] as const).filter((l) => !levels.includes(l));
  const unpublished =
    tba.length === 2 ? 'Regional and FIRST Championship thresholds aren’t published yet.' : tba.length === 1 ? `${LEVEL_LABEL[tba[0]]} thresholds aren’t published yet.` : null;
  const unreachable = cm ? unreachableBonus(effectiveRanking(s, d.game), d.game, d.format) : [];

  const save = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    const input: CompEditInput = {
      name: d.name.trim(),
      summary: d.summary.trim(),
      description: d.description,
      rules: d.rules,
      visibility: d.visibility,
      capacity: d.capacity,
      region: d.region.trim() || null,
      regOpensAt: d.regOpensAt,
      regClosesAt: d.regClosesAt,
      checkinOpensAt: d.checkinOpensAt,
      startsAt: d.startsAt,
      settings: d.settings,
      ...(shapeLocked ? {} : { game: d.game, format: d.format, teamMode: d.teamMode }),
    };
    try {
      if (slug) {
        await compAction(slug, 'update', input as Record<string, unknown>);
        onDone(slug);
      } else {
        const made = await createCompetition(input);
        onDone(made.slug);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Couldn’t save it. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const toggleTb = (t: Tiebreaker): void =>
    putS((x) => ({ ...x, tiebreakers: x.tiebreakers.includes(t) ? x.tiebreakers.filter((y) => y !== t) : [...x.tiebreakers, t] }));

  return (
    <div className="ds-comp">
      <button className="ds-back" onClick={onCancel}>
        ← {slug ? 'Back to the competition' : 'Competitions'}
      </button>
      <h1 className="ds-h1">{slug ? `Edit ${loaded?.competition.name ?? ''}` : 'New competition'}</h1>

      <div className="ds-panel">
        <div className="ds-panel-h">
          <h2 className="ds-panel-title">The basics</h2>
        </div>
        <div className="ds-panel-body ds-form ds-comp-grid">
          <label className="wide">
            <span>Name</span>
            <input className="ds-input" value={d.name} maxLength={LIMITS.name.max} onChange={(e) => put({ name: e.target.value })} />
          </label>
          <label className="wide">
            <span>One-line summary (on the list)</span>
            <input className="ds-input" value={d.summary} maxLength={LIMITS.summary.max} onChange={(e) => put({ summary: e.target.value })} />
          </label>
          <label>
            <span>Game</span>
            <select className="ds-select" value={d.game} disabled={shapeLocked} onChange={(e) => put({ game: e.target.value as GameId })}>
              {visibleGames.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Capacity (entries)</span>
            <input
              className="ds-input"
              inputMode="numeric"
              value={String(d.capacity)}
              disabled={qualsLocked}
              onChange={(e) => put({ capacity: Math.min(LIMITS.capacity.max, Number(e.target.value.replace(/[^0-9]/g, '')) || 0) })}
            />
          </label>
          <div className="wide">
            <OptRow
              label="Format"
              value={`${d.format}:${d.teamMode}`}
              disabled={shapeLocked}
              options={[
                { v: '1v1:solo', t: '1v1' },
                { v: '2v2:solo', t: '2v2, alliances drawn' },
                { v: '2v2:duo', t: '2v2, duos' },
              ]}
              onPick={(v) => {
                const [f, t] = v.split(':');
                put({ format: f as CompFormat, teamMode: t as TeamMode });
              }}
            />
          </div>
          <div className="wide">
            <OptRow
              label="Listed"
              value={d.visibility}
              options={[
                { v: 'public', t: 'Public' },
                { v: 'unlisted', t: 'Link only' },
              ]}
              onPick={(v) => put({ visibility: v as 'public' | 'unlisted' })}
            />
          </div>
        </div>
      </div>

      <div className="ds-panel">
        <div className="ds-panel-h">
          <h2 className="ds-panel-title">Dates</h2>
        </div>
        <div className="ds-panel-body ds-form ds-comp-grid">
          <label>
            <span>Starts (shown on the page)</span>
            <input type="datetime-local" className="ds-input" value={toLocal(d.startsAt)} onChange={(e) => put({ startsAt: fromLocal(e.target.value) })} />
          </label>
          <label>
            <span>Registration opens (blank: when published)</span>
            <input type="datetime-local" className="ds-input" value={toLocal(d.regOpensAt)} onChange={(e) => put({ regOpensAt: fromLocal(e.target.value) })} />
          </label>
          <label>
            <span>Registration closes (blank: at the start)</span>
            <input type="datetime-local" className="ds-input" value={toLocal(d.regClosesAt)} onChange={(e) => put({ regClosesAt: fromLocal(e.target.value) })} />
          </label>
          <label>
            <span>Check-in opens (blank: any time)</span>
            <input type="datetime-local" className="ds-input" value={toLocal(d.checkinOpensAt)} disabled={!s.checkIn} onChange={(e) => put({ checkinOpensAt: fromLocal(e.target.value) })} />
          </label>
          <div className="wide">
            <Toggle label="Check-in required" value={s.checkIn} disabled={qualsLocked} onPick={(v) => putS((x) => ({ ...x, checkIn: v }))} />
          </div>
        </div>
      </div>

      <div className="ds-panel">
        <div className="ds-panel-h">
          <h2 className="ds-panel-title">Qualifications</h2>
        </div>
        <div className="ds-panel-body ds-form ds-comp-grid">
          <div className="wide">
            <OptRow
              label="Schedule"
              value={s.quals.kind}
              disabled={qualsLocked}
              options={(['balanced', 'roundRobin', 'swiss', 'none'] as const)
                .filter((k) => per === 1 || (k !== 'roundRobin' && k !== 'swiss'))
                .map((k) => ({ v: k, t: QUAL_LABEL[k] }))}
              onPick={(v) => putS((x) => ({ ...x, quals: { ...x.quals, kind: v as CompSettings['quals']['kind'] } }))}
            />
          </div>
          {s.quals.kind !== 'none' && (
            <label>
              <span>{s.quals.kind === 'roundRobin' ? 'Cycles' : s.quals.kind === 'swiss' ? 'Rounds' : 'Matches per entry'}</span>
              <input
                className="ds-input"
                inputMode="numeric"
                value={String(s.quals.matchesPerEntry)}
                disabled={qualsLocked}
                onChange={(e) => putS((x) => ({ ...x, quals: { ...x.quals, matchesPerEntry: Number(e.target.value.replace(/[^0-9]/g, '')) || 1 } }))}
              />
            </label>
          )}
          {s.quals.kind === 'balanced' && (
            <label>
              <span>Matches between one entry’s appearances (at least)</span>
              <input
                className="ds-input"
                inputMode="numeric"
                value={String(s.quals.minGap)}
                disabled={qualsLocked}
                onChange={(e) => putS((x) => ({ ...x, quals: { ...x.quals, minGap: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 } }))}
              />
            </label>
          )}
          {s.quals.kind !== 'none' && (
            <>
              {table && (
                <div className="wide">
                  <OptRow
                    label="Ranking points"
                    value={s.rp.scheme}
                    disabled={rpLocked}
                    options={RP_SCHEMES.map((k) => ({
                      v: k,
                      t: SCHEME_LABEL[k],
                      d: k === 'cm' ? `Win ${table.win} · tie ${table.tie}${table.bonus.length ? ' · bonus RPs' : ''}` : 'Your own points and tiebreakers',
                    }))}
                    onPick={(v) => putS((x) => ({ ...x, rp: { ...x.rp, scheme: v as RpScheme } }))}
                  />
                </div>
              )}
              {cm && cm.bonus.length > 0 && (
                <>
                  <div className="wide">
                    <OptRow
                      label="Bonus RP thresholds"
                      value={s.rp.level}
                      disabled={rpLocked}
                      options={levels.map((l) => ({ v: l, t: LEVEL_LABEL[l], d: cm.bonus.map((b) => thresholdAt(b, l, s.rp.thresholds)).join(' · ') }))}
                      onPick={(v) => putS((x) => ({ ...x, rp: { ...x.rp, level: v as RpLevel } }))}
                    />
                  </div>
                  {unpublished && <p className="ds-hint wide">{unpublished}</p>}
                  {s.rp.level === 'custom' &&
                    cm.bonus.map((b) => (
                      <label key={b.id}>
                        <span>
                          {bonusLabel(b.id)}: {measureLabel(b.measure)}
                        </span>
                        <input
                          className="ds-input"
                          inputMode="numeric"
                          value={thrText[b.id] ?? String(thresholdAt(b, 'custom', s.rp.thresholds))}
                          disabled={rpLocked}
                          onChange={(e) => {
                            const t = e.target.value.replace(/[^0-9]/g, '').slice(0, 3);
                            setThrText((x) => ({ ...x, [b.id]: t }));
                            if (t) putS((x) => ({ ...x, rp: { ...x.rp, thresholds: { ...x.rp.thresholds, [b.id]: Number(t) } } }));
                          }}
                          onBlur={() =>
                            setThrText((x) => {
                              const next = { ...x };
                              delete next[b.id];
                              return next;
                            })
                          }
                        />
                      </label>
                    ))}
                  {unreachable.length > 0 && <p className="ds-hint warn wide">{unreachableLine(d.game, unreachable)}</p>}
                </>
              )}
              {!cm && (
                <>
                  <label>
                    <span>Points: win · tie · loss</span>
                    <span className="ds-field-row">
                      {(['win', 'tie', 'loss'] as const).map((k) => (
                        <input
                          key={k}
                          className="ds-input"
                          inputMode="numeric"
                          aria-label={`Points for a ${k}`}
                          value={String(s.points[k])}
                          disabled={pointsLocked}
                          onChange={(e) => putS((x) => ({ ...x, points: { ...x.points, [k]: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 } }))}
                        />
                      ))}
                    </span>
                  </label>
                  <div className="wide ds-comp-stack">
                    <span className="ds-hint">Tiebreakers, in order (after the ranking score)</span>
                    <span className="ds-comp-tags">
                      {tiebreakersFor(d.game, TIEBREAKERS).map((t) => {
                        const i = s.tiebreakers.indexOf(t);
                        return (
                          <button key={t} type="button" className={`ds-btn small${i >= 0 ? '' : ' ghost'}`} aria-pressed={i >= 0} disabled={pointsLocked} onClick={() => toggleTb(t)}>
                            {i >= 0 ? `${i + 1}. ` : ''}
                            {TIEBREAK_LABEL[t]}
                          </button>
                        );
                      })}
                    </span>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <div className="ds-panel">
        <div className="ds-panel-h">
          <h2 className="ds-panel-title">Playoffs</h2>
        </div>
        <div className="ds-panel-body ds-form ds-comp-grid">
          {s.quals.kind !== 'none' && (
            <div className="wide">
              <Toggle label="Playoffs after qualifications" value={s.playoffs.enabled} disabled={playoffsLocked} onPick={(v) => putS((x) => ({ ...x, playoffs: { ...x.playoffs, enabled: v } }))} />
            </div>
          )}
          {s.playoffs.enabled && (
            <>
              <div className="wide">
                <OptRow
                  label={per === 2 ? 'Alliances' : 'Entries that advance'}
                  value={String(s.playoffs.alliances)}
                  disabled={playoffsLocked}
                  options={PLAYOFF_SIZES.map((n) => ({ v: String(n), t: String(n) }))}
                  onPick={(v) => putS((x) => ({ ...x, playoffs: { ...x.playoffs, alliances: Number(v) as 2 | 4 | 8 | 16 } }))}
                />
              </div>
              <div className="wide">
                <OptRow
                  label="Bracket"
                  value={s.playoffs.format}
                  disabled={playoffsLocked}
                  options={(['single', 'double'] as const).map((f) => ({ v: f, t: BRACKET_LABEL[f] }))}
                  onPick={(v) => putS((x) => ({ ...x, playoffs: { ...x.playoffs, format: v as 'single' | 'double' } }))}
                />
              </div>
              <div className="wide">
                <OptRow
                  label="Each series"
                  value={String(s.playoffs.bestOf)}
                  disabled={playoffsLocked}
                  options={BEST_OF.map((n) => ({ v: String(n), t: n === 1 ? 'One game' : `Best of ${n}` }))}
                  onPick={(v) => putS((x) => ({ ...x, playoffs: { ...x.playoffs, bestOf: Number(v) as 1 | 3 | 5 } }))}
                />
              </div>
              <div className="wide">
                <OptRow
                  label="The final"
                  value={String(s.playoffs.finalsBestOf)}
                  disabled={playoffsLocked}
                  options={BEST_OF.map((n) => ({ v: String(n), t: n === 1 ? 'One game' : `Best of ${n}` }))}
                  onPick={(v) => putS((x) => ({ ...x, playoffs: { ...x.playoffs, finalsBestOf: Number(v) as 1 | 3 | 5 } }))}
                />
              </div>
              {per === 2 && (
                <div className="wide">
                  <OptRow
                    label="How alliances form"
                    value={s.playoffs.selection}
                    disabled={playoffsLocked}
                    options={(['captains', 'serpentine'] as const).map((m) => ({ v: m, t: SELECTION_LABEL[m] }))}
                    onPick={(v) => putS((x) => ({ ...x, playoffs: { ...x.playoffs, selection: v as 'captains' | 'serpentine' } }))}
                  />
                </div>
              )}
              {d.capacity < needForPlayoffs && (
                <p className="ds-hint warn wide">
                  The playoffs need {needForPlayoffs} entries, more than the capacity of {d.capacity}.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="ds-panel">
        <div className="ds-panel-h">
          <h2 className="ds-panel-title">Running matches</h2>
        </div>
        <div className="ds-panel-body ds-form ds-comp-grid">
          <label>
            <span>Minutes a called match waits for its drivers</span>
            <input
              className="ds-input"
              inputMode="numeric"
              value={String(Math.round(s.run.joinGraceSec / 60))}
              onChange={(e) => putS((x) => ({ ...x, run: { ...x.run, joinGraceSec: (Number(e.target.value.replace(/[^0-9]/g, '')) || 1) * 60 } }))}
            />
          </label>
          <label>
            <span>Seconds a driver rests between matches</span>
            <input
              className="ds-input"
              inputMode="numeric"
              value={String(s.run.restSec)}
              onChange={(e) => putS((x) => ({ ...x, run: { ...x.run, restSec: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 } }))}
            />
          </label>
          <label>
            <span>Matches called at once</span>
            <input
              className="ds-input"
              inputMode="numeric"
              value={String(s.run.maxConcurrent)}
              onChange={(e) => putS((x) => ({ ...x, run: { ...x.run, maxConcurrent: Number(e.target.value.replace(/[^0-9]/g, '')) || 1 } }))}
            />
          </label>
          <label>
            <span>Host region (blank: the main one)</span>
            <input className="ds-input" value={d.region} maxLength={3} placeholder="iad" onChange={(e) => put({ region: e.target.value.toLowerCase().replace(/[^a-z]/g, '') })} />
          </label>
          <div className="wide">
            <OptRow
              label="A driver who never arrives"
              value={s.run.noShow}
              options={[
                { v: 'hold', t: 'The referee decides' },
                { v: 'forfeit', t: 'Their alliance forfeits' },
              ]}
              onPick={(v) => putS((x) => ({ ...x, run: { ...x.run, noShow: v === 'forfeit' ? 'forfeit' : 'hold' } }))}
            />
          </div>
          <div className="wide">
            <Toggle label="Call matches automatically" value={s.run.autoCall} onPick={(v) => putS((x) => ({ ...x, run: { ...x.run, autoCall: v } }))} />
          </div>
        </div>
      </div>

      <div className="ds-panel">
        <div className="ds-panel-h">
          <h2 className="ds-panel-title">Page text</h2>
        </div>
        <div className="ds-panel-body ds-form">
          <label>
            <span>About (Markdown)</span>
            <textarea className="ds-input ds-comp-textarea" value={d.description} maxLength={LIMITS.description.max} onChange={(e) => put({ description: e.target.value })} />
          </label>
          <label>
            <span>Rules (Markdown)</span>
            <textarea className="ds-input ds-comp-textarea" value={d.rules} maxLength={LIMITS.rules.max} onChange={(e) => put({ rules: e.target.value })} />
          </label>
        </div>
      </div>

      {err && (
        <p className="ds-hint err" role="alert">
          {err}
        </p>
      )}
      <div className="ds-actions">
        <button className="ds-btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="ds-btn primary" disabled={busy || d.name.trim().length < LIMITS.name.min || d.capacity < LIMITS.capacity.min} onClick={() => void save()}>
          {slug ? 'Save changes' : 'Create draft'}
        </button>
      </div>
    </div>
  );
}

/** an Off / On row that can be held (`ToggleRow` has no disabled state; a locked setting greys) */
function Toggle({ label, value, disabled, onPick }: { label: string; value: boolean; disabled?: boolean; onPick: (v: boolean) => void }) {
  return (
    <OptRow<boolean>
      label={label}
      value={value}
      cols="two"
      mini
      disabled={disabled}
      onPick={onPick}
      options={[
        { v: false, t: 'Off' },
        { v: true, t: 'On' },
      ]}
    />
  );
}
