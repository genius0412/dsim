# BIOBUZZ 3D: one game, a 3D deterministic authority, 2D or 3D on screen

## 0. Status

**DRAFT 3, 2026-09-17, branch `biobuzz-3d`, `docs/biobuzz/plan-3d.md`.** **Day 0 and Day 1 LANDED on 2026-09-17** (see `HANDOFF.md`): the seam, `sim3d/`, `scene/`, the client wiring and the CAD field are merged; CAD-vs-constants findings (flowers, walls, hive heights) are OPEN pending the owner. Day 2 not started. Draft 1 (a 3D view over
the 2D sim) and draft 2 (a separate `biobuzz3d` game) were both rejected by the owner. This draft
follows the owner's direction of 2026-09-17: BIOBUZZ stays ONE game; every ranked or record match
runs on a 3D deterministic server; players render in 2D or 3D and the 2D path must stay very
fast; practice offers the old 2D physics, the 3D physics with a 2D view, or the 3D physics with
3D rendering, each with or without AI; prediction is a player option; graphics have presets and
detailed settings; GPU acceleration is on automatically. Line references are as of
`efficiency-audit` `e0ce598`, which was merged into `alpha` on 2026-09-17 (1ecc3f2), so this branch's
base carries the CLAUDE.md split, `docaudit` and the sharded suite.

Decisions, one line each:

1. **One game id, `biobuzz`.** Boards, queue, replays, records stay one population. Rows gain a
   `physics` tag so a board can show or filter 2D-era and 3D-era results.
2. **Two physics under one step.** `World.biobuzz.physics` is `'2d'` (today's pipeline, unchanged)
   or `'3d'` (new, `src/games/biobuzz/sim3d/`). `biobuzzStep` dispatches on it. **The 2D pipeline
   is permanent**: it is the light practice option (owner decision 2026-09-17), never deleted.
3. **The 3D physics is Rapier 3D, deterministic build**, `@dimforge/rapier3d-deterministic-compat`
   0.20, authoritative on the server for every ranked, record and matchmade room and in every
   replay of one. Robots, all 56 elements, the flowers and the frame are real bodies in one
   persistent world serialised to plain JSON each tick. **The hive is a dynamic see-saw** on a
   revolute joint with a calibrated ballast and detent, so the tip and the spill are emergent
   (owner decision; the table rows become the calibration targets, 3.6).
4. **The wire is the same for 2D and 3D clients.** Snapshots already carry element `z/vz`;
   robots gain `z/vz`. A 2D client ignores what it does not draw. No per-view packets.
5. **Two renderers over one world.** The existing canvas renderer (2D view, any device, no wasm,
   no WebGL) and a lazily loaded Three.js r186 renderer (3D view). Both read the same `World`.
6. **Prediction is a setting: Off, Light, Full.** Light (drive model plus walls, no 3D wasm) is
   the 2D default; Full (a small 3D prediction world) the 3D default; Off is pure interpolation.
7. **Graphics: presets Auto / Low / Medium / High / Ultra / Extreme / Custom** over sixteen
   detailed settings, per device. Auto never picks Extreme (2026-09-27). Auto detects the GPU, benchmarks two seconds, and picks; software GL
   falls back to the 2D view. `powerPreference: 'high-performance'`, hardware acceleration never
   disabled in the app.
8. **Practice is local**: physics 2D or 3D, view 2D or 3D, AI opponents off or a tier. Practice
   runs upload with `physics` and `view` tags; only 3D-physics runs are comparable to ranked.
9. **The field is imported from FIRST's public CAD** through a scripted STEP-to-glTF pipeline
   (visual mesh, collider meshes, measurements), and **the derived files ship** (owner decision
   2026-09-17, accepting the licence risk); constants-built geometry stays as the fallback.
10. **Days, not weeks.** Day 1 plays the whole game on 3D physics in the 2D view; Day 2 has 3D
    rooms online; Day 3 ships the 3D renderer and graphics settings to alpha. Three lanes.

---

## 1. Goals and non-goals

**Goals.** A BIOBUZZ match whose competitive outcomes come from a 3D rigid-body solve: a 29-in
robot stops under the 25.5-in down cell; a tipped tray dumps its load and it rolls; a shot
through a cell's closed back bounces off steel; a nectar dropped into a flower lands on the pollen
below it. A 2D player and a 3D player in the same match see the same truth at their own cost:
the 2D canvas path stays as light as today. Practice on any device, 2D or 3D physics, with or
without AI. Graphics that scale from a Chromebook to a desktop GPU without the player touching
anything, and every setting exposed for those who want to. Reuse the netcode, accounts,
Glicko-2, replays, LAN, Electron, mobile, the drivetrain model and the BIOBUZZ rules layer.

**Non-goals for the first ship.** No launched element enters a flower (standing ruling). No new
command bits (the `buttons` byte is full; deployment is a phase read). No robot pitch and roll
yet (designed for, 3.3). No robot model imports, no WebGPU (an Ultra option later), no season
reset (`BALANCE_VERSION`/`SIM_VERSION` held, per the owner's standing rule).

**Realism is the tie-breaker.** Where the manual describes a physical thing, the sim builds the
thing and lets the rulebook score whatever happens (owner direction 2026-09-17).

---

## 2. Architecture

### 2.1 One game, two physics

`World.biobuzz.physics: '2d' | '3d'` (absent reads `'2d'`, so every stored world, snapshot and
replay is unchanged). `createBiobuzzWorld(mode, seed, setups, settings, physics)` builds the same
staging (positions, preloads, stock, hives, flowers) and then either leaves the 2D pipeline to run
or seats every element and robot as a body in the 3D world. `biobuzzStep` reads the tag once per
tick and calls `step2d` (today's `step.ts` body, moved) or `step3d`.

Who picks the physics:

⚠️ **SUPERSEDED 2026-09-18 by the owner's ruling: every server-connected match is 3D.** The
table below is the Day 2 design, kept for the reasoning; the rows marked *(was)* no longer hold.

| context | physics | who decides |
|---|---|---|
| ranked, matchmade, record rooms | `3d` | the server, always |
| custom lobby (code room) | `3d` | the server, always — *(was: the host, a `2d` lobby option)* |
| LAN room | `3d` | the server, always — a LAN room is an ordinary `Room` — *(was: the host)* |
| solo practice / free drive | `3d` default | the player, in Practice setup — the ONE place 2D survives |
| replay playback | the replay's header | recorded |

A room's physics is decided by `Room.physics` off the GAME alone (`serverPhysics`,
`src/games/types.ts`) and rides the `matchStart` message and the world bag. `RoomConfig.physics`
is still on the wire and still sanitized, but no current server reads it — a NEW client keeps
sending `'3d'` so that a server one deploy behind, which does read it, builds the same room.
Matchmaking stages rooms with `physics: '3d'` only.

The record board follows: it shows 3D runs only (`boardPhysics` in `server/db/repo.ts`), and so
do the personal best, the rank and the career panel that sit beside it. The 2D rows from before
the ruling are kept, not deleted — they keep their replay and their place in a player's own match
history, and no season was reset over this.

### 2.2 Mode matrix

| | 2D view (canvas) | 3D view (Three.js) |
|---|---|---|
| 2D physics (practice, casual rooms) | today's game, unchanged | the scene draws the 2D world: elements at their `z`, hive from `tipping`, robots at height 18 |
| 3D physics (competitive, practice) | canvas renderer over the 3D world: derived cell and flower lists, elements z-lifted as today | the full picture |

The 2D renderers need one adapter: cell and flower contents come from a helper that reads the
stack arrays for `2d` worlds and the derived lists (3.5) for `3d` worlds. Nothing else changes in
`drawField.ts`, `drawRobot.ts` or `draw.ts`.

### 2.3 Module layout

```
src/games/biobuzz/
  step.ts                dispatch on world.biobuzz.physics; step2d is today's pipeline
  sim3d/
    engine.ts            initPhysics3d() (dynamic import of the wasm), world build/sync/step/readback
    bodies.ts            body + collider specs: robots, elements, tray, flowers, frame, walls
    math3.ts             vec3 / quaternion on dsin/dcos/datan2/hyp
    step3d.ts            the 3D tick (3.1)
    robot3d.ts           drive wrench → body; intake sensor; muzzle; place point; deploy
    elements3d.ts        capture / launch / place / spill tags / human player
    hive3d.ts            the see-saw joint (ballast, detent, damping), tip event at the stop, spill tags
    flower3d.ts          tube membership reads
    derive.ts            contents / stack lists + membership tags for the shared score, HUD, renderers
    predict.ts           the Light and Full prediction worlds (client only)
    settle3d.ts, spawn3d.ts
  ai/policy.ts, tiers.ts deterministic drivers (any physics)
  scene/render*.ts       Three.js renderer chunk
  graphics/              presets, detection, benchmark, settings store (client)
scripts/smoke-biobuzz/   new lanes SIM3D, HIVE3D, FLOWER3D, PREDICT, AI (same suite)
scripts/field-cad.mjs, scripts/field-cad/convert.py, public/models/biobuzz/   the CAD pipeline (8)
```

`config.ts`, `state.ts`, `hive.ts` (table, timer), `flower.ts` (scoring rules), `score.ts`,
`penalties.ts`, `hud.ts`, `mechs.ts`, `mounts.ts`, `presets.ts`, `start.ts`, the builder, the
start editor and the HUD slots are shared by both physics. Anything that writes a position is
physics-specific.

### 2.4 Shared-core changes

| file | change | why |
|---|---|---|
| `src/types.ts` | `RobotState.z?`, `vz?` (absent 0); `BiobuzzState.physics?`; `GameSettings.practicePhysics?: '2d'|'3d'`, `practiceBots?: 'off'|BotTier`; `Replay.physics?` | the only new per-tick robot fields; the practice picks sync per account like `practiceDummies` |
| `src/games/module.ts` | `scene?: () => Promise<GameSceneFactory>` | the lazy 3D renderer slot; DECODE/CR fill nothing |
| `src/games/types.ts` | `GameSimModule.bot?`, `GameSimModule.physicsOptions?: readonly Physics[]` | AI seats; which physics the UI may offer for this game |
| `src/net/protocol.ts` | `CLIENT_CAPS` gains `'bb3d'`; `RoomConfig.physics?`; `matchStart.physics?` | an older client cannot predict a 3D room; the server refuses it with an update message |
| `src/net/checksum.ts` | `worldHash` mixes `r.z` when `physics === '3d'` | stored hashes for 2D worlds unchanged |
| `src/game.ts` | renderer choice; prediction mode; ball and robot-z interpolation for 3D worlds; `initPhysics3d()` before a 3D practice or room; bot seats in solo | the client side of every decision above |
| `server/index.ts`, `server/room.ts`, `server/matchmaking.ts` | `await initPhysics3d()` at boot; room physics; cap gate; staged rooms `3d` | server authority |
| `server/persist.ts`, `server/db/` | migration: `physics text` on `records`, `matches`, `replays`, `practice_runs` (default `'2d'` for old rows) plus `view text` on `practice_runs`; `records_drivetrain_check` gains `butterfly` | boards can show or filter; nothing is reset |
| `src/lan/hostWorker.ts` | lazy 3D init when hosting a 3D room | the worker chunk stays wasm-light |
| `src/ui/*` | Graphics section; view toggle; prediction option; Practice setup (physics, AI); lobby physics option; leaderboard `physics` badge and filter | player-facing |
| `package.json` | `@dimforge/rapier3d-deterministic-compat` in `dependencies`; `three`, `@types/three` in `devDependencies` | server needs the physics; the renderer is client-only |
| `CLAUDE.md` | the client-bundle sentence allows per-game lazy chunks budgeted by `bundleaudit`; the game table row says 3D | one sentence each, on the split base |

Nothing BIOBUZZ enters `src/sim/`. The 2D pipeline keeps calling the shared `solveRobots` and
`solveArtifacts` exactly as today.

### 2.5 Packages, lifecycle, bundle

**Deterministic build, decided with its costs stated.** The default Rapier build is deterministic
on one machine but the vendor does not guarantee bit-identical results across platforms; the
`-deterministic` build pins the transcendental functions and disables SIMD so the same inputs give
the same bits everywhere. What that buys: replays re-simulate exactly on any client, the LAN host
in a browser and the server; the server can verify a client-reported run bit for bit; a Full
prediction of the local robot matches the server for uncontested motion, so corrections come only
from contacts the client did not know about; a two-run hash across Node and Chromium is a real
check rather than a hope. What it costs: speed (the vendor calls it "less optimized"; the penalty
is measured on Day 0, expected 1.2 to 2×), and the guarantee holds only with one exact version
and one construction order on every machine, which the id-ordered sync gives. The default build
would be faster and is probably deterministic in wasm in practice, since wasm floats are IEEE and
the libm is compiled in, but "probably" is not a property a replay verifier can stand on. Rule:
deterministic build everywhere; if Day 0 measures over 2× and the default build passes the
cross-runtime hash on Node, Chromium, Firefox and Safari, the owner may switch the live solve to
the default build and keep the deterministic one for server-side replay verification only.

`sim3d/engine.ts` loads the compat module through a **dynamic `import()`** inside
`initPhysics3d()` and keeps it in a module variable; `step3d` is synchronous against it.
Since 2026-09-18 the same call also loads `sim3d/impl.ts`, the barrel every heavy `sim3d/` module
hangs off, so the IMPLEMENTATION is lazy too and not just the wasm: `step.ts` dispatches through a
one-line gate (`sim3d/step3d.ts`) and the scene takes the tray angle from the light `sim3d/tilt.ts`.
Before that, a static import chain put ~14 KB gz of physics logic in the main chunk and the same
again in the LAN host worker. Vite
emits the wasm chunk once, loaded only when a 3D-physics world is about to be stepped locally
(practice, Full prediction, LAN hosting). A 2D-view client with Light or Off prediction in an
online 3D room **never loads it**. The server awaits it at boot beside `initPhysics()`; the smoke
suite awaits it at the top. The 2D games stay on `rapier2d-compat` 0.19.3; the packages coexist.
If the non-compat package plus a Vite `?url` wasm works in browser, worker, Node and `tsx` alike,
it saves about 300 KB gzipped; try it on Day 0, fall back to compat.

Route weights, gzipped: main chunk 903 KB today (at most +10 KB; measured 907.88 after the
implementation moved out of it); 3D physics chunk about 1.1 MB
(compat) or 0.77 MB (raw wasm), loaded only as described; renderer chunk at most 250 KB (engine
measured 139 KB tree-shaken); HDRI sets on demand; the post-processing chunk (ambient occlusion
and bloom, 2026-09-27) only when either is on. A 2D-view player pays the main chunk only.
`scripts/bundleaudit.mjs` (new, a `uiaudit`-shaped ratchet) fails on growth per chunk.

---

## 3. The 3D simulation

### 3.1 The tick (`step3d`)

1. Phase machine (shared `src/sim/match.ts`); disabled robots get the zero command.
2. Drivetrain: shared `updateRobot` produces a `DriveWrench` per robot from the 2D projection;
   unchanged model, unchanged feel.
3. **Sync**: the persistent Rapier world is reconciled to `world` (3.2).
4. Apply wrenches as forces in the floor plane and yaw torques. The tray is dynamic (3.6);
   nothing is set on it.
5. `world3d.step()`.
6. **Readback**: every dynamic body writes `pos/z/vel/vz/heading/angVel` into `world`, rounded to
   1e-4 in and rad, so the JSON is the truth and stable.
7. **Derive** (3.5): cell contents, flower stacks bottom to top, membership tags.
8. Gameplay reads: intake capture, launch, place, tip trigger, spill tags, human player nectar,
   gardens, park, leave, fouls, score (the shared `score.ts` over the derived lists).
9. Containment invariant: an element outside the perimeter or below the tiles is placed back
   inside at rest and logged. A safety net, never the design.

One position authority per body: the solve, and the clamp when the solve failed.

### 3.2 Persistent world and sync

The server keeps one Rapier world per room for the match; sleeping and warm-starting stay on, so
resting spheres cost nearly nothing and do not jitter. Each tick the engine syncs JSON to bodies:
bodies whose JSON changed outside the solve (a capture removed a sphere, a launch added one, a
reconcile snapped a chassis) are created, removed or teleported; the rest are left alone. Handles
are keyed by stable ids (`robot.id`, `artifact.id`, named statics); creation order is
deterministic. The persisted world is the authority and JSON its serialisation. Server and replay
both start at tick 0 from the seed and step the same inputs, so they agree bit for bit under the
deterministic build. A client's prediction world (5) is rebuilt per reconcile and may differ;
authority corrects it.

### 3.3 Robots

Dynamic cuboid `length × width × heightIn`, mass `shoveMass`, gravity on, on the tile plane.
Yaw free; pitch and roll locked for now (owner decision 2026-09-17); z translation free so a
robot pressed under a descending tray slides out rather than clipping.

**Designed so pitch and roll can be unlocked later.** The physics half is a flag
(`setEnabledRotations(true, true, true)`) plus `RobotState.q?: [x, y, z, w]` on the wire (four
numbers per robot, about 145 B raw per 2v2 snapshot) and the renderer applying it. Every reader
of a robot's pose in `sim3d/` goes through `robotPose3(r)` from day one, so nothing else changes
there. The hard parts are gameplay, not physics, and they are the reason to wait: the drivetrain
model assumes four wheels on the floor (traction must scale with how many wheels touch, which
needs per-wheel contact probes or a simplified suspension); a tipped robot needs a rule (the
manual leaves it stranded unless it self-rights, so the sim must stop its drive and offer nothing);
aim solutions assume a level muzzle; the shared footprint helpers (`robotCorners`) assume an
upright box and become the projection of an oriented one for penalties and zones. Estimate: two
to three days after the yaw-only game is stable, no schema break, since `q` is optional and
absent reads upright. Drive: the shared `DriveWrench`
as a force and yaw torque plus a yaw damping mirroring the 2D wheel brake. Friction
`PHYS_FRICTION` against robots, `PHYS_WALL_FRICTION` against statics, restitution 0. Solids from
`bbRobotSolids` extruded to `heightIn` (chassis, sweeper plates, held elements): one geometry
authority for physics, sprite and mesh.

`RobotSpec.heightIn` (12 to 29, absent 18) is clamped in `coerceBiobuzzSpec`; `stowHeightIn` (at
most 18) is a builder check. Deployment is a read of `world.match` (deployed once pre-match ends;
collider rebuilt at the edge). The 2D pipeline ignores height entirely, as today.

### 3.4 Elements

56 dynamic spheres (40 pollen r 1.4, 8 + 8 nectar r 1.8), mass `BB3_ELEMENT_MASS` (APPROX 0.2 lb
until a set is weighed), gravity 386 in/s², friction, restitution and rolling damping from
`BALL_*` as the start, CCD while `|v| > 60 in/s` so a 260 in/s shot never tunnels a plate. Rotation
unlocked (they roll; the renderer spins them from velocity; rotation is not serialised, the next
sync leaves a resting body's rotation alone). In a hopper: `held`, removed from the world. In the
human player's hand: `stock`. Everything else is a body with a position, including elements
sitting in a cell or a flower.

### 3.5 Derived lists: one scoring, one HUD, two physics

The 2D `score.ts`, `hud.ts`, `HudSlots.tsx`, `resultsRows` and the 2D renderers read
`hives[a].contents` (id lists) and `flowers[i].stack` (ids bottom to top). `derive.ts` fills the
same fields every tick from body positions: an element is in a cell when its centre is inside that
cell's interior volume (tray frame) and at rest (`|v| < BB3_REST_SPEED` for `BB3_REST_TICKS`); in a
flower when its centre is inside the tube; the stack is ordered by z. It also stamps
`state: { kind: 'element', el, slot }` on those artifacts, a tag the shared readers understand,
while the body stays in the solve (the 3D pipeline treats `'element'` as "a body in a structure",
never as "not solved"). Every shared rule then works unchanged: owner is the alliance of the top
nectar, bottom bonus the bottom nectar, tip load is the up cell's contents, cell points are the
contents at rest.

### 3.6 Hive: a dynamic see-saw calibrated to the table

Frame: static trimesh colliders from the CAD pipeline (constants boxes as fallback: base bars
x in [24,25] and [-25,-24], y ±19.4, apex z 43.95, crossbar along x). Tray: **one dynamic body
per hive** (the 42.91-in bar with two cells as convex hulls per cell part from the CAD; fallback
five 0.25-in APPROX boxes per cell, 20 × 14 × 12.04, open at the outer face) on a **revolute
joint** about the x axis at (±12.75, 0, 43.95) with **angular limits ±30°** (the damper stops).
The joint's motor is off; three calibrated terms make it behave like the real hive:

- **Ballast** `BB3_HIVE_BALLAST` (a mass at a point on the bar, below the pivot on the down side)
  makes the empty tray bi-stable: it rests against either stop and stays there.
- **Detent** `BB3_HIVE_DETENT` (a breakaway torque, modelled as joint friction that releases once
  the net torque exceeds it) is what the load must overcome. Without it a single element would
  start the swing.
- **Damping** `BB3_HIVE_DAMPING` (joint angular damping) sets the swing time; the owner's 4.0 s
  ruling is the target, measured stop to stop.

**Calibration from the available data.** Element mass is unpublished; `BB3_ELEMENT_MASS` is the
weighed value once a set is weighed (owner action) and 0.2 lb APPROX until then, with nectar mass
`BB3_NECTAR_MASS_RATIO` × pollen (APPROX 1.6: bigger, and lighter than volume scaling, because
the field guide says three pollen plus three nectar mass less than eight pollen). The two
published rows (8 pollen tips, 7 does not; 3 pollen + 3 nectar tips, 3 + 2 does not, Event Field
Setup Guide §12.3) are the calibration targets; the owner-measured rows (1n+7p, 2n+6p, 4n+1p,
5n+0p) are validation. `scripts/hive-calibrate.ts` (headless, deterministic) stages elements in
the up cell as the guide describes (against the back wall, in a line), lets them settle, and
sweeps detent and ballast until every target row holds with the smallest margin above 0.5
element-weights; it prints the validation rows and writes the constants with their derivation.
Re-run when a set is weighed. If no pair of values satisfies every target (the rows are known to
be non-linear), the detent is kept and a **position-dependent** term is allowed (the ballast's
lever arm), then the table itself becomes the last-resort trigger for the rows that still fail,
recorded as APPROX.

**Tip and spill are emergent.** The TIP scores when the joint reaches the opposite stop
(`|angle| ≥ 29°` and angular speed under `BB3_HIVE_REST_W`): that is the damper contact §10.5.1
names. Contents slide down the tilting floor and out of the open face as the bar passes level; no
timer, no fan, no RNG. `hiveTiltAngle` is read from the joint, not computed; both renderers read
it. Spilled ids carry a tag until their first non-tray contact; a robot as first contact writes a
G409 verbal line. Shots are bodies: through the open face at the true angle they are taken; off
the roof, back, sides or frame they bounce.

**Rulebook, not a filter.** The cell takes whatever lands in it. An opponent's shot landing in
your up cell counts toward your load and your cell points, as the manual scores contents by hive,
and no rule forbids launching into the other alliance's hive; it only helps them. G417 does apply
to contact: a robot that touches the tray or the frame is billed by the existing frame-ram detector
(exterior contact at speed, MAJOR once per match per robot) because the tray is now a body a
29-in robot can reach and move. The 2D pipeline's owner-alliance filter stays where it is.

**Fallback.** If calibration cannot hold the two published rows on Day 2, the tray reverts to the
kinematic body swung by the shared timer with the table as trigger (draft 2's model), behind
`BB3_HIVE_DYNAMIC = false`, and the calibration script stays for the next attempt.

### 3.7 Flowers

Static trimesh colliders from the CAD (fallback compound: top ring 4.0 hole at 21.5, four pipes,
middle ring with `BB_FLOWER_MID_HOLE` APPROX 3.2 at `BB_FLOWER_MID_Z` APPROX 3.98, extrusion with
the 3.55 × 3.57 retrieval opening, lower ring 2.79 hole). A nectar seats on the middle ring; a
pollen falls through; diameters decide. Placement drops a held element at the top with zero
velocity when the place point is in reach. Retrieval is the intake sensor overlapping the bottom
opening; the lowest pollen is captured. G410 fires on entry into the scoring cylinder.

### 3.8 Intake, launch, human player, gardens, park, leave

Intake: a sensor at each sweeper mouth (`bbMouths` extruded to roller height); an element
overlapping it for `BB3_CAPTURE_TICKS` (APPROX 3) while intake is held and the hopper has room
becomes `held` (cap 4). Launch: the shared turret and dumper solutions give speed and pitch; the
body spawns at the muzzle (`zIn`, APPROX per kind) with that velocity and CCD on. Human player:
`bbNectar` drops a stock nectar at the loading-zone spot from 6 in. Gardens, PARK and LEAVE are
position reads on the robot's footprint.

### 3.9 Determinism

Deterministic build, same version on server and client, bodies created in id order, math via
`dsin/dcos/datan2/hyp` and the seeded PRNG (the source guard scans `src/games/biobuzz/sim3d/`;
renderer files are named `render*`). A replay is `{seed, setups, commands, physics}` and
re-simulates from a fresh world at tick 0, bit-identical to the server's run. Two-run hash checks
on every 3D scene; a Node-versus-worker hash on one.

### 3.10 Budgets

| quantity | budget | today (2D) |
|---|---|---|
| server 2v2 `step3d` | ≤ 1.5 ms, dev box, persistent world | 0.37 ms |
| cores per driven room | ≤ 0.10 | 0.032 |
| bytes per 2v2 snapshot | ≤ 10,000 raw | 7,670 |
| Full-prediction reconcile, 40 ticks | ≤ 8 ms on a 2023 mid-range phone | n/a |
| Light-prediction reconcile, 40 ticks | ≤ 1 ms anywhere | n/a |
| elements at rest after a spill | within `MATCH_SETTLE_S` 2.8 s | n/a |

Measured by `costprobe` (new `biobuzz3d-*` scenarios with a primed tip), the smoke perf lane
(paired ratio against a CR 2v2), and `?perf=1`. Over 0.10 cores/room the lever is
`worker_threads`, never a bigger VM.

---

## 4. Rendering

### 4.1 Two renderers, one world

**2D view**: the existing canvas renderers, unchanged but for the contents adapter (2.2). No
WebGL, no wasm, no new bytes. This is the path a Chromebook, a phone, or a player who prefers
top-down uses, in practice and in ranked. **3D view**: Three.js 0.186.0, `WebGLRenderer`, WebGL2,
`three` imported by exactly one file behind the `scene` slot's dynamic import. Cycle with `t` in
match; pick in Graphics; the choice is per device (`localStorage['decodesim.view']`).

### 4.2 Scene

Tiles and tape (unlit, on-field tokens), walls, frame, tray groups rotated by `hiveTiltAngle`,
flower cages, 56 instanced spheres posed from the interpolated world, robots generated from spec
(chassis at `heightIn`, drivetrain from `moduleAngles` and velocity, mechanisms from
`bbMech`/mounts, alliance sign panels), a reticle at the solved landing. The field, frame, tray
and flowers are the CAD-derived GLB when present (8), constants-built otherwise. Lights and effects
follow the graphics settings (4.4).

### 4.3 Cameras

Per device. **Driver station** (desktop default): eye 12 in behind the alliance wall centre,
height 62 in (44 to 72), FOV 70 (60 to 90), yaw fixed to `viewAngleOf(alliance)` so field-centric
sticks match the view, optional soft look-at-robot. **Overhead** (orthographic, the 2D fit; the
phone default in 3D view). **Chase** (60 in back, 40 up; robot-centric). **Orbit** (spectators,
replays, gallery). Keys `t` (view), `i`/`o` (eye height), pad R3; a `view` key in `MobileLayout`.

### 4.4 Graphics settings

A **Graphics** section in Configure (beside Audio and Visual), stored per device in
`localStorage['decodesim.graphics']`, never in `GameSettings` (a GPU is a property of the machine).
One preset picker and every setting under it; changing a setting switches the preset to Custom.

| setting | values | Low | Medium | High | Ultra | Extreme |
|---|---|---|---|---|---|---|
| Render scale | 50 to 200 % of CSS pixels (backbuffer capped by a pixel budget: 0.6 / 1.2 / 2.2 / 4.0 / 8.3 MP) | 75 | 100 | 100 | 100 | 150 |
| Max frame rate | 30 / 60 / 120 / display | 60 | display | display | display | display |
| Anti-aliasing | off / MSAA 2x / MSAA 4x | off | MSAA 2x | MSAA 4x | MSAA 4x | MSAA 4x |
| Shadows | off / low 1024 / high 2048 / soft / max 4096 | off | low | high | soft | max |
| Element shadows | none / blob / real | none | blob | real | real | real |
| Ambient occlusion | off / on (GTAO) | off | off | off | off | on |
| Anisotropic filtering | 1 / 4 / 8 / 16 | 1 | 4 | 8 | 16 | 16 |
| Mesh detail | low / high (two GLB decimation levels) | low | high | high | high | high |
| Environment | procedural room / HDRI set (on demand, 4.5) | procedural | procedural | HDRI | HDRI | HDRI |
| Environment lighting | off / on | off | off | on | on | on |
| Reflections | off / on (env map on metals) | off | off | on | on | on |
| Bloom | off / on (venue lamps and hard glints; never a robot part) | off | off | off | off | off |
| Materials | standard / physical (measured finishes + a room probe) | standard | standard | standard | standard | physical |
| Effects | tracers, tint pulse, wheel spin, dust off | minimal | standard | standard | full | full |
| Field of view | 60 to 90 | 70 | 70 | 70 | 70 | 70 |
| Camera motion | full / reduced (also from `prefers-reduced-motion`) | reduced | full | full | full | full |
| PiP minimap | off / on | on | on | off | off | off |
| Performance overlay | off / fps / fps + p95 + draw calls | off | off | off | off | off |

Motion blur is not offered. Every value is applied live; a change never reloads. A `Reset to Auto`
button re-runs detection.

**Extreme (2026-09-27).** Ultra's two hedged cells moved here: AO is on at Extreme only, and SMAA is
not offered at all. Extreme renders at 150 % on top of MSAA 4x, which is sharper on this field's
thin edges, and `SMAAPass` alone is 38 KB gzipped of lookup textures. AO and bloom are post passes
in a lazy chunk fetched the first time either is on, so they apply live once it arrives. They draw
in the match and the live replay viewer only: the builder preview has no post chain, and the
replay export stays fixed at High (4.7). Auto never picks Extreme (4.6). Materials also switches
to `physical` at Extreme only — its own lazy chunk, see `docs/area/biobuzz.md`'s PHYSICAL MATERIALS.

### 4.5 Environments

The default **procedural room** (0 bytes, themed surround, three lights) plus a short list of
**CC0 HDRIs from a public library** (a gym, a hall, an outdoor field, a night set), each fetched
on demand as a 1k `.hdr` (about 1 to 2 MB), run once through `PMREMGenerator`, browser-cached,
never in any chunk; attribution on the Contributors page. Tiles and tape keep their fixed on-field
colours so the HUD contrast pairs hold. Two sets on Day 3; more is a data change.

### 4.6 GPU acceleration and Auto

Auto is the default preset. On the first 3D launch: read the WebGL renderer string
(`WEBGL_debug_renderer_info`) and, where present, the WebGPU adapter info; combine with device
memory, core count and DPR into a first guess (integrated GPU → Medium, discrete → High, phone →
Low); then a **two-second warm-up** on the real scene measures frame-time p95 and moves the preset
one step down if p95 exceeds 16.7 ms, one step up if it is under 6 ms with headroom, never past
Ultra (the warm-up measures CPU time, and Extreme's cost is GPU fill). The result is
stored; a persistent slip of p95 above 25 ms in a match lowers the preset once and writes one
event-log line. `WebGLRenderer` is created with `powerPreference: 'high-performance'` so dual-GPU
laptops pick the discrete GPU. A software renderer string (SwiftShader, llvmpipe, Basic Render
Driver) or a failed WebGL2 probe selects the 2D view with an event-log line; the 3D view stays
one click away for retry. Electron keeps hardware acceleration on (the app never calls
`disableHardwareAcceleration`; only the shot runner does) and logs `app.getGPUFeatureStatus()`.
**Decision (delegated, 2026-09-17): the desktop app offers "Force GPU on blocklisted drivers"**,
off by default, in the Graphics section, with the label saying it can crash the renderer. It adds
`ignore-gpu-blocklist` on the next launch, and the main process clears it automatically after a
`child-process-gone` with type `GPU` or a `render-process-gone`, so a bad driver costs one relaunch
and never a stuck app. Offered because the blocklist is written for driver crashes across the
whole browser population, and a student with a known-good but blocklisted laptop GPU is exactly
who loses 3D otherwise.

### 4.7 Frame composition and fallback

WebGL canvas under the existing 2D canvas, which becomes a transparent overlay for labels
(projected through the scene camera), auto paths and the replay burn-in. HUD stays React at 10 Hz
with a fixed dark scrim in 3D. Video export draws the WebGL frame onto the export canvas before
the burn-in; the `MediaRecorder` fallback captures a composited canvas. A rejected renderer
`import()` (a stale build after a redeploy) falls back to the 2D view and triggers the stale-build
reload prompt.

---

## 5. Prediction and interpolation

A **Prediction** setting beside the view, per device:

| mode | what the client does with its own robot | latency felt | cost |
|---|---|---|---|
| **Off** | renders the local robot from interpolated snapshots like a remote | about 5 ticks (83 ms) plus RTT/2 on every stick input | none |
| **Light** (2D-view default) | re-steps buffered inputs with the shared drive model and wall containment only (no robots, no elements); the server corrects contacts | none on open floor; a brief correction when pushing | under 1 ms per reconcile, no wasm |
| **Full** (3D-view default on desktop) | rebuilds a small 3D world per reconcile: statics, tray at its snapshot angle, other robots kinematic at snapshot pose, elements within `PREDICT_ELEMENT_RADIUS` (APPROX 36 in) dynamic, the local robot dynamic; re-steps up to 40 inputs | none, including light pushes | about 15 bodies per reconcile; needs the 3D physics chunk |

Corrections use the existing `localSmooth` offset (`SMOOTH_HALFLIFE`, `SMOOTH_MAX_DIST`). The
setting is offered in the Controls section and the in-match menu; an event-log line explains Off's
latency the first time.

**Auto (default).** Defaults are Light for the 2D view and phones, Full for the 3D view on
desktop, but the shipped default is **Auto**: during the pre-match countdown the client times one
Full reconcile of 40 ticks in the real prediction world and reads the connection's RTT and
jitter. Full is chosen when that reconcile is under `PREDICT_FULL_BUDGET_MS` (8) and the physics
chunk is loaded or loadable within the countdown; otherwise Light. Off is never chosen by Auto.
If Full's reconcile p95 slips above the budget in a match, Auto drops to Light once and writes an
event-log line; the player's explicit choice is never overridden. Elements and remote robots are **interpolated** in 3D-physics worlds
(ids stable, count conserved; a kind change snaps); `snapBuf` gains per-ball `x, y, z` and
per-robot `z` when `physics === '3d'`. In 2D-physics rooms everything is as today.

---

## 6. Practice and AI

**Practice setup** gains two controls beside `practiceDummies`: **Physics** (2D / 3D; 3D default;
choosing 3D loads the physics chunk once) and **Opponents** (Off / Easy / Medium / Hard, filling
the empty seats of the chosen format). The view is the device's; a phone plays 3D physics in the
2D view by default. Practice runs upload with `physics` and `view` tags; the career panel shows
both; only 3D-physics runs are comparable with ranked and the board says so.

**AI drivers** (`ai/policy.ts`): DOM-free, `GameSimModule.bot`, memory owned by the caller
(`GameController` in practice, `Room` online and in the LAN worker), never the `World`, own
mulberry32 seeded `(matchSeed, seat)`. The policy reads only positions and the derived lists, so it
drives under either physics. State machine: collect, route (steer plus wall square-up), fire when
the shared shot verdict says the arc lands, place nectar when the window allows, defend on Hard,
stay clear of the hive footprint when tall, no AUTO target past the field's own half. Re-decides
every 6 ticks so replay tracks stay hold-last friendly. Bots may fill seats in custom lobbies and
LAN rooms ("Add a bot" with a tier), never matchmade rooms in v1; a room with a bot seat is
unrated. Recorded in replays like any seat (the recorder records every setup's command).

---

## 7. Netcode, replay, server, DB

- **Wire**: `RobotState.z/vz` are the only new per-tick robot fields. Elements already carry
  `z/vz`. `BiobuzzState` grows by `physics`, spill tags and the deploy latch. Priced by
  `costprobe`.
- **Caps**: `CLIENT_CAPS` gains `'bb3d'`. A join to a 3D room from a client without it is refused
  with "Update DSIM to play this room." Old clients keep playing 2D-physics rooms and 2D-era
  replays untouched.
- **Replays**: header gains `physics` (absent `'2d'`); playback dispatches on it. `REPLAY_FORMAT`
  unchanged (no new command bits). 3D replays are exact under the deterministic build.
- **Versions**: `SIM_VERSION` and `BALANCE_VERSION` held (owner rule). The `physics` tag is what
  tells a 2D-era result from a 3D-era one; the leaderboard badges rows and can filter.
- **Server**: `await initPhysics3d()` at boot; rooms carry `physics`; matchmaking stages `3d`;
  `persistMatch` writes `physics`. Deploy the alpha app after each server change; production from a
  `main` worktree via the wrapper only. The ranked cutover to 3D physics happens per server: alpha
  on Day 3, production at promotion (question 7).
- **Migration** (one file): `physics text not null default '2d'` on `records`, `matches`,
  `replays`, `practice_runs`; `view text` on `practice_runs`; `records_drivetrain_check` gains
  `butterfly`; `dbtest` asserts the round-trips. `server/api.ts:578`'s two-valued literal becomes
  `coerceGameId` in the same deploy.
- **LAN**: the host worker imports the 3D physics lazily for a 3D room.

---

## 8. Field CAD import

FIRST publishes the field as a STEP zip and an Onshape document
(`ftc-resources.firstinspires.org/ftc/archive/2027/field`, STEP v26-27.2 of 2026-09-15, plus the
FLOWER scoring-volume document); the manual calls this CAD the official representation of the
field. `scripts/field-cad.mjs`: download the pinned zip and verify a committed sha256; run
`scripts/field-cad/convert.py` (CadQuery/OCP, headless Python) to read the STEP, walk the named
bodies and write, in inches and the field frame, a visual mesh per part, a collider mesh per part
(trimesh for statics, one convex hull per tray cell wall and bar) and `field-measurements.json`
(cell section, middle-ring height and hole, wall height, frame profile, pivot height); then
`gltf-transform` (weld, quantize, simplify, instance the four flowers, two hives and tiles) and
`gltfpack` meshopt. Outputs under `public/models/biobuzz/`: `field.glb` at two detail levels
(≤ 600 KB brotli high, ≤ 250 KB low), `field-colliders.json` (≤ 200 KB), the measurements file.
Over budget, the script fails and names the heaviest part.

At runtime the 3D physics builds its statics and tray hulls from the collider file and the scene
loads the GLB; when either is absent both fall back to constants-built geometry, and a smoke check
asserts the two collider sets agree within 0.5 in at twelve probe points. The measurements file
settles the APPROX constants and is asserted against `config.ts`. An in-browser STEP importer
(about 10 MB of wasm) is excluded; the import runs once per CAD version.

**Licence, decided.** FIRST's website terms of use grant the content for personal, non-commercial
use and forbid redistribution without written permission; whether a decimated derived mesh in a
public repo and on the site is covered is unresolved. **The owner decided on 2026-09-17 to ship the
derived files** (`field.glb`, `field-colliders.json`, the measurements) committed under
`public/models/biobuzz/` and served from the site, accepting that risk. A courtesy note to FIRST
describing the use is still sent on Day 0, and the constants-built fallback stays complete so the
files can be pulled in one commit if FIRST objects.

---

## 9. Verification

New lanes in `scripts/smoke-biobuzz/` (same process, `check()` contract; `--lane` for fast
loops); whole `npm test` at most 55 s.

| lane | checks |
|---|---|
| CORE | the 3D wasm imported only in `sim3d/engine.ts`; `three` only in the render loader; render files named `render*`; no `Math.random`/clock; `physics` absent reads `'2d'` and every existing 2D check still passes byte-identically |
| SIM3D | two-run hash on every 3D scene; Node-vs-worker hash on one; 56 conserved every tick; nothing outside the perimeter or below the tiles; a resting sphere stays at rest 600 ticks; a 260 in/s shot does not tunnel a 0.25-in plate; readback rounding stable |
| HIVE3D | tray angle matches manual heights at ±30°; open-face shot taken, each closed face bounces; table rows 8/0 and 3/3 tip, 7/0 does not; a swing empties the tray and every element lands within 1.0 s; G409 tag with and without a robot under |
| FLOWER3D | pollen through the middle ring, nectar seats; owner and bottom bonus by z equal the shared `flowerScore` over the derived stack; retrieval pops the lowest pollen; G410 on entry |
| ROBOT | 18-in passes under the down cell, 29-in stops; drive feel ratio against the 2D pipeline within 5 percent (top speed, 0-to-95 time); muzzle height per preset |
| PREDICT | Light and Full prediction worlds converge to the authoritative pose within `SMOOTH_MAX_DIST` after 40 re-stepped ticks on a scripted push; Off renders at the interpolation delay |
| AI | seed determinism over 3,600 ticks under both physics; no forbidden reads; Hard beats Easy 90/100 (`npm run test:ai`, outside `npm test`) |
| RULES | Table 10-2 totals on hand-built 3D worlds equal the same worlds' derived lists through the shared `score.ts` |
| SERVER | a real `Room` hosts a 3D 2v2 with a primed tip; a cap-less join is refused; snapshot and replay round-trip `physics`; replay re-simulates hash-equal |
| PERF | paired ratio against a CR 2v2; `step3d` ≤ 1.5 ms; reconcile costs for Light and Full |

Gallery: 3D scenes on the existing `Scene` type with a per-still camera; the shot runner gains a
software-GL flag (only there). `bundleaudit`, `costprobe`, `contrast`, `test:ai` stay outside
`npm test`.

---

## 10. Build plan: days, three lanes

Three sessions from three worktrees off `biobuzz-3d`, merging daily. **Lane A sim**: `sim3d/`,
`step.ts` dispatch, `ai/`, `spawn` changes. **Lane B render**: `scene/`, `graphics/`, cameras,
the canvas stack, `GameView`/`ReplayView` wiring, the Graphics section, the gallery. **Lane C
integration**: shared-core changes, server, worker, protocol, migration, `bundleaudit`,
`costprobe`, smoke skeleton, HANDOFF.

**Day 0 (half a day, A + C).** Install the deterministic 3D package; `initPhysics3d()` via dynamic
import in browser, worker, Node and `tsx`; a throwaway world of 4 boxes, 56 spheres, statics and
one kinematic tray steps 3,600 ticks with a two-run hash match and a measured step time; try the
non-compat wasm. Run the CAD pipeline in the evening. Send the permission request to FIRST.
*Gate:* hash equal; step under 1.5 ms 2v2.

**Day 1.** A: `physics` tag and dispatch; `step3d` with robots driving on the shared wrench,
elements staged from the shared spawn, statics from the CAD colliders (fallback boxes), intake,
launch, readback, containment, `derive.ts`. B: the contents adapter for the 2D renderers; the
renderer chunk skeleton with field GLB and generated robots and elements, driver-station and
overhead cameras. C: `RobotState.z/vz`, `scene` and `bot` slots, `practicePhysics`, Practice setup
controls, `game.ts` physics init and renderer choice, smoke skeleton, `bundleaudit`.
*End of day:* **the whole BIOBUZZ game plays on 3D physics in the 2D view** in solo practice, and
the 3D view shows robots pushing elements.

**Day 2.** A: the dynamic tray on its joint, `scripts/hive-calibrate.ts` and the calibrated
constants (kinematic fallback if the two published rows cannot both hold), spill from physics,
flower tubes, derived stacks, gardens/park/leave, human player, settle, penalties, G409 and G417
tags, Light and Full prediction worlds and the prediction Auto probe. B: tray and flower meshes, reticle, HUD scrim, chase and orbit, interpolation of balls and
remotes, labels through the scene camera. C: server init, `RoomConfig.physics`, cap gate,
matchmaking `3d`, migration, `costprobe` scenarios, replay header and re-sim check, LAN lazy init.
*End of day:* a scored 3D 2v2 online on `dsim-alpha`; a 2D-view client and a 3D-view client in the
same match; replays play back.

**Day 3.** A: perf tuning, heights in coercion, AI policy and tiers, bots in practice and
lobbies. B: Graphics section with presets and Auto detection, environment picker with two HDRI
sets, export compositing, gallery, mobile overhead default. C: smoke lanes filled, `npm test`
green, leaderboard `physics` badge, ranked cutover on the alpha server, HANDOFF, docs sections.
*Ship to alpha:* one BIOBUZZ, 3D deterministic ranked, 2D or 3D on screen, practice in three
modes with or without AI, graphics presets.

**Days 4 to 14.** Daily play-testing with the owner; tune friction, restitution, element mass,
capture ticks, cameras, presets; weigh a real element set; a 3D robot preview in the builder;
`MAX_SAVED_ROBOTS` 3 to 4; promotion to production with the ranked cutover (question 7). Every
tuning change lands with a gallery scene and a smoke check the same day.

---

## 11. Risks and kill criteria

| risk | mitigation | kill |
|---|---|---|
| `step3d` over budget with 56 live spheres | persistent world, sleeping, hopper bodies removed, CCD only when fast, decimated colliders | over 3 ms after tuning on Day 0: freeze far elements kinematic between contacts |
| Deterministic build too slow | it is the same solver with pinned math; measured Day 0 | over 2× the default build: default build for the live solve, deterministic for replay verification only |
| Two physics drift apart in feel | the drivetrain model is shared; ROBOT lane pins the ratio within 5 percent | a felt difference the ratio does not catch: tune the 3D damping, never the shared model |
| The dynamic see-saw cannot be calibrated to the published rows, or jitters at a stop | ballast + detent + damping swept by `hive-calibrate.ts`; joint limits with a small restitution; validation rows printed | both published rows cannot hold on Day 2: `BB3_HIVE_DYNAMIC = false`, kinematic tray with the table trigger, calibration retried once a set is weighed |
| Light prediction rubber-bands when pushing | corrections through `localSmooth`; Full one click away | visible snaps: make Full the 3D default on phones too, behind the pixel budget |
| Old clients in 3D rooms | `'bb3d'` cap gate with an update message | none |
| 2D-era and 3D-era results on one board without a season reset | `physics` badge and filter; owner rule against resets honoured | the owner asks for a split: an act bump is available but wipes ratings, so a `physics`-scoped board view is preferred |
| Graphics Auto picks wrong | one-step adjust from a 2 s warm-up; in-match slip lowers once; Reset to Auto | none; presets are one click |
| GPU blocklisted or software GL | detected; 2D view; optional Force GPU on desktop | none; the 2D view is the whole game |
| CAD colliders costly or noisy | trimesh statics only, hulls for the tray, harder decimation for colliders | constants boxes for physics, CAD for the picture |
| CAD licence | ask FIRST Day 0; local until answered; fallback ships | none |
| Two Rapier packages in one repo | different import paths; both pinned exactly | none |

**What kills this design:** only the solver failing its own promise on Day 0 (a resting sphere that
will not rest, or a hash that differs across runtimes on the deterministic build). Both are
measured before anything else is written.

---

## 12. Owner decisions (2026-09-17)

| # | question | decision |
|---|---|---|
| 1 | Custom lobbies and LAN default to 3D physics with a host option for 2D? | **Yes.** |
| 2 | Deterministic build everywhere, or default build with server-side verification only? | **Deterministic everywhere**, with the Day 0 speed gate and the switch rule in 2.5. |
| 3 | Robots yaw-only, or free to pitch and roll? | **Yaw-only for now**; pitch and roll later, designed for in 3.3. |
| 4 | Tray kinematic with the table trigger, or a dynamic see-saw calibrated to the data? | **Dynamic see-saw**, calibrated to the published rows (3.6); kinematic is the fallback. |
| 5 | An opponent's shot landing in your up cell? | **Realism, then the rulebook**: it counts for the hive's alliance (3.6). |
| 6 | Prediction defaults? | **Light for 2D and phones, Full for 3D desktop, with Auto calibration** (5). |
| 7 | Ranked cutover to 3D physics? | **Alpha on Day 3.** Production when the owner says so. |
| 8 | "Force GPU on blocklisted drivers" toggle? | **Delegated; decided: offered, off by default, auto-cleared after a GPU crash** (4.6). |
| 9 | Ship the CAD-derived field files? | **Yes, ship them** (8). Courtesy note to FIRST still sent. |
| 10 | Merge `efficiency-audit` into `alpha` before Day 1? | **Yes.** Done 2026-09-17 (alpha 1ecc3f2). |
| 11 | Delete the 2D physics later? | **Never.** It is the permanent light practice option. |

Still open, none blocking Day 0: weigh a real element set (mass and the nectar ratio are APPROX
until then); confirm the pitch-and-roll upgrade date after the yaw-only game is stable.

---

## 13. Appendix

### 13.1 New constants (APPROX unless a manual cite is given)

| constant | value | source |
|---|---|---|
| `BB3_HIVE_PIVOT_Z`, `BB3_HIVE_ARM`, `BB3_HIVE_CELL_LEN`, `BB3_HIVE_LEN` | 43.95, 15.44, 12.04, 42.91 in | manual (true lengths) |
| `BB3_HIVE_CELL` | 20 × 14 × 12.04 in, open outer face | manual + owner ruling |
| `BB3_HIVE_CELL_WALL` | 0.25 in | APPROX, CAD settles |
| `BB3_FLOWER_MID_HOLE`, `BB_FLOWER_MID_Z` | 3.2 in, 3.98 in | APPROX, CAD settles |
| `BB3_ELEMENT_MASS`, `BB3_NECTAR_MASS_RATIO` | 0.2 lb, 1.6 | APPROX, weigh a set |
| `BB3_HIVE_BALLAST`, `BB3_HIVE_DETENT`, `BB3_HIVE_DAMPING`, `BB3_HIVE_REST_W` | from `hive-calibrate.ts` | calibrated to the field guide rows; validated on the owner-measured rows |
| `BB3_HIVE_DYNAMIC` | true | kinematic fallback switch |
| `PREDICT_FULL_BUDGET_MS` | 8 | budget, Auto probe |
| `BB3_ELEMENT_FRICTION`, `_RESTITUTION`, `_ROLL_DAMP` | 0.6, 0.45, 0.4 | APPROX, tuned Day 4+ |
| `BB3_CCD_SPEED` | 60 in/s | APPROX |
| `BB3_REST_SPEED`, `BB3_REST_TICKS` | 2 in/s, 6 | APPROX |
| `BB3_CAPTURE_TICKS` | 3 | APPROX |
| `BB3_HEIGHT_MIN/DEFAULT/MAX` | 12 / 18 / 29 in | rules |
| `BB3_MECH_Z` turret/dumper/tube | 14 / 12 / 10 in | APPROX |
| `PREDICT_ELEMENT_RADIUS` | 36 in | APPROX |
| `GFX_PIXEL_BUDGET` Low/Medium/High/Ultra/Extreme | 0.6 / 1.2 / 2.2 / 4.0 / 8.3 MP | budget |
| `GFX_WARMUP_S`, `GFX_STEP_DOWN_P95_MS`, `GFX_STEP_UP_P95_MS`, `GFX_SLIP_P95_MS` | 2 s, 16.7, 6, 25 | APPROX |
| `BB3_EYE_DEFAULT/MIN/MAX`, `BB3_DRIVER_SETBACK`, `BB3_CAM_FOV` | 62/44/72 in, 12 in, 70° | APPROX |
| budgets | step 1.5 ms; cores/room 0.10; snapshot 10,000 B; Full reconcile 8 ms; Light 1 ms; renderer 250 KB gz; main +10 KB gz; field GLB 600 / 250 KB br | this document |

### 13.2 Shared files touched

`src/types.ts`, `src/games/module.ts`, `src/games/types.ts`, `src/net/protocol.ts`,
`src/net/checksum.ts`, `src/game.ts`, `src/settings.ts` (new practice fields), `src/sim/spawn.ts`
(the `biobuzz` coerce arm gains `heightIn`), `src/ui/GameView.tsx`, `src/ui/ReplayView.tsx`,
`src/ui/Configure.tsx` (Graphics section), `src/ui/MatchSetup.tsx`/`Lobby.tsx` (physics and AI
controls), `src/ui/Leaderboard.tsx` (physics badge), `server/index.ts`, `server/room.ts`,
`server/matchmaking.ts`, `server/persist.ts`, `server/api.ts:578`, `server/db/` (one migration),
`src/lan/hostWorker.ts`, `scripts/costprobe.ts`, `package.json`, `CLAUDE.md` (two sentences, on the
split base), `docs/area/biobuzz.md`.
