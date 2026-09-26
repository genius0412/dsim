/**
 * ROBOT COSMETICS — the one registry both renderers, the coercer, the builder and the server's
 * entitlement strip read (`docs/cosmetics-plan.md`, built 2026-09-20 on the owner's go-ahead:
 * "the color options for chassis are very dull ... follow our plan of expanding customization
 * options and giving more to free users").
 *
 * ── A LEAF, ON PURPOSE ──────────────────────────────────────────────────────────────────────
 * No imports. `src/config.ts` re-exports the chassis palette from here (every existing importer
 * keeps its name), `src/sim/spawn.ts` clamps against it, and `server/room.ts` strips against it —
 * so anything this file pulled in would be pulled into all of them.
 *
 * ── FOUR AXES, EVERY ONE A CLOSED SET OF KEYS ───────────────────────────────────────────────
 *   chassisColor  the chassis FILL (existing field)
 *   accent        the DRIVE wheels / intake rollers fill; `'match'` = the chassis colour. Never
 *                 the shooter: a flywheel is black in both games (owner, 2026-09-21)
 *   decal         a vector shape drawn over the fill, under the edge line
 *   plate         a frame drawn AROUND the sign placard — the placard's own fill stays alliance
 * The KEY goes over the wire and into replays, never a hex, a path or an image: the wire never
 * parses a colour, nothing can name the artifact green/purple, and every hex here can be retuned
 * without touching a saved robot.
 *
 * ── THE ALLIANCE IS NOT ON THE CHASSIS EDGE ANY MORE ───────────────────────────────────────
 * It used to be a red/blue OUTLINE, and a vivid fill needed a dark halo under it to keep that line
 * readable. The owner removed the outline (2026-09-21): every sprite stroke is the neutral
 * `ROBOT_TRIM` (`render/drawRobot.ts`), and the alliance is the NAME LABEL over the robot, the
 * sign placard and the heading chevron. `OUTLINE_HALO` survives only as the dark swatch in the
 * builder's placard and accent pickers (the 3D edge line went the same day). So a fill still cannot change which alliance a robot reads as.
 *
 * ── TIERS ───────────────────────────────────────────────────────────────────────────────────
 * `free` is always allowed. `supporter` unlocks on the account's `supporter_until`
 * (`SUPPORTER_COL`, the same predicate ads-off uses). `earned` keys are permanent account state
 * (`profiles.cosmetics`, server-written) and survive a lapsed membership — none exist yet; the
 * slot is here so the rewards ledger can fill it without a schema change to this file.
 * ENTITLEMENT IS CHECKED ONLY WHERE A CLIENT DECLARES A SPEC TO THE SERVER (`server/room.ts`),
 * never in `coerceSpec`: an old replay must keep the look it was recorded with whoever watches it.
 */

export type CosmeticTier = 'free' | 'supporter' | 'earned';

/** CHASSIS FILLS. Vivid on purpose; the alliance is never on the fill. `default` is the
 * charcoal every robot has always had. Nothing here is the artifact green (#22c55e) or purple
 * (#a855f7), and nothing is the exact alliance red (#ef4444) or blue (#3b82f6). */
export const CHASSIS_COLORS = {
  default: '#1f242c',
  white: '#e8e9ec',
  silver: '#9aa3ad',
  black: '#0b0d10',
  red: '#c0392b',
  orange: '#f08c1a',
  yellow: '#f2c421',
  green: '#2e9e4f',
  teal: '#14a8a0',
  blue: '#2457c5',
  purple: '#7c3aed',
  pink: '#e0489a',
  // supporter
  gold: '#d4a017',
  lime: '#b6ff2e',
  magenta: '#ff2e88',
  cyan: '#5cc8ff',
  lavender: '#b9a7ff',
  ember: '#ff5a1f',
} as const;
export type ChassisColor = keyof typeof CHASSIS_COLORS;
export const CHASSIS_COLOR_KEYS = Object.keys(CHASSIS_COLORS) as ChassisColor[];

/** the chassis fill for a spec — the default for any key an older or spoofed spec carries that
 * we no longer recognise. */
export function chassisFill(key: string | undefined): string {
  return (key && CHASSIS_COLORS[key as ChassisColor]) || CHASSIS_COLORS.default;
}

/** the fixed dark swatch the builder's placard and accent pickers draw against. */
export const OUTLINE_HALO = '#0b0d10';

/** ACCENT — wheels and rollers. `match` follows the chassis. */
export const ACCENT_KEYS = ['match', ...CHASSIS_COLOR_KEYS] as const;
export type Accent = (typeof ACCENT_KEYS)[number];
export function accentFill(accent: string | undefined, chassisColor: string | undefined): string {
  if (!accent || accent === 'match' || !(accent in CHASSIS_COLORS)) return chassisFill(chassisColor);
  return CHASSIS_COLORS[accent as ChassisColor];
}

/**
 * DECALS — drawn shapes, parametric in the footprint, never images.
 *
 * ⚠️ **`star` IS THE FIRST `earned` KEY THIS FILE HAS EVER HAD**, and it is earned by being
 * absent from BOTH tier sets below rather than by being listed in a third one — `cosmeticTier`
 * already falls through to `'earned'`, and the header has promised since the palette shipped
 * that "the slot is here so the rewards ledger can fill it without a schema change to this
 * file". This is the ledger filling it.
 *
 * It is NOT a supporter key handed out for free, and that was a deliberate call (owner asked for
 * a cosmetic on the GitHub star, 2026-09-21): a star is one click, so gifting one of the six
 * premium fills would price a Ko-fi membership at one click. An exclusive key costs the
 * supporter tier nothing and is worth more as a reward for being exclusive.
 */
export const DECAL_KEYS = ['none', 'stripe', 'chevron', 'racing', 'hazard', 'checker', 'star'] as const;
export type Decal = (typeof DECAL_KEYS)[number];

/** PLATE frames round the sign placard. `classic` is no frame. */
export const PLATE_KEYS = ['classic', 'bold', 'rounded'] as const;
export type Plate = (typeof PLATE_KEYS)[number];

/** the choice a spec carries; every field optional so every old save and replay stays valid. */
export interface Cosmetics {
  chassisColor?: string;
  accent?: string;
  decal?: string;
  plate?: string;
}

/** `"<axis>:<key>"` — the unit the tier table and `profiles.cosmetics` speak. */
export type CosmeticId = `${'chassisColor' | 'accent' | 'decal' | 'plate'}:${string}`;

/** WHICH TIER EACH KEY SITS IN. Absent from both lists ⇒ `earned`. Free is deliberately WIDE
 * (owner: "giving more to free users"): the whole basic palette, a plain stripe, a rounded
 * plate. Supporters get the six premium fills, any accent, the four patterned decals, the bold
 * plate. */
const FREE: ReadonlySet<CosmeticId> = new Set<CosmeticId>([
  ...(['default', 'white', 'silver', 'black', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const).map(
    (k): CosmeticId => `chassisColor:${k}`,
  ),
  'accent:match',
  'accent:black',
  'accent:white',
  'accent:silver',
  'decal:none',
  'decal:stripe',
  'plate:classic',
  'plate:rounded',
]);
const SUPPORTER: ReadonlySet<CosmeticId> = new Set<CosmeticId>([
  ...(['gold', 'lime', 'magenta', 'cyan', 'lavender', 'ember'] as const).map((k): CosmeticId => `chassisColor:${k}`),
  ...CHASSIS_COLOR_KEYS.map((k): CosmeticId => `accent:${k}`),
  'decal:chevron',
  'decal:racing',
  'decal:hazard',
  'decal:checker',
  'plate:bold',
]);

export function cosmeticTier(id: CosmeticId): CosmeticTier {
  if (FREE.has(id)) return 'free';
  if (SUPPORTER.has(id)) return 'supporter';
  return 'earned';
}

/** the default on each axis — what a stripped or absent choice reads as. */
export const COSMETIC_DEFAULTS: Required<Cosmetics> = { chassisColor: 'default', accent: 'match', decal: 'none', plate: 'classic' };

/** the closed set each axis is clamped to (`coerceSpec`). */
export const COSMETIC_AXES: { [K in keyof Required<Cosmetics>]: readonly string[] } = {
  chassisColor: CHASSIS_COLOR_KEYS,
  accent: ACCENT_KEYS,
  decal: DECAL_KEYS,
  plate: PLATE_KEYS,
};

/** SHAPE: fold every axis onto its closed set, unknown ⇒ the default. Pure; no entitlement. */
export function clampCosmetics(c: Cosmetics): Required<Cosmetics> {
  const out = { ...COSMETIC_DEFAULTS };
  for (const axis of Object.keys(COSMETIC_AXES) as (keyof Required<Cosmetics>)[]) {
    const v = c[axis];
    if (typeof v === 'string' && COSMETIC_AXES[axis].includes(v)) out[axis] = v;
  }
  return out;
}

/**
 * ENTITLEMENT: may this account use `id`? `supporter` covers the supporter tier; `earned` is the
 * account's own permanent unlock list (`profiles.cosmetics`), which may also name supporter-tier
 * keys (an earned copy of a paid key stays after the membership lapses).
 */
export function cosmeticAllowed(id: CosmeticId, supporter: boolean, earned: readonly string[]): boolean {
  const tier = cosmeticTier(id);
  if (tier === 'free') return true;
  if (earned.includes(id)) return true;
  return tier === 'supporter' && supporter;
}

/** downgrade every axis the account is not entitled to. Runs at the server's live ingress only. */
export function stripUnentitledCosmetics<T extends Cosmetics>(spec: T, supporter: boolean, earned: readonly string[]): T {
  const c = clampCosmetics(spec);
  const out = { ...spec };
  for (const axis of Object.keys(COSMETIC_AXES) as (keyof Required<Cosmetics>)[]) {
    if (!cosmeticAllowed(`${axis}:${c[axis]}`, supporter, earned)) out[axis] = COSMETIC_DEFAULTS[axis];
  }
  return out;
}
