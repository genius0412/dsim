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
 *
 * ⚠️ **A LAN SERVER IS REACHED THROUGH `roomServerUrl*()` AND NOTHING ELSE.** A
 * self-hosted server (docs/lan-selfhost.md) runs the GAME and nothing else — no database,
 * no accounts, no leaderboard, no matchmaker. So the override is scoped to the ONE thing a
 * LAN box can actually do, which is host a code-joined room:
 *   - `roomServerUrl()` / `roomServerUrlWith()` → the LAN box when one is connected. Used
 *     by the custom-room Lobby, and only there.
 *   - `gameServerUrl()` / `gameServerUrlWith()` → ALWAYS the cloud. Ranked, record runs
 *     and spectating are cloud concepts that cannot exist on a laptop; pointing them at one
 *     would queue a signed-in player for a rated match on a machine with no way to rate it.
 *   - `gameServerHttpUrl()` → ALWAYS the cloud. Every read API and the `/api/lan` upload
 *     go there, or the first self-hosted match posts itself somewhere with nowhere to put
 *     it and vanishes.
 * `lanServerHttpUrl()` is the one accessor that deliberately names the LAN box over HTTP,
 * for its health probe.
 */

import { parseLanAddress } from './lanAddress';
import { discordGameServerUrl } from './discordActivity';

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
  // Inside a Discord Activity the proxy CSP blocks every outside host, so the
  // baked-in server URLs are unreachable — the ONLY route to the game server is
  // the activity's `/gs` URL mapping on the page's own host. Override the whole
  // list (no region picker in-activity; the mapping is the region). This feeds
  // roomServerUrl()/gameServerUrl() alike via selectedServer().
  const discordUrl = discordGameServerUrl();
  if (discordUrl) return [{ id: 'discord', label: 'Discord', region: '', url: discordUrl }];
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

/**
 * THE LAN SERVER THIS DEVICE IS CONNECTED TO, if any. '' ⇒ playing on the cloud.
 *
 * Its own localStorage key, NOT `GameSettings` — settings sync to Postgres per account,
 * and a LAN address is a property of WHERE YOU ARE, not of who you are. Signing in on a
 * laptop at home must not drag a venue's `192.168.x.x` along with it. Same reasoning as the
 * theme preference, which lives outside settings for exactly this.
 *
 * Module state with a localStorage mirror rather than state in a component: the address is
 * read by `gameServerUrl()`, which every connect site calls, and those calls happen far from
 * whatever screen set it.
 */
const LAN_KEY = 'decodesim.lanServer.v1';

let lanUrl = (() => {
  try {
    const raw = localStorage.getItem(LAN_KEY);
    // re-validate on the way out: the key is hand-editable, and a build that tightened the
    // rules must not keep honouring an address it would now refuse
    const hit = raw ? parseLanAddress(raw) : null;
    return hit && hit.ok ? hit.value.url : '';
  } catch {
    return ''; // storage off / private window — LAN simply starts disconnected
  }
})();

/** the LAN server's ws:// URL, or '' when not connected to one */
export const lanServerUrl = (): string => lanUrl;

/** whether this device is playing on a self-hosted server rather than the cloud. Read by
 *  the "LAN — unofficial, not ranked" banner and by everything that must not offer a
 *  ranked action while it is true. */
export const lanActive = (): boolean => !!lanUrl;

/** the LAN server over HTTP — its health probe and the client it serves. The ONE accessor
 *  that points at the LAN box over HTTP; `gameServerHttpUrl()` never does. */
export const lanServerHttpUrl = (): string => httpOf(lanUrl);

/**
 * Connect this device to a self-hosted server. Returns the parsed address, or the reason it
 * was refused — the caller shows that reason; it must never silently keep the old one.
 */
export function setLanServer(raw: string): ReturnType<typeof parseLanAddress> {
  const hit = parseLanAddress(raw);
  if (!hit.ok) return hit;
  lanUrl = hit.value.url;
  try {
    localStorage.setItem(LAN_KEY, lanUrl);
  } catch {
    /* not persisted; the connection still works for this session */
  }
  return hit;
}

/** go back to the cloud. */
export function clearLanServer(): void {
  lanUrl = '';
  try {
    localStorage.removeItem(LAN_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * RELEASE CHANNEL of THIS client build (baked from `VITE_APP_CHANNEL`; default
 * 'stable'). The pre-release 'alpha' deployment sets it to 'alpha'. The server
 * uses it to (a) matchmake alpha players SEPARATELY from stable ones — they run
 * a different `src/sim`, so mixing them in one authoritative match would desync —
 * and (b) NOT persist alpha results to the leaderboard/ELO DB (in-development
 * scores stay off the boards). Sent to the server on join/queue; absent ⇒
 * 'stable' (older builds + the stable deployment). */
export const appChannel = (): string =>
  (import.meta.env.VITE_APP_CHANNEL as string | undefined)?.trim() || 'stable';

/** THIS client's build id — the git sha baked in by vite (`__BUILD_ID__`; the same
 * value `/version.json` carries). Sent to the server on `queue` so the matchmaker
 * segregates the pool by build (two different builds never share an authoritative
 * match — the "same code" invariant behind the version gate). 'dev' when unbuilt.
 * Declared here (not imported from `version.ts`, which pulls in React) so pure net
 * modules can read it. */
declare const __BUILD_ID__: string;
export const appBuild = (): string =>
  typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';

/** friendly short names for the Fly deploy regions (code → place). Unknown codes
 * fall back to their uppercase code so a new region still shows something sane. */
const REGION_LABELS: Record<string, string> = {
  iad: 'US East',
  sjc: 'US West',
  lhr: 'Europe',
  syd: 'Australia',
  nrt: 'Asia',
};
export const regionLabel = (code: string): string =>
  REGION_LABELS[code] ?? (code ? code.toUpperCase() : '');

/** whether `code` is a known deploy region (used to tell a region-coded room code
 * like `iad-abc` from an ordinary custom room code). */
export const isKnownRegion = (code: string): boolean => code in REGION_LABELS;

/** all configured servers (regions); empty ⇒ multiplayer/records disabled */
export const gameServers = (): GameServer[] => SERVERS;

/** is the CLOUD configured? Gates ranked, records, spectating and the live counters —
 *  everything that needs the database. A LAN connection deliberately does NOT count. */
export const gameServerConfigured = (): boolean => SERVERS.length > 0;

/** is there anywhere to open a ROOM? Either the cloud or a LAN server will do — a client
 *  served by a LAN host may have been built with no cloud URL baked in at all. */
export const roomServerConfigured = (): boolean => SERVERS.length > 0 || !!lanUrl;

/** whether the player actually has a CHOICE of server (≥2 configured) */
export const multiServer = (): boolean => SERVERS.length > 1;

export const selectedServer = (): GameServer | undefined =>
  SERVERS.find((s) => s.id === selectedId) ?? SERVERS[0];

export const selectedServerId = (): string => selectedServer()?.id ?? '';

/** choose the active server (by id). No-ops on an unknown id. */
export function setSelectedServer(id: string): void {
  if (SERVERS.some((s) => s.id === id)) selectedId = id;
}

/** the selected CLOUD region's WebSocket URL. Never the LAN server — see the ⚠️ at the
 *  top of this file, and use `roomServerUrl()` if a LAN box is a legitimate destination. */
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

/**
 * Where a ROOM is opened — the LAN server when one is connected, else the cloud.
 *
 * The ONLY accessor that follows a LAN connection, and the narrowness is the point: a
 * code-joined room is the one thing a server with no database can host completely. It is
 * used by `Lobby` and by nothing else.
 *
 * The fly-replay routing hints are passed through unchanged and are simply ignored by a LAN
 * server, which has one machine and no proxy in front of it — the same way they are
 * harmless on a single-region cloud deploy.
 */
export const roomServerUrl = (): string => lanUrl || selectedServer()?.url || '';

export function roomServerUrlWith(params: Record<string, string>): string {
  const base = roomServerUrl();
  if (!base) return base;
  const qs = new URLSearchParams(params).toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * The CLOUD server over HTTP(S) for the read APIs (leaderboards, replays, health/ping) and
 * for the LAN upload: ws://→http://, wss://→https://
 *
 * ⚠️ **This must NEVER follow `lanUrl`.** It is deliberately written against
 * `selectedServer()` and not against `gameServerUrl()`, because everything reached through
 * it needs the database — the account, the boards, the replay archive and `POST /api/lan`
 * itself. A LAN box has none of those, so a version of this that followed the socket would
 * point a signed-in player's whole account at a laptop, and the first self-hosted match
 * would be uploaded into a void.
 */
export const gameServerHttpUrl = (): string => httpOf(selectedServer()?.url);

/** ws(s):// → http(s):// for any server's url */
export const httpOf = (wsUrl: string | undefined): string =>
  wsUrl ? wsUrl.replace(/^ws/, 'http') : '';

/**
 * Is the supporter tier OPEN for business?
 *
 * OFF by default, and it gates the Support page AND its footer link. The tier's
 * code is complete, but a page cannot go live before the Ko-fi page and the
 * server's KOFI_VERIFICATION_TOKEN both exist: the "Support on Ko-fi" button
 * would lead somewhere that cannot take a payment, and the claim box would fail
 * on every submission. That is a dead end for a visitor and, more concretely, a
 * broken purchase path is a cited AdSense rejection reason - which matters a
 * great deal on the exact deploy whose purpose is passing that review.
 *
 * Lives HERE, not in `seasons.ts`: the server compiles that file too, and
 * `import.meta.env` does not exist outside the Vite build.
 *
 * Flip `VITE_SUPPORT_ENABLED=1` once Ko-fi is connected and the Fly secret is
 * set. Nothing else needs to change; the routes stay reachable by direct URL for
 * testing, only the navigation and the page body are gated.
 */
export const SUPPORT_ENABLED =
  (import.meta.env.VITE_SUPPORT_ENABLED as string | undefined)?.trim() === '1';
