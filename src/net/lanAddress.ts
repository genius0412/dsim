/**
 * WHAT COUNTS AS A LAN SERVER ADDRESS, and whether this page is allowed to open it.
 *
 * A LEAF MODULE with no imports, for the reason `roomRegion.ts` gives: `env.ts` reads
 * `import.meta.env` at load, so the headless smoke run cannot import it at all — and both
 * rules here fail SILENTLY in the browser, which is exactly the kind that has to be testable.
 *
 * Two jobs, and the second one is the one nobody expects:
 *
 * 1. **Parse what a person typed** into a WebSocket URL. People type `192.168.1.5:8787`,
 *    `http://192.168.1.5:8787`, a trailing slash, a stray space.
 *
 * 2. **Say whether the current page can actually open it.** A browser refuses `ws://` from an
 *    `https://` page as mixed content, and it refuses it with nothing but a console line — no
 *    event, no error the app can catch, no retry that will ever work. `localhost` is exempt
 *    (it is a "potentially trustworthy" origin), which is why HOSTING and playing on your own
 *    machine works from the live site while JOINING someone else's does not. Without this
 *    check the failure presents as an ordinary connection problem and the player is told to
 *    try again forever. See docs/lan-selfhost.md.
 */

/** the port the bundled LAN server listens on unless told otherwise */
export const LAN_DEFAULT_PORT = 8787;

export type LanAddressError =
  /** nothing usable in the string at all */
  | 'empty'
  /** not a host we can parse */
  | 'malformed'
  /**
   * A routable public address. LAN hosting is deliberately scoped to private networks in v1
   * (docs/lan-selfhost.md): public self-hosting means port forwarding, a moderation question
   * about server lists, and a much larger promise than "play on the venue wifi".
   */
  | 'not-private';

export interface LanAddress {
  /** `ws://host:port` — what a transport connects to */
  url: string;
  /** `http://host:port` — the same origin for `/health` and for serving the client */
  httpUrl: string;
  host: string;
  port: number;
  /** loopback is exempt from the mixed-content rule, so it is worth knowing separately */
  loopback: boolean;
}

const isLoopbackHost = (h: string): boolean =>
  h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');

/**
 * Is this a private / link-local address, i.e. something on the network you are sitting on?
 *
 * RFC1918 plus loopback, link-local and mDNS names. Deliberately a WHITELIST: an address that
 * cannot be recognised is refused rather than allowed, because the failure mode of guessing
 * wrong is pointing the app at a stranger's server.
 */
export function isPrivateHost(hostRaw: string): boolean {
  const host = hostRaw.toLowerCase();
  if (isLoopbackHost(host)) return true;
  // mDNS / local DNS suffixes handed out by home and venue routers
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home')) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10), with or without brackets
  const v6 = host.replace(/^\[|\]$/g, '');
  if (/^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, what you get with no DHCP
  if (a === 127) return true;
  return false;
}

/**
 * Turn whatever was typed into a LAN address, or say why not.
 *
 * Accepts a bare `host`, `host:port`, or a full `http://`/`https://`/`ws://`/`wss://` URL, and
 * always answers in `ws://` + `http://` form: a LAN box has no certificate, so there is no
 * secure variant to preserve and pretending otherwise would produce a URL that cannot connect.
 */
export function parseLanAddress(raw: string): { ok: true; value: LanAddress } | { ok: false; error: LanAddressError } {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, error: 'empty' };

  // strip any scheme; everything below works on `host[:port][/path]`
  const noScheme = text.replace(/^(https?|wss?):\/\//i, '');
  const hostPort = noScheme.split('/')[0].trim();
  if (!hostPort) return { ok: false, error: 'empty' };

  let host = hostPort;
  let port = LAN_DEFAULT_PORT;
  // IPv6 literals are bracketed, so only split on the LAST colon and only outside brackets
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPort);
  if (bracket) {
    host = `[${bracket[1]}]`;
    if (bracket[2]) port = Number(bracket[2]);
  } else {
    const i = hostPort.lastIndexOf(':');
    if (i > 0 && /^\d+$/.test(hostPort.slice(i + 1))) {
      host = hostPort.slice(0, i);
      port = Number(hostPort.slice(i + 1));
    }
  }
  if (!host || /\s/.test(host)) return { ok: false, error: 'malformed' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'malformed' };
  if (!isPrivateHost(host)) return { ok: false, error: 'not-private' };

  return {
    ok: true,
    value: {
      url: `ws://${host}:${port}`,
      httpUrl: `http://${host}:${port}`,
      host,
      port,
      loopback: isLoopbackHost(host.toLowerCase()),
    },
  };
}

/**
 * Will THIS page be allowed to open that socket, or will the browser drop it as mixed content?
 *
 * `pageProtocol` is `location.protocol` ('https:' / 'http:' / 'file:'). Returns null when the
 * connection is fine, or the address a guest should open in their browser instead — which is
 * the only advice that actually works, because no amount of retrying fixes this.
 */
export function mixedContentBlock(addr: LanAddress, pageProtocol: string): string | null {
  if (pageProtocol !== 'https:') return null; // http: and file: may open ws:// freely
  if (addr.loopback) return null; // localhost is a potentially-trustworthy origin, exempt
  return addr.httpUrl;
}
