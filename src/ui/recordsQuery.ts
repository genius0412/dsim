/**
 * WHICH BOARD THE LEADERBOARDS TAB SHOWS, as the query string carries it (`docs/records-redesign.md`).
 *
 * The board is a LINK: `/decode/records/leaderboard?board=duo&cat=auto&dt=tank&season=7` opens on
 * exactly that board, and a filter change rewrites the address in place. Only what differs from the
 * default is written, in a fixed order, so one board has one address.
 *
 *  - `board`  Solo · Duo (score boards) · 1v1 · 2v2 (ranked). It replaces the old High scores |
 *             Ranked switch and the second switch whose meaning changed with it.
 *  - `cat`    Total · Auto · TeleOp, score boards only.
 *  - `dt`     a drivetrain, or Overall, score boards only.
 *  - `season` a past period's balance_version; absent is the live one.
 *  - `me`     open at the viewer's own row (My records' tiles link here with it).
 *
 * TOLERANT ON THE WAY IN. Anything unknown is dropped, and so are `window` and `era`: the Window
 * control (Today to All time) is gone, so an old address that carried one opens the season board,
 * which is what every window but All time was a slice of. DOM-free, so `npm test` holds it.
 */
import type { Board, RecordCategory } from '../net/api';

export const BOARD_KEYS = ['solo', 'duo', '1v1', '2v2'] as const;
export type BoardKey = (typeof BOARD_KEYS)[number];
export const BOARD_LABELS: Record<BoardKey, string> = { solo: 'Solo', duo: 'Duo', '1v1': '1v1', '2v2': '2v2' };

export const CATEGORIES: readonly RecordCategory[] = ['total', 'auto', 'teleop'];
export const CATEGORY_LABELS: Record<RecordCategory, string> = { total: 'Total', auto: 'Auto', teleop: 'TeleOp' };

export const DRIVETRAIN_BOARDS: readonly Board[] = ['overall', 'mecanum', 'tank', 'swerve', 'xdrive', 'butterfly'];

export interface BoardQuery {
  board: BoardKey;
  cat: RecordCategory;
  dt: Board;
  /** a past period's balance_version, or null for the live one */
  season: number | null;
  /** scroll to the viewer's row once the board lands */
  me: boolean;
}

export const DEFAULT_BOARD_QUERY: BoardQuery = { board: 'solo', cat: 'total', dt: 'overall', season: null, me: false };

/** a score board (Solo, Duo) as opposed to a ranked ladder (1v1, 2v2) */
export function isScoreBoard(b: BoardKey): b is 'solo' | 'duo' {
  return b === 'solo' || b === 'duo';
}

const oneOf = <T extends string>(list: readonly T[], v: string | null, fallback: T): T =>
  v != null && (list as readonly string[]).includes(v) ? (v as T) : fallback;

/** the query string (with or without its `?`) to a board; unknown keys and values fall back */
export function parseBoardQuery(search: string | null | undefined): BoardQuery {
  const p = new URLSearchParams((search ?? '').replace(/^\?/, ''));
  const board = oneOf(BOARD_KEYS, p.get('board'), DEFAULT_BOARD_QUERY.board);
  const score = isScoreBoard(board);
  const n = Number(p.get('season'));
  return {
    board,
    // a ranked ladder has no category or drivetrain: the values are dropped, not kept for later
    cat: score ? oneOf(CATEGORIES, p.get('cat'), 'total') : 'total',
    dt: score ? oneOf(DRIVETRAIN_BOARDS, p.get('dt'), 'overall') : 'overall',
    season: p.has('season') && Number.isInteger(n) && n >= 0 ? n : null,
    me: p.get('me') === '1',
  };
}

/** a board to its query string, WITHOUT the `?`: only what differs from the default, in a fixed order */
export function boardQueryString(q: BoardQuery): string {
  const p = new URLSearchParams();
  if (q.board !== DEFAULT_BOARD_QUERY.board) p.set('board', q.board);
  if (isScoreBoard(q.board) && q.cat !== 'total') p.set('cat', q.cat);
  if (isScoreBoard(q.board) && q.dt !== 'overall') p.set('dt', q.dt);
  if (q.season != null) p.set('season', String(q.season));
  if (q.me) p.set('me', '1');
  return p.toString();
}

/** the canonical form of whatever arrived: parsed and written back, so a stale key is dropped */
export function canonicalBoardQuery(search: string | null | undefined): string {
  return boardQueryString(parseBoardQuery(search));
}
