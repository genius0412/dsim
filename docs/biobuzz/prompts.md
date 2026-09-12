# BIOBUZZ chat prompts (plan approved 2026-09-09)

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
