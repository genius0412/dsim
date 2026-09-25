<!-- governs: src/games/biobuzz/**, scripts/smoke-biobuzz/** -->
# GAME: BIOBUZZ

> **Status 2026-09-17:** the placeholder wording below predates kickoff; the 2D game is a full scored
> match, and the 3D physics + renderer are described in the last section, "BIOBUZZ 3D".


Read `docs/biobuzz-contract.md` FIRST — it is the lane contract. ⚠️ BIOBUZZ owns no ground-pollen physics: that is the shared solver, so a pollen that looks wrong is a question about `src/sim/`, not a fix to make here.

*Split out of `CLAUDE.md` on 2026-09-16, **verbatim** — CLAUDE.md is loaded into every
session and this is not needed by most of them. The `governs:` line above is read by
`scripts/docaudit.mjs` and by the editor hook, so keep it accurate when paths move.*

---

# GAME: BIOBUZZ (`biobuzz`)

The FTC 2026–27 season. **Rules land at kickoff on 2026-09-12**, so what is in the repo
today is a PLACEHOLDER: an empty 12 ft square with four walls and drivable robots,
`scored: false`, `startLegality: false`, two start anchors. `src/games/biobuzz/{sim,index,
state}.ts` say so at the top and the P0-shell chat replaces all three.

**It is PUBLIC on every channel, since 2026-09-13** (the promotion to production). Its
entry in `SEASONS` (`src/seasons.ts`) carries NO `channels` key, so `seasonVisible` returns
true everywhere: it is in the home picker and the queue counts, visible to the SEO surfaces,
and `/biobuzz/...` resolves on a stable build. It ships to `main` and it deploys to the
stable site like any other season.

This paragraph used to say the opposite — alpha-only, `channels: ['alpha']`, "nothing about
it may be pushed to a public branch" — which was true while the game was built before
kickoff and has been false since the promotion. The `channels` SWITCH is still there and
still works; it is simply not set for this season, and it is what a future unannounced
season would use. What remains alpha-only is the DEV ROUTES (the scene gallery,
`GameModule.devRoutes`), gated by `devRoutesEnabled()` in `App.tsx`'s `devRouteFor` — a
different gate on a different thing.

**Read `docs/biobuzz-contract.md` FIRST** — it is the lane contract: who owns which file
(Lane A the field, Lane B the robot, the integration chat everything outside
`src/games/biobuzz/`), the `elements.ts` interface between them, and the workflow.
`docs/biobuzz-plan.md` is the why; `docs/biobuzz-reference.md` will be the manual
distilled, written on kickoff day.

Everything BIOBUZZ lives in `src/games/biobuzz/`. Nothing BIOBUZZ goes into `src/sim/` or
`src/config.ts` — the same rule Chain Reaction follows. Game state is plain JSON on
`world.biobuzz`, and the sim half obeys the shared determinism rule (no DOM, no clock, no
`Math.random`, no `Date`).

⚠️ **Do not invent geometry before the manual.** CR flags values approximated from
description as `APPROX` and that convention carries over; an unflagged guess is worse than
an empty field.

⚠️ **POLLEN PHYSICS IS THE SHARED ARTIFACT SOLVER WITH `BB_POLLEN_RADIUS`; NOTHING IN
THIS DIRECTORY INTEGRATES OR SEPARATES BALLS.** (The constant is spelled `BB_POLLEN_R`.)
A ground pollen's position is written by `solveArtifacts` and by nothing else — the same ONE
POSITION AUTHORITY rule DECODE's artifacts were rebuilt to. `solveArtifacts` and `robotSolids`
take a trailing optional artifact RADIUS defaulting to `C.BALL_RADIUS`, so BIOBUZZ passes 1.5"
(a 3" pollen) where DECODE passes its default 2.5" and every DECODE call site stays
byte-identical. The SHAPES a pollen meets are this game's own — `bbRobotSolids` (`robot.ts`),
wired through the `GameSimModule.artifactSolids` slot — because the shared `robotSolids` builds
DECODE's front funnel and a BIOBUZZ sweeper is a roller bar on whichever edge `intakeMount`
names. That is GEOMETRY, which Lane B owns; it is not a physics constant, and none is added.
`play.ts` therefore has no ground integrator, no separation pass and no
eviction pass; it calls the shared solve, the shared rolling-friction pass (`stepGroundBall`,
which is the only thing that brings a pollen to rest — the solve has no gravity and no floor),
and a containment clamp, and `interact()` only CAPTURES. BIOBUZZ owns NO ground-pollen physics
constant: `BB_POLLEN_WALL_REST` is FLIGHT-only and `BB_POLLEN_R` is a size, not a dial. So a
pollen behaviour that looks wrong is a question about SHARED physics — write it into
`docs/biobuzz/feedback/` naming the gallery cell, do not fix it here.
`docs/biobuzz/feedback/000-solver-observations.md` is the standing list (no pin/round loop in
BIOBUZZ, a persistent 2.1" overlap under a pressing chassis, a struck pollen reaching
`C.BALL_MAX_SPEED` while the robot that hit it is slower, 5"-artifact rolling constants).

---


# BIOBUZZ 3D (`sim3d/`, `scene/`, `graphics/`, `public/models/biobuzz/`) — Day 1 landed 2026-09-17

Spec: `docs/biobuzz/plan-3d.md` (owner decisions in §12). **One game, two physics.**
`World.biobuzz.physics` is `'2d' | '3d'` (absent reads `'2d'`; read it ONLY through
`biobuzzPhysics(world)`); `biobuzzStep` dispatches to `step2d` (the untouched pipeline above) or
`step3d`. The 2D pipeline is PERMANENT (owner rule): every existing check must stay
byte-identical.

⚠️ **EVERY SERVER-CONNECTED MATCH IS 3D — nobody picks** (owner ruling, 2026-09-18). Record runs,
ranked, matchmade, custom code rooms, spectators and LAN all run `'3d'` for a game whose
`physicsOptions` include it. `Room.physics` is that one line (`serverPhysics`,
`src/games/types.ts`); `RoomConfig.physics` still exists on the wire but no current server reads
it, and the custom lobby's 3D/2D picker is gone. The reason is the RECORD BOARD: two solves
feeding one board is two boards, so `recordLeaderboard`, `personalBest`, `recordRank` and the
career panel all filter to `'3d'` server-side (`boardPhysics`, `server/db/repo.ts`) and
`submitRecord` refuses a 2D container outright. Pre-ruling 2D rows are kept, not deleted. They
are off the LIVE board only: an archived season shows the solve it was played on, so Act 1 is a
2D board (`accounts.md`, "THE ERA IS PER SEASON"). An old client without the `'bb3d'` cap is
now REFUSED (`BB3D_REFUSAL`) rather than downgraded to a silent 2D room.

**2D survives exactly where nothing reaches a board:** solo practice and free drive, via
`GameSettings.practicePhysics` (default `'3d'`; Practice setup has the control). A record run
whose 3D chunk fails to load REFUSES (`RecordRun.tsx` preflights it); only a practice falls back
(`GameView`). Practice-run history (`practice_runs`) keeps its own `physics` tag and is listed
newest-first — it is never ranked, which is what keeps the two eras from meeting there.

- ⚠️ **The "BIOBUZZ owns no ground-pollen physics" rule above is the 2D pipeline's.** `sim3d/`
  OWNS its own solve: one persistent Rapier 3D world per `World` object (`WeakMap` in
  `engine.ts`, rebuilt when `tick` goes backwards or the robot set changes), bodies created in id
  order, JSON→body SYNC before each step (a body is teleported only when its JSON differs from
  what the last readback wrote — no thresholds), READBACK rounded to 1e-4 after. Robots are
  cuboids `length × width × heightIn` (yaw-only, z free; `RobotState.z` = chassis BOTTOM height,
  0 while driving); elements are spheres with CCD when fast; `held`/`stock` have no body; an
  `element` in a flower FALLS and seats where the real bores let it (`flowerTube.ts`, Day 2) —
  it is not parked at a computed height and it is not a fixed body. ⚠️ **A NECTAR SEATS ON
  THE MIDDLE RING** (owner, 2026-09-24): the CAD's 3.896 middle bore passes a 3.6 NECTAR, which
  then sat on the tiles in the retrieval opening, where a ramp dragged it out backing away. The
  middle ring carries a NECTAR-only lip (`BB3_FLOWER_NECTAR_SORT_D` 3.4, `buildNectarSorter3d`,
  `GROUP_NECTAR` / `GROUP_NECTAR_SORTER` in `sim3d/groups.ts`). POLLEN never meets it, and the
  pocket filler excludes the NECTAR bit as well as the element bit. The FLOWER3D lane drives a
  ramp in and back out against it in all four tubes. The hive tray is a JOINTED
  DYNAMIC body — a real see-saw on a revolute joint, held at each stop by a DETENT
  (`applyHiveTilt` / `hiveDetentHold`) rather than driven to an angle; `hiveTiltAngle`
  (`sim3d/tilt.ts`) reads `hive.angle` back off the body. `BB3_HIVE_DYNAMIC` is **`true`**
  (`config.ts`) — the Day 1 line here said `false` "until Day 2 calibrates the see-saw", and the
  KINEMATIC path it described survives as the fallback that constant switches to, which is also
  the shape the PREDICTORS build (`buildKinematicTray`). The shared timer (`hiveTimerStep`, split
  out of `hiveStep` with no 2D change) still runs the 2D pipeline. The spill is PHYSICAL.
  `derive.ts` fills `hives[a].contents` / `flowers[i].stack` and the `element` tags from body
  positions every tick, so `score.ts`, `hud.ts` and the 2D renderers run unchanged.
- ⚠️ **NO ROBOT MEETS A FLOWER'S RING TRIMESH; IT MEETS THE MIDDLE AND TOP PLATES AS SOLID BOXES**
  (`groups.ts`, `GROUP_FLOWER_RING` / `GROUP_FLOWER_SOLID` / `GROUP_CHASSIS`;
  `flowerTube.ts`, `buildFlowerSolids3d`). A trimesh has no inside. A chassis pressed past a
  plate's outer face was pushed out through the plate's top face: up onto the 0.354-in LOWER
  plate (a chassis cannot pitch or roll, so it was held level off the tiles) or, once the lower
  plate was out of the way, down into the tiles under the MIDDLE one, whose top (5.254) sits
  0.046 in under the chassis top (`BB3_CHASSIS_TOP_Z` 5.3). MEASURED (`scratch/flowersweep.ts`,
  8,960 legal drive-ins, all four FLOWERS, eight builds; `scratch/shove.ts`, 1,472 legal shoves):
  before, 1,025 drive-ins and 214 shoves lifted the chassis over 0.1 in and 2 drive-ins left it
  at z 0.34 where 4 s of any drive command moved it 0.004 in; lower plate removed alone, 55
  shoves sank it up to 1.5 in. After: 0 lifted, 0 sunk, 0 parked, deepest plate contact 0.38 in.
  - The lower plate gets no box: the middle plate's footprint contains it and every chassis spans
    the middle plate's z band, so it never stopped a chassis. Elements meet exactly the plates they
    met before, and a deployed ramp meets neither the trimesh nor the solids (the swing guard's
    query has no groups, so it does see the solids).
  - ⚠️ **The three plates are ONE trimesh collider** so each flower still has five colliders.
    Two extra colliders per flower, even set to meet nothing, shift every later handle, reorder
    Rapier's pairs, and flipped two unrelated order-sensitive checks (a hive foot-bar contact
    height, the hive settle clock).
  - Every robot collider carries `GROUP_CHASSIS`, `GROUP_POCKET` or `GROUP_RAMP`, in `bodies.ts`
    and `predict.ts`; one built on the default groups meets the trimesh again.
  - A chassis TELEPORTED more than 1.4 in into a plate is still pushed into the tiles and held.
    Nothing in play puts one there (`bbEvalStart` keeps starts off every FLOWER), but a harness
    that drops robots at random poses will find it. `containmentPass` clamps an out-of-field robot
    to the nearest interior point without looking at statics, which at x ±70.17 is inside a FLOWER.
  - The FLOWER3D lane pins the lift, the hang and the shove.
- ⚠️ **THE HIVE TIPS ON `BB_TIP_POLLEN`, NOT ON THE CONTENTS' WEIGHT** (owner report 2026-09-19:
  "it says 0 more to tip and it does not tip"). The detent used to be a breakaway the load had to
  out-torque, and no calibration can make that agree with a COUNT: measured at the shipped hold,
  8 POLLEN weigh 4560 crammed against the back wall and 8051 in a two-wide line, 7 POLLEN weigh
  4146 to 6769 — the ranges OVERLAP, so no detent value separates the rows, and field guide §12.3
  was being violated in both directions at once. The published table is the rule, `hud.ts` and
  `HudSlots.tsx` promise it to the driver in as many words, so `hiveDetentHold` is a PIN THE
  TABLE LIFTS. Everything after the release is still the free see-saw. `hiveContentsTorque` /
  `hiveRestoringTorque` remain exported: they are how the HIVE3D lane and `hive-calibrate.ts`
  MEASURE the tray, not what triggers it.
- ⚠️ **A CELL COUNTS WHAT IS IN IT, NOT WHAT HAS STOPPED MOVING** (owner report 2026-09-19: "a lot
  of delay registering when the balls land in the hive... a significant amount of lengthened
  tipping time due to the registration time"). `derive.ts` needed `BB3_REST_TICKS` of stillness
  before an element joined `hives[a].contents`, which measured **mean 95 ticks (1.59 s), p90 205,
  max 264** from the tick its centre entered the cell, with 8 of 75 landings never registering at
  all — and `contents` is what the tip trigger, the HUD's "N MORE TO TIP" and §10.5 C all read, so
  the TIP inherited every millisecond of it. Membership is GEOMETRY now: inside the interior AND
  `BB3_CELL_SEAT_DEPTH` below the cell's open rim, which is **mean 0.2 ticks** after entry. The
  depth is what the rest gate was really buying — of 209 arrivals that got a centre inside the
  interior, 92 left again and every one stayed within 2.75 in of the rim (they SKIM the open top;
  nothing crosses the mouth and comes back), against 4.33 in for the shallowest a landed element
  ever rests. Once counted, an element is held by a LATCH read off `b.state` — plain world JSON the
  wire already round-trips, so a peer that rebuilds its engine mid-match agrees — for as long as it
  is anywhere inside the interior; that hysteresis is in `derive.ts` and NOT at the score, because
  `contents` being one list with one reader-set is the whole of why the HUD's promise and the tray
  cannot come apart.
- ⚠️ **AND IT COUNTS ONE CELL — THE ONE `hiveTakingSide` NAMES** (owner report 2026-09-20: "the hive
  tips with nothing inside sometimes... could be when balls are shot towards the hive that is
  actively moving upwards"). `derive.ts` TAGS an element in either cell `hive:<alliance>` — it is in
  the structure, not loose on the tiles, and the AI and the capture read that — but it used to put
  BOTH cells into `hives[a].contents`, which is not a tag list: it is the UP CELL'S LOAD, and the tip
  pin, the HUD's "N MORE TO TIP" and Table 10-2's "remaining in an UPWARD-FACING CELL" all read it as
  one. The down cell's outer face is open at every height, so a MISS dropping past the structure is
  inside that interior for a handful of ticks — and was one more element toward the up cell's tip.
  Measured: 7 POLLEN in the up cell (one short of the table) plus ONE element in the down cell lifts
  the pin, and the freed see-saw then goes over on the seven at tick 330, where seven alone never
  moves; over 28 randomized volleys, 3 counted ids sat outside the up cell across 6 tips and 2 of
  those tips began under-seated. The HIVE3D lane's "DOWN cell" block is the repro. `hiveTakingSide`
  rather than `up` because it is already the game's one answer to which cell is taking, so a driver
  filling the rising tray through the second half of a swing is counted as he fires.
- ⚠️ **AND A TIP THE TABLE CALLED FOR IS COMMITTED TO THE FAR STOP — THE SWING WAS BEING TURNED
  AROUND BY THE GAME'S OWN MECHANIC** (owner report 2026-09-20: "people are still reporting hive not
  tipping in some cases"). `scratch/hivemiss.ts` is the fuzzer: 420 seeded scenarios of turret and
  dumper volleys into the up cell of either alliance, every `BB_TIP_POLLEN` row, full cells, shots
  arriving mid-swing, a robot parked under the tray — judged against an INDEPENDENT geometric count
  (centre inside the taking cell's interior, no seat-depth rule) rather than against `contents`.
  It found the misses in **two** places and neither was registration:
  - **The swing reverses.** `hiveTakingSide` hands over at the release, so a driver firing through a
    swing fills the RISING cell — and that load is torque on the WRONG side of the pivot. Seed 9039:
    a 4P3N cell broke away at tick 204, spilled at level on 299, reached **−24.2°** (five degrees
    short of the far stop) and was turned around there by 1 POLLEN + 3 NECTAR that had landed in the
    rising cell, coasting back to its own stop. The balls dump on the floor and NO TIP is scored.
    `hiveDetentHold` now creeps a stalled swing forward at `BB3_HIVE_TIP_CREEP_W` (0.12 rad/s),
    between the stops only. It is an ANTI-STALL, not a rate: a healthy swing runs 0.20–0.50 rad/s
    and never meets it, so the lane's 8-POLLEN reference swing is **4.12 s free → 4.08 s**. The
    first value tried, 0.25 (the mean rate of a nominal 4 s swing), applied from the breakaway, put
    that reference at **3.12 s** and broke the owner's own `BB_TIP_SWING_S` ruling — a free swing
    accelerates from zero and decelerates into its stop, so a floor AT the mean is well above the
    curve at both ends.
  - **And the state machine had no failure path, which is what made it permanent.** `tipping` and
    `released` could only be cleared at the FAR stop, so a tray that came back sat with `released`
    latched for the rest of the match — `hiveTakingSide` names `otherSide(up)` forever, `derive.ts`
    fills `contents` from the DOWN cell, and the pin, the HUD's "N MORE TO TIP" and §10.5 C all read
    it. The up cell can then be filled to the brim and nothing happens: a dead hive with a lying
    readout. 8 of 420 runs reached it. `hiveDynamicTick` resets to `tipping: 0, released: false`
    when the tray is at rest on its OWN stop, unconditionally on the load — if the table still calls
    for a tip the pin lifts again the next tick.
  **MEASURED, same 420 seeds either side:** 386 armed → 382 tipped with **5 missed** and 8 trapped,
  against 386 → 386 with 0 missed and 0 trapped. Pin lift from the threshold element entering is
  mean **1.0** ticks, p95 **1**, both (the 2026-09-19 geometry membership owns that half); swing
  stop-to-stop mean 176.8 → 174.7 ticks, p95 264 → 251. No phantom: 0 breakaways without a
  table-satisfying up cell either side, and 120 MISS-RAIN runs score 0 tips and move the tray not at
  all either side. The creep flings nothing — spill dispersal is 3895 → 3935 elements tagged at mean
  61.0 → 61.1 in from the pivot, max 106.9 → 106.9. The fast subset, worst seeds included, is
  `commitChecks` in `scripts/smoke-biobuzz/hive3d.ts`.
- ⚠️ **`BB3_HIVE_DYNAMIC = false` IS NOT THE ONE-WORD REVERT IT IS DOCUMENTED AS.** `bb.spill` —
  G409's entire tag — is written only inside `hiveDynamicTick`; the kinematic path never writes
  it, and all four G409 checks sit inside `if (BB3_HIVE_DYNAMIC)` blocks, so flipping the word
  kills G409 in 3D **and leaves the lane green**. Restoring the kinematic tray means porting the
  spill tagging and un-gating those checks first.
- ⚠️ **A LINE §10.5 ASSESSES AT AN INSTANT IS WORTH ZERO UNTIL THAT INSTANT PASSES** (owner
  ruling, 2026-09-19; shared rules code, so it binds both pipelines). LEAVE and AUTO PARK at the
  end of AUTO (F), TELEOP PARK at the end of the MATCH (G), the up-CELL contents at rest at the
  conclusion (C), the GARDEN at the end of TELEOP at rest (E). The TIP and both FLOWER lines are
  continuous (A, D) and are paid live. The COUNT stays live either way — that is the driver's
  readout — and `BbAllianceScore.pendingPts` carries what the instants still owe, shown as its
  own chip and never inside `total`. Before this, the bar read 9 one second into AUTO.
- **Determinism:** the source guard in `scripts/smoke.ts` scans `sim3d/`; `dsin/dcos/datan2/hyp`
  only; the SIM3D lane hashes two runs. Renderer files MUST be `scene/render*.ts` (the guard
  exempts `draw*`/`render*`, and the RENDER lane asserts `three` is imported nowhere else).
- **Rapier 3D gotchas, each shipped as a bug once:** forces and torques PERSIST across steps —
  `resetForces`/`resetTorques` every tick before applying the wrench (the 2D world is rebuilt per
  step, so it never had to); the robot collider footprint is `robotExtents` (intake reach), not
  the bare chassis (a wall-flush start position touched the wall in 2D only, which read as a 30×
  yaw gap); wall friction `PHYS_WALL_FRICTION` and the solver iteration parameters must be SET
  (the 3D defaults differ from the 2D solve); `RigidBodyDesc` uses `enabledRotations`;
  `JointData.limits` do not clamp — call `setLimits` on the joint; a 0.25-in kinematic plate needs
  a 0.75-in collision skin or a 260 in/s shot tunnels; `src/sim/spawn.ts` `coerceSpec` must carry
  `heightIn` across the way it carries `bbMech`; the rest-speed snap must run EVERY tick under
  the threshold (a one-shot edge let contact bias walk a settled line 2 in).
- ⚠️ **THE OFF-FLOOR REST SNAP FROZE A BALL IN AN UNSTABLE PERCH RATHER THAN LETTING IT FALL**
  (owner report 2026-09-20: "balls are able to get stuck on top of the biobuzz panel with
  seemingly nothing actually holding it up"). `scratch/ledge-table.ts`'s CAD survey found the
  mechanism: every physical hive-frame/flower-support hull (`PHYSICAL_STATIC_CLASSES`) measures
  narrower than a POLLEN (2.8in) or has NO flat top at all — a single decimated vertex or ridge, a
  round tube or angled beam tessellated to 8–16 points. A real ball on that would roll off from
  any disturbance, but the rest snap zeroed its velocity every qualifying tick before gravity's
  own tangential pull could build enough speed to read as moving again. A rain probe
  (`scratch/rain-probe.ts`, both ball sizes, zero and lateral drop velocity, 600 ticks) found
  132/1404 drops over every physical static ending elevated and untagged, worst on the base-level
  foot bar (20/90). `groundRoll3d` now skips the hold for an UNTAGGED (`state.kind !== 'element'`
  — a cell/tube member is untouched) element touching ONLY a `ConvexPolyhedron` — the shape both
  CAD hull classes build with, fixed OR on the DYNAMIC hive tray alike, and nothing else in this
  build — and gives it a tiny deterministic "vibration" instead: a hash of `(id, tick,
  world.rngState)`, rngState READ-only and never advanced, `dsin`/`dcos` only. MEASURED after:
  88/1404 (every representative structure at or near 0/90 except a couple of exact-coordinate
  hull-intersection corners a vibration cannot punch through — a true multi-hull cage, confirmed
  by retesting at 2–3× the shipped kick with no change — and the flower's own hardware, wedged
  partly against its ring plate's genuinely broad TRIMESH, which this fix deliberately still
  counts as legitimate support). The vibration gives up after `BB3_VIBE_GIVEUP_TICKS` (30) and
  freezes like the old snap: a wider budget (90) cleared more of the probe (59/1404) but let the
  "parked elements on the HIVE finalize on the HOLD" settle check regress from 31 ticks to 398,
  because an element can chain through several perches on the way down and each restarts its own
  budget. `step3d` perf unaffected (measured 0.305 ms/tick with five perched elements, budget
  1.5); two-run determinism holds. Checks in `scripts/smoke-biobuzz/hive3d.ts`.
- ⚠️ **THE HIVE FOOT BAR IS A CHANNEL, NOT A SOLID BLOCK** (owner, 2026-09-20, second report the
  SAME day as the strafe-catch fix above: "balls are able to get stuck on top of the biobuzz
  panel with seemingly nothing actually holding it up" / "an invisible wall/bump wherever the
  drawn bar is lower than 2.15 in"). The strafe fix folded each `am-5878 Sheet Metal Foot Bar` and
  its two `am-5879 Frame Foot` pads into ONE box at the union's full AABB — 1.98 in wide × 38.94 in
  long × 2.15 in tall, EVERYWHERE. MEASURED off the shipped GLB (`scratch/footbar-ramp-fine.ts`,
  `scratch/footbar-comp2.ts` — whole-connected-component `zMax`, the rule `GROUND_BEAM_MAX_Z`'s own
  header warns a per-triangle test gets wrong by slicing the A-frame leg's own flared foot into the
  bucket, which very nearly overlaps this bar's x-range): the true cross-section is a shallow
  pressed channel, a back flange ramping ~0 → 2.14 in over 0.62 in of width then dropping sharply to
  a floor at **0.02–0.10 in** for the remaining **1.32 of its 1.98-in width**, the whole 38.94-in
  length between the two feet. `slimFootBars` (`fieldColliders.ts`) narrows the bar's own box to a
  `FOOT_BAR_FLANGE_W` (0.66 in) flange at the true outer face, drops the floor collider entirely
  (rounds to zero, same treatment as the flower under-field brackets a line below), and boxes the
  two feet at the bar's FULL original width so they still cover the true wider floor near their own
  ~2.3-in ends. ⚠️ **THE FLANGE AND THE FEET MUST TOUCH, NEVER OVERLAP** — a first pass boxed the
  feet sharing the flange's exact outer face (geometrically the "obvious" fix), and two coincident
  static Rapier colliders froze a strafing chassis dead at y≈8.8, nowhere near either foot;
  narrowing the overlap to a hair's width still cost a dip to 1.9 in/s. Building the feet at
  `[flangeInner, fullInner]` (touching the flange's own inner face, never covering its span) removed
  it outright. MEASURED after: the strafe check is clean at every sampled y (not merely above the
  3 in/s floor), a chassis driven in from the field's own driving lanes crosses the 1.32-in floor
  without slowing and stops flush at the real flange, a ground POLLEN rolls across the same floor
  without deflecting, and `containmentFixes` stays 0 for a chassis spawned where the old box used to
  be solid. KNOWN RESIDUAL: the flange's own 0.62-in ramp is still one box at the plateau height
  (a box cannot follow a ~3.2-in/in slope without ~20 steps to hold 0.1 in everywhere), and the
  feet's own faceted top (bolt holes, bevels) is smoothed by their box the same way — both narrower
  than the 1.98-in bug this fixes and both pre-existing at that scale. Checks appended in
  `scripts/smoke-biobuzz/sim3d.ts` right after the strafe check.
- ⚠️ **AND THE TWO "KNOWN RESIDUALS" THAT FIX SIGNED OFF ON WERE THE OWNER'S INVISIBLE CORNER**
  (2026-09-21, the fifth report of it: "this invisible corner in the center structure is STILL not
  fixed"). Both are the same mistake the wide floor was, one axis over: a SQUARE-TOPPED BOX
  standing on a RAMP. MEASURED off the shipped GLB at 0.02 in (`scratch/footprofile2.ts`;
  `scratch/hivetop.ts` is the per-plan-cell collider-top-vs-drawn-top table), all four corners
  agreeing to 0.01 in: ACROSS the bar the drawn top is **0.24 in at the true outer face** and rises
  linearly at **3.44 in per in** to the 2.15-in plateau, so the flange box stood up to **1.91 in
  above the drawn bar** over the outer 0.5 in of its width for the whole 38.9-in length; and ALONG
  it the whole assembly **ENDS IN A RAMP** — 0.16 in at the end, rising at **2.144 in per in** to
  full height 0.92 in in — so each of the centre structure's **four outer corners** carried a
  **1.94-in-tall block** over a chamfer that is 0.19 in tall where the block is 2.13.
  ⚠️ **THAT IS WHY FOUR DRIVING PROBES MISSED IT AND THE REPORT SURVIVED THEM.** A BIOBUZZ chassis
  is a floor-to-roof prism to a static, so it is stopped by a 0.16-in lip exactly as by a 2.15-in
  one: the plan EXTENT was always right and a collider that is the right width and the wrong height
  cannot move a robot at all (measured either side, worst shortfall to drawn structure 0.170 →
  0.180 in over 120 approaches, 0 stops more than 0.25 in short, in BOTH physics). What it moved
  was everything with a HEIGHT — a POLLEN set down on any corner rested at **2.13 in in mid-air**,
  which is the owner's whole complaint and the same sentence ("nothing actually holding it up") the
  wide floor drew. Pictures: `scratch/shots/hivecorner-{before,after}-*-ball.png`.
  **THE FIX** keeps `slimFootBars`'s six pieces and makes each one hull of its own true polytope
  (`z ≤ min(TOP, NOSE_X + RISE_X·dx, NOSE_Y + RISE_Y·dy)` — an intersection of half-spaces, so the
  hull of its vertices IS it, exactly, at the four section heights where its two breakpoints live).
  The faces that slant are the top ones the ramp really has; every face a chassis can reach stays
  VERTICAL at the part's full plan extent, because the solid is at full extent up to the nose
  height. ⚠️ **SIX PIECES IS ITSELF PART OF THE FIX.** A stack of receding BOXES is the obvious
  build, has no slanted face at all, and works — four steps sat within 0.043 in of the drawn
  surface — but it adds 24 static colliders, and a collider COUNT is not a local change: every
  handle made after it shifts and Rapier's islands reorder. MEASURED, that flipped one
  edge-of-envelope case 60 in away (the ramp ground-capture sweep's −7.65 offset, the extreme corner
  of the mouth) at 3, 4, 5 and 6 steps alike, while the same six pieces with entirely DIFFERENT
  heights left it untouched. Geometry is local; the count is not.
  **MEASURED AFTER** (`scratch/hivetop.ts`, 0.05-in plan cells against `field.glb`): the bars go
  from **1.99 in over 17.92 in²** of invisible solid to **0.02 in over 0.00 in²**; each foot from
  **2.06 in over 1.13 in²** to **1.26 in over 0.06 in²**. KNOWN RESIDUAL, stated rather than
  widened away: that last 0.06 in² is the foot pad's own inner edge, which is chamfered on a
  DIAGONAL in plan (its inner face runs from x 22.90 at |y| 18.5 to 23.20 at 19.47) where this model
  carries a rect section — a strip about 0.1 × 0.6 in, far under the footprint a 2.8-in POLLEN needs
  to rest on, and `groundRoll3d`'s narrow-hull vibration exists for exactly that scale. Checks in
  `scripts/smoke-biobuzz/sim3d.ts` under "THE INVISIBLE CORNER": the RULE (no piece above the drawn
  profile, with the square-ended box it replaced failing the same rule by 1.99 in so it is not
  vacuous), the ELEMENT (a POLLEN set on any of the four corners falls), the ROBOT (every stop
  position unchanged), and the 2D pipeline's own pair — whose frame bars ARE the rects
  `drawField.ts` fills, one construction read twice, so 2D has no invisible corner to slim.
- ⚠️ **AND THE SIXTH REPORT WAS NOT THE FIELD AT ALL — THE INVISIBLE THING WAS THE ROBOT**
  (2026-09-21: "try putting the front of the robot against the center of the horizontal beam, and
  strafe, from under the hive. You will suddenly turn because you hit something invisible").
  `chassis3dShapes` built the frame, both intake arms, the lintel and the pocket filler at the FULL
  `heightIn` over the whole footprint — a floor-to-roof prism, 14 in on a default build. The DRAWN
  robot is a **5.3-in** chassis with a mechanism standing up only where it is bolted. MEASURED with
  the owner's own manoeuvre (`scratch/beamstrafe.ts`): the chassis jammed at y −3.89 with its −y
  edge at −12.39 and yawed 3° at the kick, 11° after 5 s — and the only non-floor contact was the
  hive's **A-FRAME LEG**, whose underside crosses z ≈ 14.1 at that y. The robot was being stopped
  by its own roof, 8.8 in above anything drawn there. Five earlier passes missed it because all
  five looked at the FIELD.
  **THE COMPOUND IS THE DRAWING NOW** (`chassis3dShapes` + `chassis3dMechShapes`; the measurements
  are `BB3_CHASSIS_TOP_Z` / `bbMechEnvelopes` in `config.ts`, taken off the built meshes' own
  vertices over every archetype the builder can make — `scratch/drawnheight.ts`,
  `scratch/mechenv.ts`): a LOW BODY to **5.30** in (frame top cap 4.80, nose 5.10, sweeper roller
  5.25, intake arm 5.26) carrying the unchanged plan logic — arms, lintel, mouth slot, the edge-break
  skin, `GROUP_POCKET`, the reach hardware — plus **one tall shape per standing mechanism**: a
  CYLINDER per turret head (POLLEN r **5.04** top **11.31**, NECTAR r **5.56** top **12.12**) and a
  BOX for a dumper (top **12.80**, its own edge-frame extents reproduced from `mounts.ts`). A turret
  is a cylinder because it AIMS ITSELF — the collider is built once per deploy edge and the head
  yaws every tick, so the disc it sweeps IS its drawn geometry, the same bargain `bbRampSwingShapes`
  makes. Each shape is CLAMPED into `robotExtents` in plan, because a drawn head overhangs its own
  rail by up to 1.45 in on an edge mount with no intake reach there and the wall-flush START POSES
  are seated on that footprint.
  ⚠️ **`spec.heightIn` IS A CAP NOW, NOT AN EXTRUSION.** R102/R105, `bbDeployedHeightIn`,
  `bbStowHeightIn`, `bbStowLegal` and the deploy-edge rebuild are all untouched — they are spec
  rules and none of them ever read a collider — but a declared height no longer makes the robot
  tall anywhere. The dial promises a height the picture does not build (the builder draws it as a
  DASHED ENVELOPE, `buildHeightEnvelope`, precisely because no mesh stands that tall) and the
  PICTURE WINS: extruding a declared 29 in over the turret's footprint would have kept 17 in of
  invisible column exactly where this report puts it. MEASURED, that is the only behaviour a
  declared height still had: of 69 fixed colliders, everything a robot can reach above the deck is
  VERTICAL over it (walls, the flower columns 4.25…21.25, the hive frame) except the four sloping
  A-FRAME LEGS and a 0.9-in rim on each flower top plate — so "declared taller ⇒ stopped sooner"
  only ever meant "gets less far under the hive", and it was never drawn. The one check that
  depended on the prism was the drive-under's own NON-VACUITY probe (a 34.98-in robot stopped by
  the tray); it is a free SHAPE QUERY now, which proves the same thing without a robot shape that
  does not exist.
  **MEASURED BEFORE/AFTER**, same 32 cases — both bars, both strafe directions, mecanum/x-drive/
  swerve/butterfly, robot- and field-centric (`scratch/beamsweep.ts`, with
  `__setLegacyPrismForTests` rebuilding the prism so the comparison is one process):
  travel before the heading first moves 1° **min 3.21 → 7.40 in, mean 3.89 → 18.06**, and the worst
  contact-in-air at the stop **8.575 in → 0.163**. The general rule is the same one the foot-bar fix
  used, one level up: over **171,217** sampled chassis/static contacts across five builds and a pose
  grid round the whole centre structure, the flowers and the walls (`scratch/aircontact.ts`), every
  contact point lies within **0.377 in** of the drawn robot — and that worst case is a LATERAL skin
  artefact at an arm tip, not a height one. The tolerance the lane binds at is **0.3 in**, which is
  built rather than picked: the edge-break contact skin is 0.15, Rapier's speculative margin looks
  ahead of the surface, and `BB3_CHASSIS_TOP_Z` itself sits 0.04 over the tallest drawn part.
  **WHAT ELSE MOVED, ALL MEASURED:** the FULL predictor takes the same profile (a low
  `robotExtents` cuboid plus the same mechanism shapes — the mouth pocket stays the documented
  cheap-reconcile trade, the height profile does NOT, because it decides which contacts happen at
  all); `step3d` on a 2v2 is **1.024×** (0.141 → 0.144 ms, 5 paired alternating rounds, +1 collider
  per default robot); TURRET accuracy is unchanged-to-better over a 3-archetype × 20-stand sweep
  (72→73, 68→70, 68→68 of 80, nothing ever unlaunched); the side-roller and ramp retrieval sweeps
  and the hive tip are untouched; two-run determinism holds. The DUMPER's documented close-range
  limit moved **22 → 24 in** (scored of 4 by distance: 22 **1→0**, 24 **2→3**, 26 and beyond 4/4
  either side, with the release point identical at 10.69 in out / z 14.00) — a four-ball volley's
  own in-flight collisions resolve differently once there is no roof to meet, at the range where
  the volley is marginal anyway.
  **AND A POLLEN CAN LAND ON THE REAL DECK NOW**, which the prism made impossible to see. It RESTS
  there (a deck is genuinely broad and flat, and `groundRoll3d` keeps a `Cuboid` contact BROAD), it
  is never tagged and never captured (its bottom sits at 5.3, above `BB3_INTAKE_Z` 5, and it is
  inside the frame rather than in a mouth rect), it is conserved, and it falls the moment the robot
  drives out from under it. A POLLEN perched on a turret's swept disc gets the other answer on
  purpose: **a `Cylinder` is NARROW to `groundRoll3d` now**, alongside `ConvexPolyhedron`, because
  every cylinder in this world is a round robot part — a turret's envelope or a side roller's wheel
  — and a ball on the flat top of one is resting on something not drawn there, which is the exact
  class the narrow-hull vibration exists for. Checks in `scripts/smoke-biobuzz/sim3d.ts` under "THE
  INVISIBLE ROBOT": the RULE, the REPRO (with the prism failing it by 8.5 in, so it is not vacuous),
  and the two ELEMENT cases. Pictures: `scratch/shots/invisbox-{before,after}-{side,along}.png`.
  KNOWN RESIDUAL, stated rather than widened away: a dumper MID-THROW reaches ≈14.3 in for ~0.3 s
  — a drawn part outside the collider, the harmless direction, and it was outside the old prism
  too. (The Box Tube's flat cradle, drawn to 6.55 with no tall shape, was the other residual; the
  tube is a standing tower now and its stowed envelope is two collider boxes — see the Box Tube
  bullet under the shot path.)
- ⚠️ **A CHASSIS PLACED INSIDE THE HIVE FRAME IS SET DOWN BESIDE IT, NOT ON IT** (2026-09-25).
  `scratch/rampstuck.ts` froze 8/400 random drives (14/400 on another seed, both builds) with the
  robot at z ≈ 2.1 on a foot bar or frame foot. Every one of them STARTED inside the frame; 0/1200
  runs that started clear ever climbed, and a 2v2 ram probe never lifted a robot. The solver's
  shallowest way out of a 2.15-in bar under a 16-in chassis is UP (z 0.50 after one tick), and the
  A-frame leg then runs between the frame box and an intake arm, pushed from both sides, so no
  drive command moves it, even with zero friction. `setChassisClear` (`engineImpl.ts`) runs on a
  POSITION the solver did not produce (a new body, a gameplay move, the deploy-edge rebuild): a
  chassis more than `BB3_FIT_DEPTH` (0.25 in) inside a fixed collider is moved sideways, same
  height and heading, to the nearest clear spot (rings 0.5 in apart, out to 24 in). Rules: fixed
  bodies only (they never move, so it is order-independent mid-sync); the chassis only, never
  the reach hardware (a ramp blade in a static stays the swing guard's and the embed fold's call);
  NOT on a heading-only edit, because `squareUpRobotsWalls` turns wall-touching robots every tick
  and re-testing those moved a robot that another robot was pressing into a static past 0.25 in
  (6 mid-match moves in 150 ram runs; 0 after). Three older
  checks had been staging robots across the red foot bar without knowing it (the foot-bar
  "containment" spawn and two sweeper capture probes at x −20) and passed with the robot perched;
  they stage clear of the frame now. Smoke: "hive frame:" ×2 in `sim3d.ts`.
- **Drive feel is the shared wrench.** Parity checks measure in OPEN FIELD: two solvers' wall
  contact legitimately differs; the drive model itself matches 2D to four decimals.
- **Field geometry is CAD-derived** (owner decision 2026-09-17, licence risk accepted).
  `npm run field-cad` (cache OUTSIDE the repo at `%LOCALAPPDATA%/dsim/field-cad/`: the sha-pinned
  STEP v26-27.2 zip, a CadQuery venv) writes `public/models/biobuzz/{field.glb, field-low.glb,
  field-colliders.json, field-measurements.json}` and `sim3d/fieldColliders.gen.ts`; the README
  there has the source, node names and schema. The scene loads the GLB (constants-built fallback
  in `renderField.ts`, kept geometrically right against `drawField.ts`); the physics takes the
  collider hulls/trimeshes with the floor and walls analytic. GLTFLoader strips `/` from node
  names — look them up by `userData.name`. Read `docs/biobuzz/field-cad-audit.md` before touching
  the pipeline.
- ✅ **RESOLVED 2026-09-18 — THE CAD IS AUTHORITATIVE FOR DIMENSIONS (owner ruling).** The two
  OPEN findings are closed by moving the CONSTANTS, not by widening a tolerance. **Nothing types a
  BIOBUZZ field dimension any more:** `scripts/field-cad/emit-dims.mjs` turns
  `field-measurements.json` into `src/games/biobuzz/fieldDims.gen.ts` (`FIELD_HALF`, `TILE_PITCH`,
  `TILE_SEAMS`, `FLOWERS`, `FLOWER_D`, `HIVE`, `TAPE`, `LZ`, `GARDEN`, `ALLIANCE_AREA`), with the
  derivation and the four-instance residual of every value in its header, and `config.ts` reads
  it. The field is **±70.674** (141.35 inside, not 144), the tile pitch is **23.528** (`C.TILE`'s
  24 is DECODE's and CR's; BIOBUZZ draws `BB_TILE_SEAMS`, the seven measured seam lines), the four
  flower positions are the CAD's own least-squares ring-bore centres, and `BB_HIVE_BOTTOM_Z` is
  **31.981** — the one figure where the CAD and Fig 9-10 genuinely disagree. A legal 29-in robot
  still clears the lowest structure (30.652), so G409's drive-under survives; a dumper standing 6
  in off its own cell no longer does, because its lob clips the higher underside. The 3D walls'
  "stay at 72 for parity" exception is GONE — the constants ARE the CAD — and the SIM3D lane's
  `one field` check asserts the 2D collider faces, the 3D collider faces and the CAD/GLB faces
  agree within 0.05 in. Tape is the CAD's 16 measured strips in BOTH renderers (`BB_TAPE`), never
  an outline of a zone rectangle, all of them **one width, `BB_TAPE_W`** (the CAD's 1.000 in, NOT
  the shared `C.TAPE_W`, which is DECODE's field and equal by coincidence) — and **there is no
  centre mark**: Event Field Guide V1.0 §8 tapes the LOADING ZONES, the GARDENS and the ALLIANCE
  AREAS and nothing else, and guide §9.1 has the four centre tiles come OUT for the frame, so the
  origin is bare tile under the HIVE. Both renderers drew a white cross there at tape width; the
  RENDER lane now runs `drawBiobuzzField` against a recording context and fails on any white line
  inside the perimeter. A `fieldDims.gen.ts` that drifts from the measurements JSON
  fails the SIM3D lane, which re-renders it and diffs byte for byte. `docs/biobuzz-reference.md`
  carries the ruling and the full before/after table.
- ⚠️ **THE CAD GLB IS WOUND AT RANDOM, AND THE LOADER RE-ORIENTS EVERY SHELL** (owner report
  2026-09-21: "a lot of mounting brackets, especially black and gray ones with complex geometry,
  have holes in them from different angles and they are glitchy and broken"). MEASURED over every
  mesh and every welded connected component of both shipped GLBs (`scratch/bracket-winding.ts`):
  **193 of `field.glb`'s 193 components are closed shells with MIXED winding** — 0 boundary edges
  anywhere, and orienting each shell outward reverses **132,190 of 268,892 triangles (49.2 %)**.
  Confirmed independently by RAY PARITY (`scratch/wparity.ts`), which never looks at winding:
  36–56 % of sampled faces on the hive frames point INWARD, 34–50 % on the flowers, **69–76 % on
  the perimeter rails**. `THREE.FrontSide` was deleting about half of every part on this field.
  Two earlier passes saw a slice of this and mis-named it, and both mistakes are instructive:
  `fixGroundBeamWinding` (2026-09-20) patched three ground bars with `DoubleSide` and took the
  A-Frame Top Corner as a healthy REFERENCE because its volume ratio landed inside its own bbox —
  it is 46.6 % reversed, and a scrambled shell's divergence sum is a number with no meaning;
  `CLEAR_SHEETS_ARE_SINGLE_SIDED` (2026-09-19) read `sheetFacingBalance`'s "every plane 100 / 0"
  as open sheeting, when a 0.020-in slab puts both faces in ONE plane cluster and 100 / 0 means
  the two faces wind the same way. `repairFieldWinding` (`renderFieldGlb.ts`) replaces the
  ground-beam pass: per connected component it propagates orientation across shared edges, turns
  each face-island outward by its own signed volume, and rewrites the INDEX only — before
  `styleScene`, so `computeCreasedNormals` reads the corrected winding and there is no second
  place for the two to disagree. Ray parity after: **44.9 % inward → 1.7 %** on `field.glb`.
  `DoubleSide` survives only for a genuinely OPEN component (boundary edges over
  `OPEN_SHELL_BOUNDARY_FRAC`, 3 %), which on the high LOD is **none at all** — the field is now
  entirely single-sided and the 6,690 triangles the ground-beam patch doubled are back on the
  cheap path — and on `field-low.glb` is 2,518 of 83,728 (3.0 %), where the simplifier opens real
  holes. Cost: 92–137 ms once at load on `field.glb`, `assembleFieldGroups` 152 → 214 ms,
  +1,270 vertices (+0.3 %); keyed by GEOMETRY, so the four flower nodes that share six geometries
  pay once. ⚠️ **THE CLEAR PANELS ARE SKIPPED ENTIRELY** — their winding, normals and `DoubleSide`
  material are untouched, because the dielectric tuning above was all fitted against the asset as
  it ships and a repair under them would halve the layer count the veil was sized for; the RENDER
  lane pins that their winding is byte-identical to a fresh parse, with the opaque ACM board
  (same `plastic#e6e6e6` name, not a clear panel) as the control that the digest can see a change
  at all. The real defect is the exporter's, and `public/models/biobuzz/README.md` carries the
  note; this is a no-op the day `convert.py` orients its tessellation before merging.
- **GRAPHICS SETTINGS ARE PER DEVICE, AND THE SCENE SUBSCRIBES TO THEM** (Day 3, plan §4.4–§4.6).
  `graphics/settings.ts` is the model — the seventeen dials (§4.4's sixteen plus
  `elementDetail`, below), the four preset columns, the 0.6/1.2/2.2/4.0 MP pixel budgets,
  `localStorage['decodesim.graphics']` with field-by-field coercion. `graphics/auto.ts` is the POLICY (first guess → two-second warm-up → the in-match
  slip rule) and takes its clock as a PARAMETER, because `smoke.ts`'s determinism guard greps
  this whole directory for `performance.now()`. Nothing under `graphics/` may import `three` or
  `scene/` — it is read by `src/ui/GraphicsSection.tsx` and `src/contributors.ts`, both ordinary
  main-bundle files, and the RENDER lane asserts it. All but one apply LIVE; mesh detail
  needs the next 3D view (it picks the GLB) and SSAO/SMAA are **not offered on this build**
  (`GFX_NOT_OFFERED` carries the reason, and the UI prints it).
  - ⚠️ **THE SCORING ELEMENTS ARE THE REAL PERFORATED CAD SOLID ON HIGH AND ULTRA** (owner,
    2026-09-21: "For higher graphics settings, model the balls accurately with the holes.
    Consider grabbing the actual accurate cad"). `public/models/biobuzz/elements.glb` is a REAL
    EXTRACTION from the SAME sha-pinned field STEP, not a model by eye: `convert.py` drops the
    staged POLLEN/NECTAR (`RE_ELEMENT`) because they are not field STRUCTURE, and
    `scripts/field-cad/elements.py` + `elements.mjs` (`npm run element-cad`) pull the two solids
    out of the same zip. Each is an outer sphere, an inner sphere and **26 radial bores** in a
    1/4/8/8/4/1 latitude stack — POLLEN r **1.400** in, wall 0.070, bores ⌀0.440, 2,286 tris;
    NECTAR r **1.810**, wall 0.085, bores ⌀0.635, 2,542 tris. The README beside the asset carries
    the full table, the licence note (same zip, same terms, same 2026-09-17 decision) and why
    there is no `simplify` pass.
    - ⚠️ **`BB_NECTAR_R` AND THE CAD DISAGREE BY 0.010 in AND THE CONSTANT WAS NOT MOVED.** The
      CAD is authoritative for dimensions (2026-09-18) but that radius is the sphere Rapier
      solves and the number every flower/hive/intake tolerance was measured against, so it is a
      SIM decision, not a renderer's. The drawn NECTAR is 0.55 % wide until somebody rules; the
      delta is in `elements-measurements.json` and PINNED by the RENDER lane so it cannot grow
      unnoticed. POLLEN agrees exactly.
    - ⚠️ **THE WINDING IS THE WHOLE ASSET.** A holed ball is looked THROUGH, so its inner sphere
      and its 26 bore walls face the camera through the near-side holes. `elements.py` applies
      each CAD face's own `TopAbs_REVERSED` orientation before emitting a triangle — which
      `convert.py` does not, and which is the root of the field GLB's own mixed-winding trouble —
      so every triangle faces away from the material and ONE single-sided material renders the
      shell correctly from both sides. No `DoubleSide` anywhere: it would double the shadow pass
      and light the cavity's far wall as an outer surface.
    - ⚠️ **`geometry.applyMatrix4` IS THE WRONG WAY TO BAKE A `meshopt` ASSET.** POSITION arrives
      as a NORMALIZED `Int16Array` (`KHR_mesh_quantization`) with the scale on the node, and
      `applyMatrix4` writes transformed floats straight back into that Int16 array. Measured on
      this asset, the obvious spelling turned two clean shells at r 1.33/1.40 into a smear of
      radii from 0.60 to 1.40. `renderElementsGlb.ts` reads through `getX/getY/getZ`.
    - **The gate is `elementDetail`, a row of its own, and NOT `meshDetail`** — that one is
      already `high` on Medium (it is `low` on Low alone), and 100 perforated balls plus 100 more
      shadow casters is exactly what the Medium column exists to avoid. Sphere / sphere / CAD /
      CAD, applied LIVE, and the fixed-High replay export (§4.7) inherits the CAD ball with no
      branch of its own. The cheap `SphereGeometry` is built FIRST and always: it stands while
      the 22 KB fetch is in flight and forever if it fails (one `console.warn`, the same shape as
      `buildBiobuzzField`'s fallback), and `createBiobuzzScene` pre-warms the asset alongside
      `field.glb` so an export never draws a sphere on its first frame. MEASURED with all 56
      elements loose and in frame (`scratch/ballperf.cjs`): **9,408** element triangles on Low
      and on High-with-spheres against **132,112** on High-with-CAD, inside a scene total of
      137,510 / 337,714 / 462,098 — and on High/Ultra the sun's depth pass submits the element
      half again. The CPU side of the per-frame loop (the roll integrator and the instance
      writes, GL-free, `scratch/ballcpu.mts`) is **0.0071 ms/frame** for 56 rolling balls,
      0.0048 with `effects: 'minimal'`. No wall-clock GPU frame time is quoted: offscreen
      Electron has no timer-query extension and composites on the CPU at a capped rate, so any
      number taken there would describe the capture harness.
  - ⚠️ **AND THE ELEMENT MESHES ARE `frustumCulled = false`, WHICH IS A BUG FIX, NOT A
    SHORTCUT.** Three computes an `InstancedMesh`'s bounding sphere ONCE, lazily, from whatever
    the instance matrices held at that moment, and `instanceMatrix.needsUpdate` does not
    invalidate it. Every hidden instance is `makeScale(0,0,0)` AT THE ORIGIN, so the NECTAR mesh
    — 16 balls, all of them off-field `stock` at the start of a match — took a bounding sphere at
    the centre of the field and was then culled outright by any camera aimed away from it.
    MEASURED on the scene-preview page: a NECTAR dropped on the tiles at (15, −40) cast a shadow
    and drew NOTHING, because the shadow pass culls against the sun's own field-wide frustum and
    was unaffected — which is what makes this read as a material bug rather than a culling one.
    Nothing is bought back by fixing the sphere instead: two draw calls whose instances are
    scattered over a 141-in field are inside the frustum on essentially every frame.
  - **And each `InstancedMesh` now draws its LIVE count, not `CAP`.** Free at 176 triangles of
    sphere; not free at 2,286 of perforated CAD, where a match's 16 NECTAR against a cap of 56
    meant three quarters of the heavier mesh was zero-scale degenerates going through the vertex
    shader, and through the sun's depth pass again.
  - **THE ELEMENTS ROLL, AND THE ROLL IS VISUAL-ONLY AND INTEGRATED FROM DISPLACEMENT.** A holed
    ball that slides without turning reads as wrong the instant a hole is visible, and the sim
    keeps NO orientation for an element (`Artifact` is pos/vel/z/vz — a per-tick quaternion on 56
    balls is egress nobody asked for, and none was added). `renderElements.ts` turns each ball by
    `d / r` about `up × travel`, where `d` is how far it was seen to move since the LAST DRAWN
    FRAME — displacement, not `v · SIM_DT`, because the renderer draws interpolated snapshot
    positions at a free-running rate and a velocity-times-fixed-step integration is off by
    whatever the frame-rate-to-tick-rate ratio happens to be. Four things it has to survive, each
    checked: a TELEPORT (`derive.ts` re-tagging a landed element at a cell's own position,
    `park()`, a capture) is dropped by a `MAX_ROLL_STEP_IN` (12 in) clamp — past any real travel
    at 260 in/s and far under a field-scale jump; a REWIND (`world.tick` going backwards) spins
    nothing at all, the same trigger `Engine3d` rebuilds on; a HELD, stock or PARKED ball keeps
    its orientation and its tracked position, so its release is a continuation and its hole
    pattern does not flip the tick it is parked in a cell; and the starting orientation is a hash
    of the ball's own `id`, so 40 fresh POLLEN do not show 40 copies of the same face.
  - ⚠️ **THE FOV SLIDER IS HORIZONTAL DEGREES, 60–120** (owner, 2026-09-24: "keep human fov in
    mind"). `GraphicsSettings.hfov` (was a VERTICAL `fov`, 60–90, converted once on load: the old
    default 70 maps to the new default 100, anything else to what it showed across 16:9). 120 is
    what both human eyes see together (`graphics/fov.ts`); the old vertical 90 was 150° across on
    21:9. Every camera converts it for its own screen shape: the solved driver camera's ceiling
    (`fovCapRad`, allowed below the fit's 60° floor so an ultrawide steps the eye back instead of
    going fish-eye), chase, orbit/free (15° tighter), and the height-accurate driver eye.
  - ⚠️ **THE HEIGHT-ACCURATE DRIVER VIEW HOLDS THE WHOLE FIELD AND FOLLOWS THE ROBOT INSIDE IT**
    (owner, 2026-09-24, four reports in a row: the hive cut off; then "extremely choppy, especially
    coming off the wall... Robot is off the frame"; then "the whole field should be visible in driver
    view at all times"; then "Not fixed driver view tho", ruled as one view that does both).
    `fitDriverEyeFrame` keeps the player's height and role and steps the eye straight back from the
    wall until the whole field and both hives (`fieldViewPoints`) fit in `1 - EYE_TURN_SLACK` of
    their lens: about 77 in back at the default 100°, 38 at 120°. `driverEyeFollow` then turns
    toward the robot, CLAMPED into the aims that keep every point in frame, and the renderer eases
    it (`EYE_FOLLOW_HALFLIFE`). ⚠️ **No step may branch on a projection test**: the first version
    returned one aim when a test passed and a stepped one when it failed, and those switches were
    the chop. The vertical clamp is exact (`β = atan(tan e / cos a)` in the yawed frame, the solved
    camera's own derivation); the horizontal one carries `FIT_MARGIN_H`. The frame is solved once per
    alliance, role, height, screen shape and lens (`eyeKey`), not per frame. Pinned by the RENDER
    lane's `driverEye/field` checks: 0 of 2,700 frames lose a point, and a half-inch of robot travel
    turns the view at most 0.044°.
  - ⚠️ **MSAA is a render target this scene owns, not the canvas's `antialias`.** The context is
    created with `antialias: false` always: WebGL cannot be asked for a particular sample count
    on the default framebuffer and the attribute is fixed for the life of the context, so that
    is the only way "2x" and a live change are both possible. The target is half-float, and the
    BLIT is where tone mapping and the sRGB conversion happen.
  - ⚠️ `WebGLRenderer.setViewport`/`setScissor` take CSS pixels and multiply by the pixel ratio
    THEMSELVES. The PiP minimap passed drawing-buffer pixels once and squared the ratio — at 75 %
    render scale the whole scene drew into 56 % of the canvas, which reads as a camera bug.
  - **Environments** (plan §4.5) are ELEVEN, listed in `graphics/environments.ts` — which
    `src/contributors.ts` DERIVES its Third-party credits from, so a fetched one cannot ship
    uncredited. Two are CC0 Poly Haven HDRIs fetched on demand as 1k `.hdr`, never bundled (use
    `HDRLoader`, not `RGBELoader` — renamed in three 0.186; the old name warns on every load); one
    is three's own `RoomEnvironment`; the other **eight are PAINTED** (owner, 2026-09-21: "Add more
    choices for the 3d field background") — an equirectangular canvas per id, built once and run
    through the SAME PMREM, used as `scene.background` AND as the light-gathering map. Painted and
    not photographed for three reasons: eight more HDRIs would be 13 MB the player downloads to
    look at scenery; `envLighting` is OFF on Low and Medium, so an HDRI there is "1.7 MB for a
    backdrop" and those tiers had no background picker AT ALL (they do now — `env.apply` takes the
    row as an argument and only the light-gathering half is dropped); and each painted entry
    carries its own **`rig`** (sun direction/colour/intensity, both hemisphere terms, exposure), so
    legibility is a number that can be tuned rather than whatever the photographer's afternoon
    was. `BASE_RIG` is a COPY of `renderCore.ts`'s `SCENE_*` constants — `graphics/` may not import
    `scene/` — and the RENDER lane asserts the copy value for value; the robot-builder preview
    still lights from the constants directly, so a build cannot come out two colours.
    - ⚠️ **THE SURROUND IS GEOMETRY NOW, NOT THE DOME (`scene/renderVenue.ts`, 2026-09-21).**
      The entries above still carry the background and the rig, and both still do their job — but
      a `scene.background` ALONE was the whole surround until this, and it failed three ways at
      once. Owner: “the graphic lighting environment is too basic … an actual environment instead
      of blurry lights.”
      - **No parallax.** A background texture is sampled by view DIRECTION, so it does not move
        when the camera does; orbiting slid the field across a gradient that never shifted.
      - **No horizon in frame.** Every camera here looks DOWN at the field, so most of the frame
        samples the dome's LOWER half — one gradient stop to the next — and
        `backgroundBlurriness` (0.16–0.40) then smeared the only structure a painted dome had
        (its truss bar, its silhouette teeth) into a soft band. **That band IS what the owner
        was calling the blurry lights.**
      - **No ground at all on the shipping field.** `renderField.ts`'s procedural `bb-room` was
        added by the CONSTANTS FALLBACK only — `glbFieldToHandles` never called it — so the CAD
        field hung in the clear colour with its own alliance tape running off into the void.
      `renderVenue.ts` builds four kinds (`hall`, `arena`, `studio`, `outdoor`) off a `venue` on
      each environment row, every structural part ONE `InstancedMesh` over a unit box so each
      category is one draw call, and a procedural ground texture for the scale a flat colour
      cannot give. `bb-room` is DELETED: two floors at z −0.75 would z-fight, and its 424-in
      cylinder sits inside every hall's walls.
      - ⚠️ **AN ENCLOSED VENUE MUST BE WIDER THAN THE ORBIT CAMERA'S REACH.** `workshop` was
        290 in across and the orbit camera zooms to 620, so the eye stood OUTSIDE its own
        `BackSide` shell and the walls simply vanished. `VENUE_MIN_HALF` (660) is clamped in the
        BUILDER, not trusted to the data. Going above a ceiling degrades to a cutaway and needs
        no guard.
      - ⚠️ **`color` × `map` MULTIPLY.** The ground was handed `spec.floor` as BOTH tint and
        texture, so it rendered its own albedo squared and the practice room came out near
        black. White-tinted now, and pinned.
      - Tiering reads the existing `meshDetail` + preset column (`bbVenueDetail`, no new
        setting). Only **Low** takes the cut — Medium is where the void looked worst, because
        `envLighting` is off there and the dome was not even lighting anything.
      - Cost: scene +1.86 KB gz, **zero new asset bytes** (the ground texture is a 128×128 canvas
        painted at runtime), worst case 7 draws and 5,762 triangles against High scene totals of
        337k–462k. ~126 checks in the RENDER lane build it for real and measure it.
      - OPEN: `school-hall` and `monochrome-studio` still download 1.6–1.7 MB of HDRI that now
        buys only IBL and reflections, since the geometry hides the photograph.
    - ⚠️ **AN ENVIRONMENT MAP IS SAMPLED IN THREE'S y-UP FRAME AND THIS SCENE IS z-UP.** Every
      camera here sets `up = (0,0,1)`, but an environment map is not in the scene graph:
      `textureCubeUV` takes a world direction and three's equirect convention is +y = zenith, so an
      unrotated dome lies on its SIDE — ceiling toward the rear wall, floor toward the audience.
      Invisible while the only maps were a near-symmetric hall and a white studio; glaring the
      moment a dome has a horizon (the first sunset build painted the sky underfoot, measured).
      `scene.backgroundRotation`/`environmentRotation` fix it for EVERY id, HDRIs included. ⚠️ The
      sign is **`+π/2`**, not the `−π/2` the arithmetic gives: `WebGLRenderer` negates all three
      Euler components before handing the matrix to the shader.
    - ⚠️ **A GRAZING KEY LIGHT BLACKS THE MAT OUT, AND AMBIENT WILL NOT BUY IT BACK.** `sunset`
      first shipped with a 15° sun and MEASURED a rendered mat luminance of **0.0018**, against
      0.046 for `school-hall` and 0.097 for the room — no tile grid, no element shadows, no
      shot-path line. A 15° key lands `cos(15°) = 0.25` of itself on a horizontal floor and the
      perimeter walls shadow the first 40 in of every edge. Raising the fill does NOT fix it:
      hemisphere 1.15 → 2.6 → 3.2 moved the mat only 0.0018 → 0.0102 → 0.0110, because the floor's
      albedo is dark and ambient is a small share of it. The key's ANGLE was the whole variable;
      the rig sits at 40° and the RENDER lane holds every environment to **25° minimum**. Measured
      mat band across the eleven: 0.011 (`sunset`, warm-cast) … 0.097 (`room`), with every element
      at 7.1–12.9:1 against its own mat.
  - **The view key `t` is armed by `InputManager.attach`/`detach`** (`graphics/viewKey.ts`,
    reference-counted). It CANNOT live in the scene: the listener dies with the scene, so from
    the 2D map there is nothing left to press. It is not a `KeyAction` — it changes which
    renderer is mounted, not the robot.
  - **THE FREE CAMERA AND ITS CAD PRESETS** (owner, 2026-09-21). `graphics/freeCam.ts` is the whole
    model — a `FreeCamState` (yaw/pitch/dist plus a look-at point ON THE FLOOR), the clamps, the
    reset framing, the mapping tables and the pure gesture math — and it is DOM-free, `three`-free
    and engine-trig-free like everything else under `graphics/`; `scene/renderCameras.ts` owns the
    `PerspectiveCamera`, the easing and the one `Math.exp` the dolly needs, and `renderScene.ts`
    owns the listeners. Per device, ONE storage key (`FREE_CAM_NAV_KEY`), coerced field by field.
    - ⚠️ **ORBIT DRAGS THE FIELD; IT DOES NOT FLY THE CAMERA** (owner, 2026-09-21: "Onshape orbit
      is right drag but it is reversed"). The first version added `+dx·rate` to `yaw` — and
      `d(eye)/d(yaw)` is exactly the camera's screen-RIGHT vector, so the EYE followed the cursor
      and the field swung the other way from every CAD package and from this app's OWN spectator
      orbit camera, whose `orbitDrag` has always done `orbitYaw -= dx`. The PITCH axis was already
      right and is not flipped: pulling down rolls the field's top toward you, i.e. the eye rises.
      PAN was already "the ground follows the cursor", which is the same gesture. No vendor
      documents either sense — see the presets doc for what they do and do not publish.
    - **The presets are `dsim · onshape · solidworks · fusion · blender · custom`**, and every row
      of every one is off the vendor's own current help page:
      **[docs/biobuzz/free-cam-presets.md](../biobuzz/free-cam-presets.md)** carries the URLs, the
      quoted wording, what each vendor does NOT state, and which packages were DROPPED for want of
      a primary source (Inventor, Creo, NX, FreeCAD, SketchUp, Tinkercad). `dsim` IS the Onshape
      mapping (owner: "DSIM default should also be very close to how the onshape one works") plus
      left-drag orbit and Shift+left pan, because left is free here and the orbit camera already
      used it. `⌘` folds into Ctrl; ALT is ignored by a preset (so Onshape's own Alt+right
      constrained rotate is an orbit here) and exact in a custom layout.
    - **The options are all in that one key**: wheel direction (preset default / forward zooms in /
      forward zooms out — the preset column is `FREE_CAM_PRESET_WHEEL`), invert orbit X, invert
      orbit Y, invert pan, three sensitivities, zoom to cursor, smoothing, and a custom layout whose
      three chords are captured like a keybind and STEAL on conflict. Rare ones sit behind the
      `.ds-fold` in Graphics ▸ View. An older stored blob (`{preset, invertZoom}`) still loads:
      `invertZoom: true` reads as `wheel: 'out'`.
    - **Zoom to cursor is exact and OFF by default.** `dollyFreeCamToward` scales the camera about
      the floor point under the cursor, which leaves that point's screen position and the view
      direction untouched by construction; `renderCameras.floorUnder` is the unprojection that
      finds the point, through the camera that was actually RENDERED and therefore through the
      `setViewOffset` window the HUD's safe rect sets. Off by default because the only vendor that
      documents the behaviour at all documents it as one you enable.
  - **THE FLOWER CONTENTS READ-OUT ON THE TOP-DOWN 3D SHOT** (owner, 2026-09-21: "for the top down
    view of the 3d render, add a separate thing (like the 2d display) that shows inside the
    flower"). A FLOWER is a 21.5-in column and its contents are the one thing a plan view cannot
    say — four discs from above are four discs whatever HEIGHT they are at, and height is the rule
    — so the 2D renderer draws a SECTION beside each one, outside the perimeter, in the camera's
    own view margin. The 3D overhead camera has the same problem plus the flower's own top plate
    between it and the column. `drawFlowerReadout.ts` puts the SAME drawing there: it recovers ONE
    affine transform from three projected floor points and calls `drawBiobuzzFlowerSections`, the
    function `drawBiobuzzField` itself calls, so the two views cannot drift from each other or
    from the scorer.
    - **An affine transform is legitimate here and nowhere else.** `drawProjectedOverlay`'s own
      header says a perspective camera is not an affine map, and it is right about driver, chase,
      orbit and free. The OVERHEAD camera is an `OrthographicCamera` straight above the origin, and
      an orthographic projection of a PLANE is affine exactly. It is CHECKED rather than assumed —
      a fourth point past `AFFINE_TOL` draws nothing — so a future overhead camera that grew a
      tilt stops drawing instead of drawing in the wrong places.
    - **Overhead only.** On every other camera the flower is seen from the side through its own
      open bores and the heights are read off the picture; four opaque cards over the tiles would
      repeat what is already there. The PiP minimap is excluded too: 120–260 px across puts a whole
      column inside about eight pixels.
    - ⚠️ **IT IS `GameModule.drawSceneOverlay`, A SLOT OF ITS OWN, NOT A THIRD ARGUMENT ON
      `drawOverlays`.** That was tried and it is a trap: `drawOverlays` is written in FIELD INCHES,
      a game that ignores an extra argument still compiles, and DECODE's ramp strips were duly
      drawn in world coordinates onto a screen-pixel transform. An optional second slot cannot do
      that. It needs one thing the overlay pass cannot derive — `GameScene.camera`, the camera the
      last frame RESOLVED to, because on an interactive scene the device's own camera preference
      wins over what the host asked for.
  - ⚠️ **`Renderer.render(…, overlayOnly)` CLEARS the whole canvas.** Right for the live view
    (the 2D canvas is a separate sheet above the WebGL one); fatal anywhere both passes share a
    canvas. The replay export draws the overlay onto a sheet of its own and composites — without
    that, every exported 3D frame is black. Measured 1920×1080: 2D 0.44 ms/frame, 3D 0.85 ms.
- **Client:** `graphics/store.ts` holds the per-device view pref (`localStorage['decodesim.view']`);
  `GameView`/`game.ts` await `initPhysics3d()` before a 3D practice (fallback to 2D with an
  event-log line) and mount the lazily imported `scene` under the 2D canvas (`overlayOnly`).
  LAZY chunks — physics ≈ 1.12 MB gz (the wasm glue plus the implementation), scene ≤ 250 KB gz —
  ratcheted by `npm run bundleaudit` (needs a build; not in `npm test`).
- ⚠️ **`sim3d/` IS LAZY, AND ONLY TWO OF ITS MODULES MAY BE IMPORTED FROM OUTSIDE IT** (done
  2026-09-18; it used to be otherwise, and the implementation sat in the main chunk). `engine.ts`
  is the LOADER — `initPhysics3d` / `physics3dReady` / `rapier3d` / `physics3dImpl` — and
  `tilt.ts` is `hiveTiltAngle` + `hiveTrayRefTheta`, pure JSON, because the 3D SCENE reads the
  tray angle on a frame where no 3D physics is loaded (a 2D-physics match in the 3D view).
  Everything else hangs off `sim3d/impl.ts`, a re-export barrel that `initPhysics3d()` alone
  imports, dynamically, beside the wasm; reach it with `physics3dImpl().<name>` after the await,
  which is how the PREDICTORS (`predict.ts`) will be wired. `sim3d/step3d.ts` is a one-line gate
  doing exactly that, so `step.ts` can dispatch without pulling a byte of physics in. Node callers
  (smoke lanes, `hive-calibrate`, `costprobe`) still import the modules directly — there is no
  bundle to protect there. The RENDER lane fails on a static import of anything else.
- **THE 3D ROBOT CREATOR (`docs/roadmap.md` item 1)** — `scene/renderPreview.ts` is a second,
  small scene in the SAME chunk, and `Preview3D.tsx` (main chunk, no `three`) is the builder's
  2D/3D toggle, the `Stowed` toggle and the saved-robot thumbnails. Three rules hold it together,
  and each is asserted by the RENDER lane rather than left to a habit:
  - **ONE GENERATOR.** The preview calls `buildRobotGroup(spec, id, alliance)` — the function the
    live match calls for every robot on the field — and builds exactly one mesh of its own (the
    floor disc). The renderer, the tone mapping and the light rig come from `scene/renderCore.ts`,
    which both scenes share, because those are per-RENDERER settings and every one of them changes
    the pixels. A preview drawn a second way would be a preview that lies.
  - **ONE REBUILD KEY.** `bbSpecKey` (`specKey.ts`, NOT under `scene/`) is the build's geometry
    identity, read by the generator inside the chunk and by the thumbnail cache outside it — the
    main chunk has to key a cache on it without loading the scene chunk to ask.
  - ⚠️ **ONE DYNAMIC SPECIFIER.** `index.ts` fills TWO slots (`scene`, `previewScene`) and both
    write `import('./scene/renderScene')`; the preview factory is re-exported from there. Two
    specifiers would hoist three.js into a shared chunk behind two facades, and a facade carries
    none of the marker strings `bundleaudit` routes the `scene` budget by — both would land in
    `other` and fail that audit for a reason that has nothing to do with size.
  The COSMETIC CHASSIS COLOUR is rendered in 3D now (fill = `chassisFill(spec.chassisColor)`,
  alliance = the silhouette line plus the sign panel, the split the 2D sprite has always made);
  it was alliance-filled and the colour was not drawn at all, so it vanished when a player pressed
  `t`. Looking at a robot close up also found the TURRET and the BOX TUBE built INSIDE the chassis
  box, `specKey` missing `drivetrain`, and a discarded group never disposed — all three were the
  MATCH's bugs and all three are fixed there.
- ⚠️ **WHICH END IS THE FRONT IS ONE LANGUAGE, DRAWN IN BOTH RENDERERS** (owner, 2026-09-22:
  "somehow make it clearer fundamentally which side is front and which is back in game. This is
  especially confusing in a symmetric robot in 3D"). `bbFrontMarks` (`parts.ts`) is the geometry
  and its header is the design; `drawFrontBack` fills it in 2D and `buildFrontMarks` builds it in
  3D. TWO marks, neither in an alliance colour: a near-white **LIGHT BAR** across the full front
  rail (emissive in 3D — a matte white bar goes grey in the hive's shadow, which is where a driver
  needs it most) and a near-white **ARROW** on the deck pointing at it. The REAR takes a plain rail
  in the chassis' own structural dark and nothing else.
  ⚠️ **It had amber hazard ribs for about four hours**, and the owner's answer was "what is this
  ugly ass yellow and black beams rendered in 3D? It is awful and does not fit FTC". The back of a
  truck is the most-read "this is the back" language there is — on a truck; on an FTC robot it
  reads as construction tape, it is the loudest thing on the field and it competes with a POLLEN's
  own yellow. The FRONT language carries the job on its own: a bright bar at one end and plain
  structure at the other. The RENDER lane asserts there is no amber anywhere on the robot, in both
  renderers and in the geometry they share, by COLOUR FAMILY rather than by the one hex.
  What this replaces is a 0.7-in white block on the front cross member
  (3D) and a rear chevron in the ALLIANCE colour (2D) — the block was four screen pixels at match
  distance and behind the intake from the one angle you would look for it, and the chevron made
  "red at that end" compete with "red team". Neither mark is a collider: they sit inside the
  frame box in x/y and only stand above the deck, the same ruling the end plates got, and the
  RENDER lane measures it off the built meshes.
  **It follows the SIM's front, never the driver's REVERSED.** Flip-front is an input transform, it
  never touches `r.heading`, the HUD already says REVERSED — and in 3D the robot is one group in a
  scene four other people and every replay viewer are looking at, so there is no per-viewer variant
  of a mesh to give them. REVERSED is a property of a stick, not of the machine.
- ⚠️ **THE DRIVE WHEELS ARE CATALOGUE PARTS, AND NOTHING ABOUT THEM IS PAINTED** (owner,
  2026-09-21: "Make the wheels be rendered accurately. Gobilda 104mm gripforce mecanum wheel,
  gobilda omni wheel"; then, on the shipped picture, "it makes no sense for the wheel to have slant
  patterns" / "which is how it is right now"). One 64×64 `CanvasTexture` of diagonal lines was
  stretched over a bare `CylinderGeometry` and handed to MECANUM, to an X-drive's OMNIS and to a
  BUTTERFLY's corner set — and a `CylinderGeometry`'s flat CAP is UV-mapped too, so what a player
  actually saw through the side plate's lightening hole was **a disc with diagonal lines painted on
  it**, where a real wheel has a plain steel hub plate. A 45° slant is hardware: it is the roller
  axis of a mecanum and of nothing else.
  `BB_WHEEL_PARTS` (`scene/renderRobots.ts`) is the part table, every field either PUBLISHED and
  cited at the constant or DERIVED from published ones — goBILDA **104 mm GripForce Mecanum**
  (3625-0202-0104, **eleven** rollers, 40A silicone between steel side plates, 236 g) for mecanum
  and a butterfly's corner set; **96 mm Omni** (3624-0014-0096, two rows staggered half a pitch —
  that is what the published "core offset 8 mm one side and 12 mm on the other" means) for X-drive,
  because 96 is the LARGEST omni goBILDA sells and an X-drive is therefore honestly 0.157 in
  smaller in the radius; **96 mm / 72 mm Hogback Traction** (3626-0014-0096/0072) for tank, a
  butterfly's inboard set and a swerve pod. `wheelKindOf` is the one place that mapping lives.
  - **104 mm IS `C.WHEEL_DIAMETER_MM`** — the number `C.SPEED_PER_RPM` derives the drivetrain's top
    speed from. The drawn wheel was a typed 4.00 in (101.6 mm) beside it; the picture and the drive
    model are the same wheel now, and `BB_WHEEL_R` is GONE (a single "the wheel radius" is what let
    four drivetrains be drawn at the mecanum's size). What legitimately stays one number is the
    CHANNEL's width, cut for the widest thing that goes in it.
  - **A barrel's profile is derived, not styled.** A roller's surface has to lie on the wheel's own
    outer cylinder or the wheel thumps once a revolution, so its radius at `s` along its axis is
    `R − hypot(ρ, s·sin α)` — exactly `rollerR` at the waist, tapering to ~0.10 at the ends, and
    sharper for an omni (α = 90°) than a mecanum (45°). The two APPROX values are flagged: goBILDA
    publishes no mecanum WIDTH (48 mm is the figure at which the eleven rollers overlap 1.68× in
    azimuth — under 1.0 the wheel rolls into a gap) and no omni ROLLER COUNT (nine per row is what
    end-to-end tiling asks for).
  - **THE TIER CHANGES THE TESSELLATION AND NOTHING ELSE** ("of course, its fidelity and
    simplification should depend on graphics settings"). `bbWheelDetail(settings, tier)` reads two
    settings that already exist — `meshDetail` set by hand, and otherwise the preset COLUMN, the
    same input `GFX_PIXEL_BUDGET` uses and for the same reason (nothing separates Medium from High
    but AA and shadows). Low/Medium get the cheap one, High/Ultra and the fixed-High replay export
    the full one; **no seventeenth dial was added**, and the RENDER lane asserts that. A LOW mecanum
    still has eleven real 45° rollers — measured, not promised. It is baked at build time, so
    `sync` folds it into its own rebuild key beside `bbSpecKey` (NOT into `bbSpecKey`, which the
    main chunk's thumbnail cache reads and which must not carry a per-device setting).
  - **Handedness is `x * sy >= 0 ? 1 : -1`, the 2D sprite's own expression**, and `hand: 1` is a
    LEFT-slant wheel at the FRONT-LEFT and REAR-RIGHT corners (AndyMark/REV on the equivalent
    part). The RENDER lane MEASURES it: it isolates the topmost roller by its contiguous run in the
    merged buffer — azimuth and a z-slab both fail, because the rollers overlap in azimuth by
    design and a slab of a barrel is a circle with no principal axis — and asserts FL∥BR, FR∥BL and
    the two hands perpendicular, for every `intakeMount`.
  - **The wheels TURN now** (`v/R` off `r.vel`, each at its own part's radius), which is the §4.4
    `effects` row that had nothing behind it. A wheel is a `THREE.Group` with `rotation.order =
    'ZYX'` so an X-drive's roll stays INSIDE its 45° cant — the same class of bug as the turret's
    two nodes. A painted stripe could never have got this right at all: a texture on a spinning
    cylinder keeps its slant relative to the SCREEN.
  - Two knock-ons, both caught by measurement: `BB_BUTTERFLY_LIFT` is DERIVED against the deck now
    (a typed 0.6 under a 104 mm wheel puts the lifted crown at 4.694, through a lid at 4.34), and
    `endWheelSpanY`'s swerve half-extent is `BB_POD_INSET` rather than `BB_POD_W / 2` (the fork box
    stopped being the widest thing on a pod once it was built around the pod's own 72 mm wheel).
  - ⚠️ **A WHEEL CANNOT BE PHOTOGRAPHED ON A ROBOT**, and that is the chassis, not the wheel: it
    lives in the channel between two side plates and the outer plate is solid but for three
    lightening holes. `scripts/scene-preview/main.ts`'s `?wheelrig=1` stands the five real parts on
    bare tiles for that; `?drivetrain=` and `?gfx=` are the other two params this pass added.
- **THE SHOT PATH IS ONE PREDICTOR AND TWO DRAWINGS** (owner playtest feedback 2026-09-18, items
  5–6). `src/games/biobuzz/shotPath.ts` — NOT under `scene/`, because nothing outside `scene/` may
  import from it — answers "would this shot go in, and what does it fly through". `drawShot.ts`
  draws it on the 2D map and `scene/renderReticle.ts` in 3D, and neither works anything out for
  itself. The rules: a path ONLY for a shot that is MADE, drawn DOTTED, with no landing ring at the
  end. "Made" is `hiveAccepts` with the AIMED cell ASSUMED FULLY UP (`bbPretendHive`, the copy stage
  5b's fire gate asks — owner ruling 2026-09-19, reversing "against the REAL hive"), so the path
  is drawn exactly when holding fire would release, and a cell that is down or mid-swing still
  draws one. `bbFlightEnters` now takes an optional `BbFlightTrace`
  out-parameter and records the arc into a caller-owned buffer, which is what retired
  `scene/renderLanding.ts` — that file carried a COPY of the integrator, and its own header said
  the copy would drift.
  - ⚠️ **A TURRET'S YAW AND ELEVATION ARE SEPARATE NODES** (`bb-turret-head` → `bb-turret-pitch`).
    Both on ONE node is what "the shooter is not automatically aiming" looked like: a `THREE.Euler`
    defaults to order `XYZ`, so the elevation was applied about the UN-yawed axis, and at the 160°
    turret yaw and 80° elevation hive range actually asks for, the barrel came out 67.7° BELOW
    horizontal and 44.5° off in azimuth while the SIM's turret was dead on target. The sim aims
    correctly under both physics — measured, converging in 41–52 ticks with no button held.
  - ⚠️ **ONLY THE HOOD ELEVATES, AND THE RELEASE FOLLOWS IT** (owner ruling, 2026-09-19, after five
    rejected passes at this one mechanism). `bb-turret-pitch` used to carry the WHOLE head — plates,
    flywheel, hood, motor, braces — pivoting about the muzzle, which is the only reason a ρ budget
    ever existed: the entire assembly swept through the drivetrain at elevation. It now carries the
    hood arc and its two arms and NOTHING else, pivoting about the FLYWHEEL AXLE, which is the one
    pivot that holds the wheel-to-hood gap constant. The wheel, both side plates, the braces, the
    motor, the belt and the feed are fixed and need static deck clearance only.
  - ⚠️ **`bbMuzzleLocal(pitch)` (`robot.ts`) IS THE ONE MUZZLE, AND `scene/renderRobots.ts` IMPORTS
    IT.** The shooter's whole dimension chain lives in `config.ts` now — it used to be private to
    the renderer, which is exactly how the picture and the physics disagreed for five rounds. A hood
    on an axle pivot moves its own lip, so the release is no longer a flat `BB_LAUNCH_Z0`: it is
    9.634 in level, 8.466 at 57.6° and 7.554 at the 80° cap, and it retreats along the heading as it
    drops. Same "one predictor, two drawings" rule the shot path follows, and the RENDER lane proves
    the drawn lip sits on the sim's muzzle at every pitch rather than assuming it.
  - ⚠️ **THE LOCAL ROBOT'S PREDICTED CHASSIS HAS AN OPEN MOUTH** (owner, 2026-09-24: full hopper,
    drive into a row of POLLEN on the wall, "my whole robot jumps upwards"). The one `robotExtents`
    cuboid put a solid face where the authority's pocket is, the wall-pinned row could not move, and
    the solver lifted the predicted chassis over it: 2.1–2.2 in at a 20-tick lead while the
    authority's z stayed 0. `fitChassis` now builds the authority's frame, mechanisms, ARMS and
    pocket filler for the local robot, with the lintel folded into the filler (`predictChassisShapes`).
    The arms are not optional: without them the prediction drove 1.1 in deeper into a wall row
    every window. Cost in the PREDICT lane's push scene: 3 ms → 4 ms against the 8 ms budget (the
    full compound was 5). Remote robots keep the cuboid. Pinned by the PREDICT lane's wall-row check.
  - ⚠️ **A SEATED ELEMENT IS KINEMATIC IN THE FULL PREDICTOR — DYNAMIC PUT IT IN FREE FALL.**
    The near set is every non-`held`/`stock` ball within `PREDICT_ELEMENT_RADIUS`, and it used to
    build all of them DYNAMIC. An `element` tag means the AUTHORITY is holding it (latched in a
    HIVE cell, seated in a FLOWER bore) through its own derived structure, and **nothing in the
    prediction world catches one** — so those bodies fell for the whole replay window, every
    window. MEASURED on a settled match world, six hive-seated elements over 100 consecutive
    reconciles at a 6-tick window: the predicted body sat **-1.76 in mean, -1.96 worst** under an
    authoritative z whose own range was **0.000** — which is ½gt² for the window exactly, i.e.
    unsupported every time. The owner saw it as elements “drooping downwards and teleporting back
    up” inside the hive: the drooped pose reaches the screen whenever the drawn source is the
    predictor, and the next snapshot puts it back. `drawPredictedElements` (`game.ts`) already
    said a seated element is “the authority’s derived structure rather than a free body the local
    chassis is about to hit” — but it can only decline to DRAW the prediction, it cannot stop the
    predictor making one, and `noteElementCorrection` folds the error into a visual offset that is
    applied whether or not the draw used it. Kinematic rather than skipped, so the local chassis
    still feels a flower column as a solid — the same call the header makes for a remote robot.
    Client-only: no wire change, and the authority is untouched. Pinned by NET3D §15.
  - ⚠️ **`bbTurretSolution` IS A FIXED POINT** — the elevation moves the release and the release
    moves the elevation. `BB_TURRET_SOLVE_PASSES` (4) passes ALWAYS, with no early exit and no
    tolerance, because a trip count that depends on a float comparison can differ between a client's
    prediction and the server's authority. Measured over 7,688 field poses, a fifth pass moves the
    pitch by at most 1.76e-9 rad. The outcome change was authorised: scoreable field cells 1359 →
    1382 north and 1417 → 1439 south, pitch-capped cells 255 → 211, nothing speed-capped, worst
    required muzzle speed 253.26 → 256.37 against a 260 cap.
  - ⚠️ **A LAUNCH INHERITS THE MUZZLE'S OWN VELOCITY, AND THE TURRET LEADS** (owner, 2026-09-19:
    "animate the turret properly so that it has a 'shooting on the move' correction algorithm built
    in its animation... this does mean that perfect tracking is not possible"). A release leaves
    with `speed` along the barrel PLUS `v + ω × r` at the muzzle (`bbPointVel`) — before this a shot
    fired at full drive flew as if the robot were parked — so `bbTurretSolution` solves against a
    target displaced by `−v·t_flight`, folded into the SAME `BB_TURRET_SOLVE_PASSES` loop. A PARKED
    robot is byte-identical (every lead term is multiplied by zero, and the ROBOT lane pins it), so
    the 1382/1439 scoreable-cell counts do not move. Measured residual at 89 in/s: mean 0.14 in,
    worst 1.75; the pre-lead pair fired from the same pose misses by a mean of 53 in. A DUMPER's
    lead is exact in one step, because a lob's flight time is a closed form in the height alone.
  - ⚠️ **THE TURRET HAS AN ACCELERATION, NOT ONLY A RATE.** `bbSlewTurret` runs a discrete
    bang-bang profile (`slewAxis`) that decelerates into its target and never overshoots or rings;
    the per-axis angular velocity is carried on `RobotState` (`bbTurretYawVel` and its three
    siblings — optional, absent reads 0, quantized to 1e-4). `BB_TURRET_ACCEL` 70 rad/s² with the
    unchanged 7 rad/s rate puts a 90° swing at **0.333 s**; driving flat out past the HIVE the
    steady-state yaw error is 0.5–1.3° and 75–100% of released shots score, while a HARD REVERSAL
    leaves the barrel **22–24°** behind for 0.6–0.75 s — during which the landing gate releases
    **nothing**. The motor's rate window is centred on the CHASSIS yaw rate, so `turretHeading`
    being a WORLD angle costs the ring its own rate to hold, and a chassis spinning faster than the
    ring DRAGS the bearing.
  - ⚠️ **THE DRAWN PATH AND THE FIRE GATE ARE ONE PREDICATE** (owner, 2026-09-19: "the dotted
    lines still appear when the shot is not able to be made"). `bbTurretShotEnters` /
    `bbDumpShotEnters` (`play.ts`) are what stage 5b, `sim3d/elements3d.ts` and `shotPath.ts` all
    call — which closes 3D's Day 1 deviation, where release was gated on ALIGNMENT and the path on
    a landing prediction, so each could say yes while the other said no. The path is additionally
    gated on there being a shot to TAKE (`bbCanFire`: a live phase, a loaded hopper, not a passive
    dummy, and a dumper's 0.75 s re-arm — but NOT a turret's 77 ms beat, which would strobe it).
    The one deliberate difference stays: the gate asks Aim Assist's pretend-up hive and the path
    asks the REAL one, which is one-directional, so a drawn path is never a shot the gate refuses.
    A cell that is MID-SWING now draws nothing either — `hiveTakingSide` names one all through a
    tip, which is right for the capture and wrong for a promise, and it was the ENTIRE residual of
    "a path was drawn and the shot did not score" (28 of 28 in 3D). Measured after, over 1,152
    pose/velocity/hive cases in both physics and both mechanisms: **P(path drawn AND the shot would
    not score) = 0**, 113 paths drawn.
  - ⚠️ **A DUMPER IS A CATAPULT: ONE FLING, THE WHOLE BUCKET** (owner, 2026-09-19: "a dumper
    should not shoot one at a time. It holds four in a small 'hopper' and it would fling it like a
    catapult"). 3D used to POUR — one element every 0.3 s — because `bbDumpSolution` CONVERGES every
    throw on the cell centre and four real spheres meeting there knock each other off the arc. The
    stagger treated the symptom. `bbDumpCluster` is the 3D solve: `BB_DUMP_BUCKET` (4) seats, two
    ACROSS by two HIGH at `BB_DUMP_SEAT_PITCH`, sitting on the firing edge's own collision
    footprint, all leaving on ONE velocity so the cluster flies PARALLEL and arrives with the
    bucket's footprint. The 2D pipeline is permanent and keeps the converging solve (`BbShot.
    cluster` is the switch, and 2D never sets it) — a 2D flight element collides with nothing, so
    convergence is free there. Measured on the 28-pose tutorial grid: **20 of 28 poses score, 16 of
    them all four, 70 of 112 elements**, against the stagger's 20 of 28 poses. The row at 22 in is
    the honest near edge — the bottom row's arc clips the HIVE structure below the opening while
    the top row goes over it.
  - ⚠️ **A DUMPER HAS NO HOOD AND ITS RELEASE IS STILL FLAT.** `BB_LAUNCH_Z0` is a tipping tray's
    lip; it does not swing about a flywheel axle. `bbLobThrow`, `bbDumpSolution` and `bbLaunch`'s
    dumper branch all still read it directly, and the ROBOT lane has a leak guard: a dumper's release
    stays flat at every pitch while a turret on the same chassis follows its hood down.
  - ⚠️ **THE BOX TUBE IS A VERTICAL TWO-STAGE SLIDE WITH A CLAW, NOT A TELESCOPING ARM** (owner,
    2026-09-22: "Offset boxtube still looks extremely weird"; four earlier reports on the same part:
    "reaching towards the opening… not extending horizontally", "a lot faster", "way too quickly …
    in a violent way", "still meshes with the flower"). `config.ts`'s "THE BOX TUBE" block is the
    design. What the arm it replaced did, measured on the shipped build:
    - **It never deployed where drivers place from.** A robot flush on a FLOWER foot got 19% of its
      extension at 17° of pitch and stopped there: the deploy cap bisected a safe set that is not an
      interval, and the parked pose failed its own radius test by rounding. 3,550 of 28,928 in-reach
      poses stalled, 3,470 below half. The lane's tip check read the UNCAPPED solve, so it measured
      a pose the renderer never drew and stayed green, and "0 of 5,176 meshing" meant the arm was
      too short to reach anything.
    - The outer tube stayed flat on the deck while four inner stages rotated out of its mouth about
      the pivot, so the stack bent 90° at a joint and the stage tails swung 1.6 in into the deck;
      five sections tapering 1.5 → 0.5 in read as an antenna with nothing at the tip; the stowed
      cradle ran 2.3 in into a centre turret's ring and base plate; its pivot sat inside the new
      end bar; nothing drove anything; and the parked tip stood BESIDE the flower.
    **NOW**: three nested tubes (1.2 / 0.95 / 0.7 in — the OFFSET™ kit is a "2-stage" slide, three
    tubes of near-equal length) standing at the rail on a pivot between two plates, a pulley (belt
    to a motor under the deck) and a string spool outside them, a levelled wrist on top and a claw
    that hangs folded beside the mast. The whole slide leans a few degrees (74°–92.5°) so the claw,
    swung out level at `BB_BOX_TUBE_CLAW_REACH` from the mast, lands on the bore — **on every
    in-reach pose, flush included, to 3e-8 in**, measured on the built marker. The deploy is one
    linear 0.45-s ease run through `bbBoxTubePhases`: lean, turn the folded claw to the field side,
    extend, swing up level, turn in over the bore. The ORDER is measured, not taste: swinging toward
    the bore dips the arm through the top plate on every pose, and turning a hanging claw while it
    passes the plate clips a corner. 0 of 5,176 poses touch the flower's GLB solid at any of 21
    eases; the tightest is a corner tube reaching along the wall, whose yoke passes the end of the
    wall-side backstop (z 22.0–22.65). The front/back end bar splits round the pivot. The 2D sprite
    draws the same boxes (`bbBoxTubeStowedBoxes`) and snaps between the two end poses; the builder
    schematic draws the folded tower and the ring.
    ⚠️ **THE STOWED TOWER IS A COLLIDER** (`bbBoxTubeEnvelopes`, two boxes, like a dumper's): it
    stands 7 in above the deck and every drawn vertex of it is inside the compound, top ≤ 11.90 ≤
    `BB3_HEIGHT_MIN`. The deployed part above the stowed top exists only while the robot is parked
    on a flower and is drawn outside the collider, the dumper mid-throw's bargain.
    Placement is still a proximity action; nothing here is written to the world.
  - **The hood's own feed mouth rotates away from the feed at elevation**, which is why the wrap is
    0.556 rad and not the 1.05 it was: a FIXED feed shoe at `BB_FEED_SHOE_R` spans 146°–202° and
    takes over the entry. It bolts to both side plates, so it is also the rear tie.
  - ⚠️ **INTAKING FROM A FLOWER IS ARCHETYPE-AWARE** (owner, 2026-09-20: "intaking from the flower
    should now only be done if it is physically possible"). `BB_INTAKE_KINDS` — `sweeper` /
    `siderollers` / `ramp` (`RobotSpec.bbMech.intake`, `bbIntakeKindOf`) — are three hardware
    variants on the SAME sweeper mouth (`bbMouths`, `bbRobotSolids` stay archetype-blind; a ground
    POLLEN is taken identically by every build). What differs is whether the hardware can reach
    the retrieval opening measured off the CAD: the bottom POLLEN sits on the tiles inside the
    lower bore, 3.55 in tall and open from the plate's field edge back 3.57 in to the peanut
    supports (§9.7 Fig 9-12; the numbers are `config.ts`'s "ROBOT — intake ARCHETYPES" section
    header). A `sweeper`'s roller rides at ~4.5 in, two inches behind the tip line at the tip
    line itself — it never passes the plate edge and its reach (`bbFlowerReachOf`) is `null`,
    always. `siderollers` straddle the POLLEN (reach `[1.15, 2.65]` past the tip line, z
    `[0.5, 2.5]`); a `ramp` (`bbRamp`, an edge-triggered toggle — `RobotState.bbRampOut`/
    `bbRampAt`) slides its BLADE under it once DEPLOYED and SETTLED (`bbRampSettled`,
    `BB_RAMP_DEPLOY_S` after the toggle; reach `[0, 3.54]` past the tip line, and a z band of
    `[BB_RAMP_FLOOR_Z, BB_RAMP_PIVOT_Z]` — the HARDWARE's own band, blade underside to pivot,
    which the 2D z-bite reads; see that constant for why it is not the blade's own silhouette).
    `bbFlowerAtIntake` (`play.ts`) puts the FLOWER's ring centre into the mouth's own frame
    (`mouthAxes`) and asks a BITE — `bbBites` (`flower.ts`), one helper for both axes — of at
    least `BB_FLOWER_BITE` (0.5 in) between the archetype's box and the POLLEN's own extent, in x
    (`reach.out` against `[u−r, u+r]`) and in z (`reach.z` against the bottom element's own
    centre height, read from `ball.z` in 2D — already a centre, `flowerStackZ` — and `ball.z + r`
    in 3D, where `ball.z` is the bottom). At flush (`u = BB_PLACE_REACH`, 2.384 in): side rollers
    bite 1.5 in in x and 2.0 in in z; the ramp bites 2.56 in and 1.80 in against the 2D model's
    own bottom POLLEN; the standoff tolerance past flush is ≈1.17 in for side rollers and ≈2.06 in
    for the ramp. ⚠️ In 3D the ramp does NOT use the z-bite at all: its gate is the ball's own
    height () — see its own bullet below.
    ⚠️ **`u` IS MEASURED FROM THE MOUTH'S OWN OUTWARD BOUND (`uOut`, the roller line — the
    collision footprint's edge on this side), NOT THE BARE CHASSIS FRAME.** The frame sits
    `bbIntakeReach` (3–5 in) further BACK than that, which is where `footprintExtents` actually
    stops the chassis in a real match — measuring from the frame instead left the opening
    physically unreachable by any archetype (a robot driven flush settled ~5.2–5.4 in from the
    ring) and the RETRIEVE tutorial step never completed. `uOut` is where a robot driven flush
    against the foot actually rests, so `u ≈ BB_PLACE_REACH` there — the design intent, reached
    by the collision the field enforces rather than by a pose only a test can teleport to.
    ⚠️ **THE REACH HARDWARE IS A COLLIDER IN 3D NOW** (owner, 2026-09-20: "It should be a
    collider."). It used to be drawing + capture-gate only, on purpose, the same as the Box
    Tube's placement point above — that is GONE for 3D: `chassis3dReachShapes` (`sim3d/bodies.ts`)
    builds side rollers and a SETTLED ramp (`bbRampSettled`; folded, a ramp contributes nothing)
    as real boxes in `GROUP_POCKET` — statics, walls and robots meet them, an ELEMENT does not, the
    same group the intake pocket filler uses — in the AUTHORITY (`addChassis3dColliders`) and in
    BOTH predictors (`predict.ts`'s `fitChassis`; the FULL predictor keeps its own single
    `robotExtents` cuboid for the bare chassis but adds these small boxes on top of it — cheap
    enough that it did not move the 40-tick reconcile budget, measured: baseline 3.0 ms, with side
    rollers live 2.0 ms, with a deployed ramp live 2.0 ms, against an 8 ms budget). A side-roller
    build now stands off a wall by `bbIntakeReach + BB_SIDE_ROLLER_OUT + BB_SIDE_ROLLER_R`
    (measured 13.15 in against a bare-footprint 10.50), not the bare footprint; a wall-flush FULL
    prediction agrees with the authority to within half an inch (measured 0.25 in for side
    rollers, 0.42 in for a deployed ramp, both server-corrected trivially under the 16-in
    `SMOOTH_MAX_DIST` snap threshold). The ramp's collider set is rebuilt at the same SETTLE edge
    `bbRampReady` already gated the flower credit on — `BB_RAMP_DEPLOY_S` after the press going
    in, and immediately (no settle wait) coming out, because a fold only removes solid, nothing has
    to arrive (measured: the collider count changes at exactly tick 18 = `BB_RAMP_DEPLOY_S`·60
    deploying, and on the very next sync folding, and at no other tick). Two of the ramp's parts —
    the crossbar and the two rails — tilt at `BB_RAMP_ANGLE`, which for a FLANK mount is a genuine
    3D rotation (the mount's own yaw composed with the local pitch,
    `quatMul(yawQuat(EDGE_ANGLE[edge]), pitchQuatY(BB_RAMP_ANGLE))`, `math3.ts`) — a bare "rotate
    about Y" cannot say a flank mount's tilt, which is about world X.
    ⚠️ **A WALL-FLUSH SPAWN NEEDED A FIX ON THE SPAWN SIDE, AND THE FAILURE WAS WORSE THAN SLOW.**
    `bbSnapStart` seats an anchor at the bare footprint, so a side-roller build's wheels started
    embedded 2.65 in in the wall on every real anchor whose intake edge faced it — and MEASURED,
    that never resolved: a wheel box sitting low near the floor gives Rapier's own SAT a SHORTER
    escape through the floor (its own 2.5-in height) than sideways (2.65 in), so the correction
    went into the floor collider and the two cancelled every tick — 300 ticks / 5 s, exactly zero
    drift on every axis, not merely slow. `spawn.ts`'s `bb3dStartFootprint` (3D worlds only; `2d`
    calls `bbFootprint` exactly as before) grows the containment footprint `bbFitPose` already
    clamps against by `bbArchetypeWallExtra(kind)` (`config.ts`, a plain scalar so `spawn.ts` —
    main-bundle — need not import the lazy `sim3d/` chunk) on whichever edge the archetype's mount
    already grows, so the SAME clamp that keeps a robot inside the field also backs a
    reach-equipped anchor off before the engine ever builds a collider: MEASURED, zero protrusion
    now on every real anchor × mount × alliance (32 combos), and the settled pose drifts nothing
    (< 0.00001 in) with no yaw over a 90-tick window.
    **2D stays DRAWING-ONLY, and stays that way on purpose**: `bbFootprint`/`footprintExtents` are
    UNCHANGED in both pipelines (2D has no z, the foot is a solid rect there, so a reach part
    cannot be solid without also being solid to a ball it should let pass under) — a wall-flush 2D
    pose still draws the side rollers or the ramp INSIDE the wall, exactly as before; only 3D's
    collision changed. The wire widened for the ramp toggle: `QCommand.buttons` is 16 bits now
    (`BTN_BBRAMP` = 256, `src/net/protocol.ts`), and `packKey` (`src/sim/replay.ts`) carries the
    buttons ALONGSIDE the packed axes rather than inside them — packed in, bit 256 masked to 0 and
    a ramp press was invisible to the replay recorder.
  - ⚠️ **THE RAMP IS SOLID TO AN ELEMENT NOW, NOT JUST TO A ROBOT** (owner report 2026-09-20: "the
    pollen should be getting intaked from the deployable ramp BECAUSE it collides with the ramp
    and slides down... right now, it just looks like the pollen is passing through the ramp").
    The crossbar and rails `chassis3dReachShapes` builds (above) carried `GROUP_POCKET`
    unconditionally, which is the group an ELEMENT never meets — so a deployed ramp was solid to
    a robot and a wall and invisible to the one thing it exists to catch. `Chassis3dShape` grew an
    `elementSolid` flag (`bodies.ts`): the ramp's crossbar and rails set it (default groups, meets
    an element, plus the chassis boxes' own edge break via `chassisBoxDesc` so a ball meeting the
    bar behaves like meeting the frame); side rollers do not (still `GROUP_POCKET` — compliant
    wheels a POLLEN passes BETWEEN, not a bar it meets square on). `reachColliderDesc` (shared by
    the authority and the FULL predictor) picks the group and the collider builder off that one
    flag. **MEASURED**: a ground POLLEN fired at 30 in/s into the deployed bar's plane stops/
    bounces, never crosses it, across the whole tested lateral spread.
  - ⚠️ **THE INTAKE'S OWN PULL REACHES `BB_RAMP_OUT` FURTHER OUT, ONCE DEPLOYED AND SETTLED.**
    `bbIntakeAct` (`robot.ts`) gained `BbIntakeOpts.extraReach`, added only to the eligibility
    bound (`g.uOut + extraReach + er + BB_INTAKE_LIP`) — an element sitting anywhere inside the
    ramp's U, on the tiles or resting on the crossbar, is now something the rollers can grip and
    draw in, not just something the bar can shove. `bbIntakeExtraReach(r, time)` is the ONE
    predicate both `play.ts`'s `step2d` and `sim3d/elements3d.ts`'s `elements3dCapture` compute it
    from (`bbIntakeKindOf(spec) === 'ramp' && bbRampSettled(r, time) ? BB_RAMP_OUT : 0`), so 2D and
    3D cannot disagree about how far the pull reaches. **2D has no ramp collider at all** ("2D
    stays DRAWING-ONLY" above still holds) — nothing is solid there, so the extended reach simply
    pulls a ground POLLEN in from further out; a real bar's PUSH is 3D-only.
  - ⚠️ **A `ramp` BUILD'S FLOWER RETRIEVAL IS PHYSICS, WITH ONE GATE AND NO TIMER, SINCE
    2026-09-21** (owner, 2026-09-20: "the pollen should be getting intaked from the deployable ramp
    BECAUSE it collides with the ramp and slides down towards the intake"; "the old ramp works 99%
    of the time. When it does not work, the pollen don't budge... I think it depends on how the
    pollen are stacked"). `flowerRetrieve3d`'s ramp branch turns the lip's ROLLER while the POLLEN
    is still in the bore and takes it the moment the blade has physically LIFTED it — `ball.z >=
    BB_RAMP_LIFT_Z`, the ramp's own underside, which is above the lower plate's 0.354 rim. The
    release is a RE-TAG IN PLACE (same position, same velocity, same height) and `bbIntakeAct`'s
    extended pull (`bbIntakeExtraReach`) walks it down the deck into the hopper. There is no stall
    clock, no proximity release and no teleport of the bottom ball left in the 3D path.
    `derive.ts` carries the other half of that fact: a `ground` element whose bottom is above
    `BB_RAMP_LIFT_Z` is NOT re-claimed into the tube, because `flowerTubeOf` is a bare 2.086-in
    radius and a POLLEN standing on the robot's deck is still inside it. The test is about the
    TUBE, not the robot — inside it a POLLEN rests on the tiles (bottom 0) or on the element under
    it (bottom ≥ 2.8), and the rim carries a NECTAR, which is `element`-tagged from the moment it
    is placed.
  - ⚠️ **THE WEDGE BECAME A FLAT PLOW BLADE, AND FOUR MEASUREMENTS SAY WHY.** The 2026-09-20 wedge
    (lead 0.60, crest 1.00, two tilted boxes centred on their own profile line) never extracted a
    POLLEN by physics at all. `scratch/rampx.ts` drove it in for real — `contactPairsWith` +
    `contactPair`, every manifold named — and `config.ts`'s "THE DEPLOYABLE RAMP" carries the full
    working. In short:
    1. **A tilted box hangs `2·thick·cos(angle)` BELOW its own profile line**, so the "lead z 0.42"
       wedge really reached **0.3067**, under the LOWER RING PLATE's 0.354 top face. A free-shape
       `intersectionsWithShape` NAMES the collider: `LEAD_Z 0.42 -> trimesh z=[-0.199,0.354]
       FLOWER0` at every standoff, `0.50` and up CLEAR. That is the unexplained 0.42 freeze the
       previous pass left open, and its CAD probe missed it only because it sampled the wedge's
       CENTRELINE (`v = 0`), which is exactly where the 3.222-in bore is — the ramp is ±7.57 in
       wide and everything outside the bore's chord is over solid annulus.
    2. **Raising the lead to 0.60 put the lip on the ball's FLANK.** A tilted box's outermost point
       is its end cap's TOP corner, at 0.713. A POLLEN backed by the peanut supports climbs only
       while `(r − h)/d(h) > μ`, i.e. while `h < BB_POLLEN_R·(1 − μ/√(1+μ²))` = **0.637** at
       μ = 0.65 (`Max` of `BB3_ELEMENT_FRICTION` and `PHYS_WALL_FRICTION`). At 0.713 the ratio is
       0.564: the ball SELF-LOCKS. Measured — the chassis stalls **1.47 in short of flush**, the
       POLLEN is driven 0.42 in onto the supports (manifold normals `(0.89, ±0.46, 0)`) and 0.054
       in into the tiles, and its centre never rises.
    3. **A tilted lip's end cap OVERHANGS** (its normal carries `−sin(rise)` of down), which with
       the supports makes a downward-closing V the ball cannot rise out of at any drive strength:
       measured, a stacked column's bottom POLLEN did not clear at a roller speed of **160 in/s**.
       A level blade's leading face is VERTICAL and the ball rides up it.
    4. **A crest is pure cost.** Everything the ball climbs, the column climbs. A settled 8-column's
       bottom POLLEN already sits **0.44 in** toward the wall, perched on the lower bore's rim (the
       cage's 0.548 in of slack, transmitted down) — which IS the owner's "it depends on how they
       are stacked". The blade asks for 0.48 in of lift and nothing more.
    So the deployed ramp is ONE LEVEL BOX, `BB_RAMP_IN` … `BB_RAMP_OUT` (0.85 … 3.54 past the tip
    line), `BB_RAMP_FLOOR_Z` 0.40 underneath and `BB_RAMP_DECK_Z` 0.48 on top, rail to rail wide,
    plus the two rails. The owner's "slight slope up and a larger slope down" is the blade itself:
    the 0.08-in step at the lip lifts the POLLEN onto the deck, and the deck's inboard end drops
    it into the mouth. It is BOXES and not a `ColliderDesc.convexHull` for one reason —
    `groundRoll3d`'s perched-element rule reads a `ConvexPolyhedron` as "a narrow CAD hull" and
    would vibrate every POLLEN resting on the ramp's own deck.
    ⚠️ **THE DECK IS THE HALF THAT DELIVERS.** The old wedge stopped at its drop point 2.29 in out
    and left a 2.29-in VOID between itself and the mouth, so a POLLEN it did lift had nothing to
    stand on and fell back into the bore.
    ⚠️ **THE RAMP PIVOTS ON THE SWEEPER'S OWN SHAFT** (owner, 2026-09-21: "the ramp collides with
    the intake rollers when it is folded up"; and the original spec — *"the hole created by the U
    is where the intake rollers are situated in when the ramp is folded up vertically"*).
    `BB_RAMP_PIVOT_Z` = the roller's axis height (4.5; the RENDER lane pins it to `BB_ROLLER_Z`),
    `BB_RAMP_PIVOT_BACK` = its `u`. It used to hang 2.3 in UNDER the axle on the same `u`, so a
    folded rail stood across the shaft exactly where it runs from the barrel's end into its
    bearing, and the blade sat 0.77 in inside the r-2.0 flap sweep. On the shaft the rail's eye IS
    the bearing, the rails stand outboard of the barrel's ±7.32, and the blade keeps 4.93 in from
    the axle at EVERY swing angle (+2.93 past the flap sweep; `scratch/rampfold.ts`). Rails 18.7°
    → 36°, 5.8 → 6.9 in; a folded ramp stands 11.4 in. `BB_RAMP_IN` stays 0.85 (2.05 also
    measured 400/400 — the deck's length is not what extracts). Same grid: **400/400**, mean
    0.285 s, an 8-column drains in 72 ticks.
  - ⚠️ **A DEPLOYED RAMP DOES NOT MEET A FLOWER'S RING PLATES** (`sim3d/groups.ts`: `GROUP_RAMP` /
    `GROUP_FLOWER_RING`). Owner report: "it kinda gets caught on the bottom aluminum part of the
    flower and makes the whole robot jump upwards". MEASURED, 171 of 240 drive-ins lifted the
    chassis (to 0.23 in, vz 10 in/s) with NO penetration anywhere: the blade rides 0.046 in over
    the lower plate, and blade-bottom-edge × plate-top-edge is a SPECULATIVE contact with a
    diagonal normal, which a chassis that cannot pitch takes as a hop. No affordable clearance
    fixes it (it scales with speed). A hinged ramp would ride up; this one skips the ring plates
    only — posts, cage, walls, robots and every element still meet it, and the swing guard's
    query carries no groups. After: **0/240**, extraction 400/400.
  - ⚠️ **AND THE LIP IS DRIVEN, BECAUSE NO PASSIVE PROFILE CAN DO THIS.** `rampRollerDrive`
    (`sim3d/flower3d.ts`) raises the candidate POLLEN's velocity COMPONENT along the deck toward
    the rollers to `BB_RAMP_ROLLER_V` (50 in/s) and never reduces it, leaving every other component
    to the solver — a friction drive, which is what the roller at the top of a real ramp lip is,
    on the same motor as the intake. The bound it exists for: a POLLEN met on its flank retreats
    **0.458 in** onto the supports before it wedges, the lip would then need **1.541 in** of reach
    past the ball's centre, and the same supports cap the ramp at **1.156** (measured,
    `scratch/rampsup.ts`: the two `flower_peanut_support` hulls occupy `u 1.19…2.45` at
    `|v| 0.62…1.89`, and the 1.24-in lane between them moves with the driver's own lateral offset,
    so a tongue that fits it is a 0.1-in alignment requirement rather than a mechanism). The only
    lip height that beats it passively is `h ≤ 0.175`, under the plate's own rim.
    ⚠️ **THE DRIVE IS FLAT, AND THAT IS MEASURED, NOT ASSUMED.** Sweeping its rise angle over 400
    real drive-ins at the hardest column height (ONE pollen, dead on the axis, free to retreat):
    **0° 400/400, 10° 381/400, 18° 360/400, 25° 314/400, 35° 193/400, 45° 56/400.** Every degree of
    lift pops the ball off the deck instead of walking it along, and a ball in the air is one
    `derive.ts` re-claims into the tube. A version aimed at the mouth's own SEAT rather than
    straight down the deck measured no better (3 failures in 1200 against 2).
    ⚠️ **AND `BB_FLOWER_RETRIEVE_S` MOVED BELOW THE ROLLER.** It paces how often a POLLEN may be
    TAKEN; with the check above the branch the roller turned for one tick in nine. Every other
    retrieval path still reads it one line before it acts, so no other cadence moved.
  - **MEASURED, the sweep the previous pass owed** (`scratch/rampsweep.ts`, real drive-ins from
    16 in out with the stick held, no teleports; columns staged through the drop point and
    `bbFlowerScatter`, so they LEAN the way a match's do): four FLOWERS × stick 0.35/0.5/0.7/1.0 ×
    lateral −2…+2 in × approach angle −8…+8° × column height 1–8 × legal POLLEN/NECTAR mixes ×
    scatter seed — **400 runs, 400 extracted (100%)**, mean **0.39 s** and p95 **1.10 s** from the
    ramp reaching the opening to the POLLEN being in the hopper, 100% at every column height, every
    approach angle and every lateral offset. Forcing the height instead of drawing it: **h1
    400/400, h4 400/400, h8 398/400** — the two misses are the compounding corner every archetype's
    sweep finds hardest (a lateral offset AND an approach angle in the same rotational sense), they
    are the honest residue of a 1.156-in reach, and nothing in the code papers over them. BEFORE,
    on the same harness: the wedge extracted by physics in 0 of 5 staged columns and needed the
    stall fallback's teleport in every one. **DRAIN**: a full 8-POLLEN column empties completely on
    one held stick in **76 ticks (1.27 s)** — 0.50 s for the first and **0.05–0.20 s** for each one
    after, the column re-seating between each. The fast slice, worst seeds included, is in
    `scripts/smoke-biobuzz/flower3d.ts`; the through-the-blade probe and the ground-capture sweep
    (10 lateral offsets, intake on and off) are in `sim3d.ts`.
  - ⚠️ **THE RAMP SWING GUARD: A DEPLOY OR FOLD THAT WOULD CARRY THE RAMP INTO A STATIC REVERSES**
    (owner, 2026-09-20: deploying into a FLOWER should be refused, "same with un-deploying").
    `bbRampSwingProgress(r, time)` (`robot.ts`) is the ONE eased curve (smoothstep,
    `t²(3−2t)` over `t = elapsed / BB_RAMP_DEPLOY_S`) both the guard and the renderer's own ease
    read, `e ∈ [0,1]` (0 folded, 1 deployed) — `null` when no swing is in flight. **3D**:
    `bbRampSwingShapes(spec, heightIn, e)` (`sim3d/bodies.ts`) builds the crossbar + rails at ANY
    progress `e` about the FIXED PIVOT (`φ(e) = e·(π/2 + BB_RAMP_ANGLE)` from straight up),
    verified to reduce EXACTLY to `chassis3dReachShapes`'s own deployed numbers at `e = 1`;
    `rampSwingBlocked` is a free-floating Rapier shape-intersection query (never a collider on
    any body) filtered to `collider.parent()?.isFixed()` **OR the handle of another ROBOT's body**
    — walls, flower plates/supports, the hive FRAME and every other machine; never the hive tray,
    never this robot's own body (the blade hangs off it and would hit on every tick), never an
    element (sweeping POLLEN is the ramp's whole job). ⚠️ **IT WAS `isFixed()` ALONE UNTIL
    2026-09-21 AND A CHASSIS IS NOT FIXED**, so the query looked straight through one (owner: “I am
    able to deploy the ramp into another robot and phase”) — the deploy was allowed with the blade
    already inside the other machine, leaving the solver two overlapping solids to separate from
    the inside. MEASURED nose-to-nose: refused at 16..24 in of centre separation, deploys normally
    at 26 and beyond; with robots left out of the block set it deploys at every gap down to 16. **2D** (`bbRampSwingStep2d`, `play.ts`)
    has no z or partial-swing geometry, so it tests the FULL DEPLOYED FOOTPRINT rect (SAT) against
    the 2D field's own static rects (`biobuzzColliders.statics`, all `rot: 0`) every tick a swing
    is in flight — which covers "at the press" for free. A hit calls `bbRampReverse`: flips
    `bbRampOut` and re-stamps `bbRampAt` so the SAME curve runs backward from the CURRENT angle
    (symmetric — no snap), and sets `RobotState.bbRampBlocked` so the guard does not re-test for
    the REST of that one swing (it can only retrace ground already proven clear); a fresh press
    clears the flag. ⚠️ **A RIGID ARM ROTATING PAST 90° OVERSHOOTS ITS OWN FINAL REACH MID-SWING**:
    `sin(φ)` peaks at `φ = 90°`, which is BEFORE the arm's resting angle (`90° + BB_RAMP_ANGLE`),
    so the swing's outward reach exceeds the settled footprint's by
    `BB_RAMP_L·(1 − cos(BB_RAMP_ANGLE))` at the peak — MEASURED, a standoff that clears the
    SETTLED footprint's own clearance margin (0 in flush) can still be caught mid-swing (3 in off
    the foot still refused; 4 in and up settle clean). The guard is catching a real transient
    collision a final-pose-only check cannot see.
  - ⚠️ **A RAMP ROBOT MUST NOT BE ABLE TO FREEZE ITSELF** (replay 1dc6eb8f, 2026-09-25: frozen
    from 1:50 to the buzzer). The jam is one contact: the 0.08-in deck held VERTICALLY by a fixed
    body, so the solver pushes the chassis into the tiles, the floor pushes back, and friction on
    that contact holds the robot. Two ways in, both closed in `bbRampSwingStep3d` (`elements3d.ts`):
    - A fold pressed at speed just short of a wall reversed to a deploy that was never tested
      again ("it retraces proven-clear ground"). A swinging ramp has no collider, so the robot kept
      closing and the ramp settled 2.4 in inside the wall. Now only a reversed FOLD skips the test;
      a reversed deploy that hits again folds for good. Standing still, nothing changes.
    - A settled ramp driven across a hive foot bar or frame foot: the chassis clears them, only the
      blade meets them. `rampEmbedded` reads the step's own manifolds on `GROUP_RAMP` colliders; a
      fixed-body contact with `|n.z| > 0.5` deeper than `BB_RAMP_EMBED_DEPTH` (0.05) folds the ramp.
      Measured: 7 of 400 random drives froze this way before, 0 after.
    Once it was in the wall, every fold press reversed instantly, because the ramp was already
    inside the static. That is why the fix is a fold, not a stronger guard. Smoke: "ramp jam:" ×2.
  - ⚠️ **THE RAMP TOGGLE IS DEBOUNCED** (`debouncedPress`, `TOGGLE_DEBOUNCE_S` 2.5 ticks; `RobotState.bbRampUpAt`).
    The same replay held the button through two 1-tick dropouts, one a whole input frame of zeros
    (an empty gamepad read), and each flipped the ramp twice. The fastest real re-press in it was
    3 ticks. Smoke: "ramp debounce:" ×4. Butterfly `driveMode` shares the helper.
  - ⚠️ **SIDE ROLLERS RELOCATED TO THE MOUTH'S OWN EDGES** (owner, 2026-09-20: "situated on the
    edges of the robot, not near the center. It is to funnel things from the edge"). A wheel's
    axis is `bbSideRollerY(mouthHalf)` = `mouthHalf − BB_SIDE_ROLLER_EDGE_INSET`, not the old fixed
    `BB_SIDE_ROLLER_Y` — `chassis3dReachShapes` places the pair at `±bbSideRollerY(axes.half)`.
    `BbFlowerReach` grew `edgeGrip` (`BB_SIDE_ROLLER_REACH` sets `half: null, edgeGrip:
    BB_SIDE_ROLLER_GRIP`): the pair is 12+ in apart on a real chassis and cannot straddle a 2.8-in
    POLLEN, so `bbFlowerAtIntake`'s lateral test becomes "is the POLLEN within `edgeGrip` of
    EITHER wheel's own axis" (`min(|v−wy|, |v+wy|) ≤ edgeGrip`) instead of a centreline band — a
    driver lines an END of the intake up on the opening, never the middle. **A wide (realistic)
    chassis's wheel sits far outside a FLOWER's own plate half-width** (measured: `bbSideRollerY`
    ≈6.4–7.65 in against a 2.976-in plate half-width, at every buildable chassis width) — reaching
    one still works because the ROBOT, not the wheel, is what gets driven off-centre to line it up
    (the flush pose's HEADING absorbs the offset — see `mouthPoint`, `tutorial.ts` — never the
    stage position's `y`), but a few CAD-derived numbers that assumed the wheel sat near the
    chassis centreline (drive-in standoff, the FULL-predictor wall-standoff comparison) now read a
    wider but still-passing tolerance; their own comments carry the measurement.
  - ⚠️ **SIDE ROLLERS TUCKED IN FRONT OF THE DRIVE WHEELS, 2026-09-20** (owner: "right in front of
    the wheels... not sticking out like that" — the old build hung each wheel on its own outrigger
    off the front brace). `BB_SIDE_ROLLER_R` 0.75 → 1.0, `BB_SIDE_ROLLER_OUT` 1.9 → 0.9: the wheel
    spans −0.1 … 1.9 in about the tip line (was 1.15 … 2.65), its back half now under the side
    arm's own nose and its front poking only 1.9 in past the tip. At flush the x-bite against a
    FLOWER's bottom POLLEN is 0.92 in, a ≈0.42-in standoff-tolerance margin over the 0.5-in
    `BB_FLOWER_BITE` floor — as tucked as the geometry allows without losing the bite;
    `config.ts`'s own header on `BB_SIDE_ROLLER_R` carries the full derivation. The bracket in
    `scene/renderRobots.ts` is a single diagonal gusset from the arm's own nose to the wheel's
    axis now, not a level outrigger off the brace.
  - ⚠️ **SIDE ROLLERS ARE SOLID CYLINDERS NOW, AND THE GATE IS CONTACT, NOT A BOX — 2026-09-20**
    (owner: "the side roller should also be larger in diameter" and "it should also be colliding
    with everything. It is a physical thing"). `BB_SIDE_ROLLER_R` 1.0 → 1.5 (a 3-in compliant
    wheel) and `BB_SIDE_ROLLER_OUT` 0.9 → 0.4, so the wheel spans −1.1 … 1.9 in about the tip
    line — the SAME 1.9-in front poke as before (`OUT + R` unchanged: 0.9+1.0 = 0.4+1.5), the
    extra diameter going backward, further under the side arm's nose. `Chassis3dShape` grew a
    `shape: 'box' | 'cylinder'` field: a side roller's wheel is `ColliderDesc.cylinder(halfHeight,
    radius)` with its axis composed onto world Z (`reachColliderDesc`'s `CYL_AXIS_Z`, a fixed
    +90°-about-X quaternion — Rapier's own cylinder stands on local Y), in the DEFAULT collision
    group (`elementSolid: true`, same as the ramp's bar) rather than `GROUP_POCKET` — it meets an
    element, a wall, another robot, everything, and can never overlap a POLLEN. MEASURED: a
    30-in/s ground POLLEN fired head-on at a wheel deflects, never crosses it; between the wheels
    it still enters the mouth exactly as before.
  - ⚠️ **A SOLID WHEEL CANNOT OVERLAP THE POLLEN IT GRIPS, SO THE RETRIEVAL GATE IS A CONTACT
    RADIUS NOW, NOT THE OLD X-BITE BOX** — the box test assumed the wheel and the ball could sit
    dug into each other by a fixed depth, which stopped being true the instant the wheel became a
    real collider (a previous pass on this date found a real drive-in no longer landed inside the
    old ≈0.42-in window and papered over the mismatch by teleporting the robot in the smoke check).
    `bbFlowerAtIntakeMouth` (`play.ts`) tests the xy distance from a wheel's own axis to the
    POLLEN's centre against `BB_SIDE_ROLLER_GRIP` (`R + BB_POLLEN_R + BB_SIDE_ROLLER_CONTACT_TOL`,
    ≈3.25 in) AND the existing Z-BITE, same predicate in 2D (which has no solid wheel, so the
    robot CAN overlap — the same ≤ test, with no lower bound, still works) and 3D. The drive-in
    smoke fixture was restored to a REAL drive (no analytic reseat), tolerance re-measured at
    1.6 in (was 1.5 at the smaller wheel).
  - ⚠️ **THE POLLEN COMES OUT PHYSICALLY HERE TOO, GENERALISING THE RAMP'S OWN RELEASE — AND
    GETTING THE RELEASE POINT RIGHT TOOK THREE WRONG ONES, EACH MEASURED.** `flowerRetrieve3d`'s
    `siderollers` branch releases the bottom POLLEN as a `ground` element (never `capturePollen`s
    outright) exactly like the ramp's, and `bbIntakeExtraReach` grew a `siderollers` term
    (`BB_SIDE_ROLLER_OUT + BB_SIDE_ROLLER_R`) so the intake's own pull reaches out to sweep it in.
    Where to put it took three measured failures: retreating along `u` (toward the chassis, past
    the flower's own axis) ran the release straight into the wheel's own new solid body — MEASURED,
    a continuous drive through that overlap threw the element clear across the field the next tick
    (Rapier's own deep-penetration recovery, not a bounce); retreating further, to just behind the
    wheel's own inner edge (mirroring the ramp's own offset), found the pocket a side-roller
    archetype retreats into is only `bbIntakeReach` deep (3 in) and the wheel's span already
    reaches 1.1 in into it — MEASURED 0.2 in of headroom, not enough for a 2.8-in POLLEN to occupy
    without also touching the frame face; and leaving the release exactly at the flower's own true
    position (on the theory that a gripping wheel already presses in a little, which Rapier
    resolves as an ordinary contact force) MEASURED WRONG THE OTHER WAY — the ball's world position
    had not moved, so `derive.ts`'s tube test re-tagged it `element`/`flower:i` again the very next
    tick, invisibly (the stack never shrank). The release that works leaves `u` UNCHANGED (the
    true position already sits ≈0.5 in past the wheel's own outer edge — that is the contact
    condition) and shifts `v` toward the mouth's centreline by `BB_SIDE_ROLLER_RELEASE_CLEAR`
    (`BB_FLOWER_OPEN_R + 0.3`), landing inside the retrieval opening's own documented OPEN band
    (`config.ts`'s "the full plate width" — no support stands in it at this height) and clear of
    the wheel's lateral span in the same move.
  - **Verified by real driving, no teleports** (owner ruling — the retrieval-rate sweep):
    driving a `siderollers` build (front mount, mecanum) at 0.4–1.0 stick into F1's foot, intake
    held, over a lateral offset × approach-angle × stick × column-height (1–8) × seed sweep (135
    combinations: offset ∈ {`bbSideRollerY` ± 0, 0.8, 1.5 in}, angle ∈ {0, ±10°}, stick ∈
    {0.4, 0.7, 1.0}): **71.9% retrieved, mean time-to-first-pollen 0.80 s** once the offset/column
    dimensions alone are swept (a straight-on, `angle = 0` approach is **100%**, 45/45).
    Every failure is at `angle = ±10°` where the initial heading error compounds with the lateral
    offset in the SAME rotational sense (an angled approach starting already offset toward the
    side it turns away from); the opposite pairing (offset and angle opposite sign) mostly still
    lands. A centred approach (the mouth's own centreline on the flower, neither wheel on it)
    retrieves NOTHING, as designed. This is short of the ≥95% target across the full envelope —
    the compounding failure mode at a combined offset+angle is a real, measured limit of the
    current contact radius rather than a bug, and is left here as the open item for the next
    tuning pass rather than a claim this session did not earn.
    That sweep is a SAVED SCRIPT now — `scratch/sidesweep.ts`, the same 135-cell grid (`SS_ALL=1`
    runs all four FLOWERS per cell, 540) with the skew modelled as a straight approach AT the
    angle that ENDS on the lineup pose rather than a heading error held blind for 16 in, which is
    a driver aiming from one side rather than simply missing. It reproduces the envelope at
    **73.3 % overall, 100 % straight-on**, −10° 80 %, +10° 40 %.
  - ⚠️ **HOW FAR THE WHEELS HAVE TO STICK OUT — 1.004 in IS THE FLOOR, 1.65 IS SHIPPED, AND THE
    BRACKET MAY NOT COVER THE WHEEL** (owner, 2026-09-21: "do the side roller wheels need to stick
    out that much for flower intaking? it looks ugly and not the most realistic in terms of
    packaging"; and again, rejecting a first pass that kept 1.90 and answered with packaging alone:
    "The side rollers are rendered as being covered and still sticking out a ton. It cant be
    covered fully because it needs to actually touch the balls"). `config.ts`'s own header on
    `BB_SIDE_ROLLER_R` carries the full working and both tables.
    - **What the chassis stops against is the FLOWER's own ring plates, on the TIP LINE.** A
      BIOBUZZ chassis is one RECTANGULAR PRISM to a static (frame + arms + lintel +
      `chassis3dPocketShapes`), so its whole front face stops at `uOut`. Probed off the real 3D
      colliders (`scratch/srgeom.ts`), in the approach frame: the LOWER RING PLATE is `u ≤ 2.404`,
      `z −0.199 … 0.354`, the MID PLATE `u ≤ 2.415`, `z 3.904 … 5.254`, and between them the
      retrieval window is clear back to the peanut supports at `u −1.185`, the full ±2.976 plate
      width. A real square drive-in settles at `uTip` **2.4145** — `BB_PLACE_REACH` to 0.03 in.
      Only the wheel (z 0.5 … 2.5) gets through the window, so its FRONT must stand
      `2.404 − BB_POLLEN_R` = **1.004 in** past the tip line to touch the bottom POLLEN at all.
      Relieving the arm nose to get deeper is not available: the pocket filler is what stopped a
      fork driving over the hive's foot bars.
    - **Above that floor the reach buys recovery from YAW, and two populations disagree.** A
      chassis driven into a FLOWER meets the ring plate over only ONE SIDE of its own width — the
      driver is offset `bbSideRollerY` to put a wheel on the opening — so the normal force is a
      long lever and the settled pose picks up **18–22° of yaw**, which swings the gripping wheel
      out. `scratch/sidesweep.ts`, real drive-ins, no teleports:

      | protrusion | 1.90 | 1.85 | 1.80 | 1.75 | 1.70 | **1.65** | 1.60 | 1.50 | 1.45 | 1.40 |
      |---|---|---|---|---|---|---|---|---|---|---|
      | held-intake, all 540 | 73.3% | 68.5% | 64.4% | 60.0% | 63.9% | **63.9%** | 57.6% | 60.0% | — | 60.0% |
      | held-intake, straight-on | 100% | 100% | 100% | 100% | 100% | **100%** | 99.4% | 100% | — | 100% |
      | PARK then intake (36) | 61.1% | — | — | — | — | **58.3%** | 44.4% | 33.3% | 0.0% | 0.0% |

      The held-intake sweep alone would allow **1.40** — a driver holding the trigger takes the
      POLLEN on the way in, mean 0.24 s — but a driver who rolls up and only THEN presses it gets
      nothing at all below 1.45. **1.65** is the largest cut that costs neither population
      anything measurable. `scripts/smoke-biobuzz/flower3d.ts`'s F1 drive-in fixture is the
      canary: driven in with the intake OFF and asked once at the settled pose it bites at 1.90
      and at no smaller value at all, so it now holds the trigger through the drive and its own
      header carries this table.
    - ⚠️ **AND THE WHEEL FRICTION EXPERIMENT IS RECORDED AS A FAILURE, NOT A FIX.** A free-spinning
      compliant wheel should roll along a wall rather than grab it, and the far wheel really does
      reach the wall beside a FLOWER (probed at the settle, 0.036 in of penetration), so the
      cylinders were given `friction 0` with `CoefficientCombineRule.Min` — the tile plane's own
      trick, which reads 0 against a wall/static/robot while an ELEMENT's MAX still outranks it.
      MEASURED, 540 runs either way: **324/540 both**, not one run flipped, settle moved 0.002 in.
      The yaw is a NORMAL-force moment off the plate, not a friction moment. Reverted; the reason
      is in `reachColliderDesc`'s own header so it is not re-tried blind.
    - **The bracket is a REAR YOKE.** Two straps, above and below, running diagonally from the side
      arm's rail to the AXLE and ending in a `BB_SIDE_ROLLER_BOSS_R` bearing boss; a dead axle
      between them; a web behind the wheel's own rear tangent. Nothing is drawn forward of the axle
      line except the boss and nothing caps the tread, so **223°** of it stays visible from every
      angle, full height (a strap parallel to the rail cannot even reach the axle and starts
      occluding at 90°; the RENDER lane measures the open arc off the built meshes' own vertices).
      The wheel is a hub with a lugged compliant tread — twelve facets of the same 12-gon the
      SOLID is, offset 15° so their corners land exactly on `BB_SIDE_ROLLER_R`, six full height
      and six slightly recessed. `bbSideRollerYokeY` (`config.ts`) is the one number both
      renderers place the yoke by, because `drawRobot.ts` may not import the scene chunk.

- **Verification:** `scripts/smoke-biobuzz/sim3d.ts` (SIM3D lane: seam, drive parity, two-run
  hash, conservation, containment with `containmentFixes === 0`, CCD, capture, launch into either
  up cell, 18/29-in clearance, tip/spill, perf ≤ 1.5 ms, CAD probe agreement) and `render.ts`
  (RENDER lane); `scripts/scene-preview` (side-by-side 2D/3D page with a named-object check);
  `scripts/field-cad/preview` (GLB viewer). In an automated browser, drive the game through the
  live `GameController` (React fiber from the canvas) and judge progress by `world.tick`, since
  `requestAnimationFrame` only advances when a paint is forced.

---

# SECTION 11 — G407 OVER-CONTROL, AND THE TWO WAYS IT WAS UNREACHABLE

`src/games/biobuzz/penalties.ts` is the engine; read its header first. This section is only the
part that was BILLING NOTHING, because both halves of it are the kind of bug a passing test
suite hides.

⚠️ **OWNER REPORT 2026-09-21: "Overpossession penalties are not being given right now."** It was
true, in the two places the owner actually plays, and twenty placed G407 fixtures were green the
whole time. MEASURED (`scratch/g407probe.ts` — a driven six- and eight-element herd, empty and
full hopper, intake on and off, AUTO / TELEOP / free drive, both pipelines):

| pipeline / phase | peak per-element hold | count reached | billed |
|---|---|---|---|
| 2D, AUTO + TELEOP | 1.27 s | 6 (10 with a full hopper) | WARNING + STRATEGIC MAJOR |
| 2D, free drive | **0.00 s** | 0 | **nothing** |
| 3D, every phase | **0.00 s** | 0 (4 with a full hopper) | **nothing** |

Two independent causes, one per broken row. Neither is a tuning question and neither was
reachable from a hand-advanced fixture.

- ⚠️ **IN 3D A PLOWED ELEMENT IS TAGGED `flight`, AND BOTH HALVES OF THE RULE READ THE TAG.**
  `derive.ts` calls an element airborne when its bottom is off the tiles by `AIRBORNE_Z` (0.05 in)
  or its `vz` exceeds 1 in/s and it has not read at rest — a fair description of a ball in the air
  and ALSO of a 3-in ball being shoved across a tile seam, because **a plowed ball SKIPS**.
  Measured on a driven herd, the element was tagged `flight` on **14.3%** of the ticks it was in
  chassis contact, interleaved with the `ground` ones every few frames. `controlledArtifacts`
  filtered the field to `ground`, so a skipping element was not a candidate to be counted; and
  `bbSweepControlClocks` treated a non-`ground` element as GONE and **deleted** its hold, anchor
  and carry, so every skip reset the confirm clock to zero. That is why the hold peaked at
  exactly 0.000 against a `POSSESSION_CONFIRM` of 0.45 — not "nearly", *never*. **And every
  server-connected match is 3D** (the 2026-09-18 ruling above), so G407 was unreachable in every
  room on the server, by construction.
  The fix is `ControlGeometry.loose` — a fourth slot on the shared interface, defaulting to
  `b.state.kind === 'ground'` so DECODE and Chain Reaction are byte-identical — and
  `bbLooseElement`, which asks the physical question the tag was standing in for: is it loose,
  and is it on the floor. `ground` always is; `flight` is too when its bottom is under
  `BB_CONTROL_SKITTER_Z`. **`bbSweepControlClocks` MUST use the same predicate** — a sweep
  stricter than the count deletes the clock of an element the count is still looking at, which
  is the whole of the second half of this bug.
  ⚠️ **THE `flight` ARM IS GATED ON THE 3D SOLVE AND THAT IS NOT SUPERSTITION.** The 2D pipeline
  is PERMANENT and has no skip — a `ground` element stays `ground` from the moment it lands — so
  the arm buys it nothing, while a 2D arc's descending tail does pass through the band. Taking it
  out of 2D is the difference between a fix and a fix plus a change nobody asked for.
  **`BB_CONTROL_SKITTER_Z` (2 in) is MEASURED** (`scratch/skitter.ts`, four seeds × three
  headings): over 14,340 ticks of chassis-on-element contact while plowing, the element's bottom
  never rose above **0.92 in**; over 246 ticks of a real shot passing over a chassis in plan, it
  was never below **7.60 in**. The two distributions do not touch, so the constant is a gap and
  not a threshold — it sits 2.2× above the skip and 3.8× below the lowest shot, and neither
  number has to be re-measured to the inch for it to keep holding.
- ⚠️ **FREE DRIVE COUNTS** (and DECODE got here first, for the same reported reason — see the
  "FREE DRIVE COUNTS" paragraph in `src/sim/penalties.ts`). `freeplay` fell through this engine's
  "no fouls outside the played periods" guard, so the whole of Section 11 was inert in the mode
  people practise in. Free Drive is DRIVER PRACTICE, and practising without the fouls a match
  would give you is the opposite of practice. The phase-specific rules stay inert on their own
  terms rather than by a second list: G402 tests `isAuto`, G407 and G421 are about what a robot
  is doing right now, and — the one carve-out — **G410 is explicitly unlocked in `freeplay`**.
  Its cue is written as "unlocked WHEN teleop is inside 1:00" and negated, so every other phase
  is locked BY DEFAULT, which is the safe direction in a match and the wrong one in a mode with
  no clock to be early against: without the carve-out, opening free drive made every NECTAR ever
  placed in a FLOWER in practice a MAJOR.

**FALSE POSITIVES — 0, on every carve-out shape** (`scratch/g407fp2.ts`, six seeds each, clumps
of six and eight, both pipelines): a POKE that touches and reverses inside `POSSESSION_CONFIRM`,
a DRIVE-PAST that clips the clump with a flank in transit, and PARKING against a clump for six
seconds all bill **nothing**. The BIOBUZZ tutorial — whose worlds are FREE DRIVE, i.e. exactly
the mode just opened — bills **0 G407 lines over all seven steps × both alliances × both
pipelines**, ten seconds of scripted driving each.

**AND THE RATE ON REAL PLAY IS THE 2D RATE.** The honest control here is free: 2D match play was
already billing this rule and had been shipping, so it is the accepted baseline. Over 8 seeded
2v2 AI-vs-AI matches per cell, 60 s of TELEOP, four bots driving:

| tier | 2D warnings / majors | 3D warnings / majors |
|---|---|---|
| easy | 15 / 0 | 13 / 1 |
| medium | 11 / 0 | 12 / 0 |
| hard | 12 / 0 | 9 / 0 |

3D now sits inside the 2D band rather than at zero. No threshold was invented to get there — the
3D pipeline was made to agree with the one that has been enforcing this rule all along.

**EGRESS.** No new `World`/`RobotState` field, but `world.penalties.{ballHold,ballAnchor,ballCarry}`
rode every 3D snapshot as EMPTY objects before (the sweep wiped them each tick) and now carry
entries, and `slimWorld` keeps `penalties` verbatim. Measured, 2v2 3D, hard bots, 1,800 snapshots
at 30 Hz: **+257 B/snapshot raw** (3.7% of a 7.0 KB frame), **+135 B/snapshot deflated**
(**+3.94 KiB/s per client**, 6.35%) — and that deflate figure is a CEILING, since it is measured
per frame while the server runs `permessage-deflate` with context takeover and these maps are
highly repetitive across frames. If it ever has to come down, the lever is stripping the three
maps from `slimWorld` (they are read by the penalty engine alone), which is a netcode change and
a prediction-divergence question, not a rules one.

**Verification:** `g407DrivenChecks` in `scripts/smoke-biobuzz/rules.ts` — 34 checks. It
deliberately breaks that lane's "do not drive" doctrine for the same reason `g402DrivenChecks`
does, and it is the same class of bug a second time: a placed fixture cannot fail for a rule that
never reaches a robot which had to drive. It asserts the billing AND the three carve-outs on a
driven robot, in both pipelines and all three live phases, and it asserts the per-element hold
clock actually latched rather than only the tally. ⚠️ The `loose` predicate itself is checked
KINEMATICALLY and must stay that way: `state.kind` is DERIVED from height and motion every tick,
so a driven fixture that hand-tags a row `flight` has it re-tagged before the next penalty pass
reads it, and the run then measures the tagger instead of the rule.

## 2026-09-22 — NEITHER G402 NOR G407 IS CAPPED PER MATCH ANY MORE

Owner ruling, superseding both "per MATCH" readings of Table 10-4: "right now you can only get
penalized once for crossing and tapping a robot in auto. Fix that. Also overpossession
penalties." Both per-robot latches are gone from `penalties.ts`.

- **G407** bills every STRATEGIC instance: each 6+ streak sustained past `BB_MOMENTARY_S`, and
  each 5+ instance from the second onward. Nothing debounces it — the two `qualified` flags are
  the single tick a streak crosses MOMENTARY, so a pile has to drop below the count and climb
  back to qualify again. `bb.held[robot].g407billed` is still written, as the HUD's
  `controlMajor` marker and nothing else.
- **G402** bills every crossing, and what makes two ticks one instance is a RE-ARM WINDOW
  (`BB_G402_REARM_S`, 1 s) kept on `world.penalties.episodes` — DECODE's own episode debounce,
  not `foulEdge`, which this rule no longer uses. It is there because the contact test flickers:
  measured over a 908-duel sweep, head-on rams never flicker, but angled and offset ones go clear
  for up to **0.78 s** mid-hit while the two footprints stay within **3.4 in**. That band drifts
  with the chassis — an earlier sweep, one dimension different, peaked at 1.53 s — so the window
  is sized to the flicker rather than to the widest thing ever seen: too long swallows the genuine
  second hit the owner reported, which is the worse direction to be wrong in.
- The rules lane's `bill()` now advances `world.time`, because `step.ts` does and the window is
  measured against it. A fixture with a frozen clock holds every window open forever.

---

# AI DRIVERS (`src/games/biobuzz/ai/`) — Day 3, plan §6; rewritten 2026-09-22

`GameSimModule.bot` is filled for BIOBUZZ and absent for DECODE and Chain Reaction. Three tiers
(`easy` / `medium` / `hard`), ONE policy: `tiers.ts` is a table of numbers the single state machine
in `policy.ts` multiplies or branches on, so "Easy is a worse driver" never becomes "Easy is a
different program". **No tier may read anything a lower tier cannot** — difficulty is execution
(speed, reaction delay, where it shoots from, how it picks targets), never information. **And no tier
is allowed to be broken**: the stuck test, the reachability test and the foul guards are the same
for every tier.

**Measured, 3D, 20 seeds a cell (`npm run bench:ai`).** Solo = one bot against an idle robot; 2v2 =
four bots of one tier, points per alliance.

| | solo easy / medium / hard | 2v2 easy / medium / hard | max stuck run | fouls / alliance |
|---|---|---|---|---|
| before (every bot on the default chassis) | 25.8 / 48.0 / 62.4 | 55.1 / 88.9 / 90.3 | 24–76 s | 1–14.5 pts |
| after (roster builds) | 95.5 / 181.4 / 247.6 | 137.0 / 230.3 / 260.2 | ≤ 4 s | 0–2 pts |

The old HARD bot was stuck for 63 s of every match on average (a 12-s corner press in almost every
one) and EASY stood idle for 113 s of 150. Head to head now, 12 seeded 2v2s each: HARD beats EASY
12–0 (margin 154), MEDIUM 11–1 (margin 64), and MEDIUM beats EASY 12–0 (margin 99).

- **The memory is the CALLER's.** `bot.create(world, robotId, tier, seed)` returns a `BotSeat`; the
  caller (the controller in practice, `Room` on the server, the LAN host worker) calls
  `seat.step(world)` ONCE per tick before `biobuzzStep`, puts the result in the command map, and
  **records it exactly like a driver's** — so a replay of a match with a bot in it re-simulates with
  no bot at all. Nothing about the bot is written to the `World`. There is deliberately **no
  memoryless `drive`**.
- **The robot is the driver's too** (`BotDriver.build`, `ai/builds.ts`). Six roster builds — every
  launcher, five drivetrains, sweepers and side rollers on three mounts, two Box Tube builds — each
  a coercer FIXED POINT, legal at every anchor, ≤ 18 in tall so it drives under the HIVE. The pick
  is a pure function of `(seed, robotId)` (the tier does not pick the robot), so the bots of one
  match are always different robots. `game.ts` calls it with the practice seed; `Room.startMatch`
  draws the match seed BEFORE laying out the seats so it can do the same, and a rematch keeps the
  robots it had (it reuses `matchSetups`).
- ⚠️ **`ai/` IS SIM CODE AND IT IS IN THE MAIN CHUNK.** No DOM, no clock, no `Math.random`, no
  `process`, no `import.meta`, and nothing from `sim3d/` but `tilt`. The AI lane greps for all of
  it. **It never reads `world.rngState`** (the lane's `Proxy`); its randomness is its own mulberry32
  chain seeded `(matchSeed, seat)`. Commands leave through `localizeCommand`, and the bot re-decides
  every `BB_AI_DECIDE_TICKS` (6) and holds in between.
- ⚠️ **SHOOT FROM WHERE IT GOES IN, NOT WHERE THE VERDICT SAYS YES.** `bbFlightEnters` is the 2D
  ballistic model; under the 3D solve a shot from inside 24 in or from the side clips the cell and
  the frame. Measured over 247 match shots of the old policy: 56 % in, 5 of 79 from inside 24 in.
  Off a grid of stands the turret is 100 % at 30–48 in within 30° of the mouth normal, the dumper
  at 30–42 in within 45° (`BB_AI_TURRET_D` / `BB_AI_DUMP_D`, `ai/tuning.ts`). A turret also shoots
  on the move, but never CLOSING on the cell: tangential and receding shots are 24/24 at every
  speed, closing ones 0/6 at 40 in/s (`BB_AI_MAX_CLOSING`).
- **Count to the TIP** (`tipSense`): fire what the cell needs and keep the rest, never fire into a
  tray that has tipped but not released, and walk to the far cell while the tray swings.
- **A goal is CHECKED and a route is PLANNED** (`ai/geom.ts`): an element whose only mouth-on pose
  puts the chassis in a wall is approached another way or not at all (`poseClear`), and routes go
  round the foot bars (`nextWaypoint`). A TANK arrives along a line through a staging point — it
  cannot slide onto a pose beside it, and chasing one from close range shuttles over it.
- **Stuck is measured at any speed** (commanded motion, no displacement, 0.6 s) and the escape picks
  the clearest of twelve directions, statics included. A **stall** (no motion, no turn, no pickup, no
  shot for 2 s while collecting or scoring) replans too — the logic can deadlock where the field
  does not.
- **The foul guards, each from a measured case:** G402 — in AUTO nothing steers toward the centre
  line near it, including an escape; G421 — back off an opponent after `BB_AI_PIN_DECISIONS` of
  contact; G410 — FLOWERS are a keep-out zone and a NECTAR lying against one is not collected before
  the cue (a tank spinning next to F2 knocked its own NECTAR in, 20 points); G407 — a full hopper
  steers round loose elements and sheds anything on its bumper, and a pile the hopper cannot take
  costs extra, because the hold clock LEAKS (0.1/s) and elements shoved aside keep counting.
- **The clock:** park in the LOADING ZONE at the end of AUTO (LEAVE + PARK) and of the MATCH, leaving
  when the drive takes as long as the time left — unless the hopper holds a TIP it can fire first.
- **The FLOWER plan** (a Box Tube build that carries NECTAR, `places` tiers): empty the hopper into
  the HIVE before the cue, collect only own NECTAR, press the human player's button at the zone, and
  place one NECTAR per FLOWER in value order from 1:00. One NECTAR on four POLLEN is 15 points; the
  two tube builds score ~50 FLOWER points a solo match.
- **2v2:** leave elements the partner is clearly nearer, take the other side of the envelope, park
  at the other end of the zone, and a partner nearer a FLOWER with NECTAR aboard takes it.
- Tuning the rewrite added lives in `ai/tuning.ts`; `config.ts`'s `BB_AI_*` block still carries the
  cadence, arrival radii, wall band, pin clock and give-up radius it reads.
- **Verification:** the `AI` lane (the seam, determinism over 3,600 ticks under BOTH physics, the
  read list, quantization, R102, `step3d` perf with bots) and the **`AIPLAY` lane** (the roster:
  fixed points, not the default, legal, varied, deterministic; both seating sites call `build`; and
  three fixed-seed matches — a HARD solo over 150 with the FLOWER plan paying and both parks, a HARD
  2v2 through a minute of TELEOP with zero fouls, an EASY 2D solo that still scores — none stuck over
  5 s), run through `smoke-biobuzz/botmatch.ts`, the bench's own measurement. `npm run bench:ai` is the
  measurement (`--vs hard:easy`, `--builds <key>`, `--physics 2d`); `npm run test:ai` is the
  statistical tier ordering, a RATCHET — read `BB_AI_WIN_RATE_FLOOR`'s comment before changing it.

**R102, the STOW HEIGHT and the DEPLOY LATCH** (plan §3.3). R105.A's 29 in is the EXPANDED height
(`BB3_HEIGHT_MAX`); R102 limits the STARTING CONFIGURATION to an 18-in cube (`BB3_STOW_MAX`). A
build over the cube is modelled as folding to exactly it (`bbStowHeightIn`), because `RobotSpec`
carries no `stowHeightIn` field yet — adding one is a `src/types.ts` edit plus a carry-across in the
shared `coerceSpec`, and until then a DECLARED value is read structurally so the rule binds the day
the field lands. `coerceBiobuzzSpec` normalizes a declared stow to `[BB3_HEIGHT_MIN, heightIn]` and
**deliberately does not clamp it to 18** — that would make `bbStowLegal` true by construction.
The RULE refuses, at `GameSimModule.startLegal`; the builder says so first. Deployment is a READ of
`world.match` (`bbDeployed`), never a stored latch, and `sim3d/engineImpl.ts` rebuilds the chassis
collider at that edge, recording the height it built (`Engine3d.robotHeights`) so READBACK subtracts
the same half-height it added — get that wrong and the robot's `z` jumps on the deploy tick.

---

# THE MASS MODEL AND THE PRESET LIST — 2026-09-22

⚠️ **BIOBUZZ OWNS ITS MASS FLOOR NOW, AND EVERY PART OF THE BUILD PAYS FOR ITSELF** (owner:
"Review all configuration options for biobuzz... Focus on the mass of each component... Single
intake single turret should weigh like 18lbs minimum"). What it replaced was
`massLimits(drivetrain, inertia, bbMassFloorBump(spec))` — DECODE's per-drivetrain floor plus a
bump that priced exactly TWO things, a second turret (2.5) and a Box Tube (2.0). A sweeper
weighed nothing, a turret weighed nothing, a dumper weighed nothing and a SECOND sweeper edge
weighed nothing, so a bare mecanum chassis and one carrying a turret and two sweepers had the
same floor: 18 lb, which is also not a bare chassis — DECODE's 18 already prices in DECODE's own
shooter.

`bbMassLimits(spec)` (`config.ts`) is the one model, read by the coercer, by `bbDials` (the
builder's slider) and by both preset lists. `bbMassFloorBump`, `BB_TWIN_MASS_FLOOR` and
`BB_LIFT_MASS_FLOOR` are gone. Floor = BARE CHASSIS + one `BB_MASS_SWEEPER_EDGE` per mounted
edge + the launcher + a Box Tube, rounded to 0.01 for the reason `massLimits` documents. Every constant is APPROX with its reason on its own line:

| part | lb | | drivetrain (bare) | lb |
|---|---|---|---|---|
| sweeper edge (`frontback`/`side` pay twice) | 1.5 | | mecanum / xdrive | 11.5 |
| single turret | 5.0 | | tank | 13.0 |
| second turret of a double | +3.5 | | swerve | 15.5 |
| dumper | 3.5 | | butterfly | 17.0 |
| Box Tube (OFFSET kit ~475 g + claw) | 1.5 | | | |

Resulting floors: mecanum one sweeper one turret **18.00**
(the calibration point, asserted EXACTLY), xdrive 18.00, tank 19.50, swerve 22.00, butterfly
23.50; mecanum + dumper 16.50; + a tube 19.50; swerve + two sweepers + a double + a tube 28.50.
The CEILING is the shared per-drivetrain envelope (42, swerve 40) because **R104 sets no robot
weight limit in BIOBUZZ** (`docs/biobuzz-reference.md` §6) — there is no rules number to use, so
what is left is the sim's own statement of what a drivetrain can still move.

⚠️ **AND IT ONLY BINDS BECAUSE THE RAW MASS IS CARRIED ACROSS.** `coerceSpec`'s own mass pass
(`src/sim/spawn.ts`, step 4) runs BEFORE the BIOBUZZ arm and its floor is HIGHER than this model
for every drivetrain, so it would lift a legal light build before the model was ever consulted —
a tank turret build would come back at DECODE's 22 rather than at its own 19.50, and a preset the
coercer moves is a card that can never read as selected. `out.massLb = sp.massLb` sits with the
`bbMech` / `heightIn` / pass-target carry-across lines in that arm and the game's own clamp does
the work. Nothing outside `game === 'biobuzz'` is touched.

⚠️ **BIOBUZZ HAS NO INERTIA** (owner, 2026-09-24). `flywheelInertia` is a DECODE field on the
shared `RobotSpec`; `coerceBiobuzzSpec` pins it to 0 and nothing in this game reads it. It used
to feed the mass floor (`4 · flywheelInertia`), and a new BIOBUZZ spec is seeded from DECODE's
`DEFAULT_SPEC` at 0.4, so the builder showed mecanum + turret at 18.6 and tank + turret at 20.1.
The turret (5) and dumper (3.5) absorbed the pound the presets' old value added, so preset
floors did not move.

**THE PRESETS** are the StarterBot (`presets.ts`, the one real kit robot, still alone in front of
the rule-off) and four demos in `config.ts`. Scored head-to-head against the StarterBot with HARD
bots, 3D, a full 150-s match: **Sniper 70.4 · Skimmer 68.0 · Forager 63.6 · Pollinator 55.0 ·
StarterBot 43.0.**

| card | build | mass | rpm | floor | score |
|---|---|---|---|---|---|
| StarterBot | tank · front sweeper · front dumper | 18 (ON its floor — no kit publishes a weight) | 286 | 18.00 | 43.0 |
| **Pollinator** (`BB_PRESETS[0]`) | mecanum · front sweeper · centre turret · back Box Tube | 24.5 | 435 | 19.50 | 55.0 |
| Forager | butterfly · FRONT+BACK sweepers · front dumper | 30.5 | 420 / 300 | 23.50 | 63.6 |
| Skimmer | xdrive · front sweeper · right+left double turret | 27.5 | 520 | 21.50 | 68.0 |
| Sniper | swerve · FRONT+BACK sweepers · centre turret | 26.5 | 480 | 23.50 | 70.4 |

⚠️ **THE FORAGER REPLACED A CARD CALLED "HAULER" THAT NOBODY SHOULD HAVE PICKED** (2026-09-22).
The Hauler was a 32-lb tank with a REAR dumper and it MEASURED **25.8** against the StarterBot's
43.0 — and the StarterBot is the same drivetrain and the same archetype at 18 lb. Five seeds per
variant: front dumper 34.4, side sweeper 21.8, side sweeper behind a rear dumper 4.0 (the bot
cannot drive that at all). About half the gap was the rear mount, which costs a reverse into
range, and half the 32 lb, which costs cycles. It was also Chain Reaction's Hauler card copied
verbatim, name and team line both, which is its own reason to stop shipping it.

What replaced it keeps the "heavy, no turning" idea and drops the reversing: FRONT+BACK sweepers
fill driving either way, a FRONT dumper unloads without backing up, and BUTTERFLY is the one
drivetrain with two gearings to choose between — 420 on the mecanum set to cross the field, 300
on the traction set to hold a lane. It is the only card heavy enough for the second half of that
to mean anything, and it is the only butterfly on the list, so the five cards now cover all five
drivetrains. MEASURED **63.6 over eight seeds**, second on the list.

⚠️ **AND THE SPREAD IS WIDE — DO NOT READ THESE MEANS AS PRECISE.** The same build at 29.5 lb
scores 57.6 and at 30.5 lb 63.6 over the same eight seeds, and single seeds range 40…108. Half a
pound does not really move a robot 6 points; a 150-s 3D match with two bots is chaotic and five
seeds is a coarse instrument. The numbers are here to separate 25.8 from 63.6, which they do
comfortably, and not to rank 63.6 against 68.0.

⚠️ **`tankRpm` IS PART OF BEING A FIXED POINT.** `coerceSpec` writes that field for BUTTERFLY and
STRIPS it for every other drivetrain, so the Forager must declare one (300) and no other card may.
`bbSpecMatches` compares it, and `bbPresetLines` prints BOTH gearings for a card that has one —
a butterfly card showing a single rpm would describe half of the reason to pick it.

Each demo declares a mass ABOVE its floor (four cards on their own floors say nothing about the
tradeoff between them) and each is its own floor plus a WHOLE number of pounds, so it is a
position the 1-lb mass slider can return to. `BB_DEMO_LIFT`'s keyed-by-name map is unchanged and
now has the Pollinator as its one entry: `BB_PRESETS[0]` must stay a literal with no `bbMech`
container (`coerce.ts` builds `BB_DEFAULT_SPEC` from it), a launcher migrates from the flat
mirror and a Box Tube has no such path.

⚠️ **CHANGING `BB_PRESETS[0]` MOVES `BB_DEFAULT_SPEC`, AND SIX FIXTURES WERE MEASURED ON THE OLD
ONE.** The default build is the chassis every `mkWorld3d`, `bbSetup` and `bare()` gets when it
does not say otherwise, and the old default (the Sniper) had a SYMMETRIC 21 × 17 footprint —
FRONT+BACK sweepers, 10.5 in off the centre either way. The Pollinator's front-only sweeper is
21 × 17 too but ASYMMETRIC (10.5 front, 7.5 rear), and that moved, in order of how well they were
hidden:
- `START_CHASSIS_HALF` (`config.ts`) is a MEASUREMENT of the default build — the half-extent on
  its WALL side, every anchor being written facing into the field. 10.5 → **7.5**, or all four
  anchors float 3 in off their own wall and G304.C refuses them as written.
- the G304 clause probes (`field.ts`) seated two poses at the footprint's MIDPOINT, which is only
  on the wall for a symmetric build. `e.rear` now.
- the G421 pin lane and the `park-examples` gallery cell are both drawn against the 21 × 17 in as
  many words in their own headers, so they STATE that build (`PIN_BUILD`, `PARK_BUILD`) instead of
  inheriting it. Eighteen pin checks read as "the detector bills nothing" when the pairs stopped
  touching.
- the SIM3D dumper close-limit fixture pins `intakeMount: 'frontback'`, because a dumper fires
  over the BACK edge and the 24-in table was measured with a sweeper bolted there: on a front-only
  build 4 of 4 clear at 24 in.
- the corner-graze scene pins `drivetrain: 'swerve'`. MEASURED both ways on one rig: swerve slides
  past a 0.35-in graze at 1.00 of a free run and 0° of yaw, **MECANUM HOOKS AT 0.30 AND 94°**, and
  neither width nor intake mount changes either answer. The edge break's band is a drivetrain fact
  that check never claimed to cover, and the mecanum case is OPEN — it is the owner's original
  "I can get stuck on a corner" for what is now the DEFAULT build.

⚠️ **THE TRIANGLE INTAKE WAS NOT BUILDABLE AT ALL.** `BB_MIN_LENGTH` is 13.5 and that preset's
shared ceiling is 13, so `bbEnvelope` handed back an INVERTED length range, `bbMountFits` was
false at every mount, and the coercer silently reset a SIDE or FRONT+BACK sweeper to `front` and
pinned the chassis half an inch over the ceiling. The game's own floor is capped to the intake's
own ceiling now. It only ever reached a spec carried over from another game, because the BIOBUZZ
builder has no intake-STYLE picker.

**THE CHASSIS GOES TO 18 × 18** (owner, 2026-09-24: "why is max width/length 17 not 18?").
`BB_MAX_LENGTH`/`BB_MAX_WIDTH` are `ROBOT_MAX_SIZE` (R102's cube); the 17 was a "working inch"
no rule asks for. And length was never reaching even that: `src/sim/spawn.ts` sized a BIOBUZZ
spec with DECODE's `lengthLimits`, whose ceiling (15 sloped) is DECODE's in-cube roller rule. The
BIOBUZZ arm now carries the raw `length`/`width` across like `massLb`, and `bbEnvelope` keeps only
the shared FLOORS. R105.A's prism still binds: chassis + deployed sweepers + tube fit 18 × 24.

⚠️ **THE WIDTH RANGE DEPENDS ON THE LENGTH.** The legal set is the union of the two R105.A
rectangles (24 along the length, or along the width). `bbEnvelope` used to pick ONE per build;
at an 18 ceiling that made a front sweeper + flank tube build choose 18 × 15.5 over 15 × 18 and
shrink every saved 15 × 17 build of that shape. Now the length range is the union's and the width
range is the widest one any rectangle holding that length allows; `coerceBiobuzzSpec` clamps
length first and then reads width off it. The HOPPER slider is still 1–4 for every build
(`BB_STORAGE_MAX`, owner ruling).
