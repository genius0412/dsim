import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZENITH_AVAILABLE } from '../../src/auto/available';
import { ZENITH_STUBS, zenithRequired, zenithTarballs } from '../zenith-fallback.mjs';
import type { Check } from './harness';

/**
 * THE ZENITH LANE, and the suite's one rule for a clone WITHOUT Zenith (docs/area/autos.md,
 * "Building without Zenith").
 *
 * The `@horizon36596/zenith-*` packages are optional dependencies from vendored tarballs that are
 * never committed, so an outside contributor's clone has none, and every Zenith import resolves
 * to `src/auto/zenith-stub/`. The lanes that need Zenith itself (AUTO, AUTOUI, and one IMPORT check)
 * then SKIP, with one line saying so. Everything else runs exactly as it does with Zenith.
 *
 * ⚠️ A SKIP IS IMPOSSIBLE WHERE ZENITH IS MEANT TO BE: `WITHOUT_ZENITH` needs BOTH no real package
 * resolving AND no tarball in `vendor/zenith/`. A box with the tarballs whose install skipped them
 * (npm skips a mismatched optional tarball with only a warning) runs those lanes against the
 * stand-ins, which throw, and this lane's first check names why.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** true only on a clone without Zenith: nothing real resolves and nothing is vendored */
export const WITHOUT_ZENITH = !ZENITH_AVAILABLE && zenithTarballs(root).length === 0;

const SKIP_PREFIX = 'SKIPPED (Zenith not installed): ';
const skipped: string[] = [];
/** note something the suite did not run because this clone has no Zenith */
export function skippedWithoutZenith(what: string): void {
  skipped.push(what);
}
/** the one line the suite prints for everything it skipped, or null (`bbshard.mjs` merges them) */
export function zenithSkipLine(): string | null {
  return skipped.length > 0 ? `${SKIP_PREFIX}${skipped.join(', ')}` : null;
}

/** what each Zenith import resolves to under this runner (tsx applies `tsconfig.json`'s `paths`) */
const PROBES = [...Object.keys(ZENITH_STUBS), '@horizon36596/zenith-season-biobuzz/field/biobuzz.field.json'];

/** every `.ts`/`.tsx` under `dir`, repository-relative */
function sources(dir: string): string[] {
  return (readdirSync(join(root, dir), { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && !/node_modules/.test(f))
    .map((f) => join(dir, f).replace(/\\/g, '/'));
}

export function zenithChecks(check: Check): void {
  const resolved = PROBES.map((spec) => {
    try {
      return decodeURIComponent(import.meta.resolve(spec));
    } catch (e) {
      return `unresolved (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`;
    }
  });
  const stand = resolved.map((u) => /[\\/]zenith-stub[\\/]/.test(u));
  const real = resolved.map((u) => /[\\/]node_modules[\\/]@horizon36596[\\/]zenith-/.test(u));
  const tarballs = zenithTarballs(root);
  const allReal = real.every(Boolean);
  const allStand = stand.every(Boolean);
  check(
    'ZENITH: the stand-ins resolve only where no tarball is vendored, all four imports resolve to the same side, and ZENITH_AVAILABLE says which',
    (tarballs.length > 0 ? allReal : allReal || allStand) && ZENITH_AVAILABLE === allReal,
    `${tarballs.length} tarball(s) in vendor/zenith; ZENITH_AVAILABLE ${ZENITH_AVAILABLE}; ` +
      resolved.map((u, i) => `${PROBES[i].replace('@horizon36596/', '')} → ${real[i] ? 'real' : stand[i] ? 'stand-in' : u}`).join(' · '),
  );

  // ---- every name DSIM imports has a stand-in -------------------------------------------------
  // Without one, a clone without Zenith fails `tsc` and tsx refuses the import outright, and the
  // owner's box (which has Zenith) would never see it: so it is read off the source here.
  const files = [...sources('src'), ...sources('scripts')].filter((f) => !f.startsWith('src/auto/zenith-stub/'));
  const wanted = new Map<string, Set<string>>();
  const want = (pkg: string, name: string, file: string): void => {
    const key = `${pkg} ${name}`;
    if (!wanted.has(key)) wanted.set(key, new Set());
    wanted.get(key)!.add(file);
  };
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'(@horizon36596\/zenith-[a-z-]+)'/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (name) want(m[2], name, f);
      }
    }
    for (const m of text.matchAll(/import\('(@horizon36596\/zenith-[a-z-]+)'\)\.([A-Za-z_]\w*)/g)) want(m[1], m[2], f);
  }
  const stubText = new Map(Object.entries(ZENITH_STUBS).map(([pkg, file]) => [pkg, readFileSync(join(root, file), 'utf8')]));
  const missing = [...wanted.keys()].filter((key) => {
    const [pkg, name] = key.split(' ');
    const stub = stubText.get(pkg);
    return !stub || !new RegExp(`export\\s+(?:declare\\s+)?(?:function|const|let|type|interface|class)\\s+${name}\\b`).test(stub);
  });
  check(
    'ZENITH: every name DSIM imports from @horizon36596/zenith-* has a stand-in in src/auto/zenith-stub/, so a clone without Zenith still type-checks and runs',
    wanted.size > 20 && missing.length === 0,
    missing.length > 0
      ? missing.map((k) => `${k} (${[...wanted.get(k)!].join(', ')})`).join('; ')
      : `${wanted.size} names`,
  );

  // ---- a deploy never ships them --------------------------------------------------------------
  const vite = readFileSync(join(root, 'vite.config.ts'), 'utf8');
  const docker = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const fetcher = readFileSync(join(root, 'scripts/fetch-zenith.mjs'), 'utf8');
  check(
    'ZENITH: a deploy refuses the stand-ins: Vercel and ZENITH_REQUIRED=1 require Zenith (ZENITH_REQUIRED=0 and a plain clone do not), vite.config.ts throws on that, the Dockerfile checks after BOTH npm ci, fetch-zenith reads optionalDependencies',
    zenithRequired({ VERCEL: '1' }) &&
      zenithRequired({ ZENITH_REQUIRED: '1' }) &&
      !zenithRequired({ VERCEL: '1', ZENITH_REQUIRED: '0' }) &&
      !zenithRequired({}) &&
      !zenithRequired({ CI: 'true' }) &&
      /ZENITH_MISSING\.length > 0 && zenithRequired\(\)\) \{\s*throw new Error/.test(vite) &&
      /worker: \{[^}]*plugins: \(\) => \[zenithFallback\(\)\]/.test(vite) &&
      (docker.match(/RUN npm ci[^\n]*\n(?:#[^\n]*\n)*RUN node -e "[^"]*require\.resolve\('@horizon36596\/zenith-'/g) ?? []).length === 2 &&
      /\.\.\.pkg\.optionalDependencies/.test(fetcher),
  );
}
