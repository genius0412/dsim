import { creditedEnvironments, environmentCredit } from './games/biobuzz/graphics/environments';

/**
 * The Contributors page's roster: the team, the people whose work is in the GitHub repo, and
 * the beta testers.
 *
 * HAND-MAINTAINED, deliberately. Who counts as a contributor is a judgement about the repo
 * (merged work on GitHub, which `CONTRIBUTORS.md` records alongside the CLA), not something the
 * account system knows. What the account system DOES know is each person's live name and
 * badges, so a card keyed by `userId` reads those at render time (`fetchProfile`).
 *
 * KEYED BY ACCOUNT ID, NOT USERNAME. The id is the Neon Auth `sub`, the same on alpha and
 * production; a @username is per deployment and changes (Aadvik is @aadvikg on one and
 * @aadvikgupta on the other). Every field except `name` is optional, and a card degrades
 * cleanly without each one — which matters because the page must also work when the game
 * server is unreachable, where no live profile resolves for anyone.
 *
 * The TEAM BADGES are not read from here: they follow the admin console's access groups
 * (`TEAM_BADGES`, `src/badges.ts`). This list is the credits; the groups are who wears what.
 */
export interface Contributor {
  /** the name the credit is in — a real name for the team and GitHub contributors */
  name: string;
  /** the account (`profiles.user_id`). Drives the live @username, the profile link and the
   * badges beside the name. Omit for someone with no game account. */
  userId?: string;
  /** a short credit line: the role for the team, what they built for contributors */
  role?: string;
  /** GitHub login. Links the profile, and names the avatar vendored at
   * `public/contributors/<login>.webp` (`scripts/contributor-avatars.py`). */
  github?: string;
  /** Discord profile link (`https://discord.com/users/<id>`). */
  discordUrl?: string;
}

/** THE TEAM — the owner and the admins (`ADMIN_USER_IDS`), who build and run DSIM. */
export const DEVELOPERS: Contributor[] = [
  { name: 'Dohun Kim', role: 'Owner', userId: '0c9c1654-c720-40f5-9352-1b0cde1c465a', github: 'genius0412' },
  { name: 'Felix D', role: 'Admin', userId: 'e3d73282-ac91-4940-bd5c-4778ca34212c', github: 'crescent' },
  { name: 'Saket T', role: 'Admin', userId: '5baefc21-e1e8-43b0-9278-4af2ea150882', github: 'featurescript' },
];

/**
 * CONTRIBUTORS — everyone else with merged work in github.com/genius0412/dsim, in the order
 * GitHub's contributor graph lists them (Shaan's commits carry an email GitHub does not link,
 * so they are not on the graph, and come last). A closed, unmerged pull request is not here.
 */
export const CONTRIBUTORS: Contributor[] = [
  { name: 'Baron', role: 'Autonomous in multiplayer', userId: 'a509c53d-dc89-4dae-99de-2c6e30e537d9', github: 'BaronClaps' },
  {
    name: 'therealkingcob',
    role: 'Tank drive, gate penalties, touch controls',
    userId: 'b696301c-8056-4fec-b4d9-16fccbba12d9',
    github: 'therealkingcob',
  },
  {
    name: 'Arush Yadlapati',
    role: 'Discord Activity, gamepad combos',
    userId: 'a232300a-5a1a-4e5d-ae26-d0631f9b33d8',
    github: 'ArushYadlapati',
  },
  { name: 'Aadvik Gupta', role: 'Robot builder and profile fixes', userId: '8df89c67-7ebb-4275-aa9a-9a75312c1a1b', github: 'aadvikgg' },
  { name: 'Shaan Sridhara', role: 'Park mode, gamepad tuning', github: 'ShaanSridhara' },
];

/** BETA TESTERS — the players who try new builds on alpha before they ship. */
export const BETA_TESTERS: Contributor[] = [
  { name: 'Leo', userId: 'ea913af1-d8ab-455c-a274-7f2132b2f5ad' },
  { name: 'Aadvik Gupta', userId: '8df89c67-7ebb-4275-aa9a-9a75312c1a1b', github: 'aadvikgg' },
  { name: 'Daniel', userId: '0bb4ce4d-b046-47a7-a040-91315c7f3a28' },
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
 * which is the list the Graphics section's environment picker renders from. So adding an HDRI or a
 * photographed venue credits it by CONSTRUCTION: there is no second list to remember to update, and the
 * failure this prevents — a shipped asset with no credit on the credits page — is the kind
 * nobody notices until somebody outside the project does.
 *
 * Poly Haven's assets are CC0, which requires no attribution at all. It is given anyway, with
 * the author roles the API reports, because "we did not have to" is not a reason not to.
 */
const HDRI_CREDITS: ThirdPartyAsset[] = creditedEnvironments().map((e) => {
  // a fetched HDRI or a photographed venue derived from one (`environmentCredit`)
  const c = environmentCredit(e)!;
  return { name: e.name, credits: c.authors, license: c.license, licenseUrl: c.licenseUrl, page: c.page, use: c.use, source: 'Poly Haven' };
});

export const THIRD_PARTY: ThirdPartyAsset[] = [
  ...RAPIER_CREDITS,
  ...CODE_CREDITS,
  ...FONT_CREDITS,
  ...HDRI_CREDITS,
  FIELD_CAD_CREDIT,
];
