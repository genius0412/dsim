# HANDOFF — 2026-07-12 (MULTI-GAME: Chain Reaction added behind a GameModule seam) — READ FIRST

> **Branch: `chain-reaction` (PRIVATE — do NOT push/deploy until the user says so).**
> **GREEN — `npm run build` (client tsc+vite), `npm run server:check`, `npm test`
> (~215 checks), and `npm run contrast` (135 pairs) all pass. Verified at the real
> surface (Electron): the Home game switcher toggles DECODE↔Chain Reaction, CR Free
> Drive spawns a drivable robot on a plain field with minimal HUD, DECODE unchanged.**

## What this branch does

Adds a SECOND selectable, playable game — **Chain Reaction (CR)**, the 2026 Unofficial-FTC
CAD-competition theme — alongside DECODE, behind a clean **game-abstraction seam**. CR is
an **"empty field shell" for now**: a drivable robot on CR's own field with **NO scoring /
balls / goals / rules yet** (its real geometry + ruleset arrive later). DECODE is 100%
unchanged. Both games are playable including online multiplayer.

Plan file: `~/.claude/plans/mutable-floating-hinton.md` (approved). Built in 6 phases,
each kept build+smoke green.

## The seam (`src/games/`)

- **`types.ts`** (DOM-free): `GameId='decode'|'chain'`, `StaticSpec`, `FieldBounds`,
  `FieldColliders`, `GameUiSpec`, and **`GameSimModule`** (id/scored/startLegality/bounds/
  colliders/createWorld/step — everything the SERVER + headless need).
- **`module.ts`**: **`GameModule`** = `GameSimModule` + `drawField`/`drawOverlays?`/`ui`
  (canvas renderers). Client-only. **The split is load-bearing**: the server tsconfig has
  no DOM lib, so it imports the DOM-free sim registry and never pulls `CanvasRenderingContext2D`.
- **`sim.ts`** (server-safe registry): `SIM_GAMES`, `simModuleFor(id)`, `simGameOf(world)`.
- **`index.ts`** (full client registry): `GAMES`, `moduleFor(id)`, `gameOf(world)`,
  `registeredGames()`. **Both resolvers default undefined/unknown → `'decode'`** — the
  single back-compat rule (old worlds/snapshots/replays carry no `game`).
- **`decode/`**: `colliders.ts` (the EXACT byte-identical extraction of the old
  `computeStaticSpecs`/`buildGateArms` — imported by `sim/world.ts` too, no cycle),
  `sim.ts` (`DECODE_SIM`, references `sim/spawn` createWorld + `sim/world` step), `index.ts`
  (`DECODE_MODULE` = sim + `render/drawField` + `drawRampStrips`).
- **`chain/`**: `config.ts` (`CHAIN_HALF_X/Y=72` placeholder + walls), `colliders.ts`
  (4 perimeter walls, no dynamic), `spawn.ts` (`createChainWorld` — robots only, INERT
  goals/scores/motif/match so `worldHash`/HUD never trip, no G304), `step.ts` (`chainStep`
  = `updateRobot` + `solveRobots(chainColliders)` + a minimal phase machine; NO
  updateRobotActions/balls/goals/penalties/scoring/square-up), `drawField.ts`, `sim.ts`
  (`CHAIN_SIM`, `scored:false`, `startLegality:false`), `index.ts` (`CHAIN_MODULE`).

## How dispatch threads through

- **Sim (shared):** `physicsEngine.ts` `solveRobots(world, dt, colliders, gateCol?)` +
  `solveBalls(world, dt, colliders)` now take a `FieldColliders` (was inline DECODE geom).
  `render/camera.ts` `configure(canvas, alliance, bounds?)` fits any field size (rotation-
  aware; reduces to the old square fit for DECODE). `render/renderer.ts` draws via
  `gameOf(world).drawField/drawOverlays`.
- **Client (`game.ts`):** `this.gameId = session ? session.game : settings.game`;
  `makeWorld` uses `moduleFor(this.gameId).createWorld`; the hot path (step/draw/HUD/camera)
  resolves the module from **`this.world.game` via `this.mod = gameOf(this.world)`** so a
  reconciled server world always uses its own game's step. `HudSnapshot.game` added;
  `getHud` returns `w.game ?? 'decode'`.
- **Settings:** `GameSettings.game` (`settings.ts` default `'decode'` + coerced). Home
  switcher in `HomeMenu.tsx` (`registeredGames()` → hidden until ≥2 games; `App.tsx`
  `onGame` patches `settings.game`). `seasons.ts` gained the `chain` entry + `seasonFor()`.
- **Net (caps-gated, back-compat):** `protocol.ts` — `'game'` in `CLIENT_CAPS`; `game?` on
  `RoomConfig`/`queue`/`matchStart`/`strategyStart`; `unslimWorld` defaults `game??'decode'`
  (worldHash does NOT hash game). `NetSession.game` + `ServerSession.game`. `lobbyClient`
  carries game on join(config)/queue and surfaces `matchStart.game`. Lobby/RecordRun/
  Matchmaking pass `settings.game`.
- **Server:** `room.ts` `private get game()` = `pendingMatch?.game ?? config.game ?? 'decode'`;
  uses `simModuleFor(this.game).createWorld/.step`; matchStart/strategyStart carry `game`;
  the G304 `activeStartLegal` gates run only when `simModuleFor(this.game).startLegality`.
  `index.ts` sanitizes join `config.game` + the room-mismatch check compares game.
  **`matchmaking.ts` `bucketKey` includes game** — the guard that a CR and a DECODE
  queuer never share one authoritative room. `PendingMatch.game` + `PendingRosterEntry.game`
  (stashed in the roster jsonb like `channel`, recovered in `takePendingMatch` — no schema col).
- **Builder/HUD (game-aware):** `Menu.tsx` hides intake/flywheel/canSort for non-DECODE
  (`isDecode`); `MatchSetup.tsx` hides the `StartPositionEditor` (keeps alliance + dummies);
  `App.tsx` `guardStart` skips the G304 legality check for non-DECODE; `GameView.tsx` `Hud`
  renders MINIMAL chrome when `hud.game !== 'decode'` (no score bar/motif/breakdown/hopper).

## Persistence (Phase 5) — DELIBERATE SCOPE

- **`persist.ts` short-circuits UNSCORED games** (`!simModuleFor(o.game).scored → return {}`),
  so CR's 0-0 shell matches NEVER touch ELO/records/history. `MatchOutcome.game` added.
- **The `game` COLUMN on records/elo_ratings/matches was intentionally NOT added yet.**
  Rationale: CR is unscored ⇒ writes nothing, so DECODE boards can't be polluted; a
  half-applied migration (column default `'decode'` without threading `game` through the
  ~14 repo write/read fns) would be a FOOTGUN (existing DECODE inserts would tag future CR
  rows `'decode'`). **When CR becomes SCORED, do migration `0012` (game col + re-key ELO
  PK/board indexes) AND thread `game` through repo.ts board fns TOGETHER**, then flip
  `CHAIN_SIM.scored`. Until then persist-gating is the single, sufficient guard.

## Gotchas learned this session

- **Electron GUI verify needs the RELATIVE-base build**: `ELECTRON=1 npm run build` (the web
  build bakes `base:'/'` → blank under file://). Rebuild plain `npm run build` after to
  restore the web dist. Driver: `scratchpad/drive.cjs` (clickByText + screenshots).
- The DOM-free split (`GameSimModule` in `types.ts` vs `GameModule` in `module.ts`) is why
  `server:check` passes — don't move `drawField`'s `CanvasRenderingContext2D` back into a
  server-imported file.
- `squareUpRobots`/`squareUpStatics` (physics.ts) are coupled to DECODE goal/classifier
  geometry — `chainStep` deliberately skips them (Rapier still contains robots at the walls).
- smoke gained CR + game checks (registry defaults, CR spawn/drive/containment/determinism,
  DECODE 8-collider parity, matchmaker game-bucketing, CR room→post + matchStart.game).

## CR real game — absorbed from the manual (2026-07-14)

**Chain Reaction, presented by goBILDA.** 2v2. 30 s auto / 120 s teleop / last 20 s end
game. Terminology (in `chain/config.ts` header + `CHAIN_PTS`/element consts):
- **ACCELERATOR** = the alliance goal (what I first called "goal"). Launch PARTICLES in
  ⇒ 1 pt each. Auto-score + reject; also re-randomizes the 300 particles pre-match.
- **PARTICLE** = 3"-OD wiffle ball (300 total, `CHAIN_PARTICLE_R`=1.5). Launchable from
  ANYWHERE.
- **CATALYST** = 6"-OD purple ring (4 total). Placed on a HOOK ⇒ +1 pt per particle in
  that accelerator (multiplier). Max 1 controlled per robot.
- **HOOK** = on the accelerator wall (`CHAIN_HOOK_Y` ±27.0903"); holds a Catalyst.
- **RING STAND** = 22.5" vertical corner pole; Ascend (endgame 20 pt) / Descend (auto 20 pt).
- **LAB AREA** = start/park zone (leave 5 pt auto / park 5 pt endgame; can't combine park+ascend).
- **PARTICLE ZONE** = center white-tape diamond (neutral, unprotected).
- Robots: 18×18×18" start → 24 w × 24 l × 30.5" h max (DIFFERENT from DECODE — not yet
  wired into the CR builder's size limits).

### CR is now PLAYABLE (2026-07-14) — full shooter loop + scoring
- **`src/games/chain/play.ts` `updateChain`** owns it all: 300 PARTICLES (bespoke
  integrator — NO Rapier ball↔ball, so 300 is cheap; friction + wall bounce + robot
  plow/intake), the SHOOTER (auto-aim turret at own accelerator + fire held particles),
  ACCELERATOR scoring + RECYCLE (scored particle → +pts → reject a fresh ground particle;
  **count conserved at 300** = ground+flight+hoppers), CATALYSTS (auto-pickup, seat on a
  hook near the accelerator ⇒ +1 pt/particle), and ENDGAME (park in a lab square = 5,
  ascend near a ring stand = 20). `world.chain` (`chain/state.ts`) holds catalysts /
  per-alliance scored+points / per-robot endgame / a deterministic `nextBallId`.
  Points → `match.scores[a].total`; scored count → `goals[a].classifiedCount` (worldHash).
- **`chain/spawn.ts`** scatters 300 particles + 4 catalysts off a mulberry32 chain (seed).
- **`chain/step.ts`** = drive → `solveRobots` → `updateChain` → phase machine.
- **Render:** `chain/draw.ts` `drawChainBalls` (white particles + flight lift/shadow +
  purple catalyst rings + ascend/park badges), added as `GameModule.drawBalls` (renderer
  now dispatches balls per-game; DECODE keeps `render/drawBalls`). Lab-area squares in
  `chain/drawField.ts`.
- **HUD:** CR is scored now — `GameView` shows the red|timer|blue score bar (no motif) +
  a CR breakdown (PARTICLES / MULT ×N / CATALYSTS n/2 / endgame) + chips (HOPPER n / ×mult
  / CATALYST / ASCENDED|PARKED). `HudSnapshot.chain` + `getHud` populate it. CR `ui.showScoreHud=true`.
- **Particles NEVER overlap**: `separateParticles` in `play.ts` — a uniform spatial-hash
  (cell = 2·radius) position separation pass (`CHAIN_PART_SEP_ITERS`), O(N), scales to 300.
- **Shot goes INTO the accelerator + is EJECTED back out** (visible): a flight ball flies
  past the mouth into the box, scores on entry (`scored` flag on `BallState.flight`), keeps
  flying in, then the auto-score system relaunches the SAME ball back onto the field
  (`CHAIN_EJECT_*`). Count still conserved (ball reused, no teleport).
- **Ball storage** is a per-robot builder slider (`RobotSpec.ballStorage`, 1–30, default 8);
  rapid fire cadence `CHAIN_FIRE_INTERVAL` 0.05s.
- **Catalyst BUTTON** (not auto): `RobotCommand.catalyst` (bindings key `c` / pad LB, in
  `ControlsSection`; quantized bit2). Edge-triggered in `updateChain` (`ChainState.catalystHeld`):
  pick up a nearby free ring / place a carried ring on a hook (or drop). Catalysts STAGED in
  the lab corners at spawn.
- **Hook occupancy is drawn per-slot** (`draw.ts`): each of an alliance's 2 hooks renders as
  its own slot (empty = hollow ring + index tag, occupied = filled bright donut) so it's clear
  how many hooks there are + which hold rings (they read as one top-down otherwise).
- Smoke pins: 300+4 spawn, intake→fire→score, 300 conservation, catalyst ×2, park 5 / ascend 20,
  particles-never-overlap, catalyst-button pick-up+seat.
- **Default CR assists = auto-intake + auto-fire ON**, so a robot immediately cycles
  (verified in Electron: solo match scored 9 in auto). TUNING knobs in `chain/config.ts`
  (GAMEPLAY block): particle count/friction, hopper cap, intake reach, fire cadence/speed,
  catalyst radii, ascend radius, lab size.

### Geometry in the CR module now
- **EXACT (`chain/config.ts`, `mm()`=÷25.4):** ACCELERATORS protrude out each side wall,
  centered y — `CHAIN_ACCEL_DEPTH` 27.4605" × `CHAIN_ACCEL_WIDTH` 54.8681". HOOKS at
  `CHAIN_HOOK_Y` ±27.0903". Camera bounds widened (`CHAIN_VIEW_HALF_X`) for the protrusion.
  Smoke pins them. Element specs/scoring/timing captured as consts (unused until scoring).
- **APPROXIMATE (FLAGGED — refine with exact coords):** PARTICLE-ZONE diamond
  `CHAIN_DIAMOND_R` 38"; RING-STAND corner posts `CHAIN_RINGSTAND_INSET` 12" (at ±60,±60).
- **⚠ `cm.pdf` STILL CORRUPT** (damaged flate streams — poppler/mupdf/pdftocairo/qpdf all
  fail; renders blank). The rules above came from manual PAGES the user sent as images.
  Poppler/qpdf/mupdf were `brew install`ed this session for the (failed) decode attempt.

## Still needed to finish the CR field precisely
Exact coordinates for: the PARTICLE-ZONE diamond size, the RING-STAND positions, the LAB
AREA geometry (start/park zones), and the A–F column grid. Plus the accelerator/particle
scoring mechanics (mouth/opening + how a launched particle registers). Everything else
(field size, accelerators, hooks) is exact.

## Next up

1. **When the CR manual/remaining dimensions land:** finish `src/games/chain/*` — the
   remaining zones above, intakes, `createChainWorld` preloads, `chainStep` scoring stages,
   a start-legality model (flip `startLegality`), and `CHAIN_MODULE.ui`
   (intakes/showScoreHud/startEditor). Then the persistence work above.
2. Ranked CR is technically wired (bucketed + game carried through pending_matches), but
   pointless while unscored — leave it; it just no-ops in persist.
3. This branch is PRIVATE. Server/protocol changes are back-compat (caps-gated) but
   UNDEPLOYED — do not `flyctl deploy` until the user approves going public.

## Commit status
All work is UNCOMMITTED on `chain-reaction` (per the "commit only when asked" rule).
Offer to commit when the user is ready.
