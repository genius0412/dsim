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
 *   gallery    — the BIOBUZZ SCENE GALLERY (`Gallery-*.js`), a dev route. `devRouteFor`
 *                (`src/ui/App.tsx`) never matches `/gallery/*` on a stable build, but a static
 *                import is a bundling fact and not a runtime one: until 2026-09-19 the gallery,
 *                its seventy-scene registry and everything they reach were in `main` for every
 *                player of every game, to be gated at the URL. `GalleryRoute.tsx` `React.lazy`s
 *                it now, so it is its own chunk and this route is where it lands. Matched by
 *                FILENAME, before the content scans — it renders nothing itself.
 *   admin      — the ADMIN CONSOLE (`Admin-*.js` + the `AdminAnalytics-*.js` it lazily loads).
 *                One route, reachable by the accounts in `ADMIN_USER_IDS` and nobody else, and
 *                the fastest-growing thing in this repo: `Admin.tsx` statically pulls in
 *                `AdminLive`, `AdminReports`, `AdminAudit`, `AdminUser`, `AdminStanding` and
 *                `adminBits`, all of which were in `main` for every player until `App.tsx`
 *                `React.lazy`d the console (2026-09-19). Matched by FILENAME, before the
 *                content scans. ⚠️ THIS BUCKET IS WHY THE SPLIT HOLDS: without a route of its
 *                own the console's growth would land in `other`, whose near-zero baseline is
 *                meant to catch a chunk nobody meant to create.
 *   postfx     — BIOBUZZ 3D's POST-PROCESSING (`renderPost-*.js`, 2026-09-27): ambient occlusion and
 *                bloom, the Extreme tier's two effects, reached only through `renderScene.ts`'s
 *                `import('./renderPost')` and fetched only when one of them is on. It imports
 *                three.js from the scene chunk rather than carrying it, so it has none of the
 *                `scene` markers and would otherwise land in `other`. Matched by FILENAME.
 *   importer   — THE ROBOT IMPORTER ENGINE (`docs/robot-import-plan.md` §4, `docs/area/robot-import.md`):
 *                `importerEngine-*.js`, the lazy three.js zone `src/robotImport/engine/` behind
 *                `engineLoader.ts`'s one dynamic import — the loaders (glTF, STL, OBJ+MTL, 3MF with
 *                fflate, PLY), meshopt's simplifier with its inlined wasm, GLTFExporter, the bake and
 *                the preview. Matched by FILENAME. ⚠️ IT IMPORTS three.js, and so does the scene, so
 *                once both are reachable Rollup HOISTS three (with the GLTFLoader, the meshopt decoder
 *                and BufferGeometryUtils they share) into a shared chunk. That chunk keeps the
 *                `WebGLRenderer` marker and is billed to `scene` below — a 3D player downloads it
 *                either way — which is why `renderScene-*.js` is routed by FILENAME too: without
 *                three inside it, its own bytes carry no `scene` marker.
 *   step       — STEP support: `stepWorker-*.js` (the worker, with occt-import-js's 97 KB glue
 *                inlined) and `occt-import-js-*.wasm` (OpenCascade, ~7.6 MB raw). Fetched only when
 *                a STEP file is dropped. Matched by FILENAME.
 *   importworker — the importer's two WORKERS (lane 9): `importWorker-*.js` (parse, weld, simplify
 *                off the main thread), `measureWorker-*.js` (a measurement's orientation half) and
 *                the import worker's lazy `meshoptDecoder-*.js` and `meshoptEncoder-*.js` (the bake's
 *                stored-mesh writer, fetched on a Save). Fetched when a file is dropped on the
 *                importer. Matched by FILENAME.
 *   library    — the device ROBOT LIBRARY (`library-*.js`, `src/robotImport/library.ts`), reached
 *                by a dynamic import from the renderers' asset seam the first time an imported
 *                robot is drawn, and from the visuals relay's client the first time it reads an
 *                asset the owner uploads. Matched by FILENAME. ⚠️ A STATIC import of it from any
 *                main-side file folds it into `main` and this route reads `absent`: that is the
 *                symptom to look for.
 *   relay      — the VISUALS RELAY's VALIDATORS (`visualCheck-*.js`, `src/net/visualCheck.ts`): the PNG
 *                and GLB structure checks, reached by `import()` from `importVisualsClient.ts` the
 *                first time a look is uploaded or received. The room and the LAN host worker import
 *                the same file statically (their bundles carry it), so only the client's copy is lazy.
 *                Matched by FILENAME.
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

// `BUNDLE_DIST` points the audit at another build: `scripts/robot-import/bundle.mjs` builds one
// with the importer reachable, before the editor that will reach it exists.
const DIST = process.env.BUNDLE_DIST || 'dist';
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
  if (/^Gallery-[^/]*\.js$/.test(base)) return 'gallery';
  // ZENITH AUTOS (docs/area/autos.md): `@horizon36596/zenith-core` + `-schema` (with zod) and
  // DSIM's auto seat, behind `src/auto/zenithAutos.ts` — a facade named so this chunk is NOT
  // `index-*` (the lazy entry was `src/auto/index.ts` once, and its chunk was then billed as
  // main). Loaded only when a solo run plays an auto, or the Autonomous panel opens. The client's
  // entry is `src/ui/zenithEditor.ts` (the facade plus the editor popup), and the robot builder's
  // Autonomous panel (`AutonomousSetup.tsx`) is lazy beside it, so both count here too.
  if (/^(zenithAutos|zenithEditor|AutonomousSetup)-[^/]*\.js$/.test(base)) return 'autos';
  // The admin console's chunks, by FILENAME like the three above — Vite names a lazy chunk
  // after its facade module, so `Admin-*.js` and `AdminAnalytics-*.js` are what it emits, and
  // neither renders anything a content marker would recognise. Before the content scans,
  // because the console imports the SEASONS registry and the standing model and a future
  // marker could otherwise claim it.
  if (/^Admin[A-Za-z]*-[^/]*\.js$/.test(base)) return 'admin';
  // The post-processing chunk (AO + bloom), by FILENAME: Vite names it after `renderPost.ts`, and
  // it imports three.js from `renderScene-*.js` instead of containing it, so no content marker
  // here would recognise it. If a future chunking ever merged it into the scene chunk, the name
  // would change and the `scene` marker below would claim it, which is the right answer.
  if (/^renderPost-[^/]*\.js$/.test(base)) return 'postfx';
  // The physical-materials chunk (the `materials` row), by FILENAME for the same reason: Vite
  // names it after `renderSurfaces.ts`, its `renderSurface*.ts` helpers are merged into it (only
  // it imports them), and it imports three.js from `renderScene-*.js` rather than containing it.
  if (/^renderSurfaces-[^/]*\.js$/.test(base)) return 'surfaces';
  // THE ROBOT IMPORTER, by FILENAME (see the route table). `engineLoader-*.js` exists only in the
  // measurement build, where the loader is an entry of its own; in the app it is inlined.
  // `geometry-*.js` is the measurement code (`src/robotImport/geometry.ts`) once the editor and the
  // engine both import it: Rollup splits it into a chunk the two share, fetched with the engine.
  // `fflate.module-*.js` is three's fflate, split out because the engine (the zip reader) and the
  // main build's lazy `threeMf-*.js` share it: fetched with the engine
  if (/^(importerEngine|engineLoader|geometry|fflate\.module)-[^/]*\.js$/.test(base)) return 'importer';
  // `occtWorker-*.js` is the occt instance the STEP worker spawns (one per piece reader): Vite
  // builds a worker made inside a worker as its own bundle too
  if (/^(stepWorker|stepReader|occtWorker)-[^/]*\.js$/.test(base) || /^occt-import-js[^/]*\.wasm$/.test(base)) return 'step';
  // THE RELAY'S VALIDATORS, by FILENAME: `importVisualsClient.ts` reaches them by `import()`, so a
  // client that never uploads or receives an imported robot's look never fetches them
  if (/^visualCheck-[^/]*\.js$/.test(base)) return 'relay';
  // THE IMPORTER'S WORKERS (lane 9), by FILENAME: Vite builds each `new Worker(new URL(…))` entry
  // as its own bundle, named after it. `meshoptDecoder-*.js` is the import worker's lazy chunk for a
  // meshopt-compressed glTF, behind a facade so it is not named like the main build's shared three
  // chunk (`meshopt_decoder.module-*.js`, routed `scene` by its marker).
  // `threeMf-*.js` (three's 3MF loader, fflate's unzip and `miniDom.ts`) and `zip-*.js` (the zip
  // reader) are the import worker's lazy chunks for a 3MF or a zip; the engine's main-thread fallback
  // reaches `threeMf.ts` by the same `import()`, so the main build has one too, billed here as well.
  // `meshoptEncoder-*.js` is meshoptimizer's encoder, which the bake's stored-mesh writer
  // (`storedGlb.ts`) fetches on a Save; the worker and the engine's fallback share the one file
  // `lite-*.js` is the worker's lazy chunk for a room's lighter mesh (`lite.ts` with GLTFExporter)
  if (/^(importWorker|measureWorker|meshoptDecoder|meshoptEncoder|threeMf|zip|lite)-[^/]*\.js$/.test(base)) return 'importworker';
  // THE ROBOT LIBRARY (`src/robotImport/library.ts`, IndexedDB), by FILENAME: the renderers' asset
  // seam (`src/render/importedAssets.ts`) reaches it with a dynamic `import()` the first time an
  // imported robot is drawn, so it is its own small chunk rather than a cost in `main`.
  if (/^library-[^/]*\.js$/.test(base)) return 'library';
  // THE IMPORTER'S UI (lane 4): the editor route, and what the robot page reaches by `import()` on a
  // click (the share-file reader and writer, the export, the library dialogs). By FILENAME, before
  // the content scans: none of them carries three.js, so they would otherwise land in `other`.
  if (/^(ImportEditor|shareFile|draftStore|LibraryDialogs|exportRobot)-[^/]*\.js$/.test(base)) return 'importerui';
  // Vite's preload helper is split out only when a SECOND entry shares it (the measurement
  // build); in the app it is part of the entry chunk, so it is billed there
  if (/^preload-helper-[^/]*\.js$/.test(base)) return 'main';
  // the scene's own chunk, by FILENAME: once three.js is hoisted into a chunk shared with the
  // importer, `renderScene-*.js` no longer carries the `WebGLRenderer` marker itself
  if (/^renderScene-[^/]*\.js$/.test(base)) return 'scene';
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
 *               RAISED AGAIN 2026-09-19, 192.28 → 199.48 (+7.20), by the field-visuals lane and
 *               the owner's render pass on top of it: the shot-path reticle's arc, the clear-
 *               panel edge outlines, the turret's split yaw/pitch nodes, the swerve module and
 *               the two extra roller stripe textures, the braced shooter plates, and the
 *               am-5706 holding box. `scene/renderLanding.ts` was DELETED in the same lane and
 *               gave some of it back. Every one of those is geometry arithmetic; nothing new is
 *               imported into the chunk, which is why +7 and not +70. 50 KB of ceiling left.
 * `other` has no route in a healthy build (every `.js`/`.wasm` file lands in one of the four
 * above) — baseline near zero, so anything landing here at all is worth a look.
 *
 * ── RE-MEASURED on `feat/privacy-cookies` (roadmap item 8) ────────────────────────────
 * The privacy page's "Your data" panel and the storage registry behind it are MAIN-CHUNK by
 * design: `/privacy` must render for a visitor with no account and for the AdSense review
 * fetch, so nothing on it may sit behind a lazy boundary, and `src/storageKeys.ts` is imported
 * by `settings.ts` and `theme.ts` which are on the entry path anyway.
 *   main        929.04 KB — +10.32 over 918.72. The panel, the registry (most of it PROSE: a
 *               purpose and a retention sentence per key, which is the point of it), the CCPA
 *               paragraph and the rest of the legal-text edits, and `fetchMyExport`.
 *   graphics      4.01 KB — −1.59 from 5.60, and it is the same bytes moving rather than bytes
 *               saved: `graphics/settings.ts` and `graphics/store.ts` used to hold their own key
 *               literals and now import them from the registry, so the three key strings are
 *               counted once in main instead of once in the lazy chunk. Locked in because the
 *               ratchet asked; it is not a win to defend.
 *
 * ── RE-MEASURED 2026-09-19, the pre-publish audit ─────────────────────────────────────
 *   main        927.95 KB — −5.99 from 933.94: the BIOBUZZ scene gallery left the entry chunk
 *               (see the `gallery` route above). The same audit's own additions to main — the
 *               legal-page gate suspension, the auth dialog's a11y, `coerceCaps`, the analytics
 *               query strip — are inside the noise of that.
 *   gallery       7.33 KB — NEW: `Gallery-*.js`, the lazy gallery chunk. Bytes that used to be
 *               counted under main; a stable build never requests it.
 *   hostWorker  706.37, physics3d 1125.26, scene 199.67 — within noise (+0.11, +0.20, +0.19):
 *               the 3D-world disposal, the shared chassis-collider builder and the context-loss
 *               watcher. Baselines left where they were; the ratchet's tolerance covers them.
 *
 * ── RE-MEASURED 2026-09-19, the admin console's verification pass ─────────────────────
 *   main        923.89 KB — −4.06 from 927.95, and −14.70 from the 938.59 the console's own
 *               commit (9162190) had already pushed it to. `App.tsx` imported `Admin`
 *               STATICALLY, which pulled `AdminLive`, `AdminReports`, `AdminAudit`,
 *               `AdminUser`, `AdminStanding`, `adminBits` and `adminCopy` into the chunk every
 *               player downloads to drive a robot — for a route exactly the accounts in
 *               `ADMIN_USER_IDS` can open. One `React.lazy` took all of it out, and took the
 *               moderation features added in the same pass with it.
 *   admin        25.10 KB — NEW (`Admin-*.js` 17.48 + `AdminAnalytics-*.js` 7.61). Bytes that
 *               were counted under `main` until this build, plus suspension, username clearing,
 *               account deletion, the two report lists and the payments panel.
 *   other         1.66 KB — back to just `settings-*.js`. It had been 9.12 and FAILING since
 *               9162190, because `AdminAnalytics-*.js` had no route of its own and fell through
 *               to the bucket whose near-zero baseline exists to catch exactly that.
 *
 * ── RE-MEASURED 2026-09-19, `discord-activity` after pulling alpha (PR #41) ──────────
 *   main        927.11 KB — +3.22 over 923.89, and the split was measured against a clean
 *               `origin/alpha` worktree built the same minute (924.97): **+2.14 is the
 *               activity** — `discordActivity.ts`, the lobby browser, the Lobby "You"
 *               section, the home button and the App/ModeSelect wiring, all MAIN by design
 *               because `inDiscordActivity()` is what decides whether to render them — and
 *               +1.08 is alpha's own tip since the console pass (the URL-state fix in
 *               d64cf19). Under the 4 KB tolerance, which is the overhang this header warns
 *               about, so it is measured here instead.
 *
 * ── RE-MEASURED 2026-09-21, merging PR #41 into alpha ──────────────────────────
 *   main        946.79 KB — RAISED from 927.11, and ⚠️ ALMOST NONE OF THE RISE IS THIS PR.
 *               Measured both trees the same minute, same machine: `origin/alpha` ALONE builds
 *               a 944.61 KB entry chunk, i.e. alpha was ALREADY 20.72 KB over its own 923.89
 *               baseline and this audit was ALREADY RED on it before the merge — the
 *               match-results redesign (5392737..918173b) grew the entry chunk and did not
 *               re-measure here. The merge adds 946.79 − 944.61 = **+2.18 KB**, which is the
 *               activity itself and matches the +2.14 the 2026-09-19 entry above predicted.
 *               Raised to the measured merged value so the ratchet is honest again; the 20.72
 *               is alpha's to explain, and it is called out here rather than folded in
 *               silently, because a baseline raised without an attribution is how a ratchet
 *               stops meaning anything.
 *   discord      44.30 KB — unchanged, and still exactly the SDK: nothing of the activity's
 *               own code leaks into the lazy chunk.
 *   hostWorker 709.94, physics3d 1130.92, scene 203.60 — IDENTICAL to clean alpha to
 *               within 0.05 KB, i.e. alpha's own drift since its last entry (+3.63, +5.86,
 *               +2.16), none of it this branch's. Left where alpha left them, for alpha to
 *               re-measure with whatever moved them.
 *
 * ── RE-MEASURED 2026-09-22, the BIOBUZZ bot rewrite (`src/games/biobuzz/ai/`) ─────────────
 *   Both trees built the same minute, same machine: clean `origin/alpha` (d734a65) against the
 *   rewrite on top of it.
 *   main        963.55 KB — RAISED from 946.79. Clean alpha builds 955.52, so **+8.03 is the
 *               bots** (the new policy, `ai/geom.ts`, the build roster) and +8.73 is alpha's own
 *               drift since 2026-09-21, still under the tolerance and called out here rather than
 *               folded in silently.
 *   hostWorker  720.96 KB — RAISED from 706.26, which it was FAILING by 0.57 KB. Clean alpha
 *               builds 713.37: **+7.59 is the bots** (the LAN host runs a `Room`, and a `Room`
 *               seats bots) and +7.11 alpha's drift. The AI is sim code the server and the worker
 *               both need, so it cannot be lazy the way the 3D chunk is.
 *   Every other route identical to clean alpha to 0.01 KB.
 *
 * ── RE-MEASURED 2026-09-27, FULL PREDICTS EVERYTHING (BIOBUZZ online, `src/game.ts`) ──────────
 *   Both trees built the same minute, same machine: clean `origin/main` (8edbe69c) against the
 *   change on top of it.
 *   main        984.28 KB — RAISED from 963.55. Clean main builds 982.64, so **+1.64 is this
 *               change**: the world-tier routing, the snapshot-agreement digest
 *               (`src/net/worldDigest.ts`) and the world-step probe. It is client prediction the
 *               render loop runs every frame, so it cannot be lazy the way the 3D chunk is; the
 *               engine rewind itself is in the lazy physics3d chunk. The other +19.09 is drift
 *               since 2026-09-22 (the lag fix, contact drawing, Auto, and alpha's own merges),
 *               which had crept to within 0.18 KB of the tolerance; called out here, not folded in
 *               silently.
 *
 * ── RE-MEASURED 2026-10-01, the robot import feature branch (bundle trim) ────────────────────
 *   Built the same hour, same machine: the alpha base it forked from (3834b2a1) against the branch
 *   with its lanes merged, and the main chunk taken apart by sourcemap, file by file.
 *   main        1013.97 KB — RAISED from 984.28. The branch BUILT 1021.60 against alpha's 989.17
 *               (+32.43). Three things that did not belong in the entry chunk moved out first, −7.63:
 *               `robotImport/library.ts` (IndexedDB: the visuals relay's client imported it
 *               statically, which is why its route read `absent`), the relay's PNG/GLB validators
 *               (`net/visualCheck.ts`, ~3.3 KB, fetched on the first look) and the three games'
 *               placement checks (`games/importMechChecks.ts`, ~2.6 KB, in the editor's chunk now).
 *               What is left is +24.84 over alpha and is code a match or the robot page runs for an
 *               imported robot, none of it lazy-able: the footprint polygon and mouth-carve sim
 *               (`sim/imported.ts`, `importedMech.ts`: 5.3, run by prediction every tick), the 2D
 *               sprite and asset seam, the two games' sprite and preview branches, `FootprintSvg`
 *               (5.7), each game's `importMech.ts` (1.0), the robot page's row, panel and notices
 *               (4.3), the sim/net plumbing (physics,
 *               robot, spawn, field, mounts, the spec admission and the replay format: 3.4), the
 *               visuals relay client (2.1) with its wire constants and bridge (0.9), and the app's
 *               route, test-drive and lobby wiring (2.2). The other +4.89 of the distance from the
 *               old 984.28 is alpha's own drift since 2026-09-27 (989.17), called out, not folded in.
 *   hostWorker  797.84 KB — RAISED from 778.01. Alpha base 781.68 (+3.67 drift); the branch is +16.16:
 *               a LAN host runs a `Room`, and a Room steps imported robots (`sim/imported.ts` and
 *               `importedMech.ts`: 5.4) and relays their look (`server/importVisuals.ts` 2.3 and the
 *               validators 2.8, which the room runs synchronously on the last frame, so they cannot
 *               be lazy there as they are in the client). Only a LAN host downloads this worker.
 *   scene       231.54 KB — RAISED from 226.59 (alpha base 226.61): +4.93 = `renderImported.ts` (+2.86,
 *               the imported robot's 3D draw) and +1.98 from three.js now living in a chunk the
 *               importer and the scene share, so the same bytes compress as two files.
 *   relay        3.35 KB — NEW, `visualCheck-*.js` (see the route table).
 *   library      2.26 KB — was 1.85, measured before the relay client reached it: the lite-mesh
 *               cache reads (`meshLiteFor`, `putMeshLite`) are in the one shared chunk now.
 *   importerui  24.18 KB — was 21.55 (+2.63): the placement checks and their shared helpers, which
 *               moved here from `main`.
 *   physics3d   1144.96 KB — NOT raised: alpha's own base already measures 1143.47 against the 1125.06
 *               below (+1.49 is the branch), inside the 2% tolerance either way.
 *
 * RECALIBRATE by running `npm run build && npm run bundleaudit` and copying the printed gzip
 * totals in here, the same way `uiaudit.mjs`'s header describes lowering ITS baseline.
 */
const BASELINE = {
  main: { gzip: 1013.97 * 1000 },
  // `@discord/embedded-app-sdk` behind `watchDiscordParticipants`'s dynamic import —
  // loaded only inside a real Discord Activity embed (`onDiscordHost()` gates the
  // import), so no ordinary player downloads it. MEASURED 2026-09-18.
  discord: { gzip: 44.30 * 1000 },
  // 2026-09-25: 720.96 -> 778.01 (+57.05), MEASURED. The LAN host runs `server/room.ts` in a
  // tab, and a custom room now plays Zenith autos (docs/area/autos.md), so the room statically
  // imports the auto seat and with it Zenith's planner and follower (the `autos` chunk's content,
  // 55.75 KB). Only a player HOSTING a LAN room downloads this worker; nobody else pays for it.
  // 2026-10-01: 778.01 -> 797.84 (+19.83), MEASURED: the imported robot's sim and the visuals relay,
  // which a LAN host's Room runs (see the RE-MEASURED entry above). Alpha's own drift was +3.67 of it.
  hostWorker: { gzip: 797.84 * 1000 },
  physics3d: { gzip: 1125.06 * 1000 },
  // 2026-09-19: 199.48 -> 201.44 (+1.96). The owner's render pass made three meshes REAL —
  // a swerve pod that is a pod (top plate, azimuth ring, fork, 3-in wheel, belt drive)
  // instead of a squat box, a flywheel motor behind the hood driving through a belt, and a
  // telescoping box tube — plus the in-reach collar. It crept in under the 4 KB tolerance,
  // which is exactly the overhang this header warns about, so it is measured here instead.
  //
  // 2026-09-19, the SECOND owner pass: 201.44 -> 205.83 (+4.39), which crossed the tolerance.
  // ⚠️ ONLY 0.93 OF IT IS THAT PASS. The tree measured 204.90 BEFORE a line of it was written —
  // 3.46 KB had already crept in under the tolerance, which is the overhang this header warns
  // about happening twice in one day. Measured, not inferred: a `npm run build && npm run
  // bundleaudit` on the clean tree printed 204.90.
  // What the pass itself added: the ROBOT SIGN assembly (§12.4 R401–R403 — two plates, the
  // team-number canvas, the basis-built orientation), the AprilTag bleed-through texture and
  // its material, the clear panel's Fresnel shader chunk and its JS twin, the side plate's
  // relief ramp, and the cosmetic top caps. Every one of them is geometry or a texture that a
  // 3D scene has to carry; none of it is reachable from the main chunk.
  //
  // 2026-09-20: 205.83 -> 209.99 (+4.16), just past the 4.12 KB tolerance. The ground-beam
  // winding fix (`fixGroundBeamWinding`, `renderFieldGlb.ts`) — `weldedComponents` grew a zMin/
  // zMax pass, and `shellWindingStats` is a new exported measurement the RENDER lane calls
  // directly against the shipped GLB, the same relationship `sheetFacingBalance` has to the
  // open-sheeting check. Real load-time logic (a `THREE.DoubleSide` material clone + a per-mesh
  // triangle partition), not a comment; scoped to the frame nodes only.
  //
  // 2026-09-21: measured at 213.95, still UNDER the 4.12 KB tolerance, so the number below is
  // deliberately NOT moved — but recorded here, because this is the creep-under-tolerance case
  // the header above warns about and the next pass to cross it should not have to untangle three
  // sessions' work. **+2.15 KB of the +3.96 is the WHOLE-FIELD WINDING REPAIR**
  // (`repairFieldWinding`, `renderFieldGlb.ts`), measured in isolation by bundling that one module
  // at HEAD and with the change (esbuild, minified, `three` external: 15.44 -> 17.59 KB gzip). It
  // REPLACES `fixGroundBeamWinding`, so the net is a shell-topology + orientation-propagation core
  // and a local-frame geometry split, less the world-space partition pass that came out. The
  // remaining ~1.8 KB is concurrent `scene/renderRobots.ts` work that was uncommitted in the tree
  // at the time and is not this change's to claim.
  //
  // 2026-09-21, THE DRIVE WHEELS: 209.99 -> 216.61 (+6.62), which is past the 4.20 KB tolerance,
  // so the number below moves. ⚠️ **ONLY ~2.7 KB OF IT IS THIS PASS.** The note directly above
  // measured the same route at 213.95 earlier the same day and deliberately left the baseline
  // alone — so 3.96 KB of this step is that overhang finally being booked, not new.
  // What the wheel pass itself added, measured in isolation (the new part table + `barrelProfile`
  // / `rollerGeometries` / `plateGeometries` / `tyreGeometries` / `buildDriveWheel` / `WHEEL_LOD`
  // / `bbWheelDetail`, bundled alone with esbuild, minified, `three` external and the file's own
  // helpers stubbed): **1.78 KB gzip**, against roughly 0.35 KB for the `CanvasTexture` stripe
  // generator it REPLACES. The rest is the tier plumbing in `renderScene`/`renderPreview`.
  // It buys real geometry for five drivetrains at two tessellation levels — eleven barrel rollers
  // on 45° axles, two staggered omni rows, a crowned traction tyre — where there was a painted
  // 64×64 canvas of diagonal lines. There is no cheaper way to draw a mecanum that is a mecanum,
  // and the owner's report was that the painted one read as the wrong machine.
  //
  // 2026-09-22, FRONT/BACK MARKS + THE BOX TUBE RIM AIM: 216.61 -> 221.06 (+4.45), just past the
  // 4.20 KB tolerance. All of it is renderRobots.ts/parts.ts geometry: `bbFrontMarks` (the light
  // bar, the deck arrow, the ribbed hazard bar, one emissive material), the tube's smoothstep ease
  // and yaw/pitch/extension slew, and the rim-aim backoff. Nothing new is imported into the chunk;
  // the route list is unchanged. 29 KB of ceiling left.
  //
  // 2026-09-27, THE EXTREME TIER: measured at 223.86, under the 4.42 KB tolerance, so the number
  // is NOT moved; recorded for the next pass that crosses it. Main at 023dc75e, built the same
  // hour with no change, measured 222.62, so +1.56 of the overhang predates this and +1.24 is the
  // tier: the lazy loader for `renderPost` (which carries the passes themselves, see `postfx`),
  // the three.js core classes only those passes use (Rollup keeps three's own module in this
  // chunk, so they are emitted here), the emissive and panel-cap wiring, and the preview clamp.
  //
  // 2026-09-27, PHYSICAL MATERIALS: measured at 224.92, +1.06 over the 223.86 above and still under
  // the 4.42 KB tolerance (225.48), so the number is NOT moved; recorded, and the next pass will
  // cross it. The +1.06 is the two scenes' wiring to the lazy `surfaces` chunk — `syncSurfaces`,
  // the drop path, the probe-capture trigger and the raise/lower around the scene pass in
  // `renderScene.ts`, the robots-only twin of it in `renderPreview.ts` — plus the three.js core
  // classes only that chunk uses (`CubeCamera`, `WebGLCubeRenderTarget`, `DataTexture`), which
  // Rollup emits here with the rest of three. The shaders, the finish table and the generators are
  // in `surfaces`.
  //
  // 2026-09-27, THE ROBOT/FIELD/VENUE APPLIERS: measured at 225.14, +0.22 over the 224.92 above
  // and still under the 4.42 KB tolerance (225.48), so the number is NOT moved. The appliers
  // themselves are counted in `surfaces`, below; what lands here is the wiring `renderScene.ts`
  // and `renderPreview.ts` do around them — the robot shadow row (`setRobotShadows`),
  // `robotsChanged()`'s identity check replacing the old child-count one, and the probe recapture
  // trigger.
  //
  // 2026-09-28, TILE JOINTS AND ROBOT OVERLAPS: 225.14 -> 226.59 (+1.45), which crossed the
  // tolerance, so the baseline moves to it. What was added: the dovetail seam and tile outlines
  // (`renderTiles.ts`), and in `renderRobots.ts` the intake-arm keep-outs, the butterfly traction
  // placement, the top-cap and end-bar pieces and the measured turret rest pose (`restTurretHeads`).
  //
  // 2026-10-01, THE IMPORTED ROBOT: 226.59 -> 231.54 (+4.95), MEASURED. `renderImported.ts` (+2.86) and
  // three.js moving into a chunk the importer shares (+1.98): see the RE-MEASURED entry above. 18 KB of
  // ceiling left.
  scene: { gzip: 231.54 * 1000, budgetCeiling: 250 * 1000 },
  // 2026-09-21, THE EIGHT PAINTED ENVIRONMENTS: 4.01 -> 5.56 (+1.55), well inside the 4 KB
  // tolerance, so the number below is deliberately NOT moved — recorded here for the same reason
  // the `scene` note above records its own under-tolerance creep. The growth is DATA:
  // `graphics/environments.ts` gained a light rig and a painted-dome recipe per entry, and eight
  // entries. It is the cheap half of the trade — the alternative was eight more 1.6 MB HDRIs,
  // which would have cost this route nothing and the PLAYER 13 MB. The PAINTING lives in
  // `scene/renderEnvironment.ts` and lands in the `scene` route, which did not move (216.61 ->
  // 216.60): a few hundred bytes of canvas calls against a 217 KB chunk.
  //
  // 2026-09-27, THE EXTREME TIER: measured at 6.68, still inside the tolerance, number not moved.
  // Main at 023dc75e measured 6.52, so +0.16 is this pass (the Extreme tile, the AO and bloom rows,
  // the Max shadow tile) and 2.51 was already over the 4.01 before it.
  graphics: { gzip: 4.01 * 1000 },
  // 2026-09-27: NEW. `renderPost-*.js`, the post-processing chunk: three's GTAO pass (with its
  // shaders and the simplex noise it seeds from) and UnrealBloom, plus `renderPost.ts`'s own
  // subclass, high-pass shader and ping target, measured on the build that introduced it. Lazy:
  // fetched only when ambient occlusion or bloom is on, which is the Extreme column and any Custom
  // that turns one on. SMAA is deliberately not in it (its pass alone is 38 KB of lookup
  // textures; `GFX_NOT_OFFERED`).
  postfx: { gzip: 12.3 * 1000 },
  // 2026-09-27: NEW. `renderSurfaces-*.js`, the physical-materials chunk, measured on the build
  // that introduced it: the finish table (`graphics/finishes.ts`, 38 entries, inlined here because
  // only this chunk reads it), the surface kit (procedural detail generators, the one shader patch,
  // the twin swap), the room probe with its exposure and white balance, and the field, robot and
  // venue appliers (the GLSL strings are most of the field's share). Lazy: fetched only when the
  // `materials` row is `physical` (Extreme, or a Custom that turns it on); a 2D player and a
  // standard-materials 3D player pay nothing.
  surfaces: { gzip: 20.74 * 1000 },
  gallery: { gzip: 7.33 * 1000 },
  // 2026-09-24: the Zenith autos chunk, MEASURED on the build that introduced it — Zenith's
  // planner, follower and schema (zod) plus `src/auto/`. Lazy: see the `autos` route.
  // 51.97 -> 55.77 (+3.80) the same day: the headless runner (`runAutoHeadless`, "Simulate in
  // DSIM" and "Drive it here") and the preview projection (`view.ts`) joined the chunk. Measured
  // rather than left to creep under the 4 KB tolerance. The UI that opens it (Autonomous section,
  // `zenithHost.ts`, the HUD line) is in main: +5.15 KB against alpha @ c4afe65's 973.24.
  // 2026-09-26: 55.77 -> 59.93 (+4.16), MOVED here from main rather than grown. Merging alpha put
  // main at 984.51 against its 982.82 ceiling (alpha alone measures 980.38), so the Autonomous
  // panel (`AutonomousSetup.tsx`, lazy in `MatchSetup`) and the editor popup (`zenithLaunch.ts`,
  // `zenithHost.ts`, behind the client entry `src/ui/zenithEditor.ts`) went lazy. Main is 980.94
  // after it, +0.56 against alpha: the library read, the lobby chip and the HUD line.
  autos: { gzip: 59.93 * 1000 },
  // 2026-09-19: NEW. The whole admin console, lazily loaded by `App.tsx`. See the route note
  // above and the RE-MEASURED entry below for what moved out of `main` to create it.
  // 2026-09-25: 25.10 -> 29.75, raised on purpose: the Access and Banners tabs, the lockdown
  // scope controls, and the analytics page's sponsor report and imported-history section. Admin
  // only, so no player downloads it.
  admin: { gzip: 29.75 * 1000 },
  // 2026-10-01: NEW, the robot importer (lane 3 of `docs/robot-import-plan.md`). MEASURED with
  // `npm run bundleaudit:importer` (the app plus `engineLoader.ts` as an entry, because no screen
  // imports the loader yet; a plain production build reports both routes absent). The engine
  // chunk is 61.61 (loaders for six formats, meshopt's simplifier with its inlined wasm,
  // GLTFExporter, OrbitControls, the bake and the preview) plus the 0.27 loader.
  // What it does to `scene`: three.js, GLTFLoader, the meshopt decoder and BufferGeometryUtils
  // move into a chunk the two zones share (178.86, routed `scene` by its marker) and
  // `renderScene-*.js` drops to 49.67, so the route measures 228.53 against 226.55 without the
  // importer: +1.98 of import/export glue and two separately compressed files, inside tolerance.
  // 2026-10-01 (lane 4, with lanes 2, 6 and 7 merged): 62.81 = `importerEngine-*.js` 54.57 + the
  // shared `geometry-*.js` 8.24 (the measurement code, which the editor imports too). The feature
  // branch alone measured 61.75 with geometry inside the engine chunk; the +1.06 is the preview's
  // camera presets and collision layer.
  // 2026-10-01 (lane 9, importer performance): 62.82 -> 67.06, raised on purpose. The engine now
  // drives two workers (`importSession.ts`, `measureSession.ts` and their protocols, +2.6) and keeps
  // the main-thread fallback they replace (`parse.ts`, with the streamed STL reader, +1.2); the
  // measurement's split into an orientation half and a finish half is +0.2 in `geometry-*.js`.
  // 2026-10-02 (real CAD): 67.06 -> 69.10, raised on purpose. `importerEngine-*.js` 56.42 (the zip
  // directory reader and the zip/STEP routing, the glTF merge as it reads; three's 3MF loader left
  // for the lazy `threeMf-*.js`, billed to `importworker`), `geometry-*.js` 9.61 (+1.1: front
  // detection) and `fflate.module-*.js` 3.07, three's fflate, now split out because the lazy 3MF
  // chunk shares it (it was inside the engine chunk before).
  // 2026-10-02 (moving parts): 69.10 -> 76.94, raised on purpose. `geometry-*.js` 13.62 (+4.0:
  // `motion.ts`, the round-part fit, the wheel and axle finders and the fold planner, which the
  // editor's picking reads too) and `importerEngine-*.js` 60.25 (+3.8: the preview's picking, tints
  // and Play loop, the stored scene's export and read-back, the lighter mesh keeping its nodes).
  // 2026-10-03 (compressed stored mesh): 76.94 -> 79.85, raised on purpose. `importerEngine-*.js`
  // 60.31 -> 62.49 against ede417c4 built the same minute: the stored-mesh writer (`storedGlb.ts`,
  // quantised attributes and the meshopt container) and `liteMesh` re-writing a compressed mesh as
  // float for the relay. The encoder itself is lazy (`meshoptEncoder-*.js`, billed to `importworker`).
  // 2026-10-03 (moving parts, round two): 79.85 -> 84.28, raised on purpose. `geometry-*.js` 16.82
  // (+2.6: `motion.ts`'s flywheel, turret and deployed-part finders, upright side rollers, the wheel's
  // turns-with rules, the generic spin / swing / slide joints and their gearing) and
  // `importerEngine-*.js` 64.39 (+1.9: `splitLumps`, the preview playing joints and gearing).
  importer: { gzip: 84.28 * 1000 },
  // 2026-10-01: NEW (lane 9). `importWorker-*.js` 104.06 (three.js core, the GLB/glTF, STL, OBJ+MTL
  // and PLY loaders, meshopt's simplifier, the weld and the crease: the parse-to-prepared pipeline
  // that used to block the main thread for seconds; and GLTFExporter for the bake's mesh half),
  // `measureWorker-*.js` 6.50 (`geometry.ts`: the orientation half of a measurement) and
  // `meshoptDecoder-*.js` 7.26 (fetched only for a meshopt-compressed glTF). Fetched when a file is
  // dropped on the importer or a robot is saved, never otherwise.
  // 2026-10-02 (real CAD): 117.82 -> 139.68, raised on purpose. `importWorker-*.js` 107.31 (+3.25: the
  // glTF merge as it reads, the consuming simplification, zip requests) and three LAZY chunks it adds:
  // `threeMf-*.js` 7.96 (three's 3MF loader, fflate's unzip and `miniDom.ts`: 3MF moved off the main
  // thread, fetched only for a 3MF), the main build's copy of it for the no-Worker fallback 7.91, and
  // `zip-*.js` 1.56 (fetched only for a zip). A GLB or STL import fetches none of the three.
  // 2026-10-03 (compressed stored mesh): 139.68 -> 140.34 (ede417c4 measured 141.82 the same minute).
  // NEW `meshoptEncoder-*.js` 8.13, meshoptimizer's encoder with its inlined wasm, fetched on a Save
  // by the bake's writer; one file, since the worker's copy and the engine fallback's are the same
  // bytes. `importWorker-*.js` 107.83 -> 99.66: the bake writes with the encoder now, so GLTFExporter
  // left the worker's main chunk. Then 140.34 -> 154.05: NEW `lite-*.js` 12.26, `liteMesh` and the
  // float writer (`floatGlb.ts`, GLTFExporter), lazy in the worker and fetched only when a room asks
  // for the lighter mesh. It ran on the main thread, 0.3 s from the old 69k float mesh and 0.8 s
  // from a 250k one (Node), which froze the lobby the first time a room asked.
  importworker: { gzip: 154.05 * 1000 },
  // 2026-10-01: NEW. `occt-import-js-*.wasm` 3110.91 (OpenCascade, 7.6 MB raw), `stepWorker-*.js`
  // 21.95 (the worker with occt's glue) and `stepReader-*.js` 0.42. Fetched only when a STEP file is
  // dropped; every other import, and every player who never imports a robot, pays nothing.
  // 2026-10-02 (real CAD): 3133.28 -> 3144.41. occt's glue moved into `occtWorker-*.js` 22.02 (one per
  // piece reader, spawned by the STEP worker); `stepWorker-*.js` 10.72 is now the file reader, the
  // zip inflater, the STEP splitter and the pool; `stepReader-*.js` 0.76.
  step: { gzip: 3144.41 * 1000 },
  // 2026-10-01: NEW (robot import, rendering lane). `library-*.js` 1.85: the device library behind
  // `importedAssets`' dynamic import; the rest of that lane is +5.60 in `main` (the 2D sprites'
  // import branches, the asset seam, FootprintSvg) and +2.86 in `scene` (`renderImported.ts`),
  // both inside tolerance against the robot-import branch measured the same minute.
  // 2026-10-01: 1.85 -> 2.26: the visuals relay's client reads it too, so `meshLiteFor` and `putMeshLite`
  // are in the shared chunk.
  library: { gzip: 2.26 * 1000 },
  // 2026-10-01: NEW. `visualCheck-*.js`, the relay's PNG and GLB validators, behind `importVisualsClient.ts`'s
  // dynamic import (prefetched when a look is asked for or an upload starts). They were in `main` (~3.3 KB
  // of the entry chunk) until this build; the room and the LAN host worker still carry their own copy.
  relay: { gzip: 3.35 * 1000 },
  // 2026-10-01: NEW, the importer's UI (lane 4). `ImportEditor-*.js` 18.75 (the steps, the top-down
  // editor, the preview host, drafts, the review checks), and what the robot page `import()`s on a
  // click: `shareFile-*.js` 1.38, `LibraryDialogs-*.js` 0.75 and `exportRobot-*.js` 0.66. Fetched
  // when a player opens the importer or acts on an imported robot. What the robot page itself
  // carries for imports (the row, the panel, the notice, the test-drive and lobby wiring) is in
  // `main`: +4.53 KB against the feature branch at 5d0e6aa5 (1017.05 -> 1021.58).
  // 2026-10-01: 21.55 -> 24.18 (+2.63): `ImportEditor-*.js` now carries the placement checks
  // (`games/importMechChecks.ts`, the three games' `importChecks.ts` and the shared helpers), which were in
  // `main` as a `GameSimModule` slot and are reached only by the editor. Then +0.53 (lane 9): the
  // editor's two-half measuring (the pending state, the Measuring… notice) and Cancel stopping the
  // import's workers.
  // 2026-10-02: 24.71 -> 28.96, raised on purpose. `ImportEditor-*.js` 26.16: the Moving parts panel
  // and its picking (+3.3) and the rectangle wheel layout with its four fields and snapping (+0.9).
  // 2026-10-04: 28.96 -> 33.14, raised on purpose. The base (alpha 239caa2e) already measured 32.32
  // inside the tolerance (practice tuning, the Detail choice, the generic joints); +0.82 is the
  // Moving parts step of its own (`MotionPanel` rows, Find again, the preview legend).
  importerui: { gzip: 33.14 * 1000 },
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
