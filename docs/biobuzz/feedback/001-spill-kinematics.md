# 001 — what a TIPPED cell's contents do: measured against the owner's landing lines

Written by Lane A (the field), 2026-09-12, against `alpha` `e5d866d` plus this lane's working
tree. This file started as a question — *where do a tipped HIVE's contents end up?* — and the
owner answered it from his own drawn landing lines before it was ever filed. So it is now the
other thing: the TARGET beside what the sim actually does, with the gap named.

**The answer, from the visuals chat's field-v4 page (field-plan §2.2):** the pile leaves at
**50–88 in/s** in a **±55° fan** about the outboard axis and comes to rest **57–107 in from the
PIVOT, median ~70**, wall to wall, with bounces.

Two constants moved to hit it, one each, both flagged `APPROX` in `hive.ts`:

| | before | now |
|---|---|---|
| `BB_SPILL_SPEED` | `[40, 60]` in/s | **`[50, 88]`** in/s |
| the across term | `BB_SPILL_LATERAL` ±12 in/s, a straight-outboard throw with jitter | **`BB_SPILL_FAN` ±55°**, a rotation of the whole velocity |

`BB_SPILL_LATERAL` is gone. A fan is not a bigger jitter: the old model threw everything the
same way and nudged it sideways, so the spread grew along one axis only. Rotating the velocity
is what the owner's drawing shows and it is what puts elements across the field rather than in
a lane. Everything else — `BB_TIP_SWING_S` 4.0, release at half the swing, the shared
`BALL_ROLL_FRICTION` 28 in/s² — is untouched, and **no shared physics constant was changed.**

Cell to look at: **`hive-tip@240`** and the new **`hive-tip@480`** (the scene grew a fourth
still for exactly this reason — see below).

---

## 1. Measured vs target

Two probes, because one seed is a picture and sixty is a distribution.

**A. The gallery scene, `hive-tip`, seed-for-seed with what is on screen.** Red's staged cell
holds 3 NECTAR + 3 POLLEN (`BB_TIP_POLLEN[3]` is 3), pivot at (−12.75, 0), cell centre
y = −13.37.

| t | loose | spread x | spread y | from the PIVOT | median | nearest skin to perimeter | moving | fastest |
|---|---|---|---|---|---|---|---|---|
| 2.03 s (release) | 6 | — | — | — | — | — | 6 | up to 88 in/s |
| 2.50 s | 6 | 59.3" | 17.9" | 29.6–54.5" | 48.3" | 23.31" | 6 | 73.9 |
| 3.00 s | 6 | 99.7" | 31.6" | 39.2–87.6" | 70.1" | 0.42" | 6 | 59.9 |
| **4.00 s (the TIP settles)** | 6 | **140.5"** | 29.2" | **41.9–106.7"** | 81.4" | 0.27" | **2** | 8.8 |
| **8.00 s (at rest)** | 6 | **140.5"** | **29.4"** | **41.9–106.7"** | **81.6"** | 0.08" | 0 | 0.0 |

| id | kind | left the tray at | rest, from the pivot | travel |
|---|---|---|---|---|
| 900 | NECTAR | — | 75.0" | — |
| 901 | NECTAR | — | 88.3" | — |
| 902 | NECTAR | — | 106.7" | — |
| 903 | POLLEN | — | 74.1" | — |
| 904 | POLLEN | — | **41.9"** | 28.3" |
| 905 | POLLEN | — | 88.3" | — |

**B. Sixty tips, 360 spilled elements**, same load, seeds 1–60:

| | target | measured |
|---|---|---|
| rest distance from the pivot | 57–107 in | **24.5–108.8 in** |
| median | ~70 in | **71.0 in** |
| p10 / p90 | — | 55.7 / 83.2 in |
| inside the 57–107 band | (all of it) | **88%** |
| short of 57 | — | 11% |
| past 107 | — | 1% |
| finished against the perimeter | "wall to wall, with bounces" | 26% of elements |

**The median is 71 against a target of ~70 and the band holds 88% of the pile.** The ends are
where it differs, and the two ends differ for different reasons.

## 2. The three numbers the addendum asked for

- **SPREAD.** 140.5 in across × 29.4 in along, at rest, on the scene seed. That is wall to
  wall: the field is 144 in wide. Under the old constants it was 31.5 × 15.0.
- **FARTHEST.** 106.7 in from the pivot on the scene seed; 108.8 in over sixty tips. The target
  tops out at 107, so the far end lands on it almost exactly.
- **REST TIME.** Release at **2.033 s**, everything stopped at **4.18 s** — 2.15 s after the
  release and **0.18 s AFTER the swing settles at 4.0 s.** Under the old constants the spill
  finished 0.12 s BEFORE the tip did. This is why `hive-tip` now takes a fourth still: at
  t = 4 s two of the six are still rolling and the frame shows the throw MID-FLIGHT, which says
  nothing about where a spill ends up — the thing a driver has to plan around. `@480` (8 s) is
  the frame to read the scatter off.

## 3. Where the short ones come from — and it is the fan, not a bug

Element 904 rests **41.9 in** from the pivot, well under the 57 floor, having travelled only
28.3 in. Its speed was in band; its ANGLE was near the edge of the fan, so it was thrown ACROSS
the field rather than out into it, and a chord is shorter than a radius. Eleven per cent of the
sixty-tip sample is short for the same reason.

That is a structural consequence of the shape of the model, not of the numbers in it: a fan
that is wide enough to reach wall to wall is wide enough to throw some of the pile sideways.
`BB_SPILL_SPEED` and `BB_SPILL_FAN` are one constant each by instruction, so there is no knob
here that separates "far" from "wide" — they are the same knob. **If the real field never puts
an element closer than 57 in, the model needs a second term** (a floor on the along-axis
component, or a speed that rises with the fan angle), and that is a change worth making
deliberately rather than by widening the speed range until the short ones disappear.

## 4. Two collision effects worth knowing about

**(a) The six elements now collide with each other on the way out, and the LIVE smoke check had
to be re-scoped for it.** Six elements start in one 20 × 10.43 in cell mouth, OVERLAPPING — a
real tray dumps a pile, not a rank — and with a fan they diverge INTO each other. Measured, one
pair of the six starts **3.44 in apart on 3.60 in of diameter**. The shared solve separates them
on the release tick, so two of the six read 41.0 and 47.0 in/s against a 50 floor. Nothing is
wrong: that is what a pile does. The exact band is still pinned by the PURE `spillPoses` check;
the live check now asserts what the live path can honestly assert (all outboard, none faster
than the draw, none near rest, the fastest at or above the floor, at least half still in band).
Under the old straight-outboard model nothing ever collided, which is the only reason a hard
per-element band ever passed there.

**(b) ⚠️ A NECTAR comes to rest up to 0.40 in PAST THE WALL PLANE, and that is a SHARED physics
item, not a BIOBUZZ one.** 35 of the 360 spilled elements finish with their skin outside the
perimeter. The cause is the one already on the standing list: the shared solve runs **one radius
per call** and `clampPollenToWalls` clamps at `BB_POLLEN_R` (1.4), so a NECTAR (1.8) overhangs
by up to the 0.4 in difference. Nothing in `src/games/biobuzz/` can fix it —
per-artifact radius is field-plan §6 request 1 and
`docs/biobuzz/feedback/000-solver-observations.md` carries the same finding from the other
direction. **It got visible here** because the old spill never reached a wall and this one puts
a quarter of the pile against one. Cells: `hive-tip@480`, the elements on the audience wall.

## 5. What was NOT changed

- No shared constant. `BALL_ROLL_FRICTION` is still 28 in/s² and the stopping distance is still
  exactly `v² / 56` — 50 in/s rolls 44.6 in, 88 in/s rolls 138.3 in, which is the arithmetic the
  new range was picked against.
- The 25-inch drop is still not simulated, and the reasoning in `play.ts` is unchanged: an
  element is a GROUND element on the tick it leaves the tray, carrying its whole speed as roll.
  With a throw this size that choice now matters more, not less — the horizontal distance a real
  flight would supply is all being spent as roll instead. If the owner's landing lines were
  measured from a real tip, the model is absorbing the flight into the roll and arriving at the
  right place by a different route, which is fine for where things END UP and wrong for what the
  field looks like for the ~0.4 s an element would be in the air.

## 6. Open, for the owner

1. **The short tail.** Is 42 in from the pivot a thing that happens on a real field? If not,
   the fan needs a companion term (§3) and it is a two-constant change, not a one-constant one.
2. **The overhang.** §4(b) is a shared-solver request, already filed twice. This is the third
   sighting and the first one that is visible in a screenshot.
