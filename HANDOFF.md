# HANDOFF — session ending 2026-07-06 (Netcode Phase 2 — Rapier GROUND-BALLS slice SHIPPED)

Read `CLAUDE.md` first (load-bearing rules), then this file. The netcode/physics
roadmap is `docs/netcodeplan.md` (source of truth). Prior slices (robots, Phase 0/1)
are summarized further down; THIS session did **Phase 2, Slice 2: GROUND balls on
Rapier**.

## ✅ Current state: BUILD GREEN · `npm test` = **143 checks ALL PASS** · server type-checks · GUI live-verified

This session moved **ground balls** off the bespoke ball-collision passes onto
**Rapier 2D** (ball↔ball, ball↔wall, ball↔goal-face, ball↔classifier). Flight,
basin, rail, gate, and stock stay bespoke/scripted — the classified-vs-overflow
contact-time scoring commit in `updateRails` was **not touched**.

## The model — read before touching ball physics

Ground balls follow the same **stateless rebuild-per-step** pattern as robots, but
in a **SEPARATE Rapier solve** from robots (`solveBalls`), NOT the robot solve.

Each `step()`, in the ball section of `world.ts` (AFTER robots + intake +
penalties, matching the pre-existing order):
1. **friction pre-pass** — `stepGroundBall(b, dt)` now decays velocity + rest-snaps
   ONLY (it no longer integrates position; Rapier does, exactly like `updateRobot`
   stopped integrating robot position in Slice 1).
2. **`solveBalls(world, dt)`** (`physicsEngine.ts`) — a fresh Rapier world of the
   static field colliders + one `ColliderDesc.ball(BALL_RADIUS)` dynamic body per
   GROUND ball (built in stable `world.balls` id order → deterministic). Steps once,
   writes `translation → b.pos`, `linvel → b.vel`. Robots are ABSENT from this world.
3. **bespoke `collideBallRobot`** (iterated `BALL_SOLVER_ITERATIONS`×) — ball↔robot
   is deliberately NOT a Rapier contact (see below).
4. **hard field clamp** — `clampGroundBall(b)` snaps ground balls back inside walls +
   goal faces (Rapier soft contacts allow ~0.2in penetration; the containment
   invariant tolerates only ±0.01–0.02in).

### ⚠️ Why ball↔robot stayed BESPOKE (the key design decision this session)
The first attempt put robots + ground balls in ONE unified Rapier solve. Smoke
immediately caught two failures that are actually FUNDAMENTAL, not tuning:
- **Pin didn't stall the robot** — a light ball can't stop a robot whose linvel is
  *force-set* every tick; the robot overran the ball to the wall.
- **Gate outflow shoved the parked robot 5.5in** — product decision #7's "balls
  arriving under their own momentum can't shove the chassis" is a *deliberately
  NON-physical* rule. A real physical solve will never reproduce it.

The bespoke `collideBallRobot`/`pushRobotAt` encodes BOTH behaviors (the pin
transmits only when the robot drives in past `BALL_PIN_PUSH_MIN_SPEED`). So the
correct split is **ball↔ball + ball↔static → Rapier; ball↔robot → bespoke**. Bonus:
the Slice-1 robot solve (`solveRobots`) is **byte-for-byte unchanged** — robots
never see ball bodies, so every robot smoke check is identical.

### Restitution (single global `CoefficientCombineRule.Min`)
Per-pair restitution isn't a Rapier primitive, but `Min` on every collider gives the
right pairwise values from the existing constants: statics carry
`BALL_WALL_RESTITUTION` (0.5), balls carry `BALL_BALL_RESTITUTION` (0.55) →
ball↔static = 0.5, ball↔ball = 0.55. Robots (restitution 0) are in a different world
now, so this doesn't touch them. `makeWorld()` factors the shared inch-scale
integration params + statics for both solves.

`BALL_MASS` (0.2 lb, new in config.ts) is essentially a numerical scale now — balls
only meet equal-mass balls + immovable statics in `solveBalls` (mass cancels), since
ball↔robot is bespoke. Kept at a physical foam-ball value for honesty.

## Files touched this session
- `src/sim/physicsEngine.ts` — `solveRobots` reverted to Slice-1 (robots only, now
  via the shared `makeWorld`), NEW `solveBalls` (ground balls only), NEW `makeWorld`
  helper, NEW `statics()` helper (restitution + Min on static colliders).
- `src/sim/physics.ts` — `stepGroundBall` is friction+rest-snap only (dropped the
  position integration); NEW exported `clampGroundBall` (reuses `clampBallPosToStatics`).
  `collideBallRobot`/`collideBallBall`/`collideBallRect`/`collideBallStatic` stay LIVE
  (ground ball↔robot bespoke + the whole FLIGHT path).
- `src/sim/world.ts` — ball section restructured: ground friction → `solveBalls` →
  iterated bespoke `collideBallRobot` → `clampGroundBall`; the bespoke
  ball-ball/ball-robot/classifier/static passes are **narrowed to FLIGHT balls**
  (`activeFlight`); flight block otherwise unchanged. Robot ordering unchanged.
- `src/config.ts` — NEW `BALL_MASS`.
- `scripts/smoke.ts` — 3 new checks (now 143): Rapier ball-ball separation, fast ball
  doesn't tunnel a wall past the clamp, ground-ball collisions bit-for-bit
  deterministic across two replays.

## Verification done
- `npm test` → **143/143**, incl. the pinned-ball stall, off-center scatter,
  open-field push, gate-outflow-can't-shove (±0.01in), overflow-at-contact +
  classified-during-drain (scoring commit), intake capture, 1200-tick robot
  determinism, and the 3 new ground-ball checks.
- `npm run build` (tsc strict + vite) green; `npm run server:check` green.
- **GUI live-verified via the `verify` skill (Electron):** Free Drive — robot plows
  through spike-mark ball columns, balls roll + PILE naturally against the left wall
  (ball-ball + ball-wall via Rapier), some get intaked; robot squares up FLUSH against
  the goal-face hypotenuse and stays contained (no tunnel) under sustained contact; no
  explosions / all positions sane. (Screenshots in the session scratchpad.)

## ⚠️ NOT DONE / next steps
1. **Flight-low balls stay bespoke** (accepted deferral of the ground-only slice). A
   low flight ball ↔ a ground ball is not resolved (flight bespoke, ground in Rapier).
   Rare in practice (the shooter never misses, so shots always enter the goal). Porting
   flight-low would need per-tick z-gated collision GROUPS (ball collides with robots
   only if z<14, balls if z<10, goal-faces if z<37, …) — real machinery for near-zero
   behavioral gain. Do it only if a flight-collision bug ever surfaces.
2. **THEN cleanup** (still deferred, unchanged): delete the now dead-for-ground
   `collideBallBall`/`collideBallStatic`-ground paths only once flight is also on
   Rapier; the dead robot `collideRobots`/`constrainRobot` from Slice 1; and remove the
   `dsin/dcos/datan2` discipline from sim-reachable code (STILL REQUIRED — robot.ts fire
   + goal.ts + the in-process determinism checks rely on stable trig). Do NOT remove yet.
3. **Feel re-tune watch:** `BALL_MASS` 0.2 + reusing `PHYS_CONTACT_FREQ`/solver iters
   for ball contacts feel fine; the ~0.2in soft-contact penetration is invisible at
   field scale (the ball-ball smoke check tolerates 0.5). Revisit if ball stacking ever
   looks loose.
4. Netcode leftovers from Phase 1 still open (unchanged): Vercel client redeploy with
   `VITE_GAME_SERVER_URL`, WebTransport, full-reload reconnect.

## ⚠️ GIT: the USER commits, NOT me (they were explicit — never commit yourself)
All of this session's work is in the working tree, uncommitted, for the user to commit.
Do not run `git commit`.

## Standing user instructions
- **NEVER commit — the user commits themselves.**
- Write/refresh this HANDOFF at the END of every session.
- Product decisions in CLAUDE.md — do not regress. Physical models over scripted,
  EXCEPT where a deliberately non-physical feel is documented (ball↔robot pin /
  outflow-no-shove — that's why it stays bespoke).
- Run `npm test` after any `src/sim`/`config`/`src/net` change; `npm run build` before
  "done". `src/sim` stays deterministic (Rapier is deterministic in-process).

## Prior context (Slice 1 — Rapier robots, unchanged this session)
Slice 1 replaced the bespoke ROBOT collision solver with Rapier (`solveRobots` in
`physicsEngine.ts`, `squareUpRobots` bespoke rotation nudge in `physics.ts`). The world
is in INCHES → `integrationParameters.lengthUnit = PHYS_LENGTH_UNIT`; set-once linvel +
read-back; rebuild-per-step (reconcile/determinism safe). `RAPIER.init()` is awaited at
smoke/server/`main.tsx`. See the git history + `docs/netcodeplan.md`.

## Prior context (Phase 0/1 — netcode, unchanged)
Server-authoritative sim + client prediction (Rocket League model) replaced the old P2P
lockstep. `server/` (Node + ws + tsx) runs the shared `src/sim`; client predicts its own
robot + reconciles to snapshots. Reconnection (15s grace), delta snapshots, deployed to
Fly (`wss://dohun-sim-decode.fly.dev`, scale=1). See `docs/netcodeplan.md` + git history.
