# A realistic drive mode: research and plan (not implemented)

Owner, 2026-10-03: "can we make this new alpha version of dsim as accurate as possible? Something
like AdvantageScope or maybe even more accurate? There is also an ILITE drivetrain calculator. Do
research, but do NOT implement this ultra-realistic dsim version yet." This is the research and the
plan. Nothing here is built.

## What DSIM does today (`src/sim/drivetrain.ts`, `docs/area/physics.md`)

- Top speed `SPEED_PER_RPM × rpm × speedMult` (a 104 mm wheel at 0.95 efficiency); acceleration
  `240 × (435 / rpm) × (26 / massLb) × accelMult`, each preset landing at a μg ceiling.
- `motorStep`: torque falling linearly to 6 % at free speed, braking at 1.4×, a vector budget.
- Turn rate is wheel speed over the half-diagonal, capped at 12 rad/s.
- Power draw is a scalar (at most 20 %) from flywheel, intake and drive; no voltage, current or
  battery.
- Pushing is a stated force (`pushForce = mass × 240 × pushMult × rpmPush × (1 − draw)`); Rapier's
  collider mass is `shoveMass = pushForce / accel`, so it grows with mass².
- Imports convert their gearing to an equivalent rpm on a 104 mm wheel and use the same model.
- `docs/area/physics.md` still quotes older mecanum multipliers and frictions than `config.ts`.

## The references

- **AdvantageScope** is a log VIEWER, not a simulator: robots are `model.glb` plus one GLB per
  articulated component and a `config.json` (rotations, position, per-component zeroed pose), posed
  from logged `Pose3d` arrays. FTC support is experimental (Road Runner logs, FTC Dashboard live,
  `.wpilog` via libraries such as KoalaLog). DSIM can WRITE its format (an import's stored GLB already
  has a node per moving part at its pivot) and EXPORT replays as WPILOG, so a team overlays a sim run
  on a real-robot log as a ghost. What teams watch as "AdvantageScope simulation" is robot code in
  WPILib's simulation mode (its motor, battery and drivetrain classes, below) or a 2D physics library
  for FRC robot code on dyn4j (forces, collisions with field elements and game pieces), drawn live
  through "Connect to Simulator". Those models, not the viewer, are the accuracy bar.
- **ILITE drivetrain simulator** (FRC 1885, v2020 spreadsheet): time-stepped at 0.02 s; a linear
  torque–speed motor with back-EMF scaled by applied voltage; system voltage `V_rest − I·N·R_batt`
  less a fixed wiring loss, from the previous step's current; torque clamped by a current limit and
  by the traction at the wheel (weight × CoF × weight split); gearbox and wheel efficiency; coast,
  brake or reverse deceleration. Outputs: top speed, time to distance, min voltage, mAh, current,
  slip and current-limit flags. Its own gaps: no acceleration while slipping, dynamic CoF after slip
  only planned. ReCalc has an MIT TypeScript port (`iliteSim`), usable as a reference in tests.
- **WPILib** `DCMotor`: `R = V / I_stall`, `Kv = ω_free / (V − R·I_free)`, `Kt = τ_stall / I_stall`,
  `I = V/R − ω/(Kv·R)`; `BatterySim`, `DifferentialDrivetrainSim`.
- **FTC hardware**: goBILDA 5203 19.2:1, 312 rpm, 24.3 kg·cm stall, 9.2 A stall, 0.25 A free
  (R ≈ 1.30 Ω); REV HD Hex 6000 rpm, 0.105 N·m, 8.5 A, 0.4 A (R ≈ 1.41 Ω); Core Hex 125 rpm, 3.2 N·m,
  4.4 A. One 12 V NiMH pack behind a 20 A fuse; packs retired past ~130–200 mΩ internal resistance.
  Control Hub ports 10 A continuous. Mecanum CoF about 0.7 forward, 0.6 sideways (AndyMark, carpet);
  no published CoF for FTC foam tiles was found. Road Runner's tuning measures each robot's strafe
  slip (`lateralInPerTick`) and kS/kV/kA.
- A sanity check: four 5203 19.2:1 on 104 mm wheels give about 41 lbf at stall; a 30 lb robot at
  μ 0.7 has about 21 lbf of traction. FTC drives are traction-limited, and the traction-limited
  current is near the 20 A fuse, so battery sag and current coupling are real effects in FTC.

## How accurate the references are

None of them publishes an error against a real robot. What their models leave out:

- **WPILib's drivetrain sim** is a linear model from the motor curve or from SysId's kV/kA: no traction
  limit (a stalled start accelerates as fast as the motors push, which an FTC drive cannot), no
  slip, no collisions, battery sag only if the code wires `BatterySim` in. Its docs call the CAD-built
  version "just an approximation"; fitted to a real robot it tracks driving inside the grip limit
  well, and that is where it is meant to be used.
- **The 2D physics library on dyn4j** (swerve only): per-module grip capped at COF × the module's
  share of the weight, ONE friction coefficient (no static/kinetic split), no weight transfer, a
  skidding wheel's speed set halfway between the motor's and the floor's, battery sag modelled.
  Collisions with field elements and game pieces are its point; its own claim is "realistic enough
  to feel like a video game".
- **The drivetrain calculator**: a straight line only, no slip dynamics.
- FTC has no equivalent in its SDK, and none of these models mecanum.

What they all lack: mecanum roller losses, weight transfer, static vs kinetic friction, a check
against logs. DSIM today has the grip ceiling (a μg cap) but no motor, battery or per-wheel model.

## How DSIM does better

1. **Measured, not claimed.** A library of real-robot logs and a test that reports DSIM's error on each
   (velocity RMSE, time to distance, path deviation on a strafe and a spin), run on every model change.
   That number is the claim; no reference has one.
2. **Fit to the team's robot.** A calibration OpMode (sprint, coast-down, strafe, spin, a push) whose log
   the importer reads to fit kS/kV/kA, μ, strafe efficiency and battery IR for THAT robot, the way SysId
   fits a feedforward. Defaults stay the catalogue values.
3. **The terms FTC needs** (the table below): per-wheel mecanum force with roller friction, static and
   kinetic friction, weight transfer, one battery shared by every mechanism, the 20 A fuse.
4. **The robot's own code.** Much of a real robot's feel is its software: field-centric, heading hold,
   slew limits, dead zones, a path follower's corrections. Make those settings of the import, so the
   sim drives like the team's code does.
5. **Game pieces measured.** Launch dispersion, bounce and rolling friction from video of the real
   artifacts, with seeded spread instead of a perfect shot.

Limits: tile wear, dust, pack charge and motor-to-motor spread vary run to run, so the target is the
real robot's own spread across repeated runs, not zero error.

## What to model

| term | model | data |
|---|---|---|
| DC motor | `I = (d·V_bus − ω_m/Kv) / R`, `τ = Kt·(I − I_free)·η_gear` | vendor tables; the importer's gearing |
| shared battery | `V_bus = V_rest − ΣI·(R_batt + R_wire)`, last tick's ΣI; flywheel, intake and lifts on the same bus | player `V_rest` and IR, defaulting to a healthy pack |
| per-wheel traction | each wheel's force capped at μ_s·N (μ_k once slipping), along the wheel for traction, free sideways for omni, square to the contacting roller for mecanum, along the pod for swerve; summed to a wrench | the importer's wheel positions and types; μ measured |
| weight transfer | ΔN = m·a·h / L and m·a_y·h / W | CoM height from CAD or the player |
| yaw inertia | from CAD mass properties, or the bodies at uniform density scaled to the weight | Onshape mass properties; the importer's bodies |
| losses | rolling and back-drive drag from a coast-down; gearbox efficiency | coast-down test |
| collisions | keep the Rapier 2D solve, give Rapier the REAL mass, and let the traction caps decide a shove | — |

Mecanum push follows from the geometry: each wheel's force lies at 45°, so a straight push is at most
about 0.71·μW before roller losses; the strafe-to-forward ratio becomes a measured roller-friction
parameter instead of `strafeMult`.

## Validation

1. The ILITE reference port in smoke: for FTC configurations (5203 312/435, HD Hex, Core Hex), DSIM's
   straight sprint (time to 2 and 4 tiles, top speed, min `V_bus`, slip flag) within a few percent.
2. Real-robot logs on a fixed protocol (full-throttle sprint, coast-down, strafe, spin in place, a
   push against a load cell or wall), logged at loop rate: commands, encoder velocities, per-motor
   current, hub voltage, IMU, odometry, as `.wpilog` or a Road Runner log.
3. A replay harness feeding the logged commands open-loop into the headless sim from the same rest
   voltage, scoring velocity RMSE, time to distance, peak current and min voltage; μ, roller
   friction, η and R fitted as catalogue defaults per wheel and motor, not per player.
4. The sim run exported as WPILOG and overlaid on the real log in AdvantageScope.

## Cost and rules

- About 4 wheels × ~50 flops per robot per tick: nothing next to the Rapier step. No substeps if the
  traction model is no-slip-with-a-cap; a per-wheel spin-state slip model would need them.
- Deterministic arithmetic with the existing `dsin`/`dcos`; no randomness.
- No new per-tick state where possible (ΣI from this tick's velocities and commands, `V_rest` a spec
  constant). State that ships at 30 Hz must be costed with `npm run costprobe` first.
- Gated like `imported.tune`: practice only, stripped in rooms, standard robots byte-identical
  (`IMP_STANDARD_PINS`), a new replay format. Any ranked use changes push outcomes: a balance and
  `SIM_VERSION` decision the owner makes.

## Phases

- **P0**: the ILITE reference model in smoke and the log-replay harness; `step()` unchanged.
- **P1**: the importer's Drivetrain step shows predicted sprint time, current, min voltage and
  "traction- or current-limited" from the same functions; display only.
- **P2**: a "Realistic drive" practice flag with the motor, battery, per-wheel traction and real
  Rapier mass; validated against P0 and logs.
- **P3**: mechanisms on the shared bus (flywheel spin-up from motor and inertia, slide travel time).
- **P4**: weight transfer, yaw inertia from CAD, kinetic friction, optional per-wheel slip state.
- **P5**: custom rooms; ranked only on the owner's decision.

## For imported mechanisms (done 2026-10-03, and what is next)

Done: generic spinning, swinging and sliding parts bound to robot signals, gearing between parts at a
ratio, riding (chains), more auto-detection (`docs/area/robot-import.md`, "Moving parts"). Next, in
order of value: a multi-stage slide (cascade or continuous stages as one row), a two-position claw,
mechanism timing from motor + ratio + spool (P3), mass properties from CAD, Onshape mates and mass
through its API (mate connectors as revolute, prismatic or fixed joints), a pose-dependent collision
hull so an extended slide is solid, and AdvantageScope export.
