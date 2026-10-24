<!-- governs: src/auto/**, scripts/zenith-sim.ts, scripts/zenith-e2e.mjs, scripts/vendor-zenith.mjs, scripts/fetch-zenith.mjs -->
# AUTOS: Zenith `*.auto.json` routines, driven by an auto seat

A Zenith auto is the file a team's robot plays through Zenith's robot runtime, drawn and checked
in **Zenith** (`Horizon-36596/zenith`). DSIM plays the same
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
- **THE COMMANDS DSIM RUNS** are `shootAll`, `setIntake`, `launcherIdle`, `relocalize`,
  `cancelAll`, and the conditions `hopperFull`, `hopperEmpty`. A robot repository that registers
  the same names with its Zenith runtime deploys the file it practises. A name DSIM does not run
  ends at once and is listed, never refused: a file must not stall on a future command. Zenith's
  "robot.json does not register" finding for such a name is dropped from `LoadedAuto.findings`:
  `unsupported` already lists it, and as an error it put a red line on Zenith's own starter autos.
  ⚠️ **`setRamp` (`state: DEPLOY | STOW`) IS DSIM-ONLY**: the team's robot has no ramp today, so
  its runtime would list it as unregistered. It presses the driver's own RAMP toggle
  (`RobotCommand.bbRamp`) until the ramp is where the file wants it, then waits out the swing. A
  build without the `ramp` intake ends it at once and the panel lists it as not on this robot
  (`GameAutoAdapter.notOnRobot`), rather than as unknown to DSIM. Its summary says "no ramp" once;
  the `notOnRobot` reason leaves "it ends at once" to the panel.
- ⚠️ **A `shootAll` THAT CANNOT SHOOT ENDS, AND SAYS SO.** Aim Assist is on for every robot
  (`coerceAssists`; headless too), so FIRE releases a shot only when it would land. From a pose the
  build cannot score from nothing leaves, and the auto held FIRE for the rest of AUTO (StarterBot
  28 in from the cell; it scores from 41 to 46). So `shootAll` gives up when nothing has left the
  hopper for `bbShotPatienceS(spec)` (the build's aim and launch beat plus 1 s, restarted by each
  launch; StarterBot **2.35 s**), and the seat reports `AutoSeatStatus.cantShoot` (the step id) for
  3 s of match time. The HUD reads it as `AUTO COULDN’T SHOOT ON <STEP>` (STUCK wins over it). A real robot would launch and
  miss; DSIM keeps the preload, because the seat cannot switch Aim Assist off.
- **FORMAT 4**: a `transfer` is planner-only; the runtime and the live run treat it as a zero-second
  wait (one scheduler tick), so it moves nothing. `envelope` and `rejoinFrom` are planner-only too.
  `mirrorAuto` is called without `mirrorId`, so a running routine's transfer and `expect` ids stay
  as written; nothing DSIM drives reads them.
- **THE ALLIANCE RULE IS THE ROBOT'S**: a file's `alliance` names the alliance its poses are
  written for; it is mirrored iff the robot plays the other one, headings and `facePoint` points
  included (Zenith's `mirrorAuto`). ⚠️ Waypoint `ref`s are INLINED FIRST (`load.ts`), because
  `mirrorAuto` leaves a ref alone and `waypoints.json` is canonical.
  ⚠️ **THE FINDINGS ARE THE FILE'S** (`LoadedAuto.findings`): checked on the routine in its own
  alliance, so DSIM names the elements Zenith names for that file (a RED file on a BLUE robot said
  `flower3Foot` where Zenith said `flower1Foot`). A tank's legs are re-headed in the file's frame
  and then mirrored for the seat; `plan` and `estimate` stay the running routine's.
- **THE ROBOT FILE IS DERIVED, NEVER TYPED** (`src/games/biobuzz/auto/`): speeds, accel and turn
  rate from `driveParams`, the footprint from `bbFootprint` (intake reach INCLUDED: the bare
  chassis parked the intake bar 3 in inside a wall), every number labelled `SET FROM SIM` or
  `SET BY HAND`. The follower runs on Pedro v3's defaults except the heading gain (3, tuned in the
  AUTO lane). ⚠️ **No team's numbers go in it**: this repository is public, and the AUTO lane
  fails a label that is not DSIM's own or a file that names a team repository.
- ⚠️ **A TANK IS A MECANUM FILE, DRIVEN NOSE- OR TAIL-FIRST.** Zenith's follower and robot schema
  are mecanum-only (no drivetrain kind). Pedro puts heading feedback before the drive vector, so
  a tank asked to hold a heading it cannot reach drove NOTHING (StarterBot, the kit preset,
  stalled on garden-cycle's first leg for all 30 s). For `adapter.holonomic(spec) === false`,
  `load.ts` re-plans every path leg `tangent`/`tangentReversed` (`LoadedAuto.reheaded`) and
  `drive.ts` `nonHolonomic` steers the request. The robot file states the forward speed as the
  strafe cap (was 1 in/s: a 155 s estimate); what Zenith cannot price is the turn at a corner.
- **STUCK IS SAID, NOT FIXED** (`seat.ts`): a path step with no `timeoutS` whose follower asks for
  power while the robot stands still for 1.5 s reports `stuck`, and the HUD reads `AUTO STUCK ON
  <STEP>`. Waits, commands and author-bounded shoves into a wall never count.
  ⚠️ "Asks for power" means more than HALF the follower's braking cap (`maxBrakingPower`, read
  from the parameters it runs on). A blocked robot's velocity is noise that flips sign each tick,
  and Pedro caps power against it at that cap, so a blocked leg asks for only the cap on about
  half its ticks. A fixed 0.25 floor over Pedro's default 0.2 reset the count there and nothing
  read stuck (2026-10-10).
- ⚠️ **THE FIELD DSIM HANDS ZENITH HAS DSIM'S WALLS.** Zenith's BIOBUZZ file is the manual's
  nominal 144 in (±72); DSIM is FIRST's CAD (±70.674). Against 72 a path 1.3 in past DSIM's wall
  plans clean and then wedges the robot, so the adapter overrides `sizeIn` and derives the season
  rules (`loadSeason`) from that field. ⚠️ **The positions move with it** (obstacles, zones,
  elements, scaled by DSIM's wall over 72; sizes kept): Zenith stretches its full-bleed picture
  over `sizeIn`, so overriding `sizeIn` alone left every overlay 1.3 in off the art at the walls.
  Nested points move too (`POINT_KEYS`: `pivotIn`, and field format 3's strut ends `fromIn`/`toIn`;
  `zIn` and `radiusIn` kept). The AUTO lane walks Zenith's file beside the handed one, so a new
  point key fails by name. Zenith's HIVE legs are CAD numbers already, so the scale puts them
  0.44 in inboard; they still sit inside DSIM's measured leg footprint (lane tolerance 0.5 in).
- ⚠️ **ZENITH IS A LAZY CHUNK.** Only `types.ts`, `coerce.ts` and `library.ts` are in the main
  chunk, and none of them may import `@horizon36596/zenith-*` (types excepted). Everything else is
  reached through `import('./auto/zenithAutos')`, a facade NAMED so the chunk is not `index-*`
  (it once was, and `bundleaudit` billed it as main). `bundleaudit` routes it as `autos`.
  The CLIENT imports `src/ui/zenithEditor.ts` instead: the facade plus the editor popup
  (`zenithLaunch.ts`, `zenithHost.ts`, which read `window` and `import.meta.env`, so the server
  must not). The robot builder's Autonomous panel is `React.lazy` too. Both went lazy on
  2026-09-26 because the alpha merge put main over its ceiling; keep new auto UI out of main the
  same way.
- **THE LIBRARY IS NOT IN `GameSettings`.** Settings sync to the account under a 64 KB cap
  (`server/api.ts`) and one auto can be most of that, so it is `ZENITH_AUTOS_KEY` in
  `localStorage`, device-local, registered in `storageKeys.ts`.
- **`setup.zenithAuto` IS BOUNDED BYTES** (`coerceZenithAuto`: 40 KiB auto, 8 KiB waypoints, so one `zenithAuto` message fits the server's 64 KiB frame cap) and
  dropped by `coerceSetup` for a game without `GameSimModule.zenithAutos`. The one validator is
  Zenith's schema, in the seat: a bad file makes the seat report an error and drive nothing.
  Every load error is one sentence (`sentence()` folds the detail's own full stop). A file above
  the vendored schema's `FORMAT_VERSIONS` gets DSIM's own line ("saved by a newer Zenith (file
  format N), and this DSIM reads up to format M. Reload DSIM; …"), never Zenith's "this build of
  Zenith".
- **SOLO AND CUSTOM ROOMS; NEVER RANKED OR RECORD** (owner, 2026-09-25). Solo: `GameView` loads
  the chunk for Solo practice and Free Drive (the tutorial never gets a seat). Custom rooms: the
  lobby sends the active auto once in `{ t: 'zenithAuto' }` (never on the roster, which carries
  only `autoName`), gated on the server's `'zenithAuto'` cap; `Room.playsZenithAutos` refuses it
  in a ranked, staged or record room and `beginMatch` strips it there. The server seats the robot
  at the auto's start and runs the seat in `frameCommands` beside the bots; the client runs the
  same seat over its prediction (`GameController.loadSessionAuto`). `room.ts` is also the LAN
  host's room, so LAN rooms play autos too. ⚠️ It is a SERVER change: it needs a deploy (alpha
  has its own server, `./scripts/fly-deploy.sh --alpha`), and the Fly image needs the Zenith
  packages (vendored or published) to build.

## Zenith as the editor: `zenith-host/1`

`src/ui/zenithHost.ts` is DSIM's side of Zenith's host protocol (Zenith `site/docs/host-protocol.md`): "Edit in
Zenith" opens a POPUP (never an iframe: Zenith talks back through `window.opener`, and a gated
Zenith's cookie is `SameSite=Strict`) with this build's robot file, the field and the library.
Save comes back as `save` and is validated with `parseAutoText` before it is stored; "Simulate in
DSIM" is answered with `runAutoHeadless`'s trace. Messages are read only from the popup DSIM
opened and from Zenith's origin (`VITE_ZENITH_URL`, default the public app). `zenithLaunch.ts`
is the one place a screen opens it; `window.open` must run inside the click, so it is synchronous.
⚠️ **THE PROJECT IS BUILT AT EVERY `ready`**, from the library as it is then: a reload in the popup
(or the gate's re-login) used to get the project captured at launch, so saved edits came back old.
A reload reopens the auto the session saved last. ⚠️ **A SAVE NEVER REPLACES AN AUTO THE SESSION
DID NOT SEND**: every New in Zenith names its auto `new-auto`, so a save under a library name the
session never sent is stored under a free one (`new-auto-2`), and a new auto into a full library
(12) is refused with a sentence instead of dropping the oldest, which could be the one AUTO plays.
⚠️ **ONE WAYPOINTS FILE, AND A CLASH IS LEFT OUT** (owner's ruling, option A: merge on DSIM's side,
no protocol change; `src/auto/hostLibrary.ts`). The file sent is the opened auto's, with the other
autos' names merged in, newest first. An auto that names a waypoint the merged file already holds at
a different pose is NOT sent: Zenith would draw and edit it against the other auto's pose while DSIM
plays its own. The Autonomous panel (or the match log) says in one sentence which auto and why; Edit
in Zenith on that auto makes its file the base. Equal poses are not a clash. Zenith's `save` carries
no waypoints, so a save stores the auto's OWN file unchanged plus only the names its text uses that
the own file lacks, from the file the session sent (`waypointsForSave`): a pose it had never moves.
At 12 autos New in Zenith stays in the panel, disabled, with the reason (`LIBRARY_FULL`); Import stays on, because a file named like an auto in the library replaces it (see the panel's rules below).
⚠️ **NEW IN ZENITH SENDS THE LIBRARY WITH `newAuto: true`** (not an empty `autos`), so Zenith names the new
auto clear of every auto sent (`new-auto-2`, …) and DSIM keeps that name; only a left-out auto's name,
which Zenith could not see, is renamed, once. **Every `open` carries `hostBuild: HOST_BUILD`**
(`src/ui/zenithOpen.ts`, with the message builder): Zenith says "DSIM needs an update" and turns Save to
DSIM and Simulate in DSIM off when a page's build is below its DSIM row's `minBuild` (Zenith
`apps/web/src/project/hostOrigins.ts`). ⚠️ Raise `HOST_BUILD` by one in the same commit as any change to
what DSIM sends in `open`. **Build 2** (2026-10-24) is the first that reads auto format 4; Zenith `main`
sets `minBuild: 2`, so alpha's build 1 had Save to DSIM off from the day Zenith wrote format 4.
⚠️ **THE VENDORED ZENITH AND `HOST_BUILD` MOVE TOGETHER**: a Zenith that writes a newer format raises
its `minBuild`, and DSIM re-vendors and raises `HOST_BUILD` in one commit.

- **`newAutoStart`** (Zenith #511): every `open` carries where the player's robot starts
  (`playerStartPose`, `src/ui/zenithProject.ts`): the pose a match world spawns it at for this build,
  alliance and start setting, so an anchor re-seated for the footprint is the pose sent. A new auto in
  that session starts there instead of RED's audience wall (sweep W4-7). A Zenith without #511 ignores it.
- **`runFailed`**: a Simulate in DSIM that throws (the auto does not load, the robot cannot run it) goes
  back with the error's sentence at once; it used to be a console line and Zenith waited out 60 s
  (W4-2). A screen that opened Zenith without `onRun` answers with where to open it from.
- ⚠️ **ONE WINDOW, REUSED** (DSIM-4): a second Edit in Zenith while the window is open hands that window
  the new launch's options and posts a new `open` (or waits for `ready` if it is still loading). It
  used to post `close` and re-navigate the named window, which raised the leave-site prompt over
  unsaved edits. Zenith asks about unsaved edits itself before a new `open` replaces the project.
- **THE WAIT FOR `ready`** (DSIM-7): no `ready` in 12 s puts `ZENITH_NOT_READY` in the panel's notice
  ("…If its window asks you to sign in, sign in there…"): a gated Zenith says nothing until the
  player signs in. It is a sentence, not a failure; `ready` puts the open line back.
- ⚠️ **THE BUILD IS READ WHEN IT IS USED** (`LaunchOptions.liveSettings`, W4-D4): the robot file at every
  `ready` and the robot a Simulate in DSIM drives come from the panel's current settings, not the click
  that opened Zenith. **Zenith's bar names a preset build by its preset** (`hostLabelFor`, W4-D12):
  applying a preset keeps the player's name, so a StarterBot read "My Robot" there.
- **THE BLOCKED POPUP** says only to allow pop-ups (`POPUP_BLOCKED`, DSIM-6): opening Zenith's address
  by hand cannot reach DSIM, so offering it was a dead end.

## The Autonomous panel (`src/ui/AutonomousSetup.tsx`)

The third block of Play ▸ Match setup, in the right column that scrolls inside itself (`docs/area/ui.md`,
THE MENU STAGE). Everything it decides is DOM-free (`src/auto/library.ts`, `src/ui/autoHud.ts`), and the
`AUTOUI` lane (`scripts/smoke-biobuzz/autosUi.ts`) holds it. From the Zenith UX sweep, 2026-10-20.

- ⚠️ **THE ORDER IS THE REACH.** At 1280x720 that column is ~450px and the preview alone is 300, so
  with the preview first the buttons were a screen and a half down, under the column's fade and the
  pinned Solo / Multiplayer bar (W4-D8). The order is: the library, Import and New in Zenith, the
  notice, the selected auto's verdict, Edit in Zenith and Drive it here, the Play switch, the command
  list, then the preview beside its facts. With a few autos everything but the preview is in the
  first screenful from the section's heading, at 1280x720, 1366x768 and 360x740. Twelve autos need
  ~90px of scroll to reach the Play switch. The AUTOUI lane reads the source for the order. The
  alternatives that were not built: the section above Start position (the auto sets where the
  robot starts anyway), or its own page in the column with a Back, as Solo and Multiplayer have.
- **THE LIBRARY IS A COMPACT LIST** (`.ds-opts.list`, W4-D11): one row per auto, the name left and its
  state right (`Plays in AUTO`, `From Zenith`, `Imported`), `.ds-opt` look, a `.ds-opt-del` on each.
  Twelve card-shaped tiles were ~900px tall. It scrolls inside itself past four rows with the fifth cut
  in half to say so, scrolls the picked row into view after an import or an Undo, and every row is
  still a button, so Tab, Enter and the pad reach it.
- **A NEW NAME INTO A FULL LIBRARY IS REFUSED, NEVER DROPPED** (W4-D2): `importAutos` adds each parsed
  file, and a file whose name is not in the library, with 12 in it, goes to `refused`; the panel says
  "Couldn’t import a.auto.json, b.auto.json. The library is full (12). …" (`libraryFullFor`, three
  names then a count). A name already in the library is replaced and moves to the top, full or not.
  `upsertAuto`'s cap stays as the last line for callers that do not ask, and now drops the oldest
  entry that is NOT the active one: it used to drop the oldest, and when that was the active auto the
  active id moved to the new file with AUTO still on.
- **DELETE HAS AN UNDO** (W4-D10): the notice reads "Deleted <name>." with an Undo button
  (`removeAuto` / `restoreAuto`): the entry goes back at its own index, as the auto AUTO plays and
  switched on again only if nothing else has become the active auto since, and it is refused with a
  sentence if the library has filled up or the name is taken. One level; the next notice replaces
  it. A delete from the keyboard moves focus to Undo, because the row it was on is gone.
- **A COUNT IS PLURAL ONLY WHEN IT IS** (W4-D9): "1 step", "1 problem", "Warning" / "Warnings",
  "It ends" / "These end" (`countOf`, `planVerdict`, `warningsFact`).
- **THE COMMAND LIST IS OPEN FOR AN EMPTY LIBRARY** (DSIM-8) and sits under the Play switch otherwise,
  not below everything, so it is found. Deleting the last auto opens it again.
- **THE PRE-MATCH LINE SAYS WHAT WILL NOT RUN** (W4-D13): `GameAutoStatus` carries `unsupported`
  (commands DSIM does not run), `unsupportedConditions` and `notOnRobot`, told apart in
  `GameController.seatAuto` because `LoadedAuto.unsupported` joins commands and conditions and they
  fail differently: a command "ends at once", a condition "never reads true" (a wait on it runs to
  its timeout). "garden-cycle plays in AUTO. intakeOn is not in DSIM and ends at once." The line is a
  warning when anything is named, and a clean auto, an error and a flagged auto read exactly as
  before. The panel's facts split the same way ("Not in DSIM", "Conditions not in DSIM").
- **START POSITION SAYS WHEN AN AUTO DECIDES IT**: an auto seats the robot at the file's start, so
  while one plays the Start position section reads "<auto> plays in AUTO, so the robot starts where
  that auto starts…" (`SoloSetup.tsx`, `useActiveAutoName`). A picked start used to be ignored with
  nothing said. `saveAutoLibrary` fires `AUTO_LIBRARY_CHANGED` on `window` so that note follows the
  panel's switch; another tab's write arrives as `storage`.
- **THE BUTTON IS RESET** (W4-D14): the HUD button, the pre-match hint ("R · reset") and this panel's
  help line all say RESET. RESTART was tried and is 14px wider, which pushed the sponsor chip off a
  360px phone's HUD row. Controls still names the action Restart (`controlsLayout.ts`).

## Traces

`headless.ts` (`runAutoHeadless`) plays an auto in a real match world for one AUTO period and
returns Zenith's `Trace` (`source: "live"`, capability `dsim`). It backs "Simulate in DSIM",
"Drive it here" and `npm run zenith:sim -- <auto>`, which a robot repository's `zenith.json`
`sim.command` can point at so `zenith sim` and `zenith calibrate` read DSIM. A run on the
alliance the file was not written for is mirrored back (`traceInFileFrame`) before it goes to
Zenith, so it lies over the plan Zenith drew. The run stops at the end of AUTO without stepping into
TELEOP, so it calls `seat.end()` (the buzzer): a step still open ends there, interrupted. Without
it the step kept the `endS` it opened with, and Zenith drew a 30 s run as 0.6 s.

**THE WHOLE EXCHANGE, THROUGH A REAL POPUP:** `node scripts/zenith-e2e.mjs <zenith-checkout>` (headless,
12 checks: New in Zenith at DSIM's start, Save to DSIM, Simulate in DSIM, a reused window, Play it in
AUTO, closing). Run it after any change to `src/ui/zenith*.ts` or a re-vendor; its header lists the two
dev servers it needs. The smoke lanes hold the pure parts; only this sees both windows.

## Vendoring

⚠️ **THE TARBALLS ARE NOT IN GIT, AND MUST NOT BE** (`.gitignore`): a packed package is its
compiled source, and it was pushed once while Zenith was private (the branch was rewritten to
take it back out). Zenith 0.1.1 is on npm, but it has NEITHER `createLiveRun` NOR host mode, which
landed after it. So until a release carries them, `vendor/zenith/*.tgz` are `file:` deps packed by
`node scripts/vendor-zenith.mjs ../zenith` from a Zenith checkout holding those commits (it records
the commit in `vendor/zenith/SOURCE.md`, takes the version from Zenith's `package.json`, writes the
three tarballs' sha512 into `package-lock.json` in place, and runs `npm ci`: ⚠️ plain `npm install`
keeps a changed tarball's OLD integrity hash, which `npm ci` then refuses, and installing the tarballs
by path rewrites unrelated lockfile rows). The Dockerfile copies `vendor/` before `npm ci`.
⚠️ **ON WINDOWS, STOP EVERY DEV SERVER AND TEST RUN IN THAT CHECKOUT FIRST**: `npm ci` deletes
`node_modules` before it installs, a running Vite or tsx holds `esbuild.exe`, and the install stops
half done (`EPERM`). `npm install` puts the missing packages back; then restore `package-lock.json`.
Then copy the three tarballs onto the vendor repository's `dsim-vendor` branch (its README's table
names the Zenith commit) and push that branch right before the DSIM push that carries the lockfile:
in between, every alpha build that fetches refuses the tarballs.

**A BUILD WITH NO ZENITH CHECKOUT** (Vercel alpha, a Fly deploy from a fresh clone) runs
`node scripts/fetch-zenith.mjs` first: `vercel.json`'s `installCommand` and `scripts/fly-deploy.sh`
both do. It downloads each missing tarball from a private repository's branch through the GitHub
contents API and writes it only if its sha512 is the one `package-lock.json` pins, so a stale or
tampered tarball stops the build instead of installing. It needs, in the build's environment:

| variable | value |
|---|---|
| `ZENITH_VENDOR_REPO` | `owner/repo` holding `vendor/zenith/*.tgz` (not named here: this repository is public) |
| `ZENITH_VENDOR_REF` | branch or commit; default `dsim-vendor` |
| `ZENITH_VENDOR_TOKEN` | a fine-grained token with **Contents: read** on that one repository and nothing else |

It is a no-op when every tarball is already present and matching (a dev box that ran
`vendor-zenith.mjs`) or when no Zenith dependency is `file:`. ⚠️ **Re-vendoring changes the
lockfile's hashes**, so the tarballs on that branch must be replaced with the same bytes in the same
push, or every build that fetches will refuse them (which is the point).

**THE DAY A RELEASE CARRIES THEM** (check: `npm view @horizon36596/zenith-core@<v>` and grep its
`dist` for `createLiveRun`):
1. `npm install @horizon36596/zenith-core@^<v> @horizon36596/zenith-schema@^<v>
   @horizon36596/zenith-season-biobuzz@^<v>`, which replaces the `file:` specs and the lockfile rows.
2. Delete `vendor/`, `scripts/vendor-zenith.mjs`, `scripts/fetch-zenith.mjs` (and its lines in
   `vercel.json`'s `installCommand` and `scripts/fly-deploy.sh`), the Dockerfile's `COPY vendor`
   line, the `vendor/zenith/*.tgz` line in `.gitignore`, the three `ZENITH_VENDOR_*` Vercel env vars,
   and this section down to this list; drop both scripts from this guide's `governs:`.
3. `rm -rf node_modules && npm ci`, then `npm run build`, `server:check`, `npm run test:bb -- --lane
   AUTO`, `npm test`, `bundleaudit`, `docaudit`. Then the branch builds anywhere.

## Going to `main`

Autos are on `alpha` only. They go live on `main` the day Zenith publishes the release that carries
host mode and `createLiveRun` (Zenith's own rule: its CLAUDE.md, "Releases"; the release notes' step
12), and not before, because production DSIM opens the PUBLIC Zenith (`ZENITH_URL`'s default,
`libraries.horizon36596.org/zenith/app/`), which has no host mode until then. On that day:

1. Do "THE DAY A RELEASE CARRIES THEM" above on `alpha` (npm versions instead of vendored files), so
   neither Vercel production nor the production Fly image needs the vendor token.
2. `HOST_BUILD` must be at least the released Zenith's DSIM `minBuild`.
3. Production Vercel must NOT set `VITE_ZENITH_URL` (the default is the public app); alpha's Preview
   keeps pointing at the gated beta.
4. It is a SERVER change (custom rooms run the seat), so production needs `./scripts/fly-deploy.sh`
   from a `main` worktree, on the owner's word.
5. Check on production: New in Zenith opens the public Zenith with "Editing for DSIM", Save to DSIM
   lands in the library, Simulate in DSIM draws the trace, and a solo practice plays the auto.
