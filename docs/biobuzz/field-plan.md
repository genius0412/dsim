# BIOBUZZ field plan (Lane A) — PROPOSAL, 2026-09-12

> **BRANCH CHANGE (2026-09-12):** the shared base is **`alpha`**. `biobuzz` was merged into
> `alpha` and deleted on origin. Wherever this file says branch `biobuzz`, read `alpha`: merge
> `alpha` before you commit, land into `alpha`, `alpha` deploys.

Companion to `docs/biobuzz-reference.md` (the facts) and `docs/biobuzz-contract.md` (who edits
what). This is the build order for `src/games/biobuzz/` on the field side, what it needs from
the shared core, and what is still a guess. Nothing here is built yet.

## 0. What changes about the game as understood before kickoff

- **Two element sizes on the floor**, not one. POLLEN 2.8 in and NECTAR 3.6 in both roll on the
  tiles, get pushed by robots and pile in corners. The shared solve takes ONE radius
  (`solveArtifacts(…, radius)`, `robotSolids(…, radius)`). See §6, request 1.
- **Elements live in three places that are not the floor, a hopper or flight**: inside a HIVE
  CELL, stacked inside a FLOWER, and in the human player's hand (nectar stock). `Artifact.state`
  has no member for the first two. See §6, request 2.
- **The scoring target is high and moving in a way that matters**: the up-CELL opening is
  53.5–65.6 in above the tiles, tilted 30°, and it swaps to the other end of the HIVE every TIP.
  Launch arcs in `releasePollen` finally have something to solve against.
- **Foul values differ from DECODE** (MAJOR 20, not 15). `awardFoul` reads `C.PTS_FOUL_MAJOR`.
- **G407 caps CONTROL at 4** → the hopper dial's ceiling is 4, and a robot starts full (4
  preloads). Lane B's `BB_STORAGE_MAX` 24 / default 8 are wrong by the manual.
- Layout is **point-symmetric**, not mirrored: the start-pose mirror in `spawn.ts`
  (`x → −x`) is wrong for the zones. Red's LOADING ZONE is at y > 0, blue's at y < 0.

## 1. Geometry (config.ts, state.ts, colliders.ts) — kickoff day

Constants, each with the figure it came from or `APPROX`:

```
BB_POLLEN_R  = 1.4      // 2.8 in, §9.8 (was 1.5 APPROX)
BB_NECTAR_R  = 1.8      // 3.6 in, §9.8
BB_LZ  red: x[-72,-61] y[24,48]   blue: point-mirror        // Fig 9-2/9-3, seams; tape APPROX
BB_GARDEN red: x[-72,-49] y[-72,-70]  blue: point-mirror     // Fig 9-2/9-3
BB_HIVE_X = ±12.75 (pivot), axis along y                    // Fig 9-10 "center to center 25.5"
BB_HIVE_CELL_DY  = 13.37  // 15.44*cos30 — cell centre, PLAN        (measured, reference 2.2)
BB_HIVE_CELL_LEN = 10.43  // 12.04*cos30 — cell depth, PLAN
BB_HIVE_LEN      = 37.16  // 42.91*cos30 — assembly end to end, PLAN (NOT 42.91)
BB_CELL_OPEN = { w: 20, d: BB_HIVE_CELL_LEN }  // accept window; the width is not foreshortened
BB_HIVE_OPEN_Z = [53.5, 65.6], BB_HIVE_BOTTOM_Z = 25.5      // Fig 9-10
BB_FRAME_BAR_IN = 24, BB_FRAME_BAR_OUT = 25, BB_FRAME_Y = 19.4  // measured: 1-in bar, inner edge on the seam
BB_FLOWERS: (-69.46,-24) (-24,69.46) (69.46,24) (24,-69.46)     // measured: 2.54 off the wall, on the seam centreline
BB_FLOWER_FOOT = { along: 6, deep: 4.9 }  // RECTANGLE flush to the wall, measured
BB_FLOWER_TOP_Z = 21.5, BB_FLOWER_OPEN_R = 2.0, BB_FLOWER_VOL_Z = [3.98, 21.5] APPROX // Fig 9-12
BB_TIP_POLLEN = [8, 7, 6, 3, 1, 0]   // MEASURED (ref §4.1); index = NECTAR in cell; [0] APPROX
BB_FLOWER_UNLOCK_S = 60                                       // G410
PTS: leave 3, park 5/5, tip 20, cell 2, bottom-nectar 5, owned 2, garden 1; RP 16 / 4 / 7
```

Colliders: four walls (kept) + two frame base bars (1 in thick, inner edge on the ±24 seam,
extending outward) + four flower footprints (6 × 4.9 in RECTANGLES flush to their wall — not
circles).
`clampBallPosToStatics`-style containment for the new solids is the shared solve's job — the
field only declares `StaticSpec`s. Bounds/camera unchanged (everything is inside the walls).

Point-symmetry helper: `mirror(p) = {x: -p.x, y: -p.y}`, `heading + π`. Replaces the x-mirror
for zones AND for start anchors (a red robot starting "beside its loading zone" is at y > 0).

First gallery cell: `field-labelled` redrawn — tape, gardens, flowers on their seams, the frame,
the two hives with the staged tilt and their AprilTag ids. Reviewed before any rule lands.

## 2. Elements and staging (spawn.ts, elements.ts, new hive.ts / flower.ts)

State additions (`BiobuzzState`, plain JSON):

```ts
hives: Record<Alliance, { up: 'north' | 'south'; contents: number[]; tips: number;
                          tipping: number /* s left in the swing, 0 = settled */ }>;
flowers: [FlowerState, FlowerState, FlowerState, FlowerState]; // { stack: number[] bottom→top }
nectarStock: Record<Alliance, number>;                          // 5 at setup
nectarDue: Record<Alliance, number>;                            // entries earned by TIPS, not yet placed
leave: Record<number, boolean>; parkAuto/parkTele: Record<number, boolean>;
```

Staging per Fig 10-2: 4 pollen bottom-up in each flower stack; 4 pollen per garden in a line
from the alliance corner along the wall; 4 preloads per robot into the hopper (cap 4 — if Lane
B's cap is lower, the rest go on the tiles touching the robot; a no-show's go to its LZ centre);
3 nectar in each up-cell (`contents`); 5 nectar per alliance in `nectarStock`. Total 40 + 16,
**conserved across floor + hopper + flight + cells + flowers + stock** — the smoke invariant.

`scoreTargets(world, a)` returns, in order: the alliance's own up-CELL (pos, z = 59.5, accept
rect 20 × 12 → `r` 8 APPROX), the opponent's up-CELL (REFUSED — owner ruling 2026-09-12, late:
an element launched by the other alliance does not enter; it is a miss and lands as ground.
`alliance` on the target is what the field and the launcher both read), and the four FLOWER
tops (z 21.5, r 2.0). `releasePollen(…, target)`
solves the arc for the target's z (the existing `Vec3` + `BB_LAUNCH_Z0`).

### 2.1 HIVE (hive.ts)

- **Capture**: a flight element whose (x, y) is inside the up-cell's accept rect while its z is
  in [53.5, 65.6 + margin] and descending → `contents.push(id)`, state `element`. Anything else
  hitting the cell box (outside faces, the down cell) bounces off the structure and falls
  (G417.H says missing is not a foul).
- **Open face** (owner ruling 2026-09-12): a CELL is a 20 × 14 × 12 prism open at its OUTER end
  only — the end away from the pivot. A shot enters only if it arrives travelling TOWARD the
  pivot along the hive axis (red, up = south: `vy > 0`; blue, up = north: `vy < 0`).
  `hiveAccepts` gates on the sign of the along-axis velocity as well as on footprint and z;
  from the pivot side a shot meets the closed back and bounces. This is a FIELD gate (Lane A).
  `ScoreTarget` grows an optional `mouth: Vec2` (unit vector OUT of the opening) so a launcher
  can tell it is on the wrong side, but the field, not the robot, is the authority.
- **Tip**: when `pollen >= BB_TIP_POLLEN[min(nectar, 5)]` — the MEASURED table in
  `docs/biobuzz-reference.md` §4.1, `[8 APPROX, 7, 6, 3, 1, 0]` indexed by the NECTAR count in
  the cell — start `tipping` — **the swing takes 4 s** stable to stable (owner ruling 2026-09-12,
  `BB_TIP_SWING_S = 4`); the hive accepts nothing mid-swing. No mass model: no linear weighting fits the
  measured rows. At the
  end of the swing: `up` flips, `tips++`, +20 to the hive's alliance (AUTO if `phase !== teleop`
  yet — §10.5.B), the old contents **spill**: they leave when the bar passes LEVEL (~2 s in), out
  of the open face, so they re-enter as flight artifacts under the going-down cell (x across the
  20-in mouth, y at the cell's outer edge, z from 25.5) with an OUTBOARD velocity along the hive
  axis — APPROX 40–60 in/s plus ±12 lateral, world-RNG — then land and roll on the shared
  solver. The tip itself (points, `up` flip) still scores at settle. `nectarDue[a]++`. Contents
  of the new up-cell: empty.
- **The threshold is MEASURED and settled** (owner, 2026-09-12). The staged cell holds 3 NECTAR,
  so the first tip of a match costs **3 POLLEN**. Only the empty-cell row (0 NECTAR) is still
  `APPROX` at 8.
- Render (owner rulings 2026-09-12): the **up cell is a filled box**; its contents are **one row
  of element-scale discs hugging the cell's OUTER (open) edge**, inside the box, oldest at one
  end — colour is the type, **no letters or digits anywhere** (no `N`, no counts). The **down
  cell is a dashed outline only**, no fill — it hangs 25.5 in overhead and robots drive under
  it. Balls on the tiles under either cell draw as ordinary GROUND balls (dark ring) on top of
  the outline, so a spill reads as floor, not as cell contents. The open face is marked: outer
  short edge thin, pivot-side edge heavy. `tipping` is a 4 s cross-fade, fill → outline and
  outline → fill. ⚠️ **BOTH cells foreshorten equally** — the see-saw is
  one rigid bar at 30°, so a plan view projects both ends by cos 30° and only `z` separates
  them; drawing the up cell full length and the down cell short is wrong. **The up-cell readout
  is PER TYPE** — POLLEN, RED
  NECTAR and BLUE NECTAR counted separately (any alliance may launch into any cell, and the
  tip table is indexed by the NECTAR count), not one total.

### 2.2 FLOWER (flower.ts)

- Stack model, bottom → top. Capacity by height: fill while the top element's centre is below
  `21.5 + r` (partially inside still scores — Fig 10-5 D/H). Element enters only via the top
  (a flight element within `r` 2.0 of the top centre, z near 21.5, descending; a 3.6 nectar in a
  4.0 hole is a PLACEMENT — Lane B's deposit mechanism calls `releasePollen` with the flower
  target and a low arc).
- **The middle ring is a SORTER** (owner ruling 2026-09-12, from the visuals chat's section
  drawing): its hole is between the 2.8 POLLEN and the 3.6 NECTAR. POLLEN passes it and sits on
  the lower ring (0.43); NECTAR cannot and seats on the middle ring. So a NECTAR is never below
  the scoring floor and ALWAYS scores, and a lone POLLEN at the bottom (0.43-3.23) scores nothing
  at rest. `flowerStackZ` seats a NECTAR at `max(columnTop, BB_FLOWER_MID_Z) + r`; everything
  above rests on it as before, and retrieving a POLLEN from under a ring-seated NECTAR does not
  lower the NECTAR. The ring's HEIGHT stays APPROX: 3.98 is the retrieval opening 3.55 + bottom
  ring 0.43, i.e. the ring's UNDERSIDE, and V1 prints neither its thickness nor whether the
  volume starts at its top (manual-distilled section 11, item 1). The seat rule is what keeps the
  outcomes right whatever that number becomes.
- Retrieval (G418.B): `actOnElement(world, r, 'retrieve')` when a robot's mouth overlaps the
  flower's field-side face — pops the **bottom** element **only if it is POLLEN** (nectar 3.6 >
  3.55 opening) into the hopper. A nectar at the bottom locks the flower.
- Scoring, recomputed every tick: owner = colour of the top-most nectar in the scoring volume;
  owner earns 2 × (elements in volume); bottom-most nectar's alliance earns 5. Fig 10-5 A–H are
  the unit tests.
- **G410**: a nectar entering a flower with > 60 s of TELEOP left ⇒ MAJOR (20) per nectar to the
  opponent; the element still scores (§10.5.2 says so explicitly).
- Render: ring on the wall, owner colour on the ring, and **the stack itself drawn OUTSIDE the
  perimeter beside its flower** — one disc per element in its own colour, in stack order,
  running ALONG that wall with the BOTTOM of the stack nearest the flower. A count badge does
  not say what a driver needs: which colour is at the bottom (the 5-point bonus, and whether a
  NECTAR has locked retrieval) and which is on top (ownership). The badge it replaces was read
  as an unexplained second circle.

### 2.3 GARDEN, LEAVE, PARK

- Garden and LOADING ZONE tape are TAPE, not structure: nothing collides with them, anything
  drives or rolls over them, and they are drawn as tape lines rather than filled bars.
- Garden: every tick, count ground elements whose circle overlaps the strip; 1 each to the
  garden's colour. Displayed live, **banked at match end** like DECODE's pattern points
  (assessed at rest, §10.5.E). Same for cell contents (§10.5.C).
- LEAVE: at end of AUTO, robot not contacting the perimeter (SAT vs the four wall lines with
  `START_TOUCH_TOL` slack) ⇒ 3. PARK: at end of AUTO / end of MATCH, footprint intersects **own**
  LOADING ZONE (assumed own — the zone "belongs to" the alliance; ask in Q&A) ⇒ 5 each.
- RP: SWARM = leave + park points ≥ 16 (both robots LEAVE + both PARK in AUTO is exactly 16);
  POLLINATOR 1/2 at 4 / 7 tips. Ranked/record boards read `total`; RP go to `resultsRows`.

### 2.4 Human player (nectar entry)

Sim-driven, obeys G426/G427 by construction: on each own TIP, one nectar (if `nectarStock > 0`)
appears in the LOADING ZONE against the wall ~1.5 s later (APPROX), placed as a ground artifact
with a small RNG jitter; at ≤ 60 s all remaining stock enters, one per ~1 s. Preloads of a
no-show robot go to the LZ centre. `humanPlayers[a].box` stays inert (it is `ArtifactColor[]`
and DECODE-shaped); the stock lives on `world.biobuzz`.

### 2.5 What the field draws in a MATCH

Owner ruling (2026-09-12): **no tile axis letters or numbers in the game** — A–F / 1–6 are a
gallery aid and stay behind `world.biobuzz.labels`, which only `field-labelled` sets. The same
goes for AprilTag ids: useful in a still that is checked against the manual, noise in a match.
What a driver sees on the field itself is state — the hives' contents as a row of balls, the
flower stacks outside the wall, the tape, the structure — and nothing that is merely a
coordinate. **No letters or digits for element types or counts either** (owner, 2026-09-12): a
ball is drawn as a ball, in its colour, wherever it is.

## 3. Match flow (step.ts)

Shared 30 / 8 / 120 phases are already right. Add: the **1:00 cue** (`events.push('FLOWER
OWNERSHIP UNLOCKED')`, HUD chip flips from "NECTAR LOCKED" to "FLOWERS OPEN"), the end-of-AUTO
assessment hook (LEAVE, AUTO PARK, tips in transition counted as AUTO), the end-of-MATCH
assessment (TELEOP PARK, garden, cell contents, final flower state). `scored: true`,
`startLegality: true`, `initialAct` unchanged.

## 4. Penalties (penalties.ts), in order of value

1. **G410** nectar-in-flower early — MAJOR per nectar. One predicate on the flower entry event.
2. **G402** AUTO interference — DECODE's shape: during AUTO, a robot fully on the opponent's
   side (x sign) in contact with an opponent ⇒ MAJOR on the crosser.
3. **G407** — a WARNING, not a cap (owner ruling 2026-09-12, late): the hopper is bounded by the
   volume law alone, and CONTROL of a 5th element (hopper + herded, the simplified CONTROL test:
   contact + moving with the robot's face) is a VERBAL WARNING — a log line and a HUD chip, no
   points. MAJOR + YELLOW "if STRATEGIC" is referee judgement and is not modelled.
4. **G417** frame ram — bumper contact with a frame bar at closing speed > `APPROX` 30 in/s:
   VERBAL first, MAJOR + YELLOW if REPEATED (example B).
5. **G421** PIN — reuse DECODE's `isPinning` machinery once it is extractable (§6 request 5);
   MAJOR + MAJOR per 3 s.
6. **G408** — the intake refuses opponent nectar (no foul; the element just gets pushed).

Not modelled: G405/G406/G409/G411/G419/G420 (2D sim or referee judgement), and the human rules
(the sim's human player cannot break them).

## 5. Smoke + gallery (scripts/smoke-biobuzz/field.ts, scenesField.ts)

- Geometry: zones point-symmetric; flowers on the ±24 seams; frame bars at ±24.73; every solid
  inside the walls; `evalStart` accepts Fig 11-1's poses and rejects an LZ / wrong-side / off-wall
  pose.
- Staging: 16 + 8 + 16 pollen, 6 + 10 nectar; hopper starts at 4; conservation across all six
  places for 600 ticks under drive.
- Hive: capture only through the up-cell accept volume; N pollen tips; +20 (AUTO if before
  teleop); spill lands on tiles and conserves; up flips; one nectar enters the LZ after a tip;
  all remaining at 60 s.
- Flower: Fig 10-5 A–H table; retrieval pops pollen only; nectar locks; G410 fires at 61 s and
  not at 60.
- Garden partial overlap; LEAVE/PARK assessed at the right instants; RP thresholds; foul values
  5 / 20.
- Scenes: `field-labelled` (new art), `staging`, `hive-tip` (stills across the swing),
  `flower-stacks` (A–H), `park-examples` (Fig 10-7's three), `nectar-entry`.

## 6. Requests for the shared core (integration chat / owner)

1. **Per-artifact radius** in `solveArtifacts` and `robotSolids`/`bbRobotSolids` — an
   `Artifact.r?: number` (default `C.BALL_RADIUS`) or a radius-by-colour map. Without it nectar
   is simulated at pollen size (APPROX, visibly wrong: a 3.6 ball in a 2.8 pile). Interim: run
   nectar at 1.4 and say so on the gallery cell.
2. **`Artifact.state` member for "inside a field element"**: `{ kind: 'element'; el: string;
   slot: number }` — one generic member covers CELL and FLOWER (and any future game's goal), and
   keeps the element in `world.balls` so conservation is one array. Alternative: park them as
   `stock` and index by id from `world.biobuzz` (works, but `stock` means "in a human's hand").
3. **`ArtifactColor`** gains `'yellow' | 'red' | 'blue'` (it is `'purple' | 'green'`), or
   BIOBUZZ maps pollen → `green`, nectar → `purple` + alliance in the state. The renderer and
   the shared hopper HUD read the colour, so a real union is the honest fix.
4. **Foul tariff per game**: `awardFoul(world, offender, severity, rule, pts?)` or a
   `GameSimModule.foulPoints` slot; BIOBUZZ is 5 / 20, DECODE 5 / 15.
5. (Later) extract DECODE's pin detector (`isPinning`, criteria A/B/C, pause/resume) from
   `src/sim/penalties.ts` into a helper both games call, for G421.

None of these block kickoff-day geometry (§1) or staging; 1–3 block the element lifecycle.

## 7. For Lane B (robot) — facts from the manual that change the dials

- Hopper ceiling is the VOLUME LAW, not 4 (owner ruling 2026-09-12, late: G407 is a warning —
  §4.3 item 3). Default 4; preloads fill it. `BB_STORAGE_MAX = 4` goes; `bbStorageMax` stands.
- Expansion **18 × 24 × 29** (R105): one horizontal axis only — `BB_PRISM` 24 stands, but the
  other axis stays 18.
- Two launch targets with real heights: cell opening 53.5–65.6 in (a genuine lob, 12–14 in
  above a 29-in robot's own max), flower top 21.5 in with a 4.0 hole (a placement).
- Retrieval from the flower bottom is a new action (`'retrieve'` through `actOnElement`) — a
  mouth facing the wall, 3.55 in tall.
- Nectar is a second element the intake must handle (bigger) and must **refuse when it is the
  opponent's** (G408).
- **Shooting side** (owner, 2026-09-12): a CELL is open at its OUTER end only, so the field
  accepts a lob only when it arrives travelling toward the pivot (§2.1). A robot on the pivot
  side of the up cell cannot score into it from there. `ScoreTarget.mouth` (unit vector out of
  the opening) is there for the launcher to refuse, warn, or aim around; the gate lives in the
  field either way.

## 8. Open questions (for the Q&A on 09-28, or a real field on 09-14)

- Tip load with an EMPTY cell (0 NECTAR). Every other row is measured — see reference §4.1.
- PARK requires the **OWN** LOADING ZONE — SETTLED (owner, 2026-09-12), matching Fig 10-7.
- Flower stand-off from the wall and exact footprint (CAD ref 10-4 when the field CAD is out).
- Exact tape placement of the LZ (which side of the seam) — ±0.5 in, cosmetic.
- ~~Whether a pollen launched into the OPPONENT's up-cell is ever penalised~~ SETTLED (owner,
  2026-09-12): not penalised, and the sim does not let it enter (§2.1).
- G410 binds NECTAR only — SETTLED (owner, 2026-09-12): POLLEN may enter a FLOWER at any time and
  earns nothing until an owner exists.
