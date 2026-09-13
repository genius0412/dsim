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

> ## ⚠️ STATUS: EXECUTED 2026-09-12/13. READ THIS BOX BEFORE ANY ROW BELOW.
>
> Stages 0–4 were built (§6). **The findings table and the developer spec below are the ORIGINAL
> audit and several of their rows are now false** — they are kept, struck through, with the
> correction beside them, because "we already checked that" is the expensive thing to lose.
>
> **Four findings were dead on re-verification** (#12, #18 already fixed; #13, #20 real but much
> narrower than stated) and **four more were withdrawn on analysis** (#8, #14, #22, and #15 reduced
> to a comment fix). **Three of this document's own prescribed fixes do not work as written** — see
> the as-built column in §7.
>
> **Two new findings**, neither in the original table: **#23, `--ha=false` is on the alpha deploy
> line only** — production deploys bare, and a second machine in one region silently splits a room
> code, which is Critical; and `world.events` has 25 push sites, not 15.
>
> **The headline result is §5**: the wire is rounded to 3 dp, measured at **−41% DECODE / −54-58%
> Chain Reaction**, fleet egress 39.9 → 23.3 MB/s. It costs CPU (38.2 → 41.5 cores) and that was
> measured too.
>
> **The Stage 4 ceiling arithmetic in this document is wrong** — `MAX_ROOMS=6` on the satellites
> lowers the fleet ceiling, it does not raise it. That is the right trade and it is not the trade
> the plan describes. §6.


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
| 8 | ~~Ball diff `JSON.stringify`s every ball every broadcast~~ — **WITHDRAWN.** The stringify IS the diff key and the only reason the server is immune to #5's aliasing; the prescribed property test is false in one direction (`JSON.stringify` is key-order sensitive). Prize was ~+5% CR rooms/core against a ceiling short for unrelated reasons | `Room.broadcastSnapshot` | **High** |
| 9 | ~~`onBehaviour` never wired in production~~ **WITHDRAWN — false, and was false when written.** `matchmaking.ts` passes `persistBehaviour` as the 8th `Room` argument. The first pass read only the custom-room construction in `index.ts`; those rooms never set `Room.ranked`, which `reportBehaviour` guards on, so standing charges are live exactly where they can apply. It carried a ✔, so the adversarial pass missed it too | — | **withdrawn** |
| 10 | `world.events` monotonic, never cleared, re-sent whole 30×/s — **MEASURED AND NOT WORTH FIXING AS SPECIFIED.** 25 push sites, not 15. A cap at 64 saves **0 bytes** in DECODE solo, CR solo and CR 2v2 (the log never reaches 64) and 13.5% of the raw frame only in a synthetic foul-heavy DECODE 2v2 — while SILENTLY discarding 99 of that match's 163 toasts, because `collectNetEvents` diffs by absolute index and a saturating length never trips its shrink guard. Left uncapped; the hazard is now documented at the reader and the edge-triggering is pinned by a check | `types.ts`, sim + games | **High** |
| 11 | ~70 stationary CR particles retransmitted per frame as float noise — fixed by #2 | `Room.broadcastSnapshot` + `chain/play.ts` | **High** |
| 12 | ~~`backfillRobot` has no CR branch~~ — **REFUTED.** `catalystRail` is optional and every reader spells `?? 0` | `protocol.ts` `backfillRobot` | **High** |
| 13 | `sanitizeReplay` takes a `game` and never passes it to `coerceSetup`, which snaps G304 unconditionally ⇒ a CR replay re-sims a robot moved across the field before CR's own snap runs | `sanitize.ts`, `spawn.ts` `coerceSetup` | **High** |
| 14 | ~~`broadcast()` has no `backlog()` guard~~ — **WITHDRAWN.** All 9 call sites are ONE-SHOT control messages (`matchResult`, `eloResult`, `drop`, `error`) with no successor frame. A skipped *snapshot* is a coalesce; a skipped `drop` is a ghost robot forever. `WS_HEARTBEAT_MS`' `ws.terminate()` already closes the failure | `Room.broadcast` | **Medium** |
| 15 | `SNAP_BACKLOG_BYTES` comment was calibrated pre-compression — **COMMENT FIXED, NUMBER KEPT.** `ws.bufferedAmount` is post-deflate, so 256 KB is really 1.4–24 s by room shape (CR 2v2 vs DECODE solo). Lowering it risks skip→keyframe→skip — a skip UNPRIMES, so recovery is a full 300-ball CR keyframe — and under `WS_COMPRESS=0` the same number is RAW bytes | `room.ts` | **Medium** |
| 16 | Parked ranked queue survives sign-out ⇒ wrong account enters a rated match | `queueKeeper.ts`, 2 call sites | **Medium** |
| 17 | Production ball-delta path has no codec-level test — would also have caught #1 | `Room` vs `encodeBallDelta` | **Medium** |
| 18 | ~~`coerceStartIndex` clamps to DECODE's count~~ — **ALREADY FIXED**, per game, pinned in `smoke-biobuzz/core.ts` | `sanitize.ts`, `chain/spawn.ts` | **Medium** |
| 19 | Client inbound `JSON.parse` unguarded (`decodeServerMsg`) ⇒ one bad frame kills the handler silently | `protocol.ts`, `transport.ts` | **Low** |
| 20 | `spectateRoom` omits `region` where `roomJoinRegion` would fall back to the watcher's own pick ⇒ "no such room" for a bare custom code | `App.tsx` | **Low** |
| 21 | SFX re-cue on reconcile replay — audible under loss | `game.ts` | **Low** |
| 22 | ~~`world.gameSettings`~~ — **SKIPPED.** 0.0% measured; a 6-file sweep crossing into a lane another contract owns. `world.gameSettings` — **refuted as a cost (0.0% measured), latent as a trap**: it sits inside `Omit<World,'balls'\|'robots'>`, so if anyone ever passes settings server-side it silently starts riding every snapshot. Delete it | `types.ts`, `spawn.ts`, `game.ts` | **Info** |
| **23** | **`--ha=false` is on the ALPHA deploy line only; PRODUCTION deploys bare.** Rooms live in process memory and `routeTarget` resolves to a REGION, not a machine — so two machines in one region put two players in two rooms with the same code, silently, with no error on either screen. The alpha comment argues the production case verbatim | `scripts/fly-deploy.sh` | **Critical** |
| **24** | `world.events` has **25** push sites, not 15 (10 of them BIOBUZZ's, which was never measured) | `types.ts`, sim + games | Info |

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

## 5. The precision change, specified — **AS BUILT**

```ts
// server/wire.ts — a LEAF module, imported by server/room.ts AND scripts/costprobe.ts
export const round3 = (_k: string, v: unknown): unknown =>
  typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v;
```

Three corrections to the draft above, all found while building it:

**It does NOT live in `server/room.ts`.** Two reasons. `room.ts` sits in an import cycle, so a
`const` exported from it reads back `undefined` in a module that imports it without also pulling
in `Room` — which is exactly what `scripts/costprobe.ts` does, and the probe must not be able to
disagree with the server about this number. And it must not live in `src/net/protocol.ts` either:
that file is client-bundled, so a server-only wire helper there ships dead code to every browser.
`src/net/roomRegion.ts` is the existing precedent for a leaf module carved out for the same class
of reason. **[C]**

**`TIME_KEYS` CANNOT BE BUILT — it is dropped.** Three independent reasons, any one fatal:
it omits `world.time`, which is the LEFT side of every comparison it was meant to protect, so
exempting `fireReadyAt` leaves the identical error; two more clocks sit under *dynamic* keys no
`Set` reaches (`PenaltyState.episodes`, `ChainState.catalystReadyAt`); and a `JSON.stringify`
replacer cannot exempt a subtree at all, only a key name wherever it appears. **[C]**

**The real safety argument is one sentence, and the draft never makes it.** A ball's *rounded*
key changes the moment any field crosses a 0.0005 boundary — because the DIFF KEY is the rounded
serialisation — so the server re-sends it then, and the client is never more than 0.001 per field
from the server, indefinitely, with no ratchet. That holds even if the clone of #5 slips. For the
two clocks: both sides of every comparison go through this one replacer, so they are compared in
the same units, and a half-millisecond disagreement can at worst flip a fire-ready test for a
single tick — corrected by the next snapshot's snap-and-replay, and decided by the server anyway.

**`Number.isFinite` is dead code and was removed.** `Number.isInteger(NaN)` is already false, and
`JSON.stringify` writes a non-finite number as `null` either way. `Number.isInteger` stays, and is
what makes "ids, counts, scores, ticks and `rngState` are untouched" structural. **[C]**

**Round the diff key with the same function** — confirmed necessary and built. Rounding the frame
alone leaves the key comparing full-precision floats, so every near-stationary CR particle still
reads as changed and is re-sent.

**And `sendSnapshotTo` too**, which the draft said to skip. It is production (the reattach
keyframe), it goes out through both transports, and it is the LARGEST frame the server emits
(`upd` is every ball — all 300 in CR).

### Measured result

| scenario | wire before | wire after | cut |
|---|---|---|---|
| DECODE solo | 10.4 KiB/s | 6.1 KiB/s | **−41.3%** |
| DECODE 2v2 | 46.7 | 27.2 | **−41.8%** |
| Chain Reaction solo | 87.7 | 36.8 | **−58.0%** |
| Chain Reaction 2v2 | 177.1 | 81.8 | **−53.8%** |
| BIOBUZZ solo / 2v2 | 12.1 / 41.2 | 6.6 / 20.5 | −45.5% / −50.2% |

Fleet at 2,000 CCU: egress **39.9 → 23.3 MB/s**, total **$183 → $152/day**. It costs CPU, as
predicted — a replacer leaves V8's fast path — and that was measured too rather than assumed:
sim load **38.2 → 41.5 cores**. Egress is the larger term, so the trade is clearly right, but it
IS a trade and the number is here so nobody has to re-find it. **[M]**

No `CLIENT_CAPS` gate, no `REPLAY_FORMAT` or `SIM_VERSION` change: no key is added, removed or
retyped, `unslimWorld`/`applyBallDelta`/`reconcile` are value-blind, `QCommand` is integer-only so
`cmds` is untouched, and the solo path (`session: null`) never serializes and stays bit-identical.
Replays are an INPUT log, so no stored replay is affected. **[C]**

---

## 6. Implementation plan — **EXECUTED 2026-09-12/13**

Stages 0–4 were built. The plan below is what actually shipped, including where the original
plan (kept in git history) was wrong. Tree green throughout: `npm test` ALL PASS ×2 ·
`npm run server:check` clean · `npm run test:mm` 187 · `npm run dbtest` ALL PASS · `npm run build`.

### Stage 0 — fix the instrument

The root cause was NOT only the aliasing. **`encodeBallDelta` had zero production callers** —
`Room` hand-rolls the diff — so the probe was pricing a codec that does not ship. `costprobe.ts`
now copies the room's four lines (`prev: Map<number,string>`, one stringify per ball): same
algorithm, same CPU profile. It immediately reproduced the review's independently measured
**478.3 raw / 87.7 wire KiB/s** for CR solo, against the 9.24 it used to print.

The `--dp=N` flag was **withdrawn** — a knob for a value that is only ever 3 or absent. The probe
imports `round3` itself. And the `docs/capacity.md` / `fly.toml` sub-task was **deleted**:
capacity.md has zero costprobe references (its bandwidth figures come from
`scripts/zz-deflate-cost.ts`) and fly.toml's sizing note quotes a different probe.

### Stage 1 — correctness and security

- **#5 clone** — on `applyBallDelta`'s **RETURN**, not into the baseline: the function *returns*
  `order.map(id => baseline.get(id))`, so cloning on the way in fixes nothing. And `Artifact` has
  **three** nested objects the sim writes through in place (`pos`, `vel`, and `state` — `st.v`/
  `st.s`/`pending` on the rail, `st.lx`/`st.ly` in a hopper), so it is **four spreads**, not two.
- **#6 bounds** — `sequence` 400, `controlPoints` **8** (⚠️ never 2: readers treat length as the
  curve ORDER, so truncating to 2 turns a linear segment into a cubic), all **three** waits that
  reach `pathWaitTimer` clamped, and `shapes` **deleted outright** rather than capped — it had no
  reader anywhere, so the type, the coercer arm, the mirror block and the importer all went.
- **#13** — the real bug was in `coerceSetup`, and it is two: G304's snap is now gated on
  `simModuleFor(game).startLegality`, and `game` is threaded into `coerceSpec` **for the size
  envelope only**. The naive threading is a SIM-BEHAVIOUR change — an explicit `'decode'` arms the
  mount-reset branch, `intakeMount` moves the collider through `footprintExtents`, and every
  stored replay carrying a non-front mount would re-sim as a different robot. Narrowed
  deliberately; a smoke check holds the line. `createChainWorld` now calls `coerceSetup` (CR was
  the one game with no last line of defence — a spoofed `startIndex` **threw**), and
  `coerceBiobuzzSetup` collapsed onto the shared chokepoint, both reasons its header gave for
  forking having become false.
- **#14 WITHDRAWN, #19/#16/#20/#21 shipped.** #20 also fixed `rejoinGame`, which the review
  missed and which has the identical bare-code branch. #21 is a HIGH-WATER MARK (`>`), keeping the
  write inside the `if`: an unconditional write lowers `prev` to the server's re-simulated value
  and re-cues the same shot.

### Stage 2 — the bandwidth win

§5 above, as built, with the measured result. **#10 (`world.events`) was measured and not built** —
see finding 10: a cap at 64 saves literally zero in three of four scenarios and is silently lossy
in the fourth. The hazard is documented at `collectNetEvents` and the edge-triggering is pinned by
a check that would read 1,800 instead of 9 if a push site ever went per-tick.

### Stage 3 — storage

Per-user retention (item 11) was **not built and should not be**: `matches` has no `user_id` and
two-to-four owners, so `PRACTICE_KEEP`'s unit does not exist. What shipped instead:
`deleteAccount` sweeps `matches.replay_id` through `match_participants` (keeping the match row for
co-participants, with the cost written down); `saveReplay` scrubs robot/team names, which closes
the LAN path where a third party's name was stored unscrubbed; and a **new** finding — a one-sided
versus room wrote a `replays` row referenced by nothing, unreachable by `deleteAccount` and both
prunes.

### Stage 4 — capacity

**The review's ceiling arithmetic for this stage is wrong, and the two items must be priced
together.** `MAX_ROOMS=6` on the satellites does not take the fleet from 144 to 192 — it takes it
DOWN, because `SATELLITES` is not every region. That is the right trade (144 was never real
capacity; it was 6–24× oversubscription that presents as machines flapping, invisible on `cores`),
but it must be stated as a trade rather than as a gain.

Shipped: `--ha=false` on the **production** deploy line (finding 23 — it was alpha-only, and the
alpha comment argues the production case verbatim) plus duplicate-region detection, since the flag
is preventive only; `SATELLITE_MAX_ROOMS=6` passed as `--env MAX_ROOMS=` on the `fly machine
update` loop that already runs — it MUST live there, because `fly deploy` regenerates machine
config from fly.toml; `ord` moved into `SATELLITES`; and `snapSendGapMs` on `/api/perf`, per ROOM
and per BROADCAST, so send jitter is readable in production with no harness attached.

`UV_THREADPOOL_SIZE` is **withdrawn**: `ws` already bounds deflate concurrency twice (its global
`zlibLimiter`, and `index.ts`'s explicit `concurrencyLimit: 20`), and ~2,880 jobs/s is a CPU cost —
more threads do not create CPU, and extra runnable threads contend with the single 60 Hz sim
thread. The real lever was Stage 2, which removed 41–58% of the bytes entering the deflater.
`SIM_WORKERS` and machine-granular routing remain unbuilt, deliberately (the latter turns the
synchronous pure `routeTarget` into an async lookup on the WebSocket upgrade path, whose failure
mode is the exact split-lobby bug `--ha=false` prevents).

**The #8 property test is moot** — #8 is withdrawn, and it was false in one direction anyway
(`JSON.stringify` is key-order sensitive, so `fieldSame(a,b) === (JSON.stringify(a)===JSON.stringify(b))`
fails for two field-identical artifacts built in different key orders). #17 is instead partly
closed by a smoke check that drives a real CR `Room` and asserts no ball is re-sent with wire data
the client already holds.

---

## 7. Developer specification

⚠️ **AS-BUILT. Four rows of the original spec were wrong as written** — kept below with the
correction, because each was wrong in a way that would have shipped a bug or wasted a day.

| # | symbol | change | as built |
|---|---|---|---|
| 1 | `costprobe.ts` | ~~deep-copy the baseline artifact~~ | **Copy `Room`'s diff.** The codec had no production caller, so deep-copying the baseline would have fixed the aliasing and still priced the wrong algorithm. |
| 2 | `protocol.ts` `applyBallDelta` | ~~clone each `upd` entry into the baseline~~ | **Clone on the RETURN, four spreads.** The function returns the baseline's objects however they arrived, and `pos`/`vel`/`state` are all written in place. |
| 3 | `room.ts` `broadcastSnapshot` | `JSON.stringify(…, round3)` at both body sites + the diff key | **Plus `sendSnapshotTo`** (the reattach keyframe — the largest frame the server emits), and `round3` lives in **`server/wire.ts`**, a leaf module: `room.ts` is in an import cycle and `costprobe.ts` must import the same function. `TIME_KEYS` dropped — unbuildable. |
| 4 | `spawn.ts` `coerceAutoPath` | cap `shapes`, `sequence`, per-line `controlPoints` | **`shapes` DELETED** (no reader, anywhere), `controlPoints` capped at 8 and never 2, all three `pathWaitTimer` inputs clamped. |
| 5 | `protocol.ts` `LobbyPlayer`/`PlayerPatch` | delete `autoPath`/`autoPathEnabled` | as specified — **and `server/room.ts` has TWO sites**, not the one the review names (the host handshake and the staged/strategy path). |
| 6 | `room.ts` `broadcast` | ~~`backlog()` guard~~ | **WITHDRAWN** — one-shot control messages, no successor frame. |
| 7 | `sanitize.ts` → `spawn.ts` `coerceSetup` | thread `game`; per-game start-index clamp | **The clamp was already fixed.** Threading is narrowed to the size envelope; the start-legality gate is the other half. |
| 8 | `App.tsx` | `dropQueue()` on the `signedIn` transition; `spectateRoom` via `roomJoinRegion` | **Plus `rejoinGame`**, same bare-code branch, missed by the review. |
| 9 | `repo.ts` `deleteAccount` | sweep `matches.replay_id` | as specified, through `match_participants`, keeping the match row. |
| 10 | new | ~~per-user replay retention~~ | **NOT BUILT, and should not be** — `matches` has no `user_id`. Replaced by the one-sided-room orphan fix. |
| 11 | `fly-deploy.sh` | `-e MAX_ROOMS=N` per satellite | as specified (`--env`), on the `fly machine update` loop that already runs — **plus `--ha=false` on the production deploy line**, which is finding 23 and matters more. |
| **12** | `repo.ts` `saveReplay` | **new** | scrub robot/team names — they are drawn ON THE FIELD, so they are in the viewer and burned into every exported video. |
| **13** | `room.ts` + `index.ts` | **new** | `snapSendGapMs` on `/api/perf`, per room and per broadcast. |

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
