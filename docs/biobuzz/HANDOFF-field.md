# BIOBUZZ FIELD — handoff

Branch `biobuzz-field-staging` (cut from `origin/biobuzz-field`, with `origin/biobuzz` merged
in for the `ArtifactColor` / `r?` / `element` types). Lane A, items 1–5: HIVE frame base bars
and FLOWER feet as statics, §10.3.1 staging, `scoreTargets`, the two-size element renderer,
and the checks and gallery cells that prove them. Field lane **133 CHECKS, ALL PASS**;
`tsc --noEmit` and `npm run build` clean.

| | |
|---|---|
| `b03eef5` | `colliders.ts` — 2 frame bars + 4 FLOWER feet, `BB_SOLID_COUNT` (item 1) |
| `bc733e1` | `elements.ts` — `scoreTargets`, 2 CELLs + 4 FLOWER tops (pushed early, per request) |
| `e4d7c47` | `spawn.ts` — `stageBiobuzz`, 56 elements, G304 start anchors (item 2) |
| `9b4efea` | `draw.ts` — colour per `b.color`, radius `b.r`, three batched paths (item 3) |
| `ea9ab57` | `field.ts` + 3 appended scenes — staging, under-hive, frame-push (item 4) |
| `a78d6b5` | a custom start pose is no longer snapped to a wall — what the shots caught (item 5) |

## The five things to know

- **The solver still runs every ball at `BB_POLLEN_R`.** NECTAR are staged with `r: BB_NECTAR_R`
  and drawn at it, but `solveArtifacts` takes one radius for the whole array, so a 3.6 in NECTAR
  collides as a 2.8 in POLLEN. `APPROX`, and the OWNER'S item — Lane A may not touch `src/sim/`.
- **`world.balls` is the only staging authority.** A FLOWER's contents are the balls with
  `state.el === 'flower:<i>'` ordered by `slot`; human-player stock is `{kind:'stock', alliance}`.
  `flowers[i].stack` and `nectarStock` would have needed fields in `state.ts`, which is forbidden
  to this lane, and the five conservation buckets (floor/hopper/flight/element/stock) read the
  same either way.
- **Three geometry `APPROX`es.** FLOWER feet are the circumscribing SQUARE of the `BB_FLOWER_FOOT_R`
  circle (`StaticSpec` is rect-only); a stack's `z` is one POLLEN diameter per slot below
  `BB_FLOWER_TOP_Z`, pending `BB_FLOWER_VOL_Z`; `scoreTargets` accepts a CELL on `r = 8`, a disc
  standing in for the 20 × 12 opening.
- **`elements.ts` reads `world.biobuzz.hives` through an optional cast**, falling back to
  `BB_HIVE_UP_STAGED`. `BiobuzzState` has no `hives` member yet; the day `state.ts` gains one the
  cast can go and nothing else changes.
- **Three Lane A follow-ups I was not allowed to make.** `settle-60`'s title and comment still
  describe "the full 60-pollen scatter" through `scatterPollen` (editing an existing scene is
  forbidden); `BB_START_POSES` still sit inside the LOADING ZONE band, so `spawn.ts` snaps them
  legal on every spawn (A1/owner item, `config.ts` is forbidden); and `drawField.ts` draws no
  FLOWER, HIVE or frame bar, so the `staging` cell shows the elements on bare tiles.
