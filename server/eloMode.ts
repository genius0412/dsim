/**
 * The one thing `server/room.ts` needs from the ranked module, split out so that importing it
 * does not import a database.
 *
 * `server/ranked.ts` imports `./db/repo`, which imports `pg`, which reaches for `net`, `tls`,
 * `dns` and `fs`. The room needs NONE of that — it wanted a single pure function — but an
 * import is an import, so the whole driver came with it. That was invisible while the room
 * only ever ran on Node; it stops being invisible when the same room is bundled for a tab
 * (see `docs/lan-webrtc.md`), where those builtins do not exist and the bundle fails outright.
 *
 * `ranked.ts` re-exports this name, so every existing caller is unaffected.
 */

/** infer the ranked mode from the roster size */
export function eloMode(count: number): '1v1' | '2v2' {
  return count >= 4 ? '2v2' : '1v1';
}
