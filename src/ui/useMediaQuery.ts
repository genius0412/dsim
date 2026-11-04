import { useSyncExternalStore } from 'react';

/**
 * Does a media query match right now, as a SUBSCRIPTION (the reason `useCoarsePointer` gives: reading
 * `matchMedia` during render answers once and never again). For a layout that changes its MARKUP at a
 * width, not just its styles; a style-only change belongs in CSS.
 */
export function useMediaQuery(query: string): boolean {
  const mql = (): MediaQueryList | null =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
  return useSyncExternalStore(
    (onChange) => {
      const m = mql();
      if (!m) return () => {};
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => mql()?.matches ?? false,
    () => false,
  );
}
