# HANDOFF — Lane A (field)

## 2026-09-12 · owner CAD + the six drawing rulings · `PENDING`

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
