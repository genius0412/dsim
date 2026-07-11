import type { SeasonInfo } from '../net/api';

/**
 * Split ACT + SEASON selectors over the competitive-period list. Periods form an
 * Act → Season hierarchy (multiple seasons per act, Act 0 = beta); rather than one
 * combined `<optgroup>` picker, this exposes the two axes independently: pick an
 * act, then a season within it. `value` is the selected `balance_version`, or null
 * for the live/current period; `onChange` emits null when the current period is
 * chosen (matching the "null = live" convention the boards use). Renders nothing
 * until there is more than one period to choose between.
 */
export function PeriodPicker({
  seasons,
  current,
  value,
  onChange,
  label,
}: {
  seasons: SeasonInfo[];
  current: number | null;
  value: number | null; // null = current
  onChange: (season: number | null) => void;
  label?: string;
}) {
  if (seasons.length <= 1) return null;

  const viewing = value ?? current;
  const viewingInfo = seasons.find((s) => s.season === viewing);
  const act = viewingInfo?.act ?? seasons[0]?.act ?? 0;

  // distinct acts, newest-first (the list is already ordered newest-first)
  const acts: number[] = [];
  for (const s of seasons) if (!acts.includes(s.act)) acts.push(s.act);
  // seasons within the selected act (newest-first)
  const inAct = seasons.filter((s) => s.act === act);

  // normalise: emit null whenever the pick lands on the live season
  const pick = (season: number) => onChange(current != null && season === current ? null : season);

  return (
    <div className="ds-period">
      {label && <span className="ds-panel-title">{label}</span>}
      <select
        className="ds-select"
        aria-label="Act"
        value={act}
        onChange={(e) => {
          const a = Number(e.target.value);
          // jump to that act's latest season (seasons are newest-first)
          const latest = seasons.find((s) => s.act === a);
          if (latest) pick(latest.season);
        }}
      >
        {acts.map((a) => (
          <option key={a} value={a}>
            {a === 0 ? 'Act 0 · Beta' : `Act ${a}`}
          </option>
        ))}
      </select>
      <select
        className="ds-select"
        aria-label="Season"
        value={viewing ?? ''}
        onChange={(e) => pick(Number(e.target.value))}
      >
        {inAct.map((s) => (
          <option key={s.season} value={s.season}>
            {s.name?.trim() ? s.name.trim() : `Season ${s.seasonNo}`}
            {s.season === current ? ' (current)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
