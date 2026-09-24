#!/usr/bin/env node
/**
 * RE-VENDOR THE ZENITH PACKAGES from a Zenith checkout (default `../zenith`).
 *
 * `@horizon36596/zenith-{schema,core,season-biobuzz}` are not on npm yet, so DSIM depends on
 * packed tarballs under `vendor/zenith/` (`file:` specs in package.json). This builds the
 * three packages in the checkout, packs them over the old tarballs and writes
 * `vendor/zenith/SOURCE.md` with the commit they came from, so a diff of the tarballs always
 * names its source. Run `npm install` afterwards to refresh the lockfile's integrity hashes.
 *
 *   node scripts/vendor-zenith.mjs [path/to/zenith]
 *
 * The day the packages publish, the `file:` specs become version ranges and this script goes.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
mkdirSync(out, { recursive: true });
for (const pkg of ['schema', 'core', 'season-biobuzz']) {
  run('pnpm', ['pack', '--pack-destination', out], resolve(zenith, 'packages', pkg));
}
writeFileSync(
  resolve(out, 'SOURCE.md'),
  `# Vendored Zenith packages

Packed by \`scripts/vendor-zenith.mjs\` from \`Horizon-36596/zenith\` @ \`${sha}\` (branch \`${branch}\`).
Do not edit the tarballs by hand; re-run the script against a Zenith checkout.
`,
);
console.log(`vendor-zenith: packed schema, core and season-biobuzz from ${sha.slice(0, 7)} (${branch})`);
