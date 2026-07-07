# HANDOFF — session ending 2026-07-07 (Fly auto-stop + Phase 3 backend spine)

Read `CLAUDE.md` first (load-bearing rules), then this. Roadmap = `docs/netcodeplan.md`;
Phase 3 spec = memory `phase3-leaderboards-spec.md`. This session shipped: (1) fixed +
auto-stopped the Fly server, (2) the Phase 3 **replay foundation**, and (3) the entire
Phase 3 **backend spine** (server-side recording, Neon schema + DB layer, ranked ELO,
public read APIs). The remaining Phase 3 work is all CLIENT UI, gated on a design pick.

## ✅ Build: GREEN · `npm test` ALL PASS (~160 checks) · `npm run build` clean · `npm run server:check` clean
## ✅ Fly `dohun-sim-decode`: HEALTHY, auto-stops when idle, REDEPLOYED with the full backend + auth

## 🔑 THE ONLY THING LEFT TO GO LIVE: the user sets TWO Fly secrets (I'm classifier-blocked from
## setting secrets). Everything else is built, deployed, and end-to-end verified.
```
fly secrets set DATABASE_URL='postgresql://…neon.tech/neondb?sslmode=require&channel_binding=require' \
                NEON_AUTH_URL='https://ep-lingering-pine-ahq640vd.neonauth.c-3.us-east-1.aws.neon.tech/neondb/auth' \
                -a dohun-sim-decode
```
Server logs currently show `[db] DATABASE_URL unset` — the value the user put in `.env.example`
never became a Fly secret (that file doesn't reach the server). After setting both: the machine
restarts, auto-migrates the schema, enables persistence + JWT auth. THEN records persist.
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
