/**
 * Discord Activity support. When dsim runs as an embedded Discord Activity the
 * page is served through Discord's proxy at `<app-id>.discordsays.com`, whose
 * CSP forbids talking to any outside host — every request must ride a
 * configured Activity URL Mapping. Two mappings exist in the Discord app:
 *   `/`   → the client (this page)
 *   `/gs` → the game server
 * so in-activity the game-server socket is `wss://<host>/.proxy/gs` (Discord
 * strips the `/.proxy/gs` prefix before forwarding — the server sees `/`).
 *
 * JOINING: an activity launch shares one `instance_id` query param across every
 * participant (Discord adds it to the iframe URL), so we derive a DETERMINISTIC
 * room code from it — everyone who clicks Discord's native Join button lands in
 * the same lobby with no code entry. First arrival creates the room (the server
 * join-or-creates), later ones join it. The room config is PINNED
 * (versus/decode) because the server refuses a config-mismatched joiner — a
 * per-player `settings.game` would silently split or refuse the party.
 *
 * The Embedded App SDK is used ONLY for `getInstanceConnectedParticipants`
 * (who's in this activity — no OAuth scopes required, works right after
 * `ready()`), which feeds the home page's "Join Discord Lobby" button avatars.
 * It's a dynamic import so the normal web build never loads it. Everything else
 * (`instance_id`, detection) is plain query-string / hostname.
 */

import { DISCORD_INSTANCE_KEY } from '../storageKeys';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, isValidRoomCode } from './roomCode';

/**
 * THE QUERY STRING THIS DOCUMENT OPENED ON, captured at MODULE LOAD.
 *
 * ⚠️ IT HAS TO BE CAPTURED THIS EARLY, for exactly the reason `src/ui/entryToken.ts`
 * exists: `App`'s first mount effect canonicalizes the address bar with
 * `history.replaceState(null, '', pathFor(...))`, and `pathFor` emits a PATH with no
 * query on it. Discord's launch URL is the ONLY carrier of `instance_id`, `frame_id`
 * and `platform`, so after that effect runs `window.location.search` is empty for the
 * rest of the document's life — and anything reading the live URL then finds nothing.
 *
 * Two bugs came out of reading it live:
 *  1. The Embedded App SDK's constructor re-reads `window.location.search` ITSELF and
 *     throws `frame_id query param is not defined` when it is empty. `App` declares the
 *     canonicalize effect BEFORE the participants effect, so in the real embed the SDK
 *     could never construct — the 44 KB chunk was fetched on every launch only to throw
 *     into a swallowed `console.warn`, and the Join-Discord-Lobby button never showed a
 *     single avatar. Invisible locally, because the watcher early-returns off-host.
 *  2. `discordInstanceId()` fell back to sessionStorage, which THROWS on a Discord-in-a-
 *     browser client with third-party storage blocked (blocked, not merely partitioned).
 *     There the `catch` returned the now-empty URL value, so the instance id vanished
 *     mid-load — the same document reported "in an activity" by host but "no group" by
 *     instance, which is the split that removed the Join button and un-pinned the region.
 *
 * A module-level capture also removes the ORDERING dependency entirely: it is evaluated
 * when `App` imports this module, which is before any render and long before any effect,
 * so no caller has to be "early enough" any more.
 *
 * It can never go stale: a fresh activity launch is a fresh DOCUMENT, so a new launch
 * re-runs this line. (A reload is also a fresh document, and legitimately has no query —
 * that is what the sessionStorage memory below is for.)
 */
let launchSearch = typeof window === 'undefined' ? '' : window.location.search;

/** the captured launch query (`?frame_id=…&instance_id=…&platform=…`), falling back to the
 * live URL for the window before `App` canonicalizes it — they agree on a real launch, and
 * the fallback only ever matters if something later re-attaches a query. */
export function launchQuery(): string {
  if (launchSearch) return launchSearch;
  return typeof window === 'undefined' ? '' : window.location.search;
}

/** read one param out of the launch query, '' when absent or the query is malformed */
function launchParam(name: string): string {
  try {
    return new URLSearchParams(launchQuery()).get(name) ?? '';
  } catch {
    return ''; // a malformed query string is an absent param, never a crash
  }
}

/**
 * TEST SEAM ONLY (the `setPoolForTests` pattern). The headless suite imports this module
 * with no `window` at all and installs a stub afterwards, so the real capture above has
 * already run against nothing and there is no second chance to observe it. Production
 * never calls this.
 */
export function setLaunchSearchForTests(search: string): void {
  launchSearch = search;
}

/** true when this page is being served through Discord's activity proxy — the
 * ONLY condition under which the `/.proxy/gs` URL is valid */
function onDiscordHost(): boolean {
  return typeof window !== 'undefined' && window.location.hostname.endsWith('.discordsays.com');
}

/** true when this page is running as (or emulating) a Discord Activity. The
 * `instance_id` fallback keeps the UX testable on localhost/tunnels
 * (`?instance_id=whatever`) and robust to a Discord host change — but the
 * proxy game-server URL stays keyed to the real host (see onDiscordHost).
 *
 * ⚠️ THIS IS THE ONE PREDICATE FOR "AM I IN AN ACTIVITY". `discordGroup()` answers a
 * NARROWER question — "which party am I in" — and can legitimately be '' while this is
 * true (a reload with third-party storage blocked loses the instance id and there is no
 * carrier left to recover it from). Anything gated on being in an activity at all — the
 * season seed, the pinned region, hiding the ranked/Compete tiles — must ask THIS, or
 * those surfaces disagree with each other on a single screen. Anything that needs the
 * party (the Join button, the lobby browser's `group=`) must ask `discordGroup()` and
 * degrade when it is empty. */
export function inDiscordActivity(): boolean {
  return onDiscordHost() || discordInstanceId() !== '';
}

/**
 * The activity instance id shared by every participant of one launch ('' outside).
 *
 * It arrives ONLY on the launch URL — and the router canonicalizes that URL to a
 * bare path on first load, then pushes bare paths on every navigation. So a RELOAD
 * inside the activity (Vite's reconnect reload after a dev-server restart, the
 * REFRESH button on a dropped match, a manual refresh) came back with no
 * `instance_id`: the home page lost its Join Discord Lobby button and the reloaded
 * participant could no longer see the party at all — reported as "others who join
 * my activity can't see the join button". The id is therefore REMEMBERED for the
 * tab in sessionStorage. The URL still wins whenever it carries one: a fresh launch
 * always does, so a stale id can never outlive the instance it names, and
 * sessionStorage dies with the tab (the activity iframe) rather than persisting to
 * an unrelated visit the way localStorage would.
 *
 * ⚠️ The URL is read through `launchQuery()` — the query CAPTURED AT MODULE LOAD — not
 * through the live `window.location.search`. The live one is empty from the moment App's
 * canonicalize effect runs, so with storage blocked (where the `catch` below is the only
 * path) this used to start returning '' PART-WAY THROUGH A SINGLE LOAD: the same document
 * was in an activity by hostname and out of one by instance id. See `launchQuery`.
 */
export function discordInstanceId(): string {
  if (typeof window === 'undefined') return '';
  const fromUrl = launchParam('instance_id');
  try {
    if (fromUrl) {
      window.sessionStorage.setItem(DISCORD_INSTANCE_KEY, fromUrl);
      return fromUrl;
    }
    return window.sessionStorage.getItem(DISCORD_INSTANCE_KEY) ?? '';
  } catch {
    // storage blocked (private mode, a throwing accessor) — the URL is all there is
    return fromUrl;
  }
}

/**
 * Every Discord Activity room is pinned to ONE Fly region, so participants who
 * launched the same activity from different parts of the world converge on one
 * machine. The `/gs` proxy is anycast: without a fixed region, Fly would land each
 * player on their NEAREST machine, splitting both the socket (two rooms, same code)
 * AND the lobby listing (an EU player never sees a US player's room) by geography —
 * the exact "usable by anyone anywhere" failure. `iad` (US East) is the always-warm
 * matchmaker region (min_machines_running=1), so it is never cold. Harmless on a
 * single-region or LAN server, which ignores the hint. Change this one value to move
 * where activity games are hosted.
 */
export const DISCORD_REGION = 'iad';

/** the sanitized activity group tag (Discord instance id → the server's room `group`),
 * using the SAME character clamp the server applies, so the tag written on `join` and
 * the `group` the lobby browser queries always resolve to one value. '' outside an
 * activity. */
export function discordGroup(): string {
  return discordInstanceId().replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64);
}

/** FNV-1a 32-bit — tiny, deterministic, good enough to spread instance ids */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic room code for an activity instance: same input ⇒ same code on
 * every participant's machine. Draws 6 chars from the shared room-code alphabet
 * via an xorshift stream seeded by the instance hash; on the (rare) blocklisted
 * draw it re-seeds with a salted round and tries again, still deterministically.
 */
export function roomCodeForInstance(instanceId: string): string {
  for (let round = 0; round < 50; round++) {
    let x = fnv1a(round === 0 ? instanceId : `${instanceId}#${round}`) || 1;
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      // xorshift32
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      code += ROOM_CODE_ALPHABET[x % ROOM_CODE_ALPHABET.length];
    }
    if (isValidRoomCode(code)) return code;
  }
  // Unreachable in practice (would need 50 straight blocklisted draws). Unlike
  // generateRoomCode's 'PLAY42', this fallback is itself a VALID code (all chars in
  // ROOM_CODE_ALPHABET), so even the impossible path can't mint a code the server rejects.
  return 'DSMHQ2';
}

/** the game-server WS base in-activity (empty string outside the real proxy —
 * a localhost/tunnel emulation keeps its normal configured server) */
export function discordGameServerUrl(): string {
  return onDiscordHost() ? `wss://${window.location.host}/.proxy/gs` : '';
}

/** the slice of Discord's User object the lobby button renders */
export interface DiscordParticipant {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

/** a participant's display name (global display name, else the unique username) */
export const discordDisplayName = (p: DiscordParticipant): string => p.global_name || p.username;

/** CDN avatar URL — custom avatar when set, else Discord's default embed avatar
 * (index derived from the user id snowflake, per Discord's own formula).
 * cdn.discordapp.com is allowed by the activity CSP. */
export function discordAvatarUrl(p: DiscordParticipant): string {
  if (p.avatar) return `https://cdn.discordapp.com/avatars/${p.id}/${p.avatar}.png?size=64`;
  let idx = 0;
  try {
    idx = Number((BigInt(p.id) >> 22n) % 6n);
  } catch {
    /* non-numeric id → default 0 */
  }
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

/**
 * Watch who is connected to THIS activity instance. Dynamically imports the
 * Embedded App SDK (client id = the first label of the discordsays host),
 * handshakes `ready()`, then reports the current participants + every update.
 * Fire-and-forget resilient: any failure simply means no avatars — the join
 * button works regardless. Returns a stop function.
 *
 * ⚠️ TWO GATES, not one. `onDiscordHost()` says the handshake exists at all; the
 * `frame_id` test says the SDK can actually CONSTRUCT — its constructor throws on a
 * missing `frame_id`/`instance_id`/`platform`, and a reload inside the activity comes
 * back on a bare URL with none of them (sessionStorage remembers the instance id, but
 * nothing carries the other two). Without the second gate that case still downloads
 * 44 KB gzip of SDK in order to throw it away one line later.
 */
export function watchDiscordParticipants(cb: (people: DiscordParticipant[]) => void): () => void {
  if (!onDiscordHost()) return () => {}; // the SDK handshake only exists in the real embed
  if (!launchParam('frame_id')) return () => {}; // no launch params ⇒ the SDK cannot construct
  let stopped = false;
  let unsub: (() => void) | null = null;
  void (async () => {
    try {
      // via the facade so the lazy chunk is named `discordSdk-*`, not `index-*`
      // (bundleaudit routes by filename — see src/net/discordSdk.ts)
      const { createDiscordSdk } = await import('./discordSdk');
      const clientId = window.location.hostname.split('.')[0];
      // ⚠️ NOT the SDK's own constructor: it reads the LIVE `window.location.search`,
      // which App has already emptied by now — see `launchQuery` and discordSdk.ts.
      // (Smoke greps this file for that construction, so do not spell it here either.)
      const sdk = createDiscordSdk(clientId);
      await sdk.ready();
      if (stopped) return;
      const onUpdate = (d: { participants: DiscordParticipant[] }): void => {
        if (!stopped) cb(d.participants ?? []);
      };
      const { participants } = await sdk.commands.getInstanceConnectedParticipants();
      if (!stopped) cb(participants ?? []);
      await sdk.subscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', onUpdate);
      unsub = () => void sdk.unsubscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', onUpdate);
      // stop() may have run during an await above, before `unsub` existed — so its
      // `unsub?.()` was a no-op and left this subscription live. Tear it down now.
      if (stopped) unsub();
    } catch (e) {
      console.warn('[discord] participants unavailable:', e);
    }
  })();
  return () => {
    stopped = true;
    unsub?.();
  };
}
