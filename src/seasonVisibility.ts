/**
 * SEASON VISIBILITY for THIS client build — the thin wrapper that hands the live
 * release channel to the pure rule in `src/seasons.ts`.
 *
 * The split is deliberate and is the same one `roomJoinRegion` uses. `src/net/env.ts`
 * reads `import.meta.env` at module load, so it cannot be imported outside a Vite
 * build — the headless smoke run would fail on the import alone. So the RULE
 * (`seasonVisibleOn` / `visibleSeasonsOn` / `gameVisibleOn`) lives in the env-free
 * leaf and is tested there, and this file exists only to read the channel and call
 * it. Nothing but the channel read belongs here.
 *
 * Every UI surface that enumerates games should read THESE, not `SEASONS` /
 * `registeredGames()` directly: a season restricted to the alpha channel must be
 * absent from the home picker, the queue counts and the route table on a stable
 * build, and each of those failures is invisible (an absent row looks like a row
 * nobody added).
 */

import type { GameModule } from './games/module';
import type { GameId } from './games/types';
import { registeredGames } from './games';
import { appChannel } from './net/env';
import { importerOpenOn } from './net/imported';
import { gameVisibleOn, visibleGameIdsOn, visibleSeasonsOn, type Season } from './seasons';

/** the seasons this build may show, in registry order */
export const visibleSeasons = (): readonly Season[] => visibleSeasonsOn(appChannel());

/** the game ids this build may show, in registry order */
export const visibleGameIds = (): readonly GameId[] => visibleGameIdsOn(appChannel());

/** may this build show `game` at all? */
export const gameVisible = (game: GameId): boolean => gameVisibleOn(game, appChannel());

/**
 * The registered game MODULES this build may show — `registeredGames()` filtered
 * by channel. The twin of `registeredGames`, and what a picker wants: a module can
 * be registered (so worlds, replays and the server all resolve it) while its season
 * is still hidden from the players on this channel.
 */
export const visibleGames = (): GameModule[] =>
  registeredGames().filter((m) => gameVisible(m.id));

/**
 * May this build mount a game's `devRoutes`? ALPHA only.
 *
 * They are development instruments (the BIOBUZZ scene gallery): they draw through
 * the real renderers with no auth, session or server behind them, so a stable
 * build must not carry a URL that opens one. Same channel read as the season
 * gate above, kept beside it so there is one place that knows what `alpha` means.
 */
export const devRoutesEnabled = (): boolean => appChannel() === 'alpha';

/**
 * Does this build offer the ROBOT IMPORTER? The rule is `importerOpenOn` (`src/net/imported.ts`),
 * asked of this build's channel, so the alpha site has it and production does not, with no new
 * Vercel variable. Two more ways in, neither of them a deployment: the dev server, and
 * `VITE_ROBOT_IMPORT=1` on a local `vite build` for the preview probes (exactly `1`; anything else
 * is off).
 *
 * ⚠️ THE COSMETIC HALF. It hides the editor's route, the library row, the lobby's library cards and
 * the Network panel, and `App` shows a stored import as the standard robot (`withoutImport`). The
 * server refuses an import on a channel where the rule is closed. It hides; it never deletes: the
 * stored settings, the library and the account copy are left as they are.
 *
 * Read it only outside the smoke import graph (`App`, `Menu`, `Lobby`, `NetworkSection`,
 * `net/api.ts`): this file reaches `net/env.ts`, which reads `import.meta.env` at load.
 */
export const importerEnabled = (): boolean =>
  import.meta.env.DEV ||
  importerOpenOn(appChannel()) ||
  (import.meta.env.VITE_ROBOT_IMPORT as string | undefined)?.trim() === '1';
