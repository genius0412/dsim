# 002 — two thresholds the sim guesses, and exactly what to measure on 09-14

Written by Lane A (the field), 2026-09-12, against `alpha` `a68401f` plus this lane's working
tree. It is a REQUEST, not a report: everything below is a number the sim has to have, does not
have, and has picked a value for. **V1 cannot settle either of them** — one is arithmetic the
manual does not print and the other was never published at all.

Two numbers, and a third that FALLS OUT of the first:

| | what it decides | today | provenance |
|---|---|---|---|
| `BB_FLOWER_MID_Z` | where the scoring volume starts, and where a NECTAR seats | **3.98** | `APPROX`, derived — see §1 |
| `BB_TIP_POLLEN[0]` | whether an EMPTY cell can tip at all | **8** | `APPROX`, extrapolated — see §2 |
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
