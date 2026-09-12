# CLAUDE.md — DSIM, a 2D FTC driver-practice simulator

2D top-down driver-practice sim hosting **more than one game**:

| id | game | status |
|----|------|--------|
| `decode` | **DECODE presented by RTX** (FTC 2025–26) | full match, scored, ranked |
| `chain` | **Chain Reaction** (2026 Unofficial-FTC CAD competition) | full match, scored, ranked |

Vite + React + TypeScript, Canvas 2D. The CLIENT bundle is React + **Rapier 2D**
(`@dimforge/rapier2d-compat`, wasm) and nothing else; the rest of `dependencies`
(`ws`, `tsx`, `pg`, `jose`, `@neondatabase/auth`) exists for the SERVER and auth — keep the
client that lean. Deploys to Vercel zero-config; a Node/`ws` authoritative game server on
Fly; Electron wrapper for the desktop build.

**The app brand is DSIM; a game is a "season" (`src/seasons.ts`).** Keep them separate in
UI copy — DECODE/Chain Reaction are what is currently loaded, not the product name.

> Read this top-to-bottom once. The **Shared core** rules apply to BOTH games; each game
> then has its own section. When you touch a game, check whether the thing you're editing
> is shared (`src/sim/`, `src/config.ts`) or game-owned (`src/games/<id>/`) — that
> distinction is the single most load-bearing fact in the repo.

## Session protocol

**At the end of every working session, write/refresh `HANDOFF.md`** (repo root): current
state (is the build green?), what was finished, exact next steps, and gotchas. Read it at
session start if it exists — it may describe uncommitted mid-refactor state. HANDOFF is a
reverse-chronological log; prepend a new dated section and demote the old "READ FIRST".

## Commands

- `npm run dev` — dev server (localhost:5173)
- `npm test` — **headless sim verification** (`scripts/smoke.ts`, ~1240 checks, BOTH games).
  Run this after ANY change to `src/sim/`, `src/config.ts`, or `src/games/`. It is fast and
  catches almost everything. **Add a check per behavior change.**
- `npm run test:mm` — **matchmaker verification** (`scripts/mmsmoke.ts`, 36 checks, no DB or
  sockets — injected clock + `stage`). Run after ANY change to `server/matchmaking.ts`. Kept
  out of `npm test` on purpose, same reasoning as `contrast`: a red `npm test` must keep
  meaning "physics broke".
- `npm run build` — tsc (strict) + vite build. Run before claiming work done.
- `npm run server:check` — typecheck the server against the shared sim (`tsconfig.server.json`).
- `npm run uiaudit` — **UI STANDARD audit** (`scripts/uiaudit.mjs`, zero deps). Enforces
  `docs/ui-standard.md`: undefined custom properties, duplicate selector blocks, `var(--x,
  #literal)` fallbacks, inline spacing in JSX, the type scale and the 4px grid. It is a
  **RATCHET** — every rule carries the count measured when it was written, and the audit
  fails if a count goes UP (and tells you to lower the baseline when it goes down), so the
  standard binds new code immediately without a big-bang refactor of the existing debt. The
  first three rules sit at 0 and are hard errors, because both bugs they describe shipped
  silently: `--ds-font` was used 13 times and defined nowhere (an unresolvable `var()` in a
  `font:` shorthand voids the WHOLE declaration), and `.ds-dl` was declared twice for two
  unrelated components so the later block quietly re-laid-out the replay export menu. Same
  rule as `contrast`: deliberately NOT in `npm test`.
- `npm run contrast` — WCAG audit of the palette (`scripts/contrast.mjs`, 175 pairs, light +
  dark, no deps). Run after ANY colour/token edit. Not wired into `npm test` on purpose: a red
  `npm test` must keep meaning "physics broke".
- `npm run dbtest` — **database + payments verification** (`scripts/dbtest.ts`, ~61 checks).
  Boots **PGlite** (Postgres 17 in WASM, a devDependency — there is no Postgres on a dev box),
  runs the REAL migrations and the REAL `server/db/repo.ts` against it, and asserts the Ko-fi
  webhook's idempotency, the claim race, the auto-renewal path, the tier policy, admin
  grant/revoke, and account deletion's cascade. Run after ANY change to `server/db/`,
  `server/kofi.ts`, or a migration. Same rule as `contrast`: deliberately NOT in `npm test`.
  `server/db/pool.ts` exposes a structural `DbPool` + `setPoolForTests` so the swap is possible;
  production still builds a real `pg.Pool`.
- `npm run shiftaudit` — layout-shift audit (`scripts/shiftaudit.cjs`, Electron). Needs a
  build + `npx vite preview --port 4173` in another shell. Forces `:hover`/`:active` and the
  `on`/`primary` state classes on every interactive element across 10 routes + the live HUD,
  in BOTH themes, and asserts nothing outside that element's own subtree moves. Pressables must
  move via `transform`/`box-shadow`, never a border or margin that appears on hover.
- `npm run costprobe` — **hosting cost probe** (`scripts/costprobe.ts`, no deps, ~20s). Measures
  what ONE ROOM costs — cores/room, bytes per 30 Hz snapshot, KiB/s per client, and the replay
  row each match writes — for BOTH games, solo and 2v2, off the real `step()` and the real
  `slimWorld`/`encodeBallDelta` codec, then extrapolates to a concurrency
  (`-- --ccu=2000 --solo=0.75 --util=0.65`). Run it when someone asks what N players would
  cost, before resizing a Fly VM, and **after any change that adds a per-tick `RobotState` or
  `World` field** — a one-line field ships 30 times a second to every client in the room, and
  EGRESS, not compute, is ~90% of this bill. It is a measurement, not a test: nothing fails,
  and the published rates it prices against are stamped at the top of the file, so re-check
  them before quoting a number.
- `npm run server` / `server:start` — the authoritative game server locally.
- `npm run electron` / `npm run dist` — desktop shell / installers (`release/`).
  **Desktop builds MUST be built with `ELECTRON=1`** (relative asset base — see Gotchas).

## Repo map

```
src/
  config.ts        SHARED constants: robot/drivetrain/motor balance + ALL DECODE geometry
  types.ts         World / RobotState / RobotSpec / Artifact / BallState (shared shapes)
  math.ts          rot/clamp/hyp + the deterministic trig wrappers (dsin/dcos/datan2)
  game.ts          GameController: rAF loop, fixed-timestep stepping, predict+reconcile, HUD
  settings.ts      GameSettings + coerceSettings (localStorage, field-by-field validation)
  seasons.ts       app brand + the SEASON/GameId registry
  sim/             SHARED deterministic core (see below) — DECODE's rules also live here
  games/
    types.ts       the GAME-ABSTRACTION seam (DOM-free): GameSimModule, StaticSpec, bounds
    module.ts      GameModule = GameSimModule + canvas renderers + builder/HUD spec
    index.ts       CLIENT registry (moduleFor/gameOf) — falls back to DECODE
    sim.ts         SERVER-SAFE registry (simModuleFor/simGameOf) — no DOM imports
    decode/        thin: points at src/sim + src/render (DECODE is NOT relocated)
    chain/         Chain Reaction: config/spawn/step/play/state/beams/penalties/mounts/draw*
  render/          DECODE canvas renderers + the shared camera/robot/wheel drawing
  ui/              React menus, HUD, leaderboard, lobby (read-only over world state)
  input/           keyboard/gamepad → RobotCommand (+ rebindable bindings.ts)
  net/             protocol / transport / lobbyClient / serverSession / sanitize
server/            Node + ws authoritative rooms, Neon Postgres repo, Glicko-2 ranked
scripts/           smoke.ts (the real test suite), contrast.mjs, shiftaudit.cjs, fly-deploy.sh
docs/              decode-reference.md (field sources), netcodeplan.md (roadmap), deploy.md,
                   ui-standard.md (THE UI RULES — read before touching any component)
```

---

# The game-abstraction seam

`src/games/types.ts` defines it. Read that file before adding a game or moving code.

- **`GameSimModule`** (DOM-free): `id`, `scored`, `startLegality`, `bounds`, `colliders`,
  `createWorld`, `step`. This is all the authoritative server and headless smoke need.
- **`GameModule`** (`module.ts`) = `GameSimModule` + `drawField`/`drawRobot`/`drawBalls`/
  `drawOverlays` + `ui` (`showScoreHud`, `startEditor`, `intakes`). Client-only.
- **Two registries on purpose**: `games/index.ts` (client, full) and `games/sim.ts`
  (server-safe). The server importing the client registry would drag in canvas code.
- Both resolvers **fall back to DECODE** for an absent/unknown/missing `game` — that is the
  single back-compat rule (old worlds/snapshots/replays carry no `game` field).
  **`'decode'` must always be registered.**
- Modules emit **plain-number collider specs** (`StaticSpec`), never Rapier handles.
  `physicsEngine.ts` owns RAPIER and turns specs into bodies. A game with a different field
  size just works, because the shared Rapier solve + camera are parameterized on
  `bounds`/`colliders`.
- `World.game: GameId` tags a world; `GameSettings.game` is the player's current pick.
  DB rows, leaderboards, records, and ranked periods are **keyed per game** already.

**Rule of thumb when adding behavior:** if it would be true of any FTC-style game (drive
feel, robot-robot shove, match phases, HUD chrome, netcode) it belongs in the shared core;
if it names a game element (artifact, gate, particle, catalyst, beam) it belongs in
`src/games/<id>/`.

---

# Shared core (both games)

## Determinism — the non-negotiable

- **`src/sim/` is a pure deterministic state machine.** No DOM, no clock, no `Math.random`,
  no `Date`. It consumes per-tick `RobotCommand`s keyed by robot id and a seeded mulberry32
  PRNG stored in `world.rngState`. The same rule binds `src/games/*/` sim code.
- Fixed timestep 60 Hz (`SIM_DT` = 1/60, `MAX_STEPS_PER_FRAME` 5); rAF render loop in
  `src/game.ts` (`GameController`). HUD is React, polled at 10 Hz from `getHud()`.
- All game state must be **plain JSON** (`world.chain`, `world.penalties`, …) so snapshots,
  reconcile, and replays hold.
- `dsin`/`dcos`/`datan2` (`math.ts`) exist from the old cross-machine-lockstep era. Under
  server authority they are no longer a *correctness* requirement, but **they stay in
  `src/sim`** — CR's 300-particle solve is still bespoke, and `npm test` greps the sim for a
  bare `Math.sin/cos/random`, so new sim code (the artifact engine's own probes included) uses
  them. Dropping the discipline is the last item of the Rapier port, not a side job.

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
    wall, so the wedge is an explicit quad.
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
    stalled by 0.2 lb of foam. **No direction test and no "escaping" exemption**: both were
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

## Controls, settings, audio

- **Controls are fully rebindable** (`src/input/bindings.ts`, `src/ui/ControlsSection.tsx`):
  every keyboard action, gamepad buttons, AND the drive/turn stick assignment. Escape is
  reserved (menu/cancel — never bindable). Conflict policy: a rebound key is STOLEN from its
  old action (may show UNBOUND). Defaults: WASD drive, Q/E or ←/→ turn, Shift/K intake,
  Space fire, C catalyst (CR), F flip-front, P park, Enter start, R restart.
- "Flip front" reverses robot-centric drive so the shooter side leads — applied at INPUT level
  in `GameController`, sim untouched; REVERSED chip in the HUD.
- All `GameSettings` persist to `localStorage['decodesim.settings.v1']` via `src/settings.ts`
  (validated field-by-field on load — corrupt/stale data falls back per field) and sync to
  Postgres per account.
- **Assists are menu-only** (field/robot-centric, auto intake, auto fire) — NO in-game toggle
  keybinds. Auto-fire/intake must respect match phases (no firing in `pre`/`transition`).
- **AIM ASSIST IS ALWAYS ON, in BOTH games, and is NOT configurable.** `coerceAssists`
  (sim/spawn.ts) forces `aimAssist` true — deliberately in the SHARED coercer, not the UI,
  because a stored `false` can arrive from localStorage, a synced account blob, a saved robot
  slot, or the wire, and forcing it only in the menu would strand anyone who had switched it
  off with no control to switch back. The FLAG and both sims' manual-aim branches stay
  (DECODE's chassis-locked turret in `updateRobotActions`, Chain's `chainAimAssist` guard),
  tested by setting `r.aimAssist` on the spawned robot — restoring the option is deleting one
  line in `coerceAssists` and putting the toggle back in `Menu.tsx`. A DECODE "auto align"
  assist (hold fire → steer the chassis onto the shot) was built and then REMOVED: with the
  turret always tracking there is nothing for it to do. Chain's turretless hold-to-steer is a
  different thing and STAYS — see `chainAimAssist`.
- Audio: real FIRST field sounds (`public/sounds`, from Team254/cheesy-arena) + an announcer
  VOICE via speechSynthesis. Countdown digits must interrupt in-flight speech to stay on the
  visual beat. Menu has Sounds ON/OFF (master) + Voice lines ON/OFF (falls back to beeps).
  Shoot/intake/gate SFX are SYNTHESIZED (WebAudio, `sfx*` in `audio.ts`) and triggered by
  edge-detection on world state in `GameController.handleActionAudio` — **the sim core stays
  event-free for these**.

## HUD / UX product rules

- HUD mimics the FTC live scoring display: red|timer|blue bar at the BOTTOM.
- **No popup toasts over the field** — events go to the muted left-edge log; zone status lives
  in the top-right chips.
- Visible MENU/RESET buttons on the game screen (don't rely on Esc/R knowledge); "MATCH
  BEGINS IN" text lead-in before the 3-2-1 digits.
- END GAME at 20 s left (`ENDGAME_START` / `CHAIN_ENDGAME_S`): warning cue + HUD label/tint.
- Games opt into chrome via `GameModule.ui` (`showScoreHud`, `startEditor`, `intakes`).

### UI COPY — the house rules, settled by measurement

A seven-slice audit of every user-visible string (2026-09-06) found the voice already
strong — almost no marketing vocabulary, no "Oops!", no exclamation marks — and the real
yield in CONSISTENCY. These are the rulings, with the counts that decided them, so the
same arguments are not had again:

- **Typographic punctuation: `’` `“` `”` and `…`**, never the ASCII ones (measured 60:18
  for the apostrophe; the ellipsis was already 50:0). A file full of `’` with an ASCII
  hyphen doing an em dash's job is the actual inconsistency.
- ⚠️ **PREFER A FULL STOP OR A COLON TO A DASH.** The hyphen-vs-em-dash split was 50/50
  across the app — genuine drift, not a convention — so it had to be ruled on, and
  "normalise every ` - ` to ` — `" is the WRONG answer to a request that is explicitly
  anti-AI-slop: a dash-joined appositive is the single most-cited tell of machine-written
  prose. Almost every one of them was two sentences. Where a dash is genuinely the right
  mark, it is `—`.
- **Failures are `Couldn’t <verb the thing>.` plus a concrete next step** (`Couldn’t` beat
  `Could not` 12:5). No "Something went wrong.", ever — it tells a person nothing, and it
  was on the claim form and the sign-in form, which are the two worst places for it.
  The admin console composes its own through **`adminFail()` (`src/ui/adminCopy.ts`)**,
  which existed because five spellings of `Failed - check admin sign-in` had accumulated
  across two files, none of which said WHICH action failed.
- **Sentence case** for `ds-btn` and every heading. ALL CAPS is correct in exactly four
  places and they are all deliberate: `.overlay-buttons button` (13/13), the HUD chips (the
  FTC scoring display is uppercase), `ds-cta` (14/14), and the admin console (29/34).
- **`.ds-empty` for an empty list** (`.big` headline, no period, then one sentence with
  one), **`.ds-loading` for a loading state** (9/10 already did).
- **A name always gets `SupporterBadge`, as a SIBLING** — see the badge rules above.
- **Terminology.** DSIM is the app; DECODE and Chain Reaction are seasons. DECODE has
  ARTIFACTS, CR has PARTICLES, and a leak either way is a bug. CR's ring is a **CATALYST**
  — the **RING STAND** is a different object in the same game, so the HUD chips that said
  RING now say CATALYST. Teleop is **DRIVER-CONTROLLED** on all THREE surfaces that name it
  (the live HUD, `world.events`, and the burned-in video overlay); it used to be
  DRIVER-CONTROLLED on one and TELEOP on the other two, and free drive was FREE DRIVE and
  PRACTICE. `npm test` now pins the overlay to the HUD's words.
- **No padding**: simply / just / please note / be sure to / feel free to. **No helper text
  that restates its own label** — a hint under a button that already says what it does is
  the most common form of it here.
- **Foul lines name the ACT, not the place** (`G424 contact in the gate zone`, not
  `G424 gate zone`), because a driver reads them mid-match; CR's `G05`/`G06` used to be
  bare rule ids. ⚠️ Those strings live in `src/sim/` and `src/games/chain/`, so **changing
  them is a SERVER change and needs a deploy.**
- Code comments and JSDoc are OUT of this ruleset. The verbose in-code voice this file is
  written in is deliberate house style.


## Netcode (server-authoritative + client prediction)

The old P2P lockstep/mesh/TURN/Supabase-lobby is DELETED. Full roadmap: `docs/netcodeplan.md`.

- **`server/`** (Node + `ws`, run via `tsx`) imports the SHARED sim (no fork) and runs a
  fixed-`SIM_DT` authoritative loop per room: ingest each client's latest `RobotCommand` by
  robot id, `step(world, SIM_DT, inputs)`, broadcast a **delta snapshot every 2 ticks
  (30 Hz)**. `server/room.ts` = lobby + match + host lifecycle + deterministic drop.
  `SNAPSHOT_INTERVAL` was dropped from 60 Hz after profiling (the lag was NETWORK, not CPU;
  halving snapshot bandwidth + `setNoDelay(true)` to kill Nagle was the fix).
- **`src/net/protocol.ts`** — JSON `ClientMsg` (join/update/start/restart/input) and
  `ServerMsg` (welcome/roster/matchStart/snapshot/drop), plus quantize helpers. The client
  must PREDICT on `localizeCommand(cmd)` (exactly what the server decodes).
- **`game.ts` `stepServer`** applies its OWN command locally + `sendInput`, buffering it; on a
  snapshot it snaps `this.world` to the authoritative world and REPLAYS buffered inputs past
  `serverTick` (`reconcile`). Only the local robot is predicted. **`session: null` ⇒ the solo
  path is bit-identical.**
- **SMOOTHING is Minecraft-style entity INTERPOLATION, not extrapolation** (`displayWorld`/
  `snapBuf`/`renderTick`): the render clock runs a few ticks behind the newest snapshot and
  REMOTE robots lerp between the two bracketing snapshots. The LOCAL robot stays predicted
  with a decaying `localSmooth` error offset (cosmetic only — never touches `this.world`).
  **BALLS are NOT interpolated** — they spawn/despawn and collide, and lerping ghost-cloned
  fresh balls and blended colliding balls through each other.
- **DELTA SNAPSHOTS**: `slimWorld`/`unslimWorld` strip static robot `spec` (client re-injects
  from setups) + delta the balls (send the id ORDER every frame — determinism — but only
  CHANGED ball data); reconnect re-primes with a keyframe.
- **CONNECTION-QUALITY HUD**: `ping`/`pong` probe → smoothed RTT; snapshot arrival rate +
  inter-arrival JITTER measured client-side → SMOOTH/OK/CHOPPY dot. **Jitter is the real
  choppiness signal** — surface it when diagnosing lag reports.
- **RECONNECTION**: the server holds a dropped slot `RECONNECT_GRACE_MS` (`detach`/`reattach`/
  `checkGrace`), the transport auto-reconnects, the session re-sends `rejoin`.
- **REPLAY COVERAGE IS PER-ARCHETYPE, not just per-drivetrain.** A replay is `{seed, setups,
  command log}`, so anything that changes what a robot DOES with the same commands has to be
  carried by the container — and each such axis needs its own recorded-and-replayed check, or a
  dropped field re-simulates as the default and still hash-matches because both sides dropped
  it. Covered: DECODE's five drivetrains (tank/butterfly are the reason `REPLAY_FORMAT` 2
  exists — they steer through `ld`/`rd` alone) and three intake presets, and CR's four
  `scoreMode` archetypes × four catalyst mechanisms. The CR ones matter most: drum lateral
  pick, dumper scatter and the accelerator re-eject are all RNG, seeded off `world.rngState`,
  and `catalyst`/`fling` are CR-only command bits DECODE never exercises. Every case is checked
  straight off the recorder AND through a `JSON.parse(JSON.stringify(...))` round-trip, because
  a stored replay reaches the verifier as JSON and an `undefined` optional spec field does not
  survive that trip.
  **A replay check must not be vacuous**: assert the archetype's own code RAN (particles scored,
  peak hopper > 0), or it only proves that two idle robots idle identically. Two traps cost
  real time here — `DEFAULT_ASSISTS.fieldCentric` is TRUE, so a scene that turns the chassis and
  drives "forward" goes nowhere and parks in a corner; and holding the manual FIRE button on a
  turretless CR archetype hands `rotate` to `chainAimAssist`, which fights any steering trying
  to close on a target.
- **SOLO PRACTICE IS RECORDED, AND THAT IS WHY ITS COUNTDOWN LIVES IN THE SIM.** Solo Practice
  (`mode: 'match'` with `session: null` — the offline full match, NOT Free Drive) used to start
  from the CONTROLLER: a `countdownStart` field compared against `world.time`, with
  `startMatch(world)` called directly. That breaks the invariant `replay.ts` states — a run must
  be fully SIM-DRIVEN so `{seed, setups, commands}` alone reproduce it — because the tick auto
  began on depended on when a key was pressed and the container has nowhere to store it.
  `GameController.startMatch` now REBUILDS the world at tick 0 and sets `preCountdown` for
  `stepMatch` to run down, exactly like multiplayer. The rebuild is invisible: `robotsEnabled`
  is false in `pre`, so nothing has moved, and the seed is REUSED (`makeWorld(reseed=false)`)
  so the field and motif do not change under the player. Solo also steps on
  `localizeCommand(cmd)` unconditionally — a replay stores QUANTIZED commands, so a run only
  re-simulates exactly if the sim consumed the quantized value, and practice must not behave
  differently depending on whether it is being kept.
  - **DEVICE FIRST, ACCOUNT SECOND** (`src/net/practiceRuns.ts` → `POST /api/practice`).
    Practice is the primary OFFLINE mode and works signed out; a run that survived only a
    successful upload would make the offline mode depend on being online. Career merges both
    and renders SIGNED OUT too (`Stats`' every branch), or the device would hold runs nobody
    can open.
    **UPLOADING IS A BACKLOG, NOT A STEP.** "Device first" is only honest if the account
    eventually catches up, so `pendingPracticeUploads()` is drained after a run AND whenever a
    session appears — sequentially, stopping on the first failure. Posting once and giving up
    loses a run for reasons that have nothing to do with it: signed out at the time, offline,
    or (routinely, since the game server AUTO-STOPS when idle) a machine still cold-booting
    when the match ended.
    ⚠️ **`onPracticeRun` must be re-registered when the prop changes**, like
    `setRestartRequest` beside it. Registered in GameView's MOUNT-ONLY effect it captured the
    first render's closure — and that closure reads `signedIn`, which starts false and flips
    when auth resolves ASYNCHRONOUSLY, so the upload was never attempted at all.
  - **IT COUNTS AS A GAME PLAYED**, crediting `user_activity` from the replay's TICK COUNT
    exactly as `persist.ts` does for a server match — practice is the mode people spend most
    of their time in, and a playtime that omitted it read as broken. This is the ONE activity
    write whose input is client-reported: `sanitizeReplay` bounds each POST to at most one
    match of ticks so a single run cannot inflate it, but nothing stops a determined client
    posting runs it never played. Accepted deliberately, because games-played reaches no
    board, rank or ELO — **do not let anything competitive start reading `user_activity`.**
  - **IT CAN NEVER BECOME A LEADERBOARD SCORE, STRUCTURALLY.** `practice_runs` (migration 0032)
    is its own table and `record_leaderboard` is a view over `records`, so nothing written
    there is reachable from any board, PB, rank or ELO query — not by accident, not by a later
    refactor. That is what makes accepting a CLIENT-written row safe at all: solo practice has
    no authoritative loop to verify a score against, and re-simulating ~9,900 ticks on the game
    server to authenticate a number nobody competes on would cost real CPU for nothing. It is
    also self-policing where it is shown — the viewer RE-SIMULATES the log, so a score that
    disagrees with its own replay contradicts itself on screen. `sanitizeReplay` still forces
    the container into a shape `createWorld` can safely spawn, because `setups` reaches the sim.
  - Pruned at `PRACTICE_KEEP` (10) per account, oldest first, and the prune DELETES the pruned
    runs' replays — a replay has no back-reference to its run, so dropping rows alone leaks
    logs. Account deletion sweeps them for the same reason. All covered in `npm run dbtest`.
  - ⚠️ **TWO TRAPS make a replay check VACUOUS, and both were hit writing these tests.**
    `DEFAULT_ASSISTS.fieldCentric` is TRUE, so a scene that steers and drives "forward" parks in
    a corner — after which any two runs agree and the comparison proves nothing (use
    `fieldCentric: false` and assert the robot MOVED and SCORED). And `worldHash` covers robots,
    balls, scores and counts but **NOT `match.phase` or `phaseTimeLeft`**, so two runs that
    started the match 200 ticks apart hash identically — compare the clock too.
- **A SIM BUMP RETIRES OLDER REPLAYS, ON PURPOSE — and that is why you can DOWNLOAD one.**
  `replayPlayable` refuses a version mismatch rather than warning about it: a replay is an
  input log, so a changed sim produces a DIFFERENT game from the same inputs, and playing it
  back anyway would show something that never happened. Records are unaffected — the server
  stores the score it computed at the time and never re-derives it from the replay.
  The consequence is that an archive has a shelf life, so the viewer offers TWO exports, both on
  `status === 'ready'` — which IS `replayPlayable`, so neither is offered for a container this
  build could not reproduce anyway. That is the last moment a replay is provably the real match.
  - **THE REFUSAL HAS TO SAY WHICH REFUSAL IT IS.** `replayRefusal` is the real function and
    `replayPlayable` is `=== null` over it; it names one of five situations, because they are
    five different things to be told: `future` (THEY are behind — refresh), `balance`,
    `behaviour`, `unstamped` (recorded before SIM_VERSION was stamped, so genuinely unknown)
    and `tank` (a format-1 container that never stored tank drive). The viewer printed one
    sentence for all of them — "recorded on an older version of the sim (Season N)" — off
    `balanceVersion`, which is **not the season**: in `replays` the SEASON is the
    `balance_version` COLUMN and that number lives in `sim_version`. `unstamped` is a MESSAGE
    split only; the policy stays exactly `(r.sim ?? 0) !== simVersion`, so a build running
    SIM_VERSION 0 still accepts an unstamped log (which is what keeps format-1 replays
    playable). Smoke pins both halves.
  - **THE EXPORTS ARE A MENU IN THE HEADER, not buttons in the transport row** (`.ds-dl`).
    They are actions on the REPLAY, not on playback, and the two have very different COSTS —
    a video takes the length of the match, the JSON is instant — so each option states its
    cost and its file size next to its name. Two bare ghost buttons wedged between the seek bar
    and the clock read as two more transport controls and said neither thing.
  - **RECORDING REPLACES THE TRANSPORT ROW** (`.ds-replay-rec`), it does not grey it out: a
    progress bar, the real time remaining, why the tab has to stay in front, and Cancel. Every
    playback control is locked while a capture runs (it is a capture of THIS canvas, so
    scrubbing mid-record scrubs the FILE) and a row of four dead controls beside a "● REC 12%"
    label does not explain that.
  - **↓ Video** (`src/ui/replayVideo.ts`) is the one that LASTS: it stops being a
    re-simulation and becomes a recording, so it outlives every patch, needs no sim, and can be
    sent to someone without DSIM. THREE FORMATS — **MP4/H.264 first and default**, then
    WebM/VP9 and WebM/VP8 — and **all three go through WebCodecs**, so they all cost the same
    and the menu quotes it from the match's own length (`FAST_ENCODE_SPEED`, the measured 5×; a
    2:42 match saves in ~32s).
    **MP4 LEADS BECAUSE THE FORMAT HAS TO BE THE SAME EVERYWHERE.** It is the one every
    platform can both produce and play, so a replay saved on one machine is the same file as
    one saved on another; `availableVideoFormats` preserves the table's order, and the top
    entry is what people take. If that entry varied by browser, so would everybody's archive.
    The WebM pair stay for the people who want them (VP9 smaller, VP8 for older players), but
    neither is the default — a phone or a video editor is where these end up.
    **THE FAST PATH IS WEBCODECS, AND IT EXISTS BECAUSE `MediaRecorder` CANNOT BEAT REAL TIME.**
    It stamps frames by when they ARRIVE, not by the timestamp the frame carries — measured, 300
    frames explicitly stamped for 5.00s of video came out as 1.39s and 0.05s depending only on
    how fast they were written, and feeding it a `MediaStreamTrackGenerator` does not change
    that. `VideoEncoder` does honour the stamp, so the replay is re-simulated and drawn as fast
    as the machine manages and frame `i` is stamped at `i/60`. `MediaRecorder` survives ONLY as
    the MP4 fallback for a browser whose WebCodecs has no H.264 encoder.
    - **TWO HAND-WRITTEN MUXERS** (`src/ui/webm.ts`, `src/ui/mp4.ts`) — WebCodecs returns raw
      chunks, not a file, and the client bundle is React + Rapier and nothing else. One video
      track each, no seek index, no audio, no fragments. MP4 was the slow format purely because
      it had no container of its own, never because H.264 was slow; adding one took it from
      2:42 to 3s per 15s of match, the same 5× as the others. Traps both files document:
      assembling the output as one `number[]` and `push(...bytes)`ing frames into it overflows
      the call stack on the first real recording; every EBML size must be computed over the byte
      RUNS rather than a flattened array; MP4's `stco` holds ABSOLUTE file offsets so `moov` is
      built TWICE (measure, then write) and is safe only because the offset field is
      fixed-width; and chunks arrive in DECODE order, so `ctts` carries any B-frame reordering
      (today's browser encoders emit none, which is not a reason to write the file as if none
      could). The MP4 sample table is asserted headlessly in `npm test`.
    - ⚠️ **QUALITY IS RESOLUTION HERE, NOT BITRATE** (`MAX_EDGE` 1920). Reported as "video
      quality is horrible", and the obvious suspects — the rate control and a `latencyMode:
      'realtime'` that used to ship — turned out to be nearly irrelevant. Scored as PSNR against
      the scene re-rendered at 1920: the old path (render at the viewer's 2496×1074, `drawImage`
      down to 1280) managed **35.5 dB**, while rendering NATIVELY at 1920 gives **42.2-42.6 dB**
      — and sweeping the quantizer across its whole useful range moves 0.3 dB and 1.6× the file
      size. A >2× canvas downscale is a cheap bilinear filter and it lands on exactly the thin
      tape lines and the small scoreboard type. So `encodeSize` is a RENDER size: the capture
      retargets `camera.dpr` and draws straight into a canvas of that size. **It scales UP as
      well as down** — clamped at 1× it produced a 1280-wide video on a 1280-wide window, which
      is the bug it was meant to fix. 1920 rather than more because the same encoder that took
      1920 refused 2496 for H.264.
    - **The rate control is set deliberately but is not the lever.** `latencyMode: 'quality'`
      (there is no deadline — every frame is in hand and the file is written at the end), and
      `bitrateMode: 'quantizer'` where the browser takes it, falling back to the bitrate budget
      where it does not (Chrome refuses quantizer mode for VP8 outright). ⚠️ The quantizer
      option is CODEC-SCOPED — `{ vp9: { quantizer } }`, not `{ quantizer }` — and passing it
      flat is accepted silently and ignored, which reads exactly like an encoder that does not
      honour it. `BITS_PER_PIXEL` is a CEILING, not a target: VP9 handed 20 Mbps at 1920 spent
      1.7 of them, so the budget's only job is to stay out of the way.
    - ⚠️ **NEVER YIELD WITH `setTimeout` IN THE CAPTURE LOOP** (`yieldToBrowser` uses a
      MessageChannel). A background or unpainted tab clamps `setTimeout(…0)` to ~1s, which is
      exactly when somebody leaves the tab to encode; it read 0.6× real time throttled and 13×
      once the yield was an ordinary task. The fast path never touches rAF, so unlike the
      real-time one it cannot be starved by a hidden tab and needs no `visibilitychange` dance.
    - A canvas that has not been LAID OUT is 0×0, and the encoder accepts a 2×2 config happily,
      produces empty frames, and the viewer quietly downloads the JSON instead — hence the
      explicit size guard in `recordFast`.
    - ⚠️ **THE CAPTURE OWNS ITS OWN CANVAS — it must never draw into the VISIBLE one.** It did
      at first, resizing it to the encode size, and that put it in a tug-of-war it can only
      lose: the click sets `recording`, React swaps the transport row for the taller recording
      bar, the canvas's BOX shrinks, and anything re-fitting the backing store to that box
      resets it out from under a capture already running. The encoder is configured ONCE, so
      every frame after that is a smaller canvas scaled up into the same file — reported as
      "the field became smaller when I started recording, and the final recording file also has
      a small field", with the quality loss to match. A detached canvas removes the whole class.
    - **A FAST SAVE RUNS IN THE BACKGROUND AND LOCKS NOTHING.** Owning its own player, renderer
      and canvas means there is nothing on screen for it to disturb, so playback, seeking and
      pausing all stay live while the file encodes. Only the REAL-TIME fallback replaces the
      transport row, and it has to: it is filming the visible canvas through `captureStream`,
      so scrubbing mid-record would scrub the file. That split is also why the re-fit effect
      skips while `recorder.current` is live, and why a finished fast save does NOT `rebuild()`
      — the viewer is watching, and restarting the match under them is the one thing a
      background job must not do.
      ⚠️ **ITS PROGRESS GOES IN THE HEADER** (`.ds-replay-saving`, replacing the title), NOT in
      a strip of its own. A row inserted above the transport row steals height from the canvas,
      which re-fits to a shorter box and SQUASHES the field halfway through the recording it is
      reporting on. The header is already there and its height comes from the buttons in it, so
      nothing below it moves — measured, the canvas holds 1280×545 in a 545px box and the
      header holds 64px for the whole save. A background job must not reflow the thing it is
      running behind.
    - ⚠️ **THE PROGRESS BAR MUST NOT REACH 100% BEFORE THE FILE EXISTS.** The frame loop owns
      only `ENCODE_SHARE` (0.94) of it; the flush, the muxer and handing the browser a blob of
      tens of megabytes all come after, and the readout used to round UP to 100% and then sit
      there — reported as "at 100% it doesn't show the save popup right away". The viewer
      floors the percentage, caps it at 99, and switches the label to "Finishing" past
      `ENCODE_SHARE`.
    - ⚠️ **BOUND THE ENCODER QUEUE** (`MAX_QUEUE`), by WAITING rather than yielding once. Work
      still queued when the loop ends is paid for in `flush()` — after the bar has stopped
      moving — and a single yield per frame let it run deep enough that flushing took **3.6s of
      a 5.8s save**, all of it in that dead stretch. Waiting until the queue drains puts the
      cost back inside the loop where it is reported: the tail fell to ~0.8s. It also bounds
      memory, which an unbounded queue of encoded frames does not.
    - **THE CAPTURE YIELDS ON A TIME BUDGET** (`SLICE_MS` 8), not on a frame count, because the
      viewer keeps PLAYING while it runs and its render loop is `requestAnimationFrame` — which
      cannot run inside a long synchronous stretch. The playback loop also clamps its own
      accumulator to a few ticks: `n < 8` caps the work per frame but the arrears keep
      accruing, so a late frame makes the next one later, which is the classic spiral and reads
      as judder rather than as slowness. Dropping the debt makes the replay run a hair slow
      under load instead of lurching.
    - **THE VIEWER's canvas is re-fitted when `recording` flips**, in its own effect, because
      the recording bar replaces the transport row at a different height and no window resize
      ever fires — the field drew into a 1280×545 element at 1280×516 and came out squashed. An
      effect, not a per-frame check: React has committed the row by then, and reading
      `clientWidth` 60 times a second would force a layout flush for something that changes
      twice a match. It skips while a REAL-TIME capture runs, which is filming that canvas.
    - **THE VIDEO CARRIES ITS OWN SCOREBOARD** (`src/ui/replayOverlay.ts`). The viewer's score
      strip is React DOM sitting ABOVE the canvas, so a canvas capture had no score, no clock,
      no phase and no match start in it at all — invisible on screen, where the page supplies
      the other half, and a match nobody can read once it is a file. It draws the live
      red | phase+clock | blue bar, the "MATCH BEGINS IN" lead-in off `match.preCountdown`, and
      a FINAL frame that names the winner (a tie says so). ⚠️ It SETS ITS OWN TRANSFORM:
      `Renderer.render` leaves the context in FIELD INCHES, so the first version drew its
      scoreboard off in the field's coordinate space and produced a video with nothing on it.
      It works in CSS units so the bar is the same size relative to the field at every encode
      resolution. The words are `hudLabels`, split out of the drawing and checked in
      `npm test` — the ENDGAME split, the ceiling clock, the tie, and a solo run having no
      winner.
    - ⚠️ **THE BAR NEVER COVERS THE FIELD, and the camera's reserved bands do NOT promise
      that.** `HUD_BOTTOM` collapses to 4px on a short or touch layout and the field is centred
      in whatever is left, so the clear space under it depends on the viewer's aspect ratio.
      The capture asks `fieldScreenBottom` where the field actually ends and gives the FRAME
      `HUD_RESERVE` more height when there is not already room — measured, a 1000×295 viewer
      exports 1920×676 where the unreserved frame would have been 1920×566. Growing the frame
      is right and moving the bar onto the field is not: extra letterbox costs nothing and a
      scoreboard over the match costs the match. The countdown centres on `fieldHeight`, not on
      the frame, or it drifts toward the bar whenever the frame is extended.
    - **`availableVideoFormats` is ASYNC**, because the real question is not "is there a
      `VideoEncoder`" but "will it take this codec at this size", which only `isConfigSupported`
      answers — and that is also what decides whether MP4 saves in seconds or has to be filmed,
      which the menu says out loud. `videoFormat(id)` still answers synchronously off the static
      table before the probe lands, because the download FILENAME is built from `fmt.ext`.
  - **↓ Data** is the container verbatim (`{format, versions, seed, setups, tracks}`, the same
    JSON the server stores) — the only form that is still a REPLAY: re-playable in-sim at full
    fidelity by any build whose versions match. A video cannot be stepped, seeked in-sim, or
    verified.
  ⚠️ **Replays are only playable at all because `replays.behaviour_version` exists**
  (migration 0031). `balance_version` is the SEASON and `sim_version` holds the recording
  build's BALANCE_VERSION, so before that column there was nowhere to put SIM_VERSION,
  `getReplay` could not set `Replay.sim`, an absent `sim` read as 0 and EVERY stored replay was
  refused on EVERY build. It stayed invisible because the replay tests all use in-memory
  containers, which carry the field — `npm run dbtest` now covers the round-trip, INCLUDING
  that a pre-0031 row reads back `unstamped` rather than 0. It bit twice: the column landed but
  the Fly server was not redeployed, so the deployed `getReplay` still could not populate
  `Replay.sim` and the live viewer refused everything. **A replay change is a SERVER change —
  deploy it.**
  **Rapier is pinned EXACTLY** (not a caret) for the same reason: a fresh `npm install` pulling
  a new physics engine would change `step()` output with no version bump, making every stamp a lie.
- **DEPLOY**: Fly app `dohun-sim-decode`, `Dockerfile` + `fly.toml` + `docs/deploy.md`,
  `GET /health`; `ws` + `tsx` are runtime `dependencies`. Protocol: commit → **`./scripts/
  fly-deploy.sh`** → verify `/health` → Vercel auto-deploys clients.
  **NEVER deploy with a bare `flyctl deploy`** — fly.toml expresses only ONE `[[vm]]` size, so
  a bare deploy re-applies `shared-cpu-4x` to EVERY machine and silently upsizes the cheap
  satellites. The wrapper re-shrinks them; verify with `fly machine list -a dohun-sim-decode`.
- **The one Fly app serves EVERY client version** (alpha/beta/main bake the same
  `VITE_GAME_SERVER_URL`), so protocol changes MUST stay backward-compatible. New clients
  advertise `caps` (`CLIENT_CAPS`) on `join`/`queue` and the server feature-gates on them.
  With that discipline you don't have to sync branches before deploying the server.
  **A new `RobotSpec` field is NOT a protocol change** — but an older server's `coerceSpec`
  will drop it, so mirror it onto an older field when one exists (see CR mounts).
- **A ROOM JOIN GOES WHERE THE ROOM IS** (`src/net/roomRegion.ts` `roomJoinRegion`). One app,
  many regions, and a CUSTOM room code is BARE: a matchmaker-staged room is `iad-abc123` and
  the proxy routes on the code alone, but a code two friends share carries nothing. A socket
  opened with no hint lands on whichever machine Fly's anycast puts nearest to the JOINER,
  which has no such room and opens an EMPTY one with the same code — two lobbies, one code,
  both sides waiting, no error on either screen. So the HOST's region always wins; empty means
  genuinely unknown (an invite from before `0029`, a single-region deploy, or a code typed by
  hand) and keeps the joiner's own pick.
  **The region is an ARGUMENT to `Lobby.join()`, never a component state a caller hopes is
  right.** It was a `useState` seeded from the prop at mount, and the Lobby is ALREADY MOUNTED
  when you accept an invite from its own `InviteFlyout` — so the seed was never re-read, and
  that flyout never had the region to pass anyway (it called `onJoinRoom(code)`). Inviting from
  inside a room stamped no region either, the same split from the other side. Every path that
  can know it now hands it to the one function that opens the socket. `roomJoinRegion` lives in
  its own LEAF module rather than beside `gameServerUrlWith` in `env.ts`, because env.ts reads
  `import.meta.env` at load and the headless smoke run cannot import it at all — and this rule
  fails SILENTLY, so it has to be testable.
  The same discipline covers `spectateRoom` (passes `region` for a bare code) and the auto-join
  guard, which was a never-reset `useRef(false)`: accepting a SECOND invite without leaving the
  lobby did nothing at all. It keys on the room CODE.

## Accounts / ranked / leaderboards / records

Neon Postgres via `server/db/` (`repo.ts` + `migrations/`), written at match end OFF the hot
path. **Ranked is Glicko-2** (`server/ranked.ts`: rating + RD + volatility, `SCALE 173.7178`,
`CENTER 1500`, provisional RD shown with "?"), decided AFTER the score SETTLES
(`MATCH_SETTLE_S` — late-draining balls finish scoring before finalize); an opponent who
LEAVES mid-match is retained (`departed`) so the match still rates. **SOLO RECORD RUNS**
(score-attack): results show NET score (earned − own penalties), no opponent/winner, and
PB / WR / global rank per **mode × drivetrain × season**. Boards, records, and Act→Season
periods are **keyed per game**, so DECODE and CR never share a leaderboard.
**ADMIN MENU** (`src/ui/Admin.tsx`, `/admin`) gated on the signed-in UUID (`ADMIN_USER_IDS`;
the server enforces every action independently). **VERSION GATE**: a new build is detected
(`__BUILD_ID__` → `/version.json` poll) and forces a refresh when a player STARTS a run
(never mid-run) — no "play anyway", everyone must be on the same version for multiplayer.

**STAFF ROLES — owner + admin badges, and perks, DONE.** `profiles.role`
(`0020_staff_roles.sql`) is null | 'owner' | 'admin'. It is a **PROJECTION** of
`ADMIN_USER_IDS` / `OWNER_USER_ID` (`OWNER_USER_ID` defaults to the FIRST id in
`ADMIN_USER_IDS`), reconciled by `syncStaffRoles` once per boot after `migrate()` — the
env stays the source of truth; the column exists so the badge can be JOINED by the
leaderboard/roster queries instead of post-processed row by row (or the admin list
leaked to clients). **The sweep is SYMMETRIC** — an id removed from the env loses the
badge and the perks. **THE PERK IS ONE PREDICATE**: `SUPPORTER_COL` in repo.ts is read
by the ad gate, the cosmetic chassis colours, the saved-start cap, `/api/user/
entitlements` AND the badge, so `role in ('owner','admin')` is folded into that single
expression — never add a second "is staff entitled" check, extend that one. TWO places
deliberately keep the PAID predicate instead, because the entitled one would mislead
there: `searchProfiles` (the admin console's grant/revoke row — a colleague must not
read as a supporter with no expiry when you are deciding whether to comp months) and
the Donate page (staff get their own panel; the supporter one would say "through -"
and nag them to link a Ko-fi account that will never pay). `getSupporter` returns
`supporter: true` with `supporterUntil: null` for staff — that shape is intentional.
`LobbyPlayer.role` is **server-authored** exactly like `supporter` (a self-declared
"owner" beside a driver's name is an impersonation primitive). UI: ONE
`SupporterBadge` renders owner ★ > admin ◆ > supporter ♥ — exactly one, since staff are
also `supporter: true`. **Badge colours must be SATURATED IN BOTH THEMES**: the audit
checks the glyph against its own fill, NOT the badge against the card behind it, so the
lavender pastel (#34305c in dark) passed contrast while being invisible on the dark
panel. Distinguish by SHAPE as well as hue.
**THE BADGE GOES ON EVERY NAME**, and the failure mode is SILENT — a query that just
doesn't project the two columns still compiles and still renders, only bare, which is how
the ranked board sat badge-less next to a record board that was fine. So: `badgeCols(alias
[, prefix])` in repo.ts writes the pair once (the `prefix` form names a SECOND person in
the same row — a duo partner — as `partnerRole`/`partnerSupporter`, and `coalesce(…,false)`
is load-bearing on the LEFT JOIN a solo run takes), and client-side every row type
`extends BadgeFields` (`src/net/api.ts`) instead of re-declaring the fields. Surfaces
covered: both leaderboards (records incl. the duo partner + ranked, live AND archived),
career/profile (the `CareerPanel` name chip — the ONLY place My Stats prints who you are),
match history (every participant + record-run partners), friends/requests/challenges (both
directions), and username search. The friends poll used to skip the columns deliberately;
it no longer does — same already-joined row, and a badge that shows on the leaderboard but
not beside the same person in your friends list reads as a bug.
**A BADGE IS DECORATION BESIDE A NAME, NEVER PART OF ONE**: render it as a SIBLING of the
name element, because the name carries the hover underline (`.lb-name-h`, `.mh-player.link`)
and the ellipsis (`.fr-name`) — nested inside, it gets underlined with the name or
truncated with it. `.fr-nameline` exists for the stacked name-over-subline rows.
Tests: 36 checks in `npm run dbtest`.

**BACKGROUND RANKED QUEUE, LIVE (no flag).** The queue used to die when you left the
matchmaking screen — that screen owned the socket (`useEffect(() => teardown, [])`),
so queueing locked you out of the rest of the app, which is what stopped people
queueing at all. Now `Matchmaking` PARKS the live `LobbyClient` in `queueKeeper.ts`
(a module singleton — it must outlive the tree that made it) on unmount mid-search,
and ADOPTS it back on remount. **Nothing about how the socket is opened, queued or
handed to a match changed — only how long it lives**; that was the design constraint,
because this path costs real ELO when it breaks. `LobbyClient.on()` REPLACES, so both
hand-overs are plain re-registration. Two cases still tear down for real rather than
park: a match that already STARTED (the session owns the transport) and an in-flight
reconnect to the host region (`assigning`). `QueueBar` shows bucket/elapsed/cancel
while parked; match-found takes the screen back WITHOUT asking (the server forfeits
the slot after `RANKED_JOIN_GRACE_MS`, so a dialog is just a slower way to lose) and
DISCARDS any run in progress. An assignment arriving while parked is remembered on
the parked state — its event has already fired and won't fire again for the adopting
screen. **`updateQueue` must return a NEW object**: it mutated in place at first, so
`useSyncExternalStore` re-read an identical snapshot, skipped the render, and the
takeover silently never fired (the bar still looked right — it repaints on its own
1s timer). A smoke check asserts snapshot IDENTITY changes. `exposeForTesting` is
`import.meta.env.DEV`-only; a shipped bundle must never carry a handle that can
cancel a stranger's queue. **NOT yet validated end-to-end** — that needs two
signed-in accounts completing a rated match.

**PLAY A FRIEND — challenges (chess.com's model), DONE.** A challenge (`room_invites` +
migration `0019`) carries a **`format`**: `casual1v1`/`casual2v2` (a `versus` room),
`duorecord` (a `record`/`duo` room), or the two RATED ones. Rating is only ever applied to a
matchmaker-STAGED room (`Room.ranked` ← `pending_matches`), so a code-joined room can NEVER
rate — the rated formats therefore resolve through the MATCHMAKER, not through a room code.
The challenge's `room` column doubles as a **party token** both sides send on `queue`
(`party`/`partyOnly`/`partyFormat`; `RATED_FORMATS` in protocol.ts maps format → mode +
partyOnly). The matchmaker pairs on **UNITS** (`groupUnits`), never individual entries:
`rated1v1` is a CLOSED party (the token IS the match — no strangers, and the search radius is
skipped since they chose each other; the channel+build bucket still applies), `ranked2v2` is a
PREMADE that queues into the OPEN pool and is kept on one alliance by `allianceOrder`. That
same ordering needs NO 1v1 exception: there the party is the two opponents and half=1 splits
them correctly. **`partySize` (2) is load-bearing** — the members enqueue seconds apart, and
without it the first arrival reads as a complete unit and is swallowed by an open group.
**The token is VERIFIED, never trusted** (`challengeParty` → `verifyParty`): it resolves
against the real challenge row and only answers for an account named on it, so two clients
can't agree on a string and stage themselves a rated match, and a guessed token can't join a
pair. A token that fails is REFUSED, never downgraded to an open queue. Rated formats are
gated on **`SERVER_CAPS`** (`/api/presence` `caps`, read via `serverCaps()`) — the first
server→client capability, and NOT optional: an older server IGNORES the party fields rather
than rejecting them, silently matching two friends against strangers. Lifecycle is
Accept/**Decline** (decline MARKS `declined` so the sender is told once, then their client
cancels the row; dismiss stays a silent clear), the sender SEES their outgoing challenge
(`listFriends`'s `snt` CTE → `sent`) and can cancel it, and one live challenge per direction
(`inviteToRoom` replaces — stacked rated rows would let someone accept an abandoned token).
`src/ui/challenge.ts` `challengeOf` is the ONE place deciding lobby-vs-queue. Tests:
**`npm run test:mm`** (`scripts/mmsmoke.ts`, 36 checks, injected clock + `stage`, no DB) —
party pairing fails SILENTLY, so it is covered there rather than by a live two-account run.
NOTE `enqueue` matches synchronously but STAGES asynchronously; assertions must await a
microtask flush. Rated friend games are farmable by a colluding pair and deliberately
unmitigated (as chess.com); damp repeat-opponent deltas in `ranked.ts` if it shows up.


---

## Monetization (branch `monetization`) — ads + supporter tier

Not yet deployed. `HANDOFF.md` has the full write-up; the load-bearing rules:

- **`src/ads/adsense.ts` is the single gate.** Ads are OFF unless `VITE_ADSENSE_CLIENT`
  is set, and are suppressed unconditionally in the Electron build (AdSense forbids app
  wrappers), on touch, and for supporters. `AdsProvider` FAILS CLOSED — ads stay off
  until the entitlement check settles, so a supporter never sees a flash of them.
- **Ads are NON-PERSONALIZED by default and tagged TFUAC.** DSIM simulates FTC
  (grades 7–12) and the sim is fully playable SIGNED OUT, so most impressions carry no
  age signal. `VITE_ADSENSE_PERSONALIZED=1` is a deliberate opt-in. TFCD (COPPA) stays
  off: the terms set 13+, so asserting child-directed would be inaccurate, not cautious.
- **A CMP (Google Funding Choices) is REQUIRED, not optional** — without a certified CMP
  Google serves EEA/UK/CH users no ads at all. It loads with the client id; the message
  itself is authored in the AdSense dashboard. The footer "Privacy & cookie settings"
  link must keep existing (consent you can't withdraw isn't consent).
- **Three ad units, each with its own slot id**: `menu` (shell pages) and `results`
  (post-match) are SAFE; `game` (columns flanking the live field) is the risky one —
  60 Hz canvas + AdSense's 150px game-clearance rule. **Do not enable
  `VITE_ADSENSE_SLOT_GAME` without first comparing p95 frame time via `?perf=1`**
  (`GameController.getFrameStats`).
- **`/ads.txt` is GENERATED** from `VITE_ADSENSE_CLIENT` in `vite.config.ts` — never
  commit one, it would drift.
- **Supporter tier is Ko-fi.** `server/kofi.ts` is a PURE policy module (no DB, no
  import-time env) deciding what a payment buys: a subscription payment is always
  exactly 1 month; a one-off buys `floor(amount/price)` months, capped; a foreign
  currency buys nothing. Months are priced ONCE at webhook time and stored on the row.
- **`profiles.kofi_email` is what makes a membership RENEW.** The first manual claim
  links the payer address; every later webhook from it grants automatically. The UNIQUE
  index is also the only thing stopping one subscription covering many accounts.
- **Every write to `supporter_until` logs a `supporter_grants` audit row** (source =
  kofi/admin/revoke). Two actors can move that column; "why does this account have a
  membership?" has to stay answerable.
- **Perks are cosmetic/convenience ONLY** — never anything affecting how a robot drives
  or scores. That is a product rule AND a statement in the terms. All four advertised
  perks are BUILT (badge, ads-off, 6 saved starts, chassis colours); **do not list a
  perk on the Donate page before it exists.**
- **The saved-start PERSIST cap is the SUPPORTER ceiling**
  (`MAX_SAVED_STARTS_SUPPORTER`), in `coerceSettings` AND `saveStart`. Only the editor's
  Save button applies the free cap. Sanitizing to the free cap would DELETE a supporter's
  poses before the entitlement resolved, and on every lapse.
- **The chassis colour is an ALLOWLIST key** (`CHASSIS_COLORS`), never a free colour
  string on the wire, and it recolours only the FILL — alliance identity is the OUTLINE.
- **`LobbyPlayer.supporter` is SERVER-AUTHORED** (set at join). `sanitizePlayer` is an
  allowlist and `PlayerPatch` is a `Pick`, so a client cannot self-declare a paid badge.
- ⚠️ **`LEGAL_OPERATOR`/`LEGAL_JURISDICTION` in `src/legalText.ts` are PLACEHOLDERS.**
  Until filled, the Terms page shows a visible warning to every visitor. Fill them
  before taking a payment; do not guess them from a timezone or an email domain.
- Analytics (`src/analytics.ts`, `VITE_ANALYTICS=1`, Vercel Web Analytics — cookieless).
  **Rule: no identifiers in any event payload** — counts and enums only.

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
chassis and wall is a FIXED CIRCLE IN THE ROBOT SOLVE (see **Physics**) — the robot stalls on a
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
- BASE PARKING counts only the four WHEEL ground-contact points (`wheelContacts`, inset
  `WHEEL_INSET`): intake/turret overhang neither earns nor spoils credit. The turret never
  protrudes (`TURRET_OFFSET_FRAC`). The chassis may be NARROWER than the intake
  (`ROBOT_MIN_WIDTH` 10 < vector's 17).

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

# GAME: Chain Reaction (`chain`)

The 2026 Unofficial-FTC CAD-competition game. **Everything CR lives in `src/games/chain/`**
(nothing CR belongs in `src/config.ts` or `src/sim/`). Numbers come from the competition
manual (`cm.pdf` — its page streams are corrupt, so values came from manual PAGES supplied as
images + explicit dimensions); mm are converted via `mm()` (÷25.4). Values still approximated
from description rather than a figure are FLAGGED `APPROX` in `config.ts` — refine those
rather than inventing new ones.

**Fully playable and SCORED** (`CHAIN_SIM.scored = true`), so CR matches ride the ranked/record
boards under their own per-game periods. `startLegality: false` — CR start poses are legal by
construction, so the server's DECODE-only G304 gate stays off.

## Field + elements

- Square 12'×12', walls at ±72 (`CHAIN_HALF_X/Y`), origin center — same frame convention as
  DECODE. Colliders are just the four perimeter walls; there are **no in-field solids**, so
  `chainColliders` has no `dynamic` entry.
- **ACCELERATOR** — the alliance goal, OUTSIDE each side wall (red left x<0, blue right x>0),
  centered in y. `CHAIN_ACCEL_DEPTH` 27.46" out of the wall × `CHAIN_ACCEL_WIDTH` 54.87" along
  it. Its opening HANGS over the field, so launchers score from a stand-off distance, not
  point-blank. The camera bounds (`CHAIN_VIEW_HALF_X`) include the protrusion; the WALLS stay
  at ±72.
- **PARTICLE** — a 3"-OD wiffle ball, **300 of them** (`CHAIN_PARTICLE_SIM`), all simulated.
  Conserved: ground + flight + in-hoppers === 300, always.
- **CATALYST** — a 6"-OD purple ring (4 total). Seated on a **HOOK** (on the accelerator wall
  at y = ±`CHAIN_HOOK_Y`, four total) it raises that accelerator's multiplier.
  **Three MECHANISMS handle it** (`CHAIN_CATALYSTS`, resolved by `chainCatalystGeom(spec)` —
  the ONE resolver, so the action, the HUD prompt and the mass floor can't disagree). One claw
  does both grabbing and placing, so each has a single `reach`, measured from the mounted
  chassis EDGE (`catalystMouth`), plus a `cone` half-angle: **arm** (reach specialist, ±50°,
  slow) · **launcher** (shortest claw, ±35°, plus the inaccurate `fling` catapult) ·
  **turret** (rail + turret, cone = π so facing never matters, fastest, heaviest).
  **The ARM's reach is PER-CHASSIS, not a constant** — see `chainArmReach`. G02/G03 give a
  24" control prism (`CHAIN_PRISM`), so what's legally left to extend is
  `24 − (chassis + any sweeper on that same axis) + the ring radius`. That spans **9" on a
  maxed-out 18" chassis to 17" on a compact one**, making the arm the mechanism you build
  small to exploit; `CHAIN_EXPANSION` is now just the maxed-robot worst case, derived rather
  than assumed. **This never changes the SPRITE**: both `drawCatalystMech` and `RobotPreview`
  draw the arm at the fixed stowed `CHAIN_ARM_DRAW` (2.2"), because an arm is only extended
  while it actuates — top-down it just says which way it points. Do NOT wire the sprite to
  `reach`; drawing it extended made every robot look permanently mid-grab.
- **RING STAND** — a 22.5" vertical pole very close to each field corner (inset APPROX).
  Robots ASCEND (endgame) / DESCEND (auto).
- **LAB AREA** — each alliance's two 24" corner squares on its side: start / leave / park.
- **PARTICLE ZONE** — the central white-tape diamond (`CHAIN_DIAMOND_SIDE` 48" outer side,
  half-diagonal `CHAIN_DIAMOND_R` ≈ 33.94"). Neutral and unprotected — it is the carve-out in
  the auto-protection rule.
- **BEAMS** — four 1"×1" black tubes on the x/y axes, 56" long, running IN from each wall
  (inner end 16" from centre, crossing the diamond). See *Terrain* below.

## Scoring (`CHAIN_PTS`)

Particle **1 pt × the accelerator's multiplier**; `accelMultiplier(state, a)` = 1 + one per
CATALYST seated on that alliance's hooks. Ring-Stand **descend 100** (auto) / **ascend 100**
(endgame); Lab-Area **leave 5** (auto) / **park 5** (endgame). Match timing 30 s auto / 120 s
teleop / last 20 s endgame. The alliance total is recomputed each tick as
`particlePoints + endgame + foulPoints` — endgame status is DERIVED from position
(`endgameOf`: ascended = slow near a stand > parked = centre in a Lab square), and the AUTO
descent is LATCHED (`descentAwarded`) so a robot that came down keeps the points all match.

## Particle lifecycle (bespoke, not Rapier)

Ground particles use a bespoke integrator + a spatial-hash SEPARATION pass so they never
overlap (`separateParticles`, scales to 300 cheaply).

**PRE-MATCH RANDOMIZATION** — the manual has the accelerators fling all 300 particles back out
to randomize the field. We STAGE half inside each goal (`staged` flight balls, inert) and the
launcher ejects `CHAIN_PRELAUNCH_PER_TICK` per goal per tick during the pre-match window
(~2.5 s to clear 150), scattering deterministically off the world RNG.

**In match:** launched → ballistic flight → crosses the wall plane within `CHAIN_ACCEL_HALF_Y`
⇒ **SCORED** (count + points at that instant) → it KEEPS its momentum and BOUNCES inside the
goal box (restitution + friction, `CHAIN_FUNNEL_MIN`..`CHAIN_FUNNEL_S` dwell) → drifts to the
wall-side launcher → **EJECTED back onto the field** (`CHAIN_EJECT_*`, randomized power/arc/
spread). A shot that MISSES the opening is retrieved by a human and thrown back in
(`CHAIN_THROWBACK_*`). Nothing is ever consumed — that is why the count stays at 300.

## Robot archetypes (`RobotSpec.scoreMode`)

- **turret** — a dye-rotor + turreted single shooter: indexes ONE particle per
  `CHAIN_FIRE_INTERVAL` (**13 bps**) from ANY range, auto-aiming. The turret **SLEWS** at
  `CHAIN_TURRET_SLEW` — it cannot snap, so a sudden velocity change (a shove) makes the lead
  solution jump faster than the turret can follow and shots fired mid-correction MISS. Aim is a
  physical state, not a promise. (Contrast DECODE, where the shooter never misses.)
- **twinturret** — two barrels on ONE turret, firing alternately from a real muzzle offset
  (`CHAIN_TWIN_BARREL_OFFSET`). Only **~15 bps** (`CHAIN_TWIN_FIRE_MULT` **1.15**) — a SLIGHT
  edge over the single turret, not a near-doubling (user's call, revised down from 1.65). The
  barrel is not the bottleneck: one indexer and one aim solution gate the rate, so a second
  barrel mostly hides handoff latency. It pays ~24% of its storage (`CHAIN_STORE_TWIN_MULT`)
  and +2.5 lb of mass floor for that, which makes it a NARROW pick — this multiplier is the
  dial if it should become mainline.
- **drum** — a chassis-wide flywheel drum, no turret: streams SINGLE particles at ~**24 bps**
  (`CHAIN_DRUM_INTERVAL` with ±`CHAIN_DRUM_JITTER`) from a RANDOM lateral position across the
  rollers, uniform launch speed. NEVER a rigid uniform line, never a "6-then-wait" burst.
- **dumper** — a chassis-wide catapult: flings the WHOLE hopper at once within
  `CHAIN_DUMP_RANGE` (56"), with side-to-side speed variance (`CHAIN_DUMP_SIDE_VAR`) ⇒ real
  scatter.

**Cadence gotcha:** the turret ACCUMULATES its interval (`fireReadyAt += INTERVAL`) rather than
re-anchoring to `world.time`, so the sub-tick remainder carries and the rate averages exactly
13 bps (a plain re-anchor tick-quantizes to 12 or 15, never 13). An idle-guard clamps
`fireReadyAt` forward so a refilled hopper can't burst-fire accumulated debt.

**Turretless aiming**: drum/dumper have no turret, so **the robot aims by TURNING** —
`chainAimAssist` (called from `chainStep` BEFORE the drivetrain model) overrides `rotate` while
the MANUAL fire button is held, and the shot is gated on `CHAIN_AIM_TOL`. Auto-fire fires
opportunistically and never hijacks the driver's heading. This is BUILT IN, not an option:
`aimAssist` is forced on everywhere (see the assists bullet above), so its `!r.aimAssist`
early-out is unreachable in the product — kept, and kept tested, for if the toggle returns.
A CR TURRET ignores the flag entirely and always tracks. **SHOOTING ON THE MOVE**: a launched
particle inherits the CHASSIS velocity, so both archetypes lead — a turret by offsetting
`turretHeading`, a turretless one by offsetting the whole chassis heading (`leadDir`).

## Mechanism MOUNTS (`src/games/chain/mounts.ts`)

The sweeper intake and the turretless launcher can sit on any chassis edge. Robot frame
throughout: **+x = forward, +y = the robot's LEFT**.

- `RobotSpec.intakeMount`: **front · back · side (both flanks) · frontback (both ends)**.
- `RobotSpec.shooterMount`: **front · back · left · right** (no effect on a turret, which is
  top-mounted — the builder hides the picker for it).
- `intakeSide`/`shooterRear` are **DEPRECATED MIRRORS — never read them.** Use
  `intakeMountOf(spec)` / `shooterMountOf(spec)`. `coerceSpec` resolves the new field (falling
  back to the legacy boolean, so old saves migrate) and keeps the boolean MIRRORED, so a spec
  round-tripped through an older peer/server returns the nearest legal mount instead of
  resetting.
- `mounts.ts` is a **LEAF module** (imports only `types`) on purpose: the mount decides the
  collision footprint, so `src/sim/field.ts` must import it, and anything heavier would cycle.
  It owns `EDGE_ANGLE`/`EDGE_DIR`/`EDGE_PERP` (exact integer unit vectors — no `cos(π/2)`
  residue on the flanks), `edgeGeom(spec, edge) → {dist, span}`, `isEndEdge`.

**A mount moves three things together — change one, change all three:**
1. **CAPTURE** — `chainIntakeMouths(spec)` returns one robot-local rect per mounted edge (so
   `frontback`/`side` are simply two rects); `mouthContains(m, lx, ly, pad)` pads ONLY the
   outward lip. END edges span the chassis WIDTH, FLANK edges its LENGTH.
2. **COLLISION** — `footprintExtents` grows on exactly the mounted edge(s). DECODE resolves to
   `front`, so DECODE geometry is unchanged.
3. **AIM + LAUNCH** — `chainGoalAimHeading` returns `lead − EDGE_ANGLE[mount]` so the robot
   turns the MOUNTED edge at the goal; `launchAt` spreads the launch line across that edge.

The drawn intake bars ARE the grab area (renderer and `interact` share
`chainIntakeMouths`) — keep it that way.

## Ball storage

The manual sets no fixed particle limit (G01 unlimited control; G02 bounds them to an
18"×24"×18" CONTROL PRISM, G03 permits expanding into it), so the practical max is
VOLUME-limited. `chainStorageMax` derives it from footprint area ÷ `CHAIN_STORE_AREA_PER_BALL`
× an archetype factor × a mount factor, clamped to [1, `CHAIN_STORAGE_MAX` 122]:

- archetype — turret `0.55` (loses centre volume to the rotor+shooter), twin turret `0.42` (a
  second shooter assembly eats more), drum/dumper `1.0`.
- mount (`chainMountStoreMult`) — front == back `1.0` (mirror images; a rear sweeper is a free
  stylistic choice), frontback `0.75` (two open ends), side `0.6` (two full-length flanks).

**`CHAIN_STORE_AREA_PER_BALL` is the ONE dial for storage across the whole game** — it is the
cap's only size term, so changing it moves every archetype, mount and chassis by the same
proportion and leaves the relative trade-offs above intact. It was cut 3.6 → **2.67** for a
+35% pass (Aug 2026), with `CHAIN_STORAGE_MAX` 90 → 122, `CHAIN_STORAGE_DEFAULT` 12 → 16 and
each `CHAIN_PRESETS` `ballStorage` scaled to match; `CHAIN_STORAGE_MIN` stays 1 (a floor of one
ball is a floor, not a quantity to scale). Do NOT hand-tune the per-archetype multipliers to
change overall capacity — that silently re-balances the archetypes against each other.

The `ballStorage` slider picks any capacity up to that max; `chainHopperCap` is the ACTIVE cap
read by the sim, renderer, and HUD.

## Terrain — beams + ground clearance (`beams.ts`)

`groundClearance` (0.3–1.5", default 1.0) must be ≥ `CHAIN_BEAM_HEIGHT` 1" to cross a beam, but
more clearance RAISES the centre of gravity (`cogFactor`) and makes the drive sluggish —
`CHAIN_COG_PENALTY` 0.16 generally, and `CHAIN_COG_SWERVE_PENALTY` 0.6 on a squared curve for
SWERVE (tall modules tip and scrub). `chainStep` scales the whole movement command by
`cogFactor` BEFORE the drivetrain model.
**CoG does NOT scale PUSHING FORCE, deliberately.** It scales the COMMAND, i.e. target speed and
turn rate, not accel — so a high-clearance robot is slow but shoves at full strength. That was
checked rather than inherited: total traction is `mass · µ` whichever way the load transfers
between axles, so a raised centre of gravity costs you tipping margin and dynamic response, not
grip. Making clearance a push penalty too would be a CR balance change with no physics behind it.


**Beam crossing is modeled PER WHEEL**, not by chassis overlap: a beam drags only while one of
the four `wheelContacts` is perched on the ridge (within `CHAIN_BEAM_WHEEL_R` 2.5" of the beam
line). So a robot STRADDLING a beam (tube under the belly, all wheels down) rolls DRAG-FREE,
and a perpendicular crossing is TWO distinct bumps (front axle, then rear). Lifted wheels lose
traction: `grounded = (4−wheelsUp)/4` scales the forward retain toward
`CHAIN_BEAM_GROUND_FLOOR` 0.82. Momentum eases the climb only a little
(`CHAIN_BEAM_MOMENTUM_EASE`) — a beam ALWAYS costs speed.

**A strafing MECANUM is CURBED, not dragged** (this was revised twice from feedback — a
velocity drag let the wheel ooze onto the ridge and get stuck on top). Real mecanum climbs a
bump it drives straight at (full-diameter wheel rolls over it — which is why mecanum has the
BEST forward beam traction), but sideways force is the sum of four 45° rollers whose tiny outer
diameter cannot climb a 1" tube. So: a **pre-solve velocity wall** in `beamDrag` caps inward
speed so the leading wheel stops EXACTLY at the near face this tick, plus a **post-solve
positional clamp** `beamStrafeBlock` for numerical slop. It engages only when the crossing is
strafe-dominant (`forwardness < CHAIN_BEAM_STRAFE_BLOCK_FWD` 0.5) and there is a **STRADDLE
GUARD** so a robot already across isn't shoved back. Mecanum ONLY — tank can't strafe, swerve
steers its pods into travel, x-drive is 4-fold symmetric.

Rendering EXAGGERATES the invisible 1" tube (`CHAIN_BEAM_RENDER_H`) and bobs a crossing robot
up with a ground shadow + `CHAIN_BEAM_RUMBLE` shudder — cosmetic only; the physics footprint
stays the flat 1".

## Start poses + roles

**G04**: a robot must begin completely in the Lab Area (tile floor OR already ascended on a
corner Ring Stand). `CHAIN_START_POSES` are four named anchors — LAB·TOP, LAB·BOTTOM, RING
STAND·TOP, RING STAND·BOTTOM — CANONICAL for BLUE and x-MIRRORED for RED (`chainStartPose`).
The anchors are all legal by construction. Starting on a stand ARMS the auto-descent award
(`descentArmed`).

**FREE PLACEMENT — `src/ui/ChainStartEditor.tsx`** (the CR twin of DECODE's
`StartPositionEditor`, replacing the old slider-and-buttons `ChainStartSelector`): a canvas
stage running the REAL `drawChainField` / `drawChainRobot`, drag to place, a heading handle,
numeric X/Y/heading, live legality, and the four anchors as quick-picks. It reuses every
`ds-startpos-*` style, so there is no new CSS for the contrast/shift audits. Rules of the
seam:
- `chainEvalStart(spec,pos)` is the verdict + its REASON (`inLab` / `clearOfStand`), and its
  `legal` is the `chainSnapStart` round-trip the SPAWN runs — never a re-derivation, so the
  ring can't disagree with where the robot actually starts. `extent` is the conservative,
  rotation-agnostic half-extent the rules test, and the editor draws THAT box (not a rotated
  footprint) so a red ring always explains itself. Heading is therefore always free.
- `chainMirrorStart(pose,a)` is canonical↔actual, SELF-INVERSE, mirroring `chainStartPose`.
  Poses are stored CANONICAL, so a placement survives an alliance switch.
- **Snap defaults ON and snaps LIVE during the drag** (DECODE's defaults OFF). G04 plus the
  solid corner assembly leave a narrow legal band — at the widest chassis
  `CHAIN_RINGSTAND_BOX <= CHAIN_LAB - 2*half-extent` is nearly tight — so free-dragging would
  paint almost every drop red. Live snapping makes the robot glide along the legal band.
- **No saved-pose library** (unlike DECODE). `GameSettings.savedStartPoses` is ONE canonical
  list shared across games; a CR pose saved into it would show up unreachable in DECODE's
  Close/Far library. Adding one means namespacing that setting first.
- `startSelectionLegal(game, spec, alliance, pose)` in `src/ui/startPositions.ts` is the
  ready-up / start gate for BOTH games (DECODE G304 via `activeStartLegal`, CR G04 via
  `chainStartLegal`). CR used to be waved through as "legal by construction" — free placement
  ended that.

**CR roles are TOP / BOTTOM** (which Lab corner), NOT DECODE's CLOSE / FAR. The shared
`StartCat` slots carry them (close = TOP y≥0, far = BOTTOM y<0) via `chainAnchorCat` /
`chainDefaultIndex` / `chainRoleLabel`, so a locked role limits the selector to that corner's
floor + ring-stand anchors and two alliance robots never stack.

## Penalties (`src/games/chain/penalties.ts`)

Only the runtime CONTACT rules are modeled, and all are **MAJOR**, awarded to the victim:

- **G06** — during AUTO, contacting an opponent COMPLETELY within its own Alliance Section (its
  half, EXCLUDING the neutral Particle Zone diamond) → MAJOR on the aggressor.
- **G05** — during ENDGAME, contacting an ASCENDING opponent → MAJOR.

Edge-triggered via `chain.foulEdge` (same discipline as DECODE: fire on the false→true edge,
once while held, again on re-entry) and cleared outside auto/teleop. G01–G04 are structurally
enforced; G07 (de-score) is legal — you can lift a ring off EITHER goal's hook. G02 plowing,
G08, G09 are intentionally not modeled.

## CR pipeline order (`chainStep`)

resolve commands → `chainAimAssist` rotate override → CoG scaling → shared drivetrain/motor
(`updateRobot`) → Rapier + wall containment → `updateChain` (particles, intake, shooter,
accelerator score/recycle, catalysts, endgame) → `updateChainPenalties` → phase/timer machine.
It DELIBERATELY skips DECODE's `updateRobotActions`, goals/gates, penalties, and scoring — CR
owns all of that.

---

# Gotchas

- **THEMING (dark mode).** Pref lives in `localStorage['decodesim.theme']` (`src/theme.ts`),
  never in `GameSettings` (that syncs to Postgres per account). First paint is stamped by a
  blocking inline script in `index.html`; `system` is resolved in JS so CSS sees only
  `data-theme="light|dark"`. **EVERYTHING THEMES, INCLUDING THE IN-MATCH HUD.** Three
  categories decide how a token behaves: (1) *readable against the surface* ⇒ INVERTS
  (`--ds-ink`, `--ds-mut`, `--ds-accent`, `--ds-warn`, the `-ink` siblings); (2) *a fill with
  fixed ink* ⇒ does NOT (`--ds-red`, `--ds-*-chip`, `--ds-gold`); (3) *its ground is the
  CANVAS* ⇒ does NOT, because the field is hardcoded dark — that is `--ds-on-field`/`-dim`/
  `-accent`, deliberately absent from the dark block. Use category 3 for anything drawn
  straight on the field or the dark overlay scrims.
  A dark HUD card is only ~1.4:1 on the dark field by FILL, so its EDGE identifies it:
  floating surfaces take **`--ds-hud-line`**, never `--ds-line` (tuned against the card behind
  it). `--ds-line-strong` is tuned against `--ds-panel` and drops to 2.73:1 on the translucent
  HUD card — rings that must read there use `--ds-mut`. Detect the theme in JS via
  `document.documentElement.dataset.theme`, not `getComputedStyle`. **A colour that is both a
  fill and a text colour will fail one of the two** — split it (`--ds-ok`/`--ds-ok-ink`).
  The letterbox themes (`COLORS.backdropDark`) but the field mat does NOT; the board is
  separated from the dark floor by its outline alone (1.03:1), so keep the outline.
- **Camera/screen math**: `worldToScreen` = rotate by `viewAngle`, then y-flip. Driver stick →
  field frame uses `rot(stick, -viewAngle)` (the INVERSE — sign matters at ±90°).
- **Bird's-eye vs mirrored** (bit us once): for a nose-up schematic, robot (x,y) → screen
  must be `[[0,−1],[−1,0]]` (forward → up, robot-LEFT → screen LEFT), NOT `rotate(-90)`, which
  puts the robot's left on the screen's right. Symmetric mechanisms can't reveal the
  difference; anything left/right-asymmetric can. See `ROBOT_FRAME` in `RobotPreview.tsx`.
- The DECODE basin containment normal points INTO the field; push balls back inside with `-n`
  (a sign inversion here once made positions explode to 1e250).
- **Ball containment invariant**: ground balls get a HARD geometric clamp INSIDE the round
  loop in `world.ts` (`clampBallPosToStatics`: walls, goal faces AND the classifier channel,
  past `BALL_CONTAIN_SLOP`), and one whose centre ends up inside a robot solid is re-placed by
  `placeGroundArtifact`, because Rapier's soft contacts can't clear a DEEPLY embedded body.
  **Any new solid a ball can tunnel into needs the same geometric clamp**, not just a collider
  — the pin test reads that clamp to know what an artifact is pressed against.
- **A ball "held" by a robot that does not exist is on the FLOOR by the end of tick one**
  (`positionHeldBalls` drops it). Smoke scenes used to park the field's artifacts on
  `robot: 99` to clear it, and three gate-arm scenes were spawning on spike-mark balls that
  way. Clear a scene with `w.balls.length = 0` (and empty `humanPlayers[a].box` if the
  restock matters); the remaining `robot: 99` sites are rail scenes the floor balls cannot
  reach, listed in HANDOFF.
- **Electron builds need `ELECTRON=1`** (`vite.config.ts` switches `base` to `./`). A bare
  `npm run build` loaded under `file://` resolves `/assets/*.js` at the filesystem root and
  404s **silently** — a permanently blank white window. Check this before assuming the app
  broke. The desktop shell is a THIN SHELL: online it loads the live site, offline it falls
  back to the bundled `dist`.
- The manual PDFs re-download from ftc-resources.firstinspires.org/ftc/game/manual-NN via
  WebFetch; figures are embedded images — extract and Read them as images when geometry
  questions come up.
- ⚠️ **AN UNDEFINED CUSTOM PROPERTY IN A `font:` SHORTHAND DROPS THE WHOLE DECLARATION,
  SILENTLY.** `--ds-font` was used at 13 sites in `shell.css` and **defined nowhere** (the
  real tokens are `--ds-font-ui` / `--ds-font-mono`), so `font: 750 26px/1 var(--ds-font)`
  set no weight, no size and no line-height — it is invalid at computed-value time, and
  every longhand falls back to inherited. Nothing errors and the text still renders, just
  in the wrong face. Same bug class as `--accent` (undefined, so `var(--accent, #6ea8ff)`
  always resolved to a pre-redesign literal on a themed HUD chip). **Grep a token before
  using it.**
- ⚠️ **TWO COMPONENTS MUST NOT SHARE A CONTAINER CLASS.** `.ds-dl` was declared twice in
  `shell.css` — the replay export menu at 2377 and the download page at 3883 — so the
  later one won and the export menu was laid out as an 18px-gap COLUMN instead of the
  `inline-flex` row it was written as. The download page is `.ds-dlpage` now. The two files
  are one cascade; position in the file is the only tiebreak.
- **`.ds-btn.small` is the size modifier.** `.ds-btn.sm` was a second rule for the same
  intent with different padding, used only by `Admin.tsx`; it is gone.
- **`prefers-reduced-motion` must cap `animation-iteration-count`, not just duration** —
  capping the duration of an INFINITE animation only makes it loop faster.
- Windows PowerShell 5.1: no `&&` in npm-adjacent commands; use `;` or `if ($?)`.

---

# State of play

**DECODE** — complete: full solo match + free drive, scoring per manual, motif randomization,
human-player restock, gamepad + keyboard, physical basin/rail/gate classifier, contact-torque
physics, driver assists, audio, pre-match countdown, Electron packaging, three intake presets
with the physical `mouth` capture model, power draw, the drivetrain retune (`BALANCE_VERSION`
2), configurable G304 start positions with the canvas editor, and the Phase C penalty engine.
Robot-on-robot pushing was rebuilt (`SIM_VERSION` 3): push is a stated FORCE, a shoved chassis
spins, and the contact response is closing-velocity-scaled — see **Physics** above.

**Chain Reaction** — complete and scored: 300-particle bespoke physics with pre-match
randomization + the accelerator score/recycle loop, three archetypes (turret/drum/dumper) with
lead-compensated shooting on the move, four-edge shooter mounts + four intake mounts, catalysts
and hooks (multiplier, de-score allowed), ring-stand ascend/descend + Lab park, per-wheel beam
terrain with the mecanum strafe-curb, ground-clearance↔CoG tradeoff, Lab-Area start anchors
with TOP/BOTTOM roles, and the G05/G06 penalty pair.

**Netcode** — Phase 0 (server authority + prediction), Phase 1 (30 Hz delta snapshots,
interpolation, reconnection, connection-quality HUD, Fly deploy), and Phase 3 (accounts,
Glicko-2 ranked, leaderboards, records, admin, version gate) are LIVE.
**Phase 2 (Rapier)** — ROBOTS done (rotation unlocked, drive as a wrench); DECODE GROUND
ARTIFACTS done (the two-solve round loop with pinned artifacts, Sept 2026 — see **Physics**);
DECODE flight/basin/rail/gate scripted BY DESIGN; **CR PARTICLES still bespoke**.

## Next up (not started)

1. **Rapier slice 3 — the AUTO-PATH robot as a DYNAMIC body** driven toward its path target,
   so a chassis crushed between a kinematic path robot and a wall has somewhere to go (today
   the perimeter invariant is what saves it, and it saves it by refusing the push). Then **CR
   particles** to Rapier if 300 bodies a tick is affordable, KEEPING the scripted accelerator
   loop. ONLY after that: drop the `dsin/dcos/datan2` discipline.
2. **DECODE penalty hitbox audit** — G408 and G422 have now been rewritten against the manual's
   own text; what is left is the ZONE GEOMETRY each of the OTHER rules tests
   (`gateZone`/`gateTapeSegments`, `tunnelStrip`, `allianceArea`, `pinnedAgainstWall` slop, the
   SAT `rrContacts` test) versus the manual figures. Tighten with smoke cases.
   **Get the rule text from `/ftc/archive/2026/game/manual-NN`** — the live `/ftc/game/manual`
   now serves the 2026-27 pre-season manual and `manual-11` 404s there. WebFetch's own PDF
   extractor returns binary garbage on these; download the PDF and run `pdftotext -layout`
   (`pdftotext` without `-layout` for the glossary, whose two columns interleave otherwise).
   **Check every quoted definition against the real glossary before trusting it** — G408 shipped
   for months against two definitions that are not in this manual at all.
3. **Chain Reaction manual refinement** — replace the `APPROX` constants (ring-stand inset,
   Lab-Area size/geometry, exact zone coordinates) with measured manual values. This is the
   last real gap in CR; everything else there is feature-complete.
4. **Multi-core — DESIGNED, NOT BUILT (`docs/scaling-multicore.md`).** One server process is
   capped at about one core, because Node runs JavaScript on one thread; a 16-vCPU machine runs
   the same single thread as a 1-vCPU one, which is why the VM sweep found `shared-cpu-1x`
   through `8x` barely differ. Profiled, **~75% of a busy server is simulation that can leave
   the socket thread and ~6% is socket work that cannot**, and `server/room.ts` imports no `ws`
   and no `pg` — every way out of a room is already a callback — so the seam a worker needs
   exists. Recommended: `worker_threads` behind **`SIM_WORKERS`, default 0**, taking a machine
   from ~13 driven rooms to ~100 and 1,000 concurrent from 70–90 machines to single digits.
   ⚠️ **`UV_THREADPOOL_SIZE` must be raised with it** — `permessage-deflate` runs zlib on the
   libuv threadpool, that pool is PER PROCESS and defaults to 4, and left alone it becomes the
   new bottleneck and presents as LATENCY rather than as CPU. Sequence: Linux baseline first,
   then `SIM_WORKERS=1` (slower than none, on purpose — it prices the hop in isolation), then
   sweep 2/4/8. **Until a prototype exists, do not buy multi-core hardware for DSIM: nothing
   in the repo uses a second core.** `grep SIM_WORKERS` finds nothing today.
5. Deferred: WebTransport (needs TLS-deploy validation + an ACK-keyed delta), full-reload
   reconnect, obelisk AprilTag visuals, DECODE deferred fouls (G408 possession>3 / plowing),
   matchmaking polish, replay UI, leaderboard tiers.
