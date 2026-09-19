/**
 * BUNDLE AUDIT — `npm run bundleaudit`. Zero dependencies, same ratchet shape as
 * `scripts/uiaudit.mjs` (see that file's header for why a ratchet rather than a hard cap).
 *
 * Needs a PRIOR `npm run build` — it reads `dist/assets/`, it does not produce it. Run
 *   npm run build && npm run bundleaudit
 * If `dist/assets` is missing this fails immediately with that instruction, rather than
 * silently reporting zero chunks as a clean bill.
 *
 * ── WHY THIS EXISTS (Day 1 seam, `docs/biobuzz/plan-3d.md` §2.5) ────────────────────────
 * BIOBUZZ's 3D physics (`@dimforge/rapier3d-deterministic-compat`, ~1.1 MB gzipped) and its
 * Three.js scene (budgeted ≤ 250 KB gzipped) are both reached only through a dynamic
 * `import()` — a 2D-view player who never steps a 3D world locally must never pay for
 * either chunk. That is a STATEMENT ABOUT THE BUNDLE GRAPH, and the only thing that can
 * check a statement about the bundle graph is something that reads the built bundle. A
 * regression here (a static import that drags the wasm into the main chunk, the way
 * `--ds-font` silently broke a `font:` shorthand for months) would not fail a single test —
 * every game still plays, every check still passes — it would just make the MAIN CHUNK,
 * the one every player of every game downloads, quietly grow by a megabyte.
 *
 * ── ROUTES, BY CONTENT NOT FILENAME ──────────────────────────────────────────────────────
 * Vite hashes every chunk's filename per build, so matching on a hash is a script that
 * breaks the day after it is written. Route by what a chunk actually contains instead:
 *   main       — the entry chunk (`index-*.js` at the top of `dist/assets`)
 *   hostWorker — the LAN host worker (`hostWorker-*.js`, its own Vite worker entry)
 *   physics3d  — a chunk (or wasm asset) whose bytes carry a rapier3d marker, OR one carrying a
 *                BIOBUZZ `sim3d/` marker: since the implementation moved behind
 *                `initPhysics3d()` (`sim3d/impl.ts`), the 3D physics arrives as THREE lazy
 *                chunks rather than one — the wasm glue (`rapier-*.js`), the client's
 *                implementation barrel (`impl-*.js`), and a shared chunk (`tilt-*.js`: the CAD
 *                collider set + `sim3d/tilt.ts`) that the SCENE and the implementation both
 *                import, so Rollup hoists it out of each. The LAN host worker code-splits the
 *                same way and gets its own `impl-*.js`. All of it is 3D physics the player pays
 *                for only on a 3D world, which is the one thing this route means; bucketing it
 *                as `other` would say the opposite.
 *   scene      — a chunk whose bytes carry a Three.js marker (`WebGLRenderer`). ⚠️ TESTED BEFORE
 *                the sim3d markers, not after: the scene legitimately reads the tray angle and
 *                the CAD geometry, so if a future chunking ever merges some of that INTO the
 *                renderer chunk, "it has three.js in it" is the answer that stays right.
 *   graphics   — the GRAPHICS SETTINGS UI and the Auto detector (Day 3, plan §4.4/§4.6):
 *                `GraphicsSection-*.js`, the shared `settings-*.js` it and the detector both
 *                read, and `auto-*.js` (`Reset to Auto`'s GPU probe). Lazy for the same reason
 *                the two above are: sixteen 3D graphics settings are of no use to somebody
 *                playing 2D DECODE, and `Configure.tsx` `React.lazy`s the section so they are
 *                not in the bundle that player downloads. ⚠️ TESTED AFTER `scene`, because the
 *                renderer chunk carries its own inlined copy of the settings model and
 *                "it has three.js in it" has to keep winning for that one.
 *   other      — everything else. In practice this is empty: `@dimforge/rapier2d-compat` is a
 *                STATIC import (`src/sim/physicsEngine.ts`), so the 2D physics engine lives
 *                inside `main` already and always has (that is existing, unchanged behavior,
 *                not something this audit needs to gate) — CSS/fonts/images are not `.js`/
 *                `.wasm` and are never read here at all.
 * A `.wasm` file's bytes are checked as a byte string (ASCII substrings survive a raw
 * buffer scan regardless of the surrounding binary), and its FILENAME is checked too —
 * wasm-pack/rapier's compat packages name their `.wasm` asset after the source module, so
 * the filename alone is already a strong (and cheap) signal before the content scan runs.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const DIST = 'dist';
const ASSETS = join(DIST, 'assets');

if (!existsSync(ASSETS)) {
  console.error(`bundleaudit: ${ASSETS} does not exist.`);
  console.error('Run `npm run build` first — this audit reads a build, it does not produce one.');
  process.exit(1);
}

/**
 * ASCII markers, matched as raw byte substrings so they survive being read out of a
 * minified/mangled JS chunk OR out of a compiled `.wasm` binary's own import/name strings.
 *
 * `rapier_wasm3d` is the deterministic compat build's own wasm-bindgen glue naming its
 * source files (`rapier_wasm3d_bg.wasm` / `.js` — found by inspecting a real built chunk,
 * `dist/assets/rapier-<hash>.js`, which Vite names after the package's own facade module and
 * NOT after "rapier3d" — so a filename match alone would miss it). `rapier3d`/`dimforge` are
 * kept as a fallback in case a future package version renames the wasm-bindgen output; they
 * did NOT fire against the build this was measured on.
 */
const MARKERS = {
  physics3d: ['rapier_wasm3d', 'rapier3d', 'RAPIER3D', 'dimforge'],
  scene: ['WebGLRenderer', 'THREE.Scene', 'three.module'],
  /**
   * BIOBUZZ's own 3D chunks, which carry no `rapier` string of their own — they IMPORT the wasm
   * facade rather than containing it. All three are object PROPERTY names, which esbuild does not
   * mangle, so they survive minification the way a string literal does:
   *   `containmentFixes` / `hiveTrays` — fields of `Engine3d` (`sim3d/engineImpl.ts`)
   *   `refTheta`                        — the tray's reference angle, in `sim3d/fieldColliders.ts`
   *                                       AND in the CAD JSON it reads (`fieldColliders.gen.ts`)
   * Measured against the build that introduced the split: present in all three sim3d chunks,
   * absent from `index-*`, `hostWorker-*` and `renderScene-*`.
   */
  sim3d: ['containmentFixes', 'hiveTrays', 'refTheta'],
  /**
   * The graphics-settings chunks. STRING LITERALS, not identifiers: these chunks are minified
   * and every name in them is mangled, but a string constant is not.
   *   `decodesim.graphics` — the localStorage key (`graphics/settings.ts`)
   *   `Reset to Auto`      — the button (`ui/GraphicsSection.tsx`)
   *   `swiftshader`        — the software-renderer pattern (`graphics/auto.ts`)
   * Measured against the build that introduced the split: one of the three is present in each
   * of the three chunks, and none of them is in `index-*` or `hostWorker-*`.
   */
  graphics: ['decodesim.graphics', 'Reset to Auto', 'swiftshader'],
};

/** does `buf` contain any of `needles`, scanned as raw bytes (works for text OR wasm)? */
function containsAny(buf, needles) {
  for (const needle of needles) {
    if (buf.includes(Buffer.from(needle, 'latin1'))) return true;
  }
  return false;
}

function routeFor(file, buf) {
  const base = file;
  if (/^index-[^/]*\.js$/.test(base)) return 'main';
  if (/^hostWorker-[^/]*\.js$/.test(base)) return 'hostWorker';
  // the Embedded App SDK, reached only through `src/net/discordSdk.ts` (a facade that
  // exists precisely so this chunk is NOT named `index-*` — the package's own entry is
  // index.js, and without the facade it was billed against main's baseline).
  if (/^discordSdk-[^/]*\.js$/.test(base)) return 'discord';
  // filename-first for a standalone `.wasm` asset (cheap, and a real one would be named after
  // its source module, e.g. `rapier_wasm3d_bg-<hash>.wasm`), then a content scan for both .js
  // and .wasm alike — content is what actually decided this in the measured build, where the
  // physics chunk landed as `rapier-<hash>.js` (Vite's own facade-module naming, not a
  // "rapier3d" filename at all).
  if (/rapier/i.test(base) && base.endsWith('.wasm')) return 'physics3d';
  if (containsAny(buf, MARKERS.physics3d)) return 'physics3d';
  // THREE.JS FIRST, then sim3d, then the graphics UI — see the route table's notes on both.
  if (containsAny(buf, MARKERS.scene)) return 'scene';
  if (containsAny(buf, MARKERS.sim3d)) return 'physics3d';
  if (containsAny(buf, MARKERS.graphics)) return 'graphics';
  return 'other';
}

const files = readdirSync(ASSETS).filter((f) => f.endsWith('.js') || f.endsWith('.wasm'));
if (files.length === 0) {
  console.error(`bundleaudit: no .js or .wasm files under ${ASSETS}. Run \`npm run build\` first.`);
  process.exit(1);
}

/** route -> [{file, raw, gzip}] */
const byRoute = new Map();
for (const f of files) {
  const p = join(ASSETS, f);
  const buf = readFileSync(p);
  const route = routeFor(f, buf);
  const raw = statSync(p).size;
  const gzip = gzipSync(buf, { level: 9 }).length;
  if (!byRoute.has(route)) byRoute.set(route, []);
  byRoute.get(route).push({ file: f, raw, gzip });
}

// DECIMAL kB (1000 bytes), matching Vite's own build-log units and every budget number in
// `docs/biobuzz/plan-3d.md` §2.5 ("main chunk 903 KB", "physics chunk about 1.1 MB",
// "renderer chunk at most 250 KB") — a binary KiB would silently disagree with every number
// this script is compared against by about 2.4%, which is most of a ratchet's tolerance.
const fmtKB = (bytes) => `${(bytes / 1000).toFixed(2)} KB`;

/**
 * BASELINE, gzip-9 bytes per route — a RATCHET like `uiaudit.mjs`'s: fails when a route's
 * TOTAL gzip exceeds baseline + max(2%, 4 KB), reports "lower the baseline" when it drops by
 * more than 5%.
 *
 * MEASURED on the build this Day 1 seam produces with Lane A's `sim3d/`, Lane B's `scene/`
 * and the wiring all present — `npm run build && npm run bundleaudit`.
 *
 * ── RE-MEASURED 2026-09-18, when `sim3d/` moved behind `initPhysics3d()` ────────────────────
 * Until then `src/games/biobuzz/step.ts` imported `step3d` STATICALLY and `scene/renderField.ts`
 * imported two helpers out of `hive3d.ts`/`bodies.ts`, so the whole 3D implementation was
 * reachable from the entry and sat in the MAIN chunk — every player of every game downloading
 * BIOBUZZ's 3D physics to play a 2D DECODE match, which is precisely the thing this file exists
 * to notice. `sim3d/impl.ts` is the lazy barrel now and `initPhysics3d()` is its only importer.
 *   main        907.88 KB — `dist/assets/index-*.js`. WAS 921.71 against a 904.40 baseline (a
 *               17.3 KB overhang that had crept in under the tolerance); −13.83 KB gz.
 *   hostWorker  700.84 KB — `dist/assets/hostWorker-*.js`. WAS 714.66 and FAILING this audit by
 *               1.29 KB, which is the regression that started this. The worker code-splits too
 *               (`worker.format = 'es'`), so it gets its own lazy `impl-*.js`; −13.82 KB gz.
 *   physics3d  1123.14 KB — now FOUR files, not one: `rapier-*.js` (1089.27, the
 *               `@dimforge/rapier3d-deterministic-compat` wasm glue, UNCHANGED), the client's
 *               `impl-*.js` (10.03), the LAN worker's own `impl-*.js` (16.83, which also carries
 *               its copy of the two below), and the `tilt-*.js` shared chunk (7.01: the CAD
 *               collider set plus `sim3d/tilt.ts`, hoisted because the scene chunk and the
 *               implementation chunk both import it). +33.87 KB on a route nobody loads without
 *               choosing 3D physics — that is the whole trade, and it is the right way round.
 *   graphics      5.60 KB — NEW on Day 3, three lazy chunks: `GraphicsSection-*.js` (2.29, the
 *               section itself), `settings-*.js` (1.64, the sixteen-setting model, hoisted
 *               because the section and the detector both import it) and `auto-*.js` (1.68, the
 *               GPU probe behind `Reset to Auto`). MEASURED, and it is what the §10 budget
 *               ("main +≤ 2 KB for the settings UI") is kept to: statically imported, the
 *               section cost the MAIN chunk 2.82 KB gz (921.26 → 918.44 when `Configure.tsx`
 *               was switched to `React.lazy`); lazy, it costs it nothing.
 *   scene       192.28 KB — `dist/assets/renderScene-*.js`. UNCHANGED (+0.03, noise): the two
 *               helpers it used to reach through `hive3d.ts`/`bodies.ts` are the same two
 *               functions, now in the light `sim3d/tilt.ts`, and the CAD geometry it reads did
 *               not move — it is simply no longer a free ride on the main chunk. RAISED to
 *               187.24 on Day 2 by the reticle (`renderLanding.ts` + `renderReticle.ts`), the
 *               chase and orbit cameras and the `project` hook; the heavy part of this chunk is
 *               three.js itself and everything added since is arithmetic. RAISED AGAIN on Day 3,
 *               187.27 → 192.28 (+5.01), by the graphics lane: `RGBELoader` and the PMREM
 *               environment loader (§4.5), the MSAA render target and its blit, the PiP
 *               minimap, the performance overlay, the quality governor and the settings model
 *               this chunk inlines its own copy of. SMAA and SSAO were NOT taken (see
 *               `GFX_NOT_OFFERED`) and that is most of why this is +5.6 and not +30. Still
 *               57 KB inside the §2.5 spec ceiling, kept below as `budgetCeiling` for context —
 *               the RATCHET binds to the measurement, because a budget is not a target.
 * `other` has no route in a healthy build (every `.js`/`.wasm` file lands in one of the four
 * above) — baseline near zero, so anything landing here at all is worth a look.
 *
 * RECALIBRATE by running `npm run build && npm run bundleaudit` and copying the printed gzip
 * totals in here, the same way `uiaudit.mjs`'s header describes lowering ITS baseline.
 */
const BASELINE = {
  main: { gzip: 918.72 * 1000 },
  // `@discord/embedded-app-sdk` behind `watchDiscordParticipants`'s dynamic import —
  // loaded only inside a real Discord Activity embed (`onDiscordHost()` gates the
  // import), so no ordinary player downloads it. MEASURED 2026-09-18.
  discord: { gzip: 44.30 * 1000 },
  hostWorker: { gzip: 705.23 * 1000 },
  physics3d: { gzip: 1123.14 * 1000 },
  scene: { gzip: 192.28 * 1000, budgetCeiling: 250 * 1000 },
  graphics: { gzip: 5.60 * 1000 },
  other: { gzip: 1 * 1000 },
};

console.log('BUNDLE AUDIT — docs/biobuzz/plan-3d.md §2.5\n');
console.log('route        file                                              raw        gzip');
console.log('-----        ----                                              ---        ----');
for (const route of Object.keys(BASELINE)) {
  const entries = byRoute.get(route) ?? [];
  for (const e of entries) {
    console.log(
      `${route.padEnd(12)} ${e.file.padEnd(48)} ${fmtKB(e.raw).padStart(9)}  ${fmtKB(e.gzip).padStart(9)}`,
    );
  }
}
// anything that fell through to `other` beyond what BASELINE listed above is still printed —
// `other` is a bucket, not a single file, so list every member.
console.log();

let failed = 0;
let ratcheted = 0;
for (const [route, base] of Object.entries(BASELINE)) {
  const entries = byRoute.get(route) ?? [];
  const totalGzip = entries.reduce((sum, e) => sum + e.gzip, 0);
  if (entries.length === 0) {
    // ABSENT is not a failure — a route with no reachable call site in THIS build (e.g.
    // `physics3d` in any build that never reaches `initPhysics3d()`, or `scene` in a build
    // where nothing mounts a 3D view) is correctly absent, not broken. Print the SPEC ceiling
    // when there is one and no measurement to fall back on; otherwise the last baseline.
    console.log(`·  ${route.padEnd(12)} absent (budget ${fmtKB(base.budgetCeiling ?? base.gzip)})`);
    continue;
  }
  const tolerance = Math.max(base.gzip * 0.02, 4 * 1000);
  const over = totalGzip > base.gzip + tolerance;
  const under = totalGzip < base.gzip * 0.95;
  const state = over ? 'FAIL' : under ? 'IMPROVED' : 'ok';
  if (over) failed++;
  if (under) ratcheted++;
  const ceiling = base.budgetCeiling ? `  (spec ceiling ${fmtKB(base.budgetCeiling)})` : '';
  console.log(
    `${state === 'FAIL' ? '✗' : state === 'IMPROVED' ? '↓' : '·'}  ${route.padEnd(12)} ${fmtKB(totalGzip).padStart(9)} / ${fmtKB(base.gzip).padStart(9)} baseline${ceiling}`,
  );
}

console.log();
if (failed) {
  console.log(`${failed} route(s) grew past baseline + tolerance. Find what pulled it in —`);
  console.log('a static import where a dynamic one belongs is the usual cause — or, if the');
  console.log('growth is real and wanted, raise the BASELINE here and say so in the commit.');
  process.exit(1);
}
if (ratcheted) {
  console.log(`${ratcheted} route(s) shrank by more than 5% — lower the BASELINE in`);
  console.log('scripts/bundleaudit.mjs to lock it in, the same way uiaudit.mjs asks.');
  process.exit(1);
}
console.log('ALL ROUTES AT OR UNDER BASELINE');
