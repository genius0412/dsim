/**
 * THE TIME WINDOWS OF A RECORD BOARD (rooms plan §5.2): best run today / this week / this month.
 *
 * They roll over at 08:00 UTC (about 3-4 am Eastern, when nobody is mid-run): the day at 08:00,
 * the week on Monday 08:00, the month on the 1st at 08:00. The SERVER computes both ends and sends
 * them, so a client with a wrong clock cannot show a window that has already closed.
 *
 * Pure and DOM-free: no clock of its own, `now` is an argument.
 */
export type BoardWindow = 'season' | 'day' | 'week' | 'month' | 'all';
export const BOARD_WINDOWS: readonly BoardWindow[] = ['season', 'day', 'week', 'month', 'all'];

export function coerceWindow(v: unknown): BoardWindow {
  return BOARD_WINDOWS.includes(v as BoardWindow) ? (v as BoardWindow) : 'season';
}

const ROLL_HOUR = 8;

/** the window's start (inclusive) and when it ends, as ISO strings; null when it has none */
export function windowBounds(
  window: BoardWindow,
  now: Date,
): { start: string | null; resetsAt: string | null } {
  if (window !== 'day' && window !== 'week' && window !== 'month') return { start: null, resetsAt: null };
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  const d = now.getUTCDate();
  let start: Date;
  let next: Date;
  if (window === 'day') {
    start = new Date(Date.UTC(y, mo, d, ROLL_HOUR));
    if (start > now) start = new Date(start.getTime() - 86_400_000);
    next = new Date(start.getTime() + 86_400_000);
  } else if (window === 'week') {
    // back to this week's Monday 08:00, or the previous one if it has not struck yet
    const sinceMonday = (now.getUTCDay() + 6) % 7;
    start = new Date(Date.UTC(y, mo, d - sinceMonday, ROLL_HOUR));
    if (start > now) start = new Date(start.getTime() - 7 * 86_400_000);
    next = new Date(start.getTime() + 7 * 86_400_000);
  } else {
    start = new Date(Date.UTC(y, mo, 1, ROLL_HOUR));
    if (start > now) start = new Date(Date.UTC(y, mo - 1, 1, ROLL_HOUR));
    next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, ROLL_HOUR));
  }
  return { start: start.toISOString(), resetsAt: next.toISOString() };
}
