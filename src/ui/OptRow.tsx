/**
 * ONE ROW OF MUTUALLY EXCLUSIVE CHOICES — the shape every pick in Configure takes.
 *
 * ── WHY IT IS SHARED ───────────────────────────────────────────────────────
 * Configure used to spell a boolean three different ways: one tile whose LABEL carried the
 * state (`Auto intake ON`), two tiles reading `Off`/`On`, and a segmented `.ds-segs` row.
 * The first is the worst of them — the tile is already filled accent when it is on, so the
 * word `ON` says a second time what the fill says, and an unlit `Sorter OFF` beside a lit
 * `Sorter ON` reads as two different controls. This component is the two-tile form, and
 * every boolean and every small enum on the screen now routes through it, so a row in the
 * robot builder and a row in Graphics are the same control.
 *
 * ── TOGGLE BUTTONS, NOT AN ARIA RADIOGROUP ─────────────────────────────────
 * A radiogroup owes roving tabindex and arrow keys, and a partial implementation of that
 * pattern is worse than none (the same ruling `AudioSection`'s theme picker records). Each
 * tile is a button carrying `aria-pressed`, which is what the fourteen hand-rolled toggles
 * this replaces were missing.
 *
 * ── NO HELPER TEXT THAT RESTATES A LABEL (`docs/ui-standard.md` §8) ────────
 * `d` is for a real trade-off the player is choosing between — what an option COSTS, or
 * what it cannot do live. A sub-line that says the label again goes.
 */
import type { ReactNode } from 'react';

export interface OptChoice<T> {
  /** the stored value */
  v: T;
  /** the tile's label — sentence case, per the copy rules */
  t: string;
  /** the trade-off, when there is one. Never a restatement of `t`. */
  d?: string;
}

export function OptRow<T extends string | number | boolean>({
  label,
  value,
  options,
  onPick,
  cols,
  hint,
  mini,
  disabled,
  lead,
}: {
  label?: string;
  value: T;
  options: readonly OptChoice<T>[];
  onPick: (v: T) => void;
  /** matches `.ds-opts`'s own modifiers; omitted is the auto-fit grid */
  cols?: 'two' | 'three' | 'four' | 'five';
  /** the one fact the row cannot state for itself, shown beside the label */
  hint?: ReactNode;
  /**
   * CHIP-HEIGHT TILES. A tile with no sub-line takes a 62px floor so that a grid holding one
   * WITH a description and one without does not step (`.ds-opt:not(.mini):not(:has(.od))`), but
   * an `Off` / `On` pair has neither and two 62px slabs for a boolean is a lot of screen for
   * one bit. `ToggleRow` sets this whenever no side carries a description.
   */
  mini?: boolean;
  /** the row EXISTS but does nothing right now (a difficulty for a seat that is not AI).
   *  Greyed rather than removed, so the rows under it never move (§1.4). The picked tile
   *  stays lit, so the row still says what it will be when it comes back. */
  disabled?: boolean;
  /** the FIRST tile spans the whole row: a recommended default above the choices it picks
   *  between (Prediction's Auto), so an odd count never strands the last choice alone */
  lead?: boolean;
}) {
  const grid = (
    <div className={`ds-opts${cols ? ` ${cols}` : ''}${lead ? ' lead' : ''}`}>
      {options.map((o) => (
        <button
          key={String(o.v)}
          className={`ds-opt ${mini ? 'mini ' : ''}${value === o.v ? 'on' : ''}`}
          aria-pressed={value === o.v}
          disabled={disabled}
          onClick={() => onPick(o.v)}
        >
          <span className="ot">{o.t}</span>
          {o.d && <span className="od">{o.d}</span>}
        </button>
      ))}
    </div>
  );
  // A row with no label is the grid alone — wrapping it in an empty `.cap` would reserve a
  // line of leading for nothing and break the rhythm of the rows around it.
  if (!label) return grid;
  return (
    <div className="ds-field">
      <span className="cap">
        {label}
        {/* prose, so it stays in the caption's muted UI face — `.val` is for mono readouts */}
        {hint && <span>{hint}</span>}
      </span>
      {grid}
    </div>
  );
}

/** the two-tile `Off` / `On` row, which is most of them. */
export function ToggleRow({
  label,
  value,
  onPick,
  on = 'On',
  off = 'Off',
  onDesc,
  offDesc,
}: {
  label?: string;
  value: boolean;
  onPick: (v: boolean) => void;
  on?: string;
  off?: string;
  onDesc?: string;
  offDesc?: string;
}) {
  return (
    <OptRow<boolean>
      label={label}
      value={value}
      cols="two"
      mini={!onDesc && !offDesc}
      onPick={onPick}
      options={[
        { v: false, t: off, d: offDesc },
        { v: true, t: on, d: onDesc },
      ]}
    />
  );
}
