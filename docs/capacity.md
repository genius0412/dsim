# DSIM capacity model

Measured 2026-09-10 on branch `perf-load`, against the real server (`npm run server`) driven by
`scripts/loadtest.ts` — N headless clients speaking the real protocol at a true 60 Hz, reconciling
exactly as `game.ts` does. Raw JSON in `.loadtest-out/`, reproduced by `scripts/loadsweep.sh` and
tabulated by `scripts/loadsummary.ts`.

**Read the next section before quoting any number from this file.** Half of what a capacity model
normally reports is not measurable on the machine these runs came from, and the half that is
measurable is the half that matters.

---

## 0. What this dev box can and cannot measure

The measurements were taken on a Windows 11 laptop. Windows' default timer granularity is 15.625 ms
and Node does not raise it. Three independent consequences, each measured, not assumed:

1. **`setInterval(16.67)` actually fires every ~31 ms** — 34.5 Hz, not 60. (This is why the load
   harness runs one 5 ms ticker with an accumulator instead of a timer per client; a 5 ms request
   rounds up to one 15.6 ms tick, measured 63.8 Hz, and the accumulator emits a true 60 Hz from it.)
2. **An IDLE `monitorEventLoopDelay` reads p50 ≈ 15.6 ms** — 94% of the 16.67 ms step budget before
   a single room exists.
3. **Less CPU load produced WORSE jitter.** The idle 8-room control run measured jitter 33.9 ms
   against the driven 8-room run's 13.0 ms, at a quarter of the CPU. Scheduling noise, not load.

So:

| quantity | portable off this box? |
|---|---|
| **CPU cost per room** (`cores`) | **yes** — this is the number to extrapolate |
| bytes per client | **yes** — protocol output, machine-independent |
| snapshot gap p50 as a *saturation flag* | yes, comparatively (35 ms vs 248 ms is real) |
| loop-lag p99 vs the 16.67 ms budget | **no** — the idle floor already exceeds it |
| absolute jitter, absolute RTT, "SMOOTH/OK/CHOPPY" thresholds | **no** |

⚠️ **Every latency and jitter threshold in this document is UNCONFIRMED and must be re-measured on
Linux** (`dsim-alpha`) before it drives a decision. That run is owner-gated — it needs a deploy, and
this branch must not deploy.

### `/api/perf` `cores` is not a saturation signal

`Room.startLoop` caps catch-up at 8 ticks per fire and clamps the accumulator at 0.25 s. An
overloaded room therefore **sheds simulation time rather than consuming more CPU**. Measured: `cores`
sat flat at 0.80–0.89 from 8 rooms all the way to 48, while the snapshot gap p50 went 35 ms → 248 ms.

Fitting a capacity line through that flat tail invents capacity that does not exist, which is why
`loadsummary.ts` fits only over steps that were still keeping the server's promise (gap p50 < 45 ms,
no drops) and prints the rest as `ok=n`. **Saturation is visible in the gap and the lag, never in
the CPU number.**

---

## 1. Cores per room — measured

### DECODE, solo rooms, robots actively driven

```
 rooms  cores  c/room  gapP50  gapP99  jitter  KB/s·cli  ok
     1  0.217  0.2170    32.0      62     8.5       102   y
     2  0.229  0.1145    32.2      62     7.7       108   y
     4  0.387  0.0968    31.9      65     9.3       113   y
     8  0.719  0.0899    35.3     106    13.0        94   y
    12  0.808  0.0673    92.9     232    48.7        37   n   <- shedding
    16  0.798  0.0499    54.0     412    87.4        30   n
    24  0.857  0.0357   179.9     351    20.2        12   n
    48  0.816  0.0170   247.6     447    35.2         6   n
```

**fit over the healthy steps: `cores = 0.107 + 0.0750 × rooms` → 0.075 cores/room, 13.3 rooms/core.**

The 0.107 intercept is the process's own idle cost: timers, the presence heartbeat, `/api/perf`.

### The same rooms with every robot PARKED (control run)

```
 rooms  cores  c/room
     8  0.311  0.0389
    16  0.558  0.0349
```

**fit: 0.031 cores/room, 32.4 rooms/core.**

> ⚠️ **`fly.toml`'s recorded "~0.02–0.03 cores each (~33–55 rooms/core)" is the PARKED figure.**
> It matches the idle control run almost exactly and is ~2.4× cheaper than a room with people
> actually driving in it. Every capacity plan built on that number is over-optimistic by that
> factor. **Plan on 0.075.**

### Chain Reaction, solo rooms, driven

```
 rooms  cores  c/room  gapP50  gapP99  bytes/s per client
     1  0.060  0.0600   31.65   146.6   290,682
     2  0.139  0.0695   31.61    62.0   369,753
     4  0.174  0.0435   31.50    76.8   364,267
```

≈ **0.038–0.045 cores/room** — CPU-cheaper than driven DECODE, because CR's 300 particles use a
bespoke spatial-hash integrator rather than Rapier bodies. But see §2: it costs **3.5× the
bandwidth**, and a keyframe is 55.7 KB in a single frame.

### 2v2 — the fit is UNUSABLE, reported as such

```
 rooms  cli   cores  c/room  gapP99  KB/s·cli
     1    4   0.388  0.3880     101       298
     2    8   0.335  0.1675      61       332
     3   12   0.235  0.0783     228       204
     4   16   0.339  0.0848     222       170
     6   24   0.472  0.0787     269       170
```

`cores` is **non-monotone** — it falls from 1 room to 3 and rises again — despite every room being
verified as started. Two likely causes, neither separable on this hardware: a 2v2 room was already
partly shedding at ONE room (gap p99 101 ms), and this laptop schedules across P-cores and E-cores.
`loadsummary` reports `0.0196 cores/room, 51 rooms/core` from these points; **that number is an
artifact of the flat tail and must not be used.**

Use the frame-size ratio instead: a 4-robot snapshot is 6,424 B against a 1-robot 3,176 B, so treat a
2v2 room as costing roughly **2× a solo room** on CPU and ~2.3× on bytes, pending a Linux re-run.

### One anomalous run, unexplained

The idle 24-room step recorded gap p50 1522 ms, `cores` 0.036, server loop lag p50 1508 ms, and only
12 of 24 rooms created. That is a machine-wide stall, not a server property. **Not re-run; do not
read anything into it.**

---

## 2. Bandwidth — measured, and machine-independent

Downstream, per client, steady state:

| room | per client | per client | per room |
|---|---|---|---|
| DECODE solo | **104 KB/s** | 0.81 Mbit/s | 104 KB/s |
| DECODE 2v2 | **235 KB/s** | 1.83 Mbit/s | 940 KB/s |
| Chain Reaction solo | **365 KB/s** | 2.85 Mbit/s | 365 KB/s |

Snapshot anatomy (`slimWorld`, solo DECODE, ~2.3 KB, resent 30×/s):

- **robots are ~72% of it**, ~920 B each
- dominated by full-precision IEEE doubles: `vel` 60 B, `pos` 45 B, `slipX/slipY/slipW` ~71 B
- a Chain Reaction **keyframe is 55.7 KB in one frame** (sent on every reconnect re-prime)

**This is the first cost cliff at the 1,000-member target, not CPU.** See §5.

---

## 3. The architectural ceiling: one process ≈ one core

Node is single-threaded. The room loop, the snapshot broadcast, the JSON encoding and the socket
writes all run on one event loop. **A bigger Fly VM does not multiply room capacity**, because
nothing in the server can use a second core.

This is the single most important finding in this document, and it reframes the whole sizing
question. The measured 13.3 rooms/core is therefore also **13.3 rooms per PROCESS**, and on a Fly
shared vCPU — slower and throttled relative to a 2026 laptop P-core — it will be fewer.

CPU profile of the server under 8 driving solo rooms (30 s, `node:inspector`):

```
 ~50%  simulation (Rapier solve + step)
  ~9%  networking   (writev 4.3%, protocol.ts JSON 2.7%, broadcastSnapshot 2.0%)
  5.0% GC
  6.5% idle
```

**The sim is the CPU, not the wire.** A compact snapshot encoding is a *bandwidth* lever, not a CPU
one — worth doing (§6) but it will not buy rooms.

---

## 4. Extrapolation to Fly sizes

Given §3, the honest table is mostly flat. Rooms/machine assumes ONE server process, which is what
ships today.

| size | vCPU | Node can use | est. driven DECODE rooms, with margin | at redline |
|---|---|---|---|---|
| `shared-cpu-1x` | 1 shared | ~1 throttled | **3–5** | ~7 |
| `shared-cpu-2x` | 2 shared | ~1 | 4–6 | ~8 |
| `shared-cpu-4x` | 4 shared | ~1 | 5–8 | ~10 |
| `shared-cpu-8x` | 8 shared | ~1 | 5–8 | ~10 |
| `performance-1x` | 1 dedicated | 1 full | **8–10** | ~13 |

⚠️ **The shared-cpu rows are the weakest numbers in this document.** They assume a Fly shared vCPU
delivers meaningfully less sustained throughput than the laptop core the 13.3 figure came from, but
the shared-cpu baseline allotment and burst behaviour were **not** verified against Fly's own
documentation or against a real machine. Treat the column as an ordering, not as values. The
`performance-1x` row is the most trustworthy because it is closest to the measurement conditions.

**The useful reading of this table is that the rows barely differ.** Buying up the VM size is close
to the worst available lever. The levers that work:

1. **More processes** — `cluster`, or N machines per region. Blocked today by room-code region
   routing (`routeTarget`/`roomJoinRegion` resolve a code to a REGION, and a region is one machine),
   so this is a design problem, not a config change.
2. **Cheaper rooms** — the sim is 50% of CPU; that is where a room-cost win would come from.
3. **Fewer server-side rooms** — see the LAN/self-host note in §8.

---

## 5. The 1,000-concurrent model, against $25/day

Using the repo's stated real split (6/8 solo, 1/8 1v1, 1/8 2v2) and the measured figures:

**CPU.** Weighted ≈ 0.09 cores/room; 1,000 players ≈ 700 rooms ≈ **63 cores of work**. At one
usable core per process that is **~70–90 server processes**, i.e. 70–90 machines under today's
one-process-per-machine topology. That is the headline problem, and it is an architecture problem
(§3/§4), not a VM-size problem.

**Bandwidth.** Weighted ≈ **125 KB/s per client**.

```
1,000 clients × 125 KB/s   = 125 MB/s  = 440 GB/hour
```

At an assumed **$0.02/GB** egress (⚠️ *assumed — confirm against the actual Fly plan; rates vary by
region and some allowance is included*):

| scenario | egress/hour | cost/hour | 3-hour peak | 24 h |
|---|---|---|---|---|
| **today, uncompressed** | 440 GB | **$8.80** | **$26.40** | $211 |
| with permessage-deflate (§6) | 53 GB | **$1.06** | **$3.17** | $25 |

**A single 3-hour peak at 1,000 concurrent exceeds the entire $25/day budget on bandwidth alone,
before any compute.** Compression is what makes the stated budget reachable, and it is the
highest-value change in this whole investigation.

> ⚠️ **CORRECTION (2026-09-11) — the rows above are a LOWER BOUND, twice over.**
>
> **The payload figure was ~40% light.** 125 KB/s per client weighted is what the message bodies
> model; the WIRE measures **175 KB/s** (`scripts/zz-deflate-cost.ts`, which counts TCP
> `bytesRead` rather than the decompressed payload `ws` hands a `message` handler). So 1,000
> concurrent is **647 GB/hour uncompressed, not 440**, and the uncompressed 3-hour peak is
> **$39, not $26**. With the deflate that actually shipped it is **99 GB/hour** and the peak is
> **$5.94** — the $3.17 row above is not reachable at any window size measured.
>
> **The $0.02/GB rate is also low.** The owner has since priced this against the real plan and
> reports ~$661/day egress sustained at 1,000 concurrent uncompressed against ~$66/day with the
> deflate, plus ~$70/day and ~$66/day compute respectively. That implies an effective rate
> roughly **2× the $0.02/GB assumed here**. The *shape* of the finding survives — compression is
> what makes the target affordable, by about 10× on the dominant line item — but **no dollar
> figure in this section should be quoted without the real rate.**

---

## 6. The compression finding

`server/index.ts:1441` sets `perMessageDeflate: false`, with the comment that compression buffers and
among-frames context add latency. That was a reasonable default and it is **wrong for this workload**,
because consecutive snapshots are nearly identical and the deflate window is exactly the structure
that exploits that.

Measured over 300 *real consecutive* snapshot frames:

| mode | DECODE 4-robot | Chain 4-robot | cost |
|---|---|---|---|
| as sent today | 6,424 B | 6,602 B | — |
| float-rounding to 3 dp | 5,542 B (−14%) | 6,400 B (−3%) | lossy, needs a caps gate |
| stateless deflate L1 | 1,724 B (−73%) | 1,920 B (−71%) | 57 µs/msg, shareable per room |
| **context takeover L1** | **446 B (−93%)** | **248 B (−96%)** | ~100 µs/msg **per socket** |

Context takeover costs one zlib window per socket, so window size is the 1,000-socket question:

| windowBits/memLevel | per socket | µs/msg | saving (DECODE) | 1,000 sockets |
|---|---|---|---|---|
| 15/8 (zlib default) | 256 KB | 88 | −93% | 250 MB |
| 14/7 | 128 KB | 95 | −90% | 125 MB |
| **13/6** | **64 KB** | **123** | **−88%** | **63 MB** |
| 12/5 | 32 KB | 183 | −73% | 31 MB |
| 11/4 | 16 KB | 121 | −72% | 16 MB |

**The knee is sharp and it is at 13/6.** Below that the window can no longer hold a couple of 6.4 KB
frames, the frame-to-frame redundancy is lost, and the ratio collapses to roughly what stateless
deflate gives for more memory and more CPU.

> ⚠️ **CORRECTION (2026-09-11) — 13/6 WAS THE WRONG PICK, AND THIS TABLE IS WHY.**
> The right-hand column prices 1,000 sockets **on one machine**, and §3 of this same document
> proves that machine cannot exist: one process is one core and a core carries ~13 driven rooms,
> so a machine holds tens of sockets, not a thousand. At 20 sockets the real choice is **5 MB
> against 1.3 MB** — the memory axis the knee was chosen on is not a constraint in any reachable
> topology, and the knee argument was trading away the ratio to save 192 KB.
>
> Worse, the saving at 13/6 **degrades as the room gets busier**, because a bigger frame fits in
> a 64 KB window fewer times — exactly backwards, since the 4-robot room is the expensive one.
> Measured end to end, per client downstream:
>
> | shape | today | 13/6 | 15/8 |
> |---|---|---|---|
> | decode-solo | 100.5 KB/s | 15.2 (−83%) | **12.5 (−88%)** |
> | decode-1v1 | 184.7 KB/s | 38.3 (−80%) | **26.0 (−86%)** |
> | decode-2v2 | 283.2 KB/s | 91.1 (−67%) | **48.9 (−83%)** |
> | chain-solo | 387.8 KB/s | 90.8 (−78%) | **68.8 (−82%)** |
>
> **What shipped is 15/8**, on `alpha` in `e287c0e` + `41e346d`, with `level: 1` kept because the
> gain comes from the window rather than from searching harder inside one frame. `WS_COMPRESS=0`
> turns it off without a deploy.

CPU price at 13/6: ~123 µs/msg × 30 msg/s = **3.7 ms/s ≈ 0.004 cores per socket**, i.e. about
**+5% CPU on a solo room** in exchange for **−88% bytes**. ⚠️ That +5% is priced as if zlib ran on
the event loop. It does not — `ws` drives deflate through its ASYNC stream API, so the work lands
on the libuv threadpool beside the room loop rather than inside it. The real on-loop cost is lower
than this line claims, and `UV_THREADPOOL_SIZE` (default 4, per process) is the thing to watch
instead. Against §5 that is an excellent trade,
and §3 says we have bandwidth pressure long before we have CPU headroom to spare — so it should be
weighed knowingly, not waved through.

> **This is NOT a protocol change and needs no `CLIENT_CAPS` gate.** `permessage-deflate` is a
> WebSocket extension negotiated per connection in the HTTP upgrade. A client that does not offer it
> simply does not get it, and keeps receiving exactly the bytes it receives today. Backward
> compatibility is structural here, which makes this unusually cheap to ship.

⚠️ **Two things to verify on Linux before committing to it**, both of which the original
`perMessageDeflate: false` comment was right to worry about: whether the added per-message latency is
visible in the snapshot gap, and whether 63 MB of windows plus ws's own buffers stays inside the
machine's memory at full population.

---

## 7. Cliffs and defects found while measuring

| # | finding | status |
|---|---|---|
| 1 | **Ghost rooms.** After all drivers vanish mid-match a room keeps its 60 Hz loop for `RECONNECT_GRACE_MS` (45 s). Measured `/api/perf` showing **19 rooms and 0.906 cores with 0 players.** | **FIXED** `3490f4c` — 12 ghost rooms went 0.556–0.769 → 0.000–0.042 cores |
| 2 | **`Room.onInput` grows without bound.** Future-tick inputs are buffered in a per-robot `pending` map pruned only once the world reaches that tick, so a client stamping huge tick numbers grows server memory indefinitely. | **FIXED** `d0ba653` — `MAX_INPUT_LEAD_TICKS`, 6 smoke checks |
| 3 | **No admission control whatsoever.** Every `join` for an unknown code created a room. A busy region did not degrade, it collapsed, and it collapsed for everyone already on the machine. | **FIXED** `a8bf161` — `MAX_ROOMS` (24 on Fly), `region_full`. ⚠️ **24 is a RUNAWAY GUARD, not a measured safe load** — deliberately well above the ~13 driven rooms/core of §2 and the 8–10-with-margin of §4, because most rooms are parked (0.031 cores) rather than driven (0.075) and a cap set at the redline would refuse players while the machine still had headroom. The constant's own comment says the same thing; keep the two in step. A load-driven cap is the follow-up (§0: none of the latency thresholds are measurable on the Windows dev box). |
| 4 | **Snapshots sent uncompressed.** `perMessageDeflate: false`. | **FIXED on `alpha`** `e287c0e` + `41e346d` — 15/8, −82% to −88% end to end. The 13/6 this document recommended was superseded; see the correction in §6 |
| 4b | **Snapshot encoding was O(AUDIENCE).** Each client's own `send` closure ran `ws.send(encodeMsg(m))`, so one 2v2 frame was stringified four times from the same object, plus once per spectator. | **FIXED** `d32a2d7` — `Client.sendRaw`; at 4 recipients 0.37% → 0.09% of a core per room, at 32 recipients 3.79% → 0.14% |
| 5 | **Presence heartbeat is O(N).** Every 5 s each machine upserts `operatorSnapshot()` (a row per player *and* per guest) plus `localLive()` (every room summary) into Postgres. | **partly mitigated** — its payload scales with *per-machine* population, which `MAX_ROOMS` now bounds |
| 6 | **`DB_POOL_MAX` is 5 per machine.** At the ~70–90 machines §5 implies, that is ~450 *direct* Neon connections, which exceeds a small compute's limit. | real, unfixed — use Neon's pooled (`-pooler`) string |
| 7 | **`bestHost` is latency-only.** `server/regions.ts` picks a region by minimax latency with **no load awareness**, so the nearest region is chosen no matter how saturated it is. With `MAX_ROOMS` in place a full region now refuses cleanly instead of collapsing, but the matchmaker still *aims* at it. | real, unfixed |
| 8 | **Cold boot is already fixed.** The brief's "~7 s cold boot because the server runs through `tsx`" is stale — the `Dockerfile` already esbuild-bundles to `dist-server/index.js` and runs plain `node`. | **premise no longer true** |
| 9 | **`fly.toml`'s cores/room is the parked figure** (§1). | **premise misleading** |
| 10 | **Reconnect storms and the version gate are already safe.** `transport.ts` adds a random extra delay to every retry so a room does not march back in lockstep, and the forced refresh fires only when a player *starts a run*. | **no change needed** |
| 11 | **Spectators bypassed admission entirely.** `spectate` attaches to an existing room, so the `MAX_ROOMS` check never runs — no room slot, no sign-in, no cap. Each watcher takes the same 30 Hz snapshot stream a driver does, so one shared match link was an unbounded fan-out on a machine whose whole capacity model is per-room, and egress is the cliff reached first (§5). | **FIXED** — `MAX_SPECTATORS_PER_ROOM` (24) + `MAX_SPECTATORS` (192), both env-overridable. Same class of number as `MAX_ROOMS`: runaway guards set from what a crowd plausibly looks like, **not** from a measured spectator cost, because there is none yet. |
| 12 | **An unbounded outbound queue per socket.** Nothing read `ws.bufferedAmount`, so a socket that stopped draining accumulated snapshots that were historical by the time they arrived — invisible to the room, which only ever knew it had *called* `send`. | **FIXED** — `SNAP_BACKLOG_BYTES` (256 KB): a backed-up client is skipped and unprimed, so the next snapshot it receives is a full keyframe of the world as it is then. Coalescing, not dropping; a delta keyed to a frame it never read would be worse than nothing. |
| 13 | **No inbound `maxPayload` and no per-socket message rate limit.** ws's default cap is 100 MiB per socket, and nothing bounded how fast one socket could make the event loop — which runs every room in the region — run `JSON.parse`. | **FIXED** — `maxPayload` 64 KiB (three orders above the ~100 B hot path, an order above the largest legitimate `join`) and 240 msg/s per socket, 4× what a 60 Hz client produces; a sustained flood past 2,000/s is closed. |

---

## 8. LAN / self-hosted servers — feasibility

Asked during step 1. Answering here because it changes the capacity math more than any tuning does:
every room hosted on a player's own machine is a room the Fly bill never sees.

**Most of it already exists.** The server is a standalone bundled Node process (`npm run server:prod`)
that imports the shared sim, and the client already resolves its server through
`VITE_GAME_SERVER_URL` / `gameServerUrlWith`. A team could run the server on one laptop and have the
rest of the room connect to it over LAN today, with packaging and a server-address field in the UI
being the bulk of the remaining work.

**The open question is the trust boundary, and it is a real one.** A self-hosted server is a machine
the operator controls, so anything it reports about a match is client-authored data. Nothing
self-hosted can be allowed to reach a leaderboard, a personal best, a rank or ELO — the same rule
`CLAUDE.md` already states for `user_activity`.

The established precedent to follow is **`practice_runs`** (migration 0032): its own table, and
`record_leaderboard` is a view over `records`, so nothing written there is reachable from any
competitive query *by construction* rather than by convention. A LAN match should record the same
way — stored, viewable in career and match history, replay kept, and structurally unable to become a
score. That satisfies "we still want all the matches recorded and sent back to the database" without
opening a cheat surface.

**Not designed in detail here, and not started.** It is a product decision with a schema change
behind it.

---

## 9. Status

Sections 0–8 above are the **measurement** pass and are unchanged from the step-3 review. The
fixes that followed it are recorded in §7 with their before/after numbers; the live verification
plan for them is `docs/launch-load-test.md`.

**On the wire numbers, quote the END-TO-END ones and quote them from §6's correction.** Three
different measurements of the same thing exist and they are easy to mix up: this document's
isolated bench (−88% for a 4-robot frame at 13/6), this branch's load run (84,573 → 16,915 wire
bytes/s per client, −80%, across 8 solo rooms at 13/6), and the dedicated probe that decided what
shipped (`scripts/zz-deflate-cost.ts`, −82% to −88% at 15/8, per shape). **The last one is
authoritative** — it counts TCP bytes, runs each shape twice varying only whether the client offers
the extension, and asserts the extension really was negotiated on one run and absent on the other.

The three things that most need a decision:

1. **~~Is 1,000 concurrent a real target?~~ ANSWERED: yes.** So the 70–90 machines in §5 became the
   question rather than the answer, and it has its own document now — **`docs/scaling-multicore.md`**.
   Short version: one process is one core, but `Room` already talks only through callbacks, so
   running the simulation in `worker_threads` should take a machine from ~13 rooms to ~100 and the
   fleet from 70–90 machines to single digits. No routing change, every singleton stays a singleton.
2. **~~permessage-deflate~~ SHIPPED on `alpha`** at 15/8 — see §6's correction. Still needs the
   Linux latency check; `WS_COMPRESS=0` is the rollback.
3. **LAN/self-host** (§8) — the only lever that reduces the server population rather than serving it
   more efficiently. **Approved to pursue**; the owner has answered the three open questions in
   `docs/lan-selfhost.md`.

Everything in §7 is worth fixing regardless of which way 1–3 go. **#2 in that table is a security
issue and did not wait on the capacity review.**
