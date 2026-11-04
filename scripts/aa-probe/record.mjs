// `npm run aaprobe` — EDGE ERROR OF THE 3D VIEW, MEASURED, AND THE RECORDING THE RENDER LANE READS.
//
// Starts the probe's own Vite server if nothing answers on its port, runs `run.cjs` (offscreen
// Electron, muted, one DPR per process) over the four key views (driver, hive, robot, dolly) at Low,
// Medium, High and Ultra, at DPR 1 and DPR 2, and compares each view's edge error against
// `ceilings.json`. The number per view is `A`: E against the supersampled reference on a native
// canvas, and the alias part (against the reference resolved at the render resolution) on a canvas
// the browser stretches.
//
//   npm run aaprobe                 # measure and compare; writes nothing
//   npm run aaprobe -- --record     # and, if every view is under its ceiling, write baseline.json
//
// `baseline.json` carries the AA pipeline's fingerprint (`fingerprint.ts`); the RENDER lane fails
// when the pipeline no longer matches it. About 25 minutes on an RTX 4070 Ti SUPER, most of it the
// DPR 2 references. GPU-bound in bursts: one run at a time.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const PORT = 5203;
const RECORD = process.argv.includes('--record');
const VIEWS = ['driver', 'hive', 'robot', 'dolly'];
const TIERS = ['low', 'medium', 'high', 'ultra'];

const up = () =>
  new Promise((res) => {
    const req = http.get({ host: 'localhost', port: PORT, path: '/', timeout: 1500 }, (r) => {
      r.resume();
      res(true);
    });
    req.on('error', () => res(false));
    req.on('timeout', () => {
      req.destroy();
      res(false);
    });
  });

let server = null;
if (!(await up())) {
  server = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'scripts/aa-probe', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
}

const electron = join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const results = {};
let gpu = '';
try {
  for (const dpr of [1, 2]) {
    const out = mkdtempSync(join(tmpdir(), 'aaprobe-'));
    const r = spawnSync(electron, [join(HERE, 'run.cjs'), `--port=${PORT}`, `--tiers=${TIERS.join(',')}`, `--dprs=${dpr}`, `--views=${VIEWS.join(',')}`, `--out=${out}`], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    for (const line of (r.stdout ?? '').split('\n')) if (line.startsWith('[aa]')) console.log(line);
    const file = join(out, 'result.json');
    if (!existsSync(file)) throw new Error(`no result for DPR ${dpr}:\n${r.stderr}`);
    const res = JSON.parse(readFileSync(file, 'utf8'));
    for (const [key, v] of Object.entries(res)) {
      gpu = v.info.gpu;
      results[key] = Object.fromEntries(
        VIEWS.map((id) => {
          const s = v.views[id];
          const a = s.alias ?? s;
          return [id, { A: a.E, J: a.J }];
        }),
      );
    }
  }
} finally {
  server?.kill();
}

const ceilings = JSON.parse(readFileSync(join(HERE, 'ceilings.json'), 'utf8'));
const over = [];
for (const [key, views] of Object.entries(ceilings.ceiling)) {
  for (const id of ceilings.views) {
    const got = results[key]?.[id];
    const cap = views[id];
    const flag = !got ? 'MISSING' : got.A > cap ? 'OVER' : 'ok';
    if (flag !== 'ok') over.push(`${key} ${id}`);
    console.log(`${key.padEnd(10)} ${id.padEnd(7)} A ${got ? got.A.toFixed(2).padStart(6) : '     -'}  ceiling ${cap.toFixed(2).padStart(6)}  before ${String(ceilings.before[key]?.[id] ?? '-').padStart(6)}  ${flag}`);
  }
}
const fp = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(HERE, 'fingerprint.ts')], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
if (over.length) {
  console.log(`\n${over.length} view(s) over their ceiling: ${over.join(', ')}. Nothing recorded.`);
  process.exit(1);
}
if (RECORD) {
  writeFileSync(join(HERE, 'baseline.json'), JSON.stringify({ fingerprint: fp, gpu, recorded: new Date().toISOString().slice(0, 10), results }, null, 1) + '\n');
  console.log(`\nrecorded baseline.json (fingerprint ${fp})`);
} else {
  console.log(`\nall under their ceilings (fingerprint ${fp}); --record to write baseline.json`);
}
