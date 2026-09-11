# Launch load test — the human plan

For the BIOBUZZ kickoff (**2026-09-12**). Written 2026-09-11 on branch `perf-load`.

This is the plan a **person** runs against a **deployed** server. Everything in
`docs/capacity.md` was measured against a local server on a Windows laptop, and §0 of that
document explains at length why that box cannot measure latency at all. **Every threshold below
has to be established on Linux before it can be used as a pass/fail line.** That is the single
most important thing this exercise produces.

> **Deploys are owner-only.** Run `./scripts/fly-deploy.sh`. **Never `flyctl deploy`** — `fly.toml`
> expresses one `[[vm]]` size, so a bare deploy re-applies `shared-cpu-4x` to every machine and
> silently upsizes the cheap satellites. Verify afterwards with
> `fly machine list -a dohun-sim-decode`.

---

## 0. Before you start

| | |
|---|---|
| target app | `dsim-alpha` first. Only `dohun-sim-decode` once alpha is clean. |
| who can deploy | the owner, via `./scripts/fly-deploy.sh` |
| roll back | `WS_COMPRESS=0` (compression), `MAX_ROOMS=0` (admission cap) — both env, no code change |
| harness | `npx tsx scripts/loadtest.ts` from this branch |
| watch | `curl https://<app>/api/perf` |

Run the harness from a **Linux or Mac** box if you possibly can. On Windows it still measures
CPU and bytes correctly, but its own event-loop floor is ~15.6 ms, so it cannot distinguish a
healthy server from a mildly late one. The harness reports `harness.loopLagMs` for exactly this
reason — **if that number is in the same league as the server's, the harness is the bottleneck
and the run is void.** Split the load across machines instead.

---

## 1. Establish the Linux baseline — DO THIS FIRST

Nothing else in this document means anything until this step has run. The goal is one number:
**what does `/api/perf` `loopLagMs.p99` read on an idle, healthy Fly machine?**

```bash
curl -s https://dsim-alpha.fly.dev/api/perf?reset=1 > /dev/null
sleep 60
curl -s https://dsim-alpha.fly.dev/api/perf
```

Record `loopLagMs` `{mean, p50, p99, max}` with **zero** rooms.

- On Linux this should read **~1 ms**, not 15. The probe runs at `resolution: 1` specifically so
  that an idle loop reads what it actually is.
- If the idle p99 is already a large fraction of 16.67 ms on a real Fly machine, **stop** — the
  machine is too small or too noisy for 60 Hz and no amount of application tuning fixes it.

**Then fill in the table in `docs/capacity.md` §0.** Until it is filled in, that document's
latency rows say "not measurable" and they are honest; after this step they should say what the
real thresholds are.

---

## 2. Room ladder — where does one machine actually break?

```bash
./scripts/loadsweep.sh .loadtest-out/alpha solo 60 wss://dsim-alpha.fly.dev
npx tsx scripts/loadsummary.ts .loadtest-out/alpha
```

`STEPS` defaults to `1 2 4 8 12 16 24 32 40 48`; `GAP` defaults to 50 s and **must stay above
`RECONNECT_GRACE_MS` (45 s)** or the next step starts while the previous step's rooms are still
being held.

**What you are looking for is the first step where the promise breaks, not the CPU number.**
`/api/perf` `cores` is NOT a saturation signal on this server: past saturation `Room.startLoop`
sheds simulation time instead of consuming more CPU, so CPU flattens while every match stutters.
Measured locally, `cores` sat at 0.80–0.89 from 8 rooms to 48 while the snapshot gap p50 went
35 ms → 248 ms.

Record, per step:

| signal | healthy | the cliff |
|---|---|---|
| snapshot gap p50 | ~33 ms | drifting above ~45 ms |
| snapshot gap p99 | under ~100 ms | hundreds of ms |
| jitter | low and stable | rising sharply |
| `loopLagMs.p99` | well under 16.67 ms | approaching or past it |
| disconnects | 0 | anything above 0 |

The step before the first bad one is that machine size's honest capacity. **Write it into
`docs/deploy.md`.**

---

## 3. Verify the four changes on this branch

Each was measured locally; each needs confirming on Linux.

### 3a. Compression — the one that must not regress latency

This is the highest-value change and the only one with an unmeasured risk.

```bash
npx tsx scripts/loadtest.ts --rooms 8 --shape solo --secs 60 --url wss://dsim-alpha.fly.dev --nocompress
npx tsx scripts/loadtest.ts --rooms 8 --shape solo --secs 60 --url wss://dsim-alpha.fly.dev
```

- **Expect** `WIRE bytes/s per client` to fall to roughly **15–20% of payload**. Locally: 84,573 →
  16,915 B/s, −80%.
- **The thing to actually watch is the snapshot gap and jitter**, not the bytes. If p50 drifts off
  33 ms or jitter rises against the `--nocompress` arm, the original `perMessageDeflate: false`
  comment was right and `WS_COMPRESS=0` turns it off.
- Also check `rssMb`. Each socket holds a 64 KB deflate context; 1,000 sockets is ~63 MB of
  windows plus ws's own buffers.

### 3b. Admission control

```bash
# with MAX_ROOMS deliberately low on a scratch machine
npx tsx scripts/loadtest.ts --rooms 10 --shape solo --secs 20 --url wss://<scratch>
curl -s https://<scratch>/api/perf   # expect admitting=false, rooms==maxRooms
```

Expect the surplus clients to report *"This region is busy. Pick a different region and try
again."* and `/api/perf` to show `admitting: false`.

**Then check it in a browser**, which is the half the harness cannot see: the Lobby should show
the busy message plus the hint that the connection is fine and another region will work, with the
region picker usable. Default on Fly is `MAX_ROOMS=24`.

### 3c. Ghost rooms

```bash
npx tsx scripts/loadtest.ts --rooms 12 --shape solo --secs 20 --url wss://dsim-alpha.fly.dev
# then, immediately and repeatedly for ~45s:
curl -s https://dsim-alpha.fly.dev/api/perf
```

Expect `rooms: 12`, `players: 0`, and **`cores` near zero**. Before the fix this held 0.556–0.769
cores for the whole grace window.

⚠️ **Also confirm the behaviour change by hand**: a match now PAUSES while every driver is
disconnected. Drop both clients in a 1v1 mid-match, wait ~10 s, reconnect one — the match should
resume where it left off rather than having run on without them.

### 3d. Input bound

Covered by `npm test` (6 checks). Nothing to do live, but if anyone reports a robot that stops
responding to its own driver, `MAX_INPUT_LEAD_TICKS` in `server/room.ts` is the first place to look.

---

## 4. Multi-region and the paths the harness cannot reach

The harness drives the **room-code** path only. These need real clients.

- **Matchmaker / `queue` path.** `--path queue` is unimplemented and refuses without `--tokens`,
  because the server requires a verified Neon Auth JWT and there is no dev bypass. **Two signed-in
  accounts completing a rated match is still the only end-to-end check of the background ranked
  queue**, which `CLAUDE.md` records as never validated end-to-end.
- **Room-code region routing.** Two people, different continents, one shared code: both must land
  on the **host's** region. A second lobby with the same code on a different machine is the
  failure, and it is silent on both screens.
- **`fly-replay`.** Confirm `?mm=1` reaches the matchmaker region from a satellite.
- **Region full → another region.** With `MAX_ROOMS` low on one machine, confirm a real player can
  read the message, pick another region, and get in.

---

## 5. Database and presence

- **`DB_POOL_MAX` is 5 per machine.** ⚠️ At the room counts §5 of `docs/capacity.md` implies
  (~70–90 machines), that is **~450 direct connections**, which will exceed a small Neon compute's
  direct limit. **Use Neon's pooled (`-pooler`) connection string before going wide**, or lower
  `DB_POOL_MAX`. Connections are free in Neon's billing model — query *time* is what costs — so
  this is a limit question, not a cost one.
- **Presence heartbeat** writes every 5 s per machine: a row per player and per guest, plus every
  room summary. Its payload scales with **per-machine** population, which `MAX_ROOMS` now bounds —
  so the admission cap incidentally bounds this too. Watch that an empty machine still goes quiet
  (it beats once to publish the zero, then stops).
- **Match-end writes** are off the hot path already. Worth watching during a simultaneous
  match-end burst: end ~10 matches at once and confirm no loop-lag spike.

---

## 6. Version gate

The poll is every 90 s per client and the forced refresh only fires **when a player starts a run**,
never mid-run — so both are naturally spread across the population and neither is a stampede. No
change was made here.

What to confirm at launch is the **reconnect** wave, not the refresh: `transport.ts` already adds a
random extra delay to every retry precisely so that a whole room does not march back in lockstep.
Restart one region and watch `/api/perf` on it: connections should return spread over seconds.

---

## 7. Go / no-go

**Go:**
- idle Linux `loopLagMs.p99` is a small fraction of 16.67 ms (§1)
- at the intended per-machine room count, gap p50 ~33 ms and 0 disconnects (§2)
- compression saves ~80% of wire with **no** gap/jitter regression (§3a)
- a full region tells players so, and another region works (§3b)
- two accounts complete a rated match (§4)

**No-go / roll back:**
- compression moves the snapshot gap → `WS_COMPRESS=0`
- players report being refused while machines are idle → raise or clear `MAX_ROOMS`
- Neon refuses connections → pooled connection string, or lower `DB_POOL_MAX`

---

## 8. What is still not covered

Being explicit, because these are the gaps that bite on the day:

1. **The matchmaker path is untested under load.** It is also the path that costs real ELO when it
   breaks.
2. **2v2 capacity has no trustworthy number.** The local 2v2 sweep was non-monotone and is
   reported as unusable in `docs/capacity.md` §1. Re-run it on Linux.
3. **1,000 concurrent is not reachable on today's architecture** — ~70–90 machines (capacity §5).
   Nothing in this branch changes that; the fix is more processes per machine, which is blocked by
   room-code region routing, or fewer server-side rooms (`docs/lan-selfhost.md`).
4. **No soak test.** Everything here is minutes long. A memory leak or a slow `pending`/presence
   growth shows up over hours. Run one machine at a realistic load overnight and compare
   `heapMb.used` against `heapMb.limit` at the start and end.
