# DSIM Multiplayer — Architecture Reference

**Status:** reverse-engineered from the code on branch `alpha`, 2026-09-11. Tree was green
when this was written (`npm test` ALL PASS · `npm run test:mm` 58 checks · `npm run
server:check` clean).

**Method.** Every claim below was read out of the source, not out of `CLAUDE.md`. Where the
two disagree, **the code wins** and the discrepancy is recorded in §13. Claims are labelled:

- **[C]** Confirmed by code — I read the lines cited.
- **[I]** Strong inference — follows from code I read, but not stated outright anywhere.
- **[?]** Unknown — could not be determined without running the deployed system.

**Related docs.** `docs/netcodeplan.md` is the roadmap this was built against.
`docs/lan-selfhost.md` covers the self-host feature. ⚠️ **`docs/multiplayer.md` is STALE** —
it documents the *deleted* WebRTC-mesh / Supabase-lobby / input-delay-lockstep architecture
(`lockstep.ts`, `mesh.ts`, `lobby.ts`), none of which exists any more. Do not read it as
current. See §13.10.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [File map](#2-file-map)
3. [Lifecycle trace](#3-lifecycle-trace)
4. [Network architecture](#4-network-architecture)
5. [State ownership](#5-state-ownership)
6. [Message catalog](#6-message-catalog)
7. [Input trace](#7-input-trace)
8. [Synchronization model](#8-synchronization-model)
9. [Connection lifecycle, disconnect, reconnect, late join](#9-connection-lifecycle)
10. [Timing and clocks](#10-timing-and-clocks)
11. [Serialization](#11-serialization)
12. [Security, validation, errors, races, randomness](#12-security-validation-errors-races-randomness)
13. [⚠️ CLAUDE.md vs the code](#13-claudemd-vs-the-code)
14. [Diagrams](#14-diagrams)
15. [Key abstractions](#15-key-abstractions)
16. [Hidden coupling and the two-game seam](#16-hidden-coupling)
17. [Risks](#17-risks)
18. [Appendix A — Multiplayer Developer Reference](#appendix-a)
19. [Appendix B — Rules a Developer Must Follow](#appendix-b)

---

## 1. Executive summary

DSIM multiplayer is a **server-authoritative, room-per-match architecture** running on
Node + `ws`, deployed as one Fly app across five regions. It is not peer-to-peer, and the
P2P era is genuinely deleted, not merely disabled.

**The single most important fact:** the server runs the *same* deterministic simulation the
client does. There is no fork, no reimplementation, no "server-lite" model.
`server/room.ts:1479` calls `simModuleFor(this.game).step(w, C.SIM_DT, this.lastFrame)` —
the identical `step()` exported from `src/games/sim.ts` that the browser imports. **[C]**

Everything else follows from that:

- **The server owns the `World`.** Clients hold a copy they keep locally consistent by
  prediction, and correct on every snapshot.
- **Clients predict the whole world, but render only their own robot predicted.** The
  prediction loop steps *every* robot forward using commands the server echoed back
  (`src/game.ts:833`, `:884-888`), because robot-robot collisions have to be simulated to
  look right. Remote robots are then *drawn* interpolated ~5 ticks in the past
  (`src/game.ts:952-962`). Balls/particles are drawn straight from the predicted sim, never
  interpolated. **[C]**
- **60 Hz sim, 30 Hz snapshot, 10 Hz HUD**, all three independently confirmed
  (`src/config.ts:2707`, `server/room.ts:97`, `src/ui/GameView.tsx:231`). **[C]**
- **JSON over WebSocket.** No binary encoding, no protobuf. Bandwidth is managed by
  stripping static data and delta-encoding balls, not by a compact wire format. **[C]**
- **The match clock lives in the sim.** `src/sim/match.ts:13-73` advances the phase machine
  inside `step()`, so every peer transitions on the same tick. No wall clock anywhere in the
  match timing path. **[C]**

There are **three** ways a match starts — ranked queue, custom room code, and a friend
challenge — plus a fourth deployment mode (**LAN self-host**) where the authoritative server
is somebody's laptop and also serves the client over plain HTTP.

The system is more careful than its reputation: it has a credential-strip boundary
(`src/net/credentials.ts`), a symmetric LAN policy enforced server-side
(`server/lanMode.ts`), a match-generation guard against stale post-rematch inputs, a
client→server snapshot ack that drives self-healing keyframes, per-recipient roster
redaction during the ranked strategy window, and a build-sha-segregated matchmaker.

It also has **one confirmed production bug** (§17.1) and a handful of real risks.

---

## 2. File map

Grouped by responsibility. Each entry names the export that makes it relevant, not just the
filename.

### 2.1 Wire protocol (shared client + server)

| File | Why it matters |
|---|---|
| `src/net/protocol.ts` (748 L) | The whole wire contract. `ClientMsg` (`:271`) / `ServerMsg` (`:434`) unions · `QCommand` + `quantizeCommand`/`dequantizeCommand` (`:37-88`) · **`localizeCommand` (`:92`)** — the predict-on-this rule · `slimWorld`/`unslimWorld` (`:648`, `:737`) · `encodeBallDelta`/`applyBallDelta` (`:708`, `:725`) · `backfillRobot` (`:673`) old→new skew shim · `CLIENT_CAPS` (`:225`) / `SERVER_CAPS` (`:241`) / `RATED_FORMATS` (`:266`) · `LobbyPlayer` (`:134`) + `PlayerPatch` (`:209`) |
| `src/net/session.ts` | `NetSession` (`:86`) — the *entire* networking surface `GameController` sees. `Snapshot` (`:40`), `NetStatus` (`:51`), `MatchResultInfo` (`:7`). `session: null` ⇒ solo. |

### 2.2 Transport

| File | Why it matters |
|---|---|
| `src/net/transport.ts` | `Transport` interface (`:40`) + `WebSocketTransport` (`:78`). Auto-reconnect (`scheduleReconnect` `:162`), the 8 s black-holed-connect watchdog (`:126-138`), and **the credential strip on every send** (`:185`). Single-listener-per-event by design (`:7-9`) so socket ownership can be handed from `LobbyClient` to `ServerSession`. |
| `src/net/credentials.ts` | `stripCredentials` (`:101`), `trustedFor` (`:68`), `wsOrigin` (`:49`). The rule that a cloud JWT never reaches a LAN box, enforced at the **send boundary** rather than per call site (`:14-24`). |

### 2.3 Server

| File | Why it matters |
|---|---|
| `server/index.ts` (2477 L) | Boot, HTTP, WS upgrade + `fly-replay` routing (`:1772`), the socket message handler (`:2060`), `joinRoom` (`:1907` room creation), admin API (~20 gated endpoints from `:707`), presence, rate limiting (`:2063`). |
| `server/room.ts` (2002 L) | **`Room` (`:282`)** — the authoritative unit. `startLoop` (`:1357`), `stepOnce` (`:1476`), `broadcastSnapshot` (`:1805`), `onInput` (`:875`), `detach`/`reattach`/`checkGrace` (`:673`/`:733`/`:779`), `finalizeMatch` (`:1498`), the ranked staging chain `applyPending`→`enterStrategy`→`beginRanked` (`:1071`→`:1177`→`:1246`). |
| `server/matchmaking.ts` | `Matchmaker` (`:135`), `findMatch` (`:242`), **`groupUnits` (`:493`)**, **`allianceOrder` (`:525`)**, `partyReady` (`:488`), `bucketKey` (`:538`), `enqueue`(sync)/`assign`(async stage) split (`:153`/`:329`). |
| `server/ranked.ts` | `glicko2Update` (`:44`) — full Glicko-2 with an Illinois root-find · `computeGlicko` (`:128`) · `persistVersusMatch` (`:172`). |
| `server/persist.ts` | `persistMatch` (`:46`) — the off-hot-path DB write · `persistDodges` (`:172`) · `persistBehaviour` (`:216`). |
| `server/routing.ts` | `routeTarget` (`:18`) — which machine a socket belongs on. The server half of the region rule. |
| `server/regions.ts` | `bestHost` (`:68`) minimax fair-host pick · `interRegionMs` (`:40`) · `MATCHMAKER_REGION` (`:21`). |
| `server/auth.ts` | `verifyAuthToken` (`:61`) — `jose` JWKS verification. Secure-by-default: bad/absent token ⇒ anonymous. |
| `server/channel.ts` | `roomPersists` (`:38`) — alpha-client results never reach a production DB. |
| `server/standing.ts` / `src/dodge.ts` / `src/standing.ts` | Account standing: `chargeStanding`, `rankedLock`, `creditCleanMatch`. Dodge is a *behaviour* charge, deliberately not a rating charge (`src/dodge.ts:12-18`). |
| `server/moderation.ts` | `scrubName` — hosted name moderation, **fail-open** (`:22-26`). |
| `server/matchTypes.ts` | `PendingMatch` / `PendingRosterEntry` — the cross-region staging payload. |

### 2.4 Client — lobby, session, controller

| File | Why it matters |
|---|---|
| `src/net/lobbyClient.ts` | `LobbyClient` (`:63`). `join` (`:91`), `spectate` (`:104`), `queue` (`:135`), `update` (`:122`), `start` (`:127`). **`on()` REPLACES (`:75-77`)** — load-bearing for queue park/adopt. Re-sends join/queue on `onOpen` *and* `onReopen`. |
| `src/net/serverSession.ts` | `ServerSession` — implements `NetSession`. `sendInput` (`:202`), snapshot ingest + stale guard (`:291-327`), rejoin on reopen (`:155-159`), jitter window (`:317-327`), `status()` quality buckets (`:244-278`). |
| `src/game.ts` (1334 L) | **`GameController`**. `stepServer` (`:786`) predict+send · `reconcile` (`:985`) · `displayWorld` (`:905`) interpolation · `bufferSnapshot` (`:892`) · `cmdMap` (`:884`) · `getHud` (`:1210`) · `handleActionAudio` (`:565`) · `startMatch` (`:1091`) solo seed-reuse rebuild · `rebuildFromNet` (`:1030`). |

### 2.5 Lobby / matchmaking / challenges (UI)

| File | Why it matters |
|---|---|
| `src/ui/Lobby.tsx` | `join(roomCode, hostRegion?)` (`:233`) — **the only production `roomJoinRegion` call site (`:243`)**. Auto-join guard keyed on the room *code*, not a boolean (`:314-322`). |
| `src/ui/Matchmaking.tsx` | `find()` (`:447`), `teardown()`/park (`:139`), `adoptParked()` (`:239`), `joinAssignedMatch()` (`:525`). |
| `src/ui/queueKeeper.ts` | ⚠️ **`src/ui/`, not `src/net/`.** Module singleton parking a live `LobbyClient` across unmounts. `parkQueue`/`takeQueue`/`dropQueue`/**`updateQueue` (`:118`, returns a new object)**. |
| `src/ui/QueueBar.tsx` | Reads the keeper via `useSyncExternalStore` (`:10`) — no duplicated copy. |
| `src/ui/challenge.ts` | `challengeOf` (`:33`) — the single fork between "open a lobby" and "queue under a token". |
| `src/ui/useRoleSwap.ts` | The two-flag role-swap handshake — **no new server message**, it rides `swapReq` on the roster (`:113`, `:89-104`). |
| `src/net/roomRegion.ts` | `roomJoinRegion` (`:32`). A deliberate leaf module (no imports) so headless smoke can test it. |

### 2.6 Identity, persistence, versioning

| File | Why it matters |
|---|---|
| `src/net/sanitize.ts` | **The untrusted-input chokepoint.** `sanitizePlayer` (`:41`, allowlist), `sanitizePlayerPatch` (`:70`, presence-gated), `sanitizeReplay` (`:124`). |
| `src/sim/spawn.ts` | `coerceSpec` (`:159`) — every `RobotSpec` field clamped, idempotent · `coerceSetup` (`:549`) · `coerceAssists` (`:455`) · `createWorld` (`:679`). |
| `src/sim/replay.ts` | `Replay` container (`:57`) · `REPLAY_FORMAT` (`:42`) · `replayRefusal` (`:191`) / `replayPlayable` (`:204`) · `ReplayRecorder` (`:102`) · `verifyReplay` (`:328`). |
| `src/net/version.ts` | `BUILD_ID` (`:7`) + `useNewVersion()` (`:29`) — the `/version.json` poll. |
| `src/net/activeGame.ts` | `ActiveGameRef` — localStorage rejoin hint. Explicitly a hint; the server is authority. |
| `src/net/practiceRuns.ts` | Device-first solo store + `pendingPracticeUploads()` (`:159`) backlog. |
| `server/db/repo.ts` (4042 L) | All SQL. `challengeParty` (`:3949`), `takePendingMatch` (`:2967`, atomic delete-returning), `badgeCols`, `syncStaffRoles` (`:390`). |

### 2.7 LAN self-host (undocumented in CLAUDE.md)

| File | Why it matters |
|---|---|
| `server/lanMode.ts` | `LAN_MODE` (`:48`) + `enforceLanPolicy` (`:83`). Scrubs `DATABASE_URL`/admin/auth env; **`SERVE_CLIENT` without `LAN_MODE` refuses to boot** (`:87-94`). |
| `server/static.ts` | Serves the built client — LAN only. |
| `src/net/lanAdopt.ts` | `adoptLanFromOrigin` (`:27`) — if this page was served by a LAN host, play on it. A `/health` **probe**, not an assumption. |
| `src/net/lanAddress.ts`, `src/net/lanRuns.ts` | Address parsing; host-side match backlog (`MAX_LOCAL_LAN_RUNS` 40). |
| `server/db/migrations/0033_lan_runs.sql` | `lan_runs`, `match_id` UNIQUE — makes the host's upload idempotent. |

### 2.8 Game logic (shared + per-game)

| File | Why it matters |
|---|---|
| `src/games/sim.ts` | **The server-safe registry.** `simModuleFor` (`:21`). Imports only `decode/sim` + `chain/sim`. |
| `src/games/index.ts` | The client registry. Pulls in `CanvasRenderingContext2D` via `module.ts` — see §16.2. |
| `src/sim/world.ts` | `step()` (`:118`) — the DECODE tick. |
| `src/sim/match.ts` | `stepMatch` (`:13`) — the phase machine. `robotsEnabled` (`:76`). |
| `src/games/chain/step.ts` | `chainStep` (`:34`) — the CR tick. |
| `src/net/checksum.ts` | `worldHash` (`:18`) — FNV-1a over load-bearing state. Used by replay + smoke only (see §13.6). |

### 2.9 Tests

| Command | Covers |
|---|---|
| `npm test` (`scripts/smoke.ts`, 17,764 L) | Sim determinism, snapshot round-trip, replay container + versioning, multiplayer replay-vs-authoritative parity (`:12521`), the source-grep determinism guards (`:12217`, `:12236`), untrusted-input fuzz (`:14404`). |
| `npm run test:mm` (`scripts/mmsmoke.ts`) | **58 checks.** Party pairing, closed-party vs premade units, `allianceOrder`, buckets, radius widening, `stagedFor`. Clock-injected, no DB, no sockets. |
| `npm run dbtest` (`scripts/dbtest.ts`) | PGlite + real migrations + real repo. |
| `scripts/loadtest.ts` | N headless clients on the real protocol. Needs real JWTs for the queue path. |

---

## 3. Lifecycle trace

### 3.1 Boot and pre-connection

1. **Version gate.** `BUILD_ID` is injected at build (`vite.config.ts:138`); `/version.json`
   carries the same id (`vite.config.ts:43`). `useNewVersion()` (`src/net/version.ts:29`)
   polls on mount, every 90 s, and on window focus; the flag **latches** (`:13`). The forced
   refresh fires when a player *starts a run*, never mid-run. **[C]**
2. **LAN adoption.** `adoptLanFromOrigin()` (`src/net/lanAdopt.ts:27`) runs before first
   render: `http:` + private host + `/health` answering `"ok"` ⇒ point at this origin. **[C]**
3. **Server capability probe.** `GET /api/presence` returns `caps: SERVER_CAPS`
   (`server/index.ts:1526`, `SERVER_CAPS = ['party']` at `protocol.ts:241`). Rated challenge
   formats stay hidden until the server says it can honour them — because an older server
   *ignores* party fields rather than rejecting them, which would silently match two friends
   against strangers (`protocol.ts:228-239`). **[C]**
4. **Network position.** `probeHome(gameServerHttpUrl())` (`src/net/ping.ts:37`) reads the
   `x-region` header off `/health` and measures RTT. First sample gets a 12 s budget because
   regions auto-stop and the first request routinely *wakes* the machine (`:27-35`). **[C]**
5. **Identity.** Signed-in ⇒ a Neon Auth JWT from `getAuthToken()`. Signed-out ⇒ anonymous;
   ranked refuses (`server/index.ts:2225-2227`), custom rooms and practice do not. **[C]**

### 3.2 Three ways in

**(a) Ranked queue.** `lobby.queue(mode, player, homeRegion, accessMs, …)` over a socket
opened with `?mm=1`, which `routeTarget` (`server/routing.ts:21`) fly-replays to the single
`MATCHMAKER_REGION` — otherwise two halves of a pairing would sit in different pools. **[C]**

**(b) Custom room code.** `Lobby.join(roomCode, hostRegion?)` (`src/ui/Lobby.tsx:233`).
A custom code is **bare** — nothing for the proxy to route on — so the region must be carried
alongside it. `roomJoinRegion(hostRegion, region)` (`:243`) resolves it, and the result goes
into the **socket URL** via `roomServerUrlWith({region})` (`:251`), not into the `join`
message. **[C]**

**(c) Friend challenge.** `challengeOf` (`src/ui/challenge.ts:33`) forks on `RATED_FORMATS`:
casual formats open a joinable room; **rated formats resolve through the matchmaker** under a
party token, because `Room.ranked` is only ever set from a staged `pending_matches` row — so a
code-joined room structurally cannot rate. **[C]**

### 3.3 Matchmaker

`enqueue` (`matchmaking.ts:153`) removes any prior entry for the same **user** (`:161`,
preventing one account holding two slots) then calls `tryMatch` (`:213`) **synchronously**.

`findMatch` (`:242`) is FIFO-anchored, nearest-first, over *units* rather than individuals:
- `groupUnits` (`:493`) collapses a party into one unit at its first member's queue position.
- `partyReady` (`:488`) blocks a half-arrived party — `partySize` 2 is load-bearing, since
  members enqueue seconds apart.
- `partyOnly` (rated1v1) is a **closed pair**: must fill `need` exactly, same bucket, and
  **skips the radius gate** entirely (`:251-260`) because the two chose each other.
- `bucketKey` (`:538`) = `game | channel | build-sha`. Two different builds never share an
  authoritative match.

Staging is **async**: `startMatch` (`:323`) awaits `assign` (`:329`), which picks the fair
host via `bestHost` (`regions.ts:68`), mints a region-coded code `<region>-<mode><n><rand6>`
(`:333`), writes `pending_matches`, then sends `matchAssigned` to each client (`:352`). The
clients drop the matchmaker socket and reconnect to `?room=<code>`, where the prefix routes
them. **[C]**

`allianceOrder` (`:525`) sorts units by descending size so a premade lands on one alliance;
for `rated1v1` the party *is* the two opponents and half=1 splits them correctly (`:512-524`).

### 3.4 Room, roster, strategy window

The host machine claims the staged row with `takePendingMatch` (`repo.ts:2967`) — an **atomic
`delete … returning`**, so exactly one machine builds it (`server/index.ts:1961-1963`). **[C]**

Roster flows over `welcome` → `roster`. For a staged ranked match the room opens a
**pre-match strategy window** (`strategyStart`, `STRATEGY_DURATION_MS` 20 s,
`room.ts:1177`) — but only when **every** member advertises the `strategy` cap, so an old
client is never stranded waiting for a message it cannot render (`protocol.ts:216-224`).
During it the roster is **redacted per recipient**: an opponent's card carries name/team/ELO
only, with `spec`/`assists` neutralized so nobody can counter-pick (`protocol.ts:159-163`,
`room.ts:1903-1944`). The server also strips `alliance` from patches during this window
(`room.ts:831`). **[C]**

### 3.5 Match start

`beginMatch` (`room.ts:1009`) builds the world, bumps `matchGen`, sets `preCountdown`
(`:1022`), and broadcasts `matchStart {seed, setups, yourRobotId, game, ranked, intros, gen,
region}`. Clients mint a `ServerSession` over the **same transport** the lobby used
(`Lobby.tsx:199`) — no reconnection.

The countdown then runs **inside `step()`** (`src/sim/match.ts:17-26`), so pre→auto lands on
the same tick for everyone. **[C]**

### 3.6 The tick

Server, per `setInterval` fire at `1000 * SIM_DT` (`room.ts:1361`):

```
checkGrace()                                     room.ts:1365
bail if empty                                    room.ts:1366
FREEZE if nobody connected (clock pauses)        room.ts:1399-1403
acc += dt, capped at 0.25 s                      room.ts:1407
while (acc >= SIM_DT && n < 8 && !finalized):
    frameCommands(tick+1)                        room.ts:1478
    simModuleFor(game).step(w, SIM_DT, cmds)     room.ts:1479   ← authoritative
    recorder.record(...)                         room.ts:1480
    countParticipation(w)                        room.ts:1481
    due = tick % SNAPSHOT_INTERVAL === 0         room.ts:1482
    if post && time - postSince >= MATCH_SETTLE_S: finalizeMatch()   room.ts:1487-1490
ONE coalesced broadcast per fire                 room.ts:1423
```

`frameCommands` (`:1768`) resolves each robot: exact-tick buffered input → else the last
`latest` while within `HOLD_TICKS` (15) → else `ZERO_CMD`. So a brief input gap coasts on the
last command rather than snapping to neutral. **[C]**

### 3.7 Settle → finalize → persist

`post` is a real sim phase; `MATCH_SETTLE_S` (2.8 s) is the **server's** window on top of it
(`room.ts:1487-1490`), during which `assessMatchEnd` keeps rescoring idempotently as
late-draining balls come to rest (`match.ts:29-38`). **[C]**

`finalizeMatch` (`room.ts:1498`) is idempotent, mints a `matchId`, sends `matchArchive` **to
the host socket alone** (`:1520` — possession of the id is the right to file a LAN match),
broadcasts `matchResult`, then hands off to `persistMatch` (`persist.ts:46`) which gates on
`scored` → `dbEnabled` → ≥1 authed participant → channel. Glicko-2 runs in
`persistVersusMatch` (`ranked.ts:172`); `eloResult`/`recordResult` are broadcast *after* the
async write lands. **[C]**

A player who left mid-match is retained in `departed` (`room.ts:351`, populated by
`checkGrace` `:800-802`) so the match **still rates** — the leaver takes the loss. **[C]**

---

## 4. Network architecture

Confirmed, not assumed:

| Claim | Evidence | Verdict |
|---|---|---|
| Single dedicated Node/`ws` server per room | `Room` owns one `setInterval` loop; rooms live in a `Map` in `server/index.ts` | **[C]** |
| Server-authoritative | `room.ts:1479` is the only `step()` whose output reaches the wire | **[C]** |
| Same shared sim, not a fork | `server/room.ts:6` imports `../src/games/sim` | **[C]** |
| Prediction + reconciliation | `game.ts:786` / `:985` | **[C]** |
| Entity interpolation, not extrapolation | `game.ts:936-962` — lerp between two **past** snapshots | **[C]** |
| JSON over WebSocket | `encodeMsg = JSON.stringify` (`protocol.ts:610`) | **[C]** |
| 60 Hz sim | `C.SIM_DT = 1/60` (`config.ts:2707`) | **[C]** |
| 30 Hz snapshot | `SNAPSHOT_INTERVAL = 2` (`room.ts:97`) | **[C]** |
| 10 Hz HUD | `setInterval(… , 100)` (`GameView.tsx:231`) | **[C]** |
| Multi-region via `fly-replay` | `routeTarget` (`routing.ts:18`) + the raw upgrade-time replay header (`index.ts:1780-1787`) | **[C]** |
| Nothing peer-to-peer remains | No `lockstep.ts`/`mesh.ts`/`lobby.ts`; zero WebRTC/STUN/TURN/Supabase code | **[C]** |

**Who validates input before the sim sees it:** two layers. `sanitizePlayer` /
`sanitizePlayerPatch` (`src/net/sanitize.ts`) clamp everything about a robot at the roster
boundary; `Room.onInput` (`room.ts:875`) validates the per-tick command envelope (generation,
robot ownership, `Number.isSafeInteger(tick)`, lead cap). The command *values* need no
validation because `QCommand` is int8/uint8 and `dequantizeCommand` divides by 127 — the type
is the clamp. **[C]**

**Client requests vs authoritative broadcasts.** Requests: `join`, `rejoin`, `spectate`,
`update`, `start`, `restart`, `rematch`, `input`, `queue`, `expandSearch`, `leaveQueue`,
`report`, `reportScore`, `ping`. Broadcasts/authoritative: `welcome`, `roster`, `matchStart`,
`snapshot`, `drop`, `matchResult`, `matchArchive`, `eloResult`, `recordResult`,
`strategyStart`, `matchAssigned`, `queued`, `spectators`, `rematch`, `dodgeVerdict`,
`standingLock`, `serverNotice`, `error`, `rejoined`, `reported`, `pong`.

---

## 5. State ownership

| State | Lives | Authority | Modified by | Replicated? | How | Notes |
|---|---|---|---|---|---|---|
| `World` (whole) | Both | **Server** | `step()` | Yes | `slimWorld` + ball delta, 30 Hz | Client copy is a prediction, overwritten wholesale on reconcile (`game.ts:998`) |
| `RobotState.pos/vel/heading/angVel` | Both | Server | `solveRobots` (Rapier) | Yes | In `SlimWorld` | Local robot additionally carries a **visual-only** `localSmooth` offset (`game.ts:302`) |
| `RobotState.moduleAngles/Targets` | Both | Server | `updateRobot` | Yes | In `SlimWorld` | Backfilled to `[0,0,0,0]` if an older server omits them (`protocol.ts:683-689`) |
| `RobotState.spec` | Both | Server (via `coerceSpec`) | Roster patch pre-match only | **No** | **Stripped** (`stripSpec` `protocol.ts:641`), re-injected client-side from `matchStart.setups` | Static after `matchStart`; `worldHash` ignores it |
| `world.balls` (artifacts / CR particles) | Both | Server | `solveArtifacts`, goals, CR `updateChain` | Yes | **Delta**: full id `order` every frame, data only for changed (`protocol.ts:636`) | Order is load-bearing — it drives iteration and the hash |
| `world.match.scores` / `ScoreBreakdown` | Both | Server | `assessMatchEnd` etc. | Yes | In `SlimWorld` | Client renders it; never computes the authoritative value |
| `world.match.phase` / `phaseTimeLeft` / `preCountdown` | Both | Server | `stepMatch` inside `step()` | Yes | In `SlimWorld` | **Not** in `worldHash` — see §12.5 |
| `world.rngState` | Both | Server | CR `chain/play.ts:106` only | Yes | In `SlimWorld` | DECODE never advances it at runtime |
| `world.pinnedArtifacts` | Both | Server | `world.ts:464` | Yes | In `SlimWorld` (optional) | Carried tick-to-tick; absent ⇒ `[]` |
| `world.penalties` | Both | Server | `updatePenalties` | Yes | In `SlimWorld` | ⚠️ **No `unslimWorld` backfill** — `types.ts:519-522` |
| `world.events` | Both | Server | `step()` appends | Yes | In `SlimWorld` | Monotonic log; client drains only the new tail (`game.ts:974-983`) |
| `world.gameSettings` | Both | Client-originated | `createWorld` (`spawn.ts:839`) | **Yes (unintentionally)** | Rides `SlimWorld` | See §17.9 |
| `LobbyPlayer` (name/alliance/ready/spec/assists/startPose/startRole/swapReq) | Both | Client-proposed, **server-clamped** | `update` → `sanitizePlayerPatch` | Yes | `roster` broadcast | Presence-gated patch |
| `LobbyPlayer.supporter` / `.role` / `.slot` / `.hidden` | Server | **Server only** | Set at join from the account | Yes | `roster` | Not in `PlayerPatch` (a `Pick`) — a client cannot self-declare |
| `Room.ranked` | Server | Server | `applyPending` from `pending_matches` | Partly | `matchStart.ranked` | **Only** settable from a staged row — the structural rating guarantee |
| `matchGen` | Server | Server | `beginMatch` | Yes | `matchStart.gen`, echoed on `input.gen` | Drops stale post-rematch inputs |
| Host identity | Server | Server | `Room.add` / host reassignment | Yes | `roster.hostId` | `isHost()` is `clientId === hostId` |
| `GameSettings` (player prefs) | Client | Client | Menus | No (per-match) | Synced to Postgres per account out-of-band | Not part of the match protocol |
| Connection quality (rtt/jitter/snapHz) | Client | Client | `serverSession.ts:317-334` | No | — | Purely diagnostic |
| `snapBuf` / `renderTick` / `localSmooth` | Client | Client | `game.ts` | No | — | **Cosmetic only**; never touches `this.world` |
| `inputBuf` | Client | Client | `stepServer` | No | — | Replayed on reconcile, trimmed to acked |
| Practice replay log | Client (device) | **Client (unauthoritative by design)** | `ReplayRecorder` | On upload | `POST /api/practice` | Structurally unreachable from any board (§12.2) |
| LAN match backlog | Client (host device) | Client | `lanRuns.ts` | On upload | `POST /api/lan`, idempotent on `match_id` | Only the host uploads |

---

## 6. Message catalog

`encodeMsg` / `decodeClientMsg` / `decodeServerMsg` are plain `JSON.stringify`/`parse`
(`protocol.ts:610-612`). WebSocket gives **ordered, reliable, exactly-once** delivery, so the
app layer adds no sequencing for ordering — but it *does* add two app-layer guards
(`ack`, `gen`) for reasons ordering cannot solve.

### 6.1 Client → Server (14 variants)

| Msg | Trigger | Payload | Validation | Handler | Notes |
|---|---|---|---|---|---|
| `join` | Entering a room | `{room, player, config?, authToken?, caps?, channel?}` | `sanitizePlayer(player, game)`; JWT verified; `canJoin()` | `index.ts:2090` → `joinRoom` `:1907` | **Ignored if `room` already set** (`:2091`) — one room per socket |
| `rejoin` | Transport reopened mid-match | `{room, clientId}` | `reattach` returns null ⇒ `{rejoined,ok:false}` | `index.ts:2141` | Adopts the client's claimed id as this socket's id |
| `spectate` | Watch Live / admin | `{room, caps?, authToken?}` | Unknown code ⇒ error; capacity capped; **token only sets `hidden` after a server-side admin check** (`:2131-2137`) | `index.ts:2093` | Never counted in roster/capacity/persistence |
| `update` | Roster change | `{patch: PlayerPatch}` | `sanitizePlayerPatch`; `alliance` stripped in strategy; ready re-gated on `activeStartLegal` | `room.ts:824` | Presence-gated — absent keys are no-ops |
| `start` | Host presses start | `{}` | Host-only, `world === null`, `physicsReady()` | `room.ts:850` | Refuses with an error if Rapier WASM isn't up yet |
| `restart` | Old builds' rematch | `{}` | — | `room.ts:861` | **Explicit no-op.** Dead variant kept for back-compat |
| `rematch` | Duo-record vote | `{on}` | — | `room.ts:858` | Toggle; restart only on unanimity |
| `input` | Every tick | `{tick, q: QCommand, ack?, gen?}` | 6 checks, see below | `room.ts:875` | Sent on the **unreliable lane hint** (ignored by WS) |
| `queue` | Ranked search | `{mode, player, authToken?, homeRegion, accessMs, noWiden?, caps?, game?, channel?, build?, party?, partyOnly?, partyFormat?}` | JWT **required**; maintenance; one-live-game; standing lock; `verifyParty` | `index.ts:2218` | |
| `expandSearch` | Impatient player | `{}` | No-op if not queued | `index.ts:2310` | Idempotent |
| `leaveQueue` | Cancel | `{}` | — | `index.ts:2312` | |
| `report` | Report a driver | `{robotId, reason, detail?}` | `isReportReason` enum; room maps robotId→account | `index.ts:2179` | **By robot id, never user id** — the client is never told who opponents are |
| `reportScore` | Misscore claim | `{detail}` | Detail length-clamped | `index.ts:2155` | No target by design |
| `ping` | 300 ms timer | `{ts}` | — | `index.ts:2084` | Echoed verbatim; no server clock involved |

**`onInput` validation order** (`room.ts:875-930`) — every rejection is **silent**:
1. `gen !== matchGen` ⇒ drop (`:879`) — stale post-rematch input
2. `ack` high-water recorded even for dropped/spectating robots (`:882`)
3. Unknown robot or already-`dropped` ⇒ drop (`:884`)
4. `!Number.isSafeInteger(tick) || tick < 0` ⇒ drop (`:899`)
5. `tick - world.tick > MAX_INPUT_LEAD_TICKS` (120) ⇒ drop (`:900`)
6. Buffer future ticks only while a world exists (`:914-928`)

### 6.2 Server → Client (21 variants)

| Msg | Trigger | Payload | Consumer |
|---|---|---|---|
| `welcome` | Socket accepted | `{clientId}` | `LobbyClient:179` |
| `roster` | Any roster change | `{players, hostId}` | `LobbyClient:181` — **redacted per recipient during strategy** |
| `error` | Refusal | `{message, code?}` | `code` is only ever `'region_full'` (`:429-432`); `message` must stay self-sufficient |
| `rejoined` | Reply to `rejoin` | `{ok}` | `ok:false` ⇒ escalate to hard failure (`serverSession.ts:376-383`) |
| `reported` | Reply to `report` | `{ok}` | Always `ok:true`, even for a duplicate — telling them would leak prior reports |
| `dodgeVerdict` | Staged pairing died | `{message, yours, others}` | Sent to the **innocent too**, with `yours: null` |
| `standingLock` | Queue refused | `{until, score, tier}` | Has a clock, so the client counts it down |
| `matchStart` | World authored | `{seed, setups, yourRobotId, game?, ranked?, intros?, gen?, region?}` | Mints `ServerSession`; re-arrival = host restart |
| **`snapshot`** | Every 2 ticks | `{serverTick, w: SlimWorld, balls: BallDelta, cmds: QCommand[], ackInputTick}` | `serverSession.ts:291` |
| `queued` | Queue status | `{mode, size, need}` | Bucket-scoped count |
| `matchAssigned` | Pairing staged | `{mode, room, hostRegion}` | **Drop this socket, reconnect to `?room=`** |
| `strategyStart` | Pre-match window | `{deadline, yourRobotId, mode, intros, game?}` | Gated on the `strategy` cap |
| `drop` | Grace lapsed | `{robotId, tick}` | Informational — snapshots already reflect it |
| `spectators` | Count changed | `{n}` | Edge-triggered, deliberately **off** the 30 Hz path |
| `rematch` | Vote tally | `{votes, need, you}` | |
| `matchResult` | Phase `post` + settle | `{kind, record?, result, replay}` | Results screen + replay |
| **`matchArchive`** | Just before `matchResult` | `{matchId}` | **Host socket ONLY.** Broadcasting it handed the LAN-upload right to everyone (`protocol.ts:558-581`) |
| `eloResult` | After async persist | `{results: EloDelta[]}` | Ranked only |
| `recordResult` | After async persist | `{info}` | Record runs only |
| `serverNotice` | Admin broadcast | `{kind, message, until?}` | `setServerNotice` — no handler needed |
| `pong` | Reply to `ping` | `{ts}` | RTT = now − ts |

### 6.3 Duplicates and reordering

At the app layer, over WebSocket: **not possible for ordering**, and duplicates only arise
across a reconnect. What the code guards anyway:

- `snapshot` carries a **stale guard** (`serverSession.ts:297`: `serverTick <= appliedTick`
  ⇒ ignore). A no-op on WS; required for the planned QUIC-datagram lane. **[C]**
- `input.gen` guards a genuinely real hazard ordering cannot: a rematch rebuilds at tick 0,
  so inputs still in flight from the *old* match carry tick numbers the new one will reach
  minutes later. Without the generation they'd be buffered and applied as if current
  (`protocol.ts:336-340`). **[C]**
- `input.ack` lets the server detect a client whose *confirmed* baseline has fallen too far
  behind and force a keyframe (`ACK_STALE_TICKS` 240, `room.ts:141`, `:1853-1854`). **[C]**
- `join`/`queue` are re-sent on every reopen (`lobbyClient.ts:98-99`), so duplicates are
  expected and made idempotent by the "ignored if `room` already set" rule. **[C]**

---

## 7. Input trace

### 7.1 Keyboard/gamepad → wire

```
src/input/bindings.ts  →  RobotCommand {driveX, driveY, rotate, leftDrive, rightDrive,
                                        intake, fire, catalyst?, fling?, driveMode?}
                              (src/types.ts:20-39)
GameController.stepServer(cmd)                                    game.ts:786
  ├─ local = localizeCommand(cmd)        = dequantize(quantize(c))  protocol.ts:92
  ├─ session.sendInput(tick, cmd)   ──►  quantizeCommand → {t:'input', tick, q, ack, gen}
  ├─ inputBuf.push({tick, cmd: local})
  └─ mod.step(world, SIM_DT, cmdMap(local))       ← predict on the LOCALIZED command
```

**The `localizeCommand` rule is the whole of wire-level determinism.** The client must predict
on exactly what the server will decode, or every tick mispredicts by a rounding error. Note it
is applied in **solo too** (`game.ts:765`), so a recorded practice run replays bit-exact. **[C]**

Only three optional bits exist on the wire beyond the DECODE set: `BTN_CATALYST` (4),
`BTN_FLING` (8) — both CR — and `BTN_DRIVEMODE` (16), butterfly, shared
(`protocol.ts:49-57`). So CR costs **two bits**, not a protocol fork. **[C]**

### 7.2 A DECODE shot

DECODE's shooter is **exactly deterministic and never misses**: `fire()`
(`src/sim/robot.ts:658-740`) uses `aimSolution(r)` for the minimum-speed trajectory, builds
velocity with `dcos`/`dsin` (`:714-715`), and contains **no RNG of any kind** — no dispersion,
no jitter. The turret snaps to the solution with no slew limit. **[C]**

Consequence for netcode: a shot needs **no special prediction handling**. The client predicts
`fire()` identically to the server because the function is a pure closed-form solve over state
both sides already agree on. The flight ball appears in the next snapshot's ball delta and the
client's prediction already had it. **[C]**

### 7.3 A Chain Reaction shot

Materially different, and the difference matters:

- **Turret archetypes** slew at `CHAIN_TURRET_SLEW` — the turret *cannot snap*, so a sudden
  velocity change (a shove) makes the lead solution jump faster than the turret follows, and
  shots fired mid-correction **genuinely miss**. Aim is physical state, not a promise. **[C]**
- **Turretless archetypes** (drum/dumper) aim by turning the chassis. `chainAimAssist`
  (`chain/play.ts:632-639`) runs in `chainStep` **before** the drivetrain model
  (`chain/step.ts:46-47`) and **overwrites `cmd.rotate`**.

The netcode consequence is subtle but benign: the command reaching `updateRobot` is *not* the
one on the wire. Prediction still holds, because the override is a deterministic function of
(wire command, world state) that both sides compute identically. And critically, the **recorded**
command is the pre-override one (`chain/step.ts:48`), matching what the recorder logs — so
replay reproduces the same override. **[C]**

CR *does* have real RNG in the shot path — drum lateral pick and cadence jitter
(`chain/play.ts:244`, `:247`), accelerator re-eject (`:388-392`), catapult fling variance
(`:873-874`). All seeded off `world.rngState` (`:104-108`), which advances inside `step()` and
rides every snapshot. **Dumper scatter is *not* RNG** — it comes from `sideVar` scaling speed
by each ball's lateral position (`:692`). **[C]**

### 7.4 Drivetrain movement and mispredict

The client predicts velocity and heading locally every tick (`game.ts:874`). On reconcile
(`:985`):

```
renderedPre = predicted + localSmooth                  :993-996
this.world  = snap.world                               :998   ← hard swap
inputBuf    = inputBuf.filter(b => b.tick > serverTick) :1002  ← drop acked
replay each remaining buffered input through step()    :1009-1011
localSmooth = renderedPre − post                       :1013
if hypot(dx,dy) > SMOOTH_MAX_DIST (16 in): localSmooth = 0   :1020-1024  ← SNAP
```

So a **small** mispredict is eased away over ~200 ms (`SMOOTH_HALFLIFE` 0.06 s, decayed
frame-rate-independently at `:693-697`) and never moves `this.world`; a **large** one snaps,
because that is a real divergence rather than jitter. **[C]**

Prediction is bounded: `MAX_PREDICT_LEAD` 40 ticks (~667 ms). Past it the local robot
**pauses** (`:866-869`) rather than building an input buffer whose reconcile would replay
hundreds of steps in one synchronous hitch. **[C]**

### 7.5 Gate and intake

Both are **pure sim consequences of contact**, not messages. The client runs the identical
`updateGates` (`goal.ts:1568`) and intake code in its prediction, so it sees the gate lift and
the ball get captured at the same tick the server does — subject to correction on the next
snapshot like everything else. There is no "gate opened" event on the wire. **[C]**

`gateColliderPos` (`goal.ts:175`) is the one-tick *anticipation* that retracts the handle
collider on the same tick a robot rams it; it runs identically on both sides because it is a
function of world state and the frame's commands. **[C]**

**Audio is the exception, and it is deliberately outside the sim.**
`GameController.handleActionAudio` (`game.ts:565`) edge-detects on world state — `lastFireAt`,
`lastIntakeAt`, CR beam ride, per-alliance `gateOpen` — for **every** robot, so remote actions
are audible. The sim core emits no audio events. ⚠️ It runs inside `frameLogic` *after*
reconcile, and unlike the toast path (de-duped via `shownEventCount`, `:974-983`) the SFX
edges are **not** de-duped — a replayed prediction that re-crosses an edge can re-cue. See
§17.6. **[C]**

---

## 8. Synchronization model

### 8.1 What is sent

Delta snapshots, confirmed (`protocol.ts:614-653`, `room.ts:1805-1868`):

1. **Robot `spec` is stripped** (`stripSpec` `:641`) — static after `matchStart`, re-injected
   client-side from `setups` via `unslimWorld(…, specById)` (`:737`). `worldHash` ignores
   spec, so parity is unaffected. **[C]**
2. **Balls are delta'd**: the full id `order` ships **every frame** (a few dozen ints — or
   ~300 for CR), but data only for balls that changed. Array position drives collision and
   scoring iteration *and* the hash, so the order must match exactly (`:626-628`). **[C]**

⚠️ The production encoder is **not** `encodeBallDelta`. `Room.broadcastSnapshot`
(`room.ts:1809-1813`) hand-rolls the same diff so it can do a shared-prefix encode-once
optimisation (`:1826-1840`) where the per-client tail is only `ackInputTick`. The tested codec
is used by `smoke.ts` and `costprobe.ts` only. See §17.4. **[C]**

### 8.2 What is predicted, interpolated, and snapped

This is the part most often described loosely. Precisely:

| Entity | Simulated forward on the client? | Rendered from | Evidence |
|---|---|---|---|
| **Local robot** | Yes | **Prediction** + cosmetic `localSmooth` | `game.ts:906-911`, `:953` |
| **Remote robots** | **Yes** — stepped with their held commands | **Interpolation** between two past snapshots | `game.ts:833`, `:884-888`, `:952-962` |
| **Balls / CR particles** | Yes | **Prediction, snapped** — never lerped | `game.ts:948-951` |

Remote robots are simulated because their **collisions** must be real: if they were only
lerped at render time, the local robot would drive through them in the predicted world.
`Snapshot.cmds` exists precisely to carry each robot's command for this
(`src/net/session.ts:44-46`). "Only the local robot is predicted" is therefore an
oversimplification — only the local robot is *rendered* predicted. **[C]**

Balls are excluded from interpolation for a stated, correct reason: they spawn and despawn on
launches and they collide, so lerping ghosts a freshly-spawned ball between its predicted and
past positions and blends colliding balls *through* each other (`game.ts:948-951`). **[C]**

### 8.3 The render clock

`renderTick` (`game.ts:320`, `:926-931`) advances at real-time rate, then eases toward
`latest − INTERP_DELAY_TICKS` (5 ticks ≈ 83 ms) on a **half-life** (`INTERP_EASE_HALFLIFE`
0.11 s), then clamps to `[oldest, latest]`. The half-life form is deliberate: the previous
per-frame `* 0.1` converged at a rate scaled by FPS, so 144 Hz players chased jitter and saw
*more* remote stutter than 60 Hz players on the identical connection (`:919-925`). **[C]**

`snapBuf` holds `INTERP_BUFFER` (8) snapshots of **poses only**, captured *before* reconcile
mutates the snapshot world (`:892-899`). **[C]**

### 8.4 Checksums, rollback, sequence numbers

- **Checksums: present but not used for netcode.** `worldHash` (`src/net/checksum.ts:18`)
  exists and its doc comment still describes peers exchanging `{tick, hash}` — that is
  **stale prose from the deleted lockstep era**. No peer exchange exists. Its only live
  consumers are `src/sim/replay.ts:338` and `scripts/smoke.ts`. **[C]**
- **Rollback: none.** Reconcile is snap-and-replay, not rollback-and-resimulate-others.
- **Sequence numbers on snapshots: none** — `serverTick` doubles as ordering, and WS is
  ordered anyway. But **the app does add `ack` and `gen`** (§6.3), which CLAUDE.md does not
  mention. **[C]**

---

## 9. Connection lifecycle

### 9.1 States

```
                 ┌──────────────┐
   new WebSocket │  connecting  │──── 8 s watchdog ──┐
                 └──────┬───────┘                    │ (neither open nor close)
                   onopen│                           ▼
                 ┌──────▼───────┐            scheduleReconnect()
                 │ open (first) │◄───────────────────┤
                 └──────┬───────┘                    │
             join/queue │                            │
                 ┌──────▼───────┐                    │
                 │  roster'd    │                    │
                 └──────┬───────┘                    │
            matchStart  │                            │
                 ┌──────▼───────┐   onclose          │
                 │  in-match    ├────────────────────┤
                 └──────┬───────┘                    │
                        │            ┌───────────────┴──────────┐
                        │            │ down: server holds slot  │
                        │            │ RECONNECT_GRACE_MS = 45s │
                        │            └───────────────┬──────────┘
                        │           onreopen → rejoin│
                 ┌──────▼───────┐◄───────────────────┘
                 │  reattached  │   (full keyframe follows)
                 └──────────────┘
                        │  40 attempts exhausted (~48 s)  OR  rejoined{ok:false}
                 ┌──────▼───────┐
                 │   failed     │  HUD: "Connection lost / refresh"
                 └──────────────┘
```

### 9.2 Client side

`WebSocketTransport` (`transport.ts:78`): `MAX_RECONNECT_ATTEMPTS` 40 at
`RECONNECT_DELAY_MS` 1000 + `RECONNECT_JITTER_MS` 0-400 ⇒ **~48 s**, deliberately sized to
outlast the server's 45 s grace (`:58-62`). The jitter is anti-thundering-herd: every client
in a room drops at the same instant on a deploy or a Fly autostop, and an unjittered delay
marched them all back in lockstep onto a still-cold-booting machine (`:64-68`). **[C]**

⚠️ It is a **flat delay**, not exponential backoff, despite the file header saying "fixed
backoff" (`:12`). **[C]**

The 8 s `CONNECT_TIMEOUT_MS` watchdog (`:126-138`) exists because a WebSocket to a black-holed
host fires **neither** `onopen` nor `onclose` — the browser sits on the OS TCP timeout (75 s+),
so without it the retry loop stalls on attempt one. **[C]**

### 9.3 Server side

- `detach(id, conn?)` (`room.ts:673`) — has a **stale-socket guard** (`:688`: `conn !== c.conn`
  ⇒ ignore), so a late close event from a superseded socket cannot evict the live one. In the
  lobby it deletes the client and reassigns host; **during the strategy phase it cancels the
  staged match with a `'bail'` dodge** (`:694-703`); mid-match it only marks
  `connected = false` and stamps `disconnectAt`. **[C]**
- `reattach(id, send, sendRaw, backlog)` (`room.ts:733`) — replaces **all three** senders
  (`:742-754` records that missing `sendRaw` left a reattached client on a dead closure),
  bumps `conn`, clears `snapPrimed`/`snapAck`, sends `welcome` + `rejoined`, then a **full
  keyframe** via `sendSnapshotTo` (`:1871`). **[C]**
- `checkGrace()` (`room.ts:779`) — hot-path early-out with no allocation unless somebody is
  down (`:783-789`). Past 45 s: broadcast `drop`, record `departed`, release the one-live-game
  lock, delete the client, and `onEmpty()` if the room is now empty. **[C]**

### 9.4 Does the reconnecting player's robot survive?

**Yes, untouched.** The robot stays in `world.robots` for the whole grace window; it simply
receives `ZERO_CMD` once `HOLD_TICKS` (15) elapses past its last input (`frameCommands`
`room.ts:1768-1793`). It coasts and is shoved like any other body. Nothing resets its pose,
score contribution, or hopper. On reattach it resumes from exactly where the sim has it. **[C]**

### 9.5 "Server unreachable" vs a normal drop

**There is no protocol-level distinction** — both take `downCb → scheduleReconnect`. The only
difference is positional: an unreachable server never fires `openCb`, so `opened` stays false
and `reopenCb` never runs. Consumers distinguish by where they are in the state machine:

- `LobbyClient` maps **only `onFail`** to `closed` (`lobbyClient.ts:72`), so a transient drop
  is invisible in the lobby and "Lost connection" appears only after the full ~48 s budget.
- `ServerSession` maps `onDown` → `waitingFor: 'server'` (HUD "Reconnecting… Your run keeps
  going") and `onFail` → `failed` (HUD "Connection lost / REFRESH"). **[C]**
- A **refused rejoin** (`rejoined {ok:false}`) is escalated to `failed` manually
  (`serverSession.ts:376-383`) so the player doesn't spin on "reconnecting" for a match that
  no longer exists. **[C]**

Fly's auto-stop-when-idle is handled on the *pre-connection* side instead: `probeHome` gives
the first sample a 12 s budget because it is routinely the request that wakes the machine
(`ping.ts:27-35`), and `fly.toml` keeps `min_machines_running = 1` in the matchmaker region.

### 9.6 Late joining

**Structurally impossible once a match starts.** `canJoin()` (`room.ts:452-458`) requires:

```ts
this.clients.size < roomCapacity(this.config) && this.world === null && this.phase !== 'strategy'
```

`world === null` is true only before `beginMatch`. There is no code path that adds a *driver*
to a live room. **[C]**

The only mid-match arrivals are:
- **`rejoin`** — reclaiming an existing slot within grace. Not a new player.
- **`spectate`** — added to a separate `spectators` map (`room.ts:516`), never counted toward
  capacity, roster, or persistence. A spectator receives the current `matchStart` and then the
  identical snapshot stream drivers get (`room.ts:1866`), with `yourRobotId: -1`. Its
  `GameController` runs the spectator branch (`game.ts:840-853`): steps the world using only
  the held remote commands, no input buffer, nothing sent. **[C]**

---

## 10. Timing and clocks

| Clock | Rate | Owner | Evidence |
|---|---|---|---|
| Sim step | 60 Hz fixed (`SIM_DT` = 1/60) | Server (authoritative) + client (prediction) | `config.ts:2707` |
| Snapshot broadcast | 30 Hz (`SNAPSHOT_INTERVAL = 2`) | Server | `room.ts:97`, `:1482` |
| HUD poll | 10 Hz | Client | `GameView.tsx:231` |
| Render | rAF (display rate) | Client | `game.ts:687` |
| Multiplayer sim driver | `setInterval`, **not rAF** | Client | `game.ts:393-397` |
| Ping probe | ~3.3 Hz (300 ms) | Client | `serverSession.ts:37` |
| Render clock lag | `INTERP_DELAY_TICKS` 5 (~83 ms) | Client | `game.ts:50` |
| Reconnect retry | 1000 + rand(400) ms ×40 | Client | `transport.ts:57-69` |
| Reconnect grace | 45 s | Server | `room.ts:168` |
| Ranked join grace | 20 s | Server | `room.ts:171` |
| Strategy window | 20 s | Server | `room.ts:176` |
| Settle window | `MATCH_SETTLE_S` 2.8 s | Server | `config.ts:30,35` |

**Which clock is authoritative for the match phase: the server's tick count, via the sim.**
`stepMatch` (`src/sim/match.ts:13`) decrements `phaseTimeLeft` by `dt` inside `step()`. No
wall clock touches match timing on either side. **[C]**

⚠️ The multiplayer sim runs on `setInterval`, not rAF, plus `audio.startKeepAlive()`
(`game.ts:393-397`) — a backgrounded tab must keep feeding inputs or its robot coasts to
`ZERO_CMD` after 15 ticks. **[C]**

⚠️ **The server freezes the clock when nobody is connected** (`room.ts:1399-1403`): it resets
the accumulator and returns, so the match pauses rather than fast-forwarding when everyone has
dropped. `checkGrace` deliberately keeps running on the *wall* clock through that freeze
(`:1397`), so the grace still expires. **[C]**

**Jitter, not RTT, drives the quality indicator** — partly. `status()`
(`serverSession.ts:244-278`) buckets on **both**: `good` iff `rtt < 90 && jitter < 12`;
`fair` iff `rtt < 180 && jitter < 28`; else `poor`. Disconnected ⇒ always `poor`. So jitter is
a co-equal gate, not the sole one. The jitter window discards gaps ≥ 1000 ms so a backgrounded
tab or a reconnect keyframe cannot poison the estimate (`:317-327`). **[C]**

---

## 11. Serialization

**Format:** JSON, `JSON.stringify`/`JSON.parse` (`protocol.ts:610-612`). No binary path.

**Quantization** (`protocol.ts:37-88`): `dx`/`dy`/`rot` → int8 (`×127`, rounded);
`buttons` → uint8 bitfield; `ld`/`rd` optional int8 for tank/butterfly. Purpose is *not*
primarily bandwidth — it is **reconcile bit-matching**: the client must predict on what the
server will decode, hence `localizeCommand` (`:92`). **[C]**

**Snapshot shaping:** `slimWorld` strips balls and robot specs; `unslimWorld` re-injects specs
by id and runs `backfillRobot` (`:673`) to re-seed dynamic fields an older server omitted —
without it `POWER_DRAW_FLYWHEEL_HOLD * undefined` NaNs the robot's position and it renders at
the field centre, frozen (`:661-672`). **[C]**

**Replay container** (`src/sim/replay.ts:57`):
```
{format, balanceVersion, sim?, game?, mode, seed, ticks, setups: RobotSetup[], tracks}
```
`tracks` are flat `number[]`, hold-last compressed at `trackStride(format)` (7 for format 2,
5 for format 1). `packKey` uses **multiplication, not bit shifts** (`:88-91`) because six
bytes is 48 bits and JS bitwise truncates to 32 — the earlier version folded `ld`/`rd` out of
the key, so a tank robot recorded exactly one entry. **[C]**

**Which fields gate playability** (`replayRefusal` `:191-201`):
```
format > REPLAY_FORMAT          → 'future'      (they're behind; refresh)
balanceVersion !== build        → 'balance'     (robots perform differently now)
(r.sim ?? 0) !== simVersion      → 'behaviour', or 'unstamped' if r.sim === undefined
format < 2 && any tank/butterfly → 'tank'        (format 1 had nowhere to store the axes)
else                             → null
```
`unstamped` is a **message-only** distinction — the policy stays exactly
`(r.sim ?? 0) !== simVersion` (`:185-189`). Cosmetic-only fields: `game` (absent ⇒ DECODE),
`mode`. **`balanceVersion` is NOT the season** — in the `replays` table the season is the
`balance_version` column and the recording build's `BALANCE_VERSION` lives in `sim_version`
(migrations `0012_replay_sim_version.sql`, `0031_replay_behaviour_version.sql`). **[C]**

---

## 12. Security, validation, errors, races, randomness

### 12.1 The sanitizing chokepoint

`coerceSpec` (`src/sim/spawn.ts:159`) clamps **every** `RobotSpec` field — I verified the full
table against the interface; nothing is unhandled. `clampFinite` (`:150`) tests
`Number.isFinite` *before* clamping, so `NaN`/`Infinity`/strings/objects all fall to the
fallback rather than through `clamp`. The order is deliberate and mirrors the builder's
dependency graph: intake+drivetrain → size → rpm → inertia → mass (`:163-170`). It is
**idempotent**, and `smoke.ts:14404` fuzzes 900 specs across both games asserting every range
*and* `coerceSpec(coerceSpec(x)) === coerceSpec(x)`. **[C]**

It runs at three points: settings load, **server ingress** (`sanitize.ts:43`), and
`createWorld`. `chassisColor` is an **allowlist** key, never a free colour string (`:264-266`);
`smoke.ts:487` asserts `url(javascript:x)` is rejected. **[C]**

`sanitizePlayer` (`sanitize.ts:41`) is a true **allowlist** — a fresh object built field by
field, 12 keys. `clientId` is never read from the wire, and neither are `slot`, `hidden`,
`supporter`, or `role`. `PlayerPatch` is a `Pick` (`protocol.ts:209`) omitting all four. **A
client cannot self-declare a supporter badge or a staff role.** **[C]**

### 12.2 Practice replays

`sanitizeReplay` (`sanitize.ts:124`) bounds format, mode, seed, `ticks ≤ maxMatchTicks()+1`,
1–4 setups with unique ids 0–3, each through `coerceSetup`, and every track keyed to a real id
at the container's stride with finite elements. It **deliberately does not verify the score**
(`:113-119`).

That is safe because the isolation is **structural, not conventional**: `practice_runs`
(migration `0032`) is its own table and `record_leaderboard` is a view over `records`. Nothing
written there is reachable from any board, PB, rank, or ELO query. It is also self-policing
where it is shown — the viewer **re-simulates the log**, so a lying score contradicts itself
on screen. **[C]**

⚠️ The one client-reported write that *does* land is `user_activity` (playtime/games), bounded
to one match of ticks per POST (`api.ts:524`). The code says outright that nothing competitive
may ever read it (`api.ts:516-522`). **[C]**

### 12.3 Party tokens

`verifyParty` (`server/index.ts:223-241`) → `challengeParty` (`repo.ts:3949-3963`), which
selects from `room_invites` where `room = token AND format = $3 AND created_at > now() -
INVITE_TTL_S AND (from_user_id = caller OR to_user_id = caller)`.

So: the token must exist, match the **claimed format**, be fresh, and **name the caller**. It
returns the pair, so a third guesser cannot join. The server also rejects a format/mode
mismatch (`index.ts:233`).

**A bad token is REFUSED, never downgraded.** `index.ts:2241-2246` sends an explicit error and
returns. There is **no fallback to the open queue** anywhere on this path — I checked for one
specifically, because a silent downgrade would match two friends against strangers for
rating. **[C]**

Rated friend games remain farmable by a colluding pair, deliberately unmitigated (as
chess.com). **[C]**

### 12.4 Admin

**The server re-checks independently, per request.** `ADMIN_IDS` is a `Set` built once
(`index.ts:248-252`) and `isAdmin` is recomputed **per request** at `:720-723` from that
request's own `Authorization: Bearer` token via `verifyAuthToken`. Every one of ~20 admin
endpoints gates on it (some also accepting `ADMIN_SECRET` for curl). `Admin.tsx` has **no
gate of its own** — it is gated at `App.tsx:1442` purely for UI, and that gate is cosmetic.
**[C]**

Even the hidden-spectator flag is server-decided: the client sends a token, and `hidden` is
set only after an independent `verifyAuthToken` + `ADMIN_IDS.has` (`index.ts:2131-2137`). A
client cannot claim it. **[C]**

`OWNER_ID` gates **nothing** — it is used at exactly one site, `syncStaffRoles`
(`index.ts:2389`). Owner is a badge, not a permission. **[C]**

### 12.5 Determinism and randomness

Verified by grep across `src/sim/` and `src/games/`:
- **`Math.random`: zero hits.** The only mention is a comment (`physics.ts:1086`).
- **`Date.now` / `new Date` / `performance.now`: one hit**, and it is render-only —
  `src/games/chain/drawRobot.ts:32`.
- **Bare `Math.sin/cos/atan2/hypot`: 13 hits, all in CR *render* files**
  (`drawRobot.ts`, `draw.ts`, `RobotPreview.tsx`). Zero in `src/sim/`.
- **`session` in sim code: zero hits.** Every apparent match is a substring of
  **`possession`**. The sim is genuinely network-blind. **[C]**

`smoke.ts` enforces the first three as **source greps** (`:12217` banned-Math, `:12236` wall
clock) — with a documented incident behind them: six `Math.hypot` calls had drifted into
drivetrain/field/physics/CR-penalties, one inside `motorStep`, and swapping them measurably
moved a match score. **[C]**

**`world.rngState` is the only shared randomness**, seeded mulberry32 (`math.ts:174`). It is
mixed into `worldHash` immediately after `tick` (`checksum.ts:26-27`). Advancement:
- `createWorld` once, for the motif (`spawn.ts:680-681`, final state at `:805`)
- CR spawn, for staged-particle scatter (`chain/spawn.ts:158-162`)
- **CR `step()` — the only per-tick advance in the entire sim** (`chain/play.ts:104-108`)

**DECODE's `step()` never advances it.** There is zero runtime RNG in DECODE: the gate is fully
deterministic (`goal.ts:1568-1796`), the shooter has no dispersion, and the coincident-artifact
kick is a **hash of ids + tick** (`physics.ts:1109-1110`), not the PRNG. **[C]**

Because server and client both advance it *inside the same `step()`*, it cannot drift
independently — and any drift would be caught on the next reconcile, which replaces the world
wholesale. **[C]**

**Solo Practice seed reuse:** `startMatch` (`game.ts:1091-1103`) rebuilds the world with
`makeWorld(false)` — **reseed = false** — so the field and motif do not change under the
player, and the run begins at tick 0 of a world `ReplayPlayer` can reconstruct from
`{seed, setups}` alone. Confirmed, and `smoke.ts:11346-11348` pins the inverse: a
*controller-started* run does **not** reproduce. **[C]**

CR's RNG-driven mechanics are covered by replay round-trip tests including a
`JSON.parse(JSON.stringify(...))` trip, and `smoke.ts:12381-12388` additionally asserts a CR
replay's re-sim **differs** from a DECODE re-sim of the same seed — proving the module comes
from `replay.game` rather than a hardcode. **[C]**

### 12.6 Error handling

**Server inbound is double-guarded** (`index.ts:2060-2083`): rate limit *before* `String(data)`
and parse; `decodeClientMsg` in a try/catch that silently ignores malformed frames
(`:2077-2080`); then the whole dispatch in a second try/catch so one bad message cannot take
down the process and every other room (`:2083`). **[C]**

⚠️ **Client inbound is not guarded at all.** `decodeServerMsg` is a bare `JSON.parse`
(`protocol.ts:612`), called from `LobbyClient.onMessage` (`:178`) and `ServerSession`, and
`transport.ts:139-141` invokes `messageCb` with no try/catch. A malformed or truncated frame
throws inside the `onmessage` handler; the socket stays open and the client silently misses
that message. See §17.5. **[C]**

Silent failures worth knowing about:
- Every `onInput` rejection is silent — no error is ever returned for a bad input.
- `Room.onMessage` early-returns on `if (!c) return` (`room.ts:822`), which is what silently
  drops **every spectator message** (spectators live in a separate map).
- `transport.send` silently drops when the socket isn't OPEN (`:180`).
- A synchronous `new WebSocket()` throw goes straight to `scheduleReconnect` **without firing
  `onDown`** (`:115-120`), so the UI never learns it is down for that attempt. **[C]**

### 12.7 Race conditions

**Room creation.** The registry slot is claimed **synchronously before any `await`**
(`index.ts:1907-1919`), with a `created` flag and an `abandon()` that hands it back on every
early return (`:1940-1942`). Two simultaneous joins for one code cannot both create. **[C]**

**Staged-match claim.** `takePendingMatch` is an atomic `delete … returning`
(`repo.ts:2967`), so exactly one machine ever builds a staged match even if both players'
sockets land on different candidates. **[C]**

**Enqueue sync / stage async.** `enqueue` matches **synchronously** (`tryMatch` `:213`) but
`startMatch` awaits `assign` (`:323`). The real-world race this protects against: two players
enqueueing microseconds apart must not both be considered "the first waiter". Matching
synchronously makes the pairing decision atomic within the event loop turn; only the *DB
write and notification* are async. `mmsmoke.ts:46-53` awaits a microtask flush for exactly
this reason. **What it could still miss:** a failure *during* staging (DB write throws) after
the entries were already removed from the queue — the pairing is gone and both players must
re-queue. **[I]**

**One account, two slots.** `enqueue` calls `removeUser(userId, id)` before inserting
(`:161`), which is what prevents the ghost-robot self-pair. A `self-pair backstop` also exists
in `findMatch` (`:279`). **[C]**

**Stacked challenges.** `inviteToRoom` replaces per direction, so only one live challenge
exists each way — stacked rated rows would let someone accept an abandoned token. **[C]**

**Role swap.** `useRoleSwap.ts` is **genuinely race-free**, not merely race-reduced. It rides
two roster flags with no new message: each side sets `swapReq: true`, and when *both* are set
each client flips **its own** role (`:89-104`). Since they always held opposite roles, both
flips commute — there is no shared value to contend. An `enacted` ref prevents a double-flip
in the patch→broadcast window (`:88`, `:91`). Decline is local-only, because you cannot clear
the partner's flag. **[C]**

**Queue park/adopt.** `LobbyClient.on()` **replaces** (`lobbyClient.ts:75-77`), so park and
adopt are plain re-registration with no unsubscribe bookkeeping — **no listener duplication is
possible**. `subs` in the keeper is a `Set` and `notify()` iterates a copy (`:82-84`), so
unsubscribing during notification is safe. Double-*queueing* is guarded separately:
`adoptParked()` returns true and short-circuits the challenge auto-queue
(`Matchmaking.tsx:302`). **[C]**

**`updateQueue` must return a new object — confirmed fixed.** `queueKeeper.ts:118-127` does
`parked = { ...parked, ...patch }`, with the comment recording that in-place mutation shipped
once and silently broke the match-found takeover (`useSyncExternalStore` compares by
reference). **[C]**

---

## 13. CLAUDE.md vs the code

CLAUDE.md is meant to be current. Where it disagrees with the code, **the code is correct**
and CLAUDE.md should be corrected. Listed worst-first.

### 13.1 An entire subsystem is undocumented — LAN self-host

CLAUDE.md's netcode section does not mention it at all, yet it comprises `server/lanMode.ts`,
`server/static.ts`, `src/net/lanAddress.ts`, `src/net/lanAdopt.ts`, `src/net/lanRuns.ts`,
`src/net/credentials.ts`, `electron/lanHost.cjs`, migration `0033_lan_runs.sql`, and
`docs/lan-selfhost.md`. It changes the security model (a credential-strip boundary at the
transport send), the deployment model (a server that also serves the client over plain HTTP),
and the persistence model (client-uploaded matches with an idempotency key). Anyone touching
`transport.send`, `LobbyClient.join`, or `env.ts`'s URL accessors needs to know it exists.

### 13.2 Snapshots DO carry app-layer sequencing

CLAUDE.md describes the protocol as if `serverTick` were the only ordering and implies no acks
or sequence numbers. In fact:
- **`input.ack`** (`protocol.ts:326-335`) — a client→server snapshot ack piggybacked on the
  per-tick input, driving a self-healing keyframe when a client's confirmed baseline falls
  `ACK_STALE_TICKS` (240) behind (`room.ts:141`, `:1853-1854`).
- **`input.gen`** (`protocol.ts:336-340`) — a match-generation guard enforced at
  `room.ts:879`, without which a rematch's tick-0 rebuild would let in-flight old-match inputs
  be applied as current.

### 13.3 "Only the local robot is predicted" is an oversimplification

The prediction loop steps **every** robot using commands echoed back in `Snapshot.cmds`
(`game.ts:833`, `cmdMap` `:884-888`, `session.ts:44-46`), because remote collisions must be
simulated. Only the *rendering* is interpolated for remotes (`game.ts:952-962`). CLAUDE.md's
phrasing would lead someone to "optimise away" remote stepping and break robot-robot contact
in the predicted world.

### 13.4 `queueKeeper.ts` is at `src/ui/`, not `src/net/`

CLAUDE.md cites `src/net/queueKeeper.ts` repeatedly. The file is `src/ui/queueKeeper.ts`.

### 13.5 The ranked pre-match strategy window is unmentioned

`strategyStart`, `STRATEGY_DURATION_MS` 20 s, `enterStrategy` (`room.ts:1177`), the
`strategy` capability gate, per-recipient roster redaction (`protocol.ts:159-163`), the
`alliance`-strip during the window (`room.ts:831`), and the fact that disconnecting *during*
it cancels the match with a `'bail'` dodge (`room.ts:694-703`). This is a whole phase of the
ranked lifecycle.

### 13.6 `checksum.ts` exists, and its own doc comment is stale

CLAUDE.md implies no checksums exist. `src/net/checksum.ts` does exist. Its header still says
*"Peers exchange {tick, hash} every CHECKSUM_INTERVAL ticks"* — **no such exchange happens**;
that is leftover prose from the deleted lockstep era. `worldHash`'s only live consumers are
`src/sim/replay.ts:338` and `scripts/smoke.ts`.

### 13.7 `SNAPSHOT_INTERVAL` is server-only

CLAUDE.md discusses it as a protocol constant. It is `server/room.ts:97` and appears nowhere
on the client, which only *measures* the resulting rate.

### 13.8 `mmsmoke.ts` has 58 checks, not 36

Verified by running it: `✓ matchmaker: 58 checks passed`. CLAUDE.md says 36 in two places.

### 13.9 The repo map is significantly incomplete

Missing from CLAUDE.md's map: `server/{index,api,standing,moderation,static,channel,routing,
regions,lanMode,matchTypes}.ts` and `src/net/{api,env,ping,credentials,checksum,activeGame,
announcements,notice,roomCode,session,lanAddress,lanAdopt,lanRuns,version}.ts`. `server/index.ts`
alone is 2477 lines and owns routing, admin, and the socket handler.

### 13.10 `docs/multiplayer.md` documents a deleted architecture

It describes `lockstep.ts`, `mesh.ts`, `lobby.ts`, WebRTC full mesh, STUN, and a Supabase
Realtime lobby. None of those files exist. It should be deleted or clearly marked historical.
Residue of the same era: `src/vite-env.d.ts:4-8` still declares three `VITE_SUPABASE_*` env
vars with **zero consumers**.

### 13.11 Minor

- CLAUDE.md says "The region is an ARGUMENT to `Lobby.join()`". True of the *component's*
  local `join(roomCode, hostRegion?)` (`Lobby.tsx:233`), but **not** of
  `LobbyClient.join(room, player, config)`, which takes no region — the region goes into the
  **socket URL** (`Lobby.tsx:251`). Easy to misread into a wrong change.
- CLAUDE.md says "The same discipline covers `spectateRoom` (passes `region` for a bare
  code)." It passes a region but **bypasses `roomJoinRegion`** — see §17.2.
- `transport.ts:12` claims "fixed backoff"; it is a flat delay plus jitter, no backoff.

---

## 14. Diagrams

### 14.1 Connection and region routing

```
 browser
   │  probeHome() → /health → x-region + RTT              ping.ts:37
   │  GET /api/presence → caps                            index.ts:1526
   ▼
 choose URL
   ├─ ranked ......... gameServerUrlWith({mm:'1'})
   ├─ staged room .... gameServerUrlWith({room:'iad-abc'})   ← region in the code
   ├─ custom room .... roomServerUrlWith({region: roomJoinRegion(hostRegion, own)})
   └─ LAN ............ lanServerUrl()                        ← adopted from origin
   ▼
 new WebSocketTransport(url)                               transport.ts:102
   │  trusted = trustedFor(url, gameServers())   ← decided ONCE, from the URL
   ▼
 ws upgrade  ──►  routeTarget(url, MATCHMAKER_REGION)      routing.ts:18
                    │  mm=1        → matchmaker region
                    │  ?region=    → that region            (explicit wins)
                    │  room=xx-yy  → prefix region
                    └─ bare code   → null (stay here)
                  ▼
              same region?  ── no ──►  HTTP/1.1 200 + fly-replay: region=…
                  │ yes                socket.destroy()      index.ts:1780-1787
                  ▼
              Room (this machine)
```

### 14.2 Session lifecycle

```
  ┌─ QUEUE ────────────────────────────────────────────────────────┐
  │ queue{mode,player,homeRegion,accessMs,party?}                   │
  │   → Matchmaker.enqueue (SYNC match)          matchmaking.ts:153 │
  │   → findMatch over groupUnits                             :242  │
  │   → assign (ASYNC stage): bestHost, pending_matches        :329 │
  │   → matchAssigned{room:'<region>-<code>'}                       │
  │   → client DROPS this socket, reconnects to ?room=              │
  └────────────────────────────┬────────────────────────────────────┘
  ┌─ CODE ─────────────────────┤   ┌─ CHALLENGE ────────────────────┐
  │ join{room,player,config}   │   │ challengeOf → casual: join     │
  │ roomJoinRegion → URL       │   │              → rated: queue    │
  └────────────────────────────┤   └────────────────────────────────┘
                               ▼
                    welcome → roster  (host = first client)
                               │
                    staged+caps? ──► strategyStart (20 s, redacted roster)
                               │           │ all ready OR deadline
                               ▼           ▼
                    matchStart{seed,setups,yourRobotId,gen,region}
                               │
                    ┌──────────▼───────────┐
                    │  60 Hz step() loop   │  ← §14.3 / §14.4
                    └──────────┬───────────┘
                    teleop → post → +MATCH_SETTLE_S
                               ▼
                    finalizeMatch: matchArchive(host only) → matchResult
                               │
                    persistMatch (OFF the hot path)
                       ├─ record → submitRecord → recordResult
                       └─ versus → Glicko-2   → eloResult
```

### 14.3 Input flow

```
CLIENT (every 1/60 s)                       SERVER (every 1/60 s)
─────────────────────                       ─────────────────────
bindings → RobotCommand
    │
    ├─ local = localizeCommand(cmd)
    │      = dequantize(quantize(cmd))
    │
    ├─ sendInput(tick, cmd) ──── input{tick,q,ack,gen} ──►  onInput()   room.ts:875
    │                                                        ├ gen stale? drop
    │                                                        ├ tick unsafe? drop
    │                                                        ├ lead > 120? drop
    │                                                        └ buffer by tick
    ├─ inputBuf.push({tick, cmd: local})
    │                                                      frameCommands(t+1)  :1768
    └─ step(world, SIM_DT, cmdMap(local))                    exact → hold(15) → ZERO
         (local live cmd + held remote cmds)                        │
                                                            step(w,SIM_DT,cmds)  :1479
                                                                    │
    ◄──────── snapshot{serverTick, w, balls, cmds, ackInputTick} ───┘  every 2 ticks
    │
    ├─ bufferSnapshot()   ← poses captured BEFORE reconcile mutates
    ├─ remoteCmds = snap.cmds
    └─ reconcile(snap)
         world = snap.world                    ← hard swap
         inputBuf.filter(tick > serverTick)    ← drop acked
         replay remaining through step()
         localSmooth = renderedPre − post      ← cosmetic; SNAP if > 16 in
```

### 14.4 State sync

```
SERVER                                     WIRE                      CLIENT
──────                                     ────                      ──────
World (full)
  robots[] with spec ──── stripSpec ──►  SlimWorld ─────────────►  unslimWorld(
  balls[]         ──┐                    (no balls,                  w, balls,
                    │                     no specs)                  specById)
                    │                                                    │
                    └─ diff vs prevBalls ─► BallDelta                     │
                        order: EVERY id      {order, upd}                 │
                        upd:   changed only       │                       │
                                                  ▼                       ▼
                                        applyBallDelta(baseline) ──► balls[]
                                          patch upd, prune to order       │
                                                                          ▼
                                        specs re-injected from matchStart.setups
                                        backfillRobot() re-seeds fields an
                                        older server omitted  ← NaN guard
                                                                          ▼
                                                                  World (identical)
```

### 14.5 Disconnect flow

```
 socket closes
     │
     ├─ CLIENT: transport.onclose → downCb → scheduleReconnect
     │            1000+rand(400) ms × 40  (~48 s)
     │            HUD: "Reconnecting… Your run keeps going."
     │              │
     │              ├─ reopened → onReopen → rejoin{room, clientId}
     │              │                ├─ rejoined{ok:true} → full KEYFRAME → resume
     │              │                └─ rejoined{ok:false} → failed (hard)
     │              └─ budget exhausted → onFail → failed → "REFRESH"
     │
     └─ SERVER: detach(id, conn)                            room.ts:673
                  ├─ stale conn? ignore
                  ├─ lobby?    delete client, reassign host
                  ├─ strategy? CANCEL staged match + 'bail' dodge
                  └─ in-match? connected=false, disconnectAt=now
                                    │
                     robot stays in world.robots, coasting:
                       exact input → hold 15 ticks → ZERO_CMD
                                    │
                     checkGrace() every tick (WALL clock)  room.ts:779
                       now − disconnectAt > 45 s ?
                         ├─ no  → keep holding the slot
                         └─ yes → broadcast drop{robotId,tick}
                                  departed.set(rid, …)   ← match STILL rates
                                  release one-live-game lock
                                  delete client
                                  empty? → stop() + onEmpty() → room deleted
```

---

## 15. Key abstractions

### `Room` — `server/room.ts:282`
**Responsibility:** one authoritative match. Owns the `World`, the 60 Hz loop, the roster, the
host, snapshot broadcast, input ingest, reconnection grace, and finalization.
**Lifecycle:** created in `joinRoom` (`index.ts:1907`) or the dev fallback
(`matchmaking.ts:363`); destroyed via `onEmpty()` when the last client's grace lapses.
**Dependents:** `server/index.ts` (registry), `persist.ts`, `matchmaking.ts`.
**If changed:** it is the only writer of authoritative state. Anything that makes `stepOnce`
non-deterministic or lets a second writer touch `world` desyncs every client at once.

### `GameController` — `src/game.ts`
**Responsibility:** the client's whole match runtime — sim stepping, prediction, reconcile,
interpolation, rendering, HUD, audio edges, replay recording.
**Lifecycle:** per `GameView` mount; `dispose()` harvests any practice run (`:1326`).
**If changed:** `session: null` must stay bit-identical to solo. The `localizeCommand` call in
**both** the solo (`:765`) and net (`:871`) paths is load-bearing for replay fidelity.

### `LobbyClient` — `src/net/lobbyClient.ts:63`
**Responsibility:** thin relay for everything *before* the match — join, queue, roster,
patches, start.
**Lifecycle:** created per connect attempt; at `matchStart` the caller mints a `ServerSession`
that **takes over the same transport**.
**If changed:** `on()` must keep *replacing*. If it ever became add-listener, queue park/adopt
would duplicate handlers and double-send.

### `ServerSession` — `src/net/serverSession.ts`
**Responsibility:** the in-match client half — `sendInput`, snapshot ingest, ball baseline,
rejoin, RTT/jitter, match result.
**If changed:** it owns the ball `baseline` map that `applyBallDelta` mutates in place.
Clearing it at the wrong moment desyncs ball state silently.

### The two registries — `src/games/sim.ts` vs `src/games/index.ts`
`sim.ts` exports `simModuleFor` over DOM-free `GameSimModule`s. `index.ts` exports `moduleFor`
over `GameModule`, which adds four canvas draw members typed on
`CanvasRenderingContext2D` (`module.ts:11-29`).

**What breaks if the server imported `index.ts`:** a **compile failure**, by design.
`tsconfig.server.json:6` is `"lib": ["ES2022"]` with no `DOM`, so `CanvasRenderingContext2D` is
undefined at type level and `npm run server:check` fails. Runtime would actually survive (types
erase; nothing in the draw modules touches `document` at module scope) — which is exactly why
the split is enforced by two tsconfigs rather than a runtime guard. The *second* cost is worse:
it would drag `chain/drawRobot.ts` into the server graph, and that file holds a
`performance.now()` and eight bare `Math.sin/cos/hypot/atan2` calls which the determinism grep
**deliberately exempts** by filename (`smoke.ts:12208-12210`). **[C]**

Confirmed clean today: `server/` imports `../src/games/sim` at exactly two sites
(`room.ts:6`, `persist.ts:18`) and has **zero** imports of `src/games/index.ts`,
`src/render/*`, or `src/ui/*`.

### `World` / `RobotState` — `src/types.ts:730` / `:276`
**Responsibility:** the shared shape. Must stay plain JSON — snapshots, reconcile, and replays
all depend on it.
**If changed:** ⚠️ every new per-tick field ships 30 times a second to every client
(run `npm run costprobe`), and a field an older server omits arrives `undefined` and NaNs the
sim unless `backfillRobot` (`protocol.ts:673`) is extended.

### `queueKeeper` — `src/ui/queueKeeper.ts`
**Responsibility:** keep a live ranked search alive across the unmount of the screen that
started it. A module singleton precisely because it must outlive that tree.
**If changed:** `updateQueue` must return a new object, or `useSyncExternalStore` skips the
render and the match-found takeover silently never fires.

### Replay container — `src/sim/replay.ts:57`
**Responsibility:** `{format, versions, seed, setups, tracks}` — an input log, not a recording.
**If changed:** a sim behaviour change **retires** every older replay by design
(`replayRefusal`). Bump `SIM_VERSION` for behaviour, `BALANCE_VERSION` for balance, and
`REPLAY_FORMAT` if the track shape changes.

---

## 16. Hidden coupling

### 16.1 Sim purity — holds

No `Math.random`, no wall clock, no `session` awareness anywhere in `src/sim/` or CR sim code
(§12.5). The `session: null` ⇒ solo-path-bit-identical invariant is real: `GameController`
branches on `this.session` at the *controller* level only (`game.ts:700`, `:786`), and the sim
never sees it.

⚠️ One qualification: **`step()` is not quite pure.** `lastTickRounds` (`world.ts:114`) is
module-level mutable state written every tick. It is a diagnostic and is not hashed, so it
cannot desync — but it means `step` is not a pure function of `(world, dt, commands)`.

### 16.2 The registry seam — holds, with one soft spot

Clean today (§15). The soft spot is that `src/games/chain/` mixes **sim and render** in one
folder (`step.ts`, `play.ts` beside `draw.ts`, `drawRobot.ts`, `RobotPreview.tsx`), and the
determinism grep exempts files by the `draw*`/`render*` **filename prefix**. A future CR
render helper named something else, or sim logic moved into a `draw*` file, would slip past.

### 16.3 UI reading `world.robots` order

`snapBuf` stores poses **by robot id** and `displayWorld` looks up by id with an explicit
fallback when a robot is absent from either bracketing snapshot (`game.ts:956`). The ball
delta likewise rebuilds strictly from the authoritative `order`. So neither is positionally
fragile. `Snapshot.cmds` **is** positional (`serverSession.ts:305-309`:
`m.w.robots.forEach((r,i) => cmds.set(r.id, dequantize(qc[i]))`) — but it maps back to ids
immediately and both arrays come from the same snapshot, so a departed robot cannot skew it.
**[C]**

### 16.4 The two-game seam — three real divergences

**(a) CR replay setups are clamped with DECODE limits.** `coerceSetup`
(`src/sim/spawn.ts:549`) takes **no `game` argument** and calls `coerceSpec(s.spec)` with it
undefined. `sanitizeReplay` (`sanitize.ts:153`) therefore DECODE-clamps a CR practice replay:
a legal 17″ CR chassis (`CHAIN_MAX_LENGTH`, `chain/config.ts:483`) is narrowed to ≤15″
(`INTAKE_PRESETS.sloped.maxLength`, `config.ts:1521`). The viewer's re-sim goes through
`createChainWorld` → `coerceSpec(…, 'chain')` and reproduces a **different robot** than the one
recorded. `sanitizeReplay` already has `game` in hand (`:124`, used at `:180`). **[C]**

**(b) `coerceStartIndex` uses DECODE's anchor count for both games.** `sanitize.ts:33-37`
clamps to `START_POSES.length - 1` = 4. CR has **4** anchors (`CHAIN_START_POSES`,
`chain/config.ts:955-960`), so index 4 passes the server and then wraps modulo to 0 in
`chainStartPose` (`chain/spawn.ts:74-76`). No crash; a silently different corner. **[C]**

**(c) `createChainWorld` bypasses the spawn chokepoint.** `chain/spawn.ts:166-168` goes
straight to `makeChainRobot` without `coerceSetup` — so no `coerceAutoPath`, no alliance enum
check, no `coerceStartPose`. CR is covered at server ingress by `sanitizePlayer` only, where
DECODE is covered twice. **[C]**

Also noted, harmless: `backfillRobot` seeds DECODE flywheel geometry
(`flywheelSpinTarget(r.alliance, r.pos)`) onto CR robots. The fields are unused in CR, so it is
a seam rather than a bug. **[C]**

### 16.5 Audio edge-detection

`handleActionAudio` runs after reconcile's replay and is **not** de-duped, unlike the toast
path. See §7.5 / §17.6.

---

## 17. Risks

### 17.1 HIGH — `onBehaviour` is never wired in production **[C]**

`Room`'s constructor takes **8** parameters (`room.ts:398-426`), the 8th being `onBehaviour`.
`server/index.ts:1907-1917` — the **only** production room-creation site — passes **7**:

```ts
r = new Room(code, () => rooms.delete(code), cfg, persistMatch,
             (uid) => userRoom.set(uid, code),
             (uid) => { if (userRoom.get(uid) === code) userRoom.delete(uid); },
             persistDodges);              // ← onBehaviour omitted
```

Only the DB-off **dev** fallback wires it (`matchmaking.ts:363`). Staged ranked matches are
built by that same `joinRoom` path (`index.ts:1961-1963` claims the pending row *into the room
created at `:1907`*), so `reportBehaviour` returns immediately at its
`if (!this.onBehaviour …) return` guard (`room.ts:1612`) for **every production ranked match**.

**Impact:** AFK and leave standing charges, and card standing charges (yellow/red), never fire
in production. The whole `persistBehaviour` path (`persist.ts:216-246`) and the
`creditCleanMatch` heal are dead. Dodge charges are **unaffected** — `persistDodges` is arg 7
and is wired.

**Fix:** add `(b) => void persistBehaviour(b)` as the 8th argument at `index.ts:1917`.

### 17.2 MEDIUM — `spectateRoom` bypasses `roomJoinRegion` **[C]**

`roomJoinRegion` has exactly **one** production call site: `Lobby.tsx:243`. `spectateRoom`
(`App.tsx:669-686`) re-derives the rule inline:

```ts
gameServerUrlWith(region ? { room: code, region } : { room: code })
```

This omits the param when `region` is falsy instead of falling back to the watcher's own pick.
It is behaviourally close but it is a **second implementation of the rule the module exists to
centralise** (`roomRegion.ts:22-27` warns about exactly this). Spectating a *custom* room from
a region-less source lands on whichever machine is nearest the watcher, which reports no such
room.

**Fix:** route it through `roomJoinRegion(region, selectedServer()?.region ?? '')` and drop the
key when the result is empty.

**Other join paths audited and correct:** `Matchmaking.tsx:530` (staged code carries its
region), `Matchmaking.tsx:466` (`?mm=1`), `RecordRun.tsx:48-49` (solo, private code),
`rejoinGame` (`App.tsx:624-629`, uses the recorded region). The auto-join guard is keyed on the
**code**, not a boolean (`Lobby.tsx:314-322`), so a second invite without leaving the lobby
works.

### 17.3 MEDIUM — a parked ranked queue survives sign-out **[C]**

`dropQueue()` is called from exactly two places: `Matchmaking.tsx:570` (explicit cancel) and
`QueueBar.tsx:83` (the bar's cancel button). **No auth-change teardown exists** — I checked
`App.tsx`'s `signedIn` effects (`:998-1006`, `:1014-1024`). Signing out, or switching accounts,
while a search is parked leaves the socket open and queued under the previous account's
verified JWT. The next match-found takeover would drop the *new* user into a rated match
staged for the old one.

**Fix:** call `dropQueue()` in the `signedIn` transition effect.

### 17.4 MEDIUM — the production ball-delta codec has no codec-level test **[C]**

`encodeBallDelta` (`protocol.ts:708`) is tested by `smoke.ts` and used by `costprobe.ts`, but
**the server never calls it**. `Room.broadcastSnapshot` (`room.ts:1809-1813`) hand-rolls the
same diff so it can share an encoded prefix across clients (`:1826-1840`). The two agree
today; nothing pins that they keep agreeing. `smoke.ts:11719` tests slim/unslim round-trip
through the *shared* codec, so a drift in the room's version would pass the suite.

### 17.5 LOW — client inbound messages have no error guard **[C]**

`decodeServerMsg` is a bare `JSON.parse` (`protocol.ts:612`); `transport.ts:139-141` calls
`messageCb` with no try/catch; `LobbyClient.onMessage` (`:178`) and `ServerSession` both parse
unguarded. A malformed frame throws inside `onmessage` — the socket stays open and the message
is silently lost. The server guards both parse and dispatch (`index.ts:2077-2083`); the client
should mirror it.

### 17.6 LOW — SFX can re-cue on reconcile replay **[C]**

`handleActionAudio` (`game.ts:565`) runs in `frameLogic` (`:673`), i.e. **after** reconcile has
replayed buffered inputs. Toasts are de-duped via `shownEventCount` (`:974-983`); the SFX edges
are not, so a replayed prediction that re-crosses `lastFireAt`/`lastIntakeAt`/`gateOpen` can
fire the cue twice. Cosmetic, more audible under packet loss (more replay).

### 17.7 LOW — evicted practice bodies leave undrainable backlog entries **[C]**

`App.tsx:738` does `if (!replay) continue;` when the body was evicted by `MAX_LOCAL_RUNS`. The
meta stays in the index with no `remoteId`, so `pendingPracticeUploads()` returns it on every
future flush, forever. Harmless (one `getItem`) but it never self-clears.

### 17.8 LOW — `world.penalties` has no `unslimWorld` backfill **[C]**

`types.ts:519-522` documents it, and `ballCarry?` is `??=`-guarded for exactly that reason.
Every **new** `PenaltyState` field needs the same treatment or an old→new server skew throws
on first index. This is a landmine for anyone extending the penalty engine.

### 17.9 LOW — `world.gameSettings` rides every snapshot **[C]**

Set at `spawn.ts:839`; `SlimWorld = Omit<World, 'balls'|'robots'>` (`protocol.ts:631`) does not
strip it. Whatever the client put in `GameSettings` is broadcast to every client in the room,
30 times a second. Bandwidth cost and a minor information exposure.

### 17.10 Informational

- **`REGION` is read twice, independently** — `index.ts:304` and `room.ts:180`. Same
  expression, two consts, free to drift.
- **Duplicate migration prefixes** — `0003`, `0012`, `0018`, `0019` each appear twice.
  `migrate.ts:45-47` sorts by **filename**, so ordering is alphabetical and stable, and none of
  today's pairs touch the same table. The next duplicate that does will be an ordering bug
  nothing catches.
- **`transport.ts:12` claims "fixed backoff"** — it is a flat delay + jitter.
- **`exposeForTesting`'s DEV gate is at the call site** (`QueueBar.tsx:27`), not inside the
  module. `exposeForTesting(true)` from anywhere would attach the handle; nothing does.
- **Dead-but-annotated:** the `restart` `ClientMsg` variant (explicit no-op, `room.ts:861`),
  `MAX_PENDING_PER_ROBOT`'s eviction (documented unreachable, `room.ts:117-133`), the
  `perMessageDeflate` `threshold` (documented inert, `index.ts:1713-1729`). All three are
  deliberate; leave them.
- **Supabase env declarations survive** in `src/vite-env.d.ts:4-8` with zero consumers.

### 17.11 Still unvalidated

- **Ranked end-to-end with two real accounts: still true, still unvalidated.** Nothing in the
  repo exercises it. `mmsmoke.ts` is clock-injected and socket-free *by construction* — it can
  never catch a real two-socket race. `loadtest.ts` can drive the queue path but needs real
  JWTs from a signed-in browser (`loadtest.ts:33-36`).
- **Reconnection under real network loss** — the grace/rejoin path has no automated test.
- **Multi-room load** — `loadtest.ts` exists but `/api/perf` p99 under real matches is the
  gating number, and it has not been read on the current VM size. **[?]**

---

## Appendix A — Multiplayer Developer Reference {#appendix-a}

**Architecture.** Server-authoritative Node + `ws`, one `Room` per match, Fly multi-region with
`fly-replay`. Server and client run the **same** `step()`. JSON over WebSocket. 60 Hz sim /
30 Hz snapshot / 10 Hz HUD.

**Entry points by task:**

| Task | Start here |
|---|---|
| Change the wire format | `src/net/protocol.ts` — then check `CLIENT_CAPS`/`SERVER_CAPS` |
| Change the authoritative loop | `server/room.ts:1357` (`startLoop`) / `:1476` (`stepOnce`) |
| Change prediction/reconcile | `src/game.ts:786` (`stepServer`) / `:985` (`reconcile`) |
| Change interpolation | `src/game.ts:905` (`displayWorld`) |
| Change matchmaking | `server/matchmaking.ts:242` (`findMatch`) — then `npm run test:mm` |
| Change reconnection | `server/room.ts:673/733/779` + `src/net/transport.ts:162` |
| Change rating | `server/ranked.ts:172` (`persistVersusMatch`) |
| Add a `RobotSpec` field | `src/sim/spawn.ts:159` (`coerceSpec`) — **mandatory** |
| Add a per-tick `RobotState` field | `src/types.ts` + `protocol.ts:673` (`backfillRobot`) + `npm run costprobe` |

**State ownership in one line:** the server owns the `World`; the client owns only
`inputBuf`, `snapBuf`, `renderTick`, `localSmooth`, and its connection metrics — all cosmetic
or transient, none of which may ever touch `this.world`.

**Message catalog:** §6. 14 `ClientMsg`, 21 `ServerMsg`.

**Sync model:** delta snapshots (spec stripped, balls delta'd with full id order every frame).
Client predicts **all** robots, renders its own predicted and remotes interpolated ~5 ticks
back. Balls never interpolated. Prediction capped at `MAX_PREDICT_LEAD` 40 ticks.

**Authority model:** anything a client asserts about itself is re-derived server-side —
`sanitizePlayer` (allowlist), `PlayerPatch` (a `Pick`), `coerceSpec` (clamps), `verifyParty`
(DB-resolved), `verifyAuthToken` (JWKS), admin re-checked per request. `supporter`, `role`,
`slot`, `hidden`, `clientId`, and `Room.ranked` are **server-authored only**.

**Reconnection:** 45 s server grace; the robot stays in the world coasting on `ZERO_CMD` after
15 ticks. Client retries 40× at ~1 s (~48 s, deliberately longer than the grace). `rejoin`
returns `rejoined{ok}`; success is followed by a **full keyframe**.

**Late joining:** impossible mid-match (`canJoin()` requires `world === null`). Spectators are
a separate map and receive the same snapshot stream with `yourRobotId: -1`.

**Timing:** all match timing is sim-driven. No wall clock in the match path. The server freezes
the loop when nobody is connected; `checkGrace` keeps running on the wall clock through it.

**Serialization:** JSON; commands quantized to int8/uint8 for reconcile bit-matching (predict
on `localizeCommand`, always). Replay is `{seed, setups, tracks}` gated by `REPLAY_FORMAT` /
`BALANCE_VERSION` / `SIM_VERSION`.

**Known limitations:**
- Ranked has never been validated end-to-end with two real accounts.
- `onBehaviour` is unwired in production (§17.1) — standing charges for AFK/leave/cards do not fire.
- The production ball-delta encoder is not the tested one.
- Client inbound messages are unguarded against malformed JSON.
- CR practice replays are spec-clamped with DECODE limits (§16.4a).

**Invariants that must not break:**
1. `session: null` ⇒ the solo path is bit-identical.
2. Solo Practice rebuilds at tick 0 with the seed **reused**, never reseeded.
3. The server imports `src/games/sim.ts` only — never `src/games/index.ts`, `src/render/*`, `src/ui/*`.
4. `world.rngState` is the only shared randomness in sim code.
5. `LobbyClient.on()` replaces; it must never become add-listener.
6. `updateQueue` returns a new object.
7. DB writes stay off the per-tick hot path.
8. `Room.ranked` is only ever set from a staged `pending_matches` row.

**Dangerous areas:** `Room.stepOnce`/`broadcastSnapshot` (one bad line desyncs everyone at
once); `reconcile` (a wrong `inputBuf` filter produces drift nobody can see locally);
`coerceSpec` (a missed field is a spoofable robot); `verifyParty` (a downgrade path would make
rated challenges farmable); `enforceLanPolicy` (a regression connects somebody's laptop to the
production database).

**Dependencies:** `ws` 8.21 (transport) · `tsx` 4.23 (server runtime) · `pg` 8.22 (Postgres) ·
`jose` 6.1 (JWKS verification — note `@neondatabase/auth` is a dependency but is **not imported
anywhere in `server/`**) · `@dimforge/rapier2d-compat` **pinned exactly at `0.19.3`, not a
caret** (`package.json`) — confirmed, and load-bearing: a floating physics engine would change
`step()` output with no version bump, making every replay stamp a lie.

---

## Appendix B — Rules a Developer Must Follow {#appendix-b}

Derived only from what this investigation confirmed. Each carries its reason.

1. **Never let `server/` import `src/games/index.ts`, `src/render/*`, or `src/ui/*.`** Use
   `simModuleFor` from `src/games/sim.ts`. `npm run server:check` is the enforcement — the
   client registry types on `CanvasRenderingContext2D` and `tsconfig.server.json` has no `DOM`
   lib. It would also drag render files past the determinism grep, which exempts `draw*`/
   `render*` by filename.

2. **Every new `RobotSpec` field must be clamped in `coerceSpec`** (`src/sim/spawn.ts:159`),
   in the existing dependency order, and must survive `coerceSpec(coerceSpec(x)) ===
   coerceSpec(x)`. Specs arrive from hand-editable localStorage *and* untrusted clients.

3. **Every new per-tick `RobotState` field must be handled in `backfillRobot`**
   (`protocol.ts:673`). One Fly app serves every client version, so a newer client will receive
   snapshots from an older server where the field is `undefined` — and bare arithmetic on
   `undefined` NaNs the robot's position. Same rule for `PenaltyState`, which has **no**
   backfill at all today (`types.ts:519-522`).

4. **Run `npm run costprobe` after adding any per-tick `World`/`RobotState` field.** It ships
   30 times a second to every client in the room, and egress — not compute — is ~90% of the bill.

5. **Predict on `localizeCommand(cmd)`, never the raw command** — in the networked path *and*
   the solo path. A replay stores quantized commands, so a run re-simulates exactly only if the
   sim consumed the quantized value.

6. **A room join must resolve its region through `roomJoinRegion`.** Do not re-derive the rule
   inline. It fails **silently** — two lobbies, one code, both sides waiting, no error anywhere.
   (`spectateRoom` currently violates this; fix it rather than copying it.)

7. **`world.rngState` is the only legal source of shared randomness in sim code.** No
   `Math.random`, no `Date.now`, no `performance.now` in `src/sim/` or `src/games/*/` sim
   files. Use `dsin`/`dcos`/`datan2` from `src/math.ts`. `npm test` greps the source for all of
   these (`smoke.ts:12217`, `:12236`).

8. **DB writes stay off the per-tick hot path.** Persist at `finalizeMatch` and let it fail
   without touching the room — `persistMatch`/`persistDodges`/`persistBehaviour` all catch and
   log rather than throwing into a live match.

9. **A replay-affecting change requires a version bump.** Behaviour change ⇒ `SIM_VERSION`.
   Balance change ⇒ `BALANCE_VERSION`. Track shape change ⇒ `REPLAY_FORMAT` (and
   `trackStride`). A sim change without a bump silently produces a *different game* from the
   same inputs while claiming to be the same recording.

10. **A replay or foul-string change is a SERVER change — deploy it.** `getReplay` must be able
    to populate `Replay.sim`, and foul strings live in `src/sim/` and `src/games/chain/`. This
    has bitten twice: the `behaviour_version` column landed without a Fly redeploy and the live
    viewer refused every replay.

11. **Protocol changes must stay backward-compatible.** One Fly app serves every client
    version. New client features gate on `CLIENT_CAPS`; new server features gate on
    `SERVER_CAPS`. Adding an *optional* field to an existing message is free; changing or
    removing one is not. A new `RobotSpec` field is not a protocol change, but an older
    server's `coerceSpec` will drop it.

12. **Never accept `supporter`, `role`, `slot`, `hidden`, or `clientId` from the wire.**
    `sanitizePlayer` is an allowlist and `PlayerPatch` is a `Pick`; keep both that way. A
    self-declared staff badge is an impersonation primitive.

13. **A failed party-token verification must be REFUSED, never downgraded to the open queue.**
    A silent downgrade matches two friends against strangers for rating.

14. **`LobbyClient.on()` must keep replacing, and `updateQueue` must keep returning a new
    object.** The first makes queue park/adopt safe with no unsubscribe bookkeeping; the
    second is what makes `useSyncExternalStore` actually re-render. Both have already shipped
    broken once.

15. **Anything new that a `Room` constructor argument enables must be wired at
    `server/index.ts:1907`, not only in the dev fallback.** That is the only production
    room-creation site, and §17.1 is what happens when it is missed.

16. **Thread `game` through every coercion that has game-specific ranges.** `coerceSpec` takes
    it; `coerceSetup` does not, and that is the bug in §16.4a. CR and DECODE have different
    chassis envelopes and different start-anchor counts.

17. **Run the right suite.** `npm test` after `src/sim/`, `src/config.ts`, or `src/games/`.
    `npm run test:mm` after `server/matchmaking.ts`. `npm run dbtest` after `server/db/` or a
    migration. `npm run server:check` after anything the server imports. A red `npm test` must
    keep meaning "physics broke" — do not fold the others into it.
