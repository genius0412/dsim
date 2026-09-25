<!-- governs: src/sim/**, src/config.ts, src/math.ts, src/types.ts, src/cosmetics.ts -->
# Shared physics, determinism and drive feel

The Rapier solve, the two-solve round loop, pins, artifact contact, the wall square-up, `RobotSpec` + `coerceSpec`, and the real-motor drivetrain model. Almost every number here was settled by a measurement that is quoted beside it — change one and re-read the paragraph that explains why it is that value.

*Split out of `CLAUDE.md` on 2026-09-16, **verbatim** — CLAUDE.md is loaded into every
session and this is not needed by most of them. The `governs:` line above is read by
`scripts/docaudit.mjs` and by the editor hook, so keep it accurate when paths move.*

---

## Physics

- **ROBOT collision is Rapier 2D** (`@dimforge/rapier2d-compat`). `src/sim/physicsEngine.ts`
  `solveRobots()` rebuilds a fresh Rapier world each `step()` (stateless → reconcile/
  determinism safe, no WASM leak), owns robot translation, velocity AND ROTATION (field
  colliders from the active module + mass-weighted robot-robot + velocity-kill), and writes
  `pos`/`vel`/`heading`/`angVel` back into the canonical `RobotState`. The drive reaches it as
  a FORCE + TORQUE (`DriveWrench`, built by `updateRobot`), so the angular half of every
  contact — an off-centre ram, a flank drag, a held pair bearing itself flush — is the
  solver's own answer from the same normal and friction impulses. The wall SQUARE-UP and
  `rrContacts` stay in `physics.ts`. `RAPIER.init()` is async → **`initPhysics()` must be
  awaited** in smoke, the server, and `main.tsx` before any step.
  - **EVERY robot gets a body, including one on an AUTO PATH** — a KINEMATIC one, so it is
    solid to everybody and pushed by nobody while `updatePathTraversal` keeps owning its pose.
    It used to get no body at all, i.e. a 30-second ghost you could drive straight through.
    It needs the **SWEEP VELOCITY** too (`world.ts` derives it from the pose delta, reporting
    none when the displacement exceeds what the robot could have driven — an init teleport or a
    segment jump is not a sweep): a kinematic body the solver believes is stationary has only
    the soft positional correction acting on whatever is in its way, and that cannot keep up
    with a teleport. The whole STATIC pass is skipped for a path robot, because the gate
    handle writes `vel`/`heading`/`angVel` straight onto the chassis and bypasses `applyAcc`.
  - **ROTATION IS NOT LOCKED, AND NOTHING BESPOKE ADDS YAW ON TOP OF THE SOLVER'S.** It was
    locked once, and a hand-rolled two-body impulse (`CONTACT_PAIR_SPIN`), a settling nudge and
    a slip relief put the yaw back; with both running, an off-centre ram spun its victim 26.3°
    where the solver alone gives 12.6. All of that is gone. Measured with the two halves split
    (Sept 2026): the impact flick (`CONTACT_IMPACT_SPIN`) was pure double-counting and is
    ZERO; the settling align is capped at `CONTACT_ALIGN_RATE_MAX` 0.015 rad/tick, under a
    degree a tick, where the old 0.05 added 2.9°/tick to a wall ram. Rapier's own wall-ram
    peak (2.6 rad/s at 85 in/s and 20°) is exactly the corner pivot v·sin θ / half-diagonal,
    and an off-centre robot-robot ram turns the victim 0.7/1.5/3.9/7.9° at 2/4/8/12in off
    centre — graded by the lever arm, with the victim's yaw motor braking harder while it is
    being shoved (`MOTOR_SHOVE_BRAKE`), because a drivetrain resists being spun. **The smoke
    thresholds for these are the solver's physical numbers**; a test that wants "more turn" is
    asking for the double-count back.
- **`squareUpPair` (`physics.ts`) RECORDS AND TRANSMITS; IT DOES NOT TURN.** Two things
  survive there, and neither is a rotation:
  1. **`rrContacts` is recorded on geometric overlap alone** — before any press test. Every
     protected-zone rule in both games reads it (G424/G425/G426/G427/G402/G422/G408 and CR's
     G05/G06) and touching an opponent in their zone fouls whether or not anyone is pressing.
  2. **The transmitted PUSH** (`ContactAcc.ext`, scaled by the pair's CLOSING velocity along
     the contact normal — an absolute velocity is a load reading that does not need the other
     robot to exist), which is how a robot held against a wall by an opponent feels that
     opponent's load in the STATIC pass. Rapier resolves the contact but does not tell the
     bespoke wall aligner who is leaning on whom.
- **THE PAIR PASS ACCUMULATES; IT DOES NOT WRITE** (`ContactAcc`). It used to rotate both chassis
  before the walls / goal faces / classifier / gate arm were asked anything, so those surfaces
  worked out their geometry against a robot an opponent had already turned — the exact
  path-dependence `sumTurn` exists to kill, with the robot-robot half left outside it. Now every
  surface reads the pose the solve left and each robot is turned ONCE. (Rapier's own body order
  still follows `world.robots`, which is inherent to the solver and stays deterministic.)
- **THE PERIMETER IS A HARD INVARIANT** (`FieldColliders.bounds` + `outsideBy`/`grewOut` in
  `solveRobots`), because a collider alone stopped being enough once one body in the solve could
  not yield: a chassis crushed between the far wall and an AUTO-PATH robot was driven 15.2in
  past it and, on a longer path, out of the field entirely — with its `r.vel` reading 0.00 the
  whole time, so no speed guard can see it. It clamps **GROWTH, past a slop**: a robot that began
  the tick inside cannot be pushed out, one already outside is left alone (DECODE's outflow
  mouth is at x=−69 and the drain probes park a chassis past the wall plane on purpose), and
  `PHYS_CONTAIN_SLOP` keeps it clear of ordinary resting penetration — without that it fights
  the wall square-up, which is the two-passes-taking-turns failure the ball solve was rebuilt to
  avoid. `PHYS_MAX_ROBOT_SPEED` is the velocity half of the same guard, and is **absolute**: as
  a multiple of the robot's own top speed it fired on ordinary shoves of a slow chassis by a fast
  one, because what sets a shoved robot's velocity is the PUSHER's.
- **`pressOn` = max(own drive-in, load transmitted through the chassis)**. `pressAlong` reads only
  the robot's own drive, which is the whole story for a robot leaning on a wall by itself and none
  of it for one held there by an opponent — measured, a rammed robot sat at its arrival angle for
  four seconds. `ContactAcc.ext` carries the pair's push into the static pass.
- **GROUND ARTIFACTS ARE RAPIER TOO, AND THE TWO SOLVES RUN AS ROUNDS** (`solveArtifacts` +
  the loop in `world.ts` `step`). The rule the engine was rebuilt to (Sept 2026): **every
  element ends the tick somewhere it is allowed to be, with ONE position authority per
  element.** There used to be some forty bespoke position-writing passes taking turns — robot
  solve, ball solve, chassis eviction, wall clamp, jam freeze, settle freeze, a final
  relaxation — and every "nowhere to go" report (an artifact squished into a wall, a chassis
  walked across the field by its own artifact, a pair frozen 2.76in interpenetrated for 92
  seconds) was two of them disagreeing. Now a robot's position is written by `solveRobots`
  and nothing else, and a ground artifact's by `solveArtifacts` plus the containment clamp.
  - **ORDER WITHIN A TICK**: commands/auto-path (recording `sweepFrom`) → ground-ball
    integration, the bounce of every impact that will land this tick (`bounceFirstContacts`,
    VELOCITY only — see below), the coincident-pair kick (`scatterBalls`), `clumpDrag`, `intakeSuction`
    (VELOCITY only, and BEFORE the solve — G408 reads artifact velocity, so a post-solve
    nudge herded 120in for 0 fouls) → drive wrenches → snapshot robots + balls → the ROUND
    LOOP (`PHYS_PIN_ROUNDS`): `solveRobots` with the currently PINNED artifacts as KINEMATIC
    circles carrying the artifact's own velocity (`PinnedCircle`) → `solveArtifacts` with every robot a KINEMATIC sweep from `sweepFrom` to where
    the robot solve put it → containment clamp → `pinnedArtifacts`; if the pin set GREW,
    restore the snapshot and run the round again. Then `world.pinnedArtifacts` (carried tick
    to tick in the world JSON, so the pin has hysteresis across ticks), buried eviction +
    `placeGroundArtifact`, `squareUpRobots`, actions, penalties, flight, goals.
  - **ONE GEOMETRY AUTHORITY** — `src/sim/artifactSolids.ts` (`robotSolids`,
    `robotPenetration`) says what on a robot is SOLID to an artifact: the chassis box, the
    funnel's wedge quads with a compliant lip (`INTAKE_LIP`), the vector preset's flank rails
    (`INTAKE_RAIL_T`), and the balls it is holding. The artifact solve builds its robot
    colliders from these, the robot solve builds the same shapes (`R_CSOL`) to meet a pinned
    artifact (`R_PIN`), and the pin test measures against them, so nothing can disagree about
    where an artifact may be. The old engine had three descriptions of that surface and they
    disagreed by a roller radius — exactly the band where artifacts were frozen by one rule
    and released by another. **The intake MOUTH is open in all three** by design (#10); a
    convex hull of the funnel filled the notch and turned the outer corner into a forward
    wall, so the wedge is an explicit quad. **A GAME MAY SUPPLY ITS OWN SHAPES**
    (`GameSimModule.artifactSolids`, see the seam section in `CLAUDE.md`) — the authority is still ONE per
    game, it just is not always DECODE's: `robotSolids` describes DECODE's hardware, and a game
    whose intake is not a front funnel (BIOBUZZ's edge-mounted sweeper) returns its own chassis
    + plates + held-element circles instead. An absent slot is the shared function, so DECODE
    and CR are byte-identical.
  - **A PIN IS A ROBOT PROBLEM, NOT AN ARTIFACT PROBLEM.** `pinnedArtifacts` calls an artifact
    pinned when a robot solid penetrates it AND it is against something that cannot yield —
    the field (`inField`, measured with `clampBallPosToStatics`, which knows the walls, the
    goal faces AND the classifier channel), or, transitively through touching artifacts
    (`supported`), a static or another robot. Entry past `ARTIFACT_PIN_SLOP`, release only
    once it has come clear by `ARTIFACT_PIN_RELEASE` — without the hysteresis an artifact
    ratcheted into the wall under a leaning robot — and a free clump is NOT support (it froze
    solid when it was). **A free artifact, however deep it sits inside a chassis for a tick,
    is never pinned** — a full-speed ram can leave the first ball of a clump a fraction inside
    while the solve is still propagating the push, and a robot that stopped for that was
    stalled by 0.2 lb of artifact. **No direction test and no "escaping" exemption**: both were
    tried (Sept 2026) and both failed the same way — a heuristic cannot tell a corner hit that
    would slide a wall ball along from a wall ball boxed in by the wedge and its neighbours
    (the direction cone let a chassis drive 2.9in into the second), and a jammed pile jiggles
    above any speed threshold without going anywhere (the exemption let a robot crush one, 3.1in
    ball in ball). What is left inside a robot with something behind it is pinned, whatever the
    angle. **The pinned circle MOVES** (`PinnedCircle`): it is a kinematic body in the robot
    solve, at the position the artifact began the tick in and carrying the velocity the artifact
    solve gave it, so a ball that cannot move is the wall it always was and a ball squirting out
    of a squeeze along a wall at 100+ in/s is a wall the robot follows into the space it
    vacates. **A pin may undo the robot's OWN advance and nothing more**: the circle is sized
    against the robot's START pose and every one of its solids — tangent to the nearest solid,
    plus `PHYS_PIN_INFLATE` only for a robot DRIVING into it (the inflation is what the robot
    world's soft contact compresses under the drive force; re-tangenting each tick to the
    compressed pose let a driving robot creep 0.14in a tick), capped at the full inflated ball —
    and it moves only when that robot is DRIVING into the ball (`ARTIFACT_PIN_DRIVE` of stick
    along the pin normal — intent, not measured advance: a robot stopped on its pin advances
    nothing and is still pushing), and then only across or away from the robot's centre. A 0.2 lb
    artifact rolling down the gate onto a parked intake cannot shove 30 lb of robot; the full
    inflated moving circle did, 0.8in per drain ("when gate intaking, the balls that come down
    should not be pushing the robot away"). A pinned artifact under a robot that is NOT pushing it is put back where it began
    the tick, at rest: squeezed between a kinematic chassis and the field the solver has no
    answer it can settle on, and a column under an idle robot parked 1.25in onto it jittered
    0.19in a tick at 40 Hz. And **a re-run round restores artifact POSITIONS but keeps their
    velocities** —
    restoring the velocity too threw away the squirt the round had just found, the re-solve with
    a stopped robot gave the ball 5 in/s instead, and the robot sat on a creeping ball tick after
    tick ("artifacts act like they are fixed in place"). **NOTHING A ROBOT PUSHES ENDS UP
    FASTER THAN THE ROBOT** (the clump speed cap after the loop): two equal masses with
    restitution `e <= 1` hand the struck body `((1+e)/2)*v`, never more than the striker's own
    `v`, and the solve broke that whenever the striker was an artifact pressed against a
    KINEMATIC chassis — unable to recoil, it read as infinite mass and delivered `(1+e)*v`. A
    full-speed ram put the artifact beyond the pushed one at exactly `BALL_MAX_SPEED` against a
    robot doing 85, and a ball faster than the robot is one it can never catch ("if I drive in
    full speed, third ball bumps with the second ball and doesn't get intaked"). So a ground
    artifact's speed is bounded by what could have driven it: its own start-of-tick speed, the
    start speed of everything in its start-of-tick contact CLUMP, and the speed of any robot
    touching that clump. A clump and not one hop, because a chassis pushes a chain in ONE pass
    by design and a one-hop cap froze the back of a pile for a tick. Every velocity pre-pass
    runs BEFORE the snapshot, so `bounceFirstContacts`, `scatterBalls`, `clumpDrag` and
    `intakeSuction` are already inside the bound and only the SOLVER's excess is clipped; the
    bisection is unambiguous that the excess is the solver's restitution on a SUSTAINED contact
    and NOT the pre-solve bounce (disabling `bounceFirstContacts` changes nothing, zeroing the
    artifact collider's restitution fixes it). A PINNED artifact is EXEMPT — a wedge a few
    degrees off square has to throw it `1/tan(theta)` times the robot's own advance just to keep
    it clear, and capping that shuts the wedge and parks the robot on the ball. **An artifact on
    the field has no velocity INTO it** (the clip beside the containment clamp): a ball squeezed between a
    kinematic chassis and a static wall is between two things the solver cannot move, and the
    compromise it leaves is a velocity into the wall (58 in/s measured) on a ball the clamp has
    just put back on it — carried into the circle it told the robot solve the ball was leaving,
    carried into the next tick it read as an impact and bounced ball and robot apart. The
    sideways part, the squirt, is kept; the circle's velocity is zeroed under `BALL_REST_SPEED`
    (the solver's jitter carried into it walked a stalled robot 13° in two seconds). The circle is inflated
    (`PHYS_PIN_INFLATE`) so the chassis stops ON it instead of creeping through the solver's
    allowed error, and keeps a little friction (`PHYS_PIN_FRICTION` 0.15): the artifact contacts
    are frictionless because a free ball rolls, but this is the ball that could NOT move, and at
    zero a robot stalled square on a wall ball yawed 12° on numerical asymmetry alone. A robot
    then stalls on a dead-centre artifact and an off-centre one squirts out of the squeeze, from
    the geometry, with no pin rule written by hand. Only a DEAD-SQUARE hit on a wall ball stops
    the robot: at 8° or 15° off square the ball is squeezed out along the wall and the robot
    drives on, whether it meets the flat back of the chassis or a funnel intake with a full
    hopper (the ball slides across the wedge and pops out the far side).
  - **THE CONTAINMENT CLAMP RUNS INSIDE THE LOOP** (`BALL_CONTAIN_SLOP`), so the pin test sees
    an artifact where it will actually end the tick; a pin was missed on its forming tick when
    the solver split the squeeze into the wall and the clamp ran after the test. Anything
    solid an artifact can be pinned against belongs in `clampBallPosToStatics`, or the pin
    test cannot see it.
  - **THE STALL IS HONEST FRICTION, NOT A SCRIPT.** The lateral velocity clip after the robot
    solve distinguishes STOPPED BY A CONTACT from SLUNG SIDEWAYS — it used to restore the
    commanded strafe a contact had just refused, creeping a stationary robot into pinned
    artifacts while reporting −34 in/s. Two artifacts left COINCIDENT (a test parking balls
    off-field, a spawn on a spawn) get a hashed-direction kick (`BALL_COINCIDENT_KICK`),
    because the solver has no normal between two circles at one point, and a doorway buzz was
    exactly that pair. `lastTickRounds` (world.ts) says how many rounds the last tick ran — a
    test hook, not state.
  - **ARTIFACTS COLLIDE LIKE BALLS** (the second pass, Sept 2026 — "artifacts feel stuck to
    each other and to the wall; they don't leave the line they form coming out of the gate";
    "the artifacts do not behave like a 2d collision"). Two defects in the artifact world's
    CONTACT MODEL, neither in any pass:
    1. **In-plane friction on a rotation-locked circle is a drag that on a real rolling ball
       would be spin.** At `PHYS_BALL_FRICTION` 0.7 a glancing hit sent the struck ball off at
       3° where the contact normal was at 30°, a 45° wall bounce kept a quarter of its
       along-wall speed, and 70% of the moving contacts in a gate drain were pairs travelling
       together. Ball-ball, ball-wall and ball-bumper friction are ZERO now (0.05 still jammed a
       squeezed ball: the solver's penetration recovery puts an enormous normal impulse into a
       squeeze, and a twentieth of that as friction cancelled 165 in/s of sideways speed);
       rolling resistance with the floor (`BALL_ROLL_FRICTION`) is a separate term and unchanged.
    2. **Rapier applies NO restitution on a speculative contact.** The gap is closed as a
       velocity clip and the bounce is computed from whatever approach is left, so with the
       artifact world looking 3.5in ahead every hit landed at ~0.14 for a set 0.68 (ball) and
       0.5 (wall), at every speed, stiffer contacts making it worse (0.03) and CCD changing
       nothing. A ball rear-ending the one ahead merged with it instead of shoving it on —
       that is the train. The look-ahead STAYS (it is what lets a chassis push a chain of
       artifacts in one pass without burying the first, and what makes "still inside after the
       solve" mean "could not move" — a day at Rapier's default with a bumper skin brought the
       bounce back and a tick-by-tick chain of burials with it, 0.6in in the chassis and 1.7in
       ball in ball) and the bounce of an IMPACT is computed BEFORE the solve, exactly, by
       `bounceFirstContacts`: a pair not yet touching (`BALL_FIRST_CONTACT_GAP`) that will meet
       within `BALL_FIRST_CONTACT_LOOKAHEAD` ticks gets the equal-mass restitution impulse
       along the normal where they meet; against the field the predicted position is asked of
       `clampBallPosToStatics`. 1.5 ticks, not one, because the speculative constraint starts
       clipping a closing pair the tick BEFORE they touch (0.49 for a set 0.68 at one tick).
       Touching pairs are sustained contacts and the solver's; the solver's own restitution
       stays set and acts only on a contact this pass did not see. Measured 0.67 / 0.47.
    Consequences that had to follow: the pin needs something behind the artifact and moves with
    it (above); a CLAIMED artifact meets the chassis face like any other (the claim used to drop
    the chassis from its filter and a pile behind pushed a claimed ball 2.6in through the face
    while its capture timer ran — and the chassis must list `A_CLAIMED` in ITS filter, or the
    pair never collides); `clumpDrag` measures contact through the same `artifactSolids`
    (`BALL_PUSH_CONTACT`); and the per-contact scatter kick in `scatterBalls` is GONE — it was
    standing in for collisions that did not work, and with them honest it made the drain's
    spread WORSE (minor/major axis ratio 0.53 with it, 0.73 without) and kept four balls
    jittering at ten seconds where without it every ball came to rest. The nine-ball drain
    went from a 5in-pitch line on the wall (ratio 0.01, 9 on the wall, 8 touching pairs) to
    ratio 0.73, 4 on the wall, 3 touching. Smoke pins the restitution, the glancing-hit
    normal, the wall bounce, the drain's spread (a 2D pile in the corner now, not a line), a
    ram into a free clump not stalling, a parked robot not being shoved by a fast artifact, an
    empty robot taking three from a pile of eight and shoving the rest at full speed, and a
    wall ball caught by the flat back a few degrees off square squirting out.
- Wall/structure contacts apply **TORQUE** (summed over touching corners) so a tilted robot
  squares up flush. Torque is PRESSURE-SCALED (`CONTACT_PRESS_GAIN`); flat-face alignment is
  capped at the REMAINING TILT (`flushErr` in `pushRobotAt`) so the heading never steps past
  flush and buzzes, and at `CONTACT_ALIGN_RATE_MAX` so it can only ever ADD a little to the
  solver's own pivot, never out-turn it. The impact flick is zero — see the rotation note above.
- **FRICTION IS TWO WORLDS, AND THE ROBOT ONE IS BUMPER-REALISTIC.** `PHYS_FRICTION` 0.45 is
  the ROBOT collider and `PHYS_WALL_FRICTION` 0.35 the field statics in the robot solve
  (`statics()` must set it — it once ran on Rapier's default 0.5 while the constant's comment
  claimed to cover walls); the artifact world runs `PHYS_BALL_FRICTION` and
  `PHYS_BALL_WALL_FRICTION` at ZERO, because in-plane friction on a rotation-locked circle is a
  drag that on a real rolling ball would be spin (see ARTIFACTS COLLIDE LIKE BALLS above); only
  the PINNED circle in the robot solve keeps some (`PHYS_PIN_FRICTION`), being the ball that
  could not roll. The robot values came DOWN from 0.7/0.5 with the rewrite, and that is an OWNER-VISIBLE calibration: with honest Coulomb
  friction a stalled motor pushes with full stall force at any throttle, so at 0.7 a
  full-throttle press by an equal or heavier robot held a strafing victim outright. Relevant
  when someone reports "I cannot escape a push": a robot pressed into a wall sticks by COULOMB
  stick/slip (friction ∝ the normal force, which the victim's own into-wall command adds to),
  so escape collapses sharply once it presses in. Lowering wall friction only MOVES that
  threshold, it does not remove it; G422's `held()` smoke scene uses the weakest legal holder
  for exactly that reason.
- `robotIntersectsRect` (SAT) exists because thin zones can be fully covered by a robot body
  with no corner inside.

## Robot spec, builder, and drive feel

- ⚠️ **TOGGLE BUTTONS ARE DEBOUNCED** (`debouncedPress`, `src/sim/robot.ts`; `TOGGLE_DEBOUNCE_S`
  2.5 ticks). A release shorter than that is a dropout: replay 1dc6eb8f held a toggle through a
  one-tick all-zero input frame, and it flipped twice. Butterfly `driveMode` and the BIOBUZZ ramp
  both use it; a new toggle should too. The latch keeps `…UpAt` while it waits.

`RobotSpec` is shared by both games; some fields are game-specific and optional.

Shared: `name`/`teamName`/`teamNumber`, `length`, `width`, `intake` (`IntakeStyle`), `massLb`
(20–42), `drivetrain`, `driveRpm` (200–600), `flywheelInertia` (0–1), `canSort`.
Chain-only (optional, defaulted in `coerceSpec`): `ballStorage`, `groundClearance`,
`scoreMode`, `chainIntake`, `intakeMount`, `shooterMount` (+ two deprecated mirrors).

- **`coerceSpec` (`src/sim/spawn.ts`) is the single sanitizing chokepoint** and is
  IDEMPOTENT — run at settings load, server ingress (`net/sanitize.ts`), AND `createWorld`.
  Its clamp order is deliberate and mirrors the builder's dependency graph:
  intake+drivetrain → size, drivetrain → rpm, inertia → 0..1, drivetrain×inertia → mass.
  Specs arrive from hand-editable localStorage AND untrusted clients — people have spoofed
  oversized/NaN robots. **Every new spec field must be clamped/enum-checked here.**
- The builder's slider envelopes come from the SAME limit functions (`massLimits`,
  `rpmLimits`, `lengthLimits`, `widthLimits` in `drivetrain.ts`), so the UI can't offer an
  illegal value the coercer would then rewrite.
- **`chassisColor`/`accent`/`decal`/`plate` (`src/cosmetics.ts`) are the four cosmetic axes**,
  clamped here by `clampCosmetics` exactly like every other enum field — SHAPE only, an
  unrecognised key falls back to `base`'s own value if that is itself legal, else the hard
  default. Deliberately **NO entitlement check in `coerceSpec`**: this function also runs over
  REPLAY RE-SIMULATION, and baking a tier check in here would downgrade an old replay's look
  to whoever is watching it TODAY the first time a membership lapses or a key is re-tiered.
  Entitlement (`stripUnentitledCosmetics`) is a separate step the server's live ingress runs
  AFTER this clamp — `server/index.ts` (join, ranked queue) and `server/room.ts` (`update`) —
  see `docs/area/accounts.md` and `docs/cosmetics-plan.md` §3.3. Never touches physics: a
  smoke check pins `worldHash` bit-identical across every cosmetic combination.

### Drivetrain feel — REAL-MOTOR model (`BALANCE_VERSION` 2)

ALL drivetrain/motor knobs live in ONE documented `DRIVETRAIN & MOTOR BALANCE` block in
`config.ts` (edit there; `npm test` prints the `driveSummary` table so a tweak's effect is
visible). Grounded in real hardware: `SPEED_PER_RPM` is DERIVED from a **104 mm goBILDA
wheel** free-speed geometry × `DRIVE_EFFICIENCY` 0.95 → **~89 in/s at 435 wheel-rpm**. The
modeled motor is the **MATRIX / goBILDA 5000-series 12VDC** brushed motor (5800 rpm free,
20.45 oz-in stall) — its LINEAR torque–speed curve IS the `motorStep` model.

- **PEAK accel is TRACTION-limited (μ·g), NOT motor-limited** — stall torque could give
  ~460 in/s² but the wheels slip first, so `BASE_DRIVE_ACCEL` 240 × accelMult lands each
  drivetrain at its μ·g ceiling (tank μ≈0.9 → 348 … x-drive omni μ≈0.45 → 175).
- **MOTORS follow a torque–speed curve** (`motorStep`, used for fwd/strafe/turn): full stall
  accel off the line, falling ~linearly to `MOTOR_MIN_TORQUE_FRAC` at free speed
  (`MOTOR_TORQUE_CURVE` 1.0 = physically real), so speed approaches the top asymptotically
  (~0.5–0.8 s to 95%); braking pulls harder (`MOTOR_BRAKE_MULT`).
- **Mecanum is realistically LOSSY** (per GM0 rollers): speed 0.87 / strafe 0.80 / accel 0.88 /
  **push 0.65** — it loses straight-line speed AND gets shoved by tank. Realistic orders:
  speed tank>swerve>mecanum>xdrive · push tank>swerve≫mecanum>xdrive · accel
  tank>swerve>mecanum>xdrive (@435 rpm: speed 89/84/77/74 in/s; peak accel 348/312/211/175).
- Four wheel-saturation models: mecanum/xdrive `|f|+|s|+|ω|`, tank `|f|+|ω|` (strafe DEAD —
  left stick/W-S left side, right stick/Up-Down right side), swerve `hypot(f,s)+|ω|`.
  `maxTurn = wheelSpeed / halfDiagonal`, capped at `TURN_MAX_SPEED`. The mecanum
  wheel-saturation model is correct physics — keep it.
- **SWERVE = FOUR INDEPENDENT modules** (`RobotState.moduleAngles[4]`, FL/FR/BL/BR): real
  per-module inverse kinematics (target vel = translation + ω×r), WPILib-style module
  optimization (a >90° change FLIPS the pod + REVERSES drive, `MODULE_SLEW_RATE` 7), and
  forward kinematics of the pods for the achieved chassis motion. **Balancing weakness is
  WOBBLE, not weight** (a heavy-swerve nerf was tried and reverted): each module's control
  loop is imperfect (`SWERVE_WOBBLE_AMP`/`_FREQ`, INDEPENDENT phase per pod) → real path
  drift + yaw wobble driving straight. **X-drive renders as a DIAMOND, not an X**: the omnis
  are at ±45° but lie ACROSS their corners, not along the diagonals. Both renderers had them
  radial — every wheel aimed at the centre, which is a machine with no moment arm and so no
  yaw at all — and that is what read as an X. Fixed in BOTH `src/render/drawRobot.ts` (which
  DECODE's builder preview also uses, since it renders a real `RobotState`) and
  `src/games/chain/parts.ts`; CR's builder preview was already correct. Keep the two in step.
- **NICHES:** tank raw power/no-strafe · swerve strongest-but-imprecise · mecanum
  light/instant/precise but weaker · x-drive deliberately-weak novelty.
- **PUSHING POWER IS A FORCE, and the collider mass is DERIVED from it** (`drivetrain.ts`):
  `pushForce = massLb · BASE_DRIVE_ACCEL · pushMult · rpmPush · (1−powerDraw)` (traction-
  limited, so weight is a real term), `rpmPush = clamp(REF_DRIVE_RPM/driveRpm, PUSH_RPM_MIN,
  PUSH_RPM_MAX)`. **`shoveMass = pushForce / accel`** is what `physicsEngine.setMass` gets.
  The division is the whole point: the sim pushes by SETTING VELOCITY, so the delivered force
  is `mass × accel`, and `driveParams().accel` already carries `REF_MASS_LB/massLb`,
  `REF_DRIVE_RPM/rpm` and `1−powerDraw`. Writing the shove straight in as a mass therefore
  cancelled weight entirely (20 lb and 42 lb both delivered 5591) and applied gearing and
  power draw twice (7.45× rpm spread instead of 2.48×, ×0.64 instead of ×0.80) — a 250 rpm
  minimum-weight mecanum out-pushed a 42 lb 435 rpm tank. **Never add a factor to `pushForce`
  without checking whether `accel` already has it.** `driveParams.accel` still uses REAL mass,
  so the shove never touches linear accel.
  **ONE NUMBER, THREE JOBS**: Rapier reads `shoveMass` for the sustained shove, for a ram's
  momentum split, and for the positional split of an overlap, and the pair impulse reads it
  for rotational inertia. It is push AUTHORITY, not weight — and because `accel ∝ 1/massLb`,
  it comes out ∝ massLb², so a 2:1 weight difference separates ~4:1 on a seeded overlap. That
  is the price of `accel` staying motor-limited (heavy = sluggish) while push stays
  traction-limited (heavy = stronger); one Rapier mass cannot be both, so it is the pushing one.
  `driveSummary()`'s `push` column prints the real force, not `pushMult`.
- **Per-drivetrain CLAMPS** live in `DRIVETRAIN_LIMITS`; the mass FLOOR is raised by flywheel
  inertia (`INERTIA_MASS_FLOOR` 14) via `massLimits(dt, inertia)`.

