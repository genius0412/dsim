/**
 * LAN MODE — the "this server is somebody's laptop" switch, enforced IN THIS PROCESS.
 *
 * ⚠️ **THE GUARANTEE MUST NOT DEPEND ON HOW THE SERVER WAS STARTED.** The first version of
 * this feature put the whole policy in `electron/lanHost.cjs`: the desktop launcher blanked
 * `DATABASE_URL` and friends before spawning the child, and that was the only thing standing
 * between a self-hosted match and the production database. But `dist-server/lan.mjs` is an
 * ordinary Node bundle that anybody can run by hand, and the same binary with `SERVE_CLIENT`
 * pointed at a `dist/` and a real `DATABASE_URL` in the environment was a LAN server writing
 * to the cloud — a machine whose operator can patch it, holding a connection to the real
 * boards. A launcher cannot enforce anything about a process it did not launch.
 *
 * So the policy lives HERE, on the server side of the boundary, and the launcher's job
 * shrinks to setting one variable.
 *
 * `LAN_MODE=1` means, in this process and regardless of what else is in the environment:
 *   - **no database, ever.** `server/db/pool.ts` reads this and refuses to build a pool even
 *     with `DATABASE_URL` set, so every persistence call no-ops exactly as it does on a
 *     server with no DSN at all. Nothing here can reach `records`, `ranked_*`, ELO or
 *     `record_leaderboard`; `lan_runs` is written by the CLOUD from the host's own upload,
 *     never by the LAN server.
 *   - **no credentials.** `server/auth.ts` reads this and never verifies a token, so a LAN
 *     server cannot learn who anybody is even if a client sends a JWT. The client half of
 *     the same rule is in `src/net/transport.ts`, which strips `authToken` from every frame
 *     bound for a server the cloud does not vouch for. Two independent halves on purpose:
 *     either one alone would be a rule somebody could later refactor away.
 *   - **no admin surface.** `ADMIN_USER_IDS`, `OWNER_USER_ID`, `ADMIN_SECRET` and the Ko-fi
 *     token are scrubbed from the environment at boot, so the admin routes have no key to
 *     match and the staff-role projection has nothing to project.
 *   - **not the official channel.** `SERVER_CHANNEL` is forced to 'stable' and matters to
 *     nothing here, because a LAN server persists nothing either way.
 *
 * ## `SERVE_CLIENT` WITHOUT `LAN_MODE` FAILS CLOSED
 *
 * Serving the game client is the one thing only a LAN host does — the Fly deployment has a
 * CDN in front of it and must never turn it on (see `server/static.ts`). So the two are
 * required together: a process that is asked to serve the client without declaring itself a
 * LAN server REFUSES TO START, loudly, naming the variable it wants.
 *
 * Failing closed rather than inferring `LAN_MODE` from `SERVE_CLIENT` is deliberate. The
 * dangerous configuration is exactly the one where somebody believed they were starting an
 * ordinary server, and a server that quietly reconfigured itself — dropping the database
 * out from under a real deployment — would be a worse surprise than one that will not boot.
 * The message says what to do, and the desktop launcher sets both.
 */

/** is this process a self-hosted / LAN server? Set by `electron/lanHost.cjs`. */
export const LAN_MODE = (process.env.LAN_MODE ?? '').trim() === '1';

/**
 * Every environment variable a LAN server must not carry, whatever the operator's shell had
 * in it. Scrubbed from `process.env` rather than merely ignored, so a later reader that goes
 * straight to `process.env` — including one nobody has written yet — finds nothing.
 *
 * `DATABASE_URL` is in the list for tidiness and for the boot log; the actual refusal to
 * connect is in `pool.ts`, which reads `LAN_MODE` itself and therefore cannot be defeated by
 * import order (its module body runs before anything could call the function below).
 */
const FORBIDDEN_IN_LAN_MODE = [
  'DATABASE_URL',
  'ADMIN_USER_IDS',
  'OWNER_USER_ID',
  'ADMIN_SECRET',
  'KOFI_VERIFICATION_TOKEN',
  'MODERATION_API_KEY',
  'NEON_AUTH_URL',
  'NEON_AUTH_JWKS_URL',
] as const;

/**
 * Apply the LAN policy, or refuse to boot. Called once from `server/index.ts` BEFORE it
 * reads any of these variables into module constants.
 *
 * Returns the names it dropped, purely so the boot line can say so — a host who wondered why
 * their DSN was ignored deserves an answer in the log rather than in this file.
 *
 * `exit` and `lanMode` are ARGUMENTS with the real thing as their default, for the same reason
 * `filePath` in `server/static.ts` takes its root as one: a policy that can only be exercised
 * by booting a whole server and watching it die is a policy nothing will ever test, and this is
 * one of the two functions on this branch whose failure mode is a self-hosted server connected
 * to the production database. `npm test` calls it both ways.
 */
export function enforceLanPolicy(
  exit: (code: number) => never = process.exit,
  lanMode: boolean = LAN_MODE,
): string[] {
  if (process.env.SERVE_CLIENT && !lanMode) {
    console.error(
      '[server] SERVE_CLIENT is set but LAN_MODE is not. Serving the game client is a ' +
        'self-hosted (LAN) server’s job, and a LAN server must not be able to reach the ' +
        'cloud database. Start it with LAN_MODE=1, or unset SERVE_CLIENT. Refusing to start.',
    );
    exit(1);
  }
  if (!lanMode) return [];
  const dropped: string[] = [];
  for (const name of FORBIDDEN_IN_LAN_MODE) {
    if (process.env[name]) {
      dropped.push(name);
      delete process.env[name];
    }
  }
  process.env.SERVER_CHANNEL = 'stable';
  if (dropped.length) {
    // NAMES ONLY — never the values. This log line is the one place a host would paste into
    // a support thread, and half of these are secrets.
    console.warn(`[server] LAN_MODE=1 — ignoring ${dropped.join(', ')} (a LAN server keeps nothing)`);
  }
  return dropped;
}
