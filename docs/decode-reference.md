# DECODE (FTC 2025-26) — game & field reference

Distilled from the official Competition Manual (v9, Sections 9 "Arena" and 10 "Game
Details"), the ftc-docs field diagrams, and pixel measurements of the manual's figures.
This is the ground truth the sim implements. Field coordinates below are the sim's
world frame: origin at field center, +x = audience's right, +y = away from audience,
inches.

## Match structure

| Phase | Duration |
|---|---|
| AUTO | 30 s |
| Transition | 8 s |
| TELEOP (driver-controlled) | 2:00 |

## Scoring (implemented values)

| Achievement | Points | When assessed |
|---|---|---|
| LEAVE (robot clear of all launch lines) | 3 / robot | end of AUTO |
| CLASSIFIED artifact (passes SQUARE onto ramp) | 3 | on entry, AUTO or TELEOP |
| OVERFLOW artifact (ramp full, rides over gate) | 1 | on entry |
| PATTERN (ramp slot color matches motif at index) | 2 / slot | snapshot end of AUTO + end of match |
| DEPOT artifact (resting in depot band) | 1 | end of match |
| BASE partial / full / both-robots bonus | 5 / 10 / +10 | end of match |
| Fouls (Section 11) | MINOR 5, MAJOR 15, awarded to the OPPOSING alliance | on violation (edge-triggered, no cooldown) |

Motifs (obelisk AprilTags): 21 = GPP, 22 = PGP, 23 = PPG. The motif repeats 3× over
the 9 ramp positions, index 0 = nearest the gate.

## Artifacts

36 total: 24 purple, 12 green, 5 in diameter. Per alliance: 9 on spike marks
(near = GPP, middle = PGP, far = PPG), 3 pre-staged in the loading zone (PGP), 6 in the
alliance area (4P+2G). The 3 loading-zone artifacts are pre-staged ON the field in the
loading-zone corner: PGP, touching, flush against the alliance (side) wall, stacked up
from the very corner (manual setup — present from the start of the match). Each present
robot preloads one 3-ball alliance-area set; any set no robot claims seeds the human
player's out-of-play 2×3 BOX (leftovers only: 2 robots → 0, 1 → 3, 0 → 6), drawn OFF
the field just beyond the audience wall (the human player stands off-field).
**The human player does NOTHING until teleop** (idle through pre/auto/transition). Once
teleop starts it (a) moves the corner pre-stage into the GRAB ROW — a row along field-x
(vertical on the driver's rotated screen) so a robot sweeps all 3 driving along x — and
(b) continuously grabs loose/returned artifacts out of the loading zone into the box (up
to the 6 cap) and feeds them back into the grab row one at a time (~0.35 s apart when a
slot is free). One-at-a-time keeps box + in-transit within the 6-out-of-play cap.

## Field map (sim world frame)

```
                         far wall  (obelisk outside at (0, 78))
   BLUE GOAL (tag 20)  ┌────────────────────────────────────┐  RED GOAL (tag 24)
   right-tri corner →  │◣                                  ◢│ ← right-tri corner
   26.5"(far)x18.3"    ║                                    ║  26.5"x18.3", face =
   (side); face = the  ║      big LAUNCH ZONE (shared)      ║  the hypotenuse
   hypotenuse (~34.6°) ║      triangle: y >= |x|            ║  (~34.6°, NOT 45°)
   blue classifier on  ║   apex at field center (0,0)       ║  red classifier on
   LEFT (red) wall,    │                                    │  RIGHT (blue) wall,
   gate at y≈0         │  spike col x=-48.5   x=+48.5 spike │  gate at y≈0
   red tunnel strip    │  rows y = -35.5, -12.8, +11.1      │  blue tunnel strip
   (under blue ramp)   │                                    │  (under red ramp)
                       │  red base(-33,-39)  blue base      │
   RED drive team →    │        18x18       (+33,-39)       │  ← BLUE drive team
   (left wall)         │      audience triangle zone        │  (right wall)
   red LOADING corner  └────────────────────────────────────┘  blue LOADING corner
   23×23                        audience wall                  23×23
```
Base center x = driverSide·33 (blue drives at +x, red at −x). Drive-team ALLIANCE
AREAS are outside each wall but are no longer drawn (field enlarged); the
`allianceArea` helper remains for zone/penalty logic.

Key numbers (all in `src/config.ts`):

- Field 144×144, tiles 24.
- GOAL: a right triangle in the far corner, legs flush along the walls —
  `GOAL_FACE_WIDTH` 26.5 in along the far wall, `GOAL_DEPTH` 18.3 in down the side wall,
  right angle at the field corner. The FACE (what robots shoot at) is the hypotenuse,
  `GOAL_FACE_LEN` ~32.2 in, ~34.6° off the far wall — **NOT 45°** (corrected July 2026,
  measured from the manual's "Top View Goal Opening Inside Dimensions"). Helpers:
  `goalTriangle` / `goalFacePoints` / `goalFaceNormal` (unit normal into the field) /
  `goalCenter` (opening centroid, the aim target). `goalLineValue(p,a)` = TRUE signed
  perpendicular inches from the face (>0 behind it inside the footprint, <0 field side);
  no SQRT2 scaling anywhere. Opening lip at z = 38.75, effective entry radius 11.
- Classifier channel: 6 in wide against the side wall (`CLASSIFIER_W`), from the gate up
  into the far corner. Rail: `s = y − 2`, SQUARE (rail top) at `RAIL_S_MAX` = 55, stack
  pitch 5.1, 9 retained max, gate stop s = 2. `basinFunnelTarget` sits just INSIDE the
  goal footprint so basin balls can reach it (moved inward when the goal was reshaped).
- GATE ZONE marking: TWO thin parallel alliance-colored tape LINES, 10 in long, 2.75 in
  apart (`GATE_TAPE_W`), starting at the classifier edge (x = ±66) and running into the
  field, centered on the gate (`gateTapeSegments` → line pairs, drawn). The gate-opening
  INTERACTION rect (`gateZone`, 10×5) is larger and intentionally not drawn — feel over
  strict tape geometry.
- Secret tunnel floor strip beneath each channel belongs to the OPPOSING alliance
  (it is on their wall), `TUNNEL_STRIP_LEN` = 46.5 in from the gate toward the
  audience, `TUNNEL_W` = 6.125 in wide (its own constant, drawn with a colored outline);
  exiting balls emerge at the gate mouth rolling toward the audience.
- Launch zones (shared by both alliances): `y ≥ |x|` and the audience triangle
  (apex (0,−48), base 2 tiles on the audience wall). Depot lines near the goals are
  launch lines too (they matter for LEAVE); the big-triangle diagonals are clipped at
  the goal face (`clipToGoalFace`) so they don't run into the goals.
- Depot: band in front of each goal face, `DEPOT_DEPTH` (6 in) deep; the DEPOT tape line
  runs flush ALONG the goal face (the hypotenuse) from the far-wall corner to the
  classifier edge (x = ±66) — it stops at the channel, does NOT run to the side wall
  (`depotSegment`). Band fill no longer drawn; the white tape line is drawn last.
- BASE ZONE: 18×18, corners at (d·24, −48) & (d·42, −30), center (d·33, −39) where
  d = driverSide (blue +x, red −x). Parking: ≥1 wheel in ⇒ PARTIAL (5), all four ⇒
  FULL (10); counts the four WHEEL ground-contact points only, not intake/turret overhang.
- ALLIANCE AREA: 96 in (along wall) × 54 in (outward) taped rectangle OUTSIDE each
  alliance's own wall (red left, blue right), flush with the audience end — NOT
  wall-centered (`allianceArea`). Verified from the Section 9 figures re-extracted
  July 2026. No longer drawn (field enlarged); helper retained for zone/penalty logic.
- Spike marks: column center at x = ±48.5 — ONE tile (~23.5 in) from each side wall
  (re-verified against the markings figure; an older "two tiles" comment was wrong,
  the value was right). Rows y = −35.5 / −12.8 / +11.1, 10 in white tape each.

## Where this came from (for future verification)

- Manual section PDFs: `https://ftc-resources.firstinspires.org/ftc/game/manual-09`
  (arena) and `manual-10` (game details). Text extracts via a stdlib-Python
  stream-inflater; figures via an embedded-image extractor, then Read as images.
- Official diagrams: `ftc-docs.firstinspires.org` — `decode-field.png` (axes/walls),
  `decode-apriltags.png` (tag IDs 20/24, obelisk 21-23, goal colors per corner).
- Zone placements: pixel-measured from the manual's Figure 9-3 orthographic crops
  (the img16 crop with the 96×54 alliance area dimension arrows is the calibration
  reference: 0.133 in/px). The big top-view render (img08) has perspective — do NOT
  measure y positions from it.
- FTC field coordinate convention cross-check: red goal AprilTag at FTC
  (−58.37, 55.64, 29.5) ⇒ far-right corner ⇒ our red goal (+x side). ✓

## Deliberate deviations from strict realism (user product decisions)

- Shooter is idealized: no dispersion, adaptive hood angle, instant turret — the
  robot never misses. The FIRST shot is always instant; between shots the cadence is
  the intake preset's transfer interval PLUS a flywheel-recovery term that only slows
  FAR shots on LOW-inertia flywheels (Phase B — `flywheelInertia` slider, config
  `FLYWHEEL_*`). Close-range rapid fire is unchanged at any inertia.
- Classified/overflow decision happens at CONTACT on the rail (a ball commits when it
  first meets the column or gate floor — 9 below ⇒ overflow, else classified) instead
  of the manual's judgment language; a gate tap draining in time can save an incoming ball.
- The field is multi-robot (Phase B): up to 2 per alliance from `RobotSetup`s, spawned
  and stepped from a command map keyed by id (the multiplayer seam). Referee judgment /
  fouls: the penalty engine (Section 11) is Phase C — in progress; scoring is tracked
  per alliance and `world.rrContacts` records robot-robot contacts per tick for it.
