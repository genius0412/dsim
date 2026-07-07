# HANDOFF — session ending 2026-07-07 (Fly server perf/billing + Phase 3 design)

Read `CLAUDE.md` first (load-bearing rules), then this file. Roadmap =
`docs/netcodeplan.md`. THIS session was **ops + design**, not sim code:
1. diagnosed & fixed the live Fly server lag/teleport + health-check flapping,
2. hit the Fly **trial-ended suspension** (now BLOCKED on the user adding a card),
3. switched the server to **auto-stop** (cheap idle),
4. fully **designed Phase 3** (leaderboards / ranked / replays / auth / DB) — saved
   to auto-memory (`phase3-leaderboards-spec.md`).

The uncommitted **ball-physics follow-up fixes from the PRIOR session are still in
the tree** (see bottom) — they were never committed; do not lose them.

## ✅ Build state: GREEN · `npm test` = ALL PASS · `npm run server:check` clean
## ⛔ Fly app `dohun-sim-decode` is SUSPENDED — Fly TRIAL ENDED. Needs a credit card.

Every `fly` command now errors `trial has ended, please add a credit card`
(https://fly.io/trial). Nothing can deploy/start until the user adds a card. This is
BILLING, not a broken app — the fixes below are deployed and were healthy.

## What this session did

### 1. Server lag / teleport / health-check flapping — FIXED (committed to HEAD)
Symptom: one game, server got laggy after a while, robots teleported, Fly health
check failed (`app not responding on 8080`, machine flapping). Root cause = the Node
event loop saturating + GC pressure on a 256 MB box, NOT too many games. Fixes:
- **`server/room.ts`: `SNAPSHOT_INTERVAL` 1 → 3** (60 Hz → ~20 Hz full-world
  snapshots). THE main fix — cut per-tick `JSON.stringify`/`slimWorld`/broadcast CPU
  ~3×. Remotes are dead-reckoned client-side (`renderRemoteExtrap`) so 20 Hz looks
  identical. (CLAUDE.md always documented 20 Hz; the "Fly io setup" commit had set it
  to 1.)
- **`fly.toml`: memory 256 → 512 MB** — headroom for the per-step Rapier WASM rebuild
  + GC; stops the degrade-over-time (the teleport signature).
- **`fly.toml`: health check `timeout` 2→5 s, `grace_period` 5→10 s** — survive brief
  GC pauses + the cold-boot WASM init window.
- **Cold-boot ordering (`server/index.ts` + `server/room.ts`)**: `httpServer.listen()`
  now runs BEFORE `initPhysics()` so `/health` answers instantly on boot; match-start
  is guarded on `physicsReady()` (refuses `start`/`restart` in the sub-second WASM-load
  gap instead of throwing in the tick loop). Fixes the deploy-time "not listening on
  8080" warning.
  These are IN HEAD (user committed mid-session). Deployed twice; `/health` returned
  `ok`, checks passing — until the trial lapsed.

### 2. Auto-stop (UNCOMMITTED — the only server change not yet in HEAD)
`fly.toml` now `auto_stop_machines = 'stop'` + `min_machines_running = 0` (was
`'off'`/`1`). Fly bills $0 CPU/RAM when stopped (~1¢/mo rootfs) and auto-starts on the
next connection. Trade-off: first player of a session eats a cold boot. NOTE the boot
is ~7 s (`npm run server:start` → `tsx` transpiling the whole module graph at start;
seen in `fly logs`). Optional future: precompile to JS (`tsc`→`node dist/`) to cut
that to ~1 s — NOT done.

### 3. Phase 3 design — DONE (spec in memory `phase3-leaderboards-spec.md`)
Two competition systems, no code yet (deferred until after the Fly card + it's a big
phase):
- **Record-chasing** (score-attack, RANDOM seed each run): **solo 1v0** + **duo 2v0**
  (duo = both robots SAME drivetrain), per **all 4 drivetrains (mecanum, x-drive,
  swerve, tank)** + an Overall board. Public replays.
- **ELO ranked** (PvP): **1v1** + **2v2**, ELO split **per (mode × drivetrain) + an
  Overall**. 2v2: same-drivetrain teams → that drivetrain's board + Overall; MIXED
  teams → Overall ELO only. Runs on the existing authoritative netcode.
- **Seasons keyed to a `BALANCE_VERSION` const in config.ts** (bumped deliberately per
  balance patch): boards RESET each patch, past seasons archived + viewable. Every
  record/replay stamped with the version. Consequence: an input-log replay only
  re-simulates exactly under ITS sim version → store the immutable verified score
  permanently; play old replays against that version's sim build (versioned bundles —
  build current-season playback first).
- **Replays = deterministic input-logs** `{seed, setups, compressed per-tick
  RobotCommands}` (~10–30 KB, NOT video/snapshots) → ~25k fit in 500 MB. Fly server
  RE-SIMULATES a submitted replay to VERIFY its score before writing (anti-cheat; the
  seed is in the replay so random-seed doesn't weaken it).
- **DB + Auth = Neon + Neon Auth** (settled after ruling out Supabase, then Neon+Clerk).
  HARD REQ: user won't manually resume after dormancy. Supabase free pause needs a
  MANUAL dashboard restore (+ deletes @90 days) → FAILS. Neon free scale-to-zero
  auto-resumes ~0.5 s, no manual step. **Neon Auth** (Better Auth, identity stored IN
  Postgres `neon_auth` schema → JOIN users to leaderboards; 60K MAU free; Vite/React
  SDK) = single data service. CAVEAT: Neon Auth is BETA — verify GA + Discord/GitHub
  OAuth at build time; fallback = self-host Better Auth (open-source) on the same DB.
- **Stack:** Vercel (client) · Fly (sim + score verifier) · Neon (Postgres + Auth). All
  free/near-free. OPEN: confirm Neon's long-idle project-DELETION policy before launch.

## ⚠️ Next steps (in order)
1. **USER: add a Fly credit card** (https://fly.io/trial). Adding it ≠ being charged;
   auto-stop keeps cost at pennies/mo.
2. **THEN I deploy** (standing instruction: I run `fly deploy` myself — do NOT just
   hand back the command): `fly deploy` to push the uncommitted auto-stop `fly.toml`;
   confirm the machine sleeps when idle and wakes on connect (`fly status`,
   `curl …/health`). App URL: `wss://dohun-sim-decode.fly.dev`.
3. **Phase 3 build order** when the user is ready: (a) Neon + Neon Auth + schema +
   saved robot configs/preset slots (ships value, independent of the game loop) →
   (b) record-chasing (reuses the sim) → (c) ELO ranked (reuses the netcode) →
   (d) replay viewer + seasons.
4. Older netcode leftovers (unchanged): Vercel client redeploy with
   `VITE_GAME_SERVER_URL`, WebTransport, full-reload reconnect.

## ⚠️ GIT: the USER commits, NOT me. And I DEPLOY Fly for the user.
- **NEVER `git commit`** — the user commits/amends themselves (they did so for the
  server perf fixes this session). Uncommitted right now: `fly.toml` (auto-stop line),
  `HANDOFF.md`, and the prior-session ball files below.
- **DO run `fly deploy` myself** once the card is added (memory: `deploy-for-user`).

## Standing user instructions
- Write/refresh this HANDOFF at the END of every session.
- Run `npm test` after any `src/sim`/`config`/`src/net` change; `npm run build` before
  "done". `src/sim` stays deterministic.
- Product decisions in CLAUDE.md — do not regress.

---

## ⏳ PRIOR SESSION (2026-07-06) — Rapier GROUND-BALLS slice: STILL-UNCOMMITTED follow-ups
These fixes are in the working tree (`src/config.ts`, `src/sim/field.ts`,
`penalties.ts`, `physics.ts`, `physicsEngine.ts`, `robot.ts`, `scripts/smoke.ts`),
committed by the user only in part — the ball slice itself is committed (`da1649e`),
these follow-ups are NOT. Do not lose them:
1. **Ground-ball rest overlap** → ball solve got its own stiffness knobs
   (`PHYS_BALL_CONTACT_FREQ = 25`, `PHYS_BALL_ALLOWED_ERROR`) via `makeWorld(dt, freq,
   allowedError)`; 25 Hz separates a resting clump AND keeps gate outflow at the
   natural ~50 in/s (no `maxCorrectiveVelocity` knob in this Rapier build).
2. **Launch-zone corner-only bug** (pre-existing) → true OBB-vs-triangle SAT
   (`field.ts launchTriangles()` + `physics.ts robotIntersectsConvex()`); apex-straddle
   now reads in-zone.
3. **G402 auto-interference foul** used `goalSide` but goals are CROSS-COURT → switched
   to `driverSide(r.alliance)`; now deterministically green.

### The ball model (read before touching ball physics)
Ground balls: **stateless rebuild-per-step**, in a SEPARATE Rapier solve (`solveBalls`)
from robots. Flight/basin/rail/gate/stock stay bespoke/scripted; the
classified-vs-overflow **contact-time scoring commit in `updateRails` was not touched**.
**ball↔ball + ball↔static → Rapier; ball↔robot → BESPOKE** (`collideBallRobot`/
`pushRobotAt`) because the pinned-ball stall + gate-outflow-can't-shove are deliberately
NON-physical (product decision #7) and a real solve won't reproduce them. Restitution via
single global `CoefficientCombineRule.Min`. `solveRobots` (Slice 1) is byte-for-byte
unchanged — robots never see ball bodies.

### Still deferred (unchanged)
- Flight-low ↔ ground-ball collision (rare; shooter never misses). Needs z-gated
  collision groups — do only if a flight bug surfaces.
- Cleanup once flight is also on Rapier: delete dead `collideBallBall`/`collideBallStatic`
  ground paths + dead robot `collideRobots`/`constrainRobot`; remove `dsin/dcos/datan2`
  discipline (STILL REQUIRED until then — robot.ts fire + goal.ts + in-process
  determinism rely on it). Do NOT remove yet.

### Prior context (Slice 1 Rapier robots, Phase 0/1 netcode) — unchanged
Slice 1: bespoke robot solver → Rapier (`solveRobots`; INCHES → `lengthUnit`;
set-once/read-back linvel; rebuild-per-step). Phase 0/1: server-authoritative sim +
client prediction (Fly `wss://dohun-sim-decode.fly.dev`), reconnection grace, delta
snapshots. See `docs/netcodeplan.md` + git history.
