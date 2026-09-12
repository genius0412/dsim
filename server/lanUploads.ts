/**
 * DOES THIS DEPLOYMENT ACCEPT LAN MATCHES? — the server half of the LAN gate.
 *
 * `/api/lan` is how a self-hosted match reaches the cloud: the host uploads the match and
 * its replay so the people who played it get the run in their Career. That is the only
 * route by which anything LAN-shaped touches production data, so it is the only one that
 * has to be closed to hold LAN back from an environment.
 *
 * ⚠️ **FAIL CLOSED, and do NOT read the release channel for this.** Absent or anything but
 * `'1'` means the route is not mounted at all — it 404s exactly as it did before the
 * feature existed. Defaulting the other way would mean every future deployment ships the
 * upload path open unless somebody remembers to close it, which is the wrong way round for
 * a route that accepts a REPLAY from an authenticated stranger (see the in-flight cap on it
 * in api.ts). Keying it off `SERVER_CHANNEL === 'alpha'` was the obvious shortcut and is
 * rejected on the same grounds the client flag is kept separate from `import.meta.env.DEV`:
 * "which channel is this" and "is this feature open" are two questions, and a channel that
 * later wants LAN off, or a stable deployment that wants it on, would have nowhere to say so.
 *
 * The CLIENT half is `LAN_ENABLED` in `src/net/env.ts`, which hides the entry points. Both
 * are needed for a working LAN environment: this one alone leaves an open route nobody can
 * see, and that one alone leaves a visible button whose uploads 404.
 *
 * Unrelated to `LAN_MODE` (server/lanMode.ts), which is what a laptop sets to BECOME a LAN
 * server. A LAN server never writes `lan_runs` itself — the cloud does, from the host's
 * upload — so a LAN-mode process does not need this flag and is not affected by it.
 */
export const LAN_UPLOADS = process.env.LAN_UPLOADS?.trim() === '1';

console.log(
  LAN_UPLOADS
    ? '[lan] LAN_UPLOADS=1 — /api/lan is mounted; self-hosted matches can be filed here'
    : '[lan] LAN_UPLOADS unset — /api/lan is NOT mounted (self-hosted matches are not accepted)',
);
