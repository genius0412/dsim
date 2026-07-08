/**
 * Game-server config, read from Vite env (baked in at build time on Vercel + in
 * the Electron build). When absent, the Multiplayer entry is hidden and the solo
 * game is completely unaffected — there is no runtime network dependency.
 *
 * MULTI-SERVER: the app supports a LIST of game servers (regions) so a player can
 * pick the closest one (a pre-connection ping picker) for a record run or a
 * match. Configure with `VITE_GAME_SERVERS` — a JSON array of
 * `{ id, label, region, url }`. For back-compat, a single `VITE_GAME_SERVER_URL`
 * still works and becomes a one-entry list. The SELECTED server (module state,
 * restored from the account preference) is what every connect site uses via
 * `gameServerUrl()` / `gameServerHttpUrl()`.
 */

export interface GameServer {
  /** stable id used to persist the player's preference */
  id: string;
  /** human label for the picker (defaults to region/url) */
  label: string;
  /** region code, e.g. 'iad', 'lhr' — '' if single/unknown */
  region: string;
  /** ws:// or wss:// base URL of the server */
  url: string;
}

function parseServers(): GameServer[] {
  const raw = import.meta.env.VITE_GAME_SERVERS as string | undefined;
  if (raw) {
    try {
      const arr = JSON.parse(raw) as Partial<GameServer>[];
      const clean = arr
        .filter((s): s is Partial<GameServer> => !!s && typeof s.url === 'string' && !!s.url)
        .map((s, i) => ({
          id: s.id || `srv${i}`,
          label: s.label || s.region || (s.url as string),
          region: s.region || '',
          url: s.url as string,
        }));
      if (clean.length) return clean;
    } catch {
      /* malformed JSON → fall back to the single-URL var */
    }
  }
  const single = import.meta.env.VITE_GAME_SERVER_URL as string | undefined;
  if (single) return [{ id: 'default', label: 'Default', region: '', url: single }];
  return [];
}

const SERVERS = parseServers();
let selectedId = SERVERS[0]?.id ?? '';

/** all configured servers (regions); empty ⇒ multiplayer/records disabled */
export const gameServers = (): GameServer[] => SERVERS;

export const gameServerConfigured = (): boolean => SERVERS.length > 0;

/** whether the player actually has a CHOICE of server (≥2 configured) */
export const multiServer = (): boolean => SERVERS.length > 1;

export const selectedServer = (): GameServer | undefined =>
  SERVERS.find((s) => s.id === selectedId) ?? SERVERS[0];

export const selectedServerId = (): string => selectedServer()?.id ?? '';

/** choose the active server (by id). No-ops on an unknown id. */
export function setSelectedServer(id: string): void {
  if (SERVERS.some((s) => s.id === id)) selectedId = id;
}

export const gameServerUrl = (): string => selectedServer()?.url ?? '';

/**
 * The game-server WS URL with a fly-replay routing HINT in the query string (one
 * app, many regions). The server's upgrade interceptor reads these to route the
 * connection to the right machine:
 *   - `{ mm: '1' }`            → the designated matchmaker region (ranked queueing)
 *   - `{ room: 'iad-abc123' }` → the room's host region (region-coded code)
 *   - `{ region: 'lhr' }`      → an explicit region pick (manual "play elsewhere")
 * On a single-region deploy the hints are harmless (the one machine accepts them).
 */
export function gameServerUrlWith(params: Record<string, string>): string {
  const base = gameServerUrl();
  if (!base) return base;
  const qs = new URLSearchParams(params).toString();
  return qs ? `${base}?${qs}` : base;
}

/** the selected server over HTTP(S) for the read APIs (leaderboards, replays,
 * health/ping): ws://→http://, wss://→https:// */
export const gameServerHttpUrl = (): string => httpOf(selectedServer()?.url);

/** ws(s):// → http(s):// for any server's url */
export const httpOf = (wsUrl: string | undefined): string =>
  wsUrl ? wsUrl.replace(/^ws/, 'http') : '';
