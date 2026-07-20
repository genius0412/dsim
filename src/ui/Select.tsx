import { useEffect, useRef, useState } from 'react';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

/**
 * A small custom listbox, styled to match. Exists because the native `<select>`
 * popup "can't be fully themed cross-browser" (see `.ds-select` in shell.css) —
 * this one is ours end to end, in both themes. Follows the ARIA
 * button+listbox pattern: the trigger is `aria-haspopup="listbox"`, the popup is
 * `role="listbox"` with `role="option"` children, arrow keys move a highlighted
 * option, Enter/Space commits it, Escape closes and returns focus to the trigger.
 *
 * Not a drop-in `<select>` replacement (no native form submission) — built for
 * the handful of app-controlled pickers that already call `onChange` directly.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0); // highlighted index while open
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const current = options[selectedIndex] ?? options[0];

  // click outside closes
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // focus the highlighted option whenever the list opens or the highlight moves
  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.focus();
  }, [open, active]);

  const commit = (i: number): void => {
    const opt = options[i];
    if (opt) onChange(opt.value);
    setOpen(false);
    btnRef.current?.focus();
  };

  const onListKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commit(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      btnRef.current?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="ds-listbox-root" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className="ds-listbox-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{current?.label ?? ''}</span>
        <ChevronGlyph />
      </button>
      {open && (
        <ul className="ds-listbox-pop" role="listbox" aria-label={ariaLabel} onKeyDown={onListKeyDown}>
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              tabIndex={-1}
              className={`ds-listbox-opt${o.value === value ? ' on' : ''}${i === active ? ' hi' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(i)}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChevronGlyph() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path
        d="M2.5 4.5 6 8l3.5-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
