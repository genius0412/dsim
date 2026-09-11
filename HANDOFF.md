# HANDOFF — 2026-09-11 (external review of the Phase 0.5 merge: findings fixed)

Branch **`biobuzz`** (worktree `dsim-biobuzz`), 5 commits on top of `6c31142`. **NOT pushed,
not deployed, no PR.** `SIM_VERSION` and `BALANCE_VERSION` untouched. No physics constant was
added, moved or changed, shared or BIOBUZZ.

## READ FIRST — state

| gate | result |
|---|---|
| `npm test` | exit 0 · **1733 `PASS` lines, 0 `FAIL`** — suite 1 `ALL PASS` (**1328 checks, the same list as before**), suite 2 `405 CHECKS, ALL PASS` (was 366) |
| `npm run build` | `✓ built in 4.12s` (chunk-size warning only) |
| `npm run server:check` | green, exit 0 |
| `npx tsc --noEmit` | clean |

**DECODE is byte-identical, and the argument is mechanical.** The only SHARED files this pass
touched are `src/games/types.ts` — two `import type` lines and one OPTIONAL interface member,
all three erased at runtime — and `src/sim/spawn.ts`, which is a comment-only change.
`src/sim/artifactSolids.ts`, `src/sim/world.ts`, `src/sim/physicsEngine.ts` and `src/config.ts`
are not touched at all. Suite 1's check count is unchanged at 1328 and the whole 405 of suite 2
is BIOBUZZ's own file set.

## The eight review findings, and what each one actually was

1. **Pollen solved at DECODE's radius — NOT A BUG.** `play.ts` already passed `BB_POLLEN_R` to
   both `robotSolids` and `solveArtifacts`; the reviewer read the DEFAULT parameter
   (`C.BALL_RADIUS`) in the signature and not the call. Every call site was grepped. The
   regression test asked for was added anyway, because nothing pinned it: a solved contact rests
   at 2.990" and a pushed pollen sits 1.354" off the face, both the 3" element the renderer draws.
2. **`robotSolids` builds DECODE's funnel — CONFIRMED, fixed** (`14b61a6`). New optional
   `GameSimModule.artifactSolids` slot; BIOBUZZ fills it with `bbRobotSolids`, derived FROM
   `bbMouths` so the drawn mouth and the solid mouth cannot drift. DECODE and CR leave it empty.
3. **Custom start poses validated on the CENTRE only — CONFIRMED, fixed** (`a807e68`).
   `bbFitPose` fits the ROTATED FOOTPRINT inside the perimeter AFTER the alliance mirror, and
   slides rather than rejects. Custom poses stay ENABLED. Anchors go through it too (a no-op).
4. **The tick-start sweep fell back to the END pose — CONFIRMED, fixed** (`14b61a6`). The
   parameter is required; `NO_SWEEP` is gone. Cost of the old fallback, now measured: 0.588"
   of penetration swept against **7.872"** unswept.
5. **BIOBUZZ coercion runs after the CR pass — CONFIRMED as a fact, NOT fixed, documented**
   (`bdbe4e8`). Reordering would re-add the CR fields the arm exists to strip. The real hazard
   is different and is now written at both ends: the arm receives `out`, not raw `sp`, so the
   first `bb*` field will need carrying across at the call site.
6. **Containment observed after the local clamp — CONFIRMED, fixed** (`a6ee66d`). Escape is now
   measured BETWEEN the solve and the clamp, pollen restored each tick, with a 2.5" budget.
7. **Coverage gaps — CONFIRMED, fixed** (`a6ee66d`). Per-mount solids, the seam itself, radius
   propagation end to end, pollen mass and restitution as an ENVELOPE, the real sweep path.
8. **Perf compared independent minima — CONFIRMED, fixed** (`a6ee66d`). Paired per-round ratios
   with a median, list printed.

The four owner items (wall clamp vs the FLIGHT-ONLY comment, heading not read back from Rapier,
array-order iteration, O(B³) pin search) went to `docs/biobuzz/feedback/000-solver-observations.md`
as items 10–13 with two of the four readings CORRECTED, plus two new ones found while verifying:
14 (pollen barely bounce — `bounceFirstContacts` is DECODE-only, effective e 0.015–0.211 against
a configured 0.68) and 15 (the clamp hides 0.999"/1.744" per tick; a pollen and an artifact are
the same mass).

## What a kickoff session should know

- `bbRobotSolids` is the shape a POLLEN meets, and it is deliberately thin: chassis box, two side
  plates per mounted edge, mouth OPEN. When the manual lands and the real intake is known, that
  function is the one place to change — the renderer and the solver both read `bbMouths`.
- The suite now pins BIOBUZZ physics as ENVELOPES (`0 <= e <= C.BALL_BALL_RESTITUTION`, escape
  `<= 2.5"`), not as values, precisely so the owner can close observations 14 and 15 without
  turning this suite red.
- `npm run test:bb` is still the inner loop (2 s). Nothing here goes in `scripts/smoke.ts`.

# HANDOFF — 2026-09-11 (integration: `biobuzz-sandbox` + `origin/alpha` merged in)

Branch **`biobuzz`** (worktree `dsim-biobuzz`) = previous `biobuzz` + `biobuzz-sandbox` +
`origin/alpha` @ `914bc1b`. **PUSHED to origin** (the branch is public by decision 1; the
SEASON stays private behind `channels: ['alpha']`). **Nothing deployed** — the deflate change
that came in with alpha is a SERVER change and is inert until the owner runs
`./scripts/fly-deploy.sh`. `SIM_VERSION` and `BALANCE_VERSION` untouched by the merge itself;
alpha's own commits moved three friction constants (below).

## State at 2026-09-11 (integration; was READ FIRST)

Everything is green, on the merged tree, in this worktree.

| gate | result |
|---|---|
| `npm test` | exit 0 · **1694 `PASS` lines, 0 `FAIL`** — suite 1 `ALL PASS`, suite 2 `366 CHECKS, ALL PASS` |
| `npm run build` | `✓ built in 3.83s` (chunk-size warning only) |
| `npm run server:check` | green, exit 0 |
| `npm run test:mm` | `✓ matchmaker: 58 checks passed` |

`biobuzz-field` and `biobuzz-robot` were fast-forwarded to this tip and pushed, so both lanes
start kickoff on the same code. `biobuzz-shell` and `biobuzz-core` were already fully merged
(behind `biobuzz` with a zero-file diff) and can be retired.

## What came in from `biobuzz-sandbox` (7 commits)

Phase 0.5: **BIOBUZZ owns no ground-ball integrator.** `solveArtifacts`/`robotSolids` took a
trailing artifact-radius parameter — DECODE passes nothing and is byte-identical — the
`BB_BALL_SOLVER` switch and `separatePollen` are gone, and POLLEN ride the owner's shared solve
at `BB_POLLEN_R`. The pollen checks were rewritten for the one solver rather than deleted
(349 → 366). `docs/biobuzz/feedback/000-solver-observations.md` is the owner-facing write-up;
its "For the owner" list has three items that change how BIOBUZZ plays and none of them is
fixable inside `src/games/biobuzz/`.

## What came in from `origin/alpha` (9 commits)

- **permessage-deflate is ON** (`e287c0e` + `41e346d`) at `windowBits` 15 / `memLevel` 8 with
  `serverNoContextTakeover: false`, which is the load-bearing line. Measured on the WIRE, not
  on the app payload: −88% solo, −86% 1v1, −83% 2v2. It is negotiated per connection in the
  HTTP upgrade, so it is NOT a protocol change and needs no `CLIENT_CAPS` gate — a client that
  does not offer it gets today's exact bytes. `WS_COMPRESS=0` is NOT on this branch; that kill
  switch lives on `perf-load-v2` and has not landed on alpha yet.
- **Three friction constants moved**, all the owner's: rolling friction 28 (`84162e1`), robot
  bumper 0.45 → 0.2 (`a97f03c`), then bumper-on-bumper 0.15 with bumper-on-wall left at 0.40
  (`914bc1b`). Both suites are green against them here.
- **`npm run costprobe`** (`scripts/costprobe.ts`) — prices a room off the real `step()` and
  the real `slimWorld`/`encodeBallDelta` codec. ⚠️ It measures the PAYLOAD, so it cannot see
  permessage-deflate. `scripts/zz-deflate-cost.ts` is the one that counts TCP `bytesRead` and
  is the authoritative probe for anything compression-related.
- **The practice replay save policy** (`src/replaySavePolicy.ts`, `605857d`). Game-agnostic —
  it lives in `GameController`, so BIOBUZZ practice runs are covered the moment the season is
  playable. A completed run is always kept; an ABANDONED one is kept if it carries at least
  `PRACTICE_SAVE_MIN_S` (15) of DRIVING, counted as ticks where `robotsEnabled` so the
  pre-match countdown cannot pad it. Leaving the game screen used to lose the run silently.

## Merge resolutions — two conflicts, both docs

1. **`docs/biobuzz-plan.md` Decisions.** The sandbox branch's warning that copy-and-own has an
   exception (ground pollen physics is not copied and not owned) is KEPT, attached to decision
   3. Its restatement of decision 4 is dropped: it ended "nothing is pushed or deployed until
   decision 1 resolves", and decision 1 was resolved by the owner on 2026-09-10. The kept
   decision 4 also says more — the owner owns PHYSICS, and gallery observations go to him as
   HANDOFF notes, never as BIOBUZZ-local constant tweaks.
2. **`HANDOFF.md`.** Two branches each prepending a dated section is not a disagreement. Both
   are kept, newest first.

## Next

1. **The owner deploys.** The measured egress saving is real and currently unrealised, and a
   season kickoff is exactly when concurrency spikes. `./scripts/fly-deploy.sh`, never a bare
   `flyctl deploy` — `fly.toml` carries one `[[vm]]` size and a bare deploy upsizes every
   satellite.
2. **Kickoff, 2026-09-12 12:00 ET.** Both lanes start here. `docs/biobuzz-contract.md` is the
   lane contract; `docs/biobuzz-reference.md` gets written on kickoff day from the manual.
3. ⚠️ **`BB_POLLEN_RADIUS` does not exist** — the constant is `BB_POLLEN_R`. The plan and the
   prompts use the longer name; the code uses the real one.
4. Still unowned and not on this branch: the `Room.onInput` unbounded future-tick buffer (a
   latent DoS). A fix exists on `perf-load-v2`, which is the perf chat's to land.

---

# HANDOFF — 2026-09-11 (BIOBUZZ Phase 0.5: pollen on the shared artifact solver)

Branch **`biobuzz-sandbox`** (worktree `dsim-bb-sandbox`), off `biobuzz`. **NOT pushed, nothing
deployed** — the repo is public and the 2026–27 season is private until further notice.
`SIM_VERSION` and `BALANCE_VERSION` untouched. No physics constant, shared or BIOBUZZ, was
changed by this session.

## READ FIRST — state

**Everything is green. BIOBUZZ has one ball solver and it is the owner's.**

| gate | result |
|---|---|
| `npm test` | exit 0 · **1674 `PASS` lines, 0 `FAIL`** — suite 1 (`scripts/smoke.ts`) `ALL PASS`, suite 2 (`scripts/smoke-biobuzz/index.ts`) `366 CHECKS, ALL PASS` (was 349) |
| DECODE alone | `1308 PASS / 0 FAIL`, `ALL PASS` — **identical check-name list to the pre-item-1 baseline** (see the byte-identity proof below) |
| `npm run test:mm` | `✓ matchmaker: 58 checks passed` |
| `npm run build` | `✓ built in 7.74s` · `dist/assets/index-k3qkyn3n.js 2,411.50 kB` (chunk-size warning only) |
| `npm run server:check` | green (no output) |
| `npm run uiaudit` | `ALL RULES AT OR UNDER BASELINE` (inline-spacing 29/29, off-grid-gap 165/165, the three hard rules 0/0) |
| `npm run contrast` | `ALL PASS — 221 contrast checks across light + dark` |
| `npx tsc --noEmit -p .` | `TypeScript: No errors found` |
| gallery contact sheet | 140 PNGs, 70 cells × 2 themes, `scratch/shots/2b622f7-dirty/` — **all 70 light cells distinct** (they were not before, see the runner gotcha) |

## What changed, and why it is small

The owner's artifact rework made `solveArtifacts` the **ONE POSITION AUTHORITY** for every
ground artifact. BIOBUZZ had grown a second one — a `BB_BALL_SOLVER` switch with a bespoke arm
(CR's ground integrator copied, plus `separatePollen`) beside a `'rapier'` arm. That is exactly
the defect the rework exists to end, so the bespoke arm is gone and POLLEN ride the shared
solve. BIOBUZZ's entire contribution to pollen physics is now a **number**.

| item | commit | |
|---|---|---|
| 1 | `fb71b1c` | `refactor(sim): solveArtifacts and robotSolids take the artifact radius` |
| 2 | `2591786` | `refactor(biobuzz): one solver — POLLEN ride the shared artifact solve` |
| 3 | `2b622f7` | `test(biobuzz): the pollen checks are rewritten for the one solver, not deleted` |
| 4 | `8e0b20f` | `docs(biobuzz): gallery observations for pollen on the shared solver` (+ the `shots.cjs` fix) |
| — | `5b5bbce` | `test(biobuzz): interleave the perf windows so the ratio measures code, not load` (found by the gate run) |
| 5 | *(this one)* | the docs pass + this handoff |

1. **The radius is ADDITIVE.** `solveArtifacts(...)` and `robotSolids(r, heldBalls)` gained a
   trailing `radius: number = C.BALL_RADIUS`, used where they read `C.BALL_RADIUS` to build the
   artifact collider and the held-ball circles. **Every DECODE call site passes nothing.**
   `pinnedArtifacts`/`supported` (physicsEngine.ts ~781/790/844) deliberately still read
   `C.BALL_RADIUS` outright, because BIOBUZZ does not call them — parameterizing an unreachable
   path would be a change with no reader.
2. **`play.ts` has no ball integrator.** `separatePollen` deleted, the copied ground integrator
   deleted, the `BB_BALL_SOLVER` switch and `BB_POLLEN_FRICTION` / `BB_POLLEN_REST_SPEED` /
   `BB_POLLEN_SEP_ITERS` deleted from `config.ts`. `interact()` lost its PLOW branch and only
   CAPTURES. What runs now, in order: the shared `stepGroundBall` rolling pass → capture →
   `solveArtifacts(world, dt, biobuzzColliders, NO_IDS, NO_IDS, solids, from, BB_POLLEN_R)` with
   `robotSolids(rob, heldBalls, BB_POLLEN_R)` → `clampPollenToWalls`. `step.ts`'s pre-solve
   ordering (start-of-tick pose for `from`) is unchanged.
3. **Two things the bespoke arm did that the shared solve does not**, both resolved without
   re-implementing anything:
   - **Bringing a pollen to rest.** The solve runs in a plane with no gravity and no floor, so
     nothing stops a rolling pollen. Measured, a plowed pile was still travelling at
     **18.98 in/s five seconds after the robot stopped**. Fixed by calling the ALREADY-SHARED,
     already-exported `stepGroundBall` (`src/sim/physics.ts`, velocity-only rolling friction +
     rest snap) — not by porting BIOBUZZ's deleted 42 / 1.5 constants. `settle [*]: the pile is
     actually AT REST` is the check that fails if this is ever dropped again.
   - **Keeping a pollen in the field.** `clampPollenToWalls` was going to be deleted as
     redundant; it is not. Measured with it removed, a pollen went **2.02" past the wall plane**
     (`wall-row-sweep`, tick 105) and 1.52" (`pile-fast`), because BIOBUZZ runs no pin/round
     loop (owner note 1). Kept unchanged, re-documented as THE CONTAINMENT INVARIANT with those
     numbers, and asserted on **every tick** of seven scenes.
   Nothing else was missing: wall restitution for a GROUND pollen and a speed cap both exist on
   the shared side (`BB_POLLEN_WALL_REST` is FLIGHT-only; the cap is `C.BALL_MAX_SPEED`, which
   is an owner question rather than a gap — see note 3).
4. **Smoke was rewritten, not deleted.** The checks that read the dead switch now read the one
   solver: count conserved over 600 ticks of a sweeping robot; every pollen inside `bounds` on
   EVERY tick of `pile-slow/med/fast`, `wall-row-sweep`, `corner-pile`, `squeeze-2robots`,
   `settle-60` (through `bbSceneStills`, the one stepping path, so these check the run the
   gallery draws); no two RESTING pollen overlapping past 0.1"; the pile actually at rest; a
   full-throttle robot never posting the `pin-wall` pollen through the wall on any of 300 ticks;
   every scene hashing deterministically. 349 → 366 checks.

## The DECODE byte-identity proof

Item 1's claim is that DECODE is unchanged. The suite is **not bit-reproducible run to run**,
so "identical output" had to be defined before it could be proved: `server/room.ts:836` seeds a
Room with `(Date.now() ^ (Math.random() * 0xffffffff)) >>> 0`, so the five `Room`-driven replay
checks print different hashes and scores on every run **with no code change at all** — two runs
of the same code differ on four of those lines.

So the proof is: **the check-NAME lists are identical** (detail suffix after ` — ` stripped),
1308 `PASS` / 0 `FAIL` on both sides, and every line-level difference is one of those five
Room-seeded lines. Artifacts are in the session scratchpad (`smoke-before.txt`,
`smoke-after1.txt`, `smoke-after1b.txt`, `smoke-final.txt`); re-derive with
`grep '^PASS' f | sed 's/ — .*$//'` and `diff`.

## ⚠️ THE GALLERY RUNNER WAS PHOTOGRAPHING THE WRONG CELLS

`scripts/shots.cjs` slept a flat 120 ms after `scrollIntoView` before `capturePage`. That held
for a 12-cell filtered run and **failed silently on the full 70**: the files named
`wall-row-sweep@60`, `@150` and `@300` came out **byte-identical to the `pile-fast@30`, `@60`
and `@120` CELLS** — four cells of compositor lag on a hidden BrowserWindow — while
`pile-slow`, four cells earlier, was correct. Every PNG was a plausible BIOBUZZ scene, so
nothing looked broken; it was caught only because two files that should have differed had the
same md5 and the captions inside them named a third scene.

Fixed in `8e0b20f`: wait for two `requestAnimationFrame`s, then capture twice and discard the
first (`capturePage` itself pumps a frame). Verified by re-running: zero duplicates across all
70 light cells, and the full run now matches a filtered run byte for byte.

**Any feedback dump written against a contact sheet from before `8e0b20f` may be describing the
wrong cell.** Re-shoot before trusting one.

## ⚠️ THE PREVIEW PORT GOTCHA, HIT AGAIN

`npx vite preview` moved itself to **4174** because a sibling worktree's preview held 4173, and
`shots.cjs` defaults to 4173 — so the default invocation would have photographed *another
branch's build*. Confirmed rather than assumed: `netstat -ano | findstr 4173` showed PID 18408
listening, and the two ports served different bundles (`curl -s localhost:4173/ | grep index-`
gave `index-DTDXycuZ.js`, 4174 gave `index-CHgC59C_.js`, which is what `dist/` actually held).
Always read the port `vite preview` prints and pass `--port` explicitly.

## Next steps

1. **The owner reads `docs/biobuzz/feedback/000-solver-observations.md`** — specifically the
   "For the owner" list. The three that change how BIOBUZZ plays are: no pin/round loop
   (a chassis drives through pollen it presses on a wall), a persistent ~2.1" overlap under a
   pressing chassis that does not relax when the robot stops, and a struck pollen reaching
   `C.BALL_MAX_SPEED` (90) while the robot that hit it is slower. All three are shared-physics
   decisions; none is fixable inside `src/games/biobuzz/`.
2. **Nothing in this sprint is a rules decision.** Kickoff is 2026-09-12; `docs/biobuzz-plan.md`
   Phase 0.5 is now marked done and points at the observations file.
3. **`BB_POLLEN_RADIUS` does not exist** — the constant is `BB_POLLEN_R`. The plan and prompts
   use the longer name; the code and docs use the real one.
4. ✅ **RESOLVED by the integration merge at the top of this file** (2026-09-11): the commit
   was merged, Decisions item 1 and this header are reconciled, and `biobuzz` is pushed. The
   original note, kept because its reasoning still explains the resolution:
   ⚠️ **THIS BRANCH WAS ONE COMMIT BEHIND `biobuzz`, AND THE MISSING COMMIT CONTRADICTED THE
   HEADER ABOVE.** `biobuzz` has `63fffd9` "docs(biobuzz): the branch is public and physics
   belongs to the owner" (2026-09-10, owner-revised), which says `biobuzz` and the lane branches
   DO push to `origin` with the season hidden behind `channels: ['alpha']` — where
   `docs/biobuzz-plan.md` Decisions item 1 on this branch still says LOCAL ONLY, and the header
   of this section says "NOT pushed". Both are true of THIS session (the brief said push
   nothing, and nothing was pushed), and neither is the current policy.
   It was left unmerged deliberately: syncing branches was not in this session's brief, and
   `63fffd9` edits `docs/biobuzz-plan.md`, which item 5 also rewrote, so the merge needs a human
   to resolve the Decisions/Phase-0.5 overlap rather than a guess. Merge it before the next
   session and reconcile Decisions item 1 and this header. Its OTHER half — "BIOBUZZ does not
   own a ball integrator, POLLEN rides the shared `solveArtifacts`" — is exactly what this
   session implemented, so the two branches agree on the substance.

---

# HANDOFF — 2026-09-10 (BIOBUZZ: core + shell merged into biobuzz)

Branch **`biobuzz`** (worktree `dsim-biobuzz`), = `origin/alpha` + `biobuzz-core` + `biobuzz-shell`,
now integrated. **NOT pushed, nothing deployed** — the repo is public and the 2026–27 season is
private until further notice. `SIM_VERSION` and `BALANCE_VERSION` untouched.

## State at 2026-09-10 (was READ FIRST)

**Everything is green, and `npm test` now means both suites.**

| gate | result |
|---|---|
| `npm test` | exit 0 · **1657 `PASS` lines, 0 `FAIL`** — suite 1 (`scripts/smoke.ts`) `ALL PASS`, suite 2 (`scripts/smoke-biobuzz/index.ts`) `349 CHECKS, ALL PASS` |
| `npm run test:mm` | `✓ matchmaker: 58 checks passed` |
| `npm run build` | green (2,413.22 kB bundle, chunk-size warning only) |
| `npm run server:check` | green (no output) |
| `npm run uiaudit` | `ALL RULES AT OR UNDER BASELINE` (inline-spacing 29/29, off-grid-gap 165/165, the three hard rules 0/0) |
| `npm run contrast` | `ALL PASS — 221 contrast checks across light + dark` |
| `npx tsc --noEmit -p .` | clean |
| gallery contact sheet | 140 PNGs, 70 cells × 2 themes, `scratch/shots/9a51bb7/` |

The one error the merge left (`play.ts` importing the deleted `solveBalls`) is gone, and
`docs/biobuzz/baseline-alpha.md` is rewritten: there is no accepted-failure list any more, so
**any `FAIL` line is a regression**.

## What the seven items did

| item | commit | |
|---|---|---|
| 1 | `76cff4a` | `fix(biobuzz): the rapier pollen arm calls solveArtifacts, swept from the tick's start pose` |
| 2 | `894be27` | `feat(biobuzz): the real game module replaces P0-core's placeholder` |
| 3 | `9729702` | `refactor(core): the shell's three requests — optional catalystRail, a real biobuzz coerceSpec arm` |
| 4 | `fe71d8e` | `fix(server): the start-pose de-conflict loop reads the room's game's anchor count` |
| 5 | `9a51bb7` | `docs: the npm test gate is GREEN, and it now runs both suites` |
| 6 | — | gates + the visual check. **No commit: nothing was visibly wrong.** Evidence is this section. |
| 7 | *(this one)* | the handoff |

1. **`BB_BALL_SOLVER`'s `'rapier'` arm calls `solveArtifacts`.** `claimed` and `doorway` are
   both EMPTY sets, and that is a fact about this game rather than a stub: BIOBUZZ's `interact()`
   either captures a pollen outright (straight to `held`) or plows it, so there is no
   mid-capture ground pollen for a claim to name and no gate to expel one. `solids` is
   `robotSolids(rob, heldBalls)` per robot, and `from` is each robot's pose at the START of the
   tick, captured in `step.ts` as stage 0 of the pipeline exactly the way `world.ts` records
   `sweepFrom` — a kinematic robot swept from where it actually was, not from where the drive
   left it. Both arms still conserve pollen count and keep every pollen in `bounds` (asserted).
2. **The real `GameSimModule` / `GameModule`.** `sim.ts` is `scored: false`,
   `startLegality: false`, `initialAct: 2`, `startPoseCount: BB_START_POSE_COUNT` (2),
   `createWorld: createBiobuzzWorld`, `step: biobuzzStep`, `hud: biobuzzHud`; `index.ts` fills
   the three renderers, `Builder`, `Preview`, `hudChips`, `scoreBar`, `resultsRows`,
   `labels.configSummary` and `devRoutes`. `state.ts` is the shell's, unchanged, and
   `World.biobuzz?: BiobuzzState` imports from it.
3. The shell's three requests — (a) `RobotState.catalystRail` is optional, (b) `coerceSpec` has a
   real `game === 'biobuzz'` arm, (c) the `GameController` seam is NOT built; see the written
   request below.
4. **`server/room.ts` reads the room's own anchor count.** Both de-conflict loops (the lobby
   assign at ~line 799 and the match-start pass at ~line 1102) take
   `simModuleFor(this.game).startPoseCount` instead of `START_POSES.length`; the
   `START_POSES` import is gone. The BIOBUZZ smoke suite asserts a 4-robot alliance is only ever
   handed anchors `0..startPoseCount-1` — observed `startPoseCount=2 assigned=[0, 1, 0, 0]`.
5. `docs/biobuzz/baseline-alpha.md` rewritten around a GREEN gate; `HANDOFF.md`'s and
   `CLAUDE.md`'s `&&`-chaining paragraphs corrected (the chaining is still deliberate, and
   `test:bb` stays as the fast loop).

## ⚠️ THE SOLVER-COMPARISON CAVEAT — `solveArtifacts` hard-codes `C.BALL_RADIUS`

`solveArtifacts` builds its artifact collider, its speed cap and `robotSolids`' held-artifact
circles at **`C.BALL_RADIUS` (2.5", DECODE's artifact)**. **BIOBUZZ POLLEN is 1.5"**
(`BB_POLLEN_R`). So the `'rapier'` arm of `BB_BALL_SOLVER` separates pollen at the wrong
diameter: count is conserved and nothing leaves `bounds` (both asserted), but a pile settles
looser than it is drawn, and a held-pollen circle is a DECODE artifact.

This was left alone deliberately — fixing it costs a change to `src/sim/physicsEngine.ts` +
`src/sim/artifactSolids.ts`, i.e. shared core that no BIOBUZZ lane owns, and the default arm
(`'bespoke'`, which uses `BB_POLLEN_R`) is unaffected. It is the **P0.5 solver-comparison
caveat**: whoever compares the two solvers has to parameterize the radius first, or the
comparison is measuring the radius rather than the solver. Documented in `play.ts`'s header and
in `docs/biobuzz/baseline-alpha.md`.

## The written request core still owes the shell — a world seam on `GameController`

The third of the shell's three requests, **deliberately NOT built** (item 3c). `GameController`
builds its own world from `moduleFor(gameId).createWorld` with no injection point, so the
gallery's drivable cell (`LiveScene` in `Gallery.tsx`) runs the shared `Renderer` + shared
`InputManager` over a scene world it steps itself, and prints the module's `hud()` slice as
text where the real HUD would be.

Why it was skipped rather than added: the constructor change is small, but it has **no caller**
in this branch and cannot get one cheaply. `LiveScene` is frozen after Phase 0, and making it
the real game screen means mounting the canvas, the audio, the rAF loop and the global input
handlers inside a dev-route cell — a real piece of work, and a seam with no consumer is worse
than a written request, because the next reader cannot tell whether it is load-bearing.

**The request, for whoever does it:** accept an optional prepared `World` (or a
`createWorld` override) on `GameController`'s options, take that path instead of
`moduleFor(...).createWorld` when present, and leave `session: null` behaviour otherwise
bit-identical — `game.ts`'s solo path is the one thing a replay depends on. Then port
`LiveScene` onto it and the gallery's scene cells become the real game screen on a scene world,
which is what the cell was always for.

## What the gallery shots showed (item 6)

`scratch/shots/9a51bb7/` — clean tree, so no `-dirty` suffix. Recipe: `VITE_APP_CHANNEL=alpha
npm run build`, `npx vite preview`, then
`env -u ELECTRON_RUN_AS_NODE npx electron scripts/shots.cjs --port <port>`. Cells READ as
images, and what was seen:

- **`field-empty@0`** (light) — four walls, the tile grid, the centre cross. `0 pollen · no robot`.
- **`spawn-default@0`** (light AND dark) — 60 pollen scattered, four robots in the four corners,
  `0/9 held`. No pollen inside a chassis. Both themes correct: the mat keeps its light outline
  in dark, the card chrome inverts, the caption stays legible.
- **`pile-fast@30`** (light) — 12 pollen bunched at the intake mouth of a driving robot, none
  behind the sweeper line, none inside the frame.
- **`corner-pile@120`** (light) — 16 pollen wedged in the bottom-right corner with the robot on
  them; the pile is 2D, not a line along the wall.
- **`archetype-drum-right@0`** (light) — three chassis sizes, drum column on the robot's RIGHT in
  the in-match canvas AND in all three builder previews. The mount and the sprite agree.
- **`archetype-turret-backleft@0`** (light AND dark) — turret ring at back-left in both
  renderers at all three sizes. Dark is correct too.
- **`settle-60@300`** (light) — 60 pollen at rest, spread across the field, nothing overlapping,
  nothing against a wall in a line.
- **`pile-slow@30`** (dark, re-shot) — the 3×4 grid still tidy in front of the intake.

**Nothing was fixed, because nothing was wrong** — and note that the two bugs a shot run found
last time (the plow gaining on a pollen, every launcher mount collapsing to the front) both stay
fixed through the real `coerceSpec` arm: the 26 archetype sheets are 26 different pictures.

Pollen containment was checked numerically rather than by eye as well: a small PNG reader over
`wall-row-sweep@60`, `corner-pile@240`, `pin-wall@300` and `settle-60@300` found **zero** pollen
pixels outside the mat box (±1px for antialiasing at the wall).

**Pollen physics was NOT retuned** — that is the next chat's job, and the solver caveat above is
the first thing it has to decide about.

## Gotchas this session earned

- ⚠️ **The dev route needs the ALPHA channel AT BUILD TIME.** `devRoutesEnabled()` is
  `appChannel() === 'alpha'` and `appChannel()` reads `import.meta.env.VITE_APP_CHANNEL`, which
  Vite BAKES IN. A plain `npm run build` therefore serves a preview where `/biobuzz/gallery`
  falls through to `parseScreen` and goes home, and `shots.cjs` reports the route is not
  mounted. Build with **`VITE_APP_CHANNEL=alpha npm run build`** for a shot run.
- ⚠️ **`devRoutes` paths are matched against the GAME-STRIPPED remainder**, so BIOBUZZ's gallery
  is `'/gallery/*'`, NOT `'/biobuzz/gallery'`. `devRouteFor` in `src/ui/App.tsx` now honours a
  trailing `/*` (`rest === base || rest.startsWith(base + '/')`), which is what makes a pasted
  `/biobuzz/gallery/<scene>` link open the scene instead of the home screen. Seventy scenes is
  not seventy route entries.
- ⚠️ **`npx vite preview --port 4173` SILENTLY MOVES TO 4174** if another worktree's preview
  already holds 4173 — it prints `Port 4173 is in use, trying another one...` and serves
  anyway. `shots.cjs` defaults to 4173, so a run against a stale sibling build looks like a
  successful run of the wrong code. Check the log line and pass `--port` to match.
- ⚠️ **`shots.cjs` can capture ONE cell at the wrong scroll offset.** Two dark shots
  (`pile-slow@30`, `pile-slow@60`) came back framed on `field-empty` / `field-labelled` — a
  scroll/layout race inside `capturePage(rect)`, which clips silently. Re-running with
  `--scene pile-slow --theme dark` produced correct frames, so it is a runner flake, not a
  render bug. **If a cell looks like a neighbour, re-shoot it before believing it.**
- **`tsconfig.json` is `"include": ["src"]`** — `npx tsc --noEmit -p .` does NOT cover
  `scripts/` or `server/`. A broken `updateBiobuzz(...)` call in `scripts/smoke-biobuzz/field.ts`
  passed tsc and only showed up under `npx tsx`. Server is `npm run server:check`; the scripts
  are covered only by running them.
- ⚠️ **`DEFAULT_SPEC` now lives in the LEAF `src/sim/specDefaults.ts`** and `src/sim/spawn.ts`
  re-exports it, so every `import { DEFAULT_SPEC } from './spawn'` is unchanged. It had to move:
  BIOBUZZ's real module put a MODULE-EVAL-TIME read of it inside the registry import cycle
  (`games/sim` → `biobuzz/sim` → `biobuzz/spawn` → the coercer's top-level
  `{ ...DEFAULT_SPEC, ...BB_PRESETS[0] }`), and ES modules evaluate dependencies before the
  importer's body, so it read `DEFAULT_SPEC` in its TDZ: a hard
  `ReferenceError: Cannot access 'DEFAULT_SPEC' before initialization` at import time. The
  placeholder module never reached a file with a top-level read, which is why the cycle looked
  safe. **Keep `specDefaults.ts` a leaf** — an import there that reaches `spawn.ts`,
  `physicsEngine.ts` or a game module puts the cycle back.
- **`src/games/biobuzz/coerce.ts` is a leaf for the same reason** (`../../types`, `../../math`,
  `../../sim/drivetrain`, `../../sim/specDefaults`, `./config`, `./mounts` and nothing else).
  `robotConfig.ts` is now just `bbCoerceSpec` = `coerceSpec(raw, base, 'biobuzz')` plus
  `bbDials`, and `scripts/smoke-biobuzz/harness.ts`'s `bbCoerce` is that same one call.
- **`catalystRail` absent means 0.** `worldHash` (`src/net/checksum.ts`) mixes only
  tick/rngState/robot pose+turret/ball pos+z/scores/goal counts, and `backfillRobot`
  (`src/net/protocol.ts`) re-seeds a different field list, so the shell's stated fear (a NaN in
  the hash) was not reachable. Only the three Chain Reaction readers needed `?? 0` —
  `chain/play.ts`, `chain/state.ts`, `chain/drawRobot.ts`.
- **Giving a game a `scoreBar` used to hide its `hudChips`.** `GameView.tsx` had an
  `if (GameScoreBar) return ...` early return that dropped the whole `.status-wrap`; and its
  DECODE-specific chrome (motif dots, the four-way breakdown, the hopper strip) was gated on
  `!cr`, which put DECODE's furniture on BIOBUZZ. Both are now `hud.game === 'decode'` / a
  ternary around the bar. DECODE and Chain Reaction render byte-identically — the whole main
  suite stayed at 1308 PASS / 0 FAIL across items 2, 3 and 4.
- **`drawOverlays` is deliberately absent** from `BIOBUZZ_MODULE`, unlike the other slots. The
  slot draws between the field and the robots (DECODE's ramp strips) and BIOBUZZ has no
  published structure to underlay — Section 9 (ARENA) is a Kickoff placeholder. A no-op costs a
  call per frame and tells the next reader there is something to see. It lands with the geometry.
  `mobileButtons` and `startEditor` are absent for the reasons written in `index.ts`.

---

# HANDOFF — 2026-09-10 (BIOBUZZ Phase 0: the shared core is game-agnostic)

Branch **`biobuzz-core`** (worktree `dsim-bb-core`, cut from `biobuzz`, itself cut from
`origin/alpha`). **NOT pushed and must not be** — the repo is public and the 2026–27 season
is private until further notice. Nothing was deployed.

`npm run build` / `server:check` / `uiaudit` / `contrast` green. `npm test` is **1289 PASS
and 7 FAILURES — the same 7, and the same pass count, as the baseline** as of this section's
date. The new BIOBUZZ suite is ALL PASS. `SIM_VERSION` and `BALANCE_VERSION` untouched.

⚠️ **SUPERSEDED — that is no longer true.** `alpha` has since fixed all seven
(the artifact-collision rewrite), so the gate is now simply **green** and `npm test`'s `&&`
chain REACHES the BIOBUZZ suite: one command proves both. See the integration section at the
top of this file and the rewritten `docs/biobuzz/baseline-alpha.md`. What was true on
2026-09-09 and is worth keeping: the chaining is deliberate (a red `npm test` must keep
meaning "physics broke"), and while the seven stood the second suite never ran under
`npm test` at all — no `registry integrity` line appeared in any `npm test` log that day.
**`npm run test:bb` stays**, now as a convenience rather than as the only way: it is the fast
loop while working inside `src/games/biobuzz/`, and the way to run the BIOBUZZ suite when the
first one is red for an unrelated reason.

## What that Phase-0 refactor was and what it was not

Phase 0 items 1–8 of `docs/biobuzz-plan.md`: make the shared core GAME-AGNOSTIC so that a
third game is **a registry entry plus a module directory**, with no two-valued literal left
anywhere. It is a **REFACTOR** — `decode` and `chain` behaviour is byte-identical, and that
was the binding constraint on every decision below.

Two things were deliberately NOT done, and both are stated in the code:

- **DECODE's and CR's inline UI branches are untouched.** The new `GameModule` slots are
  wired in FRONT of them (`mod.X ? <slot> : <existing branch, unchanged>`). Rewriting the
  two games people are actually playing to route through the slots would put a behaviour
  change inside a commit whose only job is to make room for a third game.
- **The never-read `GameUiSpec` (`ui`) is left alone.** Removing it is a separate change and
  it is not in anybody's way.

Also NOT done, on purpose: `coerceSpec` was not threaded with `game` inside `coerceSetup`.
The chassis envelope is per-game too, and switching which envelope a DECODE spec is clamped
against is a behaviour change, not a refactor. Only the start-index clamp moved.

## The baseline gate

`npm test` on `alpha` is not green, so the gate is **"no NEW failures"** against a recorded
list, not "green". Recorded before any edit in `docs/biobuzz/baseline-alpha.md`: `alpha` SHA
`3054f59c7518b75ce1ed339618e203bd785a631c`, **1289 PASS / 7 FAILURES**, all seven in
`src/sim` contact physics, which Phase 0 does not touch:

1. `a robot resting against something does not turn while the driver does nothing`
2. `...and how far grows with how far off centre you hit it, without ever spinning you round`
3. `a SIDE hit on the gate arm turns the robot INTO the corner`
4. `...and a closed arm gives where one at its stop does not`
5. `ramming a wall at speed never snaps the chassis round — it squares it`
6. `an OFF-CENTRE ram spins the robot it lands on`
7. `an artifact pinned in the doorway settles instead of buzzing back and forth`

Re-check with `npm test 2>&1 | grep '^FAIL'`. Any line not in that list fails the gate.
`node_modules` did not exist in this worktree; `npm install` was run first, and it rewrote
the lockfile's Rapier range from `^0.19.3` to the exact `0.19.3` already in `package.json`
(CLAUDE.md requires the exact pin — kept, committed separately as `3fa6a90`).

## What landed, one commit per plan item

| item | commit | what |
|---|---|---|
| 0 | `5c5dc45` | `docs/biobuzz/baseline-alpha.md` — the gate |
| 1 | `72a67de` | `GAME_IDS` / `isGameId` / `coerceGameId`; `GameSimModule.initialAct` + `startPoseCount` |
| 2 | `fa1379c` | every two-valued game literal replaced by the registry helpers |
| 3 | `8a68e61` | the start-index clamp is per-game |
| 4 | `3cf8df2` | `Season.channels` + the pure channel→visibility rule, wired at every enumerating surface |
| 5 | `f7e4fd7` | the optional UI slots on `GameModule` |
| 7 | `0c49c02` | the placeholder `src/games/biobuzz/` + all four registrations |
| 6 | `2bba683` | `scripts/smoke-biobuzz/` and the `npm test` script |
| 8 | (this commit) | CLAUDE.md + HANDOFF |

Items 6 and 7 are committed in the other order: item 6's suite asserts that every id in
`GAME_IDS` is registered, so it cannot be green until item 7's module exists.

**"Adding a game" is now written down** — CLAUDE.md's seam section lists the four
registrations and every slot with its consumer. The four are `GAMES`, `SIM_GAMES`, `SEASONS`
and `GameId`/`GAME_IDS`, and **all four fail SILENTLY when missed**, which is why they are a
list rather than a sentence.

## Gotchas, in the order they will bite

- ⚠️ **`SIM_GAMES`' entries are GETTERS, and that is load-bearing.** `src/sim/spawn.ts`
  imports `simModuleFor` (item 3's clamp) and every game module imports `spawn`, so there is
  a real import cycle through `src/games/sim.ts`. A cycle is safe only when nothing is read
  at module-eval time, and `{ decode: DECODE_SIM }` IS such a read — so whether the file
  worked depended on which module the process loaded first. Entering through `spawn`
  (`scripts/smoke.ts` does) resolved; entering through a game module (the new
  `scripts/smoke-biobuzz` does) threw `Cannot access 'DECODE_SIM' before initialization`.
  Add a new game as a getter too.
- ⚠️ **`public/robots.txt` and `public/sitemap.xml` are STATIC hand-written files.** They do
  not read the registry: robots.txt has a per-game `Disallow:` block written out for
  `/decode/...` and `/chain/...`, and sitemap.xml lists `/`, `/decode`, `/chain` and six
  `/decode/...` routes. A season flipping to `stable` needs BOTH edited by hand. The new
  smoke suite pins that per VISIBLE season (and pins that a hidden one is absent from both).
  The same applies to `index.html`, which hard-codes the home description in three meta tags
  and the JSON-LD because they ship before any JS runs — that string is now pinned against
  the registry-built `HOME_DESC`, so a newly public season fails the suite until all of them
  move together.
- ⚠️ **The channel read lives in exactly ONE place**, `src/seasonVisibility.ts`. The RULE is
  pure and lives in `src/seasons.ts` (which the server compiles, via `periodLabel`, so it
  must stay free of `import.meta.env`) and takes the channel as an argument — the same split
  `roomJoinRegion` uses, for the same reason: `src/net/env.ts` reads `import.meta.env` at
  load, so the headless smoke run cannot import it at all, and this rule fails silently.
  A new UI surface that enumerates games reads `visibleGames()` / `visibleGameIds()`, never
  `registeredGames()` / `SEASONS`.
- An **unknown channel string** sees only unrestricted seasons. That is the safe direction:
  a typo'd `VITE_APP_CHANNEL` hides the private season rather than publishing it.
- **DECODE's URLs are byte-identical** because `src/net/api.ts` omits the `game` query
  parameter entirely for DECODE (`needsGameParam`) — DECODE is the server's default for a
  missing game. Do not "tidy" that into always sending it: an older deployed server and a
  newer client have to agree.
- **`devRoutes` are ALPHA-ONLY** (`devRoutesEnabled()`), gated inside `devRouteFor` in
  `App.tsx` rather than at the render site, so on a stable build the path does not route AND
  does not render — it falls through to `parseScreen`, which sends an unknown path home.
- A hidden game's URL prefix **keeps its screen**: `/biobuzz/records` on a stable build lands
  on the saved game's records, not on home, and the mount effect then canonicalizes the URL.
- ⚠️ **A hidden game had to be dropped from SAVED SETTINGS too, not just from the URL.**
  Found in the by-hand channel check: `coerceSettings` validates `game` as a `GameId` and
  knows nothing about channels, so a stored `biobuzz` (an alpha build on the same origin —
  Electron, or a preview deploy) opened a STABLE build straight onto the season, eyebrow
  reading "BIOBUZZ presented by RTX" and the URL canonicalizing to `/biobuzz`, on a build
  whose picker does not list it. `App.tsx`'s settings initializer now `switchGame`s an
  invisible saved game back to DECODE. The guard is in the initializer rather than in
  `coerceSettings` on purpose: `settings.ts` is imported by the headless smoke run, and
  `seasonVisibility.ts` pulls in `src/net/env.ts`, which cannot be imported there at all.
- **`GameSettings.savedStartPoses` is still ONE shared list across games** (the CR note in
  CLAUDE.md). BIOBUZZ inherits that problem; namespacing the setting is the fix when a third
  game wants a pose library.
- Game checks go in `scripts/smoke-biobuzz/`, **never appended to `scripts/smoke.ts`** — its
  PASS/FAIL list is what the baseline gate diffs.

## `src/games/biobuzz/` is a PLACEHOLDER

Three files (`sim.ts`, `index.ts`, `state.ts`), each saying so at the top, and the P0-shell
chat REPLACES all three. It is an empty 72×72in box with four walls, two start anchors,
`scored: false`, `startLegality: false`, `initialAct: 2`, `startPoseCount: 2`, and a step
that runs the shared drivetrain + Rapier solve + wall square-up and nothing else. No
geometry is invented: the rules land at kickoff on **2026-09-12**, and CR's `APPROX`
convention says an unflagged guess is worse than an empty field.

`docs/biobuzz-contract.md` is the ownership map (Lane A the field, Lane B the robot, the
integration chat everything outside `src/games/biobuzz/`). Per that contract, everything
this session touched outside that directory is **integration-chat property** — a lane that
needs a change there writes the request into its own handoff file.

## The channel check, done by hand

Both channels were verified against a real build (`.env.local` + `npm run build` +
`vite preview`, since `npm run dev` bakes the channel at build time — the file was deleted
afterwards and is `.gitignore`d anyway):

- **alpha**: BIOBUZZ appears on the home picker; `/biobuzz` loads and selects it (eyebrow
  "BIOBUZZ presented by RTX"), `/biobuzz/modes` works, and Free Drive renders the shell —
  the empty 72×72in box with its tile grid and perimeter, one robot on anchor 0 at
  (48, 36) heading 180°, no console errors.
- **stable**: BIOBUZZ is absent from the picker, `/biobuzz` canonicalizes to `/decode`, and
  `/biobuzz/records` lands on `/decode/records` (the screen is kept, the game falls back).

The shell's DRIVE was verified headlessly rather than through the browser (86.4 in/s after
1 s of full forward from the anchor). Synthetic key events from the automation harness do
not reach the game at all — DECODE's Free Drive does not move under them either, so that is
the harness, not the shell.

## Next steps

1. P0-shell replaces `src/games/biobuzz/`; the lanes start against
   `docs/biobuzz-contract.md`.
2. Plan item 7 in the plan's own numbering — `scripts/manual.mjs` (download a manual, run
   `pdftotext -layout`, dump figures) — was NOT part of this brief and is still open. It
   saves Lane A the first hour on kickoff day.
3. Nothing here may be pushed until the season is public.
# HANDOFF — 2026-09-11 (permessage-deflate is ON, and the wire is measured)

Branch **alpha**, commits `e287c0e` + `41e346d`. `npm test` **ALL PASS**, `npm run build` green,
`npm run server:check` green. `SIM_VERSION` untouched. **Production not touched and NOT DEPLOYED
— this is a server change and it needs `./scripts/fly-deploy.sh` to take effect.**

## READ FIRST — what changed and what is still unproven

`server/index.ts` no longer sets `perMessageDeflate: false`. WebSocket compression is on, with
context takeover kept (`serverNoContextTakeover: false`, the load-bearing line) and a 15/8 window.
Requested by the owner after the load investigation; the reasoning and the numbers are in both
commit messages and in the block comment at the `WebSocketServer` construction.

**It is not a protocol change and needs no `CLIENT_CAPS` gate.** The extension is negotiated per
connection in the HTTP upgrade (RFC 7692), so a client that does not offer it keeps receiving
byte-for-byte what it receives today. Verified against the running server: offering yields
`permessage-deflate; client_no_context_takeover; server_max_window_bits=15`, not offering yields
no extension header at all. That is what makes this safe to deploy while one Fly app serves every
client version.

### Measured, end to end, per client downstream at steady state

| shape | today | with deflate | saving |
|---|---|---|---|
| decode-solo | 100.5 KB/s | 12.5 KB/s | -88% |
| decode-1v1 | 184.7 KB/s | 26.0 KB/s | -86% |
| decode-2v2 | 283.2 KB/s | 48.9 KB/s | -83% |
| chain-solo | 387.8 KB/s | 68.8 KB/s | -82% |

Weighted on the stated 6/8 solo, 1/8 1v1, 1/8 2v2 split, 1,000 concurrent goes from 647 GB/hour
to 99, i.e. a 3-hour peak from **$38.80 to $5.94** at an ASSUMED $0.02/GB.

### Two corrections to `docs/capacity.md` (which lives on `perf-load`, not here)

1. **§5 understated today's egress by ~40%.** It modelled 125 KB/s per client weighted; the wire
   measures 175. So the uncompressed 3-hour peak is $39, not $26, and the compressed $3.17 row is
   not reachable at any window size measured here.
2. **§6's 13/6 knee was priced against a machine that cannot exist.** It costed 1,000 sockets at
   250 MB of zlib windows, while §3 of the same document proves one process is one core and a core
   carries ~13 rooms. At 20 sockets the choice is 5 MB against 1.3 MB. 13/6 measured -67% on a
   2v2 — the saving DEGRADED as the room got busier, because a bigger frame does not fit a 64 KB
   window twice — so the knee was trading the ratio away in the most expensive room to save
   192 KB. Hence 15/8.

### `scripts/zz-deflate-cost.ts` is the new probe, and why it had to exist

`scripts/loadtest.ts` (on `perf-load`) counts bytes in its `message` handler, and ws hands that
handler the DECOMPRESSED payload — its figure is identical compressed or not, and it says so
itself. Right for "how big is a snapshot", useless for "what does egress cost". The probe counts
TCP `bytesRead` off the socket, runs each shape twice varying only whether the client offers the
extension, and asserts the extension really was negotiated on one run and absent on the other.
It spawns the real server itself: `npx tsx scripts/zz-deflate-cost.ts`.

### STILL UNVERIFIED — all of it about latency, none of it measurable on Windows

- **Does the added per-message time show in the SNAPSHOT GAP?** Jitter is the choppiness signal
  players feel, not mean RTT, and this is exactly what the original `perMessageDeflate: false`
  comment was worried about. Needs a Linux run.
- **Resident memory at full population.** 15/8 is 256 KB of window per socket plus ws's own send
  buffers. Bounded by CPU (tens of sockets per machine), but unmeasured on a real machine.
- **Where the CPU lands.** Node runs permessage-deflate's zlib on the libuv THREADPOOL, not the
  event loop, so the cost should sit beside the room loop rather than inside it. `capacity.md` §6
  priced it as if it were on-loop (~+5% on a solo room). This is the assumption most worth
  checking, because if it holds, compression is cheaper than §6 claimed as well as less effective.

### Next steps

1. Deploy (`./scripts/fly-deploy.sh`, owner only), then re-run the probe against the deployed
   server with `--url` and compare the snapshot gap to a pre-deploy baseline.
2. `docs/capacity.md` §5/§6 need the two corrections above folded in. That file is on `perf-load`
   and is that chat's to edit.
3. **Unrelated and still open, from `capacity.md` §7: `Room.onInput` buffers future-tick inputs in
   a per-robot map pruned only once the world reaches that tick, so a client stamping huge tick
   numbers grows server memory without bound.** A latent DoS, flagged there as the one item that
   should not wait on the capacity review. A fix exists UNCOMMITTED in the `perf-load` worktree
   (`MAX_INPUT_LEAD_TICKS`), owned by that chat — it is not on alpha.

---

# HANDOFF — 2026-09-10, fourth session (a struck artifact may not outrun the robot)

Branch **alpha**. `npm test` **ALL PASS — 1307 checks (one new: nothing a robot pushes ends up faster than the robot)**. `npm run build` green, `npm run server:check` green.
`SIM_VERSION` untouched at **2**. Production not touched. Alpha deployed at `49d0926`; /health ok.

## READ FIRST — the report, and what it was

"If I drive in full speed, third ball bumps with the second ball and doesn't get intaked." It is
a real physics violation, not intake tuning.

Two equal masses with restitution `e <= 1` hand the struck body `((1+e)/2)*v`, never more than
the striker's own `v`. The artifact solve broke that whenever the striker was itself pressed
against a KINEMATIC chassis and re-driven every tick: unable to recoil, it read as infinite mass
and the solver delivered `(1+e)*v`. Measured on a full-speed ram into an offset pile of four, the
artifact beyond the pushed one left at exactly **90 in/s** — `BALL_MAX_SPEED` clamping a
collision that wanted more — against a robot doing **85**. A line of six was **90 against 75**. A
ball faster than the robot can never be caught again, which is the whole report.

**The fix** (world.ts, after the round loop): a ground artifact's speed is bounded by what could
physically have driven it — its own start-of-tick speed, the start speed of everything in its
start-of-tick contact CLUMP, and the speed of any robot touching that clump. Measured after,
both scenes sit at exactly **1.00x** the robot's own speed.

- a CLUMP, not one hop. A chassis pushes a chain in a single pass by design; capping a ball on
  its immediate neighbour's start speed alone freezes the back of a pile for a tick and brings
  back the burial the speculative look-ahead exists to prevent.
- every velocity pre-pass runs BEFORE the snapshot, so `bounceFirstContacts`, `scatterBalls`,
  `clumpDrag` and `intakeSuction` are already inside the bound. Only the solver's excess is cut.
- a PINNED artifact is EXEMPT. A wedge a few degrees off square must throw the ball `1/tan(theta)`
  times the robot's own advance to keep it clear of the closing gap; holding it to the robot's
  speed shuts the wedge and parks the robot on the ball, which is the failure the pin work fixed.
- `BALL_BALL_RESTITUTION` is UNCHANGED at 0.68 and still measures 0.67. Lowering it also fixes
  the symptom and was rejected: it is what makes a drain disperse instead of the artifacts
  travelling as merged pairs, and it turns out to have almost no other test coverage (dropping it
  breaks exactly one check, and that check is tautological — it asserts the constant).

## Bisection that pinned the cause, so it is not re-done

| change | third capture restored | what it proves |
|---|---|---|
| disable `bounceFirstContacts`, restitution left at 0.68 | no | the pre-solve first-contact bounce is NOT the culprit |
| artifact collider restitution -> 0, bounce pass kept | yes | it IS the solver's restitution on a SUSTAINED contact |
| `BALL_BALL_RESTITUTION` -> 0 or 0.3 | yes | same mechanism from the constant end; rejected above |
| `BALL_MAX_SPEED` -> 40 | yes | only by putting the ceiling under drive speed; a symptom fix |
| `PHYS_BALL_FRICTION` -> 0.3 | yes | by bleeding drift; breaks 4 checks incl. the gate drain |
| `clumpInterval` 0.04 -> 0.02, `capMax` 0.09 -> 0.05 | no | byte-identical. The intake cadence is NOT involved |

## Two things found in passing, NOT yet fixed

- **`sideTouch` can never fire.** The flank grab in `updateIntake` (robot.ts) requires
  `m.mouthHalf > width/2 + 0.5`, and no legal robot satisfies it: `intakeMouth` sets the VECTOR
  preset's `mouthHalf` to exactly `width/2`, and sloped/triangle have a fixed 7in mouth against a
  minimum half-width of 7.25. It is documented as the vector preset's flank capture and it is
  unreachable code.
- **`INTAKE_STRUCT_FRICTION` (0.05) is zero in effect.** The robot solids in `solveArtifacts` set
  the `Min` friction combine rule, `Min` outranks the ball collider's default `Average`, and
  `min(0, 0.05) = 0`. The intake wedges and the held artifacts are frictionless to a ground
  artifact. Verified directly against Rapier, along with the matching fact that the field statics
  name NO rule, so `PHYS_BALL_WALL_FRICTION` would combine by AVERAGE and be **halved** if it
  were ever raised from 0.

## Wall friction was tried and is not the lever (for "artifacts move too quickly")

Raising `PHYS_BALL_WALL_FRICTION` makes a wedge self-lock below `atan(mu_effective)`, and that
landed to the degree at every value tried (nominal 0.1 through 1.0, effective half of each). Two
expected costs did NOT appear: the wall bounce is untouched at every value (impacts are bounced
by the pre-solve pass, which is normal-only, so the constant reaches sustained contact and
nothing else), and the drain still disperses (spread ratio 0.59-0.69 against a 0.63 baseline).
But every value breaks a check, and which one flips partway up: below ~0.35 it is G408
over-possession re-billing (a leaned-on pile cannot squirt free, so it creeps and keeps re-arming
the carry distance); from 0.35 up it is the wall-squeeze squirt (at 8 degrees the robot stops
reaching the wall). That flip is not tunable — a ball that does not fly out and a robot that
drives through are the same event, and friction only moves the angle at which the choice flips.

## Deploy

Alpha server DEPLOYED with the wrapper after `49d0926`; /health answered ok. The Vercel alpha
client rebuilds from the push. Production untouched.

# HANDOFF — 2026-09-10, third session (piles, pins and squeezes, gate intaking)

Branch **alpha**. `npm test` **ALL PASS — 1306 checks (four new: the pile, the squeeze, and gate intaking at two standoffs; the G408 lean scene, the drain-spread check and the outflow-shove tolerance restated)**. `npm run build` green, `npm run server:check`
green. `SIM_VERSION` untouched at **2**. Production not touched. Alpha deploy: see **Deploy**.

## READ FIRST — the three reports, and what each turned out to be

1. "Artifact-chassis overlap still happens." Two real sources. A CLAIMED artifact (one the intake
   had hold of) dropped the chassis from its collision filter, so a pile behind pushed it 2.6in
   through the bumper while its capture timer ran; claimed artifacts meet the chassis now, and
   the chassis lists `A_CLAIMED` in its own filter (a Rapier pair needs both sides). And the
   default look-ahead the second session left the artifact world on made every ball-ball contact
   form a tick late, so a pile pushed by a chassis became a chain of burials (0.6in in the
   chassis, 1.7in ball in ball). The 3.5in speculative look-ahead is BACK, and the bounce Rapier
   drops on a speculative contact is restored exactly by `bounceFirstContacts` (below).
2. "Artifacts act like they are fixed in place." The pin. A fixed pin circle stopped the robot
   dead the moment a squeezed ball was still a fraction inside it, the round re-solve then threw
   away the squirt the round had just found, and the next tick repeated it — a ball creeping at
   5 in/s under a robot parked on it. The pinned circle is a KINEMATIC body now, carrying the
   artifact's velocity (`PinnedCircle`), and a re-run round keeps artifact velocities (positions
   still restored). A stuck ball is the wall it always was; a sliding one is a wall the robot
   follows. What remains "fixed" is genuine: a DEAD-SQUARE push of a ball into a wall. At 8° and
   15° off square the ball squirts out along the wall and the robot drives on, whether it meets
   the flat back of the chassis (smoke-checked) or a funnel intake with a full hopper.
3. "Going into a pile, the robot should intake three as the rest are pushed aside; they act
   like a barrier." The pin test's chain support was direction-blind, so a pile touching a wall
   anywhere counted as immovable, and the robot stuttered to 6 in/s on it. With one-pass
   speculative pushes the solve itself decides what could move, and an empty robot at full
   throttle into a pile of eight now takes three and never drops below 60 in/s.

## The design, as it stands (CLAUDE.md Physics is the reference)

- Artifact contacts are FRICTIONLESS (`PHYS_BALL_FRICTION` 0 / `PHYS_BALL_WALL_FRICTION` 0):
  at 0.05 the solver's penetration-recovery normal impulse in a squeeze, times a twentieth,
  cancelled 165 in/s of sideways speed — a friction cone around a ball that would roll.
- `PHYS_BALL_PREDICTION` 0.35 (3.5in, speculative). `bounceFirstContacts` runs before the solve:
  a pair not yet touching (`BALL_FIRST_CONTACT_GAP`) that will meet within
  `BALL_FIRST_CONTACT_LOOKAHEAD` = 1.5 ticks gets the exact equal-mass restitution impulse; the
  field via `clampBallPosToStatics`. 1.5 because the speculative constraint clips a closing pair
  the tick before they touch (0.49 for a set 0.68 at one tick). Measured 0.67 / 0.47.
- No chassis skin (`PHYS_BALL_CHASSIS_SKIN` is gone), no direction cone (`ARTIFACT_PIN_COS`
  gone), no escaping exemption (`ARTIFACT_PIN_ESCAPE` gone). All three were tried today and each
  failed a scene the others passed; see the pin comment in `pinnedArtifacts` for the two that
  were the most tempting.
- `PinnedCircle` {x, y, vx, vy}: start-of-tick position, the artifact solve's velocity, zeroed
  under `BALL_REST_SPEED` (the solver's jitter carried into the circle walked a stalled robot 13°
  in two seconds). `PHYS_PIN_FRICTION` 0.15 stays: this is the ball that could NOT roll.
- **A ball on the field has no velocity INTO it** (world.ts, beside the containment clamp): the
  squeeze between a kinematic chassis and a static wall leaves the solver's compromise velocity
  pointing into the wall (58 in/s measured); kept across rounds it bounced the ball back off the
  wall at 29 in/s and the robot off the ball. The sideways squirt is kept.
- `bounceFirstContacts` never bounces a ball already ON the static it heads for (a probe
  `BALL_FIRST_CONTACT_GAP` along its velocity is clamped): that is a sustained contact.
- `BALL_MAX_SPEED` 90 in/s (a chassis at full speed) on what the artifact solve hands back: a squeeze can demand 300+,
  which is faster than the look-ahead per tick — a 5in artifact went through a 2.7in corner gap.
- `clumpDrag` reads the shared `artifactSolids` (`BALL_PUSH_CONTACT`); the per-contact scatter
  kick is gone and the coincident kick cannot stack.

## Gate intaking (the follow-up report)

"When gate intaking, the balls that come down should not be pushing the robot away." Measured
with the robot's flank on the wall and its mouth over the exit, intake on, the ramp draining: with
the tip 6in below the exit the drain shoved the robot **0.80in** (peak 6.6 in/s). Cause: every
arrival that piled against the held artifacts became a pin, and the pinned circle was the full
inflated ball carrying the ball's velocity — a moving immovable pointed at the robot. Three
changes, all under one rule, **a pin may undo the robot's own advance and nothing more**:

- the circle is sized against the robot's START pose and all of its solids (`robotPenetration`
  with nothing skipped — the pin test skips held shapes for the doorway ball and the chassis for a
  claimed one, and a circle tangent to the wrong shape overlapped the right one): tangent to the
  nearest solid, plus `PHYS_PIN_INFLATE` only for a robot DRIVING into it (`driveIntent` along the
  pin normal), capped at the full inflated ball. The inflation is what the soft contact compresses
  under the drive force — re-tangenting each tick to the compressed pose let a driving robot creep
  0.14in a tick into the ball and the ball 0.2in into the wall. A robot that drove into a pinned
  ball is re-solved from where it started and stops at the inflation (no more 0.8in forming-tick
  overshoot); a robot not driving toward it is not moved;
- the circle moves only when the robot is DRIVING into the ball (`ARTIFACT_PIN_DRIVE`, 5% of
  stick along the pin normal — intent, not measured advance: a robot stopped on its pin advances
  nothing and is still pushing, and reading that as not-pushing killed the squirt), and then only
  across or away from the robot's CENTRE — the first version clipped along
  the one contact normal the pin test reported (a held artifact's diagonal), and what was left
  still ran into the chassis face at 24 in/s.
- a pinned artifact under a robot that is not pushing it goes back to where it began the tick,
  at rest: the squeeze between a kinematic chassis and the field has no solver answer (position
  or velocity), and the smoke jitter scene (an idle robot parked 1.25in onto the human-player
  column) buzzed at 40 Hz once the robot stopped being shoved off it. Zeroing the velocity alone
  did not stop it — the position corrections alternate on their own.
- NOT a velocity clip against the robot the ball touches (tried, removed): projected along a
  wedge slope's diagonal normal it turned a squeezed ball's compromise velocity into a sideways
  drift (6.7in along the wall under a stalled robot) and a 40 Hz jitter. The wall clip is
  axis-aligned and has no such failure.

Result: **0.00in** displaced at either standoff, empty or full hopper; smoke pins it at 0.1in and
the old outflow-shove check went from a 1.5in tolerance to 0.25.

## Measurements (the pile probe, deleted)

| scene | before today | now |
|---|---|---|
| empty robot, full throttle, pile of 8 in open field: held / slowest in the next 0.8s | 3 / 0 in/s (stall) | 3 / 69.6 in/s |
| same, worst ball-in-ball overlap | 1.7in | 0.3in |
| vector intake, same pile: deepest chassis burial | 5.6in (claimed ball through the face) | 0.5-0.7in, at the face, during a capture |
| pile of 8 against the far wall, square on | stutter 73→6→25→9, yawed 30° | pushes in, jams in the funnel with 3 taken (legit), no yaw |
| one wall ball, flat back of the chassis 8° / 15° off square | robot parked on it | ball squirts 20-100in along the wall, robot reaches the wall |
| one wall ball, funnel intake, full hopper, 8° / 15° | parked on it | ball pops out across the wedge, robot reaches the wall |
| one wall ball, funnel intake, EMPTY hopper, 0 / 8 / 15° | — | taken, every time |
| holding a pinned wall ball at full throttle: steady overlap | −0.16in | −0.16in |

## Gotchas

- **The G408 lean scene bills the ARRIVAL once now.** A full-throttle ram into a six-pile on the
  wall swallows three and squeezes the other three out along the wall; that push is a herd and
  is billed, like the wall-row ram. Holding afterwards still costs nothing (checked over 6.5s).
  Under the old friction the pile jammed and nothing moved, which is why the check used to see 0.
- **Never edit a probe with `node -e` in bash when the JS has template literals.** Twice today a
  patch printed "done" with the console.log arguments stripped out. Write the .mjs with the file
  tool and run it.
- **A kinematic circle at rest is not a fixed collider** unless its velocity is exactly zero — the
  jitter the solver leaves on a squeezed ball moved it.
- **Keeping velocities across rounds can hand a ball a speed the next tick cannot see**; hence
  `BALL_MAX_SPEED`.
- **Off-field ball positions are an invalid staging.** Anything at (300,300) is clamped back into
  the field onto ONE point and kicked apart every tick; five suite scenes did this and one of them
  put nine balls in the wall-ram robot's path. They now truncate `w.balls`; the drain scenes keep
  `RAMP_SLOTS + 1` because they re-purpose those.
- **The human player collects from the audience corner and splices the ball out of the world**;
  a scene holding references sees it frozen where it was. The drain-spread check filters on
  `w.balls.includes(b)` now.
- **The captured ball's collider appears at its slot on the tick of capture** and can overlap the
  next artifact in the mouth by ~1in for a few ticks. It reads as the capture animation; the
  smoke pile check measures the chassis box only for that reason. Worth smoothing some day.

## Next steps

1. Play-test on alpha: piles, gate intaking with an empty and a full hopper (the drain must not
   move the robot at any standoff), pushing a wall ball at an angle, and parking an idle robot on
   a column of artifacts (nothing may buzz).
2. A pile jammed in a FULL funnel against a wall stops the robot (three taken, the rest boxed in
   by the wedge, the wall and each other). That is what a funnel does; if it reads as wrong on the
   alpha, the honest change is in `artifactSolids` (the wedge geometry), not in the pin.
3. Slice 3 (auto-path robot as a dynamic body) still not started.

## Deploy

Alpha server DEPLOYED with the wrapper after each sim commit — 4f9ffd5 (piles, pins, squeezes) and 32cd777 (gate intaking: a pin may undo the robot's own advance and nothing more); /health answered ok both times. The Vercel alpha client rebuilds from the push. Production untouched.

# HANDOFF — 2026-09-10, second session (artifacts collide like balls)

Branch **alpha**. `npm test` **ALL PASS — 1302 checks (seven new, pinning the artifact contact model)**. `npm run build` green, `npm run server:check`
green. `SIM_VERSION` untouched at **2**. Production not touched. Alpha deploy: see **Deploy**.

## (earlier today, second session) Two defects in the artifact CONTACT MODEL — friction and restitution; the look-ahead and skin decisions there are SUPERSEDED by the third session above

The report: "Artifacts feel like they are stuck to each other or stuck to the wall. They don't
leave their semi-linear formation they form when they come out of the gate. They don't
disperse." and "The artifacts do not behave like a 2d collision." Both true, both measured,
both fixed in the artifact world's contact parameters rather than with a pass. CLAUDE.md's
**Physics** section carries the reference (ARTIFACTS COLLIDE LIKE BALLS); the short version:

1. **In-plane friction on a rotation-locked circle is a drag that on a real rolling ball would
   be spin.** Ball bodies are rotation-locked circles in a top-down plane; a tangential friction
   impulse had nowhere to go but their translation. At `PHYS_BALL_FRICTION` 0.7 / wall 0.5 a
   glancing hit sent the struck ball off at 3° where the contact normal was at 30°, a 45° wall
   bounce kept a quarter of its along-wall speed, and 70% of the moving contacts in a gate
   drain were pairs travelling together. Now 0.05 / 0.05 (ball-ball, ball-wall, ball-bumper).
2. **Rapier applies NO restitution on a speculative contact.** The artifact world looked 3.5in
   ahead (`PHYS_BALL_PREDICTION` 0.35 × lengthUnit 10), and Rapier closes a speculative gap as a
   velocity clip, computing the bounce from whatever approach is left — measured e ≈ 0.14 for
   a set 0.68 (ball) and 0.14-0.20 for 0.5 (wall), at every speed; stiffer contacts made it
   worse (0.03); CCD changed nothing. So a ball rear-ending the one ahead merged with it — the
   train. The look-ahead is Rapier's default now (0.002, bounce measured 0.67 / 0.47) and the
   CHASSIS carries a contact SKIN (`PHYS_BALL_CHASSIS_SKIN` 0.35in) so a full-speed sweep still
   catches an artifact before burying it. No skin on the intake (a skin on the wedge narrows the
   throat and squeezed what was in it: 1.44in burial, a ball ejected at 161 in/s).

Three things had to follow:
- **The pin needs something behind the artifact** (`pinnedArtifacts`): with real contacts a
  full-speed ram buries the first ball of a clump for a tick, and the old entry clause pinned
  any deep overlap with no support — the robot stopped dead on 0.2 lb of foam. Support is now a
  chain through OTHER artifacts to a static or robot, or the field — and **the field only pins
  what is pushed INTO it** (`ARTIFACT_PIN_COS` 0.85, ~32° of square; `fieldPushback` gives the
  direction). A corner catching a ball against a wall pushes it at an angle; a round ball
  pushed at an angle rolls out along the wall. Reading that as a pin had parked the robot
  behind a ball it was not touching (the inflated pin circle + the release hysteresis left a
  dead band: "corner-hit wall ball is nudged aside" measured 0.1in).
- **`clumpDrag` reads the same `artifactSolids` the solve does, at the skin** — a pushed
  artifact rides 0.35in off the bumper and the bare-surface contact test never saw it (the
  clump test read 0/0/0%). The robot solids are built once, before the pre-passes, in
  `world.ts`.
- **The per-contact scatter kick is gone** (`scatterBalls` keeps only the coincident-pair kick,
  which also no longer stacks: a pile of many coincident artifacts used to explode). It was
  standing in for collisions that did not work; with them honest it made the drain's spread
  WORSE (axis ratio 0.53 with it, 0.73 without) and kept balls jittering. The owner's ask
  behind it ("spread out more") is served better by the real collisions.

## Measurements (throwaway probe, deleted)

| scene | before | after |
|---|---|---|
| glancing hit, impact parameter R: struck ball's angle off the contact normal | 26° | 3° |
| same, tangential speed of the struck ball | 9 in/s | 1.3 in/s |
| 45° wall bounce, (−30, 30) in | (4.0, 8.8) | (13.9, 25.8); ideal (15, 30) |
| head-on ball-ball restitution at 40 in/s (set 0.68) | 0.14 | 0.67 |
| ball-wall restitution at 40 in/s (set 0.5) | 0.20 | 0.47 |
| nine-ball gate drain at 10 s: minor/major axis ratio | 0.01 | 0.73 |
| …balls touching the wall / touching pairs | 9 / 8 | 4 / 3 |
| …co-moving contact ticks (moving pairs with matching velocity) | 70% | 33% |
| …all nine at rest | never | 3.5 s |
| full-throttle ram into a free 3-clump, slowest speed in the next 0.5 s | 0 (stalled) | 69.6 in/s |
| 60 in/s artifact squeezed between wall and a parked robot's flank: robot displaced | — | 0.30 in |

Experiment ladder that found the restitution defect (prediction is normalized × lengthUnit 10):
prediction 0.35 → e 0.14 at every speed; 0.02 → 0.14/0.29/0.68 rising with speed; 0.002 →
0.77/0.67/0.68 (ball) and 0.42/0.47/0.49 (wall); freq 25 → 120 Hz at 0.35 → 0.03/0.00; CCD on
→ identical to CCD off. The clip-then-bounce mechanism fits all of it.

## Gotchas

- **`normalizedPredictionDistance` is × lengthUnit.** 0.35 was 3.5 INCHES, not 0.35 — the config
  comment said so and it still read as small.
- **The exit drift experiments are chaotic.** `EXIT_DRIFT` 2.5 / 3 / 4 / 5 gave axis ratios
  0.73 / 0.78 / 0.65 / 0.69 on one seed — no monotone benefit, so it stays at the owner's 2.5.
  If the wall-hugging is still too much on the alpha, this is the dial (the release lands the
  artifact immediately; a real drop off the lip would scatter it more).
- **Balls resting on a wall can carry a micro-velocity** (< 0.01 in/s) from the soft contact's
  position correction; the pre-solve rest snap cannot see it. Harmless, but "all at rest" in a
  probe can read as "never" because of it.
- **The keep clause of the pin is still direction-agnostic** (a pinned artifact stays pinned
  within `ARTIFACT_PIN_RELEASE` while anything supports it). Entry is directional, so the
  corner dead-band cannot form, but a pin that formed square and then slid can outlast the
  geometry by up to half an inch.
- **The parked-robot shove is 0.30in** at 60 in/s on the flank: the inflated pin circle pushing
  the robot out of a 0.21in burial. Real bumpers give about that. If it reads as a shove on the
  alpha, the pin circle would need to be placed tangent to the chassis surface for a robot that
  did not move into the ball.
- The suite's `{ kind: 'held', robot: 99 }` idiom (see the earlier section) is still in the
  rail scenes; none failed.

## Next steps

1. Play-test on alpha: the drain, pushing a clump, gate intaking with a full hopper.
2. If artifacts read as floating off the bumper, `PHYS_BALL_CHASSIS_SKIN` 0.35 → 0.25 (the
   catch distance for a full-speed sweep shrinks with it; scene F in the probe measured 0.80in
   burial with NO skin at 70 in/s).
3. Slice 3 (auto-path robot as a dynamic body) still not started.

## Deploy

Alpha server DEPLOYED with the wrapper after the sim commit (254d24e); /health answered ok. The Vercel alpha client rebuilds from the push. Production untouched.

# HANDOFF — 2026-09-10 (collisions rebuilt: one position authority per element)

Branch **alpha**. `npm test` **ALL PASS — 1296 checks** (7 failures at session start, 20 the
moment the rewrite landed, 0 now). `npm run build` green, `npm run server:check` green.
`SIM_VERSION` untouched at **2** (alpha policy: the bump is relative to MAIN). Production
(`dohun-sim-decode`) NOT touched. Alpha server: see **Deploy** at the bottom of this section.

## (earlier today) The seam is gone, not patched — still the reference for the engine's shape

The request was "fundamentally fix collisions and the physics engine; there should never be a
case where there is nowhere to go for some elements". Read as an invariant: **every element
ends every tick somewhere it is allowed to be, with ONE position authority per element.** The
previous section's three-faced fault (artifact/robot interaction faked at the seam between two
solves that could not see each other) is closed by removing the seam. CLAUDE.md's **Physics**
section is rewritten and is the reference; the short version:

- **`src/sim/artifactSolids.ts` (NEW) is the one geometry authority** for what on a robot is
  solid to an artifact: chassis box, funnel wedge quads with a compliant lip (`INTAKE_LIP`),
  vector flank rails (`INTAKE_RAIL_T`), held balls. `robotSolids` / `robotPenetration`
  (with a `floor` so near-misses are reported for the keep test). The mouth is open in it.
- **`solveRobots`** now takes the PINNED artifacts as fixed, inflated, low-friction circles
  (`R_PIN`, `PHYS_PIN_INFLATE`, `PHYS_PIN_FRICTION`) against density-0 chassis solids on
  each dynamic robot body (`R_CSOL`). The lateral clip after the solve distinguishes
  "stopped by a contact" from "slung sideways" — it used to restore a strafe a contact had
  just refused (a stationary robot reported −34 in/s and crept into pinned artifacts).
- **`solveArtifacts`** replaces `solveBalls` (and `artifactMomentum`, `ballRobotFeedback`):
  balls dynamic, every robot a `kinematicPositionBased` body swept from `sweepFrom` (the pose
  at the top of the tick; a path jump resets it) to where the robot solve put it, carrying the
  `artifactSolids` shapes as colliders (chassis / structure / held, distinct groups so a
  claimed or doorway ball can ignore the right ones). Restitution AND friction combine `Min`.
  `normalizedPredictionDistance` (`PHYS_BALL_PREDICTION`) gives speculative contacts.
- **The round loop** in `world.ts` `step`: snapshot → `solveRobots` with the current pin set →
  `solveArtifacts` → containment clamp (INSIDE the loop, `BALL_CONTAIN_SLOP`) →
  `pinnedArtifacts`; if the set grew, restore and go again, up to `PHYS_PIN_ROUNDS` (4).
  `world.pinnedArtifacts` carries the set tick to tick (in the world JSON — `types.ts`, both
  spawns init it) so the pin has hysteresis: enter past `ARTIFACT_PIN_SLOP`, release only once
  clear by `ARTIFACT_PIN_RELEASE`. Support is TRANSITIVE (`supported`: BFS over touching balls
  to a static or another robot) — a free clump is not support; it froze when it was.
  `lastTickRounds` is the only diagnostic left (the per-tick `lastPinReport` was removed).
- **Velocity-only pre-passes**, all before the solve: `scatterBalls` (pair scatter, plus a
  hashed-direction kick for a COINCIDENT pair — `BALL_COINCIDENT_KICK`; the doorway buzz was two
  artifacts a test had parked on one point), `clumpDrag`, and `intakeSuction` — split out of
  `updateIntake` (now capture-only) and moved BEFORE the solve, because G408 reads artifact
  velocity and a post-solve nudge herded 120in for 0 fouls.
- **Buried artifacts** (centre inside a robot solid) are re-placed by `placeGroundArtifact`,
  which flight landings use too.
- **Deleted**: the ~110-line artifact stall in `robot.ts`; `solveBalls` / `artifactMomentum`;
  the ground-pass functions `separateBalls`, `collideBallHeld`, `evictBallFromRobot`,
  `ballWedgedInRobot`, `ballRobotPenetration`, `clampGroundBall`, `footprintCornersOf`,
  `inflatedRect`; and the constants `BALL_EVICT_MAX_STEP`, `BALL_SQUISH_SLOP`,
  `BALL_FREEZE_MAX_OVERLAP`, `BALL_RELAX_PASSES`, `BALL_PIN_SLOP`, `BALL_PIN_PUSH_MIN_SPEED`,
  `BALL_JAM_SLOP`, `BALL_SETTLE_SLOP`, `BALL_ESCAPE_*`, `BALL_SEPARATION_RELAX`, `EXIT_PIN_FRAC`,
  `CONTACT_MU`, `CONTACT_RESTITUTION`, `CONTACT_PAIR_SPIN`, `CONTACT_SLIP_RELIEF`. A few smoke
  comments still NARRATE those names as history — grep before reintroducing any of them.
- Still bespoke by design: flight, basin, rail, gate, and all of Chain Reaction's particles.
  `collideBallRobot` / `collideBallBall` survive ONLY for low FLIGHT balls.

## Rotation is the solver's alone (the angular half)

With the two halves measured separately, the bespoke additions were double-counting:

| what | old | new | measured |
|---|---|---|---|
| `CONTACT_IMPACT_SPIN` | 0.05 | **0** | the flick was pure double-count |
| `CONTACT_ALIGN_RATE_MAX` | 0.05 | **0.015** | 0.05 added 2.9°/tick to a wall ram |
| `MOTOR_SHOVE_BRAKE` (NEW) | — | on a shoved robot's yaw | a drivetrain resists being spun |
| wall ram peak ω | 1.5 asserted | 2.64 rad/s | = v·sin20°/half-diagonal, the corner pivot |
| off-centre ram, 2/4/8/12in | ">2° each" | 0.66/1.54/3.91/7.85° | graded by the lever arm |
| sustained push 4/8/12in, 10s→15s | ≤1° growth | 2.16→2.74 / 5.40→6.19 / 19.05→21.84 | a corner keeps a small arm |
| gate arm, 2/4/6/8in off centre | ">3° each" | 2.5/5.8/10.5/21.4° | monotonic |
| gate arm side hit y=−12/−9/−6/−3 | ">2° each" | 0/0/23.2/2.9° | the first two never reach the stub |
| closed arm vs at its stop | stop > 2×shut | 30.5° vs 23.2° | the longer stub turns you more |

Six smoke checks (210, 212, 213, 214, 260, 263) were re-derived to those physical values with
the derivation in each test comment; 221 (corner capture on the diagonal) now runs at 40° —
dead on 45° both front corners meet both walls at once, a symmetric wedge with no torque.
**A test that wants "more turn" is asking for the double-count back.**

## Friction — an OWNER-VISIBLE calibration

`PHYS_FRICTION` 0.7 → **0.45**, `PHYS_WALL_FRICTION` 0.5 → **0.35** on the ROBOT world (bumper
rubber on polycarbonate); the artifact world keeps 0.7/0.5 as `PHYS_BALL_FRICTION` /
`PHYS_BALL_WALL_FRICTION`. Why: with honest Coulomb friction a stalled motor pushes with full
stall force at ANY throttle, so at 0.7 a full-throttle press by an equal or heavier robot held a
strafing victim outright. G422's `held()` scene now uses the weakest legal holder (18 lb x-drive
at 200 rpm, `weakHolder`). If pushes feel too easy to escape on the alpha, these two are the
dial — but they only MOVE the stick/slip threshold.

## The "nowhere" probe, final numbers

A throwaway probe (deleted; scenes A–G) of every "nowhere to go" shape: flank strafe onto a
wall artifact at throttle 1 and 0.3 then 4s idle, 0/20/30° rams into a wall row, a 4s corner
pack, a robot bridging 4.0/4.6/5.5in gaps, an artifact squeezed between two robots, a two-deep
flank push, and a full hopper's mouth onto a wall artifact. Worst squish **0.13in** (the
two-robot squeeze), zero centre-inside ticks anywhere, drift after release ≤ 0.05in, no
tunnelling through any gap under 5in, corner pack drift 0.00in, full-hopper mouth 0.00in.

## Gotchas that cost real time

- **The shell.** `node -e "..."` with backticks or `\n` inside bash double quotes silently
  applied nothing or threw ("bad substitution"), and a quoted heredoc with apostrophes in it
  failed to parse in this harness. Write scripts with the Write tool, run them with node, and
  grep afterwards. Three batches were "applied" and were not.
- **`{ kind: 'held', robot: 99 }` does NOT clear the field.** `positionHeldBalls` drops a held
  ball whose robot is gone back to the FLOOR on tick one, at its spawn (the spike marks). Three
  gate-arm scenes were spawning ON a spike-mark ball and one was driving a ball into the wall
  and measuring THAT as "the gate arm turned me". Cleared with `w.balls.length = 0` + empty
  `humanPlayers[a].box`. The idiom is still at smoke.ts lines ~2298, 2374, 2715, 2831, 2883,
  3577, 5094, 5151, 5218 (rail / drain / gate scenes whose robots sit at the wall, away from the
  spike rows) — not verified individually; sweep them.
- **A convex hull of the funnel fills the notch** and turns the outer corner into a forward
  wall (a 7in ball rode it, corner capture failed). The wedge is an explicit quad with the lip.
- **A pin was missed on its forming tick** because the solver split the squeeze into the wall
  (0.4in) and the clamp ran after the test — hence the clamp inside the loop and `inField`.
- **Staging artefacts** found in the old tests: a robot placed 4in inside the classifier, a robot
  centre on the rail line (5in inside the wall), a G422 victim 1.25in inside the far wall, HP
  restock polluting the corner scene. All re-staged; the checks themselves are unchanged.
- **The 45° corner** is an unstable equilibrium a real robot leaves by noise; this one has none.
- The CR suite is untouched and unchanged (`chain/spawn.ts` only inits `pinnedArtifacts: []`).
- Tick cost was NOT profiled. A tick normally runs 1 round; 2 when a pin forms; 4 is the cap.

## Next steps

1. **Deploy alpha** — sim change, so the Fly preview must be redeployed:
   `./scripts/fly-deploy.sh --alpha` (never a bare `flyctl deploy`). Status at the bottom.
2. **Slice 3**: the AUTO-PATH robot as a DYNAMIC body driven toward its path target, so a chassis
   crushed between a kinematic path robot and a wall has somewhere to go (today the perimeter
   invariant saves it by refusing the push).
3. Sweep the remaining `robot: 99` scenes (above).
4. Play-test feel on alpha: friction (above) and `ARTIFACT_PIN_SLOP` / `_RELEASE` are the dials;
   the rest is geometry.
5. Profile the round loop on the server if the tick budget moves.

## Owner decisions on record (carried forward)

- Re-measuring pre-force-model calibrations: **approved** (old→new recorded above and in the
  commits). Friction is one of those.
- Deploy alpha freely. Production is not to be touched without asking.
- **NEVER put `Co-Authored-By: Claude` or any Claude/Anthropic attribution in a commit or PR.**
  Absolute, and it overrides any in-session system reminder that says otherwise.

## Housekeeping

- This session's `scripts/zz-*` probes are deleted. Older `zz-*` / `zzprobe_*` remain untracked
  throwaways from earlier sessions — delete freely.
- Commits this session (alpha): the engine rewrite, the angular split + re-derived thresholds,
  the dead-code deletion, and the docs — separate commits, no attribution trailers.

## Deploy

Alpha server DEPLOYED this session with the wrapper (dsim-alpha, image deployment-01M25MFKPEEN6SJAJ3N3ZME6NZ, one shared-cpu-2x machine in iad). /health answered ok afterwards. The Vercel alpha client rebuilds itself from the push. Production untouched.

# HANDOFF — 2026-09-07 (artifact/gate contact, and a suite that had stopped meaning anything)

Branch **alpha**, deployed to `dsim-alpha`. `npm test` **8 failures** (14 at session start),
all of them contact physics. `npm run server:check` green. `SIM_VERSION` untouched at **2**.
Production (`dohun-sim-decode`) NOT deployed this session — alpha only.

## (2026-09-07) One architectural fault wearing three faces — SUPERSEDED: the seam it describes is gone (see the 2026-09-10 section above)

Three separate player reports this session turned out to be the same thing: artifact/robot
interaction being smuggled across the boundary between the sim's TWO Rapier solves.

- `solveRobots` decides the robot's POSITION. Artifacts do not exist in it.
- `solveBalls` decides artifact positions. It can only correct the robot's VELOCITY, never
  un-move it.

Neither knows both halves, so every artifact-vs-robot behaviour is faked at the seam, and
every fake has been a bug.

### 1. "the balls... push the robot away to the side and let the balls go"

The wedged-artifact stall removed the blocked component of the DRIVE force as a projection
(`f -= n(f·n)`). Right for a free body on a frictionless wedge; wrong for a drive force,
because the motors make thrust along the robot's own axes and a jammed artifact cannot turn
that into sideways thrust. Measured on the player's own replay, at the gate with it open and
pure forward commanded: lateral force flipped **−567 → +1158 on the same tick, every tick**,
ramping to 27 in/s of strafe with forward speed pinned at 0.1. Four sustained events in one
match (30/19/16/4/3 ticks). Attributing injected sideways velocity by pass: `solveRobots`
32.0 in/s, artifact solve 0.4, square-up 0.0.

**It was invisible to the tyres**, which is why it ran away: the stall runs BEFORE
`wantX/wantY` are computed, so the strafe was handed to the solver as the velocity the drive
ASKED FOR, and the per-wheel traction model saw no slip to resist.

### 2. "I'm still getting pushed around by artifacts against the wall"

Same term, second face. Capping the stall's lateral MAGNITUDE was not enough — a sign flip
with a smaller magnitude passes a magnitude cap untouched. And what it flipped matters: with
a pure forward command the pre-stall lateral force is the drivetrain BRAKING its own sideways
slide, so the stall turned the robot's attempt to stop sliding into a push the other way.
Driving into five artifacts on a wall vs the same drive into the BARE wall: 20° **29.83in vs
0.98in**, 30° **42.59in vs 1.89in**. Now 4.39 and 7.50.

Second cause, same bug: `artifactMomentum` was read AFTER the solve, so the bound included
the speed the robot had just given the artifacts — a bound the bounded party can inflate.

### 3. "I should not be getting pushed away from the gate when unpowered"

The handle PIVOTS at the classifier edge, so its stub sits there at every open fraction. A
chassis nosed into the gate mouth (legal floor below the channel — where you stand to collect
the outflow) contains that pivot whatever the arm does, so `gateRobotRest` returned 1 and the
fully retracted stub was STILL inside it. Measured with NO command: **1.16in drift, 1.59°
turn**, against 0.15in / 0.03° for a robot touching nothing. Now identical to touching
nothing. `gateOverrun` is directional on purpose — a robot approaching head-on never gets
past the pivot, so the gate stays a gate (GATE INTAKING 7/9 and 9/9).

## Gotchas that cost real time — do not re-learn these

- **STAGE, THEN VERIFY THE STAGE, THEN MEASURE.** Five probes running produced confident
  wrong conclusions: a chassis spawned inside the classifier channel (measuring its own
  ejection), a window that closed before the ramp drained, a robot covering the outflow mouth
  entirely, a robot that never left `pre` because `preCountdown` was unset, and a "gate" pose
  that was really a classifier overlap. Assert what you believe — `robotIntersectsRect(r,
  gateArmRect(a))`, `in classifier: false`, artifacts actually drained — and print it beside
  the number.
- **ALWAYS RUN THE NULL CONTROL.** "Artifacts push me 29.83in sideways" means nothing until
  the same drive into a bare wall gives 0.98in. Two earlier conclusions died on this.
- **`heading` LIVES IN (−π, π] — WRAP BEFORE SUBTRACTING.** A smoke check reported an idle
  robot "spinning 359.6°" whose angular velocity was 0.001 rad/s and whose contact response
  contributed zero torque (`press` was 0 at every contact, so `contactTorqueDelta` took its
  "no load, no torque" early-out). Pure arithmetic, red for a long time.
- **A SUITE AT 13 RED STOPS MEANING "PHYSICS BROKE".** That is the cost of the two points
  above. Of the 14 failures at session start, **7 were bad test scenes, not bugs.**

## The suite: 14 → 8, and seven of those were the tests

Two worktree-isolated subagents diagnosed the non-physics clusters, both verifying against
the PRE-REWORK tree rather than assuming.

- **Five penalty scenes (G422 ×2, G408 ×3) staged motion the sim no longer has.**
  `src/sim/penalties.ts` NOT touched. A G422 scene silently asserted the stationary case
  because the slip relief now stops a sliding contact steering its victim; a "victim goes
  nowhere" check reported `moved 52.1in` (it self-contradicted, which is how it was caught);
  a "clipping in passing" scene actually drove dead centre at full throttle and ploughed four
  artifacts 48in downfield. Restaged, plus 3 NEW checks so they cannot pass for the wrong
  reason.
- **Two replay guards measured the wrong axis.** `startPose('blue', 0)` is hard against the
  side wall and the scene is robot-centric, so travel is in −y (~68in) while the guard read x
  — which is only sideways squirt off that wall (31in when written, 0.67in now). Now
  `hyp(dx, dy)`; thresholds unchanged (5in vs 67.7in).

## Still red (8) — all contact physics, all honest

1. idle turn 2.32° at a resting pose (threshold 1°)
2. gate-arm off-centre turn profile — wants monotonic, gives 3/7/10/6°
3. gate-arm SIDE hit — 25° outlier at one of four offsets
4. closed arm vs one at its stop — 28.5° / 24.6°
5. wall ram — 5.4°/tick and 3.24 rad/s against thresholds of 4° and 1.5
6. off-centre ram spins the victim only 0.7°/1.3° at 2in/4in (wants >2°)
7. sustained off-centre push — tilt grows 5.7°→6.9° instead of settling
8. artifact pinned in the doorway buzzes — 25 reversals in 2s, peak 235 in/s

**NEITHER FEEL DIAL IS THE LEVER — both were swept and neither moves these numbers.**
`CONTACT_PAIR_SPIN` 0.6 → 1.0 → 1.4 leaves #6 byte-identical; slice B's per-wheel lateral
traction refuses the spin downstream. `CONTACT_IMPACT_SPIN` 0.05 → 0.03 → 0.02 moves #5 from
3.24 to 3.02 rad/s against a 1.5 bar. Since slice A unlocked rotation, this rotation comes
out of Rapier's own contact resolution, not the heuristic terms. **Do not "tune" these** —
find where the traction force cancels the impulse.

**#8 is a regression from the fix for bug 2, and the trade is measured:** an artifact lateral
bound of ZERO fixes #8 and the gate-arm shove but lets an artifact tunnel a 4.4in gap it
cannot fit; the momentum bound stops the tunnelling but lets the doorway ring. The right
answer is neither — it is the unification below.

## Unifying the two solves was TRIED IN FULL and is NOT the fix - measured

This was the standing recommendation - one world a tick, all positions taken from it,
deleting the whole smuggling layer. It has now been BUILT AND MEASURED, and should not be
built again without new information.

**The blocker everyone expects is not the real one.** Contact stiffness is stated on the Rapier
WORLD, not the collider (there is no per-collider stiffness in the API), and robots and
artifacts want different values. Swept, whole-suite:

| single stiffness | failures | what breaks |
|---|---|---|
| split, as shipped | 8 | - |
| ARTIFACT setting 25 / 0.001 for both | 10 | two marginal gate-lift numbers |
| ROBOT setting 12 / 0.01 for both | 13 | drivetrain side-slip ORDER inverts, tank peak 5.0% to 35.7% |

So one stiffness (the artifact one) does serve both, and the documented fear - that a stiff
contact flings a robot, which can legally begin a step deep inside a wall via its intake reach
- no longer applies, because slices A and B made the drive a FORCE rather than a velocity
written onto the chassis. Unification is therefore VIABLE. It is just not worth it.

**Built in full** (artifacts in `solveRobots` behind the group scheme below, positions taken
from that solve, `solveBalls` deleted, the drive-force stall deleted, one stiffness at
25 / 0.001): **18 failures against the split's 8, and it breaks Chain Reaction** - a mecanum
strafing into a beam left the field, y = -8 to y = 61.

**AND THE DECISIVE RESULT: unification does NOT remove the need for the geometric invariant.**
With the solve unified and the eviction pass removed, artifacts still buried **5.15in of a
2.5in radius** and sat with their centres inside a chassis for 58 and 63 ticks. The cause is
not the architecture - it is the MASS RATIO. An 0.2lb artifact between a chassis carrying a
`shoveMass` in the teens and a STATIC wall is tens-to-one terminating in an immovable body,
which a fixed iteration budget cannot propagate through in time. No arrangement of worlds
fixes that. That was the entire argument for unifying, so it is gone: `evictFromArtifacts` is
required in EITHER architecture, and with the split it is cheaper.

The group scheme, for anyone who revisits it: `U_FIELD 0x0001001a`, `U_FOOT 0x00020023`,
`U_PROXY 0x00040008` (chassis-only, massless, artifacts only - this is what keeps the intake
mouth open), `U_ART 0x0008001d`, `U_CLAIM 0x00100019`, `U_ARM 0x00200002`. It typechecks and
runs; every number above came from it.

**`cap = 0` plus the eviction was also tried** (zero artifact-to-robot lateral transfer, the
literal form of "balls do not have the force to move the chassis"): 11 failures, artifact
tunnelling returns at a 4.4in gap, and the doorway still rings. Not it either.

**Five restructures have now been tried and ALL measured worse** (13 → 17, 19, 17, 17, and the full unification at 18):

1. Full footprint solid to artifacts in `solveBalls` (mouth open only to claimed artifacts) —
   breaks clump pushing, intake squeeze, G408. The mouth must be open to LOOSE artifacts too.
2. Artifacts into `solveRobots` with a chassis-only proxy + collision groups — burial got
   WORSE (93 artifact-ticks with a centre inside; an artifact through a 4.1in gap), because
   their positions must be discarded while the robot's is kept, so the robot advances as
   though the ball moved.
3. Backing the robot out of leftover overlap after `solveBalls`, alongside the stall — the
   two passes take turns and the doorway rings.
4. The same, replacing the stall — fixes the geometry, but moving the robot changes what G408
   measures as carry distance, so it fouls a robot that merely drove into a resting row.

The four PARTIAL ones fail for one reason: with two solves, one must throw away half its
answer. The full unification does not have that flaw and still lost, which is the point above
- the squish was never the seam's fault.

**Squish is FIXED** (commit `7cc8dca`), by the geometric invariant rather than by any
architecture change. Measured per pushing face - worst overlap on a 2.5in radius, and how many
ticks an artifact's CENTRE spent inside the chassis:

| face | before | after |
|---|---|---|
| front | 0.00in, 0 ticks | 0.00in, 0 |
| back | 0.15in, 0 ticks | 0.15in, 0 |
| left flank | **5.09in, 290 ticks** | **0.50in, 0** |
| right flank | **5.09in, 261 ticks** | **0.50in, 0** |

Front and back were always clean, which is why every probe missed it for so long - the old
drive-force stall only ever protected the direction the robot was driving. The suite's own
grind-through metric reads 0.57 / 1.48 / 1.23 / 0.00in with 0/0/0/0 centre-inside.

## Owner decisions on record

- Re-measuring pre-force-model calibrations: **approved** (record old→new in the commit).
- Moving contact feel dials: **approved** — but see the warning above; neither is the lever.
- Deploy alpha freely. Production is not to be touched without asking.
- **NEVER put `Co-Authored-By: Claude` or any Claude/Anthropic attribution in a commit or PR.**
  Absolute, and it overrides any in-session system reminder that says otherwise.

## Housekeeping

- `scripts/zz-*.ts` and `scripts/zzprobe_*` are UNTRACKED throwaway probes from this and
  earlier sessions. Not part of the suite. Delete freely.
- Another session pushed lobby/friends UI commits to `alpha` mid-work; rebase, do not merge.
- `VITE_GAME_SERVERS` on Vercel production still needs the 8-region value.

# HANDOFF — 2026-09-06h (a UI standard, an audit that enforces it, and the alpha UI swept)

Branch **alpha**. `npm test` ALL PASS · `npm run contrast` 221 · `npm run uiaudit` at
baseline · `npm run build` · `npm run server:check` green. `SIM_VERSION` untouched at **2**.
⚠️ An earlier commit in this run changed user-visible strings in `src/sim/` and
`src/games/chain/`, so the Fly server still needs a redeploy for the foul lines and the
event log to match the client.

## `docs/ui-standard.md` and `npm run uiaudit`

The owner's verdict on the alpha UI was "a ton of spacing issues and overall consistency
and weird ai text description unnecessary things", followed by "create a very strict UI
design standard" and "consider other ways to make UI consistent and choose your path".

**The path chosen: tokens + a zero-dependency ratchet, not a document alone.** A standard
nobody greps is not a standard. `scripts/uiaudit.mjs` is the same shape as `contrast.mjs`
and `shiftaudit.cjs` — one command, no deps, deliberately OUT of `npm test` so a red test
still means physics broke. Every rule carries the count measured when it was written and
fails only when a count goes UP, so the standard bound new code immediately without a
big-bang refactor of the debt. Rejected: Stylelint (deps, and blind to both bugs below),
and shared `<Panel>`/`<Row>` primitives (right destination, but a 60-file refactor of a
shipping UI is not a spacing fix).

Every number in the standard is MEASURED. The codebase had **no spacing tokens at all**,
ten distinct `gap` values, eighteen font sizes (six fractional), seven weights, and 105
spacing literals inlined in JSX.

### The two rules that are hard errors, because both bugs shipped silently

- **UNDEFINED CUSTOM PROPERTY.** `--ds-font` was used 13 times and defined nowhere. In a
  `font:` shorthand an unresolvable `var()` is invalid at computed-value time and drops the
  WHOLE declaration, so `.ds-gauge-num`, `.ds-standing-name`, `.ds-report-h` and ten others
  set no weight, size or line-height for months, with nothing in the console. `--accent` was
  the same bug wearing a `#literal` fallback, which is why those are banned too.
- **DUPLICATE SELECTOR.** `.ds-dl` was declared twice for two unrelated components — the
  replay export menu and the download page — and the later block won, laying the export menu
  out as an 18px-gap column. Both stylesheets are one cascade; source order is the only
  tiebreak and nothing warns you.

### ⚠️ A LINTER WITH FALSE POSITIVES CAUSES BUGS

The duplicate-selector rule originally matched `^sel {` on a single line. A selector LIST
spans lines, so it read the last line of

```
.fr-empty,
.fr-note,
.fr-error {
```

as a standalone rule and reported `.fr-error` as a duplicate of itself. I believed it and
merged the two blocks — which folded `.fr-error`'s red into the SHARED base and **turned
`.fr-empty` red**. It shipped in `525092f` and was caught only when a later agent asked
about that block.

Two lessons, both now in the code: the parser accumulates the prelude across lines, and
**only a single-selector rule owns a name** — `.a, .b { }` followed by `.a { }` is a base
plus a per-variant override, which is the normal shape, not the bug. And when verifying a
CSS merge by computed style, probe every selector in the group, not the one you changed.

## What the sweep actually changed

Four report-only auditors, then four edit agents partitioned by FILE (CSS stayed with me,
since all four slices share `shell.css`). Highlights:

- **`.ds-panel` had no margin and `.ds-main` no gap**, so every page hand-typed panel
  spacing — 0, 16, 18, 22, 28. Donate typed nothing, so a signed-in supporter saw four cards
  meeting border-on-border. One rule owns it now, plus the `.ds-panel-body` class that had
  been written out as `style={{ padding: 16 }}` twelve times.
- **`.ds-panel + .ds-panel` only fires between two panels.** In Career the practice-replay
  panel is followed by the period picker, which is not one, so it had no gap below it at
  all. Panels in the page column carry the trailing half too; `.ds-main` is a block, so it
  COLLAPSES rather than doubling.
- **Layout shifts fixed**: Matchmaking jumped ~54px on FIND MATCH; the Chain start editor
  moved its inputs ~27px MID-DRAG; the top bar re-flowed a second after every page load;
  the Ranked tile grew then collapsed as `signedIn` resolved; the report dialogs' six option
  cards made a dialog into a page (537px → 366px at the same width).
- **Two inert properties**: `grid-column` on a flex child (the 3×3 catapult map never got
  its full-width row) and `.ds-opts` without `card4` (the four-card Catalyst picker wrapped
  3+1).
- **`.num` was in the practice-replay table five times and defined NOWHERE.**
- **HomeMenu used two NEGATIVE margins whose only job was to cancel its own flex gap.**
- Type debt cleared: 46 fractional px sizes → 0. The weight rule was AMENDED rather than
  enforced — `shell.css:164` documents both families as VARIABLE cuts, so 750 is real type
  and I had written that rule without reading the comment.

## Deliberately NOT done

- **Spacing CLUSTERS.** 6px (22 uses), 10px (24) and 14px (16) are 2px moves across many
  surfaces at once — a design decision, not a lint fix. Same for the 14 `10px` radii, which
  sit between `--ds-round` and `--ds-round-md`. Recorded as debt with counts.
- **ModeSelect's `.k` tile kickers** — the owner explicitly overruled deleting them.
- **`Select.tsx` migration.** 2 consumers against 5 raw `<select className="ds-select">`,
  1 `ds-input` and 3 unstyled in Admin. Product call.
- **"Rated 1v1" vs "Ranked 2v2"** for one concept (both are ELO). They ARE different
  formats — a closed party vs a premade in the open pool — so collapsing the words is a
  product decision.
- **The misscore queue's WATCH button still cannot work** — it passes a match id to a
  replay lookup, and those are different id spaces. Server-side fix, needs a deploy.
- The builder's nested gap ladder is still EIGHT values (`.ds-robot` 22 → `.ds-sec` 11 →
  `.ds-subh` ±4 → `.ds-opts` 12 → `.ds-panelbox` 15/14 → `.ds-fields` 18 → `.ds-field` 7 →
  `.ds-opt` 4). Collapsing it to five is the natural next pass, and the five sub-pickers
  that were just un-margined now depend on `.ds-panelbox`'s gap being the only separator.

## Next steps

- **Deploy** — `./scripts/fly-deploy.sh --alpha`, still outstanding for the sim strings.
- `fly secrets set` for `ADMIN_USER_IDS` is DONE on both apps; @ace (Dohun) is `owner` on
  each, verified through the public board. ⚠️ `OWNER_USER_ID` is NOT set explicitly on
  either app, so ownership still depends on list ORDER — `server/index.ts:249` falls back to
  `ADMIN_LIST[0]`, and `ADMIN_IDS` is built ONLY from `ADMIN_USER_IDS`, so naming an owner
  who is not in that list gives them the badge and no access.
- Untracked debris: `scripts/zz-probe-*`, `scripts/zzprobe_*`, `scratch_penalties_backup.ts`.
- Still open: two-account cross-region challenge check, an end-to-end practice upload from a
  signed-in account, Rapier slice 2 (balls), the DECODE penalty HITBOX audit, CR `APPROX`
  constants.

---

# HANDOFF — 2026-09-06g (a seven-slice UI audit: consistency + anti-AI-slop)

Branch **alpha**. `npm test` **ALL PASS (1286)** · `npm run contrast` 221 · `npm run build` ·
`npm run server:check` green. `SIM_VERSION` untouched at **2**.
⚠️ **NOT client-only: `src/sim/penalties.ts`, `src/sim/match.ts` and
`src/games/chain/penalties.ts` carry user-visible strings that changed, so the Fly server
needs a redeploy for the foul lines and the event log to match the client.**

## Previously

Seven subagents audited every user-visible string and both stylesheets, one slice each,
report-only; the rulings and the application were done centrally so the seven could not
contradict each other. The house rules they settled are now written down in CLAUDE.md
under **UI COPY** — read those before touching copy, because the two arguments that keep
recurring (dash style, failure-message shape) are decided there with the counts.

### The one ruling worth arguing with

The hyphen-vs-em-dash split was **50/50** app-wide, so it was drift, not a convention. The
tempting fix — normalise everything to `—` — is wrong for a brief that is explicitly
anti-slop, because a dash-joined appositive is the most-cited tell of machine-written
prose. Almost every one of them was two sentences. So: **full stop or colon by default,
`—` only where a dash is genuinely the right mark.** That reduces the count of BOTH glyphs.

An `Admin.tsx` comment claimed "Hyphen, not an em dash, per main's site-wide copy pass."
There is no such pass: `7a1c112` ("Polish controls and legal/footer UI copy") touched
control cards, the footer and legal casing and changed no dashes at all. The comment is
corrected.

### Real bugs the audit turned up (not copy)

- **`--ds-font` is used 13 times in `shell.css` and defined nowhere.** In a `font:`
  shorthand that is invalid at computed-value time, so the whole declaration is dropped:
  `.ds-gauge-num`, `.ds-standing-name`, `.ds-report-h` and ten others were setting no
  weight, size or line-height at all. Fixed to `--ds-font-ui`; verified in the browser that
  they now compute to 750/26px, 750/17px and 800/15px in Plus Jakarta Sans. **This is a
  visible change** — those rules start applying.
- **`.ds-dl` was declared twice** for the replay export menu and the download page, so the
  later rule turned the export menu into an 18px-gap column. Download page is `.ds-dlpage`;
  verified `.ds-dl` now computes `inline-flex / flex-end / 90px`.
- **`--accent` is defined nowhere**, so `var(--accent, #6ea8ff)` always used the literal —
  a pre-redesign blue on a themed HUD chip.
- **`.ping-graph` was the one HUD surface still hardcoded dark** (`rgba(20,24,30,.94)` +
  `--ds-line`) while its thirteen siblings use `--ds-hud`/`--ds-hud-line`.
- **`prefers-reduced-motion` capped duration but not iteration count**, so five infinite
  animations kept looping at 0.01ms each.
- **`AdminReports`' "Mark reviewed" is the punishment button.** It posts `status=reviewed`,
  which `server/index.ts:727` turns into `chargeStanding(target,'reportUpheld')`: 25
  standing, a ranked lock of 2 hours to 7 days, and 20-80 rating — while "Dismiss" beside
  it deliberately does nothing. It said "Mark reviewed", with no confirm. Now **Uphold (n)**
  with a confirm naming the charge. The three-rung SMITE got a confirm too; −100 is a
  player's entire standing.
- **`Matchmaking` rendered "That is your 3th in 24 hours."**
- **`InviteFlyout` passes `format: null`**, so an invite from a Duo Record room reaches the
  friend as "wants to play · Casual 1v1". **NOT FIXED** — needs a decision about what a
  room's format actually resolves to; it is a behaviour change, not a copy fix.

### ⚠️ STILL BROKEN, deliberately left alone

**The misscore queue's WATCH button can never work.** `AdminReports:288` calls
`onWatchReplay(r.matchId)`, but `matchId` comes from `score_reports.match_id references
matches(id)`, and the viewer looks up `replays where id = $1`. They are different id
spaces — `matches.replay_id` is its own column, which `MatchHistory` uses correctly. The
fix is server-side (project `replay_id` in `listScoreReports`) and needs a deploy, so it is
a separate change rather than something to bury in a copy pass. The button is relabelled
but still misfires.

### Also reported and NOT applied

Each is a judgement call rather than a defect, and they are listed with line numbers in
`audit-*.md` (scratchpad):

- **"Rated 1v1" vs "Ranked 2v2"** sit adjacent in the challenge picker for one concept
  (both are ELO). They ARE different formats — a closed party vs a premade in the open
  pool — so collapsing the words is a product decision, not a copy fix. ("Team up" →
  "Casual" WAS applied: that one was a second name for a format `formatLabel` already
  names.)
- Deleting the dead `.server-picker/.server-list/.server-row/.ping-dot*` families (~77
  lines) also orphans four pairs in `contrast.mjs`, so the audit count moves. Coupled
  change, left for a deliberate one. NOTE `.server-notice*` IS live — do not sweep the
  whole prefix.
- The six palette tokens with no call sites are still audited by `contrast.mjs`.
- 20 interactive elements have `:hover` and no `:focus-visible` (`.game-btn`,
  `.overlay-buttons button`, `button.ds-key` — the keybinding capture control, which is a
  keyboard-only flow). Only `.ds-dl-opt` was fixed here.
- `RobotPreview`'s `aria-label` reads raw enums to screen readers ("twinturret scorer").
- `RobotPreview`'s entire `chain` branch is dead, and is where the only read of the
  deprecated `spec.shooterRear` lives, against CLAUDE.md's "never read them".
- The snap tooltip is byte-identical in both start editors and is factually WRONG in CR,
  where snapping is live during the drag rather than on release.
- `PracticeReplays` uses a `num` class defined nowhere in the CSS (5 sites), so its score
  and length columns render in body type while every other score column is mono/tabular.

## Next steps

- **Deploy** — `./scripts/fly-deploy.sh --alpha`. Still outstanding from before this
  session too: alpha has not been redeployed since `0baeaa7`.
- The two `fly secrets set` admin lines are **still outstanding** (blocked for me):
  - `fly secrets set -a dohun-sim-decode ADMIN_USER_IDS='e3d73282-ac91-4940-bd5c-4778ca34212c,0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
  - `fly secrets set -a dsim-alpha ADMIN_USER_IDS='0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
- Untracked debris: `scripts/zz-probe-*`, `scripts/zzprobe_*`, `scratch_penalties_backup.ts`.
- Still open: two-account cross-region challenge check, an end-to-end practice upload from a
  signed-in account, Rapier slice 2 (balls), the DECODE penalty HITBOX audit, CR `APPROX`
  constants.

---

# HANDOFF — 2026-09-06f (the save reports itself honestly and stops reflowing the viewer)

Branch **alpha**. `npm test` **ALL PASS** · `npm run contrast` 221 · `npm run build` ·
`npm run server:check` green. Client-only. `SIM_VERSION` untouched at **2**.

## Previously

Three follow-ups on the background save, all reported together and all separate causes.

### "at 100% it doesn't show the save popup right away"

Two things, and the second was much bigger than I expected.

The readout ROUNDED UP: `Math.round` hits 100% while the last ~0.5% of frames are still going,
so the bar claimed to be done before it was. It floors now, caps at 99, and the frame loop only
owns `ENCODE_SHARE` (0.94) of the bar because the flush, the muxer and handing the browser a
multi-megabyte blob all come after it. Past that point the label reads **Finishing**.

Then the real one: the encoder queue was UNBOUNDED. The loop yielded once per frame when the
queue got deep, which never actually drains it, so the submit loop raced ahead and everything
left over was paid for in `flush()` — **measured, 3.6s of a 5.8s save**, all of it after the
bar had stopped moving. Waiting until the queue is under `MAX_QUEUE` puts that cost back inside
the loop where it is reported. The tail is now ~0.8s and the total is 7.0s for the same clip:
slightly longer overall, and the dead stretch at the end is gone. It also bounds memory, which
an unbounded queue of encoded frames does not.

### The field got squished while saving

The progress strip was its own row above the transport row, so it stole height from the canvas,
which re-fitted to a shorter box mid-recording. The strip now lives in the HEADER, replacing
the title: that row is already there and its height comes from the buttons in it, so nothing
below it moves. Measured across a whole save: header 64px, canvas box 545px, canvas backing
1280×545, all constant. **A background job must not reflow the thing it is running behind.**

### The replay jittered

Two sources, both addressed:

- the capture yielded only when its own queue was deep, so it could hold the main thread for
  long synchronous stretches and `requestAnimationFrame` cannot run inside one. It now yields
  on a TIME budget (`SLICE_MS` 8), leaving roughly half of each frame to the page.
- the playback loop accumulated unpayable debt: `n < 8` caps the steps per frame but the
  arrears keep growing, so a late frame makes the next one later. That is the classic spiral
  and it looks like judder, not like slowness. The accumulator is clamped to a few ticks, so a
  loaded machine runs the replay a hair slow instead of lurching.

⚠️ **I could not measure the smoothness itself.** The browser pane reports `document.hidden`,
which throttles `requestAnimationFrame` to 1 Hz, so frame gaps are meaningless there — and a
MessageChannel ticker fast enough to sample main-thread stalls starves the encoder it is
measuring (the same 7s save took 35.6s with the probe running). Both fixes are sound by
construction and the stall is bounded by `SLICE_MS`, but the "does it still stutter" question
needs a real visible tab.

### Copy

The menu, recording notes and refusal messages were rewritten short in the previous commit;
nothing further here.

## Next steps

- Client-only, so Vercel picks it up. **Still pending:** alpha has not been redeployed since
  `0baeaa7` ("a pin no longer needs a wall"), which IS sim code the server runs.
- The two `fly secrets set` admin lines are **still outstanding** — `flyctl secrets set` is
  blocked for me:
  - `fly secrets set -a dohun-sim-decode ADMIN_USER_IDS='e3d73282-ac91-4940-bd5c-4778ca34212c,0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
  - `fly secrets set -a dsim-alpha ADMIN_USER_IDS='0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
- Untracked debris: `scripts/zz-probe-*`, `scripts/zzprobe_*`, `scratch_penalties_backup.ts`.
- Still open: two-account cross-region challenge check, an end-to-end practice upload from a
  signed-in account, Rapier slice 2 (balls), the DECODE penalty HITBOX audit, CR `APPROX`
  constants.

---

# HANDOFF — 2026-09-06e (the save runs in the background; MP4 is the default everywhere)

Branch **alpha**. `npm test` **ALL PASS** · `npm run contrast` 221 · `npm run build` ·
`npm run server:check` green. Client-only. `SIM_VERSION` untouched at **2**.

## Previously

Four asks, all in the replay export.

### The scoreboard no longer covers the field

The camera reserves a bottom band, but that is not a promise: `HUD_BOTTOM` collapses to 4px on
a short or touch layout, and the field is centred in whatever is left, so how much clear space
sits under it depends entirely on the viewer's aspect ratio. On a tall window there was room;
on a short one the bar sat on the match.

The capture now asks `fieldScreenBottom` where the field actually ENDS and gives the FRAME
`HUD_RESERVE` more height when there is not already room. Measured: a 1000×295 viewer exports
1920×676 where the unreserved frame would have been 1920×566, and the field is fully clear in
both. Growing the frame is the right move and sliding the bar onto the field is not — extra
letterbox costs nothing. The countdown centres on `fieldHeight` rather than the frame, or it
drifts toward the bar whenever the frame is extended.

### MP4 is the default, on every platform

`availableVideoFormats` preserves the table's order and the top entry is what people take, so
if that entry varies by browser then so does everybody's archive. MP4/H.264 is the one format
every platform can both produce and play, so it leads. VP9 and VP8 stay for the people who
want them, but a phone or a video editor is where these end up, and neither WebM belongs at the
top for that.

### The save runs in the background

Owning its own player, renderer and canvas means the fast path has nothing on screen to
disturb — so there was never a reason to lock playback, and now it does not. The match keeps
playing, seeking and pausing while the file encodes, with a slim progress strip above a
transport row that stays live. Verified mid-save: transport row present, seek enabled, Pause
showing, playback advanced to tick 203, strip reading "SAVING MP4 · H.264 | 98% | Cancel".

Only the REAL-TIME fallback still takes the screen, and it has to: it films the visible canvas
through `captureStream`, so scrubbing mid-record would scrub the file. Two consequences worth
keeping straight — the re-fit effect skips while `recorder.current` is live, and a finished
fast save does NOT `rebuild()`, because restarting the match under someone who is watching it
is the one thing a background job must not do.

### Plainer copy

The download menu, the recording notes and the five refusal messages were rewritten short. They
had drifted into explaining themselves at length, in a register that reads as machine-written:
"Sharpest for the file size", "re-playable in DSIM at full fidelity", "which is why it can be
saved now". The information survives; the essay does not. Code comments were left alone — that
voice is the house style the rest of this file is written in.

## Next steps

- Client-only, so Vercel picks it up. **Still pending:** alpha has not been redeployed since
  `0baeaa7` ("a pin no longer needs a wall"), which IS sim code the server runs.
- The two `fly secrets set` admin lines are **still outstanding** — `flyctl secrets set` is
  blocked for me:
  - `fly secrets set -a dohun-sim-decode ADMIN_USER_IDS='e3d73282-ac91-4940-bd5c-4778ca34212c,0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
  - `fly secrets set -a dsim-alpha ADMIN_USER_IDS='0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
- Untracked debris: `scripts/zz-probe-*`, `scripts/zzprobe_*`, `scratch_penalties_backup.ts`.
- Still open: two-account cross-region challenge check, an end-to-end practice upload from a
  signed-in account, Rapier slice 2 (balls), the DECODE penalty HITBOX audit, CR `APPROX`
  constants.

---

# HANDOFF — 2026-09-06d (the capture stops fighting the viewer for the canvas; the video gets a scoreboard)

Branch **alpha**. `npm test` **ALL PASS** · `npm run build` · `npm run server:check` green.
Client-only. `SIM_VERSION` untouched at **2**.

## Previously

**I broke this in 2026-09-06c and the report was exact: "the field became smaller when I
started recording, and the final recording file also has a small field. Additionally, the
quality is still horrible."** One cause for all three.

The capture resized the VISIBLE canvas to the encode size. That put it in a tug-of-war it can
only lose:

1. the click sets `recording`;
2. React swaps the transport row for the taller recording bar, so the canvas's BOX shrinks;
3. the re-fit effect I had just added fires and resets the backing store to that box —
   **mid-capture**;
4. the encoder was configured ONCE, at 1920×818, so every frame after that is a ~1280×430
   canvas scaled up into the same file.

Hence a field that visibly shrinks the moment recording starts, a file with a small field, and
quality no better than before. **The capture now owns a detached canvas nobody else can
touch**, which removes the class rather than the instance. The viewer's own canvas is still
re-fitted when `recording` flips (the recording bar really is a different height), and that
effect now skips while a real-time capture is filming it.

Verified by measuring the FILE's pixels, which is what I should have done the first time —
last session I checked the output's dimensions and duration and both were right while the
content was wrong. Decoding frame 600 and scoring it against the scene re-rendered at 1920:
**41.2 dB**, against 35.5 dB for the old path. The visible canvas now reads 1280×516 in a
1280×516 box throughout the recording and 1280×545 after it.

### The video has a scoreboard now

Asked for mid-session: a live score, a final score, and the match-start lead-in. The viewer's
scoreboard is React DOM sitting ABOVE the canvas, so a canvas capture never had any of it —
which is invisible on screen, where the page supplies the other half, and leaves a file nobody
can read. `src/ui/replayOverlay.ts` draws:

- the live bar, red | phase + clock | blue, in the bands `camera.ts` already reserves so it
  cannot cover the field;
- **MATCH BEGINS IN** and the counting digit, off the sim's own `match.preCountdown`, so a
  replay reproduces the real lead-in rather than approximating it;
- END GAME split out of teleop on the same 20s the live HUD uses;
- a FINAL frame naming the winner, with a tie saying so.

⚠️ **It sets its own transform.** `Renderer.render` leaves the context in FIELD INCHES, so the
first version drew its scoreboard off in the field's coordinate space and produced a video with
nothing on it at all — the encode was fine, the overlay was simply somewhere else. It works in
CSS units, which is also what keeps the bar the same size relative to the field at every encode
resolution.

The words are `hudLabels`, deliberately split out of the drawing so they can be checked without
a canvas: four new checks cover the endgame split, the ceiling clock (a flooring one reads 0:00
for the whole last second of every phase), the tie, and a solo run having no winner.

### Measured end state

Through the real `ReplayView`, 15s of match, 1920×818, correct duration, scoreboard burned in:

| format | encode | size |
|---|---|---|
| WebM · VP9 | 3.0s (5×) | 2.56 MB |
| MP4 · H.264 | 3.0s (5×) | 1.49 MB |

### Note to self

The browser pane reports a **zero-height viewport when it is not displayed**, which collapses
every element to 0×0 — the capture then hits `recordFast`'s size guard and quietly downloads
the JSON instead. `resize_window` with an explicit size restores layout without needing the
pane in front. Two verification rounds went sideways on this before I noticed.

## Next steps

- Client-only, so Vercel picks it up. **Still pending from before:** alpha has not been
  redeployed since `0baeaa7` ("a pin no longer needs a wall"), which IS sim code the server
  runs.
- The two `fly secrets set` admin lines are **still outstanding** — `flyctl secrets set` is
  blocked for me, so they have to be run by hand:
  - `fly secrets set -a dohun-sim-decode ADMIN_USER_IDS='e3d73282-ac91-4940-bd5c-4778ca34212c,0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
  - `fly secrets set -a dsim-alpha ADMIN_USER_IDS='0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
- Untracked debris: `scripts/zz-probe-*`, `scripts/zzprobe_*`, `scratch_penalties_backup.ts`.
- Still open: two-account cross-region challenge check, an end-to-end practice upload from a
  signed-in account, Rapier slice 2 (balls), the DECODE penalty HITBOX audit, CR `APPROX`
  constants.

---

# HANDOFF — 2026-09-06c (replay video: MP4 stops being slow, and the quality problem was resolution)

Branch **alpha**. `npm test` **ALL PASS** · `npm run build` · `npm run server:check` green.
Client-only — no sim, no server, no migration. `SIM_VERSION` untouched at **2**.

## Previously

Two complaints, and they turned out to have one cause between them and one cause apart.

### "MP4 downloads are way too slow" — it had no CONTAINER, not a slow encoder

MP4 was the last format still going through `MediaRecorder`, which cannot beat real time (it
stamps frames by when they ARRIVE, not by the stamp the frame carries), so a 2:42 match took
2:42 to save. The reason it was still there was stated as "muxing H.264 is a second CONTAINER,
not a second encoder" — true, and the answer was simply to write the container.

`src/ui/mp4.ts` is that: a minimal ISO-BMFF muxer, one H.264 track, no fragments, no audio, the
twin of `webm.ts`. **MP4 now encodes at exactly the same 5× as WebM** — measured through the
real `ReplayView`, 15s of match in 3.0s, in all three formats, each reading back at the right
duration and decoding.

Two things in that file are easy to get wrong and silent when you do, so they are asserted
headlessly in `npm test` (the muxer is pure — it needs no browser even though the encoder
feeding it does):

- `stco` holds ABSOLUTE FILE OFFSETS, so `moov` cannot be written until its own length is
  known. It is built TWICE — measure, then write — which is safe only because the offset is a
  fixed-width field. Off by one byte and you get a file that opens, reports the right duration
  and decodes garbage.
- Chunks arrive in DECODE order. Today's browser encoders emit no B-frames, but writing the
  file as though none could is a different claim, so `ctts` is emitted when (and only when)
  presentation and decode order actually differ.

### "video quality for the two webms is horrible" — it was RESOLUTION, and I nearly fixed the wrong thing

The obvious suspects were the rate control and the `latencyMode: 'realtime'` that shipped. I
built a bench that encodes the same 7s of real match and scores each result as PSNR against the
scene re-rendered at 1920. Both suspects are nearly irrelevant:

| | bitrate | PSNR |
|---|---|---|
| **old path** (render 2496×1074 → `drawImage` to 1280, realtime) | 1.84 Mbps | **35.5 dB** |
| 1920 native, quantizer 34 | 1.52 Mbps | 42.25 dB |
| 1920 native, quantizer 22 | 1.88 Mbps | 42.40 dB |
| 1920 native, quantizer 10 | 2.47 Mbps | 42.55 dB |

**Nearly seven dB, all of it from drawing the frame at the size it is encoded at.** Sweeping
the quantizer across its whole useful range moves 0.3 dB and 1.6× the file size. (The ~42.5 dB
ceiling is 4:2:0 chroma subsampling; no encoder setting buys it back.) A >2× canvas downscale
is a cheap bilinear filter and it lands on exactly the thin tape lines and the small scoreboard
type.

So `encodeSize` is now a RENDER size, not a downsample target: the capture retargets
`camera.dpr` and draws straight into a canvas of that size. `MAX_EDGE` is 1920 — the same
encoder that accepted 1920 for H.264 refused 2496.

⚠️ **Three things I got wrong on the way, all worth keeping:**

1. **`encodeSize` clamped the scale at 1×**, so on a 1280-wide window it produced a 1280-wide
   video — precisely the resolution being blamed. It has to scale UP to the target too. Caught
   only because I checked the output dimensions of a real download rather than assuming.
2. **The quantizer option is CODEC-SCOPED** — `{ vp9: { quantizer } }`, not `{ quantizer }`. A
   flat one is accepted silently and ignored, which reads exactly like an encoder that does not
   honour the setting. It cost a whole measurement round; the giveaway was three identical file
   sizes across a q sweep.
3. **The canvas was left stale after a capture** (drawing a 1280×516 field into a 1280×545 box,
   stretched 5%). Two causes, neither of which fires a window resize: the capture leaves the
   backing store at the video's resolution, and the recording bar replaces the transport row at
   a different height. Re-fitted in an effect on `recording` — NOT a per-frame check, which
   would force a layout flush 60 times a second for something that changes twice a match.

Also: `availableVideoFormats` is now **async**, because the honest question is not "is there a
`VideoEncoder`" but "will it take this codec at this size" — and that is what decides whether
MP4 saves in seconds or has to be filmed, which the menu states. `videoFormat(id)` still
answers synchronously off the static table, because the download filename is built from
`fmt.ext` before the probe lands. The menu's cost label is computed from the match length now
instead of a hardcoded "~10s" that was a lie about anything longer than the clip it was
written against.

### Measured end state

Through the real `ReplayView`, 15s of match, all at 1920×818 and correct duration:

| format | encode | size |
|---|---|---|
| WebM · VP9 | 3.0s (5×) | 2.5 MB |
| WebM · VP8 | 3.0s (5×) | 4.0 MB |
| MP4 · H.264 | 3.0s (5×) | 1.45 MB |

## Next steps

- **Nothing here needs a deploy** — it is all client-side, so Vercel picks it up. The pending
  server work from the previous session still stands: alpha has not been redeployed since
  `0baeaa7` ("a pin no longer needs a wall"), which IS sim code the server runs.
- The two `fly secrets set` admin lines are **still outstanding** — `flyctl secrets set` is
  blocked for me by the permission classifier, so they have to be run by hand:
  - `fly secrets set -a dohun-sim-decode ADMIN_USER_IDS='e3d73282-ac91-4940-bd5c-4778ca34212c,0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
  - `fly secrets set -a dsim-alpha ADMIN_USER_IDS='0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'`
- Untracked debris still in the tree: `scripts/zz-probe-*`, `scripts/zzprobe_*`,
  `scratch_penalties_backup.ts`.
- Still open from earlier: two-account cross-region challenge check, an end-to-end practice
  upload from a signed-in account, Rapier slice 2 (balls), the DECODE penalty HITBOX audit,
  CR `APPROX` constants.

---

# HANDOFF — 2026-09-06b (the pusher stops steering itself; pins stop needing a struggle)

Branch **alpha**, pushed + deployed. `npm test` **1272, ALL PASS** · build · `server:check` green.
`SIM_VERSION` stays **2** (alpha is ONE unreleased batch past main; both changes are inside it).

## Previously

**"I turn with them and follow them" was literally true, and it was the SETTLING term.**
`squareUpPair` turns BOTH chassis flush to the SHARED contact normal. The normal belongs to the
PAIR, so a turning victim rotated it and the pusher was turned to keep up. Measured: a pusher
commanding nothing but straight forward copied its victim's heading at **102-110%** and rode it
72in across the field still touching.

Fix is the one `CONTACT_PAIR_SPIN`'s own note already named — "a contact that can slip". The
settling `align` is scaled by `1 / (1 + slip / CONTACT_SLIP_RELIEF)`, slip measured at the
contact point WITH ω×r (a pivoting chassis slips without either centre moving). The two cases
are nowhere near each other, which is why this works cleanly:

| pair state | slip | settling |
|---|---|---|
| held / idle (settling SHOULD work) | **0.0 in/s** | untouched |
| victim strafing off | 5.7 avg | faded |
| victim turning + strafing | 9.6 avg (peak 36.6) | faded |

Tracking **105% → 21%**. ω×r is safe HERE and not in `press` because it enters as a MAGNITUDE
that only attenuates — no sign to flip, so it cannot cause the documented limit cycle.

**G422 no longer needs the victim to be struggling.** Reading "attempting to move" as "the
stick is deflected this tick" is what kept the foul rare — people held against a wall stop
working the stick long before they stop being held, and a ref cannot see a stick. The guard
that REPLACES it is on the pinner (`PIN_PRESS_COS`): it must be driving INTO the victim, since
`rrContacts` is overlap-only and says nothing about who holds whom. Idle victim **0 → 3 MINORs
/ 12 s**; an idle opponent, one strafing past, and a self-trapping victim all still draw 0.
⚠️ This is a deliberate DEVIATION from the rule text, like `POSSESSION_REBILL_S`.

## Gotchas

- One existing check asserted the OPPOSITE ("a victim commanding nothing at all is not being
  pinned"). Rewritten, with the pinner-side guards added beside it — do not "restore" it.
- Still true from 06a: **a tank pusher given only `driveY` does not move** (it reads the side
  sticks), which silently turns "held against a wall" into "standing near a wall".

## Next steps

1. Drive it and see whether the pusher still feels sticky — `CONTACT_SLIP_RELIEF` (4) is the
   dial; LOWER lets go sooner. A pure pivot still drags the pusher ~88%, which is arguably real
   but is the next thing to look at if it feels wrong.
2. The into-wall escape cliff from 06a is untouched and is Coulomb stick/slip, not a bug.
3. Still open: the two `fly secrets set` admin lines, the two-account cross-region challenge
   check, an end-to-end practice upload, Rapier slice 2, penalty HITBOX audit, CR `APPROX`.

---

## HANDOFF — 2026-09-06a (G422 wall pin + what the push measurements actually say)

Branch **alpha**, pushed. `npm test` **1269, ALL PASS** · build · `server:check` green.
`SIM_VERSION` stays **2** on purpose (see its note: alpha is ONE unreleased batch past main).

## READ FIRST

**Two reported claims, both measured on BOTH branches rather than reasoned about.**

1. *"a pushed robot cannot escape, even strafing"* — TRUE on main, largely FIXED on alpha by
   the shove rework. Equal chassis, victim against a wall, pure strafe for 6 s:
   **main 6.8in → alpha 37.2in**. What remains on alpha is real Coulomb stick/slip: the
   victim's OWN into-wall command adds to the normal force, so escape collapses
   **37in (0 forward) → 23.6in (0.1) → 1.9in (0.2) → 0in (1.0)**. Lowering wall friction only
   MOVES that threshold (swept 0.5/0.3/0.15/0.05), it does not remove it. Left alone — pressing
   yourself into the wall making it worse is honest; tell me if it should be softened.
2. *"pinning penalties almost never fire"* — TRUE, and alpha was WORSE THAN MAIN. Fixed.

**The G422 bug: the obstruction test only understood a straight reverse.** It asked whether the
PINNER lay along where the victim was trying to go — true of reversing, false of every SIDEWAYS
exit. Every existing test had the victim reverse, so nothing caught it. A victim held flat on
the wall and strafing billed **0** where main billed **1**. It now tests the VICTIM'S intent
(`PIN_INTO_TRAP_COS`): the only excluded case is driving further INTO the trap, which is the
self-pinning scene the original test existed for (that check still passes). Success is then
measured by `PIN_STUCK_SPEED` + criteria A/B — prevention is an outcome, not a stick direction.
After: heavy tank holding a victim on the wall **6 MINORs / 20 s**; weak x-drive it strafes
clear of **2**.

## Gotchas hit (both cost real time)

- **A TANK PUSHER GIVEN ONLY `driveY` DOES NOT MOVE.** Tank reads `leftDrive`/`rightDrive`
  only, so half my first probe measured a victim nobody was holding and reported a free
  escape. Any pin/push scene with a tank must drive the side sticks.
- **`git worktree remove --force` FOLLOWED A DIRECTORY JUNCTION** I had made inside the
  worktree to share `node_modules`, and emptied the real one. Recovered with `npm ci` (no
  lockfile churn). Do not junction node_modules into a worktree you intend to remove.
- `PHYS_FRICTION` is NOT the walls — `statics()` never called `setFriction`, so walls ran on
  Rapier's default 0.5 (effective 0.6 by the AVERAGE combine rule) while the constant's comment
  claimed it covered them. Now stated as `PHYS_WALL_FRICTION` at the same value; verified a
  no-op by the full suite.

## Next steps

1. Decide whether the into-wall escape cliff should be softened — it is a balance call, and the
   lever is `PHYS_WALL_FRICTION` (moves the threshold) not a bug fix.
2. Still open: the two `fly secrets set` admin lines, the two-account cross-region challenge
   check, an end-to-end practice upload from a signed-in account, Rapier slice 2, the penalty
   HITBOX audit, CR `APPROX` values.

---

## HANDOFF — 2026-09-05b (solo practice runs are kept and rewatchable)

Branch **alpha**, at `1cc016d`, pushed. `npm test` **1264, ALL PASS** · `npm run dbtest` ALL PASS
(+9 practice checks) · `npm run build` · `npm run server:check` · `npm run contrast` 221 ·
`npm run test:mm` 58 — all green. `SIM_VERSION` stays **2**, `BALANCE_VERSION` stays 4.

Do not merge to main. Standing rule.

## READ FIRST

**"Solo practice" is the OFFLINE FULL MATCH (`mode: 'match'`, `session: null`), not Free
Drive.** I spent a whole round assuming Free Drive and asking questions about where an endless
session begins and ends. It is the `Solo Practice` tile in `ModeSelect`; Free Drive is the tile
next to it. Solo practice has a real end (`post`), which is why none of that mattered.

**It could not just be recorded.** `replay.ts` states the invariant: a run must be fully
SIM-DRIVEN (preCountdown → auto → … → post) so `{seed, setups, commands}` alone reproduce it.
Solo practice started from the CONTROLLER (`countdownStart` vs `world.time`, calling
`startMatch(world)` directly), so the tick auto began on depended on a keypress the container
cannot store — a recording would have diverged from tick 0. `startMatch()` now rebuilds the
world at tick 0 and sets `preCountdown`; the rebuild is invisible (`robotsEnabled` is false in
`pre`) and reuses the seed. Solo also steps on `localizeCommand(cmd)` now, since a replay
stores quantized commands.

## What landed (`1cc016d`)

- `src/game.ts` — sim-driven solo countdown, `ReplayRecorder` over `stepSolo`, finalize at
  `post` → `onPracticeRun`. `getPracticeRun()` is deliberately separate from `getMatchResult()`,
  which is documented as the SERVER's authoritative payload.
- `src/net/practiceRuns.ts` — localStorage ring (index + one body per run), cap 10, evicts and
  retries on quota. Works signed out.
- migration `0032_practice_runs.sql` + `savePracticeRun`/`listPracticeRuns`/`PRACTICE_KEEP`,
  `POST|GET /api/practice` (owner-only), `sanitizeReplay` on ingress.
- `src/ui/PracticeReplays.tsx` in Career (self-only, via `Stats`' `head` slot like
  `StandingCard`), ▶ WATCH REPLAY on the solo results screen.

## Verified

Headless: 4 new smoke checks pin that the sim-driven shape reproduces (world hash AND match
clock) and that the old controller-driven shape does NOT. 9 dbtest checks pin the prune, the
orphaned-replay cleanup, account deletion, and — the load-bearing one — that a practice run
never appears on the record leaderboard.

In-browser: drove `GameController` directly (the pane starves rAF, so a real 2:30 match will
not run there) — `startMatch` opens the recorder at tick 0, reaching `post` yields a replay,
the local save lands in localStorage, Career lists it, and ▶ Watch opens the viewer.

## Gotchas hit

- **Two ways to write a VACUOUS replay check**, both hit here: `DEFAULT_ASSISTS.fieldCentric`
  is TRUE so a steer-and-drive-forward scene parks in a corner and any two runs then agree; and
  `worldHash` does NOT cover `match.phase`/`phaseTimeLeft`, so runs that started 200 ticks
  apart hash the same. Assert movement + score, and compare the clock.
- The Browser pane starves `requestAnimationFrame` when it is not painting — `world.tick` sat
  at 0 and it looked exactly like a bug in the countdown change. A screenshot forces one burst
  of frames; `document.visibilityState` still reads "visible", so that is not the tell.
- Synthetic `KeyboardEvent`s do not reach `InputManager`; use `computer` `key`.

## Next steps

1. Confirm an upload end-to-end once alpha is redeployed (the route + 0032 shipped with this;
   deploy was started at the end of this session — verify `/api/practice` returns 401 signed
   out rather than 404).
2. Still open: the two `fly secrets set` admin lines from the previous section, the two-account
   cross-region challenge check, Rapier slice 2, the penalty HITBOX audit, CR `APPROX` values.
3. The `scripts/zz-probe-*` files and `scratch_penalties_backup.ts` are untracked G408 debris.

---

## HANDOFF — 2026-09-05 (replay downloads + the cross-region room split)

Branch **alpha**, at `b52fca0`, pushed. `npm test` **1260 checks, ALL PASS** · `npm run build`
green · `npm run server:check` green · `npm run contrast` 221 green · `npm run dbtest` **green
again** (it had been red — see below). `SIM_VERSION` stays **2**; `BALANCE_VERSION` stays 4.

Do not merge to main. Standing rule.

## READ FIRST

**"Replay unavailable" on the deployed alpha server was a MISSING DEPLOY, not a code bug.**
`dsim-alpha` was last released **Aug 26** (v11) — before `8b046dc`, which added migration
`0031_replay_behaviour_version.sql`. So the live `getReplay` had no `behaviour_version` column
to read, could not populate `Replay.sim`, an absent `sim` read as 0, and every replay was
refused. Deployed via `./scripts/fly-deploy.sh --alpha`; `/api/replay/<id>` now returns 200 with
the column in the select, so 0031 ran. **A replay change is a SERVER change.**

**That fixes NEW runs only, and that is correct.** Every replay currently on the alpha board was
recorded at `BALANCE_VERSION` **3** (July–August, format 1, no `sim` stamp); alpha is on **4**
since `7ea642b` reworked the shove. Those stay refused because the balance really did change —
what changed is that the viewer now says so instead of "recorded on an older version of the sim
(Season 3)". Runs recorded from now on stamp `bv 4 / sim 2` and play and download normally.

## OPEN — the admin change could not be applied

The user asked to drop **baron** as an admin and add **`5baefc21-e1e8-43b0-9278-4af2ea150882`**
(solver / @featurescript) on both servers. `flyctl secrets set` is REFUSED by the Claude Code
auto-mode classifier, so this is still to do BY HAND:

```
fly secrets set -a dohun-sim-decode ADMIN_USER_IDS='e3d73282-ac91-4940-bd5c-4778ca34212c,0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'
fly secrets set -a dsim-alpha       ADMIN_USER_IDS='0c9c1654-c720-40f5-9352-1b0cde1c465a,5baefc21-e1e8-43b0-9278-4af2ea150882'
```

Resolved from the live lists (`fly ssh console -C "printenv ADMIN_USER_IDS"` + `/api/user/<id>`):
`e3d73282`=Fe/@felix, `0c9c1654`=Dohun Kim/@ace (owner), `a509c53d`=**baron** (dropped).
Baron was an admin on MAIN ONLY — alpha's list was just the owner, so alpha only gains solver.
`OWNER_USER_ID` is set explicitly on both, so list ORDER carries no meaning here.

Two things to check afterwards: `syncStaffRoles` runs once per boot and the sweep is SYMMETRIC,
so a restart is what actually strips baron's badge and perks — confirm with
`/api/user/a509c53d-dc89-4dae-99de-2c6e30e537d9` returning no `role`. And a secrets set restarts
machines, which on MAIN can re-apply fly.toml's single `[[vm]]` to every one of them; sizes
before the change were **iad shared-4x/1024, lhr+sjc+syd+nrt shared-1x/1024**, so re-shrink with
`scripts/fly-deploy.sh`'s satellite loop if `fly machine list -a dohun-sim-decode` disagrees.
There were 7 players online (1 queued) when this was attempted; `scripts/announce-deploy.sh`
needs an `ADMIN_SECRET` this session is not allowed to read.

## What landed

- **`replayRefusal`** (`src/sim/replay.ts`) names WHICH refusal: `future` (they are behind —
  refresh) · `balance` · `behaviour` · `unstamped` · `tank`. `replayPlayable` is `=== null` over
  it, so the yes/no policy is byte-identical — `unstamped` is a MESSAGE split, the test stays
  `(r.sim ?? 0) !== simVersion`, and smoke pins that a build on SIM_VERSION 0 still accepts an
  unstamped log (which is what keeps the format-1 mecanum case playable).
  **The old copy was wrong three ways at once**: it printed `balanceVersion` as "Season N" (in
  `replays`, the SEASON is the `balance_version` COLUMN and that number is in `sim_version`), it
  called a FUTURE container old, and it asserted a specific mismatch for an unknown one.
- **The exports are a header MENU** (`.ds-dl`), not two ghost buttons in the transport row —
  they are actions on the replay, not on playback. Each option states its COST, which is the
  thing that decides between them: the video takes the full match in real time (the menu prints
  the actual figure), the JSON is instant and prints its size. No `MediaRecorder` ⇒ the video
  option renders DISABLED with a reason, instead of silently falling back.
- **Recording replaces the transport row** (`.ds-replay-rec`): red dot, progress bar, real time
  remaining, the "keep this tab in front" warning, Cancel. Locking four controls and showing
  "● REC 12%" did not explain why they were locked.
- **`npm run dbtest` was RED** and had been since the interim readable/exact design was reverted
  — `scripts/dbtest.ts` still called `replayReadable`, and because it is a dynamic
  `await import`, tsc never saw it. Now uses `replayPlayable`/`replayRefusal`, and the pre-0031
  row check asserts `unstamped` against a REAL row.

## Verified in the browser (pane, not Electron)

Stubbed `window.fetch` for `/api/replay/` with a container generated by `runRecordMatch` on this
build, then routed to `/decode/replay/<id>`. Menu + recording bar in **both themes**; outside
click and Escape close the menu; all four refusal texts render and the Download button is absent
on the stale screen; at **375×812** the popover is 339px with no horizontal overflow and the
recording bar wraps to three rows. Cancel discards and restores the transport row.

## Gotchas hit

- A Bash **heredoc** carrying the whole TSX truncated silently mid-file (CRLF terminator). Write
  the file with the Write tool and convert endings with python instead.
- `CLAUDE.md` and `scripts/smoke.ts` had drifted to **LF**; `core.autocrlf=true` normalizes on
  commit, but re-CRLF the working copy or every later diff warns.
- `git status --short --cached` is not a thing (`--cached` is a `diff` flag) and it aborted a
  chained commit — the commit silently did not run.

## Also landed — the cross-region room split (`a71af95`)

**Two friends on different servers who accepted the same challenge got two rooms with one
code.** A custom room code is BARE (a staged room is `iad-abc123`; a shared code carries
nothing), so a socket with no `?region=` hint lands on the machine nearest to the JOINER, which
has no such room and opens an empty one with the same code. Neither side is told.

The invite has carried the host's region since migration `0029` and `App.onJoinInvite` passed
it on. Two client paths dropped it:
- `InviteFlyout` — the accept button you use while ALREADY in the lobby — called
  `onJoinRoom(code)` with no region, so the join used our own server.
- `Lobby` read the region from a `useState` seeded at mount, and accepting from that flyout
  does not remount it, so a correct prop would not have been re-read either.
- ...and inviting a friend from inside a room stamped NO region on the invite (the 7th arg was
  simply omitted) — the same split from the other side.

Now `Lobby.join(code, hostRegion?)` takes it as an argument, `roomJoinRegion` (`src/net/
roomRegion.ts`, a leaf so smoke can import it — `env.ts` reads `import.meta.env` at load) is
the rule, and the auto-join guard keys on the CODE instead of a never-reset `useRef(false)`
that silently swallowed a second accept. 5 smoke checks. Server side needed nothing.

**Verified**: the URL builder returns `wss://…?region=lhr` for a host on lhr while our own pick
is iad, and creating a room still opens a real socket on the picker's region (live, dev pane).
**NOT verified end-to-end** — that needs two signed-in accounts on two regions. Existing invite
rows have `region` NULL and will still split, but `INVITE_TTL_S` is 10 min, so that clears
itself.

## Next steps

1. Apply the two `fly secrets set` lines above (see the OPEN section).
2. Confirm the challenge fix with two accounts on two different regions — the one link the
   dev-pane check cannot reach.
3. Watch for the first NEW alpha record run and confirm its replay plays + downloads end to end.
   That is the one link still only verified by `dbtest` and the 200 from `/api/replay`, not live.
4. The `scripts/zz-probe-*` files and `scratch_penalties_backup.ts` are untracked G408 debris
   from the previous session; delete when nothing else needs them.
5. Still open from before: Rapier slice 2 (balls), the DECODE penalty HITBOX audit (zone geometry
   vs the manual figures — G408 and G422 text are done), CR `APPROX` constants.

---

## HANDOFF — 2026-08-25 (the mouth carve-out vs the player's own assists) — alpha only

Branch **alpha**. `npm test` **1167 checks, ALL PASS** · `npm run build` green ·
`npm run server:check` green · `npm run test:mm` 58 green. `SIM_VERSION` 8 → **9**.

Do not merge to main. Standing rule.

## READ FIRST

**Every G408 scene in smoke used `DEFAULT_ASSISTS`. Real players use `PLAYER_ASSISTS`, which has
auto-intake AND auto-fire ON.** The rule behaved completely differently there, and that gap is
why four rounds of "still not getting the penalty" kept coming back negative.

Nine-clump herded in open space, identical push:

| assists | fouls | artifacts excused per tick |
|---|---|---|
| auto-intake OFF | **15** | 0 |
| auto-intake ON (the default) | **2** | **3** |

The mouth carve-out was bounded by hopper **ROOM**. Auto-fire keeps all three slots empty and
auto-intake keeps `intaking` true, so three artifacts were excused on every tick, forever — the
exact failure the constant's own doc comment warned about and believed `POSSESSION_ACQUIRE_S`
had fixed. It had not: that window is keyed on the herding clock, which barely advances in open
space, so the excused artifacts never aged out.

**Now capped at what the rollers take in one cycle** — one artifact, two for a triangle's twin
slots — which is what the exemption was ever meant to model.

## The honest remaining behaviour

A robot with auto-intake still controls FEWER artifacts than one without, because it is eating
the pile as it pushes. That is the count being truthful, not a bug. It is also exactly why the
perimeter is where players notice the rule at all: against a wall the artifacts pile up faster
than the intake can swallow them, so four or more stay in contact.

If open-space herding should bite harder for an intaking robot, the lever is NOT G408 — it is
that a robot pushing a clump in this sim also consumes it. Changing that is an intake/feel
change, not a penalty change.

## The whole chain of causes, for the record

Four rounds, four different faults, none of them the rule text:
1. the model was built on FRC definitions not in the DECODE manual (2026-08-25a);
2. it was too eager about artifacts already at a wall (2026-08-25b);
3. an artifact only counted on ticks it was touching, so steering killed it (2026-08-25c);
4. penalties did not run in Free Drive at all (2026-08-25d);
5. and the mouth carve-out was permanently open for anyone using the default assists (this one).

**Lesson: reproduce with the PLAYER'S configuration before tuning.** `DEFAULT_ASSISTS` is the
neutral sim/wire fallback; `PLAYER_ASSISTS` is what a person actually drives with, and the two
differ on auto-intake and auto-fire. A smoke suite written entirely against the former can be
green while the feature is dead in play.

---

## 2026-08-25d — penalties were OFF in Free Drive (superseded as READ FIRST)

Branch **alpha**. `npm test` **1166 checks, ALL PASS** · `npm run build` green ·
`npm run server:check` green · `npm run test:mm` 58 green. `SIM_VERSION` 7 → **8**.

Do not merge to main. Standing rule.

## READ FIRST — the actual answer to three rounds of "I'm not getting the penalty"

**The entire penalty engine was switched off in Free Drive.** `updatePenalties` returned early
for any phase that is not `auto` or `teleop`, and Free Drive runs in `freeplay`. Measured on an
identical six-clump herd:

| mode | phase | fouls |
|---|---|---|
| Free Drive | `freeplay` | **0** |
| Match | `teleop` | **13** |

`freeplay` is a live phase everywhere ELSE in the sim — `robotsEnabled` includes it, the human
player restocks in it, the shooter fires in it. Penalties were the one subsystem that excluded
it. So every round of G408 tuning was invisible to anyone practising in Free Drive, which is
exactly where you would go to practise pushing a clump around.

Now assessed in `freeplay` too. Phase-specific rules stay correctly inert on their own terms:
G402 tests `phase === 'auto'`, `endgame` tests `phase === 'teleop'`. CR is untouched —
`updateChainPenalties` gates on `isAuto`/`isTeleop` explicitly, which is right for G05/G06.

**Checked for spam**: 45 s of ordinary free driving with practice dummies drew 0 fouls on the
player. A passive dummy can never be PINNED either, since G422 needs the victim attempting to
move and a passive robot issues no command. The only event was a G426 against a dummy parked in
a loading zone, which is correct.

## Lesson for next time

Three sessions were spent tuning a rule that could not fire in the mode it was being tested in.
**Before tuning a sim rule, confirm the rule RUNS in the mode the report came from.** The
phase gate at the top of `updatePenalties` is the first thing to check, and `robotsEnabled`
(`src/sim/match.ts`) is the list of phases the rest of the sim considers live — any subsystem
whose phase list disagrees with it is a suspect.

---

## 2026-08-25c — making CONTROL reachable again (superseded as READ FIRST)

Branch **alpha**. `npm test` **1165 checks, ALL PASS** · `npm run build` green ·
`npm run server:check` green · `npm run test:mm` 58 green. `SIM_VERSION` 6 → **7**.

Do not merge to main. Standing rule.

## READ FIRST

The leniency pass below (2026-08-25b) went too far the other way: *"when I just push a clump in
open space it doesn't give me [the penalty]"*. Fixed, and the cause was not a threshold.

### An artifact only counted on the ticks it was TOUCHING

Artifacts do not RIDE a bumper in this sim — they bounce off it and are re-struck — so a herded
pile is in contact only intermittently. `held.add()` happened solely on touching ticks, so the
count collapsed to whatever was in the hopper between bounces. Measured, with a six-clump in
open space:

| driving | ticks controlling >3 | fouls |
|---|---|---|
| dead straight | 89% | 9 |
| gentle steer (±0.15) | **4%** | **0** |
| hard weave (±0.3 @2 Hz) | **0%** | **0** |

So the rule worked only if you drove perfectly straight. **An established hold now keeps
counting while it DRAINS**, so a re-struck artifact stays controlled between bounces; the drain
is what bounds it (an artifact stops counting a couple of confirm windows after the robot really
has left it, and one that never established has nothing to drain). `POSSESSION_CARRY_DIST` is
now sticky too — across re-stations and across the hold dying — because ground already covered
does not un-happen. `POSSESSION_CONFIRM` 0.8 → **0.65**.

Neither `POSSESSION_LEAK` nor `POSSESSION_CONFIRM` could fix this on their own; both were swept
(0.12–0.5 and 0.35–0.8) and the steering cases stayed at zero. It was never a threshold.

### Where the line sits now

Clean: nosing into an open clump however deep · driving into 5 artifacts already on the wall,
even leaning 20 s · nosing a 9-row at the wall at half throttle · collecting 3 with an empty
hopper · driving past artifacts strung along a lane · parked among artifacts.

Fouls: herding 5–6 across open floor straight, steering, or with the throttle wobbling ·
driving a pile INTO the wall and leaning · spinning a corralled pile · **ramming a 9-row at full
throttle and scattering it 40 in**.

That last pair is one boundary, and both sides are pinned in smoke: a half-throttle press
displaces the outer artifacts 33–39 in and draws NOTHING, because they squirt sideways out of
the squeeze rather than covering ground in the push direction; the full-throttle ram carries
four of them past the carry distance and costs three MINORs.

### Known limit

A robot WEAVING hard while pushing bats the clump apart and then genuinely controls only its own
three, so it draws nothing. That is the count being honest rather than the rule failing — but it
does mean a flailing robot is cheaper than a tidy one. If that ever matters, the fix is in the
ball–robot contact feel (how far a turning bumper flings artifacts), not in G408.

### Gotcha that cost time here

A `sed` on `cmd({ driveY: 1, intake })` matched an identical line inside an unrelated `gateHold`
helper and broke the suite at check 538. **`npm test` printing no FAIL is not proof it passed** —
it can die partway. Check the count, or the `ALL PASS` line at the end.

---

## 2026-08-25b — making CONTROL lenient about running into things (superseded as READ FIRST)

Branch **alpha**. `npm test` **1162 checks, ALL PASS** · `npm run build` green ·
`npm run server:check` green · `npm run test:mm` 58 green. `SIM_VERSION` 5 → **6**.

Do not merge to main. Standing rule.

## READ FIRST

The CONTROL rewrite below (2026-08-25a) was right about the definition and too eager in play.
Two false positives were reported and both are fixed:

* *"if you drive into a pile to intake, you get a penalty if you go in too far"*
* *"you get a penalty if you drive into five balls that are ALREADY at the wall"*

### The fix: "MOVING the SCORING ELEMENT" is a DISTANCE, and it is DIRECTIONAL

Clause B's verb is about the artifact, so it has to have actually gone somewhere. The new
`POSSESSION_CARRY_DIST` (5 in, one artifact diameter) accumulates per tick as
`max(0, b.vel · pushDir) * dt`, where `pushDir` is the direction the robot's contact point is
travelling.

**The projection is the whole trick.** A row already resting on the perimeter squirts SIDEWAYS
out of the squeeze — fast, but covering no ground in the direction the robot is driving it. A
herded pile covers it steadily. So running into things is free and taking them somewhere is not,
and a pile the robot DROVE to the wall still counts through the latch.

Two things that do NOT work, both measured before landing this:

* **an instantaneous speed floor** (what main used, and the obvious first try). Artifacts do not
  RIDE a bumper in this sim — they bounce off and are re-struck — so a jammed pile reads as
  moving quickly while going nowhere. At the ball's own rest threshold it still billed 6 MINORs
  for driving into a wall row.
* **undirected net travel.** A wall row scatters sideways plenty; only the projection separates
  it from a herd.

`POSSESSION_CONFIRM` also went 0.35 → 0.8 s. Contact plus a fifth of a second cannot tell
"taking these somewhere" from "arriving among them". Swept over the thirteen scenes in the probe,
**0.8 s with a 5 in carry is the only pair where every case comes out right** — 0.35 fouls the
intake cases, and a longer carry starts letting real herding through.

### Where the line now sits

| scene | fouls |
|---|---|
| nose into an open clump to intake, however deep | no |
| drive into 5 artifacts already on the wall, even leaning 20 s | no |
| nose into a 9-row on the wall with the intake held | no |
| parked among artifacts, never pushed | no |
| herd a 5- or 6-pile across open floor | **yes** |
| drive a pile INTO the wall and lean on it | **yes** (the latch) |
| corral a pile and spin in place | **yes** |
| RAM a wall row from 40 in away, scattering it | **yes** — see below |

That last one is a deliberate judgement call: it covers the carry distance in the push direction
because it really did move those artifacts 40 in. The line is displacement, not intent.

### Smoke scenes: two more were unsound

The `clump` helper parked unused artifacts at (900,900). Anything outside the perimeter is
dragged back in by the containment pass in world.ts, so they reappeared on the field and the
robot met them later — a THREE-artifact clump was drawing a foul off a stray. Unused artifacts
are now REMOVED from `world.balls`, and the squirting-ball scene clears the field too. Scene
durations are now derived from the gates (`acquireSecs`/`acquireTicks`) instead of hard-coded
from the old constants.

### Gotcha

`world.penalties` still has no `unslimWorld` backfill. `ballCarry` is therefore declared
**optional** and read through `??=`; a snapshot from an older server arrives without it and the
first index would otherwise throw. Any future `PenaltyState` field needs the same treatment.

---

## 2026-08-25a — what CONTROL actually is (superseded as READ FIRST)

Branch **alpha**, commit `9f8e633`, pushed. Working tree CLEAN (bar the untracked `zz-probe-*`
scratch scripts). `npm test` **1159 checks, ALL PASS** · `npm run build` green ·
`npm run server:check` green · `npm run test:mm` 58 green.
**Deployed to the alpha preview** (`dsim-alpha`, `deployment-01M0WAB0NBK0E3FQD9FWX8A59Q`,
1/1 checks, `/health` ok). Production untouched.

Do not merge to main. Standing rule.

## READ FIRST — where this session ended

G408 over-possession, rewritten from the manual's own text. `SIM_VERSION` 4 → **5**.
`BALANCE_VERSION` left at **4** (see *Open*).

### The finding: the engine was built on two definitions that are not in the DECODE manual

`controlledArtifacts` was written against an FRC-style **POSSESSION** ("as the ROBOT moves or
changes ORIENTATION ... the object remains in approximately the same position relative to the
ROBOT") and a **TRAPPING** ("preventing the movement of a SCORING ELEMENT against a FIELD
element"), both quoted in the code as if they were DECODE's. Verified by extracting Sections 11
and 16 of the archived manual and grepping both:

* there is **no POSSESSION glossary entry**; the only occurrence of the word in Section 11 is
  G404's "pre-load possession limit";
* there is **no TRAPPING glossary entry**, and the word does not appear in Section 11 at all.
  The quoted definition is DECODE's **PIN/PINNING** with "opponent ROBOT" swapped for "SCORING
  ELEMENT";
* "bulldozing" and "deflecting" are not glossary terms either — they exist only as G408's own
  non-CONTROL examples.

DECODE defines exactly one term, **CONTROL**, and the rewrite is written against it clause by
clause. See the G408 bullet in CLAUDE.md for the full mapping.

### What changed behaviourally

| | before | after |
|---|---|---|
| a pile CREPT below 1.5 in/s | 0 fouls over 12 s | controlled (no speed floor in the definition) |
| a pile driven into a wall and held | 4 MINORs, then free all match | keeps billing (the LATCH) |
| a robot parked near a wall, never pushed anything | fouled by the invented TRAPPING rule | clean |
| artifacts off a convex CORNER | counted | not control (clause B names the face) |
| anything inside your own loading zone | never counted, robot anywhere | only while the ROBOT is in there |
| an artifact excused at the mouth | re-added by the transitive chain | conducts, not counted |
| first continuing tariff | 2 × REBILL_S (measured 6.02 s) | one interval after the violation opens |
| per-(robot,artifact) clocks | leaked forever, ids recycle | swept, and cleared outside auto/teleop |
| the acquire carve-out | raw intake button only | `cmd.intake \|\| r.autoIntake`, as robot.ts does |

### ⚠️ ONE DELIBERATE DEVIATION, now labelled as one

`POSSESSION_REBILL_S` — the "another tariff every 3 s" rule — **is not in G408**. Its violation
line is one assessment. The same manual writes the continuing clause three times (G422, G423,
G434) at exactly this interval, and G434's is the identical per-artifact shape, so the omission
from G408 reads as deliberate. It is kept because you asked for it ("the over-possession penalty
is way too lenient") and because billed once the whole tariff for hoarding six artifacts was
three MINORs and then free. **Set `POSSESSION_REBILL_S` to `Infinity` for the rule as written.**
Measured cost of keeping it: leaning a six-pile on a wall for 30 s now bills **40 MINORs**
(200 pts). That is the dial to turn if it reads as too harsh.

### Two smoke scenes were mislabelled and are now fixed

Both were passing for the wrong reason, and both hid behind the invented TRAPPING rule:

* *"pushing a clump across open floor"* drove at full throttle, swallowed three artifacts, and
  spent 6.5 of its 8 seconds **parked against the far wall** with exactly three in the hopper —
  which is at the limit and not a violation. It now herds at a third throttle from the bottom
  of the field, which is what the name says.
* *"...with a FULL robot"* never had one: the `clump` helper always emptied the hopper. It now
  takes the hopper as an argument.

### Gotchas worth keeping

* **Get DECODE rule text from `/ftc/archive/2026/game/manual-NN`.** The live `/ftc/game/manual`
  serves the 2026-27 pre-season manual and `manual-11` 404s there. WebFetch's own PDF extractor
  returns binary garbage on these — download and run `pdftotext -layout`, and **without**
  `-layout` for the glossary, whose two columns interleave otherwise.
* **Check every quoted definition against the real glossary.** This rule shipped for months
  against two that do not exist.
* **Do not snap a contact to a face by nearest distance.** The first cut of `contactPush` picked
  the nearest face plane; on a square-ish chassis an artifact dead ahead is exactly equidistant
  from the front face and a flank, and a 1e-11 rounding sent it to the flank — which zeroed the
  push for a robot driving straight at it. The direction now comes from the contact itself.
* **`world.penalties` has no `unslimWorld` backfill.** Nothing was added this session, so
  nothing breaks — but any NEW `PenaltyState` field will be `undefined` on a client talking to
  the older Fly server, and the sim indexes these maps directly. Backfill or read defensively.
  (`ballTrap` was REMOVED, which is safe in both directions: nothing ever read it.)

## Open

* **`BALANCE_VERSION` stays at 4.** It went to 4 yesterday for the push rewrite, and that season
  has only ever existed on the alpha preview, so the standings a second bump would archive are
  empty. G422 and G408 both land inside that same fresh season. Bump it if alpha standings start
  being treated as real.
* Two pre-existing bugs, still unfixed and still not requested: `saveReplay` never stores
  `replay.sim` (so the `SIM_VERSION` gate refuses every DB-served replay — and that gate now
  matters more, since 4 → 5 changes foul totals), and Free Drive with an auto path enabled
  freezes the robot.

---

## 2026-08-24 — robots pushing robots, and what counts as pinning (superseded as READ FIRST)

Branch **alpha**, commit `fd05c68`, pushed. Working tree CLEAN.
`npm test` ALL PASS · `npm run build` green · `npm run server:check` green ·
`npm run test:mm` green. **Deployed to the alpha preview** (`dsim-alpha`), production untouched.

Do not merge to main. Standing rule.

## READ FIRST — where this session ended

An audit of every live path for robot-on-robot pushing found eight defects; all eight are
fixed. `SIM_VERSION` 2 → **3**. **`BALANCE_VERSION` was NOT bumped — that decision is still
open** (see *Open* below). `SIM_VERSION` is now **4** — the pinning rewrite below moved it
again — and the ALPHA PREVIEW is deployed on it.

### The one that mattered: the shove was a mass, and it should have been a force

The sim pushes by **setting velocity**, not by applying force. So the momentum a robot injects
per tick is `collider mass × accel × dt`, and the force it delivers is `mass × accel`. The old
`shoveMass = massLb · pushMult · rpmPush · (1−powerDraw)` was written as if it were the answer
on its own — but `driveParams().accel` already carries `REF_MASS_LB/massLb`,
`REF_DRIVE_RPM/rpm` and `1−powerDraw`. Measured consequences:

| factor | intended | actual before |
|---|---|---|
| `massLb` | push ∝ weight | **cancelled outright** — 20 lb and 42 lb both delivered 5591 |
| `rpmPush` | clamped 2.48× spread | **7.45×**, the clamp defeated by the second application |
| `powerDraw` | ×0.80 at the cap | **×0.64** (squared) |
| `pushMult` | tank:xdrive 4.9× | 12.1×, because `accelMult` rode along |

Verified empirically, not just algebraically: pairs with equal predicted force stalemate, pairs
with unequal force rout. The headline symptom was an inversion — **a 250 rpm minimum-weight
mecanum out-pushed a 42 lb 435 rpm tank**, i.e. the rpm slider was a stronger pushing lever
than the drivetrain pick, which is the opposite of every word in `DRIVETRAIN_PRESETS`.

Now `src/sim/drivetrain.ts` states the force and derives the mass:

```ts
pushForce = massLb · BASE_DRIVE_ACCEL · pushMult · rpmPush · (1 − powerDraw)   // traction-limited
shoveMass = pushForce / (driveParams(spec, tankMode).accel · (1 − powerDraw))  // what delivers it
```

`powerDraw` cancels between the two today. It is written out anyway, on purpose: the identity
must hold whatever `accel` happens to contain. **Never add a term to `pushForce` without
checking whether `accel` already has it.**

**The tradeoff this forces, and why it was taken.** Because `accel ∝ 1/massLb`, `shoveMass`
comes out ∝ massLb². Rapier's one `mass` also decides a ram's momentum split and the positional
split of an overlap, so a 2:1 weight difference now separates ~4:1 there. That is the price of
`accel` staying motor-limited (heavy = sluggish, the point of the mass slider) while push stays
traction-limited (heavy = stronger, which is real). One number cannot be both; it is the pushing
one, because that is what a match turns on. The alternative — dropping `REF_MASS_LB/massLb` from
`accel` — makes both correct at once but removes mass's only downside, and everyone would build
max-mass.

### A shoved robot could not turn AT ALL

Rapier locks robot rotation, so the solve produces no angular response; the only other source
was the heuristic `spin` flick, scaled by the robot's **own** press — zero for anybody who is
not driving. Measured, ramming an idle robot at y-offsets 0/4/8/12 in (the last grazing a corner
of a 16.5 in chassis) left the victim at heading **0.00° and angVel 0.000 every single time**,
while the aggressor yawed 3.5°. Cornering an opponent to spin them is the most basic defensive
move in FTC and it could not happen.

`squareUpPair` now runs the real two-body point impulse — the same model `squareUpStatics`
already used for the gate handle, extended to a second movable body — and takes **only the
rotation** (Rapier owns the linear half; adding it back would bounce apart a pair whose
restitution is deliberately 0). Coulomb `J_t` is in it, which is what makes a flank hit turn you
INTO what you caught. Now: 0 in → 0.00°, 2 in → 4.7°, 4 in → 9.4°, 8 in → 19.1°, 12 in → 27.9°,
and it **settles** rather than running away (checked to 15 s).

### The press was absolute velocity, so contacts carrying no load still torqued

Each robot's press was its own velocity on the normal — a load reading that does not need the
other robot to be there. Two robots cruising side by side in contact, nothing compressed,
squared each other up at 0.45 rad/s; a pair actively **separating** (gap 14.7 → 19.5 in) still
had the trailing one snapped from 11.46° to flush. It is the pair's **closing** velocity now,
shared by both. `contactTorqueDelta`'s "no load, no torque" rule was right all along; the input
was wrong.

### ...and a robot held against a wall by an opponent never squared up

Same root cause on the static side: `pressAlong` reads only the robot's own drive. A 42 lb tank
rammed an idle robot into the field corner and the victim sat at its 22.9° arrival angle for
four seconds. `pressOn` now takes `max(own drive-in, load transmitted through the chassis)`,
with the transmitted part carried from the pair pass in `ContactAcc.ext`. Four tilts (±20°,
±11.5°) all come flush inside 2° now.

### Four more, smaller

- **An auto-path robot was a GHOST.** `solveRobots` skipped body creation entirely for
  `autoPathActive`, so for the whole 30 s of AUTO an opponent drove clean through it (measured:
  end to end, the path robot never moved a thousandth of an inch) and it passed through walls
  too. It gets a **kinematic** body now: solid to everyone, pushed by nobody, path still owns
  the pose. CR never sets the flag, so this is DECODE-only in practice.
- **The pair pass wrote before the statics read.** It rotated both chassis before the walls /
  goal faces / classifier / gate arm worked out their geometry — the exact path-dependence
  `sumTurn` exists to kill, with the robot-robot half left outside it. `ContactAcc` accumulates
  everything and each robot is turned once. Pinned by a check: identical geometry with the robot
  ids permuted now gives bit-identical headings. (Rapier's own body order still follows
  `world.robots`; that is inherent to the solver and stays deterministic.)
- **Penetration.** A max-push tank holding an opponent against the wall buried it ~2.4 in.
  Halving the force fixed most of it; `PHYS_CONTACT_FREQ` 8 → **12** took it to 0.57 in.
- **Dead code.** `collideRobots` and `constrainRobot` (zero call sites) and `CONTACT_BIAS`
  (superseded by `CONTACT_COMPLIANCE`) are gone. `driveSummary()`'s `push` column now prints the
  real force instead of the raw `pushMult`, which had quietly disagreed with the shipped model.

### G422 pinning, read against the manual instead of paraphrased from it

The rule was verified verbatim from the ARCHIVED DECODE manual (Team Update 32, Section 11 V15,
p.112 — note `ftc-resources.../ftc/game/manual` now serves the 2026-27 BIOBUZZ pre-season manual
and `manual-11` 404s; DECODE is only at `/ftc/archive/2026/game/manual-NN`). What it says:

> A ROBOT is PINNING if it is **preventing the movement** of an opponent ROBOT by contact, either
> direct or transitive (such as against a FIELD element) and the opponent ROBOT is **attempting to
> move**. A PIN count ends once any of: **A.** separated by 2 ft for more than 3 seconds, **B.**
> either ROBOT has moved 2 ft from where the PIN initiated for more than 3 seconds, or **C.** the
> PINNING ROBOT gets PINNED. [A and B **pause** the count and it **resumes**.]
> Violation: **MINOR FOUL and an additional MINOR FOUL for every 3 seconds** in which the
> situation is not corrected.

Five divergences, all fixed:

1. **"Preventing" was not tested at all.** Any contact counted. So a robot driving ITSELF into a
   wall fouled whoever was behind it — contact, attempting to move, going nowhere, trapped, and
   the opponent preventing nothing. Measured, the WEAKEST legal build "pinned" a default chassis
   that way. `isPinning` now requires the pinner to lie along the victim's attempted direction
   (`PIN_OBSTRUCT_COS`, ~70° either side).
2. **A tank could not be pinned AT ALL.** "Attempting to move" read `driveX/driveY/rotate`, which
   a Traditional-tank driver on separate sticks never fills — G422 simply did not protect it.
   `attemptDir` decodes the command the way `updateRobot` does, side-drive and field-centric
   included.
3. **The count died on any lapse.** `PIN_BREAK_S` 0.6 s ended a pin outright when the hold
   flickered for any reason, so a pinner could wipe a 2.5 s count by easing off for 0.7 s. Only
   criteria A/B/C end one now, and A/B PAUSE and RESUME — stated twice in the rule.
4. **Criterion C did not exist.** A mutual hold is nobody's foul.
5. **The bill was wrong in both directions.** One MINOR however long you held it, plus a
   MINOR→MAJOR escalation that appears nowhere in G422. It is a MINOR every 3 s now. (G211 lets a
   Head Referee card egregious repeats — judgement, not this rule.)

**`pinnedAgainstWall` is NOT in the rule and is kept anyway.** A FIELD element is offered as an
example ("such as"); direct contact alone can pin. It stays because it is the only thing breaking
the SYMMETRY of a shove, and the cost is small: criterion B ends any pin that travels 2 ft, so the
only open-field pin the rule sustains is a stationary stalemate — and a stationary stalemate is
mutual, which criterion C ends. What is left uncovered is narrow: a robot wedged on another robot
with open field behind it.

**Measured after** (10 s scenes): a static hold bills at 3.05/6.05/9.03 s; a 2 s break pauses and
resumes; a 3.4 s break ends it and the count restarts; a swerve pinner walking the victim 69 in
along the wall bills once and stops (criterion B); a tank victim on side-drive alone now bills
identically to arcade; the drive-into-a-wall scene bills nothing, including against the weakest
legal pinner.

**Test-scene gotcha this exposed:** several pin checks read `w.match.fouls.blue.minor`, which
counts EVERY minor foul blue commits. A pin scene that travels drives through protected zones and
picks up G424/G425 of its own — one probe read 7 "pins" that were 1 pin and 6 zone fouls. Count
G422 events (`pins()` in smoke.ts), and park the artifacts or the pair ploughs a spike-mark pile
along with it and you are testing G408.

### Round two: eight more, found by attacking the fixes

The first pass was reviewed adversarially and the review found real defects in it. Everything
below was introduced (or newly exposed) by the round-one work and is now fixed, with a check
each. Worth knowing that the review's own second pass died on a usage limit with every verifier
agent unrun — its "0 confirmed" was an artifact of missing verdicts, not a clean bill. All seven
of its findings were checked by hand and three were real.

1. **A shoved robot could not turn under its own power.** The pair impulse is recomputed at full
   strength every tick, and for a sustained contact `press` is a constant 8.49 in/s (most of it
   the victim's own braking), giving a permanent −0.7 rad/s that exactly cancelled the wheels'
   +0.6. At full rotate stick a victim managed 87° of a possible 2748 in five seconds; a tank
   managed −13°. The damning part was the sweep: **an x-drive 4.5× WEAKER than its victim held
   it to 103°, the same as a tank 6× stronger.** A torque that ignores how hard it is applied is
   not a torque. `CONTACT_PAIR_SPIN` 0.6 scales the impulse's rotation — the weak pusher now
   holds it to nothing (820°) while an equal or stronger one still pins you. It costs the ram
   (near-corner spin 28° → 17.5°, still clearly offset-graded). The real fix is a contact that
   can SLIP; this is a dial, and it says so.
2. **A moving auto-path robot buried and passed through a bystander.** The kinematic body had no
   linvel, so the solver saw a stationary thing that had teleported 1.56 in — overlap grew to
   15.2in on a 17.5in pair, the SAT min axis flipped, the bystander was ejected sideways, and
   the path robot went through. `world.ts` now sets `r.vel` from the pose delta (which is also
   simply the truth — the HUD, shot-lead and the G422 speed gate were all being told zero).
   Carrying is now perfect: a 1.4in GAP, never touching.
3. **...but a jump is not a sweep.** `initializePathTraversal` teleports the chassis onto the
   path's start point, and dividing that by `dt` gave thousands of in/s that blasted a bystander
   60in. Displacement beyond `maxSpeed × 1.5` reports no velocity at all.
4. **The gate handle wrote straight onto an auto-path robot.** `applyAcc` skips path robots, but
   the gate's point impulse writes `vel`/`heading`/`angVel` directly and bypassed it — newly
   REACHABLE because `pressOn`'s transmitted load gave a non-driving robot a press it never had.
   An opponent ramming a path robot parked on the blue gate handle rotated it 7.4° off the
   heading its path commands, permanently (a `wait` segment never rewrites heading). The whole
   static pass is skipped for a path robot now.
5. **A pair contact VETOED the wall square-up.** `sumTurn` clamps the summed alignment to the
   tightest `flushErr` any contributor reports — right for a static face, wrong for an opponent,
   who will simply slide. Two parallel chassis put the pair's flushErr at ~0, so a robot pinned
   face-to-face had the wall's own −2.86°/tick correction thrown away every tick and sat 18–40°
   off flush. `noVeto()` reports `Infinity` outward while keeping the pair's own capped align.
   The existing pin check could not see it: at exactly π/2 the two normals agree.
6. **A robot crushed between a wall and a kinematic path robot left the step at 959 in/s** — six
   field widths a second. `PHYS_MAX_ROBOT_SPEED` bounds it, applied both on solve write-back and
   at the end of `applyAcc` (the gate impulse adds velocity after the solve).
7. **...and that guard's first form fired in ORDINARY play.** It was `maxSpeed × 2`, scaled to
   the victim's own top speed when what sets a shoved robot's velocity is the PUSHER's. The legal
   envelope runs 30.1 to 120.9 in/s, so the slowest build's ceiling sat BELOW what the fastest
   could legitimately shove it to: 27 of 65 ticks of a plain open-field push were clamped,
   throttling it 12% and putting a discontinuity in the rpm slider with no physical cause. It is
   an absolute 300 in/s now — ~2.5× anything that can exist here.
8. **A robot could be pushed clean out of the field.** No speed guard can see this: Rapier's
   positional correction does not feed velocity, so the victim's `r.vel` read 0.00 for every tick
   it was travelling through the wall. `FieldColliders.bounds` + `outsideBy`/`grewOut` in
   `solveRobots` hold the invariant, and hold it as GROWTH: a robot that began the tick inside
   cannot be pushed out, while one already outside is left alone — DECODE's outflow mouth sits
   at x = −69 and the drain probes park a whole chassis past the wall plane on purpose.
   `PHYS_CONTAIN_SLOP` 0.75in keeps it off ordinary resting penetration (0.57in at the worst
   shove); without that slop the wall square-up lost flush by 1.4° and artifacts began jittering
   against the classifier again — the two-passes-taking-turns failure, exactly as advertised.

**Also from round one, and worth keeping in mind:** two REAL findings were pre-existing and are
NOT fixed here — (a) Free Drive with an auto path enabled freezes the robot completely
(`world.ts` runs path traversal only in `auto` but skips `updateRobot` whenever `autoPathActive`,
and `free` never reaches `auto`); (b) `server/db/repo.ts` `saveReplay` never stores
`replay.sim`, so the `SIM_VERSION` gate refuses every DB-served replay. (b) matters more now that
`SIM_VERSION` moved.

### The stiffness sweep, so nobody re-litigates it

`PHYS_CONTACT_FREQ` was 8 Hz on the reasoning that SOFT contacts let a body starting deep inside
a wall bleed out instead of being ejected. Swept 8/15/20/25/30/40/60 Hz against both hazard
cases (a robot seeded 2 in inside a wall; two robots seeded 6 in overlapped): **recovery velocity
was 0.0 in/s at every single setting** — Rapier's positional correction here does not feed
velocity, so there is no explosion to buy off. Penetration under a max shove: 1.22 in at 8 Hz,
0.59 at 12, 0.55 at 15, 0.49 at 25, then it creeps back up. **12 was chosen, not 25**, because
15 Hz broke the classifier-jitter ratchet and 25 Hz also broke two G408 possession checks and
the wall-ram torque bound. 12 is the largest step with zero collateral.

### Test coverage

`npm test` gained ~20 checks and lost nothing. The three that changed MEANING:

- `heavier robot yields less (42 vs 21 lb ≈ 1:2 push)` → `(42 vs 21 lb, by shove mass)`, ratio
  now >2 rather than ≈2. It seeds two robots OVERLAPPING at rest and steps ONCE, which measures
  the solver's positional split — **not** a pushing match. That is exactly why the double-counts
  survived so long: under this test 20 lb and 42 lb looked 1:2 apart while delivering identical
  force. The real coverage is the new `pushContest()` helper (both robots driving, 3 s).
- `geared-for-speed (600 rpm) robot yields more than a torquey (300 rpm) one` — deleted and
  replaced by a driven contest. Shove mass is rpm-INDEPENDENT inside the clamp band now
  (`rpmPush · rpm = 435`), so the seeded-overlap version could not express it; the force is not,
  and the driven version rules on it decisively.
- `chain endgame: ascended a ring stand` placed the robot at `ringStands()[3]`, i.e. **inside**
  the solid post — the thing `CHAIN_START_POSES`' own comment says the stand anchors exist to
  avoid. It only ever passed because the contact was soft enough that 0.1 s of ejection stayed
  under `endgameOf`'s 12 in/s gate. It uses the anchor now.

## Open

- **`BALANCE_VERSION` 3 → 4 — DECIDED, a fresh ranked season.** Every head-to-head outcome
  moves and the stiffer contact moves solo record scores too, so the current DECODE and Chain
  Reaction standings are archived and the boards start over. `SIM_VERSION` 2 → 3 handles replay
  invalidation on its own axis.
- **DEPLOYED to the ALPHA PREVIEW** — `./scripts/fly-deploy.sh --alpha` → `dsim-alpha`, image
  `deployment-01M0V3KPC6YEPRQ9JBH2B2Q3KW`, one machine in `iad`, `/health` returns `ok`. Its own
  database, no live players. (It reports `stopped` between requests; the preview auto-stops when
  idle and Fly starts it on the first connection — that is normal for the single-region app.)
- ⚠️ **Production `dohun-sim-decode` is still on the OLD physics.** A production client built
  from this branch would predict the new sim against a server stepping the old one — constant
  reconcile snap-back. Ship it with `ADMIN_SECRET=… scripts/announce-deploy.sh` when the season
  reset is wanted for real; that is a separate decision from this preview.
- Gotcha for next time: the `flyctl` token in `~/.fly/config.yml` had expired (well-formed
  `fm2_` macaroon, `last_login` six weeks earlier), and flyctl reports that as
  *"no access token available"* rather than a 401 — it reads as a missing credential, not a
  stale one. `flyctl auth login` is the fix.
- The **residual order-dependence is Rapier's own body order** (`world.robots` order), not the
  bespoke pass. It is deterministic and identical for identical inputs; it only shows if you
  permute which robot holds which id, which never happens in a real match.
- CR's **ring-stand colliders still get no contact-torque square-up** — `squareUpRobotsWalls`
  aligns to the four perimeter walls only. Out of scope here; worth a look if a robot leaning on
  a stand feels wrong.

## Gotchas earned here

- **Probe worlds are full of field geometry.** A "two robots travelling together" check placed at
  x=−60 has both chassis reaching past x=−66 into the classifier channel, and one catching it and
  the other not IS relative motion — the check failed for a real reason that had nothing to do
  with what it was testing. Stay mid-field, and park the artifacts
  (`state = { kind: 'held', robot: 99 }`).
- **`flywheelInertia: 0` for any two-robot symmetry check.** The flywheel's power draw ramps with
  distance to your own goal, so two robots at different positions otherwise have different accels
  — real relative motion that will be mistaken for a contact bug.
- **`PHYS_SOLVER_ITERS` is SHARED with the ball world** (`makeWorld` takes freq/error as
  parameters but not iterations). Raising it 8 → 12 moved two artifact-possession checks; the
  robot-only levers are freq and allowed-error.

## (older) HANDOFF — 2026-08-22 (contact geometry: the closest FEATURE, and one turn per tick) — alpha only

Branch **alpha**, commit `fb75a83`. Working tree **CLEAN**. `npm test` ALL PASS ·
`npm run build` green · `npm run server:check` green. **Not deployed.**

Do not merge to main. Standing rule.

**MERGED IN (this session):** `df4b085` *hosted name moderation* off the long-lived
`moderation` branch. Server is the authority for every user-supplied NAME (username,
display handle, robot/team names on the public leaderboard + live roster) via
`server/moderation.ts` — a HOSTED endpoint (default OpenAI's free `/v1/moderations`),
NOT a hand-rolled wordlist (the user rejected that; a deleted `nameFilter.ts` — do not
resurrect it). Env-gated on `MODERATION_API_KEY` like `DATABASE_URL` gates records:
absent ⇒ disabled, every name allowed, ZERO network. FAILS OPEN on outage/timeout;
`/admin` forced-rename is the human backstop.
**DEPLOY:** this is a SERVER change — `./scripts/fly-deploy.sh` (NEVER a bare
`flyctl deploy`) AND `fly secrets set MODERATION_API_KEY='sk-…' -a dohun-sim-decode`.
Backward-compatible: no key ⇒ no-op, and the `reason:'inappropriate'` field is additive
so old clients ignore it. No CSS/colour change (reused `--ds-danger`).

### (older) Where that session ended

*"Collision with the gate/corner of the gate is still very weird."* Three structural
things, all in `src/sim/physics.ts`:

1. **The normal at a corner.** The gate handle and the classifier both took their normal
   from SAT's least-overlap axis (the handle, from a snap to whichever axis the centre was
   furthest along). Both treat a rectangle as all FACE, so near a corner the normal jumps
   between axes as the robot crosses the diagonal — the push direction, and which way you
   are turned, flips within a fraction of an inch. Now: clamp the centre onto the rect; one
   coordinate moved is a face, both moved is a CORNER and the normal runs from it.
   Continuous everywhere.
2. **Surfaces are summed, then the chassis turns once.** Each surface used to write
   `heading` as it was processed, so the gate arm computed its geometry against a robot the
   classifier had already rotated. `contactTorqueDelta` is pure, `squareUpStatics` sums, and
   the flush cap that survives is the tightest any FACE imposes.
3. **The arm's manifold is both bodies' features**, unioned, not three fallbacks in priority
   order (which one answered depended on which side you hit from).

**Measured** (drive into the arm, 2in steps across it): centred 0 deg; off-centre from the
tunnel side 7/7/7/11 deg; from the channel side 0-15 depending on where you meet it. The
channel-side spread is **not** a discontinuity — instrumented, one surface acts there and
contributes a steady 0.19 deg/tick — it is how far the chassis turns before it slides off a
2.5in stub. Bounded by a smoke check that prints both sides.

### Still open here

- **The response is a heuristic, not tau = sum(r x F) / I.** A full physical rewrite was
  tried and REVERTED this session: 20 deg hits were perfect, small angles rocked +/-9 deg,
  10 checks red. Findings kept: mass cancels; the impulse denominator is
  `1 + (r x n)^2 / (I/m)` with `I/m = (l^2 + w^2)/12`; `press` reads as a FORCE, not an
  impulse; and the torque must turn the CHASSIS, not integrate `angVel`.
- One squeeze still rings: an artifact between a driving intake and two walls, 1.48in at
  4/s. Bounded, not gone.

### Two traps that cost real time this session

- **Heading wrap.** Raw `heading` deltas read as full 360 turns. Three separate "it spins me
  round" diagnoses were my own probes, not the sim. Unwrap, or measure mod 90.
- **Parking probe artifacts at (300,300) does not remove them** — the ground clamp snaps
  them back into the field, and the robot then pivots on a pinned ball. Use
  `state = { kind: 'held', robot: 99 }`.

## (older) HANDOFF — 2026-08-18 (the ramp: a stalled column, and the overflow lane) — alpha only

Branch **alpha**, commit `3aa4697`. Working tree **CLEAN**. `npm test` ALL PASS ·
`npm run build` green · `npm run server:check` green. **Not deployed** — production
`dohun-sim-decode` is still on an older build and still owes the migrations listed
further down.

Do not merge to main. Standing rule.

## Where this session ended

Fourteen reports: the DECODE classifier ramp and gate, the intake at its outflow and in a corner, and one Chain Reaction terrain bug. The first two trace to the same kind of
thing:
a constant (or the absence of one) that was correct against the OLD `RAIL_ACCEL` of 80 and
was not rescaled when the ramp became 25 and lost its capped flow speed (`57a308e`).

### A stalled column no longer winds up (`a653810`)

*"after ball flow resumes after being stalled, it shoots down extremely quickly"* — a
blocked artifact went on accumulating `RAIL_ACCEL` into `v` every tick it stood still. The
only cap on a blocked artifact's speed was the floor's, and an OPEN gate declares "no cap"
(`exitFloorV = -Infinity`), so an open-but-blocked drain — a robot parked on the outflow,
or the doorway busy — pinned the column in place while `v` marched -5, -10, -15 … to the
`RAIL_TERMINAL` **safety** cap of 120 in/s in 4.8 s. The instant the block cleared they left
at up to **86 in/s** and the whole ramp emptied in one burst.

The fix is one line: `wasV` — the artifact's speed BEFORE this tick's gravity — is a cap in
its own right alongside the floor's, so `st.v = Math.max(st.v, floorV, wasV)`. Whatever
holds an artifact up pushes back exactly as hard as gravity pulls, so being held is never an
acceleration; it still keeps the momentum it ARRIVED with, which is what the exit lip has
always done. A FLOWING drain is untouched — an artifact in a moving column is in contact for
a tick at a time, because the one ahead has more runway and opens the gap itself.

**Capping at the DOORWAY artifact's speed was tried first and is a different bug**: that
queue is nudged along at ~22 in/s, so the whole ramp is throttled to it — mean release gap
0.58 s against 0.32 s, and a held gate stopped emptying the ramp. The note in `updateRails`
records it so it is not re-attempted.

### The overflow lane flows again (`1f95735`)

*"ball flow for overflow is weird and slightly slow"* — it was both, from two constants:

- **`OVERFLOW_DRAG` → `OVERFLOW_ROLL_LOSS`.** A 2.2/s velocity drag pins the ride at a
  terminal of `RAIL_ACCEL / 2.2`: 36 in/s under the old ramp, **11 in/s** under this one,
  against a ramp lane running 17..54. It is now a CONSTANT deceleration (9 in/s²) for the
  same reason `RAIL_ACCEL`'s own note gives — rolling resistance does not grow with speed,
  so there is no terminal and speed is a consequence of distance travelled. Both lanes are
  one physics again and the ratio is readable: `sqrt((RAIL_ACCEL − loss) / RAIL_ACCEL)` = 0.8.
- **`OVERFLOW_BUMP` 40 → 12.** At 40 the scallop was 1.6× the pull meant to drive the ride,
  which stops being a texture and becomes a TRAP: four riders dropped onto a full column,
  three stuck on it forever (one held at **v = +5 in/s**, pushed steadily back UP the ramp)
  and the fourth creeping out at 16 in/s after four seconds. The invariant is arithmetic —
  `RAIL_ACCEL − OVERFLOW_ROLL_LOSS − OVERFLOW_BUMP × OVERFLOW_SLOPE_MAX > 0` — and swept
  over 26 starting states the strandings begin the tick it goes negative (bump 19). At 12
  the ride gains speed at 4..28 in/s² and every rider comes off: exits 18..29 in/s in
  1.4..2.9 s.

**A bump strong enough to make the rider DECELERATE on a crest is strong enough to strand
it** on the uphill shoulder of the topmost artifact, where nothing above can push it back
on. The old "loses speed cresting each artifact" check was passing off the velocity drag,
not the geometry; it now asserts the SWING in the rate of gain, plus the invariant itself.

### Checks added

- `a column held against a block does not accumulate speed while it waits` (2 s vs 6 s into
  a stall, no growth) and `...and it resumes at ramp speed rather than shooting out of the
  gate` (under the ramp's own `sqrt(2as)` ceiling).
- `every overflow artifact clambers off the column instead of parking on it` (9 starting
  heights) and `...and leaves the ramp slower than the ramp lane but far above the old drag
  crawl`.
- The `LURCHES` + invariant pair replacing the old crest-deceleration check.
- The ramp-height check is sampled PER ARTIFACT now: its half-inch `s` buckets spanned two
  inches of `z`, and a column that comes to REST part way out of the mouth (which it now
  legitimately does) made the aliasing visible.

### The exit goes straight down (`fb286db`)

*"All the balls keep coming out of the gate at the same angle."* The release leaned every
artifact 5-15 degrees off the wall, and the jitter varied the lean's MAGNITUDE and never
its SIGN — so the whole drain left on the same diagonal. A wider or narrower fan only
changes how wide that one diagonal is, so the fan is gone rather than retuned.

The channel runs down the wall and the artifact rolls off the END of it, so it leaves in
the direction it was already going. The only sideways motion it has a claim to is the
weave it was doing across the groove, and `railWanderRate` (new, in field.ts) is exactly
that — how far the groove carries it per inch travelled, so times its own speed it IS
that artifact's lateral velocity. Signed, a couple of in/s, different per artifact.
Measured over a nine-artifact drain: **2.5, -3.0, 1.7, 0.5, -2.4, 3.0, -1.9, -0.2, 2.2
degrees**. `TUNNEL_EXIT_VEL` keeps only its speed (the doorway nudge's).

### A ball coming out lifts the arm, and pays for it (`7d4239d`)

*"A tap only lets out one ball now… a ball coming out is not lifting the gate back up."*
Two things, and the second is the interesting one.

- **The knock was gated on `GATE_PASS_FRAC`**, which is where an artifact gets THROUGH, not
  where it can reach the paddle from underneath. An arm a hair below the pass line was a
  wall. The threshold is now `gateRestOn` at the moment of contact — the height the paddle
  sits at when resting on that artifact's surface. A FLAT arm is still a wall at any speed,
  so retention is untouched.
- **The knock was FREE.** The arm was thrown up at no cost to the artifact, so a knock hard
  enough to reopen a sagging arm was also one that could never run out — the yield was a
  cliff (one artifact, or all nine, decided by a fifth of a second on the lever). A
  collision moves momentum; it does not mint it. **`GATE_STRIKE_LOSS` (new, 0.45)** charges
  the lift to the striker, so the arm's weight is what the flow spends itself against and a
  drain gives out when the column can no longer pay. A LATCHED arm is touching nothing, so
  holding it still costs the flow nothing.

`GATE_KNOCK` 0.06 → 0.12 with that loss. Packed nine-column, tap length → drained:
**0.10s 2 · 0.12s 2 · 0.15s 2 · 0.18s 2 · 0.20s 3 · 0.25s 7 · 0.30s 8 · 0.40s 9**, against
1/1/1/2/2/2/4/9 before. The 27-condition sweep spans every value 1..9.

**The knock-scaling check was measuring two speeds that both saturate the arm** from
`GATE_RIDE_FRAC` and reported 1.00 twice. It now measures from a SAGGING arm, which is
where a drain is actually decided: from 0.31, 5 in/s reaches 0.35 and stays shut, 10 in/s
reaches 0.46 and reopens it, 18 in/s reaches 0.75.

**A note for the next tuning pass.** `RAIL_ACCEL` 80 → 25 (`57a308e`) doubled the time a
resting column needs to deliver its next artifact — `sqrt(2·RAIL_PITCH/a)` went 0.36s →
0.64s — while the arm's fall from full lift to the pass line stayed at 0.45s
(`GATE_GRAVITY` 6). That race is why short taps went bimodal in the first place. The
strike now bridges it; if it ever needs revisiting, `GATE_GRAVITY` is the constant that
was never re-derived against the ramp it meters.

### The arm's fall is set against the ramp it meters (`d963c05`)

*"A tap lets out 1 or 2"* — still, after the strike fix, and this is the structural half.
A tap on a RESTING column is a race between two times:

| | |
|---|---|
| the arm's fall from fully open to the pass line | `sqrt(2·(1−GATE_PASS_FRAC)/GATE_GRAVITY)` |
| the column's delivery of its next artifact | `sqrt(2·RAIL_PITCH/RAIL_ACCEL)` |

The second **doubled** when the ramp stopped running at a capped flow speed (`RAIL_ACCEL`
80 → 25, `57a308e`): 0.36 s → 0.64 s. `GATE_GRAVITY` stayed at 6, a 0.45 s fall. The arm
was therefore always shut before the second artifact could arrive, and **no knock can fix
that** — the first gap is covered by nothing at all.

- **`GATE_GRAVITY` 6 → 4**: fall 0.55 s against the column's 0.64 s. Marginal is the point,
  and the ratio has a CEILING as well as a floor — at 2.9 the fall matches the delivery and
  the yield is 9 of 9 in **every one of 50** tap conditions, i.e. the drain can no longer
  give out at all.
- **`GATE_KNOCK` 0.12 → 0.07**: with the strike loss a flowing column sits at a fixed-point
  arrival speed (~19 in/s), so the rise per knock is a constant compared against a constant
  fall between arrivals. Set high, every drain that survives its first gap runs the whole
  ramp: at 0.12 the sweep was 9-or-nothing (12 ones, 36 nines, nothing between). At 0.07 it
  spans 1..9, mean 5.

Packed column, tap length → drained: **0.10s 2 · 0.15s 3 · 0.20s 5 · 0.25s 9**. Loosen the
column to +5in and a quick tap is worth 1 again, which is the situational answer it is
supposed to have. Checks: a 0.12 s bump is worth more than one artifact at three packings,
and the fall/pace RATIO itself, so the next `RAIL_ACCEL` change trips in the suite rather
than in a play session.

### Where the sim actually runs, which cost half a session

Worth stating because it looked like the fixes were not landing: **a record run is a server
room** (`RecordRun.tsx` joins a `LobbyClient` room with `kind: 'record'`), as are lobby,
matchmaking and ranked. In all of those the authoritative sim is the Fly app — `dsim-alpha`
for the alpha site — so classifier changes are invisible until that app is redeployed. Only
**Free Drive** (`session: null`) runs the client bundle's sim. `flyctl` on this box has no
usable token (`fly auth whoami` → "no access token available", both shells; `~/.fly/
config.yml` dates from 11 Jul), so a deploy needs `fly auth login` first, then
`./scripts/fly-deploy.sh --alpha` — never a bare `fly deploy`.

### Nothing on the ramp outruns the ramp (`519f69e`)

*"Sometimes balls come down the ramp extremely fast. Only sometimes. And way too fast."*

An artifact boarded the rail carrying whatever `vel.y` the BASIN had given it, and
`BASIN_FUNNEL_ACCEL` is 1150 in/s² — three times gravity, a scripted drain aid so the basin
does not clog, not a slope. Measured over six seeds of a firing robot: **boarding up to
52 in/s, peaking at 75 on the ramp, 12 of 18 over 60**, against a ramp whose own free-fall
ceiling over its whole length is 54. The *"sometimes"* was simply whether an artifact dived
straight at the entrance or jumbled in the basin first.

The channel entrance is a THROAT, not a launcher. Boarding is capped at what the ramp
itself could have produced by that point — `sqrt(2·RAIL_ACCEL·(RAIL_S_MAX − s))` — floored
at the new `RAIL_ENTRY_V` (8) so a dribbler still gets under way. After: boarding 8 flat,
peak 47..55, none over 60. **Throughput is unchanged** (18 scored either way, worst basin
backlog 3 either way), so the cap costs the drain nothing.

The invariant is now a check: *nothing on the ramp is faster than an artifact released at
the top of it.* That is the property that makes the flow legible, and it is worth keeping —
any future "the classifier feels wrong" report should be tested against it first.

### The intake has a roof (`ac774db`)

*"The intake should not intake if a ball drops on top of it."*

The mouth is open at BALL HEIGHT on purpose — that is what lets an artifact roll in under
the rollers, and it is why `ballRobotContact` returns no contact in the centre of the mouth
("the wheels ride high in z, so balls pass under them"). **That fact has an unstated other
half: what rides high in z is solid to anything coming DOWN.** Without it the mouth was open
from above as well, and an artifact dropped on the intake fell through the rollers into the
throat and was swallowed — 11 of 18 drops from 24in across the three presets.

`intakeLidZ` is the height the mouth geometry already implies: the roller's underside must
clear a full artifact for one to pass beneath it, so an artifact landing ON the roller sits
a diameter, plus the roller, plus its own radius up. `INTAKE_LID_THROW` sends it forward
along the robot's axis — a roller's axis runs ACROSS the robot, so forward or back is all
there is, and back is the chassis.

**The roof's BACK edge is load-bearing, not padding.** An artifact dropped on the CHASSIS is
ejected out of its nearest face by the contact code, and near the front that face is the
front — which puts it in the throat, a radius forward, still falling. Before the roof was
extended back a radius (to exactly `updateIntake`'s own capture window) every funnel preset
still swallowed a chassis-front drop. After: **0 of 18 taken, 18 of 18 on the floor forward
of the roller line**, where a running intake may then take them the way it is supposed to.

Note what was deliberately NOT done: the CHASSIS did not get a roof at `ROBOT_HEIGHT`. Shots
pass over robots today (nothing collides above `BALL_RADIUS*4`), and a chassis roof would
start intercepting them — which would break "the shooter never misses". A ball resting on
top of a robot also needs a state that does not exist.

### Parking on the outflow blocks it (`b37f3ba`)

*"Once I open the gate and then stand directly in front of where the balls come out, there
is no space for the balls to drop, so it would drop on top of the intake. However, it is
being intaked, still."*

The intake roof from `ac774db` did not cover this, because **the outflow does not FALL**: an
artifact leaving the ramp is LOWERED from ramp height to the floor over the last couple of
inches of rail and then released as a ground artifact. With a robot parked on the drop point
that lowering ran straight through its intake and set the artifact down INSIDE the mouth, at
floor level — the one place it could not have reached on its own.

`railBlock`'s chassis test is deliberately not the footprint (a robot holding the gate open
must not read as blocking the drain it is opening). But *"the mouth is open at ball height"*
only answers for an artifact that IS at ball height, and the outflow is not — the ramp
discharges at `RAMP_SURFACE_Z` ≈ where an intake's roof sits. So **the roof blocks the column
exactly as the chassis does**. It is a far tighter region than the footprint (the mouth, not
the whole front), and the rail line runs 3in from the wall while the gate arm is at the
classifier EDGE, so a robot working the lever is never over it.

Parked on the drop point: **0 taken, 9 left on the ramp** (3 taken before). Backed off three
inches: 3 taken — that is gate intaking and it must keep working; both are checks now.

**Releasing onto the roof instead was tried and is worse** — it makes a flight artifact at
ramp height carrying the roller's throw speed, and a flight artifact is exactly what can sail
through a gap it does not fit through. The existing gap check caught it. Noted so it is not
re-attempted.

One condition of the nine-way tap sweep moves with this: at the closest standoff the robot's
own intake covers the outflow, so it holds its own drain shut for the length of the tap
(9 → 3). That is the rule working, and the check says so rather than being tuned around.

### The paddle is a stick resting on a sphere (`fb562e1`)

*"The amount and the point at which the gate opens when a ball forces it open is very off.
Remember that the gate is a stick that is riding on top of a sphere."*

It was modelled as a **plunger** — the paddle's edge coming straight down the vertical at the
gate line, reading the artifact's surface height there (`R + sqrt(R² − d²)`) and mapping it
linearly onto a free constant. The paddle is hinged off to one side of the channel, so it
meets the artifact at a **tangent**, and a tangent's angle is both larger and a different
shape. `gateRestAngle` (config.ts) is the algebra:

    hypot(xb, W) · cos(t + atan2(W, xb)) = sqrt(xb² + d² + W² − R²),   W = GATE_PIVOT_Z − R

**The hinge height is the only free number, and the MANUAL picks it.** 9.8.3 puts the gate's
contact area 3.75–5.5in above the ramp, which is exactly where this stick touches this
sphere; the height that lands the apex contact mid-band is **3.5in**. A ramp-level hinge
contacts at 2.95in — below the band — which is what rules out the reading where a 5in
artifact stands a 6in stick almost vertical (that reading gives an apex rest of 1.03).

| d from the gate line | 0 | 1 | 2 | 2.29 |
|---|---|---|---|---|
| plunger (was) | 0.340 | 0.326 | 0.272 | 0.238 |
| tangency (now) | **0.437** | 0.362 | 0.128 | 0.000 |

The reach is no longer the artifact's radius: the tangency answers **2.29in**, and
`GATE_LINE_S` is now DERIVED from it so a column still rests packed at `GATE_STOP_S` exactly
as before.

**`GATE_SEAT_FRAC` and `GATE_PASS_FRAC` are now one derived value.** The 0.34/0.40 gap was a
fudge doing a job — "seated under the arm is not past it" — and it was needed because the old
gateway window was 8.5in against a 5.1in artifact pitch, so something was ALWAYS under the
arm. The stick's own window is 4.58in, less than one pitch, so the geometry does that job:
the stick rides highest at the apex, and clearing the apex IS passing.

Behaviour holds — a shut gate retains at every arrival speed 10..60 in/s (stopping at exactly
`GATE_STOP_S`), and the tap sweep still spans 1..9, mean 5.8.

**Still scripted, and the next thing to look at if this is revisited:** an artifact does not
yet WEDGE the arm up along the tangency as it advances (the arm's rise is still the
`GATE_KNOCK` impulse). The geometric version is `rest'(d) · v`, needs no constant at all, and
would make "a ball forces it open" a kinematic consequence — but it also needs the paddle's
FACE modelled (below the artifact's equator the edge blocks rather than wedges), or a fast
artifact levers a shut gate open.

### Pressing the lever is not parking on the outflow (`f82044a`)

*"I only get one or two balls from a tap way too often."* It was worse than that: a driver
who bumped the gate and **stayed** — which is what a driver does — got **nothing**. Measured
across five tap lengths pressed in close: **0 of 9 every time**, against 2/3/9/9/9 for the
same taps if the robot backed away.

The cause was the outflow block from `b37f3ba`. Its region carried a radius of slop around
the mouth, and at the gate that radius is exactly the difference between a robot whose MOUTH
is over the drain and one merely pressing the lever with the TIP of its intake — the chassis
front sits at the classifier edge, the intake reaches the rail line, and the padded roof then
covered the drop point. The standard technique read as parking on your own outflow.

The padding is right for LANDING (an artifact perched on the lip really does overlap the
roof) and wrong for asking whether the roof is in the way of something else, so
`intakeRoofAt` takes it as a parameter and the rail block passes **zero**. Parking the mouth
ON the drop point still blocks (0 taken, 9 left); pressing the lever no longer does (9 at
every tap length). Both are checks.

Also added: **above the mouth's opening the intake is not open.** `ballRobotContact` leaves
the mouth's centre clear because the rollers ride high and artifacts pass UNDER them — true
only of an artifact at ball height. One riding the ROOF is above the opening, where the
structure is solid; `ballRobotFrontContact` is that case. It matters because a roof-riding
artifact is in FLIGHT, and flight artifacts are not in the ground solve.

**Do not "release onto the roof" instead of blocking up-ramp.** Tried twice this session. It
makes a flight artifact beside a robot, and one drifted through a 4.6in gap between a robot's
corner and the wall — which is a bug report of its own, with a check. The note is in the
release code.

### The ramp is a 10-degree chute now, and 5-9 per tap is a BENCHMARK (`5fa9c18`)

*"I feel like the initial balls are too slow (or perhaps all of them, in general)."* They
were, and the first one worst of all: `RAIL_ACCEL` 25 is a **5.2-degree** ramp, so a column
starting from rest took **0.70s** to put its first artifact out, at 18 in/s. That value was
set when the ramp stopped running at a capped flow speed — the cap used to hide the slow
start.

`RAIL_ACCEL` **50** is a 10.5-degree chute, the sort of slope you would build for a gravity
feed that has to start a stationary ball reliably. First artifact out at **0.48s at 24 in/s**,
all nine clear in **1.65s** (was 2.37s), arrival gaps 0.25 → 0.10s.

**Three constants that were sized against the old ramp are now DERIVED from it**, so the next
slope change carries them instead of silently breaking the balance:

| | |
|---|---|
| `OVERFLOW_ROLL_LOSS` | `0.36 · RAIL_ACCEL` — the ride keeps its 0.8 speed ratio |
| `OVERFLOW_BUMP` | `0.48 · RAIL_ACCEL` — the scallop stays under the net pull |
| `GATE_GRAVITY` | `(1 − PASS) · RAIL_ACCEL / (0.74 · RAIL_PITCH)` |

That last one is the fall-to-pass vs one-pitch-from-rest relation the suite already checks,
solved for gravity: the ratio stays **0.86 at any slope**, which is what keeps a tap worth
something.

**THE BENCHMARK — "on a gate tap, 5 to 9 balls must release" — is a check now**, over 30 taps
(three packings × five tap lengths × two standoffs): worst 6, best 9, mean 8.8. `GATE_KNOCK`
0.06 → **0.05** is what puts the spread inside the band rather than pinned at 9; at 0.04 the
worst case falls to 4 and it fails. **Do not tune the gate without re-running it.**

The packing-variety check it replaces asked the yield to depend on how tightly the column was
packed — true on a 5-degree ramp where the flow was marginal enough for spacing to decide
whether it sustained. At 10.5 degrees a firm tap carries any column (loosening the pitch by
8in changes nothing) and what varies is the tap.

### Three from one session's play (`0ae0db6`, `1f8b612`, `907a90f`)

**A funnel intake collects a corner artifact** (`0ae0db6`). A wedge preset only swallows at
the THROAT and the suction walks the artifact there — which works in open field and cannot
work in a corner. An artifact tucked against two walls sits 2.5in off each, and what decides
how close the robot can get is its own chassis half-width (9in), so it ends up ~6.5in off the
mouth's centre: outside a 3in throat, unmovable. Putting the throat on it means putting the
chassis through a wall. A real funnel pressed into a corner does collect it, so a wedge now
takes an artifact inside its MOUTH (not merely its throat) that is pinned against the field
boundary, at the slow end of the timing. `INTAKE_WALL_GRAB` is deliberately tiny — this is
"against the wall", not "near the wall". Measured in the audience corner: sloped 0.35s /
triangle 0.30s along the wall, 1.18s / 2.87s on the diagonal. Vector is unchanged (its wheels
already span the mouth; its answer to an off-centre artifact is the flank grab).

**An artifact needs ground to drop onto** (`1f8b612`). The outflow block tested the mouth
UNPADDED, so an artifact only needed its CENTRE outside the intake — it could be set down half
inside one and taken. The rule is about the artifact's own footprint: the drop point needs a
full RADIUS of clearance, exactly as it already needs from a chassis. The lenience is the
front of the rollers and nowhere else (`INTAKE_CATCH_LENIENCE`, "if the ball drops on the very
front edge of the intake rollers, they can suck them in due to compliance"). Swept by tip-to-
drop-point distance it is a clean step: **1.0in clear → 0 taken, 9 left on the ramp; 1.5in
clear → they land and feed.** That front lenience is also what keeps a lever-pressing robot
from plugging its own drain.

**The beam curb no longer teleports** (`907a90f`). Measured, a mecanum driving diagonally over
a beam: **3.44in of position in ONE tick** against the 0.45in its velocity could account for;
8 of the swept crossings jumped, all mecanum (the only drivetrain with the strafe curb). Two
causes, both in `strafeCurb`/`beamStrafeBlock`:

- the straddle guard wanted a wheel a full WHEEL RADIUS past the far face (3in past centre).
  Mid-crossing `side` flips as the BODY passes the centre, the wheels behind become far-side
  wheels with a small negative `rel`, and the curb fired on a robot half way over and shoved
  it the rest of the way. **A wheel past the far face** is the honest test.
- the correction was unbounded, though its own note calls it a slop clamp. `CHAIN_BEAM_CURB_SLOP`
  caps it at **0.35in per tick**. Worst overshoot after: 0.16in, and the curb still parks the
  leading wheel exactly at the near face — over three ticks, which is what a clamp looks like.

### Four more from play, and one question left open

**A robot has a TOP** (`6f10fb5`). *"If an artifact lands on top of the robot and I move away,
they jolt."* The intake got a roof earlier; the CHASSIS did not, so an artifact coming down on
one fell into it and was ejected out the nearest FACE — measured, dropped on the middle of an
18in chassis it moved **9.8in sideways in ONE tick** and was then shovelled along to 76 in/s.
`robotTopZ` is the top (roller structure over the intake, robot height over the chassis). The
throw was also floored against the artifact's WORLD velocity, which says the roof is the field;
flooring the RELATIVE velocity makes it an artifact on a moving surface, so nothing steps when
the roof runs out. `ROBOT_TOP_SHED` walks it off the side it landed nearest — a FLOOR, never an
addition (adding per tick is 360 in/s² dressed as a nudge). Shots are unaffected: a robot
anywhere in the lane still lets 3 of 3 through.

**Overflow rides the column** (`c147af5`). *"They ride on top of the balls already in the
classifier, so it would move kinda like in steps, and it would get extra momentum from the
balls if the gate is open."* The rider had no idea what it was on — it took the RAMP's gravity
less a rolling loss and arrived faster than the column it was riding. `OVERFLOW_CARRY` is
rolling contact: its speed is dragged toward the speed of the artifact beneath it. Shut gate ⇒
stationary column ⇒ dragged to a crawl, and only the small leftover pull walks it over the
crests (the stepping). Open gate ⇒ the column's momentum is handed to it. `OVERFLOW_ROLL_LOSS`
0.36 → 0.88 of RAIL_ACCEL and `OVERFLOW_BUMP` 0.48 → 0.10 set that leftover. **0.0in of travel
in 2s shut, 10.2in open.** Three checks had to be told which case they ask about.

**Jitter** (`6de591c`). Swept the contact situations where it hides, measuring reversals/s on
anything with under 2in of net movement and visible amplitude. **Robots are clean everywhere.**
Artifacts were not, and the cause was correction SIZE: separation took out an overlap entirely
in one pass, which overshoots whenever another constraint disagrees — against a wall, always.
`BALL_SEPARATION_RELAX` (half per pass, `BALL_RELAX_PASSES` 4 → 6) plus `BALL_SETTLE_SLOP` (a
resting artifact away from robots that ends the tick within 0.2in of where it started, ends it
there). Six of seven scenes clean at 0.8/s.

⚠️ **STILL OPEN**: an artifact squeezed between a driving robot's INTAKE and two walls rings at
1.48in, 4 reversals/s (down from 15). Three narrower fixes all made something else worse and
are recorded in the check: extending the jam rule to any solid part of the robot let artifacts
through a corner gap they cannot fit; rate-limiting the eviction took it to 25/s; reverting
resting artifacts near a robot lets a robot creep through one. Bounded so it cannot regress.

### The gate torque, answered — and the square-up bug it uncovered (`b422a7e`)

*"The intake is part of the contact area."* That settled it, and wiring it up turned out to
depend on a second, larger bug.

**The intake is contact area.** Every contact test in `squareUpStatics` was built from
`robotCorners` — the CHASSIS — and the gate is pressed with the INTAKE: the chassis's
front-most corner stops half an inch short of the stub the robot leans on. The handle now
reads the FOOTPRINT (`footprintCornersOf`, `footprintMTV`), grown by the touch epsilon because
Rapier leaves a hair of separation and a strict overlap test fires never. Where a robot's front
EDGE rests on the 2.5in stub with no corner in it, the contact is the stub's own corner digging
into that edge — the nearest point ON the stub sits dead ahead of the robot's centre, where the
lever arm is zero and the torque with it, which is why the first attempt measured identical to
having no code at all.

**And the bug that made it look like a trade-off.** *"Even when I ram with the back of the
chassis where there is no intake, the robot only turns if I impact it at certain specific
angles, weird."* The classifier passed `contacts.length > 1` as its square-to flag, so a
single-corner press took `applyContactTorque`'s PIVOT mode — which has no flush cap and spins
instead of settling. A flat face aligns a chassis whether one corner is on it or two; the walls
have always passed `true`. **Across ten approach angles, front and back, the classifier now ends
0.0° off flush at every one.**

With that fixed the gate torque costs nothing: the tap benchmark is back to **worst 6 / best 9**
and GATE INTAKING drains **9 of 9** with the hopper full — they were 4 and 1 when the torque was
first tried against the pivoting classifier. So the "arm can push you straight OR you can gate
intake" trade-off recorded in the previous handoff entry was an artifact of the pivot bug, not
a real choice.

⚠️ The 360° turns this first appeared as were a MEASUREMENT artifact: the sim wraps the heading,
so a raw delta reads as a full turn. Measure the remaining tilt mod 90 instead — the check does.

### The gate torque, actually applied — and the SAT normal that hid it (`73b3ac7`)

*"Still no torque being applied at gate."* The contacts were being found: torque 0.26, press
5.9, and the heading did not move a hundredth of a degree in four seconds.

**The reason is the NORMAL.** SAT returns whichever of its four candidate axes overlaps least,
and two of those are the ROBOT'S OWN. When it picks one, the normal comes back aligned with the
chassis — and `applyContactTorque` measures "how far from flush" against that normal, so the
answer is **zero by construction**. The stub is axis-aligned, so its face normal is the axis
from its centre to the robot's, snapped to the dominant component. Pressing the gate at ten
tilts from −20° to +20°: **every one ends 0° off flush**, where before nothing under 12° moved.

Each contact also carries its **own depth** now. Handing both stub corners `mtv.depth` makes
them symmetric about a robot pressing square-on, the cross products cancel, and the torque is
zero — which is why it only ever turned at big tilts, where one corner falls outside the band
and stops cancelling the other.

**Worth remembering generally:** a torque built on a SAT normal is measuring against a
direction that may be the robot's own. Any future contact-torque surface needs the STRUCTURE's
normal, like the walls have always used.

### A pile outside the gate no longer throttles the ramp (`73b3ac7`)

*"Ball flow gets slowed down if there are balls right outside the gate. Don't let it slow
down."* The doorway artifact was part of `canLeave`, so what was already on the floor gated the
discharge:

| artifacts piled outside | 0 | 6 | 10 | 14 |
|---|---|---|---|---|
| nine out, before | 1.65s | 1.88s | 2.07s | **2.20s** |
| after | 1.47s | 1.48s | 1.48s | **1.48s** |

A chute does not ask the heap whether it may discharge — what comes out shoves what is there,
which is what the exit nudge is for. The mouth is clear unless a ROBOT is across it. **The
invariant that mattered is untouched**: the solver and the release still agree about what stops
the column (the robot, and nothing else), so nothing can descend past an exit that then refuses
it.

### One check changed MEANING, not value

Pressed hard on the lever at 19° — the pose reported verbatim from play — the arm now squares
the robot to 0° and its mouth lands over the drop point, where the drop-space rule holds the
ramp. Backing off enough to clear the drop point also stops holding the lever (gatePos 0.22 at
2in back, 0.00 at 4in). **That is two requested rules meeting, not a regression**, and the
check says so at length rather than being deleted. Gate intaking itself is alive: the other
gate-intaking check drains **9 of 9 at a 0.119s mean gap**.

### ...at the arm's pace, not the field's (`ec806b8`)

*"The gate applies way too much torque way too fast."* Measured: **20° off flush to square in
167ms**, which is a whip, not a lever.

The rate was the WALL's. A wall is the field and may square a chassis as fast as it likes; the
handle is a 2.5in hinged bar. `GATE_ARM_TORQUE_MULT` was scaling the PRESS term — which only
feeds the pressure gain and barely moved the result — and now scales the RATE, which is the
thing that was wrong. Direction and the flush cap are geometry and are untouched. At **0.12**,
20° comes square in **1.25s**: a firm nudge you can drive against.

Two checks moved to the measured behaviour rather than around it:

- the arm holds contact for a second and a half while it turns you, over which the chassis
  settles **1.30in** further out as the rotation resolves. That is the rotation, not a shove —
  the shove that check was written for was 3.85in — so its bound went 1.0 → 1.5.
- the 19° GATE INTAKING pose discharges into the angle it still has while the arm works on it,
  so **one** artifact gets out before the mouth closes over the drop point. What must not
  happen is the ramp emptying, and that is what it asserts now.

### A contact squares you up; it does not snap you round (`bfa0a26`)

*"It is still WAY too fast. It spins me around like 90 degrees instantly."* Two things were
doing it and **neither was the gate**:

- **The align ceiling.** `CONTACT_PRESS_GAIN` scales the align rate with how hard you press, up
  to `CONTACT_ALIGN_RATE_MAX` — which was 0.12 rad, **6.9° in ONE TICK, 412 deg/s**. A firm
  press quadrupled the base rate into a snap, on every structure in the game. At **0.05** the
  worst single tick ramming a wall at speed is 2.9° (174 deg/s) — about what a robot turns
  itself — and 20° still comes flush in well under a second.
- **The flick.** `CONTACT_IMPACT_SPIN` adds angular VELOCITY on a fast angled hit and, unlike
  the alignment, is NOT capped at the remaining tilt — it keeps turning the chassis after the
  contact is done. Wall ram peak spin **3.23 → 0.80 rad/s**.

It was also not scaled by the surface's rate multiplier, so slowing the gate arm's alignment
left its flick at the field's rate — the one part of the arm that could still whip you was the
only part still running full strength.

*"If I hit with the gate opener the robot doesn't turn, if I hit with the intake it turns
insanely fast"* — both halves gone: hitting the arm at five offsets across the mouth turns
17–20° and ends flush, worst single tick 3.2°.

The classifier grind-jitter bound went 15 → 20 jump-frames, which its own note anticipates
("legitimately shifts when contact tuning changes") — a robot that squares up more slowly
grinds at an angle for longer. Worst single jump unchanged at 2.45in against a 2.5in bound.

### The wrong-way turning: analysed, and it was the load sharing (`2de7310`)

*"It's turning me the other way sometimes. Fundamentals. Analyse."*

**One line.** The contact list is every corner within `CONTACT_TOUCH_EPS` (half an inch) of the
surface, and the load was shared as `depth + CONTACT_BIAS`. **That floor is a vote for corners
that are not touching.**

It reverses the torque because the two front corners are NOT mirror images — the intake extends
the front, so a tilted chassis presents corners with different lever arms. Measured at 3° off
square against a wall: the bearing corner's lever is **7.70**, the corner half an inch clear is
**8.78**. Weighted 0.6 and 0.2 by the floor, the fabricated vote takes 40% of a longer arm, and
past some tilt the sum points the wrong way. *Sometimes.*

`CONTACT_COMPLIANCE` replaces the floor: bumpers squash, so the share is how far each corner is
compressed relative to the deepest — full load there, nothing beyond half an inch of it. A
corner that is not touching carries no load, which is not a modelling choice. Square on, the
bearing corners compress equally, the moments cancel, and the robot settles — the same
equilibrium, now for a reason.

| approach | result |
|---|---|
| wall, every tilt −6°…+12° | **0.0° off flush** |
| gate, every tilt −12°…+12° | **0.0° off flush** |
| gate, hit 5in off centre with one side | **0.0° off flush** |

**The gate cases are the ones that used to do nothing at all**, and it was the same bug: its
contact set is the STUB's two corners, symmetric about the robot's centre line, and the floor
weighted them so evenly they cancelled to a torque of **0.003** — "no torque at the gate" —
while a hair more tilt let one escape the band and it snapped. Both complaints, one cause.

### ⚠️ The response is STILL a heuristic — the physical model, measured, not yet in

Separate from the above, and still true: `applyContactTorque` scales a "torque" by a tuned
gain, caps it at a tuned ceiling, WRITES the heading, and clamps against a mod-90 target. The
physical model was built this session and reverted; keep these findings:

    tau = sum r_i x F_i ;  alpha = tau / I ,  I/m = (l^2+w^2)/12 ;  |j_t| <= mu*j_n

1. **Mass cancels** — impulse `m·press`, inertia `m·(l²+w²)/12`. How far a hit turns you is the
   geometry of the hit, not your weight.
2. **The impulse that stops the CONTACT POINT** is `m·v_n/(1 + (r×n)²/(I/m))`; without the
   `moment²` term a 40 in/s ram peaked at 9.6 rad/s.
3. **`press` is a force reading, not an impulse** — a robot held at a wall reads 22 in/s of
   approach every tick, i.e. 3.4 g sustained. It must be `(postVel − preVel)·n̂`.
4. **The torque must turn the CHASSIS, not `angVel`** — `updateRobot` servos `angVel` to the
   commanded yaw, so the two cancel.

With 2+3 fixed a 20° wall hit squares perfectly. It was reverted because small angles rock:
the eps-banded list picks ONE corner, a firm impact rotates 4.6° against a 3° error, the far
corner takes over, ±9°. **The fix is the contact SET, not the response** — both corners with
true signed depths, a proper 2-point solve. The compression weighting above is the first half
of exactly that.

### The ramp has a delivery speed, and a hard hit is an impulse (`52ac706`, `19ee488`)

**"The balls get supercharged and dash down if I gate intake — since the torque change."** It
was: the same commit stopped the pile outside the gate throttling the discharge, and with
nothing taking anything back the last artifacts off a full column ran all 59in of ramp
unopposed and left at **69 in/s**.

`RAIL_ACCEL`'s note is right that ROLLING resistance does not grow with speed — but rolling is
not all that happens. The channel is a 6in groove around a 5in artifact, so it weaves down it
(`railWander`), and the faster it goes the harder it works the walls. **That** loss grows with
speed, and it is what gives a chute a delivery speed. `RAIL_RATTLE_DRAG` 1.1/s puts it at
`RAIL_ACCEL/1.1` ≈ 45 in/s.

| | before | after |
|---|---|---|
| exits off a full column | 24..**69** in/s | 20..**39** in/s |
| first artifact out | 0.53s | **0.53s** (untouched) |
| all nine clear | 1.9s | 1.9s |

The START is untouched because it is a DRAG, not a cap — an artifact at rest has no speed for
it to take. An ELEVATED artifact is exempt: it rides the column, not the channel.
`GATE_KNOCK` 0.05 → **0.085**, because a slower flow hands the arm less momentum and the tap
benchmark fell to a worst of 3; at 0.085 it is worst 6, best 9, mean 8.8.

**"Even if I hit it with a large impact it doesn't turn me."** The impulse a collision hands
the chassis lived inside an `else if (flushErr > 0.05)` — so arriving fast and nearly straight,
the case where a hit is most obvious, produced nothing. It is its own term now, with two
guards that are both the alignment cap's own argument (*a surface cannot turn a robot into
itself*): the ALIGNMENT may only reduce the tilt, and the IMPULSE is guarded against the TILT
rather than against `align` — comparing it to `align` passes trivially whenever `align` has
been zeroed for pointing the wrong way, which is exactly when it is needed.

Run-up rams at −20, −8, −3, +3, +8, +20° now all end **0.0° off flush**, wall and gate. Worst
single tick 3.0°, peak spin ~1 rad/s.

⚠️ **Tried and reverted within the hour**: reading `press` as the momentum the solve actually
removed, rather than the approach the drive is holding. It is the better measure of an IMPACT,
and it is **zero exactly when the settling torque is needed** — a robot already resting on a
wall has no approach left to take — so a robot leaning at an angle just stayed there. The note
in `pressAlong` records it.

⚠️ **A probe hazard worth remembering**: parking artifacts "out of play" at (300,300) does not
work — the ground clamp snaps them back inside the field, often right where the robot under
test is about to ram. Two wrong-way diagnoses this session were pinned artifacts, not the
surface. Set them `held` instead.

### The gate handle is a POINT, so it pivots you (`fea5c1a`)

*"When I hit the gate with the leftmost or rightmost side of the robot, I should be turning but
I square up instead."*

Every other surface in the square-up pass is a **face** — wall, goal face, classifier side — and
a chassis pressed on one bears on two corners whose moments cancel when it is flat against it.
Flush is where it settles; that is why they pass `squareTo = true`. **The gate handle is 2.5in
of bar.** Nothing about it can align an 18in chassis, and asking it to was the bug.

A point contact has an equilibrium of its own and needs no cap to find it: the moment is
`r × n`, which vanishes when the contact comes to lie on the line through the robot's centre
along the push. Lean on the arm off-centre and you turn about it until it is dead ahead;
arrive centred on it and you are not turned at all.

| arm off the robot's centre line | 0in | 3in | 6in | 8in |
|---|---|---|---|---|
| turn | **0°** | 24° | 57° | 57° |

**This is the general rule the pass was missing**: ask a FACE about flush, ask a POINT about its
moment arm. Two checks were asking the gate about flush and are now one check about the pivot;
a third pinned a blocking robot's position but not its heading, and an unpinned robot now
pivots off the arm and stops blocking the outflow it was put there to block.

### No load, no torque (`3aa4697`)

*"Torque is being applied with me not doing anything."*

The response's gain was `1 + press * CONTACT_PRESS_GAIN`. **That floor of 1 means the geometric
torque alone rotates a chassis at ZERO press** — touch a surface and it turns you, with nothing
pushing.

Against a FACE it hides: the flush cap stops the rotation the moment the robot is square, so it
reads as settling. Against the gate handle it does not hide at all, because a point contact has
no flush to stop at. Measured: a robot **parked beside the arm and never given a command turned
359.6°** on its own; one that had driven in and let go turned another 35°.

The gain is `press * CONTACT_PRESS_GAIN` now, and zero press returns before anything is
written. Worst idle turn over four resting poses (parked at the gate, driven into the gate and
released, the same at a wall and at the classifier): **0.0°**.

**The GATE INTAKING pose has been through three states this session** and the current one is
the physical one — the check says so at length rather than being re-tuned:

| | ramp discharge |
|---|---|
| arm applied no torque, robot held 19° | 9 of 9 |
| arm SQUARED the robot → mouth over the drop point | **0 of 9** |
| arm PIVOTS (it is a stub, not a face) → robot keeps its angle | 4 of 9, hopper filling |

## Next steps

1. Play-test the drain by hand — both fixes are measured headlessly, and the feel of a
   tapped gate against a packed column is the thing worth eyeballing.
2. The rest of the standing list below is unchanged.

---

# HANDOFF — 2026-08-15 (superseded) (the classifier: possession, the gate, and the ramp) — alpha only

Branch **alpha**, commit `94e08ae` + UNCOMMITTED gate-cadence work (see "Drain cadence, part 2").
`npm test` ALL PASS (~237 checks) · `npm run build` green · **working tree DIRTY** — the
gate-cadence work is unstaged, awaiting review.
**Not deployed.** Production `dohun-sim-decode` is still on the pre-session build and
still owes the migrations listed under "Still pending".

Do not merge to main. Standing rule.

## Where the session ended

The last three fixes are all in the DECODE classifier, and the last one closes the loop
the user opened with *"make a FUNDAMENTAL change and make it correct FUNDAMENTALLY."*

### The ramp is now ONE physics (`20b97a1`)

`OVERFLOW_FLOW_SPEED` is gone. It handed overflow artifacts a fixed 16 in/s down a
separate code path, which is why they crawled and why an opening gate could not reach
them. Every artifact on the ramp now runs the same solver — gravity `RAIL_ACCEL`,
contact stacking, one queue — and `overflow` means only two things:

1. the scoring flag, still decided at first contact (unchanged), and
2. **height**. An artifact is `elevated` while anything retained sits below it. That
   costs it `OVERFLOW_DRAG` rolling resistance (terminal ride ≈ `RAIL_ACCEL /
   OVERFLOW_DRAG`, ~36 in/s against the clear ramp's 46) and exempts it from the gate.

It sinks the moment there is nothing left to ride on — so an opening gate drains the
column out from under it and it simply follows, at ramp speed, on the ramp. Nothing
about it was ever special except its height.

**The trap, which cost most of a session.** The rail solver has TWO constraints and they
are not the same kind of thing:

- the artifact **AHEAD** — unconditional, artifacts cannot pass through each other;
- the **BASE** (the gate, or an occupied mouth) — a floor only for artifacts *above* it.

Conflating them broke this twice. Both unconditional, and a base that MOVES (`canLeave`
flips as a robot turns near the mouth) dragged the whole column back UP the ramp in time
with the steering. Both gated on "was it above this last tick", and an artifact dipping a
hair below its neighbour free-fell through the entire column and out through a shut gate
(measured: id 906 passing s=2.5 at 46 in/s with its floor at 7.1). **That second failure
survived a full session of a green suite** — smoke never checked that a closed gate
retains anything. It does now: three checks that nine artifacts stay put for five
seconds, packed at exactly `RAIL_PITCH` against the gate, scoring nothing.

### The exit: where the ramp ends, and nothing more (`c65209a`, `d3442fb`)

An artifact leaving the ramp used to be handed a flat floor velocity on the tick it
crossed the exit, on a fan 10–29° off the wall — nine of them left on the same diagonal
at 46 in/s and ran out across the floor. That was *"hyper accelerated and all going
diagonally in one direction"*.

**Two attempts at the drop are recorded here because both are instructive.** The manual
puts the gate's contact area 3.75–5.5 in up (9.8.3), so releasing it as a `flight`
artifact off a lip is the honest geometry — and it is wrong at 1:1. 3.75 in of fall plus
the bounces is **0.32 s of every artifact hanging in the air on the way out**, which does
not read as a ramp discharging; it reads as artifacts floating out of the wall. Charging
the drop's cost up front instead (multiply the horizontal by what a bounce keeps) puts
them on the floor but costs them **16 in/s on the tick they arrive** — precisely the
sudden step at ground contact that the release was rebuilt to remove, and there is a
smoke check for it.

So neither. The artifact lands immediately and keeps the speed the ramp gave it;
`BALL_ROLL_FRICTION` takes it out over the tunnel. Worst transition step is now
**1.33 in/s, exactly one tick of gravity**. The exit is not an event that does something
to the artifact — it is just where the ramp ends. `TUNNEL_EXIT_VEL.inward` stays at 4
(5–15°, down from 8) and the spread comes from artifacts caroming off whichever stopped
first. Measured over a full drain: within the **wall corridor** — gate, tunnel, or
loading zone — and 3–18 in off a 6.1 in tunnel.

`GATE_LIP_Z` is gone with the lip. If it comes back, note that `flight` requires a
`target`, which is meaningless for something falling off a ramp; it is read only by
`checkGoalEntry`, which also needs an UPWARD crossing of `GOAL_OPENING_Z` within
`GOAL_OPENING_RADIUS`, so an exiting artifact cannot re-enter.

### A robot's BODY is where the column stops (`d3442fb`)

Reported as *"balls can STILL pass through the robot when the robot is slightly blocking
the classifier"*, and it was one cause with the floating: **the classifier knew about
robots through a single point.** `exitMouth` tested `railPos(a, RAIL_EXIT_S)` and returned
a boolean, so a robot parked on the outflow stopped the flow while the column's floor
stayed at that fixed point — 7.3 in of artifacts sitting INSIDE the chassis, 1182 frames
of it. A robot 9 in to the side, touching nothing, blocked the whole ramp for the same
reason.

`railBlock` walks the rail line and returns the `s` a robot's body actually reaches; that
is the column's floor, for the elevated lane too (overflow rides over the retained column,
not over a robot). A robot WITH hopper room still collects the drain, now at its own
bumper — handing it over at `RAIL_EXIT_S` made the artifact travel the length of the
robot's footprint to get there, through the chassis.

Two things about that walk cost real time and should not be re-derived:

- **Its ceiling comes from the ROBOT's collision extents, not from the channel.** Bounding
  it at the classifier's gate end (s = 1) looks reasonable and is badly wrong: a robot on
  the mouth reaches s = 6.5, so the walk began already inside the chassis, stopped there,
  and put the floor 5 in inside the robot.
- **The floor is the sample the walk PROVED clear**, not the deepest blocked sample plus a
  radius — a radius along the rail is not a radius along the surface normal of a robot
  sitting at an angle, and that version still left 0.75 in of overlap.

Measured across five coverages from dead-centre to clear: **0.00 in, every one.**

### The rail is not a hole in the field (`3eb8521`)

*"They still often go past the field wall then teleport back in."* They did. The state
column is the whole diagnosis:

```
tick 223  rail    pos 69.0 -71.0     already past the wall (field half is 72)
tick 228  rail    pos 69.0 -74.8     still marching, still on the rail
tick 229  ground  pos 69.0 -75.6     released six inches outside the field
tick 230  ground  pos 64.9 -69.5     ground clamp snaps it back: a 394 in/s teleport
```

The rail is a scripted 1D flow with **no wall awareness** — the rail line simply runs on
past the audience wall — so nothing about being off the field stops an artifact. It got
there because the solver and the release disagreed about whether it could leave: an open
gate dropped the floor to `-Infinity` while the release refused on an occupied doorway,
and the `wasS >= base` exemption then freed it permanently. `mouthClear` decides that
once now, doorway included, for both; the release lets **one** artifact out per tick,
since the one it just released is the next doorway.

**The exemption was too broad**, and this is the part to remember. It exists for exactly
one case: a shut GATE must not reach back up for an overflow artifact that legitimately
dropped in below the gate line. Two floors have no legitimate "already past it" — *below
the exit* (off the field) and *inside a robot* (7.2in inside the chassis, the very thing
the body floor was added to prevent). Those two are solid and unconditional. Correcting
them means moving an artifact UP, which the solver refuses on purpose, so it is
rate-limited to `RAIL_PUSH_RATE`: a robot leaning into the channel shoves the column up
its ramp visibly instead of teleporting it.

Sealing the exit made the queue rate **real**, and it was bad: `EXIT_NUDGE` 0.5 crept the
doorway artifact out at 11 in/s, 0.9 s to clear its own diameter, a nine-artifact drain
taking 12 s. That throttle was always there — it was hidden because artifacts queued
BELOW the exit, off the field, and burst out together once it cleared, which is what
*"disperse outward at insane speeds"* was. At 1.0 the queue moves at the speed of the
flow pushing it (the only non-arbitrary value) and the drain takes 8 s.

## Slice 2 (scoped): the chassis is in the ball solve — DONE (`8d184f6`)

An artifact squeezed between a bumper and the classifier used to be resolved by two
position writes taking turns — the bespoke robot push drove it in (3.13 in), the static
eviction shoved it back out (3.70 in), on an artifact whose velocity was **zero**.
Neither pass was wrong alone; they could not see each other. Reordering and interleaving
them each bought under 0.2 in, because **a squeeze is precisely a constraint with no
one-contact-at-a-time answer.**

The chassis is now a **kinematic** body in `solveBalls`, so bumper, channel wall and the
other artifacts resolve together. Kinematic also hands you product decision #7's
"gate outflow can't shove a parked robot" for free. The **intake stays bespoke** — its
mouth is open by design (#10) and its funnel geometry is per-preset.

Measured, robot grinding a pile into the classifier corner over 8 s:

| | baseline | after |
| --- | --- | --- |
| corner pile | 2.88 in worst, **41** jump-frames / 480 | 1.84 in, **4** |
| mid-wall | 4.50 in, 6 frames | 4.50 in, 6 frames |
| open field | 0.00 in, 0 | 0.00 in, 0 |

**Three earlier attempts failed and are worth not repeating.** Kinematic chassis with the
feedback still running *after* the solve: the stall never fires, and a dead-centre
artifact squirts 34 in along the wall with the robot sailing through at 30 in/s. Heavy
**dynamic** chassis, reading back the velocity delta so the stall is emergent: it is not
— an artifact is ~0.3 lb against 20–42 lb and the drivetrain restores the loss the same
tick. Feedback moved before the solve but probing the pin at a **full radius**: nine
checks broke at once (intake capture, gate drain, G417/G418 counts, clump stacking),
because a radius-wide probe calls anything within 2.5 in of a wall pinned and robots stop
driving into things at all.

What made it work:

- `ballRobotFeedback` moves **nothing** — only `r.vel` — and runs **before** the solve. A
  kinematic body cannot be told it is blocked, so the robot has to be stopped before the
  solver ever sees the squeeze.
- It probes the pin against **this tick's push** (`approach·dt`), not a fixed distance:
  *can it move as far as I am about to push it?*
- **`clampBallPosToStatics` now includes the classifier channel.** Its absence is why the
  stall never fired there: the clamp knew only the perimeter walls and goal faces, so an
  artifact pressed on the channel was never seen as trapped. **Anything solid an artifact
  can be pinned against must be in that clamp, or the pin test cannot see it.**

### What is left

A rare spike at the channel **entrance** — 6 frames of 480, 4.50 in — on an artifact that
begins a tick already embedded in the channel, where there is no entry path to walk back
and the eviction falls through to pushing it out the nearest face by depth+radius. Not the
continuous jitter, which is gone. Fixing it properly means the artifact should never be
embedded at the start of a tick, i.e. finding what still places it there (it is not
`separateBalls` — disabling that changed nothing).

Still genuinely deferred: flight/basin/rail artifacts remain scripted, and the intake
funnel geometry is still bespoke. Porting the intake would mean re-expressing the capture
model, which assumes artifacts can occupy the chassis-front region a collider makes solid.

## G408: two things were counted that the robot does not control (`7470c0c`)

Reported as *"I get overpossession penalties when I am just intaking from a clump"* —
*"clump against a wall, specifically"*. Reproduced at **five MINOR fouls** for driving
into a wall clump with the intake running, while the hopper ended with a legal three.

- **What the FIELD holds, the robot does not control.** A pile jammed between a bumper
  and a wall goes nowhere, and the manual names the case: BULLDOZING is explicitly not
  control. Excluded when the field refuses the push — **transitively**, because a jam is
  (the front row touches the row that touches the wall), and from the **chain** as well as
  the seeds, since the chain clause asks for contact and nothing else.
- **An artifact being drawn in is not a fourth artifact.** `POSSESSION_LIMIT` and
  `HOPPER_CAPACITY` are the same 3, so a full robot cannot keep what is in its mouth —
  counting it charges the same limit twice. 173 of 272 confirmed frames in the reported
  scenario were artifacts queued in the mouth. Gated on the intake actually running; with
  it off, artifacts in the mouth are being scooped and still count.

5 MINORs → 0, hopper still filling, and every existing G408 check still passes.

### ...and then it never fired at all (uncommitted)

*"I never get overpossession pen anymore."* The mouth carve-out above is right in principle
and was written as a **REGION**: everything anywhere in front of the chassis, unbounded in
count, for as long as the intake button was held. Drivers hold that button essentially all
the time, so the rule stopped existing. Measured, identical drive into an identical
six-artifact pile on open floor:

| | intake OFF | intake ON |
| --- | --- | --- |
| full hopper, 6 artifacts | 7 MINORs | **0** |
| empty hopper, 9 artifacts | — | **0** |

The carve-out is about the artifact being **ACQUIRED**, and the reasoning that justifies it
("HOPPER_CAPACITY and POSSESSION_LIMIT are the same 3, so the slot already charges it")
justifies exactly as many artifacts as there are slots. So it is capped at
`HOPPER_CAPACITY − hopper.length`, nearest the chassis first (deterministic, id breaks
ties). A FULL robot with the intake spinning has room 0 and is excused nothing — which is
correct and is the clearest over-possession there is: it has nowhere to put any of it.

Now 7 / 5 respectively, wall-clump-with-intake still 0, and every earlier G408 check still
green. **That block ran green through the whole regression** because every G408 check either
had the intake off or put the clump on a wall; the distinguishing case — full hopper, open
floor, button held — is now checked both ways and asserted equal.

**A velocity test was tried FIRST and is wrong** — worth knowing, since it is the obvious
idea and the user suggested it. "Moves with the robot ⇒ controlled" gets both cases
backwards: a wall clump slips a median **3.5 in/s** against the robot while a **herded**
one slips **15.6**, because pressing a jammed pile stalls the robot (both near zero) while
a clump actually being pushed rolls and squirms the whole way. Artifact speed and distance
travelled separate them no better (open clump travels 43–68in, herding 49–66in).

## Drain cadence, part 1 (`dcaf1f5`)

*"The balls flow out at a weird slow cadence"* — 0.77 s between releases, mean-abs-dev
0.10 s. A metronome. Two halves: gravity over one `RAIL_PITCH` (~0.33 s, real) and the
doorway wait (~0.5 s). `EXIT_CLEARANCE` was 4.5 — nearly two diameters — swept honestly
but for bespoke ground artifacts, where releasing at one diameter left a 2.8 in overlap
spike. Re-swept now that artifacts are Rapier bodies: **worst clump overlap is 0.12 in at
4.5 / 2.0 / 1.0 / 0.0 alike.** At 1.0, releases are 0.60 s apart and a nine-artifact
column drains in 5.2 s instead of 6.3 s.

## Drain cadence, part 2: the paddle has weight (uncommitted)

*"When the gate is held open, there shouldn't be a cadence. When the gate is not held open
but was left open (e.g. tapped open), it would have a semi uniform cadence but it would
randomly stop if the momentum is not enough to keep the gate open."*

Measured before touching anything, and the reading is the whole diagnosis: **held open and
tapped open drained at 0.596 s and 0.598 s.** The same metronome either way. Whatever the
gate was doing, it was not the thing metering the flow — and it was not doing anything at
all, because a ball in the gateway simply FROZE `gatePos` wherever it happened to be,
which meant a tapped gate hovered at 1.0 (fully lifted, 77°) with artifacts rolling under
it touching nothing.

### What was actually metering it (`floorV`, seeded at zero)

Traced per tick, the cycle was entirely artificial and repeated exactly once per artifact:

```
0.533  front s=-3.87 v=-41.2   arriving at the exit at speed
0.550  front s=-4.00 v=  0.0   clamped — st.v = max(st.v, floorV) with floorV = 0
0.617  released                 speed = |v| = ZERO
0.617..0.950   doorway distance pinned at 0.02 in    it never moved
0.950  next artifact reaches the exit, EXIT_NUDGE creeps the dead one out at 22 in/s
```

`rampFloorV` starts at 0 for the frontmost artifact, and it is not resting on a wall — it
is resting on **another artifact that is rolling away down the tunnel at 30 in/s.** Zero
said otherwise, so every artifact after the first was stopped dead, released motionless,
became the obstruction for the next, and the column re-ran 0.33 s of gravity down one
`RAIL_PITCH` from rest, every single cycle. The floor now moves at the speed of whatever
is on it (`exitFloorV` = the doorway artifact's `vel.y`, and only while the gate is OPEN —
against a shut gate the floor is the paddle, which is going nowhere).

### The arm cannot hover (`GATE_RIDE_FRAC`)

Everything the user described falls out of one physical fact, with no special cases: an
unheld arm falls until it **lands on something**, and an artifact is a ball's worth of
lift and no more.

- **HELD** — a robot latches it at 1.0, clear of the flow. No contact, no drag, no cadence.
- **TAPPED** — the arm settles onto the stream at `GATE_RIDE_FRAC` and rides it. Its weight
  drags each artifact passing under (`GATE_PADDLE_DRAG`, scaled by `1 − gatePos`, which is
  why a held arm costs the flow exactly nothing), and it sags in the gaps, so the next one
  must shoulder it back up.
- **GIVES OUT** — the height an artifact can hold the paddle to is proportional to its
  speed (`GATE_SHOULDER_LIFT`). A column that has spread out can no longer lift it past
  `GATE_PASS_FRAC`, the arm settles, and the drain stops. Deterministic (no RNG — the sim
  cannot have any here) but scenario-dependent enough to feel like it just gave up.

Measured, nine-artifact column: **held 0.323 s mean / 0.073 mad, all 9 out in 3.0 s
(was 5.2 s); tapped 0.376 s / 0.144 mad, 8 of 9 out, arm riding at 0.449–0.62, then shut.**
A second tap clears the rest — it is a stall, never a deadlock, and there is a check for
that. Six new smoke checks cover the pair.

`gatewaySpeed` is deliberately a LOCAL in `updateGates`, not a `GoalState` field: goal
state rides the network snapshot, and a new numeric field is the exact shape of the
stale-server NaN bug in memory. It is recomputed from world state every tick anyway.

**`EXIT_CLEARANCE` was left at 1.0.** At 0.0 the held drain is smoother still (0.260 s /
0.048) — but the tapped drain then never gives out, and that is the behaviour being asked
for. It is a swept value from the previous session; do not churn it to buy cadence that
the paddle model should be providing.

### The arm rests ON an artifact, never between two (uncommitted)

*"When the classifier flow is stopped by the robot, the gate is always in between two
artifacts. This does not have to be that way."*

It was not a preference the arm had — it had **no idea what was underneath it.** With the
flow halted it fell straight to 0 THROUGH whatever sat in the gateway, measured at every
offset from +4 to −2.4 in: `0.000` every time. The ride model above was keyed on SPEED
alone, so a stopped artifact held it up not at all.

The paddle's edge descends the vertical at `GATE_LINE_S` (= `GATE_STOP_S − BALL_RADIUS`)
and lands where that meets the artifact's surface: height `R + sqrt(R² − d²)`. A full
diameter of clearance IS the pass height, so it maps onto `GATE_PASS_FRAC` with no constant
of its own — dead on top is exactly the pass line, the equator is half of it, and past the
artifact's edge the paddle misses entirely (which is why a column packed at `GATE_STOP_S`,
one radius clear, still reads as fully shut — that existing check was the load-bearing one).

**Which side it landed on is the whole outcome**, and measured it comes out clean:

| d (centre − gate line) | arm rests at | once the robot is gone |
| --- | --- | --- |
| +2.0 (not through) | 0.338 | wedged, stuck at s=1.31 |
| +1.2 | 0.383 | wedged, stuck at s=0.51 |
| −1.2 (mostly through) | — | **squeezed out**, arm shuts behind it |
| −2.0 | — | **squeezed out** |
| ±2.6 (beyond the edge) | 0.000 | paddle misses it |

`d > 0` is a wedge and needs its own clamp: the solver's gate floor sits at `GATE_STOP_S`
and an artifact the arm has landed ON is *below* it, hence exempted by `wasS >= base` — so
without it the thing rolled out from under a paddle resting on it. `d < 0` gets
`GATE_PADDLE_SHOVE`, the horizontal component of the paddle's weight, scaled by `d/R`. Only
the downhill half is applied; an up-ramp force would fight the solver's "never push it back
UP" invariant, and the block already does that job.

**The trap, which cost a red suite of fourteen unrelated checks.** `gateRestOn` returns 0
for *two different reasons* — "the arm is flat on the ramp" and "this artifact is nowhere
near the gate" — so `gatePos <= gateRestOn(d)` alone calls every artifact on the rail a
contact whenever the gate is shut. That froze the entire rail the instant the gate closed:
nothing reached the stack, nothing classified, and point-blank shots "stopped entering the
goal". The reach test (`|d| < R`) has to come first; `paddleBearsOn` exists so there is one
place that can be got wrong.

Also fixed a check that was measuring the wrong thing: comparing *mean gaps* between held
and tapped is a trap, because the tapped run gives out early so its mean covers only the
opening (fast) releases while the held mean is dragged up by the later ones, where a pile
has built outside the gate — it read as the tapped gate being FASTER. Do not restate the
claim that way.

### "The gate always empties all. I told you it shouldn't." (uncommitted)

It did, and the 9-stack check that "passed" was hiding it. Swept by column depth, a tap
drained **every column up to six artifacts** — and real ramps hold a handful, so in play it
always emptied. Two causes, and the second is the one that mattered:

**1. The tap latch pinned the arm at maximum lift for 0.5 s with nothing touching it.** A
hinged arm cannot do that. `GATE_OPEN_LATCH_S` is now the arm's mechanical OVERSWING (0.08 s)
and the arm is pinned only while a robot is genuinely on it; "stays open a beat" comes from
the FALL instead — ~0.23 s from full lift to the pass line, artifacts flowing the whole way.
Touch-hold is untouched and is what legitimately pins it. **This changes a documented product
decision** (CLAUDE.md updated): a tap still commits the arm fully open and you still do not
have to keep pressing.

**2. `GATE_SEAT_FRAC` — seated under the arm is NOT past it.** The geometry originally mapped
"paddle resting dead on top of an artifact" to *exactly* `GATE_PASS_FRAC`, on the reasoning
that a full diameter of clearance is the pass height. That is off by precisely the amount
that matters: resting on top is the MARGINAL contact — clearance is the ball and no more —
so with the arm's weight on it, it does not roll through. And because the gateway window
(8.5 in) is wider than the artifact pitch (5.1 in), a packed column ALWAYS has something
under the arm — so if being under it holds the gate exactly passable, a dense column keeps
itself flowing forever, which is what it did.

Seat is now 0.34 against a pass of 0.4, and getting past takes momentum:
`GATE_SHOULDER_LIFT` 0.045 → **0.016**, putting the threshold at ~25 in/s, inside the 20–46
in/s band the ramp actually produces. At 0.045 the threshold was 8.9 in/s — below anything
on the ramp, so every artifact cleared it and the rule never bit.

**`GATE_RIDE_FRAC` swept 0.44 → 0.62 changed nothing**, which is what pointed at the seat
height rather than the ride height. Don't re-sweep it.

Measured now: **hold drains 9/9; one tap drains 3 and gives out at every depth 5–9**, and
what a tap is worth varies with packing (3/3/2/2 at +0/1.5/3/5 in extra spacing) rather than
being a fixed dose. Both are checked, the depth sweep explicitly — a 9-stack stalling proves
nothing on its own.

### Earlier in the session

- **G408 over-possession** rebuilt on the manual's actual POSSESSION test (position in
  the robot frame, transitive chain from confirmed seeds) plus the real card model —
  MINOR **5** / MAJOR **15**, yellow at simultaneous 5 or three instances of 4+. The rule
  had been fouling the wrong robot and was switched off by a threshold set below its own
  signal.
- **The classifier ends AT the gate** — the rect used to run three inches past it and was
  drawn as a wall on the short end. Stroked on three sides now.
- **The mouth is a PLACE** — artifacts stop teleporting into a parked robot, and the
  doorway nudge sets a FLOOR on outward speed rather than adding every tick (it compounded
  to 91 in/s).
- **Chain Reaction**: flywheel launcher straddling the turret feed hole, beams apply yaw
  torque, mobile THROW button (hidden when the assist owns the action).

## Gotchas earned here

- **`npm test` passing is not evidence for anything it does not check.** Two of this
  session's three worst bugs were invisible to a green suite. Every behaviour the user
  reports twice now has a check; keep that up.
- **Probe, then change.** Several reports were refuted by measurement rather than fixed:
  the flick-shuttle carried 18 in for zero fouls where a shove carried 9 for three; chassis
  penetration by an artifact measured 0.00 in over 0 frames.
- The human player **restocks during teleop**, so any probe that measures "where the balls
  ended up" must filter to the ids it spawned. An earlier "max 148 in" reading was three
  loading-zone restocks, not drain artifacts.
- `Math.hypot` is banned in sim source by the smoke guard — use `hyp` from `src/math`.
  `Math.max/min/sign/PI` are fine.

## Open, not started

- **Ball/robot pass-through** — the classifier case is fixed and watched (`d3442fb`).
  The earlier "2.77 in penetration" reading was the intake mouth, which `ballRobotContact`
  leaves open *by design*; chassis penetration measures 0.00 in. If it is reported again,
  get the specific scenario rather than re-measuring the mouth.
- **Penalty hitbox audit** (roadmap #1) — the rules are right, the trigger volumes have
  never been checked against the manual figures.
- **Production deploy**: prod is on migration 0024; 0025–0029 plus the 08-07 spectating
  batch are pending. `./scripts/fly-deploy.sh` — **never a bare `flyctl deploy`**.
- Red cards are unreachable (G408 is the only card source and cannot issue a second
  yellow).
- "Replays for tank drive dont seem to be working" — `eb45f01` fixed recording; unverified
  end to end.
- `CLASSIFIER_W` 6 in vs `TUNNEL_W` 6.125 in — ⅛ in mismatch, noted, not changed.
- **At the alpha→main merge**: start a new Chain Reaction season from the admin menu.
  DECODE does NOT roll. Do not bump `BALANCE_VERSION`.
