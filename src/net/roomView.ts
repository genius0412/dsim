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
 * A no-op for a game with no scene and for a player on the 2D view. Unawaited; a failure here
 * is answered by the controller's own load, which falls back to the 2D view.
 */
import { moduleFor } from '../games';
import { getViewPref } from '../games/biobuzz/graphics/store';
import type { GameId } from '../types';

export function preloadRoomView(game: GameId): void {
  const scene = moduleFor(game).scene;
  if (!scene || getViewPref() !== '3d') return;
  void scene().catch(() => {});
}
