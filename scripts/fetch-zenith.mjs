#!/usr/bin/env node
/**
 * FETCH THE VENDORED ZENITH TARBALLS before `npm install` / `npm ci`, for a build that has no
 * Zenith checkout to run `scripts/vendor-zenith.mjs` against (the Vercel alpha build).
 *
 * `@horizon36596/zenith-*` are `file:vendor/zenith/*.tgz` dependencies, and the tarballs are never
 * committed here (this repository is public and a packed package is compiled source). So this
 * downloads each one from a private GitHub repository's branch through the contents API, checks it
 * against the sha512 integrity package-lock.json already pins, and only then writes it where npm
 * expects it. A tarball that does not match is refused, never installed.
 *
 *   ZENITH_VENDOR_REPO=<owner>/<repo>   the repository that holds vendor/zenith/*.tgz
 *   ZENITH_VENDOR_REF=<branch|sha>      default: dsim-vendor
 *   ZENITH_VENDOR_TOKEN=<token>         read-only (Contents: read) on that repository
 *
 *   node scripts/fetch-zenith.mjs
 *
 * A NO-OP, exit 0, when there is nothing to do: no `file:` Zenith dependency in package.json (the
 * packages came from npm), or every tarball is already present with the pinned hash (a dev box that
 * ran vendor-zenith.mjs). Otherwise it needs all three variables, and says which is missing.
 * Never prints the token.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));

/** `[name, relative tarball path]` for every Zenith dependency installed from a vendored file. */
const vendored = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
  .filter(([name, spec]) => name.startsWith('@horizon36596/zenith-') && spec.startsWith('file:'))
  .map(([name, spec]) => [name, spec.slice('file:'.length)]);

if (vendored.length === 0) {
  console.log('fetch-zenith: no vendored Zenith dependency, nothing to fetch');
  process.exit(0);
}

const sri = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

/** The sha512 package-lock.json pins for `name`. A tarball with no pinned hash is never fetched. */
function pinnedIntegrity(name) {
  const integrity = lock.packages?.[`node_modules/${name}`]?.integrity;
  if (!integrity?.startsWith('sha512-')) {
    console.error(`fetch-zenith: package-lock.json pins no sha512 for ${name}; run scripts/vendor-zenith.mjs and commit the lockfile`);
    process.exit(1);
  }
  return integrity;
}

const missing = vendored.filter(([name, path]) => !existsSync(path) || sri(readFileSync(path)) !== pinnedIntegrity(name));
if (missing.length === 0) {
  console.log(`fetch-zenith: all ${vendored.length} Zenith tarballs present and matching the lockfile`);
  process.exit(0);
}

const repo = process.env.ZENITH_VENDOR_REPO;
const ref = process.env.ZENITH_VENDOR_REF || 'dsim-vendor';
const token = process.env.ZENITH_VENDOR_TOKEN;
const unset = [!repo && 'ZENITH_VENDOR_REPO', !token && 'ZENITH_VENDOR_TOKEN'].filter(Boolean);
if (unset.length > 0) {
  console.error(
    `fetch-zenith: ${missing.map(([, p]) => p).join(', ')} missing and ${unset.join(' and ')} unset.\n` +
      '  Set them in the build environment (docs/area/autos.md, Vendoring), or run\n' +
      '  node scripts/vendor-zenith.mjs <zenith checkout> on a dev box.',
  );
  process.exit(1);
}
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('fetch-zenith: ZENITH_VENDOR_REPO must look like owner/repo');
  process.exit(1);
}

for (const [name, path] of missing) {
  const url = `https://api.github.com/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
  let response;
  for (let attempt = 1; ; attempt += 1) {
    try {
      response = await fetch(url, {
        headers: {
          accept: 'application/vnd.github.raw',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'dsim-fetch-zenith',
        },
      });
      if (response.status < 500 || attempt === 4) break;
    } catch (error) {
      if (attempt === 4) throw error;
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
  }
  if (!response.ok) {
    // 404 is also what GitHub answers a token that cannot see a private repository
    console.error(`fetch-zenith: ${path} @ ${ref}: HTTP ${response.status}${response.status === 404 ? ' (wrong repo/ref/path, or the token cannot read the repository)' : ''}`);
    process.exit(1);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const got = sri(bytes);
  const want = pinnedIntegrity(name);
  if (got !== want) {
    console.error(`fetch-zenith: ${path} @ ${ref} does not match package-lock.json (got ${got.slice(0, 20)}…, want ${want.slice(0, 20)}…); refusing it`);
    process.exit(1);
  }
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, bytes);
  console.log(`fetch-zenith: ${path} (${bytes.length} bytes, integrity ok)`);
}
