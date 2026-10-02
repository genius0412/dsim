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

/**
 * WHETHER TO USE THE ROUTER RIGHT NOW — and, above all, for how long NOT to.
 *
 * The router is checked once at boot (`probePrimary` in env.ts) and the page falls back to the
 * Anycast host if it does not answer. That fallback used to be PERMANENT for the life of the tab,
 * and a failed boot probe is ordinary: a laptop restoring its tabs before the Wi-Fi is up, a
 * phone waking a backgrounded tab, a captive portal, eight slow seconds on a bad connection.
 * Every one of those tabs then sent its presence, status and friends polls to the player's
 * NEAREST region for as long as it stayed open — measured on 2026-10-02, ord answered one to
 * twenty such requests every one to three minutes with no socket and no match, which is enough
 * to keep a satellite from ever auto-stopping.
 *
 * So a failure now means "not for a while": the Anycast host is used for a backoff window
 * (30 s, doubling to 5 min) and the router is tried again after it. A probe that fails while
 * the browser says it is OFFLINE does not count at all — it says nothing about the router —
 * and the next `online` event re-probes (env.ts).
 */
export class PrimaryHealth {
  private downUntil = 0;
  private backoffMs = 0;

  constructor(
    private readonly minMs = 30_000,
    private readonly maxMs = 5 * 60_000,
  ) {}

  /** may requests go through the router at `now`? */
  usable(now: number): boolean {
    return now >= this.downUntil;
  }

  /** the router did not answer at `now`; returns when to try it again */
  failed(now: number): number {
    this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, this.maxMs) : this.minMs;
    this.downUntil = now + this.backoffMs;
    return this.downUntil;
  }

  /** the router answered: use it, and start any later backoff from the bottom again */
  ok(): void {
    this.downUntil = 0;
    this.backoffMs = 0;
  }
}
