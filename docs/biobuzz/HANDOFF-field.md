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
