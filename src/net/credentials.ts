/**
 * WHAT MAY LEAVE THIS DEVICE, AND WHERE TO.
 *
 * ⚠️ **A LAN SERVER IS SOMEBODY'S LAPTOP.** That is the premise of the whole self-hosted
 * feature (docs/lan-selfhost.md) and it cuts both ways: the cloud does not trust what a LAN
 * server reports, and this device must not hand a LAN server anything it could use elsewhere.
 * The Neon Auth JWT is exactly that — a bearer credential for the player's REAL account, good
 * against `api.playdsim.com` for as long as it lives. A guest who joins a room on a
 * classmate's laptop was, until this module existed, sending it one on `join` and another on
 * `spectate`, because `LobbyClient` attached it unconditionally and `Lobby.tsx` is the one
 * connect site that follows a LAN address. The operator of that laptop did not have to attack
 * anything; they only had to read their own server's log.
 *
 * ## Why the check is at the SEND boundary rather than at the call sites
 *
 * The obvious fix is "don't attach the token when `lanActive()`", at each of the two places
 * that attach one. That fix is correct today and wrong in a month. There will be a third
 * caller — a new lobby message that wants to know who you are — and it will be written by
 * somebody reading `join` as the example, and nothing anywhere will fail. A rule enforced per
 * call site is a rule with as many holes as the codebase later grows call sites.
 *
 * So the transport strips it (`WebSocketTransport.send`). Every frame, whatever produced it,
 * on its way out. A future `queue`-shaped message cannot leak a token to a LAN box, because
 * the leak is no longer a property of the message.
 *
 * ## ...and why the allowlist runs in that direction
 *
 * `trustedFor` asks "is this one of the CLOUD servers this build was configured with", not "is
 * this a LAN address". Both would work on today's two cases. Only the first one is still right
 * when a third kind of destination appears, because a destination nobody has classified yet
 * gets the safe answer by default rather than the convenient one. A client served by a LAN
 * host with no cloud URL baked into it trusts NOTHING, which is correct: it has no cloud
 * account to spend anyway.
 *
 * The server-side half of the same rule is `LAN_MODE` in `server/lanMode.ts`, which makes a
 * self-hosted server refuse to verify a token even if one reaches it. Two independent halves
 * on purpose — either alone is a rule somebody can later refactor away.
 */

/**
 * `scheme://host:port` for a ws/wss/http/https URL, or '' if it will not parse.
 *
 * Built by hand from `protocol` + `host` rather than read off `URL.origin`: `origin` is
 * specified to be the opaque string "null" for schemes the browser does not treat as special,
 * and `ws:`/`wss:` have been on both sides of that line across engines. A comparison that
 * silently becomes `'null' === 'null'` is a comparison that says every server is the same
 * server, which here means every server is trusted.
 */
export function wsOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/**
 * May this device send account credentials to `url`?
 *
 * True only for an origin that appears in `allow` — the CLOUD servers this build was
 * configured with (`VITE_GAME_SERVERS` / `VITE_GAME_SERVER_URL`). Query strings are ignored,
 * because the routing hints (`?room=`, `?region=`, `?mm=1`) are appended per connection and
 * say nothing about who is on the other end.
 *
 * An unparseable URL is untrusted, and so is every URL when nothing is configured.
 */
export function trustedFor(url: string, allow: readonly string[]): boolean {
  const origin = wsOrigin(url);
  if (!origin) return false;
  return allow.some((a) => wsOrigin(a) === origin);
}

/**
 * Every field that is a CREDENTIAL rather than data, and must never cross to an untrusted
 * server.
 *
 * A list, so adding a second one is a one-line change in the place somebody adding a
 * credential to the protocol will actually look. `authToken` is today's only member: the Neon
 * Auth JWT, attached by `LobbyClient.join`, `.spectate` and `.queue`.
 *
 * Deliberately NOT a pattern like /token|auth/i. `queue` carries `party` — a challenge token —
 * which is issued BY the cloud FOR one specific pairing and is meaningless anywhere else; a
 * greedy matcher would strip it, and the failure would be a "play a friend" invite that
 * silently stops working rather than anything that looks like a security control misfiring.
 */
const CREDENTIAL_FIELDS = ['authToken'] as const;

/**
 * The same frame with every credential field removed, or the frame unchanged when it has none.
 *
 * Text first, JSON second. The overwhelming majority of frames on this socket are `input` on
 * the hot path — one per tick, per client — and none of them contains the substring, so the
 * normal cost of this function is one `indexOf` over a short string. Only a frame that
 * mentions a credential field is parsed and re-serialized.
 *
 * A frame that is not JSON at all is passed through untouched: this strips credentials, it is
 * not a validator, and a transport that silently dropped malformed frames would turn a protocol
 * bug into a mystery.
 */
export function stripCredentials(frame: string): string {
  if (!CREDENTIAL_FIELDS.some((f) => frame.includes(f))) return frame;
  let msg: unknown;
  try {
    msg = JSON.parse(frame);
  } catch {
    return frame;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return frame;
  const obj = msg as Record<string, unknown>;
  let touched = false;
  for (const f of CREDENTIAL_FIELDS) {
    if (f in obj) {
      delete obj[f];
      touched = true;
    }
  }
  return touched ? JSON.stringify(obj) : frame;
}
