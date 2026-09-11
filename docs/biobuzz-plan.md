# BIOBUZZ (FTC 2026–27) — season scaffold plan

Status: **APPROVED 2026-09-09** (decisions below settled the same day). Nothing built yet
beyond this document set. Written three days before kickoff.

## Context

- **BIOBUZZ presented by RTX** is the FTC 2026–27 game. Reveal + kickoff: **Saturday
  2026-09-12, 12:00 ET** (live stream). Game sets ship 09-14. Team Q&A opens 09-28.
- Known BEFORE kickoff (pre-season manual + FIRST's game preview):
  - **POLLEN** is the scoring element: "plastic balls approximately 3 in. in diameter",
    described as similar to DECODE artifacts. Pollen rolls against walls and collects in
    corners; robots are expected to intake several at once from lines and piles, and to
    navigate autonomously between known locations.
  - **R102** starting configuration is still an 18 in cube. **R104** no weight limit.
    **R105** expansion limits: "Sizing Constraints and more details will be released at
    Kickoff." Motors 8 / servos 8 (R503).
  - Sections 9 (Arena), 10 (Game), and the game-specific rules are placeholders until
    kickoff. The pre-season manual is `ftc-resources.firstinspires.org/ftc/game/manual`
    (93 pages; WebFetch returns binary, `pdftotext -layout` works).
- **Repo facts that shape this plan** (verified 2026-09-09):
  - `genius0412/dsim` is **PUBLIC**. GitHub has no private branches. See *Decisions*.
  - The live development branch is **`alpha`** (334 commits ahead of `main`, deployed to
    Fly app `dsim-alpha` + a Vercel preview scoped to the `alpha` branch). `main` is the
    stable release line. Anything new branches from `alpha`.
  - `alpha`'s `npm test` was **8 red** on 2026-09-07 (all DECODE contact physics, per
    HANDOFF). The gate for this work is "no NEW failures", not "green", until that clears.
  - The **game-abstraction seam exists** (`src/games/types.ts`, two registries, `GameModule`)
    and **Chain Reaction is the worked example** of a second game living entirely in
    `src/games/chain/` (20 files, ~300 KB). A third `GameId` needs **no DB migration** —
    every `game` column is `text` with default `'decode'`, `presence.game_queues` is jsonb
    for exactly this reason, and boards/ELO/records/periods are already keyed per game.
  - What a third game DOES hit is a set of two-valued literals that silently degrade an
    unknown id to DECODE: ~14 `x === 'chain' ? 'chain' : 'decode'` ternaries across
    `server/index.ts`, `server/api.ts`, `server/db/repo.ts`, `server/persist.ts`,
    `src/net/api.ts`; the route regex `(decode|chain)` in `src/ui/App.tsx` (2 sites); the
    allowlists in `src/settings.ts`; and ~16 `isDecode` builder gates in `src/ui/Menu.tsx`
    plus `hud.game === 'chain'` branches in `GameView.tsx` / `game.ts`.
  - `GameUiSpec` (`showScoreHud` / `startEditor` / `intakes`) has **zero readers**. The
    real per-game UI gating is ad-hoc booleans. A third game either adds a third arm to
    each, or we give the module real UI slots first. This plan does the latter.
  - CR's particle machinery (300 bespoke 3 in balls, spatial-hash separation, intake
    mouths measured off the chassis, hopper caps, turret/drum/dumper launchers, four-edge
    mounts, lead-compensated shooting on the move) is **almost certainly the right starting
    point for a 3 in pollen game**. The repo rule is "a new game is a new
    `src/games/<id>/` tree", so the plan is **copy-and-own**, not import-from-chain.

## Goal

By kickoff (T0 = 09-12 12:00 ET), two contributors with Claude Max can each open a chat
and start building **without touching the same files**:

- **Lane A — FIELD**: the arena, game elements, pollen physics, scoring, match flow,
  penalties, field art, start legality.
- **Lane B — ROBOT**: robot archetypes (mechanisms), builder dials and their clamps,
  presets, robot sprite + preview, robot-side HUD chips, controls.

And every shared-core edit a third game needs is **already landed** on the integration
branch, so neither lane has to touch `server/`, `protocol.ts`, `Menu.tsx`, `GameView.tsx`,
or `App.tsx` during the sprint.

## Decisions (settled 2026-09-09)

1. **Where the work lives: the PUBLIC `biobuzz` branch on `genius0412/dsim`** (revised
   2026-09-10 with the owner). The code is visible; the season is not — `channels:
   ['alpha']` keeps BIOBUZZ off every stable build, and the Vercel preview for the branch
   builds with the stable channel unless someone sets `VITE_APP_CHANNEL=alpha` on it.
   Lane branches (`biobuzz-field`, `biobuzz-robot`) push too, so both contributors can
   pull each other's work. Nothing is deployed to Fly until the owner runs the wrapper.
2. **Base = `alpha`.** Test gate = "no new failures vs the `alpha` baseline" while
   `alpha` itself is red. **`alpha` keeps moving until kickoff**: the integration chat
   merges `origin/alpha` into `biobuzz` at the start of every session (see *Workflow*).
3. **Copy-and-own CR's pollen-relevant machinery** into `src/games/biobuzz/`. BIOBUZZ is
   a **full season** in DSIM terms, exactly like DECODE and Chain Reaction: its own
   `GameId`, its own `SEASONS` entry, its own boards/periods, its own game directory.
   (CR was a CAD-competition game, but DSIM treats it as a full season; BIOBUZZ is the
   same shape with the official manual behind it.)
   ⚠️ **REVISED 2026-09-11, and the exception is the important part: GROUND POLLEN PHYSICS
   IS NOT COPIED AND NOT OWNED.** Copy-and-own is right for the drivetrain feel, the intake,
   the hopper and the step order; it is wrong for the ball solve, because the owner's artifact
   rework made `solveArtifacts` the ONE position authority for every ground artifact and a
   copied integrator would be a second one. POLLEN ride the shared solve at `BB_POLLEN_R`.
   See *Phase 0.5*.
4. **Owner (`@genius0412`) is aware and owns PHYSICS.** He is actively reworking artifact
   contact on `alpha` (one Rapier solve, one position authority, clump speed bound, pins
   and squeezes — see alpha's HANDOFF). BIOBUZZ therefore does **not** own a ball
   integrator: POLLEN rides the shared `solveArtifacts` with the radius parameterized, and
   every physics observation from the gallery goes to him as a HANDOFF note, never as a
   BIOBUZZ-local constant tweak. Server changes ship only through his `fly-deploy.sh`.
5. **Lanes undecided; both contributors have push rights** (owner + requester). The
   contract is written so either person can take either lane.

Two additions from the approval round, folded in below:

- **Physics and text→visual conversion are where Claude is weakest**, so the kickoff
  lanes are streamlined around a **visual feedback loop**: the human dumps information
  (manual pages, screenshots, impressions), Claude builds, and produces **frequent visual
  checks** (a gallery page + rendered stills) the human reviews and annotates. Everything
  that is not physics or visuals is Claude's alone. See *Visual feedback loop* and
  *Phase 0.5*.
- **Load and latency for a 10× population** is a separate track in a separate chat
  (branch `perf-load` off `alpha`, merges independently of BIOBUZZ). Prompt drafted in
  the scratchpad `biobuzz-prompts.md`; the plan only records the dependency: the shell
  must be able to run on the load-tested server, so BIOBUZZ adds no per-tick cost beyond
  CR's (300 particles is the ceiling already paid for).

## Architecture

### One game module, two lanes, one contract

```
src/games/biobuzz/
  sim.ts            BIOBUZZ_SIM: GameSimModule (DOM-free)          shared, frozen after P0
  index.ts          BIOBUZZ_MODULE: GameModule + UI slots           shared, frozen after P0
  step.ts           the tick pipeline (CR's shape)                  A owns ORDER, B adds hooks only via elements API
  ── Lane A (field) ───────────────────────────────────────────────
  config.ts         field/element/scoring/timing constants (mm(), APPROX convention)
  state.ts          BiobuzzState (plain JSON on world.biobuzz) + field geometry helpers
  colliders.ts      statics + bounds (+ dynamic if the game has moving field parts)
  spawn.ts          createBiobuzzWorld: pollen layout, robot placement anchors
  play.ts           pollen integrator/separation, scoring, match assessment
  elements.ts       THE CONTRACT SURFACE A exports to B (see biobuzz-contract.md)
  penalties.ts      contact/zone rules, edge-triggered (chain/penalties.ts pattern)
  drawField.ts      static field art
  draw.ts           pollen + element renderer (drawBalls slot)
  StartEditor.tsx   per-game start editor (ChainStartEditor pattern), if legality exists
  hud.ts            field half of the HUD slice (score, counts, phase extras)
  ── Lane B (robot) ───────────────────────────────────────────────
  robot.ts          archetype geometry: mouths, launchers, footprint, hopper cap
  mounts.ts         edge/position mounts (leaf module — imports only types)
  robotConfig.ts    dial ranges, defaults, PRESETS, clamp helpers used by coerceSpec
  drawRobot.ts      sprite (imports chassis/wheels from a copied parts.ts)
  parts.ts          chassis/wheel drawing (copied from chain/parts.ts)
  RobotPreview.tsx  builder preview
  Builder.tsx       the builder panel rendered into Menu via the module slot
  labels.ts         display labels shared by builder + leaderboard config summary
  hudRobot.ts       robot half of the HUD slice (mechanism state, hopper, prompts)
scripts/smoke-biobuzz/
  harness.ts        check()/run()/mkWorld for this game (tiny)
  field.ts          A's checks
  robot.ts          B's checks
  index.ts          runs both; wired into `npm test`
docs/
  biobuzz-plan.md         this file
  biobuzz-contract.md     the A↔B interface + ownership map + workflow (READ FIRST for lanes)
  biobuzz-reference.md    A's distillation of Sections 9/10 (decode-reference.md pattern)
```

### Shared-core generalization (Phase 0, lands BEFORE the lanes start)

Behavior-preserving for `decode` and `chain`. Every item is small; together they mean the
lanes never edit shared UI or server files.

1. **`GAME_IDS` + `isGameId()` + `coerceGameId(x, fallback = 'decode')`** in
   `src/games/types.ts` (DOM-free, so the server can import it). Replace every
   two-valued ternary and regex with it: `server/index.ts` (~6), `server/api.ts` (~5),
   `server/db/repo.ts` (~3), `server/persist.ts`, `src/net/api.ts` (`gameParam`),
   `src/settings.ts` (allowlist + loadout loop + `startPoseCount`), `src/ui/App.tsx`
   (both regexes built from `GAME_IDS`). Smoke: one check that `coerceGameId` of every
   registered id round-trips and an unknown id falls to `decode`.
2. **Starting act per game** moves onto the sim module: `GameSimModule.initialAct`
   (decode 0, chain 1, biobuzz 2) so `ensureSeason(..., game === 'chain' ? 1 : 0)` becomes
   `simModuleFor(game).initialAct`.
3. **Season visibility**: `Season.channels?: readonly ('stable' | 'alpha')[]` (absent =
   all). On a `stable` client build a hidden season is excluded from the home picker,
   `QueueCounts`, `parsePath` (falls to the saved game), sitemap/SEO route lists, and the
   robots.txt block is not generated. `registeredGames()` gains a `visibleGames()` twin
   that reads the client channel (`src/net/env.ts`). BIOBUZZ ships `channels: ['alpha']`
   until the owner flips it.
4. **Real per-game UI slots on `GameModule`** (client-only file, so React types are fine):
   - `Builder?: ComponentType<{ spec; onChange; game }>` — Menu renders it in place of
     the CR-specific block when present. `chain` and `decode` keep their inline branches
     for now (no refactor of working games); only BIOBUZZ uses the slot.
   - `Preview?: ComponentType<{ spec; size }>` — used by Menu + MatchStrategy where they
     import `ChainRobotPreview` today.
   - `hudChips?`, `resultsRows?`, `scoreBar?` — GameView renders them when present.
   - `mobileButtons?` — MobileControls consults it for extra action buttons.
   - `startEditor?: ComponentType<StartEditorProps>` — MatchSetup/Lobby/MatchStrategy
     use it in place of the `isDecode ? StartPositionEditor : ChainStartEditor` branch.
   - `labels?: { configSummary(spec): string }` — Leaderboard/robotLabels use it.
   - On the DOM-free side: `GameSimModule.hud?(world, robotId): unknown` feeds
     `HudSnapshot.gameHud` so `game.ts` stops growing per-game bags. `hud.chain` stays.
   Delete the dead `GameUiSpec.intakes/showScoreHud/startEditor` or leave them; leaving is
   safer. Adding is optional-field-only, so `chain`/`decode` compile unchanged.
5. **Per-game start-index clamp**: `coerceStartIndex` in `src/net/sanitize.ts` and
   `coerceSetup` in `src/sim/spawn.ts` clamp to `START_POSES.length` (DECODE's 5). Take
   the count from `simModuleFor(game).startPoseCount` instead (CR has 4 today and only
   survives because 4 < 5).
6. **`npm test` runs `scripts/smoke.ts` then `scripts/smoke-biobuzz/index.ts`**
   (`tsx a && tsx b` in package.json — the `&&` is fine inside an npm script). The
   monolith is not split; the new game just does not append to a 16 000-line file two
   people are editing at once.
7. **`scripts/manual.mjs`**: download a manual by URL/number to `scratch/`, run
   `pdftotext -layout`, and, when `pdfimages` is present, dump the figures. Codifies the
   pattern CLAUDE.md says lives in old scratchpads. Saves Lane A the first hour on T0.
8. **Register the shell** (item 9's module) in both registries + `SEASONS`
   (`key: 'biobuzz'`, name BIOBUZZ, presenter RTX, years 2026–27, `channels: ['alpha']`,
   blurb placeholder), `World.biobuzz?: BiobuzzState`, CLAUDE.md game table row +
   a "GAME: BIOBUZZ" section stub, HANDOFF entry.
9. **The shell module**: an empty 12 ft × 12 ft field, four walls, drivable robots, a
   deterministic scatter of N placeholder pollen (3 in, rolling, wall-bounded, never
   overlapping — CR's integrator), `scored: false`, `startLegality: false`, two start
   anchors per alliance, the CR robot stack copied and renamed with catalyst logic
   removed, a `Builder` that exposes only the shared dials. `smoke-biobuzz` asserts:
   registry integrity, wall containment, pollen count conserved, same seed ⇒ same
   `worldHash` after 600 ticks, `coerceSpec(…, 'biobuzz')` idempotent, snapshot
   slim/unslim preserves `game` + the `biobuzz` bag, `switchGame` isolates the loadout,
   a server `Room` runs a BIOBUZZ match headless (the CR check at the end of smoke.ts
   is the template).

10. **The visual feedback loop** (P0-shell builds the infrastructure; the lanes fill it):
    - **`src/games/biobuzz/scenes.ts`** — a registry of deterministic, DOM-free SCENES:
      `{ id, title, lane: 'field' | 'robot', build(seed) → World, script?(world, tick) →
      commands, stills: number[] }`. A scene is a world plus an optional scripted driver
      (a robot drives into a pile, sweeps a wall row, launches at a target, two robots
      squeeze a pollen). `scenesField.ts` (A) and `scenesRobot.ts` (B) contribute; the
      registry file itself is frozen after P0. `smoke-biobuzz` steps every scene to its
      last still and hashes it, so a scene is also a determinism check for free.
    - **`/biobuzz/gallery`** (`src/games/biobuzz/Gallery.tsx`, alpha channel only, mounted
      through the module's `devRoutes` slot): a grid of canvases drawn with the REAL
      `drawField`/`drawRobot`/`drawBalls` — the field alone, the field with every zone and
      element labelled, each archetype × each mount at three chassis sizes (the builder
      preview and the in-match sprite side by side), and every scene at each of its
      `stills` ticks. Each cell shows its scene id and tick. Click a cell → that scene
      runs live, drivable, in the normal game view (`/biobuzz/gallery/<scene>`).
    - **`scripts/shots.cjs`** (Electron, `shiftaudit.cjs` pattern): loads the gallery,
      screenshots every cell (or `--scene <id>`) into `scratch/shots/<git-sha>/<cell>.png`,
      both themes. Claude runs it after every visual change and **Reads the PNGs** — the
      point is that Claude sees its own output before the human does, so the human's
      review time goes to judgement, not to catching a shooter drawn on the wrong edge.
    - **Feedback dumps**: the human writes `docs/biobuzz/feedback/<date>-<lane>-<n>.md`
      (free text, scene ids or cell names as anchors, pasted manual excerpts, phone photos
      of the real field once sets ship 09-14). A lane chat starts every iteration by
      reading the newest unprocessed dump, replies in the same file under
      `## Response <sha>` with what changed and which cells to re-check, and moves on.
      No dump is ever edited by Claude above the response marker.

Acceptance for Phase 0: `npm run build`, `npm run server:check`, `npm run uiaudit`, and
`npm run contrast` green; `npm test` shows no new failures vs the `alpha` baseline;
`/biobuzz` loads in the dev server with the channel set to `alpha` and a robot drives
into pollen; `scripts/shots.cjs` produces a gallery contact sheet the human has looked at.

### Phase 0.5 — pollen on the shared solver (DONE, 2026-09-11)

This phase was planned as a two-solver bake-off with a human turning dials. It did not need
to be, and the reason is worth keeping: **the owner owns physics, and BIOBUZZ passes a radius
and nothing else.**

While this plan was being written the owner was rebuilding artifact physics on `alpha` to one
rule — *every element ends the tick somewhere it is allowed to be, with ONE position authority
per element* — and `solveArtifacts` became that authority for every ground artifact. A second
ball integrator living in `src/games/biobuzz/` would have been a second position authority for
the same class of object, which is precisely the failure the rework exists to end. So there is
no `BB_BALL_SOLVER` switch, no bespoke BIOBUZZ ground integrator, and no separation pass:

- `solveArtifacts` and `robotSolids` take a trailing optional **artifact radius**, defaulting
  to `C.BALL_RADIUS`, so every DECODE call site is byte-identical and BIOBUZZ passes
  `BB_POLLEN_R` (1.5", a 3" pollen) instead of 2.5".
- `play.ts` contains **no ball integrator**. It calls the shared solve, the shared
  rolling-friction pass (`stepGroundBall`), and a containment clamp, and `interact()` only
  CAPTURES — it no longer writes pollen positions.
- BIOBUZZ owns **no ground-pollen physics constants**. `BB_POLLEN_WALL_REST` survives for
  FLIGHT only. Tuning a pollen means tuning a shared artifact, which is the owner's call.

What is left of the original phase is the part that was always the valuable half: the SCENES
and the LOOKING. The physics scene set is built (`scenesField.ts` / `scenesRobot.ts`: three
pile speeds, a wall row sweep, a corner squeeze, a pin against the wall, two robots squeezing
one pollen, an intake line, a dumper at a wall, 60 pollen settling), every scene is hashed
deterministically in `npm run test:bb`, and the perimeter is asserted on EVERY tick of every
physics scene rather than at the end.

**The gallery has been read and written up: `docs/biobuzz/feedback/000-solver-observations.md`.**
One paragraph per scene on what the shared solve does with a 1.5" pollen, and a "For the owner"
list of everything that looks physically wrong or DECODE-specific — the missing pin/round loop,
a persistent 2.1" overlap under a pressing chassis, a struck pollen reaching `C.BALL_MAX_SPEED`
while the robot that hit it is slower, and the 5"-artifact rolling constants. Nothing on that
list was fixed here; fixing any of it is a shared-physics change and therefore the owner's.

**Exit:** there is no `signoff` dump to write, because there are no BIOBUZZ pollen constants to
freeze. What replaces it is a standing rule, recorded in `docs/biobuzz-contract.md` §1 and in
`CLAUDE.md`: Lane A may add element-specific behaviour on top (a pollen that scores, a pollen
that is held) and may NOT add a ball integrator, a separation pass, or a pollen physics
constant.

### Kickoff day (Phase 1, lanes in parallel)

The lanes are organised so the **humans spend their time looking, not typing**. Claude
owns everything mechanical (constants, colliders, clamps, smoke checks, HUD, labels,
handoffs). The human's job is the information dump at the start and the visual verdict
at each checkpoint. Checkpoints are **every ~90 minutes or every landed behaviour,
whichever is sooner**, and each one is a `shots.cjs` run + a two-line "look at cells X, Y"
note in the lane handoff.

**T0 → T0+2h — information dump.** The human runs `node scripts/manual.mjs` the moment the
manual is up and drops the text + figures where both lanes can read them (`scratch/manual/`
is gitignored, so the dumps go in `docs/biobuzz/feedback/` as `T0-field.md` /
`T0-robot.md` with the figure PNGs beside them). Lane A distills Sections 9 and 10 into
`docs/biobuzz-reference.md` (match structure table, scoring table, element table with
counts/dimensions, field map in the sim frame with every zone's coordinates, figure
sources) and **draws the field first** — the first gallery cell is the labelled empty
field, before any rule is implemented, because a misread figure costs a day and a
misread rule costs an hour. Lane B reads the robot rules (R105 expansion envelope,
mechanism/possession limits, the StarterBot mechanism list from the four vendors), writes
the archetype list + dial table into `biobuzz-contract.md` §4, and **draws the archetypes
second** — one cell per archetype × mount, reviewed before any mechanism is simulated.

**T0+2h — contract sync (30 min, both chats, one human in the loop).** Fix the
`elements.ts` API for THIS game (what can a robot do to which element, and what does the
field need to know about the robot to let it): capture, release/launch/deposit, score
zones, legal-start test, possession limits. Fix the `BiobuzzState` shape and the
`RobotSpec.bb*` field list. After this point each lane edits only its own files.

**T0+2h → T0+day 2 — build, in visual-first order.**
- A: field art + labelled zones (cell) → colliders (cell: robot resting against each
  solid) → spawn layout (cell) → element interaction scenes (cells, one per element) →
  scoring/assessment → match flow (if timing changed) → penalties → start legality +
  editor (cell) → field HUD slice. Smoke check per behaviour; scene per interaction.
- B: archetype sprites + previews (cells) → `RobotSpec.bb*` fields + `coerceSpec` clamps
  (+ `sanitize` passthrough) → `robot.ts` geometry (cell: mouths drawn ON the sprite, the
  drawn mouth IS the capture area) → mounts (cells) → `robotConfig.ts` ranges + presets →
  mechanism scenes (cells: each archetype captures, each archetype releases/launches) →
  `Builder` → labels → robot HUD chips → controls/mobile buttons for any new action (new
  `RobotCommand` fields need a protocol bitfield bit — the ONE shared edit B may make,
  coordinated in the contract doc). Smoke check per behaviour; scene per mechanism.
- Anything physics-shaped that appears on kickoff day (a game element that moves, a ramp,
  a pollen that is not a ball) goes to the **Fable** lane regardless of ownership map,
  with a dedicated scene set and a human sign-off dump, exactly like Phase 0.5.

### Integration (Phase 2)

- Flip `scored`, `startLegality`, `initialAct` as the rules dictate. Both lanes' smoke
  files green, no new failures in the monolith, build + server:check + uiaudit + contrast.
- Electron `verify` pass: menu, builder, field, a full solo match, results screen, both
  themes.
- Merge `biobuzz` → `alpha`; owner deploys `dsim-alpha` (`./scripts/fly-deploy.sh
  --alpha`); playtest online; then decide on `channels` and `main`.
- Fold the lane HANDOFF files into the root `HANDOFF.md`; CLAUDE.md "GAME: BIOBUZZ"
  section written in the house style (rules + gotchas, not a tour).

## Workflow

- Integration branch **`biobuzz`** off `alpha`. Lane branches **`biobuzz-field`** and
  **`biobuzz-robot`**, each in its own **git worktree** (repo convention: never work from
  the primary checkout when others share it). Merge `biobuzz` into the lane at least
  daily; the integration chat merges the lane back when green.
- `biobuzz` and the lane branches are pushed to `origin`; `git pull --ff-only` before
  every session. Worktrees on this machine: `dsim-biobuzz` (branch `biobuzz`, integration), one
  `dsim-bb-<name>` per chat (`core`, `shell`, `sandbox`, `field`, `robot`, `load`).
- **`alpha` sync**: `git merge origin/alpha` into `biobuzz` (MERGE, never rebase — the
  branch is shared by several worktrees and a rebase orphans them), done by the
  integration chat at the start of every session and before every lane merge. Expected
  conflict surface is Phase 0's files only (`types.ts`, the registries, `Menu.tsx`,
  `GameView.tsx`, `App.tsx`, `settings.ts`, `server/*`); lanes never touch those, so a
  lane merge never conflicts with `alpha`. Record the `alpha` SHA merged in HANDOFF.
- **`perf-load`** (the latency/traffic track) branches off `alpha` directly, not off
  `biobuzz`, and merges to `alpha` on its own schedule. BIOBUZZ picks it up through the
  `alpha` sync.
- During the sprint each lane keeps its own handoff file (`docs/biobuzz/HANDOFF-field.md`,
  `docs/biobuzz/HANDOFF-robot.md`) instead of prepending to root `HANDOFF.md`, because
  two prepends at line 1 conflict on every merge. Folded in at Phase 2.
- CLAUDE.md is edited only by the integration chat. Lanes propose text in their handoff.
- No lane touches `alpha` or `main`. No one runs `flyctl deploy`; the owner does.
- Every PR: `npm test`, `npm run build`, `npm run server:check`; `npm run uiaudit` if any
  `src/ui` or `.tsx` in the game dir changed; `npm run contrast` if any colour changed.
- First contribution: add a `CONTRIBUTORS.md` line and the CLA sentence in the PR body
  (CONTRIBUTING.md).

## Model assignment

| chat | model | why |
|---|---|---|
| P0-core: shared-core generalization (items 1–6, 8) | Opus 5 | the prompt enumerates every site; the grep proof + smoke checks catch a silent downgrade; the diff is REVIEWED by the Fable integration chat before merge |
| P0-shell: module scaffold + copy-and-own + smoke-biobuzz + scenes/gallery/shots (items 7, 9, 10) | Opus 5 | mechanical, well-templated by `chain/` and `shiftaudit.cjs` |
| ~~P0.5-sandbox: pollen physics, two solvers, human tuning loop~~ — DONE, and there was no bake-off: POLLEN ride the shared `solveArtifacts` at `BB_POLLEN_R`, so there are no dials to turn. What remains of this row is reading the gallery and writing observations UP to the owner (`docs/biobuzz/feedback/000-solver-observations.md`) | Opus 5 | the human is still the judge, but of the SHARED solver; a pollen behaviour that looks wrong is an owner question, not a BIOBUZZ edit |
| perf-load: harness, capacity model, then fixes | Opus 5 | measurement is mechanical; the capacity numbers are reviewed by the integration chat BEFORE step 4 (admission control / second-machine routing), which is the design-heavy part |
| Integration + reviews + merges + `alpha` syncs | **Fable 5.1** | the one Fable chat before kickoff: review gates after P0, after the solver comparison, after the capacity numbers; conflict resolution |
| Lane A field (kickoff) | **Fable 5.1** | geometry measured off manual figures + scoring/penalty rule text + any new physics; the repo's history says these are where misreadings ship for months. Human's call on the day |
| Lane B robot (kickoff) | Opus 5 | large but well-patterned (CR archetypes); escalate to Fable for the expansion-rule / footprint / clamp work if R105 is unusual, and for any mechanism with real dynamics |

Fable is used sparingly before kickoff on purpose: the prompts are already file-level
plans, so the model that follows them matters less than the review at each merge point.

## Risks

- **Local-only means one machine is the repo.** Until decision 1 resolves, the `biobuzz`
  branch exists on the requester's disk only. Mitigation: `git bundle` to the owner after
  every integration merge; the bundle is the backup.
- **`alpha` is mid-physics-rework** (drive as force, artifact contact), and BIOBUZZ now
  rides that rework rather than sitting beside it. The shared `updateRobot`/`solveRobots`/
  `solveArtifacts` path both games step through may move under us; `step.ts` copies CR's call
  order so a shared fix lands in one place per game. That is a deliberate trade: a change to
  the artifact solve changes how POLLEN behave, with no BIOBUZZ constant to absorb it, which
  is the price of not owning a second integrator. Merge `origin/alpha` every session and
  re-run `npm run test:bb` — the per-tick containment and settle checks are what catch it.
- **The gallery becomes the product.** A dev route with its own renderer path drifts from
  the real game view. Mitigation: the gallery draws through the SAME module functions
  (`drawField`/`drawRobot`/`drawBalls`) the match uses and the "click to run" cell is the
  ordinary game view; there is no gallery-only drawing code.
- **Launch-day load.** Estimated >10× the previous peak. Tracked in `perf-load`; the risk
  to BIOBUZZ specifically is that the shell's per-tick cost is higher than CR's. Smoke
  measures both halves of that, best-of-three windows in the same run: the WORLD STEP against
  `STEP_BUDGET` and a whole SERVER ROOM tick against `ROOM_BUDGET`. The step budget is **1.8×**
  and not the 1.2× this plan assumed — riding the shared Rapier artifact solve instead of a
  bespoke integrator measured 1.25–1.63× (≈0.47 ms for a 2v2, under 3% of a frame), and the
  budget carries that measurement in a comment. The ROOM budget stays **1.2×** and measures
  0.75–0.99×, because a room tick also pays for a snapshot and CR's 300 particles make that
  side much fatter than BIOBUZZ's 60 pollen.
- **The manual may change robot rules** (R105) in a way the flat `RobotSpec` + shared
  `footprintExtents` (which reads DECODE's `INTAKE_PRESETS[spec.intake].reach` for every
  game) fights. B's first task is to read that rule; the contract doc lists the escape
  hatch (a `bbFootprint(spec)` override in `footprintExtents`, like CR's mount branch).
- **Two people, one `types.ts`.** Only B adds `RobotSpec` fields; only A adds
  `World.biobuzz` state. Enforced by the ownership map, checked at PR.
- **The pollen guess is wrong** (the game is not a ball-launch game). Then the CR copy is
  still the right drivetrain/intake/hopper base; the scoring mechanism is A's to define and
  B's to actuate through `elements.ts`.
