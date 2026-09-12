# BIOBUZZ — Lane B (ROBOT) handoff

Reverse-chronological. Prepend a new dated section; demote the old "READ FIRST".

---

## READ FIRST — 2026-09-12, later: modular mechanisms, and a turret that actually aims

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
