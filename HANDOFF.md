# HANDOFF — 2026-07-08 (session 7: intake redesign + power draw + drivetrain overhaul) — READ FIRST

## Build state
GREEN. `npm test` = **206/206** checks pass (0 fail). `npm run build` (tsc strict + vite)
clean. Work is on `alpha`, **not yet committed** (see "Next steps"). `BALANCE_VERSION` bumped
**1 → 2** (balance changes → a fresh ranked season; old replays only re-verify under v1).

## Intake/physics iteration 2 (this session, after the section-1 writeup below)
A long back-and-forth reshaped the intake into a **funnel model** + several balance asks. All
green. Key changes on top of the "What shipped" section:
- **FUNNEL intake (sloped/triangle):** no flat front — two solid side **wedges/slopes** (in
  `ballRobotContact`, `physics.ts`) deflect balls to the **throat** (chassis-front center) where
  the compliant wheels grab them. Capture is ONLY at the throat, directly under the wheels
  (`updateIntake`, robot.ts) — the edge/slope wheels can't grab (balls can't get under them). A
  narrow under-wheel suction (`mouth.drawIn`) seats a centered ball; OFF-center balls reach
  center only by the robot DRIVING them into the slopes (wedge collision), not a wide vacuum.
- **ROLLER stickout (`INTAKE_WHEEL_STICKOUT` 1.3):** the axle+wheels stick out past the wedges
  and are the robot/wall hitbox (full `reach`, via `robotExtents`/Rapier), but ride high in z so
  **balls pass UNDER the roller and never collide with it** — only the recessed wedges do. So the
  ball hitbox starts `reach − stickout` in.
- **VECTOR stays flat-front** (a plate that DOES collide with balls — that's what stops an
  encompassing 18"-chassis grabbing off its flank). Capture across the plate, center-fast /
  edge-slow timing, overhang flank grab. (Unifying vector into the funnel let it slurp side balls
  — reverted.)
- **`INTAKE_PRESETS.mouth` reshaped:** `wedge / mouthHalf / throatHalf / drawIn / capMin / capMax
  / clumpInterval / dual` (dropped `wheelHalf/wedgeWidth/funnel`). Triangle `fireInterval` buffed
  0.3→0.25.
- **SIZING (`maxLength = 18 − reach`):** the intake counts toward the 18" cube. sloped 15 / vector
  14.5 / triangle 13. **DEFAULT_SPEC + Standard Issue are now 15×18** (were 18×18) and
  `REF_HALF_DIAG` re-anchored to `hypot(15,18)/2` so the default still calibrates to 75/7/280.
- **BALANCE:** `INERTIA_MASS_FLOOR` 14→6 (inertia only nudges the mass floor); `REF_MASS_LB` 30→26
  and all preset masses lowered (26/36/22/23/26) — all clamp-valid (smoke guard added).
  `FLYWHEEL_RECOVERY_MAX` 0.6→1.25 + `FLYWHEEL_CLOSE_SPEED` 135 so **distance dominates cadence**
  (close = instant at any inertia; far low-inertia is punished hard). `DRIVETRAIN_LIMITS` floors
  lowered (mecanum/xdrive 18, tank/swerve 22).
- **CLAMP-ALL (`Menu.setSpec`):** every spec edit re-clamps mass+rpm+length together (floor moves
  with drivetrain + inertia; length with the intake). Handlers simplified.
- **BALL RESISTANCE:** `BALL_ROLL_FRICTION` 25→42 — bumped balls don't skitter (feel heavier).
- **RENDERING:** `drawRobot` + `RobotPreview` draw the SAME funnel + protruding roller (preview
  matches the in-game sprite).

### Further intake changes (also done, green — after the above)
- **VECTOR now matches the funnel model:** open center NOTCH (the wheel row rides high in z, so
  balls pass UNDER it — no plate pushes them), with solid side RAILS only where the frame is wider
  than the wheels (that's what stops an 18"-chassis grabbing off its flank; 14"-chassis wheels
  overhang → flank grab). Off-center balls are actively VECTORED to center by the wheels, THEN
  sucked to the throat. Collision + suction unified with the funnel in `ballRobotContact` /
  `updateIntake` (a `wheelSpan` = throatHalf for funnel / mouthHalf for vector).
- **Collision structure runs to the FULL reach** (rails/slopes not recessed — the recess left a
  gap under the roller that let side balls slip in). `INTAKE_WHEEL_STICKOUT` is now render-only.
- **Triangle transfer is a max-rate CAP, not a flat slowdown** (`fireCap` 0.18): same cadence as
  others, just can't fire faster than the cap; far shots (recovery > cap) fire at the same rate.
- **BALL_ROLL_FRICTION 42** (balls harder to push).

### Physical held balls (K / O) — DONE + green
Captured balls are now REAL world objects: `Artifact` state `{kind:'held', robot, slot}`. The color
`hopper` is kept SYNCED (user chose sync, not replace). Flow: capture → `b.state='held'` (kept in
world, `hopper.push`); `positionHeldBalls` (world.ts, end of `step`) parks each held ball at its
robot's `storageSlots(spec)` (physics.ts) each tick; fire → convert a held ball to flight + reslot;
`collideBallHeld` (physics.ts) makes held balls solid obstacles so a full intake physically blocks
the mouth. Rendering: hopper pips REMOVED from drawRobot; held balls drawn in drawRobot's LOCAL frame
(from the synced hopper colors at `storageSlots`) BELOW the turret, and drawBalls SKIPS 'held'.
Preloads (`PRELOAD`/`HP_INITIAL_STOCK`) are spawned as held balls in spawn.ts. Smoke tests that reset
a robot to empty must also drop held balls (`w.balls = w.balls.filter(b=>b.state.kind!=='held')`).

### Intake RENDERING (in flux — many small visual asks, `/verify` to see)
Funnel presets (sloped/triangle) draw as: funnel mouth + two RIGHT TRIANGLES (hypotenuse = the
slope, no flat front) + a roller shaft/compliant-wheels that sticks out just past the wedges
(`wedgeTip = hl+reach-0.5`, `rollerTip = hl+reach+0.5`). Vector = flat plate + roller. drawRobot.ts
and RobotPreview.tsx are kept MATCHING (front is +x in-game, −y in the preview). `storageSlots` puts
the newest ball near the mouth so it blocks. Preset min-lengths: sloped longest (13.5), vector 11.5,
triangle smallest (11). NOTE: `/verify` can't run the raw file:// build (absolute `/assets/` paths) —
run `npx vite preview --port 4173` and point Electron at `http://localhost:4173`.

### PENDING (not yet built)
- **Triangle 2-ball slide**: with only 2 balls held, the front ball should be able to slide within
  the 2-ball-wide front space to make room when the 3rd arrives. Today `storageSlots` is fixed per
  slot (no dynamic repositioning) — needs a small positional model for the triangle front pair.
- Fine intake **visual tuning** (wedge length, roller protrusion, stored-ball offsets) is centralized
  in `drawRobot.ts` / `RobotPreview.tsx` / `storageSlots` — one-line nudges when the user has eyes on it.

## What shipped this session (all in `src/`, sim stays pure/deterministic)

### 1. Physical intake model (`config.ts` INTAKE_PRESETS + `robot.ts` updateIntake)
Replaced the single-band "touch a hitbox and wait" with a real mouth model. `INTAKE_PRESETS`
kept its TOP-LEVEL fields (`reach`, `overhang`, `min/maxLength`, `fireInterval` — these feed
`robotExtents`/the Rapier collider/length clamps/drawing, so the collision OBB is unchanged)
and REMOVED `halfWidth`/`perBall`/`clumpPerBall`, adding a `mouth` sub-object:
`mouthHalf`, `wheelHalf`, `wedge`/`wedgeWidth`/`funnel`, `capMin`/`capMax`, `clumpInterval`,
`dual`. `updateIntake` now:
- captures on real geometry (wheel line at the tip, width `wheelHalf`); non-overhang presets
  still clamp the mouth inside the frame so a full-width chassis forbids side intake;
- **timing depends on WHERE the ball enters**: `single = capMin + (capMax−capMin)·t`,
  `t = |localY|/wheelHalf` — vector center fast (capMin 0.10), edges slow (capMax 0.34);
- **wedges FUNNEL** off-center balls toward the centerline (sloped/triangle): a lateral
  VELOCITY nudge only (`approach(vLocal.y, −sign·funnel, funnel)`), never a position write —
  it runs in `updateRobotActions` BEFORE the ball solve, so Rapier/`collideBallRobot` own
  penetration (no fight with the OBB pushout, no explosions);
- **triangle takes TWO per cycle** from a clump (`dual`); hopper stays a flat color array.
The vector flank/`sideTouch` overhang path is preserved verbatim (renamed mouthHalf→wheelHalf,
same 8.5 value → side-capture smoke tests unchanged).

### 2. Power draw (`types.ts` + `spawn.ts` + `robot.ts` + `config.ts`)
New serialized `RobotState.flywheelSpin` (0..1, set in `updateRobotActions` from distance to
the robot's OWN goal: `FLY_SPIN_NEAR 40`→`FLY_SPIN_FAR 170`) and `powerDraw` (set in
`updateRobot`). Draw = `POWER_DRAW_FLYWHEEL(0.12)·inertia·spin + (intake ? 0.06 : 0)`, capped
`POWER_DRAW_MAX 0.18`. It scales the LOCAL `driveParams` copy (`maxSpeed/accel/maxTurn/
turnAccel *= 1−draw`) — `driveParams()` itself is untouched so the 75/7/280 calibration holds.
One-tick lag (fire runs after drive) is invisible + deterministic.

### 3. Drivetrain retune + pushing power (`config.ts` + `physicsEngine.ts`)
`DRIVETRAIN_PRESETS` gained `pushMult` and retuned `accelMult`: tank `1.5/1.5` > swerve
`1.12/1.15` > mecanum `1.0/1.0` (UNCHANGED — the calibration anchor) > xdrive `0.92/0.9`.
**Pushing power = effective Rapier shove mass** at `physicsEngine.ts` `setMass`:
`massLb · pushMult · rpmPush · (1−powerDraw)` where `rpmPush = clamp(REF_DRIVE_RPM/driveRpm,
0.6,1.8)` (geared-for-speed ⇒ less torque). So push scales with drivetrain, mass↑, rpm↓,
draw↓ — real-motor style. `driveParams.accel` still uses REAL mass, so linear accel is
untouched. At the reference (mecanum/435/rest) every factor = 1 → the mass-weighted-shove
smoke checks (42 vs 21 ≈ 1:2, symmetric) are byte-unchanged.

### 4. Per-drivetrain clamps + inertia→weight coupling (`config.ts` + `drivetrain.ts` + `Menu.tsx` + `settings.ts`)
Replaced ad-hoc `SWERVE_MIN_MASS`/`SWERVE_MAX_RPM` with `DRIVETRAIN_LIMITS`
`{minMass,maxMass,minRpm,maxRpm}` per drivetrain (mecanum/xdrive 20–42/200–600, tank
24–42/200–560, swerve 25–40/200–500). New `INERTIA_MASS_FLOOR 14`: a bigger flywheel weighs
more → `massLimits(dt, inertia).min = clamp(baseMin + 14·inertia, baseMin, max)`. New helpers
`massLimits`/`rpmLimits` in `drivetrain.ts`. Menu sliders derive bounds from them; the
flywheel-inertia slider now BUMPS mass up to the new floor; drivetrain-switch re-clamps both;
`coerceSettings` reads inertia FIRST then clamps mass/rpm via the helpers (both persistence
paths coupled). Fixed `ROBOT_PRESETS.Hummingbird` to swerve-legal 25 lb / 500 rpm.

### 5. Rendering (`drawRobot.ts` + `RobotPreview.tsx`)
`preset.halfWidth`→`preset.mouth.mouthHalf`. Sloped/triangle draw drive-pod-wide funnel
WEDGES + a compliant-wheel line; vector highlights the fast CENTER opening vs dim vectoring
sides; triangle storage pips flipped (two near the mouth, one deep).

## New smoke checks (in `scripts/smoke.ts`, near the drivetrain section)
accel order tank>swerve>mecanum>xdrive; equal-mass tank out-pushes mecanum; high-rpm yields
more than low-rpm; power-draw ~11% slower far from goal + driveParams byte-identical;
`massLimits`/`rpmLimits` values + `coerceSettings` swerve up-to-floor/down-to-500; vector
CENTER (7t) faster than EDGE (20t); sloped wedge imparts inward velocity + funnels the ball
in; triangle devours two per cycle.

## Gotchas learned this session
- **Placing a test ball DEAD-ON the intake OBB face triggers the deep-push eviction**
  (`collideBallRobot`, physics.ts:718 `pen = BALL_RADIUS + 2`) → it lands OUT of the capture
  band. Place mouth-test balls at `wheelLine + 2` (shallow contact), like the clump test.
- Free mode's human-player restock adds balls over time, but they spawn in the loading zone
  (far from a robot at origin) so they never become mouth candidates — fine for intake tests.
- `run(world, cmd, x)` is x SECONDS, not ticks. The vector flank test relies on the robot
  strafing IN over ~1 s (the ball only enters the flank band as the robot closes).

## Next steps
1. **COMMIT + DEPLOY (not done).** Sim + server share `src/sim`, so this is a deploy-worthy
   change AND a `BALANCE_VERSION` bump. Protocol: commit on alpha → `git checkout main; git
   merge alpha --no-ff` → `flyctl deploy --remote-only` → `curl .../health` → Vercel
   auto-deploys client → `git branch -f alpha main; git branch -f beta main; git push origin
   alpha beta`. (No Co-Authored-By trailer — commits must look hand-typed.) `/verify` in the
   Electron GUI first if you want eyes on the new shapes/feel.
2. **Penalty hitbox audit** (the other roadmap item — unchanged from last session).

## Doc state
`CLAUDE.md` product decisions #1 (power draw added to flywheel), #7 (drivetrain push/clamps),
#10 (intake model) + State-of-play refreshed for this session; smoke count 205. `INTAKE_PRESETS`
shape change + `DRIVETRAIN_LIMITS`/power-draw constants documented inline in `config.ts`.
