import type { Alliance, GameId, GameSettings, RobotSpec, StartCat, StartPose, StartSel } from '../types';
import type { LobbyPlayer } from '../net/protocol';
import { START_POSES, MAX_SAVED_STARTS, MAX_SAVED_STARTS_SUPPORTER } from '../config';
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

/**
 * Pure helpers for the Close/Far start-position model shared by the editor and
 * its host screens. The ACTIVE start (`startIndex`/`startPose`) is what spawns /
 * travels on the wire; `startCat` picks the category, `savedStartPoses` is the
 * per-category library (≤ MAX_SAVED_STARTS each), and `startMemory` remembers the
 * last selection in each category so switching tabs restores it.
 */

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

/** the ACTIVE start fields (startIndex/startPose) for a remembered selection */
function activeFromSel(cat: StartCat, sel: StartSel, game?: GameId): { startIndex: number; startPose: StartPose | null } {
  const index = sel.index >= 0 ? sel.index : categoryDefaultIndex(cat, game);
  return { startIndex: index, startPose: sel.pose };
}

/** patch: switch the active category, restoring that category's remembered pick */
export function switchCategory(s: GameSettings, cat: StartCat): Partial<GameSettings> {
  return { startCat: cat, ...activeFromSel(cat, s.startMemory[cat], s.game) };
}

/** patch: set the active start to `sel` within the CURRENT category + remember it */
export function selectStart(s: GameSettings, sel: StartSel): Partial<GameSettings> {
  const cat = s.startCat;
  return { ...activeFromSel(cat, sel, s.game), startMemory: { ...s.startMemory, [cat]: sel } };
}

/**
 * patch: save a custom pose into the current category's library.
 *
 * The slice is a RUNAWAY GUARD, not the entitlement gate — hence the supporter
 * ceiling rather than the free one. `StartPositionEditor` is the single place
 * that decides whether the "＋ Save" button appears at all (via `savedStartCap`),
 * and if this also enforced the free cap it would silently truncate a supporter's
 * six poses down to two on their very next save. Same reasoning as
 * `coerceSettings`: the persisted ceiling is always the high one.
 */
export function saveStart(s: GameSettings, pose: StartPose): Partial<GameSettings> {
  const cat = s.startCat;
  const list = [...s.savedStartPoses[cat], pose].slice(-MAX_SAVED_STARTS_SUPPORTER);
  return { savedStartPoses: { ...s.savedStartPoses, [cat]: list } };
}

/** how many saved starts per category this player gets — the ONE place the perk
 *  is decided. */
export function savedStartCap(supporter: boolean): number {
  return supporter ? MAX_SAVED_STARTS_SUPPORTER : MAX_SAVED_STARTS;
}

/** patch: delete a saved pose from a category */
export function deleteSavedStart(s: GameSettings, cat: StartCat, i: number): Partial<GameSettings> {
  return {
    savedStartPoses: { ...s.savedStartPoses, [cat]: s.savedStartPoses[cat].filter((_, k) => k !== i) },
  };
}

/** are two poses effectively the same spot? (for highlighting the active pick) */
export function samePose(a: StartPose | null | undefined, b: StartPose | null | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) < 0.05 && Math.abs(a.y - b.y) < 0.05 && Math.abs(a.headingDeg - b.headingDeg) < 0.5;
}

/**
 * Is the ACTIVE start selection legal, for EITHER game? A null pose means "use the
 * named anchor", which both games resolve legal for any chassis. A custom pose is
 * checked against that game's own rule — DECODE's G304 setup constraints, CR's G04
 * Lab-Area containment (plus the solid Ring-Stand assembly). Both take the pose in
 * the CANONICAL frame and are alliance-symmetric.
 *
 * Callers use this to REFUSE ready-up / game-start rather than let the spawn quietly
 * relocate a robot: CR gained free placement with `ChainStartEditor`, so "chain is
 * always legal" (true when it only offered anchors) no longer holds.
 */
export function startSelectionLegal(
  game: GameId | undefined,
  spec: RobotSpec,
  alliance: Alliance,
  startPose: StartPose | null | undefined,
): boolean {
  if (!startPose) return true;
  // THE MODULE ANSWERS, because this used to be `game === 'chain' ? … : …` and a two-valued
  // branch over a five-valued registry is the seam bug CLAUDE.md names: BIOBUZZ fell into
  // DECODE's arm and had its poses measured against DECODE's launch lines. A game with no
  // start rule fills nothing and every pose is legal — which is what the old DECODE arm could
  // not express. `src/games/sim.ts` is the SERVER-SAFE registry, so this stays DOM-free.
  const legal = simModuleFor(game).startLegal;
  return legal ? legal(spec, alliance, startPose) : true;
}
