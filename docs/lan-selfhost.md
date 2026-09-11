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
  `UNIQUE` and the first write wins, so a retry is free. `npm run dbtest` covers it.
- **Device first, account second.** A venue's connection is bad at exactly the wrong moment, so
  the run is stored locally and uploaded from a backlog, reusing the shape `practiceRuns.ts`
  already has. The host being required to be signed in does not mean required to be online at
  the final whistle.
- **The LAN server never handles anyone's credentials.** The rejected alternative — the LAN
  server collecting each player's Neon Auth JWT and forwarding them — means handing player
  tokens to a box the cloud has no reason to trust. That stays rejected.

⚠️ **The upload must go to the CLOUD, not to the server you are playing on.** When a LAN
connection is active, `gameServerUrl()` points at the host's laptop; every read API and the
upload must keep resolving to the configured official server. These have to be two different
accessors, or the first LAN match posts itself to a box with no database and vanishes.

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
3. `POST /api/lan` + the client upload module and its backlog drain. **The cloud-vs-LAN URL
   split in `env.ts` is the load-bearing part**, and it is where this most easily goes wrong.
4. Static client serving on the game server, behind an env var.
5. Electron: spawn the server, host panel, join URL, reachability check.
6. The banner, the https/ws diagnosis, and `npm run uiaudit` green.

Steps 3 and 4 are independent of each other and of the UI.
