#!/usr/bin/env node
/**
 * HOST A DSIM LAN SERVER FROM A TERMINAL, on macOS, Windows and Linux, with one command.
 *
 * ⚠️ WHY THIS FILE IS JAVASCRIPT AND NOT TWO LINES IN `scripts` — the `dist` script next to it
 * is the cautionary tale. It reads `set ELECTRON=1&& npm run build`, which is `cmd.exe` syntax:
 * it works on the maintainer's Windows box and fails on every Mac and every Linux machine, and
 * the failure is `set: command not found` rather than anything about DSIM. The portable way to
 * set an environment variable for a child process is to not use a shell at all — so this script
 * builds the environment as an object and hands it to `spawn`. Nothing here is interpreted by
 * `cmd.exe`, `bash` or `zsh`, so there is nothing for them to disagree about.
 *
 * WHAT IT DOES, in order:
 *   1. builds `dist/` if it is missing (a fresh clone has none, and the server refuses to serve
 *      a directory that is not there);
 *   2. sets `LAN_MODE=1` and `SERVE_CLIENT=<dist>`, the pair `server/lanMode.ts` requires
 *      together — serving the client without declaring LAN mode is refused at boot, on purpose;
 *   3. starts the server through `tsx`, the same way `npm run server:start` does, so there is no
 *      second build step to keep in sync and no `dist-server/` to go stale;
 *   4. prints every address a guest can actually type, which is the thing people came for.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: touch a database, verify a token, or read an admin secret.
 * It cannot, and that is enforced by the server rather than by this file — see `LAN_MODE` in
 * `server/lanMode.ts`. This script only sets the flag; the refusals live on the other side of it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** `--port 9000`, `--port=9000`, or `PORT=9000` in the environment. Default matches the app. */
function wantedPort() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port' || a === '-p') return args[i + 1];
    const m = /^--port=(.+)$/.exec(a);
    if (m) return m[1];
  }
  return process.env.PORT || '8787';
}

/**
 * Every address a guest could type, private ranges first.
 *
 * Same rule as `electron/lanHost.cjs`, and deliberately the same ORDER: an RFC1918 address is
 * the one plausibly on the network the guests are on, so it is what belongs on a projector. A
 * machine on a VPN or with a container bridge will have others, and they are printed too rather
 * than guessed between — "if the first does not work, try the next" is a shorter support
 * conversation than "why does it say the wrong address".
 */
function addresses() {
  const out = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const priv =
        /^10\./.test(a.address) ||
        /^192\.168\./.test(a.address) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(a.address);
      out.push({ name, address: a.address, private: priv });
    }
  }
  return out.sort((x, y) => Number(y.private) - Number(x.private));
}

/** `npm` is `npm.cmd` on Windows, and `spawnSync` without a shell will not find the plain name. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function buildClient() {
  console.log('[lan] dist/ is missing — building the client once (this takes a minute)…');
  const r = spawnSync(NPM, ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.error) {
    console.error(`[lan] could not run ${NPM}: ${r.error.message}`);
    console.error('[lan] Node and npm must be on PATH. https://nodejs.org');
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error('[lan] the build failed — the output above says why.');
    console.error('[lan] a fresh clone needs `npm install` first.');
    process.exit(r.status ?? 1);
  }
}

const port = wantedPort();
if (!existsSync(join(DIST, 'index.html'))) buildClient();

/**
 * The server is started by THIS Node with `--import tsx`, not by invoking a `tsx` command.
 *
 * A bare `tsx` is only on PATH inside an npm script, so `node scripts/lan.mjs` — which is
 * exactly what the `dsim-lan` bin runs — would get "command not found". Going the other way and
 * spawning `node_modules/.bin/tsx` by path is no better: that is a shell shim on POSIX and a
 * `.cmd` on Windows, so it needs `shell: true` on one platform and not the other. Letting Node
 * load the loader by package name avoids both, and keeps the server on the same runtime that is
 * already running this file.
 */
if (!existsSync(join(ROOT, 'node_modules', 'tsx'))) {
  console.error('[lan] tsx is not installed — run `npm install` in this folder first.');
  console.error(`[lan]   cd ${ROOT}`);
  console.error('[lan]   npm install');
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ['--import', 'tsx', join(ROOT, 'server', 'index.ts')],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(port),
      // the two the server checks against each other — see `server/lanMode.ts`
      LAN_MODE: '1',
      SERVE_CLIENT: DIST,
    },
  },
);

const urls = addresses().map((a) => `http://${a.address}:${port}`);
console.log('');
console.log('  ─────────────────────────────────────────────────────────────');
if (urls.length === 0) {
  console.log('  This computer is not on a network anyone else can reach.');
  console.log('  Join the venue Wi-Fi or plug into the switch, then start again.');
} else {
  console.log('  Everyone else opens ONE of these, in any browser, same network:');
  for (const u of urls) console.log(`      ${u}`);
  if (urls.length > 1) console.log('  (More than one network adapter. If the first fails, try the next.)');
}
console.log('');
console.log(`  You play here:  http://localhost:${port}`);
console.log('  LAN matches are unofficial — never rated, never on a leaderboard.');
console.log('  Ctrl-C to stop hosting.');
console.log('  ─────────────────────────────────────────────────────────────');
console.log('');

// Ctrl-C must stop the SERVER, not orphan it behind a dead launcher.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
