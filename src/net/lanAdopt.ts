import { lanServerUrl, setLanServer } from './env';
import { parseLanAddress } from './lanAddress';

/**
 * IF THIS PAGE WAS SERVED BY A LAN HOST, PLAY ON IT — without anybody typing an address.
 *
 * A guest at a venue is told one thing: open `http://192.168.1.5:8787`. That address IS the
 * server; asking them to then find a panel and type it in again would be asking them to
 * repeat back what they just did. So the client asks whether its own origin is a DSIM game
 * server, and adopts it if so.
 *
 * ⚠️ **IT IS A PROBE, NOT AN ASSUMPTION**, and the difference matters on a dev box: `npm run
 * dev` serves the app from `http://localhost:5173`, which passes every other test here and
 * is NOT a game server. `/health` is what separates them, and a Vite dev server answers it
 * with a 404.
 *
 * The conditions are deliberately narrow, and between them they mean this never fires
 * anywhere it should not:
 *   - `http:` only. The deployed site is https, so it is skipped there outright.
 *   - a PRIVATE host only, so a page served from a public http origin is not adopted.
 *   - `/health` must answer. A static file server, a dev server or a proxy does not.
 *
 * The desktop shell is skipped by the first condition either way: it loads the live https
 * site when it can and a `file://` bundle when it cannot, and a host playing on their own
 * machine connects through the Host panel instead.
 */
export async function adoptLanFromOrigin(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const { protocol, host, origin } = window.location;
  if (protocol !== 'http:') return false;

  const hit = parseLanAddress(host);
  if (!hit.ok) return false; // not a private address — not a LAN host
  if (lanServerUrl() === hit.value.url) return true; // already pointed here

  try {
    // short: this runs before the first render and a dead probe must not hold it up
    const res = await fetch(`${origin}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    if ((await res.text()).trim() !== 'ok') return false;
  } catch {
    return false; // no server here, or it did not answer in time
  }

  setLanServer(hit.value.url);
  return true;
}
