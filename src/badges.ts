/**
 * BADGES — the one kind of mark an account wears beside its name for something it EARNED.
 *
 * There used to be two: a TITLE (one-off words, "BIOBUZZ · Act 2 · 1v1 Champion") and a BADGE
 * (a category with a counter). Every competitive grant carried both for the same finish, so the
 * owner folded titles into badges (2026-09-24): migration 0049 retired `profiles.title`, and
 * the one title with no badge twin, the GitHub star's, became the `stargazer` badge. Which act
 * or season a badge came from is on its grant, and the profile's trophy case lists them.
 *
 * A badge is a CATEGORY: earning the same one again raises its count rather than adding a row,
 * and the badge beside a name shows the number (owner, 2026-09-22: "badges should not be handed
 * out as often as titles. Often, badges should have a counter").
 *
 * ── A LEAF, ON PURPOSE ──────────────────────────────────────────────────────────────────────
 * No imports, like `src/cosmetics.ts`: the server validates against this registry
 * (`server/db/repo.ts`), the client draws from it, and `scripts/smoke.ts` drives it headlessly.
 *
 * ── THE SET IS CLOSED, AND SMALL ────────────────────────────────────────────────────────────
 * A badge id goes over the wire, into `profiles.equipped_badges` and into every grant's
 * `items`, so it is a stable KEY — never a label. Eight exist:
 *   ranked-gold / -silver / -bronze   #1 / #2 / #3 on a ranked ladder when an ACT ends
 *   record-holder                     top 3 overall or #1 of a drivetrain when a SEASON ends
 *   stargazer                         starred DSIM on GitHub — revocable, never counts past 1
 *   developer / beta-tester /         a member of the `dev` / `beta` / `contributor` ACCESS GROUP
 *     contributor                     (0051) — given by an admin, revoked with the membership,
 *                                     never counts past 1 (`TEAM_BADGES`)
 * The podium is three badges rather than one with a rank inside it because the COUNT has to
 * mean one thing: "3× Ranked Champion" is a sentence, "3× podium (some golds)" is not.
 * Game-agnostic on purpose — a player who wins the DECODE ladder and the BIOBUZZ ladder has
 * won a ladder twice. Which game each one came from is on the grant, and the profile says so.
 */

export const BADGE_KEYS = [
  'ranked-gold',
  'ranked-silver',
  'ranked-bronze',
  'record-holder',
  'stargazer',
  'developer',
  'beta-tester',
  'contributor',
] as const;
export type BadgeId = (typeof BADGE_KEYS)[number];

/** is `id` a badge this build knows? Anything else is refused on write and skipped on read. */
export function isBadgeId(id: unknown): id is BadgeId {
  return typeof id === 'string' && (BADGE_KEYS as readonly string[]).includes(id);
}

/** what a badge is called on screen. Every key must appear here; `npm test` checks. */
export const BADGE_LABELS: Record<BadgeId, string> = {
  'ranked-gold': 'Ranked Champion',
  'ranked-silver': 'Ranked Finalist',
  'ranked-bronze': 'Ranked Semifinalist',
  'record-holder': 'Record Holder',
  stargazer: 'Stargazer',
  developer: 'Developer',
  'beta-tester': 'Beta Tester',
  contributor: 'Contributor',
};

/** how a badge is EARNED — the one sentence the badge picker and the dialog need, because a
 *  badge is a category and its name alone does not say what puts a count on it. */
export const BADGE_EARN: Record<BadgeId, string> = {
  'ranked-gold': 'Finish #1 on a ranked ladder when an act ends.',
  'ranked-silver': 'Finish #2 on a ranked ladder when an act ends.',
  'ranked-bronze': 'Finish #3 on a ranked ladder when an act ends.',
  'record-holder': 'Finish top 3 on the overall record board, or #1 for a drivetrain, when a season ends.',
  stargazer: 'Star DSIM on GitHub and connect GitHub under Account. It stays while the star does.',
  developer: 'Given to the people who build DSIM.',
  'beta-tester': 'Given to the players who test new builds before they ship.',
  contributor: 'Given to the people whose work is in DSIM on GitHub.',
};

/** the visual family — drives the art and the dialog's treatment. The podium is the special
 *  one (owner: the ranked reward is "the most prestigious"); the record badge is deliberately
 *  plainer, and the stargazer ★ disc (owner, 2026-09-24) plainer still. The three TEAM badges
 *  share one shape (a keycap tile) and differ by glyph and hue — see `BadgeMark.tsx`. */
export type BadgeTier = 'gold' | 'silver' | 'bronze' | 'record' | 'stargazer' | 'team';
export const BADGE_TIER: Record<BadgeId, BadgeTier> = {
  'ranked-gold': 'gold',
  'ranked-silver': 'silver',
  'ranked-bronze': 'bronze',
  'record-holder': 'record',
  stargazer: 'stargazer',
  developer: 'team',
  'beta-tester': 'team',
  contributor: 'team',
};

/**
 * THE TEAM BADGES, by the ACCESS GROUP that gives each one (`access_members`, 0051).
 *
 * Membership IS the badge: an admin adding someone to a group grants it (pending, claimed
 * through the dialog like every other reward) and removing them revokes it. So there is no
 * second list to keep in step, and `server/db/repo.ts` (`syncTeamBadges`) repairs any drift at
 * boot. The keys are `AccessGroup` (`src/net/protocol.ts`) spelled out, because this file is a
 * leaf; `npm test` holds the two sets equal.
 */
export const TEAM_BADGES = {
  dev: 'developer',
  beta: 'beta-tester',
  contributor: 'contributor',
} as const satisfies Record<string, BadgeId>;

/** is this a badge the team GIVES, rather than one a player can go and earn? */
export function isTeamBadge(id: BadgeId): boolean {
  return BADGE_TIER[id] === 'team';
}

/**
 * THE BADGES A LIST SHOWS THIS ACCOUNT — the badge picker and the Achievements page.
 *
 * Both list every badge, earned or not, so the list doubles as what to go and do. A team badge
 * is not something to go and do: an unheld one would read as "Not yet" beside a sentence that
 * says it is given. So a team badge is listed only to an account that holds it.
 */
export function listedBadges(counts: Readonly<Record<string, number>>): BadgeId[] {
  return BADGE_KEYS.filter((id) => !isTeamBadge(id) || (counts[id] ?? 0) > 0);
}

/** the podium badge a final ranked placement earns, or null past the podium. */
export function podiumBadge(rank: number): BadgeId | null {
  return rank === 1 ? 'ranked-gold' : rank === 2 ? 'ranked-silver' : rank === 3 ? 'ranked-bronze' : null;
}

/**
 * HOW MANY MAY BE WORN AT ONCE. Three: enough to show a whole podium, few enough that a board
 * row stays a name with some decoration rather than decoration with a name in it. The owner
 * kept it at three when titles folded into badges (2026-09-24).
 */
export const MAX_EQUIPPED_BADGES = 3;

/** a worn badge and its counter, as it travels on every name the server sends. */
export interface EquippedBadge {
  id: string;
  /** times earned — the counter. 1 shows no number; 2+ shows it. */
  n: number;
}

/**
 * READ AN EQUIPPED LIST OFF THE WIRE. Tolerant in exactly the direction a decoration should
 * be: an unknown id (a newer build's badge), a malformed entry or a non-array all drop out
 * rather than throwing, and the list is capped at `MAX_EQUIPPED_BADGES` whatever arrived.
 */
export function coerceEquippedBadges(v: unknown): EquippedBadge[] {
  if (!Array.isArray(v)) return [];
  const out: EquippedBadge[] = [];
  for (const e of v) {
    if (!e || typeof e !== 'object') continue;
    const id = (e as { id?: unknown }).id;
    const n = Number((e as { n?: unknown }).n);
    if (!isBadgeId(id) || !Number.isFinite(n) || n < 1) continue;
    if (out.some((x) => x.id === id)) continue;
    out.push({ id, n: Math.floor(n) });
    if (out.length >= MAX_EQUIPPED_BADGES) break;
  }
  return out;
}

/**
 * EQUIP ONE MORE — the rule "Equip now" follows. Already worn: unchanged. Room left: appended.
 * Full: the OLDEST worn badge makes room, because the one just earned is the one the player
 * asked to show and the one they have worn longest is the one they have shown longest.
 */
export function withBadgeEquipped(current: readonly string[], id: string): string[] {
  if (current.includes(id)) return [...current];
  const next = [...current, id];
  return next.length > MAX_EQUIPPED_BADGES ? next.slice(next.length - MAX_EQUIPPED_BADGES) : next;
}
