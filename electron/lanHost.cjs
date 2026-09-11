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
 * THE CHILD GETS A DELIBERATELY EMPTY ENVIRONMENT for anything account-shaped. No
 * `DATABASE_URL`, no auth secrets: a LAN server runs the GAME and nothing else, every match
 * on it is unofficial, and the results reach an account only by being uploaded from the
 * host's own client to the cloud (see docs/lan-selfhost.md). A LAN server that could write
 * to the real database would be a server whose operator could write anything they liked.
 */

const { spawn } = require('node:child_process');
const { networkInterfaces } = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const DEFAULT_PORT = 8787;

/** the running child, or null. One host per app — a second would fight for the port. */
let child = null;
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
  if (child) return status();
  const port = Number(opts.port) || DEFAULT_PORT;
  const script = serverScript(app);
  const { client } = paths(app);
  log = [];

  try {
    child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        // turn Electron's own binary into a plain Node runtime
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(port),
        // serve the client on the same origin as the socket — the whole point; see
        // `server/static.ts` for why a guest cannot reach this box any other way
        SERVE_CLIENT: client,
        // a LAN server keeps NOTHING. Blanked explicitly rather than merely absent, so a
        // developer running the app with a real .env in their environment cannot host a
        // match straight into the production database.
        DATABASE_URL: '',
        ADMIN_USER_IDS: '',
        ADMIN_SECRET: '',
        KOFI_VERIFICATION_TOKEN: '',
        FLY_REGION: '',
        FLY_MACHINE_ID: '',
      },
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
  child.on('exit', (code) => {
    exited = code;
    child = null;
  });

  // up to ~8s: Rapier's wasm is the slow part of a cold start
  for (let i = 0; i < 40; i++) {
    if (exited !== null) {
      return { error: lastProblem(exited) };
    }
    if (await probe(port)) return status();
    await new Promise((r) => setTimeout(r, 200));
  }
  stop();
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

/** stop hosting. Safe to call when nothing is running — quit paths call it unconditionally. */
function stop() {
  if (!child) return status();
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  child = null;
  return status();
}

module.exports = { start, stop, status, lanAddresses, DEFAULT_PORT };
