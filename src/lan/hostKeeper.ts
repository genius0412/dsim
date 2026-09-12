/**
 * WHERE A TAB-HOSTED ROOM LIVES WHILE ITS HOST IS PLAYING IN IT.
 *
 * The LAN screen starts the room, and then the host leaves that screen to go and play — which
 * unmounts the component that owns the `LanHost`. React's answer to "this component is gone"
 * is to run the cleanup, and the cleanup stopped hosting: the host clicked GO TO THE ROOM, the
 * Worker was terminated on the way, every guest's connection was closed behind them, and the
 * host arrived at a lobby waiting on a room that no longer existed.
 *
 * So the host is PARKED here on the way out, exactly as `src/ui/queueKeeper.ts` parks a live
 * ranked queue for the same reason: module state outlives a tree, and the room has to outlive
 * the screen that made it. Coming back to the LAN screen ADOPTS it again, so the host still has
 * a Stop hosting button and still sees the code they read out.
 *
 * ⚠️ **THE ROOM STILL HAS TO END SOMEWHERE.** Parked, it has no UI attached at all, so the two
 * things that stop it are the host stopping it from the LAN screen and the room going EMPTY
 * (`LanHost` acts on the Worker's `empty`). A tab that is closed takes the Worker with it.
 */
import type { LanHost } from './hostRuntime';

let held: LanHost | null = null;

/** hand the room over on the way to the room screen */
export function keepHostedRoom(host: LanHost): void {
  if (held && held !== host) held.stop();
  held = host;
}

/** adopt it back (the LAN screen mounting again). Clears as it returns. */
export function takeHostedRoom(): LanHost | null {
  const h = held;
  held = null;
  return h;
}

/** is a room parked here? — for a caller that must not consume it */
export function hostedRoomParked(): boolean {
  return held !== null;
}

/** end a parked room and forget it */
export function stopHostedRoom(reason?: string): void {
  held?.stop(reason);
  held = null;
}
