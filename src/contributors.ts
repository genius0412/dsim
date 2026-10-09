import { hdriEnvironments } from './games/biobuzz/graphics/environments';

/**
 * The Contributors page's roster.
 *
 * This is HAND-MAINTAINED, and deliberately so: none of it is derivable from the
 * account system. Auth is Neon Auth only — there is no Discord OAuth anywhere in
 * this codebase, so a Discord avatar or profile link can't be looked up, and a
 * contributor's game account (if they even have one) isn't linked to their GitHub
 * handle either. Keep it in step with `CONTRIBUTORS.md`, which is the CLA record;
 * this file is only what the page renders.
 *
 * EVERY field except `fallbackName` is optional, and the card degrades cleanly
 * without each one — a contributor with no game account, no Discord, or no avatar
 * still renders. That matters because the page must also work when the game server
 * is unreachable (a cold Fly machine, or a Vercel preview with no
 * `VITE_GAME_SERVER_URL`), where NO live handle resolves for anyone.
 */
export interface Contributor {
  /** Shown until (or instead of) a live game handle resolves. Required — it is the
   * only thing standing between a cold server and a page of blank cards. */
  fallbackName: string;
  /** Short role/credit line, e.g. "Project owner". */
  role?: string;
  /** In-game username (the `/profile/<username>` slug). Drives the LIVE display
   * name and the profile link. Omit for contributors with no game account: the
   * card then shows `fallbackName` and isn't clickable. */
  inGameUsername?: string;
  /** Full Discord CDN avatar URL. Omit to render initials instead. */
  discordAvatarUrl?: string;
  /** Discord profile link (`https://discord.com/users/<id>`). */
  discordUrl?: string;
  /** GitHub profile link. */
  githubUrl?: string;
}

/**
 * CORE TEAM — the owner, plus anyone else `CONTRIBUTORS.md` marks with a staff-level
 * `role` rather than just a name. Today that is the owner alone; a second entry here
 * means giving them a `role` in `CONTRIBUTORS.md` first, not just moving their card.
 *
 * TODO(fill in): `discordAvatarUrl` and `discordUrl` still need collecting.
 */
export const CORE_TEAM: Contributor[] = [
  {
    fallbackName: 'Dohun Kim',
    role: 'Project owner',
    inGameUsername: 'ace',
    githubUrl: 'https://github.com/genius0412',
  },
];

/**
 * CONTRIBUTORS — everyone in `CONTRIBUTORS.md` who isn't core team, signed CLA and
 * pre-CLA alike (the page does not distinguish; `CONTRIBUTORS.md` is the record of
 * that, not this page). Names and GitHub handles come straight from that file, in
 * its order.
 *
 * TODO(fill in): `discordAvatarUrl`, `discordUrl`, and `inGameUsername` have to be
 * collected from each contributor — they aren't recorded anywhere in the repo.
 * Cards render correctly with the fields still missing, so this list can be
 * completed one person at a time without breaking the page.
 */
export const CONTRIBUTORS: Contributor[] = [
  {
    fallbackName: 'Felix D',
    inGameUsername: 'felix',
    githubUrl: 'https://github.com/crescent',
  },
  {
    fallbackName: 'Shlok Khandelwal',
    githubUrl: 'https://github.com/shlok-k720',
  },
  {
    fallbackName: 'Aadvik Gupta',
    inGameUsername: 'aadvikg_',
    githubUrl: 'https://github.com/aadvikgg',
  },
  {
    fallbackName: 'Baron',
    inGameUsername: 'Baron',
    githubUrl: 'https://github.com/BaronClaps',
  },
  {
    fallbackName: 'Shaan Sridhara',
  },
  {
    fallbackName: 'therealkingcob',
    githubUrl: 'https://github.com/therealkingcob',
  },
];

/**
 * Package versions read from `package.json`, baked in at build time by
 * `vite.config.ts` (`__THIRD_PARTY_VERSIONS__`, same technique as `__BUILD_ID__` —
 * see `src/net/version.ts`). `declare const` rather than an import: this file has
 * no bundler-independent way to read `package.json` itself, and a JSON import
 * would need `resolveJsonModule` turned on repo-wide for one page. The literal
 * fallback below is ONLY for a consumer that isn't Vite (there is none today); it
 * is not read on an ordinary build or dev server.
 */
declare const __THIRD_PARTY_VERSIONS__:
  | {
      rapier2d: string;
      rapier3d: string;
      three: string;
      occt: string;
      react: string;
      plusJakartaSans: string;
      spaceGrotesk: string;
    }
  | undefined;
const PKG_VERSIONS =
  typeof __THIRD_PARTY_VERSIONS__ !== 'undefined'
    ? __THIRD_PARTY_VERSIONS__
    : {
        rapier2d: '0.19.3',
        rapier3d: '0.20.0',
        three: '0.186.0',
        occt: '0.0.23',
        react: '18.3.1',
        plusJakartaSans: '5.2.8',
        spaceGrotesk: '5.2.10',
      };

/**
 * THIRD-PARTY CREDITS the app ships or fetches — code, fonts, downloaded assets and
 * FIRST's own field CAD, on the same page, in their own section, never in "Built by"
 * (crediting a library or a standards body there would credit them for driver-practice
 * work they did not do).
 */
export interface ThirdPartyAsset {
  /** the credited thing's own name. */
  name: string;
  /** the installed version, from `package.json` — absent for a credit that isn't an
   * npm package (a downloaded HDRI, or the FIRST field CAD note). */
  version?: string;
  /** who made it, and at what — photography and processing are often different
   * people, and a library's listed author and its wider contributor base are too. */
  credits: readonly { name: string; role: string }[];
  license: string;
  licenseUrl: string;
  /** the credited thing's own page, for anyone who wants the original. */
  page: string;
  /** where it is used in DSIM, in one clause. */
  use: string;
  /** where it is distributed from — a package registry, an asset library, or a
   * standards body — not necessarily a "library" in the code sense. */
  source: string;
}

const OFL = 'https://openfontlicense.org';
const APACHE_2 = 'https://opensource.org/licenses/Apache-2.0';
const MIT = 'https://opensource.org/license/mit';

/**
 * The two physics engines DSIM runs on, Apache-2.0 from Dimforge. Rapier 2D is
 * authoritative for every match; the deterministic Rapier 3D build is BIOBUZZ's 3D
 * physics (`docs/biobuzz/plan-3d.md`).
 */
const RAPIER_CREDITS: ThirdPartyAsset[] = [
  {
    name: 'Rapier 2D',
    version: PKG_VERSIONS.rapier2d,
    credits: [{ name: 'Dimforge', role: 'Author' }],
    license: 'Apache-2.0',
    licenseUrl: APACHE_2,
    page: 'https://github.com/dimforge/rapier.js',
    use: 'Authoritative physics for every match',
    source: 'npm',
  },
  {
    name: 'Rapier 3D (deterministic)',
    version: PKG_VERSIONS.rapier3d,
    credits: [{ name: 'Dimforge', role: 'Author' }],
    license: 'Apache-2.0',
    licenseUrl: APACHE_2,
    page: 'https://github.com/dimforge/rapier',
    use: 'BIOBUZZ 3D physics',
    source: 'npm',
  },
];

/** Rendering, STEP reading and UI. */
const CODE_CREDITS: ThirdPartyAsset[] = [
  {
    name: 'Three.js',
    version: PKG_VERSIONS.three,
    credits: [{ name: 'mrdoob and the three.js authors', role: 'Author' }],
    license: 'MIT',
    licenseUrl: MIT,
    page: 'https://github.com/mrdoob/three.js',
    use: 'BIOBUZZ 3D rendering',
    source: 'npm',
  },
  {
    // LGPL-2.1, so it ships as its own separately loaded module (a worker and a wasm file,
    // fetched only when a STEP file is imported), which is what the licence asks of a library
    // linked into a larger work. OpenCascade is LGPL-2.1 with its own linking exception.
    name: 'occt-import-js (OpenCascade)',
    version: PKG_VERSIONS.occt,
    credits: [
      { name: 'Viktor Kovacs', role: 'Author' },
      { name: 'Open Cascade SAS', role: 'OpenCascade' },
    ],
    license: 'LGPL-2.1',
    licenseUrl: 'https://opensource.org/license/lgpl-2-1',
    page: 'https://github.com/kovacsv/occt-import-js',
    use: 'Reading STEP files when you import a robot',
    source: 'npm',
  },
  {
    name: 'React',
    version: PKG_VERSIONS.react,
    credits: [{ name: 'Meta Platforms, Inc. and contributors', role: 'Author' }],
    license: 'MIT',
    licenseUrl: MIT,
    page: 'https://github.com/facebook/react',
    use: "The app's UI",
    source: 'npm',
  },
];

/** The two variable typefaces (`--ds-font-ui` / `--ds-font-mono`), both OFL-1.1 and
 * both loaded from Fontsource in `src/main.tsx`. */
const FONT_CREDITS: ThirdPartyAsset[] = [
  {
    name: 'Plus Jakarta Sans',
    version: PKG_VERSIONS.plusJakartaSans,
    credits: [{ name: 'Tokotype', role: 'Type design' }],
    license: 'OFL-1.1',
    licenseUrl: OFL,
    page: 'https://fontsource.org/fonts/plus-jakarta-sans',
    use: 'UI typeface (--ds-font-ui)',
    source: 'Fontsource',
  },
  {
    name: 'Space Grotesk',
    version: PKG_VERSIONS.spaceGrotesk,
    credits: [{ name: 'Florian Karsten', role: 'Type design' }],
    license: 'OFL-1.1',
    licenseUrl: OFL,
    page: 'https://fontsource.org/fonts/space-grotesk',
    use: 'Mono/HUD typeface (--ds-font-mono)',
    source: 'Fontsource',
  },
];

/**
 * The BIOBUZZ field CAD (`public/models/biobuzz/README.md`). This is NOT a licence —
 * FIRST's terms grant the content for personal, non-commercial use and forbid
 * redistribution without permission, and whether a decimated derived mesh served
 * from this site is covered is unresolved (the owner decided 2026-09-17 to ship it
 * anyway; see `docs/biobuzz/plan-3d.md` §8). The row states that plainly rather than
 * dressing it up as a licence grant.
 */
const FIELD_CAD_CREDIT: ThirdPartyAsset = {
  name: 'BIOBUZZ field CAD',
  credits: [
    { name: 'FIRST (For Inspiration and Recognition of Science and Technology)', role: 'Field design' },
  ],
  license: 'FIRST website terms of use',
  licenseUrl: 'https://www.firstinspires.org/website-terms-of-use',
  page: 'https://ftc-resources.firstinspires.org/ftc/archive/2027/field/field-cad-step',
  use: 'Derived 3D field mesh and dimensions',
  source: 'FIRST',
};

/**
 * ── WHY THE HDRI PART IS DERIVED AND NOT TYPED OUT ─────────────────────────────────────────
 * These entries are built from `BB_ENVIRONMENTS` (`src/games/biobuzz/graphics/environments.ts`),
 * which is the list the Graphics section's environment picker renders from. So adding a third
 * HDRI credits it by CONSTRUCTION: there is no second list to remember to update, and the
 * failure this prevents — a shipped asset with no credit on the credits page — is the kind
 * nobody notices until somebody outside the project does.
 *
 * Poly Haven's assets are CC0, which requires no attribution at all. It is given anyway, with
 * the author roles the API reports, because "we did not have to" is not a reason not to.
 */
const HDRI_CREDITS: ThirdPartyAsset[] = hdriEnvironments().map((e) => ({
  name: e.name,
  credits: e.hdri!.authors,
  license: e.hdri!.license,
  licenseUrl: e.hdri!.licenseUrl,
  page: e.hdri!.page,
  use: 'BIOBUZZ 3D environment lighting',
  source: 'Poly Haven',
}));

export const THIRD_PARTY: ThirdPartyAsset[] = [
  ...RAPIER_CREDITS,
  ...CODE_CREDITS,
  ...FONT_CREDITS,
  ...HDRI_CREDITS,
  FIELD_CAD_CREDIT,
];
