# HANDOFF — Lane A (field)

## 2026-09-12 · rules lane (A4b) · `LANDED` — commit `b1f4535`, 679 checks green

Scoring, the Section 11 contact rules, the 1:00 cue, the `gameHud` slice and three scenes.
`state.ts` and `play.ts` were not touched; this branch carries A4a's state-contract commit
(`2db7a05`) and nothing else of A4a's.

- **Files owned and changed**: `score.ts` (NEW), `penalties.ts`, `step.ts`, `hud.ts`,
  `scenesField.ts`, `scripts/smoke-biobuzz/rules.ts` (NEW, registered in `index.ts` as
  `--lane rules`, 115 checks).
- **Gates**: `npx tsc --noEmit -p .` clean · `npm run test:bb -- --lane rules` 115/115 ·
  `npm run test:bb` 679/679 · gallery shots on 4177 (`VITE_APP_CHANNEL=alpha`) read at
  hi-res for all three scenes.

### What the next person has to know

1. **`scripts/smoke-biobuzz/field.ts` HAS ONE CHANGED ASSERTION AND IT IS NOT THIS LANE'S
   FILE.** `room: the finished BIOBUZZ match scored nothing (an unscored shell must stay
   0-0)` could not survive a scorer existing: the staged layout — 3 elements in each up-CELL
   and 4 POLLEN in each GARDEN — is worth `3·BB_PTS.cell + 4·BB_PTS.garden` = 10 to each
   alliance before anybody drives. It now asserts that derived value AND that the two
   alliances are EQUAL, which is the cheapest place an x-MIRRORED zone (instead of
   point-symmetric) shows up. `simModuleFor('biobuzz').scored` is still `false`, so
   `persistMatch` still skips the game. **`origin/biobuzz-field`'s `7f67fa0` also edits this
   file**, so expect a one-hunk conflict there and keep both sides.
2. **`origin/biobuzz-field` is AHEAD by `7f67fa0` ("the field goes live") and this branch does
   NOT carry it.** The brief's merge trigger is a `state.ts` commit and that one touches
   `play.ts`, `field.ts` and the handoff only. It is the commit that unblocks item 3.
3. **`hive-tip` renders three IDENTICAL stills** (t = 0 · 2 s · 4 s). The scene is built
   against the finished swing, but the swing is advanced by `hiveStep` from `play.ts`, which
   is A4a's file. Its header says so. The swing arithmetic is NOT untested — `rules.ts` calls
   the pure `hiveStep` directly and pins the release at `BB_TIP_RELEASE_S`. **Once `7f67fa0`
   is merged the three stills should differ; re-shoot the cell and delete this note.**
4. **`HudSlots.tsx` has not been wired.** `biobuzzFieldHud` now returns the whole of Table
   10-2 per alliance, the RP flags, the per-cell `needed`/`tipping`, flower owners and depth,
   the nectar stock/due and the G410 lock. The slice is ADDITIVE, so existing reads of
   `f?.scored` still work and nothing is broken — but the `scoreBar` and `resultsRows` slots
   still render almost none of it. That is an integration-chat job (`src/ui/` is outside every
   Lane A file list), and `needed` is the single most decision-changing number in the game.
5. **G421 (pinning) is NOT modelled and is blocked on a one-line export.** `isPinning` is
   private to `src/sim/penalties.ts`; field-plan §6 request 5 asks for it. Until then a
   BIOBUZZ pin costs nothing. **G407 (herding) is deliberately not modelled** — the control
   cap is structural. G405/G409/G411/G418/G426/G427 are structural or human-player rules and
   each says so in `penalties.ts`.
6. **`BB_FRAME_RAM_SPEED` is `APPROX`.** The manual gives no closing speed for G417, so 30
   in/s is a placeholder and the 2026-09-14 field test is what sets it. The escalation it
   gates (VERBAL first, MAJOR on a repeat) is the rule and is not approximate.
7. **The AUTO/TELEOP TIP SPLIT IS NOT STORED.** `BbHiveState.tips` is one counter, so a TIP is
   worth 20 whenever it happens and the results screen cannot break it down by period. Nothing
   in Table 10-2 needs the split today; if a later table does, it is a `state.ts` field and
   therefore A4a's to add.
8. **A `bbSetup` pose is CANONICAL (the BLUE frame).** The spawn mirrors a RED one THROUGH THE
   ORIGIN — (x, y, θ) → (−x, −y, θ + 180°) — so a red robot placed at a left-wall coordinate
   ends up on the right wall. Two scene poses were written the wrong way round before this was
   noticed and the cell looked plausible either way. The gallery draws through
   `viewAngleOf('blue')`, so screen-x is world-y and screen-y is world-x; do not read a shot as
   if it were a plain top-down.
9. **Every fixture is measured on the FOOTPRINT, not the chassis.** `robotExtents` is 21 × 17
   for the default BIOBUZZ spec (a sweeper reaching past each end of a 15 × 17 chassis). A
   robot at x = −63 has a corner THROUGH the wall at −73.5, and three of the six first-run
   failures were poses written against the chassis.


## 2026-09-12 · no letters on the field · `PENDING`

- **Cells to look at**: `field-labelled@0` and the new **`hive-ground@0`**. Both at 1600px via
  `scratch/hires.cjs --scene <id>` (gitignored throwaway); `--labels 0` renders a labelled
  scene with the caption flag off, which is what a driver sees.
- **Files**: `drawField.ts` (the cell render), `scenesField.ts` (`field-labelled` + the new
  `hive-ground`), `scenes.ts` (one-line colour fix, below).
- **What changed** (field-plan §2.1 render / §2.5):
  1. **No letters or digits anywhere for elements.** The per-type tally (`3n 2p`) is gone. An
     up-CELL's contents are **one row of element-scale discs hugging the cell's OUTER (open)
     edge**, inside the box, oldest at the −x end, colour = type. When the row runs longer than
     the 20-in width the PITCH closes up and the discs overlap while the RADII stay true —
     shrinking them instead would make a NECTAR and a POLLEN the same size, which is the one
     distinction the row carries.
  2. **UP is a filled box, DOWN is a dashed outline with no fill.** The down cell hangs 25.5 in
     up and robots drive under it, so it is not a surface; the outline also lets the floor show
     through it.
  3. **The open face is marked by WEIGHT** — outer short edge thin, pivot-side edge heavy. That
     is a scoring rule in the picture: `hiveAccepts` only takes a shot arriving TOWARD the
     pivot, so an open face drawn at the wrong end is the rule drawn wrong. Neither mark fades
     with the swing: the box is open at the same end whichever way it points.
  4. **`tipping` is a cross-fade**, fill ↔ outline, over the swing. The denominator is
     **imported from `hive.ts`**, not copied — a renderer with its own copy of the swing length
     is a fade that ends at a different instant from the flip it is animating.
  5. `draw.ts` skipping `element`-state balls was **already landed** by biobuzz-field-staging
     (`isLoose`), so the double-draw in the last handoff is closed. Nothing needed here.
- **The up-cell fill is a 45% wash, not solid** (`CELL_FILL_A`). At full saturation a RED
  NECTAR in the RED cell was red on red and read as an empty ring — and the NECTAR count is
  what the tip table is indexed by, so it is the one thing in there that must not disappear.
  The heavy pivot-edge mark needed the same room.
- ⚠️ **Fixed in `scenes.ts`: `bbPollen` emitted `'green'`.** POLLEN is `'yellow'` (§9.8,
  `POLLEN_COLOR` in `spawn.ts`) and `draw.ts` batches only yellow/red/blue, so **every scene
  built from `bbPollen` was drawing no balls at all** — the whole POLLEN PHYSICS SET
  (`pile-*`, `corner-pile`, `wall-row-sweep`, `pin-wall`, `squeeze-2robots`, `settle-60`)
  rendered an empty field. A ball that is never drawn looks exactly like a scene that placed
  none, which is why it survived a green suite.
- ⚠️ **For biobuzz-field-staging — `bbWorld` leaves DANGLING element ids.**
  `createBiobuzzWorld` runs `stageBiobuzz`, which writes ids into every FLOWER stack and both
  up-CELLS; `bbWorld(seed, setups, pollen)` then REPLACES `world.balls` and leaves those ids
  pointing at elements that no longer exist. The readouts are a join, so it is normally
  invisible — but `bbPollen` numbers from 1 and so does the staging, so `hive-ground`'s three
  floor pollen ALIASED F1's staged stack and rendered outside the perimeter beside a flower.
  Worked around in the scene (it clears the references); the helper is yours.
- ⚠️ **For biobuzz-field-staging — `BB_TIP_SWING_S` is 0.8 in `hive.ts`, but the ruling is 4 s**
  (field-plan §2.1, owner 2026-09-12). `drawField.ts` imports your constant rather than
  carrying its own, so the cross-fade is correct whatever the value is — but the swing itself
  is five times too fast, and the contents spill at the halfway point of it.
- **Still APPROX**: the hive pair being centred on the field, the LOADING ZONE tape edge
  (±0.5 in, cosmetic), and `BB_TIP_POLLEN[0]` (an empty cell was never measured).

> **BRANCH CHANGE (2026-09-12):** the shared base is **`alpha`**. `biobuzz` was merged into
> `alpha` and deleted on origin. Wherever this file says branch `biobuzz`, read `alpha`: merge
> `alpha` before you commit, land into `alpha`, `alpha` deploys.

## 2026-09-12 · the four HIVE rulings, on an `alpha` base · `biobuzz-field-hive`

- **Files**: `hive.ts` (rewritten), `scripts/smoke-biobuzz/field.ts` (the `hive:` block). `flower.ts` unchanged. Nothing wired — `play.ts`, `step.ts`, `state.ts`, `config.ts` untouched. Field lane **168 checks, all pass**; `npm run build` green.
- **The rulings (field-plan §2.1), all four in**: swing `BB_TIP_SWING_S = 4.0` (a decision, not APPROX); `hiveAccepts` now takes a `vel: Vec3` and gates on APPROACH — the CELL is open at its outer end only, so `vel.y` must point at the pivot (`hiveApproachSign`: up=south takes vy > 0, up=north vy < 0); contents RELEASE at level (`BB_TIP_RELEASE_S` = swing/2) with a `released` latch, so `spilled` arrives two seconds BEFORE `tipped` and the 20 points; `spillPoses` returns `{pos, vel}` with vel outboard `BB_SPILL_SPEED` 40–60 in/s and `BB_SPILL_LATERAL` ±12 across, `vel.z` 0.
- ⚠️ **`BB_TIP_LOAD` and `BB_NECTAR_MASS` ARE GONE, superseded by the merge.** `config.ts` now carries the owner's MEASURED `BB_TIP_POLLEN` table, and the config comment is explicit that a see-saw is torque and packing, not weight — no linear mass model fits the measured rows. `hiveLoad` counts `{pollen, nectar}` and `hiveWillTip` is the table lookup; smoke asserts every row and its one-short neighbour, so reintroducing a mass model fails loudly. Consequence worth knowing: the staged cell (3 nectar) tips at **3 pollen**, reachable in AUTO.
- **REQUEST to `state.ts`** (Lane A's own file, deliberately not edited here): add `released: boolean` to `BbHiveState` and `released: false` to both hives in `emptyBiobuzzState()`. Until then `hive.ts` declares `HiveState extends BbHiveState` with `released` OPTIONAL, so a plain state hive still typechecks as an input; every hive the module returns sets it. With the field in `state.ts` that interface collapses to a re-export.
- **Still APPROX**: `BB_HIVE_ACCEPT_MARGIN` 2 in, the spill speed and lateral spread, and — in `flower.ts` — `BB_FLOWER_VOL_Z` [3.98, 21.5], `BB_FLOWER_FLOOR_Z` 0.43, `BB_FLOWER_ENTRY_MARGIN` 3 in. `BB_TIP_RELEASE_S` = swing/2 assumes a constant angular rate, which a damped swing is not; the error moves WHEN the spill lands, never whether it does. Fig 10-5 A–H are still RECONSTRUCTED from the §10.5.2 rule text, not read off the figure.

## 2026-09-12 · owner CAD + the six drawing rulings · `d6c0430`

- **Cells to look at**: `field-labelled@0` (annotated) and the SAME cell rendered with the
  caption flag off, which is what a driver sees. `scratch/hires.cjs --scene field-labelled
  --labels 0` renders the unannotated half at 1600px (the 420px gallery cell is too small to
  judge geometry); `scratch/` is gitignored throwaway.
- **Files**: `config.ts` (measured constants), `drawField.ts` (all six fixes),
  `scenesField.ts` (`field-labelled` only — it now stages REAL elements).
- **What changed in the drawing**, in the order it matters:
  1. **Both HIVE cells are the same size.** The see-saw is one rigid bar at 30°, so a plan view
     projects both ends by cos 30° and only `z` separates them (reference §2.2). The down cell
     is no longer drawn short; UP is said by brightness and by the counts alone, which is all a
     plan view honestly has. The assembly is 37.16 long, not 42.91.
  2. **The FLOWER foot is a 6 × 4.9 rectangle flush to the wall**, not a 2.6 disc.
  3. **The FLOWER readout is the STACK ITSELF**, outside the perimeter beside its flower, one
     disc per element in its own colour, bottom nearest the flower. The count badge is gone.
  4. **The up-CELL readout is PER TYPE** — POLLEN / RED NECTAR / BLUE NECTAR as separate pips.
  5. **AprilTag ids are behind the labels flag**, printed as a range and moved onto the cell's
     SHORT axis (they overflowed the 10.43-in cell and ran through the counts).
  6. **GARDENS and LOADING ZONES are tape strokes**, mat showing through. The garden strokes at
     `BB_TAPE_1`, not at the 2-in strip depth — at 2 the stroke repaints the solid bar.
- **No longer APPROX**: flower position and stand-off, flower footprint, frame bar x and foot
  y, cell centre / depth / assembly length, the cell accept window, and the tip table. They are
  owner CAD measurements dated 2026-09-12 and cited to reference §2.2 / §2.3 / §4.1. What is
  still APPROX: the hive pair being centred on the field, the LOADING ZONE tape edge (±0.5 in,
  cosmetic), and `BB_TIP_POLLEN[0]` (an empty cell was never measured).
- ⚠️ **BLOCKED ON `draw.ts` (biobuzz-field-staging owns it): parked elements are drawn twice.**
  `field-labelled` now stages REAL `Artifact`s in the `element` state, because both new
  readouts are a JOIN — an id with no element behind it draws nothing. `drawBiobuzzBalls`
  skips only `held`, so it also paints every `element`-state ball as a loose yellow POLLEN at
  its `pos`, which is the flower ring or the cell centre it is parked in. In the still that is
  a yellow disc inside each FLOWER ring and one over each up-cell's pips — it hides the RED
  NECTAR pip in red's cell. The fix is one line beside the `held` guard:
  `if (b.state.kind === 'element') continue;`. `spawn.ts` will hit this the moment it stages
  anything, so it is not specific to this scene.
- **Wanted from the shared core**: a per-artifact radius, so NECTAR is not simulated at POLLEN
  size (`docs/biobuzz/field-plan.md` §6 request 1).

## 2026-09-12 · geometry + the drawn field · `73372ad`

- **Cells to look at**: `field-labelled@0` (the whole field), `field-empty@0` (mat + grid only).
- **Files**: `src/games/biobuzz/config.ts` (`// ---- FIELD GEOMETRY (manual V1)` + `bbMirror`),
  `state.ts` (hives / flowers / nectarStock / nectarDue / leave / parkAuto / parkTele / `labels`,
  all DRAFT until the T0+2h sync), `drawField.ts`, `scenesField.ts` (`field-labelled` only).
- **APPROX in the drawing**: the hive body's 14-in width across, the 30° foreshortening of the
  down cell, the flower foot radius 2.6, the flower stand-off 3.0, the frame foot y ±19.5 and
  bar 1.5, and both tape widths' exact placement on the seams. Every one is tagged in config.ts;
  `grep APPROX src/games/biobuzz/config.ts` is the 09-14 tape-measure list.
- **Not real yet**: `field-labelled`'s cell contents and flower stacks are bare ids with no
  elements behind them (drawing input); `spawn.ts` places the real ones in a later pass.
- **Wanted from the shared core**: a per-artifact radius, so NECTAR is not simulated at POLLEN
  size (`docs/biobuzz/field-plan.md` §6 request 1).


---

## (hive lane, merged)

## 2026-09-12 — hive/flower logic ready for wiring (`biobuzz-field-hive`)

- **Landed**: `src/games/biobuzz/hive.ts` (hiveAccepts / hiveLoad / hiveStep / spillPoses, pure, rng as a parameter) and `flower.ts` (stack model, flowerFits/flowerCapacity, flowerAccepts top-only, flowerRetrieve pollen-only, flowerScore per §10.5.2), plus `hive:` / `flower:` checks in `scripts/smoke-biobuzz/field.ts`. Nothing wired: `play.ts`, `step.ts`, `state.ts`, `config.ts` untouched — wiring waits for the field-labelled verdict and the T0+2h sync.
- **APPROX, local to `hive.ts` until `config.ts` carries them**: `BB_TIP_LOAD` 6 pollen-equivalents (bounded below by the stable staged pose, 3 nectar ≈ 4.95), `BB_NECTAR_MASS` 1.65, `BB_TIP_SWING_S` 0.8 s, `BB_HIVE_ACCEPT_MARGIN` 2 in. Measure tip load and both masses on 09-14, then move the four consts into `config.ts` and delete them here (one import line each).
- **APPROX, local to `flower.ts`**: `BB_FLOWER_VOL_Z` [3.98, 21.5] (field-plan §1 name, not yet in config), `BB_FLOWER_FLOOR_Z` 0.43 (lower-ring top, where the bottom element rests), `BB_FLOWER_ENTRY_MARGIN` 3 in. Consequence worth a real-field check: a bottom POLLEN (top at 3.23) sits wholly in the retrieval opening and does NOT score; a bottom NECTAR (top at 4.03) is partially in by 0.05 in and does. Capacity by height: 8 pollen or 6 nectar.
- **Fig 10-5 A–H are RECONSTRUCTED from the §10.5.2 rule text**, not read off the figure (the manual is not in the repo). The table in `field.ts` encodes owner / owner points / bonus per case from the rules; re-label against the real figure when someone has the PDF open.
- **State shapes** `HiveState` / `FlowerState` are declared locally (field-plan §2); when `state.ts` gains `hives` / `flowers`, import from there and delete the local declarations. `BbElementKind` (`'pollen' | Alliance`) lives in `flower.ts` and is what `kindOf` / `massOf` callbacks in `play.ts` will resolve from the artifact.


---

## (staging lane, merged)

## 2026-09-12 · geometry + the drawn field · `73372ad`

- **Cells to look at**: `field-labelled@0` (the whole field), `field-empty@0` (mat + grid only).
- **Files**: `src/games/biobuzz/config.ts` (`// ---- FIELD GEOMETRY (manual V1)` + `bbMirror`),
  `state.ts` (hives / flowers / nectarStock / nectarDue / leave / parkAuto / parkTele / `labels`,
  all DRAFT until the T0+2h sync), `drawField.ts`, `scenesField.ts` (`field-labelled` only).
- **APPROX in the drawing**: the hive body's 14-in width across, the 30° foreshortening of the
  down cell, the flower foot radius 2.6, the flower stand-off 3.0, the frame foot y ±19.5 and
  bar 1.5, and both tape widths' exact placement on the seams. Every one is tagged in config.ts;
  `grep APPROX src/games/biobuzz/config.ts` is the 09-14 tape-measure list.
- **Not real yet**: `field-labelled`'s cell contents and flower stacks are bare ids with no
  elements behind them (drawing input); `spawn.ts` places the real ones in a later pass.
- **Wanted from the shared core**: a per-artifact radius, so NECTAR is not simulated at POLLEN
  size (`docs/biobuzz/field-plan.md` §6 request 1).

## 2026-09-12 · the staged field · `b03eef5` `bc733e1` `e4d7c47` `9b4efea` `ea9ab57` `a78d6b5`

- **Cells to look at**: `staging@0` (§10.3.1 Fig 10-2), `under-hive@0/@120`, `frame-push@0/@30/@60`.
- **Files**: `colliders.ts` (two FRAME base bars + four FLOWER feet, `BB_SOLID_COUNT`),
  `spawn.ts` (`stageBiobuzz` replaces `scatterPollen`; G304 start anchors), `elements.ts`
  (`scoreTargets` — both up-CELLs and the four FLOWER tops), `draw.ts` (colour per `b.color`,
  radius `b.r`, three batched paths), `scripts/smoke-biobuzz/field.ts`, three appended scenes.
- **The staging is 56 elements**: 16 POLLEN in the four FLOWERS, 8 in the two GARDENS, 16
  preloaded through the real capture path, 6 NECTAR in the two up-CELLS, 10 in human hands.
  Field lane 133 checks, all pass.
- **APPROX**: FLOWER feet are the circumscribing SQUARE of `BB_FLOWER_FOOT_R` (`StaticSpec` is
  rect-only); a stack's `z` is one POLLEN diameter per slot below `BB_FLOWER_TOP_Z`, pending
  `BB_FLOWER_VOL_Z`; `scoreTargets` accepts a CELL on `r = 8`, a disc for the 20 × 12 opening.
- **What the shots caught**: `bbSnapStart` was repairing every start pose, not just the two
  pre-V1 anchors, so a scene asking for the field centre spawned a robot on the perimeter
  (`a78d6b5`). Anchors only now; a custom pose is mirrored and perimeter-fitted, never dragged.
- **Wanted from the shared core**: a per-artifact radius — NECTAR is staged and drawn at
  `BB_NECTAR_R` but `solveArtifacts` takes one radius for the array, so it collides at POLLEN
  size. Same ask as the entry above (`field-plan.md` §6 request 1).

## 2026-09-12 · the state bag is filled · `a1613d9`

- **Cells to look at**: `staging@0` — the two up-CELLS now read `3` and all four FLOWERS badge
  `4`, because `drawField.ts` is reading state that staging finally writes.
- **Files**: `spawn.ts` (`stageBiobuzz` fills `flowers[i].stack`, `hives[a].contents`,
  `nectarStock[a]`; `cellNectar` reads `hives[a].up`), `elements.ts` (the `hives` cast is gone),
  `scripts/smoke-biobuzz/field.ts`. Field lane **143 checks, all pass**.
- **The bag is DERIVED from `world.balls`**, not written alongside it: the array stays the
  conservation authority and disagreement is unrepresentable at staging. Ten checks assert it
  both ways anyway — a runtime writer can still drift, and the capture path, the tip machine
  and G418.B retrieval all land on this state next.
- **ONE-LINE FOLLOW-UP, NOT MINE**: `bbWorld` in `scenes.ts` replaces `world.balls` wholesale
  after staging, so a scene with a POLLEN override keeps the staged bag — which is why
  `under-hive@0` draws four FLOWERS badged `4` under a `0 pollen` caption. `spawn.ts` now
  exports `bbIndexElements(world)` for it; the fix is calling it after `world.balls = pollen`.
- **Still wanted from the shared core**: the per-artifact radius. NECTAR is staged, drawn and
  now indexed at `BB_NECTAR_R`, and still collides at POLLEN size.

## 2026-09-12 · every target says which way it opens, and the anchors are legal

- **Base is `alpha` now**, not `biobuzz` — merged clean, nothing of mine conflicted (it was all
  already in alpha). Field lane **185 checks, all pass**; `npx tsc --noEmit` clean.
- **`ScoreTarget.mouth?: Vec2`** (`state.ts`) — unit vector OUT of the opening, filled in
  `scoreTargets`. Up-CELL: away from the HIVE pivot, so the same sign as the cell's own `pos.y`
  and correct through a TIP rather than hard-coded per alliance. FLOWERS: into the field —
  F1 `(1,0)`, F2 `(0,-1)`, F3 `(-1,0)`, F4 `(0,1)`. Optional because a target that is a plain
  volume has no such direction; absence means "no constraint", never a default direction.
- **`BB_START_POSES` moved out of the LOADING ZONE band** (`config.ts`): `(60, ±36)` →
  `(61.5, 36)` and `(61.5, −60)`. The old BOTTOM anchor sat inside `BB_LZ.blue` and both
  stopped 2 in short of the wall, so `spawn.ts` repaired them on every spawn — the anchor a
  builder places, the anchor the selector labels TOP/BOTTOM, and the pose the robot got were
  three different things. Spawning now moves them **0.010 in**, which is `WALL_SEAT`, the
  float-tangency guard. `bbSnapStart` stays: the seating is spec-dependent.
- **Checks**: each up-CELL mouth points away from its pivot, asserted STAGED and TIPPED; every
  mouth is a unit vector; each FLOWER's mouth steps away from the wall it stands against; each
  anchor spawns within 0.05 in of where it is written and is legal on the RAW anchor (own side,
  wall contact inside `START_TOUCH_TOL`, clear of its own zone) rather than on the repaired pose.
- **TWO COPIES OF ONE TABLE, still**: `drawField.ts` has a private `FIELD_SIDE` identical to the
  `FLOWER_MOUTH` map in `elements.ts`. Four entries, two chances to disagree about which way
  `rear` is — they should collapse to one exported constant. `drawField.ts` is not this lane's.
