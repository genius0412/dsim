# HANDOFF — session ending 2026-07-06 (Netcode Phase 0 + Phase 1 SHIPPED LIVE)

Read `CLAUDE.md` first (load-bearing rules), then this file. The netcode/physics
roadmap is `docs/netcodeplan.md` (source of truth; supersedes the old "Road to
Multiplayer" plan and all prior Phase D notes).

## ✅ Current state: BUILD GREEN · `npm test` = 140 checks ALL PASS · server type-checks · **DEPLOYED + user-verified over the internet on Fly**

Multiplayer is live: client (Vite dev / `.env` → `wss://dohun-sim-decode.fly.dev`) ⇄
authoritative Fly game server. User play-tested control feel, remote smoothness, AND
robot-robot collisions over the real deploy — all good.

## Phase 1 status: reconnection + delta snapshots DONE; **server DEPLOYED to Fly**;
WebTransport deferred (needs the TLS deploy to validate); full-reload reconnect + the
Vercel client deploy still open.

## ⚠️ GIT: user commits, NOT me (they were explicit — **never commit yourself**)
The earlier netcode overhaul is committed (in `c7e802e`). THIS session's later changes —
remote-robot prediction (collision fix), server crash-hardening, delta snapshots, deploy
files, new smoke tests — are in the working tree, **uncommitted**, for the user to commit.
Only `fly.toml` differs at the git layer if you diff. Do not run `git commit`.

## Phase 0 was LIVE-VERIFIED by the user

Two browsers, localhost server. Findings + fixes this session (all shipped):
- **Local control feel:** initially the non-host robot was jittery. Root cause: the
  server applied "latest command received" each tick instead of each client's command
  FOR THAT TICK, so the client mispredicted and every snapshot yanked it back. Fixed by
  per-tick input buffering on the server (`server/room.ts` `frameCommands`): consume the
  input tagged for the exact tick, hold-last on a brief gap (`HOLD_TICKS`), coast to ZERO
  when stale. Snapshot rate raised to 60 Hz (`SNAPSHOT_INTERVAL = 1`).
- **Remote robots (smoothness THEN collisions) — landed on FULL PREDICTION:** first pass
  used dead-reckoning extrapolation in the render layer (smooth, zero latency) BUT it
  ignored collisions, so robots visually overlapped when they rammed. A render-time
  separation push was a band-aid the user (correctly) rejected. **Final, correct fix:** the
  client now PREDICTS remote robots in the sim — `stepServer`/`reconcile` feed EVERY robot a
  command via `cmdMap()` (local robot = live input, remotes = their last command from the
  snapshot), so `step()` moves AND collides them exactly like the server. Render straight
  from the predicted world — no extrapolation layer, no separation hack (both deleted).
  Requires the server to send each robot's command: snapshot now carries `cmds: QCommand[]`
  aligned with `w.robots` (server `lastFrame` → `frameCmds`; client holds `remoteCmds`).
  Smoke-verified bit-identical incl. robot-robot collisions. The only residual is the
  irreducible one: a remote's hard reversal mispredicts for ~1 RTT then corrects.

## Phase 1 progress — RECONNECTION (transient drops)

A mid-match socket drop no longer ends that player's game: the server HOLDS the slot for
`RECONNECT_GRACE_MS` (15 s) while the robot coasts to ZERO, and the client auto-reconnects
and reclaims it. Verified headlessly (spawned real server, dropped a client, reclaimed the
same robot slot; bogus rejoin rejected).
- **Transport** (`src/net/transport.ts`): `WebSocketTransport` now auto-reconnects with
  backoff (`onOpen`/`onReopen`/`onDown`/`onFail`; ~20 s budget).
- **Lobby** re-sends `join` on reopen; **`ServerSession`** re-sends `rejoin{room,clientId}`
  on reopen and flips `connected` (HUD "reconnecting" via `status().waitingFor`).
- **Server** (`server/room.ts`): `detach` (lobby ⇒ leave; match ⇒ hold), `reattach`
  (reclaim + immediate resync snapshot + `{t:'rejoined',ok}`), `checkGrace` (finalize-drop
  after the grace). `server/index.ts` routes `rejoin` and adopts the reclaimed clientId.
- **Protocol**: added `rejoin` (client) + `rejoined` (server).
- **LIMITATION**: only transient socket drops (wifi blip, laptop sleep) — a full PAGE
  RELOAD loses the ServerSession/robotId, so it can't rejoin yet. Reload-reconnect needs
  UI-level session restore (localStorage room+clientId, auto-rejoin on load) — future work.

## Phase 1 progress — DELTA SNAPSHOTS (bandwidth)

Snapshots are no longer full-world JSON. Two determinism-safe cuts (`src/net/protocol.ts`
`slimWorld`/`unslimWorld`, used by `server/room.ts` + `src/net/serverSession.ts`):
- **spec-stripped robots**: `robot.spec` is static, so it's dropped on the wire and the
  client re-injects it from `setups` (worldHash ignores spec ⇒ parity intact).
- **ball delta**: every snapshot sends the authoritative ball id ORDER (cheap) but only
  the DATA for balls that CHANGED since the last snapshot; the client rebuilds the array
  in that order from its baseline. Sending the order every frame is what keeps it
  deterministic (array position drives collision/scoring iteration + worldHash).
  Reliable+ordered WebSocket ⇒ no ack needed; a reconnect re-primes with a full keyframe.
Verified: smoke round-trips (slim+unslim hash-identical; ball delta reconstructs exactly,
3/27 balls sent) AND a live 2-client wire test — both clients reconstruct **identical
worldHash every tick (85/85, 0 mismatches)**; avg snapshot ~1.8 KB.

## Phase 1 — DEPLOYED to Fly.io (app `dohun-sim-decode`, region iad)

The server is LIVE at **`wss://dohun-sim-decode.fly.dev`** (`/health` → 200). Deployed via
`fly deploy` (remote builder, ~62 MB image). See **`docs/deploy.md`** (has a beginner
quickstart + a Render.com click-only alternative).
- `Dockerfile` (node:22-alpine, `npm ci --omit=dev` ⇒ only react/react-dom/ws/tsx, NOT
  electron/vite), `fly.toml` (port 8080, force_https ⇒ `wss://`, `/health` check),
  `.dockerignore`. `ws`+`tsx` are runtime `dependencies` now.
- **SCALED TO 1 MACHINE (critical):** room state is in-memory PER MACHINE and Fly
  load-balances each WS connection independently, so ≥2 machines = split-brain (two players
  in the "same" room land on different machines, can't see each other). `fly scale count 1`.
  If you ever `fly deploy` and it recreates 2, scale back to 1.
- **`GET /health` → 200** via an explicit `http.Server` the WS server mounts on; binds
  **`0.0.0.0`** (Fly requirement — a localhost bind is unreachable ⇒ 502).
- Cost: one always-on `shared-cpu-1x`/256 MB ≈ a couple $/mo.
- **STILL OPEN:** the **Vercel client** is the OLD build — to let people play without the
  dev server, set `VITE_GAME_SERVER_URL=wss://dohun-sim-decode.fly.dev` on Vercel + deploy
  the current code there.

## Phase 1 — SERVER CRASH-HARDENING (from a live incident)

The user hit a Fly outage ("app not listening", all robots disconnected) — an unhandled
exception in a timer/socket handler had killed the whole Node process. Hardened so one bad
tick/message/room can never take the process down:
- `server/room.ts` tick loop wrapped in try/catch (logs `[room CODE] tick error …`).
- `server/index.ts` wraps message routing in try/catch; adds `wss`/`httpServer` `error`
  handlers + `process.on('uncaughtException'|'unhandledRejection')` — all LOG, don't exit.
- So if it recurs, `fly logs` now shows the real stack (before, it died silently). If you
  see a repeating tick error there, that's a genuine sim bug to fix at the source.
- Client tolerates an older server missing `snapshot.cmds` (guards `m.cmds ?? []`) so a
  version-skewed deploy degrades instead of crashing.

## WebTransport — DEFERRED (honest status)

The `Transport` seam (`src/net/transport.ts`) is ready for a WebTransport (HTTP/3/QUIC)
impl with WS fallback, but it is intentionally NOT written: WebTransport needs a real TLS
cert + HTTP/3 and can only be exercised against an `https://` deploy (not localhost), so
it must be built + validated ON the deployed Fly instance. Also, the current delta relies
on WebSocket's ordered+reliable delivery (no ack); WebTransport datagrams are unreliable,
so adding it means acking snapshots (`ackInputTick` is plumbed) and keying deltas off the
last ACKed tick. WS is fully playable meanwhile (prediction masks loss). Details in
`docs/deploy.md`.

## This session — executed `docs/netcodeplan.md` **Phase 0**

Replaced the P2P WebRTC-lockstep multiplayer with a **server-authoritative sim +
client-side prediction** (the Rocket League model). This kills the mid-match
disconnects structurally: no head-of-line blocking, one central drop/liveness
authority, no cross-peer float-determinism requirement.

### New: `server/` package (Node + `ws`, run via `tsx`)
- `server/index.ts` — WebSocket accept + room registry (keyed by lowercased room code).
- `server/room.ts` — lobby + authoritative match loop. Imports the **shared `src/sim`**
  (no fork): each tick it ingests the latest `RobotCommand` per robot id, calls
  `step(world, SIM_DT, inputs)`, and broadcasts a full-world `snapshot` every 3 ticks
  (~20 Hz). Host = first joiner. Host `start` builds `RobotSetup[]` from the roster
  (distinct start poses per alliance) + a seed, sets `preCountdown`, broadcasts
  `matchStart{seed,setups,yourRobotId}`. A client leaving mid-match **drops its robot to
  ZERO at the current tick** (broadcast `drop`) — the match never stalls.
- `tsconfig.server.json` + scripts: `npm run server` (tsx watch), `server:start`,
  `server:check` (tsc typecheck — green). Deps added: `ws`, `@types/ws`, `@types/node`.

### Rewired `src/net/`
- `protocol.ts` — **kept** `quantize/dequantize/localizeCommand`; **replaced** lockstep
  binary packets with JSON `ClientMsg` (join/update/start/restart/**input**) +
  `ServerMsg` (welcome/roster/**matchStart**/**snapshot**/drop). `ROOM_CAPACITY` moved here.
- `session.ts` — now the **`NetSession` INTERFACE** (reconcile contract): `sendInput`,
  `takeSnapshot`, `isHost`, `requestRestart()` (no seed — server authors it), `onRestart`,
  `seed`, `setups`, `localRobotId`, `status`, `dispose`. Plus `Snapshot`/`NetStatus`.
- **New** `transport.ts` (`Transport` iface + `WebSocketTransport`; Phase-1 seam for
  WebTransport), `lobbyClient.ts` (thin lobby over the socket), `serverSession.ts`
  (`ServerSession implements NetSession` — takes over the transport at `matchStart`).
- `env.ts` — dropped Supabase + TURN; now just `gameServerConfigured()` / `gameServerUrl()`
  from `VITE_GAME_SERVER_URL`.
- **Deleted**: `mesh.ts`, `lockstep.ts`, `lobby.ts`. `checksum.ts` kept (`worldHash`).

### `game.ts` — `stepNetworked` → `stepServer` (predict + reconcile)
Each sim tick: apply the local command immediately via `step()` on the predicted world,
push `{tick, localizeCommand(cmd)}` into `inputBuf`, and `session.sendInput(tick, cmd)`.
On a snapshot (`reconcile`): `this.world = snapshot.world`, drop inputs `<= serverTick`,
replay the rest forward through `step()`. **(Later corrected — see the FULL PREDICTION
note above:** every robot is now stepped via `cmdMap()`, remotes on their held command, so
their collisions are simulated. The original "remotes default to ZERO" caused overlap.)
**`session: null` ⇒ solo path bit-identical** (unchanged). `rematch`/restart call
`requestRestart()`.

### UI
- `App.tsx` gates MULTIPLAYER on `gameServerConfigured()`.
- `Lobby.tsx` rebuilt on the game-server socket (`WebSocketTransport` + `LobbyClient` →
  `ServerSession` at matchStart). No mesh/presence/ready-mesh gating; server owns the
  roster + host. Same CSS classes, so styling is unchanged.
- `GameView.tsx` untouched — the HUD `net` chip shape (`{waitingFor,desync,peers}`) is
  preserved by `ServerSession.status()`.

### Tests
`scripts/smoke.ts`: removed the lockstep/command-packet blocks; **added** worldHash
JSON-snapshot fidelity, **predict/reconcile parity** (reconcile replay reproduces the
authoritative world exactly), and a **drop-degrades-cleanly** check. A throwaway
end-to-end script (spun up the real WS server + 2 `ws` clients) verified: roster,
host = first joiner, per-client robot ids, same seed, snapshot flow, and a mid-match
drop that keeps the survivor advancing. (Deleted after running.)

## ⚠️ NOT DONE / next steps (in `docs/netcodeplan.md` order)
1. **Vercel client deploy** — set `VITE_GAME_SERVER_URL=wss://dohun-sim-decode.fly.dev` in
   Vercel env + deploy the CURRENT code (Vercel still serves the old pre-netcode build), so
   people can play without the local dev server.
2. **Phase 1 leftovers** — **WebTransport** (deferred, validate on the Fly TLS deploy);
   **full-reload reconnect** (localStorage room+clientId, auto-rejoin on load — the transient
   socket-drop case IS done). Optional: re-tune remote prediction if hard-reversal mispredict
   feels off on high-ping links.
3. **Phase 2** — Rapier 2D physics (replace `sim/physics.ts`); only THEN remove the
   `dsin/dcos/datan2` discipline from sim-reachable code (still required elsewhere until then).
   Clean boundary for a FRESH session.
4. **Phase 3** — Postgres/Clerk, ELO/leaderboards/matchmaking/replays + the UI redesign.

## Gotchas / notes
- **Tick rate is 60 Hz** (`SIM_DT = 1/60`), NOT 120 — CLAUDE.md corrected this session.
- The client predicts on `localizeCommand(cmd)` and the server steps the dequantized
  wire value — keep these identical (don't predict on a raw command).
- `docs/multiplayer.md` is now **STALE** (describes the deleted P2P/Supabase stack) —
  rewrite or delete it when the Phase 0 UI/docs pass lands.
- `@supabase/supabase-js` was removed from `dependencies` (bundle dropped ~accordingly);
  nothing imports it anymore.
- Server uses `Date.now()/Math.random()` freely (it is the single authority — the
  determinism ban applies only to `src/sim`, which stays clean).
- PowerShell 5.1: no `&&`; Bash tool available for POSIX.

## Standing user instructions
- **NEVER commit — the user commits themselves.** (They were explicit after I committed
  once without asking.) Also don't re-assert "it's uncommitted" repeatedly; state git facts
  once, only when relevant.
- Write/refresh this HANDOFF at the END of every session.
- Product decisions in CLAUDE.md — do not regress. Physical models over scripted behavior.
- Run `npm test` after any `src/sim`/`config`/`src/net` change; `npm run build` before "done".
- Fly deploy: `fly` is authed on this machine (`fly deploy` works); keep it at 1 machine.
