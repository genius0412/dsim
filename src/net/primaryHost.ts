/**
 * THE PRIMARY'S OWN ADDRESS: a host that reaches the always-warm iad machine without passing
 * through the region nearest the player.
 *
 * The game-server hostname is Anycast: every request lands on the NEAREST region, and Fly's
 * proxy starts that region's machine if it is stopped. So every poll a menu tab made
 * (`/api/status`, `/api/presence`, the friends heartbeat, page views) kept its nearest
 * satellite running. Measured 2026-09-27: satellites `started` 21-24 h a day against 4-104
 * hours of match activity in a week. A server-side `fly-replay` cannot fix that, because the
 * satellite has to be running to send it, and a `fly-prefer-region` header makes every request
 * CORS-preflighted, and the preflight still goes to the nearest region.
 *
 * The router (`router/`) is a separate Fly app whose only machines are in iad. Each request it
 * receives it answers with `fly-replay: app=<game app>;region=iad`, so the game app's iad
 * machine serves it and no satellite is involved.
 *
 * WHAT GOES THERE: the HTTP APIs (`gameServerHttpUrl()`) and LAN signalling. WHAT DOES NOT:
 * match, room, spectate and matchmaker sockets, which must reach the room's region; the
 * `/health` latency probe, which measures the nearest region on purpose; and `/api/lobbies`,
 * which is pinned to a region by the Discord Activity.
 *
 * A leaf module (no `import.meta.env`) so the smoke run can test it.
 */

/** game-server host → its router's host. A host not listed has no router. */
export const PRIMARY_HOSTS: Readonly<Record<string, string>> = {
  'dohun-sim-decode.fly.dev': 'dsim-primary.fly.dev',
  'dsim-alpha.fly.dev': 'dsim-alpha-primary.fly.dev',
};

/**
 * The router's ws(s):// base for a game-server URL, or '' when there is none.
 *
 * `override` is `VITE_GAME_PRIMARY_URL`: a ws(s):// or http(s):// URL replaces the table, and
 * `off` disables the router for that build.
 */
export function primaryWsBase(serverUrl: string, override = ''): string {
  const o = override.trim();
  if (o === 'off') return '';
  if (o) return o.replace(/^http/, 'ws').replace(/\/$/, '');
  let u: URL;
  try {
    u = new URL(serverUrl);
  } catch {
    return '';
  }
  const host = PRIMARY_HOSTS[u.host];
  if (!host) return '';
  return `${u.protocol === 'ws:' ? 'ws' : 'wss'}://${host}`;
}
