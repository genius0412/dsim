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

import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, isValidRoomCode } from './roomCode';

/** true when this page is being served through Discord's activity proxy — the
 * ONLY condition under which the `/.proxy/gs` URL is valid */
function onDiscordHost(): boolean {
  return typeof window !== 'undefined' && window.location.hostname.endsWith('.discordsays.com');
}

/** true when this page is running as (or emulating) a Discord Activity. The
 * `instance_id` fallback keeps the UX testable on localhost/tunnels
 * (`?instance_id=whatever`) and robust to a Discord host change — but the
 * proxy game-server URL stays keyed to the real host (see onDiscordHost). */
export function inDiscordActivity(): boolean {
  return onDiscordHost() || discordInstanceId() !== '';
}

/** the activity instance id shared by every participant of one launch ('' outside) */
export function discordInstanceId(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('instance_id') ?? '';
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
 */
export function watchDiscordParticipants(cb: (people: DiscordParticipant[]) => void): () => void {
  if (!onDiscordHost()) return () => {}; // the SDK handshake only exists in the real embed
  let stopped = false;
  let unsub: (() => void) | null = null;
  void (async () => {
    try {
      const { DiscordSDK } = await import('@discord/embedded-app-sdk');
      const clientId = window.location.hostname.split('.')[0];
      const sdk = new DiscordSDK(clientId);
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
