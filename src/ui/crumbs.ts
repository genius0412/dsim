import { RECORDS_HUB, RECORDS_PAGES, isRecordsPage } from './recordsPages';

/**
 * THE BREADCRUMB TRAIL of a shell screen, and the ONE place that decides where "up" is.
 *
 * The app bar renders this after the season name (`AppShell`), and "back" is its second-to-last entry
 * (`parentOf`), so what the bar SHOWS and where a back action GOES are one table and cannot drift
 * apart (they did: `App` used to carry its own `solosetup`/`rooms`/records-page special cases beside
 * a title lookup that knew none of them). Nothing left of the DSIM mark or the season name ever
 * changes between screens, which is why this replaced a Back button that only existed off Home.
 *
 * DOM-free and string-keyed (the `Screen` union lives in `App.tsx`), so `npm test` can hold it.
 * Full-screen surfaces (the game, a joined room, a replay) are NOT here: they render outside the
 * shell and their Back leaves a live socket, which is a different action. Ranked, Duo record, Room
 * entry and LAN are popups over Play now (`App.tsx` `POPUPS`), and the bar shows Play's trail under
 * one; their entries here are what a crumb to one of them would read.
 */
export interface CrumbTarget {
  screen: string;
  sub?: string | null;
}
export interface Crumb {
  label: string;
  /** where this crumb goes. Absent on the LAST crumb: you are already there. */
  to?: CrumbTarget;
}

const HOME: CrumbTarget = { screen: 'home' };
const PLAY: Crumb = { label: 'Play', to: { screen: 'modes' } };
const RECORDS: Crumb = { label: 'Records', to: { screen: 'records', sub: RECORDS_HUB } };
const ROBOT: Crumb = { label: 'Robot', to: { screen: 'configure', sub: 'robot' } };
const PROFILE: Crumb = { label: 'Profile', to: { screen: 'account', sub: 'appearance' } };

/** the pages reached from the footer, each one level under Home */
const FOOTER_PAGES: Readonly<Record<string, string>> = {
  download: 'Download',
  contributors: 'Contributors',
  changelogs: 'Changes',
  privacy: 'Privacy',
  terms: 'Terms',
  donate: 'Support',
  accountreset: 'Reset password',
  accountverify: 'Verify email',
  admin: 'Admin',
  dev: 'Dev',
};

/** the last crumb of a trail: a label with no target (you are here) */
const here = (label: string): Crumb => ({ label });
/** a trail's parents, with the final crumb stripped of its target */
const trail = (...parents: Crumb[]) => (label: string): Crumb[] => [...parents, here(label)];

/**
 * The trail for a shell screen. Home is `[]` (the bar is the same markup minus the trail). An
 * unknown screen is `[]` too, so a new screen that forgets its entry shows no trail rather than
 * a wrong one; `npm test` asserts every shell screen has one.
 *
 * `sub` is the route's own `sub` (a records page, an account page) and `username` a public
 * profile's name.
 */
export function crumbsFor(screen: string, sub: string | null = null, username: string | null = null): Crumb[] {
  switch (screen) {
    case 'home':
      return [];
    case 'modes':
      return [here('Play')];
    case 'rooms':
      return trail(PLAY)('Browse rooms');
    case 'competitions':
      return trail(PLAY)('Competitions');
    case 'matchmaking':
      return trail(PLAY)('Ranked');
    case 'duorecord':
      return trail(PLAY)('Duo record');
    case 'lobby':
      return trail(PLAY)('Room');
    case 'lan':
      return trail(PLAY)('LAN');
    // Robot is a Play page (a tile beside the two setup tiles) that keeps the `/configure/robot` route
    case 'configure':
      return sub === 'robot' ? trail(PLAY)('Robot') : [here('Configure')];
    case 'robotimport':
      return trail(PLAY, ROBOT)('Import robot');
    case 'records': {
      if (!isRecordsPage(sub)) return [here('Records')];
      const page = RECORDS_PAGES.find((p) => p.key === sub);
      return trail(RECORDS)(page?.label ?? 'Records');
    }
    // a public profile is reached from a leaderboard, the feed or the search, all of them Records
    case 'profile':
      return trail(RECORDS)(username || 'Player');
    case 'account':
      return sub === 'appearance' ? [here('Profile')] : trail(PROFILE)('Account');
    default: {
      const label = FOOTER_PAGES[screen];
      return label ? [here(label)] : [];
    }
  }
}

/** where "up" is from a trail: its second-to-last crumb, or Home from a top-level screen */
export function parentOf(crumbs: readonly Crumb[]): CrumbTarget {
  return crumbs.length >= 2 ? (crumbs[crumbs.length - 2].to ?? HOME) : HOME;
}
