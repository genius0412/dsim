# Zenith autos in DSIM: plan (2026-09-24)

Branch `claude/zenith-dsim-auto-pathing-g29xta` in `genius0412/dsim` (off `alpha` @ `c4afe65`) and
the same branch name in `Horizon-36596/zenith`. The owner reviews at two checkpoints (below); the
rest is built end to end.

## 1. The goal in one paragraph

A team draws an autonomous routine in **Zenith**, the same `*.auto.json` file their robot plays
(`Horizon-36596/biobuzz` runs it through its Zenith runtime). **DSIM** plays that file in its AUTO
period: the robot **drives itself through DSIM's own drivetrain and physics**, following the path
the way Pedro Pathing v3 follows it, and runs the file's commands (intake, shoot) on DSIM's
mechanisms. Zenith is the editor and the visualizer; DSIM is the field the auto is tried on. A run
in DSIM can be sent back to Zenith as a trace, so the planned path and the driven path are drawn on
top of each other.

## 2. Is Zenith a good fit? Yes, with three limits

**Why it fits:**

- **Same frame.** Zenith files are centre-origin inches, +X to the audience's right, +Y away from
  the audience, heading CCW from +X. DSIM uses the same frame. Both mirror alliances by the same
  point symmetry, `(x, y, h) -> (-x, -y, h + pi)`, so no axis conversion is needed. The old `.pp`
  import had to rescale from a corner origin.
- **The follower already exists.** `@horizon36596/zenith-core` ships a line-for-line port of Pedro
  v3's ForesightV3 follower (`packages/core/src/sim/follower.ts`, ADR 0003). Its output is a
  robot-frame power triple, forward, strafe and turn, and that triple maps exactly onto DSIM's
  robot-centric `RobotCommand`. Pedro's mecanum normalisation, `max(1, |f| + |s| + |t|)`, is the
  same budget as DSIM's `sum` saturation. So the path is followed by **commanding the drivetrain**
  and never by writing a pose, which is the root fix for the old heading teleport.
- **The command tree exists too.** `packages/core/src/sim/simulate.ts` already models sequence,
  parallel all/race/deadline, branch, waits, timeouts, markers, `endCondition` and `"current"` legs,
  in SolversLib's scheduling order.
- **Core is pure.** It has no DOM, no clock, no randomness and no Node APIs; `pnpm test` enforces
  that. It drops into DSIM's sim code, the server and a Web Worker unchanged.

**The limits, and what this plan does about each:**

1. **The follower and command tree are welded to Zenith's own plant.** `simulate()` owns the loop;
   nothing lets another program feed in its own pose and read powers out tick by tick. **Z1** adds
   that API (`createLiveRun`). A contract test holds it to `simulate()`: fed by Zenith's own plant,
   it must produce the same trace byte for byte.
2. **Zenith only knows the BIOBUZZ field.** DECODE and Chain Reaction have no Zenith field, so this
   plan covers BIOBUZZ only. DECODE keeps its existing `.pp` path untouched (section 8).
3. **The Zenith web app cannot be driven by another app.** It has no `postMessage` channel and no
   project loading from a URL. **Z3** adds a small, generic host protocol, so DSIM (or any host) can
   open Zenith with a project and receive the edited auto back.

## 3. What was there before, and why it broke

`src/sim/pathTraversal.ts` (DECODE only; BIOBUZZ and CR set `autoPaths: false`) still does the
following:

- It advances a parameter at constant top speed, with no acceleration.
- It **writes `robot.pos` and `robot.heading` every tick**, and snaps the heading between segments.
- It skips `updateRobot`, so a path robot has no drivetrain, no traction and no motor model.
- It forces `intake` and `fire` on for the whole path.

Known bugs that follow from this:

- The heading teleport, which is what the owner reported.
- Robots passed through each other until a kinematic body was bolted on.
- Free Drive with an auto enabled freezes the robot. `autoPathActive` is set in any mode.
- The server strips autos, because they are not reconciled.

**None of this is reused.** The new auto is a *driver*: it produces `RobotCommand`s. That is the
contract the BIOBUZZ bot already follows, so it inherits replays, prediction and server authority
from a pattern that is already proven.

## 4. Architecture

```
 Zenith web (editor)  ──postMessage "zenith-host/1"──►  DSIM MatchSetup "Autonomous" panel
   draws, validates,   ◄── open {project}, trace ───        library, preview, run
   estimates, overlays                                          │
                                                                ▼  setup.zenithAuto (the file text)
 @horizon36596/zenith-core  (vendored tarball)          src/auto/  (shared, game-agnostic)
   loadAuto · resolve · plan · estimate · check           AutoSeat: BotSeat-shaped, per robot
   mirrorAuto · createLiveRun (NEW, Z1)                    ├─ createLiveRun(plan, robot, field, host)
                                                           ├─ powers -> sticks (exact updateRobot inverse)
                                                           └─ host commands from the game ▼
                                                        src/games/biobuzz/auto/
                                                           registry: shootAll, setIntake, launcherIdle,
                                                           cancelAll, relocalize; hopperFull/hopperEmpty
                                                           zenithRobotFor(spec) -> robot.json
```

### 4.1 The seat (DSIM `src/auto/`)

- `createAutoSeat(world, robotId, autoText, gameAuto)` returns a `BotSeat` (`step(world):
  RobotCommand`).
- The caller runs it **exactly where the bots run**: once per tick before the step, into the
  recorded command map, through `localizeCommand`. The call sites are `GameController.stepSolo`,
  `Room.frameCommands` and the LAN host.
- It acts only while `world.match.phase === 'auto'`. Outside AUTO it returns the driver's own
  command, so Free Drive never freezes.
- Each tick it does this:
  1. Reads the belief: the robot's pose, velocity and spin, converted into the file's alliance
     frame.
  2. Ticks the live run.
  3. Turns the powers into sticks by inverting `updateRobot` exactly: robot-centric when
     `r.fieldCentric` is off, rotated through the heading and `viewAngleOf` when it is on, and
     `leftDrive`/`rightDrive` for tank. This is the same inversion the bot's `command()` uses.
  4. ORs in the buttons the running commands hold (`intake`, `fire`, ...).
- **Mirroring:** mirror the file into the running alliance if and only if they differ, using
  Zenith's own `mirrorAuto`. Poses and headings are both mirrored.
- **Start pose:** the file's `start.pose` becomes the setup's custom start, checked by the game's
  `startLegal` (G304 and R102). An illegal start is shown in the panel and the match refuses it, the
  same as any illegal custom start.
- **Determinism:** the seat reads only the world and its own memory. It never reads
  `world.rngState` and never writes the world. A replay re-simulates from the recorded commands with
  no seat at all, the same as with bots.

### 4.2 The Zenith live run (Z1)

`createLiveRun(plan, robot, field, host, options)` returns:

```ts
interface LiveRun {
  tick(belief: LiveBelief, timeS: number): LiveTickResult; // powers + what started/ended
  readonly finished: boolean;
  trace(): Trace;          // the same Trace shape the Gradle sim writes, for the overlay
}
interface LiveHost {
  command(name: string, args: Record<string, string | number | boolean>): LiveCommand;
  condition(name: string): boolean;
}
interface LiveCommand { initialize(): void; execute(): void; isFinished(): boolean; end(interrupted: boolean): void }
```

- `simulate()` is refactored to be **this run plus Zenith's own plant and timed commands**, so the
  two can never drift apart.
- The contract test: for every example auto, `simulate(...)` equals the live run driven by
  `MecanumPlant` with `estimateS`-timed commands, byte for byte.

### 4.3 The robot file DSIM hands Zenith

`zenithRobotFor(spec)` in `src/games/biobuzz/auto/robot.ts` derives `robot.json` from the DSIM
build, so Zenith's estimate describes the robot DSIM will actually drive:

- **Footprint:** from `spec.length` and `spec.width`.
- **Kinematics:** `maxForwardVel = dp.maxSpeed`, `maxStrafeVel = dp.maxSpeed * dp.strafeMult`,
  `accel` and `decel = dp.accel`, `maxAngularVel = dp.maxTurn`.
- **Follower gains:** under `kinematics.follower`. Brake coefficients come from DSIM's active
  deceleration, `1 / (2 * accel)`. Every number carries the provenance `SET FROM SIM` until
  headless runs calibrate it, which then relabels it `CALIBRATED FROM SIM`.
- **Mouths and capacity:** from `bbMech.intake`.
- **The command registry:** the biobuzz robot's own names, so **one file runs on both the robot and
  DSIM**:

| command | args | in DSIM |
|---|---|---|
| `shootAll` | `count` 1-4, `cadence` | holds `fire` until `count` pollen have left the hopper, or it is empty |
| `setIntake` | `side` FRONT/BACK/BOTH, `state` STOP/FORWARD/REVERSE | holds `intake` while FORWARD. `side` is honoured when the build has a front-and-back mount; otherwise any FORWARD runs the one intake |
| `launcherIdle` | none | ends at once (DSIM's flywheel has no idle state to leave) |
| `cancelAll` | none | releases every held button |
| `relocalize` | none | ends at once (DSIM's belief is the truth) |
| condition `hopperFull` | none | `hopper.length >= capacity` |
| condition `hopperEmpty` | none | `hopper.length === 0` |

- A file that names a command DSIM lacks still runs. The unknown command ends at once and the panel
  lists it as a warning.
- `estimateS` for `shootAll` comes from DSIM's own fire cadence.

### 4.4 Zenith as the editor (Z3): the `zenith-host/1` protocol

1. DSIM opens Zenith in a new window: `<ZENITH_URL>/?host=dsim`.
2. Zenith posts `{type:"ready", protocol:"zenith-host/1"}` to `window.opener`.
3. The host answers `{type:"open", project:{name, robot, field, waypoints?, autos:{name:text}},
   open?: name, readOnlyRobot: true}`.
4. Zenith opens the project through a new `HostBackend`, next to the directory, desktop and GitHub
   backends. **Save** posts `{type:"save", name, text}`. DSIM validates the text with the same
   `loadAuto` and stores it.
5. `{type:"trace", auto, trace}` from the host loads a DSIM run as the "Full sim" overlay.
   `{type:"run", name, text}` from Zenith asks the host to run the auto headless and reply with a
   trace. This is the "Simulate in DSIM" button.
6. Both sides check `event.origin` against an allowlist. DSIM accepts messages only from its
   configured Zenith origin; Zenith accepts messages only from the origin named by `host=` if it is
   on its own allowlist.
7. A popup is used rather than an iframe, because Zenith's password gate sets a `SameSite=Strict`
   cookie, which an iframe cannot carry.

Zenith's UI in host mode:

- A thin host bar reads "Editing for DSIM · <robot name>", with **Save to DSIM** and **Simulate in
  DSIM**.
- The robot panel is read-only, because the robot comes from the DSIM build.
- "Open folder", GitHub and Propose are hidden.
- Everything else is the normal editor.

### 4.5 DSIM UI (BIOBUZZ)

- **MatchSetup, a new "Autonomous" section**, shown when the game's module declares `zenith`:
  - a library of saved autos (a capped list in `GameSettings`, coerced field by field);
  - **Import .auto.json**, **Paste**, **Edit in Zenith**, **Delete**;
  - a **preview** of the selected auto on the BIOBUZZ field: the planned path from zenith-core's
    `plan` samples, with the footprint at the start and end;
  - Zenith's estimate (total seconds against the 30 s AUTO);
  - the findings count, and any command DSIM will not run;
  - a **Run this auto in AUTO** toggle.
- **In the match:** the planned path is drawn faintly during `pre` and `auto`, and the status chip
  reads `AUTO · <step id>`. After AUTO, **Open run in Zenith** sends the trace.
- **Free drive:** a key (`T`) resets to the auto's start pose and plays the auto once, so a routine
  can be tried without running a whole match.

## 5. Work plan, in order

| id | repo | piece | done when |
|---|---|---|---|
| Z1 | zenith | `createLiveRun` in `packages/core/src/live/`; `simulate` rebuilt on it | the live run fed by `MecanumPlant` equals `simulate` byte for byte on every example; `pnpm test` and `pnpm build` green |
| D1 | dsim | vendor the zenith tarballs (`vendor/zenith/*.tgz`, `file:` deps); auto code in a lazy client chunk | `build`, `bundleaudit` (new chunk ratcheted, main chunk unchanged), `server:check` |
| D2 | dsim | `src/auto/` seat + `src/games/biobuzz/auto/` registry, robot file, conditions; `GameSimModule.zenith` slot | the new smoke lane `AUTO` below passes |
| D3 | dsim | wiring: `setup.zenithAuto` coercer (bounded), solo seat in `stepSolo`, start pose, Free Drive key | a solo match plays a file through AUTO, then hands control back in TELEOP |
| D4 | dsim | headless `npm run zenith:sim -- <auto>` writing a Zenith `Trace` | `zenith sim` in a robot repo can point `sim.command` at it |
| Z3 | zenith | `HostBackend`, `zenith-host/1`, host-mode chrome, Save/Simulate buttons | Playwright: a fake host opens a project, edits, receives the save |
| **CP1** | — | **owner reviews the Zenith host-mode UI (screenshots)** | |
| D5 | dsim | MatchSetup Autonomous panel, preview, in-match overlay and chip, Edit in Zenith, Open run in Zenith | `uiaudit`, `contrast`, `shiftaudit` clean; screenshots in both themes |
| **CP2** | — | **owner reviews the DSIM auto UI and a recording of a robot driving an auto** | |
| D6 | dsim | online: the seat on the server (`Room.frameCommands`), the auto in setups behind a `caps` bit, client prediction runs the same seat | `net3d` checks: server and client agree through AUTO; old clients unaffected |
| D7 | both | docs: `docs/area/autos.md` (routed, `governs: src/auto/**`), Zenith `docs/spec/12-host-protocol.md`, HANDOFF | `docaudit` ALL PASS |

**The `AUTO` smoke lane** (`scripts/smoke-biobuzz/`), each check a stated property:

- **No teleport:** across every tick of every test auto, the heading moves at most `maxTurn * dt`
  (plus a contact margin) and the position at most `maxSpeed * dt`.
- **It gets there:** a straight 48 in leg ends within 2 in and 3° of its end pose, and a bezier
  with `tangent` heading stays within 3 in of the planned curve.
- **Heading modes:** the `constant`, `linear` (short way, as the robot does), `facePoint` and
  `tangentReversed` headings each track Zenith's `headingAtT` within tolerance.
- **Both alliances:** a RED file run as BLUE drives the mirrored path, and a BLUE file run as BLUE
  is not mirrored twice.
- **Commands:** `setIntake` FORWARD collects a pollen in the path; `shootAll count:2` launches
  exactly 2; `endCondition: hopperFull` cuts a sweep short.
- **Determinism and replay:** two runs give identical worlds, and replaying the recorded commands
  with no seat gives the same world.
- **Both physics:** everything above under 2D and 3D.
- **Handover:** at TELEOP the robot takes the driver's command again. In Free Drive the seat is
  inert until `T`.
- **The real file:** biobuzz's `close.auto.json` plays to its end inside 30 s without a stall.

## 6. Decisions I took (the owner can reverse any of them)

- **BIOBUZZ only.** DECODE's `.pp` path is left exactly as it is, and removing it is a separate
  change.
- **The robot's own command names**, so one auto file serves the robot and DSIM.
- **Mirror headings too.** biobuzz's `PathBuilder.withHeading` passes `constant`, `linear` and
  `facePoint` headings through unmirrored for the other alliance (`PathBuilder.java:213-234`),
  which looks like a robot bug. DSIM follows Zenith's `mirrorAuto`, and the robot bug is filed
  separately.
- **Vendored tarballs**, because nothing is on npm yet (`npm view` returns 404). The day the
  packages publish, the `file:` specs become version ranges.
- **The auto chunk is lazy.** The main client bundle stays React + Rapier, per `CLAUDE.md`.
- **Solo first. Online (D6) comes after CP2**, because a server change needs a Fly deploy and a
  `caps` bit.

## 7. Questions only the owner can answer (none block CP1 or CP2)

1. **Autos in online matches:** custom rooms only, or ranked too? Ranked would let a player's
   file, not their hands, score AUTO points.
2. **Which Zenith URL does production DSIM open?** The public
   `libraries.horizon36596.org/zenith/app/` needs a Zenith release that carries the host protocol.
   Until then DSIM reads `VITE_ZENITH_URL`.
3. **Should the old `.pp` import go away for DECODE,** or stay until DECODE has a Zenith field?

## 8. Out of scope

- DECODE and Chain Reaction autos.
- Any change to the biobuzz robot repository.
- A Zenith field for any season but BIOBUZZ.
- Any change to ranked scoring.
