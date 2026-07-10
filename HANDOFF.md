# HANDOFF — 2026-07-09 (in-game backdrop → menu floor; console-scaffold unification) — READ FIRST

> **LATEST: GREEN, uncommitted on `low-poly-ui`.** `npm run build` + `npm test` (ALL PASS) pass.
> Client-only — **no server/sim behavior change, no Fly redeploy needed.** GUI-verified via Electron
> (`/modes` → Free Drive, `/lobby`, `/ranked`, `/record`), screenshots + a canvas pixel probe.
>
> **1. In-game backdrop is now the menu floor.** `renderer.ts` filled the canvas `#14161a` before
> drawing; it now fills `COLORS.backdrop` (`#f9faf7`, new in `config.ts`, tracks `--ds-bg`). **The
> FIELD is untouched** — mat stays `#23262b`, so the board reads as a physical object on the warm
> floor. Verified by sampling the live canvas: letterbox corner `#f9faf7`, field center `#2c3038`.
> Two knock-ons that the light letterbox exposed and that are now fixed:
> - `.eventlog-line` (`styles.css`) was the ONE HUD surface with no border (only an accent bar) —
>   it sits in the left letterbox and would have floated invisibly. Given `1px solid var(--border)`.
> - Remote-robot name labels (`renderer.ts`) are light glyphs; a robot pinned to the far wall
>   pushes its label off the mat onto the light backdrop. They now carry a dark `strokeText`
>   outline, so they read on both.
>
> Everything else already worked: the HUD was rethemed to light cards with pastel borders last
> session, so the light backdrop actually *completes* that. Countdown text stays light on purpose
> (it paints on the dark mat, centered) — `styles.css` already comments this.
>
> **2. Console-scaffold unification (custom room + online screens).** `shell.css`'s own comment
> says the console layer is for "Lobby, Record Run, Ranked", but only **Lobby** and
> **MatchStrategy** used it. `Matchmaking.tsx` and `RecordRun.tsx` were bare `.ds-app`/`.ds-main`
> renders *outside* `AppShell` — centered text, no header, `ds-btn primary` instead of the pill
> `ds-cta`. Both now render through a local `page(title, sub, body)` helper that emits the exact
> Lobby scaffold: `.ds-console` → `.ds-console-in` (max 520) → `.ds-head` (← Back + `<Logo>` +
> APP_NAME) → `.ds-title` h1 with an `.accent` span → `.ds-sub` → `.ds-panelbox`. Ranked's 1v1/2v2
> `.ds-segs` became `.ds-opts.two` + `.ds-opt` (title + description), matching Lobby's
> Create/Join room pair.
>
> **3. One brand mark.** `Lobby.tsx` used `<Logo>` on its entry screen but a hardcoded
> `<span className="glyph">D</span>` on its room screen; `MatchStrategy.tsx` used the glyph twice.
> All four are `<Logo size={24} />` now, and the dead `.ds-mark .glyph` rule is deleted from
> `shell.css` (`.ds-dl-plat .glyph` in Download is unrelated and stays).
>
> **4. `.ds-field` layout bug — fixed at the SOURCE this time.** Last session's item 7 hit this in
> Menu's Park panel and worked around it by wrapping the field in a `.ds-fields` row. The real bug:
> `.ds-field { flex: 1 1 150px }` is a column WIDTH inside the `.ds-fields` row, but a `.ds-field`
> dropped straight into a `.ds-panelbox` (a COLUMN flexbox) turned that basis into a **150px row
> HEIGHT** — a dead ~90px gap under the input. It was live on **Lobby** ("Your name") and **Account**.
> The flex sizing now lives on `.ds-fields > .ds-field`; bare `.ds-field` is layout-neutral.
> Menu's inline `flex: '0 1 110px'` override still wins. If you add a `.ds-field` to a ROW, it must
> be inside a `.ds-fields`.
>
> **5. `.server-picker`** lost its `margin: 0 auto 20px; max-width: 380px` — both call sites
> (Account panel, Record Run console) are left-aligned padded containers that own their spacing.
>
> **Gotchas for the next `verify` run.** `ELECTRON_RUN_AS_NODE=1` is set in this shell — `unset` it
> or `npx electron` runs as plain Node and `require('electron')` returns a path string. The driver
> script must live INSIDE the repo (module resolution). To reach `/lobby` `/ranked` `/record` you
> need path routing, which is disabled under `file://` — build with `VITE_GAME_SERVER_URL` set
> (else Multiplayer is hidden), serve `dist` with `npx vite preview --port 4173`, and `loadURL`
> the http routes. The ranked route is **`/ranked`**, not `/matchmaking`. The signed-out ranked
> gate is what renders without an account; to shoot the queue screen, temporarily short-circuit
> `if (!signedIn)`.

---

# HANDOFF — 2026-07-09 (strategy 20s + countdown SFX; "matched on <server>" HUD chip)

> **GREEN, uncommitted on alpha.** `npm test` + `npm run server:check` + `npm run build` pass.
> **Needs a Fly redeploy** for the strategy-time + server-region pieces to take effect (client-only
> bits ship via the Vercel push).
>
> **1. Ranked strategy window 60s → 20s.** `server/room.ts` `STRATEGY_DURATION_MS = 20000`.
>
> **2. Countdown SFX in the strategy screen** (`src/ui/MatchStrategy.tsx`). The window now beeps
> once per second over the final `STRAT_TICK_FROM = 5` seconds, rising in pitch, with a longer
> final beep at 1s. Own `MatchAudio` instance (the GameController isn't up yet pre-match), gated
> by the player's Sounds toggle (`settings.audio.sounds`). Fires once per new second (poll is 4 Hz,
> guarded on a strict decrease of `secsLeft`). The ⏱ chip's warning style now flips at ≤5s (was ≤10)
> to match the shorter window.
>
> **3. "Matched on <server>" HUD chip for ALL multiplayer games** (ranked, custom, record).
> - Server now reports its Fly region at matchStart: `server/room.ts` `SERVER_REGION`
>   (`FLY_REGION`/`SERVER_REGION` env) → new optional `region` on the `matchStart` ServerMsg
>   (`src/net/protocol.ts`) + `MatchStart` (`src/net/lobbyClient.ts`).
> - `src/net/env.ts`: `regionLabel(code)` (iad→'US East', sjc→'US West', lhr→'Europe', syd→
>   'Australia', nrt→'Asia'; unknown→UPPER) + `isKnownRegion`.
> - `ServerSession` derives a `serverLabel` (`deriveServerLabel`): reported region → region-coded
>   room-code prefix (`iad-…`) → picked server label. Surfaced as `NetStatus.server` (new field).
> - `GameView.tsx`: a `🌐 <label>` chip next to the NET chip (only when `hud.net.server` is set).
> - Backward-compatible: an OLD server omits `region`, so the client falls back to the room-code
>   prefix (accurate for ranked) or the selected server's label.
>
> **4. Fly VM cost downgrade.** `fly.toml` default performance-2x/4GB → **performance-1x/2GB**
> (applies to iad + sjc; still dedicated). `scripts/fly-deploy.sh` far satellites (lhr/syd/nrt)
> performance-1x → **shared-cpu-1x/1024MB** (`SATELLITE_SIZE`/`SATELLITE_MEMORY`, now passes
> `--vm-memory`). Shared CPU can throttle-flap a sustained 60Hz match (the exact risk the
> dedicated-CPU note warns about) — accepted for the low-traffic far regions (they auto-stop when
> idle + rarely host); bump back to a performance-* size if one flaps. Applied on the next
> `fly-deploy.sh` run (the satellite-resize step), OR live now via `fly machine update`.
>
> **5. Homepage redesign** (`src/ui/Home.tsx`, `MatchSetup.tsx`, `shell.css`). Play tiles are now
> grouped into three labeled sections (`.ds-tileset`/`.ds-tileset-label`): **Practice · offline**
> (Solo Practice primary + Free Drive), **Compete · online** (Find Match, Record Run, Duo Record),
> **Custom** (Custom Room) LAST. "Solo Match" → **"Solo Practice"** (was misleading — it's a full
> match, used for practice). **Match setup** is now a COLLAPSED `<details>` panel
> (`.ds-collapse`/`.ds-collapse-sum`) with the hint "Alliance, start & auto · Ranked and Custom set
> these in the lobby" — those options only apply to solo/offline modes, so they no longer clutter
> the landing. GUI-verified via Electron (structure + collapsed→expanded). Client-only (no deploy
> dependency beyond the Vercel push). NOTE: `verify` needs `ELECTRON=1 npm run build` (relative
> `base` for `file://`); the plain web build uses `base:'/'` and renders blank under Electron.
>
> **6. UI de-clutter pass** (`shell.css`, `Menu.tsx`, `Lobby.tsx`, `MatchHistory.tsx`). Trimmed
> over-tall boxes: the My Robot HERO card was ~292px (a long/narrow robot preview stretched it) →
> **239px** — `RobotPreview size={160}` in Menu + `.ds-hero-view svg { max-height:190px }` (capped
> just under the stats column so the stats drive the height, killing the empty bottom-right gap) +
> `.ds-hero-view` min-height 200→150. Home `.ds-tile` min-height 118→94 (lone Custom Room tile no
> longer looms). `.ds-empty`/`.ds-loading` padding 44→30px. Removed 3 redundant tooltips: Lobby
> ★HOST chip (text already says it) + the presence dot ('you'/'connected', row already shows "(you)"),
> and the MatchHistory season `<select>` (options name the seasons). Kept genuinely-explanatory ones
> (copy-room-code, ServerPicker ping-dot quality, net-stat chips, view-@user). GUI-verified via Electron.
>
> **7. Park mode box too tall — real layout bug** (`Menu.tsx`). The Park-mode `.ds-panelbox` was
> 214px with a ~150px empty gap between the slider and the hint. Cause: a bare `.ds-field` (`flex:
> 1 1 150px`) sat directly in the panelbox's COLUMN flex, so its 150px flex-BASIS became a forced
> HEIGHT. Fix: wrap it in `.ds-fields` (a row) like every other section does → basis is width again;
> box 214→**102px**. (No CSS change — purely the missing wrapper.)
>
> **8. Settings reachable when signed out** (`AccountButton.tsx`). Auth-enabled + signed-out showed
> ONLY "Sign in" (a modal) with no path to the settings page, so controls/audio were unreachable
> without an account. Added a "Settings" ghost button beside "Sign in" (in the account-name slot)
> → `onAccount` → the Account page, which already renders Controls/Audio/Reset regardless of sign-in.
> GUI-verified: header shows Settings·Sign in, and Settings lands on Account → Controls section.
>
> **9. Drivetrain rebalance** (`config.ts` `DRIVETRAIN_PRESETS`). Small tuning: **tank**
> speedMult 1.05→1.03, accelMult 1.5→1.42; **mecanum** speedMult 1.0→1.02, accelMult 1.0→1.06.
> Preserves the core accel order tank>swerve>mecanum>xdrive (383/302/286/248 in/s²) and keeps tank
> the top straight-line speed (1.03>1.02); `pushMult` untouched so mass-shove calibration holds.
> Mecanum is NO LONGER the 1.0/1.0 anchor — the BASE (`SPEED_PER_RPM`/`BASE_DRIVE_ACCEL`) is the
> 75/7/280 calibration and the ref mecanum now reads 76.5/7.14/296.8. Updated the calibration smoke
> check to divide out the mecanum mult (pins the base regardless of tuning) + 2 new checks (speed
> order, mecanum buffed). Comments updated in config.ts / drivetrain.ts / CLAUDE.md. smoke + build green.
>
> **NOT live-verified for the multiplayer bits** (#2/#3 need a running server + 2 signed-in clients —
> couldn't orchestrate headlessly, same as the strategy-window ship). Deploy is safe from alpha
> (server + client changed): commit → `flyctl deploy` → verify /health → Vercel auto-deploys the client.

---

# HANDOFF — 2026-07-09 (FIX: alpha↔main matchmaking pool separation → strategy window)

> **LATEST (build-id matchmaking segregation): GREEN, uncommitted on alpha.**
> `npm test` (+3 checks) + `npm run server:check` + `npm run build` all pass.
>
> **Symptom (reported):** an alpha 2v2 RANKED match did NOT open the pre-match STRATEGY
> window (it should). Alpha and main were sharing a matchmaking pool.
>
> **Root cause — one bug, both symptoms.** The strategy window opens only if EVERY client
> in a staged ranked room advertises the `strategy` cap (`server/room.ts:492`). `main`
> clients advertise NEITHER a `channel` NOR the `strategy` cap (verified:
> `git show main:server/matchmaking.ts`/`:src/net/protocol.ts` have neither). The
> matchmaker already segregates by `channel`, but ONLY if alpha actually reports
> `channel:'alpha'` — which comes from `VITE_APP_CHANNEL`, a MANUAL Vercel env var
> (`.env.example:46`, commented). If it's unset, the alpha client reports `'stable'`, so
> alpha and main land in one pool; an alpha 2v2 can then include a `main` client (no
> `strategy` cap) → the server falls to `startRankedImmediate()` → no strategy window.
> (A *pure* alpha 2v2 already works — the whole reconnect/caps path was traced.)
>
> **Fix — automatic pool separation by BUILD ID (`__BUILD_ID__`, the git sha).** The client
> now sends its build id on `queue` and the matchmaker segregates by (channel + build), so
> two DIFFERENT builds NEVER share an authoritative match — the exact "same code" invariant
> the client-side version gate already implies, now enforced server-side. Alpha and main
> always have different shas ⇒ separated automatically, no env var needed.
> - `server/matchmaking.ts`: `QueueEntry.build`; new `bucketKey(e)=`${channel}|${build}``;
>   `findMatch` + `broadcastStatus` bucket by it (was channel-only). Absent build ⇒ '' ⇒
>   channel-only fallback (old clients still pair among themselves).
> - `src/net/protocol.ts`: optional `build?` on the `queue` ClientMsg.
> - `src/net/env.ts`: `appBuild()` (reads `__BUILD_ID__`; declared here, NOT imported from
>   `version.ts` which pulls React). `src/net/lobbyClient.ts` `queue()` sends `build: appBuild()`.
> - `server/index.ts`: queue handler reads `msg.build` → `enqueue`.
> - `scripts/smoke.ts`: +3 (different builds don't pair; same build pairs; build-less old
>   clients still pair via channel fallback).
>
> **DEPLOY (both needed; the code alone does nothing until the SERVER runs it):**
> 1. **Redeploy the Fly server from current alpha** (`flyctl deploy --remote-only`) — the
>    matchmaker must run this bucketing code. Verify `/health`.
> 2. **Rebuild the alpha client on Vercel** so it sends `build`. (A build id is baked on
>    every deploy already — no config needed for separation.)
> 3. **STILL set `VITE_APP_CHANNEL=alpha`** on the alpha Vercel project — the `channel`
>    remains what keeps alpha results OFF the leaderboard/ELO (unpersisted); build-id only
>    handles pool separation. Both matter.
> Note: build-id bucketing means a client on an OLD build (pre-refresh) only matches other
> old-build clients until the version gate refreshes it — intended (never pair mismatched sims).

---

# HANDOFF — 2026-07-09 (FIX: networked robot NaN → renders at field centre)

> **LATEST (old-server field-skew NaN fix): GREEN, uncommitted on alpha.**
> `npm run build` + `npm test` (+2 new checks) + `npm run server:check` all pass.
>
> **Bug (reported on the alpha DEPLOYMENT only):** in any server-connected mode the local
> robot rendered at its start pose for one frame, then vanished and a static robot appeared
> at the field CENTRE (0,0), while the "real" robot stayed faintly controllable. HUD showed
> `PWR NaN%`.
>
> **Root cause — client/server SIM version skew.** The deployed Fly server
> (`dohun-sim-decode`) is running an OLDER `src/sim` that PREDATES the power-draw model, so
> its snapshot `RobotState` has NO `flywheelSpin` / `flywheelSpinRate` / `powerDraw` (verified
> by scanning a live snapshot: robot keys end at `pathTargetHeading`). The newer alpha CLIENT
> reconciles `this.world = snap.world`, so those fields arrive `undefined`; then `updateRobot`
> computes `POWER_DRAW_FLYWHEEL_HOLD * undefined` → NaN → `powerDraw` NaN → `dp.maxSpeed *=
> (1 − NaN)` → NaN velocity/position. `ctx.translate(NaN,NaN)` is a no-op, so the robot draws
> at the camera origin = field centre and freezes. Never reproduced LOCALLY because
> `npm run server` runs the CURRENT sim (fields present). One Fly app serves every client
> version, so this old→new skew is exactly the backward-compat hazard `CLAUDE.md` warns about
> (cf. the tank `ld/rd ?? 0` guard).
>
> **Fix (`src/net/protocol.ts` `unslimWorld` → new `backfillRobot`):** when the client rebuilds
> a world from the wire, back-fill any missing/non-finite dynamic robot field to a sane value
> (`flywheelSpin` ← `flywheelSpinTarget(alliance,pos)` like spawn, `flywheelSpinRate`/`powerDraw`
> ← 0). `finiteOr` catches `undefined` AND `null` (JSON serializes NaN→null). Harmless when the
> server DOES send them. Also removed the leftover TEMP DEBUG overlay in `game.ts` (green text +
> `window.__dbg`) that was left in to chase this. +2 smoke checks (old-server skew: back-fill is
> finite; stepping the stripped snapshot never NaNs the position).
>
> **CHOSEN FIX (user directive): segregate + don't persist ALPHA, plus the NaN guard.**
> A single Fly binary can only run ONE `src/sim`, so alpha (new physics) and stable (old
> physics) clients can't safely share an authoritative match. Instead of forcing everyone onto
> one sim, the build now carries a **release channel** and the server keeps the two apart:
> - **`src/net/env.ts` `appChannel()`** — baked from `VITE_APP_CHANNEL` (default `'stable'`; the
>   alpha Vercel project sets `alpha`). Sent to the server on `join`/`queue` (`lobbyClient.ts`,
>   new optional `channel` on both `ClientMsg`s).
> - **Matchmaking segregation** (`server/matchmaking.ts`): `findMatch` only groups entries of the
>   SAME channel; `broadcastStatus` counts per-channel (so an alpha queuer isn't told a mixed
>   pool is "ready"); the staged `PendingMatch` + each roster entry carry the channel (persisted
>   inside the roster jsonb — NO schema migration; `repo.ts` `takePendingMatch` reads it back).
> - **No DB writes for alpha** (`server/room.ts`): `Room.channel` is set from the first client
>   (or the staged roster); `finalizeMatch` still broadcasts `matchResult` (results + replay
>   work) but RETURNS before `onResult` when `channel === 'alpha'` — no leaderboard/ELO/record
>   rows. Client shows "Not saved / Not rated on this test build" (`GameView.tsx`) instead of
>   spinning on "computing rank…".
> - **NaN guard kept** (`unslimWorld` back-fill) as defence-in-depth for any residual field skew.
>
> **DEPLOY STEPS (both needed for the feature; the client push alone already stops the NaN):**
> 1. **Set `VITE_APP_CHANNEL=alpha`** on the alpha Vercel project (Settings → Env), then push →
>    Vercel rebuilds `alphadec.dohunkim.xyz`. WITHOUT this the alpha client reports `stable` and
>    won't segregate / stays persisted.
> 2. **Redeploy the Fly server from current alpha** (`scripts/announce-deploy.sh` to warn players,
>    then `flyctl deploy --remote-only`) so the server knows `channel` AND runs the current sim.
>    Note: the server then runs the alpha sim for ALL rooms (stable clients would rubber-band on
>    the changed physics but never NaN — extra snapshot fields are ignored). Verify `/health`.
> Repro/diagnosis: headless `ws` clients + an Electron driver pointed at the live deployment
> reading `window.__dbg` (that TEMP overlay is now removed).

---

# HANDOFF — 2026-07-09 (ranked pre-match STRATEGY window)

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
