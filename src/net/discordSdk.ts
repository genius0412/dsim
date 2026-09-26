/**
 * The Embedded App SDK's lazy facade — the ONLY module that names
 * `@discord/embedded-app-sdk`, and it is only ever DYNAMICALLY imported
 * (`watchDiscordParticipants`), so the SDK is a chunk nobody outside a Discord
 * Activity downloads.
 *
 * The facade exists for the CHUNK NAME, not for abstraction: Vite names a lazy
 * chunk after its facade module, and the SDK package's own entry is `index.js`,
 * so importing the package directly produced `index-<hash>.js` — which
 * `bundleaudit`'s filename-first routing reads as the MAIN chunk and bills
 * against main's baseline (+47.9 KB gzip, a fifth of the whole tolerance).
 * Through this file the chunk is `discordSdk-<hash>.js` and lands on the
 * audit's own `discord` route.
 *
 * It now also carries the ONE behavioural patch the SDK needs here — see below.
 * `discordActivity.ts` imports THIS module dynamically and this module imports
 * THAT one statically, which is not a cycle: the static direction is one-way, and
 * `discordActivity` is fully evaluated (it is in the main chunk) long before the
 * dynamic import resolves.
 */
import { DiscordSDK } from '@discord/embedded-app-sdk';
import { launchQuery } from './discordActivity';

/**
 * ⚠️ THE STOCK CONSTRUCTOR CANNOT SUCCEED IN THIS APP.
 *
 * `new DiscordSDK(clientId)` parses `this._getSearch()` — which is
 * `window.location.search` READ LIVE — and throws `frame_id query param is not
 * defined` if it is empty. App's first mount effect canonicalizes the address bar to
 * a bare path (`pathFor` emits no query), and it is declared BEFORE the effect that
 * starts the participant watcher, so in the real embed the live search was ALWAYS
 * empty by the time we got here: the SDK threw on every launch, the throw was
 * swallowed by the watcher's `console.warn`, and the "Join Discord Lobby" button
 * never rendered a single avatar. Nothing surfaced it locally, because the watcher
 * early-returns when we are not on the discordsays host.
 *
 * `_getSearch()` is a documented member of the SDK's own type, and the base
 * constructor calls it through `this`, so a subclass override is in place BEFORE the
 * parse runs. It returns the query captured at module load (`launchQuery`), which is
 * the only place those params still exist.
 *
 * It must be a PROTOTYPE method reading a MODULE-scope value, never an instance field:
 * field initializers and constructor-parameter properties are assigned AFTER the base
 * constructor returns, so `this.whatever` is still `undefined` at the moment the base
 * constructor asks for the search.
 */
class LaunchDiscordSDK extends DiscordSDK {
  override _getSearch(): string {
    return launchQuery();
  }
}

/** build an SDK bound to the launch query this document opened on. Still throws when
 * there is no launch query at all (a reload inside the activity) — callers gate on
 * `frame_id` being present rather than paying for the chunk to find out. */
export function createDiscordSdk(clientId: string): DiscordSDK {
  return new LaunchDiscordSDK(clientId);
}
