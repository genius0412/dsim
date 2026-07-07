# HANDOFF — session ending 2026-07-06 (Netcode Phase 2 — Rapier ROBOTS slice SHIPPED)

Read `CLAUDE.md` first (load-bearing rules), then this file. The netcode/physics
roadmap is `docs/netcodeplan.md` (source of truth). Prior netcode work (Phase 0/1)
is summarized further down; THIS session did **Phase 2, robots-first slice**.

## ✅ Current state: BUILD GREEN · `npm test` = **140 checks ALL PASS** · server type-checks + boots · GUI live-verified

This session replaced the bespoke **robot** collision solver with **Rapier 2D**
(`@dimforge/rapier2d-compat`), the first slice of netcodeplan Phase 2. Balls are
still 100% bespoke (Slice 2, deferred — the user chose "robots first").

## What "robots on Rapier" means (the model — read before touching physics)

`RobotState` stays the single canonical, JSON-serializable source of truth. Each
`step()`:
1. `updateRobot` (robot.ts) computes accel-clamped target velocities into `r.vel`/
   `r.angVel` and integrates HEADING — but **no longer integrates position** (Rapier
   does). Turret/fire/aim unchanged.
2. **`solveRobots(world, dt)`** (`src/sim/physicsEngine.ts`, NEW) builds a FRESH
   Rapier world: static colliders (perimeter walls, goal-face hypotenuse slabs,
   classifier-channel rects) + one dynamic body per robot (rotation LOCKED,
   `linvel = r.vel` set from RobotState, mass = `spec.massLb`, restitution 0,
   friction `PHYS_FRICTION`). Steps ONCE, writes `translation → r.pos` and
   `linvel → r.vel` back, then `world.free()`. Returns each robot's PRE-solve
   velocity.
3. **`squareUpRobots(world, preVels)`** (physics.ts, NEW) is the bespoke post-step
   pass Rapier can't do: the contact-torque "square up flush" nudge (rotation only)
   + emits `world.rrContacts` (id-ordered a<b) for the penalty engine. Press scales
   with the pre-solve drive-in velocity.

**Why stateless rebuild-per-step:** `game.ts` reconcile swaps `this.world` for a
fresh snapshot up to 60×/s; a Rapier world keyed to object identity would
rebuild-and-LEAK WASM every frame. Rebuild-per-step makes reconcile + bit-for-bit
determinism trivially correct, and building ~8 colliders + N bodies is microseconds.
Rapier OWNS robot translation + velocity, so wall/robot velocity-kill, mass-weighted
shoving, restitution-0 inelastic contact, AND pinned-ball feedback (balls mutate the
canonical RobotState, which is rebuilt into Rapier next tick) all come for free. Only
the ROTATION square-up is bespoke.

## Load-bearing Rapier gotchas discovered this session (do NOT relearn the hard way)

- **The world is in INCHES, not meters.** Rapier's default tolerances assume meters
  (~40× smaller). MUST set `rw.integrationParameters.lengthUnit = PHYS_LENGTH_UNIT`
  (10) or a robot driven full-speed into a wall-pinned robot out-runs the solver,
  penetration grows past the chassis width, the min-penetration axis flips, and the
  pair is EJECTED sideways at ~60 in/s. This was the single most important fix.
- **Hard-setting `linvel` every tick OVERRIDES Rapier's velocity resolution** → the
  body keeps its forced inward velocity and penetrates. The correct pattern (verified)
  is set-once from RobotState + **read `linvel()` back into `r.vel`** so the wall's
  velocity-kill propagates. Do not re-force velocity mid-contact.
- **`contact_erp` is getter-only** (TGS-soft derives it). Tune softness via
  `contact_natural_frequency` (`PHYS_CONTACT_FREQ` 8 = soft) + `normalizedAllowed
  LinearError` (`PHYS_ALLOWED_ERROR`). Soft contacts allow a ~0.2in steady wall
  penetration (invisible at field scale; the containment smoke check tolerates 0.6).
- **Init is async** (`RAPIER.init()`); the sim `step()` is sync. `initPhysics()`
  (physicsEngine.ts) is awaited at ALL THREE entry points before any step:
  `scripts/smoke.ts` (top-level await), `server/index.ts` (before `listen`),
  `src/main.tsx` (before `createRoot().render`).
- **Contact manifolds** (for the square-up, though we ended up using bespoke SAT for
  torque): `rw.contactPairsWith(collider, other => rw.contactPair(a, other,
  (m,flipped) => m.normal()))`. Deterministic in-process (two identical runs are
  bit-identical — verified; the 1200-tick determinism smoke check passes).
- **compat build inlines WASM** as a single ~1.57MB base64 blob → NO separate .wasm
  asset → Vite + Electron `file://` work with no `vite-plugin-wasm`. Cost: the client
  bundle grew ~1.2MB (gzip ~704KB). Acceptable; revisit with the non-compat build +
  a served .wasm only if size becomes a problem.

## Files touched this session

- **NEW** `src/sim/physicsEngine.ts` — `initPhysics()`, `physicsReady()`,
  `solveRobots()` + `buildStatics()`.
- `src/sim/physics.ts` — added `squareUpRobots` (+ `squareUpStatics`/`squareUpPair`/
  `pressAlong`), reusing the existing `applyContactTorque`/`classifierMTV`/
  `pointDepthInRobot`. `collideRobots` + `constrainRobot` are now **DEAD** (only a
  smoke COMMENT references them) — left in place as reference for the Slice-2 ball
  port; `pushRobotAt` is still LIVE (bespoke ball pin).
- `src/sim/world.ts` — swapped the 2-pass `{collideRobots; constrainRobot}` block for
  `solveRobots` + `squareUpRobots`.
- `src/sim/robot.ts` — `updateRobot` dropped the two position-integration lines only.
- `src/config.ts` — `PHYS_LENGTH_UNIT` 10, `PHYS_SOLVER_ITERS` 8, `PHYS_CONTACT_FREQ`
  8, `PHYS_ALLOWED_ERROR` 0.01, `PHYS_FRICTION` 0.7, `CONTACT_TOUCH_EPS` 0.5.
- `scripts/smoke.ts`, `server/index.ts`, `src/main.tsx` — `await initPhysics()`.
- `scripts/smoke.ts` — added the "full-speed wall drive is contained (no tunneling)"
  check (now 140 total).
- `package.json` — `@dimforge/rapier2d-compat` (0.19.3) added to `dependencies`
  (runtime; the server imports it too).

## Verification done

- `npm test` → 140/140, incl. the 1200-tick 4-robot **bit-for-bit determinism** check
  and every feel test (strafe ratio 0.8, wall square-up no-oscillation, mass-shove
  1:2, equal-mass symmetric, pinned ball stall + off-center scatter, classifier
  eviction, squeeze-against-wall-stays-in-field, gate-outflow-cant-shove, G422
  pinning). All route through Rapier now.
- `npm run build` (tsc strict + vite) green. `npm run server:check` green. Server
  boots after `initPhysics()`; `/health` → 200.
- **GUI live-verified via the `verify` skill (Electron):** Free Drive, robot drives
  forward/strafe/rotate responsively, squares up FLUSH against walls with no buzz,
  stays contained at the goal-face/classifier corners, never clips/tunnels/sticks.
  (Screenshots were in the session scratchpad.)

## ⚠️ NOT DONE / next steps

1. **Phase 2 Slice 2 — BALLS on Rapier** (deferred; the tricky part per the plan).
   Balls → dynamic bodies/sensors for ground/flight-low (roll, ball-ball, ball-wall,
   ball-robot, goal-face bounce), PRESERVING pinned-ball resistance + near-inelastic
   feel; KEEP basin/rail/gate SCRIPTED atop Rapier (the classified-vs-overflow
   contact-time commit must stay exact); create/destroy Rapier ball bodies on every
   `flight↔basin↔rail↔ground` transition. Balls currently stay 100% bespoke and work.
2. **THEN cleanup** (only after balls land): delete the dead `collideRobots`/
   `constrainRobot`; remove the `dsin/dcos/datan2` determinism discipline from
   sim-reachable code (STILL REQUIRED now — robot.ts fire + goal.ts use it, and the
   in-process determinism check relies on stable trig). Do NOT remove it yet.
3. **Re-tune check:** `PHYS_FRICTION` 0.7 adds wall/robot friction the old model
   lacked (resists a pinned robot squirting out of a squeeze). Feels fine in the GUI;
   re-evaluate if driving along a wall feels sticky. Soft contacts (`PHYS_CONTACT_FREQ`
   8) allow ~0.2in wall penetration — bump the frequency if that ever looks wrong.
4. Netcode leftovers from Phase 1 still open: Vercel client redeploy with
   `VITE_GAME_SERVER_URL`, WebTransport, full-reload reconnect (unchanged this session).

## ⚠️ GIT: the USER commits, NOT me (they were explicit — never commit yourself)
All of this session's work is in the working tree, uncommitted, for the user to commit.
Do not run `git commit`.

## Standing user instructions
- **NEVER commit — the user commits themselves.**
- Write/refresh this HANDOFF at the END of every session.
- Product decisions in CLAUDE.md — do not regress. Physical models over scripted.
- Run `npm test` after any `src/sim`/`config`/`src/net` change; `npm run build` before
  "done". Server-side Rapier uses `Date.now()` freely (single authority); `src/sim`
  stays deterministic (Rapier is deterministic in-process, which is all the
  server-authoritative model needs).
- Fly deploy: `fly` is authed; keep it at 1 machine. The Fly server image now needs
  the Rapier dep (it's a runtime `dependency`, so `npm ci --omit=dev` includes it).

## Prior context (Phase 0/1 — unchanged this session)
Server-authoritative sim + client prediction (Rocket League model) replaced the old
P2P lockstep. `server/` (Node + ws + tsx) runs the shared `src/sim`; client predicts
its own robot + reconciles to snapshots. Reconnection (15s grace), delta snapshots
(spec-stripped robots + ball delta), deployed to Fly (`wss://dohun-sim-decode.fly.dev`,
scale=1 — room state is per-machine). See `docs/netcodeplan.md` + prior git history.
