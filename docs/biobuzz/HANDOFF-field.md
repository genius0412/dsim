# HANDOFF — Lane A (field)

> **BRANCH CHANGE (2026-09-12):** the shared base is **`alpha`**. `biobuzz` was merged into
> `alpha` and deleted on origin. Wherever this file says branch `biobuzz`, read `alpha`: merge
> `alpha` before you commit, land into `alpha`, `alpha` deploys.

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
