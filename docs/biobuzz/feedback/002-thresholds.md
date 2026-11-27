# 002 — two thresholds the sim guesses, and exactly what to measure on 09-14

Written by Lane A (the field), 2026-09-12, against `alpha` `a68401f` plus this lane's working
tree. It is a REQUEST, not a report: everything below is a number the sim has to have, does not
have, and has picked a value for. **V1 cannot settle either of them** — one is arithmetic the
manual does not print and the other was never published at all.

Two numbers, and a third that FALLS OUT of the first:

| | what it decides | today | provenance |
|---|---|---|---|
| `BB_FLOWER_MID_Z` | where the scoring volume starts, and where a NECTAR seats | **3.98** | `APPROX`, derived — see §1 |
| `BB_TIP_POLLEN[0]` | whether an EMPTY cell can tip at all | **8** | **SETTLED 2026-09-13** — Event Field Setup Guide §12.3; see §2 |
| capacity | how many fit: **POLLEN 8 · NECTAR 5** | derived | falls out of `BB_FLOWER_MID_Z` — see §3 |

Cells to look at: **`flower-stack@0`** (all four column states in one frame — the shaded band IS
`BB_FLOWER_MID_Z`) and **`hive-tip@0`** (the tip table's staged row).

---

## 1. THE MIDDLE RING — its height, its thickness, and its hole

**What the sim does with it.** `BB_FLOWER_MID_Z` is the seat: a POLLEN (2.8) passes the middle
ring and falls to the lower one, a NECTAR (3.6) cannot and rests ON it (`flowerStackZ`, the
`max(columnTop, BB_FLOWER_MID_Z)`). It is also the FLOOR of the scoring volume,
`BB_FLOWER_VOL_Z = [BB_FLOWER_MID_Z, 21.5]`, so it decides three outcomes at once:

- a NECTAR **always** scores, because it can never sit below the floor;
- a lone POLLEN on the lower ring (0.43 → 3.23) scores **nothing**;
- the four staged POLLEN read **3 in volume and 0 points** at t=0.

**Why V1 cannot answer it.** 3.98 is `3.55 + 0.43` — the retrieval opening's height plus the
**bottom** ring's thickness (Fig 9-12 labels 0.43 as "Thickness of Bottom Ring"). That is the
top of the retrieval opening, which is not the same object as the middle ring, and the manual
prints **no middle-ring height and no middle-ring hole anywhere** (manual-distilled §11 item 1).
The number is a plausible stand-in for a dimension the manual does not contain.

**Measure, on the real FLOWER:**

1. **The middle ring's TOP face, above the tiles.** A tape from the floor to the surface a
   NECTAR would come to rest on. This is the number `BB_FLOWER_MID_Z` wants — not the ring's
   underside, and not the top of the retrieval opening.
2. **The ring's own thickness.** If the top face and the underside differ by more than about a
   tenth, say both: today's constant is named for the underside in its own comment and used as
   the top, and that is only harmless while the ring is thin.
3. **The hole diameter.** It must fall **between 2.8 and 3.6** or the sorter ruling is wrong
   about the FLOWER, and that would be a larger finding than the number. Under 2.8 and nothing
   passes; over 3.6 and nothing seats.
4. **Does the scoring volume start at the ring's TOP or its BOTTOM?** §10.5.2 says "between the
   top ring and the middle ring" and does not say which face. With a thin ring it does not
   matter; with a thick one it is a POLLEN either side of the line.

**What changes if it moves.** One constant, `BB_FLOWER_MID_Z` in `src/games/biobuzz/flower.ts`,
and its `APPROX` flag comes off. Everything else re-derives: `flowerStackZ`, `flowerScore`,
`flowerCapacity`, the staged flower's 3-in-volume reading, and the shaded band in the section
render all read it. **The one thing that does NOT re-derive is the two capacity literals** — see
§3 — which is deliberate, and is one label edit.

---

## 2. THE TIP TABLE'S EMPTY ROW

> **SETTLED 2026-09-13 — no field measurement needed for row 0.** The 2026-2027 **Event Field
> Setup Guide**, §12 Hive Calibration (V1.0 pp26–27), requires every HIVE to be ballast-calibrated
> to tip at **[8] POLLEN + [0] NECTAR** and **[3] POLLEN + [3] NECTAR**. Its §12.3 acceptance
> table: with 0 NECTAR, a tossed-in 7th POLLEN must NOT tip and a tossed-in 8th MUST; with 3
> NECTAR, a tossed-in 2nd must NOT tip and a tossed-in 3rd MUST. So rows 0 and 3 are official and
> match the sim. Rows 1, 2, 4, 5 are not in the guide and are still the owner's single measurement
> — items 2 and 3 below (a second reading, and whether order matters) still stand. Note a field
> is calibrated to these two rows, so an event HIVE may not reproduce the owner's other rows.

**What the sim does with it.** `BB_TIP_POLLEN` is indexed by the NECTAR in the up-CELL and gives
the POLLEN also needed to tip it; a cell tips when `pollen >= BB_TIP_POLLEN[min(nectar, 5)]`.
Measured (owner, 2026-09-12) and **not in the manual at all**:

| NECTAR | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| POLLEN needed | **8** ⚠️ | 7 | 6 | 3 | 1 | 0 |

**Why V1 cannot answer it.** Only index 0 is a guess: an EMPTY cell was never put on the scale,
and 8 extrapolates the 7/6 trend at the top. Nothing interpolates this table — no single linear
weighting fits it (1n+7p and 2n+6p make a NECTAR worth one POLLEN; 3n+3p contradicts that
outright), so a see-saw here is torque and packing, and a missing row cannot be computed from
its neighbours.

**Measure, on the real HIVE, ideally all six rows again:**

1. **NECTAR 0 — the empty cell, POLLEN only.** The row that is a guess. Load POLLEN one at a
   time until it goes over. If it will not tip on POLLEN alone at any count the cell holds,
   that is an answer too — say "does not tip", and the row becomes unreachable rather than 8.
2. **NECTAR 1–5, to confirm 7 / 6 / 3 / 1 / 0.** The table was measured once. It is the whole
   rule for whether AUTO can tip at all (staged is 3 NECTAR, so the first tip costs 3 POLLEN),
   and a second reading is cheap while the field is in front of you.
3. **Whether ORDER matters** — three NECTAR loaded first versus three loaded last, at the same
   count. The sim's table cannot express it, so if it matters we need to know before the table
   is trusted rather than after.

**What changes if it moves.** One array in `src/games/biobuzz/config.ts`, and the literal in the
smoke lane's `hive: BB_TIP_POLLEN is the measured table [8,7,6,3,1,0]` check — two edits, on
purpose (see §3).

---

## 3. THE CAPACITIES ARE PINNED AS LITERALS, AND THAT IS THE POINT

`flowerCapacity` DERIVES capacity by filling the column one element at a time through
`flowerFits`, so **POLLEN 8** and **NECTAR 5** are consequences of `BB_FLOWER_MID_Z`, not
constants. The smoke lane nevertheless asserts them as bare literals:

```
'flower: capacity by height — 8 POLLEN, and only 5 NECTAR because the ring seats the first'
capP === 8 && capN === 5
```

That is deliberate, and it is this document's interface to the code. A check that asserted
`flowerCapacity('pollen') === flowerCapacity('pollen')` would pass forever and tell nobody the
column's capacity had silently changed; a check pinned to 8 and 5 FAILS the moment
`BB_FLOWER_MID_Z` is re-measured, and the failure names the two numbers a human has to look at.
So a re-measure is exactly **one config edit and one label edit**, in that order, and the label
edit is the moment somebody re-reads this file.

The same rule is why `BB_TIP_POLLEN` is pinned to `[8,7,6,3,1,0]` rather than compared against
itself. Both literals exist to be broken by a measurement.

**Do not "fix" either check by deriving its expected value from the constant it is testing.**

### The arithmetic, so a re-measure can be checked without running anything

At `BB_FLOWER_MID_Z` 3.98, lower ring 0.43, top ring 21.5, POLLEN r 1.4, NECTAR r 1.8, and
`flowerFits` admitting an element while the column's top is still **below** the top ring:

- **POLLEN** stack from the floor in steps of 2.8 — tops at 3.23, 6.03, 8.83, 11.63, 14.43,
  17.23, 20.03, **22.83**. The eighth is admitted at a top of 20.03 and a ninth is not, so
  **8**, and the eighth stands 1.33 proud of the ring (Fig 10-5 D/H — an element held on the
  backstop still counts, which is why the section's panel is drawn tall enough to show it).
- **NECTAR** seat the first at 3.98 and step 3.6 — tops at 7.58, 11.18, 14.78, 18.38, **21.98**.
  Five, and a sixth is refused. The 3.55 in of clearance the ring costs the column is exactly
  one NECTAR: the old arithmetic, stacking from the floor, said six.

If the measured ring lands **below ~3.6** the column gets its sixth NECTAR back; if it lands
**above ~5.1** it loses a POLLEN as well. Both are one config edit away.

---

## What a useful reply looks like

Numbers and units, no prose needed:

```
mid ring top:      __ in above tiles      (thickness __ , hole __ in dia)
volume starts at:  top / bottom of that ring
tip, 0 nectar:     __ pollen              (or: does not tip)
tip, 1..5 nectar:  __ __ __ __ __         (confirming 7 6 3 1 0)
order matters:     yes / no
pollen that fit:   __                     (derived 8)
nectar that fit:   __                     (derived 5)
```

Anything measured here comes off `APPROX` and stops being this lane's guess.

---

# APPENDIX — the rest of the `APPROX` list

**This is an appendix to the two asks above, not a replacement for them.** §1 and §2 are the two
numbers worth a trip; everything below is the standing list of every other constant in the game
that is a guess, transcribed so somebody on a field can work from a document instead of from a
grep. If there is only time for §1 and §2, do those.

`config.ts` says at its lines 18–20 and 103–104 that `grep APPROX src/games/biobuzz/config.ts`
IS the 09-14 tape-measure list. Counted: **34 live markers over 43 constants**, of which **25
markers / 33 constants** are in `config.ts` and the rest are not.

⚠️ **THE CONFIG-ONLY GREP MISSES TEN CONSTANTS, AND TWO OF THEM ARE §1 ABOVE.** The convention is
written as if `config.ts` held every guess, and it does not. Outside it:

| file | constants carrying a live `APPROX` |
|---|---|
| `flower.ts` | `BB_FLOWER_FLOOR_Z`, `BB_FLOWER_MID_Z`, `BB_FLOWER_VOL_Z`, `BB_FLOWER_ENTRY_MARGIN` |
| `hive.ts` | `BB_HIVE_ACCEPT_MARGIN`, `BB_SPILL_SPEED`, `BB_SPILL_FAN` |
| `penalties.ts` | `BB_FRAME_RAM_SPEED` |
| `play.ts` | `NECTAR_ENTRY_JITTER` (module-local) |
| `elements.ts` | `CELL_ACCEPT_R` (module-local) |

`BB_FLOWER_MID_Z` and `BB_FLOWER_VOL_Z` — the subject of §1, and two of the four the field
handoff calls load-bearing for a scoring outcome — live in `flower.ts`, so the documented grep
returns neither. The honest grep is `grep -rn APPROX src/games/biobuzz/`. Either widen the
sentence in `config.ts` or move the ten constants into it; today the convention promises a list
it does not produce.

## A. THE FOUR TO MEASURE FIRST

A tape measure settles each of these, and each one changes whether something SCORES.

| constant(s) | today | derived from (the marker's own words) | what it decides |
|---|---|---|---|
| `BB_FLOWER_MID_Z` · `BB_FLOWER_VOL_Z` (`flower.ts`) | **3.98** · **[3.98, 21.5]** | "3.98 is the retrieval opening 3.55 plus the lower ring 0.43 … it is the RING'S UNDERSIDE" | the scoring floor, the NECTAR seat, both capacities. **§1 above is this row.** |
| `BB_FLOWER_FLOOR_Z` (`flower.ts`) | **0.43** in | "Fig 9-12: lower ring 0.43 tall on the tiles … APPROX — Fig 9-12 pixel read" | the base of the POLLEN stack. A lone bottom POLLEN tops at 3.23 and scores nothing because of this number and §1's TOGETHER — move either and that outcome flips. Same trip, same column. |
| `BB_GARDEN` | red x[−72, −49] y[−72, −70] — a **2 in** strip | "Fig 9-2/9-3 — strip depth off the drawing" | GARDEN points. `bbInGarden` scores a ground element within one radius of this rect, and the strip is 2 in deep against a 2.8-in POLLEN, so the drawn depth is most of the test. Measure the strip depth and where its outside edge sits. |
| `BB_LZ` | red x[−72, −61] y[24, 48] | "Fig 9-2/9-3 — ±0.5 in on the tape edge" | G426/G427 foul points, where a human-entered NECTAR lands, and whether start anchor 1 is legal. Foul points are score. |

`BB_HIVE_X` (**12.75**, "APPROX: Fig 9-2 — that the PAIR is centred on the field") is the fifth
if the tape is still out: one pull confirms the 25.5 in pivot-to-pivot pitch sits centred on
x = 0. Fifth and not fourth because no RULE reads it — it moves every launcher solution and the
G417 frame geometry, but nothing scores or fails to score on it directly.

## B. LOAD-BEARING, BUT A TAPE MEASURE WILL NOT SETTLE THEM

These change a scoring outcome. None of them is a length. Each needs a loaded HIVE, a test shot,
or an owner ruling.

| constant(s) | today | derived from (the marker's own words) | what it decides |
|---|---|---|---|
| `BB_SPILL_SPEED` · `BB_SPILL_FAN` (`hive.ts`) | **[35, 62]** in/s · **±18°** | "BOTH STILL APPROX, and MORE approx than the pair they replace … a ruling about FEEL that moves the landing distance with it" | where a tipped CELL's contents land, and so who can collect them. Tip a loaded cell and mark the landing lines; `001-spill-kinematics.md` has the numbers either side of the change. |
| `BB_HIVE_ACCEPT_MARGIN` (`hive.ts`) · `CELL_ACCEPT_R` (`elements.ts`) | **2.0** in · **8** in | "the opening is 14 in tall (§9.6.2) and a lob arrives from above" · "the opening is a 20 x 10.43 rect … 8 is the inscribed-ish compromise" | whether a launched element ENTERS the up-CELL at all, so whether a HIVE ever tips. `CELL_ACCEPT_R` is a disc standing in for a rect — replace it with the rect when `ScoreTarget` grows one, rather than re-tuning the radius. |
| `BB_FLOWER_ENTRY_MARGIN` (`flower.ts`) | **3.0** in | "the backstop is 1.25 in tall, and a lob arrives from above" | whether a descending element counts as entering a FLOWER. |
| `BB_PLACE_TOL` | **2.0** in | "the slop of a real tube lining up on a 4.0-in ring; a placement should not need the pixel" | whether a Box Tube placement succeeds. This is the real guess in the placement geometry — see `BB_PLACE_REACH` below. |
| `BB_DUMP_MIN_DIST` · `BB_DUMP_MAX_DIST` · `BB_DUMP_APEX_ABOVE` | **1** · **36** · **4** in | "A DUMPER'S RANGE (owner, 2026-09-13) … APPROX all three" | whether a dumper reaches the cell it is aimed at. An owner ruling about feel, re-decided once already; not a field measurement. |
| `BB_FRAME_RAM_SPEED` (`penalties.ts`) | **30** in/s | "the manual says 'don't meddle with the HIVE' and prints no number, so this is the field-plan's §4.4 guess" | a G417 MAJOR. Its own comment already puts it on the 09-14 list. It needs a referee's judgement, not a tape. |
| `BB_START_POSES` | (34, 61.5) · (46, −61.5) | "APPROX, AND IN ONE PLACE: THE FRONTAGE … the ±72 walls, the x = 0 seam and the FLOWER centres are measured and are not APPROX" | start legality only, and it is derived from `BB_LZ` and `BB_FLOWER_FOOT`. **Measuring row A4 settles this one too** — nothing separate to do on the field. |

## C. FEEL — launcher, robot and timing tuning

Nothing here changes whether something scores. These change how a robot feels to drive and how
fast it cycles, and a tape measure has nothing to say about any of them. Listed so the count is
honest, not because they are field work.

| constant(s) | today | derived from (the marker's own words) |
|---|---|---|
| `BB_TURRET_SLEW` | 7 rad/s | "CR's tuned value, and turret hardware has not changed" |
| `BB_TURRET_PITCH_SLEW` | 1.6 rad/s | "APPROX, and deliberately slower than the yaw slew" |
| `BB_TURRET_PITCH_MIN` · `_MAX` | 0 · 80° (1.396 rad) | "the pitch envelope a turret can actually reach … APPROX both ends" |
| `BB_AIM_TOL` · `BB_AIM_GAIN` | 0.14 rad · 4.5 | "Only turretless archetypes use these: the fire button steers the chassis. APPROX." |
| `BB_FIRE_INTERVAL` | 1/13 s | "the long-run rate averages exactly 13/s instead of tick-quantizing to 12 or 15. APPROX." |
| `BB_FIRE_BURST_MAX` | 6 | "this only bounds a pathological catch-up. APPROX." |
| `BB_LAUNCH_SPEED_MAX` | 260 in/s | "APPROX, like every launcher number here — see the risks in `docs/biobuzz/plan-mechanisms.md`" |
| `BB_LAUNCH_SPEED_DEFAULT` | 175 in/s | "the old drum's tuned speed, kept as a neutral number" |
| `BB_LAUNCH_LINE_FRAC` | 0.92 | "Slightly under 1 so the outermost POLLEN of a burst is not born exactly on the frame line. APPROX." |
| `BB_LAUNCH_PLATE_GAP` · `_OVERHANG` | 3.1 · 1.2 in | "GAP is `BB_POLLEN_R * 2` plus a working clearance … APPROX with the element" |
| `BB_DUMP_RELOAD_S` | 0.75 s | "a tray swinging back down. It is what stops a held fire button re-dumping on every capture" |
| `BB_FLOWER_RETRIEVE_S` | 0.35 s | "one element worked out from under the stack through a 3.55-in hole, not a roller sweeping loose elements off the tiles" |
| `BB_FLOWER_RETRIEVE_PAD` | 1.0 in | "the contact slop of a compliant roller" |
| `BB_LIFT_MASS_FLOOR` | 2.0 lb | "extra lb on the chassis mass FLOOR for carrying a Box Tube. APPROX." |
| `BB_POLLEN_WALL_REST` | 0.35 | "a guess about a 3-in foam ball, and only a picture judges it (`launch-wall-bounce` in the gallery)" — FLIGHT only |
| `BB_MIN_LENGTH` · `BB_MAX_LENGTH` · `BB_MIN_WIDTH` · `BB_MAX_WIDTH` | **10 · 17 · 10 · 17 in** (the floors were 13.5 and 14.5 when this was written) | "The FLOORS are DECODE's per-intake floors, because there is no BIOBUZZ rule to argue a different one from … All four are APPROX." Quoted as written on 2026-09-12; since `a8c4f0f2` (2026-10-10) the chassis floor is 10 x 10 and the shared intake and swerve floors no longer apply to BIOBUZZ. |
| `BB_STORE_AREA_PER_BALL` | 12 in² | "a one-layer packing model, ~12 in² of hopper floor per 3-in POLLEN" — inert while `BB_STORAGE_MAX` 4 binds first |
| `NECTAR_ENTRY_JITTER` (`play.ts`) | 4.0 in | "A human putting five elements on the same tile does not stack them. APPROX." |
| `BB_POLLEN_SIM` | 60 | "60 is a placeholder chosen to LOOK like a field worth driving on" — **and nothing reads it; see below** |

Two more markers sit on the StarterBot preset in `presets.ts` — `length` 15 / `width` 16 ("kit
side rails are ~15 in; no kit publishes a width") and `flywheelInertia` 0.5 ("a direct-drive
flywheel"). They describe a robot card, not the field, and no field measurement moves them.

## ALREADY CLOSED — DO NOT RE-MEASURE

Three markers in `config.ts` say `APPROX` only in the past tense. All three are now measured off
the owner's CAD and the field guide (2026-09-12 / 09-13), and all three are excluded from every
count above:

- `BB_FLOWER_D` **2.54** in — was `APPROX` 3.0 off Fig 9-12.
- `BB_FLOWER_FOOT` **6 × 4.9** in — was an `APPROX` 2.6-in disc; it is a rectangle.
- `BB_TIP_POLLEN[0]` **8** — was an extrapolation of the 7/6 trend; the Event Field Setup Guide
  §12.3 confirms it (§2 above). The other five rows of that table are still the owner's single
  measurement, and §2 still asks for a second reading of them.

## WHERE THE MARKER AND THE CODE DISAGREE

Four, found while transcribing. None is urgent; each one would mislead somebody working from the
grep alone.

1. **`BB_POLLEN_SIM` is dead and still carries a live marker.** Its comment says "how many POLLEN
   the shell scatters", but nothing in `src/` reads it — the only other mention in the repo is an
   unused import in `scripts/smoke-biobuzz/field.ts`. Staging is `BB_POLLEN_COUNT` 40, a manual
   count. It is a shell leftover sitting on the tape-measure list, and it cannot be measured
   because there is no such thing on a real field.
2. **`BB_PLACE_REACH` is marked `APPROX` but is now fully derived from two MEASURED numbers.**
   `BB_FLOWER_FOOT.deep − BB_FLOWER_D` = 4.9 − 2.54 = 2.36, and both of those came off the
   owner's CAD on 2026-09-12 (see ALREADY CLOSED). The guess in that pair is `BB_PLACE_TOL`
   alone. The marker should come off the reach and stay on the tolerance.
3. **`BB_LAUNCH_PLATE_GAP` is only a third `APPROX`.** It is `BB_POLLEN_R * 2 + 0.3` = 3.1, and
   `BB_POLLEN_R` 1.4 is a printed manual dimension (§9.8). Only the 0.3 in of working clearance
   is a guess.
4. **`BB_TURRET_PITCH_MIN` is 0, and 0 is a definition.** The marker says "APPROX both ends"; the
   lower end is "level", which is exact. `BB_TURRET_PITCH_MAX` 80° is the guess.
