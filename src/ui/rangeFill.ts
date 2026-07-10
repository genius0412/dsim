import type { CSSProperties } from 'react';

/**
 * Progress fill for a styled `<input type="range">`.
 *
 * Once a range sets `appearance: none` to get a custom track + puck thumb, the
 * engine stops painting the filled portion that `accent-color` used to give us
 * for free (only Firefox keeps it, via `::-moz-range-progress`). So the track's
 * gradient reads this `--fill` percentage instead, and every slider has to hand
 * it its own value. Custom properties inherit into pseudo-elements, which is
 * what makes the CSS side work.
 *
 * Returns a style object to spread onto the input.
 */
export function rangeFill(value: number, min: number, max: number): CSSProperties {
  const span = max - min;
  const pct = span > 0 ? ((value - min) / span) * 100 : 0;
  // clamp: a coerced spec can briefly sit outside a freshly-narrowed envelope
  const clamped = Math.max(0, Math.min(100, pct));
  return { ['--fill' as string]: `${clamped}%` } as CSSProperties;
}
