<!-- governs: src/games/decode/**, src/sim/goal.ts, src/sim/penalties.ts, src/sim/field.ts -->
# GAME: DECODE

⚠️ DECODE's rules live in `src/sim/` and `src/config.ts`, not in `src/games/decode/` — they predate the game seam and were deliberately not relocated. Field geometry, start poses, the ball lifecycle, the gate lever, shooter and intake, and the penalty engine.

*Split out of `CLAUDE.md` on 2026-09-16, **verbatim** — CLAUDE.md is loaded into every
session and this is not needed by most of them. The `governs:` line above is read by
`scripts/docaudit.mjs` and by the editor hook, so keep it accurate when paths move.*

---

# GAME: DECODE (`decode`)

DECODE's rules live in **`src/sim/`** and **`src/config.ts`** (they predate the seam and were
deliberately NOT relocated); `src/games/decode/` is a thin module that points at them.
`src/config.ts` is the single source of truth for ALL DECODE geometry, physics, and scoring
constants. Tune there, not inline.

## Field geometry — verified, do not "fix" from intuition

Measured from the official Competition Manual Section 9 figures (extracted the embedded
images from the PDF and pixel-measured them). See `docs/decode-reference.md`. Facts people
get wrong:

- World frame: origin center, +x = audience's right, +y away from audience. Inches.
- **Goals are cross-court**: BLUE goal far-LEFT corner (tag 20), RED far-RIGHT (tag 24).
  Red alliance wall = left (x=−72), blue wall = right (x=+72).
- Driver view rotation: `viewAngleOf()` in `src/sim/field.ts` — blue looks from the right wall
  (−π/2), red from the left (+π/2). Camera AND driver-frame input both use it.
- Launch zones are **shared** (not per alliance): big triangle `y >= |x|` (apex at field
  center) + small audience triangle. Any robot part inside ⇒ may launch.
- Each goal's classifier channel runs down the adjacent side wall to a gate near mid-wall
  (y≈0); released/overflow balls roll out beneath it toward the audience.
- **GOAL FOOTPRINT is a right triangle in the corner, NOT a symmetric 45° face**
  (`smoke.ts` asserts it): legs flush along the walls — `GOAL_FACE_WIDTH` 26.5" along the far
  wall, `GOAL_DEPTH` 18.3" down the side wall, right angle at the field corner. The FACE
  robots shoot at is the hypotenuse (`GOAL_FACE_LEN` ~32.2", ~34.6° off the far wall).
  `goalTriangle`/`goalFacePoints`/`goalFaceNormal` (unit normal into the field)/`goalCenter`.
  **`goalLineValue` returns TRUE perpendicular inches** from the face (>0 behind, inside the
  footprint; <0 field side) — do NOT divide by SQRT2 anywhere.
- Spike marks: horizontal 10" tape at x=±48.5 — ONE tile (~23.5") from the side wall; rows
  y = −35.5 / −12.8 / +11.1, 3 balls per row (GPP / PGP / PPG near→far). BASE zone 18×18,
  corners at (d·24,−48) & (d·42,−30), `BASE_CENTER` (d·33,−39), d = driverSide (blue +x,
  red −x). Loading zones = audience corners, 23×23.
- GATE ZONE: the real marking is TWO thin alliance-colored tape LINES, 10" long, 2.75" apart
  (`GATE_TAPE_W`), starting at the classifier edge (x=±66) and running into the field
  (`gateTapeSegments`). The larger 10×5 `gateZone()` INTERACTION rect works the gate and is
  intentionally undrawn (feel > strict tape).
- DEPOT tape runs flush ALONG the goal face (the hypotenuse) from the far-wall corner to the
  classifier edge — it does NOT run through the channel (`depotSegment` clips at the
  classifier). Band `DEPOT_DEPTH` 6"; band fill is not drawn (white tape line drawn last).
- SECRET TUNNEL: `TUNNEL_W` 6.125" (its own constant, not `CLASSIFIER_W`). `tunnelStrip(X)` is
  beneath X's goal but belongs to the OPPOSING alliance (whose drive team is on that wall).
- ALLIANCE (drive-team) AREAS are NOT DRAWN (removed to enlarge the field); the `allianceArea`
  helper stays (96×54 outside each wall) for zone logic. `VIEW_MARGIN` 14; the camera reserves
  HUD bands (`HUD_TOP`/`HUD_BOTTOM` in camera.ts) so chips never cover the field.

## START POSITIONS — configurable + rulebook-constrained (G304)

A robot may start on any pose satisfying **G304** (Section 11): (A) footprint OVER a white
LAUNCH LINE, (B) TOUCHING the GOAL or the FIELD perimeter, (C) fully within its own half
(blue x≤0 / red x≥0) — PLUS the collision box may only rest AGAINST a solid, never penetrate
it. All in `src/sim/field.ts`: `evalStartPose(spec,pose,a)→StartLegality` (footprint =
chassis+intake via `footprintExtents`/`footprintCorners`, SAT tests), `snapStartToLegal`,
`mirrorStartPose` (canonical goalSide=+1 ↔ actual, self-inverse), `startPose(a,index,custom?,
spec?)`. Tolerances `START_TOUCH_TOL`/`START_PEN_SLOP`.

`START_POSES` (GOAL·FAR / AUDIENCE / GOAL·GATE) are **semantic ANCHORS resolved DYNAMICALLY
per chassis** via `presetPose(index,a,spec)` — a preset is legal at ANY size, not a fixed
coordinate. **Anchor index 0 & 1 MUST stay far apart** (a 2-robot alliance spawns slots 0/1 —
smoke-checked). Custom poses ride `RobotSetup.startPose`/`GameSettings.startPose`/
`LobbyPlayer.startPose`, sanitized by `coerceStartPose` + snapped legal at `coerceSetup`.

UI `src/ui/StartPositionEditor.tsx`: a CANVAS reusing the real `drawField`/`drawRobot`
renderers + drag/rotate + X/Y/heading inputs; snapping is OPT-IN (default OFF) and an illegal
pose is previewed red but NEVER saved. **Starts split CLOSE vs FAR** (by distance to goal):
a per-player SAVED library (`savedStartPoses{close,far}`) + `startMemory` + `startCat`, with
pure patch-helpers in `src/ui/startPositions.ts`. In a 2v2 the robot's role LOCKS the category
(1st on the alliance by clientId = CLOSE, 2nd = FAR). Editor gotcha: a preset pick must be ONE
settings patch (`selectStart`), never two `set()` calls (stale-closure overwrite drops one).
**ROLE is SWAPPABLE by mutual consent** (`useRoleSwap.ts` + `RoleSwapBar.tsx`): a two-flag
handshake (propose→accept; when both set, each client flips ITS OWN role, race-free). Decline
is LOCAL-only.

## Ball lifecycle (no teleporting — user is emphatic)

flight → (crosses opening plane, either direction) → **basin** (jumbles inside the goal wedge
with real containment/collisions, funnels to the SQUARE when slow) → **rail** (1D flow down
the classifier, gravity + contact stacking, position always continuous — hand-offs preserve
position and blend onto the rail line) → gate exit → ground. Overflow rides OVER the stack at
`OVERFLOW_Z` and always exits.

**Classified-vs-overflow is decided at CONTACT, not at hand-off** (user was explicit): a ball
boards the rail as `pending`, and only when it first meets the column (or gate floor) does it
commit — 9 retained below it at that instant ⇒ overflow (1 pt), else classified (3 pts).
Scoring happens at that decision moment, so a gate tap that drains in time SAVES an incoming
ball. A pending ball that flows out an open gate untouched classifies at exit.

Stray balls must never enter goal wedges or classifier channels (solid to balls), and no
collision may ever push a ball outside the field (the containment clamp inside the round
loop). Balls have "mass" feel: robot→ball contact is near-inelastic, and a ball PINNED between
chassis and wall is a FIXED CIRCLE IN THE ROBOT SOLVE (see `docs/area/physics.md`) — the robot stalls on a
dead-centre pinned ball while off-centre balls squirt out of the squeeze, from the geometry
rather than from a hand-written pin rule.

## Gate physics (manual 9.8.3, `updateGates` in goal.ts)

The gate is a PHYSICAL class-1 LEVER, not a boolean: continuous `GoalState.gatePos`
(0 closed .. 1 lifted) + `gateVel` + `gateLatch`. **Geometry (Figure 9-15):** it HINGES at the
classifier edge where the gate-zone tape starts (|x| = `FIELD_HALF − CLASSIFIER_W`) — a SHORT
handle (`GATE_ARM_SHORT`) pokes OUT into the gate zone (what a robot pushes) and a LONG paddle
(`GATE_ARM_LONG` = `CLASSIFIER_W`) lies ACROSS the channel, covering the artifacts.

- **Opening is ONE-DIRECTIONAL** (`pushingGate`): only a STRAIGHT push toward the wall opens it
  (`velToward = r.vel.x·goalSide`); driving SIDEWAYS along the wall does not, and loitering
  does not.
- **A tap COMMITS it fully open** and the driver need not keep pressing — but the arm is
  PINNED only while a robot is on it (a push, or resting against an already-OPEN arm:
  touch-hold). "Stays open a beat" is the FALL, not a timer: `GATE_OPEN_LATCH_S` is now just
  the arm's mechanical OVERSWING (0.08 s), and gravity needs ~0.23 s to bring it from full
  lift back to `GATE_PASS_FRAC`. It is **closed by gravity** — it SWINGS shut
  (`GATE_GRAVITY`/`GATE_CLOSE_MAX`), never snaps. (Was a 0.5 s pin at maximum lift with
  nothing touching it, which a hinged arm cannot do and which made a tap empty the whole ramp.)
- **THE ARM CANNOT HOVER — it rests on what is under it.** An unheld arm falls until it lands
  on the flow. `gateRestOn(d)` is the geometry: the paddle's edge comes down the vertical at
  `GATE_LINE_S` and meets an artifact's surface at `R + sqrt(R²−d²)`, mapping the
  full-diameter case to **`GATE_SEAT_FRAC`, which is BELOW `GATE_PASS_FRAC` on purpose** —
  seated on an artifact is the marginal contact, so being under the arm is NOT being past it.
  Getting past takes MOMENTUM (`GATE_SHOULDER_LIFT`, ≈25 in/s to stay passable, capped at
  `GATE_RIDE_FRAC`). Hence: **HELD ⇒ streams (paddle clear, no drag); TAPPED ⇒ a few
  artifacts then the arm settles onto the column and the drain GIVES OUT** — one tap never
  empties the ramp, and how much it is worth depends on how the column is packed.
  Equating seat with pass is the trap: the gateway window (8.5") is wider than the artifact
  pitch (5.1"), so a packed column always has something under the arm and would hold itself
  passable forever.
- **WHICH SIDE the paddle landed on decides the outcome.** `d > 0` (not yet through) ⇒ the arm
  rests on the artifact's downhill face and WEDGES it — frozen until someone works the lever
  (its own clamp in `updateRails`; the solver's gate floor sits at `GATE_STOP_S` and does not
  reach). `d < 0` (mostly through) ⇒ the arm is on its uphill face and `GATE_PADDLE_SHOVE`
  squeezes it out, the gate falling shut behind it. `GATE_PADDLE_DRAG` (×`1 − gatePos`) is the
  paddle's weight on whatever passes under it. `paddleBearsOn` gates all of this and MUST test
  reach (`|d| < R`) first — `gateRestOn` returns 0 both for "arm flat" and "artifact nowhere
  near", so without it every artifact on the rail reads as in-contact whenever the gate is
  shut and the ENTIRE rail freezes. `gateOpen` is DERIVED = `gatePos >= GATE_PASS_FRAC`.
- **The handle is a PHYSICAL one-way door** — a robot-only Rapier collider (`buildGateArms`),
  so a robot can't strafe THROUGH the closed lever; a straight push lifts `gatePos` and
  RETRACTS the collider so the opening robot glides in.
- **The lift is RAM-SPEED-SCALED and the retract is ANTICIPATED (no jolt):**
  `gateLiftRate(ramSpeed) = GATE_OPEN_RATE + GATE_OPEN_RATE_SPEED·ramSpeed`. `buildGateArms`
  runs one step BEFORE `updateGates`, so `gateColliderPos(world,dt,cmds,a)` anticipates the
  exact lift about to be applied and world.ts passes it into `solveRobots`→`buildGateArms` —
  the handle retracts on the SAME tick the push lands (this killed the old 1-tick jolt).
- Rendered (`drawGateArm`) top-down by FORESHORTENING each arm toward the pivot
  (`len·cos(gatePos·GATE_LIFT)`), the long paddle greening past the pass fraction.

## Shooter + intake (DECODE)

- **The TURRET never misses** (the paragraph below). A FIXED SHOOTER can — see "Fixed shooters"
  at the end of this section.
- **The shooter NEVER misses**: no dispersion; `solveShot` uses the MINIMUM-SPEED trajectory to
  the goal opening — the adaptive hood angle sweeps ~89° (near-vertical lob at point-blank)
  down to ~45° far out, so an exact finite solution exists at EVERY distance and the required
  speed is a SMOOTH function of distance (`v²=g·(dh+√(d²+dh²))`). The turret is always exactly
  on the lead-compensated solution (no slew limit). No aim ray drawn.
- **No flywheel spin-up before the FIRST shot** — the opening shot is always instant. BETWEEN
  shots the cadence is the intake preset's transfer interval (`INTAKE_PRESETS[*].fireInterval`:
  0.1 s, triangle 0.3 s) PLUS a flywheel-recovery term: `recovery = closeRecovery +
  FLYWHEEL_RECOVERY_MAX · shotNorm² · (1−inertia)`, where `shotNorm` ramps in only past
  `FLYWHEEL_CLOSE_SPEED`. FAR shots are slowed for low-inertia flywheels. **Close-range rapid
  fire carries a SMALL floor for near-zero inertia** (`closeRecovery = FLYWHEEL_CLOSE_RECOVERY
  · max(0, 1 − inertia/FLYWHEEL_CLOSE_INERTIA_KNEE)`): +0.04 s at inertia 0, fading to 0 by
  0.2 — a close-zone cycler wants a LITTLE inertia (~0.1–0.2), not 0. `r.fireReadyAt` gates it.
- **POWER DRAW**: a running intake plus the flywheel pull current off the drive motors. Two
  flywheel terms, both ×`flywheelInertia`: a small steady HOLD
  (`POWER_DRAW_FLYWHEEL_HOLD·spin`) and the DOMINANT SPIN-UP
  (`POWER_DRAW_FLYWHEEL_SPINUP·flywheelSpinRate` — the cost of ACCELERATING the wheel while
  driving AWAY from the goal; spinning DOWN is free). `flywheelSpin` ramps 0→1 with distance to
  the robot's OWN goal (`FLY_SPIN_NEAR`→`FLY_SPIN_FAR`); it seeds at the spawn-distance target
  so there's no phantom first-tick spin-up. `r.powerDraw` scales a LOCAL `driveParams` copy
  (speed/accel/turn ×(1−draw)) — `driveParams()` itself is untouched — AND weakens the shove.
- **The intake is physical**: the collision OBB extends by intake reach (`footprintExtents` →
  `robotExtents`) — it cannot clip walls/goals. THREE presets (**keep these user-given names**):
  **Sloped** (ramp, trapezoid mouth, devours clumps), **Vector wheel** (VERTICAL compliant
  wheels drawn as a row of small rects — never circles; chassis 11.5–14.5"), **Triangle**
  (TRIANGULAR internal storage — hopper pips draw in a triangle; longest reach, slower
  transfer). Internal keys sloped/vector/triangle ('compact'/'extended' migrate in settings).
- **CAPTURE MODEL**: each preset carries a `mouth` sub-object (`mouthHalf`, `throatHalf`,
  `wedge`, `drawIn`, `capMin`/`capMax`, `clumpInterval`, `dual`). Non-overhang presets clamp the
  mouth inside the frame so a full-width chassis geometrically forbids side intake. **Wedges
  FUNNEL** off-center balls toward the centerline via a lateral VELOCITY nudge only, never a
  position write — it runs before the ball solve so Rapier owns penetration. **Triangle takes
  TWO per cycle** (`dual`). NOTE: `halfWidth`/`perBall`/`clumpPerBall`/`wheelHalf`/`wedgeWidth`/
  `funnel` and the unreachable `sideTouch` flank grab were REMOVED — grep before reintroducing.
- ⚠️ **A HELD ARTIFACT MUST NEVER ADVANCE THROUGH THE WORLD — `HELD_SLIDE_SPEED` BEATS THE
  FASTEST LEGAL CHASSIS.** This is the actual cause of "the third ball is still being deflected
  too far", after two earlier bisections (restitution, then roll friction) had correctly ruled
  out the physics and the capture window. A held artifact is SOLID to ground artifacts
  (`robotSolids.held`) and is still out in FRONT of the chassis face while it slides to its
  slot, so at 45 in/s against a robot driving 85 the sim carried **the artifact the intake had
  just swallowed** forward through the world at 40 in/s, into the next artifact in the line —
  which, still touching the one behind it, chained the impulse straight on. Measured on a
  touching file of three at full throttle: the first went in clean and never moved, then balls
  two and three BOTH left at 73 in/s on the same tick, two ticks after the capture, and were
  shoved 32in downfield. At 150 the whole file goes in at ticks 39 / 43 / 47 with **peak
  artifact speed 0.0** on sloped and vector. Real hardware has no such problem because the
  rollers turn far faster at the surface than the chassis drives: what is grabbed is INSIDE the
  robot at once and cannot reach back out. Smoke asserts the RELATION (`HELD_SLIDE_SPEED >
  max driveParams().maxSpeed` over the whole legal envelope), not the number, so raising the
  rpm ceiling later fires the check instead of resurrecting the bug.
- ⚠️ **A HELD ARTIFACT'S SLOT IS INSIDE THE ROBOT, NEVER PROUD OF THE CHASSIS FACE**
  (`heldSlotPos`, physics.ts). Sloped and vector put the front one's SKIN at the roller line;
  TRIANGLE sat 2in further out at `hl + 2` until it was moved to `hl` (deep `hl − 4` → `hl − 6`
  with it), which is what made it the last preset still clipping the third artifact in a line
  — 74 in/s, against 0 for the other two — after the slide fix above. A slot proud of the face
  also puts a held artifact inside the WALL plane when the robot is tip-on to a wall, and holds
  a shoved pile 4in off its own footprint, out of reach of G408's contact test. ⚠️ Move BOTH
  triangle slots together or the deep-to-front spacing closes to 4.83in, under the 5in sum of
  radii, and the stored artifacts draw overlapping.
- **THE GRAB IS THE ROLLER NIP, AND IT IS ONE BAND FOR ALL THREE CAPTURE BRANCHES.**
  `intakeNip(spec)` about `intakeAxleX(spec)` (`config.ts`) is the whole fore-aft test; the
  branches (`atThroat` · `cornered` · `onRollerRow`) differ only in their LATERAL bound and
  their gates, which is where their identity actually lives. It comes out of geometry this
  file already asserted and the capture code never read: `intakeLidZ` puts the roller's
  underside at exactly `2·BALL_RADIUS`, the APEX of an artifact on the floor, so the axle is at
  `z = 2R + Rr`, the vertical separation from a floored artifact's centre is exactly
  `S = R + Rr`, and **a RIGID roller grazes it at ONE point — directly under the axle.** Every
  inch of grab is tread flex: with the tread reaching `c = INTAKE_TREAD_FRAC · Rr` past its
  circle, `|dx| <= sqrt(c·(2S + c))`, and `front = back + c` because ahead of the nip the
  loaded lobe flexes into the approaching artifact. Resolved: 72mm roller back 1.517 / front
  1.800, 48mm back 1.157 / front 1.346 — forward limit `tip + 0.38`, where the old branches all
  reached `tip + BALL_RADIUS`, i.e. the artifact's SKIN merely touching the roller's FRONT FACE
  with its centre a full radius out in front of the wheel. Reported as "the intake is a
  circular compliant wheel spinning… the ball should be directly below or very slightly in
  front of the center of the wheel… right now the range is way too big". Triangle's `atThroat`
  had ended 0.58in BEHIND its own axle, so that preset never grabbed at its wheel at all.
  - ⚠️ **`INTAKE_TREAD_FRAC` HAS A FLOOR AT ~0.135 AND BELOW IT TRIANGLE STOPS INTAKING.** A
    free ground artifact's centre can never get behind `hl + BALL_RADIUS` — the chassis is a
    LIVE collider against a CLAIMED artifact (`physicsEngine.ts`; the claim's only surviving
    effect is `skipChassis` in `pinnedArtifacts`) and `intakeSuction` pulls toward `(hl, 0)` —
    so everything the intake has hold of comes to rest with its skin flush on the front face.
    That seat is `BALL_RADIUS − reach + intakeRollerDia/2` from the axle, CHASSIS-INDEPENDENT:
    **+0.917 sloped · −0.055 vector · −1.083 triangle**, and the band must CONTAIN it. Measured
    settle 9.759 / 9.757 / 9.016 against an `hl + R` of 9.750 / 9.750 / 9.000, to five decimals
    over 40 ticks at both throttles. Smoke names the numbers.
  - **THE SUCTION TARGET STAYS `(hl, 0)` AND MUST NOT MOVE TO THE AXLE.** It is inert on sloped
    (the axle is 1.58in behind the face) and on vector (0.055in ahead, inside the 0.3in dead
    zone), and on TRIANGLE the axle is 1.08in in FRONT of the seat — it would push a seated
    artifact out of the throat. An intake that shoves artifacts away from itself.
  - **Timing depends on WHERE the ball enters**: `single = capMin + (capMax−capMin)·clamp(
    |localY|/throatHalf, 0, 1)`. ⚠️ **That denominator stays `throatHalf`** — the laterals did
    not move, `throatHalf + BALL_RADIUS·0.25` is exactly `atThroat`'s own bound, and the two
    WIDE branches deliberately clamp to 1 and pay `capMax`. Re-normalising it onto the wheel row
    makes `capMax` unreachable and silently deletes vector's centre-fast/edges-slow identity.
  - **THE SWALLOW IS 1–2 TICKS**, on the half-tick grid `(n − 0.5)/60` because the gate reads an
    ACCUMULATED `world.time` (an interval on a tick boundary is a float coin toss): sloped 1t
    centre / 4t edge / 1t clump · triangle 1t / 3t / 1t + `dual` (120 artifacts/s off a pile) ·
    vector 2t / 8t and NO clump bonus. ⚠️ **`drawIn` had to rise with them (40/32/70)** because
    the wedge presets are TRAVEL-limited, not interval-limited — the measured back-to-back gap
    on sloped was 0.133 s against a `clumpInterval` of 0.04, which is exactly why the 2026-09-10
    bisection found `clumpInterval` 0.04→0.02 with `capMax` 0.09→0.05 BYTE-IDENTICAL.
  - **The invariant is `capture ⊆ suction ⊆ claim`** (smoke, both chassis extremes of all three
    presets). `intakeClaims`' x geometry deliberately did NOT shrink with the grab: the nip is
    where an artifact is SWALLOWED, the claim is which artifacts the intake has HOLD of, and one
    crossing the mouth toward the seat must not be chassis-pinnable for not yet being under the
    wheel. `intakeSuction`'s `ahead` is now exactly `overIntakeRoof`'s front edge (`tip +
    BALL_RADIUS`), which matters because `drawIn` is above `INTAKE_LID_THROW` on every preset.
- **NO INTAKE (`intake: 'none'`) AND HAND LOADING** (`humanPlayer.ts` `handLoad`, 2026-10-02). The kit
  robot has no intake: its human player drops artifacts into it in the LOADING ZONE, which the manual
  allows for any robot (G432: "DRIVE TEAM members may load SCORING ELEMENTS into a ROBOT that is
  partially or fully in the LOADING ZONE"). `none` is a fourth `INTAKE_PRESETS` entry with reach 0 and
  an all-zero mouth, but every capture path is gated on `noIntake(spec)`, not on those numbers: no
  claim, suction, capture, roof or G408 mouth exemption; the footprint and the artifact solids are
  the chassis box (an import: its whole hull, `decodeImportSolids`); the three held slots are the
  standard line with the front skin at the face, inside a 15–18 in chassis (an import: on its
  centreline, packed closer if its hull is short). The human player hands one artifact per
  `HP_HAND_LOAD_S` (0.4 s) to a robot of its alliance with no intake that is partly in its own zone
  (`robotIntersectsRect`), under `HP_HAND_LOAD_MAX_SPEED` / `_MAX_TURN` and with hopper room, teleop
  and free drive only: from the box first, else a ground artifact off the zone's floor (no artifact is
  created or lost). It goes straight into the next slot. A hand-off is that tick's one action, so
  staging the grab row waits. **Robots with an intake are not hand loaded**, though the rule allows
  it: the human player stages the grab row for them as before, and a world without a no-intake robot
  steps byte-identically (the shared pins). Chain Reaction and BIOBUZZ coerce `none` to `sloped`. The
  touch pad drops INTAKE for it, the import editor has no intake span to place, and the DECODE
  tutorial swaps its intake step for a load step (drive into the zone, wait).
- BASE PARKING counts only the four WHEEL ground-contact points (`wheelContacts`, inset
  `WHEEL_INSET`): intake/turret overhang neither earns nor spoils credit. The turret never
  protrudes (`TURRET_OFFSET_FRAC`). The chassis may be NARROWER than the intake
  (`ROBOT_MIN_WIDTH` 10 < vector's 17).
- **AN IMPORTED ROBOT'S INTAKE** (`decodeImportMouth`, `src/sim/importedMech.ts`; the shared rules
  are `docs/area/physics.md` "Imported robots: mechanisms"). FRONT ONLY. The preset keeps the depth
  (reach, roller, nip, lid, cadences, the lip); the import moves the mouth to where its hull ends
  inside the placed span (`tip`), puts the face `reach` behind it and gives it the span's width
  (funnels `[throatHalf + 1.5, 9]`, vector `[5, 9]`), off-centre by `yc`. Every intake window —
  claim, suction, capture, roof, classifier guard — reads that one mouth with `local.y − yc`, so
  capture ⊆ suction ⊆ claim holds by construction. The artifact solids are the hull behind the
  face plus the standard wedge quads (or the hull flanking the mouth with its rails); held slots
  sit behind the import's own roller line on its centreline. The turret is the placed shooter,
  the launch height the placed `z`, never under 10.5 in (a lower release would be pushed out of
  its own hull by the flight-contact pass).

## Fixed shooters (`src/sim/fixedShot.ts`, `src/sim/flywheel.ts`, 2026-10-02)

Three optional spec fields, each ABSENT on every robot built before them, and absent means
today's turret path byte for byte (`decodeShotSpecial` is the one gate; smoke `FX_PINS` were
recorded before any of it existed):

| field | absent | present |
|---|---|---|
| `launcher: 'fixed'` | the turret aims itself | bolted to the chassis: fires along the heading (an import: plus `mech.shooterYawDeg`), so the ROBOT aims |
| `hoodDeg` (20–80, whole °) | the hood solves its angle | one angle |
| `flywheel` `{ mode: 'fixed' \| 'presets', rpm[1..3], wheelMm, feedS }` | the speed is solved | a setpoint wheel |

Whatever is not fixed is still solved (`decodePlannedShot`): a fixed hood with a solved speed
solves the speed for that angle; a setpoint wheel under an adjustable hood solves the angle (high
root first, 20–80°, 45° when out of reach). With both fixed nothing is solved: the artifact flies
the one arc, and the unchanged flight stage and `checkGoalEntry` decide the hit.

- **Read off the RAW input only** (`coerceSpec`, the `imported` rule): a client that switches
  back to a turret sends none of the three, and a fallback to `base` would keep them. Chain
  Reaction strips all three; BIOBUZZ keeps `flywheel` on its own fixed launcher only.
- **The wheel is state** (`RobotState.flyRpm`, whole rpm, written only for a `flywheel` build):
  it ramps to the setpoint at `FLY_RAMP_RPM_S` (slower with `flywheelInertia`), each shot takes
  `FLY_SHOT_DROP` (less with inertia), and the feeder runs only at `FLY_FEED_MIN_FRAC` of the
  setpoint (the kit OpMode's 1075/1125), `feedS` per artifact. The artifact leaves at
  `FLY_EXIT_EFFICIENCY · π · wheel · flyRpm / 60` — the speed at the feed, not the setpoint.
  Spawn seeds the wheel at its first setpoint (no spin-up before the first shot, the turret's rule).
- **`FLY_EXIT_EFFICIENCY` 0.40 is CALIBRATED.** A wheel rolling an artifact along a fixed hood
  gives it half the surface speed; 0.4 leaves a fifth of that to squeeze and slip. With the kit's
  hood at `DECODE_KIT_HOOD_DEG` 70°, it is the value at which the kit's own autonomous (drive
  against the goal, fire three) scores. Measured, muzzle to goal centroid along the face
  normal: the kit scores from **12–22 in** (rising through the opening, the against-the-goal shot:
  muzzle ≈ 18 in there) and **40–60 in** (falling into it); 24–38 and 62+ miss. 0.35 merges the
  bands (14–44); 0.45 moves the far one to 58–66.
- **Aim assist turns the chassis** while fire is held (`decodeFixedAimAssist`, a hook in
  `world.ts` before `updateRobot`, written into `rotate` AND the tank side drives — BIOBUZZ's stage
  2), lead-compensated over the arc's flight time; a held fire releases once within
  `decodeFixedAimTol`. **A driver's shot is not range-gated**: out of band it leaves and
  misses. **Auto fire** (the player default, every auto path) releases only a shot the flight
  stage, run forward (`decodeShotEnters`), says would score.
- ⚠️ **THE TURN IS A BRAKING PROFILE, NOT A P-GAIN** (`fixedAimTurn`, `src/sim/aimTurn.ts`, both
  games; 2026-10-02, after "the robot shakes constantly while shooting and its cadence is really
  slow"). Commanded spin `min(maxTurn, √(2a|e|), 15|e|)`, `a` half the chassis's braking authority
  (`FIXED_AIM_DECEL_FRAC`, `FIXED_AIM_SETTLE_RATE`, `driveParams`). The old `clamp(4.5·e)` with a
  dead band at the release tolerance parked the kit 0.045 rad off and crossed the aim on faster
  chassis: TW (mecanum) 30° → −0.074, Cypher (swerve) 30° → −0.16, 90° → −0.32. Now nothing in the
  drivetrain envelope crosses it, 10° to 172°, and each build ends within 0.02 rad (a swerve stops
  0.015 off: its pods ignore a command under 2 % of top speed).
  ⚠️ **Gated on `SIM_PATCH` 4**, with the feed clock's slack and DECODE's release tolerance: a
  replay recorded before steps the `*_PRE4` rules, and smoke holds five scenes to the old code's
  pins (`scripts/fixed-pre4-scenes.ts`). Keep both branches until a `SIM_VERSION` bump retires them.
- **The aim leads only the velocity along the driver's stick** (`decodeFixedLeadVel`). Pressed on
  the goal face, a turning chassis pivots on a corner and its centre moves sideways at about
  ω × the half-diagonal; leading that moved the aim against the turn (±0.1–0.18 rad every tick,
  6 in along the face). The release still carries the real velocity.
- **A tank's forward yields to the turn**, down to nothing at the release tolerance: its own push is
  what the face's square-up holds flush. 6 in along the face it chattered 0.05↔0.12 rad every 3
  ticks (4.03 shots/s); with the push kept on it stuck 0.28 rad off. Holonomic drives keep their
  stick, so pressed flush off-centre they cannot turn (TW never fires 6 in along, before or after).
- **The release tolerance is the opening's angle** at the muzzle (`decodeFixedAimTol`: half of
  `GOAL_OPENING_RADIUS` sideways; 0.11 rad at 50 in, at most 0.25 close in). The flat 0.06 was that
  offset seen from 8 ft.
- **The cadence is the feed's** (`flyFeedDue`): `world.time` is a sum of 1/60 and sat a few ulps
  short of `fireReadyAt` on the 12th tick, so most 0.20-s feeds took 13 ticks (4.68/s). Now 12,
  5.00/s from in band. The wheel's recovery (−10 %, back over the 95.6 % minimum in 2 ticks) is never
  the limit at inertia 0. Smoke: `fixed aim (DECODE)`.
- **Presets** step on `RobotCommand.flyPreset` (bit 1024, debounced edge; Z / R3, the mode-toggle
  role shared with BIOBUZZ's Deploy ramp). DECODE only: BIOBUZZ's fixed launcher runs one setpoint.
- **The kit card** (`ROBOT_PRESETS`, LAST so `DEFAULT_SPEC` still mirrors the first): tank 286,
  NO intake (hand loaded, see "NO INTAKE" above), frame 17 in, fixed launcher, hood 70°, 2411 rpm on
  96 mm, 0.20-s feed. Clamps: 13.5 lb → the 22-lb tank floor; width 16 APPROX.
- ⚠️ **THE KIT'S 70° IS AN EFFECTIVE ANGLE, NOT ITS GUIDE'S.** Measured on the kit's CAD
  (2026-10-02, the mecanum variant's STEP; the skid-steer kit's file is cut off at the source, and
  its assembly PDF matches the mecanum variant's launcher dimension for dimension): the ramps end in
  a straight vertical run bolted flat to a U-channel, so the artifact leaves at **90° ±2°**, 13.0 in
  up, 3.2 in behind the robot's front (the launcher end: the kit's auto starts with it against the
  goal, fires, then drives 4 in back). A 90° no-spin arc lands where it left. What carries the real
  artifact over the goal face is the spin of the one-sided pinch, which curves it toward the
  launcher end; `stepFlightBall` has no spin or drag. So the card flies the no-spin arc that lands
  where the kit's auto says it does, from the sim's release point (the turret's, a sixth of the
  length behind centre at `LAUNCH_HEIGHT`). Setting the guide's 90° would make the kit unable to
  score at all. The honest fix is spin in the flight stage, calibrated against a real shot.

## Scoring + multi-robot

Classified 3 / overflow 1 / pattern 2 per slot / leave 3 / depot 1 / base 5/10+10. PATTERN
shows only BANKED points (assessed end-of-AUTO and end-of-match — never a live matched count);
breakdown chips show artifact COUNTS, not points. `canSort` robots fire the hopper color
matching the next unfilled motif slot (else FIFO). A 2-robot alliance splits the 6 preload
balls (slot A `PRELOAD`, slot B `HP_INITIAL_STOCK`) and starts that alliance's HP stock empty.
Free-Drive has a "practice dummies" toggle (3 idle robots as obstacles).

## Penalty engine (`src/sim/penalties.ts`)

**MINOR = 5 pts, MAJOR = 15 pts** (these ARE DECODE's values — Section 16 glossary: a MINOR
FOUL is "a credit of 5 points", a MAJOR "a credit of 15 points", towards the MATCH point
total. An older note here claimed the manual said 10/30; that was a PREVIOUS season), awarded to the OPPOSING
(victim) alliance via `awardFoul` → the victim's `ScoreBreakdown.foulPoints`;
`match.fouls[offender]` tallies committed counts for the HUD.

- **G417** — TOUCHING an opponent's gate is an immediate **MAJOR**, edge-triggered on bumper
  contact with the gate ARM (`robotIntersectsRect(r, gateArmRect(a))`), **even if it never
  opens**. Deliberately DIFFERENT from `updateGates`' physical `pushingGate` (which also needs
  an active shove). Touching your OWN gate is legal.
  ⚠️ **The episode key is also G417.A's PATTERN RP award.** `decodeRankFacts`
  (`src/games/decode/rankFacts.ts`, a competition's measures) reports `patternAward` for the
  gate owner from any `penalties.episodes` key `G417:<owner>:<robot>`. Nothing prunes that map
  on a DECODE world; pruning or re-keying it silently takes the award away, so change both.
- **G418.B** — each classified artifact that LEAVES an opponent's RAMP because you opened their
  gate is a MAJOR **per artifact**. Billed **on the DRAIN, not on the touch**:
  `penalties.rampBallIds` holds last tick's committed non-overflow rail balls per goal and every
  id that is gone this tick costs the culprit one MAJOR — so the bill keeps running after the
  offender drives away (the flow finishes the drain), and a TAP that never lifts the arm past
  the pass fraction costs **G417 alone** (billing the standing column on contact was a bug,
  fixed Aug 2026). `penalties.gateCulprit` is pinned to an opponent who actually `pushingGate`s
  the arm, not to one merely brushing it, so an owner draining their own ramp is never billed to
  a leaning opponent. Both are reset whenever the phase isn't auto/teleop, so a drain across the
  frozen transition is nobody's foul. Matches manual Example 3.
- **Protected zones use one uniform model** — each zone is OWNED by an alliance and a
  cross-alliance CONTACT while either robot is in it fouls the NON-owner ("regardless of who
  initiates"): **G424 gate zone** (MINOR — opening the gate is legal for anyone; only in-zone
  *contact* fouls), **G425 tunnel** (MINOR — `tunnelStrip(a)` sits under a's goal but is OWNED
  by `other(a)`; fires only when the INTRUDER itself is in the strip). **G424.A gate↔tunnel
  exception**: they overlap in the classifier corner and are MUTUALLY EXCLUSIVE — if the gate
  robot is also in the opponent's tunnel it's G425 only, else G424 only.
- **G426 loading** (MINOR). **G427 base** (MAJOR in endgame + sets `RobotState.baseAwarded`).
- **G402 auto interference** (MAJOR): an alliance BELONGS on its **goalSide** (blue −x, red +x
  — NOT driverSide, which was inverted and fouled the alliance sitting on its own side); fires
  when fully on the opponent's side + contact during AUTO, on the CROSSER.
- **G408 over-possession** (MINOR **per ARTIFACT over the limit**, topped up as a pile GROWS
  inside one held violation, + a **YELLOW CARD** when excessive). DECODE defines exactly ONE
  term here — **CONTROL** — and the engine is written against it. It used to be written against
  an FRC-style **POSSESSION** and an invented **TRAPPING**, and *neither term exists in the
  DECODE manual*: there is no POSSESSION entry and no TRAPPING entry in the Section 16 glossary,
  the word TRAPPING appears nowhere in Section 11, and DECODE's PIN/PINNING is about opponent
  ROBOTS. (The quoted "TRAPPING" was PIN/PINNING with "opponent ROBOT" swapped for "SCORING
  ELEMENT".) Two invented tests were carrying most of the rule.
  The real definition: *"the SCORING ELEMENT is fully supported by or stuck in, on, or under the
  ROBOT **or** it intentionally pushes a SCORING ELEMENT to a desired location or in a preferred
  direction (i.e., herding). CONTROL requires contact ... either directly or transitively through
  other SCORING ELEMENTS. Typically ... A. The SCORING ELEMENT is fully supported by the ROBOT
  B. The ROBOT is moving the SCORING ELEMENT in a preferred direction with a flat or concave
  face of the ROBOT."* So there are two ways in, and `controlledArtifacts` is those two:
  - **A. FULLY SUPPORTED** is the hopper.
  - **B. HERDING** is `contactPush`: contact on a **flat or concave face** — a convex CORNER
    returns null, the one piece of clause B the engine had never modelled — with the robot's own
    rigid-body velocity at the contact (`robotPointVelocity`, ω×r included, so a SPIN counts)
    carrying it, and not backing away from it. Sustained past `POSSESSION_CONFIRM` while the
    artifact keeps its **station** (`POSSESSION_DRIFT`, measured in the ROBOT frame — a rigid
    rotation does not move it). The manual gives no numeric test for "intentionally", so the
    confirm window plus the station test are the sim's proxy for a referee's eye, and they ARE
    the BULLDOZING and DEFLECTING carve-outs: something clipped in passing never lasts, and
    something that bounces off leaves at once.
  - **CONTROL LATCHES WHILE THE ARTIFACT IS STILL GOING SOMEWHERE, AND AN ARRIVAL IS NOT A
    JOURNEY.** The per-artifact hold advances only while the artifact is still being taken
    somewhere (`POSSESSION_MOVE_MIN`) and DRAINS when it is merely being leaned on, even in
    full contact. Without that drain control latched on the way in and never released, so
    shoving artifacts against a wall billed once for the push — fair, you did herd them there —
    and then again every `POSSESSION_REBILL_S` for as long as you stayed, while nothing moved.
    Reported as "I still get penalties when I'm pushing forward against two balls against the
    wall... it counts as me moving them even tho its basically staying in place."  This replaced the invented TRAPPING branch and
    lands in the same place from the real text — a robot that drove a pile into the perimeter
    and sits on it is controlling the pile. A robot that never pushed anything never latches,
    which is how "I'm getting spammed with over-possession penalties just by standing still"
    stays fixed without a velocity threshold.
  - **"MOVING" IS A DISTANCE, NOT A SPEED** (`POSSESSION_CARRY_DIST`, 5in = one artifact
    diameter). Clause B's verb is about the artifact, so it has to have actually GONE somewhere,
    accumulated **along the direction the robot is taking it** — and that projection is the
    whole trick. A row already resting on the perimeter squirts SIDEWAYS out of the squeeze,
    quickly, while covering no ground in the push direction; a herded pile covers it steadily.
    So running into things is free and taking them somewhere is not, which is the two reported
    false positives ("a penalty if you go in too far" intaking, and "driving into five balls
    that are ALREADY at the wall") fixed without making a wall pin free.
    An instantaneous SPEED floor cannot do this and was tried first: artifacts do not RIDE a
    bumper here, they bounce off and are re-struck, so a jammed pile reads as moving fast while
    going nowhere — at the ball's own rest threshold it still billed 6 MINORs for driving into
    a wall row. Net directional distance is immune; jitter cancels.
    The two ABSOLUTE-speed gates this replaced (`POSSESSION_MOVE_SPEED`, `POSSESSION_TURN_RATE`,
    both from the FRC definition) leaked the other way too: a pile CREPT below 1.5 in/s drew
    nothing over twelve seconds. `POSSESSION_PUSH_MIN` is all that is left of them and sits low
    on purpose — it only keeps numerical noise in a resting contact from reading as a push.
  - **TOTAL TIME-TO-FOUL IS THE THING PLAYERS FEEL.** It is `POSSESSION_CARRY_DIST` (however
    long 5in takes to cover) + `POSSESSION_CONFIRM` + `POSSESSION_GRACE`, and it must be short
    enough to survive ordinary driving. Reported as "I still almost never get penalties" while
    pushing ~10 artifacts: that push DID foul, but only after **1.43s of UNINTERRUPTED
    herding**, and real driving (nudge, turn, adjust) rarely sustains that. Now **1.05s**
    (CONFIRM 0.65 → 0.45, GRACE 0.4 → 0.2) with every false-positive case still clean.
    **0.2 is the floor for GRACE** — at 0.1 the bulldozing carve-out breaks and clipping an
    artifact in passing starts to foul.
  - **`POSSESSION_CONFIRM` IS THE OTHER LENIENCY KNOB** (0.35 → 0.45s). Contact plus a fifth of
    a second cannot tell "taking these somewhere" from "arriving among them", which is what
    fouled a robot for nosing deep into a clump. Swept against the full case matrix, 0.65s with
    a 5in carry is the window where every case lands.
  - **AN ESTABLISHED HOLD KEEPS COUNTING WHILE IT DRAINS**, not only on the ticks the artifact
    is touching — and this is what makes the rule reachable at all. Artifacts do not RIDE a
    bumper here, they bounce off and are re-struck, so a herded pile is in contact only
    intermittently. Counting solely on touching ticks meant that the moment a driver STEERED,
    a robot pushing a six-clump controlled exactly THREE (its own hopper) for 97% of ticks and
    the rule never fired — reported as "when I just push a clump in open space it doesn't give
    me [the penalty]". The drain bounds it: an artifact stops counting a couple of confirm
    windows after the robot really has left it, and one that never established has nothing to
    drain. The carry distance is likewise STICKY across re-stations and across the hold dying,
    because ground already covered does not un-happen.
  - **CARVE-OUT C is the LOADING ZONE, scoped to the ROBOT being in it** — "inadvertent contact
    ... while attempting to acquire a SCORING ELEMENT **from the LOADING ZONE**". It used to key
    on the ARTIFACT's position alone, which made the whole 23×23 corner a control-free sanctuary;
    G432.D settles that it is not one ("ARTIFACT CONTROL begins when the ROBOT is in the LOADING
    ZONE, and ... is still CONTROLLED ... when the ROBOT leaves"). The separate mouth exemption
    (`POSSESSION_ACQUIRE_S`) is the SIM's own, not the manual's: the sim's intake is a multi-tick
    animation where a real one is instantaneous. It reads `cmd.intake || r.autoIntake`, the same
    condition that actually runs the intake — reading the raw button made the auto-intake assist
    HARSHER for its users than a driver holding it.
    **It is capped at what the ROLLERS TAKE IN ONE CYCLE** (one artifact, two for a triangle's
    twin slots), NOT at hopper room. Hopper room is the wrong axis and made the rule unreachable
    for anyone using the assists, which is the default: `autoFire` keeps all three slots empty
    and `autoIntake` keeps the exemption armed, so THREE artifacts were excused on every tick
    forever. Measured on a nine-clump herded in open space with `PLAYER_ASSISTS`: 2 MINORs with
    auto-intake on, 15 with it off.
  - **A ROBOT WITH AUTO-INTAKE GENUINELY CONTROLS FEWER ARTIFACTS**, and that is the count being
    honest rather than a bug — it is eating the pile as it pushes, so there is less of a pile.
    It is also why the wall is where players notice the rule: against the perimeter the
    artifacts pile up faster than the intake can swallow them.
  - **AN EXCUSED ARTIFACT CONDUCTS BUT IS NOT COUNTED.** Both halves matter: counting it anyway
    means the chain re-adds everything the mouth exemption just removed, and severing the chain
    means a robot nosing into a six-clump controls nothing at all.
  - ⚠️ **`controlledArtifacts` IS SHARED, AND ITS FOUR `ControlGeometry` SLOTS ARE THE ONLY
    THINGS IN IT THAT ARE NOT GAME-NEUTRAL** — `carveOut` (the LOADING-ZONE rect), `hopperCap`,
    `radius`, and `loose` (which artifacts are on the floor at all). **Every one defaults to
    DECODE's answer**, so DECODE passes no geometry and is byte-identical; a caller that passes
    none gets exactly the function this file describes. The newest is `loose`, default
    `b.state.kind === 'ground'`, and the reason it had to exist is worth knowing before adding a
    fifth: under a 3D solve that tag is DERIVED from height and motion each tick, so a PLOWED
    ball — which skips — reads `flight` on 14% of the ticks a chassis is pushing it, and BIOBUZZ's
    G407 could neither count it nor keep a clock on it. DECODE's planar solve has no skip and the
    tag and the fact agree, which is why this never bit here. See `docs/area/biobuzz.md`,
    "SECTION 11 — G407 OVER-CONTROL".
  - **EXCESSIVE is defined by the rule**: 5+ at once (clause A) or 3+ separate greater-than-
    MOMENTARY (glossary: "fewer than approximately 3 seconds", `MOMENTARY_S`) stretches of
    controlling 4+ (clause B — the manual reads "3 or more separate **violations** in a MATCH";
    an older note here invented a manual typo). G408 cards a robot at most ONCE per match, per
    its own "REPEATED excessive violations ... do not result in additional YELLOW CARDS".
  - ⚠️ **`POSSESSION_REBILL_S` IS A HOUSE RULE — G408 has no continuing clause.** Its violation
    line is one assessment, and the omission is deliberate: G422, G423 and G434 all carry
    "an additional MINOR FOUL ... for every 3 seconds in which the situation is not corrected",
    and G434's is the exact per-artifact shape. It is kept because billed once, the whole tariff
    for hoarding six artifacts was three MINORs and then free for the match ("the over-possession
    penalty is way too lenient"). Set it to `Infinity` for the rule as written.
  - **Deliberately still a foul**: RAMMING a wall row at full throttle and scattering it 40in
    along the wall. It covers the carry distance in the push direction, because it really did
    move those artifacts. NOSING into the same row at half throttle displaces the outer ones
    just as far and draws nothing, because they squirt SIDEWAYS out of the squeeze rather than
    covering ground where the robot is driving them — that projection is the whole distinction,
    and both sides of it are pinned in smoke.
  - **Known limit**: a robot WEAVING hard while pushing (±0.3 rad at 2 Hz) bats the clump apart
    and then genuinely controls only its own three, so it draws nothing. That is the count
    being honest, not the rule failing — but it does mean a flailing robot is cheaper than a
    tidy one.
  - **The per-(robot,artifact) clocks are SWEPT** when an artifact stops being a loose ground
    ball, and cleared outside auto/teleop. They were only deleted on the not-touching path, so
    an artifact that got INTAKEN kept its clock all match — unbounded growth in `world.penalties`
    (plain JSON, on every snapshot and replay) and, because ids are `max(id)+1` and
    `humanPlayer.ts` splices balls out, a stale key can rebind to a DIFFERENT artifact that then
    arrives pre-latched, skipping the confirm window that is the whole bulldozing filter.
- **CARDS** (`awardCard` in scoring.ts) attach to a ROBOT (a team). A second card from ANY rule
  ESCALATES to a RED, and a RED sets `ScoreBreakdown.voided` so that alliance's `total` reads 0
  while the breakdown still shows everything earned — the loss the card is meant to be. Shown
  as a HUD chip on the carded team and a forfeit line on the results screen.
- **G422 pinning** — written against the rule's own clauses, which the sim had drifted a long way
  from. "A ROBOT is PINNING if it is PREVENTING the movement of an opponent ROBOT by contact,
  either direct or transitive (such as against a FIELD element) and the opponent ROBOT is
  ATTEMPTING TO MOVE." So `isPinning` needs all of: contact · the victim attempting to move ·
  **the pinner IN THE WAY of where the victim is trying to go** (`PIN_OBSTRUCT_COS`) ·
  `pinnedAgainstWall`.
  - **"Preventing" is tested on the VICTIM'S INTENT, not the pinner's bearing**
    (`PIN_INTO_TRAP_COS`). Some test is needed, or a robot driving ITSELF into a wall fouls
    whoever is behind it — every other clause is satisfied and the opponent prevents nothing,
    and measured, the WEAKEST legal build "pinned" a default chassis that way. But the first
    version asked whether the PINNER lay along where the victim was trying to go, which is true
    of a straight reverse and FALSE OF EVERY SIDEWAYS EXIT — so a robot held flat against a
    wall and strafing to get out was ruled un-pinned however stuck it was. That is the ordinary
    pin, and it billed NOTHING: measured on an equal pair, a victim welded to the wall (1.1in
    in six seconds) drew 0 where the pre-rewrite code drew 1. It also contradicts the rule,
    which names the case — prevention "either direct or transitive (such as against a FIELD
    element)": pressed into a wall, the wall holds and the pinner supplies the press.
    So the ONLY thing excluded is driving further INTO the trap. Whether an escape attempt
    SUCCEEDS is then measured by `PIN_STUCK_SPEED` and criteria A/B, which is where it belongs
    — prevention is an outcome, not a stick direction. Measured after: a heavy tank holding a
    victim on the wall bills 6 MINORs over 20 s while a weak x-drive it strafes clear of bills 2.
  - **"Attempting to move" must read SIDE-DRIVE too** (`attemptDir`). It read only
    `driveX/driveY/rotate`, which a Traditional-tank driver on separate sticks never fills — a
    tank robot was never attempting to move and so could not be pinned AT ALL.
  - ⚠️ **A VICTIM DOES NOT HAVE TO BE STRUGGLING** (`PIN_PRESS_COS`), which is a DEVIATION from
    the rule's "and the opponent ROBOT is ATTEMPTING TO MOVE", in the same class as
    `POSSESSION_REBILL_S`. Reading that as "the stick is deflected this tick" is what kept the
    foul rare: somebody held against a wall stops working the stick long before they stop being
    held — they line up a shot, they wait, they give up — and a referee cannot see a stick
    anyway. So an idle victim is still pinned. The guard that REPLACES the struggle test is on
    the PINNER: it must be driving INTO the victim, because `rrContacts` is recorded on
    geometric overlap alone, so contact by itself says nothing about who is holding whom.
    Measured: idle victim 0 → 3 MINORs over 12 s, while an idle or passing-by opponent stays 0.
    Restoring the letter of the rule is returning that branch to `false`.
  - **A PIN DOES NOT NEED A WALL.** `pinnedAgainstWall` (which is NOT in the rule — a FIELD
    element is an example, "such as") used to be a hard requirement, kept as the only thing
    breaking the SYMMETRY of a shove. That made an open-floor pin draw nothing at all. Two
    clauses replace it, and between them they do the job better:
    **(a) the PINNER must be driving INTO its victim** — `rrContacts` is recorded on geometric
    overlap alone, so contact says nothing about who is holding whom; and
    **(b) a robot CORNERED against a solid is ESCAPING, NOT PINNING.** (b) is easy to miss and
    dropping the wall test without it silently cancels every wall pin there is: the victim held
    against a wall pushes BACK into its pinner, the reverse direction then also reads as a pin,
    and criterion C throws the pair out as mutual. Sixteen existing checks went to zero on
    exactly that. Stated directly it is the better rule anyway — a robot with a solid at its
    back and an opponent at its front is the one being HELD, and pressing toward the opponent
    is its only way out.
    Two robots meeting in open floor are both free to leave, so both qualify and criterion C
    correctly calls it the mutual shove it is. Measured mid-field, 58in from any wall: a light
    pusher holding a heavy idle victim bills 3 MINORs / 12 s with the victim at 0, while an
    idle opponent, one driving away, and an equal-chassis mutual shove all bill nothing.
    ⚠️ A stalemate test needs EQUAL chassis — a light pusher against a heavy victim is not
    mutual, the heavy one wins and pins the light one against the far wall, which is a real foul.
  - **The count ENDS only on the rule's A/B/C**, never on the hold merely lapsing: (A) 2 ft apart
    for >3 s, (B) either robot 2 ft from where the pin initiated for >3 s, (C) the pinner is
    itself pinned. A and B **PAUSE** the count first and it **RESUMES** — that is stated twice in
    the rule. A 0.6 s lapse timer used to end pins outright, so a pinner could wipe a
    two-and-a-half-second count by easing off for seven tenths of a second.
  - **Billing is MINOR, and another MINOR every 3 s it is not corrected.** Nine seconds is three
    MINORs. There is **no MAJOR escalation anywhere in G422** — the sim invented one. (G211 lets
    a Head Referee card egregious repeats; that is judgement, not this rule.)
  - `PIN_STUCK_SPEED` is the sim's own stand-in for a referee's eye on "preventing", measured as
    progress along the ESCAPE direction rather than raw speed — a victim bulldozed sideways along
    a wall is moving quickly and is no less pinned.
- **PENALTIES ARE ASSESSED IN FREE DRIVE.** `updatePenalties` runs for `auto`, `teleop` AND
  `freeplay`. `freeplay` is a live phase everywhere else in the sim — `robotsEnabled` says so,
  `humanPlayer` restocks in it, the shooter fires in it — and penalties were the one subsystem
  that excluded it, so the ENTIRE engine was off in the mode people actually practise in
  (measured: an identical six-clump herd drew 0 fouls in free drive and 13 in a match). Free
  Drive is DRIVER PRACTICE and practising without match fouls is the opposite of practice.
  Phase-specific rules stay inert on their own terms: G402 tests `phase === 'auto'` and
  `endgame` tests `phase === 'teleop'`, so neither fires in a mode with no auto and no clock.
  CR is unaffected — `updateChainPenalties` gates on `isAuto`/`isTeleop` explicitly, which is
  right for G05/G06. Ordinary free driving with practice dummies draws nothing (measured over
  45 s); a passive dummy can never be PINNED either, since it never attempts to move.
- **Fouls are EDGE-triggered — NO cooldown/timer** (user was emphatic): fire on the false→true
  edge, once while held, and AGAIN immediately on re-entry. `fire()` is idempotent within a
  tick. All penalty state is plain JSON.

---

