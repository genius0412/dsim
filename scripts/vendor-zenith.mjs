#!/usr/bin/env node
/**
 * RE-VENDOR THE ZENITH PACKAGES from a Zenith checkout (default `../zenith`).
 *
 * `@horizon36596/zenith-{schema,core,season-biobuzz}` are not on npm yet, so DSIM depends on
 * packed tarballs under `vendor/zenith/` (`file:` specs in package.json). This builds the
 * three packages in the checkout, packs them over the old tarballs and writes
 * `vendor/zenith/SOURCE.md` with the commit they came from, so a diff of the tarballs always
 * names its source, then reinstalls them so the lockfile's integrity hashes match.
 *
 *   node scripts/vendor-zenith.mjs [path/to/zenith]
 *
 * ⚠️ THE TARBALLS ARE NEVER COMMITTED (`.gitignore`): this repository is public and Zenith is not
 * yet, and a packed package is its compiled source. So a fresh clone of this branch runs this
 * script against a Zenith checkout before `npm ci`. The day the packages publish, the `file:`
 * specs become version ranges and this script goes.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const zenith = resolve(process.argv[2] ?? '../zenith');
const out = resolve('vendor/zenith');
if (!existsSync(resolve(zenith, 'packages/core/package.json'))) {
  console.error(`vendor-zenith: ${zenith} is not a Zenith checkout`);
  process.exit(1);
}
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

const sha = run('git', ['rev-parse', 'HEAD'], zenith);
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], zenith);
const dirty = run('git', ['status', '--porcelain', '--', 'packages/schema', 'packages/core', 'packages/season-biobuzz'], zenith);
if (dirty) {
  console.error('vendor-zenith: the three packages have uncommitted changes; commit them first so the tarballs name a real commit');
  process.exit(1);
}
run('npx', ['tsc', '-b', 'packages/schema', 'packages/core', 'packages/season-biobuzz'], zenith);
// the tarball names carry the version, which Zenith's release moves (0.1.0 -> 0.1.1 ...)
const version = JSON.parse(readFileSync(resolve(zenith, 'packages/core/package.json'), 'utf8')).version;
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.endsWith('.tgz')) rmSync(resolve(out, f));
for (const pkg of ['schema', 'core', 'season-biobuzz']) {
  run('pnpm', ['pack', '--pack-destination', out], resolve(zenith, 'packages', pkg));
}
writeFileSync(
  resolve(out, 'SOURCE.md'),
  `# Vendored Zenith packages

Packed by \`scripts/vendor-zenith.mjs\` from a Zenith checkout @ \`${sha}\` (branch \`${branch}\`, version ${version}).
Do not edit the tarballs by hand; re-run the script against a Zenith checkout.
`,
);
// `npm install` alone reports "up to date" for a changed `file:` tarball and keeps the OLD
// integrity hash in package-lock.json, which `npm ci` (the Fly image) then refuses. Installing the
// tarballs by path re-hashes them.
run('npm', ['install', '--no-audit', '--no-fund', ...['schema', 'core', 'season-biobuzz'].map((p) => `./vendor/zenith/horizon36596-zenith-${p}-${version}.tgz`)], process.cwd());
console.log(`vendor-zenith: packed schema, core and season-biobuzz ${version} from ${sha.slice(0, 7)} (${branch}), lockfile refreshed`);
