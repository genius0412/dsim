/**
 * BIOBUZZ runtime state — the `world.biobuzz` bag.
 *
 * ⚠️ PLACEHOLDER. This whole directory exists so the two registries, `SEASONS`
 * and `GAME_IDS` compile with a third id in them; the P0-shell chat REPLACES
 * these three files with the real shell (field, elements, archetypes). Nothing
 * outside `src/games/biobuzz/` should grow a dependency on what is in here yet.
 *
 * The interface is deliberately EMPTY: BIOBUZZ's rules land at kickoff on
 * 2026-09-12, so there is nothing honest to put in it. It exists as a named type
 * so `World.biobuzz` has a shape to point at and every consumer that already
 * narrows on `world.biobuzz` keeps type-checking when the fields arrive.
 *
 * Whatever goes in here must be PLAIN JSON, like `world.chain` — snapshots,
 * reconcile and replays all round-trip it.
 */

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface BiobuzzState {}

/** a fresh (empty) BIOBUZZ state bag */
export const emptyBiobuzzState = (): BiobuzzState => ({});
