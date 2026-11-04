/**
 * THE ZENITH STAND-INS' ONE ERROR (docs/area/autos.md, "Building without Zenith").
 *
 * `core.ts`, `schema.ts` and `season-biobuzz.ts` here are what `@horizon36596/zenith-*` resolve
 * to when the real packages are not installed (`tsconfig.json` `paths`, `vite.config.ts`'s
 * `zenith-fallback` plugin). They export the names DSIM imports and nothing works: every
 * function throws this. DSIM never gets that far, because `ZENITH_AVAILABLE` (`../available.ts`)
 * reads false and the screens and `loadZenithAuto` stop first; reaching one of these is a bug.
 *
 * ⚠️ NEVER SHIPPED: a deploy build that would resolve here fails instead (`ZENITH_REQUIRED`,
 * `scripts/zenith-fallback.mjs`), and the BIOBUZZ CORE lane fails when vendored tarballs are
 * present and these resolve anyway.
 */
export function zenithUnavailable(name: string): Error {
  return new Error(`${name} is a stand-in: the Zenith packages are not installed in this build (README, "Building without Zenith").`);
}
