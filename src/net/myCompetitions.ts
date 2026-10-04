/**
 * THE CALL BAR'S ONE READ (`GET /api/competitions/me`), in a module of its own because the bar is in
 * the MAIN chunk and the rest of the competition client (`competitions.ts`) is lazy with the pages.
 * Signed out, offline, or a server without the route: `null`, never an error the bar would show.
 */
import { gameServerHttpUrl } from './env';
import { getAuthToken } from '../lib/authClient';
import type { MyCompetitions } from '../competition/wire';
import type { GameId } from '../games/types';

export async function fetchMyCompetitions(): Promise<MyCompetitions | null> {
  const b = gameServerHttpUrl();
  if (!b) return null;
  const token = await getAuthToken().catch(() => null);
  if (!token) return null;
  try {
    const res = await fetch(b + '/api/competitions/me', { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return (await res.json()) as MyCompetitions;
  } catch {
    return null;
  }
}

/** one finished competition on a player's profile */
export interface Placement {
  slug: string;
  name: string;
  game: GameId;
  place: number | null;
  entrants: number;
  completedAt: number | null;
  official: boolean;
}

/** a player's finished competitions and where they placed (`GET /api/profile/<username>/competitions`).
 *  Empty on any failure: the profile shows nothing rather than an error for a side panel. */
export async function fetchPlacements(username: string): Promise<Placement[]> {
  const b = gameServerHttpUrl();
  if (!b) return [];
  const res = await fetch(`${b}/api/profile/${encodeURIComponent(username)}/competitions`).catch(() => null);
  if (!res || !res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as { competitions?: Placement[] };
  return body.competitions ?? [];
}
