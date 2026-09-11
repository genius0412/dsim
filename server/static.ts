import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, resolve, sep, extname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * SERVING THE GAME CLIENT FROM THE GAME SERVER — the LAN host's half of the feature.
 *
 * OFF unless `SERVE_CLIENT` names a built `dist/`. The Fly deployment must never turn this
 * on: it has a CDN in front of it and would start handing out a bundled copy that goes stale
 * the moment Vercel deploys, which is the version-skew the matchmaker's build segregation
 * exists to prevent.
 *
 * WHY A SELF-HOSTED SERVER HAS TO DO THIS AT ALL. A browser refuses a `ws://` socket from an
 * `https://` page as mixed content — silently, with no catchable error (see
 * `src/net/lanAddress.ts` and docs/lan-selfhost.md). So a guest cannot reach a LAN server
 * from `https://www.playdsim.com` at all, and the fix is not a workaround but the better
 * arrangement: the host serves the client over plain HTTP on the SAME ORIGIN as the socket,
 * a guest opens `http://192.168.1.5:8787` in any browser on the network, and:
 *   - there is no mixed content anywhere, because both are `http:` on one origin;
 *   - guests install nothing — the join instruction is a URL on a projector;
 *   - version skew stops existing, since every client in the room was served the same bytes
 *     by the same host.
 *
 * It is a ROUTE, not an architecture: the server is already an HTTP server (`/health`,
 * `/api/*`), and this is the last `if` before the 426.
 */

/**
 * `SERVE_CLIENT=/path/to/dist` turns it on. Absent ⇒ this module answers nothing.
 *
 * Read PER CALL, not once at module load. It is one `resolve()` of a short string against a
 * request that is about to touch the disk anyway, and reading it at load time made the module
 * impossible to exercise: an ES import is hoisted above everything in the importing file, so
 * a test that sets the variable before importing sets it too late. A server whose only
 * security-relevant function is a path-containment check has to be testable.
 */
const root = (): string => (process.env.SERVE_CLIENT ? resolve(process.env.SERVE_CLIENT) : '');

export const servingClient = (): boolean => !!root();

/** Vite emits exactly these. An unknown extension is served as an octet-stream rather than
 *  guessed at — a wrong `content-type` on a script is a silently dead page. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Turn a request URL into a file inside `ROOT`, or null if it escapes.
 *
 * EXPORTED, and taking its root as an ARGUMENT, so `npm test` can pin it directly: this is
 * the one security-relevant function in the file and it must not be reachable only through
 * a socket.
 *
 * ⚠️ **THE CONTAINMENT CHECK IS THE SECURITY BOUNDARY OF THIS FILE.** This process is
 * running on somebody's laptop, on a network of strangers at a competition venue, and every
 * request comes from a machine its operator does not control. `..` is decoded from the
 * percent-encoding before `normalize` sees it, so the check is made on the RESOLVED path
 * against `ROOT + sep` — never on the URL text, which can say `%2e%2e%2f` and a dozen other
 * things. A prefix test without the separator would also let `/dist-evil` past a ROOT of
 * `/dist`.
 */
export function filePath(ROOT: string, url: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url, 'http://x').pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (pathname.includes('\0')) return null;
  const full = resolve(join(ROOT, normalize(pathname)));
  return full === ROOT || full.startsWith(ROOT + sep) ? full : null;
}

/**
 * Cache policy, and it is two policies because Vite's output is two kinds of file.
 *
 * Everything under `assets/` carries a content hash in its NAME, so it can never change
 * meaning and is immutable for a year. `index.html` names those files, so it must never be
 * cached at all: a host that rebuilds and restarts mid-scrimmage would otherwise serve an
 * index pointing at bundles that no longer exist, and the guests' browsers would keep
 * showing it. Everything else takes a short revalidating cache.
 */
function cacheFor(path: string): string {
  if (path.endsWith('.html')) return 'no-cache';
  if (path.includes(`${sep}assets${sep}`)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=300';
}

const send = async (
  res: ServerResponse,
  path: string,
  headOnly: boolean,
  status = 200,
): Promise<boolean> => {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    size = info.size;
  } catch {
    return false;
  }
  res.writeHead(status, {
    'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': cacheFor(path),
    // the client this serves is a LAN one and talks only to this origin; no page on another
    // origin has any business embedding it, and a host's laptop is not a CDN
    'x-content-type-options': 'nosniff',
  });
  if (headOnly) {
    res.end();
    return true;
  }
  createReadStream(path).pipe(res);
  return true;
};

/**
 * Answer a request from the built client, or report that this is not ours.
 *
 * Returns false when the caller should carry on to its own fallback — the module is off, the
 * method is not a read, or the path is an escape attempt. It NEVER returns false merely
 * because a file is missing: an SPA's routes (`/leaderboard`, `/replay/<id>`) are not files,
 * so a miss falls through to `index.html` and the router sorts it out. `/api/*` is dispatched
 * before this is ever reached, so nothing real is shadowed by that.
 */
export async function serveClient(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const ROOT = root();
  if (!ROOT) return false;
  const headOnly = req.method === 'HEAD';
  if (req.method !== 'GET' && !headOnly) return false;

  const path = filePath(ROOT, req.url ?? '/');
  if (!path) {
    // a traversal attempt, answered rather than passed on: the 426 below would tell the
    // sender their probe reached something that reads URLs
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad path');
    return true;
  }

  if (await send(res, path, headOnly)) return true;
  // a directory or a nonexistent path: try its index, then the SPA entry
  if (await send(res, join(path, 'index.html'), headOnly)) return true;
  if (await send(res, join(ROOT, 'index.html'), headOnly)) return true;
  return false; // SERVE_CLIENT points somewhere that is not a built client
}
