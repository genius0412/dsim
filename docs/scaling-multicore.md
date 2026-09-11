# Can DSIM use more than one core?

**Yes.** Written 2026-09-11 on branch `perf-load-v2`, in answer to a direct question: the
capacity model (`docs/capacity.md` §5) says 1,000 concurrent players needs **70–90 machines**
under today's topology, and that is not a number anyone wants to operate.

The short version: **one server process is capped at about one core because Node runs JavaScript
on a single thread, but the code is already shaped for the fix.** `Room` has no socket and no
database in it — it talks through callbacks — which is exactly the seam a worker needs. Moving
the simulation off the socket-owning thread should take one machine from ~13 rooms to ~100, and
the machine count from 70–90 to **single digits**.

This document is the audit behind that claim: what was measured, the two designs that are
actually available, what each one costs, and what neither of them fixes.

---

## 1. Where the time actually goes

Re-bucketed from the CPU profile taken during the load investigation (8 rooms, robots being
driven, DECODE, local server). Self time, 30 s window:

| bucket | share | can it leave the socket thread? |
|---|---|---|
| simulation — `src/sim` + `src/games` JS | 33.1% | **yes** |
| simulation — Rapier + wasm | 32.8% | **yes** |
| simulation — inlined frames¹ | 4.8% | **yes** |
| room loop + snapshot build (`server/room.ts`) | 4.5% | **yes** |
| garbage collection | 5.0% | follows whoever allocates — mostly the sim |
| socket writes (`writev`, `node:net`) | 5.1% | no |
| `ws` framing | 0.9% | no |
| protocol encode (`JSON.stringify`) | 3.2% | **yes**, see §4 |
| idle | 6.5% | — |

¹ These appear in the profile as `set SubtleCrypto`, which is a mis-symbolised inlined frame, not
a crypto call. Every parent chain is `penalties.ts` / `physics.ts` under `step`. It is simulation.

**~75% of a busy server is simulation and room bookkeeping. ~6% is socket work that must stay
wherever the socket lives.** That ratio — call it 12:1, and 8:1 if encoding stayed behind — is
the entire argument. A single socket-owning thread can feed a lot of simulation.

⚠️ This profile is DECODE at 8 rooms on a Windows box. The split is what is portable here, not
the absolute times (`docs/capacity.md` §0). Chain Reaction moves it further toward simulation, not
less: it steps 300 particles per tick.

---

## 2. Why one process is one core

Node executes JavaScript on one thread. `Room.startLoop` is a timer on that thread, `step()` runs
on it, and Rapier's wasm runs on it. A machine with 4 or 8 vCPUs runs the same single JavaScript
thread as a machine with 1 — the extra cores idle. That is why the sweep found `shared-cpu-1x`
through `8x` barely differ, and why `docs/deploy.md` now warns against buying a bigger VM to get
more rooms.

Two things already escape that thread and are worth knowing about, because they are the proof that
offloading works here rather than a theory about it:

- **`permessage-deflate` runs zlib on the libuv threadpool**, not the event loop (`server/index.ts`,
  the block above the `WebSocketServer`). Compression is genuinely parallel today.
- **Rapier is wasm**, which is still on the JS thread, but is a self-contained module that can be
  instantiated once per thread with no shared state — `solveRobots` rebuilds its world every
  `step()` precisely so nothing persists between calls.

---

## 3. The seam already exists

This is the part that makes the change tractable rather than a rewrite. `server/room.ts` imports
`config`, `sim`, `games`, `protocol`, `replay`, `moderation`, `standing`, `channel`, `ranked`. It
imports **no `ws` and no `pg`.** Every way out of a room is a function handed to it:

```ts
constructor(
  readonly code: string,
  private readonly onEmpty: () => void,
  readonly config: RoomConfig = DEFAULT_ROOM_CONFIG,
  private readonly onResult?: (o: MatchOutcome) => void | Promise<PersistOutcome | void>,
  private readonly onUserActive?: (userId: string) => void,
  private readonly onUserInactive?: (userId: string) => void,
  …
)
```

and every way *in* to a client is `Client.send` / `Client.sendRaw`, a plain function. The headless
smoke already drives whole matches through this seam with no sockets at all — that is what
`npm test` is. **A room is already an actor that communicates by message passing; it just happens
to be running in the same thread as its mailbox.**

---

## 4. Option A — `worker_threads` (recommended)

Rooms run in N worker threads. The main thread keeps every socket, every singleton, and a
directory of which worker owns which room code.

```
main thread                          worker 1..N
  ws sockets, HTTP, upgrade            Room instances
  Matchmaker (one)                     step() + Rapier
  DB pool (one)                        snapshot build
  presence heartbeat (one)             JSON encode  ──► posts a ready-to-send STRING
  rooms: Map<code, workerId>
```

**Why this one fits the code:**

- **Every singleton stays a singleton.** `Matchmaker` is a class the server instantiates once; the
  DB pool is one pool; presence writes one row keyed on `FLY_MACHINE_ID`. None of them fork.
- **No routing change anywhere.** `routeTarget`, `fly-replay`, `roomJoinRegion`, region-coded codes
  — all untouched. The machine a room lives on does not change; only which thread inside it.
- **The encode already produces a string.** Since the shared-encode change, `broadcastSnapshot`
  builds one string per frame. A worker can build that string and post it, so encoding leaves the
  socket thread too and the main thread does nothing but write bytes.
- **Posting a string is a memcpy.** At ~6.5 KB per 2v2 frame, 30 Hz, 100 rooms, that is single-digit
  MB/s of copying. Not a concern.

**What it costs:**

- **An RPC surface of about 20 methods.** `Room`'s public surface is `add`, `addSpectator`,
  `detach`, `reattach`, `onMessage`, `applyPending`, `maybeStartRanked`, `hideSpectator`, and a
  set of synchronous READS — `summary()`, `presenceSnapshot()`, `visibleSpectators()`,
  `canJoin()`, `stagedFor()`, `tick`, `hasWorld`. The writes become posts. The reads are the
  awkward half, because `/api/live` and the presence heartbeat call them synchronously today.
- **The reads should become a mirror, not an await.** `index.ts` already caches both of these
  (`liveCache`, `presenceCache`). Let each worker push a summary on change and have the main thread
  serve those caches from its mirror. No round trip, and the endpoints keep their current shape.
- **`RAPIER.init()` per worker.** `initPhysics()` must be awaited in each thread before it steps.
  Memory cost per worker, once.
- ⚠️ **`UV_THREADPOOL_SIZE` must be raised.** This is the one real trap. `permessage-deflate` runs
  on the libuv threadpool, that pool is **per process** and defaults to **4 threads**, and this
  design puts ~100 rooms' worth of compression through one process's pool. Left at the default it
  becomes the new bottleneck, and it will present as latency, not as CPU. Option B does not have
  this problem, because N processes have N pools.

---

## 5. Option B — `cluster` (N processes, sticky by room code)

Each worker is a full copy of today's server on the same port via `SO_REUSEPORT`; the primary
accepts the upgrade, decides who owns the room code, and hands the socket over with
`worker.send(msg, socket)`.

**In its favour:** each worker owns its own sockets, so socket work scales too, and each process
gets its own libuv threadpool. No RPC surface at all — a worker is just the server.

**Against it — three singletons fork, and two of them fail silently:**

1. **The matchmaker.** `Matchmaker` would exist once per worker, so four workers is four ranked
   queues that cannot see each other, and two people queueing at the same instant may never pair.
   Fixable the way the region-level problem is already fixed: `routeTarget` sends `?mm=1` to the
   one matchmaker region, so send it to one matchmaker *worker* too. The pattern exists; it just
   has to be applied a level down.
2. **Presence.** `MACHINE = FLY_MACHINE_ID || REGION || 'local'` is one row per machine, and every
   worker would overwrite the same row. Needs a worker suffix in the key.
3. **The DB pool.** `DB_POOL_MAX` is per process, so N workers is N× the connections. At 5 per pool
   and 4 workers that is 20 per machine — which makes Neon's pooled connection string a
   prerequisite rather than the deferred item it is today (`docs/launch-load-test.md` §5).

Plus the primary has to own a `code → worker` registry and consult it before the handshake
completes. That is the same class of bug as two machines in one region splitting a room code
(`docs/deploy.md`), with one important difference: **here we control the dispatcher.** The primary
sees every connection for the machine, so the registry is an in-process `Map` rather than a
distributed lookup. It is genuinely easier than the cross-machine version.

---

## 6. What this does to the machine count

Using the measured 0.075 cores per driven room and the weighted 0.09 from `capacity.md` §5:

| | rooms per machine | machines for ~700 rooms |
|---|---|---|
| today, one process per machine | ~11–13 | **70–90** |
| 4 sim workers | ~45–50 | ~15 |
| 8 sim workers | ~90–100 | **~7–8** |

⚠️ **These are extrapolations from a CPU ratio, not measurements of a running multi-worker server.**
The 8-worker row in particular assumes the socket thread stays under its ~6% share and that the
threadpool note in §4 is respected. Treat it as the reason to build a prototype, not as a capacity
promise. The first honest number comes from running the real thing on Linux.

---

## 7. What multi-core does NOT fix

Being explicit, because it would be easy to read this as "the scaling problem is solved":

1. **Bandwidth is unchanged.** Compression already did that work (−82% to −88% measured). Cores do
   not move bytes.
2. **One region is still one machine.** `fly-replay` targets a region and Fly picks any machine in
   it, so two machines per region still split room codes silently (`docs/deploy.md`). Multi-core
   raises the ceiling *within* a machine, which is precisely why it is the better lever — but it
   does not make the second machine safe.
3. **`bestHost` is still latency-only.** Routing sends players to the nearest region, never the
   emptiest, so one region can saturate while another idles. Independent of this work.
4. **The matchmaker is still unvalidated end-to-end.** It needs two signed-in accounts completing a
   rated match, which no harness on this branch can do.
5. **LAN self-hosting is still the only lever that removes load rather than paying for it**
   (`docs/lan-selfhost.md`). Multi-core makes 1,000 concurrent affordable; LAN makes a chunk of it
   never arrive.

---

## 8. Recommendation

**Prototype Option A behind a `SIM_WORKERS` environment variable, defaulting to 0 (today's
behaviour).** In that order and for that reason: the seam already exists, no routing changes, every
singleton stays where it is, and a bad result is one variable away from being switched off — the
same discipline `WS_COMPRESS` and `MAX_ROOMS` already follow on this branch.

Sequence:

1. Land the branch and get the Linux baseline (`docs/launch-load-test.md` §1). **Everything here is
   a ratio measured on a box that cannot measure latency; the prototype needs a real floor to be
   judged against.**
2. Prototype one worker (`SIM_WORKERS=1`). One worker is slower than none — it adds a hop and buys
   no parallelism — and that is the point: it proves the seam is correct and measures the hop's cost
   in isolation, before any of the numbers in §6 are on the line.
3. Then sweep 2, 4, 8 against the room ladder in §2 of the load-test plan and find where the socket
   thread actually saturates. Raise `UV_THREADPOOL_SIZE` first.
