# DSIM multiplayer synchronization engine — review, cost model, and plan

**Branch `alpha`. Measured 2026-09-11, starting at `1b72858`; the branch advanced to
`8cd4d61` mid-session.**
Companion to `docs/multiplayer-architecture.md` (what the system IS), `docs/capacity.md`
(what it COSTS), and `docs/scaling-multicore.md` (the unbuilt multi-core path). This
document is the third question: **what is inefficient, what should change, and in what
order.**

Tree was green before measuring: `npm test` ALL PASS · `npm run test:mm` 58 checks ·
`npm run server:check` clean. **No code was modified.**

⚠️ **Why the moving HEAD does not invalidate anything here.** `git diff 1b72858 8cd4d61`
over `server/`, `src/net/`, `src/game.ts`, `src/config.ts`, `src/types.ts`, `src/games/`
and `scripts/costprobe.ts` is **empty** — every protocol, server, client and probe citation
below is byte-identical across both. The only `src/sim/` change is `heldSlotPos`'s
**triangle** intake slot (`physics.ts`), and every measurement here uses `DEFAULT_SPEC`,
whose intake is `sloped` (`spawn.ts:84`) — so it is inert for all of it. **[C]**

## Evidence labels — used on every claim

| | meaning |
|---|---|
| **[C]** | confirmed by code — the cited lines were read at this HEAD |
| **[D]** | per `docs/multiplayer-architecture.md` — its section cited |
| **[M]** | measured this session — the probe is named and reproducible |
| **[P]** | designed but NOT built — `docs/scaling-multicore.md` |
| **[E]** | estimate — arithmetic shown |

Measurement probes were run from a scratchpad, not the repo. Each is a plain `tsx` script
over the real `step()`, the real `slimWorld`, and the real ball diff, so each is
reproducible by re-creating it against the same entry points.

---

## 0. Executive summary

The synchronization engine is **well built and correctly reasoned**. Server authority is
real, the client predicts every robot (not just its own) so contact is honest, the
shared-prefix encode makes broadcast O(balls) rather than O(recipients), and
`permessage-deflate` at 15/8 has already taken 82–88% off the wire. There is no
architectural rewrite to recommend, and most of the standard sync-engine toolkit — interest
management, AOI culling, spatial partitioning, priority tiers — **does not apply**, because
a room holds 2–4 robots and everyone in it must see the whole field.

Six findings change decisions. In descending order of consequence:

1. **The measuring instrument is broken, and it under-reports the dominant cost by up to
   9.5×.** `scripts/costprobe.ts:229` builds its ball-delta baseline from **live `Artifact`
   references**, which the sim mutates in place. `encodeBallDelta` compares with
   `JSON.stringify(prev) !== JSON.stringify(b)`, so with `prev === b` it can only ever
   report **zero changed balls**. Measured: costprobe's Chain Reaction solo figure of
   9.24 KiB/s per client is really **87.67 KiB/s**. Every bandwidth number quoted from
   costprobe since it was written is low. **[C][M]**

2. **One lever cuts 41–58% of the wire, needs no protocol version, no caps gate, and no
   client change.** Rounding every non-integer to 3 decimal places — *the precision
   `worldHash` already quantizes to* — before diffing and before serializing. Rounding
   *helps* the deflate window rather than hurting it, which is why `capacity.md` §6
   under-valued it 3× by measuring only RAW bytes. **[M]**

3. **A client can make the server broadcast ~64 KiB of arbitrary JSON to every client and
   spectator, 240×/second, with no backpressure check.** `LobbyPlayer.autoPath` is in
   `PlayerPatch`, `coerceAutoPath` leaves `shapes`, `sequence` and per-line `controlPoints`
   unbounded, `update` calls `broadcastRoster()` unconditionally, and `broadcast()` has no
   `backlog()` guard. **No client reads the field.** **[C]**

4. **The fleet cannot reach the target by a factor of 13.5, and multi-core does not fix
   it.** `fly-replay` resolves to a REGION, one machine per region is enforced
   (`fly-deploy.sh --ha=false`), `DEPLOY_REGIONS` is 5, `MAX_ROOMS` is 24 ⇒ **120 rooms,
   service-wide.** 2,000 CCU needs 1,625. `SIM_WORKERS` raises the per-machine term to
   ~500 and leaves the ×5 untouched. **[C][P]**

5. **Rapier costs 48× per element what the bespoke integrator costs.** Measured: 32.0 µs
   per ground artifact vs 0.66 µs per CR particle. Porting CR's 300 particles to Rapier —
   `CLAUDE.md`'s "Next up" item 1 — would cost **~9.6 ms of a 16.67 ms tick for one room**,
   a ~34× room-cost increase. **Do not do it.** **[M]**

6. **Replay rows have no retention policy at all**, and a versus match's replay is
   unreachable by `deleteAccount`'s cleanup. It is the only compounding line in the cost
   model. **[C]**

Two prior findings are corrected: `§17.9` (`world.gameSettings` rides every snapshot) is
**refuted** — the server never populates it and nothing anywhere reads it; and the premise
that "egress is ~90% of the bill" is **stale** — post-deflate it is 0.3× compute for DECODE
and 3.0× for Chain Reaction.

---

# PHASE 1 — Current architecture

## 1.1 The path, end to end

Verified at HEAD; line numbers re-read, not taken from the reference doc.

```
CLIENT                                                          SERVER
──────                                                          ──────
bindings.ts → RobotCommand
  │
  ├─ local = localizeCommand(cmd)            protocol.ts:92
  │    = dequantizeCommand(quantizeCommand(cmd))
  │    ── THE predict-on-this rule. Quantization exists for
  │       RECONCILE BIT-MATCHING, not bandwidth.          [C][D §11]
  │
  ├─ session.sendInput(tick, cmd) ──── {t:'input',tick,q,ack,gen} ──►
  │                                                    Room.onInput   room.ts:875
  │                                                      gen ≠ matchGen       → drop :879
  │                                                      ack recorded even if dropped :882
  │                                                      unknown/dropped robot → drop :884
  │                                                      !isSafeInteger(tick)  → drop :899
  │                                                      lead > 120 ticks      → drop :900
  │                                                      else buffer by tick
  ├─ inputBuf.push({tick, cmd: local})
  └─ mod.step(world, SIM_DT, cmdMap(local))         setInterval(1000*SIM_DT)  room.ts:1427
       ↑ predicts ALL robots: local live +            checkGrace()   (WALL clock)      :1365
         remotes held from Snapshot.cmds              bail if empty                    :1366
         game.ts:833, :884-888                        FREEZE if nobody connected  :1399-1403
                                                      acc += dt, clamped 0.25 s        :1407
                                                      while (acc>=SIM_DT && n<8 && !fin):
                                                        frameCommands(tick+1)          :1478
                                                          exact → hold 15 → ZERO_CMD
                                                        step(w, SIM_DT, cmds) ◄ AUTHORITY :1479
                                                        recorder.record()              :1480
                                                        countParticipation()           :1481
                                                        due = tick % 2 === 0           :1482
                                                      ONE coalesced broadcast per fire :1423
                                                                │
  ◄──── {t:'snapshot',serverTick,w,balls,cmds,ackInputTick} ────┘  broadcastSnapshot :1805
  │
  ├─ stale guard: serverTick <= appliedTick ⇒ drop     serverSession.ts:297
  ├─ bufferSnapshot()  ← poses captured BEFORE reconcile mutates   game.ts:892
  ├─ remoteCmds = snap.cmds                                        game.ts:833
  └─ reconcile(snap)                                               game.ts:985
        renderedPre = predicted + localSmooth                           :993
        this.world  = snap.world                     ◄ HARD SWAP        :998
        inputBuf    = inputBuf.filter(b.tick > serverTick)               :1002
        replay each remaining buffered input through step()         :1009-1011
        localSmooth = renderedPre − post             ◄ COSMETIC ONLY     :1013
        if hypot > SMOOTH_MAX_DIST (16in): localSmooth = 0          :1020-1024
  │
  └─ displayWorld()                                                game.ts:905
        local robot  : PREDICTED + localSmooth
        remote robots: INTERPOLATED between two past snapshots      :952-962
        balls        : PREDICTED, never lerped                      :948-951
```

**Confirmed at HEAD [C]:** `room.ts:1479` is the only `step()` whose output reaches the
wire. `SNAPSHOT_INTERVAL = 2` (`room.ts:97`). `Room` at `room.ts:282`. `slimWorld` at
`protocol.ts:648`, `SlimWorld = Omit<World,'balls'|'robots'>` at `:631`. `localizeCommand`
at `protocol.ts:92`. `roomJoinRegion` at `roomRegion.ts:32`. `coerceSetup` at
`spawn.ts:549` (still no `game` param). `coerceStartIndex` at `sanitize.ts:33`.

⚠️ **One citation in the reference doc has drifted:** it cites `SIM_DT` at
`config.ts:2707`; at HEAD it is **`config.ts:2840`** (`config.ts:2707` is `TUNNEL_W`). The
value, 1/60, is unchanged. Flagged here in the same spirit that doc flags `CLAUDE.md`.

## 1.2 What the reference doc gets right, verified

| §8.2 claim | verdict |
|---|---|
| Local robot: simulated + rendered predicted | **[C]** `game.ts:906-911`, `:953` |
| Remote robots: **simulated** forward, rendered interpolated | **[C]** `game.ts:833`, `:884-888`, `:952-962` |
| Balls: simulated, rendered snapped, never lerped | **[C]** `game.ts:948-951` |

This is the single most important thing not to "optimize away". Remote robots are stepped
because **robot-robot collision must be real in the predicted world**; `Snapshot.cmds`
exists for exactly that (`src/net/session.ts:44-46`). Any proposal that stops simulating
remote robots breaks contact prediction. **[C][D §8.2]**

## 1.3 The shared-prefix encode — better than documented

`broadcastSnapshot` (`room.ts:1805-1868`) memoizes the frame body per primed/unprimed class
and appends a per-client tail of **exactly `,"ackInputTick":NNNN}`**. **[C]**

Measured: the tail is **21 bytes**; a DECODE 2v2 frame is ~12,600 B. So **99.8% of the
frame is shared**, and a 4-driver room with 24 spectators performs **one** `JSON.stringify`
of the body, not 28. **[C][M]** This is already the right design. Any proposal that adds a
second per-client field destroys it — which is the real cost of "per-recipient
optimization" here (see Phase 9).

---

# PHASE 2 — Synchronization cost model

## 2.1 Instrument correction (do this before quoting any number)

`scripts/costprobe.ts:229`:

```ts
baseline = new Map(world.balls.map((b) => [b.id, b] as const));   // ← live references
```

`encodeBallDelta` (`protocol.ts:715-716`) compares `JSON.stringify(prev) !== JSON.stringify(b)`.
The sim mutates artifacts in place (`world.ts:99` `b.pos.x += …`, `physics.ts:918`
`b.vel.x = 0`), so `prev` IS `b` and the delta is **always empty**. **[C]**

The production server is **not** affected — `Room.prevBalls` stores *strings*
(`room.ts:1809-1811`), which in-place mutation cannot alias. This is a probe bug, not a
server bug. **[C]**

Measured `upd` per snapshot, exact server method, full 10,008-tick match:

| shape | costprobe (aliased) | true (server method) |
|---|---:|---:|
| DECODE solo | 0.0 balls | **1.9** |
| DECODE 2v2 | 0.0 | **7.8** |
| CR solo | 0.2 | **77.2** |
| CR 2v2 | 0.5 | **113.1** |

**Fix:** deep-copy at `costprobe.ts:229`. One line. Re-run before quoting anything. **[C]**

## 2.2 Network — corrected, MEASURED

Per client, downstream, whole match, through the real `deflateRaw` 15/8 level-1
context-takeover model with the 1024 B send-site threshold (mirroring `server/index.ts`):

| shape | RAW KiB/s | **WIRE KiB/s** | costprobe said | under-report |
|---|---:|---:|---:|---:|
| DECODE solo | 111.2 | **10.64** | 8.07 | 24% (×1.3) |
| DECODE 2v2 | 368.9 | **47.78** | 36.21 | 24% (×1.3) |
| CR solo | 478.3 | **87.67** | 9.24 | **89% (×9.5)** |
| CR 2v2 | 794.6 | **177.14** | 27.67 | **84% (×6.4)** |

**[M]** A room sends its frame to each client separately, so a 2v2 room's egress is 4× the
WIRE column.

### Every lever, priced RAW and WIRE

DECODE 2v2 (the expensive DECODE shape), against a 47.78 KiB/s base:

| lever | RAW saved | **WIRE saved** |
|---|---:|---:|
| drop `world.events` (send tail only) | 31.6% | **18.8%** |
| **round every non-integer to 3 dp** | 14.6% | **41.2%** |
| drop `robots` entirely (upper bound) | 29.8% | 45.2% |
| drop the ball `order` array | 0.8% | 0.7% |
| strip `gameSettings` | **0.0%** | **0.0%** |
| events + 3 dp combined | 46.2% | **58.0%** |

CR solo, against 87.67 KiB/s:

| lever | RAW saved | **WIRE saved** |
|---|---:|---:|
| **round to 3 dp** | 16.8% | **50.9%** |
| drop the ball `order` array | 7.1% | 5.1% |
| drop `robots` | 5.7% | 7.3% |
| drop `world.events` | 0.2% | 0.2% |

**[M]** Two independent measurements (this pass and a separate verification harness) agree
on the 3 dp figure to 0.1 percentage points: −41.2% DECODE, −50.9% CR solo.

**Why rounding helps the deflate window rather than hurting it:** a 17-significant-digit
IEEE literal is 17 near-random bytes an LZ77 matcher can almost never match, while a 3-dp
literal is both shorter *and* drawn from a small alphabet of repeating digit runs — the
literal cost and the match probability improve together. This is why `capacity.md` §6,
which measured only RAW bytes (−14% DECODE / −3% CR), under-valued the lever by ~3× and
concluded it was marginal and lossy.

### Quantize *before diffing* compounds it

Rounding the diff key as well as the wire value removes balls that "changed" only in the
far decimals:

| | upd/frame | WIRE KiB/s | saved |
|---|---:|---:|---:|
| CR solo, today | 77.2 | 87.67 | — |
| CR solo, 3 dp | 49.1 | **36.79** | **58.0%** |
| CR 2v2, today | 113.1 | 177.14 | — |
| CR 2v2, 3 dp | 89.5 | **81.81** | **53.8%** |
| DECODE 2v2, 3 dp | 7.4 | **28.06** | **41.3%** |

**[M]** Behind this is a real defect: at tick 1500 a CR room reports **85 changed particles
while only 11 are moving** (|v| > 0.01); at tick 7500, 88 changed against 9 moving. Roughly
**70 stationary particles per frame** are retransmitted because their serialized form
differs in float noise. **[M]**

## 2.3 CPU — MEASURED, and it inverts the usual assumption

Per-tick cost, 600-tick warmup, 1,800 ticks measured:

| scenario | `step()` µs/tick | snapshot build µs/tick | B/snap |
|---|---:|---:|---:|
| DECODE solo | **1242.4** | 36.6 | 2,799 |
| DECODE 2v2 | **2090.8** | 61.2 | 8,205 |
| CR solo | 322.2 | 119.8 | 4,259 |
| CR 2v2 | 541.6 | 141.5 | 7,884 |

**DECODE's Rapier round loop is ~4× more expensive than Chain Reaction's entire
300-particle solve.** The intuition that "300 particles is the big number" is wrong. **[M]**

Note the second column: the snapshot build is 3% of DECODE solo's per-tick cost but **27%
of CR solo's**, because CR ships 300 ball entries.

### CR's particle solve is linear and cheap

`separateParticles` (`chain/play.ts:764-803`): cell = one particle diameter, 3×3
neighbourhood, `o.id <= b.id` pair guard, `CHAIN_PART_SEP_ITERS` = 2. Once separated, a
diameter-sized cell can hold at most ~4 centres (points pairwise ≥ d apart in a d×d
square), so the neighbourhood is bounded — it is **O(n·k) with k self-limiting**. The O(n²)
worst case exists (a coincident pile) but is unreachable once the pass has run once. **[C]**

Measured marginal cost: **0.66 µs per particle** (0.51 at low density rising to 0.73 at
300 — mildly superlinear from density, nowhere near quadratic). **[M]**

### Rapier is 48× more expensive per element

| ground artifacts | DECODE `step()` µs/tick |
|---:|---:|
| 0 | 170.4 |
| 8 | 487.2 |
| 16 | 722.7 |
| 24 | 938.5 |

**Marginal: 32.0 µs per artifact.** At 24 artifacts the ground-artifact solve is **82% of
DECODE's entire tick**. **[M]**

> ### ⚠️ Do not port CR particles to Rapier
> `CLAUDE.md` "Next up" item 1 proposes moving CR's 300 particles to Rapier "if 300 bodies
> a tick is affordable". **Measured, it is not, by a factor of ~34.** 300 × 32.0 µs =
> **9.6 ms/tick against a 16.67 ms budget — 58% of one core for ONE room.** A CR room would
> go from ~0.045 cores to ~0.6, i.e. from tens of rooms per core to under two. The bespoke
> integrator is not technical debt here; it is the reason Chain Reaction is CPU-cheaper
> than DECODE. **[M]**

### The pin round loop is not a multiplier

`PHYS_PIN_ROUNDS` is 4, and each round is two Rapier world builds. Measured over a full
match: **rounds = 1 on 99.8% of DECODE solo ticks and 98.9% of 2v2 ticks**, never past 2.
Eliminating re-runs entirely would save 0.2–0.7%. Not a lever. **[M]**

### The ball diff pays full serialization to answer a boolean

`room.ts:1809-1811` runs one `JSON.stringify` **per ball per broadcast** to build a
string-keyed comparison map:

| shape | balls | changed/frame | diff µs/frame | frame encode µs/frame | diff share |
|---|---:|---:|---:|---:|---:|
| DECODE 2v2 | 32 | 9.2 | 28.3 | 91.8 | 24% |
| CR 2v2 | 292 | 109.6 | 133.6 | 149.9 | 47% |
| CR solo | 300 | 60.8 | 121.1 | 70.3 | **63%** |

A field-wise comparator cuts it **67–69%**. For CR solo that is 81.6 µs × 30 Hz =
2.45 ms/s = **0.0025 cores/room**, roughly **+5% CR rooms/core**. **[M]**

⚠️ The current approach is *correct by construction* (stringify compares everything); a
field-wise comparator is a silent-drop hazard and must ship with a property test — see
Phase 16.

## 2.4 Memory — MEASURED

Retained per room at match end (`maxMatchTicks()` = 10,008):

| shape | World | Replay buffer | `prevBalls` strings | heap delta |
|---|---:|---:|---:|---:|
| DECODE solo | 8 KiB | 213 KiB | 7 KiB | 0.9 MB |
| DECODE 2v2 | 19 KiB | 853 KiB | 7 KiB | 3.4 MB |
| CR solo | 44 KiB | 213 KiB | 80 KiB | — (GC noise) |
| CR 2v2 | 49 KiB | 852 KiB | 80 KiB | 2.9 MB |

**The `ReplayRecorder` dominates**, and it grows monotonically all match. **[M]**

Per socket: permessage-deflate 15/8 costs ~256 KB of window in the server direction;
`clientNoContextTakeover: true` bounds the inflate side (`index.ts:1703-1712`). Plus
`SNAP_BACKLOG_BYTES` 256 KB worst case. **[C]**

`fly.toml:64-66` is `shared-cpu-4x` / **1024 MB**. **[C]**

**Today CPU binds, not memory:** at `MAX_ROOMS` 24 that is ~24–82 MB of rooms + ~24 MB of
zlib windows against 1 GB. **[E]**

> **This flips under `SIM_WORKERS`.** At the plan's ~100 rooms/machine: rooms 100–340 MB,
> zlib windows 400 sockets × 256 KB = **102 MB**, backlog worst case another 102 MB, plus
> 8 worker isolates each with its own Rapier wasm instance. **Order 400–800 MB against a
> 1024 MB machine.** `scaling-multicore.md` §4 notes "memory cost per worker, once" but
> does not do this arithmetic. **Memory becomes the binding constraint at ~100 rooms, and
> the plan needs a VM bump to say so.** `fly.toml:57` already notes `performance-*` enforces
> a 2048 MiB floor, which the multi-core path implies anyway. **[E][P]**

## 2.5 Scaling — rooms per core, and the ceiling above it

| quantity | value | source |
|---|---|---|
| driven DECODE room | 0.075 cores → **13.3 rooms/core** | **[M]** capacity.md §1 |
| parked room | 0.031 cores → 32.4 rooms/core | **[M]** capacity.md §1 |
| driven CR room | 0.038–0.045 cores | **[M]** capacity.md §1 |
| one process | **one core** (Node is single-threaded) | **[M]** capacity.md §3 |
| `MAX_ROOMS` | 24 per machine, `REGION ? 24 : 0` | **[C]** index.ts:377-385 |
| `DEPLOY_REGIONS` | 5 | **[C]** regions.ts:16 |
| machines per region | **1, enforced** (`--ha=false`) | **[C]** fly-deploy.sh:40-44 |

⚠️ Do not conflate the two cores/room figures. costprobe measures **pure sim + encode**
(0.0169 DECODE solo); capacity.md measures the **whole server process under load** (0.075).
capacity.md's is the one to size machines with.

### Complexity, honestly classified

| class | what | note |
|---|---|---|
| O(1) per room | matchmaker lookup, roster ops, host reassign | **[C]** |
| O(robots) | `frameCmds`, `frameCommands`, drive model | 2–4, trivial **[C]** |
| O(robots²) | Rapier robot-robot solve, `rrContacts` | bounded at 4 **[C]** |
| **O(artifacts)** | `solveArtifacts` @ **32 µs each** | DECODE, 24 → **the dominant cost** **[M]** |
| **O(particles·k)** | `separateParticles` @ **0.66 µs each** | CR, 300 **[M]** |
| O(balls) per broadcast | the `JSON.stringify` diff | 63% of CR's encode **[M]** |
| O(recipients) | socket write + **per-socket deflate** | the only true fan-out cost **[C]** |
| O(rooms) globally | presence heartbeat, `/api/live`, room registry | **[C]** |

**No O(rooms) work exists inside a per-room tick.** The scaling axis really is rooms. **[C]**

### The fleet ceiling — the binding constraint

`fly-replay` resolves to a **region**, never a machine (`index.ts:1782`,
`routing.ts:18-31`), and `fly-deploy.sh:40-44` deploys `--ha=false` precisely because two
machines in one region would split room codes silently. So:

```
5 regions × MAX_ROOMS 24                       =   120 rooms   ← service-wide, at HEAD
2,000 CCU at costprobe's 75% solo mix          = 1,625 rooms   ← 13.5× over
with SIM_WORKERS=8 (~100 rooms/machine) [P]    =   500 rooms   ← still 3.3× short
```

**[C][P]** Multi-core raises the per-machine term and leaves the ×5 untouched. Reaching
2,000 CCU needs **more regions or machine-granular routing**, and that is a routing change,
not a CPU one.

### Secondary: `MAX_ROOMS` is uniform across non-uniform machines

`MAX_ROOMS` is `REGION ? 24 : 0` with no reference to VM size, and `fly.toml` has no
`[env]` block — so all five machines use 24. But `fly-deploy.sh:59-61` re-applies
**`shared-cpu-1x`** to sjc/lhr/syd/nrt; only iad keeps `shared-cpu-4x`. `fly.toml:50-53`
states the measurement in its own words: a shared-cpu-1x sustained baseline is "a fraction
of a core ~ ONE busy room". The cap was sized for the primary and applied to machines with
a fraction of its CPU. **[C]**

The failure is not graceful: `Room.startLoop` sheds simulation rather than consuming CPU,
so `/api/perf` `cores` stays flat while every match stutters (capacity.md §0 measured gap
p50 35 ms → 248 ms between 8 and 48 rooms). **[M]**

## 2.6 Corrected hosting model, 2,000 CCU

Egress on the **corrected** wire rates; compute on capacity.md's whole-server cores/room at
65% utilisation and `$257.54/8` per vCPU-month; egress at the stamped `$0.02/GB`.

| population | rooms | cores | egress GB/day | egress $/day | compute $/day | **egress : compute** |
|---|---:|---:|---:|---:|---:|---:|
| all DECODE | 1,625 | 131 | 3,526 | $71 | $217 | **0.3×** |
| 50/50 | 1,625 | 105 | 11,498 | $230 | $173 | **1.3×** |
| all Chain Reaction | 1,625 | 79 | 19,471 | $389 | $130 | **3.0×** |
| *(what costprobe reports, 50/50)* | 1,625 | 105 | 2,562 | $51 | $173 | 0.3× |
| **50/50 with 3 dp quantize** | 1,625 | 105 | **5,287** | **$106** | $173 | **0.6×** |

**[M][E]**

**The premise "egress, not compute, is ~90% of the bill" is stale.** It was true before
`permessage-deflate` shipped. Post-deflate and post-correction it ranges from 0.3×
(DECODE) to 3.0× (Chain Reaction). **Which game the population plays moves the bill more
than any optimization in this document**: an all-CR population costs 5.5× the egress of an
all-DECODE one at identical CCU. **[M]**

Neither of these is the ceiling. **120 rooms is.**

---

# PHASE 3 — Inefficiencies

Scaling Impact = effect on rooms/core or bytes/room. Every row was read at HEAD; rows
marked ✔ were additionally adversarially verified by a second, independent pass.

| # | Problem | Location | CPU | Memory | Bandwidth | Rooms/core or bytes/room | Sev |
|---|---|---|---|---|---|---|---|
| 1 | `costprobe` baseline aliases live `Artifact`s ⇒ delta always empty | `costprobe.ts:229` | probe only | — | **every bandwidth number low, ×9.5 for CR** | mis-sizes the whole fleet | **Critical** ✔ |
| 2 | Full-precision IEEE doubles on the wire | `room.ts:1834`, `:1877` | — | — | **−41% DECODE / −51% CR on the WIRE** | −41…−58% bytes/room | **Critical** ✔ |
| 3 | `LobbyPlayer.autoPath` unbounded, broadcast to all, read by nobody | `protocol.ts:154-155`, `spawn.ts:494-524`, `room.ts:824-846`, `:1889-1901` | stringify whole roster per `update` | **unbounded ws send buffer** | up to 64 KiB × 4 × 28 per update | can take a region's process down | **Critical** ✔ |
| 4 | Fleet ceiling 5 × 24 = 120 rooms | `routing.ts:18-31`, `regions.ts:16`, `index.ts:377-385`, `fly-deploy.sh:40-44` | — | — | — | **hard global ceiling, 13.5× short** | **Critical** ✔ |
| 5 | No retention on `replays`; versus replays unreachable by `deleteAccount` | `persist.ts:80`, `repo.ts:1534-1556` | — | **157 GB/day at 2,000 CCU, compounding** | — | Neon storage grows without bound | **Critical** ✔ |
| 6 | `MAX_ROOMS` 24 applied to `shared-cpu-1x` satellites | `index.ts:377-385`, `fly-deploy.sh:59-61` | 6–24× oversubscribed | possible OOM at 1 GB | — | machines flap; invisible on `cores` | **High** ✔ |
| 7 | Ball diff `JSON.stringify`s every ball every broadcast | `room.ts:1809-1811` | **63% of CR's encode** | ~1.2 MB/s transient string per CR room | none | ~+5% CR rooms/core | **High** ✔ |
| 8 | `world.events` monotonic, re-sent whole 30×/s | `types.ts:751`; appended at 11 sites; never cleared | re-stringified per broadcast | few KB/room | 31.6% RAW / **18.8% WIRE** of a DECODE 2v2 frame | −18.8% bytes/room (DECODE) | **High** ✔ |
| 9 | `onBehaviour` never wired in production | `index.ts:1907-1917` vs `room.ts:398-426`, guard `:1612` | — | — | — | none — **all standing charges dead** | **High** ✔ |
| 10 | ~70 stationary CR particles retransmitted per frame as float noise | `room.ts:1809-1811` + `chain/play.ts` | — | — | most of CR's 87.67 KiB/s | fixed by #2 | **High** ✔ |
| 11 | `applyBallDelta` returns baseline objects the predicted sim then mutates | `protocol.ts:725-731`, `:737-750`, `game.ts:998` | — | — | — | **client correctness**: a ball the server does not re-send is never corrected | **High** ✔ |
| 12 | `backfillRobot` has no CR branch; `catalystRail` un-backfilled | `protocol.ts:673-691`, `types.ts:317` | — | — | — | old→new skew NaNs a CR robot | **High** ✔ |
| 13 | `coerceSetup` takes no `game` ⇒ CR replays DECODE-clamped | `spawn.ts:549`, `sanitize.ts:153` | — | — | — | CR replay re-sims a different robot | **High** ✔ |
| 14 | `broadcast()` has no `backlog()` guard (`sendTo` does) | `room.ts:1889-1901` vs `:1845-1849` | — | unbounded queue | — | amplifies #3 | **Medium** ✔ |
| 15 | `SNAP_BACKLOG_BYTES` calibrated pre-compression | `room.ts:135-164` | — | still bounds memory | — | tolerates ~10× the stall intended (~9–14 s) | **Medium** ✔ |
| 16 | `spectateRoom` re-implements the region rule inline | `App.tsx:669-686` | — | — | — | silent two-lobbies-one-code | **Medium** ✔ |
| 17 | Parked ranked queue survives sign-out | `queueKeeper.ts:105`, 2 call sites | — | — | — | wrong account enters a rated match | **Medium** ✔ |
| 18 | Production ball-delta path has no codec-level test | `room.ts:1809-1813` vs `protocol.ts:708` | — | — | — | silent drift; would also have caught #1 | **Medium** ✔ |
| 19 | `coerceStartIndex` uses DECODE's anchor count for CR | `sanitize.ts:33-37`, `chain/spawn.ts:74-76` | — | — | — | silently different corner | **Medium** ✔ |
| 20 | Client inbound `JSON.parse` unguarded | `protocol.ts:612`, `transport.ts:139-141` | — | — | — | one bad frame silently lost | **Low** ✔ |
| 21 | SFX re-cue on reconcile replay | `game.ts:565`, `:673` | — | — | — | audible under loss | **Low** ✔ |
| 22 | `world.gameSettings` — **refuted as a cost**, latent as a trap | `types.ts:761`, `spawn.ts:839`, `game.ts:423` | — | dead field on client worlds | **0.0% measured** | see §3.1 | **Info** ✔ |

## 3.1 Two prior findings corrected

**`§17.9` is refuted.** The reference doc says `world.gameSettings` "is broadcast to every
client in the room, 30 times a second". Measured: **removing it changes the frame by 0.0%
in all four scenarios.** The reason is structural — `server/room.ts:1021` calls
`createWorld('match', seed, setups)` with **three** arguments, and `gameSettings` is the
optional **fourth** (`spawn.ts:679`). It is `undefined` on every server-authored world, so
`JSON.stringify` omits the key entirely. **[C][M]**

It is worse than harmless and better than reported: the **client** does pass it
(`game.ts:423`), and `grep '\.gameSettings'` across `src/` and `server/` returns **zero
consumers**. The field is written, shipped nowhere, wiped by every reconcile's hard swap,
and read by nothing. The right change is **delete the field**, not strip it. The latent
hazard is real though: it sits inside `Omit<World,'balls'|'robots'>`, so if anyone ever
passes settings server-side it silently starts riding every snapshot.

**The cost premise is stale.** See §2.6.

---

# PHASE 4 — Modern techniques, evaluated against THIS architecture

| technique | applies? | why |
|---|---|---|
| **Interest management / AOI / quadtree / octree / spatial partitioning for visibility** | **No** | 2–4 robots per room and full-arena visibility is a product invariant. There is nothing partial to cull. The one place a spatial hash earns its keep is already built — `separateParticles`' grid (`chain/play.ts:770`) — and it is for *physics*, not visibility. **[C]** |
| **Priority-based replication tiers** | **No** | Tiers pay off when a client sees more entities than it can afford. A DECODE client sees 24 artifacts; CR's 300 are all inside one 12′ square that fits on screen. |
| **Delta compression** | **Already built, for balls** | `encodeBallDelta`/`applyBallDelta` (`protocol.ts:708`, `:725`). The open question is robots — answered below. |
| **Per-field dirty bits on robots** | **Marginal — measure first** | Removing robots *entirely* saves 45.2% of the DECODE 2v2 wire and only 7.3% of CR solo's. Rounding to 3 dp already takes 41.2% / 50.9% for a fraction of the complexity and **no protocol version**. Dirty bits add a per-robot bitmask, a `CLIENT_CAPS` gate and a second code path to chase a shrinking remainder. **Do #2 first, then re-measure.** **[M]** |
| **Bit-packing / binary wire (protobuf, flatbuffers)** | **No, and it would regress** | The wire is already 8–11× compressed by deflate with context takeover. A binary encoding has higher entropy per byte and compresses *worse*; measured, the win from 3 dp comes precisely from making the text **more** repetitive. It would also break the shared-prefix encode (a per-client binary tail is not a string append) and cost a `REPLAY_FORMAT`-class migration. |
| **Client prediction + reconciliation** | **Already built** | `game.ts:786`, `:985`. |
| **Prediction of remote entities** | **Already built** | `Snapshot.cmds` + `cmdMap` (`game.ts:884-888`). Often treated as exotic; here it is the default. |
| **Entity interpolation** | **Already built** | `displayWorld` (`game.ts:905`), half-life eased render clock (`:919-931`). |
| **Rollback netcode** | **No** | Reconcile is snap-and-replay. True rollback buys frame-perfect fighting-game inputs; a driving sim with 83 ms interpolation does not need it, and it would cost a full input history for every robot. |
| **Lockstep / determinism checksums on the wire** | **Deliberately removed** | `worldHash` survives for replay + smoke only (`checksum.ts:18`); its doc comment is stale lockstep prose. **[C][D §13.6]** |
| **Snapshot compression** | **Shipped** | 15/8, context takeover, `WS_COMPRESS=0` rollback. **[C]** |
| **Worker-thread replication** | **The real lever** | `scaling-multicore.md`. See Architecture C. **[P]** |
| **Backpressure** | **Built, mis-calibrated** | `SNAP_BACKLOG_BYTES` (`room.ts:164`) exists but was sized against uncompressed frames. **[C]** |
| **Adaptive snapshot rate** | **Worth it for spectators only** | See Phase 9. |

**Nothing in the MMO/battle-royale toolkit is missing here.** The techniques that matter
are already implemented; the wins left are in *precision*, *retention*, and *topology*.

---

# PHASE 5 — Candidate architectures

All four respect Appendix B: solo path bit-identical, predict on `localizeCommand`,
`world.rngState` sole randomness, server never imports the client registry, remote robots
stay stepped, protocol stays backward-compatible.

### Architecture A — "Correct the instrument and the precision" (recommended first)

Fix `costprobe`'s baseline; round non-integers to 3 dp at the two `JSON.stringify` sites
and in the diff key; wire `onBehaviour`; delete `LobbyPlayer.autoPath` from the wire; add a
`backlog()` guard to `broadcast()`; cap `world.events`; add replay retention.

### Architecture B — "Delta-encode robots too"

Per-robot dirty bitmask in the shared body, `CLIENT_CAPS`-gated; old clients keep full state.

### Architecture C — `SIM_WORKERS` (`worker_threads`)

Rooms move to N worker threads; main thread keeps sockets, singletons, and a
`code → workerId` directory. **[P]**

### Architecture D — Machine-granular routing

Room codes carry a machine hint, not just a region; `routeTarget` learns it. Lifts the ×5.

### Scoring

| | CPU/room | Mem/room | Bytes/room | Rooms/core | Fleet ceiling | Complexity | Invariants | Migration |
|---|---|---|---|---|---|---|---|---|
| **A** | −5% (CR diff) | unchanged | **−41…−58%** | +5% CR | unchanged | **Low** | all safe, no version bump | **hours–days** |
| **B** | slightly worse | unchanged | −5…−15% *after A* | slightly worse | unchanged | High | needs caps gate + 2 paths | weeks |
| **C** | unchanged/room | **+memory pressure** | unchanged | **×4–8/machine** | 120 → ~500 | High | all safe (the seam exists) | weeks, prototype first |
| **D** | unchanged | unchanged | unchanged | unchanged | **lifts the ×5** | High | protocol change | weeks |

**Recommendation: A now, C next (prototype-gated), D when the ceiling is actually reached,
B probably never.** A is the only one with a large measured win and an hours-scale diff.

---

# PHASE 6 — Recommended engine design

**Keep the engine. Change four things about what goes into it.**

1. **A precision boundary at the wire.** One `JSON.stringify` replacer at `room.ts:1834`
   and `:1877`, and the same rounding applied to the diff key at `:1810`.
2. **A retention boundary at the database.** Replays are a fixed-size archive, not an
   append-only log.
3. **An admission boundary sized per machine**, not per fleet.
4. **A roster that carries only what a client reads.**

Nothing about authority, prediction, reconciliation, or interpolation changes.

## 6.1 The precision change, specified

```ts
// server/room.ts — one shared replacer, used at :1834 and :1877
const WIRE_DP = 1000; // 3 dp — exactly worldHash's own tolerance (checksum.ts:24)
const round3 = (_k: string, v: unknown): unknown =>
  typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v)
    ? Math.round(v * WIRE_DP) / WIRE_DP
    : v;
```

**Why the `Number.isInteger` guard is load-bearing:** `world.rngState` is a 32-bit
mulberry32 integer, and `world.tick`, ball ids and every count are integers. A naive
`toFixed(3)` would make them *longer* and would corrupt `rngState`. **[C]**

**Why 3 dp is provably safe:**

- `worldHash` (`checksum.ts:24`) already quantizes with `Math.round(f * 1000)`. The
  determinism check the whole replay system rests on **is already blind to differences
  below this threshold.** **[C]**
- The client hard-swaps the world every snapshot (`game.ts:998`), so a rounded value is
  re-anchored 30×/s and cannot accumulate. **[C]**
- 0.001 inch on a 144-inch field, against a `SMOOTH_MAX_DIST` of **16 inches**
  (`game.ts:45`). **[C]**
- It is not a shape change — a rounded number is still a number — so an older client parses
  it unchanged. **No `CLIENT_CAPS` string, no `REPLAY_FORMAT` bump.** Replays are input
  logs and never carry wire values, so replay fidelity is untouched. **[C]**
- The solo path never serializes, so `session: null` stays bit-identical. **[C]**

**Rounding the diff key too** is what removes the ~70 stationary CR particles per frame; it
must use the same rounding or the two disagree about what changed.

---

# PHASE 7 — Replication pipeline (target)

```
step() completes
   │
   ├─ ball diff:  round3(ball) → compare against prevRounded      ← #2 + #7 + #10
   │                (field comparator behind a property test, or keep stringify)
   ├─ slim:       slimWorld(w)                                     unchanged
   ├─ events:     tail since last broadcast, or capped ring        ← #8
   ├─ body:       JSON.stringify({...}, round3)   ONCE per primed/unprimed class
   ├─ tail:       ,"ackInputTick":N}              21 bytes, per client
   └─ sendRaw     per recipient, with backlog() gate               unchanged
```

Everything not marked is untouched. The shared-prefix property is preserved because
rounding is applied inside the *shared* body, not per recipient.

---

# PHASE 8 — Dirty-state tracking

**Recommendation: do not build per-field dirty tracking yet.**

Balls already have change detection. Robots do not, and Architecture B would add it — but
the measurement says the remainder after Phase 6 is small and the cost is a second code
path plus a caps gate. The honest sequence is: ship the 3 dp change, re-run the corrected
`costprobe`, and only then decide whether the residual robot payload justifies a protocol
version. **[M]**

If it is ever built, the correct shape is a **per-robot changed-field bitmask in the shared
body** — never a per-recipient one, which would destroy the shared-prefix encode currently
saving 27 redundant `JSON.stringify` calls per 2v2-with-spectators frame. **[C]**

---

# PHASE 9 — Interest management, reframed

There is no spatial visibility to manage. The real question is per-recipient
differentiation, and the honest answer is that **DSIM already has the only instance of it
worth having**, and adding more is expensive.

## 9.1 The existing precedent — ranked strategy-window redaction

During the 20 s strategy window the roster is **redacted per recipient**: an opponent's
card carries name/team/ELO only, with `spec`/`assists` neutralized so nobody can
counter-pick (`protocol.ts:159-163`, `room.ts:1903-1944`), and `alliance` is stripped from
patches (`room.ts:831`). It is gated on every member advertising the `strategy` cap
(`protocol.ts:216-224`). **[C][D §3.4]**

This is the pattern to copy: **per-recipient differentiation on the LOW-RATE control plane
(roster, once per change), never on the 30 Hz snapshot plane.**

## 9.2 What is per-recipient on the snapshot plane today

Exactly one field: `ackInputTick`, 21 bytes (`room.ts:1858`). **99.8% of the frame is
shared.** That is the design's best property and the constraint on every proposal here.
**[C][M]**

## 9.3 Spectators — the one genuine candidate

A spectator receives the **identical** 30 Hz stream a driver gets (`room.ts:1866`), runs
the spectator branch with `yourRobotId: -1`, steps the world from held remote commands,
sends nothing, and renders interpolated ~5 ticks back (`game.ts:840-853`). **[C]**

At `MAX_SPECTATORS_PER_ROOM` 24 and `MAX_SPECTATORS` 192 (`index.ts:422-423`), a single
popular CR match is 24 × 177.14 KiB/s = **4.15 MiB/s from one room**. **[M]** Halving the
spectator rate to 15 Hz would save ~2 MiB/s per full room.

**But it is not free, and the reasons are specific:**

- A second rate means a **second shared body** per broadcast — still O(1) in recipients, so
  this is the one per-recipient split that does not break the encode.
- The client's quality indicator buckets on measured snapshot rate and jitter
  (`serverSession.ts:244-278`); a spectator at 15 Hz would read **CHOPPY** permanently
  unless the bucket learns the intended rate. That needs a `SERVER_CAPS`-gated field.
- `INTERP_DELAY_TICKS` is 5 ticks ≈ 83 ms, tuned for 30 Hz arrival. At 15 Hz the buffer
  holds half as many frames for the same wall time and remote motion would visibly step.

**Verdict: worth doing only after Phase 6, and only with the rate advertised to the
client.** The 3 dp change takes ~51% off that same spectator stream for none of this
complexity. Do the cheap one first.

## 9.4 What must NOT be differentiated

Drivers need every remote robot's full state, because they **simulate** it. Trimming fields
from remote robots would break `step()` — the trap §13.3 of the reference doc warns about.
**[C][D §13.3]**

---

# PHASE 10 — Bandwidth optimization, ordered by measured value

| # | change | WIRE saved | protocol cost | risk |
|---|---|---|---|---|
| 1 | **Round non-integers to 3 dp (wire + diff key)** | **41–58%** | **none** | low — inside `worldHash`'s own tolerance |
| 2 | `world.events`: send the tail, or cap the array | 18.8% DECODE 2v2, ~0% CR | none (cap) / caps gate (tail) | low |
| 3 | Delete `LobbyPlayer.autoPath` from the wire | removes a 64 KiB amplifier | none — nobody reads it | none |
| 4 | Ball `order` only when it changes | 5–7% CR, 0.8% DECODE | caps gate | medium — `order` is determinism-load-bearing |
| 5 | Spectators at 15 Hz | ~50% of spectator egress | `SERVER_CAPS` field | medium |
| 6 | Per-robot delta encoding | ≤15% *after #1* | caps gate + 2 paths | medium |

**#1 alone is worth more than #2–#6 combined**, costs no protocol version, and is roughly a
ten-line diff. That is the whole recommendation.

---

# PHASE 11 — Adaptive replication

Recommend **one** adaptive behaviour, and it already half exists: the backlog skip at
`room.ts:1845-1849` unprimes a congested client so its next frame is a keyframe.

⚠️ **That loop deserves scrutiny.** A client that is behind is skipped, then sent a frame
*larger* than the delta it missed — a CR keyframe is several times a steady-state snapshot.
On a genuinely slow link this can oscillate. **[C]** And `SNAP_BACKLOG_BYTES` (256 KB) was
calibrated against *uncompressed* frames; post-deflate the same 256 KB is **~9–14 seconds**
of arrears rather than the ~1.3 s the comment reasons about. **[C][M]**

**Recommendation:** re-derive the constant from compressed frame sizes, and prefer
*skipping deltas* over *forcing a keyframe* until the backlog actually drains. Do not add
adaptive rate control beyond this; the room-per-match shape does not need it.

---

# PHASE 12 — Server cost model

See §2.6 for the table. Labelling discipline, per `capacity.md`'s own rules:

| number | status |
|---|---|
| 0.075 cores/room driven DECODE, 13.3 rooms/core | **MEASURED** — capacity.md §1 |
| 0.031 cores/room parked | **MEASURED** — capacity.md §1 |
| wire KiB/s per client (corrected table, §2.2) | **MEASURED** this session |
| 32.0 µs/artifact, 0.66 µs/particle | **MEASURED** this session |
| −41…−58% from 3 dp | **MEASURED** this session |
| per-room memory (§2.4) | **MEASURED** this session |
| 120-room fleet ceiling | **CONFIRMED BY CODE** |
| ~100 rooms/machine at `SIM_WORKERS=8` | **DESIGNED-NOT-BUILT** — scaling-multicore.md §6 |
| 400–800 MB/machine at 100 rooms | **EXTRAPOLATED** from measured per-room memory |
| $/day at 2,000 CCU | **EXTRAPOLATED**, at the stamped $0.02/GB — re-check the real rate |
| absolute latency, jitter, loop-lag thresholds | **NOT MEASURABLE** on this box — capacity.md §0 |

**The compounding line is Neon replay storage**, not egress or compute: 157 GB/day at
2,000 CCU, and `replays` has no retention. **[M][C]**

---

# PHASE 13 — Latency budget

| stage | cost | fixed by design? |
|---|---|---|
| input → local prediction | **0 ms** (predicted) | yes |
| input → server | ½ RTT | no |
| server buffer → applied | 0–16.7 ms (`frameCommands(tick+1)`) | yes |
| step → broadcast | 0–33.3 ms (`SNAPSHOT_INTERVAL` 2) | yes |
| deflate | libuv threadpool, off the event loop | yes |
| server → client | ½ RTT | no |
| snapshot → render (remotes) | **83 ms** (`INTERP_DELAY_TICKS` 5) | yes |

**Fixed floor for seeing a remote robot: ~100–133 ms + RTT.** The local robot is 0 ms
because it is predicted. **[C]**

**What a collision looks like:** the server's version is authoritative. The local player
sees their own robot react immediately (prediction) and the opponent react ~83 ms + ½ RTT
late; the opponent sees the mirror image. Both converge on the next snapshot, and a
divergence over `SMOOTH_MAX_DIST` (16 in) snaps rather than eases (`game.ts:1020-1024`).
**[C]**

⚠️ Every *absolute* latency figure needs a Linux run (`dsim-alpha`). The dev box's idle
`monitorEventLoopDelay` p50 is already 15.6 ms — 94% of a tick budget before a room exists.
capacity.md §0. **[M]**

## 13.1 The deflate threadpool, priced for TODAY

zlib runs on the libuv threadpool, which is **per process** and defaults to **4 threads**.
At `MAX_ROOMS` 24 × ~4 clients × 30 Hz that is **~2,900 deflate jobs/second** through 4
threads today, before any worker-thread work exists. `concurrencyLimit: 20`
(`index.ts:1735`) bounds concurrent jobs, not pool size. **[C][E]**

`scaling-multicore.md` §4 flags `UV_THREADPOOL_SIZE` as the SIM_WORKERS trap. **It is
already a live concern on the single-threaded server**, and it presents as latency, not
CPU — exactly the axis this dev box cannot measure. **First thing to look at on the Linux
run.**

---

# PHASE 14 — Failure modes

| failure | server | client | match survives? |
|---|---|---|---|
| socket drops | `detach`; robot coasts, `ZERO_CMD` after 15 ticks; 45 s grace | 40 retries ≈ 48 s, deliberately longer | **yes** within 45 s |
| everybody drops | **clock FREEZES** (`room.ts:1399-1403`); `checkGrace` runs on the wall clock | — | yes |
| refused rejoin | — | `rejoined{ok:false}` → hard `failed` | no |
| region at `MAX_ROOMS` | `error{code:'region_full'}` | "pick a different region" | **a staged ranked match cannot** — the code names one region |
| slow client | skipped past `SNAP_BACKLOG_BYTES`, unprimed | receives a *larger* keyframe | yes, possibly oscillating |
| malformed frame inbound | double-guarded (`index.ts:2077-2083`) | **unguarded `JSON.parse`** — silently lost | yes |
| half-open TCP | ws heartbeat terminates → normal teardown | — | yes |
| satellite throttled | sheds sim time; `cores` stays flat | stutter | degraded, **invisible to the operator** |

---

# PHASE 15 — Implementation plan

### Stage 0 — measure honestly (hours, no product risk)

1. `costprobe.ts:229` — deep-copy the baseline. **Every bandwidth number depends on this.**
2. Re-run `npm run costprobe`. Update `docs/capacity.md` §2 and the `fly.toml` sizing note.

### Stage 1 — security and correctness (hours)

3. Delete `autoPath`/`autoPathEnabled` from `LobbyPlayer` and `PlayerPatch`
   (`protocol.ts:154-155`, `:212`). The server discards them at `room.ts:1015` and no
   client reads them.
4. Add the `backlog()` guard to `broadcast()` (`room.ts:1889`), matching `sendTo`.
5. Wire `onBehaviour` as the 8th arg at `index.ts:1917` + import `persistBehaviour`.
   **Then convert the 7-deep positional tail to a named options object** — the same
   omission is one argument away from hitting `onDodge`.
6. `dropQueue()` in the `signedIn` transition effect (`App.tsx:998-1006`).
7. Route `spectateRoom` through `roomJoinRegion` (`App.tsx:672-674`).

### Stage 2 — the bandwidth win (days)

8. The 3 dp replacer at `room.ts:1834`, `:1877`, and the diff key at `:1810`.
9. Smoke: assert `worldHash` is unchanged across the replacer over a recorded tick stream —
   this is the safety proof, and it is one assertion.
10. Cap or tail `world.events`.

### Stage 3 — storage (days)

11. A retention policy for `replays`. Follow the `PRACTICE_KEEP`/`LAN_KEEP` precedent: keep
    N per user, or prune by age past the current season.
12. Sweep `matches.replay_id` in `deleteAccount` (`repo.ts:1543-1556`) — today a versus
    replay is unreachable and survives account deletion carrying user-entered
    `name`/`teamName`/`teamNumber`.

### Stage 4 — capacity (weeks, prototype-gated)

13. Linux baseline on `dsim-alpha` — **nothing below is judgeable without it.**
14. Derive `MAX_ROOMS` per machine rather than a flat 24.
15. Raise `UV_THREADPOOL_SIZE`; measure the deflate pool under load.
16. `SIM_WORKERS=1` (slower than none, on purpose — it prices the hop), then sweep 2/4/8.
    **Budget the memory first** (§2.4): a 1 GB machine will not hold 100 rooms.
17. Only then: the fleet ceiling — more regions, or machine-granular routing.

---

# PHASE 16 — Testing strategy

Reuse what exists; add three assertions, not a framework.

| change | suite | new check |
|---|---|---|
| 3 dp wire rounding | `npm test` | `worldHash` equality across the replacer; snapshot round-trip through `unslimWorld` |
| ball diff comparator (if #7 is taken) | `npm test` | **property test**: `fieldSame(a,b) === (JSON.stringify(a)===JSON.stringify(b))` over mutated artifacts — this also closes §17.4 |
| `autoPath` removal | `npm test` | `sanitizePlayer` fuzz already at `smoke.ts:14404`; assert the keys are gone |
| `onBehaviour` wiring | `npm run dbtest` | a ranked finalize writes the standing row |
| replay retention | `npm run dbtest` | prune keeps N and deletes the pruned replays (mirror the `PRACTICE_KEEP` test) |
| `MAX_ROOMS` per machine | new unit | admission lives in `index.ts` |

**No version bump is required for the 3 dp change** — replays are input logs and never
carry wire values. A change that *did* alter `step()` output would need `SIM_VERSION`
(Appendix B rule 9). **[C]**

---

# PHASE 17 — Benchmarking plan

Extend the existing harness; do not build a new one.

1. **`scripts/costprobe.ts`** — fix the baseline (Stage 0), then add a `--dp=N` flag so the
   precision lever is measurable in the tool everyone already runs.
2. **`scripts/loadtest.ts` + `loadsweep.sh` + `loadsummary.ts`** — the room ladder. Re-run
   on **Linux (`dsim-alpha`)**; `capacity.md` §0 is explicit that absolute latency, jitter
   and loop-lag are not measurable on the Windows dev box, and that the honest saturation
   signal is **snapshot-gap p50/p99**, never `cores`.
3. **`scripts/zz-deflate-cost.ts`** — the TCP-level authority. Re-run it after the 3 dp
   change; it counts real `bytesRead` rather than modelling zlib, and it is the number to
   quote.
4. **New, small:** a per-tick cost probe splitting `step()` from the snapshot build, and a
   ground-element sweep. Both were written this session and are the basis of §2.3; they
   belong in `scripts/` if the room-cost question recurs.

**Gating numbers for `SIM_WORKERS`:** snapshot-gap p50 < 45 ms with no drops, at a room
count where single-threaded already sheds; plus RSS against the machine's memory.

---

# PHASE 18 — Risks introduced

| change | risk | mitigation |
|---|---|---|
| 3 dp rounding | a field where 1e-3 is semantically significant | `worldHash` already quantizes at exactly this precision; the smoke assertion proves it |
| 3 dp rounding | `rngState`/ids/counts corrupted | the `Number.isInteger` guard, tested |
| field-wise ball comparator | silent drop of a field added later | property test against `JSON.stringify` — mandatory, and it closes §17.4 |
| `world.events` cap | client re-shows events on the shrink reset (`game.ts:977`) | use the tail form behind a caps gate, or accept a rare duplicate toast |
| `autoPath` removal | a future auto-path feature needs it | it is discarded at `room.ts:1015` today; re-add bounded when the feature exists |
| replay retention | destroying an archive | keep-N-per-user, never delete the current season; mirror `PRACTICE_KEEP` |
| `SIM_WORKERS` | memory, and `UV_THREADPOOL_SIZE` | budget both **before** the sweep; `SIM_WORKERS=0` default |

---

# PHASE 19 — Final recommendation

**Do not rewrite the synchronization engine.** It is correct, carefully reasoned, and
already implements the techniques a review like this normally recommends. The wins are
elsewhere, and three of them are cheap:

1. **Fix `costprobe`'s baseline** before anyone sizes anything again. One line; it is
   currently under-reporting Chain Reaction's bandwidth by 9.5×.
2. **Round the wire to 3 decimal places.** 41–58% of the wire, no protocol version, no
   client change, and the safety argument is that `worldHash` already quantizes there.
3. **Delete `LobbyPlayer.autoPath` from the wire** and put a `backlog()` guard on
   `broadcast()`. It is an unbounded amplification vector on the process that runs every
   room in the region, and no client reads the field.

Then: **wire `onBehaviour`** (every ranked standing charge is silently dead), **give
`replays` a retention policy** (the only compounding cost line), and **stop planning to
port CR particles to Rapier** (measured at 48× per element).

The ceiling above all of it is topological, not computational: **120 rooms, service-wide.**
`SIM_WORKERS` takes that to ~500 and no further. If 2,000 concurrent is a real target, the
next architectural decision is about **routing and regions**, not about CPU per room.

---

# Developer specification

## What to change, exactly

| # | file:line | change |
|---|---|---|
| 1 | `scripts/costprobe.ts:229` | deep-copy the baseline artifact |
| 2 | `server/room.ts:1834`, `:1877` | `JSON.stringify(…, round3)` |
| 3 | `server/room.ts:1810` | round the diff key with the same function |
| 4 | `src/net/protocol.ts:154-155`, `:212` | delete `autoPath`/`autoPathEnabled` from `LobbyPlayer` + `PlayerPatch` |
| 5 | `server/room.ts:1889` | `if (c.backlog && c.backlog() > SNAP_BACKLOG_BYTES) return;` |
| 6 | `server/index.ts:1917` + `:12` | pass `(b) => void persistBehaviour(b)`; import it |
| 7 | `server/room.ts:398-426` | convert the callback tail to a named options object |
| 8 | `src/ui/App.tsx:672-674` | route through `roomJoinRegion` |
| 9 | `src/ui/App.tsx:998-1006` | `dropQueue()` on the `signedIn` transition |
| 10 | `server/db/repo.ts:1543-1556` | sweep `matches.replay_id` in `deleteAccount` |
| 11 | new | replay retention, mirroring `PRACTICE_KEEP` |
| 12 | `server/index.ts:377-385` | derive `MAX_ROOMS` from the machine |

## Invariants (unchanged, all respected above)

1. `session: null` ⇒ solo path bit-identical.
2. Predict on `localizeCommand(cmd)`, in both paths.
3. `world.rngState` is the only shared randomness.
4. `server/` imports `src/games/sim.ts` only.
5. `LobbyClient.on()` replaces; `updateQueue` returns a new object.
6. Remote robots are **stepped**, not merely lerped.
7. Replay-affecting change ⇒ version bump. *(None of the above is one.)*
8. Protocol stays backward-compatible; new features gate on `CLIENT_CAPS`/`SERVER_CAPS`.
9. `Room.ranked` only ever from a staged `pending_matches` row.
10. **New:** the 30 Hz snapshot stays ~99.8% shared. Per-recipient work belongs on the
    roster plane, not the snapshot plane.

## Numbers to re-measure before quoting

Everything in §2.2 and §2.6 after fixing `costprobe`; everything absolute about latency
after a Linux run. `capacity.md` §0 is the standing rule and it still applies.
