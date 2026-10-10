<!-- governs: server/**, api/**, router/**, src/net/**, src/lan/**, src/game.ts, src/sim/replay.ts, src/replaySavePolicy.ts, src/ui/ReplayView.tsx, src/ui/ReplayRail.tsx, src/ui/replayVideo.ts, src/ui/replayOverlay.ts, src/ui/webm.ts, src/ui/mp4.ts -->
# Netcode — server authority, prediction, snapshots, replays, deploy

The authoritative loop, delta snapshots, reconcile, interpolation, replay containers and video export, LAN, and the Fly deploy protocol. ⚠️ One app serves every client version, so protocol changes must stay backward-compatible.

*Split out of `CLAUDE.md` on 2026-09-16, **verbatim** — CLAUDE.md is loaded into every
session and this is not needed by most of them. The `governs:` line above is read by
`scripts/docaudit.mjs` and by the editor hook, so keep it accurate when paths move.*

---

## Netcode (server-authoritative + client prediction)

The old P2P lockstep/mesh/TURN/Supabase-lobby is DELETED. Full roadmap: `docs/netcodeplan.md`.

- **`server/`** (Node + `ws`, run via `tsx`) imports the SHARED sim (no fork) and runs a
  fixed-`SIM_DT` authoritative loop per room: ingest each client's latest `RobotCommand` by
  robot id, `step(world, SIM_DT, inputs)`, broadcast a **delta snapshot every 2 ticks
  (30 Hz)**. `server/room.ts` = lobby + match + host lifecycle + deterministic drop.
  `SNAPSHOT_INTERVAL` was dropped from 60 Hz after profiling (the lag was NETWORK, not CPU;
  halving snapshot bandwidth + `setNoDelay(true)` to kill Nagle was the fix).
- ⚠️ **ROOMS CAN RUN ON WORKER THREADS (`SIM_WORKERS`, 2026-09-27).** One Node process is one JS
  thread, so every room on a machine used to share one core. `server/roomHost.ts` (socket
  thread), `server/roomWorker.ts` (a worker) and `server/roomThreads.ts` (the messages between
  them). Unset or `0`: `createRoom` returns a plain `Room` and nothing else runs, the old server.
  `auto`: one worker per vCPU beyond the first. Production sets `auto` in `fly.toml`, so a
  performance-1x still runs in-process. Sockets, matchmaker, DB pool, presence and the registry
  stay on the socket thread; routing is unchanged.
  - `index.ts` talks to a room only through `RoomHandle`, which `Room` satisfies. A worker room
    is a `RemoteRoom`: writes are posted in order; `reattach`, `applyPending` and the two report
    resolvers return promises, and `index.ts` awaits only when handed one, so an in-process room
    keeps its synchronous timing. Every synchronous READ comes from `RoomFacts`, a mirror the
    worker re-sends when the room may have changed (any op but `input`, any broadcast but a
    snapshot, and a 1 s sweep for the live clock and score).
  - ⚠️ **THE MIRROR IS A MESSAGE BEHIND, SO THE READS THAT ADMIT PEOPLE COUNT WHAT IS IN
    FLIGHT.** An `add` posted and not yet acknowledged (`RoomFacts.ack`) is a seat for `canJoin`
    and `seatFor`, and a room with anything in flight is never abandonable. Without that, two
    joins inside a millisecond both fit a one-seat room, and `abandon()` disposes a room under a
    joiner.
  - **WIDENING `Room`'S PUBLIC SURFACE:** a method `index.ts` calls needs `RoomHandle`,
    `RemoteRoom`, an `Op` and a case in the worker; a synchronous read needs a `RoomFacts` field;
    a constructor callback needs a `CB_*` bit and a worker event. `Client` crosses by structured
    clone, so `send`/`sendRaw`/`backlog` are its only functions and the worker rebuilds them
    around the SOCKET KEY (`registerSocket`). A worker room's `conn` in `index.ts` is that key
    (spectators get one too, from `addSpectator`); the worker maps it to the room's own stamp.
  - `Client.backlog` crosses as a report, in 16 KB steps, re-read every 50 ms while non-zero —
    a room skipping a backed-up socket writes nothing to it, so nothing else would report it
    drained.
  - A worker that dies closes its rooms' sockets (1011), releases their one-game locks, drops
    their codes and respawns (not if it never loaded physics, or after 5 deaths in 10 min). With
    no live worker `createRoom` falls back to in-process. A late joiner adding itself to a room
    its worker already disposed REVIVES it, as an in-process `Room` would take them.
  - `room.ts` stays browser-safe for the LAN tab host; worker plumbing lives in `roomWorker.ts`.
    The image builds TWO entries (`index.js`, `roomWorker.js`); the single-file LAN bundle has no
    worker and runs in-process.
  - `/api/perf` adds `workers[]` (rooms, loop lag, busy share over the last second) and
    `loopBusy` for the socket thread, whose `loopLagMs` no longer measures the simulation.
  - Measured on the Windows dev box: 30 driven 1v1 DECODE rooms in-process, snapshot gap p50/p99
    79/280 ms; on 4 workers, 33/49 ms. 60 rooms on 8 workers, 33/51 ms with each worker ~40%
    busy. The next ceiling is the socket thread, ~0.3% busy per client (38% at 120 clients),
    mostly `writev` and zlib; worker plumbing is under 2% of a worker's time. One worker against
    none at 20 rooms: socket thread 78% → 14% busy, RTT p99 10 → 3 ms.
  - Checks: `npm run test:workers` (`scripts/workersmoke.ts`) — the pool with fake sockets (a
    killed worker, backlog, dispose, revive, the awaited calls), then the same scenarios against a
    real server in-process and on two workers. Kept out of `npm test`.
- ⚠️ **ROOM SETTINGS: A ROOM'S SHAPE IS THE HOST'S, AND THE SERVER BUILDS IT** (rooms plan M1,
  2026-10-07; `docs/rooms-and-leaderboards-plan.md`). `RoomConfig.settings` (`RoomSettings`:
  `preset`, `perAlliance`, `teamSwitch`, `listed`) is built by `coerceRoomSettings` from the first
  joiner's UNTRUSTED request, which contributes only `preset` and `listed`; the sides come from the
  preset, and a record room is locked to its record shape (all seats BLUE, record runs are forced
  onto one alliance), Private. Capacity is the sum of the sides (`roomCapacity`, `Room.capacity`),
  clamped to `ROOM_CAPACITY` (4) until 3-4 a side lands. **No `settings` = the legacy room, byte
  for byte** (old clients, staged ranked/competition codes, LAN): everyone picks a side, any split
  up to four seats. Host messages `roomSettings`, `moveMember`, `unlockRoom` (cap `'rooms2'`, the
  client gates on `serverCaps()`; an older server ignores them) are refused in a staged/ranked room
  (`hostControlRefusal`: a host there could demote an opponent and have them charged a no-show) and
  once the match is set up. Sides are enforced in `add` (a joiner lands on a side with room) and in
  `update` (a self-switch onto a full side, or with team switching off, is DROPPED, so an old client
  obeys too). A shrink below who is seated is refused, never auto-demoting anyone; a settings change
  clears everyone's ready, a move clears that member's. `unlockRoom` turns a duo record into a
  custom room, one-way and only before the first run; it mutates `config.kind/record` IN PLACE, and
  a worker room's socket-thread copy follows through `RoomFacts.cfg` (`applyFacts`), the same way the
  capacity follows through `lobby.capacity`. `MatchOutcome.config.settings` is the room as it ENDED
  and `matches.preset` (0061) stores it beside `mode`, whose check constraint cannot say 3v1.
  Smoke: "settings:" (shared), `test:workers` "unlocking a worker room", `dbtest` "preset:".
- ⚠️ **A MISSING INPUT TICK KEEPS THE LAST APPLIED BUTTONS** (`frameCommands`, 2026-09-25).
  Inputs ride the unreliable lane, one tick per packet, and a tick with none of its own is filled
  from `latest`, the newest command BY TICK. A client runs ahead, so that is usually a FUTURE
  command. Its stick is borrowed; its `buttons` are not — they come from `held`. A future release
  borrowed into a gap made a held button read up-down-up, and every edge-triggered toggle fired
  twice. Smoke: "input gap:" (shared).
- ⚠️ **THE CLIENT RUNS AHEAD BY THE ROUND TRIP, AND NOT BY A TICK MORE** (`src/net/leadControl.ts`,
  2026-09-27, owner: "lag / rubberbanding" in a solo record run at 50 ms). The reconcile keeps
  only inputs stamped past the snapshot, so the clock came out as `max(own, newest snapshot)`,
  about a downlink BEHIND the room: **0% of inputs reached the room on their tick** at 50 ms, every
  tick ran `latest` a round trip late, and the "prediction" was the server's robot plus a tick.
  Nothing ever lowered the clock either, so a server stall past its 0.25 s clamp left the client
  further ahead for good, toward the forty-tick replay cap (22 ms of DECODE replay per snapshot,
  and a freeze at the cap). `LeadController` reads `lead − (ackInputTick − serverTick)` (the round
  trip in ticks) at each snapshot, aims for its worst over ~2 s plus one tick, clamped to 24, and
  gets there by running the accumulator at most 6% fast or 15% slow — **never a burst**: stepping
  the whole world forward in one frame re-simulates every ball from a stale state and flings them
  on the next snapshot. `MAX_PREDICT_LEAD` stays the hard cap; a snapshot gap zeroes the rate; an
  older server with no `ackInputTick` leaves the clock as it was. Cost: the reconcile replays the
  lead every snapshot, ~6 steps at 66 ms (a few ms of DECODE, half that for Chain Reaction; a 3D
  room replays through the predictor). Smoke: "lead:" (shared), with a real UPLINK — the older
  latency probes delivered inputs instantly, which is why this never showed.
- ⚠️ **A SNAPSHOT'S CLOCKS ARE PUT BACK EXACTLY BEFORE ANYTHING STEPS FROM THEM**
  (`src/net/wireClocks.ts`, 2026-09-27; owner: "spams the shooting sound a ton and fakes the
  shooting animation but it never launches"). `round3` rounds `world.time`, the two countdowns and
  the shot stamps to 1 ms, and the sim compares them every tick. Running a round trip ahead, every
  snapshot in the lead window re-decided each shot from rounded clocks: the same shot came out at a
  `world.time` a hair later (cued again), or a tick early (a launch that jumped back). Measured
  through a real `Room` with the game's own bot driving: 1.7–2.5 cues per real shot at 66–150 ms,
  up to four per dumper fling; after, 1.00–1.16. `ServerSession` rebuilds `world.time` from the
  tick, `lastFireAt`/`lastIntakeAt` onto the tick grid and `preCountdown`/`phaseTimeLeft` from
  their start, bit for bit, and leaves any value the rounding could not explain. The shot and
  intake cues are high-water marks in TICKS (`handleActionAudio`). `fireReadyAt` cannot be rebuilt
  and stays rounded; sending it unrounded (a server change, ~11 bytes per robot per snapshot) would
  remove the rest. Chain Reaction keeps ~10% extra cues with no rounding at all: its particle
  prediction misses some shots by a tick. Smoke: "wire clocks:", "shot cues:" (shared).
- ⚠️ **ONLINE, rAF STEPS THE SIM; THE TIMER IS ONLY THE HIDDEN-TAB FALLBACK** (`RAF_STALE_MS`).
  Stepping on a 16 ms `setInterval` and drawing on rAF, with nothing interpolating the local robot,
  showed a 60 Hz display zero ticks one frame and two the next on 7–26% of frames (solo: 0.3%) —
  "online feels juddery" at any ping. Both drivers read one `lastSimT`, so a hand-over neither
  loses nor double-counts time, and the timer still feeds the room from a backgrounded tab.
- ⚠️ **A REMOTE ROBOT NEXT TO YOURS IS DRAWN AT YOUR MOMENT** (`src/net/contactDraw.ts`,
  2026-09-27). Running ahead put the local robot a full round trip further from the
  interpolated remotes, so a shove drew one chassis sunk into the other: drawn centres p95
  4.2 in closer than the server's at 66 ms and 6.1 in at 130 ms (max 13.4), measured on server
  contact frames only. Within `CONTACT_DRAW_FAR_IN` a remote is blended toward its PREDICTED
  pose (it is already stepped there on its held command and collides with yours), carrying its
  own decaying offset (`remoteSmooth`, `REMOTE_SMOOTH_HALFLIFE`) the way `localSmooth` carries
  yours. And a HELD ball rides its robot AS DRAWN (`followDrawn`): the predicted world placed a
  remote robot's hopper on its predicted pose while the chassis was drawn interpolated, so every
  correction jumped the balls (127 pops > 6 in a minute at 130 ms, zero after). Cost: a little
  remote wobble when the other driver changes stick mid-shove. A BIOBUZZ 3D room does the same off
  the FULL predictor, whose remote robots are now DYNAMIC and driven on their held commands
  (`Predictor.robots`, corrections via `noteRemoteCorrection`); they used to be KINEMATIC at the
  snapshot pose, an immovable wall a round trip out of date once the client ran ahead. The same
  predictor now carries EVERY MOVING ELEMENT, not only those within `PREDICT_ELEMENT_RADIUS`, so a
  far shot or a rolling POLLEN is drawn at the local robot's moment instead of a median 13 ticks
  behind it (owner: "balls in server-required games are all very laggy and behind"). Elements
  seated in a HIVE or FLOWER stay on the interpolation clock with the tray they sit in.
- ⚠️ **IN A BIOBUZZ 3D ROOM, FULL PREDICTS EVERYTHING** (2026-09-27, owner: "Ideally, FULL should
  predict EVERYTHING"; reported first as "when I shoot balls on high ping, they appear mid flight
  after a delay"). Full runs the real `step3d` for the whole field on the client — every robot on
  its held command, every element, launches, captures, the HIVE trays — the same thing a 2D room
  has always done (`worldPredicted`). Two pieces make it affordable:
  - **`rewindEngineTo`** (`sim3d/engineImpl.ts`): `adoptWorld` moves the ONE persistent 3D engine onto
    each snapshot and re-seats only the bodies whose state differs (the trays from
    `hives[a].angle`), instead of rebuilding it — a rebuild is 15–40 ms, 30 times a second.
    Replaying a snapshot through a rewound engine reproduces the server's run to 0.08 in on
    robots and 0.2 in on elements, closer than a fresh engine does.
  - **Replay only on disagreement** (`src/net/worldDigest.ts`): the client keeps a digest of its own
    predicted world per tick, and a snapshot that matches it (robots `AGREE_POS_IN`, elements
    `AGREE_BALL_IN`, same element states, hoppers, scores, phase; remote sticks within
    `AGREE_STICK`, every button equal) skips the rewind and replay. 64–84% of snapshots skip;
    `FULL_RESYNC_EVERY` forces the full path anyway.
  - ⚠️ **THE REWIND IS A ROLLBACK: THE CLIENT SAVES ITS OWN ENGINE ON THE SNAPSHOT TICKS**
    (`saveEngineState`, `GameController.saveForRollback`; 2026-09-27, owner: "it just doesn't shoot
    sometimes"). Moving each body back from the predicted tick kept a lead's worth of FUTURE
    Rapier contact state, so even from an exact snapshot with identical inputs 9.8% of replays
    ended on a different capture than the room and 7.3% on a different shot. The client then
    picked up elements the room did not, predicted them early (p10 −6 to −12 ticks), and fired
    them: 24–75 shots per 150 s that never happened (bot driving, fire held, 100 ms). Restoring
    position, spin and sleep per body got 9.8% to 8.7%; restoring Rapier's whole world
    (`takeSnapshot`) got it to 0%, and over a real `Room` the phantom shots to 0–2 (5 on a dumper at
    150 ms with stalls, all aim-gate calls, not pickups). The client saves every even tick it
    predicts or replays (the room snapshots every other tick) and `rewindEngineTo` restores the save
    for the snapshot's tick before comparing bodies. Cost in Chrome on a 4-robot field: 0.6 ms per
    save (~1.2 MB), 1.1 ms per rollback rewind, against a 0.8 ms `step3d`; about 30–40 ms of CPU per
    second of play. Full reconciles halve, because the prediction agrees more often. Auto's world
    probe counts the saves.
    ⚠️ The save also keeps the world's kinematic JSON, and a snapshot within the wire's rounding of
    it gets that JSON back exactly. The JSON a step ends on is not the bodies' readback
    (`groundRoll3d` damps velocities, `derive.ts` zeroes a resting element's), and rewriting it
    from the bodies replayed every rollback without the room's damping: 264 of 266 replays off the
    room's poses, 5 captures wrong on one seed. Now 0.
    ⚠️ **"0" ABOVE IS FOR A CLIENT ENGINE WITH THE ROOM'S HISTORY, AND A REAL ONE NEVER HAS IT.** The
    checks build both engines from tick 0. A real client builds its engine from a snapshot, so its
    contact state (warm starts, pair order — not on the wire) is its own for the whole match, and
    the save it restores is its own too: with the client's engine built from JSON at tick 30, 310
    of 310 rewinds ended off the room's poses. Mostly by thousandths; at walls and impacts by up to
    2.5 in / 15° — the online "invisible bump" (2026-10-02, see `docs/area/biobuzz.md`, the wall
    square-up). Giving the robot a fresh body on a divergent rewind made it worse (cold contacts
    differ from the room's warm ones more than stale ones do).
  Measured against the old Full: your own shot appears on the frame you fire (was 117–233 ms and
  11–25 in into its flight), moving elements are drawn 0 ticks behind (was a median of 2–4 and a p95
  of 18–27), corrections equal or smaller; simulation CPU 68–200 ms per second of play against
  25–96. The old `sim3d/predict` Full is now its own pickable mode, **BALANCED** (owner: "old full
  should also be an option"), between Light and Full on the Network screen. Auto probes the world
  step first (a settled throwaway copy, warm runs, against `PREDICT_WORLD_BUDGET_MS`), then
  Balanced; the slip rule steps Full → Balanced → Light, one level at a time, and never back up.
  Measured on one match and seed: Light ~2 ms of CPU per second of play, Balanced ~40, Full ~80.
- ⚠️ **AUTO PREDICTION JUDGES WARM RUNS, AND DEFAULTS TO FULL** (`maybeProbeAuto`, 2026-09-27; owner:
  "even with great machines, prediction seems to default to light"). Its one probe used to be
  the COLD first run of the Full predictor — 35–37 ms on a fast desktop whose warm runs cost 4–7
  — so nearly everyone missed the 8 ms budget. Now it probes once per countdown frame, drops
  the first run and takes the BEST of the rest (`AUTO_PROBE_RUNS`); a client that arrives after
  the countdown starts on Full instead of Light; and the slip rule steps down on the MEDIAN of
  `PREDICT_SLIP_WINDOW` reconciles, not a p95 three GC pauses decide. Only a probe that throws
  sends Auto to Light unmeasured.
- **`HOLD_TICKS` is 36 (600 ms)**: a TCP retransmit stalls the input stream 200–500 ms, and at 15 the
  room stopped a robot whose driver was still holding the stick (10.6 in yank at 500 ms, 0.03 now).
  ⚠️ Server constant: deploy it.
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
  fresh balls and blended colliding balls through each other. **A BIOBUZZ 3D world is the
  exception** (its 56 elements are minted once and never destroyed), and that exception is what
  the next two bullets are about.
- ⚠️ **THE LOCAL ROBOT AND THE BALL IT IS PUSHING MUST BE THE SAME MOMENT, AND THEY WERE NOT.**
  Reported as "in server-required games, the balls behave really weirdly — maybe it is something
  with the prediction?" (owner, 2026-09-21). It was: a predicted 3D room draws the local robot
  from the PREDICTION, which sits at about the newest server tick, and every element from the
  INTERPOLATION, which sits `INTERP_DELAY_TICKS` behind it. Two clocks, one frame, ~6 ticks
  (100 ms) apart — and **structural, not network**: measured through a real `Room` with a real
  latency queue, an element was drawn **p95 8.65 in / max 8.9 in** closer to the local robot than
  the server had it *at the robot's own tick*, and the number was the same at 0 ms RTT as at
  140 ms with 5% loss. A POLLEN the driver was pushing sat inside their own chassis; a shot
  crossing the field crossed it a tenth of a second late. The bisect is one line: **prediction
  OFF draws the local robot interpolated too, at the SAME clock as the elements, and takes the
  identical measurement to p95 0.01 in.** DECODE and Chain Reaction never had it — their balls
  are rendered from the locally-stepped world, which IS the local robot's clock (measured p95
  0.00–0.46 in, and a displayed ball never jumps further than its true per-tick motion).
  **The fix changes neither clock.** The FULL predictor has always carried the near elements as
  real dynamic bodies and pushed them with the predicted chassis, and has always thrown the
  answer away; `Predictor.elements()` hands them back and `displayWorld` DRAWS them, so the robot
  and the things it is touching are one moment again — **p95 0.99 in, max 1.3** on the same run.
  Client-side only: no wire change, no `World` field, no egress, and `session: null` never
  reaches `displayWorld` at all, so solo stays bit-identical.
  - **`ballSmooth` IS `localSmooth` FOR ONE ELEMENT**, and the trap is WHERE it is captured. The
    correction must be read INSIDE the reconcile, `before` against `after` at the SAME predicted
    tick; read it across a FRAME and every correction also carries one tick of real motion, which
    never decays, and each element is pinned a tick behind for the rest of the match — measured,
    that put the artifact straight back (p95 8.1 in against 0.99). A ball crossing
    `PREDICT_ELEMENT_RADIUS`, or re-tagged into a structure, is the one discontinuity the
    reconcile cannot see, so `displayWorld` absorbs that switch whole, up to `BALL_SWITCH_MAX`
    (48 in). A single reconcile correction past `BALL_SMOOTH_MAX` (12 in) snaps.
  - ⚠️ **A SWITCH BETWEEN THE TWO CLOCKS IS NOT AN ERROR, AND SNAPPING IT WAS "THE BALLS KEEP
    TELEPORTING"** (owner, 2026-09-24). The two clocks are ~10 ticks apart, so a shot at 150 in/s
    sits ~25 in apart on them. The cap used to be 6 in for switches too, so a shot leaving the
    radius mid-flight, or landing in a hive, jumped back up its own path. Three rules now:
    the predictor KEEPS an element past the radius while it moves faster than
    `PREDICT_ELEMENT_KEEP_SPEED` (it changes clocks at rest, where they agree); an `element`
    that landed PREDICTED stays predicted (one already seated stays interpolated, or a tipping
    tray's contents would step at 30 Hz); and every non-carried ball's drawn pose is remembered,
    so a switch INTO the prediction is eased too. Measured with a real `Room` over 3 minutes:
    >6 in pops 40–45 → 3–7 at 66–130 ms RTT.
  - ⚠️ **A RELEASE IS DRAWN FROM THE SNAPSHOT THE RENDER CLOCK IS ON, NOT THE NEWEST ONE**
    (owner, 2026-09-24: "when i shoot the balls, they sometimes appear for a split second where
    i intaked them"). The newest world says `flight`, both bracketing snapshots still say
    `held`, and lerping them drew the ball at its snapshot pose while held, inside the robot.
    `displayWorld` now keeps it HELD (hidden, with that snapshot's state) until the render clock
    reaches the launch, which is the moment the interpolated robot fires it. A ball the
    predictor already has (your own shot) is drawn predicted at once, and neither case eases in
    from a previous drawn pose (`released`).
  - **A LIGHT PREDICTOR CARRIES NO ELEMENTS**, so `elements()` returns `null` (not an empty list)
    and it keeps the old drawing. That is the honest limit of this fix: Auto picks Full whenever
    the machine holds `PREDICT_FULL_BUDGET_MS`, and a machine that cannot afford Full cannot
    afford to predict elements either.
- ⚠️ **A RE-TAG IS NOT A TELEPORT.** `displayWorld` SNAPPED an element to the newer snapshot on
  ANY `state.kind` change, which is right for a hopper and wrong for a game whose tags are
  DERIVED from body positions every tick (`derive.ts`): `ground`, `flight` and `element` all
  describe the same continuously-moving sphere, and a missed shot skidding across the tiles
  re-tags itself `flight`/`ground`/`flight` on consecutive ticks while travelling in a straight
  line. Every flicker threw it two ticks forward and froze it for a frame — measured, the worst
  jump ANY element made was **2.61 in against a true per-tick motion of 1.34**, a pop of nearly
  twice the distance it was really covering, on a ball nobody had touched. Narrowed to `held` and
  `stock` — the only two tags that mean something is CARRYING it — the worst jump is **1.36 in**,
  which is the motion and nothing else. This half applies at every prediction setting, Off
  included. Checks: `scripts/smoke-biobuzz/net3d.ts` §13–14, which assert the INTERPOLATED
  baseline is still far off as well as the fixed number — a bound on one number alone passes just
  as well when the scene stops moving.
- ⚠️ **A 3D ROOM DOES NOT START UNTIL EVERY SEAT HAS LOADED ITS PHYSICS** (owner request,
  2026-09-22: "only start any server-required game once 3D physics loads"). ⚠️ **A SERVER
  CHANGE — it needs a deploy.**
  `'bb3d'` says a client CAN step a 3D world. It says nothing about WHEN: the Rapier 3D wasm
  and the `sim3d/` barrel are two LAZY chunks (`initPhysics3d`), and until they land the client
  cannot be given a controller at all (`game.ts` asserts it). The server started the match the
  instant everybody readied, so a driver on a cold cache watched the first seconds of their own
  match from behind the "Loading 3D physics…" panel — in RANKED, seconds their own standing was
  being accounted against.
  **THE HANDSHAKE, all additive** (one Fly app serves every client version): a new cap
  `'ready3d'` on `join`/`queue`, a new `ClientMsg` `{ t: 'physicsReady' }` sent once
  `initPhysics3d()` resolves, and `LobbyPlayer.ready3d` on the roster so the waiting screen can
  name WHO it is waiting for. `Room.seatWaiting3d` is the gate and it is asked by all three
  paths that build a world (`startMatch`, `startRankedImmediate`, `beginRanked`), beside
  `physicsReadyForRoom` — which is the same question about the SERVER's own copy.
  - **A CLIENT WITHOUT THE CAP COUNTS AS READY AT ONCE**, and so does a dropped one and a bot.
    An older build will never send the message, so waiting on one holds a whole room for the
    full deadline and then starts anyway, which is the worst of both.
  - ⚠️ **THE DEADLINE STARTS THE MATCH; IT NEVER CANCELS ONE** (`READY3D_DEADLINE_MS`, 45 s
    from the first moment the room wanted to start). A chunk that has not arrived by then is
    not arriving and the other three people did nothing wrong — and a cancel would hand every
    client a FREE DODGE, because `physicsReady` is a message a client chooses to send. That is
    also why the clock is armed once, inside `seatWaiting3d`, rather than re-stamped by each of
    the three start paths and the 200 ms polls inside two of them: a deadline every caller
    re-arms never expires.
  - ⚠️ **AND THE RANKED STRATEGY COUNTDOWN IS EXTENDED RATHER THAN ENFORCED.**
    `onStrategyDeadline` is STRICT and CANCELS, billing `unready` to whoever did not press the
    button — which for a driver who pressed it on time and is still fetching 1.1 MB is a charge
    for a download. `extendStrategyForReady3d` pushes the window out to the readiness deadline
    (once, bounded) and re-sends `strategyStart` with the new number, because the clock on that
    screen is a promise about when the match cancels and one that keeps ticking past a deadline
    nobody will enforce is a lie the driver can read.
  - **THE STRATEGY SCREEN IS THE WAITING ROOM, and a CUSTOM room now opens one too** —
    `Room.enterCustomStart`, `strategyStart` with `ranked: false` and no `intros`, which
    `MatchStrategy` renders with the ELO column, the re-pick, the ready button and the
    countdown all gone. Three things differ from the ranked window and each is deliberate:
    nobody readies a second time (they already did, or the host could not have pressed START),
    the roster is **NOT redacted** (a custom lobby has shown every build all along, so hiding
    them for the last two seconds would be the pre-match reveal running backwards — hence the
    redaction is keyed on `pendingMatch`, not on the phase alone), and leaving forfeits nothing.
    It opens **only when EVERY member advertises BOTH `'strategy'` and `'ready3d'`**; with a
    mixed roster the old immediate start stands, because a client that cannot render the window
    would see a lobby that silently stopped answering START.
  - ⚠️ **THE CLIENT ANNOUNCES ON `welcome`, NOT BEHIND THE JOIN FRAME.** A `join` is handled
    ASYNCHRONOUSLY (token verification, a suspension read, a staged-match lookup), so a frame
    sent straight after it arrives while that socket still has no `room` and `server/index.ts`
    DROPS it — after which the room waits out its whole 45 s for a client that loaded on time.
    `welcome` is the server saying the seat is taken and it is re-sent on every reattach, which
    is exactly the two moments this has to fire. It also may NOT subscribe to
    `transport.onOpen`/`onReopen`: those are SINGLE-SLOT on both transports, so a second
    subscriber silently unhooks the re-`join` a reconnect depends on.
  - **THE PRELOAD IS THE HALF THAT MAKES THE WAIT INVISIBLE** (`src/net/roomPhysics.ts`).
    Holding the start is only tolerable if it is normally zero, and it is zero exactly when the
    fetch happened while the player was doing something else: entering the ranked queue
    (`Matchmaking.find`), sitting on the room-code screen (`Lobby`), opening the record page
    (`RecordRun`, which already preflighted and REFUSES rather than falling back). That module
    reaches the game through `simModuleFor` — the SERVER-SAFE registry — because the client one
    drags in canvas renderers for a question that is one boolean.
  - Checks: `scripts/smoke-biobuzz/net3d.ts` §2b, driving real `Room`s headlessly. Every
    negative is paired with the positive one message later (a room that never starts for an
    unrelated reason would pass "it did not start"), plus the old-client, mixed-roster, 2D-game
    and deadline cases, and the ranked window's extension end to end.

- **A CUSTOM ROOM PLAYS ZENITH AUTOS** (`docs/area/autos.md`): `{ t: 'zenithAuto' }` behind the
  `'zenithAuto'` server cap, one message, never on the roster; the server's auto seat runs in
  `frameCommands` beside the bots, so its commands are recorded and ride `cmds`. Never ranked.
- ⚠️ **IMPORTED ROBOTS PLAY IN CUSTOM AND LAN ROOMS ONLY** (`RobotSpec.imported`,
  `docs/robot-import-plan.md`; rules and sentences in `src/net/imported.ts`). ⚠️ **A SERVER
  CHANGE, it needs a deploy.** The server decides, the client only avoids sending what will be
  refused. ⚠️ **ALPHA ONLY until the owner says** (robot-import.md "Where it ships"): a server whose
  `IMPORTS_OPEN_HERE` is false (`server/channel.ts`: no `SERVER_CHANNEL=alpha`, no `ROBOT_IMPORT=1`, or
  `LAN_MODE`) advertises neither `robotImport` nor `importVisuals` (`advertisedCaps`) and its rooms
  allow none (`RoomConfig.imports`, resolved once on the socket thread and sent to the worker; a
  test opens a room with `imports: true`, never by env).
  - **The capability `'robotImport'` is in `CLIENT_CAPS` and `SERVER_CAPS`.** The client offers an
    imported spec to a room only when the server advertises it (`roomTakesImportedRobots`: the
    cloud's `serverCaps()`, a LAN server's own presence, or true for a room this tab hosts). An older
    server's `coerceSpec` drops the field without a word, so the client would predict one robot
    while the room stepped another. Otherwise the lobby sends the last standard robot and says so.
  - **It is a hard gate on the room, like `'bb3d'`.** A room that holds an imported robot admits
    only clients with the cap (join, rejoin, spectate: a watcher steps the world too), and an
    imported robot is never added to a room that has a seat or watcher without it. One rule,
    `importAdmission`, asked at the door (`server/index.ts`, from `RoomHandle.importState()`; a
    worker room mirrors it in `RoomFacts.imports` and counts seats still in flight), again inside
    `Room.add`/`addSpectator` (the mirror can be a message behind, and the LAN tab host has no door),
    on an `update` patch that carries an import, at `startMatch` (refuses with a sentence), and in
    `Room.reattach`.
  - **One robot id per room.** A robot's look is relayed and drawn by its `imported.id`, so a seat
    may not bring an id another seat holds (`IMPORT_ID_TAKEN`, a sentence that says to duplicate the
    robot in the library). `importState().ids` carries the seats' ids (a re-picking seat's own is left
    out), the worker mirror carries them in `RoomFacts.imports.ids` plus adds in flight, and the
    join door, `Room.add` and `vetImportedPatch` all ask. Two teammates using one shared robot file
    have one id: the second is refused until one duplicates it.
  - **A returning socket's build is the one that plays.** `rejoin` and the account reclaim pass the
    new socket's `caps` to `Room.reattach`, which re-runs `importAdmission` (a build without the cap
    back in a room that holds an import, its own seat's included, is refused) and then REPLACES the
    seat's caps. It used to keep the join's, so a tab back on an older build still read as able to
    play an import and a later `update` to one was admitted. `seatSecured` stays the join's.
  - **Where it is refused outright:** the ranked `queue` message, before any attempt exists (a late
    refusal would charge the other players); a join to a staged ranked room or a record room; an
    `update` there. `Room.allowsImportedRobots()` is `playsZenithAutos` without the game flag: a
    `versus` room that is not staged. `beginMatch` strips `imported` from every setup in a room that
    does not allow it, which covers a rematch and any path that skipped a door. `submitRecord` throws
    on an imported robot, and `persistMatch` skips a record that holds one.
  - **Read the wire, not `coerceSpec`.** The doors test what the client SENT (`msg.player.spec`,
    `msg.patch.spec`). `coerceSpec` starts from the seat's current spec, so a patch that re-picks a
    standard robot must drop the import itself (the `update` handler strips it); do not rely on
    the coercer.
  - ⚠️ **Decide before coercing.** `vetImportedPatch` runs on the RAW patch, BEFORE
    `sanitizePlayerPatch`, and a refused import is removed from it, so a ranked or record room never
    coerces a robot it is about to refuse. It ran after, and `coerceImported` on 16 bands of 256
    far-off points (a 62 KB frame) cost 70 ms of the thread every room on a worker shares, at up to
    240 messages a second. The coercer is bounded too (`docs/area/physics.md`): smoke holds the worst
    64 KiB `update` under 1 ms (`imports/cost`), and `test:workers` sends sixty of them and times a
    rename behind them.
  - **Replays:** a container with an imported robot is written as `format: 3`
    (`REPLAY_FORMAT_IMPORTED`); every other replay is still format 2, byte for byte
    (`REPLAY_FORMAT_BASE`). An older build reads 3 as `future` and refuses it rather than playing a
    rectangle robot. A custom room still saves its match and replay (watchable by its players and
    staff, as before). **Practice and LAN runs with an imported robot stay on the device**: marked
    `imported` in their local index, left out of `pendingPracticeUploads`/`pendingLanUploads`, and
    refused (400) by `/api/practice` and `/api/lan` as the door behind that.
  - **`hostWorker.seat()` sanitises the guest's player** (`sanitizePlayer`, caps through
    `coerceCaps`) like the cloud join. It did not: the roster carried a guest's raw wire spec until
    the match spawned.
  - Checks: `smoke.ts` "imports/…" (rules, replay, device-only runs, settings, rooms, source pins
    for the doors that need a socket), `npm run test:workers` (the mirror, and the real doors on both
    server shapes), `npm run dbtest` ("imports:").
- ⚠️ **AN IMPORTED ROBOT'S LOOK IS RELAYED THROUGH THE ROOM, ON REQUEST, AND NEVER STORED** (VISUALS RELAY: `src/net/importVisuals.ts`, `src/net/visualCheck.ts` (the validators, lazy in the client), `server/importVisuals.ts`, `src/net/importVisualsClient.ts`). ⚠️ **A SERVER CHANGE, it needs a deploy** (and a client one). The footprint rides the spec to everyone; the picture and the mesh live on the owner's device, so a custom or LAN room carries them.
  - **Wire, all additive, behind `'importVisuals'`** (`CLIENT_CAPS` and `SERVER_CAPS`): `visualPut` (owner → room: `kind` `'top'` PNG ≤ 256 KiB or `'mesh'` GLB ≤ 1 MiB, the seat's `spec.imported.id`, `total`, `seq`, base64 `data` of 24 KiB, 32,768 characters, about 33 KB a frame, under the 64 KiB frame cap and a DataChannel's 64 KiB default), `visualGet` (viewer → room: `owner`, `id`, `kind`), and back `visualReady` (an asset can be asked for: to cap holders only, on completion and again to anyone who attaches or reclaims a seat), `visualChunk` (the stream, in order from 0, sent only to a viewer that asked) and `visualRefused` (a reason and a sentence). A client without the cap is sent none of it, and its `visualPut`/`visualGet` are ignored without a reply. An older server ignores them, so an owner uploads only to a server that says it relays (`roomTakesImportVisuals`: a tab host yes, a LAN address its own presence, else the cloud's). Nothing here is per tick.
  - **The bytes live in the ROOM** (`VisualRelay`, one per `Room`), in memory, for the room's life: not a database row, not a replay (a replay carries the footprint), not a disk. On a worker room that puts the bytes, the base64, the GLB parse and the stream timer on the WORKER; the socket thread only writes the frames it would write anyway, and it is the thread that is already the ceiling. Freed with the owner (`freeOwner` beside every `clients.delete`), a robot change (`specChanged`), a start that stripped imports (`reconcile`) and the room emptying (`emptied`).
  - **Budgets.** A room holds 4 × (1 MiB + 256 KiB), the process 64 MiB, and ONE SOURCE (an account, else an address) at most eight seats' sets (`VISUAL_SOURCE_BYTES`, 10 MiB): without it about 52 sockets held the whole budget. Over any of them, a polite `budget` refusal and the viewers keep the footprint. The process figure is ONE counter across threads: the pool makes a `SharedArrayBuffer` of per-thread slots (the socket thread 0, worker `i` is `i + 1`) plus a row of 256 source buckets per slot, and zeroes a dead worker's slot and row, so a crash cannot leak it. The source is `Client.budgetKey`, a 32-bit hash the socket thread takes at the door (`visualSourceKey` of `u:<account>` or `ip:<address>`); the address itself never enters a room. A half-sent upload is swept after 60 s by a TIMER while one is open (`sweepStale`, every 15 s), not only when somebody else uploads. Egress is the bill, so serving is capped too, as RATES over a rolling minute: 8 MiB per viewer source and 24 MiB per room, charged when a request is accepted, and 8 concurrent streams a viewer. They were lifetime totals: a busy room stopped serving after about nine viewer sessions, and a watcher could reset its own by coming back under a new client id. Nothing is sent to a client that did not ask.
  - **Pacing.** The owner sends a frame every 30 ms (33 a second against the 240 bucket, beside 60 Hz input). The room's pump (20 ms) writes one chunk per viewer per tick, only while `Client.backlog()` is under 40 KiB (on a worker room that is the mirror, which reports from 16 KiB), a viewer in a live match is held to one chunk per 100 ms so its snapshots are not crowded out, and a socket the room cannot read (the LAN tab host) is paced by the pump alone. 40 KiB sits far under the 256 KB at which a snapshot is skipped (a skip makes the next one a keyframe). `visualChunk` is written UNCOMPRESSED (`index.ts` `write`): base64 of a PNG or GLB gains 25% for a zlib pass and would fill the socket's shared deflate window with noise; a worker's `out()` neither hashes nor mirrors it.
  - **Validation, twice** (`validateTopPng`, `validateMeshGlb`: the room at the last frame, the viewer again on what it assembled). PNG: signature, an IHDR first with a legal depth and a side of 1–1024 (65,535 × 65,535 fits in 256 KiB and is a decompression bomb), chunk lengths that tile the file, an IDAT, an IEND that ends it. GLB: header and chunk lengths, JSON ≤ 256 KiB, **no `uri` anywhere** (the viewer's loader would FETCH it), no images or textures, no required extension, one BIN buffer with views and accessors inside it, triangles ≤ 150k (`VISUAL_MAX_TRIANGLES`; the importer's own cap is 400k now, and a relayed mesh is a float GLB under 1 MiB, about 20k on a real robot). The id must be the one in the seat's CURRENT imported spec, and two seats may not hold one id (`dup` here, `IMPORT_ID_TAKEN` at the doors), so a viewer keying a picture by robot id cannot be handed another seat's.
  - ⚠️ **The GLB check is an ALLOWLIST**, because the viewer hands the file to three's GLTFLoader and every feature it has is something an owner could aim at every other player's browser. Measured in review: `EXT_mesh_gpu_instancing` drew 512 × 500,000 copies of a mesh from a 546 KB file, `EXT_meshopt_compression` allocated `count × byteStride` bytes it was told, an `images` OBJECT `{"0": …}` passed an `Array.isArray` test and the loader decoded a picture from it anyway, 512 nodes drawing one 150k mesh were 77M triangles, and a node cycle left the load hanging. So: no extension anywhere (`VISUAL_GLB_EXTENSIONS` is what our exporter writes, which is none); images, textures, samplers, skins, animations and cameras refused when PRESENT, whatever their type; every object's keys allowlisted; component types and shapes looked up as own properties; every attribute as long as the positions and every index value read and checked; the node graph a forest no deeper than 32; triangles counted per NODE that draws a mesh. Smoke `visuals/glb+` holds each crafted file; `visuals/lite` holds real GLTFExporter and `liteMesh` output passing.
  - ⚠️ **A RE-UPLOAD KEEPS THE LAST GOOD LOOK UNTIL IT VALIDATES** (`Owner.up`). A reconnect sends the look again, and the new upload used to replace the ready asset at its FIRST frame, so a junk, oversized, interrupted or stale second upload left every viewer with nothing where it had a good look. An upload in progress lives beside the ready asset and replaces it only once it passes `validateVisual` (its streams end with it, and it is announced again); a refused or swept one is freed alone. The room's cap counts what the room will hold after the swap (`reserved − the ready asset of that kind + total`), so a full room still takes a replacement, and while it travels the room holds both, one asset over. Smoke `visuals/keep`.
  - **The owner is told** (`ownLookTrouble`, the lobby's robot line): see `docs/area/robot-import.md`, "Relayed to a room". `visualRefused` already carried a reason; nothing showed it.
  - **A mesh over 1 MiB, or a compressed one,** is cut once by the importer engine (`liteMesh`, in the stored mesh frame, colours kept, always a FLOAT GLB) and cached on the library record as `meshLite`; if even that does not fit, the picture alone goes. ⚠️ The stored mesh has been quantised and meshopt-packed since 2026-10-03, and every validator (this server, older servers, every client) refuses its two extensions, so the owner sends the stored file as it is only when `validateMeshGlb` takes it (a float mesh saved before) and `liteMesh`'s float copy otherwise. No wire or server change. Only a game with a 3D view (BIOBUZZ) uploads a mesh, and only a viewer in that view asks for one.
  - **LAN.** The tab host runs the same `Room`, so it relays with no code of its own; its `Client`s have no `backlog`, and no frame is over 64 KiB. A viewer opts out per device (Configure ▸ Network ▸ "Show other players’ imported robots", `IMPORT_VISUALS_KEY`; Network and not Graphics because Graphics is hidden for a game with no 3D view and this concerns the 2D picture too): off means the footprint and no request. Received assets reach the renderers through `importedAssetsBridge.ts`, the one adapter to the asset registry (`registerImportedAssets`), and leaving the room takes them back. ⚠️ **An asset is (owner, robot id)**: the bridge binds each id to the owner whose look arrived first and refuses another owner's, the registry has one LENDER per id (`relay:<owner>`; this device's own, `''`, always wins and is never replaced by a relayed one), and a viewer never asks for, or lends, a look under its own seat's robot id or an id its own library holds.
  - Checks: `smoke.ts` "visuals/…" (wire, validators including an external `uri` and an image in a mesh, pacing, budgets, a real `Room`, the client against a real `Room`, real GLTFExporter output through `liteMesh`), `npm run test:workers` (across the thread, the backlog pacing, the shared budget with a killed worker, the real doors on both server shapes), `npm run costprobe` (snapshot bytes unchanged).
- ⚠️ **THE LOAD HOLD: A STARTED `'3d'` MATCH WAITS AT TICK 0 UNTIL EVERY SEAT CAN PLAY IT**
  (owner, 2026-09-24). The gate above was not enough and matches, record runs included, still
  opened behind the loading panel. `physicsReady` is sent from the LOBBY and covers the physics
  chunk only. The 3D VIEW (Three.js chunk, field GLB, scene build) cannot load there, because
  the game screen that owns it is built from `matchStart`. So after `matchStart` the room
  holds (`Room.beginLoadHold`, `loadHeld` in the tick loop, same clock reset as the ghost
  freeze) until every connected seat advertising `'viewready'` has sent
  `{ t: 'viewReady', gen }` for THIS generation. The controller sends it from `stepServer` once
  `physicsPending` and `sceneLoading` are both false (2D view and a failed scene both count).
  - `{ t: 'loadHold', gen, waitMs, loading }` goes out at the start, on each report, **every
    second** while held (a lost frame must not strand a client), and on release (`waitMs: 0`).
    A held client does not predict: running the countdown locally against a frozen server
    snaps back on release. The session also drops a hold on any snapshot past tick 0 and at
    its own copy of the cap, so a lost release cannot freeze it.
  - ⚠️ **THE CAP STARTS THE MATCH; IT NEVER CANCELS ONE** (`LOAD_HOLD_MAX_MS`, 20 s), for the
    free-dodge reason above. The release names the seats it left behind: the server logs them,
    the others' event log says so, and the late client joins the running match when it
    loads. Its loading ticks (`loadingTicks`) come off the live ticks its AFK verdict is judged
    against, so a slow load is never a standing charge.
  - Not waited on: a client without the cap, a dropped seat, a bot, any non-`'3d'` room.
  - `preloadRoomView` (`src/net/roomView.ts`) fetches the scene chunk from the same three
    screens as the physics preload, so the hold is usually the scene build and nothing else.
  - Checks: `net3d.ts` §2c (hold, stale generation, release, cap, dropped seat, old client,
    DECODE) plus source pins for the client half, since `ServerSession` cannot be imported
    headlessly.

- **DELTA SNAPSHOTS**: `slimWorld`/`unslimWorld` strip static robot `spec` (client re-injects
  from setups) + delta the balls (send the id ORDER every frame — determinism — but only
  CHANGED ball data); reconnect re-primes with a keyframe.
- ⚠️ **EVERY ROOM STEPS OFF ONE CLOCK, AND THE SNAPSHOT ENCODER IS SPLICED, NOT STRINGIFIED**
  (2026-09-27, `docs/capacity.md` §7b). ⚠️ A SERVER CHANGE: it needs a deploy.
  - `server/tickScheduler.ts` replaced a `setInterval(1000/60)` per room. On Linux that interval
    fires every ~16.3 ms, so its `Date.now()` accumulator ran 0 or 2 steps on some fires and a
    LONE room sent 7.7% of its snapshots 16/48 ms apart — jitter the client reads as stutter, on
    an idle machine. One self-correcting `performance.now()` deadline; the old per-room rules
    (≤8 steps a turn, debt past 250 ms forgiven, ONE coalesced broadcast per turn) apply once for
    the process. Rooms alternate SNAPSHOT PARITY (`snapPhase`) so half of them encode on odd
    ticks. `advanceForTest`/`pumpForTest` take a room off the clock and keep parity 0, so every
    headless test sees the old even-tick cadence. Browser-safe: the LAN tab host bundles it.
  - `server/snapshotWire.ts`: the diff used to `JSON.stringify(ball, round3)` EVERY ball on
    EVERY broadcast (a replacer disables V8's fast path) to find the ~12% that moved — ~40% of a
    Chain Reaction room's CPU. A rounded SHADOW walk (`sameR3`) decides "changed" and only those
    are stringified; the body splices those cached strings. **The wire is byte-identical**, and
    that is asserted, not argued: `npm test` "snapshot wire:" runs rooms of all three games with
    the old encoder beside the new one (`Room.checkWireForTest`), lossy recipients, a backed-up
    socket and a reattach included. Anything that changes what a snapshot CONTAINS goes through
    `snapshotBody`/`BallWireCache` and must keep that check green.
  - `server/warmup.ts`: a headless busy match per game after physics init, so a woken satellite's
    first player does not pay for the JIT (their match cost 30–60% more). Sliced and never
    awaited — `/health` and joins are served throughout. `WARMUP=0` is the kill switch.
- **CONNECTION-QUALITY HUD**: `ping`/`pong` probe → smoothed RTT; snapshot arrival rate +
  inter-arrival JITTER measured client-side → SMOOTH/OK/CHOPPY dot. **Jitter is the real
  choppiness signal** — surface it when diagnosing lag reports.
- **RECONNECTION**: the server holds a dropped slot `RECONNECT_GRACE_MS` (`detach`/`reattach`/
  `checkGrace`), the transport auto-reconnects, the session re-sends `rejoin`.
- ⚠️ **A REJOIN MUST CARRY THE MATCH GENERATION, OR THE ROBOT DOES NOT MOVE AND NOTHING LOOKS
  BROKEN.** `Room.onInput` drops any input stamped with a stale `gen` — that is what lets a
  rematch rebuild a world in place — and the Home rejoin card builds a FRESH `ServerSession`
  out of a SAVED `matchStart`. `ActiveGameRef.start` is written field by field and `gen` was
  not one of the fields, so a returning driver sent generation 0 at a room that has been on 1
  since its first tick: every command discarded, prediction moving the robot locally, every
  snapshot snapping it back. Reported as a rejoin that leaves the game stuck; measured at
  0.000 in of travel against 38.7 in. Same failure class as the `physics` field above it, and
  the third time this object has lost a field nobody thought to copy.
  **BOTH HALVES, because either alone still leaves a hole**: the record carries `gen` (works
  against every deployed server), and `Room.reattach` states the live generation on
  `rejoined` (`{ok: true, gen}`), which corrects a record that is merely STALE — a rematch
  moved the room on after it was written. Both additive and optional on the wire.
- **`matchStart.drivers` IS WHO IS IN THE SEATS** (`MatchDriver[]`, `robotId` → username; a bot
  seat is named for its tier). It exists because nothing mapped a match's robot ids onto the
  lobby's usernames: `setups` carries each robot's `RobotSpec`, whose `name` is the CHASSIS, so
  the in-match label named the build and two default builds were labelled identically. Built
  ONCE in `Room.beginMatch` (`seatedDrivers`), which is where all three start paths and every
  rematch meet, and FROZEN there — `robotOf` is torn down as people leave, so deriving it per
  send would hand a spectator arriving late a handshake that cannot name the robot still on the
  field. Additive and optional both ways, so **no `caps` gate**: an older client ignores the key,
  an older server sends none and the client falls back to `spec.name`. It is NOT in
  `World`/`RobotState` and must not become so — that is a per-tick field at 30 Hz to every
  client, and the sim is deterministic JSON that has no business knowing who is driving.
  ⚠️ **And it is the FOURTH field `ActiveGameRef.start` has to carry** — `MatchStart`,
  `NetSession`, `App.beginSession` — after `physics` and `gen` each shipped missing from that
  hand-written copy. Cheapest symptom of the three (a rejoined driver's labels fall back to
  chassis names), identical hole.
- **WHETHER A LEAVE KEEPS YOUR SEAT IS PER ROOM KIND, and the rejoin offer must agree with it.**
  Custom, ranked and duo-record hold the seat for the grace, so their offer is real (and in
  ranked, going back is what stops away ticks accruing against standing). A SOLO RECORD room is
  reaped on a clean close — one driver, no opponent, and holding it kept an empty room
  simulating for 45 s — so there is nothing to come back to and `leaveSession` clears the
  record on the way out. A refusal (`rejoined: ok=false`) clears it and returns to the MENU with
  a sentence; it must be told apart from `failed`, which an ordinary mid-match drop also sets —
  yanking somebody out of a game they are still in is worse than the dead card
  (`ServerSession.slotRefused`).
- **`abandon` IS NOT A WAY TO LOSE A DECIDED RUN.** `detach` keeps a solo record room alive
  through `finishing` until the field settles and the PB is written; `abandon` is a second door
  into the same situation and it bypassed detach, deleting the client and taking the room with
  it. RESTART pressed in the seconds after the buzzer therefore lost the score. The LOCK still
  goes — that is all the caller needs — and the seat is left for the close that follows.
- ⚠️ **A DECIDED MATCH IS SAVED WHOEVER WALKS AWAY, IN EVERY ROOM** (2026-09-24, "some replays
  are not saving"). `finishing` used to be solo-record only, so a custom game, a bot game, a
  duo run or a ranked match whose LAST connected driver left between the buzzer and the settle
  (up to `MATCH_SETTLE_MAX_S`, while the results screen is still waiting) froze as a ghost room
  and was deleted unsaved: no replay, no history row, no ELO. Now `detach` sets `finishing` in
  any room once nobody is connected inside `inFinishWindow`, and `abandonSlot` leaves the seat
  in any room inside it. A match everybody left MID-match is still not saved. Checks:
  `smoke.ts` "versus buzzer".
- ⚠️ **THE ONE-GAME LOCK IS PER PROCESS, SO THE DOORS ALSO READ THE HEARTBEAT.** `userRoom`
  lives in one machine's memory, and a record run (selected region), a custom room (host region)
  and the ranked queue (matchmaker) are routinely on different machines, which is how an account
  in a live versus was admitted to a record run elsewhere. The join and queue doors now also ask
  `liveRoomsByUser()` (the presence heartbeat, cached 3 s) through `remoteLiveConflict`
  (`server/admission.ts`), keeping the local exemptions: a room staged for the account, and (join
  only) a solo record run of its own. It fails open, and it can refuse for up to ~8 s after a
  remote match reaches `post` (one beat plus the cache). A staged-but-unclaimed room on another
  region is still invisible to it.
- **ABUSE GUARDS AT THE DOOR** (all named constants with their reasons in `server/index.ts` /
  `server/room.ts`): room codes must match `ROOM_CODE_RE` and room kinds are coerced to their
  enums; a network (salted hash of `fly-client-ip`) may host `MAX_HOSTED_PER_IP` (12) rooms that
  are not live matches with a signed-in driver; spectating needs a world and is capped per
  network; a lobby idle for `LOBBY_IDLE_MINUTES` (20) is closed; a socket that a reconnect
  REPLACED no longer drives the seat (`Room.onMessage` compares `conn`); report rows are
  de-duplicated per room before Postgres; `update` bursts collapse into one leading and one
  trailing roster broadcast (`UPDATE_ROSTER_MIN_MS`); a room whose tick throws continuously is
  stopped. All refusals are plain `error` messages every client already renders.
- **THE ONE-GAME REFUSAL CARRIES `code: 'active_game'`.** It is one of the few a client can act
  on, so the record launcher offers the way back into that match instead of a dead card; the
  sentence stays self-sufficient and the launcher matches on it too, because most of the fleet
  predates the code.
- ⚠️ **A MATCHMAKER CODE WITH NO ROOM AND NO STAGED ROW IS REFUSED, NOT OPENED** (`match_gone`,
  2026-10-03, "stuck on loading into match"). `join` creates the room it names, which is right for
  a custom code. For a matchmaker code (`isStagedRoomCode`, server/matchTypes.ts) whose match is
  already over (cancelled at the grace, or its machine restarted) it made an empty custom room,
  and the ranked "Match found" screen, which moves only on `strategyStart`, `matchStart` or
  `error`, waited until the socket was reaped: 15 min on a satellite, never on iad. Reproduced
  against the real server (PGlite harness): the late joiner got `welcome, roster` and nothing
  else. A failed staged-row read is refused the same way, and a join that throws now answers an
  unseated socket. The client half also covers older servers: `LobbyClient.watchStagedStart`
  drops a room socket that has not answered `STAGED_ANSWER_MS` after its first join
  (`STAGED_CONNECT_MS` after the assignment if no join went out; `src/net/stagedStart.ts` says why
  those cannot cut off a live room), a cancel RETIRES the room socket (`LobbyClient.retire`: a
  reconnect closes it instead of re-joining the dead code, and it stays 10 s because the room's
  `dodgeVerdict` follows its `error`), and a parked search carrying an error is adopted as ended.
  ⚠️ Server change: deploy it.
- **`GET /health` REPORTS `x-build`** (`BUILD_REF`, else Fly's `FLY_MACHINE_VERSION`, else
  `dev`). The body is still exactly `ok` — the platform probe reads it. It exists because "is
  this bug in the code or in the running image" had no answer from outside: `/api/presence`'s
  capability list only moves when a capability does.
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
- ⚠️ **ANY CHANGE TO WHAT `step()` PRODUCES CHANGES EVERY REPLAY RECORDED BEFORE IT**, a scoring
  or membership rule included: a replay is inputs, so one element behaving differently turns the
  rest of the match into a different game. Measure it (re-simulate stored replays against their
  stored scores) before shipping. Two ways to ship one: bump `SIM_VERSION` (retires every older
  replay in every game), or gate the new rule on `SIM_PATCH` (`src/config.ts`), which replays
  each log under the rules it was recorded with. Patch 1 (2026-09-27) shipped ungated first and
  sent the top eight BIOBUZZ 3D records to 55–186 against a real 674–726; migration 0055 stores
  the patch and backfilled the rows recorded in between.
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
      twice a match. It skips while a REAL-TIME capture runs, which is filming that canvas; `startRealtime`
      refits ONCE itself (flushSync, then refit, then `rec.start()`), so the taller recording bar is in place before the first frame.
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
- **SITE STATUS: LOCKDOWN, BANNERS, RESTART COUNTDOWN** (`server/siteState.ts`,
  `src/net/siteStatus.ts`, migrations 0051/0052; the rules are in `docs/area/accounts.md`).
  - ⚠️ **THE RESTART NOTICE USED TO REACH ONE MACHINE.** It was a variable on whichever machine
    the admin POST landed on, so on a multi-region app most players never saw the countdown.
    Every banner, the restart included, is a `banners` row now. Each machine re-reads the set
    every 5 s while it has sockets (`pushSiteStatus`) and pushes a CHANGE to its own sockets:
    `siteStatus` for new clients, the old `serverNotice` for older ones. The machine that took
    the write pushes at once. `/api/presence` still carries `notice` and `maintenance` (with an
    additive `scope`) for older clients.
  - **`GET /api/status`** is the one read every page makes (boot, then `NoticePoller` every
    20 s): lockdown, live banners, the restart notice, server time, and `access` when a token
    came with it. An older server 404s it and the client falls back to presence for the notice.
    `siteStatus` needs no cap: an older client ignores a `t` it does not know.
  - A restart row stays live 20 s past its `until` (the "restarting now" beat); end and cancel
    backdate it past that. Without a database the set lives in memory, as the notice did.
  - **FIRST LOAD.** `main.tsx` asks for the status beside the physics init. Closed: the closed
    screen mounts as soon as the answer lands, before the app, the lobby socket or any lazy
    chunk. Open: the app waits at most `BOOT_WAIT_MS` (800 ms) for the answer, then opens.
    **FAIL OPEN**: an unreachable server is not a closed site (free drive works offline; the
    server refuses writes itself when it is up). The exception is a build baked closed
    (`VITE_SITE_LOCKDOWN=1`, the alpha): closed until the server confirms an admin or group.
  - **A MATCH IN PROGRESS FINISHES.** The server does not end running rooms, and the client
    keeps the match screen until the player leaves it (`shellState.inMatch`), then shows the
    closed screen.
- **`api/` is the OTHER server**: Vercel serverless functions, deployed alongside the static
  client, not the Fly game server above. `api/download.ts` is an Edge-runtime proxy that streams
  a desktop-release binary from the site's own domain (via the `/download/:asset` rewrite in
  `vercel.json`) rather than sending the browser to github.com; it checks the requested asset
  name against a strict allowlist before fetching anything, forwards Range/HEAD so downloads can
  resume, and never caches a response (a cached partial served for a different request would
  hand someone a truncated file).
- **SATELLITES ARE CHEAP ONLY WHILE STOPPED, AND ANY REQUEST STARTS ONE.** A satellite stops a
  few minutes after its last request, so one request every couple of minutes keeps it up all
  day. Measured 2026-10-02, after the router moved the menu polls to iad: satellites still ran
  10-22 h a day. Four causes, four fixes:
  - the router fallback (`probePrimary`, env.ts) was PERMANENT for the tab after one failed
    boot probe. It is a backoff now (`PrimaryHealth`: 30 s doubling to 5 min, offline does not
    count, `online` re-probes);
  - a results screen or lobby held its socket forever, pinging every 300 ms. A satellite closes a
    socket that is outside a live match and has sent nothing but `ping`/`input` for 15 min
    (`IDLE_RELEASE_MS`, close code `4002`, which `transport.ts` never reconnects), and a clean
    leave from a FINISHED room frees the seat at once (`Room.detach`), so an old client's
    reconnect is refused instead of taking the seat back;
  - `/health?region=` fly-replayed to the named region, booting it. It is answered locally;
  - two `usePresence` pollers ran per tab. There is one shared poller now.
  Each satellite logs `[wake] N req/60s: …` once a minute it took HTTP requests (route, page
  host, browser family; nothing per client). Read it before guessing what keeps one up.
- **The one Fly app serves EVERY client version** (alpha/beta/main bake the same
  `VITE_GAME_SERVER_URL`), so protocol changes MUST stay backward-compatible. New clients
  advertise `caps` (`CLIENT_CAPS`) on `join`/`queue` and the server feature-gates on them.
  With that discipline you don't have to sync branches before deploying the server.
  **A new `RobotSpec` field is NOT a protocol change** — but an older server's `coerceSpec`
  will drop it, so mirror it onto an older field when one exists (see CR mounts).
- **IDLE TRAFFIC GOES TO THE PRIMARY ROUTER, NOT THE ANYCAST HOST** (`src/net/primaryHost.ts`,
  `router/`, 2026-09-27). The game host is Anycast: a request lands on the NEAREST region and Fly
  starts that region's machine if it is stopped. Menu polls (`/api/status`, `/api/presence`,
  the friends heartbeat, page views) kept satellites `started` 21-24 h a day against 4-104
  match-hours a week. A server-side `fly-replay` cannot fix it (the satellite must be running
  to send it), and a `fly-prefer-region` header makes the request CORS-preflighted, and the
  preflight goes to the nearest region. So `dsim-primary` (`dsim-alpha-primary` for alpha) is
  a separate app whose ONE machine is in iad; it answers every request, sockets included,
  with `fly-replay: app=<game app>;region=iad`.
  - `gameServerHttpUrl()` goes through the router. `nearestHttpUrl()` is the Anycast host and
    is only for the `/health` latency probe (`ping.ts`), which measures the nearest region on
    purpose. LAN signalling uses `primaryWsUrl()`. **Match, room, spectate and `?mm=1`
    sockets stay on the Anycast host**: they must reach a room's region, and a replayed
    `?mm=1` would report the router's region as the player's edge (`replaySrcRegion`).
  - A request through the router arrives with a `fly-replay-src` header, so `/health?region=`
    and `/api/lobbies?region=` answer locally there. Neither is sent through it (the Discord
    Activity has no router: its `/gs` mapping is the only host its CSP allows).
  - The router's `Host` reaches the game server; `siteHost()` folds any `*.fly.dev` name into
    `<FLY_APP_NAME>.fly.dev` so the analytics visitor hash does not split old and new clients.
    OAuth callbacks use `PUBLIC_ORIGIN`, set on both apps.
  - `probePrimary()` (boot) falls back to the Anycast host for the page if the router does
    not answer, so a missing router costs only the satellite wake-ups this was removing.
  - Fly replays bodies up to 1 MB. `readBody` caps at 512 KB, so every upload fits.
  - LAN rendezvous is per machine, so an OLD client (Anycast) and a new one (router) at the
    same venue can miss each other until the old one reloads (the version gate).
  - Deploy: `./scripts/fly-deploy.sh --router [--alpha]`. Its machines must stay in iad.
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

