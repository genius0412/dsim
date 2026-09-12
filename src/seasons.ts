/**
 * App branding + the SEASON registry.
 *
 * The product is **DohunSim** — a 2D FTC driver-practice simulator. Each FTC
 * game is a "season". Right now only DECODE (2025–26) is playable; the sim's
 * geometry/scoring in `src/config.ts` + `src/sim/` are DECODE-specific. This
 * module is the seam for adding future seasons: register another `Season` here,
 * flip `playable: true` once its rules land, and the UI (season badge/picker)
 * picks it up automatically. Keep the APP name ("DohunSim") separate from the
 * SEASON name ("DECODE") everywhere in the UI — the brand is the app, DECODE is
 * just the game currently loaded.
 */

export const APP_NAME = 'DSIM';
export const APP_TAGLINE = '2D Driver Practice';
/** One plain sentence saying what this is. Shown on the home menu and reused as
 * the first sentence of the meta description (`src/seo.ts`) — so it is also the
 * line that shows up in a search result and a pasted-link preview. The static
 * copy in `index.html` and the web manifest repeat it verbatim (they ship before
 * any JS runs); keep all three in step, and keep it a description, not a pitch. */
export const APP_BLURB = 'An online 2D driving simulator for FIRST Tech Challenge.';

/** external links surfaced in the footer / download page */
export const LINKS = {
  repo: 'https://github.com/genius0412/dsim',
  discord: 'https://discord.gg/YB4tXnx7Pj',
  /** Ko-fi page - donations + the supporter membership tier. The Donate screen
   *  reads it from this one place; the webhook (server/api.ts) is what actually
   *  grants the tier once a payment is claimed. */
  kofi: 'https://ko-fi.com/playdsim',
} as const;

import type { GameId } from './games/types';

/**
 * A client build's RELEASE CHANNEL. The pre-release deployment bakes
 * `VITE_APP_CHANNEL=alpha`; everything else (including the stable site and the
 * Electron build) is `stable`. See `appChannel()` in `src/net/env.ts`.
 */
export type ReleaseChannel = 'stable' | 'alpha';

export interface Season {
  /** stable key (used for future save bucketing / URLs) — matches a `GameId` */
  key: GameId;
  /** short game name, e.g. "DECODE" */
  name: string;
  /**
   * Presenting sponsor, e.g. "RTX" — omitted when a game has none. Kept as its
   * own field rather than baked into a `fullName` string because the home-menu
   * eyebrow is CSS-uppercased, and a brand that styles itself in mixed case
   * (goBILDA) must survive that. `fullNameOf` reassembles the two.
   */
  presenter?: string;
  /** competition program */
  program: string;
  /** playing years, e.g. "2025–26" */
  years: string;
  /** one-line description of the game */
  blurb: string;
  /** false ⇒ shown in the picker as "coming soon", not selectable */
  playable: boolean;
  /**
   * Which client CHANNELS may SEE this season at all. Absent ⇒ every channel.
   *
   * Distinct from `playable`, and the difference matters: `playable: false` is a
   * PUBLIC "coming soon" row, while a channel restriction hides the season
   * outright — off the home picker, out of the queue counts, off the SEO
   * surfaces, and its URL prefix stops resolving (a `/biobuzz/...` link on a
   * stable build falls back to the saved game). That is what lets an unannounced
   * season be developed on the alpha deployment of a PUBLIC repo.
   */
  channels?: readonly ReleaseChannel[];
}

export const SEASONS: readonly Season[] = [
  {
    key: 'decode',
    name: 'DECODE',
    presenter: 'RTX',
    program: 'FIRST Tech Challenge',
    years: '2025–26',
    blurb: 'Classify artifacts into cross-court goals, match the motif, park on base.',
    playable: true,
  },
  {
    key: 'chain',
    name: 'Chain Reaction',
    presenter: 'goBILDA',
    program: 'Unofficial FTC · CAD Competition',
    years: '2026',
    blurb: 'The 2026 Unofficial FTC CAD-competition game - a new shooter (rules to come).',
    playable: true,
  },
  {
    // ALPHA-ONLY until the season is announced. The repo is public, so `channels`
    // is what keeps an unreleased season off the stable site while it is built on
    // the alpha deployment — see `seasonVisibleOn` below.
    key: 'biobuzz',
    name: 'BIOBUZZ',
    presenter: 'RTX',
    program: 'FIRST Tech Challenge',
    years: '2026–27',
    blurb: 'Rules land at kickoff on 2026-09-12.',
    playable: true,
    channels: ['alpha'],
  },
] as const;

/**
 * Is this season visible on a client built for `channel`?
 *
 * The channel→visibility RULE lives here, in a leaf module with no
 * `import.meta.env` in it, and takes the channel as an ARGUMENT — exactly the
 * split `roomJoinRegion` uses. `src/net/env.ts` reads `import.meta.env` at module
 * load, so the headless smoke run cannot import it at all; a rule that could only
 * be reached through env.ts would be untestable, and this one fails SILENTLY (a
 * season that is merely absent looks like a season nobody registered).
 * `src/seasonVisibility.ts` is the thin wrapper that supplies the live channel.
 *
 * An unknown channel string sees only the unrestricted seasons, which is the safe
 * direction: a typo'd `VITE_APP_CHANNEL` hides the unannounced season rather than
 * publishing it.
 */
export function seasonVisibleOn(s: Season, channel: string): boolean {
  return !s.channels || (s.channels as readonly string[]).includes(channel);
}

/** the seasons a client on `channel` may see, in registry order. */
export function visibleSeasonsOn(channel: string): readonly Season[] {
  return SEASONS.filter((s) => seasonVisibleOn(s, channel));
}

/** the game ids a client on `channel` may see, in registry order. */
export function visibleGameIdsOn(channel: string): readonly GameId[] {
  return visibleSeasonsOn(channel).map((s) => s.key);
}

/** is this GAME visible on `channel`? An id with no season registered is treated
 * as visible — the season registry, not this predicate, is where a game is
 * announced, and a module registered without a season row must not vanish. */
export function gameVisibleOn(game: GameId, channel: string): boolean {
  const s = SEASONS.find((x) => x.key === game);
  return !s || seasonVisibleOn(s, channel);
}

/**
 * "DECODE presented by RTX" — the game's name plus its presenting sponsor, or
 * just the name when it has none. For plain-text surfaces (the <title>, meta
 * descriptions). Anything that UPPERCASES its text should render `name` and
 * `presenter` separately instead, so a mixed-case brand isn't flattened.
 */
export function fullNameOf(s: Season): string {
  return s.presenter ? `${s.name} presented by ${s.presenter}` : s.name;
}

/** the season the sim is currently built for (the first playable game) */
export const CURRENT_SEASON: Season =
  SEASONS.find((s) => s.playable) ?? SEASONS[0];

/** the season record for a game id (defaults to the first entry, DECODE). */
export function seasonFor(game: GameId): Season {
  return SEASONS.find((s) => s.key === game) ?? SEASONS[0];
}

/**
 * Canonical label for a competitive PERIOD (a leaderboard/records bucket).
 *
 * Periods form an Act → Season hierarchy: multiple seasons per act, both
 * 1-indexed, plus a historical **Act 0** for the beta / pre-season. The label is
 * the admin's custom title when set, else the structured "Act X · Season Y"
 * coordinate. Used by the leaderboard badge/picker and the career panel so every
 * surface names a period identically.
 */
export function periodLabel(p: { name?: string | null; act: number; seasonNo: number }): string {
  const custom = p.name?.trim();
  if (custom) return custom;
  return `Act ${p.act} · Season ${p.seasonNo}`;
}
