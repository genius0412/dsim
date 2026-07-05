# CLAUDE.md — DECODE 2D Simulator

2D top-down driver-practice sim for the FTC 2025-26 game **DECODE presented by RTX**.
Vite + React + TypeScript, Canvas 2D, zero runtime deps beyond React. Deploys to
Vercel zero-config; Electron wrapper for a desktop build.

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
- Spike marks: horizontal 10" tape at x=±48.5, rows y = -35.5 / -12.8 / +11.1,
  3 balls per row (GPP / PGP / PPG near→far). Bases 18×18 at (±36,-36). Loading zones =
  audience corners, 23×23.

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

1. **No flywheel spin-up model.** Shots limited only by the intake preset's
   hopper→shooter transfer cadence (`INTAKE_PRESETS[*].fireInterval`: 0.1 s,
   except triangle 0.3 s — slower transfer is its stated tradeoff).
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
7. Drivetrain feel: fast (75 in/s, 7 rad/s turn, snappy accel); mecanum wheel-saturation
   model (`|f|+|s|+|ω|`) is correct physics — keep it. Wall/structure contacts apply
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
`scripts/smoke.ts` has 57 checks — keep adding one per behavior change.
Next candidates: 2v2 with real people (netcode over the command map — the sim core is
ready), penalties/fouls, obelisk AprilTag visuals, mobile/touch controls, replays
(trivially possible: record the per-tick command map + seed).
