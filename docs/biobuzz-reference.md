# BIOBUZZ — the manual, distilled (Competition Manual V1, 2026-09-12)

Source: `BIOBUZZ_Competition_Manual_V1.pdf`, 173 pages. Sections 8–11 (Game Overview, ARENA,
Game Details, Game Rules) plus the Section 16 glossary and the Section 12 robot envelope.
Every number below cites its page or figure. Anything **not** in the text — a coordinate read
off a drawing, a threshold the manual leaves to physics — is marked `APPROX` and says what it
was read from, exactly as `docs/decode-reference.md` does. Lane A owns this file.

Sim frame (unchanged from DECODE / Chain Reaction): origin at field centre, inches,
**+x = audience's right, +y = away from the audience**. Per G304.A and Fig 9-5, **RED is
columns A–C (x < 0, audience LEFT)** and **BLUE is D–F (x > 0)** — the same side assignment
DECODE uses (red wall at x = −72).

## 1. Match

| period | length | notes |
|---|---|---|
| AUTO | 0:30 | no driver input (§10.4, G401) |
| transition | 0:08 | no powered movement (G403); tips completing here count as AUTO (§10.5.B) |
| TELEOP | 2:00 | driver control |
| **FLOWER ownership unlocked** | at **1:00 left** | G410: NECTAR may not enter a FLOWER before this. Audio cue TBD (Table 9-1, p79) |
| final 20 s | 0:20 | "Train Whistle" cue (Table 9-1) — the shared `ENDGAME_START` |

Match clock on the display counts 2:30 → 0:00 (Table 9-1). Nectar entry by humans: **one
NECTAR per own-HIVE TIP, or all remaining at ≤ 60 s** (G426, §10.1).

## 2. Field

- FIELD ≈ 144 × 144 in inside the walls; 36 soft tiles 24 × 24 × 0.59 in (§9.2, p64).
  Perimeter kit am-0481. Every tape line stays inside one tile (§9.3).
- Tile grid: columns A–F (x = −72…+72 in 24-in steps), rows 1–6 (y = −72 audience … +72).
  Seam/tab lines V–Z at x = −48, −24, 0, +24, +48 and rows 1–5 at y = −48…+48 (Fig 9-4/9-5, p67).
- Elements on the field: **1 HIVE Structure** (frame + red HIVE + blue HIVE) at centre, **4
  FLOWERS** on the perimeter wall (§9.2). Nothing else is solid.

### 2.1 Zones and areas (§9.3, Fig 9-2 p65, Fig 9-3 p66, glossary)

The layout is **point-symmetric (180° about the origin), not mirrored**: red's LOADING ZONE is
on the far (rear) half of the left wall, red's GARDEN is the audience-left corner; blue's are
the diagonal opposites.

| zone | alliance | manual size | sim rect (in) | source |
|---|---|---|---|---|
| LOADING ZONE | red | ~23 wide × 11 deep, bounded by tape + wall, tape included; width "set by TILE seams" | x ∈ [−72, −61], y ∈ [+24, +48] | Fig 9-2/9-3; the seams at rows 4 and 5 (`APPROX` ±0.5 for tape) |
| LOADING ZONE | blue | same | x ∈ [+61, +72], y ∈ [−48, −24] | point symmetry, Fig 9-2 |
| GARDEN | red | ~23 × 2 in, "defined by the outside edge of tape", two 1-in tapes | x ∈ [−72, −49], y ∈ [−72, −70] (along the audience wall from the red corner) | Fig 9-2/9-3, §10.3.1 ("corner closest to the ALLIANCE AREA, contacting the audience or rear wall") |
| GARDEN | blue | same | x ∈ [+49, +72], y ∈ [+70, +72] (rear wall, blue corner) | point symmetry |
| ALLIANCE AREA | each | ~97 wide × 54 deep, OUTSIDE the field, centred on the side wall | red x ∈ [−126, −72], y ∈ [−48.5, +48.5]; blue mirrored | glossary p169; Fig 9-2. Not drawn (DECODE precedent) |

Tape is 1 or 2 in red / electric-blue gaffer (§9.3). GARDENS are **not protected** (§10.5.3,
G411 note). LOADING ZONE belongs to the alliance whose ALLIANCE AREA it adjoins.

### 2.2 HIVE Structure (§9.6, Figs 9-7…9-11, pp69–73)

Frame: two triangular metal structures joined at the apex by a crossbar, on mounting strips
under the tiles. **49.46 in wide (x) × 38.95 in deep (y)** at the base, which is its widest
point; pivot axes **43.95 in** above the tiles (§9.6.1). A BIOBUZZ logo panel on each side.

- **THE SEE-SAW IS ONE RIGID BAR AT 30°, SO BOTH CELLS FORESHORTEN EQUALLY IN PLAN.** The two
  cells sit on one assembly through the pivot; one end is high and one is low, but both are at
  30° from horizontal, so a top-down view projects both by `cos 30° = 0.866`. Only `z` tells
  them apart. Measured (owner CAD, 2026-09-12): the cell outer face is **21 in from the pivot**
  in 3-D, and the cell is a **rectangular prism 12 in deep**. Projected:

  | along the hive axis, from the pivot | true (in) | **plan (× cos 30°)** |
  |---|---|---|
  | cell outer face | 21.46 | **18.58** |
  | cell centre | 15.44 | **13.37** |
  | cell inner face | 9.42 | **8.16** |
  | cell depth | 12.04 | **10.43** |
  | assembly end to end | 42.91 | **37.16** |

  The 20-in opening WIDTH is perpendicular to the tilt axis and is NOT foreshortened, so a
  cell's plan footprint — the launch accept window — is **20 wide × 10.43 deep**, centred 13.37
  from the pivot. (The manual's 18.84 is the gap between the two cells' INNER faces, 2 × 9.42;
  it is not the centre spacing.)
- **HIVE centre to centre 25.5 in** (Fig 9-10) → red pivot x = −12.75, blue pivot x = +12.75
  (`APPROX` that the pair is centred on the field — Fig 9-2 shows it so).
- Frame base bars: **bent sheet metal, effective 1 in thick, with one edge ON the tile seam at
  x = ±24 and the other 1 in OUTWARD** (owner CAD, 2026-09-12) — so a bar occupies x ∈ [24, 25]
  and x ∈ [−25, −24]. Feet at y ≈ ±19.4 (Fig 9-8 gives a 38.95-in frame depth; the CAD measure
  reads 38.80). The space under the hives is drivable:
  bottom of a HIVE is 25.5 in above the tiles (Fig 9-10) and G409 assumes robots drive under it.
- Each HIVE = 2 CELLS (same colour) on a connecting bar, rotating on the pivot; **bi-stable**,
  one CELL up at a time. Cells **18.84 in apart**, each **12.04 in deep**, assembly **42.91 in**
  end to end (Fig 9-9) → cell centres ±15.4 in from the pivot along the HIVE axis, which runs
  along **y** (cells are north/south of the pivot — Fig 9-2, 9-17).
- Tilt **30°** from level in each stable state (Fig 9-10). Top of the up-CELL opening **65.6 in**
  above tiles, bottom of the up-CELL opening **53.5 in**, bottom of the (down) HIVE **25.5 in**.
  Horizontal projection of a cell centre from the pivot at 30° ≈ 15.4·cos30 ≈ **13.4 in**
  (`APPROX`, derived).
- CELL opening ≈ **20 wide × 14 tall × 12 deep** (§9.6.2, Fig 9-11; interior height 7.61 to the
  roof break).
- **The CELL is open at its OUTER end only** (owner ruling 2026-09-12): the 20 × 14 opening of
  Fig 9-11 is the face perpendicular to the bar at the end away from the pivot. Up, it faces
  up-and-outboard, so a LAUNCH must arrive travelling toward the pivot; down, it faces
  down-and-outboard, which is where a TIP spills its contents (outboard of the down cell).
- **Swing time ≈ 4 s** stable to stable (owner ruling 2026-09-12). Contents leave as the bar
  passes level; the TIP scores when the damper meets the frame.
- A **damper** on each HIVE contacts the frame in a stable state (Fig 9-9, Fig 10-3).
- **AprilTag cluster** (4 tags, 36h11, 3.25 in) on the bottom face of every CELL, bottom edge
  toward field centre (§9.9, Figs 9-15…9-17, pp74–77). IDs: red CELL rear (opposite audience)
  **30 31 32 33**, red CELL audience side **34 35 36 37**, blue audience **38 39 40 41**, blue
  rear **42 43 44 45**. Cluster centreline 9.938 in from the cell front; tags on 2.75-in
  centres in two pairs 7.0 in apart (Fig 9-15).
- **Staged pose** (§10.3.1, Fig 10-2 p83): each HIVE tilted so the CELL that "points at a
  FLOWER" is DOWN. Red: **up-CELL = south (y < 0)**, blue: **up-CELL = north (y > 0)**.

### 2.3 FLOWER (§9.7, Fig 9-12, pp72–73)

Four, attached to the perimeter wall, one per wall, on the tile seam one tile off centre
(`APPROX` from Fig 9-2 / 9-4 pixel measurement: ±24 ± 1 in; point-symmetric):

| flower | wall | centre (sim) | nearest alliance |
|---|---|---|---|
| F1 | left (x = −72) | (**−69.46**, **−24**) | red |
| F2 | rear (y = +72) | (**−24**, **+69.46**) | red side of the rear wall |
| F3 | right (x = +72) | (**+69.46**, **+24**) | blue |
| F4 | audience (y = −72) | (**+24**, **−69.46**) | blue side of the audience wall |

Measured (owner CAD, 2026-09-12): the ring centre is **2.54 in** from the wall face, and each
flower sits **exactly on the centreline of the tile seam** — x or y = ±24.000, not offset to one
side.

**The footprint is a RECTANGLE, not a circle**: the face parallel to the wall is **4.9 in** from
it and the flower is **~6 in wide** along the wall. So the solid a robot meets is a 6 × 4.9 in
box flush against the wall, with the 4.0-in ring opening inside it 2.54 in off the wall — not
the `APPROX` 2.6-in disc the first pass assumed.

Geometry: top ring opening **4.0 in dia** at **21.5 in** above tiles; backstop **1.25 in** tall
on the field side of the top ring; retrieval opening at the bottom **3.55 in tall × 3.57 in
deep**; lower ring **0.4 in** tall (0.43 in Fig 9-12) with a **2.79 in** hole; upper and middle
rings joined by four HIPS pipes; middle and lower rings joined on the wall side by square
extrusion. Top ring plate half-widths 2.40 / 1.89 / 1.94 (Fig 9-12) → footprint `APPROX` a
~5 in rounded square.

**Scoring volume** = between the top ring and the middle ring (§10.5.2, CAD ref 10-4):
`APPROX` z ∈ [3.98, 21.5] (middle ring top = 3.55 + 0.43). A 2.8 pollen passes the top opening
(4.0) and the retrieval opening (3.55) but not the lower hole (2.79); a 3.6 NECTAR passes the top
opening only — which is why G418 says POLLEN out of the bottom and nothing else.

### 2.4 Scoring elements (§9.8, p74; glossary)

| element | size | count | colour | AndyMark |
|---|---|---|---|---|
| POLLEN | ≈ **2.8 in** (7.1 cm) Gopher ResisDent polyethylene | **40** | yellow | am-5851 |
| NECTAR | ≈ **3.6 in** (9.1 cm) same family | **8 red + 8 blue** | red / blue | am-5852 |

"Not perfectly spherical and may vary in size." Mass is not published — **weigh a set on
09-14** (it decides the tip threshold, §4.1).

## 3. Staging (§10.3.1, Fig 10-2 p83; §10.3.4 p85)

40 POLLEN: **4 in each FLOWER** (16) · **4 in the red GARDEN** · **4 in the blue GARDEN** ·
**4 pre-loaded per ROBOT** (16; in/on the robot or on the tiles touching it — G304.G, §10.3.4).
Garden pollen "in a line starting in the corner closest to the ALLIANCE AREA and contacting the
audience or rear perimeter wall". A no-show robot's 4 go to ~the centre of its LOADING ZONE
against the wall.

16 NECTAR: **3 in each upward-facing CELL** of matching colour (6) — against the back wall of
the CELL, in a line on the side closest to that alliance's area — and **5 in each ALLIANCE
AREA** (10), entered by humans per G426/G427.

Robots (G304): fully on own side (red x < 0 / blue x > 0), touching the perimeter wall, not in
a LOADING ZONE, not contacting or inside a FLOWER's scoring volume, in STARTING CONFIGURATION
(R102 18-in cube), contacting exactly 4 POLLEN, motionless. Fig 11-1 (p105) shows examples.

## 4. Scoring (§10.5, Table 10-2 p91)

| achievement | AUTO | TELEOP | assessed |
|---|---|---|---|
| LEAVE — no longer contacting the perimeter wall | 3 | – | end of AUTO |
| PARK — at least partially in the LOADING ZONE (Fig 10-7) | 5 | 5 | end of AUTO / end of MATCH |
| HIVE TIP | 20 | 20 | throughout; complete before TELEOP starts ⇒ AUTO |
| POLLEN / NECTAR remaining in an upward-facing CELL | – | 2 each | at rest after the match |
| Bottom NECTAR Bonus (bottom-most nectar of your colour in a FLOWER) | – | 5 per flower | live, final at rest |
| POLLEN / NECTAR in a FLOWER you OWN | – | 2 each | live, final at rest |
| POLLEN / NECTAR at least partially in a GARDEN (credited to the garden's colour, whoever placed it) | – | 1 each | at rest after the match |

RP (Table 10-2/10-3): **SWARM** LEAVE + PARK points ≥ **16**; **POLLINATOR 1** ≥ **4 TIPS**;
**POLLINATOR 2** ≥ **7 TIPS**; WIN 3, TIE 1 (thresholds are for "all other events"; regionals
and Championship TBA).

### 4.1 HIVE TIP (§10.5.1, p87)

TIPPED when (A) the HIVE moves from one stable state to the other, the down-CELL becoming the
up-CELL, and (B) the damper that was not contacting the frame begins to contact it. "Bi-stable
… holds its position until enough POLLEN or NECTAR are LAUNCHED into the upwards-facing CELL"
(§9.6). **The manual does not print the load.** It was MEASURED on a real HIVE (owner,
2026-09-12) — these are the configurations in the up-CELL that tip it:

| NECTAR in cell | POLLEN needed to tip |
|---|---|
| 0 | not measured — `APPROX` 8 |
| 1 | 7 |
| 2 | 6 |
| 3 | **3** |
| 4 | 1 |
| 5 | 0 (tips on the fifth NECTAR alone) |

**This is a TABLE, not a mass.** No single linear weighting fits it: 1n+7p and 2n+6p equal
would make a NECTAR worth one POLLEN, and 3n+3p then contradicts it. The seesaw is torque and
packing, not weight, so the sim carries the measured rows and interpolates nothing. It is
monotone (more of either element still tips), so the test is `pollen >= NEEDED[min(nectar, 5)]`.

**The staged row is the one that matters**: a HIVE is staged with **3 NECTAR** in its up-CELL
(§3), so the first TIP of a match costs **3 POLLEN** — reachable in AUTO.

The only legal way to induce a TIP is LAUNCHING into the up-CELL (G417). Contents of a cell
that goes down spill onto the tiles (G409 intent: "hit the TILE floor before it is collected").

### 4.2 FLOWER (§10.5.2, Fig 10-5 p89)

Elements score when at least partially inside the scoring volume. **Owner** = alliance of the
**top-most NECTAR** of its colour meeting the criteria; the owner earns 2 per element in that
FLOWER regardless of who placed it. **Bottom NECTAR Bonus** 5 to the alliance of the
**bottom-most** scoring NECTAR. No nectar ⇒ no owner, no bonus. Fig 10-5 cases A–H (a nectar
above the top ring on the backstop still counts if partially inside; one on the tiles under the
lower ring does not) are the table-driven test set.

### 4.3 GARDEN (§10.5.3, Fig 10-6 p90)

Partially in the 23 × 2 strip counts (a circle overlapping the rect). Either alliance may remove
elements from either garden. Nectar of either colour scores for the GARDEN's colour.

## 5. Rules the sim can enforce (Section 11, pp99–117; violations Table 10-4 p92)

**MINOR FOUL = 5, MAJOR FOUL = 20** (Table 10-4 — DECODE's MAJOR was 15). MOMENTARY < ~3 s,
CONTINUOUS > ~10 s, REPEATED = more than once per match, STRATEGIC = for advantage (§10.6).

| rule | text | penalty | sim treatment |
|---|---|---|---|
| G304 | start position (see §3) | match will not start | `evalStart` + editor, `startLegality: true` |
| G402 | no AUTO opponent interference; red side = columns A–C, blue = D–F | MAJOR per match (+ card if STRATEGIC) | DECODE's G402 shape: crosser on the wrong side + contact during AUTO |
| G405 | don't eject elements from the field | MAJOR per element | structural (nothing leaves the field) |
| G407 | **CONTROL no more than 4 SCORING ELEMENTS** | VERBAL; MAJOR + card if STRATEGIC (example A: 6+) | hopper cap 4; herding count warned at 5, MAJOR at 6+ |
| G408 | don't CONTROL opponent NECTAR | VERBAL; card if STRATEGIC | intake refuses opponent nectar |
| G409 | don't catch elements spilling from a TIPPED HIVE | VERBAL; card if STRATEGIC | not modelled (spill lands on tiles) |
| **G410** | **no NECTAR into a FLOWER before 1:00 left** | **MAJOR per NECTAR** | element entry event; the achievement still scores |
| G411 | no hoarding | MAJOR + card | not modelled |
| G417 | don't meddle with the HIVE (ram the frame, launch at the outside of a cell) | VERBAL; MAJOR + card if STRATEGIC | frame-ram speed threshold `APPROX`; VERBAL then MAJOR if REPEATED |
| G418 | FLOWER: enter only via the top, remove only POLLEN from the bottom | VERBAL; MAJOR + card if STRATEGIC | structural |
| G421 | PIN ≤ 3 s (2-ft / 3-s release, pause/resume) | MAJOR + MAJOR per further 3 s | DECODE's pin detector, MAJOR tariff |
| G426/G427 | humans enter NECTAR only per TIP / at ≤ 60 s, only via own LOADING ZONE, contacting the tile first | MINOR per nectar | structural (the sim's human player obeys) |

Cards: a second YELLOW in the same tournament phase is a RED = DISQUALIFIED (§10.6.1); playoffs
card the whole alliance (§10.6.3).

## 6. Robot envelope (Section 12) — Lane B facts the field depends on

- **R102** STARTING CONFIGURATION 18 × 18 × 18 in; preloaded elements may extend outside.
- **R105** expanded envelope **18 × 24 × 29 in tall**, physically constrained, one assembly.
  So a robot expands along ONE horizontal axis only (`BB_PRISM` 24 was the right guess).
- **R104** no weight limit. **G407** effectively caps the hopper at **4** elements.
- A 29-in robot is taller than the 25.5-in bottom of the down-HIVE — 2D sim ignores it.

## 7. Figures used

Fig 9-2 zones (p65) · 9-3 LZ/garden dims (p66) · 9-4/9-5 tile coordinates (p67) · 9-7…9-11 hive
(pp69–72) · 9-12 flower (p73) · 9-15…9-17 AprilTags (pp75–77) · Table 9-1 cues (p79) · 10-2
staging (p83) · 10-3 damper (p87) · CAD 10-4 flower volume (p88) · 10-5 ownership (p89) · 10-6
garden (p90) · 10-7 park (p90) · Table 10-2/10-3 points and RP (p91) · Table 10-4 fouls (p92) ·
11-1 start examples (p105).

Re-derive any pixel measurement with `python scripts/manual-render.py --pages 63-99 --dpi 300`
(on `biobuzz-field`; rasterises to `scratch/manual/pages/`, gitignored — the drawings are vector
paths, so `scripts/manual-figures.mjs` finds no image object for them). At D dpi a PDF point is
D/72 px; one stated dimension (the 144-in field) fixes the drawing scale. Manual page images
never go in the repo.

## 8. APPROX to settle on a real field (09-14)

Most of this list was settled by owner CAD measurement on 2026-09-12 and folded into the
sections above: flower stand-off 2.54 · flower footprint a 6 × 4.9 rectangle · flower exactly on
the seam centreline · frame bar 1 in thick with one edge on the ±24 seam, extending outward ·
cell outer face 21 from the pivot, prism 12 deep, both cells foreshortened by cos 30° in plan.
What is still open:

- LOADING ZONE tape: inside edge at x = ±61, and which side of the row-4 / row-5 seams the tape
  sits on. `APPROX` ±0.5 in, cosmetic.
- HIVE pair centred on the field? Pivot x = ±12.75 assumed from "25.5 centre to centre".
- **Tip load with an EMPTY cell** — the one row of §4.1 not measured (`APPROX` 8 POLLEN).
- Spill kinematics: how fast contents leave the open face as the bar passes level (`APPROX`
  40–60 in/s outboard), and how far they roll on the tiles.
- Element rolling behaviour: does a NECTAR roll like a POLLEN on the soft tiles (owner note).

## 9. Intake pipeline

How the numbers above got out of the PDF, and what to re-run when V2 lands.

- **Manual PDF**: `https://ftc-resources.firstinspires.org/ftc/game/manual-NN`, fetched by
  `scripts/manual.mjs`. WebFetch's own PDF extractor returns binary garbage on these.
- **Text**: `pdftotext -layout` for prose; `pdftotext` WITHOUT `-layout` for the Section 16
  glossary, whose two columns interleave otherwise.
- **Raster figures**: `scripts/manual-figures.mjs` (Node stdlib — `pdfimages` is not on this
  machine, and the header of that file explains why writing one was cheaper than installing
  one). It finds image objects only; it finds nothing on the field drawings.
- **Vector drawings**: `scripts/manual-render.py` (PyMuPDF) —
  `python scripts/manual-render.py --pages 63-99 --dpi 300`, output to `scratch/manual/pages/`
  (gitignored). Every field figure in Section 9 is vector paths, so this is the only way to
  measure them. Verified end to end against V0 p.61 at 200 dpi. **Manual page images never go
  in the repo.**
- **Scale**: at D dpi a PDF point is D/72 px; one stated dimension (the 144-in field) fixes
  the drawing scale for every other measurement on that page.

### Cross-checks worth doing once

- **AprilTag mirror test.** Take one published BIOBUZZ AprilTag or HIVE coordinate in the FTC
  field frame and confirm it lands on the side this document says it does. DECODE's red goal
  tag at FTC (−58.37, 55.64, 29.5) resolving to the far-RIGHT corner is what proved that field
  was not mirrored, and a mirrored field is the error that survives every internal consistency
  check. BIOBUZZ is point-symmetric rather than mirrored (§2), so this check is worth MORE
  here, not less: an x-mirror of a point-symmetric layout is internally consistent and wrong.
- **Two dimensions per drawing.** Measure a second known length on the same page and confirm
  the scale factor agrees before trusting anything derived from the first.
- **Prose against figure.** Where the manual states a dimension in words AND draws it, measure
  anyway. DECODE's 26.5" goal face and 18.3" goal depth came off the figures because the prose
  did not carry them.
