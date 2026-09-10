# BIOBUZZ SHELL — handoff

Branch `biobuzz-shell` (cut from `biobuzz`, cut from `origin/alpha`). Nothing pushed.

What this is: a playable, **unscored** BIOBUZZ game module in `src/games/biobuzz/`, built by
copy-and-own from Chain Reaction, plus the tooling and the visual-feedback rig around it —
plan items 1, 2, 4, 5, 6, 7. Item 3 (the real `sim.ts` / `index.ts` replacing P0-core's
placeholders) is **not done, and cannot be**: see [Blocked on P0-core](#blocked-on-p0-core).

Every guessed number in `config.ts` carries an `APPROX` comment. Nothing here asserts a score,
a zone or an element count, because Sections 7–11 of the V0 manual are Kickoff placeholders.

---

## Commits

| | |
|---|---|
| `f8ecff1` | `scripts/manual.mjs` — fetch + text-dump an FTC game manual (item 1) |
| `169d61a` | the game tree, 21 files, copy-and-own from Chain Reaction (item 2) |
| `d88415d` | `scenes.ts` / `scenesField.ts` / `scenesRobot.ts` (item 4) |
| `810db3e` | `Gallery.tsx` — every scene, every still, the real renderers (item 5) |
| `118d8a9` | `scripts/shots.cjs` + the `shots` npm script (item 6) |
| `83585ba` | `scripts/smoke-biobuzz/` — field + server + robot lanes (item 7) |
| *(this one)* | what reading the screenshots changed — two real bugs and the sheet layout |

Two files outside my lane were touched, both one-line additions to `package.json`:
`"shots"` and `"test:bb"`. Nothing else outside `src/games/biobuzz/` and
`scripts/smoke-biobuzz/` was modified except `.claude/skills/verify/SKILL.md` (the recipe I
was asked to document) and this file.

---

## Blocked on P0-core

`src/games/types.ts:29` is still `export type GameId = 'decode' | 'chain'`, `World` has no
`biobuzz` field, and there are no `Builder` / `devRoutes` / `labels` / `hud` / `initialAct` /
`startPoseCount` slots. The `biobuzz` branch is still at `20e65a4` (docs only).

Consequences, all of them mechanical to clear:

1. **`tsc` reports exactly two facts, repeatedly.** `Property 'biobuzz' does not exist on type
   'World'` (hud, penalties, play, scenes, scenesRobot, step) and `'biobuzz' is not assignable
   to GameId` (spawn ×2, plus the smoke suite's comparisons). Nothing else. That was kept as
   the signal: any THIRD kind of error is mine.
2. **Item 3 is deferred on purpose.** An object literal typed `GameSimModule` today would
   produce excess-property errors for `initialAct` and `startPoseCount`, which would bury the
   signal above. The module's real `sim.ts` / `index.ts` should be written immediately after
   `git merge biobuzz`, resolving conflicts in favour of the real module:
   `scored: false`, `startLegality: false`, `initialAct: 2`, `startPoseCount: 2`, every UI slot
   filled, `devRoutes: [{ path: '/biobuzz/gallery', Component: BiobuzzGallery }]`.
3. **7 of the 268 smoke checks are red, all for this reason.** `moduleFor('biobuzz')` falls
   back to DECODE, so the four registry checks, the snapshot game tag, the server-registry
   `scored` check and the room-perf ratio (which is comparing a DECODE room to a Chain Reaction
   room) are measuring the wrong game. They go green on the merge — the room-perf one is the
   only one worth re-reading afterwards, since it will then be a real measurement.

### Three requests for core

- **`RobotState.catalystRail` should be optional.** BIOBUZZ has no catalyst, but the shared
  `RobotState` requires the field (`worldHash` and the snapshot diff both read it), so
  `spawn.ts` writes `catalystRail: 0` with an INERT-BUT-PRESENT comment. Making it optional is
  the real fix; a missing field is a type error at best and a NaN in the hash at worst.
- **Fold `coerceBiobuzzSpec` into `coerceSpec`.** Two edits in `src/sim/spawn.ts`: add a
  `game === 'biobuzz'` arm that runs this game's size/mass/storage/mount clamps, and exempt it
  from the `game !== 'chain'` mount reset at line ~330. Then
  `src/games/biobuzz/robotConfig.ts`'s `bbCoerceSpec` collapses to a single `coerceSpec` call
  and `scripts/smoke-biobuzz/harness.ts`'s `bbCoerce` becomes that call directly. Every
  existing check keeps passing — they were written against the contract, not the plumbing.
  **This is not cosmetic**: see [the mount bug](#2-every-launcher-mount-collapsed-to-the-front).
- **A seam to inject a world into `GameController`.** It builds its own world from
  `moduleFor(gameId).createWorld` with no injection point, so the gallery's drivable view
  (`LiveScene`) runs the SHARED `Renderer` + SHARED `InputManager` over a scene world it steps
  itself, and prints the module's own `hud()` slice as text instead of the real HUD. With a
  seam it would be the real game screen on a scene world, which is what the cell is for.

---

## What reading the screenshots changed

Recipe and gotchas are in `.claude/skills/verify/SKILL.md`. Two runs of
`npx electron scripts/shots.cjs` (140 PNGs each, 70 cells × 2 themes) found two real bugs, and
neither was visible in any test.

### 1. The plow gained on a POLLEN at speed

`src/games/biobuzz/play.ts`, `interact()`. A ground POLLEN inside the chassis was pushed out by
a **fixed 0.6" per tick**. A robot at 50 in/s advances 0.83" per tick and one at 80 in/s
advances 1.33", so the frame gained on the ball every tick and eventually contained it: in
`corner-pile@120` and `pile-fast@30` the pollen centres were a full radius INSIDE the chassis,
i.e. being carried around inside a robot. Now the push resolves the whole penetration depth
(plus `PLOW_EPS`), which is what the pollen-vs-pollen separator already did. Measured, in the
worst cell: **1.50" → 0.34"**, and 0.34" is a ball genuinely squeezed between a frame and a
wall.

### 2. Every launcher mount collapsed to the front

`src/games/biobuzz/robotConfig.ts`, new `bbCoerceSpec`. The shared `coerceSpec` resets
`intakeMount` and `shooterMount` for any game it does not recognise — correct for DECODE (those
fields move the collision footprint), and BIOBUZZ is one of those games until the arm above
lands. So **every turretless build spawned with a front drum whatever edge was picked, and
every turret was bolted to the front whatever the nine positions offered.** The 26 archetype
sheets rendered as 26 copies of two pictures, which is how it was found — and every one of
those sheets hashed identically, which is why no determinism check caught it.

`bbCoerceSpec` re-arms the raw mount fields between the shared pass and this game's pass. That
is sound rather than a bypass: `coerceBiobuzzSpec` is the authority on those fields for this
game — it enum-checks them, folds a corner mount off a turretless launcher, re-derives the size
envelope from the intake mount, and re-mirrors the legacy booleans. It is also idempotent,
which the smoke asserts over a hostile input matrix and over all 26 builds.

### 3. The hopper held thirty-nine POLLEN

`src/games/biobuzz/config.ts`. `BB_STORE_AREA_PER_BALL` was 2.67 in² with a ceiling of 122 —
numbers carried over from a game whose element is much smaller. `launch-wall-bounce@45` dumped
a full hopper and drew a single-file line of pollen along the entire 144" wall, because
thirty-nine 3" balls is not a hopper, it is a third of the field's supply riding inside one
robot. Retuned to one layer at 12 in² apiece (a 3" ball needs ~9 in² of floor; hex packing is
7.8 and nothing packs perfectly) with a ceiling of 24, which puts a 15×17 turret at 9 POLLEN
and an 18" open dumper at 20. **Still a guess** — Section 7 could move the diameter, and this
is one constant.

### 4. The archetype sheets were unreadable, three ways

- Three robots placed along world **x** stacked VERTICALLY, because every cell draws at the
  blue drive-station view angle where +x is screen-down. They stand along **y** now and read
  left-to-right, smallest chassis first.
- The sheet canvas framed the whole 144" field to show three 15" robots. `fitCell` takes a zoom
  window; a sheet uses ±48".
- Three fixed-width previews overflowed a grid column and the third had its own dimension label
  sliced off. `BiobuzzRobotPreview` grew a `fluid` prop, and the sheet cell takes the whole grid
  row with the canvas and the previews side by side. **That last part is a screenshot
  constraint, not taste**: `capturePage(rect)` clips to the viewport silently and a window
  cannot exceed the display, so a stacked 1100px cell lost its previews off the bottom of every
  archetype PNG.
- A sheet robot's turret is aimed along its chassis heading (`makeBiobuzzRobot` aims a fresh
  turret at field centre, so three robots at three places spawned with three turret angles).

---

## The cells to look at

`scratch/shots/<sha>/index.html` is the contact sheet; `scratch/` is gitignored, so re-run
`npm run dev` + `npx electron scripts/shots.cjs` to regenerate. In rough order of what is worth
your time:

| cell | what to check |
|---|---|
| `archetype-drum-right@0`, `archetype-turret-backleft@0` | the mount is where the name says, in BOTH the sprite and the preview. These two are the proof that bug #2 is fixed — before it, every archetype cell was the same picture. |
| `archetype-*@0` (26 of them) | one sprite bug lives in exactly one combination. Corners, flanks, and the twin turret's second shooter. |
| `corner-pile@120`, `pile-fast@30..120` | no POLLEN inside a chassis. Bug #1's cells. |
| `settle-60@0` vs `@300` | a NULL TEST — must be the same picture. It is, to zero displacement. |
| `intake-line@45..240` | the caption's `held` count steps up exactly as pollen leave the line: the drawn mouths ARE the capture areas. |
| `launch-wall-bounce@20..240` | where pollen leave from, the arc, the wall bounce (`BB_POLLEN_WALL_REST` is a guess and only a picture judges it). |
| `squeeze-2robots@90` | a POLLEN squeezed between two robots must pop out, not vanish. It does; the count in the caption is the proof. |
| `spawn-default@0` | four robots at two mirrored anchors, 60 pollen. 1.5" of wall clearance at the anchors — tight, and asserted in smoke. |
| `field-labelled@0` | the 24" POLLEN ruler on both axes. This is what to measure other cells against. |
| `wall-row-sweep@60..300` | a sweeper running along a wall — where a plow and a wall clamp fight. |

---

## Gates

| gate | result |
|---|---|
| `npm run test:bb` (new) | 268 checks, 261 pass, 7 red for the P0-core reason above |
| `npm test` | no new failures — the run log is in the session transcript |
| `npm run build` | **RED, and only for the P0-core reason**: `tsc` reports `Property 'biobuzz' does not exist on type 'World'` (scenes ×2, scenesRobot ×2, step ×2) and `'biobuzz' is not assignable to GameId` (robotConfig, spawn). Eight errors, two facts, both core-owned. `vite build` is never reached because `build` is `tsc && vite build`. Clears on the merge. |
| `npm run server:check` | PASS |
| `npm run uiaudit` | PASS. It scans `src/ui` only, so `src/games/biobuzz/*.tsx` is not audited — the gallery uses `ds-*` classes throughout anyway, with three inline `style` objects, each carrying the reason a class could not do it. (The run reports `off-grid-gap` one better than BASELINE, in `src/ui`, which this branch does not touch.) |
| `npm run contrast` | PASS — 221 checks across light + dark |

`docs/biobuzz/baseline-alpha.md`, named in the plan's `npm test` gate, **does not exist in this
repo** — so "no new failures vs the baseline" was checked against the `npm test` run itself
rather than against a recorded list. Worth creating before the next lane starts.

---

## Known gaps, deliberate

- **`solveBalls` uses `C.BALL_RADIUS` (2.5") for a 3" POLLEN.** The Rapier arm of the ball
  solver is shared and takes its radius from the DECODE constant, so the `rapier` solver
  separates pollen at the wrong size. The bespoke arm (the default, `BB_BALL_SOLVER`) uses
  `BB_POLLEN_R`. Both arms are built and both conserve POLLEN over 600 ticks, which is what the
  smoke asserts; making `solveBalls` take a radius is a core-owned one-liner.
- **`coerceBiobuzzSetup` replaces the shared `coerceSetup` rather than calling it.** The shared
  one clamps `startIndex` to DECODE's 5 anchors and repairs a custom pose with DECODE's G304
  geometry; BIOBUZZ has two anchors and `startLegality: false`. Everything `coerceSetup` does
  that is NOT DECODE-specific is done — alliance, startIndex, startPose, autoPath (with
  `autoPathEnabled` forced false when there is no usable path), assists. Chain Reaction skips
  all of it, which is a known gap in CR and deliberately not copied.
- **`mountsClash` is not used between the sweeper and the launcher.** They live at different
  HEIGHTS: a front sweeper feeding a front drum is the most common FTC layout there is, not a
  conflict. The builder offers every combination and the coercer keeps every combination. The
  function stays because it is the shared mount algebra and `occupiedCells` should have one
  owner.
- **`scoreTargets()` returns `[]`, so `bbAimHeading` and `bbAimAssist` are never exercised with
  a real target.** Written and wired anyway, so the first target Section 9 publishes is a return
  value and not a new pipeline stage.
- **`scratch/gallery.html` + `scratch/gallery.tsx`** are a gitignored scratch mount for the
  gallery, so shots could be taken before `devRoutes` exists. Delete them once the slot is
  wired; nothing imports them.
