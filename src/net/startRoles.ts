import type { GameId, StartCat, StartPose } from '../types';
import type { LobbyPlayer } from './protocol';
import { START_POSES } from '../config';
import { chainAnchorCat, chainDefaultIndex } from '../games/chain/config';
import { simModuleFor } from '../games/sim';

export const otherCat = (c: StartCat): StartCat => (c === 'close' ? 'far' : 'close');

/**
 * THE ALLIANCE, AS EXACTLY TWO MEMBERS IN THE ONE ORDER EVERY CLIENT AGREES ON —
 * or null, which is the answer for one, three and four.
 *
 * ⚠️ **THIS IS THE ONLY LIST THE ROLE MODEL MAY BE DERIVED FROM.** The role split and
 * the swap handshake are two halves of one negotiation, and they used to read two
 * different orders: the split paired by clientId sort, the handshake picked the
 * partner by ROSTER (join) order. With two members those always name the same person,
 * so nothing showed; with three or four — which a Discord activity produces by
 * default, since every participant advertises the same alliance — they disagreed, and
 * the handshake's own invariant ("both flip, so they stay opposite") broke: a request
 * from the first member fanned out to three people, a request from the third set a
 * flag nobody read, an accept half-completed, and a swap between any two moved the
 * UNINVOLVED members' derived role, which the lobby turns into an unrequested start
 * position change that discards a custom pose.
 *
 * `< 2` was the old guard and it is wrong for the same reason `!== 2` is right: there
 * is no third role. Above two, every caller must fall back to the unlocked model —
 * no locked category, no swap — rather than invent one.
 */
export function allianceDuo(
  players: LobbyPlayer[],
  me: LobbyPlayer,
): { first: LobbyPlayer; second: LobbyPlayer; partner: LobbyPlayer; mineFirst: boolean } | null {
  const allies = players
    .filter((p) => p.alliance === me.alliance && !p.hidden)
    .sort((a, b) => a.clientId.localeCompare(b.clientId));
  if (allies.length !== 2) return null;
  const [first, second] = allies;
  const mineFirst = first.clientId === me.clientId;
  // I must be one of the two. A hidden or not-yet-rostered `me` would otherwise be
  // handed somebody else's partner and somebody else's half of the split.
  if (!mineFirst && second.clientId !== me.clientId) return null;
  return { first, second, partner: mineFirst ? second : first, mineFirst };
}

/**
 * This player's locked 2v2 start role (CLOSE/FAR), GUARANTEEING the two alliance
 * members hold DISTINCT roles. Precedence:
 *  1. both members carry an explicit `startRole` and they differ → honour mine;
 *  2. only I'm explicit → mine;
 *  3. only my PARTNER is explicit → the OPPOSITE of theirs;
 *  4. neither explicit (or both explicit but IDENTICAL — a collision) → a
 *     deterministic positional split by clientId (first = close, second = far).
 *
 * Rule 3 fixes the swap→host-leave→rejoin bug: a lobby rejoin returns as a fresh
 * `join` with a NEW clientId and NO `startRole` (rejoin never reattaches a duo
 * lobby slot), so the rejoiner must take the opposite of its partner's RETAINED
 * swapped role — the old clientId-only sort ignored the partner and could land
 * both on the same role. Both clients compute this identically from the shared
 * roster, so they always converge on one close + one far. Returns undefined unless
 * the alliance has EXACTLY two visible members — see `allianceDuo`.
 */
export function derivedRole(players: LobbyPlayer[], me: LobbyPlayer): StartCat | undefined {
  const duo = allianceDuo(players, me);
  if (!duo) return undefined;
  const mine = me.startRole;
  const theirs = duo.partner.startRole;
  if (mine && theirs && mine !== theirs) return mine;
  if (mine && !theirs) return mine;
  if (!mine && theirs) return otherCat(theirs);
  return duo.mineFirst ? 'close' : 'far';
}

export interface CatPreset {
  index: number;
  pose: StartPose;
  label: string;
}

/** the built-in presets belonging to a category, with their START_POSES index */
export function categoryPresets(cat: StartCat): CatPreset[] {
  const out: CatPreset[] = [];
  START_POSES.forEach((p, index) => {
    if (p.cat === cat) out.push({ index, pose: { x: p.x, y: p.y, headingDeg: p.headingDeg }, label: p.label });
  });
  return out;
}

/** the fallback preset index for a category (its first preset) — game-aware: CR maps
 * the category onto its TOP/BOTTOM Lab-corner anchors, DECODE onto its Close/Far presets. */
export function categoryDefaultIndex(cat: StartCat, game?: GameId): number {
  if (game === 'chain') return chainDefaultIndex(cat);
  // a game with its own roles answers through its module (BIOBUZZ's TOP / BOTTOM)
  const byModule = simModuleFor(game).startDefaultIndex;
  if (byModule) return byModule(cat);
  return categoryPresets(cat)[0]?.index ?? 0;
}

/** the category a preset/anchor index belongs to (game-aware, see above) */
export function indexCategory(index: number, game?: GameId): StartCat {
  if (game === 'chain') return chainAnchorCat(index);
  const byModule = simModuleFor(game).startAnchorCategory;
  if (byModule) return byModule(index);
  return START_POSES[index]?.cat ?? 'close';
}
