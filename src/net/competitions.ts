/**
 * COMPETITIONS — the client's half of `/api/competitions/*` (0059, `docs/area/competitions.md`).
 *
 * Its own module rather than more of `api.ts`, so the pages (a lazy chunk) bring it with them and
 * the main bundle carries only `fetchMyCompetitions`, which the call bar needs from every screen.
 *
 * Every read sends the token when there is one: the page answers differently for an entrant, a
 * referee and a stranger, and a signed-out visitor is a stranger, not an error.
 */
import { gameServerHttpUrl } from './env';
import { getAuthToken } from '../lib/authClient';
import { sendWithTokenRetry } from './authFetch';
import type { Alliance, CardColour, CompetitionSummary, RpRuling } from '../competition/types';
import type { CompEditInput, CompMatchView, CompetitionDetail, CompetitionList } from '../competition/wire';
import type { GameId } from '../games/types';

/** a refusal the server explained, or a failure that has no better sentence */
export class CompError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'CompError';
  }
}

function base(): string {
  const b = gameServerHttpUrl();
  if (!b) throw new CompError('Competitions need the game server, and this build has none.', 0);
  return b;
}

async function read<T>(path: string): Promise<T> {
  const token = await getAuthToken().catch(() => null);
  const res = await fetch(base() + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new CompError(body.error ?? `Couldn’t load that (error ${res.status}).`, res.status);
  return body;
}

async function post<T = { ok: true; note?: string }>(path: string, payload: unknown): Promise<T> {
  const token = await getAuthToken().catch(() => null);
  if (!token) throw new CompError('Sign in first.', 401);
  const res = await sendWithTokenRetry(token, getAuthToken, (t) =>
    fetch(base() + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: JSON.stringify(payload ?? {}),
    }),
  );
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new CompError(body.error ?? `Couldn’t do that (error ${res.status}). Try again in a moment.`, res.status);
  return body;
}

export type ListScope = 'live' | 'upcoming' | 'past' | 'mine' | 'drafts' | 'all';

export function fetchCompetitions(scope: ListScope, game?: GameId | null, offset = 0): Promise<CompetitionList> {
  const q = new URLSearchParams({ scope });
  if (game) q.set('game', game);
  if (offset) q.set('offset', String(offset));
  return read<CompetitionList>(`/api/competitions?${q.toString()}`);
}

export function fetchCompetition(slug: string): Promise<CompetitionDetail> {
  return read<CompetitionDetail>(`/api/competitions/${encodeURIComponent(slug)}`);
}

export function fetchCompetitionCaps(): Promise<{ canCreate: boolean; why: string | null; admin: boolean }> {
  return read(`/api/competitions/caps`);
}

export { fetchMyCompetitions } from './myCompetitions';

export function createCompetition(input: CompEditInput): Promise<{ slug: string; id: string; game: GameId }> {
  return post(`/api/competitions`, input);
}

/** one action on one competition: `register`, `status`, `match`, … (see server/competitions.ts) */
export function compAction<T = { ok: true; note?: string }>(slug: string, action: string, payload: Record<string, unknown> = {}): Promise<T> {
  return post<T>(`/api/competitions/${encodeURIComponent(slug)}/${action}`, payload);
}

/**
 * THE RANKING-POINT CORRECTIONS on one decided qualification match (0060). Each carries the
 * match's `attempt` as the desk rendered it: a match reset or replayed since is refused with
 * "The match changed. Refresh." rather than corrected blind. `note` is the reason, required, and
 * public in the log.
 */
type MatchRef = Pick<CompMatchView, 'id' | 'attempt'>;

/** a per-key patch: a number sets a measure, null clears it (unknown), a key left out is kept */
export type FactsPatch = Partial<Record<Alliance, Record<string, number | null>>>;
/** per bonus id: a ruling, or null to go back to what was scored */
export type RulingsPatch = Partial<Record<Alliance, Record<string, RpRuling | null>>>;

export function matchFacts(slug: string, m: MatchRef, facts: FactsPatch, note: string) {
  return compAction(slug, 'match', { action: 'facts', match: m.id, attempt: m.attempt, facts, note });
}

export function matchRulings(slug: string, m: MatchRef, rulings: RulingsPatch, note: string) {
  return compAction(slug, 'match', { action: 'rp', match: m.id, attempt: m.attempt, rulings, note });
}

/** a referee's card for one entry; null withdraws it. The sim's own card is not touched. */
export function matchCard(slug: string, m: MatchRef, entry: number, colour: CardColour | null, note: string) {
  return compAction(slug, 'match', { action: 'card', match: m.id, attempt: m.attempt, entry, colour, note });
}

export { fetchPlacements, type Placement } from './myCompetitions';

export type { CompetitionSummary };
