import { RECORDS_BOARD_KEY } from '../storageKeys';
import { boardQueryString, parseBoardQuery, type BoardQuery } from './recordsQuery';

/**
 * THE LAST BOARD, PER GAME (`docs/records-redesign.md`): a bare `/records` opens on the board you last
 * looked at in that game, not on Solo every time. The period and the `me` flag are never kept: a past
 * season is a visit, not a preference. A per-viewer convenience, so every read and write may fail
 * (a private window, blocked storage) and the page works without it.
 */
function readAll(): Record<string, string> {
  try {
    const m: unknown = JSON.parse(localStorage.getItem(RECORDS_BOARD_KEY) ?? '{}');
    return m && typeof m === 'object' ? (m as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** the remembered board's query string for a game, canonical, or null when there is none */
export function rememberedBoard(game: string): string | null {
  const v = readAll()[game];
  return typeof v === 'string' ? boardQueryString({ ...parseBoardQuery(v), season: null, me: false }) : null;
}

export function rememberBoard(game: string, q: BoardQuery): void {
  try {
    const all = readAll();
    all[game] = boardQueryString({ ...q, season: null, me: false });
    localStorage.setItem(RECORDS_BOARD_KEY, JSON.stringify(all));
  } catch {
    /* storage refused: the board still shows, it is just not remembered */
  }
}
