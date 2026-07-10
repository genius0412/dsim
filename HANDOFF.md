# HANDOFF — 2026-07-09 (netcode anti-stutter: snapshot coalescing + prediction lead cap + ping graph) — READ FIRST

> **LATEST: GREEN, uncommitted on alpha.** `npm test`, `server:check`, `build` all pass.
> Chasing the "connected games feel weird — stutter / rubberband / things fly around, even at low
> CPU and stable *average* ping" report. Diagnosis: it's TIMING/jitter, not load. Fixes (all
> revertible, no protocol change — backward-compatible with the deployed Fly server):
> - **SERVER snapshot-burst COALESCING** (`server/room.ts`): the tick loop catches up several ticks
>   in one `setInterval` fire after any scheduling hitch/GC; the old "broadcast inside `stepOnce` on
>   every SNAPSHOT_INTERVAL crossing" then flushed a BURST of snapshots back-to-back down one socket
>   → the client saw ~0ms spacing then a gap = snapshot jitter = the stutter. `stepOnce` now RETURNS
>   whether the tick is snapshot-due; the loop broadcasts AT MOST ONE snapshot per fire (newest
>   tick). Steady state is unchanged 30 Hz (every even tick still triggers exactly one send); only
>   catch-up bursts collapse. `advanceForTest` preserves per-due-tick broadcast (tests unaffected).
> - **CLIENT prediction LEAD CAP** (`src/game.ts`, `MAX_PREDICT_LEAD` 40 ticks ≈ 667ms): during a
>   snapshot stall the client kept predicting + buffering its own inputs unboundedly; the next
>   snapshot then reconciled with a single SYNCHRONOUS replay of hundreds of full sim steps (balls +
>   Rapier) — a multi-hundred-ms hitch that re-sims from a stale state, so everything "flies" on
>   recovery. Now prediction pauses at the lead edge (drains `acc`, no burst-catch-up) instead of
>   building a replay bomb; the local robot freezes (honest "you're lagging") rather than exploding.
>   Reconcile also defensively bounds replay to MAX_PREDICT_LEAD ticks. Gated on `gotSnapshot` so
>   the pre-match sim countdown still predicts freely from tick 0. `lastServerTick`/`gotSnapshot`
>   reset in `rebuildFromNet`.
> - **INTERP cushion** `INTERP_DELAY_TICKS` 4→5 (~83ms): one extra tick so a single 30 Hz gap (33ms)
>   no longer drains the remote-interp buffer and freezes/warps remotes.
> - **PING GRAPH** (user-requested, to catch sub-second spikes the smoothed number hides):
>   `ServerSession` keeps a RAW RTT ring buffer (`rttSamples`, 120 ≈ 36s) and probes faster
>   (`PING_INTERVAL_MS` 1000→300, ~3 Hz — trivial bandwidth). `NetStatus.rttHistory` carries it.
>   HUD: the connection chip is now CLICKABLE (📈) → toggles a `PingGraph` SVG sparkline (min/avg/max
>   + spike count vs a 1.8×avg threshold) under the top-right chips. `src/ui/GameView.tsx` +
>   `.ping-graph*` CSS; `.status-wrap` is now a right-aligned column so the graph drops below.
> - NOT changed (documented, lower impact): no explicit clock-sync (lead still floats with
>   instantaneous latency, but is now bounded); local-correction snap threshold `SMOOTH_MAX_DIST`
>   16"; balls remain un-interpolated (inherent — mitigated by the two fixes above); client sim is
>   still a `setInterval`. Revisit if stutter persists after deploy.
> - **DEPLOY NEEDED**: the coalescing lives in `server/room.ts` → requires `flyctl deploy
>   --remote-only` to take effect (per the deploy protocol). The client fixes ship via Vercel.
>
> ---

# HANDOFF — 2026-07-08 (session 9: ranked placement / leaderboard standing)

## This session (on `main`, build + smoke + server:check GREEN, NOT committed/pushed yet)
**Reworked ranked "provisional" from RD-based → GAMES-BASED placement**, and gave the
ranked leaderboard a real "your standing" surface. Motivation: users kept the "?" for
dozens of games because it was `rd > 110` (Glicko RD shrinks slowly in a young pool —
you learn little from uncertain opponents), which felt broken and had no relation to
match count.

**What changed:**
- **`src/config.ts`**: new `PLACEMENT_GAMES = 10` (single source of truth, imported by
  server + client + smoke). RD is still used INTERNALLY by Glicko-2 to size swings — it
  just no longer drives any UI.
- **Placement = games-based**, per board (mode × drivetrain, incl. Overall). A player is
  "in placements" until they've played `PLACEMENT_GAMES` ranked games on that board.
- **Leaderboard hides un-placed players** (`eloLeaderboard` now `and e.games >= PLACEMENT_GAMES`).
- **New `eloUserStanding(userId, mode, drivetrain, bv)`** in `repo.ts` → `{rank|null, rating, games}`;
  rank is computed AMONG PLACED PLAYERS with the same order as the board (so they agree).
  `/api/elo?...&me=<uuid>` returns it as `me`. `fetchElo(mode, dt, season?, me?)` now returns
  `{rows, me}`. `getUserStats` ELO rank also switched to placed-only (Career agrees).
- **`Leaderboard.tsx`**: takes `myUserId` (from `App` `accountUserId`), renders a `MyStanding`
  banner — "#N · your rank · <rating> ELO" once placed, or a "? · N matches until placement
  (games/PLACEMENT_GAMES) + progress bar" while placing. Highlights the viewer's own row
  (`.lb-you` + YOU tag). Ranked empty-state text updated. CSS in `shell.css` (`.lb-standing*`,
  `tr.lb-you`, `.lb-you-tag`).
- **Results screen "?"** now games-based: `EloOutcome`/`EloDelta` carry `games` (overall board,
  after the match); `upsertRating` returns new games; `persistVersusMatch` threads it; `room.ts`
  forwards it; `game.ts` `getEloResults` → `provisional: d.games < C.PLACEMENT_GAMES`. Tooltip
  reworded to "In placements…".
- **smoke.ts**: eloResult stub carries `games`; 2 new checks (games passthrough + placement
  threshold). All ~192 checks pass.

**Not done / possible follow-ups**: Career panel still says "Unranked" (not "In placements")
for un-placed players — intentional, out of scope. No DB migration needed (uses existing
`elo_ratings.games`). **Deploy note**: this touches `server/` → follow the deploy protocol
(commit → `flyctl deploy --remote-only` → verify `/health` → Vercel auto-deploys client).

---

# HANDOFF — 2026-07-08 (session 8: high-ping robot-collision fix)

## This session (on `main`, build + smoke GREEN, NOT committed/pushed yet)
**Fixed: robot-robot & robot-field collisions feeling wrong at high ping** (phantom
contacts + visible overlap). Root cause was a render/physics TIME-BASE mismatch in
`src/game.ts`: the local robot was drawn at its predicted PRESENT pose, but remote
robots were drawn via past-time entity interpolation (`snapBuf`/`renderTick`,
~RTT/2+66ms behind), while collision physics in `this.world` resolves against remotes'
predicted-PRESENT poses. So you collided with where a remote *was*, not where it was
*drawn* — scaling with ping.
**Fix**: deleted the past-time interpolation and now render EVERY robot at its
predicted-present pose + a decaying cosmetic correction offset — the local robot's
`localSmooth` technique, extended to remotes via `remoteSmooth` (Map by id). Remotes
are already predicted forward in `this.world` from their held command, so seen ==
collided, and client physics stays aligned with the server (no rubberband on
push/pin — right for this push-heavy game; cf. Rocket League). Changed only
`game.ts` (`displayWorld`/`reconcile`/decay loop/fields) + doc'd in CLAUDE.md Phase 1.
Balls were already rendered from the predicted sim — unchanged.
**Next steps if issues persist**: watch for remote *overshoot* on sudden direction
reversals at very high ping (held-command prediction is stale ~RTT/2); if bad, cap
remote prediction lead or add held-command decay. `SMOOTH_HALFLIFE`/`SMOOTH_MAX_DIST`
tune the ease-in vs. snap. Verify live 2-client at real latency (smoke can't).

---

# HANDOFF — 2026-07-08 (session 7: intake/ball feel + seasons + multi-server)

## Branch strategy (IMPORTANT — this session introduced a two-branch split)
- **`alpha`** = the primary dev line: physics/ball tuning **plus** the new backend features.
- **`beta`** = **`main` + the backend features only, NO physics** (per user). Branched fresh
  off `main` this session (old beta was a stale ancestor; force-moved to `main`).
- The backend feature commits are authored on `beta`, then **cherry-picked onto `alpha`**
  (feature files — `server/*`, `src/net/*`, `src/ui/*` — are disjoint from the physics files
  `config.ts`/`goal.ts`/`robot.ts`, so cherry-picks are clean).
- `main` is untouched this session. Nothing pushed yet (`git push` when ready).

## Build state
- **`alpha`**: GREEN — `npm test` ALL PASS, `npm run build` clean, `npm run server:check` clean.
- **`beta`**: GREEN — same three all pass (after the tank-NaN guard below).

## alpha ≠ main on the TANK drivetrain (gotcha)
`alpha` and `main` **diverged** on tank drive. `main` merged a "tank" PR that added required
`leftDrive`/`rightDrive` to `RobotCommand` and an independent-stick tank model — but left two
bugs: server `ZERO_CMD` missing those fields (server:check red) and `(undefined+undefined)/2`
= NaN on a driver-frame strafe (smoke red). `alpha` never took that PR (its own drivetrain
overhaul has no `leftDrive`/`rightDrive`). On `beta` both were fixed (ZERO_CMD fields;
`cmd.leftDrive ?? 0`). Do NOT assume alpha and main share tank code.

## What shipped this session

### 1. Ball/intake feel (ALPHA ONLY — `config.ts`/`goal.ts`/`robot.ts`)
- **Goal basin**: split funnel velocity into radial+tangential and damp the tangential hard
  (`BASIN_TANGENT_DAMPING`) so balls spiral STRAIGHT into the classifier throat instead of
  orbiting it (the "circular jumble"); brisker funnel (`BASIN_FUNNEL_ACCEL` 500→700, grip
  260, entry-keep 0.45).
- **Gate release**: `TUNNEL_EXIT_VEL.along` 42→22 (gentle) with independent x/y jitter (0.6–1.4)
  — low momentum + friction + ball↔ball spread the drain. Earlier a symmetric perpendicular
  kick split it into TWO branches; removed. Overflow flow speed untouched (58).
- **Triangle intake**: strongest grab (`drawIn` 28→46, `capMin/Max` 0.04/0.07, clump 0.035).
  Tradeoff stays TRANSFER (`fireCap`), not the grab.
- **Vector intake**: no clump SPEED bonus (that's a wedge trait now — gated on `m.wedge`). A
  FLAT intake rammed into an OFF-CENTER ball at high CLOSING speed (`INTAKE_RAM_SPEED` 32,
  measured RELATIVE to the robot) is NOT vectored — it bounces off the flat front as a normal
  impact collision (`collideBallRobot`). Impact-only: once a ball rides with the chassis (low
  closing speed) it vectors in even while pushing hard; the CENTER compliant wheels always
  intake fast.

### 2. Feature A — Seasons (BOTH branches)
Season = the `balance_version` key, but the LIVE season is now DB-controlled so an admin can
start a fresh season at runtime without a redeploy.
- `server/db/repo.ts`: `currentSeasonNumber(fallback)` = max(highest `seasons` row, config
  `BALANCE_VERSION`); `listSeasons()`, `startNewSeason(name)`, `purgeSeasonReplays(season)`.
- Migration `0004_season_replay_index.sql`: index `replays.balance_version` for bulk purge.
- `persist.ts`: stamps results AND the replay with `currentSeasonNumber` (identical to before
  until an admin advances the season).
- API: `GET /api/seasons` (list + `current`); default board view = live season. Admin
  `POST /api/admin/season/start` + `/purge-replays` (JWT admin id OR `ADMIN_SECRET`).
- Client: **season picker** in `Leaderboard.tsx` (archived seasons stay viewable; wires the
  already-supported `season` param); Admin buttons "Start new season" + "Purge archived
  replays". Purge deletes replays only — `records/matches.replay_id` are `on delete set null`,
  so boards survive and just lose watchability.

### 3. Feature B — Multi-server (BOTH branches) — partial
- `src/net/env.ts`: game server is now a **list** (`VITE_GAME_SERVERS` JSON of
  `{id,label,region,url}`), back-compat to single `VITE_GAME_SERVER_URL`. A module-level
  SELECTED server drives `gameServerUrl()/gameServerHttpUrl()`, so all existing connect sites
  follow the choice with no change. `multiServer()`, `setSelectedServer(id)`, `httpOf()`.
- `src/net/ping.ts`: pre-connection latency probe (`pingServer`/`pingAll`/`pingQuality`/
  `fastestServer`) timing each server's `/health`. `/health` now sends CORS + `x-region`
  (from `FLY_REGION`/`SERVER_REGION`); `/api/presence` reports its region.
- **Record-run server picker** (`src/ui/ServerPicker.tsx`, wired in `RecordRun.tsx`): when
  >1 server is configured, the player picks a region from a live ping list before starting;
  single-server deploys skip it. Choice is **saved to the account** via
  `GameSettings.preferredServerId` (synced through the existing account-settings sync — NOT
  localStorage) and restored on load (App effect on `settings.preferredServerId`).
- `.env.example` documents `VITE_GAME_SERVERS`.

## NEXT UP (where I stopped — matchmaking regions)
Multiplayer cross-region matchmaking is **not done**. Chosen design (confirmed approach):
**region-aware matchmaking — cross-region by default + a region-lock filter.** Plan:
1. `protocol.ts` `queue` msg: add `region?: string` + `regionLock?: boolean` (I started this
   edit then reverted it to keep the tree clean — re-apply it).
2. `server/matchmaking.ts`: `QueueEntry` gains `region`/`regionLock`; replace the FIFO
   `splice(0, need)` with a `findGroup` that only pairs a region-locked player with same-region
   players (unlocked = cross-region). Add a smoke test for the pairing rule.
3. `server/index.ts` queue handler: pass `region`/`regionLock` from the msg to `enqueue`.
4. `src/net/lobbyClient.ts` `queue()` + `src/ui/Matchmaking.tsx`: a region-lock toggle; send
   the selected server's region.
- **Cross-INSTANCE matchmaking** (matching players on physically different Fly regions) needs
  SHARED queue state (the matchmaker is in-process per instance). Deferred: either route all
  ranked to ONE matchmaking instance (config/deploy choice), or a Postgres-backed shared queue.
  Document the deploy choice; don't build speculative shared-queue infra until multi-region Fly
  is actually provisioned.
- **Fly multi-region provisioning** needs the user's `flyctl`/account: `fly regions add <code>`,
  set `VITE_GAME_SERVERS` on Vercel to the per-region wss:// URLs. Not doable from here.

## Gotchas / how to work here
- **Two-branch flow**: author backend features on `beta`, `git cherry-pick <sha>` onto `alpha`.
  Verify BOTH: `npm run server:check`, `npm test`, `npm run build`.
- PowerShell: no `&&`; here-strings for commit messages must use single-quoted `@'…'@` and the
  closing `'@` at column 0. Avoid inner double-quotes in the message body (they broke a commit).
- Season model: reads default to the LIVE season (may be admin-advanced past config
  `BALANCE_VERSION`); an explicit `?season=` picks an archived one. `replays.balance_version`
  is stamped with the season so a purge is a direct delete-by-season.
- Deploy protocol (unchanged): commit on alpha → merge main → `flyctl deploy --remote-only`
  (`dohun-sim-decode`) → verify `/health` → Vercel auto-deploys the client. `docs/deploy.md`.
- No Co-Authored-By / Claude trailer on commits (user preference).

## Commit log (this session)
- alpha: `d183841` intake+basin+gate feel · `753d3bd` gate-branch fix · `7c6cd34` seasons ·
  `b7d3149` multi-server foundation · `990b1eb` record-run picker · `cf2c174` env docs.
- beta: `06ec281` ZERO_CMD fix · `42ffc3d` seasons · `17e073d` foundation · `70de2ae` picker ·
  `9d4d94a` env docs · (+ tank-NaN guard) — same features, no physics.
