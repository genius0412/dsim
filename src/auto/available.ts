/**
 * IS ZENITH IN THIS BUILD? (docs/area/autos.md, "Building without Zenith"). MAIN CHUNK: it imports
 * nothing, so a screen can ask before it reaches for the lazy `autos` chunk.
 *
 * The three `@horizon36596/zenith-*` packages are optional dependencies installed from vendored
 * tarballs that are never committed (the repository is public, Zenith is not). A clone without
 * them still installs, builds and tests: every resolver falls back to `src/auto/zenith-stub/`,
 * whose functions throw. This flag is how the app knows which one it got.
 *
 *  - THE CLIENT: `__DSIM_ZENITH__`, baked in by `vite.config.ts` from whether the real packages
 *    resolve (`scripts/zenith-fallback.mjs`), the same technique as `__BUILD_ID__`.
 *  - NODE (tsx, the server): where `@horizon36596/zenith-core` resolves. Under tsx a missing
 *    package resolves to the stub through `tsconfig.json`'s `paths`; only that reads false. It
 *    fails OPEN: anything that cannot be checked reads true, so the production server, which
 *    always has the packages, can never turn autos off by mistake.
 */
declare const __DSIM_ZENITH__: boolean;

/** the one sentence a screen shows where autonomous would be */
export const AUTOS_UNAVAILABLE = 'Autonomous isn’t included in this build.';

function resolvesToStub(): boolean {
  try {
    const meta = import.meta as ImportMeta & { resolve?: (specifier: string) => string };
    if (typeof meta.resolve !== 'function') return false;
    return /[\\/]zenith-stub[\\/]/.test(decodeURIComponent(meta.resolve('@horizon36596/zenith-core')));
  } catch {
    return false;
  }
}

export const ZENITH_AVAILABLE: boolean = typeof __DSIM_ZENITH__ === 'boolean' ? __DSIM_ZENITH__ : !resolvesToStub();

/**
 * MAY THIS BUILD SAY THE WORD "AUTONOMOUS" TO A PLAYER? One decision, in one place: every screen that
 * names autos (the Match setup section and its sentence, the room's AUTO chip, the privacy page's
 * inventory row) asks this and draws nothing when it is false. A production build (channel not
 * `alpha`) without autos must not name an unreleased feature; an alpha build whose packages are
 * missing still tells its developer why the panel is absent (`AUTOS_UNAVAILABLE`). The day autos
 * ship to production, `available` is true there and this is the only line that changes.
 * `channel` is `VITE_APP_CHANNEL` read as `appChannel()` reads it (trimmed, default `stable`); not
 * imported from `net/env` so this file stays a leaf the server can load.
 */
export function autosMentionedOn(channel: string, available: boolean): boolean {
  return available || channel.trim() === 'alpha';
}

const buildChannel = (): string => {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return env?.VITE_APP_CHANNEL?.trim() || 'stable';
};

/** `autosMentionedOn` for THIS build */
export const autosMentioned = (): boolean => autosMentionedOn(buildChannel(), ZENITH_AVAILABLE);
