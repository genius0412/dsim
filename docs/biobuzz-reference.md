# BIOBUZZ (FTC 2026-27) — game & field reference

**STATUS: A SCAFFOLD. Almost every value below is blank on purpose.**

This is the ground truth the sim implements, in the same shape as
[`decode-reference.md`](decode-reference.md) — and DECODE's numbers came from pixel-measuring
the manual's own figures, not from its prose, which is why the measurement log near the bottom
is a first-class section here rather than an afterthought.

It is blank because the V0 pre-season manual has nothing to put in it. Sections 8, 9, 10 and
11 — Game Overview, ARENA, Game Details, Game Rules — are each a single page reading *"This
section will be updated with the Kickoff Competition Manual release on September 12, 2026"*
(V0 pages 60, 61, 62, 63). There are no field figures anywhere in those pages: the extractor
finds 19 images in the 93-page V0 and not one of them is on a field page.

**Fill it from the Kickoff manual before writing constants**, not after. A number that reaches
`src/games/biobuzz/config.ts` without a row here is a number nobody can re-derive, and the
`APPROX` convention in that file exists to be retired against this document.

Field coordinates below are the SIM world frame:

> **origin at field centre · +x = the audience's right · +y = away from the audience · inches**

Same convention as DECODE and Chain Reaction. It is stated here rather than assumed because
the FTC field coordinate system is not the same one, and a cross-check against a published
AprilTag coordinate is the cheapest way to catch a mirrored field — see *Cross-checks* below.

---

## Match structure

| Phase | Duration | Source |
|---|---|---|
| AUTO | | |
| Transition | | |
| TELEOP (driver-controlled) | | |
| ENDGAME (begins with … left) | | |

## Scoring

| Achievement | Points | When assessed | Source |
|---|---:|---|---|
| | | | |

Fouls: MINOR ___ / MAJOR ___, awarded to the OPPOSING alliance.
⚠️ Take these from the **Section 16 glossary**, not from memory — DECODE's are 5/15 and a
previous season's were 10/30, and this repo shipped the wrong pair for months once already.

## Scoring elements

| Element | Count | Diameter / size | Colour(s) | Where it starts | Source |
|---|---:|---|---|---|---|
| POLLEN | | | | | |

⚠️ **The POLLEN base constants are SIGNED OFF and are not retuned by this document.** If the
manual's real POLLEN differs in size or count, that is a finding to record here and raise —
the owner owns physics, and a ball constant is not changed by a BIOBUZZ chat. Observations go
to `docs/biobuzz/feedback/000-solver-observations.md`.

## Field map (sim world frame)

Everything drawn today, and nothing more. `drawField.ts` draws the mat, the 24" tile grid, the
perimeter and a centre cross — and it is deliberately that sparse, because a field that LOOKS
finished is the worst available outcome before the geometry exists.

```
                                  far wall  (y = +72)
                    ┌────────────────────────────────────────┐
                    │                                        │
                    │                                        │
                    │                                        │
   red wall         │                   ┼                    │        blue wall
   (x = -72)        │            origin (0, 0)               │        (x = +72)
                    │                                        │
                    │           24" tile grid throughout     │
                    │                                        │
                    └────────────────────────────────────────┘
                               audience wall  (y = -72)

          12ft x 12ft — six 24" tiles per side, so x=0 and y=0 are BOTH grid lines.
```

| Feature | Value | Constant | Source |
|---|---|---|---|
| Field half-width / half-depth | 72 in | `BB_HALF_X` / `BB_HALF_Y` | standard FTC field |
| Tile pitch | 24 in | `C.TILE` | shared |
| Perimeter wall thickness | 10 in | `BB_WALL_T` | APPROX |
| Camera bound beyond the wall | none | `BB_VIEW_HALF_X` | APPROX — no outboard goal known |
| Alliance walls | | | |
| Goal(s) | | | |
| Tape / zones | | | |
| Structures | | | |

Anything added here needs the same three things DECODE's entries have: a value, the constant
that carries it, and a source that names a page.

---

## Measurement log

**One row per measured dimension.** This is what makes a number re-derivable instead of
re-guessable, and it is the section that actually gets used a year later.

Method: open the figure, find ONE dimension the manual states in words or in a callout,
measure it in pixels, and every other dimension on that drawing follows from the ratio. Then
check the result against a SECOND known dimension before trusting it — a drawing that is not
to scale fails that check immediately, and one that is to scale costs a single extra
measurement.

| Figure (page, file) | Reference dimension | px | in/px | Derived | Value (in) | Second check |
|---|---|---:|---:|---|---:|---|
| | | | | | | |

Figures come from:

```bash
node scripts/manual.mjs
```

```bash
node scripts/manual-figures.mjs
```

The first downloads the PDF and its text and prints the section-to-page table; the second
extracts the embedded images to `scratch/manual/figures/` with an `index.md`. Both write to
`scratch/`, which is gitignored — the PDF and its figures are FIRST's, and the citations here
are what belong in the repo.

⚠️ **A FIGURE THAT EXTRACTS NOTHING IS VECTOR LINE ART, NOT A MISSING FIGURE.** The extractor
pulls embedded image XObjects; a drawing authored as paths is not one, and no flag will make
it appear. If a page visibly shows a field drawing and produces no file, that is the expected
result, and the fallback is a high-zoom screenshot of the page, measured exactly the same way
— record it in the log as `screenshot` in place of a page-object filename, with the zoom
level, since the in/px ratio is then specific to that capture and not to the PDF.

## Where this came from (for future verification)

- Manual PDF: `https://ftc-resources.firstinspires.org/ftc/game/manual-NN` via
  `scripts/manual.mjs`. WebFetch's own PDF extractor returns binary garbage on these.
- Text: `pdftotext -layout` for prose; `pdftotext` WITHOUT `-layout` for the Section 16
  glossary, whose two columns interleave otherwise.
- Figures: `scripts/manual-figures.mjs` (Node stdlib — `pdfimages` is not on this machine,
  and the header of that file explains why writing one was cheaper than installing one).
- V0 baseline read for this scaffold: `BIOBUZZ_Competition_Manual_V0.pdf`, 93 pages, Sections
  8-11 all placeholders (pp. 60-63), Section 16 Glossary p. 92, 19 extractable figures, none
  of which are field drawings.

### Cross-checks worth doing once

- **Mirror test.** Take one published AprilTag or goal coordinate in the FTC field frame and
  confirm it lands on the side this document says it does. DECODE's red goal tag at FTC
  (−58.37, 55.64, 29.5) resolving to the far-RIGHT corner is what proved that field was not
  mirrored, and a mirrored field is the error that survives every internal consistency check.
- **Two dimensions per drawing**, as above.
- **Prose against figure.** Where the manual states a dimension in words AND draws it, measure
  anyway. DECODE's 26.5" goal face and 18.3" goal depth came off the figures because the prose
  did not carry them.

## Deliberate deviations from the manual (product decisions)

Record them here as they are made, with the reason. DECODE's list is the model: each entry
says what the sim does instead, and why it is better for a driver-practice sim than the
literal rule would be. An undocumented deviation reads as a bug to the next person.

| Deviation | What the manual says | What the sim does | Why |
|---|---|---|---|
| | | | |

## Open questions for Kickoff

Answer these first, in this order, because the rest of the field hangs off them:

1. Field size and origin — is it the standard 12ft square, and is anything outboard of a wall
   (a DECODE-style classifier, a CR-style accelerator) that the camera bound must include?
2. The scoring element — count, diameter, mass, colours, and where they start.
3. Goals and scoring structures — footprint, height, and what a shooter is aiming AT.
4. Zones and tape — what is protected, what constrains a start, what is only a marking.
5. Match structure and the scoring table.
6. The Section 11 rules that touch geometry: start legality, protected zones, possession
   limits. Check every quoted definition against the real Section 16 glossary before trusting
   it — DECODE's G408 shipped for months against two definitions that were not in its manual.
