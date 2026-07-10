# HANDOFF — 2026-07-10 (GATE lever reshape + activation, field-render cleanups) — READ FIRST

> **GREEN (build + smoke both pass, 359 checks).**
> **SIM-CORE change** (`src/sim/goal.ts`, `physicsEngine.ts`, `types.ts`, `spawn.ts`,
> `config.ts`) ⇒ a server running matches must **`flyctl deploy --remote-only`** to stay
> in sync. `slimWorld`/`unslimWorld` pass `goals` through whole, so the new
> `GoalState.gateLatch` numeric field rides snapshots fine, but a stale server would run
> the OLD gate model → redeploy. No `BALANCE_VERSION` bump (gate feel + render, not
> drivetrain/scoring calibration).

## What shipped this session

Reshaped the GATE and reworked how it opens/holds/closes, plus a few field-render cleanups.
NOTE: an experimental "classifier outflow jam / robot-catches-the-drain" feature was
prototyped and then **REVERTED at the user's request** — only the gate SHAPE + ACTIVATION
changes were kept. `updateRails` is back at its pre-session behavior (balls drain off the
lip normally). Do not reintroduce `outflowFloor`/`outflowJammed`/`GATE_JAM_*`/`GATE_CATCH_*`.

1. **Gate geometry — class-1 LEVER** (`drawGateArm` in `render/drawGoals.ts`;
   `GATE_ARM_LONG`/`GATE_ARM_SHORT`/`GATE_LIFT` in config). Hinges at the CLASSIFIER EDGE
   where the gate-zone tape starts (|x| = `FIELD_HALF − CLASSIFIER_W`): a SHORT handle pokes
   into the gate zone (pushable), a LONG paddle lies across the channel to the WALL edge
   covering the artifacts; both foreshorten toward the pivot as they lift. Drawn thinner
   (lineWidth 2.0, square cap).

2. **Latch + touch-hold** (`updateGates`, new `GoalState.gateLatch`). A push sets
   `gateLatch = GATE_OPEN_LATCH_S` (0.5 s) — a TAP fully opens it, no holding. RESTING
   against an already-open gate re-arms the latch (touch-hold). Untouched → latch decays →
   gravity swings it shut, sped up (`GATE_GRAVITY` 22 / `GATE_CLOSE_MAX` 9). Flow-hold
   (`ballInGateway`) keeps an OPEN gate open during a drain but does NOT lift it, so a ball
   reaching an almost-closed gate can't reopen it.

3. **One-directional opening** (`pushingGate`): only a STRAIGHT push toward the wall opens
   it (`velToward = r.vel.x · goalSide`, or the drive-command x-component). Driving SIDEWAYS
   along the wall does NOT open it.

4. **Physical one-way door** (`buildGateArms` in `physicsEngine.ts`, robot solve only,
   `GATE_ARM_THICK`): the SHORT handle is a solid robot collider (retracts as the gate opens)
   so a robot can't strafe THROUGH the closed lever; a straight push lifts it and the robot
   glides in. Long paddle needs no collider (over the already-solid classifier).

5. **Tighter activation rect** (`gateArmRect`, `GATE_ARM_REACH` 5→3, `GATE_ARM_Y0/Y1`
   −1..6 → −2..3, centered on `GATE_TAPE_Y`).

6. **Field-render cleanups** (`render/drawField.ts`, `drawBalls.ts`):
   - Secret-tunnel strip: only its FIELD-SIDE long edge is stroked (its short edges sat on
     the classifier box border — which must win — and its other long edge sat on the
     perimeter wall).
   - Loading zone: only the two INTERIOR edges, drawn as ONE connected L so the corner joins
     cleanly (the other two sat on the perimeter walls).
   - Balls now draw z-sorted (low→high), so OVERFLOW artifacts (`OVERFLOW_Z` 13.5) render
     ABOVE the retained/classified column (`RAMP_SURFACE_Z` 10), not below.

## State / next steps

- `npm test` (359) + `npm run build` both GREEN. Committed + pushed on `alpha`.
- Not visually verified in the Electron GUI this session — worth a `/verify` pass to eyeball
  the lever + the render cleanups (classifier box border intact for both alliances, loading
  zone L, overflow balls on top).
- If deploying the match server: commit on `alpha` → `flyctl deploy --remote-only` → verify
  `/health` (server imports `src/sim`, so the gate model must match clients).

## Gotchas

- `GATE_OPEN_EPS` was removed (the old flow-hold used it; the new one keys on `goal.gateOpen`
  = `gatePos >= GATE_PASS_FRAC`, which is what gives "almost-closed can't reopen").
- The physical-door collider is built from live `gatePos` each step (fresh Rapier world),
  one tick behind `updateGates` — deterministic. The `pressIntoGate` smoke test pins
  `gatePos` each tick so the collider it exercises is deterministic.
- `pushingGate`'s command path (not just velocity) is why a robot stalled against the closed
  handle collider still opens it: the collider kills inward velocity, but the drive command
  toward the wall still trips `GATE_PUSH_MIN_CMD`.
