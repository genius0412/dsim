/**
 * THE STORAGE REGISTRY — every browser-storage key this app writes, in one place.
 *
 * It exists because the privacy policy used to enumerate these keys in prose, and prose
 * drifts: by the time this was written `PRIVACY_MD` named four keys (`decodesim.active`,
 * `decodesim.chain`, `decodesim.friends`, `decodesim.seen`) that DO NOT EXIST under those
 * spellings, and said nothing at all about the seven added since — graphics, view, camera,
 * prediction, the tutorial flag, the practice-run logs, the LAN backlog. A policy that
 * misdescribes what it stores is worse than no policy, and nobody was ever going to catch it
 * by reading, because the list and the code were in different files.
 *
 * So the list IS the code. Two rules keep it that way, and `npm test` enforces both:
 *
 *  1. **No `decodesim.` string literal anywhere in `src/` except this file.** That is what
 *     makes a new key impossible to add without registering it — there is nowhere else it
 *     may be written down.
 *  2. **Every file that touches `localStorage`/`sessionStorage` imports from here.** The key
 *     is always an identifier off this module, or a documented `…Key(id)` accessor derived
 *     from one, which is how the two run indexes address their per-run bodies.
 *
 * The privacy page renders its table straight off `STORAGE_KEYS` (`src/ui/YourData.tsx`), so
 * adding an entry publishes it. `PRIVACY_MD` describes the CATEGORIES and points at that
 * table; it names no keys.
 *
 * ⚠️ ONE LITERAL LIVES OUTSIDE THIS FILE, deliberately: `index.html`'s blocking theme stamp,
 * which runs before any module loads and therefore cannot import anything. The smoke check
 * reads that script and asserts the literal in it still equals `THEME_KEY`.
 *
 * This module is a LEAF — no imports, no DOM, no React — in the `src/contributors.ts` sense,
 * so sim-adjacent code (`net/practiceRuns.ts`) and the UI can both take it.
 */

/** which store: `localStorage` outlives the browser closing, `sessionStorage` dies with the tab */
export type StorageKind = 'local' | 'session';

/**
 * WHAT THE KEY IS FOR, in the three buckets a consent standard recognises.
 *
 *  - `necessary`  — the app cannot do what you asked without it: the room code that lets a
 *                   reload rejoin your match, the input log of the run you just drove.
 *  - `preference` — a choice you made, remembered. Nothing here is required to play.
 *  - `analytics`  — measurement of how the app is used.
 *
 * ⚠️ NOTHING IS IN `analytics`, AND THAT IS A FACT WORTH STATING rather than a gap in the
 * list. DSIM's analytics (Vercel Web Analytics) is cookieless and writes nothing to this
 * device; `ANALYTICS_KEY` below is its OFF SWITCH, which is a preference. The category stays
 * in the type because the honest answer to "which of these are analytics" is "none", and a
 * type unable to express the question could not answer it either.
 */
export type StorageCategory = 'necessary' | 'preference' | 'analytics';

export interface StorageKeyEntry {
  key: string;
  storage: StorageKind;
  /** what it holds and why, in one sentence somebody who does not write code can read */
  purpose: string;
  /** when it goes away — the column a data-protection request actually asks about */
  retention: string;
  category: StorageCategory;
}

// ---- the keys ---------------------------------------------------------------
// One exported constant per key rather than a lookup object, so a use site reads
// `localStorage.getItem(THEME_KEY)` and the smoke check can tell an identifier from a
// literal without parsing TypeScript.

/** `GameSettings` — the whole tuned setup, and the one key that also syncs to an account */
export const SETTINGS_KEY = 'decodesim.settings.v1';
/** light / dark / follow-the-OS (`src/theme.ts`, and `index.html`'s first-paint stamp) */
export const THEME_KEY = 'decodesim.theme';
/** 3D quality preset — a property of THIS machine's GPU, so never an account setting */
export const GRAPHICS_KEY = 'decodesim.graphics';
/** 2D or 3D renderer, per device. `.v2` since the default moved to 3D (2026-09-23): a new key
 *  rather than a rewrite of the old one, so every device starts on 3D once, including those
 *  that had stored `'2d'`. The old `decodesim.view` is no longer read. */
export const VIEW_KEY = 'decodesim.view.v2';
/** which 3D camera the last match was watched from */
export const CAMERA_KEY = 'decodesim.camera';
/** the driver's own height, for the height-accurate BIOBUZZ 3D driver camera — per device */
export const DRIVER_HEIGHT_KEY = 'decodesim.driverHeight';
/** which mouse-button layout the BIOBUZZ 3D free camera uses, and its zoom direction */
export const FREE_CAM_NAV_KEY = 'decodesim.freeCamNav';
/** client-side prediction on/off — a per-device netcode preference */
export const PREDICTION_KEY = 'decodesim.prediction';
/** that the "prediction is off" notice has been shown once, so it is not shown again */
export const PREDICTION_OFF_NOTICE_KEY = 'decodesim.prediction.offNotice';
/** this tab already reloaded once for an out-of-date page file after a deploy (`main.tsx`) */
export const CHUNK_RELOAD_KEY = 'decodesim.chunkReload';
/** usage analytics on/off. Absent means ON — `src/analytics.ts` says why */
export const ANALYTICS_KEY = 'decodesim.analytics';
/** which games’ tutorials this device has finished, exited or turned down (comma-separated ids; legacy `1` = all) */
export const TUTORIAL_SEEN_KEY = 'decodesim.tutorial.v1';
/** the Chain Reaction "unofficial game" disclaimer has been dismissed */
export const CHAIN_DISCLAIMER_KEY = 'decodesim.chainDisclaimer.v2';
/** which in-app announcements have been read (the last 200 ids) */
export const SEEN_ANNOUNCEMENTS_KEY = 'decodesim.seenAnnouncements.v1';
/** the friends rail was left expanded */
export const FRIENDS_PANEL_OPEN_KEY = 'decodesim.friendsPanelOpen';
/** the address of the self-hosted (LAN) server this browser last joined */
export const LAN_SERVER_KEY = 'decodesim.lanServer.v1';
/** the multiplayer room this browser is in, so a reload rejoins instead of losing the match */
export const ACTIVE_GAME_KEY = 'decodesim.activeGame.v1';
/** a ranked match the matchmaker staged for you, so a reload still finds it */
export const STAGED_MATCH_KEY = 'decodesim.stagedMatch.v1';
/** index of your solo practice runs. Each run's log sits at `PRACTICE_RUNS_KEY.<id>` */
export const PRACTICE_RUNS_KEY = 'decodesim.practice.v1';
/** index of self-hosted matches awaiting upload. Bodies at `LAN_RUNS_KEY.<id>` */
export const LAN_RUNS_KEY = 'decodesim.lanruns.v1';
/** the "verify your email" banner, dismissed for this tab only */
export const VERIFY_BANNER_KEY = 'decodesim.verifyBanner.v1';
/**
 * the Discord Activity instance this tab was launched into. Written ONLY inside an activity
 * embed; the launch URL carries it once and the router drops it, so a reload would otherwise
 * lose the party (`net/discordActivity.ts`)
 */
export const DISCORD_INSTANCE_KEY = 'decodesim.discordInstance.v1';
/** the Zenith auto library (`src/auto/library.ts`): auto files for AUTO, per game, this device only */
export const ZENITH_AUTOS_KEY = 'decodesim.zenithAutos.v1';

/**
 * THE INVENTORY, in the order the privacy page prints it: `necessary` first (the ones you
 * cannot decline and still play), then `preference`, alphabetically by key inside each group.
 *
 * `retention` answers "when does this go away", because that is what a deletion request
 * asks. "Until you clear your browser data" appears a lot, and it is a real answer: nothing
 * here has a server-side expiry, because nothing here is on a server.
 */
export const STORAGE_KEYS: readonly StorageKeyEntry[] = [
  {
    key: ACTIVE_GAME_KEY,
    storage: 'local',
    category: 'necessary',
    purpose:
      'The room code of the multiplayer match this browser is in, so closing the tab by accident and reopening it rejoins the match instead of abandoning your alliance.',
    retention: 'Removed when the match ends or you leave it.',
  },
  {
    key: DISCORD_INSTANCE_KEY,
    storage: 'session',
    category: 'necessary',
    purpose:
      'The Discord activity this tab was launched into, so a reload inside the activity still finds the same party. Only written when DSIM runs as a Discord Activity.',
    retention: 'Ends with this browser tab.',
  },
  {
    key: LAN_RUNS_KEY,
    storage: 'local',
    category: 'necessary',
    purpose:
      'Matches this device hosted on a self-hosted server, with their input logs, waiting to reach your account. Venue wifi fails at exactly the final whistle, so the match waits here until an upload succeeds.',
    retention: 'Removed once uploaded. The last 40 are kept; the oldest goes first past that.',
  },
  {
    key: PRACTICE_RUNS_KEY,
    storage: 'local',
    category: 'necessary',
    purpose:
      'Your solo practice runs: score, length, and the input log that reproduces the run. Solo practice runs on this device with no server watching it, so this is the only copy until you sign in.',
    retention:
      'The last 10 are kept; the oldest goes first past that. Deleting a run removes it at once.',
  },
  {
    key: ZENITH_AUTOS_KEY,
    storage: 'local',
    category: 'necessary',
    purpose:
      'Your autonomous routines: the Zenith auto files you imported or edited, which one is on, and whether it plays in AUTO. They stay on this device and are not synced to your account, because an auto file is too big for the settings that sync.',
    retention: 'Until you delete an auto from the Autonomous panel or clear your browser data.',
  },
  {
    key: SETTINGS_KEY,
    storage: 'local',
    category: 'necessary',
    purpose:
      'Your robot builds, saved robots, control bindings, driver assists, audio, start positions and mobile layout. Signed in, the same values also sync to your account.',
    retention:
      'Until you clear your browser data, or use "Reset all settings" on your profile. Signed in, the synced copy leaves with your account.',
  },
  {
    key: STAGED_MATCH_KEY,
    storage: 'local',
    category: 'necessary',
    purpose:
      'A ranked match the matchmaker has set up for you, so a reload between the queue and the field still finds it.',
    retention: 'Removed when you enter the match, or shortly after it expires.',
  },
  {
    key: VERIFY_BANNER_KEY,
    storage: 'session',
    category: 'necessary',
    purpose: 'That you dismissed the "verify your email" banner, so it stays dismissed.',
    retention: 'Ends with this browser tab.',
  },
  {
    key: CHUNK_RELOAD_KEY,
    storage: 'session',
    category: 'necessary',
    purpose:
      'That this tab has already reloaded once to pick up a new version of the site, so a missing file cannot make it reload forever.',
    retention: 'Ends with this browser tab.',
  },
  {
    key: ANALYTICS_KEY,
    storage: 'local',
    category: 'preference',
    purpose:
      'Whether anonymous usage analytics are on. Absent means on, because the measurement is cookieless and carries no identifiers; the switch is below.',
    retention: 'Until you clear your browser data.',
  },
  {
    key: CAMERA_KEY,
    storage: 'local',
    category: 'preference',
    purpose: 'Which 3D camera you last watched a match from.',
    retention: 'Until you clear your browser data.',
  },
  {
    key: CHAIN_DISCLAIMER_KEY,
    storage: 'local',
    category: 'preference',
    purpose: 'That you have read the notice explaining Chain Reaction is an unofficial game.',
    retention: 'Until you clear your browser data.',
  },
  {
    key: DRIVER_HEIGHT_KEY,
    storage: 'local',
    category: 'preference',
    purpose:
      'Your own height, if you entered it, to place BIOBUZZ’s 3D driver camera at your real eye level. Kept per device, since the person in front of the screen is not an account fact.',
    retention: 'Until you clear your browser data, or use the setting’s "Clear" button.',
  },
  {
    key: FREE_CAM_NAV_KEY,
    storage: 'local',
    category: 'preference',
    purpose: 'Which mouse-button layout the free 3D camera uses, and which way the scroll wheel zooms.',
    retention: 'Until you clear your browser data.',
  },
  {
    key: FRIENDS_PANEL_OPEN_KEY,
    storage: 'local',
    category: 'preference',
    purpose: 'Whether the friends rail is expanded.',
    retention: 'Until you clear your browser data.',
  },
  {
    key: GRAPHICS_KEY,
    storage: 'local',
    category: 'preference',
    purpose:
      'The 3D quality preset for this machine. Kept per device rather than per account, because a graphics card is a property of the computer in front of you.',
    retention: 'Until you clear your browser data.',
  },
  {
    key: LAN_SERVER_KEY,
    storage: 'local',
    category: 'preference',
    purpose: 'The address of the self-hosted server you last joined, so you can rejoin it.',
    retention: 'Until you clear your browser data, or leave the self-hosted server.',
  },
  {
    key: PREDICTION_KEY,
    storage: 'local',
    category: 'preference',
    purpose:
      'Whether the client predicts your robot between server updates. A per-device feel setting, not an account one.',
    retention: 'Until you clear your browser data.',
  },
  {
    key: PREDICTION_OFF_NOTICE_KEY,
    storage: 'local',
    category: 'preference',
    purpose: 'That the "prediction is off" explanation has already been shown once.',
    retention: 'Until you clear your browser data.',
  },
  {
    key: SEEN_ANNOUNCEMENTS_KEY,
    storage: 'local',
    category: 'preference',
    purpose:
      'Which in-app announcements you have read, as a list of the last 200 announcement ids. It works signed out, which is why it is not on your account.',
    retention: 'Until you clear your browser data.',
  },
  {
    key: THEME_KEY,
    storage: 'local',
    category: 'preference',
    purpose:
      'Light, dark, or follow your system. Read before the first paint, so the page does not flash the wrong theme.',
    retention: 'Until you clear your browser data.',
  },
  {
    key: TUTORIAL_SEEN_KEY,
    storage: 'local',
    category: 'preference',
    purpose:
      'Which games’ tutorials you have finished, left or turned down on this device, so the first-run card for that game is not shown again.',
    retention: 'Until you clear your browser data.',
  },
  {
    key: VIEW_KEY,
    storage: 'local',
    category: 'preference',
    purpose: 'Whether matches are drawn in 2D or 3D on this device.',
    retention: 'Until you clear your browser data.',
  },
];

/** the entries in one category, in registry order — what the inventory table groups by */
export function storageKeysIn(category: StorageCategory): readonly StorageKeyEntry[] {
  return STORAGE_KEYS.filter((e) => e.category === category);
}

/**
 * Every category, in the order the page shows them — INCLUDING the empty one.
 *
 * The page prints "None" against a category with no entries rather than hiding it, which is
 * the whole reason `analytics` is worth listing: a visitor looking for the tracking keys gets
 * an answer instead of an absence, and if somebody later adds one it appears there by
 * construction rather than by anyone remembering to update the copy.
 */
export const STORAGE_CATEGORY_ORDER: readonly StorageCategory[] = [
  'necessary',
  'preference',
  'analytics',
];

/** the category heading, and one line saying what the group means */
export const STORAGE_CATEGORY_LABEL: Record<StorageCategory, string> = {
  necessary: 'Needed to play',
  preference: 'Your preferences',
  analytics: 'Analytics',
};

export const STORAGE_CATEGORY_BLURB: Record<StorageCategory, string> = {
  necessary: 'Without these the thing you asked for does not work. They are not tracking.',
  preference: 'Choices you made, remembered on this device. Nothing here is needed to play.',
  analytics: 'Measurement of how the app is used.',
};
