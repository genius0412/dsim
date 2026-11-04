import { PLATE_FONT_KEYS, clampCosmetics, type Cosmetics, type PlateFont } from './cosmetics';

/**
 * PLATE FONTS — the faces a robot sign's team number is printed in, how to lay a number out in
 * one, and how a face is fetched (owner, 2026-11-04: "the number inside the number plate is not
 * vertically centered. The font is also kinda ugly and it looks like the number is stretched
 * vertically, making the numbers really thin").
 *
 * ── WHAT WAS WRONG WITH THE OLD SIGN (`getSignTexture`, `scene/renderRobots.ts`) ─────────────
 *  · OFF CENTRE: it set `textBaseline = 'middle'`, which centres the EM BOX, not the numerals.
 *    The em box reaches down to the descender, and digits sit on the baseline and rise to the
 *    cap height, so the digits landed high: on a captured 3D sign the gap above "788" was 5 px
 *    and below it 31 px. The face was `system-ui`, so how far off it was changed per platform.
 *  · STRETCHED: a five-digit number is wider than the plate at R403's 2.25-in height, and it was
 *    fitted with `ctx.scale(squeeze, 1)` — the digits were condensed to about 70 % of their width
 *    at full height. That anisotropic scale is the "stretched vertically, really thin" look. The
 *    texture's aspect was NOT the cause: 312 × 132 px is exactly the plate's 6.5 × 2.75 in.
 *
 * ── WHAT IT DOES NOW (`src/plateLayout.ts`) ───────────────────────────────────────────────────
 * `plateTextLayout` scales UNIFORMLY, always: the numerals are R403's 2.25 in tall when they fit
 * the plate's width inside its 0.25-in margin, and smaller, at the face's own proportions, when
 * they do not. A string of digits is centred on its CAP BAND (baseline to cap height), which is
 * the optical centre of lining figures; the hyphen a numberless robot shows is centred on its own
 * ink. Horizontally the INK is centred, not the advance, so side bearings do not pull it off.
 * The layout reads a per-glyph table measured out of the very files the browser loads
 * (`scripts/plate-fonts.py`), so it is pure and `npm test` holds it to ±2 % of centre.
 *
 * ── THE FACES ─────────────────────────────────────────────────────────────────────────────────
 * Five SIL OFL 1.1 typefaces, subset to the eleven glyphs a sign can print (about 1.1–1.6 KB of
 * WOFF2 each), self-hosted in `src/assets/plateFonts/` with their licence (`OFL.txt`). None has a
 * Reserved Font Name, so the subsets keep their names. Nothing is fetched from a font CDN.
 *   standard  Barlow Semi Condensed ExtraBold — the default, free: a heavy sport sans whose
 *             numerals keep a five-digit number near full height
 *   block     Archivo Black — a wide heavy grotesque, the vinyl-sticker look
 *   racing    Saira ExtraBold — squared motorsport numerals
 *   angular   Chakra Petch Bold — cut corners
 *   mono      JetBrains Mono ExtraBold — engineering monospace
 * Gimmicky faces (stencil, varsity, pixel) were left out on purpose: robots look FTC-real.
 *
 * ── LOADED LAZILY ─────────────────────────────────────────────────────────────────────────────
 * A face is fetched the first time a sign is painted in it (`loadPlateFont`), or when the
 * builder's picker shows it, and never otherwise. Until it lands a sign paints in the bold system
 * face through the same layout (measured), then repaints in place, so a robot never shows an
 * empty plate. DOM-free at import.
 *
 * ── TWO FILES, FOR THE MAIN CHUNK ─────────────────────────────────────────────────────────────
 * This one is the registry and the loader, which the builder's picker needs, so it is in the
 * bundle every player downloads. The measured glyph table and the layout are `plateLayout.ts`,
 * which only the 3D sign (the scene chunk) and `npm test` import.
 */

export interface PlateFontFace {
  key: PlateFont;
  /** the picker's name for it */
  label: string;
  /** the CSS family `loadPlateFont` registers it under (unique to DSIM, so a user's installed copy
   *  of the same face can never be picked up instead) */
  family: string;
  /** the typeface it is cut from, for the credit */
  typeface: string;
  /** the subset WOFF2 */
  url: string;
}

/**
 * ⚠️ EACH `new URL` IS A STRING LITERAL ON PURPOSE. That is the form Vite recognises, emits the
 * file for and rewrites to the hashed asset path (relative under the desktop build's `./` base);
 * under Node (`npm test`) it is just a `file:` URL that nothing fetches. A computed path would be
 * neither emitted nor found.
 */
const URLS: Record<PlateFont, string> = {
  standard: new URL('./assets/plateFonts/standard.woff2', import.meta.url).href,
  block: new URL('./assets/plateFonts/block.woff2', import.meta.url).href,
  racing: new URL('./assets/plateFonts/racing.woff2', import.meta.url).href,
  angular: new URL('./assets/plateFonts/angular.woff2', import.meta.url).href,
  mono: new URL('./assets/plateFonts/mono.woff2', import.meta.url).href,
};

const NAMES: Record<PlateFont, [label: string, typeface: string]> = {
  standard: ['Standard', 'Barlow Semi Condensed ExtraBold'],
  block: ['Block', 'Archivo Black'],
  racing: ['Racing', 'Saira ExtraBold'],
  angular: ['Angular', 'Chakra Petch Bold'],
  mono: ['Mono', 'JetBrains Mono ExtraBold'],
};

export const PLATE_FONTS: Readonly<Record<PlateFont, PlateFontFace>> = Object.fromEntries(
  PLATE_FONT_KEYS.map((key) => [
    key,
    { key, label: NAMES[key][0], family: `DSIM Plate ${NAMES[key][0]}`, typeface: NAMES[key][1], url: URLS[key] },
  ]),
) as Record<PlateFont, PlateFontFace>;

/** the face a spec's sign is printed in — the default for an absent or unknown key */
export function plateFontOf(spec: Cosmetics): PlateFontFace {
  return PLATE_FONTS[clampCosmetics(spec).plateFont as PlateFont];
}

// ── loading ─────────────────────────────────────────────────────────────────────────────────
const loads = new Map<PlateFont, Promise<boolean>>();
const ready = new Set<PlateFont>();

/** has `key`'s face landed, so a canvas can paint in it this frame? */
export function plateFontReady(key: PlateFont): boolean {
  return ready.has(key);
}

/**
 * Fetch and register `key`'s face, once. Resolves `true` when a canvas can paint in it, `false`
 * where it cannot (no `FontFace` — a Node test — or a failed fetch, which the next ask retries,
 * so a dropped request does not leave every later robot in the fallback face).
 */
export function loadPlateFont(key: PlateFont): Promise<boolean> {
  const had = loads.get(key);
  if (had) return had;
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return Promise.resolve(false);
  const face = PLATE_FONTS[key];
  const p = new FontFace(face.family, `url(${face.url}) format('woff2')`)
    .load()
    .then((loaded) => {
      document.fonts.add(loaded);
      ready.add(key);
      return true;
    })
    .catch((err: unknown) => {
      console.warn(`[plateFonts] couldn’t load the ${key} plate font`, err);
      loads.delete(key);
      return false;
    });
  loads.set(key, p);
  return p;
}
