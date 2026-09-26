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
  if (/^Gallery-[^/]*\.js$/.test(base)) return 'gallery';
  // ZENITH AUTOS (docs/area/autos.md): `@horizon36596/zenith-core` + `-schema` (with zod) and
  // DSIM's auto seat, behind `src/auto/zenithAutos.ts` — a facade named so this chunk is NOT
  // `index-*` (the lazy entry was `src/auto/index.ts` once, and its chunk was then billed as
  // main). Loaded only when a solo run plays an auto, or the Autonomous panel opens.
  if (/^zenithAutos-[^/]*\.js$/.test(base)) return 'autos';
  // The admin console's chunks, by FILENAME like the three above — Vite names a lazy chunk
  // after its facade module, so `Admin-*.js` and `AdminAnalytics-*.js` are what it emits, and
  // neither renders anything a content marker would recognise. Before the content scans,
  // because the console imports the SEASONS registry and the standing model and a future
  // marker could otherwise claim it.
  if (/^Admin[A-Za-z]*-[^/]*\.js$/.test(base)) return 'admin';
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
 * RECALIBRATE by running `npm run build && npm run bundleaudit` and copying the printed gzip
 * totals in here, the same way `uiaudit.mjs`'s header describes lowering ITS baseline.
 */
const BASELINE = {
  main: { gzip: 963.55 * 1000 },
  // `@discord/embedded-app-sdk` behind `watchDiscordParticipants`'s dynamic import —
  // loaded only inside a real Discord Activity embed (`onDiscordHost()` gates the
  // import), so no ordinary player downloads it. MEASURED 2026-09-18.
  discord: { gzip: 44.30 * 1000 },
  // 2026-09-25: 720.96 -> 778.01 (+57.05), MEASURED. The LAN host runs `server/room.ts` in a
  // tab, and a custom room now plays Zenith autos (docs/area/autos.md), so the room statically
  // imports the auto seat and with it Zenith's planner and follower (the `autos` chunk's content,
  // 55.75 KB). Only a player HOSTING a LAN room downloads this worker; nobody else pays for it.
  hostWorker: { gzip: 778.01 * 1000 },
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
  scene: { gzip: 221.06 * 1000, budgetCeiling: 250 * 1000 },
  // 2026-09-21, THE EIGHT PAINTED ENVIRONMENTS: 4.01 -> 5.56 (+1.55), well inside the 4 KB
  // tolerance, so the number below is deliberately NOT moved — recorded here for the same reason
  // the `scene` note above records its own under-tolerance creep. The growth is DATA:
  // `graphics/environments.ts` gained a light rig and a painted-dome recipe per entry, and eight
  // entries. It is the cheap half of the trade — the alternative was eight more 1.6 MB HDRIs,
  // which would have cost this route nothing and the PLAYER 13 MB. The PAINTING lives in
  // `scene/renderEnvironment.ts` and lands in the `scene` route, which did not move (216.61 ->
  // 216.60): a few hundred bytes of canvas calls against a 217 KB chunk.
  graphics: { gzip: 4.01 * 1000 },
  gallery: { gzip: 7.33 * 1000 },
  // 2026-09-24: the Zenith autos chunk, MEASURED on the build that introduced it — Zenith's
  // planner, follower and schema (zod) plus `src/auto/`. Lazy: see the `autos` route.
  // 51.97 -> 55.77 (+3.80) the same day: the headless runner (`runAutoHeadless`, "Simulate in
  // DSIM" and "Drive it here") and the preview projection (`view.ts`) joined the chunk. Measured
  // rather than left to creep under the 4 KB tolerance. The UI that opens it (Autonomous section,
  // `zenithHost.ts`, the HUD line) is in main: +5.15 KB against alpha @ c4afe65's 973.24.
  autos: { gzip: 55.77 * 1000 },
  // 2026-09-19: NEW. The whole admin console, lazily loaded by `App.tsx`. See the route note
  // above and the RE-MEASURED entry below for what moved out of `main` to create it.
  // 2026-09-25: 25.10 -> 29.75, raised on purpose: the Access and Banners tabs, the lockdown
  // scope controls, and the analytics page's sponsor report and imported-history section. Admin
  // only, so no player downloads it.
  admin: { gzip: 29.75 * 1000 },
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
