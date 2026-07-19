# HANDOFF — 2026-07-19 (Chain Reaction: wall square-up + drivetrain diagonal audit) — READ FIRST

## Latest session — wall square-up in CR + diagonal-speed audit

- **CR robots now square up flush to walls** (they didn't before). DECODE's post-Rapier
  `squareUpRobots` was never called in `chainStep`. The wall block of `squareUpStatics`
  (physics.ts) was factored into `squareUpWalls(r, preVel, halfX, halfY)`, and a new export
  `squareUpRobotsWalls(world, preVels, halfX, halfY)` runs robot-robot squaring + wall-only
  statics (no DECODE goal-face/classifier geometry, which is phantom in CR). `chainStep` now
  captures `preVels = solveRobots(...)` and calls it with `CHAIN_HALF_X/Y`.
- **Diagonal-speed bug FIXED (was real — in the ACCEL phase, not top speed).** TOP speed was
  already capped fine (`hypot` demand for swerve, L1 for mecanum/xdrive), which is why a
  peak-speed probe missed it. But `motorStep` was stepping fwd + strafe INDEPENDENTLY, so the
  velocity VECTOR accelerated at √2·accel on a diagonal → over a 0.5 s drive from rest,
  diagonal covered **33-37% more ground** for swerve/xdrive (~10% mecanum). Added
  `motorStepVec` (drivetrain.ts) — caps the accel budget in vector MAGNITUDE, not per-axis;
  robot.ts uses it for translation (angVel still 1-D `motorStep`). After: diagonal/straight
  displacement ratio ≤ 1.0 for all drivetrains. Smoke test now measures DISPLACEMENT (not peak
  speed) so it actually guards the bug. Pure-forward accel/top-speed unchanged (identical to
  the old path when strafe = 0), so the DECODE `driveSummary` calibration holds.
- **High-CG swerve is now way more sluggish** (user request). `cogFactor` (CR beams.ts) is
  drivetrain-aware: swerve uses `CHAIN_COG_SWERVE_PENALTY` (0.6) on a SQUARED clearance curve
  (tippy tall modules), vs the base `CHAIN_COG_PENALTY` (0.16) linear for everyone else — so a
  max-clearance swerve drops to ~40% authority vs ~84% for tank/mecanum.

# HANDOFF — 2026-07-19 (Chain Reaction: start positions + launcher randomization)

## Latest session — start positions, pre-match launcher randomization, fire-rate + spread tuning

- **START POSITIONS (rule G04 — start completely in the Lab Area).** `CHAIN_START_POSES`
  in `config.ts` = 4 legal named anchors (2 Lab-corner FLOOR poses + 2 RING-STAND ascended
  poses), CANONICAL for BLUE (+x), x-mirrored for RED in `spawn.ts` `chainStartPose`.
  `makeChainRobot` honours `setup.startIndex` (2-robot alliance defaults to 0/1 → the two Lab
  corners). Selector: `MatchSetup.tsx` (solo config) now shows CR start buttons (was a
  placeholder) that set `settings.startIndex`. All anchors legal by construction, so G04
  always holds. (No drag-editor yet; multiplayer Lobby/MatchStrategy still render the DECODE
  `StartPositionEditor` for CR — a latent follow-up, not wired for CR start editing.)
- **PRE-MATCH FIELD RANDOMIZATION via the goal launchers** (manual auto-score/reject).
  `createChainWorld` no longer scatters particles — it STAGES 150 per goal (`state: {kind:
  'flight', target, scored:true, staged:true}`, positioned in the goal box). New
  `prematchRandomize` in `play.ts` flings `CHAIN_PRELAUNCH_PER_TICK` (1) per goal per tick
  onto the field with a randomized arc (~2.5 s to clear both goals). Staged balls are inert
  (skipped in the flight loop) until launched; count stays conserved at 300 the whole time.
  `staged?: boolean` added to the flight `BallState` (serializes fine; worldHash unaffected).
- **Fire-rate tuning:** drum `CHAIN_DRUM_INTERVAL` 0.023→0.0115 (2× faster); turret
  `CHAIN_FIRE_INTERVAL` 0.05→0.0714 (70% of the old rate).
- **Eject spread:** `CHAIN_EJECT_SPREAD` 150→80 (narrower width-wise scatter out of the goal;
  used by BOTH the gameplay recycle eject and the pre-match launcher).

# HANDOFF — 2026-07-19 (Chain Reaction: penalty engine + single sweeper intake)

> **Intake designs collapsed to ONE: `ChainIntakeStyle = 'sweeper'`** (the full-width
> roller). Removed `'roller'`/`'funnel'` from the type, `CHAIN_INTAKES`, the Menu picker
> (now a static info row), and the funnel render branches in `drawRobot.ts`/`RobotPreview`.
> Old saves migrate automatically (coerceSpec falls back to sweeper). CR presets all use
> sweeper. Kept the type open (`'sweeper'` union of one) for future designs.


> **Branch: `chain-reaction` (PRIVATE — do NOT push/deploy until the user says so).**
> **GREEN — `npm run build` (client tsc+vite), `npm run server:check`
> (`tsc -p tsconfig.server.json`), and `npm test` (466 checks) all pass. DECODE is 100%
> unchanged.**

## Latest session — CR penalty engine (`src/games/chain/penalties.ts`)

`updateChainPenalties(world)` runs in `chainStep` BEFORE `updateChain` (so a foul awarded
this tick folds into the alliance total `updateChain` writes — it now adds
`+ scores[a].foulPoints`). CR has no `world.rrContacts`, so the engine does its OWN
OBB–OBB SAT contact test (`robotsContact`, via `robotCorners` + `CHAIN_FOUL_SLOP`).
Rules modeled — both MAJOR, awarded to the VICTIM via the shared `awardFoul`,
EDGE-triggered via `chain.foulEdge` (`${rule}-${offender}-${victim}` keys):
- **G06** — in AUTO, contacting an opponent COMPLETELY inside its own alliance section
  (its x-half, excluding the neutral Particle-Zone diamond) → MAJOR on the aggressor.
- **G05** — in END GAME, contacting an ASCENDING opponent (`chain.endgame[id]==='ascended'`)
  → MAJOR on the aggressor.
NOT modeled (deliberate): G02 plowing + G08 "prolonged restriction" (user: hard to do
well) and **G09 accelerator-exit obstruction (user removed it this session)**. G01–G04 are
structurally enforced; G07 (de-score) is legal. HUD `hud.chain.foulPts/oppFoulPts` +
GameView Results now show a CR PENALTIES row (split out of End Game).

## What this branch is

A SECOND selectable, playable game — **Chain Reaction (CR)**, the 2026 Unofficial-FTC
CAD-competition theme (presented by goBILDA) — alongside DECODE, behind the
**game-abstraction seam** in `src/games/`. Both games are playable incl. online
multiplayer. CR is now a **full game** (not the old shell): particles, accelerators,
catalysts/hooks, beams, endgame, scoring — all implemented.

The seam: `GameSimModule` (DOM-free, server-safe, in `src/games/types.ts` + registry
`src/games/sim.ts`) vs `GameModule` (client, adds canvas renderers, `src/games/module.ts`
+ registry `src/games/index.ts`). Both `moduleFor`/`gameOf` default unknown→`'decode'`.
The server tsconfig has NO DOM lib — it must only ever import `simModuleFor`. DECODE's
colliders live byte-identically in `src/games/decode/colliders.ts`.

## Chain Reaction — how it plays (all in `src/games/chain/`)

- **Field** (`config.ts`, `state.ts`, `drawField.ts`): 144" tile field; ACCELERATORS
  protrude out of each side wall (red left / blue right, `CHAIN_ACCEL_*` = manual mm),
  centered in y. FOUR HOOKS/goal at y=±688mm (`hookPos`, 2 positions × 2 stacked). RING
  STANDS near the 4 corners (climb posts). LAB AREAS = corner squares (park/leave). Central
  white PARTICLE-ZONE diamond (`CHAIN_DIAMOND_R`). Red/blue alliance divider on the vertical
  centre line, flush OUTSIDE the beam (no tape overlap). BEAMS: four **1"-wide** (`BEAM_HALF_W
  =0.5`) black tubes on the x/y axes wall→diamond = difficult terrain.
- **Particles** (`play.ts`, `draw.ts`): 300 white 3" balls, bespoke integrator +
  spatial-hash `separateParticles` (never overlap, no Rapier ball-ball). Conserved: ground
  + flight + hoppers === 300 always (ball reuse, no teleport). ACCELERATOR auto-scores an
  entering particle then REJECTS it back onto the field (further out + randomized spread).
- **Beams** (`beams.ts`, called from `step.ts`): CLEARANCE is the only hard gate
  (`groundClearance ≥ CHAIN_BEAM_HEIGHT`). Given clearance, EVERY drivetrain crosses;
  MOMENTUM dominates (a running start powers over), traction only matters creeping.
  `beamDrag` runs BEFORE `solveRobots` (scales across-velocity so the slowdown persists —
  a post-solve change is wiped by `updateRobot` re-setting velocity); `beamBlock` runs
  AFTER for no-clearance robots (hard wall). Raised clearance → `cogFactor` sluggishness.
- **Catalysts** (`play.ts` `catalystAction`): 4 purple rings START on the ring stands.
  A `catalyst` button (key C / pad LB) picks up a free ring OR de-scores a seated one
  (own or opponent goal), and seats a carried ring on a nearby own hook (+1 pt/particle
  multiplier, `accelMultiplier`).
- **Endgame**: park in a lab area (5) / ascend a ring stand (20).

### CR robot configuration (`RobotSpec` CR-only fields; scoring reworked 2026-07-18)

THREE SCORING ARCHETYPES (`RobotSpec.scoreMode`) — turret aims its own turret; **drum +
dumper are TURRETLESS chassis-wide launchers that AIM BY TURNING** (holding fire steers the
robot to face the goal via `chainAimAssist` in step.ts, then it fires once aligned; autofire
fires opportunistically without hijacking the heading). Both fire a **parallel straight-line**
of particles across the chassis width (`launchLine`, NOT converging on a point). The tall
Accelerator opening HANGS over the field, so these score from a STAND-OFF distance:
- **`turret`** (default) — dye-rotor single-shooter: auto-aims + indexes ONE per
  `CHAIN_FIRE_INTERVAL` (0.05 s) from ANYWHERE (`launchToAccel`, solved arc, never short).
- **`drum`** — chassis-wide flywheel ROLLERS streaming SINGLE particles CONTINUOUSLY: one
  every `CHAIN_DRUM_INTERVAL` (0.023 s ≈ 43/s, fast) ± `CHAIN_DRUM_JITTER` from a RANDOM
  lateral position across the width (`launchAt`) — uniform SPEED, but the pattern is never a
  uniform line. Any range. Rendered as full-width rollers (NOT a channelled drum).
- **`dumper`** — chassis-wide catapult: flings the WHOLE hopper at once within
  `CHAIN_DUMP_RANGE` (56", a real stand-off, not point-blank); opposite-side balls leave at
  ±`CHAIN_DUMP_SIDE_VAR` speed ⇒ scatter (< 100% accuracy). Recovers `CHAIN_DUMP_INTERVAL` (0.8 s).

GOAL INTERIOR + THROW-BACK (in `updateChain`'s flight loop): a scored particle KEEPS its
momentum and BOUNCES around inside the goal box (back/side/floor restitution `CHAIN_GOAL_REST`
+ `CHAIN_GOAL_FRICTION`), funneling toward the wall-side launcher (`CHAIN_FUNNEL_DRIFT_ACC`),
which flings it back onto the field once it's funneled back (near the wall, moving fieldward,
after `CHAIN_FUNNEL_MIN`) or `CHAIN_FUNNEL_S` max-dwell expires — NOT a snap-to-one-x instant
eject. A particle that MISSES the opening is thrown back INTO the field by a human
(`throwBack`; FOR NOW, this rule may change).

ROBOT VISUALS + RESULTS: `drawChainRobot` shows the archetype (turret / full-width flywheel
ROLLERS / catapult bucket) + intake design + hopper bar; the intake reads green whenever it
can still collect (`hopper < cap`). The FINAL SCORE screen (both PvP `Results` and solo
`RecordResults` in GameView.tsx) is CR-aware: Particles ×mult + End Game (no DECODE fouls);
`hud.chain` carries per-alliance `particlePts`/`oppMult`/`oppCatalysts`.

A REAR-SHOOTER build (`RobotSpec.shooterRear`, drum/dumper only): the launcher mounts at the
BACK, so the robot turns its BACK to the goal to shoot (`chainGoalAimHeading` += π, `launchAt`
from the rear edge). Menu toggle + preview + in-game render all honor it.

Three INTAKE DESIGNS (`RobotSpec.chainIntake`, `CHAIN_INTAKES` geometry → `interact`, measured
off the ACTUAL chassis so the capture stays ~robot-sized): **roller** (full-width, 3" bite,
all-rounder) · **funnel** (narrow 55%, 6" reach, precise singles) · **sweeper** (widest +2"
overhang, 4" bite, max volume). CR intake is a WIDE band (multi-ball per tick), PLUS a TIGHT
active-intake PULL (`CHAIN_INTAKE_PULL_R` 5" — deliberately small; draws edge particles into
the mouth for a higher rate without a large reach).

RING PICK/PLACE INDICATOR: `chainCatalystPrompt(chain, rob)` reports pickup/place availability
+ the target; the HUD shows a gold `chip prompt` (PICK UP / PLACE RING) and `drawChainBalls`
draws a highlight ring + link line on the target ring/hook. Rings can be seated on EITHER
goal's hooks (own OR opponent) — `catalystAction`/`chainCatalystPrompt` scan both alliances.

SHOOTING ON THE MOVE: a launched Particle INHERITS the chassis velocity (real physics) and the
shooter LEADS to compensate — a TURRET leads by turning its turret (`turretHeading = leadDir`),
a TURRETLESS drum/dumper leads by turning its CHASSIS heading (`chainGoalAimHeading = leadDir`);
both stay accurate while moving. `leadDir` (play.ts) solves the projectile-lead angle; launch
arcs use the NET (muzzle + inherited) velocity.

HOPPER CAPACITY is DERIVED from archetype × size (`chainStorageMax`/`chainHopperCap` in
chain/config.ts), CM-grounded: G01 = unlimited Particles, G02 bounds control to an
**18×24×18 prism**, G03 lets the robot expand into it — so no fixed count; the MAX is the
one-layer volume `CHAIN_STORAGE_MAX = 48` (18×24 ÷ 3" grid = 6×8). The formula scales chassis
footprint / `CHAIN_STORE_AREA_PER_BALL` (6.5 in²/ball — hex packing + G03 deployed-hopper
expansion past the frame) × an archetype factor: TURRET smallest (0.55, dye rotor + shooter
take center volume), DRUM = DUMPER large (1.0). The `ballStorage` slider's MAX is dynamic;
`coerceSpec` resolves scoreMode BEFORE clamping ballStorage to `chainStorageMax`. Plus
**groundClearance** (0.5–3"). `flywheelInertia`/`canSort`/DECODE intake picker hidden for CR.
(The `cm.pdf` at repo root is now READABLE — `pdftotext cm.pdf` works; the old corrupt copy
is replaced.)

ROBOT VISUALS: `GameModule.drawRobot?` hook (renderer.ts: `mod.drawRobot ?? drawRobot`).
CR's `src/games/chain/drawRobot.ts` shares the chassis + `drawWheels`/`roundRect` (exported
from `render/drawRobot.ts`, DECODE byte-identical) and draws the ARCHETYPE launcher (turret
on top · chassis-wide slotted drum · catapult bucket) + the INTAKE DESIGN + a hopper-fill
bar. `RobotPreview` has a CR variant behind a `chain` prop (Menu + MatchStrategy pass it).

FOUR CR PRESETS (`CHAIN_PRESETS`, shown in place of DECODE's `ROBOT_PRESETS` when
`game==='chain'`): **Sniper** (turret/funnel/swerve) · **Drummer** (drum/roller/mecanum) ·
**Hauler** (dumper/sweeper/tank, big storage) · **Skimmer** (dumper/roller/xdrive, fast).
All coerceSpec-stable so a card highlights when active (`chainSpecMatches`). HUD shows a
TURRET/DRUM/DUMPER chip.

## Wiring touchpoints (both games)

- `src/types.ts`: `World.game?`/`World.chain?`, `GameSettings.game`, `RobotSpec.{ballStorage,
  groundClearance,scoreMode,chainIntake}?`, `ChainScoreMode`/`ChainIntakeStyle`,
  `RobotCommand.catalyst?`, `BallState` `flight` variant `{target,scored?}`.
- `src/sim/spawn.ts` `coerceSpec`: clamps/defaults all four CR fields (enum-checks
  scoreMode/chainIntake). `DEFAULT_SPEC` carries turret+roller defaults.
- `src/sim/physicsEngine.ts`: `solveRobots`/`solveBalls` take `FieldColliders`.
- Net: `RobotCommand.catalyst` → buttons bitfield `BTN_CATALYST=4`; `game` on RoomConfig/
  queue/matchStart/strategyStart, caps-gated (`CLIENT_CAPS` has `'game'`); matchmaking
  `bucketKey` includes game. Persistence short-circuits when `!module.scored`.
- `src/ui/Menu.tsx`: CR archetype + intake-design selectors, CR presets, storage/clearance
  sliders (all gated `!isDecode`). `src/ui/GameView.tsx`: CR HUD (score, PARTICLES/MULT/
  CATALYSTS, HOPPER n/cap, TURRET|DUMPER chip). `src/game.ts` `getHud`: CR `chain` readout.

## Verify / gotchas

- `npm test` (`scripts/smoke.ts`, ~445 PASS lines) is the runtime surface — CR spawn,
  300-particle conservation, catalyst ×5 + de-score, beams (canCrossBeams/beamDragFactor/
  beamBlock), particle non-overlap, wide/multi-ball intake, **dumper in/out-of-range**,
  **intake-design funnel-reach/roller-width**, **CR-preset coerce-stability**. Add one per
  behavior change.
- **Electron GUI verify**: needs `ELECTRON=1 npm run build` first (relative base for
  `file://`), then **`npm run build` again to restore the web base** before finishing —
  do not leave the repo on the Electron build. Driver recipe in `.claude/skills/verify`;
  working scripts this session in the scratchpad (`verifyCR.cjs`).
- Determinism holds (commands + `world.rngState` only) — client prediction / server
  authority / replays are safe for CR. `chainStep` deliberately skips DECODE's
  updateRobotActions/goals/gates/penalties/DECODE-scoring.

## Still approximate (flagged in `chain/config.ts`) — awaiting exact manual numbers

`CHAIN_DIAMOND_R` (diamond size → where beams end), ring-stand exact corner positions
(`CHAIN_RINGSTAND_INSET`), lab-area geometry (`CHAIN_LAB`). Beam width (1") and hook/
accelerator dims ARE exact (manual). Archetype/intake/dump tuning values are a reasonable
baseline, not a frozen spec — tune in `chain/config.ts`.
