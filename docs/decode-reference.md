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
| Fouls (not simulated) | minor 5, major 15 | — |

Motifs (obelisk AprilTags): 21 = GPP, 22 = PGP, 23 = PPG. The motif repeats 3× over
the 9 ramp positions, index 0 = nearest the gate.

## Artifacts

36 total: 24 purple, 12 green, 5 in diameter. Per alliance: 9 on spike marks
(near = GPP, middle = PGP, far = PPG), 3 in the loading zone (PGP), 6 in the alliance
area (4P+2G) of which up to 3 are preloaded; the sim gives the rest to the human
player as restock stock (placed into the loading zone every ~3 s when a slot is free).

## Field map (sim world frame)

```
                         far wall  (obelisk outside at (0, 78))
   BLUE GOAL (tag 20)  ┌────────────────────────────────────┐  RED GOAL (tag 24)
   wedge vs far wall → │◤                                  ◥│ ← wedge vs far wall
   blue classifier     ║                                    ║  red classifier
   channel on the      ║      big LAUNCH ZONE (shared)      ║  channel on the
   LEFT (red) wall,    ║      triangle: y >= |x|            ║  RIGHT (blue) wall,
   gate at y≈0         ║   apex at field center (0,0)       ║  gate at y≈0
                       │                                    │
   red tunnel strip    │  spike col x=-48.5   x=+48.5 spike │  blue tunnel strip
   (under blue ramp)   │  rows y = -35.5, -12.8, +11.1      │  (under red ramp)
                       │                                    │
   RED ALLIANCE        │  red base(-36,-36)  blue base      │  BLUE ALLIANCE
   AREA (left wall)    │        18x18       (+36,-36)       │  AREA (right wall)
                       │      audience triangle zone        │
   red LOADING corner  └────────────────────────────────────┘  blue LOADING corner
   23×23                        audience wall                  23×23
```

Key numbers (all in `src/config.ts`):

- Field 144×144, tiles 24.
- Goal face line: blue `y − x = 117`, red `y + x = 117`; drawn wedge
  `(±45,72) (±66,51) (±66,72)` (corner cut by the classifier channel). Opening lip at
  z = 38.75, opening center `(±58, 64)`, effective entry radius 11.
- Classifier channel: 6 in wide against the side wall, from the gate tape (y ≈ 0,
  10 in tape at `GATE_ZONE`) up into the far corner. Rail: `s = y − 2`, SQUARE at
  s = 48, stack pitch 5.1, 9 retained max, gate stop s = 2.
- Secret tunnel floor strip beneath each channel belongs to the OPPOSING alliance
  (it is on their wall); exiting balls emerge at the gate mouth rolling toward the
  audience.
- Launch zones (shared by both alliances): `y ≥ |x|` and the audience triangle
  (apex (0,−48), base 2 tiles on the audience wall). Depot lines near the goals are
  launch lines too (they matter for LEAVE).
- Depot: band in front of each goal face, `DEPOT_DEPTH` (6 in) deep.

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
  robot never misses. Cadence (0.1 s) is the only fire limit; no flywheel model.
- Classified/overflow decision happens at the SQUARE via physical queueing (a ball
  waits in the funnel while the entrance is busy) instead of the manual's judgment
  language; only a full 9-ball ramp produces overflow.
- Fouls, referee judgment, and the 2-robot-per-alliance structure are not simulated
  (solo practice); scoring is tracked per alliance and the sim core supports N robots.
