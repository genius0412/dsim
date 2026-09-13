# BIOBUZZ Competition Manual V1 — distilled

Source: `BIOBUZZ_Competition_Manual_V1.pdf`, 173 pages, "V1" in every page footer. Every line
below cites the **PDF page**, which on this document equals the printed page number (page 2's
footer reads "2 of 173"). Quotation marks mean the words are verbatim from the manual.

**Scope.** Written for the field and robot lanes: scoring, penalties, match timing, the zone and
scoring definitions, human-player rules, start rules, R105, and the glossary. Sections 1–7 (FIRST
ethos, eligibility, advancement, event rules, awards) and 13–15 (tournament, league, Championship)
are summarised only where a game rule points into them.

**Method.** `pdftotext -layout` for prose, `pdftotext` without `-layout` for the two-column
Section 16 glossary, and page rasters at 110 dpi for figures and for the tables whose text layer
is broken (below). Nothing here is measured by eye where the manual states the number in words or
in a dimension callout. Where a value comes **only** from a drawing it is marked `APPROX` and says
which figure it came from.

### Text-layer defects in this PDF

Some digits are missing from the embedded text of certain pages — they render correctly but do not
extract. Every value taken from one of these pages was read from the page raster:

- **p76** — the AprilTag ID lists extracted as `0, , ,` / `, , , 7` / `, , ,`.
- **p79** — Table 9-1 extracted as `"Buzzer x "`, `" Bells"`, `" -second Buzzer"`, with the event
  and timer rows scrambled out of correspondence.
- **p91** — Table 10-2 extracted with rows and columns interleaved.
- **pp102, 104** — `ROBOT is DISABLED` extracted as `OBOT is DI ABLED`; `RED CARD` as `RED CA D`.

---

## 1. Match timing

§10.1 (p81) and §10.4 (p85):

> "MATCHES consist of pre-MATCH setup, a 30-second AUTO period, an 8-second transition period
> between AUTO and TELEOP, and a 2-minute TELEOP period, followed by the post-MATCH reset."

| period | length | rule / page |
|---|---|---|
| AUTO | 0:30 | §10.4 p85 — "ROBOTS operate without any DRIVER control or input" |
| AUTO→TELEOP transition | 0:08 | §10.4 p85 — "for scoring purposes as described in Section 10.5 Scoring" |
| TELEOP | 2:00 | §10.4 p85 |

The **glossary defines MATCH itself** as "a 30-second AUTO period, an 8-second transition period
between AUTO and TELEOP, and a 2-minute TELEOP period in which the ROBOT plays the current season
game" (p171).

The primary FIELD timer counts **2:30 → 0:00** (Table 9-1). The 8-second transition is shown as its
own `0:08 → 0:01` countdown, so it does **not** consume the 2:30.

### 1.1 Audio cues — Table 9-1 (p79), read from the page raster

| event | timer value | audio cue |
|---|---|---|
| MATCH start | 2:30 | "This MATCH begins in 3, 2, 1, GO" (optional); "Cavalry Charge" |
| AUTO ends | 2:00 | "Buzzer x 3" |
| AUTO to TELEOP Transition | 0:08 to 0:01 | "Drivers, pick up your controllers, 3-2-1" |
| TELEOP begins | 2:00 | "3 Bells" |
| **FLOWER Ownership Unlocked** | **1:00** | **[TBD]** |
| Final 20 seconds | 0:20 | "Train Whistle" |
| MATCH end | 0:00 | "3-second Buzzer" |
| MATCH stopped | N/A | "Foghorn" |

§9.11 (p79): "audio cues are intended as a courtesy to participants and not intended as official
MATCH markers. If there is a discrepancy between an audio cue and the visual FIELD timers, the
visual FIELD timers are the authority."

### 1.2 The NECTAR cue — 1:00 remaining

**One instant governs three separate things.** The manual never names it as a period; BIOBUZZ has
no endgame.

1. **FLOWER scoring opens.** §10.5.2 (p88): "FLOWER scoring cannot begin until there is one minute
   remaining in the MATCH per G410. Achievements scored prior to one minute remaining are still
   scored, but subject to penalties."
2. **ROBOTS may enter NECTAR into a FLOWER.** G410 (p109): "ROBOTS may not enter NECTAR into the
   FLOWER scoring volume until the last 60 seconds of the MATCH." Violation: **MAJOR FOUL per
   NECTAR**. "The primary FIELD timer display is the cue to indicate when there is 60 seconds left
   in the MATCH."
3. **Humans may enter all remaining NECTAR.** G426 (p116) — §7 below.

Before 1:00 the only legal human NECTAR entry is the per-TIP allowance. §10.1 (p81): "Each time a
HIVE is TIPPED, an ALLIANCE is allowed to enter one of five NECTAR initially staged in the ALLIANCE
AREA. With 60 seconds left in the MATCH, ALLIANCES can enter all remaining NECTAR."

⚠️ **"Final 20 seconds" at 0:20 is an audio cue and nothing else.** No scoring line, RP, or rule
keys on it — the "Train Whistle" is all the manual attaches to that moment.

---

## 2. Scoring

### 2.1 Point values — Table 10-2 (p91), read from the page raster

A blank cell in the manual means *not available in that period*; the manual prints `-` where a
value is simply absent.

| category | line | AUTO | TELEOP | RP | when assessed |
|---|---|---|---|---|---|
| LEAVE | — | **3** | *(blank)* | - | end of AUTO (§10.5.F) |
| PARK | — | **5** | **5** | - | AUTO: end of AUTO; TELEOP: end of MATCH (§10.5.F, §10.5.G) |
| HIVE | HIVE TIP | **20** | **20** | - | throughout the MATCH, continuing "until all SCORING ELEMENTS and ROBOTS have come to rest at the conclusion of the MATCH" (§10.5.A); a TIP "complete prior to the start of TELEOP" is assessed as AUTO (§10.5.B) |
| HIVE | POLLEN and/or NECTAR remaining in CELL | - | **2** | - | "after all SCORING ELEMENTS and ROBOTS have come to rest at the conclusion of the MATCH" (§10.5.C) |
| FLOWER | Bottom NECTAR Bonus | - | **5** | - | throughout, "with final assessment taking place at the end of TELEOP after all SCORING ELEMENTS and ROBOTS have come to rest" (§10.5.D) |
| FLOWER | POLLEN and/or NECTAR in an owned FLOWER | - | **2** | - | as above (§10.5.D) |
| GARDEN | POLLEN and/or NECTAR in GARDEN | - | **1** | - | "at the end of TELEOP when all ROBOTS and SCORING ELEMENTS have come to rest" (§10.5.E) |
| — | **SWARM RP** — "Combined LEAVE + PARK points earned at or above threshold" | - | - | **1** | end of MATCH |
| — | **POLLINATOR 1 RP** — "The number of TIPS at or above threshold" | - | - | **1** | end of MATCH |
| — | **POLLINATOR 2 RP** — "The number of TIPS at or above threshold" | - | - | **1** | end of MATCH |
| — | **WIN** — "Completing a MATCH with more MATCH points than your opponent" | - | - | **3** | end of MATCH |
| — | **TIE** — "Completing a MATCH with the same MATCH points as your opponent" | - | - | **1** | end of MATCH |

⚠️ **LEAVE has no TELEOP value.** Its TELEOP cell in Table 10-2 is empty — not a dash, not a zero.
PARK is the only ROBOT achievement scoring in both periods.

⚠️ **HIVE TIP is worth 20 in both periods**, so a TIP is worth the same whenever it lands.

### 2.2 RP thresholds — Table 10-3 (p91)

| RP type | *FIRST* Championship | Regional Championships | **All Other Events\*** |
|---|---|---|---|
| SWARM RP | TBA | TBA | **16 Points** |
| POLLINATOR 1 RP | TBA | TBA | **4 TIPS** |
| POLLINATOR 2 RP | TBA | TBA | **7 TIPS** |

"RP thresholds for Regional Championships and *FIRST* Championship will be announced in Team
Updates." "\*Premier Events will be able to set their own thresholds to best reflect the
experience they want to provide teams."

### 2.3 Assessment rules, verbatim — §10.5 (p86)

> "A. Assessment of HIVE TIPS occurs throughout the MATCH and continues until all SCORING ELEMENTS
> and ROBOTS have come to rest at the conclusion of the MATCH.
> B. HIVE TIPS that are complete prior to the start of TELEOP are assessed as part of AUTO.
> C. Assessment of POLLEN and NECTAR remaining in the CELL will occur after all SCORING ELEMENTS
> and ROBOTS have come to rest at the conclusion of the MATCH.
> D. Assessment of SCORING ELEMENTS scored in a FLOWER will occur throughout the MATCH with final
> assessment taking place at the end of TELEOP after all SCORING ELEMENTS and ROBOTS have come to
> rest at the conclusion of the MATCH.
> E. Assessment of GARDEN scoring occurs at the end of TELEOP when all ROBOTS and SCORING ELEMENTS
> have come to rest at the conclusion of the MATCH.
> F. Assessment of LEAVE and AUTO PARK occurs at the end of AUTO.
> G. Assessment of TELEOP PARK occurs at the end of the MATCH."

Also p86: "Achievements scored before the MATCH starts, during the AUTO-to-TELEOP transition
period, and after the MATCH ends at 0:00 may be subject to penalties." And: "Scoring is evaluated
and scored by human volunteers. Delays or errors in the live score are not considered an ARENA
FAULT."

### 2.4 HIVE TIP criteria — §10.5.1 (p87)

> "The HIVE is considered TIPPED when:
> A. it moves from one stable state to the other stable state with the downwards-facing CELL
> becoming the upwards-facing CELL, and
> B. subsequently, the damper on the HIVE that was previously not contacting the frame begins to
> contact the frame."

Notes on the same page:

- "LAUNCHING into the upward-facing CELL is the only allowed way to earn a HIVE TIP. ROBOTS must
  follow G417 and cannot disrupt or cause a HIVE TIP in other ways."
- "Teams should be aware that LAUNCHING at the downward-facing CELL while a HIVE is tipping may
  disrupt its movement and may result in the TIP not being achieved."
- "volunteers are not expected to watch for the specific instant the damper contacts the frame."

**POLLEN and NECTAR remaining in CELL** (p87): "At the end of the MATCH, any POLLEN and/or NECTAR
left in an upward-facing CELL will earn points for that ALLIANCE."

⚠️ **The manual never states what it takes to tip a HIVE.** §9.6 (p69) says only that each HIVE "is
bi-stable and will hold its position until enough POLLEN or NECTAR are LAUNCHED into the
upwards-facing CELL". No mass, count, or torque threshold appears anywhere in V1.

### 2.5 FLOWER criteria — §10.5.2 (p88)

> "NECTAR and POLLEN score when they are at least partially within the FLOWER scoring volume:
> between the top ring and the middle ring as highlighted purple and included in CAD Reference
> 10-4."

- **Bottom NECTAR Bonus**: "The ALLIANCE that has the bottom-most NECTAR of its color that meets
  the criteria for scoring in a FLOWER earns points."
- **FLOWER Owner**: "The ALLIANCE that has the top-most NECTAR of its color that meets the criteria
  for scoring in a FLOWER owns that FLOWER and will earn points for every POLLEN and NECTAR that
  meet the scoring criteria for that FLOWER, regardless of which ALLIANCE placed the POLLEN and/or
  NECTAR in the FLOWER."
- "Placing SCORING ELEMENTS into the top of the FLOWER is the only allowable way to score. ROBOTS
  must follow G418 while interacting with the FLOWER."

Figure 10-5 (p89) illustrates ownership. The scoring volume's height is **not given as a number** —
it is defined by reference to the top and middle rings and to an external CAD link ("Click to View
more Details"), which is outside this PDF.

### 2.6 GARDEN criteria — §10.5.3 (p89)

> "To qualify for GARDEN points, POLLEN or NECTAR must be at least partially in the GARDEN zone."
>
> - "GARDENS are ALLIANCE SPECIFIC and earn points for the ALLIANCE of corresponding color
>   regardless of which ALLIANCE placed the POLLEN or NECTAR in the GARDEN.
> - GARDENS are not protected zones, and either ALLIANCE can remove SCORING ELEMENTS from either
>   GARDEN during the MATCH.
> - NECTAR belonging to either ALLIANCE and POLLEN scores in the GARDEN for the ALLIANCE that
>   corresponds with the color of the GARDEN."

Figure 10-6 (p90) shows seven balls along a garden strip marked ✗/✓: a ball overlapping the taped
strip scores, one clear of it does not. Element colour never affects **whether** it scores, only
which alliance is credited — and that is the GARDEN's colour, not the ball's.

### 2.7 LEAVE and PARK — §10.5.4 (p90), verbatim

> **LEAVE** — "To qualify for LEAVE points, a ROBOT must move so that it is no longer contacting
> the perimeter wall."
>
> **PARK** — "To qualify for PARK points, a ROBOT must move so that it is at least partially in the
> LOADING ZONE. (Figure 10-7)"

The glossary (p171) repeats both word for word: LEAVE is "a scoring achievement in which a ROBOT
must move so that it is no longer contacting the perimeter wall"; PARK is "a scoring achievement in
which a ROBOT must move so that it is at least partially in the LOADING ZONE".

⚠️ **Neither the rule nor the glossary says *its own* LOADING ZONE.** Figure 10-7's three panels all
show a red robot at the red LOADING ZONE (two ✓, one ✗ — the ✗ being a robot beside but not
overlapping the zone), so the figure does not settle it either. Open question, §11.

Both are ROBOT-position achievements only; the manual attaches no element or contact condition to
either, and LEAVE requires **no** minimum distance — only that contact with the wall has ended.

---

## 3. Penalties

### 3.1 Penalty definitions — Table 10-4 (pp92–93), verbatim

| penalty | description |
|---|---|
| **VERBAL WARNING** | "a warning issued by event staff or the Head REFEREE" |
| **MINOR FOUL** | "a credit of **5 points** towards the opponent's MATCH point total" |
| **MAJOR FOUL** | "a credit of **20 points** towards the opponent's MATCH point total" |
| **YELLOW CARD** | "a warning issued by the Head REFEREE for egregious ROBOT or team member behavior or rule violations. A subsequent YELLOW CARD within the same tournament phase results in a RED CARD" |
| **RED CARD** | "a penalty issued by the Head REFEREE for egregious ROBOT or team member behavior or rule violations which results in a team being DISQUALIFIED for the MATCH." |
| **DISABLED** | "The REFEREE instructs the team to stop the ROBOT which will deactivate all outputs, rendering the ROBOT inoperable for the remainder of the MATCH." |
| **DISQUALIFIED** | "the state of a team in which they receive 0 MATCH points and 0 RANKING POINTS in a Qualification MATCH or causes their ALLIANCE to receive 0 MATCH points in a Playoff MATCH." |

Duration and intent words — §10.6 (p92), verbatim:

> - "MOMENTARY describes durations that are fewer than approximately 3 seconds.
> - CONTINUOUS describes durations that are more than approximately 10 seconds.
> - REPEATED describes actions that happen more than once within a MATCH."
> - "STRATEGIC describes actions done with the aim of gaining a competitive advantage."

"This includes actions that are deliberate or reckless with foreseeable consequences.
Accidental/unforeseeable occurrences cannot be STRATEGIC." And: "Accidental situations that are
then deliberately used to a team's advantage will be viewed as STRATEGIC."

Also §10.6 (p92): "Unless otherwise noted, all penalties are assigned for each instance of a rule
violation, and a single action may violate multiple rules."

### 3.2 The per-3-seconds clause

**Exactly one rule in Section 11 carries a per-3-seconds clause: G421 (PINS).** Its wording is
"MAJOR FOUL per instance and an additional MAJOR FOUL for every 3 seconds in which the situation is
not corrected". Table 10-6 (p95) expands that pattern:

> "Upon violation, a MAJOR FOUL is assessed against the violating ALLIANCE and the REFEREE begins to
> count. Their count continues until the criteria to discontinue the count are met, and for each 3
> seconds within that time, an additional MAJOR FOUL is assessed against the violating ALLIANCE. A
> ROBOT in violation of this type of rule for 15 seconds is assessed a total of 6 MAJOR FOULS
> (assuming no other rules were being simultaneously violated)."

So the tariff is 1 on entry plus 1 per 3 s: 15 s ⇒ 6 MAJOR ⇒ **120 points** to the opponent.

Table 10-6 also fixes the other violation wordings: "MINOR FOUL per SCORING ELEMENT" means a MINOR
"equal to the number of SCORING ELEMENTS used in violation of the rule"; "…and YELLOW CARD per
MATCH if REPEATED" means the card is issued once per MATCH however many further instances occur;
and for the most punitive shape, "Only 1 MAJOR FOUL and 1 CARD can be earned for a single violation
instance; however, multiple MAJOR FOULS and CARDS may be earned in a single MATCH if multiple
instances of the violation occurred during the MATCH" (p96).

### 3.3 Full rule list, Section 11 (pp99–117)

`*` marks rules the manual itself stars. Triggers are compressed; **penalty text is verbatim**.

#### 11.1 Personal Safety (p99)

| rule | MINOR/MAJOR | trigger | penalty |
|---|---|---|---|
| G101\* | neither | A team member enters the FIELD during a MATCH. Stepping on, or "hanging a large portion of their body over the FIELD", violates it; pointing, waving, or leaning over the wall without impacting the MATCH does not. | VERBAL WARNING |
| G102\* | neither | Climbing on, hanging from, deforming such that it does not return to shape without human intervention, or damaging an ARENA element. Bracing the FIELD perimeter is allowed; moving it out of position violates G102.C. | VERBAL WARNING |

#### 11.2 Conduct (pp99–101)

| rule | MINOR/MAJOR | trigger | penalty |
|---|---|---|---|
| G201\* | neither | Not civil toward everyone / not respectful of equipment. | VERBAL WARNING. YELLOW CARD if subsequent violations occur during the event |
| G202\* | neither | Violating the Competition Integrity Contract — throwing MATCHES, deliberately missing RPs, asking others to, asking teams not to show up, taunting opponents, disrupting ARENA operations. | VERBAL WARNING. YELLOW or RED CARD if subsequent violations occur during the event |
| G203\* | neither | An inspected team sends nobody from its DRIVE TEAM to an assigned Qualification MATCH. | DISQUALIFIED from the current MATCH |
| G204\* | **MAJOR** | Actions "clearly aimed at forcing the opponent ALLIANCE to violate a rule". | MAJOR FOUL per instance. MAJOR FOUL per instance and YELLOW CARD per MATCH if REPEATED. "The ALLIANCE that was forced to break a rule will not be assessed a penalty." |
| G205\* | neither | Egregious behaviour beyond the listed rules, or repeat violations during the event. | YELLOW or RED CARD |

G204's two worked examples (p101) are BIOBUZZ-specific: deliberately driving into an opponent lined
up on a FLOWER "with 65 seconds left in the MATCH, causing them drop the NECTAR into the FLOWER
early in violation of G410"; and driving through the blue LOADING ZONE while a blue DRIVE TEAM
member is introducing NECTAR, "deflecting the blue NECTAR before it contacts the TILE in the
LOADING ZONE, in violation of G426."

#### 11.3 Pre-MATCH (pp102–105)

| rule | MINOR/MAJOR | trigger | penalty |
|---|---|---|---|
| G301\* | **MAJOR** (on repeat) | DRIVE TEAM causes a significant delay to MATCH start — only once the expected start time has passed **and** the team has ARENA access. | VERBAL WARNING. MAJOR FOUL for the upcoming MATCH if a subsequent violation occurs within the tournament phase. In a Playoff MATCH the VERBAL WARNING is issued to the entire ALLIANCE. Not MATCH ready within 2 minutes of the warning, with no good-faith effort ⇒ DISABLED |
| G302\* | neither | Items at the FIELD exceed the ALLIANCE AREA / aren't worn or held; or disrupt ARENA operations, extend more than 6 ft 6 in (~198 cm) above the TILES, communicate outside the ARENA, block visibility, or jam another team's remote sensing. | MATCH will not start until remedied. VERBAL WARNING if discovered or used inappropriately during a MATCH. YELLOW CARD if subsequent violations occur during the event |
| G303\* | neither | ROBOT not ready: hazard, fails Section 3.3 eligibility/inspection, isn't the only team-provided item left in the FIELD, or wrong-colour ROBOT SIGNS (R402). | MATCH will not start if there is a quick remedy. DISABLED if not, with re-inspection at the Head REFEREE's discretion. **RED CARD if a ROBOT non-compliant with G303.B participates** |
| G304\* | neither | Start position — §6 below. | MATCH will not start if quick remedy; DISABLED or removed from FIELD if not |
| G305\* | neither | No OpMode selected and INIT-ed; an AUTO OpMode without the 30-second AUTO timer enabled. | MATCH will not start until remedied. DISABLED if the ROBOT cannot initialize an OpMode or it cannot be remedied quickly |

#### 11.4.1 AUTO (p106)

| rule | MINOR/MAJOR | trigger | penalty |
|---|---|---|---|
| G401\* | **MAJOR** if STRATEGIC | A DRIVE TEAM member interacts with a ROBOT or OPERATOR CONSOLE from the start countdown until the end of AUTO. Exceptions: pressing start within a MOMENTARY margin of MATCH start; pressing stop; personal or console safety. | VERBAL WARNING. MAJOR FOUL and YELLOW CARD per MATCH, if STRATEGIC |
| G402 | **MAJOR** | "During AUTO, a team may not disrupt AUTO for the opposing ALLIANCE." | **MAJOR FOUL per MATCH.** MAJOR FOUL and YELLOW CARD per MATCH, if STRATEGIC |

G402's notes (p106): "During AUTO, FIELD columns A, B, C constitute the red side of the FIELD, and
columns D, E, F (Figure 9-5) constitute the blue side of the FIELD. Each ALLIANCE has priority over
those FIELD and SCORING ELEMENTS on their side of the FIELD." Crossing during AUTO "is a risky
gameplay strategy that may be seen as STRATEGIC". Elements deflected across the line by another
object "will likely not be penalized".

⚠️ **G402 is per MATCH, not per instance** — one MAJOR however many times it happens, unless
STRATEGIC adds the card.

#### 11.4.2 TELEOP (pp106–107)

| rule | MINOR/MAJOR | trigger | penalty |
|---|---|---|---|
| G403\* | **MAJOR** if STRATEGIC | "Any powered movement of the ROBOT or any of its MECHANISMS" during the 8-second transition. "Movement due to inertia, gravity, or de-energizing of actuators, etc. is not considered powered movement." | VERBAL WARNING. MAJOR FOUL and YELLOW CARD per MATCH, if STRATEGIC |
| G404\* | **MAJOR** if STRATEGIC | Powered movement after the end of TELEOP, until the Head REFEREE or designee signals retrieval. | VERBAL WARNING. MAJOR FOUL and YELLOW CARD per MATCH, if STRATEGIC |

#### 11.4.3 SCORING ELEMENT (pp107–110)

| rule | MINOR/MAJOR | trigger | penalty |
|---|---|---|---|
| G405\* | **MAJOR** | Deliberately ejecting a SCORING ELEMENT from the FIELD, "either directly or by bouncing it off a FIELD element or another ROBOT". Elements leaving "during scoring attempts or as the result of ROBOT-to-ROBOT interactions are not considered deliberate ejections". | **MAJOR FOUL per SCORING ELEMENT** |
| G406\* | **MAJOR** if STRATEGIC | A ROBOT or DRIVE TEAM member makes a mess in or damages the ARENA. | VERBAL WARNING. MAJOR FOUL and YELLOW CARD per MATCH, if STRATEGIC. DISABLED if a ROBOT caused it and further damage is likely |
| **G407** | **MAJOR** if STRATEGIC | "A ROBOT may not simultaneously CONTROL more than 4 SCORING ELEMENTS." | VERBAL WARNING. MAJOR FOUL and YELLOW CARD per MATCH, if STRATEGIC |
| **G408** | neither | "A ROBOT may not CONTROL the opponent's NECTAR." | VERBAL WARNING. **YELLOW CARD per MATCH, if STRATEGIC** — no FOUL at any level |
| G409 | neither | "A ROBOT may not catch or deflect a SCORING ELEMENT released by a TIPPED HIVE unless and until that SCORING ELEMENT contacts anything else besides that ROBOT." | VERBAL WARNING. **YELLOW CARD per MATCH, if STRATEGIC** — no FOUL |
| **G410** | **MAJOR** | "ROBOTS may not enter NECTAR into the FLOWER scoring volume until the last 60 seconds of the MATCH." | **MAJOR FOUL per NECTAR** |
| G411\* | **MAJOR** | "An ALLIANCE may not STRATEGICALLY prevent the opposing ALLIANCE from accessing SCORING ELEMENTS." | **MAJOR FOUL and YELLOW CARD per MATCH** |

G407's judgement thresholds (p108), verbatim in the manual's own examples — likely STRATEGIC: "A
ROBOT that picks up and CONTROLS 6 or more SCORING ELEMENTS, moving them to a scoring location";
"Multiple instances of greater than MOMENTARY CONTROL of 5 or more SCORING ELEMENTS by a ROBOT
throughout a MATCH". Likely **not** STRATEGIC: "A ROBOT MOMENTARILY CONTROLS 5 SCORING ELEMENTS
which they 'reverse' quickly so that at least one SCORING ELEMENT returns to approximately its
original state." Not CONTROL at all: "bulldozing (inadvertent contact with a SCORING ELEMENT while
in the path of the ROBOT moving about the FIELD)", "deflecting (being hit by a SCORING ELEMENT that
bounces into or off a ROBOT)", and "SCORING ELEMENTS that have been LAUNCHED by a ROBOT that are no
longer in contact with the ROBOT."

G409's STRATEGIC examples (p109): a robot REPEATEDLY stopped under the HIVE waiting for a TIP; a
top-opening MECHANISM used to catch falling elements; REPEATEDLY positioning so falling elements
"hit the ROBOT and move with an advantageous vector before contacting anything else". Not
STRATEGIC: one or two POLLEN landing on a flat surface while driving by, and a non-functioning
robot accumulating elements while stationary.

G411's notes (p110): "An ALLIANCE using their own NECTAR and/or POLLEN for scoring is not a
violation"; "Corralling relevant SCORING ELEMENTS into a limited portion of the FIELD and/or
actively positioning a ROBOT to prevent opposing ALLIANCE access is a violation of this rule. **A
GARDEN is not a protected zone.**"

#### 11.4.4 ROBOT (pp110–112)

| rule | MINOR/MAJOR | trigger | penalty |
|---|---|---|---|
| G412\* | neither | The ROBOT or something it CONTROLS "disrupts anything outside the FIELD or contacts a human that is outside the FIELD", or "the ROBOT operation is dangerous". | **DISABLED and VERBAL WARNING.** YELLOW CARD per MATCH, if subsequent violations occur during the event |
| G413\* | neither | Failing to press stop and set down controllers when instructed to DISABLE per T402. | VERBAL WARNING. **RED CARD, if STRATEGIC** |
| G414\* | neither | Team number or ALLIANCE colour becomes indeterminate to the Head REFEREE. | VERBAL WARNING. YELLOW CARD, if STRATEGIC |
| G415\* | neither | Grabbing, grasping, attaching to, becoming entangled with, or suspending from an ARENA element — SCORING ELEMENTS excepted. "ROBOTS with a concave shape that wraps partially around a FLOWER for purposes such as to aid in alignment would not be in violation." | VERBAL WARNING. YELLOW CARD per MATCH, if STRATEGIC. DISABLED if the Head REFEREE perceives damage is likely |
| G416 | **MAJOR** if STRATEGIC | Exceeding the R105.A / R105.B expansion limits during the MATCH, or deliberately detaching parts per R105.C. | VERBAL WARNING. **MAJOR FOUL per instance, if STRATEGIC** |
| **G417** | **MAJOR** if STRATEGIC | "ROBOTS may not manipulate the motion of the HIVE in any way other than by LAUNCHING SCORING ELEMENTS into an upward-facing CELL." | VERBAL WARNING. MAJOR FOUL and YELLOW CARD per MATCH, if STRATEGIC |
| **G418** | **MAJOR** if STRATEGIC | "ROBOTS may not enter SCORING ELEMENTS into or remove SCORING ELEMENTS from a FLOWER except: A. only enter POLLEN and NECTAR into the top of a FLOWER, and B. only remove POLLEN from the bottom of a FLOWER." | VERBAL WARNING. MAJOR FOUL and YELLOW CARD per MATCH, if STRATEGIC |

G417 (pp111–112). The blanket sentence: "Any other interaction with the HIVE that causes or could
cause or impeding a TIP is a violation of this rule" (sic). Likely STRATEGIC: "ramming into the
HIVE frame at high-speed"; "ramming into the HIVE frame multiple times in a short time period";
"deliberately LAUNCHING NECTAR or POLLEN into the external bottom, sides, or top faces of a CELL";
"impeding the TIP of an opponent's HIVE by LAUNCHING NECTAR or POLLEN at it"; "contacting a HIVE
directly or transitively through a CONTROLLED SCORING ELEMENT"; "actions that are REPEATED after a
warning has been given." Likely **not** STRATEGIC: accidentally bumping the frame while attempting
to pick up POLLEN, and "A ROBOT attempting to LAUNCH POLLEN or NECTAR into the upward-facing CELL
and missing in a way that hits the bottom, sides, or top of the CELL."

G418 (p112): the FLOWER is "designed and intended to only allow POLLEN and NECTAR to enter through
the top of the top ring and only allow POLLEN (not NECTAR) to be removed from the bottom of the
middle ring." Not violations: contacting the FLOWER while entering or removing elements;
contacting already-scored elements while scoring; "driving into a FLOWER and contacting the POLLEN
or NECTAR inside it." Likely STRATEGIC: pulling POLLEN through the side; grabbing and shaking the
FLOWER; forcing NECTAR out of the middle ring with a MECHANISM; "deliberately drives into the
perimeter wall at high-speed causing a SCORING ELEMENT to fall out of a FLOWER"; and "deliberately
holds a NECTAR up to the side of the FLOWER pipes such that it meets the FLOWER scoring criteria."
Likely not: knocking a POLLEN out the top while scoring another, or dislodging one while picking up
POLLEN off the TILES.

#### 11.4.5 Opponent Interaction (pp113–114)

Preamble (p113): "G419 and G420 are mutually exclusive. A single ROBOT to ROBOT interaction which
violates more than 1 of these rules results in the most punitive penalty, and only the most
punitive penalty, being assessed."

| rule | MINOR/MAJOR | trigger | penalty |
|---|---|---|---|
| G419\* | **MAJOR** if STRATEGIC | "A ROBOT may not damage or functionally impair an opponent ROBOT." | VERBAL WARNING. MAJOR FOUL and YELLOW CARD **per instance**, if STRATEGIC. **MAJOR FOUL and RED CARD per instance if STRATEGIC and opponent ROBOT is unable to drive** |
| G420\* | **MAJOR** if STRATEGIC | "A ROBOT may not attach to, tip over, or entangle an opponent ROBOT." | VERBAL WARNING. MAJOR FOUL and YELLOW CARD per instance, if STRATEGIC. **MAJOR FOUL and RED CARD per instance, if STRATEGIC and either CONTINUOUS or opponent ROBOT is unable to drive** |
| **G421\*** | **MAJOR** | "A ROBOT may not PIN an opponent's ROBOT for more than 3 seconds." | **MAJOR FOUL per instance and an additional MAJOR FOUL for every 3 seconds in which the situation is not corrected** |

G419's carve-outs (p113): damage to "exposed or unprotected COMPONENTS or MECHANISMS in the course
of normal gameplay is not likely to be considered a violation", naming "an exposed or unprotected
main power switch (see R603)", "exposed or unprotected wiring", and "a delicately constructed
MECHANISM (such as an intake)". Functional impairment examples include disconnecting internal
wiring, disconnecting the opponent's battery, and powering off a well-protected switch — the last
two "clearly result in a RED CARD because the ROBOT is no longer able to drive". "Unable to drive"
means "the DRIVER can no longer drive to a desired location in a reasonable time (generally). For
example, if a ROBOT can only move in circles, or can only move extremely slowly."

G420 (p114): "Tipping as an unintended consequence of normal ROBOT-to-ROBOT interaction, including
single frame-to-frame hits that result in a ROBOT tipping, as perceived by the REFEREE, is not a
STRATEGIC violation of this rule."

**G421 verbatim, in full** (p114):

> "A ROBOT is PINNING if it is preventing the movement of an opponent ROBOT by contact, either
> direct or transitive (such as against a FIELD element). A PIN count ends once any of the
> following criteria below are met:
> A. the ROBOTS have separated by at least 2 ft. (~61 cm) from each other for more than 3 seconds,
> B. either ROBOT has moved 2 ft. from where the PIN initiated for more than 3 seconds, or
> C. the PINNING ROBOT gets PINNED.
>
> For the criteria in G421.A, the PIN count pauses once ROBOTS are separated by 2 ft. until either
> the PIN ends or the PINNING ROBOT moves back within 2 ft., at which point the PIN count is
> resumed.
>
> For the criteria in G421.B, the PIN count pauses once either ROBOT has moved 2 ft. from where the
> PIN initiated until the PIN ends or until both ROBOTS move back within 2 ft., at which point the
> PIN count is resumed."

⚠️ **G421 does not require the pinned ROBOT to be attempting to move.** The test is "preventing the
movement of an opponent ROBOT by contact" and nothing more; the glossary's PIN/PINNING entry (p171)
is the same sentence. **There is no CARD escalation inside G421** — only the running MAJOR tariff.

#### 11.4.6 Human (pp115–117) — §7 below.

### 3.4 Cards — §10.6.1–10.6.3 (pp93–95)

- "YELLOW CARDS are additive, meaning that a second YELLOW CARD is automatically converted to a RED
  CARD … including earning a second YELLOW CARD during a single MATCH."
- "A RED CARD results in MATCH DISQUALIFICATION. A team that has received either a YELLOW or a RED
  CARD carries a YELLOW CARD into subsequent MATCHES, except as noted below."
- A card caused by an ARENA FAULT "will be rescinded."
- "All YELLOW CARDS and G301 VERBAL WARNINGS are cleared at the conclusion of Practice,
  Qualification, and division Playoff MATCHES." Other VERBAL WARNINGS clear after Practice and
  otherwise persist through later tournament phases.
- §10.6.3 (p95): "During Playoff MATCHES, YELLOW and RED CARDS are assigned to the violating team's
  entire ALLIANCE instead of to only the violating team. If an ALLIANCE receives 2 YELLOW CARDS, the
  entire ALLIANCE is issued a RED CARD."
- §10.7 (p96): "No event staff, including the Head REFEREE, will review video, photos, artistic
  renderings, etc. of any MATCH, from any source, under any circumstances."

---

## 4. Zones, areas, and boundary words

§9.3 (p65): "The term 'zone' is used to identify spaces within the FIELD. The term 'area' is used
to describe spaces outside of the FIELD."

Tape (p65): "either 1 in. (2.50 cm) wide or 2 in. (5.10 cm) wide ProGaff® Premium Professional
Grade Gaffer Tape, or comparable gaffers tape in red, and electric blue." "On the BIOBUZZ FIELD,
none of the tape lines span across TILE seams."

### 4.1 The three definitions, verbatim (§9.3 pp65–66; glossary pp169–171)

> **ALLIANCE AREA**: "an approximately 97 in. (246.40 cm) wide by 54 in. (137.15 cm) deep by
> infinitely tall volume formed by placing ALLIANCE colored tape onto the flooring surface outside
> of the FIELD. **The ALLIANCE AREA includes the taped lines** (Figure 9-2)."
>
> **LOADING ZONE**: "an approximately 23 in. (58.40 cm) wide by 11 in. (27.95 cm) deep infinitely
> tall volume bounded by red or blue tape and the adjoining FIELD perimeters. **The LOADING ZONE
> includes the tape lines** (Figure 9-3). The LOADING ZONE is an ALLIANCE specific zone belonging to
> the ALLIANCE with the adjacent ALLIANCE AREA."
>
> **GARDEN**: "an approximately 23 in. (58.40 cm) by 2 in. (5.10 cm) wide and infinitely tall volume
> **defined by the outside edge of blue or red tape** in opposite corners of the FIELD, as shown in
> Figure 9-2."

⚠️ **The three boundary phrasings are deliberately different and must not be collapsed.** ALLIANCE
AREA and LOADING ZONE *include* their tape; the GARDEN is bounded by the tape's **outside edge**.
The GARDEN is the one zone where which side of the tape you measure from changes the answer.

### 4.2 Layout (Figure 9-2 p65, Figure 9-3 p66, Figure 9-4/9-5 p67)

- The FIELD "is oriented such that the red ALLIANCE AREA is located on the left from the primary
  audience viewing direction" (§9.5, p68).
- Tile grid: columns **A–F** left to right, rows **1–6** with row 1 nearest the audience (Fig 9-5);
  seam/tab lines **V–Z** and **1–5** (Fig 9-4).
- RED LOADING ZONE sits on the **left wall, one tile row in from the rear wall** — spanning tile row
  5, not in the corner (Fig 9-4, where the red outline lies between seam lines 4 and 5). RED GARDEN
  is in the **audience-left corner**, along the audience wall. BLUE's two are the point-symmetric
  opposites: blue LOADING ZONE on the right wall at row 2, blue GARDEN in the rear-right corner.
  `APPROX` for the row assignments — read from Fig 9-2/9-4; the manual states no coordinates.
- Figure 9-3 dimensions the two: LOADING ZONE `~23 in (~58.40 cm)` along the wall, "Width set by
  TILE Seams", by `11 in. (27.95 cm)` deep. GARDEN `~23 in (~58.40 cm)` along the wall, "Width set
  by TILE Seams", drawn as "[2] pieces: 1 in. (2.5 cm) Wide Tape" — which is where the 2 in. depth
  comes from.
- **The layout is point-symmetric (180° about the centre), not mirrored.** Each alliance's LOADING
  ZONE and GARDEN are in opposite corners of the field from each other, and the two alliances' sets
  are diagonally opposed.

---

## 5. Field and elements

### 5.1 FIELD (§9.1–9.2, pp63–64)

- "approximately 144 in. by 144 in. (365.75 cm by 365.75 cm) area bounded by the inside surface of
  the walls of the FIELD perimeter."
- "36 interlocking soft foam TILES which are each approximately 24 in. by 24 in. by 0.59 in. (60.95
  cm by 60.95 cm by 1.50 cm) nominally sized." FIRST Tech Challenge Field Soft Tiles (am-2499).
- Populated with "1 HIVE Structure, consisting of 1 Frame with 2 mounted HIVES (1 HIVE per
  ALLIANCE)" and "4 FLOWERS". Full field am-5850_Full; perimeter kit am-0481.
- Tolerance rule (§9.1, p63): the 3D CAD model is the official representation, "with a general
  tolerance of +/- 1 in. (+/- 2.5 cm)", and "Illustrations included in the Competition Manual are
  for a general visual understanding … any dimensions included are nominal. Unless specifically
  noted, all these dimensions carry a tolerance of +/- 1 in. (+/- 2.5 cm)."

### 5.2 HIVE Structure (§9.6, pp69–71)

> "The HIVE Structure is located in the center of the FIELD. A frame holds a red HIVE and a blue
> HIVE. Each HIVE consists of 2 CELLS, one on either end of each HIVE. Each CELL is a
> three-dimensional structure that can hold NECTAR and POLLEN.
>
> Each HIVE is on a pivot and can tip so that one of the CELLS is facing upwards at any given time.
> Each HIVE is bi-stable and will hold its position until enough POLLEN or NECTAR are LAUNCHED into
> the upwards-facing CELL. On the bottom face of each CELL is a unique AprilTag Cluster containing 4
> distinct AprilTags."

**Frame** (§9.6.1, p69): "two triangular metal structures that attach to mounting strips under the
TILES which are connected at their apex by a crossbar. The frame is **49.46 in. (125.65 cm) wide**,
and **38.95 in. (98.95 cm) deep** at its base, which is also its widest point. The Frame supports 2
pivots with their axis **43.95 in. (111.65 cm) above the TILES**." A BIOBUZZ logo panel is attached
to each side and "may not be present at all events."

**HIVE and CELL** (§9.6.2, p70): "Each HIVE includes two CELLS (either both red or both blue)
approximately **18.8 in. (47.8 cm) apart**." "The opening of the CELL is approximately **20 in.
(50.8 cm) wide by 14 in (35.6 cm) tall and 12 in. (30.5 cm) deep**."

Figure 9-9 (p71) dimension callouts: **18.84 in (47.85 cm)**, **12.04 in (30.58 cm)**, **42.91 in
(109.0 cm)** overall, with *Pivot* and *Damper* labelled. `18.84 + 2 × 12.04 = 42.92`, so the 18.84
is the clear gap between the two cells and 12.04 is each cell's own length along the bar.

Figure 9-10 (p71) callouts:

| quantity | value |
|---|---|
| tilt | **30°** |
| Top of HIVE Opening above TILES | **65.6 in (166.60 cm)** |
| Bottom of HIVE Opening above TILES | **53.5 in (135.90 cm)** |
| Bottom of HIVE above TILES | **25.5 in (64.75 cm)** |
| HIVE Center to Center | **25.5 in (64.75 cm)** |

**Cross-check on the 30°**, using only stated numbers: the opening is 14 in tall and its stated
vertical extent is `65.6 − 53.5 = 12.1 in`; `14 × cos 30° = 12.12`. So the 30° is the tilt of the
opening face from vertical, equivalently of the HIVE bar from horizontal. Consistent.

⚠️ **Everything else about HIVE geometry is figure-derived.** The manual states no pivot x-position,
no HIVE axis direction, and no cell-centre offset. From Fig 9-2 and Fig 9-17 the two HIVES sit side
by side across the field with each HIVE's two cells fore-and-aft of its pivot — `APPROX`, read from
the figures.

### 5.3 FLOWER (§9.7, pp72–73)

> "The FLOWER is a structure on the FIELD in which POLLEN and NECTAR can be placed into the top, and
> POLLEN can be removed from the bottom. There are four FLOWERS on the FIELD attached to the
> perimeter wall."

Stated key features (p72), verbatim numbers:

- "The opening on the top of each FLOWER is approximately **4 in. (10.15 cm) in diameter** and is
  approximately **21.5 in. (54.6 cm) above the TILES**."
- "There is a backstop on top of each FLOWER to help guide POLLEN and NECTAR into the FLOWER. This
  backstop is **1.25 in. (3.15 cm) tall**."
- "There is a Retrieval Opening at the bottom of the FLOWER for ROBOTS to remove SCORING ELEMENTS
  which is approximately **3.55 in. (9.0 cm) tall and 3.57 in. (9.1 cm) deep**."
- "There is a lower ring that sits on the TILE floor and is approximately **0.4 in. (1.0 cm) tall**
  with an hole for POLLEN to sit in that is approximately **2.79 in. (7.1 cm) diameter**."
- "The upper and middle rings are connected with four HIPS pipes, and the middle and lower rings are
  connected on the perimeter wall side with square extrusion."

Figure 9-12 (p73) adds: top ring plate widths **2.40 in (6.10 cm)** and **1.89 in (4.80 cm)** across
and **1.94 in (4.95 cm)**; "Thickness of Bottom Ring **0.43 in. (1.1 cm)**".

**The geometry that decides what fits**: top opening 4.0 in, retrieval opening 3.55 in, lower ring
hole 2.79 in. A 2.8 in POLLEN passes the top and the retrieval opening but not the lower hole; a 3.6
in NECTAR passes only the top. That is exactly why G418.B permits removing POLLEN and not NECTAR
from the bottom.

⚠️ **The manual gives no FLOWER positions.** "attached to the perimeter wall" is all the text says;
Figure 9-2 / 10-1 show one FLOWER roughly mid-wall on each of the four walls, point-symmetrically
placed. Any coordinate is `APPROX` from those figures.

### 5.4 SCORING ELEMENTS (§9.8, p74)

> "SCORING ELEMENTS for BIOBUZZ are POLLEN and NECTAR.
> - POLLEN are approximately **2.8 in. (7.1 cm)** Gopher ResisDent™ polyethylene balls in yellow
>   (am-5851_yellow).
> - NECTAR are approximately **3.6 in. (9.1 cm)** Gopher ResisDent™ polyethylene balls in red
>   (am-5852_red) and blue (am-5852_blue).
>
> There are **40 POLLEN, 8 red NECTAR, and 8 blue NECTAR** total in a BIOBUZZ MATCH.
> POLLEN and NECTAR are not perfectly spherical and may vary in size. Teams should plan for this
> variation when designing their ROBOTS."

No mass is published for either element.

### 5.5 AprilTags (§9.9, pp74–77)

"AprilTags for BIOBUZZ are **3.25 in. (8.25 cm) square** targets from the **36h11** tag family."
They come as clusters of four on a single sticker, aligned with Reference Holes, "applied to the
CELLS". "Each AprilTag Cluster is placed on the bottom of a CELL facing downward towards the TILES
with its bottom edge oriented towards the center of the FIELD" (p75).

IDs (p76, read from the page raster — the text layer drops most of these digits):

| tags | location |
|---|---|
| **30, 31, 32, 33** | red CELL on the side of the FIELD opposite the audience |
| **34, 35, 36, 37** | red CELL on the audience side |
| **38, 39, 40, 41** | blue CELL on the audience side |
| **42, 43, 44, 45** | blue CELL on the side opposite the audience |

The cluster sticker in Fig 9-16 is labelled per cell, e.g. "RED AUDIENCE / Tag family: 36h11".
Figure 9-15 (p75) carries the cluster and Reference Hole layout dimensions; the manual warns
"Images from this manual are examples and not to scale and not intended to be printed for practice
purposes."

---

## 6. Setup and start rules

### 6.1 SCORING ELEMENT staging — §10.3.1 (pp83–84)

"Each HIVE is tilted such that one CELL is pointed down, and the other CELL is pointed up, as shown.
(An easy way to remember this is the CELL which 'points at' a FLOWER should be the one tilted
down.)"

> "A. 40 POLLEN are staged on the FIELD as follows:
> i. 4 POLLEN in each of the 4 FLOWERS (16)
> ii. 4 POLLEN in the red GARDEN (4)
> iii. 4 POLLEN in the blue GARDEN (4)
> iv. 4 POLLEN pre-loaded in each ROBOT (16)"
>
> "B. 8 red and 8 blue NECTAR are staged on the FIELD as follows:
> i. 3 NECTAR in each upward-facing CELL of corresponding color (6)
> ii. 5 NECTAR are in each ALLIANCE AREA of corresponding color (10)"

Placement notes: "Pre-loaded POLLEN start the MATCH located in or on the ROBOT, or on the TILES
contacting the ROBOT. ROBOTS that are not present for their MATCH will have their pre-load POLLEN
placed in approximately the center of the LOADING ZONE against the perimeter wall." "POLLEN in the
GARDEN is placed in a line starting in the corner closest to the ALLIANCE AREA and contacting the
audience or rear perimeter wall." "NECTAR in the CELL is placed contacting the back wall of the CELL
and in a line against the side closest to the ALLIANCE AREA of corresponding color."

⚠️ **3 NECTAR start in each up-CELL**, so the first TIP of a MATCH is launched into a cell that is
already part-loaded. **16 of the 40 POLLEN start inside FLOWERS**, so the FLOWERS are the field's
POLLEN supply via the retrieval opening.

### 6.2 ROBOT start — G304 (p104), verbatim

> "A ROBOT must be positioned on the FIELD such that it meets all of the following requirements:
> A. fully contained on its own ALLIANCE's side of the FIELD (FIELD columns A, B, C for red, or
> FIELD columns D, E, F for blue) (Figure 9-4),
> B. not attached to, entangled with, or suspended from any FIELD element,
> C. touching the FIELD perimeter wall,
> D. not contacting or in the scoring volume of a FLOWER,
> E. not in the LOADING ZONE,
> F. confined to its STARTING CONFIGURATION (see R102 and R103),
> G. in contact with exactly 4 POLLEN pre-loads as described in Section 10.3.1 SCORING ELEMENTS, and
> H. fully motionless following completion of OpMode initialization,"

Violation: "The MATCH will not start until all requirements are met, if there is a quick remedy.
DISABLED or removed from FIELD, if it is not a quick remedy."

Notes: "G304.A requires the ROBOT to be fully contained within the FIELD perimeter and not overhang
the FIELD perimeter wall." "Each ROBOT must start contacting 4 POLLEN either located in or on the
ROBOT, or on the TILES contacting the ROBOT." Figure 11-1 (p105) shows legal examples.

⚠️ **C and E together**: a robot must touch the perimeter wall but may not be in its LOADING ZONE —
and the LOADING ZONE is itself against the wall. The legal wall frontage excludes that zone.

### 6.3 Other setup rules

- **§10.3.4 (p85)**: "ROBOTS must start the MATCH contacting 4 pre-loaded POLLEN." Placement order,
  if either alliance asks the Head REFEREE beforehand: "1. first red ROBOT 2. first blue ROBOT 3.
  second red ROBOT 4. second blue ROBOT". In Qualification MATCHES, Red 1 / Blue 1 places first
  within their alliance; in Playoffs the ALLIANCE lead decides.
- **§10.3.2 (p84)** DRIVE TEAM staging: only members assigned to that MATCH, only those whose ROBOTS
  passed initial complete inspection, in their designated ALLIANCE AREA, badges "clearly display[ed]
  … above their waists", and in a Playoff MATCH the ALLIANCE CAPTAIN displays their identifier. If
  the alliance cannot agree on placement, "the team listed on the MATCH schedule as 'Red 1' or 'Blue
  1' will stage closest to the audience."
- **§10.3.3 (p84)** OPERATOR CONSOLES: an AUTO OpMode must be selected "with the 30 second timer
  enabled"; otherwise a TELEOP OpMode; either way INIT must be pressed.
- **DRIVE TEAM roles** — Table 10-1 (p82): up to 4 people, "only 1 member of the DRIVE TEAM is
  allowed to be a non-STUDENT". **DRIVE COACH** max 1, "any team member and may be an adult, must
  wear 'DRIVE COACH' badge"; **DRIVER** max 3, STUDENT, "DRIVE TEAM" badge; **HUMAN PLAYER**, "a
  SCORING ELEMENT manager", STUDENT, same badge.

---

## 7. Human-player rules — §11.4.6 (pp115–117)

| rule | MINOR/MAJOR | trigger | penalty |
|---|---|---|---|
| G422\* | **MINOR** if STRATEGIC | "Once a MATCH starts, DRIVE TEAM members may not leave their designated ALLIANCE AREA." | VERBAL WARNING. **MINOR FOUL per instance, if STRATEGIC** |
| G423\* | **MAJOR** if STRATEGIC | "Once the MATCH starts, DRIVE COACHES or members of another team may not handle the gamepads of the OPERATOR CONSOLE." | VERBAL WARNING. MAJOR FOUL and YELLOW CARD per MATCH, if STRATEGIC |
| G424\* | **MINOR** if STRATEGIC | "DRIVE COACHES may not contact SCORING ELEMENTS, except for safety purposes." | VERBAL WARNING. **MINOR FOUL per instance, if STRATEGIC** |
| G425\* | **MAJOR** if STRATEGIC | A DRIVE TEAM member may not directly or indirectly "A. contact a ROBOT, B. contact a SCORING ELEMENT in contact with a ROBOT or TILE, C. disrupt SCORING ELEMENT scoring, or D. contact a FIELD element." | VERBAL WARNING. MAJOR FOUL and YELLOW CARD per MATCH, if STRATEGIC |
| **G426** | **MINOR** | Entering NECTAR onto the FIELD outside the allowances below. | **MINOR FOUL per NECTAR** |
| **G427** | **MINOR** | Introducing NECTAR other than as allowed below. | **MINOR FOUL per NECTAR** |
| **G428** | **MINOR** | "DRIVE TEAM members may not remove SCORING ELEMENTS from the FIELD." | **MINOR FOUL per SCORING ELEMENT** |

**G426 verbatim** (p116):

> "DRIVE TEAM members may not enter NECTAR onto the FIELD except:
> A. each time the HIVE of their corresponding ALLIANCE color is TIPPED, one NECTAR may be entered
> for that ALLIANCE, or
> B. when 60 seconds or less remain in the MATCH, all remaining NECTAR can be entered
>
> whichever comes first."

Note: "The primary FIELD timer is the cue to indicate when there is 60 seconds left in the MATCH."

**G427 verbatim** (p116):

> "NECTAR may not be introduced to the FIELD, except as follows:
> A. without the use of a tool,
> B. by a DRIVE TEAM member of the ALLIANCE of the corresponding color, and
> C. such that NECTAR contacts the TILE within the LOADING ZONE before contacting a ROBOT or a FIELD
> element."

Notes (pp116–117): "Humans scoring into a HIVE or FLOWER is never allowed and subject to G202
violations." "If DRIVE TEAM members come into possession of any POLLEN or opposing ALLIANCE NECTAR
that has exited the FIELD, they should pass it to the nearest FIELD STAFF for reintroduction." "When
introducing NECTAR, DRIVE TEAM members must avoid contacting a SCORING ELEMENT that is also in
contact with a TILE to avoid violating G425."

**G428 note** (p117): "A SCORING ELEMENT is considered on the FIELD if it is contacting a TILE, or in
and/or on a ROBOT, FIELD element, or SCORING ELEMENT."

**G422 notes** (p115): "Simply breaking the plane of the AREA during normal MATCH play is not a
violation." "DRIVE TEAM members may retrieve their own ALLIANCE's NECTAR that has left the FIELD
that they can reach while remaining in the ALLIANCE AREA."

**G425 notes** (p116): "Hand-held controllers, hanging wires, items of clothing, and other objects in
the ALLIANCE AREA can all result in DRIVE TEAM members indirectly contacting a ROBOT." "For G425.A
and G425.B, the penalty is applied to the DRIVE TEAM member regardless of whether the DRIVE TEAM
member or ROBOT initiates contact." Disrupting scoring "includes … blocking a ROBOT from scoring in a
FLOWER, or deliberately hitting or shaking the perimeter wall to descore NECTAR or POLLEN from the
FLOWER."

### 7.1 Element logistics — §10.8.2 (p97)

"POLLEN that exits the FIELD will be reintroduced into the FIELD at the earliest safe opportunity by
FIELD STAFF in the nearest convenient location." "NECTAR that exits the FIELD will be returned to
that ALLIANCE's DRIVE TEAM for reintroduction per Section 11.4.6 Human."

⚠️ **The two element types leave the field by different routes.** A POLLEN comes back wherever FIELD
STAFF put it; a NECTAR goes back to its own DRIVE TEAM and must then re-enter under G426/G427 — i.e.
through the LOADING ZONE and subject to the 1:00 gate.

No ARENA FAULT is called for reasonable delays in either, nor for a MATCH that begins with damaged,
miscounted, or misplaced SCORING ELEMENTS.

---

## 8. R105 and the robot envelope (Section 12)

**R102** (p121) — "**STARTING CONFIGURATION is limited to an 18-inch Cube.** In the STARTING
CONFIGURATION (the physical configuration in which a ROBOT starts a MATCH), all parts of the ROBOT
must be fully stationary, and the ROBOT must be fully self-contained within an **18 in. (45.70 cm)
wide, by 18 in. (45.70 cm) long, by 18 in. (45.70 cm) high** volume." Note: "Any pre-loaded SCORING
ELEMENTS may extend outside the starting size constraint."

**R103** (p121) — the ROBOT must be "fully self-supported (i.e., does not exert force on the sides or
top of a sizing tool)", by mechanical means while powered off and/or by an OpMode that pre-positions
and holds servos and motors.

**R104** (p121) — "**There is no ROBOT weight limit.** There is no explicit weight limit for FIRST
Tech Challenge ROBOTS playing BIOBUZZ."

**R105 verbatim** (p122):

> "**A ROBOT must stay as one assembly, and there are limits to how much it can expand.** After the
> MATCH has started, ROBOTS may expand beyond the STARTING CONFIGURATION but are still subject to
> sizing constraints relative to the ROBOT, based on the initial STARTING CONFIGURATION. The sizing
> constraints are:
>
> A. After the start of the MATCH, ROBOTS may expand beyond the STARTING CONFIGURATION but at all
> times must remain within a **18 in. (45.70 cm) by 24 in. (61.0 cm) by 29 in. (73.65 cm) tall**
> sizing volume when fully expanded per G416,
> B. ROBOTS must be physically constrained to fit within these limits without the use of software,
> and
> C. ROBOTS may not be designed to deliberately detach COMPONENTS.
>
> The sizing limit volume is defined relative to the FIELD surface and is oriented such that the 29
> in. (73.65 cm) dimension is always the vertical height above the FIELD surface."

Notes (pp123–124), each with its own figure:

- "ROBOTS are measured in 'stable' configurations they would use during normal gameplay on the FIELD
  (i.e., with their wheels all touching the TILES). If a ROBOT is 'tilted' slightly due to
  interactions on the FIELD, this is not a violation."
- "A ROBOT that can mechanically exceed the sizing limit would be in violation even if the ROBOT has
  software limiting the position of the extension during the MATCH." (Fig 12-3)
- A single MECHANISM extending out **both** sides is allowed if the overall dimension at maximum
  mechanical extension stays within the limit (Fig 12-4).
- **Multiple** MECHANISMS "that are not mechanically linked that can extend out of both sides of a
  ROBOT simultaneously would NOT be allowed" if the overall horizontal dimension at maximum
  mechanical extension exceeds the limit (Fig 12-5).
- A pivoting extension rotating in the horizontal plane is allowed "as long as the overall dimension
  does not exceed the sizing limit at any point in its travel" (Fig 12-6).

⚠️ **The expansion footprint is 18 × 24, from an 18 × 18 start** — so the horizontal growth is 6 in,
on **one** axis only, and it is the robot's own axis (the volume is "relative to the ROBOT"), while
the 29 in is always true vertical. The in-match enforcement of all of this is **G416**, not R105.

---

## 9. Glossary (Section 16, pp169–173)

Verbatim entries for every capitalised term the field and robot lanes use. Terms defined only inside
a rule and not repeated in Section 16 are marked *(not in glossary)* with their source.

### 9.1 Game elements

| term | definition | page |
|---|---|---|
| **POLLEN** | "2.8 in. (7.1 cm) Gopher ResisDent™ polyethylene balls in yellow" | 171 |
| **NECTAR** | "approximately 3.6 in. (9.1 cm) Gopher ResisDent™ polyethylene balls" | 171 |
| **SCORING ELEMENT** | "SCORING ELEMENTS for BIOBUZZ are POLLEN and NECTAR" | 172 |
| **HIVE** | "a bi-stable structure made up of two CELLS and a connecting assembly that rotates on a pivot" | 170 |
| **CELL** | "a three-dimensional structure that can hold NECTAR and POLLEN" | 169 |
| **FLOWER** | "a structure on the FIELD in which POLLEN and NECTAR can be placed into the top, and POLLEN can be removed from the bottom" | 170 |
| **GARDEN** | "an approximately 23 in. (58.40 cm) by 2 in. (5.10 cm) wide and infinitely tall volume defined by the outside edge of blue or red tape in opposite corners of the FIELD" | 170 |
| **LOADING ZONE** | "an approximately 23 in. (58.40 cm) wide by 11 in. (27.95 cm) deep infinitely tall volume bounded by red or blue tape and the adjoining FIELD perimeters" | 171 |
| **ALLIANCE AREA** | "an approximately 97 in. (246.40 cm) wide by 54 in. (137.15 cm) deep by infinitely tall volume formed by placing ALLIANCE colored tape onto the flooring surface outside of the FIELD" | 169 |
| **FIELD** | "an approximately 144 in. by 144 in. (365.75 cm by 365.75 cm) area bounded by the inside surface of the walls" | 170 |
| **TILE** | "flooring surface of the FIELD is made of 36 interlocking soft foam TILES" | 173 |
| **ARENA** | "includes all elements of the game infrastructure that are required to play this season's FTC game including: the FIELD, SCORING ELEMENTS, queue area, team media area, and all equipment needed for FIELD control, ROBOT control, and scorekeeping" | 169 |
| **HIVE Structure** | *(not in glossary)* — §9.6 p69: frame + 2 mounted HIVES, located in the centre of the FIELD | 69 |
| **AprilTag / AprilTag Cluster** | *(not in glossary)* — §9.9 p74: 3.25 in 36h11 targets, four per cluster on one sticker | 74 |
| **damper** | *(not in glossary)* — §10.5.1 p87 and Fig 9-9 / Fig 10-3: the part whose contact with the frame completes a TIP | 87 |

### 9.2 Actions and achievements

| term | definition | page |
|---|---|---|
| **LAUNCH/LAUNCHING** | "an action by a ROBOT in which the SCORING ELEMENT is shot into the air, propelled across the floor to a desired location or in a preferred direction, or thrown in a forceful way" | 171 |
| **CONTROL** | "an action by a ROBOT in which the SCORING ELEMENT is fully supported by or stuck in, on, or under the ROBOT **or** it intentionally pushes a SCORING ELEMENT to a desired location or in a preferred direction (i.e., herding). CONTROL requires contact with a ROBOT, either directly or transitively through other SCORING ELEMENTS. Typically, CONTROL requires one of the following to be true: A. The SCORING ELEMENT is fully supported by the ROBOT B. The ROBOT is moving the SCORING ELEMENT in a preferred direction with a flat or concave face of the ROBOT" | 169 |
| **TIP/TIPPED** | "a scoring criteria in which the HIVE moves from one stable state to the other stable state with the downwards-facing CELL becoming the upwards-facing CELL and the damper on the HIVE that was previously not contacting the frame begins to contact the frame" | 173 |
| **LEAVE** | "a scoring achievement in which a ROBOT must move so that it is no longer contacting the perimeter wall" | 171 |
| **PARK** | "a scoring achievement in which a ROBOT must move so that it is at least partially in the LOADING ZONE" | 171 |
| **PIN/PINNING** | "an action by a ROBOT that is preventing the movement of an opponent ROBOT by contact, either direct or transitive (such as against a FIELD element)" | 171 |
| **FLOWER Owner / Bottom NECTAR Bonus** | *(not in glossary)* — §10.5.2 p88 | 88 |

⚠️ **LAUNCHING includes propelling along the floor.** A ball rolled or shoved into a CELL at speed is
a LAUNCH by the definition — which matters because G417 makes LAUNCHING into the up-CELL the *only*
legal way to cause a TIP.

⚠️ **CONTROL has two independent limbs** — full support *or* herding — and either one counts toward
G407's limit of 4 and toward G408's opponent-NECTAR ban.

### 9.3 Match, periods, and people

| term | definition | page |
|---|---|---|
| **ALLIANCE** | "a cooperative of 2 FIRST Tech Challenge teams" | 169 |
| **ALLIANCE CAPTAIN** | "the designated STUDENT representative from each ALLIANCE lead" | 169 |
| **AUTO** | "the first 30 seconds of the MATCH, during which DRIVERS may not provide input to their ROBOTS, so ROBOTS operate with only their pre-programmed instructions" | 169 |
| **TELEOP** | "third period of each MATCH is 2 minutes (2:00) long and called the teleoperated period (TELEOP). During TELEOP, DRIVERS remotely operate ROBOTS" | 173 |
| **MATCH** | "a 30-second AUTO period, an 8-second transition period between AUTO and TELEOP, and a 2-minute TELEOP period in which the ROBOT plays the current season game" | 171 |
| **DRIVE TEAM** | "a set of up to 4 people from the same FIRST Tech Challenge team responsible for team performance for a specific MATCH" | 170 |
| **DRIVE COACH** | "a guide or advisor" | 170 |
| **DRIVER** | "an operator and controller of the ROBOT" | 170 |
| **HUMAN PLAYER** | "a SCORING ELEMENT manager" | 170 |
| **STUDENT** | "a person who has not completed high-school, secondary school, or the comparable level in their HOME REGION as of September 1st" | 172 |
| **FIELD STAFF** | "volunteers present in and around the ARENA that are responsible for making sure the MATCHES are cycled through efficiently, fairly, safely, and with a spirit of cooperation, Gracious Professionalism®, and generosity of spirit" | 170 |
| **REFEREE** | "an official who is certified by FIRST to enforce the rules of the current season's game" | 172 |
| **SURROGATE** | "a team randomly assigned by event management software to play an extra Qualification MATCH" | 172 |
| **ARENA FAULT** | "an error in ARENA operation" | 169 |

### 9.4 Scoring and ranking

| term | definition | page |
|---|---|---|
| **RANKING POINTS (RP)** | "credited to a team based on their ALLIANCE's performance in Qualification MATCHES" | 172 |
| **RANKING SCORE (RS)** | "the average number of RANKING POINTS earned by a team throughout their Qualification MATCHES" | 172 |
| **SWARM RP** | "an RP earned when the combined LEAVE + PARK points earned at or above threshold" | 172 |
| **POLLINATOR 1 RP** | "an RP earned when the number of TIPS at or above threshold" | 172 |
| **POLLINATOR 2 RP** | "an RP earned when the number of TIPS at or above threshold" | 172 |

⚠️ **POLLINATOR 1 and POLLINATOR 2 have identical glossary text.** They differ only by the threshold
in Table 10-3 (4 TIPS and 7 TIPS at all other events).

### 9.5 Violations and robot construction

| term | definition | page |
|---|---|---|
| **MINOR FOUL** | "a credit of 5 points towards the opponent's MATCH point total" | 171 |
| **MAJOR FOUL** | "a credit of 20 points towards the opponent's MATCH point total" | 171 |
| **YELLOW CARD** | "a warning issued by the Head REFEREE for egregious ROBOT or team member behavior or rule violations" | 173 |
| **RED CARD** | "a penalty issued by the Head REFEREE for egregious ROBOT or team member behavior or rule violations which results in a team being DISQUALIFIED for the MATCH." | 172 |
| **VERBAL WARNING** | "a warning issued by event staff or the Head REFEREE" | 173 |
| **DISABLED** | "The REFEREE instructs the team to stop the ROBOT which will deactivate all outputs, rendering the ROBOT inoperable for the remainder of the MATCH" | 170 |
| **DISQUALIFIED** | "the state of a team in which they receive 0 MATCH points and 0 RANKING POINTS in a Qualification MATCH or causes their ALLIANCE to receive 0 MATCH points in a Playoff MATCH" | 170 |
| **MOMENTARY** | "describes durations that are fewer than approximately 3 seconds" | 171 |
| **CONTINUOUS** | "describes durations that are more than approximately 10 seconds" | 169 |
| **REPEATED** | "describes actions that happen more than once within a MATCH" | 172 |
| **STRATEGIC** | "describes actions done with the aim of gaining a competitive advantage" | 172 |
| **ROBOT** | "an electromechanical assembly built by a FIRST Tech Challenge team to play the current season's game and includes all the basic systems required to be an active participant in the game — power, communications, control, and movement about the FIELD" | 172 |
| **STARTING CONFIGURATION** | "the physical configuration in which a ROBOT starts a MATCH" | 172 |
| **CHASSIS** | "ROBOT's MAJOR MECHANISM that enables it to move around a FIELD" | 169 |
| **COMPONENT** | "any part in its most basic configuration, which cannot be disassembled without damaging or destroying the part or altering its fundamental function" | 169 |
| **MECHANISM** | "an assembly of COMPONENTS that provide specific functionality on the ROBOT" | 171 |
| **MAJOR MECHANISM** | "a group of COMPONENTS and/or MECHANISMS assembled together to address at least 1 game challenge: ROBOT movement, SCORING ELEMENT manipulation, FIELD element manipulation, or performance of a scorable task without the assistance of another ROBOT" | 171 |
| **OPERATOR CONSOLE** | "the set of COMPONENTS and MECHANISMS used by the DRIVE TEAM to relay commands to the ROBOT" | 171 |
| **ROBOT SIGN** | "a required assembly which attaches to the ROBOT and simultaneously identifies a ROBOT's team number as well as its ALLIANCE affiliation" | 172 |

---

## 10. Open questions for the owner

1. **Does PARK require the ROBOT's OWN LOADING ZONE?** §10.5.4 and the glossary both say only "the
   LOADING ZONE". The LOADING ZONE is defined as alliance-specific (§9.3), which implies own, and
   Figure 10-7 only ever shows a red robot at the red zone — so the figure does not test the
   opposite case. The manual does not close it. Q&A candidate.
2. **What tips a HIVE?** V1 states no threshold — only "enough POLLEN or NECTAR". Every tip model is
   therefore an assumption until measured on a real field or answered in Q&A.
3. **What is the FLOWER scoring volume's height?** §10.5.2 defines it as "between the top ring and
   the middle ring" and defers the geometry to CAD Reference 10-4, a link outside the PDF. The
   middle ring's height above the tiles is never printed. Needs the field CAD.
4. **Where are the four FLOWERS?** "attached to the perimeter wall" is the whole of the text. Any
   coordinate is read off Figure 9-2 / 10-1 at `APPROX`.
5. **Which way does the HIVE axis run, and where are the pivots?** The manual states the structure is
   centred and the HIVES are 25.5 in apart centre to centre, but never says along which axis, nor
   which cell of each HIVE starts up beyond "the CELL which points at a FLOWER should be the one
   tilted down" — which is only decidable once FLOWER positions are fixed (item 4).
6. **Is the CELL open on one face or more?** §9.6.2 gives one opening, "approximately 20 in. wide by
   14 in tall and 12 in. deep", but does not say which face of the prism it is or whether the cell
   is closed elsewhere. Everything about launch approach angle depends on this.
7. **Is a POLLEN or NECTAR launched into the OPPONENT's up-CELL penalised?** No rule prohibits it —
   G417 bans manipulating the HIVE by means other than launching into an up-CELL, and says nothing
   about whose. Worth confirming, since it would also score the opponent a TIP.
8. **Does G410 bind POLLEN?** The rule names NECTAR only ("may not enter NECTAR into the FLOWER
   scoring volume"), while §10.5.2's note says "FLOWER scoring cannot begin until there is one minute
   remaining" without qualification. Read literally, POLLEN may enter a FLOWER at any time but earns
   nothing unless an owner exists. Confirm.
9. **Element mass.** Not published for either POLLEN or NECTAR; needed for any launch or tip model.
10. **RP thresholds for Regional Championships and the *FIRST* Championship** are TBA (Table 10-3) and
    will arrive in a Team Update.
11. **The FLOWER-ownership audio cue** at 1:00 is literally `[TBD]` in Table 9-1 — expect a later
    version to name it.

---

## 11. Conflicts with current docs

Checked against `docs/biobuzz-reference.md` and `docs/biobuzz/field-plan.md` as of this commit.
Neither file was edited. **13 disagreements**, grouped by kind. Most are provenance rather than
value: the two docs carry owner-CAD and owner-ruling numbers that read as if they came from the
manual, and a reader who goes to the cited page will not find them.

### Values that contradict the manual

1. **`field-plan.md` §1 — `BB_FLOWER_VOL_Z = [3.98, 21.5] APPROX`, derived as "middle ring top =
   3.55 + 0.43".** That arithmetic adds the **bottom** ring thickness (Fig 9-12 labels 0.43 in as
   "Thickness of Bottom Ring") to the retrieval-opening height, and calls the result the **middle**
   ring. The manual gives no middle-ring height anywhere. The lower bound of the scoring volume is
   unknown, not 3.98. (`reference.md` §2.3 carries the same derivation.)

2. **`reference.md` §2.2 — "Cells **18.84 in apart**, each **12.04 in deep**".** Fig 9-9's 12.04 is
   the cell's extent **along the HIVE bar**, i.e. its length end to end (18.84 + 2 × 12.04 = 42.92 =
   the stated 42.91 overall). §9.6.2's "12 in. (30.5 cm) deep" is the **opening's** depth. The same
   file's §2.2 table then correctly uses 12.04 as "cell depth" in the foreshortening maths, so the
   two readings coexist in one document under one name.

3. **`reference.md` §5 table — "G407 … hopper cap 4; herding count warned at 5, MAJOR at 6+" and
   `field-plan.md` §4.3, §7 — "Hopper ceiling 4 (G407); default 4".** G407 caps **CONTROL**, which
   by the glossary includes herding, and its violation is a VERBAL WARNING with MAJOR + YELLOW only
   "if STRATEGIC". A structural hopper cap of 4 is not what the rule says, and it interacts badly
   with G304.G: a robot **starts** contacting exactly 4 POLLEN, so it begins at the cap and the
   first ball it touches on the floor is its fifth CONTROLLED element. Flagging the mechanism, not
   the number.

4. **`field-plan.md` §4.4 — "G417 frame ram … VERBAL first, MAJOR + YELLOW if REPEATED".** G417's
   escalation condition is **STRATEGIC**, not REPEATED. REPEATED appears only as example F, one of
   six listed indicators that an action is likely STRATEGIC. Using REPEATED as the trigger drops
   example A ("ramming into the HIVE frame at high-speed"), which is STRATEGIC on a single hit.

5. **`reference.md` §6 — "**G407** effectively caps the hopper at **4** elements."** Same as (3),
   restated as a robot-envelope fact where Lane B will read it as structural.

### Numbers presented as manual facts that the manual does not contain

6. **`reference.md` §2.3 FLOWER coordinates** — (−69.46, −24), (−24, +69.46), (+69.46, +24), (+24,
   −69.46), cited to "Fig 9-2 / 9-4 pixel measurement" and owner CAD. The manual states no FLOWER
   position at all. The values may well be right; the citation should not read as the manual.

7. **`reference.md` §2.2 — "Cluster centreline 9.938 in from the cell front; tags on 2.75-in centres
   in two pairs 7.0 in apart (Fig 9-15)."** Fig 9-15 is a dimension drawing on p75 and the manual
   prints no such figures in text; these are measurements off the drawing and are not marked
   `APPROX`.

8. **`reference.md` §2.2 — "the HIVE axis … runs along **y**" and "red pivot x = −12.75, blue pivot
   x = +12.75".** The manual gives 25.5 in centre to centre (Fig 9-10) and says the structure is in
   the centre of the FIELD (§9.6), but never states the axis direction. `reference.md` marks the
   ±12.75 `APPROX` for centring while treating the **axis** as established — it is the axis that is
   figure-only. (Conversely the centring itself is *stated* in §9.6, so that half is firmer than the
   `APPROX` suggests.)

9. **`reference.md` §4.1 HIVE TIP table** (`[8 APPROX, 7, 6, 3, 1, 0]`) and **`field-plan.md` §1
   `BB_TIP_POLLEN`.** Both say plainly that these are owner measurements and that the manual is
   silent — correct and well-labelled. Recorded here only so the conflict list is complete: **V1
   contains no tip threshold**, so nothing in the PDF can ever confirm or refute this table.

10. **`reference.md` §2.2 — "Swing time ≈ 4 s", "The CELL is open at its OUTER end only", "Tilt 30°
    from level"** and the matching `field-plan.md` §2.1 rules. The first two are owner rulings
    (labelled as such). The third is figure-only: Fig 9-10 prints "30°" without saying from what.
    It does check out — the stated opening heights give 65.6 − 53.5 = 12.1 = 14 × cos 30° — so the
    reading is right, but the derivation belongs in the doc rather than a bare citation.

11. **`reference.md` §2.1 — ALLIANCE AREA "centred on the side wall", red x ∈ [−126, −72], y ∈
    [−48.5, +48.5].** The 97 × 54 size is stated (§9.3, glossary); the **centring** is not, and is
    read from Fig 9-2. Not marked `APPROX`.

### Omissions worth closing

12. **Neither doc records that LEAVE has no TELEOP value.** `reference.md` §4's table shows LEAVE as
    "3 | – " which is right, but the manual's cell is *blank* rather than a dash, and the distinction
    is the reason PARK is the only both-period ROBOT achievement. Worth stating explicitly so nobody
    "restores" a teleop LEAVE.

13. **Neither doc records G421's missing struggle test.** `reference.md` §5 summarises G421 as
    "PIN ≤ 3 s (2-ft / 3-s release, pause/resume) … DECODE's pin detector, MAJOR tariff". DECODE's
    detector requires the victim to be ATTEMPTING TO MOVE — a clause **G421 does not contain**.
    Porting DECODE's `isPinning` unchanged would under-call BIOBUZZ pins. (`CLAUDE.md` documents that
    DSIM already deviates from DECODE's own version of that clause; under BIOBUZZ the deviation
    becomes the literal rule.)

### Agreements worth recording

Checked and **correct** in both docs: MINOR 5 / MAJOR 20; match 30 / 8 / 120 with the 2:30 → 0:00
display; the 1:00 FLOWER unlock and its `[TBD]` cue; G410 MAJOR per NECTAR; G426 one-per-TIP then
all at ≤ 60 s, MINOR per NECTAR; red = columns A–C on the audience's left; the point-symmetric (not
mirrored) zone layout; LOADING ZONE 23 × 11 including its tape; GARDEN 23 × 2 by the tape's outside
edge; 40 POLLEN / 8 + 8 NECTAR at 2.8 in and 3.6 in; the staging split 16/4/4/16 and 6/10; AprilTag
IDs 30–45 in the stated four groups; R102 18-in cube, R104 no weight limit, R105 18 × 24 × 29
physically constrained; and the scoring table's 3 / 5 / 20 / 2 / 5 / 2 / 1 with RP 16 / 4 / 7 and
WIN 3 / TIE 1.
