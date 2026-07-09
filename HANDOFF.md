# HANDOFF — 2026-07-09 (ranked pre-match STRATEGY window) — READ FIRST

> **LATEST (pre-match strategy lobby for random matchmaking): GREEN, uncommitted on alpha.**
> `npm run build` + `npm run server:check` + `npm test` (+20 new checks) all pass.
>
> **Problem:** ranked matchmaking paired strangers and dropped them STRAIGHT into the
> match — no reveal, no coordination; the `ready` flag existed but was never enforced;
> start poses were silently de-conflicted server-side.
>
> **What shipped — a `phase: 'connecting' | 'strategy' | 'match'` window on staged ranked
> rooms** (`server/room.ts`). Once every paired player connects, `maybeStartRanked` now
> calls `enterStrategy()` (NOT `beginMatch`): it seeds each client's authoritative
> alliance + default pose from the staged roster, resets `ready`, arms a strict
> `STRATEGY_DURATION_MS` (60s) deadline, and sends each client a new `strategyStart`
> ServerMsg. Drivers then re-pick / claim a pose / ready via the existing `update`/
> `roster`; `maybeBeginRanked` starts the match the instant all ready, or
> `onStrategyDeadline` CANCELS if anyone isn't ready in time (user decision — strict, no
> auto-start). `beginRanked` builds setups from the LIVE re-picked specs (alliance/seed
> stay authoritative from the staged `PendingMatch`; spec re-clamped by
> `coerceSpec`/`coerceSetup` so re-pick can't break the build limits).
>
> - **Alliance-only reveal is server-side.** `broadcastRoster` is now per-recipient during
>   strategy: own + same-alliance entries full (with a `slot` for ELO lookup); OPPONENT
>   entries redacted to name/team/ELO (`hidden:true`, spec/assists neutralized to
>   `DEFAULT_SPEC`/`DEFAULT_ASSISTS`). Opponent detail is revealed only at `matchStart`.
>   **Gotcha closed:** during `'connecting'` (before strategy) clients self-report alliance
>   `'red'` (placeholder), so alliance-based redaction can't work — the roster is WITHHELD
>   entirely for a staged room until `enterStrategy` sends the redacted one.
> - **Alliance is locked** during ranked strategy (the `update` handler strips `alliance`).
> - **Disconnect during strategy CANCELS** the match (`detach` → `cancelPending`); the
>   `join`-based reconnect can't reclaim a held pre-match slot. Full strategy-phase
>   reconnection is DEFERRED.
> - **Protocol** (`src/net/protocol.ts`): `LobbyPlayer` gained `slot?`/`hidden?` (server-
>   authored, never patchable); new `strategyStart` ServerMsg. `lobbyClient.ts` dispatches
>   it. No new ClientMsg — `ready`/`startIndex`/`spec` ride the existing `update`.
> - **Client** (`src/ui/MatchStrategy.tsx`, new): alliance build cards (reuses
>   `RobotPreview`), minimal opponent cards, close/far start-pose claim (`START_POSES`),
>   saved-robot quick-swap + full builder (reuses `Menu`), ready + live countdown. Wired
>   into `Matchmaking.tsx` (`wireStrategy` attaches to both the dev mm-socket and the
>   production host-room socket; `playerInfo` now sends `ready:false`); `App.tsx` passes
>   `onSettingsChange={update}` so re-picks persist. Shared labels lifted to
>   `src/ui/robotLabels.ts`. New CSS `.ds-strat-*` in `shell.css`.
> - **Dev parity** (`server/matchmaking.ts`): `localStart` (no-DB) now routes through
>   `applyPending` (synthesizing a stable userId per connection) so the strategy window is
>   exercisable locally without Postgres.
> - **`STRATEGY_DURATION_MS = 60s`** — tune in `server/room.ts` if needed.
>
> **BACKWARD-COMPATIBLE SINGLE SERVER (mixed client versions safe).** Because one Fly app
> serves EVERY client (alpha/beta/main all bake the same `VITE_GAME_SERVER_URL`), the new
> server must not break old clients. Fix: a **capability handshake** — the client sends
> `caps: CLIENT_CAPS` (`['strategy']`) on `join`/`queue` (`protocol.ts`), the server stores
> it per-`Client`, and `maybeStartRanked` opens the strategy window ONLY if EVERY connected
> client advertises `'strategy'`; otherwise it calls the new `startRankedImmediate()` (the
> old instant-start with STAGED specs). So: all-new room ⇒ strategy; any old client ⇒
> instant start (old clients never get a `strategyStart` they can't render); a new client in
> a fallback room just gets `matchStart` and skips the screen; a new client against an OLD
> (not-yet-deployed) server also just works (no `strategyStart` ever arrives). This means
> you can `fly deploy` the new server WITHOUT breaking main/beta users, and roll the client
> out to alpha→beta→main at your own pace. **Nuance:** one shared matchmaking queue ⇒ a
> cross-version pair skips strategy; it fires only when two updated clients meet. Once all
> branches carry the new client, it's universal.
>
> **NOT yet done:** live end-to-end UI verification (needs a running game server + two
> signed-in clients; couldn't orchestrate headlessly). Deploy is now SAFE from alpha
> (`flyctl deploy` — `server/` changed); no need to sync branches first thanks to the
> capability gate. Consider strategy-phase reconnection + a config for the deadline length
> as follow-ups.
>
> **BUG FIX (separate, pre-existing — TANK frozen over the network).** `quantizeCommand`/
> `dequantizeCommand` (`src/net/protocol.ts`) only encoded `dx/dy/rot/buttons` and
> hard-set `leftDrive/rightDrive = 0`. TANK is the only drivetrain that steers via
> `leftDrive`/`rightDrive` (mecanum/swerve/xdrive use `driveX/driveY`), so a networked
> tank robot (multiplayer OR record run — both go through `ServerSession` → `quantize`)
> got ZERO drive and sat frozen at its spawn = the middle of the field, while the local
> client kept predicting its movement (`localizeCommand` = `dequantize∘quantize`, so
> prediction ALSO dropped the tank fields → the robot was frozen everywhere the net path
> ran). Mecanum worked (its axes are transmitted); solo FREE-DRIVE worked (`stepSolo` uses
> the raw command, no quantize). FIX: added `ld`/`rd` (int8) to `QCommand` +
> quantize/dequantize, with `?? 0` guards so an older client's ld/rd-less packet still
> decodes. Verified with a headless tank record-run probe (robot now drives) + 2 smoke
> checks. **DEPLOY NOTE:** tank only works over the net once BOTH the client (Vercel) and
> the server (Fly) carry this fix — a client/server version skew here is exactly the
> desync class the capability/backward-compat work above is meant to make safe.
>
> **BONUS FIX:** `server:check` (strict tsc for `tsconfig.server.json`) was already RED at
> HEAD — the staged-roster `autoPath` (a `string`) never type-checked against
> `RobotSetup.autoPath: AutoPathData`. `startRankedImmediate` now coerces it via
> `coerceAutoPath`, so `server:check` is green again.

---

# HANDOFF — 2026-07-08 (usernames + profiles + duo-name fix, on session 9) — READ FIRST

> **LATEST (usernames + public profiles + duo-name fix): rebased onto session 9, GREEN.**
> `npm run build` + `npm run server:check` + `npm test` all pass.
> - **USERNAME** — unique lowercase `[a-z0-9]` slug per account, SEPARATE from the display
>   `handle`. Migration `0006_username.sql` (renamed from 0005 to dodge the
>   `0005_pending_matches.sql` collision): nullable `profiles.username` + unique index.
>   Format `^[a-z0-9]{3,20}$`, validated in the DB index + `server/api.ts` +
>   `src/net/api.ts`.
> - **DUO names** — root cause was read-side only (`partner_id` was always stored).
>   `recordLeaderboard` now `left join`s the partner profile → `partnerHandle`/
>   `partnerUsername`; `Leaderboard.tsx` `DriverName` renders host + partner and links
>   each to `/profile/<username>` (records + ranked boards).
> - **Public profile** — `/profile/:username` route in `App.tsx`; `Profile.tsx` +
>   `Stats.tsx` share the extracted `CareerPanel.tsx`. Capture: required sign-up field,
>   the non-dismissible `UsernameGate.tsx` (any signed-in account with no username), and
>   the Account editor — all via `UsernameField.tsx` (debounced availability check).
> - **Endpoints** — `POST /api/user/username` (JWT, 409 taken), `GET /api/username-available`,
>   `GET /api/profile/:username[/stats]`.
> - Deployed physics-free (beta/main); migration `0006` runs at server boot.
>
> Session 9 (anti-cheat) notes follow.

> **session 9: server-authoritative spec/settings sanitization (anti-cheat).**
> Players were spoofing their robot config via devtools (inspect-element / edited
> `localStorage` / hand-crafted wire messages) to spawn oversized or NaN-dimensioned
> robots. Fixed by making config validation a SINGLE SOURCE OF TRUTH enforced at every
> layer. Build + smoke (+18 new checks) + server:check GREEN, uncommitted on alpha.
>
> - **`src/sim/spawn.ts`** now owns the canonical coercers: `coerceSpec` (clamps every
>   numeric axis to its per-drivetrain / per-preset legal range, GUARDS finiteness — bare
>   `clamp(NaN,…)` returns NaN, which previously slipped through), `coerceAssists`,
>   `coerceAutoPath` (structural + field-bound clamp so a spoofed auto path can't teleport
>   a robot to an absurd/NaN pos), and `coerceSetup`. All idempotent.
> - **`createWorld` runs `coerceSetup` on EVERY setup** — the ultimate chokepoint: no spawn
>   path (client localStorage, wire join, DB-staged ranked match) can produce an illegal
>   robot. Deterministic + idempotent ⇒ live play and replay re-runs agree.
> - **`src/net/sanitize.ts`** (new): `sanitizePlayer` / `sanitizePlayerPatch` for server
>   ingress. Wired into `server/index.ts` (`join` + ranked `queue`) and `server/room.ts`
>   (`update` patch) — a spoofed spec is clamped BEFORE it lands on the roster.
> - **`src/settings.ts`** `coerceSettings` refactored to delegate to the same coercers
>   (deleted its inline spec block + `isValidAutoPathData`), so client + server sanitize
>   identically. NOTE: this also FIXED a latent client bug — the old inline path let
>   `length/width/mass/rpm: NaN` through (no finiteness guard).
>
> Earlier session-8 notes (region-aware matchmaking + `fly-replay` routing) follow.

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

## Region-aware matchmaking + `fly-replay` routing — DONE (uncommitted on alpha, build/smoke green)
Full plan in `docs/netcodeplan.md` **Phase 4**; plan file `~/.claude/plans/yes-plan-mode-on-ancient-rain.md`.
Model: **ONE Fly app, one machine per region** (`iad/sjc/lhr/syd/nrt`), routing via `fly-replay`
(NOT separate apps, NOT the old region-lock). The earlier region-lock toggle/`findGroup` were
REPLACED. Region-local ranked by default; search radius widens over time / on demand; a
cross-region match is hosted on the fair MIDPOINT region (minimax).
- **`server/regions.ts`** (new): `DEPLOY_REGIONS`, `MATCHMAKER_REGION` (env, default iad),
  `INTER_REGION_MS` static RTT matrix (SEED values — calibrate post-deploy), `bestHost()` minimax
  → `{hostRegion, cost, spread}`. **`server/matchTypes.ts`** (new): `PendingMatch`/roster.
- **`server/matchmaking.ts`** (rewritten): `QueueEntry` now `homeRegion/accessMs/noWiden/
  enqueuedAt/expandBumps`; `radiusCeiling()` (cross-region-ms gate, 0→300 widening); `findMatch`
  FIFO-greedy under the radius; `assign()` stages `pending_matches` + sends `matchAssigned`;
  `localStart()` no-DB dev fallback (hosts on the matchmaker machine). Injectable `now`/`stage`
  for tests. `expand(id)` = `expandSearch`.
- **`server/index.ts`**: WSS `noServer` + `httpServer.on('upgrade')` interceptor → `routeTarget`
  (`?mm=1`→MATCHMAKER_REGION, `?room=<region>-…`, `?region=`) answers with `fly-replay: region=<r>`
  (loop-guarded on `fly-replay-src`; inert when `FLY_REGION=''`). `/health?region=` also fly-replays
  (per-region ping). `join` is now async `joinRoom`: claims a staged match via `takePendingMatch`,
  verifies auth BEFORE add (maps roster by userId), `maybeStartRanked`. Queue handler uses the new
  fields; `expandSearch` wired. Periodic `cleanupStalePending`.
- **`server/room.ts`**: `applyPending()`/`maybeStartRanked()`/`cancelPending()` build the
  authoritative ranked match from the staged roster (ignores client specs) once all userIds
  reconnect (or 20s join grace → cancel). Extracted `beginMatch()` shared by all start paths.
- **DB**: `0005_pending_matches.sql` + repo `createPendingMatch/takePendingMatch(delete-returning)/
  cleanupStalePending`.
- **Client**: `protocol.ts` queue msg (`homeRegion/accessMs/noWiden`), `matchAssigned` ServerMsg,
  `expandSearch` ClientMsg. `ping.ts` `probeHome()` (reads `x-region`) + `pingServer` appends
  `?region`. `env.ts` `gameServerUrlWith(hint)`. `lobbyClient.queue(mode,player,homeRegion,accessMs,
  noWiden)` + `expandSearch()` + `matchAssigned` handler. `Matchmaking.tsx`: connect `?mm=1`, probe
  home, on `matchAssigned` DROP the mm socket and reconnect `?room=<code>` (two-socket handoff);
  region-lock checkbox REPLACED by expand-search + widening status + `noWiden` opt-in. `Lobby.tsx`
  region `<select>` + `?region` connect; `RecordRun.tsx` `?region` connect.
- **Config**: `fly.toml` `min_machines_running=1` (warm matchmaker region). `.env.example` Model-M
  block + `MATCHMAKER_REGION`. `deploy.md` multi-region recipe. 14 new smoke checks (bestHost,
  radiusCeiling, region-local/cross-region/noWiden/expand, staged code+roster shape).
- **Decisions**: designated matchmaker machine (not Postgres shared queue); built A+B+C.
- **NOT committed** — edited alpha directly (per protocol re-author on `beta` then cherry-pick, or
  commit alpha + backport). Cross-region ranked needs `DATABASE_URL` (roster staging); region-local
  + custom rooms don't.
- **PENDING LIVE VERIFICATION**: `fly-replay` can't be exercised on localhost (needs the Fly proxy).
  After the multi-region deploy, confirm `?region=lhr` from the US lands on lhr (`/api/presence`),
  and a widened cross-region ranked match hosts on the minimax region. Provisioning is user-run:
  `fly deploy` → `fly scale count 1 --region <code>` (×5) → `fly secrets set MATCHMAKER_REGION=iad`
  → set `VITE_GAME_SERVERS` (all same base URL, per-region entries) on Vercel. Then calibrate
  `INTER_REGION_MS` from real `/health` pings.

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
