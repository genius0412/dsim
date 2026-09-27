/**
 * A SIM WORKER THREAD (`SIM_WORKERS` > 0) — see `server/roomPool.ts` for the main-thread half and
 * `docs/scaling-multicore.md` for why this exists.
 *
 * It listens BEFORE it loads anything, so a room main creates in the first instant after boot is
 * accepted and simply behaves as an in-process room does before physics has loaded ("Server is
 * starting up" on `start`). Then Rapier 2D + 3D, each worker its own copy (a wasm instance is
 * per thread), then the JIT warm-up (`server/warmup.ts`) — sliced, so rooms the worker already
 * holds keep stepping through it.
 *
 * ⚠️ Bundled as its OWN esbuild entry (`Dockerfile`, `npm run server:build`): the worker is a
 * separate module graph, and `roomPool.ts` resolves `./roomWorker.js` beside the bundled
 * `index.js` (or `./roomWorker.ts` when running through `tsx`).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { initPhysics } from '../src/sim/physicsEngine';
import { initPhysics3d } from '../src/games/biobuzz/sim3d/engine';
import { RoomHost } from './roomHost';
import type { ToWorker } from './roomWire';
import { warmUp, warmupEnabled } from './warmup';

if (!parentPort) throw new Error('server/roomWorker.ts must run as a worker thread');
/* THE SAME CONTAINMENT THE MAIN THREAD HAS (`server/index.ts` logs these and carries on). A room
   timer that throws would otherwise end this worker and every room on it — worse than the
   in-process server, where the same throw costs nothing but a log line. A worker that really
   cannot continue (out of memory) still exits, and `RoomPool` replaces it. */
process.on('uncaughtException', (e) => console.error('[worker] uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('[worker] unhandledRejection:', e));
const port = parentPort;
const host = new RoomHost((batch) => port.postMessage(batch));
port.on('message', (batch: ToWorker[]) => host.receive(batch));
// the low-rate mirror refresh: summaries, clocks and phase changes that no message caused
setInterval(() => host.refreshMirrors(), 250);

await Promise.all([initPhysics(), initPhysics3d()]);
const wantWarm = (workerData as { warm?: boolean } | null)?.warm !== false && warmupEnabled(process.env.WARMUP);
const warm = wantWarm ? await warmUp() : null;
host.emit({ k: 'ready', warm: warm ? { ms: Math.round(warm.ms), ticks: warm.ticks } : null });
