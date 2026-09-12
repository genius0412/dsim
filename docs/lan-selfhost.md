# LAN / self-hosted servers — design

Branch `lan-selfhost`, stacked on `perf-load-v2`. **Steps 1 and 2 are BUILT** (see §9);
everything from step 3 on is still design.

Decided with the owner: LAN matches are **unofficial** — never on a leaderboard, never rated —
but their **replays are still uploaded** for storage and data collection.

## Why this is a capacity feature, not just a convenience

Every room hosted on a team's own laptop is a room the Fly bill never sees. The capacity model
(`docs/capacity.md`) puts 1,000 concurrent players at ~700 rooms and ~63 cores of work.
`docs/scaling-multicore.md` shows how to serve that on single-digit machines instead of 70–90 —
but LAN is the only lever on the table that **reduces the population being served** rather than
serving it more efficiently. At a competition venue, where a whole team is on one network, it is
also the lever with the best latency story: a LAN room's RTT is ~1 ms against ~30–80 ms to the
nearest Fly region.

## Owner decisions (2026-09-11)

These answer the three questions this document previously left open, and two of them changed the
design rather than just confirming it.

| question | answer | consequence |
|---|---|---|
| Who uploads, and under whose account? | **The host.** "Whoever is hosting the match from the computer." | The per-client upload with a dedup problem is gone. One uploader, one row. |
| Can the host be signed out? | **No — the host must be online and signed in**, so the data still lands. | Hosting is gated on a session. Guests may still be signed out. |
| Packaging? | **"Very easy and integrated into the app. No terminal commands acceptable."** Must meet the app's quality bar. | Rules out "download a zip and run node". Drives §5 entirely. |

## ⚠️ The constraint that decides the whole UX: an https page cannot open a `ws://` socket

This is the finding that matters most, and it is not obvious until you try it.

Browsers block `ws://` from an `https://` page as **mixed content**. It fails with nothing but a
console message — no error the app can catch and nothing the player can act on. So:

- `https://www.playdsim.com` → `ws://192.168.1.5:8787` is **blocked**.
- `https://www.playdsim.com` → `ws://localhost:8787` is **allowed**, because `localhost` is a
  "potentially trustworthy" origin and is exempt.
- **The desktop app is not a way around it.** `electron/main.cjs` loads the live https site
  whenever it is reachable and only falls back to the bundled copy when it is not, so the
  desktop app is usually an https page too.

A LAN server cannot realistically hold a TLS certificate for `192.168.1.5`, so "just use wss"
is not available.

### What follows: the LAN host serves the client too

**The host's server serves the game to the LAN over plain HTTP, on the same origin as the
WebSocket.** A guest opens `http://192.168.1.5:8787` in any browser on the network and gets the
app; the socket it opens is same-origin `ws://`, so there is no mixed content anywhere.

This is better than the alternatives rather than merely being the one that works:

- **No install for guests.** No desktop app, no app store, no download — a URL on a projector.
- **Version skew stops existing.** Every client in the room was served by the same host, so
  they are byte-identical builds. That is exactly the invariant the matchmaker's build
  segregation exists to protect, satisfied for free.
- **It is the same server binary.** The server is already an HTTP server (`/health`, `/api/*`);
  serving a static `dist/` alongside is a route, not an architecture.

The HOST still plays through `ws://localhost`, which is exempt, so the host can be in the
desktop app or the web app and it works either way.

## Hosting without a download: what was actually tried

The guest half of this feature needs no download and never did — a guest opens a URL. The
question this section answers is the HOST half: *"ideally this all runs through web, with no
requirement to download the app."* It was investigated properly rather than waved off, because
the answer is a `no` and a `no` has to be able to show its work.

**A browser tab cannot be a server.** Not "cannot yet", and not "cannot without a flag": there
is no web API that opens a listening socket, so a page cannot be dialled INTO by another
machine. Everything a page can do is a connection it initiated. Four candidates were checked
against that, and all four fail for the same structural reason:

| candidate | why it does not work |
|---|---|
| **Direct Sockets** (`TCPServerSocket`) | This is the one API that genuinely listens, and it is restricted to **Isolated Web Apps** — a signed bundle, INSTALLED, and gated behind enterprise policy. Reaching it requires more download than the terminal does. |
| **Service Workers** | Intercept requests from the SAME origin in the SAME browser profile. A service worker on the host's laptop is invisible to a guest's laptop; it is a cache layer, not a network endpoint. |
| **WebTransport** | Client-side only. It speaks to a server over HTTP/3 and cannot BE one, and it needs TLS besides — which is the problem this whole document starts from. |
| **A cloud relay** | Works, and is not LAN. The entire point of a LAN room is that the venue Wi-Fi has no internet, or has internet nobody wants 40 players' traffic on. A relay puts the thing being avoided back in the middle. |

### WebRTC is the one real path, and it is not a small one

**`RTCDataChannel` is the single mechanism by which a browser accepts a connection it did not
initiate**, and it is genuinely peer-to-peer over a LAN once established (host candidates on
the same subnet connect directly; no STUN, no TURN, no internet). If the terminal ever goes
away, this is how. Two things stand between here and there, and neither is small:

1. **Signalling.** Before two peers can talk they must exchange SDP offers and ICE candidates,
   and that exchange has to happen over something that already works. The options are a cloud
   rendezvous (needs the internet the venue does not have — so it defeats the purpose on the
   day it matters) or manual copy-paste of an SDP blob per guest (fine for a demo with one
   friend, unusable at a scrimmage with eight). mDNS-based local discovery is the interesting
   third option and is its own project.
2. **The authoritative room has to move into the tab.** Today `server/room.ts` runs the match
   and the browser predicts against it. Hosting from a page means running that loop in the
   host's tab.

**The codebase is unusually close to being able to do (2), which is why this is recorded as a
design rather than a fantasy.** `server/room.ts` has exactly ONE `node:` import (`randomUUID`
from `node:crypto`; `crypto.randomUUID()` is in every browser that matters). Everything else it
touches is `src/sim`, `src/games`, and the persistence and matchmaking modules that LAN mode
already disables — see the `LAN_MODE` refusals. And `src/net/transport.ts` is an interface
written for exactly this: the client already talks to a `Transport`, not to a `WebSocket`, so a
`DataChannelTransport` is an implementation rather than a refactor.

What it is NOT is a thing to do the day before a kickoff. It changes how every client reaches
every match, and its failure mode — a room that half-connects — is the worst kind to debug in a
gym.

### So: one command, and the page says why

`scripts/lan.mjs` (`npm run lan`) is the answer for now, and `LanPanel` prints the four
commands on the page instead of hiding the host half behind `bridge?.lan`. Before that, a
player on the web saw a screen titled "LAN play" whose only control asked for somebody else's
address, which reads as "hosting is broken" rather than "hosting needs a terminal".

Rules the launcher is written to:

- **No shell, ever.** The neighbouring `dist` script is the cautionary tale: `set ELECTRON=1&&
  npm run build` is `cmd.exe` syntax that fails on every Mac and every Linux box, and fails
  with `set: command not found`, which names nothing a person can search for. `lan.mjs` passes
  an environment OBJECT to `spawn`, so no shell parses any of it and there is nothing for
  `bash`, `zsh` and `cmd.exe` to disagree about.
- **It prints addresses, private ranges first**, the same ordering as `electron/lanHost.cjs`.
  That is the thing people came for and it belongs on a projector.
- **It builds `dist/` if missing**, because a fresh clone has none and the server refuses to
  serve a directory that is not there.
- **It sets `LAN_MODE=1` and `SERVE_CLIENT` together.** The refusals live on the server side
  of that flag, not in the launcher — see "How the rules are ENFORCED, and where" below.

**Why four commands and not `npx github:genius0412/dsim`.** The one-liner needs a `prepare`
script so npm builds the client after cloning, and `prepare` also runs on every ordinary `npm
install` — so every contributor would pay a full client build on every install to save a host
three lines once. The `bin` entry (`dsim-lan`) is in `package.json` so that trade can be
revisited without another design pass.

## What already exists

Most of the plumbing is there, which is why this is worth doing.

| piece | state |
|---|---|
| a standalone server binary | **exists** — `npm run server:prod` runs the esbuild bundle `dist-server/index.js` on plain `node`; no `tsx`, no Docker |
| server runs without a database | **exists** — `DATABASE_URL` unset makes every persistence call a no-op and the game, lobby and matches keep working (`server/db/pool.ts`) |
| the client can point at another server | **exists** — `VITE_GAME_SERVER_URL` / `gameServerUrlWith` in `src/net/env.ts` |
| offline-first result upload with a retry backlog | **exists** — `src/net/practiceRuns.ts` + `pendingPracticeUploads()` |
| a results table that cannot reach a leaderboard | **exists** — `practice_runs` (0032), and now `lan_runs` (0033) |
| a stable per-match identity | **BUILT** — `matchId` on `matchResult` |
| Electron already bundles a built client | **exists** — `loadLocal()` serves `dist/index.html` |

## The trust boundary

A self-hosted server is a machine its operator controls. Anything it reports is, from the
cloud's point of view, client-authored data. Someone can trivially run a patched server that
reports a 900-point match.

`CLAUDE.md` already states the rule this has to obey: *"do not let anything competitive start
reading `user_activity`"*. The same reasoning applies here, and the repo already contains the
pattern that solves it.

**`practice_runs` is the precedent.** It is its own table, and `record_leaderboard` is a view
over `records` — so nothing written to it is reachable from any board, PB, rank or ELO query
*by construction*, not by convention. `lan_runs` (migration 0033) is built the same way, and
`npm run dbtest` asserts the boring version of it directly: a 120-point LAN match does not
appear on the board.

It is also self-policing where it is displayed: the replay viewer **re-simulates the input
log**, so a score that disagrees with its own replay contradicts itself on screen.

### How the rules are ENFORCED, and where

The first build put the whole policy in `electron/lanHost.cjs`: the launcher blanked
`DATABASE_URL` and the secrets before spawning the child, and that was all that stood between a
self-hosted match and the production database. `dist-server/lan.mjs` is an ordinary Node bundle
anybody can run by hand, so that was a guarantee about ONE way of starting the server.

**`LAN_MODE=1` moves it into the process** (`server/lanMode.ts`). In LAN mode:

- `server/db/pool.ts` refuses to build a pool even with `DATABASE_URL` set, so every
  persistence call no-ops exactly as it does with no DSN at all. It is checked in that module's
  own body, not in the boot sequence, because the pool is built the moment anything imports it.
- `server/auth.ts` never verifies a token. A LAN server cannot learn who anybody is even if a
  client sends one.
- `ADMIN_USER_IDS`, `OWNER_USER_ID`, `ADMIN_SECRET` and the Ko-fi token are deleted from
  `process.env` at boot, before `server/index.ts` reads them into constants.

**`SERVE_CLIENT` without `LAN_MODE` refuses to start.** Serving the client is the one thing only
a self-hosted server does, so the two are one decision. Failing closed beats inferring
`LAN_MODE` from `SERVE_CLIENT`: the dangerous configuration is exactly the one where somebody
believed they were starting an ordinary server, and a process that quietly dropped the database
out from under a real deployment would be a worse surprise than one that will not boot. The
desktop launcher sets both, and passes an ALLOWLISTED environment rather than the parent's with
holes punched in it — so the next cloud secret anybody adds is not inherited on the day it
is introduced.

### The guest never hands the host a credential

`LobbyClient` attaches the Neon Auth JWT to `join` and `spectate`, and `Lobby.tsx` is the one
connect site that follows a LAN address. So a guest joining a classmate's laptop was handing it
a bearer credential for their real cloud account.

The strip is at the **transport send boundary** (`WebSocketTransport.send` +
`src/net/credentials.ts`), not at the two call sites: a rule enforced per call site grows a hole
every time somebody adds a message. The allowlist runs in the safe direction — credentials go
to a CONFIGURED CLOUD SERVER and nothing else — so a destination nobody has classified yet gets
the safe answer rather than the convenient one. `LAN_MODE` is the server half of the same rule.

### Rules this imposes

1. **A LAN match may never write `records`, `ranked_*`, ELO, or any `record_leaderboard`
   source.** Enforced by the schema, not by a `WHERE` clause someone can later refactor away.
2. **`sanitizeReplay` still applies.** `setups` reaches `createWorld`, so the container must be
   forced into a shape the sim can safely spawn regardless of where it came from.
3. **A LAN run does NOT credit `user_activity`.** `/api/lan` deliberately omits the
   `addActivity` call `/api/practice` makes. A practice run is at least bounded by the poster's
   own sim; a LAN match is bounded by nothing, so crediting games-played from one would make
   that counter forgeable by anyone willing to script against the endpoint.
4. **Participants are stored as NAMES, never user ids.** A guest may be signed out, and
   attributing a match to an account on the say-so of an untrusted machine is the same
   impersonation primitive that `LobbyPlayer.supporter` being server-authored exists to prevent.
5. **The badge/supporter fields stay server-authored.** A LAN server must not be able to
   declare anybody an owner or a supporter.

## Upload path — the host, not every client

The earlier draft had **every client upload its own copy**, which needed a dedup story and got
one (`matchId`). The owner's answer is simpler and strictly better: **the host uploads**.

What that removes: four uploads per match, four rows to reconcile, and the question of what to
do when two clients report different scores for the same `matchId`.

What it keeps, because these were right for reasons that still apply:

- **`matchId` is still the key**, because the *host's own* upload is still offered more than
  once — a timeout that actually succeeded, a reinstall, two tabs. `lan_runs.match_id` is
  `UNIQUE`, the first write by THAT HOST wins, so a retry is free. `npm run dbtest` covers it.
- ⚠️ **THE ID IS A CAPABILITY AND GOES TO THE HOST ALONE.** It used to ride `matchResult`,
  which is a broadcast, so every driver and every spectator got it — and the cloud has no way
  to know who really hosted a self-hosted match, so all it can check is that the uploader signed
  in and named an id. Whoever posted first took the row under their own account, and the real
  host's upload was answered with somebody else's match and marked done on the device. It is its
  own message now (`matchArchive`), sent to the host's socket immediately before the result, and
  the idempotence is scoped by host: a non-owner claiming a filed id gets **409**, not a silent
  win. Two protections against two different mistakes — the capability stops the claim, the
  ownership check makes a leaked one fail out loud.
- **Device first, account second.** A venue's connection is bad at exactly the wrong moment, so
  the run is stored locally and uploaded from a backlog, reusing the shape `practiceRuns.ts`
  already has. The host being required to be signed in does not mean required to be online at
  the final whistle.
- **The LAN server never handles anyone's credentials.** The rejected alternative — the LAN
  server collecting each player's Neon Auth JWT and forwarding them — means handing player
  tokens to a box the cloud has no reason to trust. That stays rejected.

⚠️ **The upload must go to the CLOUD, not to the server you are playing on.** A LAN box has
no database — it is started with a blank `DATABASE_URL` on purpose — so a match posted back to
it vanishes. The accessors are therefore split by SCOPE rather than by connection state:
`roomServerUrl*()` follows the LAN socket and `Lobby.tsx` is its only caller, while
`gameServerUrl()`/`gameServerHttpUrl()` stay the cloud throughout a LAN match. See "What the
split actually is" under **Order of work** for what went wrong the first time.

## Schema — BUILT (migration 0033)

`lan_runs`: `match_id` unique, `host_user_id` cascading, `game`, `balance_version` (the season,
so the replay purge sweeps it), `score` jsonb, `participants` jsonb, `replay_id`, `created_at`.
`LAN_KEEP` is 40 against `PRACTICE_KEEP`'s 10, because a team scrimmaging at a venue plays
matches back to back all afternoon. Pruning deletes the pruned runs' replays; `deleteAccount`
sweeps by `host_user_id`. See the migration's own comments and the 16 `dbtest` checks.

⚠️ **`replays.behaviour_version` must be populated** (see `CLAUDE.md`) or every stored LAN
replay reads back as `unstamped` and is refused by `replayPlayable` on every build. Migration
0031 handles it; the LAN path uses the same `saveReplay`, so this is inherited rather than
re-solved.

## Client UX

- **Hosting lives in the app, behind a signed-in gate.** A "Host a LAN game" action that starts
  the bundled server, shows the join URL big enough to read across a room, and says whether the
  port is actually reachable — a host behind a firewall is the single most likely support issue,
  and "it doesn't work" with no further information is the worst version of it.
- **Joining is a URL, not a field.** Guests type `http://<host>:8787` into a browser. There is
  still a "connect to a server" entry in the app for the host's own machine and for anyone who
  prefers it, remembered per device in its **own `localStorage` key** — not in `GameSettings`,
  which syncs to Postgres per account, because a LAN address is a property of *where you are*,
  not *who you are*. Same reasoning as the theme preference.
- **A persistent, unmissable "LAN — unofficial, not ranked" banner** whenever connected to a
  non-official server. This must be impossible to confuse with a ranked match; somebody who
  thinks they are climbing a leaderboard and is not has been actively misled.
- **The results screen says where it went**: "Saved to your account as an unofficial match",
  and when offline "Will upload when you're back online" — reusing the practice-run copy, which
  already says both of these things well.
- ⚠️ **If a guest reaches a LAN server from an https page anyway** (someone types the address
  into the app instead of the browser), the socket fails silently. The connect path must detect
  `location.protocol === 'https:'` against a non-localhost `ws://` target and say so —
  "Open http://192.168.1.5:8787 in your browser instead" — rather than showing a generic
  connection failure for something no retry will ever fix.

## Server packaging

- **Serve the client from the server**, gated on an env var pointing at a built `dist/`. Off by
  default, so the Fly deployment is unaffected: it has a CDN in front of it and must not start
  serving a stale bundled copy.
- **Ship `dist-server/` in the Electron build** and start it as a child process from the main
  process. The shell already bundles `dist`; adding the server bundle is a build-config change
  plus a spawn, not new server code.
- **Do not attempt NAT traversal or public self-hosting in v1.** LAN is a bounded, testable
  problem; "host a public server" invites port-forwarding support load and a moderation question
  (public server lists) nobody has asked for.

## Order of work

1. ~~`matchId` minted at `finalizeMatch` and carried in `matchResult`.~~ **DONE** — `42a6751`.
2. ~~Migration + `lan_runs` repo functions + `dbtest`.~~ **DONE** — `9bf2cf7`.
3. ~~`POST /api/lan` + the client upload module and its backlog drain.~~ **DONE** —
   `f2e227c` (the API and the URL split), and the drain is wired in step 6's commit.
   **The cloud-vs-LAN URL split in `env.ts` was the load-bearing part**, and it went
   wrong exactly where this said it would — see "What the split actually is" below.
4. ~~Static client serving on the game server, behind an env var.~~ **DONE** — `43b5982`.
5. ~~Electron: spawn the server, host panel, join URL, reachability check.~~ **DONE** —
   `1c6645d` (the main process) and `19a1cfd` (the panel).
6. ~~The banner, the https/ws diagnosis, and `npm run uiaudit` green.~~ **DONE** — `19a1cfd`.

### What the split actually is

The first version of `env.ts` made `gameServerUrl()` return `lanUrl || cloud`, which is the
obvious reading of "the client is connected to a LAN server" and is wrong in a way nothing
would have reported: RANKED, RECORDS and SPECTATE all read that accessor, so a player with a
LAN address stored would have queued for a rated match against a laptop in the same room.

So there are two families and the rule is flat:

- **`roomServerUrl()` / `roomServerUrlWith()` / `roomServerConfigured()`** follow a LAN
  connection. `src/ui/Lobby.tsx` is their ONLY caller — a custom room is the one thing that
  may be hosted on somebody's laptop.
- **`gameServerUrl()` / `gameServerHttpUrl()`** are ALWAYS the cloud, including while a LAN
  match is being played. `uploadLanRun` depends on this: the match is posted to the cloud
  from a client sitting on a LAN socket.

### Three more decisions this took

- **Origin adoption** (`src/net/lanAdopt.ts`). A guest is told "open
  `http://192.168.1.5:8787`", and that address IS the server, so asking them to type it into
  a panel afterwards is asking them to repeat themselves. The client probes its OWN origin:
  `http:` only, private host only, `/health` must answer `ok` within 2s. The probe is what
  separates a LAN host from `npm run dev` on `localhost:5173`.
- **The build-skew warning** (`checkSkew` in `LanPanel`). The desktop shell loads the LIVE
  site when it can, while the server it starts serves the `dist/` that shipped in the
  installer — so the host can be running a different build from every guest, and a
  CODE-JOINED room has no build segregation to catch it. It is a warning with a one-click
  fix (play through `http://localhost:<port>`), not a block: the two are usually identical,
  and the check needs the server up to answer at all.
- **The host keeps the match, not every client** (`keepLanRun` in `App.tsx`). Three
  conditions, each load-bearing: `lanActive()` (a cloud match is written by the server that
  ran it), `isHost()` (the owner's "whoever is hosting the match from the computer" — one
  uploader, so there is no dedup problem), and a present `matchId` (an older LAN server
  mints none, and an unkeyed row would re-upload as a new match on every retry).

Steps 3 and 4 were independent of each other and of the UI.
