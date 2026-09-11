/**
 * HOSTING A LAN GAME FROM THE DESKTOP APP — the main-process half.
 *
 * The owner's requirement was "very easy and integrated into the app. No terminal commands
 * acceptable", so the desktop app starts the game server itself. What it starts is the
 * SELF-CONTAINED bundle `dist-server/lan.mjs` (`npm run server:bundle`), which differs from
 * the Fly bundle in one way that matters here: it inlines its dependencies instead of
 * marking them external, because a packaged Electron app has no `node_modules` to resolve
 * them from.
 *
 * ⚠️ **IT IS RUN BY ELECTRON ITSELF, NOT BY `node`.** `ELECTRON_RUN_AS_NODE=1` turns
 * `process.execPath` into a plain Node runtime, so hosting works on a machine that has never
 * had Node installed — which is every machine this feature is for. Spawning `node` would
 * work on a developer's laptop and fail silently on a team's.
 *
 * THE CHILD GETS AN ALLOWLISTED ENVIRONMENT, not the parent's with a few holes punched in
 * it. A LAN server runs the GAME and nothing else; results reach an account only by being
 * uploaded from the host's own client to the cloud (see docs/lan-selfhost.md), and a LAN
 * server that could write to the real database would be a server whose operator could write
 * anything they liked. The earlier version spread `...process.env` and then blanked the four
 * secrets that existed at the time, which is a list somebody has to MAINTAIN: the next cloud
 * secret anybody adds is inherited by every self-hosted server on the day it is introduced,
 * silently, and the person adding it has no reason to look in this file. So the direction is
 * inverted — nothing is passed unless it is named here, and the names are the ones a Node
 * process needs to run at all plus the two that configure the host.
 *
 * ⚠️ **`LAN_MODE=1` IS THE LOAD-BEARING ONE, AND IT IS NOT A HINT.** The server enforces
 * the whole unofficial-and-no-database policy on ITSELF from that variable
 * (`server/lanMode.ts`): it refuses to build a database pool, refuses to verify anybody's
 * credentials, and drops the admin environment, whatever this launcher did or did not put in
 * the child's environment. That matters because `dist-server/lan.mjs` is an ordinary Node
 * bundle anybody can run by hand, with no launcher in the picture — a guarantee that lives
 * only here is a guarantee about ONE way of starting the server. This launcher's job is to
 * set the flag; the server's job is to mean it.
 */

const { spawn } = require('node:child_process');
const { networkInterfaces } = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const DEFAULT_PORT = 8787;

/** the running child, or null. One host per app — a second would fight for the port. */
let child = null;
/**
 * A stop that has issued its kill and is waiting for the process to actually go.
 *
 * ⚠️ **`child = null` IS NOT `the port is free`.** `kill()` delivers a signal and returns;
 * the OS process lives on for as long as it takes to unwind, and it is still holding
 * 0.0.0.0:8787 the whole time. The panel's own Stop / Start buttons are two clicks a second
 * apart, and changing the port is literally stop-then-start — so the previous version's
 * window between them was not theoretical, and what came out of it was the WORST failure this
 * screen has: EADDRINUSE, reported as 'another copy of DSIM may already be hosting', about a
 * server the app itself had just stopped. So a stop is a PROMISE, and a start waits on it.
 */
let stopping = null;
let current = { port: 0, startedAt: 0 };
/** the last few lines the server printed, so a failure can say something specific */
let log = [];

const remember = (line) => {
  for (const l of String(line).split(/\r?\n/)) if (l.trim()) log.push(l.trim());
  if (log.length > 40) log = log.slice(-40);
};

/**
 * Where the packaged app keeps the two things the host needs.
 *
 * `app.isPackaged` decides, because the layout genuinely differs: in development they sit in
 * the repo, and in a build electron-builder puts them inside `app.asar`. `dist-server/lan.mjs`
 * cannot be RUN from inside an asar (it is not a real file on disk to a spawned process), so
 * a packaged host copies it out to a temp path first — see `serverScript`.
 */
function paths(app) {
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  const inAsar = app.isPackaged ? path.join(base, 'app.asar') : base;
  return {
    bundle: path.join(inAsar, 'dist-server', 'lan.mjs'),
    client: path.join(inAsar, 'dist'),
    scratch: app.getPath('userData'),
  };
}

/**
 * A real on-disk path to the server bundle.
 *
 * A packaged app's files live in `app.asar`, which Electron's own `fs` can read but a spawned
 * process cannot — so the bundle is copied to `userData` on first host. It is re-copied when
 * the sizes differ, which is what makes an app UPDATE take effect instead of the host
 * silently running the previous version's server all season.
 */
function serverScript(app) {
  const { bundle, scratch } = paths(app);
  if (!app.isPackaged) return bundle;
  const out = path.join(scratch, 'lan-server.mjs');
  try {
    const src = fs.statSync(bundle);
    let stale = true;
    try {
      stale = fs.statSync(out).size !== src.size;
    } catch {
      /* not copied yet */
    }
    if (stale) fs.copyFileSync(bundle, out);
    return out;
  } catch {
    return bundle; // let the spawn fail with a real error rather than inventing one
  }
}

/**
 * Every address a guest could actually type.
 *
 * IPv4 only, non-internal, and PRIVATE ones first. A laptop at a venue routinely has three
 * or four interfaces up — wifi, ethernet, a VPN, WSL's virtual switch, Docker's bridge — and
 * only one of them is the network the guests are on. There is no reliable way to know which,
 * so the app SHOWS them rather than guessing, and puts the ones that look like a local
 * network at the top. `src/net/lanAddress.ts` holds the matching rule on the client side.
 */
function lanAddresses() {
  const out = [];
  const ifaces = networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
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

/** is the server answering yet? Used to report "started" only once it really has. */
function probe(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 700 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** what the renderer renders. Safe to call at any time, running or not. */
function status() {
  return {
    running: !!child,
    port: child ? current.port : 0,
    startedAt: child ? current.startedAt : 0,
    addresses: lanAddresses(),
    log: log.slice(-8),
  };
}

/**
 * The ONLY variables the parent may hand down.
 *
 * Nothing about DSIM is in here, deliberately — these are the ones a Node process needs to
 * find its own libraries, its temp directory and the user's home on the three platforms. A
 * cloud secret cannot be inherited by being forgotten, because inheritance is not the default.
 */
const PASSTHROUGH = [
  'PATH', 'Path', 'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL', 'TZ',
];

/** the child's whole environment: the allowlist above, plus what makes it a LAN server */
function childEnv(client, port) {
  const env = {};
  for (const k of PASSTHROUGH) if (process.env[k] !== undefined) env[k] = process.env[k];
  // turn Electron's own binary into a plain Node runtime — this is what makes hosting work
  // on a machine that has never had Node installed, which is every machine this is for
  env.ELECTRON_RUN_AS_NODE = '1';
  env.PORT = String(port);
  // the server enforces the unofficial / no-database policy on ITSELF from this; see the
  // header of this file and `server/lanMode.ts`
  env.LAN_MODE = '1';
  // serve the client on the same origin as the socket — the whole point; see
  // `server/static.ts` for why a guest cannot reach this box any other way. The server
  // REFUSES TO START on this without LAN_MODE, so the pair is checked from both sides.
  env.SERVE_CLIENT = client;
  return env;
}

/**
 * Start hosting. Resolves to `status()` on success, or `{ error }` with something specific
 * enough to act on.
 *
 * It WAITS for `/health` rather than reporting success on spawn. A host reads the join URL
 * off this screen and says it out loud to a room; telling them the server is up a second
 * before it is means the first four people to try it see a connection error. The wait is
 * bounded — the server takes about a second to load Rapier — and an exit inside that window
 * reports the server's own last line, because "port already in use" is the single most
 * likely failure and is worth saying out loud.
 */
async function start(app, opts = {}) {
  // a restart is stop-then-start, and the stopped server does not release the port the instant
  // it is asked to. Wait for it, or spawn straight into our own EADDRINUSE.
  if (stopping) await stopping;
  if (child) return status();
  const port = Number(opts.port) || DEFAULT_PORT;
  const script = serverScript(app);
  const { client } = paths(app);
  log = [];

  try {
    child = spawn(process.execPath, [script], {
      env: childEnv(client, port),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    child = null;
    return { error: `Couldn’t start the server: ${e && e.message ? e.message : e}` };
  }

  current = { port, startedAt: Date.now() };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  let exited = null;
  const mine = child;
  child.on('exit', (code) => {
    exited = code;
    // only clear the slot if it is still OURS: a stop that has already replaced it, or a
    // start that followed one, must not be un-done by a late exit from the old process
    if (child === mine) child = null;
  });

  // up to ~8s: Rapier's wasm is the slow part of a cold start
  for (let i = 0; i < 40; i++) {
    if (exited !== null) {
      return { error: lastProblem(exited) };
    }
    if (await probe(port)) return status();
    await new Promise((r) => setTimeout(r, 200));
  }
  await stop();
  return { error: 'The server started but never answered. Check that nothing else is using this port.' };
}

/** the most useful thing we can say about a server that quit on us */
function lastProblem(code) {
  const line = [...log].reverse().find((l) => /EADDRINUSE|error|Error/.test(l));
  if (line && /EADDRINUSE/.test(line)) {
    return 'That port is already in use. Another copy of DSIM may already be hosting — stop it, or pick a different port.';
  }
  return line
    ? `The server stopped: ${line}`
    : `The server stopped before it finished starting (exit code ${code}).`;
}

/**
 * Stop hosting, and do not resolve until the process is GONE.
 *
 * Safe to call when nothing is running — the quit paths call it unconditionally, and they
 * do not await it, which is fine: the kill is issued before the first await, so quitting is as
 * prompt as it was. What awaiting buys is the RESTART, which cannot spawn onto a port the
 * previous server has not let go of yet (see `stopping`).
 *
 * A child that ignores the polite signal is escalated. `kill()` is SIGTERM on POSIX and a
 * hard terminate on Windows, so the escalation is mostly for the case where the server is
 * wedged inside Rapier's wasm init; without it a stuck child would park this promise forever
 * and the panel's Start button would never come back.
 */
function stop() {
  if (stopping) return stopping;
  if (!child) return Promise.resolve(status());
  const dying = child;
  child = null; // the slot is free for a start to WAIT on, not for one to use
  stopping = new Promise((resolve) => {
    const done = () => {
      clearTimeout(hard);
      stopping = null;
      resolve(status());
    };
    const hard = setTimeout(() => {
      try {
        dying.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      // and if even that does not land, stop waiting rather than wedging the panel
      setTimeout(done, 1000).unref?.();
    }, 3000);
    hard.unref?.();
    dying.once('exit', done);
    try {
      dying.kill();
    } catch {
      done(); // never started, or already reaped
    }
  });
  return stopping;
}

module.exports = { start, stop, status, lanAddresses, childEnv, DEFAULT_PORT };
