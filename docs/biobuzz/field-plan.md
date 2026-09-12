# BIOBUZZ field plan (Lane A) — PROPOSAL, 2026-09-12

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
BB_HIVE_X = ±12.75 (pivot), axis along y                     // Fig 9-10 "center to center 25.5"
BB_HIVE_CELL_DY = 13.4  (APPROX: 15.4·cos30)                 // Fig 9-9/9-10
BB_HIVE_OPEN_Z = [53.5, 65.6], BB_HIVE_BOTTOM_Z = 25.5       // Fig 9-10
BB_CELL_OPEN = 20 × 12 (accept footprint, APPROX from 20×14×12)  // Fig 9-11
BB_FRAME legs x = ±24.73, y ±19.5, bar ~1.5 in (APPROX)      // Fig 9-8
BB_FLOWERS: (-72+d,-24) (-24,72-d) (72-d,24) (24,-72+d), d = 3.0 APPROX  // Fig 9-2/9-4 pixels
BB_FLOWER_TOP_Z = 21.5, BB_FLOWER_OPEN_R = 2.0, BB_FLOWER_VOL_Z = [3.98, 21.5] APPROX // Fig 9-12
BB_TIP_LOAD = ? pollen-equivalents, BB_NECTAR_MASS = 1.65 pollen APPROX   // NOT PUBLISHED
BB_FLOWER_UNLOCK_S = 60                                       // G410
PTS: leave 3, park 5/5, tip 20, cell 2, bottom-nectar 5, owned 2, garden 1; RP 16 / 4 / 7
```

Colliders: four walls (kept) + two frame base bars + four flower footprints (circles r≈2.6).
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
rect 20 × 12 → `r` 8 APPROX), the opponent's up-CELL (legal, pointless — `alliance` set so a
launcher can skip it), and the four FLOWER tops (z 21.5, r 2.0). `releasePollen(…, target)`
solves the arc for the target's z (the existing `Vec3` + `BB_LAUNCH_Z0`).

### 2.1 HIVE (hive.ts)

- **Capture**: a flight element whose (x, y) is inside the up-cell's accept rect while its z is
  in [53.5, 65.6 + margin] and descending → `contents.push(id)`, state `element`. Anything else
  hitting the cell box (outside faces, the down cell) bounces off the structure and falls
  (G417.H says missing is not a foul).
- **Tip**: when `Σ mass(contents) ≥ BB_TIP_LOAD`, start `tipping` (APPROX 0.8 s swing). At the
  end of the swing: `up` flips, `tips++`, +20 to the hive's alliance (AUTO if `phase !== teleop`
  yet — §10.5.B), the old contents **spill**: re-spawned as ground artifacts under the now-down
  cell (x ≈ pivot, y ≈ ∓(13.4 + 6), z from 25.5, world-RNG scatter, landing through the shared
  flight step), `nectarDue[a]++`. Contents of the new up-cell: empty.
- **Threshold is the one number physics decides and the manual does not print.** The staged
  hive holds 3 nectar and is stable, so `BB_TIP_LOAD > 3 × nectar`. Ship a guess (e.g. 6 pollen-
  equivalents) flagged `APPROX`, and **measure on 09-14** when the set arrives: weigh a pollen and
  a nectar, count pollen to tip a staged cell.
- Render: two hives as top-down cell outlines; the up-cell drawn bright with its content count
  (yellow/red/blue pips), the down-cell dimmed; a short swing animation on `tipping`.

### 2.2 FLOWER (flower.ts)

- Stack model, bottom → top. Capacity by height: fill while the top element's centre is below
  `21.5 + r` (partially inside still scores — Fig 10-5 D/H). Element enters only via the top
  (a flight element within `r` 2.0 of the top centre, z near 21.5, descending; a 3.6 nectar in a
  4.0 hole is a PLACEMENT — Lane B's deposit mechanism calls `releasePollen` with the flower
  target and a low arc).
- Retrieval (G418.B): `actOnElement(world, r, 'retrieve')` when a robot's mouth overlaps the
  flower's field-side face — pops the **bottom** element **only if it is POLLEN** (nectar 3.6 >
  3.55 opening) into the hopper. A nectar at the bottom locks the flower.
- Scoring, recomputed every tick: owner = colour of the top-most nectar in the scoring volume;
  owner earns 2 × (elements in volume); bottom-most nectar's alliance earns 5. Fig 10-5 A–H are
  the unit tests.
- **G410**: a nectar entering a flower with > 60 s of TELEOP left ⇒ MAJOR (20) per nectar to the
  opponent; the element still scores (§10.5.2 says so explicitly).
- Render: ring on the wall + a stacked-pips badge; owner colour on the ring.

### 2.3 GARDEN, LEAVE, PARK

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
3. **G407** — structural cap 4 in the hopper; herding of ground elements counted with a
   simplified CONTROL test (contact + moving with the robot's face); VERBAL (log line) at 5,
   MAJOR + YELLOW at 6+ (the manual's own "likely STRATEGIC" example A).
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

- Hopper ceiling **4** (G407); default 4; preloads fill it. `BB_STORAGE_*` and the storage-area
  law shrink to a 1–4 dial or disappear.
- Expansion **18 × 24 × 29** (R105): one horizontal axis only — `BB_PRISM` 24 stands, but the
  other axis stays 18.
- Two launch targets with real heights: cell opening 53.5–65.6 in (a genuine lob, 12–14 in
  above a 29-in robot's own max), flower top 21.5 in with a 4.0 hole (a placement).
- Retrieval from the flower bottom is a new action (`'retrieve'` through `actOnElement`) — a
  mouth facing the wall, 3.55 in tall.
- Nectar is a second element the intake must handle (bigger) and must **refuse when it is the
  opponent's** (G408).

## 8. Open questions (for the Q&A on 09-28, or a real field on 09-14)

- Tip load (pollen count / element masses). The single biggest unknown; everything else is
  geometry.
- Does PARK require the **own** LOADING ZONE? (Assumed yes.)
- Flower stand-off from the wall and exact footprint (CAD ref 10-4 when the field CAD is out).
- Exact tape placement of the LZ (which side of the seam) — ±0.5 in, cosmetic.
- Whether a pollen launched into the OPPONENT's up-cell is ever penalised (text: no).
