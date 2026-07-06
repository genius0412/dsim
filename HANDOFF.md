# HANDOFF — session ending 2026-07-06 (Netcode Phase 0 + most of Phase 1)

Read `CLAUDE.md` first (load-bearing rules), then this file. The netcode/physics
roadmap is `docs/netcodeplan.md` (source of truth; supersedes the old "Road to
Multiplayer" plan and all prior Phase D notes).

## ✅ Current state: BUILD GREEN · `npm test` = 138 checks ALL PASS · server type-checks · live 2-client + reconnect + delta-wire runs PASS · user-verified live (control feel + smoothness)

## Phase 1 status: reconnection + delta snapshots + deploy artifacts DONE; WebTransport deferred (needs a TLS deploy to validate)

## Phase 0 was LIVE-VERIFIED by the user

Two browsers, localhost server. Findings + fixes this session (all shipped):
- **Local control feel:** initially the non-host robot was jittery. Root cause: the
  server applied "latest command received" each tick instead of each client's command
  FOR THAT TICK, so the client mispredicted and every snapshot yanked it back. Fixed by
  per-tick input buffering on the server (`server/room.ts` `frameCommands`): consume the
  input tagged for the exact tick, hold-last on a brief gap (`HOLD_TICKS`), coast to ZERO
  when stale. Snapshot rate raised to 60 Hz (`SNAPSHOT_INTERVAL = 1`).
- **Remote robot smoothness:** remote robots looked choppy (snapshot stepping). The user
  wanted ZERO added latency, so I used **dead-reckoning extrapolation** (not interpolation):
  `game.ts` `renderRemoteExtrap` draws each remote robot at its estimated PRESENT pose from
  the last snapshot's pos+velocity, with a decaying correction offset (`REMOTE_SMOOTH_TAU_MS`)
  so snapshots don't snap. Zero display latency; brief overshoot on hard cuts is the
  fundamental network limit, not a bug. Tunables: `REMOTE_MAX_EXTRAP_S`, `REMOTE_SMOOTH_TAU_MS`.

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

## Phase 1 progress — DEPLOY ARTIFACTS (Fly.io)

Ready to `fly deploy` (I can't run it — no Fly creds here). See **`docs/deploy.md`**.
- `Dockerfile` (node:22-alpine, `npm ci --omit=dev` ⇒ only react/react-dom/ws/tsx, NOT
  electron/vite), `fly.toml` (port 8080, force_https ⇒ `wss://`, health check, 1 warm
  machine), `.dockerignore`.
- `server/index.ts` now serves **`GET /health` → 200** on the same port (verified) via an
  explicit `http.Server` the WS server mounts on.
- **`ws` + `tsx` moved to `dependencies`** (server runtime needs them; `--omit=dev` still
  excludes electron/vite/typescript). Client (Vercel) build unaffected.
- Client points at the server via `VITE_GAME_SERVER_URL` (already gated); prod = `wss://…`.

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
replay the rest forward through `step()`. Only the local robot is predicted; remote
robots default to ZERO in `step()` and are corrected each snapshot. **`session: null`
⇒ solo path bit-identical** (unchanged). `rematch`/restart call `requestRestart()`.

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
1. **LIVE 2-browser verification on different networks** — start `npm run server`, set
   `VITE_GAME_SERVER_URL=ws://localhost:8787` in `.env`, `npm run dev`, open two tabs,
   same room code, host READY→START. Confirm no freezes, a tab-close degrades cleanly,
   and a throttled client (DevTools) doesn't stall the other. This is the Phase 0 ship
   criterion and the one thing only a real run can prove.
2. **Phase 1 remaining** — reconnection (transient) + delta snapshots + deploy artifacts
   are DONE (above). Still to do: **run `fly deploy`** (needs your Fly account; `docs/deploy.md`
   is step-by-step) + set `VITE_GAME_SERVER_URL=wss://…` on Vercel; **WebTransport** (deferred,
   validate on the TLS deploy); **full-reload reconnect** (localStorage session restore).
3. **Phase 2** — Rapier 2D physics (replace `sim/physics.ts`); only THEN remove the
   `dsin/dcos/datan2` discipline from sim-reachable code (still required elsewhere until then).
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
- Write/refresh this HANDOFF at the END of every session.
- Product decisions in CLAUDE.md — do not regress. Physical models over scripted behavior.
- Run `npm test` after any `src/sim`/`config`/`src/net` change; `npm run build` before "done".
