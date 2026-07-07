/**
 * Desktop-build download config, read from Vite env (baked in at build time).
 *
 * The Electron desktop shell is produced with `npm run dist` (electron-builder,
 * Windows nsis installer + portable exe → `release/`). Host those artifacts
 * anywhere (GitHub Releases, a CDN, Vercel static) and point these envs at them;
 * the Download page links to whatever is configured and otherwise explains how
 * to build it yourself. No URL configured ⇒ the page still renders with the
 * build-it-yourself instructions.
 */

const INSTALLER = import.meta.env.VITE_DOWNLOAD_INSTALLER_URL as string | undefined;
const PORTABLE = import.meta.env.VITE_DOWNLOAD_PORTABLE_URL as string | undefined;
/** optional "all releases" page (e.g. a GitHub releases URL) */
const RELEASES = import.meta.env.VITE_DOWNLOAD_RELEASES_URL as string | undefined;
/** optional human-readable version label shown on the page */
const VERSION = import.meta.env.VITE_APP_VERSION as string | undefined;

export interface DesktopBuild {
  /** platform + format label, e.g. "Windows · Installer" */
  label: string;
  /** short note (size / kind) */
  note: string;
  /** download URL, or null when not configured */
  url: string | null;
}

export const DESKTOP_BUILDS: DesktopBuild[] = [
  { label: 'Windows · Installer', note: '.exe · one-click NSIS setup', url: INSTALLER ?? null },
  { label: 'Windows · Portable', note: '.exe · no install, run anywhere', url: PORTABLE ?? null },
];

export const releasesUrl = (): string | null => RELEASES ?? null;
export const appVersion = (): string | null => VERSION ?? null;
/** any download actually configured? */
export const hasDesktopBuilds = (): boolean =>
  DESKTOP_BUILDS.some((b) => b.url) || !!RELEASES;
