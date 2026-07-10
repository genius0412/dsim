# HANDOFF — 2026-07-10 (realistic GATE: physical push-to-open arm + G417 touch-fix) — READ FIRST

> **GREEN (build + smoke both pass, 351 checks; GUI visually verified via Electron).**
> **SIM-CORE change** (`src/sim/goal.ts`, `world.ts`, `penalties.ts`, `types.ts`, `config.ts`)
> ⇒ a server that runs matches must **`flyctl deploy --remote-only`** to stay in sync.
> `slimWorld`/`unslimWorld` pass `goals` through whole, so the two new numeric `GoalState`
> fields ride snapshots fine, but a stale server would run the OLD gate model → redeploy.
> No `BALANCE_VERSION` bump (gate feel, not drivetrain calibration).

## What changed this session (read the manual → make the gate realistic)

Manual §9.8.3: the GATE is a ROBOT-activated **push-to-open** arm (~2 in horizontal
displacement), **"closed by gravity"**, that takes a **variable, non-instant** time to
close ("may or may not stay open"; not-closing-immediately is not a fault). Holds back
CLASSIFIED artifacts; OVERFLOW rides over the top. The old sim was a boolean that
snapped open/closed and opened when a robot merely LOITERED in the gate zone.

1. **Physical arm model** (`updateGates` in `src/sim/goal.ts`). New `GoalState.gatePos`
   (0 closed .. 1 fully lifted) + `gateVel`. A robot **actively pressing** the arm lifts
   it at `GATE_OPEN_RATE`; released, it **swings closed under gravity** (`GATE_GRAVITY`,
   starts slow → accelerates, terminal `GATE_CLOSE_MAX`) — not instant. **Flow holds it
   open**: a ball in the gateway suspends gravity (unchanged behavior, now physical).
   `gateOpen` (an artifact can pass) is DERIVED = `gatePos >= GATE_PASS_FRAC` — every old
   reader (rail flow, HUD chip, sfx edge, penalties culprit-clear) still works off it.
2. **Push-to-open detection fixed (was "extremely lenient")** (`pushingGate`, exported):
   opening now requires the robot to be **TOUCHING the arm** (`gateArmRect` — a tight
   contact footprint at the channel mouth, `GATE_ARM_REACH`/`_Y0`/`_Y1` in config, added
   to `field.ts`) **AND driving INTO it** — velocity toward the arm (`GATE_PUSH_MIN_SPEED`)
   OR a drive command toward it (`GATE_PUSH_MIN_CMD`, via `commandFieldDir` which mirrors
   robot.ts's stick→chassis transform — needed because a robot stalled against the
   classifier reads ~0 velocity yet is plainly leaning on the arm). Loitering in the gate
   zone no longer opens it. `updateGates(world, dt, actualCommands)` now takes commands.
3. **G417 penalty fixed (user: "touching the opponent gate, even if you don't open it,
   is still a MAJOR")** (`updateGateFouls` in `penalties.ts`). G417 now fires on
   `robotIntersectsRect(r, gateArmRect(a))` — CONTACT with the opponent's gate arm, **no
   push/open required** — deliberately DIFFERENT from `pushingGate`. Removed the old loose
   gate-ZONE + `GATE_LONG_SIDE_MARGIN` test (the const is gone). G418.B still bills the
   on-ramp balls at the G417 edge; culprit retention unchanged.
4. **Rendering** (`src/render/drawGoals.ts` `drawGateArm`, manual Figure 9-15): the gate is a
   **LEVER** that pivots at the classifier face and its paddle **sticks OUT toward the
   field** (the gate-zone side), **centered between the two gate-zone tape lines**. Closed
   it lies out at full `GATE_ARM_LEN` reach; as it opens it **swings UP**, drawn top-down by
   FORESHORTENING the paddle toward the pivot (`cos(gatePos·GATE_LIFT)`), steel→green, with a
   ghost of the closed reach. (Replaced an earlier wrong version that swept an arm across the
   channel toward −y.) Visually verified open + closed in the GUI.

Config: all new knobs in the `classifier / gate` block of `config.ts` (`GATE_OPEN_RATE`,
`GATE_GRAVITY`, `GATE_CLOSE_MAX`, `GATE_PASS_FRAC`, `GATE_OPEN_EPS`, `GATE_ARM_LEN`,
`GATE_LIFT`, `GATE_PUSH_MIN_SPEED`, `GATE_PUSH_MIN_CMD`, `GATE_ARM_REACH` (=5, matches the
lever reach), `GATE_ARM_Y0/Y1`). `GATE_LONG_SIDE_MARGIN` REMOVED.

## Smoke (`scripts/smoke.ts`) — new / changed gate cases

- New: loitering does NOT open · a real push eases the arm open (not instant) · sustained
  push fully opens · released arm swings closed gradually · falls fully closed · gatePos 0
  after a drain. Existing gate-open tests now DRIVE into the gate (`cmd({driveY:1})`,
  `fieldCentric=false`, heading toward the wall) instead of just standing in the zone.
- G417 test now asserts **touching (idle, no push) still fouls**; G418 test drives into
  the gate. G424/G425 exception tests unchanged and green.

## State / next

- Build green, 351 smoke checks green, gate arm verified in the Electron GUI (closed =
  gray hinged arm + ghost; open = green arm swung from the hinge; opens only on a push).
- **Not committed yet.** Uncommitted files: `config.ts`, `types.ts`, `sim/{goal,world,
  penalties,field}.ts`, `render/drawGoals.ts`, `scripts/smoke.ts`, `CLAUDE.md`.
- Gotcha: `commandFieldDir` reads `cmd.leftDrive/rightDrive` (required fields) for tank;
  ZERO_CMD in goal.ts includes them. `RobotCommand` has no optional drive fields.
- Deferred/untouched: the roadmap "penalty hitbox audit" could now also verify
  `gateArmRect` extents against the manual figure alongside the other zones.
