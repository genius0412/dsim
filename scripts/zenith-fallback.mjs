/**
 * BUILDING WITHOUT ZENITH (docs/area/autos.md): which `@horizon36596/zenith-*` packages resolve,
 * where each falls back to, and whether this build may fall back at all. Zero dependencies.
 *
 * The packages are OPTIONAL dependencies installed from `vendor/zenith/*.tgz`, which are never
 * committed, so `npm ci` on a clone without them installs everything else and skips these. Each
 * resolver then falls back to `src/auto/zenith-stub/`:
 *   - `tsc` and `tsx`: `paths` in `tsconfig.json` / `tsconfig.server.json`, real package first;
 *   - Vite (the client, its workers and the dev server): `zenithFallbackPlugin` below.
 * With the packages installed, none of that changes what resolves.
 *
 * ⚠️ A DEPLOY NEVER FALLS BACK. `zenithRequired()` is true under Vercel and wherever
 * `ZENITH_REQUIRED=1` is set (`scripts/fly-deploy.sh`), and `vite.config.ts` then refuses to
 * build without the real packages. The Fly image checks the same after its `npm ci` (Dockerfile).
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** each package and the stand-in it falls back to, relative to the repository root */
export const ZENITH_STUBS = {
  '@horizon36596/zenith-core': 'src/auto/zenith-stub/core.ts',
  '@horizon36596/zenith-schema': 'src/auto/zenith-stub/schema.ts',
  '@horizon36596/zenith-season-biobuzz': 'src/auto/zenith-stub/season-biobuzz.ts',
};
/** subpaths DSIM imports, with their stand-ins */
const ZENITH_SUBPATH_STUBS = {
  '@horizon36596/zenith-season-biobuzz/field/': 'src/auto/zenith-stub/field/',
};

/** the Zenith specifiers that do not resolve from `root` (empty when Zenith is installed) */
export function zenithMissing(root = process.cwd()) {
  const require = createRequire(join(resolve(root), 'package.json'));
  const probes = [...Object.keys(ZENITH_STUBS), '@horizon36596/zenith-season-biobuzz/field/biobuzz.field.json'];
  return probes.filter((spec) => {
    try {
      require.resolve(spec);
      return false;
    } catch {
      return true;
    }
  });
}

/** the stand-in file for `specifier`, absolute, or null for anything that is not Zenith */
export function zenithStubFor(specifier, root = process.cwd()) {
  const whole = ZENITH_STUBS[specifier];
  if (whole) return resolve(root, whole);
  for (const [prefix, dir] of Object.entries(ZENITH_SUBPATH_STUBS)) {
    if (specifier.startsWith(prefix)) return resolve(root, dir, specifier.slice(prefix.length));
  }
  return null;
}

/** the vendored tarballs present in `vendor/zenith/` (a box that is meant to have Zenith) */
export function zenithTarballs(root = process.cwd()) {
  const dir = resolve(root, 'vendor/zenith');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.tgz')) : [];
}

/** may this build NOT have Zenith? Never on Vercel or with ZENITH_REQUIRED=1; ZENITH_REQUIRED=0 overrides. */
export function zenithRequired(env = process.env) {
  if (env.ZENITH_REQUIRED === '0') return false;
  return env.ZENITH_REQUIRED === '1' || !!env.VERCEL;
}

/**
 * The Vite plugin: with every package resolving it does nothing, so Vite resolves them as it
 * always has. Otherwise each Zenith import resolves to its stand-in. `vite.config.ts` decides
 * once, at startup, from `zenithMissing()`, and bakes the same answer in as `__DSIM_ZENITH__`.
 */
export function zenithFallbackPlugin({ root = process.cwd(), missing }) {
  return {
    name: 'zenith-fallback',
    enforce: 'pre',
    resolveId(source) {
      if (missing.length === 0 || !source.startsWith('@horizon36596/zenith-')) return null;
      const stub = zenithStubFor(source, root);
      if (!stub || !existsSync(stub)) {
        throw new Error(`zenith-fallback: ${source} is not installed and has no stand-in in src/auto/zenith-stub/; add one (docs/area/autos.md)`);
      }
      return stub;
    },
  };
}
