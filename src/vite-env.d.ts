/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  /** new Supabase publishable key (sb_publishable_…) — client-safe */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** legacy anon key — still accepted as a fallback */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** presenting-sponsor KILL SWITCH — the exact string `0` removes every
   *  placement. Anything else (including absent) leaves the sponsorship on, so a
   *  typo cannot silently void the deal. See `src/sponsor.ts`. */
  readonly VITE_SPONSOR?: string;
  /** override the sponsor artwork without touching the repo — any URL, any format.
   *  `-LIGHT` is the cut for a LIGHT SURFACE (dark ink) and `-DARK` the reverse;
   *  the sponsor calls that first one "the dark logo", so go by the pixels, not by
   *  the label. Defaults to the bundled artwork in `src/assets/sponsors/`, and does
   *  NOT reach the Electron splash, which loads its own copies. See
   *  `docs/sponsor.md`. */
  readonly VITE_SPONSOR_LOGO_LIGHT?: string;
  readonly VITE_SPONSOR_LOGO_DARK?: string;
  /** `1` bakes this build CLOSED: every page shows the closed screen until the server confirms
   *  the signed-in account is an admin or in an access group. Set on the alpha site only.
   *  See `src/net/siteStatus.ts` and docs/deploy.md. */
  readonly VITE_SITE_LOCKDOWN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
