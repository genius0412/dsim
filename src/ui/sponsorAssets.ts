/**
 * The sponsor's artwork, resolved to real URLs.
 *
 * SEPARATE FROM `src/sponsor.ts`, and the split is load-bearing twice over:
 *
 *  - `src/sponsor.ts` stays importable by the headless smoke suite, which runs
 *    under `tsx` with no bundler and would choke on an image import.
 *  - the imports below go through VITE, which rewrites them against the build's
 *    `base`. The desktop build sets `ELECTRON=1` → `base: './'` and runs from
 *    `file://`, where an absolute `/sponsors/…` path out of `public/` resolves to
 *    the filesystem root and 404s. The desktop app is one of the placements that
 *    was bought, so that is not a cosmetic failure.
 *
 * ⚠️ THE FILENAMES SAY WHICH SURFACE, NOT WHICH INK, and they are spelled
 * `on-light` / `on-dark` precisely because the two conventions collide: the
 * sponsor's own files are `OffsetLogoLight.png` (a BLACK wordmark, for a light
 * surface) and `OffsetLogoDark.png` (a near-white one), while the sponsor
 * describes the black cut as "the dark logo". Going by the label rather than by
 * the pixels puts white ink on a white page. See `docs/sponsor.md`.
 */
import offsetOnLight from '../assets/sponsors/offset-on-light.png';
import offsetOnDark from '../assets/sponsors/offset-on-dark.png';

const env = import.meta.env;

/** for a LIGHT surface — dark ink. Light theme, and the light-theme HUD card. */
export const SPONSOR_LOGO_LIGHT: string =
  (env.VITE_SPONSOR_LOGO_LIGHT as string | undefined) ?? offsetOnLight;

/** for a DARK surface — light ink. Dark theme, and ALWAYS the replay burn-in,
 *  whose plate is painted dark at every theme. NOT automatically the in-game
 *  chip: `--ds-hud` inverts, so a light-theme HUD card is WHITE on the dark
 *  field and the chip takes the ordinary swap like any other placement. */
export const SPONSOR_LOGO_DARK: string =
  (env.VITE_SPONSOR_LOGO_DARK as string | undefined) ?? offsetOnDark;
