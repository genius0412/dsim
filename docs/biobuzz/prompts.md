# BIOBUZZ chat prompts (plan approved 2026-09-09)

> **BRANCH CHANGE (2026-09-12):** the shared base is **`alpha`**. `biobuzz` was merged into
> `alpha` and deleted on origin. Wherever this file says branch `biobuzz`, read `alpha`: merge
> `alpha` before you commit, land into `alpha`, `alpha` deploys.

Paste each block into its own chat. Worktrees already exist on the requester's machine
(`git worktree list` from any checkout shows them). Integration (merging lanes → `biobuzz`,
merging `origin/alpha` → `biobuzz`) stays in the planning chat, which is the ONLY Fable 5.1
chat before kickoff. Fable is spent on REVIEW, not on typing: (1) the P0 diff before it merges
into `biobuzz`, (2) the solver comparison + the human's verdict, (3) the perf-load capacity
numbers before any server behaviour changes. Escalate a working chat to Fable only if it is
stuck on one physics behaviour for more than two feedback rounds, or if the kickoff robot
rules (R105) turn out unusual. The `biobuzz` branch is PUBLIC on `origin` (agreed with the
owner 2026-09-10); the season stays hidden by `channels: ['alpha']`. Lane branches push to
`origin` too. **Physics belongs to the owner** — POLLEN rides the shared `solveArtifacts`;
no chat tunes a ball constant, it writes the observation into HANDOFF for him.

| chat | model | worktree | branch | start |
|---|---|---|---|---|
| P0-core | Opus 5 | `C:\Users\saket\Desktop\saket\FTC\Claude Projects\dsim-bb-core` | `biobuzz-core` (off `biobuzz`) | now |
| P0-shell | Opus 5 | `…\dsim-bb-shell` | `biobuzz-shell` (off `biobuzz`) | now, in parallel |
| P0.5-sandbox | Opus 5 | `…\dsim-bb-sandbox` | `biobuzz-sandbox` | after core + shell are merged into `biobuzz` |
| perf-load | Opus 5 | `…\dsim-bb-load` | `perf-load` (off `origin/alpha`) | now, independent |
| Lane A / Lane B | Fable / Opus | `…\dsim-bb-field`, `…\dsim-bb-robot` | `biobuzz-field`, `biobuzz-robot` | kickoff T0 |

---

## P0-core — Opus 5

You are working in the DSIM repo (2D FTC driver-practice simulator: Vite + React + TS client,
Node/ws authoritative server, shared deterministic sim). Worktree:
`C:\Users\saket\Desktop\saket\FTC\Claude Projects\dsim-bb-core`, branch `biobuzz-core`,
which was cut from `biobuzz` (itself cut from `origin/alpha`). Work ONLY in that worktree;
never touch `alpha`, `main`, or another worktree. Commit after each numbered item
(Conventional Commits). Push only your own branch (`git push -u origin biobuzz-core`).

Read first, in order: `CLAUDE.md` (all of it — it is the contract), the top section of
`HANDOFF.md`, `docs/biobuzz-plan.md`, `docs/biobuzz-contract.md`, then
`src/games/types.ts`, `src/games/module.ts`, `src/games/index.ts`, `src/games/sim.ts`,
`src/seasons.ts`, `src/settings.ts`, `src/net/sanitize.ts`.

Your job is Phase 0 items 1–6 and 8 of the plan: make the shared core GAME-AGNOSTIC so a
third `GameId` (`'biobuzz'`) is a registry entry plus a module directory, with no two-valued
literals left anywhere. `decode` and `chain` behaviour must be byte-identical — this is a
refactor, not a feature. A parallel chat (P0-shell) is building the `src/games/biobuzz/`
module; you own everything OUTSIDE that directory, it owns everything inside it. You create
only a placeholder there (item 7).

Before you edit anything: run `npm test` on the untouched worktree and record the names of
every failing check in `docs/biobuzz/baseline-alpha.md` with the `alpha` SHA. That list is
the gate — "no NEW failures".

1. `src/games/types.ts`: add `'biobuzz'` to `GameId`; export `GAME_IDS: readonly GameId[]`,
   `isGameId(x: unknown): x is GameId`, `coerceGameId(x: unknown, fallback: GameId =
   'decode'): GameId`. Add `initialAct: number` and `startPoseCount: number` to
   `GameSimModule` (decode `0` / `START_POSES.length`; chain `1` / `CHAIN_START_POSES.length`).
2. Replace every `=== 'chain' ? 'chain' : 'decode'`, `'decode' | 'chain'` allowlist, and
   `(decode|chain)` regex with `coerceGameId` / `GAME_IDS` / `isGameId`. Known sites (grep
   yourself — there are more): `server/index.ts` (~6), `server/api.ts` (~5),
   `server/db/repo.ts` (~3), `server/persist.ts` (`ensureSeason(..., game === 'chain' ? 1 :
   0)` → `simModuleFor(game).initialAct`), `src/net/api.ts` (`gameParam` + 4), `src/settings.ts`
   (allowlist, `switchGame` loadout loop, start-index clamp), `src/ui/App.tsx` (both route
   regexes, built from `GAME_IDS`), `src/ui/startPositions.ts`. The server keeps importing
   only `src/games/sim.ts` / `types.ts` (no DOM). Grep proof at the end:
   `grep -rn "'chain' : 'decode'\|(decode|chain)\|'decode' | 'chain'" src server scripts`
   returns nothing outside `src/games/chain/` and comments.
3. Per-game start-index clamp: `coerceStartIndex` (`src/net/sanitize.ts`) and `coerceSetup`
   (`src/sim/spawn.ts`) clamp to `simModuleFor(game).startPoseCount`, not `START_POSES.length`.
   Thread `game` where it is missing. Smoke checks: CR keeps index 3; DECODE keeps 4; an
   unknown game clamps as decode.
4. `src/seasons.ts`: `Season.channels?: readonly ('stable' | 'alpha')[]` (absent = all),
   plus `visibleSeasons()` / `visibleGames()` reading the client channel from
   `src/net/env.ts` (`VITE_APP_CHANNEL`, default `stable`). Use them in `HomeMenu`,
   `QueueCounts`, `App.tsx` `parsePath` (a hidden game's URL prefix on a stable build falls
   back to the saved game), `src/seo.ts`, and wherever `robots.txt` / `sitemap.xml` route
   lists come from. If those are static files, say so in HANDOFF and add a smoke check that
   every VISIBLE season's routes are listed. `env.ts` reads `import.meta.env` at load and
   cannot be imported by headless smoke — put the channel→visibility rule in a leaf module
   and test THAT, the way `roomJoinRegion` is split out.
5. `src/games/module.ts`: OPTIONAL UI slots on `GameModule` — `Builder`, `Preview`,
   `hudChips`, `resultsRows`, `scoreBar`, `mobileButtons`, `startEditor`,
   `labels.configSummary`, and `devRoutes?: { path: string; Component }[]` (the gallery
   will mount through this; alpha channel only). On the DOM-free side,
   `GameSimModule.hud?(world, robotId): unknown` → `HudSnapshot.gameHud` in `game.ts`. Wire
   each slot at its consumer (`Menu.tsx`, `MatchStrategy.tsx`, `GameView.tsx`,
   `MobileControls.tsx`, the start-editor pick in `MatchSetup`/`Lobby`/`MatchStrategy`,
   `Leaderboard`/`robotLabels`, `App.tsx` routing for `devRoutes`) as
   `mod.X ? <slot> : <existing branch, unchanged>`. Do NOT refactor the decode/chain inline
   branches. Leave the dead `GameUiSpec` fields alone.
6. `package.json`: `"test": "tsx scripts/smoke.ts && tsx scripts/smoke-biobuzz/index.ts"`.
   Create `scripts/smoke-biobuzz/{harness.ts,index.ts,field.ts,robot.ts}` with the same
   `check()`/`failures`/`process.exit` shape as `scripts/smoke.ts` lines ~255–300; `await
   initPhysics()` first; `field.ts`/`robot.ts` may hold one check each until P0-shell fills them.
7. Placeholder module so the registries compile: `src/games/biobuzz/{sim.ts,index.ts,state.ts}`
   — `scored: false`, `startLegality: false`, `initialAct: 2`, `startPoseCount: 2`, a 72×72
   four-wall collider, `createWorld`/`step` that spawn robots and step the shared drivetrain
   only. Register in BOTH registries. `SEASONS` entry: `key: 'biobuzz'`, name `BIOBUZZ`,
   presenter `RTX`, program `FIRST Tech Challenge`, years `2026–27`, blurb `Rules land at
   kickoff on 2026-09-12.`, `playable: true`, `channels: ['alpha']`. `World.biobuzz?:
   BiobuzzState` (empty interface for now). Smoke: registry integrity for all three ids;
   `coerceGameId` round-trips; hidden season absent from `visibleGames()` on `stable`.
   P0-shell will REPLACE these three files — keep them minimal and say so in a comment.
8. CLAUDE.md: `biobuzz` row in the game table; a `# GAME: BIOBUZZ (`biobuzz`)` section stub
   pointing at `docs/biobuzz-contract.md`; under the seam section, an "Adding a game" list
   of the now-four registrations (two registries, `SEASONS`, `GAME_IDS`) and the slots.
   HANDOFF.md: prepend a dated section (state, what landed, the baseline list, gotchas).

Gates before you report done: `npm run build`, `npm run server:check`, `npm run uiaudit`,
`npm run contrast` green; `npm test` no new failures vs your baseline file; the grep proof
above; `npm run dev` with `VITE_APP_CHANNEL=alpha` shows BIOBUZZ on the home picker and
`/biobuzz` loads; with `stable` it does not appear and `/biobuzz` falls back. Ask me
anything blocking NOW, before starting; otherwise work to the end and report.

---

## P0-shell — Opus 5

You are working in the DSIM repo, worktree
`C:\Users\saket\Desktop\saket\FTC\Claude Projects\dsim-bb-shell`, branch `biobuzz-shell`
(cut from `biobuzz`, which is cut from `origin/alpha`). Work only there; never touch
`alpha`/`main`/other worktrees; commit per item; push only your own branch.

Read first: `CLAUDE.md` (all), `docs/biobuzz-plan.md`, `docs/biobuzz-contract.md`, then
EVERY file in `src/games/chain/` (the worked example of a second game), `scripts/shiftaudit.cjs`
(the Electron screenshot pattern), and `.claude/skills/verify/SKILL.md`.

Your job is plan items 7, 9 and 10: a playable, unscored BIOBUZZ SHELL in
`src/games/biobuzz/` built by COPY-AND-OWN from Chain Reaction, the manual tooling, and the
visual-feedback infrastructure (scenes, gallery, shots). A parallel chat (P0-core) owns
everything OUTSIDE `src/games/biobuzz/` and `scripts/smoke-biobuzz/` — registries,
`GameModule` slots, `SEASONS`, `types.ts` `GameId`. Start with the items that need nothing
from it (1, 2, 4); when it reports done, `git merge biobuzz` (integration will have merged
core in) and then do 3, 5, 6, 7.

1. `scripts/manual.mjs` (Node stdlib; `pdftotext` is on PATH here, `pdfimages` is not):
   `node scripts/manual.mjs [url-or-manual-number] [outdir]` downloads the PDF, writes
   `<name>.txt` via `pdftotext -layout` AND `<name>.glossary.txt` via plain `pdftotext`
   (two-column glossary interleaves under `-layout`), dumps figures as PNG when `pdfimages`
   exists, and prints the page count + a table of "Section N" page numbers. Default URL
   `https://ftc-resources.firstinspires.org/ftc/game/manual`. Default outdir `scratch/manual/`
   — add `scratch/` to `.gitignore`. Test it on the current (pre-season) manual.
2. Copy-and-own into `src/games/biobuzz/`, renaming `Chain`→`Biobuzz`, `CHAIN_`→`BB_`,
   `chain`→`biobuzz`, and DELETING everything catalyst / hook / accelerator / ring-stand /
   beam / lab-area / ground-clearance specific:
   - `config.ts` — field walls, `mm()`, particle physics constants, robot dial constants,
     presets. Every guessed number carries an `APPROX` comment.
   - `state.ts` — the `BiobuzzState` from the contract §2 + `emptyBiobuzzState()`.
   - `colliders.ts` — four walls + `bounds`.
   - `spawn.ts` — robots via `coerceSpec(…, 'biobuzz')`; a deterministic scatter of 60
     placeholder POLLEN (3 in) off `world.rngState`; two start anchors per alliance,
     canonical BLUE and x-mirrored RED. It MUST run the shared `coerceSetup` sanitizing
     (startIndex/startPose/autoPath) or replicate it — CR skips it, known gap, do not copy.
   - `step.ts` — CR's pipeline minus CR gameplay: commands → aim hook → drivetrain →
     Rapier + wall square-up → `updateBiobuzz` → penalties stub → phase machine. Keep the
     exact order as a numbered comment block; Lane A owns it later.
   - `play.ts` — pollen ground integrator + spatial-hash separation + wall bounce ONLY,
     behind a `BB_BALL_SOLVER: 'bespoke' | 'rapier'` switch in `config.ts` whose `rapier`
     arm calls the shared `solveBalls` path DECODE uses (P0.5 will pick one; build both,
     both must conserve count and stay in bounds).
   - `elements.ts` — the contract §3 functions as shell stubs: `pollenIn` (real),
     `capturePollen` (real: ground → hopper, cap-checked), `releasePollen` (lob with the
     given velocity, no target), `scoreTargets` → `[]`, `evalStart` → legal, `actOnElement`
     → false.
   - `robot.ts` / `mounts.ts` / `robotConfig.ts` / `parts.ts` / `drawRobot.ts` /
     `RobotPreview.tsx` — sweeper intake on any edge + the turret / twinturret / drum /
     dumper launcher family renamed to the contract §4 exports (`bbMouths`, `bbFootprint`,
     `bbHopperCap`, `bbAimHeading`, `bbLaunch`); catalyst code removed; `mounts.ts` stays a
     LEAF (imports only `../../types`).
   - `drawField.ts` (mat, walls, centre mark), `draw.ts` (pollen), `labels.ts`,
     `penalties.ts` (empty engine with the edge-trigger scaffold), `hud.ts` / `hudRobot.ts`
     → `{ field: { scored }, robot: { hopper, cap, mode } }`, `Builder.tsx` (shared dials +
     archetype/mount pickers) for the `GameModule.Builder` slot.
   User-visible word for the element is POLLEN, never ball/particle/artifact.
3. Replace P0-core's placeholder `sim.ts` / `index.ts` / `state.ts` with the real module:
   `scored: false`, `startLegality: false`, `initialAct: 2`, `startPoseCount: 2`, every UI
   slot filled, `devRoutes` = the gallery (item 5).
4. `src/games/biobuzz/scenes.ts` + `scenesField.ts` + `scenesRobot.ts` (plan item 10):
   `Scene = { id, title, lane, build(seed): World, script?(world, tick): Record<robotId,
   RobotCommand>, stills: number[] }`, DOM-free. Ship these scenes: `field-empty`,
   `field-labelled` (zones drawn with names), `spawn-default`, `pile-slow/med/fast` (robot
   drives into a 12-pollen pile at 20/50/80 in/s), `wall-row-sweep`, `corner-pile`,
   `pin-wall` (one pollen pinned, robot keeps driving), `squeeze-2robots`, `intake-line`,
   `launch-wall-bounce`, `settle-60`, and `archetype-<mode>-<mount>` sheets for every
   archetype × mount at 12/15/18 in chassis (preview + in-match sprite side by side).
   `smoke-biobuzz` steps every scene to its last still and asserts a stable hash.
5. `src/games/biobuzz/Gallery.tsx` at `/biobuzz/gallery` (through `devRoutes`, alpha channel
   only): a grid of canvases drawn with the REAL module `drawField`/`drawRobot`/`drawBalls`
   — one cell per scene per still, plus the archetype sheets. Cell caption = `<scene>@<tick>`.
   Click → `/biobuzz/gallery/<scene>`: the ordinary game view running that scene, drivable.
   No gallery-only drawing code, ever. Use existing `ds-*` classes (`docs/ui-standard.md`);
   `npm run uiaudit` must stay green.
6. `scripts/shots.cjs` (Electron, `shiftaudit.cjs` pattern; needs a build + `npx vite
   preview --port 4173`): loads the gallery, screenshots every cell (or `--scene a,b`) into
   `scratch/shots/<short-sha>/<cell>.<theme>.png`, both themes, and writes an `index.html`
   contact sheet beside them. Then RUN it, Read the PNGs yourself, and fix what looks wrong
   before anyone else sees it. Document the recipe in `.claude/skills/verify/SKILL.md`.
7. `scripts/smoke-biobuzz/field.ts` + `robot.ts`: registry integrity; 4 walls; a robot
   driven at each wall for 3 s stays inside `bounds`; pollen count conserved over 600 ticks
   under BOTH solvers; same seed twice ⇒ identical `worldHash`; `coerceSpec(spec,'biobuzz')`
   idempotent and clamps every `bb*` field; `slimWorld`/`unslimWorld` preserves `game` and
   `world.biobuzz`; `switchGame` isolates the biobuzz loadout; a server `Room` runs a
   headless BIOBUZZ match to `post` (template: the last block of `scripts/smoke.ts`); the
   intake captures a pollen it drives over; `releasePollen` conserves count; a 2v2 BIOBUZZ
   room's mean step time ≤ 1.2× a 2v2 CR room's, measured in the same run.

Gates: `npm test` (no new failures vs `docs/biobuzz/baseline-alpha.md`), `npm run build`,
`npm run server:check`, `npm run uiaudit`, `npm run contrast`; `shots.cjs` output Read and
described in `docs/biobuzz/HANDOFF-shell.md` with the cells I should look at. Ask blocking
questions NOW; otherwise work to the end and report.

---

## P0.5-sandbox — Opus 5 (start after core + shell are merged into `biobuzz`)

You are working in the DSIM repo, worktree
`C:\Users\saket\Desktop\saket\FTC\Claude Projects\dsim-bb-sandbox`, branch `biobuzz-sandbox`
off `biobuzz`. Push only your own branch. Read `CLAUDE.md` (Shared core → Physics, and both GAME
sections' ball/particle parts), `docs/biobuzz-plan.md` §Phase 0.5, `docs/biobuzz-contract.md`,
`src/games/biobuzz/{config,play,elements,scenesField}.ts`, `src/sim/physicsEngine.ts`
(`solveBalls`, `ballRobotFeedback`, `clampBallPosToStatics`), `src/games/chain/play.ts`
(`separateParticles`), `.claude/skills/verify/SKILL.md` (the `shots.cjs` recipe).

Goal: make POLLEN (3 in balls, ~60–300 on the field) FEEL RIGHT against robots, walls and
each other BEFORE the rules exist — this is the one piece of BIOBUZZ known in advance, and
it is the work I most need to see with my own eyes. I am your test driver. The loop is:

1. Run `scripts/shots.cjs` on the physics scene set (`pile-*`, `wall-row-sweep`,
   `corner-pile`, `pin-wall`, `squeeze-2robots`, `intake-line`, `launch-wall-bounce`,
   `settle-60`) under BOTH `BB_BALL_SOLVER` values; Read every PNG; write a one-page
   comparison in `docs/biobuzz/feedback/000-solver-compare.md` (what each solver does per
   scene, in plain words, with the cells to look at) and STOP for my verdict on which
   solver to keep. Delete the loser the same day; the switch goes away.
2. Then iterate: I play `/biobuzz/gallery/<scene>` in the dev server (`npm run dev`,
   `VITE_APP_CHANNEL=alpha`) and write `docs/biobuzz/feedback/<nnn>-physics.md`. You read
   the newest unprocessed dump, change constants in `src/games/biobuzz/config.ts` (never in
   `src/sim/` or `src/config.ts` — those move DECODE), re-shoot, Read the PNGs, and append
   `## Response <sha>` to my file: what changed, which cells to re-check, what you could not
   do and why. Every accepted behaviour gets a smoke check in `scripts/smoke-biobuzz/field.ts`
   (containment, conservation, no-overlap, stall-on-pin, settle time, no jitter against a
   wall — the DECODE "artifacts do not jitter against the classifier" check is the model).
3. Exit when I write a dump titled `signoff`. Then freeze: a comment block at the top of
   the pollen constants saying they are signed off and that Lane A adds element behaviour
   on top and never retunes the base.

Two facts from the integration you must build into step 1: (a) the `'rapier'` arm calls the
shared `solveArtifacts`, which HARD-CODES DECODE's 2.5 in artifact radius for the collider, the
speed cap and the held-artifact circles — POLLEN is 1.5 in, so that arm settles a pile looser
than it is drawn; if the human picks `rapier`, the follow-up is parameterizing that radius in
`src/sim/physicsEngine.ts` (a shared-core change — write it up in HANDOFF for the integration
chat, do not make it yourself). (b) `scripts/shots.cjs` defaults to port 4173 and a STALE
`vite preview` from another worktree may already own it — check `netstat -ano | findstr 4173`
first and pass the port `vite preview` actually reports, or you will photograph the wrong bundle.

Things I already know I care about: a pile must not explode or interpenetrate when a
robot drives through it at full speed; a ball pinned dead-centre against a wall must stall
the robot rather than tunnel; off-centre pinned balls squirt sideways; a corner pile must
settle and stay settled; rolling friction should look like a plastic ball on foam tile, not
an ice puck; two robots squeezing a ball must not launch it. Ask blocking questions NOW;
otherwise do step 1 and stop.

---

## perf-load — Opus 5 (independent track, start now)

You are working in the DSIM repo (2D FTC driver-practice sim: Vite/React client on Vercel,
Node + `ws` authoritative game server on Fly, Neon Postgres). Worktree:
`C:\Users\saket\Desktop\saket\FTC\Claude Projects\dsim-bb-load`, branch `perf-load` off
`origin/alpha`. Work only there. Commit per step. Do not push, do not deploy — the owner
runs `./scripts/fly-deploy.sh`; a bare `flyctl deploy` is forbidden (it re-sizes every
machine, see `fly.toml`).

Read first: `CLAUDE.md` (Netcode + Accounts sections and the Commands list), `docs/deploy.md`,
`docs/netcodeplan.md`, `fly.toml`, `fly.alpha.toml`, `Dockerfile`, `scripts/fly-deploy.sh`,
`server/index.ts` (the `/api/perf` probe ~line 288 and ~1275, the presence heartbeat ~104,
`/api/presence` ~326), `server/room.ts` (`SNAPSHOT_INTERVAL`, `RECONNECT_GRACE_MS`, the tick
loop ~1272), `server/matchmaking.ts`, `server/regions.ts` (`DEPLOY_REGIONS`), `server/db/pool.ts`
(`DB_POOL_MAX` default 5), `src/net/{protocol,transport,serverSession,lobbyClient,env}.ts`,
`src/game.ts` (`stepServer`, `reconcile`, interpolation), `scripts/probe-thru.ts`,
`scripts/probe-sm.ts`.

Situation: a new FTC season (BIOBUZZ) kicks off 2026-09-12 and we expect **more than 10× the
previous peak concurrent population** on launch weekend, mostly students in the US with a
long tail worldwide. Today: ONE Fly app (`dohun-sim-decode`) in `iad` (shared-cpu-4x, always
warm, also the matchmaker) + `sjc`/`lhr`/`syd`/`nrt` satellites (shared-cpu-1x, idle-to-zero,
auto-start, ~7 s cold boot because the server runs through `tsx`); one machine per region on
purpose (room codes route by region, two machines in one region would split a room); rooms
step 60 Hz Rapier at ~0.02–0.03 cores each (~33–55 rooms/core measured); 30 Hz JSON delta
snapshots; `/api/perf` reports event-loop lag percentiles; DB writes happen at match end
off the hot path; presence is a per-machine heartbeat row aggregated by `/api/presence`.
The alpha preview app (`dsim-alpha`, `fly.alpha.toml`) is the place to test.

Goal: know, with numbers, how many concurrent players each machine size holds at acceptable
latency, remove the cliffs before launch, and hand me a human test plan for the parts only
real clients can validate. Everything must stay protocol-backward-compatible (one app serves
every client version; `CLIENT_CAPS`/`SERVER_CAPS` feature-gating is the mechanism).

Steps:

1. **Ask me for the numbers you cannot derive**: previous peak concurrent players and rooms
   (Fly metrics / `/api/presence` history / the owner), current Fly plan limits, Neon plan
   limits, whether the owner will accept an always-on cost increase for launch week, and
   whether the target is 10× rooms, 10× sockets, or both. Then proceed on stated
   assumptions if I am slow.
2. **Load harness** `scripts/loadtest.ts`: N headless clients speaking the REAL protocol
   (`src/net/protocol.ts`, `localizeCommand`), joining M rooms (1v1/2v2 mix, DECODE + CR),
   sending inputs at 60 Hz, measuring per client: snapshot inter-arrival p50/p99 and jitter,
   RTT via `ping`/`pong`, reconcile distance, disconnects. Runs against `npm run server`
   locally first, then against `dsim-alpha` when the owner has deployed. Output a table +
   JSON. Also drive the matchmaker path (`queue`) and the room-code path separately.
3. **Capacity model**: sweep rooms per machine on the local server to find where `/api/perf`
   p99 approaches the 16.67 ms budget and where snapshot jitter degrades; state rooms/core
   and sockets/core for shared-cpu-1x/2x/4x/8x and performance-1x by extrapolation from the
   measured slope. Write `docs/capacity.md`. **STOP here and report** — the numbers get
   reviewed before any server behaviour changes.
4. **Fix the cliffs you find**, in likely order of value; each one a separate commit with a
   before/after number: (a) cold boot — precompile the server (`tsc` → `node dist/…`, or
   `tsx` with a warm build cache) so an auto-started satellite answers in <1 s, and check
   the health-check grace still fits; (b) admission control — a machine near its room
   budget refuses new rooms with a typed `ServerMsg` the client renders as "region busy,
   try <other region>" instead of degrading everyone; the matchmaker routes to the
   least-loaded viable region; (c) Fly scaling — per-region `min_machines_running` for
   launch week and whether a second machine per region is possible without breaking
   room-code routing (design it, do not assume); (d) snapshot cost — measure bytes/s per
   client; if JSON is the bottleneck, add an opt-in compact encoding gated by `CLIENT_CAPS`
   (older clients keep JSON); (e) DB — pool sizing (`DB_POOL_MAX`), the match-end write
   burst, presence heartbeat write rate × machines, Neon connection limits; (f) version gate
   + Vercel — the client is static and fine, but the forced-refresh-on-new-build path can
   stampede reconnects: confirm it is rate-safe; (g) reconnect storms — `RECONNECT_GRACE_MS`
   and `RANKED_JOIN_GRACE_MS` behaviour when a whole region restarts.
5. **Client-side**: the connection-quality HUD already shows SMOOTH/OK/CHOPPY off jitter;
   add a "server full / region busy" state and a visible region picker fallback if not
   present. `npm run uiaudit` green.
6. **Human test plan** `docs/launch-load-test.md`: what I and the owner run, from where
   (home ISP, phone hotspot, school Wi-Fi, one tester per satellite region if we can get
   them), what to watch (`/api/perf`, `fly logs`, the HUD dot, `/api/presence`), pass/fail
   thresholds, and the rollback (which `fly scale` commands). Include the loadtest command
   lines to run against `dsim-alpha` while humans play, so the human test happens under
   synthetic background load.
7. Tests: `npm test`, `npm run test:mm`, `npm run dbtest`, `npm run server:check`,
   `npm run build` all green (or no new failures vs `alpha`, which is currently red on some
   DECODE physics checks — record the baseline first). New matchmaker behaviour gets
   `mmsmoke` checks. HANDOFF.md gets a dated section; `docs/deploy.md` gets the new sizing
   guidance.

Ask your blocking questions NOW (step 1). Then build the harness and the capacity model
before touching any server behaviour — measure first, the repo's own history says every
un-measured Fly change here flapped.

---

## Lane A — FIELD (kickoff day, Fable 5.1) — finalize morning of T0

Worktree `…\dsim-bb-field`, branch `biobuzz-field` off `biobuzz`. Read `CLAUDE.md`,
`docs/biobuzz-plan.md` §Kickoff day, `docs/biobuzz-contract.md` (you are Lane A),
`docs/decode-reference.md` (the format to match), `src/games/biobuzz/**`, the `shots.cjs`
recipe in `.claude/skills/verify/SKILL.md`, and `docs/biobuzz/feedback/T0-field.md` (my
information dump: manual text, figures, first impressions). Step 1 (T0): write
`docs/biobuzz-reference.md` (match structure, scoring table, element table, field map in the
sim frame — origin centre, +x audience right, +y away, inches; measure figures, cite pages)
and DRAW THE FIELD FIRST: `field-labelled` cell with every zone and element named, shot and
Read, before implementing any rule. Stop for my verdict on that cell. Step 2 (T0+2h, with
Lane B and me): finalize `elements.ts` signatures and `BiobuzzState`. Step 3: constants →
colliders (cell: robot resting on each solid) → spawn → element scenes (one per element) →
scoring → penalties → start legality → field HUD; one smoke check per behaviour in
`scripts/smoke-biobuzz/field.ts`, one scene per interaction in `scenesField.ts`; a
`shots.cjs` run and a "look at cells X, Y" line in `docs/biobuzz/HANDOFF-field.md` every
~90 min or every landed behaviour. Read my feedback dumps at the start of every iteration
and answer below `## Response <sha>`. Physics (a moving element, a ramp, anything not a
rolling ball) gets its own scene set and my sign-off before it is built on. The pollen base
constants are signed off — never retune them. Never edit files owned by Lane B or by
integration.

## Lane B — ROBOT (kickoff day, Opus 5) — finalize morning of T0

Worktree `…\dsim-bb-robot`, branch `biobuzz-robot` off `biobuzz`. Read `CLAUDE.md` (Robot
spec + Chain Reaction robot/mount/storage sections), `docs/biobuzz-plan.md` §Kickoff day,
`docs/biobuzz-contract.md` (you are Lane B), `src/games/biobuzz/{robot,mounts,robotConfig,
Builder,RobotPreview,drawRobot,scenesRobot}.*`, `src/sim/spawn.ts` `coerceSpec`, the
`shots.cjs` recipe, and `docs/biobuzz/feedback/T0-robot.md` (my dump: robot rules, R105
expansion envelope, the four vendors' StarterBot mechanisms). Step 1 (T0): write the
archetype list + dial table into the contract §4 and DRAW THE ARCHETYPES FIRST: one gallery
cell per archetype × mount at 12/15/18 in, preview beside in-match sprite, shot and Read.
Stop for my verdict. Step 2 (T0+2h sync). Step 3: `RobotSpec.bb*` + `coerceSpec` clamps +
sanitize → `robot.ts` geometry (the drawn mouth IS the capture area — one geometry) →
mounts → ranges/presets → mechanism scenes (each archetype captures; each releases/launches)
→ Builder → labels → robot HUD chips → controls; one smoke check per behaviour in
`scripts/smoke-biobuzz/robot.ts`, one scene per mechanism in `scenesRobot.ts`; shots + a
"look at cells" line in `docs/biobuzz/HANDOFF-robot.md` every ~90 min. A new button: write
the `BTN_*` request in your handoff, do not edit `protocol.ts`. A mechanism with real
dynamics (an arm that swings, a flywheel that stores energy): stop and say so — it moves to
the Fable lane. Never edit files owned by Lane A or by integration.

---

# Field assembly — 2026-09-12 afternoon (manual V1 read, plan in `docs/biobuzz/field-plan.md`)

Goal of this wave: **something visual, fast.** Three Lane-A chats on disjoint files, one
integration step first, one relay line for Lane B. Facts come from `docs/biobuzz-reference.md`;
design from `docs/biobuzz/field-plan.md`; both land on `biobuzz` in step 0. Every chat:
subagents for reconnaissance and for parallel file edits, main thread for the shape decisions
and for the shot + Read. Run `npm run test:bb -- --lane field` only, never the full `npm test`,
until the last commit of the chat.

| step | chat | model | files | starts |
|---|---|---|---|---|
| 0 | integration (master chat) | Fable 5.1 | `docs/*`, `src/types.ts` | done 2026-09-12 (eccf132, 424746a, types commit) |
| A1 | field-art | Opus 5 | `config.ts` (field block), `state.ts`, `drawField.ts`, `scenesField.ts` (`field-labelled` only) | after step 0 |
| A2 | solids + staging | Opus 5 | `colliders.ts`, `spawn.ts`, `elements.ts` (staging), `draw.ts`, `smoke-biobuzz/field.ts`, new scenes appended to `scenesField.ts` | after A1's first commit (constants) |
| A3 | hive + flower behaviour | Fable 5.1 (Opus if limits are tight) | `hive.ts`, `flower.ts`, `play.ts` stage 6, `step.ts`, `hud.ts`, `penalties.ts` G410 | after the `field-labelled` verdict |
| B | Lane B relay | (paste into the robot chat) | — | now |

## Step 0 — integration (this chat)

Commit `docs/biobuzz-reference.md` + `docs/biobuzz/field-plan.md` on `biobuzz`. In
`src/types.ts`: `ArtifactColor` gains `'yellow' | 'red' | 'blue'`; `Artifact.r?: number`
(unused by the shared solve until the owner takes it — flagged in HANDOFF); `Artifact.state`
gains `{ kind: 'element'; el: string; slot: number }`. `src/sim/**` is the owner's: the foul
tariff (BIOBUZZ MAJOR 20, DECODE 15) is NOT changed there — Lane A writes `bbAwardFoul` in
`penalties.ts` mirroring `awardFoul` with 5/20 into the BIOBUZZ score, and the per-artifact
radius in `solveArtifacts` / `robotSolids` goes to the owner via
`docs/biobuzz/feedback/000-solver-observations.md` (below the `## Response` marker).

## A1 — field-art (Opus 5)

You are Lane A of BIOBUZZ in the DSIM repo, worktree
`C:\Users\saket\Desktop\saket\FTC\Claude Projects\dsim-bb-field`, branch `biobuzz-field`.
First `git merge biobuzz`; the only expected conflict is `docs/biobuzz-reference.md` — take
the `biobuzz` side for every factual section (`git checkout --theirs docs/biobuzz-reference.md`),
then re-add from the scaffold (`git show HEAD:docs/biobuzz-reference.md`) its manual-intake
pipeline / cross-checks section — `scripts/manual-render.py`, `manual-figures.mjs`, the
AprilTag mirror check — under `## 9. Intake pipeline`. V1 numbers win everywhere else. Read `CLAUDE.md`, `docs/biobuzz-contract.md` (you are Lane A), `docs/biobuzz-reference.md`
§2 (geometry) and `docs/biobuzz/field-plan.md` §1 (constants list). You edit ONLY
`src/games/biobuzz/{config,state,drawField,scenesField}.ts`; everything else is another chat's.
Never touch `src/sim/`, `src/config.ts`, `src/types.ts`, or Lane B's robot files.

Job: make the BIOBUZZ field LOOK like the manual, today. Order:

1. (15 min, then COMMIT AND PUSH — another chat is waiting on it) Constants in `config.ts`
   under a `// ---- FIELD GEOMETRY (manual V1)` block, exactly the names in field-plan §1:
   `BB_POLLEN_R = 1.4` (retire the 1.5 APPROX), `BB_NECTAR_R = 1.8`, `BB_POLLEN_COUNT = 40`,
   `BB_NECTAR_COUNT = 8`, `BB_LZ` and `BB_GARDEN` (per-alliance plain `{x0,x1,y0,y1}` in
   world inches), `BB_HIVE_X = 12.75`, `BB_HIVE_CELL_DY = 13.4`, `BB_HIVE_OPEN_Z = [53.5, 65.6]`,
   `BB_HIVE_BOTTOM_Z = 25.5`, `BB_CELL_OPEN = {w: 20, d: 12}`, `BB_FRAME_X = 24.73`,
   `BB_FRAME_Y = 19.5`, `BB_FRAME_BAR = 1.5`, `BB_FLOWER_D = 3.0`, `BB_FLOWERS` (four centres,
   table in reference §2.3), `BB_FLOWER_TOP_Z = 21.5`, `BB_FLOWER_OPEN_R = 2.0`,
   `BB_FLOWER_FOOT_R = 2.6`, `BB_FLOWER_UNLOCK_S = 60`, the points table `BB_PTS`, RP
   thresholds. Every derived number carries `// APPROX: <figure>` exactly as the reference
   tags it. Add `bbMirror(p)` = point mirror (`-x, -y`, heading + PI) next to the existing
   x-mirror helper with a one-line comment: the layout is point-symmetric, not mirrored.
   Commit: `feat(biobuzz): field geometry constants from manual V1`. Push.
2. `state.ts`: add to `BiobuzzState` the shapes in field-plan §2 (`hives`, `flowers`,
   `nectarStock`, `nectarDue`, `leave`, `parkAuto`, `parkTele`) with `emptyBiobuzzState()`
   filling them (staged: red up = 'south', blue up = 'north', contents empty — spawn fills
   them in another chat). Plain JSON only.
3. `drawField.ts`: mat + grid stay. Add, in this z-order: red / electric-blue tape rectangles
   for both LOADING ZONES (1-in tape, low-alpha fill) and both GARDENS (2-in strip); the HIVE
   frame as two base bars at `x = ±BB_FRAME_X` plus a dashed crossbar hint at the apex (reads
   as overhead); the two HIVES top-down — each a 42.91 × ~14 rounded rect along y at
   `x = ±BB_HIVE_X`, split into two cells, the UP cell bright in alliance colour with its
   content count from `world.biobuzz.hives[a].contents.length`, the DOWN cell dimmed and
   foreshortened (its projection is shorter at 30°); the four AprilTag id groups as tiny text
   on each cell (`30–33` etc., reference §2.2); the four FLOWERS as a ring (r 2.0) inside a
   foot (r 2.6) on the wall at their seam, with a stack badge from
   `world.biobuzz.flowers[i].stack.length`. Labels: `RED LZ`, `BLUE LZ`, `RED GARDEN`,
   `BLUE GARDEN`, `F1…F4`, `RED HIVE`, `BLUE HIVE`, tile letters A–F / 1–6 along the edges —
   only when the scene asks for labels (the existing `field-labelled` flag). Colours: the
   theme tokens the DECODE field uses; fixed colours only for tape.
4. `scenesField.ts`: update `field-labelled` (no robots, staged state); every other scene id
   untouched. Run the shots recipe from `.claude/skills/verify/SKILL.md`:
   `node scripts/shots.cjs --scene field-empty,field-labelled` (Git Bash: `MSYS_NO_PATHCONV=1`),
   Read the PNGs yourself, fix, repeat until: zones in the right corners (red LZ far-left
   wall at y > 0, red garden audience-left corner), flowers on the ±24 seams, hives centred,
   no label overlaps. Then `npm run test:bb -- --lane field`, `npm run build`, commit
   `feat(biobuzz): draw the field — zones, hive structure, flowers`, push.

Subagents: one `Explore` at the start to map how `src/render/drawField.ts` (DECODE) draws
tape / labels and what scene flags `scenesField.ts` has (file:line only); one
`general-purpose` to write `drawField.ts` from your constants while you do `state.ts`; the
shot + Read is yours. Do not run the full smoke suite; do not start the dev server —
shots.cjs runs `vite preview` on 4173 itself (if 4173 is taken another worktree owns it, use
`--port 4174`). Five-line `docs/biobuzz/HANDOFF-field.md` entry: sha, which cells to look at,
what is APPROX in the drawing. STOP after the push and say "look at field-labelled".

## A2 — solids + staging (Opus 5) — start when A1 has pushed its constants commit

You are Lane A of BIOBUZZ in the DSIM repo. Make a worktree from any dsim checkout:
`git worktree add "C:\Users\saket\Desktop\saket\FTC\Claude Projects\dsim-bb-field2" -b biobuzz-field-staging biobuzz-field`
— work there, push only `biobuzz-field-staging`. Read `CLAUDE.md`,
`docs/biobuzz-contract.md` (Lane A), `docs/biobuzz-reference.md` §2–§3,
`docs/biobuzz/field-plan.md` §1–§2, and `src/games/biobuzz/config.ts` (the constants exist —
never redefine one). You edit ONLY `src/games/biobuzz/{colliders,spawn,elements,draw}.ts`,
`scripts/smoke-biobuzz/field.ts`, and APPEND new scenes to `scenesField.ts` (never edit an
existing scene — another chat owns `field-labelled`). Pollen physics is the shared
`solveArtifacts`; you never write an integrator, separation, eviction or ball constant.

Job: every element on the field where the manual stages it, and the field made solid.

1. `colliders.ts`: add to `statics` the two frame base bars (rects at `x = ±BB_FRAME_X`,
   `y ∈ [−BB_FRAME_Y, BB_FRAME_Y]`, thickness `BB_FRAME_BAR`) and the four flower feet
   (circle `BB_FLOWER_FOOT_R` at each `BB_FLOWERS` centre — whichever `StaticSpec` shape the
   shared colliders support; if only rects exist, a rect of the same footprint, commented
   APPROX). Bounds unchanged. Export `BB_SOLID_COUNT`.
2. `spawn.ts`: replace `scatterPollen` with `stageBiobuzz(world)` per reference §3: 4 pollen
   in each flower (`world.biobuzz.flowers[i].stack` = their ids; the balls stay in
   `world.balls` with `state: {kind: 'element', el: 'flower:0', slot}`, `pos` at the flower
   centre, `z` by slot); 4 pollen per garden in a line from the alliance corner along the
   wall (ground, touching the wall, one diameter apart); 4 preloads per robot through the
   existing capture path (cap 4; overflow on the tiles touching the robot; a missing robot's
   4 at its LZ centre against the wall); 3 nectar of each colour in that alliance's UP cell
   (`state {kind: 'element', el: 'hive:red', slot}`, `pos` at the cell centre); `nectarStock`
   5 each. Nectar `color: 'red' | 'blue'`, `r: BB_NECTAR_R`; pollen `color: 'yellow'`,
   `r: BB_POLLEN_R` (the field draws `r`; the solver still runs every ball at `BB_POLLEN_R` —
   write that as APPROX in the handoff, it is the owner's item). Start anchors: replace the
   x-mirror with `bbMirror` (point symmetry); two default anchors touching the wall, on the
   alliance side, outside the LZ, per G304 (reference §3).
3. `draw.ts`: colour per `b.color` (yellow / red / blue — keep the batched path, three
   batches), radius `b.r ?? BB_POLLEN_R`; `state.kind === 'element'` balls are NOT drawn here
   (the field draws cell counts and flower badges).
4. `smoke-biobuzz/field.ts`: zones point-symmetric; flowers at ±24 on their walls; frame
   bars inside the walls; staging counts 16 + 8 + 16 pollen, 6 nectar in cells + 10 in stock;
   conservation of 40 + 16 across floor / hopper / flight / element / stock after 600 ticks of
   two robots driving; a robot placed on each new solid is pushed off (mirror the `pin-wall`
   recipe). Scenes appended: `staging` (staged, robots at anchors, labels off), `under-hive`
   (robot between the frame bars — proves it drives through), `frame-push` (robot into a
   frame bar, 60 ticks).
5. `node scripts/shots.cjs --scene staging,under-hive,frame-push --port 4174`, Read, fix.
   `npm run test:bb -- --lane field`, `npm run build`, one commit per numbered item, push,
   one HANDOFF-field.md entry, STOP and say "look at staging".

Subagents: `Explore` once for `StaticSpec` shapes + how DECODE's spawn stages its artifacts
(file:line only); one `general-purpose` for the smoke checks while you write `spawn.ts`.

## A3 — hive + flower behaviour (Fable 5.1) — start after the `field-labelled` verdict

You are Lane A of BIOBUZZ in the DSIM repo, worktree
`C:\Users\saket\Desktop\saket\FTC\Claude Projects\dsim-bb-field`, branch `biobuzz-field`
(merge `biobuzz-field-staging` first if it has landed). Read `CLAUDE.md`,
`docs/biobuzz-contract.md`, `docs/biobuzz-reference.md` §4–§5, `docs/biobuzz/field-plan.md`
§2.1–§2.4, §3, §4 item 1, and the current `src/games/biobuzz/{play,step,elements,state}.ts`.
You edit `src/games/biobuzz/{hive,flower,play,step,hud,penalties,elements}.ts`, `sim.ts`
ONLY to flip `scored: true` (say so in the handoff), and append scenes + smoke checks.

Job: the field scores. In order, one commit each, `--lane field` after each:

1. `hive.ts` — capture into the up cell (accept rect `BB_CELL_OPEN` at `z` within
   `BB_HIVE_OPEN_Z` + margin, descending); `BB_TIP_LOAD` APPROX = 6 pollen-equivalents,
   `BB_NECTAR_MASS = 1.65` APPROX, `tipping` swing 0.8 s APPROX; on settle: flip `up`,
   `tips++`, +20 (auto if before teleop start), spill old contents as ground balls under the
   now-down cell via the shared flight / land step (world RNG), `nectarDue[a]++`. Any
   alliance may launch into any up cell; contents credit the hive's alliance.
2. `flower.ts` — stack model, capacity by height, entry via the top only, `actOnElement(…,
   'retrieve')` pops the bottom POLLEN only, live owner + bottom-nectar bonus, Fig 10-5 A–H as
   a table-driven smoke check.
3. `play.ts` stage 6 — points: tips; cell contents (live, banked at end); flower owner +
   bonus; garden 1 / element (circle ∩ strip); LEAVE / PARK latched at end of AUTO / end of
   MATCH (PARK in OWN LZ — assumption, flagged); RP rows (SWARM ≥ 16, POLLINATOR 1 ≥ 4 tips,
   POLLINATOR 2 ≥ 7). `scoreTargets` returns own up cell, opponent up cell, four flower tops.
4. Human player: one nectar into the own LZ ~1.5 s after each own tip, all remaining at
   ≤ 60 s staggered 1 s (APPROX both), through the existing `humanPlayers` timer if it fits,
   else on `world.biobuzz`.
5. `step.ts` — the 1:00 cue (`FLOWER OWNERSHIP UNLOCKED` event + HUD chip), end-of-AUTO and
   end-of-MATCH assessment hooks. `penalties.ts` — G410 only (MAJOR 20 per nectar into a
   flower before 1:00 left; the element still scores), via your own `bbAwardFoul` (5/20 — never
   edit `src/sim/scoring.ts`).
   `hud.ts` — tips, up-cell counts, flower owners, lock chip.
6. Scenes: `hive-tip` (stills across the swing), `flower-stacks` (A–H), `park-examples`
   (Fig 10-7's three), `nectar-entry`. Shots, Read, HANDOFF entry, push, STOP.

Subagents: `Explore` for how DECODE banks end-of-match points and fires `events`; one
`general-purpose` for the A–H table + smoke while you write `hive.ts`. Physics you are
tempted to tune (spill scatter, swing time) is APPROX and goes in the handoff, not into a
constant hunt.

## B — Lane B relay (paste into the robot chat, one message)

Manual V1 facts that change your dials (source `docs/biobuzz-reference.md` §6 on
`biobuzz`): **hopper ceiling is 4** (G407 CONTROL ≤ 4) — `BB_STORAGE_MAX` 4, default 4,
preloads fill it. **R105 expansion 18 × 24 × 29 in**, one horizontal axis only — `BB_PRISM`
24 stands, the other axis stays 18. Two launch targets with real heights: HIVE up-cell
opening **53.5–65.6 in** (a lob), FLOWER top **21.5 in**, 4.0-in hole (a placement). New
action: **retrieve** a POLLEN from a FLOWER's bottom opening (3.55 in tall) —
`actOnElement(world, r, 'retrieve')`, mouth facing the wall. NECTAR is a second element,
3.6 in vs 2.8, `color: 'red' | 'blue'` with `Artifact.r` — the intake must handle it and
must **refuse the opponent's** (G408). `ArtifactColor` now has `yellow | red | blue`
(step 0 on `biobuzz`). Merge `biobuzz` before your next commit.


## Rulings 3 — 2026-09-12 afternoon (owner, via master)

Source of truth: `docs/biobuzz/field-plan.md` §2.1 / §2.5 / §7 and `docs/biobuzz-reference.md` §2.2
on `biobuzz`. Merge `biobuzz` first.

### A1 — field-art

```
Merge biobuzz. Rulings (field-plan §2.1 render, §2.5): 1) NO letters or digits on the field for
elements — no N, no counts, no tally text. Up-cell contents = one row of element-scale discs
hugging the cell's OUTER (open) edge, inside the box, oldest at one end; colour is the type.
2) Down cell = dashed outline only, no fill (overhead at 25.5 in). Ground balls under either
cell draw as normal ground balls (dark ring) on top of the outline. 3) Open face marked: outer
short edge thin, pivot-side edge heavy. 4) `tipping` render = 4 s cross-fade fill→outline /
outline→fill, using BB_TIP_SWING_S when A3's constant lands (4 until then). Shots:
field-labelled + new `hive-ground` cell (down cell with 3 balls under it, no labels). Handoff,
push, STOP.
```

### A2 — solids + staging

```
Merge biobuzz. Ruling (field-plan §2.1 open face): `ScoreTarget` in state.ts gains optional
`mouth?: Vec2` — unit vector pointing OUT of the opening. Cells: south cell (0,-1), north cell
(0,+1), both alliances. Flowers point into the field: F1 (+1,0), F2 (0,-1), F3 (-1,0), F4 (0,+1).
Fill it in `scoreTargets`. Cell accept r stays 8 until rect. Smoke check: each up-cell mouth
points away from its pivot. Handoff, push, STOP.
```

### A3 — hive + flower behaviour

```
Merge biobuzz. Rulings (field-plan §2.1): 1) BB_TIP_SWING_S = 4.0 (owner). 2) `hiveAccepts`
also gates on approach — the cell is open at its OUTER end only, so the along-axis velocity
must point toward the pivot (up=south → vy > 0; up=north → vy < 0). Add a vel param.
3) Contents RELEASE when the bar passes level (~SWING/2): `hiveStep` returns `spilled` at
that edge (a `released` flag on HiveState), while `tipped`/points still fire at settle.
4) `spillPoses` returns `{pos, vel}`: z = BB_HIVE_BOTTOM_Z, vel outboard along the axis
40–60 in/s APPROX, ±12 lateral, from the rng. Smoke: wrong-side shot rejected; release
precedes settle; every spill vel points outboard. Handoff, push, STOP.
```

### V — visuals chat (standalone, no repo writes)

```
You own BIOBUZZ visuals only — throwaway HTML/canvas pages, never repo code. Start from
scratchpad file `biobuzz-field.html` (3 panels: plan view, side-view see-saw, top-down tip +
scatter) — the master chat will paste its path. Facts: docs/biobuzz-reference.md and
docs/biobuzz/field-plan.md on branch `biobuzz` (worktree dsim-biobuzz, read-only for you).
Rules: no letters/digits for elements — balls are balls; up cell filled, contents row on the
outer (open) edge; down cell dashed outline; ground balls dark ring; tip swing 4 s, release at
level, spill outboard; shots enter only travelling toward the pivot. Tip table
[8,7,6,3,1,0] by nectar count. Serve over http (python -m http.server), verify in the
browser pane, send ONE file per deliverable. Keep it simple: one file, few tabs. Next asks:
(a) robot-scale reference on the plan view, (b) side-by-side "shot from open side vs closed
side" animation, (c) flower stack fill/retrieve animation. Reply terse.
```

## A4 — field wiring (Lane A, after the 2026-09-12 merges)

You are Lane A (field) for BIOBUZZ in worktree `dsim-bb-field`, branch `biobuzz-field`.

BRANCH SWITCH: the shared base is `alpha`. `biobuzz` was merged into `alpha` and deleted on origin. Start with:

    git fetch && git merge --no-edit origin/alpha

`alpha` (3dcf90f) already holds A1 field art + rulings, A2 statics/staging/scoreTargets/`mouth`, A3 hive/flower + rulings, all merged and green (tsc clean, field lane 189/189). Read `docs/biobuzz-contract.md`, `docs/biobuzz/HANDOFF-field.md`, `docs/biobuzz/field-plan.md` (§2.1 open face / 4 s swing / release at level, §2.5 no letters or digits, §7 shooting side) and `docs/biobuzz-reference.md` before editing.

Goal: make the field LIVE. State, tick, scoring, release. Field files only: `src/games/biobuzz/{state,play,step,hud,elements,scenesField}.ts` and `scripts/smoke-biobuzz/field.ts`. Do not touch `robot.ts` or any Lane B file. Everything on `world.biobuzz` stays plain JSON; sim code has no DOM, clock, `Math.random` or `Date`.

1. `state.ts`: `BbHiveState` gains `released: boolean` (A3 asked for it). `emptyBiobuzzState()` seeds per-alliance `hives` (`upCell`, `contents`, tip timer, `released`), per-flower `flowers` (`stock`, `nectarDue`), `nectarStock`, `nectarDue`.
2. `play.ts`: capture through `ScoreTarget.mouth` + `hiveAccepts(hive, alliance, pos, z, vel)`, so a shot enters only while travelling toward the pivot; `hiveStep` runs the 4 s swing (`BB_TIP_SWING_S`), releases at `BB_TIP_RELEASE_S`, spawns `spillPoses` as ground balls with their velocity, then sets `released`; scoring for hive contents, garden, LEAVE and PARK; human-player restock; flower nectar drip. No ground-ball physics here, the shared solver owns it.
3. `step.ts`: the 1:00 nectar cue. Phase machine otherwise untouched.
4. Penalties: G410 through `bbAwardFoul`, edge-triggered, no cooldown timers.
5. `hud.ts`: the `gameHud` slice with hive counts and tip state.
6. `elements.ts`: delete the `upCell` cast now that state carries it.
7. `scripts/smoke-biobuzz/field.ts`: a live-match scene (the hive tips at t, release spawns exactly the contents as ground balls), element conservation on every tick (ground + flight + held + in cells + staged = the field total), a shot from the closed side rejected and one toward the pivot accepted, `released` surviving a JSON round-trip, tip table `[8,7,6,3,1,0]` lookups.
8. Scenes in `scenesField.ts`: `hive-tip` (t = 0, 2, 4 s), `park-examples`, `nectar-entry`.

Gates: `npx tsc --noEmit -p .`, `npm run test:bb -- --lane field`, then `npm run test:bb`. Gallery shots need `VITE_APP_CHANNEL=alpha npx vite --port 4176 --strictPort` and `MSYS_NO_PATHCONV=1 npx electron scripts/shots.cjs --scene <ids> --port 4176 --path /biobuzz/gallery --theme light --out scratch/shots/gate`. Read the shots. No letters or digits drawn on the field outside the labelled scene.

Land: `git fetch && git merge --no-edit origin/alpha` again, push `biobuzz-field`, prepend a dated section to `docs/biobuzz/HANDOFF-field.md`, and report the commit hash plus the check count. No Claude attribution in commits.

## A4 split (2026-09-12 evening) — A4a hive live · A4b rules/score · M manual distillation

A4 above is split into two code lanes and one docs lane so they run at once. File ownership is
exclusive; a lane that needs a file it does not own asks the master chat.

### Shared state contract (both code lanes write against this; A4a owns the file)

```ts
// src/games/biobuzz/state.ts — additions
export interface BbHiveState { /* A3's fields, plus */ released: boolean; }
export interface BbFlowerState { id: string; stock: number; nectarDue: number }
export interface BiobuzzState {
  hives: Record<Alliance, BbHiveState>;
  flowers: BbFlowerState[];
  nectarStock: Record<Alliance, number>;
  nectarDue: Record<Alliance, number>;
  // existing fields unchanged
}
export function emptyBiobuzzState(): BiobuzzState
```

### A4a — hive live (existing Lane A chat, worktree `dsim-bb-field`, branch `biobuzz-field`)

Same preamble as A4 (base is `alpha`; `git fetch && git merge --no-edit origin/alpha` first).
Own: `state.ts`, `play.ts`, `elements.ts`, `scripts/smoke-biobuzz/field.ts`.
FIRST COMMIT within 10 minutes: the state contract above in `state.ts` + `emptyBiobuzzState()`, pushed to `biobuzz-field`, so A4b can merge it.
Then: capture through `ScoreTarget.mouth` + `hiveAccepts`; `hiveStep` (4 s swing, release at `BB_TIP_RELEASE_S`, `spillPoses` → ground balls with velocity, set `released`); human-player restock; flower nectar drip; delete the `upCell` cast. No ground-ball physics.
Smoke in `field.ts`: live tip scene, conservation every tick, closed-side shot rejected / toward-pivot accepted, JSON round-trip of `released`.
Gates and landing as in A4. Do NOT edit `step.ts`, `hud.ts`, `penalties.ts`, `scenesField.ts`.

### A4b — rules, score, HUD (NEW chat, worktree `dsim-bb-rules`, branch `biobuzz-rules`)

Setup (run once, from the `dsim-biobuzz` folder's parent):

    git -C dsim-biobuzz worktree add ../dsim-bb-rules -b biobuzz-rules origin/alpha && cd dsim-bb-rules && npm ci

You are Lane A-rules for BIOBUZZ. Base is `alpha`. Read `docs/biobuzz-contract.md`, `docs/biobuzz/field-plan.md`, `docs/biobuzz-reference.md`, `docs/biobuzz/prompts.md` (the A4 split section: the state contract is there).
Own: `penalties.ts`, `hud.ts`, `step.ts`, `scenesField.ts`, and a NEW smoke lane `scripts/smoke-biobuzz/rules.ts` registered in `index.ts` as `--lane rules`.
Write against the state contract. When `origin/biobuzz-field` shows a `state.ts` commit, `git fetch && git merge --no-edit origin/biobuzz-field`. Until then, code that reads the new fields may be stubbed behind `world.biobuzz.hives?.` and must still typecheck against A3's state.
Do: scoring per the manual table (hive contents by cell state, garden, LEAVE, PARK) in `step.ts` or a new `score.ts`, recomputed every tick like CR; G410 and the other runtime contact rules through `bbAwardFoul`, edge-triggered, no cooldowns; the 1:00 nectar cue; the `gameHud` slice (hive counts, tip state, nectar stock); scenes `hive-tip` (t = 0, 2, 4 s), `park-examples`, `nectar-entry`. No letters or digits on the field outside the labelled scene.
Smoke (`rules.ts`): every scoring line asserted with a hand-computed total; each foul fires once on the edge and again on re-entry; endgame cue at the right tick.
Gates: `npx tsc --noEmit -p .`, `npm run test:bb -- --lane rules`, `npm run test:bb`, gallery shots (port 4177) read at hi-res.
Land: merge `origin/alpha` again, push `biobuzz-rules`, add a dated section to `docs/biobuzz/HANDOFF-field.md` under "rules lane", report commit + check count. No Claude attribution.

### M — manual distillation (NEW docs-only chat, worktree `dsim-bb-docs`, branch `biobuzz-docs`)

Setup once, in a terminal from the `Claude Projects` folder, then open the new chat in `dsim-bb-docs`:

    git -C dsim-biobuzz worktree add ../dsim-bb-docs -b biobuzz-docs origin/alpha

Prompt (give it the PDF path; it runs unattended from there):

You are the BIOBUZZ manual lane, worktree dsim-bb-docs, branch biobuzz-docs, base alpha. The full Competition Manual PDF is at <PATH>. Work from the PDF only, no guessing.
1. Copy it to scratch/manual.pdf (scratch/ is gitignored; the PDF and every page image stay uncommitted, always).
2. Text: `pdftotext -layout scratch/manual.pdf scratch/manual.txt` and, for the glossary section only, `pdftotext scratch/manual.pdf scratch/manual-flat.txt` (the two-column glossary interleaves under -layout). Read the text in sections with sed -n; do not paste the whole file into context.
3. Figures: `python -c "import fitz;d=fitz.open('scratch/manual.pdf');[d[i].get_pixmap(dpi=110).save(f'scratch/figs/p{i+1:03}.png') for i in range(len(d))]"` after mkdir scratch/figs, then Read only the pages the text says carry a field figure or a dimension drawing. Measure nothing by eye that the text states; where a number comes only from a drawing, say so and mark APPROX.
4. Write ONE file, docs/biobuzz/manual-distilled.md, with the section's rule id and PDF page for every line: scoring table (each line, points, when assessed); penalty list (id, MINOR or MAJOR, trigger, any per-3-seconds clause); match timing (auto, teleop, endgame, the nectar cue); LEAVE, PARK and garden definitions with the exact boundary words; human-player rules; start rules; R105 expansion limits; glossary entries for POLLEN, NECTAR, HIVE, CELL, FLOWER, GARDEN, LOADING ZONE and every other capitalised term the field or robot lanes use. Quote verbatim where a number or boundary word matters. End with "Open questions for the owner".
5. Compare against docs/biobuzz-reference.md and docs/biobuzz/field-plan.md and list every disagreement in a final "Conflicts with current docs" section; do not edit those two files.
6. Commit only manual-distilled.md, push biobuzz-docs, report the commit and the conflict count. No Claude attribution.

## Round 5 (2026-09-12 night) — after `alpha` `26b5c0d`

State: `alpha` carries A4a (field live), A4b (score.ts, Section 11 rules, 1:00 cue, HUD slice),
Lane B (launcher + lift wired, turret aims at `mouth`), `scored: true`, `isPinning` exported from
`src/sim/penalties.ts`. 802/802, tsc clean. Three Lane A chats run in parallel; each merges
`origin/alpha` first and lands into `alpha` through the master. Owner questions open: per-flower
nectar (ANSWERED: none — human player only, G426), turretless cannot reach the HIVE (Lane B
handoff), `BB_FRAME_RAM_SPEED`, `BB_TIP_POLLEN[0]`.

### A5a — field follow-ups (existing field chat, `dsim-bb-field`, `biobuzz-field`)

Merge origin/alpha (26b5c0d) first; it carries your 7f67fa0 plus the rules lane and Lane B. Then four items, your files only (state.ts, play.ts, elements.ts, spawn.ts, drawField.ts, scenesField.ts, field.ts smoke):
1. The per-FLOWER stock question is answered by docs/biobuzz-reference.md §2.4 and G426: NECTAR enters the field only through the HUMAN PLAYER (one per own-HIVE TIP, or all remaining at ≤ 60 s). There is no per-flower supply. Delete `stock` and `nectarDue` from `BbFlowerState` and `emptyBiobuzzState()`; the per-ALLIANCE `nectarStock`/`nectarDue`/`nectarTimer` stay. grep hud.ts and score.ts first; if either reads the per-flower fields, tell the master instead of editing them.
2. `bbWorld(seed, setups, pollen)` leaves dangling element ids in every FLOWER stack and both up-CELLs after it replaces `world.balls`. Make it clear the ids it invalidates (or restage after the replace). Add the smoke check: every id in a stack or a cell resolves to a ball.
3. `drawField.ts` still carries a private `FIELD_SIDE` duplicating `elements.ts`'s `FLOWER_MOUTH`. Import the one in elements.ts and delete the copy.
4. The 4 s spill: at t = 4 s seven elements spread about 20 in wide and one reached the perimeter (hive-tip@240 at 1600px). Do not tune; write what you measure (spread, farthest element, rest time) into docs/biobuzz/feedback/ as the owner's spill-kinematics question.
Gates: `npx tsc --noEmit -p .`, `npm run test:bb -- --lane field`, full `npm run test:bb`, shots of `hive-tip` at tick 0/120/240 and `hive-ground`. Prepend HANDOFF-field.md, push biobuzz-field, report the commit. No Claude attribution.

### A5b — G421 pinning (existing rules chat, `dsim-bb-rules`, `biobuzz-rules`)

Merge origin/alpha (26b5c0d) first: `isPinning` is now exported from src/sim/penalties.ts (field-plan §6 request 5). Your files only (penalties.ts, step.ts, hud.ts, score.ts, scenesField.ts, rules.ts smoke).
1. Model G421 PINNING in penalties.ts on the exported `isPinning`, exactly as DECODE's G422 uses it (same criteria A/B/C, the count pauses and resumes). Points and the per-3-seconds clause come from docs/biobuzz-reference.md; if the reference does not carry G421's text, stop and say so — the manual lane's docs/biobuzz/manual-distilled.md is the source, not a guess. Bill through `bbAwardFoul`; edge discipline as the other rules.
2. Smoke: a robot holding an idle victim against the frame bills, an equal-chassis mutual shove mid-field bills nothing, the count survives a 0.7 s ease-off. Use the FOOTPRINT (21 × 17 default) for every pose, as your handoff warns.
3. Leave HudSlots.tsx alone; a separate chat (A5c) owns it from now on. Your `biobuzzFieldHud` slice is its input; if it needs a field, it will ask through the master.
Gates: tsc, `npm run test:bb -- --lane rules`, full `npm run test:bb`. Prepend your HANDOFF-field.md section, push biobuzz-rules, report the commit. No Claude attribution.

### A5c — the HUD (NEW chat, worktree `dsim-bb-hud`, branch `biobuzz-hud`)

Setup once, from the `Claude Projects` folder:

    git -C dsim-biobuzz worktree add ../dsim-bb-hud -b biobuzz-hud origin/alpha

Prompt:

You are the BIOBUZZ HUD lane, worktree dsim-bb-hud, branch biobuzz-hud, base alpha (merge origin/alpha before every commit; land into alpha through the master). Read CLAUDE.md "The OPTIONAL UI slots", docs/ui-standard.md and docs/biobuzz-contract.md. You own exactly src/games/biobuzz/HudSlots.tsx and the HUD copy in src/games/biobuzz/Gallery.tsx; you read src/games/biobuzz/hud.ts (`BiobuzzFieldHud`: `score[a]: BbAllianceScore`, `rp[a]`, `cells[a]: BbCellHud` with `needed`/`tipping`/`tipProgress`/`up`, `flowerOwners`, `flowerDepth`, `nectarStock`, `nectarDue`, `nectarLocked`, `nectarIn`) and never edit it; ask the master for a field you lack.
1. `BiobuzzScoreBar`: red | phase + clock | blue, each side the alliance total plus the up-CELL line "N MORE TO TIP" (`cells[a].needed`, a number, never a word) and a TIPPING state while `tipping > 0`. NECTAR LOCKED chip until `nectarLocked` clears.
2. `BiobuzzHudChips` (driver's alliance only): own cell needed/tipping, nectar stock and due, the G410 lock. Uppercase chips like the FTC display; no dashes; no helper text.
3. `biobuzzResultsRows`: every Table 10-2 row from `BbAllianceScore` as alliance-relative `[label, mine, opp]` — LEAVE, PARK (auto), PARK (teleop), TIPS, CELL contents, OWNED FLOWER elements, BOTTOM NECTAR bonus, GARDEN, FOULS, TOTAL — then the three RP flags. Counts and points both where the row has both.
4. Verify in the browser: `VITE_APP_CHANNEL=alpha npx vite --port 4179 --strictPort`, open /biobuzz, play a solo practice match for 30 s, screenshot the bar, the chips and the results screen in light and dark. Then `npm run uiaudit` (ratchet must not go up) and `npm run contrast` if you touched a token (you should not need to).
Gates: tsc, full `npm run test:bb`, uiaudit. Commit, push biobuzz-hud, report the commit with the screenshots' paths. No Claude attribution.

### Lane B — relay (paste into the robot chat, one message)

alpha is 26b5c0d: scored:true (persistMatch writes BIOBUZZ per game, alpha-only), `isPinning` exported, your saved-robot config-summary fix is in. Still owed from your handoff: the gallery re-shoot with `turret-acquire`, `npm run shiftaudit`, and mobile buttons for bbLift/bbPlace (`GameModule.mobileButtons` + a `GameSettings.mobileLayout` key; you are cleared to edit those two integration files, same precedent as `statTiles`). Owner question relayed: the turret/turretless split (no turretless build reaches the HIVE) — keep `BB_DRUM_SPEED` until he answers.

## Round 5 addenda (2026-09-12 night) — after `alpha` `6aaf712` (manual-distilled.md merged)

### A5a addendum — the FLOWER sorter and the spill target (same chat, same files)

Two more items after your four:
5. `flower.ts` `flowerStackZ`: seat a NECTAR at `max(top, BB_FLOWER_MID_Z) + r`, with `BB_FLOWER_MID_Z = BB_FLOWER_VOL_Z[0]` (3.98 APPROX; fix the comment — it is the middle ring's UNDERSIDE, not its top; field-plan §2.2, manual-distilled §11 item 1). POLLEN is unchanged (falls through to the lower ring or rests on the column). Pin in smoke: a bare NECTAR spans 3.98–7.58 and scores (today it scores by 0.05 in, an accident of the APPROX); a POLLEN under a NECTAR — retrieval pops the pollen and the NECTAR's z does not move; staged 4 pollen still reads 3 in volume, 0 points; capacity from `flowerFits` follows the new heights. Restage `spawn.ts` `flowerStack` from the bottom through `flowerStackZ` — the APPROX comment there asks for exactly this.
6. Spill target (owner-visible; the visuals chat's field-v4 page, calibrated to his drawn landing lines): the pile leaves at 50–88 in/s in a ±55° fan about the outboard axis and rests 57–107 in from the pivot, median ~70, wall to wall with bounces. Today `BB_SPILL_SPEED` 40–60 straight outboard lands ~20 in wide. Move the fan and speed toward those numbers (APPROX, one constant each), re-shoot `hive-tip` at 240 and 480, and write measured spread / farthest / rest time beside the target in your feedback note. Item 4 becomes this.

### A5b addendum — manual-distilled.md is on alpha

`docs/biobuzz/manual-distilled.md` is merged (alpha `6aaf712`). G421 verbatim is in §3.1 (Table 10-4) and §3.3 (11.4.5). Two things it settles: (a) G421 has NO "attempting to move" clause — a BIOBUZZ robot is pinned whether or not it struggles, so the exported `isPinning`'s idle-victim branch is the LITERAL rule here, not a deviation; do not add a struggle test and say so in the smoke label. (b) §11 item 4: G417's escalation is STRATEGIC, not REPEATED — a single high-speed frame ram is STRATEGIC (example A). Fix the foul line and check label; the master fixes field-plan §4.4.

### Owner questions (from manual-distilled §10 — answer in chat, the master files the rulings)

1. PARK: your OWN LOADING ZONE only, or either? The rule and glossary say "the LOADING ZONE"; Fig 10-7 never shows the cross case.
2. Launching into the OPPONENT's up-cell: no rule bans it and it would score THEM a TIP. Allow in the sim?
3. G410 names NECTAR only: POLLEN may enter a FLOWER before 1:00 and just earns nothing until an owner exists. Confirm.
4. G407 caps CONTROL at 4 with a VERBAL WARNING (MAJOR + YELLOW only if STRATEGIC). The sim's structural hopper cap of 4 (field-plan §4.3) plus G304.G's four staged POLLEN means the first floor ball touched is the fifth CONTROLLED element. Keep the hard cap, or model the warning?

### Rulings 2026-09-12 late (owner) — filed in field-plan §2.1, §4.3, §7, §8

1. PARK: own LOADING ZONE only (already what `bbParkedNow` does; settled).
2. Opponent's up-cell: an element launched by the other alliance does NOT enter — a miss, lands as ground. Not penalised.
3. G410 binds NECTAR only (already what penalties.ts does; settled).
4. G407 is a WARNING, not a cap: the hopper is bounded by the volume law alone; CONTROL of a 5th element is a log line + HUD chip, no points, no MAJOR.

### A5a item 7 — refuse the opponent's cell (ruling 2)

`play.ts` hive capture: take only if the element's LAUNCHING alliance is the hive's owner (read whatever the flight state carries about its launcher; if it carries nothing, add `by: Alliance` to the flight variant and set it in `releasePollen`/launch — plain JSON, survives slimWorld). A refused shot stays a flight element and lands as ground. `elements.ts` `scoreTargets(world, a)` drops the opponent cell from the list (Lane B's `bbPickTarget` already skips it). Smoke: same shot from a red robot into blue's up-cell is refused; from a blue robot it is taken.

### A5b items 4–5 (rulings 3–4)

4. G407 as a WARNING: on the exported CONTROL count (hopper + herded) exceeding 4, `fire()` a 'warning' severity (add it to `bbAwardFoul`'s severity union if absent — 0 points, event line `G407 CONTROL of 5+ elements`, a `warnings` count in the HUD slice for a chip). No MAJOR, no card. Edge-triggered, re-fires on re-entry. Remove the §4.3 "MAJOR + YELLOW at 6+" branch if you wrote it. Smoke: 5 controlled warns once, 4 never, back to 4 and up again warns again.
5. Nothing to do for G410 (it already bills NECTAR only); add one smoke line proving a POLLEN entering a FLOWER at 2:00 bills nothing.

### Lane B — relay 2 (paste into the robot chat)

Owner ruling: G407 is a warning, not a cap. Delete `BB_STORAGE_MAX = 4` as the RULE ceiling in config.ts and let `bbStorageMax(spec)` (the volume law) bound the hopper dial; `BB_STORAGE_DEFAULT` stays 4. Fix the config.ts comments that call 4 the rule. Smoke: the biggest legal chassis can hold more than 4; the default still spawns with 4. The rules lane bills the warning; you only lift the cap. alpha is f01f924+.

## Round 6 (2026-09-12 late) — after `alpha` `ea2cba4`

State: A5a (field items 1–7), A5b (G421, G407 warning, G417 STRATEGIC), A5c (score bar, chips, results rows) all merged. tsc, server:check, uiaudit, contrast green; `npm run test:bb` 989/989. `controlledArtifacts` exported. Owner's Lane A todo mapped onto A6a.

### A6a — field (owner's list, in his order)

Merge origin/alpha (ea2cba4). Your files plus the clearances named in item 1.
1. **HUMAN PLAYER BUTTON** (owner): NECTAR entry is a driver ACTION, not a drip. Add `bbNectar?: boolean` to `RobotCommand` (src/types.ts), encode/decode it in src/net/protocol.ts (an edge like `catalyst`), a default keybind `N` in src/input/bindings.ts, and a mobile button through `GameModule.mobileButtons` + a `GameSettings.mobileLayout` key (Lane B was cleared for those two for bbLift/bbPlace — grep first; if its entries landed, add beside them). You are cleared for those four integration files for this bit only. Rule (G426): a press places ONE nectar into the OWN LOADING ZONE iff `nectarStock[a] > 0` and (`nectarDue[a] > 0` or ≤ 60 s of TELEOP left); otherwise nothing happens and the HUD slice says why — expose `nectarWhy: 'ok' | 'locked' | 'none-owed' | 'none-left'` for A6c. Delete the automatic drip (`BB_NECTAR_ENTRY_S`, `BB_NECTAR_DUMP_S`, `nectarTimer`); keep `nectarDue` as the entitlement counter. Either robot of the alliance may press. Smoke: press before any TIP places nothing; after one TIP places exactly one; at 59 s one per press until the stock is 0; the frozen field ignores it; a replay round-trip carries the bit.
2. **START POSITIONS** (G304, manual-distilled §6.2 A–E): anchors fully on the own side (red x < 0), touching the perimeter wall, NOT in the LOADING ZONE, clear of every FLOWER foot and scoring volume. Write `bbEvalStart(spec, pose, a)` (DECODE's `evalStartPose` shape: legal + reason) and `bbSnapStart`; at least two anchors per alliance, far apart (the index 0/1 rule), on the audience-wall and rear-wall stretches outside the LZ. Flip `startLegality: true` in sim.ts only if custom poses reach your evaluator through `coerceSetup`; otherwise leave it and say so. Mark APPROX where the frontage is figure-derived. Smoke: every anchor legal at every legal chassis size; an LZ pose and a flower-touching pose illegal.
3. **FLOWER STACK RENDER** (owner: "show balls in flower in a more intuitive way"): replace the row of discs along the wall with a SECTION VIEW beside the flower, outside the perimeter — a narrow column from top ring to lower ring, the scoring band shaded, elements as discs at their `flowerStackZ` heights in their own colours, owner colour on the top ring, a lock glyph when a NECTAR is at the bottom. It is V's c-flower page without the buttons, rotated with its wall. Gallery cell `flower-stack` at 0 / staged 4 / nectar-bottom / full; 1600px light + dark.
4. **THRESHOLDS** (owner: tip table and flower capacity accurate): both are APPROX and V1 cannot confirm them. Write `docs/biobuzz/feedback/002-thresholds.md`: exactly what to measure on 09-14 (tip load at NECTAR 0–5 including the empty cell; middle ring height and hole; how many POLLEN / NECTAR fit), and pin the DERIVED capacities (POLLEN 8, NECTAR 5) and `BB_TIP_POLLEN` in smoke as literals so a re-measure is one config edit and one label edit.
Gates as before. Prepend HANDOFF-field.md, push biobuzz-field, report the commit. No Claude attribution.

### A6b — rules

Merge origin/alpha (ea2cba4): `controlledArtifacts(world, r, dt, intaking)` is exported from src/sim/penalties.ts. 1. `bbControlled` becomes that call and nothing else changes; smoke a herded pile of five warns once. 2. YELLOW CARDS: owner decision pending (question 1 below) — do not model yet. 3. Then audit every foul line against the UI COPY rule (name the ACT) and every tariff against manual-distilled §3.1. Gates, handoff, push, report.

### A6c — HUD

Merge origin/alpha (ea2cba4). 1. `pins: BbPinHud[]` is on the slice — a PIN chip on the pinner (`PIN · 20 IN 1.4 S` from `nextIn`) and a red one on the victim. 2. G407 `warnings` → a `CONTROL 5+` chip held 3 s. 3. `nectarWhy` from A6a when it lands (grep the slice; TODO if absent). 4. Screenshots light + dark of the LIVE HUD at auto / teleop / ≤ 60 s / results — owed from A5c; attach to the report. uiaudit stays at baseline.

### Owner questions (new)

1. YELLOW CARDS: G414–G420 all card. Model cards game-wide (DECODE's `awardCard`; a second card is RED and voids the alliance score), or leave cards to the referee for this season?
2. Spill short tail: 11% of spilled elements rest inside the 57 in floor. Acceptable, or add a second term?
3. Human player button: one key for the whole alliance (either driver presses), or driver 1 only?

---

## A6a addendum (after 58a52b2) — paste into the FIELD chat

alpha moved under you: 58a52b2 carries Lane B's 3f41802/cffc243/177947b (mandatory launcher, Box Tube placement bits, hopper cap 4 restored) plus the rules and HUD lanes. Before you push:

1. `git fetch && git merge --no-edit origin/alpha`. Expect conflicts in src/types.ts, src/net/protocol.ts, src/input/bindings.ts, play.ts, spawn.ts — Lane B rewrote the same regions. Keep BOTH sides.
2. `bbNectar` is protocol bit **128**, the LAST one that fits `src/sim/replay.ts` (`q.buttons & 0xff`). Bits 32 (`bbPlaceNectar`) and 64 (`bbPlace`) are Lane B's; add yours beside them, same encode/decode shape. A ninth button needs a `REPLAY_FORMAT` bump — do not add one.
3. Mobile: Lane B did NOT land `mobileButtons`; `src/games/biobuzz/index.ts:34` still says why. Add the `GameModule.mobileButtons` slot + one `GameSettings.mobileLayout` key for the nectar button only (settings.ts coerce block at ~310 needs the new key). Leave bbPlace/bbPlaceNectar mobile buttons to Lane B.
4. `BB_STORAGE_MAX = 4` is back by owner ruling (177947b). Your flower/hive capacities are unaffected; do not re-lift it.
5. Gates before push: tsc, server:check, `npm run test:bb` (1105 on 58a52b2), uiaudit, contrast. Push `git push origin HEAD:alpha`.
