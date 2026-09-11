/**
 * Turn a directory of `loadtest --json` files into ONE table, and fit the capacity slope.
 *
 *   npx tsx scripts/loadsummary.ts .loadtest-out/sweep
 *
 * The fit is a plain least-squares line of SERVER CORES against ROOMS. The intercept is the
 * idle cost of the process (timers, the presence heartbeat, /api/perf itself) and the SLOPE is
 * the only number that extrapolates: cores per room. `roomsPerCore` is 1/slope.
 *
 * ⚠️ IT FITS `cores`, NOT `loopLagMs`, AND THAT IS A WINDOWS CONCESSION. Windows' default
 * timer granularity is 15.625ms and Node does not raise it, so `monitorEventLoopDelay` on an
 * IDLE Windows box reads p50 ≈ 15.6ms — already 94% of the 16.67ms step budget before a single
 * room exists (measured on the dev box). The lag percentile is the right saturation signal and
 * fly.toml says so; it is simply not measurable here. On Linux (dsim-alpha, or any Fly machine)
 * read `loopLagMs.p99` directly and ignore this note.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Row {
  file: string;
  rooms: number;
  clients: number;
  cores: number;
  loopP99: number;
  loopMax: number;
  rssMb: number;
  gapP50: number;
  gapP99: number;
  jitter: number;
  rttP99: number;
  kbPerClient: number;
  totalKbs: number;
  drops: number;
  inputHz: number;
  hLagP99: number;
}

const dir = process.argv[2] ?? '.loadtest-out/sweep';
const rows: Row[] = [];
for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  rows.push({
    file: f,
    rooms: j.rooms,
    clients: j.clients,
    cores: j.perfAfter?.cores ?? NaN,
    loopP99: j.perfAfter?.loopLagMs?.p99 ?? NaN,
    loopMax: j.perfAfter?.loopLagMs?.max ?? NaN,
    rssMb: j.perfAfter?.rssMb ?? NaN,
    gapP50: j.snapshotGapMs?.p50 ?? NaN,
    gapP99: j.snapshotGapMs?.p99 ?? NaN,
    jitter: j.snapshotGapMs?.jitterMeanAbsDev ?? NaN,
    rttP99: j.rttMs?.p99 ?? NaN,
    kbPerClient: Math.round((j.bytesPerClientPerSec?.mean ?? 0) / 1024),
    totalKbs: j.totalKbPerSec ?? NaN,
    drops: j.disconnects ?? 0,
    inputHz: j.harness?.inputHz ?? NaN,
    hLagP99: j.harness?.loopLagMs?.p99 ?? NaN,
  });
}
rows.sort((a, b) => a.rooms - b.rooms);

/**
 * Was this step still keeping the server's promise?
 *
 * The fit below is only meaningful over the steps where it was. Past saturation the room
 * loop does NOT burn more CPU — `startLoop` caps catch-up at 8 ticks per fire and clamps the
 * accumulator at 0.25s, so an overloaded room SHEDS SIM TIME instead. Measured on the dev
 * box: cores flattened at ~0.8 from 8 rooms to 24 while the snapshot gap went 35ms -> 180ms.
 * Fitting through that flat tail drags the slope toward zero and invents capacity that isn't
 * there, so the saturated steps are excluded and printed with `ok=n`.
 *
 * The gap test IS the promise: the server broadcasts every 2 ticks, so a p50 far off 33.3ms
 * means the loop is not running in real time, whatever the CPU says.
 */
const healthy = (r: Row): boolean =>
  Number.isFinite(r.cores) && r.gapP50 < 45 && r.drops === 0;

const pad = (s: string | number, n: number): string => String(s).padStart(n);
console.log(
  [
    pad('rooms', 6), pad('cli', 5), pad('cores', 7), pad('c/room', 7), pad('lagP99', 7),
    pad('lagMax', 7), pad('rssMB', 6), pad('gapP50', 7), pad('gapP99', 7), pad('jitter', 7),
    pad('rttP99', 7), pad('KB/s·cli', 9), pad('KB/s', 7), pad('drop', 5), pad('inHz', 6),
    pad('hLagP99', 8), pad('ok', 3),
  ].join(' '),
);
for (const r of rows) {
  console.log(
    [
      pad(r.rooms, 6), pad(r.clients, 5), pad(r.cores.toFixed(3), 7),
      pad((r.cores / r.rooms).toFixed(4), 7), pad(r.loopP99.toFixed(1), 7),
      pad(r.loopMax.toFixed(0), 7), pad(r.rssMb, 6), pad(r.gapP50.toFixed(1), 7),
      pad(r.gapP99.toFixed(0), 7), pad(r.jitter.toFixed(1), 7), pad(r.rttP99.toFixed(0), 7),
      pad(r.kbPerClient, 9), pad(r.totalKbs.toFixed(0), 7), pad(r.drops, 5),
      pad(r.inputHz.toFixed(1), 6), pad(Number.isFinite(r.hLagP99) ? r.hLagP99.toFixed(1) : '-', 8),
      pad(healthy(r) ? 'y' : 'n', 3),
    ].join(' '),
  );
}

// least-squares cores = a + b·rooms, over the HEALTHY steps only
const ok = rows.filter(healthy);
if (ok.length >= 2) {
  const n = ok.length;
  const sx = ok.reduce((s, r) => s + r.rooms, 0);
  const sy = ok.reduce((s, r) => s + r.cores, 0);
  const sxx = ok.reduce((s, r) => s + r.rooms * r.rooms, 0);
  const sxy = ok.reduce((s, r) => s + r.rooms * r.cores, 0);
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const a = (sy - b * sx) / n;
  console.log('');
  console.log(`fit over the ${n} healthy step(s) (gap p50 < 45ms, no drops) of ${rows.length}:`);
  console.log(`     cores = ${a.toFixed(3)} + ${b.toFixed(4)} × rooms`);
  console.log(`     idle floor ${a.toFixed(3)} cores · ${b.toFixed(4)} cores/room · ${(1 / b).toFixed(1)} rooms per core`);
  const perClient = ok.reduce((s, r) => s + r.kbPerClient, 0) / n;
  console.log(`     downstream ${perClient.toFixed(0)} KB/s per client (${((perClient * 8) / 1024).toFixed(2)} Mbit/s)`);
}
