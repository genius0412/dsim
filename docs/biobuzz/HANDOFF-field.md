# HANDOFF — Lane A (field)

## 2026-09-12 · rules lane (A6b) · G407 counts HERDING; the foul-line + tariff audit · `biobuzz-rules`

Gates: `npx tsc --noEmit -p .` clean · `npm run server:check` clean · `npm run uiaudit`
**ALL RULES AT OR UNDER BASELINE** · `npm run contrast` **221/221** ·
`npm run test:bb -- --lane rules` **186/186** (was 159, +27) · `npm run test:bb`
**1016/1016**. Base: `origin/alpha` `a68401f`, fast-forward.

### Item 1 — `bbControlled` is now `controlledArtifacts`, and G407 finally sees HERDING

`alpha` `ea2cba4` exported it, so the promise the old body carried is kept: the body is a call
to it and nothing else about the rule moved. The count is **hopper + herded**, which is what
the glossary's CONTROL means — an empty-hoppered robot shoving five loose elements across the
floor now warns, where before it was invisible and only an over-full hopper could trip the rule
(and `bbHopperCap` still clamps that to 4, so in a driven match G407 had never fired at all).

**Smoke (11 new checks):** a herded pile of five warns ONCE for one continuous shove and names
the count; four herded warns nothing; five the robot is merely **PARKED** against warn nothing —
CONTROL is not contact, which is the check that proves the real detector is wired rather than a
proximity count; letting go and shoving again warns again; and the intake-mouth carve-out
suppresses the fifth element for the ~1 s an acquisition takes and then ages out. The fixture is
KINEMATIC (poses and velocities set by hand, the pile advanced with the robot) for this lane's
stated reason — a rules check must fail when the RULE is wrong, not when the pollen solver
bounced a ball half an inch differently.

#### ⚠️ `bbSweepControlClocks` is HALF of the import, not borrowed housekeeping

`controlledArtifacts` is **not a pure reader** — it keeps per-`(robot, element)` hold clocks in
`world.penalties.ballHold` / `ballAnchor` / `ballCarry`, and DECODE sweeps them at the top of
its own `updatePossession`, immediately before calling it. **BIOBUZZ never runs a line of
`src/sim/penalties.ts`'s `updatePenalties`** (`step.ts` stage 7 calls this file directly), so
calling the counting half without the sweeping half reproduces, in this game, both failures
DECODE's own comment records: the maps are only ever pruned along the NOT-TOUCHING path, so an
element intaken while in contact keeps its clock for the rest of the match and rides every
30 Hz snapshot and every stored replay — and element ids are recycled, so a stale key rebinds to
a DIFFERENT element which then arrives **pre-latched** and skips the confirm window, the one
thing standing between herding and bulldozing. Two smoke checks pin it: a herd leaves clocks
behind, intaking the pile clears every one.

The count also runs for **every** robot, `passive` included, and only the warning is skipped —
freezing a passive robot's clocks would leave an element latched to it across the gap.

#### ⚠️ THREE DECODE CONSTANTS COME ALONG WITH IT — one of them matters

The shared function is written against DECODE's field and DECODE's artifact. Measured:

1. **`C.BALL_RADIUS` is 2.5 in; a BIOBUZZ element is simulated at `BB_POLLEN_R` = 1.4.** So
   `reach` (touching) is 2.9 in rather than 1.8, and the transitive `chain` is 5.4 in rather
   than 3.2 — nearly two element DIAMETERS of gap still links two elements. **This is a
   field-plan §6 request: `controlledArtifacts` should read the artifact's own `r`** (every
   `Artifact` already carries one, and `flower.ts` and the draw path already use it) instead of
   the module constant. Until then the count errs HARSH on a loose scatter, which for a rule
   whose only sanction is a warning is the survivable direction — but it is still wrong.
2. `C.HOPPER_CAPACITY` is 3 and a BIOBUZZ hopper holds 4, so the intake-mouth carve-out
   (`room = HOPPER_CAPACITY − hopper.length`) is already spent at 3 and a robot carrying its
   legal four gets none of it. Harsh again, and small.
3. `loadZone(r.alliance)` is DECODE's driver-side rect (blue x ≥ 49), not `BB_LZ` — which in
   BIOBUZZ is a 23 × 11 strip against the SIDE wall somewhere else entirely. So the real
   LOADING ZONE gets no carve-out (a robot collecting its restock is counted) and a strip of
   BIOBUZZ floor that is not a loading zone gets one. Both halves wrong, neither reachable from
   this lane — the carve-out is chosen inside the shared function.

All three are ONE request: a per-game geometry for the shared CONTROL test. None is a reason to
keep hand-rolling the rule — a slightly generous radius on a real detector beats an exact hopper
count that cannot see herding at all.

### Item 2 — YELLOW CARDS: not modelled, as instructed

Owner question 1 is open. Nothing was built. For when it is answered: `bbAwardFoul` is the one
chokepoint every sanction in this game already goes through, so a card is a fourth severity
there plus DECODE's `awardCard` semantics — it is a small change, and the reason to wait is that
a second card is RED and voids the alliance score, which reaches `score.ts` and the results rows.

### Item 3 — the audit: two foul lines and one tariff were wrong

#### Foul lines, against CLAUDE.md's UI COPY rule ("name the ACT, not the place")

A driver gets one toast between cycles and no manual, so a rule LABEL is the same failure as a
bare rule id wearing more words. Three of five passed; two did not:

| was | now |
|---|---|
| `G402 AUTO interference` | `G402 crossing into the opponent’s half in AUTO` |
| `G421 PINNING` | `G421 PINNING an opponent for more than 3 s` |

`G407 CONTROL of 5+ elements`, `G410 NECTAR in a FLOWER before 1:00` and `G417 STRATEGIC
ramming of the HIVE frame` already named their act and are unchanged. All five are now **pinned
in smoke** — four by reading the engine's own source for the exact bytes (an equality against
the string the code just produced passes for every wrong wording, the same argument the scoring
checks make), G407 as a rendered event because its line is a template literal. The typographic
apostrophe (`’`, not `'`) is pinned too.

#### Tariffs, against manual-distilled §3.1 / §3.3

| rule | manual | sim | verdict |
|---|---|---|---|
| MINOR / MAJOR | 5 / **20** (Table 10-4) | `BB_PTS.foulMinor/foulMajor` | ✅ already pinned |
| VERBAL WARNING | no points, no tally | `bbAwardFoul`'s `'warning'` branch | ✅ |
| G402 | **MAJOR FOUL per MATCH** | per `(crosser, victim)` rising edge | ❌ **fixed** |
| G407 | VERBAL WARNING (MAJOR + YELLOW if STRATEGIC) | warning only, no strategic branch | ✅ |
| G410 | MAJOR FOUL **per NECTAR** | keyed per element id | ✅ |
| G417 | VERBAL WARNING; MAJOR + YELLOW **per MATCH** if STRATEGIC | MAJOR once per match, latched | ✅ for the foul — see the question below |
| G421 | MAJOR per instance **+ 1 every 3 s** | entry at 3 s, +1 per 3 s ⇒ 18 s = 6 MAJOR = 120 | ✅ (Table 10-6's worked example) |

**G402 was over-billing.** Table 10-4's row reads "**MAJOR FOUL per MATCH.** MAJOR FOUL and
YELLOW CARD per MATCH, if STRATEGIC" — the same two-clause shape as G417, and the same word
doing the same work. The engine billed per rising edge of a `(crosser, victim)` key, so **one
robot that crossed once and ended up against BOTH opponents paid 40**, and one that bumped,
backed off and bumped again paid 40, where the manual says a team pays 20 for AUTO
interference, once, however much of it there was.

Fixed with **G417's own shape**: the edge trigger stays (delete it and a two-second brush bills
120 before any latch is consulted) and a per-MATCH `bb.held[robot].g402billed` flag sits behind
it. The cap is per **ROBOT** because the sentence's subject is "a TEAM" and an FTC team is one
robot — which is also why two crossers still pay separately. The old smoke check
`G402: re-contacting fires again` asserted the bug and has been flipped; two new fixtures drive
both directions (one crosser / two victims ⇒ 1 MAJOR; two crossers ⇒ 1 each). Both were
verified to FAIL with the latch removed, so neither passes for the wrong reason.

### Two findings OUTSIDE this lane's files — flagged, not edited

1. ⚠️ **`src/games/biobuzz/step.ts:221` pushes `'TELEOP'` into `world.events`.** CLAUDE.md's
   settled terminology ruling: teleop is **DRIVER-CONTROLLED** on all three surfaces that name
   it — the live HUD, `world.events`, and the burned-in overlay — and `src/sim/match.ts:64`
   pushes `'DRIVER-CONTROLLED'`. BIOBUZZ's own HUD already says DRIVER-CONTROLLED
   (`HudSlots.tsx:122`), so the two surfaces disagree **inside this game**, which is exactly the
   inconsistency the ruling was made to end. One word, in Lane A's file, which A6a is editing
   this round — so it is left to the field lane rather than raced.
2. The shared `bbAwardFoul` event envelope uses an ASCII ` - ` separator (`MAJOR FOUL - BLUE
   +20 (…)`), mirroring DECODE's shape on purpose so a toast reads identically in both games.
   UI COPY prefers a full stop or a colon to a dash, and `—` where a dash is right. Changing
   BIOBUZZ's half alone would break the identical-shape promise, and DECODE's half is a
   `src/sim/` string (a SERVER change needing a deploy). One cross-game request, not a lane fix.

### Owner question the tariff audit raised (new)

**G417's base VERBAL WARNING is never issued.** Table 10-4 gives G417 "VERBAL WARNING. MAJOR
FOUL and YELLOW CARD per MATCH, if STRATEGIC", and the sim says **nothing at all** below
`BB_FRAME_RAM_SPEED` — the file argues that a brush which could not cause or impede a TIP is
not a violation of the blanket sentence in the first place. That is defensible, but the manual's
likely-NOT-STRATEGIC list is headed by "accidentally bumping the frame while attempting to pick
up POLLEN", which reads as a thing that IS a violation and merely is not a strategic one. The
warning machinery now exists (it landed with G407). Modelling the base warning would mean a
driver manoeuvring under a HIVE gets a toast on every contact episode — legible under the edge
trigger, but noisy, and G409 assumes robots drive under the hives. **Model the base warning for
sub-threshold frame contact, or keep silence below the ram threshold?** Not implemented either
way; this is the same shape of call as the G407 ruling.

### Still open from before

- `BB_FRAME_RAM_SPEED` (30 in/s) is `APPROX` and on the 09-14 field-test list.
- The YELLOW CARD is named in every rule above that carries one and modelled in none of them.


## 2026-09-12 · A5a items 1–7 (Round 5 + both addenda) · `GREEN`

Base: merged `origin/alpha` `e5d866d` (fast-forward — alpha carried only `field-plan.md` and
`prompts.md`, no code). Gates, all at the end as one batch: `npx tsc --noEmit -p .` **clean** ·
`npm run test:bb -- --lane field` **318/318** · `npm run test:bb` **945/945 ALL PASS** ·
`hive-tip` re-shot at `scratch/shots/e5d866d-dirty/hive-tip@{0,120,240,480}.{light,dark}.png`.

### The seven items

1. **The per-FLOWER supply is gone.** `stock` and `nectarDue` are deleted from `BbFlowerState`
   and from `emptyBiobuzzState()`; the per-ALLIANCE `nectarStock` / `nectarDue` / `nectarTimer`
   stay and are the whole supply. Grepped `hud.ts` and `score.ts` FIRST as instructed: neither
   reads the per-flower pair (hud.ts's `nectarDue` hits are the per-ALLIANCE
   `Record<Alliance, number>`), so nothing had to go back to the master. The fields are DELETED
   rather than left at 0 — a field the rules can read but the sim will never write is a trap.
   Reference: §2.4 and G426, NECTAR enters only through the HUMAN PLAYER.
2. **`bbWorld(seed, setups, pollen)` no longer leaves dangling ids.** It replaced `world.balls`
   after staging, so every FLOWER stack and both up-CELLs held ids that resolved to nothing —
   invisible (a dangling id draws nothing) until it ALIASED a later ball. It now re-runs
   `bbIndexElements(world)` after the replace and carries `nextBallId` past the new layout.
   Smoke: a sweep over every `field` scene at every still asserts BOTH directions — every id in
   a stack or an up-CELL resolves to a ball whose state is `element` with a matching tag, and
   every element-state ball is listed exactly once. Proved non-vacuous by commenting
   `bbIndexElements` out and watching `pile-slow` fail with `flower:0:1 is ground`.
3. **`FIELD_SIDE` is gone from `drawField.ts`.** `FLOWER_MOUTH` in `elements.ts` is now
   `export const` and is the one table; the three usages import it.
4. → became item 6.
5. **The FLOWER is a SORTER** (field-plan §2.2). `flowerStackZ` seats a NECTAR at
   `max(top, BB_FLOWER_MID_Z) + r`; POLLEN pass the ring and stack from the floor as before.
   `BB_FLOWER_MID_Z` (3.98, APPROX) is the ring's UNDERSIDE and its comment says so now.
   `spawn.ts` `flowerStack` is restaged THROUGH `flowerStackZ`, which is what its APPROX comment
   had been asking for.
   **Consequence: NECTAR capacity drops 6 → 5** (zs 5.78 / 9.38 / 12.98 / 16.58 / 20.18;
   3.98 + 5 × 3.6 = 21.98 is already over `BB_FLOWER_TOP_Z` 21.5). POLLEN capacity stays 8.
   **Every A–H scoring OUTCOME is unchanged and four of the z rows moved** — that is the ruling
   working: a bottom nectar used to score because 0.43 + 3.6 = 4.03 cleared 3.98 **by 0.05 in**,
   an accident of two APPROX numbers. Seated on the ring they clear it by construction, so the
   outcomes now survive the ring's height being re-measured and the old ones would not have.
   Smoke block 10b pins the three the addendum named: the bare-nectar span 3.98–7.58 and that
   it scores; a POLLEN under a seated NECTAR pops on retrieval without lowering the NECTAR; the
   staged four POLLEN still read 3 in volume and 0 points.
6. **The spill is calibrated to the owner's landing lines.** `BB_SPILL_SPEED` `[40,60]` →
   **`[50,88]`**; `BB_SPILL_LATERAL` is REPLACED by **`BB_SPILL_FAN` ±55°**, a rotation of the
   whole velocity rather than a sideways nudge. Measured vs target is written up in
   **`docs/biobuzz/feedback/001-spill-kinematics.md`** (that file was the item-4 question; the
   owner had already answered it, so it is now the measurement).
   Headline: **median 71 in from the pivot against a target of ~70, 88% of 360 spilled elements
   inside the 57–107 band**, rest time **4.18 s** (0.18 s AFTER the swing settles, where it used
   to finish 0.12 s before). `hive-tip` therefore grew a **fourth still at 480** — at 4 s two of
   six are still rolling and the frame shows the throw mid-flight.
7. **A CELL takes only its own alliance's element** (owner ruling 2026-09-12, ruling 2). The
   shared flight variant gained **`by?: Alliance`** (`src/types.ts`), stamped in
   `releasePollen`, and `play.ts`'s capture refuses a CELL whose owner is not `by`. A refused
   shot is NOT consumed and NOT fouled: it keeps its arc and lands as ground.
   `scoreTargets(world, a)` no longer lists the opponent's cell.

### ⚠️ Three things the master needs to know

1. **`src/types.ts` was edited** — `by?: Alliance` on the `flight` variant. Outside this lane's
   files, but item 7 names it explicitly. **Optional** on purpose: every DECODE and CR flight,
   and every BIOBUZZ snapshot recorded before this, carries nothing there and is accepted by
   whatever cell it reaches, which is the pre-ruling behaviour. Plain JSON, survives `slimWorld`.
   Smoke covers the fallback.
2. **Two other lanes' smoke files needed one edit each**, both forced by items 6 and 7 and both
   minimal:
   - `scripts/smoke-biobuzz/rules.ts` — `SCENE hive-tip: its stills are 0 · 2 s · 4 s` now
     expects `0,120,240,480` (item 6's fourth still).
   - `scripts/smoke-biobuzz/robot.ts` — the aim filter's NON-VACUITY check (`raw nearest WOULD
     have picked the opponent's opening`) read the raw list from `scoreTargets(w, r.alliance)`,
     which since item 7 no longer contains the opponent's cell; it would have measured 0 poses
     and failed. It now builds the FIELD-WIDE union (both alliances, merged by id), which is the
     list that makes the check mean something. `bbPickTarget`'s own alliance filter is KEPT as a
     second line of defence and its doc block says why.
3. **`scoreTargets` changed meaning**: it is "where may `a` score", not "every opening on the
   field". The only caller that wants the field-wide list is `play.ts`'s capture pass, and it
   now merges both alliances by id. Anything else added later that walks targets to decide
   whether a shot went in must do the same, or one HIVE silently stops taking shots.

### Still open (this lane)

- **The spill's SHORT tail.** 11% of spilled elements rest closer than the 57 in floor — a wide
  fan angle throws an element ACROSS the field rather than out, and a chord is shorter than a
  radius. One constant each was the instruction, so there is no knob separating "far" from
  "wide". Needs a second term if the real field never puts one that close. Question 1 of the
  feedback note.
- **A NECTAR rests up to 0.40 in PAST the wall plane** (35 of 360 spilled elements). SHARED
  physics, not this lane's: the solve runs one radius per call and `clampPollenToWalls` clamps
  at `BB_POLLEN_R` 1.4, so a 1.8 NECTAR overhangs by the difference. Already field-plan §6
  request 1 and `feedback/000-solver-observations.md`; this is the first sighting that is
  visible in a screenshot (`hive-tip@480`, the elements on the audience wall).
- `BB_FLOWER_MID_Z`, `BB_FLOWER_VOL_Z`, `BB_SPILL_SPEED`, `BB_SPILL_FAN` are all **APPROX** and
  all now load-bearing for a scoring outcome.

**Closed since the last section:** the per-FLOWER `stock`/`nectarDue` question (item 1), the
`bbWorld` dangling ids (item 2) and the `drawField.ts` `FIELD_SIDE` duplicate (item 3) — all
three are named as open further down this file and all three are done.

### Cells to look at

`hive-tip@240` (the throw mid-flight, two still rolling) and **`hive-tip@480`** (at rest — how
wide, how far, how many finished against the perimeter), light and dark, at
`scratch/shots/e5d866d-dirty/`.

## 2026-09-12 · rules lane (A5b items 4–5) · G407 is a WARNING · `biobuzz-rules`

Gates: `npx tsc --noEmit -p .` clean · `npm run test:bb -- --lane rules` **159/159** (was 145,
+14) · `npm run test:bb` **882/882**. Based on `origin/alpha` `e5d866d`, merged for the late
owner rulings.

A5b items 1–3 landed in `0ad9bc7`; the addendum's two corrections in `5204d39`. This is items
4–5, which are rulings 3 and 4 from the 2026-09-12 late set.

### Item 4 — G407 as a WARNING (ruling 4)

**The rule was listed in `penalties.ts` as "STRUCTURAL — `bbHopperCap` is 4, so a robot cannot
hold a fifth". The ruling retires that.** Table 10-4 gives G407 a VERBAL WARNING with MAJOR +
YELLOW only if STRATEGIC, and a hopper the sim refuses to fill is not what the rule says.

- **`bbAwardFoul` gained a third severity, `'warning'`**: no points, no tally, one event line
  `WARNING - RED (G407 CONTROL of 5+ elements)`. It goes through that function rather than a
  bare `events.push` so every sanction in this game reads the same way in a toast and a replay.
- **Edge-triggered per ROBOT**, so five held for a minute is ONE warning and five → four → five
  is TWO (§10.6, per instance).
- **No STRATEGIC branch, unlike G417**, and that is deliberate. G417's strategic test is
  measurable (example A is a high-speed ram and the sim has a closing speed); G407's examples
  are about intent, which the sim cannot read. There was no "MAJOR + YELLOW at 6+" branch to
  remove — this lane had never modelled G407 at all.
- **The tally rides `world.penalties.controlInstances`**, the shared per-robot instance count
  that already means exactly this in DECODE. Same argument as the pin clocks, and still no
  `state.ts` edit. Unlike the pin clocks it is **not** cleared at a phase boundary: a clock is
  live state, a tally is history, and the chip counts the match.
- **`biobuzzFieldHud` gained `warnings: Record<Alliance, number>`.** A sanction worth no points
  is invisible on a scoreboard, so the chip IS the sanction. Additive; `HudSlots.tsx` untouched
  (A5c's).
- **`BB_CONTROL_LIMIT = 4` is exported from `penalties.ts`**, not added to `config.ts` (Lane
  B's file). It is the RULE's four; `config.ts`'s `BB_STORAGE_MAX` is the DIAL's four, and
  after relay 2 they are different things that were the same digit by accident.

### ⚠️ Two gaps in item 4, both real, neither guessed at

1. **THE BRIEF'S PREMISE IS NOT TRUE ON THIS BASE: `controlledArtifacts` IS NOT EXPORTED.** The
   item says "on the exported CONTROL count (hopper + herded)". `src/sim/penalties.ts` exports
   exactly two things — `updatePenalties` and `isPinning` — and `controlledArtifacts` is not
   one of them. So **`bbControlled` counts the HOPPER and only the hopper today.** The herded
   half of CONTROL is not reachable from this lane.

   Building a second herding test here would mean duplicating ~150 lines of genuine judgement
   (DECODE's per-(robot, artifact) hold clock, its drain, its transitive contact chain, its
   re-station rule), and a hand-rolled "touching and moving" stand-in fires on every robot that
   drives through the staged scatter. A fabricated warning teaches a driver a habit the real
   rule does not punish — and this rule's entire output IS the teaching, since it moves no
   points. **REQUEST, a §6 request-5 sibling: export `controlledArtifacts`.** The day it lands,
   `bbControlled`'s body becomes a call to it and nothing else in this file changes.

2. **THE RULE IS CORRECT BUT DORMANT UNTIL LANE B LIFTS THE CAP.** `bbHopperCap` still clamps
   every hopper to `BB_STORAGE_MAX` = 4, so a hopper-only count cannot exceed the limit in a
   driven match. That split is the brief's own (relay 2: "the rules lane bills the warning; you
   only lift the cap"), and the smoke drives the rule directly — hopper set by hand — so it is
   proven either way and fires the moment `config.ts` changes.

### Item 5 — G410 binds NECTAR only (ruling 3)

Nothing to do in the engine; it already read the element's kind and skipped `pollen`. One check
added, at **2:00** rather than one second inside the lock: a rule that had quietly generalised
to "no SCORING ELEMENT before 1:00" is indistinguishable from a correct one when the only
evidence is taken at 1:01.

### Rulings 1 and 2 — not this lane's

Ruling 1 (PARK is the own LOADING ZONE) is already what `bbParkedNow` does and the ruling says
so. Ruling 2 (an element launched by the other alliance does not enter a hive's cell) is A5a
item 7 — `play.ts` and `elements.ts`, Lane A4a's files, not touched here.

### Still open from the A5b sections below

`isPinning`'s private `pinnedAgainstWall` probe hard-codes DECODE's goal wedges and classifier
channels as solids and cannot see the HIVE frame bars, so a pin in one of those corner regions
goes unbilled. Shared-core request, under-billing rather than inventing a foul.

The **YELLOW CARD is still not modelled anywhere in BIOBUZZ** (G414/G415/G417/G418/G419/G420
all card). Game-wide decision for the master, unchanged by this commit — G407 was the one rule
where the ruling made the card moot.

## 2026-09-12 · rules lane (A5b addendum) · the distilled manual corrects two rules · `biobuzz-rules`

Gates: `npx tsc --noEmit -p .` clean · `npm run test:bb -- --lane rules` **145/145** (was 141,
+4 net after the G417 checks were rewritten) · `npm run test:bb` **868/868**. Based on
`origin/alpha` `f01f924`, merged for `docs/biobuzz/manual-distilled.md`.

**`docs/biobuzz/manual-distilled.md` is now the rules source of record for this file, not
`docs/biobuzz-reference.md`.** The reference's §5 row for G421 is a summary and its own §10
item 13 records what that summary dropped. Every rule citation in `penalties.ts` now points at
the distilled manual's section and page.

### 1. G421 has NO "attempting to move" clause — and that changes nothing in the code

The verbatim rule (p114, distilled §3.3) is "preventing the movement of an opponent ROBOT by
contact, either direct or transitive" and stops there; the glossary's PIN/PINNING entry on p171
is the same sentence. DECODE's G422 adds "...and the opponent ROBOT is attempting to move".
**G421 does not.**

`isPinning`'s idle-victim branch — the one its own comment marks ⚠️ as a DEVIATION from DECODE,
kept on the grounds that a driver who is held stops mashing the stick — **is therefore the
LITERAL rule under BIOBUZZ.** Under DECODE it is a judgement the sim makes on a referee's
behalf; here it is what the manual says. No code changed; the doc comment and the smoke label
now say so out loud, and both say **do not add a struggle test** — it would under-call every
real BIOBUZZ pin.

### 2. G417's escalation is STRATEGIC, not REPEATED — the code was wrong and is fixed

`field-plan.md` §4.4 read "VERBAL first, MAJOR + YELLOW if REPEATED" and this file implemented
it. Distilled §11 item 4: **REPEATED is not the trigger.** It is example F of six indicators
that an action is likely STRATEGIC, and using it as the condition drops **example A — "ramming
into the HIVE frame at high-speed" — which is STRATEGIC on a single hit.** A robot that ran the
frame down once, hard, was getting a free warning for the one interaction the rule names first.

What changed:

- **`BB_FRAME_RAM_SPEED` is now explicitly this sim's STRATEGIC test.** Above it, the contact
  is example A's high-speed ram and the MAJOR lands on the FIRST instance. Below it, nothing —
  which is the manual's own likely-NOT-STRATEGIC list, headed by "accidentally bumping the
  frame while attempting to pick up POLLEN". The threshold itself is unchanged and still
  `APPROX`, still on the 09-14 field-test list.
- **The tariff is PER MATCH, not per instance.** Table 10-4 says "MAJOR FOUL and YELLOW CARD
  **per MATCH**, if STRATEGIC", in deliberate contrast with G416 two rows above ("MAJOR FOUL
  **per instance**, if STRATEGIC"). So a robot pays once however many times it rams. The latch
  that used to hold "already warned" now holds "already billed" — `bb.held[r.id].g417billed`,
  same per-robot flag map, still no `state.ts` edit.
- **There is no longer a VERBAL event line for G417.** The verbal was the first half of an
  escalation that does not exist. A below-threshold brush is not a violation of the blanket
  sentence at all ("any other interaction ... that causes or could cause or impede a TIP"), so
  the sim says nothing rather than warning about it.
- ⚠️ **The YELLOW CARD is NOT modelled.** BIOBUZZ has no card machinery: `bbAwardFoul` moves
  points and nothing else, and a card carries DQ consequences through scoring and the results
  screen that no Lane A file has built. The FOUL is the half that changes a score, so the foul
  is the half that is here. **Open item for the master** — G414/G415/G417/G418/G419/G420 all
  card, so this is a game-wide decision, not a G417 one.

The master owns the `field-plan.md` §4.4 correction; this branch did not touch that file.

### 3. Table 10-6 fixes the pin tariff arithmetic, and the loop already matched it

"A ROBOT in violation of this type of rule for 15 seconds is assessed a total of 6 MAJOR FOULS"
(p95, distilled §3.2). The violation OPENS at 3 s of pinning, so 15 s of being in violation is
**18 s of pinning ⇒ 6 MAJOR ⇒ 120 points**: one on entry plus one for each of the five further
intervals. `floor(18 / 3)` is 6, so `bbUpdatePins`'s existing `while` loop reproduces it
exactly — but that was luck until it was checked, so it is now checked, longhand, against the
manual's own integer. A loop that billed on entry AND at 3 s would read 7; one that waited for
each interval to complete would read 5.

Also confirmed and now asserted: **G421 has no CARD escalation** (§3.3), only the running
tariff.

### Unchanged from the A5b section below

Items 1–8 of it all still stand, and item 1 is still the open one: `isPinning`'s private
`pinnedAgainstWall` probe hard-codes DECODE's goal wedges and classifier channels as solids and
cannot see the HIVE frame bars, so a pin in one of those corner regions goes unbilled. Still a
shared-core request, still under-billing rather than inventing a foul.

## 2026-09-12 · rules lane (A5b) · G421 PINNING is LIVE · `biobuzz-rules`

Gates: `npx tsc --noEmit -p .` clean · `npm run test:bb -- --lane rules` **141/141** (was 115,
+26) · `npm run test:bb` **864/864**. Based on `origin/alpha` `a318bce`, merged first for the
`isPinning` export.

Files changed: `penalties.ts`, `step.ts`, `hud.ts`, this doc. `score.ts` and `scenesField.ts`
are this lane's and were NOT touched — G421 bills through `world.match.scores[a].foulPoints`,
which `score.ts` already reads, and a pin has nothing to draw on a field that draws no text.

### What landed

**G421 is modelled on DECODE's exported `isPinning`, not on a second detector.** Request 5 of
field-plan §6 is what made this possible, and the rule BIOBUZZ prints is DECODE's G422 with
one thing changed — the tariff. So criteria A/B/C are CALLED:

- **A** the pair gets 24 in (the rule's 2 ft, `PIN_ESCAPE_DIST`) apart for more than 3 s;
- **B** either robot gets that far from where the pin initiated, for more than 3 s;
- **C** the pinning robot is itself being pinned — a mutual hold is nobody's foul.

A and B **END** a pin. Everything else that interrupts it — the pinner easing off, the victim
squirming a foot — **PAUSES** the count and does not reset it. That is the manual's own
"pause/resume" and it is the entire rule: without it a pinner wipes a 2.9-second count by
letting go for a tenth of a second, forever, for free.

**The tariff is the only divergence: MAJOR 20, and another MAJOR every further 3 s** (reference
§5, Table 10-4 — DECODE bills a MINOR). Billed through `bbAwardFoul`, like every other rule in
the file, because the shared `awardFoul` reads `C.PTS_FOUL_MAJOR` = 15.

**The clocks live in `world.penalties.pins` / `.pinFouls`** — the SHARED `PenaltyState`, which
already exists on a BIOBUZZ world (`spawn.ts` initialises it), is already plain JSON on every
snapshot, and already has exactly this shape. No `state.ts` edit: a second BIOBUZZ-flavoured
copy would be a state-type change to store what the world already stores.

### What the next person has to know

1. ⚠️ **`isPinning`'s INTERNAL SOLID PROBE IS STILL DECODE'S FIELD, AND THIS IS A REQUEST.**
   The private `pinnedAgainstWall` helper hard-codes DECODE's **goal wedges** and **classifier
   channels** as solids next to the perimeter. BIOBUZZ has neither, and its own solids — the
   two HIVE FRAME BARS — are invisible to it. The perimeter half is correct (both fields are
   144 in, `C.FIELD_HALF` equals `BB_HALF_X`), so the damage is confined to the four corner
   regions DECODE puts a goal in: a victim held there reads as "cornered against a solid,
   therefore escaping rather than pinning" and **the pin goes unbilled**. That direction is the
   safe one — it under-bills and never invents a foul — but it is wrong, and the fix is shared
   core: **`pinnedAgainstWall` wants the game's own solid list passed in** (a field-plan §6
   request-5 follow-on, same shape as the request that unblocked this one). Until then a pin in
   a BIOBUZZ corner is free.
2. **Contact is `robotsContact` (this file's OBB test with `BB_FOUL_SLOP`), not
   `world.rrContacts`.** DECODE feeds the solver's contact record. Using both would leave one
   file with two disagreeing definitions of contact, and the rules smoke — which drives
   hand-built worlds with no solver behind them — could not reach the rule at all.
3. **`updateBiobuzzPenalties` now takes `(world, dt, commands)`.** A pin is billed in seconds
   and asks whether the pinner is DRIVING INTO its victim, so both were unavoidable. `step.ts`
   passes the APPLIED commands (post aim-override) at stage 7, which is after the Rapier solve
   — load-bearing, because the pin clock measures how far the victim actually got this tick.
4. **The pin clocks are CLEARED outside the played periods, and DECODE's are not.** Robots are
   disabled through the transition, so a pin live at the AUTO buzzer is not being held across
   the freeze; carrying 2.9 s of it into TELEOP bills a MAJOR on the first tick of a period in
   which nothing had happened. This is the same reasoning `src/sim/penalties.ts` applies to
   G408's clocks four lines below the guard it returns from — **DECODE arguably has this bug**,
   and it is the owner's file, so it is reported here rather than patched.
5. **`biobuzzFieldHud` gained `pins: BbPinHud[]`** — `{pinner, pinned, seconds, billed,
   nextIn}`, sorted by pinner then victim. `nextIn` is the number that matters: the clock runs
   in a referee's head and costs 20 points every three seconds, so it is how long the pinner
   has to let go and how long the victim has to keep trying. **ADDITIVE** — every existing read
   still works. Per the A5 split, `HudSlots.tsx` is A5c's from now on and was not touched; if
   that chat needs another field it should ask through the master rather than reach in here.
6. **`bbEscapeDir` is a five-line local copy** of `src/sim/penalties.ts`'s private `escapeDir`.
   Copied rather than requested because it is a normalisation with no rule in it; the thing
   that encodes JUDGEMENT (`isPinning`) is imported. A duplicated judgement is a liability, a
   duplicated unit vector is not worth a round trip.
7. **Every pin fixture is measured on the FOOTPRINT, 21 × 17.** Same warning as item 9 of the
   A4b section below and it bit again: a victim flat against the +x frame bar sits at
   x = 13.5 (24 − 10.5), and a pinner written against the 15-in chassis lands four inches clear
   with the rule never firing — which reads exactly like a broken detector.
8. **26 new checks, and three of them are negative controls.** The mutual shove (criterion C),
   the 2-ft release (criterion A ends it, and a re-press restarts from zero) and the transition
   clear. A pin detector that simply said "yes" would pass the positive checks alone.

## 2026-09-12 · A4a: the field is LIVE · `GREEN`

Gates: `npx tsc --noEmit -p .` clean · `npm run test:bb -- --lane field` **208/208** ·
`npm run test:bb` **580/580** · gallery shots read at `scratch/shots/gate`
(`staging@0`, `hive-ground@0`, `under-hive@0/@120`, `field-labelled@0` — no letters or digits
drawn on the field outside the labelled cell).

### THE SPLIT — read this before touching anything below

A4 was split into two code lanes (`docs/biobuzz/prompts.md`, "A4 split"). **This lane owns
`state.ts`, `play.ts`, `elements.ts` and `scripts/smoke-biobuzz/field.ts` and NOTHING ELSE.**
`penalties.ts`, `hud.ts`, `step.ts`, `scenesField.ts` and the new `scripts/smoke-biobuzz/rules.ts`
belong to the RULES lane (`biobuzz-rules`).

Three things this lane therefore did NOT do, and they are not omissions:

- **No scoring.** Not one Table 10-2 row — TIPS, CELL contents, FLOWERS, GARDEN, LEAVE, PARK.
  `play.ts` stage 8 still zeroes `scored` / `points` / `match.scores[a].total` every tick, and
  that ZEROING is deliberate and should STAY: it runs before the rules lane's score pass, so
  that pass only ever adds to a clean slate and a stale total from a snapshot or a reconcile
  cannot survive. Remove it and a score becomes a running total that never comes down.
- **No fouls.** G410 (a NECTAR into a FLOWER before the 1:00 cue) was written here and then
  taken back out, because it bills through `bbAwardFoul` and `penalties.ts` is not this lane's
  file. The place it goes is the `flight → element` transition in `play.ts` stage 2 — which is
  edge-triggered BY CONSTRUCTION, with no latch and no cooldown, because an element enters a
  FLOWER exactly once and a parked element is not in flight any more. `bb.foulEdge` must NOT be
  used for it: `updateBiobuzzPenalties` overwrites that map every tick.
- **No scenes.** `hive-tip`, `park-examples` and `nectar-entry` are `scenesField.ts`.

### Two commits

1. **`2db7a05` — the shared state contract**, landed first and alone so the rules lane could
   merge it and compile against it.
2. **this one** — the live field.

### What the state contract carries

- `BbHiveState.released: boolean` — A3 asked for it. The spill and the TIP are two moments of
  ONE swing: the tray empties as the bar passes LEVEL (`BB_TIP_RELEASE_S`) and the points land
  two seconds later when it SETTLES. `tipping` alone cannot tell a bar that has already emptied
  from one about to, so without the latch a re-entrant step spills the same contents twice —
  duplicate ids in `world.balls`, and the end of conservation. `HiveState` in `hive.ts` is now
  `export type HiveState = BbHiveState`; there is one hive shape again.
- `BbFlowerState` gains `id`, `stock`, `nectarDue`. `id` is `BB_FLOWERS[i].id` carried on the
  row, because an array position is not a name once the state is on the wire.
  ⚠️ **`stock` and `nectarDue` are DRAFT and deliberately stay 0.** They are the contract's two
  per-flower fields, so the rules lane compiles — but nothing distilled from the manual so far
  describes a FLOWER dispensing NECTAR. The only supply rule found is the HUMAN PLAYER's
  (field-plan §2.4, G426), which is per ALLIANCE and already has `nectarStock` / `nectarDue` on
  the bag. **Question for the owner / the manual lane: is there a per-FLOWER nectar supply, or
  did "flower nectar drip" mean the human player's entries?** Writing a guessed drip into them
  would be the invented-geometry failure the contract forbids.
- `nectarTimer: Record<Alliance, number>` — seconds until the human player puts the next NECTAR
  down. A clock on the world, never a module global: a global is shared by every world in the
  process, so a replay and a live match in the same tab would take turns draining it.
- `bbLoadingZoneSpot(a, r)` moved from `spawn.ts` to `config.ts`, unchanged. The staged spot and
  the entry spot are the same point; a second copy of that arithmetic is how they drift apart.

### What `play.ts` now does — the eight stages, in order

1. HELD elements ride their robot.
2. FLIGHT integrates, then **capture runs off `scoreTargets()`**, then it lands.
3. THE HIVES step.
4. GROUND: the shared `stepGroundBall` (velocity only), then capture.
5. the SHARED artifact solve, then the perimeter invariant.
6. LAUNCH.
7. THE HUMAN PLAYERS.
8. the endgame reset and the score FLOOR (see the split, above).

- **Capture walks the `scoreTargets()` list.** Lane B aims at that list and the gallery draws
  from the same constants, so "where the opening is" and "what counts as going in" cannot drift
  apart. `HIVE_OF` / `FLOWER_OF` in `play.ts` are the `hive:<alliance>` / `flower:<index>` id
  convention written down once, instead of a `slice` and a `Number` at each reader — which is
  exactly how `flower:F1` became un-indexable in a scene.
  `ScoreTarget.mouth` is the approach-side constraint for a CELL (the up-cell is open at its
  OUTER end only, field-plan §2.1) and is NOT a velocity gate for a FLOWER, whose opening is the
  top — the flower branch leaves travel direction entirely to `flowerAccepts`. A smoke check
  pins `mouth === -hiveApproachSign(up)` on both hives in both tilts, because nothing at run
  time notices if those two descriptions of one face stop agreeing: Lane B would aim at a cell
  the field then refuses, which reads as "my shots do not score".
- **A SPILLED ELEMENT COMES BACK AS A GROUND ARTIFACT carrying the spill velocity**, measured at
  41–57 in/s outboard in the smoke scene. Ground and not flight is a decision about who owns it:
  a ground element belongs to `solveArtifacts` from the very next stage of the same tick, so a
  spill landing on a robot or against the structure is resolved by the ONE position authority.
  `spillPoses` reports the tray height as its `pos.z` and the 25-inch drop is not simulated —
  nothing scores or fouls on an element's height between the tray and the tiles, and a fall the
  solve cannot see is a second position authority for a third of a second.
  ⚠️ This is a CHANGE from the shape A3 left: it used to be a flight artifact starting at
  `BB_HIVE_BOTTOM_Z`. Both prompts asked for ground.
- **The human player (stage 7, G426).** A completed TIP earns ONE entry (`nectarDue`, written in
  stage 3); at the 1:00 cue the alliance is owed everything it still holds — a larger
  entitlement, not a faster drip, which is why the dump writes `nectarDue` rather than
  shortening the beat. Entry is a STATE FLIP (`stock` → `ground`) on a ball that has existed
  since setup, never a spawn, which is what keeps conservation a count over one array. Oldest id
  first. Nothing enters while `enabled` is false — the transition and the period after the
  buzzer are exactly when a human player may not reach in.
  `BB_NECTAR_ENTRY_S` (1.5) and `BB_NECTAR_DUMP_S` (1.0) are **APPROX** and local to `play.ts`:
  the manual sets the entitlement and says nothing about the hands. Moving them to `config.ts`
  is a one-line import change when a real field says what a human player actually takes.
- `nextRandomValue(world)` is the single RNG draw in the file — the spill scatter and the entry
  jitter both go through it, so "the rng was drawn N times this tick, in this order" is one
  readable fact rather than two inline closures.

### `elements.ts`

The `upCell` cast is **already gone** — it reads `world.biobuzz?.hives[a].up ?? BB_HIVE_UP_STAGED[a]`,
which is the state with an honest fallback for a world that is not a BIOBUZZ match. Nothing to do.
`scoreTargets()` is real (both up-CELLS + the four FLOWER tops, each with its `mouth`) and is now
the capture authority as well as the aim list. `actOnElement` is still a stub: FLOWER retrieval
(G418.B, field-plan §2.2) is the obvious next thing to put in it and was out of this lane's brief.

### New checks in `scripts/smoke-biobuzz/field.ts` (+19, 189 → 208)

- **a live tip through the real pipeline**: three POLLEN launched INBOARD are taken on the first
  tick; the swing starts on the tick the load completes (stage 3 runs after capture, on purpose);
  the tray empties at tick 121 of a 240-tick swing, i.e. at LEVEL; the release puts back EXACTLY
  the six ids that were in the cell, as ground elements, all outboard and inside `BB_SPILL_SPEED`;
  the TIP lands at tick 241 with the cells swapped and `released` back to false.
- **conservation on EVERY tick**, as a five-bucket partition (ground + flight + held + element +
  stock = 56) with `element` cross-checked against the cells and the flowers. Per-tick and not
  end-state, because a leak that cancels a duplicate is invisible to a final count.
- **the closed side**: two shots differing in nothing but the sign of `vy`; the inboard one is
  taken, the other stays a live flight element (a miss is not a foul, G417.H).
- **`mouth` vs `hiveApproachSign`** on both hives in both tilts.
- **`BB_TIP_POLLEN` pinned literally** as `[8,7,6,3,1,0]`, plus every row tested at `need − 1`
  and `need` and the past-the-end row.
- **`released` survives both round-trips** — `JSON.parse(JSON.stringify(…))` (replay,
  localStorage) and `slimWorld` / `unslimWorld` (the socket, which REBUILDS the world).
- **the human player**: the 1:00 cue empties the stock ONE at a time over five seconds with the
  array length unchanged, and nothing enters while the field is frozen.

### Still open

- The per-FLOWER `stock` / `nectarDue` question above.
- `bbWorld` still leaves dangling element ids (A3's note, unchanged) — `play.ts` tolerates them:
  a dangling id in a spill is skipped rather than thrown over, and `kindById` reads an unknown id
  as POLLEN, because a stale id must not take a match down.
- `drawField.ts` still holds a private `FIELD_SIDE` duplicating `elements.ts`'s `FLOWER_MOUTH`
  (A3's note). Neither file is this lane's.
- `sim.ts` still says `scored: false` and `HudSlots.tsx` still reads `BiobuzzFieldHud.scored`.
  Both are integration-chat files; the flag flips when the rules lane's scoring lands.
## 2026-09-12 · rules lane (A4b) · `LANDED` — commit `b1f4535`, 679 checks green

Scoring, the Section 11 contact rules, the 1:00 cue, the `gameHud` slice and three scenes.
`state.ts` and `play.ts` were not touched; this branch carries A4a's state-contract commit
(`2db7a05`) and nothing else of A4a's.

- **Files owned and changed**: `score.ts` (NEW), `penalties.ts`, `step.ts`, `hud.ts`,
  `scenesField.ts`, `scripts/smoke-biobuzz/rules.ts` (NEW, registered in `index.ts` as
  `--lane rules`, 115 checks).
- **Gates**: `npx tsc --noEmit -p .` clean · `npm run test:bb -- --lane rules` 115/115 ·
  `npm run test:bb` 679/679 · gallery shots on 4177 (`VITE_APP_CHANNEL=alpha`) read at
  hi-res for all three scenes.

### What the next person has to know

1. **`scripts/smoke-biobuzz/field.ts` HAS ONE CHANGED ASSERTION AND IT IS NOT THIS LANE'S
   FILE.** `room: the finished BIOBUZZ match scored nothing (an unscored shell must stay
   0-0)` could not survive a scorer existing: the staged layout — 3 elements in each up-CELL
   and 4 POLLEN in each GARDEN — is worth `3·BB_PTS.cell + 4·BB_PTS.garden` = 10 to each
   alliance before anybody drives. It now asserts that derived value AND that the two
   alliances are EQUAL, which is the cheapest place an x-MIRRORED zone (instead of
   point-symmetric) shows up. `simModuleFor('biobuzz').scored` is still `false`, so
   `persistMatch` still skips the game. **`origin/biobuzz-field`'s `7f67fa0` also edits this
   file**, so expect a one-hunk conflict there and keep both sides.
2. **`origin/biobuzz-field` is AHEAD by `7f67fa0` ("the field goes live") and this branch does
   NOT carry it.** The brief's merge trigger is a `state.ts` commit and that one touches
   `play.ts`, `field.ts` and the handoff only. It is the commit that unblocks item 3.
3. ~~`hive-tip` three identical stills~~ **CLOSED by the integration chat 2026-09-12**: with
   `7f67fa0` merged the stills differ — t=0 full cell, t=2 s cross-fade with the row dimmed
   (released), t=4 s the other cell up and seven elements spilled outboard (1600px re-shoot
   read). Nothing left to do here.
4. **`HudSlots.tsx` has not been wired.** `biobuzzFieldHud` now returns the whole of Table
   10-2 per alliance, the RP flags, the per-cell `needed`/`tipping`, flower owners and depth,
   the nectar stock/due and the G410 lock. The slice is ADDITIVE, so existing reads of
   `f?.scored` still work and nothing is broken — but the `scoreBar` and `resultsRows` slots
   still render almost none of it. That is an integration-chat job (`src/ui/` is outside every
   Lane A file list), and `needed` is the single most decision-changing number in the game.
5. **G421 (pinning) is NOT modelled and is blocked on a one-line export.** `isPinning` is
   private to `src/sim/penalties.ts`; field-plan §6 request 5 asks for it. Until then a
   BIOBUZZ pin costs nothing. **G407 (herding) is deliberately not modelled** — the control
   cap is structural. G405/G409/G411/G418/G426/G427 are structural or human-player rules and
   each says so in `penalties.ts`.
6. **`BB_FRAME_RAM_SPEED` is `APPROX`.** The manual gives no closing speed for G417, so 30
   in/s is a placeholder and the 2026-09-14 field test is what sets it. The escalation it
   gates (VERBAL first, MAJOR on a repeat) is the rule and is not approximate.
7. **The AUTO/TELEOP TIP SPLIT IS NOT STORED.** `BbHiveState.tips` is one counter, so a TIP is
   worth 20 whenever it happens and the results screen cannot break it down by period. Nothing
   in Table 10-2 needs the split today; if a later table does, it is a `state.ts` field and
   therefore A4a's to add.
8. **A `bbSetup` pose is CANONICAL (the BLUE frame).** The spawn mirrors a RED one THROUGH THE
   ORIGIN — (x, y, θ) → (−x, −y, θ + 180°) — so a red robot placed at a left-wall coordinate
   ends up on the right wall. Two scene poses were written the wrong way round before this was
   noticed and the cell looked plausible either way. The gallery draws through
   `viewAngleOf('blue')`, so screen-x is world-y and screen-y is world-x; do not read a shot as
   if it were a plain top-down.
9. **Every fixture is measured on the FOOTPRINT, not the chassis.** `robotExtents` is 21 × 17
   for the default BIOBUZZ spec (a sweeper reaching past each end of a 15 × 17 chassis). A
   robot at x = −63 has a corner THROUGH the wall at −73.5, and three of the six first-run
   failures were poses written against the chassis.


## 2026-09-12 · no letters on the field · `PENDING`

- **Cells to look at**: `field-labelled@0` and the new **`hive-ground@0`**. Both at 1600px via
  `scratch/hires.cjs --scene <id>` (gitignored throwaway); `--labels 0` renders a labelled
  scene with the caption flag off, which is what a driver sees.
- **Files**: `drawField.ts` (the cell render), `scenesField.ts` (`field-labelled` + the new
  `hive-ground`), `scenes.ts` (one-line colour fix, below).
- **What changed** (field-plan §2.1 render / §2.5):
  1. **No letters or digits anywhere for elements.** The per-type tally (`3n 2p`) is gone. An
     up-CELL's contents are **one row of element-scale discs hugging the cell's OUTER (open)
     edge**, inside the box, oldest at the −x end, colour = type. When the row runs longer than
     the 20-in width the PITCH closes up and the discs overlap while the RADII stay true —
     shrinking them instead would make a NECTAR and a POLLEN the same size, which is the one
     distinction the row carries.
  2. **UP is a filled box, DOWN is a dashed outline with no fill.** The down cell hangs 25.5 in
     up and robots drive under it, so it is not a surface; the outline also lets the floor show
     through it.
  3. **The open face is marked by WEIGHT** — outer short edge thin, pivot-side edge heavy. That
     is a scoring rule in the picture: `hiveAccepts` only takes a shot arriving TOWARD the
     pivot, so an open face drawn at the wrong end is the rule drawn wrong. Neither mark fades
     with the swing: the box is open at the same end whichever way it points.
  4. **`tipping` is a cross-fade**, fill ↔ outline, over the swing. The denominator is
     **imported from `hive.ts`**, not copied — a renderer with its own copy of the swing length
     is a fade that ends at a different instant from the flip it is animating.
  5. `draw.ts` skipping `element`-state balls was **already landed** by biobuzz-field-staging
     (`isLoose`), so the double-draw in the last handoff is closed. Nothing needed here.
- **The up-cell fill is a 45% wash, not solid** (`CELL_FILL_A`). At full saturation a RED
  NECTAR in the RED cell was red on red and read as an empty ring — and the NECTAR count is
  what the tip table is indexed by, so it is the one thing in there that must not disappear.
  The heavy pivot-edge mark needed the same room.
- ⚠️ **Fixed in `scenes.ts`: `bbPollen` emitted `'green'`.** POLLEN is `'yellow'` (§9.8,
  `POLLEN_COLOR` in `spawn.ts`) and `draw.ts` batches only yellow/red/blue, so **every scene
  built from `bbPollen` was drawing no balls at all** — the whole POLLEN PHYSICS SET
  (`pile-*`, `corner-pile`, `wall-row-sweep`, `pin-wall`, `squeeze-2robots`, `settle-60`)
  rendered an empty field. A ball that is never drawn looks exactly like a scene that placed
  none, which is why it survived a green suite.
- ⚠️ **For biobuzz-field-staging — `bbWorld` leaves DANGLING element ids.**
  `createBiobuzzWorld` runs `stageBiobuzz`, which writes ids into every FLOWER stack and both
  up-CELLS; `bbWorld(seed, setups, pollen)` then REPLACES `world.balls` and leaves those ids
  pointing at elements that no longer exist. The readouts are a join, so it is normally
  invisible — but `bbPollen` numbers from 1 and so does the staging, so `hive-ground`'s three
  floor pollen ALIASED F1's staged stack and rendered outside the perimeter beside a flower.
  Worked around in the scene (it clears the references); the helper is yours.
- ⚠️ **For biobuzz-field-staging — `BB_TIP_SWING_S` is 0.8 in `hive.ts`, but the ruling is 4 s**
  (field-plan §2.1, owner 2026-09-12). `drawField.ts` imports your constant rather than
  carrying its own, so the cross-fade is correct whatever the value is — but the swing itself
  is five times too fast, and the contents spill at the halfway point of it.
- **Still APPROX**: the hive pair being centred on the field, the LOADING ZONE tape edge
  (±0.5 in, cosmetic), and `BB_TIP_POLLEN[0]` (an empty cell was never measured).

> **BRANCH CHANGE (2026-09-12):** the shared base is **`alpha`**. `biobuzz` was merged into
> `alpha` and deleted on origin. Wherever this file says branch `biobuzz`, read `alpha`: merge
> `alpha` before you commit, land into `alpha`, `alpha` deploys.

## 2026-09-12 · the four HIVE rulings, on an `alpha` base · `biobuzz-field-hive`

- **Files**: `hive.ts` (rewritten), `scripts/smoke-biobuzz/field.ts` (the `hive:` block). `flower.ts` unchanged. Nothing wired — `play.ts`, `step.ts`, `state.ts`, `config.ts` untouched. Field lane **168 checks, all pass**; `npm run build` green.
- **The rulings (field-plan §2.1), all four in**: swing `BB_TIP_SWING_S = 4.0` (a decision, not APPROX); `hiveAccepts` now takes a `vel: Vec3` and gates on APPROACH — the CELL is open at its outer end only, so `vel.y` must point at the pivot (`hiveApproachSign`: up=south takes vy > 0, up=north vy < 0); contents RELEASE at level (`BB_TIP_RELEASE_S` = swing/2) with a `released` latch, so `spilled` arrives two seconds BEFORE `tipped` and the 20 points; `spillPoses` returns `{pos, vel}` with vel outboard `BB_SPILL_SPEED` 40–60 in/s and `BB_SPILL_LATERAL` ±12 across, `vel.z` 0.
- ⚠️ **`BB_TIP_LOAD` and `BB_NECTAR_MASS` ARE GONE, superseded by the merge.** `config.ts` now carries the owner's MEASURED `BB_TIP_POLLEN` table, and the config comment is explicit that a see-saw is torque and packing, not weight — no linear mass model fits the measured rows. `hiveLoad` counts `{pollen, nectar}` and `hiveWillTip` is the table lookup; smoke asserts every row and its one-short neighbour, so reintroducing a mass model fails loudly. Consequence worth knowing: the staged cell (3 nectar) tips at **3 pollen**, reachable in AUTO.
- **REQUEST to `state.ts`** (Lane A's own file, deliberately not edited here): add `released: boolean` to `BbHiveState` and `released: false` to both hives in `emptyBiobuzzState()`. Until then `hive.ts` declares `HiveState extends BbHiveState` with `released` OPTIONAL, so a plain state hive still typechecks as an input; every hive the module returns sets it. With the field in `state.ts` that interface collapses to a re-export.
- **Still APPROX**: `BB_HIVE_ACCEPT_MARGIN` 2 in, the spill speed and lateral spread, and — in `flower.ts` — `BB_FLOWER_VOL_Z` [3.98, 21.5], `BB_FLOWER_FLOOR_Z` 0.43, `BB_FLOWER_ENTRY_MARGIN` 3 in. `BB_TIP_RELEASE_S` = swing/2 assumes a constant angular rate, which a damped swing is not; the error moves WHEN the spill lands, never whether it does. Fig 10-5 A–H are still RECONSTRUCTED from the §10.5.2 rule text, not read off the figure.

## 2026-09-12 · owner CAD + the six drawing rulings · `d6c0430`

- **Cells to look at**: `field-labelled@0` (annotated) and the SAME cell rendered with the
  caption flag off, which is what a driver sees. `scratch/hires.cjs --scene field-labelled
  --labels 0` renders the unannotated half at 1600px (the 420px gallery cell is too small to
  judge geometry); `scratch/` is gitignored throwaway.
- **Files**: `config.ts` (measured constants), `drawField.ts` (all six fixes),
  `scenesField.ts` (`field-labelled` only — it now stages REAL elements).
- **What changed in the drawing**, in the order it matters:
  1. **Both HIVE cells are the same size.** The see-saw is one rigid bar at 30°, so a plan view
     projects both ends by cos 30° and only `z` separates them (reference §2.2). The down cell
     is no longer drawn short; UP is said by brightness and by the counts alone, which is all a
     plan view honestly has. The assembly is 37.16 long, not 42.91.
  2. **The FLOWER foot is a 6 × 4.9 rectangle flush to the wall**, not a 2.6 disc.
  3. **The FLOWER readout is the STACK ITSELF**, outside the perimeter beside its flower, one
     disc per element in its own colour, bottom nearest the flower. The count badge is gone.
  4. **The up-CELL readout is PER TYPE** — POLLEN / RED NECTAR / BLUE NECTAR as separate pips.
  5. **AprilTag ids are behind the labels flag**, printed as a range and moved onto the cell's
     SHORT axis (they overflowed the 10.43-in cell and ran through the counts).
  6. **GARDENS and LOADING ZONES are tape strokes**, mat showing through. The garden strokes at
     `BB_TAPE_1`, not at the 2-in strip depth — at 2 the stroke repaints the solid bar.
- **No longer APPROX**: flower position and stand-off, flower footprint, frame bar x and foot
  y, cell centre / depth / assembly length, the cell accept window, and the tip table. They are
  owner CAD measurements dated 2026-09-12 and cited to reference §2.2 / §2.3 / §4.1. What is
  still APPROX: the hive pair being centred on the field, the LOADING ZONE tape edge (±0.5 in,
  cosmetic), and `BB_TIP_POLLEN[0]` (an empty cell was never measured).
- ⚠️ **BLOCKED ON `draw.ts` (biobuzz-field-staging owns it): parked elements are drawn twice.**
  `field-labelled` now stages REAL `Artifact`s in the `element` state, because both new
  readouts are a JOIN — an id with no element behind it draws nothing. `drawBiobuzzBalls`
  skips only `held`, so it also paints every `element`-state ball as a loose yellow POLLEN at
  its `pos`, which is the flower ring or the cell centre it is parked in. In the still that is
  a yellow disc inside each FLOWER ring and one over each up-cell's pips — it hides the RED
  NECTAR pip in red's cell. The fix is one line beside the `held` guard:
  `if (b.state.kind === 'element') continue;`. `spawn.ts` will hit this the moment it stages
  anything, so it is not specific to this scene.
- **Wanted from the shared core**: a per-artifact radius, so NECTAR is not simulated at POLLEN
  size (`docs/biobuzz/field-plan.md` §6 request 1).

## 2026-09-12 · geometry + the drawn field · `73372ad`

- **Cells to look at**: `field-labelled@0` (the whole field), `field-empty@0` (mat + grid only).
- **Files**: `src/games/biobuzz/config.ts` (`// ---- FIELD GEOMETRY (manual V1)` + `bbMirror`),
  `state.ts` (hives / flowers / nectarStock / nectarDue / leave / parkAuto / parkTele / `labels`,
  all DRAFT until the T0+2h sync), `drawField.ts`, `scenesField.ts` (`field-labelled` only).
- **APPROX in the drawing**: the hive body's 14-in width across, the 30° foreshortening of the
  down cell, the flower foot radius 2.6, the flower stand-off 3.0, the frame foot y ±19.5 and
  bar 1.5, and both tape widths' exact placement on the seams. Every one is tagged in config.ts;
  `grep APPROX src/games/biobuzz/config.ts` is the 09-14 tape-measure list.
- **Not real yet**: `field-labelled`'s cell contents and flower stacks are bare ids with no
  elements behind them (drawing input); `spawn.ts` places the real ones in a later pass.
- **Wanted from the shared core**: a per-artifact radius, so NECTAR is not simulated at POLLEN
  size (`docs/biobuzz/field-plan.md` §6 request 1).


---

## (hive lane, merged)

## 2026-09-12 — hive/flower logic ready for wiring (`biobuzz-field-hive`)

- **Landed**: `src/games/biobuzz/hive.ts` (hiveAccepts / hiveLoad / hiveStep / spillPoses, pure, rng as a parameter) and `flower.ts` (stack model, flowerFits/flowerCapacity, flowerAccepts top-only, flowerRetrieve pollen-only, flowerScore per §10.5.2), plus `hive:` / `flower:` checks in `scripts/smoke-biobuzz/field.ts`. Nothing wired: `play.ts`, `step.ts`, `state.ts`, `config.ts` untouched — wiring waits for the field-labelled verdict and the T0+2h sync.
- **APPROX, local to `hive.ts` until `config.ts` carries them**: `BB_TIP_LOAD` 6 pollen-equivalents (bounded below by the stable staged pose, 3 nectar ≈ 4.95), `BB_NECTAR_MASS` 1.65, `BB_TIP_SWING_S` 0.8 s, `BB_HIVE_ACCEPT_MARGIN` 2 in. Measure tip load and both masses on 09-14, then move the four consts into `config.ts` and delete them here (one import line each).
- **APPROX, local to `flower.ts`**: `BB_FLOWER_VOL_Z` [3.98, 21.5] (field-plan §1 name, not yet in config), `BB_FLOWER_FLOOR_Z` 0.43 (lower-ring top, where the bottom element rests), `BB_FLOWER_ENTRY_MARGIN` 3 in. Consequence worth a real-field check: a bottom POLLEN (top at 3.23) sits wholly in the retrieval opening and does NOT score; a bottom NECTAR (top at 4.03) is partially in by 0.05 in and does. Capacity by height: 8 pollen or 6 nectar.
- **Fig 10-5 A–H are RECONSTRUCTED from the §10.5.2 rule text**, not read off the figure (the manual is not in the repo). The table in `field.ts` encodes owner / owner points / bonus per case from the rules; re-label against the real figure when someone has the PDF open.
- **State shapes** `HiveState` / `FlowerState` are declared locally (field-plan §2); when `state.ts` gains `hives` / `flowers`, import from there and delete the local declarations. `BbElementKind` (`'pollen' | Alliance`) lives in `flower.ts` and is what `kindOf` / `massOf` callbacks in `play.ts` will resolve from the artifact.


---

## (staging lane, merged)

## 2026-09-12 · geometry + the drawn field · `73372ad`

- **Cells to look at**: `field-labelled@0` (the whole field), `field-empty@0` (mat + grid only).
- **Files**: `src/games/biobuzz/config.ts` (`// ---- FIELD GEOMETRY (manual V1)` + `bbMirror`),
  `state.ts` (hives / flowers / nectarStock / nectarDue / leave / parkAuto / parkTele / `labels`,
  all DRAFT until the T0+2h sync), `drawField.ts`, `scenesField.ts` (`field-labelled` only).
- **APPROX in the drawing**: the hive body's 14-in width across, the 30° foreshortening of the
  down cell, the flower foot radius 2.6, the flower stand-off 3.0, the frame foot y ±19.5 and
  bar 1.5, and both tape widths' exact placement on the seams. Every one is tagged in config.ts;
  `grep APPROX src/games/biobuzz/config.ts` is the 09-14 tape-measure list.
- **Not real yet**: `field-labelled`'s cell contents and flower stacks are bare ids with no
  elements behind them (drawing input); `spawn.ts` places the real ones in a later pass.
- **Wanted from the shared core**: a per-artifact radius, so NECTAR is not simulated at POLLEN
  size (`docs/biobuzz/field-plan.md` §6 request 1).

## 2026-09-12 · the staged field · `b03eef5` `bc733e1` `e4d7c47` `9b4efea` `ea9ab57` `a78d6b5`

- **Cells to look at**: `staging@0` (§10.3.1 Fig 10-2), `under-hive@0/@120`, `frame-push@0/@30/@60`.
- **Files**: `colliders.ts` (two FRAME base bars + four FLOWER feet, `BB_SOLID_COUNT`),
  `spawn.ts` (`stageBiobuzz` replaces `scatterPollen`; G304 start anchors), `elements.ts`
  (`scoreTargets` — both up-CELLs and the four FLOWER tops), `draw.ts` (colour per `b.color`,
  radius `b.r`, three batched paths), `scripts/smoke-biobuzz/field.ts`, three appended scenes.
- **The staging is 56 elements**: 16 POLLEN in the four FLOWERS, 8 in the two GARDENS, 16
  preloaded through the real capture path, 6 NECTAR in the two up-CELLS, 10 in human hands.
  Field lane 133 checks, all pass.
- **APPROX**: FLOWER feet are the circumscribing SQUARE of `BB_FLOWER_FOOT_R` (`StaticSpec` is
  rect-only); a stack's `z` is one POLLEN diameter per slot below `BB_FLOWER_TOP_Z`, pending
  `BB_FLOWER_VOL_Z`; `scoreTargets` accepts a CELL on `r = 8`, a disc for the 20 × 12 opening.
- **What the shots caught**: `bbSnapStart` was repairing every start pose, not just the two
  pre-V1 anchors, so a scene asking for the field centre spawned a robot on the perimeter
  (`a78d6b5`). Anchors only now; a custom pose is mirrored and perimeter-fitted, never dragged.
- **Wanted from the shared core**: a per-artifact radius — NECTAR is staged and drawn at
  `BB_NECTAR_R` but `solveArtifacts` takes one radius for the array, so it collides at POLLEN
  size. Same ask as the entry above (`field-plan.md` §6 request 1).

## 2026-09-12 · the state bag is filled · `a1613d9`

- **Cells to look at**: `staging@0` — the two up-CELLS now read `3` and all four FLOWERS badge
  `4`, because `drawField.ts` is reading state that staging finally writes.
- **Files**: `spawn.ts` (`stageBiobuzz` fills `flowers[i].stack`, `hives[a].contents`,
  `nectarStock[a]`; `cellNectar` reads `hives[a].up`), `elements.ts` (the `hives` cast is gone),
  `scripts/smoke-biobuzz/field.ts`. Field lane **143 checks, all pass**.
- **The bag is DERIVED from `world.balls`**, not written alongside it: the array stays the
  conservation authority and disagreement is unrepresentable at staging. Ten checks assert it
  both ways anyway — a runtime writer can still drift, and the capture path, the tip machine
  and G418.B retrieval all land on this state next.
- **ONE-LINE FOLLOW-UP, NOT MINE**: `bbWorld` in `scenes.ts` replaces `world.balls` wholesale
  after staging, so a scene with a POLLEN override keeps the staged bag — which is why
  `under-hive@0` draws four FLOWERS badged `4` under a `0 pollen` caption. `spawn.ts` now
  exports `bbIndexElements(world)` for it; the fix is calling it after `world.balls = pollen`.
- **Still wanted from the shared core**: the per-artifact radius. NECTAR is staged, drawn and
  now indexed at `BB_NECTAR_R`, and still collides at POLLEN size.

## 2026-09-12 · every target says which way it opens, and the anchors are legal

- **Base is `alpha` now**, not `biobuzz` — merged clean, nothing of mine conflicted (it was all
  already in alpha). Field lane **185 checks, all pass**; `npx tsc --noEmit` clean.
- **`ScoreTarget.mouth?: Vec2`** (`state.ts`) — unit vector OUT of the opening, filled in
  `scoreTargets`. Up-CELL: away from the HIVE pivot, so the same sign as the cell's own `pos.y`
  and correct through a TIP rather than hard-coded per alliance. FLOWERS: into the field —
  F1 `(1,0)`, F2 `(0,-1)`, F3 `(-1,0)`, F4 `(0,1)`. Optional because a target that is a plain
  volume has no such direction; absence means "no constraint", never a default direction.
- **`BB_START_POSES` moved out of the LOADING ZONE band** (`config.ts`): `(60, ±36)` →
  `(61.5, 36)` and `(61.5, −60)`. The old BOTTOM anchor sat inside `BB_LZ.blue` and both
  stopped 2 in short of the wall, so `spawn.ts` repaired them on every spawn — the anchor a
  builder places, the anchor the selector labels TOP/BOTTOM, and the pose the robot got were
  three different things. Spawning now moves them **0.010 in**, which is `WALL_SEAT`, the
  float-tangency guard. `bbSnapStart` stays: the seating is spec-dependent.
- **Checks**: each up-CELL mouth points away from its pivot, asserted STAGED and TIPPED; every
  mouth is a unit vector; each FLOWER's mouth steps away from the wall it stands against; each
  anchor spawns within 0.05 in of where it is written and is legal on the RAW anchor (own side,
  wall contact inside `START_TOUCH_TOL`, clear of its own zone) rather than on the repaired pose.
- **TWO COPIES OF ONE TABLE, still**: `drawField.ts` has a private `FIELD_SIDE` identical to the
  `FLOWER_MOUTH` map in `elements.ts`. Four entries, two chances to disagree about which way
  `rear` is — they should collapse to one exported constant. `drawField.ts` is not this lane's.
