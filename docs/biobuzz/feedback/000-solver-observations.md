# 000 — what the shared artifact solver does with 1.5" pollen

Written by Claude, 2026-09-11, against `2b622f7` plus the working tree of Phase 0.5.
This file is the reverse of the usual dump: nobody asked a question, the gallery was read and
written down. It exists because POLLEN now ride `solveArtifacts` (the owner's artifact solve)
at `BB_POLLEN_R` = 1.5" instead of a bespoke BIOBUZZ integrator, and somebody has to say out
loud what that looks like before the season's rules land on top of it.

**Nothing here was tuned.** No shared constant and no BIOBUZZ constant was changed to make a
picture look better. Where a behaviour looks wrong it is written down, with the cell that shows
it, in **For the owner** at the bottom.

Evidence: `scratch/shots/<sha>/` (`npx electron scripts/shots.cjs --port <port>`), 70 cells ×
2 themes, plus numbers from a throwaway probe that walked every physics scene tick by tick.
Cells are named by their gallery caption, as the README asks.

## How to read the numbers

A pollen is **3.00" across** (`BB_POLLEN_R` 1.5, vs DECODE's artifact at `C.BALL_RADIUS` 2.5).
So "2.1" of overlap" means two pollen sitting inside one another by two thirds of a diameter —
their centres are 0.9" apart. "Out by 0.00"" means the pollen's skin never crossed a wall plane
on any tick of the run, which is the one hard invariant these scenes assert.

| scene | pollen | worst out | worst overlap (tick) | fastest pollen (robot then) |
|---|---|---|---|---|
| `pile-slow` | 12 | 0.000" | 0.359" (0) | 25.5 in/s (17.6) |
| `pile-med` | 12 | 0.000" | 0.359" (0) | 56.0 in/s (44.0) |
| `pile-fast` | 12 | 0.000" | **2.527" (103)** | **90.0 in/s (70.4)** |
| `wall-row-sweep` | 14 | 0.000" | **2.144" (210)** | **90.0 in/s (73.3)** |
| `corner-pile` | 16 | 0.000" | 1.230" (84) | 54.7 in/s (35.2) |
| `pin-wall` | 1 | 0.000" | — | 3.9 in/s (53.2) |
| `squeeze-2robots` | 1 | 0.000" | — | 26.1 in/s (30.8) |
| `settle-60` | 60 | 0.000" | 0.000" | 0.0 in/s |
| `intake-line` | 10 | 0.000" | 0.000" | 40.5 in/s (39.6) |
| `launch-wall-bounce` | 9 | 0.000" | 0.249" (19) | 5.5 in/s (idle) |

The 0.359" in the two slow pile scenes is the SCENE's own starting lattice, at tick 0, before
anything has moved — `bbPile` lays its rows a third of an inch tight and the solve relaxes it.

## Scene by scene

**`pile-slow` (12 pollen, 20 in/s).** The best-looking cell in the set. At `@30` the lattice is
untouched and the robot is still closing. By `@120` the block has become a rounded heap sitting
on the front bumper — hexagonally packed, twelve clearly separate circles, symmetric about the
chassis centreline, wider than it is deep. Two or three of the bottom row press about a fifth of
a radius into the bumper strip and none of them is inside the blue chassis outline. Left alone
for four more seconds the heap relaxes to **zero overlap and zero speed**. This is what the
shared solve does when it is not being asked to do the impossible, and it looks like foam balls.

**`pile-med` (12 pollen, 50 in/s).** Same heap, flatter and wider, and now the front row is
genuinely **inside the chassis** — several pollen are drawn over the front rail, inside the blue
box by roughly half a radius, at `pile-med@120`. The robot is carrying them rather than pushing
them. It also still relaxes completely once the robot stops (overlap 0.000", at rest), so the
burial is a dynamic artefact of being driven into, not a state the pile gets stuck in.

**`pile-fast` (12 pollen, 80 in/s).** This is where it breaks down. At `@30` the bottom row is
already inside the front rail. By `@120` the robot has plowed the whole pile the length of the
field into the far wall and is holding it there; two pollen escaped sideways and are sitting out
near the wall on their own. Worst overlap during the run is **2.53"** of a 3.00" diameter, and
**four seconds after the robot goes idle it is still 2.15", jiggling at 2.6 in/s** — the pile
does not come apart. A pollen also reaches exactly **90.0 in/s while the robot is doing 70.4**,
i.e. it is clipped by `C.BALL_MAX_SPEED` and by nothing else.

**`wall-row-sweep` (14 pollen).** Fourteen pollen resting along the right wall, robot sweeping
down the line. At `@60` the row is a dead-straight column with every pollen's skin on the wall
plane and the robot arriving at the top of it, yawed about 10° by the contact, its bottom-right
corner on the first pollen. At `@300` the robot has finished in the corner with **five pollen
sitting inside its own footprint**, pressed against the wall, while six others are strung out
along the bottom wall where they squirted clear. Worst overlap **2.14"**, still **2.13" three
seconds after the robot stops**. Another **90.0 in/s pollen against a 73.3 in/s robot**. No
pollen ever leaves the field — but see owner note 1 for what is holding it in.

**`corner-pile` (16 pollen).** The mildest of the pressing scenes. The robot goes in at 45° and
packs sixteen pollen into the corner in a rough hex pack that reads correctly — distinct circles,
no line artefacts, the outer ones resting on both walls. One pollen squirts around the chassis's
rear-left corner and stays there, half inside the footprint, from `@120` through `@240`. Worst
overlap 1.23" while pressing, relaxing to 0.88" three seconds after the robot stops: better than
the wall row, still not resolved.

**`pin-wall` (1 pollen).** One pollen, one wall, full throttle, five seconds. The scene's own
comment says this cell is where a human decides which lie BIOBUZZ tells, so: **it tells CR's.**
By tick 45 the robot has driven in until the pollen is roughly **half inside the front bumper**,
its centre near the wall plane, and that state is pixel-for-pixel identical at tick 300. The
robot does not stall on it, the pollen is not ejected, nothing creeps, nothing jitters, and the
pollen's own speed never exceeds 3.9 in/s. It is a stable, quiet, physically wrong equilibrium.

**`squeeze-2robots` (1 pollen).** The good news cell. Two robots converge on one pollen and it
**squirts out of the squeeze** — at `@90` it is clear of both chassis, sitting just off the gap,
and both robots have been yawed a few degrees by the contact. By `@180` the robots have backed
away and the pollen is at rest in open floor. No crush, no deletion, no 100 in/s escape (26.1
in/s peak). This is the geometry doing the right thing with no rule written for it.

**`settle-60` (60 pollen, no robot).** Sixty pollen scattered across the field and left alone.
`@0` and `@300` are the same picture: no drift, no crystallisation, no creep toward the walls,
no pair overlapping, every pollen dead still. Five seconds of 60-body solve costs nothing
visible. This is the cell that proves the shared rolling-friction pass (`stepGroundBall`) is
actually running — the solve has no gravity and no floor, so without it nothing would ever stop.

**`intake-line` (10 pollen).** A running sweeper driven up a line of ten. At `@45` three are in
the hopper and the remaining seven are still a perfectly straight, evenly spaced line — capture
lifts them one at a time without disturbing the queue, which is what you want. At `@240` the
hopper is full at 9/9 and the tenth pollen is jammed between the front bumper and the wall,
uncollectable, exactly the `pin-wall` equilibrium reached by accident. Count conserved at 10.

**`launch-wall-bounce` (9 pollen, dumper).** A full hopper flung at a wall from 20". The nine
pollen leave together, bounce, and come to rest as a **dead-straight, evenly spaced, touching
row** behind the robot — and it is the same row at `@45`, `@90` and `@240`. It never spreads.
That is not obviously a solver bug: all nine leave on parallel paths at the same speed, and with
ball-ball friction at zero and no randomness in the ground solve there is nothing to break the
symmetry, so a row in is a row out. But it is the same PICTURE as the DECODE drain complaint
("they don't leave the line they form coming out of the gate"), so it is on the owner list.

## For the owner

Each item names the cell or the number that shows it. None of these were touched.

1. **BIOBUZZ has no pin and no round loop, and `clampPollenToWalls` is the only thing hiding
   it.** DECODE's `pinnedArtifacts` → `PinnedCircle` → re-run-`solveRobots` sequence lives in
   `src/sim/world.ts`, which is DECODE-only, so nothing ever tells the BIOBUZZ robot solve that
   a wall pollen is a wall. The consequence is `pin-wall@300` and `wall-row-sweep@300`: the
   chassis simply occupies the space the pollen is in. Measured with the containment clamp
   REMOVED, a pollen went **2.02" past the wall plane** (`wall-row-sweep`, tick 105) and 1.52"
   (`pile-fast`). With the clamp the table above reads 0.000" everywhere, so the invariant holds
   — but it holds by putting the pollen back, not by the robot being stopped. The two real
   options are both yours: expose the pin/round machinery to a game module, or accept that a
   BIOBUZZ chassis drives through pollen it is pressing on a wall.
2. **Persistent overlap under a pressing chassis, which does not relax.** `pile-fast` 2.53"
   during and **2.15" four seconds after the robot stops**; `wall-row-sweep` 2.14" → 2.13";
   `corner-pile` 1.23" → 0.88". A pollen resting two thirds of a diameter inside another is a
   pile that reads as fewer balls than it has, and it is still jiggling at 1.4–2.6 in/s. The
   scenes where nothing presses (`pile-slow`, `pile-med`, `settle-60`) all reach exactly 0.000",
   so this is specifically the squeeze the solve has no answer for. Smoke asserts the settled
   cases and deliberately does NOT assert this one away.
3. **A struck pollen outruns the robot that struck it, and the only cap it gets is DECODE's.**
   `pile-fast` tick 87: pollen at **90.00 in/s, robot at 70.36**. `wall-row-sweep` tick 96:
   **90.00 in/s against 73.26**. 90.00 is `C.BALL_MAX_SPEED` exactly, so the pollen is not
   finding its own limit, it is hitting a ceiling tuned for a 5" artifact. The clump speed cap
   that fixed precisely this for DECODE ("if I drive in full speed, third ball bumps with the
   second ball and doesn't get intaked") is in `world.ts` and unreachable from a game module.
   A pollen a robot can never catch is the same bug at 1.5".
4. **`clampPollenToWalls` reverses velocity where DECODE removes only the into-wall
   component.** BIOBUZZ's clamp bounces (`BB_POLLEN_WALL_REST` 0.35, which is otherwise a
   FLIGHT constant); DECODE's `fieldPushback` clips the component into the wall and keeps the
   squirt. Left exactly as it was, flagged because the two games now disagree about the same
   contact and one of them is wrong.
5. **`INTAKE_STRUCT_FRICTION` (0.05) is zero in effect**, in both games. `physicsEngine.ts:707`
   and `:708` give the intake structure and the held balls that friction, but the ball collider
   combines with `Average` while these use `Min`, and `Min` wins — so an intake wedge and a held
   pollen are frictionless to a ground pollen. Not BIOBUZZ-specific; already noted in HANDOFF
   for the alpha session and repeated here because BIOBUZZ inherits it.
6. **The shared rolling constants are 5"-artifact numbers.** `C.BALL_ROLL_FRICTION` 32 and
   `C.BALL_REST_SPEED` 2 are what a pollen now rolls on, where the deleted BIOBUZZ arm used 42
   and 1.5. Deliberately not shadowed — BIOBUZZ owns no physics constants — but a 3" ball
   rolling on a 5" ball's friction is an owner call, and `settle-60` is where a change would
   show first.
7. **Step cost moved, and the smoke budget moved with it.** A 2v2 BIOBUZZ step went from under
   1.2× a 2v2 CR step to a measured **1.25–1.63× (median ≈ 1.34, best-of-three)**, because the
   solve now builds a real Rapier world every tick where the bespoke arm did arithmetic. In
   absolute terms that is ≈0.47 ms for a 2v2, under 3% of a frame. `STEP_BUDGET` is 1.8 with the
   measurement written on it; the ROOM budget stayed 1.2 and measures 0.75–0.99×, because a room
   tick also pays for a snapshot and CR's 300 particles make that side much fatter.
8. **The gallery runner was photographing the wrong cells, and the pictures looked fine.**
   Not physics, but it is the tool this file is made of, so it belongs here. `scripts/shots.cjs`
   slept a flat 120 ms after `scrollIntoView` before `capturePage`. That held for a 12-cell run
   and failed silently on the full 70: the files named `wall-row-sweep@60`, `@150` and `@300`
   came out **byte-identical to the `pile-fast@30`, `@60` and `@120` cells** — four cells of
   compositor lag — while `pile-slow`, four cells earlier, was correct. Every PNG was a plausible
   BIOBUZZ scene, so nothing looked broken. Fixed in this commit by waiting for two
   `requestAnimationFrame`s and discarding the first capture; re-run, all 70 light cells are now
   distinct and the full run matches a filtered run byte for byte. **Any feedback dump written
   against a contact sheet from before this fix may be describing the wrong cell.**
9. **Naming:** the plan and the brief both call the radius `BB_POLLEN_RADIUS`. The constant in
   the repo is **`BB_POLLEN_R`** (`src/games/biobuzz/config.ts`), and that is what the code and
   this file use.

### Added 2026-09-11 by the external-review pass (`biobuzz`)

Six more, from a code review of the Phase 0.5 merge. Each was VERIFIED against the code before
being written down — two of the reviewer's readings needed correcting and the correction is part
of the item. None of them was touched: every one is shared physics, and three of them are things
the shared pipeline does for DECODE and does not do for BIOBUZZ.

10. **The ground-pollen wall clamp contradicts its own constant's comment.** `BB_POLLEN_WALL_REST`
    (0.35) is documented at its definition as *"FLIGHT ONLY — a ground pollen's wall bounce is the
    shared solve's `BALL_WALL_RESTITUTION`"* (`src/games/biobuzz/config.ts`), and
    `clampPollenToWalls` applies it to GROUND pollen as well — it is called on every ground pollen
    after the solve (`play.ts`, stage 4) and reverses the into-wall component scaled by it. So a
    ground pollen's wall bounce is BIOBUZZ's number after all, and the file that says otherwise is
    two doors away. This is item 4 seen from the other end: 4 says the clamp REVERSES where DECODE
    CLIPS, this says the coefficient it reverses with is one this game is not supposed to own.
    Both are the same fix and the fix is yours, because moving ground containment into the shared
    pipeline is a shared-solver change. Left exactly as it was.

11. **A robot's canonical heading is not the orientation Rapier solved.** `solveRobots` writes
    `r.pos` from `body.translation()` — the contact-CORRECTED pose — and then writes
    `r.heading = wrapAngle(r.heading + r.angVel * dt)`, integrating from the solved angular
    velocity instead of reading `body.rotation()` (`src/sim/physicsEngine.ts`). Verified, and the
    reviewer's framing needs one correction: **it is deliberate and the reason is written down** —
    `body.rotation()` carries Rapier's positional penetration correction, which quietly turned an
    idle robot 7.2° with `angvel` reading 0.0000. So this is a tradeoff, not an oversight. What it
    costs is that position and heading come from two different authorities for one body: any yaw
    that exists only as a positional correction (a deep overlap being pushed apart at an angle,
    a corner contact resolved by rotation rather than by impulse) moves the robot and does not
    turn it. BIOBUZZ sees it wherever a chassis ends a tick overlapped, which after item 1 is
    "any chassis pressing pollen on a wall".

12. **The solves iterate ARRAY ORDER, not stable ids.** `solveArtifacts` creates ball bodies by
    walking `world.balls` (filtered to ground) and robot bodies by walking `world.robots`
    (`physicsEngine.ts`), and the file itself notes that "Rapier resolution depends on"
    collider creation order. `world.ts` and `play.ts` both hand it the arrays as they stand. It is
    DETERMINISTIC — the array order is world state, it rides the snapshot, and the wire sends the
    ball id order every frame for exactly this reason — so this is not a divergence report. It is
    that the physical answer depends on a list order nothing owns: a pollen removed from the
    middle (a capture) renumbers every later body's creation index, so the tick a robot intakes
    one pollen from a pile is a tick where the rest of the pile is solved in a different order
    than it would otherwise have been. Sorting by id at body-creation time would cost one sort per
    tick and make the solve's answer a function of the STATE rather than of the container.

13. **The pin/support search is O(B³)-shaped — and BIOBUZZ never reaches it.** `supported()`
    (`physicsEngine.ts`) is a BFS over touching artifacts that uses `queue.shift()` (O(n) on a JS
    array) and rescans every ground ball for neighbours at each dequeue, so one call is O(B²) with
    no spatial index and no memo; `pinnedArtifacts` calls it per artifact per robot, giving
    O(B³·R) in the worst case where the whole field is one touching clump. But the reviewer's
    premise — "with 60 pollen" — does not hold: `pinnedArtifacts` is called only from
    `src/sim/world.ts`, i.e. **DECODE only**, and BIOBUZZ runs no pin or round loop at all (item
    1). So `BB_POLLEN_SIM = 60` pays none of this today. It matters the day you take item 1's
    first option and expose the round loop to a game module: 60 pollen in one wall-length clump is
    where that cost lands, and it lands 60× harder than DECODE's smaller artifact set. Worth
    fixing BEFORE the round loop moves, not after.

14. **BIOBUZZ pollen barely bounce off each other, because the impact bounce is a DECODE-only
    pre-pass.** New, measured this session. `bounceFirstContacts` — the pass that exists precisely
    because "Rapier applies NO restitution on a speculative contact" — is called only from
    `src/sim/world.ts`, so BIOBUZZ gets the degraded speculative bounce and nothing else.
    Measured through the real BIOBUZZ pipeline, one pollen into a resting one, effective
    restitution: **0.211 at a 44.9 in/s approach, 0.015 at 66.7, 0.176 at 87.2** — against a
    configured `C.BALL_BALL_RESTITUTION` of **0.68**, and against DECODE's own measured 0.67 with
    the pre-pass. That is the TRAIN the DECODE rework named ("a ball rear-ending the one ahead
    merged with it instead of shoving it on"), alive in BIOBUZZ. It is the likeliest single
    explanation for `launch-wall-bounce`'s nine pollen staying in a dead-straight touching row,
    which this file previously put down to symmetry. `scatterBalls` (the coincident-pair kick) is
    DECODE-only for the same reason. Both are in `world.ts`, so both are yours.
    Now pinned by smoke as an ENVELOPE (`0 <= e <= C.BALL_BALL_RESTITUTION`), not as a value, so
    closing this gap will not turn the suite red.

15. **The clamp is hiding more than item 1 said, and the number is now measured per tick.** Item 1
    quotes 2.02" from removing `clampPollenToWalls` for a whole run. Measured this session with
    the pollen put BACK after each measurement — so the number is the solve's own per-tick escape
    rather than a compounding drift — a chassis sweeping a 14-pollen row along a wall puts a
    pollen **0.999" past the wall plane at 40 in/s and 1.744" at 80 in/s**, on a 1.5" element. Run
    with no clamp at all for 300 ticks the same scene reaches **7.1" and 9.6"**. Also new: a pollen
    and an artifact are the SAME MASS — the shared `C.BALL_MASS` (0.2 lb), verified through the
    solve by the two speeds after a head-on impact summing to the approach speed within 1% — so a
    3" pollen weighs what a 5" artifact does, which belongs beside item 6's rolling constants.
    `scripts/smoke-biobuzz/field.ts` now measures the solve's escape directly, before and without
    the clamp, with a 2.5" ceiling; every other containment check in that file reads the world
    after the clamp and therefore could never have seen any of this.


## Response

### 2026-09-12 — Lane A, field geometry (`73372ad`)

- **`BB_POLLEN_R` moved 1.5 → 1.4** with the V1 manual (2.8-in POLLEN, §9.8). Every measurement
  above this marker was taken at 1.5, so the overlap and escape numbers are now slightly stale
  in the direction of "less bad" — the ratios to `C.BALL_RADIUS` (2.5) all shift, and the
  2.1-in persistent overlap under a pressing chassis was measured on a 3-in element.
  Re-measure before quoting any of them; nothing about the SOLVE changed.
- **NECTAR is a second element size (1.8) and the shared solve has no per-artifact radius.**
  Until `field-plan.md` §6 request 1 lands, a nectar will be simulated at pollen size — a 3.6-in
  ball solved as a 2.8-in one, visibly wrong in a pile. `drawField` already draws the field at
  the real sizes, so the first cell that stages nectar will show the mismatch directly.
- Nothing in `field-labelled@0` looks physically wrong: it is a static drawing with no elements
  and no robots. The first real physics question here will be what a spilled cell's contents do
  when they land, and that needs the hive lifecycle first.
