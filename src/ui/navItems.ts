import type { ShellNav } from './AppShell';

/** The colour a section owns. `data-hue` on `.ds-app` (by screen) and on a `MenuTile` picks one of
 *  the accent scopes in shell.css; `mint` is the base palette, stated explicitly so a tile inside
 *  a coloured screen can still be mint. */
export type Hue = 'mint' | 'coral' | 'violet' | 'blue' | 'amber';

/** the top-level destinations, in the order they appear on the home menu.
 *
 * A hint NAMES WHAT IS BEHIND THE LABEL; it never restates it. `mono` is the big glyph at the
 * tile's left edge. The list also feeds the app bar's title lookup (`AppShell`). */
export const NAV_ITEMS: ReadonlyArray<{ id: ShellNav; label: string; hint: string; mono: string; hue: Hue }> = [
  { id: 'multiplayer', label: 'Multiplayer', hint: 'Rooms, ranked and competitions', mono: 'MP', hue: 'coral' },
  { id: 'solo', label: 'Solo', hint: 'Practice, free drive and record runs', mono: '1P', hue: 'violet' },
  { id: 'records', label: 'Records', hint: 'Leaderboard & career', mono: 'REC', hue: 'mint' },
  { id: 'configure', label: 'Configure', hint: 'Robot & match setup', mono: 'CFG', hue: 'blue' },
  { id: 'profile', label: 'Profile', hint: 'Appearance & account', mono: 'ME', hue: 'amber' },
];

/** which hue a shell screen wears. A screen not listed keeps the base mint. */
export const SCREEN_HUE: Readonly<Record<string, Hue>> = {
  multiplayer: 'coral',
  watch: 'coral',
  competitions: 'coral',
  solo: 'violet',
  records: 'mint',
  configure: 'blue',
  robotimport: 'blue',
  account: 'amber',
  profile: 'amber',
};

/**
 * ⚠️ PROFILE IS NOT OFFERED INSIDE A DISCORD ACTIVITY, because both halves of it are an
 * account and the embed can never have one: the page is a cross-origin iframe whose CSP
 * admits only Discord's own URL mappings, the auth host is not one, and the participant is
 * therefore ALWAYS signed out. Behind the item, Appearance is name/title/badges (all
 * server-held) and Account is sign-in, email, password, linked accounts and membership —
 * so the destination is a sign-in offer wearing two labels, which is the dead end this
 * whole ruling is about (the app bar's "?" avatar and the ranked tiles went the same way).
 *
 * The page itself is NOT deleted: it stays routable and, in the embed, says where the
 * account went and keeps the one local control on it (Reset all settings). Somebody who
 * has an account on the website is owed that sentence — what they are not owed is a
 * top-level menu entry that only ever leads to it.
 *
 * Host-based, and asked per render rather than at module load: `discordGroup()` is empty
 * after a storage-blocked reload, which would quietly put the item back on the one client
 * where it is most confusing.
 */
export function navItems(inActivity: boolean): typeof NAV_ITEMS {
  return inActivity ? NAV_ITEMS.filter((it) => it.id !== 'profile') : NAV_ITEMS;
}
