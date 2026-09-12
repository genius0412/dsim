import type { Alliance, World } from '../../types';

/**
 * The FIELD half of the BIOBUZZ HUD slice (`docs/biobuzz-contract.md` §5, Lane A).
 *
 * A game's HUD used to mean a per-game bag on the shared `HudSnapshot`, which is how
 * `game.ts` grows a field per season and every reader grows a branch. Instead the sim module
 * exposes ONE `hud(world, robotId)` and the shared chrome renders whatever comes back —
 * so this file is the only place that knows what BIOBUZZ shows.
 *
 * DOM-FREE, and that is a hard requirement rather than a style: the authoritative server
 * computes the same snapshot for its clients, so anything here that touched a document or a
 * clock would either crash the server or desynchronise it.
 *
 * SHELL SCOPE: `scored` per alliance and nothing else. There is nothing else TRUE to show —
 * `scoreTargets()` is empty and the module declares `scored: false`, so the count is
 * structurally 0. It is reported anyway, rather than omitted, because a HUD field that
 * appears at Kickoff is a chrome change and a HUD field that is already there and reads 0 is
 * a data change.
 */
export interface BiobuzzFieldHud {
  /** POLLEN scored, per alliance. 0 in the shell — see above. */
  scored: Record<Alliance, number>;
}

export function biobuzzFieldHud(world: World): BiobuzzFieldHud {
  const bb = world.biobuzz;
  // Defaulted rather than asserted: a snapshot from a build that predates this game arrives
  // without the bag, and a HUD is the last place that should throw.
  return { scored: { red: bb?.scored.red ?? 0, blue: bb?.scored.blue ?? 0 } };
}
