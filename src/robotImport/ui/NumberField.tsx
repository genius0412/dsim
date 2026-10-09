import { useEffect, useState, type ReactNode } from 'react';

/**
 * A number the player types. Typing never commits a value that is not a finite number; Enter or
 * leaving the field clamps it into range and writes it back at the step's precision, so the field
 * never disagrees with what the editor stored. A `.ds-field` with a `.cap`, like every other row.
 */
export function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  unit,
  digits,
  narrow = true,
  onCommit,
}: {
  id?: string;
  label: string;
  hint?: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  /** printed after the label as a `.val`, e.g. ":1" or "lb" */
  unit?: string;
  /** decimals shown, when fewer than the step's own (a wheel at 1/16 in reads 11.34, not 11.3375) */
  digits?: number;
  narrow?: boolean;
  onCommit: (v: number) => void;
}) {
  const decimals = digits ?? (step >= 1 ? 0 : (String(step).split('.')[1]?.length ?? 2));
  const fmt = (v: number): string => (Number.isFinite(v) ? Number(v.toFixed(decimals)).toString() : '');
  const [text, setText] = useState(fmt(value));
  useEffect(() => setText(fmt(value)), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  // reads the FIELD, not the state: a blur can arrive in the same task as the last keystroke
  const commit = (raw: string): void => {
    // untouched, it commits nothing: the text is the value rounded for show, and snapping THAT to
    // the step moved a wheel at 4.796875 to 4.8125 for a Tab through the field
    if (raw === fmt(value)) return;
    const v = Number(raw);
    if (!Number.isFinite(v) || raw.trim() === '') {
      setText(fmt(value));
      return;
    }
    const c = Math.min(max, Math.max(min, Math.round(v / step) * step));
    setText(fmt(c));
    if (Math.abs(c - value) > 1e-9) onCommit(c);
  };
  return (
    <label className={`ds-field${narrow ? ' narrow' : ''}`}>
      <span className="cap">
        {label}
        {unit ? <span className="val">{unit}</span> : hint ? <span>{hint}</span> : null}
      </span>
      <input
        id={id}
        className="ds-input"
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value);
        }}
      />
    </label>
  );
}
