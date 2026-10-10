import type { ReactNode } from 'react';
import type { Hue } from './navItems';

/**
 * One full-width tile of a menu stack (home, multiplayer, solo). A big monogram on the left, the
 * title and what is behind it, and an optional live figure on the right. The tile wears its own
 * `hue` (the same accent scopes the shell uses), so a stack of them is a stack of colours.
 *
 * The caller says WHY a tile is disabled by passing that reason as the hint.
 */
export function MenuTile({
  title,
  hint,
  mono,
  hue,
  stat,
  disabled,
  onClick,
}: {
  title: string;
  hint?: ReactNode;
  /** the 2-3 letter glyph at the left edge; decorative, so hidden from a screen reader */
  mono: string;
  hue: Hue;
  stat?: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="ds-menutile" data-hue={hue} disabled={disabled} onClick={onClick}>
      <span className="mt-mono" aria-hidden="true">
        {mono}
      </span>
      <span className="mt-text">
        <span className="mt-title">{title}</span>
        {hint ? <span className="mt-hint">{hint}</span> : null}
      </span>
      {stat ? <span className="mt-stat">{stat}</span> : null}
    </button>
  );
}
