/**
 * "2 h 05 m", "4 m 10 s", "12 s" — a countdown to a deadline. Its own leaf module because the call
 * bar (`src/ui/CompCallBar.tsx`) is in the MAIN chunk and must not drag the competition copy tables
 * in with it; everything else reaches it through `copy.ts`.
 */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h} h ${String(m).padStart(2, '0')} m`;
  }
  if (s >= 60) {
    const m = Math.floor(s / 60);
    return `${m} m ${String(s % 60).padStart(2, '0')} s`;
  }
  return `${s} s`;
}
