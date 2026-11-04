# The GRB venue: research and model notes

The `grb` environment (BIOBUZZ 3D, High and up) is Hall B3 of the George R. Brown Convention Center,
Houston, laid out as the FIRST Tech Challenge used it at the **2026 FIRST Championship** (DECODE
season, 29 April – 2 May 2026). It is generated from numbers by `scripts/venue-models/grb/`; this file
is where each number comes from. Rules for modeled venues in general: `docs/area/biobuzz.md`,
MODELED VENUES.

**Year modelled: 2026.** It is the newest FTC Championship and the only one with a published, to-scale
FTC floor plan. Everything event-specific (divisions, stands, pits) is the 2026 layout. The building is
the same every year.

## Every source is FTC's

FRC and FTC share the GRB, so each reference was checked against the FTC: FTC division names, FTC game
elements and 12-ft fields, two per division.

- **FIRST's 2026 FTC floor plan** is on FIRST's FTC Championship page. It names the six FTC divisions,
  draws "Div N F1/F2" 12-ft fields, and puts the area on Level 3. FRC played on Level 1, Halls A–E,
  per the event guide.
- **The GRB plan** is of Halls A3–B3 on Level 3, the FTC's halls.
- **FIRST's 2025 photograph** carries "INTO THE DEEP" signage, an FTC season. It comes from the FTC
  update post.
- **The 2026 da Vinci stream thumbnail** shows DECODE elements, an FTC season.
- **The coach-orientation photographs** come from the FTC coach orientation.
- **One photo is not an FTC event.** The GRB's own Hall B3 gallery photo shows the room at a non-FIRST
  show. It is used for the building's finish only: blue-grey columns, black roof steel.

Layout, as the 2026 plan draws it: six divisions in a 2 × 3 grid (two rows of three, back to back
across the centre aisle), each with two fields side by side. That is what the model has.

## Which hall, by year

| year (season) | FTC location | source |
|---|---|---|
| 2026 (DECODE) | Level 3, Halls A3 and B3; 6 divisions, 342 teams; fields in B3, pits and practice in A3 | [2026 event guide](https://www.firstinspires.org/hubfs/web/event/2026/cmp/all/event-guide.pdf), [FTC championship page](https://www.firstinspires.org/resources/library/ftc/championship-information), [floor plan](https://www.firstinspires.org/hubfs/FloorPlanForWebsite20260304.png) |
| 2025 (INTO THE DEEP) | Level 3, Halls A and B; 4 divisions, 256 teams | [2025 event guide](https://www.firstinspires.org/hubfs/web/event/2025/cmp/2025-first-championship-event-guide.pdf) |
| 2024 (CENTERSTAGE) | Level 3; FTC pit admin in Hall B3 | 2024 coach/mentor orientation (cited by search results; the file now 404s) |
| 2023 and before | not established | — |

FRC uses Level 1 Halls A–E in the same years. FIRST holds the Championship at the GRB through 2034.
The 2026 change: FTC grew from four divisions to six, and FIRST's update post says the floor plan moved
"due to the removal of built-in bleachers" ([2026 updates](https://www.firstinspires.org/community-blog/2026-first-cmp-updates)).

## The building (measured)

| what | value | source |
|---|---|---|
| Hall A3 | 324 × 371 ft, 114,620 ft² | [GRB dimensions](https://www.grbhouston.com/planners/dimensions-capacities/) |
| Hall B3 | 267 × 372 ft, 90,820 ft² | same |
| ceiling height, Level 3 | 30 ft | same |
| floor | concrete, carpeted aisles at shows; 1,000 psf | [GES facility spec (Level 1 halls A/B)](https://ordering.ges.com/042600612/download/FacilitySpecs) |
| drive-in doors | 14 ft high (19 and 24 ft wide) on Level 1 | same |
| columns, walls, doors, floor pockets, airwall | read off the vector CAD | [GRB Halls A3–B3 plan](https://assets.simpleviewinc.com/simpleview/image/upload/v1/clients/houston/HALL_A3_B3_e2696fb8-5070-4bf0-8871-1c259e267238.pdf) |

The CAD plan is a vector PDF with named layers (`L3|COL-EXHIBIT-HALL`, `L3|WALL`, `L3|DOORS`,
`L3|flr-pkt-halls`, `L3|AIRWALL`, …). Its scale comes from the floor pockets, which sit on a 30-ft grid
(45.4 units, so 1.5133 units per foot); at that scale the hall's depth reads 375 ft against the
published 371–372 and A3's length 326 ft against 324. What it gives:

- **Columns.** Every 90 ft along the hall (B3: x 67.2, −22.8, −112.9 ft from our field; A3 continues
  past a 30-ft airwall bay). Each line has a *triplet* in each of two bands: two big round columns
  38 ft apart (CAD circles 5.0 ft on B3's middle two lines, 4.0 ft elsewhere) with a small one (2.9 ft)
  between, joined by a beam (the CAD's dashed double line). The bands are 44–83 ft from the dock wall
  and 113–151 ft from the concourse wall, leaving a 142-ft column-free span between them. B3's end line
  has no interior columns.
- **Walls.** B3 end wall, A3 end wall, dock wall (drive-in ramps, docks 43–55), concourse wall.
- **Doors.** Ten drive-in openings 11–25 ft wide on the dock wall; personnel door sets on three walls
  (from the CAD's door swings).
- **Floor pockets.** A 30-ft grid; drawn into the slab texture where the CAD puts them.
- **Airwall.** Between A3 and B3. Open for FTC 2026: the plan runs ROBOT HELP & INSPECTION across it.

Two photographs show the finish: GRB’s own [Hall B3 gallery photo](https://www.grbhouston.com/media-gallery/) (a non-FIRST show, the building only)
(blue-grey round columns, black roof steel and deck, deep trusses, round ducts) and FIRST's 2025 FTC
photograph in the [2026 updates post](https://www.firstinspires.org/community-blog/2026-first-cmp-updates)
(white walls, red panels low on the walls, columns with diagonal knee braces into the roof truss,
silver spiral ducts, high-bay lights). The 2026 coach orientation's photos show the same columns and
walls ([coach orientation](https://www.firstinspires.org/hubfs/web/program/ftc/2026-ftc-cmp-coach-orientation.pdf)).

## The 2026 FTC layout (measured)

From FIRST's floor plan raster (1266 × 747). Its scale is set by the building: the columns it draws
are 179.5 px apart (90 ft) and the two bands 358.4 px apart (180 ft), so **0.502 ft/px**. A 12-ft field
measures 24 px on it, which agrees. Elements were measured by colour (fields light grey, carpets dark
grey, stands mid grey, pits by division colour) and by eye at 6× zoom.

- **Six divisions** in two rows of three across B3's column-free span: ROSS, LOVELACE, JACKSON facing
  the dock wall; EDISON, FRANKLIN, GOODALL facing the concourse wall. Divisions repeat every ~82.5 ft;
  the rows' field centres are 48.2 ft apart.
- **Two fields per division**, 27.9 ft centre to centre, alliance stations at either side (the plan's
  red and blue boxes). Each division stands on a dark carpet ~57 × 19–24 ft.
- **The audience** sits in front of each division, in a stand 78 ft wide and 70 ft deep (the grey
  block), its front 27.6 ft from the field centres. An accessible-seating platform pushes 8.5 ft out
  of its front (16 ft wide), with team-media boxes either side. The FTC event guide confirms
  accessible seating at every division with "reserved stands behind" it
  ([FTC event guide](https://www.firstinspires.org/hubfs/web/event/2026/cmp/ftc/event-guide.pdf)).
- **Behind each division** a zone (white on the plan) for scoring and field staff, closed by drape
  (the plan's blue line) on a 13.8-ft centre aisle between the rows.
- **Storage** in drape enclosures round the column triplets between stands (plan: "Storage?").
- **Pits** in A3: 315 cells measured one by one, 10 × 10 ft, back to back in strips, each division's
  pits in its colour. Drape colours from the coach orientation: Edison canary, Franklin pink, Goodall
  blue, Jackson salmon, Lovelace green, Ross grey. Pits are 10 × 10 × 10 ft with a 6-ft table.
- **Practice fields**: 14 at A3's west wall, fields 1–6 on risers (plan labels; coach orientation).
- **Fields on 24-in risers**, drive teams and field staff at floor level
  ([DECODE manual §15.2.1](https://ftc-resources.firstinspires.org/ftc/archive/2026/game/manual-15)).
  The riser is FTC.RoboSource's Gen2 Portable Riser, with a 3-step ladder at the field's non-audience
  wall. Driver-station tables are 26 in, human-player tray stands 20 in (coach orientation). FIRST's
  2025 photograph shows the 2025 version: a black-skirted stage under the fields, with people
  standing on it.

## Estimated, and why

| what | value | why |
|---|---|---|
| roof structure | primary trusses 11 ft deep along every column line, open-web joists every 10 ft, deck at 41.5 ft | no drawing; sized ~L/12 for the 142-ft span, shape from the photographs |
| ducts, house lights | 42-in spiral ducts along each bay, high-bay pendants on a 30-ft grid at 31.5 ft | photographs |
| stand construction | 24 rows, 32-in row depth, 11-in rise (top deck 22 ft), aluminium benches, two stair aisles | footprint measured; a 70-ft-deep bank under a 30-ft roof cannot rise faster; the 2026 da Vinci stream and 2025 photographs show a steep grandstand of about that size |
| lighting grid | 20.5-in box truss over each division at 24 ft, moving heads on both long beams | 2025 photographs; the 2026 plan does not draw rigging |
| LED walls | one 16 × 9 ft wall per field over the back drape, facing the audience | 2025 photographs; not on the 2026 plan |
| drape | 8 ft black round competition zones; pits 8-ft back, 3-ft sides | the common kit (GES standard booth: 8-ft back, 3-ft sides) |
| crowd | 72 % of seats; four poses, heights 0.86–1.06 | photographs range from well filled to packed |
| stage | the division's whole carpet raised 24 in: black velour skirt, fascia, three-step stairs at both ends and the back | riser height measured; the skirt and stairs from the 2025 photograph |
| event light (baked) | B3's house at 26 % of albedo, A3's pits at 80 %, white light pooled on each division (falling off over 26 ft), stand spill over 70 ft, blue uplight wash on B3's roof steel | the 2025 photograph; the levels tuned on captures |
| rigging | a second box-truss grid over the competition area at 28 ft, cross trusses, PAR cans and blue uplight cans on every division grid, a line array at each front corner, two main ducts across the hall | the 2025 photograph's roof |
| LED walls | our field's wall shows our match (scores, clock, phase); the others show three generated scoreboard layouts | the photographs show scoreboards and brackets; the content is generic |
| wall wraps | 12-ft red and black vinyl panels in turn round B3's walls | the 2025 photographs' red and black wraps, as plain colour |
| colours | desaturated paint, slab and steel values | tuned on captures against the photographs |

## Deviations from the real hall, on purpose

- **The drive teams stand on the stage, not on the floor.** In 2026 the fields alone sat on risers.
  The sim's drive team stands on the mat's plane: the alliance tape and the driver's eye (62 in) are
  measured from it. So each stage's deck covers the fields and the drive areas, at the mat's level,
  with the hall floor 24 in below. Nothing floats.
- **FRANKLIN's second field stands at 33.5 ft from ours, not 28.1.** The sim's widest driver eye (a
  portrait phone, 240-in setback) stands 293 in from our field's centre, and the clear room
  (`docs/area/biobuzz.md`, MODELED VENUES) must hold it with its 24-in margin. Moved 5.4 ft, carpet with it.
- **Left out because they stand inside that clear room** (the build prints this list): our field's
  four drive-team tables and human-player stands, field 2's near station furniture, and the drape and
  queue lane on FRANKLIN's EDISON side. The queue carts in that gap are not drawn either.
- **Blank signage.** Screens are lit blank panels; no FIRST, sponsor or season artwork anywhere.
- **The neighbouring fields are BIOBUZZ fields**, the repo's own full `field.glb`. It is the file
  our field is drawn from on High, so every hive stands on the same A-frame, foot bars and pads. Each
  sits on its own stage. Its mat is in the sim's charcoal and its polycarbonate is thinned to read as
  clear, against the CAD's flat greys.

## What still differs from the real GRB

- **Event light is baked.** No light moves and there are no beams or haze. The field is lit by the
  sim's own rig, not by the truss.
- **The drive teams stand on the stage** (see above), and there is no LED fascia on the stage edge.
- **Spectators are simple rounded figures, all seated.** Nobody stands in the aisles, at the fields
  or in the pits.
- **The LED walls show generic content**, with no camera feed of a match.
- The roof steel, ducts and lights are estimated from photographs, not drawn from structural plans.
- The 2026 finals (da Vinci) arena is not modelled; its location is not on the published plan.

## Measured cost (2026-11-04)

Dev PC: RTX 4070 Ti SUPER, 1920 × 1080, DPR 1, offscreen Electron, the whole frame by the disjoint timer.

| | High | Ultra | Extreme |
|---|---|---|---|
| GRB, GPU p50 (driver / orbit / stand view), ms | 2.6–3.1 / 2.7–3.2 / 2.7–3.2 | 3.24 / 3.38 / 3.43 | 7.02 / 6.31 / 6.63 |
| the first pass (1dad0605), ms | 1.90 / 2.00 / 1.94 | 1.81 / 1.91 / 1.86 | 4.33 / 4.08 / 4.04 |
| school gym (the old default), ms | 0.79 / 0.62 / 0.57 | — | 2.66 / 2.37 / 2.14 |

The High range spans two runs; other sessions were using the GPU at the time.

The file is 3.75 MB (meshopt geometry, KTX2 textures) and holds 4,074,162 triangles:
- the 11 neighbouring fields, 268,892 each from the full `field.glb`;
- the crowd, about 2,300 figures near our field at ~470 triangles and the rest at ~150;
- the hall and the event.

Every part placed more than once is one instanced draw. Loading from a local server, the model swaps in
0.45–0.9 s after the scene starts, including the loader chunk and the Basis transcoder.

## Rebuilding

```
npx tsx scripts/venue-models/build.ts grb            # generate, check, compress → public/venues/grb.glb
npx tsx scripts/venue-models/build.ts grb --source   # only the uncompressed source, to the tools' work folder
```

Then copy the printed `bytes`, `tris` and `cameraRoom` into the `grb` row (`environments.ts`) and run
the RENDER lane. The numbers live in `scripts/venue-models/grb/layout.ts`; the pit cells in `pits.ts`
were extracted from the plan raster by colour and are data, not a guess. The neighbouring fields are
copied from `public/models/biobuzz/field-low.glb` at build time, so a new field file needs a rebuild.
