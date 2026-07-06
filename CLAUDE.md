# CLAUDE.md — DECODE 2D Simulator

2D top-down driver-practice sim for the FTC 2025-26 game **DECODE presented by RTX**.
Vite + React + TypeScript, Canvas 2D, zero runtime deps beyond React. Deploys to
Vercel zero-config; Electron wrapper for a desktop build.

## Session protocol

**At the end of every working session, write/refresh `HANDOFF.md`** (repo root): current
state (is the build green?), what was finished, exact next steps, and gotchas. Read it
at session start if it exists — it may describe uncommitted mid-refactor state.

## Commands

- `npm run dev` — dev server (localhost:5173)
- `npm test` — **headless sim verification** (`scripts/smoke.ts`, ~30 checks). Run this
  after ANY change to `src/sim/` or `src/config.ts`. It is fast and catches almost everything.
- `npm run build` — tsc (strict) + vite build. Run before claiming work done.
- `npm run electron` / `npm run dist` — desktop shell / Windows installer (`release/`)

## Architecture (load-bearing rules)

- **`src/sim/` is a pure deterministic state machine.** No DOM, no clock, no
  `Math.random`, no `Date`. It consumes per-tick `RobotCommand`s keyed by robot id and
  a seeded mulberry32 PRNG stored in `world.rngState`. This is the seam for future
  **2v2 multiplayer with real people** (a stated user goal): more robots = more
  `RobotState`s + command sources replayed into `step()`.
- `src/config.ts` is the single source of truth for ALL geometry, physics, and scoring
  constants. Tune there, not inline.
- `src/render/` and `src/ui/` only read world state. `src/input/` only produces commands.
- Fixed timestep 120 Hz (`SIM_DT`), rAF render loop in `src/game.ts` (GameController).
- HUD is React, polled at 10 Hz from `GameController.getHud()`.

## Field geometry — verified, do not "fix" from intuition

Geometry was measured from the official Competition Manual Section 9 figures (extracted
the embedded images from the PDF and pixel-measured them). See `docs/decode-reference.md`
for the full map and sources. Key facts people get wrong:

- World frame: origin center, +x = audience's right, +y away from audience. Inches.
- **Goals are cross-court**: BLUE goal far-LEFT corner (tag 20), RED far-RIGHT (tag 24).
  Red alliance wall = left (x=-72), blue wall = right (x=+72).
- Driver view rotation: `viewAngleOf()` in `src/sim/field.ts` — blue looks from the
  right wall (-π/2), red from the left (+π/2). Camera AND driver-frame input both use it.
- Launch zones are **shared** (not per alliance): big triangle `y >= |x|` (apex at field
  center) + small audience triangle. Any robot part inside ⇒ may launch.
- Each goal's classifier channel runs down the adjacent side wall to a gate near
  mid-wall (y≈0); released/overflow balls roll out beneath it toward the audience.
- **GOAL FOOTPRINT is a right triangle in the corner, NOT a symmetric 45° face**
  (corrected July 2026, `smoke.ts` asserts it): legs flush along the walls —
  `GOAL_FACE_WIDTH` 26.5" along the far wall, `GOAL_DEPTH` 18.3" down the side wall,
  right angle at the field corner. The FACE robots shoot at is the hypotenuse
  (`GOAL_FACE_LEN` ~32.2", ~34.6° off the far wall). `goalTriangle`/`goalFacePoints`/
  `goalFaceNormal` (unit normal into the field) / `goalCenter` (opening centroid).
  **`goalLineValue` now returns TRUE perpendicular inches** from the face (>0 behind,
  inside the footprint; <0 field side) — do NOT divide by SQRT2 anywhere (the old
  45°-face scaling was removed at every call site).
- Spike marks: horizontal 10" tape at x=±48.5 — that is ONE tile (~23.5") from the
  side wall (re-verified July 2026; an old "two tiles" comment was wrong, the value
  right), rows y = -35.5 / -12.8 / +11.1, 3 balls per row (GPP / PGP / PPG near→far).
  BASE zone 18×18, corners at (d·24,−48) & (d·42,−30), `BASE_CENTER` (d·33,−39) where
  d = driverSide (blue +x, red −x). Loading zones = audience corners, 23×23.
- GATE ZONE: the real marking is TWO thin alliance-colored tape LINES, 10" long,
  2.75" apart (`GATE_TAPE_W`), **starting at the classifier edge (x=±66) and running
  into the field** (`gateTapeSegments` → `[[Vec2,Vec2],[Vec2,Vec2]]` line pairs,
  drawn). The larger 10×5 `gateZone()` INTERACTION rect works the gate and is
  intentionally undrawn (feel > strict tape).
- DEPOT tape runs flush ALONG the goal face (the hypotenuse) from the far-wall corner
  to the classifier edge (x=±66) — it does NOT run through the channel to the side
  wall (`depotSegment` clips at the classifier). Band `DEPOT_DEPTH` 6" deep; band fill
  is no longer drawn (white tape line drawn last so the goal outline can't overdraw it).
- SECRET TUNNEL: `TUNNEL_W` 6.125" (its own constant, not CLASSIFIER_W), drawn with a
  colored outline. `tunnelStrip(X)` is beneath X's goal but belongs to the OPPOSING
  alliance (whose drive team is on that wall).
- ALLIANCE (drive-team) AREAS are NO LONGER DRAWN (removed to enlarge the field); the
  `allianceArea` helper stays (96×54 outside each wall, flush with the audience end)
  for zone logic / the coming penalty engine. `VIEW_MARGIN` 14 (bigger field); the
  camera reserves HUD bands (`HUD_TOP`/`HUD_BOTTOM` in camera.ts) so the score bar and
  chips never cover the field.
- The manual PDFs re-download from ftc-resources.firstinspires.org/ftc/game/manual-NN
  via WebFetch (saves the binary); scratchpad extract.cjs (text) and
  extract-imgs.cjs (figures) from this session extract them with Node stdlib.

## Ball lifecycle (no teleporting — user is emphatic)

flight → (crosses opening plane, either direction) → **basin** (jumbles inside goal
wedge with real containment/collisions, funnels to the SQUARE when slow) → **rail**
(1D flow down the classifier, gravity + contact stacking, position always continuous —
hand-offs preserve position and blend onto the rail line) → gate exit → ground.
Overflow rides OVER the stack at `OVERFLOW_Z` and always exits.
**Classified-vs-overflow is decided at CONTACT, not at hand-off** (user was explicit):
a ball boards the rail as `pending`, and only when it first meets the column (or gate
floor) does it commit — 9 retained below it at that instant ⇒ overflow (1 pt), else
classified (3 pts). Scoring happens at that decision moment, so a gate tap that drains
in time SAVES an incoming ball. A pending ball that flows out an open gate untouched
classifies at exit.
Gate physics: push opens it; **flow holds it open** (can't close while a ball occupies
the gateway), so a tap usually drains the whole column.

## Product decisions the user insisted on (do not regress)

1. **No flywheel spin-up before the FIRST shot** (the original product decision,
   preserved): a robot's opening shot is always instant. BETWEEN shots the cadence
   is the intake preset's hopper→shooter transfer interval
   (`INTAKE_PRESETS[*].fireInterval`: 0.1 s, except triangle 0.3 s — slower transfer
   is its stated tradeoff) PLUS a flywheel-recovery term (Phase B, in the approved
   plan). Recovery scales with the previous shot's energy and the robot's
   `flywheelInertia` (0–1 builder slider): `recovery = FLYWHEEL_RECOVERY_MAX ·
   shotNorm² · (1−inertia)`, where `shotNorm` ramps in only past
   `FLYWHEEL_CLOSE_SPEED`. So CLOSE-RANGE rapid fire is unchanged at any inertia
   (shotNorm≈0 ⇒ recovery≈0); only FAR shots are slowed, and only for low-inertia
   flywheels (high inertia ⇒ base cadence even at range). `r.fireReadyAt` gates the
   next shot in `robot.ts`. The DEFAULT robot (inertia 0.5) keeps a snappy burst.
2. **The shooter NEVER misses**: no dispersion; adaptive hood angle (55°→80°) so an
   exact solution exists at every distance incl. point-blank; turret is always exactly
   on the lead-compensated solution (no slew limit); opening accepts ascending entries.
   No aim ray / no dashed goal-tracking line drawn.
3. **Assists are menu-only**: field/robot-centric, aim assist, auto intake, auto fire
   are configured in the main menu — NO in-game toggle keybinds.
4. Auto-fire/intake must respect match phases (no firing during `pre`/`transition`).
5. **No popup toasts over the field** (they found them distracting) — events go to the
   muted left-edge log; zone status lives in the top-right chips.
6. HUD mimics the FTC live scoring display: red|timer|blue bar at the BOTTOM.
   Breakdown chips show artifact COUNTS, not points. PATTERN shows only BANKED
   points (assessed end-of-AUTO and end-of-match — never a live matched count).
7. Drivetrain feel: fast (75 in/s, 7 rad/s turn, snappy accel). Per-robot drive
   params now DERIVE from the spec via `driveParams(spec)` in `src/sim/drivetrain.ts`
   (`DRIVETRAIN_PRESETS` × `driveRpm` × `massLb`, calibrated so the DEFAULT spec
   reproduces the legacy 75/7/280 EXACTLY — smoke-checked, do not break). Four
   drivetrains with distinct wheel-saturation models: mecanum `|f|+|s|+|ω|`
   (0.85 strafe), x-drive same-but-full-strafe, tank `|f|+|ω|` (strafe input DEAD),
   swerve `hypot(f,s)+|ω|` (direction-independent). `maxTurn = wheelSpeed /
   halfDiagonal` (smaller/faster bots turn quicker, capped at `TURN_MAX_SPEED`).
   The mecanum wheel-saturation model is correct physics — keep it. Wall/structure contacts apply
   TORQUE (summed over touching corners) so a tilted robot squares up flush.
   Contact torque is PRESSURE-SCALED (`CONTACT_PRESS_GAIN`): pushing into the wall
   turns faster, and a fast angled hit also injects spin (`CONTACT_IMPACT_SPIN`,
   scaled by torque×speed — MUST scale with torque, a sign()-only kick once caused
   a numerical-noise spin-up on dead-center contacts). Flat-face alignment is
   capped at the REMAINING TILT (flushErr in `pushRobotAt`) so the heading never
   steps past flush and buzzes; ball-pin contacts pass `squareTo=false` and pivot
   freely (capping them killed corner scatter). Classifier corner eviction must
   never push a wheel TOWARD the field wall (wall-vs-structure fight = stuck robot).
   Balls have "mass" feel: robot→ball contact is near-inelastic
   (`BALL_ROBOT_RESTITUTION`), and a ball PINNED between chassis and wall transmits
   the refused push back onto the robot (`pushRobotAt`) — the robot stalls on a
   dead-center pinned ball while off-center balls squirt out sideways. The pin only
   transmits when the ROBOT drives into it (`BALL_PIN_PUSH_MIN_SPEED`): balls
   arriving under their own momentum (gate outflow into a parked robot) stop
   against the chassis instead of shoving it.
8. Audio: real FIRST field sounds (public/sounds, from Team254/cheesy-arena) + an
   announcer VOICE via speechSynthesis ("Match begins in… 3, 2, 1", "Drivers, pick up
   your controllers") — the user flip-flopped once and settled on KEEPING the voice.
   Countdown digits must interrupt in-flight speech to stay on the visual beat. Menu
   has Sounds ON/OFF (master) and Voice lines ON/OFF (falls back to beeps) toggles.
   Shoot/intake/gate SFX are SYNTHESIZED (WebAudio, `sfx*` in audio.ts) and triggered
   by edge-detection on world state in `GameController.handleActionAudio` — the sim
   core stays event-free for these. If the user ever supplies real FTC Live audio
   files, wire those in instead.
9. Stray balls must never enter goal wedges or classifier channels (solid to balls),
   and no collision may ever push a ball outside the field (final wall clamp pass).
10. The intake is physical: the collision OBB extends forward by intake reach
    (`robotExtents` in physics.ts) — it cannot clip walls/goals. THREE presets
    (user-named — keep these names): **Sloped** (ramp, trapezoid mouth in the
    frame, devours clumps), **Vector wheel** (VERTICAL compliant wheels drawn
    as a row of small rects — never circles; chassis 11.5–14.5"; steady pace),
    **Triangle** (named for its TRIANGULAR internal ball storage — hopper pips
    draw in a triangle; longest reach, devours clumps, slower transfer).
    Internal keys: sloped/vector/triangle ('compact'/'extended' in old saves
    migrate in settings.ts). CAPTURE MODEL (user was explicit): intaking
    happens when a compliant wheel is DIRECTLY ABOVE the artifact — a band at
    the wheel line (tip of reach) in updateIntake, not a deep window. Sloped/
    triangle mouths are TRAPEZOIDS (truncated — never a pointed tip) clamped
    inside the chassis, whose side prongs ENCOMPASS the intake: that geometry
    (not a code flag) is what rules out side intake — flank capture exists
    only where the vector's wheel span overhangs a narrower chassis, and the
    check compares SPANS, not penetration (the robot moves before the ball
    pass each tick, so depth tests see phantom overlap). Clump feeding:
    `clumpPerBall` cadence applies while 2+ balls sit at the mouth.
    Per-preset length ranges live in the preset (`minLength`/`maxLength`).
    The chassis may be NARROWER than the intake (`ROBOT_MIN_WIDTH` 10 < vector's
    17). BASE PARKING counts only the four WHEEL ground-contact points
    (`wheelContacts`, inset `WHEEL_INSET` inside the chassis — wheels are inside
    the frame, per high-level FTC builds): intake/turret overhang neither earns
    nor spoils credit. The turret never protrudes: its offset scales with length
    (`TURRET_OFFSET_FRAC`) and the drawn ring/barrel fit within the chassis.
11. Gate: a TAP drains the column — the flow physically holds the gate open until a
    gap appears at the gateway.
12. Visible MENU/RESET buttons on the game screen (don't rely on Esc/R knowledge);
    "MATCH BEGINS IN" text lead-in before the 3-2-1 digits.
13. **Controls are fully rebindable in the menu** (`src/input/bindings.ts`,
    `src/ui/ControlsSection.tsx`): every keyboard action, gamepad buttons, AND the
    drive/turn stick assignment. Escape is reserved (menu/cancel — never bindable).
    Conflict policy: a rebound key is STOLEN from its old action (may show UNBOUND).
    "Flip front" (default F / pad Y) reverses robot-centric drive so the shooter side
    leads — applied at input level in GameController, sim untouched; REVERSED chip in
    the HUD. All GameSettings persist to `localStorage['decodesim.settings.v1']`
    via `src/settings.ts` (validated field-by-field on load — corrupt/stale data
    falls back per field).
14. **Robot is fully specced + the field is multi-robot** (Phase B, "Road to
    Multiplayer"). `RobotSpec` v2 carries name/team/number, `massLb` (20–42),
    `drivetrain`, `driveRpm` (200–600), `flywheelInertia` (0–1), `canSort`, plus
    the existing length/width/intake. The menu offers 5 named `ROBOT_PRESETS`
    (cards) AND a custom builder (sliders/selects); editing flips to Custom.
    `createWorld(mode, seed, setups: RobotSetup[])` — a `RobotSetup` is
    `{id, alliance, spec, assists, startIndex}`, and ONLY filled slots spawn a
    robot (the multiplayer seam: the sim already steps N robots from the command
    map keyed by id). `START_POSES` = 3 named mirrored poses (GOAL SIDE / CENTER /
    WALL SIDE); a 2-robot alliance splits the 6 preload balls (slot A `PRELOAD`,
    slot B `HP_INITIAL_STOCK`) and starts that alliance's HP stock empty.
    Robot-robot collisions are `collideRobots` (SAT, MASS-WEIGHTED split
    `wa=mb/(ma+mb)`, restitution 0, contact torque on both — bumpers square up);
    the `step()` solver runs 2 passes of {all id-ascending pairs → `constrainRobot`
    all} so walls always win a squeeze, and records `world.rrContacts` per tick for
    the coming penalty engine. `canSort` robots fire the hopper color matching the
    next unfilled motif slot (else FIFO). Free-Drive has a "practice dummies"
    toggle (3 idle default robots as obstacles). `game.ts` uses `localRobotId`
    (not `robots[0]`); non-local robots get name/team labels + per-robot SFX.

## Gotchas

- Camera/screen math: `worldToScreen` = rotate by `viewAngle`, then y-flip. Driver
  stick → field frame uses `rot(stick, -viewAngle)` (the INVERSE — sign matters since
  view angles are ±90°).
- The basin containment normal points INTO the field; push balls back inside with `-n`
  (a sign inversion here once caused positions to explode to 1e250).
- `robotIntersectsRect` (SAT) exists because thin zones (gate tape) can be covered by
  the robot body with no corner inside.
- Windows PowerShell 5.1: no `&&` in npm-adjacent commands; use `;` or `if ($?)`.
- The manual PDFs' text is extractable with the stdlib scripts pattern (see memory);
  figures are embedded images — extract and Read them as images when geometry questions
  come up. `manual09/10` text dumps live in the old session scratchpad (regenerate if needed).

## State of play / roadmap

Done: full solo match + free drive, scoring per manual (classified 3 / overflow 1 /
pattern 2/slot / leave 3 / depot 1 / base 5/10+10), motif randomization, human-player
restock, gamepad + keyboard, physical basin/rail/gate classifier, contact-torque robot
physics, driver assists (menu), audio (field sounds + announcer + menu toggles),
pre-match countdown, favicon, on-screen MENU/RESET, Electron packaging, robot
size/intake presets in menu, rebindable keyboard+gamepad controls with localStorage
persistence, flip-front toggle, pinned-ball resistance physics, contact-time
overflow decision, synthesized shoot/intake/gate SFX, pressure-scaled wall torque,
END GAME at 20s left (`ENDGAME_START`: warning cue + HUD label/tint), vector-intake
side capture, wheel-contact base parking + narrow chassis, three named intake
presets (sloped / vector wheel / triangle) with per-preset length + fire cadence,
trapezoid mouths + geometric side-intake rules + clump feeding.
**Phase A (field markings), Phase B (RobotSpec v2, four drivetrains, flywheel
recovery, canSort, robot presets + custom builder, start positions, practice
dummies, mass-weighted robot-robot collisions, multi-robot spawn/step), and
Phase C (penalty engine) are DONE and green.** The "Road to Multiplayer" plan
lives at `C:\Users\geniu\.claude\plans\if-artifacts-are-scored-vivid-sphinx.md`.
Phase D (netcode) is CODE-COMPLETE + build-green but not yet verified live (see below).
`scripts/smoke.ts` has 117 checks — keep adding one per behavior change.

**Phase C — penalty engine** (`src/sim/penalties.ts`, `updatePenalties` called in
`world.ts` after the robot-robot solver). **MINOR = 5 pts, MAJOR = 15 pts** (user-set,
NOT the manual's 10/30), awarded to the OPPOSING (victim) alliance via `awardFoul` in
scoring.ts → the victim's `ScoreBreakdown.foulPoints`; `match.fouls[offender]` tallies
committed counts for the HUD. Rules: **opponent-gate** (MAJOR — a robot working the
OTHER alliance's gate zone; the gate is now physically openable by ANYONE, `updateGates`
dropped its own-alliance filter), **G425 tunnel** / **G426 loading** (MINOR, on
cross-alliance contact in-zone), **G427 base** (MAJOR in endgame + sets `RobotState.
baseAwarded` → full base at match end), **G402 auto interference** (MAJOR, fully on the
opponent's −side + contact during AUTO), **G422 pinning** (MINOR, →MAJOR on a repeat by
the same pinner: 3 s of contact while the pinned robot commands motion, stays < 8 in/s,
and hasn't escaped 24"). **Fouls are EDGE-triggered — NO cooldown/timer** (user was
emphatic): a violation fires on the false→true edge, once while held, and AGAIN
immediately on re-entry (leave the opponent gate and re-enter ⇒ instant new foul).
`fire()` is idempotent within a tick (a duplicated `rrContacts` pair, or two rules on
one key, awards once). All penalty state (`world.penalties`: episodes/pins/pinFouls) is
plain JSON so determinism/lockstep hold. HUD: FOULS chip (committed counts) + a
PENALTIES score-table row (`foulPoints`).

**Phase D — netcode** is CODE-COMPLETE and build-green (`src/net/`), with the
deterministic core smoke-tested (117 checks). NOT yet verified live — needs the 2-tab
manual pass in `docs/multiplayer.md` + your Supabase keys. Architecture: `protocol.ts`
(commands quantized to 4 B AT THE PRODUCER, which steps that same dequantized value, so
every peer's sim gets identical inputs; binary command packets + JSON control msgs),
`checksum.ts` (`worldHash` FNV-1a over rounded state → DESYNC detection), `lockstep.ts`
(input-delay buffer, `INPUT_DELAY` 8 ticks, `canStep` gate, disconnect ⇒ ZERO_CMD),
`lobby.ts` (`SupabaseLobby`: one Realtime channel/room, presence + broadcast, host =
smallest peerId), `mesh.ts` (`RtcMesh`: full mesh ≤4, lower id offers, one
ordered+reliable DataChannel, STUN only — no TURN in v1), `session.ts` (`NetSession`
ties it together + host seed/restart authority). `GameController` takes an optional
session (**null ⇒ solo path bit-identical**); its loop drives `produce → canStep →
step → checkpoint`. Match world built from the host's `matchStart{seed,setups}` and
started immediately (no controller-local seed/countdown — the fixed determinism seam).
UI: `App.tsx` screens menu|lobby|game, `Lobby.tsx`, MULTIPLAYER menu button gated on
`supabaseConfigured()`. Env-gated via `VITE_SUPABASE_URL/ANON_KEY` (`.env.example`);
absent ⇒ multiplayer hidden, solo untouched. **Determinism hardening: `Math.hypot`→
`hyp` (sqrt) across `src/sim` + `math.ts`** (engine-stable). Chromium-only v1.

Still open: LIVE 2-tab verification of Phase D; obelisk AprilTag visuals, mobile/touch
controls, replays (record the per-tick command map + seed), TURN relay, and deferred
fouls (G408 possession>3 / plowing, displacing pre-staged spike artifacts).
