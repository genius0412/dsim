import type { ShellNav } from './AppShell';

/** the four top-level destinations, in the order they appear on the home menu.
 *
 * A hint NAMES WHAT IS BEHIND THE LABEL; it never restates it. "Play → Pick a
 * game mode" said nothing the word Play did not. It is the home menu's list and
 * the top bar's title lookup. (The left rail that also read it is gone: home is the only hub.) */
export const RAIL_ITEMS: ReadonlyArray<{ id: ShellNav; label: string; hint: string }> = [
  { id: 'play', label: 'Play', hint: 'Robot, setup & matches' },
  { id: 'configure', label: 'Configure', hint: 'Controls, audio & network' },
  { id: 'records', label: 'Records', hint: 'Leaderboard & career' },
  { id: 'profile', label: 'Profile', hint: 'Appearance & account' },
];

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
export function railItems(inActivity: boolean): typeof RAIL_ITEMS {
  return inActivity ? RAIL_ITEMS.filter((it) => it.id !== 'profile') : RAIL_ITEMS;
}
