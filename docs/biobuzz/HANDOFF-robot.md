# BIOBUZZ — Lane B (ROBOT) handoff

Reverse-chronological. Prepend a new dated section; demote the old "READ FIRST".

---

## READ FIRST — 2026-09-12, evening: the mechanisms are WIRED, and the turret aims

**State: green.** `npm test` both suites ALL PASS (**665 checks**, up from 601), `npm run
build`, `npm run server:check`, `npm run uiaudit` at baseline, `npm run contrast` 221 pass,
`npm run costprobe` runs BIOBUZZ for the first time.

⚠️ **THE PREVIOUS SESSION’S WORK IS NOW COMMITTED** as `b25c85f` (it was sitting uncommitted in
the working tree). `origin/alpha` is merged in on top, cleanly — that is what brought Lane A’s
field and `ScoreTarget.mouth`.

### ⚠️⚠️ TWO MECHANISMS WERE WRITTEN AND NEITHER WAS EVER CALLED

This is the headline, it happened TWICE, and the second one I had personally declared fixed in
the section below this one.

| function | only callers before today | what that meant in a match |
|---|---|---|
| `bbSlewTurret` | none at all | every turret frozen at the bearing `spawn.ts` gave it (FIELD CENTRE), firing at **0° elevation** — flat, into the tile |
| `bbStepLift` | two checks in `scripts/smoke-biobuzz/robot.ts` | the carriage never left the deck. `drawRobot` has always drawn the mast from `r.bbLiftZ ?? 0`, and that `?? 0` was the whole story |

Both are now called from a new **stage 4b** in `updateBiobuzz` (`play.ts`), after the solve and
before the launch.

**THE LESSON, and it is why this is at the top:** a mechanism is not wired because its function
exists and its tests pass. `bbStepLift` had *two passing tests*. They called it DIRECTLY, so
they were green on code no match could reach. A direct-call test cannot tell “this function
works” from “this function runs”, and only the second was broken.

`scripts/smoke-biobuzz/robot.ts` now has a `wired:` block that drives the **world** — `run(w,
cmd({ bbLift: true }), 2.0)` through the real `biobuzzStep` — and asserts the mechanism MOVED.
**If you add a third mechanism, that is the check that matters.**

### Aiming, now that there is something to aim at

`scoreTargets()` returns real targets, so the aim path stopped being written-ahead shape and
became live code. Lane A’s message: *the shooting-side gate is field-owned, so B only needs to
aim at `mouth`.*

**`bbPickTarget` (`play.ts`) is new and it is the whole selection policy.** Two filters, both of
which only became *reachable* when `scoreTargets()` stopped returning `[]`:

1. ⚠️ **THE OPPONENT’S CELL MUST NOT BE AIMED AT.** It is on the list deliberately (a legal shot
   that scores nothing). The old code picked **nearest by raw distance**, and the geometry makes
   that fatal rather than academic: the two HIVES are **25.5 in apart** across field centre and
   their up-CELLS are staged tipped **opposite** ways, so a robot below centre has the
   opponent’s opening as its nearest AND its own as closed. Unfiltered, the aim assist held the
   robot pointed at the enemy HIVE and fed it, on the driver’s own fire button. Smoke proves the
   filter is non-vacuous by checking raw-nearest WOULD have picked it (it does, at 100+ poses on
   a grid sweep).
2. **A target is only a target from its open side** (`mouth`, a half-space test). An absent
   `mouth` is “no constraint”, never a default direction.

Whether a shot SCORES is still Lane A’s gate; this is only where a launcher POINTS.

**`bbTurretSolution` returns yaw + pitch + speed together** — the signature
`plan-mechanisms.md` said the §3 aim API had to grow. ⚠️ **`bbSolveShot` returns a MATCHED
(speed, angle) pair**, and the launch was flying the angle at a fixed `BB_DRUM_SPEED`. That is
not an approximation of the solution, it is a different shot. `bbAimPitch` is now a thin wrapper
(its doc also claimed “in degrees” and it always returned radians).

**`BB_TURRET_SPEED_MAX` = 260 in/s** (new, APPROX). Sized off the longest legal HIVE shot — far
corner (~66, 66) to the opposite up-CELL, d = 111.8 in, dh = 47.6 in, which the minimum-speed
solution takes at **255.5 in/s**. So today the thing that makes a turret miss is the SLEW, not
the range. Without a cap the turret reaches everything from everywhere and the pitch envelope is
decoration.

Measured end-to-end through the real pipeline:

| pose | target | range | speed | pitch | acquire | arrives |
|---|---|---|---|---|---|---|
| near own hive | `hive:blue` | 18.1 in | 194.9 in/s | 79.6° | 0.85 s | 59.5 in vs 59.5 in |
| far corner | `flower:3` | 37.2 in | 136.0 in/s | 52.2° | 0.55 s | 21.5 in vs 21.5 in |
| mid field | `hive:blue` | 29.5 in | 199.9 in/s | 74.1° | 0.78 s | 59.5 in vs 59.5 in |

Acquisition is 0.55–0.85 s and is **pitch-bound**, which is the axis deliberately made slower.

### ⚠️ NO TURRETLESS BUILD CAN REACH THE HIVE, AT ANY HOOD ANGLE

Nobody wrote this rule; it falls out of `BB_DRUM_SPEED` 175 against `BB_HIVE_OPEN_Z` 53.5. Best
apex over the whole 10–70° hood range is **23.0 in**, and even fired **straight up** it is
49.7 in — under the cell’s lower lip. A turretless launcher clears a FLOWER (21.5 in) and
nothing else.

That is a clean archetype split (turret → HIVE, turretless → FLOWERS) and it may well be the
right game. **It is now pinned in smoke** so that the day someone retunes the launch speed, this
is a decision somebody makes rather than a balance change nobody noticed. If the split is NOT
intended, the dial is `BB_DRUM_SPEED`.

### The stat chips no longer advertise Chain Reaction

The bug the section below left open (a BIOBUZZ builder showing a **“Claw arm · CATALYST”** chip,
off a `catalystType` the spec does not even carry) is fixed with a new **`GameModule.statTiles`
slot** — a sibling of `labels`, not an extension of it, because `labels.configSummary` is a
*sentence* for other screens and this is the builder hero’s *tile grid*. DECODE’s and CR’s inline
arms are byte-identical; the diff removes only the ternary head.

All four loadouts read correctly (`Drum shooter / launcher / FRONT · 40° hood`, `No lift / lift`,
…). Both tiles always render: an absent mechanism is a fact about the robot, and a dropped tile
is indistinguishable from a page that failed to draw one. Smoke sweeps the four loadouts + the
default + all four StarterBots for FOREIGN vocabulary, banning CR’s and DECODE’s words
**including every value read out of `CHAIN_CATALYST_LABELS` itself**, so a rename there cannot
void the check.

### `bbLift` / `bbPlace` reach a real keyboard

The cross-lane request from the section below is **landed**, and it needed more than the two
protocol bits it asked for:

- `src/net/protocol.ts` — `BTN_BBLIFT` 32 / `BTN_BBPLACE` 64, quantize + dequantize.
- `src/input/{bindings,gamepad,input}.ts` + `ControlsSection.tsx` — the actions, defaults and
  rebinding rows. **`x` = raise slide (held), `z` = place.** Pad: RS (11) and D-UP (12), the only
  free indices; RS takes the held action because it is the one free button a thumb can press
  without letting go of a stick.
- ⚠️ **`server/room.ts` `countParticipation` — FIXED, AND IT NEEDS A DEPLOY.** The “was a person
  driving” test enumerates command buttons by hand, so a BIOBUZZ driver working only the lift and
  place read as **idle** and lost participation credit. Server change: `./scripts/fly-deploy.sh`.
- ⚠️ **THE REPLAY BUTTON FIELD IS NEARLY FULL.** `src/sim/replay.ts` packs `q.buttons & 0xff`.
  Bits 32 and 64 ride through fine; **bit 128 is the last one that fits**, so a ninth button needs
  a `REPLAY_FORMAT` bump.

⚠️ **`bbPlace` IS WIRED END TO END AND STILL DOES NOTHING**, because its consumer is Lane A’s
`actOnElement`, which is still `return false`. Key → command → protocol → sim, terminating in a
stub. That is deliberate, and the day placement lands nothing else needs doing — but it IS a live
rebindable control with no effect, so decide whether that ships.

### costprobe knows about BIOBUZZ now

`scripts/costprobe.ts` grew `biobuzz-solo` and `biobuzz-2v2`, off the real `step()` and the real
codec, plus a **per-tick `RobotState` field** table that re-serializes the same frames with named
keys deleted (one variable, no confound). DECODE/CR columns verified byte-identical to the
pre-change script.

| scenario | B/snap | wire/client | cores/room |
|---|---|---|---|
| DECODE 2v2 | 10,862 | 35.4 KiB/s | 0.038 |
| CR 2v2 | 8,195 | 27.7 KiB/s | 0.023 |
| **BIOBUZZ 2v2** | **6,654** | **32.0 KiB/s** | 0.026 |

**BIOBUZZ is the cheapest of the three**, with 56 pollen against CR’s ~300. `bbTurretPitch` +
`bbLiftZ` together cost **+218 B/snap in a 2v2 (3.3% of the frame), +1.79 KiB/s per client**.
BIOBUZZ is deliberately NOT in the extrapolation block (`scored: false`, alpha-only ⇒ no
population to extrapolate from). The probe measured `bbLiftZ` at **0 B — “declared but NEVER
WRITTEN”**, which is how the dead-lift bug above was found.

### ⚠️ CROSS-LANE EDITS MADE HERE — revert these if the call was wrong

`docs/biobuzz-contract.md` §1 assigns these elsewhere. Each was edited because the feature is
unreachable without it, and each follows the precedent the `presets` slot set:

| file | owner | why |
|---|---|---|
| `src/net/protocol.ts` | integration | **explicitly sanctioned** — “a new `RobotCommand` button needs a `BTN_*` bit and a `localizeCommand` line” |
| `src/games/biobuzz/play.ts` | **A** | stage 4b + `bbPickTarget`. `bbAimAssist` already lived here, so the aim hook has precedent |
| `src/games/biobuzz/config.ts` | **A** | `BB_TURRET_SPEED_MAX`, beside the launcher constants (`BB_TURRET_SLEW`, `BB_DRUM_SPEED`, `BB_HOOD_*`) already there |
| `src/games/module.ts`, `src/ui/Menu.tsx` | integration | the `statTiles` slot + its consumer |
| `server/room.ts` | integration | the participation fix above |

### Still owed

- **A gallery re-shoot**, now doubly owed: the 35° hood default changed every firing scene, and a
  turret that actually slews changes every archetype sheet. A new `turret-acquire` scene is
  registered for exactly this — it parks a BLUE robot at (−10, −25), where the opponent’s CELL is
  the nearest opening, so a regressed alliance filter is visible without measuring anything.
- **`npm run shiftaudit`** — still not run for the new Builder blocks. Needs a build + `npx vite
  preview --port 4173`.
- **The saved-robots list has the SAME bug the stat chips had.** `Menu.tsx`’s `.om` detail line is
  another `isDecode ? … : …`, so a saved BIOBUZZ robot is described with `CHAIN_INTAKE_LABELS` /
  `CHAIN_MODE_LABELS` — a launcher-less build prints as a turret it does not have. It needs **no
  new slot**: `labels.configSummary` exists, BIOBUZZ fills it, `robotLabels.buildSummary` consumes
  it. Spawned as `task_04c4397a`.
- **Mobile**: neither new action is reachable on touch. Needs a `GameModule.mobileButtons` entry
  and a `GameSettings.mobileLayout` key.
- **`src/ui/styles.css`** throws 65 `impeccable` design-hook findings. It is the LEGACY in-match
  HUD that predates `DESIGN.md` and is re-tinted through an alias bridge `shell.css` documents;
  the repo’s real UI gate is `docs/ui-standard.md` + the `uiaudit` ratchet, which is green.
  Untouched all session. Owner’s call whether to scope it out of design review or migrate it.

---

## 2026-09-12, later: modular mechanisms, and a turret that actually aims

**State: green.** `npm test` both suites ALL PASS (**601 checks**, up from 568), `npm run
build`, `server:check`, `uiaudit` at baseline, `contrast` 221 pass. Verified live at
`/biobuzz` on the alpha channel.

⚠️ **BRANCH SWITCH.** `biobuzz` was merged into `alpha` and **deleted on origin** (owner,
2026-09-12). `alpha` is the single BIOBUZZ base and the deploy branch; this lane branch is
merged (not rebased) up to `c655fa5`. Anywhere a doc says branch `biobuzz`, read `alpha`. The
GAME is still BIOBUZZ, so `src/games/biobuzz/`, `scripts/smoke-biobuzz/` and `npm run test:bb`
are unchanged.

### What landed

A robot may now carry a **launcher**, a **vertical extension slide**, both, or **neither** —
one container field, two independently-optional named slots:

```ts
RobotSpec.bbMech?: { launcher: BbLauncherSpec | null; lift: BbLiftSpec | null }
```

Design chosen by a four-architecture judge panel; `docs/biobuzz/plan-mechanisms.md` is the
plan, and the settled calls are recorded there (35° hood default, the 5th sequential launcher
kind deferred, a dedicated `bbPlace` button, `RobotState.bb*` on `RobotState`).

| file | what |
|---|---|
| `mechs.ts` **(new leaf)** | vocabulary, migration, `bbResolveLiftMount` clash resolution |
| `types.ts` | `bbMech`; `bbTurretPitch`/`bbLiftZ` state; `bbLift`/`bbPlace` commands |
| `config.ts` | `BB_R105_HEIGHT_CAP`, the lift + hood/pitch constants, `BB_DEG` |
| `coerce.ts` | `coerceBbMech` — migrate, fold, clamp, resolve the clash, mirror out |
| `src/sim/spawn.ts` | **the carry-across** |
| `robot.ts` | `bbSolveShot(d, dh)`, `bbAimPitch`, `bbSlewTurret`, the whole lift |
| `Builder.tsx`, `drawRobot.ts`, `RobotPreview.tsx`, `parts.ts`, `presets.ts`, `labels.ts` | the surfaces |

### ⚠️ THE CONTAINER IS AUTHORITATIVE — and it briefly was not

`bbMech === undefined` means "legacy spec, migrate from `scoreMode`"; `bbMech.launcher ===
null` means "this robot genuinely has no launcher". They must stay distinguishable, because
`src/sim/spawn.ts` writes `out.scoreMode` **unconditionally** and defaults it to a turret — so
a launcher-less build spelled as an absent `scoreMode` grows a **phantom turret** on the very
next coercion. Smoke asserts it survives two passes.

The first cut had `coerceBbMech` reading `kind`/`mount` off the flat fields, which quietly made
THEM the source of truth: a caller patching only `bbMech` — the obvious thing, and what the
builder tried first — was silently reverted, with nothing failing. The container is now folded
on its own values and mirrored OUT.

### ⚠️ THREE BUGS FIXED THAT WERE ALREADY IN THE TREE

1. **`BB_LAUNCH_Z0` was a height used as a vertical velocity** in all three launch paths.
   Every POLLEN left at 10 in/s and apexed **0.13 in** — there was no arc in this game at all.
   Velocity now decomposes from a real elevation; a 35° hood gives a 23.1 in apex, 86.8 in range.
2. **`BB_TURRET_SLEW` had no consumer.** `turretHeading` was written once at `spawn.ts:204`
   and frozen for the match. The slew loop the comments described was never written; it is
   `bbSlewTurret` now, and pitch eases the same way.
3. **`BB_LIFT_MASS_FLOOR` and the storage/mass archetype reads** keyed off `spec.scoreMode`,
   which a launcher-less build still carries as a mirror — so Studica would have been billed
   for a shooter it does not have. Both read through `bbLauncherOf` now.

### ⚠️ `d` IS FOR DETERMINISTIC, NOT DEGREES

`dsin`/`dcos`/`datan2` are radians. I wrote the pitch constants in degrees, fed them to
`dcos`, and got ~1° elevations for everything. **The tests did not catch it** — the scene
checks assert hashes are *deterministic*, not that they match a golden — it took an arithmetic
check against real target heights. Pitch is radians throughout; the hood stays degrees as a
human-facing spec dial (CR's `catapultYaw` precedent) with one `BB_DEG` conversion at the
boundary.

### Why a lift and a launcher are different mechanisms

HIVE up-CELL opening **53.5–65.6 in**, R105 caps a robot at **29 in**, FLOWER top ring
**21.5 in**. So the HIVE is launch-only and the FLOWER is placeable — and smoke proves the lift
can never seat at a CELL from that arithmetic alone, with no hand-written rule.

### Wire cost (costprobe owed, and it has a gap)

`npm run costprobe` has **no BIOBUZZ scenario** — it models DECODE and CR only, so it cannot
answer this. Measured directly instead: **+152 B/snapshot** for a 2v2 of fully-equipped robots
(38 B/robot for both fields), +3.3% on the BIOBUZZ baseline of 4,582 B, and only for robots
carrying the hardware. Adding a BIOBUZZ scenario to costprobe is a real follow-up.

### Still owed

- **A gallery re-shoot.** The 35° default changes every firing scene's appearance. Contract §7
  wants the PNGs read by the chat that made the change; not done yet.
- **`npm run shiftaudit`** for the new Builder blocks (needs a build + preview server).
- **The protocol bits.** `bbLift` and `bbPlace` need `BTN_*` entries and `localizeCommand`
  lines — see the cross-lane requests below. Until then both commands are unreachable from a
  real keyboard and only smoke drives them.

---

## 2026-09-12, kickoff day: the four StarterBots are preset robots

**State: green.** `npm run build`, `npm run server:check`, `npm run uiaudit` (at baseline),
`npm run contrast` (221 pass) and `npm test` all pass. The branch was fast-forwarded to
`origin/biobuzz` first (8 commits, 0 conflicts — `biobuzz-robot` was a strict ancestor).

### What landed

**The four manufacturer StarterBots are selectable preset robots**, and the preset section is
reachable from BIOBUZZ at all for the first time.

- `src/games/biobuzz/presets.ts` (NEW) — the four StarterBots as `RobotSpec` builds, the
  BIOBUZZ preset match test, and the card's own detail lines. Every entry cites its source
  document *and that document's date*.
- `src/games/module.ts` — a new optional `presets` slot on `GameModule`
  (`{ list, matches, lines, realCount }`).
- `src/games/biobuzz/index.ts` — fills it.
- `src/ui/Menu.tsx` — consumes it as `mod.presets ? <slot> : <existing branch, unchanged>`.
- `src/ui/labelData.ts` (NEW) + `src/ui/robotLabels.ts` — `DRIVETRAIN_LABELS` / `INTAKE_SHORT`
  extracted to a leaf and re-exported (see the cycle gotcha below).
- `src/ui/shell.css` — `.ds-opt.real`, the inset accent edge marking a documented robot.
- `scripts/smoke-biobuzz/robot.ts` — preset checks.

### THE BUG THIS FIXED, which was invisible

`Menu.tsx` picked the preset list with `const presets = isDecode ? ROBOT_PRESETS :
CHAIN_PRESETS`, and the card body under each name with a second two-valued branch. BIOBUZZ did
not fall through to "no presets" — **it fell into the CHAIN arm and was offered Chain
Reaction's nine robots, described in Chain Reaction's words.** `BB_PRESETS` had no reader
except `BB_DEFAULT_SPEC`. Nothing looked broken, because nine plausible cards rendered.

This is the exact failure mode `docs/biobuzz-contract.md` and the module-slot design predict
for a two-valued branch, and it is worth remembering that the *symptom* was a populated,
confident-looking UI.

### ⚠️ THE ARCHETYPE SET IS THE WRONG SHAPE FOR THIS GAME'S REAL ROBOTS

`BB_SCORE_MODES` is `turret | twinturret | drum | dumper`. **None of the four StarterBots is
turreted**, and three of the four do not fit any of the four:

| bot | what it has | modelled as | why that is wrong |
|---|---|---|---|
| goBILDA | chassis-fixed single-barrel flywheel, sequential | `drum` | a drum streams a PARALLEL LINE across an edge |
| REV | the same, one flywheel + a servo feed gate | `drum` | same |
| AndyMark | an elastic **catapult** with an adjustable hood | `dumper` | a dumper heaves the WHOLE hopper at once |
| Studica | **no launcher published at all** | `dumper` | invented outright — see below |

The fix is the modular mechanism work, not a better guess. Each preset entry carries a
`WANTS:` comment naming the mechanism it actually needs.

### ⚠️ WHAT IS SOURCED AND WHAT IS NOT

**No manufacturer publishes a footprint, a height, or a weight.** Not one, in the build guide,
the product page or the resource guide. Drivetrain topology, motors and wheel diameters are
all real; every dimension and every mass is `APPROX`. The honest description of these cards is
**manufacturer-INSPIRED**, not manufacturer-accurate.

Three places the sim cannot represent the real robot, all commented at the entry:

1. **Studica has no launcher.** Its only published build is the PRE-KICKOFF guide (rev 0.1,
   2026-05-04), which Studica itself labels "not a guide to build an official competition
   robot". It is a drivetrain and an intake. The `dumper` on that card is a placeholder the
   spec forces, not a mechanism the robot has.
2. **Studica's real `driveRpm` is 114 and the floor is 200.** 2× Maverick 50.9:1 at 119.84 rpm
   on 100 mm wheels is 24.7 in/s; `DRIVETRAIN_LIMITS.tank.minRpm` is 200. The card drives
   ~1.75× faster than the real robot. Widening the floor is a shared-model change.
3. **REV's chassis is 16.1″ and the sim's ceiling is 15″** (`INTAKE_PRESETS.sloped.maxLength`).
   Modelled an inch short.

### `driveRpm` IS NOT THE MANUFACTURER'S RPM — convert it

`SPEED_PER_RPM` is normalised to a **104 mm reference wheel**. None of these robots runs one,
so entering a published RPM directly overstates every one of them. Each entry shows its
arithmetic:

```
free speed (in/s) = π · (wheel_mm / 25.4) · motor_rpm / 60
driveRpm          = free speed / (SPEED_PER_RPM · speedMult)
```

goBILDA 312 rpm/96 mm → **286** · REV 318/90 → **273** · AndyMark 312/101.6 → **303**
(the 13.7:1 option would be ≈425) · Studica 120/100 → 114, clamped to **200**.

### GOTCHA: the preset list re-created an import cycle, and it failed at BOOT

`presets.ts` first imported `bbCoerceSpec` from `robotConfig.ts` and `DRIVETRAIN_LABELS` from
`ui/robotLabels.ts`. Both reach the game registry — `robotConfig` → `sim/spawn`, and
`robotLabels` → `moduleFor` → every game module → `biobuzz/index.ts` → back to `presets.ts`.
Because the module object is read at evaluation time, the result was

```
ReferenceError: Cannot access 'BB_PRESET_LIST' before initialization
```

at import, not a lint warning. Same class as the one `src/sim/specDefaults.ts` documents and
the one the "add it as a GETTER" note in CLAUDE.md warns about. Fixed by importing the LEAF
`coerceBiobuzzSpec` from `./coerce` and by extracting the two pure label maps into the new leaf
`src/ui/labelData.ts`. **If you add an import to `presets.ts`, check it is a leaf.**

### A PRESET IS DEFINED AS ITS OWN COERCED FORM

`BB_STARTER_BOTS` maps every build through `coerceBiobuzzSpec`. A card must be a fixed point of
the coercer or it can never read as selected — the builder compares against a spec that has
been through `coerceSpec`, so a card carrying anything the coercer would move is a card the
player clicks and nothing lights up. Two things this catches that a literal cannot: the legacy
`intakeSide` / `shooterRear` mirrors (written by the coercer, declared by no literal), and any
dial that drifts out of range when a shared constant moves. Both halves are smoke-checked.

### THE HOPPER CEILING IS NOW 4 (G407) — a gameplay change, taken from Lane A's §7

`BB_STORAGE_MAX` **24 → 4**, `BB_STORAGE_DEFAULT` **8 → 4**. Requested by Lane A in
`docs/biobuzz/field-plan.md` §7 ("Lane B's `BB_STORAGE_MAX` 24 / default 8 are wrong by the
manual") and it is right: G407 says a ROBOT may not CONTROL more than 4 SCORING ELEMENTS, and a
hopper holding five is a robot controlling five. §10.3.1 pre-loads exactly 4 per ROBOT, so a
legal robot starts full. Both StarterBots that advertise a capacity say "up to four POLLEN".

This is no longer `APPROX`. The old 24 came from a one-layer volume model — a good answer to
"how much would physically fit", which is not the question the game asks.

**The volume law survives underneath it.** `bbStorageMax` still runs the footprint × archetype
× mount maths; the rule simply binds first for every buildable chassis. Keeping both layers
means the archetype differences stay written down instead of deleted, and the true statement
stays true: a robot holds the SMALLER of what fits and what is legal.

⚠️ **Consequences, all handled but worth knowing:**
- The storage slider is now a **1–4 dial** and every archetype reaches the same ceiling, so
  hopper size no longer distinguishes builds. Cadence, range and aiming do.
- **Every blurb that sold a build on capacity was made false and has been rewritten** —
  `BB_MODE_BLURBS` (three of four said "smallest hopper" / "whole hopper at once") and
  `BB_INTAKE_MOUNT_BLURBS` ("Least storage" / "Less storage"). The demo preset comments in
  `config.ts` too. Verified live: all eight cards read "4 pollen".
- Existing saved BIOBUZZ robots with `ballStorage` 8–24 clamp down to 4 on next load. Correct,
  but it is a visible change to somebody's saved robot.
- The `Hauler` demo was sold on "the biggest hopper in the set" and no longer has one; its
  comment now sells the cycle SHAPE (a straight line, no turns), which is still true.

---

## Requests for the integration chat

Per `docs/biobuzz-contract.md` §1 these files are integration-owned. They are **already
edited on this branch** because the feature is unreachable without them; if that is the wrong
call, these are the three to revert and re-land through integration.

0. **`src/net/protocol.ts`** — TWO new `BTN_*` bits, `bbLift` (held: raise the carriage) and
   `bbPlace` (edge: place into a FLOWER), plus their `localizeCommand` lines. This is the one
   sanctioned cross-lane edit and it is the only thing standing between the lift and a real
   keyboard — the mechanism is built and smoke-driven but no driver can reach it. Neither is an
   analog axis, deliberately, so **no `REPLAY_FORMAT` bump and no `trackStride` change** are
   needed.
1. **`src/games/module.ts`** — add the optional `presets` slot. Purely additive; a game that
   does not fill it is routed through the unchanged two-valued branch.
2. **`src/ui/Menu.tsx`** — consume it, in the established `mod.X ? <slot> : <existing>` form.
   Also fixes the latent bug above for any future third game.
3. **`src/ui/robotLabels.ts` + `src/ui/labelData.ts`** — move two pure data maps to a leaf and
   re-export. No behaviour change; removes a cycle any game module would otherwise hit.

Not yet needed, but coming with the modular mechanism work: a `BTN_*` protocol bit if a
mechanism gains a button, and a `REPLAY_FORMAT` bump + `trackStride` change if a turret ever
gains a **driver-controlled analog axis** (an auto-aiming turret needs neither).

## Requests for Lane A

- **`scoreTargets()` is still `[]`** and it is the blocker for any aimed launcher. The
  geometry to populate it already exists on `origin/biobuzz-field` (`BB_HIVE_OPEN_Z`,
  `BB_HIVE_CELL_DY`, `BB_CELL_OPEN`, `BB_FLOWER_TOP_Z`, `BB_FLOWER_OPEN_R`) but is unmerged.
- **`BB_POLLEN_R` is 1.5 here and 1.4 on `biobuzz-field`.** The manual says POLLEN is 2.8″.
  Lane A's value is right; it feeds `bbStorageMax` and `BB_LAUNCH_PLATE_GAP`, so hopper
  capacity and the launcher barrel both move when it merges.

### KNOWN, NOT FIXED: the stat chips have the SAME bug the presets had

`Menu.tsx`'s robot summary chips are a second `isDecode ? … : …`, and BIOBUZZ falls into the
CR arm — so the BIOBUZZ builder shows a **"Claw arm · CATALYST"** chip. That is Chain
Reaction's mechanism, and `coerceBiobuzzSpec` DELETES `catalystType`, so the chip is rendering
`CHAIN_CATALYST_LABELS[CHAIN_DEFAULT_CATALYST]` — a default label for a field the spec does not
have. Verified live at `/biobuzz` on the alpha channel.

Deliberately left for the modular-mechanism work rather than patched now: those chips are a
summary OF the mechanism loadout, so the composable-mechanism change rewrites what they should
say. Fixing it first would be fixing it twice. The fix wants a slot (or an extension of
`labels`), not a third arm on the branch — same reasoning as `presets`.

## Observations for the owner (not fixed here)

- **`BB_LAUNCH_Z0` is used as BOTH a height and a vertical velocity.** `config.ts` documents it
  as "launch height (in)" and `elements.ts:134` uses it that way (`held.z = BB_LAUNCH_Z0`), but
  all three launch paths in `robot.ts` also pass it inside the velocity `Vec3`. So every POLLEN
  leaves at vz = 10 in/s and apexes 0.13″. There is effectively no arc in this game today. It
  has to be split before any ballistic solve is built on it.
- **`BB_TURRET_SLEW` has zero consumers.** `turretHeading` is written once at `spawn.ts:204`,
  pointed at field centre, and frozen for the match; nothing slews it. The comment at
  `robot.ts:252` describing a finite slew rate describes code that was never written. The
  turret is currently a drawn cosmetic.
- **The element model cannot express BIOBUZZ's elements.** `ArtifactColor` is
  `'purple' | 'green'` (DECODE's), every BIOBUZZ pollen spawns `'green'`, `hopper` is
  `ArtifactColor[]`, and `solveArtifacts` takes one scalar radius per call — so 40 × 2.8″
  POLLEN and 16 × 3.6″ NECTAR cannot coexist without a shared-solver change. POLLEN-only work
  is unaffected; NECTAR, FLOWER ownership and G408 are all blocked on it.
- **Several file headers are now stale.** `robot.ts`, `elements.ts`, `state.ts`, `sim.ts` and
  `hud.ts` all say Sections 9/10 are Kickoff placeholders. Manual **V1** shipped this morning
  (173 pages, `scratch/manual/`), and roughly half the `APPROX` list in `config.ts` is now
  answerable from it.
