# DSIM multiplayer synchronization engine — review, cost model, and plan

**Measured 2026-09-11 at `1b72858`/`8cd4d61`. Re-verified claim-by-claim 2026-09-12 at
`593ac86`, which is where the citations below point.** Companion to
`docs/multiplayer-architecture.md` (what the system IS), `docs/capacity.md` (what it
COSTS), and `docs/scaling-multicore.md` (the unbuilt multi-core path). This document is the
third question: **what is inefficient, what should change, and in what order.**

**No code was modified for either pass.** Tree green at both: `npm test` ALL PASS ·
`npm run server:check` clean · `npm run test:mm` 184 checks (58 when this was first
written — the matchmaker grew a skill-pairing suite in between).

⚠️ **Citations are by SYMBOL, not by line.** The first draft cited line numbers and every
one in `server/room.ts`, `server/index.ts` and `src/net/protocol.ts` drifted within the
week as the LAN-over-WebRTC work landed. Two were wrong when written rather than drifted:
`costprobe`'s baseline is at **`:220`** (that file has not changed at all), and `worldHash`
lives in **`src/net/checksum.ts`**, not `src/sim/`.

⚠️ **The measurements were taken at `8cd4d61` and are NOT re-measured here.** `git diff
8cd4d61 593ac86` touches nothing on the snapshot path — the commits between are matchmaker
and LAN work — so every **[M]** below still describes this build. **[C]**

## Evidence labels — used on every claim

| | meaning |
|---|---|
| **[C]** | confirmed by code — the cited symbol was read at `593ac86` |
| **[D]** | per `docs/multiplayer-architecture.md` — its section cited |
| **[M]** | measured 2026-09-11 — the probe is named and reproducible |
| **[P]** | designed but NOT built — `docs/scaling-multicore.md` |
| **[E]** | estimate — arithmetic shown |

Probes were run from a scratchpad, not the repo: plain `tsx` scripts over the real
`step()`, the real `slimWorld`, and the real ball diff, reproducible by re-creating them
against the same entry points.

---

## 0. Summary

The synchronization engine is **well built and correctly reasoned**. Server authority is
real, the client predicts every robot (not just its own) so contact is honest, the
shared-prefix encode makes broadcast O(balls) rather than O(recipients), and
`permessage-deflate` at 15/8 has already taken 82–88% off the wire. There is no
architectural rewrite to recommend, and most of the standard sync-engine toolkit —
interest management, AOI culling, spatial partitioning, priority tiers — **does not
apply**, because a room holds 2–4 robots and everyone in it must see the whole field (§4).

Six findings change decisions.

1. **The measuring instrument is broken, and it under-reports the dominant cost by up to
   9.5×.** `costprobe.ts:220` rebuilds its ball-delta baseline from **live `Artifact`
   references**, which the sim mutates in place. `encodeBallDelta` compares with
   `JSON.stringify(prev) !== JSON.stringify(b)`, so with `prev === b` it can only ever
   report **zero changed balls**. Measured: costprobe's Chain Reaction solo figure of
   9.24 KiB/s per client is really **87.67 KiB/s**. Every bandwidth number quoted from
   costprobe since it was written is low. The production server is unaffected — `Room`
   stores the diff as *strings*, which in-place mutation cannot alias. **[C][M]**

2. **The client has the same aliasing bug, and there it is a correctness bug.**
   `applyBallDelta` stores and returns the caller's own `Artifact` objects into
   `ServerSession`'s running `baseBalls`; the controller then hard-swaps that array into
   `this.world` and **steps it**. So a ball the server omits from `upd` — by construction,
   one it believes unchanged — comes back as the client's own mutated copy and is never
   corrected. A clone in `applyBallDelta` fixes it. **This must land BEFORE the 3 dp
   rounding below**, which deliberately widens the set of balls the server calls
   unchanged. **[C]**

3. **One lever cuts 41–58% of the wire, needs no protocol version, no caps gate, and no
   client change.** Rounding every non-integer to 3 decimal places before diffing and
   before serializing. Rounding *helps* the deflate window rather than hurting it, which is
   why `capacity.md` §6 under-valued it 3× by measuring only RAW bytes. See §5 for the
   spec, including the keys to exempt. **[M]**

4. **`coerceAutoPath` accepts unbounded `shapes`, `sequence` and per-line `controlPoints`,
   and `LobbyPlayer.autoPath` rides `PlayerPatch` into an unguarded `broadcastRoster()`.**
   The *match* path is already safe — `Room.beginMatch` strips auto from every setup — and
   the remedy of deleting the roster field is therefore free. But the same coercer guards
   `localStorage` load and the practice-run upload that reaches the `replays` table, so
   bound it there rather than only removing the wire field. `broadcast()` also lacks the
   `backlog()` guard `sendTo` has. **[C]**

5. **The fleet cannot reach 2,000 CCU by a factor of ~11, and multi-core does not fix it.**
   `fly-replay` resolves to a REGION, one machine per region is enforced
   (`fly-deploy.sh --ha=false`), `DEPLOY_REGIONS` is **6** and `MAX_ROOMS` is 24 ⇒ **144
   rooms, service-wide.** 2,000 CCU needs ~1,625. `SIM_WORKERS` raises the per-machine term
   and leaves the ×6 untouched. **[C][P]**

6. **Rapier costs 48× per element what the bespoke integrator costs** — 32.0 µs per ground
   artifact vs 0.66 µs per CR particle — **because `solveRobots`/`solveArtifacts` rebuild a
   fresh Rapier world every round, deliberately, for reconcile safety** (`CLAUDE.md`,
   Physics). Porting CR's 300 particles to it, `CLAUDE.md`'s "Next up" item 1, would cost
   **~9.6 ms of a 16.67 ms tick for one room**. **Do not do it** — and do not re-measure
   against a persistent world and conclude this was wrong: a persistent world is a
   different design with a different determinism argument. **[M]**

Plus: **`replays` has no per-user retention** and a versus match's replay is unreachable by
`deleteAccount`. It is the only compounding line in the cost model (§2.6).

**Two prior findings are corrected.** `§17.9` of the reference doc (`world.gameSettings`
rides every snapshot) is **refuted**: `Room` calls `createWorld('match', seed, setups)` with
three arguments and `gameSettings` is the optional fourth, so it is `undefined` on every
server-authored world and `JSON.stringify` omits the key. Measured, removing it changes the
frame by **0.0%** in all four scenarios, and `grep '\.gameSettings'` across `src/` and
`server/` returns **zero consumers** — the right change is to delete the field, not strip
it. And the premise that "egress is ~90% of the bill" is **stale**: post-deflate it is 0.3×
compute for DECODE and 3.0× for Chain Reaction. **[C][M]**

---

## 1. What must not be optimized away

Three properties are load-bearing and every proposal below respects them.

| property | verified |
|---|---|
| Local robot simulated + rendered **predicted**; remote robots **simulated** forward and rendered interpolated; balls simulated, snapped, never lerped | **[C]** `game.ts` `displayWorld`/`cmdMap` |
| Remote robots are stepped from `Snapshot.cmds` so **robot-robot collision is real in the predicted world**. Anything that stops simulating them breaks contact prediction | **[C][D §8.2]** |
| The 30 Hz frame is **99.8% shared**: `broadcastSnapshot` memoizes the body per primed/unprimed class and appends a **21-byte** per-client tail (`,"ackInputTick":NNNN}`). A 4-driver room with 24 spectators does **one** `JSON.stringify`, not 28 | **[C][M]** |

The third is the constraint on every "per-recipient optimization" idea. Per-recipient work
belongs on the low-rate roster plane, where the ranked strategy-window redaction already
lives, never on the snapshot plane.

---

## 2. Cost model

### 2.1 Instrument correction — do this before quoting any number

`costprobe.ts:220` — `baseline = new Map(world.balls.map((b) => [b.id, b]))` — deep-copy it.
Measured `upd` per snapshot, exact server method, full 10,008-tick match:

| shape | costprobe (aliased) | true (server method) |
|---|---:|---:|
| DECODE solo | 0.0 balls | **1.9** |
| DECODE 2v2 | 0.0 | **7.8** |
| CR solo | 0.2 | **77.2** |
| CR 2v2 | 0.5 | **113.1** |

### 2.2 Network — corrected, MEASURED

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

Every lever, DECODE 2v2 against a 47.78 KiB/s base and CR solo against 87.67:

| lever | DECODE RAW | **DECODE WIRE** | CR RAW | **CR WIRE** |
|---|---:|---:|---:|---:|
| **round every non-integer to 3 dp** | 14.6% | **41.2%** | 16.8% | **50.9%** |
| drop `world.events` (send tail only) | 31.6% | **18.8%** | 0.2% | 0.2% |
| drop `robots` entirely (upper bound) | 29.8% | 45.2% | 5.7% | 7.3% |
| drop the ball `order` array | 0.8% | 0.7% | 7.1% | 5.1% |
| strip `gameSettings` | **0.0%** | **0.0%** | 0.0% | 0.0% |
| events + 3 dp combined | 46.2% | **58.0%** | — | — |

**[M]** Two independent measurements agree on the 3 dp figure to 0.1 percentage points.

**Why rounding helps the deflate window rather than hurting it:** a 17-significant-digit
IEEE literal is 17 near-random bytes an LZ77 matcher can almost never match, while a 3-dp
literal is both shorter *and* drawn from a small alphabet of repeating digit runs — the
literal cost and the match probability improve together.

**Quantizing the diff key as well compounds it**, by removing balls that "changed" only in
the far decimals:

| | upd/frame | WIRE KiB/s | saved |
|---|---:|---:|---:|
| CR solo, today | 77.2 | 87.67 | — |
| CR solo, 3 dp | 49.1 | **36.79** | **58.0%** |
| CR 2v2, today | 113.1 | 177.14 | — |
| CR 2v2, 3 dp | 89.5 | **81.81** | **53.8%** |
| DECODE 2v2, 3 dp | 7.4 | **28.06** | **41.3%** |

Behind this is a real defect: at tick 1500 a CR room reports **85 changed particles while
only 11 are moving** (|v| > 0.01); at tick 7500, 88 against 9. Roughly **70 stationary
particles per frame** are retransmitted as float noise. **[M]**

### 2.3 CPU — MEASURED, and it inverts the usual assumption

600-tick warmup, 1,800 ticks measured:

| scenario | `step()` µs/tick | snapshot build µs/tick | B/snap |
|---|---:|---:|---:|
| DECODE solo | **1242.4** | 36.6 | 2,799 |
| DECODE 2v2 | **2090.8** | 61.2 | 8,205 |
| CR solo | 322.2 | 119.8 | 4,259 |
| CR 2v2 | 541.6 | 141.5 | 7,884 |

**DECODE's Rapier round loop is ~4× more expensive than Chain Reaction's entire
300-particle solve.** The intuition that "300 particles is the big number" is wrong. **[M]**

- **CR's solve is linear and cheap.** `separateParticles`: cell = one particle diameter,
  3×3 neighbourhood, `o.id <= b.id` pair guard, 2 iterations. Once separated a
  diameter-sized cell holds at most ~4 centres, so the neighbourhood is bounded — O(n·k)
  with k self-limiting. Marginal **0.66 µs/particle** (0.51 at low density → 0.73 at 300).
  **[C][M]**
- **Rapier is 32.0 µs/artifact marginal** (0 → 170.4, 8 → 487.2, 16 → 722.7, 24 → 938.5
  µs/tick). At 24 artifacts the ground-artifact solve is **82% of DECODE's entire tick**.
  300 × 32.0 = **9.6 ms/tick for one room**, a ~34× room-cost increase. **[M]**
- **The pin round loop is not a multiplier.** `PHYS_PIN_ROUNDS` is 4, but measured over a
  full match **rounds = 1 on 99.8% of DECODE solo ticks and 98.9% of 2v2**, never past 2.
  Eliminating re-runs entirely saves 0.2–0.7%. **[M]**
- **The ball diff pays full serialization to answer a boolean.** `Room` runs one
  `JSON.stringify` per ball per broadcast: **63% of CR solo's encode**, 47% of CR 2v2's,
  24% of DECODE 2v2's. A field-wise comparator cuts it 67–69% ⇒ ~**+5% CR rooms/core**.
  The current approach is *correct by construction*; a comparator is a silent-drop hazard
  and must ship with a property test. **[M]**

### 2.4 Memory — MEASURED

Retained per room at match end (`maxMatchTicks()` = 10,008):

| shape | World | Replay buffer | `prevBalls` strings | heap delta |
|---|---:|---:|---:|---:|
| DECODE solo | 8 KiB | 213 KiB | 7 KiB | 0.9 MB |
| DECODE 2v2 | 19 KiB | 853 KiB | 7 KiB | 3.4 MB |
| CR solo | 44 KiB | 213 KiB | 80 KiB | — (GC noise) |
| CR 2v2 | 49 KiB | 852 KiB | 80 KiB | 2.9 MB |

**The `ReplayRecorder` dominates**, and it grows monotonically all match. Per socket,
permessage-deflate 15/8 costs ~256 KB of window server-side (`clientNoContextTakeover`
bounds the inflate side), plus `SNAP_BACKLOG_BYTES` 256 KB worst case. **[M][C]**

**Today CPU binds, not memory:** at `MAX_ROOMS` 24 that is ~24–82 MB of rooms + ~24 MB of
zlib windows against `fly.toml`'s 1024 MB. **[E]**

> **This flips under `SIM_WORKERS`.** At the plan's ~100 rooms/machine: rooms 100–340 MB,
> zlib windows 400 sockets × 256 KB = **102 MB**, backlog worst case another 102 MB, plus
> one Rapier wasm instance per worker isolate. **Order 400–800 MB against 1024 MB.**
> `scaling-multicore.md` §4 notes "memory cost per worker, once" but does not do this
> arithmetic. **Memory becomes the binding constraint at ~100 rooms, and the plan needs a
> VM bump to say so.** **[E][P]**

### 2.5 Scaling — and the ceiling above it

| quantity | value | source |
|---|---|---|
| driven DECODE room | 0.075 cores → **13.3 rooms/core** | **[M]** capacity.md §1 |
| parked room | 0.031 cores → 32.4 rooms/core | **[M]** capacity.md §1 |
| driven CR room | 0.038–0.045 cores | **[M]** capacity.md §1 |
| one process | **one core** (Node is single-threaded) | **[M]** capacity.md §3 |
| `MAX_ROOMS` | `process.env.MAX_ROOMS`, else `REGION ? 24 : 0` | **[C]** index.ts |
| `DEPLOY_REGIONS` | **6** (`iad ord sjc lhr syd nrt`) | **[C]** regions.ts |
| machines per region | **1, enforced** (`--ha=false`) | **[C]** fly-deploy.sh |

⚠️ Do not conflate the two cores/room figures. costprobe measures **pure sim + encode**
(0.0169 DECODE solo); capacity.md measures the **whole server process under load** (0.075).
capacity.md's is the one to size machines with.

**No O(rooms) work exists inside a per-room tick** — the scaling axis really is rooms. The
only true fan-out cost is the per-socket write and its deflate. The dominant per-tick terms
are O(artifacts) at 32 µs each (DECODE) and O(particles·k) at 0.66 µs (CR). **[C][M]**

**The fleet ceiling is the binding constraint.** `fly-replay` resolves to a **region**,
never a machine, and `--ha=false` is deliberate because two machines in one region would
split room codes silently:

```
6 regions × MAX_ROOMS 24                       =   144 rooms   ← service-wide, today
2,000 CCU at costprobe's 75% solo mix          = 1,625 rooms   ← 11.3× over
with SIM_WORKERS=8 (~100 rooms/machine) [P]    =   600 rooms   ← still 2.7× short
```

Multi-core raises the per-machine term and leaves the ×6 untouched. Reaching 2,000 CCU
needs **more regions or machine-granular routing** — a routing change, not a CPU one.
(`gru` and `jnb` have live machines already but stay out of `DEPLOY_REGIONS` until they are
sized past 512 MB; moving them in is +2 regions for the price of a resize.) **[C][P]**

**Secondary: 24 is uniform across non-uniform machines.** `fly-deploy.sh` re-applies
`shared-cpu-1x` to sjc/lhr/syd/nrt while only iad keeps `shared-cpu-4x`, and `fly.toml`
states in its own words that a shared-cpu-1x sustained baseline is "a fraction of a core ≈
ONE busy room". The cap was sized for the primary. **`MAX_ROOMS` already reads the
environment**, so this is `-e MAX_ROOMS=N` in the satellite loop, not new code. The failure
is not graceful: `Room.startLoop` sheds simulation rather than consuming CPU, so
`/api/perf` `cores` stays flat while every match stutters (capacity.md §0 measured gap p50
35 ms → 248 ms between 8 and 48 rooms). **[C][M]**

### 2.6 Corrected hosting model, 2,000 CCU

Egress on the **corrected** wire rates; compute on capacity.md's whole-server cores/room at
65% utilisation and `$257.54/8` per vCPU-month; egress at the stamped `$0.02/GB`. **[M][E]**

| population | rooms | cores | egress GB/day | egress $/day | compute $/day | **egress : compute** |
|---|---:|---:|---:|---:|---:|---:|
| all DECODE | 1,625 | 131 | 3,526 | $71 | $217 | **0.3×** |
| 50/50 | 1,625 | 105 | 11,498 | $230 | $173 | **1.3×** |
| all Chain Reaction | 1,625 | 79 | 19,471 | $389 | $130 | **3.0×** |
| *(what costprobe reports, 50/50)* | 1,625 | 105 | 2,562 | $51 | $173 | 0.3× |
| **50/50 with 3 dp quantize** | 1,625 | 105 | **5,287** | **$106** | $173 | **0.6×** |

**Which game the population plays moves the bill more than any optimization in this
document**: an all-CR population costs 5.5× the egress of an all-DECODE one at identical
CCU. **[M]**

**The compounding line is Neon replay storage** — ~157 GB/day at 2,000 CCU **[E]** — and
per-user retention does not exist. `purgeSeasonReplays` is the one existing lever and it is
per archived season, admin-triggered. Neither egress nor compute is the ceiling. **144
rooms is.**

---

## 3. Findings

Every row was read at `593ac86`. Severity is effect on rooms/core, bytes/room, or
correctness.

| # | finding | where | severity |
|---|---|---|---|
| 1 | `costprobe` baseline aliases live `Artifact`s ⇒ delta always empty; every bandwidth number low, ×9.5 for CR | `costprobe.ts:220` | **Critical** |
| 2 | Full-precision IEEE doubles on the wire — **−41% DECODE / −51% CR** available | `Room.broadcastSnapshot` | **Critical** |
| 3 | Fleet ceiling **6 × 24 = 144 rooms**, service-wide; 11.3× short of 2,000 CCU | `routeTarget`, `DEPLOY_REGIONS`, `MAX_ROOMS`, `fly-deploy.sh` | **Critical** |
| 4 | No per-user retention on `replays`; versus replays unreachable by `deleteAccount`, and they carry user-entered `name`/`teamName`/`teamNumber` | `persist.ts`, `repo.ts` `deleteAccount` | **Critical** |
| 5 | `applyBallDelta` returns baseline objects the predicted sim then mutates ⇒ a ball the server does not re-send is never corrected | `protocol.ts` `applyBallDelta`, `serverSession.ts` `baseBalls` | **High** |
| 6 | `coerceAutoPath` leaves `shapes`/`sequence`/`controlPoints` unbounded — also the guard on settings load and the practice-run → `replays` upload | `spawn.ts` `coerceAutoPath` | **High** |
| 7 | `MAX_ROOMS` 24 applied to `shared-cpu-1x` satellites: 6–24× oversubscribed, machines flap, invisible on `cores` | `fly-deploy.sh` satellite loop | **High** |
| 8 | Ball diff `JSON.stringify`s every ball every broadcast — **63% of CR solo's encode** | `Room.broadcastSnapshot` | **High** |
| 9 | ~~`onBehaviour` never wired in production~~ **WITHDRAWN — false, and was false when written.** `matchmaking.ts` passes `persistBehaviour` as the 8th `Room` argument. The first pass read only the custom-room construction in `index.ts`; those rooms never set `Room.ranked`, which `reportBehaviour` guards on, so standing charges are live exactly where they can apply. It carried a ✔, so the adversarial pass missed it too | — | **withdrawn** |
| 10 | `world.events` monotonic, never cleared, re-sent whole 30×/s: **18.8% of a DECODE 2v2 frame** (15 `events.push` sites) | `types.ts`, sim + games | **High** |
| 11 | ~70 stationary CR particles retransmitted per frame as float noise — fixed by #2 | `Room.broadcastSnapshot` + `chain/play.ts` | **High** |
| 12 | `backfillRobot` has no CR branch; `catalystRail` un-backfilled ⇒ old→new skew NaNs a CR robot | `protocol.ts` `backfillRobot` | **High** |
| 13 | `sanitizeReplay` takes a `game` and never passes it to `coerceSetup`, which snaps G304 unconditionally ⇒ a CR replay re-sims a robot moved across the field before CR's own snap runs | `sanitize.ts`, `spawn.ts` `coerceSetup` | **High** |
| 14 | `broadcast()` has no `backlog()` guard where `sendTo` does | `Room.broadcast` | **Medium** |
| 15 | `SNAP_BACKLOG_BYTES` calibrated pre-compression: 256 KB is now ~9–14 s of arrears, not the ~1.3 s reasoned about | `room.ts` | **Medium** |
| 16 | Parked ranked queue survives sign-out ⇒ wrong account enters a rated match | `queueKeeper.ts`, 2 call sites | **Medium** |
| 17 | Production ball-delta path has no codec-level test — would also have caught #1 | `Room` vs `encodeBallDelta` | **Medium** |
| 18 | `coerceStartIndex` clamps to DECODE's `START_POSES.length` for CR ⇒ silently different corner | `sanitize.ts`, `chain/spawn.ts` | **Medium** |
| 19 | Client inbound `JSON.parse` unguarded (`decodeServerMsg`) ⇒ one bad frame kills the handler silently | `protocol.ts`, `transport.ts` | **Low** |
| 20 | `spectateRoom` omits `region` where `roomJoinRegion` would fall back to the watcher's own pick ⇒ "no such room" for a bare custom code | `App.tsx` | **Low** |
| 21 | SFX re-cue on reconcile replay — audible under loss | `game.ts` | **Low** |
| 22 | `world.gameSettings` — **refuted as a cost (0.0% measured), latent as a trap**: it sits inside `Omit<World,'balls'\|'robots'>`, so if anyone ever passes settings server-side it silently starts riding every snapshot. Delete it | `types.ts`, `spawn.ts`, `game.ts` | **Info** |

---

## 4. Techniques evaluated and rejected

| technique | applies? | why |
|---|---|---|
| Interest management / AOI / spatial partitioning **for visibility** | **No** | 2–4 robots per room, full-arena visibility is a product invariant. The one place a spatial hash earns its keep is already built — `separateParticles`' grid — and it is for *physics* |
| Priority-based replication tiers | **No** | Tiers pay off when a client sees more entities than it can afford. CR's 300 all fit in one 12′ square on screen |
| Bit-packing / binary wire (protobuf, flatbuffers) | **No, would regress** | The wire is already 8–11× compressed with context takeover; binary has higher entropy per byte and compresses *worse*. The 3 dp win comes precisely from making the text **more** repetitive. It would also break the shared-prefix encode |
| Rollback netcode | **No** | Reconcile is snap-and-replay. Rollback buys frame-perfect fighting-game inputs; a driving sim with 83 ms interpolation does not need it |
| Per-field dirty bits on robots | **Measure first** | Removing robots *entirely* saves 45.2% of DECODE 2v2 and only 7.3% of CR solo. 3 dp takes 41–51% for no protocol version. Do #2, re-measure, then decide. If ever built: a per-robot bitmask **in the shared body**, never per-recipient |
| Spectators at 15 Hz | **After #2 only** | 24 × 177.14 KiB/s = **4.15 MiB/s from one CR room**, so halving is real. But the client's quality dot buckets on measured rate (would read CHOPPY permanently) and `INTERP_DELAY_TICKS` 5 is tuned for 30 Hz arrival. Needs a `SERVER_CAPS` field. 3 dp takes ~51% off the same stream for none of it |
| Delta compression · prediction · remote-entity prediction · interpolation · snapshot compression · backpressure | **Already built** | `encodeBallDelta`, `reconcile`, `Snapshot.cmds`, `displayWorld`, 15/8 deflate, `SNAP_BACKLOG_BYTES` (mis-calibrated, #15) |
| Lockstep / determinism checksums on the wire | **Deliberately removed** | `worldHash` survives for replay + smoke only; its doc comment is stale lockstep prose |

**Nothing in the MMO/battle-royale toolkit is missing here.** The wins left are in
*precision*, *retention*, and *topology*.

---

## 5. The precision change, specified

```ts
// server/room.ts — one shared replacer, used at both snapshot stringify sites
const WIRE_DP = 1000; // 3 dp — matches worldHash's own quantization (net/checksum.ts)
const round3 = (k: string, v: unknown): unknown =>
  typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v) && !TIME_KEYS.has(k)
    ? Math.round(v * WIRE_DP) / WIRE_DP
    : v;
```

**The `Number.isInteger` guard is load-bearing.** `world.rngState` is a 32-bit mulberry32
integer, and `world.tick`, ball ids and every count are integers. A naive `toFixed(3)` would
make them *longer* and would corrupt `rngState`. **[C]**

**`TIME_KEYS` is the correction to the first draft's safety argument.** That draft argued 3
dp is safe because `worldHash` already quantizes there. That proves *replay comparison* is
blind below 1e-3, **not that `step()` is**. Accumulated clocks compared against `world.time`
— `fireReadyAt` is the clear one — would be rounded independently of the clock they are
compared to, so a comparison within half a millisecond of its boundary flips a predicted
shot by one tick. It is cosmetic and self-corrects on the next snapshot, but the honest
options are to exempt time-like keys or to measure prediction-mismatch rate before and
after. Exempting is one `Set` and costs nothing measurable.

**What actually makes 3 dp safe is re-anchoring**, and **#5 is what makes re-anchoring true
for balls**: the client hard-swaps the world every snapshot, so a rounded value cannot
accumulate — *for any entity the server re-sends*. Balls omitted from `upd` are not
re-sent, which is exactly the case #5 describes and exactly the case rounding makes more
common. **Land #5 first.** For scale: 0.001 inch on a 144-inch field, against a
`SMOOTH_MAX_DIST` of 16 inches. **[C]**

**It is not a shape change** — a rounded number is still a number — so an older client
parses it unchanged. **No `CLIENT_CAPS` string, no `REPLAY_FORMAT` bump**; replays are input
logs and never carry wire values. The solo path never serializes, so `session: null` stays
bit-identical. **[C]**

**Round the diff key with the same function**, or the two disagree about what changed —
that is what removes the ~70 stationary CR particles per frame.

---

## 6. Implementation plan

### Stage 0 — measure honestly (hours, no product risk)

1. `costprobe.ts:220` — deep-copy the baseline. **Every bandwidth number depends on it.**
2. Re-run `npm run costprobe`; update `docs/capacity.md` §2 and the `fly.toml` sizing note.
   Add a `--dp=N` flag so the precision lever is measurable in the tool everyone runs.

### Stage 1 — correctness and security (hours)

3. **Clone in `applyBallDelta`** (#5). Blocks Stage 2.
4. Bound `coerceAutoPath`: cap `shapes`, `sequence`, per-line `controlPoints` (#6). Then
   delete `autoPath`/`autoPathEnabled` from `LobbyPlayer`/`PlayerPatch` — `beginMatch`
   already strips them, so nothing reads the roster copy.
5. `backlog()` guard on `broadcast()`, matching `sendTo` (#14).
6. Pass `game` through `sanitizeReplay` → `coerceSetup`, and give `coerceStartIndex` the
   right anchor count per game (#13, #18).
7. `dropQueue()` in the `signedIn` transition effect (#16); route `spectateRoom` through
   `roomJoinRegion` (#20); guard `decodeServerMsg` (#19).

### Stage 2 — the bandwidth win (days)

8. The 3 dp replacer at both stringify sites and on the diff key (§5), with `TIME_KEYS`.
9. Smoke: `worldHash` unchanged across the replacer over a recorded tick stream; snapshot
   round-trip through `unslimWorld`. One assertion each, and they are the safety proof.
10. Cap or tail `world.events` (#10). The tail form needs a caps gate; the cap does not, at
    the price of a rare duplicate event on the client's shrink reset.

### Stage 3 — storage (days)

11. Per-user retention for `replays`, mirroring `PRACTICE_KEEP`/`LAN_KEEP` — keep N per
    user, never delete the current season. `purgeSeasonReplays` stays the archived-season
    lever. `npm run dbtest`: prune keeps N and deletes the pruned replays.
12. Sweep `matches.replay_id` in `deleteAccount` (#4).

### Stage 4 — capacity (weeks, prototype-gated)

13. **Linux baseline on `dsim-alpha` — nothing below is judgeable without it.** The honest
    saturation signal is snapshot-gap p50/p99, never `cores` (capacity.md §0).
14. Per-machine `MAX_ROOMS` via `-e MAX_ROOMS=N` in `fly-deploy.sh`'s satellite loop (#7).
15. Raise `UV_THREADPOOL_SIZE` and measure the deflate pool under load. It is **already** a
    live concern: zlib runs on the per-process libuv pool, which defaults to **4**, and 24
    rooms × ~4 clients × 30 Hz is ~2,900 deflate jobs/s through it. It presents as latency,
    not CPU — exactly the axis a Windows dev box cannot measure. **[C][E]**
16. `SIM_WORKERS=1` (slower than none, on purpose — it prices the hop), then sweep 2/4/8.
    **Budget the memory first** (§2.4): a 1 GB machine will not hold 100 rooms.
17. Only then the fleet ceiling: size `gru`/`jnb` past 512 MB and move them into
    `DEPLOY_REGIONS` (+2 regions, no code), or machine-granular routing.

**If the ball-diff comparator (#8) is ever taken**, it ships with a property test —
`fieldSame(a,b) === (JSON.stringify(a)===JSON.stringify(b))` over mutated artifacts — or it
is a silent-drop hazard the moment someone adds a field. That test also closes #17.

---

## 7. Developer specification

| # | symbol | change |
|---|---|---|
| 1 | `costprobe.ts:220` | deep-copy the baseline artifact |
| 2 | `protocol.ts` `applyBallDelta` | clone each `upd` entry into the baseline |
| 3 | `room.ts` `broadcastSnapshot` | `JSON.stringify(…, round3)` at both body sites; same rounding on the diff key |
| 4 | `spawn.ts` `coerceAutoPath` | cap `shapes`, `sequence`, per-line `controlPoints` |
| 5 | `protocol.ts` `LobbyPlayer`/`PlayerPatch` | delete `autoPath`/`autoPathEnabled` |
| 6 | `room.ts` `broadcast` | `if (c.backlog && c.backlog() > SNAP_BACKLOG_BYTES) return;` |
| 7 | `sanitize.ts` → `spawn.ts` `coerceSetup` | thread `game`; per-game start-index clamp |
| 8 | `App.tsx` | `dropQueue()` on the `signedIn` transition; `spectateRoom` via `roomJoinRegion` |
| 9 | `repo.ts` `deleteAccount` | sweep `matches.replay_id` |
| 10 | new | per-user replay retention, mirroring `PRACTICE_KEEP` |
| 11 | `fly-deploy.sh` | `-e MAX_ROOMS=N` per satellite |

### Invariants — unchanged, all respected above

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

### Before quoting any number again

Everything in §2.2 and §2.6 after fixing `costprobe`. Everything absolute about latency
after a Linux run — the dev box's idle `monitorEventLoopDelay` p50 is already 15.6 ms, 94%
of a tick budget before a room exists. `capacity.md` §0 is the standing rule. The published
rates behind §2.6 are stamped in `costprobe.ts`; re-check them before quoting a dollar.
