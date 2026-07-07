# HANDOFF — 2026-07-07 (session 3: account features + server DEPLOYED) — READ FIRST

Build + smoke + both tsc GREEN. **Server was redeployed to Fly (`dohun-sim-decode`)
and verified live** — this fixed the prod "My Stats 404" + "display name failed to
fetch" (the client had shipped new endpoints the old server lacked; leaderboard kept
working because `/api/records|elo` already existed). New this session:

- **Editable display name** (from session 2) — now WORKS in prod after deploy.
- **Homepage counts** — `GET /api/stats` → `{users, games, byCategory{solo,duo,1v1,2v2}}`
  (`repo.getGlobalStats`, cheap COUNT/GROUP BY). Home shows Players + Games played +
  a category breakdown (only when the game server is configured). Client
  `fetchGlobalStats`. NOTE: "games" = server-persisted runs (record + PvP); offline
  Solo Match / Free Drive aren't reported, so not counted.
- **Record config on the leaderboard** — each record row now stores the robot config
  it was set with. Migration `0002_record_config.sql` (records.config jsonb).
  `MatchParticipant` carries `spec`+`assists`; `persist.ts` writes
  `config:{spec,assists}`; `submitRecord`/`recordLeaderboard`/`BoardRow` carry it.
  Client `RecordRow.config`; `Leaderboard.tsx` adds a "Robot" column that expands to a
  `ConfigSummary` (drivetrain/mass/rpm/intake/flywheel/size + assist chips). Old rows =
  `config:null` → show "—".
- **Per-account settings sync** — migration `0003_profile_settings.sql`
  (profiles.settings jsonb). `GET/POST /api/user/settings` (JWT-verified;
  `repo.getUserSettings/saveUserSettings`). `settings.ts` refactored to expose
  `coerceSettings(raw)` (shared validator). `AccountSync.tsx` (mounted in App shell when
  authEnabled) loads the account's settings on sign-in (or seeds from local if none) —
  guarded by a MODULE-LEVEL `syncedUser` so returning from a game never re-fetches and
  clobbers unsaved edits. App `update()` debounce-saves to the server (700ms) when
  signed in; localStorage still always written. Request body cap raised to 512KB (an
  imported .pp auto-path rides inside settings).
- **Route regexes** for `/api/user/:id[/stats]` widened to `[^/]+` (any non-slash id).

**STILL NEEDED for the newest UI in prod:** redeploy the FRONT-END (git push → Vercel).
The server is ready for everything; the client bundle on Vercel must be updated for the
leaderboard config expander, homepage counts, and settings sync to appear. (Display
name + My Stats already worked once the server deployed, since that client was already
live.) Nothing has been committed/pushed by me.

---

# HANDOFF — 2026-07-07 (session 2 follow-ups)

Build + smoke + both tsc GREEN; GUI verified over HTTP. Follow-ups on top of the
"UI overhaul" section below (which still says "DohunSim" — the app is now **DSIM**):

- **Renamed DohunSim → DSIM** everywhere via `APP_NAME` in `src/seasons.ts` (one const
  drives header/footer/eyebrows), plus `index.html`, `package.json` productName +
  electron-builder `artifactName`s, `electron/main.cjs`.
- **New logo** — `src/ui/Logo.tsx` (a top-down robot + barrel on a cyan badge) replaces
  the plain "D" glyph in every `.ds-mark`; `public/favicon.svg` is the same artwork.
- **Display name is editable** — `POST /api/user/handle` (JWT-verified via
  `verifyAuthToken`, the ONE authed HTTP write; CORS preflight added) + `GET /api/user/:id`
  (`repo.getProfile`). Client `updateHandle`/`fetchProfile` in `src/net/api.ts`; editor in
  `Account.tsx` (`DisplayName`), edits the profile `handle` (the public board name).
- **Desktop downloads are wired to GitHub Releases** — `src/download.ts` defaults every
  build URL to `releases/latest/download/<stable-asset>`; Windows (installer+portable),
  **macOS (universal .dmg)**, and **Linux (AppImage)**. `.github/workflows/release.yml`
  builds all three on a `v*` tag matrix and `electron-builder --publish always` uploads
  them (built-in GITHUB_TOKEN; mac unsigned via `mac.identity:null`). Stable
  artifactNames in `package.json`: DSIM-Setup.exe / DSIM-Portable.exe / DSIM-mac.dmg /
  DSIM-linux.AppImage. Download page features the visitor's detected OS first. **To make
  bytes exist: push a version tag** (`git tag v0.1.0 && git push --tags`) — the workflow
  publishes the release the links point at.
- **Match config split OUT of My Robot** — new `src/ui/MatchSetup.tsx` (alliance, start
  position, practice dummies, `.pp` auto-path import — all moved out of Menu) renders on
  **Home** below the play tiles. `Menu.tsx` (My Robot) is now ROBOT-ONLY: presets, builder,
  intake, drive style, assists, park, controls — NO game mode / alliance / start / auto
  path, and NO "ENTER FIELD"/"MULTIPLAYER" buttons (matches start from Home). Game MODE is
  the play-tile choice on Home. `Menu` props dropped `onStart`/`onMultiplayer`.

---

# HANDOFF — 2026-07-07 (rebrand → DohunSim + UI overhaul)

Build + smoke + server-tsc GREEN. Verified all new pages render over HTTP via Electron
(the `file://` capture harness shows a blank root — that's a PRE-EXISTING `initPhysics()`
WASM gate under `file://`, not from this work; nothing here touched physics/main.tsx).

**Rebrand to "DohunSim" + season abstraction.** New `src/seasons.ts` is the branding hub:
`APP_NAME='DohunSim'`, `LINKS` (repo + Discord), and a `SEASONS` registry with
`CURRENT_SEASON` (DECODE, 2025–26). DECODE is now framed as ONE season; add future games by
registering another `Season` and flipping `playable`. The *app* is DohunSim; *DECODE* is the
loaded game — keep that split (scoring text still says "DECODE scoring", correctly).
Rebranded: `index.html` title, `package.json` productName, `electron/main.cjs` title,
`AppShell` mark, `Home` eyebrow, `Menu` header.

**Legacy menu CSS DELETED.** The old `styles.css` menu design (`.menu-*/.card/.builder/
.spec-row/.bind-*/.keycap/.start-btn/.lobby-*/.field/.subtitle/.hint`) is GONE (styles.css
1078→644 lines). Everything migrated onto the Direction A `ds-` design system, with a big new
"console layer" appended to `shell.css` (`.ds-console/.ds-opt/.ds-field/.ds-range/.ds-hero/
.ds-stat/.ds-cta/.ds-key/.ds-player/.ds-season/.ds-foot/.ds-dl-*` etc.). The in-match FTC HUD
(`.hud/.scorebar/.chip/.overlay*/.timer*/.mobile-*`) INTENTIONALLY still lives in styles.css —
it is the deliberate FTC-live-scoring look (product decision), NOT legacy menu styling. Do not
"finish migrating" it without being asked. Migrated files: `Menu`, `ControlsSection`, `Lobby`,
`GameView` (overlay `.start-btn`/`.hint` leaks only).

**My Robot page redesigned** (`Menu.tsx`, still the full-screen setup console). Leads with a
robot HERO: live SVG preview (`RobotPreview.tsx`, drawn from the spec — chassis/intake/turret in
inches) + 6 stat cards + season badge, then presets, builder, match-setup sections, controls,
ENTER FIELD. Audio toggles MOVED OUT of Menu → Account page. Auto-path section now links
visualizer.pedropathing.com for the .pp source.

**New shell pages** (rendered inside AppShell `.ds-main`, routed in `App.tsx`; nav expanded to
Home / My Robot / My Stats / Leaderboard / Download; account reached via the right-slot
button):
- `Download.tsx` (`/download`) — desktop-build page. Reads `src/download.ts` (env-configurable
  `VITE_DOWNLOAD_*` URLs, else "not available yet" + build-it-yourself `npm run dist`).
- `Stats.tsx` (`/stats`) — per-user career. Uses a NEW real endpoint, not board-filtering.
- `Account.tsx` (`/account`) — identity (Neon Auth) + Audio prefs + reset-all-settings.
- Footer (`AppShell`) carries GitHub + Discord links.

**NEW server endpoint** `GET /api/user/:id/stats?season=` (`server/api.ts`) →
`repo.getUserStats(userId, balanceVersion)`: overall ELO+rank per mode, record PB+rank per
mode, W/L totals, recent match history — ranks computed server-side with window functions (no
full board pulled). Client: `fetchUserStats` + `UserStats` types in `src/net/api.ts`. Per-user
ELO already existed in the schema (`elo_ratings`); this just exposes it in one round-trip.

**AccountButton** now takes `onAccount` (name chip → account page). When auth is OFF the
right-slot shows a "Settings" button → account page (audio/reset still work without auth).

Follow-ups / not done: host real desktop builds + set `VITE_DOWNLOAD_*`; the Account-page nav
highlight falls back to "Home" (account isn't a nav item — cosmetic). `defaultSettings()` reset
wipes robot too (intentional, behind a confirm()).

---

# HANDOFF — 2026-07-07 (build fix + server perf) — READ earlier context below

Two follow-up fixes on top of the section below:

**1. Build was RED after the `NeonDB+Auth` merge — now GREEN.** Causes + fixes:
- Deps in `package.json` were not installed (`@dimforge/rapier2d-compat`, `@neondatabase/auth`,
  `pg`, `ws`) → ran `npm install`.
- The merge left a DUPLICATE `GameSettings` (one in `src/game.ts` w/ `parkSpeedPct`+`ControlBindings`
  bindings, a stale one in `src/types.ts` w/ `Record<string,string[]>`+no `parkSpeedPct`). Unified on
  ONE canonical def in `src/types.ts` (now the richer version); `game.ts` re-exports it (`export type
  { GameSettings }`) so all `from '../game'` importers still work. `settings.ts` now gets `AutoPathData`
  from `./types`. Cleaned up the auto-path merge fallout in `renderer.ts`/`pathTraversal.ts` (imports),
  `spawn.ts` (`createWorld` 4th arg `gameSettings?` optional; `autoPathActive` coerced to boolean),
  `game.ts` (`autoPath: s.autoPath ?? undefined`). `npm run build` + `npm test` green.

**2. Fly server was slow + flapping health checks with ONE player — fixed.** Root cause: the room loop
runs a CONTINUOUS 60 Hz Rapier step; on the burstable `shared-cpu-1x` that drains burst credits in ~a
minute, Fly throttles to baseline, the single event loop stalls, and `/health` times out → machine
flaps. Changes:
- **`fly.toml`**: `shared-cpu-1x`/512mb → **`performance-1x`/2048mb** (dedicated vCPU, never throttled).
  Health `grace_period` 10s→30s, `timeout` 5s→10s (tolerate cold boot). auto-stop still on ⇒ idle ~$0.
- **Cold boot**: `Dockerfile` is now a 2-stage esbuild BUNDLE run with plain `node` (was `tsx`, which
  transpiled the whole tree ~7s each boot). New scripts `server:build`/`server:prod`; added `esbuild`
  devDep; `dist-server/` gitignored. Validated: bundle builds (~108KB, 16ms) + serves `/health` + inits
  physics in <1s.
- **Per-tick CPU**: `physicsEngine.ts` `buildStatics` now MEMOIZES the constant field-collider geometry
  (was recomputing goal trig + allocating on all ~120 world-builds/s; numbers identical ⇒ determinism +
  smoke unchanged). `room.ts` `checkGrace()` early-returns when no client is disconnected (was spreading
  the client map every tick).
- **NOTE / next lever**: the biggest remaining per-tick cost is that `solveRobots`+`solveBalls` each
  build+free a fresh Rapier `World` every step (2×/tick). Pooling a persistent scratch world would cut
  that, but it's determinism-risky (client predicts with the fresh-world path; both sides must match, and
  warm-start state must be cleared) — left alone; the dedicated CPU carries the runtime load. TODO for the
  user: `fly deploy` to ship these (I can't run it — no Fly creds).

**3. Bundling broke two runtime assumptions the `tsx` path hid — both fixed:**
- **Migrations weren't shipped** → boot logged `migration failed ... ENOENT /app/dist-server/migrations`
  and records stayed disabled. `db/migrate.ts` resolves `./migrations` via `import.meta.url`; under
  `tsx` that was `/app/server/db/migrations` (whole `server/` tree copied), but in the bundle it's
  `/app/dist-server/`. esbuild does NOT bundle the `.sql` (read at runtime with `readdirSync`), so the
  Dockerfile now `COPY server/db/migrations ./dist-server/migrations` (next to the bundle). Verified the
  path resolves + files list. (The ENOENT is caught/non-fatal, so the app still listened — the earlier
  "not listening on 0.0.0.0:8080" was a transient boot-window warning, not a crash.)
- **`jose` was undeclared** — `server/auth.ts` imports it directly but it was only present as a transitive
  dep of the client-only `@neondatabase/auth`. Added `jose` to `dependencies` (was working by luck of
  hoisting). Verified a prod-only `npm ci --omit=dev` install + bundle boot serves `/health` + inits
  physics, with migrations beside the bundle.

**4. Deploy prints `WARNING The app is not listening on ... 0.0.0.0:8080` — EXPECTED, not a bug (user
chose to accept it).** The app DOES bind 0.0.0.0:8080 on Fly (proven: the boot log reaches `migrate()`,
which runs AFTER `listen()`). The warning is a deploy-time reachability-check artifact of
`auto_stop_machines = 'stop'` + `min_machines_running = 0`: Fly stops the machine right after the release,
so its post-deploy check finds nothing listening. `auto_start` wakes it on the first real connection —
verify with the public `…fly.dev/health` returning `ok`. To make the warning go away entirely, set
`min_machines_running = 1` (always-on, no cold start, but the dedicated vCPU then bills continuously); the
user opted to KEEP auto-stop for the cost savings and ignore the warning.
- Hardened `server/auth.ts` while here: `createRemoteJWKSet(new URL(JWKS_URL))` now runs in a try/catch,
  so a malformed `NEON_AUTH_URL` degrades to anonymous instead of throwing at module load (which, being
  imported before `listen()`, would have caused a REAL "not listening" crash). Secrets are set + valid, so
  this is belt-and-suspenders.

---

# HANDOFF — session ending 2026-07-07 (Fly auto-stop + Phase 3 backend spine)

Read `CLAUDE.md` first (load-bearing rules), then this. Roadmap = `docs/netcodeplan.md`;
Phase 3 spec = memory `phase3-leaderboards-spec.md`. This session shipped: (1) fixed +
auto-stopped the Fly server, (2) the Phase 3 **replay foundation**, and (3) the entire
Phase 3 **backend spine** (server-side recording, Neon schema + DB layer, ranked ELO,
public read APIs). The remaining Phase 3 work is all CLIENT UI, gated on a design pick.

## ✅ Build: GREEN · `npm test` ALL PASS (~160 checks) · `npm run build` clean · `npm run server:check` clean
## ✅ Fly `dohun-sim-decode`: HEALTHY, auto-stops when idle, REDEPLOYED with the full backend + auth

## 🔑 Fly secrets (`DATABASE_URL` + `NEON_AUTH_URL`): ✅ ALREADY SET by the user (2026-07-07).
Confirmed live: the boot log now shows the DB ENABLED (it reached `migrate()` and tried to read the
migrations dir — that only happens when `DATABASE_URL` is set). So persistence + JWT auth are wired;
records persist once the migrations-path fix above is deployed (`fly deploy`).
```
# for reference only — already applied:
fly secrets set DATABASE_URL='postgresql://…neon.tech/neondb?sslmode=require&channel_binding=require' \
                NEON_AUTH_URL='https://ep-lingering-pine-ahq640vd.neonauth.c-3.us-east-1.aws.neon.tech/neondb/auth' \
                -a dohun-sim-decode
```
- Also confirm the JWKS path with ONE live sign-in (Neon's may differ from Better Auth's `/jwks`
  default → adjust `NEON_AUTH_JWKS_URL`; until then a signed-in run verifies as anonymous = safe).
- Vercel client: set `VITE_GAME_SERVER_URL=wss://dohun-sim-decode.fly.dev` + `VITE_NEON_AUTH_URL`.

## ✅ Record-run loop — BUILT + VERIFIED end-to-end (this session)
Home "Record Run" tile → `RecordRun.tsx` connects, creates a PRIVATE record room, auto-starts
(cold-boot retry), mints a `ServerSession` → server-authoritative solo match. Electron test
against LIVE prod: `OUTCOME: GAME (matchStart OK)`. `lobbyClient.join` now carries `RoomConfig`
+ the auth JWT. On phase `post` the server records + `persistMatch` writes the record (needs the
DB secret + a signed-in user). The FTC Results overlay (score breakdown) already shows at `post`.

## Settled decisions this session (do not relitigate)
- **Recording is SERVER-SIDE, one recorder, NO client record mode.** Score-attack (records)
  and PvP (ELO) both run on the Fly server, which records the input log + owns the score.
  Solo/duo = "a server match with no opponent"; the client just plays via the existing
  predict+reconcile netcode. Kills the cross-machine-determinism question (never re-sim a
  client log to score). Line: casual/free-drive = offline no-recording; competitive = server.
  (Full rationale in memory + earlier HANDOFF history.)
- Cross-machine determinism only affects the cosmetic replay VIEWER; DEFERRED sparse-keyframe
  insurance until we actually observe drift (immutable score stored beside each replay).

## 1. Fly server — fixed + auto-stop (ME; standing deploy instruction)
Was spamming `[PR04] could not find a good candidate` — the HTTP event loop had WEDGED
(machine `started`, process alive, `/health` timing out; Fly restarts on exit only, so it
never recovered). Restarted it, then `fly deploy`'d the auto-stop `fly.toml` that had been
undeployed since last session. LIVE: `auto_stop_machines: true`, `min_machines_running: 0`,
`auto_start_machines: true`. Idle → scales to zero; a session cold-boots a FRESH process
(~7 s tsx transpile) which also sidesteps the degrade-after-uptime wedge. `/health` → ok.
Not solved: a wedge WHILE players are connected won't self-heal — add a `process.exit(1)`
watchdog if it recurs. `rw.free()` per step + room-loop cleanup verified (no leak found).

## 2. Phase 3 replay foundation (pure sim, green)
- `config.ts` `BALANCE_VERSION = 1` — the season key; bump DELIBERATELY on a balance patch.
- `src/sim/replay.ts` — `Replay` (hold-last-compressed command tracks), `ReplayRecorder`,
  `ReplayPlayer`, `simulateReplay`, `verifyReplay`, `worldResult`, `recordSetups('solo'|'duo')`,
  `runRecordMatch`, `maxMatchTicks`. Same-build record→re-sim is byte-identical (smoke).

## 3. Phase 3 BACKEND SPINE (built + green this session)
All server-side, env-driven — **no-op without `DATABASE_URL`** (game/lobby/matches still work).
- **Server recording** (`server/room.ts`): `ReplayRecorder` attached to the tick loop
  (refactored into `stepOnce`); at phase `post` → `finalizeMatch` broadcasts a `matchResult`
  (`ServerMsg`, protocol.ts) with the authoritative score + replay AND calls an injected
  `onResult(MatchOutcome)`. Record rooms force all robots onto one alliance (co-op) + guard
  duo same-drivetrain. `RoomConfig {kind:'versus'|'record', record?:'solo'|'duo'}` set via the
  first `join` (`roomCapacity` caps record rooms). `advanceForTest` = deterministic timer-free
  pump (smoke drives a full Room match → replay verifies).
- **Schema** `server/db/migrations/0001_init.sql` — seasons, profiles, robot_presets, replays,
  records (+`record_leaderboard` view), elo_ratings, matches, match_participants. All stamped
  with `balance_version`.
- **DB layer** (`server/db/`): `pool.ts` (`pg.Pool` from `DATABASE_URL`, null ⇒ disabled),
  `migrate.ts` (applies pending .sql at boot), `repo.ts` (records/replays/presets/ELO/matches
  primitives + `recordLeaderboard`/`eloLeaderboard`/`getReplay`).
- **Ranked** `server/ranked.ts` — PURE `computeElo` (team-Elo; OVERALL board always + the
  mode×drivetrain board only when all share a drivetrain; mixed ⇒ overall only) + `applyMatchElo`
  (reads/writes ratings + match history). Smoke-tested.
- **Persistence** `server/persist.ts` `persistMatch(outcome)` — orchestrates record vs. ELO,
  saves the replay, requires ≥1 AUTHED participant (else drops anonymous). Wired as the Room's
  `onResult` in `server/index.ts`.
- **Public read API** `server/api.ts` (GET on the WS port, CORS-open): `/api/records`,
  `/api/elo`, `/api/replay/:id`. Empty/404 when DB disabled.
- `pg` + `@types/pg` added; `.env.example` documents `DATABASE_URL`, `DB_POOL_MAX`, Neon Auth
  vars (+ `fly secrets set` guidance).

## 4. UI redesign — Direction A "DRIVER STATION" CHOSEN; foundation SHIPPED
User picked **A · Driver Station** (broadcast telemetry: near-black, signal-amber, mono data,
thin rules, faint 24" tile grid). Built + Electron-verified this session:
- **`src/ui/shell.css`** — the Direction A design system (tokens on `:root` as `--ds-*` +
  component classes `ds-app/bar/nav/tile/panel/table/seg/chip/btn`). Imported in `main.tsx`
  AFTER styles.css. Legacy `styles.css` (menu/game/lobby) is UNTOUCHED — migrate screen-by-
  screen so the build stays green (don't rip it out wholesale).
- **`src/ui/AppShell.tsx`** (top bar + nav: Home / My Robot / Leaderboard), **`Home.tsx`**
  (play tiles: Solo Match / Free Drive / Custom Room / Ranked-locked + loadout summary),
  **`Leaderboard.tsx`** (records/ranked × mode × drivetrain segmented, live-fetches the read
  API, first-class empty/loading/error states).
- **`src/ui/App.tsx`** rewired: `Screen = home|robot|leaderboard|lobby|game`; Home is the
  landing. `robot` = the existing `Menu` full-screen (now takes `onBack` → Home; it stays the
  robot builder + assists + controls until split into MyRobot/Settings). game/lobby unchanged.
- **`src/net/api.ts`** (client) + `gameServerHttpUrl()` (ws→http) — fetchRecords/fetchElo/
  fetchReplay against the server's public API.
- Verified in Electron: Home + nav + Leaderboard render correctly on Direction A; board shows a
  graceful error until the server has `/api` (needs the Fly redeploy below) + a DB.
Mockup artifact (all 3 directions) URL is in the session chat.

## ⚠️ EXTERNAL UNBLOCKS I need from you
1. **Pick a UI direction** (A / B / C, or a mix) → unblocks the entire client redesign (#7).
2. **Set Fly secrets** (placeholders only here — real values live in `.env`/Fly, never in a
   committed file): `DATABASE_URL` (Neon string) + `NEON_AUTH_URL` (the PUBLIC auth URL; auth is
   JWKS-based, there is NO secret key). Then the server auto-migrates + persists on next boot.
3. **Neon Auth**: just `VITE_NEON_AUTH_URL` (public). Neon Auth is
   BETA — confirm GA + Discord/GitHub OAuth at build; fallback = self-host Better Auth.
4. Vercel client env: `VITE_GAME_SERVER_URL=wss://dohun-sim-decode.fly.dev` + `VITE_NEON_AUTH_*`.

## ✅ Phase 3 is BUILD-COMPLETE (all 7 tasks) — everything below now exists + is green/deployed
- **Matchmaking + ELO (#5)**: `server/matchmaking.ts` (FIFO queue per 1v1/2v2 → auto-creates a
  versus room + starts), protocol `queue`/`leaveQueue`/`queued`, `Matchmaking.tsx` + Home "Ranked"
  tile + `/ranked`. ELO applied by `persistMatch` on match end. (First cut: FIFO, not ELO-banded.)
- **Record run (verified), replay viewer + routing, auth** — see above.
- **Results affordance**: `ServerSession.getMatchResult()` (the `matchResult` msg) → `GameController.
  getMatchResult()` → GameView Results shows "✓ Recorded" + **WATCH REPLAY** (plays the in-memory
  replay via `ReplayView` `preloadReplay`, no fetch).
- **UI redesign (#7) DONE**: Direction A "Steel + Cyan" (user vetoed orange/black) across ALL
  screens. New screens on `ds-*`; the LEGACY Menu/Lobby/Controls are rethemed by overriding
  styles.css tokens in `shell.css` (`--amber`→cyan etc.) — cohesive, no markup rewrite.
- **URL routing DONE**: History path router in `App.tsx`, `vercel.json` SPA rewrite, web `base:'/'`
  / Electron `ELECTRON=1`→`./`.
Only REFINEMENTS left (optional): formal MyRobot/Settings component split (Menu is rethemed, not
yet split); ELO-banded matchmaking; ELO-row replays.

## ⚠️ Still gated on the USER (not code)
- **Set the two Fly secrets** (`DATABASE_URL` + `NEON_AUTH_URL`) — the ONE-liner is up top. Server
  logs still say `[db] DATABASE_URL unset`. Until set: matches play + record but persist as
  anonymous (dropped).
- **One live sign-in to confirm the JWKS path** (`NEON_AUTH_JWKS_URL` if Neon differs from `/jwks`).
- **Vercel**: redeploy the client with `vercel.json` + `VITE_GAME_SERVER_URL` + `VITE_NEON_AUTH_URL`.

## (historical) earlier remaining-work notes
Build all new screens on the `ds-*` system in `shell.css`.
- **REDEPLOY the Fly server** so `/api/*` + server recording go live (`fly deploy` — the running
  image predates them; that's why the board 426'd). Then set `DATABASE_URL` (below) and boards fill.
- **Auth (#4) — BUILT + client-verified.** Neon Auth is Better Auth-based: ONE public client
  var `VITE_NEON_AUTH_URL` (Neon dashboard → Auth tab), SDK `@neondatabase/auth`. Built:
  `src/lib/authClient.ts` (createAuthClient + `getAuthToken()` JWT), `AccountButton`/`AuthPanel`
  (sign in/up + Google, Direction-A styled, in the AppShell `right` slot, env-gated), and the
  JWT flows on `join` (`ClientMsg.authToken` → `lobbyClient` attaches `getAuthToken()`). SERVER:
  `server/auth.ts` verifies the JWT via JWKS (`jose`, `createRemoteJWKSet`) → sets `Client.userId`
  (secure-by-default: bad/absent token ⇒ anonymous ⇒ dropped). Electron-verified the sign-in
  modal renders. **REMAINING for auth to persist end-to-end:** (a) set Fly secret `NEON_AUTH_URL`
  = the SAME public URL (server derives JWKS `${NEON_AUTH_URL}/jwks`) + **redeploy**; (b) confirm
  the real JWKS path + JWT claims against ONE live token (log a decoded token — Neon's path may
  differ from Better Auth's `/jwks` default; adjust `NEON_AUTH_JWKS_URL` if so); (c) the token
  only flows through the multiplayer/custom-room join today, so SOLO records need the record-room
  client flow below.
- **Replay viewer (#6) — DONE.** `src/ui/ReplayView.tsx` re-sims a fetched replay with the live
  `Renderer` (play/pause/restart/seek); Leaderboard record rows with a `replayId` are clickable →
  `/replay/<id>` (deep-linkable). Reachable once boards have entries.
- **URL routing — DONE (user ask).** Tiny History-API path router in `App.tsx` (no dep): every
  screen is a real path (`/leaderboard`, `/my-robot`, `/record`, `/replay/<id>`), back/forward +
  deep-load work (verified over HTTP). WEB build now uses absolute `base:'/'` + **`vercel.json`**
  SPA rewrite; ELECTRON build sets `ELECTRON=1` for relative base (routes by state under file://).
  DEPLOY NOTE: the new `vercel.json` must be picked up on the next Vercel deploy for deep links.
- **Results (#6a)**: the FTC score overlay already shows at `post`; still TODO = a "saved ✓ /
  watch replay" affordance driven by the `matchResult` ServerMsg (surface it via ServerSession).
- **MyRobot / Settings split (#7)**: split `Menu.tsx` into MyRobot (builder, on `ds-*`) + Settings
  (assists/audio/ControlsSection). Rewrite player-facing copy per the netcodeplan.
- **Record/ranked room wiring**: client `join` sends `RoomConfig` (record solo/duo, versus);
  Home "Ranked"/a Record tile create the right room kind. Lobby restyle onto `ds-*`.
- **Matchmaking (#5 remainder)**: in-memory server queue (pair by rating → assign room) +
  protocol (queue/matched) + queue UI. ELO math DONE.
- **Profile screen** (#7): identity + PBs/ELO/replays.
- Keep the FTC bottom-scorebar HUD; migrate GameView chrome onto `ds-*` last.

## ⚠️ GIT: the USER commits, NOT me. I DEPLOY Fly for the user.
- **NEVER `git commit`.** Uncommitted now: `src/config.ts`, `src/sim/replay.ts`, `scripts/smoke.ts`,
  `src/net/protocol.ts`, `server/*` (room, index, api, ranked, persist, db/*), `.env.example`,
  `package.json`/lock (`pg`), `HANDOFF.md`.
- Fly deploy done + verified this session (memory `deploy-for-user`).

## Standing user instructions
- Refresh this HANDOFF at session end. `npm test` after any `src/sim`/`config`/`src/net`/`server`
  change; `npm run build` + `npm run server:check` before "done". `src/sim` stays deterministic.
- Product decisions in CLAUDE.md — do not regress.
