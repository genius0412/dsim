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

### Closing alpha, adding testers, posting a banner

Rules in `docs/area/accounts.md` (lockdown, access groups) and `docs/area/netcode.md` (site
status). Everything below also works from the admin console: **Live** (lockdown), **Access**
(testers), **Server** (banners). An admin signs in on the closed screen and gets through.

**Closing alpha takes two switches, and they do different jobs.**

1. *The server lockdown* (a database row on dsim-alpha) is what REFUSES: joins, queueing,
   spectating, LAN, every write, for anyone who is not an admin or in a listed group. It
   carries the message and the button. Needs the alpha server on this build (migrations
   0051/0052 run at boot), so deploy it first: `./scripts/fly-deploy.sh --alpha`.
   ```bash
   GS=https://dsim-alpha.fly.dev   # ADMIN_SECRET = dsim-alpha's own secret
   curl -fsS -G -X POST "$GS/api/admin/maintenance" \
     --data-urlencode "active=1" \
     --data-urlencode "scope=site" \
     --data-urlencode "msg=The alpha is open to testers only. DSIM itself is open as usual." \
     --data-urlencode "redirect=https://playdsim.com" \
     --data-urlencode "redirectLabel=Go to DSIM" \
     --data-urlencode "bypass=beta,dev,contributor" \
     --data-urlencode "secret=$ADMIN_SECRET"
   curl -s "$GS/api/status"        # lockdown.scope "site", biting true
   ```
   No `startsAt`/`endsAt`: it bites now and lasts until lifted (`active=0`, same curl).
2. *The build flag* makes the alpha SITE start closed, so the closed screen is the first thing
   anyone sees even with the alpha server asleep or down. Vercel → Environment Variables →
   `VITE_SITE_LOCKDOWN` = `1`, scoped to the `alpha` branch (`vercel env add VITE_SITE_LOCKDOWN
   preview alpha`), then redeploy the branch. A baked-closed build opens only for an account
   the server confirms (admin or any group), so set it AFTER step 1's deploy: against an older
   server nobody, admins included, can be confirmed.

If the alpha server is down, the alpha site stays closed (the flag) and testers cannot get in
until it is back; the closed screen says it could not check. Production has no flag and fails
open. Reopening alpha: lift the lockdown and remove the flag.

**Adding testers** (per deployment: alpha testers are added on alpha). A tag is a display
name, an @username or an account id; a player who has never signed in on alpha is not in
its database yet, and signing in once on the closed screen fixes that.
```bash
curl -fsS -G -X POST "$GS/api/admin/access" --data-urlencode "action=grant" \
  --data-urlencode "group=beta" --data-urlencode "tag=PlayerOne" --data-urlencode "secret=$ADMIN_SECRET"
# a list, one tag per line (group = beta | dev | contributor):
curl -fsS -X POST --data-binary @testers.txt "$GS/api/admin/access" --url-query "action=bulk" \
  --url-query "group=beta" --url-query "secret=$ADMIN_SECRET"
curl -fsS -G "$GS/api/admin/access" --data-urlencode "secret=$ADMIN_SECRET"   # the list
```
The bulk answer names every tag that did not resolve. Revoke: `action=revoke&group=…&userId=…`.

**Posting a banner** (production shown; any server):
```bash
GS=https://dohun-sim-decode.fly.dev
curl -fsS -G -X POST "$GS/api/admin/banners" --data-urlencode "action=create" \
  --data-urlencode "kind=known-bug" \
  --data-urlencode "msg=Ramp robots can stick on a hive foot bar. [Tracking](https://github.com/…)" \
  --data-urlencode "game=biobuzz" --data-urlencode "secret=$ADMIN_SECRET"
curl -fsS -G "$GS/api/admin/banners" --data-urlencode "secret=$ADMIN_SECRET"   # ids
curl -fsS -G -X POST "$GS/api/admin/banners" --data-urlencode "action=end" \
  --data-urlencode "id=12" --data-urlencode "secret=$ADMIN_SECRET"
```
`kind` is `info`, `known-bug` or `warning`; optional `game`, `channel` (`stable`/`alpha`),
`startsAt`/`endsAt` (ms). `action=update&id=…` edits it and shows it again to players who
closed it. Every machine shows a change within ~5 s.

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

## Deploy ORDER when the wire protocol moved — client first, then server

Normally the two deploys are independent and the order does not matter: the server accepts
every client build it has ever shipped, and a client that is one server behind still plays.
**The 2026-09-19 publish of `alpha` to `main` is not that case**, and the same shape will
recur whenever a server starts REFUSING clients that lack a capability.

The new server runs every BIOBUZZ room in 3D physics (`serverPhysics`, owner ruling
2026-09-18) and refuses a client that does not advertise `bb3d` in its `caps`
(`BB3D_REFUSAL`, `server/index.ts`). Every production client built before this publish
lacks it. So:

- **Fly before Vercel** locks every production BIOBUZZ player out of every BIOBUZZ room
  until Vercel catches up and their tab reloads. DECODE and Chain Reaction are unaffected.
- **Vercel before Fly** (the right order) leaves a window in which a NEW client plays a
  BIOBUZZ solo record on the OLD server. That run is 2D, is accepted and shown a rank, and
  becomes board-invisible the moment the new server boots, because every pre-existing
  record row is stamped `physics = '2d'` by migration `0039` and BIOBUZZ boards are
  filtered to `'3d'` by `boardPhysics` (`server/db/repo.ts`). The window is as long as you
  make it: minutes if the Fly deploy follows the Vercel one directly.

The order, then:

1. Merge to `main`. Vercel builds it automatically; wait for the deployment to be READY
   and load `playdsim.com` once to confirm the new client is what it serves.
2. From a **main** worktree (never the alpha tree — `fly-deploy.sh` builds whatever tree it
   runs in): `./scripts/fly-deploy.sh`, or the announce-first `announce-deploy.sh` if
   `/api/presence` shows anyone online.
3. Watch `/health` and the Fly logs for the first BIOBUZZ room to open in 3D.

⚠️ **Every BIOBUZZ record and personal best set before this publish disappears from the
boards** — not deleted, filtered: they are `'2d'` rows on a board that now shows `'3d'`.
They come back when the season holding them is archived: `boardPhysics` reads an archived
season as the solve it was played on (2026-09-24), so rolling BIOBUZZ into Act 2 right after
the deploy turns Act 1 into a 2D board and pays its record holders. Roll before anyone sets a
3D record in the old season.

If a zero-window deploy is ever needed, the alternative is an env flag in front of
`serverPhysics`/`boardPhysics`/`stagedPhysics` (deploy dark, flip after Vercel). It was
NOT built for this publish; the reversed order above is the whole mitigation.

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
may be online, deploy through the announce wrapper instead: it posts a restart
countdown banner, waits, then runs `scripts/fly-deploy.sh` and polls `/health`. The
countdown is a database row (0052), so players on EVERY region see it within ~5 s; before
that it reached only the machine the curl landed on.

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
fly scale count 1 --region ord -a dohun-sim-decode
fly scale count 1 --region sjc -a dohun-sim-decode
fly scale count 1 --region lhr -a dohun-sim-decode
fly scale count 1 --region gru -a dohun-sim-decode   # São Paulo
fly scale count 1 --region jnb -a dohun-sim-decode   # Johannesburg
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
  `ord`/`sjc` plus the far satellites `lhr`/`gru`/`jnb`/`syd`/`nrt` — runs the much cheaper
  `shared-cpu-1x`/512MB. fly.toml has only ONE `[[vm]]`, and **`fly deploy` re-applies it
  (`shared-cpu-4x`) to every machine — silently UPSIZING the satellites off their cheap
  size.** A region added with `fly scale count` inherits that same `[[vm]]`, so a NEW
  satellite is born at `shared-cpu-4x` too and is only shrunk once it is listed in the
  script's `SATELLITES`. So always deploy with **`scripts/fly-deploy.sh`** (deploy +
  re-shrink the satellites) rather than a bare `fly deploy`. Verify after: `fly machine
  list -a dohun-sim-decode` should show `iad` at `shared-cpu-4x:1024MB` and every other
  region at `shared-cpu-1x:512MB`.
- **There is NO Middle East region on Fly** (`fly platform regions` is the authority, and
  Africa has only `jnb`). The nearest machine for those players is `lhr`; `fra` would be
  marginally closer and is the one to add if it ever matters.
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

**The audit behind "more processes" is `docs/scaling-multicore.md`**, and it is where this
question actually gets answered rather than only warned about: ~75% of a busy server is
simulation that can leave the socket thread, `Room` already talks exclusively through callbacks,
and the recommendation is `worker_threads` behind a `SIM_WORKERS` variable defaulting to 0.
**Nothing of it is built** — `SIM_WORKERS` and `worker_threads` appear nowhere in the source — so
until it is, the row above is the honest ceiling and a bigger VM is still the wrong purchase.

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
`region_full` and the client offers another region. Unlimited off Fly. On Fly it is **24 on the
primary (iad)**, **10 on a dedicated-core satellite and 6 on a shared one** —
`SATELLITE_MAX_ROOMS_DEDICATED` / `SATELLITE_MAX_ROOMS` in `scripts/fly-deploy.sh`, applied with `--env MAX_ROOMS=` on the `fly machine update` loop, because `fly deploy` regenerates
machine config from `fly.toml` and would revert a hand-set value. The satellites run
`shared-cpu-1x`, which fly.toml's own note puts at "≈ ONE busy room" and the table above gives 3–5
with margin, so the 24 sized for iad was not a guard there at all.
**A finished match does not count** (`Room.holdsCapacity`): it has stopped stepping but stays in the
registry while its players read the results screen, which has no timeout. Counting those made lhr
refuse every new room at "6/6" on 2026-09-25 with two live matches and a quarter of a core in use.
`/api/perf` reports both `rooms` (live matches) and `capRooms` (what the cap counts).
24 is deliberately above the redline (~13 driven rooms/core, 8–10 with margin — see the table
above and `docs/capacity.md` §2/§4) — it is a **runaway guard, not a measured safe-load
admission and not a tuning knob**: most rooms are parked rather than driven, and a cap set at the
redline would refuse players while the machine still had headroom. The constant's comment in
`server/index.ts` says the same; if you change one, change the other — and there are now THREE
places, the constant, this paragraph and `SATELLITE_MAX_ROOMS`.
⚠️ **`MAX_ROOMS=0` disables it, but it is NOT a durable rollback lever on a satellite.** A
hand-set env survives only until the next `./scripts/fly-deploy.sh`, whose re-shrink loop writes
`MAX_ROOMS=$SATELLITE_MAX_ROOMS` back over it. To disable the cap fleet-wide for real, set
`SATELLITE_MAX_ROOMS=0` and `SATELLITE_MAX_ROOMS_DEDICATED=0` in the script and deploy.
⚠️ **A cap that BITES costs a rated match.** The cap gates room CREATION on the same `join` path a
matchmaker-staged room takes, and `bestHost` is not load-aware — so a satellite at its cap refuses
the room, nobody connects, `RANKED_JOIN_GRACE_MS` lapses and `cancelPending` charges the innocent
players a no-show dodge. True at 24 as well; a low cap makes it reachable sooner. If `/api/perf`
shows a dedicated-core satellite refusing with headroom to spare, raise it toward 13 rather than
back to 24.

**`MAX_SPECTATORS_PER_ROOM`** (24) and **`MAX_SPECTATORS`** (192) cap watchers per room and per
machine. `MAX_ROOMS` bounds how many matches a machine *simulates* and nothing bounded how many
people *watch* one — a spectator takes the same 30 Hz snapshot stream a driver does and reaches
it without a room slot or a sign-in. Past either cap the `spectate` is refused with a plain
message (deliberately **not** `region_full`: the room exists only on this machine, so "try
another region" would be wrong advice). Same class of number as `MAX_ROOMS` — a runaway guard.
`0` on either disables that cap. A hidden admin observer counts against them.

**`WS_COMPRESS=0`** disables snapshot compression (permessage-deflate, context takeover at
**windowBits 15 / memLevel 8** — the 13/6 an earlier version of this line quoted was superseded;
see the correction in `docs/capacity.md` §6). On by default; worth ~80% of outbound bytes and
~64 KB of memory per socket. This is the rollback if the snapshot gap regresses. `false`, `no`
and `off` work too, in any case — it is a lever somebody reaches for under load and it used to
accept only the literal string `0`.

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

### Security headers, and why framing is an ALLOWLIST rather than `'none'`

`vercel.json` sends `Referrer-Policy`, `X-Content-Type-Options` and a `Content-Security-Policy`
carrying one directive: `frame-ancestors`. They landed on 2026-09-19 because the one-click
consent controls were frameable, which is a clickjacking target.

⚠️ **`frame-ancestors` MUST keep naming Discord, and `X-Frame-Options` MUST stay gone.** A
Discord Activity IS an iframe: the client is served through the proxy at
`<app-id>.discordsays.com` and framed by the Discord client. `frame-ancestors 'none'` therefore
forbids the whole activity, and it fails the way this repo hates most — no error anywhere, just
a blank or refused embed inside Discord, on a surface no audit here loads. It shipped that way:
the headers landed on 2026-09-19 (`f993507`) and the activity merged on 2026-09-21 (`eae5b98`),
while the last time anyone drove the activity in a real embed predates both. The two changes are
each correct alone and were never once seen together.

The allowlist is `'self'` plus `discord.com`, `*.discord.com` (canary and ptb) and
`*.discordsays.com` (the proxy origin, and any nesting inside it). Ordinary cross-origin framing
is still refused, which is the attack `f993507` was closing.

⚠️ **It is weaker than `'none'` by exactly those four sources, and `*.discordsays.com` is the
loose one**: it admits ANY Discord developer's proxy origin, not only ours, so a third party
could map this site into their own activity. What defuses it is that a proxied document is
served FROM the `discordsays` origin, so it carries none of this site's cookies or
`localStorage` — the frame is signed out, with no stored consent state to clickjack and no
session to act on. That is why the wildcard is kept rather than trimmed to `'self'`: the cost
is near zero, and guessing wrong in the other direction re-breaks the embed silently, which is
the whole bug this section exists to prevent.

`X-Frame-Options: DENY` was REMOVED rather than kept beside it, because that header has no
allowlist — `ALLOW-FROM` is dead in every current browser, so `DENY` is the only thing it can
say, and anything that honours it over the CSP blocks the activity. Every browser that supports
`X-Frame-Options` but NOT `frame-ancestors` is too old to run this app at all — the physics is
WebAssembly and the bundle is ESM — so nothing real loses cover.

## 3. Local dev

```bash
npm run server      # tsx watch on ws://localhost:8787
# .env:  VITE_GAME_SERVER_URL=ws://localhost:8787
npm run dev         # Vite on http://localhost:5173
```

## 4. Auth — password reset, email verification, terms (OWNER dashboard work)

The three flows are BUILT and deployed with the client and the game server. Two of them do
nothing at all until the Neon Auth project is configured, and that configuration is not in
this repo — it is clicking, in the Neon console, by whoever owns the project. This section is
the checklist, in the order it has to happen.

**What is already live without touching anything:** the "Forgot password?" link, the
`/account/reset` and `/account/verify` screens, the terms checkbox on sign-up, and the
blocking terms dialog. The terms half needs only the game server (migration `0040` applies at
boot) and works today.

**What needs the dashboard:** anything that sends an email. Better Auth generates the token
and calls its mailer; Neon Auth's hosted project owns the mailer, so with no sender configured
`requestPasswordReset` / `sendVerificationEmail` still answer `200` and no mail is ever sent.
That failure is SILENT by design (see `src/lib/authFlows.ts` on enumeration), so do not read a
green form as proof that mail works — send yourself one.

### Step 1 — a sender domain

1. Neon console → the project → **Auth** → **Emails** (or **Settings → Email**).
2. Set the **sender address** to an address on a domain you control, then add the DNS records
   the console gives you (SPF, DKIM, and a DMARC record if it asks). Mail from an unverified
   domain lands in spam or is dropped outright, which looks exactly like the flow being broken.
3. Send the console's **test email** to yourself and confirm it arrives in an inbox, not a
   spam folder.

### Step 2 — the two templates and where they land

Both emails contain a link the auth server generates; the app supplies where that link should
come back to, so there is nothing to type here except the wording.

- **Reset password** — the client passes `redirectTo` = `<origin>/account/reset`, and the auth
  server appends `?token=…`. On a Vercel PREVIEW the origin is that preview's own host, so a
  preview's reset links come back to the preview. Under Electron there is no usable origin and
  the link points at `https://www.playdsim.com/account/reset` (`appUrl` in
  `src/lib/authFlows.ts`).
- **Verify email** — same shape, `callbackURL` = `<origin>/account/verify`.

⚠️ **If the console has an allow-list of redirect URLs, every origin has to be on it**:
`https://www.playdsim.com`, the alpha/beta hosts, and `http://localhost:5173` for dev.
A redirect the auth server does not recognise is refused, and the person sees a link that
goes nowhere.

### Step 3 — require verification (optional, and do it LAST)

Neon console → **Auth** → sign-in methods → **require email verification** for
email/password. This stops an unverified account from signing in at all — it is the provider's
switch, not ours.

### Step 4 — the server-side gate (a Fly secret, and it is OFF by default)

```bash
flyctl secrets set REQUIRE_VERIFIED_EMAIL=1 -a dohun-sim-decode
```

Off, `emailGateRefusal` (`server/auth.ts`) always passes. On, an account whose address is not
verified is refused three things and nothing else:

| refused | where | what they see |
|---|---|---|
| ranked queueing | `queue`, the fourth door in `server/index.ts` | "Verify your email to play ranked…" |
| joining a record room | the join door, `server/index.ts` | "Verify your email to save a record run…" |
| `POST /api/practice` (saving a run) | `server/api.ts`, 403 | the same sentence |

Casual rooms, free drive, practice PLAY, spectating and the whole single-player game stay
open, signed in or not.

⚠️ **SET IT ONLY AFTER STEP 1 WORKS.** Verification has never existed here, so every
email/password account on the live site is currently unverified. Turning the gate on before
mail is deliverable refuses ranked to all of them at once and the Resend button on their
Profile page cannot help. Order: deploy → mail works → let people verify → set the secret.
Google sign-ins are unaffected throughout (the provider vouched for the address, so they
arrive verified).

⚠️ **AND CHECK THE TOKEN CARRIES THE CLAIM FIRST.** The gate reads `email_verified` (or
`emailVerified`) off the verified JWT. Whether Better Auth's JWT plugin puts it there is a
property of the project's configuration, and if it is absent the server falls back to ONE
cached `GET /get-session` per token — which may itself answer nothing, in which case the
verified state is `null` and the gate PASSES (deliberately: a gate that refuses what it
cannot read would take ranked down silently). So before trusting the switch, sign in as a
test account and read `/token`'s payload; if neither the claim nor the session lookup
answers, the secret is a no-op and turning it on proves nothing.

### Step 5 — when the legal text changes

`LEGAL_VERSION` in `src/legalText.ts` is derived from `LEGAL_UPDATED`. Move that date and
every signed-in account is asked to accept once, on their next load, by a blocking dialog
whose only other button is Sign out. That is the intent — but it is a prompt in front of
every player, so move it for a material change and not for a typo. It is a CLIENT change
(Vercel) and a SERVER change (the route records the server's own constant), so deploy both or
the dialog will keep coming back.

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

---

## Vercel deployments: only `main` and `alpha` build

Every push to every branch used to create a Vercel deployment and a preview build. On a Hobby
project builds run one at a time and deployments count against a daily limit, so a day of pushes
to feature branches queued the ALPHA build behind previews nobody opened — and 500+ old preview
deployments had accumulated by 2026-09-18.

`vercel.json` now does two things:

- **`ignoreCommand`** skips the build for any branch other than `main` and `alpha` (exit 0 = skip,
  exit 1 = build; Vercel's "ignored build step"). A skipped push still creates a deployment
  record marked canceled, which costs no build minutes.
- **`git.deploymentEnabled`** turns auto-deployment OFF entirely for the branches we push most
  (`biobuzz-3d`, the `feat/*` branches, …). The map takes exact branch names only — add a new
  long-lived branch there when you create it.

**Pruning what already accumulated** — the owner runs it, with a token from vercel.com → Account →
Tokens passed through the environment (never on the command line, never in the repo):

```bash
VERCEL_TOKEN=… node scripts/vercel-prune.mjs --project dsim --days 14          # dry run: lists
VERCEL_TOKEN=… node scripts/vercel-prune.mjs --project dsim --days 14 --yes    # deletes
```

It never deletes a production deployment, anything still carrying an alias, or the newest
deployment of any branch. Deleting is permanent. To see which build a site is serving:
`curl https://alpha.playdsim.com/version.json`.
