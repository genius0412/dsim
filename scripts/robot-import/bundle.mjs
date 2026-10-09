/**
 * `npm run bundleaudit:importer` — the bundle audit with the robot importer REACHABLE.
 *
 * Until the import editor lands, nothing in the app imports `src/robotImport/engineLoader.ts`, so
 * a production build tree-shakes the engine away and `bundleaudit` reports the `importer` and
 * `step` routes absent (which it allows). This builds the app once more with the loader as a
 * second entry, into a temp dir, so the two routes — and the shared three.js chunk the scene
 * then gets — are measured against their baselines. The main chunk is unchanged by the extra
 * entry: the loader imports nothing statically.
 *
 * Needs nothing but the repo's own Vite. Never writes to `dist/`.
 */
import { build } from 'vite';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const out = join(tmpdir(), 'dsim-importer-bundle');
await build({
  logLevel: 'warn',
  build: {
    outDir: out,
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve('index.html'), engineLoader: resolve('src/robotImport/engineLoader.ts') },
      // an app build drops an entry's exports, and with them the loader's dynamic import
      preserveEntrySignatures: 'exports-only',
    },
  },
});
const r = spawnSync(process.execPath, [resolve('scripts/bundleaudit.mjs')], { stdio: 'inherit', env: { ...process.env, BUNDLE_DIST: out } });
process.exit(r.status ?? 1);
