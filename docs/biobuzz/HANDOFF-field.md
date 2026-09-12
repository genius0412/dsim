# HANDOFF — Lane A (field)

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
