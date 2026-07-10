# HANDOFF — 2026-07-10 (gate "easier to open" — ram-scaled + no jolt) — READ FIRST

> **GREEN — `npm run build` + `npm test` (all checks, incl. the gate suite) pass.**
> **No server/DB change; no `BALANCE_VERSION` bump.** This is a sim-tuning + physics
> change in `src/sim` (gate arm), so it IS a protocol-relevant sim change for
> multiplayer determinism — but it's server-authoritative and identical everywhere, so
> a redeploy is only needed if you want the live server running the new gate feel
> (`flyctl deploy --remote-only`). Solo/local is already live via the dev server.

## What shipped this session — the gate opens easier

User feedback: "when driving in to open the gate, the hitbox makes the drivetrain
suddenly stop for a split second — make it easier to open", then "it should open faster
based on how hard I'm ramming it, and I still don't like the 1-tick stop."

Two coupled changes, both in the gate arm model:

1. **Ram-speed-scaled lift.** The arm now lifts at `gateLiftRate(ramSpeed) =
   GATE_OPEN_RATE(10) + GATE_OPEN_RATE_SPEED(1.2)·ramSpeed`, capped at
   `GATE_OPEN_RATE_MAX(66)` — a hard ram (~≥47 in/s) opens it in ~one tick; a gentle
   lean still eases it open over several ticks. `GATE_OPEN_HOLD` is now **0** (was 0.02)
   so the lift begins on the contact tick (the `pushingGate` straight-ram gate already
   prevents accidental opens, so no debounce is needed).

2. **No 1-tick jolt (collider anticipation).** `buildGateArms` (physicsEngine, inside
   `solveRobots`) runs one step BEFORE `updateGates` mutates `gatePos`, so it used to
   build the handle collider from last tick's still-closed `gatePos` and hard-stop a
   robot that was, that very tick, ramming the gate open. Now `gateColliderPos(world,
   dt, cmds, a)` (goal.ts) anticipates the exact lift `updateGates` is about to apply,
   and `world.ts` passes a `Record<Alliance,number>` into `solveRobots`→`buildGateArms`,
   so the handle retracts on the SAME tick the push lands. Harder ram ⇒ bigger first-tick
   retract ⇒ you glide through instead of bouncing off.

### Files touched
- `src/config.ts` — `GATE_OPEN_HOLD` 0.08→0.02→**0**; `GATE_OPEN_RATE` 8→**10**; new
  `GATE_OPEN_RATE_SPEED`, `GATE_OPEN_RATE_MAX`.
- `src/sim/goal.ts` — new `gateRamSpeed` (shared ram metric; `pushingGate` now =
  `gateRamSpeed>0`), `gateLiftRate`, `gateColliderPos`; `updateGates` computes `ram` and
  uses `gateLiftRate(ram)`.
- `src/sim/physicsEngine.ts` — `solveRobots(world, dt, gateCol?)` +
  `buildGateArms(rw, world, gateCol?)` use the anticipated open fraction; imports
  `Alliance`.
- `src/sim/world.ts` — computes `gateCol` (red/blue) via `gateColliderPos` before
  `solveRobots` and passes it in.
- `scripts/smoke.ts` — "eases open" test now samples a gentle 1-tick lean; the old
  pinned-`gatePos` one-way-door geometry test is replaced by a direct `gateColliderPos`
  mechanism test (idle = solid, ram = same-tick retract, harder ram = more retract).
- `CLAUDE.md` — gate paragraph updated.

### Behavior contract change (intended)
A STRAIGHT ram now *yields* the handle on contact (it's a one-way door that opens to a
push), so the old "a straight push is blocked at a closed gate" is gone — that's the
point. The one-way property remains for NON-pushing motion: a strafe along the wall
still sees the solid closed stub (`gateRamSpeed=0` ⇒ raw `gatePos`). G417 (touching an
opponent's gate arm) is unaffected — it keys off `gateArmRect` intersection, not the
collider.

## Gotchas / notes
- `gateColliderPos` reads POST-`updateRobot` velocity (pre-collision commanded vel);
  `updateGates` reads post-solve velocity. For a clean ram these match (velocity
  preserved through the retracted handle); for a partially-blocked medium ram the
  collider can be a hair more open than `gatePos` for one tick — imperceptible, self-
  corrects next tick.
- A step()-based "harder ram lifts faster" test does NOT work: `updateRobot` recomputes
  velocity from the command each tick, so a single tick can't build up 55 in/s and both
  speeds hit the gentle lean-floor. The speed-scaling is proven directly against
  `gateColliderPos` instead (which shares `gateLiftRate` with `updateGates`).
- Local dev: `.env.local` has `VITE_GAME_SERVER_URL=` (empty) to disable the
  multiplayer/username gate for solo testing. Restore the `ws://localhost:8789` line (or
  delete the empty override) + restart dev to test multiplayer again.

## Exact next steps (unchanged roadmap)
- Feel-tune the gate constants if the user wants (e.g. `GATE_OPEN_RATE_SPEED` /
  `GATE_OPEN_RATE_MAX` for how snappy a hard ram is). `npm test` after any `src/sim` edit.
- Roadmap item 1 still open: penalty hitbox/zone-geometry audit.
- Balls → Rapier (Phase 2 slice 2) still deferred.
