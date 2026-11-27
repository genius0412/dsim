import { envVar } from './runtimeEnv';
import { importerOpenOn, ROBOT_IMPORT_CAP } from '../src/net/imported';
import { IMPORT_VISUALS_CAP } from '../src/net/importVisuals';

/**
 * WHICH DEPLOYMENT THIS SERVER IS — stable (production) or alpha (the preview).
 *
 * Until now there was ONE game server and every client version talked to it, so an in-dev
 * alpha build had to be walled off inside it: the matchmaker segregates alpha entries into
 * their own pool, and alpha results are never written to the database. That second rule is
 * what made the preview only half-testable — standing, dodge penalties, reports, playtime
 * and ranked all EXIST by writing to Postgres, so on a shared server they silently no-op and
 * there is nothing to look at.
 *
 * With a separate alpha app pointed at its own database, that protection comes from the
 * DEPLOYMENT instead of from a rule inside one process: alpha writes go to the alpha
 * database, and production cannot see them because it is not connected to it. So the alpha
 * server persists normally and the preview behaves like the real thing.
 *
 * The client-channel segregation STAYS regardless. It is cheap, and it is what still
 * protects production if an alpha client ever reaches the stable server — which it can,
 * since a browser tab can point anywhere.
 */
export const SERVER_CHANNEL: string = (envVar('SERVER_CHANNEL') ?? 'stable').trim() || 'stable';

/** is this the alpha (preview) deployment? */
export const isAlphaServer = (): boolean => SERVER_CHANNEL === 'alpha';

/**
 * May a room's results be written to this server's database?
 *
 * Pure, and takes both channels, because the rule is about the PAIRING rather than about
 * either side alone:
 *
 *   alpha client on the STABLE server → NO. The old rule, still the important one: an
 *     in-development build's results must never land in production boards, and a browser
 *     tab can point anywhere it likes.
 *   alpha client on the ALPHA server → YES. That is the whole point of the preview: its
 *     database is its own, so there is nothing to protect it from.
 *   stable client anywhere → YES, as before.
 */
export function roomPersists(roomChannel: string | undefined, serverChannel = SERVER_CHANNEL): boolean {
  if (roomChannel !== 'alpha') return true;
  return serverChannel === 'alpha';
}

/**
 * MAY AN IMPORTED ROBOT PLAY ON THIS SERVER? The importer ships to alpha only until the owner
 * says otherwise (`importerOpenOn`, src/net/imported.ts, is the rule; the client asks it of its
 * build's channel). Fail-closed: production sets no `SERVER_CHANNEL` and reads 'stable'.
 *
 * `ROBOT_IMPORT=1` opens it on a local server or a test run, and wins over everything below.
 *
 * A LAN SERVER (`LAN_MODE=1`: the desktop app's own LAN host, or anyone running the LAN bundle)
 * FOLLOWS THE STABLE CHANNEL'S RULE, whatever channel it says it is:
 * `enforceLanPolicy` forces the channel to 'stable', but only after this module has read it, so
 * `LAN_MODE` is read here and answered as `importerOpenOn('stable')`. Closed today; the release that
 * adds 'stable' to `IMPORTER_CHANNELS` opens desktop and self-hosted LAN servers with production,
 * with no `electron/lanHost.cjs` change, and taking 'stable' out again closes them too. A desktop
 * LAN host runs the server bundled with its release, so it opens from a desktop build made after
 * that release.
 *
 * A closed server does not advertise the two caps (`advertisedCaps`) and every room it builds
 * refuses imports (`RoomConfig.imports`, `Room.allowsImportedRobots`). It hides and refuses; it
 * never strips what a player has stored.
 */
export function importsOpen(channel: string, override: string | undefined, lanMode: string | undefined): boolean {
  if ((override ?? '').trim() === '1') return true;
  if ((lanMode ?? '').trim() === '1') return importerOpenOn('stable');
  return importerOpenOn(channel);
}

/** this process's answer, read once at boot: `SERVER_CHANNEL` (production sets none and reads
 *  'stable'), `ROBOT_IMPORT=1` (a test override), and `LAN_MODE` (follows stable, above) */
export const IMPORTS_OPEN_HERE: boolean = importsOpen(SERVER_CHANNEL, envVar('ROBOT_IMPORT'), envVar('LAN_MODE'));

/** `caps` as `/api/presence` says them: without the importer's two words where imports are closed.
 *  `'imports2'` stays either way: it says the machine runs the code that knows the host setting and
 *  the Public-room rules, which is what the flip checks every region for before it opens anything. */
export function advertisedCaps(caps: readonly string[], importsAllowed: boolean): string[] {
  return importsAllowed ? [...caps] : caps.filter((c) => c !== ROBOT_IMPORT_CAP && c !== IMPORT_VISUALS_CAP);
}
