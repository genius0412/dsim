/**
 * START FETCHING THE 3D VIEW a server room of `game` will open on, while the player is still in
 * the lobby, the queue or the record page.
 *
 * The companion of `preloadRoomPhysics` (`roomPhysics.ts`), and separate from it because that
 * file is a leaf on the SERVER-SAFE registry and this needs the client one (`moduleFor`), which
 * carries the renderers. The scene itself cannot be built here: it belongs to the game screen,
 * which only exists after `matchStart`. What can be done early is the lazy Three.js + scene
 * chunk, so the room's load hold (`VIEWREADY_CAP`) waits on the scene build and not on a
 * download.
 *
 * It also starts the 3D physics solve (`preloadRoomPhysics`) and, once the scene chunk lands, the
 * game's `warmScene` (effects chunks, the selected venue's files). A no-op for a game with no scene and for a player on the 2D view. Unawaited; a failure here
 * is answered by the controller's own load, which falls back to the 2D view.
 */
import { moduleFor } from '../games';
import { preloadRoomPhysics } from './roomPhysics';
import { getViewPref } from '../games/biobuzz/graphics/store';
import type { GameId } from '../types';

export function preloadRoomView(game: GameId): void {
  const m = moduleFor(game);
  if (!m.scene || getViewPref() !== '3d') return;
  // the solo practice has no lobby, so this is the only place its 3D solve is warmed
  void preloadRoomPhysics(game).catch(() => {});
  // the scene chunk first, then what it will ask for (effects chunks, the venue's files)
  void m
    .scene()
    .then(() => m.warmScene?.())
    .then((warm) => warm?.())
    .catch(() => {});
}
