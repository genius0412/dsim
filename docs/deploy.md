# Deploying the multiplayer stack

Two independent deploys: the **client** (static, Vercel — unchanged) and the
**game server** (`server/`, a small always-on Node process). They are wired
together by one env var, `VITE_GAME_SERVER_URL`.

---

## The ALPHA preview server (a second Fly app)

The `alpha` branch's Vercel deployment talks to its **own** game server and its **own**
database, so preview features can be tested for real instead of being walled off.

**Why a separate app rather than another region.** One app served every client version, and
an in-development build had to be quarantined inside it: the matchmaker keeps alpha entries
in their own pool, and alpha results were *never written to the database*. That second rule
is what made the preview only half-usable — standing, dodge penalties, reports, playtime and
ranked all exist BY writing to Postgres, so on the shared server they silently no-op and
there is nothing to look at. With its own app and its own database, the alpha server
persists normally (`SERVER_CHANNEL=alpha`, see `server/channel.ts`) and production cannot
see any of it, because it is not connected to that database.

The client-channel segregation stays regardless — a browser tab can point anywhere, so the
stable server still refuses to persist an alpha build's results.

### One-time setup

**1. Create the app** (name must match `fly.alpha.toml`'s `app =`):
```bash
fly apps create dsim-alpha
```

> ONE MACHINE, always. `./scripts/fly-deploy.sh --alpha` passes `--ha=false` because Fly's
> default launches a second machine for high availability — and for this server that is not
> redundancy, it is a SPLIT. Rooms live in the process's memory and the routing hints resolve
> to a REGION, not a machine, so two machines in one region put two players in two different
> rooms with the same code. If you ever see two machines in `fly machine list`, destroy one.

**2. Make a Neon branch for it.** In the Neon console → your project → **Branches** →
**New branch** off `main`, name it `alpha`. Copy its pooled connection string. A branch is
copy-on-write, so this costs approximately nothing and starts as a snapshot of production —
which is what you want: real profiles to test standing and reports against.

**3. Set the secrets** (the same ones production has, with the alpha database):
```bash
fly secrets set -a dsim-alpha \
  DATABASE_URL='postgresql://…the ALPHA branch…' \
  NEON_AUTH_URL='…same as production…' \
  ADMIN_USER_IDS='…your uuid…' \
  ADMIN_SECRET='…any long random string…'
```
Double-check `DATABASE_URL` before the first deploy: it is the one setting that decides
whether alpha writes land in the preview or in production. Migrations run at boot, so the
alpha branch self-migrates on the first start.

**4. Deploy:**
```bash
./scripts/fly-deploy.sh --alpha
```
Then verify: `curl https://dsim-alpha.fly.dev/health`

**5. Point the alpha site at it.** In Vercel → Project → **Settings → Environment
Variables**, scoped to the **Preview** environment (or the `alpha` branch specifically):

| Variable | Value |
| --- | --- |
| `VITE_GAME_SERVER_URL` | `wss://dsim-alpha.fly.dev` |
| `VITE_GAME_SERVERS` | `[{"id":"alpha","label":"Alpha preview","region":"iad","url":"wss://dsim-alpha.fly.dev"}]` |
| `VITE_APP_CHANNEL` | `alpha` |

Scope them to the **`alpha` git branch** (`vercel env add NAME preview alpha`), not to Preview
as a whole — Preview covers every branch, and production must keep pointing at production.

`VITE_GAME_SERVERS` is the one that is easy to miss: it is the multi-region list, and
`src/net/env.ts` reads it FIRST — a `VITE_GAME_SERVER_URL` set beside it is ignored. Setting
only the single URL leaves the preview talking to the production servers.

These are baked in at build time, so redeploy the branch after changing them.

### Deploying afterwards

```bash
./scripts/fly-deploy.sh --alpha     # preview  (fly.alpha.toml, one region)
./scripts/fly-deploy.sh             # production (fly.toml, re-shrinks satellites)
```
Never a bare `fly deploy` for either: without `-c` it reads `fly.toml`, which would deploy
the production config under whichever app name it was given.

### What is different about it

| | production | alpha preview |
| --- | --- | --- |
| regions | iad + sjc/lhr/syd/nrt | iad only |
| always-warm machine | yes (the matchmaker) | no — idles to zero, wakes on connect |
| VM | shared-cpu-4x (iad) | shared-cpu-2x |
| database | production Neon | the `alpha` Neon branch |
| alpha results persist | never | yes |

Cost is close to zero while nobody is testing: the machine stops when idle and Fly bills
only the rootfs.

### Protocol compatibility still matters, just less

Two apps means the preview no longer has to prove its protocol changes against production
traffic. But `main` and `alpha` still share a database *schema lineage* and the same client
code paths, so keep new fields additive and keep feature-gating on `caps` — a merge to main
should not need a coordinated redeploy.

---

## Beginner quickstart — Fly.io game server (≈10 min)

Fly is CLI-driven; its **website** handles the account, billing, and dashboards, and a
handful of terminal commands do the deploy. You do **NOT** need Docker installed — Fly
builds the image on their servers.

**A. On the website (fly.io)**
1. Go to **https://fly.io** → **Sign Up** (email or GitHub). This creates an
   "organization" for you automatically.
2. Open the dashboard → **Billing** → **Add a payment method** (a card is required even
   for tiny usage — abuse prevention). One small always-on machine for this server is
   roughly **$2–5/month**.

**B. Install the Fly CLI (`flyctl`)** — one command in **PowerShell**:
```powershell
iwr https://fly.io/install.ps1 -useb | iex
```
Close and reopen the terminal so `fly` is on your PATH. (Verify with `fly version`.)

**C. Log in** (opens your browser to confirm):
```powershell
fly auth login
```

**D. Pick a unique app name.** Open `fly.toml` (repo root) and change the first line —
app names are global, so `decode-game-server` is likely taken:
```toml
app = "decode-server-yourname"   # letters/numbers/dashes, must be unique
```
Also set `primary_region` to the code nearest your players (e.g. `iad` US-East,
`lax` US-West, `lhr` London, `syd` Sydney).

**E. Create + deploy** — run these from the project folder (`d:\Projects\2ddecodesim`):
```powershell
fly launch --no-deploy   # detects Dockerfile+fly.toml; when it asks to copy the existing config, say YES; skip Postgres/Redis
fly deploy               # builds + ships (first build ~2-3 min)
```

**F. Get your URL.** After deploy: `https://<your-app>.fly.dev`. Test the health check
in a browser — it should print `ok`:
```
https://<your-app>.fly.dev/health
```
Your client uses the **wss://** form: `wss://<your-app>.fly.dev`.

**G. Wire the client** (see §2 below): set `VITE_GAME_SERVER_URL=wss://<your-app>.fly.dev`
on Vercel and redeploy.

Useful later: `fly logs` (live output), `fly status` (machine health), `fly apps destroy
<app>` (tear it all down and stop billing).

### Prefer clicking to typing? (Render.com — fully web-based alternative)
If you'd rather not touch a terminal at all, **Render.com** deploys this same
`Dockerfile` straight from a GitHub repo through its website: New → **Web Service** →
connect the repo → it auto-detects the Dockerfile → set the env var `PORT` isn't even
needed (Render injects it) → Create. You get a `wss://<name>.onrender.com` URL to put in
`VITE_GAME_SERVER_URL`. (Render's free tier sleeps when idle and cold-starts on the next
connection; a paid instance stays warm — same tradeoff as Fly's `auto_stop`.) Railway
works the same way.

---

## 1. Game server → Fly.io (reference)

The server is a single stateless process (all match state lives in memory). Files:
`Dockerfile`, `fly.toml`, `.dockerignore` (repo root).

```bash
# one-time
fly launch --no-deploy        # pick a unique app name + region near your players
# every deploy (wrapper: deploys, then re-shrinks the satellite regions)
./scripts/fly-deploy.sh
```

- `fly.toml` exposes port 8080, forces HTTPS (so clients use `wss://`), auto-stops the
  machine when idle (`min_machines_running = 0`, `auto_stop_machines = 'stop'`) and
  auto-starts it on the next connection, and health-checks `GET /health` (with a 30s
  grace so a cold boot never flaps the machine). Set `min_machines_running = 1` to keep
  one machine warm and skip the first-connect cold start, at the cost of always-on
  billing for the warm machine.
- The Docker image is a 2-stage build: it esbuild-BUNDLES `server/index.ts` (+ the
  shared `src/sim`) to one plain-JS file, then runs it with plain `node`. This avoids
  transpiling the TS tree with `tsx` on every cold boot (~7s), so an auto_started
  machine is serving `/health` in well under a second.
- Your server URL is `wss://<app-name>.fly.dev`.
- Scale/CPU: the room loop runs a CONTINUOUS 60 Hz Rapier physics step. That is a
  sustained CPU workload, so the primary `iad` machine runs on `shared-cpu-4x` (4 shared
  vCPUs — enough parallel headroom that the 60 Hz loop never exhausts burst credits in
  practice; a smaller `shared-cpu-1x` throttles to a tiny baseline within a minute of play,
  stalling the event loop until even `/health` times out and the machine flaps "unhealthy").
  See fly.toml's COST-PASS note for the measured tradeoff vs. a dedicated `performance-1x`.
  `auto_stop_machines = 'stop'` +
  `min_machines_running = 1` keep ONE machine warm (the primary region = the
  designated `MATCHMAKER_REGION`, which ranked queueing routes to), while other regions
  idle to zero and cold-boot on first connect.

### Safe deploy — warn players, then deploy (`scripts/announce-deploy.sh`)

A bare deploy restarts the server process, dropping anyone mid-match. When players
may be online, deploy through the announce wrapper instead: it broadcasts a
`serverNotice` countdown banner to every connected client (and re-sends it to
anyone who joins during the window), waits, then runs `scripts/fly-deploy.sh` and
polls `/health`.

```bash
# one-time: authorize the announce endpoint from the CLI (no browser session)
fly secrets set ADMIN_SECRET='<random>' -a dohun-sim-decode

# every deploy when players may be online (5-min warning by default):
ADMIN_SECRET='<same value>' scripts/announce-deploy.sh "Server update — reconnecting shortly"
# custom wait (seconds); 0 = deploy immediately (use when /api/presence shows 0 online):
ADMIN_SECRET='<same value>' scripts/announce-deploy.sh "msg" 120
```

The `ADMIN_SECRET` must match the Fly secret of the same name; the announce endpoint
also accepts a signed-in admin's JWT (the Admin panel's "Announce restart" button does
the same thing manually). Check `GET /api/presence` first — if `online` is 0, you can
skip the wait. Keep `ADMIN_SECRET` out of git (it's only ever passed via env / the Fly
secret; never commit it).

### Multi-region (one app, one machine per region)

For a geographically spread player base, run the SAME app in several regions — this is
easier to manage than N separate apps and is what the client is built for (region-local
matchmaking + a fair-midpoint host via `fly-replay`; see `docs/netcodeplan.md` Phase 4).

```bash
./scripts/fly-deploy.sh                        # ship the image (NOT a bare `fly deploy` — see VM sizes below)
fly scale count 1 --region iad -a dohun-sim-decode   # one machine PER region
fly scale count 1 --region sjc -a dohun-sim-decode
fly scale count 1 --region lhr -a dohun-sim-decode
fly scale count 1 --region syd -a dohun-sim-decode
fly scale count 1 --region nrt -a dohun-sim-decode
fly secrets set MATCHMAKER_REGION=iad -a dohun-sim-decode   # holds the global ranked queue
```

- Keep it at **one machine per region** — two machines in one region re-split room/queue
  affinity (the matchmaker + rooms are in-process). The primary region stays warm
  (`min_machines_running = 1`); the rest auto-stop to ~$0 and wake on connect.
- Set `VITE_GAME_SERVERS` on Vercel to the region list, **all sharing the one app URL**
  (each entry differs only by `region`/`label`); the client adds a `?region=`/`?mm=`/`?room=`
  hint and the server `fly-replay`s the connection to the right region. See `.env.example`.
- Cross-region **ranked** also needs `DATABASE_URL` (the paired roster is staged in Postgres
  for the host machine). Region-local ranked and custom rooms do not.
- **`fly-replay` routing can only be verified on the deployed app** (the Fly proxy isn't in
  the loop on localhost) — after deploy, confirm a `?region=lhr` connection from the US lands
  on the `lhr` machine (`/api/presence` shows its region).
- **Per-region VM sizes + the deploy reset (IMPORTANT).** `iad` runs `shared-cpu-4x`
  /1024MB (the always-warm matchmaker; 4 shared vCPUs give the 60 Hz loop ample headroom
  without a dedicated vCPU's cost — see fly.toml's COST-PASS note); EVERY other region —
  `sjc` (joined 2026-07-20) plus the far satellites `lhr`/`syd`/`nrt` — runs the much cheaper
  `shared-cpu-1x`/1024MB. fly.toml has only ONE `[[vm]]`, and **`fly deploy` re-applies it
  (`shared-cpu-4x`) to every machine — silently UPSIZING the satellites off their cheap
  size.** So always deploy with **`scripts/fly-deploy.sh`** (deploy + re-shrink the
  satellites) rather than a bare `fly deploy`. Verify after: `fly machine list -a
  dohun-sim-decode` should show `iad` at `shared-cpu-4x:1024MB` and `sjc/lhr/syd/nrt` at
  `shared-cpu-1x:1024MB`.
- **Calibrating `INTER_REGION_MS`** (`server/regions.ts`): measure machine-to-machine RTT over
  Fly's 6PN mesh — from each region's machine, TCP-connect to another region's hallpass
  (`<region>.<app>.internal:22`, since the app binds IPv4-only so port 8080 isn't on 6PN) and
  time the handshake. Average both directions, drop into the matrix, redeploy. (Last measured
  2026-07-08.)

Any host that runs a container works (Railway, Render, a VPS with `npm ci --omit=dev &&
npm run server:start`); Fly is just the documented path. The only requirements are a
public TLS endpoint and a persistent process.

### Sizing — how many rooms fit on a machine

Measured 2026-09-10; full method and caveats in `docs/capacity.md`.

| | cores/room | rooms/core |
|---|---|---|
| DECODE, robots actively driven | **0.075** | **13.3** |
| DECODE, robots parked | 0.031 | 32.4 |
| Chain Reaction, driven | ~0.040 | ~25 |

⚠️ **The "~0.02–0.03 cores each" figure in `fly.toml`'s comments is the PARKED number.** It
matches an idle control run almost exactly and is ~2.4× cheaper than a room with people actually
driving in it. **Size on 0.075.**

⚠️ **A BIGGER VM DOES NOT BUY PROPORTIONALLY MORE ROOMS.** Node is single-threaded: the room
loop, snapshot encoding and socket writes all run on one event loop, so one server process is
capped at roughly one core no matter how many vCPUs the machine has. Going `shared-cpu-4x` →
`shared-cpu-8x` buys almost nothing. The levers that work are more *processes* (see below) or
cheaper rooms.

| size | est. driven DECODE rooms, with margin |
|---|---|
| `shared-cpu-1x` | 3–5 |
| `shared-cpu-2x` | 4–6 |
| `shared-cpu-4x` | 5–8 |
| `shared-cpu-8x` | 5–8 |
| `performance-1x` | 8–10 |

The shared-cpu rows are extrapolations and were **not** verified against a real Fly machine —
treat them as an ordering, not as values. `performance-1x` is the most trustworthy row because it
is closest to how the 13.3 figure was measured. Re-measure with
`./scripts/loadsweep.sh` per `docs/launch-load-test.md` §2 and replace this table with real numbers.

**`MAX_ROOMS`** (env) caps how many rooms a machine will host; past it, new rooms are refused with
`region_full` and the client offers another region. Default **24** on Fly, unlimited off it.
24 is deliberately above the redline — it is a runaway guard, not a tuning knob. `MAX_ROOMS=0`
disables it.

**`WS_COMPRESS=0`** disables snapshot compression (permessage-deflate, context takeover at
windowBits 13 / memLevel 6). On by default; worth ~80% of outbound bytes and ~64 KB of memory per
socket. This is the rollback if the snapshot gap regresses.

**`DB_POOL_MAX`** is 5 per machine. ⚠️ Past ~20 machines that is 100+ **direct** Neon connections;
switch to Neon's pooled (`-pooler`) connection string before going wide. Connections are free in
Neon's billing model — query *time* is what costs — so this is a limit question, not a cost one.

### Can a region run TWO machines? (designed, not built)

Not today, and the reason is worth stating precisely because it looks like a config change and
is not.

`fly-replay` targets a **region**: `server/index.ts` answers an upgrade with
`'fly-replay': 'region=<r>'` and Fly's proxy picks *any* machine there. Room codes resolve only
as far as a region — `routeTarget` reads `<region>-<code>` or an explicit `?region=` — so with two
machines in one region, two players sharing a code can land on different machines, each opening
an empty room with the same code. That failure is **silent on both screens**: a lobby of one, no
error anywhere. It is exactly the bug `roomJoinRegion` exists to prevent, reappearing one level
down.

So one machine per region is load-bearing, and `MAX_ROOMS` is what turns "the region is
oversubscribed" from a collapse into a refusal.

**What would make a second machine safe** is resolving a code to a *machine* rather than a region,
and then replaying to it precisely. Fly's `fly-replay` accepts `instance=<machine_id>` as well as
`region=`, so the routing half already exists. The missing half is a shared code → machine
registry — and that **also already exists**: the presence heartbeat upserts
`(MACHINE, REGION, localLive())` every 5 s, where `localLive()` is every room on that machine.

Sketch, in the order it would have to be built:

1. Resolve a bare or region-coded room code against the presence table at upgrade time; if it
   names a machine that is not this one, answer `fly-replay: instance=<id>`.
2. **Beat immediately on room creation.** A room registered only on the next 5 s heartbeat is
   invisible to a second joiner who arrives sooner, which reintroduces the split-lobby bug in a
   narrower window. `beatNow` is already wired for exactly this kind of call.
3. Decide what happens when the lookup misses (room genuinely new, or presence is stale). Falling
   back to "host it here" is what happens today and is what causes the split; falling back to a
   deterministic machine-of-the-region is safer.
4. Only then raise the machine count, and only in one region first.

⚠️ Do not raise `min_machines_running` above 1 per region as a way to add capacity — it adds
machines that room codes cannot reach correctly. It is a *warmth* control (avoiding cold boot),
not a *capacity* control.

## 2. Client → Vercel

Add the env var and redeploy (baked in at build time):

```
VITE_GAME_SERVER_URL=wss://<app-name>.fly.dev
```

Absent ⇒ the MULTIPLAYER menu is hidden and the solo game is unaffected (mirrors the
old `supabaseConfigured()` gating). For the Electron build, set the same var in the
shell before `npm run dist`.

## 3. Local dev

```bash
npm run server      # tsx watch on ws://localhost:8787
# .env:  VITE_GAME_SERVER_URL=ws://localhost:8787
npm run dev         # Vite on http://localhost:5173
```

## Transport note — WebSocket now, WebTransport later

Phase 0/1 ship on **WebSocket** (universal, works everywhere including Safari and
Electron). The `Transport` interface (`src/net/transport.ts`) is the seam for a
**WebTransport** (HTTP/3 / QUIC unreliable-datagram) implementation, which trims tail
latency on lossy networks. It is deliberately **not** implemented yet: WebTransport
requires a valid TLS certificate + HTTP/3 and can only be exercised against a real
`https://` deployment (not localhost-without-certs), so it should be added and
validated **on the deployed Fly instance**, with automatic WebSocket fallback behind
the same interface. Client prediction already masks the occasional lost packet, so
WebSocket is fully playable in the meantime.

Note: today's snapshots are delta-encoded but assume the **ordered, reliable**
WebSocket (no per-packet ack). WebTransport datagrams are unreliable, so adding it also
means acking snapshots (the `ackInputTick` field is already plumbed for this) and
keying deltas off the last **acked** tick instead of the last **sent** tick.
