#!/usr/bin/env node
/**
 * TEST TAB HOSTING ON A REAL LAN, FROM ONE COMMAND, WITH NO CLOUD AND NO SECRETS.
 *
 * Tab hosting (`docs/lan-webrtc.md`) runs the authoritative room in a browser tab and reaches it
 * over a WebRTC DataChannel. The two browsers cannot open that channel until they have swapped
 * an offer, an answer and some ICE candidates, and in production that exchange goes through the
 * cloud game server. This script puts that rendezvous on THIS machine instead, and serves the
 * client next to it, so the whole feature can be exercised between two laptops on a table
 * before anything is deployed.
 *
 * ⚠️ **IT IS NOT `npm run lan`, AND THE DIFFERENCE IS WHERE THE MATCH RUNS.**
 *   - `npm run lan` makes this machine the GAME SERVER: it steps the room, and guests reach it
 *     by typing its address. It needs Node on the host and nothing on the guests.
 *   - `npm run lan:tab` makes this machine only the INTRODUCER. The room runs in the host's
 *     browser tab, guests join with a six-character code, and the traffic between them never
 *     touches this process at all. It is the local stand-in for the cloud.
 * Both set `LAN_MODE=1`, so neither can reach a database, verify a credential, or hold an admin
 * key — see `server/lanMode.ts`.
 *
 * ## Why it has to BUILD, and why it stamps what it built
 *
 * Two client-side facts are baked in at build time and cannot be changed afterwards:
 * `VITE_LAN_ENABLED` (without it the LAN screen does not exist) and `VITE_GAME_SERVER_URL`
 * (where the signalling socket dials). The second one must be this machine's LAN ADDRESS, not
 * `localhost`, or the guest's browser would dial its own machine and find nothing.
 *
 * So a `dist/` left behind by an ordinary `npm run build` is not usable here and would fail in
 * the least helpful way available — a LAN screen with no Host-in-this-tab panel on it, or a
 * panel whose button times out. `dist/.lantab` records the exact URL the current build was
 * stamped with; a re-run rebuilds when it disagrees (a new Wi-Fi network, a different port) and
 * skips the minute when it does not.
 *
 * Flags: `--port 9000` · `--host 192.168.1.50` (pick an adapter) · `--build` (force a rebuild).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const STAMP = join(DIST, '.lantab');
const ARGS = process.argv.slice(2);

/** `--flag value` or `--flag=value`; returns undefined when absent. */
function flag(...names) {
  for (let i = 0; i < ARGS.length; i++) {
    if (names.includes(ARGS[i])) return ARGS[i + 1];
    for (const n of names) {
      const m = new RegExp(`^${n}=(.+)$`).exec(ARGS[i]);
      if (m) return m[1];
    }
  }
  return undefined;
}

/**
 * Every address a guest could reach this machine on, private ranges first.
 *
 * Same rule and same ORDER as `scripts/lan.mjs` and `electron/lanHost.cjs`: an RFC1918 address
 * is the one plausibly on the network the guests are on. Unlike those two this script must
 * CHOOSE one rather than print them all, because the address is compiled into the client — so
 * it takes the first and says which, and `--host` overrides it.
 */
function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
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

const port = flag('--port', '-p') ?? process.env.PORT ?? '8787';
const found = addresses();
const host = flag('--host') ?? found[0]?.address;

if (!host) {
  console.error('[lan:tab] This computer is not on a network anyone else can reach.');
  console.error('[lan:tab] Join the Wi-Fi or plug into the switch, then start again.');
  console.error('[lan:tab] (To try it on this machine alone, pass --host 127.0.0.1.)');
  process.exit(1);
}

const origin = `http://${host}:${port}`;
const signalUrl = `ws://${host}:${port}`;

/**
 * `npm` is `npm.cmd` on Windows, and since Node 18.20/20.12 `spawnSync` REFUSES to run a `.cmd`
 * without `shell: true` — it fails with `EINVAL`, which says nothing about the cause. The
 * arguments here are static literals, so there is nothing for a shell to re-interpret.
 */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
/** spawnSync options every npm call needs on Windows; see NPM above. */
const NPM_SHELL = process.platform === 'win32';

const stamped = existsSync(STAMP) ? readFileSync(STAMP, 'utf8').trim() : '';
const needsBuild = ARGS.includes('--build') || !existsSync(join(DIST, 'index.html')) || stamped !== signalUrl;

if (needsBuild) {
  if (stamped && stamped !== signalUrl) {
    console.log(`[lan:tab] the built client points at ${stamped}, not ${signalUrl} — rebuilding.`);
  } else {
    console.log('[lan:tab] building the client with LAN on and the rendezvous pointed here…');
  }
  console.log('[lan:tab] (about a minute; skipped next time unless the address changes)');
  const r = spawnSync(NPM, ['run', 'build'], {
    shell: NPM_SHELL,
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      // the LAN screen and its tab-host panel exist only when this is set — see src/net/env.ts
      VITE_LAN_ENABLED: '1',
      // where `LanSignalClient` dials. NOT localhost: the guest's browser runs this too.
      VITE_GAME_SERVER_URL: signalUrl,
    },
  });
  if (r.error) {
    console.error(`[lan:tab] could not run ${NPM}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error('[lan:tab] the build failed — the output above says why.');
    process.exit(r.status ?? 1);
  }
  writeFileSync(STAMP, `${signalUrl}\n`);
}

if (!existsSync(join(ROOT, 'node_modules', 'tsx'))) {
  console.error('[lan:tab] tsx is not installed — run `npm install` in this folder first.');
  process.exit(1);
}

/**
 * Started by THIS Node with `--import tsx` rather than by invoking a `tsx` command, for the
 * reason `scripts/lan.mjs` gives at length: a bare `tsx` is only on PATH inside an npm script,
 * and the `.bin` shim needs `shell: true` on Windows and not on POSIX.
 */
const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'server', 'index.ts')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(port),
    // the pair server/lanMode.ts requires together: serve the client, keep nothing
    LAN_MODE: '1',
    SERVE_CLIENT: DIST,
    // the third door (server/lanUploads.ts) — without it the rendezvous refuses every claim
    LAN_SIGNALLING: '1',
  },
});

console.log('');
console.log('  ─────────────────────────────────────────────────────────────');
console.log('  HOST (this machine, and every guest) opens:');
console.log(`      ${origin}`);
if (found.length > 1) {
  console.log(`  (${found.length} network adapters; using ${host}. Others: ` +
    `${found.slice(1).map((a) => a.address).join(', ')} — pass --host to pick one.)`);
}
console.log('');
console.log('  Then, on the HOST machine:  Play → LAN → Host in this tab → START HOSTING');
console.log('  Read the six-character code out; guests type it into Join → Room code.');
console.log('');
console.log('  This server only introduces the browsers to each other. The match runs in the');
console.log('  host’s tab and the traffic goes straight between machines.');
console.log('  Nothing is signed in and nothing is uploaded — the match stays on the device');
console.log('  that hosted it, in the upload backlog, until it is played against a real server.');
console.log('  Ctrl-C to stop.');
console.log('  ─────────────────────────────────────────────────────────────');
console.log('');

// Ctrl-C must stop the SERVER, not orphan it behind a dead launcher.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
