<!-- governs: src/auto/**, scripts/zenith-sim.ts, scripts/vendor-zenith.mjs -->
# AUTOS: Zenith `*.auto.json` routines, driven by an auto seat

A Zenith auto is the file a team's robot plays (`Horizon-36596/biobuzz` runs it through its
Zenith runtime), drawn and checked in **Zenith** (`Horizon-36596/zenith`). DSIM plays the same
file in AUTO by **driving** the robot. The plan and its reasons are in
`docs/plans/zenith-autos.md`; the AUTO smoke lane (`scripts/smoke-biobuzz/autos.ts`) is the
contract. BIOBUZZ only: Zenith has no DECODE or Chain Reaction field, and DECODE's `.pp` path
(`src/sim/pathTraversal.ts`) is a different, older thing that this code never touches.

## The rules

- ⚠️ **NOTHING WRITES A POSE OR A HEADING.** The seat (`seat.ts`) runs Zenith's own Pedro v3
  ForesightV3 follower and command tree (`@horizon36596/zenith-core` `createLiveRun`) against the
  robot's REAL pose and velocity each tick, and turns the robot-frame powers into the sticks
  `updateRobot` reads (`drive.ts`, the exact inverse, field-centric and tank included). The old
  `.pp` follower assigned `robot.heading` every tick, which is the heading teleport the owner
  reported; the AUTO lane checks every tick of every run against the drivetrain's own turn and
  speed limits so that shape fails by name. If a behaviour needs a pose written, it is wrong.
- **THE SEAT IS A BOT SEAT.** `step(world, driverCmd)` once per tick, BEFORE the step, into the
  command map the recorder is handed, through `localizeCommand`. So a replay re-simulates with
  NO seat, and the same code will run in `Room.frameCommands` when autos go online. The seat reads
  the world and never writes it, never reads `world.rngState`, and keeps its memory to itself.
- **IT DRIVES ONLY IN AUTO**, and in Free Drive only when ARMED (`arm()`; the controller arms it
  at every world build, so Restart plays the auto again). Outside those it hands the driver's
  command back unchanged, so TELEOP is the driver's at the buzzer and Free Drive never freezes
  (the `.pp` path froze it, because its flag was set in every mode).
- **ONE FILE, TWO ROBOTS.** The command and condition names are the robot's
  (`shootAll`, `setIntake`, `launcherIdle`, `relocalize`, `cancelAll`; `hopperFull`,
  `hopperEmpty`), so the file a team deploys is the file it practises. A name DSIM does not run
  ends at once and is listed, never refused: a file must not stall on a future command.
- **THE ALLIANCE RULE IS THE ROBOT'S**: a file's `alliance` names the alliance its poses are
  written for; it is mirrored iff the robot plays the other one, headings and `facePoint` points
  included (Zenith's `mirrorAuto`). ⚠️ Waypoint `ref`s are INLINED FIRST (`load.ts`), because
  `mirrorAuto` leaves a ref alone and `waypoints.json` is canonical.
- **THE ROBOT FILE IS DERIVED, NEVER TYPED** (`src/games/biobuzz/auto/`): speeds, accel and turn
  rate from `driveParams`, the footprint from `bbFootprint` (intake reach INCLUDED: the bare
  chassis parked the intake bar 3 in inside a wall), every number labelled `SET FROM SIM`. The
  follower gains are the robot's measured ones (`CARRIED OVER`).
- ⚠️ **THE FIELD DSIM HANDS ZENITH HAS DSIM'S WALLS.** Zenith's BIOBUZZ file is the manual's
  nominal 144 in (±72); DSIM is FIRST's CAD (±70.674). Against 72 a path 1.3 in past DSIM's wall
  plans clean and then wedges the robot, so the adapter overrides `sizeIn` and derives the season
  rules (`loadSeason`) from that field.
- ⚠️ **ZENITH IS A LAZY CHUNK.** Only `types.ts`, `coerce.ts` and `library.ts` are in the main
  chunk, and none of them may import `@horizon36596/zenith-*` (types excepted). Everything else is
  reached through `import('./auto/zenithAutos')`, a facade NAMED so the chunk is not `index-*`
  (it once was, and `bundleaudit` billed it as main). `bundleaudit` routes it as `autos`.
- **THE LIBRARY IS NOT IN `GameSettings`.** Settings sync to the account under a 64 KB cap
  (`server/api.ts`) and one auto can be most of that, so it is `ZENITH_AUTOS_KEY` in
  `localStorage`, device-local, registered in `storageKeys.ts`.
- **`setup.zenithAuto` IS BOUNDED BYTES** (`coerceZenithAuto`: 64 KiB auto, 16 KiB waypoints) and
  dropped by `coerceSetup` for a game without `GameSimModule.zenithAutos`. The one validator is
  Zenith's schema, in the seat: a bad file makes the seat report an error and drive nothing.
- **SOLO ONLY, for now.** `GameView` loads the chunk for Solo practice and Free Drive; a room, a
  record run and the tutorial never get a seat. Online is plan item D6 (a `caps` bit, the seat in
  `Room.frameCommands`, the same seat predicting on the client) and is a SERVER change.

## Zenith as the editor: `zenith-host/1`

`src/ui/zenithHost.ts` is DSIM's side of Zenith's host protocol (Zenith `docs/spec/12`): "Edit in
Zenith" opens a POPUP (never an iframe: Zenith talks back through `window.opener`, and a gated
Zenith's cookie is `SameSite=Strict`) with this build's robot file, the field and the library.
Save comes back as `save` and is validated with `parseAutoText` before it is stored; "Simulate in
DSIM" is answered with `runAutoHeadless`'s trace. Messages are read only from the popup DSIM
opened and from Zenith's origin (`VITE_ZENITH_URL`, default the public app). `zenithLaunch.ts`
is the one place a screen opens it; `window.open` must run inside the click, so it is synchronous.

## Traces

`headless.ts` (`runAutoHeadless`) plays an auto in a real match world for one AUTO period and
returns Zenith's `Trace` (`source: "live"`, capability `dsim`). It backs "Simulate in DSIM",
"Drive it here" and `npm run zenith:sim -- <auto>`, which a robot repository's `zenith.json`
`sim.command` can point at so `zenith sim` and `zenith calibrate` read DSIM. A run on the
alliance the file was not written for is mirrored back (`traceInFileFrame`) before it goes to
Zenith, so it lies over the plan Zenith drew.

## Vendoring

The Zenith packages are not on npm yet: `vendor/zenith/*.tgz` are `file:` deps, packed by
`node scripts/vendor-zenith.mjs ../zenith`, which records the source commit in
`vendor/zenith/SOURCE.md` and reinstalls the tarballs (⚠️ plain `npm install` keeps a changed
tarball's OLD integrity hash, and `npm ci` then refuses it). The Dockerfile copies `vendor/`
before `npm ci`. The day they publish, the specs become version ranges.
