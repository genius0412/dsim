
# CLAUDE.md — DSIM, an FTC driver-practice simulator

An FTC driver-practice sim hosting **more than one game**:

| id | game | status |
|----|------|--------|
| `decode` | **DECODE presented by RTX** (FTC 2025–26) | full match, scored, ranked |
| `chain` | **Chain Reaction** (2026 Unofficial-FTC CAD competition) | full match, scored, ranked |
| `biobuzz` | **BIOBUZZ presented by RTX** (FTC 2026–27) | full match, scored, ranked; 2D or 3D physics + view |

Vite + React + TypeScript, Canvas 2D. The CLIENT bundle is React + **Rapier 2D**
(`@dimforge/rapier2d-compat`, wasm) and nothing else; the rest of `dependencies`
(`ws`, `tsx`, `pg`, `jose`, `@neondatabase/auth`) exists for the SERVER and auth — keep the
client that lean. BIOBUZZ 3D adds two LAZY chunks (Rapier 3D deterministic, Three.js), fetched
only when a 3D world is stepped or drawn locally; `npm run bundleaudit` ratchets every chunk. Deploys to Vercel zero-config; a Node/`ws` authoritative game server on
Fly; Electron wrapper for the desktop build.

**The app brand is DSIM; a game is a "season" (`src/seasons.ts`).** Keep them separate in
UI copy — DECODE/Chain Reaction are what is currently loaded, not the product name.

> Read this file top-to-bottom once, then the guide for whatever you are about to touch —
> see the routing table below. When you touch a game, check whether the thing you're editing
> is shared (`src/sim/`, `src/config.ts`) or game-owned (`src/games/<id>/`) — that
> distinction is the single most load-bearing fact in the repo.

## ⚠️ READ THE AREA GUIDE FOR WHAT YOU ARE TOUCHING

This file is the CORE: what is true everywhere, and where everything else is. It used to be
2,200 lines (~43,000 tokens) and it is loaded into **every session**, so every session paid
for DECODE's gate-lever geometry whether it was going near a gate or not. The deep rules now
live in `docs/area/`, and **they bind exactly as hard as they did when they were in this
file.** Almost every paragraph in them is a bug that shipped, was measured, and was written
down so it would not ship twice.

**Before your first edit under a path below, read its guide.** Not skim — the rules there are
mostly of the form "the obvious thing is wrong, and here is the measurement that says so".

| you are touching | read first | ~tok |
|---|---|---|
| `src/sim/**` · `src/config.ts` · `src/math.ts` · `src/types.ts` | [docs/area/physics.md](docs/area/physics.md) | 7.2k |
| `server/**` · `src/net/**` · `src/game.ts` · replays | [docs/area/netcode.md](docs/area/netcode.md) | 6.8k |
| `server/db/**` · ranked · matchmaking · standing · admin | [docs/area/accounts.md](docs/area/accounts.md) | 7.0k |
| `src/ui/**` · `src/input/**` · `src/render/**` · `src/tutorial/**` · **strings** | [docs/area/ui.md](docs/area/ui.md) | 3.1k |
| DECODE rules — `src/sim/goal.ts`, `penalties.ts`, `field.ts`, `src/games/decode/**` | [docs/area/decode.md](docs/area/decode.md) | 10.6k |
| `src/games/chain/**` | [docs/area/chain.md](docs/area/chain.md) | 4.5k |
| `src/games/biobuzz/**` · `scripts/smoke-biobuzz/**` | [docs/area/biobuzz.md](docs/area/biobuzz.md) | 2.1k |
| `src/auto/**` · Zenith autos · `zenith:sim` | [docs/area/autos.md](docs/area/autos.md) | 1.9k |
| adding a game — `src/games/types.ts`, `index.ts`, `sim.ts`, `src/seasons.ts` | [docs/area/adding-a-game.md](docs/area/adding-a-game.md) | 1.0k |
| `src/ads/**` · `server/kofi.ts` · `src/legalText.ts` · `src/storageKeys.ts` | [docs/area/monetization.md](docs/area/monetization.md) | 2.2k |
| `src/sponsor.ts` · `src/ui/Sponsor.tsx` · `electron/**` | [docs/area/sponsor.md](docs/area/sponsor.md) | 0.9k |

⚠️ **`src/sim/` is TWO guides.** It is the shared deterministic core (physics.md) *and* it is
where DECODE's own rules live (decode.md) — they predate the game seam and were deliberately
not relocated. Editing `src/sim/penalties.ts` or `src/sim/goal.ts` means both.

Also on demand, not in the routing table because they are not keyed to a path:
`docs/ui-standard.md` (the CSS rules `npm run uiaudit` enforces) · `docs/deploy.md` ·
`docs/capacity.md` · `docs/netcodeplan.md` · `docs/roadmap.md` (the eight roadmap items and
their state) · `docs/coordination-board.md` (**retired** — `.coord.retired.json` is in the repo
root, every `coord` command is a no-op, ignore it) · `docs/handoff-archive.md`.

**These are links, NOT `@imports`.** A CLAUDE.md `@path` import is loaded eagerly into every
session, which is the exact cost this split exists to remove. If you find yourself converting
them, you are undoing it.

**Keeping it honest.** `npm run docaudit` checks that every guide is routed, every route
resolves, every `governs:` glob still matches real files, no directory under `src/` or
`server/` has fallen through the gaps, and that this file stays under its token budget. That
last one is a RATCHET, the same way `uiaudit` is: the budget only ever goes down, so CLAUDE.md
cannot quietly grow back to 43k. If you add a rule here, ask first whether it belongs in a
guide — the test is whether a session working somewhere else needs to know it.

## Session protocol

**At the end of every working session, write/refresh `HANDOFF.md`** (repo root): current
state (is the build green?), what was finished, exact next steps, and gotchas. Read it at
session start if it exists — it may describe uncommitted mid-refactor state. HANDOFF is a
reverse-chronological log; prepend a new dated section and demote the old "READ FIRST".
**Read the TOP section, not the file.** Sessions before 2026-09-12g live in
`docs/handoff-archive.md`, moved there unedited on 2026-09-16 — the log had reached 5,888
lines (~97k tokens), which is a large fixed cost to pay before any work starts, and the rules
that outlived a session were promoted into this file long ago. Keep the archive fed the same
way: when HANDOFF.md gets long again, cut the old tail into it rather than letting every
future session read it.

## Commands

- `npm run dev` — dev server (localhost:5173)
- `npm test` — **headless sim verification** (1861 checks in `scripts/smoke.ts` + 2375 in
  `scripts/smoke-biobuzz/`, BOTH games, **~39s**). Run this after ANY change to `src/sim/`,
  `src/config.ts`, or `src/games/`. It catches almost everything. **Add a check per behavior
  change.**
  It is fast because `scripts/smokeshard.mjs` SHARDS smoke.ts across cores, not because it is
  small (serially it is 3m40s, what it cost until 2026-09-16): it parses smoke.ts, keeps the
  103-statement preamble verbatim in every shard, and bin-packs its 257 top-level blocks
  longest-first across 12 processes from a measured cost table. **smoke.ts itself is
  untouched — write checks exactly as before**; a serial run produces the same check names
  and outcomes as the sharded one.
  ⚠️ **The sharding rests on one property: no state crosses a block boundary.** A block is a
  closed scope and the only top-level mutable is `failures`, which every block writes and none
  reads. The runner ASSERTS that rather than assuming it — add a top-level `let`, or a
  top-level side effect other than `await initPhysics()`, and it refuses to run and tells you
  where. Keep new checks inside a `{ … }` block and this never comes up.
  - `npm run test:serial` — the old single-process run. The escape hatch when the runner
    refuses, and the tie-breaker if you ever doubt a sharded result.
  - `npm run test:calibrate` — re-measure per-block cost (~60s). Worth doing after adding or
    deleting an expensive block; the table is keyed by block CONTENT, so ordinary edits
    invalidate one entry rather than all of them, and a stale table only packs worse.
  - **~22s is the FLOOR** at any width: one block costs 22.4s on its own and a block cannot be
    split across processes. More shards past 12 buy nothing.
- `npm run test:mm` — **matchmaker verification** (`scripts/mmsmoke.ts`, 197 checks, no DB or
  sockets — injected clock + `stage`). Run after ANY change to `server/matchmaking.ts`. Kept
  out of `npm test` on purpose, same reasoning as `contrast`: a red `npm test` must keep
  meaning "physics broke".
- `npm run build` — tsc (strict) + vite build. Run before claiming work done.
- `npm run server:check` — typecheck the server against the shared sim (`tsconfig.server.json`).
- `npm run uiaudit` — **UI STANDARD audit** (`scripts/uiaudit.mjs`, zero deps). Enforces
  `docs/ui-standard.md`: undefined custom properties, duplicate selector blocks, `var(--x,
  #literal)` fallbacks, inline spacing in JSX, the type scale and the 4px grid. A **RATCHET**:
  every rule carries the count measured when written and fails if a count goes UP (lower the
  baseline when it goes down), so the standard binds new code without a big-bang refactor of
  existing debt. The first three rules sit at 0 and are hard errors, because both bugs they
  describe shipped silently: `--ds-font` was used 13 times and defined nowhere (voids the
  WHOLE `font:` shorthand), and `.ds-dl` was declared twice so the later block quietly
  re-laid-out the replay export menu. Same rule as `contrast`: deliberately NOT in `npm test`.
- `npm run docaudit` — **doc routing audit** (`scripts/docaudit.mjs`, zero deps, instant). Checks
  the CLAUDE.md split above is still TRUE: every `docs/area/` guide is routed from here, every
  link resolves, every `governs:` glob still matches real files (catches a directory RENAME,
  which otherwise leaves a guide governing nothing), every source file has an owning guide, and
  **CLAUDE.md is inside its token budget** — a RATCHET like `uiaudit`'s, only ever going down, so
  this file cannot grow back to the 43k it was. Run after moving a rule, renaming a directory, or
  adding a top-level module. Same rule as `contrast`: deliberately NOT in `npm test`.
- `npm run contrast` — WCAG audit of the palette (`scripts/contrast.mjs`, 383 checks, light +
  dark, no deps). Run after ANY colour/token edit. Not wired into `npm test` on purpose: a red
  `npm test` must keep meaning "physics broke".
- `npm run dbtest` — **database + payments verification** (`scripts/dbtest.ts`). Boots
  **PGlite** (Postgres 17 in WASM, a devDependency — there is no Postgres on a dev box), runs
  the REAL migrations and `server/db/repo.ts` against it, and asserts the Ko-fi webhook's
  idempotency, the claim race, the auto-renewal path, the tier policy, admin grant/revoke, and
  account deletion's cascade. Run after ANY change to `server/db/`, `server/kofi.ts`, or a
  migration. Same rule as `contrast`: deliberately NOT in `npm test`. `server/db/pool.ts`
  exposes a structural `DbPool` + `setPoolForTests` so the swap is possible; production still
  builds a real `pg.Pool`. It also asserts two SCHEMA invariants against the live schema after
  every migration, as RULES rather than a list of columns: **every foreign key has an index
  leading with its own columns** (without one, each parent delete scans the whole child table
  — migration 0037 fixed five, and the rule found the fifth itself), and **no index is a dead
  prefix of another** (never chosen, costs a write on every insert). Both fail silently —
  nothing errors, the database just does more work as tables grow. A reintroducing migration is
  caught here.
- `npm run shiftaudit` — layout-shift audit (`scripts/shiftaudit.cjs`, Electron). Needs a
  build + `npx vite preview --port 4173` in another shell. Forces `:hover`/`:active` and the
  `on`/`primary` state classes on every interactive element across 10 routes + the live HUD,
  in BOTH themes, and asserts nothing outside that element's own subtree moves. Pressables must
  move via `transform`/`box-shadow`, never a border or margin that appears on hover.
- `npm run costprobe` — **hosting cost probe** (`scripts/costprobe.ts`, no deps, ~20s). Measures
  what ONE ROOM costs — cores/room, bytes per 30 Hz snapshot, KiB/s per client, and the replay
  row each match writes — for BOTH games, solo and 2v2, off the real `step()` and the real
  `slimWorld`/`encodeBallDelta` codec, then extrapolates to a concurrency
  (`-- --ccu=2000 --solo=0.75 --util=0.65`). Run it when someone asks what N players would
  cost, before resizing a Fly VM, and **after any change that adds a per-tick `RobotState` or
  `World` field** — a one-line field ships 30 times a second to every client, and EGRESS, not
  compute, is ~90% of this bill. A measurement, not a test: nothing fails, and the published
  rates it prices against are stamped at the top of the file — re-check them before quoting.
- `npm run server` / `server:start` — the authoritative game server locally.
- `npm run electron` / `npm run dist` — desktop shell / installers (`release/`).
  **Desktop builds MUST be built with `ELECTRON=1`** (relative asset base — see Gotchas).

## Deploying — the rules that are dangerous to miss

Full protocol in `docs/deploy.md`; the netcode half in `docs/area/netcode.md`. These four stay
here because getting them wrong is expensive and none of them is obvious from the code.

- **Production is `main`.** `scripts/fly-deploy.sh` builds from whatever tree it runs in, so
  running it in the usual checkout (branch `alpha`) ships alpha. Deploy from a `main` worktree,
  and say which branch you are deploying when you ask.
- ⚠️ **NEVER a bare `flyctl deploy`.** `fly.toml` expresses only ONE `[[vm]]` size, so a bare
  deploy re-applies `shared-cpu-4x` to EVERY machine and silently upsizes the cheap satellites.
  Use `./scripts/fly-deploy.sh`; verify with `fly machine list -a dohun-sim-decode`.
- **The one Fly app serves EVERY client version** (alpha/beta/main bake the same
  `VITE_GAME_SERVER_URL`), so protocol changes MUST stay backward-compatible. New clients
  advertise `caps` on `join`/`queue` and the server feature-gates on them.
- **A migration, a replay change, or a foul STRING is a SERVER change** — it needs a deploy.
  Foul lines live in `src/sim/` and `src/games/chain/`; migrations apply at game-server boot.

## Repo map

```
src/
  config.ts        SHARED constants: robot/drivetrain/motor balance + ALL DECODE geometry
  types.ts         World / RobotState / RobotSpec / Artifact / BallState (shared shapes)
  math.ts          rot/clamp/hyp + the deterministic trig wrappers (dsin/dcos/datan2)
  game.ts          GameController: rAF loop, fixed-timestep stepping, predict+reconcile, HUD
  settings.ts      GameSettings + coerceSettings (localStorage, field-by-field validation)
  seasons.ts       app brand + the SEASON/GameId registry
  sim/             SHARED deterministic core (docs/area/physics.md) — DECODE's rules too
  games/
    types.ts       the GAME-ABSTRACTION seam (DOM-free): GameSimModule, StaticSpec, bounds
    module.ts      GameModule = GameSimModule + canvas renderers + builder/HUD spec
    index.ts       CLIENT registry (moduleFor/gameOf) — falls back to DECODE
    sim.ts         SERVER-SAFE registry (simModuleFor/simGameOf) — no DOM imports
    decode/        thin: points at src/sim + src/render (DECODE is NOT relocated)
    chain/         Chain Reaction: config/spawn/step/play/state/beams/penalties/mounts/draw*
    biobuzz/       BIOBUZZ: 2D + sim3d/ (Rapier3D backend) + scene/ (Three.js renderer), lazy chunks
  render/          DECODE canvas renderers + the shared camera/robot/wheel drawing
  ui/              React menus, HUD, leaderboard, lobby (read-only over world state)
  input/           keyboard/gamepad → RobotCommand (+ rebindable bindings.ts)
  net/             protocol / transport / lobbyClient / serverSession / sanitize
  tutorial/        DOM-free tutorial runner, the GameModule.tutorial slot
  lib/             authFlows.ts — the one wrapper over the auth SDK
  lan/             tab-hosted LAN room; hostWorker.ts
server/            Node + ws authoritative rooms, Neon Postgres repo, Glicko-2 ranked
api/               Vercel serverless: download.ts (desktop-build proxy)
electron/          desktop shell
scripts/           smoke.ts (the real test suite), contrast.mjs, shiftaudit.cjs, fly-deploy.sh
docs/              decode-reference.md (field sources), netcodeplan.md (roadmap), deploy.md,
                   ui-standard.md (THE UI RULES — read before touching any component)
```

---

# The game-abstraction seam

`src/games/types.ts` defines it. Read that file before adding a game or moving code.

- **`GameSimModule`** (DOM-free): `id`, `scored`, `startLegality`, `bounds`, `colliders`,
  `createWorld`, `step`. This is all the authoritative server and headless smoke need.
- **`GameModule`** (`module.ts`) = `GameSimModule` + `drawField`/`drawRobot`/`drawBalls`/
  `drawOverlays` + `ui` (`showScoreHud`, `startEditor`, `intakes`). Client-only.
- **Two registries on purpose**: `games/index.ts` (client, full) and `games/sim.ts`
  (server-safe). The server importing the client registry would drag in canvas code.
- Both resolvers **fall back to DECODE** for an absent/unknown/missing `game` — that is the
  single back-compat rule (old worlds/snapshots/replays carry no `game` field).
  **`'decode'` must always be registered.**
- Modules emit **plain-number collider specs** (`StaticSpec`), never Rapier handles.
  `physicsEngine.ts` owns RAPIER and turns specs into bodies. A game with a different field
  size just works, because the shared Rapier solve + camera are parameterized on
  `bounds`/`colliders`.
- `World.game: GameId` tags a world; `GameSettings.game` is the player's current pick.
  DB rows, leaderboards, records, and ranked periods are **keyed per game** already.

**Rule of thumb when adding behavior:** if it would be true of any FTC-style game (drive
feel, robot-robot shove, match phases, HUD chrome, netcode) it belongs in the shared core;
if it names a game element (artifact, gate, particle, catalyst, beam) it belongs in
`src/games/<id>/`.

# Shared core (both games)

## Determinism — the non-negotiable

- **`src/sim/` is a pure deterministic state machine.** No DOM, no clock, no `Math.random`,
  no `Date`. It consumes per-tick `RobotCommand`s keyed by robot id and a seeded mulberry32
  PRNG stored in `world.rngState`. The same rule binds `src/games/*/` sim code.
- Fixed timestep 60 Hz (`SIM_DT` = 1/60, `MAX_STEPS_PER_FRAME` 5); rAF render loop in
  `src/game.ts` (`GameController`). HUD is React, polled at 10 Hz from `getHud()`.
- All game state must be **plain JSON** (`world.chain`, `world.penalties`, …) so snapshots,
  reconcile, and replays hold.
- `dsin`/`dcos`/`datan2` (`math.ts`) exist from the old cross-machine-lockstep era. Under
  server authority they are no longer a *correctness* requirement, but **they stay in
  `src/sim`** — CR's 300-particle solve is still bespoke, and `npm test` greps the sim for a
  bare `Math.sin/cos/random`, so new sim code (the artifact engine's own probes included) uses
  them. Dropping the discipline is the last item of the Rapier port, not a side job.

# Gotchas

- **THEMING (dark mode).** Pref lives in `localStorage['decodesim.theme']` (`src/theme.ts`),
  never in `GameSettings` (that syncs to Postgres per account). First paint is stamped by a
  blocking inline script in `index.html`; `system` is resolved in JS so CSS sees only
  `data-theme="light|dark"`. **EVERYTHING THEMES, INCLUDING THE IN-MATCH HUD.** Three
  categories decide how a token behaves: (1) *readable against the surface* ⇒ INVERTS
  (`--ds-ink`, `--ds-mut`, `--ds-accent`, `--ds-warn`, the `-ink` siblings); (2) *a fill with
  fixed ink* ⇒ does NOT (`--ds-red`, `--ds-*-chip`, `--ds-gold`); (3) *its ground is the
  CANVAS* ⇒ does NOT, because the field is hardcoded dark — that is `--ds-on-field`/`-dim`/
  `-accent`, deliberately absent from the dark block. Use category 3 for anything drawn
  straight on the field or the dark overlay scrims.
  A dark HUD card is only ~1.4:1 on the dark field by FILL, so its EDGE identifies it:
  floating surfaces take **`--ds-hud-line`**, never `--ds-line` (tuned against the card behind
  it). `--ds-line-strong` is tuned against `--ds-panel` and drops to 2.73:1 on the translucent
  HUD card — rings that must read there use `--ds-mut`. Detect the theme in JS via
  `document.documentElement.dataset.theme`, not `getComputedStyle`. **A colour that is both a
  fill and a text colour will fail one of the two** — split it (`--ds-ok`/`--ds-ok-ink`).
  The letterbox themes (`COLORS.backdropDark`) but the field mat does NOT; the board is
  separated from the dark floor by its outline alone (1.03:1), so keep the outline.
- **Camera/screen math**: `worldToScreen` = rotate by `viewAngle`, then y-flip. Driver stick →
  field frame uses `rot(stick, -viewAngle)` (the INVERSE — sign matters at ±90°).
- **Bird's-eye vs mirrored** (bit us once): for a nose-up schematic, robot (x,y) → screen
  must be `[[0,−1],[−1,0]]` (forward → up, robot-LEFT → screen LEFT), NOT `rotate(-90)`, which
  puts the robot's left on the screen's right. Symmetric mechanisms can't reveal the
  difference; anything left/right-asymmetric can. See `ROBOT_FRAME` in `RobotPreview.tsx`.
- The DECODE basin containment normal points INTO the field; push balls back inside with `-n`
  (a sign inversion here once made positions explode to 1e250).
- **Ball containment invariant**: ground balls get a HARD geometric clamp INSIDE the round
  loop in `world.ts` (`clampBallPosToStatics`: walls, goal faces AND the classifier channel,
  past `BALL_CONTAIN_SLOP`), and one whose centre ends up inside a robot solid is re-placed by
  `placeGroundArtifact`, because Rapier's soft contacts can't clear a DEEPLY embedded body.
  **Any new solid a ball can tunnel into needs the same geometric clamp**, not just a collider
  — the pin test reads that clamp to know what an artifact is pressed against.
- **A ball "held" by a robot that does not exist is on the FLOOR by the end of tick one**
  (`positionHeldBalls` drops it). Smoke scenes used to park the field's artifacts on
  `robot: 99` to clear it, and three gate-arm scenes were spawning on spike-mark balls that
  way. Clear a scene with `w.balls.length = 0` (and empty `humanPlayers[a].box` if the
  restock matters); the remaining `robot: 99` sites are rail scenes the floor balls cannot
  reach, listed in HANDOFF.
- **Electron builds need `ELECTRON=1`** (`vite.config.ts` switches `base` to `./`). A bare
  `npm run build` loaded under `file://` resolves `/assets/*.js` at the filesystem root and
  404s **silently** — a permanently blank white window. Check this before assuming the app
  broke. The desktop shell is a THIN SHELL: online it loads the live site, offline it falls
  back to the bundled `dist`.
- The manual PDFs re-download from ftc-resources.firstinspires.org/ftc/game/manual-NN via
  WebFetch; figures are embedded images — extract and Read them as images when geometry
  questions come up.
- ⚠️ **AN UNDEFINED CUSTOM PROPERTY IN A `font:` SHORTHAND DROPS THE WHOLE DECLARATION,
  SILENTLY.** `--ds-font` was used at 13 sites in `shell.css` and **defined nowhere** (the
  real tokens are `--ds-font-ui` / `--ds-font-mono`), so `font: 750 26px/1 var(--ds-font)`
  set no weight, no size and no line-height — it is invalid at computed-value time, and
  every longhand falls back to inherited. Nothing errors and the text still renders, just
  in the wrong face. Same bug class as `--accent` (undefined, so `var(--accent, #6ea8ff)`
  always resolved to a pre-redesign literal on a themed HUD chip). **Grep a token before
  using it.**
- ⚠️ **TWO COMPONENTS MUST NOT SHARE A CONTAINER CLASS.** `.ds-dl` was declared twice in
  `shell.css` — the replay export menu at 2377 and the download page at 3883 — so the
  later one won and the export menu was laid out as an 18px-gap COLUMN instead of the
  `inline-flex` row it was written as. The download page is `.ds-dlpage` now. The two files
  are one cascade; position in the file is the only tiebreak.
- **`.ds-btn.small` is the size modifier.** `.ds-btn.sm` was a second rule for the same
  intent with different padding, used only by `Admin.tsx`; it is gone.
- **`prefers-reduced-motion` must cap `animation-iteration-count`, not just duration** —
  capping the duration of an INFINITE animation only makes it loop faster.
- **SEARCH WITH `rg`, NOT `grep -r` OR `find`, FROM THE REPO ROOT.** `.claude/worktrees/`
  holds full checkouts of this repo (810 MB at the last look), so a recursive `grep`/`find`
  walks four copies of `src/`, `scripts/` and `docs/` and returns the same hit four times —
  measured, it is also slow enough to blow a two-minute tool timeout. Ripgrep only honours an
  exclusion you add yourself: add `.claude/worktrees/` to your local `.git/info/exclude` (it is
  not tracked) or scope searches to `src server scripts docs`.
- Windows PowerShell 5.1: no `&&` in npm-adjacent commands; use `;` or `if ($?)`.

---

# State of play

**DECODE** — complete: full solo match + free drive, scoring per manual, motif randomization,
human-player restock, gamepad + keyboard, physical basin/rail/gate classifier, contact-torque
physics, driver assists, audio, pre-match countdown, Electron packaging, three intake presets
with the physical `mouth` capture model, power draw, the drivetrain retune (`BALANCE_VERSION`
2), configurable G304 start positions with the canvas editor, and the Phase C penalty engine.
Robot-on-robot pushing was rebuilt (`SIM_VERSION` 3): push is a stated FORCE, a shoved chassis
spins, and the contact response is closing-velocity-scaled — see `docs/area/physics.md`.

**Chain Reaction** — complete and scored: 300-particle bespoke physics with pre-match
randomization + the accelerator score/recycle loop, three archetypes (turret/drum/dumper) with
lead-compensated shooting on the move, four-edge shooter mounts + four intake mounts, catalysts
and hooks (multiplier, de-score allowed), ring-stand ascend/descend + Lab park, per-wheel beam
terrain with the mecanum strafe-curb, ground-clearance↔CoG tradeoff, Lab-Area start anchors
with TOP/BOTTOM roles, and the G05/G06 penalty pair.

**Netcode** — Phase 0 (server authority + prediction), Phase 1 (30 Hz delta snapshots,
interpolation, reconnection, connection-quality HUD, Fly deploy), and Phase 3 (accounts,
Glicko-2 ranked, leaderboards, records, admin, version gate) are LIVE.
**Phase 2 (Rapier)** — ROBOTS done (rotation unlocked, drive as a wrench); DECODE GROUND
ARTIFACTS done (the two-solve round loop with pinned artifacts, Sept 2026 — see
`docs/area/physics.md`);
DECODE flight/basin/rail/gate scripted BY DESIGN; **CR PARTICLES still bespoke**.

